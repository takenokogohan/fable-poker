import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { SolverSession, chooseWorkers } from "./cluster";
import CardPicker from "./components/CardPicker";
import HandDetail from "./components/HandDetail";
import SpotConfigView from "./components/SpotConfig";
import StrategyMatrix from "./components/StrategyMatrix";
import { cacheGet, cacheKey, cachePut } from "./idb";
import {
  STREET_NAMES,
  SUIT_COLORS,
  SUIT_SYMBOLS,
  actionColor,
  actionLabel,
  fmtBB,
  handToCell,
  parseBoard,
  rankOf,
  suitOf,
  RANKS,
} from "./poker";
import type { NodeData, SpotConfig } from "./types";
import { buildConfigText } from "./types";
import type { SessionMeta } from "./cluster";

type Phase = "config" | "loading" | "solving";
type CacheState = "none" | "restored" | "saving" | "saved";

interface PathStep {
  step: number;
  label: string;
}

function BoardCards({ board }: { board: string }) {
  const cards = parseBoard(board) ?? [];
  return (
    <span className="board-cards">
      {cards.map((c, i) => (
        <span
          key={i}
          className="board-card"
          style={{ color: SUIT_COLORS[suitOf(c)] }}
        >
          {RANKS[rankOf(c)]}
          {SUIT_SYMBOLS[suitOf(c)]}
        </span>
      ))}
    </span>
  );
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("config");
  const [spot, setSpot] = useState<SpotConfig | null>(null);
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [node, setNode] = useState<NodeData | null>(null);
  const [path, setPath] = useState<PathStep[]>([]);
  const [iterations, setIterations] = useState(0);
  const [explPct, setExplPct] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [selectedCell, setSelectedCell] = useState<number | null>(null);
  const [showEv, setShowEv] = useState(false);
  const [showEq, setShowEq] = useState(false);
  const [cacheState, setCacheState] = useState<CacheState>("none");
  const [error, setError] = useState("");

  const session = useRef<SolverSession | null>(null);
  const runningRef = useRef(false);
  const targetRef = useRef(0);
  const pathRef = useRef<number[]>([]);
  const flagsRef = useRef<string[]>([]);
  const cacheKeyRef = useRef("");
  const savedIterRef = useRef(0);

  const queryNode = useCallback(async () => {
    if (!session.current) return;
    const flags: string[] = [];
    if (showEv) flags.push("ev");
    if (showEq) flags.push("eq");
    flagsRef.current = flags;
    try {
      const data = await session.current.query(pathRef.current, flags);
      if (data.ok) setNode(data);
      else setError(data.error ?? "クエリ失敗");
    } catch (e) {
      setError(String(e));
    }
  }, [showEv, showEq]);

  const saveToCache = useCallback(async () => {
    const s = session.current;
    if (!s || s.iterations <= savedIterRef.current) return;
    setCacheState("saving");
    try {
      const states = await s.exportStates();
      const bytes = states.reduce((a, b) => a + b.byteLength, 0);
      const ok = await cachePut({
        key: cacheKeyRef.current,
        iterations: s.iterations,
        workers: s.k,
        states,
        savedAt: Date.now(),
        bytes,
        label: spot?.board ?? "",
      });
      savedIterRef.current = s.iterations;
      setCacheState(ok ? "saved" : "none");
    } catch (e) {
      console.warn("cache save failed:", e);
      setCacheState("none");
    }
  }, [spot]);

  const solveLoop = useCallback(async () => {
    const s = session.current;
    if (!s || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    let chunk = 2;
    try {
      while (runningRef.current && s.iterations < targetRef.current) {
        const t0 = performance.now();
        const n = Math.min(chunk, targetRef.current - s.iterations);
        await s.runIterations(n);
        setIterations(s.iterations);
        const expl = await s.exploitability();
        setExplPct((expl / (s.meta.pot || 1)) * 100);
        const elapsed = performance.now() - t0;
        chunk = Math.max(
          1,
          Math.min(50, Math.round((n * 1500) / Math.max(elapsed, 50)))
        );
      }
    } catch (e) {
      setError(String(e));
    }
    runningRef.current = false;
    setRunning(false);
    if (session.current) {
      const data = await session.current.query(
        pathRef.current,
        flagsRef.current
      );
      if (data.ok) setNode(data);
      saveToCache();
    }
  }, [saveToCache]);

  const startSolve = useCallback(
    async (config: SpotConfig) => {
      setPhase("loading");
      setError("");
      setSpot(config);
      setPath([]);
      pathRef.current = [];
      setSelectedCell(null);
      setIterations(0);
      setExplPct(null);
      setCacheState("none");
      savedIterRef.current = 0;
      session.current?.terminate();
      session.current = null;

      try {
        const configText = buildConfigText(config);
        cacheKeyRef.current = await cacheKey(configText);
        const cached = await cacheGet(cacheKeyRef.current);
        const cards = config.board.length / 2;
        const k = cached ? cached.workers : chooseWorkers(cards);
        const s = await SolverSession.create(configText, k);
        session.current = s;
        setMeta(s.meta);
        targetRef.current = config.targetIterations;

        if (cached) {
          try {
            await s.importStates(cached.states);
            setIterations(s.iterations);
            savedIterRef.current = s.iterations;
            setCacheState("restored");
            const expl = await s.exploitability();
            setExplPct((expl / (s.meta.pot || 1)) * 100);
          } catch (e) {
            console.warn("cache restore failed:", e);
          }
        }
        setPhase("solving");
        const data = await s.query([], []);
        if (data.ok) setNode(data);
        if (s.iterations < targetRef.current) solveLoop();
      } catch (e) {
        setError(String(e));
        setPhase("config");
      }
    },
    [solveLoop]
  );

  useEffect(() => {
    if (phase === "solving" && !runningRef.current) queryNode();
  }, [showEv, showEq, phase, queryNode]);

  const descend = async (step: number, label: string) => {
    pathRef.current = [...pathRef.current, step];
    setPath((p) => [...p, { step, label }]);
    setSelectedCell(null);
    await queryNode();
  };

  const jumpTo = async (idx: number) => {
    pathRef.current = pathRef.current.slice(0, idx);
    setPath((p) => p.slice(0, idx));
    setSelectedCell(null);
    await queryNode();
  };

  const stop = () => {
    runningRef.current = false;
  };
  const resume = () => {
    targetRef.current = Math.max(targetRef.current, iterations + 100);
    solveLoop();
  };

  if (phase === "config") {
    return (
      <div className="app">
        <header>
          <h1>Fable Poker GTOソルバー</h1>
          <span className="subtitle">
            ヘッズアップ・ポストフロップ CFR+ ソルバー
          </span>
        </header>
        {error && <div className="error">{error}</div>}
        <SpotConfigView onSolve={startSolve} />
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div className="app">
        <div className="loading">ゲームツリー構築中…</div>
      </div>
    );
  }

  const actingPlayer = node?.player ?? 0;
  const playerName =
    actingPlayer === 0 ? spot?.oopName ?? "OOP" : spot?.ipName ?? "IP";
  const hands = actingPlayer === 0 ? meta!.hands0 : meta!.hands1;
  const handCells = hands.map(handToCell);
  const reach = actingPlayer === 0 ? node?.reach0 : node?.reach1;
  const equity = actingPlayer === 0 ? node?.equity0 : node?.equity1;
  const maxChips = node?.actions
    ? Math.max(...node.actions.map((a) => a.chips), 0)
    : 0;

  const aggFreqs: number[] = [];
  if (node?.type === "action" && node.strategy && reach) {
    const na = node.actions!.length;
    const nh = hands.length;
    let total = 0;
    for (let a = 0; a < na; a++) aggFreqs.push(0);
    for (let h = 0; h < nh; h++) {
      const w = reach[h];
      if (w <= 0) continue;
      total += w;
      for (let a = 0; a < na; a++) aggFreqs[a] += w * node.strategy[a * nh + h];
    }
    if (total > 0) for (let a = 0; a < na; a++) aggFreqs[a] /= total;
  }

  const cacheLabel = {
    none: "",
    restored: "キャッシュから復元",
    saving: "キャッシュ保存中…",
    saved: "キャッシュ保存済み",
  }[cacheState];

  return (
    <div className="app">
      <header>
        <h1>Fable Poker GTOソルバー</h1>
        <button
          className="back-btn"
          onClick={() => {
            stop();
            setPhase("config");
          }}
        >
          ← スポット設定へ
        </button>
      </header>

      <div className="solve-status panel">
        <BoardCards board={node?.board ?? meta!.board} />
        <span className="status-item">
          ポット <b>{fmtBB(node?.pot ?? meta!.pot)} bb</b>
        </span>
        <span className="status-item">
          反復 <b>{iterations}</b> / {targetRef.current}
        </span>
        <span className="status-item">
          搾取可能度{" "}
          <b>{explPct === null ? "—" : `${explPct.toFixed(2)}% pot`}</b>
        </span>
        <span className="status-item">
          メモリ <b>{meta!.totalStorageMB.toFixed(0)} MB</b>
        </span>
        {meta!.workersUsed > 0 && (
          <span className="status-item">
            ワーカー <b>{meta!.workersUsed}</b>
          </span>
        )}
        {cacheLabel && <span className="status-item cache">{cacheLabel}</span>}
        {running ? (
          <button onClick={stop}>一時停止</button>
        ) : (
          <button onClick={resume}>+100 反復</button>
        )}
        {running && <span className="spinner" />}
      </div>

      <div className="breadcrumbs panel">
        <button
          className={"crumb" + (path.length === 0 ? " current" : "")}
          onClick={() => jumpTo(0)}
        >
          ルート
        </button>
        {path.map((s, i) => (
          <button
            key={i}
            className={"crumb" + (i === path.length - 1 ? " current" : "")}
            onClick={() => jumpTo(i + 1)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      {node?.type === "action" && (
        <>
          <div className="action-bar panel">
            <span className="acting">
              {STREET_NAMES[node.street ?? 0]} — <b>{playerName}</b>{" "}
              のアクション
              {(node.toCall ?? 0) > 0 && ` (${fmtBB(node.toCall!)} bb に直面)`}
            </span>
            <div className="action-buttons">
              {node.actions!.map((a, i) => (
                <button
                  key={i}
                  className="action-btn"
                  style={{
                    borderColor: actionColor(a.kind, a.chips, maxChips),
                  }}
                  onClick={() =>
                    descend(i, `${playerName}: ${actionLabel(a.kind, a.chips)}`)
                  }
                >
                  <span
                    className="action-dot"
                    style={{
                      background: actionColor(a.kind, a.chips, maxChips),
                    }}
                  />
                  {actionLabel(a.kind, a.chips)}
                  <span className="action-freq">
                    {aggFreqs[i] !== undefined
                      ? `${(aggFreqs[i] * 100).toFixed(1)}%`
                      : ""}
                  </span>
                </button>
              ))}
            </div>
            <div className="overlay-toggles">
              <label>
                <input
                  type="checkbox"
                  checked={showEv}
                  onChange={(e) => setShowEv(e.target.checked)}
                />
                EV
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showEq}
                  onChange={(e) => setShowEq(e.target.checked)}
                />
                エクイティ
              </label>
            </div>
          </div>

          <div className="solve-main">
            <div className="panel">
              <StrategyMatrix
                handCells={handCells}
                reach={reach!}
                strategy={node.strategy!}
                actions={node.actions!}
                selectedCell={selectedCell}
                onCellClick={setSelectedCell}
              />
            </div>
            {selectedCell !== null && (
              <div className="panel">
                <HandDetail
                  cell={selectedCell}
                  hands={hands}
                  handCells={handCells}
                  reach={reach!}
                  strategy={node.strategy!}
                  evs={node.evs}
                  equity={equity}
                  actions={node.actions!}
                />
              </div>
            )}
          </div>
        </>
      )}

      {node?.type === "chance" && (
        <div className="panel">
          <h3>次のカードを選択</h3>
          <CardPicker
            selected={[]}
            disabled={Array.from({ length: 52 }, (_, c) => c).filter(
              (c) => !(node.cards ?? []).includes(c)
            )}
            onPick={(c) =>
              descend(c, `${RANKS[rankOf(c)]}${SUIT_SYMBOLS[suitOf(c)]}`)
            }
          />
        </div>
      )}

      {node?.type === "terminal" && (
        <div className="panel terminal-panel">
          <h3>
            {node.terminal === "fold"
              ? `${
                  node.folder === 0 ? spot?.oopName : spot?.ipName
                } がフォールド — ポット ${fmtBB(node.pot ?? 0)} bb`
              : `ショーダウン — ポット ${fmtBB(node.pot ?? 0)} bb`}
          </h3>
          {showEq && node.equity0 && (
            <p>
              平均エクイティ: {spot?.oopName}{" "}
              {avgEquity(node.equity0, node.reach0).toFixed(1)}% /{" "}
              {spot?.ipName}{" "}
              {avgEquity(node.equity1!, node.reach1).toFixed(1)}%
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function avgEquity(eq: number[], reach: number[]): number {
  let num = 0;
  let den = 0;
  for (let h = 0; h < eq.length; h++) {
    num += eq[h] * reach[h];
    den += reach[h];
  }
  return den > 0 ? (num / den) * 100 : 0;
}
