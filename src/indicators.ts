// Every indicator returns an array as long as its input, with NaN where the value is not yet known.

import { DAY } from './format.ts';

function filled(n: number): number[] {
  return new Array<number>(n).fill(NaN);
}

/** Applies `fn` to each full window of `n` values that holds no NaN. */
function rolling(src: number[], n: number, fn: (start: number, end: number) => number): number[] {
  const out = filled(src.length);
  let valid = 0;
  for (let i = 0; i < src.length; i++) {
    valid = Number.isNaN(src[i]) ? 0 : valid + 1;
    if (valid >= n) out[i] = fn(i - n + 1, i);
  }
  return out;
}

export function sma(src: number[], n: number): number[] {
  return rolling(src, n, (s, e) => {
    let sum = 0;
    for (let i = s; i <= e; i++) sum += src[i];
    return sum / n;
  });
}

export function stdev(src: number[], n: number): number[] {
  return rolling(src, n, (s, e) => {
    let sum = 0;
    for (let i = s; i <= e; i++) sum += src[i];
    const mean = sum / n;
    let sq = 0;
    for (let i = s; i <= e; i++) sq += (src[i] - mean) ** 2;
    return Math.sqrt(sq / n);
  });
}

export function highest(src: number[], n: number): number[] {
  return extreme(src, n, 1);
}

export function lowest(src: number[], n: number): number[] {
  return extreme(src, n, -1);
}

/** Exponential smoothing seeded with the simple average of the first `n` values. */
function smoothed(src: number[], n: number, alpha: number): number[] {
  const out = filled(src.length);
  let start = 0;
  while (start < src.length && Number.isNaN(src[start])) start++;
  if (start + n > src.length) return out;
  let value = 0;
  for (let i = start; i < start + n; i++) value += src[i];
  value /= n;
  out[start + n - 1] = value;
  for (let i = start + n; i < src.length; i++) {
    value += alpha * (src[i] - value);
    out[i] = value;
  }
  return out;
}

export function ema(src: number[], n: number): number[] {
  return smoothed(src, n, 2 / (n + 1));
}

/** Wilder's moving average, as used by RSI and ATR. */
export function rma(src: number[], n: number): number[] {
  return smoothed(src, n, 1 / n);
}

export function rsi(src: number[], n: number): number[] {
  const gain = filled(src.length);
  const loss = filled(src.length);
  for (let i = 1; i < src.length; i++) {
    const d = src[i] - src[i - 1];
    gain[i] = d > 0 ? d : d <= 0 ? 0 : NaN;
    loss[i] = d < 0 ? -d : d >= 0 ? 0 : NaN;
  }
  const g = rma(gain, n);
  const l = rma(loss, n);
  return g.map((x, i) => (l[i] === 0 ? (x === 0 ? 50 : 100) : 100 - 100 / (1 + x / l[i])));
}

/** Change over `n` bars as a fraction, so roc(20) > 5% reads naturally. */
export function roc(src: number[], n: number): number[] {
  return src.map((x, i) => (i >= n ? x / src[i - n] - 1 : NaN));
}

