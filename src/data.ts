import { intervalMs, YAHOO_INSIDE_DAYS } from './dsl.ts';
import { DAY, isoDate } from './format.ts';
import { parseFred, type FredSeries } from './fred.ts';
import { columnName, emptyBars, MAX_COLUMNS, sliceBars, type AssetRef, type Bars, type Column, type KeyedService, type Source, type UnreadColumn } from './types.ts';

const FRESH_FOR = 6 * 3_600_000;
/** Yahoo hosts in the order they are tried, with the wait before each retry. */
const YAHOO_HOSTS = ['query1', 'query2', 'query1'];
const YAHOO_WAITS = [500, 1500];
/** With "When Yahoo fails, use Tiingo", a saved Yahoo copy younger than this is used before Tiingo is asked. */
const YAHOO_SAVED_FIRST = 3 * DAY;
/** The first day asked of Tiingo, so its answer is a ticker's whole history. */
const TIINGO_START = '1900-01-01';

/** The settings that choose each service's API key, as the settings tab names them. */
export const KEY_SETTING: Record<KeyedService, string> = { tiingo: 'Tiingo API key', fred: 'FRED API key' };
const SERVICE: Record<KeyedService, string> = { tiingo: 'Tiingo', fred: 'FRED' };

export interface DataDeps {
  /** GET a URL with any extra headers and return its body; rejects on a network error or a non-2xx status. */
  fetchText(url: string, headers?: Record<string, string>): Promise<string>;
  /** Reads a vault file, or null when it does not exist. */
  readVaultFile(path: string): Promise<string | null>;
  cacheRead(key: string): Promise<string | null>;
  cacheWrite(key: string, text: string): Promise<void>;
  now(): number;
  /** Waits between retries; without it retries go out straight away. */
  sleep?: (ms: number) => Promise<void>;
  /** The API key of a service, read from the user's secret storage when a request is about to go out; null when none is set. */
  secret?: (service: KeyedService) => string | null;
  /** The environment variable a service's key is read from, when keys come from there instead of the plugin's settings. */
  keyVariable?: (service: KeyedService) => string;
  /** Whether a Yahoo ticker that fails to load may come from Tiingo instead: the setting "When Yahoo fails, use Tiingo". */
  tiingoFallback?: () => boolean;
  /** Parses a CSV file's text as parseCsv does, somewhere else, such as a background worker; without it the text is parsed here. */
  parseCsv?: (text: string, path: string) => Promise<Bars>;
}

export interface Loaded {
  bars: Bars;
  /** Set when the network failed and older cached bars were used instead, or when Tiingo stood in for Yahoo. */
  warning: string | null;
  /** What the reader should know about how the bars are dated, which needs no new download (fred.ts); null for nothing. */
  note: string | null;
  /** Where the bars came from: Tiingo, when it stood in for a Yahoo ticker. */
  source: Source;
  /** Time of the last bar. */
  through: number;
  /** When these bars were fetched (csv: now). */
  fetched: number;
  /** True when a refresh failed and an older saved copy is being used. */
  stale: boolean;
}

/**
 * Why a ticker's prices could not load, when there is a next step that can put it right: a ticker its source does not know
 * (`ref` as the block names it), a service's API key that is not set or that the service did not accept (`setting` names
 * where it is chosen), a CSV file that is not in the vault, or no answer from the network and no saved copy.
 */
export type PriceFailure =
  | { kind: 'ticker'; ref: string; source: Source }
  | { kind: 'key'; service: KeyedService; setting: string; rejected: boolean }
  | { kind: 'csv'; path: string }
  | { kind: 'offline' };

/** An error that says why prices could not load (PriceFailure). */
export class PriceError extends Error {
  readonly failure: PriceFailure;

  constructor(message: string, failure: PriceFailure) {
    super(message);
    this.name = 'PriceError';
    this.failure = failure;
  }
}

