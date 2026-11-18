// Trigger prices: for each ticker of a strategy, the closes at its next bar that would make its rules give an order. Each
// is found by working the rules out again on copies of the prices with that bar added; the run's own prices and state are
// never changed. Pure, so it runs in the background worker or, when none can start, on the main thread.

import { WARMUP_INPUT } from './backtest.ts';
import { children, findPos, walk, type Expr, type SeriesName, type Spec } from './dsl.ts';
import { missingInputAt, periodKey, type AssetState, type RunResult, type WarmupInput } from './engine.ts';
import { clocksApart, rowEnds, specEvaluator, type Apart, type Evaluator, type PosState } from './evaluate.ts';
import { DAY, isIntraday, minus, price, signedPct, stamp, tidy } from './format.ts';
import * as ind from './indicators.ts';
import { lookbackBars } from './runner.ts';
import { sliceBars, type Bars } from './types.ts';

export type TriggerSide = 'buy' | 'sell' | 'add' | 'rearm';

/** Closes at which a rule gives its order, from `lo` up to `hi`; null where that reaches past the closes searched, or for a held ticker to its stop or target. */
export interface Band {
  lo: number | null;
  hi: number | null;
}

export interface Trigger {
  ticker: string;
  side: TriggerSide;
  /** The ticker whose next close the prices are for: the one traded, or one its rules read with `of`. */
  driver: string;
  /** The driver's last close, which the percentages are measured from, and the closes searched around it. */
  last: number;
  range: { lo: number; hi: number };
  fires: Band[];
  /**
   * The driver is a series of values, such as a FRED series: what is tried is its next value, on an even scale rather
   * than a log one, and how far a value is from the last is a difference, not a percentage.
   */
  values?: true;
  /** The ticker's own last close, which its stop and target are measured from. */
  ownLast: number;
  /**
   * Why no price is worked out: an order already waits for the next open (or close), an input of the buy or the rule
   * itself is still warming up, only a ranking buys the ticker, or the ticker is a CSV file.
   */
  blocked?: 'pending' | 'warmup' | 'ranking' | 'csv';
  /** With `blocked: 'warmup'`: the input still unknown at the next close, or null when it is the buy rule. */
  warmup?: { input: WarmupInput; n: number } | null;
  /** Held with no sell rule and no add to make: only the stop, the target or a ranking sell it. */
  noRule?: true;
  /** Held: the stop and target in force for the next bar. */
  levels?: { stop: number | null; target: number | null };
  /** True when nothing about the next bar is assumed but the close; otherwise `assumptions` says what is, in words that follow "Assumes". */
  exact: boolean;
  assumptions: string[];
}

export interface TriggerReport {
  /** When the next bar starts. */
  next: number;
  /** The run's bars are shorter than a day, so times are written with the time of day. */
  intraday: boolean;
  /** The strategy fills at the close it read (`fill: close`), not at the following open. */
  closeFill: boolean;
  /** With a ranking: the start of the bar at whose close it decides next; null when that is too far to walk to. */
  decision: number | null;
  triggers: Trigger[];
}

/** What trigger prices need of a run: its timeline, its final equity, and each ticker's state at the end. */
export interface TriggerRun {
  t: number[];
  equity: number;
  states: AssetState[];
}

export const triggerRun = (run: Pick<RunResult, 't' | 'equity' | 'states'>): TriggerRun => ({ t: run.t, equity: run.equity[run.equity.length - 1], states: run.states });

/** Whether a strategy has a next close to watch: one that ends at a `to` date has not. */
export const watchable = (spec: Spec): boolean => spec.to === null;

/** Closes tried across the range before the changes between them are narrowed down. */
const GRID = 48;
/**
 * A change is narrowed down until the closes on either side of it are this close, as a fraction of the price, and within
 * a quarter of the last digit a price is shown with (format.ts price), so the level shown is the change to that digit.
 */