export function atr(h: number[], l: number[], c: number[], n: number): number[] {
  const tr = h.map((hi, i) => (i === 0 ? hi - l[i] : Math.max(hi - l[i], Math.abs(hi - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
  return rma(tr, n);
}

export function macd(src: number[], fast: number, slow: number): number[] {
  const f = ema(src, fast);
  const s = ema(src, slow);
  return f.map((x, i) => x - s[i]);
}

export function lag(src: number[], n: number): number[] {
  return src.map((_, i) => (i >= n ? src[i - n] : NaN));
}

/** One-bar change as a fraction; NaN on the first bar. */
export function returns(src: number[]): number[] {
  return src.map((x, i) => (i > 0 ? x / src[i - 1] - 1 : NaN));
}

/**
 * The highest (`sign` 1) or lowest (-1) of each full window of `n` known values, in one pass with a queue of candidates.
 * Of equal candidates the oldest is kept, so a window holding both 0 and -0 gives the one that came first, as a scan of
 * the window from its start does.
 */
function extreme(src: number[], n: number, sign: 1 | -1): number[] {
  const out = filled(src.length);
  const keep: number[] = [];
  let head = 0;
  let valid = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    if (Number.isNaN(x)) {
      keep.length = 0;
      head = 0;
      valid = 0;
      continue;
    }
    valid++;
    while (keep.length > head && sign * src[keep[keep.length - 1]] < sign * x) keep.pop();
    keep.push(i);
    if (keep[head] <= i - n) head++;
    if (valid >= n) out[i] = src[keep[head]];
  }
  return out;
}

/**
 * The sum of each full window of `n` known values, moved on one bar at a time. It is built again from scratch
 * every `n` bars, so rounding cannot add up over a long series.
 */
function windowSum(src: number[], n: number): number[] {
  const out = filled(src.length);
  let sum = 0;
  let valid = 0;
  let moved = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    if (Number.isNaN(x)) {
      sum = 0;
      valid = 0;
      moved = 0;
      continue;
    }
    valid++;
    if (valid <= n) {
      sum += x;
    } else if (++moved >= n) {
      sum = 0;
      for (let j = i - n + 1; j <= i; j++) sum += src[j];
      moved = 0;
    } else {
      sum += x - src[i - n];
    }
    if (valid >= n) out[i] = sum;
  }
  return out;
}

/** Index of the first element of `sorted` that is not below `x`: how many are below it. */
function below(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const typical = (h: number[], l: number[], c: number[]): number[] => c.map((x, i) => (h[i] + l[i] + x) / 3);

/** Linearly weighted average of the last `n` values: the newest weighs n, the oldest 1. */
export function wma(src: number[], n: number): number[] {
  const out = filled(src.length);
  const weights = (n * (n + 1)) / 2;
  let sum = 0;
  let weighted = 0;
  let valid = 0;
  let moved = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    if (Number.isNaN(x)) {
      sum = weighted = valid = moved = 0;
      continue;
    }
    valid++;
    if (valid <= n) {
      sum += x;
      weighted += valid * x;
    } else if (++moved >= n) {
      sum = weighted = 0;
      for (let k = 0; k < n; k++) {
        sum += src[i - n + 1 + k];
        weighted += (k + 1) * src[i - n + 1 + k];
      }
      moved = 0;
    } else {
      weighted += n * x - sum;
      sum += x - src[i - n];
    }
    if (valid >= n) out[i] = weighted / weights;
  }
  return out;
}

/** Hull's average: wma(2 * wma(n / 2) - wma(n), sqrt(n)), the half and the root rounded down. */
export function hma(src: number[], n: number): number[] {
  const fast = wma(src, Math.floor(n / 2));
  const slow = wma(src, n);
  return wma(fast.map((x, i) => 2 * x - slow[i]), Math.floor(Math.sqrt(n)));
}

/** The middle of the last `n` values, or the mean of the two middle ones when `n` is even. */
export function median(src: number[], n: number): number[] {
  const out = filled(src.length);
  const sorted: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    if (Number.isNaN(x)) {
      sorted.length = 0;
      continue;
    }
    sorted.splice(below(sorted, x), 0, x);
    if (sorted.length > n) sorted.splice(below(sorted, src[i - n]), 1);
    if (sorted.length === n) out[i] = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }
  return out;
}

/** (x - mean) / standard deviation over the last `n` values, both as `sma` and `stdev` take them; unknown when they are all equal. */
export function zscore(src: number[], n: number): number[] {
  return rolling(src, n, (s, e) => {
    // Measured from the window's first value, so a window of equal values has exactly no spread.
    let sum = 0;
    for (let i = s; i <= e; i++) sum += src[i] - src[s];
    const mean = sum / n;
    let sq = 0;
    for (let i = s; i <= e; i++) sq += (src[i] - src[s] - mean) ** 2;
    return sq === 0 ? NaN : (src[e] - src[s] - mean) / Math.sqrt(sq / n);
  });
}

/** The share of the previous `n` values that are below this one, from 0 to 100. */
export function percentRank(src: number[], n: number): number[] {
  const out = filled(src.length);
  const sorted: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    if (Number.isNaN(x)) {
      sorted.length = 0;
      continue;
    }
    if (sorted.length === n) out[i] = (100 * below(sorted, x)) / n;
    sorted.splice(below(sorted, x), 0, x);
    if (sorted.length > n) sorted.splice(below(sorted, src[i - n]), 1);
  }
  return out;
}

/** Slope of the least-squares line through the last `n` values, in the series' units per bar. */
export function slope(src: number[], n: number): number[] {
  const mid = (n - 1) / 2;
  const spread = (n * (n * n - 1)) / 12;
  return rolling(src, n, (s, e) => lineSums(src, s, e, mid)[1] / spread);
}

