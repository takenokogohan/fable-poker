// Measure cluster iteration speed on a real flop spot (light tree).
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

await page.goto("http://app.test/");
await page.waitForSelector(".line-builder");
// default scenario: BTN vs BB SRP; rainbow flop (worst case for isomorphism)
await page.fill(".board-input input", "Ks7h2d");
await page.fill('input[type="number"][min="20"]', "20");

const t0 = Date.now();
await page.click(".solve-btn");
await page.waitForSelector(".solve-status", { timeout: 300000 });
const initMs = Date.now() - t0;
const workers = await page.evaluate(() => {
  const m = document.body.textContent.match(/ワーカー\s*(\d+)/);
  return m ? +m[1] : 0;
});
const memMB = await page.evaluate(() => {
  const m = document.body.textContent.match(/メモリ\s*(\d+)\s*MB/);
  return m ? +m[1] : 0;
});
console.log(`init: ${(initMs / 1000).toFixed(1)}s, workers=${workers}, memory=${memMB}MB`);

let last = 0;
let lastT = Date.now();
const interval = setInterval(async () => {
  try {
    const it = await page.evaluate(() => {
      const els = document.querySelectorAll(".status-item b");
      return els.length >= 2 ? parseInt(els[1].textContent) : 0;
    });
    if (it > last) {
      const now = Date.now();
      console.log(
        `iter ${it}: ${(((now - lastT) / (it - last)) / 1000).toFixed(2)}s/iter`
      );
      last = it;
      lastT = now;
    }
  } catch {
    /* page busy */
  }
}, 2000);

await page.waitForFunction(
  () => {
    const els = document.querySelectorAll(".status-item b");
    return els.length >= 2 && parseInt(els[1].textContent) >= 20;
  },
  { timeout: 900000 }
);
clearInterval(interval);
const totalMs = Date.now() - t0;
const expl = await page.evaluate(() => {
  const m = document.body.textContent.match(/([\d.]+)% pot/);
  return m ? +m[1] : -1;
});
console.log(
  `20 iterations in ${(totalMs / 1000).toFixed(0)}s total (${(
    totalMs /
    20 /
    1000
  ).toFixed(2)}s/iter incl. BR), expl=${expl}% pot`
);
console.log("PERF TEST DONE");
await browser.close();
