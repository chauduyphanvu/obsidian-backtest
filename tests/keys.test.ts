import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { complete, localTickers } from '../src/complete.ts';
import { KEY_SETTING, loadBars, withoutQueries, type DataDeps } from '../src/data.ts';
import { helpAt } from '../src/docs.ts';
import { parseSpec } from '../src/dsl.ts';
import { tokenizeBlock } from '../src/highlight.ts';
import { SYSTEM_PROMPT } from '../src/llm.ts';
import { PriceStore, type PriceFiles } from '../src/price-store.ts';
import { Runner } from '../src/runner.ts';
import { DEFAULT_SETTINGS, defaultsFrom, normalizeSettings, validateSetting } from '../src/settings-core.ts';
import { SymbolLookup, blockSource, blockTickers } from '../src/symbols.ts';
import type { AssetRef, KeyedService } from '../src/types.ts';
import { DAY } from './helpers.ts';

const FRED_KEY = 'abcdef0123456789abcdef0123456789';
const TIINGO_KEY = '0123456789abcdef0123456789abcdef01234567';
const KEYS: Record<KeyedService, string> = { fred: FRED_KEY, tiingo: TIINGO_KEY };
const NOW = Date.UTC(2025, 2, 12, 12);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const readme = readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8');

/**
 * A stand-in for FRED holding one series, from [date, first published, value] rows, answering as FRED did on 2026-11-17:
 * its publication days (vintage dates); the series as it stood on a day; and each observation as first released
 * (`output_type=4`) within a real-time period, which leaves out what the first day published, and is refused for a period
 * with more than 2,000 publication days.
 */
function fredAnswer(rows: [string, string, string][]): (url: string) => Promise<string> {
  const days = [...new Set(rows.map((r) => r[1]))].sort();
  return async (url) => {
    const q = new URL(url).searchParams;
    if (url.includes('/series/vintagedates?')) {
      const offset = Number(q.get('offset') ?? 0);
      const limit = Number(q.get('limit') ?? 10000);
      return JSON.stringify({ count: days.length, offset, limit, vintage_dates: days.slice(offset, offset + limit) });
    }
    const start = q.get('realtime_start') ?? days[days.length - 1];
    const end = q.get('realtime_end') ?? '9999-12-31';
    const asRow = ([date, , value]: [string, string, string], from: string) => ({ realtime_start: from, realtime_end: end, date, value });
    if (q.get('output_type') !== '4') {
      return JSON.stringify({ observations: rows.filter((r) => r[1] <= end).map((r) => asRow(r, start)) });
    }
    const within = days.filter((d) => d >= start && d <= end).length;
    if (within > 2000) {
      return JSON.stringify({
        error_code: 400,
        error_message: `Bad Request.  There are ${within} vintage dates in the specified real-time period: ${start} to ${end}.  This exceeds the maximum number of vintage dates allowed for this file type (2000).`,
      });
    }
    return JSON.stringify({ observations: rows.filter((r) => r[1] !== days[0] && r[1] >= start && r[1] <= end).map((r) => asRow(r, r[1])) });
  };
}

/** Daily FRED observations, each first published the next day, for the `n` days to 10 March 2025. */
function dailyRows(n: number, value = (i: number) => (i % 7) - 3): [string, string, string][] {
  const rows: [string, string, string][] = [];
  for (let i = 0; i < n; i++) {
    const d = Date.UTC(2025, 2, 10) - (n - 1 - i) * DAY;
    rows.push([iso(d), iso(d + DAY), String(value(i))]);
  }
  return rows;
}
const daily = (n: number) => fredAnswer(dailyRows(n));

const tiingoRows = (n: number) =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => {
      const p = 100 + (i % 9);
      const date = iso(Date.UTC(2025, 2, 11) - (n - 1 - i) * DAY);
      return { date: `${date}T00:00:00.000Z`, close: p, high: p + 1, low: p - 1, open: p, volume: 10, adjClose: p, adjHigh: p + 1, adjLow: p - 1, adjOpen: p, adjVolume: 10 };
    }),
  );

interface Recorded {
  requests: { url: string; headers?: Record<string, string> }[];
  writes: { key: string; text: string }[];
}

