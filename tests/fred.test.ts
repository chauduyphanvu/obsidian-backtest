import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { barsFrom } from '../src/data.ts';
import { parseSpec } from '../src/dsl.ts';
import { BACKFILL, parseFred } from '../src/fred.ts';
import { sliceBars, type Bars } from '../src/types.ts';
import { bars, DAY, near, T0 } from './helpers.ts';

/** FRED's observations JSON as `output_type=4` answers, from [date, first published, value] rows. */
function fredJson(rows: [string, string, string][]): string {
  return JSON.stringify({
    realtime_start: '2024-01-01',
    realtime_end: '9999-12-31',
    output_type: 4,
    file_type: 'json',
    order_by: 'observation_date',
    sort_order: 'asc',
    count: rows.length,
    offset: 0,
    limit: 100000,
    observations: rows.map(([date, published, value]) => ({ realtime_start: published, realtime_end: published, date, value })),
  });
}

const utc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const day = (n: number) => T0 + n * DAY;

/** A series of values as fred.ts gives it: open, high, low and close the value, no volume. */
function values(times: number[], vs: number[]): Bars {
  return { t: times, o: vs, h: vs, l: vs, c: vs, v: vs.map(() => 0), values: true };
}

function run(src: string, data: Record<string, Bars>) {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  return runBacktest(spec!, new Map(Object.entries(data)));
}

// ------------------------------------------------------------------------------------------------ dating

test('a FRED series is dated by first publication, keeps zero and values below it, and leaves out missing ones', () => {
  const s = parseFred(
    fredJson([
      ['2024-01-02', '2024-01-03', '0.50'],
      ['2024-01-03', '2024-01-04', '.'],
      ['2024-01-04', '2024-01-05', '-0.25'],
      ['2024-01-05', '2024-01-08', '0'],
    ]),
    'T10Y2Y',
  );
  assert.deepEqual(s.bars.t.map(iso), ['2024-01-03', '2024-01-05', '2024-01-08']);
  assert.deepEqual(s.bars.c, [0.5, -0.25, 0]);
  for (const k of ['o', 'h', 'l'] as const) assert.deepEqual(s.bars[k], s.bars.c);
  assert.deepEqual(s.bars.v, [0, 0, 0]);
  assert.equal(s.bars.values, true);
  assert.equal(s.note, null);
});

test('a row comes only when a newer observation is published, so its time grows with every row', () => {
  const s = parseFred(
    fredJson([
      ['2024-01-01', '2024-02-09', '1'],
      // Two observations first published on one day: the row holds the newer one.
      ['2024-02-01', '2024-03-08', '2'],
      ['2024-03-01', '2024-03-08', '3'],
      // An older observation published after a newer one adds no row.
      ['2023-12-01', '2024-03-20', '9'],
      ['2024-04-01', '2024-05-10', '4'],
      // A later release of an observation already published is not its first.
      ['2024-04-01', '2024-06-07', '44'],
    ]),
    'X',
  );
  assert.deepEqual(s.bars.t.map(iso), ['2024-02-09', '2024-03-08', '2024-05-10']);
  assert.deepEqual(s.bars.c, [1, 3, 4]);
  for (let i = 1; i < s.bars.t.length; i++) assert.ok(s.bars.t[i] > s.bars.t[i - 1]);
});

test('the first release of an observation is kept, whichever order FRED lists its releases in', () => {
  const s = parseFred(fredJson([['2024-04-01', '2024-06-07', '44'], ['2024-04-01', '2024-05-10', '4']]), 'X');
  assert.deepEqual([s.bars.t.map(iso), s.bars.c], [['2024-05-10'], [4]]);
});

test('more than 5 values first published on one day are a backfill, dated by the median delay of the others', () => {
  assert.equal(BACKFILL, 5);
  const months = (from: number, n: number) => Array.from({ length: n }, (_, i) => iso(Date.UTC(2009, from + i, 1)));
  const backfill = months(0, 16).map((d): [string, string, string] => [d, '2010-05-03', '5']);
  const s = parseFred(
    fredJson([
      ...backfill,
      // Delays after the last day of the month: 11, 16 and 13 days, so 13.
      ['2010-05-01', '2010-06-11', '6'],
      ['2010-06-01', '2010-07-16', '7'],
      ['2010-07-01', '2010-08-13', '8'],
    ]),
    'UNRATE',
  );
  const t = s.bars.t.map(iso);
  assert.equal(t[0], '2009-02-13');
  assert.equal(t[t.indexOf('2010-04-13')], '2010-04-13');
  // April 2010's usual date, 13 May, is after the backfill came out: it is dated the day it was published.
  assert.deepEqual(t.slice(-4), ['2010-05-03', '2010-06-11', '2010-07-16', '2010-08-13']);
  assert.equal(t.length, 19);
  assert.equal(
    s.note,
    'FRED first published 16 values of UNRATE (dated 2009-01-01 to 2010-04-01) together on 2010-05-03, so each is dated 13 days after the last day of its period, the median delay of the values published later, and never later than it was published. They are the figures of that first release, which may already include later revisions: only the dates are estimates.',
  );
});

