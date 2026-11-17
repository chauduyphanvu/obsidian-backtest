// The "Try other parameter values" section: runs every combination of the declared ranges and reads the result honestly.

import type { Backtest, Stats } from './backtest.ts';
import { h, minus, niceStep, pct, s } from './dom.ts';
import {
  METRICS,
  isDeclared,
  metricOf,
  runSweep,
  splitSummary,
  summarize,
  sweepLimit,
  sweepParams,
  type Metric,
  type Parse,
  type Period,
  type SweepParam,
  type SweepPoint,
  type SweepResult,
  type SweepSummary,
} from './sweep.ts';

export interface SweepInput {
  source: string;
  backtest: Backtest;
  parse: Parse;
}

/** Shared by the parts of a section: observers to disconnect, and whether the section is gone. */
export interface Life {
  gone: boolean;
  observers: ResizeObserver[];
}

const TABLE_ROWS = 20;
/** Weakest and strongest tint of a heatmap cell, as a percentage of the gain or loss colour. */
const TINT_MIN = 10;
const TINT_MAX = 62;
/** Cells stop growing here, so a grid with few columns stays a grid. */
const MAX_CELL = 96;
/** Rough width of a character of the 11px chart text. */
const CHAR = 6.6;

// ---------------------------------------------------------------- words and numbers

const tidy = (x: number) => Number(x.toPrecision(12));
const paramText = (p: { percent: boolean }, v: number) => (p.percent ? `${tidy(v * 100)}%` : String(tidy(v)));
export const valuesText = (params: SweepParam[], values: Record<string, number>) => params.map((p) => `${p.name} ${paramText(p, values[p.name])}`).join(', ');
const fmtMetric = (m: Metric, v: number) => (METRICS[m].percent ? pct(v) : Number.isFinite(v) ? minus(v.toFixed(2)) : '–');
export const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n.toLocaleString('en-US')}${suffix}`;
}

/** "made 8.1% a year", "had a Sharpe ratio of 0.62": a result in words. */
export function did(m: Metric, v: number): string {
  switch (m) {
    case 'cagr':
      return `made ${pct(v)} a year`;
    case 'totalReturn':
      return `returned ${pct(v)}`;
    case 'maxDrawdown':
      return `had a worst drawdown of ${pct(v)}`;
    case 'sharpe':
      return `had a Sharpe ratio of ${fmtMetric(m, v)}`;
    case 'sortino':
      return `had a Sortino ratio of ${fmtMetric(m, v)}`;
  }
}

/** Appends a progress bar with a label; hidden until shown. */
export function progressBar(parent: HTMLElement): { set: (done: number, total: number, text: string) => void; show: (on: boolean) => void } {
  const wrap = h(parent, 'span', 'bt-progress');
  const bar = h(wrap, 'progress');
  const label = h(wrap, 'span', 'bt-progress-label');
  wrap.hidden = true;
  return {
    set: (done, total, text) => {
      bar.max = total;
      bar.value = done;
      label.textContent = text;
    },
    show: (on) => (wrap.hidden = !on),
  };
}

function select<T extends string>(parent: HTMLElement, label: string, options: [T, string][], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const wrap = h(parent, 'label', 'bt-picker');
  h(wrap, 'span', 'bt-picker-label', label);
  const el = h(wrap, 'select', 'dropdown');
  for (const [v, text] of options) {
    const o = h(el, 'option', undefined, text);
    o.value = v;
  }
  el.value = value;
  el.addEventListener('change', () => onChange(el.value as T));
  return el;
}

/** Keeps a tooltip inside its chart: to the right of `x`, or to the left when it would run off. */
export function placeTip(tip: HTMLElement, x: number, y: number, width: number): void {
  tip.hidden = false;
  const left = x + 12 + tip.offsetWidth > width ? x - 12 - tip.offsetWidth : x + 12;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.max(0, y)}px`;
}

/** Draws on every width change; drawing changes the height, which notifies again at the same width. */
export function observe(life: Life, el: HTMLElement, draw: (width: number) => void): void {
  let drawn = 0;
  const observer = new ResizeObserver((entries) => {
    const width = Math.floor(entries[0].contentRect.width);
    if (width > 0 && width !== drawn) draw((drawn = width));
  });
  observer.observe(el);
  life.observers.push(observer);
}

// ---------------------------------------------------------------- section

/** Appends a collapsed "Try other parameter values" section when a parameter has a range. Returns a cleanup function. */
export function renderSweep(parent: HTMLElement, input: SweepInput): () => void {
  const params = sweepParams(input.backtest.spec);
  if (params.length === 0) return () => {};
  const life: Life = { gone: false, observers: [] };
  const details = h(parent, 'details', 'bt-details bt-sweep');
  h(details, 'summary', undefined, 'Try other parameter values');
  details.addEventListener('toggle', () => build(h(details, 'div', 'bt-sweep-body'), input, params, life), { once: true });
  return () => {
    life.gone = true;
    for (const o of life.observers) o.disconnect();
  };
}