/** Deps that answer FRED, Tiingo and Yahoo as `answer` says, and record every request and every file written. */
function recording(answer: (url: string) => Promise<string>, over: Partial<DataDeps> = {}): { d: DataDeps; seen: Recorded; cache: Map<string, string> } {
  const seen: Recorded = { requests: [], writes: [] };
  const cache = new Map<string, string>();
  const d: DataDeps = {
    fetchText: async (url, headers) => {
      seen.requests.push(headers ? { url, headers } : { url });
      return answer(url);
    },
    readVaultFile: async () => null,
    cacheRead: async (k) => cache.get(k) ?? null,
    cacheWrite: async (k, v) => {
      seen.writes.push({ key: k, text: v });
      cache.set(k, v);
    },
    now: () => NOW,
    secret: (service) => KEYS[service],
    tiingoFallback: () => true,
    ...over,
  };
  return { d, seen, cache };
}

const FRED: AssetRef = { name: 'T10Y2Y', source: 'fred', id: 'T10Y2Y' };

// ------------------------------------------------------------------------------------------------ loading FRED

test('a FRED series is asked for by its publication days: as it stood on the first, then as first released, with the key only in the query, and saved under its ID', async () => {
  const { d, seen, cache } = recording(daily(30));
  const r = await loadBars(FRED, '1d', 0, d);
  const base = `https://api.stlouisfed.org/fred/series/%s?series_id=T10Y2Y&api_key=${FRED_KEY}&file_type=json`;
  assert.deepEqual(seen.requests, [
    { url: `${base.replace('%s', 'vintagedates')}&limit=10000&offset=0` },
    { url: `${base.replace('%s', 'observations')}&realtime_start=2025-02-10&realtime_end=2025-02-10` },
    { url: `${base.replace('%s', 'observations')}&output_type=4&realtime_start=2025-02-10&realtime_end=9999-12-31` },
  ]);
  assert.deepEqual([r.source, r.stale, r.warning, r.bars.values, iso(r.through)], ['fred', false, null, true, '2025-03-11']);
  assert.deepEqual([...cache.keys()], ['fred-T10Y2Y']);
  // The same series serves every interval from the one file.
  await loadBars(FRED, '1h', 0, d);
  await loadBars(FRED, '1w', 0, d);
  assert.equal(seen.requests.length, 3);
});

test('a daily series with more publication days than FRED answers for at once is asked for a window of days at a time, with what its first day held', async () => {
  // FRED has DGS3MO from 1982, but ALFRED from 2005: its first day there held 23 years, then each day added one value.
  const first = '2005-06-28';
  const rows: [string, string, string][] = [];
  for (let t = Date.UTC(1982, 0, 4); t < Date.parse(first); t += 7 * DAY) rows.push([iso(t), first, '5']);
  for (let i = 0; i < 3500; i++) {
    const d = Date.parse(first) + i * DAY;
    rows.push([iso(d), iso(d + DAY), String(1 + (i % 5))]);
  }
  const { d, seen } = recording(fredAnswer(rows));
  const r = await loadBars({ name: 'DGS3MO', source: 'fred', id: 'DGS3MO' }, '1d', 0, d);
  assert.equal(iso(r.bars.t[0]).slice(0, 4), '1982');
  assert.equal(r.bars.c[r.bars.c.length - 1], 1 + (3499 % 5));
  // Its publication days, its first day, then three windows of first releases.
  assert.equal(seen.requests.length, 5);
  assert.match(r.note!, /^FRED first published \d+ values of DGS3MO \(dated 1982-01-04 to 2005-06-2\d\) together on 2005-06-28/);
});

test('whether bars are values comes from the source, never from a saved file', async () => {
  const { d, cache } = recording(daily(30));
  await loadBars(FRED, '1d', 0, d);
  const saved = JSON.parse(cache.get('fred-T10Y2Y')!);
  delete saved.bars.values;
  cache.set('fred-T10Y2Y', JSON.stringify(saved));
  assert.equal((await loadBars(FRED, '1d', 0, d)).bars.values, true);
  // A saved Yahoo file that says it holds values is read as prices.
  cache.set('yahoo-SPY-1d', JSON.stringify({ fetched: NOW, since: 0, bars: { ...saved.bars, values: true } }));
  const spy = await loadBars({ name: 'SPY', source: 'yahoo', id: 'SPY' }, '1d', 0, d);
  assert.equal(spy.bars.values, undefined);
  assert.equal('values' in spy.bars, false);
});

