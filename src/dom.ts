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

/** Like colourSource, with each line in an element of its own (returned in order), for showing some lines only. */
export function colourLines(pre: HTMLElement, text: string): HTMLElement[] {
  const lines = text.split('\n');
  return tokenizeBlock(lines).map((tokens, i) => {
    const line = lines[i];
    const el = h(pre, 'span', 'bt-src-line');
    let at = 0;
    for (const t of tokens) {
      if (t.from > at) el.append(line.slice(at, t.from));
      h(el, 'span', `bt-tok bt-tok-${t.kind}`, line.slice(t.from, t.to));
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
