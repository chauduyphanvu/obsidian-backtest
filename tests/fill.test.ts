import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOSE_FILL_NOTE, runBacktest } from '../src/backtest.ts';
import { parseSpec, RESERVED, SETTINGS } from '../src/dsl.ts';
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
const mar = (d: number) => Date.UTC(2020, 2, d);
/** A run's results without the explanation records, to compare two runs number for number. */
const plain = (r: ReturnType<typeof run>) => ({
  t: r.run.t,
  equity: r.run.equity,
  exposure: r.run.exposure,
  trades: r.run.trades.map(({ why, ...t }) => t),
  states: r.run.states,
  costs: r.run.costs,
  bench: r.benchmark.equity,
});

test('fill: the setting reads "next open" and "close" in any case, and names both for anything else', () => {
  assert.ok(SETTINGS.includes('fill'));
  assert.ok(RESERVED.has('fill'));
  const fill = (line: string) => parseSpec(`universe: SPY\n${line}\nbuy when true`);
  assert.equal(fill('fill: close').spec!.fill, 'close');
  assert.equal(fill('fill: CLOSE').spec!.fill, 'close');
  assert.equal(fill('fill: Next  Open').spec!.fill, 'next open');
  assert.equal(parseSpec('universe: SPY\nbuy when true').spec!.fill, 'next open');
  for (const bad of ['fill: open', 'fill: next close', 'fill: market on close']) {
    const { spec, errors } = fill(bad);
    assert.equal(spec, null);
    assert.deepEqual(errors.map((e) => [e.line, e.message]), [[2, 'fill must be one of: next open, close']]);
  }
  assert.match(fill('fill = 3').errors[0].message, /"fill" is a built-in name/);
});

test('a written "fill: next open" changes nothing', () => {
  const A = bars([10, 12, 12, 15, 9, 9, 9, 13, 14], { opens: [10, 10, 12, 12, 15, 9, 9, 9, 13] });
  const src = 'universe: A\ncapital: 1000\ncosts: 10 bps\nslippage: 5 bps\nstop loss: 20%\nbuy when close > 10\nsell when close < 10';
  assert.deepEqual(plain(run(src + '\nfill: next open', { A })), plain(run(src, { A })));
});

test('with fill: close a rule fills at the close it was read at', () => {
  // close > 10 first holds at day 1's close (12): bought there. close < 10 at day 4's close (9): sold there.
  const A = bars([10, 12, 12, 15, 9, 9, 9], { opens: [10, 10, 12, 12, 15, 9, 9] });
  const r = run('universe: A\ncapital: 1000\nfill: close\nbuy when close > 10\nsell when close < 10', { A });
  assert.deepEqual(r.run.trades.map((t) => [t.entryT, t.entryPrice, t.exitT, t.exitPrice, t.reason, t.bars]), [[day(1), 12, day(4), 9, 'signal', 3]]);
  assert.deepEqual(r.run.equity, [1000, 1000, 1000, 1250, 750, 750, 750]);
  // Positions are marked after the close's fills, so day 1 already holds and day 4 does not.
  assert.deepEqual(r.run.exposure, [0, 1, 1, 1, 0, 0, 0]);
  assert.ok(r.notes.includes(CLOSE_FILL_NOTE));
  assert.ok(!run('universe: A\nbuy when close > 10', { A }).notes.includes(CLOSE_FILL_NOTE));
});

test('with fill: close costs and slippage apply to the close as to an open', () => {
  const A = bars([10, 10, 20, 20], { opens: [10, 10, 10, 20] });
  const r = run('universe: A\ncapital: 1000\nfill: close\nslippage: 1%\ncosts: 100 bps\nbuy when true\nsell when close > 15', { A });
  // Bought at day 0's close at 10 * 1.01 with 1000 / 1.01; sold at day 2's close at 20 * 0.99.
  const t = r.run.trades[0];
  assert.deepEqual([t.entryT, t.exitT, t.reason], [day(0), day(2), 'signal']);
  assert.ok(near(t.entryPrice, 10.1) && near(t.exitPrice, 19.8));
  const shares = 1000 / 1.01 / 10.1;
  assert.ok(near(r.run.equity[0], shares * 10));
  assert.ok(near(r.run.equity[2], shares * 19.8 * 0.99));
  assert.ok(near(t.ret, (19.8 * 0.99) / (10.1 * 1.01) - 1));
});