test('the note on a backfill comes with the series, fresh or saved, and is not a warning', async () => {
  const rows: [string, string, string][] = Array.from({ length: 8 }, (_, i) => [iso(Date.UTC(2024, i, 1)), '2024-10-01', String(i)]);
  rows.push(['2024-09-01', '2024-10-04', '9'], ['2024-10-01', '2024-11-08', '10']);
  const { d, cache } = recording(fredAnswer(rows));
  const fresh = await loadBars({ name: 'UNRATE', source: 'fred', id: 'UNRATE' }, '1d', 0, d);
  assert.match(fresh.note!, /^FRED first published 8 values of UNRATE \(dated 2024-01-01 to 2024-08-01\) together on 2024-10-01/);
  assert.equal(fresh.warning, null);
  assert.equal(JSON.parse(cache.get('fred-UNRATE')!).note, fresh.note);
  const again = await loadBars({ name: 'UNRATE', source: 'fred', id: 'UNRATE' }, '1d', 0, d);
  assert.equal(again.note, fresh.note);
});

test('FRED: a series it does not know is final; a rejected key, another error and a broken answer are not', async () => {
  const missing = recording(async () => JSON.stringify({ error_code: 400, error_message: 'Bad Request.  The series does not exist.' }));
  await assert.rejects(loadBars({ name: 'XYZ', source: 'fred', id: 'XYZ' }, '1d', 0, missing.d), { message: 'FRED has no series called XYZ. Check the series ID, such as T10Y2Y.' });
  const key = recording(async () =>
    JSON.stringify({ error_code: 400, error_message: 'Bad Request.  The value for variable api_key is not registered.  Read https://fred.stlouisfed.org/docs/api/api_key.html for more information.' }),
  );
  await assert.rejects(loadBars(FRED, '1d', 0, key.d), {
    message: 'Couldn\'t load T10Y2Y from fred: FRED did not accept the API key. Check the secret chosen under "FRED API key" in the plugin settings',
  });
  const busy = recording(async () => JSON.stringify({ error_code: 429, error_message: 'Too Many Requests.   Exceeded Rate Limit' }));
  await assert.rejects(loadBars(FRED, '1d', 0, busy.d), { message: "Couldn't load T10Y2Y from fred: FRED said: Too Many Requests. Exceeded Rate Limit" });
  const html = recording(async () => '<html>503</html>');
  await assert.rejects(loadBars(FRED, '1d', 0, html.d), { message: "Couldn't load T10Y2Y from fred: FRED sent something other than series data" });
});

test('FRED without a key asks nothing and names the setting', async () => {
  const { d, seen } = recording(daily(5), { secret: () => null });
  await assert.rejects(loadBars(FRED, '1d', 0, d), { message: 'FRED needs an API key to load T10Y2Y. Choose the secret that holds it under "FRED API key" in the plugin settings.' });
  assert.equal(seen.requests.length, 0);
});

// ------------------------------------------------------------------------------------------------ where the keys go

/** Every place a key could leak to that is not the request carrying it. */
function leaks(seen: Recorded, others: unknown[]): string[] {
  const out: string[] = [];
  const look = (where: string, text: string) => {
    for (const [service, key] of Object.entries(KEYS)) if (text.includes(key)) out.push(`${service} key in ${where}`);
  };
  for (const w of seen.writes) {
    look(`the file name ${w.key}`, w.key);
    look(`the file ${w.key}`, w.text);
  }
  for (const r of seen.requests) {
    // The FRED key may only be the api_key of a FRED request, and the Tiingo key only the Authorization header of a Tiingo one.
    const url = new URL(r.url);
    const query = new URLSearchParams(url.search);
    if (url.hostname === 'api.stlouisfed.org') query.delete('api_key');
    look(`the address ${url.hostname}${url.pathname}?${query}`, `${url.hostname}${url.pathname}?${query}`);
    for (const [name, value] of Object.entries(r.headers ?? {})) {
      if (url.hostname === 'api.tiingo.com' && name === 'Authorization') {
        assert.equal(value, `Token ${TIINGO_KEY}`);
        continue;
      }
      look(`the header ${name} to ${url.hostname}`, value);
    }
  }
  others.forEach((o, i) => look(`thing ${i} (${JSON.stringify(o).slice(0, 80)})`, JSON.stringify(o, (_k, v) => (v instanceof Map ? [...v] : v))));
  return out;
}

