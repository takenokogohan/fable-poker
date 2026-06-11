// Reproduce the spot from the user's GTO Wizard recording and compare:
// Cash 100bb, EP opens, SB 3bets to ~11bb, EP calls.
// Flop Qd 8s 6c, pot 23.5, eff. stack 88.75. Hero (video) = SB with AdKh.
//
// GTO Wizard reference values (from the recording):
//   SB (OOP) with AdKh: check 81.4% (+1.8 EV), b8.22 13.5% (+1.8), b21.15 5.1% (+1.7)
//   EP (IP) range after check: check 50.9%, b5.88 46.8%, b18.8 2.3%
//   SB AdKh facing b5.88: fold 93.6% (+0), call 4.9% (0), raises ~1.5% (-0.4/-0.5)
import { readFileSync } from "fs";

const wasmBytes = readFileSync(new URL("./public/solver.wasm", import.meta.url));
const enc = new TextEncoder();
const dec = new TextDecoder();
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const ex = instance.exports;
const call = (fn, s) => {
  const b = enc.encode(s);
  const p = ex.sv_alloc(b.length);
  new Uint8Array(ex.memory.buffer).set(b, p);
  const out = fn(p, b.length);
  ex.sv_free(p, b.length);
  return read(out);
};
const read = (ptr) => {
  const v = new DataView(ex.memory.buffer);
  const len = v.getUint32(ptr, true);
  const t = dec.decode(new Uint8Array(ex.memory.buffer, ptr + 4, len));
  ex.sv_free_result(ptr);
  return JSON.parse(t);
};

// --- range parsing (mirror of web/src/ranges.ts) ---
const RANKS = "23456789TJQKA";
const ri = (c) => RANKS.indexOf(c.toUpperCase());
function cell(hi, lo, type) {
  const row = 12 - hi;
  const col = 12 - lo;
  if (type === "p") return row * 13 + row;
  return type === "s" ? row * 13 + col : col * 13 + row;
}
function parseRange(text) {
  const grid = new Float32Array(169);
  for (let part of text.split(",")) {
    part = part.trim();
    if (part === "") continue;
    let weight = 1;
    const colon = part.indexOf(":");
    if (colon >= 0) {
      weight = parseFloat(part.slice(colon + 1));
      part = part.slice(0, colon).trim();
    }
    const set = (c) => (grid[c] = Math.max(grid[c], weight));
    const plus = part.endsWith("+");
    if (plus) part = part.slice(0, -1);
    if (part.includes("-")) {
      const [a, b] = part.split("-").map((t) => t.trim());
      if (a.length === 2 && a[0] === a[1]) {
        const hiP = ri(a[0]);
        const loP = ri(b[0]);
        for (let r = Math.min(hiP, loP); r <= Math.max(hiP, loP); r++) set(cell(r, r, "p"));
      } else {
        const type = a[2]?.toLowerCase() === "s" ? "s" : "o";
        const hi = ri(a[0]);
        const from = ri(b[1]);
        const to = ri(a[1]);
        for (let r = Math.min(from, to); r <= Math.max(from, to); r++) set(cell(hi, r, type));
      }
    } else if (part.length === 2 && part[0] === part[1]) {
      const start = ri(part[0]);
      const end = plus ? 12 : start;
      for (let r = start; r <= end; r++) set(cell(r, r, "p"));
    } else if (part.length >= 2) {
      const hi = ri(part[0]);
      const lo = ri(part[1]);
      const tc = part[2]?.toLowerCase();
      const types = tc === "s" ? ["s"] : tc === "o" ? ["o"] : ["s", "o"];
      for (const t of types) {
        if (plus) for (let r = lo; r < hi; r++) set(cell(hi, r, t));
        else set(cell(hi, lo, t));
      }
    }
  }
  return grid;
}
const intersect = (a, b) => a.map((v, i) => Math.min(v, b[i]));

// Ranges matched to the GTO Wizard recording: the SB "Flat & 3bet" screen
// showed RAISE 11.25bb 7.4% with 99+, ATs+, A5s, KQs, JTs, AKo, AQo(mixed).
// EP's continue-vs-3bet range was not shown; standard approximation.
const SB_3BET_VS_EP =
  "JJ+, TT:0.75, 99:0.5, AJs+, ATs:0.75, A5s:0.5, KQs:0.5, JTs:0.5, AKo, AQo:0.4";
const RFI_EP =
  "22+, ATs+, A5s-A4s, KTs+, QTs+, JTs, T9s, 98s, 87s, 76s, 65s, AJo+, KQo";
