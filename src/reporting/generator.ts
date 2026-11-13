import puppeteer from "@cloudflare/puppeteer";
import { nowIso, sha256Hex, toReadableSlug } from "../crypto.ts";
import {
  listCycleQuestions,
  requireCycle,
  requireMember,
} from "../db/queries.ts";
import type {
  Env,
  QuestionDto,
  ReportGenerationJobMessage,
  ReportRecord,
} from "../types.ts";

const CHART_COLORS = [
  "#2B2D6E",
  "#8B7CE8",
  "#FFD14D",
  "#4F46E5",
  "#10B981",
  "#F59E0B",
];

export function escapeHtml(str: string): string {
  return str.replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch]!,
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function svgToDataUri(body: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="340" viewBox="0 0 480 340"><style>text{font-family:Pretendard,Arial,sans-serif;font-size:12px;fill:#23244d}</style>${body}</svg>`;
  return `data:image/svg+xml;base64,${toBase64(new TextEncoder().encode(svg))}`;
}

function buildPieChart(labels: string[], values: number[]): string {
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return "";
  let angle = -Math.PI / 2;
  const slices = values
    .map((value, i) => {
      const next = angle + (value / total) * Math.PI * 2;
      const point = (r: number, a: number) => [
        190 + r * Math.cos(a),
        160 + r * Math.sin(a),
      ];
      const [x1, y1] = point(115, angle);
      const [x2, y2] = point(115, next);
      const color = CHART_COLORS[i % CHART_COLORS.length];
      const path =
        value === total
          ? `<circle cx="190" cy="160" r="115" fill="${color}"/>`
          : `<path d="M190 160 L${x1} ${y1} A115 115 0 ${value / total > 0.5 ? 1 : 0} 1 ${x2} ${y2} Z" fill="${color}"/>`;
      const [tx, ty] = point(88, (angle + next) / 2);
      angle = next;
      const pct = ((value / total) * 100).toFixed(1);
      return `${value ? path : ""}${value ? `<text x="${tx}" y="${ty}" text-anchor="middle" style="fill:white;font-weight:bold">${pct}%</text>` : ""}<rect x="335" y="${35 + i * 25}" width="10" height="10" fill="${color}"/><text x="351" y="${45 + i * 25}">${escapeHtml(labels[i].slice(0, 12))}</text>`;
    })
    .join("");
  return svgToDataUri(
    `${slices}<circle cx="190" cy="160" r="67" fill="white"/>`,
  );
}

function buildBarChart(labels: string[], values: number[], max = 5): string {
  if (!labels.length) return "";
  const width = 360 / labels.length;
  const bars = values
    .map((value, i) => {
      const x = 60 + i * width;
      const height = (value / max) * 220;
      const barW = Math.max(2, width - 20);
      return `<rect x="${x}" y="${280 - height}" width="${barW}" height="${height}" fill="#8B7CE8" stroke="#2B2D6E"/><text x="${x + barW / 2}" y="${270 - height}" text-anchor="middle">${value.toFixed(1)}</text><text x="${x + barW / 2}" y="305" text-anchor="middle">${escapeHtml(labels[i].slice(0, 12))}</text>`;
    })
    .join("");
  return svgToDataUri(
    `<path d="M50 30 V280 H450" stroke="#E3E0F5" fill="none"/>${bars}`,
  );
}

function buildRadarChart(labels: string[], values: number[]): string {
  if (labels.length < 3) return buildBarChart(labels, values, 5);
  const point = (r: number, i: number) =>
    `${240 + r * Math.cos((i * 2 * Math.PI) / labels.length - Math.PI / 2)},${165 + r * Math.sin((i * 2 * Math.PI) / labels.length - Math.PI / 2)}`;
  const grids = [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `<polygon points="${labels.map((_, i) => point(n * 24, i)).join(" ")}" fill="none" stroke="#E3E0F5"/>`,
    )
    .join("");
  const axes = labels
    .map((label, i) => {
      const [lx, ly] = point(120, i).split(",");
      const [tx, ty] = point(145, i).split(",");
      return `<line x1="240" y1="165" x2="${lx}" y2="${ly}" stroke="#E3E0F5"/><text x="${tx}" y="${ty}" text-anchor="middle">${escapeHtml(label.slice(0, 16))}</text>`;
    })
    .join("");
  const poly = `<polygon points="${values.map((v, i) => point(v * 24, i)).join(" ")}" fill="#8b7ce8" fill-opacity=".25" stroke="#2b2d6e" stroke-width="2.5"/>`;
  return svgToDataUri(`${grids}${axes}${poly}`);
}

export interface CompiledQuestionSlide {
  display_order: number;
  category: string;
  content: string;
  question_type: QuestionDto["question_type"];
  image_data_uri: string | null;
  avg_rating: number;
  avg_rating_label: string;
  rating_percent: number;
  min_rating: number;
  max_rating: number;
  text_answers: string[];
  options_summary: { text: string; count: number; percentage: number }[];
  pie_chart_base64: string;
  bar_chart_base64: string;
  continued?: boolean;
}

function splitTextChunks(text: string, maxLines: number): string[] {
  const parts: string[] = [];
  let part = "";
  let col = 0;
  let lines = 1;
  for (const ch of text) {
    const nextLine = ch === "\n" || col >= 28;
    if (nextLine && lines >= maxLines && part) {
      parts.push(part);
      part = "";
      col = 0;
      lines = 1;
    } else if (nextLine) {
      lines++;
      col = 0;
    }
    part += ch;
    col = ch === "\n" ? 0 : col + 1;
  }
  if (part) parts.push(part);
  return parts.length ? parts : [""];
}

function paginateSlides(
  questions: CompiledQuestionSlide[],
): CompiledQuestionSlide[] {
  return questions.flatMap((q) => {
    if (q.question_type === "TEXT") {
      const maxLines = q.image_data_uri ? 5 : 12;
      const chunks = q.text_answers.flatMap((ans) =>
        splitTextChunks(ans, maxLines),
      );
      if (chunks.length === 0) return [q];
      const pages: CompiledQuestionSlide[] = [];
      for (let i = 0; i < chunks.length; i += 2) {
        pages.push({
          ...q,
          text_answers: chunks.slice(i, i + 2),
          continued: i > 0,
        });
      }
      return pages;
    }
    if (q.options_summary.length > 6) {
      const pages: CompiledQuestionSlide[] = [];
      for (let i = 0; i < q.options_summary.length; i += 6) {
        pages.push({
          ...q,
          options_summary: q.options_summary.slice(i, i + 6),
          continued: i > 0,
        });
      }
      return pages;
    }
    return [q];
  });
}

export async function renderReportHtml(
  env: Env,
  cycleId: number,
  revieweeId: number,
): Promise<string> {
  const [cycle, reviewee, questions] = await Promise.all([
    requireCycle(env.DB, cycleId),
    requireMember(env.DB, revieweeId),
    listCycleQuestions(env.DB, cycleId),
  ]);

  const submittedCountRow = await env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM assignments WHERE cycle_id = ? AND reviewee_id = ? AND is_submitted = 1",
  )
    .bind(cycleId, revieweeId)
    .first<{ cnt: number }>();
  const totalFeedback = Number(submittedCountRow?.cnt ?? 0);

  const answersRes = await env.DB.prepare(
    `SELECT a.id, a.question_id, a.rating_value, a.answer_text
     FROM answers a
     JOIN assignments s ON s.id = a.assignment_id
     WHERE s.cycle_id = ? AND s.reviewee_id = ? AND s.is_submitted = 1`,
  )
    .bind(cycleId, revieweeId)
    .all<{
      id: number;
      question_id: number;
      rating_value: number | null;
      answer_text: string | null;
    }>();

  const optionCountsRes = await env.DB.prepare(
    `SELECT ao.option_id, COUNT(*) AS cnt
     FROM answer_options ao
     JOIN answers a ON a.id = ao.answer_id
     JOIN assignments s ON s.id = a.assignment_id
     WHERE s.cycle_id = ? AND s.reviewee_id = ? AND s.is_submitted = 1
     GROUP BY ao.option_id`,
  )
    .bind(cycleId, revieweeId)
    .all<{ option_id: number; cnt: number }>();

  const optionCounts = new Map<number, number>(
    optionCountsRes.results.map((r) => [r.option_id, Number(r.cnt)]),
  );

  const answersByQuestion = new Map<
    number,
    { rating_value: number | null; answer_text: string | null }[]
  >();
  for (const row of answersRes.results) {
    const list = answersByQuestion.get(row.question_id) ?? [];
    list.push(row);
    answersByQuestion.set(row.question_id, list);
  }

  const questionRawRows = await env.DB.prepare(
    "SELECT id, image_r2_key FROM questions WHERE cycle_id = ?",
  )
    .bind(cycleId)
    .all<{ id: number; image_r2_key: string | null }>();
  const imageKeyMap = new Map(
    questionRawRows.results.map((r) => [r.id, r.image_r2_key]),
  );

  const categories = new Map<string, number[]>();
  const compiledQuestions: CompiledQuestionSlide[] = [];
  const selectedKeywords: string[] = [];

  for (const q of questions) {
    const qAnswers = answersByQuestion.get(q.id) ?? [];
    let image_data_uri: string | null = null;
    const r2Key = imageKeyMap.get(q.id);
    if (r2Key) {
      const imgObj = await env.FILES.get(r2Key);
      if (imgObj) {
        const mime =
          imgObj.httpMetadata?.contentType ??
          (r2Key.endsWith(".png")
            ? "image/png"
            : r2Key.endsWith(".webp")
              ? "image/webp"
              : "image/jpeg");
        image_data_uri = `data:${mime};base64,${toBase64(new Uint8Array(await imgObj.arrayBuffer()))}`;
      }
    }

    const slide: CompiledQuestionSlide = {
      display_order: q.display_order,
      category: q.category || "기본 역량",
      content: q.content,
      question_type: q.question_type,
      image_data_uri,
      avg_rating: 0,
      avg_rating_label: "0.0점",
      rating_percent: 0,
      min_rating: 0,
      max_rating: 0,
      text_answers: [],
      options_summary: [],
      pie_chart_base64: "",
      bar_chart_base64: "",
    };

    if (q.question_type === "RATING") {
      const scores = qAnswers
        .filter((a) => a.rating_value != null)
        .map((a) => Number(a.rating_value));
      if (scores.length > 0) {
        const avg =
          Math.round(
            (scores.reduce((a, b) => a + b, 0) / scores.length) * 100,
          ) / 100;
        slide.avg_rating = avg;
        slide.avg_rating_label = `${avg.toFixed(1)}점 / 5.0점`;
        slide.rating_percent = Math.floor((avg / 5) * 100);
        slide.min_rating = Math.min(...scores);
        slide.max_rating = Math.max(...scores);
        categories.set(slide.category, [
          ...(categories.get(slide.category) ?? []),
          ...scores,
        ]);
      }
    } else if (q.question_type === "TEXT") {
      slide.text_answers = qAnswers
        .map((a) => a.answer_text?.trim() ?? "")
        .filter(Boolean)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    } else {
      slide.options_summary = q.options.map((opt) => {
        const count = optionCounts.get(opt.id) ?? 0;
        if (count > 0 && !selectedKeywords.includes(opt.option_text)) {
          selectedKeywords.push(opt.option_text);
        }
        return {
          text: opt.option_text,
          count,
          percentage:
            totalFeedback > 0 ? Math.floor((count / totalFeedback) * 100) : 0,
        };
      });
      const nonZero = slide.options_summary.filter((o) => o.count > 0);
      slide.pie_chart_base64 = buildPieChart(
        nonZero.map((o) => o.text),
        nonZero.map((o) => o.count),
      );
      slide.bar_chart_base64 = buildBarChart(
        slide.options_summary.map((o) => o.text),
        slide.options_summary.map((o) => o.percentage),
        100,
      );
    }

    compiledQuestions.push(slide);
  }

  const categorySummary = [...categories.entries()].map(([name, scores]) => {
    const avg =
      Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) /
      100;
    return { name, avg };
  });

  const catLabels = categorySummary.map((c) => c.name);
  const catValues = categorySummary.map((c) => c.avg);
  const radarChartUri = catLabels.length
    ? buildRadarChart(catLabels, catValues)
    : "";
  const pieChartUri = buildPieChart(catLabels, catValues);
  const keywords = selectedKeywords.slice(0, 6);
  const questionPages = paginateSlides(compiledQuestions);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(reviewee.name)} 님 피어리뷰 결과 리포트</title>
