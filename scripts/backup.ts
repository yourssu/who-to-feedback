import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export function backupDatabase(source: string, target: string) {
  const db = new Database(source, { readonly: true });
  try {
    db.query("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
}
if (import.meta.main) {
  const destination = process.argv[2];
  if (!destination)
    throw new Error(
      "사용법: bun run scripts/backup.ts /절대/백업/경로 (앱 정지 후 실행)",
    );
  const target = resolve(destination);
  if (existsSync(target))
    throw new Error("이미 존재하는 백업 경로입니다. 새 경로를 지정해 주세요.");
  mkdirSync(target, { recursive: true });
  backupDatabase(
    resolve(process.env.PEERFLOW_DB ?? "data/peerflow.sqlite3"),
    resolve(target, "peerflow.sqlite3"),
  );
  const media = resolve(process.env.PEERFLOW_MEDIA ?? "media");
  if (existsSync(media))
    cpSync(media, resolve(target, "media"), { recursive: true });
  console.log(`백업 완료: ${target}`);
}
