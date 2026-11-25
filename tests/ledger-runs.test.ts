import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { addTries, carriedFrom, emptyLedger, handRenamed, holdsText, Ledgers, mergeLedgers, placeRecord, recordName, trialHash, trialOf, triesToAdd, versionFigures, versionHash, type Ledger, type LedgerStore } from '../src/ledger.ts';
import { walkForward } from '../src/luck.ts';
import { pbo, stepBlocks, stepsPerYear } from '../src/overfit.ts';
import { blockKeyPrefix, blockNameKeySuffix, blockStateKey, keyNote } from '../src/render.ts';
import { runSweep, sweepPbo, sweepTrials, type SweepResult } from '../src/sweep.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY } from './helpers.ts';
import './window.ts';

/** Daily bars over calendar days, each close the last times `growth(day)`. */
function daily(from: string, to: string, growth: (d: Date) => number): Bars {
  const closes: number[] = [];
  const times: number[] = [];
  let c = 100;
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY) {
    if (times.length) c *= growth(new Date(t));
    closes.push(c);
    times.push(t);
  }
  return bars(closes, { times });
}

const wavy = daily('2016-01-01', '2020-12-31', (d) => 1 + 0.012 * Math.sin(d.getTime() / DAY / 9) + 0.004 * Math.cos(d.getTime() / DAY / 2.3));
const SWEPT = 'universe: A\nn = 10 in 0..30 step 10\nbuy when close > sma(n)\nsell when close < sma(n)';

test('each sweep variant carries its trial, steps a year and step blocks, the same as its own run gives', async () => {
  const data = new Map([['A', wavy]]);
  const r = await runSweep(SWEPT, data);
  assert.equal(r.points.length, 4);
  const [broken, ...ran] = r.points;
  // n = 0 does not parse: nothing to count.
  assert.deepEqual([broken.trial, broken.perYear, broken.steps, broken.blocks], [null, null, 0, null]);
  for (const p of ran) {
    const spec = parseSpec(SWEPT, { overrides: p.values }).spec!;
    const bt = runBacktest(spec, data);
    assert.equal(p.trial, trialHash(spec));
    assert.equal(p.perYear, stepsPerYear(bt.run.t));
    assert.deepEqual({ steps: p.steps, blocks: p.blocks }, stepBlocks(bt.run.equity, bt.run.cashReturn));
  }
  assert.equal(new Set(ran.map((p) => p.trial)).size, 3);
});

test('a sweep counts the variants that ran and traded, and the overfitting check reads the same ones', async () => {
  const r = await runSweep(SWEPT, new Map([['A', wavy]]));
  // One variant never trades: it is cash, not a try.
  const idle: SweepResult = { ...r, points: r.points.map((p, i) => (i === 3 ? { ...p, trades: 0 } : p)) };
  const trials = sweepTrials(idle);
  assert.deepEqual(
    trials,
    idle.points.slice(1, 3).map((p) => ({ hash: p.trial!, sharpe: p.stats!.sharpe, perYear: p.perYear! })),
  );
  const check = sweepPbo(idle);
  assert.deepEqual(check, pbo(idle.points.slice(1, 3).map((p) => ({ steps: p.steps, blocks: p.blocks! }))));
  assert.equal(check.short, 'variants');
  assert.equal(check.variants, 2);
});

test('a walk-forward counts every variant that ran and traded, as its own run gives it', async () => {
  const data = new Map([['A', wavy]]);
  const src = 'universe: A\nn = 10 in 10..40 step 10\nbuy when close > sma(n)\nsell when close < sma(n)';
  const w = (await walkForward(src, data, { trainYears: 2, testYears: 1 }))!;
  assert.equal(w.trials.length, 4);
  for (const [i, n] of [10, 20, 30, 40].entries()) {
    const spec = parseSpec(src, { overrides: { n } }).spec!;
    const bt = runBacktest(spec, data);
    assert.deepEqual(w.trials[i], { hash: trialHash(spec), sharpe: bt.stats.sharpe, perYear: stepsPerYear(bt.run.t) });
  }
  // A variant that never trades is not one.
  const never = (await walkForward('universe: A\nn = 10 in 10..20 step 10\nbuy when close > sma(n) and n > 15\nsell when close < sma(n)', data, { trainYears: 2, testYears: 1 }))!;
  assert.equal(never.idle, 1);
  assert.equal(never.trials.length, 1);
});

