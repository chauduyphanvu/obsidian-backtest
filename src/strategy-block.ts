// A strategy block's drawings: parsing it, running it or reusing a kept result, drawing the result with its sections, and
// what a drawing leaves behind (its runs, its sections, its place among the blocks on screen) until the block is drawn
// again or goes away. The plugin says where each block is and hands in the settings, the results and the vault writes.

import { priceFailure } from './data.ts';
import { runStep, type RunStep } from './diagnostics.ts';
import type { Defaults } from './dsl.ts';
import { easeHeight } from './dom.ts';
import { equityCsv, resultMarkdown, snapshotMarkdown, tradesCsv } from './export.ts';
import { isIntraday } from './format.ts';
import { applyFix } from './fixes.ts';
import { forwardLink, type ForwardStart } from './forward.ts';
import { trialOf, versionFigures, type Ledgers } from './ledger.ts';
import { LimitError } from './limits.ts';
import type { Action, MenuItems } from './render-actions.ts';
import type { TrackPaint } from './render-params.ts';
import { renderDebug } from './render-debug.ts';
import { renderLuck, renderTriesNote } from './render-luck.ts';
import { renderPriceCharts } from './render-price.ts';
import { renderRegimes } from './render-regimes.ts';
import { renderSweep } from './render-sweep.ts';
import { renderVersions } from './render-versions.ts';
import { blockStateKey, renderDefaultsChanged, renderErrors, renderFailure, renderLimit, renderLoading, renderRenamed, renderResult, type DrawnResult, type Loading, type NextAction, type Section, type ViewState } from './render.ts';
import { ResultCache, debounce, defaultsMatter } from './result-cache.ts';
import type { Results } from './results.ts';
import { setParamValues } from './rewrite.ts';
import type { RunOutput } from './runner.ts';
import { defaultsFrom, type Settings } from './settings-core.ts';
import type { SymbolLookup } from './symbols.ts';
import { blockRuns } from './worker-client.ts';

/** Blocks whose open or folded state is remembered for the session. */
const KEPT_BLOCK_STATES = 500;
/** Texts of blocks whose result has been on screen in this session, so drawing one again does not play its arrival. */
const KEPT_SHOWN = 2000;
/** After the last change to a setting, how long to wait before blocks on screen are told their defaults changed. */
const DEFAULTS_CHECK_MS = 400;

/** What a caller of `renderStrategy` says about where the block is. */
export interface StrategyOptions {
  notePath: string;
  /** Run again and fetch prices again, instead of reusing a recent result. */
  force?: boolean;
  /** Writes parameter values (fractions for percentages) into the block's text. Absent where the block can't be edited. */
  apply?: (values: Record<string, number>) => Promise<void>;
  /** Writes a whole text in place of the block's, for restoring a version. Absent where the block can't be edited. */
  restore?: (text: string) => Promise<void>;
  /** Keys the block's remembered open or folded state; without one it is not remembered. */
  stateKey?: string;
  /** Which block of which note this is (render.ts blockStateKey), the same in the note and in the preview panel; absent when that can't be told. */
  blockKey?: string;
  /** Start folded or open, instead of following the setting. */
  compact?: boolean;
  /** Drawn in the preview panel: a failed run rejects instead of drawing its own message, and the note's properties are left alone. */
  panel?: boolean;
  /** Run without the size limits and with the longer time limit, after the reader asked for it (limits.ts). */
  anyway?: boolean;
  /** Keep the result on screen until the new one is ready, as a refresh does, instead of the shape of a result. */
  inPlace?: boolean;
}