test('with fill: close the stops watch a position from the bar after the one it was bought at', () => {
  const spec = 'universe: A\ncapital: 1000\nfill: close\nstop loss: 10%\nbuy when close >= 100';
  // Bought at day 1's close (100). Day 1's own low of 80 came before the fill and does not count.
  // Day 2 trades down to 85: out at the stop, 90.
  const inside = bars([99, 100, 95, 95], { opens: [99, 99, 100, 95], lows: [99, 80, 85, 95] });
  let r = run(spec, { A: inside });
  assert.deepEqual(r.run.trades.map((t) => [t.entryT, t.exitT, t.exitPrice, t.reason, t.bars]), [[day(1), day(2), 90, 'stop loss', 1]]);
  // Day 2 opens at 80, below the stop: out at the open.
  const gap = bars([99, 100, 82, 82], { opens: [99, 99, 80, 82], lows: [99, 99, 79, 82] });
  r = run(spec, { A: gap });
  assert.deepEqual(r.run.trades.map((t) => [t.exitT, t.exitPrice]), [[day(2), 80]]);
});

test('with fill: close the trailing stop starts from the close it was bought at', () => {
  // Bought at day 1's close (100), with a 10% trailing stop. Day 2's level is 90 (its high of 120
  // counts once the bar is done), so a low of 105 holds. Day 3's level is 108: out there.
  const A = bars([99, 100, 115, 106, 106], { opens: [99, 99, 100, 115, 106], highs: [99, 125, 120, 115, 106], lows: [99, 95, 105, 105, 106] });
  const r = run('universe: A\ncapital: 1000\nfill: close\ntrailing stop: 10%\nbuy when close >= 100', { A });
  assert.deepEqual(r.run.trades.map((t) => [t.entryT, t.exitT, t.exitPrice, t.reason]), [[day(1), day(3), 108, 'trailing stop']]);
  assert.deepEqual(r.run.trades[0].why!.exit, { k: 'level', level: 108, high: 120, atOpen: false });
});

test('with fill: close a stop and a target in one bar: the stop first, unless the bar opens beyond the target', () => {
  const both = bars([100, 100, 100, 100], { opens: [100, 100, 100, 100], highs: [100, 130, 130, 100], lows: [100, 70, 85, 100] });
  const r = run('universe: A\ncapital: 1000\nfill: close\ntake profit: 20%\nstop loss: 10%\nbuy when true', { A: both });
  // Bought at day 0's close. Day 1 holds both levels (and so does day 0's range, which doesn't count): the stop.
  assert.deepEqual(r.run.trades.map((t) => [t.exitT, t.exitPrice, t.reason]), [[day(1), 90, 'stop loss']]);
  const gapUp = bars([100, 95, 95], { opens: [100, 125, 95], highs: [100, 126, 95], lows: [100, 85, 95] });
  const up = run('universe: A\ncapital: 1000\nfill: close\ntake profit: 20%\nstop loss: 10%\nbuy when true', { A: gapUp });
  assert.deepEqual(up.run.trades.map((t) => [t.exitT, t.exitPrice, t.reason]), [[day(1), 125, 'take profit']]);
});

test('with fill: close a stopped ticker waits for its buy rule to stop holding, then buys at that close', () => {
  // In at day 0's close (100); stopped at 90 on day 1. The rule holds on days 1 and 2, fails on day 3
  // (close 85) and holds again on day 4: back in at day 4's close.
  const B = bars([100, 100, 100, 85, 100, 100], { opens: [100, 100, 100, 100, 85, 100], lows: [100, 85, 100, 85, 85, 100] });
  const r = run('universe: B\nfill: close\nstop loss: 10%\nbuy when close >= 100', { B });
  assert.deepEqual(r.run.trades.map((t) => [t.entryT, t.exitT, t.reason]), [[day(0), day(1), 'stop loss'], [day(4), day(5), 'open']]);
});

