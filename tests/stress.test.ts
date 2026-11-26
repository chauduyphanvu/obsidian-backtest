import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { runStress } from '../src/stress.ts';
import { bars } from './helpers.ts';

test('runStress generates all 4 perturbation axes, valid p10<=p50<=p90 envelopes, and breaking points', () => {
  // 2.5 years of synthetic trending + mean-reverting daily prices
  const prices: number[] = [];
  let p = 100;
  for (let i = 0; i < 650; i++) {
    const trend = i < 250 ? 0.0012 : i < 380 ? -0.0015 : 0.0014;
    const wave = Math.sin(i / 7) * 0.008;
    p = Math.max(10, p * (1 + trend + wave));
    prices.push(p);
  }
  const b = bars(prices);
  b.h = b.c.map((c, i) => Math.max(b.o[i], c) * 1.01);
  b.l = b.c.map((c, i) => Math.min(b.o[i], c) * 0.99);
  const data = new Map([['SPY', b]]);
  const src = 'universe: SPY\ncosts: 5 bps\nstop loss: 8%\nbuy when close > sma(20)\nsell when close < sma(20)';
  const spec = parseSpec(src).spec!;
  const base = runBacktest(spec, data);
  const report = runStress(src, spec, data, base);

  assert.ok(report.paths.length >= 20, `expected >= 20 stress paths, got ${report.paths.length}`);
  assert.ok(report.paths.some((x) => x.axis === 'params'));
  assert.ok(report.paths.some((x) => x.axis === 'friction'));
  assert.ok(report.paths.some((x) => x.axis === 'timing'));
  assert.ok(report.paths.some((x) => x.axis === 'outliers'));

  for (let i = 0; i < report.t.length; i++) {
    assert.ok(report.envelopes.all.p10[i] <= report.envelopes.all.p50[i] + 1e-9);
    assert.ok(report.envelopes.all.p50[i] <= report.envelopes.all.p90[i] + 1e-9);
  }
  assert.ok(report.breakingPoints.neighborSurvivalRate >= 0 && report.breakingPoints.neighborSurvivalRate <= 1);
  assert.ok(['robust', 'sensitive', 'fragile'].includes(report.breakingPoints.grade));
});

test('runStress is deterministic for the same seed', () => {
  const prices = Array.from({ length: 180 }, (_, i) => 100 + Math.sin(i / 5) * 6 + i * 0.25);
  const data = new Map([['SPY', bars(prices)]]);
  const src = 'universe: SPY\nbuy when close > sma(10)\nsell when close < sma(10)';
  const spec = parseSpec(src).spec!;
  const base = runBacktest(spec, data);
  const a = runStress(src, spec, data, base, {}, 123);
  const b = runStress(src, spec, data, base, {}, 123);
  assert.deepEqual(a.breakingPoints, b.breakingPoints);
  assert.deepEqual(a.envelopes.all, b.envelopes.all);
});
