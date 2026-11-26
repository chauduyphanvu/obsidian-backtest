// Always-On Adversarial Stress Envelope: passively perturbs a strategy across 4 orthogonal real-world failure axes
// (AST literal jitter ±15%, execution friction/adverse fills, timing delay/rebalance phase shifts, and outlier removal)
// to render an epistemic fragility fan and breaking-point summary instead of a single knife-edge equity curve.
// Pure; runs in the background worker reusing priceMemo indicator buffers.

import { computeStats, specSignals, type Backtest } from './backtest.ts';
import { extractLiteralSites, parseSpec, type Defaults, type LiteralSite, type Spec } from './dsl.ts';
import { simulate, type SimStressHooks } from './engine.ts';
import { priceMemo } from './price-memo.ts';
import { makeRng } from './rng.ts';
import type { Bars } from './types.ts';

export type StressAxis = 'params' | 'friction' | 'timing' | 'outliers';

export interface StressPath {
  axis: StressAxis;
  label: string;
  /** Equity normalized to base starting capital, decimated onto `StressReport.t`. */
  equity: number[];
  sharpe: number;
  cagr: number;
  maxDrawdown: number;
}

export interface Envelope {
  p10: number[];
  p50: number[];
  p90: number[];
}

export interface BreakingPoints {
  /** Estimated friction (bps per side) where Sharpe crosses 0; Infinity if still positive above 100 bps. */
  breakevenBps: number;
  /** Fraction of ±15% literal-jitter neighbors with Sharpe > 0 (1 when no numeric literals exist). */
  neighborSurvivalRate: number;
  /** Sharpe ratio with the strategy's single best calendar year removed. */
  exBestYearSharpe: number;
  /** Sharpe ratio under +1 bar execution delay. */
  delayedSharpe: number;
  /** True when that axis collapses performance (cuts Sharpe > 40% or turns it <= 0). */
  axisCollapse: Record<StressAxis, boolean>;
  grade: 'robust' | 'sensitive' | 'fragile';
}

export interface StressReport {
  /** Decimated timestamps (up to MAX_POINTS) aligned with `envelopes` and `paths`. */
  t: number[];
  envelopes: Record<StressAxis | 'all', Envelope>;
  paths: StressPath[];
  breakingPoints: BreakingPoints;
  elapsedMs: number;
}

const MAX_POINTS = 360;
const PARAM_PATHS = 12;

/** Builds decimation indices across `[0, n - 1]` preserving start and end points. */
function sampleIndices(n: number, maxPts = MAX_POINTS): number[] {
  if (n <= maxPts) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let k = 0; k < maxPts; k++) out.push(Math.round((k * (n - 1)) / (maxPts - 1)));
  return out;
}

/** Projects a path `(pt, peq)` onto `targetT` via last-known value; late-start paths anchor onto `baseDecimated` at `pt[0]`. */
function alignAndNormalize(pt: number[], peq: number[], targetT: number[], capital: number, baseDecimated?: number[]): number[] {
  const out = new Array<number>(targetT.length);
  const startEq = peq[0] > 0 ? peq[0] : capital;
  let anchor = capital;
  if (baseDecimated && pt.length > 0 && pt[0] > targetT[0]) {
    let ai = 0;
    while (ai + 1 < targetT.length && targetT[ai + 1] <= pt[0]) ai++;
    if (baseDecimated[ai] > 0) anchor = baseDecimated[ai];
  }
  const scale = anchor / startEq;
  let j = 0;
  for (let i = 0; i < targetT.length; i++) {
    const x = targetT[i];
    if (baseDecimated && pt.length > 0 && x < pt[0]) {
      out[i] = baseDecimated[i];
      continue;
    }
    while (j + 1 < pt.length && pt[j + 1] <= x) j++;
    out[i] = (pt[j] <= x ? peq[j] : peq[0]) * scale;
  }
  return out;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function buildEnvelope(paths: StressPath[], n: number, fallback: number[]): Envelope {
  if (paths.length === 0) return { p10: [...fallback], p50: [...fallback], p90: [...fallback] };
  const p10 = new Array<number>(n);
  const p50 = new Array<number>(n);
  const p90 = new Array<number>(n);
  const col = new Array<number>(paths.length);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < paths.length; k++) col[k] = paths[k].equity[i];
    col.sort((a, b) => a - b);
    p10[i] = quantile(col, 0.1);
    p50[i] = quantile(col, 0.5);
    p90[i] = quantile(col, 0.9);
  }
  return { p10, p50, p90 };
}

