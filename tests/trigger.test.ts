import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { parseSpec, type Spec } from '../src/dsl.ts';
import { missingInputAt } from '../src/engine.ts';
import { specEvaluator } from '../src/evaluate.ts';
import { STARTERS } from '../src/gallery.ts';
import { nextBarTime, periodEnds, monthKey } from '../src/indicators.ts';
import { lookbackBars } from '../src/runner.ts';
import {
  agrees,
  computeTriggers,
  condition,
  keptBars,
  levelsSentence,
  nearest,
  nextBarData,
  PRECISION,
  search,
  tickerText,
  triggerRun,
  watchable,
  type Trigger,
  type TriggerReport,
} from '../src/trigger.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY, near, T0 } from './helpers.ts';
import { tally, verify, walkBars } from './trigger-helpers.ts';

function parsed(src: string): Spec {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, [], src);
  return spec!;
}
function run(src: string, data: Record<string, Bars>): Backtest {
  return runBacktest(parsed(src), new Map(Object.entries(data)));
}
function report(src: string, data: Record<string, Bars>): { bt: Backtest; report: TriggerReport; data: Map<string, Bars> } {
  const map = new Map(Object.entries(data));
  const bt = runBacktest(parsed(src), map);
  return { bt, report: computeTriggers(bt.spec, map, triggerRun(bt.run)), data: map };
}
const only = (r: TriggerReport, side?: Trigger['side']): Trigger => {
  const found = r.triggers.filter((t) => side === undefined || t.side === side);
  assert.equal(found.length, 1, JSON.stringify(r.triggers));
  return found[0];
};
const day = (n: number) => T0 + n * DAY;

/** Fails unless `v` is made only of plain objects, arrays, strings, numbers, booleans and null, as postMessage keeps them. */
function assertPlain(v: unknown, path = 'result'): void {
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return;
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertPlain(x, `${path}[${i}]`));
    return;
  }
  assert.ok(typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype, `${path} is ${typeof v === 'object' ? Object.getPrototypeOf(v)?.constructor?.name : typeof v}`);
  for (const [k, x] of Object.entries(v as object)) assertPlain(x, `${path}.${k}`);
}

// ---------------------------------------------------------------- the engine's state at the end

test('a held position carries what its rules read and the levels in force for the next bar, the trailing one moved by the last high', () => {
  // Bought at day 1's open, 10. The highs reach 12 on day 3, so the 5% trailing stop is at 11.4 for the next bar.
  const A = bars([10, 10, 11, 12, 11.5]);
  const st = run('universe: A\ncapital: 1000\nstop loss: 10%\ntrailing stop: 5%\ntake profit: 50%\nbuy when true', { A }).run.states[0];
  assert.deepEqual(st.pos, { entryIdx: 1, entryPrice: 10, lastPrice: 10, entries: 1 });
  assert.ok(near(st.levels!.stop!, 11.4) && near(st.levels!.target!, 15));
  const plain = run('universe: A\nbuy when true', { A }).run.states[0];
  assert.ok(plain.pos && !('levels' in plain) && !('rearming' in plain));
  assert.deepEqual(run('universe: A\nstop loss: 10%\nbuy when true', { A }).run.states[0].levels, { stop: 9, target: null });
});

test('a ticker stopped out while its buy rule still holds waits for the rule to stop holding; one in cash otherwise does not', () => {
  // Bought at day 1's open (10), stopped at 9 on day 3, whose close of 10 still holds the buy rule.
  const A = bars([10, 10, 10, 10], { lows: [10, 10, 10, 8.8] });
  const stopped = run('universe: A\nstop loss: 10%\nbuy when close > 9.9', { A }).run;
  assert.equal(stopped.trades[0].reason, 'stop loss');
  assert.deepEqual([stopped.states[0].long, stopped.states[0].rearming, 'pos' in stopped.states[0]], [false, true, false]);
  // The buy rule stopped holding at the stop's close: it may buy again.
  const cleared = run('universe: A\nstop loss: 10%\nbuy when close > 9.9', { A: bars([10, 10, 10, 9.5], { lows: [10, 10, 10, 8.8] }) }).run.states[0];
  assert.ok(!('rearming' in cleared));
  // A ranking buys whatever the stop did.
  const ranked = run('universe: A, B\nhold: top 1 by close\nstop loss: 10%\nbuy when close > 9.9', { A, B: bars([1, 1, 1, 1]) }).run.states[0];
  assert.ok(!('rearming' in ranked));
});