test('a run shown counts as a try only when it traded, and a version keeps its figures', () => {
  const data = new Map([['A', wavy]]);
  const spec = parseSpec('universe: A\nbuy when close > sma(20)\nsell when close < sma(20)').spec!;
  const bt = runBacktest(spec, data);
  assert.deepEqual(trialOf(spec, bt), { hash: trialHash(spec), sharpe: bt.stats.sharpe, perYear: stepsPerYear(bt.run.t) });
  assert.deepEqual(versionFigures(bt), { cagr: bt.stats.cagr, maxDrawdown: bt.stats.maxDrawdown, sharpe: bt.stats.sharpe, trades: bt.run.trades.length });
  const idle = parseSpec('universe: A\nbuy when false').spec!;
  assert.equal(trialOf(idle, runBacktest(idle, data)), null);
});

/** A store in memory that counts its writes, with JsonStore's moves and list of keys. */
function memory(): LedgerStore & { records: Map<string, Ledger>; writes: number } {
  const records = new Map<string, Ledger>();
  const store = {
    records,
    writes: 0,
    get: async (key: string) => records.get(key) ?? null,
    update: async (key: string, change: (l: Ledger | null) => Ledger) => {
      store.writes++;
      const next = change(records.get(key) ?? null);
      records.set(key, next);
      return next;
    },
    rename: async (from: string, to: string) => {
      const moving = records.get(from);
      if (!moving) return;
      records.delete(from);
      const there = records.get(to);
      records.set(to, there ? mergeLedgers(there, moving) : moving);
    },
    renamePrefix: async (from: string, to: string) => {
      for (const [k, v] of [...records]) {
        if (!k.startsWith(from)) continue;
        records.delete(k);
        records.set(to + k.slice(from.length), v);
      }
    },
    listKeys: async (prefix: string) => [...records.keys()].filter((k) => k.startsWith(prefix)),
  };
  return store;
}

const run = (hash: string, sharpe = 1) => ({ hash, sharpe, perYear: 252 });
const figures = { cagr: 0.1, maxDrawdown: -0.2, sharpe: 1, trades: 4 };

test('a block counts each try once, and drawing it again writes nothing', async () => {
  const store = memory();
  let now = 100;
  const block = new Ledgers(store, () => now).forBlock('Note.md\u0000name:trend');
  await block.add([run('a1'), null, run('b2')], { text: 'universe: SPY', defaults: {}, figures });
  assert.deepEqual(Object.keys((await block.read()).trials), ['a1', 'b2']);
  assert.equal(store.writes, 1);
  now = 200;
  await block.add([run('a1', 2)], { text: 'universe: SPY', defaults: {}, figures });
  assert.equal(store.writes, 1, 'nothing new, nothing written');
  assert.deepEqual((await block.read()).trials.a1, [1, 252, 100]);
  await block.add([run('c3')]);
  assert.equal(store.writes, 2);
  assert.deepEqual((await block.read()).versions.map((v) => [v.hash, v.at]), [[versionHash('universe: SPY', {}), 100]]);
  // A block nobody has drawn reads as empty.
  assert.deepEqual(await new Ledgers(store).forBlock('Other.md\u0000block:0').read(), emptyLedger());
});

