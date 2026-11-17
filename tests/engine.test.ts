import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import type { Bars } from '../src/types.ts';
import { bars, near, DAY, T0 } from './helpers.ts';

function run(src: string, data: Record<string, Bars>) {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  return runBacktest(spec!, new Map(Object.entries(data)));
}
const day = (n: number) => T0 + n * DAY;

test('a signal at the close fills at the next open', () => {
  // close > 10 first holds on day 1; the buy fills at day 2's open (12), the sell at day 5's open (9).
  const A = bars([10, 12, 12, 15, 9, 9, 9], { opens: [10, 10, 12, 12, 15, 9, 9] });
  const r = run('universe: A\ncapital: 1000\nbuy when close > 10\nsell when close < 10', { A });
  assert.equal(r.run.trades.length, 1);
  const t = r.run.trades[0];
  assert.deepEqual([t.entryT, t.entryPrice, t.exitT, t.exitPrice, t.reason], [day(2), 12, day(5), 9, 'signal']);
  assert.ok(near(t.ret, 9 / 12 - 1));
  assert.deepEqual(r.run.equity, [1000, 1000, 1000, 1250, 750, 750, 750]);
  assert.deepEqual(r.run.exposure, [0, 0, 1, 1, 1, 0, 0]);
});

test('costs are charged on both sides', () => {
  const A = bars([10, 10, 10, 10, 10], { opens: [10, 10, 10, 10, 10] });
  const r = run('universe: A\ncapital: 1000\ncosts: 100 bps\nbuy when close[1] != close[1] or true\nsell when close[2] == 10', { A });
  // Buy at day 1 with 1000 / 1.01 = 990.099 invested; sell at day 3 for 990.099 * 0.99.
  const invested = 1000 / 1.01;
  assert.ok(near(r.run.equity[1], invested));
  assert.ok(near(r.run.equity[3], invested * 0.99));
  assert.ok(near(r.run.costs, invested * 0.01 * 2));
  assert.ok(near(r.run.trades[0].ret, 0.99 / 1.01 - 1));
});

test('weights, cash remainder and the same-weights benchmark', () => {
  const A = bars([10, 10, 20, 20], { opens: [10, 10, 10, 20] });
  const B = bars([5, 5, 5, 5], { opens: [5, 5, 5, 5] });
  const r = run('universe: A 50%, B 30%\ncapital: 1000\nbuy when true', { A, B });
  // Day 1 open: 500 in A (50 shares), 300 in B, 200 cash. A doubles on day 2.
  assert.deepEqual(r.run.equity, [1000, 1000, 1500, 1500]);
  assert.ok(near(r.run.exposure[2], 1300 / 1500));
  assert.deepEqual(r.benchmark.equity, r.run.equity);
  assert.equal(r.benchmark.label, 'Buy & hold');
  assert.deepEqual(r.run.states.map((s) => [s.name, s.long, s.since]), [['A', true, day(1)], ['B', true, day(1)]]);
});

test('rebalancing returns held assets to their weights at the first open of a period', () => {
  // 31 Jan to 2 Feb 2020: the month turns between the 2nd and 3rd bar.
  const start = Date.UTC(2020, 0, 30);
  const A = bars([10, 20, 20, 20], { opens: [10, 10, 20, 20], start });
  const B = bars([10, 10, 10, 10], { opens: [10, 10, 10, 10], start });
  const never = run('universe: A 50%, B 50%\ncapital: 1000\nbuy when true', { A, B });
  const monthly = run('universe: A 50%, B 50%\ncapital: 1000\nrebalance: monthly\nbuy when true', { A, B });
  // Bought on 31 Jan at 10: 50 shares each. A doubles that day: 1000 in A, 500 in B.
  assert.deepEqual(never.run.equity, [1000, 1500, 1500, 1500]);
  assert.deepEqual(monthly.run.equity, [1000, 1500, 1500, 1500]);
  // After the 1 Feb rebalance each holds 750, which only shows in how they move next.
  const A2 = bars([10, 20, 20, 40], { opens: [10, 10, 20, 20], start });
  assert.equal(run('universe: A 50%, B 50%\ncapital: 1000\nbuy when true', { A: A2, B }).run.equity[3], 2500);
  assert.equal(run('universe: A 50%, B 50%\ncapital: 1000\nrebalance: monthly\nbuy when true', { A: A2, B }).run.equity[3], 2250);
});

test('stop loss fills at the stop, or at the open when the bar gaps through it', () => {
  const spec = 'universe: A\ncapital: 1000\nstop loss: 10%\nbuy when true';
  // Entry at 100 on day 1. Day 2 trades down to 85: out at 90.
  const inside = bars([100, 100, 88, 88], { opens: [100, 100, 100, 88], lows: [100, 100, 85, 88] });
  let r = run(spec, { A: inside });
  assert.deepEqual([r.run.trades[0].exitPrice, r.run.trades[0].reason, r.run.trades[0].exitT], [90, 'stop loss', day(2)]);
  assert.equal(r.run.equity[2], 900);
  // Day 2 opens at 80, below the stop: out at 80.
  const gap = bars([100, 100, 82, 82], { opens: [100, 100, 80, 82], lows: [100, 100, 79, 82] });
  r = run(spec, { A: gap });
  assert.equal(r.run.trades[0].exitPrice, 80);
});

