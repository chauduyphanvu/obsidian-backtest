// The functions added after the first thirty-four: hand-worked values, a second implementation written straight from each
// definition and compared on thousands of random bars with gaps, the properties each must have, and a check that no value
// uses a later bar.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ind from '../src/indicators.ts';
import { candles, levels, rng, type Candles } from './random-bars.ts';

const round = (xs: number[], d = 4) => xs.map((x) => (Number.isNaN(x) ? null : Number(x.toFixed(d))));
const N = NaN;
const isN = Number.isNaN;

// ---------------------------------------------------------------- hand-worked values

test('sum adds up the last n values, and is unknown until n of them are known', () => {
  assert.deepEqual(ind.sum([1, 2, 3, 4, 5], 3), [N, N, 6, 9, 12]);
  // A gap makes every window that holds it unknown.
  assert.deepEqual(ind.sum([1, 2, N, 4, 5, 6], 2), [N, 3, N, N, 9, 11]);
  assert.deepEqual(ind.sum([4, 7], 1), [4, 7]);
});

test('sum is not a running total, so a large value leaves nothing behind once it has left the window', () => {
  // A running total that took the old values off would keep a trace of the 1e15 (whose last digits it cannot hold); each window is added on its own.
  assert.deepEqual(ind.sum([0.5, 1e15, 0.25, 0, 0], 2).slice(2), [1e15 + 0.25, 0.25, 0]);
  assert.equal(ind.sum([1e6, 2e6, 0.1, 0.1, 0.1, 0.1, 0.1], 3)[6], 0.1 + 0.1 + 0.1);
});

test('dema(2) and tema(2) of a straight line are the line, since they cancel the lag of the exponential averages', () => {
  // ema(2) of 1..6 seeds with 1.5 at index 1 and then follows 0.5 behind: 1.5 2.5 3.5 4.5 5.5. Its own ema(2) seeds with
  // 2 at index 2 and then follows 1 behind: 2 3 4 5. dema = 2 * e1 - e2 = 2 * 2.5 - 2 = 3, then 4, 5, 6.
  assert.deepEqual(round(ind.dema([1, 2, 3, 4, 5, 6], 2)), [null, null, 3, 4, 5, 6]);
  // e3 = ema(2) of e2 seeds with 2.5 at index 3: 2.5 3.5 4.5. tema = 3 * e1 - 3 * e2 + e3 = 10.5 - 9 + 2.5 = 4, then 5, 6.
  assert.deepEqual(round(ind.tema([1, 2, 3, 4, 5, 6], 2)), [null, null, null, 4, 5, 6]);
});

test('dema(2) of 1 3 2 6 worked out by hand', () => {
  // e1: seed (1 + 3) / 2 = 2 at index 1, then 2 + 2/3 * (2 - 2) = 2, then 2 + 2/3 * (6 - 2) = 4.6667.
  // e2: seed (2 + 2) / 2 = 2 at index 2, then 2 + 2/3 * (4.6667 - 2) = 3.7778. dema: 2 * 2 - 2 = 2 and 2 * 4.6667 - 3.7778 = 5.5556.
  assert.deepEqual(round(ind.dema([1, 3, 2, 6], 2)), [null, null, 2, 5.5556]);
});

test('efficiency is how far the value moved over how far it travelled, and unknown when it did not move', () => {
  // 10 11 12 11 13 with n = 2: |12 - 10| / (1 + 1) = 1, |11 - 11| / (1 + 1) = 0, |13 - 12| / (1 + 2) = 1/3.
  assert.deepEqual(round(ind.efficiency([10, 11, 12, 11, 13], 2)), [null, null, 1, 0, 0.3333]);
  assert.deepEqual(ind.efficiency([5, 5, 5], 2), [N, N, N]);
  // n = 1 is 1 whenever the value changed.
  assert.deepEqual(ind.efficiency([5, 6, 6, 4], 1), [N, 1, N, 1]);
});

