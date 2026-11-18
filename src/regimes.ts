// Regimes and crises: how a strategy did while the market was in each of a few states, and through the market's worst
// falls. The market's prices come in from outside, and nothing here reads or changes the prices a result was made from.

import { parseSpec, type Expr } from './dsl.ts';
import { Evaluator } from './evaluate.ts';
import { DAY, YEAR } from './format.ts';
import { barEnds, endedBy } from './indicators.ts';
import { lookbackBars } from './runner.ts';
import type { AssetRef, Bars } from './types.ts';

/** A state of the market that a rule on one ticker's daily bars tells apart: the rule holds, or it does not. */
export interface RegimeDef {
  /** How a block's `universe` line names the ticker the state is read from. */
  ticker: string;
  /** A condition on that ticker's own daily bars: true puts a bar in the first state, false in the second. */
  condition: string;
  title: string;
  states: [string, string];
  /**
   * A fall or rise of more than threefold between two closes within this many bars is the series being quoted in other units,
   * not a move: the state is unknown until the jump is that far behind. For a condition that compares a close with an earlier one.
   */
  scaleWindow?: number;
}

export const STOCK_REGIMES: RegimeDef[] = [
  { ticker: 'SPY', condition: 'close > sma(200)', title: 'SPY against its 200-day average', states: ['Above', 'Below'] },
  { ticker: '^VIX', condition: 'close >= 20', title: 'The VIX', states: ['20 or higher', 'Under 20'] },
  { ticker: '^TNX', condition: 'close > close[126]', title: 'The 10-year yield (^TNX) against its close 126 trading days earlier', states: ['Above', 'Below'], scaleWindow: 126 },
];

export const CRYPTO_REGIMES: RegimeDef[] = [
  { ticker: 'binance:BTCUSDT', condition: 'close > sma(200)', title: 'Bitcoin against its 200-day average', states: ['Above', 'Below'] },
  {
    ticker: 'binance:BTCUSDT',
    condition: 'stdev(roc(1), 30) > median(stdev(roc(1), 30), 365)',
    title: "Bitcoin's 30-day volatility against its median over 365 days",
    states: ['Above', 'Below'],
  },
];

/** A regime with its ticker and rule read out of the block that names them (resolveRegime). */
export interface Regime extends RegimeDef {
  ref: AssetRef;
  rule: Expr;
  /** Bars of history before the run's first bar that the rule needs. */
  lookback: number;
}

export interface RegimePlan {
  regimes: Regime[];
  /** The tickers the regimes read, once each. */
  refs: AssetRef[];
  /** The most history any regime needs before the run's first bar, in bars. */
  lookback: number;
  /** Where the tickers' prices come from, as a sentence names it. */
  source: 'Yahoo' | 'Binance';
}

/** Reads a regime's ticker and rule out of the block that names them. */
export function resolveRegime(def: RegimeDef): Regime {
  const { spec, errors } = parseSpec(`universe: ${def.ticker}\nbuy when ${def.condition}`);
  if (!spec) throw new Error(`The regime "${def.title}" does not parse: ${errors[0].message}`);
  const ref = spec.universe[0];
  return { ...def, ref: { name: ref.name, source: ref.source, id: ref.id }, rule: spec.rules[ref.name].buy, lookback: lookbackBars(spec) };
}

/**
 * The regimes for a strategy: Bitcoin's for one that trades only on Binance, the stock market's for any other, a file of your
 * own prices included.
 */
export function regimePlan(universe: AssetRef[]): RegimePlan {
  const coins = universe.length > 0 && universe.every((a) => a.source === 'binance');
  const regimes = (coins ? CRYPTO_REGIMES : STOCK_REGIMES).map(resolveRegime);
  return {
    regimes,
    refs: [...new Map(regimes.map((r) => [r.ref.name, r.ref])).values()],
    lookback: Math.max(...regimes.map((r) => r.lookback)),
    source: coins ? 'Binance' : 'Yahoo',
  };
}

/** True at each bar with a jump of more than threefold between two closes among the `window` bars ending there. */
function scaleJumps(close: number[], window: number): boolean[] {
  let last = -Infinity;
  return close.map((c, i) => {
    const step = i > 0 ? c / close[i - 1] : 1;
    if (step > 3 || step < 1 / 3) last = i;
    return i - last < window;
  });
}

