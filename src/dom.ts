// DOM and number-format helpers shared by everything that renders.

export const SVG = 'http://www.w3.org/2000/svg';
export const DAY = 86_400_000;
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function h<K extends keyof HTMLElementTagNameMap>(parent: Element, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  parent.appendChild(el);
  return el;
}

export function s(parent: Element, tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  parent.appendChild(el);
  return el;
}

export const minus = (text: string) => text.replace('-', '−');
export const pct = (x: number, digits = 1) => (Number.isFinite(x) ? minus((x * 100).toFixed(digits)) + '%' : '–');
export const signedPct = (x: number, digits = 1) => (x > 0 ? '+' : '') + pct(x, digits);
export const isoDate = (t: number) => new Date(t).toISOString().slice(0, 10);

export function money(x: number): string {
  const a = Math.abs(x);
  const trim = (v: number, d: number) => String(Number(v.toFixed(d)));
  if (a >= 1e9) return `$${trim(x / 1e9, 2)}B`;
  if (a >= 1e6) return `$${trim(x / 1e6, 2)}M`;
  if (a >= 1e4) return `$${trim(x / 1e3, 1)}k`;
  return `$${x.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function price(x: number): string {
  return x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: x < 1 ? 6 : 2 });
}

/** Intraday runs need the time of day as well. */
export function stamp(t: number, intraday: boolean): string {
  return intraday ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : isoDate(t);
}

export function niceStep(span: number, target: number): number {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
}
