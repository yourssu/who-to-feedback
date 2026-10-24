import { getPlatform } from "../platform";
import { DomainError } from "../repository";
import { questionSchema } from "../domain";
import {
  addQuestion,
  deleteQuestion,
  addOption,
  deleteOption,
  requireDraftCycle,
} from "../questions";
import type { HttpServices } from "../http/types";
export function registerQuestionsRoutes(services: HttpServices) {
  const { repo, route, page, form, id, back } = services;
  route("admin_questions", "get", (c) =>
    page(c, "admin_custom/questions.html", {
      cycle: repo.cycle(id(c)),
      questions: repo.questions(id(c)),
    }),
  );
  route("admin_add_question", "post", async (c) => {
    requireDraftCycle(repo, id(c));
    const q = questionSchema.parse(form(c));
    let image: string | null = null;
    let imagePath: string | null = null;
    try {
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
        imagePath = image;
        await getPlatform(repo).mediaPut(image, bytes);
      }
      addQuestion(repo, id(c), q, image);
    } catch (error) {
      if (imagePath) {
        try {
          await getPlatform(repo).mediaDelete(imagePath);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "문항 저장 및 업로드 정리에 실패했습니다.",
          );
        }
      }
      throw error;
    }
    return back(c, id(c), "admin_questions");
  });
  route("admin_delete_question", "post", (c) => {
    const cycle = deleteQuestion(repo, id(c, "question_id"));
    return back(c, cycle, "admin_questions");
  });
  route("admin_add_option", "post", (c) => {
    const cycle = addOption(repo, id(c, "question_id"), form(c).option_text);
    return back(c, cycle, "admin_questions");
  });
  route("admin_delete_option", "post", (c) => {
    const cycle = deleteOption(repo, id(c, "option_id"));
    return back(c, cycle, "admin_questions");
  });
}
