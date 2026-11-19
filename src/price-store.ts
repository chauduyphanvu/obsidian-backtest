// Saved prices: the files in the plugin's cache folder, the ones kept in memory, the column names of the CSV files read,
// and whether a block's prices are all saved and fresh. The plugin hands in the vault's file calls and the network.

import { csvColumnNames, type DataDeps } from './data.ts';
import { parseSpec, type Defaults, type Spec } from './dsl.ts';
import { WeighedCache } from './limits.ts';
import { ReadyMemo, loadNeeds } from './live-core.ts';
import { Runner } from './runner.ts';
import type { Bars } from './types.ts';

/**
 * Saved price files kept in memory, by their total length in characters, which is about a byte each. A Binance ticker's
 * smaller bars come to several megabytes each, so the files are not counted alone. The least recently used go first.
 */
const KEPT_PRICE_TEXT = 60_000_000;
const KEPT_PRICE_FILES = 200;

/** The vault's file calls the store uses, with paths as the vault writes them. */
export interface PriceFiles {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
}

export interface PriceStoreOptions {
  files: PriceFiles;
  /** The folder the price files are saved in, as the vault writes it. */
  cacheDir: string;
  /** A path as the vault writes it (Obsidian's normalizePath). */
  normalize: (path: string) => string;
  /** GET a URL and return its body (data.ts DataDeps). */
  fetchText: DataDeps['fetchText'];
  /** A service's API key from the user's secret storage, read at each request (data.ts DataDeps). */
  secret?: DataDeps['secret'];
  /** Whether Tiingo stands in for Yahoo (data.ts DataDeps). */
  tiingoFallback?: DataDeps['tiingoFallback'];
}

export class PriceStore {
  /** Whether each kind of block's prices are all saved and fresh, which the preview panel asks at every pause in typing. */
  readonly ready = new ReadyMemo();
  private memory = new WeighedCache<string>({ maxEntries: KEPT_PRICE_FILES, maxAgeMs: Infinity, weigh: (text) => text.length, maxWeight: KEPT_PRICE_TEXT });
  private dataDeps: DataDeps | null = null;
  /** Column names of the CSV files read so far, for completion after `column(`. A file that is deleted or renamed is forgotten. */
  private csvColumns = new Map<string, string[]>();
  private o: PriceStoreOptions;

  constructor(o: PriceStoreOptions) {
    this.o = o;
  }

  /** The column names of the CSV file at `path`, when it has been read. */
  columns(path: string): string[] | undefined {
    return this.csvColumns.get(this.o.normalize(path));
  }

  /** Forgets the columns of the file at `path`, or of every file under it when it is a folder. */
  forgetColumns(path: string): void {
    for (const known of this.csvColumns.keys()) if (known === path || known.startsWith(`${path}/`)) this.csvColumns.delete(known);
  }

  /** Drops the files kept in memory and every answer about readiness; the saved files stay (see removeSaved). */
  forget(): void {
    this.memory.clear();
    this.ready.changed();
  }

  /** Removes the folder of saved price files. */
  async removeSaved(): Promise<void> {
    const dir = this.o.cacheDir;
    if (await this.o.files.exists(dir)) await this.o.files.rmdir(dir, true);
  }

  deps(): DataDeps {
    if (this.dataDeps) return this.dataDeps;
    const adapter = this.o.files;
    const normalizePath = this.o.normalize;
    const file = (key: string) => `${this.o.cacheDir}/${key}.json`;
    // One object for the plugin's life, so several blocks asking for the same ticker share a download.
    this.dataDeps = {
      now: () => Date.now(),
      // globalThis, not window: the command line runs this on Node, which has no window.
      sleep: (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
      fetchText: this.o.fetchText,
      secret: this.o.secret,
      tiingoFallback: this.o.tiingoFallback,
      readVaultFile: async (path) => {
        const p = normalizePath(path);
        if (!(await adapter.exists(p))) {
          this.csvColumns.delete(p);
          return null;
        }
        const text = await adapter.read(p);
        if (p.toLowerCase().endsWith('.csv')) this.csvColumns.set(p, csvColumnNames(text));
        return text;
      },
      cacheRead: async (key) => {
        const hit = this.memory.get(key);
        if (hit !== undefined) return hit;
        if (!(await adapter.exists(file(key)))) return null;
        const text = await adapter.read(file(key));
        this.memory.set(key, text);
        return text;
      },
      cacheWrite: async (key, text) => {
        this.memory.set(key, text);
        this.ready.changed();
        if (!(await adapter.exists(this.o.cacheDir))) await adapter.mkdir(this.o.cacheDir);
        await adapter.write(file(key), text);
      },
    };
    return this.dataDeps;
  }

  /** The prices a block reads, from the saved files only: nothing is downloaded or written. Null when one is not saved. */
  async savedData(spec: Spec, defaults: Defaults): Promise<Map<string, Bars> | null> {
    const offline: DataDeps = { ...this.deps(), fetchText: () => Promise.reject(new Error('offline')), cacheWrite: async () => {}, sleep: async () => {} };
    try {
      const { data } = await new Runner(offline, defaults, { freshForMs: Infinity }).loadPrices(spec);
      return data;
    } catch {
      return null;
    }
  }

  /**
   * True when running the block needs no download: it parses, and every ticker's saved prices are fresh. The panel asks at
   * every pause in typing, so the answer is kept for the kind of block it is (loadNeeds) until a price file is written or
   * removed, or the oldest saved file stops being fresh. Parsing a saved file of smaller bars takes tens of milliseconds.
   */
  async pricesReady(source: string, defaults: Defaults, freshForMs: number): Promise<boolean> {
    const { spec } = parseSpec(source, { defaults });
    if (!spec) return false;
    const needs = loadNeeds(spec);
    const known = this.ready.get(needs);
    if (known !== undefined) return known;
    const turn = this.ready.turn();
    const offline: DataDeps = { ...this.deps(), fetchText: () => Promise.reject(new Error('offline')), cacheWrite: async () => {}, sleep: async () => {} };
    try {
      const { prices, warnings } = await new Runner(offline, defaults, { freshForMs }).loadPrices(spec);
      // Loading prices warns only when a download failed and a saved copy, or nothing for a ticker's smaller bars, stood in.
      // So a warning means this block needs a download, whatever else it says.
      const ready = prices.every((p) => !p.stale) && warnings.length === 0;
      this.ready.set(needs, ready, ready ? Math.min(...prices.map((p) => p.fetched)) + freshForMs : Infinity, turn);
      return ready;
    } catch {
      return false;
    }
  }
}
