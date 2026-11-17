import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec } from '../src/dsl.ts';
import { cacheKey, csvPaths, csvVersions, debounce, ResultCache } from '../src/result-cache.ts';

const clock = () => {
  const c = { t: 1000, now: () => c.t };
  return c;
};

test('a stored result comes back until it expires', () => {
  const c = clock();
  const cache = new ResultCache<string>(10, 100, c.now);
  assert.equal(cache.get('a'), undefined);
  cache.set('a', 'one');
  c.t += 99;
  assert.equal(cache.get('a'), 'one');
  c.t += 1;
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 0);
});

test('reading a result does not extend its life, setting it again does', () => {
  const c = clock();
  const cache = new ResultCache<number>(10, 100, c.now);
  cache.set('a', 1);
  c.t += 60;
  assert.equal(cache.get('a'), 1);
  c.t += 60;
  assert.equal(cache.get('a'), undefined);
  cache.set('a', 2);
  c.t += 60;
  cache.set('a', 3);
  c.t += 60;
  assert.equal(cache.get('a'), 3);
});

test('the least recently used entries go first, and a read counts as a use', () => {
  const cache = new ResultCache<number>(3, 1e9);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), 1);
  cache.set('d', 4);
  assert.equal(cache.get('b'), undefined);
  assert.deepEqual(['a', 'c', 'd'].map((k) => cache.get(k)), [1, 3, 4]);
  assert.equal(cache.size, 3);
  // Setting an existing key replaces it and makes it the newest.
  cache.set('a', 10);
  cache.set('e', 5);
  assert.equal(cache.get('c'), undefined);
  assert.equal(cache.get('a'), 10);
  assert.equal(cache.size, 3);
});

test('falsy values are results too', () => {
  const cache = new ResultCache<number | null | string>(3, 1e9);
  cache.set('zero', 0);
  cache.set('null', null);
  cache.set('empty', '');
  assert.deepEqual(['zero', 'null', 'empty'].map((k) => cache.get(k)), [0, null, '']);
});

test('delete and clear', () => {
  const cache = new ResultCache<number>(5, 1e9);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.delete('a');
  cache.delete('missing');
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 1);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get('b'), undefined);
});

test('size counts only entries that have not expired', () => {
  const c = clock();
  const cache = new ResultCache<number>(5, 100, c.now);
  cache.set('old', 1);
  c.t += 80;
  cache.set('new', 2);
  c.t += 30;
  assert.equal(cache.size, 1);
  assert.equal(cache.get('new'), 2);
});

test('an unlimited age keeps entries, and a size of zero keeps nothing', () => {
  const c = clock();
  const forever = new ResultCache<number>(2, Infinity, c.now);
  forever.set('a', 1);
  c.t += 1e15;
  assert.equal(forever.get('a'), 1);
  const none = new ResultCache<number>(0, 1e9);
  none.set('a', 1);
  assert.equal(none.get('a'), undefined);
  assert.equal(none.size, 0);
});

test('cacheKey: same text and defaults give the same key, in any key order', () => {
  const defaults = { capital: 10000, costBps: 5, cashRate: '0%', dataSource: 'yahoo' };
  const reordered = { dataSource: 'yahoo', cashRate: '0%', costBps: 5, capital: 10000 };
  assert.equal(cacheKey('universe: SPY', defaults), cacheKey('universe: SPY', reordered));
  assert.equal(cacheKey('universe: SPY', { a: 1, b: undefined }), cacheKey('universe: SPY', { a: 1 }));
  assert.match(cacheKey('universe: SPY', defaults), /^[0-9a-z]+-[0-9a-z]+$/);
});

test('cacheKey: a different text or different defaults give a different key', () => {
  const base = { capital: 10000, costBps: 0 };
  const keys = new Set([
    cacheKey('universe: SPY', base),
    cacheKey('universe: SPY ', base),
    cacheKey('universe: QQQ', base),
    cacheKey('universe: SPY', { ...base, capital: 10001 }),
    cacheKey('universe: SPY', { ...base, extra: 'x' }),
    cacheKey('universe: SPY', null),
    cacheKey('universe: SPY', undefined),
    cacheKey('universe: SPY', [1, 2]),
    cacheKey('universe: SPY', [2, 1]),
    cacheKey('', base),
  ]);
  assert.equal(keys.size, 10);
  // The text and the defaults cannot trade characters.
  assert.notEqual(cacheKey('b', 'a'), cacheKey('ab', ''));
  assert.notEqual(cacheKey('1', { a: 1 }), cacheKey('', { a: 1 }));
});

