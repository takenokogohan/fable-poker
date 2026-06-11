// Inject the hashed asset list into dist/sw.js so the first visit precaches
// everything needed for offline use.
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";

const dist = new URL("./dist/", import.meta.url).pathname;
const assets = readdirSync(dist + "assets").map((f) => `/assets/${f}`);
const swPath = dist + "sw.js";
let sw = readFileSync(swPath, "utf8");
const build = createHash("sha1")
  .update(JSON.stringify(assets) + readFileSync(dist + "index.html", "utf8"))
  .digest("hex")
  .slice(0, 12);
sw =
  `self.__PRECACHE__ = ${JSON.stringify(assets)};\nself.__BUILD__ = "${build}";\n` +
  sw;
writeFileSync(swPath, sw);
console.log(`sw.js: precaching ${assets.length} assets, build ${build}`);
