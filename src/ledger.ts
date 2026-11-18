// What a block has been through: every variant of it that was run (its trials, which the deflated Sharpe ratio counts)
// and every version of its text. One record per block, kept in the plugin's folder by a JsonStore.

import type { Spec } from './dsl.ts';
import { perStep } from './overfit.ts';
import { hash, stable } from './result-cache.ts';
import { lookbackBars } from './runner.ts';

/** A trial's annualised Sharpe ratio as computeStats gives it, the run's steps a year, and when it was first run. */
export type Trial = [sharpeAnnual: number, perYear: number, firstSeen: number];

/** A version's headline figures; null where a figure was not a number. */
export interface VersionFigures {
  cagr: number | null;
  maxDrawdown: number | null;
  sharpe: number | null;
  trades: number;
}

export interface Version {
  /** Of the text and the defaults together. */
  hash: string;
  text: string;
  /** Of the default settings the text was run with, which fill in what the text leaves out. */
  defaults: string;
  /** When the version was first run. */
  at: number;
  figures: VersionFigures;
}

export interface Ledger {
  /** By trial hash. */
  trials: Record<string, Trial>;
  /** Runs counted since the count was last started again, a variant run twice counting twice. */
  total: number;
  /** Oldest first. */
  versions: Version[];
  /** When the count was last started again; 0 for never. Trials first seen before it are not counted. */
  resetAt: number;
}

/** Versions kept besides the very first. */
export const MAX_VERSIONS = 100;

export function emptyLedger(): Ledger {
  return { trials: {}, total: 0, versions: [], resetAt: 0 };
}

const hashText = (text: string) => hash(text).toString(36);

/**
 * A variant's identity: two specs that trade alike hash alike. Left out are what only labels or reports a run (its
 * name, `test from`, which only splits the figures, the rules as written) and which parameter a number came from
 * (the declared parameters, `params` on indicators, `param` on lags, `nParam` on stops and sizing), since a parameter
 * set to 20 trades as the number 20 does. With a `from` date, the history loaded before it is kept in: it covers the
 * widest value of each parameter's range, and recursive averages such as an EMA depend on where they started.
 */
export function trialHash(spec: Spec): string {
  const { written: _written, name: _name, testFrom: _testFrom, params: _params, ...trading } = spec;
  return hashText(stable([withoutParamNames(trading), spec.from === null ? null : lookbackBars(spec)]));
}

function withoutParamNames(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutParamNames);
  if (value === null || typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(node)) {
    if (key === 'nParam' || (key === 'params' && node.k === 'ind') || (key === 'param' && node.k === 'lag')) continue;
    out[key] = withoutParamNames(node[key]);
  }
  return out;
}

export function defaultsHash(defaults: unknown): string {
  return hashText(stable(defaults));
}

/** A version's identity: its text, and the defaults that fill in what the text leaves out. */
export function versionHash(text: string, defaults: unknown): string {
  return hashText(`${stable(defaults)}\u0000${text}`);
}

/** Counts a run. A run whose Sharpe ratio or steps a year is not a number is not counted, and the record is returned as it was. */
export function addTrial(ledger: Ledger, trial: string, sharpeAnnual: number, perYear: number, at: number): Ledger {
  if (!Number.isFinite(sharpeAnnual) || !(Number.isFinite(perYear) && perYear > 0)) return ledger;
  const known = Object.hasOwn(ledger.trials, trial) ? ledger.trials[trial] : null;
  return {
    ...ledger,
    trials: { ...ledger.trials, [trial]: [sharpeAnnual, perYear, known ? known[2] : at] },
    total: ledger.total + 1,
  };
}

const figure = (x: number) => (Number.isFinite(x) ? x : null);

/** Adds a version not seen before; a version already there keeps when it was first run, and the record is returned as it was. */
export function addVersion(
  ledger: Ledger,
  v: { text: string; defaults: unknown; at: number; figures: { cagr: number; maxDrawdown: number; sharpe: number; trades: number } },
): Ledger {
  const id = versionHash(v.text, v.defaults);
  if (ledger.versions.some((x) => x.hash === id)) return ledger;
  const { cagr, maxDrawdown, sharpe, trades } = v.figures;
  const added: Version = {
    hash: id,
    text: v.text,
    defaults: defaultsHash(v.defaults),
    at: v.at,
    figures: { cagr: figure(cagr), maxDrawdown: figure(maxDrawdown), sharpe: figure(sharpe), trades },
  };
  return { ...ledger, versions: capVersions(sortVersions([...ledger.versions, added])) };
}

/** Starts the count of trials again from `at`. The versions stay. */
export function resetTrials(ledger: Ledger, at: number): Ledger {
  return { ...ledger, trials: {}, total: 0, resetAt: Math.max(at, ledger.resetAt) };
}

