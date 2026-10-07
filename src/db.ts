import { Database, type SQLQueryBindings } from "bun:sqlite";
import { applyMigrations } from "./migrations";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Assignment,
  Member,
  Question,
  Option,
  CycleRecord,
  CycleView,
  ReportRecord,
  JobRecord,
} from "./models";
export type Row = Record<string, any>;
export function openDatabase(
  path = process.env.PEERFLOW_DB ?? "data/peerflow.sqlite3",
) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;",
  );
  applyMigrations(db);
  return new Repository(db);
}
export class Repository {
  constructor(public db: Database) {}
  all<T = Row>(sql: string, ...args: SQLQueryBindings[]): T[] {
    return this.db.query(sql).all(...args) as T[];
  }
  one<T = Row>(sql: string, ...args: SQLQueryBindings[]): T | null {
    return this.db.query(sql).get(...args) as T | null;
  }
  run(sql: string, ...args: SQLQueryBindings[]) {
    return this.db.query(sql).run(...args);
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
  require(table: "cycles", id: number): CycleRecord;
  require(table: "reports", id: number): ReportRecord;
  require(table: "jobs", id: number): JobRecord;
  require(table: "members", id: number): Member;
  require(table: string, id: number): Row;
  require(table: string, id: number): Row {
    if (
      ![
        "members",
        "cycles",
        "questions",
        "options",
        "assignments",
        "answers",
        "reports",
        "admins",
        "jobs",
      ].includes(table)
    )
      throw new Error("Invalid table");
    const row = this.one(`SELECT * FROM ${table} WHERE id=?`, id);
    if (!row) throw new DomainError("요청한 항목을 찾을 수 없습니다.", 404);
    return row;
  }
  members(): Member[] {
    return this.all("SELECT * FROM members ORDER BY name,id") as Member[];
  }
  questions(cycle: number): Question[] {
    const options = new Map<number, Option[]>();
    for (const option of this.all<Option>(
      'SELECT o.* FROM options o JOIN questions q ON q.id=o.question_id WHERE q.cycle_id=? ORDER BY o."order",o.id',
      cycle,
    )) {
      const group = options.get(option.question_id) ?? [];
      group.push(option);
      options.set(option.question_id, group);
    }
    return this.all(
      'SELECT * FROM questions WHERE cycle_id=? ORDER BY "order",id',
      cycle,
    ).map((q) => ({
      ...q,
      image: q.image ? { url: `/media/${q.image}` } : null,
      options: options.get(q.id) ?? [],
      get_question_type_display: (
        {
          RATING: "5점 척도 평가",
          TEXT: "서술형 주관식",
          SINGLE_CHOICE: "객관식 단일 선택",
          MULTIPLE_CHOICE: "객관식 다중 선택 (태그)",
        } as Row
      )[q.question_type],
      get_scale_type_display:
        q.scale_type === "TEXT_5" ? "텍스트 5단계" : "숫자 1–5",
    })) as Question[];
  }
  assignments(cycle: number, reviewer?: number): Assignment[] {
    const members = new Map(
      this.all<Member>(
        `SELECT m.* FROM members m WHERE m.id IN (
        SELECT reviewer_id FROM assignments WHERE cycle_id=?
        UNION SELECT reviewee_id FROM assignments WHERE cycle_id=?
      )`,
        cycle,
        cycle,
      ).map((member) => [member.id, member]),
    );
    return this.all(
      `SELECT * FROM assignments WHERE cycle_id=? ${reviewer !== undefined ? "AND reviewer_id=?" : ""} ORDER BY id`,
      ...[cycle, ...(reviewer !== undefined ? [reviewer] : [])],
    ).map((a) => ({
      ...a,
      is_submitted: !!a.is_submitted,
      reviewer: members.get(a.reviewer_id)!,
      reviewee: members.get(a.reviewee_id)!,
      draft_data: a.draft_data ? JSON.parse(a.draft_data) : {},
    })) as Assignment[];
  }
  cycle(id: number): CycleView {
    const c = this.require("cycles", id);
    const a = this.one(
      "SELECT count(*) total, sum(is_submitted) done FROM assignments WHERE cycle_id=?",
      id,
    )!;
    return {
      ...c,
      questions: this.questions(id),
      reports: this.all("SELECT id FROM reports WHERE cycle_id=?", id),
      total_assignments_count: a.total,
      submitted_assignments_count: a.done ?? 0,
      completion_rate: a.total
        ? Math.floor(((a.done ?? 0) / a.total) * 100)
        : 0,
      is_all_submitted: a.total > 0 && a.done === a.total,
      is_question_locked: c.status !== "DRAFT",
      is_deadline_passed:
        ["COMPLETED", "CLOSED"].includes(c.status) ||
        !!(c.end_at && Date.parse(c.end_at) <= Date.now()),
      get_status_display: (
        {
          DRAFT: "초안 (DRAFT)",
          ACTIVE: "진행 중 (ACTIVE)",
          COMPLETED: "작성 완료 (COMPLETED)",
          CLOSED: "종료 및 배포 (CLOSED)",
        } as Row
      )[c.status],
      custom_html_file: c.custom_template
        ? { name: c.custom_template_name }
        : null,
    };
  }
  latest(): CycleView | null {
    const c = this.one(
      "SELECT id FROM cycles ORDER BY created_at DESC,id DESC LIMIT 1",
    );
    return c ? this.cycle(c.id) : null;
  }
  log(cycle: number, summary: string, bumpVersion = false) {
    this.transaction(() => {
      const c = this.require("cycles", cycle);
      const version = bumpVersion
        ? `v${Number(c.version.replace(/^v/, "")) + 1}`
        : c.version;
      if (bumpVersion)
        this.run("UPDATE cycles SET version=? WHERE id=?", version, cycle);
      this.run(
        "INSERT INTO version_logs(cycle_id,version,changed_summary,created_at) VALUES (?,?,?,?)",
        cycle,
        version,
        summary,
        new Date().toISOString(),
      );
    });
  }
}
export class DomainError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
