import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { parseYahoo, parseYahooInside } from '../src/data.ts';
import { parseSpec, RESERVED } from '../src/dsl.ts';
import { insideKey, lookInside, type ExitWhy, type Trade } from '../src/engine.ts';
import { explainTrade, type Explanation } from '../src/explain.ts';
import type { Bars } from '../src/types.ts';
import { DAY, T0 } from './helpers.ts';

const HOUR = 3_600_000;
const day = (n: number) => T0 + n * DAY;

function run(src: string, data: Record<string, Bars>): Backtest {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  return runBacktest(spec!, new Map(Object.entries(data)));
}

/** Bars with the given [open, high, low, close] at the given times. */
function ohlc(rows: number[][], times: number[]): Bars {
  return { t: times, o: rows.map((r) => r[0]), h: rows.map((r) => r[1]), l: rows.map((r) => r[2]), c: rows.map((r) => r[3]), v: rows.map(() => 1000) };
}
/** Daily bars from day 0 on. */
const daily = (rows: number[][]) => ohlc(rows, rows.map((_, n) => day(n)));
/** A day's 1h bars on the exchange's clock, from 09:30. */
const hours = (n: number, rows: number[][]) => ohlc(rows, rows.map((_, j) => day(n) + 9.5 * HOUR + j * HOUR));
function join(...parts: Bars[]): Bars {
  return { t: parts.flatMap((p) => p.t), o: parts.flatMap((p) => p.o), h: parts.flatMap((p) => p.h), l: parts.flatMap((p) => p.l), c: parts.flatMap((p) => p.c), v: parts.flatMap((p) => p.v) };
}
const FLAT = [100, 100, 100, 100];
const one = (bt: Backtest): Trade => {
  assert.equal(bt.run.trades.length, 1);
  return bt.run.trades[0];
};
/** The stop or target a trade was sold at. */
const levelOf = (t: Trade) => t.why!.exit as Extract<ExitWhy, { k: 'level' }>;
const sold = (ex: Explanation) => ex.sections.find((s) => s.id === 'sold')!.rows.map((r) => r.label);

// ---------------------------------------------------------------- the setting

test('magnify: a bar size smaller than the interval that divides it and that the source gives', () => {
  const spec = (text: string) => parseSpec(`${text}\nbuy when true`);
  assert.equal(spec('universe: SPY\nmagnify: 1H').spec!.magnify, '1h');
  assert.equal(spec('universe: SPY').spec!.magnify, undefined);
  assert.equal(spec('universe: SPY\ninterval: 1w\nmagnify: 1d').spec!.magnify, '1d');
  assert.equal(spec('data: binance\nuniverse: BTCUSDT\ninterval: 4h\nmagnify: 15m').spec!.magnify, '15m');
  assert.equal(spec('universe: SPY, binance:BTCUSDT, csv:Data/gold.csv\nmagnify: 5m').spec!.magnify, '5m');
  const error = (text: string) => spec(text).errors.map((e) => e.message);
  assert.deepEqual(error('universe: SPY\nmagnify: 1d'), ['magnify must use bars shorter than the 1d bars of the strategy, for example 1h']);
  assert.deepEqual(error('universe: SPY\nmagnify: soon'), ['magnify must have a bar size smaller than the 1d bars of the strategy, for example 1h']);
  assert.deepEqual(error('data: binance\nuniverse: BTCUSDT\ninterval: 5m\nmagnify: 3m'), ['A 5m bar does not contain a whole number of 3m bars. Use a size that divides it, for example 1m']);
  assert.deepEqual(error('data: binance\nuniverse: BTCUSDT\ninterval: 1m\nmagnify: 1m'), ['1m bars are the shortest bars. Thus magnify cannot examine them with smaller bars']);
  assert.deepEqual(error('universe: SPY\nmagnify: 1m'), ['Yahoo can examine daily bars only with 2m, 5m, 15m, 30m, 1h bars, not 1m']);
  assert.deepEqual(error('universe: SPY\ninterval: 1w\nmagnify: 1h'), ['Yahoo can examine weekly bars only with 1d bars, not 1h']);
  assert.deepEqual(error('universe: SPY, binance:BTCUSDT\nmagnify: 2m'), ['Binance can examine 1d bars only with 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h bars, not 2m']);
  assert.deepEqual(error('universe: csv:Data/gold.csv\nmagnify: 1h'), ['magnify examines bars with smaller bars from Yahoo or Binance. CSV files do not have smaller bars']);
  // A whole-strategy setting, so not inside a for section, and a word a parameter can't take.
  assert.match(error('universe: SPY, QQQ\nfor SPY:\n  magnify: 1h')[0], /is a setting for the full strategy/);
  assert.ok(RESERVED.has('magnify'));
});