export const PRECISION = 1e-4;
const shownStep = (x: number): number => (x < 1 ? 1e-6 : 0.01) / 4;
/** The range searched is SPREAD standard deviations of the driver's last RETURNS log returns either side of its last close, within RANGE_MIN and RANGE_MAX. */
const SPREAD = 5;
const RETURNS = 60;
const RANGE_MIN = 0.02;
const RANGE_MAX = 0.5;
/** Rules worked out for one ticker at most, so a rule whose outcome flips at every close tried cannot run on. */
const MAX_TRIES = 600;
/** Bars at most added to a series read with `of` to reach the next bar of the ticker it is read for. */
const MAX_COVER = 64;
/** Bars at most walked forward to find a ranking's next decision. */
const MAX_WALK = 200_000;
/** Functions whose value at a bar depends on every bar before it rather than on a window, so a series cut short gives another value. */
const WHOLE = ['bars_since', 'obv'];
/** Functions given no series that read each bar's high, low and close, and those that read its volume as well. */
const HLC = ['atr', 'stoch_k', 'stoch_d', 'adx', 'plus_di', 'minus_di', 'cci', 'williams_r', 'supertrend', 'supertrend_up', 'keltner_upper', 'keltner_lower'];
const VOLUME: Record<string, SeriesName[]> = { mfi: ['high', 'low', 'close', 'volume'], vwap: ['high', 'low', 'close', 'volume'], obv: ['close', 'volume'] };

/** What the rules read of one series: the fewest bars back they read it, and what of its newest bar they read. */
interface Read {
  lag: number;
  now: Set<SeriesName | 'calendar' | 'column'>;
}

/** Every series the expressions read, worked out for `asset`, in the order first read. */
function readsOf(exprs: Expr[], asset: string): Map<string, Read> {
  const out = new Map<string, Read>();
  const note = (name: string, lag: number, what: Read['now'] extends Set<infer T> ? T[] : never) => {
    let r = out.get(name);
    if (!r) out.set(name, (r = { lag, now: new Set() }));
    r.lag = Math.min(r.lag, lag);
    if (lag === 0) for (const w of what) r.now.add(w);
  };
  const visit = (e: Expr, at: string, lag: number): void => {
    if (e.k === 'series') note(at, lag, [e.name]);
    else if (e.k === 'column') note(at, lag, ['column']);
    else if (e.k === 'cal') note(at, lag, ['calendar']);
    else if (e.k === 'lag') return visit(e.a, at, lag + e.n);
    else if (e.k === 'of') return visit(e.a, e.asset, lag);
    else if (e.k === 'ind') {
      if (HLC.includes(e.fn)) note(at, lag, ['high', 'low', 'close']);
      if (VOLUME[e.fn]) note(at, lag, VOLUME[e.fn]);
      if (e.fn === 'correl') note(at, lag, ['close']);
    }
    for (const c of children(e)) visit(c, at, lag);
  };
  for (const e of exprs) visit(e, asset, 0);
  return out;
}

/** How the next bar is made up for one ticker: whose close is tried, the bars added to each series, and what that assumes. */
interface Plan {
  driver: string;
  /** For the ticker and each series its rules read: the starts of the bars added, the driver's last one closing at the close tried. */
  added: Map<string, number[]>;
  assumptions: string[];
}

/** The time the bar added at `t` to series `b` ends, as the rules take it (evaluate.ts rowEnds). */
const endOf = (b: Bars, t: number[]): number => rowEnds({ ...b, t }).at(-1)!;

/** A series of dated values, a FRED series or a CSV file of columns: it has a row only when a value is published. */
const isValues = (b: Bars): boolean => !!(b.values || b.unpriced);

function smallestGap(t: number[]): number {
  let step = Infinity;
  for (let i = 1; i < t.length; i++) if (t[i] > t[i - 1]) step = Math.min(step, t[i] - t[i - 1]);
  return step;
}

/**
 * The latest time a value published in series `b` can be dated and still be known by `limit` (ind.valueEnds); null when
 * that is not past its last row, or so close to it that its rows would be known at other times.
 */
function publishedBy(b: Bars, limit: number): number | null {
  const step = smallestGap(b.t);
  const t = step < DAY ? limit - step : Math.floor(limit / DAY) * DAY - DAY;
  return t - b.t[b.t.length - 1] >= Math.min(step, DAY) ? t : null;
}

