// Parameter sweeps: run every combination of the ranges declared in a block, and read the result honestly.

import { runBacktest, type Backtest, type Stats } from './backtest.ts';
import { paramValues, parseSpec, type ParseResult, type Spec } from './dsl.ts';
import type { Bars } from './types.ts';

export type Metric = 'cagr' | 'sharpe' | 'sortino' | 'maxDrawdown' | 'totalReturn';
/** Which part of a run with `test from` to read: all of it, the part before, or the part from it on. */
export type Period = 'all' | 'before' | 'after';

/** Every metric reads "higher is better"; drawdowns are negative, so a smaller loss is higher. `noun` is the label inside a sentence. */
export const METRICS: Record<Metric, { label: string; noun: string; percent: boolean; explain: string }> = {
  cagr: { label: 'Return per year', noun: 'return per year', percent: true, explain: 'the average yearly growth, compounded' },
  totalReturn: { label: 'Total return', noun: 'total return', percent: true, explain: 'the gain over the whole run' },
  maxDrawdown: { label: 'Worst drawdown', noun: 'worst drawdown', percent: true, explain: 'the deepest fall from a previous high; closer to 0 is better' },
  sharpe: { label: 'Sharpe ratio', noun: 'Sharpe ratio', percent: false, explain: 'return above cash for each unit of ups and downs; higher is steadier' },
  sortino: { label: 'Sortino ratio', noun: 'Sortino ratio', percent: false, explain: 'like Sharpe, but only falls count as risk' },
};

export const MAX_RUNS = 2000;
/** Backtests between pauses that let the note repaint and the Stop button work. */
const BATCH = 4;

export type Parse = (overrides: Record<string, number>) => ParseResult;

export interface SweepParam {
  name: string;
  percent: boolean;
  /** Ascending; the declared value is always one of them. */
  values: number[];
  declared: number;
}

export interface SweepPoint {
  /** The swept parameters' values; the others stay as declared. */
  values: Record<string, number>;
  /** Position in each parameter's `values`, in `SweepResult.params` order. */
  index: number[];
  stats: Stats | null;
  /** The parts before and from `test from`; null when it is not set. */
  before: Stats | null;
  after: Stats | null;
  trades: number;
  error: string | null;
}

export interface SweepResult {
  params: SweepParam[];
  points: SweepPoint[];
  /** Variants run; fewer than the grid when stopped. */
  tried: number;
  total: number;
  stopped: boolean;
}

export const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const tidy = (x: number) => Number(x.toPrecision(12));

/** The parameters with a range, each with the values to try. A declared value off the step grid is tried too. */
export function sweepParams(spec: Spec): SweepParam[] {
  return spec.params
    .filter((p) => p.range !== null)
    .map((p) => ({
      name: p.name,
      percent: p.percent,
      values: [...new Set([...paramValues(p), p.declared].map(tidy))].sort((a, b) => a - b),
      declared: tidy(p.declared),
    }));
}

/** Number of variants the declared ranges produce (1 when nothing has a range). */
export function sweepSize(spec: Spec): number {
  return sweepParams(spec).reduce((n, p) => n * p.values.length, 1);
}

/** Why a sweep of `size` variants can't run, or null when it can. */
export function sweepLimit(size: number, maxRuns = MAX_RUNS): string | null {
  if (size <= maxRuns) return null;
  return `The ranges give ${size.toLocaleString('en-US')} variants, and the most this runs at once is ${maxRuns.toLocaleString('en-US')}. Use a larger step or a narrower range.`;
}

/** Every combination of indices, the last parameter changing fastest. */
export function* grid(params: SweepParam[]): Generator<number[]> {
  const total = params.reduce((n, p) => n * p.values.length, 1);
  for (let k = 0; k < total; k++) {
    const index = new Array<number>(params.length);
    let rest = k;
    for (let d = params.length - 1; d >= 0; d--) {
      index[d] = rest % params[d].values.length;
      rest = Math.floor(rest / params[d].values.length);
    }
    yield index;
  }
}

export function valuesAt(params: SweepParam[], index: number[]): Record<string, number> {
  return Object.fromEntries(params.map((p, d) => [p.name, p.values[index[d]]]));
}

