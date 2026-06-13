// E2E: upload a Ten-Four hand image and verify the in-browser parse + solve +
// evaluation pipeline produces results.
import { chromium } from "playwright";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";

const DIST = new URL("./dist", import.meta.url).pathname;
const SAMPLE = "/Users/takenokogohan/sandbox/poker-analyzer/example_images/IMG_5540.PNG";
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".png": "image/png", ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

const browser = await chromium.launch({ args: ["--single-process", "--no-zygote"] });
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, hasTouch: true, isMobile: true });
await ctx.route("http://app.test/**", (route) => {
  const url = new URL(route.request().url());
  const file = join(DIST, url.pathname === "/" ? "/index.html" : url.pathname);
  if (existsSync(file) === false) return route.fulfill({ status: 404, body: "nf" });
  route.fulfill({ status: 200, contentType: MIME[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto("http://app.test/");
await page.waitForSelector(".image-entry");
await page.click(".image-entry");
await page.waitForSelector('input[type="file"]');
await page.setInputFiles('input[type="file"]', SAMPLE);

// parse result should appear quickly
await page.waitForSelector(".img-summary", { timeout: 30000 });
const summary = (await page.textContent(".img-summary")).replace(/\s+/g, " ");
console.log("parsed:", summary);
if (!summary.includes("BB")) throw new Error("hero position not BB");
if (!/A♠Q♠|Q♠A♠/.test(summary)) throw new Error("hero cards not A♠Q♠: " + summary);
if (!summary.includes("3betポット")) throw new Error("pot type not 3bet");

// solve + evaluation
await page.waitForSelector(".eval-table", { timeout: 300000 });
const rows = await page.$$(".eval-table tbody tr");
console.log("eval rows:", rows.length);
const tableText = (await page.textContent(".eval-table")).replace(/\s+/g, " ");
console.log("eval:", tableText);
if (rows.length < 1) throw new Error("no evaluation rows");

await page.screenshot({ path: process.env.TMPDIR + "/ui-image-analyze.png", fullPage: true });

if (errors.length) { console.error("PAGE ERRORS:", errors.slice(0, 5)); process.exit(1); }
console.log("IMAGE ANALYZE TEST PASSED");
await browser.close();