test('a run with Tiingo, FRED and Tiingo standing in for Yahoo puts the keys in the requests that carry them and nowhere else', async () => {
  const { d, seen } = recording(async (url) => {
    if (url.includes('finance.yahoo.com')) throw new Error('HTTP 503');
    if (url.includes('api.tiingo.com')) return tiingoRows(400);
    return daily(400)(url);
  });
  const block = 'universe: tiingo:SPY, QQQ\ncash rate: fred:DGS3MO\nfrom: 2024-12-01\nbuy when close of fred:T10Y2Y > 0';
  const runner = new Runner(d, defaultsFrom({ ...DEFAULT_SETTINGS, tiingoSecret: 'tiingo-secret', fredSecret: 'fred-secret' }));
  const { spec, errors } = runner.parse(block);
  assert.deepEqual(errors, []);
  const out = await runner.run(spec!);
  // Both keys went out, each where its service takes it: FRED's in the three requests of each series, Tiingo's for SPY
  // and for QQQ in Yahoo's place.
  assert.equal(seen.requests.filter((r) => r.url.includes(`api_key=${FRED_KEY}`)).length, 6);
  assert.equal(seen.requests.filter((r) => r.headers?.Authorization === `Token ${TIINGO_KEY}`).length, 2);
  assert.deepEqual(
    out.prices.map((p) => [p.name, p.source]),
    [['SPY', 'tiingo'], ['QQQ', 'tiingo'], ['T10Y2Y', 'fred'], ['DGS3MO', 'fred']],
  );
  assert.deepEqual(out.warnings, ["Couldn't load QQQ from Yahoo (HTTP 503); using Tiingo's prices instead."]);
  assert.deepEqual(leaks(seen, [out.spec, out.warnings, out.notes, out.prices, [...out.data], out.backtest.notes, runner.parse(block)]), []);
});

test('no error from a keyed request carries a key, or the query of the address it went to', async () => {
  const messages: string[] = [];
  const answers: ((url: string) => Promise<string>)[] = [
    // A network error that quotes the address, as some do.
    async (url) => {
      throw new Error(`net::ERR_CONNECTION_RESET at ${url}`);
    },
    async () => JSON.stringify({ error_code: 500, error_message: `Internal error for api_key=${FRED_KEY}` }),
    async () => JSON.stringify({ error_code: 500, error_message: `Something went wrong with ${FRED_KEY}` }),
    async () => JSON.stringify({ detail: `Request limit reached for ${TIINGO_KEY}` }),
    async (url) => `<html>Gateway timeout for ${url}</html>`,
    async () => `{"broken": "${FRED_KEY}`,
    async () => `[{"date": "${TIINGO_KEY}`,
  ];
  for (const answer of answers) {
    for (const ref of [FRED, { name: 'SPY', source: 'tiingo' as const, id: 'SPY' }]) {
      const { d, seen } = recording(answer);
      await loadBars(ref, '1d', 0, d).then(
        () => assert.fail('it should fail'),
        (e: Error) => messages.push(e.message),
      );
      assert.deepEqual(leaks(seen, []), []);
    }
  }
  assert.equal(messages.length, 14);
  for (const m of messages) {
    assert.ok(!m.includes(FRED_KEY) && !m.includes(TIINGO_KEY), m);
    assert.ok(!/https?:\/\/\S*\?/.test(m), m);
  }
  assert.ok(messages.includes("Couldn't load T10Y2Y from fred: net::ERR_CONNECTION_RESET at https://api.stlouisfed.org/fred/series/vintagedates"));
  assert.ok(messages.includes("Couldn't load T10Y2Y from fred: FRED said: Something went wrong with …"));
});

