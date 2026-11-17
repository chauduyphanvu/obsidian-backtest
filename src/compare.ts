// Comparing and combining strategies: the `compare` block's syntax, putting equity curves on one timeline,
// a rebalanced portfolio of them, and how alike they move. Pure; the caller loads notes and runs strategies.

import { isoDate } from './dom.ts';
import type { Diagnostic } from './dsl.ts';

export const MIN_ENTRIES = 2;
export const MAX_ENTRIES = 8;

export interface CompareEntry {
  /** The note's link text or vault path, without `#name` and alias. */
  link: string;
  /** The strategy's `name:` setting; null for the note's first strategy block. */
  block: string | null;
  label: string | null;
  /** A fraction, e.g. 0.4 for `40%`; null when the block gives no weights. */
  weight: number | null;
  /** 1-based line inside the block. */
  line: number;
}

// The lookbehind, not a leading \s+, keeps a long run of spaces from being retried at every position.
const WEIGHT_AT_END = /(?<=\s)([+-]?\d+(?:\.\d+)?\s*%)$/;
const WEIGHT = /^([+-]?\d+(?:\.\d+)?)\s*%$/;
const BARE_PATH = /^(.+?\.md)(?:#(.*))?$/i;
const EPS = 1e-9;
/** Below this the returns do not vary, apart from rounding noise. */
const FLAT = 1e-12;

const HOW_TO_WRITE = 'Write a note as [[Note name]] or [[Note name#Strategy name]], or as a vault path ending in .md';

function span(raw: string, token: string): { from: number; to: number } {
  const from = raw.lastIndexOf(token);
  return { from, to: from + token.length };
}

/** A weight such as `40%` as a fraction, or the problem with it. */
function weightOf(raw: string, line: number, token: string): number | Diagnostic {
  const m = token.match(WEIGHT);
  if (!m) return { line, message: 'After the note, only a weight such as 40% can follow', ...span(raw, token) };
  const w = Number(m[1]) / 100;
  if (!(w > 0)) return { line, message: 'A weight must be above 0%', ...span(raw, token) };
  return w;
}

function parseLine(raw: string, line: number): CompareEntry | Diagnostic {
  const text = raw.trim();
  let target: string;
  let label: string | null = null;
  let weight: number | null = null;

  if (text.startsWith('[[')) {
    const close = text.indexOf(']]');
    if (close < 0) return { line, message: 'This link has no closing ]]' };
    const inner = text.slice(2, close);
    const rest = text.slice(close + 2).trim();
    const pipe = inner.indexOf('|');
    target = pipe < 0 ? inner : inner.slice(0, pipe);
    if (pipe >= 0) label = inner.slice(pipe + 1).trim() || null;
    if (rest) {
      const w = weightOf(raw, line, rest);
      if (typeof w !== 'number') return w;
      weight = w;
    }
  } else {
    const m = text.match(WEIGHT_AT_END);
    const path = m ? text.slice(0, m.index).trimEnd() : text;
    if (m) {
      const w = weightOf(raw, line, m[1]);
      if (typeof w !== 'number') return w;
      weight = w;
    }
    if (!BARE_PATH.test(path.trim())) return { line, message: HOW_TO_WRITE };
    target = path;
  }

  const hash = target.indexOf('#');
  const link = (hash < 0 ? target : target.slice(0, hash)).trim();
  const block = hash < 0 ? null : target.slice(hash + 1).trim();
  if (!link) return { line, message: "This link doesn't name a note" };
  if (block === '') return { line, message: 'Nothing follows # in this link: name the strategy, or remove the #' };
  return { link, block, label, weight, line };
}

const duplicateKey = (e: CompareEntry) => `${e.link.replace(/\.md$/i, '').toLowerCase()}#${(e.block ?? '').toLowerCase()}`;

/** Reads the lines of a `compare` block. `entries` holds every line that parsed, even when `errors` is not empty. */
export function parseCompare(source: string): { entries: CompareEntry[]; errors: Diagnostic[] } {
  const entries: CompareEntry[] = [];
  const errors: Diagnostic[] = [];
  source.split(/\r?\n/).forEach((raw, i) => {
    const text = raw.trim();
    if (!text || text.startsWith('#')) return;
    const r = parseLine(raw, i + 1);
    if ('message' in r) errors.push(r);
    else entries.push(r);
  });

  const seen = new Map<string, number>();
  for (const e of entries) {
    const key = duplicateKey(e);
    const first = seen.get(key);
    if (first === undefined) seen.set(key, e.line);
    else errors.push({ line: e.line, message: `This strategy is already listed on line ${first}` });
  }
  if (entries.length > MAX_ENTRIES) errors.push({ line: entries[MAX_ENTRIES].line, message: `A comparison holds at most ${MAX_ENTRIES} strategies` });
  // A line that failed to parse would make these checks report problems that are not there.
  if (entries.length < MIN_ENTRIES && errors.length === 0) {
    errors.push({ line: entries.length ? entries[entries.length - 1].line : 1, message: `Add at least ${MIN_ENTRIES} strategies to compare` });
  }

  const weighted = entries.filter((e) => e.weight !== null);
  if (weighted.length > 0 && weighted.length < entries.length) {
    const odd = entries.find((e) => (e.weight === null) !== (entries[0].weight === null))!;
    errors.push({ line: odd.line, message: 'Give every strategy a weight, or none of them' });
  } else if (weighted.length > 0) {
    const sum = weighted.reduce((s, e) => s + e.weight!, 0);
    if (sum > 1 + EPS) {
      errors.push({ line: entries[entries.length - 1].line, message: `The weights add up to ${Number((sum * 100).toFixed(2))}%, and they can't add up to more than 100%` });
    }
  }
  return { entries, errors: errors.sort((a, b) => a.line - b.line) };
}

export interface Curve {
  label: string;
  /** Epoch milliseconds, ascending. */
  t: number[];
  equity: number[];
  /** What a unit of cash grew to by each time in `t`, starting at 1. Absent means cash earned nothing. */
  cash?: number[];
}

/** The growth of cash as an index starting at 1, from a run's cash return per step (`cashReturn[i]` is what cash earned from step i - 1 to i). */
export function cashIndex(cashReturn: number[]): number[] {
  const out: number[] = [];
  let level = 1;
  for (let i = 0; i < cashReturn.length; i++) {
    if (i > 0) level *= 1 + cashReturn[i];
    out.push(level);
  }
  return out;
}

export interface Aligned {
  t: number[];
  series: number[][];
  /** Each curve's cash index on `t`, rebased to 1 at the first time; all ones for a curve without cash. */
  cash: number[][];
}

/** Puts curves on one timeline: the union of their times from the latest start to the earliest end, each carried forward between its own points and rebased to 1 at the window's first time. Throws a clear Error when the curves do not overlap for at least 2 points. */
export function alignCurves(curves: Curve[]): Aligned {
  if (curves.length === 0) throw new Error('There are no strategies to compare');
  for (const c of curves) if (c.t.length === 0) throw new Error(`${c.label} has no prices to compare`);
  const last = (c: Curve) => c.t[c.t.length - 1];
  const latestStart = curves.reduce((a, c) => (c.t[0] > a.t[0] ? c : a));
  const earliestEnd = curves.reduce((a, c) => (last(c) < last(a) ? c : a));
  const start = latestStart.t[0];
  const end = last(earliestEnd);
  if (start > end) {
    throw new Error(`These strategies never overlap in time: ${latestStart.label} starts on ${isoDate(start)}, after ${earliestEnd.label} ends on ${isoDate(end)}`);
  }

  const times = [...new Set(curves.flatMap((c) => c.t.filter((t) => t >= start && t <= end)))].sort((a, b) => a - b);
  if (times.length < 2) throw new Error(`These strategies overlap on a single date, ${isoDate(start)}, which is too little to compare`);

  const carry = (c: Curve, values: number[]) => {
    let j = 0;
    const carried = times.map((t) => {
      while (j + 1 < c.t.length && c.t[j + 1] <= t) j++;
      return values[j];
    });
    return carried.map((v) => v / carried[0]);
  };
  const series = curves.map((c) => carry(c, c.equity));
  const cash = curves.map((c) => (c.cash ? carry(c, c.cash) : times.map(() => 1)));
  return { t: times, series, cash };
}

/** What cash earned over each step of the aligned timeline, per curve; the first step has none. */
export function cashReturns(aligned: Pick<Aligned, 'cash'>): number[][] {
  return aligned.cash.map((index) => index.map((v, i) => (i === 0 ? 0 : v / index[i - 1] - 1)));
}

/** The cash return of a portfolio of several curves: their cash returns averaged at the given weights, scaled so the weights add up to 1. */
export function weightedCashReturn(returns: number[][], weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  const steps = returns[0]?.length ?? 0;
  return Array.from({ length: steps }, (_, i) => (total > 0 ? returns.reduce((s, r, k) => s + r[i] * weights[k], 0) / total : 0));
}

const monthOf = (t: number) => {
  const d = new Date(t);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

/**
 * A portfolio holding the aligned curves at the given weights (fractions summing to <= 1; the rest is cash earning nothing),
 * brought back to those weights at the first point of each calendar month (UTC). Starts at 1.
 * The first point of a month is valued with the weights drifted up to it, then the portfolio is reset to its weights from there.
 */
export function combine(aligned: Pick<Aligned, 't' | 'series'>, weights: number[]): number[] {
  if (weights.length !== aligned.series.length) throw new Error('There must be one weight for each curve');
  if (weights.some((w) => !(w >= 0))) throw new Error('Weights cannot be negative');
  const invested = weights.reduce((s, w) => s + w, 0);
  if (invested > 1 + EPS) throw new Error(`Weights add up to ${Number((invested * 100).toFixed(2))}%; they cannot add up to more than 100%`);

  const { t, series } = aligned;
  const cashShare = Math.max(0, 1 - invested);
  const sleeves = [...weights];
  let cash = cashShare;
  const out = [1];
  for (let i = 1; i < t.length; i++) {
    let total = cash;
    for (let k = 0; k < sleeves.length; k++) {
      sleeves[k] *= series[k][i] / series[k][i - 1];
      total += sleeves[k];
    }
    if (monthOf(t[i]) !== monthOf(t[i - 1])) {
      for (let k = 0; k < sleeves.length; k++) sleeves[k] = weights[k] * total;
      cash = cashShare * total;
    }
    out.push(total);
  }
  return out;
}

/** Correlation of per-step returns between every pair; 1 on the diagonal; NaN when a series never moves. */
export function correlations(aligned: Pick<Aligned, 't' | 'series'>): number[][] {
  const returns = aligned.series.map((s) => s.slice(1).map((v, i) => v / s[i] - 1));
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const centered = returns.map((r) => {
    const m = mean(r);
    return r.map((x) => x - m);
  });
  const norm = centered.map((c) => Math.sqrt(c.reduce((a, x) => a + x * x, 0)));
  return centered.map((a, i) =>
    centered.map((b, j) => {
      if (i === j) return 1;
      if (norm[i] < FLAT || norm[j] < FLAT) return NaN;
      return a.reduce((s, x, n) => s + x * b[n], 0) / (norm[i] * norm[j]);
    }),
  );
}
