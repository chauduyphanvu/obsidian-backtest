// "Was it luck?": three checks that try to make a lucky or over-fitted backtest look like one.

import { computeStats, maxDrawdown, type Backtest, type Stats } from './backtest.ts';
import { parseSpec } from './dsl.ts';
import { simulate, type RunResult, type SimParams, type Signals } from './engine.ts';
import { Evaluator, type BarRule } from './evaluate.ts';
import { makeRng, shuffle, type Rng } from './rng.ts';
import { baseSpec, grid, pause, quantile, runVariant, sweepLimit, sweepParams, valuesAt, type Metric, type Parse, type SweepParam } from './sweep.ts';
import type { Bars } from './types.ts';

const YEAR = 365.25 * 86_400_000;
const BATCH = 4;

export interface Spread {
  /** 5th percentile, median and 95th percentile: lo..hi holds the middle 90%. */
  lo: number;
  median: number;
  hi: number;
  /** Every outcome, ascending. */
  values: number[];
}

function spread(values: number[]): Spread {
  const s = [...values].sort((a, b) => a - b);
  return { lo: quantile(s, 0.05), median: quantile(s, 0.5), hi: quantile(s, 0.95), values: s };
}

/** About one month of the series' steps. */
export function monthOfBars(t: number[]): number {
  const years = (t[t.length - 1] - t[0]) / YEAR;
  return years > 0 ? Math.max(1, Math.round((t.length - 1) / years / 12)) : 1;
}

// ---------------------------------------------------------------- reshuffled history

export interface BootstrapResult {
  runs: number;
  blockBars: number;
  seed: number;
  cagr: Spread;
  maxDrawdown: Spread;
  /** Share of paths that end below where they started. */
  lossShare: number;
  actual: { cagr: number; maxDrawdown: number };
}

/**
 * Circular block bootstrap (Politis & Romano, 1992). The run's step returns are cut into blocks of
 * `blockBars` consecutive steps that start anywhere and wrap from the end to the start; each path
 * strings random blocks together until it is as long as the run. Blocks keep the short-term
 * streaks inside each month; anything slower than a block (a regime lasting years) is broken up.
 * The paths share the run's dates, so return per year is measured over the same span.
 */
export function bootstrap(t: number[], equity: number[], opts: { runs?: number; blockBars?: number; seed: number }): BootstrapResult {
  const n = equity.length - 1;
  if (n < 2) throw new Error('The run is too short to reshuffle.');
  const runs = opts.runs ?? 1000;
  const block = Math.min(n, Math.max(1, Math.round(opts.blockBars ?? monthOfBars(t))));
  const growth = new Float64Array(n);
  for (let i = 0; i < n; i++) growth[i] = equity[i + 1] / equity[i];
  const years = (t[n] - t[0]) / YEAR;
  const rng = makeRng(opts.seed);
  const cagr: number[] = [];
  const worst: number[] = [];
  let losses = 0;
  for (let r = 0; r < runs; r++) {
    let v = 1;
    let peak = 1;
    let dd = 0;
    for (let j = 0; j < n; ) {
      let at = rng.int(n);
      for (let k = 0; k < block && j < n; k++, j++) {
        v *= growth[at];
        at = at + 1 === n ? 0 : at + 1;
        if (v > peak) peak = v;
        else if (v / peak - 1 < dd) dd = v / peak - 1;
      }
    }
    cagr.push(v ** (1 / years) - 1);
    worst.push(dd);
    if (v < 1) losses++;
  }
  return {
    runs,
    blockBars: block,
    seed: opts.seed,
    cagr: spread(cagr),
    maxDrawdown: spread(worst),
    lossShare: losses / runs,
    actual: { cagr: (equity[n] / equity[0]) ** (1 / years) - 1, maxDrawdown: maxDrawdown(equity) },
  };
}

// ---------------------------------------------------------------- random entries

/** Bar indices of a position's entry and exit fills. */
export interface Holding {
  entry: number;
  exit: number;
}

/** Return per year over the worst drawdown's size. */
export function returnOverDrawdown(s: Pick<Stats, 'cagr' | 'maxDrawdown'>): number {
  if (s.maxDrawdown < 0) return s.cagr / -s.maxDrawdown;
  return s.cagr > 0 ? Infinity : s.cagr < 0 ? -Infinity : 0;
}

