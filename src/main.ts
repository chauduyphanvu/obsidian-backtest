import { MarkdownRenderChild, MarkdownView, Notice, Plugin, TFile, normalizePath, requestUrl } from 'obsidian';
import { extractBlocks } from './blocks.ts';
import { parseCompare, type Curve } from './compare.ts';
import type { DataDeps } from './data.ts';
import { DAY, isoDate } from './dom.ts';
import { StrategySuggest, strategyEditor } from './editor.ts';
import { equityCsv, resultProperties, snapshotMarkdown, tradesCsv } from './export.ts';
import { DEFAULT_MODEL, draftStrategy } from './llm.ts';
import { DraftModal } from './llm-modal.ts';
import { failedStatus, statusFrom, type StrategyStatus } from './orders.ts';
import { OrdersModal } from './orders-view.ts';
import { renderActions } from './render-actions.ts';
import { renderCompare, renderCompareErrors, renderCompareMessage } from './render-compare.ts';
import { renderPriceCharts } from './render-price.ts';
import { renderLuck } from './render-luck.ts';
import { renderErrors, renderFailure, renderLoading, renderResult, type Section } from './render.ts';
import { renderSweep } from './render-sweep.ts';
import { ResultCache, cacheKey } from './result-cache.ts';
import { Runner, type RunOutput } from './runner.ts';
import { BacktestSettingTab, defaultsFrom, normalizeSettings, type Settings } from './settings.ts';

const TEMPLATE = `\`\`\`strategy
name: Trend following
universe: SPY
from: 2005-01-01
costs: 5 bps

buy  when close > sma(200)
sell when close < sma(200)
\`\`\`
`;

const HOUR = 3_600_000;
const KEPT_RESULTS = 40;

export default class BacktestBlocks extends Plugin {
  settings: Settings = normalizeSettings(null);
  private memory = new Map<string, string>();
  private results = new ResultCache<RunOutput>(KEPT_RESULTS, 6 * HOUR);
  private dataDeps: DataDeps | null = null;

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.results = new ResultCache<RunOutput>(KEPT_RESULTS, this.settings.cacheHours * HOUR);
    this.addSettingTab(new BacktestSettingTab(this.app, this));

    this.registerMarkdownCodeBlockProcessor('strategy', (source, el, ctx) => {
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      void this.renderStrategy(source, el, child, ctx.sourcePath, false);
    });
    this.registerMarkdownCodeBlockProcessor('compare', (source, el, ctx) => {
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      void this.renderComparison(source, el, child, ctx.sourcePath);
    });

    this.registerEditorExtension(strategyEditor(() => defaultsFrom(this.settings)));
    this.registerEditorSuggest(new StrategySuggest(this.app));