test('only the first day a series was published on can be a backfill: values published together later are dated the day they came out', () => {
  // ALFRED's first vintage, on Monday 5 January 2015, holds December 2014. After it, each week's seven values, Thursday
  // to Wednesday, come out together on the Monday after the week ends.
  const rows: [string, string, string][] = Array.from({ length: 31 }, (_, i) => [iso(Date.UTC(2014, 11, 1 + i)), '2015-01-05', '1']);
  const weeks = 6;
  for (let w = 0; w < weeks; w++) {
    const thursday = Date.UTC(2015, 0, 1 + 7 * w);
    for (let k = 0; k < 7; k++) rows.push([iso(thursday + k * DAY), iso(thursday + 11 * DAY), String(2 + w)]);
  }
  const s = parseFred(fredJson(rows), 'DFF');
  const t = s.bars.t.map(iso);
  // After the backfill, one row on each Monday a week came out, holding its Wednesday's value.
  const after = t.findIndex((d) => d > '2015-01-05');
  assert.deepEqual(t.slice(after), Array.from({ length: weeks }, (_, w) => iso(Date.UTC(2015, 0, 12 + 7 * w))));
  assert.deepEqual(s.bars.c.slice(after), Array.from({ length: weeks }, (_, w) => 2 + w));
  assert.ok(t.slice(0, after).every((d) => d <= '2015-01-05'));
  assert.equal(s.note?.startsWith('FRED first published 31 values of DFF (dated 2014-12-01 to 2014-12-31) together on 2015-01-05,'), true, s.note!);
});

test('exactly 5 values published on one day are taken as published', () => {
  const rows = Array.from({ length: BACKFILL }, (_, i): [string, string, string] => [iso(Date.UTC(2024, 0, 1 + i)), '2024-01-10', String(i)]);
  const s = parseFred(fredJson(rows), 'X');
  assert.deepEqual([s.bars.t.map(iso), s.bars.c, s.note], [['2024-01-10'], [4], null]);
  const more = parseFred(fredJson([...rows, ['2024-01-06', '2024-01-10', '5']]), 'X');
  assert.notEqual(more.note, null);
});

test('with no value published on its own, a backfill is dated a whole period after its period ends', () => {
  // Quarters, all published on 1 March 2002: each counts from the last day of the quarter after its own.
  const quarters = Array.from({ length: 8 }, (_, i): [string, string, string] => [iso(Date.UTC(2000, 3 * i, 1)), '2002-03-01', String(i)]);
  const s = parseFred(fredJson(quarters), 'GDP');
  assert.deepEqual(s.bars.t.map(iso), ['2000-06-30', '2000-09-30', '2000-12-31', '2001-03-31', '2001-06-30', '2001-09-30', '2001-12-31', '2002-03-01']);
  assert.match(s.note!, /dated 2000-01-01 to 2001-10-01\) together on 2002-03-01, so each is dated a quarter after its period ends, as no value published later shows the usual delay/);
  // A daily series' default is a day after, a weekly one's a week after the day its week ends.
  const daily = parseFred(fredJson(Array.from({ length: 6 }, (_, i): [string, string, string] => [iso(Date.UTC(2024, 0, 1 + i)), '2024-03-01', '1'])), 'D');
  assert.equal(iso(daily.bars.t[0]), '2024-01-02');
  assert.match(daily.note!, /a day after its period ends/);
});