function lowerBound(t: number[], x: number): number {
  let a = 0;
  let b = t.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (t[m] < x) a = m + 1;
    else b = m;
  }
  return a;
}

/** The asset's bars inside the run: `first` is the first bar a signal can be read on, `last` the last bar. */
function barsInRun(bars: Bars, run: RunResult): { first: number; last: number } {
  return { first: lowerBound(bars.t, run.t[0]), last: lowerBound(bars.t, run.t[run.t.length - 1] + 1) - 1 };
}

/** k distinct whole numbers from [0, n), by Floyd's algorithm. */
function sampleDistinct(n: number, k: number, rng: Rng): number[] {
  const picked = new Set<number>();
  for (let j = n - k; j < n; j++) {
    const r = rng.int(j + 1);
    picked.add(picked.has(r) ? j : r);
  }
  return [...picked];
}

/**
 * Places holdings of the given lengths (bars from entry fill to exit fill) at random between the
 * fill bars `first` and `last`, without overlap. A holding of L bars takes L + 1 bars: the engine
 * can't sell and buy the same ticker on one open, so the next entry comes a bar after an exit.
 * Every arrangement of the holdings and the empty bars between them is equally likely.
 * A 0-bar holding (stopped out on its entry bar) becomes 1 bar: an exit by signal fills a bar later.
 * That can overfill a ticker that was in the market almost without a break; the longest holdings
 * then give back a bar each until they fit.
 */
export function placeHoldings(lengths: number[], first: number, last: number, rng: Rng): Holding[] {
  const order = shuffle(lengths.map((l) => Math.max(1, l)), rng);
  let free = last - first + 1 - order.reduce((s, l) => s + l + 1, 0);
  while (free < 0) {
    const k = order.indexOf(Math.max(...order));
    if (order[k] <= 1) throw new Error('The holdings do not fit in the run');
    order[k]--;
    free++;
  }
  const slots = sampleDistinct(free + order.length, order.length, rng).sort((a, b) => a - b);
  let used = 0;
  return slots.map((slot, j) => {
    const entry = first + slot - j + used;
    used += order[j] + 1;
    return { entry, exit: entry + order[j] };
  });
}

/** Buy at the close before each entry and sell at the close before each exit, so both fill at those opens. */
function holdingSignals(bars: Bars, holdings: Holding[]): Signals {
  const buy = new Array<number>(bars.t.length).fill(0);
  const sell = new Array<number>(bars.t.length).fill(0);
  for (const h of holdings) {
    buy[h.entry - 1] = 1;
    sell[h.exit - 1] = 1;
  }
  return { buy, sell: (i) => sell[i], score: null };
}

/** Random timing: each ticker keeps its number of trades and their holding lengths, placed at random. */
export function randomTiming(bt: Backtest, rng: Rng): { holdings: Map<string, Holding[]>; run: RunResult } {
  const holdings = new Map<string, Holding[]>();
  for (const a of bt.spec.universe) {
    const { first, last } = barsInRun(bt.data.get(a.name)!, bt.run);
    const lengths = bt.run.trades.filter((t) => t.asset === a.name).map((t) => t.bars);
    holdings.set(a.name, placeHoldings(lengths, first + 1, last, rng));
  }
  const s = bt.spec;
  // The strategy's own setup with its stops off and no ranking: the placed holdings decide everything.
  const params: SimParams = { assets: s.universe, from: s.from, to: s.to, capital: s.capital, costBps: s.costBps, slippageBps: s.slippageBps, rebalance: s.rebalance, stops: {}, cash: s.cash, sizing: s.sizing, rank: null };
  const signals = new Map(s.universe.map((a) => [a.name, holdingSignals(bt.data.get(a.name)!, holdings.get(a.name)!)]));
  return { holdings, run: simulate(params, bt.data, signals) };
}

/** The ranking strategy's own buy and sell rules per ticker, which decide what it may hold. */
export type PickRules = Map<string, { buy: number[]; sell: BarRule | null }>;

