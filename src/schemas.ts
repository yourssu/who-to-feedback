import {
  ApiError,
  type CycleStatus,
  type DeliveryStatus,
  type DeliveryType,
  type QuestionAnswerItem,
  type QuestionType,
  type ScaleType,
} from "./types.ts";

function fail(field: string, reason: string): never {
  throw new ApiError(400, "VALIDATION_ERROR", reason, [{ field, reason }]);
}

function assertPlainObject(
  input: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("body", "요청 본문은 JSON 객체여야 합니다.");
  }
  const obj = input as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      fail(key, `허용되지 않는 필드입니다: ${key}`);
    }
  }
  return obj;
}

function requireString(
  obj: Record<string, unknown>,
  field: string,
  minLen: number,
  maxLen: number,
  trim = true,
): string {
  const raw = obj[field];
  if (typeof raw !== "string") {
    fail(field, `${field} 필드는 문자열이어야 합니다.`);
  }
  const value = trim ? raw.trim() : raw;
  const charLen = [...value].length;
  if (charLen < minLen || charLen > maxLen) {
    fail(
      field,
      `${field} 길이는 ${minLen}~${maxLen}자 사이여야 합니다.`,
    );
  }
  return value;
}

function optionalString(
  obj: Record<string, unknown>,
  field: string,
  maxLen: number,
  defaultValue?: string,
  minLen = 0,
): string | undefined {
  const raw = obj[field];
  if (raw === undefined) return defaultValue;
  if (typeof raw !== "string") {
    fail(field, `${field} 필드는 문자열이어야 합니다.`);
  }
  const value = raw.trim();
  const charLen = [...value].length;
  if (charLen < minLen || charLen > maxLen) {
    fail(field, `${field} 길이는 최대 ${maxLen}자여야 합니다.`);
  }
  return value;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireEmail(obj: Record<string, unknown>, field: string): string {
  const value = requireString(obj, field, 3, 254, true);
  if (!EMAIL_REGEX.test(value)) {
    fail(field, "유효한 이메일 주소를 입력해 주세요.");
  }
  return value;
}

function requireIsoDateTime(
  obj: Record<string, unknown>,
  field: string,
): string {
  const raw = requireString(obj, field, 1, 64, true);
  const normalized =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw)
      ? `${raw}+09:00`
      : raw;
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) {
    fail(field, "유효한 ISO-8601 일시 형식이어야 합니다.");
  }
  return new Date(ms).toISOString();
}

function requirePositiveInt(
  value: unknown,
  field: string,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
  if (!Number.isSafeInteger(num) || num < min || num > max) {
    fail(field, `${field} 값은 ${min}~${max} 사이의 정수여야 합니다.`);
  }
  return num;
}

export function parsePathId(raw: string | undefined, name: string): number {
  return requirePositiveInt(raw, name, 1);
}

export function validateInitialAdminSetup(input: unknown): {
  username: string;
  email: string;
  password: string;
} {
  const obj = assertPlainObject(input, ["username", "email", "password"]);
  return {
    username: requireString(obj, "username", 1, 50, true),
    email: requireEmail(obj, "email"),
    password: requireString(obj, "password", 8, 200, false),
  };
}

export function validateAdminLogin(input: unknown): {
  username: string;
  password: string;
} {
  const obj = assertPlainObject(input, ["username", "password"]);
  return {
    username: requireString(obj, "username", 1, 50, true),
    password: requireString(obj, "password", 1, 200, false),
  };
}

export function validateReviewerPinLogin(input: unknown): { pin_code: string } {
  const obj = assertPlainObject(input, ["pin_code"]);
  const pin_code = requireString(obj, "pin_code", 6, 6, true);
  if (!/^[0-9]{6}$/.test(pin_code)) {
    fail("pin_code", "6자리 숫자 PIN 코드를 입력해 주세요.");
  }
  return { pin_code };
}

export function validateCreateMember(input: unknown): {
  name: string;
  email: string;
  department: string;
  slack_user_id: string;
} {
  const obj = assertPlainObject(input, [
    "name",
    "email",
    "department",
    "slack_user_id",
  ]);
  return {
    name: requireString(obj, "name", 1, 50, true),
    email: requireEmail(obj, "email"),
    department: optionalString(obj, "department", 100, "") ?? "",
    slack_user_id: optionalString(obj, "slack_user_id", 50, "") ?? "",
  };
}

