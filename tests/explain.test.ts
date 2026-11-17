import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { explainTrade, type Explanation, type Row, type Section } from '../src/explain.ts';
import type { Trade } from '../src/engine.ts';
import type { Bars } from '../src/types.ts';
import { bars, near, DAY, T0 } from './helpers.ts';

function run(src: string, data: Record<string, Bars>): Backtest {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  return runBacktest(spec!, new Map(Object.entries(data)));
}
const day = (n: number) => T0 + n * DAY;
const section = (ex: Explanation, id: Section['id']) => ex.sections.find((s) => s.id === id)!.rows;
/** The rows of a section as [label, value, outcome, depth], for comparing whole sections. */
const table = (ex: Explanation, id: Section['id']) => section(ex, id).map((r) => [r.label, r.value, r.outcome, r.depth]);
const find = (ex: Explanation, id: Section['id'], label: string | RegExp): Row => {
  const hit = section(ex, id).find((r) => (typeof label === 'string' ? r.label === label : label.test(r.label)));
  assert.ok(hit, `no row ${label} in ${id}: ${JSON.stringify(table(ex, id))}`);
  return hit;
};

test('a plain rule: when it was read, both sides of the comparison, the size, the fill and the result', () => {
  // close > 10 first holds at day 1's close (12): filled at day 2's open (12). Sold at day 5's open (9).
  const A = bars([10, 12, 12, 15, 9, 9, 9], { opens: [10, 10, 12, 12, 15, 9, 9] });
  const bt = run('universe: A\ncapital: 1000\nbuy when close > 10\nsell when close < 10', { A });
  const ex = explainTrade(bt, bt.run.trades[0]);
  assert.equal(ex.title, 'A: bought 2020-01-03 at 12.00, sold 2020-01-06 at 9.00');
  assert.deepEqual(table(ex, 'bought'), [
    ['The buy rule was read at the close of 2020-01-02.', '', null, 0],
    ['buy when close > 10', 'close 12 > 10', 'yes', 0],
  ]);
  assert.deepEqual(table(ex, 'size'), [
    ['Portfolio value at the open of 2020-01-03', '$1,000.00', null, 0],
    ['Weight', '100% of that: $1,000.00', null, 0],
    ['Money put in', '$1,000.00, for 83.3333 shares', null, 0],
    ['Filled at the open of 2020-01-03', '12.00; the close the rule read was 12.00', null, 0],
  ]);
  assert.deepEqual(table(ex, 'sold'), [
    ['The sell rule was read at the close of 2020-01-05.', '', null, 0],
    ['sell when close < 10', 'close 9 < 10', 'yes', 0],
    ['Sold at the open of 2020-01-06', '9.00', null, 0],
  ]);
  assert.deepEqual(table(ex, 'result'), [
    ['Return after costs', '−25.00%', null, 0],
    ['Profit', '−$250.00', null, 0],
    ['Held', '3 bars, from 2020-01-03 to 2020-01-06', null, 0],
  ]);
  assert.deepEqual(ex.facts, { buyT: day(1), buyRule: 'yes', entryPrice: 12, shares: 1000 / 12, reason: 'signal', sellT: day(4), sellRule: 'yes', level: null, exitPrice: 9, ret: -0.25 });
  assert.ok(section(ex, 'bought')[1].code && !section(ex, 'bought')[0].code);
});

test('a cross shows the bar before as well', () => {
  // sma(2): 10, 10, 9.5, 10.5; sma(3): 10, 9.67, 10.33. Day 4 is the first bar above after one at or below.
  const A = bars([10, 10, 10, 9, 12, 13]);
  const bt = run('universe: A\nbuy when sma(2) crosses above sma(3)', { A });
  const ex = explainTrade(bt, bt.run.trades[0]);
  assert.deepEqual(find(ex, 'bought', 'buy when sma(2) crosses above sma(3)').value, 'sma(2) 10.50 is above sma(3) 10.33; the bar before it was 9.50, at or below 9.67');
  assert.equal(ex.facts.buyT, day(4));
});

test('and, or and not show each part, with an unknown part marked as unknown', () => {
  // On day 0 sma(10) is still warming up, but "or" needs only one part: the buy holds.
  const A = bars([10, 10, 10]);
  const bt = run('universe: A\nbuy when close > 5 and (close > sma(10) or not close < 1)', { A });
  const ex = explainTrade(bt, bt.run.trades[0]);
  assert.deepEqual(table(ex, 'bought').slice(1), [
    ['buy when close > 5 and (close > sma(10) or not close < 1)', 'all of these must hold', 'yes', 0],
    ['close > 5', 'close 10 > 5', 'yes', 1],
    ['(close > sma(10) or not close < 1)', 'one of these is enough', 'yes', 1],
    ['close > sma(10)', 'close 10 > sma(10) unknown', 'unknown', 2],
    ['not close < 1', 'holds when the part below does not', 'yes', 2],
    ['close < 1', 'close 10 < 1', 'no', 3],
  ]);
});

