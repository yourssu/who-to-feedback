import { resolve } from "node:path";
export interface PdfConverter {
  convert(html: string): Promise<Uint8Array>;
}
/** A separate TS worker gives Chromium conversion a hard time limit. */
export class ChromiumPdfConverter implements PdfConverter {
  async convert(html: string) {
    if (Buffer.byteLength(html) > 32 * 1024 * 1024)
      throw new Error("보고서 HTML은 최대 32MB입니다.");
    const child = Bun.spawn(
      [process.execPath, resolve("src/reporting/pdf-worker.ts")],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 60000);
    try {
      child.stdin.write(html);
      child.stdin.end();
      const [buffer, stderr, code] = await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (timedOut) throw new Error("PDF 변환 시간이 초과되었습니다.");
      if (code !== 0) throw new Error(`PDF 변환 실패: ${stderr.slice(-1500)}`);
      const bytes = new Uint8Array(buffer);
      if (
        bytes.length > 64 * 1024 * 1024 ||
        new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-"
      )
        throw new Error("유효한 PDF를 생성하지 못했습니다.");
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  }
}
