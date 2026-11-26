import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { analyzeBookImpact, buildBookSnapshot } from '../src/book.ts';
import { parseSpec } from '../src/dsl.ts';
import { bars } from './helpers.ts';

test('analyzeBookImpact measures tail-drawdown correlation, sleeve redundancy, and marginal Sharpe improvement', () => {
  // Equity trend asset that crashes in middle; crisis hedge that rallies during that exact crash!
  const n = 220;
  const spyPrices: number[] = [];
  const hedgePrices: number[] = [];
  let s = 100;
  let h = 100;
  for (let i = 0; i < n; i++) {
    const crash = i >= 80 && i < 120;
    s *= 1 + (crash ? -0.008 : 0.0025) + Math.sin(i / 5) * 0.003;
    h *= 1 + (crash ? 0.012 : -0.0005) - Math.sin(i / 5) * 0.002;
    spyPrices.push(s);
    hedgePrices.push(h);
  }
  const spyData = new Map([['SPY', bars(spyPrices)]]);
  const hedgeData = new Map([['HDG', bars(hedgePrices)]]);
  const baseBt = runBacktest(parseSpec('name: Core\nuniverse: SPY\nbuy when true').spec!, spyData);
  const hedgeBt = runBacktest(parseSpec('name: Crisis Hedge\nuniverse: HDG\nbuy when true').spec!, hedgeData);

  const book = buildBookSnapshot(
    'Main Book',
    'Accounts/Main.md',
    [{ label: 'Core', out: { spec: baseBt.spec, backtest: baseBt, data: spyData, warnings: [], prices: [] } }],
    [1],
    [{ ticker: 'SPY', shares: 100 }],
    5_000,
    20_000,
  );
  assert.ok(book !== null);
  const impact = analyzeBookImpact(book, hedgeBt, 0.2);
  assert.ok(impact !== null);
  assert.ok(impact.deltaMaxDD > 0.02, `expected crisis hedge to shrink book max drawdown, got ${impact.deltaMaxDD}`);
  assert.ok(impact.deltaSharpe > 0, `expected crisis hedge to improve book Sharpe, got ${impact.deltaSharpe}`);
  assert.ok(impact.tailDrawdownCorrelation < 0, `expected negative tail drawdown correlation, got ${impact.tailDrawdownCorrelation}`);
  assert.equal(impact.redundancy.length, 1);
  assert.ok(impact.transitionOrders.length === 2, 'transition should trim SPY to fund HDG and buy HDG');
  assert.equal(impact.transitionOrders[0].ticker, 'SPY');
  assert.equal(impact.transitionOrders[0].action, 'sell');
  assert.equal(impact.transitionOrders[1].ticker, 'HDG');
  assert.equal(impact.transitionOrders[1].action, 'buy');
});

test('analyzeBookImpact keeps bookBefore Sharpe invariant to candidate cash rate and nets overlapping holdings', () => {
  const n = 200;
  const spyPrices: number[] = [];
  let s = 100;
  for (let i = 0; i < n; i++) {
    s *= 1 + 0.001 + Math.sin(i / 6) * 0.006;
    spyPrices.push(s);
  }
  const spyData = new Map([['SPY', bars(spyPrices)]]);
  const baseBt = runBacktest(parseSpec('name: Core\nuniverse: SPY\nbuy when true').spec!, spyData);
  const cand0 = runBacktest(parseSpec('name: Cand0\nuniverse: SPY\ncash rate: 0%\nbuy when true').spec!, spyData);
  const cand5 = runBacktest(parseSpec('name: Cand5\nuniverse: SPY\ncash rate: 5%\nbuy when true').spec!, spyData);

  const book = buildBookSnapshot(
    'Main Book',
    'Accounts/Main.md',
    [{ label: 'Core', out: { spec: baseBt.spec, backtest: baseBt, data: spyData, warnings: [], prices: [] } }],
    [1],
    [{ ticker: 'SPY', shares: 100 }],
    0,
    10_000,
  );
  assert.ok(book !== null);
  const imp0 = analyzeBookImpact(book, cand0, 0.2)!;
  const imp5 = analyzeBookImpact(book, cand5, 0.2)!;
  assert.ok(Math.abs(imp0.bookBefore.sharpe - imp5.bookBefore.sharpe) < 1e-12, 'bookBefore.sharpe must not depend on candidate cash rate');
});