function planFor(data: Map<string, Bars>, apart: Apart | undefined, asset: string, exprs: Expr[], intraday: boolean): Plan {
  const reads = readsOf(exprs, asset);
  const own = data.get(asset)!;
  const next = ind.nextBarTime(own.t);
  const ownEnd = endOf(own, [...own.t, next]);
  const added = new Map<string, number[]>([[asset, [next]]]);
  const limitOf = (name: string) => (apart?.(name, asset) ? next : ownEnd);
  // Another series of prices gets the bars that the ticker's next bar would read: those that end by the time it ends, or
  // by the time it starts when it is read a bar early (evaluate.ts clocksApart). On the same clock that is one bar. A
  // series of values gets none: unless a value is published, the engine has no new row of it.
  for (const name of reads.keys()) {
    const b = data.get(name);
    if (name === asset || !b || b.t.length === 0 || isValues(b)) continue;
    const step = ind.barStepper(b.t);
    const times: number[] = [];
    let t = b.t;
    while (times.length < MAX_COVER) {
      t = [...t, step(t[t.length - 1])];
      if (endOf(b, t) > limitOf(name)) break;
      times.push(t[t.length - 1]);
    }
    if (times.length > 0) added.set(name, times);
  }
  const closeNow = (name: string) => reads.get(name)?.now.has('close') ?? false;
  let driver = asset;
  if (!closeNow(asset)) {
    for (const name of reads.keys()) {
      const b = data.get(name);
      if (name === asset || !b || b.t.length === 0 || !closeNow(name)) continue;
      if (!isValues(b)) {
        if (!added.has(name)) continue;
      } else {
        // Solved for a series of values, the value tried is one published just in time for the ticker's next bar.
        const at = publishedBy(b, limitOf(name));
        if (at === null) continue;
        added.set(name, [at]);
      }
      driver = name;
      break;
    }
  }

  const assumptions: string[] = [];
  const who = driver === asset ? 'it' : driver;
  const its = driver === asset ? 'its' : `${driver}'s`;
  const now = reads.get(driver)?.now ?? new Set();
  if (!isValues(data.get(driver)!)) {
    if (now.has('open')) assumptions.push(`${who} opens at its last close`);
    if (now.has('high') || now.has('low')) assumptions.push(`${who} trades only between its open and its close`);
    if (now.has('volume')) assumptions.push(`${its} volume is that of its last bar`);
    if (now.has('column')) assumptions.push(`${its} columns keep their last values`);
  }
  for (const name of [asset, ...[...reads.keys()].filter((n) => n !== asset)]) {
    const read = reads.get(name);
    const b = data.get(name);
    if (!read || !b) continue;
    if (name !== asset && isValues(b)) {
      if (name === driver) assumptions.push(`${name} publishes one new value by that close`);
      else assumptions.push(b.unpriced ? `${name} has no new row by that close` : `${name} publishes no new value by that close`);
      continue;
    }
    const times = added.get(name);
    if (!times || read.lag >= (name === driver ? times.length - 1 : times.length)) continue;
    assumptions.push(name === driver ? `${name} is unchanged until that close` : `${name} is unchanged`);
  }
  if ([...reads.values()].some((r) => r.now.has('calendar'))) assumptions.push(`the next bar is dated ${stamp(next, intraday)}`);
  return { driver, added, assumptions };
}

/**
 * A copy of `b` with bars added at `times`: each opens at the close before it, the last closes at `close` and the others
 * where they opened. A value published is its own open, high and low. The series' own flags are kept as they are, since
 * they decide when its rows are known.
 */
function withBars(b: Bars, times: number[], close: number): Bars {
  const last = b.c[b.c.length - 1];
  const volume = b.v[b.v.length - 1];
  const out: Bars = { ...b, t: [...b.t, ...times], o: [...b.o], h: [...b.h], l: [...b.l], c: [...b.c], v: [...b.v] };
  times.forEach((_, k) => {
    const c = k === times.length - 1 ? close : last;
    const o = b.values ? c : last;
    out.o.push(o);
    out.h.push(Math.max(o, c));
    out.l.push(Math.min(o, c));
    out.c.push(c);
    out.v.push(volume);
  });
  if (b.columns) out.columns = b.columns.map((col) => ({ ...col, v: [...col.v, ...times.map(() => col.v[col.v.length - 1])] }));
  return out;
}

/**
 * How many of their last bars the series `names` are cut to, so each try reads less; null when they must be read whole.
 * They are read whole when a rule reads a function of the whole history (bars_since, obv), or when the cut would change a
 * series' smallest gap, its clock or where its next bar falls, all of which decide how its bars line up. The rules are
 * also checked on the cut series against the run's own reading (see agrees).
 */
