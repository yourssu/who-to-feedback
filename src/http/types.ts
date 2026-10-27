import type { RouteName } from "#templates";
import type { Context, Hono } from "hono";
import type { DashboardViewModel, TemplateName } from "./view-models";
import type { Repository, Row } from "../repository";
export interface Session {
  admin_id?: number;
  test_admin?: boolean;
  member_id?: number;
  member_name?: string;
  cycle_id?: number;
  csrf: string;
  messages?: {
    text: string;
    tags: string;
  }[];
}
export type Env = {
  Bindings: {
    clientIp?: string;
  };
  Variables: {
    session: Session;
    token: string;
    body: Row;
    routeName: string;
  };
};
export type Ctx = Context<Env>;
export interface HttpServices {
  app: Hono<Env>;
  repo: Repository;
  route: (
    name: RouteName,
    method: "get" | "post",
    handler: (c: Ctx) => Response | Promise<Response>,
  ) => void;
  page: {
    (
      c: Ctx,
      name: "admin_custom/dashboard.html",
      data: DashboardViewModel,
    ): Response;
    (
      c: Ctx,
      name: Exclude<TemplateName, "admin_custom/dashboard.html">,
      data?: Row,
    ): Response;
  };
  flash: (c: Ctx, text: string, tags?: string) => void;
  rotate: (c: Ctx, data: Partial<Session>) => void;
  form: (c: Ctx) => Row;
  id: (c: Ctx, name?: string) => number;
  back: (c: Ctx, cycle: number, screen?: RouteName) => Response;
  clientKey: (c: Ctx, identity: string) => string;
  locked: (key: string) => boolean;
  fail: (key: string) => void;
  numeric: (value: unknown) => number;
}
