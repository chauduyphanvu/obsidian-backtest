import type { Bars } from '../src/types.ts';

export const DAY = 86_400_000;
export const T0 = Date.UTC(2020, 0, 1);

/** Daily bars from closes, or bars at the given `times`; open equals the previous close unless given. */
export function bars(closes: number[], opts: { opens?: number[]; highs?: number[]; lows?: number[]; start?: number; step?: number; times?: number[] } = {}): Bars {
  const o = opts.opens ?? closes.map((c, i) => (i === 0 ? c : closes[i - 1]));
  return {
    t: opts.times ?? closes.map((_, i) => (opts.start ?? T0) + i * (opts.step ?? DAY)),
    o,
    h: opts.highs ?? closes.map((c, i) => Math.max(c, o[i])),
    l: opts.lows ?? closes.map((c, i) => Math.min(c, o[i])),
    c: closes,
    v: closes.map(() => 1000),
  };
}

export function near(actual: number, expected: number, eps = 1e-9): boolean {
  return Math.abs(actual - expected) <= eps;
}
