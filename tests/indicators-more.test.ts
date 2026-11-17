// The functions added after the first twelve: hand-worked values, a second implementation written straight from each
// definition, and a check that no value uses a later bar.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ind from '../src/indicators.ts';

const round = (xs: number[], d = 4) => xs.map((x) => (Number.isNaN(x) ? null : Number(x.toFixed(d))));
const N = NaN;

// ---------------------------------------------------------------- hand-worked values

test('wma weighs the newest value n and the oldest 1', () => {
  // wma(3) of 1..6 at index 2: (1*1 + 2*2 + 3*3) / (1 + 2 + 3) = 14 / 6; the line then climbs by 1 a bar.
  assert.deepEqual(round(ind.wma([1, 2, 3, 4, 5, 6], 3)), [null, null, 2.3333, 3.3333, 4.3333, 5.3333]);
  // (1*10 + 2*12 + 3*11) / 6 = 67 / 6
  assert.deepEqual(round(ind.wma([10, 12, 11], 3)), [null, null, 11.1667]);
  assert.deepEqual(round(ind.wma([4, 7], 1)), [4, 7]);
});

test('hma(4) is wma(2 * wma(2) - wma(4), 2)', () => {
  // x = 1, 2, 4, 7, 11, 16.
  // wma(2): (1*1 + 2*2) / 3 = 5/3, (2 + 8) / 3 = 10/3, (4 + 14) / 3 = 6, (7 + 22) / 3 = 29/3, (11 + 32) / 3 = 43/3.
  // wma(4): (1*1 + 2*2 + 3*4 + 4*7) / 10 = 4.5, (2 + 8 + 21 + 44) / 10 = 7.5, (4 + 14 + 33 + 64) / 10 = 11.5.
  // raw = 2 * wma(2) - wma(4): 2*6 - 4.5 = 7.5, 2*29/3 - 7.5 = 11.8333, 2*43/3 - 11.5 = 17.1667.
  // hma = wma(raw, 2): (7.5 + 2*11.8333) / 3 = 10.3889, (11.8333 + 2*17.1667) / 3 = 15.3889.
  assert.deepEqual(round(ind.hma([1, 2, 4, 7, 11, 16], 4)), [null, null, null, null, 10.3889, 15.3889]);
  // n = 9: half 4, root 3, so the first value comes at index 9 + 3 - 2 = 10 (wma(9) at 8, then two more raw values).
  const h = ind.hma(Array.from({ length: 14 }, (_, i) => i * i), 9);
  assert.equal(h.findIndex((x) => !Number.isNaN(x)), 10);
});

test('median is the middle value, or the mean of the two middle ones', () => {
  // [5, 1, 9] sorts to 1 5 9; [1, 9, 3] to 1 3 9; [9, 3, 7] to 3 7 9.
  assert.deepEqual(ind.median([5, 1, 9, 3, 7], 3), [N, N, 5, 3, 7]);
  // [5, 1, 9, 3] sorts to 1 3 5 9: (3 + 5) / 2; [1, 9, 3, 7] to 1 3 7 9: (3 + 7) / 2.
  assert.deepEqual(ind.median([5, 1, 9, 3, 7], 4), [N, N, N, 4, 5]);
});

test('zscore divides by the standard deviation that stdev gives, and is unknown on equal values', () => {
  // 2 4 4 4 5 5 7 9: mean 5, deviations -3 -1 -1 -1 0 0 2 4, squares 9 1 1 1 0 0 4 16 = 32, / 8 = 4, so sd 2. (9 - 5) / 2 = 2.
  assert.deepEqual(round(ind.zscore([2, 4, 4, 4, 5, 5, 7, 9], 8)), [null, null, null, null, null, null, null, 2]);
  // 1 2 6: mean 3, squares 4 + 1 + 9 = 14, sd = sqrt(14 / 3) = 2.1602, (6 - 3) / 2.1602 = 1.3887.
  assert.deepEqual(round(ind.zscore([1, 2, 6], 3)), [null, null, 1.3887]);
  assert.deepEqual(ind.zscore([0.1, 0.1, 0.1, 0.1], 3), [N, N, N, N]);
});

test('percent_rank counts the previous n values below this one', () => {
  // Index 3 (5) against 3 1 2: all three below, 100. Index 4 (4) against 1 2 5: two below, 66.67.
  // Index 5 (2) against 2 5 4: none below, since 2 is not below 2: 0.
  assert.deepEqual(round(ind.percentRank([3, 1, 2, 5, 4, 2], 3)), [null, null, null, 100, 66.6667, 0]);
});

test('slope is the least-squares slope per bar', () => {
  // 1 2 4 7 at positions 0..3: mean position 1.5, mean 3.5. Sum of (j - 1.5)(x - 3.5) = 3.75 + 0.75 + 0.25 + 5.25 = 10,
  // over the sum of (j - 1.5)^2 = 5, gives 2.
  assert.deepEqual(round(ind.slope([1, 2, 4, 7], 4)), [null, null, null, 2]);
  // Windows of 3: sum of (j - 1) * x is -1*1 + 1*4 = 3 and -2 + 7 = 5, over 2: 1.5 and 2.5.
  assert.deepEqual(round(ind.slope([1, 2, 4, 7], 3)), [null, null, 1.5, 2.5]);
  assert.deepEqual(ind.slope([3, 3, 3], 3), [N, N, 0]);
});

