import type { EditorView } from '@codemirror/view';
import { MarkdownRenderChild, MarkdownView, Menu, Notice, Platform, Plugin, TFile, TFolder, normalizePath, requestUrl, type Editor, type MarkdownFileInfo, type MarkdownPostProcessorContext } from 'obsidian';
import { runAccount } from './account.ts';
import { blockAt, extractBlocks, hasStrategyBlock, targetBlock, type Block } from './blocks.ts';
import { compareCurves, parseCompare, type CompareHost } from './compare.ts';
import { CsvModal } from './csv-modal.ts';
import { DASHBOARD_TEMPLATE, NOTES_PER_PAUSE, findStrategies as findInNotes, mayHoldStrategy, type FoundStrategy } from './dashboard.ts';
import { withoutQueries, type PriceFailure } from './data.ts';
import { runStep } from './diagnostics.ts';
import { StrategySuggest, applyFixAtCursor, applyParamAtCursor, strategyEditor } from './editor.ts';
import { hoverValue, type HoverValue } from './debug.ts';
import { parseSpec, type Spec } from './dsl.ts';
import type { Bars } from './types.ts';
import { applyFix, suggestion } from './fixes.ts';
import { HOUR, isoDate, plural } from './format.ts';
import { forwardLink, isForwardNote, makeForward, writeLog, type ForwardStart } from './forward.ts';
import { GalleryModal } from './gallery-modal.ts';
import { Ledgers, mergeLedgers, parseLedger, type Ledger } from './ledger.ts';
import { DEFAULT_MODEL, draftStrategy } from './llm.ts';
import { DraftModal } from './llm-modal.ts';
import { drawHeld, viewText } from './live-core.ts';
import { LiveView, VIEW_TYPE_LIVE, liveEditorExtension, openLivePanel, pokeLiveViews, type LiveHost } from './live-view.ts';
import { ordersSavePlan, scanAccounts, scanOrders, type AccountScanHost, type ListFix, type ScanHost } from './orders.ts';
import { OrdersBadge, SharedScan, type Scan } from './orders-badge.ts';
import { OrdersModal, OrdersView, VIEW_TYPE_ORDERS, openOrdersPane, type OrdersHost } from './orders-view.ts';
import { PriceStore } from './price-store.ts';
import { renderAccount, type AccountHost } from './render-account.ts';
import { renderCompare, renderCompareErrors, renderCompareMessage } from './render-compare.ts';
import { renderDashboard, type DashboardHost } from './render-dashboard.ts';
import { renderForward, type ForwardHost } from './render-forward.ts';
import { blockKeyPrefix, blockNameKeyPrefix, blockNameKeySuffix, blockStateKey, keyNote, type OldRecord } from './render.ts';
import { RenameModal } from './rename-modal.ts';
import { Results } from './results.ts';
import type { RunOutput } from './runner.ts';
import { NOTE_CHANGED, findBlock, fixBlockInNote, nameProblem, renameLinksInNote, setParamValues, setSettingInNote, setWeightsInNote, writeBlockInNote, writeInNote, writeValuesInNote } from './rewrite.ts';
import { JsonStore } from './store.ts';
import { StrategyBlocks, forwardStart, keptNote, type StrategyOptions } from './strategy-block.ts';
import { SymbolLookup } from './symbols.ts';
import { createNote, createStrategyNote, createWithFreeName, NoteProperties, saveDatedFile } from './vault-writes.ts';
import { parseCsvInWorker, shutdownWorkers } from './worker-client.ts';
import { BacktestSettingTab } from './settings.ts';
import { defaultsFrom, normalizeSettings, type Settings } from './settings-core.ts';

/** Puts text at the cursor; a block starts on its own line. */
function place(editor: Editor, text: string): void {
  const atLineStart = editor.getCursor('from').ch === 0;
  editor.replaceSelection(text.startsWith('```') && !atLineStart ? `\n${text}` : text);
}

const idle = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

/** The strategy block the cursor is in, in the note being edited. */
/** A strategy block of a note. */
interface Place {
  file: TFile;
  /** The note's text as the editor holds it. */
  text: string;
  block: Block;
  /** Its place among the note's strategy blocks. */
  index: number;
  /** The editor the note is open in, when it is. */
  view?: MarkdownView | MarkdownFileInfo;
}

interface AtCursor extends Place {
  view: MarkdownView | MarkdownFileInfo;
}

/** "the strategy", or "Trend" in quotes for a block with a name, for a message. */
const strategyLabel = (block: Block): string => (block.name === null ? 'the strategy' : `"${block.name}"`);

/** "1 link in 1 note", "3 links in 2 notes". */
const linksIn = (links: number, notes: number): string => `${links} ${links === 1 ? 'link' : 'links'} in ${notes} ${notes === 1 ? 'note' : 'notes'}`;