test('every drawing of a block hears of a change, and starting the count again clears its tries', async () => {
  const store = memory();
  const ledgers = new Ledgers(store, () => 500);
  const note = ledgers.forBlock('Note.md\u0000name:trend');
  const panel = ledgers.forBlock('Note.md\u0000name:trend');
  const other = ledgers.forBlock('Note.md\u0000name:other');
  const heard: number[] = [];
  const stop = panel.watch((l) => heard.push(Object.keys(l.trials).length));
  other.watch(() => heard.push(-1));
  await note.add([run('a1'), run('b2')]);
  await note.reset();
  assert.deepEqual(heard, [2, 0]);
  assert.equal((await panel.read()).resetAt, 500);
  stop();
  await note.add([run('c3')]);
  assert.deepEqual(heard, [2, 0]);
});

test('renaming a note moves its blocks\' records, and a block drawn before the rename writes to its new key', async () => {
  const store = memory();
  const ledgers = new Ledgers(store, () => 1);
  const old = blockStateKey('Notes/a.md', 'Trend', 0);
  const block = ledgers.forBlock(old);
  await block.add([run('a1')]);
  await ledgers.rename(blockKeyPrefix('Notes/a.md', false), blockKeyPrefix('Notes/b.md', false));
  const moved = blockStateKey('Notes/b.md', 'Trend', 0);
  assert.deepEqual([...store.records.keys()], [moved]);
  await block.add([run('b2')]);
  assert.deepEqual(Object.keys(store.records.get(moved)!.trials), ['a1', 'b2']);
  // A folder moves every note under it.
  await ledgers.rename(blockKeyPrefix('Notes', true), blockKeyPrefix('Archive', true));
  assert.deepEqual([...store.records.keys()], [blockStateKey('Archive/b.md', 'Trend', 0)]);
  await block.add([run('c3')]);
  assert.equal(Object.keys(store.records.get(blockStateKey('Archive/b.md', 'Trend', 0))!.trials).length, 3);
});

test('a new note at a renamed note\'s old path starts its own record, and a block drawn before the rename still follows it', async () => {
  const store = memory();
  const ledgers = new Ledgers(store, () => 1);
  const old = ledgers.forBlock(blockStateKey('Untitled.md', null, 0));
  await old.add([run('trend1')], { text: 'universe: SPY', defaults: {}, figures });
  await ledgers.rename(blockKeyPrefix('Untitled.md', false), blockKeyPrefix('Trend.md', false));
  // Another note made as Untitled.md in the same session.
  const fresh = ledgers.forBlock(blockStateKey('Untitled.md', null, 0));
  const heard: string[][] = [];
  old.watch((l) => heard.push(['old', ...Object.keys(l.trials)]));
  fresh.watch((l) => heard.push(['fresh', ...Object.keys(l.trials)]));
  assert.deepEqual(await fresh.read(), emptyLedger());
  await fresh.add([run('dip1')]);
  await old.add([run('trend2')]);
  assert.deepEqual(Object.keys(store.records.get(blockStateKey('Untitled.md', null, 0))!.trials), ['dip1']);
  assert.deepEqual(Object.keys(store.records.get(blockStateKey('Trend.md', null, 0))!.trials), ['trend1', 'trend2']);
  assert.deepEqual(heard, [['fresh', 'dip1'], ['old', 'trend1', 'trend2']]);
  // Renamed in turn, the new note takes its record along, and the first block keeps to its own.
  await ledgers.rename(blockKeyPrefix('Untitled.md', false), blockKeyPrefix('Dip.md', false));
  await fresh.add([run('dip2')]);
  await old.add([run('trend3')]);
  assert.deepEqual(Object.keys(store.records.get(blockStateKey('Dip.md', null, 0))!.trials), ['dip1', 'dip2']);
  assert.deepEqual(Object.keys(store.records.get(blockStateKey('Trend.md', null, 0))!.trials), ['trend1', 'trend2', 'trend3']);
});

