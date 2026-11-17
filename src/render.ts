import type { Backtest, Segment } from './backtest.ts';
import type { Diagnostic, Spec, StopLevel } from './dsl.ts';
import type { Trade } from './engine.ts';
import { DAY, h, isoDate, minus, money, moneyTicks, niceStep, pct, price, s, signedPct, stamp, timeTicks } from './dom.ts';
import { tokenizeBlock } from './highlight.ts';
import { renderDeepStats } from './render-stats.ts';
import type { RunOutput } from './runner.ts';

const MAX_TRADE_ROWS = 500;

/** The strategy as written: the block replaces its own text, so the result has to show it. */
function source(el: HTMLElement, text: string): void {
  const pre = h(el, 'pre', 'bt-source');
  const lines = text.trim().split('\n');
  tokenizeBlock(lines).forEach((tokens, i) => {
    const line = lines[i];
    let at = 0;
    for (const t of tokens) {
      if (t.from > at) pre.append(line.slice(at, t.from));
      h(pre, 'span', `bt-tok bt-tok-${t.kind}`, line.slice(t.from, t.to));
      at = t.to;
    }
    pre.append(line.slice(at) + (i < lines.length - 1 ? '\n' : ''));
  });
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

function summary(spec: Spec): string {
  const names = spec.universe.map((a) => a.name);
  const parts = [
    spec.rank
      ? `the top ${spec.rank.top} of ${names.length > 6 ? `${names.length} tickers` : names.join(', ')}, ${pct(spec.universe[0].weight, 0)} each`
      : spec.universe.map((a) => (names.length > 1 || a.weight < 1 ? `${a.name} ${Number((a.weight * 100).toFixed(1))}%` : a.name)).join(' \u00b7 '),
  ];
  if (spec.sizing.k === 'invvol') parts.push('sized by inverse volatility');
  if (spec.sizing.k === 'risk') parts.push(`${pct(spec.sizing.risk, 1)} risked per trade`);
  if (spec.rebalance !== 'never') parts.push(spec.rank ? `chosen ${spec.rebalance}` : `rebalanced ${spec.rebalance}`);
  if (spec.interval !== '1d') parts.push(`${spec.interval} bars`);
  parts.push(spec.costBps ? `${spec.costBps} bps costs` : 'no costs');
  if (spec.slippageBps) parts.push(`${spec.slippageBps} bps slippage`);
  const level = (l: StopLevel | null) => (l === null ? '' : l.k === 'pct' ? pct(l.v, 0) : `${l.mult} ATR`);
  const text = (name: string) => {
    const st = spec.stops[name];
    return [st.stopLoss && `${level(st.stopLoss)} stop`, st.trailingStop && `${level(st.trailingStop)} trailing stop`, st.takeProfit && `${level(st.takeProfit)} target`].filter(Boolean).join(', ');
  };
  const stops = new Set(names.map(text));
  if (stops.size > 1) parts.push('stops set per ticker');
  else if (text(names[0])) parts.push(text(names[0]));
  if (spec.params.length) parts.push(spec.params.map((p) => `${p.name} ${p.percent ? pct(p.value, 1) : p.value}`).join(', '));
  return parts.join(', ');
}

/** A section added under the standard result; returns a cleanup function when it holds observers. */
export type Section = (root: HTMLElement) => (() => void) | void;

export interface ResultView {
  source: string;
  out: RunOutput;
  /** The parser's warnings for this block. */
  notes: Diagnostic[];
  onRefresh: () => void;
  /** Sections placed after the trade list, in order. */
  sections?: Section[];
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

export function renderResult(el: HTMLElement, view: ResultView): () => void {
  el.replaceChildren();
  const root = h(el, 'div', 'bt-root');
  const { spec, backtest: bt, warnings, prices } = view.out;
  const { run, stats, tradeStats, benchmark } = bt;
  const first = run.t[0];
  const last = run.t[run.t.length - 1];
  const intraday = run.t.some((t) => t % DAY !== 0);
  const cleanups: (() => void)[] = [];

  const head = h(root, 'div', 'bt-head');
  const titles = h(head, 'div');
  h(titles, 'div', 'bt-title', spec.name ?? 'Backtest');
  h(titles, 'div', 'bt-sub', summary(spec));
  const refresh = h(head, 'button', 'bt-button', 'Refresh prices');
  refresh.addEventListener('click', view.onRefresh);
  source(root, view.source);

  for (const w of warnings) h(root, 'div', 'bt-warning', w);
  for (const n of view.notes) h(root, 'div', 'bt-warning', `Line ${n.line}: ${n.message}`);
  if (spec.from !== null && first - spec.from > 7 * DAY) {
    h(root, 'div', 'bt-warning', `The run starts on ${isoDate(first)}, the first day every ticker has prices, not ${isoDate(spec.from)}.`);
  }

  const tiles = h(root, 'div', 'bt-tiles');
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

  const legend = h(root, 'div', 'bt-legend');
  const key = (cls: string, label: string, value: number) => {
    const k = h(legend, 'span', 'bt-key');
    h(k, 'span', `bt-swatch ${cls}`);
    h(k, 'span', undefined, label);
    h(k, 'span', 'bt-key-value', money(value));
  };
  key('bt-swatch-strategy', 'Strategy', run.equity[run.equity.length - 1]);
  key('bt-swatch-benchmark', benchmark.label, benchmark.equity[benchmark.equity.length - 1]);

  const chart = h(root, 'div', 'bt-chart');
  const tip = h(chart, 'div', 'bt-tip');
  tip.hidden = true;
  let drawn = 0;
  const observer = new ResizeObserver((entries) => {
    const width = Math.floor(entries[0].contentRect.width);
    // Drawing changes the chart's height, which would notify this observer again within the same frame.
    if (width > 0 && width !== drawn) window.requestAnimationFrame(() => drawChart(chart, tip, (drawn = width), bt, intraday));
  });
  observer.observe(chart);
  cleanups.push(() => observer.disconnect());

  const facts = [`${stamp(first, intraday)} to ${stamp(last, intraday)}, starting with ${money(spec.capital)}.`, 'A rule seen at a close fills at the next open.'];
  if (run.costs > 0) facts.push(`Costs paid: ${money(run.costs)}.`);
  facts.push(bt.interest > 0 ? `${bt.cashRateNote}: ${money(bt.interest)} of interest.` : `${bt.cashRateNote}.`);
  h(root, 'div', 'bt-note', facts.join(' '));
  const traded = prices.filter((p) => spec.universe.some((a) => a.name === p.name));
  if (traded.length) {
    const through = Math.min(...traded.map((p) => p.through));
    const sources = [...new Set(traded.map((p) => ({ yahoo: 'Yahoo', binance: 'Binance', stooq: 'Stooq', csv: 'your CSV files' })[p.source]))].join(' and ');
    h(root, 'div', 'bt-note', `Prices through ${stamp(through, intraday)}, from ${sources}.`);
  }

  segments(root, bt);
  positions(root, bt, intraday);
  trades(root, run.trades, intraday);
  cleanups.push(renderDeepStats(root, { t: run.t, strategy: run.equity, benchmark: benchmark.equity, benchmarkLabel: benchmark.label }));
  for (const section of view.sections ?? []) {
    const stop = section(root);
    if (stop) cleanups.push(stop);
  }
  return () => cleanups.forEach((stop) => stop());
}

function positions(root: HTMLElement, bt: Backtest, intraday: boolean): void {
  const table = h(h(root, 'div', 'bt-wide'), 'table', 'bt-table');
  const head = h(h(table, 'thead'), 'tr');
  for (const [text, num] of [['Ticker', 0], ['Weight', 1], ['Now', 0], ['Trades', 1], ['Won', 1], ['Average trade', 1]] as const) {
    h(head, 'th', num ? 'bt-num' : undefined, text);
  }
  const body = h(table, 'tbody');
  for (const st of bt.run.states) {
    const closed = bt.run.trades.filter((t) => t.asset === st.name && t.reason !== 'open');
    const row = h(body, 'tr');
    h(row, 'td', undefined, st.name);
    h(row, 'td', 'bt-num', pct(st.weight, 0));
    const now = st.long ? `Long since ${stamp(st.since!, intraday)}` : 'In cash';
    h(row, 'td', undefined, now + (st.pending ? `, ${st.pending === 'buy' ? 'buys' : 'sells'} at the next open` : ''));
    h(row, 'td', 'bt-num', String(closed.length));
    h(row, 'td', 'bt-num', closed.length ? pct(closed.filter((t) => t.ret > 0).length / closed.length, 0) : '–');
    h(row, 'td', 'bt-num', closed.length ? signedPct(closed.reduce((a, t) => a + t.ret, 0) / closed.length) : '–');
  }
}

function trades(root: HTMLElement, all: Trade[], intraday: boolean): void {
  if (all.length === 0) return;
  const d = h(root, 'details', 'bt-details');
  h(d, 'summary', undefined, `Trades (${all.length})`);
  // Built on first open: a long run can have thousands of rows.
  d.addEventListener(
    'toggle',
    () => {
      const shown = all.slice(-MAX_TRADE_ROWS).reverse();
      if (shown.length < all.length) h(d, 'div', 'bt-note', `Showing the latest ${shown.length} of ${all.length}.`);
      const table = h(h(d, 'div', 'bt-scroll'), 'table', 'bt-table');
      const head = h(h(table, 'thead'), 'tr');
      for (const [text, num] of [['Ticker', 0], ['Bought', 0], ['At', 1], ['Sold', 0], ['At', 1], ['Return', 1], ['Profit', 1], ['Exit', 0]] as const) {
        h(head, 'th', num ? 'bt-num' : undefined, text);
      }
      const body = h(table, 'tbody');
      for (const t of shown) {
        const row = h(body, 'tr');
        h(row, 'td', undefined, t.asset);
        h(row, 'td', undefined, stamp(t.entryT, intraday));
        h(row, 'td', 'bt-num', price(t.entryPrice));
        h(row, 'td', undefined, t.reason === 'open' ? '–' : stamp(t.exitT, intraday));
        h(row, 'td', 'bt-num', price(t.exitPrice));
        h(row, 'td', 'bt-num', signedPct(t.ret));
        h(row, 'td', 'bt-num', (t.pnl > 0 ? '+' : '') + minus(money(t.pnl)));
        h(row, 'td', undefined, t.reason === 'open' ? 'still held' : t.reason === 'signal' ? 'sell rule' : t.reason);
      }
    },
    { once: true },
  );
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

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, run.equity[i], benchmark.equity[i]);
    hi = Math.max(hi, run.equity[i], benchmark.equity[i]);
  }
  lo = Math.max(lo, 1e-9);
  const pad = Math.max(Math.log(hi / lo) * 0.04, 0.01);
  const [l0, l1] = [Math.log(lo) - pad, Math.log(hi) + pad];
  const yEq = (v: number) => top + (1 - (Math.log(Math.max(v, 1e-9)) - l0) / (l1 - l0)) * eqH;

  let ddMin = 0;
  for (let i = 0; i < n; i++) ddMin = Math.min(ddMin, drawdown[i], benchmark.drawdown[i]);
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
  const path = (values: number[], y: (v: number) => number) => {
    let d = '';
    for (let i = 0; i < n; i += stride) d += `${d ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y(values[i]).toFixed(1)}`;
    if ((n - 1) % stride !== 0) d += `L${x(t[n - 1]).toFixed(1)},${y(values[n - 1]).toFixed(1)}`;
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

    tip.replaceChildren();
    h(tip, 'div', 'bt-tip-date', stamp(t[i], intraday));
    const row = (cls: string, label: string, value: number, dd: number) => {
      const r = h(tip, 'div', 'bt-tip-row');
      h(r, 'span', `bt-swatch ${cls}`);
      h(r, 'span', 'bt-tip-label', label);
      h(r, 'span', 'bt-tip-value', money(value));
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
