import {
  hashPassword,
  nowIso,
  randomToken,
  sha256Hex,
  verifyPassword,
} from "../crypto.ts";
import { buildSessionResponse } from "../db/queries.ts";
import {
  emptyResponse,
  formatSessionCookie,
  jsonResponse,
  parseCookie,
  readJsonBody,
  type Router,
} from "../router.ts";
import {
  validateAdminLogin,
  validateInitialAdminSetup,
  validateReviewerPinLogin,
} from "../schemas.ts";
import {
  ApiError,
  type AdminRecord,
  type D1Database,
  type SessionRecord,
} from "../types.ts";

const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;

async function checkRateLimit(db: D1Database, attemptKey: string): Promise<void> {
  const row = await db
    .prepare("SELECT locked_until FROM login_attempts WHERE attempt_key = ?")
    .bind(attemptKey)
    .first<{ locked_until: number }>();
  if (row && row.locked_until > Date.now()) {
    throw new ApiError(
      429,
      "RATE_LIMITED",
      "로그인 시도가 너무 많습니다. 15분 후 다시 시도해 주세요.",
    );
  }
}

async function recordLoginFailure(
  db: D1Database,
  attemptKey: string,
): Promise<void> {
  const now = Date.now();
  const prev = await db
    .prepare(
      "SELECT failures, updated_at FROM login_attempts WHERE attempt_key = ?",
    )
    .bind(attemptKey)
    .first<{ failures: number; updated_at: number }>();

  const failures =
    prev && now - prev.updated_at < LOCK_WINDOW_MS ? prev.failures + 1 : 1;
  const lockedUntil = failures >= MAX_LOGIN_FAILURES ? now + LOCK_WINDOW_MS : 0;

  await db
    .prepare(
      `INSERT INTO login_attempts (attempt_key, failures, locked_until, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(attempt_key) DO UPDATE SET
         failures = excluded.failures,
         locked_until = excluded.locked_until,
         updated_at = excluded.updated_at`,
    )
    .bind(attemptKey, failures, lockedUntil, now)
    .run();
}

async function clearLoginFailures(
  db: D1Database,
  attemptKey: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM login_attempts WHERE attempt_key = ?")
    .bind(attemptKey)
    .run();
}

