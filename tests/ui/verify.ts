import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../../src/app";
import { openDatabase, type Row } from "../../src/db";
import { seedDemo } from "../../scripts/seed";
import { Client, mockPdf } from "../helpers";
import { closeCycle } from "../../src/domain";
import { JobRunner } from "../../src/jobs";
import { generateAll } from "../../src/reports";
import { templates } from "../../src/templates";

process.env.SITE_URL = "http://peerflow.test";
process.env.NODE_ENV = "test";

// In-process HTTP interception: no production DB, listening port, or real Slack calls.
const root = resolve("artifacts/ui");
mkdirSync(root, { recursive: true });
const repo = openDatabase(":memory:");
const cycle = seedDemo(repo),
  app = createApp(repo);
const admin = new Client(app),
  reviewer = new Client(app),
  anonymous = new Client(app);
const captures: {
  name: string;
  html: string;
  template?: string;
  context?: Row;
}[] = [];
const render = templates.render.bind(templates);
let last: { template: string; context: Row } | undefined;
templates.render = ((name: string, context: Row) => {
  last = { template: name, context };
  return render(name, context);
}) as typeof templates.render;
async function capture(
  client: Client,
  path: string,
  name: string,
  method = "GET",
  data?: Row,
) {
  last = undefined;
  const response = await client.request(path, method, data);
  if (response.status !== 200)
    throw new Error(`${name}: HTTP ${response.status}`);
  const html = await response.text();
  const rendered = last as { template: string; context: Row } | undefined;
  captures.push({ name, html, ...(rendered ?? {}) });
}
await capture(anonymous, "/setup/", "setup");
await capture(anonymous, "/login/", "pin-login");
await capture(anonymous, "/login/", "pin-error", "POST", { code: "000000" });
for (let i = 0; i < 4; i++)
  await anonymous.request("/login/", "POST", { code: "000000" });
await capture(anonymous, "/login/", "pin-locked");
repo.run("DELETE FROM login_attempts");
await capture(anonymous, "/admin/login/", "admin-login");
await capture(anonymous, "/admin/login/", "admin-error", "POST", {
  username: "admin",
  password: "wrong",
});
await admin.admin();
await capture(admin, `/admin-panel/cycles/${cycle}/history/`, "history");
await reviewer.login(repo);
await capture(reviewer, "/", "review-dashboard");
await capture(reviewer, "/review/1/", "review-form");
for (const [path, name] of [
  ["/admin-panel/", "overview"],
  ["/admin-panel/members/", "members"],
  [`/admin-panel/cycles/${cycle}/questions/`, "questions"],
  [`/admin-panel/cycles/${cycle}/assignments/`, "assignments"],
  [`/admin-panel/cycles/${cycle}/status/`, "status"],
  [`/admin-panel/cycles/${cycle}/validation/`, "validation"],
  ["/admin-panel/messages/send/", "messages"],
])
  await capture(admin, path, name);
// Capture operational states without changing the main demo data used by reports.
repo.run(
  "INSERT INTO validation_logs(cycle_id,row_index,issue_type,current_value,created_at) VALUES (?,2,'INVALID_ROW','이메일 형식 오류',?)",
  cycle,
  new Date().toISOString(),
);
repo.run(
  "UPDATE answers SET is_excluded_from_report=1,exclusion_reason='응답 확인 필요' WHERE id=(SELECT id FROM answers WHERE answer_text IS NOT NULL LIMIT 1)",
);
await capture(
  admin,
  `/admin-panel/cycles/${cycle}/validation/`,
  "validation-issues",
);
repo.run("DELETE FROM validation_logs");
repo.run("UPDATE answers SET is_excluded_from_report=0,exclusion_reason=''");
const dm = repo.one("SELECT id FROM jobs WHERE kind='DM' LIMIT 1")!;
repo.run(
  "UPDATE jobs SET status='UNKNOWN',error='서버 재시작으로 확인 필요' WHERE id=?",
  dm.id,
);
await capture(admin, "/admin-panel/messages/send/", "messages-unknown");
repo.run(
  "UPDATE jobs SET status='FAILED',error='Slack 권한 확인 필요' WHERE id=?",
  dm.id,
);
await capture(admin, "/admin-panel/messages/send/", "messages-failed");
repo.run("UPDATE jobs SET status='PENDING',error='' WHERE id=?", dm.id);
closeCycle(repo, cycle);
generateAll(repo, cycle);
// PDF rendering is exercised once in test:pdf; UI only needs ready/error states.
const runner = new JobRunner(repo, { send: async () => ({}) }, mockPdf);
while (await runner.tick()) {}
for (const report of repo.all("SELECT pdf_status,error_log FROM reports"))
  if (report.pdf_status !== "READY")
    throw new Error(report.error_log || "PDF가 준비되지 않았습니다.");