test('a saved copy used after a failed refresh says why without the key', async () => {
  const { d, cache } = recording(daily(30));
  await loadBars(FRED, '1d', 0, d);
  const later = recording(
    async (url) => {
      throw new Error(`timeout ${url}`);
    },
    { now: () => NOW + DAY, cacheRead: async (k) => cache.get(k) ?? null },
  );
  const r = await loadBars(FRED, '1d', 0, later.d);
  assert.equal(r.warning, "Couldn't refresh T10Y2Y (timeout https://api.stlouisfed.org/fred/series/vintagedates); using prices saved on 2025-03-12.");
});

test("a FRED series keeps the history its rules need counted in its own rows, as a CSV file does", async () => {
  // A monthly series from 1990, first published 14 days after each month: a daily run's 250 bars of history would hold
  // only a dozen of its rows.
  const months: [string, string, string][] = Array.from({ length: 420 }, (_, i) => [iso(Date.UTC(1990, i, 1)), iso(Date.UTC(1990, i + 1, 14)), String(4 + (i % 5))]);
  const { d } = recording(fredAnswer(months));
  const { spec, errors } = parseSpec('universe: SPY\nfrom: 2020-01-01\nbuy when sma(close, 12) of fred:UNRATE < 6');
  assert.deepEqual(errors, []);
  const spy = JSON.stringify({ fetched: NOW, since: 0, bars: { t: [Date.UTC(2019, 0, 2), Date.UTC(2020, 0, 2)], o: [1, 1], h: [1, 1], l: [1, 1], c: [1, 1], v: [1, 1] } });
  const { data } = await new Runner({ ...d, cacheRead: async (k) => (k === 'yahoo-SPY-1d' ? spy : null) }).loadPrices(spec!);
  const rows = data.get('UNRATE')!;
  assert.equal(rows.values, true);
  assert.ok(rows.t.filter((t) => t < spec!.from!).length >= 250, `${rows.t.length} rows`);
  // Prices are cut at the run's own lookback as before.
  assert.equal(data.get('SPY')!.t.length, 2);
});

test('the plugin setting for interest on cash takes a FRED yield', () => {
  assert.equal(validateSetting('cashRate', 'fred:DGS3MO'), null);
  assert.equal(normalizeSettings({ cashRate: 'fred:DGS3MO' }).cashRate, 'fred:DGS3MO');
  assert.match(validateSetting('cashRate', 'fred:') ?? '', /is not a ticker/);
});

test('withoutQueries takes the query off every web address in a message and leaves the rest', () => {
  assert.equal(withoutQueries('GET https://api.stlouisfed.org/fred/x?api_key=k&a=1 failed, see http://h/p?q=1.'), 'GET https://api.stlouisfed.org/fred/x failed, see http://h/p');
  assert.equal(withoutQueries('Is this a question? Yes: HTTP 503'), 'Is this a question? Yes: HTTP 503');
});

test('the settings save the names of the secrets, never a key, and the setting names match the messages', () => {
  assert.deepEqual([DEFAULT_SETTINGS.tiingoSecret, DEFAULT_SETTINGS.fredSecret, DEFAULT_SETTINGS.tiingoFallback], ['', '', false]);
  assert.deepEqual(normalizeSettings({ tiingoSecret: ' tiingo ', fredSecret: 'fred', tiingoFallback: true, dataSource: 'tiingo' }), {
    ...DEFAULT_SETTINGS,
    tiingoSecret: 'tiingo',
    fredSecret: 'fred',
    tiingoFallback: true,
    dataSource: 'tiingo',
  });
  assert.deepEqual(normalizeSettings({ tiingoSecret: 5, fredSecret: null, tiingoFallback: 'yes', dataSource: 'fred' }), DEFAULT_SETTINGS);
  assert.equal(defaultsFrom({ ...DEFAULT_SETTINGS, dataSource: 'tiingo' }).dataSource, 'tiingo');
  const defaults = JSON.stringify(defaultsFrom({ ...DEFAULT_SETTINGS, tiingoSecret: 'tiingo-secret', fredSecret: 'fred-secret', tiingoFallback: true }));
  assert.ok(!/secret|fallback/i.test(defaults), defaults);
  const tab = readFileSync(new URL('../src/settings.ts', import.meta.url), 'utf8');
  for (const name of Object.values(KEY_SETTING)) assert.ok(tab.includes(`.setName('${name}')`), name);
  assert.ok(tab.includes(".setName('When Yahoo fails, use Tiingo')"));
});

