// Ten-Four hand-history image parser — card detection layer.
//
// The share card is a fixed-layout digital image, so we read it
// deterministically (no cloud OCR): suit = chip background colour, and the
// chips sit on a regular grid. This module finds the card chips and assigns
// suits; rank-glyph reading lives in ./ranks.
//
// Works on any RGBA buffer (browser ImageData or Node pngjs), so the same
// code is verified against sample PNGs in tools/parse-images.mjs.

import { GLYPH_TEMPLATES } from "./glyphTemplates";

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export type Rank =
  | "A" | "K" | "Q" | "J" | "T" | "9" | "8" | "7" | "6" | "5" | "4" | "3" | "2";

const TEMPLATES = GLYPH_TEMPLATES.map((t) => ({
  label: t.label as Rank,
  bits: Uint8Array.from(t.bits, (c) => (c === "1" ? 1 : 0)),
}));

export type Suit = "h" | "d" | "c" | "s";

export interface CardChip {
  x: number; // bbox top-left
  y: number;
  w: number;
  h: number;
  cx: number; // center
  cy: number;
  suit: Suit;
}

function hsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : d / mx, mx];
}

/** Vivid heart/diamond/club chip background; spade is handled by gap-fill. */
function vividSuit(r: number, g: number, b: number): Suit | null {
  const [h, s, v] = hsv(r, g, b);
  if (v >= 0.32 && s >= 0.3) {
    if (h < 22 || h >= 335) return "h"; // red
    if (h >= 90 && h < 165) return "c"; // green
    if (h >= 185 && h < 262) return "d"; // blue
  }
  return null;
}

/** Spade chip background: bluish mid-grey, clearly lighter than the navy bg
 * (v≈0.39) but less saturated/bright than a diamond chip. Position tags share
 * this colour, so callers must only sample known card-slot locations. */
function isSpadeBg(r: number, g: number, b: number): boolean {
  const [h, s, v] = hsv(r, g, b);
  return h >= 198 && h <= 236 && s >= 0.18 && s <= 0.5 && v >= 0.3 && v <= 0.56;
}

function isNavyBg(r: number, g: number, b: number): boolean {
  const [, , v] = hsv(r, g, b);
  return v < 0.28;
}

/** Classify a card slot by sampling its background colour: a missed vivid chip
 * must read as its real suit, not default to spade. Returns null for empty. */
function slotSuit(img: RgbaImage, cx: number, cy: number, chipW: number): Suit | null {
  const [r, g, b] = sampleBox(img, cx, cy, Math.round(chipW * 0.3));
  const v = vividSuit(r, g, b);
  if (v) return v;
  if (isSpadeBg(r, g, b)) return "s";
  if (!isNavyBg(r, g, b)) return "s";
  return null;
}

const CHIP_MIN_W = 26, CHIP_MAX_W = 58, CHIP_MIN_H = 36, CHIP_MAX_H = 64;

interface Comp {
  minx: number; miny: number; maxx: number; maxy: number;
  area: number; counts: Record<Suit, number>;
}

