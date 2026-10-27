// Explicitly invoked against an empty, Mock-Slack staging deployment only.
// Credentials and evidence stay in ignored artifacts; no database backdoor is used.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const base = new URL(process.env.PEERFLOW_STAGING_URL ?? "");
assert.equal(base.protocol, "https:");
assert.ok(
  base.hostname.startsWith("peerflow-staging.") &&
    base.hostname.endsWith(".workers.dev"),
);
assert.equal(
  process.env.PEERFLOW_STAGING_MOCK_CONFIRMED,
  "true",
  "Confirm deployed MOCK_SLACK_MODE=true before testing",
);
const dir = `artifacts/remote-${Date.now()}`;
await mkdir(dir, { recursive: true, mode: 0o700 });
const cookies = new Map();
async function request(path, data, jar = cookies) {
  const body =
    data instanceof FormData
      ? data
      : data
        ? new URLSearchParams(data)
        : undefined;
  if (body) body.set("csrfmiddlewaretoken", jar.get("csrftoken") ?? "");
  const response = await fetch(new URL(path, base), {
    method: body ? "POST" : "GET",
    body,
    redirect: "manual",
    headers: {
      Cookie: Array.from(jar, ([k, v]) => `${k}=${v}`).join("; "),
      Origin: base.origin,
    },
  });
  for (const item of response.headers.getSetCookie()) {
    const [k, v] = item.split(";")[0].split("=");
    jar.set(k, v);
  }
  return response;
}
async function post(path, data = {}) {
  const r = await request(path, data);
  assert.equal(r.status, 302, `${path}: ${await r.text()}`);
  return r.headers.get("location");
}
assert.equal((await request("/health/")).status, 200);
if (process.env.PEERFLOW_STAGING_CREDENTIALS) {
  const credentials = JSON.parse(
    await readFile(process.env.PEERFLOW_STAGING_CREDENTIALS, "utf8"),
  );
  assert.equal(credentials.url, base.origin);
  await request("/admin/login/");
  await post("/admin/login/", {
    username: credentials.username,
    password: credentials.password,
  });
} else {
  assert.equal(
    (await request("/setup/")).status,
    200,
    "Requires empty staging or PEERFLOW_STAGING_CREDENTIALS",
  );
  const password = randomBytes(24).toString("base64url");
  await writeFile(
    `${dir}/credentials.json`,
    JSON.stringify({ url: base.origin, username: "staging-admin", password }),
    { mode: 0o600 },
  );
  await post("/setup/", {
    username: "staging-admin",
    email: "staging@example.com",
    password,
    password_confirm: password,
  });
}
assert.equal((await request("/setup/")).status, 404);
for (const path of [
  "/admin",
  "/admin/members/",
  "/admin/status/",
  "/admin/validation/",
  "/admin/messages/send/",
])
  assert.equal((await request(path)).status, 200, path);
assert.equal((await request("/admin", undefined, new Map())).status, 302);
const csv = new FormData();
csv.set(
  "csv_file",
  new File(
    [
      "name,email,department\n테스트리뷰어,reviewer@example.com,검증팀\n테스트수신자,recipient@example.com,검증팀",
    ],
    "members.csv",
    { type: "text/csv" },
  ),
);
await post("/admin/members/import-csv/", csv);
const members = await (await request("/admin/members/")).text();
const ids = [...members.matchAll(/members\/(\d+)\/delete\//g)].map((m) => m[1]);
assert.equal(ids.length, 2);
const location = await post("/admin/cycles/create/", {
  title: "Workers 원격 검증",
  start_at: new Date().toISOString(),
  end_at: new Date(Date.now() + 86400000).toISOString(),
});
const cycle = location.match(/cycles\/(\d+)\//)[1];
await post(`/admin/cycles/${cycle}/questions/add/`, {
  order: "1",
  question_type: "RATING",
  content: "협업 역량",
  scale_type: "NUMERIC_5",
  category: "기본",
});
await post(`/admin/cycles/${cycle}/assignments/add/`, {
  reviewer_id: ids[0],
  reviewee_id: ids[1],
});
await post(`/admin/cycles/${cycle}/start/`);
const status = await (await request(`/admin/cycles/${cycle}/status/`)).text();
const pin = status.match(/data-test-pin>(\d{6})</)?.[1];
assert.ok(
  pin,
  "TEST_MODE must expose reviewer PIN only to authenticated admin",
);
const reviewer = new Map();
await request("/login/", undefined, reviewer);
assert.equal((await request("/login/", { code: pin }, reviewer)).status, 302);
const dashboard = await (await request("/", undefined, reviewer)).text();
const reviewPath = dashboard.match(/\/review\/\d+\//)?.[0];
assert.ok(reviewPath);
const review = await (await request(reviewPath, undefined, reviewer)).text();
const rating = review.match(/name="(q_\d+_rating)"/)?.[1];
assert.ok(rating);
assert.equal(
  (await request(reviewPath, { [rating]: "5" }, reviewer)).status,
  302,
);
const completed = await (
  await request(`/admin/cycles/${cycle}/status/`)
).text();
assert.ok(completed.includes("100%"));
await post(`/admin/cycles/${cycle}/close/`);
const reportsPath = `/admin/cycles/${cycle}/reports/`;
let pdfPath;
for (let i = 0; i < 90; i++) {
  const html = await (await request(reportsPath)).text();
  assert.ok(
    !html.includes("PDF 변환 실패") &&
      !html.includes('class="alert alert-error report-error"'),
    "Remote report generation failed",
  );
  pdfPath = html.match(/\/admin\/reports\/\d+\/pdf\//)?.[0];
  if (pdfPath) break;
  await new Promise((r) => setTimeout(r, 2000));
}
assert.ok(pdfPath, "PDF queue timeout");
const pdf = await request(pdfPath);
assert.equal(pdf.status, 200);
const bytes = Buffer.from(await pdf.arrayBuffer());
assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
await writeFile(`${dir}/report.pdf`, bytes);
const extracted = execFileSync("pdftotext", [`${dir}/report.pdf`, "-"], {
  encoding: "utf8",
});
assert.match(extracted.replace(/\s/g, ""), /테스트/);
const htmlResponse = await request(pdfPath.replace("/pdf/", "/preview-html/"));
assert.equal(htmlResponse.status, 200);
assert.match(htmlResponse.headers.get("content-security-policy"), /sandbox/);
await writeFile(`${dir}/report.html`, await htmlResponse.text());
await post(`/admin/cycles/${cycle}/publish/`);
let sent = false;
for (let i = 0; i < 45; i++) {
  const html = await (await request(reportsPath)).text();
  if (html.includes("Slack 발송 완료")) {
    sent = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
assert.ok(sent, "Mock delivery queue timeout");
await writeFile(
  `${dir}/result.json`,
  JSON.stringify(
    {
      url: base.origin,
      cycle,
      pdfPath,
      pdfBytes: bytes.length,
      checks: [
        "health",
        process.env.PEERFLOW_STAGING_CREDENTIALS ? "admin login" : "setup",
        "admin pages",
        "authentication",
        "CSV",
        "cycle",
        "question",
        "assignment",
        "start/close",
        "test mode PIN login and reviewer submission",
        "Queues",
        "R2 HTML/PDF",
        "remote Browser PDF Korean text",
        "Mock report delivery",
      ],
      limitations: ["No real Slack delivery", "No load or recovery test"],
    },
    null,
    2,
  ),
);
console.log(`PASS remote staging; evidence: ${dir}`);
