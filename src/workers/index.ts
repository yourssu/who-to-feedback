import { createHash } from "node:crypto";
import { DurableObject } from "cloudflare:workers";
import { Repository } from "../repository";
import { applyMigrations } from "../migrations";
import { createApp } from "../app";
import { DurableSqlite } from "./sqlite";
import { platform, prepareReports } from "./platform";
import { parseJobPayload } from "../job-payloads";
import { enqueue, now } from "../domain";
import { renderReport, commitReport, hashReport } from "../reports";
import { closeDeliveredCycle } from "../deliveries";
import { convertPdf } from "./pdf";
import { deliver, SlackError } from "./slack";
interface Env {
  APP: DurableObjectNamespace<Peerflow>;
  ASSETS: Fetcher;
  FILES: R2Bucket;
  BROWSER: Fetcher;
  GENERATE_QUEUE: Queue<{ id: number }>;
  DELIVERY_QUEUE: Queue<{ id: number }>;
  SITE_URL?: string;
  MOCK_SLACK_MODE: string;
  SLACK_BOT_TOKEN?: string;
}
const instance = (env: Env) => env.APP.get(env.APP.idFromName("peerflow-v1"));
export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname.startsWith("/static/"))
      return env.ASSETS.fetch(request);
    return instance(env).fetch(request);
  },
  async queue(batch: MessageBatch<{ id: number }>, env: Env) {
    for (const message of batch.messages) {
      try {
        await instance(env).processJob(message.body.id);
        message.ack();
      } catch (error) {
        console.error("queue processing failed", error);
        message.retry({ delaySeconds: 60 });
      }
    }
  },
  async scheduled(_event: ScheduledController, env: Env) {
    await instance(env).maintenance();
  },
} satisfies ExportedHandler<Env, { id: number }>;