/** Connected components of vivid-suit pixels → colored card chips. */
function vividChips(img: RgbaImage): CardChip[] {
  const { width: W, height: H, data } = img;
  const mask = new Uint8Array(W * H); // 0 none, else suit char code
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const s = vividSuit(data[i], data[i + 1], data[i + 2]);
      if (s) mask[y * W + x] = s.charCodeAt(0);
    }
  }
  const lab = new Int32Array(W * H);
  let nl = 0;
  const comps: Comp[] = [];
  const stack: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (mask[p] === 0 || lab[p] !== 0) continue;
      nl++;
      let minx = x, maxx = x, miny = y, maxy = y, area = 0;
      const counts: Record<Suit, number> = { h: 0, d: 0, c: 0, s: 0 };
      stack.push(p);
      lab[p] = nl;
      while (stack.length) {
        const q = stack.pop()!;
        const qx = q % W, qy = (q / W) | 0;
        area++;
        counts[String.fromCharCode(mask[q]) as Suit]++;
        if (qx < minx) minx = qx; if (qx > maxx) maxx = qx;
        if (qy < miny) miny = qy; if (qy > maxy) maxy = qy;
        const nb = [q + 1, q - 1, q + W, q - W];
        const nbx = [qx + 1, qx - 1, qx, qx];
        const nby = [qy, qy, qy + 1, qy - 1];
        for (let k = 0; k < 4; k++) {
          const nx = nbx[k], ny = nby[k];
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const np = nb[k];
          if (mask[np] !== 0 && lab[np] === 0) { lab[np] = nl; stack.push(np); }
        }
      }
      comps.push({ minx, miny, maxx, maxy, area, counts });
    }
  }
  const chips: CardChip[] = [];
  for (const c of comps) {
    const w = c.maxx - c.minx + 1, h = c.maxy - c.miny + 1;
    if (w < CHIP_MIN_W || w > CHIP_MAX_W || h < CHIP_MIN_H || h > CHIP_MAX_H) continue;
    if (c.area < w * h * 0.45) continue;
    const suit = (Object.entries(c.counts).sort((a, b) => b[1] - a[1])[0][0]) as Suit;
    chips.push({ x: c.minx, y: c.miny, w, h, cx: (c.minx + c.maxx) / 2, cy: (c.miny + c.maxy) / 2, suit });
  }
  return chips;
}

/** debug: raw colored-chip detections */
export function _debugChips(img: RgbaImage): CardChip[] {
  return vividChips(img);
}

/** average colour of a small box, for sampling a slot's background */
function sampleBox(img: RgbaImage, cx: number, cy: number, half: number): [number, number, number] {
  const { width: W, height: H, data } = img;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.max(0, cy - half); y <= Math.min(H - 1, cy + half); y++) {
    for (let x = Math.max(0, cx - half); x <= Math.min(W - 1, cx + half); x++) {
      const i = (y * W + x) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  return [r / n, g / n, b / n];
}

/** 1-D clustering of values within `tol` → cluster mean positions. */
function cluster(vals: number[], tol: number): number[] {
  if (vals.length === 0) return [];
  const sorted = [...vals].sort((a, b) => a - b);
  const groups: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - groups[groups.length - 1][groups[groups.length - 1].length - 1] <= tol)
      groups[groups.length - 1].push(sorted[i]);
    else groups.push([sorted[i]]);
  }
  return groups.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
}

export interface DetectedCards {
  /** hole cards per player row, top→bottom; each row [left, right] suit */
  holeRows: { cy: number; cards: { cx: number; suit: Suit }[] }[];
  /** board cards left→right */
  board: { cx: number; cy: number; suit: Suit }[];
  chipW: number;
  chipH: number;
}

/**
 * Locate all card slots and assign suits. Colored chips anchor the grid;
 * spade slots (no vivid chip) are recovered by sampling the slot background.
 */
