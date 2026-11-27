import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderSteps } from '../src/account.ts';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import {
  createConfirmFillEvent,
  ensureOpeningBalanceEvent,
  mergeLedgerJsonl,
  parseLedgerJsonl,
  projectAccountState,
  projectAccountWithStatus,
  rewriteLedgerStrategyKey,
  serializeLedgerEvent,
} from '../src/fill-ledger.ts';
import { evaluateKillSwitch, killSwitchContext } from '../src/killswitch.ts';
import { buildDeploymentCommit, computeRealityTape, liveSinceLine } from '../src/lifecycle.ts';
import { DEFAULT_SETTINGS, defaultsFrom } from '../src/settings-core.ts';
import { bars } from './helpers.ts';

test('fill-ledger projects holdings/cash deterministically and merges multi-device JSONL without clobbering or duplicating', () => {
  const buySpy = createConfirmFillEvent({ account: 'Main', ticker: 'SPY', side: 'buy', quantity: 10, price: 500, fees: 1, t: Date.UTC(2026, 0, 10) });
  const sellSpy = createConfirmFillEvent({ account: 'Main', ticker: 'SPY', side: 'sell', quantity: 4, price: 520, fees: 1, t: Date.UTC(2026, 0, 20) });
  const deviceA = [buySpy].map(serializeLedgerEvent).join('\n') + '\n';
  // Device B synced sellSpy + a duplicate of buySpy; Device A now logs TLT buy.
  const buyTlt = createConfirmFillEvent({ account: 'Main', ticker: 'TLT', side: 'buy', quantity: 20, price: 90, fees: 0, t: Date.UTC(2026, 0, 25) });
  const syncedDisk = mergeLedgerJsonl(deviceA, [buySpy, sellSpy]);
  const merged = mergeLedgerJsonl(syncedDisk, [buyTlt, sellSpy]);
  const parsed = parseLedgerJsonl(merged);
  assert.equal(parsed.length, 3);
  assert.deepEqual(
    parsed.map((e) => e.ticker),
    ['SPY', 'SPY', 'TLT'],
  );

  const projected = projectAccountState(parsed, 'Main', { cash: 10_000 });
  assert.deepEqual(projected.holdings, [
    { ticker: 'SPY', shares: 6 },
    { ticker: 'TLT', shares: 20 },
  ]);
  // 10000 - 5001 + 2079 - 1800 = 5278
  assert.equal(projected.cash, 5278);
});

test('ensureOpeningBalanceEvent prevents double-counting after Markdown edits and flags divergence', () => {
  const fillTs = Date.UTC(2026, 1, 5);
  const initialOpening = { holdings: [{ ticker: 'SPY', shares: 10 }], cash: 5_000 };
  const wm = ensureOpeningBalanceEvent([], 'Main', initialOpening, fillTs);
  assert.ok(wm !== null);
  assert.equal(wm.kind, 'opening_balance');
  assert.equal(wm.t, 0);

  const fill = createConfirmFillEvent({ account: 'Main', ticker: 'SPY', side: 'buy', quantity: 5, price: 100, fees: 0, t: fillTs });
  const events = [wm, fill];
  // Second call for the same account returns null (one-time watermark).
  assert.equal(ensureOpeningBalanceEvent(events, 'Main', initialOpening, fillTs + 1000), null);

  // Unedited Markdown block matches watermark -> no divergence.
  const clean = projectAccountWithStatus(events, 'Main', initialOpening);
  assert.equal(clean.divergesFromBlock, false);
  assert.equal(clean.loggedEvents, 1);
  assert.deepEqual(clean.projected.holdings, [{ ticker: 'SPY', shares: 15 }]);
  assert.equal(clean.projected.cash, 4_500);

  // User manually edits Markdown holdings to SPY 50, cash 1000 -> watermark prevents double-counting and flags divergence!
  const edited = projectAccountWithStatus(events, 'Main', { holdings: [{ ticker: 'SPY', shares: 50 }], cash: 1_000 });
  assert.equal(edited.divergesFromBlock, true);
  assert.deepEqual(edited.projected.holdings, [{ ticker: 'SPY', shares: 15 }]);
  assert.equal(edited.projected.cash, 4_500);
});

