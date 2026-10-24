import puppeteer from "@cloudflare/puppeteer";
import { reportPrintStyle } from "../reporting/print-style";
export async function convertPdf(binding: Fetcher, html: string) {
  if (Buffer.byteLength(html) > 32 * 1024 * 1024)
    throw new Error("HTML exceeds 32 MiB");
  const browser = await puppeteer.launch(
    binding as unknown as Parameters<typeof puppeteer.launch>[0],
  );
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      void (request.url().startsWith("data:")
        ? request.continue()
        : request.abort());
    });
    await page.setViewport({ width: 1280, height: 720 });
    await page.setContent(html + `<style>${reportPrintStyle}</style>`, {
      waitUntil: "load",
      timeout: 30000,
    });
    const bytes = await page.pdf({
      width: "1280px",
      height: "720px",
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      printBackground: true,
      preferCSSPageSize: true,
    });
    if (bytes.byteLength > 64 * 1024 * 1024)
      throw new Error("PDF exceeds 64 MiB");
    return bytes;
  } finally {
    await browser.close();
  }
}
