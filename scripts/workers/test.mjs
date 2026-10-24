import { spawn } from "node:child_process";
import { resolve } from "node:path";
const child = spawn(process.execPath, ["tests/workers/verify.mjs"], {
  stdio: "inherit",
  env: { ...process.env, XDG_CACHE_HOME: resolve(".wrangler/cache") },
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
