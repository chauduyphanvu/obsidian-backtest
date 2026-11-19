// The comparison of several strategies: legend, equity chart, figures table and how alike they move.

import { alignCurves, cashReturns, combine, correlations, lineStats, weightedCashReturn, type Aligned, type Curve } from './compare.ts';
import { h, s } from './dom.ts';
import { weightDecimals } from './allocate.ts';
import { renderSplit } from './render-split.ts';
import type { Diagnostic } from './dsl.ts';
import { isIntraday, minus, money, moneyTicks, pct, stamp, timeTicks } from './format.ts';

export interface CompareInput {
  /** One per entry, already loaded and run. */
  curves: Curve[];
  /** Fractions, one per curve; null when the block gives no weights. */
  weights: number[] | null;
  /** The value every line starts from, such as 10000. */
  capital: number;
  /** Writes whole percentages, one per entry, into the block's weights; null when the block's place in its note is not known. */
  use?: ((percents: number[]) => Promise<void>) | null;
}

/** A line in the chart. Identity is carried by the swatch colour and by `mark`, which is also printed at the line's end. */
export interface Line {
  mark: string;
  label: string;
  /** Sets the series colour as `--c`. */
  cls: string;
  /** Rebased to 1 at the first date. */
  values: number[];
  /** What cash earned over each step, for the Sharpe ratio. */
  cashReturn: number[];
  combined: boolean;
}

const LABEL_GAP = 14;
const TINT_MIN = 8;
const TINT_MAX = 55;

const share = (w: number) => `${Number((w * 100).toFixed(1))}%`;

export function renderCompareMessage(parent: HTMLElement, text: string): void {
  h(h(parent, 'div', 'bt-root'), 'div', 'bt-note', text);
}

/** The block's problems, each with its line; `title` names what cannot run, as "This comparison cannot run". */
export function renderCompareErrors(parent: HTMLElement, errors: Diagnostic[], source: string, title = 'This comparison cannot run'): void {
  const root = h(parent, 'div', 'bt-root');
  h(root, 'div', 'bt-error-title', errors.length === 1 ? title : `${title}: ${errors.length} problems`);
  const lines = source.split('\n');
  const list = h(root, 'ul', 'bt-errors');
  for (const e of errors) {
    const li = h(list, 'li');
    h(li, 'span', 'bt-error-line', `Line ${e.line}`);
    h(li, 'span', undefined, e.message);
    const text = lines[e.line - 1]?.trim();
    if (text) h(li, 'code', 'bt-error-src', text);
  }
}

/** Renders the comparison into `parent` (which the caller has emptied). Returns a cleanup function. */
export function renderCompare(parent: HTMLElement, input: CompareInput): () => void {
  let aligned: Aligned;
  try {
    aligned = alignCurves(input.curves);
  } catch (e) {
    renderCompareMessage(parent, (e as Error).message);
    return () => {};
  }
  const { t } = aligned;
  const intraday = isIntraday(t);
  const { lines, combined } = compareLines(input, aligned);
  // Combined first wherever lines are listed, and drawn last so it sits on top of the chart.
  const listed = combined ? [combined, ...lines] : lines;

  const root = h(parent, 'div', 'bt-root');
  h(root, 'div', 'bt-title', 'Comparison');
  h(root, 'div', 'bt-sub', `${stamp(t[0], intraday)} to ${stamp(t[t.length - 1], intraday)}, the dates that all strategies cover. Each line starts at ${money(input.capital)}.`);

  const legend = h(root, 'div', 'bt-legend bt-cmp-legend');
  for (const l of listed) {
    const key = h(legend, 'span', 'bt-key bt-cmp-key');
    key.title = l.label;
    mark(key, l);
    h(key, 'span', 'bt-cmp-name', l.label);
    h(key, 'span', 'bt-key-value', money(l.values[l.values.length - 1] * input.capital));
  }

  const chart = h(root, 'div', 'bt-chart');
  const tip = h(chart, 'div', 'bt-tip bt-cmp-tip');
  tip.hidden = true;
  let drawn = 0;
  const observer = new ResizeObserver((entries) => {
    // Drawing changes the container's height, which notifies again at the same width.
    const width = Math.floor(entries[0].contentRect.width);
    if (width > 0 && width !== drawn) window.requestAnimationFrame(() => drawChart(chart, tip, (drawn = width), t, [...lines, ...(combined ? [combined] : [])], input.capital, intraday));
  });
  observer.observe(chart);

  if (combined && input.weights) h(root, 'div', 'bt-note', combinedNote(lines, input.weights));

  figures(root, listed, t);
  alike(root, lines, aligned);
  if (input.weights) renderSplit(root, { aligned, labels: lines.map((l) => `${l.mark} ${l.label}`), weights: input.weights, decimals: weightDecimals(input.weights), use: input.use ?? null });
  return () => observer.disconnect();
}

