// IndexedDB cache for solved spots.

const DB_NAME = "fable-poker";
const STORE = "solves";
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // evict beyond ~2 GB

export interface CachedSolve {
  key: string;
  iterations: number;
  workers: number; // partition worker count (0 = monolithic)
  states: ArrayBuffer[]; // [main, ...workers] or [mono]
  savedAt: number;
  bytes: number;
  label: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheGet(key: string): Promise<CachedSolve | null> {
  try {
    const db = await openDb();
    const r = await tx<CachedSolve | undefined>(db, "readonly", (s) =>
      s.get(key) as IDBRequest<CachedSolve | undefined>
    );
    db.close();
    return r ?? null;
  } catch {
    return null;
  }
}

export async function cachePut(entry: CachedSolve): Promise<boolean> {
  try {
    const db = await openDb();
    await tx(db, "readwrite", (s) => s.put(entry));
    // LRU eviction by total size
    const all = await tx<CachedSolve[]>(db, "readonly", (s) =>
      s.getAll() as IDBRequest<CachedSolve[]>
    );
    let total = all.reduce((a, e) => a + e.bytes, 0);
    if (total > MAX_TOTAL_BYTES) {
      const sorted = all.sort((a, b) => a.savedAt - b.savedAt);
      for (const e of sorted) {
        if (total <= MAX_TOTAL_BYTES || e.key === entry.key) continue;
        await tx(db, "readwrite", (s) => s.delete(e.key));
        total -= e.bytes;
      }
    }
    db.close();
    return true;
  } catch (e) {
    console.warn("cache put failed:", e);
    return false;
  }
}

/** FNV-1a (two 32-bit lanes); crypto.subtle is unavailable outside secure
 * contexts, and collision resistance is not a concern for a local cache. */
export async function cacheKey(configText: string): Promise<string> {
  const data = new TextEncoder().encode("v2:" + configText);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < data.length; i++) {
    h1 = Math.imul(h1 ^ data[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ data[(data.length - 1 - i) >>> 0], 0x01000193) >>> 0;
  }
  return (
    h1.toString(16).padStart(8, "0") +
    h2.toString(16).padStart(8, "0") +
    data.length.toString(16)
  );
}
