import { z } from "zod";
import { DomainError } from "../repository";
import { now } from "../domain";
import type { HttpServices } from "../http/types";
export function registerCyclesRoutes(services: HttpServices) {
  const { repo, route, page, form, id, back } = services;
  route("admin_dashboard", "get", (c) =>
    page(c, "admin_custom/dashboard.html", {
      cycles_data: repo
        .all("SELECT id FROM cycles ORDER BY created_at DESC,id DESC")
        .map((row) => {
          const cycle = repo.cycle(row.id);
          return {
            cycle,
            unsubmitted_reviewers_count: repo.one(
              "SELECT count(DISTINCT reviewer_id) n FROM assignments WHERE cycle_id=? AND is_submitted=0",
              row.id,
            )!.n,
          };
        }),
    }),
  );
  route("admin_create_cycle", "post", (c) => {
    const data = z
      .object({
        title: z.string().trim().min(1).max(200),
        start_at: z.string().min(1),
        end_at: z.string().min(1),
      })
      .parse(form(c));
    const date = (s: string) =>
      new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s + "+09:00");
    const start = date(data.start_at),
      end = date(data.end_at);
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      end <= start
    )
      throw new DomainError("마감 시각은 시작 시각보다 이후여야 합니다.");
    const cycle = Number(
      repo.run(
        "INSERT INTO cycles(title,start_at,end_at,created_at) VALUES (?,?,?,?)",
        data.title,
        start.toISOString(),
        end.toISOString(),
        now(),
      ).lastInsertRowid,
    );
    repo.log(cycle, "회차 생성");
    return back(c, cycle, "admin_questions");
  });
  route("admin_update_reviewer_notice", "post", (c) => {
    repo.require("cycles", id(c));
    repo.run(
      "UPDATE cycles SET reviewer_notice_message=? WHERE id=?",
      String(form(c).reviewer_notice_message ?? "").slice(0, 5000),
      id(c),
    );
    repo.log(id(c), "리뷰어 안내 문구 변경", true);
    return back(c, id(c), "admin_status_detail");
  });
  route("admin_cycle_history", "get", (c) =>
    page(c, "admin_custom/dashboard.html", {
      history_mode: true,
      cycles_data: [],
      cycle: repo.cycle(id(c)),
      version_logs: repo.all(
        "SELECT * FROM version_logs WHERE cycle_id=? ORDER BY id DESC",
        id(c),
      ),
    }),
  );
}
