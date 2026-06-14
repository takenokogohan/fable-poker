// Debug row alignment: list-tag cy vs hole-card-row cy + suits.
import { PNG } from "pngjs";
import { readFileSync, mkdtempSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const file = process.argv[2];
const out = join(mkdtempSync(join(tmpdir(), "tf-")), "detect.mjs");
execSync(`npx esbuild ${new URL("../src/handImage/detect.ts", import.meta.url).pathname} --bundle --format=esm --outfile=${out}`, { stdio: "pipe" });
const { detectCards, detectTags, nameBrightness } = await import(out);
const png = PNG.sync.read(readFileSync(file));
const img = { width: png.width, height: png.height, data: png.data };
const SUIT = { h: "♥", d: "♦", c: "♣", s: "♠" };

const { list } = detectTags(img);
const listRows = list.slice(0, 6).sort((a, b) => a.cy - b.cy);
console.log("list tags (cy, brightness):");
listRows.forEach((t, i) => console.log(`  row${i} cy=${t.cy.toFixed(0)} x=${t.x} bright=${nameBrightness(img, t).toFixed(0)}`));

const d = detectCards(img);
console.log("\nhole rows (cy, suits):");
d.holeRows.forEach((r, i) => console.log(`  hrow${i} cy=${r.cy.toFixed(0)} ${r.cards.map((c) => SUIT[c.suit]).join("")}`));
console.log("\nboard suits:", d.board.map((c) => SUIT[c.suit]).join(""));