test('ensureOpeningBalanceEvent anchors at t=0 so upgrade-vault fills and concurrent multi-device first fills are never wiped', () => {
  const opening = { holdings: [{ ticker: 'SPY', shares: 10 }], cash: 10_000 };
  // (a) Upgrade vault with pre-existing fills [t1, t2] and no opening_balance yet, then a new fill at t3.
  const t1 = Date.UTC(2026, 0, 5);
  const t2 = Date.UTC(2026, 0, 12);
  const t3 = Date.UTC(2026, 1, 1);
  const f1 = createConfirmFillEvent({ account: 'Main', ticker: 'SPY', side: 'buy', quantity: 5, price: 100, fees: 0, t: t1 });
  const f2 = createConfirmFillEvent({ account: 'Main', ticker: 'TLT', side: 'buy', quantity: 10, price: 90, fees: 0, t: t2 });
  const preUpgradeDisk = `${serializeLedgerEvent(f1)}\n${serializeLedgerEvent(f2)}\n`;
  const existing = parseLedgerJsonl(preUpgradeDisk);
  const wmUpgrade = ensureOpeningBalanceEvent(existing, 'Main', opening, t3)!;
  assert.equal(wmUpgrade.t, 0);
  const f3 = createConfirmFillEvent({ account: 'Main', ticker: 'SPY', side: 'buy', quantity: 3, price: 105, fees: 0, t: t3 });
  const upgraded = parseLedgerJsonl(mergeLedgerJsonl(preUpgradeDisk, [wmUpgrade, f3]));
  const projUpgrade = projectAccountState(upgraded, 'Main', opening);
  // All three fills preserved: SPY 10 + 5 + 3 = 18, TLT 10, cash = 10000 - 500 - 900 - 315 = 8285.
  assert.deepEqual(projUpgrade.holdings, [
    { ticker: 'SPY', shares: 18 },
    { ticker: 'TLT', shares: 10 },
  ]);
  assert.equal(projUpgrade.cash, 8285);

  // (b) Concurrent multi-device first fills with identical opening balances emit the same watermark id and preserve both fills.
  const wmA = ensureOpeningBalanceEvent([], 'Main', { holdings: [{ ticker: 'TLT', shares: 5 }, { ticker: 'spy', shares: 10 }], cash: 5_000 })!;
  const wmB = ensureOpeningBalanceEvent([], 'Main', { holdings: [{ ticker: 'SPY', shares: 10 }, { ticker: 'TLT', shares: 5 }], cash: 5_000 })!;
  assert.equal(wmA.id, wmB.id, 'canonicalized holdings at t=0 must produce identical watermark IDs across devices');
  const devAFill = createConfirmFillEvent({ account: 'Main', ticker: 'SPY', side: 'buy', quantity: 2, price: 100, fees: 0, t: Date.UTC(2026, 2, 1, 10) });
  const devBFill = createConfirmFillEvent({ account: 'Main', ticker: 'QQQ', side: 'buy', quantity: 4, price: 50, fees: 0, t: Date.UTC(2026, 2, 1, 11) });
  const diskA = mergeLedgerJsonl('', [wmA, devAFill]);
  const mergedBoth = parseLedgerJsonl(mergeLedgerJsonl(diskA, [wmB, devBFill]));
  assert.equal(mergedBoth.filter((e) => e.kind === 'opening_balance').length, 1);
  const projBoth = projectAccountState(mergedBoth, 'Main', { holdings: [{ ticker: 'SPY', shares: 10 }, { ticker: 'TLT', shares: 5 }], cash: 5_000 });
  assert.deepEqual(projBoth.holdings, [
    { ticker: 'QQQ', shares: 4 },
    { ticker: 'SPY', shares: 12 },
    { ticker: 'TLT', shares: 5 },
  ]);
  assert.equal(projBoth.cash, 4_600);
});

