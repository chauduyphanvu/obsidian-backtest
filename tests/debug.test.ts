import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { price, stamp } from '../src/dom.ts';
import { parseSpec } from '../src/dsl.ts';
import type { Trade } from '../src/engine.ts';
import {
  barOnOrAfter,
  cellText,
  debugColumns,
  debugCsv,
  debugRange,
  debugRows,
  interesting,
  nearMiss,
  positionWords,
  rankingAt,
  tradeStops,
  type DebugRow,
} from '../src/debug.ts';
import { makeRng } from '../src/rng.ts';
import type { Bars } from '../src/types.ts';
import { bars, near, DAY, T0 } from './helpers.ts';

function run(src: string, data: Record<string, Bars>, overrides?: Record<string, number>): Backtest {
  const { spec, errors } = parseSpec(src, { overrides });
  assert.deepEqual(errors, []);
  return runBacktest(spec!, new Map(Object.entries(data)));
}
const rowsOf = (bt: Backtest, asset = 'A'): DebugRow[] => debugRows(bt, asset, 0, debugRange(bt, asset).count);
const day = (n: number) => T0 + n * DAY;
/** The cell of column `n` of a row, as [outcome, a, b]. */
const cell = (row: DebugRow, n: number) => [row.cells[n].outcome, row.cells[n].a, row.cells[n].b];
const outcomes = (rows: DebugRow[], n: number) => rows.map((r) => r.cells[n].outcome);
const kinds = (row: DebugRow) => row.events.map((e) => e.k);

test('a plain rule: one column each for the rules, the two sides of each comparison, and what happened at each bar', () => {
  // close > 10 first holds at day 1's close (12): filled at day 2's open (12). Sold at day 5's open (9), decided at day 4's close.
  const A = bars([10, 12, 12, 15, 9, 9, 9], { opens: [10, 10, 12, 12, 15, 9, 9] });
  const bt = run('universe: A\ncapital: 1000\nbuy when close > 10\nsell when close < 10', { A });
  const cols = debugColumns(bt, 'A');
  assert.deepEqual(cols.map((c) => [c.id, c.group, c.kind, c.whole, c.text, c.op]), [
    ['buy:0', 'buy', 'test', true, 'close > 10', '>'],
    ['sell:0', 'sell', 'test', true, 'close < 10', '<'],
  ]);
  assert.deepEqual(debugRange(bt, 'A'), { count: 7, from: day(0), to: day(6) });
  const rows = rowsOf(bt);
  assert.deepEqual(rows.map((r) => r.close), [10, 12, 12, 15, 9, 9, 9]);
  assert.deepEqual(rows.map((r) => cell(r, 0)), [['no', 10, 10], ['yes', 12, 10], ['yes', 12, 10], ['yes', 15, 10], ['no', 9, 10], ['no', 9, 10], ['no', 9, 10]]);
  assert.deepEqual(rows.map((r) => r.held), [false, false, true, true, true, false, false]);
  assert.deepEqual(rows.map((r) => r.readHeld), [false, false, true, true, true, false, false]);
  assert.deepEqual(rows.map((r) => r.buy), ['no', 'yes', 'yes', 'yes', 'no', 'no', 'no']);
  assert.deepEqual(rows.map((r) => r.what), [
    '',
    'Buy rule held: bought at the next open (2020-01-03) at 12.00.',
    'Bought at the open at 12.00.',
    'Buy rule held but already long.',
    'Sell rule held: sold at the next open (2020-01-06) at 9.00.',
    'Sold at the open at 9.00.',
    '',
  ]);
  assert.deepEqual(rows.map((r) => kinds(r)), [[], ['buy'], ['buy'], ['long'], ['sell'], ['sell'], []]);
  assert.ok(near(rows[2].shares, 1000 / 12));
  assert.deepEqual(rows.map(positionWords), ['Flat', 'Flat', 'Long, 83.3333 shares', 'Long, 83.3333 shares', 'Long, 83.3333 shares', 'Flat', 'Flat']);
  // The sell rule does not read the position, so it is shown on every bar, and is in play only while held.
  assert.deepEqual(outcomes(rows, 1), ['no', 'no', 'no', 'no', 'yes', 'yes', 'yes']);
  assert.deepEqual(rows.map((r) => r.sell), ['no', 'no', 'no', 'no', 'yes', 'yes', 'yes']);
  assert.deepEqual(cellText(cols[0], rows[1].cells[0]), { main: '12 > 10', detail: '' });
});

test('and, or and not: a column for each part and one for the whole, and an unknown part does not hide the others', () => {
  // sma(3) is unknown on the first two bars.
  const A = bars([10, 12, 12, 13, 14, 3]);
  const bt = run('universe: A\nbuy when close > sma(3) and not close < 5', { A });
  const cols = debugColumns(bt, 'A');
  assert.deepEqual(cols.map((c) => [c.kind, c.depth, c.whole, c.text]), [
    ['test', 1, false, 'close > sma(3)'],
    ['join', 1, false, 'not close < 5'],
    ['test', 2, false, 'close < 5'],
    ['join', 0, true, 'close > sma(3) and not close < 5'],
  ]);
  assert.equal(cols[3].heading, 'Whole rule');
  const rows = rowsOf(bt);
  assert.deepEqual(outcomes(rows, 0), ['unknown', 'unknown', 'yes', 'yes', 'yes', 'no']);
  assert.deepEqual(outcomes(rows, 1), ['yes', 'yes', 'yes', 'yes', 'yes', 'no']);
  assert.deepEqual(outcomes(rows, 2), ['no', 'no', 'no', 'no', 'no', 'yes']);
  // and: unknown while one part is unknown and the other holds; false as soon as one part is false.
  assert.deepEqual(outcomes(rows, 3), ['unknown', 'unknown', 'yes', 'yes', 'yes', 'no']);
  assert.deepEqual(rows.map((r) => r.buy), ['unknown', 'unknown', 'yes', 'yes', 'yes', 'no']);
  assert.deepEqual(rows[0].cells[0].note, 'still warming up');
  assert.equal(cellText(cols[0], rows[0].cells[0]).main, '10 > unknown');
  assert.equal(cellText(cols[0], rows[0].cells[0]).detail, 'still warming up');
  // The chain a near miss is judged on is the top-level parts of the `and`.
  assert.deepEqual(rows.map((r) => r.buyChain), [['unknown', 'yes'], ['unknown', 'yes'], ['yes', 'yes'], ['yes', 'yes'], ['yes', 'yes'], ['no', 'no']]);

  // or: true with an unknown part as soon as another part holds.
  const B = bars([10, 12, 12, 13, 14, 3]);
  const or = run('universe: B\nbuy when close > sma(3) or close > 11', { B });
  const rowsOr = rowsOf(or, 'B');
  assert.deepEqual(outcomes(rowsOr, 0), ['unknown', 'unknown', 'yes', 'yes', 'yes', 'no']);
  assert.deepEqual(outcomes(rowsOr, 1), ['no', 'yes', 'yes', 'yes', 'yes', 'no']);
  assert.deepEqual(outcomes(rowsOr, 2), ['unknown', 'yes', 'yes', 'yes', 'yes', 'no']);
});

