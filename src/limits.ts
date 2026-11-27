// How large one backtest may be and how long it may take, in one place, with the messages a refusal shows. Pure.

import type { Backtest } from './backtest.ts';
import { CSV_ASK_BYTES } from './debug.ts';
import { ruleExprs, walk, type Spec } from './dsl.ts';
import { isInsideKey } from './engine.ts';
import { ResultCache } from './result-cache.ts';
import type { RunOutput } from './runner.ts';
import type { Bars } from './types.ts';

/** How far a run may go somewhere: the sizes checked before it starts. */
export interface SizeLimits {
  /** Bars across every ticker the run loads. */
  bars: number;
  /** Each part of each ticker's rules (buy, sell, add, ranking score) times that ticker's bars: one value worked out per part and bar. */
  ruleWork: number;
  /** The periods of every function in each ticker's rules, added up, times that ticker's bars: the prices the functions read. */
  windowWork: number;
}

/**
 * Every ceiling of a single backtest. Measured on an Apple M5 Max (Node 26, and Chrome for the window): a run costs 0.4 to
 * 1.6 µs per bar (less per bar with more tickers), about 15 ns per rule part per bar, and about 1 ns per price inside the
 * window of `sma`, `stdev`, `highest` or `lowest`, which add their whole window up again at every bar. A ranking adds little
 * and the number of parameters nothing. In memory, prices take about 64 bytes a bar, each column of a CSV file 8 more, a result about 100 bytes a step and
 * 600 a trade, and each rule part about 5 bytes a bar while the run lasts. A phone is taken as 2 to 10 times slower.
 */
export const LIMITS = {
  /**
   * In the background worker a run can be stopped, so time is left to `runMs` and these bound memory: a run at both
   * limits holds about 150 MB of rule values in the worker and 64 MB of prices on each side, and takes about 1.2 s here.
   * Its window reads are not counted, since only time grows with them.
   */
  worker: { bars: 1_000_000, ruleWork: 25_000_000, windowWork: Infinity } satisfies SizeLimits,
  /**
   * On the main thread, where a run cannot be stopped and the window does not respond until it ends, these bound time: a
   * run at all three limits takes about 0.4 s here, so a few seconds on a slow phone.
   */
  here: { bars: 200_000, ruleWork: 4_000_000, windowWork: 200_000_000 } satisfies SizeLimits,
  /** How long one backtest may run in the worker before it is stopped: about 8 times the slowest run the size limits allow here. */
  runMs: 10_000,
  /** The same after "Run it anyway", which also skips the size limits. */
  anywayMs: 120_000,
  /** How long a sweep or a luck check may go without finishing a step, each of which is one backtest or a whole reshuffle. */
  stepMs: 120_000,
  /**
   * A block whose run on the main thread takes longer than this is not run again on every frame of a slider drag: a frame
   * lasts 16.7 ms at 60 Hz, and drawing the figures and the chart takes a few of them. In Chrome here one ticker of 5,000
   * daily bars takes 7 to 10 ms on the main thread, and 20 tickers with a ranking 40 to 57 ms.
   */
  dragMs: 12,
  /** Results kept in memory, so a block drawn again does not run again: how many, and their total size in bytes. */
  keptResults: 120,
  keptBytes: 100_000_000,
  /**
   * The largest CSV file a block reads, in characters (bytes, for a file of numbers), by where its text is parsed. Here the
   * window does not respond while a file is parsed, about 14 ms a megabyte: 0.83 s for 1.1 million minute rows, 62 MB. So
   * the limit here is the size at which the rule table asks before it saves a file. In the worker the window stops only to
   * take the bars back, about 1.4 ms a megabyte, so 0.14 s at the limit, where a file of minute rows has about twice the
   * bars of the largest run: a later `from` date can still cut it to a run that fits.
   */
  csvBytes: { worker: 100_000_000, here: CSV_ASK_BYTES },
} as const;

/** What drives the cost of one backtest: see SizeLimits. */
export interface RunSize {
  bars: number;
  tickers: number;
  ruleWork: number;
  windowWork: number;
  /** Of `bars`, the smaller bars of `magnify`; absent when there are none. */
  inside?: number;
}

/**
 * The size of a run of `spec` on `data`, its prices. The smaller bars `magnify` looks inside with count as bars, since they
 * are held and walked like any, but not as tickers; no rule reads them. The columns of a CSV file are left out: they add
 * memory (8 bytes a value, so 50 columns weigh about six times the prices) and time to send them to the worker, but none to
 * the run, and the file is read and parsed before this is counted, which is where a file with many columns costs most.
 */