test('rewriteLedgerStrategyKey updates strategy attribution on exact and prefix renames while keeping event IDs intact', () => {
  const e1 = createConfirmFillEvent({ account: 'Main', strategy: 'Strategies/Alpha.md\u0000name:trend', ticker: 'SPY', side: 'buy', quantity: 5, price: 100, t: 1000 });
  const e2 = createConfirmFillEvent({ account: 'Main', strategy: 'Strategies/Beta.md\u0000name:swing', ticker: 'QQQ', side: 'buy', quantity: 5, price: 200, t: 2000 });
  const raw = `${serializeLedgerEvent(e1)}\n${serializeLedgerEvent(e2)}\n`;

  // Exact strategy rename
  const exact = rewriteLedgerStrategyKey(raw, 'Strategies/Alpha.md\u0000name:trend', 'Strategies/Alpha.md\u0000name:momentum', true);
  assert.equal(exact.changed, 1);
  const parsedExact = parseLedgerJsonl(exact.text);
  assert.equal(parsedExact[0].id, e1.id);
  assert.equal(parsedExact[0].strategy, 'Strategies/Alpha.md\u0000name:momentum');
  assert.equal(parsedExact[1].strategy, 'Strategies/Beta.md\u0000name:swing');

  // Folder prefix rename
  const folder = rewriteLedgerStrategyKey(exact.text, 'Strategies/', 'Archive/Strategies/', false);
  assert.equal(folder.changed, 2);
  const parsedFolder = parseLedgerJsonl(folder.text);
  assert.equal(parsedFolder[0].strategy, 'Archive/Strategies/Alpha.md\u0000name:momentum');
  assert.equal(parsedFolder[1].strategy, 'Archive/Strategies/Beta.md\u0000name:swing');
});

test('flip orders decompose via orderSteps into two accurate fill legs and preserve cost basis', () => {
  // Long 30 -> Short 50 (shares = -80): sell 30, then sell short 50
  const toShort = orderSteps({ holding: 30, shares: -80 });
  assert.deepEqual(toShort, [
    { action: 'sell', shares: 30 },
    { action: 'short', shares: 50 },
  ]);
  const t0 = Date.UTC(2026, 2, 1);
  const legsToShort = toShort.map((s, i) => createConfirmFillEvent({ account: 'Main', ticker: 'SPY', side: s.action, quantity: s.shares, price: 100, fees: 0, t: t0 + i }));
  const afterShort = projectAccountState(legsToShort, 'Main', { holdings: [{ ticker: 'SPY', shares: 30 }], cash: 7_000 });
  assert.deepEqual(afterShort.holdings, [{ ticker: 'SPY', shares: -50 }]);
  assert.equal(afterShort.cash, 15_000);
  assert.equal(afterShort.costBasis.get('SPY'), 100);

  // Short 50 -> Long 20 (shares = +70): cover 50, then buy 20
  const toLong = orderSteps({ holding: -50, shares: 70 });
  assert.deepEqual(toLong, [
    { action: 'cover', shares: 50 },
    { action: 'buy', shares: 20 },
  ]);
  const legsToLong = toLong.map((s, i) => createConfirmFillEvent({ account: 'Main', ticker: 'SPY', side: s.action, quantity: s.shares, price: 90, fees: 0, t: t0 + 10 + i }));
  const afterLong = projectAccountState([...legsToShort, ...legsToLong], 'Main', { holdings: [{ ticker: 'SPY', shares: 30 }], cash: 7_000 });
  assert.deepEqual(afterLong.holdings, [{ ticker: 'SPY', shares: 20 }]);
  assert.equal(afterLong.costBasis.get('SPY'), 90);
});

