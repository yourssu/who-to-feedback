import type { Platform } from "../platform";
import { passwordHash, passwordVerify } from "./password";
import { setReportFont } from "../reporting/svg-text";
import type { Repository } from "../repository";
export interface FilesEnv {
  ASSETS: Fetcher;
  FILES: R2Bucket;
  SITE_URL?: string;
}
const fontUris: Record<string, string> = {};
let fontLoaded: Promise<void> | undefined;
export function platform(env: FilesEnv): Platform {
  return {
    siteUrl: env.SITE_URL,
    secureCookies: true,
    passwordHash,
    passwordVerify,
    staticFile: (request) => env.ASSETS.fetch(request),
    async mediaGet(name) {
      const object = await env.FILES.get(`media/${name}`);
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, {
        headers: {
          "Content-Type":
            object.httpMetadata?.contentType ?? "application/octet-stream",
        },
      });
    },
    async mediaPut(name, bytes) {
      await env.FILES.put(`media/${name}`, bytes, {
        httpMetadata: {
          contentType: name.endsWith(".png")
            ? "image/png"
            : name.endsWith(".webp")
              ? "image/webp"
              : "image/jpeg",
        },
      });
    },
    async mediaDelete(name) {
      await env.FILES.delete(`media/${name}`);
    },
    async artifact(value, mime) {
      const key =
        typeof value === "string" ? value : new TextDecoder().decode(value);
      if (
        !/^r2:reports\/[a-f0-9]{64}(?:-[a-f0-9-]{36})?\.(html|pdf)$/.test(key)
      )
        throw new Error("Invalid artifact reference");
      const object = await env.FILES.get(key.slice(3));
      if (!object) return new Response("Artifact missing", { status: 404 });
      return new Response(object.body, {
        headers: {
          "Content-Type": mime,
          "Content-Length": String(object.size),
        },
      });
    },
    reportAssets: { fonts: {}, images: new Map() },
  };
}
export async function prepareReports(
  repo: Repository,
  env: FilesEnv,
  cycle: number,
) {
  const assets = repo.platform!.reportAssets!;
  assets.fonts = fontUris;
  const readFont = async (format: string) => {
    const response = await env.ASSETS.fetch(
      `https://assets.invalid/static/fonts/Pretendard-Regular.${format}`,
    );
    if (!response.ok) throw new Error(`Missing report font: ${format}`);
    return response.arrayBuffer();
  };
  if (!fontLoaded)
    fontLoaded = readFont("ttf")
      .then((bytes) => setReportFont(bytes))
      .catch((error) => {
        fontLoaded = undefined;
        throw error;
      });
  await fontLoaded;
  if (!assets.fonts.woff2)
    assets.fonts.woff2 =
      "data:font/woff2;base64," +
      Buffer.from(await readFont("woff2")).toString("base64");
  if (
    repo.one(
      "SELECT id FROM cycles WHERE id=? AND use_custom_template=1",
      cycle,
    ) &&
    !assets.fonts.ttf
  )
    assets.fonts.ttf =
      "data:font/ttf;base64," +
      Buffer.from(await readFont("ttf")).toString("base64");
  assets.images.clear();
  // Scope image hydration to the currently rendered cycle in callers where possible.
  for (const row of repo.all(
    "SELECT DISTINCT image FROM questions WHERE cycle_id=? AND image IS NOT NULL",
    cycle,
  )) {
    const response = await repo.platform!.mediaGet(row.image);
    if (response.ok)
      assets.images.set(
        row.image,
        `data:${response.headers.get("Content-Type")};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`,
      );
  }
}
