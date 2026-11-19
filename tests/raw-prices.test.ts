import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadBars, loadRawBars, parseTiingoRaw, parseYahoo, parseYahooRaw, type DataDeps } from '../src/data.ts';
import { matchFills, rawPrices, type Followed } from '../src/fills.ts';
import { Runner } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY } from './helpers.ts';

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * A Yahoo chart answer for Monday 3 to Friday 7 August 2020, with AAPL's 4-for-1 split effective on the open of the 31st:
 * here moved to Wednesday the 5th, so two days come before it. Prices are split-adjusted, as Yahoo's are; a dividend
 * paid on Thursday makes the adjusted closes before it lower.
 */
const STAMPS = [3, 4, 5, 6, 7].map((d) => Date.UTC(2020, 7, d, 13, 30) / 1000);
function chart(splits: Record<string, unknown> | undefined): string {
  const close = [100, 102, 104, 103, 105];
  return JSON.stringify({
    chart: {
      result: [
        {
          meta: { gmtoffset: -14400, exchangeTimezoneName: 'America/New_York' },
          timestamp: STAMPS,
          events: splits ? { splits, dividends: { [STAMPS[3]]: { amount: 0.8, date: STAMPS[3] } } } : undefined,
          indicators: {
            quote: [{ open: close.map((c) => c - 1), high: close.map((c) => c + 2), low: close.map((c) => c - 2), close, volume: close.map(() => 10) }],
            adjclose: [{ adjclose: close.map((c, i) => (i < 3 ? c * 0.99 : c)) }],
          },
        },
      ],
    },
  });
}
const SPLIT = { [STAMPS[2]]: { date: STAMPS[2], numerator: 4, denominator: 1, splitRatio: '4:1' } };
const NOW = Date.UTC(2020, 7, 10);

test('Yahoo prices as they traded: split-adjusted prices multiplied back by the splits after them, and no dividend adjustment', () => {
  const raw = parseYahooRaw(chart(SPLIT), NOW);
  assert.deepEqual(raw.t.map(iso), ['2020-08-03', '2020-08-04', '2020-08-05', '2020-08-06', '2020-08-07']);
  // Before the split each price is four times Yahoo's; from the split's own day on, it is Yahoo's.
  assert.deepEqual(raw.c, [400, 408, 104, 103, 105]);
  assert.deepEqual([raw.o[0], raw.h[0], raw.l[0]], [396, 408, 392]);
  // The adjusted bars of the same answer carry the dividend instead.
  assert.deepEqual(parseYahoo(chart(SPLIT), NOW).c.map((c) => Number(c.toFixed(6))), [99, 100.98, 102.96, 103, 105]);
  // Without split events the prices are Yahoo's own.
  assert.deepEqual(parseYahooRaw(chart(undefined), NOW).c, [100, 102, 104, 103, 105]);
  // A split event that makes no sense is passed over.
  assert.deepEqual(parseYahooRaw(chart({ x: { date: STAMPS[2], numerator: 0, denominator: 1 } }), NOW).c, [100, 102, 104, 103, 105]);
});

test('Yahoo prices as they traded stop before a day still trading, as the adjusted ones do', () => {
  assert.deepEqual(parseYahooRaw(chart(SPLIT), Date.UTC(2020, 7, 7, 15)).t.map(iso), ['2020-08-03', '2020-08-04', '2020-08-05', '2020-08-06']);
});

test("Tiingo prices as they traded are its open, high, low and close, not the adjusted ones", () => {
  const rows = [
    { date: '2025-03-03T00:00:00.000Z', open: 99.5, high: 101, low: 99, close: 100, volume: 5, adjOpen: 49.75, adjHigh: 50.5, adjLow: 49.5, adjClose: 50, adjVolume: 10 },
    { date: '2025-03-04T00:00:00.000Z', open: 100, high: 112, low: 100, close: 110, volume: 5, adjOpen: 50, adjHigh: 56, adjLow: 50, adjClose: 55, adjVolume: 10 },
  ];
  const b = parseTiingoRaw(JSON.stringify(rows), Date.UTC(2025, 3, 1));
  assert.deepEqual(b.t.map(iso), ['2025-03-03', '2025-03-04']);
  assert.deepEqual([b.o, b.h, b.l, b.c, b.v], [[99.5, 100], [101, 112], [99, 100], [100, 110], [5, 5]]);
  assert.throws(() => parseTiingoRaw(JSON.stringify({ detail: 'Not found.' }), 0), /Not found/);
});

