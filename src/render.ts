import type { Backtest, Segment } from './backtest.ts';
import { STOP_SETTINGS, type Commission, type Diagnostic, type Spec, type StopLevel } from './dsl.ts';
import { colourSource, h, s } from './dom.ts';
import { hintFor } from './fixes.ts';
import { DAY, isIntraday, isoDate, minus, money, moneyTicks, niceStep, pct, signedPct, stamp, timeTicks } from './format.ts';
import { commentStart, declaredParams, settingKey } from './highlight.ts';
import { anywayLabel, type LimitError } from './limits.ts';
import { pendingTiming, timingPhrase } from './orders.ts';
import { formatParam, renderParamBar, type ParamsHook } from './render-params.ts';
import { renderDeepStats } from './render-stats.ts';
import { renderPositions, renderTrades } from './render-trades.ts';
import type { RunOutput } from './runner.ts';
import type { Source } from './types.ts';
import type { TriggerReport } from './trigger.ts';

/** The strategy as written: the block replaces its own text, so the result has to show it. */
function source(el: HTMLElement, text: string): void {
  colourSource(h(el, 'pre', 'bt-source'), text.trim());
}

export function renderLoading(el: HTMLElement, text: string): void {
  el.replaceChildren();
  h(h(el, 'div', 'bt-root'), 'div', 'bt-note', text);
}

export function renderErrors(el: HTMLElement, errors: Diagnostic[], src: string): void {
  el.replaceChildren();
  const root = h(el, 'div', 'bt-root');
  h(root, 'div', 'bt-error-title', errors.length === 1 ? "This strategy can't run yet" : `This strategy can't run yet: ${errors.length} problems`);
  const lines = src.split('\n');
  const list = h(root, 'ul', 'bt-errors');
  for (const e of errors) {
    const li = h(list, 'li');
    h(li, 'span', 'bt-error-line', `Line ${e.line}`);
    h(li, 'span', undefined, e.message);
    const text = lines[e.line - 1]?.trim();
    if (text) h(li, 'code', 'bt-error-src', text);
    const hint = hintFor(lines, e);
    if (hint) h(li, 'span', 'bt-error-hint', hint);
  }
  source(root, src);
}

export function renderFailure(el: HTMLElement, message: string, src: string, onRetry: () => void): void {
  el.replaceChildren();
  const root = h(el, 'div', 'bt-root');
  h(root, 'div', 'bt-error-title', "The backtest couldn't run");
  h(root, 'div', 'bt-note', message);
  h(root, 'button', 'bt-button', 'Try again').addEventListener('click', onRetry);
  source(root, src);
}

/** A run refused for its size or stopped for its time (limits.ts): which limit, and a button to run it without one when that is allowed. */
export function renderLimit(el: HTMLElement, error: LimitError, src: string, onAnyway: () => void): void {
  el.replaceChildren();
  const root = h(el, 'div', 'bt-root');
  h(root, 'div', 'bt-error-title', error.kind === 'size' ? 'This backtest is too large to run' : 'This backtest took too long');
  h(root, 'div', 'bt-note', error.message);
  if (error.anyway) h(root, 'button', 'bt-button', anywayLabel(error)).addEventListener('click', onAnyway);
  source(root, src);
}

/**
 * A line at the top of a drawn result for when the plugin's default settings have changed since it was worked out: it says
 * the result still has the old ones, and a button works it out again. The line starts hidden; the returned function shows
 * or hides it.
 */
export function renderDefaultsChanged(el: HTMLElement, onRun: () => void): (changed: boolean) => void {
  const root = el.querySelector('.bt-root') ?? el;
  const note = document.createElement('div');
  note.className = 'bt-defaults-changed';
  note.hidden = true;
  h(note, 'span', 'bt-defaults-changed-text', 'The default settings were changed after this result was worked out. It still has the old ones.');
  h(note, 'button', 'bt-button', 'Run again').addEventListener('click', onRun);
  root.prepend(note);
  return (changed) => {
    note.hidden = !changed;
  };
}

