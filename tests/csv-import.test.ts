import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { CSV_HEADERS, parseCsv } from '../src/data.ts';
import { parseSpec } from '../src/dsl.ts';
import { cleanedPath, csvStrategy, csvTicker, dateOrderIsAmbiguous, dateSeparator, inspectCsv, remapCsv, type CsvCleaned, type CsvMapping, type CsvRead, type CsvUnread } from '../src/csv-import.ts';
import { DAY } from './helpers.ts';

const d = (y: number, m: number, day: number) => Date.UTC(y, m - 1, day);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Business days from 2024-01-02, with prices that wander. */
type Day = { t: number; o: number; h: number; l: number; c: number; v: number };

function days(n: number, start = d(2024, 1, 2)): Day[] {
  const out: Day[] = [];
  let price = 472.65;
  for (let t = start; out.length < n; t += DAY) {
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const i = out.length;
    const o = Number((price + 0.12 * Math.sin(i)).toFixed(2));
    price = Number((price + 0.9 * Math.sin(i / 3) + 0.15).toFixed(2));
    out.push({ t, o, h: Number((Math.max(o, price) + 1.1).toFixed(2)), l: Number((Math.min(o, price) - 0.9).toFixed(2)), c: price, v: 80_000_000 + i * 1000 });
  }
  return out;
}

const yahooFile = (n = 130) =>
  `Date,Open,High,Low,Close,Adj Close,Volume\n${days(n)
    .map((r) => [iso(r.t), r.o, r.h, r.l, r.c, Number((r.c * 0.98).toFixed(2)), r.v].join(','))
    .join('\n')}\n`;

const read = (text: string): CsvRead => {
  const r = inspectCsv(text);
  assert.ok(r.read, `expected the file to be read, but: ${(r as CsvUnread).reason}`);
  return r;
};
const unread = (text: string): CsvUnread => {
  const r = inspectCsv(text);
  assert.ok(!r.read, 'expected the file not to be read');
  return r;
};
const cleaned = (c: CsvCleaned) => {
  assert.ok(c.ok, c.ok ? '' : c.reason);
  return c;
};
const map = (over: Partial<CsvMapping>): CsvMapping => ({ date: null, open: null, high: null, low: null, close: null, volume: null, adjClose: null, dateOrder: null, ...over });

test('a Yahoo download is read: columns, rows, dates and samples agree with parseCsv', () => {
  const text = yahooFile();
  const r = read(text);
  const bars = parseCsv(text);
  assert.equal(r.rows, 130);
  assert.equal(r.rows, bars.t.length);
  assert.equal(r.first, '2024-01-02');
  assert.equal(r.last, iso(bars.t[129]));
  assert.deepEqual(r.header, ['Date', 'Open', 'High', 'Low', 'Close', 'Adj Close', 'Volume']);
  assert.deepEqual(r.columns, { date: 0, open: 1, high: 2, low: 3, close: 4, volume: 6, adjClose: 5, dateOrder: null });
  assert.equal(r.head.length, 3);
  assert.equal(r.tail.length, 3);
  assert.equal(r.head[0].date, '2024-01-02');
  // The Adj Close column scales every price, so the sample shows what a strategy will see.
  assert.equal(r.head[0].close, bars.c[0]);
  assert.notEqual(r.head[0].close, days(1)[0].c);
  assert.equal(r.tail[2].close, bars.c[129]);
  assert.deepEqual(r.doubts, []);
  assert.equal(r.rawRows.length, 5);
  assert.equal(r.rawRows[0][0], '2024-01-02');
});

test('every header name parseCsv knows is found in the same column here', () => {
  const standard = ['Date', 'Open', 'High', 'Low', 'Close', 'Volume'];
  const roles = ['date', 'open', 'high', 'low', 'close', 'volume'] as const;
  for (const [role, names] of Object.entries(CSV_HEADERS)) {
    for (const name of names) {
      const header = [...standard];
      const at = roles.indexOf(role as (typeof roles)[number]);
      if (at >= 0) header[at] = name.toUpperCase();
      else header.push(name.toUpperCase());
      const r = read(`${header.join(',')}\n2024-01-02,5,5,5,5,5${at < 0 ? ',5' : ''}\n`);
      assert.equal(r.columns[role as keyof CsvMapping], at >= 0 ? at : 6, `${role} named ${name}`);
    }
  }
});

