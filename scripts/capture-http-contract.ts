import { readdir, readFile } from "node:fs/promises";
import { routes, type RouteName } from "../src/templates";

// Freeze the legacy HTTP surface before changing runtime and persistence.
const sources = [
  "src/app.ts",
  ...(await readdir("src/routes"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `src/routes/${name}`),
];
const contracts: { method: string; path: string; name: string | null }[] = [];
for (const file of sources) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(
    /\broute\(\s*"([^"]+)"\s*,\s*"(get|post)"/g,
  )) {
    const name = match[1] as RouteName;
    if (!routes[name]) throw new Error(`Unknown route: ${name}`);
    contracts.push({
      method: match[2].toUpperCase(),
      path: routes[name],
      name,
    });
  }
  for (const match of source.matchAll(/\bapp\.(get|post)\(\s*"([^"]+)"/g)) {
    contracts.push({
      method: match[1].toUpperCase(),
      path: match[2],
      name: null,
    });
  }
}
contracts.sort((a, b) =>
  `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`),
);
const keys = contracts.map((entry) => `${entry.method} ${entry.path}`);
if (new Set(keys).size !== keys.length)
  throw new Error("Duplicate HTTP contract");
const target = "tests/contracts/http-routes.json";
const content = JSON.stringify(contracts, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if ((await Bun.file(target).text()) !== content)
    throw new Error("HTTP contract changed; review fixture explicitly");
} else await Bun.write(target, content);
console.log(`${contracts.length} HTTP route contracts verified`);
