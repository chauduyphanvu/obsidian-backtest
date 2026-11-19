import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { INSIDE_BARS, insideReach, loadBars, loadInsideBars, parseYahooInside, type DataDeps } from '../src/data.ts';
import { parseSpec } from '../src/dsl.ts';
import { insideKey, isInsideKey } from '../src/engine.ts';
import { runSize } from '../src/limits.ts';
import { Runner } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { DAY } from './helpers.ts';

const HOUR = 3_600_000;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
/** After the close of Tuesday 17 November 2026 in New York, when the saved answers were taken during that session. */
const LATE = Date.UTC(2026, 10, 17, 22, 0);
const days = (b: Bars) => [...new Set(b.t.map((t) => new Date(t).toISOString().slice(0, 10)))];

test("Yahoo's hours: whole sessions only, on the exchange's clock, with the day that is still trading left out", () => {
  const b = parseYahooInside(fixture('yahoo-inside-spy-1h.json'), LATE, HOUR);
  // 3 July and 28 November 2025 close early and Yahoo leaves their last bar empty; 30 January 2026 has an hour, then nulls;
  // 17 November 2026 was still trading when the answer was taken, and ends on the latest trade's time.
  assert.deepEqual(days(b), ['2025-07-02', '2025-11-26', '2026-11-16']);
  assert.equal(b.t.length, 21);
  // 13:30 UTC in July and 14:30 in November are both 09:30 in New York; the last hour starts at 15:30.
  const day = (d: string) => b.t.filter((t) => new Date(t).toISOString().startsWith(d)).map((t) => new Date(t).toISOString().slice(11, 16));
  assert.deepEqual(day('2025-07-02'), ['09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:30']);
  assert.deepEqual(day('2026-11-16'), ['09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:30']);
  // The prices are Yahoo's as they come: adjusted for splits, not for dividends.
  assert.deepEqual([b.o[0], b.c[6]], [617.239990234375, 620.3699951171875]);
  // A session that has not ended by `now` is left out, even with every hour so far.
  assert.deepEqual(days(parseYahooInside(fixture('yahoo-inside-spy-1h.json'), Date.UTC(2026, 10, 16, 20, 59), HOUR)), ['2025-07-02', '2025-11-26']);
  // 5-minute bars: 78 of them from 09:30 to 15:55.
  const five = parseYahooInside(fixture('yahoo-inside-spy-5m.json'), LATE, 5 * 60_000);
  assert.equal(five.t.length, 78);
  assert.deepEqual([new Date(five.t[0]).toISOString().slice(11, 16), new Date(five.t[77]).toISOString().slice(11, 16)], ['09:30', '15:55']);
  // Read with the wrong step, the hours do not follow one another: nothing is kept.
  assert.equal(parseYahooInside(fixture('yahoo-inside-spy-1h.json'), LATE, 30 * 60_000).t.length, 0);
  // An older window than Yahoo serves is an error in Yahoo's own words.
  assert.throws(() => parseYahooInside(fixture('yahoo-inside-too-old.json'), LATE, HOUR), /The requested range must be within the last 730 days/);
});

test('how far back smaller bars are loaded from: Yahoo\'s window, 100,000 bars back on Binance, all of Yahoo\'s daily bars', () => {
  const now = Date.UTC(2026, 10, 17, 16, 30);
  assert.equal(insideReach('yahoo', '1h', now), Date.UTC(2026, 10, 17) - 729 * DAY);
  assert.equal(insideReach('yahoo', '5m', now), Date.UTC(2026, 10, 17) - 59 * DAY);
  assert.equal(insideReach('yahoo', '1d', now), 0);
  assert.equal(insideReach('binance', '5m', now), Date.UTC(2026, 10, 17) - INSIDE_BARS * 5 * 60_000);
  assert.equal(INSIDE_BARS * HOUR / (365.25 * DAY) > 11, true);
});

