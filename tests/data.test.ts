import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadBars, parseBinance, parseCsv, parseYahoo, type DataDeps } from '../src/data.ts';
import { DAY } from './helpers.ts';

const yahoo = (ts: number[], close: (number | null)[], adj: (number | null)[]) =>
  JSON.stringify({
    chart: {
      result: [
        {
          meta: { gmtoffset: -18000 },
          timestamp: ts,
          indicators: {
            quote: [{ open: close, high: close.map((c) => (c === null ? null : c + 1)), low: close.map((c) => (c === null ? null : c - 1)), close, volume: close.map(() => 10) }],
            adjclose: [{ adjclose: adj }],
          },
        },
      ],
    },
  });

// 14:30 UTC on 2 to 5 January 2024.
const stamps = [2, 3, 4, 5].map((d) => Date.UTC(2024, 0, d, 14, 30) / 1000);

test('yahoo bars are adjusted, dated by the exchange day, and stop before today', () => {
  const json = yahoo(stamps, [100, null, 110, 120], [50, null, 110, 120]);
  const now = Date.UTC(2024, 0, 5, 16, 0);
  const b = parseYahoo(json, now);
  assert.deepEqual(b.t, [Date.UTC(2024, 0, 2), Date.UTC(2024, 0, 4)]);
  assert.deepEqual([b.o[0], b.h[0], b.l[0], b.c[0]], [50, 50.5, 49.5, 50]);
  assert.equal(parseYahoo(json, now + DAY).t.length, 3);
});

test("yahoo keeps today's daily bar once the regular session has closed", () => {
  // Friday 5 January 2024 trades 9:30 to 16:00 in New York (UTC-5): 14:30 to 21:00 UTC.
  const session = (start: number, end: number) => {
    const body = JSON.parse(yahoo(stamps, [100, 101, 110, 120], [100, 101, 110, 120]));
    body.chart.result[0].meta.currentTradingPeriod = { regular: { start: start / 1000, end: end / 1000, gmtoffset: -18000, timezone: 'EST' } };
    return JSON.stringify(body);
  };
  const [open, close] = [Date.UTC(2024, 0, 5, 14, 30), Date.UTC(2024, 0, 5, 21, 0)];
  const days = (json: string, now: number, weekly = false) => parseYahoo(json, now, weekly).t.map((t) => new Date(t).getUTCDate());
  assert.deepEqual(days(session(open, close), close - 60_000), [2, 3, 4]);
  assert.deepEqual(days(session(open, close), close), [2, 3, 4, 5]);
  // Without the field, today's bar waits for the next day as before.
  assert.deepEqual(days(yahoo(stamps, [100, 101, 110, 120], [100, 101, 110, 120]), close), [2, 3, 4]);
  // A session that ended on an earlier day says nothing about today's bar.
  const thursday = (h: number) => Date.UTC(2024, 0, 4, h);
  assert.deepEqual(days(session(thursday(14), thursday(21)), close), [2, 3, 4]);
  // Weekly bars are unchanged: this week's bar is still open.
  assert.deepEqual(days(session(open, close), close + 60_000, true), []);
});

test('yahoo bars stamped at the exchange midnight keep their day across a clock change', () => {
  // Recorded responses (November 2026, when New York and London were on winter time). Yahoo stamps a weekly bar at
  // midnight New York time and a currency pair's daily bar at midnight London time, so in summer the stamp is the
  // evening before in UTC; meta.gmtoffset is only today's offset.
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const dates = (json: string, weekly = false) => parseYahoo(json, Date.UTC(2026, 10, 17), weekly).t.map((t) => new Date(t).toISOString().slice(0, 10));
  // Weekly SPY: every bar on a Monday, before and after the switches of 9 March and 2 November 2025.
  assert.deepEqual(dates(fixture('yahoo-spy-1wk.json'), true), ['2025-02-24', '2025-03-03', '2025-03-10', '2025-03-17', '2025-10-27', '2025-11-03', '2025-11-10']);
  // EUR/USD: London went to summer time on 30 March 2025; Monday 31 March is stamped 23:00 UTC on the 30th.
  assert.deepEqual(dates(fixture('yahoo-eurusd-1d.json')), ['2025-03-26', '2025-03-27', '2025-03-28', '2025-03-31', '2025-04-01', '2025-04-02', '2025-04-03', '2025-07-02', '2025-07-03']);
});

