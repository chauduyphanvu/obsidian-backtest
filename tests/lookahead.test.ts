// fill: close must never trade at a close on the strength of another series' bar that may close after it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { explainTrade } from '../src/explain.ts';
import * as ind from '../src/indicators.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY } from './helpers.ts';

const HOUR = 3_600_000;
const jan = (d: number, hour = 0) => Date.UTC(2020, 0, d, hour);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Daily times from `from` to `to`, weekdays only or every day. */
function days(from: number, to: number, weekdays: boolean): number[] {
  const out: number[] = [];
  for (let t = from; t <= to; t += DAY) if (!weekdays || ![0, 6].includes(new Date(t).getUTCDay())) out.push(t);
  return out;
}
const series = (times: number[], close: (t: number) => number): Bars => bars(times.map(close), { times });

function run(source: string, data: Record<string, Bars>): Backtest {
  const { spec, errors } = parseSpec(source);
  assert.deepEqual(errors, []);
  return runBacktest(spec!, new Map(Object.entries(data)));
}
const trades = (bt: Backtest) => bt.run.trades.map((t) => [t.asset, iso(t.entryT), t.reason === 'open' ? 'open' : iso(t.exitT)]);
const boughtRows = (bt: Backtest, k: number) => explainTrade(bt, bt.run.trades[k]).sections.find((s) => s.id === 'bought')!.rows;

// Wednesday 1 January to Friday 31 January 2020. STK trades on weekdays, CRY every day.
const STK_T = days(jan(1), jan(31), true);
const CRY_T = days(jan(1), jan(31), false);

test('endedBy: the latest bar that had ended by each moment', () => {
  const daily = [1, 2, 3].map((d) => jan(d));
  // A bar ends at its start plus a day: at the start of 2 January only the bar of the 1st has ended.
  assert.deepEqual(ind.endedBy(daily, [jan(1), jan(2), jan(2, 12), jan(3), jan(4)]), [-1, 0, 0, 1, 2]);
});

test('clockOf: the source, the bar length and the days of the week with bars', () => {
  const stock = ind.clockOf('yahoo', STK_T);
  assert.equal(stock, ind.clockOf('yahoo', days(jan(6), jan(31), true)));
  assert.notEqual(stock, ind.clockOf('binance', STK_T));
  assert.notEqual(stock, ind.clockOf('yahoo', CRY_T));
  assert.notEqual(ind.clockOf('binance', CRY_T), ind.clockOf('binance', Array.from({ length: 48 }, (_, i) => jan(1) + i * HOUR)));
  // A lone weekend bar among hundreds of weekdays does not make a weekend calendar.
  const odd = [...days(jan(1), Date.UTC(2020, 11, 31), true), Date.UTC(2021, 0, 2)];
  assert.equal(ind.clockOf('yahoo', odd), ind.clockOf('yahoo', days(jan(1), Date.UTC(2020, 11, 31), true)));
});

test('fill: close, a stock reading crypto reads the crypto bar of the day before, and the explanation names it', () => {
  // CRY jumps on Wednesday 15 January. Its daily close comes at midnight UTC, after the stock's close that day.
  const data = { STK: series(STK_T, () => 50), CRY: series(CRY_T, (t) => (t >= jan(15) ? 200 : 100)) };
  for (const ref of ['CRY', 'binance:CRY']) {
    const close = run(`universe: STK\nfill: close\nbuy when close of ${ref} > 150`, data);
    assert.deepEqual(trades(close), [['STK', '2020-01-16', 'open']], ref);
    assert.equal(close.run.trades[0].why!.buyT, jan(16));
    const rule = boughtRows(close, 0).find((r) => r.code)!;
    assert.match(rule.value, /read from the CRY bar of 2020-01-15/);
  }
  // Next open is unchanged: the signal at the close of the 15th, read from CRY's bar of the 15th, fills at the next open.
  const open = run('universe: STK\nbuy when close of binance:CRY > 150', data);
  assert.deepEqual(trades(open), [['STK', '2020-01-16', 'open']]);
  assert.equal(open.run.trades[0].why!.buyT, jan(15));
  assert.match(boughtRows(open, 0).find((r) => r.code)!.value, /read from the CRY bar of 2020-01-15/);
});

