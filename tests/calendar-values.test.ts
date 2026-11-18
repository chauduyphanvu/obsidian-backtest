// The calendar values added after month and month_start: quarter, the start and end of a week, a quarter and a year,
// trading_day and trading_days_left. Hand-worked days, the same days counted with Date on random series, the rebalance's own
// week and period counts, the final bar's end, and the history trading_day needs at every bar size.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { complete } from '../src/complete.ts';
import type { DataDeps } from '../src/data.ts';
import { cellText, debugColumns, debugRange, debugRows } from '../src/debug.ts';
import { docFor } from '../src/docs.ts';
import { CALENDAR, RESERVED, parseSpec, type CalName, type Expr } from '../src/dsl.ts';
import { periodKey } from '../src/engine.ts';
import { Evaluator } from '../src/evaluate.ts';
import { explainTrade } from '../src/explain.ts';
import { fixFor } from '../src/fixes.ts';
import { tokenize } from '../src/highlight.ts';
import * as ind from '../src/indicators.ts';
import { lookbackBars, Runner } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY } from './helpers.ts';
import { rng } from './random-bars.ts';
import { head, tally, verify, walkBars } from './trigger-helpers.ts';

const HOUR = 3_600_000;
const N = NaN;
const cal = (name: CalName, t: number[]): number[] => new Evaluator(new Map([['A', bars(t.map(() => 10), { times: t })]])).eval({ k: 'cal', name } as Expr, 'A');
const utc = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);
const days = (from: number, count: number, weekends = false): number[] => {
  const out: number[] = [];
  for (let t = from; out.length < count; t += DAY) if (weekends || ![0, 6].includes(new Date(t).getUTCDay())) out.push(t);
  return out;
};

// ---------------------------------------------------------------- the names

test('the new calendar values are in the language, and the conditions among them are conditions', () => {
  const names = ['quarter', 'week_start', 'week_end', 'quarter_start', 'quarter_end', 'year_start', 'year_end', 'trading_day', 'trading_days_left'];
  for (const name of names) assert.ok((CALENDAR as string[]).includes(name), name);
  const conditions = ['week_start', 'week_end', 'quarter_start', 'quarter_end', 'year_start', 'year_end'];
  for (const name of conditions) {
    assert.deepEqual(parseSpec(`universe: A\nbuy when ${name}\nsell when not ${name}`).errors, [], name);
    assert.deepEqual(parseSpec(`universe: A\nbuy when ${name} and close > sma(5) or month_end`).errors, [], name);
    assert.match(parseSpec(`universe: A\nbuy when ${name} > 0`).errors[0].message, /A comparison needs a number, not a condition/, name);
  }
  for (const name of ['quarter', 'trading_day', 'trading_days_left']) {
    assert.deepEqual(parseSpec(`universe: A\nbuy when ${name} == 3 and close > sma(5)`).errors, [], name);
    assert.match(parseSpec(`universe: A\nbuy when ${name}`).errors[0].message, /A rule needs a condition/, name);
  }
  // A parameter can't take one of their names.
  for (const name of names) {
    assert.match(parseSpec(`universe: A\n${name} = 3\nbuy when true`).errors[0]?.message ?? '', /is a built-in name/, name);
    assert.ok(RESERVED.has(name), name);
  }
});

test('quarter is 1 to 4 from the month of the bar', () => {
  const t = [utc(2024, 1, 31), utc(2024, 3, 31), utc(2024, 4, 1), utc(2024, 6, 30), utc(2024, 7, 1), utc(2024, 9, 30), utc(2024, 10, 1), utc(2024, 12, 31)];
  assert.deepEqual(cal('quarter', t), [1, 1, 2, 2, 3, 3, 4, 4]);
});

// ---------------------------------------------------------------- weeks, quarters and years

