import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DataDeps } from '../src/data.ts';
import { mapLimit } from '../src/orders.ts';
import { Runner } from '../src/runner.ts';

// The recipe a forced scan of today's orders follows: runners built with freshForMs = time since the scan began,
// so a price fetched during the scan is reused and one saved earlier is fetched again, once.

const DAYS = 600;
const START = Date.UTC(2025, 0, 1);
function yahoo(): string {
  const timestamp = Array.from({ length: DAYS }, (_, i) => Math.floor(Date.UTC(2023, 0, 2 + i) / 1000));
  const close = timestamp.map((_, i) => 100 + (i % 17));
  const quote = { open: close, high: close, low: close, close, volume: close.map(() => 1) };
  return JSON.stringify({ chart: { result: [{ meta: { gmtoffset: 0 }, timestamp, indicators: { quote: [quote], adjclose: [{ adjclose: close }] } }] } });
}

function world(savedAt: number | null) {
  let clock = START;
  const saved = new Map<string, string>();
  const fetched: string[] = [];
  if (savedAt !== null) {
    const t = Array.from({ length: DAYS }, (_, i) => Date.UTC(2023, 0, 2 + i));
    const c = t.map(() => 100);
    const bars = { t, o: c, h: c, l: c, c, v: c };
    for (const t of ['SPY', 'QQQ']) saved.set(`yahoo-${t}-1d`, JSON.stringify({ bars, fetched: savedAt, since: 0 }));
  }
  const deps: DataDeps = {
    now: () => clock,
    fetchText: async (url) => {
      fetched.push(url.match(/chart\/([^?]+)/)![1]);
      clock += 40;
      return yahoo();
    },
    readVaultFile: async () => null,
    cacheRead: async (key) => saved.get(key) ?? null,
    cacheWrite: async (key, text) => void saved.set(key, text),
  };
  return { deps, fetched, advance: (ms: number) => (clock += ms), now: () => clock };
}

const SOURCES = ['universe: SPY\nbuy when true', 'universe: SPY, QQQ\nbuy when true', 'universe: QQQ\nbuy when true', 'universe: SPY\nbuy when close > 1'];

test('a forced scan downloads each ticker once for any number of strategies, three at a time', async () => {
  const w = world(START - 60_000);
  const started = w.now();
  const runner = () => new Runner(w.deps, {}, { freshForMs: w.now() - started });
  let active = 0;
  let most = 0;
  await mapLimit(SOURCES, 3, async (src) => {
    const r = runner();
    const { spec } = r.parse(src);
    active++;
    most = Math.max(most, active);
    await r.run(spec!);
    active--;
  });
  assert.deepEqual([...w.fetched].sort(), ['QQQ', 'SPY']);
  assert.ok(most <= 3);
});

test('a scan that is not forced keeps using prices saved within the cache window', async () => {
  const w = world(START - 60_000);
  const r = new Runner(w.deps, {}, { freshForMs: 6 * 3_600_000 });
  await r.run(r.parse(SOURCES[1]).spec!);
  assert.deepEqual(w.fetched, []);
});
