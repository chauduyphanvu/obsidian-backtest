import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import type { DataDeps } from '../src/data.ts';
import { regimePlan } from '../src/regimes.ts';
import { Runner } from '../src/runner.ts';
import type { AssetRef } from '../src/types.ts';
import { DAY } from './helpers.ts';

const HOUR = 3_600_000;
const FIRST = Date.UTC(2020, 0, 2);
const yahoo = (name: string): AssetRef => ({ name, source: 'yahoo', id: name });
const SPY = yahoo('SPY');
const VIX = yahoo('^VIX');

/** Yahoo's answer for 1,600 daily bars from 2020-01-02, closing at 100, 101, 102 and so on. */
function yahooJson(): string {
  const days = Array.from({ length: 1600 }, (_, i) => i);
  const close = days.map((i) => 100 + i);
  const stamps = days.map((i) => (FIRST + i * DAY + 14.5 * HOUR) / 1000);
  const quote = { open: close, high: close.map((c) => c + 1), low: close.map((c) => c - 1), close, volume: close.map(() => 10) };
  return JSON.stringify({ chart: { result: [{ meta: { gmtoffset: -18000 }, timestamp: stamps, indicators: { quote: [quote], adjclose: [{ adjclose: close }] } }] } });
}

/** Binance's answer for daily klines from `start` up to the day before `now`. */
function klines(start: number, now: number): string {
  const rows: unknown[][] = [];
  for (let open = Math.max(Math.ceil(start / DAY) * DAY, FIRST); open + DAY - 1 < now; open += DAY) rows.push([open, '100', '101', '99', '100', '5', open + DAY - 1]);
  return JSON.stringify(rows.slice(0, 1000));
}

function market(files: Record<string, string> = {}) {
  const cache = new Map<string, string>();
  const urls: string[] = [];
  const clock = { now: Date.UTC(2024, 5, 1) };
  const deps: DataDeps = {
    fetchText: async (url) => {
      urls.push(url);
      if (url.includes('finance.yahoo.com')) return yahooJson();
      return klines(Number(new URL(url).searchParams.get('startTime')), clock.now);
    },
    readVaultFile: async (path) => files[path] ?? null,
    cacheRead: async (key) => cache.get(key) ?? null,
    cacheWrite: async (key, text) => void cache.set(key, text),
    now: () => clock.now,
  };
  return { deps, urls, clock, cache };
}

test('extras are daily bars from the lookback before the first day, saved like any other ticker’s', async () => {
  const { deps, urls, cache } = market();
  const from = Date.UTC(2023, 0, 2);
  const got = await new Runner(deps).loadExtras([SPY, VIX], from, 250);
  assert.deepEqual([...got.data.keys()], ['SPY', '^VIX']);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => u.includes('interval=1d')));
  assert.ok(urls.some((u) => u.includes('/SPY?')) && urls.some((u) => u.includes('%5EVIX')));
  // 250 bars at 1.6 calendar days each, 400 days, before the run's first day. Bars before that are cut, so the answer does not
  // depend on how far back the saved file reaches.
  const since = from - 400 * DAY;
  assert.equal(got.data.get('SPY')!.t[0], since);
  assert.equal(got.data.get('SPY')!.t.length, Math.floor((FIRST + 1599 * DAY - since) / DAY) + 1);
  assert.deepEqual(got.warnings, []);
  assert.deepEqual(got.prices.map((p) => [p.name, p.source, p.stale]), [['SPY', 'yahoo', false], ['^VIX', 'yahoo', false]]);
  assert.deepEqual([...cache.keys()].sort(), ['yahoo-SPY-1d', 'yahoo-_VIX-1d']);
});

test('Binance extras ask for daily bars from the start of the lookback', async () => {
  const { deps, urls } = market();
  const from = Date.UTC(2023, 0, 2);
  const plan = regimePlan([{ name: 'BTCUSDT', source: 'binance', id: 'BTCUSDT' }]);
  const got = await new Runner(deps).loadExtras(plan.refs, from, plan.lookback);
  // 396 bars at 1.6 days, rounded up: 634 days.
  const since = from - 634 * DAY;
  assert.ok(urls[0].includes('interval=1d'));
  assert.equal(new URL(urls[0]).searchParams.get('startTime'), String(since));
  assert.equal(got.data.get('BTCUSDT')!.t[0], Math.ceil(since / DAY) * DAY);
});

