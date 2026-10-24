import { pbkdf2Sync } from "node:crypto";
import { test, expect } from "bun:test";
import nunjucks from "nunjucks";
import {
  renderCustom,
  validateCustomTemplate,
} from "../../src/custom-template";
import { passwordHash, passwordVerify } from "../../src/workers/password";
import { deliver, SlackError } from "../../src/workers/slack";
import { fixture } from "../helpers";
import { hashReport } from "../../src/reports";

test("restricted template interpreter matches escaped Nunjucks nested loops and conditions", () => {
  const source =
    "<h1>{{ title }}</h1>{% for q in questions %}{% if not q.hidden %}{{ loop.index }}:{{ q.text }}{% else %}hidden{% endif %}{% else %}empty{% endfor %}";
  for (const context of [
    {
      title: "<script>&",
      questions: [
        { hidden: false, text: "<한글>" },
        { hidden: true, text: "secret" },
      ],
    },
    { title: "empty", questions: [] },
  ]) {
    expect(renderCustom(source, context)).toBe(
      new nunjucks.Environment(null, { autoescape: true }).renderString(
        source,
        context,
      ),
    );
  }
  for (const source of [
    "{{ a.constructor }}",
    "{% include a %}",
    "{% if a %}x{% endfor %}",
    "{{ a",
    "{% else %}",
  ])
    expect(() => validateCustomTemplate(source)).toThrow();
  expect(
    renderCustom("{{ a.secret }}", { a: Object.create({ secret: "hidden" }) }),
  ).toBe("");
  expect(() =>
    renderCustom(
      "{% for a in rows %}{% for b in rows %}x{% endfor %}{% endfor %}",
      { rows: Array(400).fill(1) },
    ),
  ).toThrow();
});

test("Workers password hashes are salted and reject wrong passwords and unsupported costs", async () => {
  const one = await passwordHash("strong password"),
    two = await passwordHash("strong password");
  expect(one).not.toBe(two);
  const [, cost, salt, digest] = one.split("$");
  expect(
    pbkdf2Sync(
      "strong password",
      Buffer.from(salt!, "hex"),
      Number(cost),
      32,
      "sha256",
    ).toString("hex"),
  ).toBe(digest);
  expect(await passwordVerify("strong password", one)).toBe(true);
  expect(await passwordVerify("wrong", one)).toBe(false);
  expect(
    await passwordVerify("strong password", one.replace("600000", "1")),
  ).toBe(false);
});

test("R2 HTML reference preserves content hash for approval and PDF jobs", () => {
  const digest = hashReport("<html>한글</html>");
  expect(hashReport(`r2:reports/${digest}.html`)).toBe(digest);
});

test("Slack HTTP adapter uploads both attachments and treats partial upload failures as unknown", async () => {
  const repo = fixture();
  repo.run(
    "INSERT INTO reports(cycle_id,reviewee_id,html,pdf,pdf_status,validation_status,approved_hash,created_at) VALUES (1,2,'html',?,'READY','APPROVED','hash','now')",
    new Uint8Array([1]),
  );
  repo.platform = {
    artifact: async () =>
      new Response("file", { headers: { "Content-Length": "4" } }),
  } as any;
  const original = globalThis.fetch;
  const calls: string[] = [];
  let uploadCount = 0,
    failSecond = false;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/api/conversations.open"))
      return Response.json({ ok: true, channel: { id: "D1" } });
    if (url.includes("/api/files.getUploadURLExternal"))
      return Response.json({
        ok: true,
        file_id: `F${++uploadCount}`,
        upload_url: `https://files.slack.com/upload/${uploadCount}`,
      });
    if (url.includes("/upload/")) {
      if (failSecond && uploadCount === 2)
        return new Response("failed", { status: 503 });
      return new Response("ok");
    }
    if (url.includes("files.completeUploadExternal")) {
      expect(JSON.parse(init.body).files).toHaveLength(2);
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  try {
    const payload = {
      type: "REPORT" as const,
      member_id: 2,
      cycle_id: 1,
      report_id: 1,
      revision: 1,
      html_hash: "hash",
    };
    await deliver(repo, payload, {
      MOCK_SLACK_MODE: "false",
      SLACK_BOT_TOKEN: "test-only",
    });
    expect(calls.filter((x) => x.includes("/upload/"))).toHaveLength(2);
    uploadCount = 0;
    failSecond = true;
    try {
      await deliver(repo, payload, {
        MOCK_SLACK_MODE: "false",
        SLACK_BOT_TOKEN: "test-only",
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(SlackError);
      expect((error as SlackError).known).toBe(false);
    }
  } finally {
    globalThis.fetch = original;
    repo.db.close();
  }
});
