import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeStats, runBacktest } from '../src/backtest.ts';
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

test('on mixed calendars each ticker is rebalanced at its own first bar of the period', () => {
  // Thursday 30 January to Tuesday 4 February 2020. CRY trades every day, STK on weekdays, so
  // February starts on Saturday for CRY and on Monday for STK.
  const [jan30, jan31, feb1, feb2, feb3, feb4] = [30, 31, 32, 33, 34, 35].map((d) => Date.UTC(2020, 0, d));
  const CRY = bars([10, 20, 20, 20, 20, 20], { start: jan30 });
  const STK = bars([10, 10, 10, 20], { opens: [10, 10, 10, 10], times: [jan30, jan31, feb3, feb4] });
  const r = run('universe: STK 50%, CRY 50%\ncapital: 1000\nrebalance: monthly\nbuy when true', { STK, CRY });
  assert.deepEqual(r.run.t, [jan30, jan31, feb1, feb2, feb3, feb4]);
  // 50 shares each at 10 on 31 January; CRY doubles that day: 500 + 1000.
  // Saturday: CRY goes back to 750 of 1500, selling 12.5 shares at 20 and leaving 250 in cash.
  // Monday: STK's first February bar, so it buys 25 shares with that 250 to reach 750.
  assert.deepEqual(r.run.equity, [1000, 1500, 1500, 1500, 1500, 2250]);
  assert.deepEqual(r.run.exposure.slice(2), [1250 / 1500, 1250 / 1500, 1, 1]);
  assert.deepEqual(r.run.states.map((s) => s.shares), [75, 37.5]);
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

test('a bar that opens beyond the target takes the target at the open, even when it later trades through the stop', () => {
  // Entry at 100 on day 1: stop 90, target 110. Day 2 opens at 115, then falls to 85: the open came first.
  const A = bars([100, 100, 95, 95], { opens: [100, 100, 115, 95], highs: [100, 100, 118, 95], lows: [100, 100, 85, 95] });
  const r = run('universe: A\ncapital: 1000\ntake profit: 10%\nstop loss: 10%\nbuy when true', { A });
  assert.deepEqual(r.run.trades.map((t) => [t.exitT, t.exitPrice, t.reason]), [[day(2), 115, 'take profit']]);
  assert.equal(r.run.equity[2], 1150);
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
  assert.deepEqual(r.run.states, [{ name: 'A', weight: 1, long: false, since: null, pending: 'buy', shares: 0, lastClose: 12, value: 0, targetWeight: 1 }]);
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

test('slippage worsens every fill, and costs are charged on the slipped value', () => {
  const A = bars([10, 10, 20, 20], { opens: [10, 10, 20, 20] });
  let r = run('universe: A\ncapital: 1000\nslippage: 1%\nbuy when true\nsell when close > 15', { A });
  // Bought at 10 * 1.01 on day 1, sold at 20 * 0.99 on day 3.
  let t = r.run.trades[0];
  assert.deepEqual([t.entryT, t.exitT, t.reason, t.bars], [day(1), day(3), 'signal', 2]);
  assert.ok(near(t.entryPrice, 10.1) && near(t.exitPrice, 19.8));
  const shares = 1000 / 10.1;
  assert.ok(near(r.run.equity[2], shares * 20));
  assert.ok(near(r.run.equity[3], shares * 19.8));
  assert.ok(near(t.pnl, shares * 19.8 - 1000));

  r = run('universe: A\ncapital: 1000\nslippage: 1%\ncosts: 100 bps\nbuy when true\nsell when close > 15', { A });
  const spent = 1000 / 1.01;
  const proceeds = (spent / 10.1) * 19.8;
  assert.ok(near(r.run.equity[3], proceeds * 0.99));
  assert.ok(near(r.run.costs, spent * 0.01 + proceeds * 0.01));
  t = r.run.trades[0];
  assert.ok(near(t.ret, (19.8 * 0.99) / (10.1 * 1.01) - 1));
  assert.ok(near(t.pnl, proceeds * 0.99 - 1000));

  // The stop sits 10% under the 101 fill, at 90.9, and fills 1% worse than that.
  const inside = bars([100, 100, 88, 88], { opens: [100, 100, 100, 88], lows: [100, 100, 85, 88] });
  r = run('universe: A\ncapital: 1000\nslippage: 1%\nstop loss: 10%\nbuy when true', { A: inside });
  assert.ok(near(r.run.trades[0].exitPrice, 90.9 * 0.99));
  assert.ok(near(r.run.equity[2], 891));
});

test('rebalancing trades are slipped too', () => {
  const start = Date.UTC(2020, 0, 30);
  const A = bars([10, 20, 20, 20], { opens: [10, 10, 20, 20], start });
  const B = bars([10, 10, 10, 10], { opens: [10, 10, 10, 10], start });
  const r = run('universe: A 50%, B 50%\ncapital: 1000\nslippage: 1%\nrebalance: monthly\nbuy when true', { A, B });
  // s shares each at 10.1. On 1 Feb A is worth 20s and B 10s: A sells 5s of value at 19.8 a share,
  // and the cash buys B at 10.1.
  const s = 500 / 10.1;
  assert.ok(near(r.run.equity[2], s * 15 + (s * 10 + ((s / 4) * 19.8 * 10) / 10.1)));
});

test('cash earns the cash rate for the calendar days of each step, and so does the benchmark', () => {
  // Wednesday 1, Thursday 2, then Monday 6 January: steps of 1 and 4 days at 36.5% a year.
  const A: Bars = { t: [day(0), day(1), day(5)], o: [10, 10, 10], h: [10, 10, 10], l: [10, 10, 10], c: [10, 10, 10], v: [1, 1, 1] };
  const r = run('universe: A\ncapital: 1000\ncash rate: 36.5%\nbuy when close > 10', { A });
  assert.ok(near(r.run.equity[1], 1001));
  assert.ok(near(r.run.equity[2], 1001 * 1.004));
  assert.ok(near(r.interest, 1001 * 1.004 - 1000));
  assert.ok(near(r.run.cashReturn[2], 0.004));
  assert.equal(r.cashRateNote, 'Cash earns 36.5% a year');
  // The benchmark earns a day of interest, then buys at the open with all of it.
  assert.ok(near(r.benchmark.equity[1], 1001) && near(r.benchmark.equity[2], 1001));
});

test('a cash rate ticker pays its close at the previous bar, as a yearly percentage', () => {
  const A = bars([10, 10, 10, 10]);
  const R = bars([36.5, 73], { start: day(1) });
  const r = run('universe: A\ncapital: 1000\ncash rate: R\nbuy when close > 10', { A, R });
  // Day 0 has no rate yet (0), day 1 pays 36.5% for a day, day 2 pays 73%.
  assert.ok(near(r.run.equity[1], 1000));
  assert.ok(near(r.run.equity[2], 1001));
  assert.ok(near(r.run.equity[3], 1001 * 1.002));
  assert.ok(near(r.interest, 1001 * 1.002 - 1000));
  assert.equal(r.cashRateNote, 'Cash earns the R rate');
});

test('on an hourly run, a daily benchmark and a daily cash rate count only once their day has ended', () => {
  const HOUR = 3_600_000;
  const A = bars(Array.from({ length: 72 }, () => 10), { step: HOUR });
  // The benchmark earns a day at 36.5% (1001), buys at the open of 2 January at 10 and doubles
  // that day, then again on the 3rd.
  const B = bars([10, 20, 40]);
  const R = bars([36.5, 73, 73]);
  const r = run('universe: A\ncapital: 1000\nbenchmark: B\ncash rate: R\nbuy when false', { A, B, R });
  const bench = r.benchmark.equity;
  // 2 January's close is known when its 23:00 bar ends at midnight, not at 00:00.
  assert.deepEqual([bench[24], bench[46], bench[47], bench[70], bench[71]], [1000, 1000, 2002, 2002, 4004]);
  // Cash earns nothing until the 1 January rate is known at the end of that day; it then pays
  // 36.5% for each hour until the 2 January rate of 73% is known.
  const hourly = (rate: number) => rate / 365 / 24;
  assert.equal(r.run.cashReturn[23], 0);
  assert.ok(near(r.run.cashReturn[24], hourly(0.365)) && near(r.run.cashReturn[47], hourly(0.365)));
  assert.ok(near(r.run.cashReturn[48], hourly(0.73)));
});

test('Sharpe and Sortino measure returns above the cash rate', () => {
  const t = [day(0), day(1), day(2)];
  // Returns +10% and -10% against 1% a step from cash: excess +9% and -11%.
  const s = computeStats(t, [100, 110, 99], 100, [1, 1, 1], [0, 0.01, 0.01]);
  const perYear = Math.sqrt(365.25);
  assert.ok(near(s.sharpe, (-0.01 / 0.1) * perYear));
  assert.ok(near(s.sortino, (-0.01 / Math.sqrt(0.11 ** 2 / 2)) * perYear));
  // With no cash rate the mean return here is 0.
  assert.ok(near(computeStats(t, [100, 110, 99], 100, [1, 1, 1]).sharpe, 0));
});

test('a run that only earns the cash rate has a Sharpe and Sortino of 0, not rounding noise', () => {
  // Never invested at 4% a year: each step's return equals the cash return up to rounding (about 1e-20).
  const A = bars(Array.from({ length: 20 }, () => 100));
  const r = run('universe: A\ncapital: 10000\ncash rate: 4%\nbuy when false', { A });
  assert.ok(r.stats.totalReturn > 0);
  assert.equal(r.stats.sharpe, 0);
  assert.equal(r.stats.sortino, 0);
  // A real spread above 1e-12 a step still counts.
  const s = computeStats([day(0), day(1), day(2)], [100, 100 + 1e-8, 100], 100, [1, 1, 1]);
  assert.ok(s.sharpe !== 0 && s.sortino !== 0);
});

test('bars held counts completed bars since the entry fill', () => {
  const A = bars([10, 10, 10, 10, 10, 10, 10]);
  const r = run('universe: A\nbuy when true\nsell when bars held >= 2', { A });
  // In on day 1 (0 bars held at that close), 2 at day 3's close, out at day 4's open; back in on day 5.
  assert.deepEqual(r.run.trades.map((t) => [t.entryT, t.exitT, t.reason, t.bars]), [[day(1), day(4), 'signal', 3], [day(5), day(6), 'open', 1]]);
});

test('entry price is the fill price, slippage included', () => {
  const A = bars([100, 100, 95.5, 95.5, 95.5]);
  const rule = 'universe: A\nbuy when true\nsell when close < entry price * 0.95';
  // Filled at 100: 95.5 stays above 95. Filled at 101: 95.5 is below 95.95, so it sells on day 3.
  assert.equal(run(rule, { A }).run.trades[0].reason, 'open');
  const t = run(rule + '\nslippage: 1%', { A }).run.trades[0];
  assert.deepEqual([t.reason, t.exitT], ['signal', day(3)]);
});

// Every bar's true range is 2, so ATR(2) is 2 from bar 1 until bar 3 moves.
const atrBars = (bar3: { o: number; h: number; l: number; c: number }) =>
  bars([100, 100, 100, bar3.c, bar3.c], { opens: [100, 100, 100, bar3.o, bar3.c], highs: [101, 101, 101, bar3.h, bar3.c], lows: [99, 99, 99, bar3.l, bar3.c] });

test('ATR stops use the ATR at the signal bar and keep it for the position', () => {
  // Signal at bar 1 (ATR 2), filled at 100 on bar 2: stop at 96, target at 104.
  const stop = run('universe: A\nstop loss: 2 atr(2)\nbuy when atr(2) > 0', { A: atrBars({ o: 100, h: 101, l: 95, c: 97 }) });
  assert.deepEqual(stop.run.trades.map((t) => [t.entryT, t.exitT, t.exitPrice, t.reason]), [[day(2), day(3), 96, 'stop loss']]);
  const target = run('universe: A\ntake profit: 2 atr(2)\nbuy when atr(2) > 0', { A: atrBars({ o: 100, h: 105, l: 99, c: 103 }) });
  assert.deepEqual(target.run.trades.map((t) => [t.exitPrice, t.reason]), [[104, 'take profit']]);
  // The trailing level is the highest completed high (101 after bar 2) minus 2.
  const trail = run('universe: A\ntrailing stop: 1 atr(2)\nbuy when atr(2) > 0', { A: atrBars({ o: 100, h: 100.5, l: 98.5, c: 99 }) });
  assert.deepEqual(trail.run.trades.map((t) => [t.exitPrice, t.reason]), [[99, 'trailing stop']]);
  // Bought on bar 1 after a signal at bar 0, where ATR(2) is unknown: no stop at all.
  const none = run('universe: A\nstop loss: 2 atr(2)\nbuy when true', { A: atrBars({ o: 100, h: 101, l: 50, c: 97 }) });
  assert.deepEqual(none.run.trades.map((t) => t.reason), ['open']);
});

test('a stop set in a for section applies to that ticker only', () => {
  const drop = () => bars([100, 100, 88, 88], { opens: [100, 100, 100, 88], lows: [100, 100, 85, 88] });
  const r = run('universe: A 50%, B 50%\ncapital: 1000\nstop loss: 10%\nbuy when true\nfor B:\n  stop loss: 20%', { A: drop(), B: drop() });
  assert.deepEqual(r.run.trades.map((t) => [t.asset, t.exitPrice, t.reason]), [['A', 90, 'stop loss'], ['B', 88, 'open']]);
});

test('trade profits, interest and capital add up to the final equity', () => {
  const start = Date.UTC(2020, 0, 28);
  const A = bars([10, 12, 20, 18, 9, 15, 16], { start });
  const B = bars([50, 50, 60, 40, 40, 50, 70], { start });
  const r = run('universe: A 50%, B 30%\ncapital: 1000\ncosts: 10 bps\nslippage: 5 bps\ncash rate: 5%\nrebalance: weekly\nbuy when close > close[1] or true\nsell when close < 10', { A, B });
  assert.ok(r.run.trades.length >= 3);
  const pnl = r.run.trades.reduce((s, t) => s + t.pnl, 0);
  assert.ok(near(r.run.equity[r.run.equity.length - 1], 1000 + pnl + r.interest, 1e-9));
  const open = r.run.states.filter((s) => s.long);
  assert.ok(open.every((s) => near(s.value, s.shares * s.lastClose)));
});
