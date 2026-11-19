// The top of a result in words and figures: the sentence it opens with, then each figure of the strategy beside its
// benchmark's on a line of its own, as two dots on one scale, with how far apart they are.

import type { Backtest } from './backtest.ts';
import { h, s } from './dom.ts';
import { pct, signedPct } from './format.ts';
import { figures, moreFigures, verdict, type Figure, type Judge } from './verdict.ts';

/** The opening sentence, drawn again for each run shown. */
export function verdictView(parent: HTMLElement): { show(bt: Backtest, opts?: { arrive?: boolean }): void } {
  const box = h(parent, 'div', 'bt-verdict');
  const lead = h(box, 'p', 'bt-verdict-lead');
  const more = h(box, 'p', 'bt-verdict-more');
  return {
    show(bt, opts = {}) {
      const v = verdict(bt);
      // A new result's underlines draw in once, in the order the sentence reads.
      lead.classList.toggle('bt-arrive', opts.arrive ?? false);
      lead.replaceChildren();
      for (const part of v.lead) {
        if (part.mark) h(lead, 'span', `bt-mark bt-mark-${part.mark}`, part.text);
        else lead.append(part.text);
      }
      more.textContent = v.more;
      more.hidden = !v.more;
    },
  };
}

/**
 * Two values on one scale from 0: a dot for each, joined by a line, with 0 marked. A value that is not known has no dot.
 * `lo` and `hi` set a scale shared with other rows; by default it spans 0 and both values.
 */
export function dumbbell(parent: HTMLElement, s: number, b: number, lo?: number, hi?: number): HTMLElement {
  const track = h(parent, 'div', 'bt-dumbbell');
  track.setAttribute('aria-hidden', 'true');
  const known = [s, b].filter(Number.isFinite);
  if (known.length === 0) return track;
  const a = lo ?? Math.min(0, ...known);
  const z = hi ?? Math.max(0, ...known);
  const pad = (z - a) * 0.06 || 1;
  const at = (v: number) => (((v - a + pad) / (z - a + 2 * pad)) * 100).toFixed(2);
  h(track, 'span', 'bt-dumbbell-zero').style.left = `${at(0)}%`;
  // Where the dots slide out from when a new result arrives.
  track.style.setProperty('--bt-from', `${at(0)}%`);
  if (known.length === 2) {
    const join = h(track, 'span', 'bt-dumbbell-join');
    join.style.left = `${at(Math.min(s, b))}%`;
    join.style.width = `${(Number(at(Math.max(s, b))) - Number(at(Math.min(s, b)))).toFixed(2)}%`;
  }
  if (Number.isFinite(b)) h(track, 'span', 'bt-dumbbell-dot bt-dumbbell-benchmark').style.left = `${at(b)}%`;
  if (Number.isFinite(s)) h(track, 'span', 'bt-dumbbell-dot bt-dumbbell-strategy').style.left = `${at(s)}%`;
  return track;
}

function value(parent: HTMLElement, cls: string, text: string, note?: string): void {
  const cell = h(parent, 'span', cls);
  h(cell, 'span', 'bt-vs-value', text);
  if (note) h(cell, 'span', 'bt-vs-note', note);
}

const JUDGE_WORD: Record<Judge, string> = { better: 'Better', worse: 'Worse', even: 'About even' };

/** A mark of who did better: a check, a dash, two lines for even, a dot for a figure that is not judged. */
function judgeIcon(parent: HTMLElement, judge: Judge | undefined): void {
  const i = h(parent, 'span', 'bt-judge-icon');
  i.setAttribute('aria-hidden', 'true');
  const svg = s(i, 'svg', { width: 10, height: 10, viewBox: '0 0 10 10' });
  const line = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  if (judge === 'better') s(svg, 'path', { d: 'M2.2 5.3l1.8 1.8 3.8-4', ...line });
  else if (judge === 'worse') s(svg, 'path', { d: 'M2.5 5h5', ...line });
  else if (judge === 'even') s(svg, 'path', { d: 'M2.5 3.8h5M2.5 6.2h5', ...line, 'stroke-width': 1.3 });
  else s(svg, 'circle', { cx: 5, cy: 5, r: 1.4, fill: 'currentColor' });
}

/** Which part of the chart a figure comes from, for the rows that light it up. */
const LINKS: Record<string, string> = { 'Return per year': 'end', 'Total return': 'end', 'Worst drawdown': 'dd', Volatility: 'vol', 'Time invested': 'held', 'Exposure, gross': 'held' };

