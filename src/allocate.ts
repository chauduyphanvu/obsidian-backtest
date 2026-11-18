// How to split money between strategies: weights from their monthly returns, worked out again each month from the
// months before it only, so the combined line they give is one that could have been followed. Pure.

import { cashReturns, monthStarts, rebalanced, type Aligned } from './compare.ts';

export const METHODS = ['equal', 'inverse volatility', 'minimum variance', 'maximum diversification'] as const;
export type Method = (typeof METHODS)[number];

/** Full months of returns the methods that read correlations need, and the one that reads volatility alone. */
export const COVARIANCE_MONTHS = 24;
export const VOLATILITY_MONTHS = 6;
/**
 * A strategy whose monthly returns vary by less than this (about 0.35% a year) sat in cash, or nearly, over the months
 * measured: sizing by risk would put almost everything in it, so the methods that do leave it out.
 */
const STILL = 0.001;
const MAX_STEPS = 20_000;
const TOLERANCE = 1e-12;

/**
 * Each strategy's return over each full calendar month: from the first point of a month to the first point of the next,
 * the stretches over which `combine` holds its weights. The part month before the first start and the month still
 * running are left out. One row per strategy.
 */
export function monthlyReturns(aligned: Pick<Aligned, 't' | 'series'>): number[][] {
  const starts = monthStarts(aligned.t);
  return aligned.series.map((s) => starts.slice(1).map((end, j) => s[end] / s[starts[j]] - 1));
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * The covariance of the returns (one row per strategy) shrunk towards a matrix with every correlation at the average
 * one, by the intensity of Ledoit and Wolf, "Honey, I Shrunk the Sample Covariance Matrix", Journal of Portfolio
 * Management 30(4), 2004, section 2 and appendix (their covCor estimator, with the sample covariance over T, not T - 1).
 * Every row must vary.
 */
export function shrunkCovariance(returns: number[][]): { cov: number[][]; shrinkage: number } {
  const n = returns.length;
  const T = returns[0].length;
  const x = returns.map((r) => {
    const m = mean(r);
    return r.map((v) => v - m);
  });
  const s = x.map((a) => x.map((b) => a.reduce((sum, v, t) => sum + v * b[t], 0) / T));
  const sd = s.map((row, i) => Math.sqrt(row[i]));
  let rbar = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) rbar += s[i][j] / (sd[i] * sd[j]);
  rbar = n > 1 ? (2 * rbar) / (n * (n - 1)) : 0;
  const target = s.map((row, i) => row.map((v, j) => (i === j ? v : rbar * sd[i] * sd[j])));

  // pi: the summed variances of the sample covariances; rho: their covariances with the target; gamma: how far apart the two matrices are.
  let pi = 0;
  let rho = 0;
  let gamma = 0;
  let size = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let p = 0;
      let thetaI = 0;
      let thetaJ = 0;
      for (let t = 0; t < T; t++) {
        const d = x[i][t] * x[j][t] - s[i][j];
        p += d * d;
        thetaI += (x[i][t] * x[i][t] - s[i][i]) * d;
        thetaJ += (x[j][t] * x[j][t] - s[j][j]) * d;
      }
      pi += p / T;
      if (i === j) rho += p / T;
      else rho += (rbar / 2) * (Math.sqrt(s[j][j] / s[i][i]) * (thetaI / T) + Math.sqrt(s[i][i] / s[j][j]) * (thetaJ / T));
      gamma += (target[i][j] - s[i][j]) ** 2;
      size += s[i][j] ** 2;
    }
  }
  // With two strategies the target is the sample matrix itself, apart from rounding, and there is nothing to shrink.
  const shrinkage = gamma > 1e-24 * size ? Math.max(0, Math.min(1, (pi - rho) / gamma / T)) : 0;
  return { cov: s.map((row, i) => row.map((v, j) => shrinkage * target[i][j] + (1 - shrinkage) * v)), shrinkage };
}

/**
 * The point nearest `v` with no coordinate below 0 and all of them adding up to `total`: Duchi, Shalev-Shwartz, Singer and
 * Chandra, "Efficient Projections onto the l1-Ball for Learning in High Dimensions", ICML 2008, figure 1.
 */
