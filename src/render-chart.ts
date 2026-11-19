// The value chart of a result: the strategy against its benchmark on a log scale, shaded by which of them is ahead, with
// the market's falls, the time the strategy held, and below it how far each was under its previous high. Moving across
// the chart reads out that bar in the line above it; the buttons beside the read-out show the last years only.

import type { Backtest } from './backtest.ts';
import { h, motionOK, onWidth, s, tween } from './dom.ts';
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
  /**
   * Draws another run of the same block, keeping the span shown. `ghost` is the block's run as written, drawn as a dashed
   * line while a slider shows other values; `arrive` draws the lines in once, for a new result.
   */
  show(bt: Backtest, opts?: { ghost?: Backtest | null; arrive?: boolean }): void;
  /** The span of time shown, or 0 for the whole run. */
  span(): number;
  /** Lights up the part of the chart a figure comes from: 'end', 'dd', 'vol', 'held', or null for none. */
  highlight(part: string | null): void;
  stop(): void;
}

interface Key {
  value: HTMLElement;
  dd: HTMLElement;
}

function key(parent: HTMLElement, cls: string, label: string): Key & { label: HTMLElement } {
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

/** How far below its previous high a value is; the panel under the chart says what the number is. */
const below = (dd: number): string => (!Number.isFinite(dd) ? '' : dd > -0.0005 ? 'at a high' : pct(dd));

/** How long a change of the span takes. */
const RANGE_MS = 420;
/** How long the arrival of a new result's lines takes, and a margin after it. */
const ARRIVE_MS = 1700;

export function renderValueChart(parent: HTMLElement, o: { span?: number } = {}): ValueChart {
  const box = h(parent, 'div', 'bt-value');
  const read = h(box, 'div', 'bt-read');
  const row1 = h(read, 'div', 'bt-read-row');
  const when = h(row1, 'span', 'bt-read-when');
  const date = h(when, 'span', 'bt-read-date');
  const fall = h(when, 'span', 'bt-read-fall');
  const ranges = h(row1, 'div', 'bt-range');
  ranges.setAttribute('role', 'group');
  ranges.setAttribute('aria-label', 'Time shown');
  const thumb = h(ranges, 'span', 'bt-range-thumb');
  thumb.setAttribute('aria-hidden', 'true');
  const row2 = h(read, 'div', 'bt-read-row bt-read-values');
  const mine = key(row2, 'bt-swatch-strategy', 'Strategy');
  const ghostKey = key(row2, 'bt-swatch-ghost', 'As written');
  ghostKey.label.parentElement!.hidden = true;
  const theirs = key(row2, 'bt-swatch-benchmark', '');
  const state = h(row2, 'span', 'bt-read-state');
  const stateMark = h(state, 'span', 'bt-read-held');
  const stateText = h(state, 'span');
  const chart = h(box, 'div', 'bt-chart');
  const legend = h(box, 'div', 'bt-chart-legend');
  const id = ++charts;

  let bt: Backtest | null = null;
  let ghost: Backtest | null = null;
  let span = o.span ?? 0;
  let width = 0;
  let drawnWidth = 0;
  let part: string | null = null;
  let arriving = false;
  let stopTween = () => {};
  let offered: number[] = [];
  const buttons = new Map<number, HTMLButtonElement>();

  const placeThumb = () => {
    const on = buttons.get(span);
    if (!on || !(on.offsetWidth > 0)) return;
    thumb.style.setProperty('width', `${on.offsetWidth}px`);
    thumb.style.setProperty('transform', `translateX(${on.offsetLeft - 2}px)`);
  };
  // The buttons are made again only when the spans on offer change, so focus stays and the thumb can slide.
  const buildRanges = (total: number) => {
    const now = RANGES.filter((r) => r.span < total * 0.85).map((r) => r.span);
    if (!now.includes(span)) span = 0;
    ranges.hidden = now.length === 0;
    if (now.join() !== offered.join() || buttons.size === 0) {
      offered = now;
      for (const b of buttons.values()) b.remove();
      buttons.clear();
      for (const r of [{ label: 'All', span: 0 }, ...RANGES.filter((x) => now.includes(x.span))]) {
        const button = h(ranges, 'button', 'bt-range-button', r.label);
        button.type = 'button';
        buttons.set(r.span, button);
        button.addEventListener('click', () => {
          if (r.span === span) return;
          const was = last;
          span = r.span;
          press();
          change(was);
        });
      }
    }
    press();
  };
  const press = () => {
    for (const [k, b] of buttons) b.setAttribute('aria-pressed', String(k === span));
    window.requestAnimationFrame(placeThumb);
  };

  const readout = { date, fall, mine, ghost: ghostKey, theirs, state, stateMark, stateText };
  /** The mapping of the drawing on screen. */
  let last: Drawn | null = null;
  const draw = (o2: { from?: number; arrive?: boolean; settled?: boolean } = {}) => {
    if (!bt || width <= 0) return null;
    drawnWidth = width;
    const drawn = drawChart({ chart, legend, width, bt, ghost, span, from: o2.from, id, read: readout });
    const svg = chart.querySelector('svg');
    if (svg && part) svg.setAttribute('data-bt-hl', part);
    if (svg && (o2.arrive || arriving) && motionOK()) svg.classList.add('bt-arrive');
    if (svg && o2.settled) svg.classList.add('bt-zoomed');
    last = drawn;
    return drawn;
  };

  // A new span eases in: the target is drawn once with the run from the earlier of the two starts, its panels moved by a
  // transform from where the old span put them back to their place, and then drawn again as it is.
  const change = (before: Drawn | null) => {
    stopTween();
    if (!bt || width <= 0) return;
    if (!before || before.plotW <= 0 || !motionOK()) {
      draw();
      return;
    }
    const t = bt.run.t;
    const startOf = (sp: number) => (sp > 0 ? Math.max(t[0], t[t.length - 1] - sp) : t[0]);
    const old = { ta: before.ta, tb: before.tb };
    const after = draw({ from: Math.min(old.ta, startOf(span)) });
    const svg = chart.querySelector('svg');
    if (!after || !svg) return;
    // From the new mapping back to the old one: x is linear in time, and each panel's y linear in its own value.
    const sx = ((after.tb - after.ta) / (old.tb - old.ta)) * (before.plotW / after.plotW);
    const tx = before.left + ((after.ta - old.ta) / (old.tb - old.ta)) * before.plotW - after.left * sx;
    const panels = [
      { g: svg.querySelector('.bt-l-val'), y: (v: number) => before.yLog(v), y2: (v: number) => after.yLog(v), at: [after.logLo, after.logHi] },
      { g: svg.querySelector('.bt-l-dd'), y: (v: number) => before.yDd(v), y2: (v: number) => after.yDd(v), at: [0, after.ddMin] },
      { g: svg.querySelector('.bt-l-held'), y: (v: number) => v, y2: (v: number) => v, at: [0, 1] },
      { g: svg.querySelector('.bt-l-bands'), y: (v: number) => v, y2: (v: number) => v, at: [0, 1] },
    ];
    const start = panels.map((p) => {
      const [a, b] = p.at;
      const [n0, n1] = [p.y2(a), p.y2(b)];
      const sy = n1 === n0 ? 1 : (p.y(b) - p.y(a)) / (n1 - n0);
      return { g: p.g as SVGGElement | null, sy, ty: p.y(a) - n0 * sy };
    });
    svg.classList.add('bt-zooming');
    stopTween = tween(RANGE_MS, (k) => {
      for (const p of start) {
        if (!p.g) continue;
        const [a, d, e, f] = [sx + (1 - sx) * k, p.sy + (1 - p.sy) * k, tx * (1 - k), p.ty * (1 - k)];
        p.g.setAttribute('transform', `matrix(${a.toFixed(5)},0,0,${d.toFixed(5)},${e.toFixed(2)},${f.toFixed(2)})`);
      }
      if (k >= 1) draw({ settled: true });
    });
  };

  const stop = onWidth(chart, (w) => {
    width = w;
    // The first notice of a width already drawn would draw it again and cut short a new result's arrival.
    if (w !== drawnWidth) draw();
  });
  return {
    show(next, opts = {}) {
      stopTween();
      bt = next;
      ghost = opts.ghost && opts.ghost !== next ? opts.ghost : null;
      theirs.label.textContent = next.benchmark.label;
      ghostKey.label.parentElement!.hidden = !ghost;
      buildRanges(next.run.t[next.run.t.length - 1] - next.run.t[0]);
      // While the block is folded the chart has no width; the observer draws it when it opens.
      width = Math.floor(chart.clientWidth);
      if (opts.arrive && motionOK()) {
        arriving = true;
        window.setTimeout(() => {
          arriving = false;
          chart.querySelector('svg')?.classList.remove('bt-arrive');
        }, ARRIVE_MS);
      }
      draw({ arrive: opts.arrive });
    },
    span: () => span,
    highlight(next) {
      part = next;
      const svg = chart.querySelector('svg');
      if (!svg) return;
      if (next) svg.setAttribute('data-bt-hl', next);
      else svg.removeAttribute('data-bt-hl');
    },
    stop: () => {
      stopTween();
      stop();
    },
  };
}

interface Readout {
  date: HTMLElement;
  fall: HTMLElement;
  mine: Key;
  ghost: Key;
  theirs: Key;
  state: HTMLElement;
  stateMark: HTMLElement;
  stateText: HTMLElement;
}

interface DrawInput {
  chart: HTMLElement;
  legend: HTMLElement;
  width: number;
  bt: Backtest;
  /** The run as written, as a dashed line, or null. */
  ghost: Backtest | null;
  /** The last span of time shown, or 0 for the whole run. */
  span: number;
  /** Draws the run from this time on, even before the span starts (for the eased change of the span). */
  from?: number;
  id: number;
  read: Readout;
}

/** The mapping a drawing used, so a change of span can move one drawing to where another put the same things. */
interface Drawn {
  ta: number;
  tb: number;
  left: number;
  plotW: number;
  logLo: number;
  logHi: number;
  ddMin: number;
  yLog: (l: number) => number;
  yDd: (v: number) => number;
}

function drawChart({ chart, legend, width, bt, ghost, span, from: drawFrom, id, read }: DrawInput): Drawn {
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
  // What is drawn may start before what is shown: the panels are clipped to the plot.
  let first = from;
  if (drawFrom !== undefined) while (first > 0 && t[first - 1] >= drawFrom) first--;

  const svg = s(chart, 'svg', { width, height, class: 'bt-svg', role: 'img', 'aria-label': `Value of the strategy and of ${benchmark.label} with the time held and the drawdowns below` });

  // The benchmark has no value (NaN) before its first bar when its prices start later. A ruined run's equity is 0 from
  // the ruin on, which a log scale can't show: its line ends at the last close before.
  const ruined = run.ruin ? run.t.indexOf(run.ruin.t) : n;
  const eq = (i: number) => (i < ruined && run.equity[i] > 0 ? run.equity[i] : NaN);
  const be = (i: number) => (benchmark.equity[i] > 0 ? benchmark.equity[i] : NaN);
  // The run as written, while a slider shows other values; it shares the bars of the run on screen when its prices do.
  const ghostOn = ghost && ghost.run.t.length === n && ghost.run.t[0] === t[0] ? ghost : null;
  const gh = (i: number) => (ghostOn && ghostOn.run.equity[i] > 0 ? ghostOn.run.equity[i] : NaN);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = from; i < n; i++) {
    for (const v of [eq(i), be(i), gh(i)]) {
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

  const clip = s(s(svg, 'defs', {}), 'clipPath', { id: `bt-plot-${id}` });
  s(clip, 'rect', { x: left, y: 0, width: plotW, height });
  const layer = (cls: string, clipped = true) => s(s(svg, 'g', clipped ? { 'clip-path': `url(#bt-plot-${id})` } : {}), 'g', { class: cls });
  const labels = s(svg, 'g', { class: 'bt-l-labels' });

  // Market falls, under everything else.
  const bands = layer('bt-l-bands');
  const falls = crisesFor(bt.spec.universe).filter((c) => {
    const [a, b] = crisisTimes(c);
    return b >= ta && a <= tb;
  });
  const shownFalls = crisesFor(bt.spec.universe).filter((c) => {
    const [a, b] = crisisTimes(c);
    return b >= t[first] && a <= tb;
  });
  for (const c of shownFalls) {
    const [a, b] = crisisTimes(c);
    const xa = x(Math.max(a, t[first]));
    const xb = Math.max(x(Math.min(b, tb)), xa + 1.5);
    s(bands, 'rect', { x: xa, y: top, width: xb - xa, height: ddTop + ddH - top, class: 'bt-fall-band' });
  }
  const placed: [number, number][] = [];
  for (const c of [...falls].sort((p, q) => crisisTimes(q)[1] - crisisTimes(q)[0] - (crisisTimes(p)[1] - crisisTimes(p)[0]))) {
    const [a] = crisisTimes(c);
    // The widest falls are named first, each where its name has room.
    const w = c.name.length * 6 + 4;
    const at = Math.min(x(Math.max(a, ta)), left + plotW - w);
    if (at < left || placed.some(([p, q]) => at < q + 10 && at + w > p - 10)) continue;
    placed.push([at, at + w]);
    s(labels, 'text', { x: at, y: top - 7, class: 'bt-axis bt-fall-label' }, c.name);
  }

  const split = bt.spec.testFrom;
  if (split !== null && split > ta && split < tb) {
    s(bands, 'rect', { x: x(split), y: top, width: left + plotW - x(split), height: ddTop + ddH - top, class: 'bt-test-band' });
    s(labels, 'text', { x: x(split) + 5, y: top + 13, class: 'bt-axis bt-test-label' }, 'Test period');
  }

  // Grid and axis labels.
  const grid = s(svg, 'g', { class: 'bt-l-grid' });
  for (const v of ticks) {
    s(grid, 'line', { x1: left, x2: left + plotW, y1: yEq(v), y2: yEq(v), class: 'bt-grid' });
    s(grid, 'text', { x: left - 7, y: yEq(v) + 3.5, class: 'bt-axis', 'text-anchor': 'end' }, money(v));
  }
  const ddStep = niceStep(-ddMin, 2);
  for (let v = 0; v >= ddMin - 1e-9; v -= ddStep) {
    if (v !== 0) s(grid, 'line', { x1: left, x2: left + plotW, y1: yDd(v), y2: yDd(v), class: 'bt-grid' });
    s(grid, 'text', { x: left - 7, y: yDd(v) + 3.5, class: 'bt-axis', 'text-anchor': 'end' }, pct(v, 0));
  }
  s(grid, 'text', { x: left, y: ddTop - 10, class: 'bt-axis bt-panel-label' }, 'Below the previous high');
  for (const tick of timeTicks(ta, tb, plotW)) {
    s(grid, 'text', { x: x(tick.t), y: height - 6, class: 'bt-axis', 'text-anchor': 'middle' }, tick.label);
    s(grid, 'line', { x1: x(tick.t), x2: x(tick.t), y1: ddTop + ddH, y2: ddTop + ddH + 4, class: 'bt-baseline' });
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
    let start = first;
    while (start < end && !Number.isFinite(value(start))) start++;
    return steps(start, end)
      .map((i, k) => `${k ? 'L' : 'M'}${p(x(t[i]), y(value(i)))}`)
      .join('');
  };

  // Which line is ahead: the space between them, split where they cross.
  const val = layer('bt-l-val');
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
  for (const i of steps(first, n)) {
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
  const fills = s(val, 'g', { class: 'bt-fills' });
  if (ahead) s(fills, 'path', { d: ahead, class: 'bt-ahead' });
  if (behind) s(fills, 'path', { d: behind, class: 'bt-behind' });

  if (ghostOn) s(val, 'path', { d: path(gh, yEq), class: 'bt-line bt-line-ghost' });
  s(val, 'path', { d: path(be, yEq), class: 'bt-line bt-line-benchmark', pathLength: 1 });
  s(val, 'path', { d: path(eq, yEq, ruined), class: 'bt-line bt-line-strategy', pathLength: 1 });

  // The largest gaps named on the chart, away from both ends, where the two lines stay far enough apart for the whole
  // width of the word: the place is the one whose narrowest gap under the word is the widest.
  const tags = s(svg, 'g', { class: 'bt-l-tags' });
  const lastBar = Math.min(ruined, n) - 1;
  for (const [sign2, cls, text] of [
    [1, 'bt-tag-ahead', 'Strategy ahead'],
    [-1, 'bt-tag-behind', `${benchmark.label} ahead`],
  ] as const) {
    const w = text.length * 5.8 + 8;
    let best = { room: 15, x: 0, y: 0 };
    const look = steps(from + Math.round((n - from) * 0.04), Math.max(from + 1, lastBar - Math.round((n - from) * 0.04)));
    for (const i of look) {
      const cx = x(t[i]);
      if (cx - w / 2 < left || cx + w / 2 > left + plotW) continue;
      // The narrowest gap, in pixels and on the right side, under the word's width.
      let room = Infinity;
      let mid = 0;
      for (let j = i; j >= from && x(t[j]) >= cx - w / 2; j -= stride) room = Math.min(room, sign2 * (yEq(be(j)) - yEq(eq(j))));
      for (let j = i; j <= lastBar && x(t[j]) <= cx + w / 2; j += stride) room = Math.min(room, sign2 * (yEq(be(j)) - yEq(eq(j))));
      if (!(room > best.room)) continue;
      mid = (yEq(be(i)) + yEq(eq(i))) / 2;
      best = { room, x: cx, y: mid };
    }
    if (best.x > 0) s(tags, 'text', { x: best.x, y: best.y + 3.5, 'text-anchor': 'middle', class: `bt-axis bt-tag ${cls}` }, text);
  }

  // The time held: a bar for each stretch at one level, lighter when only partly invested, hatched when short.
  const held = layer('bt-l-held');
  const net = run.netExposure;
  const kind = (i: number): string => {
    const e = run.exposure[i] ?? 0;
    if (!(e > 1e-9) || i >= ruined) return '';
    if (net && net[i] < 0) return 'short';
    return e < 0.995 ? 'part' : 'full';
  };
  const strip: Record<string, string> = { full: '', part: '', short: '' };
  for (let i = first; i < n; ) {
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
  s(held, 'rect', { x: Math.min(left, x(t[first])), y: stripTop, width: Math.max(plotW, left + plotW - x(t[first])), height: stripH, rx: 2, class: 'bt-strip-bg' });
  if (strip.short) {
    const pattern = s(s(svg, 'defs', {}), 'pattern', { id: `bt-hatch-${id}`, width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    s(pattern, 'rect', { width: 2, height: 4, class: 'bt-hatch' });
    s(held, 'path', { d: strip.short, class: 'bt-strip-short', fill: `url(#bt-hatch-${id})` });
  }
  if (strip.part) s(held, 'path', { d: strip.part, class: 'bt-strip bt-strip-part' });
  if (strip.full) s(held, 'path', { d: strip.full, class: 'bt-strip' });
  s(grid, 'text', { x: left - 7, y: stripTop + stripH / 2 + 3.5, class: 'bt-axis', 'text-anchor': 'end' }, 'Held');

  const dd = layer('bt-l-dd');
  const ddPath = path((i) => drawdown[i], yDd, ruined);
  const ddEnd = Math.max(first, ruined - 1);
  s(dd, 'line', { x1: Math.min(left, x(t[first])), x2: left + plotW, y1: yDd(0), y2: yDd(0), class: 'bt-baseline' });
  if (ddPath) s(dd, 'path', { d: `${ddPath}L${p(x(t[ddEnd]), yDd(0))}L${p(x(t[first]), yDd(0))}Z`, class: 'bt-area-strategy' });
  s(dd, 'path', { d: path((i) => benchmark.drawdown[i], yDd), class: 'bt-line bt-line-benchmark bt-line-thin', pathLength: 1 });
  s(dd, 'path', { d: ddPath, class: 'bt-line bt-line-strategy bt-line-thin', pathLength: 1 });

  // The worst fall of each, named where it happened.
  const calls = s(svg, 'g', { class: 'bt-l-call' });
  const worst = (dd2: (i: number) => number, end: number): number => {
    let at = -1;
    for (let i = from; i < end; i++) if (Number.isFinite(dd2(i)) && dd2(i) < -0.0005 && (at < 0 || dd2(i) < dd2(at))) at = i;
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
    s(calls, 'circle', { cx, cy, r: 7, class: `bt-ping bt-ping-${c.cls}` });
    s(calls, 'circle', { cx, cy, r: 3, class: `bt-dot bt-dot-${c.cls}` });
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
    s(calls, 'text', { x: lx, y: ly + 4, class: 'bt-axis bt-callout' }, text);
  }

  // The last value of each, at the end of its line.
  const endsG = s(svg, 'g', { class: 'bt-l-end' });
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
    s(endsG, 'circle', { cx: left + plotW, cy: yEq(e.v), r: 3, class: `bt-dot bt-dot-${e.cls}` });
    s(endsG, 'text', { x: left + plotW + 7, y: e.y + 3.5, class: 'bt-axis bt-end-label' }, money(e.v));
  }

  // Moving across the chart: one line through both panels, a dot on each line, and the read-out above. None of it eases:
  // reading must be instant.
  const cross = s(svg, 'line', { y1: top, y2: ddTop + ddH, class: 'bt-cross', visibility: 'hidden' });
  const dots = (['benchmark', 'strategy', 'benchmark', 'strategy'] as const).map((cls, k) => s(svg, 'circle', { r: k < 2 ? 4.5 : 3.5, class: `bt-dot bt-dot-${cls} bt-hover-dot`, visibility: 'hidden' }));
  const hit = s(svg, 'rect', { x: left, y: top, width: plotW, height: ddTop + ddH - top, fill: 'transparent' });

  const readAt = (i: number, live: boolean) => {
    const at = Math.min(i, n - 1);
    read.date.textContent = live ? stamp(t[at], intraday) : `${stamp(t[at], intraday)} · last bar`;
    const gone = at >= ruined;
    read.mine.value.textContent = gone ? 'ruined' : money(run.equity[at]);
    read.mine.dd.textContent = gone ? '' : below(drawdown[at]);
    read.ghost.value.textContent = Number.isFinite(gh(at)) ? money(gh(at)) : '–';
    read.ghost.dd.textContent = ghostOn && Number.isFinite(gh(at)) ? below(ghostOn.drawdown[at]) : '';
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

  // The key is on the chart: the gaps, the falls and the strip are named where they are. The line under it says what the
  // shading is, and keys only the hatching of a short, which has no room for a word.
  legend.replaceChildren();
  h(legend, 'span', 'bt-chart-note', falls.length ? 'Shading: the gap between the two lines, and the large market drawdowns' : 'Shading: the gap between the two lines');
  if (strip.short) {
    const k = h(legend, 'span', 'bt-chart-key');
    h(k, 'span', 'bt-chart-swatch bt-chart-swatch-short');
    h(k, 'span', undefined, 'Held short');
  }
  h(legend, 'span', 'bt-chart-note bt-chart-scale', 'Value on a log scale');
  return { ta, tb, left, plotW, logLo: l0, logHi: l1, ddMin, yLog, yDd };
}

/** A strategy's value and its benchmark's, cut down to at most `n` points, for a small chart that has no room for more. */
export interface SparkSeries {
  /** The strategy's value; shorter than `benchmark` when the run lost all its equity before the end. */
  strategy: number[];
  benchmark: number[];
  label: string;
}

/**
 * The points of a sparkline: every k-th bar and the last one, from the first bar, with the strategy cut at a ruin. A
 * loop, not Math.min(...) or slices of the whole run: a long intraday run has more values than a call takes arguments.
 */
export function sparkSeries(bt: Backtest, n = 120): SparkSeries {
  const { run, benchmark } = bt;
  const bars = run.t.length;
  const ruined = run.ruin ? run.t.indexOf(run.ruin.t) : -1;
  const end = ruined >= 0 ? ruined : bars;
  const k = Math.max(1, Math.ceil(bars / n));
  const strategy: number[] = [];
  const bench: number[] = [];
  for (let i = 0; i < bars; i += k) {
    bench.push(benchmark.equity[i]);
    if (i < end) strategy.push(run.equity[i]);
  }
  if ((bars - 1) % k !== 0) {
    bench.push(benchmark.equity[bars - 1]);
    if (end === bars) strategy.push(run.equity[bars - 1]);
  }
  return { strategy, benchmark: bench, label: benchmark.label };
}

let sparks = 0;

/**
 * A small chart of a strategy against its benchmark: both on one log scale, and the gap between them shaded in the colour
 * of whichever is ahead, as in the value chart. No axes.
 */
export function drawSpark(parent: HTMLElement, series: SparkSeries, width = 68, height = 24): void {
  const { strategy, benchmark } = series;
  const n = benchmark.length;
  let [least, most] = [Infinity, 0];
  for (const list of [strategy, benchmark]) {
    for (const v of list) {
      if (!(v > 0)) continue;
      if (v < least) least = v;
      if (v > most) most = v;
    }
  }
  const box = h(parent, 'span', 'bt-spark');
  const svg = s(box, 'svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'bt-svg', role: 'img', 'aria-label': `Value of the strategy and of ${series.label}` });
  if (n < 2 || most === 0) return;
  const lo = Math.log(least);
  const span = Math.log(most) - lo || 1;
  const x = (i: number) => ((i / (n - 1)) * (width - 2) + 1).toFixed(1);
  const y = (v: number) => (2 + (1 - (Math.log(v) - lo) / span) * (height - 4)).toFixed(1);
  const points = (list: number[]) => list.flatMap((v, i) => (v > 0 ? [`${x(i)},${y(v)}`] : []));
  const b = points(benchmark);
  const m = points(strategy);
  // The gap: the shape between the two lines, cut by the benchmark's line into the part above it and the part below.
  if (m.length > 1 && m.length === b.length) {
    const id = `bt-spark-${++sparks}`;
    const defs = s(svg, 'defs', {});
    s(s(defs, 'clipPath', { id: `${id}-a` }), 'path', { d: `M1,-5L${b.join('L')}L${width - 1},-5Z` });
    s(s(defs, 'clipPath', { id: `${id}-b` }), 'path', { d: `M1,${height + 5}L${b.join('L')}L${width - 1},${height + 5}Z` });
    const between = `M${m.join('L')}L${[...b].reverse().join('L')}Z`;
    s(svg, 'path', { d: between, class: 'bt-ahead', 'clip-path': `url(#${id}-a)` });
    s(svg, 'path', { d: between, class: 'bt-behind', 'clip-path': `url(#${id}-b)` });
  }
  if (b.length > 1) s(svg, 'path', { d: `M${b.join('L')}`, class: 'bt-line bt-line-benchmark bt-spark-line' });
  if (m.length > 1) s(svg, 'path', { d: `M${m.join('L')}`, class: 'bt-line bt-line-strategy bt-spark-line' });
}

/** A small line of the strategy against its benchmark, for the folded result: no axes, both on one log scale. */
export function sparkline(parent: HTMLElement, bt: Backtest, width = 68, height = 24): void {
  drawSpark(parent, sparkSeries(bt), width, height);
}
