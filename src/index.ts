import { openDatabase } from "./db";
import { createApp } from "./app";
import { JobRunner, SlackDelivery } from "./jobs";
const repo = openDatabase();
const jobs = new JobRunner(repo, new SlackDelivery());
jobs.start();
const cleanup = setInterval(
  () => {
    repo.run("DELETE FROM sessions WHERE expires_at<?", Date.now());
    repo.run(
      "DELETE FROM login_attempts WHERE updated_at<?",
      Date.now() - 24 * 60 * 60 * 1000,
    );
  },
  60 * 60 * 1000,
);
const app = createApp(repo);
const server = Bun.serve({
  port: Number(process.env.PORT ?? 8000),
  hostname: process.env.HOST ?? "127.0.0.1",
  fetch: (request, server) =>
    app.fetch(request, { clientIp: server.requestIP(request)?.address }),
});
console.log(`PeerFlow: http://${server.hostname}:${server.port}`);
async function stop() {
  clearInterval(cleanup);
  await server.stop(false);
  await jobs.stop();
  repo.db.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