test('after a stop the buy rule must stop holding before it fires again', () => {
  const A = bars([100, 100, 88, 88, 88, 88], { opens: [100, 100, 100, 88, 88, 88], lows: [100, 100, 85, 88, 88, 88] });
  assert.equal(run('universe: A\nstop loss: 10%\nbuy when true', { A }).run.trades.length, 1);
  // close > 87 holds throughout, so there is no re-entry either.
  assert.equal(run('universe: A\nstop loss: 10%\nbuy when close > 87', { A }).run.trades.length, 1);
  // close < 95 fails on day 0-1 and holds from day 2, when the position is... never opened before then.
  const B = bars([100, 100, 100, 85, 100, 100, 100], { opens: [100, 100, 100, 100, 85, 100, 100], lows: [100, 100, 100, 85, 85, 100, 100] });
  // Buy rule "close >= 100": in on day 1, stopped on day 3 at 90, rule false at day 3's close (85), true on day 4, back in on day 5.
  const r = run('universe: B\nstop loss: 10%\nbuy when close >= 100', { B });
  assert.deepEqual(r.run.trades.map((t) => [t.entryT, t.reason]), [[day(1), 'stop loss'], [day(5), 'open']]);
});

test('trailing stop follows the highest high of completed bars', () => {
  // Entry 100 on day 1; highs 100, 120, then a low of 105 on day 3 (stop = 120 * 0.9 = 108).
  const A = bars([100, 100, 120, 106, 106], { opens: [100, 100, 100, 120, 106], highs: [100, 100, 120, 120, 106], lows: [100, 100, 100, 105, 106] });
  const r = run('universe: A\ncapital: 1000\ntrailing stop: 10%\nbuy when true', { A });
  assert.deepEqual([r.run.trades[0].exitPrice, r.run.trades[0].reason, r.run.trades[0].exitT], [108, 'trailing stop', day(3)]);
});

test('take profit fills at the target; with both in one bar the stop wins', () => {
  const A = bars([100, 100, 125, 125], { opens: [100, 100, 100, 125], highs: [100, 100, 130, 125] });
  let r = run('universe: A\ncapital: 1000\ntake profit: 20%\nbuy when true', { A });
  assert.deepEqual([r.run.trades[0].exitPrice, r.run.trades[0].reason], [120, 'take profit']);
  const both = bars([100, 100, 100, 100], { opens: [100, 100, 100, 100], highs: [100, 100, 130, 100], lows: [100, 100, 85, 100] });
  r = run('universe: A\ncapital: 1000\ntake profit: 20%\nstop loss: 10%\nbuy when true', { A: both });
  assert.equal(r.run.trades[0].reason, 'stop loss');
});

test('assets on different calendars: the run starts when all have data, and missing days carry the last close', () => {
  // W trades every day, S skips days 2-3 (a weekend) and starts a day later.
  const W = bars([10, 10, 10, 20, 20, 20]);
  const S: Bars = { t: [day(1), day(4), day(5)], o: [50, 50, 50], h: [50, 50, 100], l: [50, 50, 50], c: [50, 50, 100], v: [1, 1, 1] };
  const r = run('universe: W 50%, S 50%\ncapital: 1000\nbuy when true', { W, S });
  assert.deepEqual(r.run.t, [day(1), day(2), day(3), day(4), day(5)]);
  // W bought on day 2 at 10 (50 shares). S fills at its next bar, day 4, at 50: its half of 1500
  // is 750, but only 500 is in cash, so it buys 10 shares, which double on day 5.
  assert.deepEqual(r.run.equity, [1000, 1000, 1500, 1500, 2000]);
});

test('a pending order on the last bar is reported, not filled', () => {
  const A = bars([10, 10, 12]);
  const r = run('universe: A\nbuy when close > 11', { A });
  assert.equal(r.run.trades.length, 0);
  assert.deepEqual(r.run.states, [{ name: 'A', weight: 1, long: false, since: null, pending: 'buy' }]);
});

test('from and to bound the run, with earlier bars feeding the lookback', () => {
  const A = bars([1, 2, 3, 4, 5, 6, 7, 8]);
  const r = run(`universe: A\nfrom: 2020-01-04\nto: 2020-01-06\nbuy when close > sma(3)`, { A });
  assert.deepEqual(r.run.t, [day(3), day(4), day(5)]);
  // sma(3) is already known on day 3, so the buy fills on day 4's open.
  assert.equal(r.run.trades[0].entryT, day(4));
});

test('statistics', () => {
  const closes = [100, 100, 110, 99, 121];
  const A = bars(closes, { start: Date.UTC(2020, 0, 1), step: 91.3125 * DAY });
  const r = run('universe: A\ncapital: 100\nbuy when true\nbenchmark: A', { A });
  // In at the open of bar 1 (100): equity 100, 100, 110, 99, 121 over exactly one year.
  assert.ok(near(r.stats.totalReturn, 0.21));
  assert.ok(near(r.stats.cagr, 0.21, 1e-9));
  assert.ok(near(r.stats.maxDrawdown, 99 / 110 - 1));
  assert.ok(near(r.stats.exposure, 0.8));
  assert.equal(r.benchmark.label, 'A buy & hold');
  assert.ok(near(r.benchmark.stats.cagr, 0.21, 1e-9));
  assert.equal(r.tradeStats.count, 0);
  assert.equal(r.tradeStats.open, 1);
});