await capture(reviewer, "/review/1/", "review-locked");
await capture(admin, `/admin-panel/cycles/${cycle}/reports/`, "reports");
await capture(admin, `/admin-panel/cycles/${cycle}/checklist/`, "checklist");
const report = repo.one("SELECT id FROM reports LIMIT 1")!;
repo.run(
  "UPDATE reports SET pdf_status='FAILED',error_log='PDF 변환 실패: 재생성 필요' WHERE id=?",
  report.id,
);
await capture(
  admin,
  `/admin-panel/cycles/${cycle}/reports/`,
  "reports-pdf-error",
);
repo.run(
  "UPDATE reports SET pdf_status='READY',error_log='' WHERE id=?",
  report.id,
);
const emptyRepo = openDatabase(":memory:");
const emptyClient = new Client(createApp(emptyRepo));
await emptyClient.admin();
for (const [path, name] of [
  ["/admin-panel/", "overview-empty"],
  ["/admin-panel/members/", "members-empty"],
  ["/admin-panel/messages/send/", "messages-empty"],
  ["/admin-panel/validation/", "validation-empty"],
  ["/admin-panel/status/", "status-empty"],
])
  await capture(emptyClient, path, name);
emptyRepo.run(
  "INSERT INTO cycles(title,created_at) VALUES (?,?)",
  "빈 회차",
  new Date().toISOString(),
);
for (const [path, name] of [
  ["/admin-panel/cycles/1/history/", "history-empty"],
  ["/admin-panel/cycles/1/questions/", "questions-empty"],
  ["/admin-panel/cycles/1/assignments/", "assignments-empty"],
  ["/admin-panel/cycles/1/reports/", "reports-empty"],
])
  await capture(emptyClient, path, name);
