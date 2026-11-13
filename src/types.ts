export type CycleStatus = "DRAFT" | "ACTIVE" | "COMPLETED" | "CLOSED";
export type QuestionType =
  | "RATING"
  | "TEXT"
  | "SINGLE_CHOICE"
  | "MULTIPLE_CHOICE";
export type ScaleType = "NUMERIC_5" | "TEXT_5";
export type GenerationStatus = "PENDING" | "READY" | "FAILED";
export type ApprovalStatus = "NEEDS_REVIEW" | "APPROVED" | "SENT";
export type DeliveryType = "PIN_ISSUE" | "REMINDER" | "REPORT";
export type DeliveryStatus = "PENDING" | "SENT" | "FAILED";
export type SessionRole = "ADMIN" | "REVIEWER";

export interface D1Meta {
  changes: number;
  last_row_id: number;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface R2ObjectBody {
  key: string;
  size: number;
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  body: ReadableStream<Uint8Array> | null;
}

export interface R2Bucket {
  put(
    key: string,
    value: string | Uint8Array | ArrayBuffer | ReadableStream,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(keys: string | string[]): Promise<void>;
}

export interface Queue<Body = unknown> {
  send(message: Body): Promise<void>;
}

export interface Message<Body = unknown> {
  readonly id: string;
  readonly body: Body;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface MessageBatch<Body = unknown> {
  readonly queue: string;
  readonly messages: readonly Message<Body>[];
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}

export interface ReportGenerationJobMessage {
  job_type: "GENERATE_REPORT";
  cycle_id: number;
  reviewee_id: number;
  report_id: number;
  revision: number;
}

export interface SlackDeliveryJobMessage {
  job_type: "SEND_SLACK_DELIVERY";
  delivery_id: number;
}

export type QueueMessage = ReportGenerationJobMessage | SlackDeliveryJobMessage;

export interface PdfRenderer {
  renderPdf(html: string, env: Env): Promise<Uint8Array>;
}

export interface SlackClient {
  sendDmText(params: {
    email: string;
    slackUserId: string;
    text: string;
    env: Env;
  }): Promise<{ resolvedSlackUserId?: string }>;
  sendReportFiles(params: {
    email: string;
    slackUserId: string;
    cycleId: number;
    cycleTitle: string;
    memberId: number;
    memberName: string;
    htmlBytes: Uint8Array;
    pdfBytes: Uint8Array;
    env: Env;
  }): Promise<{ resolvedSlackUserId?: string }>;
}

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  REPORT_QUEUE: Queue<ReportGenerationJobMessage>;
  DELIVERY_QUEUE: Queue<SlackDeliveryJobMessage>;
  BROWSER?: unknown;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  SITE_URL?: string;
  MOCK_SLACK_MODE?: string;
  SLACK_BOT_TOKEN?: string;
  PDF_RENDERER?: PdfRenderer;
  SLACK_CLIENT?: SlackClient;
}

export interface AdminRecord {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  created_at: string;
}

export interface MemberRecord {
  id: number;
  name: string;
  email: string;
  department: string;
  slack_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface CycleRecord {
  id: number;
  title: string;
  status: CycleStatus;
  start_at: string;
  end_at: string;
  reviewer_notice_message: string;
  created_at: string;
  updated_at: string;
}

export interface CycleDetail extends CycleRecord {
  total_assignments_count: number;
  submitted_assignments_count: number;
  completion_rate: number;
  is_all_submitted: boolean;
  is_deadline_passed: boolean;
}

export interface QuestionOptionRecord {
  id: number;
  question_id: number;
  display_order: number;
  option_text: string;
}

export interface QuestionRecord {
  id: number;
  cycle_id: number;
  display_order: number;
  question_type: QuestionType;
  scale_type: ScaleType;
  category: string;
  content: string;
  image_r2_key: string | null;
  created_at: string;
}

export interface QuestionDto {
  id: number;
  cycle_id: number;
  display_order: number;
  question_type: QuestionType;
  scale_type: ScaleType;
  category: string;
  content: string;
  image_url: string | null;
  options: QuestionOptionRecord[];
  created_at: string;
}

export interface AssignmentRecord {
  id: number;
  cycle_id: number;
  reviewer_id: number;
  reviewee_id: number;
  is_submitted: number;
  submitted_at: string | null;
  draft_data: string | null;
  draft_saved_at: string | null;
  last_reminded_at: string | null;
  created_at: string;
}

export interface AssignmentSummary {
  id: number;
  cycle_id: number;
  reviewer: MemberRecord;
  reviewee: MemberRecord;
  is_submitted: boolean;
  submitted_at: string | null;
  draft_saved_at: string | null;
  last_reminded_at: string | null;
  created_at: string;
}

export interface ReportRecord {
  id: number;
  cycle_id: number;
  reviewee_id: number;
  revision: number;
  generation_status: GenerationStatus;
  approval_status: ApprovalStatus;
  html_r2_key: string | null;
  pdf_r2_key: string | null;
  content_hash: string | null;
  approved_hash: string | null;
  error_message: string;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReportSummary {
  id: number;
  cycle_id: number;
  reviewee: MemberRecord;
  revision: number;
  generation_status: GenerationStatus;
  approval_status: ApprovalStatus;
  html_url: string | null;
  pdf_url: string | null;
  error_message: string;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryRow {
  id: number;
  cycle_id: number;
  member_id: number;
  report_id: number | null;
  delivery_type: DeliveryType;
  status: DeliveryStatus;
  dedupe_key: string;
  attempts: number;
  error_message: string;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryRecord {
  id: number;
  cycle_id: number;
  member: MemberRecord;
  report_id: number | null;
  delivery_type: DeliveryType;
  status: DeliveryStatus;
  attempts: number;
  error_message: string;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRecord {
  token_hash: string;
  role: SessionRole;
  admin_id: number | null;
  member_id: number | null;
  cycle_id: number | null;
  csrf_token: string;
  expires_at: number;
  created_at: string;
}

export interface QuestionAnswerItem {
  question_id: number;
  rating_value?: number | null;
  answer_text?: string | null;
  option_ids?: number[];
}

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "STATE_CONFLICT"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "CSV_VALIDATION_ERROR"
  | "INTERNAL_ERROR";

export class ApiError extends Error {
  status: number;
  code: ErrorCode;
  details?: { field: string; reason: string }[];

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: { field: string; reason: string }[],
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class CsvValidationError extends Error {
  rowIndex: number;
  reason: string;

  constructor(rowIndex: number, reason: string) {
    super(`${rowIndex}행 오류: ${reason}`);
    this.rowIndex = rowIndex;
    this.reason = reason;
  }
}
