import { mkdirSync } from "node:fs";

// The image must be built first. All mutable data belongs to a disposable volume.
const image = process.argv[2] ?? "peerflow:local-verification";
const name = `peerflow-check-${crypto.randomUUID().slice(0, 8)}`;
const volume = `${name}-data`;
let containerCreated = false;
async function command(args: string[], input?: string) {
  const child = Bun.spawn(args, {
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined && child.stdin) {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(`${args.slice(0, 2).join(" ")}: ${error}`);
  return out.trim();
}
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const seed = `
import { mkdirSync } from 'node:fs';
import { openDatabase } from '/app/src/db.ts';
import { seedDemo } from '/app/scripts/seed.ts';
const repo=openDatabase(); const cycle=seedDemo(repo);
mkdirSync('/app/data/media',{recursive:true});
await Bun.write('/app/data/media/check.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
repo.run('UPDATE questions SET image=? WHERE id=1','check.png');
console.log(JSON.stringify({cycle,code:repo.one('SELECT code FROM pins WHERE member_id=1').code,assignments:repo.assignments(cycle,1).map(a=>a.id)})); repo.db.close();`;
const query = (source: string) =>
  command(["docker", "exec", name, "bun", "-e", source]);
let base = "";
class HttpClient {
  cookies = new Map<string, string>();
  async request(path: string, data?: Record<string, unknown>) {
    const response = await fetch(base + path, {
      method: data ? "POST" : "GET",
      redirect: "manual",
      headers: {
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(data
          ? {
              "Content-Type": "application/json",
              "X-CSRFToken": this.cookies.get("csrftoken") ?? "",
              Origin: "http://docker.test",
            }
          : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    // Send Secure cookies manually across loopback: TLS terminates at Nginx in production.
    for (const entry of response.headers.getSetCookie()) {
      const pair = entry.split(";")[0],
        index = pair.indexOf("=");
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
}
async function healthy() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + "/health/")).ok) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error("Docker HTTP server did not become healthy");
}
try {
  await command(["docker", "volume", "create", volume]);
  const fixture = JSON.parse(
    await command(
      [
        "docker",
        "run",
        "--rm",
        "-i",
        "-v",
        `${volume}:/app/data`,
        "-e",
        "NODE_ENV=development",
        "-e",
        "MOCK_SLACK_MODE=true",
        image,
        "bun",
        "run",
        "-",
      ],
      seed,
    ),
  ) as { cycle: number; code: string; assignments: number[] };
  await command([
    "docker",
    "run",
    "-d",
    "--name",
    name,
    "-p",
    "127.0.0.1::8000",
    "-v",
    `${volume}:/app/data`,
    "-e",
    "MOCK_SLACK_MODE=true",
    "-e",
    "SLACK_BOT_TOKEN=",
    "-e",
    "SITE_URL=http://docker.test",
    "-e",
    "PEERFLOW_MEDIA=/app/data/media",
    image,
  ]);
  containerCreated = true;
  base = `http://${await command(["docker", "port", name, "8000/tcp"])}`;
  await healthy();
  console.log("PASS production startup and health");
  const admin = new HttpClient(),
    reviewer = new HttpClient(),
    anonymous = new HttpClient();
  const setup = await admin.request("/setup/");
  assert(setup.status === 200, "Initial setup failed");
  assert(
    setup.headers
      .getSetCookie()
      .some((v) => /peerflow_session=.*;.*Secure/i.test(v)),
    "Production session is not Secure",
  );
  assert(
    (
      await admin.request("/setup/", {
        username: "docker-admin",
        email: "docker@example.com",
        password: "docker-test-password",
        password_confirm: "docker-test-password",
      })
    ).status === 302,
    "Admin creation failed",
  );
  assert(
    (await anonymous.request("/setup/")).status === 404,
    "Setup stayed open",
  );
  assert(
    (
      await fetch(base + "/admin-panel/cycles/create/", {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      })
    ).status === 403,
    "Missing CSRF was accepted",
  );
  assert(
    (await fetch(base + "/static/css/style.css")).ok,
    "Static asset failed",
  );
  const blockedMedia = await anonymous.request("/media/check.png");
  assert(
    blockedMedia.status === 302 &&
      blockedMedia.headers.get("Location") === "/login/",
    "Media exposed without login",
  );
  assert(
    (await admin.request("/media/check.png")).ok,
    "Authenticated media failed",
  );
  await admin.request("/logout/");
  await admin.request("/admin/login/");
  assert(
    (
      await admin.request("/admin/login/", {
        username: "docker-admin",
        password: "docker-test-password",
      })
    ).status === 302,
    "Admin password login failed",
  );
  await reviewer.request("/login/");
  assert(
    (await reviewer.request("/login/", { code: fixture.code })).status === 302,
    "Reviewer login failed",
  );
  const answers = {
    q_1_rating: "4",
    q_2_text:
      "컨테이너에서도 한글 피드백과 PDF가 정상적으로 생성되는지 확인합니다.",
    q_3_single: "1",
    q_4_multi: ["4", "5"],
  };
  for (const id of fixture.assignments) {
    assert(
      (await reviewer.request(`/review/${id}/save-draft/`, answers)).ok,
      "Draft failed",
    );
    assert(
      (await reviewer.request(`/review/${id}/`, answers)).status === 302,
      "Submission failed",
    );
  }
  console.log("PASS setup, authentication, media, CSRF, drafts and submission");
  for (const path of [
    "/admin-panel/",
    "/admin-panel/members/",
    `/admin-panel/cycles/${fixture.cycle}/history/`,
    `/admin-panel/cycles/${fixture.cycle}/validation/`,
    "/admin-panel/messages/send/",
  ]) {
    assert((await admin.request(path)).ok, `Admin screen failed: ${path}`);
  }
  assert(
    (
      await admin.request(
        `/admin-panel/cycles/${fixture.cycle}/generate-reports/`,
        {},
      )
    ).status === 302,
    "Report generation request failed",
  );
  const reportSource = `import {openDatabase} from './src/db.ts';const r=openDatabase();console.log(JSON.stringify(r.all('SELECT id,pdf_status,error_log FROM reports')));r.db.close();`;
  let reports: { id: number; pdf_status: string; error_log: string | null }[] =
    [];
  for (let i = 0; i < 120; i++) {
    reports = JSON.parse(await query(reportSource));
    assert(
      !reports.some((r) => r.pdf_status === "FAILED"),
      `PDF job failed: ${JSON.stringify(reports)}`,
    );
    if (reports.length === 3 && reports.every((r) => r.pdf_status === "READY"))
      break;
    await Bun.sleep(500);
  }
  assert(
    reports.length === 3 && reports.every((r) => r.pdf_status === "READY"),
    "PDF jobs timed out",
  );
  mkdirSync("artifacts/docker", { recursive: true });
  for (const r of reports) {
    const path = `/admin-panel/reports/${r.id}/pdf/`;
    assert(
      (await anonymous.request(path)).status === 302,
      "PDF exposed without login",
    );
    const response = await admin.request(path),
      bytes = new Uint8Array(await response.arrayBuffer());
    assert(
      response.ok && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-",
      "Invalid PDF download",
    );
    const file = `artifacts/docker/report-${r.id}.pdf`;
    await Bun.write(file, bytes);
    const info = await command(["pdfinfo", file]),
      text = await command(["pdftotext", "-layout", file, "-"]);
    assert(
      /Pages:\s+7\b/.test(info) && text.includes("피드백"),
      "Container PDF pages or Korean text failed",
    );
  }
  assert(
    (await admin.request(`/admin-panel/cycles/${fixture.cycle}/publish/`, {}))
      .status === 302,
    "Approval failed",
  );
  let closed = false;
  for (let i = 0; i < 60; i++) {
    closed =
      (await query(
        `import {openDatabase} from './src/db.ts';const r=openDatabase();console.log(r.cycle(${fixture.cycle}).status);r.db.close();`,
      )) === "CLOSED";
    if (closed) break;
    await Bun.sleep(500);
  }
  assert(closed, "Mock delivery did not complete cycle");
  await command(["docker", "restart", name]);
  const previousBase = base;
  base = `http://${await command(["docker", "port", name, "8000/tcp"])}`;
  console.log(
    `Restart port ${previousBase === base ? "preserved" : "reassigned; refreshed client endpoint"}`,
  );
  await healthy();
  assert(
    (await admin.request("/admin-panel/")).ok,
    "Session was lost after restart",
  );
  assert(
    (await admin.request(`/admin-panel/reports/${reports[0].id}/pdf/`)).ok,
    "Stored PDF was lost after restart",
  );
  await command(["docker", "stop", name]);
  await command([
    "docker",
    "run",
    "--rm",
    "-v",
    `${volume}:/app/data`,
    "-e",
    "PEERFLOW_MEDIA=/app/data/media",
    image,
    "bun",
    "run",
    "scripts/backup.ts",
    "/app/data/test-backup",
  ]);
  const backupCheck = await command([
    "docker",
    "run",
    "--rm",
    "-v",
    `${volume}:/app/data`,
    image,
    "bun",
    "-e",
    `import {existsSync} from 'node:fs';if(!existsSync('/app/data/test-backup/media/check.png')) throw new Error('media backup missing');import {Database} from 'bun:sqlite';const d=new Database('/app/data/test-backup/peerflow.sqlite3',{readonly:true});console.log(JSON.stringify({integrity:d.query('PRAGMA integrity_check').get(),reports:d.query('SELECT count(*) n FROM reports WHERE pdf_status=?').get('READY')}));d.close();`,
  ]);
  assert(
    JSON.parse(backupCheck).reports.n === 3 &&
      JSON.parse(backupCheck).integrity.integrity_check === "ok",
    "Backup failed",
  );
  await Bun.write(
    "artifacts/docker/result.json",
    JSON.stringify(
      {
        image,
        checks: [
          "production startup",
          "Secure cookies",
          "setup",
          "CSRF",
          "static",
          "PIN login",
          "draft and submit",
          "admin screens",
          "Chromium PDF and Korean text",
          "authenticated download",
          "mock approval and delivery",
          "restart persistence",
          "SQLite backup integrity",
        ],
        reports: reports.length,
        status: "PASS",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS Docker startup, review, 3 PDFs, mock delivery, restart and backup",
  );
} finally {
  if (containerCreated) await command(["docker", "rm", "-f", name]);
  await command(["docker", "volume", "rm", volume]);
}