emptyRepo.db.close();
captures.push({
  name: "report-html",
  html: repo.one("SELECT html FROM reports LIMIT 1")!.html,
});
for (const capture of captures) {
  await Bun.write(`${root}/${capture.name}.html`, capture.html);
  if (process.env.UI_EXPORT_CONTEXT === "true" && capture.context)
    await Bun.write(
      `${root}/${capture.name}.json`,
      JSON.stringify(
        { template: capture.template, context: capture.context },
        null,
        2,
      ),
    );
}
if (process.env.UI_EXPORT_ONLY === "true") {
  console.log(`HTML ${captures.length}개 출력 완료`);
  repo.db.close();
  process.exit(0);
}
const screens = new Map(captures.map((c) => [c.name, c.html]));
const screenServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/screen/")) {
      const html = screens.get(path.slice("/screen/".length));
      return new Response(html ?? "Not found", {
        status: html ? 200 : 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return app.fetch(request);
  },
});
const flowRepo = openDatabase(":memory:");
seedDemo(flowRepo);
const flowApp = createApp(flowRepo);
const flowServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => flowApp.fetch(request),
});
const flowOrigin = flowServer.url.origin;
process.env.SITE_URL = flowOrigin;
const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(
  executable ? { executablePath: executable } : {},
);
const errors: string[] = [];
const checks: Row[] = [];
try {
  const variants = await Promise.allSettled(
    [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ].map(async (viewport) => {
      for (const theme of ["light", "dark"] as const) {
        const context = await browser.newContext({
          viewport,
          colorScheme: theme,
        });
        context.setDefaultTimeout(15000);
        context.setDefaultNavigationTimeout(15000);
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        for (const capture of captures) {
          await page.goto(`${screenServer.url.origin}/screen/${capture.name}`);
          await page.evaluate(() => document.fonts.ready);
          const horizontalOverflow = await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth + 1,
          );
          if (horizontalOverflow && capture.name !== "report-html")
            errors.push(
              `${capture.name} ${viewport.width} ${theme}: horizontal overflow`,
            );
          await page.screenshot({
            path: `${root}/${capture.name}-${viewport.width}-${theme}.png`,
            fullPage: true,
            animations: "disabled",
          });
          checks.push({
            screen: capture.name,
            width: viewport.width,
            theme,
            horizontalOverflow,
          });
          console.log("PASS", capture.name, viewport.width, theme);
          if (capture.name === "review-form") {
            await page
              .getByRole("button", { name: "리뷰 시작", exact: true })
              .click();
            await page.screenshot({
              path: `${root}/review-rating-${viewport.width}-${theme}.png`,
              fullPage: true,
              animations: "disabled",
            });
            await page
              .locator(".wizard-step.active .rating-option label")
              .nth(3)
              .click();
            await page
              .locator(".wizard-step.active [data-wizard-next]")
              .click();
            await page.screenshot({
              path: `${root}/review-text-${viewport.width}-${theme}.png`,
              fullPage: true,
              animations: "disabled",
            });
            await page
              .locator(".wizard-step.active textarea")
              .fill("항상 구체적인 피드백으로 협업을 도와주셨습니다.");
            await page
              .locator(".wizard-step.active [data-wizard-next]")
              .click();
            await page.screenshot({
              path: `${root}/review-single-${viewport.width}-${theme}.png`,
              fullPage: true,
              animations: "disabled",
            });
            await page
              .locator(".wizard-step.active .option-item")
              .first()
              .click();
            await page
              .locator(".wizard-step.active [data-wizard-next]")
              .click();
            await page.screenshot({
              path: `${root}/review-multi-${viewport.width}-${theme}.png`,
              fullPage: true,
              animations: "disabled",
            });
          }
        }
        await context.close();
      }
    }),
  );
  for (const result of variants)
    if (result.status === "rejected") throw result.reason;
  if (errors.length) throw new Error("브라우저 오류: " + errors.join("\n"));
  // Exercise the real form/CSRF/wizard workflow in a browser using a separate fresh DB.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  context.setDefaultTimeout(15000);
  context.setDefaultNavigationTimeout(15000);
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(`${flowOrigin}/login/`);
  await page
    .locator("#code")
    .fill(flowRepo.one("SELECT code FROM pins WHERE member_id=1")!.code);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await page.waitForURL(`${flowOrigin}/`);
  await page
    .getByRole("link", { name: /리뷰 작성하기/ })
    .first()
    .click();
  await page.getByRole("button", { name: "리뷰 시작", exact: true }).click();
  await page.locator(".wizard-step.active .rating-option label").nth(3).click();
  await page.locator(".wizard-step.active [data-wizard-next]").click();
  await page
    .locator(".wizard-step.active textarea")
    .fill(
      "모바일에서도 임시 저장과 제출이 정상적으로 동작하는지 확인하는 피드백입니다.",
    );
  await page.getByRole("button", { name: "임시 저장", exact: true }).click();
  await page
    .getByRole("button", { name: "임시 저장됨", exact: true })
    .waitFor();
  await page.locator(".wizard-step.active [data-wizard-next]").click();
  await page.locator(".wizard-step.active .option-item").first().click();
  await page.locator(".wizard-step.active [data-wizard-next]").click();
  await page.locator(".wizard-step.active .option-item").first().click();
  await page.getByRole("button", { name: "리뷰 제출", exact: true }).click();
  await page.waitForURL(`${flowOrigin}/`);
  if (flowRepo.require("assignments", 1).is_submitted !== 1)
    throw new Error("브라우저 제출이 DB에 반영되지 않았습니다.");
  await context.close();
  await Bun.write(
    `${root}/checks.json`,
    JSON.stringify({ checks, errors, browserFlow: "PASS" }, null, 2),
  );
  console.log(
    `화면 ${captures.length}개 × 4개 변형, 리뷰 문항 4개 상태 및 실제 제출 흐름 검증 완료: ${root}`,
  );
} finally {
  await browser.close();
  await screenServer.stop(true);
  await flowServer.stop(true);
  flowRepo.db.close();
  repo.db.close();
}
