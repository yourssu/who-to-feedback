import type { Database } from "bun:sqlite";
import { initialSchema } from "./schema";
const migrations = [
  initialSchema,
  `ALTER TABLE reports ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE reports ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
   ALTER TABLE reports ADD COLUMN approved_hash TEXT;
   ALTER TABLE jobs ADD COLUMN resolved_at TEXT;
   ALTER TABLE jobs ADD COLUMN resolution TEXT;`,
];
export function applyMigrations(db: Database) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY)",
  );
  db.transaction(() => {
    const row = db
      .query("SELECT max(version) version FROM schema_version")
      .get() as {
      version: number | null;
    };
    const version = row.version ?? 0;
    if (version > migrations.length)
      throw new Error(
        "DB 스키마가 앱보다 최신입니다. 같은 버전의 앱으로 실행해 주세요.",
      );
    for (let i = version; i < migrations.length; i++) {
      db.exec(migrations[i]);
      db.query("INSERT INTO schema_version VALUES (?)").run(i + 1);
    }
  }).immediate();
}
