// Reading a price file the way the plugin does, so a person can see what it will make of it, and cleaning one it cannot read.
import { CSV_GUESSES, CSV_HEADERS, CSV_SLASHED_DATE, detectCsvSeparator, tidyHeader as tidy, parseCsv, parseCsvTime, slashedDatesAreDayFirst, splitCsvLine } from './data.ts';
import { parseSpec } from './dsl.ts';
import { rowDating } from './evaluate.ts';
import { csvField, DAY, plural } from './format.ts';
import { columnName, MAX_COLUMNS, type Bars } from './types.ts';

/** Raw rows kept for display. */
const RAW_ROWS = 5;
/** Parsed rows shown at each end of a file. */
const SAMPLE_ROWS = 3;
/** The trend rule of the starter strategy. */
const STARTER_AVERAGE = 100;
/** A gap this long, or five times the usual step, is worth a note. */
const BIG_GAP = 10 * DAY;

type CsvRole = 'date' | 'open' | 'high' | 'low' | 'close' | 'volume';
export type DateOrder = 'day-first' | 'month-first';

/** Which column plays each part, as an index into the header (null: none). */
export interface CsvMapping {
  date: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  /** An adjusted close that scales every price, as parseCsv does with an "Adj Close" column. */
  adjClose: number | null;
  /** How to read 02/01/2024. Null leaves it to the rule parseCsv uses. */
  dateOrder: DateOrder | null;
}

export interface CsvRow {
  /** 2024-01-31, or with a time of day when the bar has one. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Shown {
  /** Names in the file's first line. */
  header: string[];
  /** The first few rows as written. */
  rawRows: string[][];
  /** The columns parseCsv used, or, for a file it cannot read, a best guess. */
  columns: CsvMapping;
  /** Dates such as 02/01/2024 or 02-01-2024 that could be day first or month first. */
  ambiguousDates: boolean;
}

/** A column beyond the prices that a rule can read by name. */
export interface CsvSignal {
  /** What a rule calls it: `column(<name>)`. */
  name: string;
  /** The header as the file spells it. */
  header: string;
  /** The first and the last row that has a number in this column. */
  first: { date: string; value: number };
  last: { date: string; value: number };
  /** Rows with a number in this column. */
  count: number;
}

export interface CsvRead extends Shown {
  read: true;
  rows: number;
  first: string;
  last: string;
  /** False for a file with only a date and columns: a strategy can read its columns but cannot trade it. */
  priced: boolean;
  /** The first rows and the last, as prices; empty for a file with no prices. */
  head: CsvRow[];
  /** The last rows, without any already in `head`. */
  tail: CsvRow[];
  /** The columns a rule can read by name, in file order. */
  signals: CsvSignal[];
  /** Plain sentences about columns no rule can read. */
  unreadable: string[];
  /** Plain sentences about anything that looks wrong. */
  doubts: string[];
  /** When a row counts as known, and so how a row must be dated, in one or two sentences. */
  dating: string;
}

export interface CsvUnread extends Shown {
  read: false;
  reason: string;
}

export type CsvInspection = CsvRead | CsvUnread;

export type CsvCleaned =
  | {
      ok: true;
      /** The cleaned file: a standard header, ISO dates, oldest first. */
      text: string;
      rows: number;
      /** Rows that could not be read and were left out. */
      dropped: number;
      /** What was filled in, changed or left out, in plain sentences. */
      notes: string[];
      /** The names a rule reads the other columns of the file by, which are kept in the copy. */
      columns: string[];
      sample: CsvRow[];
      first: string;
      last: string;
    }
  | { ok: false; reason: string };

export type CsvInsert = { ok: true; text: string; note: string | null } | { ok: false; reason: string };

/** How a row of a column is dated, in the words the helper window uses, for a file of days (see datingOf). */
export const SIGNAL_DATING =
  "A row counts as known at the end of the day it is dated. Give each row the date of the close that you calculated its value from. For example, a rule on the close of Tuesday can use a row with the date of Tuesday. Its order fills at the open of Wednesday.";

/** How this file's rows are dated, by the rule the run reads them with (evaluate.ts rowDating). */
function datingOf(bars: Bars): string {
  const { known, carry, daily } = rowDating(bars);
  if (daily) return bars.unpriced ? SIGNAL_DATING.replace('dated.', 'dated. The gaps between the rows do not change this.') : SIGNAL_DATING;
  const said = carry.replace(/^so /, '');
  return `A row counts as known ${known}. ${said[0].toUpperCase()}${said.slice(1)}.`;
}

interface Table {
  header: string[];
  rows: string[][];
  sep: string;
}

// The live preview reads the same file again on every change, so the last split is kept.
let lastText: string | null = null;
let lastTable: Table | null = null;