// ---------------------------------------------------------------- what the smaller bars decide

const LEVELS = 'universe: A\ncapital: 1000\nstop loss: 10%\ntake profit: 20%\nbuy when true';
// Bought at day 1's open, 100: the stop at 90 and the target at 120 both lie inside day 2's range.
const BOTH = daily([FLAT, FLAT, [100, 125, 85, 100], FLAT]);

test('a target reached before the stop, in the smaller bars, is taken at the target', () => {
  const plain = one(run(LEVELS, { A: BOTH }));
  assert.deepEqual([plain.reason, plain.exitPrice, plain.exitT], ['stop loss', 90, day(2)]);
  const A = hours(2, [[100, 125, 100, 121], [121, 121, 85, 90], [90, 100, 90, 100]]);
  const bt = run(`${LEVELS}\nmagnify: 1h`, { A: BOTH, [insideKey('A', '1h')]: A });
  const t = one(bt);
  assert.deepEqual([t.reason, t.exitPrice, t.exitT, t.bars], ['take profit', 120, day(2), 1]);
  assert.deepEqual(t.why!.exit, { k: 'level', level: 120, high: null, atOpen: false, inside: { k: 'inside', t: day(2) + 9.5 * HOUR } });
  assert.deepEqual(bt.run.inside, [{ asset: 'A', from: day(2), looked: 1, whole: 0 }]);
});

test('a stop reached before the target is taken at the stop, and says it was looked inside', () => {
  const A = hours(2, [[100, 100, 85, 88], [88, 125, 88, 121], [121, 121, 100, 100]]);
  const t = one(run(`${LEVELS}\nmagnify: 1h`, { A: BOTH, [insideKey('A', '1h')]: A }));
  assert.deepEqual([t.reason, t.exitPrice, t.exitT], ['stop loss', 90, day(2)]);
  assert.deepEqual(t.why!.exit, { k: 'level', level: 90, high: null, atOpen: false, inside: { k: 'inside', t: day(2) + 9.5 * HOUR } });
});

test('a smaller bar that opens beyond a level fills at its open, as a bar does', () => {
  // The second hour opens at 88, under the stop at 90; the bar as a whole only shows its low of 86.
  const down = daily([FLAT, FLAT, [100, 104, 86, 91], [91, 91, 91, 91]]);
  assert.equal(one(run(LEVELS, { A: down })).exitPrice, 90);
  let t = one(run(`${LEVELS}\nmagnify: 1h`, { A: down, [insideKey('A', '1h')]: hours(2, [[100, 104, 96, 97], [88, 92, 86, 91]]) }));
  assert.deepEqual([t.reason, t.exitPrice, t.why!.exit], ['stop loss', 88, { k: 'level', level: 90, high: null, atOpen: true, inside: { k: 'inside', t: day(2) + 10.5 * HOUR } }]);
  // And one that opens above the target fills there.
  const up = daily([FLAT, FLAT, [100, 130, 99, 125], [125, 125, 125, 125]]);
  assert.equal(one(run(LEVELS, { A: up })).exitPrice, 120);
  t = one(run(`${LEVELS}\nmagnify: 1h`, { A: up, [insideKey('A', '1h')]: hours(2, [[100, 105, 99, 104], [126, 130, 125, 125]]) }));
  assert.deepEqual([t.reason, t.exitPrice, levelOf(t).atOpen], ['take profit', 126, true]);
});