<style>
  :root {
    --primary: #2b2d6e;
    --periwinkle: #8b7ce8;
    --gold: #c99410;
    --canvas: #ffffff;
    --surface: #f7f6fd;
    --wash: #ece9fb;
    --hairline: #e3e0f5;
    --ink: #23244d;
    --ink-strong: #1a1b3d;
    --slate: #63648c;
    --steel: #8b8cad;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    background: #ffffff;
    color: var(--ink);
    font-family: "Pretendard", -apple-system, BlinkMacSystemFont, sans-serif;
  }
  @page { size: 1280px 720px; margin: 0; }
  @media print {
    html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .slide:last-child { break-after: auto; page-break-after: auto; }
  }
  .slide {
    position: relative;
    width: 1280px;
    height: 720px;
    overflow: hidden;
    background: var(--canvas);
    page-break-after: always;
    break-after: page;
    padding: 48px 60px;
  }
  .lavender-page { background: var(--wash); }
  .eyebrow { color: var(--primary); font-size: 14px; font-weight: 700; letter-spacing: 1.5px; }
  .slide-title { margin: 12px 0 24px; color: var(--ink-strong); font-size: 30px; font-weight: 750; }
  .card { background: var(--surface); border: 1px solid var(--hairline); border-radius: 16px; padding: 24px; }
  .keyword-pill {
    display: inline-flex; align-items: center; padding: 8px 16px;
    border-radius: 8px; background: var(--primary); color: #fff;
    font-size: 14px; font-weight: 600; margin: 4px;
  }
  .comment-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
  .comment-card {
    border: 1px solid var(--hairline); border-top: 6px solid var(--primary);
    border-radius: 0 0 16px 16px; background: var(--surface); padding: 20px;
  }
  .comment-body { margin-top: 10px; font-size: 15px; line-height: 1.5; white-space: pre-wrap; }
  .page-footer {
    position: absolute; left: 60px; right: 60px; bottom: 24px;
    border-top: 1px solid var(--hairline); padding-top: 8px;
    display: flex; justify-content: space-between; color: var(--steel); font-size: 11px;
  }