/** The file split the way parseCsv splits it: the first line is the header, blank lines do not count. */
function table(text: string): Table | null {
  if (text === lastText) return lastTable;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  let out: Table | null = null;
  if (lines.length > 0) {
    const sep = detectCsvSeparator(lines[0]);
    out = { header: splitCsvLine(lines[0], sep), rows: lines.slice(1).map((l) => splitCsvLine(l, sep)), sep };
  }
  [lastText, lastTable] = [text, out];
  return out;
}

const NO_COLUMNS: CsvMapping = { date: null, open: null, high: null, low: null, close: null, volume: null, adjClose: null, dateOrder: null };

/** The columns parseCsv picks: the first header with one of the names it knows. */
function namedColumns(header: string[]): CsvMapping {
  const lower = header.map((h) => h.toLowerCase());
  const find = (wanted: readonly string[]) => {
    const i = lower.findIndex((h) => wanted.includes(h));
    return i < 0 ? null : i;
  };
  return {
    date: find(CSV_HEADERS.date),
    open: find(CSV_HEADERS.open),
    high: find(CSV_HEADERS.high),
    low: find(CSV_HEADERS.low),
    close: find(CSV_HEADERS.close),
    volume: find(CSV_HEADERS.volume),
    adjClose: find(CSV_HEADERS.adjClose),
    dateOrder: null,
  };
}

const GUESSES = CSV_GUESSES;
const DATE_GUESSES = [/^date$/, /^(datetime|timestamp)$/, /^time$/, /^day$/, /^datum$/, /\b(date|datetime|timestamp)\b/, /\btime\b/];

/** A date that can be told from a number by looking: it has separators or month names, or is eight digits. */
const LOOKS_LIKE_DATE = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})([ T].*)?$|^\d{8}$|^\d{1,2}[- ][A-Za-z]{3,9}[- ]\d{2,4}$|^[A-Za-z]{3,9}\.? \d{1,2},? \d{4}$/;

/** Guesses which column is which from the names, and for the date from what the cells look like. */
function guessColumns(t: Table): CsvMapping {
  const names = t.header.map(tidy);
  const taken = new Set<number>();
  const pick = (patterns: RegExp[]): number | null => {
    for (const p of patterns) {
      const i = names.findIndex((n, k) => !taken.has(k) && p.test(n));
      if (i >= 0) {
        taken.add(i);
        return i;
      }
    }
    return null;
  };
  let date = pick(DATE_GUESSES);
  if (date === null) {
    const sample = t.rows.slice(0, 50);
    const k = t.header.findIndex((_, i) => {
      const cells = sample.map((r) => r[i] ?? '').filter((c) => c !== '');
      return !taken.has(i) && cells.length > 0 && cells.filter((c) => LOOKS_LIKE_DATE.test(c)).length >= 0.8 * cells.length;
    });
    if (k >= 0) {
      date = k;
      taken.add(k);
    }
  }
  const adjClose = pick(GUESSES.adjClose);
  const [open, high, low, close, volume] = [GUESSES.open, GUESSES.high, GUESSES.low, GUESSES.close, GUESSES.volume].map(pick);
  return { date, open, high, low, close: close ?? adjClose, volume, adjClose: close === null ? null : adjClose, dateOrder: null };
}

interface Reader {
  number(s: string | undefined): number;
  date(s: string, dayFirst: boolean): number;
}

/** Numbers and dates exactly as parseCsv reads them. */
const STRICT: Reader = {
  number: (s) => (s === undefined || s === '' ? NaN : Number(s)),
  date: (s, dayFirst) => parseCsvTime(s, dayFirst),
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The UTC day for year, month (1 to 12) and day, or NaN when that day does not exist. */
function utcDay(year: number, month: number, day: number): number {
  const at = Date.UTC(year, month - 1, day);
  const d = new Date(at);
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? at : NaN;
}

/** 2-Jan-2024, 02 Jan 24, Jan 2, 2024: the UTC day, NaN for one that does not exist, null when it is not written this way. The browser would read these in the computer's time zone. */
function namedMonthDate(s: string): number | null {
  const dayFirst = /^(\d{1,2})[- ]([A-Za-z]{3,9})\.?[- ]+(\d{4}|\d{2})$/.exec(s);
  const monthFirst = /^([A-Za-z]{3,9})\.? +(\d{1,2}),? +(\d{4})$/.exec(s);
  if (!dayFirst && !monthFirst) return null;
  const [day, name, year] = dayFirst ? [dayFirst[1], dayFirst[2], dayFirst[3]] : [monthFirst![2], monthFirst![1], monthFirst![3]];
  const month = MONTH_NAMES.indexOf(name.slice(0, 3).toLowerCase());
  if (month < 0) return NaN;
  const y = Number(year);
  return utcDay(year.length === 2 ? (y > 69 ? 1900 + y : 2000 + y) : y, month + 1, Number(day));
}

/** Also reads what parseCsv does not: a decimal comma, thousands separators, 20240131 and month names. */
function lenientReader(sep: string, changed: { numbers: boolean }): Reader {
  const forms = [
    { re: /^-?\d{1,3}(,\d{3})+(\.\d+)?$/, fix: (s: string) => s.replace(/,/g, '') },
    { re: /^-?\d{1,3}(\.\d{3})+(,\d+)?$/, fix: (s: string) => s.replace(/\./g, '').replace(',', '.') },
    { re: /^-?\d+,\d+$/, fix: (s: string) => s.replace(',', '.') },
  ];
  // In a file split on commas, a comma inside a number is a thousands separator; otherwise it is a decimal comma.
  const order = sep === ',' ? forms : [forms[1], forms[2], forms[0]];
  return {
    number(s) {
      const n = STRICT.number(s);
      if (!Number.isNaN(n) || !s) return n;
      const form = order.find((f) => f.re.test(s));
      if (!form) return NaN;
      changed.numbers = true;
      return Number(form.fix(s));
    },
    date(s, dayFirst) {
      const named = namedMonthDate(s);
      if (named !== null) return named;
      const t = parseCsvTime(s, dayFirst);
      if (!Number.isNaN(t)) return t;
      const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s) ?? /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
      return m ? utcDay(Number(m[1]), Number(m[2]), Number(m[3])) : NaN;
    },
  };
}

