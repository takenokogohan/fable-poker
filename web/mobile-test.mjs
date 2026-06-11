// Mobile + offline E2E:
// 1. iPhone-sized touch viewport: layout, touch range painting, solve, detail
// 2. Service worker: load once online, cut the network, reload, solve again
import { chromium } from "playwright";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";

const DIST = new URL("./dist", import.meta.url).pathname;
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const browser = await chromium.launch({
  args: [
    "--single-process",
    "--no-zygote",
    // lets the service worker register on plain http://app.test
    "--unsafely-treat-insecure-origin-as-secure=http://app.test",
  ],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
});
const serve = (route) => {
  const url = new URL(route.request().url());
  const file = join(DIST, url.pathname === "/" ? "/index.html" : url.pathname);
  if (existsSync(file) === false)
    return route.fulfill({ status: 404, body: "nf" });
  route.fulfill({
    status: 200,
    contentType: MIME[extname(file)] ?? "application/octet-stream",
    body: readFileSync(file),
  });
};
await context.route("http://app.test/**", serve);

const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// ---- mobile layout & touch ----
await page.goto("http://app.test/");
await page.waitForSelector(".line-builder");
console.log("mobile config screen loaded");

// touch-paint: tap an empty range cell and check it toggles
const cell = page.locator(".paint-matrix >> nth=0 >> [data-cell] >> nth=168"); // 22
const before = await cell
  .locator(".cell-fill")
  .evaluate((el) => el.style.background);
await cell.tap();
const after = await cell
  .locator(".cell-fill")
  .evaluate((el) => el.style.background);
if (before === after) throw new Error("touch paint did not toggle the cell");
console.log("touch painting works");
await cell.tap(); // restore

await page.screenshot({ path: process.env.TMPDIR + "/ui-mobile-config.png" });

// solve a turn spot
await page.fill(".board-input input", "Ks7h2d8c");
await page.fill('input[type="number"][min="20"]', "40");
await page.locator(".solve-btn").scrollIntoViewIfNeeded();
await page.locator(".solve-btn").click({ force: true });
await page.waitForSelector(".solve-status", { timeout: 60000 });
await page.waitForFunction(
  () => {
    const els = document.querySelectorAll(".status-item b");
    return els.length >= 2 && parseInt(els[1].textContent) >= 40;
  },
  { timeout: 300000 }
);
const cells = await page.$$(".strat-cell");
if (cells.length !== 169) throw new Error("matrix not rendered");
await page.locator(".strat-cell:not(.empty)").first().tap();
await page.waitForSelector(".hand-detail", { timeout: 15000 });
console.log("mobile solve + tap detail works");
await page.screenshot({ path: process.env.TMPDIR + "/ui-mobile-solve.png" });
// wait for cache save so the offline pass can restore it
await page.waitForFunction(
  () => document.body.textContent.includes("キャッシュ保存済み"),
  { timeout: 60000 }
);

// ---- offline via service worker ----
const swState = await page.evaluate(async () => {
  if ("serviceWorker" in navigator === false) return "unsupported";
  const reg = await navigator.serviceWorker.ready;
  return reg.active ? "active" : "no-active";
});
console.log("service worker:", swState);
if (swState !== "active") throw new Error("service worker not active");
// give precache a moment to finish
await page.waitForTimeout(1500);

// cut the network entirely: unroute -> requests to app.test now fail unless
// the service worker serves them from cache
await context.unroute("http://app.test/**");
await context.route("http://app.test/**", (route) => route.abort());

await page.reload();
await page.waitForSelector(".line-builder", { timeout: 30000 });
console.log("offline reload: app shell loaded from SW cache");

// solve offline (wasm + worker scripts must come from the cache too)
await page.fill(".board-input input", "Ks7h2d8c");
await page.fill('input[type="number"][min="20"]', "40");
await page.locator(".solve-btn").scrollIntoViewIfNeeded();
await page.locator(".solve-btn").click({ force: true });
await page.waitForSelector(".solve-status", { timeout: 60000 });
await page.waitForFunction(
  () => {
    const els = document.querySelectorAll(".status-item b");
    return els.length >= 2 && parseInt(els[1].textContent) >= 40;
  },
  { timeout: 300000 }
);
const restored = await page.evaluate(() =>
  document.body.textContent.includes("キャッシュから復元")
);
console.log(`offline solve works (cache restored=${restored})`);

if (errors.length) {
  console.error("PAGE ERRORS:", errors.slice(0, 5));
  process.exit(1);
}
console.log("MOBILE + OFFLINE TEST PASSED");
await browser.close();
