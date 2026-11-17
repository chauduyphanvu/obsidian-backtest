import { intervalMs, YAHOO_INSIDE_DAYS } from './dsl.ts';
import { columnName, emptyBars, MAX_COLUMNS, sliceBars, type AssetRef, type Bars, type Column, type UnreadColumn } from './types.ts';

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
 * Midnight UTC of the exchange's calendar day that the moment `ms` falls on. Yahoo's `gmtoffset` is the offset in force
 * today only: in the other half of the year it puts a bar stamped at the exchange's midnight (a weekly bar, a currency
 * pair's daily bar) on the day before, so the time zone's own rules give each moment its offset. Without a zone the
 * runtime knows, today's offset is used.
 */
function exchangeDay(timeZone: unknown, fallbackOffsetMs: number): (ms: number) => number {
  if (typeof timeZone === 'string' && timeZone) {
    try {
      const format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' });
      return (ms) => {
        const parts = format.formatToParts(ms);
        const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
        return Date.UTC(part('year'), part('month') - 1, part('day'));
      };
    } catch {
      // An unknown zone name throws here; today's offset stands in.
    }
  }
  return (ms) => Math.floor((ms + fallbackOffsetMs) / DAY) * DAY;
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
  const localDay = exchangeDay(result.meta?.exchangeTimezoneName, (result.meta?.gmtoffset ?? 0) * 1000);
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

/**
 * Yahoo's intraday chart JSON to the smaller bars `magnify` looks inside daily bars with, `step` long. What Yahoo's chart
 * API was seen to do (November 2026, saved in tests/fixtures/yahoo-inside-*.json): it serves 2m to 30m bars for the last 60
 * days and 1h bars for the last 730, and answers an older request with an error; its intraday bars are adjusted for splits
 * but not for dividends, and come without an adjusted close; it leaves out the trading periods outside the regular
 * session; and `meta.tradingPeriods` gives each day's regular session, with that day's offset from UTC. A bar can come
 * with nulls, as the half-hour bar of a day that closes early does, and while a session is open the last bar is the latest
 * trade, with its own time. So a day is kept only when its bars cover its whole session, one after another, every one
 * a valid bar, and the session is over by `now`; the bars of other days are left out, and the bars of those days count as
 * missing. Times are the exchange's clock read as UTC, as parseYahoo dates its daily bars by the exchange's day, so each
 * day's bars fall inside that day's daily bar.
 */
export function parseYahooInside(json: string, now: number, step: number): Bars {
  const body = JSON.parse(json);
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error(body?.chart?.error?.description ?? 'Yahoo returned no data');
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const days: unknown = result.meta?.tradingPeriods;
  const bars = emptyBars();
  if (!Array.isArray(days)) return bars;
  let i = 0;
  for (const day of days as { start: number; end: number; gmtoffset: number }[][]) {
    const kept = emptyBars();
    let whole = Array.isArray(day) && day.length > 0;
    for (const session of whole ? day : []) {
      const [start, end, offset] = [session.start * 1000, session.end * 1000, session.gmtoffset * 1000];
      let next = start;
      while (i < ts.length && ts[i] * 1000 < start) i++;
      for (; i < ts.length && ts[i] * 1000 < end; i++) {
        const [o, h, l, c] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]];
        if (ts[i] * 1000 !== next || [o, h, l, c].some((x) => typeof x !== 'number')) {
          whole = false;
          continue;
        }
        const length = kept.t.length;
        push(kept, next + offset, o, h, l, c, q.volume?.[i] ?? 0);
        if (kept.t.length === length) whole = false;
        next += step;
      }
      if (next < end || end > now) whole = false;
    }
    if (!whole) continue;
    for (let k = 0; k < kept.t.length; k++) push(bars, kept.t[k], kept.o[k], kept.h[k], kept.l[k], kept.c[k], kept.v[k]);
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

/** 31/01/2024, 01/31/2024, 31-01-2024, 01-31-2024 or 31.01.2024, optionally followed by a time. */
const SLASHED = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
/** A zone at the end of a date and time: Z, or an offset such as -05:00 or +0100 after the time of day, never a year. */
const ZONE = /\d:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[zZ]|[+-]\d{2}:?\d{2})$/;

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
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : ZONE.test(s) ? s : s.replace(' ', 'T') + 'Z';
  return Date.parse(iso);
}

