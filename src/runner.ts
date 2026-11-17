import { runBacktest, type Backtest } from './backtest.ts';
import { barsFrom, insideReach, loadBars, loadInsideBars, type DataDeps, type Loaded } from './data.ts';
import { insideKey } from './engine.ts';
import { paramValues, parseSpec, type Defaults, type Expr, type ParseResult, type Spec } from './dsl.ts';
import { emptyBars, type AssetRef, type Bars } from './types.ts';

const DAY = 86_400_000;
const INTERVAL_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: DAY, w: 7 * DAY };
const MIN_LOOKBACK = 250;
/** Recursive averages (EMA, RSI, ATR) depend on where they started; this many periods makes that negligible. */
const SETTLE = 5;
/** How far back before the run `bars_since` looks for the last bar its condition held, on top of what the condition itself needs. */
const BARS_SINCE_REACH = 250;
/** Daily and longer bars skip weekends and holidays, so a run of trading bars spans more calendar time. */
const NON_TRADING = 1.6;
/** The parser refuses longer periods, so a range reaching past this needs no more history. */
const MAX_PERIOD = 10_000;

/** The value a period or lag is looked back with: the largest its parameter can take up to `max`, when it is one. */
type Widest = (value: number, param: string | null | undefined, max?: number) => number;

/** Bars of history an expression reads before its current bar: nested windows add, and so do lags. */
function exprLookback(e: Expr, w: Widest): number {
  const back = (x: Expr) => exprLookback(x, w);
  switch (e.k) {
    case 'num':
    case 'bool':
    case 'series':
    case 'pos':
      return 0;
    case 'cal':
      return e.name === 'month_start' ? 1 : 0;
    case 'ind': {
      const src = e.src ? back(e.src) : 0;
      const [a, b, c] = e.args.map((v, k) => w(v, e.params?.[k], MAX_PERIOD));
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
        case 'stoch_k':
          return a + b;
        case 'stoch_d':
          return a + b + c;
        case 'adx':
          return 1 + 2 * SETTLE * a;
        case 'plus_di':
        case 'minus_di':
        case 'supertrend':
        case 'supertrend_up':
          return 1 + SETTLE * a;
        case 'mfi':
          return 1 + a;
        case 'obv':
          return 1;
        case 'percent_rank':
        case 'correl':
          return src + a + 1;
        case 'hma':
          return src + a + Math.floor(Math.sqrt(a));
        case 'keltner_upper':
        case 'keltner_lower':
          return Math.max(src + SETTLE * a, 1 + SETTLE * c);
        case 'bars_since':
          return src + BARS_SINCE_REACH;
        default:
          return src + a;
      }
    }
    case 'math':
      return Math.max(...e.args.map(back));
    case 'bin':
    case 'logic':
      return Math.max(back(e.a), back(e.b));
    case 'cmp':
      return Math.max(back(e.a), back(e.b)) + (e.op === 'xup' || e.op === 'xdn' ? 1 : 0);
    case 'neg':
    case 'not':
    case 'of':
      return back(e.a);
    case 'lag':
      return back(e.a) + w(e.n, e.param);
  }
}

/**
 * Bars of history a run needs before "from" so that every rule, ranking score, ATR stop and
 * sizing input is known and settled at its first bar; at least 250. A period or lag given by a
 * parameter with a range counts at the largest value of the range, so a sweep, the luck checks or
 * a slider can try any value of it on the prices loaded for the block. That depends only on the
 * block's text, so the same block still loads the same history.
 */
export function lookbackBars(spec: Spec): number {
  const widest: Widest = (value, param, max = Infinity) => {
    const p = param ? spec.params.find((x) => x.name === param) : undefined;
    return p ? Math.max(value, ...paramValues(p).filter((v) => v <= max)) : value;
  };
  let bars = MIN_LOOKBACK;
  const exprs = Object.values(spec.rules).flatMap((r) => [r.buy, ...(r.sell ? [r.sell] : []), ...(r.add ? [r.add] : [])]);
  if (spec.rank) exprs.push(spec.rank.by);
  for (const e of exprs) bars = Math.max(bars, exprLookback(e, widest));
  for (const st of Object.values(spec.stops)) {
    for (const level of [st.stopLoss, st.trailingStop, st.takeProfit]) if (level?.k === 'atr') bars = Math.max(bars, 1 + SETTLE * widest(level.n, level.nParam, MAX_PERIOD));
  }
  if (spec.sizing.k === 'risk') bars = Math.max(bars, 1 + SETTLE * widest(spec.sizing.n, spec.sizing.nParam, MAX_PERIOD));
  if (spec.sizing.k === 'invvol') bars = Math.max(bars, 1 + widest(spec.sizing.n, spec.sizing.nParam, MAX_PERIOD));
  return bars;
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
    const warnings = loaded.flatMap((l) => (l.warning ? [l.warning] : []));
    // Saved prices can reach further back than this run asks for; the same block must give the same answer.
    const data = new Map(loaded.map((l) => [l.name, barsFrom(l.bars, since)]));
    if (spec.magnify) {
      for (const inside of await this.loadInside(spec, spec.magnify, force)) {
        if (inside.warning) warnings.push(inside.warning);
        if (inside.bars) data.set(insideKey(inside.name, spec.magnify), inside.bars);
      }
    }
    return { data, warnings, prices: loaded.map((l) => ({ name: l.name, source: l.source, through: l.through, fetched: l.fetched, stale: l.stale })) };
  }

  /**
   * The smaller bars of each Yahoo and Binance ticker in the universe, for `magnify`, from the run's first day (no history
   * before it is needed, as nothing is held there) or the earliest the source gives them, whichever is later. A ticker
   * whose smaller bars can't be loaded is read as whole bars, with a warning; one whose window does not reach into the
   * run gets none, which the run's notes say.
   */
  private loadInside(spec: Spec, interval: string, force: boolean): Promise<{ name: string; bars: Bars | null; warning: string | null }[]> {
    const now = this.deps.now();
    return Promise.all(
      spec.universe
        .filter((a) => a.source !== 'csv')
        .map(async (a) => {
          const since = Math.max(spec.from ?? 0, insideReach(a.source, interval, now));
          if (spec.to !== null && spec.to < since) return { name: a.name, bars: emptyBars(), warning: null };
          try {
            const l = await loadInsideBars(a, interval, since, this.deps, force, { freshForMs: this.freshForMs });
            return { name: a.name, bars: barsFrom(l.bars, since), warning: l.warning };
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            return { name: a.name, bars: null, warning: `${why.replace(/\.$/, '')}. ${a.name}'s bars were not looked inside.` };
          }
        }),
    );
  }

  async run(spec: Spec, force = false): Promise<RunOutput> {
    const { data, warnings, prices } = await this.loadPrices(spec, force);
    return { spec, backtest: runBacktest(spec, data), data, warnings, prices };
  }
}
