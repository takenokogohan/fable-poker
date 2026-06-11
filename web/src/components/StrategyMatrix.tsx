// 13x13 strategy display: each cell shows reach-weighted action frequencies
// as horizontal color segments (GTO Wizard style).

import { useMemo } from "react";
import { actionColor, gridLabel } from "../poker";
import type { ActionInfo } from "../types";

interface Props {
  handCells: number[]; // grid cell per hand (acting player)
  reach: number[];
  strategy: number[]; // [na × nh]
  actions: ActionInfo[];
  selectedCell: number | null;
  onCellClick: (cell: number) => void;
}

export interface CellAgg {
  weight: number;
  freqs: number[]; // per action
}

export function aggregateCells(
  handCells: number[],
  reach: number[],
  strategy: number[],
  na: number
): CellAgg[] {
  const nh = handCells.length;
  const cells: CellAgg[] = Array.from({ length: 169 }, () => ({
    weight: 0,
    freqs: new Array(na).fill(0),
  }));
  for (let h = 0; h < nh; h++) {
    const w = reach[h];
    if (w <= 0) continue;
    const cell = cells[handCells[h]];
    cell.weight += w;
    for (let a = 0; a < na; a++) {
      cell.freqs[a] += w * strategy[a * nh + h];
    }
  }
  for (const c of cells) {
    if (c.weight > 0) {
      for (let a = 0; a < na; a++) c.freqs[a] /= c.weight;
    }
  }
  return cells;
}

export default function StrategyMatrix({
  handCells,
  reach,
  strategy,
  actions,
  selectedCell,
  onCellClick,
}: Props) {
  const na = actions.length;
  const cells = useMemo(
    () => aggregateCells(handCells, reach, strategy, na),
    [handCells, reach, strategy, na]
  );
  const maxChips = Math.max(...actions.map((a) => a.chips), 0);
  const maxWeight = Math.max(...cells.map((c) => c.weight), 1e-9);
  const colors = actions.map((a) => actionColor(a.kind, a.chips, maxChips));

  return (
    <div className="matrix strategy-matrix">
      {cells.map((cell, i) => {
        const has = cell.weight > 1e-9;
        // render aggressive actions (last in list) first
        const segs: { color: string; width: number }[] = [];
        for (let a = na - 1; a >= 0; a--) {
          segs.push({ color: colors[a], width: cell.freqs[a] * 100 });
        }
        const alpha = has
          ? 0.35 + 0.65 * Math.min(1, (cell.weight / maxWeight) * 3)
          : 0;
        return (
          <div
            key={i}
            className={
              "cell strat-cell" +
              (selectedCell === i ? " selected" : "") +
              (has ? "" : " empty")
            }
            onClick={() => has && onCellClick(i)}
          >
            {has && (
              <div className="strat-bar" style={{ opacity: alpha }}>
                {segs.map((s, k) => (
                  <div
                    key={k}
                    style={{ width: `${s.width}%`, background: s.color }}
                  />
                ))}
              </div>
            )}
            <span className="cell-label">{gridLabel(i)}</span>
          </div>
        );
      })}
    </div>
  );
}