test('kama starts from the price before its first known efficiency ratio and then follows its formula', () => {
  // 10 11 12 11 13, n = 2, fast 2 (2/3), slow 30 (2/31). The first ER is at index 2 (|12 - 10| / 2 = 1), so the seed is the price of index 1, 11.
  // sc = (1 * (2/3 - 2/31) + 2/31)^2 = (2/3)^2 = 0.4444, so kama = 11 + 0.4444 * (12 - 11) = 11.4444.
  // Index 3: ER 0, sc = (2/31)^2 = 0.0041623, kama = 11.4444 + 0.0041623 * (11 - 11.4444) = 11.44259.
  // Index 4: ER 1/3, sc = (1/3 * (2/3 - 2/31) + 2/31)^2 = 0.070349, kama = 11.44259 + 0.070349 * (13 - 11.44259) = 11.55216.
  assert.deepEqual(round(ind.kama([10, 11, 12, 11, 13], 2, 2, 30), 5), [null, null, 11.44444, 11.44259, 11.55216]);
});

test('kama of a window that does not move reads ER as 0 and stays where the slow smoothing puts it', () => {
  const flat = [7, 7, 7, 7, 7];
  assert.deepEqual(ind.kama(flat, 2, 2, 30), [N, N, 7, 7, 7]);
  // With fast = slow, sc does not depend on ER: it is (2 / 5) squared on every bar.
  const x = [10, 12, 11, 13];
  const sc = (2 / 5) ** 2;
  const first = 12 + sc * (11 - 12);
  assert.deepEqual(round(ind.kama(x, 2, 4, 4), 6), round([N, N, first, first + sc * (13 - first)], 6));
});

test('aroon counts the bars since the highest high or lowest low of the last n + 1 bars, a tie going to the most recent', () => {
  // Highs 1 3 2 3 1 0 with n = 3 (windows of 4 bars). At index 3 the window 1 3 2 3 has its high twice, the later one on this bar: 0 bars ago, 100.
  // At 4 the window 3 2 3 1: the later 3 is 1 bar ago, 100 * (3 - 1) / 3 = 66.67. At 5, the window 2 3 1 0: 2 bars ago, 33.33.
  assert.deepEqual(round(ind.aroonUp([1, 3, 2, 3, 1, 0], 3)), [null, null, null, 100, 66.6667, 33.3333]);
  // Lows 5 4 4 6 5 7: at 3 the window 5 4 4 6 has its low at index 2 (the later of two), 1 bar ago: 66.67. At 4: 4 4 6 5, 2 bars ago: 33.33. At 5: 4 6 5 7, 3 bars ago: 0.
  assert.deepEqual(round(ind.aroonDown([5, 4, 4, 6, 5, 7], 3)), [null, null, null, 66.6667, 33.3333, 0]);
  // n = 1 compares this bar with the one before: 100 when the high is at least as high, else 0.
  assert.deepEqual(ind.aroonUp([1, 2, 2, 1], 1), [N, 100, 100, 0]);
});

test('psar follows Wilder: the trend picked from the first two closes, a share of the way to the extreme point, and reversals at the SAR', () => {
  // Step 0.1, max 0.3. Bars (high, low, close): 10 8 9 | 11 9 10 | 12 10 11 | 13 11 12 | 13 9 9.5 | 12 8 8.5 | 11 8.5 9 | 14 9 13.
  // Index 1: the close rose (9 to 10), so an uptrend, the SAR is the first low, 8, the extreme point the second high, 11, af 0.1.
  // Index 2: 8 + 0.1 * (11 - 8) = 8.3, but not above the lows of the two bars before (9 and 8): 8. The high 12 is a new extreme: ep 12, af 0.2.
  // Index 3: 8 + 0.2 * (12 - 8) = 8.8, under both lows (10 and 9). ep 13, af 0.3.
  // Index 4: 8.8 + 0.3 * (13 - 8.8) = 10.06, held to 10 by the low of index 2. The low 9 is below it: the trend reverses, the SAR is the old extreme, 13, ep 9, af 0.1.
  // Index 5: 13 + 0.1 * (9 - 13) = 12.6, held to 13 by the highs of the two bars before. The low 8 is a new extreme: ep 8, af 0.2.
  // Index 6: 13 + 0.2 * (8 - 13) = 12, held to 13 (the high of index 4). No new extreme.
  // Index 7: 13 + 0.2 * (8 - 13) = 12, over the highs of the two bars before (11 and 12). The high 14 is above it: it reverses to an uptrend, with the SAR the old extreme, 8.
  const h = [10, 11, 12, 13, 13, 12, 11, 14];
  const l = [8, 9, 10, 11, 9, 8, 8.5, 9];
  const c = [9, 10, 11, 12, 9.5, 8.5, 9, 13];
  assert.deepEqual(round(ind.psar(h, l, c, 0.1, 0.3)), [null, 8, 8, 8.8, 13, 13, 13, 8]);
});

