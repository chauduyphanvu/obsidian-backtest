import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PriceStore, type PriceFiles } from '../src/price-store.ts';
import { bars } from './helpers.ts';

/** A vault folder in memory that counts its reads. */
function vault(files: Record<string, string> = {}) {
  const map = new Map(Object.entries(files));
  const dirs = new Set<string>();
  const reads: string[] = [];
  const io: PriceFiles = {
    exists: async (p) => map.has(p) || dirs.has(p),
    read: async (p) => {
      reads.push(p);
      const text = map.get(p);
      if (text === undefined) throw new Error(`no ${p}`);
      return text;
    },
    write: async (p, text) => void map.set(p, text),
    mkdir: async (p) => void dirs.add(p),
    rmdir: async (p) => {
      dirs.delete(p);
      for (const k of [...map.keys()]) if (k.startsWith(`${p}/`)) map.delete(k);
    },
  };
  return { map, dirs, reads, io };
}

const normalize = (p: string) => p.replace(/^\/+/, '').replace(/\/+/g, '/');
const offline = async (url: string): Promise<string> => {
  throw new Error(`offline: ${url}`);
};
const store = (v: ReturnType<typeof vault>) => new PriceStore({ files: v.io, cacheDir: 'plugin/cache', normalize, fetchText: offline });
const saved = (fetched: number) => JSON.stringify({ fetched, since: 0, bars: bars(Array.from({ length: 400 }, (_, i) => 100 + i)) });

test('a saved price file is read from the vault each time, and a missing one is null', async () => {
  const v = vault({ 'plugin/cache/yahoo-SPY-1d.json': 'saved' });
  const deps = store(v).deps();
  assert.equal(await deps.cacheRead('yahoo-SPY-1d'), 'saved');
  v.map.set('plugin/cache/yahoo-SPY-1d.json', 'changed by a sync');
  assert.equal(await deps.cacheRead('yahoo-SPY-1d'), 'changed by a sync');
  assert.deepEqual(v.reads, ['plugin/cache/yahoo-SPY-1d.json', 'plugin/cache/yahoo-SPY-1d.json']);
  assert.equal(await deps.cacheRead('yahoo-QQQ-1d'), null);
});

test('one set of data calls serves the whole life of the store', () => {
  const s = store(vault());
  assert.equal(s.deps(), s.deps());
});

test('writing a price file makes the folder and ends every answer about readiness', async () => {
  const v = vault();
  const s = store(v);
  s.ready.set('needs', true, Infinity);
  const deps = s.deps();
  await deps.cacheWrite('yahoo-SPY-1d', 'new');
  assert.ok(v.dirs.has('plugin/cache'));
  assert.equal(v.map.get('plugin/cache/yahoo-SPY-1d.json'), 'new');
  assert.equal(s.ready.get('needs'), undefined);
  assert.equal(await deps.cacheRead('yahoo-SPY-1d'), 'new');
});

test('reading a CSV file keeps its column names, which a missing file, a delete or a rename forgets', async () => {
  const v = vault({ 'Data/signals.csv': 'date,score,News Sentiment\n2024-01-02,1,2\n', 'Data/other.csv': 'date,x\n2024-01-02,1\n' });
  const s = store(v);
  const deps = s.deps();
  assert.equal(s.columns('Data/signals.csv'), undefined);
  assert.ok(await deps.readVaultFile('/Data//signals.csv'));
  await deps.readVaultFile('Data/other.csv');
  assert.deepEqual(s.columns('//Data/signals.csv'), ['score', 'news_sentiment']);
  s.forgetColumns('Data');
  assert.equal(s.columns('Data/signals.csv'), undefined);
  assert.equal(s.columns('Data/other.csv'), undefined);
  await deps.readVaultFile('Data/other.csv');
  v.map.delete('Data/other.csv');
  assert.equal(await deps.readVaultFile('Data/other.csv'), null);
  assert.equal(s.columns('Data/other.csv'), undefined);
});

test('forgetting drops every answer about readiness, and removing takes the folder away only when it is there', async () => {
  const v = vault({ 'plugin/cache/yahoo-SPY-1d.json': 'saved' });
  v.dirs.add('plugin/cache');
  const s = store(v);
  s.ready.set('needs', true, Infinity);
  s.forget();
  assert.equal(s.ready.get('needs'), undefined);
  await s.removeSaved();
  assert.ok(!v.dirs.has('plugin/cache'));
  assert.equal(v.map.size, 0);
  await s.removeSaved();
});

test('a block is ready when every ticker has fresh saved prices, and the answer is kept until a file is written', async () => {
  const v = vault({ 'plugin/cache/yahoo-SPY-1d.json': saved(Date.now() - 1000) });
  const s = store(v);
  const block = 'universe: SPY\nbuy when true';
  assert.equal(await s.pricesReady(block, { capital: 10_000, costBps: 0, slippageBps: 0, cashRate: '0%', dataSource: 'yahoo' }, 3_600_000), true);
  const reads = v.reads.length;
  assert.equal(await s.pricesReady(block, { capital: 10_000, costBps: 0, slippageBps: 0, cashRate: '0%', dataSource: 'yahoo' }, 3_600_000), true);
  assert.equal(v.reads.length, reads);
  assert.equal(await s.pricesReady('universe: SPY\nbuy when', { capital: 10_000, costBps: 0, slippageBps: 0, cashRate: '0%', dataSource: 'yahoo' }, 3_600_000), false);
});

test('a block whose saved prices are too old, or missing, needs a download', async () => {
  const defaults = { capital: 10_000, costBps: 0, slippageBps: 0, cashRate: '0%', dataSource: 'yahoo' as const };
  const old = store(vault({ 'plugin/cache/yahoo-SPY-1d.json': saved(Date.now() - 7_200_000) }));
  assert.equal(await old.pricesReady('universe: SPY\nbuy when true', defaults, 3_600_000), false);
  const none = store(vault());
  assert.equal(await none.pricesReady('universe: SPY\nbuy when true', defaults, 3_600_000), false);
});
