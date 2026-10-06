import { expect, test } from "bun:test";
import { fixture, Client } from "../helpers";
import { createApp } from "../../src/app";
import { compileFeedback } from "../../src/reports";

test("매칭 목록 조회는 인원이 늘어도 쿼리 두 번이며 최신 팀원 정보를 반환한다", () => {
  const r = fixture();
  try {
    r.transaction(() => {
      for (let i = 0; i < 100; i++) {
        const id = r.run(
          "INSERT INTO members(name,email,created_at) VALUES (?,?,?)",
          `Member ${i}`,
          `member${i}@example.com`,
          "2026-10-01",
        ).lastInsertRowid;
        r.run(
          "INSERT INTO assignments(cycle_id,reviewer_id,reviewee_id) VALUES (1,1,?)",
          id,
        );
      }
    });
    let queries = 0;
    const all = r.all.bind(r),
      one = r.one.bind(r);
    r.all = ((...args: Parameters<typeof r.all>) => {
      queries++;
      return all(...args);
    }) as typeof r.all;
    r.one = ((...args: Parameters<typeof r.one>) => {
      queries++;
      return one(...args);
    }) as typeof r.one;
    const assignments = r.assignments(1, 1);
    expect(assignments).toHaveLength(101);
    expect(queries).toBe(2);
    r.run("UPDATE members SET name='Updated' WHERE id=1");
    expect(r.assignments(1, 1)[0].reviewer.name).toBe("Updated");
  } finally {
    r.db.close();
  }
});

test("보고서 집계 쿼리는 문항 수에 비례하지 않으며 선택지의 회차·순서를 보존한다", () => {
  const r = fixture();
  try {
    r.run("INSERT INTO cycles(title,created_at) VALUES ('other','2026-10-01')");
    const other = r.run(
      "INSERT INTO questions(cycle_id,\"order\",question_type,content) VALUES (2,1,'SINGLE_CHOICE','other')",
    ).lastInsertRowid;
    r.run(
      "INSERT INTO options(question_id,\"order\",option_text) VALUES (?,1,'외부 선택지')",
      other,
    );
    for (let i = 5; i <= 100; i++)
      r.run(
        "INSERT INTO questions(cycle_id,\"order\",question_type,content) VALUES (1,?,'TEXT','추가 문항')",
        i,
      );
    let queries = 0;
    const all = r.all.bind(r),
      one = r.one.bind(r);
    r.all = ((...args: Parameters<typeof r.all>) => {
      queries++;
      return all(...args);
    }) as typeof r.all;
    r.one = ((...args: Parameters<typeof r.one>) => {
      queries++;
      return one(...args);
    }) as typeof r.one;
    const feedback = compileFeedback(r, 1, 2);
    expect(feedback.questions_data).toHaveLength(100);
    expect(queries).toBeLessThanOrEqual(7);
    expect(
      feedback.questions_data[2].options_summary.map(
        (o: { text: string }) => o.text,
      ),
    ).toEqual(["소통", "책임감"]);
    expect(feedback.font_path).toStartWith("data:font/woff2;base64,");
    r.run("UPDATE cycles SET use_custom_template=1 WHERE id=1");
    expect(compileFeedback(r, 1, 2).font_path).toStartWith(
      "data:font/ttf;base64,",
    );
  } finally {
    r.db.close();
  }
});

test("정적 폰트의 조건부 요청은 본문 없는 304이고 인증 화면에는 적용되지 않는다", async () => {
  const r = fixture();
  try {
    const client = new Client(createApp(r));
    const font = await client.request("/static/fonts/Pretendard-Regular.woff2");
    expect(font.status).toBe(200);
    const bytes = new Uint8Array(await font.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("wOF2");
    expect(bytes.length).toBeLessThan(4_000_000);
    const cached = await client.request(
      "/static/fonts/Pretendard-Regular.woff2",
      "GET",
      undefined,
      { "If-None-Match": font.headers.get("etag")! },
    );
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    const login = await client.request("/login/");
    expect(login.headers.get("Cache-Control")).toBe("no-store");
  } finally {
    r.db.close();
  }
});
