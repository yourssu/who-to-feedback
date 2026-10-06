import { z } from "zod";
import { DomainError, type Row } from "../db";
import type { Ctx, HttpServices } from "../http/types";
export function registerValidationRoutes(services: HttpServices) {
  const { repo, route, page, flash, form, id, back, invalidateReports } =
    services;
  const validation = (c: Ctx, cycle: Row | null) => {
    const members = repo.members(),
      suggestions: Row[] = [],
      seen = new Set<number>();
    for (const member of members) {
      if (seen.has(member.id)) continue;
      const others = members.filter(
        (m) =>
          !seen.has(m.id) &&
          m.name.normalize("NFKC").toLowerCase() ===
            member.name.normalize("NFKC").toLowerCase(),
      );
      if (others.length > 1) {
        others.forEach((m) => seen.add(m.id));
        suggestions.push({
          raw_names: others.map((m) => m.name),
          suggested_name: member.name,
          similarity: 100,
        });
      }
    }
    const excluded = cycle
      ? repo
          .all(
            "SELECT a.* FROM answers a JOIN assignments s ON s.id=a.assignment_id WHERE s.cycle_id=? AND a.is_excluded_from_report=1",
            cycle.id,
          )
          .map((a) => {
            const assignment = repo.require("assignments", a.assignment_id);
            return {
              ...a,
              question: repo.require("questions", a.question_id),
              assignment: {
                ...assignment,
                reviewer: repo.require("members", assignment.reviewer_id),
                reviewee: repo.require("members", assignment.reviewee_id),
              },
            };
          })
      : [];
    return page(c, "admin_custom/validation.html", {
      cycle,
      active_menu: "validation",
      suggestions,
      logs: cycle
        ? repo.all("SELECT * FROM validation_logs WHERE cycle_id=?", cycle.id)
        : [],
      excluded_answers: excluded,
    });
  };
  route("admin_validation", "get", (c) => validation(c, repo.latest()));
  route("admin_validation_detail", "get", (c) =>
    validation(c, repo.cycle(id(c))),
  );
  route("admin_apply_normalization", "post", (c) => {
    const data = form(c),
      names = Array.isArray(data.raw_names) ? data.raw_names : [data.raw_names];
    const target = z.string().trim().min(1).max(50).parse(data.target_name);
    repo.transaction(() => {
      for (const name of names)
        repo.run(
          "UPDATE members SET normalized_name=? WHERE name=?",
          target,
          String(name),
        );
    });
    flash(c, "원본 이름을 보존하고 정규화 이름을 저장했습니다.");
    return c.redirect("/admin-panel/validation/");
  });
  route("admin_toggle_answer_exclusion", "post", (c) => {
    const a = repo.require("answers", id(c, "answer_id")),
      assignment = repo.require("assignments", a.assignment_id);
    if (repo.cycle(assignment.cycle_id).status === "CLOSED")
      throw new DomainError("배포가 종료된 답변은 변경할 수 없습니다.");
    repo.transaction(() => {
      invalidateReports(assignment.cycle_id);
      repo.run(
        "UPDATE answers SET is_excluded_from_report=1-is_excluded_from_report WHERE id=?",
        a.id,
      );
    });
    return back(c, assignment.cycle_id, "admin_validation_detail");
  });
}
