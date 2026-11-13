import {
  ApiError,
  CsvValidationError,
  type Env,
  type SessionRecord,
} from "./types.ts";

export interface RouteContext {
  req: Request;
  url: URL;
  env: Env;
  params: Record<string, string>;
  session: SessionRecord | null;
  clientIp: string;
}

export type RouteHandler = (
  ctx: RouteContext,
) => Response | Promise<Response>;

interface CompiledRoute {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: CompiledRoute[] = [];

  add(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const normalized = path.replace(/\/+$/, "") || "/";
    const regexSource = normalized
      .split("/")
      .map((segment) => {
        if (segment.startsWith(":")) {
          paramNames.push(segment.slice(1));
          return "([^/]+)";
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    const pattern = new RegExp(`^${regexSource || "/"}/?$`);
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      paramNames,
      handler,
    });
  }

  get(path: string, handler: RouteHandler): void {
    this.add("GET", path, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.add("POST", path, handler);
  }

  put(path: string, handler: RouteHandler): void {
    this.add("PUT", path, handler);
  }

  patch(path: string, handler: RouteHandler): void {
    this.add("PATCH", path, handler);
  }

  delete(path: string, handler: RouteHandler): void {
    this.add("DELETE", path, handler);
  }

  match(
    method: string,
    pathname: string,
  ): { handler: RouteHandler; params: Record<string, string> } | null {
    const upper = method.toUpperCase();
    for (const route of this.routes) {
      if (route.method !== upper) continue;
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, idx) => {
        params[name] = decodeURIComponent(m[idx + 1]);
      });
      return { handler: route.handler, params };
    }
    return null;
  }
}

export function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
  });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export function emptyResponse(
  status = 204,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
  });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }
  return new Response(null, { status, headers });
}

export async function readJsonBody(
  req: Request,
  allowEmpty = false,
  maxBytes = 1024 * 1024,
): Promise<unknown> {
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new ApiError(
      413,
      "PAYLOAD_TOO_LARGE",
      "요청 본문 크기가 제한을 초과했습니다.",
    );
  }
  if (bytes.byteLength === 0) {
    if (allowEmpty) return undefined;
    throw new ApiError(400, "VALIDATION_ERROR", "요청 본문이 비어 있습니다.");
  }
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Content-Type은 application/json이어야 합니다.",
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "유효한 JSON 형식이 아닙니다.",
    );
  }
}

export function parseCookie(
  cookieHeader: string | null,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export function formatSessionCookie(
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const parts = [
    `peerflow_session=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function handleError(error: unknown): Response {
  if (error instanceof CsvValidationError) {
    return jsonResponse(
      {
        code: "CSV_VALIDATION_ERROR",
        message: error.message,
        row_index: error.rowIndex,
        reason: error.reason,
      },
      422,
    );
  }
  if (error instanceof ApiError) {
    const payload: Record<string, unknown> = {
      code: error.code,
      message: error.message,
    };
    if (error.details && error.details.length > 0) {
      payload.details = error.details;
    }
    return jsonResponse(payload, error.status);
  }
  console.error("Unhandled API Error:", error);
  return jsonResponse(
    {
      code: "INTERNAL_ERROR",
      message: "서버 내부 오류가 발생했습니다.",
    },
    500,
  );
}
