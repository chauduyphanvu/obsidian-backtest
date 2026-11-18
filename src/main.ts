import type { EditorView } from '@codemirror/view';
import { MarkdownRenderChild, MarkdownView, Notice, Platform, Plugin, TFile, TFolder, normalizePath, requestUrl, type Editor, type MarkdownPostProcessorContext } from 'obsidian';
import { compareCurves, parseCompare } from './compare.ts';
import { CsvModal } from './csv-modal.ts';
import { DASHBOARD_TEMPLATE, findStrategies as findInNotes, type FoundStrategy } from './dashboard.ts';
import { withoutQueries } from './data.ts';
import { StrategySuggest, applyFixAtCursor, strategyEditor } from './editor.ts';
import { HOUR, isoDate } from './format.ts';
import { makeForward, writeLog, type ForwardStart } from './forward.ts';
import { GalleryModal } from './gallery-modal.ts';
import { Ledgers, mergeLedgers, parseLedger, type Ledger } from './ledger.ts';
import { DEFAULT_MODEL, draftStrategy } from './llm.ts';
import { DraftModal } from './llm-modal.ts';
import { drawHeld } from './live-core.ts';
import { LiveView, VIEW_TYPE_LIVE, liveEditorExtension, openLivePanel, pokeLiveViews, type LiveHost } from './live-view.ts';
import { ordersSavePlan, scanOrders, type ScanHost } from './orders.ts';
import { OrdersBadge } from './orders-badge.ts';
import { OrdersModal } from './orders-view.ts';
import { PriceStore } from './price-store.ts';
import { renderCompare, renderCompareErrors, renderCompareMessage } from './render-compare.ts';
import { renderDashboard, type DashboardHost } from './render-dashboard.ts';
import { renderForward, type ForwardHost } from './render-forward.ts';
import { blockKeyPrefix, blockStateKey } from './render.ts';
import { Results } from './results.ts';
import { findBlock, setParamValues, writeBlockInNote, writeValuesInNote } from './rewrite.ts';
import { JsonStore } from './store.ts';
import { StrategyBlocks, type StrategyOptions } from './strategy-block.ts';
import { SymbolLookup } from './symbols.ts';
import { createNote, createWithFreeName, NoteProperties, saveDatedFile } from './vault-writes.ts';
import { shutdownWorkers } from './worker-client.ts';
import { BacktestSettingTab } from './settings.ts';
import { defaultsFrom, normalizeSettings, type Settings } from './settings-core.ts';

/** Puts text at the cursor; a block starts on its own line. */
function place(editor: Editor, text: string): void {
  const atLineStart = editor.getCursor('from').ch === 0;
  editor.replaceSelection(text.startsWith('```') && !atLineStart ? `\n${text}` : text);
}

const idle = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

export default class BacktestBlocks extends Plugin {
  settings: Settings = normalizeSettings(null);
  private prices = new PriceStore({
    files: this.app.vault.adapter,
    cacheDir: normalizePath(`${this.manifest.dir}/cache`),
    normalize: normalizePath,
    fetchText: async (url, headers) => {
      let res;
      try {
        res = await requestUrl({ url, headers, throw: false });
      } catch (e) {
        // FRED takes its key in the query, and a network error can quote the address.
        throw new Error(withoutQueries(e instanceof Error ? e.message : String(e)));
      }
      // The services explain a bad ticker in a JSON body, which the parsers turn into a message.
      if (res.status >= 400 && !res.text.trimStart().startsWith('{')) throw new Error(`HTTP ${res.status}`);
      return res.text;
    },
    secret: (service) => {
      const name = service === 'fred' ? this.settings.fredSecret : this.settings.tiingoSecret;
      return name ? this.app.secretStorage.getSecret(name) : null;
    },
    tiingoFallback: () => this.settings.tiingoFallback,
  });
  private results = new Results({
    deps: () => this.prices.deps(),
    defaults: () => defaultsFrom(this.settings),
    freshForMs: () => this.settings.cacheHours * HOUR,
    modified: async (path) => (await this.app.vault.adapter.stat(normalizePath(path)))?.mtime ?? null,
  });
  private properties = new NoteProperties<TFile>({
    read: (file) => this.app.vault.cachedRead(file),
    frontmatter: (file) => this.app.metadataCache.getFileCache(file)?.frontmatter,
    processFrontMatter: (file, edit) => this.app.fileManager.processFrontMatter(file, edit),
    runSource: (source, opts) => this.results.runSource(source, opts),
    notice: (text) => void new Notice(text),
  });
  /** Each strategy block's record of tries and versions, one file for each block in the plugin's folder. */
  private ledgerFiles = new JsonStore<Ledger>({
    files: this.app.vault.adapter,
    dir: `${this.manifest.dir}/ledger`,
    normalize: normalizePath,
    parse: parseLedger,
    merge: mergeLedgers,
  });
  private ledgers = new Ledgers(this.ledgerFiles);
  /** The strategy blocks on screen. */
  private blocks = new StrategyBlocks({
    results: this.results,
    ledgers: this.ledgers,
    settings: () => this.settings,
    saveFile: (title, ext, text) => this.saveFile(title, ext, text),
    scheduleProperties: (notePath) => {
      const file = this.app.vault.getAbstractFileByPath(notePath);
      if (file instanceof TFile) this.properties.scheduleProperties(file);
    },
    startForward: (input) => this.startForward(input),
  });
  /** The scan of the vault for today's orders. */
  private orders: ScanHost = {
    clear: () => this.results.clear(),
    find: () => this.findStrategies(),
    run: (source, opts) => this.results.runSource(source, opts),
  };
  private ordersBadge: OrdersBadge | null = null;
  private symbolLookup: SymbolLookup | null = null;
  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.results.reset(this.settings.cacheHours * HOUR);
    this.addSettingTab(new BacktestSettingTab(this.app, this));