/** Simulates a spec variant (optionally reusing signals and stress hooks) and returns a compact StressPath. */
function runVariant(
  axis: StressAxis,
  label: string,
  spec: Spec,
  data: Map<string, Bars>,
  targetT: number[],
  capital: number,
  reusedSignals?: ReturnType<typeof specSignals>,
  stress?: SimStressHooks,
  baseDecimated?: number[],
): StressPath | null {
  try {
    const signals = reusedSignals ?? specSignals(spec, data);
    const run = simulate({ ...spec, assets: spec.universe, ...(stress ? { stress } : {}) }, data, signals);
    const stats = computeStats(run.t, run.equity, spec.capital, run.exposure, run.cashReturn, run.ruin ? run.t.indexOf(run.ruin.t) : undefined, run.netExposure);
    return {
      axis,
      label,
      equity: alignAndNormalize(run.t, run.equity, targetT, capital, baseDecimated),
      sharpe: Number.isFinite(stats.sharpe) ? stats.sharpe : 0,
      cagr: Number.isFinite(stats.cagr) ? stats.cagr : 0,
      maxDrawdown: Number.isFinite(stats.maxDrawdown) ? stats.maxDrawdown : 0,
    };
  } catch {
    return null;
  }
}

/** Builds a perturbed equity curve by zeroing out excess returns on masked steps (O(N), zero re-simulation). */
function outlierPath(label: string, bt: Backtest, dropStep: (i: number) => boolean, targetT: number[], capital: number): StressPath {
  const { t, equity, exposure, cashReturn, netExposure, ruin } = bt.run;
  const ruinIdx = ruin ? t.indexOf(ruin.t) : undefined;
  const eq = new Array<number>(equity.length);
  eq[0] = capital;
  for (let i = 1; i < equity.length; i++) {
    if (ruinIdx !== undefined && i >= ruinIdx) {
      eq[i] = 0;
      continue;
    }
    const r = dropStep(i) ? (cashReturn[i] ?? 0) : equity[i - 1] > 0 ? equity[i] / equity[i - 1] - 1 : 0;
    eq[i] = eq[i - 1] * (1 + r);
  }
  const stats = computeStats(t, eq, capital, exposure, cashReturn, ruinIdx, netExposure);
  return {
    axis: 'outliers',
    label,
    equity: alignAndNormalize(t, eq, targetT, capital),
    sharpe: Number.isFinite(stats.sharpe) ? stats.sharpe : 0,
    cagr: Number.isFinite(stats.cagr) ? stats.cagr : 0,
    maxDrawdown: Number.isFinite(stats.maxDrawdown) ? stats.maxDrawdown : 0,
  };
}

/** Generates ±15% perturbed literal overrides for one path without requiring declared parameter ranges. */
function jitterLiterals(sites: readonly LiteralSite[], rand: () => number, scale: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sites) {
    // Perturb by [-scale, +scale] relative to current value (minimum ±1 step for tiny integers).
    const delta = (rand() * 2 - 1) * scale;
    let next = s.value * (1 + delta);
    if (s.domain.integer) {
      next = Math.round(next);
      if (next === s.value && Math.abs(delta) > 0.04) next = s.value + (delta >= 0 ? 1 : -1);
    }
    out[s.id] = Math.min(s.domain.max, Math.max(s.domain.min, next));
  }
  return out;
}

/**
 * Runs the 32-path Adversarial Stress Battery across all 4 axes:
 * 1. `params` (12 paths): ±15% simultaneous jitter of every numeric literal in the AST.
 * 2. `friction` (6 paths): 2x/3x/+10/+25/+50 bps costs + 25% adverse intrabar fill.
 * 3. `timing` (8 paths): +1/+2 bar signal delay, rebalance phase offsets, and start-date shifts.
 * 4. `outliers` (6 paths): drop best calendar year, top 1/3/5 trades, best 20-bar stretch, and best month.
 */