function row(parent: HTMLElement, f: Figure, arrive: boolean): HTMLElement {
  const r = h(parent, 'div', 'bt-vs-row');
  const link = LINKS[f.label];
  if (link) {
    r.classList.add('bt-vs-linked');
    r.setAttribute('data-bt-hl', link);
  }
  h(r, 'span', 'bt-vs-label', f.label);
  value(r, 'bt-vs-s', f.sText, f.sNote);
  const track = dumbbell(r, f.s, f.b);
  track.classList.add('bt-vs-track');
  if (arrive) track.classList.add('bt-arrive');
  value(r, 'bt-vs-b', f.bText, f.bNote);
  const judge = h(r, 'span', `bt-vs-judge${f.judge ? ` bt-judge-${f.judge}` : ''}`);
  if (f.delta || f.judge) {
    judgeIcon(judge, f.judge);
    if (f.judge) h(judge, 'span', 'bt-sr', `${JUDGE_WORD[f.judge]}: `);
    h(judge, 'span', 'bt-vs-delta', f.delta);
  }
  return r;
}

/** The trades in one line under the figures: "67 trades · 30% won · +2.6% on average · 1 open". */
export function tradesLine(bt: Backtest): string {
  const ts = bt.tradeStats;
  const open = ts.open ? [`${ts.open} open`] : [];
  if (!ts.count) return [ts.open ? 'No closed trades' : 'No rule opened a position', ...open].join(' \u00b7 ');
  return [`${ts.count} ${ts.count === 1 ? 'trade' : 'trades'}`, `${pct(ts.winRate, 0)} won`, `${signedPct(ts.avgReturn)} on average`, ...open].join(' \u00b7 ');
}

/** How many figures "All figures" adds (moreFigures), said on its button without working them out. */
const MORE_FIGURES = 8;

/**
 * The figures: a tally of where the strategy did better, a row for each figure with both values as dots on one scale and
 * a mark of who did better, and the trades in a line under them. "All figures" adds the rest, and stays open or closed
 * across the runs a slider shows. `link` is told the part of the chart a row comes from while the pointer is on it.
 */
export function versusView(parent: HTMLElement, o: { more?: boolean; link?: (part: string | null) => void } = {}): { show(bt: Backtest, opts?: { arrive?: boolean }): void; more(): boolean } {
  const box = h(parent, 'div', 'bt-vs');
  let more = o.more ?? false;
  let shown: Backtest | null = null;
  const draw = (arrive: boolean) => {
    const bt = shown!;
    box.replaceChildren();
    const list = figures(bt).filter((f) => !f.textOnly);
    const head = h(box, 'div', 'bt-vs-head');
    const s = h(head, 'span', 'bt-vs-key');
    h(s, 'span', 'bt-vs-key-dot bt-dumbbell-strategy');
    s.append('Strategy');
    h(head, 'span', 'bt-vs-versus', 'vs');
    const b = h(head, 'span', 'bt-vs-key');
    h(b, 'span', 'bt-vs-key-dot bt-dumbbell-benchmark');
    b.append(bt.benchmark.label);
    const judged = list.filter((f) => f.judge).map((f) => f.judge!);
    if (judged.length) {
      const tally = h(head, 'span', 'bt-vs-tally');
      const pips = h(tally, 'span', 'bt-vs-pips');
      pips.setAttribute('aria-hidden', 'true');
      const order: Judge[] = ['better', 'even', 'worse'];
      for (const j of [...judged].sort((x, y) => order.indexOf(x) - order.indexOf(y))) h(pips, 'span', `bt-pip bt-judge-${j}`);
      const count = (j: Judge) => judged.filter((x) => x === j).length;
      const words = [['Better', 'better'], ['worse', 'worse'], ['about even', 'even']] as const;
      const said = words.flatMap(([w, j]) => (count(j) ? [`${w} on ${count(j)}`] : []));
      said[0] = said[0][0].toUpperCase() + said[0].slice(1);
      tally.append(said.join(' \u00b7 '));
    }
    for (const f of list) {
      const r = row(box, f, arrive);
      const part = r.getAttribute('data-bt-hl');
      if (part && o.link) {
        r.addEventListener('pointerenter', () => o.link!(part));
        r.addEventListener('pointerleave', () => o.link!(null));
      }
    }
    if (more) for (const f of moreFigures(bt)) row(box, f, false);
    const foot = h(box, 'div', 'bt-vs-foot');
    h(foot, 'span', 'bt-vs-trades', tradesLine(bt));
    const toggle = h(foot, 'button', 'bt-chip-button bt-vs-toggle', more ? 'Fewer figures' : `All figures \u00b7 ${MORE_FIGURES} more`);
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(more));
    toggle.addEventListener('click', () => {
      more = !more;
      // The button is drawn again with the rows; one pressed from the keyboard keeps the focus.
      const focused = document.activeElement === toggle;
      draw(false);
      if (focused) box.querySelector<HTMLElement>('.bt-vs-toggle')?.focus();
    });
  };
  return {
    show(bt, opts = {}) {
      shown = bt;
      draw(opts.arrive ?? false);
    },
    more: () => more,
  };
}
