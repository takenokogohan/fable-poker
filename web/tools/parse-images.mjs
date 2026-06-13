// Dev harness: run the Ten-Four card detector against the sample screenshots
// and print extracted cards, so the parser can be verified outside the browser.
// Usage: node tools/parse-images.mjs [dir]
import { PNG } from "pngjs";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const DIR =
  process.argv[2] ||
  "/Users/takenokogohan/sandbox/poker-analyzer/example_images";

// bundle the TS detector to ESM we can import
const out = join(mkdtempSync(join(tmpdir(), "tf-")), "detect.mjs");
execSync(
  `npx esbuild ${new URL("../src/handImage/detect.ts", import.meta.url).pathname} --bundle --format=esm --outfile=${out}`,
  { stdio: "pipe" }
);
const { detectCards, readRank } = await import(out);

const SUIT = { h: "♥", d: "♦", c: "♣", s: "♠" };
const files = readdirSync(DIR).filter((f) => /\.png$/i.test(f)).sort();
for (const f of files) {
  const png = PNG.sync.read(readFileSync(join(DIR, f)));
  const img = { width: png.width, height: png.height, data: png.data };
  const d = detectCards(img);
  const card = (cx, cy, suit) => {
    const { rank } = readRank(img, Math.round(cx), Math.round(cy), d.chipW, d.chipH);
    return (rank || "?") + SUIT[suit];
  };
  const hole = d.holeRows
    .map((r) => r.cards.map((c) => card(c.cx, r.cy, c.suit)).join(""))
    .join(" ");
  const board = d.board.map((c) => card(c.cx, c.cy, c.suit)).join("");
  console.log(`${f}\n    hole: ${hole}\n    board: ${board || "(none)"}`);
}
