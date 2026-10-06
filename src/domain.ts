import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import type { JobKind, JobPayloads } from "./models";
import { DomainError, type Repository, type Row } from "./db";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const now = () => new Date().toISOString();
export const textLabels = [
  "매우 아님",
  "약간 아님",
  "보통임",
  "약간 그럼",
  "매우 그럼",
];
export const memberSchema = z.object({
  name: z.string().trim().min(1).max(50),
  email: z.email(),
  slack_user_id: z.string().trim().max(50).default(""),
  department: z.string().trim().max(100).default(""),
});
export const questionSchema = z.object({
  order: z.coerce.number().int().min(1).max(1000),
  question_type: z.enum(["RATING", "TEXT", "SINGLE_CHOICE", "MULTIPLE_CHOICE"]),
  scale_type: z.enum(["NUMERIC_5", "TEXT_5"]).default("NUMERIC_5"),
  category: z.string().trim().max(100).default("기본 역량"),
  content: z.string().trim().min(1).max(5000),
});
export function editable(repo: Repository, assignment: Row) {
  const cycle = repo.cycle(assignment.cycle_id);
  if (
    assignment.is_submitted ||
    cycle.status !== "ACTIVE" ||
    cycle.is_deadline_passed
  )
    throw new DomainError(
      "마감되었거나 제출한 리뷰는 수정할 수 없습니다.",
      403,
    );
  return cycle;
}
export function owner(
  repo: Repository,
  id: number,
  member: number,
  cycle: number,
) {
  const a = repo.require("assignments", id);
  if (a.reviewer_id !== member || a.cycle_id !== cycle)
    throw new DomainError("이 리뷰에 접근할 수 없습니다.", 403);
  return a;
}
export function normalizeAnswers(
  repo: Repository,
  cycle: number,
  payload: Row,
  partial = false,
) {
  const questions = repo.questions(cycle);
  const suffixes: Row = {
    RATING: "rating",
    TEXT: "text",
    SINGLE_CHOICE: "single",
    MULTIPLE_CHOICE: "multi",
  };
  const allowed = new Set(
    questions.map((q) => `q_${q.id}_${suffixes[q.question_type]}`),
  );
  for (const key of Object.keys(payload))
    if (key !== "csrfmiddlewaretoken" && !allowed.has(key))
      throw new DomainError("알 수 없는 답변 항목입니다.");
  return questions.map((q) => {
    const suffix = (
      {
        RATING: "rating",
        TEXT: "text",
        SINGLE_CHOICE: "single",
        MULTIPLE_CHOICE: "multi",
      } as Row
    )[q.question_type];
    const raw = payload[`q_${q.id}_${suffix}`];
    if (partial && (raw == null || raw === "")) return { question: q };
    if (q.question_type === "RATING") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 5)
        throw new DomainError("척도는 1~5점 중 선택해 주세요.");
      return { question: q, rating: n };
    }
    if (q.question_type === "TEXT") {
      if (
        typeof raw !== "string" ||
        (!partial && !raw.trim()) ||
        [...raw].length > 2000
      )
        throw new DomainError("서술형 답변은 1~2,000자로 입력해 주세요.");
      return { question: q, text: raw.trim() };
    }
    const values = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    const ids = [...new Set(values.map(Number))];
    if (
      (!partial && ids.length === 0) ||
      (q.question_type === "SINGLE_CHOICE" && ids.length !== 1) ||
      ids.some((id) => !q.options.some((o: Row) => o.id === id))
    )
      throw new DomainError("해당 문항의 선택지를 선택해 주세요.");
    return { question: q, options: ids };
  });
}
export function saveDraft(
  repo: Repository,
  id: number,
  member: number,
  cycle: number,
  payload: Row,
) {
  repo.transaction(() => {
    const a = owner(repo, id, member, cycle);
    editable(repo, a);
    normalizeAnswers(repo, cycle, payload, true);
    const data = { ...payload };
    delete data.csrfmiddlewaretoken;
    if (Buffer.byteLength(JSON.stringify(data)) > 100 * 1024)
      throw new DomainError("임시 저장 데이터는 최대 100KB입니다.");
    repo.run(
      "UPDATE assignments SET draft_data=?,draft_saved_at=? WHERE id=?",
      JSON.stringify(data),
      now(),
      id,
    );
  });
}
export function qualityReason(text: string) {
  if (!text) return "";
  if (
    [
      "없습니다",
      "잘 모르겠습니다",
      "함께한 경험이 없습니다",
      "없음",
      "모름",
      "n/a",
      "na",
      "test",
      "테스트",
      "없어",
      "몰라",
    ].includes(text.toLowerCase()) ||
    [...text].length <= 2 ||
    /^[ㄱ-ㅎㅏ-ㅣ\s]+$/.test(text) ||
    /^(.)\1{2,}$/u.test(text) ||
    /^(asdf|qwerty|zxcv|1234|123|12345|qwer)$/i.test(text)
  )
    return "응답 품질 필터 자동 검출 (실내용 없음)";
  return "";
}
export function submitReview(
  repo: Repository,
  id: number,
  member: number,
  cycle: number,
  payload: Row,
) {
  repo.transaction(() => {
    const a = owner(repo, id, member, cycle);
    editable(repo, a);
    const answers = normalizeAnswers(repo, cycle, payload);
    for (const answer of answers) {
      const reason = qualityReason(answer.text ?? "");
      const result = repo.run(
        "INSERT INTO answers(assignment_id,question_id,rating_value,answer_text,is_excluded_from_report,exclusion_reason) VALUES (?,?,?,?,?,?)",
        id,
        answer.question.id,
        answer.rating ?? null,
        answer.text ?? null,
        reason ? 1 : 0,
        reason,
      );
      for (const option of answer.options ?? [])
        repo.run(
          "INSERT INTO answer_options VALUES (?,?)",
          Number(result.lastInsertRowid),
          option,
        );
    }
    repo.run(
      "UPDATE assignments SET is_submitted=1,submitted_at=?,draft_data=NULL WHERE id=?",
      now(),
      id,
    );
  });
}
export function enqueue<K extends JobKind>(
  repo: Repository,
  kind: K,
  payload: JobPayloads[K],
  key: string,
) {
  repo.run(
    "INSERT OR IGNORE INTO jobs(kind,payload,dedupe_key,created_at) VALUES (?,?,?,?)",
    kind,
    JSON.stringify(payload),
    key,
    now(),
  );
}
export function issuePin(repo: Repository, member: number, cycle: number) {
  const existing = repo.one(
    "SELECT code FROM pins WHERE member_id=? AND cycle_id=?",
    member,
    cycle,
  );
  if (existing) return existing.code as string;
  let code: string;
  do {
    code = String(randomInt(100000, 1000000));
  } while (repo.one("SELECT id FROM pins WHERE code_hash=?", hash(code)));
  repo.run(
    "INSERT INTO pins(member_id,cycle_id,code_hash,code) VALUES (?,?,?,?)",
    member,
    cycle,
    hash(code),
    code,
  );
  return code;
}
export function pinJob(repo: Repository, member: number, cycle: number) {
  const c = repo.require("cycles", cycle),
    code = issuePin(repo, member, cycle);
  enqueue(
    repo,
    "DM",
    {
      member_id: member,
      cycle_id: cycle,
      type: "AUTH_CODE",
      text: `[${c.title}] 피어리뷰를 시작해 주세요.\n6자리 PIN: ${code}\n${process.env.SITE_URL ?? "http://localhost:8000"}/login/`,
    },
    `pin:${cycle}:${member}`,
  );
}
export function startCycle(repo: Repository, id: number) {
  repo.transaction(() => {
    const c = repo.cycle(id);
    if (c.status !== "DRAFT")
      throw new DomainError("초안 회차만 시작할 수 있습니다.");
    if (c.end_at && Date.parse(c.end_at) <= Date.now())
      throw new DomainError("마감 시각이 현재보다 이전입니다.");
    if (!c.questions.length || !c.total_assignments_count)
      throw new DomainError("문항과 리뷰 매칭을 먼저 등록해 주세요.");
    if (
      c.questions.some(
        (q: Row) => q.question_type.includes("CHOICE") && !q.options.length,
      )
    )
      throw new DomainError("객관식 문항에 선택지를 추가해 주세요.");
    repo.run(
      "UPDATE cycles SET status='ACTIVE',start_at=COALESCE(start_at,?) WHERE id=?",
      now(),
      id,
    );
    for (const m of repo.all(
      "SELECT DISTINCT reviewer_id FROM assignments WHERE cycle_id=?",
      id,
    ))
      pinJob(repo, m.reviewer_id, id);
    repo.log(id, "회차 시작");
  });
}
export function closeCycle(repo: Repository, id: number, requireAll = false) {
  repo.transaction(() => {
    const c = repo.cycle(id);
    if (c.status !== "ACTIVE")
      throw new DomainError("진행 중인 회차만 마감할 수 있습니다.");
    if (requireAll && !c.is_all_submitted)
      throw new DomainError("아직 전원 제출되지 않았습니다.");
    repo.run(
      "UPDATE cycles SET status='COMPLETED',end_at=? WHERE id=?",
      now(),
      id,
    );
    enqueue(
      repo,
      "GENERATE",
      { cycle_id: id },
      `generate:${id}:${crypto.randomUUID()}`,
    );
    repo.log(id, "회차 마감 및 결과지 생성 요청");
  });
}
export function addAssignment(
  repo: Repository,
  cycle: number,
  reviewer: number,
  reviewee: number,
) {
  const c = repo.cycle(cycle);
  if (!["DRAFT", "ACTIVE"].includes(c.status) || c.is_deadline_passed)
    throw new DomainError("마감된 회차의 매칭은 수정할 수 없습니다.");
  if (reviewer === reviewee)
    throw new DomainError("자기 자신은 리뷰할 수 없습니다.");
  repo.require("members", reviewer);
  repo.require("members", reviewee);
  repo.run(
    "INSERT OR IGNORE INTO assignments(cycle_id,reviewer_id,reviewee_id) VALUES (?,?,?)",
    cycle,
    reviewer,
    reviewee,
  );
  if (c.status === "ACTIVE") pinJob(repo, reviewer, cycle);
}
export function parseCSV(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      if (quoted && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (!quoted && field)
        throw new DomainError("잘못된 CSV 따옴표입니다.");
      else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new DomainError("닫히지 않은 CSV 따옴표입니다.");
  row.push(field);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
export function importMembers(repo: Repository, bytes: Uint8Array) {
  if (bytes.length > 2 * 1024 * 1024)
    throw new DomainError("CSV는 최대 2MB입니다.");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    source = new TextDecoder("euc-kr", { fatal: true }).decode(bytes);
  }
  const [headers, ...rows] = parseCSV(source.replace(/^\uFEFF/, ""));
  if (!headers) throw new DomainError("CSV가 비어 있습니다.");
  if (rows.length > 10000) throw new DomainError("CSV는 최대 10,000행입니다.");
  let created = 0,
    updated = 0,
    rowIndex = 0;
  const cycle = repo.latest();
  try {
    repo.transaction(() => {
      for (const [index, row] of rows.entries()) {
        rowIndex = index + 2;
        const get = (names: string[]) =>
          row[
            headers.findIndex((h) => names.includes(h.trim().toLowerCase()))
          ]?.trim() ?? "";
        const name = get([
          "name",
          "이름",
          "nickname",
          "닉네임",
          "닉네임(발음)",
        ]);
        if (!name) throw new DomainError(`${index + 2}행에 이름이 없습니다.`);
        const email =
          get(["email", "이메일"]) ||
          `${hash(name).slice(0, 16)}-${index}@members.invalid`;
        const member = memberSchema.parse({
          name,
          email,
          slack_user_id: get(["slack_user_id", "slack_id", "slack"]),
          department: get([
            "department",
            "부서",
            "소속",
            "팀",
            "team",
            "역할",
            "role",
          ]),
        });
        const exists = repo.one("SELECT id FROM members WHERE email=?", email);
        repo.run(
          "INSERT INTO members(name,email,slack_user_id,department,normalized_name,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,slack_user_id=excluded.slack_user_id,department=excluded.department",
          member.name,
          email,
          member.slack_user_id,
          member.department,
          name.normalize("NFKC").toLowerCase(),
          now(),
        );
        exists ? updated++ : created++;
      }
    });
    if (cycle)
      repo.run("DELETE FROM validation_logs WHERE cycle_id=?", cycle.id);
    return { created, updated };
  } catch (error) {
    if (cycle) {
      repo.transaction(() => {
        repo.run("DELETE FROM validation_logs WHERE cycle_id=?", cycle.id);
        repo.run(
          "INSERT INTO validation_logs(cycle_id,row_index,issue_type,current_value,created_at) VALUES (?,?,?,?,?)",
          cycle.id,
          rowIndex,
          "INVALID_ROW",
          error instanceof DomainError
            ? error.message
            : "이름·이메일 등 필수값의 형식을 확인해 주세요.",
          now(),
        );
      });
    }
    throw error;
  }
}