test('the warm-up check is the engine\'s: sizing inputs first, then the stops in order', () => {
  const nan = () => NaN;
  const known = () => 1;
  const stops = { stopLoss: { k: 'atr' as const, mult: 2, n: 10 }, trailingStop: null, takeProfit: { k: 'atr' as const, mult: 3, n: 20 } };
  assert.deepEqual(missingInputAt({ k: 'risk', risk: 0.01, mult: 2, n: 14 }, stops, nan, known), { input: 'risk per trade', n: 14 });
  assert.deepEqual(missingInputAt({ k: 'invvol', n: 60 }, stops, known, nan), { input: 'inverse volatility', n: 60 });
  assert.deepEqual(missingInputAt({ k: 'fixed' }, stops, (n) => (n === 20 ? NaN : 1), known), { input: 'take profit', n: 20 });
  assert.equal(missingInputAt({ k: 'fixed' }, undefined, nan, nan), null);
});

test('the next bar skips a weekend unless the series trades at weekends, and month_end reads it', () => {
  const friday = Date.UTC(2026, 10, 13);
  const weekdays = [friday - 4 * DAY, friday - 3 * DAY, friday];
  assert.equal(nextBarTime(weekdays), Date.UTC(2026, 10, 16));
  assert.equal(nextBarTime([friday - DAY, friday, friday + DAY]), Date.UTC(2026, 10, 15));
  assert.equal(nextBarTime([friday]), Date.UTC(2026, 10, 16));
  assert.equal(nextBarTime([friday - 14 * DAY, friday - 7 * DAY, friday]), friday + 7 * DAY);
  // Friday 27 November 2026 is not the month's last weekday: Monday the 30th is.
  const nov27 = Date.UTC(2026, 10, 27);
  assert.deepEqual(periodEnds([nov27 - DAY, nov27], monthKey), [0, 0]);
  assert.deepEqual(periodEnds([nov27, nov27 + 3 * DAY], monthKey), [0, 1]);
});

// ---------------------------------------------------------------- trigger prices

test('a buy rule on the close: the close above which it buys, in words, exact', () => {
  // sma(3) at the next bar is (10 + 9 + x) / 3, below x when x > 9.5.
  const A = bars([10, 10, 10, 10, 9]);
  const { report: r } = report('universe: A\nbuy when close > sma(3)', { A });
  const t = only(r);
  assert.deepEqual([t.side, t.driver, t.last, t.exact, t.assumptions], ['buy', 'A', 9, true, []]);
  assert.equal(t.fires.length, 1);
  assert.equal(t.fires[0].hi, null);
  assert.ok(t.fires[0].lo! >= 9.5 && t.fires[0].lo! / 9.5 - 1 <= PRECISION, String(t.fires[0].lo));
  assert.equal(r.next, day(5));
  assert.deepEqual(tickerText(r, 'A'), { text: 'Buys if it closes above 9.50 (+5.6%), at the following open.', note: null });
  const close = report('universe: A\nfill: close\nbuy when close > sma(3)', { A }).report;
  assert.equal(tickerText(close, 'A').text, 'Buys if it closes above 9.50 (+5.6%), at that close.');
});

test('a rule on another ticker is solved for that ticker\'s close, with the traded one held where it was', () => {
  const S = bars([10, 10, 10, 10, 9]);
  const T = bars([50, 51, 52, 53, 54]);
  const { report: r, data } = report('universe: T\nbuy when close of S > sma(3) of S', { S, T });
  const t = only(r);
  assert.deepEqual([t.driver, t.last, t.ownLast, t.exact], ['S', 9, 54, true]);
  assert.equal(tickerText(r, 'T').text, 'Buys if S closes above 9.50 (+5.6%), at the following open.');
  // The traded ticker gets a bar where it was; the driver's closes at the price tried.
  const st = runBacktest(parsed('universe: T\nbuy when close of S > sma(3) of S'), data).run.states[0];
  const next = nextBarData(parsed('universe: T\nbuy when close of S > sma(3) of S'), data, st, 9.7);
  assert.deepEqual([next.get('T')!.c.at(-1), next.get('T')!.h.at(-1), next.get('S')!.c.at(-1), next.get('S')!.o.at(-1), next.get('S')!.h.at(-1)], [54, 54, 9.7, 9, 9.7]);
  assert.equal(data.get('S')!.c.length, 5, 'the run\'s own prices are left alone');
});