export function detectCards(img: RgbaImage): DetectedCards {
  const { width: W } = img;
  const chips = vividChips(img);
  const chipW = median(chips.map((c) => c.w)) || 38;
  const chipH = median(chips.map((c) => c.h)) || 48;

  // hole-card region = right side; board = left side
  const hole = chips.filter((c) => c.cx > W * 0.6);
  const boardChips = chips.filter((c) => c.cx < W * 0.5);

  // Ten-Four always shows 6 players. Colored chips anchor the grid, but a row
  // whose two hole cards are both spades has no vivid anchor — so we lock a
  // 6-row grid from the detected rows' pitch and recover the rest by sampling.
  const detYs = cluster(hole.map((c) => c.cy), chipH * 0.6);
  let colXs = cluster(hole.map((c) => c.cx), chipW * 0.6);
  const pitch =
    detYs.length >= 2 ? median(detYs.slice(1).map((y, i) => y - detYs[i])) : chipH * 1.17;
  // two card columns; derive the missing one from the chip pitch if needed
  if (colXs.length === 1) colXs = [colXs[0], colXs[0] + chipW * 1.1].sort((a, b) => a - b);
  colXs = colXs.slice(0, 2);

  // anchor the top row: probe one pitch above the topmost detected row in case
  // the top (UTG) row is itself all-spade
  let top = detYs[0];
  const probeUp = top - pitch;
  if (probeUp > pitch * 0.5) {
    const spadeAbove = colXs.some((cx) => {
      const [r, g, b] = sampleBox(img, Math.round(cx), Math.round(probeUp), Math.round(chipW * 0.3));
      return isSpadeBg(r, g, b);
    });
    if (spadeAbove) top = probeUp;
  }

  const holeRows: DetectedCards["holeRows"] = [];
  for (let ri = 0; ri < 6; ri++) {
    const ry = top + ri * pitch;
    const cards: { cx: number; suit: Suit }[] = [];
    for (const cxCol of colXs) {
      const hit = hole.find(
        (c) => Math.abs(c.cy - ry) < pitch * 0.45 && Math.abs(c.cx - cxCol) < chipW * 0.6
      );
      if (hit) {
        cards.push({ cx: cxCol, suit: hit.suit });
        continue;
      }
      const s = slotSuit(img, Math.round(cxCol), Math.round(ry), chipW);
      if (s) cards.push({ cx: cxCol, suit: s });
    }
    if (cards.length) holeRows.push({ cy: ry, cards });
  }

  // Board cards sit on the left under each street label: flop = 3 in a row,
  // turn = 1, river = 1, each starting at the same left margin. Scan each
  // street row left→right by card pitch, classifying each slot, until empty.
  const board: DetectedCards["board"] = [];
  if (boardChips.length) {
    const boardRowYs = cluster(boardChips.map((c) => c.cy), chipH * 0.6);
    const pitch = chipW * 1.18; // chip width + gap (≈45px at 840w)
    const x0 = Math.min(...boardChips.map((c) => c.cx)); // left margin (≈61)
    for (const ry of boardRowYs) {
      for (let k = 0; k < 5; k++) {
        const cx = x0 + k * pitch;
        const hit = boardChips.find(
          (c) => Math.abs(c.cy - ry) < chipH * 0.6 && Math.abs(c.cx - cx) < chipW * 0.55
        );
        if (hit) {
          board.push({ cx: hit.cx, cy: ry, suit: hit.suit });
          continue;
        }
        const s = slotSuit(img, Math.round(cx), Math.round(ry), chipW);
        if (s) board.push({ cx, cy: ry, suit: s });
        else break; // empty slot → end of this street's cards
      }
    }
    board.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  }

  return { holeRows, board, chipW, chipH };
}

/** Position-label tag (grey rounded rect): bluish mid-grey. Shared by the
 * player list (left column) and each action row (indented). */
function isTagGrey(r: number, g: number, b: number): boolean {
  const [h, s, v] = hsv(r, g, b);
  return h >= 200 && h <= 226 && s >= 0.12 && s <= 0.32 && v >= 0.36 && v <= 0.54;
}

export interface Box {
  x: number; y: number; w: number; h: number; cx: number; cy: number;
}

/** Detect the grey position tags; split into player-list (far left) vs the
 * indented action-row tags. */