test('correl is the correlation of the one-bar changes', () => {
  const a = [100, 101, 101 * 1.02, 101 * 1.02 * 1.03];
  // The changes of a are .01 .02 .03; of b .01 .03 .02. Means 2 and 2 (in hundredths), deviations -1 0 1 and -1 1 0:
  // the sum of products is 1, and both sums of squares are 2, so 1 / 2 = 0.5.
  const b = [100, 101, 101 * 1.03, 101 * 1.03 * 1.02];
  assert.deepEqual(round(ind.correl(a, b, 3)), [null, null, null, 0.5]);
  // Opposite changes: -1. The same changes: 1.
  const down = [100, 90, 99, 89.1];
  const up = [100, 110, 99, 108.9];
  assert.deepEqual(round(ind.correl(up, down, 3)), [null, null, null, -1]);
  assert.deepEqual(round(ind.correl(up, up, 3)), [null, null, null, 1]);
  // A series that does not move has no correlation.
  assert.deepEqual(ind.correl(up, [5, 5, 5, 5], 3), [N, N, N, N]);
});

test('bars_since counts from the last bar the condition held, and is unknown until then and after an unknown bar', () => {
  assert.deepEqual(ind.barsSince([N, 0, 1, 0, 0, 1, 0, N, 0, 1, 0]), [N, N, 0, 1, 2, 0, 1, N, N, 0, 1]);
});

const H = [10, 12, 11, 13, 12];
const L = [8, 9, 9, 10, 10];
const C = [9, 11, 10, 12, 11];

test('stoch_k is where the close sits in the range of the last n bars', () => {
  // n = 3 at index 2: highest high 12, lowest low 8, close 10: 100 * (10 - 8) / (12 - 8) = 50.
  // Index 3: 13 and 9, close 12: 100 * 3 / 4 = 75. Index 4: 13 and 9, close 11: 100 * 2 / 4 = 50.
  assert.deepEqual(round(ind.stochK(H, L, C, 3, 1)), [null, null, 50, 75, 50]);
  // Averaged over 2: (50 + 75) / 2 and (75 + 50) / 2.
  assert.deepEqual(round(ind.stochK(H, L, C, 3, 2)), [null, null, null, 62.5, 62.5]);
  // %D averages that over 2 more bars: (62.5 + 62.5) / 2 at index 4.
  assert.deepEqual(round(ind.stochD(H, L, C, 3, 2, 2)), [null, null, null, null, 62.5]);
  // A range with no height is unknown.
  assert.deepEqual(ind.stochK([5, 5], [5, 5], [5, 5], 2, 1), [N, N]);
});

test('williams_r is -100 at the lowest low and 0 at the highest high', () => {
  // Same bars: -100 * (12 - 10) / 4 = -50, -100 * (13 - 12) / 4 = -25, -100 * (13 - 11) / 4 = -50.
  assert.deepEqual(round(ind.williamsR(H, L, C, 3)), [null, null, -50, -25, -50]);
});

test('cci measures the typical price against its average and its mean deviation', () => {
  // Typical prices (h + l + c) / 3: 9, 32/3, 10, 35/3, 11. For n = 3 at index 2 the average is 89/9 and the deviations
  // -8/9, 7/9, 1/9, whose absolute values add to 16/9, so the mean deviation is 16/27.
  // (10 - 89/9) / (0.015 * 16/27) = (1/9) / 0.0088889 = 12.5.
  // At index 3 the average is 97/9 and the deviations are -1/9, -7/9, 8/9: the same mean deviation, and (35/3 - 97/9) = 8/9, so 100.
  const c = ind.cci(H, L, C, 3);
  assert.deepEqual(round(c.slice(0, 4), 3), [null, null, 12.5, 100]);
  assert.deepEqual(ind.cci([5, 5, 5], [5, 5, 5], [5, 5, 5], 3), [N, N, N]);
});

test('mfi compares money flowing in with money flowing out', () => {
  // High, low and close all equal, so the typical price is the close. Closes 10 11 10 12 12 13, volumes 100 200 100 300 50 100.
  // Flows (price * volume), counted in when the price rose and out when it fell: 2200 in, 1000 out, 3600 in, none (equal), 1300 in.
  // n = 3 at index 3: in 2200 + 3600 = 5800, out 1000: 100 - 100 / (1 + 5.8) = 85.2941.
  // Index 4: in 3600, out 1000: 100 - 100 / 4.6 = 78.2609. Index 5: in 3600 + 1300, out 0: 100.
  const c = [10, 11, 10, 12, 12, 13];
  const m = ind.mfi(c, c, c, [100, 200, 100, 300, 50, 100], 3);
  assert.deepEqual(round(m), [null, null, null, 85.2941, 78.2609, 100]);
  // No flow either way is 50, as with rsi.
  assert.deepEqual(ind.mfi([5, 5, 5], [5, 5, 5], [5, 5, 5], [1, 1, 1], 2), [N, N, 50]);
});

