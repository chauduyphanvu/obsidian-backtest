// Deterministic synthetic daily bars, written once in Rearview's import format and read by both engines.

export interface TickerSpec {
  id: number;
  ticker: string;
  /** Bar index (in the shared calendar) of the first bar. */
  first: number;
  start: number;
  /** One step of the log close, given the previous log close and a source of normals. */
  step: (x: number, k: number, n: () => number) => number;
  /** Intraday spread of the high and low around the body, as a fraction. */
  wick: number;
  /** The overnight gap as a log return, or 0 for an open at the previous close. */
  gap: (n: () => number, u: () => number) => number;
  /**
   * The first trading day of each month (or Monday-based week) opens, trades and closes at the
   * previous close, and the second opens there: Rearview decides a rebalance at the first day's
   * close and fills at the second day's open, where we fill at the first day's open, so this makes
   * both see one price.
   */
  calm: 'month' | 'week' | null;
  /** The share of days, after the first, with no bar (a halt). */
  missing?: number;
}

export interface Row {
  id: number;
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normals(u: () => number): () => number {
  return () => {
    const a = Math.max(u(), 1e-12);
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u());
  };
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const cents = (x: number) => Math.round(x * 100) / 100;

/** Weekdays from 2 January 2013, without 1 January, 4 July and 25 December. */
export function calendar(count: number): string[] {
  const out: string[] = [];
  for (let t = Date.UTC(2013, 0, 2); out.length < count; t += 86_400_000) {
    const d = new Date(t);
    const wd = d.getUTCDay();
    const md = `${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
    if (wd === 0 || wd === 6 || md === '1-1' || md === '7-4' || md === '12-25') continue;
    out.push(iso(t));
  }
  return out;
}

export const BARS = 3000;

/** The last trading day of a month at or after bar `k`, so a ranking run starting there decides on its first bar in both engines. */
function monthEndAtOrAfter(days: string[], k: number): number {
  while (k + 1 < days.length && days[k + 1].slice(0, 7) === days[k].slice(0, 7)) k++;
  return k;
}

export function tickers(days: string[]): TickerSpec[] {
  const revert = (x: number, level: number, speed: number) => speed * (Math.log(level) - x);
  let regime = 0;
  let drift = 0.0015;
  return [
    {
      id: 1, ticker: 'TRND', first: 0, start: 40, wick: 0.006, calm: 'month',
      step: (x, _k, n) => x + 0.0004 + 0.012 * n(),
      gap: () => 0,
    },
    {
      id: 2, ticker: 'MREV', first: 0, start: 50, wick: 0.008, calm: 'month',
      step: (x, _k, n) => x + revert(x, 50, 0.05) + 0.015 * n(),
      gap: () => 0,
    },
    {
      id: 3, ticker: 'CHOP', first: 0, start: 80, wick: 0.009, calm: 'month',
      step: (x, k, n) => {
        if (k >= regime) {
          drift = -Math.sign(drift) * 0.0015;
          regime = k + 60 + ((k * 7919) % 190);
        }
        return x + drift + revert(x, 80, 0.003) + 0.018 * n();
      },
      gap: () => 0,
    },
    {
      id: 4, ticker: 'VOLA', first: 0, start: 30, wick: 0.015, calm: 'month',
      step: (x, _k, n) => x + 0.0003 + revert(x, 30, 0.002) + 0.035 * n(),
      gap: (n) => 0.01 * n(),
    },
    {
      id: 5, ticker: 'GAPY', first: 0, start: 60, wick: 0.007, calm: null,
      step: (x, _k, n) => x + 0.0002 + revert(x, 60, 0.002) + 0.012 * n(),
      // One day in ten gaps 3% to 15% either way, enough to jump a stop or a target.
      gap: (n, u) => (u() < 0.1 ? (u() < 0.5 ? -1 : 1) * (0.03 + 0.12 * u()) : 0.002 * n()),
    },
    {
      id: 6, ticker: 'LATE', first: monthEndAtOrAfter(days, 640), start: 25, wick: 0.01, calm: 'month',
      step: (x, _k, n) => x + 0.0006 + revert(x, 60, 0.001) + 0.02 * n(),
      gap: () => 0,
    },
    {
      id: 7, ticker: 'HOLE', first: 0, start: 70, wick: 0.008, calm: null, missing: 0.03,
      step: (x, _k, n) => x + 0.0002 + revert(x, 70, 0.004) + 0.014 * n(),
      gap: () => 0,
    },
    {
      id: 8, ticker: 'WK1', first: 0, start: 45, wick: 0.007, calm: 'week',
      step: (x, _k, n) => x + 0.0003 + revert(x, 60, 0.002) + 0.013 * n(),
      gap: () => 0,
    },
    {
      id: 9, ticker: 'WK2', first: 0, start: 35, wick: 0.009, calm: 'week',
      step: (x, _k, n) => x + revert(x, 35, 0.01) + 0.016 * n(),
      gap: () => 0,
    },
  ];
}

/**
 * A volume that changes from bar to bar, for the indicators that weigh by it. It draws nothing from the price generators'
 * random numbers, so the prices stay what they were, and no case's rules read volume.
 */
function volume(id: number, k: number): number {
  let h = Math.imul(id + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return 200_000_000 + (((h ^ (h >>> 15)) >>> 0) % 1_600_000_001);
}

/** The Monday-based week of a YYYY-MM-DD date, as our engine counts weeks. */
export function weekOf(date: string): number {
  return Math.floor((Math.floor(Date.parse(date) / 86_400_000) + 3) / 7);
}

export function periodOf(date: string, by: 'month' | 'week'): string {
  return by === 'month' ? date.slice(0, 7) : String(weekOf(date));
}

export function generate(): { days: string[]; specs: TickerSpec[]; rows: Row[] } {
  const days = calendar(BARS);
  const specs = tickers(days);
  const rows: Row[] = [];
  for (const s of specs) {
    const u = mulberry32(0x5eed + s.id * 7717);
    const n = normals(u);
    let prevClose = s.start;
    let x = Math.log(s.start);
    for (let k = s.first; k < days.length; k++) {
      const by = s.calm;
      const nth = by === null ? 0 : k === 0 || periodOf(days[k], by) !== periodOf(days[k - 1], by) ? 1 : k > 1 && periodOf(days[k - 1], by) !== periodOf(days[k - 2], by) ? 2 : 0;
      // Draw every number every day, so a calm or missing day doesn't shift the rest of the series.
      const g = s.gap(n, u);
      const next = s.step(x, k, n);
      const w1 = Math.abs(n()) * s.wick;
      const w2 = Math.abs(n()) * s.wick;
      if (k > s.first && s.missing && u() < s.missing) continue;
      if (k > s.first && nth === 1) {
        rows.push({ id: s.id, date: days[k], o: prevClose, h: prevClose, l: prevClose, c: prevClose, v: volume(s.id, k) });
        continue;
      }
      const o = k === s.first ? cents(s.start) : nth === 2 ? prevClose : cents(prevClose * Math.exp(g));
      x = next;
      const c = cents(Math.exp(x));
      const h = Math.max(o, c, Math.ceil(Math.max(o, c) * (1 + w1) * 100) / 100);
      const l = Math.min(o, c, Math.floor(Math.min(o, c) * (1 - w2) * 100) / 100);
      if (!(l > 0)) throw new Error(`${s.ticker} went to ${l} on ${days[k]}`);
      rows.push({ id: s.id, date: days[k], o, h, l, c, v: volume(s.id, k) });
      prevClose = c;
      x = Math.log(c);
    }
  }
  return { days, specs, rows };
}

const fmt = (x: number) => Number(x.toFixed(6)).toString();

/**
 * Securities only Rearview sees: a twin with the bars of one of our tickers under another id. Rearview never opens a
 * side of a security it holds the other side of (a held security is no entry candidate), where we close one side and
 * open the other at one fill; a case that flips trades our ticker's longs on the ticker and its shorts on the twin, in
 * one account. `series("twin")` is 1 on a twin and 0 on every other security, for the rules to tell them apart.
 */
export const TWINS = [{ id: 10, ticker: 'TWIN', of: 'CHOP' }];

/** The import folder's files, by name. `weights` adds series/w.csv: a constant per security from the first day. */
export function importFiles(g: ReturnType<typeof generate>, weights: Record<string, number>): Record<string, string> {
  const name = (s: { ticker: string }) => `${s.ticker} synthetic`;
  const twins = TWINS.map((w) => ({ ...w, src: g.specs.find((s) => s.ticker === w.of)! }));
  const rows = [...g.rows, ...twins.flatMap((w) => g.rows.filter((r) => r.id === w.src.id).map((r) => ({ ...r, id: w.id })))];
  const files: Record<string, string> = {
    'manifest.json': '{"format":"rvw-import","version":1}\n',
    'securities.csv':
      'id,name,kind,exchange,sector,industry,delist_date,delist_reason\n' + [...g.specs, ...twins].map((s) => `${s.id},${name(s)},STOCK,NYSE,,,,\n`).join(''),
    'tickers.csv': 'id,ticker,from,to\n' + [...g.specs, ...twins.map((w) => ({ ...w, first: w.src.first }))].map((s) => `${s.id},${s.ticker},${g.days[s.first]},\n`).join(''),
    'actions.csv': 'id,ex_date,type,value1,value2,ref_id\n',
    'bars.csv': 'id,date,open,high,low,close,volume\n' + rows.map((r) => `${r.id},${r.date},${fmt(r.o)},${fmt(r.h)},${fmt(r.l)},${fmt(r.c)},${r.v}\n`).join(''),
  };
  files['series/w.csv'] =
    'id,date,value\n' +
    g.specs
      .filter((s) => s.ticker in weights)
      .map((s) => `${s.id},${g.days[s.first]},${weights[s.ticker]}\n`)
      .join('');
  files['series/twin.csv'] =
    'id,date,value\n' + [...g.specs.map((s) => `${s.id},${g.days[s.first]},0\n`), ...twins.map((w) => `${w.id},${g.days[w.src.first]},1\n`)].join('');
  return files;
}

/** One ticker's bars from bars.csv, as the CSV our engine reads. */
export function tickerCsv(barsCsv: string, id: number): string {
  const lines = barsCsv.trim().split('\n');
  const out = ['date,open,high,low,close,volume'];
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    if (Number(f[0]) === id) out.push(f.slice(1).join(','));
  }
  return out.join('\n') + '\n';
}
