import { nowIso } from "../crypto.ts";
import {
  getCycleDetail,
  listCycleAssignments,
  listCycleQuestions,
  requireAssignment,
  requireMember,
  toAssignmentSummary,
} from "../db/queries.ts";
import { jsonResponse, readJsonBody, type Router } from "../router.ts";
import { parsePathId, validateReviewAnswersInput } from "../schemas.ts";
import {
  ApiError,
  type AssignmentRecord,
  type D1Database,
  type D1PreparedStatement,
  type QuestionAnswerItem,
  type QuestionDto,
  type SessionRecord,
} from "../types.ts";

function requireReviewerSession(
  session: SessionRecord | null,
): SessionRecord & { member_id: number; cycle_id: number } {
  if (
    !session ||
    session.role !== "REVIEWER" ||
    !session.member_id ||
    !session.cycle_id
  ) {
    throw new ApiError(403, "FORBIDDEN", "리뷰어 권한이 필요합니다.");
  }
  return session as SessionRecord & { member_id: number; cycle_id: number };
}

async function requireOwnedAssignment(
  db: D1Database,
  assignmentId: number,
  reviewerId: number,
  cycleId: number,
): Promise<AssignmentRecord> {
  const a = await requireAssignment(db, assignmentId);
  if (a.reviewer_id !== reviewerId || a.cycle_id !== cycleId) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "본인에게 배정된 리뷰에만 접근할 수 있습니다.",
    );
  }
  return a;
}

function normalizeAndValidateAnswers(
  questions: QuestionDto[],
  inputAnswers: QuestionAnswerItem[],
  partial: boolean,
): QuestionAnswerItem[] {
  const questionMap = new Map<number, QuestionDto>(
    questions.map((q) => [q.id, q]),
  );
  const byQuestionId = new Map<number, QuestionAnswerItem>();

  for (const ans of inputAnswers) {
    if (!questionMap.has(ans.question_id)) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        `해당 회차에 존재하지 않는 문항 ID입니다: ${ans.question_id}`,
      );
    }
    if (byQuestionId.has(ans.question_id)) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        `동일 문항에 중복 답변이 전달되었습니다: ${ans.question_id}`,
      );
    }
    byQuestionId.set(ans.question_id, ans);
  }

  return questions.map((q) => {
    const item = byQuestionId.get(q.id);
    if (q.question_type === "RATING") {
      const val = item?.rating_value ?? null;
      if (val === null) {
        if (!partial) {
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            `Q${q.display_order} 문항의 척도 점수를 선택해 주세요.`,
          );
        }
        return { question_id: q.id, rating_value: null };
      }
      if (!Number.isInteger(val) || val < 1 || val > 5) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          `Q${q.display_order} 척도 점수는 1~5점 사이여야 합니다.`,
        );
      }
      return { question_id: q.id, rating_value: val };
    }

    if (q.question_type === "TEXT") {
      const rawText = item?.answer_text ?? null;
      const trimmed = rawText ? rawText.trim() : "";
      if (!trimmed) {
        if (!partial) {
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            `Q${q.display_order} 서술형 답변을 입력해 주세요.`,
          );
        }
        return { question_id: q.id, answer_text: rawText ? trimmed : null };
      }
      if ([...trimmed].length > 2000) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          `Q${q.display_order} 서술형 답변은 최대 2,000자까지 입력 가능합니다.`,
        );
      }
      return { question_id: q.id, answer_text: trimmed };
    }

    const validOptionIds = new Set(q.options.map((o) => o.id));
    const selected = item?.option_ids ?? [];
    for (const optId of selected) {
      if (!validOptionIds.has(optId)) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          `Q${q.display_order} 문항에 속하지 않는 선택지 ID입니다.`,
        );
      }
    }
    if (!partial && selected.length === 0) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        `Q${q.display_order} 문항의 선택지를 선택해 주세요.`,
      );
    }
    if (q.question_type === "SINGLE_CHOICE" && selected.length > 1) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        `Q${q.display_order} 단일 선택 문항은 1개의 선택지만 선택할 수 있습니다.`,
      );
    }
    return { question_id: q.id, option_ids: selected };
  });
}

