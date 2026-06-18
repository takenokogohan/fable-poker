// Assemble detected cards + actions into a structured hand. Same shape as the
// Ten-Four JSON export, so downstream analysis is input-agnostic.

import {
  detectCards,
  detectTags,
  detectActionStreets,
  extractTagText,
  nameBrightness,
  readRank,
  glyphDist,
  type ActionClass,
  type RgbaImage,
  type Suit,
} from "./detect";

export type Position = "UTG" | "HJ" | "CO" | "BTN" | "SB" | "BB";
// player-list rows are always in this order, top → bottom
const LIST_ORDER: Position[] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];

export type Action = "fold" | "check" | "call" | "bet" | "raise";

export interface ActionStep {
  position: Position;
  action: Action;
}

export interface ParsedHand {
  heroPosition: Position;
  heroCards: string[]; // ["As","Qs"]
  players: { position: Position; cards: string[] }[];
  board: string[]; // ["Kh","7s","5c",...]
  potType: "srp" | "3bp" | "4bp" | "limped" | "unknown";
  villainPosition: Position | null;
  streets: { street: "preflop" | "flop" | "turn" | "river"; actions: ActionStep[] }[];
  warnings: string[];
}

const card = (rank: string, suit: Suit) => rank + suit;

export function parseHand(img: RgbaImage): ParsedHand {
  const warnings: string[] = [];
  const { list } = detectTags(img);

  // player-list rows (always UTG→BB top to bottom) are the reliable row anchors
  const listRows = list.slice(0, 6).sort((a, b) => a.cy - b.cy);
  // postflop action-street bands anchor the board rows (so a street whose only
  // card is a spade — no vivid chip — is still found).
  const groups = detectActionStreets(img);
  const boardBands: [number, number][] = groups
    .slice(1)
    .map((g) => [g[0].cy, g[g.length - 1].cy]);
  // anchor the hole-card grid to the list-tag rows so a row whose cards weren't
  // detected as vivid chips (e.g. an all-spade or partly-cut top row) still
  // maps to the correct player.
  const cards = detectCards(img, listRows.map((t) => t.cy), boardBands);

  const players: ParsedHand["players"] = [];
  let heroIdx = 0, heroBright = -1;
  listRows.forEach((tag, i) => {
    const pos = LIST_ORDER[i] ?? "BB";
    const row = cards.holeRows[i]; // 1:1 with list rows
    const cs = row
      ? row.cards.map((c) => {
          const { rank } = readRank(img, Math.round(c.cx), Math.round(row.cy), cards.chipW, cards.chipH);
          return card(rank || "?", c.suit);
        })
      : [];
    players.push({ position: pos, cards: cs });
    const br = nameBrightness(img, tag);
    if (br > heroBright) { heroBright = br; heroIdx = i; }
  });
  const heroPosition = LIST_ORDER[heroIdx] ?? "BB";
  const heroCards = players[heroIdx]?.cards ?? [];

  // board
  const board = cards.board.map((c) => {
    const { rank } = readRank(img, Math.round(c.cx), Math.round(c.cy), cards.chipW, cards.chipH);
    return card(rank || "?", c.suit);
  });

  // per-image position templates from the labeled list tags
  const tmpl = listRows.map((tag, i) => ({ pos: LIST_ORDER[i] ?? "BB", bm: extractTagText(img, tag) }));
  const readPos = (tagBox: Parameters<typeof extractTagText>[1]): Position | null => {
    const bm = extractTagText(img, tagBox);
    if (!bm) return null;
    let best: Position | null = null, bd = 1;
    for (const t of tmpl) {
      if (!t.bm) continue;
      const d = glyphDist(bm, t.bm);
      if (d < bd) { bd = d; best = t.pos; }
    }
    return bd < 0.25 ? best : null;
  };

  // action streets (groups already computed above for board anchoring)
  const nPost = (board.length >= 3 ? 1 : 0) + (board.length >= 4 ? 1 : 0) + (board.length >= 5 ? 1 : 0);
  const streetNames: ParsedHand["streets"][number]["street"][] = ["preflop", "flop", "turn", "river"];
  const streets: ParsedHand["streets"] = [];

  const toAction = (cls: ActionClass, preflop: boolean, facing: boolean): Action | null => {
    if (cls === "fold") return "fold";
    if (cls === "other") return null;
    if (preflop) return cls === "aggro" ? "raise" : "call";
    if (cls === "aggro") return facing ? "raise" : "bet";
    return facing ? "call" : "check";
  };

  for (let gi = 0; gi <= nPost && gi < groups.length; gi++) {
    const g = groups[gi];
    const preflop = gi === 0;
    const actions: ActionStep[] = [];
    let facing = false;
    for (const r of g) {
      const a = toAction(r.cls, preflop, facing);
      if (!a) continue;
      if (a === "bet" || a === "raise") facing = true;
      const pos = readPos(r.tag) ?? heroPosition;
      actions.push({ position: pos, action: a });
    }
    streets.push({ street: streetNames[gi], actions });
  }

  // pot type from preflop raise count
  const preflopRaises = (streets[0]?.actions ?? []).filter((a) => a.action === "raise").length;
  const potType =
    preflopRaises >= 3 ? "4bp" : preflopRaises === 2 ? "3bp" : preflopRaises === 1 ? "srp" : "limped";

  // villain = the non-hero actor seen postflop (HU postflop)
  let villainPosition: Position | null = null;
  for (let i = 1; i < streets.length; i++) {
    for (const a of streets[i].actions) {
      if (a.position !== heroPosition) { villainPosition = a.position; break; }
    }
    if (villainPosition) break;
  }

  if (heroCards.includes("?")) warnings.push("hero card rank unread");
  if (board.includes("?")) warnings.push("board card rank unread");

  return { heroPosition, heroCards, players, board, potType, villainPosition, streets, warnings };
}