function intro(params: SweepParam[], total: number): string {
  const ranges = params.map((p) => `${p.name} from ${paramText(p, p.values[0])} to ${paramText(p, p.values[p.values.length - 1])} (${plural(p.values.length, 'value')})`);
  const list = ranges.length === 1 ? ranges[0] : `${ranges.slice(0, -1).join(', ')} and ${ranges[ranges.length - 1]}`;
  return `The ranges in this block give ${plural(total, 'variant')}: ${list}. Each one is a full backtest on the same prices.`;
}

function build(body: HTMLElement, input: SweepInput, params: SweepParam[], life: Life): void {
  const total = params.reduce((n, p) => n * p.values.length, 1);
  h(body, 'p', 'bt-sweep-intro', intro(params, total));
  const refusal = sweepLimit(total);
  if (refusal) {
    h(body, 'div', 'bt-warning', refusal);
    return;
  }
  const controls = h(body, 'div', 'bt-run-row');
  const run = h(controls, 'button', 'bt-button mod-cta', `Run ${plural(total, 'variant')}`);
  const progress = progressBar(controls);
  const stop = h(controls, 'button', 'bt-button', 'Stop');
  stop.hidden = true;
  const results = h(body, 'div', 'bt-sweep-results');
  let stopping = false;
  stop.addEventListener('click', () => (stopping = true));
  run.addEventListener('click', async () => {
    stopping = false;
    run.hidden = true;
    stop.hidden = false;
    progress.set(0, total, `0 of ${total}`);
    progress.show(true);
    results.replaceChildren();
    try {
      const result = await runSweep(input.source, input.backtest.data, {
        parse: input.parse,
        onProgress: (done, n) => progress.set(done, n, `${done} of ${n}`),
        shouldStop: () => stopping || life.gone,
      });
      if (life.gone) return;
      showResults(results, input, result, life);
      if (result.stopped) {
        run.textContent = `Run all ${plural(total, 'variant')}`;
        run.hidden = false;
      }
    } catch (e) {
      h(results, 'div', 'bt-warning', e instanceof Error ? e.message : String(e));
      run.hidden = false;
    } finally {
      stop.hidden = true;
      progress.show(false);
    }
  });
}

interface View {
  metric: Metric;
  period: Period;
  /** Parameters on the heatmap's rows and columns, as indices into `params`. */
  down: number;
  across: number;
}

function showResults(results: HTMLElement, input: SweepInput, result: SweepResult, life: Life): void {
  const params = result.params;
  const segments = input.backtest.segments;
  // The two parameters with the most values make the heatmap; the one with more goes down the side,
  // where a narrow note has room for it.
  const [down, across] = params.map((_, i) => i).sort((a, b) => params[b].values.length - params[a].values.length || a - b);
  // With a test date, the view starts on the part before it: values chosen on the whole run have seen the test period.
  const view: View = { metric: 'cagr', period: segments ? 'before' : 'all', down, across: across ?? 0 };
  const testDay = segments ? segments[1].label.replace(/^From /, '') : null;

  if (result.stopped) h(results, 'div', 'bt-warning', `Stopped after ${result.tried} of ${plural(result.total, 'variant')}: what follows covers those only.`);
  const pickers = h(results, 'div', 'bt-pickers');
  const explain = h(results, 'div', 'bt-note bt-sweep-explain');
  const splitBox = h(results, 'div');
  const periodRow = h(results, 'div', 'bt-pickers');
  const content = h(results, 'div');

  const draw = () => {
    for (const o of life.observers.splice(0)) o.disconnect();
    explain.textContent = `${METRICS[view.metric].label}: ${METRICS[view.metric].explain}.`;
    splitBox.replaceChildren();
    if (segments) splitCallout(splitBox, result, view.metric, testDay!);
    content.replaceChildren();
    const bench = view.period === 'all' ? input.backtest.benchmark.stats : segments![view.period === 'before' ? 0 : 1].benchmarkStats;
    const summary = summarize(result, view.metric, { period: view.period, benchmark: bench });
    if (!summary) {
      h(content, 'div', 'bt-warning', `No variant has a ${METRICS[view.metric].noun} for this period.`);
      return;
    }
    reading(content, result, summary, input.backtest.benchmark.label, bench);
    if (params.length === 1) dotLine(content, life, result, summary);
    else heatmapSection(content, life, result, summary, view, draw);
    bestValues(content, params, summary, view.period, testDay);
    if (params.length >= 3) bestTable(content, result, summary);
  };

  select(pickers, 'Measure', (Object.keys(METRICS) as Metric[]).map((m) => [m, METRICS[m].label]), view.metric, (m) => {
    view.metric = m;
    draw();
  });
  if (segments) {
    const periods: [Period, string][] = [
      ['before', segments[0].label],
      ['after', segments[1].label],
      ['all', 'Whole run'],
    ];
    select(periodRow, 'Show', periods, view.period, (p) => {
      view.period = p;
      draw();
    });
  }
  draw();
}