export function pickRules(bt: Backtest): PickRules {
  const ev = new Evaluator(bt.data);
  return new Map(
    bt.spec.universe.map((a) => {
      const rule = bt.spec.rules[a.name];
      return [a.name, { buy: ev.eval(rule.buy, a.name), sell: rule.sell ? ev.compile(rule.sell, a.name) : null }];
    }),
  );
}

/** A random score that keeps its value from bar to bar and is drawn afresh with chance `redraw` at each bar. */
function stickyScores(n: number, redraw: number, rng: Rng): number[] {
  const out = new Array<number>(n);
  let v = rng.next();
  for (let i = 0; i < n; i++) {
    if (i > 0 && rng.next() < redraw) v = rng.next();
    out[i] = v;
  }
  return out;
}

/**
 * Random picks for a ranking strategy: the same run in every way (rules, decision bars, top N,
 * stops, sizing, costs) except that the score ranking the tickers is random. A ticker's random
 * score is kept from bar to bar and redrawn with chance `redraw` per bar, so the picks can be
 * made to change about as often as the strategy's do.
 */
export function randomPicks(bt: Backtest, rng: Rng, redraw: number, rules: PickRules = pickRules(bt)): RunResult {
  const signals = new Map<string, Signals>(
    bt.spec.universe.map((a) => [a.name, { ...rules.get(a.name)!, score: stickyScores(bt.data.get(a.name)!.t.length, redraw, rng) }]),
  );
  return simulate({ ...bt.spec, assets: bt.spec.universe }, bt.data, signals);
}

/** Chances per bar of a new random score, from a draw every bar to about one a year of daily bars. */
const REDRAW = [1, 0.3, 0.1, 0.03, 0.01, 0.003];
const PILOTS = 3;

/** The redraw chance whose random picks trade most nearly as often as the strategy, so costs weigh the same on both. */
export async function matchTurnover(bt: Backtest, rules: PickRules, seed: number): Promise<number> {
  const rng = makeRng(seed ^ 0x2545f491);
  const want = bt.run.trades.length;
  let best = REDRAW[0];
  let gap = Infinity;
  for (const redraw of REDRAW) {
    let trades = 0;
    for (let k = 0; k < PILOTS; k++) trades += randomPicks(bt, rng, redraw, rules).trades.length;
    const g = Math.abs(Math.log((trades / PILOTS + 1) / (want + 1)));
    if (g < gap) [best, gap] = [redraw, g];
    await pause();
  }
  return best;
}

export interface RandomEntriesResult {
  /** timing: the strategy's holdings at random dates per ticker. picks: a ranking's tickers picked at random. */
  mode: 'timing' | 'picks';
  /** Why the check did not run: no trades, a ranking that holds every ticker, or no room to move the trades. */
  skip: 'no-trades' | 'holds-everything' | 'always-invested' | null;
  /** Random variants run. */
  runs: number;
  seed: number;
  stopped: boolean;
  strategy: { cagr: number; maxDrawdown: number; ratio: number; trades: number };
  random: { cagr: number[]; maxDrawdown: number[]; ratio: number[]; trades: number[] };
  /** Random variants that did at least as well as the strategy: ties count against it. */
  atLeast: { cagr: number; ratio: number };
  /** Share of the run the strategy spends in its tickers, averaged over them. Near 1, random timing is close to buy and hold. */
  invested: number;
  /** picks: the chance per bar that a ticker's random score is drawn again; null for timing. */
  redraw: number | null;
}

/**
 * How often random entries do as well as the strategy, through the same engine. Timing mode keeps
 * each ticker's trade count and holding lengths and places them at random, with the same weights,
 * sizing, costs, slippage and cash rate, and stops off (the holding lengths already carry their
 * effect). A ranking strategy gets random picks instead. Default 200 variants.
 */
