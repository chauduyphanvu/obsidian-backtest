// The strategy blocks on screen as the commands for a whole note and for a rename reach them: drawn into a stand-in for the
// page, from a CSV file, with the runs on this thread.
import { El } from './page.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DataDeps } from '../src/data.ts';
import type { Defaults } from '../src/dsl.ts';
import { Ledgers, type Ledger, type LedgerStore } from '../src/ledger.ts';
import { ADD_NAME, NAME_IT, UNNAMED } from '../src/render-luck.ts';
import { blockStateKey } from '../src/render.ts';
import { Results } from '../src/results.ts';
import { normalizeSettings } from '../src/settings-core.ts';
import { StrategyBlocks, type BlocksHost } from '../src/strategy-block.ts';
import { DAY } from './helpers.ts';

const DEFAULTS: Defaults = { capital: 10_000, costBps: 0, slippageBps: 0, cashRate: '0%', dataSource: 'yahoo' };
const block = (name: string, n = 20) => `name: ${name}\nuniverse: csv:a.csv\nbuy when close > sma(${n})\nsell when close < sma(${n})`;

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

function setup(more: Partial<BlocksHost> = {}) {
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
  const results = new Results({ deps: () => deps, defaults: () => DEFAULTS, freshForMs: () => 6 * 3_600_000, modified: async () => 1 });
  const records = new Map<string, Ledger>();
  const store: LedgerStore = {
    get: async (key) => records.get(key) ?? null,
    update: async (key, change) => {
      const next = change(records.get(key) ?? null);
      records.set(key, next);
      return next;
    },
    rename: async () => {},
    renamePrefix: async () => {},
    listKeys: async (prefix) => [...records.keys()].filter((k) => k.startsWith(prefix)),
  };
  const settings = { ...normalizeSettings(null), writeProperties: false };
  const blocks = new StrategyBlocks({
    results,
    ledgers: new Ledgers(store),
    settings: () => settings,
    saveFile: async () => {},
    copy: () => {},
    openSettings: () => {},
    openCsv: () => {},
    lookup: () => null,
    scheduleProperties: () => {},
    startForward: async () => {},
    saveProperties: async () => {},
    showMenu: () => {},
    ...more,
  });
  const draw = async (source: string, opts: { panel?: boolean; key?: string; rename?: () => void } = {}) => {
    const el = new El('div');
    const child = {};
    const key = opts.key ?? blockStateKey('N.md', source.match(/^name: (.*)$/m)?.[1] ?? null, 0);
    const place = opts.panel ? { panel: true, blockKey: key } : { stateKey: key, blockKey: key, ...(opts.rename ? { rename: opts.rename } : {}) };
    await blocks.renderStrategy(source, el as unknown as HTMLElement, child, { notePath: 'N.md', ...place });
    return { el, child, card: () => el.byClass('bt-result')[0] };
  };
  return { blocks, results, reads, draw, records };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('refreshing a note runs its blocks on screen in place and the others here, each text once', async () => {
  const { blocks, results, reads, draw } = setup();
  const shown = await draw(block('Trend'));
  const first = shown.card();
  assert.ok(first);
  reads.length = 0;
  const done = await blocks.refreshNote('N.md', [block('Trend'), block('Swing', 30), block('Swing', 30)]);
  assert.deepEqual(done, { ran: 3, problem: null });
  // The block on screen has a new result in place of the old one; the other one ran once, and is kept for when it draws.
  assert.notEqual(shown.card(), first);
  assert.equal(shown.el.byClass('bt-result').length, 1);
  assert.equal(reads.length, 2);
  const kept = await results.runSource(block('Swing', 30), { cachedOnly: true });
  assert.ok(kept.backtest.run.t.length > 0);
  // A block that cannot run says why.
  const bad = await blocks.refreshNote('N.md', ['universe: csv:gone.csv\nbuy when true']);
  assert.equal(bad.ran, 0);
  assert.match(bad.problem ?? '', /gone\.csv/);
  // Another note's blocks are not touched.
  reads.length = 0;
  await blocks.refreshNote('Other.md', []);
  assert.equal(shown.card(), shown.el.byClass('bt-result')[0]);
  assert.equal(reads.length, 0);
});

test('folding a note folds its results on screen, not the preview\'s, and the others draw folded', async () => {
  const { blocks, draw } = setup();
  const trend = await draw(block('Trend'));
  const panel = await draw(block('Trend'), { panel: true });
  assert.ok(!trend.card().classes().includes('bt-folded'));
  const keys = [blockStateKey('N.md', 'Trend', 0), blockStateKey('N.md', 'Swing', 1)];
  blocks.setOpenInNote('N.md', keys, false);
  assert.ok(trend.card().classes().includes('bt-folded'));
  assert.ok(!panel.card().classes().includes('bt-folded'));
  const swing = await draw(block('Swing', 30), { key: keys[1] });
  assert.ok(swing.card().classes().includes('bt-folded'));
  blocks.setOpenInNote('N.md', keys, true);
  assert.ok(!trend.card().classes().includes('bt-folded'));
  assert.ok(!swing.card().classes().includes('bt-folded'));
  // A renamed block keeps its state under its new key.
  blocks.setOpenInNote('N.md', keys, false);
  blocks.moveState(keys[0], blockStateKey('N.md', 'Trend v2', 0));
  const renamed = await draw(block('Trend v2'));
  assert.ok(renamed.card().classes().includes('bt-folded'));
});

test('a block in its note shows the line of a record it left elsewhere when the plugin finds one, and the preview does not', async () => {
  const asked: string[] = [];
  const take = async () => {};
  const { draw } = setup({
    oldRecord: async (note, key, name, text) => {
      // The block's text is what tells a rename, a move or a copy from a new block.
      assert.equal(text, block(name));
      asked.push(`${note} ${key} ${name}`);
      if (name === 'Trend v2') return { kind: 'renamed', name: 'Trend', take };
      if (name === 'Moved') return { kind: 'moved', note: 'Scratch.md', take };
      if (name === 'Copied') return { kind: 'copied', note: 'Scratch.md', name: 'Copied', tries: 120, take };
      return null;
    },
  });
  const renamed = await draw(block('Trend v2'));
  await settle();
  assert.equal(renamed.el.byClass('bt-renamed').length, 1);
  assert.match(renamed.el.byClass('bt-renamed')[0].textContent, /the old name "Trend"/);
  const moved = await draw(block('Moved'));
  await settle();
  assert.match(moved.el.byClass('bt-renamed')[0].textContent, /was in Scratch\.md before.*Move the record to this note/);
  const copied = await draw(block('Copied'));
  await settle();
  assert.match(copied.el.byClass('bt-renamed')[0].textContent, /does not include 120 tries of that block\.Add them to the count/);
  const other = await draw(block('Swing'));
  await settle();
  assert.equal(other.el.byClass('bt-renamed').length, 0);
  await draw(block('Trend v2'), { panel: true });
  await settle();
  assert.deepEqual(
    asked,
    ['Trend v2', 'Moved', 'Copied', 'Swing'].map((n) => `N.md ${blockStateKey('N.md', n, 0)} ${n}`),
  );
});

test('a block with no name counts no tries, has no Versions section, and asks for a name in "How many tries"', async () => {
  let asked = 0;
  const { draw, records } = setup({
    oldRecord: async () => {
      asked++;
      return null;
    },
  });
  const unnamed = 'universe: csv:a.csv\nbuy when close > sma(20)\nsell when close < sma(20)';
  let renames = 0;
  const note = await draw(unnamed, { rename: () => renames++ });
  await settle();
  assert.equal(records.size, 0, 'nothing is recorded under the place of the block');
  assert.equal(note.el.byClass('bt-versions').length, 0);
  assert.equal(note.el.byClass('bt-figures-note')[0]?.textContent ?? '', '');
  note.el.byClass('bt-luck')[0].dispatch('toggle');
  const tries = note.el.byClass('bt-luck-verdict')[0];
  assert.equal(tries.textContent, UNNAMED);
  const button = tries.parent!.byClass('bt-button').find((b) => b.textContent === NAME_IT)!;
  button.dispatch('click');
  assert.equal(renames, 1);
  assert.equal(asked, 0);
  // The preview panel can't edit the block, so it says how to name it instead.
  const panel = await draw(unnamed, { panel: true });
  panel.el.byClass('bt-luck')[0].dispatch('toggle');
  const said = panel.el.byClass('bt-luck-verdict')[0];
  assert.equal(said.textContent, `${UNNAMED} ${ADD_NAME}`);
  assert.equal(said.parent!.byClass('bt-button').filter((b) => b.textContent === NAME_IT).length, 0);
  assert.equal(records.size, 0);
});
