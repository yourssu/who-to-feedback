import nunjucks from "nunjucks";
import { resolve } from "node:path";
import type { Row } from "./db";
export const routes = {
  admin_resolve_delivery: "/admin-panel/messages/jobs/:job_id/resolve/",
  admin_report_pdf: "/admin-panel/reports/:report_id/pdf/",
  health_check: "/health/",
  setup_wizard: "/setup/",
  login: "/login/",
  logout: "/logout/",
  review_dashboard: "/",
  review_form: "/review/:assignment_id/",
  save_draft: "/review/:assignment_id/save-draft/",
  admin_dashboard: "/admin-panel/",
  admin_create_cycle: "/admin-panel/cycles/create/",
  admin_update_reviewer_notice: "/admin-panel/cycles/:cycle_id/update-notice/",
  admin_cycle_history: "/admin-panel/cycles/:cycle_id/history/",
  admin_members: "/admin-panel/members/",
  admin_add_member: "/admin-panel/members/add/",
  admin_import_members_csv: "/admin-panel/members/import-csv/",
  admin_delete_member: "/admin-panel/members/:member_id/delete/",
  admin_validation: "/admin-panel/validation/",
  admin_validation_detail: "/admin-panel/cycles/:cycle_id/validation/",
  admin_apply_normalization: "/admin-panel/validation/normalize/",
  admin_toggle_answer_exclusion:
    "/admin-panel/validation/answers/:answer_id/toggle-exclusion/",
  admin_questions: "/admin-panel/cycles/:cycle_id/questions/",
  admin_add_question: "/admin-panel/cycles/:cycle_id/questions/add/",
  admin_delete_question: "/admin-panel/questions/:question_id/delete/",
  admin_add_option: "/admin-panel/questions/:question_id/options/add/",
  admin_delete_option: "/admin-panel/options/:option_id/delete/",
  admin_assignments: "/admin-panel/cycles/:cycle_id/assignments/",
  admin_add_assignment: "/admin-panel/cycles/:cycle_id/assignments/add/",
  admin_delete_assignment: "/admin-panel/assignments/:assignment_id/delete/",
  admin_auto_match: "/admin-panel/cycles/:cycle_id/assignments/auto-match/",
  admin_status: "/admin-panel/status/",
  admin_status_detail: "/admin-panel/cycles/:cycle_id/status/",
  admin_start_cycle_action: "/admin-panel/cycles/:cycle_id/start/",
  admin_close_cycle_action: "/admin-panel/cycles/:cycle_id/close/",
  admin_send_reminder_action: "/admin-panel/cycles/:cycle_id/reminder/",
  admin_generate_reports_action:
    "/admin-panel/cycles/:cycle_id/generate-reports/",
  admin_reports: "/admin-panel/cycles/:cycle_id/reports/",
  admin_save_report_memo: "/admin-panel/reports/:report_id/memo/",
  admin_generate_sample_reports:
    "/admin-panel/cycles/:cycle_id/sample-reports/",
  admin_run_layout_check: "/admin-panel/cycles/:cycle_id/layout-check/",
  admin_preview_report_html: "/admin-panel/reports/:report_id/preview-html/",
  admin_regenerate_report: "/admin-panel/reports/:report_id/regenerate/",
  admin_publish_reports_action: "/admin-panel/cycles/:cycle_id/publish/",
  admin_send_message: "/admin-panel/messages/send/",
  admin_delivery_checklist: "/admin-panel/cycles/:cycle_id/checklist/",
  admin_retry_failed_messages: "/admin-panel/messages/retry-failed/",
  admin_send_test_dm: "/admin-panel/messages/send-test/",
  admin_upload_custom_template:
    "/admin-panel/cycles/:cycle_id/upload-template/",
  admin_toggle_custom_template:
    "/admin-panel/cycles/:cycle_id/toggle-template/",
};
export type RouteName = keyof typeof routes;
export function url(name: RouteName, args: Row = {}) {
  if (!routes[name]) throw new Error(`Unknown route: ${name}`);
  return routes[name].replace(/:(\w+)/g, (_, k) => {
    if (args[k] == null) throw new Error(`Missing route parameter: ${k}`);
    return encodeURIComponent(args[k]);
  });
}
export function formatDate(input: string | null, format: string) {
  if (!input) return "";
  const d = new Date(input);
  if (!Number.isFinite(d.getTime())) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return format.replace(
    /[YmdHi]/g,
    (k) =>
      ({
        Y: parts.year,
        m: parts.month,
        d: parts.day,
        H: parts.hour,
        i: parts.minute,
      })[k as "Y"] ?? k,
  );
}
export const templates = new nunjucks.Environment(
  new nunjucks.FileSystemLoader(resolve("core/templates"), {
    noCache: process.env.NODE_ENV !== "production",
  }),
  { autoescape: true },
);
templates.addGlobal("url", url);
templates.addFilter("fallback", (value, other) => value || other);
templates.addFilter("date", formatDate);
templates.addFilter("truncatechars", (value, n) => {
  const chars = [...String(value ?? "")];
  return chars.length > n
    ? chars.slice(0, n - 1).join("") + "…"
    : chars.join("");
});
templates.addFilter("add", (value, n) => Number(value) + Number(n));
templates.addFilter("stringformat", (value, fmt) =>
  fmt === "02d" ? String(value).padStart(2, "0") : String(value),
);
templates.addFilter("slice", (value, range) => {
  const [start, end] = String(range).split(":");
  return String(value).slice(Number(start) || 0, end ? Number(end) : undefined);
});
templates.addFilter("groupbyMember", (values: Row[]) => {
  const groups = new Map<
    number,
    {
      grouper: Row;
      list: Row[];
    }
  >();
  for (const a of [...values].sort((a, b) =>
    a.reviewer.name.localeCompare(b.reviewer.name, "ko"),
  )) {
    if (!groups.has(a.reviewer.id))
      groups.set(a.reviewer.id, { grouper: a.reviewer, list: [] });
    groups.get(a.reviewer.id)!.list.push(a);
  }
  return [...groups.values()];
});
templates.addFilter(
  "linebreaksbr",
  (value) =>
    new nunjucks.runtime.SafeString(
      escapeHtml(String(value ?? "")).replace(/\n/g, "<br>"),
    ),
);
export function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
// Uploaded templates are deliberately limited to data interpolation and simple loops/conditions.
// Never expose Nunjucks calls, includes, imports, prototype access, or arbitrary filters.
export function validateCustomTemplate(source: string) {
  if (Buffer.byteLength(source) > 1024 * 1024)
    throw new Error("HTML 양식은 최대 1MB입니다.");
  for (const match of source.matchAll(/({{[\s\S]*?}}|{%[\s\S]*?%})/g)) {
    const expression = match[0].slice(2, -2).trim();
    if (
      /[()[\]{};`\\]|__|\b(?:constructor|prototype|attr|safe|range|cycler|joiner|self|super)\b/.test(
        expression,
      )
    )
      throw new Error("지원하지 않는 템플릿 표현식입니다.");
    if (
      match[0].startsWith("{%") &&
      !/^(?:for\s+\w+\s+in\s+[\w.]+|endfor|if\s+(?:not\s+)?[\w.]+|else|endif)$/.test(
        expression,
      )
    )
      throw new Error("양식은 변수, 단순 if/for 문법만 지원합니다.");
    if (match[0].startsWith("{{") && !/^[\w.]+$/.test(expression))
      throw new Error("변수 표현식만 지원합니다.");
  }
  const compiled = nunjucks.compile(
    source,
    new nunjucks.Environment(null, { autoescape: true }),
  );
  compiled.render({});
}
export function renderCustom(source: string, context: Row) {
  validateCustomTemplate(source);
  return new nunjucks.Environment(null, { autoescape: true }).renderString(
    source,
    context,
  );
}