test('week_start and week_end follow Monday to Sunday, the first bar of the data is not known to start one, and the last bar knows its end', () => {
  // Wednesday 2024-01-03 to Tuesday 2024-01-16 on weekdays.
  const t = days(utc(2024, 1, 3), 10);
  assert.deepEqual(t.map((x) => new Date(x).toISOString().slice(5, 10)), ['01-03', '01-04', '01-05', '01-08', '01-09', '01-10', '01-11', '01-12', '01-15', '01-16']);
  assert.deepEqual(cal('week_start', t), [N, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  // The Friday ends its week (the next bar is the Monday); the last bar, a Tuesday, is followed by a Wednesday of the same week.
  assert.deepEqual(cal('week_end', t), [0, 0, 1, 0, 0, 0, 0, 1, 0, 0]);
  // The data ending on a Friday: the next bar the calendar expects is the Monday, so that Friday ends its week.
  assert.equal(cal('week_end', t.slice(0, 8)).at(-1), 1);
  // With weekend bars (Friday 2024-01-05 to Monday the 8th) the week ends on the Sunday, and the Monday, as the last bar, is followed by a Tuesday.
  const all = days(utc(2024, 1, 5), 4, true);
  assert.deepEqual(cal('week_end', all), [0, 0, 1, 0]);
  // The Sunday as the last bar: the next bar expected is the Monday.
  assert.deepEqual(cal('week_end', all.slice(0, 3)), [0, 0, 1]);
  // The Saturday as the last bar: the next is the Sunday, the same week.
  assert.deepEqual(cal('week_end', all.slice(0, 2)), [0, 0]);
});

test('quarter and year boundaries: the last bar before the next period is its end, and the data ending on one knows it', () => {
  // 2023-12-28 (Thu) to 2024-01-04 (Thu), weekdays: Dec 28, 29, Jan 1 (a bar, though a holiday), 2, 3, 4.
  const t = days(utc(2023, 12, 28), 6);
  assert.deepEqual(cal('year_start', t), [N, 0, 1, 0, 0, 0]);
  assert.deepEqual(cal('year_end', t), [0, 1, 0, 0, 0, 0]);
  assert.deepEqual(cal('quarter_start', t), [N, 0, 1, 0, 0, 0]);
  assert.deepEqual(cal('quarter_end', t), [0, 1, 0, 0, 0, 0]);
  // Friday 2023-12-29 as the last bar: the next bar expected is Monday January 1, a new year and quarter.
  assert.equal(cal('year_end', t.slice(0, 2)).at(-1), 1);
  assert.equal(cal('quarter_end', t.slice(0, 2)).at(-1), 1);
  // Thursday 2023-12-28 as the last: the next is Friday the 29th, still the same year.
  assert.equal(cal('year_end', t.slice(0, 1)).at(-1), 0);
  // A quarter ends at March, June, September and December, a year at December.
  const ends = [utc(2024, 3, 29), utc(2024, 4, 1), utc(2024, 6, 28), utc(2024, 7, 1), utc(2024, 9, 30), utc(2024, 10, 1), utc(2024, 12, 31), utc(2025, 1, 2)];
  assert.deepEqual(cal('quarter_end', ends), [1, 0, 1, 0, 1, 0, 1, 0]);
  assert.deepEqual(cal('quarter_start', ends), [N, 1, 0, 1, 0, 1, 0, 1]);
  assert.deepEqual(cal('year_end', ends), [0, 0, 0, 0, 0, 0, 1, 0]);
});

/** A series on a calendar: bars on weekdays (or every day), each dropped with probability `drop`, from `from`. */
function series(seed: number, from: number, count: number, o: { weekends?: boolean; drop?: number; hours?: number[] } = {}): number[] {
  const u = rng(seed);
  const out: number[] = [];
  for (let day = from; out.length < count; day += DAY) {
    if (!o.weekends && [0, 6].includes(new Date(day).getUTCDay())) continue;
    if (u() < (o.drop ?? 0)) continue;
    for (const h of o.hours ?? [0]) out.push(day + h * HOUR);
  }
  return out;
}

/** The week, month, quarter and year of a time worked out with Date, as text that changes when the period does. */
const keyOf = {
  week: (t: number) => {
    const d = new Date(t);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7))).toISOString().slice(0, 10);
  },
  month: (t: number) => new Date(t).toISOString().slice(0, 7),
  quarter: (t: number) => `${new Date(t).getUTCFullYear()}-Q${Math.floor(new Date(t).getUTCMonth() / 3) + 1}`,
  year: (t: number) => String(new Date(t).getUTCFullYear()),
};

