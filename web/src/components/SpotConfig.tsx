// Spot configuration screen: preflop line builder, ranges, board, tree settings.

import { useMemo, useState } from "react";
import { cardToString, parseBoard } from "../poker";
import {
  buildScenario,
  OPENER_POSITIONS,
  TIGHTNESS_LABELS,
  validDefenders,
  type Position,
  type PotType,
  type Tightness,
} from "../ranges";
import {
  clearCustomRange,
  loadCustomRange,
  saveCustomRange,
  type Side,
} from "../customRanges";
import type { SpotConfig } from "../types";
import CardPicker from "./CardPicker";
import RangeMatrix from "./RangeMatrix";

interface Props {
  onSolve: (config: SpotConfig) => void;
}

const TREE_PRESETS = {
  light: {
    label: "超軽量 (フロップ解析の推奨)",
    betsFlop: "33",
    betsTurn: "75",
    betsRiver: "75",
    raisesFlop: "60",
    raisesTurn: "",
    raisesRiver: "",
    maxBets: 2,
    allin: 0,
  },
  simple: {
    label: "シンプル (ターン/リバー解析の推奨)",
    betsFlop: "33",
    betsTurn: "75",
    betsRiver: "75",
    raisesFlop: "60",
    raisesTurn: "60",
    raisesRiver: "60",
    maxBets: 2,
    allin: 0,
  },
  standard: {
    label: "標準 (大メモリ・低速)",
    betsFlop: "33,75",
    betsTurn: "75",
    betsRiver: "75",
    raisesFlop: "60",
    raisesTurn: "60",
    raisesRiver: "60",
    maxBets: 3,
    allin: 1.0,
  },
} as const;

const POT_TYPES: { id: PotType; label: string }[] = [
  { id: "srp", label: "SRP" },
  { id: "3bp", label: "3BET" },
  { id: "4bp", label: "4BET" },
];

function isMobileDevice(): boolean {
  return navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 800;
}