export async function randomEntries(
  backtest: Backtest,
  opts: { runs?: number; seed: number; onProgress?: (done: number, total: number) => void; shouldStop?: () => boolean },
): Promise<RandomEntriesResult> {
  const bt = backtest;
  const total = opts.runs ?? 200;
  const mode = bt.spec.rank ? 'picks' : 'timing';
  const trades = bt.run.trades;
  const spans = bt.spec.universe.map((a) => ({ name: a.name, ...barsInRun(bt.data.get(a.name)!, bt.run) }));
  const held = trades.reduce((s, t) => s + Math.max(1, t.bars), 0);
  const room = spans.reduce((s, x) => s + x.last - x.first, 0);
  const result: RandomEntriesResult = {
    mode,
    skip: null,
    runs: 0,
    seed: opts.seed,
    stopped: false,
    strategy: { cagr: bt.stats.cagr, maxDrawdown: bt.stats.maxDrawdown, ratio: returnOverDrawdown(bt.stats), trades: trades.length },
    random: { cagr: [], maxDrawdown: [], ratio: [], trades: [] },
    atLeast: { cagr: 0, ratio: 0 },
    invested: room > 0 ? held / room : NaN,
    redraw: null,
  };
  if (trades.length === 0) return { ...result, skip: 'no-trades' };
  if (mode === 'picks' && bt.spec.rank!.top >= bt.spec.universe.length) return { ...result, skip: 'holds-everything' };
  if (mode === 'timing') {
    const slack = spans.map((x) => x.last - x.first - trades.filter((t) => t.asset === x.name).reduce((s, t) => s + Math.max(1, t.bars) + 1, 0));
    if (slack.every((s) => s <= 0)) return { ...result, skip: 'always-invested' };
  }

  const rng = makeRng(opts.seed);
  const rules = mode === 'picks' ? pickRules(bt) : null;
  if (rules) result.redraw = await matchTurnover(bt, rules, opts.seed);
  for (let k = 0; k < total; k++) {
    if (opts.shouldStop?.()) {
      result.stopped = true;
      break;
    }
    const run = rules ? randomPicks(bt, rng, result.redraw!, rules) : randomTiming(bt, rng).run;
    const s = computeStats(run.t, run.equity, bt.spec.capital, run.exposure, run.cashReturn);
    const ratio = returnOverDrawdown(s);
    result.random.cagr.push(s.cagr);
    result.random.maxDrawdown.push(s.maxDrawdown);
    result.random.ratio.push(ratio);
    result.random.trades.push(run.trades.length);
    if (s.cagr >= result.strategy.cagr) result.atLeast.cagr++;
    if (ratio >= result.strategy.ratio) result.atLeast.ratio++;
    result.runs++;
    opts.onProgress?.(result.runs, total);
    if (result.runs % BATCH === 0 && result.runs < total) await pause();
  }
  return result;
}

// ---------------------------------------------------------------- walk-forward

/** Training and testing lengths in months, from the longest that leaves at least three test stretches. */
const PLANS: [number, number][] = [
  [48, 12],
  [36, 12],
  [24, 12],
  [24, 6],
  [12, 6],
  [12, 3],
];

const years = (months: number) => {
  const y = months / 12;
  return `${Number(y.toFixed(2))} year${y === 1 ? '' : 's'}`;
};

/** Chooses the training and testing lengths, or explains why the history is too short. */
export function walkPlan(t: number[], trainYears?: number, testYears?: number): { trainMonths: number; testMonths: number } {
  const span = ((t[t.length - 1] - t[0]) / YEAR) * 12;
  const covers = `This run covers ${(span / 12).toFixed(1)} years.`;
  // A week's grace, so 2015-01-01 to 2019-12-31 counts as five years.
  const fits = (months: number) => span + 0.25 >= months;
  if (trainYears !== undefined || testYears !== undefined) {
    const train = Math.max(1, Math.round((trainYears ?? 4) * 12));
    const test = Math.max(1, Math.round((testYears ?? 1) * 12));
    if (!fits(train + test)) throw new Error(`Training on ${years(train)} and testing on the next ${years(test)} needs at least ${years(train + test)} of prices. ${covers}`);
    return { trainMonths: train, testMonths: test };
  }
  const plan = PLANS.find(([train, test]) => fits(train + 3 * test));
  if (!plan) throw new Error(`Walk-forward needs about two years of prices or more: it picks values on one stretch, tests them on the next, and repeats. ${covers}`);
  return { trainMonths: plan[0], testMonths: plan[1] };
}

function addMonths(t: number, months: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
}

/**
 * Rolling windows: train on `trainMonths`, test on the following `testMonths`, then move on by the
 * test length, so the test stretches follow one another without gaps. Index ranges are inclusive.
 * A last test stretch shorter than a quarter of the test length is left out.
 */
