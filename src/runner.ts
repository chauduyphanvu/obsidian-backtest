import { runBacktest, type Backtest } from './backtest.ts';
import { loadBars, type DataDeps, type Loaded } from './data.ts';
import { parseSpec, type Defaults, type ParseResult, type Spec } from './dsl.ts';
import type { AssetRef, Bars } from './types.ts';

const INTERVAL_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };
/** Bars fetched before "from" so indicators are warm when the run starts. */
const LOOKBACK_BARS = 500;

export interface RunOutput {
  spec: Spec;
  backtest: Backtest;
  data: Map<string, Bars>;
  /** Things the reader should know that did not stop the run, such as stale prices. */
  warnings: string[];
  prices: PriceInfo[];
}

/** Where one ticker's prices came from and how far they go. */
export interface PriceInfo {
  name: string;
  source: Loaded['source'];
  through: number;
  fetched: number;
  stale: boolean;
}

/** Loads a spec's prices and runs it. Knows nothing about Obsidian: everything outside comes through `deps`. */
export class Runner {
  private deps: DataDeps;
  private defaults: Partial<Defaults>;
  private freshForMs: number | undefined;

  /** `defaults` fill in what a block leaves out, such as the capital or the cash rate. */
  constructor(deps: DataDeps, defaults: Partial<Defaults> = {}, opts: { freshForMs?: number } = {}) {
    this.deps = deps;
    this.defaults = defaults;
    this.freshForMs = opts.freshForMs;
  }

  /** Parses a block with this runner's defaults; `overrides` replace declared parameter values. */
  parse(source: string, overrides?: Record<string, number>): ParseResult {
    return parseSpec(source, { defaults: this.defaults, overrides });
  }

  async loadPrices(spec: Spec, force = false): Promise<{ data: Map<string, Bars>; warnings: string[]; prices: PriceInfo[] }> {
    const refs = new Map<string, AssetRef>();
    const cash = spec.cash.k === 'ticker' ? [spec.cash.ref] : [];
    for (const r of [...spec.universe, ...spec.extras, ...(spec.benchmark ? [spec.benchmark] : []), ...cash]) {
      if (!refs.has(r.name)) refs.set(r.name, r);
    }
    const step = Number(spec.interval.slice(0, -1)) * INTERVAL_MS[spec.interval.slice(-1)];
    const since = spec.from === null ? 0 : spec.from - LOOKBACK_BARS * step;
    const loaded = await Promise.all(
      [...refs.values()].map(async (r) => ({ name: r.name, ...(await loadBars(r, spec.interval, since, this.deps, force, { freshForMs: this.freshForMs })) })),
    );
    return {
      data: new Map(loaded.map((l) => [l.name, l.bars])),
      warnings: loaded.flatMap((l) => (l.warning ? [l.warning] : [])),
      prices: loaded.map((l) => ({ name: l.name, source: l.source, through: l.through, fetched: l.fetched, stale: l.stale })),
    };
  }

  async run(spec: Spec, force = false): Promise<RunOutput> {
    const { data, warnings, prices } = await this.loadPrices(spec, force);
    return { spec, backtest: runBacktest(spec, data), data, warnings, prices };
  }
}