test('a block given a new name takes its record along, and a block whose name only starts the same keeps its own', async () => {
  const store = memory();
  const ledgers = new Ledgers(store, () => 1);
  const trend = ledgers.forBlock(blockStateKey('Notes/a.md', 'Trend', 0));
  const longer = ledgers.forBlock(blockStateKey('Notes/a.md', 'Trend following', 1));
  await trend.add([run('a1'), run('a2')], { text: 'name: Trend', defaults: {}, figures });
  await longer.add([run('l1')]);
  await ledgers.move(blockStateKey('Notes/a.md', 'Trend', 0), blockStateKey('Notes/a.md', 'Trend v2', 0));
  assert.deepEqual([...store.records.keys()].sort(), [blockStateKey('Notes/a.md', 'Trend following', 1), blockStateKey('Notes/a.md', 'Trend v2', 0)]);
  assert.deepEqual(Object.keys(store.records.get(blockStateKey('Notes/a.md', 'Trend v2', 0))!.trials), ['a1', 'a2']);
  // A drawing made before the move writes to the new name; the longer name still writes to its own.
  await trend.add([run('a3')]);
  await longer.add([run('l2')]);
  assert.deepEqual(Object.keys(store.records.get(blockStateKey('Notes/a.md', 'Trend v2', 0))!.trials), ['a1', 'a2', 'a3']);
  assert.deepEqual(Object.keys(store.records.get(blockStateKey('Notes/a.md', 'Trend following', 1))!.trials), ['l1', 'l2']);
  // A block given the old name afterwards is another block, and a move onto a name that has a record joins the two.
  await ledgers.forBlock(blockStateKey('Notes/a.md', 'Trend', 0)).add([run('n1')]);
  assert.deepEqual(Object.keys(store.records.get(blockStateKey('Notes/a.md', 'Trend', 0))!.trials), ['n1']);
  await ledgers.move(blockStateKey('Notes/a.md', 'Trend', 0), blockStateKey('Notes/a.md', 'Trend v2', 0));
  assert.deepEqual(Object.keys(store.records.get(blockStateKey('Notes/a.md', 'Trend v2', 0))!.trials).sort(), ['a1', 'a2', 'a3', 'n1']);
  // A drawing under the new name hears of the tries the move brought along.
  const heard: number[] = [];
  ledgers.forBlock(blockStateKey('Notes/a.md', 'Dip', 2)).watch((l) => heard.push(Object.keys(l.trials).length));
  // A block that had no name moves the same way.
  await ledgers.forBlock(blockStateKey('Notes/a.md', null, 2)).add([run('u1')]);
  await ledgers.move(blockStateKey('Notes/a.md', null, 2), blockStateKey('Notes/a.md', 'Dip', 2));
  assert.deepEqual(Object.keys(store.records.get(blockStateKey('Notes/a.md', 'Dip', 2))!.trials), ['u1']);
  assert.deepEqual(heard, [1]);
});

const ledgerOf = (at: number, text = 'name: Trend\nuniverse: SPY'): Ledger => ({ trials: { t1: [1, 252, at] }, versions: [{ hash: 'v1', text, defaults: 'd', at, figures: { cagr: 0, maxDrawdown: 0, sharpe: 0, trades: 1 } }], resetAt: 0 });

