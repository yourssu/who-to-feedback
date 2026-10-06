import { DomainError, openDatabase, type Repository } from "../src/db";
import { startCycle, closeCycle, enqueue } from "../src/domain";
import { publish } from "../src/reports";
import { sendReminders } from "../src/reminders";

export function manage(repo: Repository, action: string, cycle: number) {
  if (!Number.isSafeInteger(cycle) || cycle < 1)
    throw new DomainError("유효한 회차 ID가 필요합니다.");
  switch (action) {
    case "start_review_cycle":
      startCycle(repo, cycle);
      break;
    case "close_review_cycle":
      closeCycle(repo, cycle);
      break;
    case "send_reminders":
      sendReminders(repo, cycle);
      break;
    case "generate_reports":
      if (repo.cycle(cycle).status !== "COMPLETED")
        throw new DomainError("마감된 회차만 생성할 수 있습니다.");
      enqueue(
        repo,
        "GENERATE",
        { cycle_id: cycle },
        `cli-generate:${cycle}:${crypto.randomUUID()}`,
      );
      break;
    case "publish_reports": {
      const reports = repo.all(
        "SELECT validation_status FROM reports WHERE cycle_id=?",
        cycle,
      );
      if (
        !reports.length ||
        reports.some((r) => !["APPROVED", "SENT"].includes(r.validation_status))
      )
        throw new DomainError("CLI는 이미 승인된 결과지만 발송할 수 있습니다.");
      publish(repo, cycle);
      break;
    }
    default:
      throw new DomainError(
        "명령: start_review_cycle, close_review_cycle, send_reminders, generate_reports, publish_reports",
      );
  }
}
if (import.meta.main) {
  const repo = openDatabase();
  try {
    manage(repo, process.argv[2] ?? "", Number(process.argv[3]));
    console.log("처리 완료. 큐 작업은 실행 중인 앱이 수행합니다.");
  } finally {
    repo.db.close();
  }
}