/** One variant: parsed with the overrides and run on the same prices. Problems are recorded, not thrown. */
export function runVariant(parse: Parse, data: Map<string, Bars>, values: Record<string, number>, index: number[]): { point: SweepPoint; backtest: Backtest | null } {
  const point: SweepPoint = { values, index, stats: null, before: null, after: null, trades: 0, error: null };
  const parsed = parse(values);
  if (!parsed.spec) {
    point.error = parsed.errors[0]?.message ?? 'These values make the block invalid';
    return { point, backtest: null };
  }
  try {
    const bt = runBacktest(parsed.spec, data);
    point.stats = bt.stats;
    point.before = bt.segments?.[0].stats ?? null;
    point.after = bt.segments?.[1].stats ?? null;
    point.trades = bt.run.trades.length;
    return { point, backtest: bt };
  } catch (e) {
    point.error = e instanceof Error ? e.message : String(e);
    return { point, backtest: null };
  }
}

export function baseSpec(parse: Parse): Spec {
  const base = parse({});
  if (!base.spec) throw new Error(`The block has errors: ${base.errors.map((e) => e.message).join('; ')}`);
  return base.spec;
}

/**
 * `onProgress` also gets the result so far, which grows as the sweep runs. `pause` lets other work in between batches;
 * a worker passes one that costs nothing.
 */
export async function runSweep(
  source: string,
  data: Map<string, Bars>,
  opts: {
    parse?: Parse;
    maxRuns?: number;
    onProgress?: (done: number, total: number, sofar: SweepResult) => void;
    shouldStop?: () => boolean;
    pause?: () => Promise<void>;
  } = {},
): Promise<SweepResult> {
  const parse = opts.parse ?? ((overrides) => parseSpec(source, { overrides }));
  const wait = opts.pause ?? pause;
  const params = sweepParams(baseSpec(parse));
  const total = params.reduce((n, p) => n * p.values.length, 1);
  const refusal = sweepLimit(total, opts.maxRuns);
  if (refusal) throw new Error(refusal);
  const result: SweepResult = { params, points: [], tried: 0, total, stopped: false };
  for (const index of grid(params)) {
    if (opts.shouldStop?.()) {
      result.stopped = true;
      break;
    }
    result.points.push(runVariant(parse, data, valuesAt(params, index), index).point);
    result.tried = result.points.length;
    opts.onProgress?.(result.tried, total, result);
    if (result.tried % BATCH === 0 && result.tried < total) await wait();
  }
  return result;
}

/** The metric for one part of a variant's run; NaN when it has none. */
export function metricOf(p: SweepPoint, metric: Metric, period: Period = 'all'): number {
  const s = period === 'all' ? p.stats : period === 'before' ? p.before : p.after;
  const v = s?.[metric];
  return v !== undefined && Number.isFinite(v) ? v : NaN;
}

/** Linear interpolation between the closest ranks of a sorted list. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  return pos === lo ? sorted[lo] : sorted[lo] + (sorted[lo + 1] - sorted[lo]) * (pos - lo);
}

function median(xs: number[]): number {
  return quantile([...xs].sort((a, b) => a - b), 0.5);
}

/**
 * Variants with a result for the metric and period, best first; ties keep grid order. A variant
 * that never trades is cash, not a version of the strategy, so it is left out: otherwise it would
 * "win" on drawdown with values that do nothing.
 */
function ranked(result: SweepResult, metric: Metric, period: Period = 'all'): SweepPoint[] {
  return result.points.filter((p) => p.trades > 0 && !Number.isNaN(metricOf(p, metric, period))).sort((a, b) => metricOf(b, metric, period) - metricOf(a, metric, period));
}

export function isDeclared(result: SweepResult, p: SweepPoint): boolean {
  return result.params.every((q, d) => q.values[p.index[d]] === q.declared);
}

/** 1 for the best; tied variants share the better rank. */
function rankOf(list: SweepPoint[], value: number, metric: Metric, period: Period): number {
  return 1 + list.filter((p) => metricOf(p, metric, period) > value).length;
}

export interface Neighbours {
  /** The best variant's neighbours on the grid (one step along one parameter) that have a result. */
  points: SweepPoint[];
  median: number;
  worst: number;
  /**
   * The share of the best variant's lead over the bottom quarter of variants (their 25th
   * percentile) that its neighbours keep: 1 means they do as well as the best, 0 means they sit
   * down with the weakest variants. The bottom quarter, not the worst, so one broken variant
   * can't make every neighbour look close.
   */
  kept: number;
  /** plateau: they keep at least 2/3 of the lead. spike: less than 1/3. flat: the best is no better than the bottom quarter. none: no neighbours with a result. */
  verdict: 'plateau' | 'mixed' | 'spike' | 'flat' | 'none';
}