/** The failure an error carries, read as data, so an error rebuilt from a copy of it carries it too; null for any other error. */
export function priceFailure(e: unknown): PriceFailure | null {
  const f = (e as { failure?: { kind?: unknown } } | null)?.failure;
  return f && ['ticker', 'key', 'csv', 'offline'].includes(f.kind as string) ? (f as PriceFailure) : null;
}

/** A request that got no answer at all: no network, or a host that cannot be reached. */
class NoAnswer extends Error {}

/** A GET through deps.fetchText. A rejection that is not an HTTP status (`HTTP 503`, as fetchText words one) got no answer. */
async function get(deps: DataDeps, url: string, headers?: Record<string, string>): Promise<string> {
  try {
    return await deps.fetchText(url, headers);
  } catch (e) {
    throw /^HTTP \d{3}\b/.test(message(e)) ? e : new NoAnswer(message(e));
  }
}

/** A Yahoo request that failed and goes out again: the try that comes next, of how many, and the wait before it goes; 0 once it has gone. */
export interface Retry {
  attempt: number;
  of: number;
  wait: number;
}

interface Cached {
  fetched: number;
  /** The `since` the bars were fetched for. */
  since: number;
  bars: Bars;
  /** The note that came with a FRED series (Loaded.note). */
  note?: string;
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
  return yahooBars(json, now, weekly, (r, i, c) => (r.adj[i] != null ? r.adj[i]! / c : 1));
}

/**
 * Yahoo chart JSON to daily bars as they traded that day, for comparing a broker's fills with: Yahoo's prices are adjusted
 * for splits but not for dividends ("Close price adjusted for splits", its historical data page says), so each bar is
 * multiplied back by the splits after it, from the chart's split events.
 */
export function parseYahooRaw(json: string, now: number): Bars {
  return yahooBars(json, now, false, (r, i) => {
    let f = 1;
    for (const s of r.splits) if (s.t > r.ts[i] * 1000 && s.numerator > 0 && s.denominator > 0) f *= s.numerator / s.denominator;
    return f;
  });
}

interface YahooChart {
  ts: number[];
  adj: (number | null)[];
  splits: { t: number; numerator: number; denominator: number }[];
}

/** Yahoo chart JSON to bars, each price of row `i` (close `c`) multiplied by `factor`, without a bar that is still trading. */
function yahooBars(json: string, now: number, weekly: boolean, factor: (r: YahooChart, i: number, c: number) => number): Bars {
  const body = JSON.parse(json);
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error(body?.chart?.error?.description ?? 'Yahoo sent no data');
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const splits = Object.values((result.events?.splits ?? {}) as Record<string, { date?: number; numerator?: number; denominator?: number }>).map((s) => ({
    t: Number(s.date) * 1000,
    numerator: Number(s.numerator),
    denominator: Number(s.denominator),
  }));
  const chart: YahooChart = { ts, adj: result.indicators?.adjclose?.[0]?.adjclose ?? [], splits };
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
    const f = factor(chart, i, c);
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
  if (!result) throw new Error(body?.chart?.error?.description ?? 'Yahoo sent no data');
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

/** Minutes after midnight in New York when the US exchanges' regular session ends. */
const US_CLOSE = 16 * 60;

const NEW_YORK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });

/** The day in New York at the moment `ms`, as midnight UTC of that date, and the minutes since midnight there. */
function newYork(ms: number): { day: number; minutes: number } {
  const parts = NEW_YORK.formatToParts(ms);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { day: Date.UTC(part('year'), part('month') - 1, part('day')), minutes: part('hour') * 60 + part('minute') };
}

/** A number Tiingo sent, or NaN for none. */
const field = (x: unknown): number => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN);

/**
 * Daily bars to weekly ones stamped as Yahoo stamps its own: at the Monday that starts the week, a holiday or not, with the
 * first open, the highest high, the lowest low, the last close and the volume of the week's days. A week counts from the
 * Monday after it, `today` being the day in New York, as parseYahoo counts Yahoo's.
 */
