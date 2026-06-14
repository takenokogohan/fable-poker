// Image hand analysis: upload a Ten-Four hand card → parse → solve → evaluate
// the hero's postflop decisions. Everything runs client-side.

import { useRef, useState } from "react";
import { SolverSession, chooseWorkers } from "../cluster";

/** Phones can't hold the cluster's per-worker tree copies for a flop solve —
 * it OOMs and Safari reloads the tab. Solve monolithically (one instance) on
 * mobile; the image solve is a small one-off so the speed hit is fine. */
function isMobileDevice(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.maxTouchPoints > 1 &&
    Math.min(screen.width, screen.height) < 820
  );
}
import { handToScenario, type SpotMapping } from "../handImage/analyze";
import { parseHand, type ParsedHand } from "../handImage/parse";
import { evaluateHand, type HandEvaluation } from "../handImage/evaluate";
import {
  RANKS,
  SUIT_COLORS,
  SUIT_SYMBOLS,
  parseCard,
  rankOf,
  suitOf,
} from "../poker";
import { buildConfigText, type SpotConfig } from "../types";

type Phase = "idle" | "parsing" | "solving" | "done" | "error";

/** Decode a file to RGBA, normalized to 840px width (the parser's reference). */
async function fileToImage(file: File): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const url = URL.createObjectURL(file);
  try {
    const im = new Image();
    await new Promise((res, rej) => {
      im.onload = res;
      im.onerror = () => rej(new Error("画像を読み込めません"));
      im.src = url;
    });
    const W = 840;
    const scale = W / im.naturalWidth;
    const H = Math.round(im.naturalHeight * scale);
    const cvs = document.createElement("canvas");
    cvs.width = W;
    cvs.height = H;
    const ctx = cvs.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(im, 0, 0, W, H);
    const id = ctx.getImageData(0, 0, W, H);
    return { width: id.width, height: id.height, data: id.data };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function Cards({ cards }: { cards: string[] }) {
  return (
    <span className="img-cards">
      {cards.map((c, i) => {
        const id = parseCard(c);
        if (id === null) return <span key={i} className="board-card">??</span>;
        return (
          <span key={i} className="board-card" style={{ color: SUIT_COLORS[suitOf(id)] }}>
            {RANKS[rankOf(id)]}
            {SUIT_SYMBOLS[suitOf(id)]}
          </span>
        );
      })}
    </span>
  );
}

const VERDICT = {
  good: { label: "✓ GTO一致", cls: "v-good" },
  ok: { label: "△ わずかに損", cls: "v-ok" },
  mistake: { label: "✗ ミス", cls: "v-bad" },
  na: { label: "—", cls: "" },
} as const;

const STREET_JA: Record<string, string> = { flop: "フロップ", turn: "ターン", river: "リバー" };
const ACTION_JA: Record<string, string> = {
  fold: "フォールド", check: "チェック", call: "コール", bet: "ベット", raise: "レイズ",
};

export default function ImageAnalyze({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [hand, setHand] = useState<ParsedHand | null>(null);
  const [scen, setScen] = useState<SpotMapping | null>(null);
  const [evalRes, setEvalRes] = useState<HandEvaluation | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const sessionRef = useRef<SolverSession | null>(null);

  const reset = () => {
    sessionRef.current?.terminate();
    sessionRef.current = null;
    setHand(null); setScen(null); setEvalRes(null); setProgress(""); setError("");
  };

  async function onFile(file: File | undefined) {
    if (!file) return;
    reset();
    setPhase("parsing");
    try {
      const img = await fileToImage(file);
      const h = parseHand(img);
      setHand(h);
      const s = handToScenario(h);
      setScen(s);
      if (!s.valid) { setPhase("done"); return; }

      setPhase("solving");
      const cfg: SpotConfig = {
        board: s.board!.slice(0, 6), // flop only; turn/river navigated as chance
        pot: s.pot!,
        stack: s.stack!,
        betsFlop: "33", betsTurn: "75", betsRiver: "75",
        raisesFlop: "60", raisesTurn: "", raisesRiver: "",
        maxBets: 2, allinThreshold: 0,
        rangeOop: s.oopRange!, rangeIp: s.ipRange!,
        oopName: s.oop!, ipName: s.ip!,
        targetIterations: 200,
      };
      const workers = isMobileDevice() ? 0 : chooseWorkers(3);
      const session = await SolverSession.create(buildConfigText(cfg), workers);
      sessionRef.current = session;
      const target = 200;
      while (session.iterations < target) {
        await session.runIterations(20);
        setProgress(`ソルブ中 ${session.iterations}/${target}`);
      }
      const ev = await evaluateHand(session, h, s);
      setEvalRes(ev);
      setPhase("done");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }

  return (
    <div className="image-analyze">
      <header>
        <h1>ハンド画像を解析</h1>
        <button className="back-btn" onClick={() => { reset(); onClose(); }}>← 戻る</button>
      </header>

      <section className="panel">
        <p className="hint">
          Ten-Four のハンド履歴画像を選んでください。端末内で解析され、画像は送信されません。
        </p>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
      </section>

      {error && <div className="error">{error}</div>}
      {phase === "parsing" && <div className="loading">画像を解析中…</div>}
      {phase === "solving" && <div className="loading">{progress || "ソルブ中…"}</div>}

      {hand && (
        <section className="panel">
          <h2>読み取り結果</h2>
          <div className="img-summary">
            <span>
              ヒーロー <b>{hand.heroPosition}</b> <Cards cards={hand.heroCards} />
            </span>
            <span>ボード <Cards cards={hand.board} /></span>
            <span>
              {hand.potType === "srp" ? "シングルレイズ" : hand.potType === "3bp" ? "3betポット" : hand.potType === "4bp" ? "4betポット" : hand.potType}
            </span>
          </div>
          {hand.warnings.length > 0 && (
            <p className="hint warn">読み取り注意: {hand.warnings.join(" / ")}</p>
          )}
        </section>
      )}

      {scen && !scen.valid && (
        <section className="panel">
          <p className="hint warn">このハンドは自動ソルブ対象外です: {scen.reason}</p>
        </section>
      )}

      {scen && scen.valid && evalRes && (
        <section className="panel">
          <h2>
            {scen.opener} vs {scen.defender}・{hand?.potType === "3bp" ? "3betポット" : hand?.potType === "4bp" ? "4betポット" : "SRP"}
            ・ヒーロー {scen.hero}（{scen.heroIsOop ? "OOP" : "IP"}）
          </h2>
          {evalRes.postflop.length === 0 ? (
            <p className="hint">評価対象のポストフロップ決定がありません。{evalRes.truncatedReason}</p>
          ) : (
            <table className="eval-table">
              <thead>
                <tr><th>ストリート</th><th>あなたの行動</th><th>頻度</th><th>EVロス</th><th>判定</th></tr>
              </thead>
              <tbody>
                {evalRes.postflop.map((d, i) => (
                  <tr key={i}>
                    <td>{STREET_JA[d.street] ?? d.street}</td>
                    <td>{ACTION_JA[d.action] ?? d.action}</td>
                    <td>{d.freq === null ? "—" : `${(d.freq * 100).toFixed(0)}%`}</td>
                    <td>{d.evLoss === null ? "—" : `${d.evLoss.toFixed(2)}bb`}</td>
                    <td className={VERDICT[d.verdict].cls}>{VERDICT[d.verdict].label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {evalRes.truncatedReason && evalRes.postflop.length > 0 && (
            <p className="hint">注: {evalRes.truncatedReason}(以降は未評価)</p>
          )}
          <p className="hint">
            ※ プリフロップとレンジは標準プリセットによる近似です。ベットサイズは簡易ツリー(フロップ33%/ターン・リバー75%)に丸めています。
          </p>
        </section>
      )}
    </div>
  );
}
