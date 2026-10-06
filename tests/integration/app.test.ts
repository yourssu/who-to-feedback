import { afterEach, expect, test } from "bun:test";
import { Client, fixture, answers } from "../helpers";
import { createApp } from "../../src/app";
import type { Repository } from "../../src/db";
const repos: Repository[] = [];
const setup = () => {
  const repo = fixture();
  repos.push(repo);
  return { repo, client: new Client(createApp(repo)) };
};
afterEach(() => repos.splice(0).forEach((r) => r.db.close()));
test("관리자 초기 설정은 한 번만 가능하고 로그인 시 세션을 교체한다", async () => {
  const { repo, client } = setup();
  await client.request("/setup/");
  const old = client.cookies.get("peerflow_session");
  expect((await client.admin()).status).toBe(302);
  expect(client.cookies.get("peerflow_session")).not.toBe(old);
  expect((await client.request("/setup/")).status).toBe(404);
  expect((await client.request("/admin-panel/")).status).toBe(200);
  expect(
    repo.one("SELECT password_hash FROM admins")!.password_hash,
  ).toStartWith("$argon2id$");
});
test("PIN 재로그인, 관리자 차단, 회차별 리뷰 접근을 검증한다", async () => {
  const { repo, client } = setup();
  expect((await client.login(repo)).status).toBe(302);
  expect((await client.request("/")).status).toBe(200);
  expect((await client.request("/review/2/")).status).toBe(403);
  expect((await client.request("/admin-panel/")).status).toBe(302);
  await client.request("/logout/");
  expect((await client.login(repo)).status).toBe(302);
});
test("쿠키를 바꿔도 인증 실패 제한을 유지한다", async () => {
  const { repo, client } = setup();
  await client.request("/login/");
  for (let i = 0; i < 5; i++)
    await client.request("/login/", "POST", { code: "000000" });
  const other = new Client(client.app);
  const response = await other.request("/login/");
  expect(await response.text()).toContain("로그인 시도가 잠시 잠겼어요");
  expect(
    repo.one("SELECT locked_until FROM login_attempts")!.locked_until,
  ).toBeGreaterThan(Date.now());
});
test("CSRF와 타 사이트 Origin을 차단한다", async () => {
  const { client } = setup();
  await client.request("/setup/");
  expect(
    (await client.request("/setup/", "POST", {}, { "X-CSRFToken": "bad" }))
      .status,
  ).toBe(403);
  expect(
    (
      await client.request(
        "/setup/",
        "POST",
        {},
        { Origin: "https://evil.example" },
      )
    ).status,
  ).toBe(403);
});
test("임시 저장, 제출, 마감 후 쓰기를 HTTP에서 검증한다", async () => {
  const { repo, client } = setup();
  await client.login(repo);
  expect(
    (await client.request("/review/1/save-draft/", "POST", answers())).status,
  ).toBe(200);
  expect((await client.request("/review/1/", "POST", answers())).status).toBe(
    302,
  );
  expect(
    (await client.request("/review/1/save-draft/", "POST", answers())).status,
  ).toBe(403);
  const page = await client.request("/review/1/");
  expect(await page.text()).toContain("제출한 리뷰가 잠겼어요");
});
test("모든 관리자 화면과 빈 상태를 렌더링한다", async () => {
  const { client } = setup();
  await client.admin();
  for (const path of [
    "/admin-panel/",
    "/admin-panel/members/",
    "/admin-panel/validation/",
    "/admin-panel/cycles/1/validation/",
    "/admin-panel/cycles/1/questions/",
    "/admin-panel/cycles/1/assignments/",
    "/admin-panel/status/",
    "/admin-panel/cycles/1/status/",
    "/admin-panel/cycles/1/reports/",
    "/admin-panel/cycles/1/checklist/",
    "/admin-panel/cycles/1/history/",
    "/admin-panel/messages/send/",
  ]) {
    const response = await client.request(path);
    expect(response.status, path).toBe(200);
    const html = await response.text();
    expect(html, path).not.toContain("{%");
    expect(html, path).not.toContain("undefined");
  }
});
test("이미지와 결과지는 비로그인 상태에서 노출하지 않는다", async () => {
  const { client } = setup();
  expect(
    (await client.request("/media/reports_html/private.html")).status,
  ).toBe(302);
  expect(
    (await client.request("/admin-panel/reports/1/preview-html/")).status,
  ).toBe(302);
  expect((await client.request("/static/css/style.css")).status).toBe(200);
});
test("빈 배열은 정상 로그인과 빈 화면으로 표시된다", async () => {
  const { repo, client } = setup();
  const login = await client.request("/login/");
  expect(await login.text()).toContain("안전한 리뷰 공간");
  await client.admin();
  const messages = await client.request("/admin-panel/messages/send/");
  expect(await messages.text()).not.toContain("실패한 DM 0건");
  const validation = await client.request("/admin-panel/validation/");
  expect(await validation.text()).toContain("필수값 오류가 발견되지 않았어요.");
  repo.run("DELETE FROM cycles");
  const overview = await client.request("/admin-panel/");
  expect(await overview.text()).toContain("첫 피어리뷰를 시작해 보세요");
});
test("동시에 온 제출과 임시 저장은 제출 결과를 덮어쓰지 않는다", async () => {
  const { repo, client } = setup();
  await client.login(repo);
  const responses = await Promise.all([
    client.request("/review/1/", "POST", answers()),
    client.request("/review/1/save-draft/", "POST", answers()),
  ]);
  expect(responses[0].status).toBe(302);
  expect(repo.require("assignments", 1).is_submitted).toBe(1);
  expect(repo.all("SELECT * FROM answers")).toHaveLength(4);
  expect(repo.require("assignments", 1).draft_data).toBeNull();
});