test('a weekly series is dated by the day its week ends', () => {
  // Weeks ending on Saturdays, the later ones first published on the Thursday after.
  const saturdays = Array.from({ length: 9 }, (_, i) => iso(Date.UTC(2024, 0, 6 + 7 * i)));
  const rows: [string, string, string][] = saturdays.map((d, i) => [d, i < 6 ? '2024-02-12' : iso(utc(d) + 5 * DAY), String(i)]);
  const s = parseFred(fredJson(rows), 'ICSA');
  // The six weeks of the backfill are dated five days after they end, the delay the other three show, and the last one,
  // which that would put after the backfill came out, on the day it came out.
  assert.deepEqual(s.bars.t.slice(0, 6).map(iso), [...saturdays.slice(0, 5).map((d) => iso(utc(d) + 5 * DAY)), '2024-02-12']);
  assert.match(s.note!, /5 days after the last day of its period/);
});

test('a row without a publication day it can be read from has no date of its own, and is dated as a backfill is', () => {
  const s = parseFred(
    fredJson([
      ['2024-01-02', '', '1'],
      ['2024-01-03', '2024-01-04', '2'],
      ['2024-01-04', '2024-01-05', '3'],
    ]),
    'X',
  );
  // The other two are known a day after their date, so the first is too.
  assert.deepEqual(s.bars.t.map(iso), ['2024-01-03', '2024-01-04', '2024-01-05']);
  assert.match(s.note!, /FRED first published 1 value of X \(dated 2024-01-02\) together on a day FRED does not give/);
});

test('an answer with no observations is an error', () => {
  assert.throws(() => parseFred(JSON.stringify({ error_code: 400, error_message: 'Bad Request.  The series does not exist.' }), 'X'), /FRED sent no observations/);
});

test('cutting a series keeps it a series of values', () => {
  const f = values([day(0), day(5), day(9)], [1, -2, 0]);
  assert.equal(sliceBars(f, 1).values, true);
  assert.equal(barsFrom(f, day(5)).values, true);
  assert.equal(sliceBars(bars([1, 2, 3]), 1).values, undefined);
});

// ------------------------------------------------------------------------------------------------ the language

const errorsOf = (src: string) => parseSpec(src).errors.map((e) => e.message);

test('a FRED series can be read and be the cash rate, but cannot be traded or be the benchmark', () => {
  assert.deepEqual(errorsOf('universe: SPY, fred:T10Y2Y\nbuy when true'), [
    'fred:T10Y2Y is a series of values from FRED, not prices, so it cannot be traded. A rule can read it instead, as in close of fred:T10Y2Y > 0',
  ]);
  assert.deepEqual(errorsOf('symbol: fred:UNRATE\nbuy when true').slice(0, 1), [
    'fred:UNRATE is a series of values from FRED, not prices, so it cannot be traded. A rule can read it instead, as in close of fred:UNRATE > 0',
  ]);
  assert.deepEqual(errorsOf('universe: SPY\nbenchmark: fred:T10Y2Y\nbuy when true'), [
    'fred:T10Y2Y is a series of values from FRED, not prices, so it cannot be the benchmark. A rule can read it instead, as in close of fred:T10Y2Y > 0',
  ]);
  const { spec, errors, warnings } = parseSpec('universe: SPY\ncash rate: FRED:dgs3mo\nbuy when close of fred:T10Y2Y > 0 and sma(close, 3) of fred:T10Y2Y < 1');
  assert.deepEqual(errors, []);
  // A FRED value is not adjusted, so a fixed number gets no note.
  assert.deepEqual(warnings, []);
  assert.deepEqual(spec!.cash, { k: 'ticker', ref: { name: 'DGS3MO', source: 'fred', id: 'DGS3MO' } });
  assert.deepEqual(spec!.extras, [{ name: 'T10Y2Y', source: 'fred', id: 'T10Y2Y' }]);
});

test('a FRED series has rows of its own spacing, like a CSV file, so no interval is wrong for it', () => {
  assert.deepEqual(errorsOf('universe: binance:BTCUSDT\ninterval: 4h\nbuy when close of fred:T10Y2Y > 0'), []);
  assert.deepEqual(errorsOf('data: binance\nuniverse: BTCUSDT\ninterval: 15m\ncash rate: fred:DGS3MO\nbuy when true'), []);
});

test('a FRED series has no columns, and names its source when one is asked for', () => {
  assert.deepEqual(errorsOf('universe: SPY\nbuy when column(score) of fred:T10Y2Y > 0'), [
    'T10Y2Y comes from FRED, not from a CSV file, so it has no column called score. Name the file, as in column(score) of csv:Data/signals.csv',
  ]);
});

