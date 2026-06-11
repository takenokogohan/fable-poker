// Range string parsing and 6-max preflop presets (approximate 100bb GTO
// ranges; editable in the UI before solving).

import { RANKS } from "./poker";

// rank char -> index 0..12 (2..A)
const ri = (c: string) => RANKS.indexOf(c.toUpperCase());

/** cell index from high rank, low rank, type. ranks are 0..12 (A=12). */
function cell(hi: number, lo: number, type: "p" | "s" | "o"): number {
  const row = 12 - hi;
  const col = 12 - lo;
  if (type === "p") return row * 13 + row;
  return type === "s" ? row * 13 + col : col * 13 + row;
}

/**
 * Parse a range string like:
 *   "22+, 55-22, ATs+, A5s-A2s, KQo, T9s, QQ:0.5, A2s+:0.25"
 * into 169 weights.
 */
export function parseRange(text: string): Float32Array {
  const grid = new Float32Array(169);
  for (let part of text.split(",")) {
    part = part.trim();
    if (!part) continue;
    let weight = 1;
    const colon = part.indexOf(":");
    if (colon >= 0) {
      weight = parseFloat(part.slice(colon + 1));
      part = part.slice(0, colon).trim();
    }
    const set = (c: number) => {
      grid[c] = Math.max(grid[c], weight);
    };
    const plus = part.endsWith("+");
    if (plus) part = part.slice(0, -1);

    if (part.includes("-")) {
      // dash range: pairs "TT-66" or same-high "A5s-A2s"
      const [a, b] = part.split("-").map((t) => t.trim());
      if (a.length === 2 && a[0] === a[1]) {
        const hiP = ri(a[0]);
        const loP = ri(b[0]);
        for (let r = Math.min(hiP, loP); r <= Math.max(hiP, loP); r++)
          set(cell(r, r, "p"));
      } else {
        const type = a[2]?.toLowerCase() === "s" ? "s" : "o";
        const hi = ri(a[0]);
        const from = ri(b[1]);
        const to = ri(a[1]);
        for (let r = Math.min(from, to); r <= Math.max(from, to); r++)
          set(cell(hi, r, type));
      }
    } else if (part.length === 2 && part[0] === part[1]) {
      // pair, maybe with +
      const start = ri(part[0]);
      const end = plus ? 12 : start;
      for (let r = start; r <= end; r++) set(cell(r, r, "p"));
    } else if (part.length >= 2) {
      const hi = ri(part[0]);
      const lo = ri(part[1]);
      const typeChar = part[2]?.toLowerCase();
      const types: ("s" | "o")[] =
        typeChar === "s" ? ["s"] : typeChar === "o" ? ["o"] : ["s", "o"];
      for (const t of types) {
        if (plus) {
          // second rank from lo up to hi-1
          for (let r = lo; r < hi; r++) set(cell(hi, r, t));
        } else {
          set(cell(hi, lo, t));
        }
      }
    }
  }
  return grid;
}

// ---- preflop scenario builder ----
// Positions and orderings. Preflop action order: EP HJ CO BTN SB BB.
// Postflop the blinds act first: SB BB EP HJ CO BTN.

export const POSITIONS = ["EP", "HJ", "CO", "BTN", "SB", "BB"] as const;
export type Position = (typeof POSITIONS)[number];
export type PotType = "srp" | "3bp" | "4bp";

const PREFLOP_ORDER: Position[] = ["EP", "HJ", "CO", "BTN", "SB", "BB"];
const POSTFLOP_ORDER: Position[] = ["SB", "BB", "EP", "HJ", "CO", "BTN"];

export const OPENER_POSITIONS: Position[] = ["EP", "HJ", "CO", "BTN", "SB"];

export function validDefenders(opener: Position): Position[] {
  const i = PREFLOP_ORDER.indexOf(opener);
  return PREFLOP_ORDER.slice(i + 1);
}

// ---- approximate 100bb 6-max ranges (editable in the UI) ----
// Every range comes in three tightness levels. "normal" aims at standard
// GTO-ish widths; "loose" is roughly the old presets; "tight" is value-lean.

export type Tightness = "tight" | "normal" | "loose";
export const TIGHTNESS_LABELS: Record<Tightness, string> = {
  tight: "タイト",
  normal: "ノーマル",
  loose: "ルース",
};

type V3 = Record<Tightness, string>;