test('obv adds the volume of a rising bar and takes off that of a falling one, from 0 on the first bar', () => {
  // Closes 10 11 10 10 12, volumes 5 7 3 4 6: 0, +7, -3 = 4, equal (4), +6 = 10.
  assert.deepEqual(ind.obv([10, 11, 10, 10, 12], [5, 7, 3, 4, 6]), [0, 7, 4, 4, 10]);
});

test('vwap weighs the typical price by volume, and is unknown over bars that did not trade', () => {
  // Typical prices 9 and 11 with volumes 100 and 300: (9 * 100 + 11 * 300) / 400 = 10.5.
  assert.deepEqual(ind.vwap([10, 12], [8, 10], [9, 11], [100, 300], 2), [N, 10.5]);
  assert.deepEqual(ind.vwap([10, 12, 14], [8, 10, 12], [9, 11, 13], [0, 0, 5], 2), [N, N, 13]);
});

test('plus_di, minus_di and adx follow Wilder, smoothing from the second bar', () => {
  // n = 2. Bars (high, low, close): (10, 8, 9) (11, 9, 10) (12, 10, 11) (11, 9, 10) (13, 10, 12).
  // From the second bar: +DM 1, 1, 0, 2 (a rise in the high that beats the fall in the low); -DM 0, 0, 1, 0; true range 2, 2, 2, 3.
  // Smoothing seeds with the mean of the first two, then s + (x - s) / 2:
  //   +DM: 1, 0.5, 1.25.   -DM: 0, 0.5, 0.25.   range: 2, 2, 2.5.
  // +DI = 100 * +DM / range: 50, 25, 50. -DI: 0, 25, 10.
  // DX = 100 * |+DI - -DI| / (+DI + -DI): 100, 0, 66.6667.
  // adx seeds with the mean of the first two DX values, (100 + 0) / 2 = 50 at index 3, then (50 * 1 + 66.6667) / 2 = 58.3333.
  const h = [10, 11, 12, 11, 13];
  const l = [8, 9, 10, 9, 10];
  const c = [9, 10, 11, 10, 12];
  assert.deepEqual(round(ind.plusDi(h, l, c, 2)), [null, null, 50, 25, 50]);
  assert.deepEqual(round(ind.minusDi(h, l, c, 2)), [null, null, 0, 25, 10]);
  assert.deepEqual(round(ind.adx(h, l, c, 2)), [null, null, null, 50, 58.3333]);
});

test('adx(1) is DX itself, and a bar with no range leaves it unknown for good, as it does any average', () => {
  // n = 1: no smoothing. Bars (10, 8, 9) (11, 9, 10) (12, 9, 11): +DM 1, 1; -DM 0, 0; true range 2, 3.
  // +DI 50, 33.33; -DI 0, 0; DX 100, 100.
  assert.deepEqual(round(ind.adx([10, 11, 12], [8, 9, 9], [9, 10, 11], 1)), [null, 100, 100]);
  // A bar that opens, trades and closes at the last close has a true range of 0, so no DI to divide: unknown, and so is every later value.
  assert.deepEqual(ind.adx([10, 11, 10, 12], [8, 9, 10, 10], [9, 10, 10, 11], 1).slice(1), [100, N, N]);
});

test('supertrend: bands that only move towards the price until the close crosses one', () => {
  // n = 2, mult 1. Highs 10 11 12 15 16 14 12, lows 8 9 10 12 13 11 9, closes 9 10 11 14 15 12 10.
  // True ranges 2 2 2 4 3 4 3, so the average true range (Wilder, seeded with the first two) is . 2 2 3 3 3.5 3.25.
  // Midpoints 9 10 11 13.5 14.5 12.5 10.5, so the plain bands are upper 12 13 16.5 17.5 16 13.75 and lower 8 9 10.5 11.5 9 7.25.
  // Index 1 starts in a downtrend on the upper band, 12. At 2 the upper band stays 12 (13 is higher, and the close 10 is not above it).
  // At 3 the close of the bar before (11) is not above 12, so the upper band stays 12, and the close 14 is above it: an uptrend,
  // with the lower band 10.5 (it rose from 9). At 4 the close before (14) was above 12, so the upper band resets to 17.5; the
  // lower band rises to 11.5, and the close 15 is above it, so the uptrend goes on. At 5 the upper band falls to 16 and the lower
  // stays 11.5 (9 is lower). At 6 the upper band falls to 13.75 and the close 10 is below the lower band 11.5: a downtrend.
  const h = [10, 11, 12, 15, 16, 14, 12];
  const l = [8, 9, 10, 12, 13, 11, 9];
  const c = [9, 10, 11, 14, 15, 12, 10];
  const s = ind.supertrend(h, l, c, 2, 1);
  assert.deepEqual(round(s.line, 2), [null, 12, 12, 10.5, 11.5, 11.5, 13.75]);
  assert.deepEqual(round(s.up, 2), [null, 0, 0, 1, 1, 1, 0]);
});