test('a Stooq file with the usual header is read; the bulk-download layout is guessed and cleaned', () => {
  const rows = days(8);
  const plain = `Date,Open,High,Low,Close,Volume\n${rows.map((r) => [iso(r.t), r.o, r.h, r.l, r.c, r.v].join(',')).join('\n')}\n`;
  assert.equal(read(plain).rows, 8);

  const bulk = `<TICKER>,<PER>,<DATE>,<TIME>,<OPEN>,<HIGH>,<LOW>,<CLOSE>,<VOL>,<OPENINT>\n${rows
    .map((r) => ['SPY.US', 'D', iso(r.t).replace(/-/g, ''), '000000', r.o, r.h, r.l, r.c, r.v, 0].join(','))
    .join('\n')}\n`;
  const u = unread(bulk);
  assert.deepEqual(u.columns, map({ date: 2, open: 4, high: 5, low: 6, close: 7, volume: 8 }));
  assert.match(u.reason, /^The plugin reads columns named date, open, high, low and close\. This file has no date, open, high, low or close column\./);
  const c = cleaned(remapCsv(bulk, u.columns));
  const bars = parseCsv(c.text);
  assert.deepEqual(bars.t, rows.map((r) => r.t));
  assert.deepEqual(bars.c, rows.map((r) => r.c));
  assert.deepEqual(bars.v, rows.map((r) => r.v));
});

test('semicolons with decimal commas are not read by the plugin, and a cleaned copy fixes them', () => {
  const rows = days(6);
  const comma = (x: number) => String(x).replace('.', ',');
  const text = `Date;Open;High;Low;Close;Volume\n${rows
    .map((r) => [`${String(new Date(r.t).getUTCDate()).padStart(2, '0')}.01.2024`, comma(r.o), comma(r.h), comma(r.l), comma(r.c), r.v].join(';'))
    .join('\n')}\n`;
  const u = unread(text);
  assert.match(u.reason, /decimal comma/);
  assert.match(u.reason, /"\d+,\d+"/);
  assert.deepEqual(u.columns, map({ date: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 }));
  const c = cleaned(remapCsv(text, u.columns));
  assert.ok(c.notes.some((n) => /decimal comma/.test(n)));
  const bars = parseCsv(c.text);
  assert.deepEqual(bars.c, rows.map((r) => r.c));
  assert.deepEqual(bars.o, rows.map((r) => r.o));
  assert.deepEqual(bars.t, rows.map((r) => r.t));
  assert.equal(c.dropped, 0);
});

test('thousands separators and European thousands are read when cleaning', () => {
  const text = 'Date;Close\n02.01.2024;"1.234,50"\n03.01.2024;"2.345,25"\n04.01.2024;3,5\n';
  const c = cleaned(remapCsv(text, map({ date: 0, close: 1 })));
  assert.deepEqual(parseCsv(c.text).c, [1234.5, 2345.25, 3.5]);
  const us = cleaned(remapCsv('Date,Close\n2024-01-02,"1,234.50"\n2024-01-03,"12,345"\n2024-01-04,"7,5"\n', map({ date: 0, close: 1 })));
  assert.deepEqual(parseCsv(us.text).c, [1234.5, 12345, 7.5]);
});

test('a byte order mark does not hide the first column', () => {
  const text = `\uFEFF${yahooFile(5)}`;
  const r = read(text);
  assert.equal(r.header[0], 'Date');
  assert.equal(r.columns.date, 0);
  assert.equal(r.rows, 5);
  const noMarkOnClean = cleaned(remapCsv(text, r.columns)).text;
  assert.ok(noMarkOnClean.startsWith('date,open,high,low,close,volume\n'));
});

test('day-first dates: proven ones are read, ambiguous ones are flagged and can be set either way', () => {
  const proven = 'Date,Open,High,Low,Close\n02/01/2024,1,2,1,2\n31/01/2024,1,2,1,2\n';
  const p = read(proven);
  assert.deepEqual([p.first, p.last], ['2024-01-02', '2024-01-31']);
  assert.equal(p.ambiguousDates, false);
  assert.deepEqual(p.doubts, [`The file has no volume column, so volume is 0 on every bar and a rule that reads volume cannot work.`, `Only 2 rows. The trend rule in the starter strategy uses a 100-bar average and would never act on this file.`]);

  const ambiguous = 'Date,Open,High,Low,Close,Volume\n02/01/2024,1,2,1,2,5\n03/01/2024,1,2,1,2,5\n04/01/2024,1,2,1,2,5\n';
  const a = read(ambiguous);
  assert.equal(a.ambiguousDates, true);
  assert.deepEqual([a.first, a.last], ['2024-02-01', '2024-04-01']);
  assert.ok(a.doubts.some((x) => /two ways: 02\/01\/2024 is 2024-02-01 month first, or 2024-01-02 day first\. They were read month first/.test(x)), a.doubts.join('\n'));
  assert.equal(dateOrderIsAmbiguous(ambiguous, 0), true);
  assert.equal(dateOrderIsAmbiguous(proven, 0), false);

  const dayFirst = cleaned(remapCsv(ambiguous, { ...a.columns, dateOrder: 'day-first' }));
  assert.deepEqual(parseCsv(dayFirst.text).t, [d(2024, 1, 2), d(2024, 1, 3), d(2024, 1, 4)]);
  assert.ok(dayFirst.notes.some((n) => /read day first/.test(n)));
  const monthFirst = cleaned(remapCsv(ambiguous, { ...a.columns, dateOrder: 'month-first' }));
  assert.deepEqual(parseCsv(monthFirst.text).t, [d(2024, 2, 1), d(2024, 3, 1), d(2024, 4, 1)]);
  // With no choice made, the cleaned copy is read the way parseCsv reads the original.
  assert.deepEqual(parseCsv(cleaned(remapCsv(ambiguous, a.columns)).text).t, parseCsv(ambiguous).t);
});

