import { DomainError } from "../repository";
import { importMembers, memberSchema, now } from "../domain";
import type { HttpServices } from "../http/types";
export function registerMembersRoutes(services: HttpServices) {
  const { repo, route, page, flash, form, id } = services;
  route("admin_members", "get", (c) =>
    page(c, "admin_custom/members.html", {
      members: repo.members(),
      active_menu: "members",
    }),
  );
  route("admin_add_member", "post", (c) => {
    const m = memberSchema.parse(form(c));
    repo.run(
      "INSERT INTO members(name,email,slack_user_id,department,normalized_name,created_at) VALUES (?,?,?,?,?,?)",
      m.name,
      m.email,
      m.slack_user_id,
      m.department,
      m.name.normalize("NFKC").toLowerCase(),
      now(),
    );
    flash(c, "팀원이 등록되었습니다.");
    return c.redirect("/admin/members/");
  });
  route("admin_delete_member", "post", (c) => {
    const member = id(c, "member_id");
    repo.require("members", member);
    if (
      repo.one(
        "SELECT id FROM assignments WHERE reviewer_id=? OR reviewee_id=?",
        member,
        member,
      )
    )
      throw new DomainError(
        "리뷰에 참여한 팀원은 삭제할 수 없습니다. 매칭을 먼저 확인해 주세요.",
      );
    repo.run("DELETE FROM members WHERE id=?", member);
    return c.redirect("/admin/members/");
  });
  route("admin_import_members_csv", "post", async (c) => {
    const file = form(c).csv_file;
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".csv"))
      throw new DomainError("CSV 파일을 선택해 주세요.");
    const result = importMembers(
      repo,
      new Uint8Array(await file.arrayBuffer()),
    );
    flash(
      c,
      `CSV 등록 완료: 신규 ${result.created}명, 업데이트 ${result.updated}명`,
    );
    return c.redirect("/admin/members/");
  });
}