/**
 * The sums a least-squares line through src[s..e] against the bar number is made of, each value taken less the first so
 * large prices lose no precision: of those values, and of each times its bar's distance from the middle bar `mid`. The
 * second over n (n² - 1) / 12 is the slope.
 */
function lineSums(src: number[], s: number, e: number, mid: number): [number, number] {
  let [total, top] = [0, 0];
  for (let i = s; i <= e; i++) {
    const d = src[i] - src[s];
    total += d;
    top += (i - s - mid) * d;
  }
  return [total, top];
}

/** Pearson correlation of the one-bar changes (as fractions) of `a` and `b` over the last `n` bars; unknown when either is constant. */
export function correl(a: number[], b: number[], n: number): number[] {
  const [ra, rb] = [returns(a), returns(b)];
  const out = filled(a.length);
  let valid = 0;
  for (let i = 0; i < a.length; i++) {
    valid = Number.isNaN(ra[i]) || Number.isNaN(rb[i]) ? 0 : valid + 1;
    if (valid < n) continue;
    const s = i - n + 1;
    let sa = 0;
    let sb = 0;
    for (let j = s; j <= i; j++) {
      sa += ra[j] - ra[s];
      sb += rb[j] - rb[s];
    }
    const [ma, mb] = [sa / n, sb / n];
    let [caa, cbb, cab] = [0, 0, 0];
    for (let j = s; j <= i; j++) {
      const [da, db] = [ra[j] - ra[s] - ma, rb[j] - rb[s] - mb];
      caa += da * da;
      cbb += db * db;
      cab += da * db;
    }
    if (caa > 0 && cbb > 0) out[i] = Math.max(-1, Math.min(1, cab / (Math.sqrt(caa) * Math.sqrt(cbb))));
  }
  return out;
}

/** Bars since the condition (1 where it holds) was last true: 0 on a bar where it is. Unknown until it has been true, and again after a bar where it was unknown, until it is next true. */
export function barsSince(cond: number[]): number[] {
  const out = filled(cond.length);
  let last = -1;
  for (let i = 0; i < cond.length; i++) {
    if (cond[i] === 1) {
      last = i;
      out[i] = 0;
    } else if (Number.isNaN(cond[i])) {
      last = -1;
    } else if (last >= 0) {
      out[i] = i - last;
    }
  }
  return out;
}

/** How many of the last `n` bars the condition held, this one included. Unknown until `n` bars have been read and while any of them is unknown. */
export function count(cond: number[], n: number): number[] {
  return windowSum(cond, n);
}

/** Stochastic %K: where the close sits in the range of the last `n` bars, 0 to 100, averaged over `smooth` bars. */
export function stochK(h: number[], l: number[], c: number[], n: number, smooth: number): number[] {
  const [hh, ll] = [extreme(h, n, 1), extreme(l, n, -1)];
  return sma(c.map((x, i) => (hh[i] > ll[i] ? (100 * (x - ll[i])) / (hh[i] - ll[i]) : NaN)), smooth);
}

/** Stochastic %D: the average of %K over `d` bars. */
export function stochD(h: number[], l: number[], c: number[], n: number, smooth: number, d: number): number[] {
  return sma(stochK(h, l, c, n, smooth), d);
}

/** Williams %R: -100 when the close is at the lowest low of the last `n` bars, 0 when it is at the highest high. */
export function williamsR(h: number[], l: number[], c: number[], n: number): number[] {
  const [hh, ll] = [extreme(h, n, 1), extreme(l, n, -1)];
  return c.map((x, i) => (hh[i] > ll[i] ? (-100 * (hh[i] - x)) / (hh[i] - ll[i]) : NaN));
}

/** Commodity channel index of the typical price (high + low + close) / 3, with the mean deviation about its average; unknown when the window is flat. */
export function cci(h: number[], l: number[], c: number[], n: number): number[] {
  const tp = typical(h, l, c);
  return rolling(tp, n, (s, e) => {
    let sum = 0;
    for (let i = s; i <= e; i++) sum += tp[i] - tp[s];
    const mean = sum / n;
    let dev = 0;
    for (let i = s; i <= e; i++) dev += Math.abs(tp[i] - tp[s] - mean);
    return dev === 0 ? NaN : (tp[e] - tp[s] - mean) / (0.015 * (dev / n));
  });
}

