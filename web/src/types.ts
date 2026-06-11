// Shared types for the worker protocol and solver JSON payloads.

export interface SolverMeta {
  ok: boolean;
  error?: string;
  hands0: string[];
  hands1: string[];
  grid0: number[];
  grid1: number[];
  weights0: number[];
  weights1: number[];
  actionNodes: number;
  storageMB: number;
  board: string;
  pot: number;
  stack: number;
}

export interface RunResult {
  ok: boolean;
  error?: string;
  iterations: number;
  exploitability: number;
  exploitabilityPctPot: number;
}

export interface ActionInfo {
  kind: number;
  chips: number;
}

export interface NodeData {
  ok: boolean;
  error?: string;
  type: "action" | "chance" | "terminal";
  board: string;
  reach0: number[];
  reach1: number[];
  equity0?: number[];
  equity1?: number[];
  // action node
  player?: number;
  street?: number;
  pot?: number;
  toCall?: number;
  actions?: ActionInfo[];
  strategy?: number[];
  evs?: number[];
  // chance node
  cards?: number[];
  // terminal
  terminal?: "fold" | "showdown";
  folder?: number;
}

export interface SpotConfig {
  board: string;
  pot: number;
  stack: number;
  betsFlop: string;
  betsTurn: string;
  betsRiver: string;
  raisesFlop: string;
  raisesTurn: string;
  raisesRiver: string;
  maxBets: number;
  allinThreshold: number;
  rangeOop: Float32Array;
  rangeIp: Float32Array;
  oopName: string;
  ipName: string;
  targetIterations: number;
}

export function buildConfigText(c: SpotConfig): string {
  const lines = [
    `board=${c.board}`,
    `pot=${c.pot}`,
    `stack=${c.stack}`,
    `bets_flop=${c.betsFlop}`,
    `bets_turn=${c.betsTurn}`,
    `bets_river=${c.betsRiver}`,
    `raises_flop=${c.raisesFlop}`,
    `raises_turn=${c.raisesTurn}`,
    `raises_river=${c.raisesRiver}`,
    `max_bets=${c.maxBets}`,
    `allin_threshold=${c.allinThreshold}`,
    `range_oop=${Array.from(c.rangeOop)
      .map((v) => +v.toFixed(3))
      .join(",")}`,
    `range_ip=${Array.from(c.rangeIp)
      .map((v) => +v.toFixed(3))
      .join(",")}`,
  ];
  return lines.join("\n");
}
