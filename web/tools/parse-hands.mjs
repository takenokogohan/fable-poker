// Full hand parse: cards + actions + hero + pot type, for all sample images.
import { PNG } from "pngjs";
import { readFileSync, readdirSync, mkdtempSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const DIR =
  process.argv[2] || "/Users/takenokogohan/sandbox/poker-analyzer/example_images";
const out = join(mkdtempSync(join(tmpdir(), "tf-")), "parse.mjs");
execSync(
  `npx esbuild ${new URL("../src/handImage/parse.ts", import.meta.url).pathname} --bundle --format=esm --outfile=${out}`,
  { stdio: "pipe" }
);
const { parseHand } = await import(out);

const pretty = (s) => s.replace(/h/g, "♥").replace(/d/g, "♦").replace(/c/g, "♣").replace(/s/g, "♠");
for (const f of readdirSync(DIR).filter((f) => /\.png$/i.test(f)).sort()) {
  const png = PNG.sync.read(readFileSync(join(DIR, f)));
  const h = parseHand({ width: png.width, height: png.height, data: png.data });
  const streets = h.streets
    .map((s) => `${s.street}: ${s.actions.map((a) => `${a.position} ${a.action}`).join(", ")}`)
    .join("\n      ");
  console.log(
    `${f}\n  hero ${h.heroPosition} ${pretty(h.heroCards.join(""))}  vs ${h.villainPosition || "?"}  ${h.potType}` +
      `  board ${pretty(h.board.join("")) || "(none)"}` +
      (h.warnings.length ? `  [!${h.warnings.join("; ")}]` : "") +
      `\n      ${streets}`
  );
}