/** One line for each strategy, drawn whatever its weight, and Combined when the block gives weights, which holds each at its weight: one at 0% not at all. */
export function compareLines(input: Pick<CompareInput, 'curves' | 'weights'>, aligned: Aligned): { lines: Line[]; combined: Line | null } {
  const cash = cashReturns(aligned);
  const lines: Line[] = aligned.series.map((values, i) => ({ mark: String(i + 1), label: input.curves[i].label, cls: `bt-cmp-c${i + 1}`, values, cashReturn: cash[i], combined: false }));
  const combined: Line | null = input.weights
    ? { mark: 'C', label: 'Combined', cls: 'bt-cmp-all', values: combine(aligned, input.weights), cashReturn: weightedCashReturn(cash, input.weights), combined: true }
    : null;
  return { lines, combined };
}

/** What Combined holds, said under the chart: the weights, the strategies listed at 0%, and the cash. */
export function combinedNote(lines: Pick<Line, 'mark'>[], weights: number[]): string {
  const held = lines.flatMap((l, i) => (weights[i] > 0 ? [{ mark: l.mark, w: weights[i] }] : []));
  const out = held.every((x) => x.w === held[0].w) && held.length === lines.length ? `each strategy at ${share(held[0].w)}` : held.map((x) => `${x.mark} at ${share(x.w)}`).join(', ');
  const zero = lines.filter((_, i) => weights[i] === 0).map((l) => l.mark);
  const listed = zero.length ? ` ${zero.join(', ')} ${zero.length === 1 ? 'is' : 'are'} at 0%: the chart shows ${zero.length === 1 ? 'it' : 'them'}, but Combined does not include ${zero.length === 1 ? 'it' : 'them'}.` : '';
  const cash = 1 - weights.reduce((a, w) => a + w, 0);
  return `Combined: ${out}. It rebalances to these weights on the first date of each month.${listed}${cash > 1e-9 ? ` The remaining ${share(cash)} is cash with no interest.` : ''}`;
}

/** The colour swatch and the number that stand for a line wherever its name is listed. */
function mark(parent: HTMLElement, l: Line): void {
  h(parent, 'span', `bt-swatch bt-cmp-swatch ${l.cls}`);
  h(parent, 'span', 'bt-cmp-mark', l.mark);
}

/** Two decimals, with no "-0.00" for a value too small to show. */
const ratio = (x: number) => minus((Math.round(x * 100) / 100 || 0).toFixed(2));

export { lineStats };

function figures(root: HTMLElement, listed: Line[], t: number[]): void {
  const wrap = h(root, 'div', 'bt-scroll bt-cmp-scroll');
  const table = h(wrap, 'table', 'bt-table bt-cmp-table');
  const head = h(h(table, 'thead'), 'tr');
  h(head, 'th');
  for (const name of ['Return per year', 'Total return', 'Worst drawdown', 'Sharpe ratio']) h(head, 'th', 'bt-num', name);
  const body = h(table, 'tbody');
  for (const l of listed) {
    const st = lineStats(t, l.values, l.cashReturn);
    const row = h(body, 'tr', l.combined ? 'bt-cmp-combined' : undefined);
    const who = h(h(row, 'td', 'bt-cmp-name-cell'), 'span', 'bt-cmp-who');
    mark(who, l);
    h(who, 'span', 'bt-cmp-name', l.label).title = l.label;
    const values = [pct(st.cagr), pct(st.totalReturn, Math.abs(st.totalReturn) >= 10 ? 0 : 1), pct(st.maxDrawdown), ratio(st.sharpe)];
    for (const v of values) h(row, 'td', 'bt-num', v);
  }
}