function network(answer: (url: string) => string) {
  const cache = new Map<string, string>();
  const asked: { url: string; headers?: Record<string, string> }[] = [];
  const d: DataDeps = {
    fetchText: async (url, headers) => {
      asked.push(headers ? { url, headers } : { url });
      return answer(url);
    },
    readVaultFile: async () => null,
    cacheRead: async (k) => cache.get(k) ?? null,
    cacheWrite: async (k, v) => void cache.set(k, v),
    now: () => NOW,
    secret: () => 'KEY',
    tiingoFallback: () => true,
  };
  return { d, cache, asked };
}

test('prices as they traded are saved apart from the adjusted ones, and read from there while fresh', async () => {
  const { d, cache, asked } = network(() => chart(SPLIT));
  const AAPL = { name: 'AAPL', source: 'yahoo' as const, id: 'AAPL' };
  const raw = await loadRawBars(AAPL, d);
  assert.deepEqual(raw.bars.c, [400, 408, 104, 103, 105]);
  assert.equal(raw.source, 'yahoo');
  // The same daily request a strategy block makes.
  assert.deepEqual(asked, [{ url: `https://query1.finance.yahoo.com/v8/finance/chart/AAPL?period1=0&period2=${NOW / 1000}&interval=1d&events=div%2Csplit&includeAdjustedClose=true` }]);
  assert.deepEqual([...cache.keys()], ['raw-yahoo-AAPL-1d']);
  await loadRawBars(AAPL, d);
  assert.equal(asked.length, 1);
  // The adjusted bars have their own file and their own download.
  const adjusted = await loadBars(AAPL, '1d', 0, d);
  assert.equal(adjusted.bars.c[4], 105);
  assert.deepEqual([...cache.keys()].sort(), ['raw-yahoo-AAPL-1d', 'yahoo-AAPL-1d']);
  assert.equal(asked.length, 2);
});