export default function SpotConfigView({ onSolve }: Props) {
  const [opener, setOpener] = useState<Position>("BTN");
  const [defender, setDefender] = useState<Position>("BB");
  const [potType, setPotType] = useState<PotType>("srp");
  // tightness is per player (e.g. tight BB vs loose BTN)
  const [openerT, setOpenerT] = useState<Tightness>("normal");
  const [defenderT, setDefenderT] = useState<Tightness>("normal");

  const scenario = useMemo(
    () => buildScenario(opener, defender, potType, openerT, defenderT),
    [opener, defender, potType, openerT, defenderT]
  );
  // which displayed side (oop/ip) belongs to the opener
  const oopIsOpener = scenario.oopName === opener;
  const sideT = (side: Side): Tightness =>
    (side === "oop") === oopIsOpener ? openerT : defenderT;
  const setSideT = (side: Side, t: Tightness) => {
    if ((side === "oop") === oopIsOpener) setOpenerT(t);
    else setDefenderT(t);
  };

  // ranges/pot/stack are editable overrides on top of the scenario
  const [overrides, setOverrides] = useState<{
    key: string;
    oop?: Float32Array;
    ip?: Float32Array;
    pot?: number;
    stack?: number;
  }>({ key: "" });
  const scenarioKey = `${opener}-${defender}-${potType}-${openerT}-${defenderT}`;
  const ov = overrides.key === scenarioKey ? overrides : { key: scenarioKey };

  // user-saved ranges for this slot take precedence over the preset
  const [customVersion, setCustomVersion] = useState(0);
  const customOop = useMemo(
    () => loadCustomRange(opener, defender, potType, sideT("oop"), "oop"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scenarioKey, customVersion]
  );
  const customIp = useMemo(
    () => loadCustomRange(opener, defender, potType, sideT("ip"), "ip"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scenarioKey, customVersion]
  );

  const oopRange = ov.oop ?? customOop ?? scenario.oopRange;
  const ipRange = ov.ip ?? customIp ?? scenario.ipRange;
  const pot = ov.pot ?? scenario.pot;
  const stack = ov.stack ?? scenario.stack;

  const saveRange = (side: Side, grid: Float32Array) => {
    saveCustomRange(opener, defender, potType, sideT(side), side, grid);
    setOverrides({ ...ov, [side === "oop" ? "oop" : "ip"]: undefined });
    setCustomVersion((v) => v + 1);
  };
  const resetRange = (side: Side) => {
    clearCustomRange(opener, defender, potType, sideT(side), side);
    setOverrides({ ...ov, [side === "oop" ? "oop" : "ip"]: undefined });
    setCustomVersion((v) => v + 1);
  };

  const [boardText, setBoardText] = useState("Ks7h2d");
  const [treePresetManual, setTreePresetManual] =
    useState<keyof typeof TREE_PRESETS | null>(null);
  const [iterations, setIterations] = useState(150);
  const [error, setError] = useState("");

  const board = parseBoard(boardText) ?? [];
  const boardValid = board.length >= 3 && board.length <= 5;
  const treePreset =
    treePresetManual ?? (board.length === 3 ? "light" : "simple");

  const pickDefender = (op: Position, def: Position): Position =>
    validDefenders(op).includes(def) ? def : "BB";

  const randomFlop = () => {
    const cards = new Set<number>();
    while (cards.size < 3) cards.add(Math.floor(Math.random() * 52));
    setBoardText([...cards].map(cardToString).join(""));
  };

  const solve = () => {
    if (!boardValid) {
      setError("ボードは3〜5枚で指定してください (例: Ks7h2d)");
      return;
    }
    const t = TREE_PRESETS[treePreset];
    onSolve({
      board: board.map(cardToString).join(""),
      pot,
      stack,
      betsFlop: t.betsFlop,
      betsTurn: t.betsTurn,
      betsRiver: t.betsRiver,
      raisesFlop: t.raisesFlop,
      raisesTurn: t.raisesTurn,
      raisesRiver: t.raisesRiver,
      maxBets: t.maxBets,
      allinThreshold: t.allin,
      rangeOop: oopRange,
      rangeIp: ipRange,
      oopName: scenario.oopName,
      ipName: scenario.ipName,
      targetIterations: iterations,
    });
  };

  return (
    <div className="config-view">
      <section className="panel">
        <h2>プリフロップシナリオ</h2>
        <div className="line-builder">
          <div className="pos-group">
            <span className="pos-label">オープン</span>
            <div className="pos-buttons">
              {OPENER_POSITIONS.map((p) => (
                <button
                  key={p}
                  className={"pos-btn" + (opener === p ? " active" : "")}
                  onClick={() => {
                    setOpener(p);
                    setDefender(pickDefender(p, defender));
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div className="pos-group">
            <span className="pos-label">相手</span>
            <div className="pos-buttons">
              {validDefenders(opener).map((p) => (
                <button
                  key={p}
                  className={"pos-btn" + (defender === p ? " active" : "")}
                  onClick={() => setDefender(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div className="pos-group">
            <span className="pos-label">ポット</span>
            <div className="pos-buttons">
              {POT_TYPES.map((t) => (
                <button
                  key={t.id}
                  className={"pos-btn" + (potType === t.id ? " active" : "")}
                  onClick={() => setPotType(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="scenario-desc">{scenario.description}</p>
        <div className="pot-stack">
          <label>
            ポット (bb)
            <input
              type="number"
              value={pot}
              step={0.5}
              onChange={(e) => setOverrides({ ...ov, pot: +e.target.value })}
            />
          </label>
          <label>
            有効スタック (bb)
            <input
              type="number"
              value={stack}
              step={0.5}
              onChange={(e) => setOverrides({ ...ov, stack: +e.target.value })}
            />
          </label>
        </div>
        <p className="hint">
          レンジは100bbキャッシュの近似GTOレンジです。下のマトリクスで自由に編集できます。
        </p>
      </section>

      <section className="panel ranges-panel">
        <div className="ranges-row">
          <RangeMatrix
            title={`OOP: ${scenario.oopName}`}
            grid={oopRange}
            onChange={(g) => setOverrides({ ...ov, oop: g })}
            isCustom={customOop !== null}
            onSave={() => saveRange("oop", oopRange)}
            onResetPreset={() => resetRange("oop")}
            tightness={sideT("oop")}
            onTightnessChange={(t) => setSideT("oop", t)}
          />
          <RangeMatrix
            title={`IP: ${scenario.ipName}`}
            grid={ipRange}
            onChange={(g) => setOverrides({ ...ov, ip: g })}
            isCustom={customIp !== null}
            onSave={() => saveRange("ip", ipRange)}
            onResetPreset={() => resetRange("ip")}
            tightness={sideT("ip")}
            onTightnessChange={(t) => setSideT("ip", t)}
          />
        </div>
        <p className="hint">
          レンジの広さ (タイト/ノーマル/ルース) はプレイヤー毎に選べます。
          「保存」でこの組み合わせ (ポジション×ポットタイプ×広さ)
          のレンジとして端末に保存され、次回から自動で使われます。
        </p>
      </section>

      <section className="panel">
        <h2>ボード</h2>
        <div className="board-input">
          <input
            type="text"
            value={boardText}
            onChange={(e) => setBoardText(e.target.value)}
            placeholder="例: Ks7h2d (ターン/リバー解析は4〜5枚)"
            className={boardValid ? "" : "invalid"}
          />
          <button onClick={randomFlop}>ランダムフロップ</button>
          <button onClick={() => setBoardText("")} disabled={board.length === 0}>
            クリア
          </button>
        </div>
        <CardPicker
          selected={board}
          disabled={[]}
          onPick={(c) => {
            if (board.includes(c)) {
              setBoardText(
                board.filter((x) => x !== c).map(cardToString).join("")
              );
            } else if (board.length < 5) {
              setBoardText([...board, c].map(cardToString).join(""));
            }
          }}
        />
      </section>

      <section className="panel">
        <h2>ツリー設定</h2>
        <div className="tree-config">
          <select
            value={treePreset}
            onChange={(e) =>
              setTreePresetManual(e.target.value as keyof typeof TREE_PRESETS)
            }
          >
            {Object.entries(TREE_PRESETS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label} — ベット F{v.betsFlop}% / T{v.betsTurn}% / R
                {v.betsRiver}%{v.raisesTurn === "" ? " (T/Rレイズなし)" : ""}
              </option>
            ))}
          </select>
          <label>
            イテレーション数
            <input
              type="number"
              value={iterations}
              min={20}
              max={2000}
              step={10}
              onChange={(e) => setIterations(+e.target.value)}
            />
          </label>
        </div>
        <p className="hint">
          フロップ全体の解析はメモリ数百MB・1分前後かかります(ターン・リバーは数秒)。
          解析中の盤面探索は可能で、精度は反復とともに上がります。
        </p>
        {board.length === 3 && isMobileDevice() && (
          <p className="hint warn">
            モバイル端末ではフロップ全体の解析がメモリ不足で失敗する場合があります。
            その場合はターン/リバー解析(ボード4〜5枚)をご利用ください。
          </p>
        )}
      </section>

      {error && <div className="error">{error}</div>}
      <button className="solve-btn" onClick={solve} disabled={!boardValid}>
        ソルブ開始
      </button>
    </div>
  );
}
