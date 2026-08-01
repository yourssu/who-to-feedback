"use strict";

const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const APP_DIR = __dirname;
const ROOT_DIR = path.resolve(APP_DIR, "..");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const GENERATED_DIR = path.join(ROOT_DIR, "generated");
const PORT = Number(process.env.PORT || 8765);
const PORTABLE_ONLY = fs.existsSync(path.join(ROOT_DIR, "runtime", ".portable"));

function loadModule(name) {
  const portable = path.join(ROOT_DIR, "runtime", "node_modules", name);
  if (fs.existsSync(portable)) return require(portable);
  return require(name);
}

const { chromium } = loadModule("playwright");
const JSZip = require(path.join(APP_DIR, "vendor", "jszip.min.js"));
const { renderReportHtml } = require("./report");

const jobs = new Map();
let activeBrowser = null;

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
  res.end(body);
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8", ".png": "image/png", ".pdf": "application/pdf", ".zip": "application/zip" })[ext] || "application/octet-stream";
}

function safeResolve(root, relative) {
  const target = path.resolve(root, relative.replace(/^[/\\]+/, ""));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

async function sendFile(res, file, downloadName) {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error("not file");
    const headers = { "Content-Type": contentType(file), "Content-Length": stat.size, "Cache-Control": "no-store" };
    if (downloadName) headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  } catch (_) {
    json(res, 404, { error: "파일을 찾을 수 없습니다." });
  }
}

function readJsonBody(req, limitBytes = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("요청 데이터가 너무 큽니다."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (_) { reject(new Error("JSON 형식이 올바르지 않습니다.")); }
    });
    req.on("error", reject);
  });
}

function safeFileName(value) {
  const cleaned = String(value || "report").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/g, "").trim();
  return cleaned || "report";
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function chromiumExecutable() {
  const candidates = [
    path.join(ROOT_DIR, "runtime", "chromium", "chrome-win64", "chrome.exe"),
    path.join(ROOT_DIR, "runtime", "chromium", "chrome-headless-shell-win64", "chrome-headless-shell.exe")
  ];
  const portable = candidates.find((candidate) => fs.existsSync(candidate));
  if (portable) return portable;
  if (PORTABLE_ONLY) throw new Error("내장 Chromium 실행 파일을 찾을 수 없습니다.");
  return chromium.executablePath();
}

