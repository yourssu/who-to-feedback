import type { Row } from "../repository";
/** Preserve every character while splitting long feedback into readable slide cards. */
function chunks(value: string, maxLines: number) {
  const parts: string[] = [];
  let part = "",
    column = 0,
    lines = 1;
  for (const char of value) {
    const nextLine = char === "\n" || column >= 28;
    if (nextLine && lines >= maxLines && part) {
      parts.push(part);
      part = "";
      column = 0;
      lines = 1;
    } else if (nextLine) {
      lines++;
      column = 0;
    }
    part += char;
    column = char === "\n" ? 0 : column + 1;
  }
  if (part) parts.push(part);
  return parts.length ? parts : [""];
}
export function paginateQuestions(questions: Row[]): Row[] {
  return questions.flatMap((question) => {
    if (question.question_type === "TEXT") {
      // Embedded images leave less vertical space on a detail slide.
      const limit = question.image_url ? 5 : 12;
      const feedback = question.text_answers.flatMap((answer: string) =>
        chunks(answer, limit),
      );
      if (!feedback.length) return [question];
      const pages: Row[] = [];
      for (let i = 0; i < feedback.length; i += 2)
        pages.push({
          ...question,
          text_answers: feedback.slice(i, i + 2),
          continued: i > 0,
        });
      return pages;
    }
    if (question.options_summary.length > 6) {
      const pages: Row[] = [];
      for (let i = 0; i < question.options_summary.length; i += 6)
        pages.push({
          ...question,
          options_summary: question.options_summary.slice(i, i + 6),
          continued: i > 0,
        });
      return pages;
    }
    return [question];
  });
}
