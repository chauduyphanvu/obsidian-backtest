import { emptyBars, type AssetRef, type Bars } from './types.ts';

const DAY = 86_400_000;
const FRESH_FOR = 6 * 3_600_000;
/** Yahoo hosts in the order they are tried, with the wait before each retry. */
const YAHOO_HOSTS = ['query1', 'query2', 'query1'];
const YAHOO_WAITS = [500, 1500];

export interface DataDeps {
  /** GET a URL and return its body; rejects on a network error or a non-2xx status. */
  fetchText(url: string): Promise<string>;
  /** Reads a vault file, or null when it does not exist. */
  readVaultFile(path: string): Promise<string | null>;
  cacheRead(key: string): Promise<string | null>;
  cacheWrite(key: string, text: string): Promise<void>;
  now(): number;
  /** Waits between retries; without it retries go out straight away. */
  sleep?: (ms: number) => Promise<void>;
}

export interface Loaded {
  bars: Bars;
  /** Set when the network failed and older cached bars were used instead. */
  warning: string | null;
  source: 'yahoo' | 'stooq' | 'binance' | 'csv';
  /** Time of the last bar. */
  through: number;
  /** When these bars were fetched (csv: now). */
  fetched: number;
  /** True when a refresh failed and an older saved copy is being used. */
  stale: boolean;
}

/** A failure that no other host, source or saved copy can fix, such as a ticker that does not exist. */
class NoPrices extends Error {}

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

/**
 * Yahoo chart JSON to bars adjusted for splits and dividends, without a bar that is still trading.
 * Today's daily bar counts once the regular session it belongs to has closed.
 */
