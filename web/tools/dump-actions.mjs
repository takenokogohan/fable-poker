// Print the action-row colour classes grouped by street, to verify against
// known hands.
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
const { detectActionStreets } = await import(out);
const png = PNG.sync.read(readFileSync(file));
const groups = detectActionStreets({ width: png.width, height: png.height, data: png.data });
const sym = { fold: "F", passive: "·", aggro: "R", other: "?" };
console.log(file.split("/").pop(), "→", groups.length, "groups");
groups.forEach((g, i) =>
  console.log(`  group ${i}: ${g.map((r) => sym[r.cls]).join(" ")}`)
);
