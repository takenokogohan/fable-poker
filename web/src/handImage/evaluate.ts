// Evaluate a parsed hand's hero decisions against a solved spot. The solver
// tree is postflop-only, so we navigate the actual line (actions + runout
// cards) and read the hero's strategy frequency and EV at each decision.

import type { SolverSession } from "../cluster";
import { parseCard } from "../poker";
import type { SpotMapping } from "./analyze";
import type { Action, ParsedHand } from "./parse";

export type Verdict = "good" | "ok" | "mistake" | "na";

export interface DecisionResult {
  street: string;
  action: Action;
  freq: number | null; // solver frequency of hero's action with this hand
  ev: number | null;
  bestAction: string | null;
  evLoss: number | null; // best EV − chosen EV (bb)
  verdict: Verdict;
}

export interface HandEvaluation {
  postflop: DecisionResult[];
  truncatedReason?: string;
}

const KIND: Record<Action, number> = { fold: 0, check: 1, call: 2, bet: 3, raise: 4 };
const KIND_NAME = ["フォールド", "チェック", "コール", "ベット", "レイズ", "オールイン"];

function findHandIndex(hands: string[], cards: string[]): number {
  if (cards.length < 2) return -1;
  const [a, b] = cards;
  let i = hands.indexOf(a + b);
  if (i < 0) i = hands.indexOf(b + a);
  return i;
}

function findActionIdx(actions: { kind: number; chips: number }[], action: Action): number {
  let idx = actions.findIndex((a) => a.kind === KIND[action]);
  if (idx < 0 && (action === "bet" || action === "raise"))
    idx = actions.findIndex((a) => a.kind === 5); // all-in stands in for bet/raise
  if (idx < 0 && action === "call") idx = actions.findIndex((a) => a.kind === 5);
  return idx;
}

function classify(evLoss: number | null): Verdict {
  if (evLoss === null) return "na";
  if (evLoss <= 0.1) return "good";
  if (evLoss <= 0.6) return "ok";
  return "mistake";
}

export async function evaluateHand(
  session: SolverSession,
  hand: ParsedHand,
  scen: SpotMapping
): Promise<HandEvaluation> {
  const heroSeat = scen.heroIsOop ? 0 : 1;
  const hands = heroSeat === 0 ? session.meta.hands0 : session.meta.hands1;
  const heroIdx = findHandIndex(hands, hand.heroCards);
  const postStreets = hand.streets.filter((s) => s.street !== "preflop");
  const board = hand.board;
  const path: number[] = [];
  const postflop: DecisionResult[] = [];
  let truncatedReason: string | undefined;

  for (let i = 0; i < postStreets.length; i++) {
    const s = postStreets[i];
    for (const act of s.actions) {
      const node = await session.query(path, ["ev"]);
      if (node.type !== "action" || !node.actions) {
        truncatedReason = "ツリーが途中で終端に到達";
        return { postflop, truncatedReason };
      }
      const ai = findActionIdx(node.actions, act.action);
      if (ai < 0) {
        truncatedReason = `${s.street} の ${act.action} がツリーに無し`;
        return { postflop, truncatedReason };
      }
      if (node.player === heroSeat && heroIdx >= 0 && node.strategy && node.evs) {
        const na = node.actions.length;
        const nh = hands.length;
        const freq = node.strategy[ai * nh + heroIdx];
        const ev = node.evs[ai * nh + heroIdx];
        let bestEv = -Infinity, bestAi = 0;
        for (let a = 0; a < na; a++) {
          const e = node.evs[a * nh + heroIdx];
          if (e > bestEv) { bestEv = e; bestAi = a; }
        }
        const evLoss = isFinite(bestEv) ? bestEv - ev : null;
        postflop.push({
          street: s.street,
          action: act.action,
          freq,
          ev,
          bestAction: KIND_NAME[node.actions[bestAi].kind] ?? null,
          evLoss,
          verdict: classify(evLoss),
        });
      }
      path.push(ai);
    }
    // deal the next street's card to continue down the actual runout
    if (i < postStreets.length - 1) {
      const cardStr = board[3 + i]; // turn = board[3], river = board[4]
      const cardId = cardStr ? parseCard(cardStr) : null;
      const cn = await session.query(path, []);
      if (cn.type !== "chance" || cardId === null) {
        truncatedReason = "ラン アウトの分岐に到達できず";
        break;
      }
      path.push(cardId);
    }
  }
  return { postflop, truncatedReason };
}