/** Kline rows every `step` from `start` up to `now`. */
function klines(start: number, step: number, now: number): unknown[][] {
  const rows: unknown[][] = [];
  for (let t = start, p = 100; t + step <= now; t += step, p *= 1.0001) rows.push([t, String(p), String(p * 1.01), String(p * 0.99), String(p * 1.0001), '1', t + step - 1]);
  return rows;
}

/** A network with Yahoo's saved answers and Binance klines, which records what it was asked. */
function network(now: () => number, opts: { yahooHours?: string } = {}): DataDeps & { asked: string[]; store: Map<string, string> } {
  const asked: string[] = [];
  const store = new Map<string, string>();
  const start = Date.UTC(2025, 0, 1);
  return {
    asked,
    store,
    fetchText: async (url) => {
      asked.push(url);
      const u = new URL(url);
      if (u.hostname === 'data-api.binance.vision') {
        const step = { '1d': DAY, '1h': HOUR }[u.searchParams.get('interval')!]!;
        const from = Number(u.searchParams.get('startTime'));
        return JSON.stringify(klines(start, step, now()).filter((r) => (r[0] as number) >= from).slice(0, 1000));
      }
      if (u.searchParams.get('interval') === '1h') return opts.yahooHours ?? fixture('yahoo-inside-spy-1h.json');
      return fixture('yahoo-inside-spy-1d.json');
    },
    readVaultFile: async (path) => (path === 'Data/gold.csv' ? 'date,open,high,low,close\n2026-11-13,1,1,1,1\n2026-11-16,1,1,1,1' : null),
    cacheRead: async (k) => store.get(k) ?? null,
    cacheWrite: async (k, v) => void store.set(k, v),
    now,
  };
}

test('the runner loads the hours of each Yahoo and Binance ticker in the universe, and only those, from the run\'s first day', async () => {
  const d = network(() => LATE);
  const { spec, errors } = parseSpec('universe: SPY, binance:BTCUSDT, csv:Data/gold.csv\nbenchmark: QQQ\nfrom: 2026-01-01\nmagnify: 1h\nbuy when close > close[1] of IWM');
  assert.deepEqual(errors, []);
  const { data, prices, warnings } = await new Runner(d).loadPrices(spec!);
  assert.deepEqual(warnings, []);
  assert.deepEqual([...data.keys()].sort(), ['BTCUSDT', insideKey('BTCUSDT', '1h'), 'IWM', 'QQQ', 'SPY', insideKey('SPY', '1h'), 'gold'].sort());
  assert.deepEqual(prices.map((p) => p.name).sort(), ['BTCUSDT', 'IWM', 'QQQ', 'SPY', 'gold']);
  // Yahoo's whole window is asked for, so the saved hours serve any block; the run keeps those from its first day.
  const hours = d.asked.filter((u) => u.includes('interval=1h') && u.includes('yahoo'));
  assert.deepEqual(hours, [`https://query1.finance.yahoo.com/v8/finance/chart/SPY?period1=${(Date.UTC(2026, 10, 17) - 729 * DAY) / 1000}&period2=${LATE / 1000}&interval=1h`]);
  assert.deepEqual(days(data.get(insideKey('SPY', '1h'))!), ['2026-11-16']);
  // Binance's hours start at the run's first day: no history before it is needed.
  const btc = data.get(insideKey('BTCUSDT', '1h'))!;
  assert.equal(btc.t[0], Date.UTC(2026, 0, 1));
  assert.ok(d.asked.some((u) => u.includes('symbol=BTCUSDT&interval=1h&startTime=' + Date.UTC(2026, 0, 1))));
  // Binance's are saved apart from a block's own 1h bars of that market; Yahoo's 1h bars are only ever smaller bars.
  assert.ok(d.store.has('yahoo-SPY-1h') && d.store.has('binance-BTCUSDT-1h-inside') && !d.store.has('binance-BTCUSDT-1h'));
  // The size of the run counts the hours as bars, not as tickers.
  const size = runSize(spec!, data);
  assert.equal(size.tickers, 5);
  assert.equal(size.bars, [...data.values()].reduce((n, b) => n + b.t.length, 0));
});

