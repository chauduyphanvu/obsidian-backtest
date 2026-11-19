// The "Prices and trades" section: a ticker's price with the strategy's holding periods, buys and sells marked, and for a
// strategy that shorts its short sales and covers too.

import { h, s } from './dom.ts';
import type { Trade } from './engine.ts';
import { price, signedPct, stamp, timeTicks } from './format.ts';
import {
  MARKER_REACH,
  boughtWording,
  buyAndHold,
  buyPoints,
  clipBars,
  clipTrades,
  decimate,
  heldIntervals,
  heldShare,
  markerCount,
  markerPath,
  nearestIndex,
  priceRange,
  priceScale,
  priceTicks,
  showMarkers,
  summaryLine,
  tradeAt,
  tradeExit,
  useLog,
  type Closes,
  type WindowTrade,
} from './price-chart.ts';
import type { Bars } from './types.ts';

export interface PriceInput {
  /** Prices keyed by ticker name; only `tickers` are shown. */
  data: Map<string, Bars>;
  tickers: string[];
  trades: Trade[];
  /** The run's first and last time; the charts show this window. */
  from: number;
  to: number;
  intraday: boolean;
}

/** Up to this many tickers get a button each; more get a drop-down. */
const MAX_BUTTONS = 12;
const TOO_MANY = 'There are too many trades to mark at this width. The shaded bands show when the strategy held the ticker.';

interface View {
  name: string;
  series: Closes;
  held: WindowTrade[];
}

interface Drawn {
  buys: number;
  sells: number;
  shorts: number;
  covers: number;
  dropped: boolean;
}

type Mark = 'buy' | 'sell' | 'short' | 'cover';
/**
 * Each marker points the way its order trades: a buy or a cover below the price with its tip up, a sell or a short sale
 * above it with its tip down. A long's buy is filled and its sell hollow; a short's sale is filled and its cover hollow,
 * in the short colour, so the four differ in shape as well as colour.
 */
const POINTS: Record<Mark, 'buy' | 'sell'> = { buy: 'buy', sell: 'sell', short: 'sell', cover: 'buy' };

/** Appends a collapsed "Prices and trades" section to `parent`. Built the first time it is opened. Returns a cleanup function. */
export function renderPriceCharts(parent: HTMLElement, input: PriceInput): () => void {
  const details = h(parent, 'details', 'bt-details');
  h(details, 'summary', undefined, 'Prices and trades');
  let observer: ResizeObserver | undefined;
  details.addEventListener('toggle', () => (observer = build(h(details, 'div', 'bt-price-body'), input)), { once: true });
  return () => observer?.disconnect();
}