function weeksOf(daily: Bars, today: number): Bars {
  const out = emptyBars();
  for (let i = 0; i < daily.t.length; ) {
    const day = Math.floor(daily.t[i] / DAY);
    // Day 0 of the epoch was a Thursday.
    const monday = (day - ((((day + 3) % 7) + 7) % 7)) * DAY;
    const next = monday + 7 * DAY;
    if (next > today) break;
    let [h, l, v, j] = [-Infinity, Infinity, 0, i];
    for (; j < daily.t.length && daily.t[j] < next; j++) {
      h = Math.max(h, daily.h[j]);
      l = Math.min(l, daily.l[j]);
      v += daily.v[j];
    }
    push(out, monday, daily.o[i], h, l, daily.c[j - 1], v);
    i = j;
  }
  return out;
}

/**
 * Tiingo's daily prices JSON to bars adjusted for splits and dividends (its adjOpen, adjHigh, adjLow, adjClose and
 * adjVolume, or the raw value scaled by adjClose / close where one is missing), each dated by its exchange day. Today's row
 * counts once the regular session in New York has closed. Weekly bars are made from the daily ones (weeksOf).
 */
export function parseTiingo(json: string, now: number, weekly = false): Bars {
  const daily = emptyBars();
  const ny = tiingoRows(json, now, (r, t) => {
    const close = field(r.close);
    const f = field(r.adjClose) > 0 && close > 0 ? field(r.adjClose) / close : 1;
    const price = (adjusted: string, raw: string) => (Number.isFinite(field(r[adjusted])) ? field(r[adjusted]) : field(r[raw]) * f);
    const volume = Number.isFinite(field(r.adjVolume)) ? field(r.adjVolume) : field(r.volume);
    push(daily, t, price('adjOpen', 'open'), price('adjHigh', 'high'), price('adjLow', 'low'), price('adjClose', 'close'), volume);
  });
  return weekly ? weeksOf(daily, ny.day) : daily;
}

/** Tiingo's daily prices JSON to bars as they traded that day: its open, high, low and close, which no later dividend or split changes. */
export function parseTiingoRaw(json: string, now: number): Bars {
  const daily = emptyBars();
  tiingoRows(json, now, (r, t) => push(daily, t, field(r.open), field(r.high), field(r.low), field(r.close), field(r.volume)));
  return daily;
}

/** Calls `row` for each row of Tiingo's daily prices whose New York session has closed, with its exchange day; gives the time in New York. */
function tiingoRows(json: string, now: number, row: (r: Record<string, unknown>, t: number) => void): ReturnType<typeof newYork> {
  const rows: unknown = JSON.parse(json);
  if (!Array.isArray(rows)) {
    const detail = (rows as { detail?: unknown } | null)?.detail;
    throw new Error(typeof detail === 'string' ? detail : 'Tiingo sent no data');
  }
  const ny = newYork(now);
  const last = ny.minutes >= US_CLOSE ? ny.day : ny.day - DAY;
  for (const r of rows as Record<string, unknown>[]) {
    const m = typeof r?.date === 'string' ? r.date.match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
    const t = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
    if (t <= last) row(r, t);
  }
  return ny;
}

