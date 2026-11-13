import { nowIso, sha256Hex, timingSafeEqualStr } from "./crypto.ts";
import {
  handleError,
  jsonResponse,
  parseCookie,
  Router,
  type RouteContext,
} from "./router.ts";
import { registerAssignmentsRoutes } from "./routes/assignments.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerCyclesRoutes } from "./routes/cycles.ts";
import { registerDeliveriesRoutes } from "./routes/deliveries.ts";
import { registerMediaRoutes } from "./routes/media.ts";
import { registerMembersRoutes } from "./routes/members.ts";
import { registerQuestionsRoutes } from "./routes/questions.ts";
import { registerReportsRoutes } from "./routes/reports.ts";
import { registerReviewerRoutes } from "./routes/reviewer.ts";
import { ApiError, type Env, type SessionRecord } from "./types.ts";

const PUBLIC_MUTATION_PATHS = new Set([
  "/api/auth/setup",
  "/api/auth/admin/login",
  "/api/auth/reviewer/login",
]);

function buildRouter(): Router {
  const router = new Router();

  router.get("/api/health", async ({ env }) => {
    await env.DB.prepare("SELECT 1").first();
    return jsonResponse({ status: "ok", timestamp: nowIso() }, 200);
  });

  registerAuthRoutes(router);
  registerMembersRoutes(router);
  registerCyclesRoutes(router);
  registerQuestionsRoutes(router);
  registerAssignmentsRoutes(router);
  registerReportsRoutes(router);
  registerDeliveriesRoutes(router);
  registerReviewerRoutes(router);
  registerMediaRoutes(router);

  return router;
}

const appRouter = buildRouter();

async function resolveSession(
  req: Request,
  env: Env,
): Promise<SessionRecord | null> {
  const rawToken = parseCookie(req.headers.get("cookie"), "peerflow_session");
  if (!rawToken || !/^[a-f0-9]{64}$/.test(rawToken)) {
    return null;
  }
  const tokenHash = await sha256Hex(rawToken);
  const session = await env.DB.prepare(
    "SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?",
  )
    .bind(tokenHash, Date.now())
    .first<SessionRecord>();
  return session ?? null;
}

export async function handleRequest(
  req: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (!pathname.startsWith("/api/") && pathname !== "/api") {
    if (env.ASSETS) {
      return env.ASSETS.fetch(req);
    }
    return new Response("Not Found", { status: 404 });
  }

  try {
    const matched = appRouter.match(req.method, pathname);
    if (!matched) {
      throw new ApiError(404, "NOT_FOUND", "요청한 API 경로를 찾을 수 없습니다.");
    }

    const session = await resolveSession(req, env);

    if (pathname.startsWith("/api/admin/") || pathname === "/api/admin") {
      if (!session) {
        throw new ApiError(401, "UNAUTHORIZED", "관리자 로그인이 필요합니다.");
      }
      if (session.role !== "ADMIN") {
        throw new ApiError(403, "FORBIDDEN", "관리자 권한이 필요합니다.");
      }
    }

    if (pathname.startsWith("/api/reviewer/") || pathname === "/api/reviewer") {
      if (!session) {
        throw new ApiError(401, "UNAUTHORIZED", "PIN 로그인이 필요합니다.");
      }
      if (session.role !== "REVIEWER") {
        throw new ApiError(403, "FORBIDDEN", "리뷰어 권한이 필요합니다.");
      }
    }

    const isMutation = !["GET", "HEAD", "OPTIONS"].includes(
      req.method.toUpperCase(),
    );
    if (isMutation && !PUBLIC_MUTATION_PATHS.has(pathname)) {
      if (!session) {
        throw new ApiError(401, "UNAUTHORIZED", "로그인이 필요합니다.");
      }
      const csrfHeader = req.headers.get("x-csrf-token") ?? "";
      if (!csrfHeader || !timingSafeEqualStr(csrfHeader, session.csrf_token)) {
        throw new ApiError(
          403,
          "FORBIDDEN",
          "유효하지 않은 CSRF 토큰입니다.",
        );
      }
    }

    const ctx: RouteContext = {
      req,
      url,
      env,
      params: matched.params,
      session,
      clientIp: req.headers.get("cf-connecting-ip") ?? "127.0.0.1",
    };

    return await matched.handler(ctx);
  } catch (err) {
    return handleError(err);
  }
}