test('a trailing stop rises with each smaller bar that has ended, and is hit later in the same bar', () => {
  // Day 2 runs up to 120 in its first hour and falls to 107 in its second. A whole bar's high counts only from the next
  // bar on, so without magnify the level is 90 all day 2 and 108 on day 3, which opens at 108.
  const A = daily([FLAT, FLAT, [100, 120, 100, 108], [108, 108, 105, 106], [106, 106, 106, 106]]);
  const src = 'universe: A\ncapital: 1000\ntrailing stop: 10%\nbuy when true';
  const plain = one(run(src, { A }));
  assert.deepEqual([plain.reason, plain.exitPrice, plain.exitT], ['trailing stop', 108, day(3)]);
  const t = one(run(`${src}\nmagnify: 1h`, { A, [insideKey('A', '1h')]: hours(2, [[100, 120, 100, 118], [118, 119, 107, 108]]) }));
  assert.deepEqual([t.reason, t.exitPrice, t.exitT], ['trailing stop', 108, day(2)]);
  assert.deepEqual(t.why!.exit, { k: 'level', level: 108, high: 120, atOpen: false, inside: { k: 'inside', t: day(2) + 10.5 * HOUR } });
});

test('a position bought at an open is watched through the rest of that bar, and can be stopped later in it', () => {
  // Bought at day 1's open, 100, with the stop at 90 and the target at 105: the first hour reaches the target.
  const A = daily([FLAT, [100, 106, 88, 95], [95, 95, 95, 95]]);
  const src = 'universe: A\ncapital: 1000\nstop loss: 10%\ntake profit: 5%\nbuy when true';
  assert.deepEqual([one(run(src, { A })).reason, one(run(src, { A })).exitPrice], ['stop loss', 90]);
  const t = one(run(`${src}\nmagnify: 1h`, { A, [insideKey('A', '1h')]: hours(1, [[100, 106, 99, 105], [105, 105, 88, 95]]) }));
  assert.deepEqual([t.reason, t.exitPrice, t.entryT, t.exitT, t.bars], ['take profit', 105, day(1), day(1), 0]);
  // A 10% trailing stop on the bar bought at: it trails the open, 100, until the first hour reaches 112; read whole, the
  // bar's low of 99 is above 90, and the stop comes only at the next bar.
  const run2 = daily([FLAT, [100, 112, 99, 100], [100, 100, 98, 98], [98, 98, 98, 98]]);
  const trail = 'universe: A\ncapital: 1000\ntrailing stop: 10%\nbuy when true';
  const whole = one(run(trail, { A: run2 }));
  assert.deepEqual([whole.reason, whole.exitPrice, whole.exitT], ['trailing stop', 100, day(2)]);
  const seen = one(run(`${trail}\nmagnify: 1h`, { A: run2, [insideKey('A', '1h')]: hours(1, [[100, 112, 100, 111], [111, 111, 99, 100]]) }));
  assert.deepEqual([seen.reason, seen.exitPrice, seen.entryT, seen.exitT], ['trailing stop', 112 * 0.9, day(1), day(1)]);
});

test('a bar without smaller bars, or without all of them, is read whole, and counted once they have started', () => {
  // Day 1 has its smaller bars, day 2 has none: the stop is taken first there, and the note counts it.
  const yahoo = run(`${LEVELS}\nmagnify: 1h`, { A: BOTH, [insideKey('A', '1h')]: hours(1, [FLAT]) });
  const t = one(yahoo);
  assert.deepEqual([t.reason, t.exitPrice, t.why!.exit], ['stop loss', 90, { k: 'level', level: 90, high: null, atOpen: false, inside: { k: 'whole', why: 'none' } }]);
  assert.deepEqual(yahoo.run.inside, [{ asset: 'A', from: day(1), looked: 0, whole: 1 }]);
  assert.ok(yahoo.notes.includes('In that period, the run did not examine 1 bar of A with a stop or target in it, because its 1h bars were missing or did not agree with it.'), yahoo.notes.join('\n'));
  // On Binance a 4h bar must hold all four of its 1h bars.
  const at = (n: number) => T0 + n * 4 * HOUR;
  const B = ohlc([FLAT, FLAT, [100, 125, 85, 100], FLAT], [0, 1, 2, 3].map(at));
  const four = ohlc([[100, 125, 100, 121], [121, 121, 85, 90], [90, 100, 90, 95], [95, 100, 95, 100]], [0, 1, 2, 3].map((j) => at(2) + j * HOUR));
  const src = 'universe: binance:B\ninterval: 4h\ncapital: 1000\nstop loss: 10%\ntake profit: 20%\nbuy when true\nmagnify: 1h';
  const all = one(run(src, { B, [insideKey('B', '1h')]: four }));
  assert.deepEqual([all.reason, all.exitPrice], ['take profit', 120]);
  const three = { t: four.t.slice(0, 3), o: four.o.slice(0, 3), h: four.h.slice(0, 3), l: four.l.slice(0, 3), c: four.c.slice(0, 3), v: four.v.slice(0, 3) };
  const missing = one(run(src, { B, [insideKey('B', '1h')]: three }));
  assert.deepEqual([missing.reason, missing.exitPrice, levelOf(missing).inside], ['stop loss', 90, { k: 'whole', why: 'missing' }]);
});