/** Dates with slashes or dashes are month first unless some first number is above 12 and no second number is. Dotted ones are always day first. */
function slashedDatesAreDayFirst(values: string[]): boolean {
  let first = false;
  let second = false;
  for (const v of values) {
    const m = SLASHED.exec(v);
    if (!m || m[2] === '.') continue;
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

/** A number in a column beyond the prices: digits with an optional point and exponent, nothing else (no hex, no "Infinity"). */
const COLUMN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const columnCell = (s: string | undefined): number => {
  const n = s !== undefined && COLUMN_NUMBER.test(s) ? Number(s) : NaN;
  return Number.isFinite(n) ? n : NaN;
};

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

const PRICE_HEADERS: readonly string[] = [...CSV_HEADERS.open, ...CSV_HEADERS.high, ...CSV_HEADERS.low, ...CSV_HEADERS.close];

/** A header as the CSV helper compares it: capitals, angle brackets, underscores and dots do not matter. */
export const tidyHeader = (name: string): string => name.toLowerCase().replace(/[<>_.]/g, ' ').replace(/\s+/g, ' ').trim();

/** The headers the CSV helper takes for each part of a price file, best first, compared after tidyHeader. */
export const CSV_GUESSES = {
  open: [/^open$/, /^open\b/, /^opening\b/],
  high: [/^high$/, /^high\b/, /^highest\b/],
  low: [/^low$/, /^low\b/, /^lowest\b/],
  close: [/^close$/, /^close\b/, /^closing\b/, /^(last|price|settle|value|nav)$/, /^(last|price)\b/],
  volume: [/^volume$/, /^vol\b/, /^volume\b/],
  adjClose: [/^adj close$/, /^adjusted close$/, /^adjclose$/],
};

const PRICE_GUESSES = [...CSV_GUESSES.open, ...CSV_GUESSES.high, ...CSV_GUESSES.low, ...CSV_GUESSES.close, ...CSV_GUESSES.adjClose];

/**
 * Whether a header looks like a price by the CSV helper's guesses, such as "Price", "Close Price", "Last" or "Adj Close".
 * A file with one is a price file the reader cannot read as it is, which the helper can clean, never a file of signals.
 */
const looksLikePrice = (header: string): boolean => PRICE_GUESSES.some((p) => p.test(tidyHeader(header)));

/**
 * The columns of a header line that can be columns a rule reads: every header with something in it that the reader does not
 * use as a date or a price. A file with no price header at all uses none of them as a price, so there `volume` and
 * `adj close` are columns like the rest.
 */
function extraColumns(names: string[]): number[] {
  const header = names.map((h) => h.toLowerCase());
  const priced = header.some((h) => PRICE_HEADERS.includes(h));
  const used: readonly string[] = priced ? Object.values(CSV_HEADERS).flat() : CSV_HEADERS.date;
  return names.flatMap((h, i) => (h !== '' && !used.includes(header[i]) ? [i] : []));
}

/**
 * The names a rule can use for the columns of a CSV file, read from its first line alone: what `column(...)` would
 * accept, before the rows say which of them hold numbers. Empty for any text that is not a header.
 */
export function csvColumnNames(text: string): string[] {
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/).find((l) => l.trim());
  if (!first) return [];
  const names = splitLine(first, detectSeparator(first));
  const out: string[] = [];
  for (const i of extraColumns(names)) {
    const name = columnName(names[i]);
    if (name && !out.includes(name)) out.push(name);
  }
  return out.slice(0, MAX_COLUMNS);
}

/** Quoted header names in a sentence: "A", "A and B", "A, B and C". */
function quotedList(names: string[]): string {
  const q = names.map((n) => `"${n}"`);
  return q.length < 2 ? q.join('') : `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
}

/**
 * The columns beyond date and prices that hold numbers, lined up with the rows kept, and the ones that cannot be read by
 * name. A header that clashes with another after `columnName` makes none of them readable: a rule would have to guess.
 * Those problems are kept with the bars, not raised, so a file that read before reads the same now.
 */
function readColumns(names: string[], rows: string[][]): Pick<Bars, 'columns' | 'unread'> {
  const numeric = extraColumns(names)
    .map((i) => ({ i, header: names[i], name: columnName(names[i]) }))
    .filter((c) => c.name !== '' && rows.some((r) => !Number.isNaN(columnCell(r[c.i]))));
  const unread: UnreadColumn[] = [];
  const readable: typeof numeric = [];
  for (const c of numeric) {
    const same = numeric.filter((o) => o.name === c.name);
    if (same.length > 1) {
      if (same[0] === c) unread.push({ name: c.name, why: `${same.length} columns would all be called ${c.name}: ${quotedList(same.map((o) => o.header))}. Rename all but one in the file` });
    } else if (readable.length < MAX_COLUMNS) readable.push(c);
    else unread.push({ name: c.name, why: `only the first ${MAX_COLUMNS} columns of a file can be read`, limit: true });
  }
  const out: Pick<Bars, 'columns' | 'unread'> = {};
  if (readable.length) out.columns = readable.map((c): Column => ({ name: c.name, header: c.header, v: rows.map((r) => columnCell(r[c.i])) }));
  if (unread.length) out.unread = unread;
  return out;
}

/**
 * CSV with a header row naming a date or time column and open, high, low, close (volume optional).
 * Separators can be commas, semicolons or tabs; dates can be ISO, MM/DD/YYYY, DD/MM/YYYY (when some day is above 12), the
 * same two with dashes, or DD.MM.YYYY.
 * Every other column that holds numbers is kept as a column a rule can read (see `columnName` for how a header becomes a
 * name). A file with a date and such columns but no price header at all has no prices: it is kept as `unpriced`.
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
  const noPrices = ti >= 0 && [oi, hi, li, ci].every((i) => i < 0) && !names.some((h, i) => i !== ti && looksLikePrice(h));
  const lackPrices = new Error(`The CSV needs a header row with date, open, high, low and close columns, but has no ${missing.join(', ')} column`);
  if (missing.length && !(noPrices && extraColumns(names).length > 0)) throw lackPrices;

  const fields = lines.slice(1).map((line) => splitLine(line, sep));
  const dayFirst = slashedDatesAreDayFirst(fields.map((f) => f[ti] ?? ''));
  const bars = emptyBars();
  const kept: string[][] = [];

  if (noPrices) {
    const dated = fields.map((f) => ({ t: parseTime(f[ti] ?? '', dayFirst), f })).filter((r) => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
    for (const r of dated) {
      if (bars.t.length && r.t <= bars.t[bars.t.length - 1]) continue;
      bars.t.push(r.t);
      kept.push(r.f);
    }
    if (bars.t.length === 0) throw new Error(`The CSV has no usable rows: no date in the "${names[ti]}" column could be read. Dates should look like 2024-01-31`);
    for (const k of ['o', 'h', 'l', 'c'] as const) bars[k] = bars.t.map(() => NaN);
    bars.v = bars.t.map(() => 0);
    const read = readColumns(names, kept);
    if (!read.columns && !read.unread) throw lackPrices;
    return { ...bars, ...read, unpriced: true };
  }

  const rows = fields.map((f) => {
    const c = num(f[ci]);
    const adj = ai >= 0 && num(f[ai]) > 0 ? num(f[ai]) / c : 1;
    return { t: parseTime(f[ti] ?? '', dayFirst), o: num(f[oi]) * adj, h: num(f[hi]) * adj, l: num(f[li]) * adj, c: c * adj, v: vi >= 0 ? num(f[vi]) : 0, f };
  });
  // A NaN time would make the comparator's answer NaN, and the sort undefined.
  const dated = rows.filter((r) => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
  for (const r of dated) {
    const before = bars.t.length;
    push(bars, r.t, r.o, r.h, r.l, r.c, r.v);
    if (bars.t.length > before) kept.push(r.f);
  }
  if (bars.t.length > 0) return { ...bars, ...readColumns(names, kept) };

  if (dated.length === 0) throw new Error(`The CSV has no usable rows: no date in the "${names[ti]}" column could be read. Dates should look like 2024-01-31`);
  for (const [name, key] of [[names[oi], 'o'], [names[hi], 'h'], [names[li], 'l'], [names[ci], 'c']] as const) {
    if (dated.every((r) => !Number.isFinite(r[key]))) throw new Error(`The CSV has no usable rows: no number in the "${name}" column could be read`);
  }
  throw new Error('The CSV has no usable rows: every row has a price at or below zero, or a high or low that does not contain the open and close');
}

/** The pieces parseCsv reads a file with, for code that has to agree with it exactly. */
export { SLASHED as CSV_SLASHED_DATE, detectSeparator as detectCsvSeparator, parseTime as parseCsvTime, slashedDatesAreDayFirst, splitLine as splitCsvLine };

async function fetchYahoo(ref: AssetRef, interval: string, deps: DataDeps): Promise<Bars> {
  const now = Math.floor(deps.now() / 1000);
  // Intraday bars come for a recent window only, asked for whole (see insideReach).
  const days = YAHOO_INSIDE_DAYS[interval];
  const path =
    `/v8/finance/chart/${encodeURIComponent(ref.id)}` +
    (days
      ? `?period1=${insideReach('yahoo', interval, deps.now()) / 1000}&period2=${now}&interval=${interval}`
      : `?period1=0&period2=${now}&interval=${interval === '1w' ? '1wk' : '1d'}&events=div%2Csplit&includeAdjustedClose=true`);
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
      return days ? parseYahooInside(text, deps.now(), intervalMs(interval)) : parseYahoo(text, deps.now(), interval === '1w');
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

/**
 * Fetches, saves and returns fresh bars; on failure falls back to the saved copy when there is one. Bars before `keepFrom`
 * are not kept, so a saved series that grows at every refresh stays within it.
 */
async function refresh(ref: AssetRef, interval: string, since: number, deps: DataDeps, key: string, cached: Cached | null, keepFrom = -Infinity): Promise<Loaded> {
  try {
    let bars = ref.source === 'yahoo' ? await fetchYahoo(ref, interval, deps) : await fetchBinance(ref, interval, since, cached?.bars ?? null, deps);
    if (keepFrom > -Infinity) bars = barsFrom(bars, keepFrom);
    if (bars.t.length === 0) throw new Error('no bars returned');
    const fetched = deps.now();
    await deps.cacheWrite(key, JSON.stringify({ fetched, since: Math.max(cached?.since ?? since, keepFrom), bars } satisfies Cached));
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
export async function loadBars(
  ref: AssetRef,
  interval: string,
  since: number,
  deps: DataDeps,
  force = false,
  opts?: { freshForMs?: number; keepFrom?: number; key?: string },
): Promise<Loaded> {
  if (ref.source === 'csv') {
    const text = await deps.readVaultFile(ref.id);
    if (text === null) throw new Error(`No file at ${ref.id}`);
    let bars: Bars;
    try {
      bars = parseCsv(text);
    } catch (e) {
      // A block can read several files, so the message says which one.
      throw e instanceof Error ? new Error(e.message.replace(/^The CSV\b/, `The CSV file ${ref.id}`)) : e;
    }
    return loaded('csv', bars, deps.now());
  }

  const key = opts?.key ?? cacheKey(ref, interval);
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
    download = refresh(ref, interval, since, deps, key, cached, opts?.keepFrom).finally(() => map.delete(slot));
    byKey.set(slot, download);
  }
  return download;
}

/** The name a source's bars of one ticker and interval are saved under. */
const cacheKey = (ref: AssetRef, interval: string): string => `${ref.source}-${ref.id}-${interval}`.replace(/[^A-Za-z0-9._-]/g, '_');

/** The bars at or after `since`. */
export function barsFrom(bars: Bars, since: number): Bars {
  let i = 0;
  while (i < bars.t.length && bars.t[i] < since) i++;
  // Through sliceBars, so a CSV file's extra columns stay with their bars.
  return sliceBars(bars, i);
}

/**
 * The most smaller bars `magnify` loads and saves for one ticker: 69 days of 1m bars, 347 days of 5m bars, 2.9 years of
 * 15m bars or 11.4 years of 1h bars. It is 100 of Binance's pages, about 6 MB saved, and 6 MB in memory while a block holds it.
 */
export const INSIDE_BARS = 100_000;

/**
 * The earliest time a source's smaller bars of size `interval` are loaded from at `now` for magnify, counted back from the
 * start of the day in UTC, so runs on one day load the same bars: Yahoo's intraday window with a day to spare (its limit
 * is counted from the moment of the request), or INSIDE_BARS bars on Binance. Yahoo's daily bars are loaded from the start.
 */
export function insideReach(source: AssetRef['source'], interval: string, now: number): number {
  const today = Math.floor(now / DAY) * DAY;
  if (source === 'binance') return today - INSIDE_BARS * intervalMs(interval);
  const days = YAHOO_INSIDE_DAYS[interval];
  return days ? today - (days - 1) * DAY : 0;
}

/**
 * The smaller bars `magnify` looks inside `ref`'s bars with, from `since`: loaded and saved like a ticker's own bars, under
 * their own interval, with Binance's kept to INSIDE_BARS (insideReach) as later refreshes add to them. Binance's are saved
 * apart from a block's own bars of that interval, which cutting them would make too short for that block, and a file a
 * block saved would be too long to cut here. Yahoo's are never cut, so its daily bars inside weekly ones share the daily
 * file. A file of Binance's smaller bars saved under the shared name before they had their own is left to blocks of that
 * interval, as any saved file is.
 */
export function loadInsideBars(ref: AssetRef, interval: string, since: number, deps: DataDeps, force = false, opts?: { freshForMs?: number }): Promise<Loaded> {
  const binance = ref.source === 'binance';
  const keepFrom = binance ? insideReach('binance', interval, deps.now()) : undefined;
  const key = binance ? `${cacheKey(ref, interval)}-inside` : undefined;
  return loadBars({ ...ref, name: `the ${interval} bars of ${ref.name}` }, interval, since, deps, force, { ...opts, keepFrom, key });
}