test('a block renamed by hand finds its old record only when exactly one name of its note has a record but no block', () => {
  const key = 'N.md\u0000name:trend v2';
  const old = 'N.md\u0000name:trend';
  const other = 'N.md\u0000name:swing';
  const blocks = [key, other];
  const since = 1000;
  const text = 'name: Trend v2\nuniverse: SPY';
  assert.equal(handRenamed(key, null, [[old, ledgerOf(5)], [other, ledgerOf(5)]], blocks, since, text), old);
  // Tries under the new name made in this session, as by the drawing that asks, do not hide it.
  assert.equal(handRenamed(key, ledgerOf(1500), [[old, ledgerOf(5)]], blocks, since, text), old);
  // A record under the new name from before the session: the block has had that name for a while.
  assert.equal(handRenamed(key, ledgerOf(500), [[old, ledgerOf(5)]], blocks, since, text), null);
  // Two names left behind with the block's text: which one it was is not clear.
  assert.equal(handRenamed(key, null, [[old, ledgerOf(5)], ['N.md\u0000name:gone', ledgerOf(5)]], blocks, since, text), null);
  // No name left behind, or one whose record is empty.
  assert.equal(handRenamed(key, null, [[other, ledgerOf(5)]], blocks, since, text), null);
  assert.equal(handRenamed(key, null, [[old, emptyLedger()], [other, ledgerOf(5)]], blocks, since, text), null);
  assert.equal(handRenamed(key, null, [[old, null]], blocks, since, text), null);
});

test('a record left by a block that was deleted is no old name of a new block with other text', () => {
  const key = 'N.md\u0000name:meanrev';
  const momentum = 'N.md\u0000name:momentum';
  const since = 1000;
  const deleted = ledgerOf(5, 'name: Momentum\nuniverse: SPY\nbuy when close > sma(200)');
  assert.equal(handRenamed(key, null, [[momentum, deleted]], [key], since, 'name: MeanRev\nuniverse: SPY\nbuy when rsi(2) < 10'), null);
  // The same text but for its name line is a rename, whatever the line endings, the blank lines at the end and the comment.
  assert.equal(handRenamed(key, null, [[momentum, deleted]], [key], since, 'name: MeanRev # was Momentum\r\nuniverse: SPY\r\nbuy when close > sma(200)\r\n\n'), momentum);
  // A record with tries but no version has no text to compare.
  assert.equal(handRenamed(key, null, [[momentum, { ...emptyLedger(), trials: { t1: [1, 252, 5] } }]], [key], since, 'name: MeanRev'), null);
  // Of two names left behind, the one with the block's text is the old name.
  const trend = 'N.md\u0000name:trend';
  assert.equal(handRenamed(key, null, [[momentum, deleted], [trend, ledgerOf(5, 'name: Trend\nuniverse: QQQ')]], [key], since, 'name: MeanRev\nuniverse: QQQ'), trend);
});

test('the old name comes from the latest version of its record, as written', async () => {
  assert.equal(recordName(ledgerOf(5, 'universe: SPY\nname: Trend Following # old'), 'trend following'), 'Trend Following');
  assert.equal(recordName({ ...emptyLedger(), trials: { t1: [1, 252, 5] } }, 'trend following'), 'trend following');
  const store = memory();
  const ledgers = new Ledgers(store, () => 2000);
  store.records.set('N.md\u0000name:trend', ledgerOf(5));
  store.records.set('N.md\u0000name:swing', ledgerOf(5, 'name: Swing'));
  store.records.set('N.md\u0000block:0', ledgerOf(5, 'universe: QQQ'));
  store.records.set('M.md\u0000name:other', ledgerOf(5, 'name: Other'));
  const blocks = async () => ['N.md\u0000name:trend v2', 'N.md\u0000name:swing', 'N.md\u0000block:2'];
  const text = 'name: Trend v2\nuniverse: SPY';
  // Only names count: a block keyed by its place moves when blocks move, which is no rename.
  assert.deepEqual(await ledgers.renamedFrom('N.md\u0000name:trend v2', 'N.md\u0000name:', blocks, 1000, text), { key: 'N.md\u0000name:trend', name: 'Trend' });
  await ledgers.forBlock('N.md\u0000name:trend v2').add([run('x1')]);
  assert.deepEqual(await ledgers.renamedFrom('N.md\u0000name:trend v2', 'N.md\u0000name:', blocks, 1000, text), { key: 'N.md\u0000name:trend', name: 'Trend' });
  // A block whose text changed besides its name gives no sign of a rename.
  assert.equal(await ledgers.renamedFrom('N.md\u0000name:trend v2', 'N.md\u0000name:', blocks, 1000, 'name: Trend v2\nuniverse: QQQ'), null);
  await ledgers.move('N.md\u0000name:trend', 'N.md\u0000name:trend v2');
  assert.equal(await ledgers.renamedFrom('N.md\u0000name:trend v2', 'N.md\u0000name:', blocks, 1000, text), null);
});

