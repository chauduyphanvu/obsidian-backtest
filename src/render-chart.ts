// The value chart of a result: the strategy against its benchmark on a log scale, shaded by which of them is ahead, with
// the market's falls, the time the strategy held, and below it how far each was under its previous high. Moving across
// the chart reads out that bar in the line above it; the buttons beside the read-out show the last years only.

import type { Backtest } from './backtest.ts';
import { h, onWidth, s } from './dom.ts';
import { DAY, YEAR, isIntraday, money, moneyTicks, niceStep, pct, stamp, timeTicks } from './format.ts';
import { crisesFor, type Crisis } from './regimes.ts';

/** The shorter spans a chart can show, each offered only when the run is clearly longer. */
const RANGES = [
  { label: '10Y', span: 10 * YEAR },
  { label: '5Y', span: 5 * YEAR },
  { label: '1Y', span: YEAR },
];

/** For ids that are unique across every chart on the page. */
let charts = 0;

export interface ValueChart {
  /** Draws another run of the same block, keeping the span shown. */
  show(bt: Backtest): void;
  stop(): void;
}

interface Key {
  label: HTMLElement;
  value: HTMLElement;
  dd: HTMLElement;
}

function key(parent: HTMLElement, cls: string, label: string): Key {
  const k = h(parent, 'span', 'bt-read-key');
  h(k, 'span', `bt-swatch ${cls}`);
  return { label: h(k, 'span', 'bt-read-label', label), value: h(k, 'span', 'bt-read-value'), dd: h(k, 'span', 'bt-read-dd') };
}

const crisisTimes = (c: Crisis): [number, number] => [Date.parse(`${c.peak}T00:00:00Z`), Date.parse(`${c.trough}T00:00:00Z`) + DAY - 1];

/** The fall a time lies in, if any. */
const fallAt = (falls: Crisis[], time: number): Crisis | undefined =>
  falls.find((c) => {
    const [a, b] = crisisTimes(c);
    return time >= a && time <= b;
  });

/** How far below its previous high a value is, in words. */
const below = (dd: number): string => (!Number.isFinite(dd) ? '' : dd > -0.0005 ? 'at a high' : `${pct(dd)} from its high`);

export function renderValueChart(parent: HTMLElement): ValueChart {
  const box = h(parent, 'div', 'bt-value');
  const read = h(box, 'div', 'bt-read');
  const date = h(read, 'span', 'bt-read-date');
  const mine = key(read, 'bt-swatch-strategy', 'Strategy');
  const theirs = key(read, 'bt-swatch-benchmark', '');
  const state = h(read, 'span', 'bt-read-state');
  const stateMark = h(state, 'span', 'bt-read-held');
  const stateText = h(state, 'span');
  const fall = h(read, 'span', 'bt-read-fall');
  const ranges = h(read, 'div', 'bt-range');
  ranges.setAttribute('role', 'group');
  ranges.setAttribute('aria-label', 'Time shown');
  const chart = h(box, 'div', 'bt-chart');
  const legend = h(box, 'div', 'bt-chart-legend');
  const id = ++charts;

  let bt: Backtest | null = null;
  let span = 0;
  let drawn = 0;

  const draw = () => {
    if (!bt || drawn <= 0) return;
    const total = bt.run.t[bt.run.t.length - 1] - bt.run.t[0];
    const offered = RANGES.filter((r) => r.span < total * 0.85);
    if (!offered.some((r) => r.span === span)) span = 0;
    ranges.replaceChildren();
    ranges.hidden = offered.length === 0;
    for (const r of [{ label: 'All', span: 0 }, ...offered]) {
      const button = h(ranges, 'button', 'bt-range-button', r.label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(r.span === span));
      button.addEventListener('click', () => {
        span = r.span;
        draw();
      });
    }
    drawChart({ chart, legend, width: drawn, bt, span, id, read: { date, mine, theirs, state, stateMark, stateText, fall } });
  };

  const stop = onWidth(chart, (width) => {
    drawn = width;
    draw();
  });
  return {
    show(next) {
      bt = next;
      theirs.label.textContent = next.benchmark.label;
      // While the block is folded the chart has no width; the observer draws it when it opens.
      drawn = Math.floor(chart.clientWidth);
      draw();
    },
    stop,
  };
}

