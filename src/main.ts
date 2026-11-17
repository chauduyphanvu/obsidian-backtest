import type { EditorView } from '@codemirror/view';
import { MarkdownRenderChild, MarkdownView, Notice, Platform, Plugin, TFile, normalizePath, requestUrl, type Editor, type MarkdownPostProcessorContext } from 'obsidian';
import { compareCurves, parseCompare } from './compare.ts';
import { CsvModal } from './csv-modal.ts';
import { DASHBOARD_TEMPLATE, findStrategies as findInNotes, type FoundStrategy } from './dashboard.ts';
import { StrategySuggest, applyFixAtCursor, strategyEditor } from './editor.ts';
import { equityCsv, snapshotMarkdown, tradesCsv } from './export.ts';
import { HOUR, isIntraday } from './format.ts';
import { GalleryModal } from './gallery-modal.ts';
import { LimitError } from './limits.ts';
import { DEFAULT_MODEL, draftStrategy } from './llm.ts';
import { DraftModal } from './llm-modal.ts';
import { drawHeld } from './live-core.ts';
import { LiveView, VIEW_TYPE_LIVE, liveEditorExtension, openLivePanel, pokeLiveViews, type LiveHost } from './live-view.ts';
import { ordersSavePlan, scanOrders, type ScanHost } from './orders.ts';
import { OrdersBadge } from './orders-badge.ts';
import { OrdersModal } from './orders-view.ts';
import { PriceStore } from './price-store.ts';
import { renderActions } from './render-actions.ts';
import { renderCompare, renderCompareErrors, renderCompareMessage } from './render-compare.ts';
import { renderDashboard, type DashboardHost } from './render-dashboard.ts';
import { renderDebug } from './render-debug.ts';
import { renderPriceCharts } from './render-price.ts';
import { renderLuck } from './render-luck.ts';
import { blockStateKey, renderDefaultsChanged, renderErrors, renderFailure, renderLimit, renderLoading, renderResult, type Section } from './render.ts';
import { renderSweep } from './render-sweep.ts';
import { ResultCache, debounce, defaultsMatter } from './result-cache.ts';
import { Results } from './results.ts';
import { findBlock, setParamValues, writeValuesInNote } from './rewrite.ts';
import type { RunOutput } from './runner.ts';
import { SymbolLookup } from './symbols.ts';
import { createWithFreeName, NoteProperties, saveDatedFile } from './vault-writes.ts';
import { blockRuns, shutdownWorkers } from './worker-client.ts';
import { BacktestSettingTab } from './settings.ts';
import { defaultsFrom, normalizeSettings, type Settings } from './settings-core.ts';
import type { Defaults } from './dsl.ts';

/** Puts text at the cursor; a block starts on its own line. */
function place(editor: Editor, text: string): void {
  const atLineStart = editor.getCursor('from').ch === 0;
  editor.replaceSelection(text.startsWith('```') && !atLineStart ? `\n${text}` : text);
}

/** Blocks whose open or folded state is remembered for the session. */
const KEPT_BLOCK_STATES = 500;
/** After the last change to a setting, how long to wait before blocks on screen are told their defaults changed. */
const DEFAULTS_CHECK_MS = 400;

const idle = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

/** What a caller of `renderStrategy` says about where the block is. */
interface StrategyOptions {
  notePath: string;
  /** Run again and fetch prices again, instead of reusing a recent result. */
  force?: boolean;
  /** Writes parameter values (fractions for percentages) into the block's text. Absent where the block can't be edited. */
  apply?: (values: Record<string, number>) => Promise<void>;
  /** Keys the block's remembered open or folded state; without one it is not remembered. */
  stateKey?: string;
  /** Start folded or open, instead of following the setting. */
  compact?: boolean;
  /** Drawn in the preview panel: a failed run rejects instead of drawing its own message, and the note's properties are left alone. */
  panel?: boolean;
  /** Run without the size limits and with the longer time limit, after the reader asked for it (limits.ts). */
  anyway?: boolean;
}

