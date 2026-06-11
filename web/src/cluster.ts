// Solver session: either a single monolithic instance or a 1+K cluster
// partitioned over the first dealt card (turn cards for a flop spot).

import type { NodeData, SolverMeta } from "./types";

type Msg = Record<string, unknown>;

class WorkerHandle {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    (r: { result?: unknown; bin?: ArrayBuffer }) => void
  >();

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (e: MessageEvent) => {
      const { id } = e.data;
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        p(e.data);
      }
    };
  }

  call(msg: Msg, transfer: Transferable[] = []): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, ({ result, bin }) => {
        if (bin !== undefined) return resolve(bin);
        const r = result as { ok?: boolean; error?: string };
        if (r && r.ok === false) return reject(new Error(r.error));
        resolve(result);
      });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  terminate() {
    this.worker.terminate();
  }
}

/** sum worker value-buffers: [trav u32][n u32][(id u32, nh u32, f32*nh)*] */
function sumValueBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const first = new Uint8Array(buffers[0]);
  const out = first.slice().buffer;
  const outF = new DataView(out);
  for (let b = 1; b < buffers.length; b++) {
    const dv = new DataView(buffers[b]);
    let o = 4;
    const n = dv.getUint32(o, true);
    o += 4;
    let oo = 8;
    for (let i = 0; i < n; i++) {
      const id = dv.getUint32(o, true);
      const nh = dv.getUint32(o + 4, true);
      const idOut = outF.getUint32(oo, true);
      const nhOut = outF.getUint32(oo + 4, true);
      if (id !== idOut || nh !== nhOut) {
        throw new Error("value buffer layout mismatch");
      }
      o += 8;
      oo += 8;
      for (let h = 0; h < nh; h++) {
        outF.setFloat32(
          oo + h * 4,
          outF.getFloat32(oo + h * 4, true) + dv.getFloat32(o + h * 4, true),
          true
        );
      }
      o += nh * 4;
      oo += nh * 4;
    }
  }
  return out;
}

export interface SessionMeta extends SolverMeta {
  workersUsed: number;
  totalStorageMB: number;
}

export class SolverSession {
  private main: WorkerHandle;
  private workers: WorkerHandle[] = [];
  meta!: SessionMeta;
  iterations = 0;
  readonly k: number;
  private configText: string;

  private constructor(configText: string, k: number) {
    this.configText = configText;
    this.k = k;
    this.main = new WorkerHandle();
    for (let i = 0; i < k; i++) this.workers.push(new WorkerHandle());
  }

  /** k = 0 -> monolithic */
  static async create(
    configText: string,
    k: number
  ): Promise<SolverSession> {
    const s = new SolverSession(configText, k);
    const mainCfg =
      k > 0 ? `${configText}\npartition=main\nworkers=${k}` : configText;
    const inits: Promise<unknown>[] = [
      s.main.call({ type: "init", config: mainCfg }),
    ];
    for (let i = 0; i < k; i++) {
      inits.push(
        s.workers[i].call({
          type: "init",
          config: `${configText}\npartition=worker\nworkers=${k}\nworker_idx=${i}`,
        })
      );
    }
    const metas = (await Promise.all(inits)) as SolverMeta[];
    const total = metas.reduce((a, m) => a + (m.storageMB ?? 0), 0);
    s.meta = { ...metas[0], workersUsed: k, totalStorageMB: total };
    return s;
  }

  async runIterations(n: number): Promise<void> {
    if (this.k === 0) {
      const r = (await this.main.call({ type: "run", iterations: n })) as {
        iterations: number;
      };
      this.iterations = r.iterations;
      return;
    }
    for (let i = 0; i < n; i++) {
      for (const p of [0, 1]) {
        const tasks = (await this.main.call({
          type: "iterBegin",
          traverser: p,
        })) as ArrayBuffer;
        const partials = (await Promise.all(
          this.workers.map((w) =>
            w.call({ type: "subtreeRun", mode: 0, bytes: tasks.slice(0) }, [])
          )
        )) as ArrayBuffer[];
        const summed = sumValueBuffers(partials);
        const r = (await this.main.call(
          { type: "iterFinish", bytes: summed },
          [summed]
        )) as { iterations: number };
        this.iterations = r.iterations;
      }
    }
    await this.syncMirror();
  }

