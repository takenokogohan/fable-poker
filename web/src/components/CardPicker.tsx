// 52-card grid grouped by suit row.

import { RANKS, SUIT_COLORS, SUIT_SYMBOLS, makeCard } from "../poker";

interface Props {
  selected: number[];
  disabled: number[];
  onPick: (card: number) => void;
}

export default function CardPicker({ selected, disabled, onPick }: Props) {
  return (
    <div className="card-picker">
      {[3, 2, 1, 0].map((suit) => (
        <div key={suit} className="card-row">
          {Array.from({ length: 13 }, (_, i) => {
            const rank = 12 - i;
            const card = makeCard(rank, suit);
            const isSel = selected.includes(card);
            const isDis = disabled.includes(card);
            return (
              <button
                key={card}
                className={
                  "card-btn" + (isSel ? " selected" : "") + (isDis ? " disabled" : "")
                }
                style={{ color: SUIT_COLORS[suit] }}
                disabled={isDis}
                onClick={() => onPick(card)}
              >
                {RANKS[rank]}
                <span className="suit">{SUIT_SYMBOLS[suit]}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
