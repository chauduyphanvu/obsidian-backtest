// Every function returns an array as long as its input, with NaN where the value is not yet known.

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

const DAY = 86_400_000;

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

/** 1 on the first bar of each period; unknown on the series' first bar, whose period may have begun earlier. */
export function periodStarts(t: number[], key: (t: number) => number): number[] {
  return t.map((x, i) => (i === 0 ? NaN : key(x) !== key(t[i - 1]) ? 1 : 0));
}