test('lifecycle deployment commit + 3-track reality tape + kill-switch evaluation work end-to-end', () => {
  const prices: number[] = [];
  let p = 100;
  for (let i = 0; i < 160; i++) {
    // Strong first 110 bars (pre-deployment), then sharp 25% drawdown post-deployment!
    const r = i < 110 ? 0.003 + Math.sin(i / 5) * 0.004 : -0.007;
    p *= 1 + r;
    prices.push(p);
  }
  const fullBars = bars(prices);
  const preBars = {
    t: fullBars.t.slice(0, 110),
    o: fullBars.o.slice(0, 110),
    h: fullBars.h.slice(0, 110),
    l: fullBars.l.slice(0, 110),
    c: fullBars.c.slice(0, 110),
    v: fullBars.v.slice(0, 110),
  };
  const src = [
    'name: Trend',
    'universe: SPY',
    'slippage: 5 bps',
    'buy when true',
    'invalidate when live drawdown > 1.25 * backtest max drawdown',
    '  or (live bars >= 30 and live percentile < 10%)',
  ].join('\n');
  const spec = parseSpec(src).spec!;
  const preBt = runBacktest(spec, new Map([['SPY', preBars]]));
  const commit = buildDeploymentCommit({ blockKey: 'Test.md\u0000name:trend', version: 1, source: src, defaults: defaultsFrom(DEFAULT_SETTINGS), bt: preBt });
  assert.match(liveSinceLine(commit), /^\d{4}-\d{2}-\d{2} @[a-z0-9]+$/);

  const postBt = runBacktest(spec, new Map([['SPY', fullBars]]));
  const fill = createConfirmFillEvent({
    account: 'Main',
    strategy: commit.blockKey,
    ticker: 'SPY',
    side: 'buy',
    quantity: 70,
    price: fullBars.o[110] * 1.003, // 30 bps adverse slippage
    t: fullBars.t[110],
  });
  const tape = computeRealityTape(commit, postBt, [fill], 'Main', 10_000);
  assert.ok(tape !== null);
  assert.equal(tape.shadow, null);
  assert.equal(tape.shortfall.shadowReturn, null);
  assert.equal(tape.shortfall.dataRevisionGap, null);
  assert.equal(tape.realized?.length, tape.t.length);
  assert.ok(tape.shortfall.liveDrawdown > 0.15);
  assert.ok(tape.shortfall.slippageDriftBps > 15);
  assert.ok(tape.shortfall.livePercentile < 15);

  const report = evaluateKillSwitch(spec.invalidate, killSwitchContext(commit, tape.shortfall));
  assert.equal(report.status, 'halted');
  assert.ok(report.trippedClauses.length >= 1);

  // Untagged multi-sleeve fills must NOT leak into a single strategy's realized curve or kill-switch unless soleStrategyAccount is true.
  const untaggedFill = createConfirmFillEvent({
    account: 'Main',
    ticker: 'SPY',
    side: 'buy',
    quantity: 70,
    price: fullBars.o[110] * 1.003,
    t: fullBars.t[110],
  });
  const isolatedTape = computeRealityTape(commit, postBt, [untaggedFill], 'Main', 10_000);
  assert.ok(isolatedTape !== null);
  assert.equal(isolatedTape.realized, null);
  assert.equal(isolatedTape.shortfall.realizedReturn, null);

  // When caller explicitly certifies a sole-strategy account, untagged fills are included.
  const soleTape = computeRealityTape(commit, postBt, [untaggedFill], 'Main', 10_000, { soleStrategyAccount: true });
  assert.ok(soleTape !== null);
  assert.ok(soleTape.realized !== null);
  assert.ok(soleTape.shortfall.realizedReturn !== null);

  // Explicitly strategy-tagged fills from a non-Active-Book account ("IRA") still compute realized equity & kill-switch even when Active Book is "Main".
  const iraFill = createConfirmFillEvent({
    account: 'IRA',
    strategy: commit.blockKey,
    ticker: 'SPY',
    side: 'buy',
    quantity: 70,
    price: fullBars.o[110] * 1.003,
    t: fullBars.t[110],
  });
  const iraTape = computeRealityTape(commit, postBt, [iraFill], 'Main', 10_000);
  assert.ok(iraTape !== null);
  assert.ok(iraTape.realized !== null);
  assert.ok(iraTape.shortfall.slippageDriftBps > 15);
  assert.equal(evaluateKillSwitch(spec.invalidate, killSwitchContext(commit, iraTape.shortfall)).status, 'halted');

  // Commit hash uses full base36 (no 6-char truncation) while legacy 6-char pins remain parseable.
  assert.ok(commit.commitHash.length >= 6);
  const legacyParsed = parseSpec('universe: SPY\nlive since: 2026-04-01 @a9f3c1\nbuy when true');
  assert.equal(legacyParsed.spec?.liveSince?.commit, 'a9f3c1');
  const fullParsed = parseSpec(`universe: SPY\nlive since: ${liveSinceLine(commit)}\nbuy when true`);
  assert.equal(fullParsed.spec?.liveSince?.commit, commit.commitHash);
});