export function keptBars(spec: Spec, data: Map<string, Bars>, names: string[], exprs: Expr[]): number | null {
  let whole = false;
  for (const e of exprs) walk(e, (x) => (whole ||= x.k === 'ind' && WHOLE.includes(x.fn)));
  if (whole) return null;
  const keep = lookbackBars(spec) + 2;
  for (const name of names) {
    const t = data.get(name)!.t;
    if (t.length <= keep) continue;
    const cut = t.slice(t.length - keep);
    if (smallestGap(cut) !== smallestGap(t) || ind.clockOf('', cut) !== ind.clockOf('', t) || ind.nextBarTime(cut) !== ind.nextBarTime(t)) return null;
  }
  return keep;
}

const same = (x: number, y: number) => x === y || (Number.isNaN(x) && Number.isNaN(y));

/**
 * Whether every part of the expressions, worked out for `asset`, has the same value at the last bar of the run (`full`,
 * on its own prices) and of a try (`cut`, on prices cut short and with the next bar added): the guard that cutting the
 * prices short changed nothing the rules read. `last` gives each series' last bar of the run in both.
 */
export function agrees(full: Evaluator, cut: Evaluator, exprs: Expr[], asset: string, last: (name: string, cut: boolean) => number, pos: PosState | null, cutPos: PosState | null): boolean {
  let ok = true;
  const visit = (e: Expr, at: string): void => {
    if (!ok) return;
    if (!findPos(e)) ok = same(full.eval(e, at)[last(at, false)], cut.eval(e, at)[last(at, true)]);
    for (const c of children(e)) visit(c, e.k === 'of' ? e.asset : at);
  };
  for (const e of exprs) {
    if (findPos(e)) ok &&= same(full.compile(e, asset)(last(asset, false), pos), cut.compile(e, asset)(last(asset, true), cutPos));
    visit(e, asset);
  }
  return ok;
}

/** The fraction either side of the last close searched: SPREAD standard deviations of the last RETURNS log returns. */
function spread(c: number[]): number {
  const rets: number[] = [];
  for (let i = Math.max(1, c.length - RETURNS); i < c.length; i++) {
    const r = Math.log(c[i] / c[i - 1]);
    if (Number.isFinite(r)) rets.push(r);
  }
  if (rets.length < 2) return RANGE_MAX;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
  return Math.min(RANGE_MAX, Math.max(RANGE_MIN, SPREAD * sd));
}

/**
 * The values searched for a series of values, which can be 0 or below: SPREAD times the root mean square of its last
 * RETURNS changes either side of its last value, or of all its changes when those are all 0; for a series that has
 * never changed, RANGE_MAX of its last value, or 1 when that is 0.
 */
function valueRange(c: number[]): { lo: number; hi: number } {
  const last = c[c.length - 1];
  const rms = (from: number) => {
    let [sum, n] = [0, 0];
    for (let i = Math.max(1, from); i < c.length; i++) {
      const d = c[i] - c[i - 1];
      if (Number.isFinite(d)) [sum, n] = [sum + d * d, n + 1];
    }
    return n > 0 ? Math.sqrt(sum / n) : 0;
  };
  const r = SPREAD * (rms(c.length - RETURNS) || rms(1)) || (last === 0 ? 1 : RANGE_MAX * Math.abs(last));
  return { lo: last - r, hi: last + r };
}

/** A stretch of closes over which a rule's outcome stays `label`, from `from` to `to`, both tried; null at the ends of the closes searched. */
interface Stretch {
  label: string;
  from: number | null;
  to: number | null;
}

/**
 * The outcome of `label` across the closes from `lo` to `hi`: GRID closes spaced evenly on a log scale, then each change
 * between two of them narrowed down by halving until the closes either side are within PRECISION of each other, and of
 * the digit a price is shown to. With
 * `even`, for a series of values, they are spaced evenly and narrowed down to PRECISION of the range from `lo` to `hi`.
 */
export function search(lo: number, hi: number, label: (x: number) => string, even = false): Stretch[] {
  const xs = Array.from({ length: GRID }, (_, k) => (even ? lo + (hi - lo) * (k / (GRID - 1)) : lo * (hi / lo) ** (k / (GRID - 1))));
  const wide = even ? (p: number, q: number) => q - p > PRECISION * (hi - lo) : (p: number, q: number) => q - p > Math.min(PRECISION * p, shownStep(p));
  const ls = xs.map(label);
  const out: Stretch[] = [{ label: ls[0], from: null, to: null }];
  let tries = GRID;
  let [cur, at] = [ls[0], xs[0]];
  for (let k = 1; k < GRID; k++) {
    while (cur !== ls[k]) {
      let [p, q, lq] = [at, xs[k], ls[k]];
      while (wide(p, q) && tries < MAX_TRIES) {
        const m = even ? (p + q) / 2 : Math.sqrt(p * q);
        const lm = label(m);
        tries++;
        if (lm === cur) p = m;
        else [q, lq] = [m, lm];
      }
      if (tries >= MAX_TRIES) [q, lq] = [xs[k], ls[k]];
      out[out.length - 1].to = p;
      out.push({ label: lq, from: q, to: null });
      [cur, at] = [lq, q];
    }
    at = xs[k];
  }
  return out;
}

