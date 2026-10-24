import { DomainError } from "../repository";
import { now, owner, saveDraft, submitReview, textLabels } from "../domain";
import type { Ctx, Session, HttpServices } from "../http/types";
export function registerReviewerRoutes(services: HttpServices) {
  const { repo, route, page, flash, form, id } = services;
  const reviewer = (c: Ctx) => {
    const s = c.get("session");
    if (!s.member_id || !s.cycle_id)
      throw new DomainError("PIN으로 로그인해 주세요.", 401);
    return s as Session & {
      member_id: number;
      cycle_id: number;
    };
  };
  route("review_dashboard", "get", (c) => {
    const s = c.get("session");
    if (!s.member_id || !s.cycle_id) return c.redirect("/login/");
    const cycle = repo.cycle(s.cycle_id),
      assignments = repo.assignments(s.cycle_id, s.member_id),
      done = assignments.filter((a) => a.is_submitted).length;
    return page(c, "review/dashboard.html", {
      reviewer: repo.require("members", s.member_id),
      cycle,
      assignments: assignments.map((a) => ({ ...a, assignment: a })),
      submitted_count: done,
      completion_rate: assignments.length
        ? Math.floor((done / assignments.length) * 100)
        : 0,
      is_all_completed: assignments.length > 0 && done === assignments.length,
      can_write: cycle.status === "ACTIVE" && !cycle.is_deadline_passed,
    });
  });
  route("review_form", "get", (c) => {
    const s = reviewer(c),
      a = owner(repo, id(c, "assignment_id"), s.member_id, s.cycle_id),
      cycle = repo.cycle(a.cycle_id),
      is_locked =
        !!a.is_submitted ||
        cycle.status !== "ACTIVE" ||
        cycle.is_deadline_passed;
    const draft = a.draft_data ? JSON.parse(a.draft_data) : {};
    const questions_data = repo.questions(a.cycle_id).map((q) => {
      const answer = repo.one(
        "SELECT * FROM answers WHERE assignment_id=? AND question_id=?",
        a.id,
        q.id,
      );
      const options = answer
        ? repo
            .all(
              "SELECT option_id FROM answer_options WHERE answer_id=?",
              answer.id,
            )
            .map((o) => o.option_id)
        : [];
      return {
        question: q,
        options: q.options,
        scale_options: [1, 2, 3, 4, 5].map((val) => ({
          val,
          label: q.scale_type === "TEXT_5" ? textLabels[val - 1] : `${val}점`,
        })),
        draft_rating: Number(
          draft[`q_${q.id}_rating`] ?? answer?.rating_value ?? 0,
        ),
        draft_text: draft[`q_${q.id}_text`] ?? answer?.answer_text ?? "",
        draft_single: Number(draft[`q_${q.id}_single`] ?? options[0] ?? 0),
        draft_multi: (draft[`q_${q.id}_multi`] != null
          ? [draft[`q_${q.id}_multi`]].flat()
          : options
        ).map(Number),
      };
    });
    return page(c, "review/form.html", {
      assignment: { ...a, reviewee: repo.require("members", a.reviewee_id) },
      cycle,
      questions_data,
      is_locked,
      lock_title: a.is_submitted
        ? "제출한 리뷰가 잠겼어요"
        : "회차가 종료되었어요",
      lock_message: a.is_submitted
        ? "이미 제출을 완료한 피어리뷰입니다. 제출된 답변은 읽기 전용으로 확인만 가능합니다."
        : "마감 시간이 경과하였거나 회차가 종료되어 리뷰를 작성할 수 없습니다.",
    });
  });
  route("review_form", "post", (c) => {
    const s = reviewer(c);
    submitReview(
      repo,
      id(c, "assignment_id"),
      s.member_id,
      s.cycle_id,
      form(c),
    );
    flash(c, "피어리뷰가 성공적으로 제출되었습니다.");
    return c.redirect("/");
  });
  route("save_draft", "post", (c) => {
    const s = reviewer(c);
    saveDraft(repo, id(c, "assignment_id"), s.member_id, s.cycle_id, form(c));
    return c.json({
      status: "success",
      message: "임시 저장되었습니다.",
      saved_at: now(),
    });
  });
}