const FILE = 'prices/a.csv';
const csvRows = Array.from({ length: 30 }, (_, i) => `${new Date(Date.UTC(2023, 0, 2 + i)).toISOString().slice(0, 10)},${10 + i},${11 + i},${9 + i},${10 + i}`);
const CSV = ['date,open,high,low,close', ...csvRows].join('\n');

test('loading extras leaves the strategy’s own prices and result as they were', async () => {
  const { deps } = market({ [FILE]: CSV });
  const runner = new Runner(deps);
  const out = await runner.run(runner.parse(`universe: csv:${FILE}\nbuy when true`).spec!);
  const before = { data: JSON.stringify([...out.data]), keys: [...out.data.keys()], equity: JSON.stringify(out.backtest.run.equity), series: [...out.data.values()] };
  const extras = await runner.loadExtras([SPY, VIX], out.backtest.run.t[0], 250);
  assert.deepEqual([...out.data.keys()], before.keys);
  assert.equal(JSON.stringify([...out.data]), before.data);
  assert.equal(JSON.stringify(out.backtest.run.equity), before.equity);
  [...out.data.values()].forEach((b, i) => assert.equal(b, before.series[i]));
  for (const name of extras.data.keys()) assert.ok(!out.data.has(name));
  // The same block gives the same result whether or not the market's prices were ever loaded.
  assert.equal(JSON.stringify(runBacktest(out.spec, out.data).run.equity), before.equity);
  assert.equal(JSON.stringify((await runner.run(out.spec)).backtest.run.equity), before.equity);
});

test('a strategy that trades a ticker the regimes also read keeps its own bars of it', async () => {
  const { deps } = market();
  const runner = new Runner(deps);
  const spec = runner.parse('universe: SPY\nfrom: 2023-01-02\nbuy when true').spec!;
  const out = await runner.run(spec);
  const own = out.data.get('SPY')!;
  const [length, first] = [own.t.length, own.t[0]];
  const extras = await runner.loadExtras([SPY], out.backtest.run.t[0], 396);
  assert.notEqual(extras.data.get('SPY'), own);
  assert.equal(own.t.length, length);
  assert.equal(own.t[0], first);
  assert.ok(extras.data.get('SPY')!.t[0] < first);
});

test('saved extras come from the saved files alone, and only while they are fresh', async () => {
  const { deps, urls, clock } = market();
  const runner = new Runner(deps);
  const from = Date.UTC(2023, 0, 2);
  assert.equal(await runner.savedExtras([SPY, VIX], from, 250), null);
  assert.deepEqual(urls, []);

  const loaded = await runner.loadExtras([SPY, VIX], from, 250);
  const fetched = urls.length;
  const saved = await runner.savedExtras([SPY, VIX], from, 250);
  assert.equal(urls.length, fetched);
  assert.deepEqual(saved?.data.get('^VIX'), loaded.data.get('^VIX'));
  assert.deepEqual(saved?.data.get('SPY')!.t, loaded.data.get('SPY')!.t);

  // One of the two not saved.
  assert.equal(await runner.savedExtras([SPY, yahoo('^TNX')], from, 250), null);
  assert.equal(urls.length, fetched);

  // Past the time saved prices are kept for (6 hours unless the settings say otherwise), a download would be needed.
  clock.now += 7 * HOUR;
  assert.equal(await runner.savedExtras([SPY, VIX], from, 250), null);
  assert.equal(urls.length, fetched);
  assert.ok(await new Runner(deps, {}, { freshForMs: 12 * HOUR }).savedExtras([SPY, VIX], from, 250));
});

test('a failed download of extras says which ticker, and saved extras never write', async () => {
  const { deps, cache } = market();
  const failing: DataDeps = { ...deps, fetchText: () => Promise.reject(new Error('offline')) };
  await assert.rejects(new Runner(failing).loadExtras([SPY], Date.UTC(2023, 0, 2), 250), /Couldn't load SPY from yahoo: offline/);
  assert.equal(await new Runner(deps).savedExtras([SPY], Date.UTC(2023, 0, 2), 250), null);
  assert.equal(cache.size, 0);
});