export function walkWindows(t: number[], trainMonths: number, testMonths: number): { train: [number, number]; test: [number, number] }[] {
  const out: { train: [number, number]; test: [number, number] }[] = [];
  const end = t[t.length - 1];
  for (let k = 0; ; k++) {
    const trainStart = addMonths(t[0], k * testMonths);
    const testStart = addMonths(t[0], k * testMonths + trainMonths);
    const testEnd = addMonths(t[0], (k + 1) * testMonths + trainMonths);
    if (testStart > end) break;
    if (end - testStart < 0.25 * (testEnd - testStart)) break;
    const i0 = lowerBound(t, trainStart);
    const j0 = lowerBound(t, testStart);
    const j1 = lowerBound(t, testEnd) - 1;
    if (j1 < j0 || j0 - i0 < 2) break;
    out.push({ train: [i0, j0 - 1], test: [j0, j1] });
  }
  return out;
}

function windowScore(run: RunResult, [a, b]: [number, number], metric: Metric): number {
  const slice = (xs: number[]) => xs.slice(a, b + 1);
  const v = computeStats(slice(run.t), slice(run.equity), run.equity[a], slice(run.exposure), slice(run.cashReturn))[metric];
  return Number.isFinite(v) ? v : NaN;
}

export interface WalkWindow {
  trainFrom: number;
  trainTo: number;
  testFrom: number;
  testTo: number;
  /** The variant that scored best on the training stretch. */
  chosen: Record<string, number>;
  trainScore: number;
  /** Total return of the chosen variant over the test stretch. */
  testReturn: number;
  /** Total return of the values in the note over the same stretch. */
  declaredReturn: number;
}

export interface WalkLine {
  equity: number[];
  stats: Stats;
}

export interface WalkForwardResult {
  metric: Metric;
  trainMonths: number;
  testMonths: number;
  params: SweepParam[];
  /** Variants that ran and traded; `failed` could not run, `idle` never traded (cash, so never a pick). */
  variants: number;
  failed: number;
  idle: number;
  windows: WalkWindow[];
  /** From the last bar of the first training stretch to the end of the last test stretch. */
  t: number[];
  /** The test stretches stitched together, starting at the strategy's capital. */
  equity: number[];
  stats: Stats;
  /** The values in the note, over the same dates. */
  declared: WalkLine;
  /** The variant that did best over the whole run, picked with hindsight, over the same dates. */
  hindsight: WalkLine & { values: Record<string, number> };
  /** Test stretches whose pick differs from the one before. */
  changes: number;
}

/**
 * Walk-forward: on each training stretch pick the variant that scored best there, then follow that
 * variant over the next test stretch, which the pick never saw. Every variant runs once over the
 * whole history, so indicators are warm from earlier bars and positions carry across boundaries,
 * but a pick only reads results up to the last bar of its training stretch. Null when stopped.
 */