/** What one try of the next bar says for the ticker. */
type Outcome = TriggerSide | 'none';

/** The start of the bar at whose close a ranking next decides: the last bar of the period the next bar falls in, or the next bar with `rebalance: never`. */
function nextDecision(t: number[], rebalance: Spec['rebalance']): number | null {
  const step = ind.barStepper(t);
  let cur = step(t[t.length - 1]);
  if (rebalance === 'never') return cur;
  for (let i = 0; i < MAX_WALK; i++) {
    const after = step(cur);
    if (periodKey(after, rebalance) !== periodKey(cur, rebalance)) return cur;
    cur = after;
  }
  return null;
}

/** The trigger prices of every ticker of a strategy, from the run of `spec` on `data` that ended in `run`. */
export function computeTriggers(spec: Spec, data: Map<string, Bars>, run: TriggerRun): TriggerReport {
  const intraday = isIntraday(run.t);
  const report: TriggerReport = {
    next: ind.nextBarTime(run.t),
    intraday,
    closeFill: spec.fill === 'close',
    decision: spec.rank ? nextDecision(run.t, spec.rebalance) : null,
    triggers: [],
  };
  const apart = clocksApart(spec, data);
  let reference: Evaluator | null = null;
  const full = () => (reference ??= specEvaluator(spec, data));
  for (const a of spec.universe) {
    const st = run.states.find((s) => s.name === a.name)!;
    report.triggers.push(...tickerTriggers(spec, data, run, st, a.source === 'csv', apart, full, intraday));
  }
  return report;
}

/** The rules that decide a ticker's next order: sell and add while held, the buy rule (and the sell rule, which can veto it) while flat. */
function rulesFor(spec: Spec, st: AssetState): { read: Expr[]; addable: boolean } {
  const rules = spec.rules[st.name];
  const addable = st.long && !!rules.add && (st.entries ?? 1) < (spec.entries ?? 1);
  const exprs = st.long ? [rules.sell, addable ? rules.add! : null] : st.rearming ? [rules.buy] : [rules.buy, rules.sell];
  return { read: exprs.filter((e): e is Expr => e !== null && e !== undefined), addable };
}

/** The plain parts of a ticker's trigger, before any price is worked out. */
function blank(st: AssetState, side: TriggerSide): Trigger {
  return { ticker: st.name, side, driver: st.name, last: st.lastClose, range: { lo: st.lastClose, hi: st.lastClose }, fires: [], ownLast: st.lastClose, exact: true, assumptions: [] };
}

