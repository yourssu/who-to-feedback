import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const base = new URL(process.env.PEERFLOW_STAGING_URL ?? "");
assert.equal(base.protocol, "https:");
assert.ok(
  base.hostname.startsWith("peerflow-staging.") &&
    base.hostname.endsWith(".workers.dev"),
);
const admin = new Map();
async function request(path, jar = admin, data) {
  const body = data
    ? new URLSearchParams({
        ...data,
        csrfmiddlewaretoken: jar.get("csrftoken") ?? "",
      })
    : undefined;
  const r = await fetch(new URL(path, base), {
    method: body ? "POST" : "GET",
    body,
    redirect: "manual",
    headers: {
      Origin: base.origin,
      Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    },
  });
  for (const item of r.headers.getSetCookie()) {
    const [k, v] = item.split(";")[0].split("=");
    jar.set(k, v);
  }
  return r;
}
const home = await request("/admin");
assert.equal(home.status, 200);
assert.match(await home.text(), /공개 목업 환경/);
for (const path of ["/admin/", "/admin-panel/"]) {
  const r = await request(path);
  assert.equal(r.status, 308);
  assert.equal(r.headers.get("location"), "/admin");
}
const members = await (await request("/admin/members/")).text();
for (const name of ["김유어", "박수", "이온"])
  assert.ok(members.includes(name));
const status = await (await request("/admin/status/")).text();
const cycle = status.match(/\/admin\/cycles\/(\d+)\/status\//)?.[1];
assert.ok(cycle);
const pins = [...status.matchAll(/data-test-pin>(\d{6})</g)].map((m) => m[1]);
assert.equal(pins.length, 3);
const reviewer = new Map();
await request("/login/", reviewer);
assert.equal(
  (await request("/login/", reviewer, { code: pins[0] })).status,
  302,
);
const dashboard = await (await request("/", reviewer)).text();
const reviewPath = dashboard.match(/\/review\/\d+\//)?.[0];
assert.ok(reviewPath);
const form = await (await request(reviewPath, reviewer)).text();
const fields = {};
for (const m of form.matchAll(
  /<input[^>]*name="(q_\d+_(?:rating|single|multi))"[^>]*value="([^"]+)"/g,
))
  fields[m[1]] ??= m[2];
const textName = form.match(/name="(q_\d+_text)"/)?.[1];
assert.ok(textName);
fields[textName] =
  "원격 목업 테스트: 구체적인 설명과 피드백으로 협업에 도움을 주셨습니다.";
assert.equal(Object.keys(fields).length, 4);
assert.equal((await request(reviewPath, reviewer, fields)).status, 302);
const after = await (await request(`/admin/cycles/${cycle}/status/`)).text();
assert.match(after, /5 \/ 6/);
let pdfPath;
for (let i = 0; i < 90; i++) {
  const html = await (await request(`/admin/cycles/${cycle}/reports/`)).text();
  assert.ok(
    html.includes("항상 꼼꼼한 리뷰"),
    "Seeded review text should appear in report preview",
  );
  pdfPath = html.match(/\/admin\/reports\/\d+\/pdf\//)?.[0];
  if (pdfPath) break;
  await new Promise((r) => setTimeout(r, 2000));
}
assert.ok(pdfPath, "Seeded sample PDF not ready");
const pdf = await request(pdfPath);
assert.equal(pdf.status, 200);
const bytes = Buffer.from(await pdf.arrayBuffer());
assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
const dir = `artifacts/demo-remote-${Date.now()}`;
await mkdir(dir, { recursive: true });
await writeFile(`${dir}/report.pdf`, bytes);
await writeFile(
  `${dir}/result.json`,
  JSON.stringify(
    {
      url: base.origin,
      cycle,
      checks: [
        "anonymous admin",
        "canonical redirects",
        "3 mock members",
        "3 reviewer PINs",
        "all 4 question types",
        "review submission 5/6",
        "seeded review preview",
        "sample PDF",
      ],
      pdfBytes: bytes.length,
    },
    null,
    2,
  ),
);
console.log(`PASS anonymous demo flow: ${dir}`);
