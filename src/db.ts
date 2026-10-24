import { Database } from "bun:sqlite";
import { applyMigrations } from "./migrations";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Repository } from "./repository";
export * from "./repository";
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