export function detectTags(img: RgbaImage): { list: Box[]; action: Box[] } {
  const { width: W, height: H, data } = img;
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (isTagGrey(data[i], data[i + 1], data[i + 2])) mask[y * W + x] = 1;
    }
  const lab = new Int32Array(W * H);
  const st: number[] = [];
  const boxes: Box[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (!mask[p] || lab[p]) continue;
      let a = 0, mnx = x, mxx = x, mny = y, mxy = y;
      st.push(p); lab[p] = 1;
      while (st.length) {
        const q = st.pop()!;
        const qx = q % W, qy = (q / W) | 0;
        a++;
        if (qx < mnx) mnx = qx; if (qx > mxx) mxx = qx;
        if (qy < mny) mny = qy; if (qy > mxy) mxy = qy;
        const nb = [q + 1, q - 1, q + W, q - W];
        const xs = [qx + 1, qx - 1, qx, qx], ys = [qy, qy, qy + 1, qy - 1];
        for (let k = 0; k < 4; k++) {
          const nx = xs[k], ny = ys[k];
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const np = nb[k];
          if (mask[np] && !lab[np]) { lab[np] = 1; st.push(np); }
        }
      }
      const w = mxx - mnx + 1, h = mxy - mny + 1;
      if (w >= 34 && w <= 110 && h >= 22 && h <= 44 && a > w * h * 0.5)
        boxes.push({ x: mnx, y: mny, w, h, cx: (mnx + mxx) / 2, cy: (mny + mxy) / 2 });
    }
  boxes.sort((a, b) => a.y - b.y || a.x - b.x);
  // action tags are indented vs the list column; the list column is the
  // leftmost cluster of tag x's
  const minX = Math.min(...boxes.map((b) => b.x));
  const list = boxes.filter((b) => b.x < minX + 30);
  const action = boxes.filter((b) => b.x >= minX + 30);
  return { list, action };
}

export type ActionClass = "fold" | "passive" | "aggro" | "other";

/** Dominant vivid colour of the action text just right of a tag → action class
 * (blue=fold, green=check/call, red=bet/raise). */
function actionColor(img: RgbaImage, tag: Box): ActionClass {
  const { width: W, data } = img;
  let red = 0, green = 0, blue = 0;
  const x0 = Math.round(tag.x + tag.w + 70), x1 = Math.round(tag.x + tag.w + 330);
  for (let y = tag.y; y < tag.y + tag.h; y++)
    for (let x = x0; x < Math.min(W, x1); x++) {
      const i = (y * W + x) * 4;
      const [h, s, v] = hsv(data[i], data[i + 1], data[i + 2]);
      if (v > 0.45 && s > 0.4) {
        if (h < 25 || h > 335) red++;
        else if (h >= 90 && h < 165) green++;
        else if (h >= 195 && h < 255) blue++;
      }
    }
  const mx = Math.max(red, green, blue);
  if (mx < 30) return "other";
  if (mx === blue) return "fold";
  if (mx === green) return "passive";
  return "aggro";
}

export interface ActionRow {
  cy: number;
  cls: ActionClass;
  tag: Box;
}

