import { children, findPos, type CalName, type CmpOp, type Expr, type Spec } from './dsl.ts';
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
  const sources = new Map<string, string>();
  const refs = [...spec.universe, ...spec.extras, ...(spec.benchmark ? [spec.benchmark] : []), ...(spec.cash.k === 'ticker' ? [spec.cash.ref] : [])];
  for (const r of refs) if (!sources.has(r.name)) sources.set(r.name, r.source);
  const clocks = new Map<string, string>();
  const clock = (name: string) => {
    let c = clocks.get(name);
    if (c === undefined) clocks.set(name, (c = ind.clockOf(sources.get(name) ?? '?', data.get(name)?.t ?? [])));
    return c;
  };
  return (from, to) => clock(from) !== clock(to);
}

/** The Evaluator a spec's rules are read with, by the run and by everything that explains or redoes it. */
export function specEvaluator(spec: Spec, data: Map<string, Bars>): Evaluator {
  return new Evaluator(data, clocksApart(spec, data));
}

/** Every [reader, read] pair of tickers that a spec's rules and ranking score connect with `of`, nested ones included. */
export function ofReads(spec: Spec): [string, string][] {
  const out = new Map<string, [string, string]>();
  const visit = (e: Expr, asset: string): void => {
    if (e.k === 'of' && e.asset !== asset) out.set(`${asset}\u0000${e.asset}`, [asset, e.asset]);
    for (const c of children(e)) visit(c, e.k === 'of' ? e.asset : asset);
  };
  for (const a of spec.universe) {
    const r = spec.rules[a.name];
    for (const e of [r.buy, r.sell, spec.rank?.by]) if (e) visit(e, a.name);
  }
  return [...out.values()];
}

/** The open position a sell rule reads: where it was bought, as an index into the asset's bars, and at what fill price. */
export interface PosState {
  entryIdx: number;
  entryPrice: number;
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
  }
}

function logic(op: 'and' | 'or', a: number, b: number): number {
  if (op === 'and') return a === 0 || b === 0 ? 0 : a === 1 && b === 1 ? 1 : NaN;
  return a === 1 || b === 1 ? 1 : a === 0 && b === 0 ? 0 : NaN;
}

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
  private memo = new Map<string, number[]>();
  private alignments = new Map<string, number[]>();

  /** `apart` names the series a rule reads one bar early (clocksApart); without it every series is read by bar end. */
  constructor(data: Map<string, Bars>, apart?: Apart) {
    this.data = data;
    this.apart = apart;
  }

  eval(e: Expr, asset: string): number[] {
    const key = asset + '\u0000' + JSON.stringify(e);
    let out = this.memo.get(key);
    if (!out) {
      out = this.compute(e, asset);
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
        return (_, p) => (p ? p.entryPrice : NaN);
      case 'math': {
        const a = this.compile(e.args[0], asset);
        if (e.fn === 'abs') return (i, p) => Math.abs(a(i, p));
        const b = this.compile(e.args[1], asset);
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
        const crosses = op === 'xup' || op === 'xdn';
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

  /** The index of `other`'s bar that `of` reads for `asset`'s bar `i`; -1 when none had ended. */
  barOf(other: string, asset: string, i: number): number {
    if (i < 0) return -1;
    return other === asset ? i : this.aligned(other, asset)[i];
  }

  /** Indices into `from`'s bars for each bar of `to`: see alignByEnd, and clocksApart for series read one bar early. */
  private aligned(from: string, to: string): number[] {
    const key = `${from}\u0000${to}`;
    let at = this.alignments.get(key);
    if (!at) {
      const [f, t] = [this.bars(from).t, this.bars(to).t];
      this.alignments.set(key, (at = this.apart?.(from, to) ? ind.endedBy(f, t) : ind.alignByEnd(f, t)));
    }
    return at;
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
        return { open: bars.o, high: bars.h, low: bars.l, close: bars.c, volume: bars.v }[e.name];
      case 'ind':
        return this.indicator(e, asset, bars);
      case 'cal':
        return calendar(e.name, bars.t);
      case 'pos':
        throw new Error('Position values need a position: use compile()');
      case 'math': {
        const a = this.eval(e.args[0], asset);
        if (e.fn === 'abs') return each((i) => Math.abs(a[i]));
        const b = this.eval(e.args[1], asset);
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

  private indicator(e: Extract<Expr, { k: 'ind' }>, asset: string, bars: Bars): number[] {
    const src = e.src ? this.eval(e.src, asset) : bars.c;
    const [a, b, c] = e.args;
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
    }
    throw new Error(`Unknown function ${e.fn}`);
  }
}