function sortVersions(versions: Version[]): Version[] {
  return versions.sort((a, b) => a.at - b.at || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
}

/** The very first version and the latest MAX_VERSIONS others. */
function capVersions(versions: Version[]): Version[] {
  return versions.length <= MAX_VERSIONS + 1 ? versions : [versions[0], ...versions.slice(-MAX_VERSIONS)];
}

/**
 * One record from the copy on disk and this session's, for JsonStore: every trial and version either holds, by hash,
 * less the trials first seen before the later of the two resets. A trial in both keeps its earliest first sight and
 * this session's figures; a version in both keeps its earliest. The total is the one counted since the later reset.
 */
export function mergeLedgers(disk: Ledger, mine: Ledger): Ledger {
  const resetAt = Math.max(disk.resetAt, mine.resetAt);
  const both = new Map(Object.entries(disk.trials));
  for (const [id, t] of Object.entries(mine.trials)) {
    const other = both.get(id);
    both.set(id, other ? [t[0], t[1], Math.min(t[2], other[2])] : t);
  }
  const trials = Object.fromEntries([...both].filter(([, t]) => t[2] >= resetAt));
  const byHash = new Map<string, Version>();
  for (const v of [...mine.versions, ...disk.versions]) {
    const other = byHash.get(v.hash);
    if (!other || v.at < other.at) byHash.set(v.hash, v);
  }
  const counted = disk.resetAt === mine.resetAt ? Math.max(disk.total, mine.total) : disk.resetAt > mine.resetAt ? disk.total : mine.total;
  return {
    trials,
    total: Math.max(counted, Object.keys(trials).length),
    versions: capVersions(sortVersions([...byHash.values()])),
    resetAt,
  };
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isCount = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;
const isFigure = (x: unknown): x is number | null => x === null || isNumber(x);
const HASH = /^[0-9a-z]{1,11}$/;

/** A record read from a file, or null when it is not one. Only the fields a record has are kept. */
export function parseLedger(raw: unknown): Ledger | null {
  if (!isObject(raw) || !isObject(raw.trials) || !isCount(raw.total) || !Array.isArray(raw.versions) || !isNumber(raw.resetAt) || raw.resetAt < 0) return null;
  const trials: [string, Trial][] = [];
  for (const [id, t] of Object.entries(raw.trials)) {
    if (!HASH.test(id) || !Array.isArray(t) || t.length !== 3 || !t.every(isNumber) || !(t[1] > 0)) return null;
    trials.push([id, [t[0], t[1], t[2]]]);
  }
  const versions: Version[] = [];
  for (const v of raw.versions) {
    if (!isObject(v) || typeof v.hash !== 'string' || !HASH.test(v.hash) || typeof v.text !== 'string') return null;
    if (typeof v.defaults !== 'string' || !HASH.test(v.defaults) || !isNumber(v.at) || !isObject(v.figures)) return null;
    const f = v.figures;
    if (!isFigure(f.cagr) || !isFigure(f.maxDrawdown) || !isFigure(f.sharpe) || !isCount(f.trades)) return null;
    versions.push({ hash: v.hash, text: v.text, defaults: v.defaults, at: v.at, figures: { cagr: f.cagr, maxDrawdown: f.maxDrawdown, sharpe: f.sharpe, trades: f.trades } });
  }
  return { trials: Object.fromEntries(trials), total: raw.total, versions, resetAt: raw.resetAt };
}

/**
 * The deflated Sharpe ratio's inputs from a record: N, the distinct trials, and V, the variance of their Sharpe ratios
 * per step of a run with `perYear` steps a year, so trials on other bar sizes compare through their annual figures.
 * V is the sample variance (over N − 1); 0 with fewer than 2 trials.
 */
export function trialSpread(ledger: Ledger, perYear: number): { trials: number; variance: number } {
  const srs = Object.values(ledger.trials).map((t) => perStep(t[0], perYear));
  const n = srs.length;
  if (n < 2) return { trials: n, variance: 0 };
  const mean = srs.reduce((s, x) => s + x, 0) / n;
  return { trials: n, variance: srs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) };
}

export type DiffLine = { op: 'same' | 'added' | 'removed'; text: string };

/**
 * The lines of `after` against those of `before` by longest common subsequence: lines kept, added and removed, in
 * order, a removed line before the line that replaced it. Lines end at \n or \r\n.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  // lcs[i * w + j]: the longest common subsequence of x from i on and y from j on.
  const w = y.length + 1;
  const lcs = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ op: 'same', text }));
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push({ op: 'same', text: x[i++] });
      j++;
    } else if (j >= y.length || (i < x.length && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
      out.push({ op: 'removed', text: x[i++] });
    } else {
      out.push({ op: 'added', text: y[j++] });
    }
  }
  for (const text of a.slice(a.length - tail)) out.push({ op: 'same', text });
  return out;
}