const RFI: Record<string, V3> = {
  EP: {
    tight: "66+, ATs+, A5s:0.5, KTs+, QTs+, JTs, T9s:0.5, AQo+, KQo:0.5",
    normal: "22+, ATs+, A5s-A4s, KTs+, QTs+, JTs, T9s, 98s, 87s, AJo+, KQo",
    loose:
      "22+, A9s+, A5s-A2s, K9s+, Q9s+, J9s+, T9s, 98s, 87s, 76s, 65s, 54s, ATo+, KJo+, QJo",
  },
  HJ: {
    tight: "22+, ATs+, A5s-A4s, KTs+, QTs+, JTs, T9s, 98s, AJo+, KQo",
    normal:
      "22+, A9s+, A5s-A2s, K9s+, Q9s+, J9s+, T9s, 98s, 87s, 76s, 65s, 54s, ATo+, KJo+, QJo",
    loose:
      "22+, A7s+, A5s-A2s, K8s+, Q9s+, J8s+, T8s+, 97s+, 87s, 76s, 65s, 54s, A9o+, KTo+, QTo+, JTo",
  },
  CO: {
    tight:
      "22+, A9s+, A5s-A2s, K9s+, Q9s+, J9s+, T9s, 98s, 87s, 76s, ATo+, KJo+, QJo",
    normal:
      "22+, A2s+, K7s+, Q8s+, J8s+, T8s+, 97s+, 87s, 76s, 65s, 54s, A9o+, A5o, KTo+, QTo+, JTo",
    loose:
      "22+, A2s+, K5s+, Q6s+, J7s+, T7s+, 96s+, 86s+, 75s+, 64s+, 54s, A7o+, A5o, K9o+, Q9o+, J9o+, T9o",
  },
  BTN: {
    tight:
      "22+, A2s+, K6s+, Q8s+, J8s+, T7s+, 97s+, 86s+, 75s+, 65s, 54s, A8o+, A5o, KTo+, QTo+, JTo, T9o",
    normal:
      "22+, A2s+, K2s+, Q4s+, J6s+, T6s+, 95s+, 85s+, 74s+, 64s+, 53s+, 43s, A4o+, K9o+, Q9o+, J9o+, T9o, 98o",
    loose:
      "22+, A2s+, K2s+, Q2s+, J4s+, T5s+, 95s+, 84s+, 74s+, 63s+, 53s+, 43s, A2o+, K7o+, Q8o+, J8o+, T8o+, 97o+, 87o",
  },
  SB: {
    tight:
      "22+, A2s+, K7s+, Q8s+, J8s+, T8s+, 97s+, 87s, 76s, 65s, A8o+, A5o, KTo+, QTo+, JTo",
    normal:
      "22+, A2s+, K2s+, Q3s+, J5s+, T6s+, 96s+, 85s+, 75s+, 64s+, 54s, A2o+, K8o+, Q9o+, J9o+, T9o",
    loose:
      "22+, A2s+, K2s+, Q2s+, J4s+, T5s+, 95s+, 85s+, 74s+, 64s+, 53s+, A2o+, K6o+, Q8o+, J8o+, T8o+, 98o",
  },
};