test('hours that cannot be loaded leave the run as it would be without them, with a warning; a run before the window loads none', async () => {
  const d = network(() => LATE, { yahooHours: fixture('yahoo-inside-too-old.json') });
  const { spec } = parseSpec('universe: SPY\nfrom: 2026-01-01\nmagnify: 1h\nbuy when true');
  const out = await new Runner(d).loadPrices(spec!);
  assert.equal(out.data.has(insideKey('SPY', '1h')), false);
  assert.deepEqual(out.warnings, [
    'Cannot load the 1h bars of SPY from yahoo: 1h data not available for startTime=1731428841 and endTime=1794932841. The requested range must be within the last 730 days. The run did not examine the bars of SPY with smaller bars.',
  ]);
  const old = parseSpec('universe: SPY\nfrom: 2020-01-01\nto: 2021-12-31\nmagnify: 1h\nbuy when true').spec!;
  const asked = d.asked.length;
  const before = await new Runner(d).loadPrices(old);
  assert.deepEqual(before.data.get(insideKey('SPY', '1h')), { t: [], o: [], h: [], l: [], c: [], v: [] });
  assert.ok(d.asked.slice(asked).every((u) => !u.includes('interval=1h')));
});

test('Binance hours are saved only as far back as the most that is loaded, as refreshes add to them', async () => {
  let now = Date.UTC(2025, 0, 11);
  const d = network(() => now);
  const BTC = { name: 'BTCUSDT', source: 'binance' as const, id: 'BTCUSDT' };
  // A keep-from of 5 days back stands for INSIDE_BARS back: older bars are not saved.
  const first = await loadBars(BTC, '1h', Date.UTC(2025, 0, 1), d, false, { keepFrom: now - 5 * DAY });
  assert.equal(first.bars.t[0], now - 5 * DAY);
  let saved = JSON.parse(d.store.get('binance-BTCUSDT-1h')!);
  assert.deepEqual([saved.since, saved.bars.t[0], saved.bars.t.length], [now - 5 * DAY, now - 5 * DAY, 5 * 24]);
  // Two days on, a refresh adds 48 hours and drops the 48 oldest.
  now += 2 * DAY;
  await loadBars(BTC, '1h', now - 5 * DAY, d, true, { keepFrom: now - 5 * DAY });
  saved = JSON.parse(d.store.get('binance-BTCUSDT-1h')!);
  assert.deepEqual([saved.since, saved.bars.t[0], saved.bars.t.length], [now - 5 * DAY, now - 5 * DAY, 5 * 24]);
  // loadInsideBars keeps INSIDE_BARS: with 1h bars that is longer than this market has existed, so everything is kept.
  const all = await loadInsideBars(BTC, '1h', Date.UTC(2025, 0, 1), d, true);
  assert.equal(all.bars.t[0], Date.UTC(2025, 0, 1));
});

test('a CSV file whose name has a space is never taken for smaller bars, nor smaller bars for a ticker', async () => {
  // A benchmark file named "SPY 1h.csv" next to the 1h bars of SPY: before, both were kept under "SPY 1h".
  const csv = 'date,open,high,low,close\n' + ['2025-07-02', '2025-11-26', '2026-11-16', '2026-11-17'].map((d, i) => `${d},${50 + i},${51 + i},${49 + i},${50.5 + i}`).join('\n');
  const d = { ...network(() => LATE), readVaultFile: async (path: string) => (path === 'Data/SPY 1h.csv' ? csv : null) };
  const { spec, errors } = parseSpec('universe: SPY\nbenchmark: csv:Data/SPY 1h.csv\nmagnify: 1h\nstop loss: 2%\nbuy when true');
  assert.deepEqual(errors, []);
  assert.equal(spec!.benchmark!.name, 'SPY 1h');
  const { data } = await new Runner(d).loadPrices(spec!);
  assert.deepEqual(data.get('SPY 1h')!.c, [50.5, 51.5, 52.5, 53.5]);
  assert.equal(data.get(insideKey('SPY', '1h'))!.t.length, 21);
  assert.equal(isInsideKey('SPY 1h'), false);
  assert.equal(isInsideKey(insideKey('SPY 1h', '1h')), true);
  const size = runSize(spec!, data);
  assert.equal(size.tickers, 2);
  const bt = runBacktest(spec!, data);
  assert.equal(bt.benchmark.label, 'SPY 1h buy & hold');
});

