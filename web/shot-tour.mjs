// Screenshot tour of every view at iPhone size to hunt layout breakage.
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
const OUT = process.env.TMPDIR + "/tour-";

const browser = await chromium.launch({ args: ["--single-process", "--no-zygote"] });
const context = await browser.newContext({
  viewport: { width: 402, height: 739 }, // iPhone 16 Pro safari portrait
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
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
await page.waitForSelector(".line-builder");

// horizontal overflow check helper
const overflow = () =>
  page.evaluate(() => {
    const bad = [];
    const docW = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > docW + 1)
      bad.push(`PAGE scrollWidth ${document.documentElement.scrollWidth} > ${docW}`);
    for (const el of document.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.right > docW + 1 && r.width > 8) {
        bad.push(
          `${el.tagName}.${String(el.className).slice(0, 40)} right=${r.right.toFixed(0)}`
        );
        if (bad.length > 8) break;
      }
    }
    return bad;
  });

console.log("== config top ==", await overflow());
await page.screenshot({ path: OUT + "1-config-top.png" });
await page.evaluate(() => window.scrollTo(0, 99999));
await page.screenshot({ path: OUT + "2-config-bottom.png" });

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
console.log("== solve view ==", await overflow());
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: OUT + "3-solve-top.png" });

// open hand detail with EV + equity on
const checks = await page.$$('.overlay-toggles input[type="checkbox"]');
await checks[0].check();
await checks[1].check();
await page.waitForTimeout(4000);
await page.locator(".strat-cell:not(.empty)").first().tap();
await page.waitForSelector(".hand-detail", { timeout: 15000 });
await page.waitForTimeout(500);
console.log("== detail open ==", await overflow());
await page.locator(".hand-detail").scrollIntoViewIfNeeded();
await page.screenshot({ path: OUT + "4-detail.png" });

// descend to chance node (check/check)
const btns = await page.$$(".action-btn");
await btns[0].click();
await page.waitForTimeout(1000);
const btns2 = await page.$$(".action-btn");
await btns2[0].click();
await page.waitForTimeout(1500);
console.log("== chance view ==", await overflow());
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: OUT + "5-chance.png" });

console.log("done");
await browser.close();