test('with fill: close bars held counts from the close of the buy, and a sell and a buy never meet at one close', () => {
  const A = bars([10, 10, 10, 10, 10, 10, 10]);
  const r = run('universe: A\nfill: close\nbuy when true\nsell when bars held >= 2', { A });
  // In at day 0's close; 2 bars held at day 2's close: out there. Day 3's close reads the buy rule again.
  assert.deepEqual(r.run.trades.map((t) => [t.entryT, t.exitT, t.reason, t.bars]), [[day(0), day(2), 'signal', 2], [day(3), day(5), 'signal', 2], [day(6), day(6), 'open', 0]]);
});

test('with fill: close the last bar leaves nothing pending, and the state says what traded at that close', () => {
  const A = bars([10, 10, 12]);
  const r = run('universe: A\ncapital: 1200\nfill: close\nslippage: 1%\nbuy when close > 11', { A });
  assert.deepEqual(r.run.trades.map((t) => [t.entryT, t.reason, t.bars]), [[day(2), 'open', 0]]);
  const [st] = r.run.states;
  assert.equal(st.pending, null);
  assert.ok(st.long);
  assert.equal(st.filled!.side, 'buy');
  assert.ok(near(st.filled!.price, 12.12) && near(st.filled!.shares, 1200 / 12.12));
  // A sell at the last close is reported the same way; a bar with no order has null.
  const B = bars([10, 12, 12, 9]);
  const out = run('universe: B\nfill: close\nbuy when close > 11\nsell when close < 10', { B });
  assert.deepEqual([out.run.states[0].long, out.run.states[0].pending, out.run.states[0].filled?.side], [false, null, 'sell']);
  assert.equal(run('universe: B\nfill: close\nbuy when close > 11', { B }).run.states[0].filled, null);
  // A stop taken inside the last bar is not an order filled at its close.
  const stopped = run('universe: B\nfill: close\nbuy when close > 11\nstop loss: 10%', { B });
  assert.deepEqual([stopped.run.trades[0].reason, stopped.run.states[0].long, stopped.run.states[0].filled], ['stop loss', false, null]);
  // Without fill: close the state has no such field at all.
  assert.ok(!('filled' in run('universe: B\nbuy when close > 11', { B }).run.states[0]));
});

test('with fill: close rebalancing trades at each ticker\'s last close of the period', () => {
  // Wednesday 29 January to Saturday 1 February 2020, every day. Bought at the first close, 50 shares
  // each. A doubles on the 30th: 1000 and 500. The 31st is both tickers' last bar of January, so at
  // its close A sells 12.5 shares at 20 and B buys 25 at 10, to 750 each. A doubles again on 1 February.
  const A = bars([10, 20, 20, 40], { start: jan(29) });
  const B = bars([10, 10, 10, 10], { start: jan(29) });
  const r = run('universe: A 50%, B 50%\ncapital: 1000\nfill: close\nrebalance: monthly\nbuy when true', { A, B });
  assert.deepEqual(r.run.equity, [1000, 1500, 1500, 2250]);
  assert.deepEqual(r.run.states.map((s) => s.shares), [37.5, 75]);
  assert.deepEqual(r.run.trades.map((t) => [t.why!.trims, t.why!.topUps]), [[1, 0], [0, 1]]);
  // The benchmark buys at the same first close and rebalances at the same close.
  assert.deepEqual(r.benchmark.equity, [1000, 1500, 1500, 2250]);
  assert.equal(run('universe: A 50%, B 50%\ncapital: 1000\nfill: close\nbuy when true', { A, B }).run.equity[3], 2500);
});

