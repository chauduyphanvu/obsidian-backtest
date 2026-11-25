// The Years and Months tabs of a result: the strategy's return each year less its benchmark's, and each month's return in
// a calendar grid.

import { h, onWidth, s } from './dom.ts';
import { MONTHS, pct, plural, signedPct } from './format.ts';
import { readByKeys, type KeyReading } from './render-chart.ts';
import { periodReturns, type PeriodReturn } from './stats.ts';
import { tabInfo } from './tabs.ts';
import { benchProse, LEVEL, periodName, yearsAhead } from './verdict.ts';

export interface PeriodInput {
  t: number[];
  strategy: number[];
  benchmark: number[];
  benchmarkLabel: string;
}

/** A value with a quieter note after it, such as "+31.2% (2019)". */
export function cell(row: HTMLElement, value: string, note: string | null): void {
  const td = h(row, 'td', 'bt-num', value);
  if (note) {
    td.append(' ');
    h(td, 'span', 'bt-stats-note', `(${note})`);
  }
}

/** Builds a section the first time it opens; returns a cleanup function for what the build left watching. */
function lazy(details: HTMLElement, build: (body: HTMLElement) => (() => void) | void): () => void {
  let stop: (() => void) | void;
  details.addEventListener('toggle', () => (stop = build(h(details, 'div', 'bt-tab-body'))), { once: true });
  return () => stop?.();
}

/** Draws into `box` at its width, and again when that changes. Returns a cleanup function. */
const pts = (d: number): string => `${Math.abs(d * 100).toFixed(1)} pts`;

/** The Years tab. Nothing is added for a run shorter than a calendar year's worth of data. */
export function renderYears(parent: HTMLElement, input: PeriodInput): () => void {
  const mine = periodReturns(input.t, input.strategy, 'year');
  if (mine.length === 0) return () => {};
  const ahead = yearsAhead(input.t, input.strategy, input.benchmark);
  const details = h(parent, 'details', 'bt-details bt-years');
  h(details, 'summary', undefined, 'Years');
  tabInfo(details, 'Years', ahead.years > 0 ? `better in ${ahead.ahead.length} of ${ahead.years}` : plural(mine.length, 'year'));
  return lazy(details, (body) => {
    const bench = benchProse(input.benchmarkLabel);
    const theirs = new Map(periodReturns(input.t, input.benchmark, 'year').map((p) => [p.key, p]));
    if (ahead.years > 0) {
      const behind = ahead.years - ahead.ahead.length - ahead.level;
      const all = `In ${plural(ahead.years, 'full year')}, the strategy did better than ${bench} in ${ahead.ahead.length}, the same in ${ahead.level} and worse in ${behind}.`;
      h(body, 'p', 'bt-tab-lead', ahead.onlyFalling && ahead.ahead.length < ahead.years ? `${all} In each year that the strategy did better, ${bench} decreased.` : all);
    }
    const read = h(body, 'div', 'bt-tab-read');
    read.setAttribute('aria-live', 'polite');
    const idle = `Each bar shows the strategy return minus the ${bench} return for one calendar year. Move the pointer to a year to compare.`;
    read.textContent = idle;
    const key = h(body, 'div', 'bt-chart-legend');
    for (const [cls, text] of [['bt-chart-swatch-gap-ahead', 'Strategy better'], ['bt-chart-swatch-gap-behind', `${input.benchmarkLabel} better`]]) {
      const k = h(key, 'span', 'bt-chart-key');
      h(k, 'span', `bt-chart-swatch ${cls}`);
      h(k, 'span', undefined, text);
    }
    const chart = h(body, 'div', 'bt-chart');
    let keys: KeyReading | null = null;
    readByKeys(chart, 'Chart of the years. Use the arrow keys to read each year.', () => keys);
    if (mine.some((p) => p.partial)) h(body, 'div', 'bt-note', 'A light bar shows a year that the data does not fully cover.');
    return onWidth(chart, (width) => (keys = drawGaps(chart, read, idle, width, mine, theirs, bench)));
  });
}

/** Columns closer than this have every second, fifth or tenth year named. */
const LABEL_GAP = 34;

