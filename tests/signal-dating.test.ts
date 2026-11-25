// When a row of a CSV file counts as known: the engine, the result's note and the helper window say the same thing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { inspectCsv, type CsvRead } from '../src/csv-import.ts';
import { parseCsv } from '../src/data.ts';
import { parseSpec } from '../src/dsl.ts';
import { specEvaluator } from '../src/evaluate.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY } from './helpers.ts';

const HOUR = 3_600_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const stamp = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
/** A stock's weekdays from Monday 1 January 2024. */
const weekdays = Array.from({ length: 420 }, (_, i) => Date.UTC(2024, 0, 1) + i * DAY).filter((t) => ![0, 6].includes(new Date(t).getUTCDay()));
const SPY = bars(weekdays.map((_, i) => 100 + Math.sin(i / 5)), { times: weekdays });

/** A file of signals with one row at each time, the score 1 on the row at `hot` and 0 elsewhere. */
const file = (times: number[], hot: number, show = iso) => ['date,score', ...times.map((t) => `${show(t)},${t === hot ? 1 : 0}`)].join('\n');

/** The first bar of `reader` at whose close `column(score) of sig` reads the hot row. */
function firstRead(text: string, reader: Bars = SPY, readerRef = 'SPY', extra = ''): number {
  const { spec, errors } = parseSpec(`universe: ${readerRef}\n${extra}buy when column(score) of csv:Data/sig.csv > 0.5`);
  assert.deepEqual(errors, []);
  const name = spec!.universe[0].name;
  const data = new Map<string, Bars>([[name, reader], ['sig', parseCsv(text)]]);
  const v = specEvaluator(spec!, data).series(spec!.rules[name].buy, name);
  return reader.t[v.indexOf(1)];
}

/** The first stock day on or after `t`. */
const onOrAfter = (t: number) => weekdays.find((d) => d >= t)!;

test('a row of a file of signals is read at the close of the day it is dated, however far apart its rows are', () => {
  const fridays = weekdays.filter((t) => new Date(t).getUTCDay() === 5).slice(0, 20);
  const months = Array.from({ length: 10 }, (_, m) => Date.UTC(2024, m, 15));
  const events = [Date.UTC(2024, 1, 5), Date.UTC(2024, 1, 8), Date.UTC(2024, 1, 13), Date.UTC(2024, 1, 20), Date.UTC(2024, 1, 26)];
  const cases: [string, number[], number][] = [
    ['daily', weekdays.slice(0, 60), weekdays[30]],
    ['weekly, dated Fridays', fridays, fridays[10]],
    // 15 June 2024 is a Saturday: it is read at the first close after it, Monday the 17th.
    ['monthly, dated the 15th', months, months[5]],
    ['irregular', events, events[2]],
    ['a single row', [Date.UTC(2024, 2, 6)], Date.UTC(2024, 2, 6)],
  ];
  for (const [what, times, hot] of cases) assert.equal(iso(firstRead(file(times, hot))), iso(onOrAfter(hot)), what);
  // So the order it gives fills at the next open; the row stays the latest one until the next row is known.
  const { spec } = parseSpec('universe: SPY\nbuy when column(score) of csv:Data/sig.csv > 0.5\nsell when column(score) of sig < 0.5');
  const bt = runBacktest(spec!, new Map<string, Bars>([['SPY', SPY], ['sig', parseCsv(file(fridays, fridays[10]))]]));
  assert.deepEqual(bt.run.trades.map((t) => [iso(t.why!.buyT), iso(t.entryT), iso(t.exitT)]), [[iso(fridays[10]), iso(onOrAfter(fridays[10] + DAY)), iso(onOrAfter(fridays[11] + DAY))]]);
});

test('with fill: close an order on another clock rests on the row before the one of its own day, and one note says so', () => {
  const hot = weekdays[20];
  const text = file(weekdays.slice(0, 60), hot);
  const results = ['next open', 'close'].map((fill) => {
    const { spec } = parseSpec(`universe: SPY\nfill: ${fill}\nbuy when column(score) of csv:Data/sig.csv > 0.5\nsell when bars held >= 1`);
    return runBacktest(spec!, new Map<string, Bars>([['SPY', SPY], ['sig', parseCsv(text)]]));
  });
  const [open, close] = results;
  assert.deepEqual(open.run.trades.map((t) => [iso(t.why!.buyT), iso(t.entryT)]), [[iso(hot), iso(weekdays[21])]]);
  // The row dated the 20th weekday is known at the end of that day, after the stock's close: the close of the next day uses it.
  assert.deepEqual(close.run.trades.map((t) => [iso(t.why!.buyT), iso(t.entryT)]), [[iso(weekdays[21]), iso(weekdays[21])]]);
  const about = (bt: typeof open) => bt.notes.filter((n) => n.includes('sig'));
  assert.deepEqual(about(open), [
    'A row of sig counts as known at the end of the day it is dated. Thus the date of each row must be the day of the close that its value comes from. A row with a date before the data that it comes from lets the rules see the future.',
  ]);
  assert.deepEqual(about(close), [
    `${about(open)[0]} With fill: close, a rule of SPY reads the last row of sig that ended before its bar started. It does not read the row of the same date, because the order fills at the close, before that row is known.`,
  ]);
  // A CSV ticker on the same days is on the same clock: it reads the row of its own day, and the note says what that assumes.
  const gold = bars(weekdays.map(() => 50), { times: weekdays });
  const { spec } = parseSpec('universe: csv:Data/gold.csv\nfill: close\nbuy when column(score) of csv:Data/sig.csv > 0.5\nsell when bars held >= 1');
  const same = runBacktest(spec!, new Map<string, Bars>([['gold', gold], ['sig', parseCsv(text)]]));
  assert.deepEqual(same.run.trades.map((t) => [iso(t.why!.buyT), iso(t.entryT)]), [[iso(hot), iso(hot)]]);
  assert.match(same.notes.find((n) => n.includes('sig'))!, /With fill: close, a rule of gold reads the row of sig of the same date\. The result counts that row as known at the time of the fill/);
});

