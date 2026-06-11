// Sanity-check all preflop preset ranges: for every scenario and tightness,
// ranges must parse to something non-empty and widths must be monotonic
// (tight <= normal <= loose). Bundles ranges.ts via esbuild so the real
// source is what gets tested.
import { execSync } from "child_process";

const tmp = (process.env.TMPDIR ?? "/tmp") + "/ranges-bundle.mjs";
execSync(
  `npx esbuild src/ranges.ts --bundle --format=esm --outfile=${tmp}`,
  { cwd: new URL(".", import.meta.url).pathname, stdio: "pipe" }
);
const { buildScenario, rangePercent, OPENER_POSITIONS, validDefenders } =
  await import(tmp);

let checked = 0;
let failed = 0;
for (const opener of OPENER_POSITIONS) {
  for (const defender of validDefenders(opener)) {
    for (const potType of ["srp", "3bp", "4bp"]) {
      const pct = {};
      for (const t of ["tight", "normal", "loose"]) {
        const s = buildScenario(opener, defender, potType, t);
        const oopPct = rangePercent(s.oopRange);
        const ipPct = rangePercent(s.ipRange);
        pct[t] = { oop: oopPct, ip: ipPct };
        if (oopPct <= 0 || ipPct <= 0) {
          console.error(
            `EMPTY RANGE: ${opener} vs ${defender} ${potType} ${t}: oop=${oopPct} ip=${ipPct}`
          );
          failed++;
        }
      }
      for (const side of ["oop", "ip"]) {
        if (
          pct.tight[side] > pct.normal[side] + 0.01 ||
          pct.normal[side] > pct.loose[side] + 0.01
        ) {
          console.error(
            `NOT MONOTONIC: ${opener} vs ${defender} ${potType} ${side}: ` +
              `tight=${pct.tight[side].toFixed(1)} normal=${pct.normal[
                side
              ].toFixed(1)} loose=${pct.loose[side].toFixed(1)}`
          );
          failed++;
        }
      }
      checked++;
      console.log(
        `${opener.padEnd(3)} vs ${defender.padEnd(3)} ${potType}: ` +
          ["tight", "normal", "loose"]
            .map(
              (t) =>
                `${t[0].toUpperCase()}=${pct[t].oop.toFixed(1)}/${pct[
                  t
                ].ip.toFixed(1)}`
            )
            .join("  ")
      );
    }
  }
}
console.log(`\n${checked} scenarios checked`);
if (failed > 0) {
  console.error(`${failed} FAILURES`);
  process.exit(1);
}
console.log("RANGE CHECK PASSED");
