import { MarkdownRenderChild, MarkdownView, Notice, Plugin, TFile, normalizePath, requestUrl } from 'obsidian';
import { extractBlocks } from './blocks.ts';
import { cashIndex, parseCompare, type Curve } from './compare.ts';
import type { DataDeps } from './data.ts';
import { DAY, isoDate } from './dom.ts';
import { StrategySuggest, strategyEditor } from './editor.ts';
import { equityCsv, planProperties, propertyIds, resultProperties, snapshotMarkdown, tradesCsv } from './export.ts';
import { DEFAULT_MODEL, draftStrategy } from './llm.ts';
import { DraftModal } from './llm-modal.ts';
import type { Spec } from './dsl.ts';
import { failedStatus, mapLimit, ordersSavePlan, statusFrom, type StrategyStatus } from './orders.ts';
import { OrdersModal } from './orders-view.ts';
import { renderActions } from './render-actions.ts';
import { renderCompare, renderCompareErrors, renderCompareMessage } from './render-compare.ts';
import { renderPriceCharts } from './render-price.ts';
import { renderLuck } from './render-luck.ts';
import { renderErrors, renderFailure, renderLoading, renderResult, type Section } from './render.ts';
import { renderSweep } from './render-sweep.ts';
import { ResultCache, cacheKey, csvPaths, csvVersions, debounce } from './result-cache.ts';
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
/** How long after the last block of a note renders its properties are written, so a note with several blocks is written once. */
const PROPERTY_DELAY = 1000;
/** Strategies run side by side when today's orders are worked out. */
const ORDERS_CONCURRENCY = 3;
/** Notes read between pauses that let the window redraw. */
const NOTES_PER_PAUSE = 50;

const idle = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

export default class BacktestBlocks extends Plugin {
  settings: Settings = normalizeSettings(null);
  private memory = new Map<string, string>();
  private results = new ResultCache<RunOutput>(KEPT_RESULTS, 6 * HOUR);
  private dataDeps: DataDeps | null = null;
  /** What to run before a rendered block draws again or goes away. */
  private disposers = new WeakMap<MarkdownRenderChild, () => void>();
  private propertyWrites = new Map<string, { (): void; cancel(): void }>();

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.results = new ResultCache<RunOutput>(KEPT_RESULTS, this.settings.cacheHours * HOUR);
    this.addSettingTab(new BacktestSettingTab(this.app, this));

