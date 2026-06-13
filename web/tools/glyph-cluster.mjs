// Extract every card's rank glyph from the sample images, cluster identical
// shapes (same rank = same glyph), and write a montage PNG so each cluster can
// be labeled by sight. Prints cluster sizes; montage cells are in print order.
import { PNG } from "pngjs";
import { readFileSync, writeFileSync, readdirSync, mkdtempSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const DIR = "/Users/takenokogohan/sandbox/poker-analyzer/example_images";
const out = join(mkdtempSync(join(tmpdir(), "tf-")), "detect.mjs");
execSync(
  `npx esbuild ${new URL("../src/handImage/detect.ts", import.meta.url).pathname} --bundle --format=esm --outfile=${out}`,
  { stdio: "pipe" }
);
const { detectCards, extractGlyph, glyphDist, GLYPH_W, GLYPH_H } = await import(out);

const glyphs = [];
for (const f of readdirSync(DIR).filter((f) => /\.png$/i.test(f)).sort()) {
  const png = PNG.sync.read(readFileSync(join(DIR, f)));
  const img = { width: png.width, height: png.height, data: png.data };
  const d = detectCards(img);
  const slots = [];
  for (const row of d.holeRows) for (const c of row.cards) slots.push([c.cx, row.cy]);
  for (const c of d.board) slots.push([c.cx, c.cy]);
  for (const [cx, cy] of slots) {
    const g = extractGlyph(img, cx, cy, d.chipW, d.chipH);
    if (g) glyphs.push({ g, f });
  }
}

// greedy clustering
const TH = 0.12;
const clusters = [];
for (const item of glyphs) {
  let best = -1, bd = 1;
  for (let i = 0; i < clusters.length; i++) {
    const dd = glyphDist(item.g, clusters[i].centroid);
    if (dd < bd) { bd = dd; best = i; }
  }
  if (best >= 0 && bd < TH) clusters[best].members.push(item);
  else clusters.push({ centroid: item.g, members: [item] });
}
// recompute centroids by majority vote
for (const c of clusters) {
  const cen = new Uint8Array(GLYPH_W * GLYPH_H);
  for (let k = 0; k < cen.length; k++) {
    let s = 0;
    for (const m of c.members) s += m.g[k];
    cen[k] = s * 2 >= c.members.length ? 1 : 0;
  }
  c.centroid = cen;
}
clusters.sort((a, b) => b.members.length - a.members.length);

console.log(`${glyphs.length} glyphs → ${clusters.length} clusters (montage order):`);
clusters.forEach((c, i) => console.log(`  #${i}: ${c.members.length}`));

// montage: scale 4x, 10 per row, black bg / white glyph, 1px separators
const SC = 4, GAP = 6, PER = 10;
const cw = GLYPH_W * SC + GAP, ch = GLYPH_H * SC + GAP;
const cols = Math.min(PER, clusters.length), rows = Math.ceil(clusters.length / PER);
const MW = cols * cw + GAP, MH = rows * ch + GAP;
const m = new PNG({ width: MW, height: MH });
m.data.fill(0);
for (let a = 3; a < m.data.length; a += 4) m.data[a] = 255; // opaque
clusters.forEach((c, i) => {
  const ox = GAP + (i % PER) * cw, oy = GAP + Math.floor(i / PER) * ch;
  for (let gy = 0; gy < GLYPH_H; gy++)
    for (let gx = 0; gx < GLYPH_W; gx++) {
      const on = c.centroid[gy * GLYPH_W + gx];
      for (let sy = 0; sy < SC; sy++)
        for (let sx = 0; sx < SC; sx++) {
          const px = ox + gx * SC + sx, py = oy + gy * SC + sy;
          const idx = (py * MW + px) * 4;
          const v = on ? 255 : 30;
          m.data[idx] = v; m.data[idx + 1] = v; m.data[idx + 2] = v;
        }
    }
});
const montagePath = join(tmpdir(), "glyph-montage.png");
writeFileSync(montagePath, PNG.sync.write(m));
console.log("montage:", montagePath, MW + "x" + MH);
