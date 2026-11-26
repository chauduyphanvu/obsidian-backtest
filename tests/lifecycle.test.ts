import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { createConfirmFillEvent, ingestBrokerCsv, parseLedgerJsonl, projectAccountState, serializeLedgerEvent } from '../src/fill-ledger.ts';
import { evaluateKillSwitch, killSwitchContext } from '../src/killswitch.ts';
import { buildDeploymentCommit, computeRealityTape, liveSinceLine } from '../src/lifecycle.ts';
import { DEFAULT_SETTINGS, defaultsFrom } from '../src/settings-core.ts';
import { bars } from './helpers.ts';

test('fill-ledger projects holdings/cash deterministically and deduplicates repeated broker CSV imports', () => {
  const schwabCsv = [
    'Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount',
    '01/10/2026,Buy,SPY,SPDR S&P 500,10,$500.00,$1.00,-$5001.00',
    '01/20/2026,Sell,SPY,SPDR S&P 500,4,$520.00,$1.00,$2079.00',
  ].join('\n');
  const first = ingestBrokerCsv(schwabCsv, 'Main', new Set());
  assert.equal(first.added.length, 2);
  assert.equal(first.skippedDuplicates, 0);

  const jsonl = first.added.map(serializeLedgerEvent).join('\n');
  const parsed = parseLedgerJsonl(jsonl);
  assert.equal(parsed.length, 2);

  // Re-ingesting the same CSV yields 0 new events.
  const second = ingestBrokerCsv(schwabCsv, 'Main', new Set(parsed.map((e) => e.id)));
  assert.equal(second.added.length, 0);
  assert.equal(second.skippedDuplicates, 2);

  // Confirm an additional fill via 1-click UI.
  const confirm = createConfirmFillEvent({ account: 'Main', ticker: 'TLT', side: 'buy', quantity: 20, price: 90, fees: 0, t: Date.UTC(2026, 0, 25) });
  const projected = projectAccountState([...parsed, confirm], 'Main', { cash: 10_000 });
  assert.deepEqual(projected.holdings, [
    { ticker: 'SPY', shares: 6 },
    { ticker: 'TLT', shares: 20 },
  ]);
  // 10000 - 5001 + 2079 - 1800 = 5278
  assert.equal(projected.cash, 5278);
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
  assert.equal(tape.realized?.length, tape.t.length);
  assert.ok(tape.shortfall.liveDrawdown > 0.15);
  assert.ok(tape.shortfall.slippageDriftBps > 15);
  assert.ok(tape.shortfall.livePercentile < 15);

  const report = evaluateKillSwitch(spec.invalidate, killSwitchContext(commit, tape.shortfall));
  assert.equal(report.status, 'halted');
  assert.ok(report.trippedClauses.length >= 1);
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

  // Position flips reset cost basis to the new fill price, and identical same-day CSV fills are preserved cleanly.
  const dupCsv = [
    'Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount',
    '01/10/2026,Buy,SPY,SPDR,10,$500.00,$0.00,-$5000.00',
    '01/10/2026,Buy,SPY,SPDR,10,$500.00,$0.00,-$5000.00',
  ].join('\n');
  const firstDup = ingestBrokerCsv(dupCsv, 'Main', new Set());
  assert.equal(firstDup.added.length, 2);
  const reimportDup = ingestBrokerCsv(dupCsv, 'Main', new Set(firstDup.added.map((e) => e.id)));
  assert.equal(reimportDup.added.length, 0);
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
