// User-saved range overrides, persisted in localStorage per scenario slot
// (opener × defender × pot type × tightness × side).

import type { Position, PotType, Tightness } from "./ranges";

export type Side = "oop" | "ip";

function key(
  opener: Position,
  defender: Position,
  potType: PotType,
  tightness: Tightness,
  side: Side
): string {
  return `fp-range:${opener}:${defender}:${potType}:${tightness}:${side}`;
}

export function loadCustomRange(
  opener: Position,
  defender: Position,
  potType: PotType,
  tightness: Tightness,
  side: Side
): Float32Array | null {
  try {
    const raw = localStorage.getItem(key(opener, defender, potType, tightness, side));
    if (raw === null) return null;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) === false || arr.length !== 169) return null;
    return new Float32Array(arr);
  } catch {
    return null;
  }
}

export function saveCustomRange(
  opener: Position,
  defender: Position,
  potType: PotType,
  tightness: Tightness,
  side: Side,
  grid: Float32Array
): boolean {
  try {
    const arr = Array.from(grid).map((v) => +v.toFixed(3));
    localStorage.setItem(
      key(opener, defender, potType, tightness, side),
      JSON.stringify(arr)
    );
    return true;
  } catch {
    return false; // quota or privacy mode
  }
}

export function clearCustomRange(
  opener: Position,
  defender: Position,
  potType: PotType,
  tightness: Tightness,
  side: Side
): void {
  try {
    localStorage.removeItem(key(opener, defender, potType, tightness, side));
  } catch {
    /* ignore */
  }
}
