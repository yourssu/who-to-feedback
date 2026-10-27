import { test, expect } from "bun:test";
import { createApp } from "../../src/app";
import { fixture, Client } from "../helpers";
import { defaultPlatform } from "../../src/legacy/platform";
import { startCycle } from "../../src/domain";
import { deliver } from "../../src/workers/slack";

test("test admin access, legacy redirects, and disabling test privileges", async () => {
  const repo = fixture();
  repo.platform = { ...defaultPlatform, testMode: true };
  startCycle(repo, 1);
  const client = new Client(createApp(repo));
  expect((await client.request("/admin")).status).toBe(200);
  expect((await client.request("/admin/cycles/1/status/")).status).toBe(200);
  for (const path of ["/admin/", "/admin-panel", "/admin-panel/"]) {
    const response = await client.request(path);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/admin");
  }
  const old = await client.request(
    "/admin-panel/cycles/1/start/?a=1",
    "POST",
    {},
  );
  expect(old.status).toBe(308);
  expect(old.headers.get("location")).toBe("/admin/cycles/1/start/?a=1");

  expect((await client.request("/admin")).status).toBe(200);
  const enabled = await (
    await client.request("/admin/cycles/1/status/")
  ).text();
  expect(enabled).toContain("data-test-pin");
  expect(enabled).toContain("테스트 모드");
  repo.platform.testMode = false;
  expect((await client.request("/admin/cycles/1/status/")).status).toBe(302);
  expect((await client.request("/admin")).status).toBe(302);
  const anonymous = new Client(createApp(repo));
  expect((await anonymous.request("/admin")).status).toBe(302);
});

test("explicit TEST_MODE suppresses real Slack even if MOCK_SLACK_MODE is false", async () => {
  const repo = fixture();
  // No token: ordinary mode would throw; test mode must never contact Slack.
  await deliver(
    repo,
    { member_id: 1, type: "TEST_DM", text: "test" },
    { TEST_MODE: "true", MOCK_SLACK_MODE: "false" },
  );
});

test("test admin writes still require CSRF", async () => {
  const repo = fixture();
  repo.platform = { ...defaultPlatform, testMode: true };
  const app = createApp(repo);
  expect(
    (
      await app.request("http://localhost/admin/cycles/create/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "bad" }),
      })
    ).status,
  ).toBe(403);
});