interface Cols {
  date: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adj: number;
}

interface Parsed {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** The row as the file has it. */
  row: string[];
}

interface Tally {
  date: number;
  missing: number;
  zero: number;
  shape: number;
  duplicate: number;
}

const tallyTotal = (t: Tally): number => t.date + t.missing + t.zero + t.shape + t.duplicate;

/**
 * Rows to prices the way parseCsv does, keeping count of why rows were left out. A missing open, high or low
 * (column -1) is filled from the close: open is the close, high the larger of open and close, low the smaller.
 */
function readRows(rows: string[][], c: Cols, dayFirst: boolean, read: Reader, years: boolean): { parsed: Parsed[]; tally: Tally; dates: number[] } {
  const tally: Tally = { date: 0, missing: 0, zero: 0, shape: 0, duplicate: 0 };
  const good: Parsed[] = [];
  const cell = (f: string[], i: number) => (i >= 0 ? read.number(f[i]) : NaN);
  for (const f of rows) {
    const t = read.date(f[c.date] ?? '', dayFirst);
    if (!Number.isFinite(t) || (years && (t < Date.UTC(1000, 0, 1) || t >= Date.UTC(10000, 0, 1)))) {
      tally.date++;
      continue;
    }
    const close = cell(f, c.close);
    const adjusted = c.adj >= 0 && cell(f, c.adj) > 0 ? cell(f, c.adj) / close : 1;
    const cl = close * adjusted;
    const o = c.open >= 0 ? cell(f, c.open) * adjusted : cl;
    const h = c.high >= 0 ? cell(f, c.high) * adjusted : Math.max(o, cl);
    const l = c.low >= 0 ? cell(f, c.low) * adjusted : Math.min(o, cl);
    if ([o, h, l, cl].some(Number.isNaN)) tally.missing++;
    else if (Math.min(o, h, l, cl) <= 0) tally.zero++;
    else if (l > Math.min(o, cl) || h < Math.max(o, cl)) tally.shape++;
    else {
      const v = c.volume >= 0 ? read.number(f[c.volume]) : 0;
      good.push({ t, o, h, l, c: cl, v: Number.isFinite(v) ? v : 0, row: f });
    }
  }
  const dates = good.map((g) => g.t);
  good.sort((a, b) => a.t - b.t);
  const parsed: Parsed[] = [];
  for (const g of good) {
    if (parsed.length && g.t <= parsed[parsed.length - 1].t) tally.duplicate++;
    else parsed.push(g);
  }
  return { parsed, tally, dates };
}

