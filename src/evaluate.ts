import { findPos, type CalName, type CmpOp, type Expr } from './dsl.ts';
import type { Bars } from './types.ts';
import * as ind from './indicators.ts';

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
  private memo = new Map<string, number[]>();
  private alignments = new Map<string, number[]>();

  constructor(data: Map<string, Bars>) {
    this.data = data;
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

  /** Indices into `from`'s bars for each bar of `to`; see alignByEnd. */
  private aligned(from: string, to: string): number[] {
    const key = `${from}\u0000${to}`;
    let at = this.alignments.get(key);
    if (!at) this.alignments.set(key, (at = ind.alignByEnd(this.bars(from).t, this.bars(to).t)));
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
