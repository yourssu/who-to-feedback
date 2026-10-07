import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, fixture, answers } from "../helpers";
import { createApp } from "../../src/app";
import type { Repository } from "../../src/db";
import { invalidateReports } from "../../src/reports";

const repos: Repository[] = [];
function setup() {
  const repo = fixture();
  repos.push(repo);
  return { repo, client: new Client(createApp(repo)) };
}
afterEach(() => repos.splice(0).forEach((repo) => repo.db.close()));

test("문항 저장 실패 시 업로드 파일을 정리하고 DB 변경을 롤백한다", async () => {
  const { repo, client } = setup();
  await client.admin();
  const root = mkdtempSync(join(tmpdir(), "peerflow-upload-rollback-"));
  const previous = process.env.PEERFLOW_MEDIA;
  process.env.PEERFLOW_MEDIA = root;
  try {
    repo.db.exec(
      "CREATE TRIGGER fail_history BEFORE INSERT ON version_logs BEGIN SELECT RAISE(ABORT,'history unavailable'); END",
    );
    const form = new FormData();
    form.set("order", "5");
    form.set("question_type", "TEXT");
    form.set("content", "업로드 실패 검증");
    form.set(
      "image",
      new File(
        [
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcN8AAAAASUVORK5CYII=",
            "base64",
          ),
        ],
        "question.png",
        { type: "image/png" },
      ),
    );
    form.set("csrfmiddlewaretoken", client.cookies.get("csrftoken")!);
    const response = await client.app.request(
      "http://localhost/admin-panel/cycles/1/questions/add/",
      {
        method: "POST",
        body: form,
        headers: {
          Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
      },
    );
    expect(response.status).toBe(500);
    expect(repo.questions(1)).toHaveLength(4);
    expect(repo.require("cycles", 1).version).toBe("v1");
    expect(readdirSync(join(root, "question_images"))).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.PEERFLOW_MEDIA;
    else process.env.PEERFLOW_MEDIA = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("종료된 회차와 발송 대기 회차는 보고서 무효화를 거부하고 생성물을 보존한다", () => {
  const { repo } = setup();
  repo.run(
    "INSERT INTO reports(cycle_id,reviewee_id,html,created_at) VALUES (1,2,'preserved',?)",
    new Date().toISOString(),
  );
  repo.run("UPDATE cycles SET status='CLOSED' WHERE id=1");
  expect(() => invalidateReports(repo, 1)).toThrow("종료");
  expect(repo.one("SELECT html FROM reports")!.html).toBe("preserved");
  repo.run("UPDATE cycles SET status='COMPLETED' WHERE id=1");
  repo.run(
    "INSERT INTO jobs(kind,payload,dedupe_key,created_at) VALUES ('REPORT',?, 'pending-report',?)",
    JSON.stringify({ cycle_id: 1 }),
    new Date().toISOString(),
  );
  expect(() => invalidateReports(repo, 1)).toThrow("발송 중");
  expect(repo.one("SELECT html FROM reports")!.html).toBe("preserved");
  repo.run("UPDATE jobs SET status='FAILED'");
  invalidateReports(repo, 1);
  expect(repo.one("SELECT html FROM reports")!.html).toBeNull();
});

test("실제 HTTP 서버에서 잘못된 JSON 저장을 거부하고 정상 저장·제출을 유지한다", async () => {
  const { repo, client } = setup();
  await client.login(repo);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: client.app.fetch,
  });
  const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const send = (path: string, data: unknown) =>
    fetch(new URL(path, server.url), {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRFToken": client.cookies.get("csrftoken")!,
      },
      body: JSON.stringify(data),
    });
  try {
    const invalid = await send("/review/1/save-draft/", { q_1_rating: true });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { status: string }).status).toBe("error");
    expect(repo.require("assignments", 1).draft_data).toBeNull();
    expect((await send("/review/1/save-draft/", answers())).status).toBe(200);
    expect((await send("/review/1/", answers())).status).toBe(302);
    expect(repo.require("assignments", 1).is_submitted).toBe(1);
    expect(repo.all("SELECT * FROM answers")).toHaveLength(4);
    expect((await send("/review/1/save-draft/", answers())).status).toBe(403);
  } finally {
    await server.stop(true);
  }
});
