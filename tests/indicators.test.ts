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

const sellRule = (text: string): Expr => {
  const { spec, errors } = parseSpec(`universe: A\nbuy when true\nsell when ${text}`);
  assert.deepEqual(errors, []);
  return spec!.rules.A.sell!;
};
const at = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const onDays = (days: number[]) => ({ t: days, o: days.map(() => 1), h: days.map(() => 1), l: days.map(() => 1), c: days.map(() => 1), v: days.map(() => 1) });

test('calendar values come from the UTC date of each bar', () => {
  // Thursday 30 January to Monday 3 February 2020, weekend included.
  const ev = new Evaluator(new Map([['A', bars([1, 1, 1, 1, 1], { start: at(2020, 1, 30) })]]));
  const num = (name: string) => ev.eval({ k: 'cal', name } as Expr, 'A');
  assert.deepEqual(num('month'), [1, 1, 2, 2, 2]);
  assert.deepEqual(num('day'), [30, 31, 1, 2, 3]);
  assert.deepEqual(num('weekday'), [4, 5, 6, 7, 1]);
  assert.deepEqual(num('year'), [2020, 2020, 2020, 2020, 2020]);
  // The first bar's month may have started before the data does.
  assert.deepEqual(round(num('month_start')), [null, 0, 1, 0, 0]);
  assert.deepEqual(num('month_end'), [0, 1, 0, 0, 0]);
});

test('month_end on the last bar looks at the next weekday, or the next day when the series trades on weekends', () => {
  // 2020 is a leap year: Friday 28 February is followed by Saturday the 29th.
  const weekdays = new Evaluator(new Map([['A', onDays([at(2020, 2, 26), at(2020, 2, 27), at(2020, 2, 28)])]]));
  assert.deepEqual(weekdays.eval(cond('month_end'), 'A'), [0, 0, 1]);
  const everyDay = new Evaluator(new Map([['A', bars([1, 1, 1, 1, 1, 1, 1], { start: at(2020, 2, 22) })]]));
  assert.deepEqual(everyDay.eval(cond('month_end'), 'A'), [0, 0, 0, 0, 0, 0, 0]);
  // Weekly bars step a week past the last one.
  const weekly = new Evaluator(new Map([['A', onDays([at(2024, 1, 15), at(2024, 1, 22), at(2024, 1, 29)])]]));
  assert.deepEqual(weekly.eval(cond('month_end'), 'A'), [0, 0, 1]);
});

test('a sell rule with position values is worked out bar by bar with the open position', () => {
  const ev = new Evaluator(new Map([['A', bars([12, 11, 9, 9.5, 8])]]));
  const rule = ev.compile(sellRule('bars held >= 2 or close < entry price * 0.9'), 'A');
  const pos = { entryIdx: 1, entryPrice: 10 };
  // bars held: -1, 0, 1, 2, 3; entry price * 0.9 = 9.
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => rule(i, pos)), [0, 0, 0, 1, 1]);
  // Flat, position values are unknown and never trigger a rule.
  assert.deepEqual([0, 1, 2].map((i) => rule(i, null)), [NaN, NaN, NaN]);
  const either = ev.compile(sellRule('close > 11.5 or bars held > 0'), 'A');
  assert.deepEqual([0, 1].map((i) => either(i, null)), [1, NaN]);
  const both = ev.compile(sellRule('close > 11.5 and bars held > 0'), 'A');
  assert.deepEqual([0, 1].map((i) => both(i, null)), [NaN, 0]);
  // A cross reads the previous bar with the same position.
  const cross = ev.compile(sellRule('close crosses below entry price'), 'A');
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => cross(i, pos)), [NaN, 0, 1, 0, 0]);
  const math = ev.compile(sellRule('max(bars held, 1) * 2 - -entry_price / 10 == 3 and not abs(bars held) > 1'), 'A');
  assert.deepEqual([1, 2, 3].map((i) => math(i, pos)), [1, 1, 0]);
  // A rule without position values reads the precomputed series.
  assert.deepEqual([0, 4].map((i) => ev.compile(sellRule('close < 10'), 'A')(i, pos)), [0, 1]);
});
