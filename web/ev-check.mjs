// Visual check: preflop builder (EP vs SB 3BET like the GTO Wizard video) and
// the EV convention (fold = 0) at a facing-bet node.
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

const browser = await chromium.launch({
  args: ["--single-process", "--no-zygote"],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 960 },
});
await context.route("http://app.test/**", (route) => {
  const url = new URL(route.request().url());
  const file = join(DIST, url.pathname === "/" ? "/index.html" : url.pathname);
  if (!existsSync(file)) return route.fulfill({ status: 404, body: "nf" });
  route.fulfill({
    status: 200,
    contentType: MIME[extname(file)] ?? "application/octet-stream",
    body: readFileSync(file),
  });
});

const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.goto("http://app.test/");
await page.waitForSelector(".line-builder");

// EP open, SB 3bets (the video's spot), turn-ish board for speed: Qd8s6c + 2h
await page.click('.pos-btn:has-text("EP") >> nth=0');
await page.click('.pos-group:nth-child(2) .pos-btn:has-text("SB")');
await page.click('.pos-btn:has-text("3BET")');
await page.waitForTimeout(300);
console.log("scenario:", await page.textContent(".scenario-desc"));
const potVal = await page.inputValue(".pot-stack input >> nth=0");
const stackVal = await page.inputValue(".pot-stack input >> nth=1");
console.log(`pot=${potVal} stack=${stackVal} (video: 23.5 / 88.75)`);
await page.screenshot({ path: process.env.TMPDIR + "/ui-builder.png" });

await page.fill(".board-input input", "Qd8s6c2h");
await page.fill('input[type="number"][min="20"]', "80");
await page.click(".solve-btn");
await page.waitForSelector(".solve-status", { timeout: 60000 });
await page.waitForFunction(
  () => {
    const els = document.querySelectorAll(".status-item b");
    return els.length >= 2 && parseInt(els[1].textContent) >= 80;
  },
  { timeout: 300000 }
);

// turn on EV, descend: OOP(SB) check -> IP(EP) bet -> SB facing bet
await page.check('.overlay-toggles input[type="checkbox"] >> nth=0');
await page.waitForTimeout(2500);
const btns0 = await page.$$(".action-btn");
await btns0[0].click(); // check
await page.waitForTimeout(1500);
const btns1 = await page.$$(".action-btn");
await btns1[btns1.length - 1].click(); // biggest bet
await page.waitForTimeout(2500);

// open detail of a non-empty cell and read fold EV
await page.waitForSelector(".strat-cell:not(.empty)");
await (await page.$(".strat-cell:not(.empty)")).click();
await page.waitForSelector(".hand-detail");
const evCell = await page.textContent(".hand-detail tbody tr td:nth-child(4)");
console.log("EV cell (first combo):", evCell?.trim());
await page.screenshot({
  path: process.env.TMPDIR + "/ui-ev.png",
  fullPage: true,
});
console.log("EV CHECK DONE");
await browser.close();