test('fill: close, crypto reading a stock reads the stock bar that ended before its own bar began', () => {
  // STK jumps on Friday 17 January. CRY's Friday bar no longer reads it; its Saturday bar does, as before.
  const data = { STK: series(STK_T, (t) => (t >= jan(17) ? 200 : 100)), CRY: series(CRY_T, () => 50) };
  const close = run('universe: binance:CRY\nfill: close\nbuy when close of STK > 150', data);
  assert.deepEqual(trades(close), [['CRY', '2020-01-18', 'open']]);
  assert.match(boughtRows(close, 0).find((r) => r.code)!.value, /read from the STK bar of 2020-01-17/);
  // A jump on Wednesday 15 January is read on Thursday the 16th.
  const midweek = { STK: series(STK_T, (t) => (t >= jan(15) ? 200 : 100)), CRY: series(CRY_T, () => 50) };
  assert.deepEqual(trades(run('universe: binance:CRY\nfill: close\nbuy when close of STK > 150', midweek)), [['CRY', '2020-01-16', 'open']]);
});

test('fill: close, a ranking across stock and crypto reads every ticker\'s previous bar when both trade, and the current one when only one does', () => {
  // CRY leads from Wednesday 15 January and falls back on Saturday the 25th; STK stays at 100.
  const data = { STK: series(STK_T, () => 100), CRY: series(CRY_T, (t) => (t >= jan(15) && t < jan(25) ? 150 : 50)) };
  const bt = run('universe: STK, binance:CRY\ncapital: 1000\nfill: close\nhold: top 1 by close', data);
  // 1 January: both trade and no bar has ended yet, so nothing is chosen. 2 January reads the 1st: STK.
  // 16 January reads the 15th: CRY, the switch at that close. Saturday 25 January only CRY trades: its own
  // bar of the 25th against STK's Friday, so CRY is sold that close and STK bought at its next, Monday the 27th.
  assert.deepEqual(trades(bt), [
    ['STK', '2020-01-02', '2020-01-16'],
    ['CRY', '2020-01-16', '2020-01-25'],
    ['STK', '2020-01-27', 'open'],
  ]);
  const cry = bt.run.trades[1].why!;
  assert.equal(cry.rank!.decision.t, jan(16));
  assert.equal(cry.buyT, jan(15));
  assert.deepEqual(cry.rank!.decision.table!.map((x) => [x.asset, iso(x.t), x.score]), [
    ['CRY', '2020-01-15', 150],
    ['STK', '2020-01-15', 100],
  ]);
  const sold = bt.run.trades[1].why!.exit!;
  assert.equal(sold.k, 'rank');
  assert.equal(sold.k === 'rank' && iso(sold.t), '2020-01-25');
  assert.equal(bt.run.trades[2].why!.rank!.decision.t, jan(27));
  assert.equal(bt.run.trades[2].why!.buyT, jan(24));
  assert.match(boughtRows(bt, 1)[0].label, /ranking at the close of 2020-01-16 selected it\. For this ticker, the ranking read the bar of 2020-01-15\./);
  // Next open reads every ticker's bar of the decision day, as before.
  const open = run('universe: STK, binance:CRY\ncapital: 1000\nhold: top 1 by close', data);
  assert.deepEqual(trades(open), [
    ['STK', '2020-01-02', '2020-01-16'],
    ['CRY', '2020-01-16', '2020-01-26'],
    ['STK', '2020-01-27', 'open'],
  ]);
});

test('fill: close, a ticker kept by a ranking that read the bar before is still sold by its own sell rule at its close', () => {
  // STK leads throughout; its sell rule holds at its close of Thursday 16 January only.
  const data = { STK: series(STK_T, (t) => (t === jan(16) ? 90 : 100)), CRY: series(CRY_T, () => 50) };
  const bt = run('universe: STK, binance:CRY\ncapital: 1000\nfill: close\nhold: top 1 by close\nfor STK:\n  sell when close < 95', data);
  // The decision of the 16th reads the 15th and keeps STK, but its sell rule at the close of the 16th sells it;
  // the 17th reads the 16th, where the sell rule held, so STK cannot be chosen, and CRY is.
  assert.deepEqual(trades(bt), [
    ['STK', '2020-01-02', '2020-01-16'],
    ['CRY', '2020-01-17', '2020-01-18'],
    ['STK', '2020-01-20', 'open'],
  ]);
  assert.deepEqual(bt.run.trades[0].why!.exit, { k: 'rule', t: jan(16) });
});

