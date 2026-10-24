import { createHash } from "node:crypto";
import type { DeliveryPayload, JobRecord } from "./models";
import { WebClient } from "@slack/web-api";
import type { Repository, Row } from "./repository";
import { parseJobPayload } from "./job-payloads";
import { now } from "./domain";
import { closeDeliveredCycle } from "./deliveries";
import { generateAll, generateReport } from "./reports";
import { ChromiumPdfConverter, type PdfConverter } from "./pdf";
export interface Delivery {
  send(
    payload: DeliveryPayload,
    repo: Repository,
  ): Promise<{
    message?: string;
  }>;
}
export class SlackDelivery implements Delivery {
  private client: WebClient | null;
  constructor(
    private mock = process.env.MOCK_SLACK_MODE?.toLowerCase() !== "false",
  ) {
    this.client = mock
      ? null
      : new WebClient(process.env.SLACK_BOT_TOKEN, {
          retryConfig: { retries: 0 },
          rejectRateLimitedCalls: true,
        });
    if (!mock && !process.env.SLACK_BOT_TOKEN)
      throw new Error("실제 Slack 모드에는 SLACK_BOT_TOKEN이 필요합니다.");
  }
  async send(p: DeliveryPayload, repo: Repository) {
    const member = repo.require("members", p.member_id);
    if (this.mock) return { message: "Mock 전송 완료" };
    const client = this.client!;
    let user = member.slack_user_id;
    if (!/^[UW][A-Z0-9]+$/.test(user)) {
      const lookup = await client.users.lookupByEmail({ email: member.email });
      const found = lookup.user?.id;
      if (!found) throw new Error("Slack User ID를 확인할 수 없습니다.");
      user = found;
      repo.run(
        "UPDATE members SET slack_user_id=? WHERE id=?",
        user,
        member.id,
      );
    }
    const dm = await client.conversations.open({ users: user });
    if (!dm.channel?.id) throw new Error("Slack DM 채널을 열 수 없습니다.");
    if (p.type === "REPORT") {
      const report = repo.require("reports", p.report_id),
        cycle = repo.require("cycles", p.cycle_id);
      if (
        report.validation_status !== "APPROVED" ||
        !report.html ||
        report.approved_hash !== p.html_hash ||
        report.revision !== p.revision
      )
        throw new Error("승인된 결과지 파일이 없습니다.");
      if (report.pdf_status !== "READY" || !report.pdf)
        throw new Error("PDF 결과지가 아직 준비되지 않았습니다.");
      await client.filesUploadV2({
        channel_id: dm.channel.id,
        file_uploads: [
          {
            file: Buffer.from(report.html),
            filename: `peer_review_${cycle.id}_${member.id}.html`,
            title: `${cycle.title} 피어리뷰 리포트_${member.name} (HTML)`,
          },
          {
            file: Buffer.from(report.pdf),
            filename: `peer_review_${cycle.id}_${member.id}.pdf`,
            title: `${cycle.title} 피어리뷰 리포트_${member.name} (PDF)`,
          },
        ],
        initial_comment: `[${cycle.title}] 피어리뷰 HTML·PDF 결과 리포트가 도착했습니다.`,
      });
    } else
      await client.chat.postMessage({ channel: dm.channel.id, text: p.text });
    return {};
  }
}
export class JobRunner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  constructor(
    public repo: Repository,
    private delivery: Delivery,
    private pdf: PdfConverter = new ChromiumPdfConverter(),
  ) {}
  recover() {
    this.repo.run(
      "UPDATE jobs SET status='PENDING' WHERE status='RUNNING' AND kind IN ('GENERATE','PDF')",
    );
    this.repo.run(
      "UPDATE jobs SET status='UNKNOWN',error='서버 재시작으로 전송 결과를 확인할 수 없습니다. Slack에서 확인 후 처리해 주세요.' WHERE status='RUNNING' AND kind NOT IN ('GENERATE','PDF')",
    );
  }
  start() {
    this.recover();
    this.timer = setInterval(() => {
      void this.tick();
    }, 500);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    while (this.busy) await Bun.sleep(25);
  }
  async tick() {
    if (this.busy) return false;
    this.busy = true;
    try {
      const job = this.repo.transaction(() => {
        const j = this.repo.one<JobRecord>(
          "SELECT * FROM jobs WHERE status='PENDING' AND available_at<=? ORDER BY id LIMIT 1",
          Date.now(),
        );
        if (j)
          this.repo.run(
            "UPDATE jobs SET status='RUNNING',attempts=attempts+1 WHERE id=?",
            j.id,
          );
        return j;
      });
      if (!job) return false;
      let pdfSource: string | undefined;
      let parsed: ReturnType<typeof parseJobPayload> | undefined;
      try {
        parsed = parseJobPayload(job.kind, job.payload);
        if (parsed.kind === "GENERATE") {
          const p = parsed.payload;
          if (p.member_id) generateReport(this.repo, p.cycle_id, p.member_id);
          else generateAll(this.repo, p.cycle_id, !!p.sample);
        } else if (parsed.kind === "PDF") {
          const p = parsed.payload;
          const report = this.repo.require("reports", p.report_id);
          if (!report.html) {
            this.repo.run(
              "UPDATE jobs SET status='DONE',error='대체된 PDF 작업 취소' WHERE id=?",
              job.id,
            );
            return true;
          }
          pdfSource = report.html;
          const currentHash = createHash("sha256")
            .update(report.html ?? "")
            .digest("hex");
          if (currentHash === p.html_hash) {
            const bytes = await this.pdf.convert(report.html);
            this.repo.run(
              "UPDATE reports SET pdf=?,pdf_status='READY',error_log='' WHERE id=? AND html=?",
              bytes,
              report.id,
              report.html,
            );
          }
        } else {
          const p = parsed.payload;
          if (p.type === "AUTH_CODE" || p.type === "REMINDER") {
            const cycle = this.repo.cycle(p.cycle_id!);
            if (cycle.status !== "ACTIVE" || cycle.is_deadline_passed) {
              this.repo.run(
                "UPDATE jobs SET status='DONE',error='마감된 회차의 알림 취소' WHERE id=?",
                job.id,
              );
              return true;
            }
          }
          if (p.type === "REPORT") {
            const report = this.repo.require("reports", p.report_id);
            if (
              report.revision !== p.revision ||
              report.approved_hash !== p.html_hash ||
              report.validation_status !== "APPROVED"
            ) {
              this.repo.run(
                "UPDATE jobs SET status='DONE',error='승인된 생성물과 다른 발송 작업 취소' WHERE id=?",
                job.id,
              );
              return true;
            }
          }
          await this.delivery.send(p, this.repo);
          this.repo.transaction(() => {
            this.repo.run(
              "INSERT INTO delivery_logs(job_id,cycle_id,member_id,delivery_type,message_content,is_success,sent_at) VALUES (?,?,?,?,?,1,?)",
              job.id,
              p.cycle_id ?? null,
              p.member_id,
              p.type,
              p.type === "AUTH_CODE"
                ? "인증 PIN 발송"
                : "text" in p
                  ? p.text
                  : "HTML·PDF 결과지 발송",
              now(),
            );
            if (p.type === "REPORT") {
              this.repo.run(
                "UPDATE reports SET is_sent=1,sent_at=?,validation_status='SENT' WHERE id=?",
                now(),
                p.report_id,
              );
              closeDeliveredCycle(this.repo, p.cycle_id);
            }
          });
        }
        this.repo.run(
          "UPDATE jobs SET status='DONE',error='' WHERE id=?",
          job.id,
        );
      } catch (e) {
        const error = e as {
          code?: string;
          retryAfter?: number;
          data?: {
            error?: string;
          };
          message?: string;
        };
        const rateLimit = error.code === "slack_webapi_rate_limited_error";
        // API errors are known rejections. Network errors may mean a message was delivered.
        const known =
          !parsed ||
          ["GENERATE", "PDF"].includes(job.kind) ||
          rateLimit ||
          error.code === "slack_webapi_platform_error";
        const status =
          rateLimit && job.attempts < 4
            ? "PENDING"
            : known
              ? "FAILED"
              : "UNKNOWN";
        this.repo.transaction(() => {
          this.repo.run(
            "UPDATE jobs SET status=?,error=?,available_at=? WHERE id=?",
            status,
            error.data?.error ?? error.message ?? "작업 실패",
            Date.now() + Math.max(1, error.retryAfter ?? 30) * 1000,
            job.id,
          );
          if (parsed?.kind === "PDF")
            this.repo.run(
              "UPDATE reports SET pdf_status='FAILED',error_log=? WHERE id=? AND html=?",
              error.message ?? "PDF 변환 실패",
              parsed.payload.report_id,
              pdfSource ?? null,
            );
          if (parsed?.kind === "DM" || parsed?.kind === "REPORT") {
            const p = parsed.payload;
            this.repo.run(
              "INSERT INTO delivery_logs(job_id,cycle_id,member_id,delivery_type,message_content,is_success,error_message,sent_at) VALUES (?,?,?,?,?,0,?,?)",
              job.id,
              p.cycle_id ?? null,
              p.member_id,
              p.type,
              p.type === "AUTH_CODE"
                ? "인증 PIN 발송"
                : "text" in p
                  ? p.text
                  : "HTML·PDF 결과지 발송",
              error.message ?? "전송 오류",
              now(),
            );
          }
        });
      }
      return true;
    } finally {
      this.busy = false;
    }
  }
}
