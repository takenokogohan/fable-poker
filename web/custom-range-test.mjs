// Verify: edit a range -> 保存 -> reload -> custom range auto-applies;
// プリセットに戻す -> reverts. Also re-check the mobile import/header overlap.
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
const context = await browser.newContext({
  viewport: { width: 402, height: 739 },
  hasTouch: true,
  isMobile: true,
});
await context.route("http://app.test/**", (route) => {
  const url = new URL(route.request().url());
  const file = join(DIST, url.pathname === "/" ? "/index.html" : url.pathname);
  if (existsSync(file) === false) return route.fulfill({ status: 404, body: "nf" });
  route.fulfill({
    status: 200,
    contentType: MIME[extname(file)] ?? "application/octet-stream",
    body: readFileSync(file),
  });
});
const page = await context.newPage();
await page.goto("http://app.test/");
await page.waitForSelector(".ranges-row");

// overlap re-check
const overlap = await page.evaluate(() => {
  const eds = [...document.querySelectorAll(".range-editor")];
  const imp = eds[0].querySelector(".range-import").getBoundingClientRect();
  const hdr = eds[1].querySelector(".range-header").getBoundingClientRect();
  return imp.bottom > hdr.top + 1;
});
console.log("import/header overlap:", overlap);
if (overlap) throw new Error("still overlapping");

const pct = () => page.textContent(".range-pct >> nth=0");
const before = await pct();
// paint a cell (toggle 22 on/off) to change the range, then save
await page
  .locator(".paint-matrix >> nth=0 >> [data-cell] >> nth=168")
  .tap();
const edited = await pct();
console.log(`edit: ${before} -> ${edited}`);
await page.locator(".range-editor >> nth=0 >> .save-btn").click();
await page.waitForSelector(".custom-badge");
console.log("saved; badge visible");

// reload: custom range must auto-apply
await page.reload();
await page.waitForSelector(".ranges-row");
const afterReload = await pct();
const badge = await page.locator(".custom-badge").count();
console.log(`after reload: ${afterReload} (badge=${badge})`);
if (afterReload !== edited || badge < 1) throw new Error("custom range not restored");

// per-side tightness: OOP tight + IP loose simultaneously
const oopPill = (label) =>
  page.locator(`.range-editor >> nth=0 >> .pill:has-text("${label}")`);
const ipPill = (label) =>
  page.locator(`.range-editor >> nth=1 >> .pill:has-text("${label}")`);
await oopPill("タイト").click();
await ipPill("ルース").click();
await page.waitForTimeout(200);
const oopPct = await page.textContent(".range-pct >> nth=0");
const ipPct = await page.textContent(".range-pct >> nth=1");
console.log(`mixed tightness: OOP(tight)=${oopPct} IP(loose)=${ipPct}`);
if (parseFloat(oopPct) >= parseFloat(ipPct))
  throw new Error("tight OOP should be narrower than loose IP");
// the tight slot has no custom saved -> no badge
const tightBadges = await page.locator(".custom-badge").count();
console.log(`mixed slot badges: ${tightBadges} (expect 0)`);
await oopPill("ノーマル").click();
await ipPill("ノーマル").click();
await page.waitForTimeout(200);

// reset to preset
await page.locator('.range-editor >> nth=0 >> button:has-text("プリセットに戻す")').click();
await page.waitForTimeout(200);
const afterReset = await pct();
console.log(`after reset: ${afterReset} (expect ${before})`);
if (afterReset !== before) throw new Error("reset did not revert");
console.log("CUSTOM RANGE TEST PASSED");
await browser.close();