test('fill: close, tickers on one clock are unchanged: same source, same days, same bar length', () => {
  const A = series(STK_T, (t) => (t >= jan(15) ? 200 : 100));
  const B = series(STK_T, () => 150);
  // Both Yahoo weekday series: B's rule reads A's bar of the same day and buys at that close, as before.
  const of = run('universe: B\nfill: close\nbuy when close of A > 150', { A, B });
  assert.deepEqual(trades(of), [['B', '2020-01-15', 'open']]);
  const ranked = run('universe: A, B\ncapital: 1000\nfill: close\nhold: top 1 by close', { A, B });
  assert.deepEqual(trades(ranked), [
    ['B', '2020-01-01', '2020-01-15'],
    ['A', '2020-01-15', 'open'],
  ]);
  // Binance tickers on the same bars close at the same moment.
  const C = series(CRY_T, (t) => (t >= jan(15) ? 200 : 100));
  const D = series(CRY_T, () => 150);
  assert.deepEqual(trades(run('universe: binance:D\nfill: close\nbuy when close of binance:C > 150', { C, D })), [['D', '2020-01-15', 'open']]);
});

test('fill: close, an hourly rule reads another source\'s hour that ended before its own began, and a daily bar from the next day on', () => {
  const hours = Array.from({ length: 72 }, (_, i) => jan(1) + i * HOUR);
  const X = series(hours, () => 50);
  // The CSV's bar of 10:00 on 2 January is the first above 150.
  const Y = series(hours, (t) => (t >= jan(2, 10) ? 200 : 100));
  const hourly = run('universe: binance:X\ninterval: 1h\nfill: close\nbuy when close of csv:Data/Y.csv > 150', { X, Y });
  assert.equal(hourly.run.trades[0].entryT, jan(2, 11));
  // The same rule on Binance's own hourly bars reads the hour that ends with its own.
  assert.equal(run('universe: binance:X\ninterval: 1h\nfill: close\nbuy when close of binance:Y > 150', { X, Y }).run.trades[0].entryT, jan(2, 10));
  // A daily bar of 2 January (Binance's own, another bar length) is read from 00:00 on the 3rd, not from 23:00 on the 2nd.
  const daily = series([1, 2, 3].map((d) => jan(d)), (t) => (t >= jan(2) ? 200 : 100));
  const bt = run('universe: binance:X\ninterval: 1h\nfill: close\nbuy when close of binance:Y > 150', { X, Y: daily });
  assert.equal(bt.run.trades[0].entryT, jan(3));
  assert.equal(run('universe: binance:X\ninterval: 1h\nbuy when close of binance:Y > 150', { X, Y: daily }).run.trades[0].why!.buyT, jan(2, 23));
});

test('fill: close, a weekly rule reads another source\'s week only after its own week', () => {
  // Weeks dated Monday 6, 13, 20 and 27 January; Y's week of the 13th is the first above 150.
  const weeks = [6, 13, 20, 27].map((d) => jan(d));
  const X = series(weeks, () => 50);
  const Y = series(weeks, (t) => (t >= jan(13) ? 200 : 100));
  const bt = run('universe: X\ninterval: 1w\nfill: close\nbuy when close of binance:Y > 150', { X, Y });
  assert.equal(bt.run.trades[0].entryT, jan(20));
});

test('fill: close notes say which reads moved to the bar before, and which assume a close is known', () => {
  const STK = series(STK_T, () => 100);
  const CRY = series(CRY_T, () => 100);
  const QQQ = series(STK_T, () => 100);
  const shifted = run('universe: STK\nfill: close\nbuy when close of binance:CRY > 150', { STK, CRY }).notes;
  assert.ok(shifted.some((n) => n.includes('previous bar') && n.includes('CRY for STK')), shifted.join('\n'));
  assert.ok(!shifted.some((n) => n.includes('known at the time')));
  const assumed = run('universe: STK\nfill: close\nbuy when close of QQQ > 150', { STK, QQQ }).notes;
  assert.ok(assumed.some((n) => n.includes('QQQ for STK') && n.includes('known at the time of the fill')), assumed.join('\n'));
  const ranked = run('universe: STK, QQQ\nfill: close\nhold: top 1 by close', { STK, QQQ }).notes;
  assert.ok(ranked.some((n) => n.includes('compares') && n.includes('known at the time of the fill')), ranked.join('\n'));
  const mixed = run('universe: STK, binance:CRY\nfill: close\nhold: top 1 by close', { STK, CRY }).notes;
  assert.ok(mixed.some((n) => n.includes('the score reads the previous bar of each ticker')), mixed.join('\n'));
  assert.ok(!mixed.some((n) => n.includes('known at the time')));
  // Binance closes come at the same moment for every ticker, and next open never fills before a close it read.
  assert.ok(!run('universe: binance:CRY\nfill: close\nbuy when close of binance:ETH > 150', { CRY, ETH: CRY }).notes.some((n) => n.includes('ETH')));
  assert.ok(!run('universe: STK\nbuy when close of QQQ > 150', { STK, QQQ }).notes.some((n) => n.includes('QQQ')));
});
