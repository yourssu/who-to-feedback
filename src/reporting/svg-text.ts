import { readFileSync } from "node:fs";
import { parse, type Font } from "opentype.js";
let cached: Font | undefined;
function font() {
  if (!cached) {
    const bytes = readFileSync("core/static/fonts/Pretendard-Regular.ttf");
    cached = parse(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  }
  return cached;
}
/** Inline chart images cannot inherit the surrounding report's embedded font. */
export function outlineSvgText(body: string) {
  return body.replace(
    /<text([^>]*)>([^<]*)<\/text>/g,
    (_match, attributes: string, encoded: string) => {
      const text = encoded.replace(
        /&(amp|lt|gt|quot|#39);/g,
        (_, key: string) =>
          ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[key]!,
      );
      const x = Number(attributes.match(/\bx="([^"]+)"/)?.[1] ?? 0),
        y = Number(attributes.match(/\by="([^"]+)"/)?.[1] ?? 0);
      const f = font(),
        offset = attributes.includes('text-anchor="middle"')
          ? f.getAdvanceWidth(text, 12) / 2
          : 0;
      const fill = /fill:\s*white/.test(attributes) ? "#ffffff" : "#23244d";
      return `<path d="${f.getPath(text, x - offset, y, 12).toPathData(2)}" fill="${fill}"/>`;
    },
  );
}