test('with fill: close a top-up short of cash is owed until the ticker\'s next rebalance, and completed as cash arrives', () => {
  // Thursday 27 February to Tuesday 3 March 2020. STK trades on weekdays, CRY every day, so STK's last
  // February bar is Friday the 28th and CRY's is Saturday the 29th.
  const STK = bars([10, 10, 10, 20], { times: [feb(27), feb(28), mar(2), mar(3)] });
  const CRY = bars([10, 20, 20, 20, 20, 20], { start: feb(27) });
  const r = run('universe: STK 50%, CRY 50%\ncapital: 1000\nfill: close\nrebalance: monthly\nbuy when true', { STK, CRY });
  // 50 shares each at Thursday's close. CRY doubles on Friday: 500 and 1000. Friday's close: STK
  // wants 250 more, with no cash, so it is owed. Saturday's close: CRY sells 12.5 shares at 20 down
  // to 750. Monday's close: STK's top-up buys 25 shares at 10 with that 250. STK doubles on Tuesday.
  assert.deepEqual(r.run.equity, [1000, 1500, 1500, 1500, 1500, 2250]);
  assert.deepEqual(r.run.states.map((s) => s.shares), [75, 37.5]);
});

test('with fill: close a ranking switches at the decision\'s close', () => {
  const RANKED = { A: bars([10, 10, 10, 10]), B: bars([20, 20, 5, 5]), C: bars([15, 15, 15, 15]) };
  const r = run('universe: A, B, C\ncapital: 1000\nfill: close\nhold: top 1 by close', RANKED);
  // B leads at day 0's close and is bought there; at day 2's close C leads: B sold at 5 and C bought at 15.
  assert.deepEqual(r.run.trades.map((t) => [t.asset, t.entryT, t.exitT, t.reason]), [['B', day(0), day(2), 'signal'], ['C', day(2), day(3), 'open']]);
  [1000, 1000, 250, 250].forEach((v, i) => assert.ok(near(r.run.equity[i], v)));
});

test('with fill: close a ranking decision on a day a ticker has no bar fills at its next close, and the buys wait for it', () => {
  // 27 January to 3 March 2020: CRY every day, STK on weekdays. With monthly decisions February ends on
  // Saturday the 29th, a day STK has no bar.
  const days = (from: number, to: number, weekdays: boolean) => {
    const out: number[] = [];
    for (let t = from; t <= to; t += DAY) if (!weekdays || ![0, 6].includes(new Date(t).getUTCDay())) out.push(t);
    return out;
  };
  const cryT = days(jan(27), mar(3), false);
  const stkT = days(jan(27), mar(3), true);
  const STK = bars(stkT.map(() => 100), { times: stkT });
  const CRY = bars(cryT.map((t) => (t < feb(29) ? 50 : t < mar(3) ? 150 : 300)), { times: cryT });
  const r = run('universe: STK, CRY\ncapital: 1000\nfill: close\nrebalance: monthly\nhold: top 1 by close', { STK, CRY });
  // 31 January picks STK, bought at that close. 29 February picks CRY: STK sells at its next close,
  // Monday 2 March, and CRY's buy waits through Sunday for that cash, then fills at the same close.
  assert.deepEqual(r.run.trades.map((t) => [t.asset, t.entryT, t.exitT, t.reason]), [['STK', jan(31), mar(2), 'signal'], ['CRY', mar(2), mar(3), 'open']]);
  assert.equal(r.run.trades[1].why!.waited, true);
  assert.deepEqual(r.run.trades[1].why!.rank!.decision.sold, ['STK']);
  assert.ok(near(r.run.equity[r.run.equity.length - 1], 2000));
});

test('with fill: close risk per trade reads the ATR at the close it fills at', () => {
  // Every bar's true range is 2, so ATR(2) is 2 from bar 1: the signal at bar 0 waits, bar 1 buys at its close.
  const A = bars([100, 100, 100, 100], { opens: [100, 100, 100, 100], highs: [101, 101, 101, 101], lows: [99, 99, 99, 99] });
  const r = run('universe: A\ncapital: 1000\nfill: close\nrisk per trade: 1% at 2 atr(2)\nbuy when true', { A });
  assert.equal(r.run.trades[0].entryT, day(1));
  assert.ok(near(r.run.states[0].shares, 2.5));
  assert.deepEqual(r.run.trades[0].why!.warmup, { input: 'risk per trade', n: 2, fromT: day(0) });
});