test('a block with Binance 15m bars and a block that looks inside with them do not make each other download everything again', async () => {
  const M15 = 900_000;
  let now = Date.UTC(2026, 10, 17, 12);
  const start = Date.UTC(2021, 0, 1);
  const store = new Map<string, string>();
  let pages = 0;
  const d: DataDeps = {
    fetchText: async (url) => {
      const u = new URL(url);
      pages++;
      const step = { '1d': DAY, '15m': M15 }[u.searchParams.get('interval')!]!;
      const from = Math.max(Number(u.searchParams.get('startTime')), start);
      const rows: unknown[][] = [];
      for (let t = Math.ceil((from - start) / step) * step + start; t + step <= now && rows.length < 1000; t += step) rows.push([t, '100', '101', '99', '100.5', '1', t + step - 1]);
      return JSON.stringify(rows);
    },
    readVaultFile: async () => null,
    cacheRead: async (k) => store.get(k) ?? null,
    cacheWrite: async (k, v) => void store.set(k, v),
    now: () => now,
  };
  const plain = parseSpec('data: binance\nuniverse: BTCUSDT\ninterval: 15m\nfrom: 2022-01-01\nbuy when close > sma(20)').spec!;
  const inside = parseSpec('data: binance\nuniverse: BTCUSDT\nfrom: 2022-01-01\nmagnify: 15m\nstop loss: 2%\nbuy when close > sma(20)').spec!;
  const runner = new Runner(d);
  const pagesFor = async (spec: typeof plain) => {
    const before = pages;
    await runner.loadPrices(spec);
    return pages - before;
  };
  // A file saved by the looking inside before it had a file of its own: cut to the latest INSIDE_BARS, under the shared name.
  const keep = insideReach('binance', '15m', now);
  const old = { t: [] as number[], o: [] as number[], h: [] as number[], l: [] as number[], c: [] as number[], v: [] as number[] };
  for (let t = keep; t + M15 <= now - 7 * 3_600_000; t += M15) for (const [k, x] of [['t', t], ['o', 100], ['h', 101], ['l', 99], ['c', 100.5], ['v', 1]] as const) old[k].push(x);
  store.set('binance-BTCUSDT-15m', JSON.stringify({ fetched: now - 7 * 3_600_000, since: keep, bars: old }));
  // Each block loads what it needs once; the old file is too short for the 15m block, which replaces it.
  assert.ok((await pagesFor(plain)) > 170);
  assert.ok((await pagesFor(inside)) >= 100);
  assert.ok(store.has('binance-BTCUSDT-15m-inside'));
  for (let cycle = 0; cycle < 3; cycle++) {
    now += 7 * 3_600_000;
    // After the saved prices go stale, each asks only for what is newer than what it saved: one page each, and a daily one.
    assert.ok((await pagesFor(inside)) <= 2);
    assert.ok((await pagesFor(plain)) <= 1);
  }
  const shared = JSON.parse(store.get('binance-BTCUSDT-15m')!);
  const own = JSON.parse(store.get('binance-BTCUSDT-15m-inside')!);
  assert.ok(shared.since < Date.UTC(2022, 0, 1));
  assert.equal(own.since, insideReach('binance', '15m', now));
  assert.equal(own.bars.t[0], own.since);
});
