// Render public/icon.svg to the PNG sizes the manifest needs.
import { chromium } from "playwright";
import { readFileSync } from "fs";

const svg = readFileSync(new URL("./public/icon.svg", import.meta.url), "utf8");
const browser = await chromium.launch({ args: ["--single-process", "--no-zygote"] });
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
for (const size of [512, 192]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0"><div style="width:${size}px;height:${size}px">${svg.replace(
      "<svg ",
      `<svg width="${size}" height="${size}" `
    )}</div></body>`
  );
  await page.screenshot({
    path: new URL(`./public/icon-${size}.png`, import.meta.url).pathname,
    omitBackground: true,
  });
}
await browser.close();
console.log("icons generated");
