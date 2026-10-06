import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db";
import { backupDatabase } from "../../scripts/backup";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initialSchema } from "../../src/schema";
import { applyMigrations } from "../../src/migrations";

test("기존 Bun 스키마를 갱신하고 데이터와 적용 버전을 보존한다", () => {
  const db = new Database(":memory:");
  try {
    db.exec(initialSchema);
    db.run("INSERT INTO schema_version VALUES (1)");
    db.run(
      "INSERT INTO members(name,email,created_at) VALUES ('보존','keep@example.com','2026-01-01')",
    );
    applyMigrations(db);
    applyMigrations(db);
    expect(db.query("SELECT name FROM members").get()).toEqual({
      name: "보존",
    });
    expect(
      db.query("SELECT max(version) version FROM schema_version").get(),
    ).toEqual({ version: 2 });
    expect(
      db
        .query("PRAGMA table_info(reports)")
        .all()
        .map((row: any) => row.name),
    ).toContain("approved_hash");
  } finally {
    db.close();
  }
});

test("지원하지 않는 새 스키마를 묵시적으로 열지 않는다", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES (99)",
    );
    expect(() => applyMigrations(db)).toThrow("최신");
  } finally {
    db.close();
  }
});

test("SQLite 일관성 있는 백업 파일을 열어 데이터를 복구할 수 있다", () => {
  const root = mkdtempSync(join(tmpdir(), "peerflow-backup-"));
  const path = join(root, "source.sqlite3"),
    target = join(root, "backup.sqlite3");
  try {
    const repo = openDatabase(path);
    repo.run(
      "INSERT INTO members(name,email,created_at) VALUES ('백업','backup@example.com','2026-01-01')",
    );
    repo.db.close();
    backupDatabase(path, target);
    const restored = openDatabase(target);
    try {
      expect(restored.members()[0].name).toBe("백업");
      expect(
        restored.one<{ integrity_check: string }>("PRAGMA integrity_check"),
      ).toEqual({ integrity_check: "ok" });
    } finally {
      restored.db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
