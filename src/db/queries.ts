import { nowIso, randomPinCode, sha256Hex } from "../crypto.ts";
import {
  ApiError,
  type AdminRecord,
  type AssignmentRecord,
  type AssignmentSummary,
  type CycleDetail,
  type CycleRecord,
  type DeliveryRecord,
  type DeliveryRow,
  type DeliveryStatus,
  type DeliveryType,
  type D1Database,
  type Env,
  type MemberRecord,
  type QuestionDto,
  type QuestionOptionRecord,
  type QuestionRecord,
  type ReportRecord,
  type ReportSummary,
  type SessionRecord,
} from "../types.ts";

export async function requireAdmin(
  db: D1Database,
  id: number,
): Promise<AdminRecord> {
  const row = await db
    .prepare("SELECT * FROM admins WHERE id = ?")
    .bind(id)
    .first<AdminRecord>();
  if (!row) {
    throw new ApiError(404, "NOT_FOUND", "관리자 계정을 찾을 수 없습니다.");
  }
  return row;
}

export async function requireMember(
  db: D1Database,
  id: number,
): Promise<MemberRecord> {
  const row = await db
    .prepare("SELECT * FROM members WHERE id = ?")
    .bind(id)
    .first<MemberRecord>();
  if (!row) {
    throw new ApiError(404, "NOT_FOUND", "팀원을 찾을 수 없습니다.");
  }
  return row;
}

export async function requireCycle(
  db: D1Database,
  id: number,
): Promise<CycleRecord> {
  const row = await db
    .prepare("SELECT * FROM cycles WHERE id = ?")
    .bind(id)
    .first<CycleRecord>();
  if (!row) {
    throw new ApiError(404, "NOT_FOUND", "회차를 찾을 수 없습니다.");
  }
  return row;
}

export async function requireQuestion(
  db: D1Database,
  id: number,
): Promise<QuestionRecord> {
  const row = await db
    .prepare("SELECT * FROM questions WHERE id = ?")
    .bind(id)
    .first<QuestionRecord>();
  if (!row) {
    throw new ApiError(404, "NOT_FOUND", "설문 문항을 찾을 수 없습니다.");
  }
  return row;
}

export async function requireOption(
  db: D1Database,
  id: number,
): Promise<QuestionOptionRecord> {
  const row = await db
    .prepare("SELECT * FROM question_options WHERE id = ?")
    .bind(id)
    .first<QuestionOptionRecord>();
  if (!row) {
    throw new ApiError(404, "NOT_FOUND", "선택지를 찾을 수 없습니다.");
  }
  return row;
}

export async function requireAssignment(
  db: D1Database,
  id: number,
): Promise<AssignmentRecord> {
  const row = await db
    .prepare("SELECT * FROM assignments WHERE id = ?")
    .bind(id)
    .first<AssignmentRecord>();
  if (!row) {
    throw new ApiError(404, "NOT_FOUND", "리뷰 매칭을 찾을 수 없습니다.");
  }
  return row;
}

export async function requireReport(
  db: D1Database,
  id: number,
): Promise<ReportRecord> {
  const row = await db
    .prepare("SELECT * FROM reports WHERE id = ?")
    .bind(id)
    .first<ReportRecord>();
  if (!row) {
    throw new ApiError(404, "NOT_FOUND", "리포트를 찾을 수 없습니다.");
  }
  return row;
}

export function isCycleDeadlinePassed(cycle: CycleRecord): boolean {
  if (cycle.status === "COMPLETED" || cycle.status === "CLOSED") return true;
  return Date.parse(cycle.end_at) <= Date.now();
}

export async function toCycleDetail(
  db: D1Database,
  cycle: CycleRecord,
): Promise<CycleDetail> {
  const stats = await db
    .prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(is_submitted), 0) AS submitted FROM assignments WHERE cycle_id = ?",
    )
    .bind(cycle.id)
    .first<{ total: number; submitted: number }>();
  const total = Number(stats?.total ?? 0);
  const submitted = Number(stats?.submitted ?? 0);
  const completion_rate = total > 0 ? Math.floor((submitted / total) * 100) : 0;
  return {
    ...cycle,
    total_assignments_count: total,
    submitted_assignments_count: submitted,
    completion_rate,
    is_all_submitted: total > 0 && submitted === total,
    is_deadline_passed: isCycleDeadlinePassed(cycle),
  };
}

export async function getCycleDetail(
  db: D1Database,
  cycleId: number,
): Promise<CycleDetail> {
  const cycle = await requireCycle(db, cycleId);
  return toCycleDetail(db, cycle);
}

export async function listAllMembers(db: D1Database): Promise<MemberRecord[]> {
  const res = await db
    .prepare("SELECT * FROM members ORDER BY name ASC, id ASC")
    .all<MemberRecord>();
  return res.results;
}

