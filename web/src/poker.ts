// Card / grid utilities mirroring the Rust solver conventions.
// card = rank * 4 + suit; rank 0 = deuce .. 12 = ace; suit 0=c 1=d 2=h 3=s

export const RANKS = "23456789TJQKA";
export const SUITS = "cdhs";
export const SUIT_SYMBOLS = ["♣", "♦", "♥", "♠"];
export const SUIT_COLORS = ["#4caf78", "#4a9fdc", "#e25757", "#b8bcc8"];

export const rankOf = (c: number) => c >> 2;
export const suitOf = (c: number) => c & 3;
export const makeCard = (rank: number, suit: number) => (rank << 2) | suit;

export function cardToString(c: number): string {
  return RANKS[rankOf(c)] + SUITS[suitOf(c)];
}

export function parseCard(s: string): number | null {
  const r = RANKS.indexOf(s[0]?.toUpperCase() ?? "");
  const su = SUITS.indexOf(s[1]?.toLowerCase() ?? "");
  if (r < 0 || su < 0) return null;
  return makeCard(r, su);
}

export function parseBoard(s: string): number[] | null {
  const clean = s.replace(/[\s,]/g, "");
  if (clean.length % 2 !== 0) return null;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    const c = parseCard(clean.slice(i, i + 2));
    if (c === null) return null;
    if (out.includes(c)) return null;
    out.push(c);
  }
  return out;
}

/** 13x13 grid cell index: row/col indexed by rank descending (0 = A). */
export function gridLabel(cell: number): string {
  const row = Math.floor(cell / 13);
  const col = cell % 13;
  const r1 = RANKS[12 - Math.min(row, col)];
  const r2 = RANKS[12 - Math.max(row, col)];
  if (row === col) return r1 + r2;
  return row < col ? r1 + r2 + "s" : r1 + r2 + "o";
}

/** number of combos in a cell (ignoring blockers) */
export function cellComboCount(cell: number): number {
  const row = Math.floor(cell / 13);
  const col = cell % 13;
  return row === col ? 6 : row < col ? 4 : 12;
}

/** map a hand string like "AsKd" to its grid cell */
export function handToCell(hand: string): number {
  const c1 = parseCard(hand.slice(0, 2))!;
  const c2 = parseCard(hand.slice(2, 4))!;
  const r1 = rankOf(c1);
  const r2 = rankOf(c2);
  const hi = 12 - Math.max(r1, r2);
  const lo = 12 - Math.min(r1, r2);
  if (r1 === r2) return hi * 13 + hi;
  return suitOf(c1) === suitOf(c2) ? hi * 13 + lo : lo * 13 + hi;
}

export const ACTION_KIND = {
  FOLD: 0,
  CHECK: 1,
  CALL: 2,
  BET: 3,
  RAISE: 4,
  ALLIN: 5,
} as const;

export function actionLabel(kind: number, chips: number): string {
  switch (kind) {
    case ACTION_KIND.FOLD:
      return "フォールド";
    case ACTION_KIND.CHECK:
      return "チェック";
    case ACTION_KIND.CALL:
      return `コール ${fmtBB(chips)}`;
    case ACTION_KIND.BET:
      return `ベット ${fmtBB(chips)}`;
    case ACTION_KIND.RAISE:
      return `レイズ ${fmtBB(chips)}`;
    case ACTION_KIND.ALLIN:
      return `オールイン ${fmtBB(chips)}`;
    default:
      return "?";
  }
}

export function fmtBB(v: number): string {
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

/** color for an action: folds blue, checks/calls green, bets/raises red (darker = bigger) */
export function actionColor(
  kind: number,
  chips: number,
  maxChips: number
): string {
  if (kind === ACTION_KIND.FOLD) return "#3d85c8";
  if (kind === ACTION_KIND.CHECK || kind === ACTION_KIND.CALL) return "#54a953";
  // bet family: interpolate light red -> dark red by size
  const t = maxChips > 0 ? Math.min(chips / maxChips, 1) : 1;
  const from = [240, 128, 128];
  const to = [150, 22, 28];
  const c = from.map((f, i) => Math.round(f + (to[i] - f) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export const STREET_NAMES = ["フロップ", "ターン", "リバー"];
