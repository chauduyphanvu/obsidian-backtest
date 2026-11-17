import { MarkdownRenderChild, Notice, Plugin, normalizePath, requestUrl } from 'obsidian';
import { runBacktest } from './backtest.ts';
import { loadBars, type DataDeps } from './data.ts';
import { parseSpec, type Spec } from './dsl.ts';
import { StrategySuggest, strategyHighlighter } from './editor.ts';
import { renderErrors, renderFailure, renderLoading, renderResult } from './render.ts';
import type { AssetRef, Bars } from './types.ts';

const TEMPLATE = `\`\`\`strategy
name: Trend following
universe: SPY
from: 2005-01-01
costs: 5 bps

buy  when close > sma(200)
sell when close < sma(200)
\`\`\`
`;

const INTERVAL_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };
/** Bars fetched before "from" so indicators are warm when the run starts. */
const LOOKBACK_BARS = 500;

export default class BacktestBlocks extends Plugin {
  private memory = new Map<string, string>();

  onload(): void {
    this.registerMarkdownCodeBlockProcessor('strategy', (source, el, ctx) => {
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      void this.run(source, el, child, false);
    });

    this.registerEditorExtension(strategyHighlighter);
    this.registerEditorSuggest(new StrategySuggest(this.app));

    this.addCommand({
      id: 'insert-strategy',
      name: 'Insert strategy block',
      editorCallback: (editor) => editor.replaceSelection(TEMPLATE),
    });
    this.addCommand({
      id: 'clear-prices',
      name: 'Clear saved prices',
      callback: async () => {
        this.memory.clear();
        const dir = this.cacheDir();
        if (await this.app.vault.adapter.exists(dir)) await this.app.vault.adapter.rmdir(dir, true);
        new Notice('Saved prices cleared. Strategy blocks fetch again when they next render.');
      },
    });
  }

  private cacheDir(): string {
    return normalizePath(`${this.manifest.dir}/cache`);
  }

  private deps(): DataDeps {
    const adapter = this.app.vault.adapter;
    const file = (key: string) => `${this.cacheDir()}/${key}.json`;
    return {
      now: () => Date.now(),
      fetchText: async (url) => {
        const res = await requestUrl({ url, throw: false });
        // The services explain a bad ticker in a JSON body, which the parsers turn into a message.
        if (res.status >= 400 && !res.text.trimStart().startsWith('{')) throw new Error(`HTTP ${res.status}`);
        return res.text;
      },
      readVaultFile: async (path) => {
        const p = normalizePath(path);
        return (await adapter.exists(p)) ? adapter.read(p) : null;
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
        if (!(await adapter.exists(this.cacheDir()))) await adapter.mkdir(this.cacheDir());
        await adapter.write(file(key), text);
      },
    };
  }

  private async loadPrices(spec: Spec, force: boolean): Promise<{ data: Map<string, Bars>; warnings: string[] }> {
    const refs = new Map<string, AssetRef>();
    for (const r of [...spec.universe, ...spec.extras, ...(spec.benchmark ? [spec.benchmark] : [])]) {
      if (!refs.has(r.name)) refs.set(r.name, r);
    }
    const step = Number(spec.interval.slice(0, -1)) * INTERVAL_MS[spec.interval.slice(-1)];
    const since = spec.from === null ? 0 : spec.from - LOOKBACK_BARS * step;
    const deps = this.deps();
    const loaded = await Promise.all([...refs.values()].map(async (r) => ({ name: r.name, ...(await loadBars(r, spec.interval, since, deps, force)) })));
    return {
      data: new Map(loaded.map((l) => [l.name, l.bars])),
      warnings: loaded.flatMap((l) => (l.warning ? [l.warning] : [])),
    };
  }

  private async run(source: string, el: HTMLElement, child: MarkdownRenderChild, force: boolean): Promise<void> {
    const { spec, errors } = parseSpec(source);
    if (!spec) {
      renderErrors(el, errors, source);
      return;
    }
    const retry = (refetch: boolean) => () => void this.run(source, el, child, refetch);
    renderLoading(el, `Loading prices for ${[...spec.universe, ...spec.extras].map((a) => a.name).join(', ')}…`);
    try {
      const { data, warnings } = await this.loadPrices(spec, force);
      const stop = renderResult(el, spec, runBacktest(spec, data), warnings, source, retry(true));
      child.register(stop);
    } catch (e) {
      renderFailure(el, e instanceof Error ? e.message : String(e), source, retry(false));
    }
  }
}
