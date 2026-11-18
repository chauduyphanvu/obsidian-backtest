// How numbers, dates and times read, and the ticks of chart axes. Pure: logic and views both use it.

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const YEAR = 365.25 * DAY;
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Whether any of these times falls inside a day, so a run's times need the time of day as well. */
export const isIntraday = (t: readonly number[]): boolean => t.some((x) => x % DAY !== 0);

export const minus = (text: string) => text.replace('-', '−');
export const pct = (x: number, digits = 1) => (Number.isFinite(x) ? minus((x * 100).toFixed(digits)) + '%' : '–');
export const signedPct = (x: number, digits = 1) => (x > 0 ? '+' : '') + pct(x, digits);
export const isoDate = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The calendar day of a time on the reader's clock, so "today" means their today. */
export function localDate(t: number): string {
  const d = new Date(t);
  return isoDate(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

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

/** A number to 12 significant digits, which drops the floating-point tail of a sum such as 0.1 + 0.2. */
export const tidy = (x: number) => Number(x.toPrecision(12));

/** The middle value, or the mean of the two middle ones; NaN for none. */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** A count and its word: "1 run", "1,000 runs"; `many` for a word whose plural is not an added "s". */
export const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;
/** As plural, but the count has no thousands separators: "1000 bars". */
export const ungroupedPlural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** 1st, 2nd, 11th, 1,001st. */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n.toLocaleString('en-US')}${suffix}`;
}
/** As ordinal, but without thousands separators: 1001st. */
export function ungroupedOrdinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** A number with `d` decimals, or none when it is whole. */
export function fixed(x: number, d: number): string {
  if (Number.isNaN(x)) return 'unknown';
  if (!Number.isFinite(x)) return x > 0 ? 'infinity' : '−infinity';
  const digits = Number.isInteger(x) ? 0 : d;
  return minus(x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
}

/**
 * The decimals a value is shown with: 2 from 1 up and for 0, 4 from 0.01, else 6. `unknown` is the count for NaN, where the
 * trade explanations and the rule table differ: explanations take 6 and the table 2, which decides how many decimals the
 * other value of a pair gets (see pair).
 */
export function places(x: number, unknown: number): number {
  const a = Math.abs(x);
  if (Number.isNaN(a)) return unknown;
  return a >= 1 || a === 0 ? 2 : a >= 0.01 ? 4 : 6;
}

/** Two values side by side, with enough decimals that different numbers never print the same. `unknown`: see places. */
export function pair(a: number, b: number, percent: boolean, unknown: number): [string, string] {
  const f = (x: number, d: number) => (percent && Number.isFinite(x) ? `${fixed(Number((x * 100).toPrecision(12)), d)}%` : fixed(x, d));
  let d = Math.max(places(percent ? a * 100 : a, unknown), places(percent ? b * 100 : b, unknown));
  while (d < 10 && a !== b && f(a, d) === f(b, d)) d++;
  return [f(a, d), f(b, d)];
}

/** A number of shares, to 4 decimals. */
export const shareCount = (x: number) => minus(x.toLocaleString('en-US', { maximumFractionDigits: 4 }));

/** A field of a comma-separated line, in quotes when it holds a comma, a quote or a line break. */
export const csvField = (v: string | number): string => {
  const x = String(v);
  return /[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
};
