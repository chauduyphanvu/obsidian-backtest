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
  return rolling(src, n, (s, e) => {
    let m = -Infinity;
    for (let i = s; i <= e; i++) if (src[i] > m) m = src[i];
    return m;
  });
}

export function lowest(src: number[], n: number): number[] {
  return rolling(src, n, (s, e) => {
    let m = Infinity;
    for (let i = s; i <= e; i++) if (src[i] < m) m = src[i];
    return m;
  });
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

/** The highest (`sign` 1) or lowest (-1) of each full window of `n` known values, in one pass with a queue of candidates. */
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
    while (keep.length > head && sign * src[keep[keep.length - 1]] <= sign * x) keep.pop();
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
  return rolling(src, n, (s, e) => {
    let top = 0;
    for (let i = s; i <= e; i++) top += (i - s - mid) * (src[i] - src[s]);
    return top / spread;
  });
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

function isWeekend(t: number): boolean {
  const d = new Date(t).getUTCDay();
  return d === 0 || d === 6;
}

export function monthKey(t: number): number {
  const d = new Date(t);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/**
 * 1 on the last bar of each period: the next bar falls in another one. Past the final bar the next
 * bar is one step on (the smallest gap in the series), skipping weekends unless the series has
 * weekend bars, so the final bar of a month is known to end it on its own calendar.
 */
export function periodEnds(t: number[], key: (t: number) => number): number[] {
  let step = Infinity;
  for (let i = 1; i < t.length; i++) step = Math.min(step, t[i] - t[i - 1]);
  if (!Number.isFinite(step)) step = DAY;
  const weekends = t.some(isWeekend);
  return t.map((x, i) => {
    let next = i + 1 < t.length ? t[i + 1] : x + step;
    if (i + 1 === t.length) while (!weekends && isWeekend(next)) next += DAY;
    return key(next) !== key(x) ? 1 : 0;
  });
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