/** The parameters (in lower case) that a stop setting takes as its whole level, as in `stop loss: stop`. */
function stopParams(source: string): Set<string> {
  const lines = source.split('\n');
  const names = new Set(declaredParams(lines).map((p) => p.name.toLowerCase()));
  const out = new Set<string>();
  for (const line of lines) {
    const key = settingKey(line);
    if (!key || !STOP_SETTINGS.includes(key)) continue;
    const comment = commentStart(line);
    const value = (comment < 0 ? line : line.slice(0, comment)).slice(line.indexOf(':') + 1).trim().toLowerCase();
    if (names.has(value)) out.add(value);
  }
  return out;
}

/**
 * The line under the title. Percentages are written as the block writes them. A parameter that is a stop is not listed again
 * when the line spells that stop out; `source` is the block's text, which says which parameters those are.
 */
export function summary(spec: Spec, source = ''): string {
  const names = spec.universe.map((a) => a.name);
  const parts = [
    spec.rank
      ? `the top ${spec.rank.top} of ${names.length > 6 ? `${names.length} tickers` : names.join(', ')}, ${pct(spec.universe[0].weight, 0)} each`
      : spec.universe.map((a) => (names.length > 1 || a.weight < 1 ? `${a.name} ${Number((a.weight * 100).toFixed(1))}%` : a.name)).join(' \u00b7 '),
  ];
  if (spec.sizing.k === 'invvol') parts.push('sized by inverse volatility');
  if (spec.sizing.k === 'risk') parts.push(`${pct(spec.sizing.risk, 1)} risked per trade`);
  if ((spec.entries ?? 1) > 1) parts.push(`bought in up to ${spec.entries} entries`);
  if (spec.rebalance !== 'never') parts.push(spec.rank ? `chosen ${spec.rebalance}` : `rebalanced ${spec.rebalance}`);
  if (spec.interval !== '1d') parts.push(`${spec.interval} bars`);
  if (spec.costBps || !spec.commission) parts.push(spec.costBps ? `${spec.costBps} bps costs` : 'no costs');
  if (spec.commission) parts.push(commissionText(spec.commission));
  if (spec.slippageBps) parts.push(`${spec.slippageBps} bps slippage`);
  const level = (l: StopLevel | null) => (l === null ? '' : l.k === 'pct' ? formatParam({ percent: true }, l.v) : `${l.mult} ATR`);
  const text = (name: string) => {
    const st = spec.stops[name];
    return [st.stopLoss && `${level(st.stopLoss)} stop`, st.trailingStop && `${level(st.trailingStop)} trailing stop`, st.takeProfit && `${level(st.takeProfit)} target`].filter(Boolean).join(', ');
  };
  const stops = new Set(names.map(text));
  const spelt = stops.size === 1 && text(names[0]) !== '';
  if (stops.size > 1) parts.push('stops set per ticker');
  else if (spelt) parts.push(text(names[0]));
  const asStops = spelt ? stopParams(source) : new Set<string>();
  const listed = spec.params.filter((p) => !asStops.has(p.name.toLowerCase()));
  if (listed.length) parts.push(listed.map((p) => `${p.name} ${formatParam(p, p.value)}`).join(', '));
  return parts.join(', ');
}

/** A commission as the summary names it: "commission 1 an order", "commission 0.005 a share, at least 1, at most 1% of the order". */
export function commissionText(c: Commission): string {
  if (c.k === 'order') return `commission ${c.fee} an order`;
  const limits = [c.min > 0 ? `at least ${c.min}` : '', c.max !== null ? `at most ${formatParam({ percent: true }, c.max)} of the order` : ''].filter(Boolean);
  return `commission ${c.fee} a share${limits.length ? `, ${limits.join(', ')}` : ''}`;
}

/** A section added under the standard result; returns a cleanup function when it holds observers. */
export type Section = (root: HTMLElement) => (() => void) | void;