test('a cross shows the bar before as well, and is unknown while the bar before is', () => {
  // sma(2): 10, 10, 9.5, 10.5, 12.5; sma(3): 10, 9.667, 10.333, 11.333. The first cross above is on day 4.
  const A = bars([10, 10, 10, 9, 12, 13]);
  const bt = run('universe: A\nbuy when sma(2) crosses above sma(3)', { A });
  const cols = debugColumns(bt, 'A');
  assert.deepEqual(cols.map((c) => [c.kind, c.op, c.text]), [['cross', 'crosses above', 'sma(2) crosses above sma(3)']]);
  const rows = rowsOf(bt);
  assert.deepEqual(outcomes(rows, 0), ['unknown', 'unknown', 'unknown', 'no', 'yes', 'no']);
  const c = rows[4].cells[0];
  assert.ok(near(c.a, 10.5) && near(c.b, 10.333333333333334) && near(c.pa, 9.5) && near(c.pb, 9.666666666666666));
  assert.deepEqual(cellText(cols[0], c), { main: '10.50 vs 10.33', detail: 'before 9.50 vs 9.67' });
  assert.equal(rows[0].cells[0].note, 'still warming up');
  assert.equal(rows[2].cells[0].note, 'the bar before is unknown');
  assert.equal(rows[4].what, 'Buy rule held: bought at the next open (2020-01-06) at 12.00.');
  // crosses below
  const down = run('universe: A\nbuy when true\nsell when sma(2) crosses below sma(3)', { A: bars([10, 11, 12, 11, 9, 8]) });
  const dc = debugColumns(down, 'A')[1];
  assert.equal(dc.op, 'crosses below');
});

