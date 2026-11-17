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

/** Ticks for a log axis: 1-2-5 steps over a wide range, even steps over a narrow one. */
export function moneyTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  if (hi / lo < 10) {
    const step = niceStep(hi - lo, 5);
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
    return out;
  }
  const mults = hi / lo > 2000 ? [1] : hi / lo > 60 ? [1, 3] : [1, 2, 5];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of mults) {
      const v = m * 10 ** e;
      if (v >= lo && v <= hi) out.push(v);
    }
  }
  return out;
}

export function timeTicks(t0: number, t1: number, width: number): { t: number; label: string }[] {
  const max = Math.max(2, Math.floor(width / 80));
  const out: { t: number; label: string }[] = [];
  const days = (t1 - t0) / DAY;
  if (days < 3) {
    const step = [1, 2, 3, 4, 6, 12, 24].find((x) => days * 24 / x <= max) ?? 24;
    for (let t = Math.ceil(t0 / (step * 3_600_000)) * step * 3_600_000; t <= t1; t += step * 3_600_000) {
      const d = new Date(t);
      out.push({ t, label: d.getUTCHours() === 0 ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : `${String(d.getUTCHours()).padStart(2, '0')}:00` });
    }
  } else if (days < 75) {
    const step = [1, 2, 7, 14].find((x) => days / x <= max) ?? 14;
    for (let t = Math.ceil(t0 / DAY) * DAY; t <= t1; t += step * DAY) {
      const d = new Date(t);
      out.push({ t, label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` });
    }
  } else {
    const months = days / 30.44;
    const step = [1, 2, 3, 6, 12, 24, 60, 120].find((x) => months / x <= max) ?? 240;
    const d0 = new Date(t0);
    let m = d0.getUTCFullYear() * 12 + d0.getUTCMonth();
    m = Math.ceil(m / step) * step;
    for (;; m += step) {
      const t = Date.UTC(Math.floor(m / 12), m % 12, 1);
      if (t > t1) break;
      if (t >= t0) out.push({ t, label: step >= 12 ? String(Math.floor(m / 12)) : m % 12 === 0 ? String(Math.floor(m / 12)) : MONTHS[m % 12] });
    }
  }
  return out;
}