export default class BacktestBlocks extends Plugin {
  settings: Settings = normalizeSettings(null);
  private prices = new PriceStore({
    files: this.app.vault.adapter,
    cacheDir: normalizePath(`${this.manifest.dir}/cache`),
    normalize: normalizePath,
    fetchText: async (url) => {
      const res = await requestUrl({ url, throw: false });
      // The services explain a bad ticker in a JSON body, which the parsers turn into a message.
      if (res.status >= 400 && !res.text.trimStart().startsWith('{')) throw new Error(`HTTP ${res.status}`);
      return res.text;
    },
  });
  private results = new Results({
    deps: () => this.prices.deps(),
    defaults: () => defaultsFrom(this.settings),
    freshForMs: () => this.settings.cacheHours * HOUR,
    modified: async (path) => (await this.app.vault.adapter.stat(normalizePath(path)))?.mtime ?? null,
  });
  /** What to run before a rendered block draws again or goes away. */
  private disposers = new WeakMap<MarkdownRenderChild, () => void>();
  private properties = new NoteProperties<TFile>({
    read: (file) => this.app.vault.cachedRead(file),
    frontmatter: (file) => this.app.metadataCache.getFileCache(file)?.frontmatter,
    processFrontMatter: (file, edit) => this.app.fileManager.processFrontMatter(file, edit),
    runSource: (source, opts) => this.results.runSource(source, opts),
    notice: (text) => void new Notice(text),
  });
  /** The scan of the vault for today's orders. */
  private orders: ScanHost = {
    clear: () => this.results.clear(),
    find: () => this.findStrategies(),
    run: (source, opts) => this.results.runSource(source, opts),
  };
  /** Whether each block was left open (true) or folded (false), for blocks drawn again within a session. */
  private blockState = new ResultCache<boolean>(KEPT_BLOCK_STATES, Infinity);
  private ordersBadge: OrdersBadge | null = null;
  private symbolLookup: SymbolLookup | null = null;
  /** The strategy blocks on screen with the defaults each was drawn with, so each can say when the settings have since changed. */
  private onScreen = new Map<MarkdownRenderChild, { source: string; drawn: Defaults; say: (changed: boolean) => void }>();
  private checkDefaults = debounce(() => {
    const now = defaultsFrom(this.settings);
    for (const block of this.onScreen.values()) block.say(defaultsMatter(block.source, block.drawn, now));
  }, DEFAULTS_CHECK_MS);

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.results.reset(this.settings.cacheHours * HOUR);
    this.addSettingTab(new BacktestSettingTab(this.app, this));

    this.registerMarkdownCodeBlockProcessor('strategy', (source, el, ctx) => {
      const child = new MarkdownRenderChild(el);
      child.register(() => this.dispose(child));
      ctx.addChild(child);
      void this.renderStrategy(source, el, child, { notePath: ctx.sourcePath, ...this.placeInNote(source, el, ctx) });
    });
    this.registerMarkdownCodeBlockProcessor('compare', (source, el, ctx) => {
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      void this.renderComparison(source, el, child, ctx.sourcePath);
    });

    this.registerMarkdownCodeBlockProcessor('backtests', (source, el, ctx) => {
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      child.register(renderDashboard(el, source, this.dashboardHost()));
    });
    this.registerView(VIEW_TYPE_LIVE, (leaf) => new LiveView(leaf, this.liveHost()));
    this.registerEditorExtension(liveEditorExtension(pokeLiveViews));

