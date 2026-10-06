import { DomainError, type Repository } from "./db";
import { enqueue, now } from "./domain";
export function sendReminders(repo: Repository, cycleId: number) {
  const cycle = repo.cycle(cycleId);
  if (cycle.status !== "ACTIVE" || cycle.is_deadline_passed)
    throw new DomainError(
      "진행 중인 회차에서만 리마인더를 발송할 수 있습니다.",
    );
  const assignments = repo.assignments(cycle.id).filter((a) => !a.is_submitted);
  repo.transaction(() => {
    for (const reviewer of new Set(assignments.map((a) => a.reviewer_id))) {
      const names = assignments
        .filter((a) => a.reviewer_id === reviewer)
        .map((a) => a.reviewee.name);
      enqueue(
        repo,
        "DM",
        {
          member_id: reviewer,
          cycle_id: cycle.id,
          type: "REMINDER",
          text: `[${cycle.title}] 아직 작성하지 않은 리뷰: ${names.join(", ")}\n${process.env.SITE_URL ?? "http://localhost:8000"}/`,
        },
        `reminder:${cycle.id}:${reviewer}:${new Date().toISOString().slice(0, 10)}`,
      );
      repo.run(
        "UPDATE assignments SET last_reminded_at=? WHERE cycle_id=? AND reviewer_id=? AND is_submitted=0",
        now(),
        cycle.id,
        reviewer,
      );
    }
  });
}