test('a held position: the sell rule\'s closes stop at the stop, which acts inside the bar first', () => {
  // Bought at day 1's open (10), so the 5% stop is at 9.5. sma(3) at the next bar is (12 + 11 + x) / 3, above x when x < 11.5.
  const src = 'universe: A\nstop loss: 5%\nbuy when true\nsell when close < sma(3)';
  const A = bars([10, 10, 10, 12, 11]);
  const { bt, report: r, data } = report(src, { A });
  const t = only(r);
  assert.deepEqual([t.side, t.levels, t.fires.length], ['sell', { stop: 9.5, target: null }, 1]);
  assert.equal(t.fires[0].lo, null);
  assert.ok(t.fires[0].hi! < 11.5 && 11.5 / t.fires[0].hi! - 1 <= PRECISION);
  assert.equal(t.range.lo, 9.5 * (1 + 1e-9));
  assert.equal(tickerText(r, 'A').text, 'Sells unless it closes above 11.50 (+4.5%), at the following open. The stop at 9.50 (−13.6%) sells during the bar if the price reaches it.');
  // Just below the stop the bar reaches it on its way to the close and sells there; just above, the sell rule does.
  const st = bt.run.states[0];
  const below = runBacktest(bt.spec, nextBarData(bt.spec, data, st, 9.5 * (1 - 1e-6))).run;
  assert.deepEqual([below.trades.at(-1)!.reason, below.trades.at(-1)!.exitT, below.trades.at(-1)!.exitPrice, below.states[0].pending], ['stop loss', day(5), 9.5, null]);
  const above = runBacktest(bt.spec, nextBarData(bt.spec, data, st, 9.5 * (1 + 1e-6))).run;
  assert.deepEqual([above.states[0].long, above.states[0].pending], [true, 'sell']);
});

test('a stop above the last close sells at the next open whatever the close, and the text says so', () => {
  // The last bar reached 12 before closing at 10, so the 3% trailing stop is at 11.64 for the next bar.
  const A = bars([10, 10, 10, 10], { highs: [10, 10, 10, 12] });
  const { report: r } = report('universe: A\ntrailing stop: 3%\nbuy when true\nsell when close < 5', { A });
  const t = only(r);
  assert.deepEqual(t.fires, []);
  assert.equal(tickerText(r, 'A').text, 'The stop at 11.64 (+16.4%) is above the last close, so it sells at the next open unless the price opens above it.');
});

test('after a stop the buy rule must stop holding: the close below which it does', () => {
  const A = bars([10, 10, 10, 10], { lows: [10, 10, 10, 8.8] });
  const { report: r } = report('universe: A\nstop loss: 10%\nbuy when close > 9.9', { A });
  const t = only(r);
  assert.equal(t.side, 'rearm');
  assert.ok(t.fires[0].lo === null && t.fires[0].hi! <= 9.9 && 9.9 / t.fires[0].hi! - 1 <= PRECISION);
  assert.equal(tickerText(r, 'A').text, 'After the stop, the buy rule must stop holding before A is bought again: it does if A closes below 9.90 (−1.0%).');
  verify(parsed('universe: A\nstop loss: 10%\nbuy when close > 9.9'), new Map([['A', A]]), 'rearm', tally());
});

