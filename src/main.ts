import { MarkdownRenderChild, Notice, Plugin, normalizePath, requestUrl } from 'obsidian';
import type { DataDeps } from './data.ts';
import { parseSpec } from './dsl.ts';
import { StrategySuggest, strategyHighlighter } from './editor.ts';
import { renderErrors, renderFailure, renderLoading, renderResult } from './render.ts';
import { Runner } from './runner.ts';

const TEMPLATE = `\`\`\`strategy
name: Trend following
universe: SPY
from: 2005-01-01
costs: 5 bps

buy  when close > sma(200)
sell when close < sma(200)
\`\`\`
`;

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

  private async run(source: string, el: HTMLElement, child: MarkdownRenderChild, force: boolean): Promise<void> {
    const { spec, errors } = parseSpec(source);
    if (!spec) {
      renderErrors(el, errors, source);
      return;
    }
    const retry = (refetch: boolean) => () => void this.run(source, el, child, refetch);
    renderLoading(el, `Loading prices for ${[...spec.universe, ...spec.extras].map((a) => a.name).join(', ')}…`);
    try {
      const out = await new Runner(this.deps()).run(spec, force);
      const stop = renderResult(el, spec, out.backtest, out.warnings, source, retry(true));
      child.register(stop);
    } catch (e) {
      renderFailure(el, e instanceof Error ? e.message : String(e), source, retry(false));
    }
  }
}
