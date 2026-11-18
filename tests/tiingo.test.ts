import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { loadBars, loadInsideBars, parseTiingo, parseYahoo, type DataDeps } from '../src/data.ts';
import { parseSpec } from '../src/dsl.ts';
import { insideKey } from '../src/engine.ts';
import { clocksApart } from '../src/evaluate.ts';
import { fixFor } from '../src/fixes.ts';
import { clockOf } from '../src/indicators.ts';
import type { AssetRef, Bars } from '../src/types.ts';
import { bars, DAY } from './helpers.ts';

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const HOUR = 3_600_000;

/** One row of Tiingo's daily prices, at price `p`, adjusted by `f`. */
function row(date: string, p: number, f = 1) {
  return {
    date: `${date}T00:00:00.000Z`,
    close: p,
    high: p + 1,
    low: p - 1,
    open: p - 0.5,
    volume: 1000,
    adjClose: p * f,
    adjHigh: (p + 1) * f,
    adjLow: (p - 1) * f,
    adjOpen: (p - 0.5) * f,
    adjVolume: 1000 / f,
    divCash: 0,
    splitFactor: 1,
  };
}

/** Every Monday to Friday from `from` to `to`, as YYYY-MM-DD. */
function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) if (![0, 6].includes(new Date(t).getUTCDay())) out.push(iso(t));
  return out;
}

const tiingo = (dates: string[], price = (i: number) => 100 + i) => JSON.stringify(dates.map((d, i) => row(d, price(i))));

// ------------------------------------------------------------------------------------------------ reading

test('tiingo bars use the adjusted prices and volume, dated by the exchange day', () => {
  const b = parseTiingo(JSON.stringify([row('2025-03-03', 100, 0.5), row('2025-03-04', 110, 0.5)]), Date.UTC(2025, 3, 1));
  assert.deepEqual(b.t.map(iso), ['2025-03-03', '2025-03-04']);
  assert.deepEqual([b.o[0], b.h[0], b.l[0], b.c[0], b.v[0]], [49.75, 50.5, 49.5, 50, 2000]);
  assert.equal(b.values, undefined);
  // A missing adjusted field is the raw one scaled by adjClose / close; a missing volume is 0.
  const partial = { ...row('2025-03-03', 100, 0.5), adjHigh: null, adjVolume: undefined, volume: null };
  const p = parseTiingo(JSON.stringify([partial]), Date.UTC(2025, 3, 1));
  assert.deepEqual([p.h[0], p.v[0]], [50.5, 0]);
  // A row a price series can't hold is skipped, as for any source.
  assert.equal(parseTiingo(JSON.stringify([{ ...row('2025-03-03', 100), adjClose: 0, adjOpen: 0, adjHigh: 0, adjLow: 0 }]), Date.UTC(2025, 3, 1)).t.length, 0);
});

test("tiingo keeps today's bar once the regular session in New York has closed, in winter and in summer", () => {
  const json = tiingo(['2025-03-06', '2025-03-07', '2025-03-10', '2025-03-11']);
  const days = (now: number) => parseTiingo(json, now).t.map(iso);
  // Friday 7 March 2025, New York on winter time (UTC-5): the session ends at 21:00 UTC.
  assert.deepEqual(days(Date.UTC(2025, 2, 7, 20, 59)), ['2025-03-06']);
  assert.deepEqual(days(Date.UTC(2025, 2, 7, 21, 0)), ['2025-03-06', '2025-03-07']);
  // Monday 10 March, on summer time (UTC-4): it ends at 20:00 UTC. A row after today is never kept.
  assert.deepEqual(days(Date.UTC(2025, 2, 10, 19, 59)), ['2025-03-06', '2025-03-07']);
  assert.deepEqual(days(Date.UTC(2025, 2, 10, 20, 0)), ['2025-03-06', '2025-03-07', '2025-03-10']);
  // At 01:00 UTC on the 11th it is still the 10th in New York.
  assert.deepEqual(days(Date.UTC(2025, 2, 11, 1, 0)), ['2025-03-06', '2025-03-07', '2025-03-10']);
});

test('tiingo weekly bars are dated on the Mondays Yahoo dates its own, from the same weeks', () => {
  // The weeks of the saved Yahoo answer for SPY's weekly bars, read on the same day.
  const fixture = readFileSync(new URL('./fixtures/yahoo-spy-1wk.json', import.meta.url), 'utf8');
  const now = Date.UTC(2026, 10, 17);
  const yahoo = parseYahoo(fixture, now, true).t.map(iso);
  const dates = [...weekdays('2025-02-24', '2025-03-21'), ...weekdays('2025-10-27', '2025-11-14')];
  assert.deepEqual(parseTiingo(tiingo(dates), now, true).t.map(iso), yahoo);
});

