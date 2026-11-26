import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyLiteralOverrides, extractLiteralSites, parseSpec } from '../src/dsl.ts';
import { simulate } from '../src/engine.ts';
import { runBacktest, specSignals } from '../src/backtest.ts';
import { removeMutedLines, setLiteralValues, toggleMuteLine } from '../src/rewrite.ts';
import { bars } from './helpers.ts';

test('extractLiteralSites finds rule periods, thresholds, stops, and params with valid domains', () => {
  const src = [
    'name: Demo',
    'universe: SPY',
    'stop loss: 8%',
    'fast = 50 in 20..100 step 10',
    'buy when close > sma(200) and rsi(14) < 30',
    'sell when close < sma(fast)',
  ].join('\n');
  const sites = extractLiteralSites(src);
  assert.equal(sites.length, 5);
  assert.equal(sites[0].value, 0.08);
  assert.equal(sites[0].percent, true);
  assert.equal(sites[1].param, 'fast');
  assert.equal(sites[1].value, 50);
  assert.equal(sites[2].value, 200);
  assert.equal(sites[2].domain.integer, true);
  assert.equal(sites[3].value, 14);
  assert.equal(sites[4].value, 30);
});

test('literalOverrides and setLiteralValues produce identical specs and preserve formatting', () => {
  const src = 'universe: SPY\nstop loss: 8%\nbuy when close > sma(200) and rsi(14) < 30\nsell when close < sma(200)';
  const sites = extractLiteralSites(src);
  const overrides = { [sites[0].id]: 0.12, [sites[1].id]: 150, [sites[3].id]: 35 };
  const viaParse = parseSpec(src, { literalOverrides: overrides });
  const rewritten = setLiteralValues(src, sites, overrides);
  const viaText = parseSpec(rewritten);
  assert.deepEqual(viaParse.errors, []);
  assert.deepEqual(viaText.errors, []);
  assert.equal(viaParse.spec!.stops.SPY.stopLoss?.k, 'pct');
  assert.equal((viaParse.spec!.stops.SPY.stopLoss as { k: 'pct'; v: number }).v, 0.12);
  assert.equal(rewritten, 'universe: SPY\nstop loss: 12%\nbuy when close > sma(150) and rsi(14) < 35\nsell when close < sma(200)');
});

test('muted lines with ~ are skipped cleanly without breaking rule continuations', () => {
  const src = [
    'universe: SPY',
    '~stop loss: 8%',
    'buy when close > sma(5)',
    '  ~and rsi(2) < 10',
    '  and close > open',
    'sell when close < sma(5)',
  ].join('\n');
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  assert.deepEqual(spec!.mutedLines, [2, 4]);
  assert.equal(spec!.stops.SPY.stopLoss, null);
  assert.equal(toggleMuteLine(src, 2).split('\n')[1], 'stop loss: 8%');
  assert.equal(removeMutedLines(src).split('\n').length, 4);
});

test('written.spans populates exact source spans for rule AST nodes', () => {
  const src = 'universe: SPY\nbuy when close > sma(50)\nsell when close < sma(50)';
  const { spec } = parseSpec(src);
  const buy = spec!.written!.rules.SPY.buy!;
  assert.ok(buy.spans && buy.spans.length === buy.parts.length);
  assert.deepEqual(buy.spans![0], { line: 2, from: 9, to: 24 });
});

test('live since and invalidate when parse cleanly onto Spec', () => {
  const src = [
    'universe: SPY',
    'live since: 2026-04-01 @a9f3c',
    'buy when close > sma(20)',
    'sell when close < sma(20)',
    'invalidate when live drawdown > 1.25 * backtest max drawdown',
    '  or live percentile < 5%',
  ].join('\n');
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  assert.equal(spec!.liveSince?.commit, 'a9f3c');
  assert.equal(spec!.liveSince?.date, Date.UTC(2026, 3, 1));
  assert.equal(spec!.invalidate, 'live drawdown > 1.25 * backtest max drawdown or live percentile < 5%');
});

test('SimStressHooks delay signals and apply adverse fills without affecting normal runs', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 4) * 10 + i * 0.5);
  const b = bars(closes);
  // Make bar ranges wider so adverseFillFraction visibly worsens fills.
  b.h = b.c.map((c, i) => Math.max(b.o[i], c) + 2);
  b.l = b.c.map((c, i) => Math.min(b.o[i], c) - 2);
  const data = new Map([['SPY', b]]);
  const spec = parseSpec('universe: SPY\nbuy when close > sma(5)\nsell when close < sma(5)').spec!;
  const sigs = specSignals(spec, data);
  const base = runBacktest(spec, data);
  const delayed = simulate({ ...spec, assets: spec.universe, stress: { signalDelayBars: 1 } }, data, sigs);
  const adverse = simulate({ ...spec, assets: spec.universe, stress: { adverseFillFraction: 0.5 } }, data, sigs);
  assert.notEqual(delayed.equity[delayed.equity.length - 1], base.run.equity[base.run.equity.length - 1]);
  assert.ok(adverse.equity[adverse.equity.length - 1] < base.run.equity[base.run.equity.length - 1]);
  // applyLiteralOverrides routes parameter literals via paramOverrides
  const pSrc = 'universe: SPY\nn = 10 in 5..20\nbuy when close > sma(n)';
  const pSites = extractLiteralSites(pSrc);
  const applied = applyLiteralOverrides(pSrc, pSites, { [pSites[0].id]: 15 });
  assert.equal(applied.paramOverrides.n, 15);
});

test('extractLiteralSites infers integer domains for nested indicator calls, hold settings, and negative percent params', () => {
  const src = [
    'universe: SPY, QQQ, TLT',
    'hold: top 2 by roc(126)',
    'dip = -5% in -20%..-1%',
    'buy when sma(rsi(14), 5) > 50 and count(close > sma(20), 10) >= 6',
  ].join('\n');
  const sites = extractLiteralSites(src);
  const byVal = (v: number) => sites.find((s) => Math.abs(s.value - v) < 1e-9);
  assert.equal(byVal(2)?.domain.integer, true, 'hold top N should be integer');
  assert.equal(byVal(126)?.domain.integer, true, 'hold roc(126) should be integer');
  assert.equal(byVal(-0.05)?.domain.min, -0.2, 'negative percent param should preserve negative min');
  assert.equal(byVal(5)?.domain.integer, true, 'outer period of nested sma(rsi(14), 5) should be integer');
  assert.equal(byVal(10)?.domain.integer, true, 'outer period of count(close > sma(20), 10) should be integer');
});