// BB flat vs an open, keyed by opener
const BB_FLAT: Record<string, V3> = {
  EP: {
    tight:
      "22-99, ATs-AJs:0.75, A5s-A2s:0.5, K9s+, QTs+, JTs, T9s, 98s, 87s, 76s, AJo:0.5, KQo:0.5",
    normal:
      "22-99, A2s-AJs:0.75, K8s+, Q9s+, J8s+, T8s+, 97s+, 87s, 76s, 65s, 54s, ATo:0.5, AJo:0.75, KJo+, QJo",
    loose:
      "22-99, A2s-AJs, K6s+, Q8s+, J8s+, T7s+, 96s+, 86s+, 75s+, 64s+, 54s, ATo+, KTo+, QJo, JTo:0.5",
  },
  HJ: {
    tight:
      "22-99, A2s-AJs:0.6, K9s+, QTs+, JTs, T9s, 98s, 87s, 76s, 65s, ATo:0.5, AJo:0.75, KQo:0.75",
    normal:
      "22-99, A2s-AJs:0.75, K7s+, Q8s+, J8s+, T8s+, 97s+, 87s, 76s, 65s, 54s, ATo:0.75, AJo, KJo+, QJo, JTo:0.5",
    loose:
      "22-99, A2s-AJs, K5s+, Q8s+, J7s+, T7s+, 96s+, 86s+, 75s+, 64s+, 54s, A8o+, KTo+, QTo+, JTo, T9o:0.5",
  },
  CO: {
    tight:
      "22-99, A2s-AJs:0.75, K8s+, Q9s+, J8s+, T8s+, 97s+, 87s, 76s, 65s, 54s, ATo:0.75, KJo+, QJo, JTo:0.5",
    normal:
      "22-99, A2s-AJs, K5s+, Q7s+, J7s+, T7s+, 96s+, 86s+, 75s+, 64s+, 54s, A5o-A9o:0.5, ATo, KTo+, QTo+, JTo",
    loose:
      "22-99, A2s-AJs, K2s+, Q5s+, J6s+, T6s+, 95s+, 85s+, 74s+, 64s+, 53s+, A2o+:0.6, ATo, KTo+, Q9o+, J9o+, T9o, 98o:0.5",
  },
  BTN: {
    tight:
      "22-99, A2s-ATs:0.75, K7s+, Q8s+, J7s+, T7s+, 96s+, 86s+, 75s+, 64s+, 54s, A5o-A9o:0.6, ATo, KTo+, QTo+, JTo, T9o",
    normal:
      "22-99, A2s-A9s, ATs:0.5, K2s+, Q2s+, J4s+, T6s+, 96s+, 85s+, 74s+, 63s+, 53s+, 43s, A2o-A9o, K9o+, Q9o+, J9o+, T8o+, 98o, 87o:0.5",
    loose:
      "22-99, A2s-A9s, ATs:0.5, K2s+, Q2s+, J2s+, T4s+, 95s+, 84s+, 74s+, 63s+, 52s+, 43s, A2o+, K8o+, K7o:0.5, Q8o+, J8o+, T8o+, 97o+, 87o, 76o, 65o:0.5",
  },
  SB: {
    tight:
      "22+, A2s+, K5s+, Q7s+, J7s+, T7s+, 96s+, 86s+, 75s+, 64s+, 54s, A2o+:0.75, K9o+, Q9o+, J9o+, T9o",
    normal:
      "22+, A2s+, K2s+, Q2s+, J4s+, T5s+, 95s+, 85s+, 74s+, 63s+, 53s+, 43s, A2o+, K6o+, Q8o+, J8o+, T8o+, 97o+, 87o, 76o",
    loose:
      "22+, A2s+, K2s+, Q2s+, J2s+, T4s+, 95s+, 84s+, 74s+, 63s+, 52s+, 42s+, 32s, A2o+, K4o+, Q6o+, J7o+, T7o+, 97o+, 86o+, 76o, 65o",
  },
};

// SB flat vs an open (narrow, no closing-action incentive)
const SB_FLAT: V3 = {
  tight: "55-TT, AJs, KQs, QJs:0.5, JTs:0.5, T9s:0.5",
  normal:
    "22-TT, JJ:0.3, AJs, ATs:0.5, A5s:0.3, KQs, KJs:0.5, QJs, JTs, T9s, 98s:0.5, AQo:0.25",
  loose:
    "22-JJ, AQs:0.5, AJs, ATs, A5s:0.5, KQs, KJs, KTs:0.5, QJs, QTs:0.5, JTs, T9s, 98s, 87s:0.5, AQo:0.5, KQo:0.25",
};

// in-position cold call vs an earlier open (HJ/CO/BTN)
const IP_FLAT: V3 = {
  tight: "55-JJ, QQ:0.25, AQs:0.5, AJs:0.5, KQs, QJs:0.5, JTs:0.5, T9s:0.5",
  normal:
    "22-JJ, QQ:0.25, AQs:0.5, AJs, ATs:0.5, KQs, KJs:0.5, QJs, JTs, T9s, 98s:0.5",
  loose:
    "22-JJ, QQ:0.3, AQs:0.5, AJs, ATs, A5s:0.5, KQs, KJs, KTs:0.5, QJs, QTs:0.5, JTs, T9s, 98s, 87s:0.5, 76s:0.5, AQo:0.3",
};