test('a buy that has to wait for its sizing or stop input, or for its own rule, is said so instead of a price', () => {
  const A = bars(Array.from({ length: 10 }, (_, i) => 10 + i));
  const { bt, report: input, data } = report('universe: A\nstop loss: 2 atr(20)\nbuy when close > 30', { A });
  assert.deepEqual([only(input).blocked, only(input).warmup], ['warmup', { input: 'stop loss', n: 20 }]);
  assert.equal(tickerText(input, 'A').text, "Can't buy at the next close: the 20-bar ATR for the stop loss is still unknown there.");
  // The engine agrees: a next close that holds the buy rule is held back, not bought.
  const after = runBacktest(bt.spec, nextBarData(bt.spec, data, bt.run.states[0], 40)).run;
  assert.deepEqual([after.states[0].pending, after.skipped], [null, [{ asset: 'A', input: 'stop loss', n: 20, count: 1 }]]);
  const rule = report('universe: A\nbuy when close > sma(50)', { A }).report;
  assert.deepEqual([only(rule).blocked, only(rule).warmup], ['warmup', null]);
  assert.equal(tickerText(rule, 'A').text, "Can't buy at the next close: the buy rule is still unknown there.");
});

test('an order already waiting, a CSV file and a ticker only a ranking buys get no price', () => {
  const pending = report('universe: A\nbuy when close > 11', { A: bars([10, 10, 12]) }).report;
  assert.deepEqual([only(pending).blocked, only(pending).side, tickerText(pending, 'A').text], ['pending', 'buy', '–']);
  const csv = report('universe: csv:Data/a.csv\nbuy when close > sma(3)', { a: bars([10, 10, 10, 10, 9]) }).report;
  assert.deepEqual([only(csv).blocked, tickerText(csv, 'a').text], ['csv', '–']);
  // Data ends on Friday 13 November 2026; a monthly ranking next decides at the close of Monday the 30th.
  const end = Date.UTC(2026, 10, 13);
  const at = (n: number, b: Bars): Bars => ({ ...b, t: b.t.map((_, i) => end - (b.t.length - 1 - i) * DAY) });
  const ranked = report('universe: A, B\nrebalance: monthly\nhold: top 1 by roc(2)\nbuy when true\nsell when close < 1', {
    A: walkBars(40, 1, { end }),
    B: walkBars(40, 2, { end }),
  }).report;
  assert.equal(ranked.decision, Date.UTC(2026, 10, 30));
  const flat = ranked.triggers.find((t) => t.blocked === 'ranking')!;
  assert.equal(tickerText(ranked, flat.ticker).text, 'Bought only when the ranking picks it, next at the close of 2026-11-30.');
  const held = ranked.triggers.find((t) => !t.blocked)!;
  assert.match(tickerText(ranked, held.ticker).text, / The ranking decides again at the close of 2026-11-30\.$/);
  const never = report('universe: A, B\nhold: top 1 by roc(2)\nbuy when true', { A: at(0, walkBars(40, 1)), B: at(0, walkBars(40, 2)) }).report;
  assert.equal(never.decision, never.next);
  assert.match(tickerText(never, never.triggers.find((t) => t.blocked === 'ranking')!.ticker).text, /next at the next close\.$/);
});

test('a held ticker with no sell rule says what can sell it', () => {
  const { report: r } = report('universe: A\ntrailing stop: 10%\nbuy when true', { A: bars([10, 10, 11, 12]) });
  assert.equal(tickerText(r, 'A').text, 'No sell rule. The stop at 10.80 (−10.0%) sells during the bar if the price reaches it.');
});

test('what the made-up bar assumes is listed: its open, high and low, volume, other tickers and the calendar; reading them a bar back assumes nothing', () => {
  const A = walkBars(80, 3);
  const V = walkBars(80, 4);
  // The buy rule never holds, so the ticker stays in cash and the rule is the one read.
  const said = (rule: string) => only(report(`universe: A\nbuy when ${rule} and close < 1`, { A, V }).report);
  assert.deepEqual(said('close > open').assumptions, ['it opens at its last close']);
  assert.deepEqual(only(report('universe: A\nbuy when close > open and close < 1', { A, V }).report).fires, []);
  assert.deepEqual(said('high > highest(20)[1]').assumptions, ['it trades only between its open and its close']);
  assert.deepEqual(said('close > highest(20)[1]').assumptions, []);
  assert.deepEqual(said('close > vwap(10)').assumptions, ['it trades only between its open and its close', 'its volume is that of its last bar']);
  assert.deepEqual(said('atr(14) > 0 and close > sma(5)').assumptions, ['it trades only between its open and its close']);
  assert.deepEqual(said('close > sma(5) and close of V < sma(10) of V').assumptions, ['V is unchanged']);
  assert.deepEqual(said('close > sma(5) and close[1] of V > 0').assumptions, []);
  assert.deepEqual(said('close > sma(5) and weekday < 6').assumptions, ['the next bar is dated 2026-11-16']);
  const t = said('close > open');
  assert.equal(t.exact, false);
  assert.equal(tickerText(report('universe: A\nbuy when close > open and close < 1', { A, V }).report, 'A').note, 'Assumes it opens at its last close.');
});

