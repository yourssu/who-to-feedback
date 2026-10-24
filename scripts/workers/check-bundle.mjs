import { readFile } from "node:fs/promises";
const bundle = await readFile("dist/worker/index.js", "utf8");
for (const pattern of [/\bBun\./, /bun:sqlite/, /node:fs(?:\/promises)?["']/]) {
  if (pattern.test(bundle))
    throw new Error(`Local-only API leaked into Worker bundle: ${pattern}`);
}
console.log("Worker bundle contains no Bun or node:fs dependencies.");