// 3bet ranges
const BB_3BET: Record<string, V3> = {
  EP: {
    tight: "QQ+, AKs, AKo, A5s:0.3",
    normal: "QQ+, JJ:0.5, AKs, AQs:0.5, A5s-A4s:0.5, KQs:0.3, AKo, AQo:0.3",
    loose:
      "TT+, AQs+, AJs:0.5, A5s-A4s, KQs:0.5, KJs:0.3, JTs:0.3, AKo, AQo:0.5",
  },
  HJ: {
    tight: "JJ+, AQs+, A5s:0.4, AKo",
    normal:
      "JJ+, TT:0.5, AQs+, AJs:0.3, A5s-A4s:0.6, KQs:0.5, KJs:0.3, AKo, AQo:0.5, KQo:0.3",
    loose:
      "TT+, 99:0.5, AJs+, ATs:0.5, A5s-A3s, KQs, KJs:0.5, QJs:0.4, JTs:0.4, AQo+, KQo:0.5",
  },
  CO: {
    tight: "TT+, AJs+, A5s-A4s:0.5, KQs:0.5, AQo+",
    normal:
      "TT+, 99:0.3, AJs+, ATs:0.3, A5s-A2s:0.5, KQs, KJs:0.5, QJs:0.3, JTs:0.3, AQo+, KQo:0.5",
    loose:
      "99+, ATs+, A9s:0.5, A5s-A2s:0.75, KTs+, QTs+, JTs, T9s:0.5, 98s:0.5, AJo+, ATo:0.4, KQo, KJo:0.4",
  },
  BTN: {
    tight: "TT+, ATs+, A5s-A4s, KJs+, QJs:0.5, JTs:0.5, AQo+, KQo:0.5",
    normal:
      "TT+, 99:0.3, ATs+, A5s-A2s:0.6, K9s+, QTs+, JTs, T9s:0.5, 98s:0.5, AJo+, ATo:0.3, KQo, KJo:0.5",
    loose:
      "99+, 88:0.5, A8s+, A5s-A2s, K8s+, Q9s+, J9s+, T9s, 98s, 87s:0.5, 76s:0.5, 65s:0.5, ATo+, A9o:0.4, KJo+, KTo:0.5, QJo:0.75, JTo:0.4",
  },
  SB: {
    tight: "TT+, ATs+, A5s-A4s:0.5, KJs+, AJo+, KQo:0.5",
    normal:
      "99+, A9s+, A5s-A2s:0.6, K9s+, QTs+, JTs, T9s:0.5, 98s:0.5, AJo+, ATo:0.4, KQo, KJo:0.5",
    loose:
      "88+, A7s+, A5s-A2s, K8s+, Q9s+, J9s+, T8s+, 98s, 87s:0.5, 76s:0.5, ATo+, A9o:0.5, KTo+, QTo+, JTo:0.5",
  },
};

const SB_3BET: Record<string, V3> = {
  EP: {
    tight: "QQ+, AKs, AKo, AQs:0.4",
    normal: "QQ+, JJ:0.6, AKs, AQs:0.6, A5s:0.5, KQs:0.4, AKo, AQo:0.3",
    loose:
      "TT+, AQs+, AJs:0.6, A5s-A4s:0.75, KQs:0.75, KJs:0.4, AKo, AQo:0.6",
  },
  HJ: {
    tight: "JJ+, AQs+, A5s:0.4, AKo, AQo:0.3",
    normal:
      "JJ+, TT:0.6, AQs+, AJs:0.5, A5s-A4s:0.6, KQs:0.6, AKo, AQo:0.6",
    loose:
      "TT+, 99:0.5, AJs+, ATs:0.6, A5s-A3s:0.75, KQs, KJs:0.5, QJs:0.5, JTs:0.4, AQo+, KQo:0.5",
  },
  CO: {
    tight: "JJ+, TT:0.5, AQs+, A5s:0.5, KQs:0.5, AQo+",
    normal:
      "TT+, 99:0.5, AJs+, ATs:0.5, A5s-A4s, KQs, KJs:0.5, QJs:0.4, AQo+, KQo:0.4",
    loose:
      "99+, ATs+, A9s:0.5, A5s-A2s, KTs+, QTs+, JTs, T9s:0.5, AJo+, ATo:0.4, KQo, KJo:0.5",
  },
  BTN: {
    tight: "TT+, ATs+, A5s-A4s, KJs+, QJs:0.5, AJo+, KQo:0.75",
    normal:
      "99+, 88:0.5, ATs+, A5s-A2s:0.7, K9s+, QTs+, JTs, T9s:0.4, AJo+, ATo:0.4, KQo, KJo:0.4",
    loose:
      "88+, 77:0.5, A8s+, A5s-A2s, K9s+, Q9s+, J9s+, T8s+, 98s, 87s:0.5, ATo+, A9o:0.5, KTo+, QTo+, JTo:0.5",
  },
};

