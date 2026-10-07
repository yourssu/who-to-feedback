import { afterEach, expect, test } from "bun:test";
import { fixture } from "../helpers";
import type { Repository } from "../../src/db";
import {
  addQuestion,
  addOption,
  deleteQuestion,
  deleteOption,
} from "../../src/questions";
import { startCycle } from "../../src/domain";

const repos: Repository[] = [];
function setup() {
  const repo = fixture();
  repos.push(repo);
  return repo;
}
afterEach(() => repos.splice(0).forEach((repo) => repo.db.close()));
const question = { order: 5, question_type: "TEXT", content: "추가 문항" };

test("문항과 선택지 변경은 각각 버전과 이력을 함께 저장한다", () => {
  const repo = setup();
  const id = addQuestion(repo, 1, question);
  expect(repo.require("questions", id).content).toBe(question.content);
  expect(addOption(repo, 3, "추가 선택지")).toBe(1);
  expect(deleteOption(repo, 1)).toBe(1);
  expect(deleteQuestion(repo, id)).toBe(1);
  expect(repo.require("cycles", 1).version).toBe("v5");
  expect(repo.all("SELECT version FROM version_logs ORDER BY id")).toEqual(
    ["v2", "v3", "v4", "v5"].map((version) => ({ version })),
  );
});

test.each(["add question", "delete question", "add option", "delete option"])(
  "이력 저장 실패 시 문항·선택지·버전 전체를 롤백한다: %s",
  (operation) => {
    const repo = setup();
    const before = repo.questions(1);
    repo.db.exec(
      "CREATE TRIGGER fail_log BEFORE INSERT ON version_logs BEGIN SELECT RAISE(ABORT,'history unavailable'); END",
    );
    const mutate = () => {
      if (operation === "add question") addQuestion(repo, 1, question);
      if (operation === "delete question") deleteQuestion(repo, 3);
      if (operation === "add option") addOption(repo, 3, "추가 선택지");
      if (operation === "delete option") deleteOption(repo, 1);
    };
    expect(mutate).toThrow("history unavailable");
    expect(repo.questions(1)).toEqual(before);
    expect(repo.require("cycles", 1).version).toBe("v1");
    expect(repo.all("SELECT * FROM version_logs")).toHaveLength(0);
  },
);

test("시작한 회차는 HTTP를 통하지 않는 문항·선택지 변경도 거부한다", () => {
  const repo = setup();
  startCycle(repo, 1);
  const before = repo.questions(1);
  expect(() => addQuestion(repo, 1, question)).toThrow("수정할 수 없습니다");
  expect(() => deleteQuestion(repo, 3)).toThrow("수정할 수 없습니다");
  expect(() => addOption(repo, 3, "추가 선택지")).toThrow("수정할 수 없습니다");
  expect(() => deleteOption(repo, 1)).toThrow("수정할 수 없습니다");
  expect(repo.questions(1)).toEqual(before);
});