/** Blocks whose parse and saved prices the editor's hover keeps. */
const HOVERED_BLOCKS = 4;
const HOVER_FRESH_MS = 5 * 60_000;
/** A scan this recent is what the orders pane shows when it opens, instead of a new one. */
const RECENT_SCAN_MS = 5 * 60_000;

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
    parseCsv: parseCsvInWorker,
    sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
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
    copy: (text, what) =>
      void navigator.clipboard.writeText(text).then(
        () => new Notice(`${what[0].toUpperCase()}${what.slice(1)} is on the clipboard.`),
        (e: unknown) => new Notice(`Cannot copy ${what} to the clipboard: ${e instanceof Error ? e.message : String(e)}`),
      ),
    openSettings: () => this.openSettings(),
    openCsv: () => this.openCsv(),
    lookup: () => this.lookup(),
    scheduleProperties: (notePath) => {
      const file = this.app.vault.getAbstractFileByPath(notePath);
      if (file instanceof TFile) this.properties.scheduleProperties(file);
    },
    startForward: (input) => this.startForward(input),
    saveProperties: async (notePath) => {
      const file = this.app.vault.getAbstractFileByPath(notePath);
      if (file instanceof TFile) await this.properties.saveProperties(file, true);
    },
    showMenu: (at, items) => {
      const menu = new Menu();
      for (const item of items) {
        if (!item) menu.addSeparator();
        else menu.addItem((m) => m.setTitle(item.label).setIcon(item.icon).onClick(() => void item.run()));
      }
      const box = at.getBoundingClientRect();
      menu.showAtPosition({ x: box.right, y: box.bottom + 4, left: true }, at.ownerDocument);
    },
    oldRecord: (notePath, key, name, text) => this.oldRecord(notePath, key, name, text),
  });
  /** When the plugin loaded: a block's record that began since then was made in this session. */
  private loadedAt = Date.now();
  /** The scan of the vault for today's orders, with each result's trigger prices worked out before its runs close. */
  private orders: ScanHost = {
    clear: () => this.results.clear(),
    find: () => this.findStrategies(),
    run: (source, opts) => this.results.runSource(source, { ...opts, triggers: true }),
    triggers: (out) => this.results.triggers(out),
  };
  /** The vault's account blocks for the orders window, run after the strategies so their kept results are reused. */
  private accountScan: AccountScanHost = {
    find: () => this.findStrategies('account'),
    strategies: (note) => ({ ...this.compareHost(note), run: (source) => this.results.runSource(source, { background: true }) }),
  };
  /** The one scan of the vault for today's orders at a time, for the status bar, the orders window and the pane. */
  private scans = new SharedScan((force, onProgress) => scanOrders(this.orders, force, onProgress));
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
      void this.renderComparison(source, el, child, ctx);
    });
    this.registerMarkdownCodeBlockProcessor('account', (source, el, ctx) => {
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      child.register(renderAccount(el, source, this.accountHost(source, el, ctx)));
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
    this.registerView(VIEW_TYPE_ORDERS, (leaf) => new OrdersView(leaf, this.ordersHost()));
    this.registerEditorExtension(liveEditorExtension(pokeLiveViews));

    this.registerEditorExtension(strategyEditor(() => defaultsFrom(this.settings), { lookup: () => this.lookup(), value: (block, call) => this.hoverValue(block.join('\n'), call) }));
    this.registerEditorSuggest(
      new StrategySuggest(this.app, {
        defaults: () => defaultsFrom(this.settings),
        lookup: () => this.lookup(),
        csvColumns: (path) => this.prices.columns(path),
        csvPaths: () => this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === 'csv').map((f) => f.path),
      }),
    );

    // A result left open for days says that its prices are old once its note is shown again.
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        const view = leaf?.view;
        if (view instanceof MarkdownView && view.file) this.blocks.checkAges(view.file.path, Date.now());
      }),
    );
    this.registerEvent(this.app.vault.on('delete', (file) => this.prices.forgetColumns(file.path)));
    this.registerEvent(this.app.vault.on('rename', (_file, oldPath) => this.prices.forgetColumns(oldPath)));
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        // Only notes hold blocks, and folders hold notes.
        if (file instanceof TFile && file.extension !== 'md') return;
        const folder = file instanceof TFolder;
        void this.ledgers.rename(blockKeyPrefix(oldPath, folder), blockKeyPrefix(file.path, folder));
      }),
    );

    this.addCommand({
      id: 'insert-strategy',
      name: 'Insert strategy block',
      editorCallback: (editor) => new GalleryModal(this.app, { insert: (block) => place(editor, block) }).open(),
    });
    this.addCommand({ id: 'new-strategy-note', name: 'New strategy note', callback: () => this.newStrategyNote() });
    this.addCommand({ id: 'use-csv-file', name: 'Use a CSV file in a strategy', callback: () => this.openCsv() });
    this.addCommand({
      id: 'draft-strategy',
      name: 'Write a strategy from a description',
      callback: () => this.openDraft(),
    });
    this.addCommand({
      id: 'todays-orders',
      name: "Show today's orders",
      callback: () => this.openOrders(),
    });
    this.addCommand({ id: 'orders-pane', name: "Show today's orders in the sidebar", callback: () => void openOrdersPane(this.app) });
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
      name: 'Delete saved prices',
      callback: () => void this.clearPrices(),
    });
    this.addCommand({
      id: 'fix-at-cursor',
      name: 'Correct the problem at the cursor',
      editorCallback: (editor) => {
        const view = (editor as unknown as { cm?: EditorView }).cm;
        if (!view || !applyFixAtCursor(view)) new Notice('There is no correction for the text at the cursor.');
      },
    });
    this.addCommand({
      id: 'number-to-parameter',
      name: 'Make the number at the cursor a parameter',
      editorCallback: (editor) => {
        const view = (editor as unknown as { cm?: EditorView }).cm;
        if (!view || !applyParamAtCursor(view)) new Notice('There is no number at the cursor that can be a parameter.');
      },
    });
    this.addCommand({ id: 'open-live', name: 'Open strategy preview', callback: () => void openLivePanel(this.app) });
    this.addCommand({
      id: 'insert-dashboard',
      name: 'Insert strategy dashboard',
      editorCallback: (editor) => place(editor, DASHBOARD_TEMPLATE),
    });
    this.addCommand({
      id: 'refresh-note',
      name: 'Refresh all strategies in this note',
      checkCallback: (checking) => this.noteCommand(checking, (file, text) => void this.refreshNote(file, text)),
    });
    this.addCommand({
      id: 'fold-note',
      name: 'Fold all results in this note',
      checkCallback: (checking) => this.noteCommand(checking, (file, text) => this.openInNote(file, text, false)),
    });
    this.addCommand({
      id: 'open-note',
      name: 'Open all results in this note',
      checkCallback: (checking) => this.noteCommand(checking, (file, text) => this.openInNote(file, text, true)),
    });
    this.addCommand({
      id: 'refresh-at-cursor',
      name: 'Refresh the strategy at the cursor',
      editorCheckCallback: (checking, editor, ctx) => this.cursorCommand(checking, editor, ctx, (at) => void this.refreshAtCursor(at)),
    });
    this.addCommand({
      id: 'keep-at-cursor',
      name: 'Keep the strategy at the cursor as a note',
      editorCheckCallback: (checking, editor, ctx) => this.cursorCommand(checking, editor, ctx, (at) => void this.keepAtCursor(at)),
    });
    this.addCommand({
      id: 'forward-at-cursor',
      name: 'Start a forward test for the strategy at the cursor',
      editorCheckCallback: (checking, editor, ctx) => this.cursorCommand(checking, editor, ctx, (at) => void this.forwardAtCursor(at)),
    });
    this.addCommand({
      id: 'rename-at-cursor',
      name: 'Rename the strategy at the cursor',
      editorCheckCallback: (checking, editor, ctx) => this.cursorCommand(checking, editor, ctx, (at) => this.renameAtCursor(at)),
    });

    this.ordersBadge = new OrdersBadge(
      Platform.isMobile ? null : this.addStatusBarItem(),
      {
        scan: async () => {
          const scan = await this.scans.run(false);
          this.offerToPanes(scan);
          return scan.statuses;
        },
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
    // Obsidian does not wait for onunload, which returns nothing, so the writes can only be started here: flush queues the
    // write of every changed record before it returns.
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
    new Notice('The saved prices are deleted. Each strategy block downloads its prices again when it shows next.');
  }

  /** The ticker lookup while its setting is on; null means nothing is ever requested. */
  private lookup(): SymbolLookup | null {
    if (!this.settings.tickerLookup) return null;
    const deps = this.prices.deps();
    return (this.symbolLookup ??= new SymbolLookup({ now: deps.now, fetchText: deps.fetchText, sleep: deps.sleep }));
  }

  /** What a strategy block can do because of where it sits in its note: write values back into it, and have its open or folded state remembered. */
  private placeInNote(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Pick<StrategyOptions, 'apply' | 'restore' | 'rename' | 'stateKey' | 'blockKey'> {
    const info = ctx.getSectionInfo(el);
    const found = info ? findBlock(info.text, info.lineStart, source) : null;
    if (!found) return {};
    const stateKey = blockStateKey(ctx.sourcePath, found.block.name, found.index);
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(file instanceof TFile)) return { stateKey, blockKey: stateKey };
    // The block's line is asked for again now: the note may have moved it since it was drawn.
    const apply = (values: Record<string, number>): Promise<void> => writeValuesInNote((edit) => this.app.vault.process(file, edit), ctx.getSectionInfo(el)?.lineStart, source, values);
    const restore = (text: string): Promise<void> => writeBlockInNote((edit) => this.app.vault.process(file, edit), ctx.getSectionInfo(el)?.lineStart, source, text);
    const rename = (): void => void this.renameBlock(file, ctx.getSectionInfo(el)?.lineStart, source);
    return { stateKey, blockKey: stateKey, apply, restore, rename };
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
      defaults: () => defaultsFrom(this.settings),
      rewrite: setParamValues,
      newNote: () => this.newStrategyNote(),
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
      openBlock: (note, name, line) => this.openListed(note, name, line),
      newNote: () => this.newStrategyNote(),
      now: () => Date.now(),
      triggers: (out) => this.results.triggers(out, undefined, true),
      fix: (row) => this.blockFix(row.note, row.source, row.failure),
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
        if (!f) return { ok: false, message: 'Cannot find this note. The plugin wrote nothing.' };
        // The block's line is asked for again now: the note may have moved it since it was drawn.
        const written = await writeLog((edit) => this.app.vault.process(f, edit), ctx.getSectionInfo(el)?.lineStart, rows, through, Date.now());
        if (written.ok) new Notice(written.added > 0 ? `Added ${written.added} ${written.added === 1 ? 'bar' : 'bars'} to the log.` : 'The log contains the last bar. There is nothing to add.');
        return written;
      },
      open: (target) => this.openLink(target, ctx.sourcePath),
    };
  }

  /** A command for the whole note in the active view, in Reading view or while editing; offered only while the note has a strategy block. */
  private noteCommand(checking: boolean, run: (file: TFile, text: string) => void): boolean {
    const file = this.app.workspace.getActiveFile();
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!file || !view || view.file !== file) return false;
    const text = viewText(view);
    if (!hasStrategyBlock(text)) return false;
    if (!checking) run(file, text);
    return true;
  }

  /** Runs every strategy block of the note again with new prices (StrategyBlocks refreshNote), and says how many ran. */
  private async refreshNote(file: TFile, text: string): Promise<void> {
    const sources = extractBlocks(text).map((b) => b.source);
    const { ran } = await this.blocks.refreshNote(file.path, sources);
    const all = sources.length;
    if (ran === all) new Notice(all === 1 ? 'The plugin refreshed the strategy in this note.' : `The plugin refreshed the ${all} strategies in this note.`);
    else if (all === 1) new Notice('The strategy in this note did not run. Its block shows why.');
    else new Notice(`The plugin refreshed ${ran} of the ${all} strategies in this note. A strategy that did not run shows why on its block.`);
  }

  /** Opens, or folds, every result of the note: those on screen now, and the others when they are drawn. */
  private openInNote(file: TFile, text: string, open: boolean): void {
    this.blocks.setOpenInNote(
      file.path,
      extractBlocks(text).map((b, i) => blockStateKey(file.path, b.name, i)),
      open,
    );
  }

  /** A command for the strategy block the cursor is in; offered only while it is in one. */
  private cursorCommand(checking: boolean, editor: Editor, view: MarkdownView | MarkdownFileInfo, run: (at: AtCursor) => void): boolean {
    const file = view.file;
    if (!file) return false;
    const text = editor.getValue();
    const found = blockAt(text, editor.getCursor().line);
    if (!found) return false;
    if (!checking) run({ file, text, view, ...found });
    return true;
  }

  /**
   * Runs the block at the cursor again with new prices. While the cursor is in it, Live Preview shows its text and not its
   * result, so it runs here and the result it draws next is the new one.
   */
  private async refreshAtCursor(at: AtCursor): Promise<void> {
    const { ran, problem } = await this.blocks.refreshNote(at.file.path, [at.block.source]);
    const label = strategyLabel(at.block);
    new Notice(ran > 0 ? `The plugin refreshed ${label}.` : `Cannot refresh ${label}. ${problem ?? 'Its result shows why.'}`);
  }

  /** The block's result, kept or run now, for a command that needs no drawn result; null, and a message, when it does not run. */
  private async runAtCursor(at: AtCursor, what: string): Promise<RunOutput | null> {
    try {
      return await this.results.runSource(at.block.source);
    } catch (e) {
      new Notice(`Cannot ${what}. ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Saves the result of the block at the cursor as a note, as "Keep this result as a note" in its menu does. */
  private async keepAtCursor(at: AtCursor): Promise<void> {
    const out = await this.runAtCursor(at, `keep ${strategyLabel(at.block)} as a note`);
    if (!out) return;
    const kept = keptNote(at.block.source, out, Date.now());
    await this.saveFile(kept.title, 'md', kept.text);
  }

  /** Starts a forward test of the block at the cursor, as "Start a forward test" in its menu does. */
  private async forwardAtCursor(at: AtCursor): Promise<void> {
    const out = await this.runAtCursor(at, `start a forward test for ${strategyLabel(at.block)}`);
    if (out) await this.startForward(forwardStart(at.block.source, out, defaultsFrom(this.settings), at.file.path));
  }

  /** Asks for a new name for the block at the cursor, then gives it that name (renameStrategy). */
  private renameAtCursor(at: Place): void {
    const others = extractBlocks(at.text).filter((_, i) => i !== at.index).map((b) => b.name);
    new RenameModal(this.app, {
      current: at.block.name,
      problem: (name) => nameProblem(name, at.block.name, others),
      rename: (name) => void this.renameStrategy(at, name),
    }).open();
  }

  /** Writes the block's new name on its `name:` line, then moves its record, its remembered state and the links to it (moveStrategy). */
  private async renameStrategy(at: Place, name: string): Promise<void> {
    const { file, block, index } = at;
    try {
      // The note on disk is the one written: the editor's text, saved first, is what the block was found in.
      if (at.view instanceof MarkdownView) await at.view.save();
      await writeInNote((edit) => this.app.vault.process(file, edit), block.line, (note, line) => setSettingInNote(note, line, block.source, 'strategy', 'name', name));
    } catch (e) {
      new Notice(`Cannot rename ${strategyLabel(block)}. ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const named = block.name === null ? `The plugin gave the strategy the name "${name}".` : `The plugin renamed ${strategyLabel(block)} to "${name}".`;
    try {
      const from = blockStateKey(file.path, block.name, index);
      // A block with no name was kept by its place, which another block may have held, or which it may have left: the record that comes along is the one with its text.
      const record = block.name !== null ? from : await this.ledgers.placeRecord(from, `${blockKeyPrefix(file.path, false)}block:`, block.source);
      const { links, notes } = await this.moveStrategy(file, { key: from, name: block.name }, { key: blockStateKey(file.path, name, index), name }, record);
      new Notice(block.name === null ? named : `${named} It changed ${links > 0 ? linksIn(links, notes) : 'no links'}.`);
    } catch (e) {
      new Notice(`${named} It cannot move the record of tries or the links. ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Moves what belongs to a strategy of the note `file` from its old name to its new one: its record of tries and versions,
   * what is remembered of its result, and, when it had a name, every link to it in the vault's compare, account and forward
   * blocks and forward test notes (rewrite.ts renameLinksInNote), one write for each note. Resolves with how many links
   * changed in how many notes.
   */
  private async moveStrategy(file: TFile, from: { key: string; name: string | null }, to: { key: string; name: string }, record: string | null = from.key): Promise<{ links: number; notes: number }> {
    if (record !== null) await this.ledgers.move(record, to.key);
    this.blocks.moveState(from.key, to.key);
    const old = from.name;
    if (old === null) return { links: 0, notes: 0 };
    const { vault, metadataCache } = this.app;
    const rename = (text: string, isTarget: (link: string) => boolean) => renameLinksInNote(text, isTarget, old, to.name, isForwardNote(text));
    let links = 0;
    let notes = 0;
    let read = 0;
    for (const note of vault.getMarkdownFiles()) {
      const cache = metadataCache.getFileCache(note);
      if (!mayHoldStrategy(cache ? (cache.sections ?? []).map((section) => section.type) : null)) continue;
      if (++read % NOTES_PER_PAUSE === 0) await idle();
      const cached = await vault.cachedRead(note);
      if (!cached.toLowerCase().includes(old.toLowerCase())) continue;
      const isTarget = (link: string) => metadataCache.getFirstLinkpathDest(link, note.path)?.path === file.path;
      // Only a note with a link to change is written.
      if (rename(cached, isTarget).count === 0) continue;
      let changed = 0;
      await vault.process(note, (text) => {
        const next = rename(text, isTarget);
        changed = next.count;
        return next.text;
      });
      if (changed > 0) {
        links += changed;
        notes++;
      }
    }
    return { links, notes };
  }

  /** The editor the note `file` is open in, if any: its text is ahead of the file while typing. */
  private openView(file: TFile): MarkdownView | undefined {
    return this.app.workspace.getLeavesOfType('markdown').map((leaf) => leaf.view).find((view): view is MarkdownView => view instanceof MarkdownView && view.file === file);
  }

  /** The keys of the strategy blocks of the note at `path` now (render.ts blockStateKey), read from its editor when it is open; null when there is no such note. */
  private async blockKeysOf(path: string): Promise<string[] | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    const open = this.openView(file);
    const note = open ? viewText(open) : await this.app.vault.cachedRead(file);
    return extractBlocks(note).map((b, i) => blockStateKey(path, b.name, i));
  }

  /** Asks for a name for the block with the text `source` that opens on `line` of the note `file`, then gives it that name, as its result's button does. */
  private async renameBlock(file: TFile, line: number | undefined, source: string): Promise<void> {
    const view = this.openView(file);
    const text = view ? viewText(view) : await this.app.vault.cachedRead(file);
    const found = line === undefined ? null : findBlock(text, line, source);
    if (!found) {
      new Notice(NOTE_CHANGED);
      return;
    }
    this.renameAtCursor({ file, text, view, ...found });
  }

  /**
   * For StrategyBlocks: the record of tries that the block with the key `key`, the name `name` and the text `text` in the
   * note at `notePath` left elsewhere, with what brings it here: under its old name after a rename by hand (Ledgers
   * renamedFrom), or else in another note that it was moved or copied from (Ledgers carriedFrom).
   */
  private async oldRecord(notePath: string, key: string, name: string, text: string): Promise<OldRecord | null> {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) return null;
    const old = await this.ledgers.renamedFrom(key, blockNameKeyPrefix(notePath), async () => (await this.blockKeysOf(notePath)) ?? [], this.loadedAt, text);
    if (old) {
      return {
        kind: 'renamed',
        name: old.name,
        take: async () => {
          try {
            const { links, notes } = await this.moveStrategy(file, old, { key, name });
            new Notice(`The plugin moved the record of "${old.name}" to "${name}". It changed ${links > 0 ? linksIn(links, notes) : 'no links'}.`);
          } catch (e) {
            new Notice(`Cannot move the record of "${old.name}". ${e instanceof Error ? e.message : String(e)}`);
            throw e;
          }
        },
      };
    }
    // A block cut from a note that is open is gone from its editor at once, though the file may still hold it.
    const stillThere = async (k: string) => (await this.blockKeysOf(keyNote(k)))?.includes(k) ?? false;
    const carried = await this.ledgers.carriedFrom(key, blockNameKeySuffix(name), stillThere, this.loadedAt, text);
    if (!carried) return null;
    const from = keyNote(carried.key);
    if (carried.moved) {
      return {
        kind: 'moved',
        note: from,
        take: async () => {
          try {
            await this.ledgers.move(carried.key, key);
            new Notice(`The plugin moved the record of "${name}" from ${from} to ${notePath}. Links such as ${forwardLink(from, name)} do not change.`);
          } catch (e) {
            new Notice(`Cannot move the record of "${name}" from ${from}. ${e instanceof Error ? e.message : String(e)}`);
            throw e;
          }
        },
      };
    }
    return {
      kind: 'copied',
      note: from,
      name,
      tries: carried.tries,
      take: async () => {
        try {
          const added = await this.ledgers.copyTrials(carried.key, key);
          new Notice(
            added > 0
              ? `The plugin added ${plural(added, 'try', 'tries')} of "${name}" in ${from} to the count of "${name}" in ${notePath}.`
              : `The plugin did not add tries of "${name}" in ${from}. The count of "${name}" in ${notePath} includes them, or it started again after them.`,
          );
        } catch (e) {
          new Notice(`Cannot add the tries of "${name}" in ${from}. ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        }
      },
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
      new Notice(`Cannot start the forward test: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Writes text to a dated file in the results folder and says where it went. */
  private saveFile(title: string, ext: string, text: string): Promise<void> {
    const { vault } = this.app;
    const files = { exists: (path: string) => vault.adapter.exists(path), createFolder: (path: string) => vault.createFolder(path), create: (path: string, text: string) => vault.create(path, text) };
    return saveDatedFile(files, normalizePath(this.settings.snapshotFolder), title, ext, text, (message) => new Notice(message));
  }

  /** How a `compare` or `account` block in the note at `notePath` finds and runs the strategies it lists. */
  private compareHost(notePath: string): CompareHost<TFile> {
    return {
      note: (link) => this.app.metadataCache.getFirstLinkpathDest(link, notePath),
      read: (file) => this.app.vault.cachedRead(file),
      run: (source) => this.results.runSource(source),
    };
  }

  /**
   * Writes a change into the block drawn in `el` through the NOTE_CHANGED guard (writeInNote): `change` gets the note's
   * text and the block's line. Null when the block is not in a note that can be written.
   */
  private blockWriter(el: HTMLElement, ctx: MarkdownPostProcessorContext): ((change: (note: string, line: number) => string | null) => Promise<void>) | null {
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(file instanceof TFile) || !ctx.getSectionInfo(el)) return null;
    // The block's line is asked for again at each write: the note may have moved it since it was drawn.
    return (change) => writeInNote((edit) => this.app.vault.process(file, edit), ctx.getSectionInfo(el)?.lineStart, change);
  }

  /** What an `account` block needs: its strategies run, the broker's file, prices as they traded, and the two writes it can make to itself. */
  private accountHost(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): AccountHost {
    const write = this.blockWriter(el, ctx);
    return {
      run: (entries) => runAccount(entries, this.compareHost(ctx.sourcePath)),
      read: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(normalizePath(path)) ?? this.app.metadataCache.getFirstLinkpathDest(path, ctx.sourcePath);
        if (!(file instanceof TFile)) throw new Error(`There is no file ${path} in this vault. Write the path from the top folder of the vault, for example Broker/schwab.csv.`);
        return this.app.vault.cachedRead(file);
      },
      raw: (refs) => this.results.runner().loadRaw(refs),
      weights: write ? (weights) => write((note, line) => setWeightsInNote(note, line, source, 'account', weights)) : null,
      setting: write ? (key, value) => write((note, line) => setSettingInNote(note, line, source, 'account', key, value)) : null,
    };
  }

  private async renderComparison(source: string, el: HTMLElement, child: MarkdownRenderChild, ctx: MarkdownPostProcessorContext): Promise<void> {
    const { entries, errors } = parseCompare(source);
    if (errors.length) {
      renderCompareErrors(el, errors, source);
      return;
    }
    renderCompareMessage(el, `The plugin runs ${entries.length} strategies…`);
    try {
      const curves = await compareCurves(entries, this.compareHost(ctx.sourcePath));
      el.replaceChildren();
      const weights = entries.every((e) => e.weight !== null) ? entries.map((e) => e.weight!) : null;
      const write = this.blockWriter(el, ctx);
      const use = write ? (percents: number[]) => write((note, line) => setWeightsInNote(note, line, source, 'compare', entries.map((e, i) => ({ line: e.line, percent: percents[i] })))) : null;
      child.register(renderCompare(el, { curves, weights, capital: this.settings.capital, use }));
    } catch (e) {
      el.replaceChildren();
      renderCompareMessage(el, e instanceof Error ? e.message : String(e));
    }
  }

  /** Every strategy block in the vault, or every block of `lang`. Notes Obsidian has already read and found no code in are not read again here. */
  private findStrategies(lang = 'strategy'): Promise<FoundStrategy[]> {
    const { vault, metadataCache } = this.app;
    return findInNotes(
      vault.getMarkdownFiles(),
      {
        sections: (file) => {
          const cache = metadataCache.getFileCache(file);
          return cache ? (cache.sections ?? []).map((section) => section.type) : null;
        },
        read: (file) => vault.cachedRead(file),
        pause: idle,
      },
      lang,
    );
  }

  private openOrders(): void {
    new OrdersModal(this.app, this.ordersHost()).open();
  }

  /** What the orders window and the pane need. The status bar and the pane show the answer of each scan that one of them starts. */
  private ordersHost(): OrdersHost {
    return {
      scan: async (force, onProgress) => {
        const scan = await this.scans.run(force, onProgress);
        this.ordersBadge?.show(scan.statuses);
        this.offerToPanes(scan);
        return scan;
      },
      recent: () => this.scans.recent(RECENT_SCAN_MS),
      accounts: () => scanAccounts(this.accountScan),
      now: () => Date.now(),
      openBlock: (note, name, line, lang) => this.openListed(note, name, line, lang),
      fix: (status) => this.blockFix(status.note, status.source, status.failure),
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
      newNote: () => this.newStrategyNote(),
      openPane: () => void openOrdersPane(this.app),
    };
  }

  private offerToPanes(scan: Scan): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ORDERS)) if (leaf.view instanceof OrdersView) leaf.view.offer(scan);
  }

  /**
   * Opens the note at `path` scrolled to its block of `lang` called `name` (the one on `line` while that is still it), a
   * strategy's result drawn open. False, and nothing opened, when the note has no such block.
   */
  private async openBlock(path: string, name: string | null, line?: number, lang = 'strategy'): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const found = targetBlock(await this.app.vault.cachedRead(file), name, line ?? null, lang);
    if (!found) return false;
    if (lang === 'strategy') this.blocks.drawOpen(blockStateKey(path, found.block.name, found.index));
    // A line in the ephemeral state puts the cursor on the fence, and Live Preview then shows the block's text instead of its
    // result. A scroll moves the view alone, in Live Preview and in Reading view.
    await this.app.workspace.getLeaf(false).openFile(file, { eState: { scroll: found.block.line } });
    return true;
  }

  /** Opens a block a list names, or its note at the top when the note no longer has it. */
  private openListed(path: string, name: string, line: number | undefined, lang = 'strategy'): void {
    void this.openBlock(path, name, line, lang).then((opened) => {
      if (!opened) void this.app.workspace.openLinkText(path, '', false);
    });
  }

  /** Opens a link such as `Note#Name` at the strategy it names; another link, or one to a note without that strategy, as Obsidian does. */
  private openLink(target: string, sourcePath: string): void {
    const hash = target.indexOf('#');
    const file = hash < 0 ? null : this.app.metadataCache.getFirstLinkpathDest(target.slice(0, hash), sourcePath);
    void (file ? this.openBlock(file.path, target.slice(hash + 1)) : Promise.resolve(false)).then((opened) => {
      if (!opened) void this.app.workspace.openLinkText(target, sourcePath, false);
    });
  }

  /** Asks for a starter strategy, then makes a note of it. Works with no note open. */
  private newStrategyNote(): void {
    new GalleryModal(this.app, { insert: (block) => void this.writeStrategyNote(block) }).open();
  }

  /** Writes the block as a new note in Obsidian's folder for new notes, and opens it. */
  private async writeStrategyNote(block: string): Promise<void> {
    const { vault, workspace, fileManager } = this.app;
    const folder = fileManager.getNewFileParent(workspace.getActiveFile()?.path ?? '');
    try {
      const path = await createStrategyNote({ exists: (p) => vault.adapter.exists(p), create: (p, t) => vault.create(p, t) }, folder.isRoot() ? '' : folder.path, block);
      const file = vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return;
      const leaf = workspace.getLeaf(false);
      await leaf.openFile(file);
      // With the cursor on the fence, Live Preview shows the block's text; on the empty line after the block, its result.
      const view = leaf.view;
      if (view instanceof MarkdownView && view.getMode() === 'source') view.editor.setCursor(view.editor.lastLine(), 0);
    } catch (e) {
      new Notice(`Cannot make the note: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * The fix for a block that did not run, for a list of every block (today's orders, the dashboard): for the first problem
   * of a block that has one, the button's words, the sentence that offers it, and what writes it into the note; for a run
   * whose prices did not load, the step the block's own card offers (diagnostics.ts runStep). Null when there is none.
   */
  private blockFix(note: string, source: string | undefined, failure?: PriceFailure): ListFix | Promise<ListFix | null> | null {
    if (source === undefined) return null;
    const defaults = defaultsFrom(this.settings);
    const lines = source.split('\n');
    if (failure) {
      return runStep(lines, failure, defaults, this.lookup()).then(({ text, action }) => {
        if (!action) return text ? { text } : null;
        if (action.kind !== 'change') return { label: action.label, text, open: () => (action.kind === 'settings' ? this.openSettings() : this.openCsv()) };
        return { label: action.label, text, write: () => this.fixInNote(note, source, applyFix(lines, action.fix).join('\n')) };
      });
    }
    for (const e of this.results.runner().parse(source).errors) {
      const offered = suggestion(lines, e, defaults);
      if (offered) return { label: offered.fix.label, text: offered.text, write: () => this.fixInNote(note, source, applyFix(lines, offered.fix).join('\n')) };
    }
    return null;
  }

  /** Each block text the editor's hover read lately, parsed and with its saved prices; newest last. */
  private hovered = new Map<string, { at: number; read: Promise<{ spec: Spec; data: Map<string, Bars> } | null> }>();

  /** The value of a part of a block's rules on its ticker, from the saved prices only, for the editor's hover. */
  private async hoverValue(source: string, call: string): Promise<HoverValue | null> {
    const kept = this.hovered.get(source);
    // Prices saved since are read again after a while, so a hover in a long session is not days behind.
    let read = kept && Date.now() - kept.at < HOVER_FRESH_MS ? kept.read : null;
    if (!read) {
      const defaults = defaultsFrom(this.settings);
      const { spec } = parseSpec(source, { defaults });
      read = spec ? this.prices.savedData(spec, defaults).then((data) => (data ? { spec, data } : null)) : Promise.resolve(null);
      this.hovered.delete(source);
      this.hovered.set(source, { at: Date.now(), read });
      // A few blocks are kept: the ones being edited.
      for (const key of this.hovered.keys()) if (this.hovered.size > HOVERED_BLOCKS) this.hovered.delete(key);
    }
    const got = await read;
    return got ? hoverValue(got.spec, got.data, call) : null;
  }

  /** Writes a fixed block into its note, found by its text, for a list that does not know where the block is. */
  private async fixInNote(path: string, source: string, text: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`The note ${path} is not in the vault.`);
    let written = false;
    await this.app.vault.process(file, (note) => {
      const next = fixBlockInNote(note, source, text);
      written = next !== null;
      return next ?? note;
    });
    if (!written) throw new Error('The block changed, or the note has two blocks with the same text. Open the note and fix the block there.');
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

  /** Opens the settings window at the plugin's tab. */
  private openSettings(): void {
    // The settings window has no public call for opening one plugin's tab.
    const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  private openDraft(): void {
    const s = this.settings;
    const key = () => (s.llmSecret ? (this.app.secretStorage.getSecret(s.llmSecret) ?? '') : '');
    new DraftModal(this.app, {
      configured: () => (s.llmProvider === 'anthropic' ? key() !== '' : s.llmBaseUrl.trim() !== '' && s.llmModel.trim() !== ''),
      openSettings: () => this.openSettings(),
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
        else new Notice('Open a note in the editor. Then insert the draft.');
      },
    }).open();
  }
}