const IP_3BET: Record<string, V3> = {
  EP: {
    tight: "QQ+, JJ:0.5, AKs, AQs:0.5, AKo",
    normal: "JJ+, TT:0.3, AQs+, AJs:0.3, A5s:0.5, KQs:0.5, AKo, AQo:0.3",
    loose:
      "TT+, AQs+, AJs:0.6, A5s-A4s:0.75, KQs, KJs:0.4, JTs:0.3, AKo, AQo:0.6",
  },
  HJ: {
    tight: "JJ+, AQs+, A5s:0.5, KQs:0.4, AKo, AQo:0.3",
    normal:
      "TT+, 99:0.3, AQs+, AJs:0.5, A5s-A4s:0.5, KQs:0.7, KJs:0.3, AKo, AQo:0.5, KQo:0.2",
    loose:
      "99+, AJs+, ATs:0.6, A5s-A3s:0.75, KQs, KJs:0.6, QJs:0.5, JTs:0.5, AQo+, AJo:0.4, KQo:0.5",
  },
  CO: {
    tight: "TT+, AJs+, A5s-A4s:0.6, KQs:0.75, AQo+",
    normal:
      "99+, 88:0.5, AJs+, ATs:0.5, A5s-A4s, KQs, KJs:0.5, QJs:0.5, JTs:0.5, T9s:0.5, AQo+, AJo:0.3, KQo:0.3",
    loose:
      "88+, ATs+, A9s:0.5, A5s-A2s, KTs+, QTs+, JTs, T9s, 98s:0.5, AJo+, ATo:0.4, KQo, KJo:0.5, QJo:0.3",
  },
  BTN: { tight: "", normal: "", loose: "" }, // BTN never faces a later non-blind 3bettor
};

// opener continuing vs a 3bet (call), by whether the opener is in position
const CALL_3BET_OOP: V3 = {
  tight:
    "99-QQ, KK:0.3, AA:0.3, AQs+, AJs:0.4, A5s:0.3, KQs:0.5, JTs:0.3, AKo:0.5",
  normal:
    "99-QQ, KK:0.4, AA:0.4, 88:0.5, AQs+, AJs:0.5, A5s:0.5, KQs, KJs:0.3, QJs:0.4, JTs:0.4, AQo:0.4, AKo:0.6",
  loose:
    "88-QQ, KK:0.4, AA:0.4, 77:0.5, AQs+, AJs, ATs:0.5, A5s:0.6, KQs, KJs:0.5, QJs, JTs, T9s:0.5, 98s:0.4, AQo:0.6, AKo:0.6, KQo:0.3",
};
const CALL_3BET_IP: V3 = {
  tight:
    "77-JJ, QQ:0.4, KK:0.2, AA:0.2, AQs+, AJs:0.6, ATs:0.4, A5s:0.4, KQs, KJs:0.4, QJs:0.6, JTs:0.6, T9s:0.4, AKo:0.5, AQo:0.4",
  normal:
    "55-JJ, QQ:0.5, KK:0.25, AA:0.25, ATs+, A5s-A4s:0.5, KTs+, QTs+, JTs, T9s, 98s:0.5, 87s:0.5, AQo+, KQo:0.5",
  loose:
    "22-JJ, QQ:0.5, KK:0.25, AA:0.25, A8s+, A5s-A2s:0.5, K9s+, Q9s+, J9s+, T8s+, 97s+, 87s, 76s, 65s, 54s, AJo+, KQo, KJo:0.5",
};

// 4bet pots
const FOURBET_RANGE: V3 = {
  tight: "KK+, QQ:0.4, AKs, AKo:0.5, A5s:0.25",
  normal: "KK+, QQ:0.6, JJ:0.2, AKs, AKo:0.7, A5s:0.4, AQs:0.2",
  loose: "QQ+, JJ:0.4, TT:0.2, AKs, AQs:0.4, A5s-A4s:0.5, KQs:0.2, AKo, AQo:0.3",
};
const CALL_4BET: V3 = {
  tight: "QQ:0.6, KK:0.4, AA:0.3, JJ:0.4, AKs, AKo:0.4, A5s:0.25",
  normal:
    "QQ:0.7, KK:0.5, AA:0.4, JJ:0.6, TT:0.3, AKs, AQs:0.4, A5s:0.4, KQs:0.2, AKo:0.6",
  loose:
    "QQ:0.75, KK:0.5, AA:0.4, JJ:0.75, TT:0.5, 99:0.3, AKs, AQs:0.6, AJs:0.3, A5s-A4s:0.5, KQs:0.4, AKo:0.7, AQo:0.3",
};