test('smaller bars that do not match the bar are not used; ones that nearly do are pinned to its prices', () => {
  // Scaled to agree best, these hours miss the bar's high of 125 by more than a quarter of its range (40).
  const off = one(run(`${LEVELS}\nmagnify: 1h`, { A: BOTH, [insideKey('A', '1h')]: hours(2, [[100, 100, 95, 97], [97, 100, 85, 100]]) }));
  assert.deepEqual([off.reason, off.exitPrice, levelOf(off).inside], ['stop loss', 90, { k: 'whole', why: 'mismatch' }]);
  // These reach only 115 and close at 90, but by a factor of 1.054 they come within 5.4 of each of the bar's prices: the
  // first hour is given the bar's high, so the target the bar reached is reached there, before the stop.
  const near = hours(2, [[100, 115, 100, 114], [114, 114, 85, 90]]);
  const seen = lookInside(100, 125, 85, 100, near, 0, 2, 0);
  assert.ok(seen.ok);
  if (seen.ok) {
    assert.deepEqual(seen.path.h.map((x) => Number(x.toFixed(2))), [125, 120.17]);
    assert.deepEqual(seen.path.l.map((x) => Number(x.toFixed(2))), [100, 85]);
    assert.deepEqual([seen.path.o[0], seen.path.t], [100, near.t]);
  }
  const t = one(run(`${LEVELS}\nmagnify: 1h`, { A: BOTH, [insideKey('A', '1h')]: near }));
  assert.deepEqual([t.reason, t.exitPrice], ['take profit', 120]);
  // Hours of another day, which fell from its open, do not match a day that rose to its high and came back, at any scale.
  assert.deepEqual(lookInside(100, 125, 85, 100, hours(2, [[50, 52, 45, 46]]), 0, 1, 0), { ok: false, why: 'mismatch' });
});

test('one factor takes in an adjustment the smaller bars lack: a split and a dividend', () => {
  // The daily bars are adjusted; the hours are as traded, before a 2-for-1 split and a 2% dividend (a factor of 0.49), or
  // after the split only (0.98). Each day is scaled by its own factor, so the result is the one on adjusted hours.
  const rows = [[100, 125, 100, 121], [121, 121, 85, 90], [90, 100, 90, 100]];
  for (const factor of [1, 0.98, 0.49]) {
    const A = hours(2, rows.map((r) => r.map((x) => x / factor)));
    const t = one(run(`${LEVELS}\nmagnify: 1h`, { A: BOTH, [insideKey('A', '1h')]: A }));
    assert.deepEqual([t.reason, t.exitPrice, t.exitT], ['take profit', 120, day(2)], `factor ${factor}`);
  }
  // Yahoo's own: SPY's hours of 26 November 2025 are not adjusted for the dividends since, and its daily bar is.
  const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const now = Date.UTC(2026, 10, 17, 16, 30);
  const big = parseYahoo(read('yahoo-inside-spy-1d.json'), now);
  const small = parseYahooInside(read('yahoo-inside-spy-1h.json'), now, HOUR);
  const i = big.t.indexOf(Date.UTC(2025, 10, 26));
  const from = small.t.findIndex((t) => t >= big.t[i]);
  const to = small.t.findIndex((t) => t >= big.t[i] + DAY);
  const seen = lookInside(big.o[i], big.h[i], big.l[i], big.c[i], small, from, to, 0);
  assert.equal(to - from, 7);
  assert.ok(seen.ok);
  // The path keeps the bar's own prices: its open first, its high and low where the hours have them.
  if (seen.ok) assert.deepEqual([seen.path.o[0], Math.max(...seen.path.h), Math.min(...seen.path.l)], [big.o[i], big.h[i], big.l[i]]);
});

