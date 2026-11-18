import { children, findPos, ruleExprs, type CalName, type CmpOp, type Expr, type Spec } from './dsl.ts';
import { DAY } from './format.ts';
import { priceMemo } from './price-memo.ts';
import type { Bars } from './types.ts';
import * as ind from './indicators.ts';

/** Whether the rules of series `to` must read series `from` one bar early: see clocksApart. */
export type Apart = (from: string, to: string) => boolean;

/**
 * Which series a spec's rules must read one bar early: with `fill: close`, those on another clock than the series the rule
 * belongs to (ind.clockOf: another source, other days of the week, or another bar length).
 *
 * The rule: an order filled at a close may rest only on bars that had closed by then. A bar of another series normally
 * counts once it has ended by the end of the rule's own bar (alignByEnd). Bars carry only their start, and a daily bar is
 * stamped at midnight UTC of its date whatever the market's hours, so two series' bars of one period end at the same
 * stamped time while really closing hours apart: a US stock at about 21:00 UTC, crypto at 24:00, Tokyo at 06:00. With
 * next-open fills that does not matter, as the order fills on a later bar. With close fills, a rule on one clock reads
 * another clock's latest bar that had ended by the time its own bar began, so never one of the same period: for daily bars
 * the other series' previous day, for weekly bars its previous week, for hourly bars its previous hour, and a daily bar from
 * the next day's first hour on. Series on one clock are read as before, as the data cannot show that they close apart.
 * engine.ts applies the same rule to a ranking's comparison across tickers.
 */
export function clocksApart(spec: Spec, data: Map<string, Bars>): Apart | undefined {
  if (spec.fill !== 'close') return undefined;
  const sources = sourcesOf(spec);
  const clocks = new Map<string, string>();
  const clock = (name: string) => {
    let c = clocks.get(name);
    if (c === undefined) clocks.set(name, (c = ind.clockOf(sources.get(name) ?? '?', data.get(name)?.t ?? [])));
    return c;
  };
  return (from, to) => clock(from) !== clock(to);
}

/** The source of each series a spec names, the first one given when a name comes more than once. */
function sourcesOf(spec: Spec): Map<string, string> {
  const sources = new Map<string, string>();
  const refs = [...spec.universe, ...spec.extras, ...(spec.benchmark ? [spec.benchmark] : []), ...(spec.cash.k === 'ticker' ? [spec.cash.ref] : [])];
  for (const r of refs) if (!sources.has(r.name)) sources.set(r.name, r.source);
  return sources;
}

/**
 * What clocksApart's answer rests on besides the prices, as text. Two specs with the same key read every series alike on
 * one map of prices, so their Evaluators can share indicator series (price-memo.ts).
 */
export function apartKey(spec: Spec): string {
  return spec.fill === 'close' ? JSON.stringify([...sourcesOf(spec)].sort(([a], [b]) => (a < b ? -1 : 1))) : '';
}

/** When each row of a series is known: a bar of prices when it ends, a row of dated values (a file's, FRED's) by ind.valueEnds. */
export const rowEnds = (b: Bars): number[] => (b.unpriced || b.values ? ind.valueEnds(b.t) : ind.barEnds(b.t));

/** Functions given a series that still read the ticker's own prices: its closes, or its average true range. */
const OWN_PRICES = ['correl', 'keltner_upper', 'keltner_lower'];

/** Functions that weigh bars by volume, and so mean nothing on prices that have none. */
const NEEDS_VOLUME = ['mfi', 'obv', 'vwap', 'cmf'];

/**
 * The Evaluator a spec's rules are read with, by the run and by everything that explains or redoes it.
 * A file of columns with no prices can be read by `of`, but not traded, compared with or used for a cash rate.
 */
export function specEvaluator(spec: Spec, data: Map<string, Bars>): Evaluator {
  const roles: [string | undefined, string][] = [
    ...spec.universe.map((a): [string, string] => [a.name, 'be in the universe, because it cannot be traded']),
    [spec.benchmark?.name, 'be the benchmark, because it has no price to hold'],
    [spec.cash.k === 'ticker' ? spec.cash.ref.name : undefined, 'give the cash rate, because it has no close to read a yield from'],
  ];
  for (const [name, role] of roles) {
    if (name !== undefined && data.get(name)?.unpriced) {
      throw new Error(`${name} has no prices, only columns. A strategy can read its columns with column(...) of ${name}, but ${name} cannot ${role}.`);
    }
  }
  return new Evaluator(data, clocksApart(spec, data), apartKey(spec));
}

