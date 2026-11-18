// The top of a result in words and figures: the sentence it opens with, then each figure of the strategy beside its
// benchmark's on a line of its own, as two dots on one scale, with how far apart they are.

import type { Backtest } from './backtest.ts';
import { h } from './dom.ts';
import { figures, moreFigures, verdict, type Figure } from './verdict.ts';

/** The opening sentence, drawn again for each run shown. */
export function verdictView(parent: HTMLElement): { show(bt: Backtest): void } {
  const box = h(parent, 'div', 'bt-verdict');
  const lead = h(box, 'p', 'bt-verdict-lead');
  const more = h(box, 'p', 'bt-verdict-more');
  return {
    show(bt) {
      const v = verdict(bt);
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

function row(parent: HTMLElement, f: Figure): void {
  const r = h(parent, 'div', `bt-vs-row${f.textOnly ? ' bt-vs-text-row' : ''}`);
  h(r, 'span', 'bt-vs-label', f.label);
  value(r, 'bt-vs-s', f.sText, f.sNote);
  if (f.textOnly) {
    h(r, 'span', 'bt-vs-text', f.delta);
    return;
  }
  dumbbell(r, f.s, f.b).classList.add('bt-vs-track');
  value(r, 'bt-vs-b', f.bText, f.bNote);
  h(r, 'span', 'bt-vs-delta', f.delta);
}

/** The figures, with "More figures" opening the rest; it stays open or closed across the runs a slider shows. */
export function versusView(parent: HTMLElement): { show(bt: Backtest): void } {
  const box = h(parent, 'div', 'bt-vs');
  let more = false;
  let shown: Backtest | null = null;
  const draw = () => {
    const bt = shown!;
    box.replaceChildren();
    const head = h(box, 'div', 'bt-vs-row bt-vs-head');
    h(head, 'span', 'bt-vs-label');
    const s = h(head, 'span', 'bt-vs-s bt-vs-key');
    h(s, 'span', 'bt-vs-key-dot bt-dumbbell-strategy');
    s.append('Strategy');
    h(head, 'span', 'bt-vs-track');
    const b = h(head, 'span', 'bt-vs-b bt-vs-key');
    h(b, 'span', 'bt-vs-key-dot bt-dumbbell-benchmark');
    b.append(bt.benchmark.label);
    h(head, 'span', 'bt-vs-delta', 'Difference');
    for (const f of figures(bt)) row(box, f);
    if (more) for (const f of moreFigures(bt)) row(box, f);
    const toggle = h(box, 'button', 'bt-link-button bt-vs-toggle', more ? 'Fewer figures' : 'More figures');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(more));
    toggle.addEventListener('click', () => {
      more = !more;
      // The button is drawn again with the rows; one pressed from the keyboard keeps the focus.
      const focused = document.activeElement === toggle;
      draw();
      if (focused) box.querySelector<HTMLElement>('.bt-vs-toggle')?.focus();
    });
  };
  return {
    show(bt) {
      shown = bt;
      draw();
    },
  };
}
