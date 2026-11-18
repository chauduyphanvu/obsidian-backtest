// Work that depends only on a map of prices and what was asked of it: an indicator's series, and the benchmark's run. A
// sweep, a walk-forward and a slider run many variants of one block on the same prices, and the variants mostly ask for
// the same work, so on a map shared here it is done once. A map is shared only where many runs will read it: a map made
// for one look, such as a run on prices with a bar added, would only push out what the others keep.

import type { Bars } from './types.ts';

/** The most a PriceMemo keeps, counting 8 bytes for each number. */
export const MEMO_BYTES = 64 * 2 ** 20;

interface Entry {
  /** The entries of the map of prices it was worked out on. */
  kept: Map<string, Entry>;
  key: string;
  value: unknown;
  bytes: number;
}

export class PriceMemo {
  private maps = new WeakMap<Map<string, Bars>, Map<string, Entry>>();
  /** Every entry, of every map, the least recently used first. */
  private order = new Set<Entry>();
  private total = 0;
  private cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  /** Keeps work done on `data` from now on. Neither the map nor its bars may change afterwards, or what was kept is wrong. */
  share(data: Map<string, Bars>): void {
    if (!this.maps.has(data)) this.maps.set(data, new Map());
  }

  /**
   * What `make` gives for `key` on `data`, kept when `data` is shared; `numbers` counts the numbers it holds. An error is
   * not kept, so the next call tries again. Beyond the cap the least recently used entries go, of whichever map, so those
   * of a map no longer read go in time; an entry larger than the whole cap is not kept.
   */
  get<T>(data: Map<string, Bars>, key: string, make: () => T, numbers: (value: T) => number): T {
    const kept = this.maps.get(data);
    if (!kept) return make();
    const hit = kept.get(key);
    if (hit) {
      this.order.delete(hit);
      this.order.add(hit);
      return hit.value as T;
    }
    const value = make();
    const bytes = 8 * numbers(value);
    if (bytes > this.cap) return value;
    const entry: Entry = { kept, key, value, bytes };
    kept.set(key, entry);
    this.order.add(entry);
    this.total += bytes;
    for (const old of this.order) {
      if (this.total <= this.cap) break;
      this.order.delete(old);
      old.kept.delete(old.key);
      this.total -= old.bytes;
    }
    return value;
  }

  /** What is kept, in the bytes the cap counts. */
  get bytes(): number {
    return this.total;
  }
}

/** The one every run reads, so runs on one map of prices share their work wherever they are started from. */
export const priceMemo = new PriceMemo(MEMO_BYTES);