test('a series given a bar keeps its own flags, which decide when its rows are known, and its columns their last values', () => {
  const A = walkBars(80, 3);
  // A CSV file of columns, its rows known by their date, with a flag of a kind the copy does not name.
  const signals: Bars & { marker: string } = { ...walkBars(80, 4), unpriced: true, columns: [{ name: 'level', header: 'Level', v: Array.from({ length: 80 }, (_, i) => i) }], marker: 'kept' };
  const { bt, data, report: said } = report('universe: A\nbuy when close > sma(5) and column(level) of csv:Data/signals.csv > 0 and close < 1', { A, signals });
  assert.deepEqual(only(said).assumptions, ['signals keeps its last values']);
  const next = nextBarData(bt.spec, data, bt.run.states[0], 50).get('signals') as typeof signals;
  assert.equal(next.t.length, 81);
  assert.deepEqual([next.unpriced, next.columns![0].v.at(-1), next.marker], [true, 79, 'kept']);
  assert.deepEqual([signals.t.length, signals.columns![0].v.length], [80, 80]);
});

test('another clock: a stock read by Bitcoin\'s close waits for Bitcoin\'s bar that ends with its own; with fill: close Bitcoin is read a bar early, already known', () => {
  // SPY trades on weekdays and ends on Friday 13 November 2026; Bitcoin trades every day and ends on Sunday the 15th.
  const SPY = walkBars(300, 6, { end: Date.UTC(2026, 10, 13) });
  const BTC = walkBars(300, 7, { weekends: true, end: Date.UTC(2026, 10, 15) });
  const rule = 'buy when close of binance:BTCUSDT > sma(3) of binance:BTCUSDT\nsell when close of binance:BTCUSDT < sma(3) of binance:BTCUSDT';
  for (const fill of ['next open', 'close']) {
    const spec = parsed(`universe: SPY\nfill: ${fill}\n${rule}`);
    const data = new Map([['SPY', SPY], ['BTCUSDT', BTC]]);
    const r = verify(spec, data, `fill: ${fill}`, tally());
    const t = only(r);
    // At the next open Monday's SPY bar reads Bitcoin's Monday; at the close it reads Sunday's, which is known.
    assert.equal(t.driver, fill === 'close' ? 'SPY' : 'BTCUSDT');
    if (fill === 'close') assert.ok(t.fires.length === 0 || (t.fires.length === 1 && t.fires[0].lo === null && t.fires[0].hi === null));
    else assert.ok(t.fires.some((b) => b.lo !== null || b.hi !== null));
  }
  // Ending on Friday, Bitcoin needs Saturday and Sunday too, which are taken as unchanged.
  const early = new Map([['SPY', SPY], ['BTCUSDT', walkBars(300, 7, { weekends: true, end: Date.UTC(2026, 10, 13) })]]);
  const t = only(verify(parsed(`universe: SPY\n${rule}`), early, 'Bitcoin ending on Friday', tally()));
  assert.deepEqual([t.driver, t.assumptions], ['BTCUSDT', ['BTCUSDT is unchanged until that close']]);
});

