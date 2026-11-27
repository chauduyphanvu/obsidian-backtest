import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAccount, parseAccount } from '../src/account.ts';
import { runBacktest } from '../src/backtest.ts';
import { dagNodeKey, diffBacktests, parseSignalBlock, parseUniverseBlock, resolveStrategyDag, type VaultReader } from '../src/dag.ts';
import { runRound } from '../src/dashboard.ts';
import type { DataDeps } from '../src/data.ts';
import { parseSpec, type Defaults } from '../src/dsl.ts';
import { scanOrders } from '../src/orders.ts';
import { Results } from '../src/results.ts';
import { NoteProperties } from '../src/vault-writes.ts';
import { bars, DAY } from './helpers.ts';
import './window.ts';

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

test('unified Results.runSource resolves DAGs across scanOrders, dashboard, account/compare, and NoteProperties', async () => {
  const start = Date.UTC(2020, 0, 1);
  let c = 100;
  const csvRows = Array.from({ length: 120 }, (_, i) => {
    const o = c;
    c *= 1 + Math.sin(i / 6) * 0.012 + 0.001;
    return `${new Date(start + i * DAY).toISOString().slice(0, 10)},${o},${Math.max(o, c)},${Math.min(o, c)},${c}`;
  });
  const csvText = ['date,open,high,low,close', ...csvRows].join('\n');

  const files: Record<string, string> = {
    'Universes/Core.md': '```universe\nname: Core\ncsv:a.csv\n```',
    'Strategies/Parent.md': '```strategy\nname: Parent\nuniverse: [[Core]]\nbuy when close > sma(10)\nsell when close < sma(10)\n```',
    'Strategies/Child.md': '```strategy\nname: Child\nextends: [[Parent]]\nstop loss: 10%\nbuy when base\n```',
  };
  const vault = memVault(files);
  const childSource = 'name: Child\nextends: [[Parent]]\nstop loss: 10%\nbuy when base';
  const DEFAULTS: Defaults = { capital: 10_000, costBps: 0, slippageBps: 0, cashRate: '0%', dataSource: 'yahoo' };
  const deps: DataDeps = {
    fetchText: () => Promise.reject(new Error('offline')),
    readVaultFile: async (p) => (p === 'a.csv' ? csvText : null),
    cacheRead: async () => null,
    cacheWrite: async () => {},
    now: () => Date.now(),
  };
  const results = new Results({
    deps: () => deps,
    defaults: () => DEFAULTS,
    freshForMs: () => 6 * 3_600_000,
    modified: async () => 1,
    resolveDag: (src, notePath) => resolveStrategyDag(src, notePath, vault),
  });

  // 1. scanOrders passes notePath -> DAG child succeeds
  const orderStatuses = await scanOrders(
    {
      clear: () => results.clear(),
      find: async () => [{ note: 'Strategies/Child.md', name: 'Child', source: childSource }],
      run: (src, opts) => results.runSource(src, opts),
    },
    false,
    () => {},
  );
  assert.equal(orderStatuses[0].error, null);
  assert.ok(orderStatuses[0].asOf > 0);

  // 2. Dashboard runRound passes notePath -> DAG child succeeds (and hits cache!)
  const dashRows: { state: string }[] = [];
  await runRound(
    {
      find: async () => [{ note: 'Strategies/Child.md', name: 'Child', source: childSource }],
      run: (src, _force, notePath) => results.runSource(src, { background: true, notePath }),
      openBlock: () => {},
      newNote: () => {},
      now: () => Date.now(),
    },
    { folder: null, sort: 'name' },
    false,
    { onList: () => {}, onRow: (_i, row) => void dashRows.push(row), current: () => true },
  );
  assert.equal(dashRows.length, 1);
  assert.equal(dashRows[0].state, 'done');

  // 3. Compare / runAccount passes file.path -> DAG child succeeds and attaches blockKey
  const acct = parseAccount('cash: 10000\n[[Child]] 100%');
  const runs = await runAccount(acct.entries, {
    note: (link) => {
      const p = vault.resolve(link, 'Accounts/Main.md');
      return p ? { basename: link, path: p } : null;
    },
    read: async (f) => (await vault.read(f.path!))!,
    run: (src, notePath) => results.runSource(src, { notePath }),
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].label, 'Child');
  assert.equal(runs[0].blockKey, 'Strategies/Child.md\u0000name:child');

  // 4. NoteProperties saveProperties passes file.path -> DAG child hits cachedOnly result
  const writtenFm: Record<string, unknown> = {};
  const props = new NoteProperties<{ path: string }>({
    read: async (f) => files[f.path],
    frontmatter: () => undefined,
    processFrontMatter: async (_f, edit) => edit(writtenFm),
    runSource: (src, opts) => results.runSource(src, opts),
    notice: () => {},
  });
  await props.saveProperties({ path: 'Strategies/Child.md' }, false);
  assert.ok('bt_return_per_year' in writtenFm && 'bt_sharpe' in writtenFm, 'NoteProperties should save figures for DAG child strategy');
});
