import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { isoDate } from '../src/format.ts';
import type { RunOutput } from '../src/runner.ts';
import { blockOf, EMPTY, STARTERS } from '../src/gallery.ts';
import { createStrategyNote, createWithFreeName, NoteProperties, saveDatedFile, type NewFiles, type PropertiesHost } from '../src/vault-writes.ts';
import { bars } from './helpers.ts';

function run(src: string): RunOutput {
  const { spec } = parseSpec(src);
  const data = new Map([['A', bars([10, 11, 12, 11, 13, 14, 13, 15])]]);
  return { spec: spec!, backtest: runBacktest(spec!, data), data, warnings: [], prices: [] };
}

const FENCE = '```';
const note = (...blocks: string[]) => blocks.map((b) => `${FENCE}strategy\n${b}\n${FENCE}`).join('\n\n');
const ONE = 'name: One\nuniverse: A\nbuy when true';
const TWO = 'name: Two\nuniverse: A\nbuy when close > 12';

interface File {
  path: string;
}

/** A note with properties, whose blocks run when they are kept (or always, with `announce`), or fail. */
function host(text: string, o: { kept?: boolean; fails?: string[]; frontmatter?: Record<string, unknown> } = {}) {
  const fm: Record<string, unknown> = { ...(o.frontmatter ?? {}) };
  const notices: string[] = [];
  const asked: boolean[] = [];
  let writes = 0;
  const h: PropertiesHost<File> = {
    read: async () => text,
    frontmatter: () => ({ ...fm }),
    processFrontMatter: async (_file, edit) => {
      writes++;
      edit(fm);
    },
    runSource: async (source, opts) => {
      asked.push(opts.cachedOnly);
      if (o.fails?.some((f) => source.includes(f))) throw new Error('no');
      if (opts.cachedOnly && o.kept === false) throw new Error('This strategy did not run at this time.');
      return run(source);
    },
    notice: (t) => void notices.push(t),
  };
  return { h, fm, notices, asked, writes: () => writes };
}

test('properties are written from kept results only, and stale bt_ properties go', async () => {
  const x = host(note(ONE, TWO), { frontmatter: { bt_old_trades: 3, title: 'mine' } });
  await new NoteProperties(x.h).saveProperties({ path: 'N.md' }, false);
  assert.deepEqual(x.asked, [true, true]);
  assert.equal(x.fm.title, 'mine');
  assert.ok(!('bt_old_trades' in x.fm));
  assert.ok('bt_one_trades' in x.fm && 'bt_two_trades' in x.fm);
  assert.deepEqual(x.notices, []);
});

test('when asked for, the strategies run first and the result is said', async () => {
  const x = host(note(ONE, TWO), { fails: ['Two'] });
  const props = new NoteProperties(x.h);
  await props.saveProperties({ path: 'N.md' }, true);
  assert.deepEqual(x.asked, [false, false]);
  assert.match(x.notices[0], /^Saved \d+ figures to the properties of this note\. 1 of 2 strategies did not run\. The plugin kept the figures from their previous runs\.$/);
  await props.saveProperties({ path: 'N.md' }, true);
  assert.equal(x.notices[1], 'The properties of this note agree with the results. There is nothing to save.');
  assert.equal(x.writes(), 1);
});

test('a note with no strategy that runs writes nothing, and says so only when asked', async () => {
  const x = host(note(ONE), { fails: ['One'] });
  const props = new NoteProperties(x.h);
  await props.saveProperties({ path: 'N.md' }, false);
  assert.deepEqual(x.notices, []);
  await props.saveProperties({ path: 'N.md' }, true);
  assert.deepEqual(x.notices, ['This note has no strategy that runs. There is nothing to save.']);
  assert.equal(x.writes(), 0);
});

test('a note whose blocks render one after another is written once, a second after the last', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const x = host(note(ONE));
    const props = new NoteProperties(x.h);
    props.scheduleProperties({ path: 'N.md' });
    mock.timers.tick(600);
    props.scheduleProperties({ path: 'N.md' });
    mock.timers.tick(999);
    assert.equal(x.asked.length, 0);
    mock.timers.tick(1);
    await new Promise((r) => setImmediate(r));
    assert.equal(x.asked.length, 1);
    props.scheduleProperties({ path: 'N.md' });
    props.cancel();
    mock.timers.tick(5000);
    await new Promise((r) => setImmediate(r));
    assert.equal(x.asked.length, 1);
  } finally {
    mock.timers.reset();
  }
});

function files(existing: string[] = []) {
  const have = new Set(existing);
  const made: string[] = [];
  const f: NewFiles = {
    exists: async (p) => have.has(p),
    createFolder: async (p) => void have.add(p),
    create: async (p) => {
      have.add(p);
      made.push(p);
    },
  };
  return { f, made, have };
}

test('a saved file is dated in the results folder, its title cleaned, and numbered when the name is taken', async () => {
  const day = isoDate(Date.now());
  const x = files([`Backtests/A b ${day}.csv`]);
  const notices: string[] = [];
  await saveDatedFile(x.f, 'Backtests', 'A/b', 'csv', 'text', (t) => void notices.push(t));
  await saveDatedFile(x.f, 'Backtests', 'A: b#', 'csv', 'text', (t) => void notices.push(t));
  assert.deepEqual(x.made, [`Backtests/A b ${day} (2).csv`, `Backtests/A b ${day} (3).csv`]);
  assert.ok(x.have.has('Backtests'));
  assert.deepEqual(notices, [`Saved to Backtests/A b ${day} (2).csv`, `Saved to Backtests/A b ${day} (3).csv`]);
});

test('a file that cannot be saved says why', async () => {
  const notices: string[] = [];
  const f: NewFiles = { exists: async () => false, createFolder: async () => {}, create: async () => Promise.reject(new Error('disk full')) };
  await saveDatedFile(f, 'Backtests', 'A', 'md', 'text', (t) => void notices.push(t));
  assert.deepEqual(notices, ['Cannot save the file: disk full']);
});

test('a new file takes the next free name, numbered before its extension', async () => {
  const x = files(['Data/a.csv', 'Data/a-2.csv']);
  assert.equal(await createWithFreeName(x.f, 'Data/a.csv', 'x'), 'Data/a-3.csv');
  assert.equal(await createWithFreeName(x.f, 'Data/b.csv', 'x'), 'Data/b.csv');
});

test('a new strategy note is named after its block, in the folder for new notes, and never over a note that is there', async () => {
  const starter = STARTERS[0];
  const name = starter.text.match(/^name:\s*(.+)$/m)![1];
  const x = files([`Trading/${name}.md`]);
  const texts: string[] = [];
  const f = { ...x.f, create: async (p: string, t: string) => void (texts.push(t), await x.f.create(p, t)) };
  assert.equal(await createStrategyNote(f, 'Trading', blockOf(starter)), `Trading/${name}-2.md`);
  assert.deepEqual(texts, [blockOf(starter)]);
  // The top of the vault, a block with no name, and a name with characters a file name cannot have.
  assert.equal(await createStrategyNote(x.f, '', blockOf(EMPTY)), 'My strategy.md');
  assert.equal(await createStrategyNote(x.f, '', '```strategy\nuniverse: SPY\n```\n'), 'Strategy.md');
  assert.equal(await createStrategyNote(x.f, '', '```strategy\nuniverse: SPY\n```\n'), 'Strategy-2.md');
  assert.equal(await createStrategyNote(x.f, 'A/B', '```strategy\nname: SPY/TLT: 60#40\nuniverse: SPY\n```\n'), 'A/B/SPY TLT 60 40.md');
});