test('a tiingo week has its first open, highest high, lowest low, last close and the sum of its volume', () => {
  // Monday 17 February 2025 was a holiday: the week starts on Tuesday, and is still dated Monday.
  const json = JSON.stringify([row('2025-02-18', 100), row('2025-02-19', 104), row('2025-02-20', 98), row('2025-02-21', 101), row('2025-02-24', 120)]);
  const w = parseTiingo(json, Date.UTC(2025, 2, 3, 12), true);
  assert.deepEqual(w.t.map(iso), ['2025-02-17', '2025-02-24']);
  assert.deepEqual([w.o[0], w.h[0], w.l[0], w.c[0], w.v[0]], [99.5, 105, 97, 101, 4000]);
});

test('this week is left out until the Monday after it, in New York', () => {
  const json = tiingo(weekdays('2025-02-24', '2025-03-07'));
  const weeks = (now: number) => parseTiingo(json, now, true).t.map(iso);
  // Friday evening and Sunday: the week of 3 March is not over in New York until Monday.
  assert.deepEqual(weeks(Date.UTC(2025, 2, 7, 22)), ['2025-02-24']);
  assert.deepEqual(weeks(Date.UTC(2025, 2, 10, 3)), ['2025-02-24']);
  assert.deepEqual(weeks(Date.UTC(2025, 2, 10, 5)), ['2025-02-24', '2025-03-03']);
});

test('tiingo explains a problem in a JSON detail', () => {
  assert.throws(() => parseTiingo(JSON.stringify({ detail: 'Not found.' }), 0), /^Error: Not found\.$/);
  assert.throws(() => parseTiingo('{}', 0), /Tiingo returned no data/);
});

// ------------------------------------------------------------------------------------------------ loading

const KEY = 'tiingo-key-0123456789abcdef0123456789abcdef';
const SPY: AssetRef = { name: 'SPY', source: 'tiingo', id: 'SPY' };
const NOW = Date.UTC(2025, 2, 12, 12);
const DAILY = tiingo(weekdays('2025-02-03', '2025-03-11'));

interface Call {
  url: string;
  headers?: Record<string, string>;
}

/** Deps whose network answers `answer` for each request and records it; every request to Yahoo fails unless it says otherwise. */
function deps(answer: (url: string) => Promise<string>, over: Partial<DataDeps> = {}) {
  const cache = new Map<string, string>();
  const calls: Call[] = [];
  const d: DataDeps = {
    fetchText: async (url, headers) => {
      calls.push(headers ? { url, headers } : { url });
      return answer(url);
    },
    readVaultFile: async () => null,
    cacheRead: async (k) => cache.get(k) ?? null,
    cacheWrite: async (k, v) => void cache.set(k, v),
    now: () => NOW,
    secret: (service) => (service === 'tiingo' ? KEY : null),
    ...over,
  };
  return { d, calls, cache };
}

test('a tiingo ticker is asked for its whole daily history, with the key in the Authorization header only', async () => {
  const { d, calls, cache } = deps(async () => DAILY);
  const r = await loadBars(SPY, '1d', Date.UTC(2025, 0, 1), d);
  assert.deepEqual(calls, [{ url: 'https://api.tiingo.com/tiingo/daily/SPY/prices?startDate=1900-01-01&resampleFreq=daily', headers: { Authorization: `Token ${KEY}` } }]);
  assert.deepEqual([r.source, iso(r.through), r.stale, r.warning, r.note], ['tiingo', '2025-03-11', false, null, null]);
  assert.deepEqual([...cache.keys()], ['tiingo-SPY-1d']);
  // Weekly bars are their own download and their own file, as Yahoo's are.
  const w = await loadBars(SPY, '1w', 0, d);
  assert.deepEqual(w.bars.t.map(iso).slice(-2), ['2025-02-24', '2025-03-03']);
  assert.deepEqual([...cache.keys()], ['tiingo-SPY-1d', 'tiingo-SPY-1w']);
  // Tiingo serves whole histories, so a saved copy serves a run that starts earlier, as Yahoo's does.
  await loadBars(SPY, '1d', 0, d);
  assert.equal(calls.length, 2);
});

