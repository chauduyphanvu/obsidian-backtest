import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec, type Expr } from '../src/dsl.ts';
import { Evaluator } from '../src/evaluate.ts';
import * as ind from '../src/indicators.ts';
import { bars, near, DAY, T0 } from './helpers.ts';

const round = (xs: number[], d = 4) => xs.map((x) => (Number.isNaN(x) ? null : Number(x.toFixed(d))));

test('sma, highest, lowest, stdev', () => {
  assert.deepEqual(round(ind.sma([1, 2, 3, 4, 5], 3)), [null, null, 2, 3, 4]);
  assert.deepEqual(round(ind.highest([1, 5, 3, 2, 4], 2)), [null, 5, 5, 3, 4]);
  assert.deepEqual(round(ind.lowest([1, 5, 3, 2, 4], 2)), [null, 1, 3, 2, 2]);
  assert.deepEqual(round(ind.stdev([2, 4, 4, 4, 5, 5, 7, 9], 8)), [null, null, null, null, null, null, null, 2]);
});

test('a window waits for a full run of known values', () => {
  assert.deepEqual(round(ind.sma([NaN, NaN, 1, 2, 3], 2)), [null, null, null, 1.5, 2.5]);
});

test('ema is seeded with the simple average', () => {
  assert.deepEqual(round(ind.ema([1, 2, 3, 4, 5], 3)), [null, null, 2, 3, 4]);
  assert.deepEqual(round(ind.ema([2, 4, 6, 12], 3)), [null, null, 4, 8]);
});

test('rsi matches Wilder\'s worked example', () => {
  // Closes from Wilder's 1978 table as commonly reproduced (StockCharts): first RSI(14) = 70.46.
  const c = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
  const r = ind.rsi(c, 14);
  assert.ok(Number.isNaN(r[13]));
  assert.ok(near(r[14], 70.46, 0.01), String(r[14]));
  assert.ok(near(r[15], 66.25, 0.01), String(r[15]));
  assert.ok(near(r[19], 57.92, 0.01), String(r[19]));
});

test('atr uses the true range', () => {
  const a = ind.atr([10, 12, 11], [9, 10, 8], [9.5, 11, 9], 2);
  // TR: 1, max(2, 2.5, 0.5) = 2.5, max(3, 0, 3) = 3 -> seed (1 + 2.5) / 2 = 1.75, then 1.75 + (3 - 1.75) / 2
  assert.deepEqual(round(a), [null, 1.75, 2.375]);
});

const cond = (text: string): Expr => {
  const { spec, errors } = parseSpec(`universe: A\nbuy when ${text}`);
  assert.deepEqual(errors, []);
  return spec!.rules.A.buy;
};

test('crosses fire once, on the bar of the cross', () => {
  const ev = new Evaluator(new Map([['A', bars([1, 2, 3, 4, 3, 2, 3, 4])]]));
  assert.deepEqual(round(ev.eval(cond('close crosses above 2.5'), 'A')), [null, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(round(ev.eval(cond('close crosses below 2.5'), 'A')), [null, 0, 0, 0, 0, 1, 0, 0]);
});

test('unknown values follow three-valued logic and never hold', () => {
  const ev = new Evaluator(new Map([['A', bars([1, 2, 3, 4])]]));
  assert.deepEqual(round(ev.eval(cond('close > sma(3)'), 'A')), [null, null, 1, 1]);
  assert.deepEqual(round(ev.eval(cond('not close > sma(3)'), 'A')), [null, null, 0, 0]);
  assert.deepEqual(round(ev.eval(cond('close > sma(3) or close >= 2'), 'A')), [null, 1, 1, 1]);
  assert.deepEqual(round(ev.eval(cond('close > sma(3) and close >= 2'), 'A')), [0, null, 1, 1]);
});

test('lag and arithmetic', () => {
  const ev = new Evaluator(new Map([['A', bars([1, 2, 4, 8])]]));
  assert.deepEqual(round(ev.eval(cond('close / close[1] - 1 >= 100%'), 'A')), [null, 1, 1, 1]);
  assert.deepEqual(round(ev.eval(cond('roc(2) > 250%'), 'A')), [null, null, 1, 1]);
  assert.deepEqual(round(ev.eval(cond('max(close, 3) - abs(-1) == 3'), 'A')), [0, 0, 1, 0]);
});

test('"of" reads another ticker as of each bar, never ahead', () => {
  // B trades every other day.
  const data = new Map([
    ['A', bars([1, 1, 1, 1, 1])],
    ['B', bars([10, 20, 30], { start: T0 + DAY, step: 2 * DAY })],
  ]);
  const { spec } = parseSpec('universe: A\ndata: yahoo\nbuy when close of B >= 20');
  const ev = new Evaluator(data);
  assert.deepEqual(round(ev.eval(spec!.rules.A.buy, 'A')), [null, 0, 0, 1, 1]);
});