export function runSize(spec: Spec, data: Map<string, Bars>): RunSize {
  let bars = 0;
  let tickers = 0;
  let inside = 0;
  for (const [name, b] of data) {
    bars += b.t.length;
    if (!isInsideKey(name)) tickers++;
    else inside += b.t.length;
  }
  let ruleWork = 0;
  let windowWork = 0;
  for (const a of spec.universe) {
    const n = data.get(a.name)?.t.length ?? 0;
    const rules = spec.rules[a.name];
    let parts = 0;
    let periods = 0;
    for (const e of [...ruleExprs(rules), spec.rank?.by]) {
      if (!e) continue;
      walk(e, (x) => {
        parts++;
        if (x.k === 'ind' && x.args.length > 0) periods += Math.max(...x.args);
      });
    }
    ruleWork += parts * n;
    windowWork += periods * n;
  }
  return { bars, tickers, ruleWork, windowWork, ...(inside > 0 ? { inside } : {}) };
}

/** `n` in words: digits with commas below a million, "2.1 million" or "3 billion" above, never reading the same as `other`. */
export function amount(n: number, other?: number): string {
  if (n < 1_000_000) return n.toLocaleString('en-US');
  const [unit, word] = n < 1e9 ? [1e6, 'million'] : [1e9, 'billion'];
  const say = (x: number, d: number) => `${Number((x / unit).toFixed(d))} ${word}`;
  for (let d = 1; d <= 3; d++) if (other === undefined || say(n, d) !== say(other, d)) return say(n, d);
  return n.toLocaleString('en-US');
}

const tickers = (n: number) => (n === 1 ? '1 ticker' : `${n} tickers`);

/** "10 seconds", "2 minutes". */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return seconds === 1 ? '1 second' : `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minutes`;
}

const SMALLER = 'To make it smaller, move the "from" date forward, use a longer "interval" or use a smaller number of tickers.';
/** A longer interval leaves the smaller bars as many as they were, so it helps little when they are most of the bars. */
const SMALLER_INSIDE = 'Most of them are the smaller bars of "magnify". To make it smaller, use a longer "magnify" size, move the "from" date forward or use a smaller number of tickers.';
const FOREGROUND = 'Backtests run in the foreground here. Obsidian cannot do other work while a backtest runs.';

/** Why a run of this size is not started where `where` says, or null when it fits. */
export function sizeRefusal(size: RunSize, where: 'worker' | 'here'): string | null {
  const limits = LIMITS[where];
  const lead = where === 'here' ? `${FOREGROUND} ` : '';
  const limit = where === 'here' ? 'The limit here is' : 'The limit is';
  if (size.bars > limits.bars) {
    const smaller = 2 * (size.inside ?? 0) > size.bars ? SMALLER_INSIDE : SMALLER;
    return `${lead}This run has ${amount(size.bars, limits.bars)} bars across ${tickers(size.tickers)}. ${limit} ${amount(limits.bars, size.bars)}. ${smaller}`;
  }
  if (size.ruleWork > limits.ruleWork) {
    return `${lead}Its rules calculate ${amount(size.ruleWork, limits.ruleWork)} values: one for each part of the rules of a ticker on each of its bars. ${limit} ${amount(limits.ruleWork, size.ruleWork)}. To make it smaller, use shorter rules, move the "from" date forward, use a longer "interval" or use a smaller number of tickers.`;
  }
  if (size.windowWork > limits.windowWork) {
    return `${lead}Its functions read ${amount(size.windowWork, limits.windowWork)} prices: the period of each function on each bar. ${limit} ${amount(limits.windowWork, size.windowWork)}. To make it smaller, use shorter periods, move the "from" date forward or use a longer "interval".`;
  }
  return null;
}

/** `n` bytes in megabytes, with as many decimals as it takes not to read the same as `other`: "62 MB", "20.1 MB". */
function megabytes(n: number, other: number): string {
  const say = (d: number) => `${Number((n / 1e6).toFixed(d))} MB`;
  for (let d = 0; d <= 3; d++) if (say(d) !== `${Number((other / 1e6).toFixed(d))} MB`) return say(d);
  return say(3);
}

/** Why a CSV file of `bytes` characters at `path` is not parsed where `where` says, or null when it fits. */
export function csvRefusal(path: string, bytes: number, where: 'worker' | 'here'): string | null {
  const limit = LIMITS.csvBytes[where];
  if (bytes <= limit) return null;
  const lead = where === 'here' ? 'CSV files are read in the foreground here. Obsidian cannot do other work while the plugin reads a file. ' : '';
  return `${lead}The file ${path} is ${megabytes(bytes, limit)}. ${where === 'here' ? 'The limit here is' : 'The limit is'} ${megabytes(limit, bytes)}. To make the file smaller, delete the rows from before the time that the strategy uses, or the columns that the strategy does not read.`;
}

