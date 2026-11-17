import type { Expr } from './dsl.ts';
import type { Bars } from './types.ts';
import * as ind from './indicators.ts';

/**
 * Evaluates expressions over an asset's bars. Numbers and conditions are both number arrays; a
 * condition is 1 (holds), 0 (does not) or NaN (unknown: an indicator still warming up, or another
 * ticker with no bar yet). Unknown follows three-valued logic and never triggers a rule.
 */
export class Evaluator {
  private data: Map<string, Bars>;
  private memo = new Map<string, number[]>();

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
        switch (e.op) {
          case '+':
            return each((i) => a[i] + b[i]);
          case '-':
            return each((i) => a[i] - b[i]);
          case '*':
            return each((i) => a[i] * b[i]);
          case '/':
            return each((i) => (b[i] === 0 ? NaN : a[i] / b[i]));
        }
        break;
      }
      case 'neg': {
        const a = this.eval(e.a, asset);
        return each((i) => -a[i]);
      }
      case 'cmp': {
        const a = this.eval(e.a, asset);
        const b = this.eval(e.b, asset);
        const known = (i: number) => !Number.isNaN(a[i]) && !Number.isNaN(b[i]);
        const bool = (i: number, v: boolean) => (known(i) ? (v ? 1 : 0) : NaN);
        switch (e.op) {
          case '>':
            return each((i) => bool(i, a[i] > b[i]));
          case '<':
            return each((i) => bool(i, a[i] < b[i]));
          case '>=':
            return each((i) => bool(i, a[i] >= b[i]));
          case '<=':
            return each((i) => bool(i, a[i] <= b[i]));
          case '==':
            return each((i) => bool(i, a[i] === b[i]));
          case '!=':
            return each((i) => bool(i, a[i] !== b[i]));
          case 'xup':
            return each((i) => (i > 0 && known(i) && known(i - 1) ? (a[i] > b[i] && a[i - 1] <= b[i - 1] ? 1 : 0) : NaN));
          case 'xdn':
            return each((i) => (i > 0 && known(i) && known(i - 1) ? (a[i] < b[i] && a[i - 1] >= b[i - 1] ? 1 : 0) : NaN));
        }
        break;
      }
      case 'logic': {
        const a = this.eval(e.a, asset);
        const b = this.eval(e.b, asset);
        if (e.op === 'and') return each((i) => (a[i] === 0 || b[i] === 0 ? 0 : a[i] === 1 && b[i] === 1 ? 1 : NaN));
        return each((i) => (a[i] === 1 || b[i] === 1 ? 1 : a[i] === 0 && b[i] === 0 ? 0 : NaN));
      }
      case 'not': {
        const a = this.eval(e.a, asset);
        return each((i) => 1 - a[i]);
      }
      case 'lag':
        return ind.lag(this.eval(e.a, asset), e.n);
      case 'of': {
        if (e.asset === asset) return this.eval(e.a, asset);
        // The other ticker's latest value at or before each of this asset's bars.
        const other = this.bars(e.asset);
        const values = this.eval(e.a, e.asset);
        let j = -1;
        return each((i) => {
          while (j + 1 < other.t.length && other.t[j + 1] <= bars.t[i]) j++;
          return j < 0 ? NaN : values[j];
        });
      }
    }
    throw new Error('Unhandled expression');
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
