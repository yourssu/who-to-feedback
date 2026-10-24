import { spawn } from "node:child_process";
import { resolve } from "node:path";
// Keep local development isolated from the legacy Docker .env and user-global caches.
const env = {
  ...process.env,
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_LOG_PATH: resolve(".wrangler/logs"),
  WRANGLER_REGISTRY_PATH: resolve(".wrangler/registry"),
  XDG_CACHE_HOME: resolve(".wrangler/cache"),
};
const args = process.argv.slice(2);
const child = spawn(
  process.execPath,
  ["node_modules/wrangler/bin/wrangler.js", ...args],
  { stdio: "inherit", env },
);
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
