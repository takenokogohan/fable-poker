// Node smoke test for the distributed protocol: 1 main + 2 worker wasm
// instances, exercising iterate / exploitability / routing / EV fan-out /
// state export-import — exactly what the browser cluster does.
import { readFileSync } from "fs";

const wasmBytes = readFileSync(new URL("./public/solver.wasm", import.meta.url));
const enc = new TextEncoder();
const dec = new TextDecoder();

async function makeInstance() {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const ex = instance.exports;
  const withString = (fn, s) => {
    const b = enc.encode(s);
    const p = ex.sv_alloc(b.length);
    new Uint8Array(ex.memory.buffer).set(b, p);
    const out = fn(p, b.length);
    ex.sv_free(p, b.length);
    return out;
  };
  const withBytes = (fn, bytes) => {
    const p = ex.sv_alloc(bytes.length);
    new Uint8Array(ex.memory.buffer).set(bytes, p);
    const out = fn(p, bytes.length);
    ex.sv_free(p, bytes.length);
    return out;
  };
  const readRaw = (ptr) => {
    const view = new DataView(ex.memory.buffer);
    const len = view.getUint32(ptr, true);
    const copy = new Uint8Array(len);
    copy.set(new Uint8Array(ex.memory.buffer, ptr + 4, len));
    ex.sv_free_result(ptr);
    return copy;
  };
  const readJson = (ptr) => JSON.parse(dec.decode(readRaw(ptr)));
  return { ex, withString, withBytes, readRaw, readJson };
}

function sumValueBuffers(buffers) {
  const out = buffers[0].slice();
  const outDv = new DataView(out.buffer);
  for (let b = 1; b < buffers.length; b++) {
    const dv = new DataView(buffers[b].buffer, buffers[b].byteOffset);
    const n = dv.getUint32(4, true);
    let o = 8;
    for (let i = 0; i < n; i++) {
      const nh = dv.getUint32(o + 4, true);
      if (outDv.getUint32(o, true) !== dv.getUint32(o, true)) throw new Error("layout");
      o += 8;
      for (let h = 0; h < nh; h++) {
        outDv.setFloat32(o + h * 4, outDv.getFloat32(o + h * 4, true) + dv.getFloat32(o + h * 4, true), true);
      }
      o += nh * 4;
    }
  }
  return out;
}

const range = Array(169).fill(1).join(",");
const base = [
  "board=Ks7h2d8c",
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

const K = 2;
const main = await makeInstance();
const workers = [];
for (let i = 0; i < K; i++) workers.push(await makeInstance());

let meta = main.readJson(main.withString(main.ex.sv_init, `${base}\npartition=main\nworkers=${K}`));
if (!meta.ok) throw new Error(meta.error);
console.log(`main init: nodes=${meta.actionNodes} storage=${meta.storageMB}MB`);
let totalMB = meta.storageMB;
for (let i = 0; i < K; i++) {
  const m = workers[i].readJson(
    workers[i].withString(workers[i].ex.sv_init, `${base}\npartition=worker\nworkers=${K}\nworker_idx=${i}`)
  );
  if (!m.ok) throw new Error(m.error);
  totalMB += m.storageMB;
  console.log(`worker ${i}: storage=${m.storageMB}MB`);
}

const ITERS = 80;
const t0 = Date.now();
for (let it = 0; it < ITERS; it++) {
  for (const p of [0, 1]) {
    const tasks = main.readRaw(main.ex.sv_iter_begin(p));
    const partials = workers.map((w) => w.readRaw(w.withBytes((pp, ll) => w.ex.sv_subtree_run(0, pp, ll), tasks)));
    const summed = sumValueBuffers(partials);
    const r = main.readJson(main.withBytes(main.ex.sv_iter_finish, summed));
    if (!r.ok) throw new Error(r.error);
  }
}
console.log(`cluster: ${ITERS} iters in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// exploitability
let brTotal = 0;
for (const p of [0, 1]) {
  const tasks = main.readRaw(main.ex.sv_br_begin(p));
  const partials = workers.map((w) => w.readRaw(w.withBytes((pp, ll) => w.ex.sv_subtree_run(1, pp, ll), tasks)));
  const summed = sumValueBuffers(partials);
  brTotal += main.readJson(main.withBytes(main.ex.sv_br_finish, summed)).brTotal;
}
const info = main.readJson(main.ex.sv_expl_info());
const expl = (brTotal / info.pairWeight - info.dead) / 2;
console.log(`exploitability: ${expl.toFixed(4)} bb (${((expl / info.pot) * 100).toFixed(2)}% pot)`);
if (expl / info.pot > 0.03) throw new Error("poor convergence");

// mirror sync + routed query
const mirror = main.readRaw(main.ex.sv_export_street0());
for (const w of workers) {
  const r = w.readJson(w.withBytes(w.ex.sv_import_street0, mirror));
  if (!r.ok) throw new Error(r.error);
}
const route = main.readJson(main.withString(main.ex.sv_route, "0,0,8"));
console.log(`route 0,0,8 -> worker ${route.owner}`);
if (route.owner < 0 || route.owner >= K) throw new Error("bad route");
const q = workers[route.owner].readJson(workers[route.owner].withString(workers[route.owner].ex.sv_query, "0,0,8|ev"));
if (!q.ok || q.type !== "action") throw new Error("routed query failed: " + JSON.stringify(q).slice(0, 120));
console.log(`routed query ok: board=${q.board} actions=${q.actions.length} evs=${q.evs.length}`);

// EV fan-out at root
const evTasks = main.readRaw(main.ex.sv_ev_begin(...(() => { const b = enc.encode(""); const p = main.ex.sv_alloc(1); return [p, 0]; })()));
const evPartials = workers.map((w) => w.readRaw(w.withBytes((pp, ll) => w.ex.sv_subtree_run(2, pp, ll), evTasks)));
const evSummed = sumValueBuffers(evPartials);
const pathBytes = enc.encode("");
const evBuf = new Uint8Array(4 + pathBytes.length + evSummed.length);
new DataView(evBuf.buffer).setUint32(0, pathBytes.length, true);
evBuf.set(evSummed, 4);
const evr = main.readJson(main.withBytes(main.ex.sv_ev_finish, evBuf));
if (!evr.ok) throw new Error(evr.error);
console.log(`EV fan-out at root: ${evr.evs.length} values, sample=${evr.evs.slice(0, 3).map((x) => x.toFixed(2))}`);

// state roundtrip
const st = workers[0].readRaw(workers[0].ex.sv_export_state());
const ri = workers[0].readJson(workers[0].withBytes(workers[0].ex.sv_import_state, st));
if (!ri.ok) throw new Error(ri.error);
console.log(`state roundtrip ok (${(st.length / 1e6).toFixed(1)} MB, iters=${ri.iterations})`);

console.log("CLUSTER SMOKE TEST PASSED");
