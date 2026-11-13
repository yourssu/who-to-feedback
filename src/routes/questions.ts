import { nowIso, toReadableSlug } from "../crypto.ts";
import {
  listCycleQuestions,
  requireCycle,
  requireOption,
  requireQuestion,
} from "../db/queries.ts";
import {
  emptyResponse,
  jsonResponse,
  readJsonBody,
  type Router,
} from "../router.ts";
import {
  parsePathId,
  validateCreateQuestionFields,
  validateCreateQuestionOption,
} from "../schemas.ts";
import { ApiError } from "../types.ts";

function detectImageExtension(
  bytes: Uint8Array,
): { ext: "png" | "jpg" | "webp"; contentType: string } | null {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { ext: "png", contentType: "image/png" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { ext: "jpg", contentType: "image/jpeg" };
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return { ext: "webp", contentType: "image/webp" };
  }
  return null;
}

export function registerQuestionsRoutes(router: Router): void {
  router.get("/api/admin/cycles/:cycleId/questions", async ({ params, env }) => {
    const cycleId = parsePathId(params.cycleId, "cycleId");
    const items = await listCycleQuestions(env.DB, cycleId);
    return jsonResponse({ items });
  });

  router.post(
    "/api/admin/cycles/:cycleId/questions",
    async ({ req, params, env }) => {
      const cycleId = parsePathId(params.cycleId, "cycleId");
      const cycle = await requireCycle(env.DB, cycleId);
      if (cycle.status !== "DRAFT") {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "시작된 회차의 설문 문항은 추가하거나 수정할 수 없습니다.",
        );
      }

      const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
      let fields: ReturnType<typeof validateCreateQuestionFields>;
      let imageFile: File | null = null;

      if (contentType.includes("multipart/form-data")) {
        const formData = await req.formData();
        const rawObj: Record<string, unknown> = {
          display_order: formData.get("display_order"),
          question_type: formData.get("question_type"),
          content: formData.get("content"),
        };
        if (formData.get("scale_type") != null) {
          rawObj.scale_type = formData.get("scale_type");
        }
        if (formData.get("category") != null) {
          rawObj.category = formData.get("category");
        }
        fields = validateCreateQuestionFields(rawObj);
        const maybeImage = formData.get("image");
        if (maybeImage instanceof File && maybeImage.size > 0) {
          imageFile = maybeImage;
        }
      } else {
        fields = validateCreateQuestionFields(await readJsonBody(req));
      }

      let imageR2Key: string | null = null;
      if (imageFile) {
        if (imageFile.size > 10 * 1024 * 1024) {
          throw new ApiError(
            413,
            "PAYLOAD_TOO_LARGE",
            "문항 참고 이미지는 최대 10MB까지 업로드할 수 있습니다.",
          );
        }
        const bytes = new Uint8Array(await imageFile.arrayBuffer());
        const detected = detectImageExtension(bytes);
        if (!detected) {
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "PNG, JPEG, WebP 형식의 이미지만 업로드할 수 있습니다.",
          );
        }
        const cycleFolder = `cycle-${cycleId}_${toReadableSlug(cycle.title, "cycle")}`;
        const qPrefix = `Q${fields.display_order}_${toReadableSlug(fields.category, "question")}`;
        imageR2Key = `questions/${cycleFolder}/${qPrefix}_${crypto.randomUUID().slice(0, 8)}.${detected.ext}`;
        await env.FILES.put(imageR2Key, bytes, {
          httpMetadata: { contentType: detected.contentType },
        });
      }

      try {
        const latestCycle = await requireCycle(env.DB, cycleId);
        if (latestCycle.status !== "DRAFT") {
          throw new ApiError(
            409,
            "STATE_CONFLICT",
            "시작된 회차의 설문 문항은 추가할 수 없습니다.",
          );
        }
        const now = nowIso();
        const res = await env.DB.prepare(
          `INSERT INTO questions (cycle_id, display_order, question_type, scale_type, category, content, image_r2_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            cycleId,
            fields.display_order,
            fields.question_type,
            fields.scale_type,
            fields.category,
            fields.content,
            imageR2Key,
            now,
          )
          .run();

        const questionId = Number(res.meta.last_row_id);
        return jsonResponse(
          {
            id: questionId,
            cycle_id: cycleId,
            display_order: fields.display_order,
            question_type: fields.question_type,
            scale_type: fields.scale_type,
            category: fields.category,
            content: fields.content,
            image_url: imageR2Key
              ? `/api/media/questions/${questionId}/image`
              : null,
            options: [],
            created_at: now,
          },
          201,
        );
      } catch (err) {
        if (imageR2Key) {
          await env.FILES.delete(imageR2Key);
        }
        throw err;
      }
    },
  );

  router.delete("/api/admin/questions/:questionId", async ({ params, env }) => {
    const questionId = parsePathId(params.questionId, "questionId");
    const question = await requireQuestion(env.DB, questionId);
    const cycle = await requireCycle(env.DB, question.cycle_id);
    if (cycle.status !== "DRAFT") {
      throw new ApiError(
        409,
        "STATE_CONFLICT",
        "시작된 회차의 설문 문항은 삭제할 수 없습니다.",
      );
    }

    await env.DB.prepare("DELETE FROM questions WHERE id = ?")
      .bind(questionId)
      .run();

    if (question.image_r2_key) {
      await env.FILES.delete(question.image_r2_key);
    }
    return emptyResponse(204);
  });

  router.post(
    "/api/admin/questions/:questionId/options",
    async ({ req, params, env }) => {
      const questionId = parsePathId(params.questionId, "questionId");
      const question = await requireQuestion(env.DB, questionId);
      const cycle = await requireCycle(env.DB, question.cycle_id);
      if (cycle.status !== "DRAFT") {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "시작된 회차의 선택지는 추가할 수 없습니다.",
        );
      }
      if (
        question.question_type !== "SINGLE_CHOICE" &&
        question.question_type !== "MULTIPLE_CHOICE"
      ) {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "객관식(SINGLE_CHOICE, MULTIPLE_CHOICE) 문항에만 선택지를 추가할 수 있습니다.",
        );
      }

      const body = validateCreateQuestionOption(await readJsonBody(req));
      const existingOpt = await env.DB.prepare(
        "SELECT id FROM question_options WHERE question_id = ? AND option_text = ?",
      )
        .bind(questionId, body.option_text)
        .first<{ id: number }>();
      if (existingOpt) {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "동일한 내용의 선택지가 이미 등록되어 있습니다.",
        );
      }

      let res;
      try {
        res = await env.DB.prepare(
          `INSERT INTO question_options (question_id, display_order, option_text)
           SELECT ?, COALESCE(MAX(display_order), 0) + 1, ?
           FROM question_options
           WHERE question_id = ?`,
        )
          .bind(questionId, body.option_text, questionId)
          .run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE")) {
          throw new ApiError(
            409,
            "STATE_CONFLICT",
            "동일한 내용의 선택지가 이미 등록되어 있습니다.",
          );
        }
        throw err;
      }

      const option = await requireOption(env.DB, Number(res.meta.last_row_id));
      return jsonResponse(option, 201);
    },
  );

  router.delete("/api/admin/options/:optionId", async ({ params, env }) => {
    const optionId = parsePathId(params.optionId, "optionId");
    const option = await requireOption(env.DB, optionId);
    const question = await requireQuestion(env.DB, option.question_id);
    const cycle = await requireCycle(env.DB, question.cycle_id);
    if (cycle.status !== "DRAFT") {
      throw new ApiError(
        409,
        "STATE_CONFLICT",
        "시작된 회차의 선택지는 삭제할 수 없습니다.",
      );
    }

    await env.DB.prepare("DELETE FROM question_options WHERE id = ?")
      .bind(optionId)
      .run();
    return emptyResponse(204);
  });
}
