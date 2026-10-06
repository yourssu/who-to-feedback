import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { DomainError, type Repository, type Row } from "./db";
import { hash } from "./domain";
import { routes, templates, url, type RouteName } from "./templates";
import type { Ctx, Env, Session, HttpServices } from "./http/types";
import { registerAuthRoutes } from "./routes/auth";
import { registerReviewerRoutes } from "./routes/reviewer";
import { registerCyclesRoutes } from "./routes/cycles";
import { registerMembersRoutes } from "./routes/members";
import { registerQuestionsRoutes } from "./routes/questions";
import { registerAssignmentsRoutes } from "./routes/assignments";
import { registerStatusRoutes } from "./routes/status";
import { registerReportsRoutes } from "./routes/reports";
import { registerValidationRoutes } from "./routes/validation";
import { registerMessagesRoutes } from "./routes/messages";
const randomToken = () =>
  crypto.randomUUID().replaceAll("-", "") +
  crypto.randomUUID().replaceAll("-", "");
const numeric = (value: unknown) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new DomainError("유효하지 않은 ID입니다.");
  return n;
};
const secureEqual = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export function createApp(repo: Repository) {
  const app = new Hono<Env>();
  const clientKey = (c: Ctx, identity: string) =>
    hash(
      `${process.env.TRUST_PROXY === "true" ? (c.req.header("X-Real-IP") ?? c.env?.clientIp ?? "unknown") : (c.env?.clientIp ?? "direct")}:${identity}`,
    );
  const locked = (key: string) =>
    (repo.one("SELECT locked_until FROM login_attempts WHERE key=?", key)
      ?.locked_until ?? 0) > Date.now();
  const fail = (key: string) => {
    const previous = repo.one("SELECT * FROM login_attempts WHERE key=?", key);
    const count =
      previous && Date.now() - previous.updated_at < 15 * 60 * 1000
        ? previous.failures + 1
        : 1;
    repo.run(
      "INSERT INTO login_attempts(key,failures,locked_until,updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,locked_until=excluded.locked_until,updated_at=excluded.updated_at",
      key,
      count,
      count >= 5 ? Date.now() + 15 * 60 * 1000 : 0,
      Date.now(),
    );
  };
  const flash = (c: Ctx, text: string, tags = "success") => {
    const s = c.get("session");
    (s.messages ??= []).push({ text, tags });
  };
  const rotate = (c: Ctx, data: Partial<Session>) => {
    repo.run("DELETE FROM sessions WHERE token_hash=?", hash(c.get("token")));
    c.set("token", randomToken());
    c.set("session", { csrf: randomToken(), ...data });
  };
  const page = (c: Ctx, name: string, data: Row = {}) => {
    const s = c.get("session"),
      admin = s.admin_id ? repo.require("admins", s.admin_id) : {};
    const messages = (s.messages ?? []).map((m) => ({
      text: m.text,
      tags: m.tags,
      toString: () => m.text,
    }));
    s.messages = [];
    const html = templates.render(name, {
      latest_cycle: repo.latest(),
      ...data,
      csrf_token: s.csrf,
      messages,
      request: {
        session: s,
        user: { username: admin.username, email: admin.email },
        POST: c.get("body") ?? {},
        resolver_match: { url_name: c.get("routeName") },
      },
    });
    return c.html(html);
  };
  const route = (
    name: RouteName,
    method: "get" | "post",
    handler: (c: Ctx) => Response | Promise<Response>,
  ) => {
    app[method](routes[name], async (c) => {
      c.set("routeName", name);
      return handler(c);
    });
  };
  const form = (c: Ctx) => c.get("body");
  const id = (c: Ctx, name = "cycle_id") => numeric(c.req.param(name));
  const back = (c: Ctx, cycle: number, screen: RouteName = "admin_reports") =>
    c.redirect(url(screen, { cycle_id: cycle }));
  const draftCycle = (cycle: number) => {
    const c = repo.cycle(cycle);
    if (c.is_question_locked)
      throw new DomainError(
        "시작한 회차의 문항과 선택지는 수정할 수 없습니다.",
        403,
      );
    return c;
  };
  const invalidateReports = (cycle: number) => {
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
  };
  app.get("/health/", (c) => {
    repo.one("SELECT 1");
    return c.json({ status: "ok" });
  });
  app.get("/static/*", async (c) => {
    const root = resolve("core/static"),
      path = resolve(
        root,
        decodeURIComponent(c.req.path.slice("/static/".length)),
      );
    if (!path.startsWith(root + sep)) return c.notFound();
    const file = Bun.file(path);
    if (!(await file.exists())) return c.notFound();
    const etag = `W/"${file.size}-${file.lastModified}"`;
    const headers = {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": file.type,
      ETag: etag,
    };
    if (c.req.header("If-None-Match") === etag)
      return new Response(null, { status: 304, headers });
    return new Response(file, { headers });
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 3 * 1024 * 1024,
      onError: (c) =>
        c.json(
          { status: "error", message: "업로드 용량이 초과되었습니다." },
          413,
        ),
    }),
  );
  app.use("*", async (c, next) => {
    const cookie = getCookie(c, "peerflow_session");
    let token =
      cookie && /^[a-f0-9]{64}$/.test(cookie) ? cookie : randomToken();
    const stored = repo.one(
      "SELECT data FROM sessions WHERE token_hash=? AND expires_at>?",
      hash(token),
      Date.now(),
    );
    if (!stored) token = randomToken();
    const session: Session = stored
      ? JSON.parse(stored.data)
      : { csrf: randomToken() };
    c.set("session", session);
    c.set("token", token);
    c.set("body", {});
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "same-origin");
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
        const origin = c.req.header("Origin");
        const expected = process.env.SITE_URL
          ? new URL(process.env.SITE_URL).origin
          : new URL(c.req.url).origin;
        if (origin && origin !== expected)
          throw new DomainError("허용되지 않은 요청 출처입니다.", 403);
        const body: Row = Object.create(null);
        if (c.req.header("Content-Type")?.startsWith("application/json")) {
          const bytes = await c.req.arrayBuffer();
          if (
            c.req.path.includes("/save-draft/") &&
            bytes.byteLength > 100 * 1024
          )
            throw new DomainError("임시 저장은 최대 100KB입니다.");
          let data: unknown;
          try {
            data = JSON.parse(new TextDecoder().decode(bytes));
          } catch {
            throw new DomainError("유효한 JSON 객체를 전송해 주세요.");
          }
          if (!data || Array.isArray(data) || typeof data !== "object")
            throw new DomainError("JSON 객체를 전송해 주세요.");
          Object.assign(body, data);
        } else {
          const data = await c.req.formData();
          for (const key of new Set(data.keys())) {
            const values = data.getAll(key);
            body[key] = values.length > 1 ? values : values[0];
          }
        }
        c.set("body", body);
        const csrf = c.req.header("X-CSRFToken") ?? body.csrfmiddlewaretoken;
        if (typeof csrf !== "string" || !secureEqual(csrf, session.csrf))
          throw new DomainError(
            "요청이 만료되었습니다. 페이지를 새로고침해 주세요.",
            403,
          );
      }
      if (c.req.path.startsWith("/admin-panel/") && !session.admin_id)
        return c.redirect(
          "/admin/login/?next=" + encodeURIComponent(c.req.path),
        );
      await next();
    } finally {
      const active = c.get("session"),
        current = c.get("token");
      if (stored && current === token)
        repo.run(
          "UPDATE sessions SET data=?,expires_at=? WHERE token_hash=?",
          JSON.stringify(active),
          Date.now() + 12 * 60 * 60 * 1000,
          hash(current),
        );
      else
        repo.run(
          "INSERT INTO sessions(token_hash,data,expires_at) VALUES (?,?,?)",
          hash(current),
          JSON.stringify(active),
          Date.now() + 12 * 60 * 60 * 1000,
        );
      const opts = {
        path: "/",
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "Lax" as const,
        maxAge: 12 * 60 * 60,
      };
      setCookie(c, "peerflow_session", current, opts);
      setCookie(c, "csrftoken", active.csrf, { ...opts, httpOnly: false });
    }
  });
  const services: HttpServices = {
    app,
    repo,
    route,
    page,
    flash,
    rotate,
    form,
    id,
    back,
    draftCycle,
    invalidateReports,
    clientKey,
    locked,
    fail,
    numeric,
  };
  registerAuthRoutes(services);
  registerReviewerRoutes(services);
  registerCyclesRoutes(services);
  registerMembersRoutes(services);
  registerQuestionsRoutes(services);
  registerAssignmentsRoutes(services);
  registerStatusRoutes(services);
  registerReportsRoutes(services);
  registerValidationRoutes(services);
  registerMessagesRoutes(services);
  app.get("/media/*", async (c) => {
    const s = c.get("session");
    if (!s.admin_id && !s.member_id)
      throw new DomainError("로그인이 필요합니다.", 401);
    const name = decodeURIComponent(c.req.path.slice("/media/".length));
    if (!repo.one("SELECT id FROM questions WHERE image=?", name))
      return c.notFound();
    const root = resolve(process.env.PEERFLOW_MEDIA ?? "media"),
      path = resolve(root, name);
    if (!path.startsWith(root + sep)) return c.notFound();
    const file = Bun.file(path);
    if (!(await file.exists())) return c.notFound();
    return c.body(await file.arrayBuffer(), 200, { "Content-Type": file.type });
  });
  app.onError((error, c) => {
    const status =
      error instanceof DomainError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : 500;
    const message =
      error instanceof z.ZodError
        ? "필수 입력값과 형식을 확인해 주세요."
        : error instanceof DomainError
          ? error.message
          : "요청을 처리하지 못했습니다. 입력값과 운영 기록을 확인해 주세요.";
    if (status === 500) console.error(error);
    if (
      c.req.path.includes("/save-draft/") ||
      c.req.header("Accept")?.includes("application/json")
    )
      return c.json({ status: "error", message }, status as 400);
    if (status === 401) return c.redirect("/login/");
    if (c.req.method === "POST" && status === 400) {
      flash(c, message, "error");
      const ref = c.req.header("Referer");
      if (ref) {
        const target = new URL(ref);
        if (target.origin === new URL(c.req.url).origin)
          return c.redirect(target.pathname);
      }
      return c.redirect(
        c.req.path.startsWith("/admin-panel/") ? "/admin-panel/" : "/login/",
      );
    }
    return c.text(message, status as 400);
  });
  return app;
}