function isoOf(t: number): string {
  if (Math.abs(t) > 8.64e15) return String(t);
  const iso = new Date(t).toISOString();
  return t % DAY === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

const rowOf = (b: { t: number; o: number; h: number; l: number; c: number; v: number }): CsvRow => ({ date: isoOf(b.t), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });

/** Why rows were left out, in one sentence. */
function leftOut(tally: Tally, of: number, verb: string): string | null {
  const total = tallyTotal(tally);
  if (total === 0) return null;
  const why = [
    tally.date > 0 && `${tally.date.toLocaleString('en-US')} with a date that the plugin cannot read`,
    tally.missing > 0 && `${tally.missing.toLocaleString('en-US')} with a price that is missing or not a number`,
    tally.zero > 0 && `${tally.zero.toLocaleString('en-US')} with a price at or below zero`,
    tally.shape > 0 && `${tally.shape.toLocaleString('en-US')} where the high or low does not contain the open and close`,
    tally.duplicate > 0 && `${tally.duplicate.toLocaleString('en-US')} with the date of a previous row`,
  ].filter(Boolean);
  return `${total.toLocaleString('en-US')} of ${plural(of, 'row')} ${verb}: ${why.join(', ')}.`;
}

/** Whether a date is written 02/01/2024 or 02-01-2024, which can be day first or month first (02.01.2024 is always day first). */
const twoWays = (m: RegExpExecArray | null): m is RegExpExecArray => m !== null && m[2] !== '.';

/** What the slashed or dashed dates in a column show about their order: a number above 12 can only be a day. */
function slashedOrder(values: string[]): { any: boolean; dayFirst: boolean; monthFirst: boolean; differs: boolean } {
  const out = { any: false, dayFirst: false, monthFirst: false, differs: false };
  for (const v of values) {
    const m = CSV_SLASHED_DATE.exec(v);
    if (!twoWays(m)) continue;
    out.any = true;
    if (Number(m[1]) > 12) out.dayFirst = true;
    if (Number(m[3]) > 12) out.monthFirst = true;
    if (Number(m[1]) !== Number(m[3])) out.differs = true;
  }
  return out;
}

/** Slashed or dashed dates that are all numbers up to 12, and so could be read either way round. */
function ambiguousOf(values: string[]): boolean {
  const o = slashedOrder(values);
  return o.any && !o.dayFirst && !o.monthFirst && o.differs;
}

/** True when the dates in this column could be day first or month first, so the person has to say which. */
export function dateOrderIsAmbiguous(text: string, column: number): boolean {
  const t = table(text);
  return t !== null && ambiguousOf(t.rows.map((r) => r[column] ?? ''));
}

/** How the dates in this column that could be read two ways are written: 02/01/2024 or 02-01-2024. */
export function dateSeparator(text: string, column: number): '/' | '-' {
  for (const r of table(text)?.rows ?? []) {
    const m = CSV_SLASHED_DATE.exec(r[column] ?? '');
    if (twoWays(m)) return m[2] === '-' ? '-' : '/';
  }
  return '/';
}

function gaps(times: number[]): string | null {
  if (times.length < 3) return null;
  const steps = times.slice(1).map((t, i) => t - times[i]);
  const usual = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)];
  const limit = Math.max(BIG_GAP, 5 * usual);
  const big = steps.map((s, i) => ({ s, i })).filter((x) => x.s > limit);
  if (big.length === 0) return null;
  const worst = big.reduce((a, b) => (b.s > a.s ? b : a));
  const days = Math.round(worst.s / DAY);
  return `The file has ${plural(big.length, 'gap')} of more than ${Math.round(limit / DAY)} days between rows. The longest is ${days} days, from ${isoOf(times[worst.i])} to ${isoOf(times[worst.i + 1])}.`;
}

function orderNote(dates: number[]): string | null {
  let up = 0;
  let down = 0;
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] > dates[i - 1]) up++;
    else if (dates[i] < dates[i - 1]) down++;
  }
  if (down === 0) return null;
  return `The rows are ${up === 0 ? 'from the last date to the first' : 'not in date order'}. The plugin puts them in date order when it reads the file.`;
}

/** The first slashed or dashed date whose day and month are different numbers, so that reading it two ways gives two dates. */
function firstSlashed(values: string[]): string | null {
  return values.find((v) => {
    const m = CSV_SLASHED_DATE.exec(v);
    return twoWays(m) && Number(m[1]) !== Number(m[3]);
  }) ?? null;
}

function slashedExample(value: string): string {
  const m = CSV_SLASHED_DATE.exec(value)!;
  const iso = (month: string, day: string) => `${m[4]}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  return `${value} is ${iso(m[1], m[3])} month first, or ${iso(m[3], m[1])} day first`;
}

/** Doubts about how the dates were read: the order of the rows, and dates that could be written two ways. */
function dateDoubts(t: Table, dateColumn: number, dates: number[]): string[] {
  const out: string[] = [];
  const order = orderNote(dates);
  if (order) out.push(order);
  const values = t.rows.map((r) => r[dateColumn] ?? '');
  if (ambiguousOf(values)) out.push(`The plugin can read the dates as month first or as day first: ${slashedExample(firstSlashed(values)!)}. It read them month first. If the file is day first, select day first below.`);
  const slashes = slashedOrder(values);
  if (slashes.dayFirst && slashes.monthFirst) out.push('The dates are a mix of day first and month first. Thus the plugin did not read the rows with dates that cannot be month first.');
  return out;
}

/** Doubts about the times of the rows read: a time of day, and long gaps. */
function timeDoubts(times: number[]): string[] {
  const out: string[] = [];
  const timed = times.find((x) => x % DAY !== 0);
  if (timed !== undefined) {
    out.push(`Some dates have a time of day, for example ${isoOf(timed)}. The plugin reads times as UTC. For a file of daily prices, use dates with no time, for example 2024-01-31.`);
  }
  const gap = gaps(times);
  if (gap) out.push(gap);
  return out;
}

function doubtsOf(t: Table, cols: Cols, bars: { t: number[]; v: number[] }, tally: Tally, dates: number[]): string[] {
  const out: string[] = [];
  const skipped = leftOut(tally, t.rows.length, 'were not read');
  if (skipped) out.push(skipped);
  out.push(...dateDoubts(t, cols.date, dates));
  if (cols.volume < 0) out.push('The file has no volume column. Thus volume is 0 on each bar, and a rule that reads volume cannot work.');
  else if (bars.v.every((v) => v === 0)) out.push('Volume is 0 on each bar. Thus a rule that reads volume cannot work.');
  out.push(...timeDoubts(bars.t));
  if (bars.t.length <= STARTER_AVERAGE) {
    out.push(`The file has only ${plural(bars.t.length, 'row')}. The trend rule in the starter strategy uses a ${STARTER_AVERAGE}-bar average. Thus it cannot give an order on this file.`);
  }
  return out;
}

const orList = (words: string[]): string => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`);

