// Statistics beyond the headline tiles: calendar-period returns, downside-adjusted ratios and time under water.
// All functions take an equity series as `t` (epoch ms, ascending) and `equity` (same length, at least 2 points).
// periodReturns and deepStats also take a series that starts with NaN (a benchmark whose prices start
// later) and measure it from its first value.

import { maxDrawdown, NOISE } from './backtest.ts';
import { DAY, YEAR } from './format.ts';

/** Daily data starts and ends a few days inside a period (weekends, holidays); that still counts as covering it. */
const GRACE = 4 * DAY;

export interface PeriodReturn {
  /** "2024" or "2024-03" */
  key: string;
  /** UTC start of the period */
  t: number;
  ret: number;
  /** The data does not cover the whole period. */
  partial: boolean;
}

/**
 * Return of each calendar year or month. A period's return is measured from the last equity value before it
 * (or the series' first value) to its own last value. A first period that holds only the series' first point
 * has no return of its own and is left out.
 */
export function periodReturns(t: number[], equity: number[], period: 'year' | 'month'): PeriodReturn[] {
  const s = firstValue(equity);
  [t, equity] = [t.slice(s), equity.slice(s)];
  const out: PeriodReturn[] = [];
  const n = t.length;
  for (let i = 0; i < n; ) {
    const d = new Date(t[i]);
    const y = d.getUTCFullYear();
    const m = period === 'year' ? 0 : d.getUTCMonth();
    const start = Date.UTC(y, m, 1);
    const end = period === 'year' ? Date.UTC(y + 1, 0, 1) : Date.UTC(y, m + 1, 1);
    let j = i;
    while (j + 1 < n && t[j + 1] < end) j++;
    if (i > 0 || j > 0) {
      out.push({
        key: period === 'year' ? String(y) : `${y}-${String(m + 1).padStart(2, '0')}`,
        t: start,
        ret: equity[j] / equity[i > 0 ? i - 1 : 0] - 1,
        partial: (i === 0 && t[0] - start > GRACE) || (j === n - 1 && end - t[n - 1] > GRACE),
      });
    }
    i = j + 1;
  }
  return out;
}

/**
 * Annualised mean return above cash over annualised downside deviation (steps below cash), using steps
 * per year inferred from the data: the same figure as computeStats' sortino. `cashReturn[i]` is what
 * cash earned from point i - 1 to i; without it cash earns nothing. 0 when there is no downside
 * beyond rounding noise.
 */
export function sortino(t: number[], equity: number[], cashReturn?: number[]): number {
  const steps = equity.length - 1;
  let sum = 0;
  let downside = 0;
  for (let i = 1; i < equity.length; i++) {
    const r = equity[i] / equity[i - 1] - 1 - (cashReturn?.[i] ?? 0);
    sum += r;
    if (r < 0) downside += r * r;
  }
  const dev = Math.sqrt(downside / steps);
  if (dev < NOISE) return 0;
  const perYear = steps / ((t[t.length - 1] - t[0]) / YEAR);
  return (sum / steps / dev) * Math.sqrt(perYear);
}

/** Return per year divided by the worst drawdown's size. 0 when there is no drawdown. */
export function calmar(t: number[], equity: number[]): number {
  const worst = maxDrawdown(equity);
  if (worst === 0) return 0;
  const years = (t[t.length - 1] - t[0]) / YEAR;
  const perYear = (equity[equity.length - 1] / equity[0]) ** (1 / years) - 1;
  return perYear / -worst;
}

/** Return over the trailing `windowDays` calendar days, at every point that has that much history (uses the last point at or before t − window). */
export function rollingReturns(t: number[], equity: number[], windowDays: number): { t: number[]; ret: number[] } {
  const out = { t: [] as number[], ret: [] as number[] };
  let base = 0;
  for (let i = 0; i < t.length; i++) {
    const target = t[i] - windowDays * DAY;
    if (target < t[0]) continue;
    while (base + 1 < t.length && t[base + 1] <= target) base++;
    out.t.push(t[i]);
    out.ret.push(equity[i] / equity[base] - 1);
  }
  return out;
}

export interface Underwater {
  longestDays: number;
  longestFrom: number | null;
  /** null = still under water at the end */
  longestTo: number | null;
  /** 0 when at a new high at the end */
  currentDays: number;
}

/** Longest stretch below a previous high, in calendar days, from the last point at that high to the first point back at it. */
export function underwater(t: number[], equity: number[]): Underwater {
  const res: Underwater = { longestDays: 0, longestFrom: null, longestTo: null, currentDays: 0 };
  let peak = equity[0];
  let peakT = t[0];
  let below = false;
  for (let i = 1; i < equity.length; i++) {
    if (equity[i] < peak) {
      below = true;
      continue;
    }
    const days = (t[i] - peakT) / DAY;
    if (below && days > res.longestDays) Object.assign(res, { longestDays: days, longestFrom: peakT, longestTo: t[i] });
    below = false;
    peak = equity[i];
    peakT = t[i];
  }
  if (below) {
    res.currentDays = (t[t.length - 1] - peakT) / DAY;
    if (res.currentDays > res.longestDays) Object.assign(res, { longestDays: res.currentDays, longestFrom: peakT, longestTo: null });
  }
  return res;
}

export interface DeepStats {
  sortino: number;
  calmar: number;
  bestYear: PeriodReturn | null;
  worstYear: PeriodReturn | null;
  /** Fraction of months with a gain; NaN when no months. */
  positiveMonths: number;
  months: number;
  underwater: Underwater;
  bestMonth: PeriodReturn | null;
  worstMonth: PeriodReturn | null;
}

function extremes(list: PeriodReturn[]): [PeriodReturn | null, PeriodReturn | null] {
  let best: PeriodReturn | null = null;
  let worst: PeriodReturn | null = null;
  for (const p of list) {
    if (!best || p.ret > best.ret) best = p;
    if (!worst || p.ret < worst.ret) worst = p;
  }
  return [best, worst];
}

/** Where the series has its first value. */
function firstValue(equity: number[]): number {
  let s = 0;
  while (s < equity.length && Number.isNaN(equity[s])) s++;
  return s;
}

/** `cashReturn`, aligned with `t`, makes the Sortino ratio measure returns above cash. */
export function deepStats(t: number[], equity: number[], cashReturn?: number[]): DeepStats {
  const s = firstValue(equity);
  [t, equity, cashReturn] = [t.slice(s), equity.slice(s), cashReturn?.slice(s)];
  const years = periodReturns(t, equity, 'year');
  const full = years.filter((y) => !y.partial);
  const months = periodReturns(t, equity, 'month');
  const [bestYear, worstYear] = extremes(full.length > 0 ? full : years);
  const [bestMonth, worstMonth] = extremes(months);
  return {
    sortino: sortino(t, equity, cashReturn),
    calmar: calmar(t, equity),
    bestYear,
    worstYear,
    positiveMonths: months.length > 0 ? months.filter((m) => m.ret > 0).length / months.length : NaN,
    months: months.length,
    underwater: underwater(t, equity),
    bestMonth,
    worstMonth,
  };
}
