// Two checks of whether a strategy's figures come from trying many variants rather than from an edge: the deflated
// Sharpe ratio (Bailey and López de Prado, 2014), which asks how likely the shown Sharpe ratio is to be above zero
// given how many variants were tried and how much their Sharpe ratios spread, and the probability of backtest
// overfitting by combinatorially symmetric cross-validation (Bailey, Borwein, López de Prado and Zhu, 2017), which asks
// how often the variant that did best on one half of the history did worse than the median variant on the other half.
//
// Sharpe ratios here are per step, as computeStats measures them before it annualises: the mean excess return over cash
// divided by its population standard deviation, 0 when that deviation is below NOISE.

import { NOISE } from './backtest.ts';
import { YEAR } from './format.ts';

// W. J. Cody's rational approximations for the normal distribution function, with the coefficients of R's pnorm.
const CDF_A = [2.2352520354606839287, 161.02823106855587881, 1067.6894854603709582, 18154.981253343561249, 0.065682337918207449113];
const CDF_B = [47.20258190468824187, 976.09855173777669322, 10260.932208618978205, 45507.789335026729956];
const CDF_C = [
  0.39894151208813466764, 8.8831497943883759412, 93.506656132177855979, 597.27027639480026226, 2494.5375852903726711, 6848.1904505362823326,
  11602.651437647350124, 9842.7148383839780218, 1.0765576773720192317e-8,
];
const CDF_D = [
  22.266688044328115691, 235.38790178262499861, 1519.377599407554805, 6485.558298266760755, 18615.571640885098091, 34900.952721145977266,
  38912.003286093271411, 19685.429676859990727,
];
const CDF_P = [0.21589853405795699, 0.1274011611602473639, 0.022235277870649807, 0.001421619193227893466, 2.9112874951168792e-5, 0.02307344176494017303];
const CDF_Q = [1.28426009614491121, 0.468238212480865118, 0.0659881378689285515, 0.00378239633202758244, 7.29751555083966205e-5];

/** exp(-y²/2) times `factor`, with y² split so the large part is exact and no precision is lost in the far tail. */
function gaussTail(y: number, factor: number): number {
  const whole = Math.trunc(y * 16) / 16;
  const rest = (y - whole) * (y + whole);
  return Math.exp(-whole * whole * 0.5) * Math.exp(-rest * 0.5) * factor;
}

/** Φ, the standard normal distribution function, to full double precision. */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const y = Math.abs(x);
  if (y <= 0.67448975) {
    let num = 0;
    let den = 0;
    if (y > Number.EPSILON / 2) {
      const sq = x * x;
      num = CDF_A[4] * sq;
      den = sq;
      for (let i = 0; i < 3; i++) {
        num = (num + CDF_A[i]) * sq;
        den = (den + CDF_B[i]) * sq;
      }
    }
    return 0.5 + (x * (num + CDF_A[3])) / (den + CDF_B[3]);
  }
  // `lower` is Φ(-|x|), the smaller of the two tails.
  let lower: number;
  if (y <= Math.sqrt(32)) {
    let num = CDF_C[8] * y;
    let den = y;
    for (let i = 0; i < 7; i++) {
      num = (num + CDF_C[i]) * y;
      den = (den + CDF_D[i]) * y;
    }
    lower = gaussTail(y, (num + CDF_C[7]) / (den + CDF_D[7]));
  } else if (y < 37.5193) {
    const inv = 1 / (y * y);
    let num = CDF_P[5] * inv;
    let den = inv;
    for (let i = 0; i < 4; i++) {
      num = (num + CDF_P[i]) * inv;
      den = (den + CDF_Q[i]) * inv;
    }
    lower = gaussTail(y, (1 / Math.sqrt(2 * Math.PI) - (inv * (num + CDF_P[4])) / (den + CDF_Q[4])) / y);
  } else {
    lower = 0;
  }
  return x > 0 ? 1 - lower : lower;
}