export interface BlocksHost {
  results: Results;
  /** The settings as they are now. */
  settings(): Settings;
  /** Writes text to a dated file in the results folder and says where it went. */
  saveFile(title: string, ext: string, text: string): Promise<void>;
  /** Puts text on the clipboard and says so; `what` names it in that message ("the result"). */
  copy(text: string, what: string): void;
  /** Opens the plugin's tab of the settings, for a run that failed for an API key. */
  openSettings(): void;
  /** Opens the CSV helper ("Use a CSV file in a strategy"), for a run that failed for a CSV file that is not there. */
  openCsv(): void;
  /** The ticker lookup while the setting "Find tickers while you type" is on; null means nothing is requested. */
  lookup(): SymbolLookup | null;
  /** Writes the properties of the note at `notePath` a moment after the last of its blocks has rendered. */
  scheduleProperties(notePath: string): void;
  /** Each block's record of tries and versions, by its `blockKey`. */
  ledgers?: Ledgers;
  /** Writes a forward test note for the strategy and opens it, or says why it could not. */
  startForward(input: ForwardStart): Promise<void>;
  /** Writes the results of the note at `notePath` to its properties now. */
  saveProperties(notePath: string): Promise<void>;
  /** Opens a menu of `items` under the element `at`. */
  showMenu(at: HTMLElement, items: MenuItems): void;
  /**
   * For a block drawn in its note with the key `key`, the name `name` and the text `text`: the old name its record of tries
   * and its links still use after a rename by hand, and the move that takes them to `name`; null when there is no clear
   * sign of one.
   */
  renamedFrom?(notePath: string, key: string, name: string, text: string): Promise<{ name: string; move(): Promise<void> } | null>;
}

/** The block's text with the values of the run on screen written into it, as a kept note and a forward test carry it. */
const shownText = (source: string, shown: RunOutput): string => setParamValues(source, Object.fromEntries(shown.spec.params.map((p) => [p.name, p.value])));

/** What "Keep this result as a note" saves for the run `shown` of the block `source`: the file's title and its text. */
export function keptNote(source: string, shown: RunOutput, now: number): { title: string; text: string } {
  const name = shown.spec.name ?? 'Backtest';
  return { title: `${name} result`, text: snapshotMarkdown({ name, source: shownText(source, shown), backtest: shown.backtest, now }) };
}

/** What "Start a forward test" starts from for the run `shown` of the block `source` in the note at `notePath`. */
export function forwardStart(source: string, shown: RunOutput, defaults: Defaults, notePath: string): ForwardStart {
  return {
    source: shownText(source, shown),
    defaults,
    started: shown.backtest.run.t[shown.backtest.run.t.length - 1],
    intraday: isIntraday(shown.backtest.run.t),
    link: forwardLink(notePath, shown.spec.name),
    name: shown.spec.name ?? 'Backtest',
  };
}

/** A block's text as a note holds it, whatever its line endings and blank lines at its end. */
const plainText = (text: string): string => text.replace(/\r/g, '').trimEnd();

/** The strategy blocks on screen. A block is known by the object its drawings are tied to (Obsidian's render child). */
export class StrategyBlocks {
  /** What to run before a rendered block draws again or goes away. */
  private disposers = new WeakMap<object, () => void>();
  /** Whether each block was left open (true) or folded (false), for blocks drawn again within a session. */
  private blockState = new ResultCache<boolean>(KEPT_BLOCK_STATES, Infinity);
  /** What the reader had set on each block's result (tab, span, figures), for blocks drawn again within a session. */
  private views = new ResultCache<ViewState>(KEPT_BLOCK_STATES, Infinity);
  /** The height each block's result last settled at, so its next loading takes the same room. */
  private heights = new ResultCache<{ height: number; folded: boolean }>(KEPT_BLOCK_STATES, Infinity);
  /** Blocks (by key and text) whose result has been on screen in this session. */
  private shown = new ResultCache<true>(KEPT_SHOWN, Infinity);
  /** The result each block shows now. */
  private cards = new WeakMap<object, DrawnResult>();
  /** What the last sweep of each block's text found, by result key, for its slider tracks; and who is listening. */
  private sweeps = new ResultCache<TrackPaint>(KEPT_BLOCK_STATES, Infinity);
  private sweepListeners = new Map<string, Set<(paint: TrackPaint) => void>>();
  /**
   * The strategy blocks on screen with the defaults each was drawn with, so each can say when the settings have since
   * changed, and with its note, so each can read the age of its prices again when the note is shown again, and the
   * commands for the whole note can reach it. `refresh` runs it again with new prices, as its refresh button does.
   */
  private onScreen = new Map<object, { source: string; drawn: Defaults; say: (changed: boolean) => void; note: string; panel: boolean; card: DrawnResult; refresh: () => Promise<void> }>();
  /** Tells each block on screen whether the settings have changed what it means, once settings stop changing for a moment. */
  readonly checkDefaults = debounce(() => {
    const now = defaultsFrom(this.host.settings());
    for (const block of this.onScreen.values()) block.say(defaultsMatter(block.source, block.drawn, now));
  }, DEFAULTS_CHECK_MS);

  private host: BlocksHost;

  constructor(host: BlocksHost) {
    this.host = host;
  }