export interface ResultView {
  source: string;
  out: RunOutput;
  /** The parser's warnings for this block. */
  notes: Diagnostic[];
  onRefresh: () => void;
  /** Sections placed after the trade list, in order. Built for the run on screen, so they are built again when the sliders show other values. */
  sections?: (out: RunOutput) => Section[];
  /** Start as one line that opens on a click. A remembered state wins over this. */
  compact?: boolean;
  /** Where the block's open or folded state is kept, so a block drawn again comes back as the reader left it. */
  remember?: { get(): boolean | undefined; set(open: boolean): void };
  /** Sliders for the strategy's parameters; ignored when it declares none. */
  params?: ParamsHook;
  /** Fills a line under the figures for the run on screen; returns a cleanup function when it keeps watching something. */
  figuresNote?: (el: HTMLElement, out: RunOutput) => (() => void) | void;
  /**
   * The trigger prices of a run on screen, asked for when its positions are drawn: for the block as written and for a
   * slider once let go, never while it is dragged. Null when the run has none to show.
   */
  triggers?: (out: RunOutput) => Promise<TriggerReport | null> | null;
}

/** Keys the remembered state of a block: its note and its name, or its place among the note's blocks when it has no name. */
export function blockStateKey(notePath: string, name: string | null, index: number): string {
  return `${blockKeyPrefix(notePath, false)}${name ? `name:${name.toLowerCase()}` : `block:${index}`}`;
}

/** The start of the key of every block in the note at `path`, or with `folder`, in every note under the folder at `path`. */
export function blockKeyPrefix(path: string, folder: boolean): string {
  return folder ? `${path}/` : `${path}\u0000`;
}

export interface CompactFacts {
  /** The tickers, for a strategy with no name, so folded blocks can be told apart. */
  tickers: string | null;
  figures: string[];
  holding: string;
  /** What is waiting for the next open or close, or was done at the last close, or null. */
  order: string | null;
}

/** When a rule's order fills, as the result's fine print says it. */
export const fillSentence = (spec: Pick<Spec, 'fill'>): string => (spec.fill === 'close' ? 'A rule seen at a close fills at that close.' : 'A rule seen at a close fills at the next open.');

/** What a folded block shows besides its name, worded like the positions table. */
export function compactFacts(out: RunOutput): CompactFacts {
  const { stats, run } = out.backtest;
  const intraday = isIntraday(run.t);
  const long = run.states.filter((st) => st.side === 'long');
  const steps = out.spec.entries ?? 1;
  const built = long.length === 1 && steps > 1 ? `, ${long[0].entries} of ${steps} entries` : '';
  const holding = long.length === 0 ? 'In cash' : long.length === 1 ? `Long ${long[0].name} since ${stamp(long[0].since!, intraday)}${built}` : `Holds ${long.length} of ${run.states.length}`;
  const list = (names: string[], most = 2, joiner = ' and ') => (names.length <= most ? names.join(joiner) : `${names.length} tickers`);
  const named = (side: 'buy' | 'sell' | 'add') => run.states.filter((st) => st.pending === side).map((st) => st.name);
  const buys = named('buy');
  const sells = named('sell');
  const adds = named('add');
  const due = [...(buys.length ? [`buys ${list(buys)}`] : []), ...(adds.length ? [`adds to ${list(adds)}`] : []), ...(sells.length ? [`sells ${list(sells)}`] : [])];
  const made = (side: 'buy' | 'sell' | 'add') => run.states.filter((st) => st.filled?.side === side).map((st) => st.name);
  const bought = made('buy');
  const added = made('add');
  const sold = made('sell');
  const done = [...(bought.length ? [`bought ${list(bought)}`] : []), ...(added.length ? [`added to ${list(added)}`] : []), ...(sold.length ? [`sold ${list(sold)}`] : [])];
  const order = [
    ...(due.length ? [`${due.join(' and ')} ${timingPhrase(pendingTiming(out.spec.fill))}`] : []),
    ...(done.length ? [`${done.join(' and ')} at the last close`] : []),
  ];
  return {
    tickers: out.spec.name ? null : list(out.spec.universe.map((a) => a.name), 3, ', '),
    figures: [`${signedPct(stats.cagr)} a year`, `worst drawdown ${pct(stats.maxDrawdown)}`],
    holding,
    order: order.length ? order.join(', ') : null,
  };
}

