import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { DomainError } from "../db";
import { questionSchema } from "../domain";
import type { HttpServices } from "../http/types";
export function registerQuestionsRoutes(services: HttpServices) {
  const { repo, route, page, form, id, back, draftCycle } = services;
  route("admin_questions", "get", (c) =>
    page(c, "admin_custom/questions.html", {
      cycle: repo.cycle(id(c)),
      questions: repo.questions(id(c)),
    }),
  );
  route("admin_add_question", "post", async (c) => {
    draftCycle(id(c));
    const q = questionSchema.parse(form(c));
    let image: string | null = null;
    const file = form(c).image;
    if (file instanceof File && file.size) {
      if (file.size > 2 * 1024 * 1024)
        throw new DomainError("이미지는 최대 2MB입니다.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const png =
        bytes[0] === 137 &&
        bytes[1] === 80 &&
        bytes[2] === 78 &&
        bytes[3] === 71;
      const jpg = bytes[0] === 255 && bytes[1] === 216;
      const webp =
        String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
        String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
      if (!png && !jpg && !webp)
        throw new DomainError("PNG, JPEG, WebP 이미지를 선택해 주세요.");
      image = `question_images/${crypto.randomUUID()}.${png ? "png" : jpg ? "jpg" : "webp"}`;
      const root = process.env.PEERFLOW_MEDIA ?? "media";
      mkdirSync(resolve(root, "question_images"), { recursive: true });
      await Bun.write(resolve(root, image), bytes);
    }
    repo.run(
      'INSERT INTO questions(cycle_id,"order",question_type,scale_type,category,content,image) VALUES (?,?,?,?,?,?,?)',
      id(c),
      q.order,
      q.question_type,
      q.scale_type,
      q.category,
      q.content,
      image,
    );
    repo.log(id(c), "문항 추가", true);
    return back(c, id(c), "admin_questions");
  });
  route("admin_delete_question", "post", (c) => {
    const q = repo.require("questions", id(c, "question_id"));
    draftCycle(q.cycle_id);
    repo.run("DELETE FROM questions WHERE id=?", q.id);
    repo.log(q.cycle_id, "문항 삭제", true);
    return back(c, q.cycle_id, "admin_questions");
  });
  route("admin_add_option", "post", (c) => {
    const q = repo.require("questions", id(c, "question_id"));
    draftCycle(q.cycle_id);
    if (!q.question_type.includes("CHOICE"))
      throw new DomainError("객관식 문항에만 선택지를 추가할 수 있습니다.");
    const text = z.string().trim().min(1).max(200).parse(form(c).option_text);
    const order = repo.one(
      'SELECT COALESCE(max("order"),0)+1 n FROM options WHERE question_id=?',
      q.id,
    )!.n;
    repo.run(
      'INSERT INTO options(question_id,option_text,"order") VALUES (?,?,?)',
      q.id,
      text,
      order,
    );
    repo.log(q.cycle_id, "선택지 추가", true);
    return back(c, q.cycle_id, "admin_questions");
  });
  route("admin_delete_option", "post", (c) => {
    const option = repo.require("options", id(c, "option_id")),
      q = repo.require("questions", option.question_id);
    draftCycle(q.cycle_id);
    repo.run("DELETE FROM options WHERE id=?", option.id);
    repo.log(q.cycle_id, "선택지 삭제", true);
    return back(c, q.cycle_id, "admin_questions");
  });
}