/** Group action rows into streets by the vertical gap between sections. */
export function detectActionStreets(img: RgbaImage): ActionRow[][] {
  const { action } = detectTags(img);
  const rows: ActionRow[] = action.map((tag) => ({ cy: tag.cy, cls: actionColor(img, tag), tag }));
  rows.sort((a, b) => a.cy - b.cy);
  const groups: ActionRow[][] = [];
  let cur: ActionRow[] = [];
  for (const r of rows) {
    if (cur.length && r.cy - cur[cur.length - 1].cy > 70) {
      groups.push(cur);
      cur = [];
    }
    cur.push(r);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export const GLYPH_W = 12;
export const GLYPH_H = 16;

/**
 * Extract the white rank glyph inside a card chip as a normalized binary
 * bitmap (GLYPH_W×GLYPH_H, row-major 0/1). Returns null if no glyph found.
 * All suits render the rank in white, so a white-pixel crop works uniformly.
 */
export function extractGlyph(
  img: RgbaImage,
  cx: number,
  cy: number,
  chipW: number,
  chipH: number
): Uint8Array | null {
  const { width: W, height: H, data } = img;
  const x0 = Math.max(0, Math.round(cx - chipW * 0.4));
  const x1 = Math.min(W - 1, Math.round(cx + chipW * 0.4));
  const y0 = Math.max(0, Math.round(cy - chipH * 0.4));
  const y1 = Math.min(H - 1, Math.round(cy + chipH * 0.4));
  const isWhite = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return data[i] > 170 && data[i + 1] > 170 && data[i + 2] > 170;
  };
  let minx = 1e9, miny = 1e9, maxx = -1, maxy = -1, n = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      if (isWhite(x, y)) {
        n++;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
  if (n < 8 || maxx < minx || maxy < miny) return null;
  const bw = maxx - minx + 1, bh = maxy - miny + 1;
  const out = new Uint8Array(GLYPH_W * GLYPH_H);
  for (let gy = 0; gy < GLYPH_H; gy++) {
    for (let gx = 0; gx < GLYPH_W; gx++) {
      const sx = minx + Math.floor(((gx + 0.5) / GLYPH_W) * bw);
      const sy = miny + Math.floor(((gy + 0.5) / GLYPH_H) * bh);
      out[gy * GLYPH_W + gx] = isWhite(sx, sy) ? 1 : 0;
    }
  }
  return out;
}

/** Normalize the white text inside a box to a fixed binary bitmap. */
function whiteBitmap(
  img: RgbaImage,
  x0: number, y0: number, x1: number, y1: number,
  gw: number, gh: number
): Uint8Array | null {
  const { width: W, height: H, data } = img;
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  x1 = Math.min(W - 1, x1); y1 = Math.min(H - 1, y1);
  const isWhite = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return data[i] > 170 && data[i + 1] > 170 && data[i + 2] > 170;
  };
  let minx = 1e9, miny = 1e9, maxx = -1, maxy = -1, n = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      if (isWhite(x, y)) {
        n++;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
  if (n < 6 || maxx < minx || maxy < miny) return null;
  const bw = maxx - minx + 1, bh = maxy - miny + 1;
  const out = new Uint8Array(gw * gh);
  for (let yy = 0; yy < gh; yy++)
    for (let xx = 0; xx < gw; xx++) {
      const sx = minx + Math.floor(((xx + 0.5) / gw) * bw);
      const sy = miny + Math.floor(((yy + 0.5) / gh) * bh);
      out[yy * gw + xx] = isWhite(sx, sy) ? 1 : 0;
    }
  return out;
}

export const TAG_W = 28;
export const TAG_H = 12;

/** Normalized bitmap of a position tag's white text (UTG/HJ/…). */
export function extractTagText(img: RgbaImage, box: Box): Uint8Array | null {
  return whiteBitmap(
    img,
    Math.round(box.x + 4), Math.round(box.y + 6),
    Math.round(box.x + box.w - 4), Math.round(box.y + box.h - 6),
    TAG_W, TAG_H
  );
}

/** Mean brightness of the name text just right of a list tag (hero = brightest,
 * since the hero's name is rendered bold white). */
export function nameBrightness(img: RgbaImage, tag: Box): number {
  const { width: W, data } = img;
  let sum = 0, n = 0;
  const x0 = Math.round(tag.x + tag.w + 12), x1 = Math.round(tag.x + tag.w + 210);
  for (let y = Math.round(tag.cy - 10); y < tag.cy + 10; y++)
    for (let x = x0; x < Math.min(W, x1); x++) {
      const i = (y * W + x) * 4;
      const mx = Math.max(data[i], data[i + 1], data[i + 2]);
      sum += mx; n++;
    }
  return n ? sum / n : 0;
}

/** normalized Hamming distance between two glyph bitmaps (0..1) */
export function glyphDist(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d / a.length;
}

/** Read a card's rank by matching its glyph to the nearest template. */
export function readRank(
  img: RgbaImage,
  cx: number,
  cy: number,
  chipW: number,
  chipH: number
): { rank: Rank | null; dist: number } {
  const g = extractGlyph(img, cx, cy, chipW, chipH);
  if (!g) return { rank: null, dist: 1 };
  let best: Rank | null = null, bd = 1;
  for (const t of TEMPLATES) {
    const dd = glyphDist(g, t.bits);
    if (dd < bd) { bd = dd; best = t.label; }
  }
  return { rank: best, dist: bd };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[(s.length / 2) | 0];
}