    this.addCommand({
      id: 'insert-strategy',
      name: 'Insert strategy block',
      editorCallback: (editor) => editor.replaceSelection(TEMPLATE),
    });
    this.addCommand({
      id: 'draft-strategy',
      name: 'Draft a strategy from a description',
      callback: () => this.openDraft(),
    });
    this.addCommand({
      id: 'todays-orders',
      name: "Show today's orders",
      callback: () => this.openOrders(),
    });
    this.addCommand({
      id: 'save-properties',
      name: "Save this note's results to its properties",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.saveProperties(file, true);
        return true;
      },
    });
    this.addCommand({
      id: 'clear-prices',
      name: 'Clear saved prices',
      callback: () => void this.clearPrices(),
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Defaults are part of every result's key, but the freshness window is not.
    this.results = new ResultCache<RunOutput>(KEPT_RESULTS, this.settings.cacheHours * HOUR);
  }

  async clearPrices(): Promise<void> {
    this.memory.clear();
    this.results.clear();
    const dir = this.cacheDir();
    if (await this.app.vault.adapter.exists(dir)) await this.app.vault.adapter.rmdir(dir, true);
    new Notice('Saved prices cleared. Strategy blocks fetch again when they next render.');
  }

  private cacheDir(): string {
    return normalizePath(`${this.manifest.dir}/cache`);
  }

  private deps(): DataDeps {
    if (this.dataDeps) return this.dataDeps;
    const adapter = this.app.vault.adapter;
    const file = (key: string) => `${this.cacheDir()}/${key}.json`;
    // One object for the plugin's life, so several blocks asking for the same ticker share a download.
    this.dataDeps = {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
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
    return this.dataDeps;
  }

  private runner(): Runner {
    return new Runner(this.deps(), defaultsFrom(this.settings), { freshForMs: this.settings.cacheHours * HOUR });
  }

  /** Runs a block's text, reusing a recent result for the same text and defaults. A block that does not parse rejects with its first problem. */
  private async runSource(source: string, force: boolean): Promise<RunOutput> {
    const runner = this.runner();
    const key = cacheKey(source, defaultsFrom(this.settings));
    if (!force) {
      const hit = this.results.get(key);
      if (hit) return hit;
    }
    const { spec, errors } = runner.parse(source);
    if (!spec) throw new Error(`Line ${errors[0].line}: ${errors[0].message}`);
    const out = await runner.run(spec, force);
    this.results.set(key, out);
    return out;
  }

  private async renderStrategy(source: string, el: HTMLElement, child: MarkdownRenderChild, notePath: string, force: boolean): Promise<void> {
    const runner = this.runner();
    const { spec, errors, warnings } = runner.parse(source);
    if (!spec) {
      renderErrors(el, errors, source);
      return;
    }
    const retry = (refetch: boolean) => () => void this.renderStrategy(source, el, child, notePath, refetch);
    const kept = !force && this.results.get(cacheKey(source, defaultsFrom(this.settings))) !== undefined;
    if (!kept) renderLoading(el, `Loading prices for ${[...spec.universe, ...spec.extras].map((a) => a.name).join(', ')}…`);
    try {
      const out = await this.runSource(source, force);
      const bt = out.backtest;
      const intraday = bt.run.t.some((t) => t % DAY !== 0);
      const name = spec.name ?? 'Backtest';
      const sections: Section[] = [
        (root) =>
          renderPriceCharts(root, {
            data: out.data,
            tickers: spec.universe.map((a) => a.name),
            trades: bt.run.trades,
            from: bt.run.t[0],
            to: bt.run.t[bt.run.t.length - 1],
            intraday,
          }),
        (root) => renderSweep(root, { source, backtest: bt, parse: (overrides) => runner.parse(source, overrides) }),
        (root) => renderLuck(root, { source, backtest: bt, parse: (overrides) => runner.parse(source, overrides) }),
        (root) =>
          renderActions(root, [
            { label: 'Save trades as CSV', run: () => this.saveFile(`${name} trades`, 'csv', tradesCsv(bt.run.trades, intraday)) },
            { label: 'Save value history as CSV', run: () => this.saveFile(`${name} value`, 'csv', equityCsv(bt.run.t, bt.run.equity, bt.benchmark.equity, bt.benchmark.label, intraday)) },
            { label: 'Keep this result as a note', run: () => this.saveFile(`${name} result`, 'md', snapshotMarkdown({ name, source, backtest: bt, now: Date.now() })) },
          ]),
      ];
      child.register(renderResult(el, { source, out, notes: warnings, onRefresh: retry(true), sections }));
      if (this.settings.writeProperties) {
        const file = this.app.vault.getAbstractFileByPath(notePath);
        if (file instanceof TFile) void this.saveProperties(file, false);
      }
    } catch (e) {
      renderFailure(el, e instanceof Error ? e.message : String(e), source, retry(false));
    }
  }

  /** Writes text to a dated file in the results folder and says where it went. */
  private async saveFile(title: string, ext: string, text: string): Promise<void> {
    const folder = normalizePath(this.settings.snapshotFolder);
    const clean = title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    try {
      if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder);
      const stem = `${folder}/${clean} ${isoDate(Date.now())}`;
      let path = `${stem}.${ext}`;
      for (let n = 2; await this.app.vault.adapter.exists(path); n++) path = `${stem} (${n}).${ext}`;
      await this.app.vault.create(path, text);
      new Notice(`Saved to ${path}`);
    } catch (e) {
      new Notice(`Couldn't save the file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Stores the main figures of every strategy in a note in that note's properties. */
  private async saveProperties(file: TFile, announce: boolean): Promise<void> {
    const blocks = extractBlocks(await this.app.vault.cachedRead(file));
    const all: Record<string, string | number> = {};
    for (const block of blocks) {
      try {
        const out = await this.runSource(block.source, false);
        Object.assign(all, resultProperties(out.backtest, Date.now(), { name: block.name, multiple: blocks.length > 1 }));
      } catch {
        // A block that can't run has nothing to record; its own rendering shows why.
      }
    }
    const keys = Object.keys(all);
    if (keys.length === 0) {
      if (announce) new Notice('This note has no strategy that runs, so there is nothing to save.');
      return;
    }
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      // Writing equal values again would touch the file on every render.
      for (const k of keys) if (fm[k] !== all[k]) fm[k] = all[k];
    });
    if (announce) new Notice(`Saved ${keys.length} figures to this note's properties.`);
  }

  private async renderComparison(source: string, el: HTMLElement, child: MarkdownRenderChild, notePath: string): Promise<void> {
    const { entries, errors } = parseCompare(source);
    if (errors.length) {
      renderCompareErrors(el, errors, source);
      return;
    }
    renderCompareMessage(el, `Running ${entries.length} strategies…`);
    try {
      const curves: Curve[] = [];
      for (const entry of entries) {
        const file = this.app.metadataCache.getFirstLinkpathDest(entry.link.replace(/\.md$/i, ''), notePath);
        if (!file) throw new Error(`Line ${entry.line}: there is no note called "${entry.link}".`);
        const blocks = extractBlocks(await this.app.vault.cachedRead(file));
        const block = entry.block === null ? blocks[0] : blocks.find((b) => b.name?.toLowerCase() === entry.block!.toLowerCase());
        if (!block) {
          throw new Error(entry.block === null ? `Line ${entry.line}: "${file.basename}" has no strategy block.` : `Line ${entry.line}: "${file.basename}" has no strategy named "${entry.block}".`);
        }
        let out: RunOutput;
        try {
          out = await this.runSource(block.source, false);
        } catch (e) {
          throw new Error(`Line ${entry.line}: "${block.name ?? file.basename}" couldn't run. ${e instanceof Error ? e.message : String(e)}`);
        }
        curves.push({ label: entry.label ?? block.name ?? file.basename, t: out.backtest.run.t, equity: out.backtest.run.equity });
      }
      el.replaceChildren();
      const weights = entries.every((e) => e.weight !== null) ? entries.map((e) => e.weight!) : null;
      child.register(renderCompare(el, { curves, weights, capital: this.settings.capital }));
    } catch (e) {
      renderCompareMessage(el, e instanceof Error ? e.message : String(e));
    }
  }

  private openOrders(): void {
    const scan = async (force: boolean, onProgress: (done: number, total: number) => void): Promise<StrategyStatus[]> => {
      const found: { note: string; name: string; source: string }[] = [];
      for (const file of this.app.vault.getMarkdownFiles()) {
        const text = await this.app.vault.cachedRead(file);
        if (!text.includes('strategy')) continue;
        extractBlocks(text).forEach((b, i, all) => found.push({ note: file.path, name: b.name ?? (all.length > 1 ? `${file.basename} ${i + 1}` : file.basename), source: b.source }));
      }
      const list: StrategyStatus[] = [];
      onProgress(0, found.length);
      for (const [i, f] of found.entries()) {
        try {
          list.push(statusFrom(f.note, f.name, await this.runSource(f.source, force), Date.now()));
        } catch (e) {
          list.push(failedStatus(f.note, f.name, e instanceof Error ? e.message : String(e)));
        }
        onProgress(i + 1, found.length);
      }
      return list;
    };
    new OrdersModal(this.app, {
      scan,
      now: () => Date.now(),
      openNote: (path) => void this.app.workspace.openLinkText(path, '', false),
      save: async (markdown) => {
        if (!this.settings.ordersNote.trim()) return null;
        const path = normalizePath(this.settings.ordersNote.trim().replace(/(\.md)?$/i, '.md'));
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) await this.app.vault.modify(existing, markdown);
        else await this.app.vault.create(path, markdown);
        return path;
      },
    }).open();
  }

  private openDraft(): void {
    const s = this.settings;
    const key = () => (s.llmSecret ? (this.app.secretStorage.getSecret(s.llmSecret) ?? '') : '');
    new DraftModal(this.app, {
      configured: () => (s.llmProvider === 'anthropic' ? key() !== '' : s.llmBaseUrl.trim() !== '' && s.llmModel.trim() !== ''),
      openSettings: () => {
        // The settings window has no public call for opening one plugin's tab.
        const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
        setting.open();
        setting.openTabById(this.manifest.id);
      },
      draft: (description, onStatus) =>
        draftStrategy(
          description,
          { provider: s.llmProvider, baseUrl: s.llmBaseUrl, model: s.llmModel || DEFAULT_MODEL[s.llmProvider], apiKey: key() },
          async (url, headers, body) => {
            const res = await requestUrl({ url, method: 'POST', headers, body, throw: false });
            return { status: res.status, text: res.text };
          },
          { defaults: defaultsFrom(s), onStatus },
        ),
      insert: (block) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) view.editor.replaceSelection(block);
        else new Notice('Open a note in editing mode first, then insert the draft.');
      },
    }).open();
  }
}