function build(body: HTMLElement, input: PriceInput): ResizeObserver {
  const names = input.tickers;
  const view = (name: string): View => ({
    name,
    series: clipBars(input.data.get(name)!, input.from, input.to),
    held: clipTrades(input.trades, name, input.from, input.to),
  });
  let current = view(names[0]);
  let width = 0;

  const picker = names.length > 1 ? h(body, 'div', 'bt-price-picker') : null;
  const summary = h(body, 'div', 'bt-price-summary');
  const legend = h(body, 'div', 'bt-legend bt-price-legend');
  const key = (label: string, mark: (el: HTMLElement) => void) => {
    const k = h(legend, 'span', 'bt-key');
    mark(k);
    h(k, 'span', undefined, label);
    return k;
  };
  const glyph = (el: HTMLElement, kind: Mark) => {
    const svg = s(el, 'svg', { width: 12, height: 11, class: 'bt-price-glyph' });
    s(svg, 'path', { d: POINTS[kind] === 'buy' ? markerPath('buy', 6, -1) : markerPath('sell', 6, 11), class: `bt-price-${kind}` });
  };
  key('Price', (k) => h(k, 'span', 'bt-price-sw bt-price-sw-line'));
  const heldKey = key('Held', (k) => h(k, 'span', 'bt-price-sw bt-price-sw-band'));
  const shortHeldKey = key('Held short', (k) => h(k, 'span', 'bt-price-sw bt-price-sw-band-short'));
  const buyKey = key('Buy', (k) => glyph(k, 'buy'));
  const sellKey = key('Sell', (k) => glyph(k, 'sell'));
  const shortKey = key('Sell short', (k) => glyph(k, 'short'));
  const coverKey = key('Buy to cover', (k) => glyph(k, 'cover'));
  const chart = h(body, 'div', 'bt-chart bt-price-chart');
  const tip = h(chart, 'div', 'bt-tip bt-price-tip');
  tip.hidden = true;
  const note = h(body, 'div', 'bt-note bt-price-note', TOO_MANY);

  const redraw = () => {
    if (width <= 0) return;
    const drawn = drawPrice(chart, tip, width, current, input);
    const shorts = current.held.filter((w) => w.trade.side === 'short').length;
    heldKey.hidden = current.held.length === shorts;
    shortHeldKey.hidden = shorts === 0;
    buyKey.hidden = drawn.buys === 0;
    sellKey.hidden = drawn.sells === 0;
    shortKey.hidden = drawn.shorts === 0;
    coverKey.hidden = drawn.covers === 0;
    note.hidden = !drawn.dropped;
  };
  const pick = (i: number) => {
    current = view(names[i]);
    summary.textContent = summaryLine(current.held.length, heldShare(current.held, input.from, input.to), buyAndHold(current.series.c));
    redraw();
  };

  if (picker && names.length > MAX_BUTTONS) {
    const select = h(picker, 'select', 'dropdown bt-price-select');
    select.setAttribute('aria-label', 'Ticker');
    for (const name of names) h(select, 'option', undefined, name).value = name;
    select.addEventListener('change', () => pick(select.selectedIndex));
  } else if (picker) {
    const group = h(picker, 'div', 'bt-price-buttons');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Ticker');
    const buttons = names.map((name, i) => {
      const b = h(group, 'button', 'bt-price-pick', name);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(i === 0));
      b.addEventListener('click', () => {
        buttons.forEach((other, j) => other.setAttribute('aria-pressed', String(j === i)));
        pick(i);
      });
      return b;
    });
  }
  summary.textContent = summaryLine(current.held.length, heldShare(current.held, input.from, input.to), buyAndHold(current.series.c));

  const observer = new ResizeObserver((entries) => {
    // Drawing changes the container's height, which notifies again at the same width.
    const w = Math.floor(entries[0].contentRect.width);
    if (w > 0 && w !== width) {
      // Drawing changes the container's height, which would notify this observer again within the same frame.
      window.requestAnimationFrame(() => {
        width = w;
        redraw();
      });
    }
  });
  observer.observe(chart);
  return observer;
}