async function createSession(
  db: D1Database,
  params: {
    role: "ADMIN" | "REVIEWER";
    admin_id?: number;
    member_id?: number;
    cycle_id?: number;
  },
): Promise<{ rawToken: string; session: SessionRecord }> {
  const rawToken = randomToken(32);
  const token_hash = await sha256Hex(rawToken);
  const csrf_token = randomToken(24);
  const expires_at = Date.now() + SESSION_TTL_SECONDS * 1000;
  const created_at = nowIso();

  const session: SessionRecord = {
    token_hash,
    role: params.role,
    admin_id: params.admin_id ?? null,
    member_id: params.member_id ?? null,
    cycle_id: params.cycle_id ?? null,
    csrf_token,
    expires_at,
    created_at,
  };

  await db
    .prepare(
      `INSERT INTO sessions (token_hash, role, admin_id, member_id, cycle_id, csrf_token, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      session.token_hash,
      session.role,
      session.admin_id,
      session.member_id,
      session.cycle_id,
      session.csrf_token,
      session.expires_at,
      session.created_at,
    )
    .run();

  return { rawToken, session };
}

export function registerAuthRoutes(router: Router): void {
  router.get("/api/auth/setup-status", async ({ env }) => {
    const existing = await env.DB.prepare("SELECT id FROM admins LIMIT 1").first<{
      id: number;
    }>();
    return jsonResponse({ needs_setup: !existing });
  });

  router.post("/api/auth/setup", async ({ req, url, env }) => {
    const existing = await env.DB.prepare("SELECT id FROM admins LIMIT 1").first<{
      id: number;
    }>();
    if (existing) {
      throw new ApiError(
        409,
        "STATE_CONFLICT",
        "이미 최초 관리자 계정이 설정되어 있습니다.",
      );
    }

    const body = validateInitialAdminSetup(await readJsonBody(req));
    const password_hash = await hashPassword(body.password);
    const created_at = nowIso();

    try {
      const res = await env.DB.prepare(
        "INSERT INTO admins (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
      )
        .bind(body.username, body.email, password_hash, created_at)
        .run();
      const adminId = Number(res.meta.last_row_id);
      const { rawToken, session } = await createSession(env.DB, {
        role: "ADMIN",
        admin_id: adminId,
      });
      const secure = url.protocol === "https:";
      const payload = await buildSessionResponse(env.DB, session);
      return jsonResponse(payload, 201, {
        "Set-Cookie": formatSessionCookie(
          rawToken,
          SESSION_TTL_SECONDS,
          secure,
        ),
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        409,
        "STATE_CONFLICT",
        "이미 최초 관리자 계정이 설정되어 있습니다.",
      );
    }
  });

  router.post("/api/auth/admin/login", async ({ req, url, env, clientIp }) => {
    const body = validateAdminLogin(await readJsonBody(req));
    const attemptKey = await sha256Hex(`${clientIp}:admin:${body.username}`);
    await checkRateLimit(env.DB, attemptKey);

    const admin = await env.DB.prepare(
      "SELECT * FROM admins WHERE username = ?",
    )
      .bind(body.username)
      .first<AdminRecord>();

    if (!admin || !(await verifyPassword(body.password, admin.password_hash))) {
      await recordLoginFailure(env.DB, attemptKey);
      throw new ApiError(
        401,
        "UNAUTHORIZED",
        "아이디 또는 비밀번호가 일치하지 않습니다.",
      );
    }

    await clearLoginFailures(env.DB, attemptKey);
    const { rawToken, session } = await createSession(env.DB, {
      role: "ADMIN",
      admin_id: admin.id,
    });
    const secure = url.protocol === "https:";
    const payload = await buildSessionResponse(env.DB, session);
    return jsonResponse(payload, 200, {
      "Set-Cookie": formatSessionCookie(rawToken, SESSION_TTL_SECONDS, secure),
    });
  });

  router.post(
    "/api/auth/reviewer/login",
    async ({ req, url, env, clientIp }) => {
      const body = validateReviewerPinLogin(await readJsonBody(req));
      const attemptKey = await sha256Hex(`${clientIp}:reviewer_pin`);
      await checkRateLimit(env.DB, attemptKey);

      const codeHash = await sha256Hex(body.pin_code);
      const pinRow = await env.DB.prepare(
        `SELECT p.member_id, p.cycle_id
         FROM pins p
         JOIN cycles c ON c.id = p.cycle_id
         WHERE p.code_hash = ?
           AND c.status = 'ACTIVE'
           AND c.end_at > ?`,
      )
        .bind(codeHash, nowIso())
        .first<{ member_id: number; cycle_id: number }>();

      if (!pinRow) {
        await recordLoginFailure(env.DB, attemptKey);
        throw new ApiError(
          401,
          "UNAUTHORIZED",
          "유효하지 않거나 마감된 회차의 PIN 코드입니다.",
        );
      }

      await clearLoginFailures(env.DB, attemptKey);
      const { rawToken, session } = await createSession(env.DB, {
        role: "REVIEWER",
        member_id: pinRow.member_id,
        cycle_id: pinRow.cycle_id,
      });
      const secure = url.protocol === "https:";
      const payload = await buildSessionResponse(env.DB, session);
      return jsonResponse(payload, 200, {
        "Set-Cookie": formatSessionCookie(
          rawToken,
          SESSION_TTL_SECONDS,
          secure,
        ),
      });
    },
  );

  router.post("/api/auth/logout", async ({ req, url, env, session }) => {
    if (!session) {
      throw new ApiError(401, "UNAUTHORIZED", "로그인이 필요합니다.");
    }
    const rawCookie = parseCookie(
      req.headers.get("cookie"),
      "peerflow_session",
    );
    if (rawCookie) {
      const tokenHash = await sha256Hex(rawCookie);
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
        .bind(tokenHash)
        .run();
    }
    const secure = url.protocol === "https:";
    return emptyResponse(204, {
      "Set-Cookie": formatSessionCookie("", 0, secure),
    });
  });

  router.get("/api/auth/me", async ({ env, session }) => {
    if (!session) {
      throw new ApiError(401, "UNAUTHORIZED", "로그인이 필요합니다.");
    }
    const payload = await buildSessionResponse(env.DB, session);
    return jsonResponse(payload, 200);
  });
}
