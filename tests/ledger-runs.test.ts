import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { emptyLedger, Ledgers, trialHash, trialOf, versionFigures, versionHash, type Ledger, type LedgerStore } from '../src/ledger.ts';
import { walkForward } from '../src/luck.ts';
import { pbo, stepBlocks, stepsPerYear } from '../src/overfit.ts';
import { blockKeyPrefix, blockStateKey } from '../src/render.ts';
import { runSweep, sweepPbo, sweepTrials, type SweepResult } from '../src/sweep.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY } from './helpers.ts';

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

/** A store in memory that counts its writes, with JsonStore's renamePrefix. */
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
    renamePrefix: async (from: string, to: string) => {
      for (const [k, v] of [...records]) {
        if (!k.startsWith(from)) continue;
        records.delete(k);
        records.set(to + k.slice(from.length), v);
      }
    },
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