</style>
</head>
<body>
  <section class="slide lavender-page">
    <div class="eyebrow">${escapeHtml(cycle.title)}</div>
    <h1 style="font-size: 46px; color: var(--ink-strong); margin-top: 140px;">${escapeHtml(reviewee.name)}님 피어리뷰 리포트</h1>
    <p style="font-size: 20px; color: var(--slate);">부서/소속: ${escapeHtml(reviewee.department || "미지정")} · 총 ${totalFeedback}명 참여</p>
    <footer class="page-footer"><span>PeerFlow Report</span><span>Cover</span><span>Page 01</span></footer>
  </section>

  <section class="slide">
    <div class="eyebrow">01. KEYWORDS &amp; CORE VALUES</div>
    <h2 class="slide-title">핵심 키워드 및 역량 종합</h2>
    <div class="card" style="margin-bottom: 20px;">
      ${keywords.length ? keywords.map((kw) => `<span class="keyword-pill">#${escapeHtml(kw)}</span>`).join("") : '<span style="color:var(--steel)">선택형 키워드 응답이 없습니다.</span>'}
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
      <div class="card">
        <h3 style="margin: 0 0 12px; color: var(--primary);">카테고리별 역량 평균</h3>
        <table width="100%" cellspacing="0" cellpadding="6">
          ${
            categorySummary.length
              ? categorySummary
                  .map(
                    (c) =>
                      `<tr><td><strong>${escapeHtml(c.name)}</strong></td><td align="right"><strong>${c.avg.toFixed(2)}점</strong> / 5.0점</td></tr>`,
                  )
                  .join("")
              : '<tr><td colspan="2" style="color:var(--steel)">척도 응답 데이터가 없습니다.</td></tr>'
          }
        </table>
        ${pieChartUri ? `<div style="text-align:center;margin-top:12px;"><img src="${pieChartUri}" style="max-height:140px;" alt="pie chart"/></div>` : ""}
      </div>
      <div class="card" style="text-align:center;">
        <h3 style="margin: 0 0 12px; color: var(--primary);">역량 방사형 차트</h3>
        ${radarChartUri ? `<img src="${radarChartUri}" style="max-height:260px;" alt="radar chart"/>` : '<p style="color:var(--steel)">차트 데이터가 없습니다.</p>'}
      </div>
    </div>
    <footer class="page-footer"><span>PeerFlow Report</span><span>Summary</span><span>Page 02</span></footer>
  </section>

  ${questionPages
    .map(
      (q, idx) => `<section class="slide">
    <div class="eyebrow">02. QUESTION FEEDBACK</div>
    <h2 class="slide-title">Q${q.display_order}. ${escapeHtml(q.category)}${q.continued ? " (계속)" : ""}</h2>
    <div class="card" style="margin-bottom: 16px;">
      <h3 style="margin: 0; font-size: 20px;">Q${q.display_order}. ${escapeHtml(q.content)}</h3>
      ${q.image_data_uri ? `<div style="margin-top:12px;text-align:center;"><img src="${q.image_data_uri}" style="max-height:160px;border-radius:8px;" alt="question image"/></div>` : ""}
    </div>
    ${
      q.question_type === "RATING"
        ? `<div class="card" style="text-align:center;">
            <div style="font-size:26px;font-weight:bold;color:var(--primary);">${escapeHtml(q.avg_rating_label)}</div>
            <p style="color:var(--slate);">최저 ${q.min_rating}점 ~ 최고 ${q.max_rating}점 (총 ${totalFeedback}명 응답)</p>
          </div>`
        : q.question_type === "TEXT"
          ? `<div class="comment-grid">
              ${
                q.text_answers.length
                  ? q.text_answers
                      .map(
                        (ans) =>
                          `<div class="comment-card"><strong>익명 피드백</strong><div class="comment-body">${escapeHtml(ans)}</div></div>`,
                      )
                      .join("")
                  : '<p style="color:var(--steel)">작성된 서술형 피드백이 없습니다.</p>'
              }
            </div>`
          : `<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
              <div class="card">
                ${q.options_summary
                  .map(
                    (opt) =>
                      `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--hairline);"><span>${escapeHtml(opt.text)}</span><strong>${opt.percentage}% (${opt.count}명)</strong></div>`,
                  )
                  .join("")}
              </div>
              <div class="card" style="text-align:center;">
                ${q.pie_chart_base64 ? `<img src="${q.pie_chart_base64}" style="max-height:200px;" alt="option chart"/>` : '<p style="color:var(--steel)">선택된 항목이 없습니다.</p>'}
              </div>
            </div>`
    }
    <footer class="page-footer"><span>PeerFlow Report</span><span>Question Detail</span><span>Page ${String(idx + 3).padStart(2, "0")}</span></footer>
  </section>`,
    )
    .join("\n")}