/** Binance kline rows to bars, without the kline that has not closed yet. */
export function parseBinance(json: string, now: number): Bars {
  const rows = JSON.parse(json);
  if (!Array.isArray(rows)) throw new Error(rows?.msg ?? 'Binance sent no data');
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
  // Line by line to the first with text: splitting a file of a million rows takes the main thread tens of milliseconds.
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  let first = '';
  for (let at = 0; at < body.length && !first.trim(); ) {
    const end = body.indexOf('\n', at);
    first = body.slice(at, end < 0 ? body.length : end).replace(/\r$/, '');
    at = end < 0 ? body.length : end + 1;
  }
  if (!first.trim()) return [];
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
      if (same[0] === c) unread.push({ name: c.name, why: `${same.length} columns have the name ${c.name}: ${quotedList(same.map((o) => o.header))}. In the file, give each of them a different header` });
    } else if (readable.length < MAX_COLUMNS) readable.push(c);
    else unread.push({ name: c.name, why: `a rule can read only the first ${MAX_COLUMNS} columns of a file`, limit: true });
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
  const lackPrices = new Error(`The CSV must have a header row with date, open, high, low and close columns, but it has no ${missing.join(', ')} column`);
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
    if (bars.t.length === 0) throw new Error(`The CSV has no rows with a date that the plugin can read in the "${names[ti]}" column. Write dates as 2024-01-31`);
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

  if (dated.length === 0) throw new Error(`The CSV has no rows with a date that the plugin can read in the "${names[ti]}" column. Write dates as 2024-01-31`);
  for (const [name, key] of [[names[oi], 'o'], [names[hi], 'h'], [names[li], 'l'], [names[ci], 'c']] as const) {
    if (dated.every((r) => !Number.isFinite(r[key]))) throw new Error(`The CSV has no rows with a number that the plugin can read in the "${name}" column`);
  }
  throw new Error('The CSV has no rows that the plugin can use. Each row has a price of zero or less, or a high or low that does not contain the open and close');
}

/** The pieces parseCsv reads a file with, for code that has to agree with it exactly. */
export { SLASHED as CSV_SLASHED_DATE, detectSeparator as detectCsvSeparator, parseTime as parseCsvTime, slashedDatesAreDayFirst, splitLine as splitCsvLine };

async function fetchYahoo(ref: AssetRef, interval: string, deps: DataDeps, raw = false, tell?: (retry: Retry) => void): Promise<Bars> {
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
    if (attempt > 0) {
      const next = { attempt: attempt + 1, of: YAHOO_HOSTS.length };
      tell?.({ ...next, wait: YAHOO_WAITS[attempt - 1] });
      await deps.sleep?.(YAHOO_WAITS[attempt - 1]);
      tell?.({ ...next, wait: 0 });
    }
    let text: string;
    try {
      text = await get(deps, `https://${YAHOO_HOSTS[attempt]}.finance.yahoo.com${path}`);
    } catch (e) {
      failure = e;
      continue;
    }
    // A throttled or broken answer is plain text or HTML; Yahoo's own explanations are JSON, and trying again won't change them.
    if (!text.trimStart().startsWith('{')) {
      failure = new Error('Yahoo did not send price data');
      continue;
    }
    try {
      if (days) return parseYahooInside(text, deps.now(), intervalMs(interval));
      return raw ? parseYahooRaw(text, deps.now()) : parseYahoo(text, deps.now(), interval === '1w');
    } catch (e) {
      if (/"code"\s*:\s*"Not Found"/.test(text)) throw unknown(ref, `Yahoo has no prices for ${ref.name}. Make sure that the ticker is correct.`);
      throw e;
    }
  }
  throw failure;
}