  /** exploitability in bb */
  async exploitability(): Promise<number> {
    if (this.k === 0) {
      const r = (await this.main.call({ type: "run", iterations: 0 })) as {
        exploitability: number;
      };
      return r.exploitability;
    }
    let brTotal = 0;
    for (const p of [0, 1]) {
      const tasks = (await this.main.call({
        type: "brBegin",
        traverser: p,
      })) as ArrayBuffer;
      const partials = (await Promise.all(
        this.workers.map((w) =>
          w.call({ type: "subtreeRun", mode: 1, bytes: tasks.slice(0) }, [])
        )
      )) as ArrayBuffer[];
      const summed = sumValueBuffers(partials);
      const r = (await this.main.call({ type: "brFinish", bytes: summed }, [
        summed,
      ])) as { brTotal: number };
      brTotal += r.brTotal;
    }
    const info = (await this.main.call({ type: "explInfo" })) as {
      dead: number;
      pairWeight: number;
    };
    return (brTotal / info.pairWeight - info.dead) / 2;
  }

  private async syncMirror(): Promise<void> {
    if (this.k === 0) return;
    const mirror = (await this.main.call({
      type: "exportStreet0",
    })) as ArrayBuffer;
    await Promise.all(
      this.workers.map((w) =>
        w.call({ type: "importStreet0", bytes: mirror.slice(0) }, [])
      )
    );
  }

  async query(path: number[], flags: string[]): Promise<NodeData> {
    const pathStr = path.join(",");
    if (this.k === 0) {
      return (await this.main.call({
        type: "query",
        query: `${pathStr}|${flags.join(",")}`,
      })) as NodeData;
    }
    const route = (await this.main.call({
      type: "route",
      path: pathStr,
    })) as { owner: number };
    if (route.owner >= 0) {
      return (await this.workers[route.owner].call({
        type: "query",
        query: `${pathStr}|${flags.join(",")}`,
      })) as NodeData;
    }
    // main serves the node; EV needs a fan-out
    const wantEv = flags.includes("ev");
    const data = (await this.main.call({
      type: "query",
      query: `${pathStr}|${flags.filter((f) => f !== "ev").join(",")}`,
    })) as NodeData;
    if (wantEv && data.ok && data.type === "action") {
      const tasks = (await this.main.call({
        type: "evBegin",
        path: pathStr,
      })) as ArrayBuffer;
      const partials = (await Promise.all(
        this.workers.map((w) =>
          w.call({ type: "subtreeRun", mode: 2, bytes: tasks.slice(0) }, [])
        )
      )) as ArrayBuffer[];
      const summed = new Uint8Array(sumValueBuffers(partials));
      // sv_ev_finish input: [u32 path_len][path bytes][values]
      const pathBytes = new TextEncoder().encode(pathStr);
      const buf = new Uint8Array(4 + pathBytes.length + summed.length);
      new DataView(buf.buffer).setUint32(0, pathBytes.length, true);
      buf.set(pathBytes, 4);
      buf.set(summed, 4 + pathBytes.length);
      const evr = (await this.main.call(
        { type: "evFinish", bytes: buf.buffer },
        [buf.buffer]
      )) as { evs: number[] };
      data.evs = evr.evs;
    }
    return data;
  }

  async exportStates(): Promise<ArrayBuffer[]> {
    const all = [this.main, ...this.workers];
    return (await Promise.all(
      all.map((w) => w.call({ type: "exportState" }))
    )) as ArrayBuffer[];
  }

  async importStates(states: ArrayBuffer[]): Promise<number> {
    const all = [this.main, ...this.workers];
    if (states.length !== all.length) throw new Error("state count mismatch");
    const rs = (await Promise.all(
      all.map((w, i) => w.call({ type: "importState", bytes: states[i] }))
    )) as { iterations: number }[];
    this.iterations = rs[0].iterations;
    await this.syncMirror();
    return this.iterations;
  }

  get config(): string {
    return this.configText;
  }

  terminate() {
    this.main.terminate();
    for (const w of this.workers) w.terminate();
  }
}

/** pick the worker count for a spot */
export function chooseWorkers(boardCards: number): number {
  if (boardCards >= 5) return 0; // river solves are fast single-instance
  const hc = navigator.hardwareConcurrency || 4;
  return Math.min(8, Math.max(2, hc - 2));
}