test('month_end at the next bar: on the month\'s last weekday the rule can buy, the day before it cannot', () => {
  const src = 'universe: A\nbuy when month_end and close > sma(3)\nsell when bars held >= 1';
  // Friday 27 November 2026: the next bar is Monday the 30th, the month's last.
  const last = verify(parsed(src), new Map([['A', walkBars(60, 7, { end: Date.UTC(2026, 10, 27) })]]), 'month end', tally());
  assert.ok(only(last).fires.length > 0);
  assert.deepEqual(only(last).assumptions, ['the next bar is dated 2026-11-30']);
  const before = computeTriggers(parsed(src), new Map([['A', walkBars(60, 7, { end: Date.UTC(2026, 10, 26) })]]), triggerRun(run(src, { A: walkBars(60, 7, { end: Date.UTC(2026, 10, 26) }) }).run));
  assert.deepEqual(only(before).fires, []);
  assert.match(tickerText(before, 'A').text, /^The buy rule gives no order at any close from /);
});

test('positions built in entries: an add\'s close, and none once the entries are all made', () => {
  const src = 'universe: A\nentries: 3\nbuy when true\nadd when close > last entry price * 1.01\nsell when close < 5';
  const A = bars([10, 10, 10, 10]);
  const r = verify(parsed(src), new Map([['A', A]]), 'entries', tally());
  const add = r.triggers.find((t) => t.side === 'add')!;
  assert.ok(add.fires[0].lo! >= 10.1 && add.fires[0].lo! / 10.1 - 1 <= PRECISION && add.fires[0].hi === null);
  assert.match(tickerText(r, 'A').text, /^The sell rule gives no order at any close from .*\. Adds if it closes above 10\.10 \(\+1\.0%\), at the following open\.$/);
  const full = report(src, { A: bars([10, 10, 10.5, 11, 11.5, 12]) }).report;
  assert.deepEqual(full.triggers.map((t) => t.side), ['sell']);
});

test('a strategy with a to date has no next close to watch', () => {
  assert.equal(watchable(parsed('universe: A\nto: 2020-01-03\nbuy when true')), false);
  assert.equal(watchable(parsed('universe: A\nbuy when true')), true);
});

test('a report is plain data and leaves the run\'s prices and state as they were', () => {
  STARTERS.forEach((s, k) => {
    const spec = parsed(s.text);
    const names = [...new Set([...spec.universe, ...spec.extras, ...(spec.benchmark ? [spec.benchmark] : [])].map((a) => a.name))];
    const data = new Map(names.map((name, j) => [name, walkBars(700, 10 * k + j, { weekends: spec.universe.some((a) => a.source === 'binance') })]));
    const bt = runBacktest(spec, data);
    const before = structuredClone({ data, states: bt.run.states, t: bt.run.t });
    const arrays = [...data.values()].map((b) => b.c);
    const r = computeTriggers(spec, data, triggerRun(bt.run));
    assertPlain(r);
    assert.deepStrictEqual({ data, states: bt.run.states, t: bt.run.t }, before);
    assert.ok([...data.values()].every((b, i) => b.c === arrays[i]));
  });
});

// ---------------------------------------------------------------- cutting the prices short

test('prices are cut short only when nothing the rules read depends on the whole history or on the cut', () => {
  const A = walkBars(2000, 8);
  const spec = (rule: string) => parsed(`universe: A\nbuy when ${rule}`);
  const read = (s: Spec) => [s.rules.A.buy];
  const data = new Map([['A', A]]);
  assert.equal(keptBars(spec('close > sma(20)'), data, ['A'], read(spec('close > sma(20)'))), lookbackBars(spec('close > sma(20)')) + 2);
  for (const rule of ['bars_since(close < sma(5)) > 2', 'obv > sma(obv, 10)']) assert.equal(keptBars(spec(rule), data, ['A'], read(spec(rule))), null, rule);
  // A few weekend bars early on make the whole series trade at weekends; the last bars alone do not.
  const odd: Bars = { ...A, t: A.t.map((t, i) => (i < 60 ? T0 + i * DAY : t)) };
  assert.equal(keptBars(spec('close > sma(20)'), new Map([['A', odd]]), ['A'], read(spec('close > sma(20)'))), null);
});

