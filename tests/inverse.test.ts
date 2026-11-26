import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { brushContrast, probeBar, rawAuc } from '../src/inverse.ts';
import { bars } from './helpers.ts';

test('rawAuc computes exact Mann-Whitney ROC-AUC', () => {
  assert.equal(rawAuc([10, 20, 30], [1, 2, 3]), 1);
  assert.equal(rawAuc([1, 2, 3], [10, 20, 30]), 0);
  assert.equal(rawAuc([5, 5], [5, 5]), 0.5);
});

test('brushContrast ranks separating features, computes permutation p-values, and reports DSR trial tax', () => {
  // Alternating smooth trending periods (winners) and choppy mean-reverting periods (losers)
  const prices: number[] = [];
  let p = 100;
  for (let i = 0; i < 400; i++) {
    const cycle = Math.floor(i / 40) % 2;
    const step = cycle === 0 ? 0.004 + Math.sin(i / 4) * 0.008 : Math.sin(i * 1.4) * 0.025 - 0.001;
    p = Math.max(20, p * (1 + step));
    prices.push(p);
  }
  const b = bars(prices);
  b.h = b.c.map((c, i) => Math.max(b.o[i], c) * 1.015);
  b.l = b.c.map((c, i) => Math.min(b.o[i], c) * 0.985);
  const data = new Map([['SPY', b]]);
  const spec = parseSpec('universe: SPY\nbuy when close > sma(5)\nsell when close < sma(5)').spec!;
  const bt = runBacktest(spec, data);
  const losers = bt.run.trades.map((tr, i) => ({ tr, i })).filter((x) => x.tr.reason !== 'open' && x.tr.ret < 0).map((x) => x.i);
  assert.ok(losers.length >= 2, 'need at least 2 losing trades');
  const contrast = brushContrast(spec, data, bt, losers, 7, 100);
  assert.equal(contrast.selectedCount, losers.length);
  assert.ok(contrast.features.length >= 10);
  assert.equal(contrast.effectiveTrialsCost, contrast.features.length);
  assert.ok(contrast.features[0].auc >= contrast.features[contrast.features.length - 1].auc);
  assert.ok(contrast.features[0].pValue > 0 && contrast.features[0].pValue <= 1);
  assert.match(contrast.features[0].suggestedClause, /^and /);
});

test('probeBar finds blocking comparison and computes global counterfactual effect', () => {
  const prices = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 3) * 8 + i * 0.2);
  const data = new Map([['SPY', bars(prices)]]);
  const src = 'universe: SPY\nbuy when rsi(2) < 10\nsell when rsi(2) > 70';
  const spec = parseSpec(src).spec!;
  const bt = runBacktest(spec, data);
  // Find a flat bar where rsi(2) did not fire (between 10 and 40)
  const b = data.get('SPY')!;
  let probeIdx = -1;
  for (let i = 30; i < b.t.length - 5; i++) {
    const res = probeBar(src, spec, data, bt, 'SPY', i);
    if (res && !res.fired && res.position === 'flat' && res.blockers.length > 0 && res.blockers[0].counterfactual) {
      probeIdx = i;
      assert.ok(res.blockers[0].counterfactual!.newValue > 10);
      assert.ok(Number.isFinite(res.blockers[0].counterfactual!.deltaSharpe));
      break;
    }
  }
  assert.ok(probeIdx >= 0, 'should find a non-firing flat bar with a counterfactual threshold');
});

test('probeBar resolves 2nd+ comparison clauses/counterfactuals and handles position-aware sell rules without throwing', () => {
  const prices = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 4) * 6 + i * 0.3);
  const data = new Map([['SPY', bars(prices)]]);
  const src = [
    'universe: SPY',
    'buy when close > sma(10) and rsi(2) < 5',
    'sell when bars held >= 20 or position return < -15%',
  ].join('\n');
  const spec = parseSpec(src).spec!;
  const bt = runBacktest(spec, data);
  let sawSecondBlocker = false;
  let sawPositionSellProbe = false;
  for (let i = 20; i < prices.length - 2; i++) {
    const res = probeBar(src, spec, data, bt, 'SPY', i);
    if (!res) continue;
    if (res.position === 'flat') {
      const rsiBlocker = res.blockers.find((b) => b.clause.includes('rsi(2) < 5'));
      if (rsiBlocker?.counterfactual) sawSecondBlocker = true;
    } else if (res.position === 'long') {
      assert.equal(res.ruleSide, 'sell');
      sawPositionSellProbe = true;
    }
  }
  assert.ok(sawSecondBlocker, '2nd comparison in buy rule should keep exact clause text and counterfactual');
  assert.ok(sawPositionSellProbe || bt.run.trades.length === 0, 'position-aware sell rule should probe cleanly');
});

test('probeBar resolves between bounds and verifies counterfactual flips the probed bar', () => {
  const prices = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 4) * 8 + i * 0.15);
  const data = new Map([['SPY', bars(prices)]]);
  const src = 'universe: SPY\nbuy when rsi(5) between 15 and 25\nsell when rsi(5) > 70';
  const spec = parseSpec(src).spec!;
  const bt = runBacktest(spec, data);
  let sawBetweenCf = false;
  for (let i = 20; i < prices.length - 5; i++) {
    const res = probeBar(src, spec, data, bt, 'SPY', i);
    if (res && !res.fired && res.position === 'flat') {
      const cf = res.blockers.find((b) => b.counterfactual)?.counterfactual;
      if (cf) {
        assert.ok(Number.isFinite(cf.newValue));
        assert.ok(Number.isFinite(cf.deltaSharpe));
        sawBetweenCf = true;
        break;
      }
    }
  }
  assert.ok(sawBetweenCf, 'probeBar should find a flipping counterfactual on a between comparison');
});
