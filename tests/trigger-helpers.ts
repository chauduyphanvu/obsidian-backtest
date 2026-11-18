// Helpers for checking trigger prices against the engine (trigger-engine.test.ts, trigger.test.ts).

import assert from 'node:assert/strict';
import { runBacktest } from '../src/backtest.ts';
import type { Spec } from '../src/dsl.ts';
import type { AssetState } from '../src/engine.ts';
import { makeRng } from '../src/rng.ts';
import { computeTriggers, nextBarData, PRECISION, triggerRun, type Trigger, type TriggerReport, type TriggerSide } from '../src/trigger.ts';
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

/** A close one and a half times the search's precision beyond `edge`, below it for `out` −1 and above it for 1. */
const beyond = (t: Trigger, edge: number, out: -1 | 1): number => edge + out * 1.5 * (t.values ? PRECISION * (t.range.hi - t.range.lo) : edge * PRECISION);

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
        for (const [x, expected] of [[edge, true], [beyond(t, edge, out), false]] as const) {
          const after = runBacktest(spec, nextBarData(spec, data, st, x)).run.states.find((s) => s.name === t.ticker)!;
          assert.equal(fired(after, t.side, spec.fill === 'close'), expected, `${label}: ${t.ticker} ${t.side} with ${t.driver} closing at ${x} (edge ${edge}, ${expected ? 'inside' : 'outside'})`);
        }
        seen[t.side]++;
      }
    }
  }
  return report;
}

/** A series of values as FRED gives it (fred.ts): one row each time a value is published, its open, high, low and close the value. */
export const valueSeries = (t: number[], vs: number[]): Bars => ({ t, o: [...vs], h: [...vs], l: [...vs], c: [...vs], v: vs.map(() => 0), values: true });

/** A CSV file of dated values with no prices (data.ts), its one column named `score`. */
export const signalFile = (t: number[], vs: number[]): Bars => ({
  t,
  o: vs.map(() => NaN),
  h: vs.map(() => NaN),
  l: vs.map(() => NaN),
  c: vs.map(() => NaN),
  v: vs.map(() => 0),
  unpriced: true,
  columns: [{ name: 'score', header: 'score', v: [...vs] }],
});

/**
 * Checks every trigger of the report against the engine on prices made here, not by trigger.ts: the ticker gets its next
 * daily bar, closing at the close tried or, when the rules are solved for a series of values, at its last close while
 * that series gets the value tried, published on the last day the bar can read it. Every other series is left as it is,
 * since a series of values (a FRED series, a file of columns) has no new row until one is published. Closes tried across
 * the range, at each price and just beyond it, must each give the order exactly when the report says so.
 */
export function verifyPublished(spec: Spec, data: Map<string, Bars>, label: string, seen: Tally): TriggerReport {
  const bt = runBacktest(spec, data);
  const report = computeTriggers(spec, data, triggerRun(bt.run));
  for (const t of report.triggers) {
    if (t.blocked || t.noRule) continue;
    const st = bt.run.states.find((s) => s.name === t.ticker)!;
    const own = data.get(t.ticker)!;
    const driven = t.driver !== t.ticker;
    assert.ok(!driven || data.get(t.driver)!.values, `${label}: only a series of values is given a row here, not ${t.driver}`);
    const made = (x: number) => {
      const m = new Map(data);
      const c = driven ? st.lastClose : x;
      m.set(t.ticker, { ...own, t: [...own.t, report.next], o: [...own.o, st.lastClose], h: [...own.h, Math.max(st.lastClose, c)], l: [...own.l, Math.min(st.lastClose, c)], c: [...own.c, c], v: [...own.v, own.v.at(-1)!] });
      if (driven) {
        const d = data.get(t.driver)!;
        // Read a bar early with fill: close, the value must be out before the bar starts; otherwise by the time it ends.
        const day = spec.fill === 'close' ? report.next - DAY : report.next;
        m.set(t.driver, { ...d, t: [...d.t, day], o: [...d.o, x], h: [...d.h, x], l: [...d.l, x], c: [...d.c, x], v: [...d.v, 0] });
      }
      return m;
    };
    const fires = (x: number) => t.fires.some((b) => (b.lo === null || x >= b.lo) && (b.hi === null || x <= b.hi));
    const xs: [number, boolean][] = [];
    const { lo, hi } = t.range;
    for (let k = 0; k < 48; k += 5) {
      const x = t.values ? lo + (hi - lo) * (k / 47) : lo * (hi / lo) ** (k / 47);
      xs.push([x, fires(x)]);
    }
    for (const band of t.fires) {
      for (const [edge, out] of [[band.lo, -1], [band.hi, 1]] as const) {
        if (edge === null) continue;
        xs.push([edge, true], [beyond(t, edge, out), false]);
        seen[t.side]++;
      }
    }
    for (const [x, expected] of xs) {
      const after = runBacktest(spec, made(x)).run.states.find((s) => s.name === t.ticker)!;
      assert.equal(fired(after, t.side, spec.fill === 'close'), expected, `${label}: ${t.ticker} ${t.side} with ${t.driver} at ${x} (${expected ? 'inside' : 'outside'} ${JSON.stringify(t.fires)})`);
    }
  }
  return report;
}