export function projectSimplex(v: number[], total: number): number[] {
  const u = [...v].sort((a, b) => b - a);
  let sum = 0;
  let theta = 0;
  for (let j = 0; j < u.length; j++) {
    sum += u[j];
    const t = (sum - total) / (j + 1);
    if (u[j] - t > 0) theta = t;
  }
  return v.map((x) => Math.max(x - theta, 0));
}

/**
 * The weights, none below 0 and adding up to `total`, with the least variance under `cov`, by projected gradient descent
 * from equal weights. The step is 1 over a bound on the gradient's Lipschitz constant (twice the Frobenius norm), which
 * makes every step lower the variance; it stops when no weight moves by more than a millionth of a millionth of the total.
 */
export function minimumVariance(cov: number[][], total: number): number[] {
  const n = cov.length;
  let w = new Array<number>(n).fill(total / n);
  const bound = 2 * Math.sqrt(cov.reduce((s, row) => s + row.reduce((r, c) => r + c * c, 0), 0));
  if (!(bound > 0)) return w;
  for (let step = 0; step < MAX_STEPS; step++) {
    const next = projectSimplex(
      w.map((wi, i) => wi - (2 * cov[i].reduce((s, c, j) => s + c * w[j], 0)) / bound),
      total,
    );
    const moved = next.reduce((m, x, i) => Math.max(m, Math.abs(x - w[i])), 0);
    w = next;
    if (moved <= TOLERANCE * total) break;
  }
  return w;
}

/**
 * The weights with the highest ratio of their weighted volatilities to the portfolio's volatility (Choueifaty and Coignard,
 * "Toward Maximum Diversification", Journal of Portfolio Management 35(1), 2008): the least-variance weights on the
 * correlation matrix, each divided by its strategy's volatility, scaled back to `total`.
 */
export function maximumDiversification(cov: number[][], total: number): number[] {
  const sd = cov.map((row, i) => Math.sqrt(row[i]));
  const y = minimumVariance(
    cov.map((row, i) => row.map((v, j) => v / (sd[i] * sd[j]))),
    1,
  );
  const raw = y.map((yi, i) => yi / sd[i]);
  const sum = raw.reduce((s, x) => s + x, 0);
  return raw.map((x) => (x / sum) * total);
}

/** Weights in inverse proportion to each volatility, adding up to `total`. */
export function inverseVolatility(cov: number[][], total: number): number[] {
  const inv = cov.map((row, i) => 1 / Math.sqrt(row[i]));
  const sum = inv.reduce((s, x) => s + x, 0);
  return inv.map((x) => (x / sum) * total);
}

const months = (method: Method) => (method === 'equal' ? 0 : method === 'inverse volatility' ? VOLATILITY_MONTHS : COVARIANCE_MONTHS);

/** Strategies whose monthly returns barely vary: left out of the methods that size by risk. */
function stillOnes(returns: number[][]): number[] {
  return returns.flatMap((r, i) => (Math.sqrt(mean(r.map((v) => (v - mean(r)) ** 2))) < STILL ? [i] : []));
}

/**
 * The weights a method gives from the returns (one row per strategy), adding up to `total`. With fewer months than the
 * method needs, or when every strategy barely moved, they are equal.
 */
export function weightsFrom(method: Method, returns: number[][], total: number): number[] {
  const n = returns.length;
  const equal = returns.map(() => total / n);
  const T = returns[0]?.length ?? 0;
  if (method === 'equal' || T < months(method)) return equal;
  const still = stillOnes(returns);
  const moving = returns.flatMap((_, i) => (still.includes(i) ? [] : [i]));
  if (moving.length === 0) return equal;
  const { cov } = shrunkCovariance(moving.map((i) => returns[i]));
  const w = { 'inverse volatility': inverseVolatility, 'minimum variance': minimumVariance, 'maximum diversification': maximumDiversification }[method](cov, total);
  const out = new Array<number>(n).fill(0);
  moving.forEach((i, k) => (out[i] = w[k]));
  return out;
}

/**
 * The weights a method sets at the first point and at each later month's first point, each from the full months that
 * ended by then: what someone following it could have known.
 */
export function monthlyWeights(aligned: Pick<Aligned, 't' | 'series'>, method: Method, total: number): Map<number, number[]> {
  const returns = monthlyReturns(aligned);
  const out = new Map<number, number[]>([[0, weightsFrom(method, returns.map(() => []), total)]]);
  // Return k runs from start k to start k + 1, so at start j the first j returns are known.
  monthStarts(aligned.t).forEach((at, j) => out.set(at, weightsFrom(method, returns.map((r) => r.slice(0, j)), total)));
  return out;
}