/** The files whose columns a spec's rules read, as the rules name them, in the order they are first read. */
export function columnFiles(spec: Spec): string[] {
  const out = new Set<string>();
  const visit = (e: Expr, asset: string): void => {
    if (e.k === 'column') out.add(asset);
    for (const c of children(e)) visit(c, e.k === 'of' ? e.asset : asset);
  };
  for (const a of spec.universe) {
    for (const e of [...ruleExprs(spec.rules[a.name]), spec.rank?.by]) if (e) visit(e, a.name);
  }
  return [...out];
}

/** A length of time in words: "15 minutes", "1 hour", "4 hours". */
function span(ms: number): string {
  const [n, unit] = ms % 3_600_000 === 0 ? [ms / 3_600_000, 'hour'] : ms % 60_000 === 0 ? [ms / 60_000, 'minute'] : [ms / 1000, 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * When a row of a CSV file counts as known, and how it must be dated for that, in words that follow "counts as known":
 * a file of dated values at the end of the day it is dated, a file with prices when its bar ends, and either at its time
 * plus the shortest gap between rows when they are less than a day apart. The same rule as Evaluator.aligned. Without the
 * file's rows, a row of a day.
 */
export function rowDating(b?: Bars): { known: string; carry: string; daily: boolean } {
  let step = Infinity;
  const t = b?.t ?? [];
  for (let i = 1; i < t.length; i++) if (t[i] > t[i - 1]) step = Math.min(step, t[i] - t[i - 1]);
  if (step < DAY) {
    return { known: `at its time plus ${span(step)}, the shortest gap between its rows`, carry: 'so each row must carry the start of the interval its value was computed from', daily: false };
  }
  if (b && !b.unpriced && Number.isFinite(step) && step > DAY) {
    const months = Math.max(1, Math.round(step / (30.4375 * DAY)));
    const after = step < 20 * DAY ? `${Math.round(step / DAY)} days` : months === 1 ? 'a month' : `${months} months`;
    return { known: `when its bar ends, ${after} after the day it is dated`, carry: "so a value in its columns must come from that bar's close or before", daily: false };
  }
  return { known: 'at the end of the day it is dated', carry: 'so each row must carry the day whose close its value was computed from', daily: true };
}

const LOOKAHEAD = 'a row dated earlier than the data behind it lets the rules see the future.';

/**
 * What the result says when a rule reads a column: when a row counts as known and so how it must be dated, because a wrong
 * date lets a rule see the future. With `fill: close`, also which row an order at a close rests on (clocksApart), for every
 * rule that reads the file, prices or columns, so the note on reading other tickers a bar early (backtest.ts) leaves these
 * files to this one. Files that read alike share a note.
 */
export function columnNotes(spec: Spec, data?: Map<string, Bars>): string[] {
  const files = columnFiles(spec);
  if (files.length === 0) return [];
  const apart = data ? clocksApart(spec, data) : undefined;
  const reads = ofReads(spec);
  const groups = new Map<string, string[]>();
  const tails = new Map<string, string>();
  for (const file of files) {
    const dating = rowDating(data?.get(file));
    let tail = '';
    if (apart) {
      const when = dating.daily ? 'date' : 'time';
      const readers = reads.filter(([, read]) => read === file).map(([reader]) => reader);
      const early = readers.filter((r) => apart(file, r));
      const same = readers.filter((r) => !apart(file, r));
      if (early.length) {
        tail += ` With fill: close, a rule of ${list(early)} reads the latest row of ${file} that had ended when its own bar began, never the row of the same ${when}, because the order fills at the close, before that row is known.`;
      }
      if (same.length) {
        tail += ` With fill: close, a rule of ${list(same)} reads the row of ${file} of the same ${when}, and the result assumes that row is known at the moment of the fill, which is not true when it is worked out after that close.`;
      }
    }
    const key = `${dating.known}\u0000${dating.carry}\u0000${tail}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(file);
    tails.set(key, tail);
  }
  return [...groups].map(([key, names]) => {
    const [known, carry] = key.split('\u0000');
    return `A row of ${list(names)} counts as known ${known}, ${carry}: ${LOOKAHEAD}${tails.get(key)}`;
  });
}

/** "A", "A and B", "A, B and C". */
const list = (names: string[]): string => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** Every [reader, read] pair of tickers that a spec's rules and ranking score connect with `of`, nested ones included. */
export function ofReads(spec: Spec): [string, string][] {
  const out = new Map<string, [string, string]>();
  const visit = (e: Expr, asset: string): void => {
    if (e.k === 'of' && e.asset !== asset) out.set(`${asset}\u0000${e.asset}`, [asset, e.asset]);
    for (const c of children(e)) visit(c, e.k === 'of' ? e.asset : asset);
  };
  for (const a of spec.universe) {
    for (const e of [...ruleExprs(spec.rules[a.name]), spec.rank?.by]) if (e) visit(e, a.name);
  }
  return [...out.values()];
}

/**
 * The open position a sell or add rule reads: where its first entry filled, as an index into the asset's bars; the
 * average fill price of its entries; the fill price of its latest entry; and how many entries it has.
 */
export interface PosState {
  entryIdx: number;
  entryPrice: number;
  /** Absent for a position bought in one entry, whose last entry is its only one. */
  lastPrice?: number;
  entries?: number;
  /** Absent for a long position. */
  short?: true;
  /** Present with `fill: close`: the first entry filled at the close of its bar, so that bar's range came before the fill. */
  atClose?: true;
}

/** A rule evaluated one bar at a time: 1, 0 or NaN at bar `i`, given the open position (null when flat). */
export type BarRule = (i: number, pos: PosState | null) => number;

function arith(op: '+' | '-' | '*' | '/', a: number, b: number): number {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return b === 0 ? NaN : a / b;
  }
}

/** A comparison at one bar; `pa` and `pb` are the previous bar's values, which only crosses read. */
function compare(op: CmpOp, a: number, b: number, pa: number, pb: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  switch (op) {
    case '>':
      return a > b ? 1 : 0;
    case '<':
      return a < b ? 1 : 0;
    case '>=':
      return a >= b ? 1 : 0;
    case '<=':
      return a <= b ? 1 : 0;
    case '==':
      return a === b ? 1 : 0;
    case '!=':
      return a !== b ? 1 : 0;
    case 'xup':
      return Number.isNaN(pa) || Number.isNaN(pb) ? NaN : a > b && pa <= pb ? 1 : 0;
    case 'xdn':
      return Number.isNaN(pa) || Number.isNaN(pb) ? NaN : a < b && pa >= pb ? 1 : 0;
    case 'xany':
      return Number.isNaN(pa) || Number.isNaN(pb) ? NaN : (a > b && pa <= pb) || (a < b && pa >= pb) ? 1 : 0;
  }
}

function logic(op: 'and' | 'or', a: number, b: number): number {
  if (op === 'and') return a === 0 || b === 0 ? 0 : a === 1 && b === 1 ? 1 : NaN;
  return a === 1 || b === 1 ? 1 : a === 0 && b === 0 ? 0 : NaN;
}

/** `sqrt`, `log` or `exp` of one value; unknown where the result is not a number, as the root of a negative or the log of 0 or less, or is too large to hold. */
function unary(fn: 'sqrt' | 'log' | 'exp', x: number): number {
  switch (fn) {
    case 'sqrt':
      return x < 0 ? NaN : Math.sqrt(x);
    case 'log':
      return x > 0 ? Math.log(x) : NaN;
    case 'exp': {
      const y = Math.exp(x);
      return y === Infinity ? NaN : y;
    }
  }
}

/** `if(condition, a, b)` at one bar: `a` where the condition holds, `b` where it does not, unknown where it is. */
const choose = (condition: number, a: number, b: number): number => (Number.isNaN(condition) ? NaN : condition === 1 ? a : b);

function calendar(name: CalName, t: number[]): number[] {
  const each = (fn: (d: Date) => number) => t.map((x) => fn(new Date(x)));
  switch (name) {
    case 'month':
      return each((d) => d.getUTCMonth() + 1);
    case 'day':
      return each((d) => d.getUTCDate());
    case 'weekday':
      return each((d) => ((d.getUTCDay() + 6) % 7) + 1);
    case 'year':
      return each((d) => d.getUTCFullYear());
    case 'month_start':
      return ind.periodStarts(t, ind.monthKey);
    case 'month_end':
      return ind.periodEnds(t, ind.monthKey);
    case 'quarter':
      return each((d) => Math.floor(d.getUTCMonth() / 3) + 1);
    case 'week_start':
      return ind.periodStarts(t, ind.weekKey);
    case 'week_end':
      return ind.periodEnds(t, ind.weekKey);
    case 'quarter_start':
      return ind.periodStarts(t, ind.quarterKey);
    case 'quarter_end':
      return ind.periodEnds(t, ind.quarterKey);
    case 'year_start':
      return ind.periodStarts(t, ind.yearKey);
    case 'year_end':
      return ind.periodEnds(t, ind.yearKey);
    case 'trading_day':
      return ind.tradingDay(t);
    case 'trading_days_left':
      return ind.tradingDaysLeft(t);
  }
}

/**
 * Evaluates expressions over an asset's bars. Numbers and conditions are both number arrays; a
 * condition is 1 (holds), 0 (does not) or NaN (unknown: an indicator still warming up, or another
 * ticker with no bar yet). Unknown follows three-valued logic and never triggers a rule.
 */
export class Evaluator {
  private data: Map<string, Bars>;
  private apart: Apart | undefined;
  private shared: string | undefined;
  private memo = new Map<string, number[]>();
  private alignments = new Map<string, number[]>();

  /**
   * `apart` names the series a rule reads one bar early (clocksApart); without it every series is read by bar end. With
   * `shared`, the apartKey that `apart` was made with, indicator series are shared with other Evaluators on the same prices.
   */
  constructor(data: Map<string, Bars>, apart?: Apart, shared?: string) {
    this.data = data;
    this.apart = apart;
    this.shared = shared;
  }

  eval(e: Expr, asset: string): number[] {
    const key = asset + '\u0000' + JSON.stringify(e);
    let out = this.memo.get(key);
    if (!out) {
      // Only an indicator is kept for other runs: they read the same ones, while each variant compares them its own way.
      out =
        e.k === 'ind' && this.shared !== undefined
          ? priceMemo.get(this.data, `ind\u0000${key}\u0000${this.shared}`, () => this.compute(e, asset), (v) => v.length)
          : this.compute(e, asset);
      this.memo.set(key, out);
    }
    return out;
  }

  /**
   * A rule that may read the open position. Parts that do not are still evaluated once over the
   * whole series; only the rest is worked out bar by bar.
   */
  compile(e: Expr, asset: string): BarRule {
    if (!findPos(e)) {
      const values = this.eval(e, asset);
      return (i) => values[i];
    }
    switch (e.k) {
      case 'pos':
        if (e.name === 'bars_held') return (i, p) => (p ? i - p.entryIdx : NaN);
        if (e.name === 'last_entry_price') return (_, p) => (p ? (p.lastPrice ?? p.entryPrice) : NaN);
        if (e.name === 'entries_made') return (_, p) => (p ? (p.entries ?? 1) : NaN);
        if (e.name === 'position_return') {
          const c = this.bars(asset).c;
          return (i, p) => (p ? (p.short ? 1 - c[i] / p.entryPrice : c[i] / p.entryPrice - 1) : NaN);
        }
        if (e.name === 'highest_since_entry' || e.name === 'lowest_since_entry') return this.sinceEntry(asset, e.name === 'highest_since_entry');
        return (_, p) => (p ? p.entryPrice : NaN);
      case 'math': {
        const a = this.compile(e.args[0], asset);
        if (e.fn === 'abs') return (i, p) => Math.abs(a(i, p));
        const fn = e.fn;
        if (fn === 'sqrt' || fn === 'log' || fn === 'exp') return (i, p) => unary(fn, a(i, p));
        const b = this.compile(e.args[1], asset);
        if (fn === 'if') {
          const c = this.compile(e.args[2], asset);
          return (i, p) => choose(a(i, p), b(i, p), c(i, p));
        }
        return e.fn === 'min' ? (i, p) => Math.min(a(i, p), b(i, p)) : (i, p) => Math.max(a(i, p), b(i, p));
      }
      case 'bin': {
        const [a, b, op] = [this.compile(e.a, asset), this.compile(e.b, asset), e.op];
        return (i, p) => arith(op, a(i, p), b(i, p));
      }
      case 'neg': {
        const a = this.compile(e.a, asset);
        return (i, p) => -a(i, p);
      }
      case 'cmp': {
        const [a, b, op] = [this.compile(e.a, asset), this.compile(e.b, asset), e.op];
        // A cross reads the previous bar with the same position, so "bars held" is one less there.
        const crosses = op === 'xup' || op === 'xdn' || op === 'xany';
        return (i, p) => compare(op, a(i, p), b(i, p), crosses && i > 0 ? a(i - 1, p) : NaN, crosses && i > 0 ? b(i - 1, p) : NaN);
      }
      case 'logic': {
        const [a, b, op] = [this.compile(e.a, asset), this.compile(e.b, asset), e.op];
        return (i, p) => logic(op, a(i, p), b(i, p));
      }
      case 'not': {
        const a = this.compile(e.a, asset);
        return (i, p) => 1 - a(i, p);
      }
    }
    // The parser keeps position values out of lags, "of" and indicator inputs.
    throw new Error(`Position values can't be used inside ${e.k}`);
  }

  /**
   * The highest high (or lowest low) since the position's first entry, read at bar `i`: the entry's price before slippage, then
   * each bar's range from the bar it filled at, whose range counts only when it filled at that bar's open. It is what the
   * trailing stop's high-water mark holds. A position's bars are read one after another, so it keeps the running value.
   */
  private sinceEntry(asset: string, highest: boolean): BarRule {
    const bars = this.bars(asset);
    const range = highest ? bars.h : bars.l;
    let entry = -1;
    let atClose = false;
    let upto = -1;
    let value = NaN;
    return (i, p) => {
      if (!p || i < p.entryIdx) return NaN;
      const first = p.entryIdx + (p.atClose ? 1 : 0);
      if (p.entryIdx !== entry || !!p.atClose !== atClose || i < upto) {
        [entry, atClose, upto] = [p.entryIdx, !!p.atClose, first - 1];
        value = (p.atClose ? bars.c : bars.o)[p.entryIdx];
      }
      for (let j = upto + 1; j <= i; j++) value = highest ? Math.max(value, range[j]) : Math.min(value, range[j]);
      upto = Math.max(upto, i);
      return value;
    };
  }

  /** The index of `other`'s bar that `of` reads for `asset`'s bar `i`; -1 when none had ended. */
  barOf(other: string, asset: string, i: number): number {
    if (i < 0) return -1;
    return other === asset ? i : this.aligned(other, asset)[i];
  }

  /**
   * Indices into `from`'s bars for each bar of `to`: the latest that had ended by the end of `to`'s bar (alignByEnd), or
   * by its start for series read one bar early (clocksApart). A file of dated values ends its rows by valueEnds.
   */
  private aligned(from: string, to: string): number[] {
    const key = `${from}\u0000${to}`;
    let at = this.alignments.get(key);
    if (!at) {
      const [f, t] = [this.bars(from), this.bars(to)];
      this.alignments.set(key, (at = ind.endedBy(f.t, this.apart?.(from, to) ? t.t : rowEnds(t), rowEnds(f))));
    }
    return at;
  }

  /** Whether `e`, worked out for `asset`, reads another series one bar early (clocksApart). */
  private readsEarly(e: Expr, asset: string): boolean {
    if (e.k === 'of') return e.asset !== asset && !!this.apart?.(e.asset, asset);
    return children(e).some((c) => this.readsEarly(c, asset));
  }

  private bars(asset: string): Bars {
    const b = this.data.get(asset);
    if (!b) throw new Error(`No data for ${asset}`);
    return b;
  }

  private compute(e: Expr, asset: string): number[] {
    const bars = this.bars(asset);
    const n = bars.t.length;
    const each = (fn: (i: number) => number): number[] => {
      const out = new Array<number>(n);
      for (let i = 0; i < n; i++) out[i] = fn(i);
      return out;
    };
    switch (e.k) {
      case 'num':
        return each(() => e.v);
      case 'bool':
        return each(() => (e.v ? 1 : 0));
      case 'series':
        if (bars.unpriced) throw new Error(`${asset} has no prices, only columns, so its ${e.name} can't be read. Read a column with column(name) of ${asset}.`);
        return { open: bars.o, high: bars.h, low: bars.l, close: bars.c, volume: bars.v }[e.name];
      case 'ind':
        return this.indicator(e, asset, bars);
      case 'cal':
        return calendar(e.name, bars.t);
      case 'column':
        return this.column(asset, e.name, bars);
      case 'pos':
        throw new Error('Position values need a position: use compile()');
      case 'math': {
        const a = this.eval(e.args[0], asset);
        if (e.fn === 'abs') return each((i) => Math.abs(a[i]));
        const fn = e.fn;
        if (fn === 'sqrt' || fn === 'log' || fn === 'exp') return each((i) => unary(fn, a[i]));
        const b = this.eval(e.args[1], asset);
        if (fn === 'if') {
          const c = this.eval(e.args[2], asset);
          return each((i) => choose(a[i], b[i], c[i]));
        }
        // Math.min and Math.max already give NaN when either side is NaN.
        return each((i) => (e.fn === 'min' ? Math.min(a[i], b[i]) : Math.max(a[i], b[i])));
      }
      case 'bin': {
        const a = this.eval(e.a, asset);
        const b = this.eval(e.b, asset);
        return each((i) => arith(e.op, a[i], b[i]));
      }
      case 'neg': {
        const a = this.eval(e.a, asset);
        return each((i) => -a[i]);
      }
      case 'cmp': {
        const a = this.eval(e.a, asset);
        const b = this.eval(e.b, asset);
        return each((i) => compare(e.op, a[i], b[i], i > 0 ? a[i - 1] : NaN, i > 0 ? b[i - 1] : NaN));
      }
      case 'logic': {
        const a = this.eval(e.a, asset);
        const b = this.eval(e.b, asset);
        return each((i) => logic(e.op, a[i], b[i]));
      }
      case 'not': {
        const a = this.eval(e.a, asset);
        return each((i) => 1 - a[i]);
      }
      case 'lag':
        return ind.lag(this.eval(e.a, asset), e.n);
      case 'of': {
        if (e.asset === asset) return this.eval(e.a, asset);
        // The other ticker's value from its latest bar that had ended when this asset's bar ended.
        const values = this.eval(e.a, e.asset);
        const at = this.aligned(e.asset, asset);
        return each((i) => (at[i] < 0 ? NaN : values[at[i]]));
      }
    }
  }

  /** A column of a CSV file by name, or an error that says what the file has instead. */
  private column(asset: string, name: string, bars: Bars): number[] {
    const found = bars.columns?.find((c) => c.name === name);
    if (found) return found.v;
    const unread = bars.unread?.find((u) => u.name === name);
    if (unread) throw new Error(`The CSV file ${asset} can't give the column ${name}: ${unread.why}.`);
    const have = bars.columns?.map((c) => c.name) ?? [];
    throw new Error(
      `The CSV file ${asset} has no column called ${name}. ${have.length ? `Its columns are ${have.join(', ')}.` : 'It has no columns besides its prices.'} Only a column with numbers in it can be read.`,
    );
  }

  private indicator(e: Extract<Expr, { k: 'ind' }>, asset: string, bars: Bars): number[] {
    // `sma(column(x), 5) of file` reads only the column; anything that reads the file's own prices has none to read.
    if (bars.unpriced && (e.src === null || OWN_PRICES.includes(e.fn))) {
      throw new Error(`${asset} has no prices, only columns, so ${e.fn}() can't be worked out for it. Read a column with column(name) of ${asset}.`);
    }
    const src = e.src ? this.eval(e.src, asset) : bars.c;
    const [a, b, c] = e.args;
    if (NEEDS_VOLUME.includes(e.fn) && !bars.v.some((x) => x > 0)) {
      throw new Error(`${asset} has no volume, which ${e.fn}() needs. A FRED series and some indexes have none, and a CSV file needs a volume column.`);
    }
    switch (e.fn) {
      case 'sma':
        return ind.sma(src, a);
      case 'ema':
        return ind.ema(src, a);
      case 'rsi':
        return ind.rsi(src, a);
      case 'roc':
        return ind.roc(src, a);
      case 'stdev':
        return ind.stdev(src, a);
      case 'highest':
        return ind.highest(src, a);
      case 'lowest':
        return ind.lowest(src, a);
      case 'atr':
        return ind.atr(bars.h, bars.l, bars.c, a);
      case 'macd':
        return ind.macd(src, a, b);
      case 'macd_signal':
        return ind.ema(ind.macd(src, a, b), c);
      case 'bb_upper':
      case 'bb_lower': {
        const mid = ind.sma(src, a);
        const sd = ind.stdev(src, a);
        const sign = e.fn === 'bb_upper' ? b : -b;
        return mid.map((m, i) => m + sign * sd[i]);
      }
      case 'wma':
        return ind.wma(src, a);
      case 'hma':
        return ind.hma(src, a);
      case 'median':
        return ind.median(src, a);
      case 'zscore':
        return ind.zscore(src, a);
      case 'percent_rank':
        return ind.percentRank(src, a);
      case 'slope':
        return ind.slope(src, a);
      // The other series was read through `of`, so it is already lined up with this ticker's bars. Read a bar early
      // (clocksApart), its change at a bar is the one up to the start of that bar, so this ticker's closes are taken a bar
      // early too: both changes then cover the same time, and are known at a fill at that bar's close.
      case 'correl':
        return ind.correl(this.readsEarly(e.src!, asset) ? ind.lag(bars.c, 1) : bars.c, src, a);
      case 'bars_since':
        return ind.barsSince(src);
      case 'count':
        return ind.count(src, a);
      case 'stoch_k':
        return ind.stochK(bars.h, bars.l, bars.c, a, b);
      case 'stoch_d':
        return ind.stochD(bars.h, bars.l, bars.c, a, b, c);
      case 'adx':
        return ind.adx(bars.h, bars.l, bars.c, a);
      case 'plus_di':
        return ind.plusDi(bars.h, bars.l, bars.c, a);
      case 'minus_di':
        return ind.minusDi(bars.h, bars.l, bars.c, a);
      case 'cci':
        return ind.cci(bars.h, bars.l, bars.c, a);
      case 'williams_r':
        return ind.williamsR(bars.h, bars.l, bars.c, a);
      case 'mfi':
        return ind.mfi(bars.h, bars.l, bars.c, bars.v, a);
      case 'obv':
        return ind.obv(bars.c, bars.v);
      case 'vwap':
        return ind.vwap(bars.h, bars.l, bars.c, bars.v, a);
      case 'keltner_upper':
      case 'keltner_lower': {
        const mid = ind.ema(src, a);
        const range = ind.atr(bars.h, bars.l, bars.c, c);
        const sign = e.fn === 'keltner_upper' ? b : -b;
        return mid.map((m, i) => m + sign * range[i]);
      }
      case 'supertrend':
        return ind.supertrend(bars.h, bars.l, bars.c, a, b).line;
      case 'supertrend_up':
        return ind.supertrend(bars.h, bars.l, bars.c, a, b).up;
      case 'sum':
        return ind.sum(src, a);
      case 'dema':
        return ind.dema(src, a);
      case 'tema':
        return ind.tema(src, a);
      case 'kama':
        return ind.kama(src, a, b, c);
      case 'aroon_up':
        return ind.aroonUp(bars.h, a);
      case 'aroon_down':
        return ind.aroonDown(bars.l, a);
      case 'psar':
        return ind.psar(bars.h, bars.l, bars.c, a, b);
      case 'cmf':
        return ind.cmf(bars.h, bars.l, bars.c, bars.v, a);
      case 'linreg':
        return ind.linreg(src, a);
      case 'rsquared':
        return ind.rsquared(src, a);
      case 'efficiency':
        return ind.efficiency(src, a);
      case 'streak':
        return ind.streak(src);
    }
    throw new Error(`Unknown function ${e.fn}`);
  }
}
