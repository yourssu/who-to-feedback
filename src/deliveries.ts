import { DomainError, type Repository } from "./db";
import { now } from "./domain";
export function resolveDelivery(
  repo: Repository,
  jobId: number,
  resolution: "SENT" | "NOT_SENT",
) {
  repo.transaction(() => {
    const job = repo.require("jobs", jobId);
    if (job.status !== "UNKNOWN" || !["DM", "REPORT"].includes(job.kind))
      throw new DomainError("확인이 필요한 발송 작업만 처리할 수 있습니다.");
    const payload = JSON.parse(job.payload);
    if (job.kind === "REPORT") {
      const report = repo.require("reports", payload.report_id);
      if (
        report.revision !== payload.revision ||
        report.approved_hash !== payload.html_hash
      )
        throw new DomainError("현재 승인된 결과지와 다른 작업입니다.");
      if (resolution === "SENT") {
        repo.run(
          "UPDATE reports SET is_sent=1,sent_at=?,validation_status='SENT' WHERE id=?",
          now(),
          report.id,
        );
        closeDeliveredCycle(repo, payload.cycle_id);
      }
    }
    repo.run(
      "UPDATE jobs SET status=?,error=?,available_at=0,resolved_at=?,resolution=? WHERE id=?",
      resolution === "SENT" ? "DONE" : "PENDING",
      resolution === "SENT"
        ? "관리자가 Slack 수신 확인"
        : "관리자가 미수신 확인 후 재전송 요청",
      now(),
      resolution,
      jobId,
    );
    repo.run(
      "INSERT INTO delivery_logs(job_id,cycle_id,member_id,delivery_type,message_content,is_success,error_message,sent_at) VALUES (?,?,?,?,?,?,?,?)",
      jobId,
      payload.cycle_id ?? null,
      payload.member_id,
      payload.type,
      "관리자 발송 결과 확인",
      resolution === "SENT" ? 1 : 0,
      resolution === "SENT" ? "" : "미수신 확인 후 재전송",
      now(),
    );
  });
}
export function closeDeliveredCycle(repo: Repository, cycle: number) {
  const targets = repo.one(
    "SELECT count(DISTINCT reviewee_id) n FROM assignments WHERE cycle_id=?",
    cycle,
  )!.n;
  const sent = repo.one(
    "SELECT count(*) n FROM reports WHERE cycle_id=? AND is_sent=1",
    cycle,
  )!.n;
  if (sent === targets && targets > 0)
    repo.run("UPDATE cycles SET status='CLOSED' WHERE id=?", cycle);
}
export function retryFailedDeliveries(repo: Repository) {
  // Do not bypass the explicit UNKNOWN resolution or replay replaced report content.
  repo.run(
    "UPDATE jobs SET status='PENDING',available_at=0 WHERE status='FAILED' AND kind IN ('DM','REPORT')",
  );
}