function tickerTriggers(spec: Spec, data: Map<string, Bars>, run: TriggerRun, st: AssetState, csv: boolean, apart: Apart | undefined, full: () => Evaluator, intraday: boolean): Trigger[] {
  const name = st.name;
  const rules = spec.rules[name];
  const levels = st.levels ? { levels: { ...st.levels } } : {};
  if (csv) return [{ ...blank(st, st.long ? 'sell' : 'buy'), blocked: 'csv' }];
  if (st.pending) return [{ ...blank(st, st.pending), blocked: 'pending' }];
  if (!st.long && spec.rank) return [{ ...blank(st, 'buy'), blocked: 'ranking' }];
  const { read, addable } = rulesFor(spec, st);
  if (st.long && !rules.sell && !addable) return [{ ...blank(st, 'sell'), noRule: true, ...levels }];

  const plan = planFor(data, apart, name, read, intraday);
  const { driver, added } = plan;
  const driverBars = data.get(driver)!;
  const values = !!driverBars.values;
  const last = driverBars.c[driverBars.c.length - 1];
  const r = values ? 0 : spread(driverBars.c);
  let range = values ? valueRange(driverBars.c) : { lo: last * (1 - r), hi: last * (1 + r) };
  const sides: TriggerSide[] = st.long ? [...(rules.sell ? (['sell'] as const) : []), ...(addable ? (['add'] as const) : [])] : [st.rearming ? 'rearm' : 'buy'];
  const made = (fires: Band[], side: TriggerSide, more: Partial<Trigger> = {}): Trigger => ({
    ticker: name,
    side,
    driver,
    last,
    range,
    fires,
    ...(values ? { values: true as const } : {}),
    ownLast: st.lastClose,
    ...levels,
    ...more,
    exact: plan.assumptions.length === 0,
    assumptions: plan.assumptions,
  });

  // The prices each try reads: the series the rules read, cut short when that is safe, with the next bar added.
  const cutAt = (keep: number | null) => {
    const base = new Map<string, Bars>();
    for (const n of added.keys()) {
      const b = data.get(n)!;
      base.set(n, keep !== null && b.t.length > keep ? sliceBars(b, b.t.length - keep) : b);
    }
    return base;
  };
  const tryData = (base: Map<string, Bars>, x: number) => {
    const m = new Map(data);
    for (const [n, times] of added) {
      const b = base.get(n)!;
      m.set(n, withBars(b, times, n === driver ? x : b.c[b.c.length - 1]));
    }
    return m;
  };
  let base = cutAt(keptBars(spec, data, [...added.keys()], read));
  const shift = (b: Map<string, Bars>) => data.get(name)!.t.length - b.get(name)!.t.length;
  const posIn = (b: Map<string, Bars>): PosState | null => (st.pos ? { ...st.pos, entryIdx: st.pos.entryIdx - shift(b) } : null);
  if ([...base].some(([n, b]) => b !== data.get(n))) {
    const cut = base;
    const lastOf = (n: string, inCut: boolean) => (inCut ? cut.get(n) ?? data.get(n)! : data.get(n)!).t.length - 1;
    if (!agrees(full(), specEvaluator(spec, tryData(cut, last)), read, name, lastOf, st.pos ?? null, posIn(cut))) base = cutAt(null);
  }
  const pos = posIn(base);
  const n = base.get(name)!.t.length;

  if (!st.long && !st.rearming) {
    const own = withBars(base.get(name)!, added.get(name)!, base.get(name)!.c.at(-1)!);
    const missing = missingInputAt(
      spec.sizing,
      spec.stops[name],
      (k) => ind.atr(own.h, own.l, own.c, k)[n],
      (k) => ind.stdev(ind.returns(own.c), k)[n],
    );
    if (missing) return [made([], 'buy', { blocked: 'warmup', warmup: missing })];
  }

  // A held ticker's stop and target act inside the bar before its close, so the closes searched stop short of them; one
  // the bar opens beyond (at the last close, as it is taken to open) sells it at the open whatever the close.
  if (st.long && st.levels) {
    const { stop, target } = st.levels;
    if ((stop !== null && st.lastClose <= stop) || (target !== null && st.lastClose >= target)) return sides.map((side) => made([], side));
    if (driver === name) range = { lo: stop === null ? range.lo : Math.max(range.lo, stop * (1 + 1e-9)), hi: target === null ? range.hi : Math.min(range.hi, target * (1 - 1e-9)) };
  }
  if (!(values ? Number.isFinite(last) : last > 0) || !(range.lo < range.hi)) return sides.map((side) => made([], side));

  let known = false;
  const outcome = (x: number): Outcome => {
    const ev = specEvaluator(spec, tryData(base, x));
    if (st.long) {
      if (rules.sell && ev.compile(rules.sell, name)(n, pos) === 1) return 'sell';
      if (!addable || ev.compile(rules.add!, name)(n, pos) !== 1) return 'none';
      // An add is made only while the position is below its whole size (engine.ts, the state of an add at the end).
      const value = st.shares * (driver === name ? x : st.lastClose);
      return st.targetWeight * (run.equity - st.value + value) - value > 0 ? 'add' : 'none';
    }
    const buy = ev.eval(rules.buy, name)[n];
    if (!Number.isNaN(buy)) known = true;
    if (st.rearming) return buy !== 1 ? 'rearm' : 'none';
    return buy === 1 && !(rules.sell && ev.compile(rules.sell, name)(n, null) === 1) ? 'buy' : 'none';
  };
  const stretches = search(range.lo, range.hi, outcome, values);
  if (!st.long && !st.rearming && !known) return [made([], 'buy', { blocked: 'warmup', warmup: null })];
  return sides.map((side) => made(stretches.filter((s) => s.label === side).map((s) => ({ lo: s.from, hi: s.to })), side));
}