test('a saved FRED series with its note is ready to run with no download', async () => {
  const files = new Map<string, string>();
  const io: PriceFiles = {
    exists: async (p) => files.has(p),
    read: async (p) => files.get(p)!,
    write: async (p, t) => void files.set(p, t),
    mkdir: async () => {},
    rmdir: async () => {},
  };
  // The first 10 days were first published together, a backfill the result notes.
  const rows: [string, string, string][] = Array.from({ length: 400 }, (_, i) => {
    const d = Date.UTC(2024, 1, 4) + i * DAY;
    return [iso(d), iso(i < 10 ? Date.UTC(2024, 1, 14) : d + DAY), '4'];
  });
  const net = recording(async (url) => (url.includes('api.tiingo.com') ? tiingoRows(400) : fredAnswer(rows)(url)));
  const store = new PriceStore({ files: io, cacheDir: 'cache', normalize: (p) => p, fetchText: net.d.fetchText, secret: net.d.secret });
  const block = 'universe: tiingo:SPY\ncash rate: fred:DGS3MO\nbuy when true';
  const defaults = defaultsFrom(DEFAULT_SETTINGS);
  const { spec } = parseSpec(block, { defaults });
  const out = await new Runner(store.deps(), defaults).run(spec!);
  assert.equal(out.notes!.length, 1);
  assert.deepEqual(out.warnings, []);
  assert.equal(await store.pricesReady(block, defaults, 6 * 3_600_000), true);
});

// ------------------------------------------------------------------------------------------------ ticker lookup

test('a Tiingo ticker, a FRED series, a bare name for one and every plain ticker of a Tiingo block but a ^ one are never looked up', async () => {
  const lines = ['universe: SPY, tiingo:QQQ, binance:BTCUSDT', 'cash rate: fred:DGS3MO', 'buy when close of fred:T10Y2Y > 0 and close of t10y2y > 0 and close of qqq > 1 and close of ^VIX < 30'];
  assert.deepEqual(
    blockTickers(lines).map((r) => [r.ticker, r.source]),
    [['SPY', 'yahoo'], ['BTCUSDT', 'binance'], ['^VIX', 'yahoo']],
  );
  // A plain ^ ticker comes from Yahoo whatever the block's source, so it is looked up there.
  assert.deepEqual(blockTickers(['data: tiingo', ...lines]).map((r) => [r.ticker, r.source]), [['BTCUSDT', 'binance'], ['^VIX', 'yahoo']]);
  assert.deepEqual(blockTickers(lines, { dataSource: 'tiingo' }).map((r) => [r.ticker, r.source]), [['BTCUSDT', 'binance'], ['^VIX', 'yahoo']]);
  assert.equal(blockSource(['data: Tiingo']), 'tiingo');

  const urls: string[] = [];
  const lookup = new SymbolLookup({ now: () => 0, fetchText: async (url) => (urls.push(url), JSON.stringify({ quotes: [] })) });
  for (const [word, source] of [['tiingo:SP', 'yahoo'], ['fred:T10', 'yahoo'], ['csv:Data', 'yahoo'], ['SP', 'tiingo'], ['FRED:dgs', 'binance']] as const) {
    assert.deepEqual(await lookup.suggest(word, source), [], word);
    assert.deepEqual(lookup.peekSuggest(word, source), [], word);
  }
  assert.equal(urls.length, 0);
  // A yahoo: word in a Tiingo block is still looked up at Yahoo, as asked.
  await lookup.suggest('yahoo:SP', 'tiingo');
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes('q=SP&'));
});

// ------------------------------------------------------------------------------------------------ editing help

const labels = (lines: string[], before: string) => complete([...lines, before], lines, before)?.items.map((i) => i.label) ?? null;

