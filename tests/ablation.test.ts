import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyClauseMutes, extractClauses, runAblation } from '../src/ablation.ts';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { bars } from './helpers.ts';

test('extractClauses decomposes multi-clause rules, stops, and rebalance with source spans', () => {
  const src = [
    'universe: SPY',
    'rebalance: monthly',
    'stop loss: 8%',
    'buy when close > sma(20)',
    '  and rsi(14) < 75',
    'sell when close < sma(20)',
    '  or rsi(14) > 85',
  ].join('\n');
  const spec = parseSpec(src).spec!;
  const clauses = extractClauses(spec, src);
  assert.deepEqual(
    clauses.map((c) => c.id),
    ['buy:0', 'buy:1', 'sell:0', 'sell:1', 'stop:stopLoss', 'rebalance'],
  );
  assert.equal(clauses[4].span?.line, 3);
  assert.equal(clauses[5].span?.line, 2);
});

test('runAblation identifies a dead-weight clause as neutral and a core trend filter as load-bearing', () => {
  // Oscillating uptrend (RSI ~65) followed by a sharp downtrend, then oscillating recovery.
  const prices = [
    ...Array.from({ length: 60 }, (_, i) => 100 + i * 0.8 + (i % 2 === 0 ? 1.5 : -1.5)),
    ...Array.from({ length: 40 }, (_, i) => 148 - i * 1.5 + (i % 2 === 0 ? 1 : -1)),
    ...Array.from({ length: 60 }, (_, i) => 88 + i * 1.1 + (i % 2 === 0 ? 1.5 : -1.5)),
  ];
  const data = new Map([['SPY', bars(prices)]]);
  const src = [
    'universe: SPY',
    'buy when close > sma(10)',
    '  and rsi(5) <= 100',
    'sell when close < sma(10)',
  ].join('\n');
  const spec = parseSpec(src).spec!;
  const base = runBacktest(spec, data);
  const report = runAblation(spec, data, base, src);
  const rsiClause = report.clauses.find((c) => c.id === 'buy:1')!;
  const sellTrend = report.clauses.find((c) => c.id === 'sell:0')!;
  assert.equal(rsiClause.verdict, 'neutral');
  assert.equal(rsiClause.tradesAdded + rsiClause.tradesBlocked, 0);
  assert.equal(sellTrend.verdict, 'load-bearing');
  assert.ok(sellTrend.deltaMaxDD > 0.05 && sellTrend.deltaSharpe > 0.5, 'trend exit filter should materially help');
});

test('applyClauseMutes neutralizes selected clauses cleanly', () => {
  const src = 'universe: SPY\nstop loss: 5%\nbuy when close > sma(10) and rsi(14) < 70\nsell when close < sma(10)';
  const spec = parseSpec(src).spec!;
  const muted = applyClauseMutes(spec, src, new Set(['stop:stopLoss', 'buy:1']));
  assert.equal(muted.stops.SPY.stopLoss, null);
  assert.equal(muted.rules.SPY.buy.k, 'logic');
});