test('the guard: a rule on a window agrees on the cut prices, and so does a short exponential average, which has forgotten where it started; a long one does not', () => {
  const A = walkBars(1500, 9);
  const cut = (b: Bars, n: number): Bars => ({ t: b.t.slice(-n), o: b.o.slice(-n), h: b.h.slice(-n), l: b.l.slice(-n), c: b.c.slice(-n), v: b.v.slice(-n) });
  const check = (rule: string) => {
    const s = parsed(`universe: A\nbuy when ${rule}`);
    const full = specEvaluator(s, new Map([['A', A]]));
    const short = specEvaluator(s, new Map([['A', cut(A, 300)]]));
    return agrees(full, short, [s.rules.A.buy], 'A', (_, inCut) => (inCut ? 299 : 1499), null, null);
  };
  assert.equal(check('close > sma(50) and close > highest(20)[1] - 100'), true);
  assert.equal(check('close > sma(50) and rsi(2) > 0 - 1'), true);
  assert.equal(check('close > ema(50)'), false);
  assert.equal(check('close > sma(50) and ema(100) > 0'), false);
});

// ---------------------------------------------------------------- the search and the words

test('the search narrows each change down to within the precision, on the side where the outcome holds', () => {
  const stretches = search(50, 200, (x) => (x < 80 || x >= 120 ? 'fires' : 'none'));
  assert.deepEqual(stretches.map((s) => s.label), ['fires', 'none', 'fires']);
  const [a, b, c] = stretches;
  assert.deepEqual([a.from, c.to], [null, null]);
  assert.ok(a.to! < 80 && b.from! >= 80 && b.from! / a.to! - 1 <= PRECISION);
  assert.ok(b.to! < 120 && c.from! >= 120 && c.from! / b.to! - 1 <= PRECISION);
  assert.deepEqual(search(50, 200, () => 'none'), [{ label: 'none', from: null, to: null }]);
});

test('a rule\'s closes in words: above, below, between, unless, either side, and whatever the close', () => {
  const t = (fires: Trigger['fires']) => ({ fires, last: 100 });
  assert.equal(condition(t([{ lo: 102, hi: null }]), 'it'), 'if it closes above 102.00 (+2.0%)');
  assert.equal(condition(t([{ lo: 98, hi: null }]), 'it'), 'unless it closes below 98.00 (−2.0%)');
  assert.equal(condition(t([{ lo: null, hi: 97 }]), 'SPY'), 'if SPY closes below 97.00 (−3.0%)');
  assert.equal(condition(t([{ lo: null, hi: 101 }]), 'it'), 'unless it closes above 101.00 (+1.0%)');
  assert.equal(condition(t([{ lo: 98, hi: 99 }]), 'it'), 'if it closes between 98.00 (−2.0%) and 99.00 (−1.0%)');
  assert.equal(condition(t([{ lo: null, hi: 95 }, { lo: 105, hi: null }]), 'it'), 'if it closes below 95.00 (−5.0%) or above 105.00 (+5.0%)');
  assert.equal(condition(t([{ lo: null, hi: null }]), 'it'), 'whatever the next close');
  assert.equal(condition(t([]), 'it'), null);
  assert.equal(levelsSentence({ levels: { stop: 95, target: 110 }, ownLast: 100 }), 'The stop at 95.00 (−5.0%) and the target at 110.00 (+10.0%) sell during the bar if the price reaches them.');
  assert.equal(levelsSentence({ levels: { stop: null, target: 99 }, ownLast: 100 }), 'The target at 99.00 (−1.0%) is below the last close, so it sells at the next open unless the price opens below it.');
});

test('how near a rule is: the nearest price where it changes, and whether an unchanged close gives the order', () => {
  assert.deepEqual(nearest({ fires: [{ lo: 102, hi: null }], last: 100 }), { distance: 102 / 100 - 1, now: false });
  assert.deepEqual(nearest({ fires: [{ lo: null, hi: 99 }, { lo: 103, hi: null }], last: 100 }), { distance: 99 / 100 - 1, now: false });
  assert.deepEqual(nearest({ fires: [{ lo: 98, hi: null }], last: 100 }), { distance: 98 / 100 - 1, now: true });
  const whatever = nearest({ fires: [{ lo: null, hi: null }], last: 100 })!;
  assert.ok(Number.isNaN(whatever.distance) && whatever.now);
  assert.equal(nearest({ fires: [], last: 100 }), null);
});