test('extra columns are ignored, and the cleaned copy keeps only the standard ones', () => {
  const rows = days(7);
  const text = `Date,Symbol,Open,High,Low,Close,Volume,Dividends,Stock Splits\n${rows
    .map((r) => [iso(r.t), 'SPY', r.o, r.h, r.l, r.c, r.v, 0, 0].join(','))
    .join('\n')}\n`;
  const r = read(text);
  assert.deepEqual(r.columns, { date: 0, open: 2, high: 3, low: 4, close: 5, volume: 6, adjClose: null, dateOrder: null });
  const c = cleaned(remapCsv(text, r.columns));
  assert.equal(c.text.split('\n')[0], 'date,open,high,low,close,volume');
  assert.deepEqual(parseCsv(c.text), parseCsv(text));
});

test('a file with only dates and closes is not read, and is cleaned with the rest filled from the close', () => {
  const rows = days(9);
  const text = `Date,Close\n${rows.map((r) => `${iso(r.t)},${r.c}`).join('\n')}\n`;
  const u = unread(text);
  assert.match(u.reason, /This file has no open, high or low column\. A file with only dates and closes can still be used/);
  assert.match(u.reason, /filled from the close/);
  assert.deepEqual(u.columns, map({ date: 0, close: 1 }));
  const c = cleaned(remapCsv(text, u.columns));
  assert.equal(c.rows, 9);
  assert.ok(c.notes[0].startsWith('The file has no open, high or low, so each is set to the close.'));
  assert.ok(c.notes.some((n) => /no volume column, so volume is 0/.test(n)));
  const bars = parseCsv(c.text);
  assert.deepEqual(bars.c, rows.map((r) => r.c));
  assert.deepEqual([bars.o, bars.h, bars.l], [bars.c, bars.c, bars.c]);
  assert.deepEqual(bars.v, rows.map(() => 0));
});

test('with an open but no high or low, they come from the open and close', () => {
  const text = 'Date,Open,Close\n2024-01-02,10,12\n2024-01-03,12,11\n';
  const c = cleaned(remapCsv(text, map({ date: 0, open: 1, close: 2 })));
  const bars = parseCsv(c.text);
  assert.deepEqual([bars.o, bars.h, bars.l, bars.c], [[10, 12], [12, 12], [10, 11], [12, 11]]);
  assert.ok(c.notes[0].includes('larger of the open and the close') && c.notes[0].includes('smaller of the open and the close'));
});

test('an empty file, a header with no rows and a file that is not prices are explained', () => {
  const empty = unread('');
  assert.equal(empty.reason, 'The file is empty.');
  assert.deepEqual([empty.header, empty.rawRows], [[], []]);
  assert.equal(unread('\n  \n').reason, 'The file is empty.');
  const headerOnly = unread('Date,Open,High,Low,Close\n');
  assert.match(headerOnly.reason, /header row and nothing under it/);
  assert.deepEqual(headerOnly.header, ['Date', 'Open', 'High', 'Low', 'Close']);

  const contacts = 'name,email,age\nAnn,ann@example.com,31\nBob,bob@example.com,45\nCy,cy@example.com,29\n';
  const n = unread(contacts);
  assert.match(n.reason, /^This does not look like a file of prices: no column looks like a date or a price\./);
  assert.deepEqual(n.header, ['name', 'email', 'age']);
  assert.equal(n.rawRows.length, 3);
  assert.deepEqual(n.columns, map({}));
  assert.deepEqual(remapCsv(contacts, n.columns), { ok: false, reason: 'Choose which column holds the date.' });

  const sales = unread('date,customer,amount\n2024-01-02,Ann,31\n2024-01-03,Bob,45\n');
  assert.match(sales.reason, /no column looks like a closing price/);
  assert.equal(sales.columns.date, 0);
  assert.equal(sales.columns.close, null);
});

test('a date column is found by what is in it when its name says nothing', () => {
  const text = 'When,Px\n2024-01-02,10\n2024-01-03,11\n';
  const u = unread(text);
  assert.equal(u.columns.date, 0);
  assert.equal(u.columns.close, null);
  // A big number column is not mistaken for dates.
  assert.equal(unread('Qty,Px\n123456789,10\n223456789,11\n').columns.date, null);
});

test('dates that cannot be read are explained with the first one', () => {
  const u = unread('Date,Open,High,Low,Close\nlast tuesday,1,2,1,2\nnext week,1,2,1,2\n');
  assert.equal(u.reason, 'No date in the "Date" column could be read. The first one is "last tuesday". Dates should look like 2024-01-31.');
  const nums = unread('Date,Open,High,Low,Close\n2024-01-02,1,2,1,n/a\n');
  assert.equal(nums.reason, 'No number in the "Close" column could be read. The first one is "n/a".');
  const zero = unread('Date,Open,High,Low,Close\n2024-01-02,0,0,0,0\n');
  assert.match(zero.reason, /price at or below zero/);
});