test('psar starts in a downtrend when the second close is not above the first, from the first high', () => {
  // Highs 10 9.5 9, lows 8 7.5 7, closes 9 8 7.5, step 0.1. Index 1: down, SAR 10, ep 7.5. Index 2: 10 + 0.1 * (7.5 - 10) = 9.75, held to 10 by the first high.
  assert.deepEqual(ind.psar([10, 9.5, 9], [8, 7.5, 7], [9, 8, 7.5], 0.1, 0.3), [N, 10, 10]);
  // Equal closes count as not above.
  assert.equal(ind.psar([10, 10], [8, 8], [9, 9], 0.1, 0.3)[1], 10);
});

test('psar waits for two bars it can use, and an unknown bar after it starts leaves it unknown for good', () => {
  const [h, l, c] = [[N, 10, 11, 12, 13, 14], [N, 8, 9, 10, 11, 12], [N, 9, 10, 11, 12, 13]];
  assert.deepEqual(round(ind.psar(h, l, c, 0.1, 0.3)).map((x) => x === null), [true, true, false, false, false, false]);
  const gap = ind.psar([10, 11, 12, 13, 14], [8, 9, 10, 11, 12], [9, 10, 11, N, 13], 0.1, 0.3);
  assert.deepEqual(gap.map(isN), [true, false, false, true, true]);
});

test('cmf weighs where each close sits in its range by volume, and a bar with no range adds nothing', () => {
  // (high, low, close, volume): (10, 8, 9.5, 100) has a multiplier of ((9.5 - 8) - (10 - 9.5)) / 2 = 0.5, so 50;
  // (12, 10, 10, 200) has ((10 - 10) - (12 - 10)) / 2 = -1, so -200; (11, 11, 11, 50) has no range, so 0, with its volume still counted.
  const [h, l, c, v] = [[10, 12, 11], [8, 10, 11], [9.5, 10, 11], [100, 200, 50]];
  // n = 2: (50 - 200) / 300 = -0.5, then (-200 + 0) / 250 = -0.8. n = 3: (50 - 200 + 0) / 350.
  assert.deepEqual(round(ind.cmf(h, l, c, v, 2)), [null, -0.5, -0.8]);
  assert.deepEqual(round(ind.cmf(h, l, c, v, 3)), [null, null, -0.4286]);
  // No volume in the window gives no value.
  assert.deepEqual(ind.cmf([10, 12], [8, 10], [9, 11], [0, 0], 2), [N, N]);
});

test('linreg is the least-squares line at the last bar, which is the average plus the slope times (n - 1) / 2', () => {
  // 1 2 4 7: the slope is 2 and the average 3.5, so the line at the last of the four positions is 3.5 + 2 * 1.5 = 6.5.
  assert.deepEqual(round(ind.linreg([1, 2, 4, 7], 4)), [null, null, null, 6.5]);
  // Windows of 3: 1 2 4 has slope 1.5 and average 7/3, so 7/3 + 1.5 = 3.8333; 2 4 7 has slope 2.5 and average 13/3, so 6.8333.
  assert.deepEqual(round(ind.linreg([1, 2, 4, 7], 3)), [null, null, 3.8333, 6.8333]);
  // A line through two points passes through both.
  assert.deepEqual(ind.linreg([1, 3, 2], 2), [N, 3, 2]);
  assert.deepEqual(ind.linreg([3, 3, 3], 3), [N, N, 3]);
});

