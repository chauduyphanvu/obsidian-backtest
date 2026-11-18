// The trigger prices checked against the engine: for each price a report gives, the bar it assumes is added to the prices
// just inside and just outside it, the strategy is run again, and the ticker's order at the end must be there inside and
// gone outside.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec, type Spec } from '../src/dsl.ts';
import type { AssetState } from '../src/engine.ts';
import { STARTERS } from '../src/gallery.ts';
import { makeRng } from '../src/rng.ts';
import { computeTriggers, nextBarData, PRECISION, triggerRun, type TriggerReport, type TriggerSide } from '../src/trigger.ts';
import type { Bars } from '../src/types.ts';
import { DAY } from './helpers.ts';

/** Daily bars of a random walk ending on `end`, on weekdays only unless `weekends`. */
export function walkBars(n: number, seed: number, o: { weekends?: boolean; end?: number; vol?: number } = {}): Bars {
  const rng = makeRng(seed);
  const t: number[] = [];
  for (let d = o.end ?? Date.UTC(2026, 10, 13); t.length < n; d -= DAY) {
    const wd = new Date(d).getUTCDay();
    if (o.weekends || (wd !== 0 && wd !== 6)) t.unshift(d);
  }
  const b: Bars = { t, o: [], h: [], l: [], c: [], v: [] };
  let c = 100;
  for (let i = 0; i < n; i++) {
    const open = c;
    c *= Math.exp((rng.next() - 0.495) * 2 * (o.vol ?? 0.02));
    b.o.push(open);
    b.h.push(Math.max(open, c) * (1 + rng.next() * 0.01));
    b.l.push(Math.min(open, c) * (1 - rng.next() * 0.01));
    b.c.push(c);
    b.v.push(1000 + Math.floor(rng.next() * 500));
  }
  return b;
}

/** The first `n` bars. */
const head = (b: Bars, n: number): Bars => ({ t: b.t.slice(0, n), o: b.o.slice(0, n), h: b.h.slice(0, n), l: b.l.slice(0, n), c: b.c.slice(0, n), v: b.v.slice(0, n) });

/** Whether the ticker's state at the end shows the order a trigger of `side` gives. */
function fired(st: AssetState, side: TriggerSide, closeFill: boolean): boolean {
  if (side === 'rearm') return st.rearming !== true;
  return closeFill ? st.filled?.side === side : st.pending === side;
}

export type Tally = Record<TriggerSide, number>;
export const tally = (): Tally => ({ buy: 0, sell: 0, add: 0, rearm: 0 });

/** Checks every price of the report on `data` against the engine; counts the prices checked by side into `seen`. */
export function verify(spec: Spec, data: Map<string, Bars>, label: string, seen: Tally): TriggerReport {
  const bt = runBacktest(spec, data);
  const report = computeTriggers(spec, data, triggerRun(bt.run));
  // A ranking that decides at the next close may sell a held ticker whatever its sell rule says.
  if (spec.rank && report.decision === report.next) return report;
  for (const t of report.triggers) {
    if (t.blocked) continue;
    const st = bt.run.states.find((s) => s.name === t.ticker)!;
    for (const band of t.fires) {
      for (const [edge, out] of [[band.lo, -1], [band.hi, 1]] as const) {
        if (edge === null) continue;
        for (const [x, expected] of [[edge, true], [edge * (1 + out * 1.5 * PRECISION), false]] as const) {
          const after = runBacktest(spec, nextBarData(spec, data, st, x)).run.states.find((s) => s.name === t.ticker)!;
          assert.equal(fired(after, t.side, spec.fill === 'close'), expected, `${label}: ${t.ticker} ${t.side} with ${t.driver} closing at ${x} (edge ${edge}, ${expected ? 'inside' : 'outside'})`);
        }
        seen[t.side]++;
      }
    }
  }
  return report;
}

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
