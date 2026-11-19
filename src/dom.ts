// DOM helpers shared by everything that renders.

import { tokenizeBlock } from './highlight.ts';

export const SVG = 'http://www.w3.org/2000/svg';

export function h<K extends keyof HTMLElementTagNameMap>(parent: Element, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  parent.appendChild(el);
  return el;
}

/** Writes strategy text into `pre` coloured the way the editor shows it, one span for each token. */
export function colourSource(pre: HTMLElement, text: string): void {
  const lines = text.split('\n');
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

/**
 * Like colourSource, with each line in an element of its own (returned in order), for showing some lines only. `token` is
 * told each token's element, its line and its columns.
 */
export function colourLines(pre: HTMLElement, text: string, token?: (el: HTMLElement, line: number, from: number, to: number) => void): HTMLElement[] {
  const lines = text.split('\n');
  return tokenizeBlock(lines).map((tokens, i) => {
    const line = lines[i];
    const el = h(pre, 'span', 'bt-src-line');
    let at = 0;
    for (const t of tokens) {
      if (t.from > at) el.append(line.slice(at, t.from));
      const span = h(el, 'span', `bt-tok bt-tok-${t.kind}`, line.slice(t.from, t.to));
      token?.(span, i, t.from, t.to);
      at = t.to;
    }
    el.append(line.slice(at));
    return el;
  });
}

export function s(parent: Element, tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  parent.appendChild(el);
  return el;
}

/**
 * Calls `draw` with the box's width when it is first known and each time it changes. Drawing changes the box's height,
 * which notifies the observer again within the same frame, so a drawing waits for the next frame and the same width
 * never draws twice. Returns a cleanup function.
 */
export function onWidth(box: HTMLElement, draw: (width: number) => void): () => void {
  let drawn = 0;
  const observer = new ResizeObserver((entries) => {
    const width = Math.floor(entries[0].contentRect.width);
    if (width > 0 && width !== drawn) window.requestAnimationFrame(() => draw((drawn = width)));
  });
  observer.observe(box);
  return () => observer.disconnect();
}

/**
 * Whether to animate. Motion only shows a change of state or place; with the system's "reduce motion" on, every change is
 * a cut. Without `matchMedia` (the tests' stand-in page) nothing animates either.
 */
export function motionOK(): boolean {
  const media = typeof window === 'undefined' ? undefined : window.matchMedia;
  return typeof media === 'function' && !media.call(window, '(prefers-reduced-motion: reduce)').matches;
}

export const easeOut = (k: number): number => 1 - (1 - k) ** 3;
export const easeInOut = (k: number): number => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2);

/**
 * Calls `step` once a frame for `ms` with the eased share of the time gone, from above 0 to 1. Without motion it calls
 * `step(1)` at once. Returns a function that stops it where it is.
 */
export function tween(ms: number, step: (k: number) => void, curve: (k: number) => number = easeInOut): () => void {
  if (ms <= 0 || !motionOK()) {
    step(1);
    return () => {};
  }
  let stopped = false;
  let frame = 0;
  const start = performance.now();
  const tick = (now: number) => {
    if (stopped) return;
    const k = Math.min(1, Math.max(0, (now - start) / ms));
    step(curve(k));
    if (k < 1) frame = window.requestAnimationFrame(tick);
  };
  frame = window.requestAnimationFrame(tick);
  return () => {
    stopped = true;
    window.cancelAnimationFrame(frame);
  };
}

/** The time a layout change takes (`--bt-t-layout` in the stylesheet), with a margin for the last frame. */
const LAYOUT_MS = 300;

/**
 * Makes a change to a box's content and lets the box's height ease from the old height to the new one, so the note
 * under it moves smoothly instead of jumping. Without motion it only makes the change.
 */
export function easeHeight(box: HTMLElement, change: () => void): void {
  if (!motionOK()) {
    change();
    return;
  }
  const from = box.offsetHeight;
  change();
  box.style.removeProperty('height');
  const to = box.offsetHeight;
  if (Math.abs(from - to) < 1) return;
  box.classList.add('bt-easing');
  box.style.setProperty('height', `${from}px`);
  void box.offsetHeight;
  box.style.setProperty('height', `${to}px`);
  const token = String(Math.random());
  box.setAttribute('data-bt-ease', token);
  window.setTimeout(() => {
    if (box.getAttribute('data-bt-ease') !== token) return;
    box.removeAttribute('data-bt-ease');
    box.classList.remove('bt-easing');
    box.style.removeProperty('height');
  }, LAYOUT_MS + 40);
}

/**
 * Opens or closes a box drawn as `.bt-reveal` (its one child holds the content): the space opens first and the content
 * fades in, and the reverse on closing. A closed box is `hidden` and `inert` once its closing is over, so it is out of
 * the tab order and of what a screen reader reads.
 */
export function reveal(box: HTMLElement, open: boolean): void {
  const token = String(Math.random());
  box.setAttribute('data-bt-reveal', token);
  if (open) {
    box.hidden = false;
    box.inert = false;
    // The closed state must be laid out once before the open one, or there is nothing to ease from.
    if (motionOK()) void box.offsetHeight;
    box.classList.add('bt-open');
    return;
  }
  box.classList.remove('bt-open');
  box.inert = true;
  if (!motionOK()) {
    box.hidden = true;
    return;
  }
  window.setTimeout(() => {
    if (box.getAttribute('data-bt-reveal') === token) box.hidden = true;
  }, LAYOUT_MS + 40);
}

/** A box for `reveal`: the outer element eases, the inner one holds the content. Starts closed unless `open`. */
export function revealBox(parent: HTMLElement, cls: string, open = false): { box: HTMLElement; inner: HTMLElement } {
  const box = h(parent, 'div', `bt-reveal ${cls}`);
  const inner = h(box, 'div', 'bt-reveal-in');
  if (open) box.classList.add('bt-open');
  else {
    box.hidden = true;
    box.inert = true;
  }
  return { box, inner };
}
