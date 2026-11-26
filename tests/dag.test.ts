import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { DagIndex, dagNodeKey, diffBacktests, parseSignalBlock, parseUniverseBlock, resolveStrategyDag, type VaultReader } from '../src/dag.ts';
import { parseSpec } from '../src/dsl.ts';
import { addTrial, emptyLedger, familyTrialSpread } from '../src/ledger.ts';
import { bars } from './helpers.ts';

function memVault(files: Record<string, string>): VaultReader {
  return {
    resolve(link) {
      const clean = link.replace(/\.md$/i, '').toLowerCase();
      for (const path of Object.keys(files)) {
        const base = path.replace(/\.md$/i, '');
        if (base.toLowerCase() === clean || base.split('/').pop()!.toLowerCase() === clean) return path;
      }
      return null;
    },
    async read(path) {
      return files[path] ?? null;
    },
  };
}

test('resolveStrategyDag composes extends, base keyword, universe blocks, and regime signals', async () => {
  const vault = memVault({
    'Regimes/Credit Stress.md': '```regime\nname: Credit Stress\nvix_high = close of ^VIX > 25\nrisk_off = vix_high\n```',
    'Universes/Core.md': '```universe\nname: Core ETFs\nSPY 60%, TLT 40%\n```',
    'Strategies/Trend Core.md': '```strategy\nname: Trend Core\nuniverse: [[Core]]\ncosts: 5 bps\nbuy when close > sma(200)\nsell when close < sma(200)\n```',
  });
  const child = [
    'name: Trend + Credit Filter',
    'extends: [[Trend Core]]',
    'stop loss: 10%',
    'buy when base and not [[Credit Stress#risk_off]]',
  ].join('\n');

  const resolved = await resolveStrategyDag(child, 'Strategies/Child.md', vault);
  assert.deepEqual(resolved.errors, []);
  assert.ok(resolved.parentSource !== null);
  assert.equal(resolved.parentName, 'Trend Core');
  assert.equal(resolved.rootFamilyKey, dagNodeKey('Strategies/Trend Core.md', 'Trend Core', 'strategy'));
  assert.ok(resolved.dependencies.length >= 3);

  const parsed = parseSpec(resolved.mergedSource);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.spec!.universe.map((a) => a.name), ['SPY', 'TLT']);
  assert.equal(parsed.spec!.costBps, 5);
  assert.equal(parsed.spec!.stops.SPY.stopLoss?.k, 'pct');
  assert.ok(parsed.spec!.extras.some((e) => e.name === '^VIX'));
});

test('resolveStrategyDag detects inheritance cycles cleanly', async () => {
  const vault = memVault({
    'A.md': '```strategy\nname: A\nextends: [[B]]\nbuy when base\n```',
    'B.md': '```strategy\nname: B\nextends: [[A]]\nbuy when base\n```',
  });
  const resolved = await resolveStrategyDag('name: A\nextends: [[B]]\nbuy when base', 'A.md', vault);
  assert.ok(resolved.errors.some((e) => /cycle/i.test(e.message)));
});

test('DagIndex tracks transitive downstream dependents', () => {
  const index = new DagIndex();
  index.record('child', ['parent', 'regime']);
  index.record('grandchild', ['child']);
  assert.deepEqual(new Set(index.dependentsOf('regime')), new Set(['child', 'grandchild']));
  assert.deepEqual(index.dependentsOf('parent'), ['child', 'grandchild']);
  index.remove('child');
  assert.deepEqual(index.dependentsOf('regime'), []);
});

test('diffBacktests computes exact parent vs child delta and avoided losing trades', () => {
  const prices = [100, 102, 104, 106, 108, 100, 92, 95, 98, 102, 106, 110, 114, 118, 122];
  const data = new Map([['SPY', bars(prices)]]);
  const parentSpec = parseSpec('name: Base\nuniverse: SPY\nbuy when close > sma(3)\nsell when close < sma(3)').spec!;
  const childSpec = parseSpec('name: Child\nuniverse: SPY\nstop loss: 5%\nbuy when close > sma(3)\nsell when close < sma(3)').spec!;
  const diff = diffBacktests(runBacktest(parentSpec, data), runBacktest(childSpec, data), 'Base');
  assert.equal(diff.parentName, 'Base');
  assert.ok(Number.isFinite(diff.deltaSharpe));
  assert.ok(Number.isFinite(diff.deltaMaxDD));
});

test('parseSignalBlock and parseUniverseBlock handle exports and formatting', () => {
  const sig = parseSignalBlock('name: Vol\na = stdev(20)\nhigh = a > 2', 'regime');
  assert.equal(sig.name, 'Vol');
  assert.equal(sig.exports.size, 2);
  assert.equal(sig.defaultName, 'high');
  const uni = parseUniverseBlock('name: Tech\nQQQ, XLK\nSMH');
  assert.equal(uni.tickers, 'QQQ, XLK, SMH');
});

test('familyTrialSpread rolls up trials across parent and child ledgers without double-counting', () => {
  let parent = emptyLedger();
  parent = addTrial(parent, 'abc1', 1.1, 252, 1000);
  parent = addTrial(parent, 'abc2', 0.4, 252, 2000);
  let child = emptyLedger();
  child = addTrial(child, 'abc2', 0.4, 252, 2500);
  child = addTrial(child, 'def3', 1.5, 252, 3000);
  const spread = familyTrialSpread([parent, child], 252);
  assert.equal(spread.trials, 3);
  assert.ok(spread.variance > 0);
});

test('extends expands base to false on sell when parent has no sell rule, and keeps shared muted lines outside for-scopes', async () => {
  const vault = memVault({
    'Parent.md': [
      '```strategy',
      'name: Always In',
      'universe: SPY, TLT',
      'buy when true',
      'for SPY:',
      '  stop loss: 10%',
      '```',
    ].join('\n'),
  });
  const child = [
    'name: Guarded',
    'extends: [[Parent]]',
    '~costs: 5 bps',
    'sell when base or close < sma(50)',
  ].join('\n');
  const resolved = await resolveStrategyDag(child, 'Child.md', vault);
  assert.deepEqual(resolved.errors, []);
  assert.match(resolved.mergedSource, /sell when false or close < sma\(50\)/);
  const mutedIdx = resolved.mergedSource.indexOf('~costs: 5 bps');
  const forIdx = resolved.mergedSource.indexOf('for SPY:');
  assert.ok(mutedIdx >= 0 && forIdx >= 0 && mutedIdx < forIdx, 'child shared muted line must precede parent for-scope');
  const parsed = parseSpec(resolved.mergedSource);
  assert.deepEqual(parsed.errors, []);
});