test('with fill: close the bar bought at its close is not watched, and the next one is looked inside', () => {
  // Bought at day 0's close, 100. Day 0 itself reaches both levels, before the fill; day 1 reaches the target first.
  const A = daily([[100, 130, 80, 100], [100, 125, 85, 100], FLAT]);
  const inside = join(hours(0, [[100, 130, 100, 129], [129, 129, 80, 100]]), hours(1, [[100, 125, 100, 121], [121, 121, 85, 90], [90, 100, 90, 100]]));
  const src = `${LEVELS}\nfill: close`;
  assert.deepEqual([one(run(src, { A })).reason, one(run(src, { A })).exitT], ['stop loss', day(1)]);
  const t = one(run(`${src}\nmagnify: 1h`, { A, [insideKey('A', '1h')]: inside }));
  assert.deepEqual([t.entryT, t.reason, t.exitPrice, t.exitT], [day(0), 'take profit', 120, day(1)]);
});

test('an add filled at an open moves the stop and the target for the rest of that bar', () => {
  // Two entries of half each. The first, at day 1's open, 100, sets the stop at 95 and the target at 110. The add rule holds at day
  // 2's close (105), so day 3 opens with an add at 110: 5 + 4.545 shares at 104.76 on average, the stop at 99.52 and the
  // target at 115.24. Day 3 reaches the target in its first hour; read whole, its low of 99 would take the stop first.
  const A = daily([FLAT, FLAT, [100, 106, 100, 105], [110, 116, 99, 101], [101, 101, 101, 101]]);
  const src = 'universe: A\ncapital: 1000\nentries: 2\nstop loss: 5%\ntake profit: 10%\nbuy when true\nadd when close > 104';
  const average = 1000 / (5 + 500 / 110);
  const plain = one(run(src, { A }));
  assert.equal(plain.reason, 'stop loss');
  assert.ok(Math.abs(plain.exitPrice - average * 0.95) < 1e-9);
  const t = one(run(`${src}\nmagnify: 1h`, { A, [insideKey('A', '1h')]: hours(3, [[110, 116, 109, 115], [115, 115, 99, 101]]) }));
  assert.equal(t.reason, 'take profit');
  assert.equal(t.entries!.length, 2);
  assert.ok(Math.abs(t.exitPrice - average * 1.1) < 1e-9 && Math.abs(t.entryPrice - average) < 1e-9);
  assert.equal(t.exitT, day(3));
});

test('commission, costs and slippage are paid on an exit inside a bar as on any', () => {
  const A = hours(2, [[100, 125, 100, 121], [121, 121, 85, 90], [90, 100, 90, 100]]);
  const bt = run(`${LEVELS}\ncosts: 10 bps\nslippage: 20 bps\ncommission: 1\nmagnify: 1h`, { A: BOTH, [insideKey('A', '1h')]: A });
  const t = one(bt);
  // Bought at 100.2 with the slippage, so the target is 120.24; sold there less the slippage, the costs and 1 of commission.
  assert.equal(t.reason, 'take profit');
  assert.ok(Math.abs(t.exitPrice - 120.24 * 0.998) < 1e-9);
  const shares = t.why!.shares;
  assert.ok(Math.abs(bt.run.equity.at(-1)! - (1000 - (shares * 100.2 * 1.001 + 1) + shares * 120.24 * 0.998 * 0.999 - 1)) < 1e-9);
});