/** The columns the guesses take for a price: open, high, low, close or an adjusted close. */
const guessedPrices = (t: Table, guess: CsvMapping): number[] =>
  [...new Set([guess.open, guess.high, guess.low, guess.close, guess.adjClose].filter((i): i is number => i !== null && i < t.header.length))];

/** What was wrong with a file parseCsv could not read, in plain words. */
function reasonFor(t: Table | null, named: CsvMapping, guess: CsvMapping, error: string): string {
  if (t === null) return 'The file is empty.';
  if (t.rows.length === 0) return 'The file has a header row and no rows below it. Each row must hold one day of prices.';
  const missing = (['date', 'open', 'high', 'low', 'close'] as const).filter((r) => named[r] === null);
  if (missing.length > 0) {
    if (guess.date === null || guess.close === null) {
      const lacks = guess.date === null && guess.close === null ? 'a date or a price' : guess.date === null ? 'a date' : 'a closing price';
      return `The plugin found no column with ${lacks}. Thus this is possibly not a file of prices. A price file has one row for each day, with a minimum of a date column and a close column.`;
    }
    const only = missing.every((m) => m === 'open' || m === 'high' || m === 'low');
    // A file with a date and one column that looks like a price is read as a price file, which a file of signals with
    // such a header would be too: say how to make it one.
    const priceLike = guessedPrices(t, guess);
    const signals = named.open === null && named.high === null && named.low === null && named.close === null && priceLike.length === 1;
    return (
      `The plugin reads columns named date, open, high, low and close. This file has no ${orList(missing)} column.` +
      (only ? ' The plugin can use a file with only dates and closes: it sets the open, high and low to the close.' : ' Select the correct columns below.') +
      (signals ? ` If "${t.header[priceLike[0]]}" holds values that are not prices, give it a different name. Then the plugin reads the file as a file of signals.` : '')
    );
  }
  const cell = (i: number | null) => (i === null ? '' : (t.rows.find((r) => (r[i] ?? '') !== '')?.[i] ?? ''));
  const name = (i: number | null) => (i === null ? '' : t.header[i]);
  const first = readRows(t.rows, { date: named.date!, open: named.open!, high: named.high!, low: named.low!, close: named.close!, volume: -1, adj: -1 }, false, STRICT, false);
  if (first.tally.date === t.rows.length) {
    return `The plugin cannot read a date in the "${name(named.date)}" column. The first date is "${cell(named.date)}". Write dates as 2024-01-31.`;
  }
  if (first.tally.missing > 0 && first.tally.missing >= first.tally.zero + first.tally.shape) {
    const decimalComma = t.rows.some((r) => /^-?\d+,\d+$/.test(r[named.close!] ?? ''));
    return decimalComma
      ? `The prices have a decimal comma, for example "${cell(named.close)}". The plugin reads only a decimal point. A cleaned copy writes them with a point.`
      : `The plugin cannot read a number in the "${name(named.close)}" column. The first value is "${cell(named.close)}".`;
  }
  return error.replace(/^The CSV /, 'The file ');
}

/**
 * What the plugin makes of a price file: how it was read, or why it was not, with the first rows and anything doubtful.
 * The answer to "was it read" is parseCsv's own.
 */
