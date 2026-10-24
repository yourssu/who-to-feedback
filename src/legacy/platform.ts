import { mkdirSync, rmSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import type { Platform } from "../platform";
function mediaPath(name: string) {
  const root = resolve(process.env.PEERFLOW_MEDIA ?? "media"),
    path = resolve(root, name);
  if (!path.startsWith(root + sep)) throw new Error("Invalid media path");
  return path;
}
export const defaultPlatform: Platform = {
  get siteUrl() {
    return process.env.SITE_URL;
  },
  get secureCookies() {
    return process.env.NODE_ENV === "production";
  },
  get trustProxy() {
    return process.env.TRUST_PROXY === "true";
  },
  passwordHash: (password) =>
    Bun.password.hash(password, { algorithm: "argon2id" }),
  passwordVerify: (password, hash) => Bun.password.verify(password, hash),
  async staticFile(request) {
    const root = resolve("core/static"),
      path = resolve(
        root,
        decodeURIComponent(
          new URL(request.url).pathname.slice("/static/".length),
        ),
      );
    if (!path.startsWith(root + sep))
      return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    if (!(await file.exists()))
      return new Response("Not found", { status: 404 });
    const etag = `W/"${file.size}-${file.lastModified}"`;
    const headers = {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": file.type,
      ETag: etag,
    };
    return request.headers.get("If-None-Match") === etag
      ? new Response(null, { status: 304, headers })
      : new Response(file, { headers });
  },
  async mediaGet(name) {
    const file = Bun.file(mediaPath(name));
    return (await file.exists())
      ? new Response(file, { headers: { "Content-Type": file.type } })
      : new Response("Not found", { status: 404 });
  },
  async mediaPut(name, bytes) {
    const path = mediaPath(name);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, bytes);
  },
  async mediaDelete(name) {
    rmSync(mediaPath(name), { force: true });
  },
  async artifact(value, mime) {
    return new Response(
      typeof value === "string" ? value : new Uint8Array(value),
      { headers: { "Content-Type": mime } },
    );
  },
};