export function validateCreateCycle(input: unknown): {
  title: string;
  start_at: string;
  end_at: string;
  reviewer_notice_message?: string;
} {
  const obj = assertPlainObject(input, [
    "title",
    "start_at",
    "end_at",
    "reviewer_notice_message",
  ]);
  const title = requireString(obj, "title", 1, 200, true);
  const start_at = requireIsoDateTime(obj, "start_at");
  const end_at = requireIsoDateTime(obj, "end_at");
  if (Date.parse(end_at) <= Date.parse(start_at)) {
    fail("end_at", "마감 일시는 시작 일시보다 이후여야 합니다.");
  }
  const reviewer_notice_message = optionalString(
    obj,
    "reviewer_notice_message",
    5000,
  );
  return { title, start_at, end_at, reviewer_notice_message };
}

export function validateUpdateCycle(input: unknown): {
  title?: string;
  start_at?: string;
  end_at?: string;
  reviewer_notice_message?: string;
} {
  const obj = assertPlainObject(input, [
    "title",
    "start_at",
    "end_at",
    "reviewer_notice_message",
  ]);
  const out: {
    title?: string;
    start_at?: string;
    end_at?: string;
    reviewer_notice_message?: string;
  } = {};
  if (obj.title !== undefined) {
    out.title = requireString(obj, "title", 1, 200, true);
  }
  if (obj.start_at !== undefined) {
    out.start_at = requireIsoDateTime(obj, "start_at");
  }
  if (obj.end_at !== undefined) {
    out.end_at = requireIsoDateTime(obj, "end_at");
  }
  if (obj.reviewer_notice_message !== undefined) {
    out.reviewer_notice_message = optionalString(
      obj,
      "reviewer_notice_message",
      5000,
    );
  }
  return out;
}

export function validateCloseCycle(input: unknown): {
  require_all_submitted: boolean;
} {
  if (input === undefined || input === null || input === "") {
    return { require_all_submitted: false };
  }
  const obj = assertPlainObject(input, ["require_all_submitted"]);
  if (
    obj.require_all_submitted !== undefined &&
    typeof obj.require_all_submitted !== "boolean"
  ) {
    fail("require_all_submitted", "boolean 값이어야 합니다.");
  }
  return { require_all_submitted: Boolean(obj.require_all_submitted) };
}

const QUESTION_TYPES: readonly QuestionType[] = [
  "RATING",
  "TEXT",
  "SINGLE_CHOICE",
  "MULTIPLE_CHOICE",
];
const SCALE_TYPES: readonly ScaleType[] = ["NUMERIC_5", "TEXT_5"];

export function validateCreateQuestionFields(input: unknown): {
  display_order: number;
  question_type: QuestionType;
  scale_type: ScaleType;
  category: string;
  content: string;
} {
  const obj = assertPlainObject(input, [
    "display_order",
    "question_type",
    "scale_type",
    "category",
    "content",
  ]);
  const display_order = requirePositiveInt(
    obj.display_order,
    "display_order",
    1,
    1000,
  );
  const qType = obj.question_type;
  if (
    typeof qType !== "string" ||
    !QUESTION_TYPES.includes(qType as QuestionType)
  ) {
    fail("question_type", "유효하지 않은 문항 유형입니다.");
  }
  const sType = obj.scale_type ?? "NUMERIC_5";
  if (typeof sType !== "string" || !SCALE_TYPES.includes(sType as ScaleType)) {
    fail("scale_type", "유효하지 않은 척도 유형입니다.");
  }
  const category =
    optionalString(obj, "category", 100, "기본 역량", 1) ?? "기본 역량";
  const content = requireString(obj, "content", 1, 5000, true);
  return {
    display_order,
    question_type: qType as QuestionType,
    scale_type: sType as ScaleType,
    category,
    content,
  };
}

export function validateCreateQuestionOption(input: unknown): {
  option_text: string;
} {
  const obj = assertPlainObject(input, ["option_text"]);
  return {
    option_text: requireString(obj, "option_text", 1, 200, true),
  };
}