test('rows that cannot be read are skipped and counted, with the reasons', () => {
  const rows = days(120);
  const lines = rows.map((r) => [iso(r.t), r.o, r.h, r.l, r.c, r.v].join(','));
  lines[10] = '2024-02-01,0,0,0,0,0';
  lines[20] = 'Total,,,,,';
  lines[30] = `${iso(rows[30].t)},10,9,8,9,100`;
  lines[40] = lines[39];
  lines[50] = `${iso(rows[50].t)},,,,,`;
  const text = `Date,Open,High,Low,Close,Volume\n${lines.join('\n')}\n`;
  const r = read(text);
  assert.equal(r.rows, 115);
  assert.equal(r.rows, parseCsv(text).t.length);
  assert.equal(r.doubts.length, 1, r.doubts.join('\n'));
  assert.equal(
    r.doubts[0],
    '5 of 120 rows were skipped: 1 with a date that could not be read, 1 with a price that is missing or not a number, 1 with a price at or below zero, 1 where the high or low does not contain the open and close, 1 that repeat a date already read.',
  );
});

test('rows newest first are noted, and a file with no volume or a big gap is flagged', () => {
  const rows = days(130).reverse();
  const text = `Date,Open,High,Low,Close\n${rows.map((r) => [iso(r.t), r.o, r.h, r.l, r.c].join(',')).join('\n')}\n`;
  const r = read(text);
  assert.equal(r.first, '2024-01-02');
  assert.ok(r.doubts.includes('The rows are newest first. They are sorted oldest first when the file is read.'));
  assert.ok(r.doubts.some((x) => /no volume column/.test(x)));

  const gap = days(130);
  const withGap = gap.map((x, i) => (i >= 60 ? { ...x, t: x.t + 40 * DAY } : x));
  const g = read(`Date,Open,High,Low,Close,Volume\n${withGap.map((x) => [iso(x.t), x.o, x.h, x.l, x.c, x.v].join(',')).join('\n')}\n`);
  const note = g.doubts.find((x) => /gap/.test(x));
  assert.match(note!, /^1 gap of more than 10 days between rows\. The longest is 4\d days, from 2024-03-2\d to 2024-05-0\d\.$/);
});

test('rows in mixed order are noted and a zero volume column is flagged', () => {
  const rows = days(130);
  const shuffled = rows.map((_, i) => rows[(i * 7) % 130]);
  const text = `Date,Open,High,Low,Close,Volume\n${shuffled.map((x) => [iso(x.t), x.o, x.h, x.l, x.c, 0].join(',')).join('\n')}\n`;
  const r = read(text);
  assert.equal(r.rows, 130);
  assert.ok(r.doubts.includes('The rows are not in date order. They are sorted oldest first when the file is read.'));
  assert.ok(r.doubts.includes('Volume is 0 on every bar, so a rule that reads volume cannot work.'));
});

