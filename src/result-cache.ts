import type { Spec } from './dsl.ts';

/**
 * Keeps the latest results so a block that re-renders (scrolling, switching views) does not run again.
 * Entries expire after `maxAgeMs` and the least recently used are dropped beyond `maxEntries`.
 */
export class ResultCache<T> {
  private entries = new Map<string, { value: T; at: number }>();
  private maxEntries: number;
  private maxAgeMs: number;
  private now: () => number;

  constructor(maxEntries: number, maxAgeMs: number, now: () => number = Date.now) {
    this.maxEntries = maxEntries;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
  }

  /** A hit counts as a use. An entry is fresh while it is younger than `maxAgeMs`, however often it is read. */
  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at >= this.maxAgeMs) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, at: this.now() });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Entries that have not expired. */
  get size(): number {
    const t = this.now();
    for (const [key, hit] of this.entries) if (t - hit.at >= this.maxAgeMs) this.entries.delete(key);
    return this.entries.size;
  }
}

/** Plain data as text with object keys in order, so equal data gives equal text. A key holding `undefined` counts as absent. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** A 53-bit hash (cyrb53) of the text. */
function hash(text: string): number {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return 4294967296 * (2097151 & b) + (a >>> 0);
}

/** A short stable key for a strategy's text plus the defaults it was parsed with, and `inputs` when it reads files that can change (see `csvVersions`). */
export function cacheKey(source: string, defaults: unknown, inputs = ''): string {
  const text = `${stable(defaults)}\u0000${source}${inputs ? `\u0000${inputs}` : ''}`;
  return `${hash(text).toString(36)}-${text.length.toString(36)}`;
}

/** The vault paths of the CSV files a strategy reads, each once, in order. */
export function csvPaths(spec: Pick<Spec, 'universe' | 'extras' | 'benchmark' | 'cash'>): string[] {
  const refs = [...spec.universe, ...spec.extras, ...(spec.benchmark ? [spec.benchmark] : []), ...(spec.cash.k === 'ticker' ? [spec.cash.ref] : [])];
  return [...new Set(refs.filter((r) => r.source === 'csv').map((r) => r.id))].sort();
}

/** Which version of each file a result was made from: its path and modified time, or "missing" when there is no such file. Empty when there are no files. */
export async function csvVersions(paths: string[], modified: (path: string) => Promise<number | null>): Promise<string> {
  const times = await Promise.all(paths.map(modified));
  return paths.map((p, i) => `${p}=${times[i] ?? 'missing'}`).join('\n');
}

const REAL_TIMERS = {
  set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clear: (id: unknown): void => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Calls `fn` with the latest arguments once calls have stopped for `ms`. `cancel` drops a call that is waiting. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
  timers: { set(fn: () => void, ms: number): unknown; clear(id: unknown): void } = REAL_TIMERS,
): { (...args: A): void; cancel(): void } {
  let pending: unknown;
  let waiting = false;
  const call = (...args: A): void => {
    if (waiting) timers.clear(pending);
    waiting = true;
    pending = timers.set(() => {
      waiting = false;
      fn(...args);
    }, ms);
  };
  call.cancel = (): void => {
    if (waiting) timers.clear(pending);
    waiting = false;
  };
  return call;
}
