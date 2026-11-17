import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DataDeps } from '../src/data.ts';
import type { Defaults } from '../src/dsl.ts';
import { serve, type ToWorker } from '../src/jobs.ts';
import { Results } from '../src/results.ts';
import { createJobClient, type MakeWorker } from '../src/worker-client.ts';
import { DAY } from './helpers.ts';

const SRC = 'universe: csv:a.csv\nbuy when close > sma(20)\nsell when close < sma(20)';
const DEFAULTS: Defaults = { capital: 10_000, costBps: 0, slippageBps: 0, cashRate: '0%', dataSource: 'yahoo' };

function prices(): string {
  let c = 100;
  const start = Date.UTC(2020, 0, 1);
  const rows = Array.from({ length: 300 }, (_, i) => {
    const o = c;
    c *= 1 + Math.sin(i / 7) * 0.01;
    return `${new Date(start + i * DAY).toISOString().slice(0, 10)},${o},${Math.max(o, c)},${Math.min(o, c)},${c}`;
  });
  return ['date,open,high,low,close', ...rows].join('\n');
}

/** A worker in this process: the real message handler, answering a turn after it is asked. */
const inProcess: MakeWorker = (on) => {
  const handle = serve((m) => on.message(structuredClone(m)), 0);
  setTimeout(() => on.message({ type: 'ready' }));
  return { post: (m: ToWorker) => void setTimeout(() => void handle(structuredClone(m))), terminate: () => {} };
};

function setup(o: { defaults?: () => Defaults; modified?: (path: string) => Promise<number | null> } = {}) {
  const reads: string[] = [];
  const deps: DataDeps = {
    fetchText: () => Promise.reject(new Error('no network in tests')),
    readVaultFile: async (path) => {
      reads.push(path);
      return path === 'a.csv' ? prices() : null;
    },
    cacheRead: async () => null,
    cacheWrite: async () => {},
    now: () => Date.now(),
  };
  const client = createJobClient({ makeWorker: inProcess });
  const results = new Results({
    deps: () => deps,
    defaults: o.defaults ?? (() => DEFAULTS),
    freshForMs: () => 6 * 3_600_000,
    modified: o.modified ?? (async () => 1),
    runs: () => client.runs(),
  });
  return { results, reads, client };
}

test('a block run again with the same text, defaults and files gets the kept result', async () => {
  const { results, reads, client } = setup();
  const first = await results.runSource(SRC);
  assert.ok(first.backtest.run.t.length > 0);
  assert.equal(await results.runSource(SRC), first);
  assert.equal(reads.length, 1);
  client.shutdown();
});

test('a forced run runs again, and so does one after the kept results are dropped', async () => {
  const { results, client } = setup();
  const first = await results.runSource(SRC);
  const forced = await results.runSource(SRC, { force: true });
  assert.notEqual(forced, first);
  assert.equal(await results.runSource(SRC), forced);
  results.clear();
  assert.notEqual(await results.runSource(SRC), forced);
  const kept = await results.runSource(SRC);
  results.reset(3_600_000);
  assert.notEqual(await results.runSource(SRC), kept);
  client.shutdown();
});

test('cached only runs nothing: a block with no kept result rejects', async () => {
  const { results, reads, client } = setup();
  await assert.rejects(results.runSource(SRC, { cachedOnly: true }), { message: 'This strategy has not run yet.' });
  assert.equal(reads.length, 0);
  const out = await results.runSource(SRC);
  assert.equal(await results.runSource(SRC, { cachedOnly: true }), out);
  client.shutdown();
});

test('a block that does not parse rejects with its first problem', async () => {
  const { results, client } = setup();
  await assert.rejects(results.runSource('universe: csv:a.csv\nbuy when clsoe > 1'), /^Error: Line 2: /);
  client.shutdown();
});

test('prices older than the caller takes are not reused', async () => {
  const { results, client } = setup();
  const first = await results.runSource(SRC);
  assert.notEqual(await results.runSource(SRC, { freshForMs: 0 }), first);
  client.shutdown();
});

test('a CSV file with another modified time, or other defaults, is another result', async () => {
  let mtime = 1;
  let defaults = DEFAULTS;
  const { results, reads, client } = setup({ modified: async () => mtime, defaults: () => defaults });
  const first = await results.runSource(SRC);
  mtime = 2;
  const second = await results.runSource(SRC);
  assert.notEqual(second, first);
  defaults = { ...DEFAULTS, capital: 20_000 };
  const third = await results.runSource(SRC);
  assert.notEqual(third, second);
  assert.equal(third.spec.capital, 20_000);
  assert.equal(reads.length, 3);
  client.shutdown();
});

test('the key of a result covers the text, the defaults and each file it reads', async () => {
  const { results, client } = setup({ modified: async (path) => (path === 'a.csv' ? 5 : null) });
  const spec = results.drawing(SRC, client.runs()).parse().spec!;
  const key = await results.resultKey(spec, SRC, DEFAULTS);
  assert.equal(await results.resultKey(spec, SRC, DEFAULTS), key);
  assert.notEqual(await results.resultKey(spec, `${SRC}\n`, DEFAULTS), key);
  assert.notEqual(await results.resultKey(spec, SRC, { ...DEFAULTS, costBps: 5 }), key);
  client.shutdown();
});