test('a rule written over several lines is quoted joined, without its comments', () => {
  const A = bars([10, 10, 10]);
  const bt = run('universe: A\nbuy when close > 5   # trend\n  and close < 20 // cap', { A });
  assert.equal(section(explainTrade(bt, bt.run.trades[0]), 'bought')[1].label, 'buy when close > 5 and close < 20');
});

test('"of" names the other ticker and the bar of it that was read, on its own calendar', () => {
  // A trades every day from Monday 6 January 2020; W is weekly, dated Mondays. A weekly bar is read
  // once its week is over: W's bar of 6 January (close 20) ends at the start of the 13th, as A's bar
  // of Sunday the 12th does, so that is the first of A's bars to read it.
  const A = bars(Array.from({ length: 12 }, () => 10), { start: Date.UTC(2020, 0, 6) });
  const W = bars([5, 20, 20], { start: Date.UTC(2019, 11, 30), step: 7 * DAY });
  const bt = run('universe: A\nbuy when close of W > 10', { A, W });
  const ex = explainTrade(bt, bt.run.trades[0]);
  assert.equal(ex.facts.buyT, Date.UTC(2020, 0, 12));
  assert.equal(find(ex, 'bought', 'buy when close of W > 10').value, "close of W 20 > 10; read from W's bar of 2020-01-06");
});

test('parameters are named with their values, and percentages read as percentages', () => {
  const A = bars([10, 10, 12, 12]);
  const bt = run('universe: A\nlimit = 5% in 1%..10%\nn = 1 in 1..3\nbuy when roc(n) > limit', { A });
  const ex = explainTrade(bt, bt.run.trades[0]);
  assert.deepEqual(table(ex, 'bought').slice(1), [
    ['buy when roc(n) > limit', 'roc(n) 20% > limit 5%', 'yes', 0],
    ['Parameters', 'n = 1, limit = 5%', null, 0],
  ]);
  // A number written out shows once, negative or not.
  const neg = run('universe: A\nbuy when roc(1) > -5%', { A });
  assert.equal(section(explainTrade(neg, neg.run.trades[0]), 'bought')[1].value, 'roc(1) 0% > -5%');
});

test('a ranking: the place, the cut-off and the whole table, at the buy and at the sell', () => {
  const RANKED = { A: bars([10, 10, 10, 10]), B: bars([20, 20, 5, 5]), C: bars([15, 15, 15, 15]) };
  const bt = run('universe: A, B, C\ncapital: 1000\nhold: top 1 by close', RANKED);
  const ex = explainTrade(bt, bt.run.trades[0]);
  assert.equal(ex.asset, 'B');
  assert.deepEqual(table(ex, 'bought'), [
    ['Chosen at the ranking made at the close of 2020-01-01.', '', null, 0],
    ['There is no buy rule, so every ticker with a known score could be chosen.', '', null, 0],
    ['Ranked 1st of 3 by close. Only the best is held.', 'close 20', null, 0],
    ['The ranking at the close of 2020-01-01, by close:', '', null, 0],
    ['1. B (this one)', '20', 'yes', 1],
    ['2. C', '15', 'no', 1],
    ['3. A', '10', 'no', 1],
  ]);
  assert.equal(ex.facts.buyRule, null);
  assert.deepEqual(table(ex, 'sold'), [
    ['At the ranking made at the close of 2020-01-03:', '', null, 0],
    ['Ranked 3rd of 3 by close. Only the best is held, so it was sold.', 'close 5', null, 0],
    ['The ranking at the close of 2020-01-03, by close:', '', null, 0],
    ['1. C', '15', 'yes', 1],
    ['2. A', '10', 'no', 1],
    ['3. B (this one)', '5', 'no', 1],
    ['Sold at the open of 2020-01-04', '5.00', null, 0],
  ]);
  // A ticker that could not be chosen says why; a ranking with weights shares size between the held.
  const rule = run('universe: A, B, C\ncapital: 1000\nhold: top 2 by close\nbuy when close < 18', RANKED);
  const first = explainTrade(rule, rule.run.trades[0]);
  assert.equal(find(first, 'bought', 'B').value, 'could not be chosen: its buy rule did not hold');
  assert.equal(find(first, 'size', /^Weight/).label, 'Weight: each of the 2 held gets the same share');
});