    this.registerMarkdownCodeBlockProcessor('strategy', (source, el, ctx) => {
      const child = new MarkdownRenderChild(el);
      child.register(() => this.dispose(child));
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

  onunload(): void {
    for (const write of this.propertyWrites.values()) write.cancel();
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

  private runner(freshForMs = this.settings.cacheHours * HOUR): Runner {
    return new Runner(this.deps(), defaultsFrom(this.settings), { freshForMs });
  }

  /** A result's key: the strategy's text, the defaults, and the version of every CSV file it reads. */
  private async resultKey(spec: Spec, source: string): Promise<string> {
    const adapter = this.app.vault.adapter;
    const files = await csvVersions(csvPaths(spec), async (path) => (await adapter.stat(normalizePath(path)))?.mtime ?? null);
    return cacheKey(source, defaultsFrom(this.settings), files);
  }

  private async runSpec(runner: Runner, spec: Spec, key: string, force: boolean): Promise<RunOutput> {
    if (!force) {
      const hit = this.results.get(key);
      if (hit) return hit;
    }
    const out = await runner.run(spec, force);
    this.results.set(key, out);
    return out;
  }

  /**
   * Runs a block's text, reusing a recent result for the same text, defaults and CSV files. A block that does not parse rejects
   * with its first problem. With `cachedOnly` nothing runs: a block with no kept result rejects.
   */
  private async runSource(source: string, opts: { force?: boolean; runner?: Runner; cachedOnly?: boolean } = {}): Promise<RunOutput> {
    const runner = opts.runner ?? this.runner();
    const { spec, errors } = runner.parse(source);
    if (!spec) throw new Error(`Line ${errors[0].line}: ${errors[0].message}`);
    const key = await this.resultKey(spec, source);
    if (opts.cachedOnly) {
      const hit = this.results.get(key);
      if (!hit) throw new Error('This strategy has not run yet.');
      return hit;
    }
    return this.runSpec(runner, spec, key, opts.force ?? false);
  }

  private dispose(child: MarkdownRenderChild): void {
    this.disposers.get(child)?.();
    this.disposers.delete(child);
  }

  private async renderStrategy(source: string, el: HTMLElement, child: MarkdownRenderChild, notePath: string, force: boolean): Promise<void> {
    this.dispose(child);
    const runner = this.runner();
    const defaults = defaultsFrom(this.settings);
    const retry = (refetch: boolean) => () => void this.renderStrategy(source, el, child, notePath, refetch);
    try {
      const { spec, errors, warnings } = runner.parse(source);
      if (!spec) {
        renderErrors(el, errors, source);
        return;
      }
      const key = await this.resultKey(spec, source);
      if (force || this.results.get(key) === undefined) renderLoading(el, `Loading prices for ${[...spec.universe, ...spec.extras].map((a) => a.name).join(', ')}…`);
      const out = await this.runSpec(runner, spec, key, force);
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
        (root) => renderSweep(root, { source, backtest: bt, parse: (overrides) => runner.parse(source, overrides), defaults }),
        (root) => renderLuck(root, { source, backtest: bt, parse: (overrides) => runner.parse(source, overrides), defaults }),
        (root) =>
          renderActions(root, [
            { label: 'Save trades as CSV', run: () => this.saveFile(`${name} trades`, 'csv', tradesCsv(bt.run.trades, intraday)) },
            { label: 'Save value history as CSV', run: () => this.saveFile(`${name} value`, 'csv', equityCsv(bt.run.t, bt.run.equity, bt.benchmark.equity, bt.benchmark.label, intraday)) },
            { label: 'Keep this result as a note', run: () => this.saveFile(`${name} result`, 'md', snapshotMarkdown({ name, source, backtest: bt, now: Date.now() })) },
          ]),
      ];
      this.disposers.set(child, renderResult(el, { source, out, notes: warnings, onRefresh: retry(true), sections }));
      if (this.settings.writeProperties) {
        const file = this.app.vault.getAbstractFileByPath(notePath);
        if (file instanceof TFile) this.scheduleProperties(file);
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

  /** Writes a note's properties once, a moment after the last of its blocks has rendered. */
  private scheduleProperties(file: TFile): void {
    const path = file.path;
    let write = this.propertyWrites.get(path);
    if (!write) {
      write = debounce(() => {
        this.propertyWrites.delete(path);
        void this.saveProperties(file, false);
      }, PROPERTY_DELAY);
      this.propertyWrites.set(path, write);
    }
    write();
  }

  /**
   * Stores the main figures of every strategy in a note in that note's properties. Only strategies that have a result are
   * written; when asked for (`announce`), strategies run first, otherwise nothing runs here.
   */
  private async saveProperties(file: TFile, announce: boolean): Promise<void> {
    const blocks = extractBlocks(await this.app.vault.cachedRead(file));
    const ids = propertyIds(blocks.map((b) => b.name));
    const produced: Record<string, string | number> = {};
    let ran = 0;
    for (const [i, block] of blocks.entries()) {
      try {
        const out = await this.runSource(block.source, { cachedOnly: !announce });
        Object.assign(produced, resultProperties(out.backtest, Date.now(), ids[i]));
        ran++;
      } catch {
        // A block that can't run has nothing to record; its own rendering shows why.
      }
    }
    if (ran === 0) {
      if (announce) new Notice('This note has no strategy that runs, so there is nothing to save.');
      return;
    }
    const complete = ran === blocks.length;
    const none = (plan: ReturnType<typeof planProperties>) => Object.keys(plan.set).length === 0 && plan.remove.length === 0;
    if (none(planProperties(this.app.metadataCache.getFileCache(file)?.frontmatter, produced, complete))) {
      if (announce) new Notice("This note's properties are already up to date.");
      return;
    }
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      const plan = planProperties(fm, produced, complete);
      for (const k of plan.remove) delete fm[k];
      Object.assign(fm, plan.set);
    });
    if (announce) {
      const missed = blocks.length - ran;
      new Notice(`Saved ${Object.keys(produced).length} figures to this note's properties.${missed > 0 ? ` ${missed} of ${blocks.length} strategies couldn't run, so figures from earlier runs were kept.` : ''}`);
    }
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
          out = await this.runSource(block.source);
        } catch (e) {
          throw new Error(`Line ${entry.line}: "${block.name ?? file.basename}" couldn't run. ${e instanceof Error ? e.message : String(e)}`);
        }
        const { run } = out.backtest;
        curves.push({ label: entry.label ?? block.name ?? file.basename, t: run.t, equity: run.equity, cash: cashIndex(run.cashReturn) });
      }
      el.replaceChildren();
      const weights = entries.every((e) => e.weight !== null) ? entries.map((e) => e.weight!) : null;
      child.register(renderCompare(el, { curves, weights, capital: this.settings.capital }));
    } catch (e) {
      el.replaceChildren();
      renderCompareMessage(el, e instanceof Error ? e.message : String(e));
    }
  }

  /** Every strategy block in the vault. Pauses now and then so a large vault does not freeze the window. */
  private async findStrategies(): Promise<{ note: string; name: string; source: string }[]> {
    const found: { note: string; name: string; source: string }[] = [];
    let read = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (++read % NOTES_PER_PAUSE === 0) await idle();
      const text = await this.app.vault.cachedRead(file);
      if (!text.includes('strategy')) continue;
      extractBlocks(text).forEach((b, i, all) => found.push({ note: file.path, name: b.name ?? (all.length > 1 ? `${file.basename} ${i + 1}` : file.basename), source: b.source }));
    }
    return found;
  }