test('completion offers tiingo: and fred: after "of", data: tiingo, and a FRED yield as the cash rate', () => {
  const block = ['universe: SPY'];
  assert.deepEqual(labels(block, 'buy when close of t'), ['tiingo:']);
  assert.deepEqual(labels(block, 'buy when close of f'), ['fred:']);
  assert.deepEqual(labels(block, 'buy when close of '), ['SPY']);
  assert.deepEqual(labels(block, 'data: t'), ['tiingo']);
  assert.deepEqual(labels(block, 'cash rate: f'), ['fred:DGS3MO']);
  // Where a traded ticker goes, tiingo: is offered and fred: is not.
  const pos = (word: string) => ({ from: 10, word });
  assert.deepEqual(localTickers(block, pos('ti'), [], []).map((c) => c.insert), ['tiingo:']);
  assert.deepEqual(localTickers(block, pos('fr'), [], []), []);
  assert.deepEqual(localTickers(block, pos('tiingo:'), [], []), []);
});

test('hover help explains tiingo:, fred: and data: tiingo, and colours both kinds of ticker', () => {
  const lines = ['universe: tiingo:SPY', 'data: tiingo', 'cash rate: fred:DGS3MO', 'buy when close of fred:T10Y2Y > 0'];
  const tokens = tokenizeBlock(lines);
  const at = (row: number, word: string) => {
    const help = helpAt(lines, row, lines[row].indexOf(word) + 1, tokens);
    return help && { id: help.doc.id, text: lines[row].slice(help.from, help.to) };
  };
  assert.deepEqual(at(0, 'tiingo:SPY'), { id: 'tiingo:', text: 'tiingo:SPY' });
  assert.deepEqual(at(1, 'tiingo'), { id: 'data=tiingo', text: 'tiingo' });
  assert.deepEqual(at(2, 'fred:'), { id: 'fred:', text: 'fred:DGS3MO' });
  assert.deepEqual(at(3, 'fred:'), { id: 'fred:', text: 'fred:T10Y2Y' });
  assert.ok(tokens[0].some((t) => t.kind === 'ticker' && lines[0].slice(t.from, t.to) === 'tiingo:SPY'));
  assert.ok(tokens[3].some((t) => t.kind === 'ticker' && lines[3].slice(t.from, t.to) === 'fred:T10Y2Y'));
  // A ticker with no prefix, or another prefix, has no help of its own.
  assert.equal(helpAt(['universe: binance:BTCUSDT'], 0, 12), null);
});

test('the drafting guide names the new prefixes, and what it says about them parses', () => {
  for (const part of ['tiingo:SPY', 'close of fred:T10Y2Y < 0', 'cash rate: fred:DGS3MO', 'yahoo (the default), binance or tiingo']) assert.ok(SYSTEM_PROMPT.includes(part), part);
  assert.deepEqual(parseSpec('universe: tiingo:SPY\ncash rate: fred:DGS3MO\nbuy when close of fred:T10Y2Y < 0 and sma(close, 3) of fred:UNRATE > 4').errors, []);
  assert.ok(!/fred:\w+ \d+%/.test(SYSTEM_PROMPT));
});

// ------------------------------------------------------------------------------------------------ the reference

test('the reference quotes the Tiingo and FRED messages as the plugin words them', async () => {
  const messages: string[] = [];
  const fail = async (ref: AssetRef, answer: () => Promise<string>, over: Partial<DataDeps> = {}) => {
    const { d } = recording(answer, over);
    await loadBars(ref, '1d', 0, d).then(
      () => assert.fail('it should fail'),
      (e: Error) => messages.push(e.message),
    );
  };
  const X = (source: 'tiingo' | 'fred'): AssetRef => ({ name: 'X', source, id: 'X' });
  await fail(X('tiingo'), async () => JSON.stringify({ detail: 'Not found.' }));
  await fail(X('fred'), async () => JSON.stringify({ error_message: 'Bad Request.  The series does not exist.' }));
  await fail({ name: 'SPY', source: 'tiingo', id: 'SPY' }, async () => '[]', { secret: () => null });
  for (const m of messages) assert.ok(readme.includes(`"${m}"`) || readme.includes(m), m);
  const fallback = recording(async (url) => {
    if (url.includes('finance.yahoo.com')) throw new Error('HTTP 503');
    return tiingoRows(5);
  });
  const r = await loadBars({ name: 'SPY', source: 'yahoo', id: 'SPY' }, '1d', 0, fallback.d);
  assert.ok(readme.includes(`"${r.warning}"`), r.warning!);
  const refusal = parseSpec('universe: fred:T10Y2Y\nbuy when true').errors[0].message;
  assert.ok(readme.includes(`"${refusal}"`), refusal);
});
