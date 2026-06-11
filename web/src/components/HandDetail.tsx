// Per-combo detail for a selected grid cell: action frequencies, EV, equity.

import {
  SUIT_COLORS,
  SUIT_SYMBOLS,
  actionColor,
  actionLabel,
  gridLabel,
  parseCard,
  suitOf,
} from "../poker";
import type { ActionInfo } from "../types";

interface Props {
  cell: number;
  hands: string[]; // all hands of the acting player
  handCells: number[];
  reach: number[];
  strategy: number[];
  evs?: number[];
  equity?: number[];
  actions: ActionInfo[];
}

function HandLabel({ hand }: { hand: string }) {
  const cards = [hand.slice(0, 2), hand.slice(2, 4)];
  return (
    <span className="hand-label">
      {cards.map((c, i) => {
        const card = parseCard(c)!;
        return (
          <span key={i} style={{ color: SUIT_COLORS[suitOf(card)] }}>
            {c[0]}
            {SUIT_SYMBOLS[suitOf(card)]}
          </span>
        );
      })}
    </span>
  );
}

export default function HandDetail({
  cell,
  hands,
  handCells,
  reach,
  strategy,
  evs,
  equity,
  actions,
}: Props) {
  const nh = hands.length;
  const na = actions.length;
  const maxChips = Math.max(...actions.map((a) => a.chips), 0);
  const members: number[] = [];
  for (let h = 0; h < nh; h++) {
    if (handCells[h] === cell) members.push(h);
  }
  return (
    <div className="hand-detail">
      <div className="hand-detail-title">{gridLabel(cell)} のコンボ詳細</div>
      <table>
        <thead>
          <tr>
            <th>ハンド</th>
            <th>リーチ</th>
            <th>戦略</th>
            {evs && <th>EV (bb)</th>}
            {equity && <th>エクイティ</th>}
          </tr>
        </thead>
        <tbody>
          {members.map((h) => {
            const blocked = reach[h] <= 0;
            return (
              <tr key={h} className={blocked ? "blocked" : ""}>
                <td>
                  <HandLabel hand={hands[h]} />
                </td>
                <td>
                  {blocked
                    ? "—"
                    : reach[h] < 0.005
                      ? "<0.01"
                      : reach[h].toFixed(2)}
                </td>
                <td>
                  {blocked ? (
                    "ブロック"
                  ) : (
                    <div className="freq-bar">
                      {Array.from({ length: na }, (_, k) => {
                        const a = na - 1 - k; // aggressive first
                        const f = strategy[a * nh + h];
                        return (
                          <div
                            key={a}
                            title={`${actionLabel(
                              actions[a].kind,
                              actions[a].chips
                            )} ${(f * 100).toFixed(0)}%`}
                            style={{
                              width: `${f * 100}%`,
                              background: actionColor(
                                actions[a].kind,
                                actions[a].chips,
                                maxChips
                              ),
                            }}
                          />
                        );
                      })}
                    </div>
                  )}
                </td>
                {evs && (
                  <td>
                    {blocked
                      ? "—"
                      : Array.from({ length: na }, (_, a) => (
                          <span key={a} className="ev-item">
                            {actionLabel(actions[a].kind, actions[a].chips).split(
                              " "
                            )[0]}
                            : {evs[a * nh + h].toFixed(2)}
                          </span>
                        ))}
                  </td>
                )}
                {equity && (
                  <td>{blocked ? "—" : `${(equity[h] * 100).toFixed(1)}%`}</td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