test('tiingo: a ticker it does not know is final, a rejected key and a broken answer are not', async () => {
  const missing = deps(async () => JSON.stringify({ detail: 'Error: Ticker \'XYZ\' not found' }));
  await assert.rejects(loadBars({ name: 'XYZ', source: 'tiingo', id: 'XYZ' }, '1d', 0, missing.d), { message: 'Tiingo has no prices for XYZ. Check the ticker.' });
  const rejected = deps(async () => JSON.stringify({ detail: 'Invalid token.' }));
  await assert.rejects(loadBars(SPY, '1d', 0, rejected.d), {
    message: 'Couldn\'t load SPY from tiingo: Tiingo did not accept the API key. Check the secret chosen under "Tiingo API key" in the plugin settings',
  });
  const other = deps(async () => JSON.stringify({ detail: 'You have run over your hourly request allocation.' }));
  await assert.rejects(loadBars(SPY, '1d', 0, other.d), { message: "Couldn't load SPY from tiingo: Tiingo said: You have run over your hourly request allocation." });
  const html = deps(async () => '<html>Bad gateway</html>');
  await assert.rejects(loadBars(SPY, '1d', 0, html.d), { message: "Couldn't load SPY from tiingo: Tiingo sent something other than price data" });
});

test('tiingo without a key asks nothing and names the setting; with a saved copy it uses that copy', async () => {
  const none = deps(async () => DAILY, { secret: () => null });
  const message = 'Tiingo needs an API key to load SPY. Choose the secret that holds it under "Tiingo API key" in the plugin settings.';
  await assert.rejects(loadBars(SPY, '1d', 0, none.d), { message });
  assert.equal(none.calls.length, 0);
  // Deps with no secret storage at all are the same as no key.
  const bare = deps(async () => DAILY, { secret: undefined });
  await assert.rejects(loadBars(SPY, '1d', 0, bare.d), { message });
  const saved = deps(async () => DAILY);
  await loadBars(SPY, '1d', 0, saved.d);
  const later = deps(async () => DAILY, { secret: () => '  ', now: () => NOW + 7 * HOUR, cacheRead: saved.d.cacheRead });
  const r = await loadBars(SPY, '1d', 0, later.d);
  assert.equal(r.stale, true);
  assert.equal(r.warning, `Couldn't refresh SPY (${message}); using prices saved on 2025-03-12.`);
});

// ------------------------------------------------------------------------------------------------ in place of Yahoo

const YSPY: AssetRef = { name: 'SPY', source: 'yahoo', id: 'SPY' };
const YAHOO = JSON.stringify({
  chart: { result: [{ meta: { gmtoffset: -18000 }, timestamp: [Date.UTC(2025, 2, 3, 14, 30) / 1000], indicators: { quote: [{ open: [500], high: [501], low: [499], close: [500], volume: [10] }], adjclose: [{ adjclose: [500] }] } }] },
});
const NOT_FOUND = JSON.stringify({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } });

/** The network of these tests: Yahoo as `yahoo` says (down by default), Tiingo as `tiingoAnswer` says. */
function network(o: { yahoo?: () => Promise<string>; tiingoAnswer?: () => Promise<string>; fallback?: boolean; over?: Partial<DataDeps> } = {}) {
  const t = deps(
    (url) => {
      if (url.includes('finance.yahoo.com')) return o.yahoo ? o.yahoo() : Promise.reject(new Error('HTTP 503'));
      return o.tiingoAnswer ? o.tiingoAnswer() : Promise.resolve(DAILY);
    },
    { tiingoFallback: () => o.fallback ?? true, ...o.over },
  );
  const toTiingo = () => t.calls.filter((c) => c.url.startsWith('https://api.tiingo.com/')).length;
  return { ...t, toTiingo };
}

/** A saved Yahoo copy of SPY's daily bars, fetched `age` before NOW. */
async function savedYahoo(n: ReturnType<typeof network>, age: number): Promise<void> {
  n.cache.set('yahoo-SPY-1d', JSON.stringify({ fetched: NOW - age, since: 0, bars: parseYahoo(YAHOO, NOW) }));
}

test('with the setting off, Tiingo never stands in for Yahoo', async () => {
  const n = network({ fallback: false });
  await assert.rejects(loadBars(YSPY, '1d', 0, n.d), { message: "Couldn't load SPY from yahoo: HTTP 503" });
  assert.equal(n.toTiingo(), 0);
  const unset = network({ over: { tiingoFallback: undefined } });
  await assert.rejects(loadBars(YSPY, '1d', 0, unset.d), { message: "Couldn't load SPY from yahoo: HTTP 503" });
  assert.equal(unset.toTiingo(), 0);
});