export class Peerflow extends DurableObject<Env> {
  private repo: Repository;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = new DurableSqlite(ctx.storage);
    applyMigrations(db);
    ctx.storage.transactionSync(() => {
      const columns = db.query("PRAGMA table_info(jobs)").all() as {
        name: string;
      }[];
      if (!columns.some((c) => c.name === "lease_token")) {
        db.exec(
          "ALTER TABLE jobs ADD COLUMN lease_token TEXT; ALTER TABLE jobs ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0; ALTER TABLE jobs ADD COLUMN queued_at INTEGER NOT NULL DEFAULT 0;",
        );
      }
    });
    ctx.storage.transactionSync(() => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS report_input_epoch(id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL); INSERT OR IGNORE INTO report_input_epoch VALUES (1,0);",
      );
      for (const table of [
        "cycles",
        "members",
        "questions",
        "options",
        "assignments",
        "answers",
        "answer_options",
      ]) {
        for (const event of ["INSERT", "UPDATE", "DELETE"])
          db.exec(
            `CREATE TRIGGER IF NOT EXISTS epoch_${table}_${event} AFTER ${event} ON ${table} BEGIN UPDATE report_input_epoch SET value=value+1 WHERE id=1; END`,
          );
      }
    });
    this.repo = new Repository(db, platform(env));
  }
  async fetch(request: Request) {
    // Header is accepted only from Cloudflare's ingress; no X-Real-IP trust.
    const repo = new Repository(this.repo.db, platform(this.env));
    repo.platform!.siteUrl ??= new URL(request.url).origin;
    repo.platform!.prepareReports = (cycle) =>
      prepareReports(repo, this.env, cycle);
    const response = await createApp(repo).fetch(request, {
      clientIp: request.headers.get("CF-Connecting-IP") ?? "local",
    });
    this.ctx.waitUntil(this.dispatch());
    return response;
  }
  async dispatch() {
    const jobs = this.repo.all(
      "SELECT id,kind FROM jobs WHERE status='PENDING' AND available_at<=? AND queued_at<? ORDER BY id LIMIT 100",
      Date.now(),
      Date.now() - 300000,
    );
    for (const job of jobs) {
      const claimed = this.repo.run(
        "UPDATE jobs SET queued_at=? WHERE id=? AND status='PENDING' AND queued_at<?",
        Date.now(),
        job.id,
        Date.now() - 300000,
      );
      if (!claimed.changes) continue;
      try {
        await (
          ["GENERATE", "PDF"].includes(job.kind)
            ? this.env.GENERATE_QUEUE
            : this.env.DELIVERY_QUEUE
        ).send({ id: job.id });
      } catch (error) {
        this.repo.run("UPDATE jobs SET queued_at=0 WHERE id=?", job.id);
        console.error("outbox dispatch failed", job.id, error);
      }
    }
  }
  async processJob(id: number) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid job ID");
    const token = crypto.randomUUID();
    const claimed = this.repo.run(
      "UPDATE jobs SET status='RUNNING',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=? AND status='PENDING' AND available_at<=?",
      token,
      Date.now() + 10 * 60 * 1000,
      id,
      Date.now(),
    );
    if (!claimed.changes) return;
    const job = this.repo.require("jobs", id);
    const owns = () =>
      !!this.repo.one(
        "SELECT id FROM jobs WHERE id=? AND status='RUNNING' AND lease_token=? AND lease_until>?",
        id,
        token,
        Date.now(),
      );
    let pdfReference: string | null = null;
    let parsed: ReturnType<typeof parseJobPayload> | undefined;
    try {
      parsed = parseJobPayload(job.kind, job.payload);
      if (parsed.kind === "GENERATE") {
        const p = parsed.payload;
        if (p.member_id) {
          const reportRepo = new Repository(this.repo.db, platform(this.env));
          await prepareReports(reportRepo, this.env, p.cycle_id);
          if (!owns()) return;
          if (this.repo.require("cycles", p.cycle_id).status === "CLOSED")
            throw new Error("Closed cycle cannot regenerate reports");
          const epoch = this.repo.one(
            "SELECT value FROM report_input_epoch WHERE id=1",
          )!.value;
          const rendered = renderReport(reportRepo, p.cycle_id, p.member_id);
          if (Buffer.byteLength(rendered.html) > 32 * 1024 * 1024)
            throw new Error("HTML exceeds 32 MiB");
          const contentHash = createHash("sha256")
              .update(rendered.html)
              .digest("hex"),
            key = `reports/${contentHash}-${crypto.randomUUID()}.html`;
          await this.env.FILES.put(key, rendered.html, {
            httpMetadata: { contentType: "text/html; charset=utf-8" },
          });
          if (!owns()) return;
          // Awaiting R2 allows other requests to change answers/templates. Never commit stale output.
          if (
            this.repo.one("SELECT value FROM report_input_epoch WHERE id=1")!
              .value !== epoch ||
            this.repo.require("cycles", p.cycle_id).status === "CLOSED"
          )
            throw new Error(
              "Report inputs changed during generation; retry required",
            );
          commitReport(
            this.repo,
            p.cycle_id,
            p.member_id,
            `r2:${key}`,
            rendered.context,
            rendered.version,
          );
        } else {
          this.repo.transaction(() => {
            this.repo.require("cycles", p.cycle_id);
            for (const member of this.repo.all(
              `SELECT DISTINCT reviewee_id FROM assignments WHERE cycle_id=? ORDER BY reviewee_id ${p.sample ? "LIMIT 3" : ""}`,
              p.cycle_id,
            )) {
              enqueue(
                this.repo,
                "GENERATE",
                { cycle_id: p.cycle_id, member_id: member.reviewee_id },
                `generate-child:${id}:${member.reviewee_id}`,
              );
            }
          });
        }
      } else if (parsed.kind === "PDF") {
        const p = parsed.payload,
          report = this.repo.require("reports", p.report_id);
        pdfReference = report.html;
        if (report.html && hashReport(report.html) === p.html_hash) {
          const response = await this.repo.platform!.artifact(
            report.html,
            "text/html",
          );
          if (!response.ok) throw new Error("HTML artifact missing");
          const bytes = await convertPdf(
            this.env.BROWSER,
            await response.text(),
          );
          const key = `reports/${createHash("sha256").update(bytes).digest("hex")}-${crypto.randomUUID()}.pdf`;
          await this.env.FILES.put(key, bytes, {
            httpMetadata: { contentType: "application/pdf" },
          });
          if (!owns()) return;
          this.repo.run(
            "UPDATE reports SET pdf=?,pdf_status='READY',error_log='' WHERE id=? AND html=?",
            new TextEncoder().encode(`r2:${key}`),
            report.id,
            report.html,
          );
        }
      } else {
        const p = parsed.payload;
        let valid = true;
        if (p.type === "AUTH_CODE" || p.type === "REMINDER") {
          const cycle = this.repo.cycle(p.cycle_id!);
          valid = cycle.status === "ACTIVE" && !cycle.is_deadline_passed;
        }
        if (p.type === "REPORT") {
          const report = this.repo.require("reports", p.report_id);
          valid =
            report.revision === p.revision &&
            report.approved_hash === p.html_hash &&
            report.validation_status === "APPROVED";
        }
        if (valid) {
          await deliver(this.repo, p, this.env);
          if (!owns()) return;
          this.repo.transaction(() => {
            this.repo.run(
              "INSERT INTO delivery_logs(job_id,cycle_id,member_id,delivery_type,message_content,is_success,sent_at) VALUES (?,?,?,?,?,1,?)",
              id,
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
                "UPDATE reports SET is_sent=1,sent_at=?,validation_status='SENT' WHERE id=? AND revision=? AND approved_hash=?",
                now(),
                p.report_id,
                p.revision,
                p.html_hash,
              );
              closeDeliveredCycle(this.repo, p.cycle_id);
            }
            this.repo.run(
              "UPDATE jobs SET status='DONE',error='',lease_until=0 WHERE id=? AND lease_token=?",
              id,
              token,
            );
          });
        }
      }
      this.repo.run(
        "UPDATE jobs SET status='DONE',error='',lease_until=0 WHERE id=? AND lease_token=? AND status='RUNNING'",
        id,
        token,
      );
    } catch (error) {
      if (!owns()) return;
      const message = error instanceof Error ? error.message : "Job failed";
      const external = job.kind === "DM" || job.kind === "REPORT";
      const known = !parsed || (error instanceof SlackError && error.known);
      const retry =
        (known &&
          error instanceof SlackError &&
          error.retryAfter > 0 &&
          job.attempts < 5) ||
        (!external && !!parsed && job.attempts < 3);
      const status = retry
        ? "PENDING"
        : external && !known
          ? "UNKNOWN"
          : "FAILED";
      this.repo.transaction(() => {
        this.repo.run(
          "UPDATE jobs SET status=?,error=?,available_at=?,queued_at=0,lease_until=0 WHERE id=? AND lease_token=?",
          status,
          message,
          Date.now() +
            ((error instanceof SlackError && error.retryAfter) || 30) * 1000,
          id,
          token,
        );
        if (parsed?.kind === "PDF") {
          const p = parsed.payload;
          this.repo.run(
            "UPDATE reports SET pdf_status='FAILED',error_log=? WHERE id=? AND html=?",
            message,
            p.report_id,
            pdfReference,
          );
        }
        if (parsed?.kind === "GENERATE" && parsed.payload.member_id) {
          this.repo.run(
            "INSERT INTO reports(cycle_id,reviewee_id,validation_status,error_log,created_at) VALUES (?,?,'FAILED',?,?) ON CONFLICT(cycle_id,reviewee_id) DO UPDATE SET error_log=excluded.error_log",
            parsed.payload.cycle_id,
            parsed.payload.member_id,
            message,
            now(),
          );
        }
        if (parsed?.kind === "DM" || parsed?.kind === "REPORT") {
          const p = parsed.payload;
          this.repo.run(
            "INSERT INTO delivery_logs(job_id,cycle_id,member_id,delivery_type,message_content,is_success,error_message,sent_at) VALUES (?,?,?,?,?,0,?,?)",
            id,
            p.cycle_id ?? null,
            p.member_id,
            p.type,
            "발송 오류",
            message,
            now(),
          );
        }
      });
      console.error("job failed", id, status, message);
    } finally {
      this.ctx.waitUntil(this.dispatch());
    }
  }
  async maintenance() {
    const cutoff = Date.now();
    this.repo.transaction(() => {
      this.repo.run(
        "UPDATE jobs SET status=CASE WHEN kind IN ('GENERATE','PDF') THEN 'PENDING' ELSE 'UNKNOWN' END,error='실행 임대 만료; 외부 발송은 수신 여부 확인 필요',queued_at=0,lease_token=NULL WHERE status='RUNNING' AND lease_until<?",
        cutoff,
      );
      this.repo.run("DELETE FROM sessions WHERE expires_at<?", cutoff);
      this.repo.run(
        "DELETE FROM login_attempts WHERE updated_at<?",
        cutoff - 86400000,
      );
    });
    await this.dispatch();
    // Bounded orphan sweep; retain all referenced objects and a 35-day PITR/in-flight grace period.
    const cursor = await this.ctx.storage.get<string>("r2-sweep-cursor");
    const listing = await this.env.FILES.list({ limit: 100, cursor });
    for (const object of listing.objects) {
      if (
        !object.key.startsWith("media/") &&
        !object.key.startsWith("reports/")
      )
        continue;
      if (object.uploaded.getTime() > cutoff - 35 * 86400000) continue;
      const used = object.key.startsWith("media/")
        ? this.repo.one(
            "SELECT id FROM questions WHERE image=? LIMIT 1",
            object.key.slice(6),
          )
        : this.repo.one(
            "SELECT id FROM reports WHERE html=? OR CAST(pdf AS TEXT)=? LIMIT 1",
            `r2:${object.key}`,
            `r2:${object.key}`,
          );
      if (!used) await this.env.FILES.delete(object.key);
    }
    if (listing.truncated)
      await this.ctx.storage.put("r2-sweep-cursor", listing.cursor);
    else await this.ctx.storage.delete("r2-sweep-cursor");
  }
}
