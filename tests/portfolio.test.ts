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

/** UTC midnights from `from` to `to`, weekdays only when asked. */
function calendar(from: number, to: number, weekdays: boolean): number[] {
  const out: number[] = [];
  for (let t = from; t <= to; t += DAY) if (!weekdays || ![0, 6].includes(new Date(t).getUTCDay())) out.push(t);
  return out;
}

test('in rank mode a buy waits for the sells of the same decision, on any calendar', () => {
  // Monday 30 December 2019 to Tuesday 4 February 2020. CRY trades every day, STK on weekdays.
  const dec30 = Date.UTC(2019, 11, 30);
  const cryT = calendar(dec30, feb(4), false);
  const stkT = calendar(dec30, feb(4), true);
  const STK = bars(stkT.map(() => 100), { times: stkT });
  // CRY scores 50 until it jumps to 150 at the close of Friday 31 January, and doubles on 4 February.
  const CRY = bars(cryT.map((t) => (t < jan(31) ? 50 : t < feb(4) ? 150 : 300)), { times: cryT });
  const r = run('universe: STK, CRY\ncapital: 1000\nrebalance: monthly\nhold: top 1 by close', { STK, CRY });
  // 31 December picks STK, bought on 1 January. 31 January picks CRY: STK sells at its next open,
  // Monday 3 February, and CRY's buy waits through the weekend for that cash, then fills the same open.
  assert.deepEqual(trades(r), [['STK', jan(1), feb(3), 'signal'], ['CRY', feb(3), feb(4), 'open']]);
  assert.deepEqual(r.run.equity.slice(-4), [1000, 1000, 1000, 2000]);
  assert.deepEqual(r.run.exposure.slice(-4), [1, 1, 1, 1]);
});

test('in rank mode, when cash is short, the best score is bought first', () => {
  // Both are chosen; 1% costs leave too little cash for two full halves. B scores higher.
  const r = run('universe: A, B\ncapital: 1000\ncosts: 100 bps\nhold: top 2 by close', { A: bars([10, 10, 10]), B: bars([20, 20, 20]) });
  const [a, b] = r.run.states;
  // B gets its full 500 (25 shares), paying 5 in costs; A gets what is left, 495 / 1.01.
  assert.ok(near(b.shares, 25));
  assert.ok(near(a.shares, 495 / 1.01 / 10));
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
  // A signal on bar 0, where ATR(2) is unknown, is not acted on: the buy waits for bar 1's signal.
  r = run('universe: A\ncapital: 1000\nrisk per trade: 1% at 2 atr(2)\nbuy when true', { A });
  assert.ok(near(r.run.states[0].shares, 2.5));
  assert.equal(r.run.trades[0].entryT, day(2));
  assert.deepEqual(r.notes, ['1 buy signal for A was not acted on while the 2-bar ATR for risk per trade was still unknown.']);
});

test('inverse volatility does not buy until each ticker\'s volatility is known', () => {
  // Volatility(2) needs two returns, so it is known from bar 2: the buys fill at bar 3's open
  // (A 99, B 99.96) at 1/6 and 5/6, as when the run starts at bar 2.
  const A = bars([100, 110, 99, 99, 99]);
  const B = bars([100, 102, 99.96, 99.96, 99.96]);
  const r = run('universe: A, B\ncapital: 1000\nweighting: inverse volatility(2)\nbuy when true', { A, B });
  assert.deepEqual(r.run.trades.map((t) => [t.asset, t.entryT]), [['A', day(3)], ['B', day(3)]]);
  const [a, b] = r.run.states;
  assert.ok(near(a.shares, 1000 / 6 / 99) && near(b.shares, 5000 / 6 / 99.96));
  // Bars 0 and 1 were one run of held-back signals for each ticker.
  assert.deepEqual(r.notes, ['2 buy signals were not acted on while the 2-bar volatility for inverse volatility weighting was still unknown: A 1, B 1.']);
});

test('test from splits the one run into two parts, the second measured from the last close before it', () => {
  const A = bars([100, 100, 110, 99, 121, 121]);
  const r = run('universe: A\ncapital: 1000\ntest from: 2020-01-04\nbuy when true\nsell when close > 115', { A });
  assert.deepEqual(r.run.equity, [1000, 1000, 1100, 990, 1210, 1210]);
  const [before, after] = r.segments!;
  assert.deepEqual([before.label, before.from, before.to], ['Before 2020-01-04', day(0), day(2)]);
  assert.deepEqual([after.label, after.from, after.to], ['From 2020-01-04', day(3), day(5)]);
  assert.ok(near(before.stats.totalReturn, 0.1));
  // The fall from 1100 to 990 on 4 January belongs to the second part.
  assert.ok(near(after.stats.totalReturn, 1210 / 1100 - 1));
  assert.ok(near(after.stats.maxDrawdown, 990 / 1100 - 1));
  assert.ok(near(after.benchmarkStats.totalReturn, 1210 / 1100 - 1));
  // So the two parts' growth multiplies to the whole run's.
  assert.ok(near((1 + before.stats.totalReturn) * (1 + after.stats.totalReturn), 1 + r.stats.totalReturn));
  assert.ok(near((1 + before.benchmarkStats.totalReturn) * (1 + after.benchmarkStats.totalReturn), 1 + r.benchmark.stats.totalReturn));
  // The one trade was entered on day 1, so it belongs to the first part though it closed in the second.
  assert.deepEqual([before.tradeStats.count, after.tradeStats.count], [1, 0]);
  assert.equal(run('universe: A\nbuy when true', { A }).segments, null);
});

test('a benchmark that starts later is measured over its own dates and has no value before them', () => {
  // Quarters of 91 days from 1 January 2020; B's prices start at the third, 1 July.
  const step = 91 * DAY;
  const X = bars([100, 100, 100, 100, 100], { step });
  const B = bars([100, 100, 121], { start: T0 + 2 * step, step });
  const r = run('universe: X\ncapital: 1000\nbenchmark: B\nbuy when true', { X, B });
  // B buys at the open of its second bar at 100 and gains 21% on its third.
  assert.deepEqual(r.benchmark.equity, [NaN, NaN, 1000, 1000, 1210]);
  assert.deepEqual(r.benchmark.drawdown, [NaN, NaN, 0, 0, 0]);
  assert.ok(near(r.benchmark.stats.totalReturn, 0.21));
  // 21% over its own 182 days, not over the strategy's 364.
  assert.ok(near(r.benchmark.stats.cagr, 1.21 ** (365.25 / 182) - 1));
  assert.deepEqual(r.notes, ["B has prices only from 2020-07-01, so its figures cover a shorter period than the strategy's."]);
  // A benchmark with prices from the start has no note.
  assert.deepEqual(run('universe: X\nbenchmark: X\nbuy when true', { X }).notes, []);
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
