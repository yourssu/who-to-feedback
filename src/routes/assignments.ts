import { DomainError } from "../repository";
import { addAssignment } from "../domain";
import type { HttpServices } from "../http/types";
export function registerAssignmentsRoutes(services: HttpServices) {
  const { repo, route, page, form, id, back, numeric } = services;
  route("admin_assignments", "get", (c) => {
    const members = repo.members();
    return page(c, "admin_custom/assignments.html", {
      cycle: repo.cycle(id(c)),
      members,
      assignments: repo.assignments(id(c)),
      departments: [
        ...new Set(members.map((m) => m.department).filter(Boolean)),
      ],
    });
  });
  route("admin_add_assignment", "post", (c) => {
    addAssignment(
      repo,
      id(c),
      numeric(form(c).reviewer_id),
      numeric(form(c).reviewee_id),
    );
    return back(c, id(c), "admin_assignments");
  });
  route("admin_auto_match", "post", (c) => {
    repo.transaction(() => {
      const members = repo.members();
      for (const a of members)
        for (const b of members)
          if (
            a.id !== b.id &&
            (form(c).match_type !== "SAME_DEPT" ||
              a.department === b.department)
          )
            addAssignment(repo, id(c), a.id, b.id);
    });
    return back(c, id(c), "admin_assignments");
  });
  route("admin_delete_assignment", "post", (c) => {
    const a = repo.require("assignments", id(c, "assignment_id")),
      cycle = repo.cycle(a.cycle_id);
    if (
      a.is_submitted ||
      !["DRAFT", "ACTIVE"].includes(cycle.status) ||
      cycle.is_deadline_passed
    )
      throw new DomainError("제출되거나 마감된 매칭은 삭제할 수 없습니다.");
    repo.run("DELETE FROM assignments WHERE id=?", a.id);
    return back(c, a.cycle_id, "admin_assignments");
  });
}
