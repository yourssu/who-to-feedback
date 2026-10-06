// Development benchmark: memory DB and no Slack/PDF worker; requires dev dependencies.
import { openDatabase } from "../src/db";
import { seedDemo } from "./seed";
import { closeCycle } from "../src/domain";
import { generateAll } from "../src/reports";
import { createApp } from "../src/app";
import { Client } from "../tests/helpers";
const r = openDatabase(":memory:");
const cycle = seedDemo(r);
closeCycle(r, cycle);
let start = performance.now();
generateAll(r, cycle);
const generateMs = performance.now() - start;
const c = new Client(createApp(r));
await c.admin();
const times = [];
for (let i = 0; i < 10; i++) {
  start = performance.now();
  const res = await c.request(`/admin-panel/cycles/${cycle}/checklist/`);
  if (!res.ok) throw Error("HTTP");
  await res.text();
  times.push(performance.now() - start);
}
console.log(
  JSON.stringify({
    generateMs,
    htmlBytes: r.one(
      "SELECT length(CAST(html AS BLOB)) n FROM reports LIMIT 1",
    )!.n,
    checklistMeanMs: times.reduce((a, b) => a + b) / times.length,
  }),
);
r.db.close();
