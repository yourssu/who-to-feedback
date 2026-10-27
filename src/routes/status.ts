import { getPlatform } from "../platform";
import { sendReminders } from "../reminders";
import { type Row } from "../repository";
import { closeCycle, startCycle } from "../domain";
import type { Ctx, HttpServices } from "../http/types";
export function registerStatusRoutes(services: HttpServices) {
  const { repo, route, page, flash, id, back } = services;
  const statusPage = (c: Ctx, cycle: Row | null) => {
    const assignments = cycle ? repo.assignments(cycle.id) : [];
    const reviewers = [
      ...new Map(assignments.map((a) => [a.reviewer.id, a.reviewer])).values(),
    ];
    return page(c, "admin_custom/status.html", {
      cycle,
      active_menu: "status",
      test_pins:
        getPlatform(repo).testMode &&
        cycle?.status === "ACTIVE" &&
        !cycle.is_deadline_passed
          ? repo.all(
              "SELECT m.name, p.code FROM pins p JOIN members m ON m.id=p.member_id WHERE p.cycle_id=? ORDER BY m.id",
              cycle.id,
            )
          : [],
      reviewer_status: reviewers.map((reviewer) => {
        const all = assignments.filter((a) => a.reviewer_id === reviewer.id),
          remaining = all.filter((a) => !a.is_submitted);
        return {
          reviewer,
          total_count: all.length,
          done_count: all.length - remaining.length,
          is_all_done: !remaining.length,
          unsubmitted_reviewees: remaining.map((a) => a.reviewee),
        };
      }),
    });
  };
  route("admin_status", "get", (c) => statusPage(c, repo.latest()));
  route("admin_status_detail", "get", (c) => statusPage(c, repo.cycle(id(c))));
  route("admin_start_cycle_action", "post", (c) => {
    startCycle(repo, id(c));
    flash(c, "회차가 시작되었습니다. PIN 발송 작업을 등록했습니다.");
    return back(c, id(c), "admin_status_detail");
  });
  route("admin_close_cycle_action", "post", (c) => {
    closeCycle(repo, id(c));
    return back(c, id(c));
  });
  route("admin_generate_reports_action", "post", (c) => {
    closeCycle(repo, id(c), true);
    return back(c, id(c));
  });
  route("admin_send_reminder_action", "post", (c) => {
    sendReminders(repo, id(c));
    flash(c, "리마인더 발송 작업을 등록했습니다.");
    return back(c, id(c), "admin_status_detail");
  });
}
