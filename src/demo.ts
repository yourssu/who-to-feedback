import type { Repository } from "./repository";
import { addAssignment, now, startCycle, submitReview } from "./domain";

export function seedDemo(repo: Repository) {
  if (
    repo.one("SELECT id FROM members LIMIT 1") ||
    repo.one("SELECT id FROM cycles LIMIT 1")
  )
    throw new Error("데모 생성은 빈 DB에서만 가능합니다.");
  const members = [
    ["김유어", "you@example.com", "Product Design"],
    ["박수", "soo@example.com", "Engineering"],
    ["이온", "on@example.com", "Engineering"],
  ];
  for (const [name, email, department] of members)
    repo.run(
      "INSERT INTO members(name,email,department,slack_user_id,created_at) VALUES (?,?,?,?,?)",
      name,
      email,
      department,
      `UDEMO000${members.findIndex((m) => m[0] === name)}`,
      now(),
    );
  const cycle = Number(
    repo.run(
      "INSERT INTO cycles(title,start_at,end_at,created_at) VALUES (?,?,?,?)",
      "목업 피어리뷰 — 직접 제출 테스트",
      now(),
      new Date(Date.now() + 7 * 86400000).toISOString(),
      now(),
    ).lastInsertRowid,
  );
  for (const [index, type] of [
    "RATING",
    "TEXT",
    "SINGLE_CHOICE",
    "MULTIPLE_CHOICE",
  ].entries()) {
    const question = Number(
      repo.run(
        'INSERT INTO questions(cycle_id,"order",question_type,category,content) VALUES (?,?,?,?,?)',
        cycle,
        index + 1,
        type,
        index ? "Deep Immersion" : "Active Ownership",
        [
          "동료의 협업 태도와 소통 능력을 평가해 주세요.",
          "함께 일하며 좋았던 점과 다음에 시도해 볼 점을 작성해 주세요.",
          "가장 인상적인 협업 방식을 선택해 주세요.",
          "동료의 강점을 모두 선택해 주세요.",
        ][index],
      ).lastInsertRowid,
    );
    if (type.includes("CHOICE"))
      for (const [order, text] of ["소통", "문제 해결", "책임감"].entries())
        repo.run(
          'INSERT INTO options(question_id,"order",option_text) VALUES (?,?,?)',
          question,
          order + 1,
          text,
        );
  }
  repo.transaction(() => {
    for (const a of repo.members())
      for (const b of repo.members())
        if (a.id !== b.id) addAssignment(repo, cycle, a.id, b.id);
  });
  startCycle(repo, cycle);
  const questions = repo.questions(cycle);
  for (const a of repo
    .assignments(cycle)
    .filter((a) => a.reviewer_id !== repo.members()[0].id))
    submitReview(
      repo,
      a.id,
      a.reviewer_id,
      cycle,
      Object.fromEntries(
        questions.map((q) => [
          `q_${q.id}_${({ RATING: "rating", TEXT: "text", SINGLE_CHOICE: "single", MULTIPLE_CHOICE: "multi" } as Record<string, string>)[q.question_type]}`,
          q.question_type === "RATING"
            ? 4
            : q.question_type === "TEXT"
              ? "항상 꼼꼼한 리뷰와 명확한 설명으로 협업을 도와주셨습니다."
              : q.question_type === "SINGLE_CHOICE"
                ? q.options[0].id
                : q.options.slice(0, 2).map((o: { id: number }) => o.id),
        ]),
      ),
    );
  return cycle;
}