function popplerBinary(name) {
  const portable = path.join(ROOT_DIR, "runtime", "poppler", "Library", "bin", `${name}.exe`);
  if (fs.existsSync(portable)) return portable;
  if (PORTABLE_ONLY) throw new Error(`내장 Poppler 실행 파일을 찾을 수 없습니다: ${name}.exe`);
  const bundled = path.join(process.env.USERPROFILE || "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "poppler", "Library", "bin", `${name}.exe`);
  return fs.existsSync(bundled) ? bundled : `${name}.exe`;
}

async function browser() {
  if (activeBrowser && activeBrowser.isConnected()) return activeBrowser;
  activeBrowser = await chromium.launch({
    headless: true,
    executablePath: chromiumExecutable(),
    args: ["--font-render-hinting=none", "--disable-lcd-text", "--disable-features=PaintHolding"]
  });
  return activeBrowser;
}

async function copyReportAssets(targetRoot) {
  const sourceAssets = path.join(PUBLIC_DIR, "assets");
  const targetAssets = path.join(targetRoot, "assets");
  await fsp.mkdir(path.join(targetAssets, "fonts"), { recursive: true });
  for (const name of ["report.css", "text-rules.js", "report-runtime.js"]) {
    await fsp.copyFile(path.join(sourceAssets, name), path.join(targetAssets, name));
  }
  for (const name of ["WantedSansVariable.woff2", "OFL.txt"]) {
    await fsp.copyFile(path.join(sourceAssets, "fonts", name), path.join(targetAssets, "fonts", name));
  }
}

async function writeMemberHtml(member, jobDir, usedNames) {
  const baseCandidate = safeFileName(member.name);
  let base = baseCandidate;
  let suffix = 2;
  while (usedNames.has(base.toLowerCase())) base = `${baseCandidate}_${suffix++}`;
  usedNames.add(base.toLowerCase());
  const htmlPath = path.join(jobDir, `${base}.html`);
  await fsp.writeFile(htmlPath, renderReportHtml(member), "utf8");
  return { base, htmlPath, pdfPath: path.join(jobDir, `${base}.pdf`) };
}

async function preflightHtml(htmlPath) {
  const instance = await browser();
  const context = await instance.newContext({ viewport: { width: 1280, height: 720 }, locale: "ko-KR", timezoneId: "Asia/Seoul", deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.__REPORT_READY__ === true, null, { timeout: 30000 });
  await page.emulateMedia({ media: "print" });
  const validation = await page.evaluate(() => window.__REPORT_VALIDATION__);
  if (consoleErrors.length) {
    validation.errors = (validation.errors || []).concat(consoleErrors.map((detail) => ({ type: "CONSOLE", page: 0, element: "browser", detail })));
    validation.ok = false;
  }
  return { context, page, validation };
}

async function renderPdf(page, pdfPath) {
  await page.pdf({
    path: pdfPath,
    width: "13.333333in",
    height: "7.5in",
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
    tagged: true,
    outline: false
  });
}

function parsePdfInfo(output) {
  const pages = Number((output.match(/^Pages:\s+(\d+)/m) || [])[1] || 0);
  const size = (output.match(/^Page size:\s+(.+)$/m) || [])[1] || "";
  return { pages, size };
}

async function renderPdfToPng(pdfPath, qaDir) {
  await fsp.mkdir(qaDir, { recursive: true });
  const prefix = path.join(qaDir, "page");
  await execFileAsync(popplerBinary("pdftoppm"), ["-png", "-r", "72", pdfPath, prefix], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return (await fsp.readdir(qaDir)).filter((name) => /^page-\d+\.png$/i.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((name) => path.join(qaDir, name));
}

async function pngInkRatio(page, pngPath) {
  await page.goto(pathToFileURL(pngPath).href, { waitUntil: "load", timeout: 15000 });
  return page.evaluate(() => {
    const image = document.querySelector("img");
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sampled = 0;
    let ink = 0;
    const step = 8;
    for (let y = 0; y < canvas.height; y += step) {
      for (let x = 0; x < canvas.width; x += step) {
        const index = (y * canvas.width + x) * 4;
        sampled += 1;
        if (data[index] < 246 || data[index + 1] < 246 || data[index + 2] < 246) ink += 1;
      }
    }
    return { width: canvas.width, height: canvas.height, ratio: sampled ? ink / sampled : 0 };
  });
}

async function extractPdfText(pdfPath) {
  const portable = path.join(ROOT_DIR, "runtime", "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs");
  let modulePath = portable;
  if (!fs.existsSync(modulePath)) {
    if (PORTABLE_ONLY) throw new Error("내장 pdfjs-dist 모듈을 찾을 수 없습니다.");
    const packagePath = require.resolve("pdfjs-dist/package.json");
    modulePath = path.join(path.dirname(packagePath), "legacy", "build", "pdf.mjs");
  }
  const pdfjs = await import(pathToFileURL(modulePath).href);
  const data = new Uint8Array(await fsp.readFile(pdfPath));
  const document = await pdfjs.getDocument({ data, disableWorker: true, useSystemFonts: false }).promise;
  const pageTexts = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const pdfPage = await document.getPage(number);
    const content = await pdfPage.getTextContent();
    pageTexts.push(content.items.map((item) => item.str).join(" ").trim());
  }
  return pageTexts;
}

async function postflightPdf(pdfPath, expectedPages, qaRoot) {
  const errors = [];
  const warnings = [];
  const infoOutput = await execFileAsync(popplerBinary("pdfinfo"), [pdfPath], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  const info = parsePdfInfo(infoOutput.stdout);
  if (info.pages !== expectedPages) errors.push({ type: "PDF_PAGE_COUNT", page: 0, element: "pdf", detail: { expected: expectedPages, actual: info.pages } });
  const pngFiles = await renderPdfToPng(pdfPath, qaRoot);
  if (pngFiles.length !== expectedPages) errors.push({ type: "PDF_RENDER_COUNT", page: 0, element: "pdf", detail: { expected: expectedPages, actual: pngFiles.length } });
  const instance = await browser();
  const qaContext = await instance.newContext({ viewport: { width: 1280, height: 720 } });
  const qaPage = await qaContext.newPage();
  const rendered = [];
  for (let index = 0; index < pngFiles.length; index += 1) {
    const stat = await fsp.stat(pngFiles[index]);
    const visual = await pngInkRatio(qaPage, pngFiles[index]);
    rendered.push({ page: index + 1, bytes: stat.size, width: visual.width, height: visual.height, inkRatio: Number(visual.ratio.toFixed(5)) });
    if (stat.size < 5000 || visual.ratio < 0.002) errors.push({ type: "PDF_BLANK_PAGE", page: index + 1, element: "pdf-render", detail: rendered[rendered.length - 1] });
  }
  await qaContext.close();
  const pageTexts = await extractPdfText(pdfPath);
  pageTexts.forEach((text, index) => {
    if (text.length < 8) errors.push({ type: "PDF_TEXT_MISSING", page: index + 1, element: "pdf-text", detail: { length: text.length } });
  });
  return { ok: errors.length === 0, errors, warnings, pageCount: info.pages, pageSize: info.size, rendered, searchableText: pageTexts.every((text) => text.length >= 8) };
}

async function renderMember(member, paths, jobDir) {
  let session;
  try {
    session = await preflightHtml(paths.htmlPath);
    const preflight = session.validation;
    if (!preflight.ok) {
      return { name: member.name, ok: false, stage: "preflight", errors: preflight.errors || [], warnings: preflight.warnings || [], pageCount: preflight.pageCount || 0 };
    }
    await renderPdf(session.page, paths.pdfPath);
    await session.context.close();
    session = null;
    const postflight = await postflightPdf(paths.pdfPath, preflight.pageCount, path.join(jobDir, ".qa", paths.base));
    if (!postflight.ok) {
      await fsp.rm(paths.pdfPath, { force: true });
      return { name: member.name, ok: false, stage: "postflight", errors: postflight.errors, warnings: postflight.warnings, pageCount: postflight.pageCount };
    }
    return { name: member.name, ok: true, stage: "complete", errors: [], warnings: preflight.warnings.concat(postflight.warnings), pageCount: postflight.pageCount, pageSize: postflight.pageSize, searchableText: postflight.searchableText, html: `${paths.base}.html`, pdf: `${paths.base}.pdf`, rendered: postflight.rendered };
  } catch (error) {
    return { name: member.name, ok: false, stage: "exception", errors: [{ type: "EXCEPTION", page: 0, element: "server", detail: error.message }], warnings: [], pageCount: 0 };
  } finally {
    if (session && session.context) await session.context.close().catch(() => {});
  }
}

async function addDirectoryToZip(zip, root, current = "") {
  const directory = path.join(root, current);
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".qa" || entry.name.endsWith(".zip")) continue;
    const relative = path.join(current, entry.name);
    if (entry.isDirectory()) await addDirectoryToZip(zip, root, relative);
    else zip.file(relative.replace(/\\/g, "/"), await fsp.readFile(path.join(root, relative)));
  }
}

async function makeZip(job) {
  const zip = new JSZip();
  await addDirectoryToZip(zip, job.dir);
  const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" });
  const file = path.join(job.dir, "yourssu_peer_review_html_pdf.zip");
  await fsp.writeFile(file, output);
  return file;
}

async function runJob(job) {
  job.status = "running";
  job.message = "생성 준비 중";
  const usedNames = new Set();
  await fsp.mkdir(job.dir, { recursive: true });
  await copyReportAssets(job.dir);
  for (let index = 0; index < job.members.length; index += 1) {
    if (job.cancelled) {
      job.status = "cancelled";
      job.message = "사용자가 생성을 취소했습니다.";
      return;
    }
    const member = job.members[index];
    job.message = `${index + 1} / ${job.total} · ${member.name} HTML/PDF 생성 및 검증 중`;
    const paths = await writeMemberHtml(member, job.dir, usedNames);
    const result = await renderMember(member, paths, job.dir);
    job.results.push(Object.assign({}, result, {
      infoTeam: member.infoTeam,
      connectionStatus: member.connectionStatus,
      connectionSource: member.connectionSource
    }));
    job.completed = index + 1;
  }
  const validation = {
    generator: "Yourssu HTML PDF Generator",
    renderer: "Playwright Chromium 1.61.1 / Chromium 1228",
    font: "Wanted Sans Variable",
    total: job.total,
    passed: job.results.filter((result) => result.ok).length,
    failed: job.results.filter((result) => !result.ok).length,
    results: job.results
  };
  await fsp.writeFile(path.join(job.dir, "validation-results.json"), JSON.stringify(validation, null, 2), "utf8");
  if (validation.failed > 0) {
    job.status = "failed";
    job.error = `${validation.failed}명의 리포트가 검증을 통과하지 못했습니다. PDF는 생성하지 않았습니다.`;
    job.message = job.error;
    return;
  }
  job.zipPath = await makeZip(job);
  job.status = "complete";
  job.message = `${job.total}명 모두 검증 완료`;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    message: job.message,
    error: job.error || "",
    results: job.results,
    downloadUrl: job.status === "complete" ? `/api/jobs/${encodeURIComponent(job.id)}/download` : ""
  };
}

async function createPreview(member) {
  const id = createId("preview");
  const dir = path.join(GENERATED_DIR, "previews", id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${safeFileName(member.name)}.html`), renderReportHtml(member), "utf8");
  return { id, name: `${safeFileName(member.name)}.html` };
}

function validateMemberConnection(member) {
  if (!member || !String(member.name || "").trim()) return "대상자 이름이 없습니다.";
  if (member.connectionStatus !== "ok") return `${member.name}: info.xlsx 연결이 확인되지 않았습니다.`;
  if (!String(member.infoTeam || "").trim()) return `${member.name}: info.xlsx의 팀명이 비어 있습니다.`;
  return "";
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  const pathname = decodeURIComponent(url.pathname);
  if (req.method === "GET" && pathname === "/api/health") {
    return json(res, 200, { ok: true, app: "yourssu-peer-review-generator", version: 1 });
  }
  if (req.method === "GET" && pathname === "/") return sendFile(res, path.join(PUBLIC_DIR, "index.html"));
  if (req.method === "GET" && pathname.startsWith("/assets/")) {
    const file = safeResolve(PUBLIC_DIR, pathname);
    return file ? sendFile(res, file) : json(res, 403, { error: "잘못된 경로입니다." });
  }
  if (req.method === "POST" && pathname === "/api/preview") {
    const body = await readJsonBody(req);
    if (!body.member || !body.member.name) return json(res, 400, { error: "대상자 데이터가 없습니다." });
    const connectionError = validateMemberConnection(body.member);
    if (connectionError) return json(res, 400, { error: connectionError });
    const preview = await createPreview(body.member);
    return json(res, 200, { url: `/preview/${encodeURIComponent(preview.id)}/${encodeURIComponent(preview.name)}` });
  }
  if (req.method === "GET" && pathname.startsWith("/preview/")) {
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length < 3) return json(res, 404, { error: "미리보기를 찾지 못했습니다." });
    if (parts[2] === "assets") {
      const asset = safeResolve(path.join(PUBLIC_DIR, "assets"), parts.slice(3).join("/"));
      return asset ? sendFile(res, asset) : json(res, 403, { error: "잘못된 경로입니다." });
    }
    const file = safeResolve(path.join(GENERATED_DIR, "previews", parts[1]), parts.slice(2).join("/"));
    return file ? sendFile(res, file) : json(res, 403, { error: "잘못된 경로입니다." });
  }
  if (req.method === "POST" && pathname === "/api/jobs") {
    const body = await readJsonBody(req);
    if (!Array.isArray(body.members) || !body.members.length) return json(res, 400, { error: "생성할 대상자가 없습니다." });
    const connectionErrors = body.members.map(validateMemberConnection).filter(Boolean);
    if (connectionErrors.length) return json(res, 400, { error: `대상자 팀 연결 오류: ${connectionErrors.join(" / ")}` });
    const id = createId("job");
    const job = { id, status: "queued", members: body.members, total: body.members.length, completed: 0, message: "대기 중", results: [], dir: path.join(GENERATED_DIR, "jobs", id), zipPath: "", cancelled: false };
    jobs.set(id, job);
    runJob(job).catch((error) => {
      job.status = "failed";
      job.error = error.stack || error.message;
      job.message = "서버 오류로 생성에 실패했습니다.";
    });
    return json(res, 202, { jobId: id });
  }
  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === "GET" && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    return job ? json(res, 200, publicJob(job)) : json(res, 404, { error: "작업을 찾지 못했습니다." });
  }
  const cancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelMatch) {
    const job = jobs.get(cancelMatch[1]);
    if (!job) return json(res, 404, { error: "작업을 찾지 못했습니다." });
    job.cancelled = true;
    return json(res, 200, { ok: true });
  }
  const downloadMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/download$/);
  if (req.method === "GET" && downloadMatch) {
    const job = jobs.get(downloadMatch[1]);
    if (!job || job.status !== "complete" || !job.zipPath) return json(res, 404, { error: "다운로드 파일이 준비되지 않았습니다." });
    return sendFile(res, job.zipPath, job.total === 1 ? `${safeFileName(job.members[0].name)}_html_pdf.zip` : "yourssu_peer_review_html_pdf.zip");
  }
  json(res, 404, { error: "요청한 주소가 없습니다." });
}

async function start() {
  await fsp.mkdir(GENERATED_DIR, { recursive: true });
  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) json(res, 500, { error: error.message || "서버 오류가 발생했습니다." });
      else res.end();
    });
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Yourssu generator: http://localhost:${PORT}`);
  });
  const shutdown = async () => {
    server.close();
    if (activeBrowser) await activeBrowser.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
