import type { Spec } from './dsl.ts';
import { simulate, type RunResult, type Signals, type Trade } from './engine.ts';
import { Evaluator } from './evaluate.ts';
import type { Asset, Bars } from './types.ts';

export interface Stats {
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  volatility: number;
  sharpe: number;
  /** Average fraction of equity invested. */
  exposure: number;
}

export interface TradeStats {
  count: number;
  open: number;
  winRate: number;
  avgReturn: number;
}

export interface Backtest {
  run: RunResult;
  stats: Stats;
  tradeStats: TradeStats;
  drawdown: number[];
  benchmark: { label: string; equity: number[]; drawdown: number[]; stats: Stats };
}

const YEAR = 365.25 * 86_400_000;

export function drawdowns(equity: number[]): number[] {
  let peak = -Infinity;
  return equity.map((e) => {
    peak = Math.max(peak, e);
    return e / peak - 1;
  });
}

export function computeStats(t: number[], equity: number[], capital: number, exposure: number[]): Stats {
  const years = (t[t.length - 1] - t[0]) / YEAR;
  const total = equity[equity.length - 1] / capital - 1;
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) rets.push(equity[i] / equity[i - 1] - 1);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
  const perYear = rets.length / years;
  return {
    totalReturn: total,
    cagr: (1 + total) ** (1 / years) - 1,
    maxDrawdown: Math.min(...drawdowns(equity)),
    volatility: sd * Math.sqrt(perYear),
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(perYear) : 0,
    exposure: exposure.reduce((s, x) => s + x, 0) / exposure.length,
  };
}

export function computeTradeStats(trades: Trade[]): TradeStats {
  const closed = trades.filter((t) => t.reason !== 'open');
  return {
    count: closed.length,
    open: trades.length - closed.length,
    winRate: closed.length ? closed.filter((t) => t.ret > 0).length / closed.length : NaN,
    avgReturn: closed.length ? closed.reduce((s, t) => s + t.ret, 0) / closed.length : NaN,
  };
}

/** Runs the spec and a buy-and-hold benchmark over the same dates. `data` is keyed by asset name. */
export function runBacktest(spec: Spec, data: Map<string, Bars>): Backtest {
  const evaluator = new Evaluator(data);
  const signals = new Map<string, Signals>();
  for (const a of spec.universe) {
    const r = spec.rules[a.name];
    signals.set(a.name, { buy: evaluator.eval(r.buy, a.name), sell: r.sell ? evaluator.eval(r.sell, a.name) : null });
  }
  const run = simulate({ ...spec, assets: spec.universe }, data, signals);

  // The benchmark holds the same weights (or the named ticker) throughout, with the same costs
  // and rebalancing, bought at the same first open the strategy could have bought at.
  const held: Asset[] = spec.benchmark ? [{ ...spec.benchmark, weight: 1 }] : spec.universe;
  const always = new Map<string, Signals>(held.map((a) => [a.name, { buy: data.get(a.name)!.t.map(() => 1), sell: null }]));
  const bench = simulate(
    { assets: held, from: run.t[0], to: run.t[run.t.length - 1], capital: spec.capital, costBps: spec.costBps, rebalance: spec.rebalance, stopLoss: null, trailingStop: null, takeProfit: null },
    data,
    always,
  );
  // A named benchmark can trade on other days than the strategy: carry its last value.
  let j = -1;
  const benchEquity = run.t.map((t) => {
    while (j + 1 < bench.t.length && bench.t[j + 1] <= t) j++;
    return j < 0 ? spec.capital : bench.equity[j];
  });
  const benchExposure = run.t.map(() => 1);

  return {
    run,
    stats: computeStats(run.t, run.equity, spec.capital, run.exposure),
    tradeStats: computeTradeStats(run.trades),
    drawdown: drawdowns(run.equity),
    benchmark: {
      label: spec.benchmark ? `${spec.benchmark.name} buy & hold` : 'Buy & hold',
      equity: benchEquity,
      drawdown: drawdowns(benchEquity),
      stats: computeStats(run.t, benchEquity, spec.capital, benchExposure),
    },
  };
}