/**
 * The prices a try of the next bar reads for `ticker`, whole: those of the run with the bars added that its trigger
 * assumes, the driver's last closing at `close`. For checking trigger prices against the engine.
 */
export function nextBarData(spec: Spec, data: Map<string, Bars>, st: AssetState, close: number): Map<string, Bars> {
  const plan = planFor(data, clocksApart(spec, data), st.name, rulesFor(spec, st).read, false);
  const m = new Map(data);
  for (const [n, times] of plan.added) m.set(n, withBars(data.get(n)!, times, n === plan.driver ? close : data.get(n)!.c.at(-1)!));
  return m;
}

// ---------------------------------------------------------------- in words

/** A value of a series of values to 5 significant digits. */
const rounded = (x: number) => Number(x.toPrecision(5));
const shown = (x: number) => minus(x.toLocaleString('en-US', { maximumSignificantDigits: 5 }));

/**
 * A price with how far it is from `from`, such as "512.30 (+1.2%)"; with `values`, a value and its change, such as
 * "−0.30 (−0.24)", the change being that between the two values as shown.
 */
function priced(x: number, from: number, values?: true): string {
  if (!values) return `${price(x)} (${signedPct(x / from - 1)})`;
  const change = tidy(rounded(x) - rounded(from));
  return `${shown(x)} (${change > 0 ? '+' : ''}${shown(change)})`;
}

const VERB: Record<Exclude<TriggerSide, 'rearm'>, string> = { buy: 'Buys', sell: 'Sells', add: 'Adds' };

/** Where a band's closes lie, after "closes": "above 512.30 (+1.2%)", "below …", "between … and …". */
function where(b: Band, last: number, values?: true): string {
  if (b.lo !== null && b.hi !== null) return `between ${priced(b.lo, last, values)} and ${priced(b.hi, last, values)}`;
  return b.lo !== null ? `above ${priced(b.lo, last, values)}` : `below ${priced(b.hi!, last, values)}`;
}

/**
 * When the rule fires, in words after its verb: "if it closes above 512.30 (+1.2%)", "unless it closes below 498.20
 * (−1.1%)" when it would at an unchanged close, "whatever the next close", or null when it fires at no close searched.
 * `who` closes: "it" for the ticker itself, or the driver's name. For a series of values it is the driver's next value
 * that is above or below: "if T10Y2Y's next value is above 0.10 (+0.04)".
 */
export function condition(t: Pick<Trigger, 'fires' | 'last' | 'values'>, who: string): string | null {
  if (t.fires.length === 0) return null;
  const closes = t.values ? `${who}'s next value is` : `${who} closes`;
  if (t.fires.length > 1) return `if ${closes} ${t.fires.map((b) => where(b, t.last, t.values)).join(' or ')}`;
  const [b] = t.fires;
  if (b.lo === null && b.hi === null) return t.values ? `whatever ${closes}` : 'whatever the next close';
  if (b.hi === null && b.lo! <= t.last) return `unless ${closes} below ${priced(b.lo!, t.last, t.values)}`;
  if (b.lo === null && b.hi! >= t.last) return `unless ${closes} above ${priced(b.hi!, t.last, t.values)}`;
  return `if ${closes} ${where(b, t.last, t.values)}`;
}

/** When an order given at the next close fills. */
export const fillPhrase = (closeFill: boolean): string => (closeFill ? 'at that close' : 'at the following open');

/** Whether a held ticker's stop or target lies beyond its last close, so the next open sells it whatever its rules say. */
const actsAtOpen = (t: Pick<Trigger, 'levels' | 'ownLast'>): boolean =>
  !!t.levels && ((t.levels.stop !== null && t.levels.stop >= t.ownLast) || (t.levels.target !== null && t.levels.target <= t.ownLast));

/**
 * The rule's part, such as "Buys if it closes above 512.30 (+1.2%)", without when it fills; null for a trigger with no
 * price worked out, or a held ticker its stop or target sells at the next open.
 */
export function rulePhrase(t: Trigger): string | null {
  if (t.blocked || t.noRule || actsAtOpen(t)) return null;
  const who = t.driver === t.ticker ? 'it' : t.driver;
  const range = `from ${priced(t.range.lo, t.last, t.values)} to ${priced(t.range.hi, t.last, t.values)}`;
  const close = `${t.values ? 'next value' : 'close'}${t.driver === t.ticker ? '' : ` of ${t.driver}`}`;
  if (t.side === 'rearm') {
    const cond = condition(t, t.driver);
    return `After a stop or target exit, the buy rule must stop holding before ${t.ticker} is bought again: ${cond ? `it does ${cond}` : `it holds at every ${close} ${range}`}`;
  }
  const cond = condition(t, who);
  return cond ? `${VERB[t.side]} ${cond}` : `The ${t.side} rule gives no order at any ${close} ${range}`;
}