const EP_CALL_VS_SB_3BET =
  "77-JJ, QQ:0.5, KK:0.2, AA:0.2, 66:0.5, 55:0.3, ATs+, KTs+:0.6, QTs:0.5, JTs:0.7, T9s:0.5, 98s:0.3, AQo:0.7, AKo:0.5";

const oop = parseRange(SB_3BET_VS_EP); // SB (3bettor, OOP)
const ip = intersect(parseRange(EP_CALL_VS_SB_3BET), parseRange(RFI_EP)); // EP calls

// GTO Wizard's sizes: OOP 35%/90%, IP 25%/80% -> shared compromise 30%/85%
const config = [
  "board=Qd8s6c",
  "pot=23.5",
  "stack=88.75",
  "bets_flop=30,85",
  "bets_turn=75",
  "bets_river=75",
  "raises_flop=60",
  "raises_turn=",
  "raises_river=",
  "max_bets=2",
  "allin_threshold=0",
  `range_oop=${Array.from(oop).join(",")}`,
  `range_ip=${Array.from(ip).join(",")}`,
].join("\n");

const meta = call(ex.sv_init, config);
if (meta.ok === false) throw new Error(meta.error);
console.log(
  `spot: pot 23.5, stack 88.75, Qd8s6c | hands SB=${meta.hands0.length} EP=${meta.hands1.length}, nodes=${meta.actionNodes}, ${meta.storageMB.toFixed(0)}MB`
);

let r;
const t0 = Date.now();
for (let i = 0; i < 15; i++) {
  r = read(ex.sv_run(20));
  if (r.exploitabilityPctPot < 0.3) break;
}
console.log(
  `converged: ${r.iterations} iters, expl ${r.exploitabilityPctPot.toFixed(2)}% pot, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`
);

const aggFreq = (node, hands, reach) => {
  const na = node.actions.length;
  const nh = hands.length;
  const freqs = new Array(na).fill(0);
  let tot = 0;
  for (let h = 0; h < nh; h++) {
    const w = reach[h];
    if (w <= 0) continue;
    tot += w;
    for (let a = 0; a < na; a++) freqs[a] += w * node.strategy[a * nh + h];
  }
  return freqs.map((f) => ((f / tot) * 100).toFixed(1));
};
const handRow = (node, hands, hand, evs) => {
  const nh = hands.length;
  const h = hands.indexOf(hand);
  if (h < 0) return "hand not in range";
  const na = node.actions.length;
  const parts = [];
  for (let a = 0; a < na; a++) {
    const f = (node.strategy[a * nh + h] * 100).toFixed(1);
    const ev = evs ? ` (EV ${node.evs[a * nh + h].toFixed(2)})` : "";
    parts.push(`${label(node.actions[a])} ${f}%${ev}`);
  }
  return parts.join(" | ");
};
const label = (a) =>
  ["fold", "check", "call", `b${a.chips.toFixed(1)}`, `r${a.chips.toFixed(1)}`, "allin"][a.kind] ??
  "?";

// root: SB (OOP)
const root = call(ex.sv_query, "|ev");
console.log("SB(OOP) root range:", root.actions.map(label).join(" / "));
console.log("  range freq:", aggFreq(root, meta.hands0, root.reach0).join(" / "));
console.log("  AdKh:      ", handRow(root, meta.hands0, "AdKh", true));
console.log("  GTOW AdKh:  check 81.4% (+1.8) | b8.22 13.5% (+1.8) | b21.15 5.1% (+1.7)\n");

// after check: EP (IP)
const ipNode = call(ex.sv_query, "0");
console.log("EP(IP) after check:", ipNode.actions.map(label).join(" / "));
console.log("  range freq:", aggFreq(ipNode, meta.hands1, ipNode.reach1).join(" / "));
console.log("  GTOW range: check 50.9% | b5.88 46.8% | b18.8 2.3%\n");

// SB facing the small bet (action 1 of IP node)
const facing = call(ex.sv_query, "0,1|ev");
console.log("SB facing small bet:", facing.actions.map(label).join(" / "));
console.log("  range freq:", aggFreq(facing, meta.hands0, facing.reach0).join(" / "));
console.log("  AdKh:      ", handRow(facing, meta.hands0, "AdKh", true));
console.log("  GTOW AdKh:  fold 93.6% (+0) | call 4.9% (0) | raises 1.5% (-0.4)");