/**
 * The state at the end of each bar of a run, from the regime's ticker's own daily bars: 0 for the first state, 1 for the
 * second, -1 where it is not known. A bar of the run takes the latest daily bar that had ended by the time the run's bar
 * ended (indicators.ts endedBy), as `of` does, so a weekly or hourly run reads the same daily average a daily run would, and
 * never a day that was still going.
 */
export function regimeBuckets(regime: Regime, home: Bars, runT: number[]): number[] {
  const values = new Evaluator(new Map([[regime.ref.name, home]])).eval(regime.rule, regime.ref.name);
  const jumped = regime.scaleWindow ? scaleJumps(home.c, regime.scaleWindow) : undefined;
  return endedBy(home.t, barEnds(runT)).map((j) => {
    if (j < 0 || jumped?.[j]) return -1;
    return values[j] === 1 ? 0 : values[j] === 0 ? 1 : -1;
  });
}

/**
 * What a run made, aligned: its time, value and exposure at each bar's close, and the benchmark's value (NaN before its
 * prices start). The exposure is gross, longs and shorts together; a block that can borrow also has its net exposure.
 */
export interface RunSeries {
  t: number[];
  equity: number[];
  exposure: number[];
  netExposure?: number[];
  benchmark: number[];
}

/** A compounded return, per year when the steps it covers add up to a year or more. */
export interface Growth {
  value: number;
  perYear: boolean;
}

export interface BucketStats {
  steps: number;
  /** Of all the run's steps. */
  share: number;
  strategy: Growth;
  /** Over the same steps, leaving out those where the benchmark's value is unknown; NaN when none is known. */
  benchmark: Growth;
  /** The average of the exposure at the close of each step, and of the net exposure for a run that has one. */
  exposure: number;
  netExposure?: number;
  /** The worst fall from a high within one unbroken stretch of the state, the value at the stretch's start counting as a high. 0 when it never fell. */
  worstDrawdown: number;
}

const growth = (product: number, covered: number): Growth => (covered >= YEAR ? { value: product ** (YEAR / covered) - 1, perYear: true } : { value: product - 1, perYear: false });

/**
 * A run's figures for each state. `bucket[i]` is the state known at the end of bar i: 0 to `count` - 1, or -1 for unknown,
 * which is the last of the `count` + 1 results. The step from bar i - 1 to bar i is put in the state known at bar i - 1,
 * the last close before it, so a state is never read from the step it is judged by.
 */
export function bucketStats(run: RunSeries, bucket: number[], count: number): BucketStats[] {
  const { t, equity, exposure, netExposure, benchmark } = run;
  const sums = Array.from({ length: count + 1 }, () => ({ steps: 0, covered: 0, product: 1, benchSteps: 0, benchCovered: 0, benchProduct: 1, exposure: 0, net: 0, worst: 0 }));
  let stretch = -1;
  let peak = 0;
  // A run ruined (its equity at 0) stopped there: the steps after it are not the strategy's, in any state.
  const ruin = equity.findIndex((x, i) => i > 0 && x <= 0);
  const n = ruin < 0 ? t.length : ruin + 1;
  for (let i = 1; i < n; i++) {
    const b = bucket[i - 1] < 0 ? count : bucket[i - 1];
    const s = sums[b];
    const span = t[i] - t[i - 1];
    s.steps++;
    s.covered += span;
    s.product *= equity[i] / equity[i - 1];
    s.exposure += exposure[i];
    if (netExposure) s.net += netExposure[i];
    const bench = benchmark[i] / benchmark[i - 1];
    if (Number.isFinite(bench)) {
      s.benchSteps++;
      s.benchCovered += span;
      s.benchProduct *= bench;
    }
    if (b !== stretch) {
      stretch = b;
      peak = equity[i - 1];
    }
    peak = Math.max(peak, equity[i]);
    s.worst = Math.min(s.worst, equity[i] / peak - 1);
  }
  return sums.map((s) => ({
    steps: s.steps,
    share: s.steps / (n - 1),
    strategy: growth(s.product, s.covered),
    benchmark: s.benchSteps > 0 ? growth(s.benchProduct, s.benchCovered) : { value: NaN, perYear: false },
    exposure: s.exposure / s.steps,
    ...(netExposure ? { netExposure: s.net / s.steps } : {}),
    worstDrawdown: s.worst,
  }));
}

