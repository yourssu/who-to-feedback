import { chromium } from "playwright";
import { reportPrintStyle } from "./print-style";
const html = await Bun.stdin.text();
const executablePath =
  process.env.PDF_CHROMIUM_EXECUTABLE ??
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch({ executablePath, timeout: 30000 });
process.on("SIGTERM", () => {
  void browser.close().finally(() => process.exit(1));
});
try {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    serviceWorkers: "block",
    viewport: { width: 1280, height: 720 },
  });
  await context.route("**/*", (route) => route.abort());
  const page = await context.newPage();
  // With page JavaScript disabled, promise-based DOM helpers cannot complete.
  // Load print CSS with the HTML and let Chromium's print pipeline resolve fonts.
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
  await Bun.write(Bun.stdout, bytes);
} finally {
  await browser.close();
}
