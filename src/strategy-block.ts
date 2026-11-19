// A strategy block's drawings: parsing it, running it or reusing a kept result, drawing the result with its sections, and
// what a drawing leaves behind (its runs, its sections, its place among the blocks on screen) until the block is drawn
// again or goes away. The plugin says where each block is and hands in the settings, the results and the vault writes.

import type { Defaults } from './dsl.ts';
import { easeHeight } from './dom.ts';
import { equityCsv, snapshotMarkdown, tradesCsv } from './export.ts';
import { isIntraday } from './format.ts';
import { forwardLink, type ForwardStart } from './forward.ts';
import { trialOf, versionFigures, type Ledgers } from './ledger.ts';
import { LimitError } from './limits.ts';
import type { Action, MenuItems } from './render-actions.ts';
import { renderDebug } from './render-debug.ts';
import { renderLuck, renderTriesNote } from './render-luck.ts';
import { renderPriceCharts } from './render-price.ts';
import { renderRegimes } from './render-regimes.ts';
import { renderSweep } from './render-sweep.ts';
import { renderVersions } from './render-versions.ts';
import { blockStateKey, renderDefaultsChanged, renderErrors, renderFailure, renderLimit, renderLoading, renderResult, type DrawnResult, type Loading, type Section, type ViewState } from './render.ts';
import { ResultCache, debounce, defaultsMatter } from './result-cache.ts';
import type { Results } from './results.ts';
import { setParamValues } from './rewrite.ts';
import type { RunOutput } from './runner.ts';
import { defaultsFrom, type Settings } from './settings-core.ts';
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
}

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
  /** The strategy blocks on screen with the defaults each was drawn with, so each can say when the settings have since changed. */
  private onScreen = new Map<object, { source: string; drawn: Defaults; say: (changed: boolean) => void }>();
  /** Tells each block on screen whether the settings have changed what it means, once settings stop changing for a moment. */
  readonly checkDefaults = debounce(() => {
    const now = defaultsFrom(this.host.settings());
    for (const block of this.onScreen.values()) block.say(defaultsMatter(block.source, block.drawn, now));
  }, DEFAULTS_CHECK_MS);

  private host: BlocksHost;

  constructor(host: BlocksHost) {
    this.host = host;
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
    const redraw = (more: Pick<StrategyOptions, 'force' | 'anyway' | 'inPlace'>): void => {
      // A block run without the size limits is drawn again without them, whether it was asked for now or by the result it came from.
      this.renderStrategy(source, el, child, { ...opts, anyway: drawing.anyway, inPlace: false, ...more }).catch(showFailure);
    };
    const showFailure = (e: unknown): void => renderFailure(el, e instanceof Error ? e.message : String(e), source, () => redraw({ force: false }));
    const retry = (refetch: boolean) => () => redraw({ force: refetch, inPlace: true });
    try {
      const { spec, errors, warnings } = drawing.parse();
      if (!spec) {
        renderErrors(el, errors, source);
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
      const out = await this.host.results.runSpec(drawing, spec, key, force, (bars) => loading?.prices(bars));
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
        const tryValues = { source, backtest: bt, parse: drawing.parse, defaults: drawing.defaults, apply: opts.apply, ledger };
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
              run: () =>
                this.host.startForward({
                  source: setParamValues(source, Object.fromEntries(shown.spec.params.map((p) => [p.name, p.value]))),
                  defaults: drawing.defaults,
                  started: shown.backtest.run.t[shown.backtest.run.t.length - 1],
                  intraday: isIntraday(shown.backtest.run.t),
                  link: forwardLink(opts.notePath, shown.spec.name),
                  name: shown.spec.name ?? 'Backtest',
                }),
            };
      // The menu of the run on screen: the saves, then the forward test and the note's properties.
      const menu = (at: HTMLElement, shown: RunOutput): void => {
        const bt = shown.backtest;
        const intraday = isIntraday(bt.run.t);
        const name = shown.spec.name ?? 'Backtest';
        // A kept note carries the values that made its result.
        const shownSource = setParamValues(source, Object.fromEntries(shown.spec.params.map((p) => [p.name, p.value])));
        const next = forward(shown);
        const items: MenuItems = [
          { label: 'Save trades as CSV', icon: 'table', run: () => this.host.saveFile(`${name} trades`, 'csv', tradesCsv(bt.run.trades, intraday)) },
          { label: 'Save value history as CSV', icon: 'activity', run: () => this.host.saveFile(`${name} value`, 'csv', equityCsv(bt.run.t, bt.run.equity, bt.benchmark.equity, bt.benchmark.label, intraday)) },
          { label: 'Keep this result as a note', icon: 'bookmark', run: () => this.host.saveFile(`${name} result`, 'md', snapshotMarkdown({ name, source: shownSource, backtest: bt, now: Date.now() })) },
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
          params: spec.params.length > 0 ? { ...sliders, apply } : undefined,
          figuresNote: ledger ? (note, now) => renderTriesNote(note, ledger, now.backtest) : undefined,
          triggers: (shown) => this.host.results.triggers(shown, runs),
          menu,
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
      this.onScreen.set(child, { source, drawn: drawing.defaults, say: renderDefaultsChanged(el, () => redraw({ force: false, inPlace: true })) });
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
}

/** Waits for `n` frames, so what was drawn has been laid out. */
function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const next = (left: number) => (left <= 0 ? resolve() : window.requestAnimationFrame(() => next(left - 1)));
    next(n);
  });
}