test('dates with a time of day are noted', () => {
  const text = `Time,Open,High,Low,Close,Volume\n${Array.from({ length: 130 }, (_, i) => `2024-01-02 ${String(9 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00,1,2,1,2,5`).join('\n')}\n`;
  const r = read(text);
  assert.equal(r.first, '2024-01-02 09:00:00');
  assert.ok(r.doubts.some((x) => /^Some dates have a time of day, such as 2024-01-02 09:00:00\. Times are read as UTC/.test(x)));
});

test('a short file says the starter strategy would never act', () => {
  const r = read(yahooFile(40));
  assert.deepEqual(r.doubts, ['Only 40 rows. The trend rule in the starter strategy uses a 100-bar average and would never act on this file.']);
  assert.equal(r.head.length + r.tail.length, 6);
  assert.deepEqual(read(yahooFile(5)).head.length + read(yahooFile(5)).tail.length, 5);
});

test('a row with no date among rows newest first costs only that row, in parseCsv and in the cleaned copy', () => {
  const lines = ['Date,Open,High,Low,Close,Volume', '2024-01-04,1,2,1,2,5', 'Total,,,,,', '2024-01-03,1,2,1,2,5', '2024-01-02,1,2,1,2,5'];
  const text = `${lines.join('\n')}\n`;
  assert.deepEqual(parseCsv(text).t, [d(2024, 1, 2), d(2024, 1, 3), d(2024, 1, 4)]);
  const r = read(text);
  assert.equal(r.rows, 3);
  assert.ok(!r.doubts.some((x) => /lost when the file was read/.test(x)), r.doubts.join('\n'));
  const c = cleaned(remapCsv(text, r.columns));
  assert.equal(c.rows, 3);
  assert.equal(c.dropped, 1);
  assert.deepEqual(parseCsv(c.text).t, [d(2024, 1, 2), d(2024, 1, 3), d(2024, 1, 4)]);
});

test('inspectCsv agrees with parseCsv on the row count for every kind of file in these tests', () => {
  const files = [
    yahooFile(30),
    'Date;Open;High;Low;Close\n02.01.2024;1;2;1;2\n03.01.2024;1;2;1;2\n',
    'date\topen\thigh\tlow\tclose\n2024-01-02\t1\t2\t1\t2\n2024-01-03\t1\t2\t1\t2\n',
    'Date,Open,High,Low,Close\n1704153600,1,2,1,2\n1704240000,1,2,1,2\n',
    'Date,Open,High,Low,Close\n2024-01-02,1,2,1,2\n2024-01-02,1,3,1,2\n2024-01-03,1,2,1,2\n',
    'Date,Close,Open,High,Low\n2024-01-03,2,1,2,1\n2024-01-02,2,1,2,1\n',
    'Date,Open,High,Low,Close\n02/30/2024,1,2,1,2\n01/02/2024,1,2,1,2\n',
  ];
  for (const text of files) assert.equal(read(text).rows, parseCsv(text).t.length, text.slice(0, 60));
});

test('remapCsv: the user can pick any column for any role', () => {
  const text = 'Day,Settle,Hi,Lo,Op,Vol\n2024-01-03,11,12,10,10.5,100\n2024-01-02,10,11,9,9.5,90\n';
  const c = cleaned(remapCsv(text, map({ date: 0, close: 1, high: 2, low: 3, open: 4, volume: 5 })));
  const bars = parseCsv(c.text);
  assert.deepEqual(bars.t, [d(2024, 1, 2), d(2024, 1, 3)]);
  assert.deepEqual([bars.o, bars.h, bars.l, bars.c, bars.v], [[9.5, 10.5], [11, 12], [9, 10], [10, 11], [90, 100]]);
  assert.deepEqual([c.first, c.last, c.rows], ['2024-01-02', '2024-01-03', 2]);
  assert.equal(c.sample.length, 2);
  assert.deepEqual(c.sample[0], { date: '2024-01-02', open: 9.5, high: 11, low: 9, close: 10, volume: 90 });
});

test('remapCsv: an adjusted close scales the prices like parseCsv does', () => {
  const text = 'Day,Open,High,Low,Close,Adjusted,Volume\n2024-01-02,10,11,9,10,5,100\n2024-01-03,20,22,18,20,10,100\n';
  const c = cleaned(remapCsv(text, map({ date: 0, open: 1, high: 2, low: 3, close: 4, adjClose: 5, volume: 6 })));
  assert.deepEqual(parseCsv(c.text).c, [5, 10]);
  assert.deepEqual(parseCsv(c.text).h, [5.5, 11]);
  assert.ok(c.notes.some((n) => /adjusted close/.test(n)));
  assert.equal(parseCsv('Date,Open,High,Low,Close,Adj Close\n2024-01-02,10,11,9,10,5\n').c[0], 5);
});

test('remapCsv: dates with times, Unix times, year-first slashes and plain digits come out as clean dates', () => {
  const text = 'T,C\n2024-01-02 14:30,1\n1704326400,2\n2024/01/05,3\n20240106,4\n04.01.2024,5\n';
  const c = cleaned(remapCsv(text, map({ date: 0, close: 1 })));
  assert.equal(c.text.split('\n')[1], `2024-01-02 14:30:00,1,1,1,1,0`);
  // 1704326400 and 04.01.2024 are the same day, so the second is left out.
  assert.deepEqual(parseCsv(c.text).t, [Date.UTC(2024, 0, 2, 14, 30), d(2024, 1, 4), d(2024, 1, 5), d(2024, 1, 6)]);
  assert.equal(c.dropped, 1);
  assert.match(c.notes.join(' '), /1 of 5 rows were left out: 1 that repeat a date already read\./);
});

test('remapCsv: rows that cannot be read are left out and counted', () => {
  const text = 'Date,Close\n2024-01-02,10\nnot a date,11\n2024-01-04,\n2024-01-05,0\n2024-01-06,13\n';
  const c = cleaned(remapCsv(text, map({ date: 0, close: 1 })));
  assert.equal(c.rows, 2);
  assert.equal(c.dropped, 3);
  assert.ok(c.notes.includes('3 of 5 rows were left out: 1 with a date that could not be read, 1 with a price that is missing or not a number, 1 with a price at or below zero.'));
  assert.deepEqual(parseCsv(c.text).c, [10, 13]);
});

test('remapCsv says why it cannot clean a file', () => {
  const text = 'Date,Open,Close\n2024-01-02,1,2\n';
  assert.deepEqual(remapCsv('', map({ date: 0, close: 1 })), { ok: false, reason: 'The file has no rows of prices.' });
  assert.deepEqual(remapCsv(text, map({ date: 0 })), { ok: false, reason: 'Choose which column holds the closing price.' });
  assert.deepEqual(remapCsv(text, map({ close: 2 })), { ok: false, reason: 'Choose which column holds the date.' });
  assert.deepEqual(remapCsv(text, map({ date: 0, close: 0 })), { ok: false, reason: 'The date and the close are the same column. Choose a different column for one of them.' });
  assert.deepEqual(remapCsv(text, map({ date: 0, close: 9 })), { ok: false, reason: 'The close column is not in the file.' });
  assert.deepEqual(remapCsv('Date,Close\nsoon,1\n', map({ date: 0, close: 1 })), { ok: false, reason: 'No row could be read. No date in the "Date" column could be read. Check the columns chosen.' });
  assert.match((remapCsv('Date,Close\n2024-01-02,x\n', map({ date: 0, close: 1 })) as { reason: string }).reason, /hold no numbers/);
});

test('a cleaned copy is stable: reading it needs no further cleaning, and cleaning it again changes nothing', () => {
  const text = `Date;Close\n${days(20)
    .map((r) => `${iso(r.t).split('-').reverse().join('.')};${String(r.c).replace('.', ',')}`)
    .join('\n')}\n`;
  const first = cleaned(remapCsv(text, inspectCsv(text).columns));
  const again = read(first.text);
  assert.equal(again.rows, 20);
  assert.deepEqual(cleaned(remapCsv(first.text, again.columns)).text, first.text);
});

test('the cleaned copy goes beside the original with a name that can be used in a strategy', () => {
  assert.equal(cleanedPath('Data/gold.csv'), 'Data/gold-clean.csv');
  assert.equal(cleanedPath('gold.CSV'), 'gold-clean.csv');
  assert.equal(cleanedPath('Data/My Gold, 2024.csv'), 'Data/My-Gold-2024-clean.csv');
  assert.equal(csvTicker(cleanedPath('Data/My Gold, 2024.csv')).ok, true);
});

test('a path with a space or a comma cannot be written in a strategy, and the parser agrees', () => {
  for (const path of ['Data/my gold.csv', 'My Data/gold.csv', 'Data/gold, old.csv', 'Data/a,b.csv', 'Data/a b.csv']) {
    const t = csvTicker(path);
    assert.equal(t.ok, false, path);
    assert.equal(csvStrategy(path).ok, false, path);
    // What the plain insertion would give is broken in a real strategy.
    const { spec, errors } = parseSpec(`symbol: csv:${path}\nbuy when close > sma(5)`);
    assert.ok(errors.length > 0 || spec!.universe[0].id !== path, path);
  }
  assert.match((csvTicker('Data/my gold.csv') as { reason: string }).reason, /has a space in it.*Rename the file or its folder/);
  assert.match((csvTicker('Data/a,b.csv') as { reason: string }).reason, /has a comma in it/);
  assert.match((csvTicker('Data/.csv') as { reason: string }).reason, /is not a CSV path/);
});

test('every path that is written parses back to the same file, in the ticker and in the strategy', () => {
  const paths = ['gold.csv', 'Data/gold.csv', 'a/b/c/d.csv', 'Data/GOLD.CSV', 'Data/gold-2024_v2.csv', 'Data/gold.v2.csv', 'Data/a=b.csv', 'Data/a^b.csv', 'Data/SPY.csv', 'Data/close.csv', 'Data/buy.csv', 'Data/2024.csv', 'Data/gold(1).csv', 'Data/é.csv', 'Data/a#b.csv', 'Data/a&b.csv', 'Data/a+b.csv', "Data/a'b.csv", 'Data/[x].csv', 'Data/a;b.csv', 'Data/$x.csv', 'Data/100%.csv', 'Data/a:b.csv'];
  for (const path of paths) {
    const t = csvTicker(path);
    assert.ok(t.ok, path);
    assert.equal(t.text, `csv:${path}`);
    const universe = parseSpec(`universe: ${t.text} 60%, TLT 40%\nbuy when close > sma(5)`);
    assert.deepEqual(universe.errors, [], path);
    assert.equal(universe.spec!.universe[0].id, path);

    const s = csvStrategy(path);
    assert.ok(s.ok, path);
    assert.ok(s.text.startsWith('```strategy\n') && s.text.endsWith('\n```\n'));
    const body = s.text.slice('```strategy\n'.length, -'\n```\n'.length);
    const { spec, errors, warnings } = parseSpec(body);
    assert.deepEqual([errors, warnings], [[], []], path);
    assert.equal(spec!.universe[0].source, 'csv');
    assert.equal(spec!.universe[0].id, path);
    assert.equal(spec!.name, `Trend on ${spec!.universe[0].name}`);
    assert.equal(spec!.costBps, 5);
  }
});

test('characters the parser reads only on a universe line are reported', () => {
  assert.equal((csvTicker('Data/gold.csv') as { note: string | null }).note, null);
  for (const path of ['Data/gold(1).csv', 'Data/é.csv', 'Data/a&b.csv', 'Data/a#b.csv']) {
    const t = csvTicker(path);
    assert.ok(t.ok);
    assert.match(t.note!, /universe or symbol line, but not after "of"/, path);
    // The note is true: after "of" the parser cannot read the path.
    const viaOf = parseSpec(`universe: SPY\nbuy when close of csv:${path} > sma(5)`);
    assert.ok(viaOf.errors.length > 0 || viaOf.spec!.extras[0]?.id !== path, path);
  }
  const ok = parseSpec('universe: SPY\nbuy when close of csv:Data/gold.csv > sma(5)');
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.spec!.extras[0].id, 'Data/gold.csv');
});

test('the starter strategy for a file runs on that file', () => {
  const text = yahooFile(130);
  const s = csvStrategy('Data/spy.csv');
  assert.ok(s.ok);
  const { spec } = parseSpec(s.text.split('\n').slice(1, -2).join('\n'));
  const bt = runBacktest(spec!, new Map([['spy', parseCsv(text)]]));
  assert.ok(bt.run.equity.length > 20);
  assert.ok(bt.run.equity.every(Number.isFinite));
});

test('a file that was cleaned runs in a strategy: the whole way from a close-only file to a backtest', () => {
  const rows = days(300);
  const text = `Date,Close\n${rows.map((r) => `${iso(r.t)},${r.c}`).join('\n')}\n`;
  const u = unread(text);
  const c = cleaned(remapCsv(text, u.columns));
  const bt = runBacktest(parseSpec('universe: csv:Data/p.csv\nbuy when close > sma(20)\nsell when close < sma(20)').spec!, new Map([['p', parseCsv(c.text)]]));
  assert.ok(bt.run.trades.length > 0);
});

test('round trip: parseCsv of a cleaned copy gives the bars the file describes, whatever its layout', () => {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  for (let round = 0; round < 60; round++) {
    const rows = days(25 + Math.floor(rnd() * 20), d(2020 + Math.floor(rnd() * 4), 1 + Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 12)));
    const sep = pick([',', ';', '\t']);
    const comma = sep !== ',' && rnd() < 0.5;
    const format = pick(['iso', 'us', 'dotted', 'compact']);
    const withOpen = rnd() < 0.7;
    const withHigh = rnd() < 0.6;
    const withLow = rnd() < 0.6;
    const withVolume = rnd() < 0.6;
    const newestFirst = rnd() < 0.4;
    const dateOf = (t: number) => {
      const x = new Date(t);
      const [y, m, dd] = [x.getUTCFullYear(), String(x.getUTCMonth() + 1).padStart(2, '0'), String(x.getUTCDate()).padStart(2, '0')];
      return format === 'iso' ? `${y}-${m}-${dd}` : format === 'us' ? `${m}/${dd}/${y}` : format === 'dotted' ? `${dd}.${m}.${y}` : `${y}${m}${dd}`;
    };
    const num = (x: number) => (comma ? String(x).replace('.', ',') : String(x));
    const header = ['Day', ...(withOpen ? ['Op'] : []), ...(withHigh ? ['Hi'] : []), ...(withLow ? ['Lo'] : []), 'Settle', ...(withVolume ? ['Vol'] : []), 'Notes'];
    const lines = rows.map((r) => [dateOf(r.t), ...(withOpen ? [num(r.o)] : []), ...(withHigh ? [num(r.h)] : []), ...(withLow ? [num(r.l)] : []), num(r.c), ...(withVolume ? [String(r.v)] : []), 'x'].join(sep));
    if (newestFirst) lines.reverse();
    const text = `${rnd() < 0.3 ? '\uFEFF' : ''}${[header.join(sep), ...lines].join(rnd() < 0.3 ? '\r\n' : '\n')}\n`;

    let at = 1;
    const mapping = map({ date: 0, open: withOpen ? at++ : null, high: withHigh ? at++ : null, low: withLow ? at++ : null, close: at++, volume: withVolume ? at++ : null });
    const clean = cleaned(remapCsv(text, mapping));
    const got = parseCsv(clean.text);
    assert.deepEqual(got.t, rows.map((r) => r.t), `round ${round}`);
    assert.deepEqual(got.c, rows.map((r) => r.c), `round ${round}`);
    assert.deepEqual(got.v, rows.map((r) => (withVolume ? r.v : 0)), `round ${round}`);
    const open = rows.map((r) => (withOpen ? r.o : r.c));
    assert.deepEqual(got.o, open, `round ${round}`);
    assert.deepEqual(got.h, rows.map((r, i) => (withHigh ? r.h : Math.max(open[i], r.c))), `round ${round}`);
    assert.deepEqual(got.l, rows.map((r, i) => (withLow ? r.l : Math.min(open[i], r.c))), `round ${round}`);
    assert.equal(clean.dropped, 0, `round ${round}`);
  }
});