test('of: another ticker on its own calendar is read at the bar that had ended, and is unknown before it has one', () => {
  const A = bars([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
  // B has a bar every second day, so a bar of B is over two days after it starts.
  const B = bars([15, 25, 30, 18, 40], { step: 2 * DAY });
  const bt = run('universe: A\ncapital: 1000\nbuy when close of B > 20', { A, B });
  const cols = debugColumns(bt, 'A');
  assert.deepEqual(cols.map((c) => c.text), ['close of B > 20']);
  const rows = rowsOf(bt);
  assert.deepEqual(rows.map((r) => r.cells[0].a), [NaN, 15, 15, 25, 25, 30, 30, 18, 18, 40]);
  assert.deepEqual(outcomes(rows, 0), ['unknown', 'no', 'no', 'yes', 'yes', 'yes', 'yes', 'no', 'no', 'yes']);
  assert.equal(rows[0].cells[0].note, 'B had no finished bar yet');
  assert.equal(cellText(cols[0], rows[0].cells[0]).main, 'unknown > 20');
  assert.equal(rows[3].what, 'Buy rule held: bought at the next open (2020-01-05) at 10.00.');
});

test('a parameter: the values shown are the ones the run used, and a percentage parameter reads as a percentage', () => {
  const A = bars([10, 11, 13, 12, 15, 15]);
  const src = 'universe: A\nfast = 3 in 2..5\nlimit = 5% in 1%..10%\nbuy when close > sma(fast) and roc(1) > limit';
  const three = rowsOf(run(src, { A }));
  const two = rowsOf(run(src, { A }, { fast: 2 }));
  // sma(3) at day 3 is (11 + 13 + 12) / 3 = 12; sma(2) is (13 + 12) / 2 = 12.5.
  assert.equal(three[3].cells[0].b, 12);
  assert.equal(two[3].cells[0].b, 12.5);
  const bt = run(src, { A });
  const cols = debugColumns(bt, 'A');
  assert.deepEqual(cols.map((c) => [c.text, c.percent]), [['close > sma(fast)', false], ['roc(1) > limit', true], ['close > sma(fast) and roc(1) > limit', false]]);
  // roc(1) at day 2 is 13 / 11 - 1 = 18.18%; the limit is 5%.
  assert.deepEqual(cellText(cols[1], three[2].cells[1]), { main: '18.18% > 5%', detail: '' });
});

test('a sell rule with bars held and entry price: values while the position is held, a dash while it is not', () => {
  // Bought at day 2's open (12) after the signal at day 1; bars held counts from 0 on the fill bar and reaches 2 at day 4.
  const A = bars([10, 12, 12, 12, 12, 9, 9]);
  const bt = run('universe: A\ncapital: 1000\nbuy when close > 10\nsell when bars held >= 2 or close < entry price * 0.95', { A });
  const cols = debugColumns(bt, 'A');
  assert.deepEqual(cols.slice(1).map((c) => [c.group, c.kind, c.text, c.whole]), [
    ['sell', 'test', 'bars held >= 2', false],
    ['sell', 'test', 'close < entry price * 0.95', false],
    ['sell', 'join', 'bars held >= 2 or close < entry price * 0.95', true],
  ]);
  const rows = rowsOf(bt);
  assert.deepEqual(rows.map((r) => r.readHeld), [false, false, true, true, true, false, false]);
  // Flat: the two comparisons have nothing to compare; the rule as a whole is unknown, as the engine reads it.
  for (const i of [0, 1, 5, 6]) assert.deepEqual([1, 2, 3].map((n) => rows[i].cells[n].outcome), [null, null, 'unknown']);
  assert.equal(rows[0].cells[3].note, 'no position is held');
  assert.deepEqual(rows.slice(2, 5).map((r) => [r.cells[1].a, r.cells[1].b, r.cells[1].outcome]), [[0, 2, 'no'], [1, 2, 'no'], [2, 2, 'yes']]);
  assert.ok(rows.slice(2, 5).every((r) => near(r.cells[2].a, 12) && near(r.cells[2].b, 12 * 0.95) && r.cells[2].outcome === 'no'));
  assert.deepEqual(rows.map((r) => r.sell), ['unknown', 'unknown', 'no', 'no', 'yes', 'unknown', 'unknown']);
  assert.deepEqual(cellText(cols[1], rows[3].cells[1]), { main: '1 ≥ 2', detail: '' });
  assert.deepEqual(cellText(cols[1], rows[0].cells[1]), { main: '–', detail: '' });
  assert.equal(rows[4].what, 'Sell rule held: sold at the next open (2020-01-06) at 12.00.');
  assert.equal(rows[5].what, 'Sold at the open at 12.00.');
});

test('each kind of exit appears at the bar it filled: sell rule, stop loss, trailing stop and take profit', () => {
  const buyAt12 = { opens: [10, 10, 12, 13, 14, 12] };
  // Stop loss 10% of the 12 fill is 10.8; day 3's low 10.5 reaches it while the bar opened at 12.
  const stop = run('universe: A\ncapital: 1000\nstop loss: 10%\nbuy when close > 10', {
    A: bars([10, 12, 12, 11, 11, 11], { opens: [10, 10, 12, 12, 11, 11], highs: [10, 12, 12, 12, 11, 11], lows: [10, 10, 12, 10.5, 11, 11] }),
  });
  const s = rowsOf(stop);
  assert.equal(s[3].what.startsWith('Stopped out at 10.80.'), true);
  assert.deepEqual(s[3].events[0], { k: 'sell', stage: 'filled', trade: stop.run.trades[0] });
  assert.equal(stop.run.trades[0].reason, 'stop loss');
  assert.deepEqual(s.map((r) => r.held), [false, false, true, false, false, false]);

  // Trailing stop 10%: the highest high before the bar is 15 (day 3), so the level on day 4 is 13.5, and the bar opened at 14.
  const trail = run('universe: A\ncapital: 1000\ntrailing stop: 10%\nbuy when close > 10', {
    A: bars([10, 12, 13, 14, 12, 12], { ...buyAt12, highs: [10, 12, 14, 15, 14, 12], lows: [10, 10, 12, 13, 12.2, 12] }),
  });
  const t = rowsOf(trail);
  assert.equal(trail.run.trades[0].reason, 'trailing stop');
  assert.equal(t[4].what.startsWith('Trailing stop hit: sold at 13.50.'), true);
  assert.deepEqual(t.map((r) => r.held), [false, false, true, true, false, false]);

  // Take profit 20% of 12 is 14.40: day 3's high 15 reaches it and the bar opened at 13.
  const take = run('universe: A\ncapital: 1000\ntake profit: 20%\nbuy when close > 10', {
    A: bars([10, 12, 13, 14, 14, 14], { opens: [10, 10, 12, 13, 14, 14], highs: [10, 12, 14, 15, 14, 14], lows: [10, 10, 12, 13, 13.5, 14] }),
  });
  const p = rowsOf(take);
  assert.equal(take.run.trades[0].reason, 'take profit');
  assert.equal(p[3].what.startsWith('Take profit hit: sold at 14.40.'), true);

  // A sell rule: the decision is at one bar, the fill at the next.
  const rule = run('universe: A\ncapital: 1000\nbuy when close > 10\nsell when close > 13', { A: bars([10, 12, 12, 14, 14, 14]) });
  const r = rowsOf(rule);
  assert.equal(r[3].what, 'Sell rule held: sold at the next open (2020-01-05) at 14.00.');
  assert.equal(r[4].what, 'Sold at the open at 14.00. Buy rule held, but the sell rule held too, so no buy.');
  assert.deepEqual(r[3].events.map((e) => [e.k, 'stage' in e ? e.stage : '']), [['sell', 'decided']]);
});

test('after a stop the buy rule has to stop holding: each bar it held is explained, and the first signal after is not', () => {
  // Bought day 2 at 12, stopped day 3 at 10.8 (low 10.5). The rule still holds on days 3 to 5, fails on day 6, and buys again after day 7.
  const A = bars([10, 12, 12, 11, 12, 12, 9, 12, 12, 12], { lows: [10, 12, 12, 10.5, 12, 12, 9, 12, 12, 12] });
  const bt = run('universe: A\ncapital: 1000\nstop loss: 10%\nbuy when close > 10', { A });
  const rows = rowsOf(bt);
  assert.deepEqual(bt.run.trades.map((t) => [t.entryT, t.exitT, t.reason]), [[day(2), day(3), 'stop loss'], [day(8), day(9), 'open']]);
  assert.deepEqual(bt.run.trades[1].why!.rearm, { exitT: day(3), heldT: day(5), clearedT: day(6) });
  assert.equal(rows[3].what, 'Stopped out at 10.80. Buy rule held but waiting for the rule to stop holding after this stop loss.');
  for (const i of [4, 5]) assert.equal(rows[i].what, 'Buy rule held but waiting for the rule to stop holding after the stop loss on 2020-01-04.');
  assert.deepEqual(rows.map((r) => kinds(r).includes('rearm')), [false, false, false, true, true, true, false, false, false, false]);
  assert.equal(rows[6].what, '');
  assert.equal(rows[7].what, 'Buy rule held: bought at the next open (2020-01-09) at 12.00.');
  // Starting the window in the middle of the wait gives the same rows.
  assert.deepEqual(debugRows(bt, 'A', 5, 10), rows.slice(5));
  assert.deepEqual(debugRows(bt, 'A', 4, 7), rows.slice(4, 7));
});

test('a buy that waited for an input still warming up: the bars it waited and the bar it was bought at', () => {
  // ATR(3) is first known on day 2, so the signals on days 0 and 1 are held back and the buy is signalled on day 2.
  const A = bars([10, 11, 12, 13, 12, 14, 15, 16]);
  const bt = run('universe: A\ncapital: 1000\nstop loss: 2 atr(3)\nbuy when close > 5', { A });
  assert.deepEqual(bt.run.skipped, [{ asset: 'A', input: 'stop loss', n: 3, count: 1 }]);
  assert.deepEqual(bt.run.trades[0].why!.warmup, { input: 'stop loss', n: 3, fromT: day(0) });
  const rows = rowsOf(bt);
  const waited = 'Buy rule held, but the buy waited: the 3-bar ATR for the stop loss was still unknown.';
  assert.deepEqual(rows.slice(0, 3).map((r) => r.what), [waited, waited, 'Buy rule held: bought at the next open (2020-01-04) at 12.00.']);
  assert.deepEqual(rows[0].events, [{ k: 'warmup', input: 'stop loss', n: 3 }]);
});

test('a buy that waited names the input the trade says it waited for', () => {
  const A = bars([10, 11, 12, 13, 12, 14, 15, 16]);
  const B = bars([20, 21, 19, 22, 23, 21, 22, 24]);
  const risk = run('universe: A\ncapital: 1000\nrisk per trade: 1% at 2 atr(3)\nbuy when close > 5', { A });
  assert.deepEqual(risk.run.trades[0].why!.warmup, { input: 'risk per trade', n: 3, fromT: day(0) });
  assert.deepEqual(rowsOf(risk).slice(0, 3).map((r) => r.what), [
    'Buy rule held, but the buy waited: the 3-bar ATR for risk per trade was still unknown.',
    'Buy rule held, but the buy waited: the 3-bar ATR for risk per trade was still unknown.',
    'Buy rule held: bought at the next open (2020-01-04) at 12.00.',
  ]);
  // The returns start on day 1, so a volatility over three of them is known from day 3.
  const vol = run('universe: A, B\ncapital: 1000\nweighting: inverse volatility(3)\nbuy when close > 5', { A, B });
  for (const name of ['A', 'B']) {
    const rows = rowsOf(vol, name);
    assert.deepEqual(vol.run.trades.find((t) => t.asset === name)!.why!.warmup, { input: 'inverse volatility', n: 3, fromT: day(0) });
    assert.deepEqual(rows.slice(0, 3).map((r) => r.events), Array(3).fill([{ k: 'warmup', input: 'inverse volatility', n: 3 }]));
    assert.equal(rows[0].what, 'Buy rule held, but the buy waited: the 3-bar volatility for inverse volatility weighting was still unknown.');
    assert.equal(rows[3].what.startsWith('Buy rule held: bought at the next open (2020-01-05)'), true);
  }
});

test('an unknown value says why when that is cheap to tell', () => {
  const A = bars([10, 12, 14, 16, 18, 20, 22]);
  const back = rowsOf(run('universe: A\nbuy when close[3] > 10', { A }));
  assert.deepEqual(back.slice(0, 4).map((r) => r.cells[0].note), Array(3).fill('looks back past the first bar').concat(['']));
  assert.deepEqual(back.map((r) => r.cells[0].outcome), ['unknown', 'unknown', 'unknown', 'no', 'yes', 'yes', 'yes']);
  const zero = rowsOf(run('universe: A\nbuy when 1 / (close - close) > 1', { A }));
  assert.equal(zero[2].cells[0].note, 'divides by 0');
  assert.equal(cellText(debugColumns(run('universe: A\nbuy when 1 / (close - close) > 1', { A }), 'A')[0], zero[2].cells[0]).detail, 'divides by 0');
});

test('a position that rebalancing resized says it was the shares bought that are shown', () => {
  // Half of equity in each; A doubles during January, so the first bar of February trims it.
  const A = bars(Array.from({ length: 50 }, (_, i) => 100 + (i < 31 ? i * 3 : 93)));
  const B = bars(Array.from({ length: 50 }, () => 100));
  const bt = run('universe: A, B\ncapital: 1000\nrebalance: monthly\nbuy when true', { A, B });
  const trade = bt.run.trades.find((t) => t.asset === 'A')!;
  assert.ok(trade.why!.trims >= 1);
  const rows = rowsOf(bt, 'A');
  assert.equal(rows[10].resized, true);
  assert.equal(positionWords(rows[10]), `Long, bought ${(trade.why!.shares).toLocaleString('en-US', { maximumFractionDigits: 4 })} shares`);
  assert.equal(positionWords(rowsOf(bt, 'B')[0]), 'Flat');
});

test('a buy and a sell both signalled at one close: the buy is skipped, and the row says so', () => {
  const A = bars([10, 12, 12, 12]);
  const bt = run('universe: A\ncapital: 1000\nbuy when close > 10\nsell when close > 11', { A });
  assert.equal(bt.run.trades.length, 0);
  const rows = rowsOf(bt);
  assert.deepEqual(rows.map((r) => r.what), ['', ...Array(3).fill('Buy rule held, but the sell rule held too, so no buy.')]);
});

test('an order from the last bar is pending, and a buy rule that held with nothing in the way and no trade means no cash', () => {
  const A = bars([10, 10, 10, 12]);
  const bt = run('universe: A\ncapital: 1000\nbuy when close > 10', { A });
  assert.equal(bt.run.trades.length, 0);
  assert.equal(bt.run.states[0].pending, 'buy');
  assert.equal(rowsOf(bt)[3].what, 'Order pending: buy at the next open.');
  // A sell signalled at the last bar of a position still held.
  const held = run('universe: A\ncapital: 1000\nbuy when close > 10\nsell when close > 13', { A: bars([10, 12, 12, 14]) });
  assert.equal(held.run.trades[0].reason, 'open');
  assert.equal(rowsOf(held)[3].what, 'Order pending: sell at the next open.');
  // The run records no buy at day 1, though the rule held; with no sell rule, no stop and no warm-up, only an empty purse is left.
  const filled = run('universe: A\ncapital: 1000\nbuy when close > 10', { A: bars([10, 12, 12, 12]) });
  const none = { ...filled, run: { ...filled.run, trades: [] } };
  assert.equal(rowsOf(none)[1].what, 'Buy rule held, but no buy was made: no cash was free.');
});

test('a ranked strategy: the score at every bar, the place among the eligible at decision bars, and the ranking in the words', () => {
  // top 1 by close, a decision at every close. Scores A 10, B 9 11 9 12 9 9, C 8 8 13 8 8 20.
  const A = bars([10, 10, 10, 10, 10, 10]);
  const B = bars([9, 11, 9, 12, 9, 9]);
  const C = bars([8, 8, 13, 8, 8, 20]);
  const bt = run('universe: A, B, C\ncapital: 3000\nhold: top 1 by close', { A, B, C });
  const cols = debugColumns(bt, 'A');
  assert.deepEqual(cols.map((c) => [c.id, c.kind, c.text]), [['rank:score', 'score', 'close'], ['rank:place', 'place', cols[1].text]]);
  const place = (asset: string) => rowsOf(bt, asset).map((r) => r.rank!.place);
  assert.deepEqual(place('A'), [0, 1, 1, 1, 0, 1]);
  assert.deepEqual(place('B'), [1, 0, 2, 0, 1, 2]);
  assert.deepEqual(place('C'), [2, 2, 0, 2, 2, 0]);
  assert.deepEqual(rowsOf(bt, 'B').map((r) => r.rank!.score), [9, 11, 9, 12, 9, 9]);
  assert.deepEqual(rowsOf(bt, 'B').map((r) => cellText(debugColumns(bt, 'B')[1], r.cells[1]).main), ['2nd of 3', '1st of 3', '3rd of 3', '1st of 3', '2nd of 3', '3rd of 3']);
  assert.deepEqual(rowsOf(bt, 'B').map((r) => r.what), [
    'Ranked 2nd of 3: only the best 1 is held.',
    'Chosen by the ranking, 1st of 3: bought at the next open (2020-01-03) at 11.00.',
    'Bought at the open at 11.00. The ranking no longer holds it: sold at the next open (2020-01-04) at 9.00.',
    'Sold at the open at 9.00. Chosen by the ranking, 1st of 3: bought at the next open (2020-01-05) at 12.00.',
    'Bought at the open at 12.00. The ranking no longer holds it: sold at the next open (2020-01-06) at 9.00.',
    'Sold at the open at 9.00. Ranked 3rd of 3: only the best 1 is held.',
  ]);
  // The place computed from the rules is the place the trades recorded.
  for (const t of bt.run.trades) {
    const rank = t.why!.rank!;
    assert.equal(rankingAt(bt, rank.decision.t).indexOf(t.asset), rank.place);
  }
  assert.deepEqual(rankingAt(bt, day(2)), ['C', 'A', 'B']);
  // Tied scores go to the ticker listed first.
  const tied = run('universe: A, B, C\ncapital: 3000\nhold: top 1 by close', { A: bars([10, 10, 10]), B: bars([10, 10, 10]), C: bars([9, 9, 9]) });
  assert.deepEqual(rankingAt(tied, day(0)), ['A', 'B', 'C']);
  assert.deepEqual(['A', 'B', 'C'].map((name) => rowsOf(tied, name)[0].rank!.place), [0, 1, 2]);

  // With a buy rule, a ticker that fails it cannot be chosen.
  const gated = run('universe: A, B, C\ncapital: 3000\nhold: top 1 by close\nbuy when close > 9.5', { A, B, C });
  const rowsB = rowsOf(gated, 'B');
  assert.equal(rowsB[0].rank!.place, -1);
  assert.equal(cellText(debugColumns(gated, 'B')[2], rowsB[0].cells[2]).main, 'not eligible');
  assert.deepEqual(rowsOf(gated, 'A')[0].rank, { score: 10, place: 0, eligible: 1, top: 1, decision: true });
});

test('a ranked strategy that decides monthly: the place shows only at the last bar of a month, and a kept position says so', () => {
  const n = 70;
  const up = bars(Array.from({ length: n }, (_, i) => 100 + i));
  const flat = bars(Array.from({ length: n }, () => 100));
  const bt = run('universe: A, B\ncapital: 1000\nrebalance: monthly\nhold: top 1 by roc(5)', { A: up, B: flat });
  const rows = rowsOf(bt, 'A');
  const decisions = rows.filter((r) => r.rank!.decision).map((r) => stamp(r.t, false));
  // Days run from 2020-01-01: the last bars of January and February. The data ends in the middle of March, so March has none.
  assert.deepEqual(decisions, ['2020-01-31', '2020-02-29']);
  assert.ok(rows.filter((r) => !r.rank!.decision).every((r) => Number.isNaN(r.rank!.place)));
  assert.ok(rows.some((r) => r.what.startsWith('Kept by the ranking, 1st of 2.')));
});

test('fill: close: the decision and the fill are one bar, and the sell rule is read before the close fills', () => {
  const A = bars([10, 12, 12, 15, 9, 9, 9]);
  const bt = run('universe: A\ncapital: 1000\nfill: close\nbuy when close > 10\nsell when close < 10', { A });
  const rows = rowsOf(bt);
  assert.equal(rows[1].what, 'Buy rule held: bought at this close at 12.00.');
  // Held after the buy at day 1's close, but the rules were read before it: no position to read yet.
  assert.deepEqual(rows.map((r) => r.held), [false, true, true, true, false, false, false]);
  assert.deepEqual(rows.map((r) => r.readHeld), [false, false, true, true, true, false, false]);
  assert.deepEqual(rows.map((r) => r.sell), ['no', 'no', 'no', 'no', 'yes', 'yes', 'yes']);
  assert.equal(rows[4].what, 'Sell rule held: sold at this close at 9.00.');
  assert.deepEqual(rows[1].events.map((e) => ('stage' in e ? e.stage : e.k)), ['both']);
  assert.deepEqual(tradeStops(bt, 'A').map((s) => [s.index, s.fill]), [[1, 1]]);
  // A stop cannot fill on the bar a position was bought at the close.
  const stopped = run('universe: A\ncapital: 1000\nfill: close\nstop loss: 10%\nbuy when close > 10', {
    A: bars([10, 12, 12, 11, 11], { lows: [10, 9, 12, 10.5, 11] }),
  });
  assert.equal(stopped.run.trades[0].exitT, day(3));
  assert.equal(rowsOf(stopped)[3].what.startsWith('Stopped out at 10.80.'), true);
});

test('intraday bars: times, not dates, in the words and in the file', () => {
  const A = bars([10, 12, 12, 15, 9, 9, 9], { opens: [10, 10, 12, 12, 15, 9, 9], step: 3_600_000 });
  const bt = run('universe: A\ndata: binance\ncapital: 1000\ninterval: 1h\nbuy when close > 10\nsell when close < 10', { A });
  const rows = rowsOf(bt);
  assert.equal(rows[1].what, 'Buy rule held: bought at the next open (2020-01-01 02:00) at 12.00.');
  assert.equal(rows[4].what, 'Sell rule held: sold at the next open (2020-01-01 05:00) at 9.00.');
  const csv = debugCsv(bt, 'A').split('\n');
  assert.equal(csv[0].split(',')[0], 'time (UTC)');
  assert.equal(csv[2].split(',')[0], '2020-01-01 01:00');
});

test('the date to jump to: the first bar on or after it', () => {
  const A = bars([10, 11, 12, 13, 14], { times: [day(0), day(1), day(4), day(5), day(6)] });
  const bt = run('universe: A\nbuy when close > 100', { A });
  assert.equal(barOnOrAfter(bt, 'A', day(1)), 1);
  assert.equal(barOnOrAfter(bt, 'A', day(2)), 2);
  assert.equal(barOnOrAfter(bt, 'A', day(-5)), 0);
  assert.equal(barOnOrAfter(bt, 'A', day(100)), 4);
});

test('the near miss: every part of an and chain held but one, and that one is false', () => {
  const row = (buy: DebugRow['buy'], chain: DebugRow['buyChain'], over: Partial<DebugRow> = {}): DebugRow => ({
    index: 0, bar: 0, t: 0, close: 1, cells: [], buy, buyChain: chain, sell: null, held: false, readHeld: false, shares: NaN, resized: false, entries: 0, entriesAllowed: 1, rank: null, events: [], what: '', ...over,
  });
  assert.equal(nearMiss(row('no', ['yes', 'yes', 'no'])), true);
  assert.equal(nearMiss(row('no', ['no', 'yes'])), true);
  assert.equal(nearMiss(row('no', ['yes', 'no', 'no'])), false);
  assert.equal(nearMiss(row('no', ['no', 'no'])), false);
  // An unknown part may fail once it is known: not a near miss.
  assert.equal(nearMiss(row('unknown', ['yes', 'unknown'])), false);
  assert.equal(nearMiss(row('no', ['yes', 'unknown', 'no'])), false);
  // A rule that holds, or a rule of one part, has nothing to miss by.
  assert.equal(nearMiss(row('yes', ['yes', 'yes'])), false);
  assert.equal(nearMiss(row('no', ['no'])), false);
  assert.equal(nearMiss(row('no', [])), false);

  assert.equal(interesting(row('no', ['no', 'no'])), false);
  assert.equal(interesting(row('unknown', ['unknown'])), false);
  assert.equal(interesting(row('no', ['yes', 'no'])), true);
  assert.equal(interesting(row('yes', ['yes'])), true);
  assert.equal(interesting(row('no', ['no'], { held: true })), true);
  assert.equal(interesting(row('no', ['no'], { events: [{ k: 'pending', side: 'sell' }] })), true);

  // On a real run: three parts, and the bars that miss by one part are the ones that pass the filter.
  const A = bars([10, 12, 12, 9, 12, 12]);
  const bt = run('universe: A\nbuy when close > 10 and close < 13 and close != 12', { A });
  const rows = rowsOf(bt);
  assert.deepEqual(rows.map((r) => r.buyChain), [['no', 'yes', 'yes'], ['yes', 'yes', 'no'], ['yes', 'yes', 'no'], ['no', 'yes', 'yes'], ['yes', 'yes', 'no'], ['yes', 'yes', 'no']]);
  assert.deepEqual(rows.map(nearMiss), [true, true, true, true, true, true]);
  // Two parts fail on the bars at 12, so only the bars at 10 and 9 miss by one.
  const two = run('universe: A\nbuy when close > 10 and close < 11 and close != 12', { A });
  assert.deepEqual(rowsOf(two).map(nearMiss), [true, false, false, true, false, false]);
});

test('the trade list: the bar each decision was read at and the bar it filled at', () => {
  const A = bars([10, 12, 12, 15, 9, 9, 9, 13, 13, 13]);
  const bt = run('universe: A\ncapital: 1000\nbuy when close > 10\nsell when close < 10', { A });
  assert.deepEqual(tradeStops(bt, 'A').map((s) => [s.index, s.fill, s.trade.reason]), [[1, 2, 'signal'], [7, 8, 'open']]);
  // The row of a trade's decision shows the buy rule as holding and names the fill.
  const rows = rowsOf(bt);
  for (const s of tradeStops(bt, 'A')) {
    assert.equal(rows[s.index].buy, 'yes');
    assert.ok(rows[s.index].what.includes(`(${stamp(s.trade.entryT, false)}) at ${price(s.trade.entryPrice)}`));
  }
});

test('a window gives the rows the whole run gives, wherever it starts, and is clamped to the run', () => {
  const A = bars([10, 12, 12, 11, 12, 12, 9, 12, 12, 12, 8, 12], { lows: [10, 12, 12, 10.5, 12, 12, 9, 12, 12, 12, 8, 12] });
  const bt = run('universe: A\ncapital: 1000\nstop loss: 10%\nbuy when close > 10', { A });
  const all = rowsOf(bt);
  for (let from = 0; from < all.length; from++) {
    for (const to of [from + 1, from + 3, all.length]) assert.deepEqual(debugRows(bt, 'A', from, to), all.slice(from, to));
  }
  assert.deepEqual(debugRows(bt, 'A', -5, 2), all.slice(0, 2));
  assert.deepEqual(debugRows(bt, 'A', 10, 99), all.slice(10));
  assert.deepEqual(debugRows(bt, 'A', 5, 5), []);
  assert.deepEqual(debugRows(bt, 'A', 20, 30), []);
});

test('a run of 100,000 bars builds the rows of one window without going through the rest', () => {
  const rng = makeRng(9);
  let p = 100;
  const closes = Array.from({ length: 100_000 }, () => (p *= 1 + (rng.next() - 0.5) * 0.01));
  const bt = run('universe: A\nbuy when close > sma(50) and rsi(14) < 70\nsell when close < sma(50)', { A: bars(closes) });
  const started = performance.now();
  const rows = debugRows(bt, 'A', 99_940, 100_000);
  assert.equal(rows.length, 60);
  assert.equal(rows[0].index, 99_940);
  assert.ok(performance.now() - started < 1000);
});

// ------------------------------------------------------------------------ the file

/** Records of a CSV text, with quoted fields. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n') {
      record.push(field);
      out.push(record);
      record = [];
      field = '';
    } else field += c;
  }
  assert.deepEqual([field, record], ['', []], 'the file ends with a line break');
  return out;
}

test('the file: every bar of the run, the user\'s own text in the headings, plain numbers, yes, no and unknown, and quoted fields', () => {
  // Prices over a thousand have a thousands separator in the words, so the last field has a comma in it.
  const A = bars([1000, 1200, 1200, 1500, 900, 900], { opens: [1000, 1000, 1200, 1200, 1500, 900] });
  const bt = run('universe: A\ncapital: 10000\nbuy when max(close, open) > 1100 and close > sma(3)\nsell when close < 1000', { A });
  const csv = debugCsv(bt, 'A');
  const records = parseCsv(csv);
  assert.equal(records.length, 1 + 6);
  assert.ok(records.every((r) => r.length === records[0].length));
  assert.deepEqual(records[0], [
    'date',
    'close',
    'buy: max(close, open) > 1100 (left)',
    'buy: max(close, open) > 1100 (right)',
    'buy: max(close, open) > 1100 (result)',
    'buy: close > sma(3) (left)',
    'buy: close > sma(3) (right)',
    'buy: close > sma(3) (result)',
    'buy rule',
    'sell: close < 1000 (left)',
    'sell: close < 1000 (right)',
    'sell: close < 1000 (result)',
    'position',
    'shares',
    'what happened',
  ]);
  const rows = rowsOf(bt);
  assert.deepEqual(records[1].slice(0, 9), ['2020-01-01', '1000', '1000', '1100', 'no', '1000', '', 'unknown', 'no']);
  // Day 2: sma(3) is (1000 + 1200 + 1200) / 3 = 1133.33; the buy rule holds there.
  assert.deepEqual(records[3].slice(0, 9), ['2020-01-03', '1200', '1200', '1100', 'yes', '1200', '1133.33333333', 'yes', 'yes']);
  assert.equal(records[3][14], rows[2].what);
  assert.equal(records[3][14], 'Buy rule held: bought at the next open (2020-01-04) at 1,200.00.');
  assert.deepEqual(records[4].slice(12, 14), ['long', String(Number(rows[3].shares.toPrecision(12)))]);
  assert.deepEqual(records[2].slice(12, 14), ['flat', '']);
  // Held positions read the sell rule; flat ones show its values too, as the table does.
  assert.deepEqual(records.slice(1).map((r) => r[11]), rows.map((r) => r.cells[3].outcome));
});

test('the file with a cross, a ranking and a position value: the fields each makes', () => {
  const A = bars([10, 10, 10, 9, 12, 13, 13, 8]);
  const bt = run('universe: A\ncapital: 1000\nbuy when sma(2) crosses above sma(3)\nsell when bars held >= 1', { A });
  const records = parseCsv(debugCsv(bt, 'A'));
  assert.deepEqual(records[0].slice(2, 8), [
    'buy: sma(2) crosses above sma(3) (left)',
    'buy: sma(2) crosses above sma(3) (right)',
    'buy: sma(2) crosses above sma(3) (left before)',
    'buy: sma(2) crosses above sma(3) (right before)',
    'buy: sma(2) crosses above sma(3) (result)',
    'sell: bars held >= 1 (left)',
  ]);
  assert.deepEqual(records[5].slice(2, 7), ['10.5', '10.3333333333', '9.5', '9.66666666667', 'yes']);
  // Not read while flat: the fields are empty.
  assert.deepEqual(records[1].slice(7, 10), ['', '', '']);

  const rank = run('universe: A, B\ncapital: 1000\nhold: top 1 by close', { A: bars([10, 10, 12, 8]), B: bars([9, 11, 9, 9]) });
  const rr = parseCsv(debugCsv(rank, 'B'));
  assert.deepEqual(rr[0].slice(2), ['rank score: close', 'rank place', 'rank eligible', 'position', 'shares', 'what happened']);
  assert.deepEqual(rr.slice(1).map((r) => r.slice(2, 5)), [['9', '2', '2'], ['11', '1', '2'], ['9', '2', '2'], ['9', '1', '2']]);
});

// ------------------------------------------------------------------------ the table agrees with the trade list

/** `n` bars of a seeded random walk, with highs and lows around open and close; `gap` leaves out every `gap`th day. */
function walk(seed: number, n: number, opts: { gap?: number; vol?: number; drift?: number; hourly?: boolean } = {}): Bars {
  const rng = makeRng(seed);
  const { gap = 0, vol = 0.02, drift = 0.0004, hourly = false } = opts;
  const b: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let p = 100;
  for (let i = 0; i < n; i++) {
    if (gap && i % gap === gap - 1) continue;
    const c = p * (1 + drift + (rng.next() - 0.5) * 2 * vol);
    b.t.push(hourly ? T0 + i * 3_600_000 : T0 + i * DAY);
    b.o.push(p);
    b.h.push(Math.max(p, c) * (1 + rng.next() * 0.01));
    b.l.push(Math.min(p, c) * (1 - rng.next() * 0.01));
    b.c.push(c);
    b.v.push(1000);
    p = c;
  }
  return b;
}

interface Case {
  name: string;
  src: string;
  tickers: string[];
  gap?: Record<string, number>;
  hourly?: boolean;
}

const CASES: Case[] = [
  { name: 'trend with a trailing stop', src: 'universe: A\ncapital: 10000\ntrailing stop: 3%\nbuy when close > sma(20)\nsell when close < sma(20)', tickers: ['A'] },
  {
    name: 'two tickers with stops, costs and bars held',
    src: 'universe: A, B\ncapital: 10000\ncosts: 10 bps\nslippage: 5 bps\nstop loss: 6%\ntrailing stop: 9%\ntake profit: 5%\nbuy when rsi(14) < 55 and close > sma(30) and close of B > sma(20) of B\nsell when rsi(14) > 65 or bars held >= 15',
    tickers: ['A', 'B'],
    gap: { B: 7 },
  },
  { name: 'ATR stop and risk sizing', src: 'universe: A\ncapital: 10000\nstop loss: 2 atr(14)\nrisk per trade: 1% at 2 atr(14)\nbuy when close > sma(5)\nsell when close < sma(5)', tickers: ['A'] },
  { name: 'tight stop that keeps being hit', src: 'universe: A\ncapital: 10000\nstop loss: 1%\nbuy when close > sma(20)', tickers: ['A'] },
  { name: 'a sell rule that holds while the buy rule does', src: 'universe: A, B\ncapital: 10000\nbuy when close > sma(10)\nsell when close > sma(10) * 1.01 or bars held >= 8', tickers: ['A', 'B'] },
  { name: 'rotation each month', src: 'universe: A, B, C, D\ncapital: 10000\nrebalance: monthly\nhold: top 2 by roc(20)\nbuy when close > sma(30)\nsell when close < sma(30)', tickers: ['A', 'B', 'C', 'D'] },
  { name: 'rotation at every close with a sell rule and a stop', src: 'universe: A, B, C\ncapital: 10000\nstop loss: 6%\nhold: top 1 by roc(10)\nbuy when close > sma(20)\nsell when rsi(14) > 75', tickers: ['A', 'B', 'C'] },
  { name: 'rotation waiting for an ATR', src: 'universe: A, B, C\ncapital: 10000\nstop loss: 2 atr(14)\nhold: top 1 by roc(3)', tickers: ['A', 'B', 'C'] },
  { name: 'weighted, inverse volatility, rebalanced weekly', src: 'universe: A, B\ncapital: 10000\nrebalance: weekly\nweighting: inverse volatility(20)\nbuy when close > sma(10)\nsell when close < sma(10)', tickers: ['A', 'B'] },
  { name: 'fill at the close', src: 'universe: A\ncapital: 10000\nfill: close\nstop loss: 4%\nbuy when close > sma(15)\nsell when close < sma(15) or bars held >= 12', tickers: ['A'] },
  { name: 'fill at the close, ranked', src: 'universe: A, B, C\ncapital: 10000\nfill: close\nrebalance: weekly\nhold: top 1 by roc(10)\nbuy when close > sma(20)', tickers: ['A', 'B', 'C'] },
  { name: 'fill at the close with an ATR distance', src: 'universe: A, B\ncapital: 10000\nfill: close\ntrailing stop: 3 atr(10)\nbuy when close > sma(4)\nsell when close < sma(4)', tickers: ['A', 'B'], gap: { B: 6 } },
  { name: 'three entries with a stop, costs and a commission', src: 'universe: A\ncapital: 10000\ncosts: 5 bps\ncommission: 1\nentries: 3\nstop loss: 6%\nbuy when close > sma(20)\nadd when close > last entry price * 1.02\nsell when close < sma(20) * 0.98', tickers: ['A'] },
  {
    name: 'four entries on two calendars with a trailing stop, slippage and a commission per share',
    src: 'universe: A, B\ncapital: 10000\nslippage: 5 bps\ncommission: 0.01 per share, min 1\nentries: 4\ntrailing stop: 8%\nbuy when close > sma(10)\nadd when close > entry price * 1.03 and bars held >= 2\nsell when close < sma(10) * 0.97',
    tickers: ['A', 'B'],
    gap: { B: 7 },
  },
  { name: 'entries with an ATR stop and risk sizing', src: 'universe: A\ncapital: 10000\nentries: 3\nstop loss: 2 atr(14)\nrisk per trade: 1% at 2 atr(14)\nbuy when close > sma(5)\nadd when close > last entry price * 1.01 and entries made < 3\nsell when close < sma(5)', tickers: ['A'] },
  { name: 'entries and weekly rebalancing', src: 'universe: A 60%, B 40%\ncapital: 10000\nrebalance: weekly\nentries: 3\nbuy when close > sma(10)\nadd when close > last entry price * 1.02\nsell when close < sma(10) * 0.98', tickers: ['A', 'B'] },
  { name: 'entries at the close', src: 'universe: A\ncapital: 10000\nfill: close\nentries: 3\nstop loss: 5%\nbuy when close > sma(10)\nadd when close > last entry price * 1.02\nsell when close < sma(10) * 0.98', tickers: ['A'] },
  { name: 'entries with a ranking', src: 'universe: A, B, C\ncapital: 10000\nrebalance: monthly\nentries: 2\nhold: top 2 by roc(20)\nbuy when close > sma(30)\nadd when close > last entry price * 1.02\nsell when close < sma(30)', tickers: ['A', 'B', 'C'] },
  { name: 'hourly bars', src: 'universe: A\ndata: binance\ncapital: 10000\ninterval: 1h\nstop loss: 3%\nbuy when close > sma(12)\nsell when close < sma(12)', tickers: ['A'], hourly: true },
];

/** Whether the trades say a position was held at the end of bar `t`: an oracle that shares nothing with debug.ts but the trade list. */
function heldAt(trades: Trade[], t: number, last: number): boolean {
  return trades.some((tr) => tr.entryT <= t && (tr.reason === 'open' ? t <= last : t < tr.exitT));
}

/** The entries a trade had made by the end of the bar at time `t`. */
const entriesAt = (tr: Trade, t: number) => tr.entries!.filter((e) => e.t <= t).length;

function build(c: Case): Backtest {
  const data: Record<string, Bars> = {};
  c.tickers.forEach((name, k) => (data[name] = walk(11 + k * 7, 420, { gap: c.gap?.[name], hourly: c.hourly, drift: k % 2 ? 0.0002 : 0.0006 })));
  return run(c.src, data);
}

test('the strategies above between them make every kind of bar the table explains', () => {
  const seen = new Map<string, number>();
  const reasons = new Set<string>();
  for (const c of CASES) {
    const bt = build(c);
    for (const t of bt.run.trades) reasons.add(t.reason);
    for (const asset of c.tickers) for (const r of rowsOf(bt, asset)) for (const e of r.events) seen.set(e.k, (seen.get(e.k) ?? 0) + 1);
  }
  for (const kind of ['buy', 'sell', 'long', 'rearm', 'warmup', 'sell-first', 'pending', 'kept', 'ranked-out', 'add', 'whole']) assert.ok(seen.get(kind), `no bar of kind ${kind}: ${JSON.stringify([...seen])}`);
  assert.deepEqual([...reasons].sort(), ['open', 'signal', 'stop loss', 'take profit', 'trailing stop']);
  assert.equal(seen.get('no-cash'), undefined);
});

for (const c of CASES) {
  test(`the table agrees with the trade list: ${c.name}`, () => {
    const bt = build(c);
    assert.ok(bt.run.trades.length >= 3, `${c.name} made ${bt.run.trades.length} trades; the check needs some`);
    const ranked = bt.spec.rank !== null;
    const atClose = bt.spec.fill === 'close';
    const intraday = c.hourly === true;
    const last = bt.run.t[bt.run.t.length - 1];
    let warmups = 0;
    let skippedRuns = 0;
    let addsMade = 0;

    for (const asset of c.tickers) {
      const trades = bt.run.trades.filter((t) => t.asset === asset);
      const rows = rowsOf(bt, asset);
      const at = (t: number) => rows.find((r) => r.t === t)!;

      for (const r of rows) {
        assert.equal(r.held, heldAt(trades, r.t, last), `${asset} ${stamp(r.t, intraday)}: held`);
        // Whatever the rule says, a bar that did not buy is explained by something other than an empty purse.
        assert.ok(!kinds(r).includes('no-cash'), `${asset} ${stamp(r.t, intraday)}: ${r.what}`);
      }

      // Every buy and sell the table names is a trade of the run, at the bar and the price the trade has.
      let buys = 0;
      let sells = 0;
      for (const r of rows) {
        for (const e of r.events) {
          if (e.k === 'buy') {
            assert.ok(bt.run.trades.includes(e.trade), `${asset} ${stamp(r.t, intraday)}: a buy with no trade`);
            if (e.stage !== 'filled') assert.equal(e.trade.why!.buyT, r.t);
            if (e.stage !== 'decided') {
              assert.equal(e.trade.entryT, r.t);
              buys++;
            }
          }
          if (e.k === 'sell') {
            assert.ok(bt.run.trades.includes(e.trade) && e.trade.reason !== 'open', `${asset} ${stamp(r.t, intraday)}: a sell with no closed trade`);
            if (e.stage !== 'decided') {
              assert.equal(e.trade.exitT, r.t);
              sells++;
            }
          }
        }
      }
      assert.equal(buys, trades.length, `${asset}: buys`);
      assert.equal(sells, trades.filter((t) => t.reason !== 'open').length, `${asset}: sells`);

      for (const s of tradeStops(bt, asset)) {
        const tr = s.trade;
        const decision = rows[s.index];
        const fill = rows[s.fill];
        assert.equal(decision.t, tr.why!.buyT);
        assert.equal(decision.buy, 'yes', `${asset} ${stamp(decision.t, intraday)}: the buy rule at a decision`);
        const named = decision.events.find((e) => e.k === 'buy' && e.trade === tr);
        assert.ok(named, `${asset} ${stamp(decision.t, intraday)}: the decision row names its trade`);
        assert.equal(fill.t, tr.entryT);
        assert.ok(decision.what.includes(`at ${price(tr.entries?.[0].price ?? tr.entryPrice)}`), decision.what);
        assert.ok(decision.what.includes(atClose && tr.entryT === decision.t ? 'at this close' : stamp(tr.entryT, intraday)), decision.what);
        assert.ok(fill.events.some((e) => e.k === 'buy' && e.trade === tr && e.stage !== 'decided'));
        if (tr.reason !== 'open') {
          const out = at(tr.exitT);
          assert.ok(out.events.some((e) => e.k === 'sell' && e.trade === tr && e.stage !== 'decided'));
          assert.ok(out.what.includes(price(tr.exitPrice)), out.what);
          if (tr.why!.exit && tr.why!.exit.k !== 'level') {
            const said = at(tr.why!.exit.t);
            assert.ok(said.events.some((e) => e.k === 'sell' && e.trade === tr && e.stage !== 'filled'), `${asset}: the row of the sell decision`);
          }
        }
        // What the trade recorded about its ranking is what the row shows.
        if (tr.why!.rank && !Number.isNaN(tr.why!.rank.t)) {
          const place = at(tr.why!.rank.t).rank!;
          assert.equal(place.place, tr.why!.rank.place);
          assert.equal(place.eligible, tr.why!.rank.decision.eligible);
          assert.equal(rankingAt(bt, tr.why!.rank.decision.t).indexOf(asset), tr.why!.rank.place, `${asset}: the ranking worked out from the rules`);
        }
        // The bars a buy waited for an input are the bars that say so, up to the bar it was signalled at.
        const warm = tr.why!.warmup;
        if (warm && !ranked) {
          const from = rows.findIndex((r) => r.t === warm.fromT);
          assert.ok(from >= 0 && from < s.index);
          for (let i = from; i < s.index; i++) assert.ok(kinds(rows[i]).includes('warmup'), `${asset} ${stamp(rows[i].t, intraday)}: waiting for ${warm.input}`);
        }
        // After a stop, each bar the rule held until it was cleared says it is waiting.
        const rearm = tr.why!.rearm;
        if (rearm && !ranked) {
          const from = rows.findIndex((r) => r.t === rearm.exitT);
          const cleared = rows.findIndex((r) => r.t === rearm.clearedT);
          assert.notEqual(rows[cleared].buy, 'yes');
          for (let i = from; i < cleared; i++) {
            assert.equal(rows[i].buy, 'yes');
            assert.ok(kinds(rows[i]).some((k) => k === 'rearm' || k === 'sell-first'), `${asset} ${stamp(rows[i].t, intraday)}: waiting to be re-armed`);
          }
        }
      }

      // Every entry of every trade is on its bar with its price, and every add the table names is one of them.
      let adds = 0;
      for (const tr of trades) {
        const n = bt.spec.entries ?? 1;
        assert.equal(tr.entries !== undefined, n > 1, `${asset}: entries are recorded when they are allowed`);
        tr.entries?.forEach((e, k) => {
          const fill = at(e.t);
          assert.equal(fill.entries, entriesAt(tr, e.t), `${asset} ${stamp(e.t, intraday)}: entries made at the end of the bar`);
          assert.ok(positionWords(fill).includes(`${fill.entries} of ${n} entries`), positionWords(fill));
          if (k === 0) return;
          const named = fill.events.find((x) => x.k === 'add' && x.trade === tr && x.entry === k + 1 && x.stage !== 'decided');
          assert.ok(named, `${asset} ${stamp(e.t, intraday)}: the fill row names entry ${k + 1}`);
          assert.ok(fill.what.includes(`entry ${k + 1} of ${n}`) && fill.what.includes(price(e.price)), fill.what);
          const moved = tr.why!.adds![k - 1];
          assert.ok(fill.what.includes(`Average entry price now ${price(moved.average)}`), fill.what);
          if (moved.stopLoss !== null) assert.ok(fill.what.includes(`stop loss moved to ${price(moved.stopLoss)}`), fill.what);
          const decision = at(e.signalT);
          assert.ok(decision.events.some((x) => x.k === 'add' && x.trade === tr && x.entry === k + 1 && x.stage !== 'filled'), `${asset} ${stamp(e.signalT, intraday)}: the decision row names entry ${k + 1}`);
          assert.equal(decision.cells.some((c, n) => c.outcome === 'yes' && bt.spec.rules[asset].add && debugColumns(bt, asset)[n].group === 'add' && debugColumns(bt, asset)[n].whole), true, `${asset}: the add rule shows as held at its decision`);
          adds++;
        });
      }
      let named = 0;
      for (const r of rows) for (const e of r.events) if (e.k === 'add') {
        assert.ok(e.trade.entries![e.entry - 1], `${asset} ${stamp(r.t, intraday)}: an add with no entry`);
        if (e.stage !== 'decided') {
          assert.equal(e.trade.entries![e.entry - 1].t, r.t);
          named++;
        }
      }
      assert.equal(named, adds, `${asset}: adds named on their fill bars`);
      addsMade += adds;

      // Runs of bars that waited for an input are the runs the engine counted.
      if (!ranked) {
        let inRun = false;
        for (const r of rows) {
          const waiting = kinds(r).includes('warmup');
          if (waiting && !inRun) skippedRuns++;
          inRun = waiting;
          if (waiting) warmups++;
        }
      }

      // The CSV has one record for each bar and the same number of fields on each.
      const records = parseCsv(debugCsv(bt, asset));
      assert.equal(records.length, rows.length + 1);
      assert.ok(records.every((rec) => rec.length === records[0].length));
      assert.deepEqual(records.slice(1).map((rec) => rec[rec.length - 1]), rows.map((r) => r.what));

      // Windows agree with the whole run.
      for (const [from, to] of [[0, 1], [37, 100], [100, 101], [rows.length - 60, rows.length], [150, 400]]) assert.deepEqual(debugRows(bt, asset, from, to), rows.slice(from, to));
    }
    if (bt.spec.entries) assert.ok(addsMade >= 5, `${c.name}: only ${addsMade} adds to check`);
    if (!ranked) assert.equal(skippedRuns, bt.run.skipped.reduce((n, s) => n + s.count, 0), 'runs of waiting bars against the engine\'s own count');
    assert.ok(warmups >= 0);
  });
}
