export type CycleStatus = "DRAFT" | "ACTIVE" | "COMPLETED" | "CLOSED";
export type QuestionType =
  "RATING" | "TEXT" | "SINGLE_CHOICE" | "MULTIPLE_CHOICE";
export interface Member {
  id: number;
  name: string;
  email: string;
  slack_user_id: string;
  department: string;
  normalized_name: string;
  created_at: string;
}
export interface Option {
  id: number;
  question_id: number;
  option_text: string;
  order: number;
}
export interface Question {
  id: number;
  cycle_id: number;
  order: number;
  question_type: QuestionType;
  scale_type: "NUMERIC_5" | "TEXT_5";
  category: string;
  content: string;
  image: {
    url: string;
  } | null;
  options: Option[];
  get_question_type_display: string;
  get_scale_type_display: string;
}
export interface Assignment {
  id: number;
  cycle_id: number;
  reviewer_id: number;
  reviewee_id: number;
  is_submitted: boolean;
  submitted_at: string | null;
  last_reminded_at: string | null;
  draft_data: Record<string, string | string[]>;
  draft_saved_at: string | null;
  reviewer: Member;
  reviewee: Member;
}
export interface CycleRecord {
  id: number;
  title: string;
  start_at: string | null;
  end_at: string | null;
  status: CycleStatus;
  version: string;
  reviewer_notice_message: string;
  custom_template: string | null;
  custom_template_name: string | null;
  use_custom_template: number;
  created_at: string;
}
export interface CycleView extends CycleRecord {
  questions: Question[];
  reports: {
    id: number;
  }[];
  total_assignments_count: number;
  submitted_assignments_count: number;
  completion_rate: number;
  is_all_submitted: boolean;
  is_question_locked: boolean;
  is_deadline_passed: boolean;
  get_status_display: string;
  custom_html_file: {
    name: string | null;
  } | null;
}
export interface ReportRecord {
  id: number;
  cycle_id: number;
  reviewee_id: number;
  html: string | null;
  pdf: Uint8Array | null;
  pdf_status: "PENDING" | "READY" | "FAILED";
  version: string;
  revision: number;
  content_hash: string;
  approved_hash: string | null;
  validation_status: "NEEDS_REVIEW" | "APPROVED" | "SENT" | "FAILED";
  admin_memo: string;
  layout_check_passed: number;
  layout_issue_notes: string;
  error_log: string;
  is_sent: number;
  sent_at: string | null;
  created_at: string;
}
export type JobKind = "GENERATE" | "PDF" | "DM" | "REPORT";
export type JobStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED" | "UNKNOWN";
export interface JobRecord {
  id: number;
  kind: JobKind;
  payload: string;
  dedupe_key: string;
  status: JobStatus;
  attempts: number;
  error: string;
  available_at: number;
  created_at: string;
  resolved_at: string | null;
  resolution: "SENT" | "NOT_SENT" | null;
}
export interface DmPayload {
  member_id: number;
  cycle_id?: number;
  type: "AUTH_CODE" | "REMINDER" | "CUSTOM_MSG" | "TEST_DM";
  text: string;
}
export interface ReportPayload {
  member_id: number;
  cycle_id: number;
  type: "REPORT";
  report_id: number;
  revision: number;
  html_hash: string;
}
export interface JobPayloads {
  GENERATE: {
    cycle_id: number;
    member_id?: number;
    sample?: boolean;
  };
  PDF: {
    report_id: number;
    html_hash: string;
  };
  DM: DmPayload;
  REPORT: ReportPayload;
}
export type DeliveryPayload = DmPayload | ReportPayload;