function drawPrice(chart: HTMLElement, tip: HTMLElement, width: number, view: View, input: PriceInput): Drawn {
  chart.querySelector('svg')?.remove();
  tip.hidden = true;
  const { from, to, intraday } = input;
  const { t, c } = view.series;
  const { held } = view;
  const span = Math.max(to - from, 1);
  const top = 8;
  const plotH = Math.round(Math.min(300, Math.max(190, width * 0.42)));
  const height = top + plotH + 24;
  const right = 12;

  const { lo, hi } = priceRange(c, held);
  const log = useLog(lo, hi);
  const ticks = priceTicks(lo, hi, log, Math.max(2, Math.round(plotH / 50)));
  // Whole-number ticks need no ".00".
  const labels = ticks.map((v) => (ticks.every(Number.isInteger) ? price(v).replace(/\.00$/, '') : price(v)));
  // Wide enough for the longest label at 11px, with a gap before the plot.
  const left = Math.max(40, Math.ceil(Math.max(...labels.map((l) => l.length)) * 6.3) + 12);
  const plotW = width - left - right;
  const x = (time: number) => left + ((time - from) / span) * plotW;
  // Room above and below the data so a marker at the highest or lowest price stays inside the plot.
  const inset = MARKER_REACH + 1;
  const y = priceScale(lo, hi, log, top + inset, top + plotH - inset);
  const f = (v: number) => v.toFixed(1);

  const shorted = held.some((w) => w.trade.side === 'short');
  const label = shorted ? 'held it long or short, and its trades' : 'held it and its buys and sells';
  const svg = s(chart, 'svg', { width, height, class: 'bt-svg', role: 'img', 'aria-label': `${view.name} price, with the periods the strategy ${label}` });

  for (const short of [false, true]) {
    for (const p of heldIntervals(held.filter((w) => (w.trade.side === 'short') === short))) {
      s(svg, 'rect', { x: f(x(p.from)), y: top, width: f(Math.max(1, x(p.to) - x(p.from))), height: plotH, class: short ? 'bt-price-band bt-price-band-short' : 'bt-price-band' });
    }
  }
  ticks.forEach((v, i) => {
    s(svg, 'line', { x1: left, x2: width - right, y1: f(y(v)), y2: f(y(v)), class: 'bt-grid' });
    s(svg, 'text', { x: left - 6, y: y(v) + 3.5, class: 'bt-axis', 'text-anchor': 'end' }, labels[i]);
  });
  s(svg, 'line', { x1: left, x2: width - right, y1: top + plotH, y2: top + plotH, class: 'bt-baseline' });
  for (const tick of timeTicks(from, to, plotW)) {
    s(svg, 'text', { x: x(tick.t), y: height - 6, class: 'bt-axis', 'text-anchor': 'middle' }, tick.label);
    s(svg, 'line', { x1: x(tick.t), x2: x(tick.t), y1: top + plotH, y2: top + plotH + 4, class: 'bt-baseline' });
  }

  const points = decimate(c, plotW);
  s(svg, 'path', { d: points.map((i, k) => `${k ? 'L' : 'M'}${f(x(t[i]))},${f(y(c[i]))}`).join(''), class: 'bt-price-line' });

  const count = markerCount(held);
  const drawn: Drawn = { buys: 0, sells: 0, shorts: 0, covers: 0, dropped: count > 0 && !showMarkers(count, plotW) };
  if (count > 0 && !drawn.dropped) {
    const marks: Record<Mark, string[]> = { buy: [], sell: [], short: [], cover: [] };
    for (const w of held) {
      const short = w.trade.side === 'short';
      const [entry, exit]: Mark[] = short ? ['short', 'cover'] : ['buy', 'sell'];
      for (const p of buyPoints(w)) marks[entry].push(markerPath(POINTS[entry], x(p.t), y(p.price)));
      if (w.sell) marks[exit].push(markerPath(POINTS[exit], x(w.trade.exitT), y(w.trade.exitPrice)));
    }
    drawn.buys = marks.buy.length;
    drawn.sells = marks.sell.length;
    drawn.shorts = marks.short.length;
    drawn.covers = marks.cover.length;
    // A ring in the surface colour under each marker keeps it apart from the line.
    const kinds: Mark[] = ['buy', 'sell', 'short', 'cover'];
    for (const kind of kinds) if (marks[kind].length) s(svg, 'path', { d: marks[kind].join(''), class: `bt-price-ring bt-price-ring-${kind}` });
    for (const kind of kinds) if (marks[kind].length) s(svg, 'path', { d: marks[kind].join(''), class: `bt-price-${kind}` });
  }

  // Hover: a crosshair on the nearest bar.
  const cross = s(svg, 'line', { y1: top, y2: top + plotH, class: 'bt-cross', visibility: 'hidden' });
  const dot = s(svg, 'circle', { r: 4, class: 'bt-dot bt-price-dot', visibility: 'hidden' });
  const hit = s(svg, 'rect', { x: left, y: top, width: Math.max(plotW, 0), height: plotH, fill: 'transparent' });
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
  };
  const show = (clientX: number) => {
    const time = from + ((clientX - svg.getBoundingClientRect().left - left) / plotW) * span;
    const i = nearestIndex(t, time);
    const px = x(t[i]);
    cross.setAttribute('x1', String(px));
    cross.setAttribute('x2', String(px));
    dot.setAttribute('cx', String(px));
    dot.setAttribute('cy', String(y(c[i])));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');

    tip.replaceChildren();
    h(tip, 'div', 'bt-tip-date', stamp(t[i], intraday));
    const row = (label: string, value: string) => {
      const r = h(tip, 'div', 'bt-price-tip-row');
      h(r, 'span', 'bt-price-tip-label', label);
      h(r, 'span', 'bt-price-tip-value', value);
    };
    row('Close', price(c[i]));
    const trade = tradeAt(held, t[i]);
    if (trade) {
      const open = trade.reason === 'open';
      const short = trade.side === 'short';
      h(tip, 'div', 'bt-price-tip-sep');
      row(short ? 'Sold short' : 'Bought', boughtWording(trade, (time) => stamp(time, intraday), price));
      row(short ? 'Bought to cover' : 'Sold', open ? 'not closed' : `${stamp(trade.exitT, intraday)} at ${price(trade.exitPrice)}`);
      row(open ? 'Return to date' : 'Return', signedPct(trade.ret));
      if (!open) row('Reason', tradeExit(trade, input.trades));
    }
    tip.hidden = false;
    // To the right of the crosshair, or to the left when it would run off the chart. Measured from the left edge, where it has the most room.
    tip.style.removeProperty('left');
    tip.classList.add('bt-tip-measure');
    const w = tip.offsetWidth;
    tip.classList.remove('bt-tip-measure');
    tip.style.left = `${px + 12 + w <= width ? px + 12 : Math.max(0, px - 12 - w)}px`;
    tip.style.top = `${top + 4}px`;
  };
  hit.addEventListener('pointermove', (e) => show((e as PointerEvent).clientX));
  hit.addEventListener('pointerdown', (e) => show((e as PointerEvent).clientX));
  hit.addEventListener('pointerleave', hide);
  return drawn;
}