/** Picked on the part before `test from`, judged on the part after: the fairest number here. */
function splitCallout(el: HTMLElement, result: SweepResult, metric: Metric, day: string): void {
  const split = splitSummary(result, metric);
  if (!split) return;
  const box = h(el, 'div', 'bt-sweep-split');
  h(box, 'div', 'bt-sweep-split-title', `Tuned before ${day}, tested after: ${METRICS[metric].noun} from ${day} on`);
  const tiles = h(box, 'div', 'bt-sweep-split-tiles');
  const tile = (label: string, value: number, sub: string) => {
    const t = h(tiles, 'div', 'bt-tile');
    h(t, 'div', 'bt-tile-label', label);
    h(t, 'div', 'bt-tile-value', fmtMetric(metric, value));
    h(t, 'div', 'bt-tile-sub', sub);
  };
  const p = result.params;
  tile(`Best before ${day}`, split.chosenAfter, `${valuesText(p, split.chosen.values)}; ${fmtMetric(metric, split.chosenBefore)} before`);
  const declared = result.points.find((q) => isDeclared(result, q));
  if (declared) tile('Values in the note', split.declaredAfter, `${valuesText(p, declared.values)}; ${fmtMetric(metric, split.declaredBefore)} before`);
  tile('Middle variant', split.medianAfter, `half of ${split.count} did better`);

  const fell = split.chosenAfter < split.chosenBefore;
  const lines = [
    `The variant that did best before ${day} (${valuesText(p, split.chosen.values)}) ${did(metric, split.chosenBefore)} then and ${did(metric, split.chosenAfter)} from ${day} on, ranking ${ordinal(split.chosenAfterRank)} of ${split.count} after it.`,
    fell ? 'Some of what it showed before came from fitting those years.' : 'It held up after the split.',
    `The pick never saw the later prices, so this is the best guide here to what choosing values this way is worth.${declared ? ' The values in the note are only as clean as how they were chosen: if they were picked by looking at the whole run, their later result is not a fair test either.' : ''}`,
  ];
  h(box, 'p', 'bt-sweep-split-text', lines.join(' '));
}

function reading(el: HTMLElement, result: SweepResult, sum: SweepSummary, benchLabel: string, bench: Stats): void {
  const m = sum.metric;
  const p = result.params;
  const n = sum.ranked.length;
  const label = METRICS[m].noun;
  const list = h(el, 'ul', 'bt-sweep-reading');
  const line = (text: string) => h(list, 'li', undefined, text);

  const failed = result.points.filter((q) => q.error !== null);
  line(
    `${plural(result.tried, 'variant')} tried` +
      (failed.length ? `; ${plural(failed.length, 'variant')} could not run (${valuesText(p, failed[0].values)}: ${failed[0].error})` : '') +
      (sum.idle ? `; ${plural(sum.idle, 'variant')} never traded, so ${sum.idle === 1 ? 'it is' : 'they are'} left out of the ranking` : '') +
      (sum.failed > failed.length ? `; ${sum.failed - failed.length} had no ${label} for this period` : '') +
      '.',
  );
  if (sum.declared && sum.declaredRank !== null) {
    line(
      `The values in the note (${valuesText(p, sum.declared.values)}) rank ${ordinal(sum.declaredRank)} of ${n} on ${label}, at ${fmtMetric(m, metricOf(sum.declared, m, sum.period))}. ` +
        `The best variant reached ${fmtMetric(m, metricOf(sum.best, m, sum.period))}, and the middle one (half did better, half worse) ${fmtMetric(m, sum.median)}.`,
    );
  } else {
    line(`The values in the note ${sum.declared?.trades === 0 ? 'never trade, so they are not ranked' : 'have no result here'}. The best variant reached ${fmtMetric(m, metricOf(sum.best, m, sum.period))}, and the middle one (half did better, half worse) ${fmtMetric(m, sum.median)}.`);
  }
  const nb = sum.neighbours;
  const near = `Its neighbours, one step away on each parameter, typically reached ${fmtMetric(m, nb.median)}`;
  const say: Record<SweepSummary['neighbours']['verdict'], string> = {
    plateau: `${near}: close to the best, so the result does not hang on the exact values.`,
    mixed: `${near}: clearly below the best, so part of its lead is a lucky spot on the grid.`,
    spike: `${near}: far below it, so the best is a lonely spike and most likely noise.`,
    flat: 'Most variants did about as well as the best, so the exact values matter little.',
    none: 'Its neighbours have nothing to compare (they could not run or never traded), so there is no telling whether the best is a lonely spike.',
  };
  if (n > 1) line(say[nb.verdict]);
  if (n > 1) {
    line(
      `Picking the best of ${plural(n, 'try', 'tries')} flatters it: even if no variant had a real edge, one would come out on top by luck. Expect something nearer the middle result than the best.`,
    );
  }
  if (sum.shareBeatingBenchmark !== undefined) {
    const k = Math.round(sum.shareBeatingBenchmark * n);
    const who = benchLabel.replace(/^(Buy|Equal)/, (w) => w.toLowerCase());
    line(`${k} of ${plural(n, 'variant')} (${pct(sum.shareBeatingBenchmark, 0)}) beat ${who} on ${label}, which reached ${fmtMetric(m, bench[m])}.`);
  }
}