/** The cash return of a mix whose weights change at the points of `set`, each step at the weights held through it. */
function scheduledCash(cash: number[][], set: Map<number, number[]>, steps: number): number[] {
  let w = set.get(0)!;
  const out = [0];
  for (let i = 1; i < steps; i++) {
    const sum = w.reduce((s, x) => s + x, 0);
    out.push(sum > 0 ? cash.reduce((s, c, k) => s + c[i] * w[k], 0) / sum : 0);
    w = set.get(i) ?? w;
  }
  return out;
}

export interface Suggestion {
  method: Method;
  /** From every full month, as fractions adding up to the total. */
  weights: number[];
  /** The same as whole percentages, by largest remainders. */
  percents: number[];
  /** The combined line with the weights worked out each month from the months before it; starts at 1. */
  values: number[];
  cashReturn: number[];
}

export interface Allocation {
  /** Full months the strategies overlap. */
  months: number;
  /** Strategies that barely moved over those months, left out of the methods that size by risk. */
  still: number[];
  /** How far the covariances were pulled towards an average correlation, from 0 to 1; null below `COVARIANCE_MONTHS`. */
  shrinkage: number | null;
  /** Equal weights; inverse volatility from `VOLATILITY_MONTHS` months; the other two from `COVARIANCE_MONTHS`. */
  suggestions: Suggestion[];
}

/** Weights by each method that has the months it needs, for strategies whose curves are aligned, adding up to `total`. */
export function suggestWeights(aligned: Aligned, total: number): Allocation {
  const returns = monthlyReturns(aligned);
  const count = returns[0].length;
  const cash = cashReturns(aligned);
  const still = count >= VOLATILITY_MONTHS ? stillOnes(returns) : [];
  const moving = returns.filter((_, i) => !still.includes(i));
  const lastStart = monthStarts(aligned.t).pop() ?? 0;
  const suggestions = METHODS.filter((m) => count >= months(m)).map((method) => {
    const set = monthlyWeights(aligned, method, total);
    // Set at the last month's start, from every full month.
    const weights = set.get(lastStart)!;
    return {
      method,
      weights,
      percents: wholePercents(weights, total),
      values: rebalanced(aligned, (i) => set.get(i)!),
      cashReturn: scheduledCash(cash, set, aligned.t.length),
    };
  });
  return { months: count, still, shrinkage: count >= COVARIANCE_MONTHS && moving.length > 0 ? shrunkCovariance(moving).shrinkage : null, suggestions };
}

/**
 * The combined line at the given weights, and without each strategy in turn, its weight spread over the others in
 * proportion to theirs so the total stays the same: what each one adds to the mix. Each line comes with its cash return.
 */
export function strategyAdds(aligned: Aligned, weights: number[]): { values: number[]; cashReturn: number[]; without: { values: number[]; cashReturn: number[] }[] } {
  const cash = cashReturns(aligned);
  const total = weights.reduce((s, w) => s + w, 0);
  const line = (w: number[]) => {
    const set = new Map([[0, w]]);
    return { values: rebalanced(aligned, () => w), cashReturn: scheduledCash(cash, set, aligned.t.length) };
  };
  return {
    ...line(weights),
    without: weights.map((wk, k) => {
      const rest = total - wk;
      return line(weights.map((w, i) => (i === k || rest <= 0 ? 0 : (w * total) / rest)));
    }),
  };
}

/**
 * Weights as whole percentages adding up to exactly the whole percentages of `total` (rounded down, so never above it),
 * by largest remainders: each gets the whole part of its share, and the percentages left go to the largest fractions,
 * the first strategy first among equal ones.
 */
export function wholePercents(weights: number[], total: number): number[] {
  const units = Math.floor(total * 100 + 1e-9);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!(sum > 0)) return weights.map(() => 0);
  const quotas = weights.map((w) => (w / sum) * units);
  const out = quotas.map((q) => Math.floor(q));
  const order = quotas.map((q, i) => ({ i, rest: q - Math.floor(q) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  const left = units - out.reduce((s, x) => s + x, 0);
  for (let k = 0; k < left; k++) out[order[k].i]++;
  return out;
}