// Wichura's algorithm AS 241 (PPND16), accurate to about 1 part in 10^16.
const INV_A = [
  3.387132872796366608, 133.14166789178437745, 1971.5909503065514427, 13731.693765509461125, 45921.953931549871457, 67265.770927008700853,
  33430.575583588128105, 2509.0809287301226727,
];
const INV_B = [1, 42.313330701600911252, 687.1870074920579083, 5394.1960214247511077, 21213.794301586595867, 39307.89580009271061, 28729.085735721942674, 5226.495278852854561];
const INV_C = [
  1.42343711074968357734, 4.6303378461565452959, 5.7694972214606914055, 3.64784832476320460504, 1.27045825245236838258, 0.24178072517745061177,
  0.0227238449892691845833, 7.7454501427834140764e-4,
];
const INV_D = [
  1, 2.05319162663775882187, 1.6763848301838038494, 0.68976733498510000455, 0.14810397642748007459, 0.0151986665636164571966,
  5.475938084995344946e-4, 1.05075007164441684324e-9,
];
const INV_E = [
  6.6579046435011037772, 5.4637849111641143699, 1.7848265399172913358, 0.29656057182850489123, 0.026532189526576123093, 0.0012426609473880784386,
  2.71155556874348757815e-5, 2.01033439929228813265e-7,
];
const INV_F = [
  1, 0.59983220655588793769, 0.13692988092273580531, 0.0148753612908506148525, 7.868691311456132591e-4, 1.8463183175100546818e-5,
  1.4215117583164458887e-7, 2.04426310338993978564e-15,
];

/** The polynomial with coefficients `c` (lowest power first) at `x`. */
function poly(c: number[], x: number): number {
  let v = 0;
  for (let i = c.length - 1; i >= 0; i--) v = v * x + c[i];
  return v;
}

/** Φ⁻¹, the standard normal quantile: the x with Φ(x) = p. -Infinity at 0, Infinity at 1, NaN outside [0, 1]. */
export function normInv(p: number): number {
  if (!(p >= 0 && p <= 1)) return NaN;
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return (q * poly(INV_A, r)) / poly(INV_B, r);
  }
  let r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p));
  let x: number;
  if (r <= 5) {
    r -= 1.6;
    x = poly(INV_C, r) / poly(INV_D, r);
  } else {
    r -= 5;
    x = poly(INV_E, r) / poly(INV_F, r);
  }
  return q < 0 ? -x : x;
}

/** The Euler–Mascheroni constant. */
export const EULER_GAMMA = 0.5772156649015329;

/** What each step returned above cash, as computeStats measures it: `cashReturn[i]` is what cash earned from bar i - 1 to bar i. */
export function excessReturns(equity: readonly number[], cashReturn: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) out.push(equity[i] / equity[i - 1] - 1 - (cashReturn[i] ?? 0));
  return out;
}

export interface Moments {
  steps: number;
  mean: number;
  /** Population standard deviation. */
  sd: number;
  /** γ₃, the third standardised moment; NaN when `sd` is 0. */
  skew: number;
  /** γ₄, the fourth standardised moment, not less 3: a normal distribution's is 3. NaN when `sd` is 0. */
  kurt: number;
}

export function moments(xs: readonly number[]): Moments {
  const n = xs.length;
  let sum = 0;
  for (const x of xs) sum += x;
  const mean = sum / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const x of xs) {
    const d = x - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  const sd = Math.sqrt(m2);
  return { steps: n, mean, sd, skew: m3 / (sd * m2), kurt: m4 / (m2 * m2) };
}

/** A run's Sharpe ratio per step, with the shape of its returns that the deflated Sharpe ratio needs. */
export interface StepSharpe {
  sharpe: number;
  steps: number;
  skew: number;
  kurt: number;
}

/** The Sharpe ratio per step of excess returns and their shape; null when they barely vary, since their shape is then unknown. */
export function stepSharpe(returns: readonly number[]): StepSharpe | null {
  const m = moments(returns);
  if (!(m.sd >= NOISE)) return null;
  return { sharpe: m.mean / m.sd, steps: m.steps, skew: m.skew, kurt: m.kurt };
}

/** Steps a year in a run over times `t`, as computeStats counts them to annualise. */
export function stepsPerYear(t: readonly number[]): number {
  return (t.length - 1) / ((t[t.length - 1] - t[0]) / YEAR);
}