test('a ranking table prints scores that differ with enough decimals to tell them apart, and says when they are equal', () => {
  const close = (x: number) => bars([x, x, x]);
  const bt = run('universe: A, B, C\ncapital: 1000\nhold: top 1 by close', { A: close(0.012341), B: close(0.012344), C: close(0.012341) });
  const ex = explainTrade(bt, bt.run.trades[0]);
  const tie = 'the ticker listed first in the universe ranks higher';
  assert.deepEqual(table(ex, 'bought').slice(2), [
    ['Ranked 1st of 3 by close. Only the best is held.', 'close 0.012344', null, 0],
    ['The ranking at the close of 2020-01-01, by close:', '', null, 0],
    ['1. B (this one)', '0.012344', 'yes', 1],
    ['2. A', `0.012341, tied with C: ${tie}`, 'no', 1],
    ['3. C', `0.012341, tied with A: ${tie}`, 'no', 1],
  ]);
});

test('a stop loss inside the bar and through a gapped open', () => {
  const spec = 'universe: A\ncapital: 1000\nstop loss: 10%\nbuy when true';
  const inside = run(spec, { A: bars([100, 100, 88, 88], { opens: [100, 100, 100, 88], lows: [100, 100, 85, 88] }) });
  let ex = explainTrade(inside, inside.run.trades[0]);
  assert.deepEqual(table(ex, 'sold'), [
    ['Stop loss at 90.00', '10% under the 100.00 fill', null, 0],
    ['On 2020-01-03 the bar fell to 85.00, through the stop, so it sold at the stop.', '', null, 0],
    ['Sold at the stop', '90.00', null, 0],
  ]);
  assert.deepEqual([ex.facts.level, ex.facts.exitPrice], [90, 90]);
  const gap = run(spec, { A: bars([100, 100, 82, 82], { opens: [100, 100, 80, 82], lows: [100, 100, 79, 82] }) });
  ex = explainTrade(gap, gap.run.trades[0]);
  assert.deepEqual(table(ex, 'sold').slice(1), [
    ['On 2020-01-03 the bar opened at 80.00, below the stop, so it sold at the open.', '', null, 0],
    ['Sold at the open', '80.00', null, 0],
  ]);
  assert.equal(ex.facts.exitPrice, 80);
});

test('a stop and a target in one bar: the stop first, or the target when the bar opens beyond it', () => {
  const both = run('universe: A\ncapital: 1000\ntake profit: 20%\nstop loss: 10%\nbuy when true', {
    A: bars([100, 100, 100, 100], { opens: [100, 100, 100, 100], highs: [100, 100, 130, 100], lows: [100, 100, 85, 100] }),
  });
  let ex = explainTrade(both, both.run.trades[0]);
  assert.equal(ex.facts.reason, 'stop loss');
  find(ex, 'sold', 'The take profit at 120.00 was inside this bar too. When both are, the stop is taken first.');
  const gapUp = run('universe: A\ncapital: 1000\ntake profit: 10%\nstop loss: 10%\nbuy when true', {
    A: bars([100, 100, 95, 95], { opens: [100, 100, 115, 95], highs: [100, 100, 118, 95], lows: [100, 100, 85, 95] }),
  });
  ex = explainTrade(gapUp, gapUp.run.trades[0]);
  assert.deepEqual(table(ex, 'sold'), [
    ['Take profit at 110.00', '10% over the 100.00 fill', null, 0],
    ['On 2020-01-03 the bar opened at 115.00, above the target, so it sold at the open.', '', null, 0],
    ['The bar later fell through the stop at 90.00 too, but the open came first.', '', null, 0],
    ['Sold at the open', '115.00', null, 0],
  ]);
});

test('a trailing stop names the high it trailed from', () => {
  // Bought at 100 on day 1; highs 100 then 120; day 3's level is 120 * 0.9 = 108.
  const A = bars([100, 100, 120, 106, 106], { opens: [100, 100, 100, 120, 106], highs: [100, 100, 120, 120, 106], lows: [100, 100, 100, 105, 106] });
  const bt = run('universe: A\ncapital: 1000\ntrailing stop: 10%\nstop loss: 20%\nbuy when true', { A });
  const ex = explainTrade(bt, bt.run.trades[0]);
  assert.deepEqual(table(ex, 'sold').slice(0, 3), [
    ['Trailing stop at 108.00', '10% under 120.00, the highest price from the buy to the bar before', null, 0],
    ['The stop loss, at 80.00, was lower.', '', null, 0],
    ['On 2020-01-04 the bar fell to 105.00, through the stop, so it sold at the stop.', '', null, 0],
  ]);
  assert.equal(ex.facts.level, 108);
});

test('an ATR stop gives the multiple and the ATR at the bar it was read at', () => {
  // Every true range is 2 until bar 3: the signal at bar 1 fills at 100 on bar 2, with the stop at 96.
  const A = bars([100, 100, 100, 97, 97], { opens: [100, 100, 100, 100, 97], highs: [101, 101, 101, 101, 97], lows: [99, 99, 99, 95, 97] });
  const bt = run('universe: A\nstop loss: 2 atr(2)\nbuy when atr(2) > 0', { A });
  const ex = explainTrade(bt, bt.run.trades[0]);
  assert.equal(find(ex, 'sold', 'Stop loss at 96.00').value, '2 × ATR(2) 2 (at the close of 2020-01-02) = 4 under the 100.00 fill');
  assert.equal(ex.facts.level, 96);
});

