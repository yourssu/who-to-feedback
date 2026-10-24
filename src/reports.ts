import { createHash } from "node:crypto";
import { fontData, imageData } from "#report-files";
import { DomainError, type Repository, type Row } from "./repository";
import { outlineSvgText } from "./reporting/svg-text";
import { reportPrintStyle } from "./reporting/print-style";
import { paginateQuestions } from "./reporting/pagination";
import { now, enqueue } from "./domain";
import { escapeHtml, renderCustom, templates } from "#templates";
const colors = [
  "#2B2D6E",
  "#8B7CE8",
  "#FFD14D",
  "#4F46E5",
  "#10B981",
  "#F59E0B",
];
const svgUri = (body: string) =>
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="340" viewBox="0 0 480 340"><style>text{font-family:Arial,sans-serif;font-size:12px;fill:#23244d}</style>${outlineSvgText(body)}</svg>`,
  ).toString("base64");
function pie(labels: string[], values: number[]) {
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return "";
  let angle = -Math.PI / 2;
  return svgUri(
    values
      .map((value, i) => {
        const next = angle + (value / total) * Math.PI * 2;
        const point = (r: number, a: number) => [
          190 + r * Math.cos(a),
          160 + r * Math.sin(a),
        ];
        const [x1, y1] = point(115, angle),
          [x2, y2] = point(115, next);
        const path =
          value === total
            ? `<circle cx="190" cy="160" r="115" fill="${colors[i % colors.length]}"/>`
            : `<path d="M190 160 L${x1} ${y1} A115 115 0 ${value / total > 0.5 ? 1 : 0} 1 ${x2} ${y2} Z" fill="${colors[i % colors.length]}"/>`;
        const [tx, ty] = point(88, (angle + next) / 2);
        angle = next;
        return `${value ? path : ""}${value ? `<text x="${tx}" y="${ty}" text-anchor="middle" style="fill:white;font-weight:bold">${((value / total) * 100).toFixed(1)}%</text>` : ""}<rect x="335" y="${35 + i * 25}" width="10" height="10" fill="${colors[i % colors.length]}"/><text x="351" y="${45 + i * 25}">${escapeHtml(labels[i].slice(0, 12))}</text>`;
      })
      .join("") + '<circle cx="190" cy="160" r="67" fill="white"/>',
  );
}
function bar(labels: string[], values: number[], max = 5) {
  if (!labels.length) return "";
  const width = 360 / labels.length;
  return svgUri(
    `<path d="M50 30 V280 H450" stroke="#E3E0F5" fill="none"/>` +
      values
        .map((value, i) => {
          const x = 60 + i * width,
            height = (value / max) * 220;
          return `<rect x="${x}" y="${280 - height}" width="${Math.max(2, width - 20)}" height="${height}" fill="#8B7CE8" stroke="#2B2D6E"/><text x="${x + (width - 20) / 2}" y="${270 - height}" text-anchor="middle">${value.toFixed(1)}</text><text x="${x + (width - 20) / 2}" y="305" text-anchor="middle">${escapeHtml(labels[i].slice(0, 12))}</text>`;
        })
        .join(""),
  );
}
function radar(labels: string[], values: number[]) {
  if (labels.length < 3) return bar(labels, values);
  const point = (r: number, i: number) =>
    `${240 + r * Math.cos((i * 2 * Math.PI) / labels.length - Math.PI / 2)},${165 + r * Math.sin((i * 2 * Math.PI) / labels.length - Math.PI / 2)}`;
  return svgUri(
    [1, 2, 3, 4, 5]
      .map(
        (n) =>
          `<polygon points="${labels.map((_, i) => point(n * 24, i)).join(" ")}" fill="none" stroke="#E3E0F5"/>`,
      )
      .join("") +
      labels
        .map(
          (label, i) =>
            `<line x1="240" y1="165" x2="${point(120, i).split(",")[0]}" y2="${point(120, i).split(",")[1]}" stroke="#E3E0F5"/><text x="${point(145, i).split(",")[0]}" y="${point(145, i).split(",")[1]}" text-anchor="middle">${escapeHtml(label.slice(0, 16))}</text>`,
        )
        .join("") +
      `<polygon points="${values.map((v, i) => point(v * 24, i)).join(" ")}" fill="#8b7ce8" fill-opacity=".25" stroke="#2b2d6e" stroke-width="2.5"/>`,
  );
}
export function compileFeedback(
  repo: Repository,
  cycleId: number,
  memberId: number,
): Row {
  const cycle = repo.require("cycles", cycleId),
    member = repo.require("members", memberId);
  const total = repo.one(
    "SELECT count(*) n FROM assignments WHERE cycle_id=? AND reviewee_id=? AND is_submitted=1",
    cycleId,
    memberId,
  )!.n;
  // Report DTO intentionally contains neither authors nor assignment records.
  const context: Row = {
    cycle: { title: cycle.title, id: cycle.id, version: cycle.version },
    reviewee: { name: member.name, department: member.department },
    total_feedback_received: total,
    total_reviewer_count: total,
    questions_data: [],
  };
  const categories = new Map<string, number[]>();
  const byQuestion = new Map<number, Row[]>();
  for (const answer of repo.all(
    "SELECT a.* FROM answers a JOIN assignments s ON s.id=a.assignment_id WHERE s.cycle_id=? AND s.reviewee_id=? AND s.is_submitted=1 AND a.is_excluded_from_report=0",
    cycleId,
    memberId,
  )) {
    const values = byQuestion.get(answer.question_id) ?? [];
    values.push(answer);
    byQuestion.set(answer.question_id, values);
  }
  const optionCounts = new Map(
    repo
      .all(
        "SELECT ao.option_id,count(*) n FROM answer_options ao JOIN answers a ON a.id=ao.answer_id JOIN assignments s ON s.id=a.assignment_id WHERE s.cycle_id=? AND s.reviewee_id=? AND s.is_submitted=1 AND a.is_excluded_from_report=0 GROUP BY ao.option_id",
        cycleId,
        memberId,
      )
      .map((row) => [row.option_id, row.n]),
  );
  for (const [index, q] of repo.questions(cycleId).entries()) {
    const answers = byQuestion.get(q.id) ?? [];
    const data: Row = {
      order: q.order,
      content: q.content,
      category: q.category || "기본 역량",
      question_type: q.question_type,
      image_url: repo.platform?.reportAssets
        ? (repo.platform.reportAssets.images.get(
            q.image?.url.slice("/media/".length) ?? "",
          ) ?? "")
        : imageData(q.image?.url.slice("/media/".length) ?? null),
      avg_rating: 0,
      avg_rating_label: "0.0점",
      rating_percent: 0,
      min_rating: 0,
      max_rating: 0,
      text_answers: [],
      options_summary: [],
      selected_options: [],
      pie_chart_base64: "",
      bar_chart_base64: "",
    };
    if (q.question_type === "RATING") {
      const scores = answers
        .filter((a) => a.rating_value != null)
        .map((a) => a.rating_value as number);
      if (scores.length) {
        const avg =
          Math.round(
            (scores.reduce((a, b) => a + b, 0) / scores.length) * 100,
          ) / 100;
        Object.assign(data, {
          avg_rating: avg,
          avg_rating_label: `${avg.toFixed(1)}점 / 5.0점`,
          rating_percent: Math.floor((avg / 5) * 100),
          min_rating: Math.min(...scores),
          max_rating: Math.max(...scores),
        });
        categories.set(data.category, [
          ...(categories.get(data.category) ?? []),
          ...scores,
        ]);
      }
    } else if (q.question_type === "TEXT")
      data.text_answers = answers
        .map((a) => a.answer_text?.trim())
        .filter(Boolean)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    else {
      data.options_summary = q.options.map((o: Row) => {
        const count = optionCounts.get(o.id) ?? 0;
        return {
          text: o.option_text,
          count,
          percentage: total ? Math.floor((count / total) * 100) : 0,
        };
      });
      data.selected_options = data.options_summary
        .filter((o: Row) => o.count)
        .map((o: Row) => o.text);
      const nonzero = data.options_summary.filter((o: Row) => o.count);
      data.pie_chart_base64 = pie(
        nonzero.map((o: Row) => o.text),
        nonzero.map((o: Row) => o.count),
      );
      data.bar_chart_base64 = bar(
        data.options_summary.map((o: Row) => o.text),
        data.options_summary.map((o: Row) => o.percentage),
        100,
      );
    }
    context.questions_data.push(data);
    for (const key of new Set([index + 1, q.order]))
      for (const [field, value] of Object.entries(data))
        context[`q_${key}_${field}`] = value;
  }
  context.category_summary = [...categories].map(([name, scores]) => {
    const avg =
      Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) /
      100;
    return {
      name,
      avg,
      pct: Math.floor((avg / 5) * 100),
      count: scores.length,
    };
  });
  const labels = context.category_summary.map((c: Row) => c.name),
    values = context.category_summary.map((c: Row) => c.avg);
  Object.assign(context, {
    radar_chart_base64: labels.length ? radar(labels, values) : "",
    pie_chart_base64: pie(labels, values),
    bar_chart_base64: bar(labels, values),
  });
  context.question_pages = paginateQuestions(context.questions_data);
  context.report_keywords = [
    ...new Set(context.questions_data.flatMap((q: Row) => q.selected_options)),
  ].slice(0, 6);
  // Keep custom templates with an explicit truetype format compatible.
  context.font_format = cycle.use_custom_template ? "truetype" : "woff2";
  context.font_path =
    repo.platform?.reportAssets?.fonts[
      cycle.use_custom_template ? "ttf" : "woff2"
    ] ?? fontData(cycle.use_custom_template ? "ttf" : "woff2");
  return context;
}
export function renderReport(repo: Repository, cycle: number, member: number) {
  const c = repo.require("cycles", cycle),
    context = compileFeedback(repo, cycle, member);
  const rendered =
    c.use_custom_template && c.custom_template
      ? renderCustom(c.custom_template, context)
      : templates.render("reports/peer_review_report.html", context);
  const css = `<style data-report-print>${reportPrintStyle}</style>`;
  const html = /<\/head>/i.test(rendered)
    ? rendered.replace(/<\/head>/i, css + "</head>")
    : rendered + css;
  return { html, context, version: c.version };
}
export function generateReport(
  repo: Repository,
  cycle: number,
  member: number,
) {
  const rendered = renderReport(repo, cycle, member);
  commitReport(
    repo,
    cycle,
    member,
    rendered.html,
    rendered.context,
    rendered.version,
  );
}
export function commitReport(
  repo: Repository,
  cycle: number,
  member: number,
  html: string,
  context: Row,
  version: string,
) {
  const contentHash = hashReport(html);
  repo.transaction(() => {
    const previous = repo.one(
      "SELECT * FROM reports WHERE cycle_id=? AND reviewee_id=?",
      cycle,
      member,
    );
    if (
      previous?.html === html ||
      (html.startsWith("r2:reports/") &&
        previous?.html &&
        previous.content_hash === contentHash)
    ) {
      if (previous.pdf_status !== "READY")
        enqueue(
          repo,
          "PDF",
          { report_id: previous.id, html_hash: contentHash },
          `pdf:${previous.id}:${crypto.randomUUID()}`,
        );
      return;
    }
    if (
      repo.one(
        "SELECT j.id FROM jobs j WHERE j.kind='REPORT' AND j.status IN ('PENDING','RUNNING','UNKNOWN') AND json_extract(j.payload,'$.cycle_id')=? AND json_extract(j.payload,'$.member_id')=?",
        cycle,
        member,
      )
    )
      throw new DomainError(
        "발송 처리 중이거나 확인이 필요한 결과지는 재생성할 수 없습니다.",
      );
    const issues = context.questions_data.flatMap((q: Row) =>
      q.text_answers
        .filter((t: string) => t.length >= 300 || t.split("\n").length > 10)
        .map(() => `Q${q.order} 긴 답변의 레이아웃을 확인해 주세요.`),
    );
    const revision = previous ? previous.revision + 1 : 1;
    repo.run(
      "INSERT INTO reports(cycle_id,reviewee_id,html,version,revision,content_hash,layout_check_passed,layout_issue_notes,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(cycle_id,reviewee_id) DO UPDATE SET html=excluded.html,pdf=NULL,pdf_status='PENDING',version=excluded.version,revision=excluded.revision,content_hash=excluded.content_hash,approved_hash=NULL,validation_status='NEEDS_REVIEW',is_sent=0,sent_at=NULL,error_log='',layout_check_passed=excluded.layout_check_passed,layout_issue_notes=excluded.layout_issue_notes",
      cycle,
      member,
      html,
      version,
      revision,
      contentHash,
      issues.length ? 0 : 1,
      issues.join(" | "),
      now(),
    );
    const report = repo.one(
      "SELECT id FROM reports WHERE cycle_id=? AND reviewee_id=?",
      cycle,
      member,
    )!;
    // Failed deliveries for replaced content must never send a newer file under an old approval.
    repo.run(
      "UPDATE jobs SET status='DONE',error='새 생성물로 대체된 발송 작업' WHERE kind='REPORT' AND status='FAILED' AND json_extract(payload,'$.report_id')=?",
      report.id,
    );
    enqueue(
      repo,
      "PDF",
      { report_id: report.id, html_hash: contentHash },
      `pdf:${report.id}:${crypto.randomUUID()}`,
    );
  });
}
export function checkLayouts(repo: Repository, cycle: number) {
  let passed = 0;
  for (const report of repo.all(
    "SELECT id,reviewee_id FROM reports WHERE cycle_id=?",
    cycle,
  )) {
    const data = compileFeedback(repo, cycle, report.reviewee_id);
    const issues: string[] = [];
    for (const q of data.questions_data) {
      if (
        q.text_answers.some(
          (t: string) => [...t].length >= 300 || t.split("\n").length > 10,
        )
      )
        issues.push(`Q${q.order} 긴 서술형 답변의 레이아웃을 확인해 주세요.`);
      if (q.options_summary.length >= 8)
        issues.push(`Q${q.order} 선택지가 많아 레이아웃 확인이 필요합니다.`);
    }
    repo.run(
      "UPDATE reports SET layout_check_passed=?,layout_issue_notes=? WHERE id=?",
      issues.length ? 0 : 1,
      issues.join(" | "),
      report.id,
    );
    if (!issues.length) passed++;
  }
  return passed;
}
export function generateAll(repo: Repository, cycle: number, sample = false) {
  repo.require("cycles", cycle);
  const targets = repo.all(
    `SELECT DISTINCT reviewee_id FROM assignments WHERE cycle_id=? ORDER BY reviewee_id ${sample ? "LIMIT 3" : ""}`,
    cycle,
  );
  const failures: string[] = [];
  for (const m of targets) {
    try {
      generateReport(repo, cycle, m.reviewee_id);
    } catch (e) {
      const message = e instanceof Error ? e.message : "결과지 생성 실패";
      failures.push(message);
      repo.run(
        "INSERT INTO reports(cycle_id,reviewee_id,validation_status,error_log,created_at) VALUES (?,?,'FAILED',?,?) ON CONFLICT(cycle_id,reviewee_id) DO UPDATE SET validation_status=CASE WHEN reports.html IS NULL THEN 'FAILED' ELSE reports.validation_status END,error_log=excluded.error_log",
        cycle,
        m.reviewee_id,
        message,
        now(),
      );
    }
  }
  if (failures.length)
    throw new DomainError(
      `${failures.length}건의 결과지 생성 실패: ${failures[0]}`,
    );
}
export function publish(repo: Repository, cycle: number) {
  repo.transaction(() => {
    const c = repo.cycle(cycle);
    if (c.status !== "COMPLETED")
      throw new DomainError("마감된 회차만 발송할 수 있습니다.");
    const reports = repo.all("SELECT * FROM reports WHERE cycle_id=?", cycle);
    const targets = repo.one(
      "SELECT count(DISTINCT reviewee_id) n FROM assignments WHERE cycle_id=?",
      cycle,
    )!.n;
    if (
      !reports.length ||
      reports.length !== targets ||
      reports.some(
        (r) =>
          !r.html ||
          r.pdf_status !== "READY" ||
          !r.pdf ||
          r.validation_status === "FAILED",
      )
    )
      throw new DomainError(
        "전체 HTML·PDF 결과지 생성을 완료하고 오류를 확인해 주세요.",
      );
    for (const r of reports) {
      if (r.is_sent) continue;
      repo.run(
        "UPDATE reports SET validation_status='APPROVED',approved_hash=? WHERE id=?",
        hashReport(r.html),
        r.id,
      );
      enqueue(
        repo,
        "REPORT",
        {
          report_id: r.id,
          member_id: r.reviewee_id,
          cycle_id: cycle,
          type: "REPORT",
          revision: r.revision,
          html_hash: hashReport(r.html),
        },
        `report:${r.id}:${r.revision}`,
      );
    }
    repo.log(cycle, "결과지 검토 완료 및 발송 요청");
  });
}
export function hashReport(s: string) {
  const reference = s.match(
    /^r2:reports\/([a-f0-9]{64})(?:-[a-f0-9-]{36})?\.html$/,
  );
  if (reference) return reference[1];
  return createHash("sha256").update(s).digest("hex");
}
export function reportRows(repo: Repository, cycle: number) {
  const labels: Row = {
    NEEDS_REVIEW: "검토 필요",
    APPROVED: "승인 완료",
    SENT: "발송 완료",
    FAILED: "생성 실패",
  };
  return repo
    .all(
      "SELECT id,cycle_id,reviewee_id,version,validation_status,admin_memo,layout_check_passed,layout_issue_notes,error_log,is_sent,sent_at,created_at,pdf_status,html IS NOT NULL has_html FROM reports WHERE cycle_id=? ORDER BY reviewee_id",
      cycle,
    )
    .map((r) => ({
      ...r,
      report_id: r.id,
      reviewee: repo.require("members", r.reviewee_id),
      html_file: r.has_html
        ? { url: `/admin-panel/reports/${r.id}/preview-html/` }
        : null,
      pdf_file:
        r.pdf_status === "READY"
          ? { url: `/admin-panel/reports/${r.id}/pdf/` }
          : null,
      validation_status: labels[r.validation_status],
      preview_data: compileFeedback(repo, cycle, r.reviewee_id),
    }));
}

export function invalidateReports(repo: Repository, cycle: number) {
  if (repo.require("cycles", cycle).status === "CLOSED")
    throw new DomainError("배포가 종료된 결과지는 변경할 수 없습니다.");
  if (
    repo.one(
      "SELECT id FROM jobs WHERE kind='REPORT' AND status IN ('PENDING','RUNNING','UNKNOWN') AND json_extract(payload,'$.cycle_id')=?",
      cycle,
    )
  )
    throw new DomainError(
      "결과지 발송 중에는 답변 제외 상태를 변경할 수 없습니다.",
    );
  repo.run(
    "UPDATE reports SET validation_status='NEEDS_REVIEW',html=NULL,pdf=NULL,pdf_status='PENDING',approved_hash=NULL,is_sent=0 WHERE cycle_id=?",
    cycle,
  );
}
