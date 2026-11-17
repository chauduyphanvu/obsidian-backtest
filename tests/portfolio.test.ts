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
const jan = (d: number) => Date.UTC(2020, 0, d);
const feb = (d: number) => Date.UTC(2020, 1, d);
const trades = (r: ReturnType<typeof run>) => r.run.trades.map((t) => [t.asset, t.entryT, t.exitT, t.reason]);

const RANKED = () => ({ A: bars([10, 10, 10, 10]), B: bars([20, 20, 5, 5]), C: bars([15, 15, 15, 15]) });

test('ranking holds the top score, switching at the next open when it changes', () => {
  const r = run('universe: A, B, C\ncapital: 1000\nhold: top 1 by close', RANKED());
  // B leads at day 0's close (bought at 20 on day 1); after B falls to 5 on day 2, C leads.
  assert.deepEqual(trades(r), [['B', day(1), day(3), 'signal'], ['C', day(3), day(3), 'open']]);
  [1000, 1000, 250, 250].forEach((v, i) => assert.ok(near(r.run.equity[i], v)));
  // The benchmark holds a third of each.
  assert.equal(r.benchmark.label, 'Equal-weight buy & hold');
  assert.ok(near(r.benchmark.equity[2], 750) && near(r.benchmark.equity[3], 750));
});

test('ranking: ties go to the earlier ticker, and only tickers whose buy rule holds are eligible', () => {
  assert.equal(run('universe: A, B\nhold: top 1 by close', { A: bars([10, 10, 10]), B: bars([10, 10, 10]) }).run.trades[0].asset, 'A');
  assert.equal(run('universe: A, B, C\nhold: top 1 by close\nbuy when close < 18', RANKED()).run.trades[0].asset, 'C');
  // Two slots: each held ticker gets half.
  const two = run('universe: A, B, C\ncapital: 1000\nhold: top 2 by close', RANKED());
  assert.deepEqual(two.run.states.map((s) => [s.name, s.long, s.weight]), [['A', true, 0.5], ['B', false, 0.5], ['C', true, 0.5]]);
});

test('with a rebalance period, ranking decides on the last bar of each period', () => {
  // Wednesday 29 January to Tuesday 4 February 2020, weekdays only: 31 January ends the month.
  const times = [jan(29), jan(30), jan(31), feb(3), feb(4)];
  const A = bars([10, 10, 10, 10, 10], { times });
  const B = bars([5, 5, 20, 20, 20], { times });
  const r = run('universe: A, B\ncapital: 1000\nrebalance: monthly\nhold: top 1 by close', { A, B });
  assert.deepEqual(trades(r), [['B', feb(3), feb(4), 'open']]);
  // Ending on Friday 31 January, the next weekday is in February, so the last bar decides.
  const short = run('universe: A, B\nrebalance: monthly\nhold: top 1 by close', { A: bars([10, 10, 10], { times: times.slice(0, 3) }), B: bars([5, 5, 20], { times: times.slice(0, 3) }) });
  assert.equal(short.run.trades.length, 0);
  assert.deepEqual(short.run.states.map((s) => [s.name, s.pending, s.targetWeight]), [['A', null, 1], ['B', 'buy', 1]]);
});

test('between decisions a sell rule still exits, and the slot waits for the next decision', () => {
  const times = [jan(29), jan(30), jan(31), feb(3), feb(4), feb(5)];
  const A = bars([10, 10, 10, 10, 10, 10], { times });
  const B = bars([5, 5, 20, 20, 7, 7], { times });
  const r = run('universe: A, B\ncapital: 1000\nrebalance: monthly\nhold: top 1 by close\nsell when close < 8', { A, B });
  assert.deepEqual(trades(r), [['B', feb(3), feb(5), 'signal']]);
  assert.deepEqual(r.run.equity, [1000, 1000, 1000, 1000, 350, 350]);
  assert.deepEqual(r.run.states.map((s) => [s.long, s.pending]), [[false, null], [false, null]]);
});

test('in rank mode a stopped-out ticker can be bought again at the next decision', () => {
  const A = bars([100, 100, 88, 88, 88], { opens: [100, 100, 100, 88, 88], lows: [100, 100, 85, 88, 88] });
  const r = run('universe: A\nhold: top 1 by close\nstop loss: 10%', { A });
  assert.deepEqual(r.run.trades.map((t) => [t.entryT, t.reason]), [[day(1), 'stop loss'], [day(3), 'open']]);
});

