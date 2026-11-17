import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { bootstrap } from '../src/luck.ts';
import { makeRng } from '../src/rng.ts';
import { calmar, deepStats } from '../src/stats.ts';
import type { Bars } from '../src/types.ts';

/** `n` five-minute bars of a seeded random walk. */
function walk(n: number): Bars {
  const rng = makeRng(3);
  const b: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let p = 100;
  for (let i = 0; i < n; i++) {
    const c = p * (1 + (rng.next() - 0.5) * 0.004);
    b.t.push(Date.UTC(2021, 0, 1) + i * 300_000);
    b.o.push(p);
    b.h.push(Math.max(p, c) * 1.0005);
    b.l.push(Math.min(p, c) * 0.9995);
    b.c.push(c);
    b.v.push(1);
    p = c;
  }
  return b;
}

test('a run of 300,000 bars completes, and so do the statistics drawn from it', () => {
  const { spec, errors } = parseSpec('universe: BTCUSDT\ndata: binance\ninterval: 5m\nbuy when close > sma(50)\nsell when close < sma(50)');
  assert.deepEqual(errors, []);
  const started = performance.now();
  const bt = runBacktest(spec!, new Map([['BTCUSDT', walk(300_000)]]));
  assert.equal(bt.run.t.length, 300_000);
  assert.ok(bt.stats.maxDrawdown < 0 && bt.benchmark.stats.maxDrawdown < 0);
  const { t, equity } = bt.run;
  assert.ok(Number.isFinite(calmar(t, equity)));
  assert.ok(Number.isFinite(deepStats(t, equity).underwater.longestDays));
  assert.ok(bootstrap(t, equity, { runs: 2, seed: 1 }).actual.maxDrawdown < 0);
  assert.ok(performance.now() - started < 20_000);
});