/** Everything worth a reader's attention that is not an error: price warnings, the run's own notes, the parser's warnings. */
function notesOf(view: ResultView, out: RunOutput): string[] {
  const { spec, warnings, backtest: bt } = out;
  const first = bt.run.t[0];
  const notes = [...warnings, ...(out.notes ?? []), ...bt.notes, ...view.notes.map((n) => `Line ${n.line}: ${n.message}`)];
  if (spec.from !== null && first - spec.from > 7 * DAY) {
    notes.push(`The run starts on ${isoDate(first)}, the first day every ticker has prices, not ${isoDate(spec.from)}.`);
  }
  return notes;
}

function segments(root: HTMLElement, bt: Backtest): void {
  if (!bt.segments) return;
  const wrap = h(root, 'div', 'bt-split');
  h(wrap, 'div', 'bt-split-title', 'Before and after the test date');
  const table = h(h(wrap, 'div', 'bt-wide'), 'table', 'bt-table');
  const head = h(h(table, 'thead'), 'tr');
  h(head, 'th');
  for (const seg of bt.segments) h(head, 'th', 'bt-num', seg.label);
  const body = h(table, 'tbody');
  const row = (label: string, cell: (seg: Segment) => string) => {
    const tr = h(body, 'tr');
    h(tr, 'td', undefined, label);
    for (const seg of bt.segments!) h(tr, 'td', 'bt-num', cell(seg));
  };
  const num = (x: number) => (Number.isFinite(x) ? minus(x.toFixed(2)) : '\u2013');
  row('Return per year', (g) => pct(g.stats.cagr));
  row(`${bt.benchmark.label}, per year`, (g) => pct(g.benchmarkStats.cagr));
  row('Worst drawdown', (g) => pct(g.stats.maxDrawdown));
  row('Sharpe ratio', (g) => num(g.stats.sharpe));
  row('Trades', (g) => String(g.tradeStats.count));
  h(wrap, 'div', 'bt-note', 'Rules chosen by looking at the first period are only tested by the second.');
}

function fillTiles(tiles: HTMLElement, bt: Backtest): void {
  tiles.replaceChildren();
  const { stats, tradeStats, benchmark } = bt;
  const tile = (label: string, value: string, sub: string) => {
    const t = h(tiles, 'div', 'bt-tile');
    h(t, 'div', 'bt-tile-label', label);
    h(t, 'div', 'bt-tile-value', value);
    h(t, 'div', 'bt-tile-sub', sub);
  };
  const vs = (text: string) => `${benchmark.label} ${text}`;
  tile('Return per year', pct(stats.cagr), vs(pct(benchmark.stats.cagr)));
  tile('Total return', pct(stats.totalReturn, Math.abs(stats.totalReturn) >= 10 ? 0 : 1), vs(pct(benchmark.stats.totalReturn, Math.abs(benchmark.stats.totalReturn) >= 10 ? 0 : 1)));
  tile('Worst drawdown', pct(stats.maxDrawdown), vs(pct(benchmark.stats.maxDrawdown)));
  tile('Sharpe ratio', minus(stats.sharpe.toFixed(2)), vs(minus(benchmark.stats.sharpe.toFixed(2))));
  tile('Time invested', pct(stats.exposure, 0), `${pct(stats.volatility)} volatility a year`);
  tile(
    'Trades',
    String(tradeStats.count),
    tradeStats.count ? `${pct(tradeStats.winRate, 0)} won, ${signedPct(tradeStats.avgReturn)} on average` : tradeStats.open ? 'none closed yet' : 'the buy rule never fired',
  );
}

