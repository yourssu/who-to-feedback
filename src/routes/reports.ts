import { z } from "zod";
import { DomainError } from "../db";
import { enqueue } from "../domain";
import {
  checkLayouts,
  invalidateReports,
  publish,
  reportRows,
} from "../reports";
import { validateCustomTemplate } from "../templates";
import type { HttpServices } from "../http/types";
export function registerReportsRoutes(services: HttpServices) {
  const { repo, route, page, flash, form, id, back } = services;
  route("admin_reports", "get", (c) =>
    page(c, "admin_custom/reports.html", {
      cycle: repo.cycle(id(c)),
      reports: reportRows(repo, id(c)),
    }),
  );
  route("admin_delivery_checklist", "get", (c) =>
    page(c, "admin_custom/reports.html", {
      cycle: repo.cycle(id(c)),
      show_checklist: true,
      checklist: repo
        .all(
          "SELECT DISTINCT reviewee_id FROM assignments WHERE cycle_id=?",
          id(c),
        )
        .map((a) => {
          const member = repo.require("members", a.reviewee_id),
            r = repo.one(
              "SELECT * FROM reports WHERE cycle_id=? AND reviewee_id=?",
              id(c),
              member.id,
            );
          return {
            member,
            department: member.department,
            has_slack_id: !!member.slack_user_id,
            has_html: !!r?.html,
            has_pdf: r?.pdf_status === "READY",
            is_approved: ["APPROVED", "SENT"].includes(r?.validation_status),
          };
        }),
    }),
  );
  route("admin_preview_report_html", "get", (c) => {
    const report = repo.require("reports", id(c, "report_id"));
    if (!report.html)
      throw new DomainError("결과지가 아직 생성되지 않았습니다.", 404);
    c.header(
      "Content-Security-Policy",
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
    );
    if (c.req.query("download") === "1")
      c.header(
        "Content-Disposition",
        `attachment; filename="peer_review_${report.id}.html"`,
      );
    return c.html(report.html);
  });
  route("admin_report_pdf", "get", (c) => {
    const report = repo.require("reports", id(c, "report_id"));
    if (!report.pdf || report.pdf_status !== "READY")
      throw new DomainError("PDF가 아직 준비되지 않았습니다.", 404);
    c.header(
      "Content-Disposition",
      `attachment; filename="peer_review_${report.id}.pdf"`,
    );
    return c.body(new Uint8Array(report.pdf), 200, {
      "Content-Type": "application/pdf",
    });
  });
  route("admin_save_report_memo", "post", (c) => {
    const r = repo.require("reports", id(c, "report_id"));
    repo.run(
      "UPDATE reports SET admin_memo=? WHERE id=?",
      z
        .string()
        .max(5000)
        .parse(form(c).admin_memo ?? ""),
      r.id,
    );
    return back(c, r.cycle_id);
  });
  route("admin_regenerate_report", "post", (c) => {
    const r = repo.require("reports", id(c, "report_id"));
    if (repo.cycle(r.cycle_id).status === "CLOSED")
      throw new DomainError("배포가 종료된 결과지는 재생성할 수 없습니다.");
    enqueue(
      repo,
      "GENERATE",
      { cycle_id: r.cycle_id, member_id: r.reviewee_id },
      `regenerate:${r.id}:${crypto.randomUUID()}`,
    );
    return back(c, r.cycle_id);
  });
  route("admin_generate_sample_reports", "post", (c) => {
    const cycle = repo.cycle(id(c));
    if (cycle.status === "CLOSED")
      throw new DomainError(
        "배포가 종료된 회차에서는 샘플을 생성할 수 없습니다.",
      );
    enqueue(
      repo,
      "GENERATE",
      { cycle_id: id(c), sample: true },
      `sample:${id(c)}:${crypto.randomUUID()}`,
    );
    return back(c, id(c));
  });
  route("admin_run_layout_check", "post", (c) => {
    repo.require("cycles", id(c));
    const passed = checkLayouts(repo, id(c));
    flash(
      c,
      `자동 레이아웃 검사 완료: ${passed}명 통과. 긴 답변은 HTML·PDF 미리보기로 확인해 주세요.`,
    );
    return back(c, id(c));
  });
  route("admin_publish_reports_action", "post", (c) => {
    publish(repo, id(c));
    flash(c, "검토를 완료하고 결과지 발송 작업을 등록했습니다.");
    return back(c, id(c));
  });
  route("admin_upload_custom_template", "post", async (c) => {
    const cycle = repo.cycle(id(c));
    if (cycle.status === "CLOSED")
      throw new DomainError("배포가 종료된 양식은 변경할 수 없습니다.");
    const file = form(c).html_file;
    if (!(file instanceof File) || !/\.html?$/i.test(file.name))
      throw new DomainError("HTML 파일을 선택해 주세요.");
    const source = await file.text();
    validateCustomTemplate(source);
    repo.transaction(() => {
      invalidateReports(repo, cycle.id);
      repo.run(
        "UPDATE cycles SET custom_template=?,custom_template_name=?,use_custom_template=1 WHERE id=?",
        source,
        file.name,
        cycle.id,
      );
      repo.log(cycle.id, "커스텀 결과지 양식 변경", true);
    });
    return back(c, cycle.id);
  });
  route("admin_toggle_custom_template", "post", (c) => {
    const cycle = repo.cycle(id(c));
    if (cycle.status === "CLOSED" || !cycle.custom_template)
      throw new DomainError("변경할 수 있는 양식이 없습니다.");
    repo.transaction(() => {
      invalidateReports(repo, cycle.id);
      repo.run(
        "UPDATE cycles SET use_custom_template=1-use_custom_template WHERE id=?",
        cycle.id,
      );
      repo.log(cycle.id, "결과지 양식 적용 변경", true);
    });
    return back(c, cycle.id);
  });
}
