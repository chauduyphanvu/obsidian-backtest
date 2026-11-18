// Helpers for checking trigger prices against the engine (trigger-engine.test.ts, trigger.test.ts).

import assert from 'node:assert/strict';
import { runBacktest } from '../src/backtest.ts';
import type { Spec } from '../src/dsl.ts';
import type { AssetState } from '../src/engine.ts';
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
export const head = (b: Bars, n: number): Bars => ({ t: b.t.slice(0, n), o: b.o.slice(0, n), h: b.h.slice(0, n), l: b.l.slice(0, n), c: b.c.slice(0, n), v: b.v.slice(0, n) });

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