function fillLegend(legend: HTMLElement, bt: Backtest): void {
  legend.replaceChildren();
  const key = (cls: string, label: string, value: number) => {
    const k = h(legend, 'span', 'bt-key');
    h(k, 'span', `bt-swatch ${cls}`);
    h(k, 'span', undefined, label);
    h(k, 'span', 'bt-key-value', money(value));
  };
  key('bt-swatch-strategy', 'Strategy', bt.run.equity[bt.run.equity.length - 1]);
  key('bt-swatch-benchmark', bt.benchmark.label, bt.benchmark.equity[bt.benchmark.equity.length - 1]);
}

const PRICES_FROM: Record<Source, string> = { yahoo: 'Yahoo', binance: 'Binance', csv: 'your CSV files', tiingo: 'Tiingo', fred: 'FRED' };

/** The parts of a result that are heavy to draw or rarely needed. Returns what to run when they are drawn again or go away. */
function fillRest(root: HTMLElement, out: RunOutput, sections: Section[], triggers: Promise<TriggerReport | null> | null): (() => void)[] {
  const { spec, backtest: bt, prices } = out;
  const { run } = bt;
  const intraday = isIntraday(bt.run.t);
  const stops: (() => void)[] = [];
  const facts = [`${stamp(run.t[0], intraday)} to ${stamp(run.t[run.t.length - 1], intraday)}, starting with ${money(spec.capital)}.`, fillSentence(spec)];
  if (spec.magnify) facts.push(`A bar with a stop or target inside it is followed through its ${spec.magnify} bars, where it has them.`);
  if (run.costs > 0) facts.push(`Costs paid: ${money(run.costs)}${run.commission ? `, of which ${money(run.commission)} commission` : ''}.`);
  facts.push(bt.interest > 0 ? `${bt.cashRateNote}: ${money(bt.interest)} of interest.` : `${bt.cashRateNote}.`);
  h(root, 'div', 'bt-note', facts.join(' '));
  const traded = prices.filter((p) => spec.universe.some((a) => a.name === p.name));
  if (traded.length) {
    const through = Math.min(...traded.map((p) => p.through));
    const sources = [...new Set(traded.map((p) => PRICES_FROM[p.source]))].join(' and ');
    h(root, 'div', 'bt-note', `Prices through ${stamp(through, intraday)}, from ${sources}.`);
  }

  segments(root, bt);
  renderPositions(root, bt, intraday, triggers);
  renderTrades(root, bt, intraday);
  stops.push(renderDeepStats(root, { t: run.t, strategy: run.equity, benchmark: bt.benchmark.equity, benchmarkLabel: bt.benchmark.label, cashReturn: run.cashReturn }));
  for (const section of sections) {
    const stop = section(root);
    if (stop) stops.push(stop);
  }
  return stops;
}

