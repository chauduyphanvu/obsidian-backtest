import { emptyBars, type AssetRef, type Bars } from './types.ts';

const DAY = 86_400_000;
const FRESH_FOR = 6 * 3_600_000;

export interface DataDeps {
  /** GET a URL and return its body; rejects on a network error or a non-2xx status. */
  fetchText(url: string): Promise<string>;
  /** Reads a vault file, or null when it does not exist. */
  readVaultFile(path: string): Promise<string | null>;
  cacheRead(key: string): Promise<string | null>;
  cacheWrite(key: string, text: string): Promise<void>;
  now(): number;
}

export interface Loaded {
  bars: Bars;
  /** Set when the network failed and older cached bars were used instead. */
  warning: string | null;
}

interface Cached {
  fetched: number;
  /** The `since` the bars were fetched for. */
  since: number;
  bars: Bars;
}

function push(bars: Bars, t: number, o: number, h: number, l: number, c: number, v: number): void {
  // Rows a price series can't hold (nulls, zero or inverted ranges) are skipped.
  if (!(Math.min(o, h, l, c) > 0) || l > Math.min(o, c) || h < Math.max(o, c)) return;
  if (bars.t.length && t <= bars.t[bars.t.length - 1]) return;
  bars.t.push(t);
  bars.o.push(o);
  bars.h.push(h);
  bars.l.push(l);
  bars.c.push(c);
  bars.v.push(Number.isFinite(v) ? v : 0);
}

/** Yahoo chart JSON to bars adjusted for splits and dividends, without a bar that is still trading. */
export function parseYahoo(json: string, now: number, weekly = false): Bars {
  const body = JSON.parse(json);
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error(body?.chart?.error?.description ?? 'Yahoo returned no data');
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const adj: (number | null)[] = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const offset = (result.meta?.gmtoffset ?? 0) * 1000;
  const today = Math.floor((now + offset) / DAY) * DAY;
  const span = weekly ? 7 * DAY : DAY;
  const bars = emptyBars();
  for (let i = 0; i < ts.length; i++) {
    const day = Math.floor((ts[i] * 1000 + offset) / DAY) * DAY;
    if (day + span > today) break;
    const c = q.close?.[i];
    if (c == null) continue;
    const f = adj[i] != null ? adj[i]! / c : 1;
    push(bars, day, q.open?.[i] * f, q.high?.[i] * f, q.low?.[i] * f, c * f, q.volume?.[i] ?? 0);
  }
  return bars;
}

/** Binance kline rows to bars, without the kline that has not closed yet. */
export function parseBinance(json: string, now: number): Bars {
  const rows = JSON.parse(json);
  if (!Array.isArray(rows)) throw new Error(rows?.msg ?? 'Binance returned no data');
  const bars = emptyBars();
  for (const r of rows) {
    if (r[6] >= now) break;
    push(bars, r[0], Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4]), Number(r[5]));
  }
  return bars;
}

function parseTime(text: string): number {
  const s = text.trim().replace(/^"|"$/g, '');
  if (/^\d{9,}$/.test(s)) return s.length > 11 ? Number(s) : Number(s) * 1000;
  // A bare date is that UTC day; a date with a time and no zone is read as UTC too.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
  return Date.parse(iso);
}