/** A Sharpe ratio a year, as computeStats gives it, back to per step for a run with `perYear` steps a year. */
export function perStep(sharpeAnnual: number, perYear: number): number {
  return sharpeAnnual / Math.sqrt(perYear);
}

/**
 * SR₀: the best per-step Sharpe ratio to expect from `trials` variants with no edge whose Sharpe ratios vary by
 * `variance` (False Strategy Theorem, Bailey and López de Prado, 2014). 0 for a single variant.
 */
export function expectedMaxSharpe(trials: number, variance: number): number {
  if (trials <= 1) return 0;
  return Math.sqrt(variance) * ((1 - EULER_GAMMA) * normInv(1 - 1 / trials) + EULER_GAMMA * normInv(1 - 1 / (trials * Math.E)));
}

export interface Deflated {
  /** SR₀, per step. */
  sr0: number;
  /** The probability that the true Sharpe ratio is above SR₀. */
  dsr: number;
}

/**
 * The deflated Sharpe ratio of a run, after `trials` variants whose per-step Sharpe ratios have `variance`:
 * Φ((SR − SR₀)·√(T − 1) / √(1 − γ₃·SR + (γ₄ − 1)/4·SR²)). Null when it can't be told: under 3 steps, or a shape of
 * returns for which the standard error of the Sharpe ratio has no real value.
 */
export function deflatedSharpe(run: StepSharpe, trials: number, variance: number): Deflated | null {
  if (run.steps < 3) return null;
  const spread = 1 - run.skew * run.sharpe + ((run.kurt - 1) / 4) * run.sharpe * run.sharpe;
  if (!(spread > 0)) return null;
  const sr0 = expectedMaxSharpe(trials, variance);
  return { sr0, dsr: normCdf(((run.sharpe - sr0) * Math.sqrt(run.steps - 1)) / Math.sqrt(spread)) };
}

/** How many equal stretches of the timeline a sweep variant's returns are summed over, for the overfitting check. */
export const STRETCHES = 48;

/** Sums over each of the STRETCHES stretches of a run: of its per-step excess returns (`s`) and of their squares (`q`). */
export interface StepBlocks {
  s: number[];
  q: number[];
}

/** Where stretch j of a run of `steps` steps starts; stretch j covers the steps from `stretchStart(j)` up to `stretchStart(j + 1)`. */
function stretchStart(j: number, steps: number): number {
  return Math.floor((j * steps) / STRETCHES);
}

/** A run's excess returns summed over each stretch of its timeline, so the overfitting check needs no whole curves. */
export function stepBlocks(equity: readonly number[], cashReturn: readonly number[]): { steps: number; blocks: StepBlocks } {
  const r = excessReturns(equity, cashReturn);
  const s: number[] = [];
  const q: number[] = [];
  for (let j = 0; j < STRETCHES; j++) {
    let sum = 0;
    let squares = 0;
    for (let i = stretchStart(j, r.length); i < stretchStart(j + 1, r.length); i++) {
      sum += r[i];
      squares += r[i] * r[i];
    }
    s.push(sum);
    q.push(squares);
  }
  return { steps: r.length, blocks: { s, q } };
}

/** The per-step Sharpe ratio of `n` returns whose sum is `s` and sum of squares `q`. */
function sharpeOfSums(s: number, q: number, n: number): number {
  const mean = s / n;
  const sd = Math.sqrt(Math.max(0, q / n - mean * mean));
  return sd < NOISE ? 0 : mean / sd;
}

export interface Cscv {
  /** The share of splits in which the best variant on the training half ranked at or below the median on the other half. */
  pbo: number;
  /** λ = ln(ω / (1 − ω)) of each split, ω being the training winner's mid-rank on the other half over N + 1. */
  logits: number[];
}

/**
 * Combinatorially symmetric cross-validation over `groups.length` groups of steps (an even number), `n[g]` steps in
 * group g. `variants[v]` holds variant v's sums over each group, in grid order. Every way of choosing half the groups
 * to train on is one split, the other half being its test.
 */
