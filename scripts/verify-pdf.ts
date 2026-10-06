import { mkdirSync } from "node:fs";
import { openDatabase } from "../src/db";
import { seedDemo } from "./seed";
import { closeCycle } from "../src/domain";
import { JobRunner } from "../src/jobs";
import { compileFeedback, generateReport } from "../src/reports";

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${args[0]}: ${error}`);
  return output;
}
function normalize(text: string) {
  return text.replace(/\s+/g, "");
}
async function validate(
  repo: ReturnType<typeof openDatabase>,
  report: Record<string, any>,
  path: string,
) {
  if (report.pdf_status !== "READY")
    throw new Error(report.error_log || "PDF 생성이 완료되지 않았습니다.");
  await Bun.write(path, report.pdf);
  if (!Bun.which("pdfinfo") || !Bun.which("pdftotext"))
    throw new Error("PDF 검증에는 Poppler(pdfinfo, pdftotext)가 필요합니다.");
  const info = await command(["pdfinfo", path]);
  const expectedPages = (report.html.match(/<section class="slide/g) ?? [])
    .length;
  const actualPages = Number(info.match(/Pages:\s+(\d+)/)?.[1]);
  if (expectedPages && actualPages !== expectedPages)
    throw new Error(`PDF 페이지 수 불일치: ${actualPages}/${expectedPages}`);
  const text = normalize(await command(["pdftotext", "-layout", path, "-"]));
  const feedback = compileFeedback(repo, report.cycle_id, report.reviewee_id);
  if (!text.includes(normalize(feedback.reviewee.name)))
    throw new Error("PDF에 수신자 이름이 없습니다.");
  for (const q of feedback.question_pages)
    for (const answer of q.text_answers) {
      if (!text.includes(normalize(answer)))
        throw new Error("PDF에서 피드백 원문이 누락되거나 잘렸습니다.");
    }
  console.log(
    `PASS ${path} (${actualPages} pages, ${report.pdf.length} bytes, Korean text checked)`,
  );
}
const repo = openDatabase(":memory:");
try {
  const cycle = seedDemo(repo);
  closeCycle(repo, cycle);
  const runner = new JobRunner(repo, { send: async () => ({}) });
  while (await runner.tick()) {}
  mkdirSync("output/pdf", { recursive: true });
  mkdirSync("artifacts/pdf", { recursive: true });
  for (const report of repo.all("SELECT * FROM reports")) {
    await Bun.write(
      `output/pdf/peerflow-${report.reviewee_id}.html`,
      report.html,
    );
    await validate(
      repo,
      report,
      `output/pdf/peerflow-${report.reviewee_id}.pdf`,
    );
  }
  // Stress feedback with many explicit line breaks, beyond one fixed slide's height.
  const longText =
    "원문을 보존하는 긴 한글 피드백입니다.\n".repeat(50) + "마지막 피드백 문장";
  repo.run(
    "UPDATE answers SET answer_text=? WHERE question_id=(SELECT id FROM questions WHERE question_type='TEXT' LIMIT 1)",
    longText,
  );
  generateReport(repo, cycle, 1);
  while (await runner.tick()) {}
  await validate(
    repo,
    repo.one("SELECT * FROM reports WHERE reviewee_id=1")!,
    "artifacts/pdf/long-feedback.pdf",
  );
} finally {
  repo.db.close();
}
