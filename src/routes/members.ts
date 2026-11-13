import { nowIso, sha256Hex } from "../crypto.ts";
import { listAllMembers, requireMember } from "../db/queries.ts";
import {
  emptyResponse,
  jsonResponse,
  readJsonBody,
  type Router,
} from "../router.ts";
import { parsePathId, validateCreateMember } from "../schemas.ts";
import {
  ApiError,
  CsvValidationError,
  type D1PreparedStatement,
  type MemberRecord,
} from "../types.ts";

function parseCsvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      if (quoted && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (!quoted && field.length > 0) {
        throw new CsvValidationError(rows.length + 1, "잘못된 CSV 따옴표 형식입니다.");
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((cell) => cell.trim().length > 0)) {
        rows.push(row);
      }
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (quoted) {
    throw new CsvValidationError(rows.length + 1, "닫히지 않은 CSV 따옴표입니다.");
  }
  row.push(field);
  if (row.some((cell) => cell.trim().length > 0)) {
    rows.push(row);
  }
  return rows;
}

export function registerMembersRoutes(router: Router): void {
  router.get("/api/admin/members", async ({ env }) => {
    const items = await listAllMembers(env.DB);
    return jsonResponse({ items });
  });

  router.post("/api/admin/members", async ({ req, env }) => {
    const data = validateCreateMember(await readJsonBody(req));
    const existing = await env.DB.prepare(
      "SELECT id FROM members WHERE email = ?",
    )
      .bind(data.email)
      .first<{ id: number }>();

    if (existing) {
      throw new ApiError(
        409,
        "STATE_CONFLICT",
        "이미 동일한 이메일로 등록된 팀원이 존재합니다.",
      );
    }

    const now = nowIso();
    const res = await env.DB.prepare(
      `INSERT INTO members (name, email, department, slack_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        data.name,
        data.email,
        data.department,
        data.slack_user_id,
        now,
        now,
      )
      .run();

    const member = await requireMember(env.DB, Number(res.meta.last_row_id));
    return jsonResponse(member, 201);
  });

  router.post("/api/admin/members/import-csv", async ({ req, env }) => {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "multipart/form-data 형식으로 CSV 파일을 업로드해 주세요.",
      );
    }

    const formData = await req.formData();
    const file = formData.get("csv_file");
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".csv")) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "확장자가 .csv인 파일을 선택해 주세요.",
      );
    }
    if (file.size > 2 * 1024 * 1024) {
      throw new ApiError(
        413,
        "PAYLOAD_TOO_LARGE",
        "CSV 파일 크기는 최대 2MB입니다.",
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      decoded = new TextDecoder("euc-kr", { fatal: true }).decode(bytes);
    }

    const parsedRows = parseCsvRows(decoded.replace(/^\uFEFF/, ""));
    if (parsedRows.length < 2) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "CSV 파일에 헤더와 최소 1개 이상의 데이터 행이 필요합니다.",
      );
    }

    const [rawHeaders, ...dataRows] = parsedRows;
    if (dataRows.length > 10_000) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "CSV는 최대 10,000행까지 등록할 수 있습니다.",
      );
    }

    const headers = rawHeaders.map((h) => h.trim().toLowerCase());
    const findCol = (row: string[], candidates: string[]): string => {
      const idx = headers.findIndex((h) => candidates.includes(h));
      return idx >= 0 ? (row[idx]?.trim() ?? "") : "";
    };

    const existingMembers = await listAllMembers(env.DB);
    const existingEmails = new Set(
      existingMembers.map((m) => m.email.toLowerCase()),
    );
    const seenInCsv = new Set<string>();

    let created_count = 0;
    let updated_count = 0;
    const statements: D1PreparedStatement[] = [];
    const now = nowIso();

    for (let i = 0; i < dataRows.length; i++) {
      const rowIndex = i + 2;
      const row = dataRows[i];
      const name = findCol(row, [
        "name",
        "이름",
        "nickname",
        "닉네임",
        "닉네임(발음)",
      ]);
      if (!name) {
        throw new CsvValidationError(rowIndex, "이름(name) 값이 비어 있습니다.");
      }
      const rawEmail = findCol(row, ["email", "이메일"]);
      const email =
        rawEmail ||
        `${(await sha256Hex(name)).slice(0, 16)}-${i}@members.invalid`;

      let validated: {
        name: string;
        email: string;
        department: string;
        slack_user_id: string;
      };
      try {
        validated = validateCreateMember({
          name,
          email,
          department: findCol(row, [
            "department",
            "부서",
            "소속",
            "팀",
            "team",
            "역할",
            "role",
          ]),
          slack_user_id: findCol(row, ["slack_user_id", "slack_id", "slack"]),
        });
      } catch (err) {
        const reason =
          err instanceof ApiError
            ? err.message
            : "필수 컬럼 형식이 올바르지 않습니다.";
        throw new CsvValidationError(rowIndex, reason);
      }

      const emailLower = validated.email.toLowerCase();
      if (existingEmails.has(emailLower) || seenInCsv.has(emailLower)) {
        updated_count++;
      } else {
        created_count++;
        seenInCsv.add(emailLower);
      }

      statements.push(
        env.DB.prepare(
          `INSERT INTO members (name, email, department, slack_user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET
             name = excluded.name,
             department = excluded.department,
             slack_user_id = excluded.slack_user_id,
             updated_at = excluded.updated_at`,
        ).bind(
          validated.name,
          validated.email,
          validated.department,
          validated.slack_user_id,
          now,
          now,
        ),
      );
    }

    if (statements.length > 0) {
      await env.DB.batch(statements);
    }

    return jsonResponse({ created_count, updated_count }, 200);
  });

  router.delete("/api/admin/members/:memberId", async ({ params, env }) => {
    const memberId = parsePathId(params.memberId, "memberId");
    await requireMember(env.DB, memberId);

    const usedInAssignment = await env.DB.prepare(
      "SELECT id FROM assignments WHERE reviewer_id = ? OR reviewee_id = ? LIMIT 1",
    )
      .bind(memberId, memberId)
      .first<{ id: number }>();

    const usedInReport = await env.DB.prepare(
      "SELECT id FROM reports WHERE reviewee_id = ? LIMIT 1",
    )
      .bind(memberId)
      .first<{ id: number }>();

    if (usedInAssignment || usedInReport) {
      throw new ApiError(
        409,
        "STATE_CONFLICT",
        "리뷰 매칭 또는 리포트 이력이 존재하는 팀원은 삭제할 수 없습니다.",
      );
    }

    await env.DB.prepare("DELETE FROM members WHERE id = ?")
      .bind(memberId)
      .run();
    return emptyResponse(204);
  });
}
