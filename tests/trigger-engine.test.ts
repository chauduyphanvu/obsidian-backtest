// The trigger prices checked against the engine: for each price a report gives, the bar it assumes is added to the prices
// just inside and just outside it, the strategy is run again, and the ticker's order at the end must be there inside and
// gone outside.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec, type Spec } from '../src/dsl.ts';
import { STARTERS } from '../src/gallery.ts';
import { makeRng } from '../src/rng.ts';
import { head, tally, verify, walkBars } from './trigger-helpers.ts';

const parsed = (src: string): Spec => {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, [], src);
  return spec!;
};

test('the starters: each price a report gives makes the order inside it and not outside, at many points of their history', () => {
  const seen = tally();
  STARTERS.forEach((s, k) => {
    const spec = parsed(s.text);
    const names = [...new Set([...spec.universe, ...spec.extras, ...(spec.benchmark ? [spec.benchmark] : [])].map((a) => a.name))];
    const full = new Map(names.map((name, j) => [name, walkBars(900, 100 * k + j, { weekends: spec.universe.some((a) => a.source === 'binance') })]));
    for (let cut = 620; cut <= 900; cut += 7) {
      const data = new Map([...full].map(([name, b]) => [name, head(b, cut)]));
      verify(spec, data, `${s.title}, ${cut} bars`, seen);
    }
  });
  assert.ok(seen.buy >= 40 && seen.sell >= 40 && seen.add >= 4, JSON.stringify(seen));
});

/** A random strategy from parts of rules, settings and stops that the trigger prices treat differently. */
function randomStrategy(seed: number): string {
  const rng = makeRng(seed);
  const pick = <T,>(xs: T[]): T => xs[rng.int(xs.length)];
  const n = () => 5 + rng.int(30);
  const buys = [
    () => `close > sma(${n()})`,
    () => `close > ema(${n()})`,
    () => `rsi(${2 + rng.int(12)}) < ${20 + rng.int(40)}`,
    () => `close > highest(${n()})[1]`,
    () => `close crosses above sma(${n()})`,
    () => `zscore(${n()}) < -0.5`,
    () => `close > bb_upper(${n()}, 1)`,
    () => `close of B > sma(${n()}) of B`,
    () => `close > open`,
    () => `high > highest(${n()})[1]`,
    () => `close > sma(${n()}) and rsi(${2 + rng.int(12)}) < 70`,
    () => `close > vwap(${n()})`,
    () => `stoch_k(14, 3) < 40`,
    () => `close / close[5] > 1.01`,
    () => `bars_since(close < sma(${n()})) > 2`,
    () => `roc(${n()}) > 0 and close of B > close[1] of B`,
  ];
  const sells = [
    () => `close < sma(${n()})`,
    () => `rsi(${2 + rng.int(12)}) > ${50 + rng.int(40)}`,
    () => `close < entry price * 0.97 or bars held >= ${3 + rng.int(20)}`,
    () => `close crosses below ema(${n()})`,
    () => `close < lowest(${n()})[1]`,
    () => `close of B < sma(${n()}) of B`,
    () => `close < open`,
  ];
  const lines = ['universe: A', 'capital: 10000'];
  if (rng.next() < 0.5) lines.push('fill: close');
  if (rng.next() < 0.3) lines.push(`stop loss: ${3 + rng.int(6)}%`);
  if (rng.next() < 0.25) lines.push(`trailing stop: ${3 + rng.int(6)}%`);
  if (rng.next() < 0.25) lines.push(`take profit: ${4 + rng.int(8)}%`);
  const entries = rng.next() < 0.25;
  if (entries) lines.push('entries: 3');
  lines.push(`buy when ${pick(buys)()}`);
  if (rng.next() < 0.85) lines.push(`sell when ${pick(sells)()}`);
  if (entries) lines.push(`add when close > last entry price * ${(1 + rng.int(4) / 100).toFixed(2)}`);
  return lines.join('\n');
}

test('random strategies: each price a report gives makes the order inside it and not outside', () => {
  const seen = tally();
  const A = walkBars(700, 1);
  const B = walkBars(700, 2);
  for (let seed = 1; seed <= 160; seed++) {
    const src = randomStrategy(seed);
    const spec = parsed(src);
    const rng = makeRng(seed * 31);
    for (let k = 0; k < 6; k++) {
      const cut = 420 + rng.int(280);
      verify(spec, new Map([['A', head(A, cut)], ['B', head(B, cut)]]), `seed ${seed}, ${cut} bars:\n${src}\n`, seen);
    }
  }
  assert.ok(seen.buy >= 150 && seen.sell >= 120 && seen.add >= 25 && seen.rearm >= 8, JSON.stringify(seen));
});