test('risk per trade: the sum at risk, the ATR distance, the shares, and the cap at the weight', () => {
  const A = bars([100, 100, 100, 100], { opens: [100, 100, 100, 100], highs: [101, 101, 101, 101], lows: [99, 99, 99, 99] });
  let bt = run('universe: A\ncapital: 1000\nslippage: 1%\nrisk per trade: 1% at 2 atr(2)\nbuy when atr(2) > 0', { A });
  let ex = explainTrade(bt, bt.run.trades[0]);
  assert.deepEqual(table(ex, 'size'), [
    ['Portfolio value at the open of 2020-01-03', '$1,000.00', null, 0],
    ['Risk per trade', '1% of that: $10.00', null, 0],
    ['Distance: 2 × ATR(2) at the close of 2020-01-02', '2 × 2 = 4 a share', null, 0],
    ['Shares that lose $10.00 over that distance', '2.5, worth $252.50 at the fill', null, 0],
    ['Money put in', '$252.50, for 2.5 shares', null, 0],
    ['Filled at the open of 2020-01-03', '100.00, plus 100 bps slippage: 101.00; the close the rule read was 100.00', null, 0],
  ]);
  bt = run('universe: A\ncapital: 1000\nrisk per trade: 10% at 2 atr(2)\nbuy when atr(2) > 0', { A });
  ex = explainTrade(bt, bt.run.trades[0]);
  assert.equal(find(ex, 'size', 'That is more than its weight, so the buy is capped at the weight').value, '100% of that: $1,000.00');
});

test('a buy cut to the cash there was', () => {
  // W is bought on day 2 (50 shares at 10). S fills on day 4, its next bar: its half of 1500 is 750,
  // but only 500 is in cash.
  const W = bars([10, 10, 10, 20, 20, 20]);
  const S: Bars = { t: [day(1), day(4), day(5)], o: [50, 50, 50], h: [50, 50, 100], l: [50, 50, 50], c: [50, 50, 100], v: [1, 1, 1] };
  const bt = run('universe: W 50%, S 50%\ncapital: 1000\nbuy when true', { W, S });
  const ex = explainTrade(bt, bt.run.trades.find((t) => t.asset === 'S')!);
  assert.deepEqual(table(ex, 'size').slice(0, 4), [
    ['Portfolio value at the open of 2020-01-05', '$1,500.00', null, 0],
    ['Weight', '50% of that: $750.00', null, 0],
    ['Only $500.00 was in cash, so the buy was cut to what that covers', '$500.00', null, 0],
    ['Money put in', '$500.00, for 10 shares', null, 0],
  ]);
  // With costs, a buy of the whole portfolio leaves room for them.
  const all = run('universe: W\ncapital: 1000\ncosts: 100 bps\nbuy when true', { W });
  assert.equal(find(explainTrade(all, all.run.trades[0]), 'size', /^The costs are paid on top/).label, 'The costs are paid on top, so the $1,000.00 in cash covered');
});

test('a position still held: valued at the last close, its sell rule there, and the order waiting', () => {
  const A = bars([10, 12, 13, 14]);
  const bt = run('universe: A\ncapital: 1000\ncosts: 10 bps\nbuy when close > 11\nsell when close > 13.5', { A });
  const ex = explainTrade(bt, bt.run.trades[0]);
  assert.equal(ex.title, 'A: bought 2020-01-03 at 12.00, still held');
  assert.equal(ex.sections[2].title, 'Why it is still held');
  assert.deepEqual(table(ex, 'sold'), [
    ['Still held at the end of the run. It is valued at the last close, 2020-01-04.', '14.00', null, 0],
    ['The sell rule at the close of 2020-01-04:', '', null, 0],
    ['sell when close > 13.5', 'close 14 > 13.5', 'yes', 0],
    ['An order to sell it is waiting for the next open.', '', null, 0],
  ]);
  const spent = 1000 / 1.001;
  assert.deepEqual(table(ex, 'result').slice(3), [
    ['Costs paid so far', `$${(spent * 0.001).toFixed(2)}; selling at the last close would cost $${((spent / 12) * 14 * 0.001).toFixed(2)} more`, null, 0],
    ['A position still held counts the cost of selling at the last close in its return, without slippage.', '', null, 0],
  ]);
});

test('intraday bars give the time of day, in UTC', () => {
  const A = bars([10, 12, 12, 12], { step: 3_600_000 });
  const bt = run('universe: A\nbuy when close > 10', { A });
  const ex = explainTrade(bt, bt.run.trades[0]);
  assert.equal(section(ex, 'bought')[0].label, 'The buy rule was read at the close of the bar starting 2020-01-01 01:00 UTC.');
  assert.equal(find(ex, 'size', /^Filled/).label, 'Filled at the open of the bar starting 2020-01-01 02:00 UTC');
  assert.equal(ex.title, 'A: bought 2020-01-01 02:00 UTC at 12.00, still held');
});