/** A record with two tries, as a sweep leaves it, first seen at `at`. */
const tuned = (at: number, text = 'name: Trend\nuniverse: SPY'): Ledger => ({ ...ledgerOf(at, text), trials: { t1: [1, 252, at], t2: [0.5, 252, at] } });

test('a block moved or copied from another note finds the record it left there only when exactly one has its text and tries it does not count', () => {
  const key = 'Live.md\u0000name:trend';
  const scratch = 'Scratch.md\u0000name:trend';
  const since = 1000;
  const text = 'name: Trend\nuniverse: SPY';
  assert.equal(carriedFrom(key, null, [[scratch, tuned(5)]], since, text), scratch);
  // Its own tries from this session, such as the run it shows, do not hide it.
  assert.equal(carriedFrom(key, ledgerOf(1500), [[scratch, tuned(5)]], since, text), scratch);
  // A record of its own from before the session: the block has been here for a while.
  assert.equal(carriedFrom(key, ledgerOf(500), [[scratch, tuned(5)]], since, text), null);
  // Two records with its text: which one it came from is not clear.
  assert.equal(carriedFrom(key, null, [[scratch, tuned(5)], ['Old.md\u0000name:trend', tuned(5)]], since, text), null);
  // Other text, no version to compare, or no record.
  assert.equal(carriedFrom(key, null, [[scratch, tuned(5, 'name: Trend\nuniverse: QQQ')]], since, text), null);
  assert.equal(carriedFrom(key, null, [[scratch, { ...emptyLedger(), trials: { t1: [1, 252, 5] } }]], since, text), null);
  assert.equal(carriedFrom(key, null, [[scratch, null]], since, text), null);
  // The comment and the capitals of the name line do not matter.
  assert.equal(carriedFrom(key, null, [[scratch, tuned(5, 'name: trend # tuned\r\nuniverse: SPY\n')]], since, text), scratch);
  // Every try counted already, as after they were added in the same session: no line.
  const today = tuned(1200);
  const added = addTries({ ...emptyLedger(), trials: { x1: [1, 252, 1500] } }, today);
  assert.equal(carriedFrom(key, added, [[scratch, today]], since, text), null);
  // Of two records with its text, the one whose tries are all counted is no candidate.
  const other: Ledger = { ...ledgerOf(1300), trials: { t9: [2, 252, 1300] } };
  assert.equal(carriedFrom(key, added, [[scratch, today], ['Old.md\u0000name:trend', other]], since, text), 'Old.md\u0000name:trend');
  // Tries from before the block's last reset are not offered, since a write drops them.
  assert.equal(carriedFrom(key, { ...emptyLedger(), resetAt: 1600 }, [[scratch, today]], since, text), null);
});

test('the tries a copy adds are those its count lacks, with their figures and first sight, and none from before its reset', () => {
  const from: Ledger = { trials: { a: [1, 252, 5], b: [0.4, 52, 7], c: [2, 252, 9] }, versions: [], resetAt: 0 };
  const to: Ledger = { trials: { a: [1.5, 252, 20] }, versions: [], resetAt: 8 };
  assert.deepEqual(triesToAdd(to, from), [['c', [2, 252, 9]]]);
  assert.deepEqual(addTries(to, from).trials, { a: [1.5, 252, 20], c: [2, 252, 9] });
  assert.deepEqual(addTries(to, from).versions, [], 'versions are not added');
  assert.deepEqual(triesToAdd(null, from).map(([id]) => id), ['a', 'b', 'c']);
  const full = addTries(emptyLedger(), from);
  assert.equal(addTries(full, from), full, 'nothing to add gives the same record');
});

