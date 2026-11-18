// A strategy block's drawings: parsing it, running it or reusing a kept result, drawing the result with its sections, and
// what a drawing leaves behind (its runs, its sections, its place among the blocks on screen) until the block is drawn
// again or goes away. The plugin says where each block is and hands in the settings, the results and the vault writes.

import type { Defaults } from './dsl.ts';
import { equityCsv, snapshotMarkdown, tradesCsv } from './export.ts';
import { isIntraday } from './format.ts';
import { LimitError } from './limits.ts';
import { renderActions } from './render-actions.ts';
import { renderDebug } from './render-debug.ts';
import { renderLuck } from './render-luck.ts';
import { renderPriceCharts } from './render-price.ts';
import { renderSweep } from './render-sweep.ts';
import { blockStateKey, renderDefaultsChanged, renderErrors, renderFailure, renderLimit, renderLoading, renderResult, type Section } from './render.ts';
import { ResultCache, debounce, defaultsMatter } from './result-cache.ts';
import type { Results } from './results.ts';
import { setParamValues } from './rewrite.ts';
import type { RunOutput } from './runner.ts';
import { defaultsFrom, type Settings } from './settings-core.ts';
import { blockRuns } from './worker-client.ts';

/** Blocks whose open or folded state is remembered for the session. */
const KEPT_BLOCK_STATES = 500;
/** After the last change to a setting, how long to wait before blocks on screen are told their defaults changed. */
const DEFAULTS_CHECK_MS = 400;

/** What a caller of `renderStrategy` says about where the block is. */
export interface StrategyOptions {
  notePath: string;
  /** Run again and fetch prices again, instead of reusing a recent result. */
  force?: boolean;
  /** Writes parameter values (fractions for percentages) into the block's text. Absent where the block can't be edited. */
  apply?: (values: Record<string, number>) => Promise<void>;
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
}

export interface BlocksHost {
  results: Results;
  /** The settings as they are now. */
  settings(): Settings;
  /** Writes text to a dated file in the results folder and says where it went. */
  saveFile(title: string, ext: string, text: string): Promise<void>;
  /** Writes the properties of the note at `notePath` a moment after the last of its blocks has rendered. */
  scheduleProperties(notePath: string): void;
}

/** The strategy blocks on screen. A block is known by the object its drawings are tied to (Obsidian's render child). */
export class StrategyBlocks {
  /** What to run before a rendered block draws again or goes away. */
  private disposers = new WeakMap<object, () => void>();
  /** Whether each block was left open (true) or folded (false), for blocks drawn again within a session. */
  private blockState = new ResultCache<boolean>(KEPT_BLOCK_STATES, Infinity);
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
    this.dispose(child);
    // The block's runs: drawing it again or its going away stops them, and the worker then forgets its prices.
    const runs = blockRuns();
    // While this is the child's disposer, this drawing is the block's latest and the block is still there.
    const stop = () => runs.close();
    this.disposers.set(child, stop);
    // Everything this drawing parses, runs and hands to its sections is made with the defaults it reads here, once.
    const drawing = this.host.results.drawing(source, runs, { anyway: opts.anyway });
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
      const key = await this.host.results.resultKey(spec, source, drawing.defaults);
      if (this.disposers.get(child) !== stop) return;
      if (force || this.host.results.kept(key, drawing.freshForMs) === undefined) renderLoading(el, `Loading prices for ${[...spec.universe, ...spec.extras].map((a) => a.name).join(', ')}…`);
      const out = await this.host.results.runSpec(drawing, spec, key, force);
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
          // Regimes and crises: right after "More statistics".
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
          (root) =>
            renderActions(root, [
              { label: 'Save trades as CSV', run: () => this.host.saveFile(`${name} trades`, 'csv', tradesCsv(bt.run.trades, intraday)) },
              { label: 'Save value history as CSV', run: () => this.host.saveFile(`${name} value`, 'csv', equityCsv(bt.run.t, bt.run.equity, bt.benchmark.equity, bt.benchmark.label, intraday)) },
              { label: 'Keep this result as a note', run: () => this.host.saveFile(`${name} result`, 'md', snapshotMarkdown({ name, source: shownSource, backtest: bt, now: Date.now() })) },
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
        compact: opts.compact ?? this.host.settings().resultView === 'compact',
        remember: stateKey === undefined ? undefined : { get: () => this.blockState.get(stateKey), set: (open) => this.blockState.set(stateKey, open) },
        params: spec.params.length > 0 ? { ...sliders, apply: opts.apply } : undefined,
        triggers: (shown) => this.host.results.triggers(shown, runs),
      });
      this.onScreen.set(child, { source, drawn: drawing.defaults, say: renderDefaultsChanged(el, () => redraw({ force: false })) });
      this.disposers.set(child, () => {
        drawn();
        runs.close();
        this.onScreen.delete(child);
      });
      // The settings may have changed while the result was on its way.
      this.checkDefaults();
      if (this.host.settings().writeProperties && !opts.panel) this.host.scheduleProperties(opts.notePath);
    } catch (e) {
      // A drawing that was replaced or went away while it ran leaves the block to whatever replaced it.
      if (this.disposers.get(child) !== stop) return;
      // A limit is shown in the panel too, since only the block can offer to run it anyway.
      if (e instanceof LimitError) renderLimit(el, e, source, () => redraw({ force: false, anyway: true }));
      else if (opts.panel) throw e;
      else showFailure(e);
    }
  }
}
