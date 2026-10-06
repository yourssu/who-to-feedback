import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manage } from "../../scripts/manage";
import { afterEach, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { Client, fixture, answers } from "../helpers";
import {
  now,
  startCycle,
  submitReview,
  saveDraft,
  qualityReason,
  importMembers,
} from "../../src/domain";
import { compileFeedback, generateAll, checkLayouts } from "../../src/reports";
import type { Repository } from "../../src/db";
const repos: Repository[] = [];
const setup = () => {
  const repo = fixture();
  repos.push(repo);
  return { repo, client: new Client(createApp(repo)) };
};
afterEach(() => repos.splice(0).forEach((r) => r.db.close()));

test("회차 날짜 오류를 거부하고 한국 시간 입력을 UTC로 저장한다", async () => {
  const { repo, client } = setup();
  await client.admin();
  await client.request("/admin-panel/cycles/create/", "POST", {
    title: "역전",
    start_at: "2026-12-02T10:00",
    end_at: "2026-12-01T10:00",
  });
  expect(repo.all("SELECT * FROM cycles")).toHaveLength(1);
  await client.request("/admin-panel/cycles/create/", "POST", {
    title: "정상",
    start_at: "2026-12-01T10:00",
    end_at: "2026-12-02T10:00",
  });
  expect(
    repo.one("SELECT start_at FROM cycles WHERE title=?", "정상")!.start_at,
  ).toBe("2026-12-01T01:00:00.000Z");
});

test("부서별 자동 매칭은 같은 부서만 연결하고 ACTIVE 신규 리뷰어에게 PIN을 만든다", async () => {
  const { repo, client } = setup();
  await client.admin();
  repo.run("DELETE FROM assignments");
  repo.run("UPDATE members SET department='Other' WHERE id=3");
  await client.request(
    "/admin-panel/cycles/1/assignments/auto-match/",
    "POST",
    { match_type: "SAME_DEPT" },
  );
  expect(
    repo.assignments(1).map((a) => [a.reviewer_id, a.reviewee_id]),
  ).toEqual([
    [1, 2],
    [2, 1],
  ]);
  expect(repo.all("SELECT * FROM pins")).toHaveLength(0);
  startCycle(repo, 1);
  repo.run(
    "INSERT INTO members(name,email,department,created_at) VALUES (?,?,?,?)",
    "New",
    "new@example.com",
    "Engineering",
    now(),
  );
  await client.request("/admin-panel/cycles/1/assignments/add/", "POST", {
    reviewer_id: 4,
    reviewee_id: 1,
  });
  expect(repo.one("SELECT * FROM pins WHERE member_id=4")).not.toBeNull();
});

test("로그아웃·재로그인 후 임시 답변을 복원하고 GET code로 로그인하지 않는다", async () => {
  const { repo, client } = setup();
  await client.login(repo);
  saveDraft(repo, 1, 1, 1, { q_2_text: "로그아웃 전 임시 답변" });
  await client.request("/logout/");
  expect((await client.request("/")).status).toBe(302);
  expect(
    (
      await client.request(
        "/login/?code=" +
          repo.one("SELECT code FROM pins WHERE member_id=1")!.code,
      )
    ).status,
  ).toBe(200);
  expect((await client.request("/")).status).toBe(302);
  await client.login(repo);
  expect(await (await client.request("/review/1/")).text()).toContain(
    "로그아웃 전 임시 답변",
  );
});

test("문항과 선택지는 ACTIVE 이후 잠기고 비객관식 선택지는 거부한다", async () => {
  const { repo, client } = setup();
  await client.admin();
  await client.request("/admin-panel/questions/1/options/add/", "POST", {
    option_text: "부적절",
  });
  expect(repo.all("SELECT * FROM options WHERE question_id=1")).toHaveLength(0);
  const option = repo.one("SELECT id FROM options WHERE question_id=3")!;
  await client.request(`/admin-panel/options/${option.id}/delete/`, "POST", {});
  expect(repo.one("SELECT id FROM options WHERE id=?", option.id)).toBeNull();
  startCycle(repo, 1);
  expect(
    (await client.request("/admin-panel/questions/1/delete/", "POST", {}))
      .status,
  ).toBe(403);
  expect(repo.require("questions", 1).id).toBe(1);
});

test("빈 이력·다중 이력과 보고서 운영 메모를 표시한다", async () => {
  const { repo, client } = setup();
  await client.admin();
  expect(
    await (await client.request("/admin-panel/cycles/1/history/")).text(),
  ).toContain("기록된 변경 이력이 없습니다.");
  repo.log(1, "첫 변경");
  repo.log(1, "두 번째 변경");
  const page = await (
    await client.request("/admin-panel/cycles/1/history/")
  ).text();
  expect(page).toContain("첫 변경");
  expect(page).toContain("두 번째 변경");
  generateAll(repo, 1);
  const report = repo.one("SELECT id FROM reports LIMIT 1")!;
  await client.request(`/admin-panel/reports/${report.id}/memo/`, "POST", {
    admin_memo: "확인 완료",
  });
  expect(repo.require("reports", report.id).admin_memo).toBe("확인 완료");
});

test("다른 회차 매칭을 숨기고 품질·정렬·샘플·레이아웃 규칙을 보존한다", async () => {
  const { repo, client } = setup();
  await client.login(repo);
  repo.run(
    "INSERT INTO cycles(title,created_at) VALUES (?,?)",
    "다른 회차",
    now(),
  );
  repo.run(
    "INSERT INTO assignments(cycle_id,reviewer_id,reviewee_id) VALUES (2,1,3)",
  );
  expect((await client.request("/review/4/")).status).toBe(403);
  submitReview(repo, 1, 1, 1, {
    ...answers(),
    q_2_text: "나의 구체적인 협업 경험입니다. ".repeat(20),
  });
  submitReview(repo, 3, 3, 1, {
    ...answers(),
    q_2_text: "가장 먼저 정렬되는 구체적인 피드백입니다.",
  });
  expect(compileFeedback(repo, 1, 2).q_2_text_answers[0]).toStartWith("가장");
  generateAll(repo, 1, true);
  expect(repo.all("SELECT * FROM reports WHERE cycle_id=1")).toHaveLength(2);
  expect(checkLayouts(repo, 1)).toBe(1);
  for (const bad of ["ㅋㅋㅋ", "가가가가", "asdf", "1234", "없습니다"])
    expect(qualityReason(bad)).not.toBe("");
  expect(
    qualityReason("구체적인 행동과 협업을 설명하는 충분한 피드백입니다."),
  ).toBe("");
});

test("문항 변경은 버전과 이력을 갱신하고 이름 정규화는 원본을 보존한다", async () => {
  const { repo, client } = setup();
  await client.admin();
  await client.request("/admin-panel/cycles/1/questions/add/", "POST", {
    order: 5,
    question_type: "TEXT",
    content: "추가 질문",
  });
  expect(repo.cycle(1).version).toBe("v2");
  expect(repo.all("SELECT * FROM version_logs")).toHaveLength(1);
  await client.request("/admin-panel/validation/normalize/", "POST", {
    raw_names: ["Alice"],
    target_name: "ALICE",
  });
  expect(repo.require("members", 1).name).toBe("Alice");
  expect(repo.require("members", 1).normalized_name).toBe("ALICE");
});

test("TS 운영 명령은 미승인 결과지를 발송하지 않는다", () => {
  const { repo } = setup();
  startCycle(repo, 1);
  generateAll(repo, 1);
  expect(() => manage(repo, "publish_reports", 1)).toThrow("승인");
  expect(repo.all("SELECT * FROM jobs WHERE kind='REPORT'")).toHaveLength(0);
  manage(repo, "send_reminders", 1);
  const reminders = repo.all(
    "SELECT payload FROM jobs WHERE payload LIKE '%REMINDER%'",
  );
  expect(reminders).toHaveLength(3);
  manage(repo, "send_reminders", 1);
  expect(
    repo.all("SELECT payload FROM jobs WHERE payload LIKE '%REMINDER%'"),
  ).toHaveLength(3);
});

test("한글 EUC-KR CSV와 이메일 없는 팀원을 안전하게 가져온다", () => {
  const { repo } = setup();
  const name = new Uint8Array([0xc8, 0xab, 0xb1, 0xe6, 0xb5, 0xbf]);
  const bytes = Buffer.concat([
    Buffer.from("name,email\n"),
    Buffer.from(name),
    Buffer.from(",hong@example.com\n"),
  ]);
  importMembers(repo, bytes);
  expect(
    repo.one("SELECT name FROM members WHERE email=?", "hong@example.com")!
      .name,
  ).toBe("홍길동");
  importMembers(
    repo,
    new TextEncoder().encode("이름,팀\n이유어,개발\n정유어,디자인\n"),
  );
  const rows = repo.all(
    "SELECT email FROM members WHERE email LIKE '%@members.invalid'",
  );
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((r) => r.email)).size).toBe(2);
});

