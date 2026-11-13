import { requireQuestion } from "../db/queries.ts";
import { type Router } from "../router.ts";
import { parsePathId } from "../schemas.ts";
import { ApiError } from "../types.ts";

export function registerMediaRoutes(router: Router): void {
  router.get(
    "/api/media/questions/:questionId/image",
    async ({ params, env, session }) => {
      if (!session) {
        throw new ApiError(401, "UNAUTHORIZED", "로그인이 필요합니다.");
      }
      const questionId = parsePathId(params.questionId, "questionId");
      const question = await requireQuestion(env.DB, questionId);

      if (
        session.role === "REVIEWER" &&
        session.cycle_id !== question.cycle_id
      ) {
        throw new ApiError(
          403,
          "FORBIDDEN",
          "해당 회차의 문항 이미지에 접근할 권한이 없습니다.",
        );
      }

      if (!question.image_r2_key) {
        throw new ApiError(
          404,
          "NOT_FOUND",
          "첨부된 이미지가 없는 문항입니다.",
        );
      }

      const obj = await env.FILES.get(question.image_r2_key);
      if (!obj) {
        throw new ApiError(
          404,
          "NOT_FOUND",
          "스토리지에서 이미지를 찾을 수 없습니다.",
        );
      }

      const contentType =
        obj.httpMetadata?.contentType ??
        (question.image_r2_key.endsWith(".png")
          ? "image/png"
          : question.image_r2_key.endsWith(".webp")
            ? "image/webp"
            : "image/jpeg");

      return new Response(await obj.arrayBuffer(), {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  );
}