test('yahoo errors surface', () => {
  assert.throws(() => parseYahoo(JSON.stringify({ chart: { result: null, error: { description: 'No data found, symbol may be delisted' } } }), 0), /delisted/);
});

test('binance klines drop the one still open', () => {
  const rows = [
    [1000, '1', '2', '0.5', '1.5', '10', 1999],
    [2000, '1.5', '3', '1', '2', '10', 2999],
  ];
  assert.deepEqual(parseBinance(JSON.stringify(rows), 2500).c, [1.5]);
  assert.throws(() => parseBinance(JSON.stringify({ code: -1121, msg: 'Invalid symbol.' }), 0), /Invalid symbol/);
});

test('csv: header order, adjusted close, unsorted and bad rows', () => {
  const b = parseCsv(`Date,Close,Open,High,Low,Adj Close,Volume
2024-01-03,20,20,22,18,10,100
2024-01-02,10,10,11,9,5,100
2024-01-04,0,0,0,0,0,0
`);
  assert.deepEqual(b.t, [Date.UTC(2024, 0, 2), Date.UTC(2024, 0, 3)]);
  assert.deepEqual(b.c, [5, 10]);
  assert.deepEqual(b.h, [5.5, 11]);
  assert.deepEqual(parseCsv('time,open,high,low,close\n1704153600,1,1,1,1\n2024-01-03 12:00,1,1,1,1').t, [Date.UTC(2024, 0, 2), Date.UTC(2024, 0, 3, 12)]);
  assert.throws(() => parseCsv('a,b\n1,2'), /header row/);
});

test('csv: rows with an unreadable date are dropped and the rest keep their dates in order', () => {
  const b = parseCsv('Date,Open,High,Low,Close\n2024-01-04,3,3,3,3\n2024-01-03,2,2,2,2\nsometime,9,9,9,9\n2024-01-02,1,1,1,1');
  assert.deepEqual(b.t, [Date.UTC(2024, 0, 2), Date.UTC(2024, 0, 3), Date.UTC(2024, 0, 4)]);
  assert.deepEqual(b.c, [1, 2, 3]);
  // The bad row can come first, last or between, and more than one can be there.
  const order = (rows: string[]) => parseCsv(`Date,Open,High,Low,Close\n${rows.join('\n')}`).c;
  assert.deepEqual(order(['x,9,9,9,9', '2024-01-03,2,2,2,2', '2024-01-02,1,1,1,1', 'y,9,9,9,9']), [1, 2]);
  assert.deepEqual(order(['2024-01-05,5,5,5,5', ',9,9,9,9', '2024-01-03,3,3,3,3', 'x,9,9,9,9', '2024-01-04,4,4,4,4']), [3, 4, 5]);
});

function deps(over: Partial<DataDeps>) {
  const cache = new Map<string, string>();
  const calls: string[] = [];
  const d: DataDeps = {
    fetchText: async (url) => {
      calls.push(url);
      return yahoo(stamps, [100, 101, 102, 103], [100, 101, 102, 103]);
    },
    readVaultFile: async () => null,
    cacheRead: async (k) => cache.get(k) ?? null,
    cacheWrite: async (k, v) => void cache.set(k, v),
    now: () => Date.UTC(2024, 0, 10),
    ...over,
  };
  return { d, calls, cache };
}
const SPY = { name: 'SPY', source: 'yahoo' as const, id: 'SPY' };

test('fresh cache is reused, stale cache is refetched, force refetches', async () => {
  let now = Date.UTC(2024, 0, 10);
  const { d, calls } = deps({ now: () => now });
  await loadBars(SPY, '1d', 0, d);
  await loadBars(SPY, '1d', 0, d);
  assert.equal(calls.length, 1);
  await loadBars(SPY, '1d', 0, d, true);
  assert.equal(calls.length, 2);
  now += 7 * 3_600_000;
  await loadBars(SPY, '1d', 0, d);
  assert.equal(calls.length, 3);
});