test("이미지 업로드·인증된 조회·보고서 data URL 주입을 연결한다", async () => {
  const { repo, client } = setup();
  await client.admin();
  const root = mkdtempSync(join(tmpdir(), "peerflow-images-"));
  const previous = process.env.PEERFLOW_MEDIA;
  process.env.PEERFLOW_MEDIA = root;
  try {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcN8AAAAASUVORK5CYII=",
      "base64",
    );
    const form = new FormData();
    form.set("order", "5");
    form.set("question_type", "TEXT");
    form.set("content", "이미지 질문");
    form.set("image", new File([bytes], "question.png", { type: "image/png" }));
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
    expect(response.status).toBe(302);
    const question = repo.one('SELECT * FROM questions WHERE "order"=5')!,
      path = "/media/" + question.image;
    const anonymous = new Client(client.app);
    expect((await anonymous.request(path)).status).toBe(302);
    expect(
      Buffer.from(await (await client.request(path)).arrayBuffer()),
    ).toEqual(bytes);
    expect(compileFeedback(repo, 1, 1).q_5_image_url).toStartWith(
      "data:image/png;base64,",
    );
    expect((await client.request("/health/")).status).toBe(200);
  } finally {
    if (previous === undefined) delete process.env.PEERFLOW_MEDIA;
    else process.env.PEERFLOW_MEDIA = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
