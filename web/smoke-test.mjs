// Node smoke test: exercises the wasm C ABI exactly like the worker does.
import { readFileSync } from "fs";

const wasm = readFileSync(new URL("./public/solver.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, {});
const ex = instance.exports;
const enc = new TextEncoder();
const dec = new TextDecoder();

function call(fn, text) {
  const bytes = enc.encode(text);
  const ptr = ex.sv_alloc(bytes.length);
  new Uint8Array(ex.memory.buffer).set(bytes, ptr);
  const out = fn(ptr, bytes.length);
  ex.sv_free(ptr, bytes.length);
  return read(out);
}

function read(ptr) {
  const view = new DataView(ex.memory.buffer);
  const len = view.getUint32(ptr, true);
  const text = dec.decode(new Uint8Array(ex.memory.buffer, ptr + 4, len));
  ex.sv_free_result(ptr);
  return JSON.parse(text);
}

const range = Array(169).fill(1).join(",");
const config = [
  "board=Ks7h2d8c", // turn spot
  "pot=10",
  "stack=95",
  "bets_flop=33",
  "bets_turn=75",
  "bets_river=75",
  "raises_flop=60",
  "raises_turn=60",
  "raises_river=60",
  "max_bets=2",
  "allin_threshold=0",
  `range_oop=${range}`,
  `range_ip=${range}`,
].join("\n");

let t0 = Date.now();
const meta = call(ex.sv_init, config);
console.log(`init: ok=${meta.ok} hands=${meta.hands0.length}/${meta.hands1.length} nodes=${meta.actionNodes} storage=${meta.storageMB}MB (${Date.now() - t0}ms)`);
if (!meta.ok) { console.error(meta); process.exit(1); }

t0 = Date.now();
let r = read(ex.sv_run(30));
console.log(`run 30 iters: expl=${r.exploitabilityPctPot}% pot (${Date.now() - t0}ms)`);

t0 = Date.now();
r = read(ex.sv_run(70));
console.log(`run 70 more: expl=${r.exploitabilityPctPot}% pot (${Date.now() - t0}ms)`);
if (r.exploitabilityPctPot > 5) { console.error("FAIL: poor convergence"); process.exit(1); }

const root = call(ex.sv_query, "|ev,eq");
console.log(`root: type=${root.type} actions=${JSON.stringify(root.actions)} strat_len=${root.strategy.length} evs_len=${root.evs.length} eq_len=${root.equity0.length}`);
if (!root.ok || root.type !== "action") { console.error(root); process.exit(1); }

// descend: check(0) -> check(0) -> chance -> pick a river card
const afterCheck = call(ex.sv_query, "0,0");
console.log(`after x/x: type=${afterCheck.type} cards=${afterCheck.cards?.length}`);
const river = afterCheck.cards[0];
const riverNode = call(ex.sv_query, `0,0,${river}|eq`);
console.log(`river node: type=${riverNode.type} board=${riverNode.board} actions=${riverNode.actions?.length}`);
if (!riverNode.ok) { console.error(riverNode); process.exit(1); }

// sanity on strategy values
const nh = meta.hands0.length;
const na = root.actions.length;
let bad = 0;
for (let h = 0; h < nh; h++) {
  let s = 0;
  for (let a = 0; a < na; a++) s += root.strategy[a * nh + h];
  if (Math.abs(s - 1) > 0.01) bad++;
}
console.log(`strategy rows summing to 1: ${nh - bad}/${nh}`);
if (bad > 0) process.exit(1);

console.log("SMOKE TEST PASSED");
