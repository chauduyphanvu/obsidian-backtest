// highest and lowest in one pass, against the plain scan of each window they replaced, value for value.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ind from '../src/indicators.ts';
import { makeRng } from '../src/rng.ts';

/** Each full window of `n` known values scanned from its start, the first extreme kept: the definition. */
function scan(src: number[], n: number, sign: 1 | -1): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  let valid = 0;
  for (let i = 0; i < src.length; i++) {
    valid = Number.isNaN(src[i]) ? 0 : valid + 1;
    if (valid < n) continue;
    let m = sign * -Infinity;
    for (let j = i - n + 1; j <= i; j++) if (sign * src[j] > sign * m) m = src[j];
    out[i] = m;
  }
  return out;
}

/** Equal value for value, telling 0 from -0 and matching NaN with NaN. */
function same(got: number[], want: number[], what: string): void {
  assert.equal(got.length, want.length, what);
  const show = (x: number) => (Object.is(x, -0) ? '-0' : String(x));
  for (let i = 0; i < want.length; i++) if (!Object.is(got[i], want[i])) assert.fail(`${what}, bar ${i}: ${show(got[i])}, the scan gives ${show(want[i])}`);
}

function check(src: number[], what: string): void {
  for (const n of [1, 2, 3, 5, 20, src.length, src.length + 1, src.length + 7]) {
    if (n < 1) continue;
    same(ind.highest(src, n), scan(src, n, 1), `highest(${n}) of ${what}`);
    same(ind.lowest(src, n), scan(src, n, -1), `lowest(${n}) of ${what}`);
  }
}

test('highest and lowest match the scan on awkward series', () => {
  const N = NaN;
  check([], 'nothing');
  check([5], 'one value');
  check([3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5], 'digits of pi');
  check([N, 1, 2, N, N, 3, 4, 5, N, 6], 'gaps, which start the count again');
  check([N, N, N], 'nothing known');
  check([1, 2, 3, 4, 5, 6, 7, N], 'a gap at the end');
  check([7, 7, 7, 7, 7, 7, 7], 'a flat series');
  check([2, 2, 1, 1, 2, 2, 3, 3, 1], 'ties');
  check([0, -0, 0, -0, -0, 0, 1, -0, 0], '0 and -0, which compare equal');
  check([-0, 0, -1, 0, -0], '-0 first');
  check([Infinity, 1, -Infinity, -Infinity, 2, Infinity], 'infinities');
  check([-Infinity, -Infinity, -Infinity], 'only -Infinity');
  check([10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 'a fall');
  check([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'a rise');
  // Bitcoin at about 65,000 moving by a few hundred-millionths, so the window's extremes differ in the last bits only.
  check(Array.from({ length: 200 }, (_, i) => 65_000.12345678 + (((i * 37) % 11) - 5) * 1e-8), 'tiny moves at a large price');
});

test('highest and lowest match the scan on random series with ties and gaps', () => {
  const rng = makeRng(20261117);
  for (let k = 0; k < 300; k++) {
    const len = 1 + Math.floor(rng.next() * 400);
    const levels = 1 + Math.floor(rng.next() * 6);
    const gaps = rng.next() * 0.1;
    // Few levels, so windows hold ties, and some zeros are -0.
    const value = () => {
      const x = Math.floor(rng.next() * levels);
      return x === 0 && rng.next() < 0.5 ? -0 : x;
    };
    const src = Array.from({ length: len }, () => (rng.next() < gaps ? NaN : value()));
    for (const n of [1, 2, 1 + Math.floor(rng.next() * 30), 1 + Math.floor(rng.next() * len), len + 1]) {
      same(ind.highest(src, n), scan(src, n, 1), `random series ${k}, highest(${n})`);
      same(ind.lowest(src, n), scan(src, n, -1), `random series ${k}, lowest(${n})`);
    }
  }
});

test('stochastics and Williams %R, which share the queue, are what the scan gives on prices with equal highs and lows', () => {
  const rng = makeRng(7);
  const c = Array.from({ length: 300 }, () => 100 + Math.round(rng.next() * 8) / 4);
  const h = c.map((x) => x + Math.round(rng.next() * 4) / 4);
  const l = c.map((x) => x - Math.round(rng.next() * 4) / 4);
  for (const n of [1, 5, 14, 300, 301]) {
    const [hh, ll] = [scan(h, n, 1), scan(l, n, -1)];
    const k = c.map((x, i) => (hh[i] > ll[i] ? (100 * (x - ll[i])) / (hh[i] - ll[i]) : NaN));
    same(ind.stochK(h, l, c, n, 3), ind.sma(k, 3), `stochK(${n})`);
    same(ind.williamsR(h, l, c, n), c.map((x, i) => (hh[i] > ll[i] ? (-100 * (hh[i] - x)) / (hh[i] - ll[i]) : NaN)), `williamsR(${n})`);
  }
});