</body>
</html>`;
}

export function buildMinimalPdfBytes(title: string): Uint8Array {
  const safeTitle = title.replace(/[()\\]/g, "");
  const content = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 1280 720] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length ${safeTitle.length + 34} >>
stream
BT /F1 18 Tf 60 660 Td (${safeTitle}) Tj ET
endstream
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000231 00000 n 
0000000299 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
385
%%EOF`;
  return new TextEncoder().encode(content);
}

async function renderPdfPageOnBrowser(
  browser: any,
  html: string,
): Promise<Uint8Array> {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 720 });
    await page.setContent(html, { waitUntil: "load" });
    const pdfBuffer = await page.pdf({
      width: "1280px",
      height: "720px",
      printBackground: true,
      margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
    });
    return new Uint8Array(pdfBuffer);
  } finally {
    await page.close().catch(() => {});
  }
}

async function convertHtmlToPdf(
  html: string,
  env: Env,
  sharedBrowser?: any,
): Promise<Uint8Array> {
  if (env.PDF_RENDERER) {
    return env.PDF_RENDERER.renderPdf(html, env);
  }
  if (sharedBrowser) {
    return renderPdfPageOnBrowser(sharedBrowser, html);
  }
  if (env.BROWSER) {
    const browser = await puppeteer.launch(env.BROWSER as any);
    try {
      return await renderPdfPageOnBrowser(browser, html);
    } finally {
      await browser.close().catch(() => {});
    }
  }
  return buildMinimalPdfBytes("PeerFlow Report PDF");
}

