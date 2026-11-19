// Running a block's text and keeping the result, so a block drawn again, the compare and backtests blocks, the orders and
// the note properties reuse a recent run of the same text, defaults and CSV files instead of running it again. A result's
// trigger prices are kept with it the same way.

import type { Backtest } from './backtest.ts';
import type { DataDeps } from './data.ts';
import type { Defaults, Spec } from './dsl.ts';
import { HOUR } from './format.ts';
import { LIMITS, WeighedCache, resultBytes, runSize } from './limits.ts';
import { cacheKey, csvPaths, csvVersions, pricesAsOf } from './result-cache.ts';
import { Runner, type RunOutput } from './runner.ts';
import { triggerRun, watchable, type TriggerReport } from './trigger.ts';
import { BlockDrawing, blockRuns, type BlockRuns } from './worker-client.ts';

/** A result kept in memory, with when its prices were current (pricesAsOf). */
interface Kept {
  out: RunOutput;
  asOf: number;
}

export interface ResultsOptions {
  /** The data calls every run uses (PriceStore.deps). */
  deps: () => DataDeps;
  /** The parser defaults the settings imply now. */
  defaults: () => Defaults;
  /** How old saved prices may be, from the settings. */
  freshForMs: () => number;
  /** The modified time of the vault file at `path`, or null when there is none. */
  modified: (path: string) => Promise<number | null>;
  /** Where single runs go; the plugin's background workers unless a test hands in its own. */
  runs?: () => BlockRuns;
}

export class Results {
  private results = this.keptResults(6 * HOUR);
  /** Each result's trigger prices, asked for once; one stopped or failed is forgotten, so the next ask tries again. */
  private reports = new WeakMap<Backtest, Promise<TriggerReport | null>>();
  private o: ResultsOptions;
  private newRuns: () => BlockRuns;

  constructor(o: ResultsOptions) {
    this.o = o;
    this.newRuns = o.runs ?? blockRuns;
  }

  /** Drops every kept result and keeps new ones for `maxAgeMs`, when the settings are read or changed. */
  reset(maxAgeMs: number): void {
    this.results = this.keptResults(maxAgeMs);
  }

  /** Drops every kept result, so each block runs again. */
  clear(): void {
    this.results.clear();
  }

  runner(freshForMs = this.o.freshForMs()): Runner {
    return new Runner(this.o.deps(), this.o.defaults(), { freshForMs });
  }

  /** One drawing of a block. The defaults are read from the settings here, once, and everything made from the drawing uses them. */
  drawing(source: string, runs: BlockRuns, opts: { freshForMs?: number; anyway?: boolean; background?: boolean } = {}): BlockDrawing {
    return new BlockDrawing({
      source,
      defaults: this.o.defaults(),
      deps: this.o.deps(),
      freshForMs: opts.freshForMs ?? this.o.freshForMs(),
      runs,
      anyway: opts.anyway,
      background: opts.background,
    });
  }

  /** A result's key: the strategy's text, the defaults it was read with, and the version of every CSV file it reads. */
  async resultKey(spec: Spec, source: string, defaults: Defaults): Promise<string> {
    const files = await csvVersions(csvPaths(spec), this.o.modified);
    return cacheKey(source, defaults, files);
  }

  /** Results kept in memory, up to a count and a total size (limits.ts). */
  private keptResults(maxAgeMs: number): WeighedCache<Kept> {
    return new WeighedCache<Kept>({ maxEntries: LIMITS.keptResults, maxAgeMs, weigh: (k) => resultBytes(k.out), maxWeight: LIMITS.keptBytes });
  }

  /**
   * The kept result for `key` when its prices are no older than `freshForMs`, the age the caller takes saved prices at. A
   * forced round passes the time since it began, so a run that started before it, and finished after it dropped the kept
   * results, is not reused.
   */
  kept(key: string, freshForMs: number): RunOutput | undefined {
    const hit = this.results.get(key);
    return hit && Date.now() - hit.asOf < freshForMs ? hit.out : undefined;
  }

  async runSpec(drawing: BlockDrawing, spec: Spec, key: string, force = false, onPrices?: (bars: number) => void): Promise<RunOutput | null> {
    if (!force) {
      const hit = this.kept(key, drawing.freshForMs);
      if (hit) return hit;
    }
    const out = await drawing.run(spec, { force, onPrices });
    if (out) this.results.set(key, { out, asOf: pricesAsOf(out.prices, Date.now()) });
    return out;
  }

  /**
   * The trigger prices of a result (trigger.ts), worked out once and kept with it; null for a result with no next close to
   * watch (watchable). `runs` are those of whoever shows the result, whose worker already holds its prices; without them
   * the request gets runs of its own. A kept request that was stopped is asked again with `runs`; one that ran out of time,
   * or was too large to work out here, stays kept, as asking again would end the same way.
   */
  triggers(out: RunOutput, runs?: BlockRuns, background = false): Promise<TriggerReport | null> | null {
    if (!watchable(out.spec)) return null;
    const kept = this.reports.get(out.backtest);
    if (!kept) return this.request(out, runs, background);
    return kept.then((r) => (r === null && this.reports.get(out.backtest) !== kept ? this.triggers(out, runs, background) : r));
  }

  private request(out: RunOutput, runs: BlockRuns | undefined, background: boolean): Promise<TriggerReport | null> {
    const own = runs ?? this.newRuns();
    const asked = own
      .triggers({ spec: out.spec, prices: out.data, run: triggerRun(out.backtest.run), size: runSize(out.spec, out.data), background })
      .finally(() => {
        if (!runs) own.close();
      });
    this.reports.set(out.backtest, asked);
    const forget = () => {
      if (this.reports.get(out.backtest) === asked) this.reports.delete(out.backtest);
    };
    // Runs of its own are closed only once it settles, so only the caller's can have stopped it.
    asked.then((r) => (r === null && runs?.isClosed() ? forget() : undefined), forget);
    return asked;
  }

  /**
   * Runs a block's text, reusing a recent result for the same text, defaults and CSV files. A block that does not parse rejects
   * with its first problem. With `cachedOnly` nothing runs: a block with no kept result rejects. `background` is for a scan
   * of the vault, whose runs wait for those of the blocks on screen. `freshForMs` is how old saved prices may be. With
   * `triggers`, the result's trigger prices are worked out before its runs close, while the worker still holds its prices,
   * so asking for them afterwards (triggers) finds them kept.
   */
  async runSource(source: string, opts: { force?: boolean; freshForMs?: number; cachedOnly?: boolean; background?: boolean; triggers?: boolean } = {}): Promise<RunOutput> {
    const runs = this.newRuns();
    try {
      const drawing = this.drawing(source, runs, { freshForMs: opts.freshForMs, background: opts.background });
      const { spec, errors } = drawing.parse();
      if (!spec) throw new Error(`Line ${errors[0].line}: ${errors[0].message}`);
      const key = await this.resultKey(spec, source, drawing.defaults);
      if (opts.cachedOnly) {
        const hit = this.kept(key, drawing.freshForMs);
        if (!hit) throw new Error('This strategy did not run at this time.');
        return hit;
      }
      const out = await this.runSpec(drawing, spec, key, opts.force);
      if (!out) throw new Error('The run was stopped.');
      // A result is worth having without its trigger prices, so their failing does not fail the run.
      if (opts.triggers) await this.triggers(out, runs, opts.background)?.catch(() => null);
      return out;
    } finally {
      runs.close();
    }
  }
}