export async function walkForward(
  source: string,
  data: Map<string, Bars>,
  opts: {
    parse?: Parse;
    metric?: Metric;
    trainYears?: number;
    testYears?: number;
    maxRuns?: number;
    onProgress?: (done: number, total: number) => void;
    shouldStop?: () => boolean;
  } = {},
): Promise<WalkForwardResult | null> {
  const parse = opts.parse ?? ((overrides) => parseSpec(source, { overrides }));
  const metric = opts.metric ?? 'cagr';
  const spec = baseSpec(parse);
  const params = sweepParams(spec);
  if (params.length === 0) throw new Error('Walk-forward needs a parameter with a range to choose from, such as fast = 50 in 20..100 step 10.');
  const total = params.reduce((n, p) => n * p.values.length, 1);
  const refusal = sweepLimit(total, opts.maxRuns);
  if (refusal) throw new Error(refusal);

  const key = (index: number[]) => index.join(',');
  const declaredIndex = params.map((p) => p.values.indexOf(p.declared));
  const declared = runVariant(parse, data, valuesAt(params, declaredIndex), declaredIndex);
  if (!declared.backtest) throw new Error(declared.point.error ?? 'The values in the note did not run');
  const t = declared.backtest.run.t;
  const plan = walkPlan(t, opts.trainYears, opts.testYears);
  const windows = walkWindows(t, plan.trainMonths, plan.testMonths);
  if (windows.length === 0) throw new Error('The history is too short for one training and one test stretch.');

  // Pass 1: score every variant on every training stretch, and on the whole run for the hindsight pick.
  const estimate = total + Math.min(total, windows.length + 1);
  let done = 0;
  const scored: { index: number[]; train: number[]; whole: number }[] = [];
  let idle = 0;
  for (const index of grid(params)) {
    if (opts.shouldStop?.()) return null;
    const { backtest } = runVariant(parse, data, valuesAt(params, index), index);
    const run = backtest?.run;
    if (run && run.trades.length === 0) idle++;
    else if (run && run.t.length === t.length && run.t[0] === t[0] && run.t[t.length - 1] === t[t.length - 1]) {
      const whole = backtest.stats[metric];
      scored.push({ index, train: windows.map((w) => windowScore(run, w.train, metric)), whole: Number.isFinite(whole) ? whole : NaN });
    }
    opts.onProgress?.(++done, estimate);
    if (done % BATCH === 0) await pause();
  }

  // The first best wins a tie, so the order of the grid decides, not the values in the note.
  const bestBy = (score: (s: (typeof scored)[number]) => number) => {
    let best: (typeof scored)[number] | null = null;
    for (const s of scored) if (!Number.isNaN(score(s)) && (!best || score(s) > score(best))) best = s;
    return best;
  };
  const picks = windows.map((_, k) => bestBy((s) => s.train[k]));
  const hindsight = bestBy((s) => s.whole) ?? { index: declaredIndex, train: [], whole: NaN };

  // Pass 2: run the picked variants again for their equity lines; only a handful differ.
  const runs = new Map<string, RunResult>([[key(declaredIndex), declared.backtest.run]]);
  for (const index of [...picks.map((p) => p?.index ?? declaredIndex), hindsight.index]) {
    if (runs.has(key(index))) continue;
    if (opts.shouldStop?.()) return null;
    runs.set(key(index), runVariant(parse, data, valuesAt(params, index), index).backtest!.run);
    opts.onProgress?.(++done, estimate);
  }
  opts.onProgress?.(estimate, estimate);

  const pickIndex = (k: number) => picks[k]?.index ?? declaredIndex;
  const start = windows[0].test[0] - 1;
  const end = windows[windows.length - 1].test[1];
  const tt = t.slice(start, end + 1);
  const cash = declared.backtest.run.cashReturn.slice(start, end + 1);
  const capital = spec.capital;
  const stitch = (runFor: (k: number) => RunResult): WalkLine => {
    const equity = [capital];
    const exposure = [runFor(0).exposure[start]];
    windows.forEach((w, k) => {
      const r = runFor(k);
      for (let i = w.test[0]; i <= w.test[1]; i++) {
        equity.push((equity[equity.length - 1] * r.equity[i]) / r.equity[i - 1]);
        exposure.push(r.exposure[i]);
      }
    });
    return { equity, stats: computeStats(tt, equity, capital, exposure, cash) };
  };
  const walked = stitch((k) => runs.get(key(pickIndex(k)))!);
  const growth = (r: RunResult, w: (typeof windows)[number]) => r.equity[w.test[1]] / r.equity[w.test[0] - 1] - 1;

  return {
    metric,
    ...plan,
    params,
    variants: scored.length,
    failed: total - scored.length - idle,
    idle,
    windows: windows.map((w, k) => ({
      trainFrom: t[w.train[0]],
      trainTo: t[w.train[1]],
      testFrom: t[w.test[0]],
      testTo: t[w.test[1]],
      chosen: valuesAt(params, pickIndex(k)),
      trainScore: picks[k]?.train[k] ?? NaN,
      testReturn: growth(runs.get(key(pickIndex(k)))!, w),
      declaredReturn: growth(declared.backtest!.run, w),
    })),
    t: tt,
    equity: walked.equity,
    stats: walked.stats,
    declared: stitch(() => declared.backtest!.run),
    hindsight: { ...stitch(() => runs.get(key(hindsight.index))!), values: valuesAt(params, hindsight.index) },
    changes: picks.filter((p, k) => k > 0 && key(p?.index ?? declaredIndex) !== key(pickIndex(k - 1))).length,
  };
}