test('with fill: close the explanation says the fill was at the close the rule read', () => {
  const A = bars([10, 12, 12, 15, 9, 9, 9], { opens: [10, 10, 12, 12, 15, 9, 9] });
  const bt = run('universe: A\ncapital: 1000\nfill: close\nstop loss: 30%\nbuy when close > 10\nsell when close < 10', { A });
  const ex = explainTrade(bt, bt.run.trades[0]);
  assert.equal(section(ex, 'bought')[0].label, 'The buy rule was read at the close of 2020-01-02.');
  assert.equal(section(ex, 'size')[0].label, 'Portfolio value at the close of 2020-01-02');
  assert.deepEqual(find(ex, 'size', /^Filled/).label, 'Filled at the close of 2020-01-02, the close the rule read');
  assert.deepEqual(table(ex, 'sold').slice(2), [['Sold at the close of 2020-01-05, the close the rule read', '9.00', null, 0]]);
  assert.deepEqual([ex.facts.entryPrice, ex.facts.exitPrice], [12, 9]);
  // A stop the bar after a close buy says the stop watched from that bar.
  const stop = run('universe: A\ncapital: 1000\nfill: close\nstop loss: 10%\nbuy when close >= 100', { A: bars([99, 100, 95, 95], { opens: [99, 99, 100, 95], lows: [99, 80, 85, 95] }) });
  find(explainTrade(stop, stop.run.trades[0]), 'sold', 'Bought at a close, the position was watched by its stops from the next bar on.');
});

test('what held a buy back: an input warming up, the re-arm after a stop, a ranking\'s sells', () => {
  const flat = bars([100, 100, 100, 100], { opens: [100, 100, 100, 100], highs: [101, 101, 101, 101], lows: [99, 99, 99, 99] });
  let bt = run('universe: A\ncapital: 1000\nrisk per trade: 1% at 2 atr(2)\nbuy when true', { A: flat });
  find(explainTrade(bt, bt.run.trades[0]), 'bought', 'The buy rule held from 2020-01-01 on, but the 2-bar ATR for risk per trade was still unknown. A buy waits until the inputs it needs are known, so this was the first close it could buy at.');
  // Stopped on day 1; the rule still holds at days 1 and 2, fails on day 3 and holds again on day 4.
  const B = bars([100, 100, 100, 85, 100, 100], { opens: [100, 100, 100, 100, 85, 100], lows: [100, 85, 100, 85, 85, 100] });
  bt = run('universe: B\nfill: close\nstop loss: 10%\nbuy when close >= 100', { B });
  find(explainTrade(bt, bt.run.trades[1]), 'bought', 'After the stop loss on 2020-01-02 the buy rule still held, last on 2020-01-03. After a stop or target exit the rule has to stop holding before it can buy again: it did not hold on 2020-01-04, and held again at the next close.');
  assert.ok(!section(explainTrade(bt, bt.run.trades[0]), 'bought').some((r) => /After the stop/.test(r.label)));
  // A ranking buy that waited for its decision's sell, on mixed calendars (see the engine's test).
  const jan = (d: number) => Date.UTC(2020, 0, d);
  const days = (from: number, to: number, weekdays: boolean) => {
    const out: number[] = [];
    for (let t = from; t <= to; t += DAY) if (!weekdays || ![0, 6].includes(new Date(t).getUTCDay())) out.push(t);
    return out;
  };
  const cryT = days(Date.UTC(2019, 11, 30), Date.UTC(2020, 1, 4), false);
  const stkT = days(Date.UTC(2019, 11, 30), Date.UTC(2020, 1, 4), true);
  const STK = bars(stkT.map(() => 100), { times: stkT });
  const CRY = bars(cryT.map((t) => (t < jan(31) ? 50 : t < Date.UTC(2020, 1, 4) ? 150 : 300)), { times: cryT });
  bt = run('universe: STK, CRY\ncapital: 1000\nrebalance: monthly\nhold: top 1 by close', { STK, CRY });
  find(explainTrade(bt, bt.run.trades[1]), 'bought', 'The buy waited until the sells of the same ranking had filled (STK), so their cash was there.');
});

