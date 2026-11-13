import { nowIso } from "../crypto.ts";
import {
  ensurePinAndEnqueueDelivery,
  getCycleDetail,
  listCycleAssignments,
  listCycleQuestions,
  requireCycle,
  toCycleDetail,
} from "../db/queries.ts";
import { jsonResponse, readJsonBody, type Router } from "../router.ts";
import {
  parsePathId,
  validateCloseCycle,
  validateCreateCycle,
  validateUpdateCycle,
} from "../schemas.ts";
import {
  ApiError,
  type CycleRecord,
  type MemberRecord,
  type ReportRecord,
} from "../types.ts";

const DEFAULT_NOTICE =
  "본인에게 배정된 리뷰만 표시되며 관리자 기능에는 접근할 수 없습니다.";

export function registerCyclesRoutes(router: Router): void {
  router.get("/api/admin/cycles", async ({ env }) => {
    const rows = await env.DB.prepare(
      "SELECT * FROM cycles ORDER BY created_at DESC, id DESC",
    ).all<CycleRecord>();
    const items = await Promise.all(
      rows.results.map((c) => toCycleDetail(env.DB, c)),
    );
    return jsonResponse({ items });
  });

  router.post("/api/admin/cycles", async ({ req, env }) => {
    const data = validateCreateCycle(await readJsonBody(req));
    const now = nowIso();
    const notice = data.reviewer_notice_message ?? DEFAULT_NOTICE;

    const res = await env.DB.prepare(
      `INSERT INTO cycles (title, status, start_at, end_at, reviewer_notice_message, created_at, updated_at)
       VALUES (?, 'DRAFT', ?, ?, ?, ?, ?)`,
    )
      .bind(data.title, data.start_at, data.end_at, notice, now, now)
      .run();

    const detail = await getCycleDetail(env.DB, Number(res.meta.last_row_id));
    return jsonResponse(detail, 201);
  });

  router.get("/api/admin/cycles/:cycleId", async ({ params, env }) => {
    const cycleId = parsePathId(params.cycleId, "cycleId");
    const cycle = await getCycleDetail(env.DB, cycleId);
    const assignments = await listCycleAssignments(env.DB, cycleId);

    const reviewersMap = new Map<number, MemberRecord>();
    for (const a of assignments) {
      reviewersMap.set(a.reviewer.id, a.reviewer);
    }

    const reviewer_progress = [...reviewersMap.values()].map((reviewer) => {
      const myAssignments = assignments.filter(
        (a) => a.reviewer.id === reviewer.id,
      );
      const unsubmitted = myAssignments
        .filter((a) => !a.is_submitted)
        .map((a) => a.reviewee);
      const total_count = myAssignments.length;
      const submitted_count = total_count - unsubmitted.length;
      return {
        reviewer,
        total_count,
        submitted_count,
        is_all_done: total_count > 0 && unsubmitted.length === 0,
        unsubmitted_reviewees: unsubmitted,
      };
    });

    return jsonResponse({ cycle, reviewer_progress });
  });

  router.patch("/api/admin/cycles/:cycleId", async ({ req, params, env }) => {
    const cycleId = parsePathId(params.cycleId, "cycleId");
    const cycle = await requireCycle(env.DB, cycleId);
    if (cycle.status === "CLOSED") {
      throw new ApiError(
        409,
        "STATE_CONFLICT",
        "종료된(CLOSED) 회차는 수정할 수 없습니다.",
      );
    }

    const patch = validateUpdateCycle(await readJsonBody(req));
    const hasCoreFieldChange =
      patch.title !== undefined ||
      patch.start_at !== undefined ||
      patch.end_at !== undefined;
    if (hasCoreFieldChange && cycle.status !== "DRAFT") {
      throw new ApiError(
        409,
        "STATE_CONFLICT",
        "제목 및 시작·마감 일시는 DRAFT 상태에서만 수정할 수 있습니다.",
      );
    }

    const title = patch.title ?? cycle.title;
    const start_at = patch.start_at ?? cycle.start_at;
    const end_at = patch.end_at ?? cycle.end_at;
    const reviewer_notice_message =
      patch.reviewer_notice_message ?? cycle.reviewer_notice_message;

    if (Date.parse(end_at) <= Date.parse(start_at)) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "마감 일시는 시작 일시보다 이후여야 합니다.",
      );
    }

    await env.DB.prepare(
      `UPDATE cycles
       SET title = ?, start_at = ?, end_at = ?, reviewer_notice_message = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        title,
        start_at,
        end_at,
        reviewer_notice_message,
        nowIso(),
        cycleId,
      )
      .run();

    const updated = await getCycleDetail(env.DB, cycleId);
    return jsonResponse(updated);
  });

  router.post("/api/admin/cycles/:cycleId/start", async ({ params, env }) => {
    const cycleId = parsePathId(params.cycleId, "cycleId");
    const cycle = await getCycleDetail(env.DB, cycleId);

    if (cycle.status !== "DRAFT") {
      throw new ApiError(
        409,
        "STATE_CONFLICT",
        "초안(DRAFT) 상태의 회차만 시작할 수 있습니다.",
      );
    }
    if (Date.parse(cycle.end_at) <= Date.now()) {
      throw new ApiError(
        409,
        "STATE_CONFLICT",
        "마감 일시가 현재 시각보다 이전입니다.",
      );
    }

    const questions = await listCycleQuestions(env.DB, cycleId);
    if (questions.length === 0 || cycle.total_assignments_count === 0) {
      throw new ApiError(
        409,
        "STATE_CONFLICT",
        "설문 문항과 리뷰 매칭을 먼저 등록해 주세요.",
      );
    }

    const missingOptions = questions.some(
      (q) =>
        (q.question_type === "SINGLE_CHOICE" ||
          q.question_type === "MULTIPLE_CHOICE") &&
        q.options.length === 0,
    );
    if (missingOptions) {
      throw new ApiError(
        409,
        "STATE_CONFLICT",
        "모든 객관식 문항에 최소 1개 이상의 선택지를 추가해 주세요.",
      );
    }

    const now = nowIso();
    await env.DB.prepare(
      "UPDATE cycles SET status = 'ACTIVE', updated_at = ? WHERE id = ?",
    )
      .bind(now, cycleId)
      .run();

    const reviewersRes = await env.DB.prepare(
      "SELECT DISTINCT reviewer_id FROM assignments WHERE cycle_id = ? ORDER BY reviewer_id ASC",
    )
      .bind(cycleId)
      .all<{ reviewer_id: number }>();

    for (const row of reviewersRes.results) {
      await ensurePinAndEnqueueDelivery(env, cycleId, row.reviewer_id);
    }

    const updated = await getCycleDetail(env.DB, cycleId);
    return jsonResponse(updated, 200);
  });

  router.post(
    "/api/admin/cycles/:cycleId/close",
    async ({ req, params, env }) => {
      const cycleId = parsePathId(params.cycleId, "cycleId");
      const body = validateCloseCycle(await readJsonBody(req, true));
      const cycle = await getCycleDetail(env.DB, cycleId);

      if (cycle.status !== "ACTIVE") {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "진행 중(ACTIVE) 상태의 회차만 마감할 수 있습니다.",
        );
      }

      const submittedAnswerCountRow = await env.DB.prepare(
        `SELECT COUNT(a.id) AS cnt
         FROM answers a
         JOIN assignments s ON s.id = a.assignment_id
         WHERE s.cycle_id = ? AND s.is_submitted = 1`,
      )
        .bind(cycleId)
        .first<{ cnt: number }>();
      const submittedAnswerCount = Number(submittedAnswerCountRow?.cnt ?? 0);

      if (cycle.submitted_assignments_count < 1 || submittedAnswerCount < 1) {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "제출된 피어리뷰 답변이 최소 1개 이상 포함되어야 회차를 마감할 수 있습니다.",
        );
      }

      if (body.require_all_submitted && !cycle.is_all_submitted) {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "아직 전원 제출이 완료되지 않았습니다.",
        );
      }

      const now = nowIso();
      await env.DB.prepare(
        "UPDATE cycles SET status = 'COMPLETED', end_at = ?, updated_at = ? WHERE id = ?",
      )
        .bind(now, now, cycleId)
        .run();

      const revieweesRes = await env.DB.prepare(
        "SELECT DISTINCT reviewee_id FROM assignments WHERE cycle_id = ? ORDER BY reviewee_id ASC",
      )
        .bind(cycleId)
        .all<{ reviewee_id: number }>();

      for (const { reviewee_id } of revieweesRes.results) {
        const existingReport = await env.DB.prepare(
          "SELECT * FROM reports WHERE cycle_id = ? AND reviewee_id = ?",
        )
          .bind(cycleId, reviewee_id)
          .first<ReportRecord>();

        let reportId: number;
        let revision: number;
        if (existingReport) {
          revision = existingReport.revision + 1;
          reportId = existingReport.id;
          await env.DB.prepare(
            `UPDATE reports
             SET revision = ?, generation_status = 'PENDING', approval_status = 'NEEDS_REVIEW',
                 error_message = '', updated_at = ?
             WHERE id = ?`,
          )
            .bind(revision, now, reportId)
            .run();
        } else {
          revision = 1;
          const ins = await env.DB.prepare(
            `INSERT INTO reports (cycle_id, reviewee_id, revision, generation_status, approval_status, error_message, created_at, updated_at)
             VALUES (?, ?, 1, 'PENDING', 'NEEDS_REVIEW', '', ?, ?)`,
          )
            .bind(cycleId, reviewee_id, now, now)
            .run();
          reportId = Number(ins.meta.last_row_id);
        }

        await env.REPORT_QUEUE.send({
          job_type: "GENERATE_REPORT",
          cycle_id: cycleId,
          reviewee_id,
          report_id: reportId,
          revision,
        });
      }

      const updated = await getCycleDetail(env.DB, cycleId);
      return jsonResponse(updated, 202);
    },
  );

  router.post(
    "/api/admin/cycles/:cycleId/reminders",
    async ({ params, env }) => {
      const cycleId = parsePathId(params.cycleId, "cycleId");
      const cycle = await getCycleDetail(env.DB, cycleId);

      if (cycle.status !== "ACTIVE" || cycle.is_deadline_passed) {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "마감 전 진행 중(ACTIVE) 회차에서만 리마인더를 발송할 수 있습니다.",
        );
      }

      const unsubmittedReviewers = await env.DB.prepare(
        "SELECT DISTINCT reviewer_id FROM assignments WHERE cycle_id = ? AND is_submitted = 0 ORDER BY reviewer_id ASC",
      )
        .bind(cycleId)
        .all<{ reviewer_id: number }>();

      const now = nowIso();
      let queued_count = 0;

      for (const { reviewer_id } of unsubmittedReviewers.results) {
        const pendingReminder = await env.DB.prepare(
          "SELECT id FROM deliveries WHERE cycle_id = ? AND member_id = ? AND delivery_type = 'REMINDER' AND status = 'PENDING' LIMIT 1",
        )
          .bind(cycleId, reviewer_id)
          .first<{ id: number }>();

        if (!pendingReminder) {
          const dedupeKey = `reminder:${cycleId}:${reviewer_id}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
          const ins = await env.DB.prepare(
            `INSERT INTO deliveries (cycle_id, member_id, report_id, delivery_type, status, dedupe_key, attempts, error_message, created_at, updated_at)
             VALUES (?, ?, NULL, 'REMINDER', 'PENDING', ?, 0, '', ?, ?)`,
          )
            .bind(cycleId, reviewer_id, dedupeKey, now, now)
            .run();
          const deliveryId = Number(ins.meta.last_row_id);
          await env.DELIVERY_QUEUE.send({
            job_type: "SEND_SLACK_DELIVERY",
            delivery_id: deliveryId,
          });
          queued_count++;
        }

        await env.DB.prepare(
          "UPDATE assignments SET last_reminded_at = ? WHERE cycle_id = ? AND reviewer_id = ? AND is_submitted = 0",
        )
          .bind(now, cycleId, reviewer_id)
          .run();
      }

      return jsonResponse({ queued_count }, 202);
    },
  );
}