test('a block copied from another note adds the first block\'s tries, which keeps its record, and a block moved takes the whole record', async () => {
  const text = 'name: Trend\nuniverse: SPY';
  const scratch = blockStateKey('Scratch.md', 'Trend', 0);
  const live = blockStateKey('Live.md', 'Trend', 0);
  const suffix = blockNameKeySuffix('Trend');
  assert.equal(keyNote(live), 'Live.md');

  const store = memory();
  const ledgers = new Ledgers(store, () => 1500);
  store.records.set(scratch, { ...ledgerOf(5, text), trials: { t1: [1, 252, 5], t2: [0.5, 252, 6] } });
  // Records of another name, or kept by a block's place, are never candidates, whatever their text.
  store.records.set(blockStateKey('Scratch.md', 'Trend v2', 1), tuned(5, text));
  store.records.set(blockStateKey('Scratch.md', null, 2), tuned(5, text));
  const copy = ledgers.forBlock(live);
  const heard: number[] = [];
  copy.watch((l) => heard.push(Object.keys(l.trials).length));
  // The copy draws first and counts the run it shows, which the first block counted too.
  await copy.add([run('t1')], { text, defaults: {}, figures });
  assert.deepEqual(await ledgers.carriedFrom(live, suffix, async () => true, 1000, text), { key: scratch, moved: false, tries: 1 });
  assert.equal(await ledgers.copyTrials(scratch, live), 1);
  assert.deepEqual(store.records.get(live)!.trials, { t1: [1, 252, 1500], t2: [0.5, 252, 6] });
  assert.equal(Object.keys(store.records.get(scratch)!.trials).length, 2, 'the first block keeps its record');
  assert.deepEqual(heard, [1, 2]);
  assert.equal(await ledgers.carriedFrom(live, suffix, async () => true, 1000, text), null);
  assert.equal(await ledgers.copyTrials(scratch, live), 0);

  const cut = memory();
  const moving = new Ledgers(cut, () => 1500);
  cut.records.set(scratch, tuned(5, text));
  assert.deepEqual(await moving.carriedFrom(live, suffix, async (k) => k !== scratch, 1000, text), { key: scratch, moved: true, tries: 2 });
  await moving.move(scratch, live);
  assert.deepEqual([...cut.records.keys()], [live]);
  assert.equal(await moving.carriedFrom(live, suffix, async () => false, 1000, text), null);
});

test('a record holds a block\'s text when one of its versions has it, but for the name line', () => {
  const two: Ledger = { ...ledgerOf(5, 'universe: SPY'), versions: [...ledgerOf(5, 'universe: SPY').versions, { ...ledgerOf(9, 'universe: QQQ').versions[0], hash: 'v2' }] };
  assert.ok(holdsText(two, 'name: Trend\nuniverse: SPY\r\n'));
  assert.ok(holdsText(two, 'universe: QQQ'));
  assert.ok(!holdsText(two, 'universe: IWM'));
  assert.ok(!holdsText(emptyLedger(), 'universe: SPY'));
  assert.ok(!holdsText(null, 'universe: SPY'));
});

