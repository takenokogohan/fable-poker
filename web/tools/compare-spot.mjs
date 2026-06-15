// Solve CO vs BB SRP on Kc6c4d, navigate flop check / CO bet / BB call, deal
// turn Qs, and report BB's KQ turn strategy + exploitability — to compare with
// GTO Wizard and tell convergence from input-driven differences.
import { readFileSync, mkdtempSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "cmp-"));
const rOut = join(dir, "ranges.mjs");
execSync(`npx esbuild ${new URL("../src/ranges.ts", import.meta.url).pathname} --bundle --format=esm --outfile=${rOut}`, { stdio: "pipe" });
const { buildScenario } = await import(rOut);
const scen = buildScenario("CO", "BB", "srp", "normal", "normal");
console.log(`spot: OOP ${scen.oopName} / IP ${scen.ipName}, pot ${scen.pot}, stack ${scen.stack}`);

const cfg = [
  "board=Kc6c4d",
  `pot=${scen.pot}`,
  `stack=${scen.stack}`,
  "bets_flop=33",
  "bets_turn=75",
  "bets_river=75",
  "raises_flop=60",
  "raises_turn=60",
  "raises_river=60",
  "max_bets=2",
  "allin_threshold=0",
  `range_oop=${Array.from(scen.oopRange).map((x) => +x.toFixed(3)).join(",")}`,
  `range_ip=${Array.from(scen.ipRange).map((x) => +x.toFixed(3)).join(",")}`,
].join("\n");

const wasm = readFileSync(new URL("../public/solver.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, {});
const ex = instance.exports;
const enc = new TextEncoder(), dec = new TextDecoder();
const call = (fn, s) => { const b = enc.encode(s); const p = ex.sv_alloc(b.length); new Uint8Array(ex.memory.buffer).set(b, p); const o = fn(p, b.length); ex.sv_free(p, b.length); return read(o); };
const read = (ptr) => { const v = new DataView(ex.memory.buffer); const len = v.getUint32(ptr, true); const t = dec.decode(new Uint8Array(ex.memory.buffer, ptr + 4, len)); ex.sv_free_result(ptr); return JSON.parse(t); };

const meta = call(ex.sv_init, cfg);
if (!meta.ok) throw new Error(meta.error);
console.log(`hands BB=${meta.hands0.length} CO=${meta.hands1.length}, nodes=${meta.actionNodes}, ${meta.storageMB.toFixed(0)}MB`);

const t0 = Date.now();
let r;
for (let i = 0; i < 12; i++) {
  r = read(ex.sv_run(40));
  console.log(`iter ${r.iterations}: expl ${r.exploitabilityPctPot.toFixed(2)}% pot  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

// navigate: BB check -> CO bet -> BB call -> turn Qs
const KIND = { fold: 0, check: 1, call: 2, bet: 3, raise: 4, allin: 5 };
const idxOf = (node, kind) => node.actions.findIndex((a) => a.kind === kind);
const QS = 43; // Q spade = rank10<<2 | 3

let path = [];
let n = call(ex.sv_query, `${path.join(",")}|`);
console.log(`\nflop BB node: player=${n.player} actions=${JSON.stringify(n.actions)}`);
path.push(idxOf(n, KIND.check));
n = call(ex.sv_query, `${path.join(",")}|`);
console.log(`flop CO node: player=${n.player} actions=${JSON.stringify(n.actions)}`);
path.push(idxOf(n, KIND.bet));
n = call(ex.sv_query, `${path.join(",")}|`);
console.log(`flop BB-vs-bet node: player=${n.player} actions=${JSON.stringify(n.actions)}`);
path.push(idxOf(n, KIND.call));
n = call(ex.sv_query, `${path.join(",")}|`);
console.log(`after flop call: type=${n.type} (expect chance)`);
path.push(QS);
n = call(ex.sv_query, `${path.join(",")}|ev`);
console.log(`turn BB node: type=${n.type} player=${n.player} board=${n.board} actions=${JSON.stringify(n.actions)}`);

// BB KQ (KdQc) turn strategy
const hands = meta.hands0;
let hi = hands.indexOf("KdQc"); if (hi < 0) hi = hands.indexOf("QcKd");
const na = n.actions.length, nh = hands.length;
console.log(`\nBB turn strategy for KdQc (idx ${hi}):`);
const lbl = ["fold", "check", "call", "bet", "raise", "allin"];
for (let a = 0; a < na; a++) {
  const f = n.strategy[a * nh + hi];
  const ev = n.evs ? n.evs[a * nh + hi] : null;
  console.log(`  ${lbl[n.actions[a].kind]} ${(n.actions[a].chips).toFixed(2)}: ${(f * 100).toFixed(1)}%  EV ${ev !== null ? ev.toFixed(2) : "?"}`);
}
// aggregate BB turn range bet vs check
let betFreq = 0, checkFreq = 0, tot = 0;
const reach = n.reach0;
for (let h = 0; h < nh; h++) {
  const w = reach[h]; if (w <= 0) continue; tot += w;
  for (let a = 0; a < na; a++) {
    const f = w * n.strategy[a * nh + h];
    if (n.actions[a].kind === KIND.check) checkFreq += f; else betFreq += f;
  }
}
console.log(`\nBB turn RANGE aggregate: check ${(100 * checkFreq / tot).toFixed(1)}%  bet/other ${(100 * betFreq / tot).toFixed(1)}%`);