/** CSV with a header row naming a date or time column and open, high, low, close (volume optional). */
export function parseCsv(text: string): Bars {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('The CSV has no rows');
  const header = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const ti = col('date', 'time', 'timestamp', 'datetime');
  const [oi, hi, li, ci, vi] = [col('open'), col('high'), col('low'), col('close'), col('volume')];
  const ai = col('adj close', 'adj_close', 'adjclose');
  if ([ti, oi, hi, li, ci].some((i) => i < 0)) throw new Error('The CSV needs a header row with date, open, high, low and close columns');
  const rows = lines.slice(1).map((line) => {
    const f = line.split(',');
    const c = Number(f[ci]);
    const adj = ai >= 0 && Number(f[ai]) > 0 ? Number(f[ai]) / c : 1;
    return { t: parseTime(f[ti]), o: Number(f[oi]) * adj, h: Number(f[hi]) * adj, l: Number(f[li]) * adj, c: c * adj, v: vi >= 0 ? Number(f[vi]) : 0 };
  });
  rows.sort((a, b) => a.t - b.t);
  const bars = emptyBars();
  for (const r of rows) if (Number.isFinite(r.t)) push(bars, r.t, r.o, r.h, r.l, r.c, r.v);
  if (bars.t.length === 0) throw new Error('The CSV has no usable rows. Dates should look like 2024-01-31');
  return bars;
}

async function fetchYahoo(id: string, interval: string, deps: DataDeps): Promise<Bars> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(id)}` +
    `?period1=0&period2=${Math.floor(deps.now() / 1000)}&interval=${interval === '1w' ? '1wk' : '1d'}&events=div%2Csplit&includeAdjustedClose=true`;
  return parseYahoo(await deps.fetchText(url), deps.now(), interval === '1w');
}

async function fetchBinance(id: string, interval: string, since: number, have: Bars | null, deps: DataDeps): Promise<Bars> {
  const bars = have ?? emptyBars();
  let start = bars.t.length ? bars.t[bars.t.length - 1] + 1 : since;
  for (let pages = 0; ; pages++) {
    if (pages === 300) throw new Error('too much history for this interval; set a later "from" date');
    // data-api.binance.vision serves public market data where api.binance.com is region-blocked.
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(id)}&interval=${interval}&startTime=${start}&limit=1000`;
    const text = await deps.fetchText(url);
    const page = parseBinance(text, deps.now());
    for (let i = 0; i < page.t.length; i++) push(bars, page.t[i], page.o[i], page.h[i], page.l[i], page.c[i], page.v[i]);
    if ((JSON.parse(text) as unknown[]).length < 1000 || page.t.length === 0) return bars;
    start = page.t[page.t.length - 1] + 1;
  }
}

/**
 * Bars for one asset, from the cache while it is fresh. `since` is the earliest time the run
 * needs, lookback included; sources that serve whole histories ignore it.
 */
export async function loadBars(ref: AssetRef, interval: string, since: number, deps: DataDeps, force = false): Promise<Loaded> {
  if (ref.source === 'csv') {
    const text = await deps.readVaultFile(ref.id);
    if (text === null) throw new Error(`No file at ${ref.id}`);
    return { bars: parseCsv(text), warning: null };
  }

  const key = `${ref.source}-${ref.id}-${interval}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const raw = await deps.cacheRead(key);
  let cached: Cached | null = null;
  try {
    cached = raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    cached = null;
  }
  // A cache that starts after `since` was built for a shorter run and can't serve this one.
  const covers = cached !== null && cached.bars.t.length > 0 && (ref.source === 'yahoo' || cached.since <= since);
  if (cached && covers && !force && deps.now() - cached.fetched < FRESH_FOR) return { bars: cached.bars, warning: null };

  try {
    const bars = ref.source === 'yahoo' ? await fetchYahoo(ref.id, interval, deps) : await fetchBinance(ref.id, interval, since, covers ? cached!.bars : null, deps);
    if (bars.t.length === 0) throw new Error('no bars returned');
    await deps.cacheWrite(key, JSON.stringify({ fetched: deps.now(), since: covers ? cached!.since : since, bars } satisfies Cached));
    return { bars, warning: null };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (cached && covers) {
      const day = new Date(cached.fetched).toISOString().slice(0, 10);
      return { bars: cached.bars, warning: `Couldn't refresh ${ref.name} (${why}); using prices saved on ${day}.` };
    }
    throw new Error(`Couldn't load ${ref.name} from ${ref.source}: ${why}`);
  }
}
