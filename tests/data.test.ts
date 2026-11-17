import assert from 'node:assert/strict';
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
  assert.match(r.warning!, /Couldn't refresh SPY .*saved on 2024-01-10/);
  await assert.rejects(loadBars({ name: 'QQQ', source: 'yahoo', id: 'QQQ' }, '1d', 0, d), /Couldn't load QQQ from yahoo/);
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
  await assert.rejects(loadBars({ name: 'y', source: 'csv', id: 'Data/y.csv' }, '1d', 0, d), /No file at Data\/y.csv/);
});
