import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JsonStore, fileId, type StoreFiles } from '../src/store.ts';

/** A folder in memory, with timers the test fires by hand. */
function setup(files: Record<string, string> = {}) {
  const map = new Map(Object.entries(files));
  const dirs = new Set<string>();
  const writes: string[] = [];
  const reads: string[] = [];
  const io: StoreFiles = {
    // A folder exists once it was made or holds a file, as on disk.
    exists: async (p) => map.has(p) || dirs.has(p) || [...map.keys()].some((k) => k.startsWith(`${p}/`)),
    read: async (p) => {
      reads.push(p);
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
    list: async (dir) => ({ files: [...map.keys()].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')) }),
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
  return { map, dirs, writes, reads, store, timers, fire };
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

test('renaming by a prefix moves every record whose key starts with it, read from each file, and nothing else', async () => {
  const s = setup({
    [path('Notes/a.md\u0000name:x')]: file('Notes/a.md\u0000name:x', [1]),
    [path('Notes/a.md\u0000block:2')]: file('Notes/a.md\u0000block:2', [2]),
    [path('Notes/ab.md\u0000name:x')]: file('Notes/ab.md\u0000name:x', [3]),
    [path('Notes/b.md\u0000name:y')]: file('Notes/b.md\u0000name:y', [4]),
    'plugin/ledger/broken.json': 'not json',
    'plugin/ledger/other.txt': 'x',
  });
  await s.store.renamePrefix('Notes/a.md\u0000', 'Trading/a.md\u0000');
  await s.store.flush();
  assert.deepEqual(await s.store.get('Trading/a.md\u0000name:x'), [1]);
  assert.deepEqual(await s.store.get('Trading/a.md\u0000block:2'), [2]);
  assert.equal(s.map.has(path('Notes/a.md\u0000name:x')), false);
  // A note whose name only starts the same, and the others, stay where they are.
  assert.deepEqual(JSON.parse(s.map.get(path('Notes/ab.md\u0000name:x'))!).value, [3]);
  assert.deepEqual(JSON.parse(s.map.get(path('Notes/b.md\u0000name:y'))!).value, [4]);
  assert.equal(s.map.get('plugin/ledger/broken.json'), 'not json');
});

test('renaming a folder moves the records of every note in it, including one not yet written', async () => {
  const s = setup({ [path('Notes/a.md\u0000name:x')]: file('Notes/a.md\u0000name:x', [1]), [path('Other/c.md\u0000name:z')]: file('Other/c.md\u0000name:z', [9]) });
  await s.store.update('Notes/deep/b.md\u0000block:0', () => [5]);
  await s.store.renamePrefix('Notes/', 'Archive/');
  await s.store.flush();
  assert.deepEqual(await s.store.get('Archive/a.md\u0000name:x'), [1]);
  assert.deepEqual(await s.store.get('Archive/deep/b.md\u0000block:0'), [5]);
  assert.equal(await s.store.get('Notes/deep/b.md\u0000block:0'), null);
  assert.deepEqual(JSON.parse(s.map.get(path('Archive/deep/b.md\u0000block:0'))!).value, [5]);
  assert.deepEqual(await s.store.get('Other/c.md\u0000name:z'), [9]);
  // Nothing to move, and no folder yet: nothing happens.
  await setup().store.renamePrefix('Notes/', 'Archive/');
});

test('a record moved onto a key that already has one is merged with it', async () => {
  const s = setup({ [path('A.md\u0000name:x')]: file('A.md\u0000name:x', [1]), [path('B.md\u0000name:x')]: file('B.md\u0000name:x', [2]) });
  await s.store.renamePrefix('A.md\u0000', 'B.md\u0000');
  await s.store.flush();
  assert.deepEqual(JSON.parse(s.map.get(path('B.md\u0000name:x'))!).value, [1, 2]);
  assert.equal(s.map.has(path('A.md\u0000name:x')), false);
});

test('a file\'s key is read once: later renames by a prefix read only files not seen before', async () => {
  const s = setup({ [path('A.md\u0000name:x')]: file('A.md\u0000name:x', [1]), [path('B.md\u0000name:y')]: file('B.md\u0000name:y', [2]) });
  await s.store.renamePrefix('C.md\u0000', 'D.md\u0000');
  assert.equal(s.reads.length, 2);
  s.reads.length = 0;
  await s.store.renamePrefix('E.md\u0000', 'F.md\u0000');
  assert.equal(s.reads.length, 0);
  // A file a sync brought in is read, and moved.
  s.map.set(path('G.md\u0000name:z'), file('G.md\u0000name:z', [3]));
  await s.store.renamePrefix('G.md\u0000', 'H.md\u0000');
  await s.store.flush();
  assert.ok(s.reads.includes(path('G.md\u0000name:z')));
  assert.deepEqual(JSON.parse(s.map.get(path('H.md\u0000name:z'))!).value, [3]);
});