export async function processReportGenerationJob(
  env: Env,
  msg: ReportGenerationJobMessage,
  sharedBrowser?: any,
): Promise<void> {
  const report = await env.DB.prepare("SELECT * FROM reports WHERE id = ?")
    .bind(msg.report_id)
    .first<ReportRecord>();

  if (!report || report.revision !== msg.revision) {
    return;
  }

  try {
    const [cycle, reviewee, html] = await Promise.all([
      requireCycle(env.DB, msg.cycle_id),
      requireMember(env.DB, msg.reviewee_id),
      renderReportHtml(env, msg.cycle_id, msg.reviewee_id),
    ]);
    const contentHash = await sha256Hex(html);
    const pdfBytes = await convertHtmlToPdf(html, env, sharedBrowser);

    const cycleFolder = `cycle-${cycle.id}_${toReadableSlug(cycle.title, "cycle")}`;
    const nameSlug = toReadableSlug(reviewee.name, `member-${reviewee.id}`);
    const deptSlug = toReadableSlug(reviewee.department || "미지정", "미지정");
    const memberFolder = `${nameSlug}_${deptSlug}_id${reviewee.id}`;

    const htmlKey = `reports/${cycleFolder}/${memberFolder}/${nameSlug}_피어리뷰_리포트.html`;
    const pdfKey = `reports/${cycleFolder}/${memberFolder}/${nameSlug}_피어리뷰_리포트.pdf`;

    await env.FILES.put(htmlKey, html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    await env.FILES.put(pdfKey, pdfBytes, {
      httpMetadata: { contentType: "application/pdf" },
    });

    const latest = await env.DB.prepare("SELECT * FROM reports WHERE id = ?")
      .bind(msg.report_id)
      .first<ReportRecord>();

    if (!latest || latest.revision !== msg.revision) {
      await env.FILES.delete([htmlKey, pdfKey]);
      return;
    }

    const oldKeysToDelete: string[] = [];
    if (latest.html_r2_key && latest.html_r2_key !== htmlKey) {
      oldKeysToDelete.push(latest.html_r2_key);
    }
    if (latest.pdf_r2_key && latest.pdf_r2_key !== pdfKey) {
      oldKeysToDelete.push(latest.pdf_r2_key);
    }

    await env.DB.prepare(
      `UPDATE reports
       SET generation_status = 'READY',
           html_r2_key = ?,
           pdf_r2_key = ?,
           content_hash = ?,
           error_message = '',
           updated_at = ?
       WHERE id = ? AND revision = ?`,
    )
      .bind(
        htmlKey,
        pdfKey,
        contentHash,
        nowIso(),
        msg.report_id,
        msg.revision,
      )
      .run();

    if (oldKeysToDelete.length > 0) {
      await env.FILES.delete(oldKeysToDelete);
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "리포트 생성 중 오류가 발생했습니다.";
    await env.DB.prepare(
      `UPDATE reports
       SET generation_status = 'FAILED',
           error_message = ?,
           updated_at = ?
       WHERE id = ? AND revision = ?`,
    )
      .bind(message, nowIso(), msg.report_id, msg.revision)
      .run();
    throw err;
  }
}
