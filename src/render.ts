import type { Backtest } from './backtest.ts';
import type { Diagnostic, Spec } from './dsl.ts';
import type { Trade } from './engine.ts';
import { DAY, MONTHS, h, isoDate, minus, money, niceStep, pct, price, s, signedPct, stamp } from './dom.ts';
import { tokenizeBlock } from './highlight.ts';

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
  const parts = [spec.universe.map((a) => (spec.universe.length > 1 || a.weight < 1 ? `${a.name} ${Number((a.weight * 100).toFixed(1))}%` : a.name)).join(' · ')];
  if (spec.rebalance !== 'never') parts.push(`rebalanced ${spec.rebalance}`);
  if (spec.interval !== '1d') parts.push(`${spec.interval} bars`);
  parts.push(spec.costBps ? `${spec.costBps} bps costs` : 'no costs');
  if (spec.stopLoss !== null) parts.push(`${pct(spec.stopLoss, 0)} stop`);
  if (spec.trailingStop !== null) parts.push(`${pct(spec.trailingStop, 0)} trailing stop`);
  if (spec.takeProfit !== null) parts.push(`${pct(spec.takeProfit, 0)} target`);
  return parts.join(', ');
}

export function renderResult(el: HTMLElement, spec: Spec, bt: Backtest, warnings: string[], src: string, onRefresh: () => void): () => void {
  el.replaceChildren();
  const root = h(el, 'div', 'bt-root');
  const { run, stats, tradeStats, benchmark } = bt;
  const first = run.t[0];
  const last = run.t[run.t.length - 1];
  const intraday = run.t.some((t) => t % DAY !== 0);

  const head = h(root, 'div', 'bt-head');
  const titles = h(head, 'div');
  h(titles, 'div', 'bt-title', spec.name ?? 'Backtest');
  h(titles, 'div', 'bt-sub', summary(spec));
  const refresh = h(head, 'button', 'bt-button', 'Refresh prices');
  refresh.addEventListener('click', onRefresh);
  source(root, src);

  for (const w of warnings) h(root, 'div', 'bt-warning', w);
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
  const observer = new ResizeObserver((entries) => {
    const width = Math.floor(entries[0].contentRect.width);
    if (width > 0) drawChart(chart, tip, width, bt, intraday);
  });
  observer.observe(chart);

  h(root, 'div', 'bt-note', `${stamp(first, intraday)} to ${stamp(last, intraday)}, starting with ${money(spec.capital)}. A rule seen at a close fills at the next open.${run.costs > 0 ? ` Costs paid: ${money(run.costs)}.` : ''}`);

  positions(root, bt, intraday);
  trades(root, run.trades, intraday);
  return () => observer.disconnect();
}

function positions(root: HTMLElement, bt: Backtest, intraday: boolean): void {
  const table = h(root, 'table', 'bt-table');
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
      for (const [text, num] of [['Ticker', 0], ['Bought', 0], ['At', 1], ['Sold', 0], ['At', 1], ['Return', 1], ['Exit', 0]] as const) {
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
        h(row, 'td', undefined, t.reason === 'open' ? 'still held' : t.reason === 'signal' ? 'sell rule' : t.reason);
      }
    },
    { once: true },
  );
}

/** Ticks for a log axis: 1-2-5 steps over a wide range, even steps over a narrow one. */
function moneyTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  if (hi / lo < 10) {
    const step = niceStep(hi - lo, 5);
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
    return out;
  }
  const mults = hi / lo > 2000 ? [1] : hi / lo > 60 ? [1, 3] : [1, 2, 5];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of mults) {
      const v = m * 10 ** e;
      if (v >= lo && v <= hi) out.push(v);
    }
  }
  return out;
}

function timeTicks(t0: number, t1: number, width: number): { t: number; label: string }[] {
  const max = Math.max(2, Math.floor(width / 80));
  const out: { t: number; label: string }[] = [];
  const days = (t1 - t0) / DAY;
  if (days < 3) {
    const step = [1, 2, 3, 4, 6, 12, 24].find((x) => days * 24 / x <= max) ?? 24;
    for (let t = Math.ceil(t0 / (step * 3_600_000)) * step * 3_600_000; t <= t1; t += step * 3_600_000) {
      const d = new Date(t);
      out.push({ t, label: d.getUTCHours() === 0 ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : `${String(d.getUTCHours()).padStart(2, '0')}:00` });
    }
  } else if (days < 75) {
    const step = [1, 2, 7, 14].find((x) => days / x <= max) ?? 14;
    for (let t = Math.ceil(t0 / DAY) * DAY; t <= t1; t += step * DAY) {
      const d = new Date(t);
      out.push({ t, label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` });
    }
  } else {
    const months = days / 30.44;
    const step = [1, 2, 3, 6, 12, 24, 60, 120].find((x) => months / x <= max) ?? 240;
    const d0 = new Date(t0);
    let m = d0.getUTCFullYear() * 12 + d0.getUTCMonth();
    m = Math.ceil(m / step) * step;
    for (;; m += step) {
      const t = Date.UTC(Math.floor(m / 12), m % 12, 1);
      if (t > t1) break;
      if (t >= t0) out.push({ t, label: step >= 12 ? String(Math.floor(m / 12)) : m % 12 === 0 ? String(Math.floor(m / 12)) : MONTHS[m % 12] });
    }
  }
  return out;
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