/** elementwise min: restrict `a` to hands also in `b` */
function intersect(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(169);
  for (let i = 0; i < 169; i++) out[i] = Math.min(a[i], b[i]);
  return out;
}

export interface Scenario {
  oopName: Position;
  ipName: Position;
  pot: number;
  stack: number;
  oopRange: Float32Array;
  ipRange: Float32Array;
  description: string;
}

function flatVsOpen(
  defender: Position,
  opener: Position,
  t: Tightness
): Float32Array {
  if (defender === "BB") return parseRange(BB_FLAT[opener][t]);
  if (defender === "SB") return parseRange(SB_FLAT[t]);
  return parseRange(IP_FLAT[t]);
}

function threeBetVsOpen(
  defender: Position,
  opener: Position,
  t: Tightness
): Float32Array {
  if (defender === "BB") return parseRange(BB_3BET[opener][t]);
  if (defender === "SB") return parseRange((SB_3BET[opener] ?? SB_3BET.CO)[t]);
  return parseRange((IP_3BET[opener] ?? IP_3BET.CO)[t]);
}

/**
 * Build a postflop scenario from a preflop line.
 * Sizes: open 2.5bb (SB 3bb); 3bet 3x open in position, 4.4x from the blinds;
 * 4bet 2.4x the 3bet. 100bb starting stacks.
 */
export function buildScenario(
  opener: Position,
  defender: Position,
  potType: PotType,
  tightness: Tightness = "normal"
): Scenario {
  const t = tightness;
  const openTo = opener === "SB" ? 3 : 2.5;
  const defenderIsBlind = defender === "SB" || defender === "BB";
  const threeBetTo = defenderIsBlind
    ? Math.round(openTo * 4.4)
    : openTo * 3;
  const fourBetTo = Math.round(threeBetTo * 2.4);

  // dead blinds from players not in the hand
  let dead = 0;
  if (opener !== "SB" && defender !== "SB") dead += 0.5;
  if (defender !== "BB") dead += 1;

  let openerRange: Float32Array;
  let defenderRange: Float32Array;
  let committed: number;
  let description: string;

  const rfi = parseRange(RFI[opener][t]);
  const openerInPosition =
    POSTFLOP_ORDER.indexOf(opener) > POSTFLOP_ORDER.indexOf(defender);
  if (potType === "srp") {
    openerRange = rfi;
    defenderRange = flatVsOpen(defender, opener, t);
    committed = openTo;
    description = `${opener} ${openTo}bb オープン → ${defender} コール`;
  } else if (potType === "3bp") {
    openerRange = intersect(
      parseRange(openerInPosition ? CALL_3BET_IP[t] : CALL_3BET_OOP[t]),
      rfi
    );
    defenderRange = threeBetVsOpen(defender, opener, t);
    committed = threeBetTo;
    description = `${opener} オープン → ${defender} ${threeBetTo}bb 3bet → ${opener} コール`;
  } else {
    openerRange = intersect(parseRange(FOURBET_RANGE[t]), rfi);
    defenderRange = intersect(
      parseRange(CALL_4BET[t]),
      threeBetVsOpen(defender, opener, t)
    );
    committed = fourBetTo;
    description = `${opener} オープン → ${defender} 3bet → ${opener} ${fourBetTo}bb 4bet → ${defender} コール`;
  }

  const pot = committed * 2 + dead;
  const stack = 100 - committed;

  // OOP = first to act postflop
  const openerFirst =
    POSTFLOP_ORDER.indexOf(opener) < POSTFLOP_ORDER.indexOf(defender);
  return openerFirst
    ? {
        oopName: opener,
        ipName: defender,
        pot,
        stack,
        oopRange: openerRange,
        ipRange: defenderRange,
        description,
      }
    : {
        oopName: defender,
        ipName: opener,
        pot,
        stack,
        oopRange: defenderRange,
        ipRange: openerRange,
        description,
      };
}

/** total combo fraction of a 169 grid (for display) */
export function rangePercent(grid: Float32Array): number {
  let total = 0;
  for (let c = 0; c < 169; c++) {
    const row = Math.floor(c / 13);
    const col = c % 13;
    const combos = row === col ? 6 : row < col ? 4 : 12;
    total += grid[c] * combos;
  }
  return (total / 1326) * 100;
}