test('evaluateKillSwitch handles healthy, warning, and halted states accurately', () => {
  const expr = 'live drawdown > 1.25 * backtest max drawdown or live slippage > 3 * modeled slippage';
  const healthy = evaluateKillSwitch(expr, {
    liveDrawdown: 0.05,
    backtestMaxDrawdown: 0.2,
    livePercentile: 0.5,
    liveRollingSharpe: 0.8,
    liveSlippageBps: 5,
    modeledSlippageBps: 5,
    liveBars: 30,
    liveReturn: 0.04,
  });
  assert.equal(healthy.status, 'healthy');

  const warning = evaluateKillSwitch(expr, {
    liveDrawdown: 0.23, // within 15% of 0.25 threshold!
    backtestMaxDrawdown: 0.2,
    livePercentile: 0.3,
    liveRollingSharpe: 0.1,
    liveSlippageBps: 5,
    modeledSlippageBps: 5,
    liveBars: 30,
    liveReturn: -0.05,
  });
  assert.equal(warning.status, 'warning');

  const halted = evaluateKillSwitch(expr, {
    liveDrawdown: 0.05,
    backtestMaxDrawdown: 0.2,
    livePercentile: 0.5,
    liveRollingSharpe: 0.8,
    liveSlippageBps: 20,
    modeledSlippageBps: 5,
    liveBars: 30,
    liveReturn: 0.02,
  });
  assert.equal(halted.status, 'halted');
  assert.equal(halted.trippedClauses.length, 1);

  // `and` conjunction must NOT emit false warning when only the bar-count guard is near while Sharpe is healthy.
  const noFalseWarn = evaluateKillSwitch('live bars >= 60 and live rolling_sharpe < -0.5', {
    liveDrawdown: 0.02,
    backtestMaxDrawdown: 0.2,
    livePercentile: 0.7,
    liveRollingSharpe: 2.5,
    liveSlippageBps: 3,
    modeledSlippageBps: 5,
    liveBars: 55,
    liveReturn: 0.12,
  });
  assert.equal(noFalseWarn.status, 'healthy');

  // Position flips reset cost basis to the new fill price.
  const flipped = projectAccountState(
    [
      createConfirmFillEvent({ account: 'Main', ticker: 'SPY', side: 'short', quantity: 10, price: 100, t: Date.UTC(2026, 0, 1) }),
      createConfirmFillEvent({ account: 'Main', ticker: 'SPY', side: 'buy', quantity: 20, price: 90, t: Date.UTC(2026, 0, 2) }),
    ],
    'Main',
    { cash: 10_000 },
  );
  assert.equal(flipped.holdings[0].shares, 10);
  assert.equal(flipped.costBasis.get('SPY'), 90);
});

test('invalid invalidate-when rules fail visibly at parse time and in evaluateKillSwitch', () => {
  const typo = parseSpec('universe: SPY\nbuy when true\ninvalidate when live drawdon > 10%');
  assert.ok(typo.errors.length > 0, 'typo in invalidate when must produce a parse error');
  assert.equal(typo.errors[0].line, 3);

  const runtime = evaluateKillSwitch('live drawdon > 10%', {
    liveDrawdown: 0.05,
    backtestMaxDrawdown: 0.2,
    livePercentile: 0.5,
    liveRollingSharpe: 0.8,
    liveSlippageBps: 5,
    modeledSlippageBps: 5,
    liveBars: 30,
    liveReturn: 0.02,
  });
  assert.equal(runtime.status, 'warning');
  assert.ok(runtime.error && runtime.error.length > 0);
});