export function parseYahoo(json: string, now: number, weekly = false): Bars {
  const body = JSON.parse(json);
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error(body?.chart?.error?.description ?? 'Yahoo returned no data');
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const adj: (number | null)[] = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const offset = (result.meta?.gmtoffset ?? 0) * 1000;
  const localDay = (ms: number) => Math.floor((ms + offset) / DAY) * DAY;
  const today = localDay(now);
  const span = weekly ? 7 * DAY : DAY;
  const sessionEnd: unknown = result.meta?.currentTradingPeriod?.regular?.end;
  const closedToday = !weekly && typeof sessionEnd === 'number' && now >= sessionEnd * 1000 && localDay(sessionEnd * 1000) === today;
  const bars = emptyBars();
  for (let i = 0; i < ts.length; i++) {
    const day = localDay(ts[i] * 1000);
    if (day + span > today && !(closedToday && day === today)) break;
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

/** 31/01/2024, 01/31/2024 or 31.01.2024, optionally followed by a time. */
const SLASHED = /^(\d{1,2})([/.])(\d{1,2})\2(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

function parseTime(s: string, dayFirst: boolean): number {
  if (/^\d{9,}$/.test(s)) return s.length > 11 ? Number(s) : Number(s) * 1000;
  const m = SLASHED.exec(s);
  if (m) {
    const [day, month] = m[2] === '.' || dayFirst ? [Number(m[1]), Number(m[3])] : [Number(m[3]), Number(m[1])];
    const t = Date.UTC(Number(m[4]), month - 1, day, Number(m[5] ?? 0), Number(m[6] ?? 0), Number(m[7] ?? 0));
    const d = new Date(t);
    return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? t : NaN;
  }
  // A bare date is that UTC day; a date with a time and no zone is read as UTC too.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
  return Date.parse(iso);
}

/** Slashed dates are month first unless some first number is above 12 and no second number is. */
function slashedDatesAreDayFirst(values: string[]): boolean {
  let first = false;
  let second = false;
  for (const v of values) {
    const m = SLASHED.exec(v);
    if (m?.[2] !== '/') continue;
    if (Number(m[1]) > 12) first = true;
    if (Number(m[3]) > 12) second = true;
  }
  return first && !second;
}

/** Splits one CSV line, honouring double quotes (with "" for a quote inside one). */
function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') cur += ch;
      else if (line[i + 1] === '"') cur += line[i++];
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/** The header line decides the separator: whichever of comma, semicolon and tab splits it most. */
function detectSeparator(header: string): string {
  let best = ',';
  let most = 0;
  for (const sep of [',', ';', '\t']) {
    const n = splitLine(header, sep).length - 1;
    if (n > most) [best, most] = [sep, n];
  }
  return best;
}

const num = (s: string | undefined): number => (s === undefined || s === '' ? NaN : Number(s));

/** The header names parseCsv looks for, compared in lower case. */
export const CSV_HEADERS = {
  date: ['date', 'time', 'timestamp', 'datetime'],
  open: ['open'],
  high: ['high'],
  low: ['low'],
  close: ['close'],
  volume: ['volume'],
  adjClose: ['adj close', 'adj_close', 'adjclose'],
} as const;

/**
 * CSV with a header row naming a date or time column and open, high, low, close (volume optional).
 * Separators can be commas, semicolons or tabs; dates can be ISO, MM/DD/YYYY, DD/MM/YYYY (when some day is above 12) or DD.MM.YYYY.
 */
export function parseCsv(text: string): Bars {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('The CSV has no rows');
  const sep = detectSeparator(lines[0]);
  const names = splitLine(lines[0], sep);
  const header = names.map((h) => h.toLowerCase());
  const col = (...wanted: string[]) => header.findIndex((h) => wanted.includes(h));
  const ti = col(...CSV_HEADERS.date);
  const [oi, hi, li, ci, vi] = [col(...CSV_HEADERS.open), col(...CSV_HEADERS.high), col(...CSV_HEADERS.low), col(...CSV_HEADERS.close), col(...CSV_HEADERS.volume)];
  const ai = col(...CSV_HEADERS.adjClose);
  const missing = [ti < 0 && 'date', oi < 0 && 'open', hi < 0 && 'high', li < 0 && 'low', ci < 0 && 'close'].filter(Boolean);
  if (missing.length) throw new Error(`The CSV needs a header row with date, open, high, low and close columns, but has no ${missing.join(', ')} column`);

  const fields = lines.slice(1).map((line) => splitLine(line, sep));
  const dayFirst = slashedDatesAreDayFirst(fields.map((f) => f[ti] ?? ''));
  const rows = fields.map((f) => {
    const c = num(f[ci]);
    const adj = ai >= 0 && num(f[ai]) > 0 ? num(f[ai]) / c : 1;
    return { t: parseTime(f[ti] ?? '', dayFirst), o: num(f[oi]) * adj, h: num(f[hi]) * adj, l: num(f[li]) * adj, c: c * adj, v: vi >= 0 ? num(f[vi]) : 0 };
  });
  rows.sort((a, b) => a.t - b.t);
  const bars = emptyBars();
  for (const r of rows) if (Number.isFinite(r.t)) push(bars, r.t, r.o, r.h, r.l, r.c, r.v);
  if (bars.t.length > 0) return bars;

  const dated = rows.filter((r) => Number.isFinite(r.t));
  if (dated.length === 0) throw new Error(`The CSV has no usable rows: no date in the "${names[ti]}" column could be read. Dates should look like 2024-01-31`);
  for (const [name, key] of [[names[oi], 'o'], [names[hi], 'h'], [names[li], 'l'], [names[ci], 'c']] as const) {
    if (dated.every((r) => !Number.isFinite(r[key]))) throw new Error(`The CSV has no usable rows: no number in the "${name}" column could be read`);
  }
  throw new Error('The CSV has no usable rows: every row has a price at or below zero, or a high or low that does not contain the open and close');
}

/** The pieces parseCsv reads a file with, for code that has to agree with it exactly. */
export { SLASHED as CSV_SLASHED_DATE, detectSeparator as detectCsvSeparator, parseTime as parseCsvTime, slashedDatesAreDayFirst, splitLine as splitCsvLine };

async function fetchYahoo(ref: AssetRef, interval: string, deps: DataDeps): Promise<Bars> {
  const path =
    `/v8/finance/chart/${encodeURIComponent(ref.id)}` +
    `?period1=0&period2=${Math.floor(deps.now() / 1000)}&interval=${interval === '1w' ? '1wk' : '1d'}&events=div%2Csplit&includeAdjustedClose=true`;
  let failure: unknown;
  for (let attempt = 0; attempt < YAHOO_HOSTS.length; attempt++) {
    if (attempt > 0) await deps.sleep?.(YAHOO_WAITS[attempt - 1]);
    let text: string;
    try {
      text = await deps.fetchText(`https://${YAHOO_HOSTS[attempt]}.finance.yahoo.com${path}`);
    } catch (e) {
      failure = e;
      continue;
    }
    // A throttled or broken answer is plain text or HTML; Yahoo's own explanations are JSON, and trying again won't change them.
    if (!text.trimStart().startsWith('{')) {
      failure = new Error('Yahoo sent something other than price data');
      continue;
    }
    try {
      return parseYahoo(text, deps.now(), interval === '1w');
    } catch (e) {
      if (/"code"\s*:\s*"Not Found"/.test(text)) throw new NoPrices(`Yahoo has no prices for ${ref.name}. Check the ticker.`);
      throw e;
    }
  }
  throw failure;
}

async function fetchBinance(ref: AssetRef, interval: string, since: number, have: Bars | null, deps: DataDeps): Promise<Bars> {
  const bars = have ?? emptyBars();
  let start = bars.t.length ? bars.t[bars.t.length - 1] + 1 : since;
  for (let pages = 0; ; pages++) {
    if (pages === 300) throw new Error('too much history for this interval; set a later "from" date');
    // data-api.binance.vision serves public market data where api.binance.com is region-blocked.
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(ref.id)}&interval=${interval}&startTime=${start}&limit=1000`;
    const text = await deps.fetchText(url);
    let page: Bars;
    try {
      page = parseBinance(text, deps.now());
    } catch (e) {
      if (/"code"\s*:\s*-1121\b/.test(text)) throw new NoPrices(`Binance has no market called ${ref.name}. Check the symbol, such as BTCUSDT.`);
      throw e;
    }
    for (let i = 0; i < page.t.length; i++) push(bars, page.t[i], page.o[i], page.h[i], page.l[i], page.c[i], page.v[i]);
    if ((JSON.parse(text) as unknown[]).length < 1000 || page.t.length === 0) return bars;
    start = page.t[page.t.length - 1] + 1;
  }
}

function loaded(source: Loaded['source'], bars: Bars, fetched: number, warning: string | null = null, stale = false): Loaded {
  return { bars, warning, source, through: bars.t[bars.t.length - 1], fetched, stale };
}

/** Fetches, saves and returns fresh bars; on failure falls back to the saved copy when there is one. */
async function refresh(ref: AssetRef, interval: string, since: number, deps: DataDeps, key: string, cached: Cached | null): Promise<Loaded> {
  try {
    const bars = ref.source === 'yahoo' ? await fetchYahoo(ref, interval, deps) : await fetchBinance(ref, interval, since, cached?.bars ?? null, deps);
    if (bars.t.length === 0) throw new Error('no bars returned');
    const fetched = deps.now();
    await deps.cacheWrite(key, JSON.stringify({ fetched, since: cached?.since ?? since, bars } satisfies Cached));
    return loaded(ref.source, bars, fetched);
  } catch (e) {
    if (e instanceof NoPrices) throw e;
    const why = e instanceof Error ? e.message : String(e);
    if (cached) {
      const day = new Date(cached.fetched).toISOString().slice(0, 10);
      return loaded(ref.source, cached.bars, cached.fetched, `Couldn't refresh ${ref.name} (${why}); using prices saved on ${day}.`, true);
    }
    throw new Error(`Couldn't load ${ref.name} from ${ref.source}: ${why}`);
  }
}

const running = new WeakMap<DataDeps, Map<string, Promise<Loaded>>>();

/**
 * Bars for one asset, from the cache while it is fresh (6 hours unless `opts.freshForMs` says otherwise).
 * `since` is the earliest time the run needs, lookback included; sources that serve whole histories ignore it.
 * Calls that need the same download while one is running share it.
 */
export async function loadBars(ref: AssetRef, interval: string, since: number, deps: DataDeps, force = false, opts?: { freshForMs?: number }): Promise<Loaded> {
  if (ref.source === 'csv') {
    const text = await deps.readVaultFile(ref.id);
    if (text === null) throw new Error(`No file at ${ref.id}`);
    return loaded('csv', parseCsv(text), deps.now());
  }

  const key = `${ref.source}-${ref.id}-${interval}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const raw = await deps.cacheRead(key);
  let saved: Cached | null = null;
  try {
    saved = raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    saved = null;
  }
  // A cache that starts after `since` was built for a shorter run and can't serve this one.
  const cached = saved !== null && saved.bars.t.length > 0 && (ref.source === 'yahoo' || saved.since <= since) ? saved : null;
  if (cached && !force && deps.now() - cached.fetched < (opts?.freshForMs ?? FRESH_FOR)) return loaded(ref.source, cached.bars, cached.fetched);

  let byKey = running.get(deps);
  if (!byKey) running.set(deps, (byKey = new Map()));
  // Binance downloads differ by start time, so only calls with the same start share one.
  const slot = ref.source === 'binance' ? `${key}@${since}` : key;
  let download = byKey.get(slot);
  if (!download) {
    const map = byKey;
    download = refresh(ref, interval, since, deps, key, cached).finally(() => map.delete(slot));
    byKey.set(slot, download);
  }
  return download;
}