test('dates that mix day first and month first are noted, and the ones that cannot be read are counted', () => {
  const text = 'Date,Open,High,Low,Close,Volume\n31/01/2024,1,2,1,2,5\n01/31/2024,1,2,1,2,5\n02/05/2024,1,2,1,2,5\n';
  const r = read(text);
  assert.equal(r.rows, 2);
  assert.ok(r.doubts.some((x) => x.startsWith('1 of 3 rows were skipped: 1 with a date that could not be read')));
  assert.ok(r.doubts.includes('The dates mix day first and month first, so the ones that cannot be read as month first were skipped.'));
  assert.equal(r.ambiguousDates, false);
});

test('month names are read as plain UTC days whatever the computer\'s time zone, in the original and in the cleaned copy', () => {
  const text = 'Date,Close\n"Jan 02, 2024",10\n"Jan 3, 2024",11\n04-Jan-2024,12\n5 Jan 24,13\n"Sept 6, 2024",14\n';
  const u = unread(text);
  assert.equal(u.columns.date, 0);
  const c = cleaned(remapCsv(text, u.columns));
  assert.deepEqual(parseCsv(c.text).t, [d(2024, 1, 2), d(2024, 1, 3), d(2024, 1, 4), d(2024, 1, 5), d(2024, 9, 6)]);
  assert.equal(c.dropped, 0);
  // A day that does not exist is not rolled over to the next month.
  assert.equal(remapCsv('Date,Close\n"Feb 30, 2024",2\n', map({ date: 0, close: 1 })).ok, false);
});

