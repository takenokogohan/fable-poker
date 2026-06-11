// Editable 13x13 range grid with drag painting (mouse and touch) and a
// weight brush.

import { useCallback, useRef, useState } from "react";
import { gridLabel } from "../poker";
import { parseRange, rangePercent } from "../ranges";

interface Props {
  title: string;
  grid: Float32Array;
  onChange: (g: Float32Array) => void;
}

export default function RangeMatrix({ title, grid, onChange }: Props) {
  const [brush, setBrush] = useState(100);
  const [text, setText] = useState("");
  const painting = useRef<null | number>(null); // weight being painted
  const lastCell = useRef(-1);

  const paint = useCallback(
    (cell: number, value: number) => {
      const next = new Float32Array(grid);
      next[cell] = value;
      onChange(next);
    },
    [grid, onChange]
  );

  // pointer events work for both mouse and touch; during a touch drag no
  // enter events fire on other elements, so resolve the cell from the
  // pointer position instead
  const cellAt = (x: number, y: number): number => {
    const el = document.elementFromPoint(x, y);
    const c = el?.closest?.("[data-cell]")?.getAttribute("data-cell");
    return c === null || c === undefined ? -1 : +c;
  };

  const handleDown = (e: React.PointerEvent, cell: number) => {
    e.preventDefault();
    const target = grid[cell] > 0 ? 0 : brush / 100;
    painting.current = target;
    lastCell.current = cell;
    paint(cell, target);
  };

  const handleMove = (e: React.PointerEvent) => {
    if (painting.current === null) return;
    const cell = cellAt(e.clientX, e.clientY);
    if (cell >= 0 && cell !== lastCell.current) {
      lastCell.current = cell;
      paint(cell, painting.current);
    }
  };

  const stopPaint = () => {
    painting.current = null;
    lastCell.current = -1;
  };

  return (
    <div className="range-editor">
      <div className="range-header">
        <span className="range-title">{title}</span>
        <span className="range-pct">{rangePercent(grid).toFixed(1)}%</span>
      </div>
      <div
        className="matrix paint-matrix"
        onPointerMove={handleMove}
        onPointerUp={stopPaint}
        onPointerLeave={stopPaint}
        onPointerCancel={stopPaint}
      >
        {Array.from({ length: 169 }, (_, cell) => {
          const w = grid[cell];
          return (
            <div
              key={cell}
              className="cell"
              data-cell={cell}
              onPointerDown={(e) => handleDown(e, cell)}
            >
              <div
                className="cell-fill"
                style={{
                  background: `linear-gradient(to top, var(--accent) ${
                    w * 100
                  }%, transparent ${w * 100}%)`,
                }}
              />
              <span className="cell-label">{gridLabel(cell)}</span>
            </div>
          );
        })}
      </div>
      <div className="range-tools">
        <label>
          ウェイト {brush}%
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={brush}
            onChange={(e) => setBrush(+e.target.value)}
          />
        </label>
        <button onClick={() => onChange(new Float32Array(169))}>クリア</button>
      </div>
      <div className="range-import">
        <input
          type="text"
          placeholder="レンジ文字列 (例: 22+, ATs+, KQo, A5s:0.5)"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          onClick={() => {
            if (text.trim()) onChange(parseRange(text));
          }}
        >
          読込
        </button>
      </div>
    </div>
  );
}