test('a failed refresh falls back to saved prices with a warning; with none saved it fails', async () => {
  let now = Date.UTC(2024, 0, 10);
  let offline = false;
  const base = deps({});
  const { d } = deps({
    now: () => now,
    fetchText: async (url) => {
      if (offline) throw new Error('net::ERR_INTERNET_DISCONNECTED');
      return base.d.fetchText(url);
    },
  });
  await loadBars(SPY, '1d', 0, d);
  offline = true;
  now += DAY;
  const r = await loadBars(SPY, '1d', 0, d);
  assert.equal(r.bars.t.length, 4);
  assert.match(r.warning!, /Cannot download new prices for SPY .*saved on 2024-01-10/);
  assert.equal(r.stale, true);
  assert.equal(r.fetched, Date.UTC(2024, 0, 10));
  assert.equal(r.through, Date.UTC(2024, 0, 5));
  await assert.rejects(loadBars({ name: 'QQQ', source: 'yahoo', id: 'QQQ' }, '1d', 0, d), /Cannot load QQQ from yahoo/);
});

test('binance pages until a short page and later only fetches what is new', async () => {
  const H = 3_600_000;
  const kline = (i: number) => [i * H, '1', '1', '1', '1', '1', (i + 1) * H - 1];
  let now = 1500.5 * H;
  const starts: number[] = [];
  const { d } = deps({
    now: () => now,
    fetchText: async (url) => {
      const start = Number(new URL(url).searchParams.get('startTime'));
      starts.push(start);
      const first = Math.ceil(start / H);
      const last = Math.min(first + 999, Math.floor(now / H));
      const rows = [];
      for (let i = first; i <= last; i++) rows.push(kline(i));
      return JSON.stringify(rows);
    },
  });
  const BTC = { name: 'BTCUSDT', source: 'binance' as const, id: 'BTCUSDT' };
  let r = await loadBars(BTC, '1h', 0, d);
  assert.equal(r.bars.t.length, 1500);
  assert.deepEqual(starts, [0, 999 * H + 1]);
  now += 10 * H;
  r = await loadBars(BTC, '1h', 0, d);
  assert.equal(r.bars.t.length, 1510);
  assert.equal(starts[2], 1499 * H + 1);
  // An earlier start than the cache was built for refetches from that start.
  r = await loadBars(BTC, '1h', -5 * H, d, true);
  assert.equal(starts[3], -5 * H);
});

test('csv comes from the vault', async () => {
  const { d } = deps({ readVaultFile: async (p) => (p === 'Data/x.csv' ? 'date,open,high,low,close\n2024-01-02,1,1,1,1' : null) });
  assert.equal((await loadBars({ name: 'x', source: 'csv', id: 'Data/x.csv' }, '1d', 0, d)).bars.t.length, 1);
  await assert.rejects(loadBars({ name: 'y', source: 'csv', id: 'Data/y.csv' }, '1d', 0, d), /There is no file at Data\/y.csv/);
});

const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'query1.finance.yahoo.com'];
const hostOf = (url: string) => new URL(url).hostname;
const NOT_FOUND = JSON.stringify({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } });
const GOOD = yahoo(stamps, [100, 101, 102, 103], [100, 101, 102, 103]);

test('yahoo is retried on query1, query2, query1 with 500 ms then 1500 ms between tries', async () => {
  const hosts: string[] = [];
  const sleeps: number[] = [];
  const answers = [() => Promise.reject(new Error('HTTP 429')), () => Promise.resolve('Too Many Requests'), () => Promise.resolve(GOOD)];
  const { d } = deps({
    fetchText: async (url) => {
      hosts.push(hostOf(url));
      return answers[hosts.length - 1]();
    },
    sleep: async (ms) => void sleeps.push(ms),
  });
  const r = await loadBars(SPY, '1d', 0, d);
  assert.deepEqual(hosts, HOSTS);
  assert.deepEqual(sleeps, [500, 1500]);
  assert.equal(r.bars.t.length, 4);
  assert.equal(r.warning, null);
});

test('a first answer needs no wait, and retries go out at once when there is no sleep', async () => {
  const sleeps: number[] = [];
  const ok = deps({ sleep: async (ms) => void sleeps.push(ms) });
  await loadBars(SPY, '1d', 0, ok.d);
  assert.equal(ok.calls.length, 1);
  assert.deepEqual(sleeps, []);

  const down = deps({
    fetchText: async (url) => {
      down.calls.push(url);
      throw new Error('HTTP 503');
    },
  });
  await assert.rejects(loadBars(SPY, '1d', 0, down.d), /Cannot load SPY from yahoo: HTTP 503/);
  assert.deepEqual(down.calls.map(hostOf), HOSTS);
});