test('rebalancing during the position\'s life is counted, and costs are stated', () => {
  const start = Date.UTC(2020, 0, 29);
  const A = bars([10, 20, 20, 40], { start });
  const B = bars([10, 10, 10, 10], { start });
  const bt = run('universe: A 50%, B 50%\ncapital: 1000\ncosts: 10 bps\nfill: close\nrebalance: monthly\nbuy when true', { A, B });
  const [a, b] = bt.run.trades.map((t) => explainTrade(bt, t));
  find(a, 'result', 'Rebalancing trimmed it once.');
  find(b, 'result', 'Rebalancing topped it up once.');
  // A paid the costs of its buy and of its trim.
  const why = bt.run.trades[0].why!;
  assert.ok(why.fees > why.spent * 0.001 * 1.1);
  assert.ok(find(a, 'result', 'Costs paid so far').value.startsWith(`$${why.fees.toFixed(2)};`));
});

// ---------------------------------------------------------------- the explanation agrees with the trade

function walk(n: number, seed: number, drift: number, weekdays: boolean, start = Date.UTC(2019, 0, 1)): Bars {
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let p = 50 + rnd() * 50;
  for (let d = start; out.t.length < n; d += DAY) {
    if (weekdays && [0, 6].includes(new Date(d).getUTCDay())) continue;
    const gap = rnd() < 0.08 ? (rnd() - 0.5) * 0.12 : (rnd() - 0.5) * 0.01;
    const o = p * (1 + gap);
    const c = o * (1 + drift + (rnd() - 0.5) * 0.05);
    out.t.push(d);
    out.o.push(o);
    out.c.push(c);
    out.h.push(Math.max(o, c) * (1 + rnd() * 0.02));
    out.l.push(Math.min(o, c) * (1 - rnd() * 0.02));
    out.v.push(1000);
    p = c;
  }
  return out;
}

const STRATEGIES = [
  'universe: A\ncosts: 5 bps\nslippage: 3 bps\nstop loss: 4%\ntake profit: 7%\nbuy when sma(5) crosses above sma(20)\nsell when sma(5) crosses below sma(20)',
  'universe: A, B\nfast = 8 in 4..12 step 2\ntrailing stop: 2 atr(10)\nbuy when close > sma(fast) and (rsi(14) < 70 or close of X > sma(30) of X)\nsell when close < sma(fast) or bars held >= 15',
  'universe: A 40%, B 30%, C 20%\nrebalance: monthly\ncosts: 5 bps\nbuy when close > ema(20)\nsell when close < ema(20) * 0.97',
  'universe: A, B, C, D\nhold: top 2 by roc(15)\nrebalance: weekly\ntrailing stop: 6%\nbuy when close > sma(30)\nsell when close < sma(30)',
  'universe: A, B, C, D\nhold: top 1 by -stdev(10)\nstop loss: 2 atr(14)\ntake profit: 3 atr(14)',
  'universe: C\nrisk per trade: 1% at 2 atr(14)\nstop loss: 2 atr(14)\nbuy when close > highest(20)[1]\nsell when close < lowest(10)[1]',
  'universe: A, C\nweighting: inverse volatility(20)\nrebalance: monthly\nbuy when close > sma(25)\nsell when close < sma(25)',
  'universe: A, B\nlimit = 3% in 1%..5%\nbuy when roc(5) > limit and not close < close[3]\nsell when close < entry price * 0.95 or bars held >= 8',
  'universe: A, B, C\nrebalance: monthly\nhold: top 1 by roc(20)',
];

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * The dates the words give for a trade's decisions are the ones the engine recorded: the ranking's own close, the bar it
 * read, and with fill: close "the close the rule read" only when the fill was at that close, otherwise the close read.
 * Returns how many fills came at a later close than the one read.
 */
function checkDates(bt: Backtest, t: Trade, ex: Explanation): number {
  const why = t.why!;
  const atClose = bt.spec.fill === 'close';
  let later = 0;
  const first = section(ex, 'bought')[0].label;
  if (why.rank) {
    assert.ok(first.includes(`made at the close of ${iso(why.rank.decision.t)}`), first);
    if (why.rank.decision.t === why.buyT) assert.ok(!first.includes('which read'), first);
    else assert.ok(first.includes(`which read its bar of ${iso(why.buyT)}`), first);
  } else {
    assert.equal(first, `The buy rule was read at the close of ${iso(why.buyT)}.`);
  }
  const by = why.rank ? 'ranking' : 'rule';
  const filled = find(ex, 'size', /^Filled at the/).label;
  if (atClose) {
    assert.ok(filled.startsWith(`Filled at the close of ${iso(t.entryT)}`), filled);
    if (why.buyT === t.entryT) assert.ok(filled.endsWith(`, the close the ${by} read`), filled);
    else {
      later++;
      assert.ok(filled.endsWith(`; the ${by} read the close of ${iso(why.buyT)}`), filled);
    }
  }
  const exit = why.exit;
  if (exit && exit.k !== 'level') {
    const sold = section(ex, 'sold').at(-1)!.label;
    const head = section(ex, 'sold')[0].label;
    assert.ok(head.includes(iso(exit.k === 'rule' ? exit.t : exit.rank.decision.t)), head);
    if (atClose) {
      const said = exit.k === 'rank' ? 'ranking' : 'rule';
      assert.ok(sold.startsWith(`Sold at the close of ${iso(t.exitT)}`), sold);
      if (exit.t === t.exitT) assert.ok(sold.endsWith(`, the close the ${said} read`), sold);
      else {
        later++;
        assert.ok(sold.endsWith(`; the ${said} read the close of ${iso(exit.t)}`), sold);
      }
    }
  }
  return later;
}

