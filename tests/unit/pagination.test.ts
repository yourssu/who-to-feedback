import { expect, test } from "bun:test";
import { paginateQuestions } from "../../src/reporting/pagination";

test("긴 한글과 줄바꿈 피드백을 누락 없이 여러 페이지에 배치한다", () => {
  const text = "긴 한글 피드백 원문입니다.\n".repeat(70) + "끝 문장";
  const q = {
    question_type: "TEXT",
    image_url: "",
    text_answers: [text],
    options_summary: [],
  };
  const pages = paginateQuestions([q]);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.flatMap((p) => p.text_answers).join("")).toBe(text);
  expect(pages.every((p) => p.text_answers.length <= 2)).toBe(true);
  expect(pages[1].continued).toBe(true);
});
test("선택지가 많으면 모든 수치와 선택지 순서를 보존한다", () => {
  const options = Array.from({ length: 20 }, (_, i) => ({
    text: `선택 ${i}`,
    count: i,
    percentage: i * 5,
  }));
  const pages = paginateQuestions([
    { question_type: "MULTIPLE_CHOICE", options_summary: options },
  ]);
  expect(pages).toHaveLength(4);
  expect(pages.flatMap((p) => p.options_summary)).toEqual(options);
});
