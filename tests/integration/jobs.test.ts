import { afterEach, expect, test } from "bun:test";
import { fixture, answers, mockPdf } from "../helpers";
import { JobRunner, type Delivery } from "../../src/jobs";
import { closeCycle, startCycle, submitReview } from "../../src/domain";
import { createApp } from "../../src/app";
import { Client } from "../helpers";
import { resolveDelivery } from "../../src/deliveries";
import { generateReport, publish } from "../../src/reports";
import type { Repository } from "../../src/db";
const repos: Repository[] = [];
const db = () => {
  const r = fixture();
  repos.push(r);
  return r;
};
afterEach(() => repos.splice(0).forEach((r) => r.db.close()));
const success: Delivery = { send: async () => ({}) };
test("전체 생성·승인·발송이 끝난 회차만 종료하고 중복 발송하지 않는다", async () => {
  const r = db();
  startCycle(r, 1);
  for (const a of r.assignments(1))
    submitReview(r, a.id, a.reviewer_id, 1, answers());
  const runner = new JobRunner(r, success, mockPdf);
  while (await runner.tick()) {}
  closeCycle(r, 1, true);
  while (await runner.tick()) {}
  expect(r.all("SELECT * FROM reports")).toHaveLength(2);
  expect(r.cycle(1).status).toBe("COMPLETED");
  publish(r, 1);
  publish(r, 1);
  expect(r.all("SELECT * FROM jobs WHERE kind='REPORT'")).toHaveLength(2);
  while (await runner.tick()) {}
  expect(r.cycle(1).status).toBe("CLOSED");
  expect(r.all("SELECT * FROM reports WHERE is_sent=1")).toHaveLength(2);
});
test("전송 결과가 불명확하면 자동 재시도하지 않는다", async () => {
  const r = db();
  startCycle(r, 1);
  const runner = new JobRunner(r, {
    send: async () => {
      throw Object.assign(new Error("connection reset"), {
        code: "slack_webapi_request_error",
      });
    },
  });
  await runner.tick();
  expect(r.one("SELECT status FROM jobs WHERE id=1")!.status).toBe("UNKNOWN");
  await runner.tick();
  expect(r.one("SELECT attempts FROM jobs WHERE id=1")!.attempts).toBe(1);
});
test("재시작 시 생성은 복구하고 전송은 UNKNOWN으로 보존한다", () => {
  const r = db();
  startCycle(r, 1);
  r.run("UPDATE jobs SET status='RUNNING' WHERE id=1");
  closeCycle(r, 1);
  r.run("UPDATE jobs SET status='RUNNING' WHERE kind='GENERATE'");
  new JobRunner(r, success, mockPdf).recover();
  expect(r.one("SELECT status FROM jobs WHERE id=1")!.status).toBe("UNKNOWN");
  expect(r.one("SELECT status FROM jobs WHERE kind='GENERATE'")!.status).toBe(
    "PENDING",
  );
});
test("Slack rate limit은 지정 시간 이후 재시도한다", async () => {
  const r = db();
  startCycle(r, 1);
  const runner = new JobRunner(r, {
    send: async () => {
      throw Object.assign(new Error("rate limited"), {
        code: "slack_webapi_rate_limited_error",
        retryAfter: 60,
      });
    },
  });
  await runner.tick();
  const job = r.require("jobs", 1);
  expect(job.status).toBe("PENDING");
  expect(job.available_at).toBeGreaterThan(Date.now() + 50000);
});
test("부분 발송 실패는 전체 회차를 CLOSED로 만들지 않는다", async () => {
  const r = db();
  startCycle(r, 1);
  const runner = new JobRunner(r, success, mockPdf);
  while (await runner.tick()) {}
  closeCycle(r, 1);
  while (await runner.tick()) {}
  publish(r, 1);
  const failing = new JobRunner(r, {
    send: async (p) => {
      if (p.member_id === 2)
        throw Object.assign(new Error("invalid_auth"), {
          code: "slack_webapi_platform_error",
        });
      return {};
    },
  });
  while (await failing.tick()) {}
  expect(r.cycle(1).status).toBe("COMPLETED");
  expect(r.all("SELECT * FROM reports WHERE is_sent=1")).toHaveLength(1);
});

test("부분 발송 뒤 동일 생성물 재생성은 발송 이력과 PDF를 보존한다", async () => {
  const r = db();
  startCycle(r, 1);
  for (const a of r.assignments(1))
    submitReview(r, a.id, a.reviewer_id, 1, answers());
  const runner = new JobRunner(r, success, mockPdf);
  while (await runner.tick()) {}
  closeCycle(r, 1);
  while (await runner.tick()) {}
  publish(r, 1);
  const partial = new JobRunner(
    r,
    {
      send: async (p) => {
        if (p.member_id === 2)
          throw Object.assign(new Error("rejected"), {
            code: "slack_webapi_platform_error",
          });
        return {};
      },
    },
    mockPdf,
  );
  while (await partial.tick()) {}
  const before = r.one("SELECT * FROM reports WHERE reviewee_id=1")!;
  generateReport(r, 1, 1);
  publish(r, 1);
  const after = r.require("reports", before.id);
  expect(after.is_sent).toBe(1);
  expect(after.validation_status).toBe("SENT");
  expect(after.revision).toBe(before.revision);
  expect(after.pdf_status).toBe("READY");
  expect(r.all("SELECT * FROM jobs WHERE kind='REPORT'")).toHaveLength(2);
});