/** Money flow index: 100 - 100 / (1 + money flowing in over money flowing out) across the last `n` bars, 0 to 100. */
export function mfi(h: number[], l: number[], c: number[], v: number[], n: number): number[] {
  const tp = typical(h, l, c);
  const [inflow, outflow] = [filled(tp.length), filled(tp.length)];
  for (let i = 1; i < tp.length; i++) {
    const flow = tp[i] * v[i];
    if (Number.isNaN(flow + tp[i - 1])) continue;
    inflow[i] = tp[i] > tp[i - 1] ? flow : 0;
    outflow[i] = tp[i] < tp[i - 1] ? flow : 0;
  }
  const count = (x: number[]) => windowSum(x.map((f) => (f > 0 ? 1 : 0)), n);
  const [up, down, ups, downs] = [windowSum(inflow, n), windowSum(outflow, n), count(inflow), count(outflow)];
  return up.map((u, i) => {
    if (Number.isNaN(u + down[i])) return NaN;
    // A sum of no flow is exactly 0, whatever rounding the running sums carry.
    const [a, b] = [ups[i] === 0 ? 0 : u, downs[i] === 0 ? 0 : down[i]];
    return b === 0 ? (a === 0 ? 50 : 100) : 100 - 100 / (1 + a / b);
  });
}

/** On-balance volume: a running total that adds a bar's volume when the close rose and takes it off when it fell. It starts at 0 on the first bar. */
export function obv(c: number[], v: number[]): number[] {
  const out = filled(c.length);
  let total = 0;
  let started = false;
  for (let i = 0; i < c.length; i++) {
    if (!started) {
      if (Number.isNaN(c[i] + v[i])) continue;
      started = true;
    } else if (Number.isNaN(total + c[i] + c[i - 1] + v[i])) {
      total = NaN;
    } else if (c[i] > c[i - 1]) {
      total += v[i];
    } else if (c[i] < c[i - 1]) {
      total -= v[i];
    }
    out[i] = total;
  }
  return out;
}

/** Volume-weighted average of the typical price (high + low + close) / 3 over the last `n` bars; unknown when none of them traded. */
export function vwap(h: number[], l: number[], c: number[], v: number[], n: number): number[] {
  const tp = typical(h, l, c);
  const [money, volume, traded] = [windowSum(tp.map((x, i) => x * v[i]), n), windowSum(v, n), windowSum(v.map((x) => (x > 0 ? 1 : 0)), n)];
  return money.map((m, i) => (traded[i] > 0 ? m / volume[i] : NaN));
}