/** Where the next bar of a series is expected: one smallest gap on, skipping Saturday and Sunday unless the series has bars on them. */
function expectedNext(t: number[]): number {
  let gap = Infinity;
  for (let i = 1; i < t.length; i++) gap = Math.min(gap, t[i] - t[i - 1]);
  const weekends = t.some((x) => [0, 6].includes(new Date(x).getUTCDay()));
  let next = t[t.length - 1] + gap;
  while (!weekends && [0, 6].includes(new Date(next).getUTCDay())) next += DAY;
  return next;
}

const SERIES: [string, number[]][] = [
  ['weekdays', series(1, utc(2019, 11, 20), 900)],
  ['weekdays with holidays', series(2, utc(2020, 2, 15), 900, { drop: 0.06 })],
  ['every day', series(3, utc(2021, 6, 10), 1000, { weekends: true })],
  ['every day with gaps', series(4, utc(2018, 1, 1), 800, { weekends: true, drop: 0.1 })],
  ['hourly on weekdays', series(5, utc(2022, 3, 9), 1800, { hours: [14, 15, 16, 17, 18, 19, 20] })],
];

test('week, quarter and year starts and ends equal the same periods worked out with Date, on every kind of calendar', () => {
  for (const [label, t] of SERIES) {
    for (const [period, key] of Object.entries(keyOf) as [keyof typeof keyOf, (t: number) => string][]) {
      if (period === 'month') continue;
      const [start, end] = [cal(`${period}_start` as CalName, t), cal(`${period}_end` as CalName, t)];
      const next = expectedNext(t);
      t.forEach((x, i) => {
        assert.equal(start[i], i === 0 ? N : key(x) !== key(t[i - 1]) ? 1 : 0, `${label}: ${period}_start at ${new Date(x).toISOString()}`);
        const after = i + 1 < t.length ? t[i + 1] : next;
        assert.equal(end[i], key(after) !== key(x) ? 1 : 0, `${label}: ${period}_end at ${new Date(x).toISOString()}`);
      });
      // Some of each, or the check checks nothing (a year changes once in the shorter series).
      const most = period === 'year' ? 1 : 2;
      assert.ok(start.filter((v) => v === 1).length >= most && end.filter((v) => v === 1).length >= most, `${label} ${period}`);
    }
  }
});

test('a week_start is where `rebalance: weekly` starts a week, a quarter_start where quarterly does, and a year_start where yearly does', () => {
  for (const [label, t] of SERIES) {
    for (const [period, mode] of [['week', 'weekly'], ['quarter', 'quarterly'], ['year', 'yearly']] as const) {
      const start = cal(`${period}_start` as CalName, t);
      t.forEach((x, i) => assert.equal(start[i], i === 0 ? N : periodKey(x, mode) !== periodKey(t[i - 1], mode) ? 1 : 0, `${label}: ${period} at ${new Date(x).toISOString()}`));
    }
  }
});

// ---------------------------------------------------------------- trading_day and trading_days_left

test('trading_day and trading_days_left worked by hand: days that have a bar, unknown through the first month, and the days still to come past the last bar', () => {
  // Weekdays from Friday 2024-01-26: January's 26, 29, 30, 31, then February from the 1st. The data ends on Thursday February 8.
  const t = days(utc(2024, 1, 26), 11);
  assert.equal(new Date(t[10]).toISOString().slice(0, 10), '2024-02-09');
  const first = t.slice(0, 10);
  assert.deepEqual(first.map((x) => new Date(x).toISOString().slice(5, 10)), ['01-26', '01-29', '01-30', '01-31', '02-01', '02-02', '02-05', '02-06', '02-07', '02-08']);
  // January is the data's first month, which may have begun earlier: unknown. February's days are 1, 2, 5, 6, 7, 8 the 1st to the 6th.
  assert.deepEqual(ind.tradingDay(first), [N, N, N, N, 1, 2, 3, 4, 5, 6]);
  // January: the bars after 01-26 are 3 days, then 2, 1, 0. February 2024 has 21 weekdays (the 29th is a Thursday), so after the 8th there are
  // the 9th, 12th to 16th, 19th to 23rd and 26th to 29th: 1 + 5 + 5 + 4 = 15. Nothing tells the calendar that Presidents' Day is a holiday.
  assert.deepEqual(ind.tradingDaysLeft(first), [3, 2, 1, 0, 20, 19, 18, 17, 16, 15]);
  // With the 9th also there, the 8th has 15 still, but the 9th has 14.
  assert.deepEqual(ind.tradingDaysLeft(t).slice(-2), [15, 14]);
});