function alike(root: HTMLElement, lines: Line[], aligned: Aligned): void {
  if (lines.length < 2) return;
  const corr = correlations(aligned);
  if (lines.length === 2) {
    const c = corr[0][1];
    const text = Number.isFinite(c)
      ? `The returns of the two strategies have a correlation of ${ratio(c)}. A value of 1 shows that they move together, 0 that they are not related, and below 0 that they move in opposite directions. Thus they ${
          c >= 0.7 ? 'moved together most of the time' : c >= 0.3 ? 'moved together some of the time' : c > -0.3 ? 'moved almost independently' : 'usually moved in opposite directions'
        }.`
      : 'The plugin cannot calculate a correlation here, because the value of one of the strategies did not change.';
    h(root, 'div', 'bt-cmp-sentence', text);
    return;
  }

  h(root, 'div', 'bt-cmp-heading', 'Correlation (1 = they move together, 0 = not related)');
  const wrap = h(root, 'div', 'bt-scroll bt-cmp-scroll');
  const table = h(wrap, 'table', 'bt-table bt-cmp-corr');
  const head = h(h(table, 'thead'), 'tr');
  h(head, 'th');
  for (const l of lines) {
    const th = h(head, 'th', 'bt-num');
    mark(h(th, 'span', 'bt-cmp-who'), l);
  }
  const body = h(table, 'tbody');
  lines.forEach((a, i) => {
    const row = h(body, 'tr');
    const name = h(row, 'th', 'bt-cmp-name-cell');
    name.setAttribute('scope', 'row');
    const who = h(name, 'span', 'bt-cmp-who');
    mark(who, a);
    h(who, 'span', 'bt-cmp-name', a.label).title = a.label;
    lines.forEach((_, j) => {
      const td = h(row, 'td', 'bt-num');
      const c = corr[i][j];
      if (i === j) td.className += ' bt-cmp-self';
      else if (!Number.isFinite(c)) td.textContent = '–';
      else {
        td.textContent = ratio(c);
        td.className += c < 0 ? ' bt-cmp-neg' : ' bt-cmp-pos';
        td.style.setProperty('--bt-cmp-tint', `${Math.round(TINT_MIN + (TINT_MAX - TINT_MIN) * Math.min(1, Math.abs(c)))}%`);
      }
    });
  });
  h(root, 'div', 'bt-note', 'A blue cell shows two strategies that moved together. A red cell shows two strategies that moved in opposite directions. A darker cell shows a stronger link.');
}

/** Where each line's end label goes: as close to the line's end as possible, at least LABEL_GAP apart, inside [min, max]. */
export function spreadLabels(targets: number[], min: number, max: number, gap = LABEL_GAP): number[] {
  const order = targets.map((_, i) => i).sort((a, b) => targets[a] - targets[b]);
  const pos = order.map((i) => Math.min(max, Math.max(min, targets[i])));
  for (let k = 1; k < pos.length; k++) pos[k] = Math.max(pos[k], pos[k - 1] + gap);
  if (pos.length > 0 && pos[pos.length - 1] > max) {
    pos[pos.length - 1] = max;
    for (let k = pos.length - 2; k >= 0; k--) pos[k] = Math.min(pos[k], pos[k + 1] - gap);
  }
  const out = new Array<number>(targets.length);
  order.forEach((i, k) => (out[i] = pos[k]));
  return out;
}