/** Why the parse of the CSV file at `path` was stopped after `ms`. */
export const csvTimeMessage = (path: string, ms: number): string => `The plugin stopped reading the file ${path} after ${duration(ms)}.`;

/** Why a run was stopped after `ms`. With its size for a single backtest; without one for a step of a sweep or a luck check. */
export function timeMessage(ms: number, size: RunSize | null): string {
  if (size === null) return `The plugin stopped this after ${duration(ms)}, the maximum time for one backtest, before a backtest was complete.`;
  return `The plugin stopped this backtest after ${duration(ms)}, the maximum time for one run. It has ${amount(size.bars)} bars across ${tickers(size.tickers)}. To make it faster, move the "from" date forward, use a longer "interval", use a smaller number of tickers or use shorter periods.`;
}

/** A run refused before it started (size) or stopped while it ran (time). */
export class LimitError extends Error {
  readonly kind: 'size' | 'time';
  /** Whether it may be tried again with the size limits off and `LIMITS.anywayMs` to run. */
  readonly anyway: boolean;

  constructor(kind: 'size' | 'time', message: string, anyway: boolean) {
    super(message);
    this.name = 'LimitError';
    this.kind = kind;
    this.anyway = anyway;
  }
}

/** The label of the button that runs a refused or stopped run again without its limit. */
export function anywayLabel(error: LimitError): string {
  return error.kind === 'time' ? `Run it again for a maximum of ${duration(LIMITS.anywayMs)}` : 'Run it with no size limit';
}

/** About how many bytes a kept result holds: its prices, its steps, its trades and its fills (five numbers or names each). */
export function resultBytes(out: Pick<RunOutput, 'data'> & { backtest: Pick<Backtest, 'run'> }): number {
  let bars = 0;
  let columnValues = 0;
  for (const b of out.data.values()) {
    bars += b.t.length;
    columnValues += b.t.length * (b.columns?.length ?? 0);
  }
  const { run } = out.backtest;
  return 64 * bars + 8 * columnValues + 100 * run.t.length + 600 * run.trades.length + 40 * run.fills.t.length;
}

/**
 * A ResultCache that also keeps the total weight of what it holds under `maxWeight`, dropping the least recently used
 * first. The newest entry stays even when it alone weighs more. Its weights follow the cache's own order: every read and
 * write goes through both, so the entry the cache drops for its count is the one dropped here too.
 */
export class WeighedCache<T> {
  private cache: ResultCache<T>;
  private weights = new Map<string, number>();
  private total = 0;
  private maxEntries: number;
  private weigh: (value: T) => number;
  private maxWeight: number;

  constructor(opts: { maxEntries: number; maxAgeMs: number; weigh: (value: T) => number; maxWeight: number; now?: () => number }) {
    this.cache = new ResultCache<T>(opts.maxEntries, opts.maxAgeMs, opts.now);
    this.maxEntries = opts.maxEntries;
    this.weigh = opts.weigh;
    this.maxWeight = opts.maxWeight;
  }

  get(key: string): T | undefined {
    const hit = this.cache.get(key);
    const w = this.weights.get(key);
    if (w !== undefined) {
      this.weights.delete(key);
      if (hit !== undefined) this.weights.set(key, w);
      else this.total -= w;
    }
    return hit;
  }

  set(key: string, value: T): void {
    this.cache.set(key, value);
    this.forget(key);
    const w = this.weigh(value);
    this.weights.set(key, w);
    this.total += w;
    while (this.weights.size > this.maxEntries) this.forget(this.weights.keys().next().value!);
    while (this.total > this.maxWeight && this.weights.size > 1) {
      const oldest = this.weights.keys().next().value!;
      this.cache.delete(oldest);
      this.forget(oldest);
    }
  }

  delete(key: string): void {
    this.cache.delete(key);
    this.forget(key);
  }

  clear(): void {
    this.cache.clear();
    this.weights.clear();
    this.total = 0;
  }

  /** The weight of the entries held, expired ones included until they are read or pushed out. */
  get weight(): number {
    return this.total;
  }

  private forget(key: string): void {
    const w = this.weights.get(key);
    if (w === undefined) return;
    this.weights.delete(key);
    this.total -= w;
  }
}