/**
 * What the line under a sweep's reading says about its best values: which part of the run chose them, and whether to try them.
 * `testDay` is the day `test from` sets, or null when the block has none. Values chosen on any view that includes the test
 * period are not offered, because their later result would not be a fair test.
 */
export function bestWords(period: Period, testDay: string | null): { label: string; advice: string } {
  const tryIt = 'To try it, change those lines in the block; the note stays the record of what you chose.';
  if (testDay === null) return { label: 'Best variant here: ', advice: tryIt };
  if (period === 'before') return { label: `Best before ${testDay}: `, advice: tryIt };
  return {
    label: period === 'after' ? `Best from ${testDay} on: ` : 'Best on the whole run: ',
    advice: 'Values picked on this view have seen the test period, so their later result is not a fair test.',
  };
}

function bestValues(el: HTMLElement, params: SweepParam[], sum: SweepSummary, period: Period, testDay: string | null): void {
  const words = bestWords(period, testDay);
  const row = h(el, 'div', 'bt-sweep-best');
  h(row, 'span', undefined, words.label);
  params.forEach((p, i) => {
    if (i > 0) row.append(' ');
    h(row, 'code', undefined, `${p.name} = ${paramText(p, sum.best.values[p.name])}`);
  });
  row.append(`. ${words.advice}`);
}

// ---------------------------------------------------------------- one parameter: dots on a line

function dotLine(el: HTMLElement, life: Life, result: SweepResult, sum: SweepSummary): void {
  const chart = h(el, 'div', 'bt-chart bt-sweep-chart');
  const tip = h(chart, 'div', 'bt-tip');
  tip.hidden = true;
  observe(life, chart, (width) => drawDotLine(chart, tip, width, result, sum));
}