export function registerReviewerRoutes(router: Router): void {
  router.get("/api/reviewer/dashboard", async ({ env, session }) => {
    const revSession = requireReviewerSession(session);
    const [cycle, reviewer, assignments] = await Promise.all([
      getCycleDetail(env.DB, revSession.cycle_id),
      requireMember(env.DB, revSession.member_id),
      listCycleAssignments(env.DB, revSession.cycle_id, revSession.member_id),
    ]);

    const total_count = assignments.length;
    const submitted_count = assignments.filter((a) => a.is_submitted).length;
    const completion_rate =
      total_count > 0 ? Math.floor((submitted_count / total_count) * 100) : 0;
    const can_write = cycle.status === "ACTIVE" && !cycle.is_deadline_passed;

    return jsonResponse({
      cycle,
      reviewer,
      total_count,
      submitted_count,
      completion_rate,
      can_write,
      assignments,
    });
  });

  router.get(
    "/api/reviewer/assignments/:assignmentId",
    async ({ params, env, session }) => {
      const revSession = requireReviewerSession(session);
      const assignmentId = parsePathId(params.assignmentId, "assignmentId");
      const assignmentRow = await requireOwnedAssignment(
        env.DB,
        assignmentId,
        revSession.member_id,
        revSession.cycle_id,
      );

      const [assignment, cycle, questions] = await Promise.all([
        toAssignmentSummary(env.DB, assignmentRow),
        getCycleDetail(env.DB, assignmentRow.cycle_id),
        listCycleQuestions(env.DB, assignmentRow.cycle_id),
      ]);

      const is_locked =
        assignment.is_submitted ||
        cycle.status !== "ACTIVE" ||
        cycle.is_deadline_passed;

      let answers: QuestionAnswerItem[] = [];
      if (assignment.is_submitted) {
        const answerRows = await env.DB.prepare(
          "SELECT * FROM answers WHERE assignment_id = ? ORDER BY question_id ASC",
        )
          .bind(assignmentId)
          .all<{
            id: number;
            question_id: number;
            rating_value: number | null;
            answer_text: string | null;
          }>();

        const optionRows = await env.DB.prepare(
          `SELECT ao.answer_id, ao.option_id
           FROM answer_options ao
           JOIN answers a ON a.id = ao.answer_id
           WHERE a.assignment_id = ?
           ORDER BY ao.option_id ASC`,
        )
          .bind(assignmentId)
          .all<{ answer_id: number; option_id: number }>();

        const optionsByAnswer = new Map<number, number[]>();
        for (const r of optionRows.results) {
          const list = optionsByAnswer.get(r.answer_id) ?? [];
          list.push(r.option_id);
          optionsByAnswer.set(r.answer_id, list);
        }

        answers = answerRows.results.map((a) => ({
          question_id: a.question_id,
          rating_value: a.rating_value,
          answer_text: a.answer_text,
          option_ids: optionsByAnswer.get(a.id) ?? [],
        }));
      } else if (assignmentRow.draft_data) {
        try {
          const parsed = JSON.parse(assignmentRow.draft_data) as {
            answers?: QuestionAnswerItem[];
          };
          if (Array.isArray(parsed.answers)) {
            answers = parsed.answers;
          }
        } catch {
          answers = [];
        }
      }

      return jsonResponse({
        assignment,
        cycle,
        is_locked,
        questions,
        answers,
      });
    },
  );

  router.put(
    "/api/reviewer/assignments/:assignmentId/draft",
    async ({ req, params, env, session }) => {
      const revSession = requireReviewerSession(session);
      const assignmentId = parsePathId(params.assignmentId, "assignmentId");
      const assignmentRow = await requireOwnedAssignment(
        env.DB,
        assignmentId,
        revSession.member_id,
        revSession.cycle_id,
      );
      const cycle = await getCycleDetail(env.DB, assignmentRow.cycle_id);

      if (
        assignmentRow.is_submitted ||
        cycle.status !== "ACTIVE" ||
        cycle.is_deadline_passed
      ) {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "이미 제출되었거나 마감된 리뷰는 수정할 수 없습니다.",
        );
      }

      const body = validateReviewAnswersInput(
        await readJsonBody(req, false, 100 * 1024),
      );
      const questions = await listCycleQuestions(
        env.DB,
        assignmentRow.cycle_id,
      );
      const normalized = normalizeAndValidateAnswers(
        questions,
        body.answers,
        true,
      );

      const serialized = JSON.stringify({ answers: normalized });
      if (new TextEncoder().encode(serialized).byteLength > 100 * 1024) {
        throw new ApiError(
          413,
          "PAYLOAD_TOO_LARGE",
          "임시 저장 데이터 크기는 최대 100KB입니다.",
        );
      }

      const saved_at = nowIso();
      await env.DB.prepare(
        "UPDATE assignments SET draft_data = ?, draft_saved_at = ? WHERE id = ?",
      )
        .bind(serialized, saved_at, assignmentId)
        .run();

      return jsonResponse({ saved_at });
    },
  );

  router.post(
    "/api/reviewer/assignments/:assignmentId/submit",
    async ({ req, params, env, session }) => {
      const revSession = requireReviewerSession(session);
      const assignmentId = parsePathId(params.assignmentId, "assignmentId");
      const assignmentRow = await requireOwnedAssignment(
        env.DB,
        assignmentId,
        revSession.member_id,
        revSession.cycle_id,
      );
      const cycle = await getCycleDetail(env.DB, assignmentRow.cycle_id);

      if (
        assignmentRow.is_submitted ||
        cycle.status !== "ACTIVE" ||
        cycle.is_deadline_passed
      ) {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "이미 제출되었거나 마감된 리뷰는 제출할 수 없습니다.",
        );
      }

      const body = validateReviewAnswersInput(await readJsonBody(req));
      const questions = await listCycleQuestions(
        env.DB,
        assignmentRow.cycle_id,
      );
      const normalized = normalizeAndValidateAnswers(
        questions,
        body.answers,
        false,
      );

      const now = nowIso();
      const stmts: D1PreparedStatement[] = [];

      for (const ans of normalized) {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO answers (assignment_id, question_id, rating_value, answer_text, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).bind(
            assignmentId,
            ans.question_id,
            ans.rating_value ?? null,
            ans.answer_text ?? null,
            now,
          ),
        );
        for (const optId of ans.option_ids ?? []) {
          stmts.push(
            env.DB.prepare(
              `INSERT INTO answer_options (answer_id, option_id)
               SELECT id, ? FROM answers WHERE assignment_id = ? AND question_id = ?`,
            ).bind(optId, assignmentId, ans.question_id),
          );
        }
      }

      stmts.push(
        env.DB.prepare(
          `UPDATE assignments
           SET is_submitted = 1, submitted_at = ?, draft_data = NULL
           WHERE id = ? AND is_submitted = 0`,
        ).bind(now, assignmentId),
      );

      await env.DB.batch(stmts);

      const updated = await requireAssignment(env.DB, assignmentId);
      const summary = await toAssignmentSummary(env.DB, updated);
      return jsonResponse(summary, 200);
    },
  );
}