test('every trade\'s explanation agrees with the trade, with either kind of fill', () => {
  const data = { A: walk(500, 7, 0.0008, true), B: walk(500, 11, 0.0003, true), C: walk(700, 23, 0.0005, false), D: walk(480, 31, 0.0002, true, Date.UTC(2019, 0, 20)), X: walk(500, 41, 0.0004, true) };
  let checked = 0;
  for (const src of STRATEGIES) {
    for (const fill of ['', '\nfill: close']) {
      const bt = run(src + fill, data);
      assert.ok(bt.run.trades.length > 0, `no trades for ${src + fill}`);
      for (const t of bt.run.trades) {
        const ex = explainTrade(bt, t);
        const why = t.why!;
        const where = `${src + fill}\n${ex.title}`;
        const f = ex.facts;
        assert.equal(f.buyT, why.buyT);
        assert.ok(f.buyRule === 'yes' || (f.buyRule === null && bt.spec.rank !== null), `buy rule ${f.buyRule} at the signal: ${where}`);
        assert.ok(near(f.entryPrice, t.entryPrice, 1e-12 * t.entryPrice), `entry ${f.entryPrice} vs ${t.entryPrice}: ${where}`);
        assert.ok(near(f.shares, why.shares, 1e-9 * why.shares), `shares: ${where}`);
        assert.equal(f.reason, t.reason);
        if (why.exit?.k === 'rule') assert.equal(f.sellRule, 'yes', `sell rule at its bar: ${where}`);
        if (why.exit?.k === 'level') assert.ok(near(f.level!, why.exit.level, 1e-9 * why.exit.level), `level ${f.level} vs ${why.exit.level}: ${where}`);
        if (t.reason === 'stop loss') assert.ok(near(f.level!, why.stopLoss!, 1e-9 * f.level!), `stop loss level: ${where}`);
        if (t.reason === 'take profit') assert.ok(near(f.level!, why.takeProfit!, 1e-9 * f.level!), `target level: ${where}`);
        assert.ok(near(f.exitPrice, t.exitPrice, 1e-12 * t.exitPrice), `exit ${f.exitPrice} vs ${t.exitPrice}: ${where}`);
        assert.ok(near(f.ret, t.ret, 1e-12), `return: ${where}`);
        // Every condition row has an outcome, and the words name the fill as the engine made it.
        const fillRow = find(ex, 'size', /^Filled at the/);
        assert.match(fillRow.label, fill ? /^Filled at the close of/ : /^Filled at the open of/);
        if (t.reason === 'signal') assert.match(section(ex, 'sold').at(-1)!.label, fill ? /^Sold at the close of/ : /^Sold at the open of/);
        checkDates(bt, t, ex);
        checked++;
      }
    }
  }
  assert.ok(checked > 200, `only ${checked} trades checked`);
});

test('a mixed-calendar ranking with close fills: every trade\'s words give the decision and the bar it read as recorded', () => {
  // The review's case: two weekday stocks and a ticker that trades every day, ranked monthly and filled at the close.
  const series = (n: number, seed: number, weekdays: boolean): Bars => {
    let x = seed;
    const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    const out: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
    let p = 50 + rnd() * 50;
    for (let d = Date.UTC(2019, 0, 1); out.t.length < n; d += DAY) {
      if (weekdays && [0, 6].includes(new Date(d).getUTCDay())) continue;
      const o = p * (1 + (rnd() - 0.5) * 0.01);
      const c = o * (1 + (rnd() - 0.5) * 0.06);
      out.t.push(d);
      out.o.push(o);
      out.c.push(c);
      out.h.push(Math.max(o, c) * (1 + rnd() * 0.02));
      out.l.push(Math.min(o, c) * (1 - rnd() * 0.02));
      out.v.push(1000);
      p = c;
    }
    return out;
  };
  const bt = run('universe: STK, STK2, CRY\nfill: close\nrebalance: monthly\nhold: top 1 by roc(20)', { STK: series(500, 7, true), STK2: series(500, 9, true), CRY: series(700, 11, false) });
  assert.ok(bt.run.trades.length >= 10);
  let later = 0;
  for (const t of bt.run.trades) later += checkDates(bt, t, explainTrade(bt, t));
  // Some buys and sells fill a close or more after the bar the ranking read; their words must say so.
  assert.ok(later >= 5, `only ${later} later fills`);
});