export async function listCycleQuestions(
  db: D1Database,
  cycleId: number,
): Promise<QuestionDto[]> {
  await requireCycle(db, cycleId);
  const questionsRes = await db
    .prepare(
      "SELECT * FROM questions WHERE cycle_id = ? ORDER BY display_order ASC, id ASC",
    )
    .bind(cycleId)
    .all<QuestionRecord>();
  const optionsRes = await db
    .prepare(
      `SELECT o.* FROM question_options o
       JOIN questions q ON q.id = o.question_id
       WHERE q.cycle_id = ?
       ORDER BY o.display_order ASC, o.id ASC`,
    )
    .bind(cycleId)
    .all<QuestionOptionRecord>();

  const optionsByQuestion = new Map<number, QuestionOptionRecord[]>();
  for (const opt of optionsRes.results) {
    const list = optionsByQuestion.get(opt.question_id) ?? [];
    list.push(opt);
    optionsByQuestion.set(opt.question_id, list);
  }

  return questionsRes.results.map((q) => ({
    id: q.id,
    cycle_id: q.cycle_id,
    display_order: q.display_order,
    question_type: q.question_type,
    scale_type: q.scale_type,
    category: q.category,
    content: q.content,
    image_url: q.image_r2_key ? `/api/media/questions/${q.id}/image` : null,
    options: optionsByQuestion.get(q.id) ?? [],
    created_at: q.created_at,
  }));
}

export async function listCycleAssignments(
  db: D1Database,
  cycleId: number,
  reviewerId?: number,
): Promise<AssignmentSummary[]> {
  await requireCycle(db, cycleId);
  const members = await listAllMembers(db);
  const memberMap = new Map<number, MemberRecord>(
    members.map((m) => [m.id, m]),
  );

  const assignmentRows =
    reviewerId !== undefined
      ? await db
          .prepare(
            "SELECT * FROM assignments WHERE cycle_id = ? AND reviewer_id = ? ORDER BY id ASC",
          )
          .bind(cycleId, reviewerId)
          .all<AssignmentRecord>()
      : await db
          .prepare(
            "SELECT * FROM assignments WHERE cycle_id = ? ORDER BY id ASC",
          )
          .bind(cycleId)
          .all<AssignmentRecord>();

  return assignmentRows.results.map((a) => ({
    id: a.id,
    cycle_id: a.cycle_id,
    reviewer: memberMap.get(a.reviewer_id)!,
    reviewee: memberMap.get(a.reviewee_id)!,
    is_submitted: Boolean(a.is_submitted),
    submitted_at: a.submitted_at,
    draft_saved_at: a.draft_saved_at,
    last_reminded_at: a.last_reminded_at,
    created_at: a.created_at,
  }));
}

export async function toAssignmentSummary(
  db: D1Database,
  a: AssignmentRecord,
): Promise<AssignmentSummary> {
  const [reviewer, reviewee] = await Promise.all([
    requireMember(db, a.reviewer_id),
    requireMember(db, a.reviewee_id),
  ]);
  return {
    id: a.id,
    cycle_id: a.cycle_id,
    reviewer,
    reviewee,
    is_submitted: Boolean(a.is_submitted),
    submitted_at: a.submitted_at,
    draft_saved_at: a.draft_saved_at,
    last_reminded_at: a.last_reminded_at,
    created_at: a.created_at,
  };
}