test('rsquared is the share of the spread the line explains, and unknown when the values are all equal', () => {
  // 1 2 4 7: Sxy = 10, Sxx = 5, Syy = 21, so 10^2 / (5 * 21) = 0.9524.
  assert.deepEqual(round(ind.rsquared([1, 2, 4, 7], 4)), [null, null, null, 0.9524]);
  // 1 2 4: Sxy = 3, Sxx = 2, Syy = 14/3, so 9 / (2 * 14/3) = 0.9643. 2 4 7: Sxy = 5, Sxx = 2, Syy = 38/3, so 25 / (2 * 38/3) = 0.9868.
  assert.deepEqual(round(ind.rsquared([1, 2, 4, 7], 3)), [null, null, 0.9643, 0.9868]);
  assert.deepEqual(ind.rsquared([1, 2, 3, 4], 4), [N, N, N, 1]);
  assert.deepEqual(ind.rsquared([1, 5], 2), [N, 1]);
  assert.deepEqual(ind.rsquared([3, 3, 3], 3), [N, N, N]);
});

test('streak counts the bars in a row the value rose or fell, and starts again after an unknown value', () => {
  // 10 11 12 12 11 10 11: up 1, up 2, equal 0, down -1, down -2, up 1.
  assert.deepEqual(ind.streak([10, 11, 12, 12, 11, 10, 11]), [N, 1, 2, 0, -1, -2, 1]);
  // After the unknown value the change into 4 is unknown too, so the count begins at the change from 4 to 5.
  assert.deepEqual(ind.streak([1, 2, N, 4, 5, 6]), [N, 1, N, N, 1, 2]);
  // A rise after a fall, and after an equal bar, starts at 1.
  assert.deepEqual(ind.streak([5, 4, 4, 5]), [N, -1, 0, 1]);
});

// ---------------------------------------------------------------- a second implementation, written from the definitions

const each = (len: number, fn: (i: number) => number) => Array.from({ length: len }, (_, i) => fn(i));
const total = (w: number[]) => w.reduce((s, x) => s + x, 0);
const allEqual = (w: number[]) => w.every((x) => x === w[0]);
/** The window of `n` values ending at `i`, or null while there are fewer, or when any is unknown. */
function window(a: number[], i: number, n: number): number[] | null {
  if (i - n + 1 < 0) return null;
  const w = a.slice(i - n + 1, i + 1);
  return w.some(isN) ? null : w;
}

/** An exponential average as the language defines it: seeded with the simple average of the first n values from the first known one; once an unknown value is in the way, unknown for good. */
function naiveEma(a: number[], n: number): number[] {
  const out = a.map(() => N);
  const start = a.findIndex((v) => !isN(v));
  if (start < 0 || start + n > a.length) return out;
  const seed = a.slice(start, start + n);
  let value = seed.some(isN) ? N : total(seed) / n;
  out[start + n - 1] = value;
  for (let i = start + n; i < a.length; i++) {
    value += (2 / (n + 1)) * (a[i] - value);
    out[i] = value;
  }
  return out;
}