test('stocks and crypto in one universe are each looked inside with their own bars, from their own first day of them', () => {
  // CRY trades on Binance: every day has its 24 hours. STK has hours from day 3 on only, as Yahoo gives a recent window.
  const flatDay = (n: number) => ohlc(Array.from({ length: 24 }, () => FLAT), Array.from({ length: 24 }, (_, j) => day(n) + j * HOUR));
  const event = ohlc(
    Array.from({ length: 24 }, (_, j) => (j === 3 ? [100, 125, 100, 121] : j === 4 ? [121, 121, 85, 90] : j < 3 ? FLAT : [90, 100, 90, 100])),
    Array.from({ length: 24 }, (_, j) => day(2) + j * HOUR),
  );
  const CRY = daily([FLAT, FLAT, [100, 125, 85, 100], FLAT, FLAT]);
  const STK = daily([FLAT, FLAT, FLAT, FLAT, [100, 125, 85, 100]]);
  const bt = run('universe: STK, binance:CRY\ncapital: 1000\nstop loss: 10%\ntake profit: 20%\nbuy when true\nmagnify: 1h', {
    STK,
    CRY,
    [insideKey('CRY', '1h')]: join(flatDay(0), flatDay(1), event, flatDay(3), flatDay(4)),
    [insideKey('STK', '1h')]: join(hours(3, [FLAT]), hours(4, [[100, 125, 100, 121], [121, 121, 85, 90], [90, 100, 90, 100]])),
  });
  assert.deepEqual(
    bt.run.trades.map((t) => [t.asset, t.reason, t.exitPrice, t.exitT]),
    [['CRY', 'take profit', 120, day(2)], ['STK', 'take profit', 120, day(4)]],
  );
  assert.deepEqual(bt.run.inside, [{ asset: 'STK', from: day(3), looked: 1, whole: 0 }, { asset: 'CRY', from: day(0), looked: 1, whole: 0 }]);
  assert.deepEqual(bt.notes.filter((n) => /^The run examined/.test(n)), [
    'The run examined the bars of STK from 2020-01-04 with its 1h bars (Yahoo gives 1h bars for the last 730 days): 1 bar held a stop or target, and the run examined it with the smaller bars. Before that date, the run did not examine the bars with smaller bars, and when a bar holds a stop and a target, the run uses the stop first.',
    'The run examined each bar of CRY with its 1h bars: 1 bar held a stop or target, and the run examined it with the smaller bars.',
  ]);
});

test('a run looked inside only from a later day: the note, and each trade\'s words', () => {
  // Stopped on day 2, which has no hours: the stop is taken first, as for any bar read whole. The rule fails at day 2's close
  // (95), holds again at day 3's, and buys at day 4's open; day 4 is looked inside and reaches the target first.
  const A = daily([FLAT, FLAT, [100, 125, 85, 95], [95, 100, 95, 100], [100, 125, 85, 100], FLAT]);
  const inside = join(hours(3, [[95, 100, 95, 100]]), hours(4, [[100, 125, 100, 121], [121, 121, 85, 90], [90, 100, 90, 100]]));
  const bt = run('universe: A\ncapital: 1000\nstop loss: 10%\ntake profit: 20%\nbuy when close > 99\nmagnify: 1h', { A, [insideKey('A', '1h')]: inside });
  assert.deepEqual(bt.run.trades.map((t) => [t.reason, t.exitPrice, t.exitT]), [['stop loss', 90, day(2)], ['take profit', 120, day(4)]]);
  assert.deepEqual(bt.run.inside, [{ asset: 'A', from: day(3), looked: 1, whole: 0 }]);
  assert.ok(
    bt.notes.includes(
      'The run examined the bars of A from 2020-01-04 with its 1h bars (Yahoo gives 1h bars for the last 730 days): 1 bar held a stop or target, and the run examined it with the smaller bars. Before that date, the run did not examine the bars with smaller bars, and when a bar holds a stop and a target, the run uses the stop first.',
    ),
    bt.notes.join('\n'),
  );
  assert.deepEqual(sold(explainTrade(bt, bt.run.trades[0])), [
    'Stop loss at 90.00',
    'On 2020-01-03, the price decreased to 85.00, through the stop. Thus it sold at the stop.',
    'The take profit at 120.00 was also in this bar. There are no 1h bars for this bar. Thus the run did not examine this bar with smaller bars, and the stop comes first.',
    'Sold at the stop',
  ]);
  const ex = explainTrade(bt, bt.run.trades[1]);
  assert.deepEqual(sold(ex), [
    'Take profit at 120.00',
    'On 2020-01-05, in the 1h bar that starts at 2020-01-05 09:30 (exchange time), the price increased to 125.00, through the target. Thus it sold at the target.',
    'The stop at 90.00 was also in this bar. Its 1h bars show that the price touched the target first.',
    'Sold at the target',
  ]);
  assert.deepEqual([ex.facts.level, ex.facts.exitPrice], [120, 120]);
});