  /** Calls `listen` with what the last sweep of the block with result key `key` found, now if known and after each sweep. */
  private listenSweeps(key: string, listen: (paint: TrackPaint) => void): () => void {
    const kept = this.sweeps.get(key);
    if (kept) listen(kept);
    const set = this.sweepListeners.get(key) ?? new Set();
    set.add(listen);
    this.sweepListeners.set(key, set);
    return () => {
      set.delete(listen);
      if (set.size === 0) this.sweepListeners.delete(key);
    };
  }

  /** The results on screen of the note at `notePath` read the age of their prices again at `now`; nothing runs again. */
  checkAges(notePath: string, now: number): void {
    for (const block of this.onScreen.values()) if (block.note === notePath) block.card.checkAge(now);
  }

  /**
   * Runs the blocks of the note at `notePath` with the texts `sources` again with new prices. A block on screen, in the note
   * or in the preview panel, refreshes as its refresh button does. One that is not drawn (Live Preview draws only the blocks
   * near the screen) runs here, so it shows the new result when it draws. Resolves with how many of them ran, and why the
   * first that did not run here failed; one on screen says why itself.
   */
  async refreshNote(notePath: string, sources: readonly string[]): Promise<{ ran: number; problem: string | null }> {
    let problem: string | null = null;
    const refresh = (source: string): Promise<boolean> => {
      const drawn = [...this.onScreen].filter(([, b]) => b.note === notePath && plainText(b.source) === plainText(source));
      if (drawn.length === 0) {
        return this.host.results.runSource(source, { force: true }).then(
          () => true,
          (e: unknown) => {
            problem ??= e instanceof Error ? e.message : String(e);
            return false;
          },
        );
      }
      // A refresh that did not run leaves the result it had on screen.
      return Promise.all(drawn.map(([child, b]) => b.refresh().then(() => this.cards.get(child) !== b.card))).then((ran) => ran.some(Boolean));
    };
    // Two blocks with the same text are one run.
    const runs = new Map<string, Promise<boolean>>();
    const ran = await Promise.all(
      sources.map((source) => {
        const key = plainText(source);
        let run = runs.get(key);
        if (!run) runs.set(key, (run = refresh(source)));
        return run;
      }),
    );
    return { ran: ran.filter(Boolean).length, problem };
  }

  /**
   * Opens (or with `open` false, folds) every result of the note at `notePath` on screen, and the blocks with the keys
   * `keys` (render.ts blockStateKey) are drawn that way from now on. The preview panel keeps its own view.
   */
  setOpenInNote(notePath: string, keys: readonly string[], open: boolean): void {
    for (const key of keys) this.blockState.set(key, open);
    for (const block of this.onScreen.values()) if (block.note === notePath && !block.panel) block.card.setOpen(open);
  }

  /** What is remembered of the block with the key `from` (open or folded, its view, its height) is now that of `to`: the block was renamed. */
  moveState(from: string, to: string): void {
    if (from === to) return;
    for (const kept of [this.blockState, this.views, this.heights] as ResultCache<unknown>[]) {
      const value = kept.get(from);
      if (value === undefined) continue;
      kept.set(to, value);
      kept.delete(from);
    }
  }

  /** What the failure card offers for `step`: a correction is written through `restore`, so none is offered without it. */
  private nextAction(step: RunStep, lines: string[], restore: StrategyOptions['restore']): NextAction | null {
    const { action } = step;
    if (!action) return step.text ? { text: step.text, button: null } : null;
    if (action.kind !== 'change') return { text: step.text, button: { label: action.label, run: () => (action.kind === 'settings' ? this.host.openSettings() : this.host.openCsv()) } };
    if (!restore) return { text: step.text, button: null };
    const fixed = applyFix(lines, action.fix).join('\n');
    return {
      text: step.text,
      button: {
        label: action.label,
        run: () =>
          restore(fixed).catch((e: unknown) => {
            throw new Error(`Cannot change the block. ${e instanceof Error ? e.message : String(e)}`);
          }),
      },
    };
  }

  /** Runs what a drawing of the block left to do before it is drawn again or goes away. */
  dispose(child: object): void {
    this.disposers.get(child)?.();
    this.disposers.delete(child);
  }


