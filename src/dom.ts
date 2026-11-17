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

export function s(parent: Element, tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  parent.appendChild(el);
  return el;
}
