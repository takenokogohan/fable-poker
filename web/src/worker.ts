// Web Worker hosting one WASM solver instance (main or partition worker).
// Plain C ABI; JSON results are parsed, binary results are transferred.

interface SolverExports {
  memory: WebAssembly.Memory;
  sv_alloc(len: number): number;
  sv_free(ptr: number, len: number): void;
  sv_free_result(ptr: number): void;
  sv_init(ptr: number, len: number): number;
  sv_run(iterations: number): number;
  sv_query(ptr: number, len: number): number;
  sv_iter_begin(traverser: number): number;
  sv_iter_finish(ptr: number, len: number): number;
  sv_subtree_run(mode: number, ptr: number, len: number): number;
  sv_br_begin(traverser: number): number;
  sv_br_finish(ptr: number, len: number): number;
  sv_expl_info(): number;
  sv_ev_begin(ptr: number, len: number): number;
  sv_ev_finish(ptr: number, len: number): number;
  sv_route(ptr: number, len: number): number;
  sv_export_state(): number;
  sv_import_state(ptr: number, len: number): number;
  sv_export_street0(): number;
  sv_import_street0(ptr: number, len: number): number;
}

let exports: SolverExports | null = null;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function load(): Promise<SolverExports> {
  if (exports) return exports;
  const resp = await fetch("/solver.wasm");
  let instance: WebAssembly.Instance;
  try {
    ({ instance } = await WebAssembly.instantiateStreaming(resp, {}));
  } catch {
    const buf = await (await fetch("/solver.wasm")).arrayBuffer();
    ({ instance } = await WebAssembly.instantiate(buf, {}));
  }
  exports = instance.exports as unknown as SolverExports;
  return exports;
}

function writeBytes(ex: SolverExports, bytes: Uint8Array): [number, number] {
  const ptr = ex.sv_alloc(bytes.length);
  new Uint8Array(ex.memory.buffer).set(bytes, ptr);
  return [ptr, bytes.length];
}

/** read a length-prefixed result and free it; returns a copy */
function readRaw(ex: SolverExports, ptr: number): Uint8Array {
  const view = new DataView(ex.memory.buffer);
  const len = view.getUint32(ptr, true);
  const copy = new Uint8Array(len);
  copy.set(new Uint8Array(ex.memory.buffer, ptr + 4, len));
  ex.sv_free_result(ptr);
  return copy;
}

function readJson(ex: SolverExports, ptr: number): unknown {
  return JSON.parse(decoder.decode(readRaw(ex, ptr)));
}

/** binary results may be an error JSON; detect by leading '{' */
function binOrError(bytes: Uint8Array): { bin?: ArrayBuffer; err?: string } {
  if (bytes.length > 0 && bytes[0] === 0x7b) {
    try {
      const obj = JSON.parse(decoder.decode(bytes)) as { error?: string };
      return { err: obj.error ?? "solver error" };
    } catch {
      // fall through: binary that happens to start with '{'
    }
  }
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  );
  return { bin: buf as ArrayBuffer };
}

self.onmessage = async (e: MessageEvent) => {
  const { id, type } = e.data;
  try {
    const ex = await load();
    const withString = (fn: (p: number, l: number) => number, s: string) => {
      const [p, l] = writeBytes(ex, encoder.encode(s));
      const out = fn(p, l);
      ex.sv_free(p, l);
      return out;
    };
    const withBytes = (
      fn: (p: number, l: number) => number,
      b: ArrayBuffer
    ) => {
      const [p, l] = writeBytes(ex, new Uint8Array(b));
      const out = fn(p, l);
      ex.sv_free(p, l);
      return out;
    };

    let json: unknown = undefined;
    let bin: ArrayBuffer | undefined = undefined;

    switch (type) {
      case "init":
        json = readJson(ex, withString(ex.sv_init.bind(ex), e.data.config));
        break;
      case "run":
        json = readJson(ex, ex.sv_run(e.data.iterations));
        break;
      case "query":
        json = readJson(ex, withString(ex.sv_query.bind(ex), e.data.query));
        break;
      case "iterBegin": {
        const r = binOrError(readRaw(ex, ex.sv_iter_begin(e.data.traverser)));
        if (r.err) json = { ok: false, error: r.err };
        else bin = r.bin;
        break;
      }
      case "iterFinish":
        json = readJson(ex, withBytes(ex.sv_iter_finish.bind(ex), e.data.bytes));
        break;
      case "subtreeRun": {
        const fn = (p: number, l: number) =>
          ex.sv_subtree_run(e.data.mode, p, l);
        const r = binOrError(readRaw(ex, withBytes(fn, e.data.bytes)));
        if (r.err) json = { ok: false, error: r.err };
        else bin = r.bin;
        break;
      }
      case "brBegin": {
        const r = binOrError(readRaw(ex, ex.sv_br_begin(e.data.traverser)));
        if (r.err) json = { ok: false, error: r.err };
        else bin = r.bin;
        break;
      }
      case "brFinish":
        json = readJson(ex, withBytes(ex.sv_br_finish.bind(ex), e.data.bytes));
        break;
      case "explInfo":
        json = readJson(ex, ex.sv_expl_info());
        break;
      case "evBegin": {
        const r = binOrError(
          readRaw(ex, withString(ex.sv_ev_begin.bind(ex), e.data.path))
        );
        if (r.err) json = { ok: false, error: r.err };
        else bin = r.bin;
        break;
      }
      case "evFinish":
        json = readJson(ex, withBytes(ex.sv_ev_finish.bind(ex), e.data.bytes));
        break;
      case "route":
        json = readJson(ex, withString(ex.sv_route.bind(ex), e.data.path));
        break;
      case "exportState": {
        const r = binOrError(readRaw(ex, ex.sv_export_state()));
        if (r.err) json = { ok: false, error: r.err };
        else bin = r.bin;
        break;
      }
      case "importState":
        json = readJson(
          ex,
          withBytes(ex.sv_import_state.bind(ex), e.data.bytes)
        );
        break;
      case "exportStreet0": {
        const r = binOrError(readRaw(ex, ex.sv_export_street0()));
        if (r.err) json = { ok: false, error: r.err };
        else bin = r.bin;
        break;
      }
      case "importStreet0":
        json = readJson(
          ex,
          withBytes(ex.sv_import_street0.bind(ex), e.data.bytes)
        );
        break;
      default:
        json = { ok: false, error: `unknown message type ${type}` };
    }

    if (bin !== undefined) {
      (self as unknown as Worker).postMessage({ id, bin }, [bin]);
    } else {
      self.postMessage({ id, result: json });
    }
  } catch (err) {
    self.postMessage({ id, result: { ok: false, error: String(err) } });
  }
};