export async function toReportSummary(
  db: D1Database,
  r: ReportRecord,
): Promise<ReportSummary> {
  const reviewee = await requireMember(db, r.reviewee_id);
  const ready = r.generation_status === "READY";
  return {
    id: r.id,
    cycle_id: r.cycle_id,
    reviewee,
    revision: r.revision,
    generation_status: r.generation_status,
    approval_status: r.approval_status,
    html_url: ready && r.html_r2_key ? `/api/admin/reports/${r.id}/html` : null,
    pdf_url: ready && r.pdf_r2_key ? `/api/admin/reports/${r.id}/pdf` : null,
    error_message: r.error_message,
    sent_at: r.sent_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function listCycleReports(
  db: D1Database,
  cycleId: number,
): Promise<ReportSummary[]> {
  await requireCycle(db, cycleId);
  const members = await listAllMembers(db);
  const memberMap = new Map(members.map((m) => [m.id, m]));
  const rows = await db
    .prepare("SELECT * FROM reports WHERE cycle_id = ? ORDER BY reviewee_id ASC")
    .bind(cycleId)
    .all<ReportRecord>();

  return rows.results.map((r) => {
    const ready = r.generation_status === "READY";
    return {
      id: r.id,
      cycle_id: r.cycle_id,
      reviewee: memberMap.get(r.reviewee_id)!,
      revision: r.revision,
      generation_status: r.generation_status,
      approval_status: r.approval_status,
      html_url:
        ready && r.html_r2_key ? `/api/admin/reports/${r.id}/html` : null,
      pdf_url: ready && r.pdf_r2_key ? `/api/admin/reports/${r.id}/pdf` : null,
      error_message: r.error_message,
      sent_at: r.sent_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });
}

export async function listCycleDeliveries(
  db: D1Database,
  cycleId: number,
  filters?: { status?: DeliveryStatus; delivery_type?: DeliveryType },
): Promise<DeliveryRecord[]> {
  await requireCycle(db, cycleId);
  const members = await listAllMembers(db);
  const memberMap = new Map(members.map((m) => [m.id, m]));

  const conditions = ["cycle_id = ?"];
  const binds: unknown[] = [cycleId];
  if (filters?.status) {
    conditions.push("status = ?");
    binds.push(filters.status);
  }
  if (filters?.delivery_type) {
    conditions.push("delivery_type = ?");
    binds.push(filters.delivery_type);
  }
  const sql = `SELECT * FROM deliveries WHERE ${conditions.join(" AND ")} ORDER BY id DESC`;
  const rows = await db
    .prepare(sql)
    .bind(...binds)
    .all<DeliveryRow>();

  return rows.results.map((d) => ({
    id: d.id,
    cycle_id: d.cycle_id,
    member: memberMap.get(d.member_id)!,
    report_id: d.report_id,
    delivery_type: d.delivery_type,
    status: d.status,
    attempts: d.attempts,
    error_message: d.error_message,
    sent_at: d.sent_at,
    created_at: d.created_at,
    updated_at: d.updated_at,
  }));
}

export async function ensurePinAndEnqueueDelivery(
  env: Env,
  cycleId: number,
  memberId: number,
): Promise<{ pinCode: string; deliveryId: number | null }> {
  const existingPin = await env.DB.prepare(
    "SELECT code FROM pins WHERE cycle_id = ? AND member_id = ?",
  )
    .bind(cycleId, memberId)
    .first<{ code: string }>();

  let pinCode = existingPin?.code ?? "";
  if (!pinCode) {
    while (true) {
      const candidate = randomPinCode();
      const candidateHash = await sha256Hex(candidate);
      const conflict = await env.DB.prepare(
        "SELECT id FROM pins WHERE code_hash = ?",
      )
        .bind(candidateHash)
        .first<{ id: number }>();
      if (!conflict) {
        pinCode = candidate;
        await env.DB.prepare(
          "INSERT INTO pins (cycle_id, member_id, code, code_hash, created_at) VALUES (?, ?, ?, ?, ?)",
        )
          .bind(cycleId, memberId, pinCode, candidateHash, nowIso())
          .run();
        break;
      }
    }
  }

  const dedupeKey = `pin:${cycleId}:${memberId}`;
  const existingDelivery = await env.DB.prepare(
    "SELECT id FROM deliveries WHERE dedupe_key = ?",
  )
    .bind(dedupeKey)
    .first<{ id: number }>();

  if ((env.MOCK_SLACK_MODE ?? "true").toLowerCase() !== "false") {
    const member = await requireMember(env.DB, memberId);
    console.log(
      `[MOCK_SLACK_MODE][PIN_CODE] cycle_id=${cycleId} | reviewer="${member.name}" <${member.email}> | login_pin_code=${pinCode}`,
    );
  }

  if (existingDelivery) {
    return { pinCode, deliveryId: null };
  }

  const now = nowIso();
  const insertRes = await env.DB.prepare(
    `INSERT INTO deliveries (cycle_id, member_id, report_id, delivery_type, status, dedupe_key, attempts, error_message, created_at, updated_at)
     VALUES (?, ?, NULL, 'PIN_ISSUE', 'PENDING', ?, 0, '', ?, ?)`,
  )
    .bind(cycleId, memberId, dedupeKey, now, now)
    .run();

  const deliveryId = Number(insertRes.meta.last_row_id);
  await env.DELIVERY_QUEUE.send({
    job_type: "SEND_SLACK_DELIVERY",
    delivery_id: deliveryId,
  });
  return { pinCode, deliveryId };
}

export async function buildSessionResponse(
  db: D1Database,
  session: SessionRecord,
): Promise<{
  role: "ADMIN" | "REVIEWER";
  csrf_token: string;
  expires_at: string;
  admin: { id: number; username: string; email: string } | null;
  reviewer: {
    member_id: number;
    name: string;
    department: string;
    cycle_id: number;
    cycle_title: string;
  } | null;
}> {
  if (session.role === "ADMIN" && session.admin_id) {
    const admin = await requireAdmin(db, session.admin_id);
    return {
      role: "ADMIN",
      csrf_token: session.csrf_token,
      expires_at: new Date(session.expires_at).toISOString(),
      admin: {
        id: admin.id,
        username: admin.username,
        email: admin.email,
      },
      reviewer: null,
    };
  }
  if (session.role === "REVIEWER" && session.member_id && session.cycle_id) {
    const [member, cycle] = await Promise.all([
      requireMember(db, session.member_id),
      requireCycle(db, session.cycle_id),
    ]);
    return {
      role: "REVIEWER",
      csrf_token: session.csrf_token,
      expires_at: new Date(session.expires_at).toISOString(),
      admin: null,
      reviewer: {
        member_id: member.id,
        name: member.name,
        department: member.department,
        cycle_id: cycle.id,
        cycle_title: cycle.title,
      },
    };
  }
  throw new ApiError(401, "UNAUTHORIZED", "유효하지 않은 세션입니다.");
}