const naive = {
  sum: (a: number[], n: number) =>
    each(a.length, (i) => {
      const w = window(a, i, n);
      return w ? total(w) : N;
    }),
  dema: (a: number[], n: number) => {
    const [e1, e2] = [naiveEma(a, n), naiveEma(naiveEma(a, n), n)];
    return e1.map((x, i) => 2 * x - e2[i]);
  },
  tema: (a: number[], n: number) => {
    const e1 = naiveEma(a, n);
    const e2 = naiveEma(e1, n);
    const e3 = naiveEma(e2, n);
    return e1.map((x, i) => 3 * x - 3 * e2[i] + e3[i]);
  },
  efficiency: (a: number[], n: number) =>
    each(a.length, (i) => {
      const w = window(a, i, n + 1);
      if (!w) return N;
      const travelled = total(w.slice(1).map((x, j) => Math.abs(x - w[j])));
      return travelled === 0 ? N : Math.abs(w[n] - w[0]) / travelled;
    }),
  kama: (a: number[], n: number, fast: number, slow: number) => {
    const out = a.map(() => N);
    const [f, s] = [2 / (fast + 1), 2 / (slow + 1)];
    let value: number | null = null;
    for (let i = n; i < a.length; i++) {
      const w = window(a, i, n + 1);
      if (value === null) {
        if (!w) continue;
        value = a[i - 1];
      }
      if (!w) break;
      const travelled = total(w.slice(1).map((x, j) => Math.abs(x - w[j])));
      const er = travelled === 0 ? 0 : Math.abs(w[n] - w[0]) / travelled;
      value += (er * (f - s) + s) ** 2 * (a[i] - value);
      out[i] = value;
    }
    return out;
  },
  aroon: (a: number[], n: number, sign: 1 | -1) =>
    each(a.length, (i) => {
      const w = window(a, i, n + 1);
      if (!w) return N;
      let best = 0;
      w.forEach((x, j) => {
        if (sign * x >= sign * w[best]) best = j;
      });
      const since = n - best;
      return (100 * (n - since)) / n;
    }),
  cmf: (k: Candles, n: number) =>
    each(k.c.length, (i) => {
      const [wh, wl, wc, wv] = [k.h, k.l, k.c, k.v].map((a) => window(a, i, n));
      if (!wh || !wl || !wc || !wv || total(wv) === 0) return N;
      const top = total(wh.map((hi, j) => (hi === wl[j] ? 0 : (((wc[j] - wl[j]) - (hi - wc[j])) / (hi - wl[j])) * wv[j])));
      return top / total(wv);
    }),
  linreg: (a: number[], n: number) =>
    each(a.length, (i) => {
      const w = window(a, i, n);
      if (!w) return N;
      // The normal equations: slope b = (n * sum(xy) - sum(x) * sum(y)) / (n * sum(xx) - sum(x)^2), intercept (sum(y) - b * sum(x)) / n.
      const xs = w.map((_, j) => j);
      const [sx, sy, sxy, sxx] = [total(xs), total(w), total(xs.map((x, j) => x * w[j])), total(xs.map((x) => x * x))];
      const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      return (sy - b * sx) / n + b * (n - 1);
    }),
  rsquared: (a: number[], n: number) =>
    each(a.length, (i) => {
      const w = window(a, i, n);
      if (!w || allEqual(w)) return N;
      const [xm, ym] = [(n - 1) / 2, total(w) / n];
      const [sxy, sxx, syy] = [total(w.map((y, j) => (j - xm) * (y - ym))), total(w.map((_, j) => (j - xm) ** 2)), total(w.map((y) => (y - ym) ** 2))];
      return (sxy * sxy) / (sxx * syy);
    }),
  streak: (a: number[]) =>
    each(a.length, (i) => {
      if (i === 0 || isN(a[i]) || isN(a[i - 1])) return N;
      const dir = Math.sign(a[i] - a[i - 1]);
      let run = 0;
      for (let j = i; j >= 1 && !isN(a[j]) && !isN(a[j - 1]) && Math.sign(a[j] - a[j - 1]) === dir; j--) run++;
      return dir === 0 ? 0 : dir * run;
    }),
};