test('trading_day counts days, not bars: every bar of an hourly day has the same number', () => {
  // Bars at 14:00, 15:00 and 16:00 on 7 weekdays: February 26, 27, 28 and 29, March 1, 4 and 5 (2024). A January bar before them makes February's days known.
  const t = series(1, utc(2024, 2, 26), 21, { hours: [14, 15, 16] });
  assert.equal(new Date(t[20]).toISOString().slice(0, 10), '2024-03-05');
  assert.deepEqual(ind.tradingDay([utc(2024, 1, 30), ...t]).slice(1), [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
  // February's bars see the days still to come in the data: 3, 2, 1, 0. March 1 has the 4th and 5th in the data and then the weekdays the data would go on to have after
  // the 5th: the 6th to 8th, 11th to 15th, 18th to 22nd and 25th to 29th, 18 days, so 20, and the 4th and 5th have 19 and 18.
  assert.deepEqual(ind.tradingDaysLeft(t), [3, 3, 3, 2, 2, 2, 1, 1, 1, 0, 0, 0, 20, 20, 20, 19, 19, 19, 18, 18, 18]);
});

/** The days a series has, by month, counted from the dates alone, as the language defines trading_day. */
function naiveDays(t: number[]): { day: number[]; left: number[] } {
  const monthOf = t.map(keyOf.month);
  const dayOf = t.map((x) => new Date(x).toISOString().slice(0, 10));
  const day = t.map((_, i) => (monthOf[i] === monthOf[0] ? N : new Set(dayOf.filter((_, j) => j <= i && monthOf[j] === monthOf[i])).size));
  const weekends = t.some((x) => [0, 6].includes(new Date(x).getUTCDay()));
  const last = t.length - 1;
  // The days still to come in the last month: every day after the last bar's day, but for Saturday and Sunday on a series that has none.
  let ahead = 0;
  for (let d = Math.floor(t[last] / DAY) * DAY + DAY; keyOf.month(d) === monthOf[last]; d += DAY) if (weekends || ![0, 6].includes(new Date(d).getUTCDay())) ahead++;
  const left = t.map((_, i) => {
    const later = new Set(dayOf.filter((_, j) => j > i && monthOf[j] === monthOf[i] && dayOf[j] !== dayOf[i]));
    return later.size + (monthOf[i] === monthOf[last] ? ahead : 0);
  });
  return { day, left };
}

test('trading_day and trading_days_left equal the days counted from the dates, on every kind of calendar', () => {
  for (const [label, t] of SERIES) {
    const [mine, naive] = [{ day: ind.tradingDay(t), left: ind.tradingDaysLeft(t) }, naiveDays(t)];
    assert.deepEqual(mine.day, naive.day, `${label}: trading_day`);
    assert.deepEqual(mine.left, naive.left, `${label}: trading_days_left`);
    assert.ok(mine.day.filter((v) => v === 1).length >= 5, label);
    assert.ok(mine.left.filter((v) => v === 0).length >= 5, label);
  }
});

test('the series ends in the middle of its month in as many ways as it can: the last day of any length of data counts the days to come', () => {
  const full = series(9, utc(2023, 10, 20), 400, { drop: 0.05 });
  for (let end = 60; end < full.length; end += 7) {
    const t = full.slice(0, end);
    assert.deepEqual(ind.tradingDaysLeft(t), naiveDays(t).left, `ending at ${new Date(t[t.length - 1]).toISOString()}`);
  }
});

test('a month_end that holds is a trading_days_left of 0 on a daily series, and trading_day 1 follows month_start', () => {
  for (const [label, t] of SERIES.slice(0, 4)) {
    const [left, day, end, start] = [ind.tradingDaysLeft(t), ind.tradingDay(t), cal('month_end', t), cal('month_start', t)];
    t.forEach((_, i) => {
      assert.equal(end[i] === 1, left[i] === 0, `${label} bar ${i}: month_end and trading_days_left`);
      if (!Number.isNaN(day[i])) assert.equal(start[i] === 1, day[i] === 1, `${label} bar ${i}: month_start and trading_day`);
    });
  }
});

test('a week of 7-day bars and a daily series with a bar missing: the days counted are the days with a bar', () => {
  // Weekly bars on Mondays: the days in a month are its Mondays.
  const weekly = Array.from({ length: 12 }, (_, i) => utc(2024, 1, 1) + i * 7 * DAY);
  assert.deepEqual(ind.tradingDay(weekly).slice(5), [1, 2, 3, 4, 1, 2, 3]);
  // The last weekly bar is Monday March 18; the bar after it, a week on, is the 25th, still in March. March 4 has the 11th, 18th and 25th still to come.
  assert.deepEqual(ind.tradingDaysLeft(weekly).slice(-3), [3, 2, 1]);
  // 2024-02-05 to 2024-02-09 with Wednesday missing: the 5th, 6th, 8th and 9th.
  const missing = [utc(2024, 1, 31), utc(2024, 2, 1), utc(2024, 2, 2), utc(2024, 2, 5), utc(2024, 2, 6), utc(2024, 2, 8), utc(2024, 2, 9)];
  assert.deepEqual(ind.tradingDay(missing), [N, 1, 2, 3, 4, 5, 6]);
});

test('an empty series, a single bar and repeated times do not hang or throw', () => {
  assert.deepEqual(ind.tradingDay([]), []);
  assert.deepEqual(ind.tradingDaysLeft([]), []);
  assert.deepEqual(ind.tradingDay([utc(2024, 3, 12)]), [N]);
  // One bar: the next one is the next weekday, so the days to come are the rest of March 2024's weekdays after the 12th (13 to 29: 13 of them).
  assert.deepEqual(ind.tradingDaysLeft([utc(2024, 3, 12)]), [13]);
  const repeated = [utc(2024, 3, 11), utc(2024, 3, 12), utc(2024, 3, 12)];
  assert.equal(ind.tradingDaysLeft(repeated).length, 3);
});

test('a strategy for the turn of the month runs: the day with 3 days left to the third day of the next month', () => {
  const t = days(utc(2023, 11, 1), 400);
  const closes = t.map((_, i) => 100 + i * 0.1);
  const { spec, errors } = parseSpec('universe: A\ncapital: 10000\nbuy when trading_days_left == 3\nsell when trading_day == 3');
  assert.deepEqual(errors, []);
  const bt = runBacktest(spec!, new Map([['A', bars(closes, { times: t })]]));
  assert.ok(bt.run.trades.length >= 12, String(bt.run.trades.length));
  const day = new Date(bt.run.trades[3].entryT).toISOString().slice(0, 10);
  // The order is read at the close of the day with 3 days left and fills at the next open, on the day with 2 left; the exit is read on the third day and fills on the fourth.
  const [left, tradingDay] = [ind.tradingDaysLeft(t), ind.tradingDay(t)];
  assert.equal(left[t.indexOf(bt.run.trades[3].entryT) - 1], 3, day);
  assert.equal(tradingDay[t.indexOf(bt.run.trades[3].exitT) - 1], 3, day);
});

// ---------------------------------------------------------------- the history trading_day needs, at every bar size

const lookback = (rule: string, interval: string) => lookbackBars(parseSpec(`universe: BTCUSDT\ndata: binance\ninterval: ${interval}\nbuy when ${rule}`).spec!);

test('lookbackBars reaches back 38 days for trading_day at any bar size, and reads nothing for the rest of the calendar', () => {
  // As many bars as 38 days hold, and at least the usual 250: with bars of a day or more the loader reaches 1.6 times as far, and 4-hour bars need 228.
  assert.equal(lookback('trading_day == 1', '1m'), 38 * 1440);
  assert.equal(lookback('trading_day == 1', '15m'), 38 * 96);
  assert.equal(lookback('trading_day == 1', '1h'), 38 * 24);
  assert.equal(lookback('trading_day == 1', '4h'), 250);
  assert.equal(lookback('trading_day == 1', '1d'), 250);
  assert.equal(lookback('trading_day == 1', '1w'), 250);
  // Nested windows and lags add to it.
  assert.equal(lookback('sma(trading_day, 20) > 5', '1h'), 38 * 24 + 20);
  assert.equal(lookback('trading_day[5] == 1', '1h'), 38 * 24 + 5);
  assert.equal(lookback('trading_day[5] == 1', '1d'), 250);
  // The other new calendar values need none, or one bar for a start.
  for (const rule of ['quarter == 4', 'trading_days_left == 3', 'week_end', 'quarter_end', 'year_end', 'month_end']) assert.equal(lookback(rule, '1m'), 250, rule);
  for (const rule of ['week_start', 'quarter_start', 'year_start', 'month_start']) assert.equal(lookback(rule, '1m'), 250, rule);
  assert.equal(lookback('close[5] > 1 and week_start', '1d'), 250);
});

/** Binance klines of any size from `first`, served page by page, with a cache in memory. */
function exchange(step: number, first: number, count: number): DataDeps {
  const rows: unknown[][] = [];
  let p = 100;
  for (let i = 0; i < count; i++) {
    const c = p * (1 + Math.sin(i / 11) * 0.004);
    rows.push([first + i * step, String(p), String(Math.max(p, c) * 1.001), String(Math.min(p, c) * 0.999), String(c), '1', first + (i + 1) * step - 1]);
    p = c;
  }
  const store = new Map<string, string>();
  return {
    fetchText: async (url) => {
      const start = Number(new URL(url).searchParams.get('startTime'));
      return JSON.stringify(rows.filter((r) => (r[0] as number) >= start).slice(0, 1000));
    },
    readVaultFile: async () => null,
    cacheRead: async (k) => store.get(k) ?? null,
    cacheWrite: async (k, v) => void store.set(k, v),
    now: () => first + count * step,
  };
}

test('trading_day is known at the first bar of a run at every bar size, and is the day of the month there', async () => {
  const sizes: [string, number][] = [['1m', 60_000], ['5m', 300_000], ['15m', 900_000], ['1h', HOUR], ['4h', 4 * HOUR], ['1d', DAY], ['1w', 7 * DAY]];
  for (const [interval, step] of sizes) {
    // Bars from the start of March to the end of August, so a run from July or the start of August has the data's first month well behind it.
    const first = utc(2023, 3, 1);
    const count = Math.ceil((utc(2023, 8, 30) - first) / step);
    for (const from of ['2023-07-20', '2023-07-31', '2023-08-01', '2023-08-02']) {
      const runner = new Runner(exchange(step, first, count));
      const { spec, errors } = parseSpec(`universe: BTCUSDT\ndata: binance\ninterval: ${interval}\nfrom: ${from}\nbuy when trading_day == 3\nsell when trading_day == 5`);
      assert.deepEqual(errors, []);
      const out = await runner.run(spec!);
      const data = out.data.get('BTCUSDT')!;
      const at = out.backtest.run.t[0];
      const known = new Evaluator(out.data).eval({ k: 'cal', name: 'trading_day' }, 'BTCUSDT')[data.t.indexOf(at)];
      const tag = `${interval} from ${from}`;
      // The loader's own reach: lookback bars, 1.6 times as far for bars of a day or more.
      assert.ok(at - data.t[0] >= 38 * DAY - step, `${tag}: the data starts ${(at - data.t[0]) / DAY} days before the run`);
      assert.ok(!Number.isNaN(known), `${tag}: trading_day is unknown at the run's first bar`);
      // Crypto trades every day, so the day of the month is the number of days with a bar; a weekly bar's is the number of its week's bars so far.
      const expected = interval === '1w' ? Math.floor((new Date(at).getUTCDate() - 1) / 7) + 1 : new Date(at).getUTCDate();
      assert.equal(known, expected, tag);
    }
  }
});

test('trading_day is known from the first bar of a run on weekday bars too, the way a Yahoo ticker has them', () => {
  // Weekdays only, loaded the way the Runner loads them: from `from` less the lookback, the day-or-longer bars reaching 1.6 times as far.
  const t = days(utc(2022, 1, 3), 900);
  const spec = parseSpec('universe: A\nfrom: 2023-01-02\nbuy when trading_day == 3').spec!;
  const reach = Math.ceil(lookbackBars(spec) * 1.6) * DAY;
  for (let from = utc(2022, 9, 1); from < utc(2023, 8, 1); from += 9 * DAY) {
    const data = t.filter((x) => x >= from - reach);
    const run = data.findIndex((x) => x >= from);
    const value = ind.tradingDay(data)[run];
    const wanted = ind.tradingDay(t)[t.indexOf(data[run])];
    assert.ok(!Number.isNaN(value), `from ${new Date(from).toISOString()}: unknown`);
    assert.equal(value, wanted, `from ${new Date(from).toISOString()}`);
  }
});

test('quarter, the starts and trading_day read no later bar: the first k values do not change with the bars after them', () => {
  const t = series(7, utc(2023, 1, 2), 500, { drop: 0.04 });
  const names: CalName[] = ['quarter', 'week_start', 'quarter_start', 'year_start', 'month_start', 'trading_day'];
  for (const name of names) {
    const whole = cal(name, t);
    for (const k of [1, 2, 5, 20, 63, 64, 200, 499]) assert.deepEqual(cal(name, t.slice(0, k)), whole.slice(0, k), `${name}: the first ${k} values depend on later bars`);
  }
});

test('the ends and trading_days_left read the dates of later bars, as month_end does, and no price: a bar whose month or period is over has the same value however the data is cut after it', () => {
  const t = series(7, utc(2023, 1, 2), 500, { drop: 0.04 });
  for (const name of ['week_end', 'quarter_end', 'year_end', 'month_end'] as CalName[]) {
    const whole = cal(name, t);
    // Every bar but the last is followed by a bar of the data.
    for (const k of [20, 63, 64, 200, 499]) assert.deepEqual(cal(name, t.slice(0, k)).slice(0, k - 1), whole.slice(0, k - 1), `${name} at ${k}`);
  }
  // trading_days_left needs the rest of the bar's month: cut at the first bar of a month, every earlier month is whole.
  const whole = cal('trading_days_left', t);
  const firsts = t.flatMap((x, i) => (i > 1 && keyOf.month(x) !== keyOf.month(t[i - 1]) ? [i + 1] : []));
  assert.ok(firsts.length >= 10);
  for (const k of firsts) assert.deepEqual(cal('trading_days_left', t.slice(0, k)).slice(0, k - 1), whole.slice(0, k - 1), `trading_days_left at ${k}`);
});

test('a gap across a month end: the days still to come are counted from the last bar, and its quarter is its month\'s', () => {
  const b: Bars = bars([1, 2, 3], { times: [utc(2024, 5, 30), utc(2024, 5, 31), utc(2024, 6, 3)] });
  const ev = new Evaluator(new Map([['A', b]]));
  assert.deepEqual(ev.eval({ k: 'cal', name: 'month_end' }, 'A'), [0, 1, 0]);
  assert.deepEqual(ev.eval({ k: 'cal', name: 'quarter' }, 'A'), [2, 2, 2]);
  assert.deepEqual(ev.eval({ k: 'cal', name: 'trading_days_left' }, 'A'), [1, 0, 19]);
});

// ---------------------------------------------------------------- how they look in the editor, in an explanation and in the table

const NEW_WORDS = ['quarter', 'week_start', 'week_end', 'quarter_start', 'quarter_end', 'year_start', 'year_end', 'trading_day', 'trading_days_left'];

test('the calendar values are coloured and completed like the ones before them, and have help', () => {
  const kindOf = (word: string) => tokenize(`buy when ${word} == 3`, 'rule').find((t) => `buy when ${word} == 3`.slice(t.from, t.to) === word)!.kind;
  for (const word of NEW_WORDS) {
    assert.equal(kindOf(word), kindOf('month_start'), word);
    assert.ok(complete([], [], `buy when ${word.slice(0, 4)}`)!.items.some((i) => i.label === word), word);
    assert.equal(docFor(word)!.kind, 'calendar', word);
    assert.match(docFor(word)!.text, /read from each bar’s date in UTC/, word);
  }
  assert.equal(docFor('trading_days_left')!.signature, 'trading_days_left');
  assert.match(docFor('trading_day')!.text, /1 on the month’s first such day/);
});

test('a misspelt calendar word is corrected to the right one', () => {
  const fixed = (line: string) => {
    const lines = ['universe: SPY', line];
    const d = parseSpec(lines.join('\n')).errors[0];
    const fix = fixFor(lines, d);
    assert.ok(fix, `no fix for ${line}`);
    return line.slice(0, fix.from) + fix.insert + line.slice(fix.to);
  };
  assert.equal(fixed('buy when trading_dya == 3'), 'buy when trading_day == 3');
  assert.equal(fixed('buy when quater == 4'), 'buy when quarter == 4');
  assert.equal(fixed('buy when weeek_start'), 'buy when week_start');
  assert.equal(fixed('buy when trading_days_lft == 3'), 'buy when trading_days_left == 3');
});

function run(src: string, data: Record<string, Bars>): Backtest {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, [], src);
  return runBacktest(spec!, new Map(Object.entries(data)));
}

test('an explanation gives the number of the day and the days left, and the bar-by-bar table says why they are unknown', () => {
  const t = days(utc(2023, 11, 1), 300);
  const closes = t.map((_, i) => 100 + Math.sin(i / 7) * 5 + i * 0.05);
  const bt = run('universe: A\nbuy when trading_days_left <= 3 and close > sma(5)\nsell when trading_day == 3 or quarter == 4 and week_end', { A: bars(closes, { times: t }) });
  assert.ok(bt.run.trades.length > 3);
  const ex = explainTrade(bt, bt.run.trades[1]);
  const rows = (id: string) => ex.sections.find((s) => s.id === id)!.rows.filter((r) => r.code);
  assert.match(rows('bought').find((r) => r.label === 'trading_days_left <= 3')!.value, /^trading_days_left [0-3] ≤ 3$/);
  assert.equal(rows('bought').find((r) => r.label === 'trading_days_left <= 3')!.outcome, 'yes');
  assert.match(rows('sold').find((r) => r.label === 'trading_day == 3')!.value, /^trading_day [0-9]+ = 3$/);
  const details = (b: Backtest, i: number) => {
    const row = debugRows(b, 'A', 0, debugRange(b, 'A').count)[i];
    return Object.fromEntries(debugColumns(b, 'A').map((c, n) => [c.text, cellText(c, row.cells[n]).detail]));
  };
  const first = run('universe: A\nbuy when week_start and trading_day == 3\nsell when close < 0', { A: bars(closes, { times: t }) });
  assert.equal(details(first, 0)['week_start'], "it is the data's first bar");
  assert.equal(details(first, 0)['trading_day == 3'], "its month began before the data's first bar");
  assert.equal(details(first, 100)['trading_day == 3'], '');
});

test('trigger prices for rules on the calendar agree with the engine, tried where the next bar is one the rule holds on', () => {
  const A = walkBars(700, 1);
  const left = ind.tradingDaysLeft(A.t);
  const mondays = A.t.map((_, i) => i).filter((i) => i >= 430 && new Date(A.t[i]).getUTCDay() === 1);
  const rules: [string, number[]][] = [
    ['buy when trading_days_left == 3 and close > sma(20)\nsell when trading_day == 3', A.t.map((_, i) => i).filter((i) => i >= 430 && left[i] === 3)],
    ['buy when week_start and close > sma(20)\nsell when week_end or quarter_end', mondays.slice(0, 12)],
  ];
  const seen = tally();
  for (const [k, [body, cuts]] of rules.entries()) {
    const src = `universe: A\n${body}`;
    const { spec, errors } = parseSpec(src);
    assert.deepEqual(errors, [], src);
    assert.ok(cuts.length >= 8);
    for (const cut of cuts) verify(spec!, new Map([['A', head(A, cut)]]), `rule ${k}, ${cut} bars:\n${src}\n`, seen);
  }
  assert.ok(seen.buy >= 10, JSON.stringify(seen));
});
