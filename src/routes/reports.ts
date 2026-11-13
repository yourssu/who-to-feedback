import { nowIso } from "../crypto.ts";
import {
  listCycleReports,
  requireCycle,
  requireReport,
  toReportSummary,
} from "../db/queries.ts";
import { jsonResponse, type Router } from "../router.ts";
import { parsePathId } from "../schemas.ts";
import { ApiError, type ReportRecord } from "../types.ts";

export function registerReportsRoutes(router: Router): void {
  router.get("/api/admin/cycles/:cycleId/reports", async ({ params, env }) => {
    const cycleId = parsePathId(params.cycleId, "cycleId");
    const cycle = await requireCycle(env.DB, cycleId);

    // 생성 실패(FAILED) 상태인 리포트가 마지막 시도 후 15초 이상 경과했으면 자동으로 재시도 큐에 등록
    if (cycle.status !== "CLOSED") {
      const failedRows = await env.DB.prepare(
        "SELECT * FROM reports WHERE cycle_id = ? AND generation_status = 'FAILED' ORDER BY id ASC",
      )
        .bind(cycleId)
        .all<ReportRecord>();

      const nowMs = Date.now();
      for (const r of failedRows.results) {
        const lastUpdatedMs = Date.parse(r.updated_at);
        if (!Number.isNaN(lastUpdatedMs) && nowMs - lastUpdatedMs >= 15_000) {
          const nextRevision = r.revision + 1;
          const now = nowIso();
          await env.DB.prepare(
            `UPDATE reports
             SET revision = ?, generation_status = 'PENDING', approval_status = 'NEEDS_REVIEW',
                 approved_hash = NULL, error_message = '', updated_at = ?
             WHERE id = ? AND generation_status = 'FAILED'`,
          )
            .bind(nextRevision, now, r.id)
            .run();

          await env.REPORT_QUEUE.send({
            job_type: "GENERATE_REPORT",
            cycle_id: r.cycle_id,
            reviewee_id: r.reviewee_id,
            report_id: r.id,
            revision: nextRevision,
          });
        }
      }
    }

    const items = await listCycleReports(env.DB, cycleId);
    return jsonResponse({ items });
  });

  router.post(
    "/api/admin/reports/:reportId/regenerate",
    async ({ params, env }) => {
      const reportId = parsePathId(params.reportId, "reportId");
      const report = await requireReport(env.DB, reportId);
      const cycle = await requireCycle(env.DB, report.cycle_id);

      if (cycle.status === "CLOSED") {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "종료된(CLOSED) 회차의 리포트는 재생성할 수 없습니다.",
        );
      }
      if (report.approval_status === "SENT") {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "이미 발송 완료된 리포트는 재생성할 수 없습니다.",
        );
      }

      const pendingDelivery = await env.DB.prepare(
        "SELECT id FROM deliveries WHERE report_id = ? AND status = 'PENDING' LIMIT 1",
      )
        .bind(reportId)
        .first<{ id: number }>();
      if (pendingDelivery) {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "현재 Slack 발송 대기 중인 리포트는 재생성할 수 없습니다.",
        );
      }

      const nextRevision = report.revision + 1;
      const now = nowIso();
      await env.DB.prepare(
        `UPDATE reports
         SET revision = ?, generation_status = 'PENDING', approval_status = 'NEEDS_REVIEW',
             approved_hash = NULL, error_message = '', updated_at = ?
         WHERE id = ?`,
      )
        .bind(nextRevision, now, reportId)
        .run();

      await env.REPORT_QUEUE.send({
        job_type: "GENERATE_REPORT",
        cycle_id: report.cycle_id,
        reviewee_id: report.reviewee_id,
        report_id: reportId,
        revision: nextRevision,
      });

      const updated = await requireReport(env.DB, reportId);
      const summary = await toReportSummary(env.DB, updated);
      return jsonResponse(summary, 202);
    },
  );

  router.get(
    "/api/admin/reports/:reportId/html",
    async ({ url, params, env }) => {
      const reportId = parsePathId(params.reportId, "reportId");
      const report = await requireReport(env.DB, reportId);
      if (report.generation_status !== "READY" || !report.html_r2_key) {
        throw new ApiError(
          404,
          "NOT_FOUND",
          "HTML 리포트가 아직 생성되지 않았습니다.",
        );
      }

      const obj = await env.FILES.get(report.html_r2_key);
      if (!obj) {
        throw new ApiError(
          404,
          "NOT_FOUND",
          "스토리지에서 HTML 리포트 파일을 찾을 수 없습니다.",
        );
      }

      const headers = new Headers({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;",
      });
      if (url.searchParams.get("download") === "true") {
        headers.set(
          "Content-Disposition",
          `attachment; filename="peer_review_${report.cycle_id}_${report.reviewee_id}.html"`,
        );
      }
      return new Response(await obj.text(), { status: 200, headers });
    },
  );

  router.get(
    "/api/admin/reports/:reportId/pdf",
    async ({ url, params, env }) => {
      const reportId = parsePathId(params.reportId, "reportId");
      const report = await requireReport(env.DB, reportId);
      if (report.generation_status !== "READY" || !report.pdf_r2_key) {
        throw new ApiError(
          404,
          "NOT_FOUND",
          "PDF 리포트가 아직 준비되지 않았습니다.",
        );
      }

      const obj = await env.FILES.get(report.pdf_r2_key);
      if (!obj) {
        throw new ApiError(
          404,
          "NOT_FOUND",
          "스토리지에서 PDF 리포트 파일을 찾을 수 없습니다.",
        );
      }

      const disposition =
        url.searchParams.get("download") === "true" ? "attachment" : "inline";
      const headers = new Headers({
        "Content-Type": "application/pdf",
        "Cache-Control": "no-store",
        "Content-Disposition": `${disposition}; filename="peer_review_${report.cycle_id}_${report.reviewee_id}.pdf"`,
      });
      return new Response(await obj.arrayBuffer(), { status: 200, headers });
    },
  );

  router.post(
    "/api/admin/cycles/:cycleId/reports/publish",
    async ({ params, env }) => {
      const cycleId = parsePathId(params.cycleId, "cycleId");
      const cycle = await requireCycle(env.DB, cycleId);
      if (cycle.status !== "COMPLETED") {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "마감 완료(COMPLETED) 상태의 회차에서만 리포트를 승인·발송할 수 있습니다.",
        );
      }

      const targetCountRow = await env.DB.prepare(
        "SELECT COUNT(DISTINCT reviewee_id) AS cnt FROM assignments WHERE cycle_id = ?",
      )
        .bind(cycleId)
        .first<{ cnt: number }>();
      const targetCount = Number(targetCountRow?.cnt ?? 0);

      const reportsRes = await env.DB.prepare(
        "SELECT * FROM reports WHERE cycle_id = ? ORDER BY reviewee_id ASC",
      )
        .bind(cycleId)
        .all<ReportRecord>();
      const reports = reportsRes.results;

      if (
        targetCount === 0 ||
        reports.length !== targetCount ||
        reports.some(
          (r) =>
            r.generation_status !== "READY" ||
            !r.html_r2_key ||
            !r.pdf_r2_key ||
            !r.content_hash,
        )
      ) {
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "모든 피평가자의 HTML·PDF 리포트 생성이 완료(READY)된 후에만 승인·발송할 수 있습니다.",
        );
      }

      const now = nowIso();
      let queued_count = 0;

      for (const r of reports) {
        if (r.approval_status === "SENT") continue;

        await env.DB.prepare(
          `UPDATE reports
           SET approval_status = 'APPROVED', approved_hash = ?, updated_at = ?
           WHERE id = ?`,
        )
          .bind(r.content_hash, now, r.id)
          .run();

        const dedupeKey = `report:${r.id}:rev:${r.revision}`;
        const existingDelivery = await env.DB.prepare(
          "SELECT id, status FROM deliveries WHERE dedupe_key = ?",
        )
          .bind(dedupeKey)
          .first<{ id: number; status: string }>();

        if (!existingDelivery) {
          const ins = await env.DB.prepare(
            `INSERT INTO deliveries (cycle_id, member_id, report_id, delivery_type, status, dedupe_key, attempts, error_message, created_at, updated_at)
             VALUES (?, ?, ?, 'REPORT', 'PENDING', ?, 0, '', ?, ?)`,
          )
            .bind(cycleId, r.reviewee_id, r.id, dedupeKey, now, now)
            .run();
          const deliveryId = Number(ins.meta.last_row_id);
          await env.DELIVERY_QUEUE.send({
            job_type: "SEND_SLACK_DELIVERY",
            delivery_id: deliveryId,
          });
          queued_count++;
        } else if (existingDelivery.status === "FAILED") {
          await env.DB.prepare(
            "UPDATE deliveries SET status = 'PENDING', error_message = '', updated_at = ? WHERE id = ?",
          )
            .bind(now, existingDelivery.id)
            .run();
          await env.DELIVERY_QUEUE.send({
            job_type: "SEND_SLACK_DELIVERY",
            delivery_id: existingDelivery.id,
          });
          queued_count++;
        }
      }

      return jsonResponse({ queued_count }, 202);
    },
  );
}