test('cacheKey: nested defaults count, and many different texts rarely collide', () => {
  assert.notEqual(cacheKey('x', { a: { b: 1 } }), cacheKey('x', { a: { b: 2 } }));
  assert.equal(cacheKey('x', { a: { b: 1, c: 2 } }), cacheKey('x', { a: { c: 2, b: 1 } }));
  const seen = new Set<string>();
  for (let i = 0; i < 20000; i++) seen.add(cacheKey(`universe: SPY\nbuy when close > sma(${i})`, {}));
  assert.equal(seen.size, 20000);
});

function fakeTimers() {
  let now = 0;
  let next = 1;
  const waiting = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set(fn: () => void, ms: number) {
        waiting.set(next, { at: now + ms, fn });
        return next++;
      },
      clear(id: unknown) {
        waiting.delete(id as number);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const [id, w] of [...waiting].sort((a, b) => a[1].at - b[1].at)) {
        if (w.at <= now) {
          waiting.delete(id);
          w.fn();
        }
      }
    },
    get pending() {
      return waiting.size;
    },
  };
}

test('debounce waits for quiet and passes the latest arguments', () => {
  const f = fakeTimers();
  const seen: [string, number][] = [];
  const run = debounce((a: string, b: number) => seen.push([a, b]), 100, f.timers);
  run('a', 1);
  f.advance(60);
  run('b', 2);
  f.advance(60);
  assert.deepEqual(seen, []);
  f.advance(40);
  assert.deepEqual(seen, [['b', 2]]);
  f.advance(1000);
  assert.deepEqual(seen, [['b', 2]]);
  run('c', 3);
  f.advance(100);
  assert.deepEqual(seen, [['b', 2], ['c', 3]]);
  assert.equal(f.pending, 0);
});

test('debounce: cancel drops the waiting call, and the function works again after', () => {
  const f = fakeTimers();
  let calls = 0;
  const run = debounce(() => calls++, 50, f.timers);
  run();
  run.cancel();
  assert.equal(f.pending, 0);
  f.advance(500);
  assert.equal(calls, 0);
  run.cancel();
  run();
  f.advance(50);
  assert.equal(calls, 1);
});

test('debounce: only one timer waits at a time', () => {
  const f = fakeTimers();
  const run = debounce(() => {}, 10, f.timers);
  for (let i = 0; i < 20; i++) run();
  assert.equal(f.pending, 1);
});

test('debounce with the real timers', async () => {
  let calls = 0;
  const run = debounce(() => calls++, 5);
  run();
  run();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, 1);
  const cancelled = debounce(() => calls++, 5);
  cancelled();
  cancelled.cancel();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
});

// --- CSV files in the key ------------------------------------------------------------------------------------------

test('csvPaths: the CSV files a strategy reads, once each and sorted, whatever role they play', () => {
  const src = [
    'universe: csv:data/b.csv, csv:data/a.csv, SPY',
    'benchmark: csv:data/c.csv',
    'cash rate: csv:rates/irx.csv',
    'buy when close > close of csv:data/a.csv and close of csv:data/d.csv > 1',
  ].join('\n');
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  assert.deepEqual(csvPaths(spec!), ['data/a.csv', 'data/b.csv', 'data/c.csv', 'data/d.csv', 'rates/irx.csv']);
});

test('csvPaths: a strategy with no CSV files has none', () => {
  assert.deepEqual(csvPaths(parseSpec('universe: SPY, binance:BTCUSDT\nbuy when true').spec!), []);
});

test('csvVersions: path and modified time for each file, and "missing" for one that is gone', async () => {
  const times: Record<string, number | null> = { 'a.csv': 1700000000000, 'gone.csv': null };
  const asked: string[] = [];
  const text = await csvVersions(['a.csv', 'gone.csv'], async (p) => (asked.push(p), times[p]));
  assert.equal(text, 'a.csv=1700000000000\ngone.csv=missing');
  assert.deepEqual(asked, ['a.csv', 'gone.csv']);
  assert.equal(await csvVersions([], async () => 1), '');
});

test('a changed or missing CSV file changes the key, and no files leaves the key as it was', async () => {
  const base = { capital: 10000 };
  const at = (n: number | null) => csvVersions(['a.csv'], async () => n);
  const same = cacheKey('universe: csv:a.csv', base, await at(5));
  assert.equal(same, cacheKey('universe: csv:a.csv', base, await at(5)));
  assert.notEqual(same, cacheKey('universe: csv:a.csv', base, await at(6)));
  assert.notEqual(same, cacheKey('universe: csv:a.csv', base, await at(null)));
  assert.notEqual(cacheKey('universe: csv:a.csv', base, await at(null)), cacheKey('universe: csv:a.csv', base, await at(0)));
  assert.equal(cacheKey('universe: SPY', base), cacheKey('universe: SPY', base, ''));
  assert.notEqual(cacheKey('universe: SPY', base), cacheKey('universe: SPY', base, 'a.csv=1'));
});
