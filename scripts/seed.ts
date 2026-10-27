import { openDatabase } from "../src/db";
import { seedDemo } from "../src/demo";
export { seedDemo } from "../src/demo";
if (import.meta.main) {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.MOCK_SLACK_MODE?.toLowerCase() === "false"
  )
    throw new Error("데모 생성은 개발용 Mock 모드에서만 가능합니다.");
  const repo = openDatabase();
  seedDemo(repo);
  console.log(
    "개발용 데모 생성 완료. /setup/에서 관리자 계정을 생성해 주세요.",
  );
  for (const p of repo.all(
    "SELECT m.name,p.code FROM pins p JOIN members m ON m.id=p.member_id",
  ))
    console.log(`${p.name}: ${p.code}`);
  repo.db.close();
}