function drawGaps(chart: HTMLElement, read: HTMLElement, idle: string, width: number, mine: PeriodReturn[], theirs: Map<string, PeriodReturn>, bench: string): KeyReading {
  chart.querySelector('svg')?.remove();
  const n = mine.length;
  const gaps = mine.map((p) => {
    const b = theirs.get(p.key);
    return b && Number.isFinite(b.ret) ? p.ret - b.ret : NaN;
  });
  const known = gaps.filter(Number.isFinite);
  const lo = Math.min(0, ...known);
  const hi = Math.max(0, ...known);
  const top = 18;
  const plotH = Math.round(Math.min(170, Math.max(110, width * 0.24)));
  const height = top + plotH + 22;
  const left = 6;
  const plotW = width - 2 * left;
  const groupW = plotW / n;
  const span = hi - lo || 0.01;
  const y = (v: number) => top + ((hi - v) / span) * plotH;
  const y0 = y(0);
  const svg = s(chart, 'svg', { width, height, class: 'bt-svg', role: 'img', 'aria-label': `The strategy return minus the ${bench} return in each calendar year` });
  const hl = s(svg, 'rect', { y: 0, width: groupW, height: top + plotH + 4, class: 'bt-stats-hl', visibility: 'hidden' });
  s(svg, 'line', { x1: left, x2: left + plotW, y1: y0, y2: y0, class: 'bt-baseline' });
  const barW = Math.max(1, Math.min(26, groupW * 0.7));
  const labelEvery = [1, 2, 5, 10, 20].find((k) => groupW * k >= LABEL_GAP) ?? 20;
  const best = known.length ? gaps.indexOf(Math.max(...known)) : -1;
  const worst = known.length ? gaps.indexOf(Math.min(...known)) : -1;
  mine.forEach((p, i) => {
    const cx = left + (i + 0.5) * groupW;
    const g = gaps[i];
    const faded = p.partial ? ' bt-stats-partial' : '';
    if (!Number.isFinite(g)) s(svg, 'circle', { cx, cy: y0, r: 2.5, class: `bt-gap-none${faded}` });
    else if (Math.abs(g) <= LEVEL) s(svg, 'rect', { x: cx - barW / 2, y: y0 - 1, width: barW, height: 2, rx: 1, class: `bt-gap-level${faded}` });
    else {
      const [a, b] = [y(Math.max(g, 0)), y(Math.min(g, 0))];
      s(svg, 'rect', { x: cx - barW / 2, y: a, width: barW, height: Math.max(b - a, 1), rx: Math.min(2, barW / 2), class: `${g > 0 ? 'bt-gap-ahead' : 'bt-gap-behind'}${faded}` });
    }
    // The extremes are named; the read-out gives the rest.
    if ((i === best && g > LEVEL) || (i === worst && g < -LEVEL)) {
      s(svg, 'text', { x: cx, y: g > 0 ? y(g) - 5 : y(g) + 13, class: 'bt-axis bt-callout', 'text-anchor': 'middle' }, `${g > 0 ? '+' : '−'}${(Math.abs(g) * 100).toFixed(1)}`);
    }
    if (Number(p.key) % labelEvery === 0) s(svg, 'text', { x: cx, y: height - 4, class: 'bt-axis', 'text-anchor': 'middle' }, p.key);
  });

  const hit = s(svg, 'rect', { x: left, y: 0, width: plotW, height, fill: 'transparent' });
  let shown: number | null = null;
  const nearest = (clientX: number) => Math.min(n - 1, Math.max(0, Math.floor((clientX - svg.getBoundingClientRect().left - left) / groupW)));
  const show = (i: number) => {
    shown = i;
    hl.setAttribute('x', String(left + i * groupW));
    hl.setAttribute('visibility', 'visible');
    const p = mine[i];
    const b = theirs.get(p.key);
    const g = gaps[i];
    const apart = !Number.isFinite(g) ? `no ${bench} return` : Math.abs(g) <= LEVEL ? 'the same' : `${pts(g)} ${g > 0 ? 'better' : 'worse'}`;
    read.textContent = `${p.key}${p.partial ? ', part of the year' : ''} · strategy ${signedPct(p.ret)}, ${bench} ${b ? signedPct(b.ret) : '–'} · ${apart}`;
  };
  const rest = () => {
    shown = null;
    hl.setAttribute('visibility', 'hidden');
    read.textContent = idle;
  };
  hit.addEventListener('pointermove', (e) => show(nearest((e).clientX)));
  hit.addEventListener('pointerdown', (e) => show(nearest((e).clientX)));
  hit.addEventListener('pointerleave', rest);
  return { t: mine.map((p) => p.t), first: 0, at: () => shown, show, rest };
}

