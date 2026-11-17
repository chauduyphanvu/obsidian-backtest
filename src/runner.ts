import { runBacktest, type Backtest } from './backtest.ts';
import { loadBars, type DataDeps } from './data.ts';
import type { Spec } from './dsl.ts';
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
}

/** Loads a spec's prices and runs it. Knows nothing about Obsidian: everything outside comes through `deps`. */
export class Runner {
  private deps: DataDeps;

  constructor(deps: DataDeps) {
    this.deps = deps;
  }

  async loadPrices(spec: Spec, force = false): Promise<{ data: Map<string, Bars>; warnings: string[] }> {
    const refs = new Map<string, AssetRef>();
    for (const r of [...spec.universe, ...spec.extras, ...(spec.benchmark ? [spec.benchmark] : [])]) {
      if (!refs.has(r.name)) refs.set(r.name, r);
    }
    const step = Number(spec.interval.slice(0, -1)) * INTERVAL_MS[spec.interval.slice(-1)];
    const since = spec.from === null ? 0 : spec.from - LOOKBACK_BARS * step;
    const loaded = await Promise.all([...refs.values()].map(async (r) => ({ name: r.name, ...(await loadBars(r, spec.interval, since, this.deps, force)) })));
    return {
      data: new Map(loaded.map((l) => [l.name, l.bars])),
      warnings: loaded.flatMap((l) => (l.warning ? [l.warning] : [])),
    };
  }

  async run(spec: Spec, force = false): Promise<RunOutput> {
    const { data, warnings } = await this.loadPrices(spec, force);
    return { spec, backtest: runBacktest(spec, data), data, warnings };
  }
}
