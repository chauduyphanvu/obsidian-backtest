import type { Backtest, Segment } from './backtest.ts';
import { STOP_SETTINGS, type Commission, type Diagnostic, type Spec, type StopLevel } from './dsl.ts';
import { colourLines, colourSource, h, s } from './dom.ts';
import type { AssetState } from './engine.ts';
import { hintFor } from './fixes.ts';
import { DAY, isIntraday, isoDate, minus, money, pct, signedPct, stamp } from './format.ts';
import { commentStart, declaredParams, settingKey } from './highlight.ts';
import { anywayLabel, type LimitError } from './limits.ts';
import { pendingTiming, timingPhrase } from './orders.ts';
import { formatParam, renderParamBar, type ParamsHook } from './render-params.ts';
import { renderValueChart, sparkline } from './render-chart.ts';
import { renderNow, watchText } from './render-now.ts';
import { renderMonths, renderYears } from './render-stats.ts';
import { renderTrades } from './render-trades.ts';
import { verdictView, versusView } from './render-versus.ts';
import { sectionsIn, tabify, tabName } from './tabs.ts';
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

/**
 * What a folded block shows besides its name, worded like the positions table. A flip is said as its two orders: "sells A
 * and sells short A", "buys to cover A and buys A".
 */
export function compactFacts(out: RunOutput): CompactFacts {
  const { stats, run } = out.backtest;
  const intraday = isIntraday(run.t);
  const held = run.states.filter((st) => st.side !== null);
  const steps = out.spec.entries ?? 1;
  const one = held.length === 1 ? held[0] : null;
  const built = one && steps > 1 ? `, ${one.entries} of ${steps} entries` : '';
  const shorts = held.filter((st) => st.side === 'short').length;
  const total = run.states.length;
  const several = shorts === 0 ? `Holds ${held.length} of ${total}` : shorts === held.length ? `Short ${shorts} of ${total}` : `Long ${held.length - shorts}, short ${shorts} of ${total}`;
  const holding = !one ? (held.length === 0 ? 'In cash' : several) : `${one.side === 'short' ? 'Short' : 'Long'} ${one.name} since ${stamp(one.since!, intraday)}${built}`;
  const list = (names: string[], most = 2, joiner = ' and ') => (names.length <= most ? names.join(joiner) : `${names.length} tickers`);
  const phrases = (groups: [string, (st: AssetState) => boolean][], of = run.states) =>
    groups.flatMap(([verb, pick]) => {
      const names = of.filter(pick).map((st) => st.name);
      return names.length ? [`${verb} ${list(names)}`] : [];
    });
  // A margin call made at the last close closes its positions at the next open, whatever the block's fill.
  const calledAt = run.states.filter((st) => st.marginCall);
  const waiting = run.states.filter((st) => !st.marginCall);
  const called = phrases(
    [
      ['sells', (st) => st.pending === 'sell'],
      ['buys to cover', (st) => st.pending === 'cover'],
    ],
    calledAt,
  );
  // Covers come before buys and short sales after sells, so a flip reads in the order it fills.
  const due = phrases(
    [
      ['buys to cover', (st) => st.pending === 'cover' || (st.pending === 'buy' && st.side === 'short')],
      ['buys', (st) => st.pending === 'buy'],
      ['adds to', (st) => st.pending === 'add'],
      ['sells', (st) => st.pending === 'sell' || (st.pending === 'short' && st.side === 'long')],
      ['sells short', (st) => st.pending === 'short'],
    ],
    waiting,
  );
  const done = phrases([
    ['bought to cover', (st) => st.filled?.side === 'cover' || (st.filled?.side === 'buy' && !!st.filled.closed)],
    ['bought', (st) => st.filled?.side === 'buy'],
    ['added to', (st) => st.filled?.side === 'add'],
    ['sold', (st) => st.filled?.side === 'sell' || (st.filled?.side === 'short' && !!st.filled.closed)],
    ['sold short', (st) => st.filled?.side === 'short'],
  ]);
  const order = [
    ...(called.length ? [`margin call: ${called.join(' and ')} at the next open`] : []),
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
  const num = (x: number) => (Number.isFinite(x) ? minus(x.toFixed(2)) : '–');
  row('Return per year', (g) => pct(g.stats.cagr));
  row(`${bt.benchmark.label}, per year`, (g) => pct(g.benchmarkStats.cagr));
  row('Worst drawdown', (g) => pct(g.stats.maxDrawdown));
  row('Sharpe ratio', (g) => num(g.stats.sharpe));
  row('Trades', (g) => String(g.tradeStats.count));
  h(wrap, 'div', 'bt-note', 'Rules chosen by looking at the first period are only tested by the second.');
}

const PRICES_FROM: Record<Source, string> = { yahoo: 'Yahoo', binance: 'Binance', csv: 'your CSV files', tiingo: 'Tiingo', fred: 'FRED' };

/** The foot of a result: its dates and money, how its orders fill, what it paid and earned, and where its prices came from. */
function finePrint(root: HTMLElement, out: RunOutput): void {
  const { spec, backtest: bt, prices } = out;
  const { run } = bt;
  const intraday = isIntraday(run.t);
  const box = h(root, 'div', 'bt-fine');
  const facts = [`${stamp(run.t[0], intraday)} to ${stamp(run.t[run.t.length - 1], intraday)}, starting with ${money(spec.capital)}.`, fillSentence(spec)];
  if (spec.magnify) facts.push(`A bar with a stop or target inside it is followed through its ${spec.magnify} bars, where it has them.`);
  if (run.costs > 0) facts.push(`Costs paid: ${money(run.costs)}${run.commission ? `, of which ${money(run.commission)} commission` : ''}.`);
  // Under half a dollar would read as "$0".
  if (run.borrowFees && run.borrowFees >= 0.5) facts.push(`Borrow fees for shorts: ${money(run.borrowFees)}.`);
  if (run.marginInterest && run.marginInterest >= 0.5) facts.push(`Interest on borrowed money: ${money(run.marginInterest)}.`);
  facts.push(bt.interest > 0 ? `${bt.cashRateNote}: ${money(bt.interest)} of interest.` : `${bt.cashRateNote}.`);
  h(box, 'div', 'bt-note', facts.join(' '));
  const traded = prices.filter((p) => spec.universe.some((a) => a.name === p.name));
  if (traded.length) {
    const through = Math.min(...traded.map((p) => p.through));
    const sources = [...new Set(traded.map((p) => PRICES_FROM[p.source]))].join(' and ');
    h(box, 'div', 'bt-note', `Prices through ${stamp(through, intraday)}, from ${sources}.`);
  }
}

/**
 * The parts of a result that are heavy to draw or rarely needed: what it holds and what the next close could do, the
 * sections as tabs, and the fine print. Returns what to run when they are drawn again or go away.
 */
function fillRest(root: HTMLElement, out: RunOutput, sections: Section[], triggers: Promise<TriggerReport | null> | null): (() => void)[] {
  const { backtest: bt } = out;
  const { run } = bt;
  const intraday = isIntraday(run.t);
  const stops: (() => void)[] = [];
  segments(root, bt);
  renderNow(root, { bt, intraday, holding: compactFacts(out).holding, triggers });
  const host = h(root, 'div', 'bt-sections');
  stops.push(renderTrades(host, bt, intraday));
  const periods = { t: run.t, strategy: run.equity, benchmark: bt.benchmark.equity, benchmarkLabel: bt.benchmark.label };
  stops.push(renderYears(host, periods), renderMonths(host, periods));
  for (const section of sections) {
    const stop = section(host);
    if (stop) stops.push(stop);
  }
  tabify(host);
  finePrint(root, out);
  return stops;
}

function chevron(parent: HTMLElement): void {
  const span = h(parent, 'span', 'bt-chevron');
  span.setAttribute('aria-hidden', 'true');
  const svg = s(span, 'svg', { width: 12, height: 12, viewBox: '0 0 12 12' });
  s(svg, 'path', { d: 'M4 2l4 4-4 4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
}

function refreshIcon(parent: HTMLElement): void {
  const svg = s(parent, 'svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  s(svg, 'path', { d: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
}

/**
 * The block's text, its settings folded away behind a button: the line under the title says them in words. Settings
 * after a `for` line are the ticker's own and stay in view.
 */
function sourcePanel(parent: HTMLElement, text: string): void {
  const src = text.trim();
  if (!src) return;
  const box = h(parent, 'div', 'bt-src');
  const pre = h(box, 'pre', 'bt-source');
  const lines = colourLines(pre, src);
  let inFor = false;
  let afterSetting = false;
  const fold = src.split('\n').map((line) => {
    if (/^\s*for\s+.+:\s*(#.*|\/\/.*)?$/i.test(line)) inFor = true;
    const setting = !inFor && settingKey(line) !== null;
    const gap = !line.trim() && afterSetting;
    if (line.trim()) afterSetting = setting;
    return setting || gap;
  });
  // Nothing to fold, or nothing that would stay in view, such as a ranking written as settings alone: show it all.
  const folded = fold.filter(Boolean).length;
  if (folded === 0 || folded === lines.length) return;
  fold.forEach((f, i) => f && lines[i].classList.add('bt-src-setting'));
  const toggle = h(box, 'button', 'bt-link-button bt-src-toggle', 'Show the whole block');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    const all = !box.classList.contains('bt-src-all');
    box.classList.toggle('bt-src-all', all);
    toggle.textContent = all ? 'Fold the settings' : 'Show the whole block';
    toggle.setAttribute('aria-expanded', String(all));
  });
}

/**
 * The result of a run. The title is a button that folds the result to one line (its growth, figures, what it holds, what
 * is due) and opens it again. The result itself is not built until the block is first open.
 */
export function renderResult(el: HTMLElement, view: ResultView): () => void {
  el.replaceChildren();
  const root = h(el, 'div', 'bt-root bt-result');
  const cleanups: (() => void)[] = [];
  const first = view.out;

  const head = h(root, 'div', 'bt-head');
  const fold = h(head, 'button', 'bt-fold');
  fold.type = 'button';
  chevron(fold);
  const text = h(fold, 'span', 'bt-fold-text');
  const titleRow = h(text, 'span', 'bt-title-row');
  h(titleRow, 'span', 'bt-title', first.spec.name ?? 'Backtest');
  const held = h(titleRow, 'span', 'bt-chip bt-chip-held');
  h(held, 'span', 'bt-chip-dot');
  const heldText = h(held, 'span');
  const order = h(titleRow, 'span', 'bt-chip bt-fold-order');
  const watch = h(titleRow, 'span', 'bt-chip bt-chip-watch');
  watch.hidden = true;
  const line = h(text, 'span', 'bt-fold-facts');
  const refresh = h(head, 'button', 'bt-icon-button');
  refresh.type = 'button';
  refresh.setAttribute('aria-label', 'Refresh prices');
  refreshIcon(refresh);
  refresh.addEventListener('click', view.onRefresh);
  const body = h(root, 'div', 'bt-body');

  // The top line follows the run on screen: what it holds, what is due, and how near the next order is once that is known.
  let onHead: Backtest | null = null;
  const showHead = (out: RunOutput): Promise<TriggerReport | null> | null => {
    const bt = out.backtest;
    onHead = bt;
    const facts = compactFacts(out);
    heldText.textContent = facts.holding;
    held.classList.toggle('bt-chip-cash', !bt.run.states.some((st) => st.side !== null));
    order.textContent = facts.order ?? '';
    order.hidden = !facts.order;
    line.replaceChildren();
    sparkline(line, bt);
    for (const fact of [...(facts.tickers ? [facts.tickers] : []), ...facts.figures]) h(line, 'span', 'bt-fold-fact', fact);
    const noteCount = notesOf(view, out).length;
    if (noteCount > 0) h(line, 'span', 'bt-fold-mark', noteCount === 1 ? '1 note' : `${noteCount} notes`);
    watch.hidden = true;
    const asked = view.triggers?.(out) ?? null;
    asked?.then(
      (report) => {
        const said = report && onHead === bt ? watchText(report, bt.run.states.length) : null;
        if (!said) return;
        watch.replaceChildren();
        h(watch, 'span', 'bt-chip-warn');
        watch.append(said);
        watch.hidden = false;
      },
      () => {},
    );
    return asked;
  };
  const firstTriggers = showHead(first);

  const build = () => {
    const sub = h(body, 'div', 'bt-sub', summary(first.spec, view.source));
    sourcePanel(body, view.source);

    // The bar is made once, before the result it drives, and is never redrawn.
    let show = (_out: RunOutput, _settled: boolean): void => {};
    if (view.params && first.spec.params.length > 0) {
      cleanups.push(renderParamBar(body, { params: first.spec.params, hook: view.params, show: (out, settled) => show(out, settled) }));
    }

    const notes = h(body, 'div', 'bt-notes');
    const said = verdictView(body);
    const figs = versusView(body);
    const figuresNote = h(body, 'div', 'bt-figures-note');
    const chart = renderValueChart(body);
    cleanups.push(chart.stop);
    const rest = h(body, 'div', 'bt-rest');

    const paint = (out: RunOutput) => {
      sub.textContent = summary(out.spec, view.source);
      said.show(out.backtest);
      figs.show(out.backtest);
      chart.show(out.backtest);
    };
    let stops: (() => void)[] = [];
    const stopRest = () => {
      for (const stop of stops) stop();
      stops = [];
    };
    cleanups.push(stopRest);

    const paintAll = (out: RunOutput, triggers: Promise<TriggerReport | null> | null) => {
      notes.replaceChildren();
      for (const text of notesOf(view, out)) h(notes, 'div', 'bt-warning', text);
      paint(out);
      stopRest();
      figuresNote.replaceChildren();
      const watching = view.figuresNote?.(figuresNote, out);
      // The tab open before a slider is let go stays open on the new run.
      const open = tabName(sectionsIn(rest.querySelector('.bt-sections')).find((d) => d.open) ?? null);
      rest.replaceChildren();
      rest.classList.remove('bt-stale');
      stops = [...fillRest(rest, out, view.sections?.(out) ?? [], triggers), ...(watching ? [watching] : [])];
      const again = sectionsIn(rest.querySelector('.bt-sections')).find((d) => tabName(d) === open);
      if (again) again.open = true;
    };
    // Between two frames of a drag only what is at the top is worth redrawing; the rest says it is out of date.
    show = (out, settled) => {
      if (settled) paintAll(out, showHead(out));
      else {
        paint(out);
        rest.classList.add('bt-stale');
      }
    };
    paintAll(first, firstTriggers);
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