/** Wilder's parabolic SAR written out with the state after each bar kept in arrays, each bar worked from the one before. */
function naivePsar(k: Candles, step: number, max: number): number[] {
  const { h, l, c } = k;
  const out = h.map(() => N);
  const known = (i: number) => ![h[i], l[i], c[i]].some(isN);
  const first = h.findIndex((_, i) => i > 0 && known(i - 1) && known(i));
  if (first < 0) return out;
  const [up, sar, ep, af]: [boolean[], number[], number[], number[]] = [[], [], [], []];
  for (let i = first; i < h.length && known(i); i++) {
    let [u, s, e, a] = [true, 0, 0, step];
    if (i === first) {
      u = c[i] > c[i - 1];
      s = u ? l[i - 1] : h[i - 1];
      e = u ? h[i] : l[i];
    } else {
      [u, e, a] = [up[i - 1], ep[i - 1], af[i - 1]];
      s = sar[i - 1] + a * (e - sar[i - 1]);
      s = u ? Math.min(s, l[i - 1], l[i - 2]) : Math.max(s, h[i - 1], h[i - 2]);
    }
    if (u && l[i] < s) [u, s, e, a] = [false, Math.max(e, h[i]), l[i], step];
    else if (!u && h[i] > s) [u, s, e, a] = [true, Math.min(e, l[i]), h[i], step];
    else if (u && h[i] > e) [e, a] = [h[i], Math.min(a + step, max)];
    else if (!u && l[i] < e) [e, a] = [l[i], Math.min(a + step, max)];
    [up[i], sar[i], ep[i], af[i]] = [u, s, e, a];
    out[i] = s;
  }
  return out;
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

/**
 * A series with no holes except a few at the start and, from bar 1,200 on, a few more: the averages that stay unknown once an
 * unknown value has reached them still have a thousand values to compare before it.
 */
function latePatches(seed: number): number[] {
  const u = rng(seed);
  const out = levels(seed, BARS, false);
  for (let i = 0; i < 5; i++) out[i] = NaN;
  for (let k = 0; k < 6; k++) out[1200 + Math.floor(u() * (BARS - 1200))] = NaN;
  for (let k = 0; k < 3; k++) out[2000 + k] = NaN;
  return out;
}

for (const gaps of [false, true]) {
  const k = candles(11, BARS, gaps);
  const x = gaps ? latePatches(23) : levels(23, BARS, false);
  const kind = gaps ? 'with' : 'without';
  const tag = (name: string, ...p: number[]) => `${name}(${p.join(', ')}) on ${BARS} random bars${gaps ? ' with gaps' : ''}`;

  test(`sum, dema, tema, efficiency and streak equal the definition: ${kind} gaps`, () => {
    for (const n of [1, 2, 3, 5, 14, 30]) {
      same(ind.sum(x, n), naive.sum(x, n), tag('sum', n));
      same(ind.dema(x, n), naive.dema(x, n), tag('dema', n));
      same(ind.tema(x, n), naive.tema(x, n), tag('tema', n));
      same(ind.efficiency(x, n), naive.efficiency(x, n), tag('efficiency', n));
    }
    same(ind.streak(x), naive.streak(x), tag('streak'));
    same(ind.streak(k.c), naive.streak(k.c), tag('streak of closes'));
  });

  test(`kama equals the definition: ${kind} gaps`, () => {
    for (const n of [1, 2, 3, 10, 30]) {
      for (const [fast, slow] of [[2, 30], [3, 10], [5, 50], [1, 2]]) same(ind.kama(x, n, fast, slow), naive.kama(x, n, fast, slow), tag('kama', n, fast, slow));
    }
  });

  test(`aroon_up, aroon_down and cmf equal the definition: ${kind} gaps`, () => {
    for (const n of [1, 2, 3, 5, 14, 25, 60]) {
      same(ind.aroonUp(k.h, n), naive.aroon(k.h, n, 1), tag('aroon_up', n));
      same(ind.aroonDown(k.l, n), naive.aroon(k.l, n, -1), tag('aroon_down', n));
      same(ind.cmf(k.h, k.l, k.c, k.v, n), naive.cmf(k, n), tag('cmf', n), 1e-8);
    }
  });

  test(`linreg and rsquared equal the definition: ${kind} gaps`, () => {
    for (const n of [2, 3, 5, 14, 30, 90]) {
      same(ind.linreg(x, n), naive.linreg(x, n), tag('linreg', n), 1e-8);
      same(ind.rsquared(x, n), naive.rsquared(x, n), tag('rsquared', n), 1e-8);
    }
  });

  test(`psar equals the definition: ${kind} gaps`, () => {
    for (const [step, max] of [[0.02, 0.2], [0.1, 0.3], [0.05, 0.05], [0.5, 1], [0.01, 0.4]]) same(ind.psar(k.h, k.l, k.c, step, max), naivePsar(k, step, max), tag('psar', step, max));
  });
}

test('a window of equal values has no efficiency and no r squared, and a line is a line', () => {
  const flat = new Array<number>(30).fill(50);
  const run = [...flat, ...Array.from({ length: 30 }, (_, i) => 50 + i * 0.25)];
  assert.ok(ind.efficiency(run, 5).slice(5, 30).every(isN));
  assert.ok(ind.rsquared(run, 5).slice(4, 30).every(isN));
  // Once the window holds a straight climb, the efficiency is 1 and the fit exact.
  for (const v of ind.efficiency(run, 5).slice(40)) assert.ok(Math.abs(v - 1) < 1e-12);
  for (const v of ind.rsquared(run, 5).slice(40)) assert.ok(Math.abs(v - 1) < 1e-12);
  // linreg of a line is the line, and with the slope it gives the line's own value at an earlier bar.
  const line = Array.from({ length: 40 }, (_, i) => 3 + 0.5 * i);
  ind.linreg(line, 9).forEach((v, i) => i >= 8 && assert.ok(Math.abs(v - line[i]) < 1e-9));
  // kama of a constant is that constant.
  assert.deepEqual(ind.kama(flat, 10, 2, 30).slice(10), new Array<number>(20).fill(50));
});

// ---------------------------------------------------------------- properties each must have

/** Bars from a random walk with no ties, so a SAR never sits exactly on a bar's high and low at once. */
function walk(seed: number, n: number): Candles {
  const u = rng(seed);
  const out: Candles = { h: [], l: [], c: [], v: [] };
  let px = 100;
  for (let i = 0; i < n; i++) {
    const open = px * (1 + (u() - 0.5) * 0.004);
    const close = open * (1 + (u() - 0.49) * 0.03);
    out.h.push(Math.max(open, close) * (1 + u() * 0.01));
    out.l.push(Math.min(open, close) * (1 - u() * 0.01));
    out.c.push(close);
    out.v.push(1000 + Math.floor(u() * 500));
    px = close;
  }
  return out;
}

test('psar is always outside the bar, only moves with the trend, and reverses to the extreme of the trend it ends', () => {
  for (const seed of [1, 2, 3]) {
    const k = walk(seed, 4000);
    for (const [step, max] of [[0.02, 0.2], [0.1, 0.3], [0.5, 1]]) {
      const sar = ind.psar(k.h, k.l, k.c, step, max);
      assert.ok(isN(sar[0]));
      let below = sar[1] <= k.l[1];
      let started = 1;
      let reversals = 0;
      for (let i = 1; i < sar.length; i++) {
        const [under, over] = [sar[i] <= k.l[i], sar[i] >= k.h[i]];
        assert.ok(under !== over, `${seed} bar ${i}: the SAR ${sar[i]} is inside the bar ${k.l[i]}..${k.h[i]}`);
        // A trend that began on the second bar has the first bar before it, whose high or low the SAR may not pass on the bar after.
        if (i > 2 && under === below) assert.ok(below ? sar[i] >= sar[i - 1] : sar[i] <= sar[i - 1], `${seed} bar ${i}: the SAR moved against its trend`);
        if (i > 1 && under !== below) {
          // The trend that ended had its highest high (or lowest low) from its first bar to this one: that is the new SAR.
          const [lo, hi] = [started, i + 1];
          assert.equal(sar[i], below ? Math.max(...k.h.slice(lo, hi)) : Math.min(...k.l.slice(lo, hi)), `${seed} bar ${i}: the SAR at a reversal`);
          started = i;
          reversals++;
        }
        below = under;
      }
      assert.ok(reversals > 100, `${reversals} reversals`);
    }
  }
});

test('ranges: aroon 0 to 100, efficiency 0 to 1, cmf -1 to 1, r squared 0 to 1, and kama between the lowest and highest value', () => {
  const k = candles(5, 3000, true);
  const x = levels(6, 3000, true);
  const within = (xs: number[], lo: number, hi: number, label: string) => {
    const known = xs.filter((v) => !isN(v));
    assert.ok(known.length > 100, label);
    assert.ok(known.every((v) => v >= lo && v <= hi), `${label}: ${Math.min(...known)} to ${Math.max(...known)}`);
  };
  for (const n of [1, 5, 25]) {
    within(ind.aroonUp(k.h, n), 0, 100, 'aroon_up');
    within(ind.aroonDown(k.l, n), 0, 100, 'aroon_down');
    within(ind.efficiency(x, n), 0, 1, 'efficiency');
    within(ind.cmf(k.h, k.l, k.c, k.v, n + 1), -1 - 1e-9, 1 + 1e-9, 'cmf');
  }
  within(ind.rsquared(x, 20), 0, 1, 'rsquared');
  const known = x.filter((v) => !isN(v));
  within(ind.kama(x, 10, 2, 30), Math.min(...known), Math.max(...known), 'kama');
});

test('linreg moves with slope: it is the average plus the slope times (n - 1) / 2', () => {
  const x = levels(8, 2000, false);
  for (const n of [2, 5, 20, 90]) {
    const [line, mean, slope] = [ind.linreg(x, n), ind.sma(x, n), ind.slope(x, n)];
    line.forEach((v, i) => !isN(v) && assert.ok(Math.abs(v - (mean[i] + (slope[i] * (n - 1)) / 2)) < 1e-9 * 50, `n ${n} bar ${i}`));
    assert.ok(line.filter((v) => !isN(v)).length > 1900);
  }
});

// ---------------------------------------------------------------- no value uses a later bar

test('computing on the first k bars gives the same first k values as computing on all of them', () => {
  const k = candles(5, 700, true);
  const x = levels(9, 700, true);
  const cuts = [0, 1, 2, 3, 7, 8, 9, 10, 15, 16, 31, 32, 33, 64, 100, 257, 499, 500, 501, 699];
  const subjects: [string, (cut: number) => number[]][] = [];
  const add = (name: string, fn: (cut: number) => number[]) => subjects.push([name, fn]);
  const hlc = (cut: number): [number[], number[], number[]] => [k.h.slice(0, cut), k.l.slice(0, cut), k.c.slice(0, cut)];
  for (const n of [2, 5, 14]) {
    add(`sum ${n}`, (cut) => ind.sum(x.slice(0, cut), n));
    add(`dema ${n}`, (cut) => ind.dema(x.slice(0, cut), n));
    add(`tema ${n}`, (cut) => ind.tema(x.slice(0, cut), n));
    add(`kama ${n}`, (cut) => ind.kama(x.slice(0, cut), n, 2, 30));
    add(`aroon_up ${n}`, (cut) => ind.aroonUp(k.h.slice(0, cut), n));
    add(`aroon_down ${n}`, (cut) => ind.aroonDown(k.l.slice(0, cut), n));
    add(`cmf ${n}`, (cut) => ind.cmf(...hlc(cut), k.v.slice(0, cut), n));
    add(`linreg ${n}`, (cut) => ind.linreg(x.slice(0, cut), n));
    add(`rsquared ${n}`, (cut) => ind.rsquared(x.slice(0, cut), n));
    add(`efficiency ${n}`, (cut) => ind.efficiency(x.slice(0, cut), n));
  }
  add('psar', (cut) => ind.psar(...hlc(cut), 0.02, 0.2));
  add('psar wide', (cut) => ind.psar(...hlc(cut), 0.1, 0.3));
  add('streak', (cut) => ind.streak(x.slice(0, cut)));
  for (const [name, fn] of subjects) {
    const all = fn(700);
    for (const cut of cuts) {
      const part = fn(cut);
      assert.equal(part.length, cut, `${name}: length on ${cut} bars`);
      assert.deepEqual(part, all.slice(0, cut), `${name}: the first ${cut} values change with the bars after them`);
    }
  }
});

// ---------------------------------------------------------------- speed

test('aroon and cmf take time in proportion to the bars, not to the bars times the window', () => {
  const k = candles(3, 20000, false);
  // The fastest of several runs, so a garbage collection or the other test files running alongside don't count; a
  // window-times-bars implementation would be about a thousand times slower at 5000 than at 5, far past the margin below.
  const time = (fn: () => void) => {
    fn();
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      fn();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  const calls: [string, (n: number) => void][] = [
    ['aroon_up', (n) => ind.aroonUp(k.h, n)],
    ['aroon_down', (n) => ind.aroonDown(k.l, n)],
    ['cmf', (n) => ind.cmf(k.h, k.l, k.c, k.v, n)],
  ];
  for (const [name, fn] of calls) {
    const [small, large] = [time(() => fn(5)), time(() => fn(5000))];
    assert.ok(large < 20 * small + 30, `${name}: ${large.toFixed(1)} ms for a window of 5000 against ${small.toFixed(1)} ms for 5`);
  }
});