async function fetchBinance(ref: AssetRef, interval: string, since: number, have: Bars | null, deps: DataDeps): Promise<Bars> {
  const bars = have ?? emptyBars();
  let start = bars.t.length ? bars.t[bars.t.length - 1] + 1 : since;
  for (let pages = 0; ; pages++) {
    if (pages === 300) throw new Error('there is too much history for this interval. Move the "from" date forward');
    // data-api.binance.vision serves public market data where api.binance.com is region-blocked.
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(ref.id)}&interval=${interval}&startTime=${start}&limit=1000`;
    const text = await get(deps, url);
    let page: Bars;
    try {
      page = parseBinance(text, deps.now());
    } catch (e) {
      if (/"code"\s*:\s*-1121\b/.test(text)) throw unknown(ref, `Binance has no market with the name ${ref.name}. Make sure that the symbol is correct, for example BTCUSDT.`);
      throw e;
    }
    for (let i = 0; i < page.t.length; i++) push(bars, page.t[i], page.o[i], page.h[i], page.l[i], page.c[i], page.v[i]);
    if ((JSON.parse(text) as unknown[]).length < 1000 || page.t.length === 0) return bars;
    start = page.t[page.t.length - 1] + 1;
  }
}

/** A message with the query taken off every web address in it, so no key a request carried in its URL is shown. */
export const withoutQueries = (text: string): string => text.replace(/\b(https?:\/\/[^\s?#"'<>]*)\?[^\s"'<>]*/gi, '$1');

/** A ticker its source does not know: no other host, source or saved copy can fix it. */
const unknown = (ref: AssetRef, text: string): PriceError => new PriceError(text, { kind: 'ticker', ref: ref.name, source: ref.source });

/** A service's key not set, or not accepted (`rejected`). */
const keyProblem = (service: KeyedService, deps: DataDeps, text: string, rejected: boolean): PriceError =>
  new PriceError(text, { kind: 'key', service, setting: deps.keyVariable ? deps.keyVariable(service) : KEY_SETTING[service], rejected });

/** The API key a request to `service` needs, or an error that names the setting to choose it with. */
function keyFor(service: KeyedService, ref: AssetRef, deps: DataDeps): string {
  const key = deps.secret?.(service)?.trim();
  if (!key) {
    const where = deps.keyVariable ? `Set ${deps.keyVariable(service)} in the environment.` : `Select the secret with the key in the plugin setting "${KEY_SETTING[service]}".`;
    throw keyProblem(service, deps, `The plugin must have a ${SERVICE[service]} API key to load ${ref.name}. ${where}`, false);
  }
  return key;
}

/** Where the user put a service's key, for a message that says to check it. */
const keyPlace = (service: KeyedService, deps: DataDeps): string =>
  deps.keyVariable ? deps.keyVariable(service) : `the secret in the plugin setting "${KEY_SETTING[service]}"`;

/** Runs a request that carries `key`, so that no error it ends in holds the key or a web address's query. */
async function keyed<T>(key: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (e) {
    // These messages are the plugin's own, with no key in them.
    if (e instanceof PriceError) throw e;
    const clean = withoutQueries(message(e).split(key).join('…'));
    throw e instanceof NoAnswer ? new NoAnswer(clean) : new Error(clean);
  }
}

/** The text of a field of a JSON body, or undefined. */
function said(text: string, name: string): string | undefined {
  try {
    const v = (JSON.parse(text) as Record<string, unknown> | null)?.[name];
    return typeof v === 'string' ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** A ticker's whole daily history from Tiingo, with the key in the Authorization header only. */
async function fetchTiingo(ref: AssetRef, interval: string, deps: DataDeps, raw = false): Promise<Bars> {
  const key = keyFor('tiingo', ref, deps);
  return keyed(key, async () => {
    const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ref.id)}/prices?startDate=${TIINGO_START}&resampleFreq=daily`;
    const text = await get(deps, url, { Authorization: `Token ${key}` });
    if (!/^\s*[[{]/.test(text)) throw new Error('Tiingo did not send price data');
    try {
      return raw ? parseTiingoRaw(text, deps.now()) : parseTiingo(text, deps.now(), interval === '1w');
    } catch (e) {
      const detail = said(text, 'detail');
      if (detail === undefined) throw e;
      if (/not\s*found/i.test(detail)) throw unknown(ref, `Tiingo has no prices for ${ref.name}. Make sure that the ticker is correct.`);
      if (/token|api key|auth/i.test(detail)) throw keyProblem('tiingo', deps, `Tiingo did not accept the API key. Make sure that ${keyPlace('tiingo', deps)} is correct`, true);
      throw new Error(`Tiingo sent this message: ${detail}`);
    }
  });
}

/** Publication days one first-release answer covers: FRED refuses a real-time period with more than 2,000. */
const FRED_DAYS_AT_ONCE = 1500;