  async renderStrategy(source: string, el: HTMLElement, child: object, opts: StrategyOptions): Promise<void> {
    // A refresh keeps the result on screen, and its runs, until the new one replaces it.
    const old = opts.inPlace ? this.cards.get(child) : undefined;
    const inPlace = old !== undefined && old.root.parentElement === el;
    const before = inPlace ? this.disposers.get(child) : undefined;
    if (inPlace) this.disposers.delete(child);
    else this.dispose(child);
    // The block's runs: drawing it again or its going away stops them, and the worker then forgets its prices.
    const runs = blockRuns();
    // While this is the child's disposer, this drawing is the block's latest and the block is still there.
    const stop = () => {
      runs.close();
      before?.();
    };
    this.disposers.set(child, stop);
    // Everything this drawing parses, runs and hands to its sections is made with the defaults it reads here, once.
    const drawing = this.host.results.drawing(source, runs, { anyway: opts.anyway });
    const force = opts.force ?? false;
    // In the panel a failed first run is for the panel to show, but a retry has nobody above it: it draws its own failure.
    const redraw = (more: Pick<StrategyOptions, 'force' | 'anyway' | 'inPlace'>): Promise<void> =>
      // A block run without the size limits is drawn again without them, whether it was asked for now or by the result it came from.
      this.renderStrategy(source, el, child, { ...opts, anyway: drawing.anyway, inPlace: false, ...more }).catch(showFailure);
    // A failure that a next step can put right draws that step as soon as it is known; a ticker search can take a moment.
    const showFailure = (e: unknown): void => {
      const message = e instanceof Error ? e.message : String(e);
      const again = () => void redraw({ force: false });
      renderFailure(el, message, source, again);
      const failure = priceFailure(e);
      if (!failure) return;
      const card = el.firstElementChild;
      const lines = source.split('\n');
      void runStep(lines, failure, drawing.defaults, this.host.lookup()).then((step) => {
        const next = this.nextAction(step, lines, opts.restore);
        if (next && el.firstElementChild === card) renderFailure(el, message, source, again, next);
      });
    };
    const retry = (refetch: boolean) => () => void redraw({ force: refetch, inPlace: true });
    try {
      const { spec, errors, warnings } = drawing.parse();
      if (!spec) {
        renderErrors(el, errors, source, { defaults: drawing.defaults, fix: opts.restore });
        return;
      }
      // The panel keeps its own view of a block, apart from the note's folded or open state.
      const stateKey = opts.panel ? undefined : (opts.stateKey ?? (spec.name ? blockStateKey(opts.notePath, spec.name, -1) : undefined));
      const key = await this.host.results.resultKey(spec, source, drawing.defaults);
      if (this.disposers.get(child) !== stop) return;
      let loading: Loading | null = null;
      if (inPlace) old.busy(true);
      else if (force || this.host.results.kept(key, drawing.freshForMs) === undefined) {
        const last = stateKey === undefined ? undefined : this.heights.get(stateKey);
        const open = stateKey === undefined ? undefined : this.blockState.get(stateKey);
        const folded = !(open ?? !(opts.compact ?? this.host.settings().resultView === 'compact'));
        loading = renderLoading(el, {
          title: spec.name ?? 'Backtest',
          tickers: [...spec.universe, ...spec.extras].map((a) => a.name),
          ...(last && last.folded === folded ? { height: last.height } : {}),
          folded,
        });
      }
      const out = await this.host.results.runSpec(drawing, spec, key, force, {
        prices: (bars) => loading?.prices(bars),
        ticker: (done, total, waiting) => loading?.tickers(done, total, waiting),
      });
      // Stopped, or a kept result came back after the block was drawn again or went away.
      if (!out || this.disposers.get(child) !== stop) return;
      // A result that was run without the size limits is shown with its sliders without them too.
      drawing.follow(out);
      // What the block has been through; a block with no key of its own records nothing.
      const ledger = opts.blockKey ? this.host.ledgers?.forBlock(opts.blockKey) : undefined;
      void ledger?.add([trialOf(out.spec, out.backtest)], { text: source, defaults: drawing.defaults, figures: versionFigures(out.backtest) });
      const sections = (shown: RunOutput): Section[] => {
        const bt = shown.backtest;
        const intraday = isIntraday(bt.run.t);
        const name = shown.spec.name ?? 'Backtest';
        // The sweep and the luck checks start from the block's own text and put values on top of it.
        const tryValues = {
          source,
          backtest: bt,
          parse: drawing.parse,
          defaults: drawing.defaults,
          apply: opts.apply,
          rewrite: opts.restore,
          ledger,
          onResult: (paint: TrackPaint) => {
            this.sweeps.set(key, paint);
            for (const listen of this.sweepListeners.get(key) ?? []) listen(paint);
          },
        };
        // A kept note carries the values that made its result.
        const shownSource = setParamValues(source, Object.fromEntries(shown.spec.params.map((p) => [p.name, p.value])));
        return [
          // Regimes and crises: right after "More statistics".
          (root) =>
            renderRegimes(root, {
              run: { t: bt.run.t, equity: bt.run.equity, exposure: bt.run.exposure, ...(bt.run.netExposure ? { netExposure: bt.run.netExposure } : {}), benchmark: bt.benchmark.equity },
              benchmarkLabel: bt.benchmark.label,
              intraday,
              universe: shown.spec.universe,
              saved: (refs, from, lookback) => this.host.results.runner().savedExtras(refs, from, lookback),
              load: (refs, from, lookback) => this.host.results.runner().loadExtras(refs, from, lookback),
            }),
          (root) =>
            renderPriceCharts(root, {
              data: shown.data,
              tickers: shown.spec.universe.map((a) => a.name),
              trades: bt.run.trades,
              from: bt.run.t[0],
              to: bt.run.t[bt.run.t.length - 1],
              intraday,
            }),
          (root) => renderDebug(root, { backtest: bt, intraday, save: (title, csv) => this.host.saveFile(title, 'csv', csv) }),
          (root) => renderSweep(root, tryValues),
          (root) => renderLuck(root, tryValues),
          // Versions: after the luck checks.
          ...(ledger ? [(root: HTMLElement) => renderVersions(root, { ledger, source, defaults: drawing.defaults, restore: opts.restore })] : []),
        ];
      };
      // A forward test starts only from a block in a note: the test links back to it, and the preview panel is not its home.
      const forward = (shown: RunOutput): Action | null =>
        opts.panel || !opts.notePath
          ? null
          : {
              label: 'Start a forward test',
              icon: 'arrow-right',
              run: () => this.host.startForward(forwardStart(source, shown, drawing.defaults, opts.notePath)),
            };
      // The menu of the run on screen: the saves, then the forward test and the note's properties.
      const menu = (at: HTMLElement, shown: RunOutput): void => {
        const bt = shown.backtest;
        const intraday = isIntraday(bt.run.t);
        const name = shown.spec.name ?? 'Backtest';
        const next = forward(shown);
        const items: MenuItems = [
          { label: 'Save trades as CSV', icon: 'table', run: () => this.host.saveFile(`${name} trades`, 'csv', tradesCsv(bt.run.trades, intraday)) },
          { label: 'Save value history as CSV', icon: 'activity', run: () => this.host.saveFile(`${name} value`, 'csv', equityCsv(bt.run.t, bt.run.equity, bt.benchmark.equity, bt.benchmark.label, intraday)) },
          {
            label: 'Keep this result as a note',
            icon: 'bookmark',
            run: () => {
              const kept = keptNote(source, shown, Date.now());
              return this.host.saveFile(kept.title, 'md', kept.text);
            },
          },
          // A copy carries the values that made its result.
          { label: 'Copy as Markdown', icon: 'copy', run: () => this.host.copy(resultMarkdown({ source: shownText(source, shown), backtest: bt }), 'the result') },
          ...(next || (!opts.panel && opts.notePath) ? [null] : []),
          ...(next ? [next] : []),
          ...(!opts.panel && opts.notePath ? [{ label: "Save this note's results to its properties", icon: 'save', run: () => this.host.saveProperties(opts.notePath) }] : []),
        ];
        this.host.showMenu(at, items);
      };
      const asDrawn = drawing.sliders(out);
      // Every result a slider shows is a try.
      const sliders = ledger
        ? {
            ...asDrawn,
            rerun: async (values: Record<string, number>, settled: boolean) => {
              const next = await asDrawn.rerun(values, settled);
              if (next) void ledger.add([trialOf(next.spec, next.backtest)]);
              return next;
            },
          }
        : asDrawn;
      // A result arrives once: not when a kept one is drawn again on scrolling, nor after a refresh, nor in the panel.
      const shownKey = `${stateKey ?? ''}\u0000${source}`;
      const arrive = !opts.panel && !inPlace && !force && this.shown.get(shownKey) === undefined;
      this.shown.set(shownKey, true);
      // Values written from the sliders were on screen already: their block does not arrive again.
      const apply =
        opts.apply &&
        ((values: Record<string, number>) => {
          this.shown.set(`${stateKey ?? ''}\u0000${setParamValues(source, values)}`, true);
          return opts.apply!(values);
        });
      const initial: ViewState | undefined = inPlace ? old.view() : stateKey === undefined ? undefined : this.views.get(stateKey);
      const draw = (target: HTMLElement): DrawnResult =>
        renderResult(target, {
          source,
          out,
          notes: warnings,
          onRefresh: retry(true),
          sections,
          compact: opts.compact ?? this.host.settings().resultView === 'compact',
          remember: stateKey === undefined ? undefined : { get: () => this.blockState.get(stateKey), set: (open) => this.blockState.set(stateKey, open) },
          params: spec.params.length > 0 ? { ...sliders, apply, sweep: (listen) => this.listenSweeps(key, listen) } : undefined,
          figuresNote: ledger ? (note, now) => renderTriesNote(note, ledger, now.backtest) : undefined,
          triggers: (shown) => this.host.results.triggers(shown, runs),
          menu,
          copy: (text, what) => this.host.copy(text, what),
          nextStep: forward,
          initial,
          arrive,
          onHeight: stateKey === undefined ? undefined : (height, folded) => this.heights.set(stateKey, { height, folded }),
        });
      let drawn: DrawnResult;
      if (loading || inPlace) {
        // Drawn where it cannot be seen, until its chart has laid itself out; then it takes the place of what is shown,
        // and the block's height eases from the one to the other.
        el.classList.add('bt-block');
        const stage = document.createElement('div');
        stage.className = 'bt-stage';
        el.appendChild(stage);
        drawn = draw(stage);
        await frames(2);
        if (this.disposers.get(child) !== stop) {
          drawn.dispose();
          stage.remove();
          return;
        }
        before?.();
        easeHeight(el, () => el.replaceChildren(...Array.from(stage.childNodes)));
      } else drawn = draw(el);
      this.cards.set(child, drawn);
      this.onScreen.set(child, {
        source,
        drawn: drawing.defaults,
        say: renderDefaultsChanged(el, () => void redraw({ force: false, inPlace: true })),
        note: opts.notePath,
        panel: opts.panel ?? false,
        card: drawn,
        refresh: () => redraw({ force: true, inPlace: true }),
      });
      // A rename by hand is offered on the block in its note, which is where its record and links belong.
      const name = out.spec.name;
      if (ledger && name && opts.blockKey && !opts.panel) {
        void this.host.renamedFrom?.(opts.notePath, opts.blockKey, name, source).then((found) => {
          if (found && this.cards.get(child) === drawn) renderRenamed(el, found.name, found.move);
        });
      }
      this.disposers.set(child, () => {
        if (stateKey !== undefined) this.views.set(stateKey, drawn.view());
        drawn.dispose();
        runs.close();
        this.onScreen.delete(child);
      });
      // The settings may have changed while the result was on its way.
      this.checkDefaults();
      if (this.host.settings().writeProperties && !opts.panel) this.host.scheduleProperties(opts.notePath);
    } catch (e) {
      // A drawing that was replaced or went away while it ran leaves the block to whatever replaced it.
      if (this.disposers.get(child) !== stop) return;
      const message = e instanceof Error ? e.message : String(e);
      // A refresh that failed leaves the result on screen as it was, with a line that says why.
      if (inPlace && !(e instanceof LimitError) && old.root.parentElement === el) {
        this.disposers.set(child, stop);
        old.busy(false);
        old.failed(message, () => redraw({ force: true, inPlace: true }));
        return;
      }
      before?.();
      // A limit is shown in the panel too, since only the block can offer to run it anyway.
      if (e instanceof LimitError) renderLimit(el, e, source, () => redraw({ force: false, anyway: true }));
      else if (opts.panel) throw e;
      else showFailure(e);
    }
  }

  /** The block with this key (render.ts blockStateKey) draws open the next time it is drawn. */
  drawOpen(stateKey: string): void {
    this.blockState.set(stateKey, true);
  }
}

/** Waits for `n` frames, so what was drawn has been laid out. */
function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const next = (left: number) => (left <= 0 ? resolve() : window.requestAnimationFrame(() => next(left - 1)));
    next(n);
  });
}
