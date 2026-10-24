import { getPlatform } from "../platform";
import { deleteCookie } from "hono/cookie";
import { z } from "zod";
import { DomainError } from "../repository";
import { hash, now } from "../domain";
import type { HttpServices } from "../http/types";
export function registerAuthRoutes(services: HttpServices) {
  const {
    app,
    repo,
    route,
    page,
    flash,
    rotate,
    form,
    id,
    clientKey,
    locked,
    fail,
  } = services;
  app.get("/admin/", (c) =>
    c.redirect(c.get("session").admin_id ? "/admin-panel/" : "/admin/login/"),
  );
  route("setup_wizard", "get", (c) => {
    if (repo.one("SELECT id FROM admins LIMIT 1")) return c.notFound();
    return page(c, "auth/setup.html");
  });
  route("setup_wizard", "post", async (c) => {
    if (repo.one("SELECT id FROM admins LIMIT 1")) return c.notFound();
    const data = z
      .object({
        username: z.string().trim().min(1).max(50),
        email: z.email(),
        password: z.string().min(6).max(200),
        password_confirm: z.string(),
      })
      .parse(form(c));
    if (data.password !== data.password_confirm)
      throw new DomainError("비밀번호가 일치하지 않습니다.");
    const password = await getPlatform(repo).passwordHash(data.password);
    const admin = repo.transaction(() => {
      if (repo.one("SELECT id FROM admins LIMIT 1"))
        throw new DomainError("이미 초기 설정이 완료되었습니다.", 404);
      return Number(
        repo.run(
          "INSERT INTO admins(username,email,password_hash) VALUES (?,?,?)",
          data.username,
          data.email,
          password,
        ).lastInsertRowid,
      );
    });
    rotate(c, { admin_id: admin });
    return c.redirect("/admin-panel/");
  });
  app.get("/admin/login/", (c) =>
    page(c, "admin/login.html", {
      app_path: "/admin/login/",
      next: "/admin-panel/",
      form: {},
    }),
  );
  app.post("/admin/login/", async (c) => {
    const data = form(c),
      username = String(data.username ?? "").slice(0, 50),
      key = clientKey(c, "admin:" + username);
    const admin = repo.one("SELECT * FROM admins WHERE username=?", username);
    if (
      locked(key) ||
      !admin ||
      !(await getPlatform(repo).passwordVerify(
        String(data.password ?? ""),
        admin.password_hash,
      )) ||
      locked(key)
    ) {
      fail(key);
      return page(c, "admin/login.html", {
        app_path: "/admin/login/",
        next: "/admin-panel/",
        form: { errors: true, username: { value: username } },
      });
    }
    repo.run("DELETE FROM login_attempts WHERE key=?", key);
    rotate(c, { admin_id: admin.id });
    return c.redirect("/admin-panel/");
  });
  route("login", "get", (c) =>
    page(c, "auth/login.html", { is_locked_out: locked(clientKey(c, "pin")) }),
  );
  route("login", "post", (c) => {
    const key = clientKey(c, "pin");
    if (locked(key)) return page(c, "auth/login.html", { is_locked_out: true });
    const code = String(form(c).code ?? "").trim();
    const pin = /^\d{6}$/.test(code)
      ? repo.one(
          "SELECT p.* FROM pins p JOIN cycles c ON c.id=p.cycle_id WHERE p.code_hash=? AND c.status='ACTIVE' AND (c.end_at IS NULL OR c.end_at>?)",
          hash(code),
          now(),
        )
      : null;
    if (!pin) {
      fail(key);
      flash(c, "유효하지 않거나 만료된 인증코드입니다.", "error");
      return page(c, "auth/login.html", { is_locked_out: locked(key) });
    }
    const member = repo.require("members", pin.member_id);
    repo.run("DELETE FROM login_attempts WHERE key=?", key);
    rotate(c, {
      member_id: member.id,
      member_name: member.name,
      cycle_id: pin.cycle_id,
    });
    return c.redirect("/");
  });
  route("logout", "get", (c) => {
    rotate(c, {});
    deleteCookie(c, "csrftoken");
    return c.redirect("/login/");
  });
}