  private openOrders(): void {
    const scan = async (force: boolean, onProgress: (done: number, total: number) => void): Promise<StrategyStatus[]> => {
      const started = Date.now();
      // Results are dropped so every strategy runs again. A price fetched since the scan began is fresh for the strategies
      // that come after, so each ticker is downloaded once however many strategies use it.
      if (force) this.results.clear();
      const found = await this.findStrategies();
      let done = 0;
      onProgress(0, found.length);
      return mapLimit(found, ORDERS_CONCURRENCY, async (f) => {
        let status: StrategyStatus;
        try {
          const runner = force ? this.runner(Date.now() - started) : undefined;
          status = statusFrom(f.note, f.name, await this.runSource(f.source, { runner }), Date.now());
        } catch (e) {
          status = failedStatus(f.note, f.name, e instanceof Error ? e.message : String(e));
        }
        onProgress(++done, found.length);
        return status;
      });
    };
    new OrdersModal(this.app, {
      scan,
      now: () => Date.now(),
      openNote: (path) => void this.app.workspace.openLinkText(path, '', false),
      save: async (markdown) => {
        if (!this.settings.ordersNote.trim()) return { kind: 'none' };
        const path = normalizePath(this.settings.ordersNote.trim().replace(/(\.md)?$/i, '.md'));
        const existing = this.app.vault.getAbstractFileByPath(path);
        const plan = ordersSavePlan(existing instanceof TFile ? await this.app.vault.read(existing) : null);
        if (plan === 'refuse') return { kind: 'refused', path };
        if (existing instanceof TFile) await this.app.vault.modify(existing, markdown);
        else await this.app.vault.create(path, markdown);
        return { kind: 'saved', path };
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