test('a Tiingo ticker comes from Tiingo with the key in its header, and Tiingo never stands in for a Yahoo one here', async () => {
  const rows = JSON.stringify([{ date: '2020-08-07T00:00:00.000Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }]);
  const { d, asked } = network((url) => (url.includes('tiingo') ? rows : 'Service unavailable'));
  const t = await loadRawBars({ name: 'SPY', source: 'tiingo', id: 'SPY' }, d);
  assert.deepEqual(t.bars.c, [1.5]);
  assert.deepEqual(asked[0].headers, { Authorization: 'Token KEY' });
  await assert.rejects(loadRawBars({ name: 'QQQ', source: 'yahoo', id: 'QQQ' }, d), /Cannot load QQQ from yahoo/);
  assert.ok(asked.slice(1).every((a) => a.url.includes('yahoo.com')));
});

test('the runner loads prices as they traded for Yahoo and Tiingo tickers only, and a failure is a warning', async () => {
  const { d, asked } = network((url) => (url.includes('/BAD?') ? 'nope' : chart(SPLIT)));
  const runner = new Runner(d);
  const r = await runner.loadRaw([
    { name: 'AAPL', source: 'yahoo', id: 'AAPL' },
    { name: 'BTCUSDT', source: 'binance', id: 'BTCUSDT' },
    { name: 'BAD', source: 'yahoo', id: 'BAD' },
  ]);
  assert.deepEqual([...r.data.keys()], ['AAPL']);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^Cannot load BAD from yahoo: .*\. The plugin does not compare the fill prices of BAD\.$/);
  assert.ok(asked.every((a) => !a.url.includes('binance')));
});

// --- From prices as traded to the broker's prices ---------------------------------------------------------------------

const day = (d: number) => Date.UTC(2020, 7, d);

test("a run's adjusted price is converted by its bar's close against the close as traded that day", () => {
  const own = new Map<string, Bars>([['AAPL', bars([99, 100.98, 102.96, 103, 105], { start: day(3) })]]);
  const raw = new Map<string, Bars>([['AAPL', parseYahooRaw(chart(SPLIT), NOW)]]);
  const p = rawPrices(own, raw, new Set(['AAPL']));
  const adjusted = own.get('AAPL');
  // Monday: 400 as traded against 99 adjusted. Thursday, the ex-dividend day, and after it the two agree.
  assert.ok(Math.abs(p.factor('AAPL', adjusted, day(3)) - 400 / 99) < 1e-12);
  assert.equal(p.factor('AAPL', adjusted, day(6)), 1);
  // A day's range is the day's range as traded: 98 to 102 before the split, four times that.
  assert.deepEqual(p.range('AAPL', day(3)), { low: 392, high: 408 });
  assert.equal(p.range('AAPL', day(8)), null);
  // A ticker with no prices as traded, or bars within a day, has no known conversion.
  assert.ok(Number.isNaN(rawPrices(own, new Map(), new Set(['AAPL'])).factor('AAPL', adjusted, day(3))));
  assert.ok(Number.isNaN(p.factor('AAPL', undefined, day(3))));
  const hourly = bars([1, 2, 3], { start: day(3) + 14 * 3_600_000, step: 3_600_000 });
  assert.ok(Number.isNaN(p.factor('AAPL', hourly, day(3) + 15 * 3_600_000)));
});

test("a weekly bar is converted at the last day it covers, and a ticker that is not adjusted keeps the run's prices", () => {
  const weekly = bars([104.5], { start: day(3), step: 7 * DAY });
  const raw = new Map<string, Bars>([['AAPL', parseYahooRaw(chart(SPLIT), NOW)]]);
  // The week's close is Friday's: 105 as traded, for any day of the week.
  const p0 = rawPrices(new Map(), raw, new Set(['AAPL']));
  assert.ok(Math.abs(p0.factor('AAPL', weekly, day(3)) - 105 / 104.5) < 1e-12);
  assert.ok(Math.abs(p0.factor('AAPL', weekly, day(5)) - 105 / 104.5) < 1e-12);
  // The last daily bar covers its own day only, not the days after it.
  const twoDays = bars([99, 100.98], { start: day(3) });
  assert.ok(Math.abs(p0.factor('AAPL', twoDays, day(7)) - 408 / 100.98) < 1e-12);
  // A Binance ticker: factor 1, and the day's range from the run's own bars, hourly ones included.
  const hourly = new Map<string, Bars>([['BTCUSDT', bars([10, 12, 11], { start: day(3), step: 3_600_000, highs: [11, 13, 12], lows: [9, 11, 10] })]]);
  const p = rawPrices(hourly, new Map(), new Set());
  assert.equal(p.factor('BTCUSDT', undefined, day(3)), 1);
  assert.deepEqual(p.range('BTCUSDT', day(3)), { low: 9, high: 13 });
});

test('a fill whose broker price is not known is set against its trade but not compared on price', () => {
  const t = [day(3), day(4), day(5), day(6), day(7)];
  const S: Followed = { label: 'S', alloc: 1, t, equity: t.map(() => 10_000), log: { t: [day(3)], asset: ['AAPL'], kind: ['entry'], sharesAfter: [10], price: [99] } };
  const unknown = { factor: () => NaN, range: () => null };
  // Its shares can't be converted either, so the strategy's 10 are taken as they are.
  const r = matchFills([S], [{ date: day(3), ticker: 'AAPL', side: 'buy', quantity: 10, price: 397, fees: 0, line: 2 }], {
    from: day(3),
    capital: 10_000,
    last: { AAPL: 105 },
    days: { AAPL: t },
    raw: unknown,
  });
  assert.deepEqual([r.rows[0].class, r.rows[0].unpriced, r.rows[0].bps, r.rows[0].slippage], ['on time', true, null, 0]);
  assert.deepEqual(r.suggested, []);
});