interface Readout {
  date: HTMLElement;
  mine: Key;
  theirs: Key;
  state: HTMLElement;
  stateMark: HTMLElement;
  stateText: HTMLElement;
  fall: HTMLElement;
}

interface DrawInput {
  chart: HTMLElement;
  legend: HTMLElement;
  width: number;
  bt: Backtest;
  /** The last span of time shown, or 0 for the whole run. */
  span: number;
  id: number;
  read: Readout;
}

function drawChart({ chart, legend, width, bt, span, id, read }: DrawInput): void {
  chart.querySelector('svg')?.remove();
  const { run, benchmark, drawdown } = bt;
  const t = run.t;
  const n = t.length;
  const intraday = isIntraday(t);
  const narrow = width < 480;
  const top = 20;
  const eqH = Math.round(Math.min(250, Math.max(150, width * 0.34)));
  const stripTop = top + eqH + 12;
  const stripH = 8;
  const ddTop = stripTop + stripH + 28;
  const ddH = narrow ? 58 : 76;
  const height = ddTop + ddH + 24;

  let from = 0;
  if (span > 0) while (from < n - 2 && t[from] < t[n - 1] - span) from++;
  const ta = t[from];
  const tb = t[n - 1];

  const svg = s(chart, 'svg', { width, height, class: 'bt-svg', role: 'img', 'aria-label': `Value of the strategy and of ${benchmark.label} with the time held and the drawdowns below` });

  // The benchmark has no value (NaN) before its first bar when its prices start later. A ruined run's equity is 0 from
  // the ruin on, which a log scale can't show: its line ends at the last close before.
  const ruined = run.ruin ? run.t.indexOf(run.ruin.t) : n;
  const eq = (i: number) => (i < ruined && run.equity[i] > 0 ? run.equity[i] : NaN);
  const be = (i: number) => (benchmark.equity[i] > 0 ? benchmark.equity[i] : NaN);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = from; i < n; i++) {
    for (const v of [eq(i), be(i)]) {
      if (!Number.isFinite(v)) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  if (!(lo > 0)) [lo, hi] = [1, 2];
  const pad = Math.max(Math.log(hi / lo) * 0.05, 0.01);
  const [l0, l1] = [Math.log(lo) - pad, Math.log(hi) + pad];
  const yLog = (l: number) => top + (1 - (l - l0) / (l1 - l0)) * eqH;
  const yEq = (v: number) => yLog(Math.log(v));
  const ticks = moneyTicks(Math.exp(l0), Math.exp(l1));

  // Room on the left for the axis's widest value, such as "$5,000", and on the right for the last value of each line.
  const wide = (texts: string[], least: number) => Math.max(least, ...texts.map((x) => Math.ceil(12 + x.length * 6.4)));
  const left = wide(ticks.map(money), narrow ? 40 : 44);
  const right = wide([run.equity[n - 1], benchmark.equity[n - 1]].filter((v) => v > 0).map(money), 36);
  const plotW = Math.max(width - left - right, 10);
  const x = (time: number) => left + ((time - ta) / (tb - ta || 1)) * plotW;

  let ddMin = 0;
  for (let i = from; i < n; i++) {
    if (i < ruined) ddMin = Math.min(ddMin, drawdown[i]);
    if (Number.isFinite(benchmark.drawdown[i])) ddMin = Math.min(ddMin, benchmark.drawdown[i]);
  }
  ddMin = Math.min(ddMin, -0.01) * 1.05;
  const yDd = (v: number) => ddTop + (v / ddMin) * ddH;

  // Market falls, under everything else.
  const falls = crisesFor(bt.spec.universe).filter((c) => {
    const [a, b] = crisisTimes(c);
    return b >= ta && a <= tb;
  });
  const placed: [number, number][] = [];
  for (const c of [...falls].sort((p, q) => crisisTimes(q)[1] - crisisTimes(q)[0] - (crisisTimes(p)[1] - crisisTimes(p)[0]))) {
    const [a, b] = crisisTimes(c);
    const xa = x(Math.max(a, ta));
    const xb = Math.max(x(Math.min(b, tb)), xa + 1.5);
    s(svg, 'rect', { x: xa, y: top, width: xb - xa, height: ddTop + ddH - top, class: 'bt-fall-band' });
    // The widest falls are named first, each where its name has room.
    const w = c.name.length * 6 + 4;
    const at = Math.min(xa, left + plotW - w);
    if (at < left || placed.some(([p, q]) => at < q + 10 && at + w > p - 10)) continue;
    placed.push([at, at + w]);
    s(svg, 'text', { x: at, y: top - 7, class: 'bt-axis bt-fall-label' }, c.name);
  }

  const split = bt.spec.testFrom;
  if (split !== null && split > ta && split < tb) {
    s(svg, 'rect', { x: x(split), y: top, width: left + plotW - x(split), height: ddTop + ddH - top, class: 'bt-test-band' });
    s(svg, 'text', { x: x(split) + 5, y: top + 13, class: 'bt-axis bt-test-label' }, 'Test period');
  }

  // Grid and axis labels.
  for (const v of ticks) {
    s(svg, 'line', { x1: left, x2: left + plotW, y1: yEq(v), y2: yEq(v), class: 'bt-grid' });
    s(svg, 'text', { x: left - 7, y: yEq(v) + 3.5, class: 'bt-axis', 'text-anchor': 'end' }, money(v));
  }
  const ddStep = niceStep(-ddMin, 2);
  for (let v = 0; v >= ddMin - 1e-9; v -= ddStep) {
    if (v !== 0) s(svg, 'line', { x1: left, x2: left + plotW, y1: yDd(v), y2: yDd(v), class: 'bt-grid' });
    s(svg, 'text', { x: left - 7, y: yDd(v) + 3.5, class: 'bt-axis', 'text-anchor': 'end' }, pct(v, 0));
  }
  s(svg, 'text', { x: left, y: ddTop - 10, class: 'bt-axis bt-panel-label' }, 'Below the previous high');
  for (const tick of timeTicks(ta, tb, plotW)) {
    s(svg, 'text', { x: x(tick.t), y: height - 6, class: 'bt-axis', 'text-anchor': 'middle' }, tick.label);
    s(svg, 'line', { x1: x(tick.t), x2: x(tick.t), y1: ddTop + ddH, y2: ddTop + ddH + 4, class: 'bt-baseline' });
  }

  // About two points per pixel is all a line can show.
  const stride = Math.max(1, Math.floor((n - from) / (plotW * 2)));
  /** The indexes a line is drawn through, from `start` to before `end`, with the last one always in. */
  const steps = (start: number, end: number): number[] => {
    const out: number[] = [];
    for (let i = start; i < end; i += stride) out.push(i);
    if (out.length && out[out.length - 1] !== end - 1) out.push(end - 1);
    return out;
  };
  const p = (px: number, py: number) => `${px.toFixed(1)},${py.toFixed(1)}`;
  // A line starts at its first known value, and ends before `end`.
  const path = (value: (i: number) => number, y: (v: number) => number, end = n) => {
    let first = from;
    while (first < end && !Number.isFinite(value(first))) first++;
    return steps(first, end)
      .map((i, k) => `${k ? 'L' : 'M'}${p(x(t[i]), y(value(i)))}`)
      .join('');
  };

  // Which line is ahead: the space between them, split where they cross.
  let ahead = '';
  let behind = '';
  let top1: string[] = [];
  let bot1: string[] = [];
  let sign = 0;
  const close = () => {
    if (top1.length > 1) {
      const d = `M${top1.join('L')}L${bot1.reverse().join('L')}Z`;
      if (sign > 0) ahead += d;
      else if (sign < 0) behind += d;
    }
    top1 = [];
    bot1 = [];
  };
  let prev = -1;
  for (const i of steps(from, n)) {
    const [a, b] = [eq(i), be(i)];
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      close();
      prev = -1;
      continue;
    }
    const gap = Math.log(a / b);
    const sg = gap > 1e-4 ? 1 : gap < -1e-4 ? -1 : 0;
    if (prev >= 0 && sg !== 0 && sign !== 0 && sg !== sign) {
      const g0 = Math.log(eq(prev) / be(prev));
      const f = g0 / (g0 - gap);
      const cp = p(x(t[prev] + f * (t[i] - t[prev])), yLog(Math.log(eq(prev)) + f * (Math.log(a) - Math.log(eq(prev)))));
      top1.push(cp);
      bot1.push(cp);
      close();
      top1.push(cp);
      bot1.push(cp);
    }
    if (sg !== 0) sign = sg;
    top1.push(p(x(t[i]), yEq(a)));
    bot1.push(p(x(t[i]), yEq(b)));
    prev = i;
  }
  close();
  if (ahead) s(svg, 'path', { d: ahead, class: 'bt-ahead' });
  if (behind) s(svg, 'path', { d: behind, class: 'bt-behind' });

  s(svg, 'path', { d: path(be, yEq), class: 'bt-line bt-line-benchmark' });
  s(svg, 'path', { d: path(eq, yEq, ruined), class: 'bt-line bt-line-strategy' });

  // The time held: a bar for each stretch at one level, lighter when only partly invested, hatched when short.
  const net = run.netExposure;
  const kind = (i: number): string => {
    const e = run.exposure[i] ?? 0;
    if (!(e > 1e-9) || i >= ruined) return '';
    if (net && net[i] < 0) return 'short';
    return e < 0.995 ? 'part' : 'full';
  };
  const strip: Record<string, string> = { full: '', part: '', short: '' };
  for (let i = from; i < n; ) {
    const k = kind(i);
    let j = i;
    while (j + 1 < n && kind(j + 1) === k) j++;
    if (k) {
      const xa = x(t[i]);
      const xb = Math.max(j + 1 < n ? x(t[j + 1]) : left + plotW, xa + 1);
      strip[k] += `M${p(xa, stripTop)}H${xb.toFixed(1)}V${stripTop + stripH}H${xa.toFixed(1)}Z`;
    }
    i = j + 1;
  }
  s(svg, 'rect', { x: left, y: stripTop, width: plotW, height: stripH, rx: 2, class: 'bt-strip-bg' });
  if (strip.short) {
    const pattern = s(s(svg, 'defs', {}), 'pattern', { id: `bt-hatch-${id}`, width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    s(pattern, 'rect', { width: 2, height: 4, class: 'bt-hatch' });
    s(svg, 'path', { d: strip.short, class: 'bt-strip-short', fill: `url(#bt-hatch-${id})` });
  }
  if (strip.part) s(svg, 'path', { d: strip.part, class: 'bt-strip bt-strip-part' });
  if (strip.full) s(svg, 'path', { d: strip.full, class: 'bt-strip' });
  s(svg, 'text', { x: left - 7, y: stripTop + stripH / 2 + 3.5, class: 'bt-axis', 'text-anchor': 'end' }, 'Held');

  const ddPath = path((i) => drawdown[i], yDd, ruined);
  const ddEnd = Math.max(from, ruined - 1);
  s(svg, 'line', { x1: left, x2: left + plotW, y1: yDd(0), y2: yDd(0), class: 'bt-baseline' });
  if (ddPath) s(svg, 'path', { d: `${ddPath}L${p(x(t[ddEnd]), yDd(0))}L${p(x(ta), yDd(0))}Z`, class: 'bt-area-strategy' });
  s(svg, 'path', { d: path((i) => benchmark.drawdown[i], yDd), class: 'bt-line bt-line-benchmark bt-line-thin' });
  s(svg, 'path', { d: ddPath, class: 'bt-line bt-line-strategy bt-line-thin' });

  // The worst fall of each, named where it happened.
  const worst = (dd: (i: number) => number, end: number): number => {
    let at = -1;
    for (let i = from; i < end; i++) if (Number.isFinite(dd(i)) && dd(i) < -0.0005 && (at < 0 || dd(i) < dd(at))) at = i;
    return at;
  };
  const callouts: { i: number; v: number; cls: string }[] = [];
  const ws = worst((i) => drawdown[i], ruined);
  const wb = worst((i) => benchmark.drawdown[i], n);
  if (wb >= 0) callouts.push({ i: wb, v: benchmark.drawdown[wb], cls: 'benchmark' });
  if (ws >= 0) callouts.push({ i: ws, v: drawdown[ws], cls: 'strategy' });
  // Each label goes beside its point where it covers no other label or point and stays inside the plot: right, left,
  // above, below. A spot pushed up from below the panel is checked where it ends up, above the time axis.
  const points = callouts.map((c) => [x(t[c.i]), yDd(c.v)]);
  const boxes: [number, number, number][] = [];
  const low = ddTop + ddH + 1;
  for (const [k, c] of callouts.entries()) {
    const [cx, cy] = points[k];
    s(svg, 'circle', { cx, cy, r: 3, class: `bt-dot bt-dot-${c.cls}` });
    const text = pct(c.v);
    const w = text.length * 6.2;
    const spots = ([[cx + 7, cy], [cx - 7 - w, cy], [cx + 7, cy - 15], [cx - 7 - w, cy - 15], [cx + 7, cy + 15], [cx - 7 - w, cy + 15], [cx + 7, cy - 30], [cx - 7 - w, cy - 30]] as [number, number][]).map(([sx, sy]): [number, number] => [sx, Math.min(sy, low)]);
    const clear = ([lx, ly]: [number, number]) =>
      lx >= left &&
      lx + w <= left + plotW + right &&
      !boxes.some(([bx, by, bw]) => lx < bx + bw + 4 && lx + w + 4 > bx && Math.abs(ly - by) < 12) &&
      !points.some(([dx, dy], j) => j !== k && dx > lx - 5 && dx < lx + w + 5 && Math.abs(dy - ly) < 9);
    const [lx, ly] = spots.find(clear) ?? spots[0];
    boxes.push([lx, ly, w]);
    s(svg, 'text', { x: lx, y: ly + 4, class: 'bt-axis bt-callout' }, text);
  }

  // The last value of each, at the end of its line.
  const ends: { y: number; v: number; cls: string }[] = [];
  const lastS = ruined === n ? n - 1 : -1;
  if (lastS >= 0 && Number.isFinite(eq(lastS))) ends.push({ y: yEq(eq(lastS)), v: eq(lastS), cls: 'strategy' });
  if (Number.isFinite(be(n - 1))) ends.push({ y: yEq(be(n - 1)), v: be(n - 1), cls: 'benchmark' });
  if (ends.length === 2 && Math.abs(ends[0].y - ends[1].y) < 13) {
    const mid = (ends[0].y + ends[1].y) / 2;
    const up = ends[0].y <= ends[1].y ? 0 : 1;
    ends[up].y = mid - 6.5;
    ends[1 - up].y = mid + 6.5;
  }
  for (const e of ends) {
    s(svg, 'circle', { cx: left + plotW, cy: yEq(e.v), r: 3, class: `bt-dot bt-dot-${e.cls}` });
    s(svg, 'text', { x: left + plotW + 7, y: e.y + 3.5, class: 'bt-axis bt-end-label' }, money(e.v));
  }

  // Moving across the chart: one line through both panels, a dot on each line, and the read-out above.
  const cross = s(svg, 'line', { y1: top, y2: ddTop + ddH, class: 'bt-cross', visibility: 'hidden' });
  const dots = (['benchmark', 'strategy', 'benchmark', 'strategy'] as const).map((cls, k) => s(svg, 'circle', { r: k < 2 ? 4.5 : 3.5, class: `bt-dot bt-dot-${cls}`, visibility: 'hidden' }));
  const hit = s(svg, 'rect', { x: left, y: top, width: plotW, height: ddTop + ddH - top, fill: 'transparent' });

  const readAt = (i: number, live: boolean) => {
    const at = Math.min(i, n - 1);
    read.date.textContent = live ? stamp(t[at], intraday) : `${stamp(t[at], intraday)} · last bar`;
    const gone = at >= ruined;
    read.mine.value.textContent = gone ? 'ruined' : money(run.equity[at]);
    read.mine.dd.textContent = gone ? '' : below(drawdown[at]);
    read.theirs.value.textContent = Number.isFinite(be(at)) ? money(be(at)) : '–';
    read.theirs.dd.textContent = Number.isFinite(be(at)) ? below(benchmark.drawdown[at]) : '';
    const e = gone ? 0 : (run.exposure[at] ?? 0);
    read.stateText.textContent = run.netExposure ? `Exposure ${pct(e, 0)} gross, net ${pct(gone ? 0 : run.netExposure[at], 0)}` : e > 1e-9 ? `${pct(e, 0)} invested` : 'In cash';
    read.stateMark.className = `bt-read-held${e > 1e-9 ? (run.netExposure && run.netExposure[at] < 0 ? ' bt-read-short' : ' bt-read-in') : ''}`;
    const f = fallAt(falls, t[at]);
    read.fall.textContent = f ? f.name : '';
    read.fall.hidden = !f;
  };
  const hide = () => {
    for (const el of [cross, ...dots]) el.setAttribute('visibility', 'hidden');
    readAt(n - 1, false);
  };
  const show = (clientX: number) => {
    const box = svg.getBoundingClientRect();
    const time = ta + ((clientX - box.left - left) / plotW) * (tb - ta);
    let a = from;
    let b = n - 1;
    while (b - a > 1) {
      const mid = (a + b) >> 1;
      if (t[mid] <= time) a = mid;
      else b = mid;
    }
    const i = time - t[a] <= t[b] - time ? a : b;
    const px = String(x(t[i]));
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    cross.setAttribute('visibility', 'visible');
    const at = [be(i), eq(i), benchmark.drawdown[i], i < ruined ? drawdown[i] : NaN];
    dots.forEach((dot, k) => {
      const v = at[k];
      dot.setAttribute('cx', px);
      dot.setAttribute('cy', String(Number.isFinite(v) ? (k < 2 ? yEq(v) : yDd(v)) : 0));
      dot.setAttribute('visibility', Number.isFinite(v) ? 'visible' : 'hidden');
    });
    readAt(i, true);
  };
  hit.addEventListener('pointermove', (e) => show((e as PointerEvent).clientX));
  hit.addEventListener('pointerdown', (e) => show((e as PointerEvent).clientX));
  hit.addEventListener('pointerleave', hide);
  hide();

  legend.replaceChildren();
  const item = (cls: string, text: string) => {
    const k = h(legend, 'span', 'bt-chart-key');
    h(k, 'span', `bt-chart-swatch ${cls}`);
    h(k, 'span', undefined, text);
  };
  if (ahead) item('bt-chart-swatch-ahead', 'Strategy better');
  if (behind) item('bt-chart-swatch-behind', `${benchmark.label} better`);
  if (falls.length) item('bt-chart-swatch-fall', 'Market drawdowns');
  if (strip.full || strip.part) item('bt-chart-swatch-held', strip.short ? 'Held long' : 'Held');
  if (strip.short) item('bt-chart-swatch-short', 'Held short');
  h(legend, 'span', 'bt-chart-note', 'Value on a log scale');
}

/** A small line of the strategy against its benchmark, for the folded result: no axes, both on one log scale. */
export function sparkline(parent: HTMLElement, bt: Backtest, width = 96, height = 24): void {
  const { run, benchmark } = bt;
  const n = run.t.length;
  const ruined = run.ruin ? run.t.indexOf(run.ruin.t) : n;
  // A loop, not Math.min(...): a long intraday run has more values than a call takes arguments.
  let [least, most] = [Infinity, 0];
  for (const [series, end] of [[run.equity, ruined], [benchmark.equity, n]] as const) {
    for (let i = 0; i < end; i++) {
      const v = series[i];
      if (!(v > 0)) continue;
      if (v < least) least = v;
      if (v > most) most = v;
    }
  }
  if (n < 2 || most === 0) return;
  const lo = Math.log(least);
  const hi = Math.log(most);
  const span = hi - lo || 1;
  const k = Math.max(1, Math.floor(n / (width * 1.5)));
  const line = (series: number[], end: number) => {
    let d = '';
    for (let i = 0; i < end; i += k) {
      const v = series[i];
      if (!(v > 0)) continue;
      d += `${d ? 'L' : 'M'}${((i / (n - 1)) * (width - 2) + 1).toFixed(1)},${(2 + (1 - (Math.log(v) - lo) / span) * (height - 4)).toFixed(1)}`;
    }
    const last = series[end - 1];
    if (d && last > 0) d += `L${(((end - 1) / (n - 1)) * (width - 2) + 1).toFixed(1)},${(2 + (1 - (Math.log(last) - lo) / span) * (height - 4)).toFixed(1)}`;
    return d;
  };
  const svg = s(h(parent, 'span', 'bt-spark'), 'svg', { width, height, class: 'bt-svg', role: 'img', 'aria-label': `Value of the strategy and of ${benchmark.label}` });
  const b = line(benchmark.equity, n);
  if (b) s(svg, 'path', { d: b, class: 'bt-line bt-line-benchmark bt-spark-line' });
  const m = line(run.equity, ruined);
  if (m) s(svg, 'path', { d: m, class: 'bt-line bt-line-strategy bt-spark-line' });
}