/**
 * A FRED series, each value dated by its first release (fred.ts): the days ALFRED has it published on; the series as it
 * stood on the first of them, which holds its history from before ALFRED; then each later observation as first released
 * (`output_type=4`, which never repeats what the first day held), a window of days at a time. FRED takes the key only
 * in the query, so every error is cleaned of it.
 */
async function fetchFred(ref: AssetRef, deps: DataDeps): Promise<FredSeries> {
  const key = keyFor('fred', ref, deps);
  return keyed(key, async () => {
    const ask = async (path: string, query: string): Promise<Record<string, unknown>> => {
      const text = await get(
        deps,
        `https://api.stlouisfed.org/fred/series/${path}?series_id=${encodeURIComponent(ref.id)}&api_key=${encodeURIComponent(key)}&file_type=json${query}`,
      );
      if (!text.trimStart().startsWith('{')) throw new Error('FRED did not send series data');
      const error = said(text, 'error_message');
      if (error !== undefined) {
        if (/does not exist/i.test(error)) throw unknown(ref, `FRED has no series with the name ${ref.name}. Make sure that the series ID is correct, for example T10Y2Y.`);
        if (/api_key/i.test(error)) throw keyProblem('fred', deps, `FRED did not accept the API key. Make sure that ${keyPlace('fred', deps)} is correct`, true);
        throw new Error(`FRED sent this message: ${error.replace(/\s+/g, ' ')}`);
      }
      return JSON.parse(text) as Record<string, unknown>;
    };
    const rows = (body: Record<string, unknown>): unknown[] => (Array.isArray(body.observations) ? body.observations : []);

    const days: string[] = [];
    for (;;) {
      const page = await ask('vintagedates', `&limit=10000&offset=${days.length}`);
      const got = Array.isArray(page.vintage_dates) ? page.vintage_dates.filter((d): d is string => typeof d === 'string') : [];
      days.push(...got);
      if (got.length === 0 || days.length >= Number(page.count)) break;
    }
    if (days.length === 0) throw new Error(`FRED does not tell when it published ${ref.name}. Thus the plugin cannot find the dates of its values`);
    const asked = [`&realtime_start=${days[0]}&realtime_end=${days[0]}`];
    for (let i = 0; i < days.length; i += FRED_DAYS_AT_ONCE) {
      const end = i + FRED_DAYS_AT_ONCE < days.length ? days[i + FRED_DAYS_AT_ONCE - 1] : '9999-12-31';
      asked.push(`&output_type=4&realtime_start=${days[i]}&realtime_end=${end}`);
    }
    const answers = await Promise.all(asked.map((query) => ask('observations', query)));
    return parseFred(JSON.stringify({ observations: answers.flatMap(rows) }), ref.name);
  });
}

/** A ticker Tiingo can stand in for: a Yahoo ticker of a US listing, with no `^`, dot suffix, `=` or currency after a dash. */
const US_LISTING = /^[A-Z0-9]+(?:-[A-Z]{1,2})?$/;