test("변경된 생성물은 재승인하고 이전 실패 작업이 새 파일을 보내지 않는다", async () => {
  const r = db();
  startCycle(r, 1);
  for (const a of r.assignments(1))
    submitReview(r, a.id, a.reviewer_id, 1, answers());
  const runner = new JobRunner(r, success, mockPdf);
  while (await runner.tick()) {}
  closeCycle(r, 1);
  while (await runner.tick()) {}
  publish(r, 1);
  const failed = new JobRunner(
    r,
    {
      send: async () => {
        throw Object.assign(new Error("rejected"), {
          code: "slack_webapi_platform_error",
        });
      },
    },
    mockPdf,
  );
  while (await failed.tick()) {}
  r.run(
    "UPDATE answers SET answer_text='내용이 변경된 충분히 구체적인 피드백입니다.' WHERE answer_text IS NOT NULL",
  );
  generateReport(r, 1, 1);
  const report = r.one("SELECT * FROM reports WHERE reviewee_id=1")!;
  expect(report.revision).toBe(2);
  expect(report.approved_hash).toBeNull();
  expect(report.validation_status).toBe("NEEDS_REVIEW");
  while (await runner.tick()) {}
  publish(r, 1);
  while (await runner.tick()) {}
  expect(r.require("reports", report.id).is_sent).toBe(1);
  expect(r.cycle(1).status).toBe("COMPLETED");
});

test("로그 없이 재시작한 UNKNOWN도 표시하고 수신 확인으로 마무리한다", async () => {
  const r = db();
  startCycle(r, 1);
  const client = new Client(createApp(r));
  await client.admin();
  r.run("UPDATE jobs SET status='RUNNING' WHERE id=1");
  new JobRunner(r, success, mockPdf).recover();
  expect(
    await (await client.request("/admin/messages/send/")).text(),
  ).toContain("수신 확인 완료");
  resolveDelivery(r, 1, "SENT");
  expect(r.require("jobs", 1).status).toBe("DONE");
  expect(r.require("jobs", 1).resolution).toBe("SENT");
  expect(() => resolveDelivery(r, 1, "NOT_SENT")).toThrow();
});

test("보고서 UNKNOWN 미수신 확인 후 동일 승인 대상으로만 재전송한다", async () => {
  const r = db();
  startCycle(r, 1);
  for (const a of r.assignments(1))
    submitReview(r, a.id, a.reviewer_id, 1, answers());
  const runner = new JobRunner(r, success, mockPdf);
  while (await runner.tick()) {}
  closeCycle(r, 1);
  while (await runner.tick()) {}
  publish(r, 1);
  const unknown = new JobRunner(
    r,
    {
      send: async () => {
        throw new Error("connection lost");
      },
    },
    mockPdf,
  );
  while (await unknown.tick()) {}
  const jobs = r.all("SELECT * FROM jobs WHERE kind='REPORT'");
  resolveDelivery(r, jobs[0].id, "SENT");
  resolveDelivery(r, jobs[1].id, "NOT_SENT");
  while (await runner.tick()) {}
  expect(r.cycle(1).status).toBe("CLOSED");
  expect(r.all("SELECT * FROM reports WHERE is_sent=1")).toHaveLength(2);
});

test("손상된 작업 payload는 FAILED로 남고 다음 작업을 계속 처리한다", async () => {
  const r = db();
  r.run(
    "INSERT INTO jobs(kind,payload,dedupe_key,created_at) VALUES (?,?,?,?)",
    "DM",
    "not-json",
    "broken",
    "2026-01-01",
  );
  startCycle(r, 1);
  const runner = new JobRunner(r, success, mockPdf);
  expect(await runner.tick()).toBe(true);
  expect(r.require("jobs", 1).status).toBe("FAILED");
  expect(await runner.tick()).toBe(true);
  expect(r.require("jobs", 2).status).toBe("DONE");
});

test("생성 실패 작업은 DONE으로 숨기지 않고 원인을 남긴다", async () => {
  const r = db();
  r.run(
    "INSERT INTO jobs(kind,payload,dedupe_key,created_at) VALUES (?,?,?,?)",
    "GENERATE",
    JSON.stringify({ cycle_id: 999 }),
    "invalid-cycle",
    "2026-01-01",
  );
  const runner = new JobRunner(r, success, mockPdf);
  await runner.tick();
  expect(r.require("jobs", 1).status).toBe("FAILED");
  expect(r.require("jobs", 1).error).not.toBe("");
});