const STEP_STRATEGIES = [
  'universe: A\ncosts: 5 bps\nslippage: 3 bps\ncommission: 1\nentries: 3\nstop loss: 4%\ntake profit: 9%\nbuy when sma(5) crosses above sma(20)\nadd when close > last entry price * 1.01\nsell when sma(5) crosses below sma(20)',
  'universe: A, B\ncommission: 0.01 per share, min 1, max 1%\nentries: 2\ntrailing stop: 2 atr(10)\nbuy when close > sma(10)\nadd when bars held >= 3 and close > entry price\nsell when close < sma(10) or bars held >= 15',
  'universe: A 40%, B 30%, C 20%\nrebalance: monthly\ncosts: 5 bps\ncommission: 2\nentries: 3\nbuy when close > ema(20)\nadd when close > ema(10)\nsell when close < ema(20) * 0.97',
  'universe: A, B, C, D\nhold: top 2 by roc(15)\nrebalance: weekly\nentries: 2\nadd when close > entry price * 1.02\nstop loss: 2 atr(14)\nbuy when close > sma(30)\nsell when close < sma(30)',
  'universe: C\nrisk per trade: 1% at 2 atr(14)\nentries: 4\nstop loss: 2 atr(14)\nbuy when close > highest(20)[1]\nadd when close > highest(10)[1]\nsell when close < lowest(10)[1]',
  'universe: A, C\nweighting: inverse volatility(20)\nrebalance: monthly\nentries: 2\nadd when close < entry price * 0.98\nbuy when close > sma(25)\nsell when close < sma(25)',
  'universe: A, B\nentries: 3\ncommission: 0.5\nadd when entries made < 3 and close < last entry price\nbuy when roc(5) > 2%\nsell when close > entry price * 1.05 or bars held >= 10\ntake profit: 6%',
];

test('every explanation of a position built in entries, with a commission or not, agrees with its trade, entry by entry', () => {
  const data = { A: walk(500, 7, 0.0008, true), B: walk(500, 11, 0.0003, true), C: walk(700, 23, 0.0005, false), D: walk(480, 31, 0.0002, true, Date.UTC(2019, 0, 20)) };
  let checked = 0;
  let several = 0;
  for (const src of STEP_STRATEGIES) {
    for (const fill of ['', 'fill: close\n']) {
      const bt = run(fill + src, data);
      for (const t of bt.run.trades) {
        const ex = explainTrade(bt, t);
        const why = t.why!;
        const where = `${fill + src}\n${ex.title}`;
        const f = ex.facts;
        assert.equal(f.buyT, why.buyT);
        assert.ok(f.buyRule === 'yes' || (f.buyRule === null && bt.spec.rank !== null), `buy rule: ${where}`);
        assert.ok(near(f.entryPrice, t.entryPrice, 1e-12 * t.entryPrice), `entry ${f.entryPrice} vs ${t.entryPrice}: ${where}`);
        assert.ok(near(f.shares, why.shares, 1e-9 * why.shares), `shares: ${where}`);
        assert.equal(f.entries!.length, t.entries!.length, where);
        t.entries!.forEach((e, k) => {
          const g = f.entries![k];
          assert.deepEqual([g.t, g.signalT], [e.t, e.signalT], `entry ${k}: ${where}`);
          assert.ok(k === 0 ? g.rule === f.buyRule : g.rule === 'yes', `entry ${k} rule ${g.rule}: ${where}`);
          assert.ok(near(g.price, e.price, 1e-12 * e.price) && near(g.shares, e.shares, 1e-9 * e.shares), `entry ${k} fill: ${where}`);
        });
        assert.equal(ex.sections.filter((s) => s.id === 'add').length, t.entries!.length - 1);
        assert.equal(f.reason, t.reason);
        if (why.exit?.k === 'rule') assert.equal(f.sellRule, 'yes', `sell rule at its bar: ${where}`);
        if (why.exit?.k === 'level') assert.ok(near(f.level!, why.exit.level, 1e-9 * why.exit.level), `level ${f.level} vs ${why.exit.level}: ${where}`);
        if (t.reason === 'stop loss') assert.ok(near(f.level!, why.stopLoss!, 1e-9 * f.level!), `stop loss level: ${where}`);
        if (t.reason === 'take profit') assert.ok(near(f.level!, why.takeProfit!, 1e-9 * f.level!), `target level: ${where}`);
        assert.ok(near(f.exitPrice, t.exitPrice, 1e-12 * t.exitPrice), `exit ${f.exitPrice} vs ${t.exitPrice}: ${where}`);
        assert.ok(near(f.ret, t.ret, 1e-12), `return ${f.ret} vs ${t.ret}: ${where}`);
        checkDates(bt, t, ex);
        checked++;
        if (t.entries!.length > 1) several++;
      }
    }
  }
  assert.ok(checked > 500 && several > 250, `${checked} trades checked, ${several} with several entries`);
});
