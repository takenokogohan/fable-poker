// Map each parsed hand to a solver scenario (opener/defender/ranges) and print,
// to verify the parser → solver bridge.
import { PNG } from "pngjs";
import { readFileSync, readdirSync, mkdtempSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const DIR =
  process.argv[2] || "/Users/takenokogohan/sandbox/poker-analyzer/example_images";
const dir = mkdtempSync(join(tmpdir(), "tf-"));
const pOut = join(dir, "parse.mjs");
const aOut = join(dir, "analyze.mjs");
execSync(`npx esbuild ${new URL("../src/handImage/parse.ts", import.meta.url).pathname} --bundle --format=esm --outfile=${pOut}`, { stdio: "pipe" });
execSync(`npx esbuild ${new URL("../src/handImage/analyze.ts", import.meta.url).pathname} --bundle --format=esm --outfile=${aOut}`, { stdio: "pipe" });
const { parseHand } = await import(pOut);
const { handToScenario, heroDecisions } = await import(aOut);

const pct = (g) => {
  let t = 0;
  for (let c = 0; c < 169; c++) { const row = (c / 13) | 0, col = c % 13; t += g[c] * (row === col ? 6 : row < col ? 4 : 12); }
  return ((t / 1326) * 100).toFixed(0);
};
for (const f of readdirSync(DIR).filter((f) => /\.png$/i.test(f)).sort()) {
  const png = PNG.sync.read(readFileSync(join(DIR, f)));
  const hand = parseHand({ width: png.width, height: png.height, data: png.data });
  const s = handToScenario(hand);
  if (!s.valid) { console.log(`${f}: SKIP (${s.reason})  [hero ${hand.heroPosition} ${hand.potType}]`); continue; }
  const decs = heroDecisions(hand).map((d) => `${d.street[0]}:${d.action}`).join(" ");
  console.log(
    `${f}: ${s.opener} vs ${s.defender} ${s.potType} | OOP ${s.oop}(${pct(s.oopRange)}%) IP ${s.ip}(${pct(s.ipRange)}%) | hero ${s.hero}${s.heroIsOop ? "(OOP)" : "(IP)"} | pot ${s.pot} stack ${s.stack} | board ${s.board}\n    hero line: ${decs}`
  );
}