/** The review's file: every day of the first quarter of 2024, written DD-MM-YYYY. */
const dashedQuarter = () => {
  const lines = ['Date,Open,High,Low,Close'];
  for (let t = d(2024, 1, 1); t <= d(2024, 3, 31); t += DAY) {
    const x = new Date(t);
    lines.push(`${String(x.getUTCDate()).padStart(2, '0')}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-2024,10,11,9,10.5`);
  }
  return `${lines.join('\n')}\n`;
};

test('dates written DD-MM-YYYY are read day first when the file proves it, every row, as plain days', () => {
  const r = read(dashedQuarter());
  assert.deepEqual([r.rows, r.first, r.last], [91, '2024-01-01', '2024-03-31']);
  assert.equal(r.ambiguousDates, false);
  assert.deepEqual(r.doubts, ['The file has no volume column, so volume is 0 on every bar and a rule that reads volume cannot work.', 'Only 91 rows. The trend rule in the starter strategy uses a 100-bar average and would never act on this file.']);
  const c = cleaned(remapCsv(dashedQuarter(), r.columns));
  assert.deepEqual(c.text.split('\n').slice(1, 4), ['2024-01-01,10,11,9,10.5,0', '2024-01-02,10,11,9,10.5,0', '2024-01-03,10,11,9,10.5,0']);
  assert.equal(c.rows, 91);
});