test('when Yahoo fails and nothing is saved, Tiingo stands in, says so, and is named as the source', async () => {
  const n = network();
  const r = await loadBars(YSPY, '1d', 0, n.d);
  assert.equal(n.toTiingo(), 1);
  assert.deepEqual([r.source, r.stale, iso(r.through)], ['tiingo', false, '2025-03-11']);
  assert.equal(r.warning, "Couldn't load SPY from Yahoo (HTTP 503); using Tiingo's prices instead.");
  // Tiingo's prices are saved under Tiingo's name, never as Yahoo's.
  assert.deepEqual([...n.cache.keys()], ['tiingo-SPY-1d']);
  // A fresh Tiingo copy stands in again without a request; a refresh asks Tiingo again.
  await loadBars(YSPY, '1d', 0, n.d);
  assert.equal(n.toTiingo(), 1);
  await loadBars(YSPY, '1d', 0, n.d, true);
  assert.equal(n.toTiingo(), 2);
});

test('a saved Yahoo copy under 3 days old comes before Tiingo, and an older one after it', async () => {
  const young = network();
  await savedYahoo(young, 2 * DAY);
  const a = await loadBars(YSPY, '1d', 0, young.d);
  assert.deepEqual([a.source, a.stale, a.warning], ['yahoo', true, "Couldn't refresh SPY (HTTP 503); using prices saved on 2025-03-10."]);
  assert.equal(young.toTiingo(), 0);

  const old = network();
  await savedYahoo(old, 4 * DAY);
  const b = await loadBars(YSPY, '1d', 0, old.d);
  assert.deepEqual([b.source, b.stale], ['tiingo', false]);

  const both = network({ tiingoAnswer: () => Promise.reject(new Error('HTTP 500')) });
  await savedYahoo(both, 4 * DAY);
  const c = await loadBars(YSPY, '1d', 0, both.d);
  assert.deepEqual([c.source, c.stale, c.warning], ['yahoo', true, "Couldn't refresh SPY (HTTP 503); using prices saved on 2025-03-08."]);
  assert.equal(both.toTiingo(), 1);
});

test('when Tiingo cannot stand in either, the message says why', async () => {
  const down = network({ tiingoAnswer: () => Promise.reject(new Error('HTTP 500')) });
  await assert.rejects(loadBars(YSPY, '1d', 0, down.d), { message: "Couldn't load SPY from yahoo: HTTP 503. Tiingo could not stand in: HTTP 500" });
  const keyless = network({ over: { secret: () => null } });
  await assert.rejects(loadBars(YSPY, '1d', 0, keyless.d), {
    message: 'Couldn\'t load SPY from yahoo: HTTP 503. Tiingo could not stand in: Tiingo needs an API key to load SPY. Choose the secret that holds it under "Tiingo API key" in the plugin settings.',
  });
  assert.equal(keyless.toTiingo(), 0);
  // An old Tiingo copy, with nothing from Yahoo, is better than nothing.
  const stale = network({ tiingoAnswer: () => Promise.reject(new Error('HTTP 500')) });
  stale.cache.set('tiingo-SPY-1d', JSON.stringify({ fetched: NOW - 2 * DAY, since: 0, bars: parseTiingo(DAILY, NOW) }));
  const r = await loadBars(YSPY, '1d', 0, stale.d);
  assert.deepEqual([r.source, r.stale, r.warning], ['tiingo', true, "Couldn't load SPY from Yahoo (HTTP 503) or Tiingo; using Tiingo's prices saved on 2025-03-10."]);
});

test('Tiingo does not stand in for a ticker Yahoo does not know, for one that is not a US listing, or for smaller bars', async () => {
  const unknown = network({ yahoo: () => Promise.resolve(NOT_FOUND) });
  await assert.rejects(loadBars({ name: 'XYZ', source: 'yahoo', id: 'XYZ' }, '1d', 0, unknown.d), { message: 'Yahoo has no prices for XYZ. Check the ticker.' });
  assert.equal(unknown.toTiingo(), 0);
  for (const id of ['^GSPC', 'SHOP.TO', 'BTC-USD', 'EURUSD=X', 'ES=F', 'VOD.L']) {
    const n = network();
    await assert.rejects(loadBars({ name: id, source: 'yahoo', id }, '1d', 0, n.d), { message: `Couldn't load ${id} from yahoo: HTTP 503` });
    assert.equal(n.toTiingo(), 0, id);
  }
  for (const id of ['BRK-B', 'VFIAX', 'BF-A']) {
    const n = network();
    assert.equal((await loadBars({ name: id, source: 'yahoo', id }, '1w', 0, n.d)).source, 'tiingo', id);
  }
  // Inside bars: Tiingo has no hourly bars, and its daily bars inside Yahoo's weekly ones would not match them.
  for (const size of ['1h', '1d']) {
    const n = network();
    await assert.rejects(loadInsideBars(YSPY, size, Date.UTC(2025, 0, 1), n.d));
    assert.equal(n.toTiingo(), 0, size);
  }
});