export function cscv(variants: readonly StepBlocks[], n: readonly number[]): Cscv {
  const groups = n.length;
  const count = variants.length;
  const all = (1 << groups) - 1;
  const logits: number[] = [];
  const inMask = new Float64Array(count);
  const outMask = new Float64Array(count);
  const judge = (train: Float64Array, test: Float64Array) => {
    let best = 0;
    for (let v = 1; v < count; v++) if (train[v] > train[best]) best = v;
    let below = 0;
    let equal = 0;
    for (let v = 0; v < count; v++) {
      if (test[v] < test[best]) below++;
      else if (test[v] === test[best]) equal++;
    }
    const omega = (below + (equal + 1) / 2) / (count + 1);
    logits.push(Math.log(omega / (1 - omega)));
  };
  // Masks that hold group 0, each judged both ways round, give every split once.
  for (let mask = 1; mask <= all; mask += 2) {
    if (popCount(mask) !== groups / 2) continue;
    for (let v = 0; v < count; v++) {
      let s1 = 0;
      let q1 = 0;
      let n1 = 0;
      let s2 = 0;
      let q2 = 0;
      let n2 = 0;
      for (let g = 0; g < groups; g++) {
        if (mask & (1 << g)) {
          s1 += variants[v].s[g];
          q1 += variants[v].q[g];
          n1 += n[g];
        } else {
          s2 += variants[v].s[g];
          q2 += variants[v].q[g];
          n2 += n[g];
        }
      }
      inMask[v] = sharpeOfSums(s1, q1, n1);
      outMask[v] = sharpeOfSums(s2, q2, n2);
    }
    judge(inMask, outMask);
    judge(outMask, inMask);
  }
  return { pbo: logits.filter((l) => l <= 0).length / logits.length, logits };
}

function popCount(x: number): number {
  let c = 0;
  for (; x; x &= x - 1) c++;
  return c;
}

/** A sweep variant as the overfitting check reads it. */
export interface PboVariant {
  steps: number;
  blocks: StepBlocks;
}

export interface Pbo {
  /** Null when it can't be told, `short` saying why. */
  pbo: number | null;
  short: 'variants' | 'steps' | null;
  /** Variants used. */
  variants: number;
  /** Variants left out because their runs had another number of steps than the most common one. */
  leftOut: number;
  steps: number;
  groups: number;
  splits: number;
}

/** The fewest variants, and the fewest steps per group, the check is told for. */
export const PBO_MIN_VARIANTS = 5;
export const PBO_MIN_STEPS_PER_GROUP = 20;

/**
 * The probability of backtest overfitting of a sweep, from its variants in grid order. Variants that errored or never
 * traded are left out by the caller. The stretches are joined into 16 groups, or 12 above 150 variants to keep the
 * number of splits down: 12,870 splits for 16 groups, 924 for 12.
 */
export function pbo(variants: readonly PboVariant[]): Pbo {
  const tally = new Map<number, number>();
  for (const v of variants) tally.set(v.steps, (tally.get(v.steps) ?? 0) + 1);
  let steps = 0;
  let most = 0;
  for (const [k, c] of tally) {
    if (c > most) {
      steps = k;
      most = c;
    }
  }
  const used = variants.filter((v) => v.steps === steps);
  const groups = used.length > 150 ? 12 : 16;
  const base = { variants: used.length, leftOut: variants.length - used.length, steps, groups };
  if (used.length < PBO_MIN_VARIANTS) return { ...base, pbo: null, short: 'variants', splits: 0 };
  if (steps < PBO_MIN_STEPS_PER_GROUP * groups) return { ...base, pbo: null, short: 'steps', splits: 0 };
  const per = STRETCHES / groups;
  const n: number[] = [];
  for (let g = 0; g < groups; g++) n.push(stretchStart((g + 1) * per, steps) - stretchStart(g * per, steps));
  const joined = used.map(({ blocks }) => {
    const s: number[] = [];
    const q: number[] = [];
    for (let g = 0; g < groups; g++) {
      let sum = 0;
      let squares = 0;
      for (let j = g * per; j < (g + 1) * per; j++) {
        sum += blocks.s[j];
        squares += blocks.q[j];
      }
      s.push(sum);
      q.push(squares);
    }
    return { s, q };
  });
  const result = cscv(joined, n);
  return { ...base, pbo: result.pbo, short: null, splits: result.logits.length };
}