test('a block with no name finds the record it kept by its place, also after a block was put above it', async () => {
  const at = (i: number) => blockStateKey('Old.md', null, i);
  const dip = 'universe: SPY\nbuy when close > sma(15)';
  const slow = 'universe: SPY\nbuy when close > sma(40)';
  const fresh = 'universe: SPY\nbuy when close > sma(25)';
  const kept = (text: string) => ledgerOf(5, text);
  // Slow was the second block; a new block now sits between it and Dip.
  assert.equal(placeRecord(at(2), null, [[at(0), kept(dip)], [at(1), kept(slow)]], slow), at(1));
  assert.equal(placeRecord(at(1), kept(slow), [[at(0), kept(dip)]], fresh), null);
  assert.equal(placeRecord(at(0), kept(dip), [[at(1), kept(slow)]], 'name: Dip\n' + dip), at(0));
  assert.equal(placeRecord(at(2), null, [[at(0), kept(slow)], [at(1), kept(slow)]], slow), null);

  const store = memory();
  store.records.set(at(0), kept(dip));
  store.records.set(at(1), kept(slow));
  store.records.set(blockStateKey('Old.md', 'Other', 0), kept(slow));
  store.records.set(blockStateKey('Older.md', null, 0), kept(slow));
  const ledgers = new Ledgers(store, () => 1000);
  assert.equal(await ledgers.placeRecord(at(2), `${blockKeyPrefix('Old.md', false)}block:`, slow), at(1));
  assert.equal(await ledgers.placeRecord(at(1), `${blockKeyPrefix('Old.md', false)}block:`, fresh), null);
});

test('the key of a block starts with its note\'s prefix and its folders\', and no other note\'s', () => {
  const key = blockStateKey('Trading/Ideas/a.md', 'Trend', 2);
  assert.ok(key.startsWith(blockKeyPrefix('Trading/Ideas/a.md', false)));
  assert.ok(key.startsWith(blockKeyPrefix('Trading/Ideas', true)));
  assert.ok(key.startsWith(blockKeyPrefix('Trading', true)));
  assert.ok(!key.startsWith(blockKeyPrefix('Trading/Ideas/a', false)));
  assert.ok(!key.startsWith(blockKeyPrefix('Trading/Id', true)));
  assert.ok(!blockStateKey('Trading/Ideas/ab.md', null, 0).startsWith(blockKeyPrefix('Trading/Ideas/a.md', false)));
});

test('a walk-forward whose picks are ruined stays at 0 from the ruin, with no gaps in its line', async () => {
  // Six years rising gently, then at the start of the fifth an open 95% below the last close: bought at 200%, still above
  // 100% after the rise, the long is ruined there.
  const closes: number[] = [];
  const opens: number[] = [];
  let p = 100;
  for (let i = 0; i < 6 * 260; i++) {
    const o = i === 4 * 260 ? p * 0.05 : p;
    p = o * 1.001;
    opens.push(o);
    closes.push(p);
  }
  const days = bars(closes, { opens, highs: closes.map((c, i) => Math.max(c, opens[i])), lows: closes.map((c, i) => Math.min(c, opens[i])), step: DAY * 7 / 5 });
  const data = new Map([['A', days]]);
  const w = (await walkForward('universe: A 200%\nmargin rate: 0%\nn = 10 in 10..20 step 10\nbuy when close > sma(n)', data, { trainYears: 2, testYears: 1 }))!;
  assert.ok(w.equity.every(Number.isFinite), 'the stitched line has no gaps');
  assert.equal(w.equity.at(-1), 0);
  assert.ok(w.declared.equity.every(Number.isFinite) && w.hindsight.equity.every(Number.isFinite));
  assert.ok(w.windows.every((x) => Number.isFinite(x.testReturn) && Number.isFinite(x.declaredReturn)));
  assert.deepEqual([w.stats.totalReturn, w.stats.maxDrawdown], [-1, -1]);
  // A training stretch with the ruin in it scores the ruin, below any gain, not the flat line after it.
  const bySharpe = (await walkForward('universe: A 200%\nmargin rate: 0%\nn = 10 in 10..20 step 10\nbuy when close > sma(n)', data, { trainYears: 2, testYears: 1, metric: 'sharpe' }))!;
  const ruinT = days.t[4 * 260];
  const ruined = bySharpe.windows.filter((x) => x.trainFrom <= ruinT && ruinT <= x.trainTo);
  assert.ok(ruined.length > 0);
  for (const x of ruined) assert.ok(x.trainScore < 0, `${x.trainScore}`);
});