/** The stop and target of a held ticker in a sentence; null when it has neither. */
export function levelsSentence(t: Pick<Trigger, 'levels' | 'ownLast'>): string | null {
  if (!t.levels) return null;
  const { stop, target } = t.levels;
  if (stop !== null && stop >= t.ownLast) return `The stop at ${priced(stop, t.ownLast)} is above the last close, so it sells at the next open unless the price opens above it.`;
  if (target !== null && target <= t.ownLast) return `The target at ${priced(target, t.ownLast)} is below the last close, so it sells at the next open unless the price opens below it.`;
  const parts = [stop !== null ? `the stop at ${priced(stop, t.ownLast)}` : '', target !== null ? `the target at ${priced(target, t.ownLast)}` : ''].filter(Boolean);
  const text = `${parts.join(' and ')} ${parts.length > 1 ? 'sell' : 'sells'} during the bar if the price reaches ${parts.length > 1 ? 'them' : 'it'}.`;
  return text[0].toUpperCase() + text.slice(1);
}

/** "A", "A and B", "A, B and C". */
const listed = (xs: string[]) => (xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** When a ranking decides next, after "next" or "again": "at the next close", "at the close of 2026-11-30". */
function decisionPhrase(report: TriggerReport): string | null {
  if (report.decision === null) return null;
  return report.decision === report.next ? 'at the next close' : `at the close of ${stamp(report.decision, report.intraday)}`;
}

/**
 * What the positions table says of a ticker at the next close: each rule's price and when its order fills, the stop and
 * target, the ranking's next decision, and in `note` what the prices assume. "–" when an order already waits or the
 * ticker is a CSV file.
 */
export function tickerText(report: TriggerReport, ticker: string): { text: string; note: string | null } {
  const mine = report.triggers.filter((t) => t.ticker === ticker);
  if (mine.length === 0 || mine.some((t) => t.blocked === 'pending' || t.blocked === 'csv')) return { text: '–', note: null };
  const decision = decisionPhrase(report);
  const first = mine[0];
  if (first.blocked === 'ranking') return { text: decision ? `Bought only when the ranking picks it, next ${decision}.` : 'Bought only when the ranking picks it.', note: null };
  if (first.blocked === 'warmup') {
    const what = first.warmup ? WARMUP_INPUT[first.warmup.input](first.warmup.n) : 'the buy rule';
    return { text: `Can't buy at the next close: ${what} is still unknown there.`, note: null };
  }
  const out: string[] = [];
  for (const t of mine) {
    if (t.noRule) out.push(`No ${t.side} rule.`);
    const phrase = rulePhrase(t);
    if (phrase) out.push(t.side === 'rearm' || t.fires.length === 0 ? `${phrase}.` : `${phrase}, ${fillPhrase(report.closeFill)}.`);
  }
  const levels = levelsSentence(first);
  if (levels) out.push(levels);
  if (decision && first.side !== 'rearm') out.push(`The ranking decides again ${decision}.`);
  return { text: out.join(' '), note: first.assumptions.length > 0 ? `Assumes ${listed(first.assumptions)}.` : null };
}

/**
 * How near the next close is to changing what the rule does: the signed fraction from the driver's last close to the
 * nearest price where it starts or stops firing (NaN when there is none among the closes searched), and whether it fires
 * at an unchanged close. Null when it fires at no close searched. For a series of values the distance is the difference
 * from its last value, not a fraction.
 */
export function nearest(t: Pick<Trigger, 'fires' | 'last' | 'values'>): { distance: number; now: boolean } | null {
  if (t.fires.length === 0) return null;
  let distance = NaN;
  for (const b of t.fires) {
    for (const edge of [b.lo, b.hi]) {
      if (edge === null) continue;
      const d = t.values ? edge - t.last : edge / t.last - 1;
      if (Number.isNaN(distance) || Math.abs(d) < Math.abs(distance)) distance = d;
    }
  }
  const now = t.fires.some((b) => (b.lo === null || b.lo <= t.last) && (b.hi === null || b.hi >= t.last));
  return { distance, now };
}