test('a bare name reads the FRED series the block names, and the same name from another source is a clash', () => {
  const { spec, errors } = parseSpec('universe: SPY\nbuy when close of fred:T10Y2Y > 0\nsell when close of t10y2y < 0');
  assert.deepEqual(errors, []);
  assert.equal(spec!.extras.length, 1);
  assert.match(errorsOf('universe: SPY\nbuy when close of fred:DGS10 > 0 and close of DGS10 > 0 and close of yahoo:DGS10 > 0')[0], /^DGS10 is used for two different things here: fred:DGS10 and yahoo:DGS10/);
});

// ------------------------------------------------------------------------------------------------ the engine

test('a FRED value counts from the end of the day it was first published, however far apart the rows are', () => {
  const A = bars(Array.from({ length: 70 }, () => 10));
  // A monthly series: a bar 25 days long would end a month after it starts, but a value is known at the end of its day.
  const F = values([day(10), day(35)], [-1, 1]);
  const r = run('universe: A\nbuy when close of fred:F > 0', { A, F });
  assert.equal(r.run.trades[0].entryT, day(36));
  // The same rows read as bars of prices would be known a month later.
  const late = run('universe: A\nbuy when close of csv:Data/F.csv > 0', { A, F: { ...F, values: undefined } });
  assert.ok(late.run.trades[0].entryT > day(60));
});

test('with fill: close, a FRED value published on a day is read from the next day, as it may come after the close', () => {
  const A = bars(Array.from({ length: 40 }, () => 10));
  const F = values([day(10), day(35)], [-1, 1]);
  const r = run('universe: A\nfill: close\nbuy when close of fred:F > 0', { A, F });
  assert.equal(r.run.trades[0].entryT, day(36));
  assert.equal(r.run.trades[0].entryPrice, 10);
  assert.ok(r.notes.some((n) => /a rule reads the previous bar of a ticker that keeps other hours/.test(n) && n.includes('F for A')));
});

test('a FRED yield as the cash rate pays from the day after it was published, not a month later', () => {
  const A = bars(Array.from({ length: 70 }, () => 10));
  const R = values([day(10), day(40)], [36.5, 73]);
  const r = run('universe: A\ncapital: 1000\ncash rate: fred:R\nbuy when false', { A, R });
  // Cash earns nothing until the end of day 10, then 36.5% a year until the end of day 40, then 73%.
  assert.equal(r.run.cashReturn[10], 0);
  assert.ok(near(r.run.cashReturn[11], 0.365 / 365) && near(r.run.cashReturn[40], 0.365 / 365));
  assert.ok(near(r.run.cashReturn[41], 0.73 / 365));
  assert.equal(r.cashRateNote, 'Cash earns the R rate');
  // The rows as bars of prices: the first is known when its 30-day bar ends, a month on.
  const bars30 = run('universe: A\ncapital: 1000\ncash rate: R\nbuy when false', { A, R: { ...R, values: undefined } });
  assert.equal(bars30.run.cashReturn[11], 0);
});

test('a FRED yield of zero pays nothing, and one below zero takes from cash', () => {
  const A = bars(Array.from({ length: 6 }, () => 10));
  const R = values([day(0), day(2)], [0, -36.5]);
  const r = run('universe: A\ncapital: 1000\ncash rate: fred:R\nbuy when false', { A, R });
  assert.equal(r.run.cashReturn[1], 0);
  assert.ok(near(r.run.cashReturn[3], -0.365 / 365));
  assert.ok(r.run.equity[5] < 1000);
});

test('functions that weigh by volume say a FRED series has none', () => {
  const A = bars(Array.from({ length: 30 }, () => 10));
  const F = values(Array.from({ length: 30 }, (_, i) => day(i)), Array.from({ length: 30 }, (_, i) => i));
  const { spec } = parseSpec('universe: A\nbuy when obv of fred:F > 0');
  assert.throws(() => runBacktest(spec!, new Map([['A', A], ['F', F]])), /^Error: F has no volume, which obv\(\) needs\. A FRED series and some indexes have none, and a CSV file needs a volume column\.$/);
  // Its values can be read through any function that reads a series.
  const r = run('universe: A\nbuy when sma(close, 5) of fred:F > 20 and highest(3) of fred:F > 21', { A, F });
  // Both first hold at the close of day 23, so the buy fills at the next open.
  assert.equal(r.run.trades[0].entryT, day(24));
});