function drawDotLine(chart: HTMLElement, tip: HTMLElement, width: number, result: SweepResult, sum: SweepSummary): void {
  chart.querySelector('svg')?.remove();
  tip.hidden = true;
  const p = result.params[0];
  const m = sum.metric;
  const byIndex = new Map(result.points.map((q) => [q.index[0], q]));
  const xs = p.values;
  // A variant that never traded is cash: left out of the line like one that could not run.
  const ys = xs.map((_, i) => (byIndex.get(i)?.trades ? metricOf(byIndex.get(i)!, m, sum.period) : NaN));
  const finite = ys.filter((y) => !Number.isNaN(y));

  const left = 50;
  const right = 14;
  const top = 38;
  const plotH = Math.round(Math.min(220, Math.max(150, width * 0.3)));
  const height = top + plotH + 40;
  const plotW = width - left - right;
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const span = hi - lo || Math.max(Math.abs(hi) * 0.2, METRICS[m].percent ? 0.01 : 0.1);
  const step = niceStep(span, 4);
  const yMin = Math.floor((lo - span * 0.08) / step) * step;
  const yMax = Math.ceil((hi + span * 0.08) / step) * step;
  const y = (v: number) => top + ((yMax - v) / (yMax - yMin)) * plotH;
  const x0 = xs[0];
  const x1 = xs[xs.length - 1];
  // Inset so the end dots and labels clear the value axis.
  const inset = 14;
  const x = (v: number) => (x1 === x0 ? left + plotW / 2 : left + inset + ((v - x0) / (x1 - x0)) * (plotW - 2 * inset));

  const svg = s(chart, 'svg', { width, height, class: 'bt-svg', role: 'img', 'aria-label': `${METRICS[m].label} for each value of ${p.name}` });
  const tickFmt = (v: number) => (METRICS[m].percent ? pct(v, step >= 0.01 ? 0 : 1) : minus(v.toFixed(step >= 0.1 ? 1 : 2)));
  for (let k = Math.round(yMin / step); k * step <= yMax + step / 1e6; k++) {
    const v = k * step;
    s(svg, 'line', { x1: left, x2: width - right, y1: y(v), y2: y(v), class: Math.abs(v) < step / 1e6 ? 'bt-baseline' : 'bt-grid' });
    s(svg, 'text', { x: left - 6, y: y(v) + 3.5, class: 'bt-axis', 'text-anchor': 'end' }, tickFmt(Math.abs(v) < step / 1e6 ? 0 : v));
  }
  // Value labels along the bottom, as many as fit without touching.
  const widest = Math.max(...xs.map((v) => paramText(p, v).length)) * CHAR + 10;
  const every = Math.max(1, Math.ceil(widest / ((plotW - 2 * inset) / Math.max(1, xs.length - 1))));
  xs.forEach((v, i) => {
    if (i % every !== 0 && i !== xs.length - 1) return;
    if (i === xs.length - 1 && i % every !== 0 && x(v) - x(xs[i - (i % every)]) < widest) return;
    s(svg, 'text', { x: x(v), y: top + plotH + 18, class: 'bt-axis', 'text-anchor': 'middle' }, paramText(p, v));
  });
  s(svg, 'text', { x: left + plotW / 2, y: top + plotH + 34, class: 'bt-axis bt-panel-label', 'text-anchor': 'middle' }, p.name);

  // The values in the note, marked through the plot.
  const declaredI = xs.indexOf(p.declared);
  const bestI = sum.best.index[0];
  const dx = x(xs[declaredI]);
  s(svg, 'line', { x1: dx, x2: dx, y1: top - 4, y2: top + plotH, class: 'bt-sweep-mark' });

  let d = '';
  ys.forEach((v, i) => {
    if (Number.isNaN(v)) {
      d += ' ';
      return;
    }
    d += `${d === '' || d.endsWith(' ') ? 'M' : 'L'}${x(xs[i]).toFixed(1)},${y(v).toFixed(1)}`;
  });
  s(svg, 'path', { d: d.trim(), class: 'bt-line bt-line-strategy' });
  ys.forEach((v, i) => {
    if (!Number.isNaN(v)) s(svg, 'circle', { cx: x(xs[i]), cy: y(v), r: xs.length > 40 ? 2.5 : 4, class: 'bt-dot bt-dot-strategy' });
    else if (byIndex.has(i)) s(svg, 'text', { x: x(xs[i]), y: top + plotH - 4, class: 'bt-axis', 'text-anchor': 'middle' }, byIndex.get(i)!.error ? '×' : '–');
  });
  if (declaredI >= 0 && !Number.isNaN(ys[declaredI])) s(svg, 'circle', { cx: dx, cy: y(ys[declaredI]), r: 7, class: 'bt-sweep-ring' });

  // Labels in two rows above the plot, so they never sit on the line.
  const labels: { at: number; text: string }[] = [];
  if (declaredI === bestI) labels.push({ at: dx, text: 'In the note, and best' });
  else {
    labels.push({ at: dx, text: 'In the note' });
    labels.push({ at: x(xs[bestI]), text: 'Best' });
  }
  const placed: { cx: number; w: number }[] = [];
  labels.forEach((l, k) => {
    const w = l.text.length * CHAR;
    const cx = Math.min(Math.max(l.at, left + w / 2), width - right - w / 2);
    const row = placed.some((q) => Math.abs(q.cx - cx) < (q.w + w) / 2 + 8) ? 1 : 0;
    s(svg, 'text', { x: cx, y: 12 + row * 14, class: 'bt-axis bt-panel-label', 'text-anchor': 'middle' }, l.text);
    if (k === 1) s(svg, 'line', { x1: l.at, x2: l.at, y1: 16 + row * 14, y2: top - 4, class: 'bt-grid' });
    placed.push({ cx, w });
  });

  const hl = s(svg, 'circle', { r: 5.5, class: 'bt-dot bt-dot-strategy', visibility: 'hidden' });
  const hit = s(svg, 'rect', { x: left - 8, y: top, width: plotW + 16, height: plotH, fill: 'transparent' });
  const show = (clientX: number) => {
    const px = clientX - svg.getBoundingClientRect().left;
    let i = 0;
    for (let k = 1; k < xs.length; k++) if (Math.abs(x(xs[k]) - px) < Math.abs(x(xs[i]) - px)) i = k;
    const point = byIndex.get(i);
    tip.replaceChildren();
    h(tip, 'div', 'bt-tip-date', `${p.name} ${paramText(p, xs[i])}${i === declaredI ? ' (in the note)' : ''}`);
    if (point) tipRows(tip, point, m);
    if (!Number.isNaN(ys[i])) {
      hl.setAttribute('cx', String(x(xs[i])));
      hl.setAttribute('cy', String(y(ys[i])));
      hl.setAttribute('visibility', 'visible');
    }
    placeTip(tip, x(xs[i]), top, width);
  };
  hit.addEventListener('pointermove', (e) => show((e as PointerEvent).clientX));
  hit.addEventListener('pointerdown', (e) => show((e as PointerEvent).clientX));
  hit.addEventListener('pointerleave', () => {
    tip.hidden = true;
    hl.setAttribute('visibility', 'hidden');
  });
}

