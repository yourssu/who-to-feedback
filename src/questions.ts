import { z } from "zod";
import { DomainError, type Repository } from "./db";
import { questionSchema } from "./domain";

export function requireDraftCycle(repo: Repository, cycle: number) {
  if (repo.require("cycles", cycle).status !== "DRAFT")
    throw new DomainError(
      "시작한 회차의 문항과 선택지는 수정할 수 없습니다.",
      403,
    );
}

export function addQuestion(
  repo: Repository,
  cycle: number,
  input: unknown,
  image: string | null = null,
) {
  const q = questionSchema.parse(input);
  return repo.transaction(() => {
    requireDraftCycle(repo, cycle);
    const result = repo.run(
      'INSERT INTO questions(cycle_id,"order",question_type,scale_type,category,content,image) VALUES (?,?,?,?,?,?,?)',
      cycle,
      q.order,
      q.question_type,
      q.scale_type,
      q.category,
      q.content,
      image,
    );
    repo.log(cycle, "문항 추가", true);
    return Number(result.lastInsertRowid);
  });
}

export function deleteQuestion(repo: Repository, id: number) {
  return repo.transaction(() => {
    const q = repo.require("questions", id);
    requireDraftCycle(repo, q.cycle_id);
    repo.run("DELETE FROM questions WHERE id=?", id);
    repo.log(q.cycle_id, "문항 삭제", true);
    return q.cycle_id as number;
  });
}

export function addOption(repo: Repository, question: number, input: unknown) {
  const text = z.string().trim().min(1).max(200).parse(input);
  return repo.transaction(() => {
    const q = repo.require("questions", question);
    requireDraftCycle(repo, q.cycle_id);
    if (!q.question_type.includes("CHOICE"))
      throw new DomainError("객관식 문항에만 선택지를 추가할 수 있습니다.");
    const order = repo.one(
      'SELECT COALESCE(max("order"),0)+1 n FROM options WHERE question_id=?',
      question,
    )!.n;
    repo.run(
      'INSERT INTO options(question_id,option_text,"order") VALUES (?,?,?)',
      question,
      text,
      order,
    );
    repo.log(q.cycle_id, "선택지 추가", true);
    return q.cycle_id as number;
  });
}

export function deleteOption(repo: Repository, id: number) {
  return repo.transaction(() => {
    const option = repo.require("options", id);
    const q = repo.require("questions", option.question_id);
    requireDraftCycle(repo, q.cycle_id);
    repo.run("DELETE FROM options WHERE id=?", id);
    repo.log(q.cycle_id, "선택지 삭제", true);
    return q.cycle_id as number;
  });
}