// ---------------------------------------------------------------- a second implementation, written from the definitions

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Candles {
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

/** Sixteenths, which a float holds exactly, so equal sums of prices are equal numbers and ties are ties. */
const grid = (x: number) => Math.round(x * 16) / 16;

/**
 * Random bars on a coarse grid of prices, so closes tie, with stretches of identical bars, stretches with no volume, volume spikes
 * and (with `gaps`) missing bars at the start and in the middle, all four values missing together.
 */
function candles(seed: number, n: number, gaps: boolean): Candles {
  const u = rng(seed);
  const out: Candles = { h: [], l: [], c: [], v: [] };
  let px = 100;
  let flat = 0;
  let quiet = 0;
  for (let i = 0; i < n; i++) {
    if (flat === 0 && u() < 0.01) flat = 1 + Math.floor(u() * 30);
    if (quiet === 0 && u() < 0.01) quiet = 1 + Math.floor(u() * 30);
    let high = px;
    let low = px;
    let close = px;
    if (flat > 0) {
      flat--;
    } else {
      const open = grid(px * (1 + (u() - 0.5) * 0.01));
      close = grid(open * (1 + (u() - 0.5) * 0.04));
      high = grid(Math.max(open, close) * (1 + u() * 0.01));
      low = grid(Math.min(open, close) * (1 - u() * 0.01));
      high = Math.max(high, open, close);
      low = Math.min(low, open, close);
    }
    px = close;
    let volume = Math.round(1e5 + 9e5 * u());
    if (u() < 0.02) volume = Math.round(1e8 * u());
    if (quiet > 0) {
      quiet--;
      volume = 0;
    }
    out.h.push(high);
    out.l.push(low);
    out.c.push(close);
    out.v.push(volume);
  }
  if (gaps) {
    const missing = new Set<number>([0, 1, 2, 3, 4, 5, 6]);
    for (let k = 0; k < 6; k++) missing.add(1200 + Math.floor(u() * (n - 1200)));
    for (let k = 0; k < 4; k++) missing.add(1500 + k);
    for (const i of missing) for (const a of [out.h, out.l, out.c, out.v]) a[i] = NaN;
  }
  return out;
}

/** A series for the functions that take one: levels with ties and flat stretches, and (with `gaps`) holes anywhere. */
function levels(seed: number, n: number, gaps: boolean): number[] {
  const u = rng(seed);
  const out: number[] = [];
  let x = 50;
  let flat = 0;
  for (let i = 0; i < n; i++) {
    if (flat === 0 && u() < 0.01) flat = 1 + Math.floor(u() * 25);
    if (flat > 0) flat--;
    else x = grid(Math.max(1, x * (1 + (u() - 0.5) * 0.05)));
    out.push(x);
  }
  if (gaps) {
    for (let i = 0; i < 5; i++) out[i] = NaN;
    for (let k = 0; k < 8; k++) out[5 + Math.floor(u() * (n - 5))] = NaN;
    for (let k = 0; k < 3; k++) out[2000 + k] = NaN;
  }
  return out;
}

const isN = Number.isNaN;
/** The window of `n` values ending at `i`, or null while there are fewer, or when any is unknown. */
function window(a: number[], i: number, n: number): number[] | null {
  if (i - n + 1 < 0) return null;
  const w = a.slice(i - n + 1, i + 1);
  return w.some(isN) ? null : w;
}
const sum = (w: number[]) => w.reduce((s, x) => s + x, 0);
const allEqual = (w: number[]) => w.every((x) => x === w[0]);
const each = (len: number, fn: (i: number) => number) => Array.from({ length: len }, (_, i) => fn(i));

const naive = {
  sma: (a: number[], n: number) =>
    each(a.length, (i) => {
      const w = window(a, i, n);
      return w ? sum(w) / n : N;
    }),
  stochRaw: (k: Candles, n: number) =>
    each(k.c.length, (i) => {
      const [wh, wl] = [window(k.h, i, n), window(k.l, i, n)];
      if (!wh || !wl || isN(k.c[i])) return N;
      const [hi, lo] = [Math.max(...wh), Math.min(...wl)];
      return hi === lo ? N : (100 * (k.c[i] - lo)) / (hi - lo);
    }),
  williams: (k: Candles, n: number) =>
    each(k.c.length, (i) => {
      const [wh, wl] = [window(k.h, i, n), window(k.l, i, n)];
      if (!wh || !wl || isN(k.c[i])) return N;
      const [hi, lo] = [Math.max(...wh), Math.min(...wl)];
      return hi === lo ? N : (-100 * (hi - k.c[i])) / (hi - lo);
    }),
  cci: (k: Candles, n: number) => {
    const tp = k.c.map((c, i) => (k.h[i] + k.l[i] + c) / 3);
    return each(tp.length, (i) => {
      const w = window(tp, i, n);
      if (!w || allEqual(w)) return N;
      const mean = sum(w) / n;
      const md = sum(w.map((x) => Math.abs(x - mean))) / n;
      return (tp[i] - mean) / (0.015 * md);
    });
  },
  mfi: (k: Candles, n: number) => {
    const tp = k.c.map((c, i) => (k.h[i] + k.l[i] + c) / 3);
    return each(tp.length, (i) => {
      let [inflow, outflow] = [0, 0];
      if (i - n + 1 < 1) return N;
      for (let j = i - n + 1; j <= i; j++) {
        if (isN(tp[j]) || isN(tp[j - 1]) || isN(k.v[j])) return N;
        if (tp[j] > tp[j - 1]) inflow += tp[j] * k.v[j];
        else if (tp[j] < tp[j - 1]) outflow += tp[j] * k.v[j];
      }
      return outflow === 0 ? (inflow === 0 ? 50 : 100) : 100 - 100 / (1 + inflow / outflow);
    });
  },
  obv: (k: Candles) => {
    const out: number[] = [];
    let total: number | null = null;
    for (let i = 0; i < k.c.length; i++) {
      if (total === null) {
        if (isN(k.c[i]) || isN(k.v[i])) {
          out.push(N);
          continue;
        }
        total = 0;
      } else if (isN(total) || isN(k.c[i]) || isN(k.c[i - 1]) || isN(k.v[i])) {
        total = N;
      } else {
        total += k.c[i] > k.c[i - 1] ? k.v[i] : k.c[i] < k.c[i - 1] ? -k.v[i] : 0;
      }
      out.push(total);
    }
    return out;
  },
  vwap: (k: Candles, n: number) => {
    const tp = k.c.map((c, i) => (k.h[i] + k.l[i] + c) / 3);
    return each(tp.length, (i) => {
      const [wt, wv] = [window(tp, i, n), window(k.v, i, n)];
      if (!wt || !wv || sum(wv) === 0) return N;
      return sum(wt.map((x, j) => x * wv[j])) / sum(wv);
    });
  },
  wma: (a: number[], n: number) =>
    each(a.length, (i) => {
      const w = window(a, i, n);
      return w ? sum(w.map((x, j) => (j + 1) * x)) / ((n * (n + 1)) / 2) : N;
    }),
  median: (a: number[], n: number) =>
    each(a.length, (i) => {
      const w = window(a, i, n);
      if (!w) return N;
      const s = [...w].sort((x, y) => x - y);
      return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    }),
  zscore: (a: number[], n: number) =>
    each(a.length, (i) => {
      const w = window(a, i, n);
      if (!w || allEqual(w)) return N;
      const mean = sum(w) / n;
      return (a[i] - mean) / Math.sqrt(sum(w.map((x) => (x - mean) ** 2)) / n);
    }),
  percentRank: (a: number[], n: number) =>
    each(a.length, (i) => {
      const w = window(a, i - 1, n);
      if (!w || isN(a[i])) return N;
      return (100 * w.filter((x) => x < a[i]).length) / n;
    }),
  slope: (a: number[], n: number) =>
    each(a.length, (i) => {
      const w = window(a, i, n);
      if (!w) return N;
      const [jm, xm] = [(n - 1) / 2, sum(w) / n];
      let [top, bottom] = [0, 0];
      w.forEach((x, j) => {
        top += (j - jm) * (x - xm);
        bottom += (j - jm) ** 2;
      });
      return allEqual(w) ? 0 : top / bottom;
    }),
  correl: (a: number[], b: number[], n: number) => {
    const [ra, rb] = [a, b].map((x) => x.map((v, i) => (i > 0 ? v / x[i - 1] - 1 : N)));
    return each(a.length, (i) => {
      const [wa, wb] = [window(ra, i, n), window(rb, i, n)];
      if (!wa || !wb || allEqual(wa) || allEqual(wb)) return N;
      const [ma, mb] = [sum(wa) / n, sum(wb) / n];
      const cov = sum(wa.map((x, j) => (x - ma) * (wb[j] - mb)));
      const [va, vb] = [sum(wa.map((x) => (x - ma) ** 2)), sum(wb.map((x) => (x - mb) ** 2))];
      return cov / Math.sqrt(va * vb);
    });
  },
  barsSince: (cond: number[]) =>
    each(cond.length, (i) => {
      for (let j = i; j >= 0; j--) {
        if (isN(cond[j])) return N;
        if (cond[j] === 1) return i - j;
      }
      return N;
    }),
};

/** An average true range as the first twelve functions define it: the first bar's range alone, then Wilder's smoothing seeded with the mean of n. */
function naiveAtr(k: Candles, n: number): number[] {
  const tr = k.c.map((_, i) => (i === 0 ? k.h[0] - k.l[0] : Math.max(k.h[i] - k.l[i], Math.abs(k.h[i] - k.c[i - 1]), Math.abs(k.l[i] - k.c[i - 1]))));
  return wilder(tr, n);
}

/** Wilder's average of `n`: starts at the first known value, seeded with the mean of `n`; a gap after that leaves it unknown for good. */
function wilder(x: number[], n: number): number[] {
  const out = x.map(() => N);
  const start = x.findIndex((v) => !isN(v));
  if (start < 0 || start + n > x.length) return out;
  const seed = x.slice(start, start + n);
  if (seed.some(isN)) return out;
  let avg = sum(seed) / n;
  out[start + n - 1] = avg;
  for (let i = start + n; i < x.length; i++) {
    if (isN(x[i]) || isN(avg)) {
      avg = N;
      continue;
    }
    avg = (avg * (n - 1) + x[i]) / n;
    out[i] = avg;
  }
  return out;
}

/** +DI, -DI and ADX the way Wilder's book writes them: running sums, each one less its own n-th plus the new value. */
function naiveDirectional(k: Candles, n: number) {
  const len = k.c.length;
  const [pdm, mdm, tr] = [N, N, N].map(() => new Array<number>(len).fill(N));
  for (let i = 1; i < len; i++) {
    const [up, down] = [k.h[i] - k.h[i - 1], k.l[i - 1] - k.l[i]];
    if (isN(up + down)) continue;
    pdm[i] = up > down && up > 0 ? up : 0;
    mdm[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(k.h[i] - k.l[i], Math.abs(k.h[i] - k.c[i - 1]), Math.abs(k.l[i] - k.c[i - 1]));
  }
  const smooth = (x: number[]) => {
    const out = x.map(() => N);
    const start = x.findIndex((v) => !isN(v));
    if (start < 0 || start + n > len || x.slice(start, start + n).some(isN)) return out;
    let s = sum(x.slice(start, start + n));
    out[start + n - 1] = s;
    for (let i = start + n; i < len; i++) {
      s = s - s / n + x[i];
      out[i] = s;
    }
    return out;
  };
  const [sp, sm, st] = [smooth(pdm), smooth(mdm), smooth(tr)];
  const plus = sp.map((x, i) => (st[i] > 0 ? (100 * x) / st[i] : N));
  const minus = sm.map((x, i) => (st[i] > 0 ? (100 * x) / st[i] : N));
  const dx = plus.map((p, i) => (isN(p + minus[i]) ? N : p + minus[i] === 0 ? 0 : (100 * Math.abs(p - minus[i])) / (p + minus[i])));
  // ADX: the mean of the first n DX values, then (previous * (n - 1) + DX) / n.
  const adx = dx.map(() => N);
  const first = dx.findIndex((v) => !isN(v));
  if (first >= 0 && first + n <= len && !dx.slice(first, first + n).some(isN)) {
    let a = sum(dx.slice(first, first + n)) / n;
    adx[first + n - 1] = a;
    for (let i = first + n; i < len; i++) {
      a = isN(dx[i]) ? N : (a * (n - 1) + dx[i]) / n;
      adx[i] = a;
    }
  }
  return { plus, minus, adx };
}

/** Supertrend as TradingView writes it, with explicit bands and trend direction; once the average true range is unknown after being known, so is everything after. */
function naiveSupertrend(k: Candles, n: number, mult: number) {
  const a = naiveAtr(k, n);
  const [line, up] = [k.c.map(() => N), k.c.map(() => N)];
  const [finalUpper, finalLower] = [k.c.map(() => N), k.c.map(() => N)];
  const trendUp: boolean[] = [];
  const first = a.findIndex((x) => !isN(x));
  for (let i = first; first >= 0 && i < k.c.length && !isN(a[i]); i++) {
    const mid = (k.h[i] + k.l[i]) / 2;
    const [upper, lower] = [mid + mult * a[i], mid - mult * a[i]];
    if (i === first) {
      finalUpper[i] = upper;
      finalLower[i] = lower;
      trendUp[i] = false;
    } else {
      finalUpper[i] = upper < finalUpper[i - 1] || k.c[i - 1] > finalUpper[i - 1] ? upper : finalUpper[i - 1];
      finalLower[i] = lower > finalLower[i - 1] || k.c[i - 1] < finalLower[i - 1] ? lower : finalLower[i - 1];
      trendUp[i] = trendUp[i - 1] ? !(k.c[i] < finalLower[i]) : k.c[i] > finalUpper[i];
    }
    line[i] = trendUp[i] ? finalLower[i] : finalUpper[i];
    up[i] = trendUp[i] ? 1 : 0;
  }
  return { line, up };
}

function same(actual: number[], expected: number[], label: string, tol = 1e-9): void {
  assert.equal(actual.length, expected.length, `${label}: length`);
  let compared = 0;
  for (let i = 0; i < actual.length; i++) {
    const [a, b] = [actual[i], expected[i]];
    if (isN(a) || isN(b)) {
      assert.ok(isN(a) && isN(b), `${label}: bar ${i} is ${a}, the definition gives ${b}`);
    } else {
      assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${label}: bar ${i} is ${a}, the definition gives ${b}`);
      compared++;
    }
  }
  assert.ok(compared >= 100 || /flat|quiet/.test(label), `${label}: only ${compared} values were compared`);
}

const BARS = 3000;
const PERIODS = [1, 2, 3, 5, 14, 30];

for (const gaps of [false, true]) {
  const k = candles(11, BARS, gaps);
  const x = levels(23, BARS, gaps);
  const tag = (name: string, ...p: number[]) => `${name}(${p.join(', ')}) on ${BARS} random bars${gaps ? ' with gaps' : ''}`;

  test(`windowed functions equal the definition: ${gaps ? 'with' : 'without'} gaps`, () => {
    for (const n of PERIODS) {
      same(ind.wma(x, n), naive.wma(x, n), tag('wma', n));
      same(ind.median(x, n), naive.median(x, n), tag('median', n));
      same(ind.percentRank(x, n), naive.percentRank(x, n), tag('percent_rank', n));
      same(ind.williamsR(k.h, k.l, k.c, n), naive.williams(k, n), tag('williams_r', n));
      same(ind.vwap(k.h, k.l, k.c, k.v, n), naive.vwap(k, n), tag('vwap', n));
      same(ind.mfi(k.h, k.l, k.c, k.v, n), naive.mfi(k, n), tag('mfi', n));
      if (n >= 2) {
        same(ind.zscore(x, n), naive.zscore(x, n), tag('zscore', n));
        same(ind.slope(x, n), naive.slope(x, n), tag('slope', n));
        same(ind.cci(k.h, k.l, k.c, n), naive.cci(k, n), tag('cci', n));
      }
      for (const smooth of [1, 3]) {
        const raw = naive.stochRaw(k, n);
        same(ind.stochK(k.h, k.l, k.c, n, smooth), naive.sma(raw, smooth), tag('stoch_k', n, smooth));
        same(ind.stochD(k.h, k.l, k.c, n, smooth, 3), naive.sma(naive.sma(raw, smooth), 3), tag('stoch_d', n, smooth, 3));
      }
    }
  });

  test(`hma equals the definition: ${gaps ? 'with' : 'without'} gaps`, () => {
    for (const n of [2, 3, 4, 9, 16, 21, 50]) {
      const [half, root] = [Math.floor(n / 2), Math.floor(Math.sqrt(n))];
      const [fast, slow] = [naive.wma(x, half), naive.wma(x, n)];
      same(ind.hma(x, n), naive.wma(fast.map((f, i) => 2 * f - slow[i]), root), tag('hma', n));
    }
  });

  test(`correl, bars_since and obv equal the definition: ${gaps ? 'with' : 'without'} gaps`, () => {
    const other = levels(77, BARS, gaps);
    other[300] = other[301] = other[302] = other[303] = other[304] = other[305] = 40;
    for (const n of [2, 3, 5, 20, 60]) {
      same(ind.correl(x, other, n), naive.correl(x, other, n), tag('correl', n));
      assert.deepEqual(ind.correl(x, x, n).filter((v) => !isN(v) && Math.abs(v - 1) > 1e-9), [], 'correl with itself is 1 or unknown');
    }
    const cond = x.map((v, i) => (isN(v) || isN(x[i - 1]) ? N : v > x[i - 1] * 1.015 ? 1 : 0));
    same(ind.barsSince(cond), naive.barsSince(cond), 'bars_since');
    same(ind.obv(k.c, k.v), naive.obv(k), 'obv');
  });

  test(`adx, plus_di, minus_di equal Wilder's definition: ${gaps ? 'with' : 'without'} gaps`, () => {
    for (const n of PERIODS.filter((p) => p > 1)) {
      const w = naiveDirectional(k, n);
      same(ind.plusDi(k.h, k.l, k.c, n), w.plus, tag('plus_di', n));
      same(ind.minusDi(k.h, k.l, k.c, n), w.minus, tag('minus_di', n));
      same(ind.adx(k.h, k.l, k.c, n), w.adx, tag('adx', n));
    }
  });

  test(`supertrend equals the definition: ${gaps ? 'with' : 'without'} gaps`, () => {
    for (const [n, m] of [[1, 1], [2, 1.5], [10, 3], [14, 2.5], [30, 0.5]]) {
      const w = naiveSupertrend(k, n, m);
      const got = ind.supertrend(k.h, k.l, k.c, n, m);
      same(got.line, w.line, tag('supertrend', n, m));
      same(got.up, w.up, tag('supertrend_up', n, m));
    }
  });
}

test('stretches with no range, no volume and no change have no value rather than a made-up one', () => {
  // 40 identical bars, then moving bars: a flat range, no volume, nothing that rose or fell.
  const flat = (len: number) => new Array<number>(len).fill(50);
  const h = [...flat(40), ...[51, 52, 51, 53, 54, 52]];
  const l = [...flat(40), ...[49, 50, 49, 51, 52, 50]];
  const c = [...flat(40), ...[50, 51, 50, 52, 53, 51]];
  const v = [...flat(40).map(() => 0), 10, 10, 10, 10, 10, 10];
  const k = { h, l, c, v };
  same(ind.stochK(h, l, c, 5, 1), naive.stochRaw(k, 5), 'flat stoch');
  same(ind.cci(h, l, c, 5), naive.cci(k, 5), 'flat cci');
  same(ind.mfi(h, l, c, v, 5), naive.mfi(k, 5), 'quiet mfi');
  same(ind.vwap(h, l, c, v, 5), naive.vwap(k, 5), 'quiet vwap');
  same(ind.adx(h, l, c, 5), naiveDirectional(k, 5).adx, 'flat adx');
  same(ind.zscore(c, 5), naive.zscore(c, 5), 'flat zscore');
  assert.ok(Number.isNaN(ind.stochK(h, l, c, 5, 1)[20]));
  assert.ok(Number.isNaN(ind.cci(h, l, c, 5)[20]));
  assert.equal(ind.mfi(h, l, c, v, 5)[20], 50);
  assert.ok(Number.isNaN(ind.vwap(h, l, c, v, 5)[20]));
  assert.equal(ind.slope(c, 5)[20], 0);
  // Directional movement waits for a range, then reads it: the first adx is known only once there is one.
  assert.ok(Number.isNaN(ind.plusDi(h, l, c, 5)[20]));
  assert.ok(!Number.isNaN(ind.plusDi(h, l, c, 5)[45]));
});

test('a window of equal values has no spread even when its sum is not exact', () => {
  // 0.1 + 0.1 + 0.1 is 0.30000000000000004, so a mean made of that sum is not 0.1 and stdev gives a tiny positive number.
  const x = [0.1, 0.1, 0.1, 0.1, 0.1];
  assert.ok(ind.stdev(x, 3)[2] > 0, 'the premise: stdev of equal values is not exactly 0');
  assert.deepEqual(ind.zscore(x, 3), [N, N, N, N, N]);
  assert.deepEqual(ind.slope(x, 3).slice(2), [0, 0, 0]);
  assert.deepEqual(ind.cci(x, x, x, 3), [N, N, N, N, N]);
});

// ---------------------------------------------------------------- no value uses a later bar

test('computing on the first k bars gives the same first k values as computing on all of them', () => {
  const k = candles(5, 700, true);
  const x = levels(9, 700, true);
  const y = levels(10, 700, true);
  const cond = x.map((v, i) => (isN(v) || isN(x[i - 1]) ? N : v > x[i - 1] ? 1 : 0));
  const cuts = [0, 1, 2, 3, 7, 8, 9, 10, 15, 16, 31, 32, 33, 64, 100, 257, 499, 500, 501, 699];
  const subjects: [string, (cut: number) => number[]][] = [];
  const add = (name: string, fn: (cut: number) => number[]) => subjects.push([name, fn]);
  const hlc = (cut: number): [number[], number[], number[]] => [k.h.slice(0, cut), k.l.slice(0, cut), k.c.slice(0, cut)];
  const hlcv = (cut: number): [number[], number[], number[], number[]] => [...hlc(cut), k.v.slice(0, cut)];
  for (const n of [2, 5, 14]) {
    add(`stoch_k ${n}`, (cut) => ind.stochK(...hlc(cut), n, 3));
    add(`stoch_d ${n}`, (cut) => ind.stochD(...hlc(cut), n, 3, 3));
    add(`williams_r ${n}`, (cut) => ind.williamsR(...hlc(cut), n));
    add(`cci ${n}`, (cut) => ind.cci(...hlc(cut), n));
    add(`adx ${n}`, (cut) => ind.adx(...hlc(cut), n));
    add(`plus_di ${n}`, (cut) => ind.plusDi(...hlc(cut), n));
    add(`minus_di ${n}`, (cut) => ind.minusDi(...hlc(cut), n));
    add(`mfi ${n}`, (cut) => ind.mfi(...hlcv(cut), n));
    add(`vwap ${n}`, (cut) => ind.vwap(...hlcv(cut), n));
    add(`supertrend ${n}`, (cut) => ind.supertrend(...hlc(cut), n, 2).line);
    add(`supertrend_up ${n}`, (cut) => ind.supertrend(...hlc(cut), n, 2).up);
    add(`wma ${n}`, (cut) => ind.wma(x.slice(0, cut), n));
    add(`hma ${n}`, (cut) => ind.hma(x.slice(0, cut), n));
    add(`median ${n}`, (cut) => ind.median(x.slice(0, cut), n));
    add(`zscore ${n}`, (cut) => ind.zscore(x.slice(0, cut), n));
    add(`percent_rank ${n}`, (cut) => ind.percentRank(x.slice(0, cut), n));
    add(`slope ${n}`, (cut) => ind.slope(x.slice(0, cut), n));
    add(`correl ${n}`, (cut) => ind.correl(x.slice(0, cut), y.slice(0, cut), n));
  }
  add('obv', (cut) => ind.obv(k.c.slice(0, cut), k.v.slice(0, cut)));
  add('bars_since', (cut) => ind.barsSince(cond.slice(0, cut)));
  const whole = (fn: (cut: number) => number[]) => fn(700);
  for (const [name, fn] of subjects) {
    const all = whole(fn);
    for (const cut of cuts) {
      const part = fn(cut);
      assert.equal(part.length, cut, `${name}: length on ${cut} bars`);
      assert.deepEqual(part, all.slice(0, cut), `${name}: the first ${cut} values change with the bars after them`);
    }
  }
});

// ---------------------------------------------------------------- speed

test('rolling functions take time in proportion to the bars, not to the bars times the window', () => {
  const k = candles(3, 20000, false);
  const time = (fn: () => void) => {
    fn();
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) fn();
    return performance.now() - t0;
  };
  // A window of 5000 against 5: a loop over each window would make the first take a thousand times as long.
  const calls: [string, (n: number) => void][] = [
    ['stoch_k', (n) => ind.stochK(k.h, k.l, k.c, n, 3)],
    ['williams_r', (n) => ind.williamsR(k.h, k.l, k.c, n)],
    ['mfi', (n) => ind.mfi(k.h, k.l, k.c, k.v, n)],
    ['vwap', (n) => ind.vwap(k.h, k.l, k.c, k.v, n)],
    ['wma', (n) => ind.wma(k.c, n)],
  ];
  for (const [name, fn] of calls) {
    const [small, large] = [time(() => fn(5)), time(() => fn(5000))];
    assert.ok(large < 8 * small + 30, `${name}: ${large.toFixed(1)} ms for a window of 5000 against ${small.toFixed(1)} ms for 5`);
  }
});