test('dashed dates that could be day first or month first get the same question and choice as slashed ones', () => {
  const ambiguous = 'Date,Open,High,Low,Close,Volume\n02-01-2024,1,2,1,2,5\n03-01-2024,1,2,1,2,5\n04-01-2024,1,2,1,2,5\n';
  const a = read(ambiguous);
  assert.equal(a.ambiguousDates, true);
  assert.equal(dateOrderIsAmbiguous(ambiguous, 0), true);
  // The question about the order shows dates the way the file writes them.
  assert.equal(dateSeparator(ambiguous, 0), '-');
  assert.equal(dateSeparator(ambiguous.replace(/-/g, '/'), 0), '/');
  assert.ok(a.doubts.includes('The dates could be read two ways: 02-01-2024 is 2024-02-01 month first, or 2024-01-02 day first. They were read month first. If the file is day first, say so below.'), a.doubts.join('\n'));
  const dayFirst = cleaned(remapCsv(ambiguous, { ...a.columns, dateOrder: 'day-first' }));
  assert.deepEqual(dayFirst.text.split('\n').slice(1, 4).map((l) => l.split(',')[0]), ['2024-01-02', '2024-01-03', '2024-01-04']);
  assert.ok(dayFirst.notes.includes('Dates such as 02-01-2024 were read day first.'));
  const monthFirst = cleaned(remapCsv(ambiguous, { ...a.columns, dateOrder: 'month-first' }));
  assert.deepEqual(parseCsv(monthFirst.text).t, [d(2024, 2, 1), d(2024, 3, 1), d(2024, 4, 1)]);
  // Mixed orders are noted as with slashes.
  const mixed = read('Date,Open,High,Low,Close,Volume\n31-01-2024,1,2,1,2,5\n01-31-2024,1,2,1,2,5\n02-05-2024,1,2,1,2,5\n');
  assert.ok(mixed.doubts.includes('The dates mix day first and month first, so the ones that cannot be read as month first were skipped.'));
});

test('the dashed file reads and cleans the same in every time zone', () => {
  const script = `
    import { inspectCsv, remapCsv } from ${JSON.stringify(new URL('../src/csv-import.ts', import.meta.url).href)};
    const text = process.argv[1];
    const r = inspectCsv(text);
    const c = remapCsv(text, { ...r.columns, dateOrder: 'day-first' });
    console.log(JSON.stringify([r.read && r.first, r.read && r.last, r.read && r.doubts, c.ok && c.text]));`;
  const answers = ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Ho_Chi_Minh'].map((TZ) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script, dashedQuarter()], { env: { ...process.env, TZ }, encoding: 'utf8' }),
  );
  assert.equal(JSON.parse(answers[0])[0], '2024-01-01');
  for (const a of answers) assert.equal(a, answers[0]);
});