/** The tooltip rows for a variant: its result, its trades, and the two parts when the run is split. */
function tipRows(tip: HTMLElement, point: SweepPoint, m: Metric): void {
  const row = (label: string, value: string) => {
    const r = h(tip, 'div', 'bt-sweep-tip-row');
    h(r, 'span', 'bt-tip-label', label);
    h(r, 'span', 'bt-tip-value', value);
  };
  if (point.error) {
    h(tip, 'div', 'bt-sweep-tip-error', `Could not run: ${point.error}`);
    return;
  }
  row(METRICS[m].label, fmtMetric(m, metricOf(point, m)));
  if (point.before && point.after) {
    row('Before the split', fmtMetric(m, metricOf(point, m, 'before')));
    row('After the split', fmtMetric(m, metricOf(point, m, 'after')));
  }
  row('Trades', String(point.trades));
}

// ---------------------------------------------------------------- two or more: a heatmap

function heatmapSection(el: HTMLElement, life: Life, result: SweepResult, sum: SweepSummary, view: View, redraw: () => void): void {
  const params = result.params;
  if (params.length >= 3) {
    const row = h(el, 'div', 'bt-pickers');
    const options = params.map((p, i): [string, string] => [String(i), p.name]);
    select(row, 'Down', options, String(view.down), (v) => {
      if (Number(v) === view.across) view.across = view.down;
      view.down = Number(v);
      redraw();
    });
    select(row, 'Across', options, String(view.across), (v) => {
      if (Number(v) === view.down) view.down = view.across;
      view.across = Number(v);
      redraw();
    });
    const others = params.filter((_, i) => i !== view.down && i !== view.across);
    h(el, 'div', 'bt-note', `The ${others.length === 1 ? 'other parameter stays' : 'other parameters stay'} at the values in the note: ${others.map((p) => `${p.name} ${paramText(p, p.declared)}`).join(', ')}.`);
  }
  const fixed = params.map((p) => p.values.indexOf(p.declared));
  const chart = h(el, 'div', 'bt-chart bt-sweep-heat');
  const scroll = h(chart, 'div', 'bt-sweep-scroll');
  const tip = h(chart, 'div', 'bt-tip');
  tip.hidden = true;
  scroll.addEventListener('scroll', () => (tip.hidden = true));
  const key = h(el, 'div', 'bt-sweep-key');
  observe(life, chart, (width) => drawHeatmap(scroll, tip, key, width, result, sum, view, fixed));
}

/** Formats from most to least precise; the first whose labels fit the cells is used. */
function cellFormats(m: Metric): { fmt: (v: number) => string; unit: string }[] {
  if (METRICS[m].percent) {
    return [
      { fmt: (v) => pct(v), unit: '' },
      { fmt: (v) => minus((v * 100).toFixed(1)), unit: ' (in %)' },
      { fmt: (v) => minus((v * 100).toFixed(0)), unit: ' (in %)' },
    ];
  }
  return [
    { fmt: (v) => minus(v.toFixed(2)), unit: '' },
    { fmt: (v) => minus(v.toFixed(1)), unit: '' },
  ];
}

function tint(v: number, peak: number): string {
  if (v === 0 || !(peak > 0)) return 'var(--background-secondary)';
  const share = Math.round(TINT_MIN + (TINT_MAX - TINT_MIN) * Math.min(1, Math.abs(v) / peak));
  return `color-mix(in srgb, var(${v > 0 ? '--bt-sweep-gain' : '--bt-sweep-loss'}) ${share}%, var(--background-primary))`;
}