/** Weakest and strongest tint, as a percentage of the gain or loss colour. */
const TINT_MIN = 12;
const TINT_MAX = 70;
const LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

/** The Months tab: each month's return as a cell of a calendar grid, its value read out when pointed at. */
export function renderMonths(parent: HTMLElement, input: Pick<PeriodInput, 't' | 'strategy'>): () => void {
  const months = periodReturns(input.t, input.strategy, 'month');
  if (months.length === 0) return () => {};
  const up = months.filter((m) => m.ret > 0).length / months.length;
  const details = h(parent, 'details', 'bt-details bt-months');
  h(details, 'summary', undefined, 'Months');
  tabInfo(details, 'Months', `up in ${pct(up, 0)}`);
  return lazy(details, (body) => {
    const years = periodReturns(input.t, input.strategy, 'year');
    const best = months.reduce((a, m) => (m.ret > a.ret ? m : a));
    const worst = months.reduce((a, m) => (m.ret < a.ret ? m : a));
    const flat = months.some((m) => m.ret === 0);
    h(body, 'p', 'bt-tab-lead', `Up in ${pct(up, 0)} of ${plural(months.length, 'month')}. The best month was ${periodName(best)} (${signedPct(best.ret)}). The worst month was ${periodName(worst)} (${signedPct(worst.ret)}).${flat ? ' A month with a border had no change. Usually the strategy was in cash.' : ''}`);
    const read = h(body, 'div', 'bt-tab-read');
    const idle = 'Move the pointer to a month to see its return.';
    read.textContent = idle;
    const byKey = new Map(months.map((m) => [m.key, m]));
    const peak = Math.max(...months.map((m) => Math.abs(m.ret)), 1e-9);
    const wrap = h(body, 'div', 'bt-months-box');
    const table = h(wrap, 'table', 'bt-months-grid');
    const head = h(h(table, 'thead'), 'tr');
    h(head, 'th');
    MONTHS.forEach((name, m) => {
      const th = h(head, 'th');
      h(th, 'span', 'bt-m-long', name);
      h(th, 'span', 'bt-m-short', LETTERS[m]);
    });
    h(head, 'th', 'bt-num', 'Year');
    const tbody = h(table, 'tbody');
    tbody.addEventListener('pointerleave', () => (read.textContent = idle));
    for (const year of years) {
      const row = h(tbody, 'tr');
      h(row, 'th', undefined, year.key).setAttribute('scope', 'row');
      for (let m = 0; m < 12; m++) {
        const p = byKey.get(`${year.key}-${String(m + 1).padStart(2, '0')}`);
        const td = h(row, 'td', 'bt-month');
        if (!p) {
          td.classList.add('bt-month-none');
          continue;
        }
        const text = p.ret === 0 ? 'no change' : signedPct(p.ret);
        h(td, 'span', 'bt-sr', text);
        if (p.ret === 0) td.classList.add('bt-month-flat');
        else {
          td.classList.add(p.ret > 0 ? 'bt-stats-up' : 'bt-stats-down');
          td.style.setProperty('--bt-stats-tint', `${Math.round(TINT_MIN + (TINT_MAX - TINT_MIN) * Math.sqrt(Math.abs(p.ret) / peak))}%`);
        }
        td.addEventListener('pointerenter', () => (read.textContent = `${periodName(p)}${p.partial ? ', part of the month' : ''} · ${text}`));
      }
      h(row, 'td', `bt-num bt-stats-year${year.partial ? ' bt-stats-partial-year' : ''}`, pct(year.ret));
    }
    const scale = h(body, 'div', 'bt-months-scale');
    h(scale, 'span', undefined, pct(-peak, 0));
    for (const [cls, tint] of [['bt-stats-down', TINT_MAX], ['bt-stats-down', TINT_MIN + 10], ['bt-month-flat', 0], ['bt-stats-up', TINT_MIN + 10], ['bt-stats-up', TINT_MAX]] as const) {
      const sw = h(scale, 'span', `bt-months-swatch ${cls}`);
      if (tint) sw.style.setProperty('--bt-stats-tint', `${tint}%`);
    }
    h(scale, 'span', undefined, `+${pct(peak, 0)}`);
  });
}