test('an error Yahoo explains in its answer is final and is not retried', async () => {
  const sleeps: number[] = [];
  const body = JSON.stringify({ chart: { result: null, error: { code: 'Bad Request', description: 'Invalid input - interval=1x is not supported' } } });
  const { d, calls } = deps({ fetchText: async (url) => (calls.push(url), body), sleep: async (ms) => void sleeps.push(ms) });
  await assert.rejects(loadBars(SPY, '1d', 0, d), /Cannot load SPY from yahoo: Invalid input/);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('with every Yahoo try failed, the saved copy is used and marked stale', async () => {
  let now = Date.UTC(2024, 0, 10, 12);
  let offline = false;
  const { d, calls } = deps({
    now: () => now,
    fetchText: async (url) => {
      calls.push(url);
      if (offline) throw new Error('HTTP 500');
      return GOOD;
    },
  });
  const first = await loadBars(SPY, '1d', 0, d);
  assert.equal(first.stale, false);
  offline = true;
  now += 2 * DAY;
  const r = await loadBars(SPY, '1d', 0, d);
  assert.equal(calls.length, 1 + 3);
  assert.equal(r.stale, true);
  assert.equal(r.fetched, Date.UTC(2024, 0, 10, 12));
  assert.equal(r.source, 'yahoo');
  assert.match(r.warning!, /^Cannot download new prices for SPY \(HTTP 500\)\. The plugin uses the prices saved on 2024-01-10\.$/);
});

test('an unknown ticker gets a plain message, no retry and no saved copy', async () => {
  const { d, calls } = deps({ fetchText: async (url) => (calls.push(url), NOT_FOUND) });
  const XYZ = { name: 'XYZ', source: 'yahoo' as const, id: 'XYZ' };
  await assert.rejects(loadBars(XYZ, '1d', 0, d), { message: 'Yahoo has no prices for XYZ. Make sure that the ticker is correct.' });
  assert.equal(calls.length, 1);

  // Even with a saved copy there is nothing to fall back to.
  const saved = deps({});
  await loadBars(XYZ, '1d', 0, saved.d);
  const gone = deps({ now: () => Date.UTC(2024, 0, 12), cacheRead: saved.d.cacheRead, fetchText: async () => NOT_FOUND });
  await assert.rejects(loadBars(XYZ, '1d', 0, gone.d), { message: 'Yahoo has no prices for XYZ. Make sure that the ticker is correct.' });

  const bad = deps({ fetchText: async () => JSON.stringify({ code: -1121, msg: 'Invalid symbol.' }) });
  await assert.rejects(loadBars({ name: 'BTCUSD', source: 'binance', id: 'BTCUSD' }, '1h', 0, bad.d), {
    message: 'Binance has no market with the name BTCUSD. Make sure that the symbol is correct, for example BTCUSDT.',
  });
});

test('loaded bars say where they came from, how far they run and when they were fetched', async () => {
  const now = Date.UTC(2024, 0, 10);
  const y = deps({ now: () => now });
  const fresh = await loadBars(SPY, '1d', 0, y.d);
  assert.deepEqual([fresh.source, fresh.through, fresh.fetched, fresh.stale], ['yahoo', Date.UTC(2024, 0, 5), now, false]);
  const again = await loadBars(SPY, '1d', 0, y.d);
  assert.deepEqual([again.source, again.through, again.fetched, again.stale], ['yahoo', Date.UTC(2024, 0, 5), now, false]);

  const H = 3_600_000;
  const b = deps({ now: () => 10 * H, fetchText: async () => JSON.stringify([[0, '1', '1', '1', '1', '1', H - 1], [H, '1', '1', '1', '1', '1', 2 * H - 1]]) });
  const btc = await loadBars({ name: 'BTCUSDT', source: 'binance', id: 'BTCUSDT' }, '1h', 0, b.d);
  assert.deepEqual([btc.source, btc.through, btc.fetched, btc.stale, btc.warning], ['binance', H, 10 * H, false, null]);

  const c = deps({ now: () => 777, readVaultFile: async () => 'date,open,high,low,close\n2024-01-02,1,1,1,1\n2024-01-03,1,1,1,1' });
  const csv = await loadBars({ name: 'x', source: 'csv', id: 'x.csv' }, '1d', 0, c.d);
  assert.deepEqual([csv.source, csv.through, csv.fetched, csv.stale], ['csv', Date.UTC(2024, 0, 3), 777, false]);
});

test('calls that need the same download share one request, but separate deps do not', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { d, calls } = deps({ fetchText: async (url) => (calls.push(url), await gate, GOOD) });
  const [a, b, c] = [loadBars(SPY, '1d', 0, d), loadBars(SPY, '1d', 0, d), loadBars(SPY, '1d', 0, d, true)];
  const other = deps({ fetchText: async (url) => (other.calls.push(url), await gate, GOOD) });
  const e = loadBars(SPY, '1d', 0, other.d);
  await new Promise((r) => setImmediate(r));
  release();
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  await e;
  assert.equal(calls.length, 1);
  assert.equal(other.calls.length, 1);
  assert.equal(ra, rb);
  assert.equal(ra, rc);
  // Once it has finished the next forced call downloads again.
  await loadBars(SPY, '1d', 0, d, true);
  assert.equal(calls.length, 2);
});

test('shared downloads also cover failures, and Binance downloads share only with the same start', async () => {
  const down = deps({ fetchText: async (url) => (down.calls.push(url), Promise.reject(new Error('HTTP 500'))) });
  const results = await Promise.allSettled([loadBars(SPY, '1d', 0, down.d), loadBars(SPY, '1d', 0, down.d)]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  assert.equal(down.calls.length, 3);

  const H = 3_600_000;
  const starts: number[] = [];
  const { d } = deps({
    now: () => 10 * H,
    fetchText: async (url) => {
      starts.push(Number(new URL(url).searchParams.get('startTime')));
      return JSON.stringify([[0, '1', '1', '1', '1', '1', H - 1]]);
    },
  });
  const BTC = { name: 'BTCUSDT', source: 'binance' as const, id: 'BTCUSDT' };
  await Promise.all([loadBars(BTC, '1h', 0, d), loadBars(BTC, '1h', 0, d), loadBars(BTC, '1h', -H, d)]);
  assert.deepEqual(starts.sort((x, y) => x - y), [-H, 0]);
});

test('freshForMs sets how long saved prices count as fresh', async () => {
  let now = Date.UTC(2024, 0, 10);
  const { d, calls } = deps({ now: () => now });
  await loadBars(SPY, '1d', 0, d, false, { freshForMs: 3_600_000 });
  now += 2 * 3_600_000;
  await loadBars(SPY, '1d', 0, d, false, { freshForMs: 3_600_000 });
  assert.equal(calls.length, 2);
  now += 7 * 3_600_000;
  await loadBars(SPY, '1d', 0, d, false, { freshForMs: 24 * 3_600_000 });
  assert.equal(calls.length, 2);
  await loadBars(SPY, '1d', 0, d);
  assert.equal(calls.length, 3);
});

const jan = [Date.UTC(2024, 0, 2), Date.UTC(2024, 0, 3), Date.UTC(2024, 0, 31)];

test('csv: semicolon and tab separators, picked from the header line', () => {
  assert.deepEqual(parseCsv('Date;Open;High;Low;Close;Volume\n2024-01-02;1;2;1;2;5\n2024-01-03;2;3;2;3;5').c, [2, 3]);
  const tab = parseCsv('date\topen\thigh\tlow\tclose\n2024-01-02\t1\t2\t1\t2\n2024-01-03\t2\t3\t2\t3');
  assert.deepEqual(tab.t, jan.slice(0, 2));
  assert.deepEqual(tab.h, [2, 3]);
});

test('csv: a byte order mark, quoted fields and CRLF line ends', () => {
  const b = parseCsv('﻿"Date","Open","High","Low","Close","Note"\r\n"2024-01-02","1","2","1","2","a, b"\r\n"2024-01-03","2","3","2","3","say ""hi"""\r\n');
  assert.deepEqual(b.t, jan.slice(0, 2));
  assert.deepEqual(b.c, [2, 3]);
  // A separator inside quotes does not split, even in a semicolon file.
  assert.deepEqual(parseCsv('Date;Name;Open;High;Low;Close\n2024-01-02;"x; y";1;2;1;2').c, [2]);
});

test('csv: MM/DD/YYYY and DD.MM.YYYY dates', () => {
  const us = parseCsv('Date,Open,High,Low,Close\n01/02/2024,1,2,1,2\n01/31/2024,1,2,1,2');
  assert.deepEqual(us.t, [jan[0], jan[2]]);
  const eu = parseCsv('Date;Open;High;Low;Close\n02.01.2024;1;2;1;2\n31.01.2024 14:30;1;2;1;2');
  assert.deepEqual(eu.t, [jan[0], Date.UTC(2024, 0, 31, 14, 30)]);
});

test('csv: DD/MM/YYYY when the file proves it, MM/DD/YYYY when it is ambiguous', () => {
  const dayFirst = parseCsv('Date,Open,High,Low,Close\n02/01/2024,1,2,1,2\n31/01/2024,1,2,1,2');
  assert.deepEqual(dayFirst.t, [jan[0], jan[2]]);
  const ambiguous = parseCsv('Date,Open,High,Low,Close\n02/01/2024,1,2,1,2\n03/01/2024,1,2,1,2');
  assert.deepEqual(ambiguous.t, [Date.UTC(2024, 1, 1), Date.UTC(2024, 2, 1)]);
  // A date that does not exist is skipped.
  assert.deepEqual(parseCsv('Date,Open,High,Low,Close\n02/30/2024,1,2,1,2\n01/02/2024,1,2,1,2').t, [Date.UTC(2024, 0, 2)]);
});

test('csv: dates with dashes, DD-MM-YYYY or MM-DD-YYYY, are read like slashed ones, never with the year as a time zone', () => {
  // Day first when some first number is above 12 and no second one is, as with slashes; month first otherwise.
  const dayFirst = parseCsv('Date,Open,High,Low,Close\n02-01-2024,1,2,1,2\n31-01-2024,1,2,1,2');
  assert.deepEqual(dayFirst.t, [jan[0], jan[2]]);
  const monthFirst = parseCsv('Date,Open,High,Low,Close\n01-02-2024,1,2,1,2\n01-31-2024,1,2,1,2');
  assert.deepEqual(monthFirst.t, [jan[0], jan[2]]);
  const ambiguous = parseCsv('Date,Open,High,Low,Close\n02-01-2024,1,2,1,2\n03-01-2024,1,2,1,2');
  assert.deepEqual(ambiguous.t, [Date.UTC(2024, 1, 1), Date.UTC(2024, 2, 1)]);
  assert.deepEqual(parseCsv('Date,Open,High,Low,Close\n31-01-2024 14:30,1,2,1,2').t, [Date.UTC(2024, 0, 31, 14, 30)]);
  // An offset counts only after a time of day.
  assert.deepEqual(parseCsv('Date,Open,High,Low,Close\n2024-01-31T14:30:00-05:00,1,2,1,2\n2024-02-01 09:00+0100,1,2,1,2').t, [Date.UTC(2024, 0, 31, 19, 30), Date.UTC(2024, 1, 1, 8)]);
});

test('csv: errors name the column that is the problem', () => {
  assert.throws(() => parseCsv('Day,Open,High,Close\n2024-01-02,1,2,2'), /no date, low column/);
  assert.throws(() => parseCsv('Day,Open,High,Low,Close\n2024-01-02,1,2,1,2'), /no date column/);
  assert.throws(() => parseCsv('When,Open,High,Low,Close\n'), /no rows/);
  assert.throws(() => parseCsv('Date,Open,High,Low,Close\nlast tuesday,1,2,1,2'), /"Date" column/);
  assert.throws(() => parseCsv('Date,Open,High,Low,Close\n2024-01-02,1,2,1,n/a'), /"Close" column/);
  assert.throws(() => parseCsv('Date,Open,High,Low,Close\n2024-01-02,0,0,0,0'), /price of zero or less/);
});

test('a CSV file that cannot be read is named in the message', async () => {
  const deps: DataDeps = {
    fetchText: () => Promise.reject(new Error('no network')),
    readVaultFile: async (path) => ({ 'Data/empty.csv': 'date,open,high,low,close\n', 'Data/words.csv': 'date,open,high,low,close\nsoon,1,1,1,1\nlater,2,2,2,2\n' })[path] ?? null,
    cacheRead: async () => null,
    cacheWrite: async () => {},
    now: () => 0,
  };
  const ref = (id: string) => ({ name: id.slice(5, -4), source: 'csv' as const, id });
  await assert.rejects(loadBars(ref('Data/empty.csv'), '1d', 0, deps), /^Error: The CSV file Data\/empty\.csv has no rows$/);
  await assert.rejects(loadBars(ref('Data/words.csv'), '1d', 0, deps), /^Error: The CSV file Data\/words\.csv has no rows with a date that the plugin can read/);
});
