import { afterEach, expect, spyOn, test } from "bun:test";
import { fixture } from "../helpers";
import type { Repository } from "../../src/db";

const repos: Repository[] = [];
afterEach(() => repos.splice(0).forEach((repo) => repo.db.close()));

test("문항과 매칭 수가 늘어도 조회 SQL 수는 일정하고 연관 데이터와 순서를 유지한다", () => {
  const repo = fixture();
  repos.push(repo);
  const all = spyOn(repo, "all");
  const one = spyOn(repo, "one");
  try {
    const originalQuestions = repo.questions(1);
    expect(originalQuestions[2].options.map((o) => o.id)).toEqual([1, 2]);
    const questionQueries = all.mock.calls.length + one.mock.calls.length;
    all.mockClear();
    one.mockClear();
    const originalAssignments = repo.assignments(1);
    expect(
      originalAssignments.map((a) => [a.reviewer.name, a.reviewee.name]),
    ).toEqual([
      ["Alice", "Bob"],
      ["Bob", "Alice"],
      ["Carol", "Bob"],
    ]);
    const assignmentQueries = all.mock.calls.length + one.mock.calls.length;
    for (let i = 0; i < 100; i++) {
      repo.run(
        "INSERT INTO questions(cycle_id,\"order\",question_type,content) VALUES (1,?,'TEXT','extra')",
        i + 5,
      );
      repo.run(
        "INSERT INTO members(name,email,created_at) VALUES (?,?,?)",
        `Member ${i}`,
        `${i}@example.com`,
        new Date().toISOString(),
      );
      repo.run(
        "INSERT INTO assignments(cycle_id,reviewer_id,reviewee_id) VALUES (1,?,2)",
        i + 4,
      );
    }
    all.mockClear();
    one.mockClear();
    expect(repo.questions(1)).toHaveLength(104);
    expect(all.mock.calls.length + one.mock.calls.length).toBe(questionQueries);
    all.mockClear();
    one.mockClear();
    expect(repo.assignments(1)).toHaveLength(103);
    expect(all.mock.calls.length + one.mock.calls.length).toBe(
      assignmentQueries,
    );
    expect(repo.assignments(1, 1)).toEqual([originalAssignments[0]]);
    expect(repo.assignments(1, 0)).toEqual([]);
    expect(repo.questions(999)).toEqual([]);
    expect(repo.assignments(999)).toEqual([]);
  } finally {
    all.mockRestore();
    one.mockRestore();
  }
});