// ------------------------------------------------------------------------------------------------ the language

const errorsOf = (src: string) => parseSpec(src).errors.map((e) => e.message);

test('tiingo: tickers and data: tiingo read as Tiingo tickers, on 1d and 1w bars only', () => {
  const { spec } = parseSpec('universe: tiingo:spy, QQQ\ndata: tiingo\nbuy when true');
  assert.deepEqual(spec!.universe.map((a) => [a.name, a.source, a.id]), [['SPY', 'tiingo', 'SPY'], ['QQQ', 'tiingo', 'QQQ']]);
  assert.equal(parseSpec('universe: QQQ\nbuy when true', { defaults: { dataSource: 'tiingo' } }).spec!.universe[0].source, 'tiingo');
  assert.deepEqual(errorsOf('universe: tiingo:SPY\ninterval: 1w\nbuy when true'), []);
  assert.deepEqual(errorsOf('universe: tiingo:SPY\ninterval: 1h\nbuy when true'), ['Tiingo data comes as 1d or 1w bars, not "1h"']);
  assert.deepEqual(errorsOf('universe: tiingo:SPY\nbenchmark: binance:BTCUSDT\ninterval: 1h\nbuy when true'), ['Tiingo data comes as 1d or 1w bars, not "1h"']);
  assert.deepEqual(errorsOf('universe: SPY\ndata: tiingoo\nbuy when true'), ['data must be one of: yahoo, binance, tiingo']);
});

test('did you mean: a misspelt data: tiingo and a wrong interval for Tiingo', () => {
  const at = (lines: string[]) => {
    const d = parseSpec(lines.join('\n')).errors[0];
    return fixFor(lines, d)?.hint ?? null;
  };
  assert.equal(at(['universe: SPY', 'data: tiingoo', 'buy when true']), 'Did you mean tiingo?');
  assert.equal(at(['universe: tiingo:SPY', 'interval: 1dd', 'buy when true']), 'Did you mean 1d?');
});

test('a fixed price level warns for Tiingo, which adjusts its prices too, and names both sources when both are read', () => {
  const warn = (src: string) => parseSpec(src).warnings.map((w) => w.message);
  const tail = 'prices are adjusted for later dividends and splits, so old prices are lower than what actually traded.';
  assert.deepEqual(warn('universe: tiingo:SPY\nbuy when close > 100'), [`This compares a price with a fixed number. Tiingo ${tail}`]);
  assert.deepEqual(warn('universe: SPY, tiingo:QQQ\nbuy when close > 100'), [`This compares a price with a fixed number. Yahoo and Tiingo ${tail}`]);
  assert.deepEqual(warn('universe: SPY\nbuy when close > 100'), [`This compares a price with a fixed number. Yahoo ${tail}`]);
});

test('magnify has no smaller bars to look inside a Tiingo ticker with, and says so', () => {
  assert.deepEqual(errorsOf('universe: tiingo:SPY\nmagnify: 1h\nbuy when true'), ['magnify looks inside bars with smaller bars from Yahoo or Binance, and Tiingo has none here']);
  assert.deepEqual(errorsOf('universe: tiingo:SPY, csv:Data/a.csv\nmagnify: 1h\nbuy when true'), [
    'magnify looks inside bars with smaller bars from Yahoo or Binance, and Tiingo and CSV files have none here',
  ]);
  const both = bars([100, 100, 100, 100, 100]);
  const { spec } = parseSpec('universe: A, tiingo:QQQ\ncapital: 1000\nstop loss: 10%\nbuy when true\nmagnify: 1h');
  const bt = runBacktest(spec!, new Map<string, Bars>([['A', both], ['QQQ', both], [insideKey('A', '1h'), { t: [], o: [], h: [], l: [], c: [], v: [] }]]));
  assert.ok(bt.notes.includes('QQQ comes from Tiingo, which gives no smaller bars here, so its bars are read whole.'));
});

test('Tiingo and Yahoo keep one clock, so with fill: close one reads the other at the same close', () => {
  const t = bars([1, 2, 3]).t;
  assert.equal(clockOf('tiingo', t), clockOf('yahoo', t));
  assert.notEqual(clockOf('binance', t), clockOf('yahoo', t));
  const { spec } = parseSpec('universe: tiingo:SPY\nfill: close\nbuy when close of QQQ > 1');
  const data = new Map([['SPY', bars([1, 2, 3])], ['QQQ', bars([1, 2, 3])]]);
  assert.equal(clocksApart(spec!, data)!('QQQ', 'SPY'), false);
});