function chevron(parent: HTMLElement): void {
  const span = h(parent, 'span', 'bt-chevron');
  span.setAttribute('aria-hidden', 'true');
  const svg = s(span, 'svg', { width: 12, height: 12, viewBox: '0 0 12 12' });
  s(svg, 'path', { d: 'M4 2l4 4-4 4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
}

/**
 * The result of a run. The title is a button that folds the result to one line (its figures, what it holds, what is due)
 * and opens it again. The result itself is not built until the block is first open.
 */
export function renderResult(el: HTMLElement, view: ResultView): () => void {
  el.replaceChildren();
  const root = h(el, 'div', 'bt-root');
  const cleanups: (() => void)[] = [];
  const first = view.out;

  const head = h(root, 'div', 'bt-head');
  const fold = h(head, 'button', 'bt-fold');
  fold.type = 'button';
  chevron(fold);
  const text = h(fold, 'span', 'bt-fold-text');
  h(text, 'span', 'bt-title', first.spec.name ?? 'Backtest');
  const line = h(text, 'span', 'bt-fold-facts');
  const facts = compactFacts(first);
  for (const fact of [...(facts.tickers ? [facts.tickers] : []), ...facts.figures, facts.holding]) h(line, 'span', 'bt-fold-fact', fact);
  if (facts.order) h(line, 'span', 'bt-fold-fact bt-fold-order', facts.order);
  const noteCount = notesOf(view, first).length;
  if (noteCount > 0) h(line, 'span', 'bt-fold-mark', noteCount === 1 ? '1 note' : `${noteCount} notes`);
  const refresh = h(head, 'button', 'bt-button', 'Refresh prices');
  refresh.addEventListener('click', view.onRefresh);
  const body = h(root, 'div', 'bt-body');

  const build = () => {
    const sub = h(body, 'div', 'bt-sub', summary(first.spec, view.source));
    source(body, view.source);

    // The bar is made once, before the result it drives, and is never redrawn.
    let show = (_out: RunOutput, _settled: boolean): void => {};
    if (view.params && first.spec.params.length > 0) {
      cleanups.push(renderParamBar(body, { params: first.spec.params, hook: view.params, show: (out, settled) => show(out, settled) }));
    }

    const notes = h(body, 'div', 'bt-notes');
    const tiles = h(h(body, 'div', 'bt-tiles-box'), 'div', 'bt-tiles');
    const figuresNote = h(body, 'div', 'bt-figures-note');
    const legend = h(body, 'div', 'bt-legend');
    const chart = h(body, 'div', 'bt-chart');
    const tip = h(chart, 'div', 'bt-tip');
    tip.hidden = true;
    const rest = h(body, 'div', 'bt-rest');

    let bt = first.backtest;
    let drawn = 0;
    // Drawing the chart changes its height, which would notify the observer again within the same frame.
    const observer = new ResizeObserver((entries) => {
      const width = Math.floor(entries[0].contentRect.width);
      if (width > 0 && width !== drawn) window.requestAnimationFrame(() => drawChart(chart, tip, (drawn = width), bt, isIntraday(bt.run.t)));
    });
    observer.observe(chart);
    cleanups.push(() => observer.disconnect());

    // While the block is folded the chart has no width; the observer draws it when it opens.
    const paint = (out: RunOutput) => {
      bt = out.backtest;
      sub.textContent = summary(out.spec, view.source);
      fillTiles(tiles, bt);
      fillLegend(legend, bt);
      chart.querySelector('svg')?.remove();
      drawn = Math.floor(chart.clientWidth);
      if (drawn > 0) drawChart(chart, tip, drawn, bt, isIntraday(bt.run.t));
    };
    let stops: (() => void)[] = [];
    const stopRest = () => {
      for (const stop of stops) stop();
      stops = [];
    };
    cleanups.push(stopRest);

    const paintAll = (out: RunOutput) => {
      notes.replaceChildren();
      for (const text of notesOf(view, out)) h(notes, 'div', 'bt-warning', text);
      paint(out);
      stopRest();
      figuresNote.replaceChildren();
      const watching = view.figuresNote?.(figuresNote, out);
      rest.replaceChildren();
      rest.classList.remove('bt-stale');
      stops = [...fillRest(rest, out, view.sections?.(out) ?? [], view.triggers?.(out) ?? null), ...(watching ? [watching] : [])];
    };
    // Between two frames of a drag only what is at the top is worth redrawing; the rest says it is out of date.
    show = (out, settled) => {
      if (settled) paintAll(out);
      else {
        paint(out);
        rest.classList.add('bt-stale');
      }
    };
    paintAll(first);
  };

  let built = false;
  const setOpen = (open: boolean) => {
    root.classList.toggle('bt-folded', !open);
    fold.setAttribute('aria-expanded', String(open));
    fold.title = open ? 'Fold this result to one line' : 'Open this result';
    body.hidden = refresh.hidden = !open;
    if (open && !built) {
      built = true;
      build();
    }
  };
  fold.addEventListener('click', () => {
    const open = fold.getAttribute('aria-expanded') !== 'true';
    setOpen(open);
    view.remember?.set(open);
  });
  setOpen(view.remember?.get() ?? !view.compact);
  return () => cleanups.forEach((stop) => stop());
}

function drawChart(chart: HTMLElement, tip: HTMLElement, width: number, bt: Backtest, intraday: boolean): void {
  chart.querySelector('svg')?.remove();
  const { run, benchmark, drawdown } = bt;
  const t = run.t;
  const n = t.length;
  const left = 52;
  const right = 8;
  const top = 8;
  const eqH = Math.round(Math.min(260, Math.max(170, width * 0.36)));
  const gap = 30;
  const ddH = 80;
  const ddTop = top + eqH + gap;
  const height = ddTop + ddH + 24;
  const plotW = width - left - right;

  const svg = s(chart, 'svg', { width, height, class: 'bt-svg', role: 'img', 'aria-label': 'Strategy and benchmark value over time, with drawdowns below' });
  const x = (time: number) => left + ((time - t[0]) / (t[n - 1] - t[0])) * plotW;

  // The benchmark has no value (NaN) before its first bar when its prices start later.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    for (const v of [run.equity[i], benchmark.equity[i]]) {
      if (!Number.isFinite(v)) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  lo = Math.max(lo, 1e-9);
  const pad = Math.max(Math.log(hi / lo) * 0.04, 0.01);
  const [l0, l1] = [Math.log(lo) - pad, Math.log(hi) + pad];
  const yEq = (v: number) => top + (1 - (Math.log(Math.max(v, 1e-9)) - l0) / (l1 - l0)) * eqH;

  let ddMin = 0;
  for (let i = 0; i < n; i++) ddMin = Math.min(ddMin, drawdown[i], Number.isNaN(benchmark.drawdown[i]) ? 0 : benchmark.drawdown[i]);
  ddMin = Math.min(ddMin, -0.01);
  const yDd = (v: number) => ddTop + (v / ddMin) * ddH;

  const split = bt.spec.testFrom;
  if (split !== null && split > t[0] && split < t[n - 1]) {
    s(svg, 'rect', { x: x(split), y: top, width: width - right - x(split), height: ddTop + ddH - top, class: 'bt-test-band' });
    s(svg, 'text', { x: x(split) + 5, y: top + 13, class: 'bt-axis bt-test-label' }, 'Test period');
  }

  // Grid and axis labels.
  for (const v of moneyTicks(Math.exp(l0), Math.exp(l1))) {
    s(svg, 'line', { x1: left, x2: width - right, y1: yEq(v), y2: yEq(v), class: 'bt-grid' });
    s(svg, 'text', { x: left - 6, y: yEq(v) + 3.5, class: 'bt-axis', 'text-anchor': 'end' }, money(v));
  }
  const ddStep = niceStep(-ddMin, 2);
  for (let v = 0; v >= ddMin - 1e-9; v -= ddStep) {
    s(svg, 'line', { x1: left, x2: width - right, y1: yDd(v), y2: yDd(v), class: v === 0 ? 'bt-baseline' : 'bt-grid' });
    s(svg, 'text', { x: left - 6, y: yDd(v) + 3.5, class: 'bt-axis', 'text-anchor': 'end' }, pct(v, 0));
  }
  s(svg, 'text', { x: left, y: ddTop - 9, class: 'bt-axis bt-panel-label' }, 'Drawdown from the previous high');
  for (const tick of timeTicks(t[0], t[n - 1], plotW)) {
    s(svg, 'text', { x: x(tick.t), y: height - 6, class: 'bt-axis', 'text-anchor': 'middle' }, tick.label);
    s(svg, 'line', { x1: x(tick.t), x2: x(tick.t), y1: ddTop + ddH, y2: ddTop + ddH + 4, class: 'bt-baseline' });
  }

  // About two points per pixel is all a line can show.
  const stride = Math.max(1, Math.floor(n / (plotW * 2)));
  // A line starts at its first known value.
  const path = (values: number[], y: (v: number) => number) => {
    let first = 0;
    while (first < n && !Number.isFinite(values[first])) first++;
    let d = '';
    for (let i = first; i < n; i += stride) d += `${d ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y(values[i]).toFixed(1)}`;
    if (first < n && (n - 1 - first) % stride !== 0) d += `L${x(t[n - 1]).toFixed(1)},${y(values[n - 1]).toFixed(1)}`;
    return d;
  };
  const ddPath = path(drawdown, yDd);
  s(svg, 'path', { d: `${ddPath}L${x(t[n - 1]).toFixed(1)},${yDd(0)}L${left},${yDd(0)}Z`, class: 'bt-area-strategy' });
  s(svg, 'path', { d: path(benchmark.drawdown, yDd), class: 'bt-line bt-line-benchmark bt-line-thin' });
  s(svg, 'path', { d: ddPath, class: 'bt-line bt-line-strategy bt-line-thin' });
  s(svg, 'path', { d: path(benchmark.equity, yEq), class: 'bt-line bt-line-benchmark' });
  s(svg, 'path', { d: path(run.equity, yEq), class: 'bt-line bt-line-strategy' });

  // Hover: one crosshair through both panels.
  const cross = s(svg, 'line', { y1: top, y2: ddTop + ddH, class: 'bt-cross', visibility: 'hidden' });
  const dotB = s(svg, 'circle', { r: 4, class: 'bt-dot bt-dot-benchmark', visibility: 'hidden' });
  const dotS = s(svg, 'circle', { r: 4, class: 'bt-dot bt-dot-strategy', visibility: 'hidden' });
  const hit = s(svg, 'rect', { x: left, y: top, width: plotW, height: ddTop + ddH - top, fill: 'transparent' });
  const hide = () => {
    tip.hidden = true;
    for (const el of [cross, dotB, dotS]) el.setAttribute('visibility', 'hidden');
  };
  const show = (clientX: number) => {
    const box = svg.getBoundingClientRect();
    const time = t[0] + ((clientX - box.left - left) / plotW) * (t[n - 1] - t[0]);
    let a = 0;
    let b = n - 1;
    while (b - a > 1) {
      const mid = (a + b) >> 1;
      if (t[mid] <= time) a = mid;
      else b = mid;
    }
    const i = time - t[a] <= t[b] - time ? a : b;
    const px = x(t[i]);
    cross.setAttribute('x1', String(px));
    cross.setAttribute('x2', String(px));
    dotS.setAttribute('cx', String(px));
    dotS.setAttribute('cy', String(yEq(run.equity[i])));
    dotB.setAttribute('cx', String(px));
    dotB.setAttribute('cy', String(yEq(benchmark.equity[i])));
    for (const el of [cross, dotB, dotS]) el.setAttribute('visibility', 'visible');
    if (!Number.isFinite(benchmark.equity[i])) dotB.setAttribute('visibility', 'hidden');

    tip.replaceChildren();
    h(tip, 'div', 'bt-tip-date', stamp(t[i], intraday));
    const row = (cls: string, label: string, value: number, dd: number) => {
      const r = h(tip, 'div', 'bt-tip-row');
      h(r, 'span', `bt-swatch ${cls}`);
      h(r, 'span', 'bt-tip-label', label);
      h(r, 'span', 'bt-tip-value', Number.isFinite(value) ? money(value) : '–');
      h(r, 'span', 'bt-tip-dd', pct(dd));
    };
    row('bt-swatch-strategy', 'Strategy', run.equity[i], drawdown[i]);
    row('bt-swatch-benchmark', benchmark.label, benchmark.equity[i], benchmark.drawdown[i]);
    h(tip, 'div', 'bt-tip-foot', `${pct(run.exposure[i], 0)} invested`);
    tip.hidden = false;
    const flip = px > left + plotW / 2;
    tip.style.left = flip ? '' : `${px + 12}px`;
    tip.style.right = flip ? `${width - px + 12}px` : '';
    tip.style.top = `${top + 4}px`;
  };
  hit.addEventListener('pointermove', (e) => show((e as PointerEvent).clientX));
  hit.addEventListener('pointerdown', (e) => show((e as PointerEvent).clientX));
  hit.addEventListener('pointerleave', hide);
}
