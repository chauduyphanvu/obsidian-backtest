import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JsonStore, fileId, type StoreFiles } from '../src/store.ts';

/** A folder in memory, with timers the test fires by hand. */
function setup(files: Record<string, string> = {}) {
  const map = new Map(Object.entries(files));
  const dirs = new Set<string>();
  const writes: string[] = [];
  const io: StoreFiles = {
    exists: async (p) => map.has(p) || dirs.has(p),
    read: async (p) => {
      const text = map.get(p);
      if (text === undefined) throw new Error(`no ${p}`);
      return text;
    },
    write: async (p, text) => {
      writes.push(p);
      map.set(p, text);
    },
    mkdir: async (p) => void dirs.add(p),
    remove: async (p) => void map.delete(p),
  };
  const timers = new Map<number, () => void>();
  let next = 0;
  // A record is a set of numbers; two copies merge as their union.
  const store = new JsonStore<number[]>({
    files: io,
    dir: 'plugin/ledger',
    parse: (raw) => (Array.isArray(raw) && raw.every((x) => typeof x === 'number') ? raw : null),
    merge: (disk, mine) => [...new Set([...disk, ...mine])].sort((a, b) => a - b),
    setTimer: (fn) => {
      timers.set(++next, fn);
      return next;
    },
    clearTimer: (id) => void timers.delete(id as number),
  });
  const fire = async () => {
    const due = [...timers.values()];
    timers.clear();
    for (const fn of due) fn();
    await new Promise((r) => setTimeout(r, 0));
    await store.flush();
  };
  return { map, dirs, writes, store, timers, fire };
}

const path = (key: string) => `plugin/ledger/${fileId(key)}.json`;
const file = (key: string, value: unknown) => JSON.stringify({ key, value });

test('a record with no file is null, and a change is written once, a moment after the last change', async () => {
  const s = setup();
  assert.equal(await s.store.get('a'), null);
  await s.store.update('a', (v) => [...(v ?? []), 1]);
  await s.store.update('a', (v) => [...(v ?? []), 2]);
  assert.deepEqual(s.writes, []);
  assert.equal(s.timers.size, 1, 'one write waits, however many changes came before it');
  await s.fire();
  assert.deepEqual(s.writes, [path('a')]);
  assert.deepEqual(JSON.parse(s.map.get(path('a'))!), { key: 'a', value: [1, 2] });
  assert.ok(s.dirs.has('plugin/ledger'));
});

test('a record is read from its file, and a file another device changed meanwhile is merged, not overwritten', async () => {
  const s = setup({ [path('a')]: file('a', [1]) });
  assert.deepEqual(await s.store.get('a'), [1]);
  await s.store.update('a', (v) => [...(v ?? []), 3]);
  // A sync brings in the other device's copy before the write.
  s.map.set(path('a'), file('a', [1, 2]));
  await s.fire();
  assert.deepEqual(JSON.parse(s.map.get(path('a'))!).value, [1, 2, 3]);
  assert.deepEqual(await s.store.get('a'), [1, 2, 3]);
});

test('a file that is not a record, or holds another key, reads as none', async () => {
  const s = setup({ [path('a')]: 'not json', [path('b')]: file('someone else', [1]), [path('c')]: file('c', ['x']) });
  assert.equal(await s.store.get('a'), null);
  assert.equal(await s.store.get('b'), null);
  assert.equal(await s.store.get('c'), null);
});

test('flush writes every changed record now, and nothing unchanged', async () => {
  const s = setup({ [path('kept')]: file('kept', [5]) });
  await s.store.get('kept');
  await s.store.update('a', () => [1]);
  await s.store.update('b', () => [2]);
  await s.store.flush();
  assert.deepEqual(s.writes.sort(), [path('a'), path('b')].sort());
});

test('rename moves a record, merged with one already under the new key, and removes the old file', async () => {
  const s = setup({ [path('old')]: file('old', [1, 2]), [path('new')]: file('new', [3]) });
  await s.store.rename('old', 'new');
  await s.store.flush();
  assert.equal(s.map.has(path('old')), false);
  assert.deepEqual(JSON.parse(s.map.get(path('new'))!).value, [1, 2, 3]);
  assert.equal(await s.store.get('old'), null);
});

test('two writes of one record never interleave', async () => {
  const s = setup();
  await s.store.update('a', () => [1]);
  const first = s.store.flush();
  await s.store.update('a', (v) => [...(v ?? []), 2]);
  await Promise.all([first, s.store.flush()]);
  assert.deepEqual(JSON.parse(s.map.get(path('a'))!).value, [1, 2]);
});