test('inverse volatility shares the weights out by 1 / volatility at entry', () => {
  // Returns over bars 1-2: A +10%, -10% (volatility 0.1); B +2%, -2% (0.02). C does not move.
  const A = bars([100, 110, 99, 99, 99]);
  const B = bars([100, 102, 99.96, 99.96, 99.96]);
  const C = bars([50, 50, 50, 50, 50]);
  let r = run('universe: A, B\ncapital: 1000\nfrom: 2020-01-03\nweighting: inverse volatility(2)\nbuy when true', { A, B });
  // Signal at bar 2, bought at bar 3's open (A 99, B 99.96) with weights 10/60 and 50/60.
  const [a, b] = r.run.states;
  assert.ok(near(a.shares, 1000 / 6 / 99) && near(b.shares, 5000 / 6 / 99.96));
  // C's volatility is 0, which can't be divided by: it keeps its 20%, and A and B share their 80%.
  r = run('universe: A 40%, B 40%, C 20%\ncapital: 1000\nfrom: 2020-01-03\nweighting: inverse volatility(2)\nbuy when true', { A, B, C });
  assert.ok(near(r.run.states[0].shares, 800 / 6 / 99) && near(r.run.states[1].shares, 4000 / 6 / 99.96));
  assert.equal(r.run.states[2].shares, 4);
});

test('inverse volatility weights are worked out again at each scheduled rebalance', () => {
  // 28 January to 2 February 2020; the rebalance falls on 1 February.
  const start = jan(28);
  const A = bars([100, 110, 99, 99, 108.9, 108.9], { start });
  const B = bars([100, 102, 99.96, 101.9592, 101.9592, 101.9592], { start });
  const r = run('universe: A, B\ncapital: 1000\nfrom: 2020-01-30\nrebalance: monthly\nweighting: inverse volatility(2)\nbuy when true', { A, B });
  // Bought on 31 January at 1/6 and 5/6. On 1 February A's last two returns are -10%, 0 (volatility
  // 0.05) and B's -2%, +2% (0.02): weights 20/70 and 50/70 of 1000/6 + 5000/6 * 1.02.
  const equity = 1000 / 6 + (5000 / 6) * 1.02;
  const [a, b] = r.run.states;
  assert.ok(near(a.shares, ((2 / 7) * equity) / 99), String(a.shares));
  assert.ok(near(b.shares, ((5 / 7) * equity) / 101.9592), String(b.shares));
});

test('risk per trade buys the shares that lose the risk at the stop distance, up to the weight', () => {
  // Every bar's true range is 2, so ATR(2) is 2 from bar 1.
  const A = bars([100, 100, 100, 100], { opens: [100, 100, 100, 100], highs: [101, 101, 101, 101], lows: [99, 99, 99, 99] });
  // 1% of 1000 over 2 * 2 is 2.5 shares, slippage or not.
  let r = run('universe: A\ncapital: 1000\nslippage: 1%\nrisk per trade: 1% at 2 atr(2)\nbuy when atr(2) > 0', { A });
  assert.ok(near(r.run.states[0].shares, 2.5));
  assert.equal(r.run.trades[0].entryT, day(2));
  // 10% would be 25 shares, 2500 of value: capped at the 100% weight, 10 shares.
  r = run('universe: A\ncapital: 1000\nrisk per trade: 10% at 2 atr(2)\nbuy when atr(2) > 0', { A });
  assert.ok(near(r.run.states[0].shares, 10));
  // A signal on bar 0, where ATR(2) is unknown, falls back to the weight.
  r = run('universe: A\ncapital: 1000\nrisk per trade: 1% at 2 atr(2)\nbuy when true', { A });
  assert.ok(near(r.run.states[0].shares, 10));
});

test('test from splits the one run into two parts, each measured from its own start', () => {
  const A = bars([100, 100, 110, 99, 121, 121]);
  const r = run('universe: A\ncapital: 1000\ntest from: 2020-01-04\nbuy when true\nsell when close > 115', { A });
  assert.deepEqual(r.run.equity, [1000, 1000, 1100, 990, 1210, 1210]);
  const [before, after] = r.segments!;
  assert.deepEqual([before.label, before.from, before.to], ['Before 2020-01-04', day(0), day(2)]);
  assert.deepEqual([after.label, after.from, after.to], ['From 2020-01-04', day(3), day(5)]);
  assert.ok(near(before.stats.totalReturn, 0.1));
  assert.ok(near(after.stats.totalReturn, 1210 / 990 - 1));
  assert.ok(near(after.stats.maxDrawdown, 0));
  assert.ok(near(after.benchmarkStats.totalReturn, 1210 / 990 - 1));
  // The one trade was entered on day 1, so it belongs to the first part though it closed in the second.
  assert.deepEqual([before.tradeStats.count, after.tradeStats.count], [1, 0]);
  assert.equal(run('universe: A\nbuy when true', { A }).segments, null);
});

test('the result carries the spec, the prices and a note on the cash rate', () => {
  const { spec } = parseSpec('universe: A\nbuy when true');
  const data = new Map([['A', bars([1, 2, 3])]]);
  const r = runBacktest(spec!, data);
  assert.equal(r.spec, spec);
  assert.equal(r.data, data);
  assert.equal(r.interest, 0);
  assert.equal(r.cashRateNote, 'Cash earns nothing');
});