/** A fall in the market from its closing high to its closing low, with the days of both (UTC dates). */
export interface Crisis {
  name: string;
  market: 'stocks' | 'bitcoin';
  peak: string;
  trough: string;
}

export const CRISES: Crisis[] = [
  { name: 'Dot-com bust', market: 'stocks', peak: '2000-03-24', trough: '2002-10-09' },
  { name: 'Financial crisis', market: 'stocks', peak: '2007-10-09', trough: '2009-03-09' },
  { name: '2011 sell-off', market: 'stocks', peak: '2011-04-29', trough: '2011-10-03' },
  { name: '2015-16 sell-off', market: 'stocks', peak: '2015-05-21', trough: '2016-02-11' },
  { name: 'Late-2018 sell-off', market: 'stocks', peak: '2018-09-20', trough: '2018-12-24' },
  { name: 'Covid crash', market: 'stocks', peak: '2020-02-19', trough: '2020-03-23' },
  { name: '2022 bear market', market: 'stocks', peak: '2022-01-03', trough: '2022-10-12' },
  { name: '2025 sell-off', market: 'stocks', peak: '2025-02-19', trough: '2025-04-08' },
  { name: 'Bitcoin 2018', market: 'bitcoin', peak: '2017-12-16', trough: '2018-12-15' },
  { name: 'Bitcoin 2022', market: 'bitcoin', peak: '2021-11-08', trough: '2022-11-21' },
];

/** The falls of the stock market for every strategy, and Bitcoin's for one that trades on Binance. */
export function crisesFor(universe: AssetRef[]): Crisis[] {
  const coins = universe.some((a) => a.source === 'binance');
  return CRISES.filter((c) => c.market === 'stocks' || coins);
}

/** Whether, and when, the strategy was back at the highest value it had before the fall began. */
export type Recovery = { kind: 'held' } | { kind: 'back'; t: number } | { kind: 'not' };

export interface CrisisResult {
  crisis: Crisis;
  strategy: number;
  /** NaN when the benchmark's prices start after the fall's first day. */
  benchmark: number;
  worstDrawdown: number;
  /** The average exposure at the close of each step, and the net exposure for a run that has one. */
  exposure: number;
  netExposure?: number;
  recovery: Recovery;
}

function recovery(t: number[], equity: number[], start: number, end: number): Recovery {
  let high = -Infinity;
  for (let i = 0; i <= start; i++) high = Math.max(high, equity[i]);
  let below = start;
  while (below <= end && equity[below] >= high) below++;
  if (below > end) return { kind: 'held' };
  for (let i = below + 1; i < equity.length; i++) if (equity[i] >= high) return { kind: 'back', t: t[i] };
  return { kind: 'not' };
}

/**
 * The falls a run covers: those from a bar that had ended by the close of the peak day to a bar that had ended by the close of
 * the trough day, with the run reaching the trough day itself, so that nothing is measured from before the run began or
 * past its end. With weekly or hourly bars the figures are taken at the last bar that had ended by those closes, which is
 * the closing bar of a daily run. A fall that lies within one bar is left out.
 */
export function crisisResults(run: RunSeries, crises: Crisis[]): CrisisResult[] {
  const { t, equity, exposure, netExposure, benchmark } = run;
  const out: CrisisResult[] = [];
  for (const crisis of crises) {
    const [peak, trough] = [Date.parse(`${crisis.peak}T00:00:00Z`), Date.parse(`${crisis.trough}T00:00:00Z`)];
    const [start, end] = endedBy(t, [peak + DAY, trough + DAY]);
    // A run ruined before the crisis had stopped by then, as one that ended before it.
    if (start < 0 || end <= start || t[t.length - 1] < trough || !(equity[start] > 0)) continue;
    let top = equity[start];
    let worst = 0;
    let invested = 0;
    let net = 0;
    for (let i = start + 1; i <= end; i++) {
      top = Math.max(top, equity[i]);
      worst = Math.min(worst, equity[i] / top - 1);
      invested += exposure[i];
      if (netExposure) net += netExposure[i];
    }
    out.push({
      crisis,
      strategy: equity[end] / equity[start] - 1,
      benchmark: benchmark[end] / benchmark[start] - 1,
      worstDrawdown: worst,
      exposure: invested / (end - start),
      ...(netExposure ? { netExposure: net / (end - start) } : {}),
      recovery: recovery(t, equity, start, end),
    });
  }
  return out;
}