/** Wilder's directional movement: +DI and -DI (0 to 100) and the directional index DX they make, all from the second bar on. */
function directional(h: number[], l: number[], c: number[], n: number): { plus: number[]; minus: number[]; dx: number[] } {
  const [plusDm, minusDm, range] = [filled(h.length), filled(h.length), filled(h.length)];
  for (let i = 1; i < h.length; i++) {
    const [up, down] = [h[i] - h[i - 1], l[i - 1] - l[i]];
    if (Number.isNaN(up + down)) continue;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
    range[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  const [p, m, r] = [rma(plusDm, n), rma(minusDm, n), rma(range, n)];
  const di = (x: number, total: number) => (total > 0 ? (100 * x) / total : NaN);
  const [plus, minus] = [p.map((x, i) => di(x, r[i])), m.map((x, i) => di(x, r[i]))];
  const dx = plus.map((x, i) => {
    const both = x + minus[i];
    return both === 0 ? 0 : (100 * Math.abs(x - minus[i])) / both;
  });
  return { plus, minus, dx };
}

export function plusDi(h: number[], l: number[], c: number[], n: number): number[] {
  return directional(h, l, c, n).plus;
}

export function minusDi(h: number[], l: number[], c: number[], n: number): number[] {
  return directional(h, l, c, n).minus;
}

/** Average directional index: Wilder's smoothing of DX, seeded with the simple average of its first `n` values. */
export function adx(h: number[], l: number[], c: number[], n: number): number[] {
  return rma(directional(h, l, c, n).dx, n);
}

/**
 * Supertrend. Bands (high + low) / 2 plus and minus `mult` average true ranges, each of which only moves towards the price
 * until the close crosses it. In an uptrend the line is the lower band, and in a downtrend the upper one. The first known
 * bar starts in a downtrend. `up` is 1 in an uptrend and 0 in a downtrend.
 */
export function supertrend(h: number[], l: number[], c: number[], n: number, mult: number): { line: number[]; up: number[] } {
  const range = atr(h, l, c, n);
  const [line, up] = [filled(h.length), filled(h.length)];
  let [upper, lower, rising] = [NaN, NaN, false];
  let started = false;
  for (let i = 0; i < h.length; i++) {
    if (Number.isNaN(range[i])) {
      // Once started, an unknown bar leaves the bands unknown for good, as it does an average.
      if (started) break;
      continue;
    }
    const mid = (h[i] + l[i]) / 2;
    const [high, low] = [mid + mult * range[i], mid - mult * range[i]];
    if (!started) {
      [upper, lower, started] = [high, low, true];
    } else {
      const [prevUpper, prevLower] = [upper, lower];
      upper = high < prevUpper || c[i - 1] > prevUpper ? high : prevUpper;
      lower = low > prevLower || c[i - 1] < prevLower ? low : prevLower;
      rising = rising ? !(c[i] < lower) : c[i] > upper;
    }
    line[i] = rising ? lower : upper;
    up[i] = rising ? 1 : 0;
  }
  return { line, up };
}

/** The sum of each window of `n` known values. */
export function sum(src: number[], n: number): number[] {
  return windowSum(src, n);
}

/** Double exponential average: 2 * e1 - e2, where e1 is ema(src, n) and e2 is the ema of e1. */
export function dema(src: number[], n: number): number[] {
  const e1 = ema(src, n);
  const e2 = ema(e1, n);
  return e1.map((x, i) => 2 * x - e2[i]);
}

/** Triple exponential average: 3 * e1 - 3 * e2 + e3, where e1 is ema(src, n) and each next one is the ema of the one before. */
export function tema(src: number[], n: number): number[] {
  const e1 = ema(src, n);
  const e2 = ema(e1, n);
  const e3 = ema(e2, n);
  return e1.map((x, i) => 3 * x - 3 * e2[i] + e3[i]);
}

/**
 * Kaufman's efficiency ratio over `n` bars: how far the value moved, |x - x[n]|, over how far it travelled, the sum of
 * |x - x[1]| over those bars; 0 to 1. `still` is what a window that did not move gives.
 */
function efficiencyRatio(src: number[], n: number, still: number): number[] {
  return rolling(src, n + 1, (s, e) => {
    let path = 0;
    for (let i = s + 1; i <= e; i++) path += Math.abs(src[i] - src[i - 1]);
    return path === 0 ? still : Math.min(1, Math.abs(src[e] - src[s]) / path);
  });
}

/** Kaufman's efficiency ratio over the last `n` bars; unknown when the window did not move. */
export function efficiency(src: number[], n: number): number[] {
  return efficiencyRatio(src, n, NaN);
}

/**
 * Kaufman's adaptive average: prev + sc * (x - prev), where sc = (ER * (2 / (fast + 1) - 2 / (slow + 1)) + 2 / (slow + 1)) squared
 * and ER is the efficiency ratio over `n` bars, 0 when the window did not move. It starts at the first bar where ER is known,
 * from the value of the bar before it, as TA-Lib does. Once started, an unknown value leaves it unknown for good, as it does an average.
 */
export function kama(src: number[], n: number, fast: number, slow: number): number[] {
  const er = efficiencyRatio(src, n, 0);
  const [f, s] = [2 / (fast + 1), 2 / (slow + 1)];
  const out = filled(src.length);
  let value = NaN;
  let started = false;
  for (let i = 0; i < src.length; i++) {
    if (Number.isNaN(er[i])) {
      if (started) break;
      continue;
    }
    if (!started) [value, started] = [src[i - 1], true];
    value += (er[i] * (f - s) + s) ** 2 * (src[i] - value);
    out[i] = value;
  }
  return out;
}

/**
 * Bars since the highest (`sign` 1) or lowest (-1) of each window of the last `n + 1` known values, a tie going to the most
 * recent, in one pass with a queue of candidates.
 */
function sinceExtreme(src: number[], n: number, sign: 1 | -1): number[] {
  const out = filled(src.length);
  const keep: number[] = [];
  let head = 0;
  let valid = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    if (Number.isNaN(x)) {
      keep.length = 0;
      head = 0;
      valid = 0;
      continue;
    }
    valid++;
    while (keep.length > head && sign * src[keep[keep.length - 1]] <= sign * x) keep.pop();
    keep.push(i);
    if (keep[head] <= i - n - 1) head++;
    if (valid >= n + 1) out[i] = i - keep[head];
  }
  return out;
}

/** Aroon up: 100 * (n - bars since the highest high of the last n + 1 bars) / n, from 0 to 100. */
export function aroonUp(h: number[], n: number): number[] {
  return sinceExtreme(h, n, 1).map((since) => (100 * (n - since)) / n);
}

/** Aroon down: 100 * (n - bars since the lowest low of the last n + 1 bars) / n, from 0 to 100. */
export function aroonDown(l: number[], n: number): number[] {
  return sinceExtreme(l, n, -1).map((since) => (100 * (n - since)) / n);
}

/**
 * Wilder's parabolic SAR, a stop that trails the price: under the lows in an uptrend, over the highs in a downtrend. It starts
 * at the first two bars that have a high, low and close: the trend is up when the second close is above the first and down
 * otherwise, the SAR is the first bar's low in an uptrend and its high in a downtrend, and the extreme point is the second
 * bar's high or low; the second bar is then tested for a reversal like any later one. Each next bar the SAR moves the share
 * `af` of the way to the extreme point, but not past the lows (uptrend) or highs (downtrend) of the two bars before. `af`
 * starts at `step`, grows by `step` each time the trend makes a new extreme, and stops at `max`. A bar that crosses the SAR
 * reverses the trend: the SAR becomes the old extreme point (or that bar's high or low, if further out), the extreme point
 * becomes that bar's low or high, and `af` starts again. Once started, an unknown bar leaves it unknown for good.
 */
export function psar(h: number[], l: number[], c: number[], step: number, max: number): number[] {
  const out = filled(h.length);
  const known = (i: number) => !Number.isNaN(h[i] + l[i] + c[i]);
  let [rising, sar, ep, af] = [false, NaN, NaN, step];
  let started = false;
  for (let i = 1; i < h.length; i++) {
    if (!started) {
      if (!known(i) || !known(i - 1)) continue;
      started = true;
      rising = c[i] > c[i - 1];
      sar = rising ? l[i - 1] : h[i - 1];
      ep = rising ? h[i] : l[i];
    } else {
      if (!known(i)) break;
      sar += af * (ep - sar);
      for (let k = 1; k <= 2; k++) sar = rising ? Math.min(sar, l[i - k]) : Math.max(sar, h[i - k]);
    }
    if (rising ? l[i] < sar : h[i] > sar) {
      rising = !rising;
      sar = rising ? Math.min(ep, l[i]) : Math.max(ep, h[i]);
      ep = rising ? h[i] : l[i];
      af = step;
    } else if (rising ? h[i] > ep : l[i] < ep) {
      ep = rising ? h[i] : l[i];
      af = Math.min(af + step, max);
    }
    out[i] = sar;
  }
  return out;
}

/** Chaikin money flow: the sum of ((close - low) - (high - close)) / (high - low) * volume over the last `n` bars, over their volume; a bar with no range adds 0 to the top. Unknown while none of the bars traded. */
export function cmf(h: number[], l: number[], c: number[], v: number[], n: number): number[] {
  const flow = h.map((hi, i) => (Number.isNaN(hi + l[i] + c[i] + v[i]) ? NaN : hi === l[i] ? 0 : (((c[i] - l[i]) - (hi - c[i])) / (hi - l[i])) * v[i]));
  const [money, volume, traded] = [windowSum(flow, n), windowSum(v, n), windowSum(v.map((x) => (x > 0 ? 1 : 0)), n)];
  return money.map((m, i) => (traded[i] > 0 ? m / volume[i] : NaN));
}

/** The value at the last bar of the least-squares line through each window of `n` values, against the bar number: the line `slope` gives the slope of. */
export function linreg(src: number[], n: number): number[] {
  const mid = (n - 1) / 2;
  const spread = (n * (n * n - 1)) / 12;
  return rolling(src, n, (s, e) => {
    const [total, top] = lineSums(src, s, e, mid);
    return src[s] + total / n + (top / spread) * mid;
  });
}

/** The share of the spread of each window of `n` values that the least-squares line through it explains, 0 to 1; unknown when they are all equal. */
export function rsquared(src: number[], n: number): number[] {
  const mid = (n - 1) / 2;
  const spread = (n * (n * n - 1)) / 12;
  return rolling(src, n, (s, e) => {
    const [total, top] = lineSums(src, s, e, mid);
    const mean = total / n;
    let own = 0;
    for (let i = s; i <= e; i++) own += (src[i] - src[s] - mean) ** 2;
    return own === 0 ? NaN : Math.min(1, (top * top) / (spread * own));
  });
}

/**
 * Consecutive bars the value rose (1, 2, 3, ...) or fell (-1, -2, ...), 0 on a bar equal to the one before. It needs a known
 * change, so it is unknown on the first bar and where either value is unknown, and counts again from the next known change.
 */
export function streak(src: number[]): number[] {
  const out = filled(src.length);
  for (let i = 1; i < src.length; i++) {
    const d = src[i] - src[i - 1];
    if (Number.isNaN(d)) continue;
    const before = out[i - 1];
    out[i] = d > 0 ? (before > 0 ? before + 1 : 1) : d < 0 ? (before < 0 ? before - 1 : -1) : 0;
  }
  return out;
}

function isWeekend(t: number): boolean {
  const d = new Date(t).getUTCDay();
  return d === 0 || d === 6;
}

export function monthKey(t: number): number {
  const d = new Date(t);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/** The Monday-to-Sunday week of `t` as a number that rises by 1 each Monday, as `rebalance: weekly` counts weeks. */
export const weekKey = (t: number): number => Math.floor((Math.floor(t / DAY) + 3) / 7);
export const quarterKey = (t: number): number => Math.floor(monthKey(t) / 3);
export const yearKey = (t: number): number => new Date(t).getUTCFullYear();

/**
 * Where the bar after one starting at a given time would start, in a series whose bars start at `t`: one step on (the
 * smallest gap in the series, a day when it has fewer than two bars), skipping weekends unless the series has weekend bars.
 */
export function barStepper(t: number[]): (x: number) => number {
  let step = Infinity;
  for (let i = 1; i < t.length; i++) step = Math.min(step, t[i] - t[i - 1]);
  if (!Number.isFinite(step)) step = DAY;
  const weekends = t.some(isWeekend);
  return (x) => {
    let next = x + step;
    while (!weekends && isWeekend(next)) next += DAY;
    return next;
  };
}

/** When the bar after the last of `t` would start (barStepper). */
export const nextBarTime = (t: number[]): number => barStepper(t)(t[t.length - 1]);

/**
 * 1 on the last bar of each period: the next bar falls in another one. Past the final bar the next bar is the one
 * nextBarTime expects, so the final bar of a month is known to end it on its own calendar.
 */
export function periodEnds(t: number[], key: (t: number) => number): number[] {
  const after = t.length > 0 ? nextBarTime(t) : NaN;
  return t.map((x, i) => (key(i + 1 < t.length ? t[i + 1] : after) !== key(x) ? 1 : 0));
}

/**
 * The number of each bar's day within its month, counting the days that have a bar: 1 on the month's first such day, the same
 * for every bar of a day. Unknown through the series' first month, which may have begun before its first bar.
 */
export function tradingDay(t: number[]): number[] {
  const month = t.map(monthKey);
  let [count, day] = [0, NaN];
  return t.map((x, i) => {
    const today = Math.floor(x / DAY);
    if (i === 0 || month[i] !== month[i - 1]) count = 1;
    else if (today !== day) count++;
    day = today;
    return month[i] === month[0] ? NaN : count;
  });
}

/**
 * The days with a bar after each bar's day in its month: 0 on the month's last such day. Past the final bar they are the days
 * the series would go on to have, stepping as nextBarTime does, so a holiday after the last price is not known.
 */
export function tradingDaysLeft(t: number[]): number[] {
  const out = filled(t.length);
  if (t.length === 0) return out;
  const month = t.map(monthKey);
  const days = t.map((x) => Math.floor(x / DAY));
  const last = t.length - 1;
  const step = barStepper(t);
  let [left, day, next] = [0, days[last], step(t[last])];
  while (monthKey(next) === month[last]) {
    const today = Math.floor(next / DAY);
    if (today !== day) [left, day] = [left + 1, today];
    // The rest of this day's bars add no day, so go on from its end. A series with repeated times has a step of 0.
    const after = step(Math.max(next, (today + 1) * DAY - 1));
    if (after <= next) break;
    next = after;
  }
  for (let i = last; i >= 0; i--) {
    if (i < last) {
      if (month[i + 1] !== month[i]) left = 0;
      else if (days[i + 1] !== days[i]) left++;
    }
    out[i] = left;
  }
  return out;
}

/**
 * When each bar ends: its start plus the series' step, the smallest gap between its bars. A step of
 * 20 days or more is counted in calendar months, so a monthly bar dated the 1st ends on the 1st of
 * the next month even though February's gap is shorter. With fewer than two bars the end is unknown (NaN).
 */
export function barEnds(t: number[]): number[] {
  let step = Infinity;
  for (let i = 1; i < t.length; i++) if (t[i] > t[i - 1]) step = Math.min(step, t[i] - t[i - 1]);
  if (!Number.isFinite(step)) return t.map(() => NaN);
  if (step < 20 * DAY) return t.map((x) => x + step);
  const months = Math.max(1, Math.round(step / (30.4375 * DAY)));
  let prev = -Infinity;
  return t.map((x) => {
    const d = new Date(x);
    d.setUTCMonth(d.getUTCMonth() + months);
    return (prev = Math.max(prev, d.getTime()));
  });
}

/**
 * When each row of a file of dated values, a CSV file with no prices, is known: at the end of the day it is dated (UTC),
 * however far apart the rows are, since a value dated a day was worked out from that day's close. In a file whose rows
 * are less than a day apart, a row is known at its time plus the shortest gap between rows, as a bar of that length ends.
 */
export function valueEnds(t: number[]): number[] {
  let step = Infinity;
  for (let i = 1; i < t.length; i++) if (t[i] > t[i - 1]) step = Math.min(step, t[i] - t[i - 1]);
  if (step < DAY) return t.map((x) => x + step);
  return t.map((x) => Math.floor(x / DAY) * DAY + DAY);
}

/**
 * For each bar of `to`, the index of the latest bar of `from` that had ended by the time that bar
 * ended, or -1 when none had. Reading another series through this never sees a bar still in progress.
 */
export function alignByEnd(from: number[], to: number[]): number[] {
  return endedBy(from, barEnds(to));
}

/**
 * For each moment in `at` (ascending), the index of the latest bar of `from` that had ended by then, or -1 when none had.
 * `fromEnd` is when each of `from`'s bars ends: barEnds unless given, as valueEnds is for a file of dated values.
 */
export function endedBy(from: number[], at: number[], fromEnd = barEnds(from)): number[] {
  let j = -1;
  return at.map((x) => {
    while (j + 1 < from.length && fromEnd[j + 1] <= x) j++;
    return j;
  });
}

/** A day of the week counts as one a series trades on when at least this share of its bars fall on it, so a stray bar does not. */
const TRADING_DAY = 0.02;

/**
 * The clock a series keeps, as far as its prices show it: where they come from, its bar length (counted as barEnds counts
 * it) and the days of the week it has bars on. Two series with the same clock close their bars together, or at least the
 * data cannot tell that they don't. Bars are stamped with their start, a daily bar at midnight UTC of its trading date
 * whatever the market's hours, so series on different clocks can close the "same" bar hours apart.
 */
export function clockOf(source: string, t: number[]): string {
  let step = Infinity;
  for (let i = 1; i < t.length; i++) if (t[i] > t[i - 1]) step = Math.min(step, t[i] - t[i - 1]);
  const length = !Number.isFinite(step) ? '?' : step < 20 * DAY ? `${step}ms` : `${Math.max(1, Math.round(step / (30.4375 * DAY)))}mo`;
  const count = new Array<number>(7).fill(0);
  // Day 0 of the epoch was a Thursday.
  for (const x of t) count[(((Math.floor(x / DAY) + 4) % 7) + 7) % 7]++;
  const weekdays = count.flatMap((n, d) => (n > 0 && n >= TRADING_DAY * t.length ? [d] : [])).join('');
  // Tiingo dates a listing's bars by its exchange day, as Yahoo does, so the two keep one clock.
  return `${source === 'tiingo' ? 'yahoo' : source} ${length} ${weekdays}`;
}

/** 1 on the first bar of each period; unknown on the series' first bar, whose period may have begun earlier. */
export function periodStarts(t: number[], key: (t: number) => number): number[] {
  return t.map((x, i) => (i === 0 ? NaN : key(x) !== key(t[i - 1]) ? 1 : 0));
}