export function validateCreateAssignment(input: unknown): {
  reviewer_id: number;
  reviewee_id: number;
} {
  const obj = assertPlainObject(input, ["reviewer_id", "reviewee_id"]);
  const reviewer_id = requirePositiveInt(obj.reviewer_id, "reviewer_id", 1);
  const reviewee_id = requirePositiveInt(obj.reviewee_id, "reviewee_id", 1);
  if (reviewer_id === reviewee_id) {
    fail("reviewee_id", "자기 자신은 피평가자로 배정할 수 없습니다.");
  }
  return { reviewer_id, reviewee_id };
}

export function validateAutoMatchAssignments(input: unknown): {
  match_type: "ALL" | "SAME_DEPARTMENT";
} {
  const obj = assertPlainObject(input, ["match_type"]);
  if (obj.match_type !== "ALL" && obj.match_type !== "SAME_DEPARTMENT") {
    fail("match_type", "match_type은 ALL 또는 SAME_DEPARTMENT여야 합니다.");
  }
  return { match_type: obj.match_type };
}

export function validateReviewAnswersInput(input: unknown): {
  answers: QuestionAnswerItem[];
} {
  const obj = assertPlainObject(input, ["answers"]);
  if (!Array.isArray(obj.answers)) {
    fail("answers", "answers 필드는 배열이어야 합니다.");
  }
  const answers: QuestionAnswerItem[] = obj.answers.map((item, idx) => {
    const itemObj = assertPlainObject(item, [
      "question_id",
      "rating_value",
      "answer_text",
      "option_ids",
    ]);
    const question_id = requirePositiveInt(
      itemObj.question_id,
      `answers[${idx}].question_id`,
      1,
    );
    let rating_value: number | null | undefined = undefined;
    if (itemObj.rating_value !== undefined) {
      if (itemObj.rating_value === null) {
        rating_value = null;
      } else {
        rating_value = requirePositiveInt(
          itemObj.rating_value,
          `answers[${idx}].rating_value`,
          1,
          5,
        );
      }
    }
    let answer_text: string | null | undefined = undefined;
    if (itemObj.answer_text !== undefined) {
      if (itemObj.answer_text === null) {
        answer_text = null;
      } else if (typeof itemObj.answer_text === "string") {
        if ([...itemObj.answer_text].length > 2000) {
          fail(
            `answers[${idx}].answer_text`,
            "서술형 답변은 최대 2,000자까지 입력할 수 있습니다.",
          );
        }
        answer_text = itemObj.answer_text;
      } else {
        fail(`answers[${idx}].answer_text`, "문자열 또는 null이어야 합니다.");
      }
    }
    let option_ids: number[] | undefined = undefined;
    if (itemObj.option_ids !== undefined) {
      if (!Array.isArray(itemObj.option_ids)) {
        fail(`answers[${idx}].option_ids`, "선택지 ID 배열이어야 합니다.");
      }
      const parsedIds = itemObj.option_ids.map((idVal, optIdx) =>
        requirePositiveInt(
          idVal,
          `answers[${idx}].option_ids[${optIdx}]`,
          1,
        ),
      );
      if (new Set(parsedIds).size !== parsedIds.length) {
        fail(`answers[${idx}].option_ids`, "중복된 선택지 ID가 포함되어 있습니다.");
      }
      option_ids = parsedIds;
    }
    return { question_id, rating_value, answer_text, option_ids };
  });
  return { answers };
}

export function validateDeliveryQuery(url: URL): {
  status?: DeliveryStatus;
  delivery_type?: DeliveryType;
} {
  const status = url.searchParams.get("status") ?? undefined;
  const delivery_type = url.searchParams.get("delivery_type") ?? undefined;
  if (status && !["PENDING", "SENT", "FAILED"].includes(status)) {
    fail("status", "유효하지 않은 발송 상태 필터입니다.");
  }
  if (
    delivery_type &&
    !["PIN_ISSUE", "REMINDER", "REPORT"].includes(delivery_type)
  ) {
    fail("delivery_type", "유효하지 않은 발송 유형 필터입니다.");
  }
  return {
    status: status as DeliveryStatus | undefined,
    delivery_type: delivery_type as DeliveryType | undefined,
  };
}
