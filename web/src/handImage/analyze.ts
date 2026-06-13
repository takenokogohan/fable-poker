// Bridge a parsed hand to a solver spot: figure out the preflop roles
// (opener / defender) and reconstruct both players' ranges via the existing
// presets, so the hand can be solved and the hero's decisions evaluated.

import {
  buildScenario,
  type Position as RangePos,
  type PotType,
  type Tightness,
} from "../ranges";
import type { ParsedHand, Position } from "./parse";

export interface SpotMapping {
  valid: boolean;
  reason?: string;
  opener?: Position;
  defender?: Position;
  potType?: PotType;
  oop?: Position;
  ip?: Position;
  hero?: Position;
  heroIsOop?: boolean;
  board?: string;
  pot?: number;
  stack?: number;
  oopRange?: Float32Array;
  ipRange?: Float32Array;
}

const POSTFLOP_ORDER: Position[] = ["SB", "BB", "UTG", "HJ", "CO", "BTN"];

// the parser labels the first seat "UTG"; the range presets call it "EP"
const toRangePos = (p: Position): RangePos => (p === "UTG" ? "EP" : (p as RangePos));
const fromRangePos = (p: RangePos): Position => (p === "EP" ? "UTG" : (p as Position));

export function handToScenario(hand: ParsedHand, tightness: Tightness = "normal"): SpotMapping {
  const pre = hand.streets.find((s) => s.street === "preflop")?.actions ?? [];
  const raisers = pre.filter((a) => a.action === "raise").map((a) => a.position);

  if (hand.potType === "limped" || hand.potType === "unknown" || raisers.length === 0)
    return { valid: false, reason: "リンプ/未対応のプリフロップ" };
  if (hand.heroCards.includes("?"))
    return { valid: false, reason: "ヒーローのカードを読めず" };
  if (hand.board.length < 3 || hand.board.some((c) => c.includes("?")))
    return { valid: false, reason: "ボードを読めず(フロップ未到達)" };

  // players who didn't fold preflop reach the flop; >2 → multiway (HU-only)
  const last = new Map<Position, string>();
  for (const a of pre) last.set(a.position, a.action);
  const inToFlop = [...last.entries()].filter(([, a]) => a !== "fold").map(([p]) => p);
  if (inToFlop.length > 2)
    return { valid: false, reason: `マルチウェイ ${inToFlop.length}人(HUソルブ対象外)` };

  const potType = hand.potType as PotType;
  const opener = raisers[0];
  // postflop opponents = hero + villain; defender = the non-opener of that pair
  const hero = hand.heroPosition;
  let defender: Position | undefined;
  if (potType === "srp") {
    defender = hero === opener ? hand.villainPosition ?? undefined : hero;
  } else {
    defender = raisers[1]; // the 3-bettor
  }
  if (!defender) return { valid: false, reason: "相手ポジション不明" };
  if (defender === opener) return { valid: false, reason: "ポジション特定に失敗" };

  // hero must be one of the two postflop players
  if (hero !== opener && hero !== defender)
    return { valid: false, reason: "マルチウェイ(HUソルブ対象外)" };

  const scen = buildScenario(
    toRangePos(opener),
    toRangePos(defender),
    potType,
    tightness,
    tightness
  );
  const oop = fromRangePos(scen.oopName);
  const ip = fromRangePos(scen.ipName);
  const board = hand.board.join("");
  return {
    valid: true,
    opener,
    defender,
    potType,
    oop,
    ip,
    hero,
    heroIsOop: oop === hero,
    board,
    pot: scen.pot,
    stack: scen.stack,
    oopRange: scen.oopRange,
    ipRange: scen.ipRange,
  };
}

/** Hero's decision points (street + action taken), for the evaluation step. */
export function heroDecisions(hand: ParsedHand): { street: string; action: string }[] {
  const out: { street: string; action: string }[] = [];
  for (const s of hand.streets)
    for (const a of s.actions)
      if (a.position === hand.heroPosition) out.push({ street: s.street, action: a.action });
  return out;
}

export { POSTFLOP_ORDER };
