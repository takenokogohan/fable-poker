// Debug: dump all detected colored chips (cx,cy,suit) for one image.
import { PNG } from "pngjs";
import { readFileSync, mkdtempSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const file = process.argv[2];
const out = join(mkdtempSync(join(tmpdir(), "tf-")), "detect.mjs");
execSync(
  `npx esbuild ${new URL("../src/handImage/detect.ts", import.meta.url).pathname} --bundle --format=esm --outfile=${out}`,
  { stdio: "pipe" }
);
const { _debugChips } = await import(out);
const png = PNG.sync.read(readFileSync(file));
const chips = _debugChips({ width: png.width, height: png.height, data: png.data });
console.log(file.split("/").pop(), png.width + "x" + png.height, "colored chips:", chips.length);
for (const c of chips.sort((a, b) => a.cy - b.cy || a.cx - b.cx)) {
  console.log(`  (${c.cx.toFixed(0)},${c.cy.toFixed(0)}) ${c.w}x${c.h} ${c.suit}`);
}
