// What a block has been through: every variant of it that was run (its trials, which the deflated Sharpe ratio counts)
// and every version of its text. One record per block, kept in the plugin's folder by a JsonStore.

import type { Backtest } from './backtest.ts';
import { blockName, withoutName } from './blocks.ts';
import type { Spec } from './dsl.ts';
import { perStep, stepsPerYear } from './overfit.ts';
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
  /** By trial hash: each variant that ran and traded, once. */
  trials: Record<string, Trial>;
  /** Oldest first. */
  versions: Version[];
  /** When the count was last started again; 0 for never. Trials first seen before it are not counted. */
  resetAt: number;
}

/** Versions kept besides the very first. */
export const MAX_VERSIONS = 100;

export function emptyLedger(): Ledger {
  return { trials: {}, versions: [], resetAt: 0 };
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
  const {
    written: _written,
    name: _name,
    testFrom: _testFrom,
    params: _params,
    mutedLines: _mutedLines,
    liveSince: _liveSince,
    invalidate: _invalidate,
    extends: _extends,
    ...trading
  } = spec;
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

/**
 * Counts a trial once. One already counted keeps the figures it was first counted with, and a run whose Sharpe ratio or
 * steps a year is not a number is not counted: either way the record is returned as it was, so drawing a block again
 * changes nothing.
 */
export function addTrial(ledger: Ledger, trial: string, sharpeAnnual: number, perYear: number, at: number): Ledger {
  if (Object.hasOwn(ledger.trials, trial) || !Number.isFinite(sharpeAnnual) || !(Number.isFinite(perYear) && perYear > 0)) return ledger;
  return { ...ledger, trials: { ...ledger.trials, [trial]: [sharpeAnnual, perYear, at] } };
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
  return { ...ledger, trials: {}, resetAt: Math.max(at, ledger.resetAt) };
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
 * less the trials first seen before the later of the two resets. A trial or version in both keeps its earlier sight;
 * for a trial, its earlier sight since that reset, so one counted again after the reset stays.
 */
export function mergeLedgers(disk: Ledger, mine: Ledger): Ledger {
  const resetAt = Math.max(disk.resetAt, mine.resetAt);
  const trials: Record<string, Trial> = {};
  for (const [id, t] of [...Object.entries(disk.trials), ...Object.entries(mine.trials)]) {
    if (t[2] < resetAt) continue;
    if (!Object.hasOwn(trials, id) || t[2] < trials[id][2]) trials[id] = t;
  }
  const byHash = new Map<string, Version>();
  for (const v of [...mine.versions, ...disk.versions]) {
    const other = byHash.get(v.hash);
    if (!other || v.at < other.at) byHash.set(v.hash, v);
  }
  return {
    trials,
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
  if (!isObject(raw) || !isObject(raw.trials) || !Array.isArray(raw.versions) || !isNumber(raw.resetAt) || raw.resetAt < 0) return null;
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
  return { trials: Object.fromEntries(trials), versions, resetAt: raw.resetAt };
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

/** One run as the block's tries count it. */
export interface TrialRun {
  hash: string;
  /** Its Sharpe ratio a year, as computeStats gives it. */
  sharpe: number;
  perYear: number;
}

/** A run shown for the block as a try; null when it never traded, since a run that stays in cash is no version of the strategy. */
export function trialOf(spec: Spec, bt: Backtest): TrialRun | null {
  if (bt.run.trades.length === 0) return null;
  return { hash: trialHash(spec), sharpe: bt.stats.sharpe, perYear: stepsPerYear(bt.run.t) };
}

/** A version not yet in the record: the block's text, the defaults it was run with, and the figures of that run. */
export interface NewVersion {
  text: string;
  defaults: unknown;
  figures: { cagr: number; maxDrawdown: number; sharpe: number; trades: number };
}

/** The figures a version is listed with, from the run of its text. */
export function versionFigures(bt: Backtest): NewVersion['figures'] {
  return { cagr: bt.stats.cagr, maxDrawdown: bt.stats.maxDrawdown, sharpe: bt.stats.sharpe, trades: bt.run.trades.length };
}

/** Where the records are kept: store.ts JsonStore. */
export interface LedgerStore {
  get(key: string): Promise<Ledger | null>;
  update(key: string, change: (current: Ledger | null) => Ledger): Promise<Ledger>;
  /** Moves the record of `from` to `to`, merged with any record `to` has. */
  rename(from: string, to: string): Promise<void>;
  renamePrefix(from: string, to: string): Promise<void>;
  /** The keys that start with `prefix` and have a record, or had one. */
  listKeys(prefix: string): Promise<string[]>;
}

/** One block's record, as the drawings of the block use it. */
export interface BlockLedger {
  /** The record as it is now; an empty one when the block has none yet. */
  read(): Promise<Ledger>;
  /** Counts the runs not counted before (null ones are not) and adds `version` when it is new. Nothing is written when nothing is new. */
  add(runs: readonly (TrialRun | null)[], version?: NewVersion): Promise<void>;
  /** Starts the count of tries again from now. */
  reset(): Promise<void>;
  /** Calls `listener` with the record after each change made through any drawing of the block; returns a function that stops it. */
  watch(listener: (ledger: Ledger) => void): () => void;
}

/**
 * Calls `draw` with the block's record now and after each change; returns what stops it. A read that finishes after a
 * change was heard is not drawn, since it may predate that change: a try counted as the drawing began stays counted.
 */
export function follow(ledger: BlockLedger, draw: (ledger: Ledger) => void): () => void {
  let heard = false;
  void ledger.read().then((l) => {
    if (!heard) draw(l);
  });
  return ledger.watch((l) => {
    heard = true;
    draw(l);
  });
}

/** Whether a record holds anything: a try or a version. */
const holdsSome = (ledger: Ledger | null): ledger is Ledger => ledger !== null && (Object.keys(ledger.trials).length > 0 || ledger.versions.length > 0);

/** Whether a record is empty or began at `since` or later: its first try and its first version are no older. */
const newSince = (ledger: Ledger | null, since: number): boolean =>
  !holdsSome(ledger) || Math.min(...Object.values(ledger.trials).map((t) => t[2]), ...ledger.versions.map((v) => v.at)) >= since;

/** A block's text as its versions are compared: without carriage returns or blank space at its end. */
export const normalText = (text: string): string => text.replace(/\r/g, '').trimEnd();

/**
 * The key a block renamed by hand left its record under, for the block with key `key` and text `text`: only when its own
 * record began at `since` or later (the start of the session, so tries made under the new name since then, such as by the
 * drawing that asks, do not hide it), and exactly one of `others` (the records under the names of its note) is the key of
 * none of the note's blocks now (`blockKeys`) and has a latest version whose text is `text` but for the `name:` line. A
 * block deleted from the note leaves its record behind too, so a record with other text is no sign of a rename. Null
 * otherwise.
 */
export function handRenamed(key: string, own: Ledger | null, others: readonly [string, Ledger | null][], blockKeys: readonly string[], since: number, text: string): string | null {
  if (!newSince(own, since)) return null;
  const now = new Set(blockKeys);
  const unnamed = withoutName(normalText(text));
  const left = others.filter(([k, ledger]) => k !== key && !now.has(k) && latestUnnamed(ledger) === unnamed);
  return left.length === 1 ? left[0][0] : null;
}

/** The text of a record's latest version without its `name:` line, as blocks are matched whatever their names; null when it has none. */
function latestUnnamed(ledger: Ledger | null): string | null {
  const latest = ledger?.versions[ledger.versions.length - 1];
  return latest === undefined ? null : withoutName(normalText(latest.text));
}

/** Whether some version of a record has `text`, but for the `name:` line: the record is that block's, not another's. */
export function holdsText(ledger: Ledger | null, text: string): boolean {
  const unnamed = withoutName(normalText(text));
  return ledger !== null && ledger.versions.some((v) => withoutName(normalText(v.text)) === unnamed);
}

/**
 * The key of the record a block with no name kept by its place `key` (render.ts blockStateKey), for the block's `text`:
 * `key` when its own record holds the text (holdsText), else the one record of `others`, the note's other places, that
 * does, as when a block was put above it since. Null when none does, or more than one.
 */
export function placeRecord(key: string, own: Ledger | null, others: readonly [string, Ledger | null][], text: string): string | null {
  if (holdsText(own, text)) return key;
  const found = others.filter(([k, ledger]) => k !== key && holdsText(ledger, text));
  return found.length === 1 ? found[0][0] : null;
}

/** The tries of `from` that `to` does not count: not in it, and first seen at or after its last reset, since a write drops older ones. */
export function triesToAdd(to: Ledger | null, from: Ledger): [string, Trial][] {
  const resetAt = to?.resetAt ?? 0;
  return Object.entries(from.trials).filter(([id, t]) => !(to !== null && Object.hasOwn(to.trials, id)) && t[2] >= resetAt);
}

/** `to` with the tries of `from` it does not count (triesToAdd), each with its figures and first sight; the same object when there are none. */
export function addTries(to: Ledger, from: Ledger): Ledger {
  const more = triesToAdd(to, from);
  return more.length === 0 ? to : { ...to, trials: { ...to.trials, ...Object.fromEntries(more) } };
}

/**
 * The key of the record a named block left in another note when it was moved or copied from there, for the block with key
 * `key`, record `own` and text `text`: only when its own record began at `since` or later, and exactly one of `others` (the
 * records of blocks with its name in other notes) has a latest version with `text` but for the `name:` line, and tries that
 * `own` does not count. A record whose tries are all counted already, as after a copy was added, is no candidate. Null otherwise.
 */
export function carriedFrom(key: string, own: Ledger | null, others: readonly [string, Ledger | null][], since: number, text: string): string | null {
  if (!newSince(own, since)) return null;
  const unnamed = withoutName(normalText(text));
  const found = others.filter(([k, ledger]) => k !== key && ledger !== null && latestUnnamed(ledger) === unnamed && triesToAdd(own, ledger).length > 0);
  return found.length === 1 ? found[0][0] : null;
}

/** The name a record was kept under, as its latest version writes it; `fallback` when no version has one. */
export function recordName(ledger: Ledger | null, fallback: string): string {
  const latest = ledger?.versions[ledger.versions.length - 1];
  return (latest && blockName(latest.text)) ?? fallback;
}

/** Every block's record, by the block's key (render.ts blockStateKey). */
export class Ledgers {
  private store: LedgerStore;
  private now: () => number;
  private listeners = new Set<{ key: string; since: number; fn: (ledger: Ledger) => void }>();
  /**
   * Keys moved this session, in order, so a block drawn before its note or its name changed still writes to its new key.
   * A note's move takes every key that starts with its old one; a block's (`exact`) only its own key. A block drawn after
   * a move follows only the later ones: a new note at the old path is another note.
   */
  private moved: { from: string; to: string; exact: boolean }[] = [];

  constructor(store: LedgerStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  /** Where the record of a block drawn as `key`, when `since` moves had been made, is kept now. */
  private current(key: string, since: number): string {
    for (const { from, to, exact } of this.moved.slice(since)) if (exact ? key === from : key.startsWith(from)) key = to + key.slice(from.length);
    return key;
  }

  /** Moves every record whose key starts with `from` (a note or a folder that was renamed) to start with `to`. */
  async rename(from: string, to: string): Promise<void> {
    if (from === to) return;
    this.moved.push({ from, to, exact: false });
    await this.store.renamePrefix(from, to);
  }

  /**
   * Moves the record of the one block with key `from` (a block given a new name) to `to`, merged with any record there.
   * Keys that only start with `from`, such as that of a block whose name is longer, stay.
   */
  async move(from: string, to: string): Promise<void> {
    if (from === to) return;
    this.moved.push({ from, to, exact: true });
    await this.store.rename(from, to);
    // A drawing under the new name now counts the tries it brought along.
    const joined = await this.store.get(to);
    if (joined) for (const w of this.listeners) if (this.current(w.key, w.since) === to) w.fn(joined);
  }

  /**
   * The record a block renamed by hand left behind (handRenamed), with the name it was kept under: `prefix` starts the keys
   * of the named blocks of the block's note, `blockKeys` gives the keys of the note's blocks now, and `text` is the block's.
   */
  async renamedFrom(key: string, prefix: string, blockKeys: () => Promise<readonly string[]>, since: number, text: string): Promise<{ key: string; name: string } | null> {
    const own = await this.store.get(key);
    // Most blocks have kept a record for longer, and need no look at the note or the other records.
    if (!newSince(own, since)) return null;
    const others: [string, Ledger | null][] = [];
    for (const k of await this.store.listKeys(prefix)) if (k !== key) others.push([k, await this.store.get(k)]);
    const found = handRenamed(key, own, others, await blockKeys(), since, text);
    if (found === null) return null;
    return { key: found, name: recordName(others.find(([k]) => k === found)![1], found.slice(prefix.length)) };
  }

  /** The record a block with no name at `key` and with `text` kept by its place (placeRecord); `prefix` starts the keys of its note's places. */
  async placeRecord(key: string, prefix: string, text: string): Promise<string | null> {
    const others: [string, Ledger | null][] = [];
    for (const k of await this.store.listKeys(prefix)) if (k !== key) others.push([k, await this.store.get(k)]);
    return placeRecord(key, await this.store.get(key), others, text);
  }

  /**
   * The record a named block moved or copied from another note left there (carriedFrom), for the block with key `key` and
   * text `text`. `suffix` ends the key of every block with the block's name, and `stillThere` tells whether a key is still
   * that of a block in its note, which makes the block a copy and not a move. `tries` is how many tries the block would gain.
   */
  async carriedFrom(key: string, suffix: string, stillThere: (key: string) => Promise<boolean>, since: number, text: string): Promise<{ key: string; moved: boolean; tries: number } | null> {
    // Most blocks have kept a record for longer, and need no look at the other records.
    if (!newSince(await this.store.get(key), since)) return null;
    const others: [string, Ledger | null][] = [];
    for (const k of await this.store.listKeys('')) if (k !== key && k.endsWith(suffix)) others.push([k, await this.store.get(k)]);
    if (others.length === 0) return null;
    // Read again: the block's own first try may have been written while the other records were read.
    const own = await this.store.get(key);
    const found = carriedFrom(key, own, others, since, text);
    if (found === null) return null;
    const old = others.find(([k]) => k === found)![1]!;
    return { key: found, moved: !(await stillThere(found)), tries: triesToAdd(own, old).length };
  }

  /** Adds to the record under `to` the tries of the record under `from` that it does not count (addTries). `from` keeps its record. Returns how many were added. */
  async copyTrials(from: string, to: string): Promise<number> {
    const source = await this.store.get(from);
    if (source === null) return 0;
    const added = triesToAdd(await this.store.get(to), source).length;
    if (added === 0) return 0;
    const next = await this.store.update(to, (l) => addTries(l ?? emptyLedger(), source));
    for (const w of this.listeners) if (this.current(w.key, w.since) === to) w.fn(next);
    return added;
  }

  forBlock(key: string): BlockLedger {
    const since = this.moved.length;
    const change = async (edit: (ledger: Ledger) => Ledger): Promise<void> => {
      const at = this.current(key, since);
      const now = (await this.store.get(at)) ?? emptyLedger();
      if (edit(now) === now) return;
      const next = await this.store.update(at, (l) => edit(l ?? emptyLedger()));
      for (const w of this.listeners) if (this.current(w.key, w.since) === at) w.fn(next);
    };
    return {
      read: async () => (await this.store.get(this.current(key, since))) ?? emptyLedger(),
      add: (runs, version) =>
        change((ledger) => {
          const at = this.now();
          let next = ledger;
          for (const r of runs) if (r) next = addTrial(next, r.hash, r.sharpe, r.perYear, at);
          return version ? addVersion(next, { ...version, at }) : next;
        }),
      reset: () => change((ledger) => resetTrials(ledger, this.now())),
      watch: (fn) => {
        const w = { key, since, fn };
        this.listeners.add(w);
        return () => void this.listeners.delete(w);
      },
    };
  }
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
