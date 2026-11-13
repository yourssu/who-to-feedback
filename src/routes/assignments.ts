import { nowIso } from "../crypto.ts";
import {
  ensurePinAndEnqueueDelivery,
  isCycleDeadlinePassed,
  listAllMembers,
  listCycleAssignments,
  requireAssignment,
  requireCycle,
  requireMember,
  toAssignmentSummary,
} from "../db/queries.ts";
import {
  emptyResponse,
  jsonResponse,
  readJsonBody,
  type Router,
} from "../router.ts";
import {
  parsePathId,
  validateAutoMatchAssignments,
  validateCreateAssignment,
} from "../schemas.ts";
import { ApiError, type AssignmentRecord } from "../types.ts";

export function registerAssignmentsRoutes(router: Router): void {
  router.get(
    "/api/admin/cycles/:cycleId/assignments",
    async ({ params, env }) => {
      const cycleId = parsePathId(params.cycleId, "cycleId");
      const items = await listCycleAssignments(env.DB, cycleId);
      return jsonResponse({ items });
    },
  );

  router.post(
    "/api/admin/cycles/:cycleId/assignments",
    async ({ req, params, env }) => {
      const cycleId = parsePathId(params.cycleId, "cycleId");
      const cycle = await requireCycle(env.DB, cycleId);
      if (
        (cycle.status !== "DRAFT" && cycle.status !== "ACTIVE") ||
        isCycleDeadlinePassed(cycle)
      ) {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "마감되었거나 종료된 회차에는 매칭을 추가할 수 없습니다.",
        );
      }

      const body = validateCreateAssignment(await readJsonBody(req));
      await Promise.all([
        requireMember(env.DB, body.reviewer_id),
        requireMember(env.DB, body.reviewee_id),
      ]);

      const dup = await env.DB.prepare(
        "SELECT id FROM assignments WHERE cycle_id = ? AND reviewer_id = ? AND reviewee_id = ?",
      )
        .bind(cycleId, body.reviewer_id, body.reviewee_id)
        .first<{ id: number }>();
      if (dup) {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "이미 동일한 리뷰어-피평가자 매칭이 등록되어 있습니다.",
        );
      }

      const now = nowIso();
      const res = await env.DB.prepare(
        `INSERT INTO assignments (cycle_id, reviewer_id, reviewee_id, is_submitted, created_at)
         VALUES (?, ?, ?, 0, ?)`,
      )
        .bind(cycleId, body.reviewer_id, body.reviewee_id, now)
        .run();

      if (cycle.status === "ACTIVE") {
        await ensurePinAndEnqueueDelivery(env, cycleId, body.reviewer_id);
      }

      const created = await requireAssignment(
        env.DB,
        Number(res.meta.last_row_id),
      );
      const summary = await toAssignmentSummary(env.DB, created);
      return jsonResponse(summary, 201);
    },
  );

  router.post(
    "/api/admin/cycles/:cycleId/assignments/auto-match",
    async ({ req, params, env }) => {
      const cycleId = parsePathId(params.cycleId, "cycleId");
      const cycle = await requireCycle(env.DB, cycleId);
      if (
        (cycle.status !== "DRAFT" && cycle.status !== "ACTIVE") ||
        isCycleDeadlinePassed(cycle)
      ) {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "마감되었거나 종료된 회차에는 자동 매칭을 실행할 수 없습니다.",
        );
      }

      const { match_type } = validateAutoMatchAssignments(
        await readJsonBody(req),
      );
      const members = await listAllMembers(env.DB);
      const existingRows = await env.DB.prepare(
        "SELECT reviewer_id, reviewee_id FROM assignments WHERE cycle_id = ?",
      )
        .bind(cycleId)
        .all<{ reviewer_id: number; reviewee_id: number }>();

      const existingPairs = new Set(
        existingRows.results.map((r) => `${r.reviewer_id}:${r.reviewee_id}`),
      );

      const now = nowIso();
      const newPairs: { reviewer_id: number; reviewee_id: number }[] = [];
      for (const a of members) {
        for (const b of members) {
          if (a.id === b.id) continue;
          if (
            match_type === "SAME_DEPARTMENT" &&
            a.department !== b.department
          ) {
            continue;
          }
          const key = `${a.id}:${b.id}`;
          if (!existingPairs.has(key)) {
            existingPairs.add(key);
            newPairs.push({ reviewer_id: a.id, reviewee_id: b.id });
          }
        }
      }

      if (newPairs.length > 0) {
        const stmts = newPairs.map((p) =>
          env.DB.prepare(
            `INSERT INTO assignments (cycle_id, reviewer_id, reviewee_id, is_submitted, created_at)
             VALUES (?, ?, ?, 0, ?)
             ON CONFLICT(cycle_id, reviewer_id, reviewee_id) DO NOTHING`,
          ).bind(cycleId, p.reviewer_id, p.reviewee_id, now),
        );
        await env.DB.batch(stmts);
      }

      if (cycle.status === "ACTIVE" && newPairs.length > 0) {
        const uniqueReviewers = new Set(newPairs.map((p) => p.reviewer_id));
        for (const reviewerId of uniqueReviewers) {
          await ensurePinAndEnqueueDelivery(env, cycleId, reviewerId);
        }
      }

      return jsonResponse({ created_count: newPairs.length }, 200);
    },
  );

  router.delete(
    "/api/admin/assignments/:assignmentId",
    async ({ params, env }) => {
      const assignmentId = parsePathId(params.assignmentId, "assignmentId");
      const assignment: AssignmentRecord = await requireAssignment(
        env.DB,
        assignmentId,
      );
      const cycle = await requireCycle(env.DB, assignment.cycle_id);

      if (
        assignment.is_submitted ||
        (cycle.status !== "DRAFT" && cycle.status !== "ACTIVE") ||
        isCycleDeadlinePassed(cycle)
      ) {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "이미 제출되었거나 마감된 회차의 매칭은 삭제할 수 없습니다.",
        );
      }

      await env.DB.prepare("DELETE FROM assignments WHERE id = ?")
        .bind(assignmentId)
        .run();
      return emptyResponse(204);
    },
  );
}