test('a file of signals whose rows are less than a day apart: a row is known at its time plus the shortest gap, as a bar is', () => {
  const hours = Array.from({ length: 24 * 20 }, (_, i) => Date.UTC(2024, 0, 1) + i * HOUR);
  const btc = bars(hours.map((_, i) => 100 + Math.sin(i / 7)), { times: hours });
  const hot = hours[100];
  const text = file(hours.filter((_, i) => i % 4 === 0), hot, stamp);
  // Rows every 4 hours: the row of 04:00 holds what was worked out by 08:00, and an hourly rule reads it from the 07:00 bar.
  assert.equal(stamp(firstRead(text, btc, 'binance:BTCUSDT', 'interval: 1h\n')), stamp(hot + 3 * HOUR));
  const { spec } = parseSpec('universe: binance:BTCUSDT\ninterval: 1h\nbuy when column(score) of csv:Data/sig.csv > 0.5');
  const bt = runBacktest(spec!, new Map<string, Bars>([['BTCUSDT', btc], ['sig', parseCsv(text)]]));
  assert.ok(bt.notes.includes('A row of sig counts as known at its time plus 4 hours, the shortest gap between its rows. Thus the date of each row must be the start of the interval that its value comes from. A row with a date before the data that it comes from lets the rules see the future.'));
});

test('a file with prices is a file of bars: its weekly row, columns and all, is known when the week is over', () => {
  const mondays = weekdays.filter((t) => new Date(t).getUTCDay() === 1).slice(0, 12);
  const text = ['date,open,high,low,close,score', ...mondays.map((t, i) => `${iso(t)},10,11,9,10,${i === 4 ? 1 : 0}`)].join('\n');
  assert.equal(iso(firstRead(text)), iso(mondays[5]));
  const { spec } = parseSpec('universe: SPY\nbuy when column(score) of csv:Data/sig.csv > 0.5');
  const bt = runBacktest(spec!, new Map<string, Bars>([['SPY', SPY], ['sig', parseCsv(text)]]));
  assert.ok(bt.notes.includes('A row of sig counts as known when its bar ends, 7 days after the day it is dated. Thus a value in its columns must come from the close of that bar or before. A row with a date before the data that it comes from lets the rules see the future.'));
});

test('the helper window gives the same rule for the file it shows', () => {
  const read = (text: string) => inspectCsv(text) as CsvRead;
  const fridays = weekdays.filter((t) => new Date(t).getUTCDay() === 5).slice(0, 6);
  assert.equal(read(file(weekdays.slice(0, 6), 0)).dating, "A row counts as known at the end of the day it is dated. The gaps between the rows do not change this. Give each row the date of the close that you calculated its value from. For example, a rule on the close of Tuesday can use a row with the date of Tuesday. Its order fills at the open of Wednesday.");
  assert.equal(read(file(fridays, 0)).dating, read(file(weekdays.slice(0, 6), 0)).dating);
  assert.equal(read(file([Date.UTC(2024, 0, 2) + 9 * HOUR, Date.UTC(2024, 0, 2) + 10 * HOUR], 0, stamp)).dating, 'A row counts as known at its time plus 1 hour, the shortest gap between its rows. The date of each row must be the start of the interval that its value comes from.');
  const daily = ['date,open,high,low,close,score', ...weekdays.slice(0, 6).map((t) => `${iso(t)},10,11,9,10,1`)].join('\n');
  assert.equal(read(daily).dating, "A row counts as known at the end of the day it is dated. Give each row the date of the close that you calculated its value from. For example, a rule on the close of Tuesday can use a row with the date of Tuesday. Its order fills at the open of Wednesday.");
  const weekly = ['date,open,high,low,close,score', ...fridays.map((t) => `${iso(t)},10,11,9,10,1`)].join('\n');
  assert.equal(read(weekly).dating, "A row counts as known when its bar ends, 7 days after the day it is dated. A value in its columns must come from the close of that bar or before.");
});
