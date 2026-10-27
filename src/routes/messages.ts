import { z } from "zod";
import { DomainError, type Row } from "../repository";
import { enqueue } from "../domain";
import { resolveDelivery, retryFailedDeliveries } from "../deliveries";
import type { Ctx, HttpServices } from "../http/types";
export function registerMessagesRoutes(services: HttpServices) {
  const { repo, route, page, flash, form, id, numeric } = services;
  const messagePage = (c: Ctx) => {
    const failed_logs = repo
      .all(
        "SELECT j.id job_id,j.kind,j.payload,j.status job_status,j.error,j.created_at sent_at FROM jobs j WHERE j.kind IN ('DM','REPORT') AND j.status IN ('FAILED','UNKNOWN') ORDER BY j.id DESC",
      )
      .map((job) => {
        const p = JSON.parse(job.payload),
          member = repo.one("SELECT * FROM members WHERE id=?", p.member_id);
        return {
          ...job,
          job_status: job.job_status,
          member: member ?? { name: "삭제된 팀원" },
          get_delivery_type_display: (
            {
              AUTH_CODE: "인증 PIN",
              REMINDER: "리마인더",
              REPORT: "HTML·PDF 결과지",
              CUSTOM_MSG: "운영 메시지",
              TEST_DM: "테스트 DM",
            } as Row
          )[p.type],
          error_message:
            job.job_status === "UNKNOWN"
              ? "전송 결과 확인 필요: Slack에서 수신 여부를 확인해 주세요. " +
                job.error
              : job.error,
        };
      });
    return page(c, "admin_custom/send_message.html", {
      members: repo.members(),
      cycle: repo.latest(),
      active_menu: "messages",
      failed_logs,
      retryable_count: failed_logs.filter((j) => j.job_status === "FAILED")
        .length,
    });
  };
  route("admin_resolve_delivery", "post", (c) => {
    const resolution = z.enum(["SENT", "NOT_SENT"]).parse(form(c).resolution);
    resolveDelivery(repo, id(c, "job_id"), resolution);
    flash(
      c,
      resolution === "SENT"
        ? "Slack 수신 확인을 기록했습니다."
        : "미수신 확인을 기록하고 재전송을 요청했습니다.",
    );
    return c.redirect("/admin/messages/send/");
  });
  route("admin_send_message", "get", messagePage);
  route("admin_send_message", "post", (c) => {
    const data = form(c),
      text = z.string().trim().min(1).max(500).parse(data.message_text);
    const members =
      data.recipient_type === "ALL"
        ? repo.members()
        : [repo.require("members", numeric(data.member_id))];
    repo.transaction(() => {
      for (const m of members)
        enqueue(
          repo,
          "DM",
          { member_id: m.id, type: "CUSTOM_MSG", text },
          `custom:${crypto.randomUUID()}`,
        );
    });
    flash(c, `${members.length}명의 DM 발송 작업을 등록했습니다.`);
    return c.redirect("/admin/messages/send/");
  });
  route("admin_retry_failed_messages", "post", (c) => {
    retryFailedDeliveries(repo);
    flash(
      c,
      "실패가 확인된 발송 작업을 재등록했습니다. 전송 결과가 불명확한 작업은 자동 재발송하지 않습니다.",
    );
    return c.redirect("/admin/messages/send/");
  });
  route("admin_send_test_dm", "post", (c) => {
    const admin = repo.require("admins", c.get("session").admin_id!),
      member = repo.one("SELECT id FROM members WHERE email=?", admin.email);
    if (!member)
      throw new DomainError(
        "관리자 이메일과 같은 팀원의 Slack 정보를 먼저 등록해 주세요.",
      );
    enqueue(
      repo,
      "DM",
      {
        member_id: member.id,
        type: "TEST_DM",
        text: "PeerFlow Slack 연동 테스트 메시지입니다.",
      },
      `test:${crypto.randomUUID()}`,
    );
    flash(c, "관리자 테스트 DM 작업을 등록했습니다.");
    return c.redirect("/admin/messages/send/");
  });
}