function drawChart(chart: HTMLElement, tip: HTMLElement, width: number, t: number[], lines: Line[], capital: number, intraday: boolean): void {
  chart.querySelector('svg')?.remove();
  tip.hidden = true;
  const n = t.length;
  const left = 52;
  const right = 36;
  const top = 8;
  const plotH = Math.round(Math.min(300, Math.max(190, width * 0.42)));
  const height = top + plotH + 24;
  const plotW = width - left - right;
  const hasCombined = lines.some((l) => l.combined);

  const svg = s(chart, 'svg', { width, height, class: 'bt-svg', role: 'img', 'aria-label': 'Value of each strategy during the period' });
  const x = (time: number) => left + ((time - t[0]) / (t[n - 1] - t[0])) * plotW;
  const value = (l: Line, i: number) => l.values[i] * capital;

  let lo = Infinity;
  let hi = -Infinity;
  for (const l of lines) {
    for (let i = 0; i < n; i++) {
      lo = Math.min(lo, value(l, i));
      hi = Math.max(hi, value(l, i));
    }
  }
  lo = Math.max(lo, 1e-9);
  const pad = Math.max(Math.log(hi / lo) * 0.05, 0.02);
  const [l0, l1] = [Math.log(lo) - pad, Math.log(hi) + pad];
  const y = (v: number) => top + (1 - (Math.log(Math.max(v, 1e-9)) - l0) / (l1 - l0)) * plotH;

  for (const v of moneyTicks(Math.exp(l0), Math.exp(l1))) {
    s(svg, 'line', { x1: left, x2: width - right, y1: y(v), y2: y(v), class: 'bt-grid' });
    s(svg, 'text', { x: left - 6, y: y(v) + 3.5, class: 'bt-axis', 'text-anchor': 'end' }, money(v));
  }
  s(svg, 'line', { x1: left, x2: width - right, y1: top + plotH, y2: top + plotH, class: 'bt-baseline' });
  for (const tick of timeTicks(t[0], t[n - 1], plotW)) {
    s(svg, 'text', { x: x(tick.t), y: height - 6, class: 'bt-axis', 'text-anchor': 'middle' }, tick.label);
    s(svg, 'line', { x1: x(tick.t), x2: x(tick.t), y1: top + plotH, y2: top + plotH + 4, class: 'bt-baseline' });
  }

  // About two points per pixel is all a line can show.
  const stride = Math.max(1, Math.floor(n / (plotW * 2)));
  const path = (l: Line) => {
    let d = '';
    for (let i = 0; i < n; i += stride) d += `${d ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y(value(l, i)).toFixed(1)}`;
    if ((n - 1) % stride !== 0) d += `L${x(t[n - 1]).toFixed(1)},${y(value(l, n - 1)).toFixed(1)}`;
    return d;
  };
  for (const l of lines) {
    const weight = l.combined ? 'bt-cmp-line-main' : hasCombined ? 'bt-cmp-line-thin' : '';
    s(svg, 'path', { d: path(l), class: `bt-cmp-line ${weight} ${l.cls}` });
  }

  // The number at each line's end names it without colour. Labels that would touch are nudged apart.
  const ends = spreadLabels(lines.map((l) => y(value(l, n - 1))), top + 6, top + plotH - 6);
  lines.forEach((l, k) => {
    const yEnd = y(value(l, n - 1));
    const cx = width - right + 8;
    s(svg, 'line', { x1: width - right, y1: yEnd, x2: cx, y2: ends[k], class: `bt-cmp-leader ${l.cls}` });
    s(svg, 'circle', { cx, cy: ends[k], r: 3.5, class: `bt-cmp-end ${l.cls}` });
    s(svg, 'text', { x: cx + 7, y: ends[k] + 3.5, class: 'bt-cmp-end-mark' }, l.mark);
  });

  // Hover: one crosshair, a dot on every line and a tooltip that lists them by value.
  const cross = s(svg, 'line', { y1: top, y2: top + plotH, class: 'bt-cross', visibility: 'hidden' });
  const dots = lines.map((l) => s(svg, 'circle', { r: 3.5, class: `bt-cmp-dot ${l.cls}`, visibility: 'hidden' }));
  const hit = s(svg, 'rect', { x: left, y: top, width: plotW, height: plotH, fill: 'transparent' });
  const hide = () => {
    tip.hidden = true;
    for (const el of [cross, ...dots]) el.setAttribute('visibility', 'hidden');
  };
  const show = (clientX: number) => {
    const time = t[0] + ((clientX - svg.getBoundingClientRect().left - left) / plotW) * (t[n - 1] - t[0]);
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
    lines.forEach((l, k) => {
      dots[k].setAttribute('cx', String(px));
      dots[k].setAttribute('cy', String(y(value(l, i))));
      dots[k].setAttribute('visibility', 'visible');
    });
    cross.setAttribute('visibility', 'visible');

    tip.replaceChildren();
    h(tip, 'div', 'bt-tip-date', stamp(t[i], intraday));
    for (const l of [...lines].sort((p, q) => q.values[i] - p.values[i])) {
      const row = h(tip, 'div', 'bt-cmp-tip-row');
      mark(row, l);
      h(row, 'span', 'bt-cmp-name', l.label);
      h(row, 'span', 'bt-tip-value', money(value(l, i)));
    }
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
