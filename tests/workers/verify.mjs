import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
await build({
  entryPoints: ["src/workers/index.ts"],
  outfile: "dist/test-worker.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  external: ["cloudflare:workers", "node:*"],
  alias: {
    "#templates": "./src/workers/templates.ts",
    "#platform-default": "./src/workers/no-local-platform.ts",
    "#report-files": "./src/workers/no-local-files.ts",
  },
});
const options = convertV4MiniflareOptions({
  name: "peerflow-test",
  modules: true,
  scriptPath: "dist/test-worker.mjs",
  compatibilityDate: "2026-10-23",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { APP: { className: "Peerflow", useSQLite: true } },
  r2Buckets: ["FILES"],
  queueProducers: { GENERATE_QUEUE: "generate", DELIVERY_QUEUE: "delivery" },
  queueConsumers: {
    generate: { maxBatchSize: 1 },
    delivery: { maxBatchSize: 1 },
  },
  assets: {
    directory: "dist/assets",
    binding: "ASSETS",
    run_worker_first: true,
    assetConfig: { html_handling: "none" },
  },
  browserRendering: { binding: "BROWSER" },
  bindings: { MOCK_SLACK_MODE: "true" },
  port: 0,
});
options.workers[0].config.assets.hasUserWorker = true;
options.unsafeInspectDurableObjects = true;
const mf = new Miniflare(options);
try {
  const base = await mf.ready;
  console.log("Local workerd:", String(base));
  const cookies = new Map();
  async function request(path, data, jar = cookies, options = {}) {
    const headers = new Headers(options.headers);
    headers.set("Cookie", Array.from(jar, ([k, v]) => `${k}=${v}`).join("; "));
    let body;
    if (data) {
      if (data instanceof FormData) {
        body = data;
        body.set("csrfmiddlewaretoken", jar.get("csrftoken"));
      } else {
        body = new URLSearchParams({
          ...data,
          csrfmiddlewaretoken: jar.get("csrftoken"),
        });
      }
    }
    const response = await fetch(new URL(path, base), {
      method: data ? "POST" : "GET",
      body,
      headers,
      redirect: "manual",
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(";")[0].split("=");
      jar.set(name, value);
    }
    return response;
  }
  const health = await request("/health/");
  assert.equal(health.status, 200, await health.text());
  const setup = await request("/setup/");
  assert.equal(setup.status, 200);
  assert.match(await setup.text(), /csrfmiddlewaretoken/);
  const start = performance.now();
  const competing = new Map();
  await request("/setup/", undefined, competing);
  const credentials = {
    username: "admin",
    email: "admin@example.com",
    password: "test-password",
    password_confirm: "test-password",
  };
  const setupResults = await Promise.all([
    request("/setup/", credentials),
    request("/setup/", credentials, competing),
  ]);
  assert.deepEqual(setupResults.map((r) => r.status).sort(), [302, 404]);
  if (setupResults[0].status !== 302) {
    cookies.clear();
    for (const [name, value] of competing) cookies.set(name, value);
  }
  assert.ok(
    setupResults
      .find((r) => r.status === 302)
      .headers.getSetCookie()
      .some((value) => value.includes("HttpOnly") && value.includes("Secure")),
  );
  console.log("PBKDF2 setup wall ms:", Math.round(performance.now() - start));
  const sql = await mf.unsafeGetDurableObjectStorage(
    "peerflow-test",
    "Peerflow",
    { name: "peerflow-v1" },
  );
  const query = (text, ...args) => sql.exec(text, ...args);
  assert.equal((await query("SELECT count(*) n FROM admins"))[0].n, 1);
  assert.equal((await request("/setup/")).status, 404);
  for (const path of [
    "/admin",
    "/admin/members/",
    "/admin/status/",
    "/admin/validation/",
    "/admin/messages/send/",
  ])
    assert.equal((await request(path)).status, 200, path);
  assert.equal(
    (await request("/media/missing.png", undefined, new Map())).status,
    302,
  );
  assert.equal(
    (
      await request("/admin/members/add/", {
        name: "Alice",
        email: "alice@example.com",
        department: "Team",
      })
    ).status,
    302,
  );
  assert.equal(
    (
      await request("/admin/members/add/", {
        name: "Bob",
        email: "bob@example.com",
        department: "Team",
      })
    ).status,
    302,
  );
  const [a, b] = await query("SELECT id FROM members ORDER BY id");
  await query(
    "INSERT INTO cycles(title,created_at) VALUES ('Workerd test',datetime('now'))",
  );
  const cycle = (await query("SELECT id FROM cycles"))[0].id;
  assert.equal(
    (
      await request(`/admin/cycles/${cycle}/questions/add/`, {
        order: 1,
        question_type: "RATING",
        content: "협업 역량",
        scale_type: "NUMERIC_5",
        category: "기본",
      })
    ).status,
    302,
  );
  const question = (await query("SELECT id FROM questions"))[0].id;
  const imageBytes = Buffer.alloc(2 * 1024 * 1024);
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB0cAAAAASUVORK5CYII=",
    "base64",
  ).copy(imageBytes);
  const imageForm = new FormData();
  for (const [key, value] of Object.entries({
    order: "2",
    question_type: "TEXT",
    content: "이미지 문항",
    category: "기본",
  }))
    imageForm.set(key, value);
  imageForm.set(
    "image",
    new File([imageBytes], "pixel.png", { type: "image/png" }),
  );
  assert.equal(
    (await request(`/admin/cycles/${cycle}/questions/add/`, imageForm)).status,
    302,
  );
  const imageQuestion = (
    await query("SELECT id,image FROM questions WHERE image IS NOT NULL")
  )[0];
  const media = await request(`/media/${imageQuestion.image}`);
  assert.equal(media.status, 200);
  assert.equal((await media.arrayBuffer()).byteLength, imageBytes.length);
  assert.equal(
    (await request(`/media/${imageQuestion.image}`, undefined, new Map()))
      .status,
    302,
  );

  assert.equal(
    (
      await request(`/admin/cycles/${cycle}/assignments/add/`, {
        reviewer_id: a.id,
        reviewee_id: b.id,
      })
    ).status,
    302,
  );
  assert.equal((await query("SELECT count(*) n FROM assignments"))[0].n, 1);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  try {
    await mkdir("artifacts/workers", { recursive: true });
    for (const width of [390, 1440])
      for (const colorScheme of ["light", "dark"]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme,
        });
        await context.addCookies(
          Array.from(cookies, ([name, value]) => ({
            name,
            value,
            url: String(base),
          })),
        );
        const page = await context.newPage();
        const response = await page.goto(new URL("/admin", base).href);
        assert.equal(response.status(), 200);
        assert.ok(!page.url().includes("/login/"));
        await page.screenshot({
          path: `artifacts/workers/dashboard-${width}-${colorScheme}.png`,
          fullPage: true,
        });
        await context.close();
      }
  } finally {
    await browser.close();
  }
  // A failed nested history write must roll back the question and version together.
  await query(
    "CREATE TRIGGER fail_history BEFORE INSERT ON version_logs BEGIN SELECT RAISE(ABORT,'test rollback'); END",
  );
  const before = (await query("SELECT version FROM cycles"))[0].version;
  await request(
    `/admin/cycles/${cycle}/questions/add/`,
    { order: 2, question_type: "TEXT", content: "롤백 확인", category: "기본" },
    cookies,
    { headers: { Accept: "application/json" } },
  );
  assert.equal((await query("SELECT count(*) n FROM questions"))[0].n, 2);
  assert.equal((await query("SELECT version FROM cycles"))[0].version, before);
  await query("DROP TRIGGER fail_history");
  // CSV maximum remains one atomic command (including rollback on a late invalid row).
  const csv =
    "name,email,department\n" +
    Array.from(
      { length: 10000 },
      (_, i) => `Member ${i},member${i}@example.com,Team`,
    ).join("\n");
  const form = new FormData();
  form.set("csv_file", new File([csv], "members.csv", { type: "text/csv" }));
  const csvStart = performance.now();
  const csvResponse = await request("/admin/members/import-csv/", form);
  assert.equal(csvResponse.status, 302, await csvResponse.text());
  assert.equal((await query("SELECT count(*) n FROM members"))[0].n, 10002);
  console.log(
    "10,000-row CSV wall ms:",
    Math.round(performance.now() - csvStart),
  );
  const bad = new FormData();
  bad.set(
    "csv_file",
    new File(
      ["name,email\nTemporary,temp@example.com\nBroken,bad-email"],
      "bad.csv",
    ),
  );
  await request("/admin/members/import-csv/", bad);
  assert.equal(
    (
      await query(
        "SELECT count(*) n FROM members WHERE email='temp@example.com'",
      )
    )[0].n,
    0,
  );
  await request(`/admin/cycles/${cycle}/start/`, {});
  assert.equal((await query("SELECT status FROM cycles"))[0].status, "ACTIVE");
  const pin = (await query("SELECT code FROM pins"))[0].code;
  const reviewer = new Map();
  await request("/login/", undefined, reviewer);
  await request("/login/", { code: pin }, reviewer);
  const assignment = (await query("SELECT id FROM assignments"))[0].id;
  assert.equal(
    (await request(`/review/${assignment}/`, undefined, reviewer)).status,
    200,
  );
  const submit = await request(
    `/review/${assignment}/`,
    {
      [`q_${question}_rating`]: "5",
      [`q_${imageQuestion.id}_text`]: "한국어 이미지 피드백 원문을 보존합니다.",
    },
    reviewer,
  );
  assert.equal(submit.status, 302, await submit.text());
  assert.equal(
    (await query("SELECT is_submitted FROM assignments"))[0].is_submitted,
    1,
  );
  await request(
    `/review/${assignment}/`,
    { [`q_${question}_rating`]: "1" },
    reviewer,
  );
  assert.equal(
    (await query("SELECT rating_value FROM answers"))[0].rating_value,
    5,
  );
  await request(`/admin/cycles/${cycle}/close/`, {});
  const deadline = Date.now() + 300000;
  let report;
  while (Date.now() < deadline) {
    report = (await query("SELECT * FROM reports"))[0];
    if (report?.pdf_status === "READY") break;
    if ((await query("SELECT * FROM jobs WHERE status='FAILED'")).length)
      throw new Error(
        JSON.stringify(
          await query("SELECT kind,error FROM jobs WHERE status='FAILED'"),
        ),
      );
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.equal(
    report?.pdf_status,
    "READY",
    JSON.stringify(await query("SELECT kind,status,error FROM jobs")),
  );
  assert.match(report.html, /^r2:reports\/[a-f0-9]{64}-[a-f0-9-]{36}\.html$/);
  assert.equal(
    (await request(`/admin/reports/${report.id}/preview-html/`)).status,
    200,
  );
  const pdf = await request(`/admin/reports/${report.id}/pdf/`);
  assert.equal(pdf.status, 200);
  assert.ok(pdf.headers.get("content-disposition")?.includes(".pdf"));
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  await request(`/admin/cycles/${cycle}/publish/`, {});
  const sentDeadline = Date.now() + 10000;
  while (
    Date.now() < sentDeadline &&
    (await query("SELECT status FROM cycles"))[0].status !== "CLOSED"
  )
    await new Promise((r) => setTimeout(r, 100));
  assert.equal((await query("SELECT status FROM cycles"))[0].status, "CLOSED");
  // Custom uploaded templates remain renderable at runtime, including embedded TTF fonts.
  await query(
    "INSERT INTO cycles(title,status,created_at) VALUES ('Custom Korean','COMPLETED','now')",
  );
  const customCycle = (await query("SELECT max(id) id FROM cycles"))[0].id;
  await query(
    "INSERT INTO assignments(cycle_id,reviewer_id,reviewee_id,is_submitted) VALUES (?,?,?,1)",
    customCycle,
    a.id,
    b.id,
  );
  const custom = new FormData();
  custom.set(
    "html_file",
    new File(
      [
        `<html><head><style>@font-face{font-family:custom;src:url('{{ font_path }}') format('truetype')}body{font-family:custom}</style></head><body><h1>{{ reviewee.name }}</h1><p>사용자 양식 한글 출력 검증</p><script>document.body.innerHTML='UNSAFE_SCRIPT_EXECUTED'</script><img src="https://example.invalid/blocked.png"></body></html>`,
      ],
      "custom.html",
      { type: "text/html" },
    ),
  );
  assert.equal(
    (await request(`/admin/cycles/${customCycle}/upload-template/`, custom))
      .status,
    302,
  );
  await request(`/admin/cycles/${customCycle}/sample-reports/`, {});
  const customDeadline = Date.now() + 90000;
  let customReport;
  while (Date.now() < customDeadline) {
    customReport = (
      await query("SELECT * FROM reports WHERE cycle_id=?", customCycle)
    )[0];
    if (customReport?.pdf_status === "READY") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(
    customReport?.pdf_status,
    "READY",
    JSON.stringify(await query("SELECT kind,status,error FROM jobs")),
  );
  await mkdir("artifacts/workers", { recursive: true });
  const customPdf = await request(`/admin/reports/${customReport.id}/pdf/`);
  await writeFile(
    "artifacts/workers/custom.pdf",
    Buffer.from(await customPdf.arrayBuffer()),
  );
  const customText = execFileSync(
    "pdftotext",
    ["artifacts/workers/custom.pdf", "-"],
    { encoding: "utf8" },
  );
  assert.ok(customText.replace(/\s/g, "").includes("사용자양식한글출력검증"));
  assert.ok(!customText.includes("UNSAFE_SCRIPT_EXECUTED"));
  const ns = await mf.getDurableObjectNamespace("APP");
  const stub = ns.get(ns.idFromName("peerflow-v1"));
  const delivered = (await query("SELECT id FROM jobs WHERE kind='REPORT'"))[0]
    .id;
  const deliveryCount = (await query("SELECT count(*) n FROM delivery_logs"))[0]
    .n;
  await Promise.all([stub.processJob(delivered), stub.processJob(delivered)]);
  assert.equal(
    (await query("SELECT count(*) n FROM delivery_logs"))[0].n,
    deliveryCount,
  );
  await query(
    "INSERT INTO jobs(kind,payload,dedupe_key,status,lease_until,created_at) VALUES ('DM',?, 'expired-test','RUNNING',1,'now')",
    JSON.stringify({
      member_id: a.id,
      cycle_id: cycle,
      type: "TEST_DM",
      text: "lease test",
    }),
  );
  await stub.maintenance();
  assert.equal(
    (await query("SELECT status FROM jobs WHERE dedupe_key='expired-test'"))[0]
      .status,
    "UNKNOWN",
  );
  await query(
    "INSERT INTO jobs(kind,payload,dedupe_key,created_at) VALUES ('DM','invalid-json','malformed','now')",
  );
  const malformed = (
    await query("SELECT id FROM jobs WHERE dedupe_key='malformed'")
  )[0].id;
  await stub.processJob(malformed);
  assert.equal(
    (await query("SELECT status FROM jobs WHERE id=?", malformed))[0].status,
    "FAILED",
  );
  await mkdir("artifacts/workers", { recursive: true });
  await writeFile("artifacts/workers/report.pdf", bytes);
  const pdfText = execFileSync(
    "pdftotext",
    ["artifacts/workers/report.pdf", "-"],
    { encoding: "utf8" },
  );
  assert.ok(pdfText.includes("Bob"));
  console.log(
    execFileSync("pdfinfo", ["artifacts/workers/report.pdf"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => /Pages:|Page size:|File size:/.test(line))
      .join("\n"),
  );
  console.log(
    "PASS workerd HTTP, SQLite rollback, CSV 10000, review, R2, local Browser PDF, queue generation and mock delivery",
  );
} finally {
  await mf.dispose();
}
