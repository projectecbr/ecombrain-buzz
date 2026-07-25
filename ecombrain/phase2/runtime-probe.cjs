// Runtime probe for the Phase 2 baseline: loads the web bundle in headless
// Chrome, captures console errors / page errors / failed requests.
// Usage: pnpm vite preview --config vite.web.config.ts --port 4599 &
//        node ecombrain/phase2/runtime-probe.cjs
const path = require("node:path");
const { createRequire } = require("node:module");
// Resolve @playwright/test from the desktop package (this script lives
// outside the desktop workspace).
const desktopRequire = createRequire(
  path.join(__dirname, "../../desktop/package.json"),
);
const { chromium } = desktopRequire("@playwright/test");

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      consoleErrors.push(`[${msg.type()}] ${msg.text()}`.slice(0, 500));
    }
  });
  page.on("pageerror", (err) =>
    pageErrors.push(String(err.stack || err).slice(0, 800)),
  );
  page.on("requestfailed", (req) =>
    failedRequests.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText}`),
  );

  await page.goto("http://localhost:4599/", { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(10000);

  const rootHtml = await page.evaluate(() => {
    const root = document.getElementById("root");
    return {
      childCount: root ? root.childElementCount : -1,
      textSnippet: root ? root.textContent.slice(0, 300) : "(no #root)",
      title: document.title,
    };
  });

  console.log("=== ROOT ===");
  console.log(JSON.stringify(rootHtml, null, 2));
  console.log("=== PAGE ERRORS (uncaught) ===");
  pageErrors.forEach((e) => console.log(e, "\n---"));
  console.log(`(${pageErrors.length} total)`);
  console.log("=== CONSOLE ERRORS/WARNINGS ===");
  consoleErrors.forEach((e) => console.log(e, "\n---"));
  console.log(`(${consoleErrors.length} total)`);
  console.log("=== FAILED REQUESTS ===");
  failedRequests.forEach((e) => console.log(e));
  console.log(`(${failedRequests.length} total)`);

  await browser.close();
})();
