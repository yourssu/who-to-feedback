import { afterEach, describe, expect, test } from "bun:test";
import { fixture, answers } from "../helpers";
import {
  addAssignment,
  closeCycle,
  importMembers,
  parseCSV,
  saveDraft,
  startCycle,
  submitReview,
} from "../../src/domain";
import { compileFeedback, generateReport, publish } from "../../src/reports";
import { renderCustom, validateCustomTemplate } from "../../src/templates";
import type { Repository } from "../../src/db";
const repos: Repository[] = [];
const db = () => {
  const r = fixture();
  repos.push(r);
  return r;
};
afterEach(() => {
  repos.splice(0).forEach((r) => r.db.close());
});
describe("회차와 리뷰 무결성", () => {
  test("준비된 회차만 시작하고 PIN과 발송 작업을 생성한다", () => {
    const r = db();
    startCycle(r, 1);
    expect(r.cycle(1).status).toBe("ACTIVE");
    expect(r.all("SELECT * FROM pins")).toHaveLength(3);
    expect(
      new Set(r.all("SELECT code FROM pins").map((p) => p.code)).size,
    ).toBe(3);
    expect(() => startCycle(r, 1)).toThrow();
  });
  test("문항과 선택지가 없으면 회차를 시작하지 않는다", () => {
    const r = db();
    r.run("DELETE FROM options");
    expect(() => startCycle(r, 1)).toThrow();
    expect(r.cycle(1).status).toBe("DRAFT");
  });
  test("제출을 원자적으로 저장하고 중복·임시 저장을 차단한다", () => {
    const r = db();
    startCycle(r, 1);
    saveDraft(r, 1, 1, 1, answers());
    submitReview(r, 1, 1, 1, answers());
    expect(r.all("SELECT * FROM answers")).toHaveLength(4);
    expect(r.all("SELECT * FROM answer_options")).toHaveLength(3);
    expect(r.require("assignments", 1).draft_data).toBeNull();
    expect(() => submitReview(r, 1, 1, 1, answers())).toThrow();
    expect(() => saveDraft(r, 1, 1, 1, answers())).toThrow();
  });
  test("중간 쓰기 실패 시 답변과 제출 상태가 전부 롤백된다", () => {
    const r = db();
    startCycle(r, 1);
    r.db.exec(
      "CREATE TRIGGER fail_answer BEFORE INSERT ON answers WHEN NEW.question_id=2 BEGIN SELECT RAISE(ABORT,'forced'); END",
    );
    expect(() => submitReview(r, 1, 1, 1, answers())).toThrow();
    expect(r.all("SELECT * FROM answers")).toHaveLength(0);
    expect(r.require("assignments", 1).is_submitted).toBe(0);
  });
  test("타인의 매칭과 다른 회차에 쓰지 못한다", () => {
    const r = db();
    startCycle(r, 1);
    expect(() => submitReview(r, 1, 2, 1, answers())).toThrow();
    expect(() => saveDraft(r, 1, 1, 2, answers())).toThrow();
  });
  test.each([
    { q_1_rating: "99" },
    { q_1_rating: true },
    { q_1_rating: ["4"] },
    { q_3_single: true },
    { q_4_multi: [["3"]] },
    { q_2_text: "a".repeat(2001) },
    { q_3_single: "3" },
    { q_4_multi: [] },
    { q_4_multi: ["1"] },
    { unknown: "x" },
  ])("잘못된 답변은 DB 쓰기 전에 거부한다: %j", (invalid) => {
    const r = db();
    startCycle(r, 1);
    expect(() =>
      submitReview(r, 1, 1, 1, { ...answers(), ...invalid }),
    ).toThrow();
    expect(r.all("SELECT * FROM answers")).toHaveLength(0);
  });
  test("부분 임시 저장과 다중 선택 하나를 복원한다", () => {
    const r = db();
    startCycle(r, 1);
    saveDraft(r, 1, 1, 1, { q_2_text: "작성 중", q_4_multi: "3" });
    expect(JSON.parse(r.require("assignments", 1).draft_data).q_4_multi).toBe(
      "3",
    );
  });
  test("잘못된 JSON 타입의 임시 저장은 기존 답변을 덮어쓰지 않는다", () => {
    const r = db();
    startCycle(r, 1);
    saveDraft(r, 1, 1, 1, answers());
    const before = r.require("assignments", 1).draft_data;
    expect(() => saveDraft(r, 1, 1, 1, { q_1_rating: true })).toThrow();
    expect(r.require("assignments", 1).draft_data).toBe(before);
  });
  test("마감 뒤 제출·매칭을 차단한다", () => {
    const r = db();
    startCycle(r, 1);
    r.run(
      "UPDATE cycles SET end_at=? WHERE id=1",
      new Date(Date.now() - 1000).toISOString(),
    );
    expect(() => submitReview(r, 1, 1, 1, answers())).toThrow();
    expect(() => addAssignment(r, 1, 1, 3)).toThrow();
  });
  test("자기 매칭을 차단하고 기존 매칭을 중복 생성하지 않는다", () => {
    const r = db();
    expect(() => addAssignment(r, 1, 1, 1)).toThrow();
    addAssignment(r, 1, 1, 2);
    expect(r.all("SELECT * FROM assignments")).toHaveLength(3);
  });
  test("ACTIVE 매칭 추가 중 PIN 발송 등록이 실패하면 매칭과 PIN을 함께 롤백한다", () => {
    const r = db();
    startCycle(r, 1);
    r.run(
      "INSERT INTO members(name,email,created_at) VALUES ('New','new@example.com',?)",
      new Date().toISOString(),
    );
    r.db.exec(
      "CREATE TRIGGER fail_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'queue unavailable'); END",
    );
    expect(() => addAssignment(r, 1, 4, 2)).toThrow("queue unavailable");
    expect(r.one("SELECT id FROM assignments WHERE reviewer_id=4")).toBeNull();
    expect(r.one("SELECT id FROM pins WHERE member_id=4")).toBeNull();
  });
  test("전원 제출 조건과 관리자 수동 마감을 구분한다", () => {
    const r = db();
    startCycle(r, 1);
    expect(() => closeCycle(r, 1, true)).toThrow();
    closeCycle(r, 1);
    expect(r.cycle(1).status).toBe("COMPLETED");
    expect(r.one("SELECT kind FROM jobs WHERE kind='GENERATE'")).not.toBeNull();
  });
});
describe("집계와 양식", () => {
  test("집계 수치와 익명 DTO를 검증한다", () => {
    const r = db();
    startCycle(r, 1);
    submitReview(r, 1, 1, 1, answers());
    submitReview(r, 3, 3, 1, {
      ...answers(),
      q_1_rating: "5",
      q_2_text: "가장 먼저 정리한 충분히 구체적인 피드백입니다.",
    });
    const data = compileFeedback(r, 1, 2);
    expect(data.q_1_avg_rating).toBe(4.5);
    expect(data.q_3_options_summary[0].percentage).toBe(100);
    expect(data.q_4_options_summary[0].count).toBe(2);
    expect(JSON.stringify(data)).not.toContain("Alice");
    expect(JSON.stringify(data)).not.toContain("Carol");
    expect(JSON.stringify(data)).not.toContain("reviewer_id");
  });
  test("품질 제외와 관리자 복원 상태를 집계에 반영한다", () => {
    const r = db();
    startCycle(r, 1);
    submitReview(r, 1, 1, 1, { ...answers(), q_2_text: "ㅋㅋㅋ" });
    expect(compileFeedback(r, 1, 2).q_2_text_answers).toHaveLength(0);
    r.run("UPDATE answers SET is_excluded_from_report=0");
    expect(compileFeedback(r, 1, 2).q_2_text_answers).toEqual(["ㅋㅋㅋ"]);
  });
  test("생성과 승인을 분리하고 전체 결과지 없이 배포하지 않는다", () => {
    const r = db();
    startCycle(r, 1);
    submitReview(r, 1, 1, 1, answers());
    closeCycle(r, 1);
    generateReport(r, 1, 2);
    expect(
      r.one("SELECT validation_status FROM reports")!.validation_status,
    ).toBe("NEEDS_REVIEW");
    expect(() => publish(r, 1)).toThrow();
    generateReport(r, 1, 1);
    r.run(
      "UPDATE reports SET pdf=?,pdf_status='READY'",
      new TextEncoder().encode("%PDF boundary stub"),
    );
    publish(r, 1);
    expect(
      r.all("SELECT * FROM reports WHERE validation_status='APPROVED'"),
    ).toHaveLength(2);
    expect(r.all("SELECT * FROM jobs WHERE kind='REPORT'")).toHaveLength(2);
  });
  test("결과지에는 서버 경로 없이 폰트와 SVG가 포함된다", () => {
    const r = db();
    startCycle(r, 1);
    submitReview(r, 1, 1, 1, answers());
    generateReport(r, 1, 2);
    const html = r.one("SELECT html FROM reports")!.html;
    expect(html).toContain("data:font/ttf;base64,");
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).not.toContain("file://");
    expect(html).not.toContain("{%");
  });
  test("업로드 양식은 안전한 변수와 반복문만 허용한다", () => {
    expect(
      renderCustom(
        "<h1>{{ reviewee.name }}</h1>{% for q in questions_data %}{{ q.content }}{% endfor %}",
        {
          reviewee: { name: "<script>" },
          questions_data: [{ content: "테스트" }],
        },
      ),
    ).toContain("&lt;script&gt;");
    for (const s of [
      "{{ constructor }}",
      "{{ reviewee.__proto__ }}",
      "{{ range(100) }}",
      "{% include 'base.html' %}",
      "{% if unclosed %}",
    ])
      expect(() => validateCustomTemplate(s)).toThrow();
  });
});
describe("CSV", () => {
  test("한글, BOM, 쉼표, 따옴표, 줄바꿈을 처리한다", () => {
    const r = db();
    const csv =
      '\uFEFFname,email,department\r\n"김,유어",you@example.com,"개발\n팀"\r\n';
    expect(importMembers(r, new TextEncoder().encode(csv))).toEqual({
      created: 1,
      updated: 0,
    });
    expect(
      r.one("SELECT name FROM members WHERE email=?", "you@example.com")!.name,
    ).toBe("김,유어");
    expect(parseCSV('"a""b",c')).toEqual([['a"b', "c"]]);
  });
  test("잘못된 행이 있으면 전체 업로드를 롤백한다", () => {
    const r = db();
    expect(() =>
      importMembers(
        r,
        new TextEncoder().encode(
          "name,email\nNew,new@example.com\nInvalid,invalid\n",
        ),
      ),
    ).toThrow();
    expect(r.members()).toHaveLength(3);
    expect(r.one("SELECT row_index FROM validation_logs")!.row_index).toBe(3);
  });
});