export interface SweepSummary {
  metric: Metric;
  period: Period;
  /** Variants with a result, best first. */
  ranked: SweepPoint[];
  /** Variants that could not run or have no value for this metric. */
  failed: number;
  /** Variants that ran but never traded, left out of the ranking. */
  idle: number;
  best: SweepPoint;
  declared: SweepPoint | null;
  median: number;
  /** Where the values in the note rank, 1 = best; null when they have no result. */
  declaredRank: number | null;
  /** Share of variants that beat the benchmark on this metric, when one is given. */
  shareBeatingBenchmark?: number;
  neighbours: Neighbours;
}

/** The honest reading of a sweep for one metric. Null when no variant has a result. */
export function summarize(result: SweepResult, metric: Metric, opts: { period?: Period; benchmark?: Stats } = {}): SweepSummary | null {
  const period = opts.period ?? 'all';
  const list = ranked(result, metric, period);
  if (list.length === 0) return null;
  const idle = result.points.filter((p) => p.error === null && p.trades === 0).length;
  const value = (p: SweepPoint) => metricOf(p, metric, period);
  const best = list[0];
  const mid = median(list.map(value));
  const declared = result.points.find((p) => isDeclared(result, p)) ?? null;
  const declaredValue = declared && declared.trades > 0 ? value(declared) : NaN;

  const byKey = new Map(result.points.map((p) => [p.index.join(','), p]));
  const near: SweepPoint[] = [];
  best.index.forEach((i, d) => {
    for (const step of [-1, 1]) {
      const index = [...best.index];
      index[d] = i + step;
      const p = byKey.get(index.join(','));
      if (p && p.trades > 0 && !Number.isNaN(value(p))) near.push(p);
    }
  });
  const nearMedian = median(near.map(value));
  const lead = value(best) - quantile(list.map(value).reverse(), 0.25);
  const kept = near.length === 0 ? NaN : lead > 0 ? 1 - (value(best) - nearMedian) / lead : 1;
  const verdict: Neighbours['verdict'] = near.length === 0 ? 'none' : !(lead > 0) ? 'flat' : kept >= 2 / 3 ? 'plateau' : kept >= 1 / 3 ? 'mixed' : 'spike';

  const bench = opts.benchmark?.[metric];
  return {
    metric,
    period,
    ranked: list,
    failed: result.points.length - list.length - idle,
    idle,
    best,
    declared,
    median: mid,
    declaredRank: Number.isNaN(declaredValue) ? null : rankOf(list, declaredValue, metric, period),
    ...(bench !== undefined && Number.isFinite(bench) ? { shareBeatingBenchmark: list.filter((p) => value(p) > bench).length / list.length } : {}),
    neighbours: { points: near, median: nearMedian, worst: near.length ? Math.min(...near.map(value)) : NaN, kept, verdict },
  };
}

export interface SplitSummary {
  /** The variant that did best before `test from`: what someone tuning on that part alone would have picked. */
  chosen: SweepPoint;
  chosenBefore: number;
  chosenAfter: number;
  /** Where the pick ranks after the split among every variant with a result there, 1 = best. */
  chosenAfterRank: number;
  /** The values in the note; NaN when they have no result. */
  declaredBefore: number;
  declaredAfter: number;
  medianAfter: number;
  /** Variants that traded and have a result in both parts. */
  count: number;
}

/** Picks the best variant on the part before `test from` only, and reports what it did after. Null without a split. */
export function splitSummary(result: SweepResult, metric: Metric): SplitSummary | null {
  const both = result.points.filter((p) => p.trades > 0 && !Number.isNaN(metricOf(p, metric, 'before')) && !Number.isNaN(metricOf(p, metric, 'after')));
  if (both.length === 0) return null;
  let chosen = both[0];
  for (const p of both) if (metricOf(p, metric, 'before') > metricOf(chosen, metric, 'before')) chosen = p;
  const declared = result.points.find((p) => isDeclared(result, p));
  const chosenAfter = metricOf(chosen, metric, 'after');
  return {
    chosen,
    chosenBefore: metricOf(chosen, metric, 'before'),
    chosenAfter,
    chosenAfterRank: rankOf(both, chosenAfter, metric, 'after'),
    declaredBefore: declared ? metricOf(declared, metric, 'before') : NaN,
    declaredAfter: declared ? metricOf(declared, metric, 'after') : NaN,
    medianAfter: median(both.map((p) => metricOf(p, metric, 'after'))),
    count: both.length,
  };
}
