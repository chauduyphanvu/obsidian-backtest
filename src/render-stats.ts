// The "More statistics" section: a comparison table, yearly returns chart and monthly returns table.

import { MONTHS, h, minus, niceStep, pct, s, signedPct } from './dom.ts';
import { deepStats, periodReturns, type DeepStats, type PeriodReturn, type Underwater } from './stats.ts';

export interface DeepStatsInput {
  t: number[];
  strategy: number[];
  benchmark: number[];
  benchmarkLabel: string;
}

/** Appends a collapsed "More statistics" section to `parent`. Returns a cleanup function (disconnects observers). Content is built the first time the section is opened. */
export function renderDeepStats(parent: HTMLElement, input: DeepStatsInput): () => void {
  const details = h(parent, 'details', 'bt-details');
  h(details, 'summary', undefined, 'More statistics');
  let observer: ResizeObserver | undefined;
  details.addEventListener('toggle', () => (observer = build(h(details, 'div', 'bt-stats-body'), input)), { once: true });
  return () => observer?.disconnect();
}

function build(body: HTMLElement, input: DeepStatsInput): ResizeObserver {
  comparison(body, input);
  const years = periodReturns(input.t, input.strategy, 'year');
  // Same dates as the strategy, so the benchmark's years line up one for one.
  const benchYears = periodReturns(input.t, input.benchmark, 'year');
  const observer = yearsChart(body, input.benchmarkLabel, years, benchYears);
  monthsTable(body, periodReturns(input.t, input.strategy, 'month'), years);
  return observer;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "45 days" up to two months, then "1 year 3 months". */
function duration(days: number): string {
  if (days < 1) return 'less than a day';
  if (days < 60) return plural(Math.round(days), 'day');
  const months = Math.round(days / 30.4375);
  const years = Math.floor(months / 12);
  return [years > 0 ? plural(years, 'year') : '', months % 12 > 0 ? plural(months % 12, 'month') : ''].filter(Boolean).join(' ');
}

function periodName(p: PeriodReturn): string {
  if (p.key.length === 4) return p.key;
  const d = new Date(p.t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A value with a quieter note after it, such as "+31.2% (2019)". */
function cell(row: HTMLElement, value: string, note: string | null): void {
  const td = h(row, 'td', 'bt-num', value);
  if (note) {
    td.append(' ');
    h(td, 'span', 'bt-stats-note', `(${note})`);
  }
}

function comparison(body: HTMLElement, input: DeepStatsInput): void {
  const mine = deepStats(input.t, input.strategy);
  const bench = deepStats(input.t, input.benchmark);
  const table = h(body, 'table', 'bt-table');
  const head = h(h(table, 'thead'), 'tr');
  h(head, 'th');
  for (const [cls, label] of [['bt-swatch-strategy', 'Strategy'], ['bt-swatch-benchmark', input.benchmarkLabel]] as const) {
    const mark = h(h(head, 'th', 'bt-num'), 'span', 'bt-stats-th');
    h(mark, 'span', `bt-swatch bt-stats-swatch ${cls}`);
    h(mark, 'span', undefined, label);
  }

  const ratio = (x: number) => minus((Math.round(x * 100) / 100 || 0).toFixed(2));
  const best = (p: PeriodReturn | null): [string, string | null] => (p ? [signedPct(p.ret), periodName(p)] : ['–', null]);
  const below = (u: Underwater): [string, string | null] => (u.longestDays === 0 ? ['None', null] : [duration(u.longestDays), u.longestTo === null ? 'still below' : null]);
  const rows: [string, (d: DeepStats) => [string, string | null]][] = [
    ['Sortino ratio', (d) => [ratio(d.sortino), null]],
    ['Return per year ÷ worst drawdown', (d) => [ratio(d.calmar), null]],
    ['Best year', (d) => best(d.bestYear)],
    ['Worst year', (d) => best(d.worstYear)],
    ['Months with a gain', (d) => [pct(d.positiveMonths, 0), null]],
    ['Longest time below a previous high', (d) => below(d.underwater)],
    ['Best month', (d) => best(d.bestMonth)],
    ['Worst month', (d) => best(d.worstMonth)],
  ];
  const tbody = h(table, 'tbody');
  for (const [label, get] of rows) {
    const row = h(tbody, 'tr');
    h(row, 'td', undefined, label);
    cell(row, ...get(mine));
    cell(row, ...get(bench));
  }
}

const LABEL_GAP = 34;

function yearsChart(body: HTMLElement, benchmarkLabel: string, mine: PeriodReturn[], bench: PeriodReturn[]): ResizeObserver {
  h(body, 'div', 'bt-stats-heading', 'Return by year');
  const legend = h(body, 'div', 'bt-legend');
  for (const [cls, label] of [['bt-swatch-strategy', 'Strategy'], ['bt-swatch-benchmark', benchmarkLabel]] as const) {
    const key = h(legend, 'span', 'bt-key');
    h(key, 'span', `bt-swatch bt-stats-swatch ${cls}`);
    h(key, 'span', undefined, label);
  }
  const chart = h(body, 'div', 'bt-chart');
  const tip = h(chart, 'div', 'bt-tip bt-stats-tip');
  tip.hidden = true;
  let drawn = 0;
  const observer = new ResizeObserver((entries) => {
    // Drawing changes the container's height, which notifies again at the same width.
    const width = Math.floor(entries[0].contentRect.width);
    if (width > 0 && width !== drawn) drawYears(chart, tip, (drawn = width), benchmarkLabel, mine, bench);
  });
  observer.observe(chart);
  if (mine.some((p) => p.partial)) h(body, 'div', 'bt-note', 'Faded bars are years the data only partly covers.');
  return observer;
}

/** A bar from the zero line at `y0` to `yv`, rounded at the data end only. */
function bar(svg: SVGElement, x: number, w: number, y0: number, yv: number, cls: string): void {
  if (yv === y0) return;
  const up = yv < y0;
  const len = Math.max(Math.abs(yv - y0), 1);
  const end = up ? y0 - len : y0 + len;
  const r = Math.min(3, w / 2, len);
  const k = up ? 1 : -1;
  const f = (v: number) => v.toFixed(2);
  const sweep = up ? 1 : 0;
  const d =
    `M${f(x)},${f(y0)}V${f(end + k * r)}A${r},${r} 0 0 ${sweep} ${f(x + r)},${f(end)}` + `H${f(x + w - r)}A${r},${r} 0 0 ${sweep} ${f(x + w)},${f(end + k * r)}V${f(y0)}Z`;
  s(svg, 'path', { d, class: cls });
}

function drawYears(chart: HTMLElement, tip: HTMLElement, width: number, benchmarkLabel: string, mine: PeriodReturn[], bench: PeriodReturn[]): void {
  chart.querySelector('svg')?.remove();
  tip.hidden = true;
  const n = mine.length;
  const left = 44;
  const right = 8;
  const top = 8;
  const plotH = Math.round(Math.min(200, Math.max(140, width * 0.32)));
  const height = top + plotH + 24;
  const plotW = width - left - right;
  const groupW = plotW / n;

  const returns = [...mine, ...bench].map((p) => p.ret);
  const lo = Math.min(0, ...returns);
  const hi = Math.max(0, ...returns);
  const step = niceStep(Math.max(hi - lo, 0.01), 4);
  const yMin = Math.floor(lo / step + 1e-9) * step;
  const yMax = Math.max(Math.ceil(hi / step - 1e-9) * step, yMin + step);
  const y = (v: number) => top + ((yMax - v) / (yMax - yMin)) * plotH;

  const svg = s(chart, 'svg', { width, height, class: 'bt-svg', role: 'img', 'aria-label': 'Return of the strategy and the benchmark in each calendar year' });
  for (let k = Math.round(yMin / step); k * step <= yMax + step / 1e6; k++) {
    const v = k * step;
    if (v !== 0) s(svg, 'line', { x1: left, x2: width - right, y1: y(v), y2: y(v), class: 'bt-grid' });
    s(svg, 'text', { x: left - 6, y: y(v) + 3.5, class: 'bt-axis', 'text-anchor': 'end' }, pct(v, step >= 0.01 ? 0 : 1));
  }
  const hl = s(svg, 'rect', { y: top, width: groupW, height: plotH, class: 'bt-stats-hl', visibility: 'hidden' });

  const barW = Math.max(1, Math.min(14, Math.floor((groupW * 0.8 - 2) / 2)));
  const labelEvery = [1, 2, 5, 10, 20].find((k) => groupW * k >= LABEL_GAP) ?? 20;
  const y0 = y(0);
  mine.forEach((p, i) => {
    const x = left + i * groupW + (groupW - (2 * barW + 2)) / 2;
    const partial = p.partial ? ' bt-stats-partial' : '';
    bar(svg, x, barW, y0, y(p.ret), `bt-stats-bar-strategy${partial}`);
    bar(svg, x + barW + 2, barW, y0, y(bench[i].ret), `bt-stats-bar-benchmark${partial}`);
    if (Number(p.key) % labelEvery === 0) {
      s(svg, 'text', { x: left + (i + 0.5) * groupW, y: top + plotH + 16, class: 'bt-axis', 'text-anchor': 'middle' }, p.key);
    }
  });
  s(svg, 'line', { x1: left, x2: width - right, y1: y0, y2: y0, class: 'bt-baseline' });

  // The hit target is the whole column, labels included.
  const hit = s(svg, 'rect', { x: left, y: top, width: plotW, height: plotH + 24, fill: 'transparent' });
  const show = (clientX: number) => {
    const i = Math.min(n - 1, Math.max(0, Math.floor((clientX - svg.getBoundingClientRect().left - left) / groupW)));
    hl.setAttribute('x', String(left + i * groupW));
    hl.setAttribute('visibility', 'visible');
    tip.replaceChildren();
    h(tip, 'div', 'bt-tip-date', mine[i].key);
    for (const [cls, label, p] of [['bt-swatch-strategy', 'Strategy', mine[i]], ['bt-swatch-benchmark', benchmarkLabel, bench[i]]] as const) {
      const row = h(tip, 'div', 'bt-tip-row');
      h(row, 'span', `bt-swatch bt-stats-swatch ${cls}`);
      h(row, 'span', 'bt-tip-label', label);
      h(row, 'span', 'bt-tip-value', signedPct(p.ret));
    }
    if (mine[i].partial) h(tip, 'div', 'bt-tip-foot', 'The data covers part of this year');
    tip.hidden = false;
    const px = left + (i + 0.5) * groupW;
    const x = px + 12 + tip.offsetWidth > width ? px - 12 - tip.offsetWidth : px + 12;
    tip.style.left = `${Math.max(0, x)}px`;
    tip.style.top = `${top + 4}px`;
  };
  hit.addEventListener('pointermove', (e) => show((e as PointerEvent).clientX));
  hit.addEventListener('pointerdown', (e) => show((e as PointerEvent).clientX));
  hit.addEventListener('pointerleave', () => {
    tip.hidden = true;
    hl.setAttribute('visibility', 'hidden');
  });
}

/** Weakest and strongest tint, as a percentage of the gain or loss colour. */
const TINT_MIN = 10;
const TINT_MAX = 52;

function monthsTable(body: HTMLElement, months: PeriodReturn[], years: PeriodReturn[]): void {
  h(body, 'div', 'bt-stats-heading', 'Strategy return by month');
  const wrap = h(body, 'div', 'bt-scroll bt-stats-scroll');
  const table = h(wrap, 'table', 'bt-table bt-stats-months');
  const head = h(h(table, 'thead'), 'tr');
  h(head, 'th');
  for (const name of [...MONTHS, 'Year']) h(head, 'th', 'bt-num', name);

  const byKey = new Map(months.map((m) => [m.key, m]));
  const peak = Math.max(...months.map((m) => Math.abs(m.ret)));
  const tbody = h(table, 'tbody');
  for (const year of years) {
    const row = h(tbody, 'tr');
    h(row, 'th', undefined, year.key).setAttribute('scope', 'row');
    for (let m = 0; m < 12; m++) {
      const r = byKey.get(`${year.key}-${String(m + 1).padStart(2, '0')}`)?.ret;
      const td = h(row, 'td', 'bt-num');
      if (r === undefined) continue;
      td.textContent = pct(r).replace('%', '');
      if (r === 0) continue;
      td.className += r > 0 ? ' bt-stats-up' : ' bt-stats-down';
      td.style.setProperty('--bt-stats-tint', `${Math.round(TINT_MIN + (TINT_MAX - TINT_MIN) * (Math.abs(r) / peak))}%`);
    }
    h(row, 'td', `bt-num bt-stats-year${year.partial ? ' bt-stats-partial-year' : ''}`, pct(year.ret));
  }
  h(body, 'div', 'bt-note', 'Months coloured by size: blue for gains, red for losses.');
}