test('the words for a stop inside a bar: the smaller bar, its time, a gap at its open, a trailing level from inside the bar', () => {
  const down = daily([FLAT, FLAT, [100, 125, 86, 91], [91, 91, 91, 91]]);
  const at = (rows: number[][]) => ({ A: down, [insideKey('A', '1h')]: hours(2, rows) });
  let bt = run(`${LEVELS}\nmagnify: 1h`, at([[100, 104, 96, 97], [88, 92, 86, 91], [91, 125, 91, 91]]));
  let ex = explainTrade(bt, one(bt));
  assert.deepEqual(sold(ex), [
    'Stop loss at 90.00',
    'On 2020-01-03, the 1h bar that starts at 2020-01-03 10:30 (exchange time) opened at 88.00, below the stop. Thus it sold at that open.',
    'The take profit at 120.00 was also in this bar. Its 1h bars show that the price touched the stop first.',
    'Sold at the open of that 1h bar',
  ]);
  assert.deepEqual([ex.facts.level, ex.facts.exitPrice], [90, 88]);
  // Read whole with only the stop inside it, a bar says why it was not looked inside.
  bt = run(`${LEVELS}\nmagnify: 1h`, { A: daily([FLAT, FLAT, [100, 104, 86, 91], [91, 91, 91, 91]]), [insideKey('A', '1h')]: hours(1, [FLAT]) });
  assert.deepEqual(sold(explainTrade(bt, one(bt))), [
    'Stop loss at 90.00',
    'On 2020-01-03, the price decreased to 86.00, through the stop. Thus it sold at the stop.',
    'There are no 1h bars for this bar. Thus the run did not examine this bar with smaller bars.',
    'Sold at the stop',
  ]);
  // A trailing stop names the high inside the bar it trailed from; Binance's hours are in UTC.
  const A = daily([FLAT, FLAT, [100, 120, 100, 108], [108, 108, 105, 106]]);
  const hoursUtc = ohlc([[100, 120, 100, 118], [118, 119, 107, 108], ...Array.from({ length: 22 }, () => [108, 108, 108, 108])], Array.from({ length: 24 }, (_, j) => day(2) + j * HOUR));
  bt = run('universe: binance:A\ncapital: 1000\ntrailing stop: 10%\nbuy when true\nmagnify: 1h', { A, [insideKey('A', '1h')]: hoursUtc });
  ex = explainTrade(bt, one(bt));
  assert.deepEqual(ex.sections.find((s) => s.id === 'sold')!.rows.map((r) => [r.label, r.value]), [
    ['Trailing stop at 108.00', '10% below 120.00, the highest price from the buy to the previous 1h bar'],
    ['On 2020-01-03, in the 1h bar that starts at 2020-01-03 01:00 UTC, the price decreased to 107.00, through the stop. Thus it sold at the stop.', ''],
    ['Sold at the stop', '108.00'],
  ]);
});

test('notes: a ticker whose smaller bars do not reach into the run, a CSV file, and runs without magnify', () => {
  const bt = run('universe: A, csv:Data/gold.csv\ncapital: 1000\nstop loss: 10%\nbuy when true\nmagnify: 1h', { A: BOTH, gold: BOTH, [insideKey('A', '1h')]: { t: [], o: [], h: [], l: [], c: [], v: [] } });
  assert.deepEqual(bt.run.inside, [{ asset: 'A', from: null, looked: 0, whole: 0 }]);
  assert.deepEqual(bt.notes, [
    'No 1h bars of A are in the period of this run (Yahoo gives 1h bars for the last 730 days). Thus the run did not examine its bars with smaller bars, and when a bar holds a stop and a target, the run uses the stop first.',
    'gold is a CSV file, which has no smaller bars. Thus the run did not examine its bars with smaller bars.',
  ]);
  const plain = run(LEVELS, { A: BOTH });
  assert.equal(plain.run.inside, undefined);
  assert.equal(plain.run.trades[0].why!.exit!.k === 'level' && 'inside' in plain.run.trades[0].why!.exit!, false);
});
