import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
const fonts = new Map<string, string>();
export function localFontBytes() {
  const bytes = readFileSync("core/static/fonts/Pretendard-Regular.ttf");
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}
export function fontData(format: "ttf" | "woff2") {
  if (!fonts.has(format))
    fonts.set(
      format,
      `data:font/${format};base64,` +
        readFileSync(`core/static/fonts/Pretendard-Regular.${format}`).toString(
          "base64",
        ),
    );
  return fonts.get(format)!;
}
export function imageData(name: string | null) {
  if (!name) return "";
  const root = resolve(process.env.PEERFLOW_MEDIA ?? "media"),
    path = resolve(root, name);
  if (!path.startsWith(root + sep)) return "";
  try {
    const mime = name.endsWith(".png")
      ? "image/png"
      : name.endsWith(".webp")
        ? "image/webp"
        : "image/jpeg";
    return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
  } catch {
    return "";
  }
}
