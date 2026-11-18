import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, specSignals } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { simulate, type FillSeen } from '../src/engine.ts';
import { resultBytes } from '../src/limits.ts';
import type { Bars } from '../src/types.ts';
import { bars } from './helpers.ts';

/** A wavy series, so rules buy and sell, rebalances trim and top up, and stops are hit. */
function wave(n: number, phase: number, drift: number): number[] {
  return Array.from({ length: n }, (_, i) => 100 * (1 + 0.15 * Math.sin(i / 9 + phase) + 0.05 * Math.sin(i / 2.3 + phase * 2)) * (1 + drift) ** i);
}

const DATA = new Map<string, Bars>([
  ['A', bars(wave(400, 0, 0.0008))],
  ['B', bars(wave(400, 1.7, 0.0003))],
  ['C', bars(wave(400, 3.1, -0.0002))],
]);

const CASES = [
  'universe: A\nbuy when close > sma(10)\nsell when close < sma(20)',
  'universe: A, B\nstop loss: 3%\ntake profit: 6%\nbuy when close > sma(5)\nsell when bars held >= 20',
  'universe: A 40%, B 30%, C 30%\nrebalance: monthly\nbuy when true',
  'universe: A, B, C\nhold: top 2 by roc(10)\nbuy when true',
  'universe: A, B\nentries: 3\nbuy when close > sma(10)\nadd when bars held >= 3\nsell when close < sma(30)',
  'universe: A, B\nfill: close\nweighting: inverse volatility(20)\nrebalance: weekly\nbuy when close > sma(10)\nsell when close < sma(10)',
  'universe: A\ncommission: 0.005 per share, min 1\nslippage: 5 bps\ncosts: 10 bps\nbuy when rsi(5) < 40\nsell when rsi(5) > 70',
];

test("the run's fill log holds every fill the engine makes, in order, with the shares after it and the price before slippage", () => {
  const kinds = new Set<string>();
  for (const text of CASES) {
    const spec = parseSpec(text).spec!;
    const seen: FillSeen[] = [];
    const run = simulate({ ...spec, assets: spec.universe, onFill: (f) => void seen.push(f) }, DATA, specSignals(spec, DATA));
    assert.ok(seen.length > 0, text);
    assert.deepEqual(run.fills, {
      t: seen.map((f) => f.t),
      asset: seen.map((f) => f.asset),
      kind: seen.map((f) => f.kind),
      sharesAfter: seen.map((f) => f.shares),
      price: seen.map((f) => f.price),
    });
    for (const k of run.fills.kind) kinds.add(k);
    // The last fill of each asset leaves what the run ends holding.
    for (const st of run.states) {
      const last = run.fills.asset.lastIndexOf(st.name);
      assert.equal(last < 0 ? 0 : run.fills.sharesAfter[last], st.shares, `${st.name}: ${text}`);
    }
  }
  // Every kind of fill is in the cases above.
  assert.deepEqual([...kinds].sort(), ['add', 'entry', 'rebalance', 'sell', 'stop', 'trim']);
});

test("each trade's entry and exit are in the fill log at their times and prices", () => {
  const spec = parseSpec(CASES[1]).spec!;
  const bt = runBacktest(spec, DATA);
  const { fills } = bt.run;
  for (const tr of bt.run.trades) {
    const entry = fills.t.findIndex((t, i) => t === tr.entryT && fills.asset[i] === tr.asset && fills.kind[i] === 'entry');
    assert.ok(entry >= 0, `${tr.asset} entry at ${tr.entryT}`);
    if (tr.reason === 'open') continue;
    const exit = fills.t.findIndex((t, i) => t === tr.exitT && fills.asset[i] === tr.asset && (fills.kind[i] === 'sell' || fills.kind[i] === 'stop'));
    assert.ok(exit >= 0, `${tr.asset} exit at ${tr.exitT}`);
    assert.equal(fills.sharesAfter[exit], 0);
  }
});

test('the prices of a fill are before slippage: the same with and without it', () => {
  const plain = runBacktest(parseSpec(CASES[0]).spec!, DATA).run.fills;
  const slipped = runBacktest(parseSpec(`${CASES[0]}\nslippage: 50 bps`).spec!, DATA).run.fills;
  assert.deepEqual(slipped.price, plain.price);
  assert.deepEqual(slipped.t, plain.t);
});

test('a kept result weighs its fill log too', () => {
  const bt = runBacktest(parseSpec(CASES[2]).spec!, DATA);
  const n = bt.run.fills.t.length;
  assert.ok(n > 20);
  const without = { ...bt, run: { ...bt.run, fills: { t: [], asset: [], kind: [], sharesAfter: [], price: [] } } };
  assert.equal(resultBytes({ data: DATA, backtest: bt }) - resultBytes({ data: DATA, backtest: without }), 40 * n);
});
