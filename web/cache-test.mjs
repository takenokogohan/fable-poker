// Verify the IndexedDB cache: solve once, return to config, solve the same
// spot again -> it must restore instantly. Then measure cluster vs mono speed
// on a flop spot.
import { chromium } from "playwright";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";

const DIST = new URL("./dist", import.meta.url).pathname;
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
};

const browser = await chromium.launch({ args: ["--single-process", "--no-zygote"] });
const ctx = await browser.newContext();
await ctx.route("http://app.test/**", (route) => {
  const url = new URL(route.request().url());
  const file = join(DIST, url.pathname === "/" ? "/index.html" : url.pathname);
  if (existsSync(file) === false) return route.fulfill({ status: 404, body: "nf" });
  route.fulfill({
    status: 200,
    contentType: MIME[extname(file)] ?? "application/octet-stream",
    body: readFileSync(file),
  });
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));

const waitForIters = (n, timeout) =>
  page.waitForFunction(
    (target) => {
      const els = document.querySelectorAll(".status-item b");
      return els.length >= 2 && parseInt(els[1].textContent) >= target;
    },
    n,
    { timeout }
  );

await page.goto("http://app.test/");
await page.waitForSelector(".line-builder");
await page.fill(".board-input input", "Ks7h2d8c");
await page.fill('input[type="number"][min="20"]', "50");

// first solve
let t0 = Date.now();
await page.click(".solve-btn");
await waitForIters(50, 300000);
const firstMs = Date.now() - t0;
console.log(`first solve to 50 iters: ${(firstMs / 1000).toFixed(1)}s`);
// wait for cache save to finish
await page.waitForFunction(
  () => document.body.textContent.includes("キャッシュ保存済み"),
  { timeout: 60000 }
);
console.log("cache saved");

// back to config, solve same spot again
await page.click(".back-btn");
await page.waitForSelector(".line-builder");
await page.fill(".board-input input", "Ks7h2d8c");
await page.fill('input[type="number"][min="20"]', "50");
t0 = Date.now();
await page.click(".solve-btn");
await page.waitForSelector(".solve-status", { timeout: 60000 });
await waitForIters(50, 30000);
const secondMs = Date.now() - t0;
const restored = await page.evaluate(() =>
  document.body.textContent.includes("キャッシュから復元")
);
console.log(
  `second solve ready in ${(secondMs / 1000).toFixed(1)}s, restored=${restored}`
);
if (restored === false) throw new Error("cache restore did not happen");
if (secondMs > firstMs / 2) throw new Error("restore not faster than solving");
console.log("CACHE TEST PASSED");
await browser.close();