function tiingoStandsIn(ref: AssetRef, interval: string, deps: DataDeps): boolean {
  return ref.source === 'yahoo' && (interval === '1d' || interval === '1w') && US_LISTING.test(ref.id) && deps.tiingoFallback?.() === true;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function loaded(source: Source, bars: Bars, fetched: number, warning: string | null = null, stale = false, note: string | null = null): Loaded {
  // Whether bars are values and not prices is the source's to say, never a saved file's.
  let own = bars;
  if (source === 'fred' && !bars.values) own = { ...bars, values: true };
  else if (source !== 'fred' && bars.values) {
    const { values: _, ...prices } = bars;
    own = prices;
  }
  return { bars: own, warning, note, source, through: own.t[own.t.length - 1], fetched, stale };
}

async function fetchBars(ref: AssetRef, interval: string, since: number, cached: Cached | null, deps: DataDeps, raw = false, tell?: (retry: Retry) => void): Promise<{ bars: Bars; note: string | null }> {
  switch (ref.source) {
    case 'yahoo':
      return { bars: await fetchYahoo(ref, interval, deps, raw, tell), note: null };
    case 'binance':
      return { bars: await fetchBinance(ref, interval, since, cached?.bars ?? null, deps), note: null };
    case 'tiingo':
      return { bars: await fetchTiingo(ref, interval, deps, raw), note: null };
    case 'fred':
      return fetchFred(ref, deps);
    case 'csv':
      throw new Error('The plugin reads a CSV file from the vault. It does not download it');
  }
}

interface RefreshOptions {
  keepFrom?: number;
  freshForMs?: number;
  force?: boolean;
  /** False keeps Tiingo from standing in for Yahoo, as for magnify's smaller bars. */
  fallback?: boolean;
  /** Prices as they traded, unadjusted (parseYahooRaw, parseTiingoRaw), for Yahoo and Tiingo. */
  raw?: boolean;
  /** Told when a Yahoo request failed and goes out again. */
  tell?: (retry: Retry) => void;
}

/**
 * Fetches, saves and returns fresh bars; on failure falls back to the saved copy when there is one. Bars before `keepFrom`
 * are not kept, so a saved series that grows at every refresh stays within it. With "When Yahoo fails, use Tiingo", a
 * Yahoo ticker that fails takes its saved copy while that is under YAHOO_SAVED_FIRST old, then Tiingo, then an older copy.
 */
async function refresh(ref: AssetRef, interval: string, since: number, deps: DataDeps, key: string, cached: Cached | null, o: RefreshOptions = {}): Promise<Loaded> {
  const keepFrom = o.keepFrom ?? -Infinity;
  try {
    const got = await fetchBars(ref, interval, since, cached, deps, o.raw, o.tell);
    const bars = keepFrom > -Infinity ? barsFrom(got.bars, keepFrom) : got.bars;
    if (bars.t.length === 0) throw new Error('the source sent no bars');
    const fetched = deps.now();
    await deps.cacheWrite(key, JSON.stringify({ fetched, since: Math.max(cached?.since ?? since, keepFrom), bars, ...(got.note ? { note: got.note } : {}) } satisfies Cached));
    return loaded(ref.source, bars, fetched, null, false, got.note);
  } catch (e) {
    if (priceFailure(e)?.kind === 'ticker') throw e;
    const why = message(e);
    let tiingo = '';
    if (o.fallback !== false && !(cached && deps.now() - cached.fetched < YAHOO_SAVED_FIRST) && tiingoStandsIn(ref, interval, deps)) {
      try {
        const t = await loadBars({ ...ref, source: 'tiingo' }, interval, since, deps, o.force, { freshForMs: o.freshForMs, fallback: false });
        if (!t.stale) return { ...t, warning: `Cannot load ${ref.name} from Yahoo (${why}). The plugin uses the prices from Tiingo.` };
        if (!cached) return { ...t, warning: `Cannot load ${ref.name} from Yahoo (${why}) or Tiingo. The plugin uses the Tiingo prices saved on ${isoDate(t.fetched)}.` };
        tiingo = 'it has only a previous saved copy';
      } catch (f) {
        tiingo = message(f).replace(`Cannot load ${ref.name} from tiingo: `, '');
      }
    }
    if (cached) {
      return loaded(ref.source, cached.bars, cached.fetched, `Cannot download new prices for ${ref.name} (${why}). The plugin uses the prices saved on ${isoDate(cached.fetched)}.`, true, cached.note ?? null);
    }
    const failure: PriceFailure | null = e instanceof PriceError ? e.failure : e instanceof NoAnswer ? { kind: 'offline' } : null;
    // A key that is not set says only that.
    const text = failure?.kind === 'key' && !failure.rejected ? why : `Cannot load ${ref.name} from ${ref.source}: ${why}${tiingo ? `. The plugin also cannot use Tiingo: ${tiingo}` : ''}`;
    throw failure ? new PriceError(text, failure) : new Error(text);
  }
}


/** A download on its way, with whoever is to be told of its retries. */
interface Download {
  loaded: Promise<Loaded>;
  told: Set<(retry: Retry) => void>;
}

const running = new WeakMap<DataDeps, Map<string, Download>>();

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
  opts?: { freshForMs?: number; keepFrom?: number; key?: string; fallback?: boolean; raw?: boolean; onRetry?: (retry: Retry) => void },
): Promise<Loaded> {
  if (ref.source === 'csv') {
    const text = await deps.readVaultFile(ref.id);
    if (text === null) throw new PriceError(`There is no file at ${ref.id}`, { kind: 'csv', path: ref.id });
    let bars: Bars;
    try {
      bars = deps.parseCsv ? await deps.parseCsv(text, ref.id) : parseCsv(text);
    } catch (e) {
      // A block can read several files, so the message says which one.
      if (!(e instanceof Error) || !/^The CSV\b/.test(e.message)) throw e;
      throw new Error(e.message.replace(/^The CSV\b/, `The CSV file ${ref.id}`));
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
  // A cache that starts after `since` was built for a shorter run and can't serve this one. Only Binance is asked for less
  // than a whole history.
  const cached = saved !== null && saved.bars.t.length > 0 && (ref.source !== 'binance' || saved.since <= since) ? saved : null;
  if (cached && !force && deps.now() - cached.fetched < (opts?.freshForMs ?? FRESH_FOR)) return loaded(ref.source, cached.bars, cached.fetched, null, false, cached.note ?? null);

  let byKey = running.get(deps);
  if (!byKey) running.set(deps, (byKey = new Map()));
  // Binance downloads differ by start time, so only calls with the same start share one.
  const slot = ref.source === 'binance' ? `${key}@${since}` : key;
  let download = byKey.get(slot);
  if (!download) {
    const map = byKey;
    const told = new Set<(retry: Retry) => void>();
    const tell = (retry: Retry) => told.forEach((listen) => listen(retry));
    const pending = refresh(ref, interval, since, deps, key, cached, { keepFrom: opts?.keepFrom, freshForMs: opts?.freshForMs, force, fallback: opts?.fallback, raw: opts?.raw, tell }).finally(() =>
      map.delete(slot),
    );
    download = { loaded: pending, told };
    byKey.set(slot, download);
  }
  if (opts?.onRetry) download.told.add(opts.onRetry);
  return download.loaded;
}

/**
 * A Yahoo or Tiingo ticker's daily bars as they traded each day, unadjusted for later dividends and splits, to compare a
 * broker's fills with. They are saved apart from the adjusted bars, under the same name with `raw-` in front, and Tiingo
 * never stands in for Yahoo here.
 */
export function loadRawBars(ref: AssetRef, deps: DataDeps, opts: { freshForMs?: number } = {}): Promise<Loaded> {
  return loadBars(ref, '1d', 0, deps, false, { freshForMs: opts.freshForMs, key: `raw-${cacheKey(ref, '1d')}`, fallback: false, raw: true });
}

/** The name a source's bars of one ticker and interval are saved under. A FRED series is the same whatever the interval. */
const cacheKey = (ref: AssetRef, interval: string): string =>
  (ref.source === 'fred' ? `fred-${ref.id}` : `${ref.source}-${ref.id}-${interval}`).replace(/[^A-Za-z0-9._-]/g, '_');

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
export function loadInsideBars(ref: AssetRef, interval: string, since: number, deps: DataDeps, force = false, opts?: { freshForMs?: number; onRetry?: (retry: Retry) => void }): Promise<Loaded> {
  const binance = ref.source === 'binance';
  const keepFrom = binance ? insideReach('binance', interval, deps.now()) : undefined;
  const key = binance ? `${cacheKey(ref, interval)}-inside` : undefined;
  return loadBars({ ...ref, name: `the ${interval} bars of ${ref.name}` }, interval, since, deps, force, { ...opts, keepFrom, key, fallback: false });
}
