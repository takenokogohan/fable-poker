// E2E: drive the UI through a turn-spot solve and verify the strategy matrix.
// The sandbox forbids listening on sockets, so we serve the dist build via
// Playwright request interception instead of a dev server.
import { chromium } from "playwright";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";

const DIST = new URL("./dist", import.meta.url).pathname;
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
};

const browser = await chromium.launch({
  args: ["--single-process", "--no-zygote"],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 960 },
});
await context.route("http://app.test/**", (route) => {
  const url = new URL(route.request().url());
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = join(DIST, path);
  if (!existsSync(file)) {
    return route.fulfill({ status: 404, body: "not found" });
  }
  route.fulfill({
    status: 200,
    contentType: MIME[extname(file)] ?? "application/octet-stream",
    body: readFileSync(file),
  });
});

const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

await page.goto("http://app.test/");
await page.waitForSelector("h1");
console.log("title:", await page.textContent("h1"));

// config screen: set a turn board for a fast solve
await page.fill(".board-input input", "Ks7h2d8c");
await page.fill('input[type="number"][min="20"]', "60");
await page.screenshot({ path: process.env.TMPDIR + "/ui-config.png" });
await page.click(".solve-btn");

await page.waitForSelector(".solve-status", { timeout: 60000 });
console.log("solve view loaded");

await page.waitForFunction(
  () => {
    const els = document.querySelectorAll(".status-item b");
    return els.length >= 2 && parseInt(els[1].textContent) >= 60;
  },
  { timeout: 300000 }
);
const status = await page.textContent(".solve-status");
console.log("status:", status.replace(/\s+/g, " ").slice(0, 160));

const cells = await page.$$(".strat-cell");
console.log("strategy cells:", cells.length);
if (cells.length !== 169) throw new Error("matrix not rendered");

const actionBtns = await page.$$(".action-btn");
console.log("actions:", actionBtns.length);
await actionBtns[actionBtns.length - 1].click();
await page.waitForFunction(
  () => document.querySelectorAll(".crumb").length >= 2,
  { timeout: 30000 }
);
console.log("descended; crumbs:", (await page.$$(".crumb")).length);

await page.waitForSelector(".strat-cell:not(.empty)");
const cell = await page.$(".strat-cell:not(.empty)");
await cell.click();
await page.waitForSelector(".hand-detail", { timeout: 15000 });
const rows = await page.$$(".hand-detail tbody tr");
console.log("hand detail rows:", rows.length);

// toggle equity overlay (second checkbox)
const checks = await page.$$('.overlay-toggles input[type="checkbox"]');
await checks[1].check();
await page.waitForTimeout(4000);

await page.screenshot({
  path: process.env.TMPDIR + "/ui-solve.png",
  fullPage: true,
});

await page.click(".crumb >> nth=0");
await page.waitForTimeout(1000);

if (errors.length) {
  console.error("PAGE ERRORS:", errors.slice(0, 5));
  process.exit(1);
}
console.log("UI TEST PASSED");
await browser.close();