export interface StressHooks {
  onProgress?: (done: number, total: number) => void;
  shouldStop?: () => boolean;
}

export function runStress(
  source: string,
  spec: Spec,
  data: Map<string, Bars>,
  baseBt: Backtest,
  defaults: Partial<Defaults> = {},
  seed = 42,
  overrides?: Record<string, number>,
  hooks?: StressHooks,
): StressReport {
  const started = performance.now();
  priceMemo.share(data);
  const { t: fullT, equity: fullEq } = baseBt.run;
  const idxs = sampleIndices(fullT.length);
  const targetT = idxs.map((i) => fullT[i]);
  const baseDecimated = idxs.map((i) => fullEq[i]);
  const capital = spec.capital;
  const prng = makeRng(seed);
  const rand = () => prng.next();
  const paths: StressPath[] = [];
  let doneSteps = 0;
  const totalSteps = 32;
  const tick = () => hooks?.onProgress?.(++doneSteps, totalSteps);

  // 1. Parameter / literal jitter (12 paths)
  const sites = extractLiteralSites(source);
  if (sites.length > 0) {
    for (let k = 0; k < PARAM_PATHS; k++) {
      if (hooks?.shouldStop?.()) break;
      const scale = k < 4 ? 0.08 : k < 8 ? 0.12 : 0.15;
      const litOverrides = jitterLiterals(sites, rand, scale);
      const parsed = parseSpec(source, { defaults, overrides, literalOverrides: litOverrides });
      if (!parsed.spec) {
        tick();
        continue;
      }
      const p = runVariant('params', `Literals ±${Math.round(scale * 100)}% #${k + 1}`, parsed.spec, data, targetT, capital);
      if (p) paths.push(p);
      tick();
    }
  }

  // Reuse base signals for friction & timing (zero indicator recomputation!)
  const baseSignals = specSignals(spec, data);

  // 2. Friction & adverse fills (6 paths)
  const baseBps = spec.costBps + spec.slippageBps;
  const frictionBpsLevels = [
    { label: 'Costs 2×', extraBps: Math.max(5, baseBps), adverse: 0 },
    { label: 'Costs 3×', extraBps: Math.max(10, baseBps * 2), adverse: 0 },
    { label: '+15 bps/side', extraBps: 15, adverse: 0 },
    { label: '+30 bps/side', extraBps: 30, adverse: 0 },
    { label: '+50 bps/side', extraBps: 50, adverse: 0 },
    { label: 'Adverse fill 25%', extraBps: 0, adverse: 0.25 },
  ];
  const frictionCurve: { bps: number; sharpe: number }[] = [{ bps: baseBps, sharpe: Number.isFinite(baseBt.stats.sharpe) ? baseBt.stats.sharpe : 0 }];
  for (const f of frictionBpsLevels) {
    if (hooks?.shouldStop?.()) break;
    const nextSpec: Spec = { ...spec, costBps: spec.costBps + f.extraBps };
    const p = runVariant('friction', f.label, nextSpec, data, targetT, capital, baseSignals, f.adverse > 0 ? { adverseFillFraction: f.adverse } : undefined);
    if (p) {
      paths.push(p);
      if (f.adverse === 0) frictionCurve.push({ bps: baseBps + f.extraBps, sharpe: p.sharpe });
    }
    tick();
  }

  // Estimate breakeven friction bps where Sharpe crosses 0.
  frictionCurve.sort((a, b) => a.bps - b.bps);
  let breakevenBps = Infinity;
  if (frictionCurve[0].sharpe <= 0) {
    breakevenBps = frictionCurve[0].bps;
  } else {
    for (let i = 1; i < frictionCurve.length; i++) {
      const a = frictionCurve[i - 1];
      const b = frictionCurve[i];
      if (b.sharpe <= 0 && a.sharpe > 0) {
        const frac = a.sharpe / (a.sharpe - b.sharpe);
        breakevenBps = a.bps + frac * (b.bps - a.bps);
        break;
      }
    }
  }

  // 3. Timing & phase shifts (8 paths)
  let delayedSharpe = Number.isFinite(baseBt.stats.sharpe) ? baseBt.stats.sharpe : 0;
  const d1 = runVariant('timing', 'Delay +1 bar', spec, data, targetT, capital, baseSignals, { signalDelayBars: 1 });
  if (d1) {
    paths.push(d1);
    delayedSharpe = d1.sharpe;
  }
  const d2 = runVariant('timing', 'Delay +2 bars', spec, data, targetT, capital, baseSignals, { signalDelayBars: 2 });
  if (d2) paths.push(d2);

  if (spec.rebalance !== 'never') {
    for (const off of [2, 5, 10, 15]) {
      if (hooks?.shouldStop?.()) break;
      const p = runVariant('timing', `Rebalance +${off}d`, spec, data, targetT, capital, baseSignals, { rebalanceDayOffset: off });
      if (p) paths.push(p);
      tick();
    }
  } else {
    for (const shiftFrac of [0.03, 0.06, 0.1, 0.15]) {
      if (hooks?.shouldStop?.()) break;
      const idx = Math.floor(fullT.length * shiftFrac);
      if (idx > 0 && idx < fullT.length - 10) {
        const p = runVariant('timing', `Start +${Math.round(shiftFrac * 100)}%`, { ...spec, from: fullT[idx] }, data, targetT, capital, baseSignals, undefined, baseDecimated);
        if (p) paths.push(p);
      }
      tick();
    }
  }
  for (const shiftFrac of [0.05, 0.12]) {
    if (hooks?.shouldStop?.()) break;
    const idx = Math.floor(fullT.length * shiftFrac);
    if (idx > 0 && idx < fullT.length - 10) {
      const p = runVariant('timing', `Late start +${idx} bars`, { ...spec, from: fullT[idx] }, data, targetT, capital, baseSignals, undefined, baseDecimated);
      if (p) paths.push(p);
    }
    tick();
  }

  // 4. Outlier removal (6 pure O(N) paths)
  // Best calendar year (only when backtest spans >= 2 calendar years; otherwise removing the sole year drops 100% of bars)
  const byYear = new Map<number, { start: number; end: number }>();
  for (let i = 0; i < fullT.length; i++) {
    const y = new Date(fullT[i]).getUTCFullYear();
    const cur = byYear.get(y);
    if (!cur) byYear.set(y, { start: i, end: i });
    else cur.end = i;
  }
  let bestYear = -1;
  let bestYearRet = -Infinity;
  for (const [y, span] of byYear) {
    const baseIdx = Math.max(0, span.start - 1);
    const ret = fullEq[baseIdx] > 0 ? fullEq[span.end] / fullEq[baseIdx] - 1 : 0;
    if (ret > bestYearRet) {
      bestYearRet = ret;
      bestYear = y;
    }
  }
  const exBestYear =
    byYear.size >= 2
      ? outlierPath(
          bestYear >= 0 ? `Drop best year (${bestYear})` : 'Drop best year',
          baseBt,
          (i) => new Date(fullT[i]).getUTCFullYear() === bestYear,
          targetT,
          capital,
        )
      : null;
  if (exBestYear) paths.push(exBestYear);

  // Drop best 20-bar window
  const win = Math.min(20, Math.max(2, Math.floor(fullT.length / 10)));
  let bestWinStart = 1;
  let bestWinRet = -Infinity;
  for (let i = win; i < fullT.length; i++) {
    const r = fullEq[i - win] > 0 ? fullEq[i] / fullEq[i - win] - 1 : 0;
    if (r > bestWinRet) {
      bestWinRet = r;
      bestWinStart = i - win + 1;
    }
  }
  paths.push(outlierPath(`Drop best ${win}-bar run`, baseBt, (i) => i >= bestWinStart && i < bestWinStart + win, targetT, capital));

  // Drop top 1, 3, 5 winning trades
  const winners = [...baseBt.run.trades].filter((tr) => tr.ret > 0).sort((a, b) => b.pnl - a.pnl);
  for (const k of [1, 3, 5]) {
    const top = winners.slice(0, k);
    if (top.length === 0) continue;
    paths.push(
      outlierPath(
        `Drop top ${k} ${k === 1 ? 'trade' : 'trades'}`,
        baseBt,
        (i) => top.some((tr) => fullT[i] >= tr.entryT && fullT[i] <= tr.exitT),
        targetT,
        capital,
      ),
    );
  }

  // Drop single best month
  const byMonth = new Map<string, { start: number; end: number }>();
  for (let i = 0; i < fullT.length; i++) {
    const d = new Date(fullT[i]);
    const ym = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    const cur = byMonth.get(ym);
    if (!cur) byMonth.set(ym, { start: i, end: i });
    else cur.end = i;
  }
  let bestMonth = '';
  let bestMonthRet = -Infinity;
  for (const [ym, span] of byMonth) {
    const baseIdx = Math.max(0, span.start - 1);
    const ret = fullEq[baseIdx] > 0 ? fullEq[span.end] / fullEq[baseIdx] - 1 : 0;
    if (ret > bestMonthRet) {
      bestMonthRet = ret;
      bestMonth = ym;
    }
  }
  const bestMonthPath =
    byMonth.size >= 2
      ? outlierPath(
          'Drop best month',
          baseBt,
          (i) => {
            const d = new Date(fullT[i]);
            return `${d.getUTCFullYear()}-${d.getUTCMonth()}` === bestMonth;
          },
          targetT,
          capital,
        )
      : null;
  if (bestMonthPath) paths.push(bestMonthPath);

  // Build per-axis and combined envelopes
  const ofAxis = (axis: StressAxis) => paths.filter((p) => p.axis === axis);
  const envelopes: StressReport['envelopes'] = {
    all: buildEnvelope(paths, targetT.length, baseDecimated),
    params: buildEnvelope(ofAxis('params'), targetT.length, baseDecimated),
    friction: buildEnvelope(ofAxis('friction'), targetT.length, baseDecimated),
    timing: buildEnvelope(ofAxis('timing'), targetT.length, baseDecimated),
    outliers: buildEnvelope(ofAxis('outliers'), targetT.length, baseDecimated),
  };

  const baseSharpe = Number.isFinite(baseBt.stats.sharpe) ? baseBt.stats.sharpe : 0;
  const paramPaths = ofAxis('params');
  const neighborSurvivalRate = paramPaths.length === 0 ? 1 : paramPaths.filter((p) => p.sharpe > 0).length / paramPaths.length;

  const collapses = (axis: StressAxis): boolean => {
    const list = ofAxis(axis);
    if (list.length === 0) return false;
    const sharpes = list.map((p) => p.sharpe).sort((a, b) => a - b);
    const ref = axis === 'timing' ? delayedSharpe : quantile(sharpes, 0.25);
    return baseSharpe > 0 ? ref <= 0 || ref < baseSharpe * 0.6 : ref < baseSharpe - 0.2;
  };
  const axisCollapse: Record<StressAxis, boolean> = {
    params: collapses('params'),
    friction: collapses('friction'),
    timing: collapses('timing'),
    outliers: collapses('outliers'),
  };
  const failedAxes = Object.values(axisCollapse).filter(Boolean).length;
  const grade: BreakingPoints['grade'] =
    baseSharpe <= 0 || failedAxes >= 2 || neighborSurvivalRate < 0.6 ? 'fragile' : failedAxes === 1 || neighborSurvivalRate < 0.85 ? 'sensitive' : 'robust';

  return {
    t: targetT,
    envelopes,
    paths,
    breakingPoints: {
      breakevenBps,
      neighborSurvivalRate,
      exBestYearSharpe: exBestYear ? exBestYear.sharpe : bestMonthPath ? bestMonthPath.sharpe : baseSharpe,
      delayedSharpe,
      axisCollapse,
      grade,
    },
    elapsedMs: performance.now() - started,
  };
}