    this.registerEditorExtension(strategyEditor(() => defaultsFrom(this.settings), { lookup: () => this.lookup() }));
    this.registerEditorSuggest(
      new StrategySuggest(this.app, {
        defaults: () => defaultsFrom(this.settings),
        lookup: () => this.lookup(),
        csvColumns: (path) => this.prices.columns(path),
        csvPaths: () => this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === 'csv').map((f) => f.path),
      }),
    );

    this.registerEvent(this.app.vault.on('delete', (file) => this.prices.forgetColumns(file.path)));
    this.registerEvent(this.app.vault.on('rename', (_file, oldPath) => this.prices.forgetColumns(oldPath)));

    this.addCommand({
      id: 'insert-strategy',
      name: 'Insert strategy block',
      editorCallback: (editor) => new GalleryModal(this.app, { insert: (block) => place(editor, block) }).open(),
    });
    this.addCommand({ id: 'use-csv-file', name: 'Use a CSV file in a strategy', callback: () => this.openCsv() });
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
        if (!checking) void this.properties.saveProperties(file, true);
        return true;
      },
    });
    this.addCommand({
      id: 'clear-prices',
      name: 'Clear saved prices',
      callback: () => void this.clearPrices(),
    });
    this.addCommand({
      id: 'fix-at-cursor',
      name: 'Fix the problem at the cursor',
      editorCallback: (editor) => {
        const view = (editor as unknown as { cm?: EditorView }).cm;
        if (!view || !applyFixAtCursor(view)) new Notice('There is no fix to offer at the cursor.');
      },
    });
    this.addCommand({ id: 'open-live', name: 'Open strategy preview', callback: () => void openLivePanel(this.app) });
    this.addCommand({
      id: 'insert-dashboard',
      name: 'Insert strategy dashboard',
      editorCallback: (editor) => place(editor, DASHBOARD_TEMPLATE),
    });

    this.ordersBadge = new OrdersBadge(
      Platform.isMobile ? null : this.addStatusBarItem(),
      {
        scan: () => scanOrders(this.orders, false, () => {}),
        open: () => this.openOrders(),
        notify: (text) => void new Notice(text),
      },
      { refreshHours: () => this.settings.cacheHours },
    );
    this.addRibbonIcon('list-checks', "Show today's orders", () => this.openOrders());
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.ordersOnStartup) this.ordersBadge?.start();
    });
  }

  onunload(): void {
    this.ordersBadge?.stop();
    this.checkDefaults.cancel();
    shutdownWorkers();
    this.properties.cancel();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Defaults are part of every result's key, but the freshness window is not.
    this.results.reset(this.settings.cacheHours * HOUR);
    this.prices.ready.changed();
    // Blocks already on screen keep the defaults they were drawn with and say so; this runs once typing in a setting has paused.
    this.checkDefaults();
  }

  setOrdersBadge(on: boolean): void {
    if (on) this.ordersBadge?.start();
    else this.ordersBadge?.turnOff();
  }

  async clearPrices(): Promise<void> {
    this.prices.forget();
    this.results.clear();
    await this.prices.removeSaved();
    new Notice('Saved prices cleared. Strategy blocks fetch again when they next render.');
  }

  /** The ticker lookup while its setting is on; null means nothing is ever requested. */
  private lookup(): SymbolLookup | null {
    if (!this.settings.tickerLookup) return null;
    const deps = this.prices.deps();
    return (this.symbolLookup ??= new SymbolLookup({ now: deps.now, fetchText: deps.fetchText, sleep: deps.sleep }));
  }

  private dispose(child: MarkdownRenderChild): void {
    this.disposers.get(child)?.();
    this.disposers.delete(child);
  }

  /** What a strategy block can do because of where it sits in its note: write values back into it, and have its open or folded state remembered. */
  private placeInNote(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Pick<StrategyOptions, 'apply' | 'stateKey'> {
    const info = ctx.getSectionInfo(el);
    const found = info ? findBlock(info.text, info.lineStart, source) : null;
    if (!found) return {};
    const stateKey = blockStateKey(ctx.sourcePath, found.block.name, found.index);
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(file instanceof TFile)) return { stateKey };
    // The block's line is asked for again now: the note may have moved it since it was drawn.
    const apply = (values: Record<string, number>): Promise<void> => writeValuesInNote((edit) => this.app.vault.process(file, edit), ctx.getSectionInfo(el)?.lineStart, source, values);
    return { stateKey, apply };
  }

  private async renderStrategy(source: string, el: HTMLElement, child: MarkdownRenderChild, opts: StrategyOptions): Promise<void> {
    this.dispose(child);
    // The block's runs: drawing it again or its going away stops them, and the worker then forgets its prices.
    const runs = blockRuns();
    // While this is the child's disposer, this drawing is the block's latest and the block is still there.
    const stop = () => runs.close();
    this.disposers.set(child, stop);
    // Everything this drawing parses, runs and hands to its sections is made with the defaults it reads here, once.
    const drawing = this.results.drawing(source, runs, { anyway: opts.anyway });
    const force = opts.force ?? false;
    // In the panel a failed first run is for the panel to show, but a retry has nobody above it: it draws its own failure.
    const redraw = (more: Pick<StrategyOptions, 'force' | 'anyway'>): void => {
      // A block run without the size limits is drawn again without them, whether it was asked for now or by the result it came from.
      this.renderStrategy(source, el, child, { ...opts, anyway: drawing.anyway, ...more }).catch(showFailure);
    };
    const showFailure = (e: unknown): void => renderFailure(el, e instanceof Error ? e.message : String(e), source, () => redraw({ force: false }));
    const retry = (refetch: boolean) => () => redraw({ force: refetch });
    try {
      const { spec, errors, warnings } = drawing.parse();
      if (!spec) {
        renderErrors(el, errors, source);
        return;
      }
      const key = await this.results.resultKey(spec, source, drawing.defaults);
      if (this.disposers.get(child) !== stop) return;
      if (force || this.results.kept(key, drawing.freshForMs) === undefined) renderLoading(el, `Loading prices for ${[...spec.universe, ...spec.extras].map((a) => a.name).join(', ')}…`);
      const out = await this.results.runSpec(drawing, spec, key, force);
      // Stopped, or a kept result came back after the block was drawn again or went away.
      if (!out || this.disposers.get(child) !== stop) return;
      // A result that was run without the size limits is shown with its sliders without them too.
      drawing.follow(out);
      const sections = (shown: RunOutput): Section[] => {
        const bt = shown.backtest;
        const intraday = isIntraday(bt.run.t);
        const name = shown.spec.name ?? 'Backtest';
        // The sweep and the luck checks start from the block's own text and put values on top of it.
        const tryValues = { source, backtest: bt, parse: drawing.parse, defaults: drawing.defaults, apply: opts.apply };
        // A kept note carries the values that made its result.
        const shownSource = setParamValues(source, Object.fromEntries(shown.spec.params.map((p) => [p.name, p.value])));
        return [
          (root) =>
            renderPriceCharts(root, {
              data: shown.data,
              tickers: shown.spec.universe.map((a) => a.name),
              trades: bt.run.trades,
              from: bt.run.t[0],
              to: bt.run.t[bt.run.t.length - 1],
              intraday,
            }),
          (root) => renderDebug(root, { backtest: bt, intraday, save: (title, csv) => this.saveFile(title, 'csv', csv) }),
          (root) => renderSweep(root, tryValues),
          (root) => renderLuck(root, tryValues),
          (root) =>
            renderActions(root, [
              { label: 'Save trades as CSV', run: () => this.saveFile(`${name} trades`, 'csv', tradesCsv(bt.run.trades, intraday)) },
              { label: 'Save value history as CSV', run: () => this.saveFile(`${name} value`, 'csv', equityCsv(bt.run.t, bt.run.equity, bt.benchmark.equity, bt.benchmark.label, intraday)) },
              { label: 'Keep this result as a note', run: () => this.saveFile(`${name} result`, 'md', snapshotMarkdown({ name, source: shownSource, backtest: bt, now: Date.now() })) },
            ]),
        ];
      };
      const sliders = drawing.sliders(out);
      // The panel keeps its own view of a block, apart from the note's folded or open state.
      const stateKey = opts.panel ? undefined : (opts.stateKey ?? (spec.name ? blockStateKey(opts.notePath, spec.name, -1) : undefined));
      const drawn = renderResult(el, {
        source,
        out,
        notes: warnings,
        onRefresh: retry(true),
        sections,
        compact: opts.compact ?? this.settings.resultView === 'compact',
        remember: stateKey === undefined ? undefined : { get: () => this.blockState.get(stateKey), set: (open) => this.blockState.set(stateKey, open) },
        params: spec.params.length > 0 ? { ...sliders, apply: opts.apply } : undefined,
      });
      this.onScreen.set(child, { source, drawn: drawing.defaults, say: renderDefaultsChanged(el, () => redraw({ force: false })) });
      this.disposers.set(child, () => {
        drawn();
        runs.close();
        this.onScreen.delete(child);
      });
      // The settings may have changed while the result was on its way.
      this.checkDefaults();
      if (this.settings.writeProperties && !opts.panel) {
        const file = this.app.vault.getAbstractFileByPath(opts.notePath);
        if (file instanceof TFile) this.properties.scheduleProperties(file);
      }
    } catch (e) {
      // A drawing that was replaced or went away while it ran leaves the block to whatever replaced it.
      if (this.disposers.get(child) !== stop) return;
      // A limit is shown in the panel too, since only the block can offer to run it anyway.
      if (e instanceof LimitError) renderLimit(el, e, source, () => redraw({ force: false, anyway: true }));
      else if (opts.panel) throw e;
      else showFailure(e);
    }
  }

  private liveHost(): LiveHost {
    return {
      // One drawing at a time: a newer edit or closing the panel aborts `signal`, which stops the run, and a draw that fails lets go of it too.
      show: (source, el, { notePath, apply, signal }) => {
        const child = new MarkdownRenderChild(el);
        return drawHeld(() => this.renderStrategy(source, el, child, { notePath, apply, compact: false, panel: true }), () => this.dispose(child), signal);
      },
      pricesReady: (source) => this.pricesReady(source),
      errors: (source) => this.results.runner().parse(source).errors,
      rewrite: setParamValues,
    };
  }

  /** Whether running the block needs no download (PriceStore.pricesReady), with the settings as they are now. */
  private pricesReady(source: string): Promise<boolean> {
    return this.prices.pricesReady(source, defaultsFrom(this.settings), this.settings.cacheHours * HOUR);
  }

  /**
   * The host of a `backtests` block. `find` marks the start of a round: results are dropped once there when it is forced, and
   * prices fetched since then are fresh for the strategies after it.
   */
  private dashboardHost(): DashboardHost {
    let started = Date.now();
    return {
      find: (force) => {
        started = Date.now();
        if (force) this.results.clear();
        return this.findStrategies();
      },
      run: (source, force) => this.results.runSource(source, { background: true, ...(force ? { freshForMs: Date.now() - started } : {}) }),
      openNote: (path) => void this.app.workspace.openLinkText(path, '', false),
      now: () => Date.now(),
    };
  }

  /** Writes text to a dated file in the results folder and says where it went. */
  private saveFile(title: string, ext: string, text: string): Promise<void> {
    const { vault } = this.app;
    const files = { exists: (path: string) => vault.adapter.exists(path), createFolder: (path: string) => vault.createFolder(path), create: (path: string, text: string) => vault.create(path, text) };
    return saveDatedFile(files, normalizePath(this.settings.snapshotFolder), title, ext, text, (message) => new Notice(message));
  }

  private async renderComparison(source: string, el: HTMLElement, child: MarkdownRenderChild, notePath: string): Promise<void> {
    const { entries, errors } = parseCompare(source);
    if (errors.length) {
      renderCompareErrors(el, errors, source);
      return;
    }
    renderCompareMessage(el, `Running ${entries.length} strategies…`);
    try {
      const curves = await compareCurves(entries, {
        note: (link) => this.app.metadataCache.getFirstLinkpathDest(link, notePath),
        read: (file) => this.app.vault.cachedRead(file),
        run: (source) => this.results.runSource(source),
      });
      el.replaceChildren();
      const weights = entries.every((e) => e.weight !== null) ? entries.map((e) => e.weight!) : null;
      child.register(renderCompare(el, { curves, weights, capital: this.settings.capital }));
    } catch (e) {
      el.replaceChildren();
      renderCompareMessage(el, e instanceof Error ? e.message : String(e));
    }
  }

  /** Every strategy block in the vault. Notes Obsidian has already read and found no code in are not read again here. */
  private findStrategies(): Promise<FoundStrategy[]> {
    const { vault, metadataCache } = this.app;
    return findInNotes(vault.getMarkdownFiles(), {
      sections: (file) => {
        const cache = metadataCache.getFileCache(file);
        return cache ? (cache.sections ?? []).map((section) => section.type) : null;
      },
      read: (file) => vault.cachedRead(file),
      pause: idle,
    });
  }

  private openOrders(): void {
    new OrdersModal(this.app, {
      scan: async (force, onProgress) => {
        const list = await scanOrders(this.orders, force, onProgress);
        this.ordersBadge?.show(list);
        return list;
      },
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

  private openCsv(): void {
    const vault = this.app.vault;
    new CsvModal(this.app, {
      files: () => vault.getFiles().filter((f) => f.extension.toLowerCase() === 'csv').map((f) => f.path),
      read: (path) => vault.adapter.read(normalizePath(path)),
      create: (path, text) => createWithFreeName({ exists: (p) => vault.adapter.exists(p), create: (p, t) => vault.create(p, t) }, path, text),
      insert: (text) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.getMode() !== 'source') return false;
        place(view.editor, text);
        return true;
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
        if (view) place(view.editor, block);
        else new Notice('Open a note in editing mode first, then insert the draft.');
      },
    }).open();
  }
}
