import { runBacktest, type Backtest } from './backtest.ts';
import { loadBars, type DataDeps, type Loaded } from './data.ts';
import { parseSpec, type Defaults, type Expr, type ParseResult, type Spec } from './dsl.ts';
import type { AssetRef, Bars } from './types.ts';

const DAY = 86_400_000;
const INTERVAL_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: DAY, w: 7 * DAY };
const MIN_LOOKBACK = 250;
/** Recursive averages (EMA, RSI, ATR) depend on where they started; this many periods makes that negligible. */
const SETTLE = 5;
/** Daily and longer bars skip weekends and holidays, so a run of trading bars spans more calendar time. */
const NON_TRADING = 1.6;

/** Bars of history an expression reads before its current bar: nested windows add, and so do lags. */
function exprLookback(e: Expr): number {
  switch (e.k) {
    case 'num':
    case 'bool':
    case 'series':
    case 'pos':
      return 0;
    case 'cal':
      return e.name === 'month_start' ? 1 : 0;
    case 'ind': {
      const src = e.src ? exprLookback(e.src) : 0;
      const [a, b, c] = e.args;
      switch (e.fn) {
        case 'ema':
          return src + SETTLE * a;
        case 'rsi':
          return src + 1 + SETTLE * a;
        case 'atr':
          return 1 + SETTLE * a;
        case 'macd':
          return src + SETTLE * Math.max(a, b);
        case 'macd_signal':
          return src + SETTLE * (Math.max(a, b) + c);
        default:
          return src + a;
      }
    }
    case 'math':
      return Math.max(...e.args.map(exprLookback));
    case 'bin':
    case 'logic':
      return Math.max(exprLookback(e.a), exprLookback(e.b));
    case 'cmp':
      return Math.max(exprLookback(e.a), exprLookback(e.b)) + (e.op === 'xup' || e.op === 'xdn' ? 1 : 0);
    case 'neg':
    case 'not':
    case 'of':
      return exprLookback(e.a);
    case 'lag':
      return exprLookback(e.a) + e.n;
  }
}

/**
 * Bars of history a run needs before "from" so that every rule, ranking score, ATR stop and
 * sizing input is known and settled at its first bar; at least 250.
 */
export function lookbackBars(spec: Spec): number {
  let bars = MIN_LOOKBACK;
  const exprs = Object.values(spec.rules).flatMap((r) => (r.sell ? [r.buy, r.sell] : [r.buy]));
  if (spec.rank) exprs.push(spec.rank.by);
  for (const e of exprs) bars = Math.max(bars, exprLookback(e));
  for (const st of Object.values(spec.stops)) {
    for (const level of [st.stopLoss, st.trailingStop, st.takeProfit]) if (level?.k === 'atr') bars = Math.max(bars, 1 + SETTLE * level.n);
  }
  if (spec.sizing.k === 'risk') bars = Math.max(bars, 1 + SETTLE * spec.sizing.n);
  if (spec.sizing.k === 'invvol') bars = Math.max(bars, 1 + spec.sizing.n);
  return bars;
}

/** The bars at or after `since`. */
function barsFrom(bars: Bars, since: number): Bars {
  let i = 0;
  while (i < bars.t.length && bars.t[i] < since) i++;
  if (i === 0) return bars;
  return { t: bars.t.slice(i), o: bars.o.slice(i), h: bars.h.slice(i), l: bars.l.slice(i), c: bars.c.slice(i), v: bars.v.slice(i) };
}

export interface RunOutput {
  spec: Spec;
  backtest: Backtest;
  data: Map<string, Bars>;
  /** Things the reader should know that did not stop the run, such as stale prices. */
  warnings: string[];
  prices: PriceInfo[];
}

/** Where one ticker's prices came from and how far they go. */
export interface PriceInfo {
  name: string;
  source: Loaded['source'];
  through: number;
  fetched: number;
  stale: boolean;
}

/** Loads a spec's prices and runs it. Knows nothing about Obsidian: everything outside comes through `deps`. */
export class Runner {
  private deps: DataDeps;
  private defaults: Partial<Defaults>;
  private freshForMs: number | undefined;

  /** `defaults` fill in what a block leaves out, such as the capital or the cash rate. */
  constructor(deps: DataDeps, defaults: Partial<Defaults> = {}, opts: { freshForMs?: number } = {}) {
    this.deps = deps;
    this.defaults = defaults;
    this.freshForMs = opts.freshForMs;
  }

  /** Parses a block with this runner's defaults; `overrides` replace declared parameter values. */
  parse(source: string, overrides?: Record<string, number>): ParseResult {
    return parseSpec(source, { defaults: this.defaults, overrides });
  }

  async loadPrices(spec: Spec, force = false): Promise<{ data: Map<string, Bars>; warnings: string[]; prices: PriceInfo[] }> {
    const refs = new Map<string, AssetRef>();
    const cash = spec.cash.k === 'ticker' ? [spec.cash.ref] : [];
    for (const r of [...spec.universe, ...spec.extras, ...(spec.benchmark ? [spec.benchmark] : []), ...cash]) {
      if (!refs.has(r.name)) refs.set(r.name, r);
    }
    const step = Number(spec.interval.slice(0, -1)) * INTERVAL_MS[spec.interval.slice(-1)];
    const since = spec.from === null ? 0 : spec.from - Math.ceil(lookbackBars(spec) * (step >= DAY ? NON_TRADING : 1)) * step;
    const loaded = await Promise.all(
      [...refs.values()].map(async (r) => ({ name: r.name, ...(await loadBars(r, spec.interval, since, this.deps, force, { freshForMs: this.freshForMs })) })),
    );
    return {
      // Saved prices can reach further back than this run asks for; the same block must give the same answer.
      data: new Map(loaded.map((l) => [l.name, barsFrom(l.bars, since)])),
      warnings: loaded.flatMap((l) => (l.warning ? [l.warning] : [])),
      prices: loaded.map((l) => ({ name: l.name, source: l.source, through: l.through, fetched: l.fetched, stale: l.stale })),
    };
  }

  async run(spec: Spec, force = false): Promise<RunOutput> {
    const { data, warnings, prices } = await this.loadPrices(spec, force);
    return { spec, backtest: runBacktest(spec, data), data, warnings, prices };
  }
}