export function inspectCsv(text: string): CsvInspection {
  const t = table(text);
  const header = t?.header ?? [];
  const rawRows = t?.rows.slice(0, RAW_ROWS) ?? [];
  let bars: ReturnType<typeof parseCsv> | null = null;
  let error = '';
  try {
    bars = parseCsv(text);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const named = namedColumns(header);
  if (bars === null || t === null) {
    const guess = t === null ? NO_COLUMNS : guessColumns(t);
    const column = guess.date;
    return { read: false, header, rawRows, columns: guess, ambiguousDates: t !== null && column !== null && ambiguousOf(t.rows.map((r) => r[column] ?? '')), reason: reasonFor(t, named, guess, error) };
  }

  const signals = signalsOf(bars);
  const unreadable = unreadableOf(bars);
  if (bars.unpriced) {
    const dayFirst = slashedDatesAreDayFirst(t.rows.map((r) => r[named.date!] ?? ''));
    const dates = t.rows.map((r) => STRICT.date(r[named.date!] ?? '', dayFirst)).filter(Number.isFinite);
    const tally: Tally = { date: t.rows.length - dates.length, missing: 0, zero: 0, shape: 0, duplicate: dates.length - bars.t.length };
    const skipped = leftOut(tally, t.rows.length, 'were not read');
    return {
      read: true,
      priced: false,
      header,
      rawRows,
      columns: named,
      ambiguousDates: ambiguousOf(t.rows.map((r) => r[named.date!] ?? '')),
      rows: bars.t.length,
      first: isoOf(bars.t[0]),
      last: isoOf(bars.t[bars.t.length - 1]),
      head: [],
      tail: [],
      signals,
      unreadable,
      doubts: [...(skipped ? [skipped] : []), ...dateDoubts(t, named.date!, dates), ...timeDoubts(bars.t)],
      dating: datingOf(bars),
    };
  }

  const cols: Cols = { date: named.date!, open: named.open!, high: named.high!, low: named.low!, close: named.close!, volume: named.volume ?? -1, adj: named.adjClose ?? -1 };
  const dayFirst = slashedDatesAreDayFirst(t.rows.map((r) => r[cols.date] ?? ''));
  const mine = readRows(t.rows, cols, dayFirst, STRICT, false);
  const n = bars.t.length;
  const at = (i: number) => rowOf({ t: bars.t[i], o: bars.o[i], h: bars.h[i], l: bars.l[i], c: bars.c[i], v: bars.v[i] });
  const all = Array.from({ length: n }, (_, i) => i);
  const head = all.slice(0, SAMPLE_ROWS).map(at);
  const tail = all.slice(Math.max(SAMPLE_ROWS, n - SAMPLE_ROWS)).map(at);
  return {
    read: true,
    priced: true,
    header,
    rawRows,
    columns: named,
    ambiguousDates: ambiguousOf(t.rows.map((r) => r[cols.date] ?? '')),
    rows: n,
    first: isoOf(bars.t[0]),
    last: isoOf(bars.t[n - 1]),
    head,
    tail,
    signals,
    unreadable,
    doubts: doubtsOf(t, cols, bars, mine.tally, mine.dates),
    dating: datingOf(bars),
  };
}

/** The columns a rule can read, with where each one starts and ends. */
function signalsOf(bars: Bars): CsvSignal[] {
  return (bars.columns ?? []).map((c) => {
    const known = c.v.flatMap((x, i) => (Number.isNaN(x) ? [] : [i]));
    const at = (i: number) => ({ date: isoOf(bars.t[i]), value: c.v[i] });
    return { name: c.name, header: c.header, first: at(known[0]), last: at(known[known.length - 1]), count: known.length };
  });
}

/** The columns no rule can read, in plain sentences: those the parser could not name apart, and those past the limit. */
function unreadableOf(bars: Bars): string[] {
  const out: string[] = [];
  const past: string[] = [];
  for (const u of bars.unread ?? []) {
    if (u.limit) past.push(u.name);
    else out.push(`${u.why[0].toUpperCase()}${u.why.slice(1)}.`);
  }
  if (past.length) out.push(`The plugin reads only the first ${MAX_COLUMNS} columns of a file. It did not read these: ${past.join(', ')}.`);
  return out;
}

const CLEAN_HEADER = 'date,open,high,low,close,volume';
const KNOWN_HEADERS: readonly string[] = Object.values(CSV_HEADERS).flat();

interface Kept {
  header: string;
  name: string;
  /** One number for each row of the cleaned copy; NaN where the cell holds none. */
  values: number[];
}

/**
 * The columns of the file that no role in the copy uses and that hold numbers, as a rule would read them by name: the
 * ones to keep in a cleaned copy, and notes on what was left out or kept. A column the plugin reads as a date or a price
 * by its header is not one of them.
 */
function extraColumnsOf(t: Table, used: Set<number>, parsed: Parsed[], read: Reader): { kept: Kept[]; notes: string[] } {
  const notes: string[] = [];
  const found = t.header
    .flatMap((header, i) => (header !== '' && !used.has(i) && !KNOWN_HEADERS.includes(header.toLowerCase()) ? [{ i, header, name: columnName(header) }] : []))
    .filter((c) => c.name !== '')
    .map((c) => ({ header: c.header, name: c.name, values: parsed.map((p) => read.number(p.row[c.i])) }))
    .filter((c) => c.values.some((v) => !Number.isNaN(v)));
  const kept: Kept[] = [];
  const past: string[] = [];
  for (const c of found) {
    const same = kept.find((k) => k.name === c.name);
    if (same) notes.push(`The plugin did not keep the column "${c.header}": a rule reads it as ${c.name}, the same name as "${same.header}".`);
    else if (kept.length === MAX_COLUMNS) past.push(c.header);
    else kept.push(c);
  }
  if (past.length) notes.push(`The plugin reads only the first ${MAX_COLUMNS} columns of a file. Thus it did not keep these: ${past.join(', ')}.`);
  if (kept.length) notes.push(`The plugin kept the other columns with numbers. A rule reads them by name: ${kept.map((c) => c.name).join(', ')}.`);
  return { kept, notes };
}
const ROLES: [CsvRole | 'adjClose', string][] = [
  ['date', 'date'],
  ['open', 'open'],
  ['high', 'high'],
  ['low', 'low'],
  ['close', 'close'],
  ['volume', 'volume'],
  ['adjClose', 'adjusted close'],
];

/**
 * A clean copy of the file, with the columns the person chose: standard header, ISO dates, oldest first, a point for
 * the decimal mark. A file with no open, high or low gets them from the close; rows that cannot be read are left out.
 */
export function remapCsv(text: string, mapping: CsvMapping): CsvCleaned {
  const t = table(text);
  if (t === null || t.rows.length === 0) return { ok: false, reason: 'The file has no rows of prices.' };
  if (mapping.date === null) return { ok: false, reason: 'Select the column that holds the date.' };
  if (mapping.close === null) return { ok: false, reason: 'Select the column that holds the closing price.' };
  const chosen: [string, number][] = [];
  for (const [role, label] of ROLES) {
    const i = mapping[role];
    if (i === null) continue;
    if (i >= t.header.length) return { ok: false, reason: `The ${label} column is not in the file.` };
    const clash = chosen.find(([, j]) => j === i);
    if (clash) return { ok: false, reason: `The ${clash[0]} and the ${label} are the same column. Select a different column for one of them.` };
    chosen.push([label, i]);
  }

  const values = t.rows.map((r) => r[mapping.date!] ?? '');
  const dayFirst = mapping.dateOrder === null ? slashedDatesAreDayFirst(values) : mapping.dateOrder === 'day-first';
  const changed = { numbers: false };
  const cols: Cols = {
    date: mapping.date,
    open: mapping.open ?? -1,
    high: mapping.high ?? -1,
    low: mapping.low ?? -1,
    close: mapping.close,
    volume: mapping.volume ?? -1,
    adj: mapping.adjClose ?? -1,
  };
  const lenient = lenientReader(t.sep, changed);
  const { parsed, tally } = readRows(t.rows, cols, dayFirst, lenient, true);
  if (parsed.length === 0) {
    const worst = (Object.entries(tally) as [keyof Tally, number][]).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    const because = {
      date: `The plugin cannot read a date in the "${t.header[mapping.date]}" column.`,
      missing: 'The price columns hold no numbers that the plugin can read.',
      zero: 'All rows have a price at or below zero.',
      shape: 'In all rows, the high or low does not contain the open and close.',
      duplicate: 'All rows have a date that is also in a different row.',
    }[worst];
    return { ok: false, reason: `The plugin cannot read the rows. ${because} Make sure that you selected the correct columns.` };
  }

  const missing = (['open', 'high', 'low'] as const).filter((r) => mapping[r] === null);
  const notes: string[] = [];
  if (missing.length === 3) {
    notes.push(
      'The file has no open, high or low. Thus the plugin sets each of them to the close. As a result, a buy fills at the next close, not at the next open. A stop can close a position only at a close. The average true range counts only the moves from one close to the next.',
    );
  } else {
    const parts = [
      mapping.open === null && 'The open is set to the close.',
      mapping.high === null && 'The high is the larger of the open and the close.',
      mapping.low === null && 'The low is the smaller of the open and the close.',
    ].filter(Boolean);
    if (parts.length) notes.push(parts.join(' '));
  }
  if (mapping.volume === null) notes.push('There is no volume column. Thus volume is 0 on each bar, as for all files with no volume column.');
  if (mapping.adjClose !== null) notes.push('The plugin adjusts the prices with the adjusted close, as it does for a file with an "Adj Close" column.');
  const extra = extraColumnsOf(t, new Set(chosen.map(([, i]) => i)), parsed, lenient);
  if (changed.numbers) notes.push('In the copy, the plugin changed numbers with a decimal comma or a thousands separator to numbers with a decimal point.');
  if (ambiguousOf(values)) notes.push(`The plugin read the dates ${dayFirst ? 'day first' : 'month first'}, for example ${firstSlashed(values)}.`);
  const dropped = tallyTotal(tally);
  const left = leftOut(tally, t.rows.length, 'are not in the copy');
  if (left) notes.push(left);

  notes.push(...extra.notes);
  const lines = parsed.map((p, r) => `${isoOf(p.t)},${p.o},${p.h},${p.l},${p.c},${p.v}${extra.kept.map((c) => `,${Number.isNaN(c.values[r]) ? '' : c.values[r]}`).join('')}`);
  return {
    ok: true,
    text: `${CLEAN_HEADER}${extra.kept.map((c) => `,${csvField(c.header)}`).join('')}\n${lines.join('\n')}\n`,
    rows: parsed.length,
    dropped,
    notes,
    columns: extra.kept.map((c) => c.name),
    sample: parsed.slice(0, SAMPLE_ROWS + 2).map(rowOf),
    first: isoOf(parsed[0].t),
    last: isoOf(parsed[parsed.length - 1].t),
  };
}

/** Where a cleaned copy goes: beside the original, with no spaces or commas in its name. */
export function cleanedPath(path: string): string {
  const slash = path.lastIndexOf('/');
  const stem = path.slice(slash + 1).replace(/\.csv$/i, '').replace(/[\s,]+/g, '-');
  return `${path.slice(0, slash + 1)}${stem}-clean.csv`;
}

const blankIn = (path: string): string | null =>
  /\s/.test(path)
    ? `The path "${path}" has a space in it. A strategy reads a file path as one word. Thus you cannot write a path with a space or a comma in a strategy. Rename the file or its folder with no spaces, for example with a dash. Then open this window again.`
    : path.includes(',')
      ? `The path "${path}" has a comma in it. In a strategy, commas divide the tickers. Thus you cannot write a path with a comma or a space in a strategy. Rename the file or its folder with no commas. Then open this window again.`
      : null;

const PROBE = 'a-probe-file';

/**
 * The text that names this file in a strategy, checked with the parser. A path with a space or a comma cannot be
 * written at all. A path with other unusual characters works on a `universe` or `symbol` line but not after `of`.
 */
export function csvTicker(path: string): CsvInsert {
  const blank = blankIn(path);
  if (blank) return { ok: false, reason: blank };
  const direct = parseSpec(`symbol: csv:${path}\nbuy when close > sma(5)`);
  if (direct.errors.length > 0 || direct.spec?.universe[0]?.id !== path || direct.spec.universe[0].source !== 'csv') {
    return { ok: false, reason: `A strategy cannot read the path "${path}". ${direct.errors[0]?.message ?? 'The parser reads it as a different file.'}` };
  }
  const viaOf = parseSpec(`symbol: csv:${PROBE}.csv\nbuy when close of csv:${path} > sma(5)`);
  const ofOk = viaOf.errors.length === 0 && viaOf.spec?.extras.length === 1 && viaOf.spec.extras[0].id === path;
  return { ok: true, text: `csv:${path}`, note: ofOk ? null : 'This path works on a universe or symbol line. Because of its characters, it does not work after "of" in a rule.' };
}

/**
 * The text that reads one column of this file in a rule, checked with the parser. It names the file after "of", which works
 * wherever the rule is; a path whose characters cannot be written after "of" can only be read as the ticker the rule belongs
 * to, which a file with no prices cannot be.
 */
export function csvColumn(path: string, name: string, priced: boolean): CsvInsert {
  const blank = blankIn(path);
  if (blank) return { ok: false, reason: blank };
  const viaOf = parseSpec(`symbol: csv:${PROBE}.csv\nbuy when column(${name}) of csv:${path} > 0`);
  if (viaOf.errors.length === 0 && viaOf.spec?.extras.length === 1 && viaOf.spec.extras[0].id === path) return { ok: true, text: `column(${name}) of csv:${path}`, note: null };
  if (!priced) return { ok: false, reason: `This file has no prices. Thus a strategy can read it only with its path after "of". The characters of "${path}" do not let you write it there. Rename the file.` };
  return { ok: true, text: `column(${name})`, note: 'You cannot write this path after "of". Thus the file must be the ticker of the rule: put it on the universe or symbol line.' };
}

/** A complete small block that trades this file on a trend rule, fenced, ending with a newline. */
export function csvStrategy(path: string): CsvInsert {
  const ticker = csvTicker(path);
  if (!ticker.ok) return ticker;
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.csv$/i, '');
  const text = `name: Trend on ${base}
symbol: ${ticker.text}
costs: 5 bps

buy  when close > sma(${STARTER_AVERAGE})
sell when close < sma(${STARTER_AVERAGE})`;
  const { spec, errors } = parseSpec(text);
  if (errors.length > 0 || spec?.name !== `Trend on ${base}`) {
    return { ok: false, reason: `The plugin cannot write a strategy for "${path}". ${errors[0]?.message ?? 'The plugin cannot use the file name as a strategy name.'}` };
  }
  return { ok: true, text: `\`\`\`strategy\n${text}\n\`\`\`\n`, note: null };
}