    this.registerMarkdownCodeBlockProcessor('strategy', (source, el, ctx) => {
      const child = new MarkdownRenderChild(el);
      child.register(() => this.blocks.dispose(child));
      ctx.addChild(child);
      void this.blocks.renderStrategy(source, el, child, { notePath: ctx.sourcePath, ...this.placeInNote(source, el, ctx) });
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
    this.registerMarkdownCodeBlockProcessor('forward', (source, el, ctx) => {
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      child.register(renderForward(el, source, this.forwardHost(el, ctx)));
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
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        const folder = file instanceof TFolder;
        void this.ledgers.rename(blockKeyPrefix(oldPath, folder), blockKeyPrefix(file.path, folder));
      }),
    );

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
    this.blocks.checkDefaults.cancel();
    shutdownWorkers();
    this.properties.cancel();
    void this.ledgerFiles.flush();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Defaults are part of every result's key, but the freshness window is not.
    this.results.reset(this.settings.cacheHours * HOUR);
    this.prices.ready.changed();
    // Blocks already on screen keep the defaults they were drawn with and say so; this runs once typing in a setting has paused.
    this.blocks.checkDefaults();
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

  /** What a strategy block can do because of where it sits in its note: write values back into it, and have its open or folded state remembered. */
  private placeInNote(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Pick<StrategyOptions, 'apply' | 'restore' | 'stateKey' | 'blockKey'> {
    const info = ctx.getSectionInfo(el);
    const found = info ? findBlock(info.text, info.lineStart, source) : null;
    if (!found) return {};
    const stateKey = blockStateKey(ctx.sourcePath, found.block.name, found.index);
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(file instanceof TFile)) return { stateKey, blockKey: stateKey };
    // The block's line is asked for again now: the note may have moved it since it was drawn.
    const apply = (values: Record<string, number>): Promise<void> => writeValuesInNote((edit) => this.app.vault.process(file, edit), ctx.getSectionInfo(el)?.lineStart, source, values);
    const restore = (text: string): Promise<void> => writeBlockInNote((edit) => this.app.vault.process(file, edit), ctx.getSectionInfo(el)?.lineStart, source, text);
    return { stateKey, blockKey: stateKey, apply, restore };
  }

  private liveHost(): LiveHost {
    return {
      // One drawing at a time: a newer edit or closing the panel aborts `signal`, which stops the run, and a draw that fails lets go of it too.
      show: (source, el, { notePath, blockKey, apply, signal }) => {
        const child = new MarkdownRenderChild(el);
        return drawHeld(() => this.blocks.renderStrategy(source, el, child, { notePath, blockKey, apply, compact: false, panel: true }), () => this.blocks.dispose(child), signal);
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

  /** What a `forward` block needs: its note, the frozen rules run like any block's, and the one write it can make, to its log. */
  private forwardHost(el: HTMLElement, ctx: MarkdownPostProcessorContext): ForwardHost {
    const file = () => {
      const found = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      return found instanceof TFile ? found : null;
    };
    return {
      note: async () => {
        const f = file();
        return f ? { text: await this.app.vault.read(f), line: ctx.getSectionInfo(el)?.lineStart } : null;
      },
      run: (source, force) => this.results.runSource(source, { force }),
      append: async (rows, through) => {
        const f = file();
        if (!f) return { ok: false, message: 'This note can no longer be found, so nothing was written.' };
        // The block's line is asked for again now: the note may have moved it since it was drawn.
        const written = await writeLog((edit) => this.app.vault.process(f, edit), ctx.getSectionInfo(el)?.lineStart, rows, through, Date.now());
        if (written.ok) new Notice(written.added > 0 ? `Added ${written.added} ${written.added === 1 ? 'bar' : 'bars'} to the log.` : 'The log is checked through the last bar.');
        return written;
      },
      open: (target) => void this.app.workspace.openLinkText(target, ctx.sourcePath, false),
    };
  }

  /** Writes a note for a forward test of the strategy to the "Forward" folder under the results folder, and opens it in a new tab. */
  private async startForward(input: ForwardStart): Promise<void> {
    const made = makeForward(input);
    if (!made.ok) {
      new Notice(made.message);
      return;
    }
    const { vault } = this.app;
    const files = { exists: (path: string) => vault.adapter.exists(path), createFolder: (path: string) => vault.createFolder(path), create: (path: string, text: string) => vault.create(path, text) };
    try {
      const path = await createNote(files, normalizePath(`${this.settings.snapshotFolder}/Forward`), `${input.name} forward test ${isoDate(input.started)}`, made.note);
      new Notice(`Started a forward test in ${path}`);
      void this.app.workspace.openLinkText(path, '', true);
    } catch (e) {
      new Notice(`Couldn't start the forward test: ${e instanceof Error ? e.message : String(e)}`);
    }
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