function drawHeatmap(scroll: HTMLElement, tip: HTMLElement, key: HTMLElement, width: number, result: SweepResult, sum: SweepSummary, view: View, fixed: number[]): void {
  scroll.replaceChildren();
  tip.hidden = true;
  const m = sum.metric;
  const rowP = result.params[view.down];
  const colP = result.params[view.across];
  const byKey = new Map(result.points.map((q) => [q.index.join(','), q]));
  const cell = (r: number, c: number) => {
    const index = [...fixed];
    index[view.down] = r;
    index[view.across] = c;
    return byKey.get(index.join(','));
  };
  const values: number[] = [];
  for (let r = 0; r < rowP.values.length; r++) {
    for (let c = 0; c < colP.values.length; c++) {
      const q = cell(r, c);
      const v = q?.trades ? metricOf(q, m, sum.period) : NaN;
      if (!Number.isNaN(v)) values.push(v);
    }
  }
  const peak = Math.max(0, ...values.map(Math.abs));

  const rowLabels = rowP.values.map((v) => paramText(rowP, v));
  const labelW = Math.ceil(Math.max(rowP.name.length, ...rowLabels.map((t) => t.length)) * CHAR) + 12;
  const cols = colP.values.length;
  const per = (width - labelW) / cols;
  const formats = cellFormats(m);
  const need = (f: (v: number) => string) => Math.max(...values.map((v) => f(v).length), 1) * CHAR + 8;
  const format = formats.find((f) => need(f.fmt) <= per) ?? formats[formats.length - 1];
  const cellW = Math.max(Math.min(per, MAX_CELL), need(format.fmt));
  const cellH = 26;
  const top = 36;
  const svgW = Math.floor(labelW + cellW * cols);
  const svgH = top + cellH * rowP.values.length + 2;
  const svg = s(scroll, 'svg', { width: svgW, height: svgH, class: 'bt-svg', role: 'img', 'aria-label': `${METRICS[m].label} for each pair of ${rowP.name} and ${colP.name}` });

  // Column labels, thinned when they would touch; the row parameter's name sits over its labels.
  const colLabels = colP.values.map((v) => paramText(colP, v));
  const every = Math.max(1, Math.ceil((Math.max(...colLabels.map((t) => t.length)) * CHAR + 6) / cellW));
  colLabels.forEach((t, c) => {
    if (c % every === 0) s(svg, 'text', { x: labelW + (c + 0.5) * cellW, y: top - 8, class: 'bt-axis', 'text-anchor': 'middle' }, t);
  });
  s(svg, 'text', { x: labelW + (cellW * cols) / 2, y: 11, class: 'bt-axis bt-panel-label', 'text-anchor': 'middle' }, `${colP.name} →`);
  s(svg, 'text', { x: 0, y: top - 8, class: 'bt-axis bt-panel-label' }, `${rowP.name} ↓`);
  rowLabels.forEach((t, r) => s(svg, 'text', { x: labelW - 8, y: top + r * cellH + cellH / 2 + 4, class: 'bt-axis', 'text-anchor': 'end' }, t));

  const declared = [rowP.values.indexOf(rowP.declared), colP.values.indexOf(colP.declared)];
  const isBest = (q: SweepPoint | undefined) => q !== undefined && q === sum.best;
  let bestAt: [number, number] | null = null;
  for (let r = 0; r < rowP.values.length; r++) {
    for (let c = 0; c < cols; c++) {
      const q = cell(r, c);
      const v = q?.trades ? metricOf(q, m, sum.period) : NaN;
      const x = labelW + c * cellW + 1;
      const y = top + r * cellH + 1;
      const rect = s(svg, 'rect', { x, y, width: cellW - 2, height: cellH - 2, rx: 2, class: 'bt-sweep-cell' });
      rect.setAttribute('style', `fill: ${Number.isNaN(v) ? 'var(--background-secondary)' : tint(v, peak)}`);
      // × for a variant that could not run, – for one that never traded, nothing for one not run (a stopped sweep).
      const text = !q ? '' : q.error ? '×' : !q.trades ? '–' : Number.isNaN(v) ? '' : format.fmt(v);
      s(svg, 'text', { x: x + (cellW - 2) / 2, y: y + cellH / 2 + 3, class: `bt-sweep-cell-text${Number.isNaN(v) ? ' bt-sweep-cell-none' : ''}${isBest(q) ? ' bt-sweep-cell-best' : ''}`, 'text-anchor': 'middle' }, text);
      if (isBest(q)) bestAt = [r, c];
    }
  }
  const outline = (r: number, c: number, cls: string) =>
    s(svg, 'rect', { x: labelW + c * cellW + 1.5, y: top + r * cellH + 1.5, width: cellW - 3, height: cellH - 3, rx: 2, class: cls });
  if (bestAt && (bestAt[0] !== declared[0] || bestAt[1] !== declared[1])) outline(bestAt[0], bestAt[1], 'bt-sweep-best-outline');
  outline(declared[0], declared[1], 'bt-sweep-declared-outline');

  const hl = s(svg, 'rect', { width: cellW - 1, height: cellH - 1, rx: 2, class: 'bt-sweep-hover', visibility: 'hidden' });
  const hide = () => {
    tip.hidden = true;
    hl.setAttribute('visibility', 'hidden');
  };
  const show = (e: Event) => {
    const box = svg.getBoundingClientRect();
    const px = (e as PointerEvent).clientX - box.left;
    const py = (e as PointerEvent).clientY - box.top;
    const c = Math.floor((px - labelW) / cellW);
    const r = Math.floor((py - top) / cellH);
    if (c < 0 || c >= cols || r < 0 || r >= rowP.values.length) {
      hide();
      return;
    }
    hl.setAttribute('x', String(labelW + c * cellW + 0.5));
    hl.setAttribute('y', String(top + r * cellH + 0.5));
    hl.setAttribute('visibility', 'visible');
    const q = cell(r, c);
    tip.replaceChildren();
    const note = r === declared[0] && c === declared[1] ? ' (in the note)' : '';
    h(tip, 'div', 'bt-tip-date', `${rowP.name} ${paramText(rowP, rowP.values[r])}, ${colP.name} ${paramText(colP, colP.values[c])}${note}`);
    if (q) tipRows(tip, q, m);
    else h(tip, 'div', 'bt-tip-foot', 'Not run');
    placeTip(tip, labelW + (c + 1) * cellW - scroll.scrollLeft, top + (r + 1) * cellH, scroll.clientWidth);
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  // A finger that has lifted has left too, so a touch does not close the tooltip; tapping elsewhere does, and so does scrolling.
  svg.addEventListener('pointerleave', (e) => {
    if ((e as PointerEvent).pointerType !== 'touch') hide();
  });

  key.replaceChildren();
  const legend = h(key, 'div', 'bt-legend');
  const item = (cls: string, text: string) => {
    const k = h(legend, 'span', 'bt-key');
    h(k, 'span', `bt-sweep-swatch ${cls}`);
    h(k, 'span', undefined, text);
  };
  item('bt-sweep-swatch-declared', 'Values in the note');
  if (bestAt) item('bt-sweep-swatch-best', 'Best variant');
  const scale = h(legend, 'span', 'bt-key bt-sweep-scale');
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  h(scale, 'span', 'bt-key-value', lo < 0 ? fmtMetric(m, -peak) : fmtMetric(m, 0));
  const ramp = h(scale, 'span', 'bt-sweep-ramp');
  ramp.style.background = `linear-gradient(to right, ${lo < 0 ? `${tint(-peak, peak)}, ` : ''}var(--background-secondary)${hi > 0 ? `, ${tint(peak, peak)}` : ''})`;
  h(scale, 'span', 'bt-key-value', hi > 0 ? fmtMetric(m, peak) : fmtMetric(m, 0));
  const failed =
    (result.points.some((q) => q.error !== null) ? ' × marks values that could not run.' : '') +
    (result.points.some((q) => q.error === null && q.trades === 0) ? ' – marks values that never traded.' : '');
  h(key, 'div', 'bt-note', `${METRICS[m].label} in each cell${format.unit}: blue for gains, red for losses, deeper for larger.${failed}${svgW > width ? ' Scroll sideways for more.' : ''}`);
}

function bestTable(el: HTMLElement, result: SweepResult, sum: SweepSummary): void {
  const m = sum.metric;
  h(el, 'div', 'bt-stats-heading', `The ${Math.min(TABLE_ROWS, sum.ranked.length)} best variants`);
  const wrap = h(el, 'div', 'bt-scroll');
  const table = h(wrap, 'table', 'bt-table');
  const head = h(h(table, 'thead'), 'tr');
  h(head, 'th', 'bt-num', 'Rank');
  for (const p of result.params) h(head, 'th', 'bt-num', p.name);
  h(head, 'th', 'bt-num', METRICS[m].label);
  h(head, 'th', 'bt-num', 'Trades');
  const body = h(table, 'tbody');
  sum.ranked.slice(0, TABLE_ROWS).forEach((q, i) => {
    const row = h(body, 'tr', q === sum.declared ? 'bt-sweep-row-declared' : undefined);
    h(row, 'td', 'bt-num', String(i + 1));
    for (const p of result.params) h(row, 'td', 'bt-num', paramText(p, q.values[p.name]));
    h(row, 'td', 'bt-num', fmtMetric(m, metricOf(q, m, sum.period)));
    h(row, 'td', 'bt-num', String(q.trades));
  });
  if (sum.declaredRank !== null) h(el, 'div', 'bt-note', sum.declaredRank <= TABLE_ROWS ? 'The row in bold holds the values in the note.' : `The values in the note rank ${ordinal(sum.declaredRank)}.`);
}
