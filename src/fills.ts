// A broker's record of trades read into fills, and those fills set against the trades the strategies made. Pure; the
// caller reads the file and hands in each strategy's run.

import { detectCsvSeparator, parseCsvTime, slashedDatesAreDayFirst, splitCsvLine } from './data.ts';
import { barAt, type FillLog } from './engine.ts';
import { DAY, isIntraday, median } from './format.ts';
import type { Bars } from './types.ts';

/** Which way a trade goes: a purchase or a cover buys, a sale or a short sale sells. */
export type Side = 'buy' | 'sell';

/**
 * A trade on the short side, where the broker's file or the strategies' positions say so: a short sale (a sale), a cover
 * (a purchase), or a flip, which goes through 0, closing one side and opening the other. Absent on a purchase or sale of
 * a long position, and where the file does not say.
 */
export type ShortAction = 'short' | 'cover' | 'flip';

/** One trade from the broker's file. */
export interface Fill {
  /** The trade's day, as UTC midnight. */
  date: number;
  /** As the strategies spell it when one of them trades it. */
  ticker: string;
  side: Side;
  action?: ShortAction;
  /** Shares, above 0. */
  quantity: number;
  price: number;
  /** Commission and fees together, at or above 0. */
  fees: number;
  /** 1-based line in the file. */
  line: number;
}

export const FILL_ROLES = ['date', 'ticker', 'side', 'quantity', 'price', 'fees'] as const;
export type FillRole = (typeof FILL_ROLES)[number];

/** The header of the column that holds each part of a trade; `fees` can name several columns, which are added up. */
export interface FillColumns {
  date: string | null;
  ticker: string | null;
  side: string | null;
  quantity: string | null;
  price: string | null;
  fees: string[];
}

/** A header as it is compared: capitals, a currency in brackets, dots and underscores do not matter. */
const tidy = (header: string): string =>
  header
    .toLowerCase()
    .replace(/\((?:\$|usd)\)/g, '')
    .replace(/[_.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The headers each part of a trade goes by in the brokers' files, best first, as `tidy` writes them. */
const ALIASES: Record<FillRole, readonly string[]> = {
  date: ['date', 'trade date', 'tradedate', 'run date', 'transaction date', 'activity date', 'execution date', 'date/time', 'datetime', 'date time', 'trade time', 'time', 'timestamp'],
  ticker: ['symbol', 'ticker', 'symbol/cusip', 'security symbol'],
  side: ['action', 'buy/sell', 'side', 'transaction type', 'trans type', 'transaction', 'activity type', 'activity'],
  quantity: ['quantity', 'qty', 'shares', 'units', 'filled quantity', 'quantity filled'],
  price: ['price', 't price', 'tradeprice', 'trade price', 'fill price', 'execution price', 'average price', 'avg price', 'price per share'],
  fees: ['fees & comm', 'commission', 'commissions', 'fees', 'fee', 'comm/fee', 'ibcommission', 'comm', 'commission and fees', 'fees and commissions'],
};

interface Preset {
  name: string;
  /** Headers, as `tidy` writes them, that together tell this broker's file apart. */
  signature: readonly string[];
  /** Its words for a purchase and a sale in the action column; null when its quantities carry the sign. */
  buy: RegExp | null;
  sell: RegExp | null;
  /** Its words for a short sale and for buying one back; null where its file does not say. */
  short: RegExp | null;
  cover: RegExp | null;
  /** Headers, as `tidy` writes them, of a column whose codes O and C say a trade opened or closed a position. */
  codes: readonly string[];
}

const PRESETS: readonly Preset[] = [
  {
    name: 'Charles Schwab',
    signature: ['date', 'action', 'symbol', 'quantity', 'price', 'fees & comm'],
    buy: /^buy$/i,
    sell: /^sell$/i,
    short: /^sell short$/i,
    cover: /^buy to cover$/i,
    codes: [],
  },
  // Fidelity's words for a short sale and a cover are not documented: these read SHORT or COVER right after its usual
  // words, never further on, where they can be part of a fund's name or of "PROSPECTUS UNDER SEPARATE COVER".
  {
    name: 'Fidelity',
    signature: ['run date', 'action', 'symbol', 'quantity', 'price'],
    buy: /^you bought\b/i,
    sell: /^you sold\b/i,
    short: /^you sold\s+short\b/i,
    cover: /^you bought\s+(?:to\s+|short\s+)?cover\b/i,
    codes: [],
  },
  { name: 'Interactive Brokers Flex query', signature: ['symbol', 'quantity', 'tradeprice'], buy: /^buy$/i, sell: /^sell$/i, short: null, cover: null, codes: ['open/closeindicator', 'notes/codes'] },
  {
    name: 'Interactive Brokers activity statement',
    signature: ['datadiscriminator', 'symbol', 'date/time', 'quantity', 't price'],
    buy: null,
    sell: null,
    short: null,
    cover: null,
    codes: ['code'],
  },
];

export type LeftOut = 'dividends' | 'reinvestments' | 'transfers' | 'other';

/**
 * Activity that is not a purchase or sale of shares, read after a broker's own words for those (a Fidelity purchase can
 * end in "PROSPECTUS UNDER SEPARATE COVER") and before the general ones (a "Buy to Open" is an option). Interest comes
 * before transfers because Fidelity's names the "FDIC INSURED DEPOSIT" it was paid on.
 */
const LEFT_OUT: readonly { why: LeftOut; words: RegExp }[] = [
  { why: 'reinvestments', words: /reinvest/i },
  { why: 'dividends', words: /dividend|\bdiv\b|cap(?:ital)? gain|distribution/i },
  { why: 'other', words: /interest|\bfees?\b|\btax|adjustment|split|spin|merger|expired|assigned|exercise|to open|to close|short|cover|option|cancel/i },
  { why: 'transfers', words: /transfer|moneylink|journal|\bwire\b|deposit|withdraw|contribution|\btfr\b|\bach\b/i },
];
// BOT and SLD are how Interactive Brokers writes them in its trade logs.
const BUY_WORDS = /\b(?:buy|bought|purchased?|bot)\b/i;
const SELL_WORDS = /\b(?:sell|sold|sale|sld)\b/i;
// Short sales and covers as brokers write them, read before LEFT_OUT and only as the whole action: "short" and "cover"
// are also in a short-term gain, a fund's name or a covered call, which stay left out.
const SHORT_WORDS = /^(?:sell[\s_-]+short|sold[\s_-]+short|short[\s_-]+sale|short|ss|sshort)$/i;
const COVER_WORDS = /^(?:buy[\s_-]+to[\s_-]+cover|bought[\s_-]+to[\s_-]+cover|cover|btc)$/i;

/** A ticker as it is compared with the strategies': a broker writes BRK/B, BRK.B or BRK B for Yahoo's BRK-B. */
const tickerKey = (s: string): string => s.trim().toUpperCase().replace(/[./\s]+/g, '-');

/**
 * A number as brokers write one: $1,234.56, -$5.00, $-5.00, (5.00) for a negative one; NaN for anything else, such as
 * 512,40 with a decimal comma, which is never read as 51240.
 */
export function brokerNumber(cell: string | undefined): number {
  const s = (cell ?? '').trim();
  const bracketed = /^\(.*\)$/.test(s);
  const bare = s.replace(/[()$\s]/g, '');
  if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+(?:\.\d*)?|\d+\.?\d*|\.\d+)$/.test(bare)) return NaN;
  const n = Number(bare.replace(/,/g, ''));
  return bracketed ? -Math.abs(n) : n;
}

/** A whole date in numbers at the start of a cell: 2026-01-02, 04/13/2026, 13.04.26, or a Flex query's 20260102. */
const NUMERIC_DATE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2}(?:\d{2})?|\d{8})(?![\d/.-])/;

/**
 * The day a cell names: "04/12/2026", Schwab's "04/12/2026 as of 04/10/2026" (the trade was on the 10th), Interactive
 * Brokers' "2026-01-02, 10:00:00", a Flex query's "20260102" or "20260102;100000", or one with the month's name, such as
 * "Apr 13, 2026". NaN when there is none.
 */
function dayOf(cell: string, dayFirst: boolean): number {
  const text = dateText(cell);
  let t: number;
  if (NUMERIC_DATE.test(text) || /^\d{9,}$/.test(text)) t = parseCsvTime(text, dayFirst);
  else {
    // The engine's own reading of a date in words gives a year, 2001, to one that has none, so the cell must name the year it gives.
    t = Date.parse(`${text} UTC`);
    const year = text.match(/(?<!\d)\d{4}(?!\d)/g);
    if (!year || !year.includes(String(new Date(t).getUTCFullYear()))) t = NaN;
  }
  return Number.isFinite(t) ? Math.floor(t / DAY) * DAY : NaN;
}

function dateText(cell: string): string {
  const asOf = cell.match(/\bas of\s+(\S+)/i);
  let text = (asOf ? asOf[1] : cell).trim();
  // A comma or semicolon after a whole date in numbers comes before its time; the one in "Apr 13, 2026" does not.
  const numeric = text.match(NUMERIC_DATE);
  if (numeric && /^\s*[;,]/.test(text.slice(numeric[0].length))) text = numeric[0];
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}` : text;
}

/** The columns of a header: those saved in the block first, then each part not named there by its aliases. Indexes into the header. */
function columnsOf(header: string[], saved: Partial<FillColumns>): { at: Record<Exclude<FillRole, 'fees'>, number>; fees: number[] } {
  const names = header.map(tidy);
  const taken = new Set<number>();
  const take = (i: number) => {
    if (i >= 0) taken.add(i);
    return i;
  };
  const named = (h: string) => take(names.findIndex((n, i) => !taken.has(i) && n === tidy(h)));
  const at = {} as Record<Exclude<FillRole, 'fees'>, number>;
  for (const role of ['date', 'ticker', 'side', 'quantity', 'price'] as const) {
    const h = saved[role];
    at[role] = h ? named(h) : -1;
  }
  const savedFees = saved.fees?.length ? saved.fees.map(named) : null;
  for (const role of ['date', 'ticker', 'side', 'quantity', 'price'] as const) {
    if (saved[role]) continue;
    for (const alias of ALIASES[role]) {
      at[role] = take(names.findIndex((n, i) => !taken.has(i) && n === alias));
      if (at[role] >= 0) break;
    }
  }
  return { at, fees: savedFees ?? names.flatMap((n, i) => (!taken.has(i) && ALIASES.fees.includes(n) ? [i] : [])) };
}

/** Whether a header has what a trade needs: a date, a ticker, a quantity and a price, and every saved column. */
function readable(header: string[], saved: Partial<FillColumns>): boolean {
  const { at, fees } = columnsOf(header, saved);
  const savedMissing = FILL_ROLES.some((r) => (r === 'fees' ? fees.some((i) => i < 0) : saved[r] && at[r] < 0));
  return at.date >= 0 && at.ticker >= 0 && at.quantity >= 0 && at.price >= 0 && !savedMissing;
}

/** The header line of a table of trades in an activity statement or a Flex query, whose rows start with their section. */
const MARKED = /^"?(?:Trades"?,"?Header|HEADER)"?,/;

interface Table {
  header: string[];
  rows: { cells: string[]; line: number }[];
}

/**
 * The tables of trades in a file. An activity statement's rows start with their section ("Trades,Header,…",
 * "Trades,Data,…"), a Flex query's may start with HEADER and DATA; a plain export has one header line, perhaps under a
 * title and over totals and notes. Also counts the statement's dividend and transfer rows, which have sections of their own.
 */
function tablesOf(lines: string[], saved: Partial<FillColumns>): { tables: Table[]; ignored: number; dividends: number; transfers: number } {
  const marked = lines.some((l) => MARKED.test(l));
  const tables: Table[] = [];
  let ignored = 0;
  let dividends = 0;
  let transfers = 0;
  if (marked) {
    let current: Table | null = null;
    lines.forEach((text, i) => {
      if (!text.trim()) return;
      const cells = splitCsvLine(text, ',');
      const [section, kind] = cells;
      if ((section === 'Trades' && kind === 'Header') || section === 'HEADER') {
        current = { header: cells.slice(2), rows: [] };
        tables.push(current);
      } else if (current && ((section === 'Trades' && kind === 'Data') || section === 'DATA')) {
        current.rows.push({ cells: cells.slice(2), line: i + 1 });
      } else if (kind === 'Data' && !/^total/i.test(cells[2] ?? '') && section === 'Dividends') dividends++;
      else if (kind === 'Data' && !/^total/i.test(cells[2] ?? '') && section === 'Deposits & Withdrawals') transfers++;
      else ignored++;
    });
    const used = tables.filter((t) => readable(t.header, saved));
    for (const t of tables) if (!used.includes(t)) ignored += t.rows.length + 1;
    return { tables: used, ignored, dividends, transfers };
  }
  const at = lines.findIndex((l) => l.trim() !== '' && readable(splitCsvLine(l, detectCsvSeparator(l)), saved));
  if (at < 0) return { tables: [], ignored: lines.filter((l) => l.trim()).length, dividends, transfers };
  const sep = detectCsvSeparator(lines[at]);
  const table: Table = { header: splitCsvLine(lines[at], sep), rows: [] };
  ignored = lines.slice(0, at).filter((l) => l.trim()).length;
  for (let i = at + 1; i < lines.length; i++) if (lines[i].trim()) table.rows.push({ cells: splitCsvLine(lines[i], sep), line: i + 1 });
  return { tables: [table], ignored, dividends, transfers };
}

export interface FillsRead {
  ok: true;
  /** The broker whose file this looks like, or null when its columns were found by their names alone. */
  format: string | null;
  /** The headers read for each part, as the file spells them. */
  columns: FillColumns;
  fills: Fill[];
  /** Rows that are not a purchase or sale of shares, counted by kind. */
  left: Record<LeftOut, number>;
  /** Purchases and sales of tickers no listed strategy trades, by ticker, most rows first. */
  untraded: { ticker: string; rows: number }[];
  /** Rows of the table that could not be read, with why. */
  unread: { line: number; why: string }[];
  /** Lines that are not rows of trades: titles above the table, totals and notes below it, other sections. */
  ignored: number;
}

export type FillsResult = FillsRead | { ok: false; reason: string };

const MISSING =
  "No line of the file names the columns of a trade: a date, a symbol, a quantity and a price. Write which headers hold them in a 'fills columns' line, such as fills columns: date = Trade Date; ticker = Symbol; quantity = Qty; price = Price";

/**
 * Reads a broker's export of trades. Columns are found by their headers, never by their position, so a column added or
 * moved does not matter. `traded` holds the tickers of the listed strategies; trades of others are left out and counted.
 */
export function readFills(text: string, traded: string[], saved: Partial<FillColumns> = {}): FillsResult {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const { tables, ignored: aside, dividends, transfers } = tablesOf(lines, saved);
  if (tables.length === 0) return { ok: false, reason: MISSING };

  const spelled = new Map(traded.map((t) => [tickerKey(t), t]));
  const left: Record<LeftOut, number> = { dividends, reinvestments: 0, transfers, other: 0 };
  const untraded = new Map<string, number>();
  const unread: { line: number; why: string }[] = [];
  const fills: Fill[] = [];
  let ignored = aside;
  let format: string | null = null;
  let columns: FillColumns | null = null;

  for (const table of tables) {
    const names = table.header.map(tidy);
    const preset = PRESETS.find((p) => p.signature.every((h) => names.includes(h))) ?? null;
    format ??= preset?.name ?? null;
    const { at, fees } = columnsOf(table.header, saved);
    columns ??= {
      date: table.header[at.date],
      ticker: table.header[at.ticker],
      side: at.side >= 0 ? table.header[at.side] : null,
      quantity: table.header[at.quantity],
      price: table.header[at.price],
      fees: fees.map((i) => table.header[i]),
    };
    // Interactive Brokers can list an order, each execution that filled it, and the lots a sale closed, each a row of its
    // own told apart by this column. The orders are the trades when there are any, else the executions.
    const level = names.findIndex((n) => n === 'datadiscriminator' || n === 'levelofdetail');
    const hasOrders = level >= 0 && table.rows.some((r) => /^order$/i.test(r.cells[level] ?? ''));
    const isTrade = (cell: string | undefined) => (hasOrders ? /^order$/i : /^(?:trade|execution)$/i).test(cell ?? '');
    const codes = preset ? names.findIndex((n) => preset.codes.includes(n)) : -1;
    const wide = Math.max(3, Math.ceil(table.header.length / 2));
    const dayFirst = slashedDatesAreDayFirst(table.rows.map((r) => dateText(r.cells[at.date] ?? '')));

    for (const { cells, line } of table.rows) {
      if (cells.length < wide || cells.every((c) => c === '')) {
        ignored++;
        continue;
      }
      if (level >= 0 && !isTrade(cells[level])) {
        ignored++;
        continue;
      }
      const action = at.side >= 0 ? (cells[at.side] ?? '').trim() : '';
      let side: Side | null = null;
      let short: ShortAction | undefined;
      if (action) {
        // A broker's own words are the only ones read in its file.
        const own = preset?.buy ? preset : null;
        if (own ? own.short?.test(action) : SHORT_WORDS.test(action)) [side, short] = ['sell', 'short'];
        else if (own ? own.cover?.test(action) : COVER_WORDS.test(action)) [side, short] = ['buy', 'cover'];
        else if (preset?.buy?.test(action)) side = 'buy';
        else if (preset?.sell?.test(action)) side = 'sell';
        else {
          const out = LEFT_OUT.find((l) => l.words.test(action));
          if (out) {
            left[out.why]++;
            continue;
          }
          // A broker's own words are the only ones read in its file: a Flex query's "BUY (Ca.)" is a cancellation.
          if (!preset?.buy) side = BUY_WORDS.test(action) ? 'buy' : SELL_WORDS.test(action) ? 'sell' : null;
          if (side === null) {
            unread.push({ line, why: `the action "${action}" is not a purchase or a sale this reads` });
            continue;
          }
        }
      }
      const date = dayOf(cells[at.date] ?? '', dayFirst);
      if (Number.isNaN(date)) {
        if (/\btotal/i.test(cells.join(' '))) ignored++;
        else unread.push({ line, why: `"${cells[at.date] ?? ''}" is not a date` });
        continue;
      }
      const symbol = (cells[at.ticker] ?? '').trim();
      if (!symbol) {
        unread.push({ line, why: 'it names no ticker' });
        continue;
      }
      const ticker = spelled.get(tickerKey(symbol));
      if (ticker === undefined) {
        const key = symbol.replace(/\s+/g, ' ').toUpperCase();
        untraded.set(key, (untraded.get(key) ?? 0) + 1);
        continue;
      }
      const signed = brokerNumber(cells[at.quantity]);
      if (!(Math.abs(signed) > 0)) {
        unread.push({ line, why: `"${cells[at.quantity] ?? ''}" is not a number of shares` });
        continue;
      }
      side ??= signed > 0 ? 'buy' : 'sell';
      const price = Math.abs(brokerNumber(cells[at.price]));
      if (!(price > 0)) {
        unread.push({ line, why: `"${cells[at.price] ?? ''}" is not a price` });
        continue;
      }
      const paid = fees.reduce((s, i) => s + (Math.abs(brokerNumber(cells[i])) || 0), 0);
      short ??= codes >= 0 ? openClose(side, cells[codes]) : undefined;
      fills.push({ date, ticker, side, ...(short ? { action: short } : {}), quantity: Math.abs(signed), price, fees: paid, line });
    }
  }
  return {
    ok: true,
    format,
    columns: columns!,
    fills,
    left,
    untraded: [...untraded].map(([ticker, rows]) => ({ ticker, rows })).sort((a, b) => b.rows - a.rows || a.ticker.localeCompare(b.ticker)),
    unread,
    ignored,
  };
}

/**
 * What Interactive Brokers' open and close codes say of a trade: O opens a position and C closes one, so a sale that
 * opens is a short sale and a purchase that closes is a cover, and both at once go through 0. A cell can hold other
 * codes too, such as "O;P".
 */
function openClose(side: Side, cell: string | undefined): ShortAction | undefined {
  const codes = new Set((cell ?? '').split(/[;,\s]+/));
  const opens = codes.has('O');
  const closes = codes.has('C');
  if (opens && closes) return 'flip';
  if (side === 'sell' && opens) return 'short';
  if (side === 'buy' && closes) return 'cover';
  return undefined;
}

const ROLE_FORMS = 'date, ticker, side, quantity, price and fees';

/** Lines of a file looked through for its header when its columns are named by hand. */
const HEADER_SEARCH = 40;

export interface HeaderGuess {
  /** The headers of the line most likely to be the table's, as the file spells them. */
  header: string[];
  /** The header each part is in by its usual names or the saved ones, as indexes into `header`; -1 for none. */
  at: Record<Exclude<FillRole, 'fees'>, number>;
  fees: number[];
}

/**
 * The header of the table of trades in a file whose columns were not found, for naming them by hand: of its first lines,
 * the one with the most cells filled. In a statement whose rows start with their section, only the trades' header lines
 * are looked at, without the section and kind. Null for a file with no line of two cells.
 */
export function headerGuess(text: string, saved: Partial<FillColumns> = {}): HeaderGuess | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  const marked = lines.some((l) => MARKED.test(l));
  let best: string[] = [];
  for (const line of marked ? lines.filter((l) => MARKED.test(l)) : lines.slice(0, HEADER_SEARCH)) {
    const cells = splitCsvLine(line, marked ? ',' : detectCsvSeparator(line)).map((c) => c.trim());
    const header = marked ? cells.slice(2) : cells;
    if (header.filter(Boolean).length > best.filter(Boolean).length) best = header;
  }
  if (best.filter(Boolean).length < 2) return null;
  const { at, fees } = columnsOf(best, saved);
  return { header: best, at, fees: fees.filter((i) => i >= 0) };
}

/**
 * Reads a `fills columns` setting: `date = Run Date; ticker = Symbol; side = Action; quantity = Quantity; price = Price ($);
 * fees = Commission ($) + Fees ($)`. A header that holds a +, a ; or a quote is written in quotes, with a quote inside
 * doubled: `fees = "Comm+Fees"`. Parts not named are found by their usual headers. A string is the problem with it.
 */
export function parseFillColumns(text: string): Partial<FillColumns> | string {
  const out: Partial<FillColumns> = {};
  for (const part of splitOutsideQuotes(text, ';')) {
    if (!part.trim()) continue;
    const m = part.match(/^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/s);
    const role = FILL_ROLES.find((r) => r === m?.[1].toLowerCase());
    if (!m || !role) return `"${part.trim()}" does not say which column holds what. Write each as a part, =, and the header, such as price = Price ($); the parts are ${ROLE_FORMS}`;
    if (role in out) return `${role} is named twice`;
    if (!m[2]) return `Write the header of the ${role} column after "${role} ="`;
    const headers = (role === 'fees' ? splitOutsideQuotes(m[2], '+') : [m[2]]).map(unquoted);
    const open = headers.find((h) => h === null);
    if (open !== undefined) return `A header in quotes needs its closing quote: ${m[2].slice(m[2].indexOf('"'))}`;
    if (headers.some((h) => !h)) return 'Write each fees header between the + signs';
    if (role === 'fees') out.fees = headers as string[];
    else out[role] = headers[0]!;
  }
  if (Object.keys(out).length === 0) return `Name at least one column, such as date = Trade Date; the parts are ${ROLE_FORMS}`;
  return out;
}

/** The pieces of `text` between each `sep` that is not inside double quotes. */
function splitOutsideQuotes(text: string, sep: string): string[] {
  const out = [''];
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === sep && !quoted) out.push('');
    else out[out.length - 1] += ch;
  }
  return out;
}

/** A header as written, trimmed, without the quotes around it and with a doubled quote inside as one; null for an unclosed quote. */
function unquoted(written: string): string | null {
  const h = written.trim();
  if (!h.startsWith('"')) return h;
  return /^"(?:[^"]|"")*"$/.test(h) ? h.slice(1, -1).replace(/""/g, '"') : null;
}

/** A header as `fillColumnsText` writes it: in quotes when it holds a character the setting's own syntax uses. */
const quotedHeader = (h: string): string => (/[+;"]/.test(h) ? `"${h.replace(/"/g, '""')}"` : h);

/** The text of a `fills columns` setting for these columns: what `parseFillColumns` reads back as the same. */
export function fillColumnsText(c: Partial<FillColumns>): string {
  return FILL_ROLES.flatMap((role) => {
    if (role === 'fees') return c.fees?.length ? [`fees = ${c.fees.map(quotedHeader).join(' + ')}`] : [];
    return c[role] ? [`${role} = ${quotedHeader(c[role])}`] : [];
  }).join('; ');
}

// --- Matching ----------------------------------------------------------------------------------------------------

export type { FillLog };

/** A strategy the account follows: its share of the account, its fills (the run's `fills`), and its run's times and equity. */
export interface Followed {
  label: string;
  alloc: number;
  log: FillLog;
  t: number[];
  equity: number[];
  /** The run's own bars of each ticker it trades, which its prices are converted with; without them its prices are taken as the broker's. */
  bars?: Map<string, Bars>;
  /** It fills at the close, so its orders are not netted with those others make at the open of the same bar. */
  closeFill?: boolean;
}

/** Prices as the broker sees them, unadjusted for later dividends and splits. */
export interface RawPrices {
  /**
   * What a price of `bars`, one run's own bars of the ticker, is multiplied by to be the broker's price on `day`, and what
   * its shares are divided by to be the broker's shares that day; NaN when that is not known.
   */
  factor(ticker: string, bars: Bars | undefined, day: number): number;
  /** The unadjusted low and high of the ticker's day; null when they are not known. */
  range(ticker: string, day: number): { low: number; high: number } | null;
}

/** The shortest step between bars: a day for daily bars, a week for weekly ones; Infinity for a single bar, whose step is not known. */
const steps = new WeakMap<Bars, number>();
function stepOf(bars: Bars): number {
  let step = steps.get(bars);
  if (step === undefined) {
    step = Infinity;
    for (let i = 1; i < bars.t.length; i++) step = Math.min(step, bars.t[i] - bars.t[i - 1]);
    steps.set(bars, step);
  }
  return step;
}

/**
 * The broker's prices for each ticker in `adjusted` (Yahoo's and Tiingo's, whose prices are adjusted for later dividends
 * and splits) from their daily bars as traded (`raw`). A run's bar is converted by its close against the raw close of the
 * last day it covers, so a weekly bar is converted at its Friday; an intraday bar, whose close is no day's close, is not
 * converted, and neither is a ticker whose raw bars are missing. The prices of other tickers are as traded already, and
 * their days' ranges are read from the runs' own bars (`own`).
 */
export function rawPrices(own: Map<string, Bars>, raw: Map<string, Bars>, adjusted: Set<string>): RawPrices {
  return {
    factor(ticker, bars, day) {
      if (!adjusted.has(ticker)) return 1;
      const r = raw.get(ticker);
      if (!bars || !r || isIntraday(bars.t)) return NaN;
      const i = barAt(bars.t, day);
      if (i < 0) return NaN;
      // A bar covers the days up to the next one, and the last one as many as a step of the bars.
      const j = barAt(r.t, (bars.t[i + 1] ?? bars.t[i] + stepOf(bars)) - 1);
      return j >= 0 && r.t[j] >= bars.t[i] ? r.c[j] / bars.c[i] : NaN;
    },
    range(ticker, day) {
      const bars = adjusted.has(ticker) ? raw.get(ticker) : own.get(ticker);
      if (!bars) return null;
      let low = Infinity;
      let high = -Infinity;
      for (let i = barAt(bars.t, day + DAY - 1); i >= 0 && bars.t[i] >= day; i--) {
        low = Math.min(low, bars.l[i]);
        high = Math.max(high, bars.h[i]);
      }
      return low <= high ? { low, high } : null;
    },
  };
}

export interface MatchOptions {
  /** The `fills from` day: trades before it are not compared. */
  from: number;
  /** The `capital at start`; null leaves sizes and money of trades not made unmeasured. */
  capital: number | null;
  /** The last price of each ticker the strategies trade, in their prices, for a strategy without bars of its own. */
  last: Record<string, number>;
  /**
   * The days each ticker traded on, as ascending UTC midnights, which lateness is counted in. A ticker without them counts
   * Monday to Friday, up to the strategies' last bar.
   */
  days?: Record<string, number[]>;
  /** Without it, the run's prices are compared as they are and no fill is checked against its day's range. */
  raw?: RawPrices;
  /** How many trading days after the strategies' trade a fill still counts as late rather than off plan. */
  lateDays?: number;
}

export const LATE_DAYS = 5;
/** A trade made under this share of its size has the rest counted as not made, and a day's fills this far over what they matched are oversized. */
export const PARTIAL = 0.7;
export const OVERSIZED = 1.3;
/** A price this far outside its day's range is more likely a split than a fill. */
export const OUTSIDE = 0.03;

export type MatchClass = 'on time' | 'partial' | 'oversized' | 'late' | 'skipped' | 'waiting' | 'off-plan';

export interface ModelTrade {
  day: number;
  side: Side;
  /** From the account's position at the strategies' size, before and after the trade. */
  action?: ShortAction;
  /** Shares and money at the account's size, with a capital at start; null without one. */
  quantity: number | null;
  value: number | null;
  /** In the broker's prices. */
  price: number;
  /** The strategies whose fills make it up, by index. */
  strategies: number[];
}

export interface YourTrade {
  day: number;
  side: Side;
  /** As your file says; a flip where a day's fills on one side mix a sale and a short sale, or a cover and a purchase. */
  action?: ShortAction;
  quantity: number;
  price: number;
  fees: number;
  lines: number[];
}

export interface MatchRow {
  ticker: string;
  class: MatchClass;
  /** The part of the strategies' trade of the day on one side that the row covers; null for fills of yours that match none. */
  model: ModelTrade | null;
  /** The part of your fills of a day on one side that the row covers, with their fees on the first row of them; null for a trade or its rest not made. */
  yours: YourTrade | null;
  /** For a late fill: how many trading days after the strategies' trade it came. */
  daysLate: number | null;
  /** Your price against the strategies', in basis points of theirs, worse for you above 0; null when not compared. */
  bps: number | null;
  /** What a fill of the same day cost against the strategies' price, worse for you above 0. */
  slippage: number;
  /** What a late fill cost against the strategies' price. */
  late: number;
  /** What a trade you did not make would have made by the last price: gains missed above 0, losses avoided below. */
  skipped: number;
  fees: number;
  /** For a trade not made: how far the price has moved since, in the trade's favour above 0. */
  move: number | null;
  /** Your price is outside the day's range by more than `OUTSIDE`, most likely from a split: it is not compared. */
  outside: boolean;
  /** The broker's price of the strategies' trade is not known (RawPrices.factor), so yours is not compared with it. */
  unpriced: boolean;
}

export interface TickerCost {
  ticker: string;
  slippage: number;
  /** Slippage as basis points of the value of the fills compared; null when none was. */
  bps: number | null;
  fees: number;
  late: number;
  skipped: number;
  counts: Record<MatchClass, number>;
}

export interface Reconciliation {
  rows: MatchRow[];
  tickers: TickerCost[];
  /** The parts of the cost of not following the rules, and their sum. */
  parts: { slippage: number; fees: number; late: number; skipped: number };
  total: number;
  /** Whether sizes were compared: a capital at start was given. */
  sized: boolean;
  /** Fills of yours before `from`. */
  before: number;
  /** For each strategy with fills compared: the median slippage, as a `slippage:` setting. */
  suggested: { strategy: number; bps: number; fills: number; line: string }[];
}

const CLASSES: readonly MatchClass[] = ['on time', 'partial', 'oversized', 'late', 'skipped', 'waiting', 'off-plan'];
const sign = (side: Side) => (side === 'buy' ? 1 : -1);

/** The equity a strategy had when the account started following it: at its last bar before `from`, else its first. */
function equityAt(s: Followed, from: number): number {
  let i = 0;
  while (i + 1 < s.t.length && s.t[i + 1] < from) i++;
  return s.equity[i];
}

/** One strategy's part of a trade: its shares at the account's size, above 0, and its price, both in its own bars' terms. */
interface Part {
  strategy: number;
  shares: number;
  price: number;
}

/** The strategies' trades of one ticker on one day on one side, at the account's size. */
interface ModelSide {
  ticker: string;
  day: number;
  side: Side;
  action?: ShortAction;
  parts: Part[];
  /** The parts' money, in the strategies' own prices: what is the same whatever a later split or dividend did. */
  value: number;
  strategies: number[];
}

/** Where a moment of the strategies' trades comes in a day: the open, then stops, then the close. */
const MOMENT_ORDER = { open: 0, stop: 1, close: 2 } as const;

/** What a trade on `side` that takes the account's position from `before` to `after` does on the short side. */
function shortAction(side: Side, before: number, after: number): ShortAction | undefined {
  const dust = 1e-9 * Math.max(Math.abs(before), Math.abs(after));
  const was = before > dust ? 1 : before < -dust ? -1 : 0;
  const is = after > dust ? 1 : after < -dust ? -1 : 0;
  if (was * is < 0) return 'flip';
  if (side === 'sell') return was <= 0 ? 'short' : undefined;
  return was < 0 ? 'cover' : undefined;
}

/**
 * The strategies' trades from `from` on, sized to the account. A ticker's orders at one moment, such as the open of a
 * day, net into one, counted in shares as traded since each strategy's prices may be adjusted by another amount. A stop
 * is a moment of its own, and so is a strategy's close, so a position opened and stopped out the same day is a purchase
 * and a sale. A day's moments are then added up on each side apart. Whether a trade is a short sale, a cover or a flip
 * is read from the account's position, the strategies' positions at its size added up, so one strategy's short that
 * another's long outweighs is a plain sale.
 */
function modelTrades(strategies: Followed[], opts: MatchOptions, asTraded: (k: number, ticker: string, day: number) => number): ModelSide[] {
  const moments = new Map<string, { ticker: string; day: number; parts: (Part & { sign: number; traded: number })[]; before?: number; after?: number }>();
  const changes: { asset: string; t: number; at: number; amount: number; key: string | null }[] = [];
  strategies.forEach((s, k) => {
    const start = equityAt(s, opts.from);
    const scale = start > 0 ? (s.alloc * (opts.capital ?? 1)) / start : 0;
    const held = new Map<string, number>();
    const { log } = s;
    for (let j = 0; j < log.t.length; j++) {
      const asset = log.asset[j];
      const change = log.sharesAfter[j] - (held.get(asset) ?? 0);
      held.set(asset, log.sharesAfter[j]);
      if (change === 0 || scale === 0) continue;
      const day = Math.floor(log.t[j] / DAY) * DAY;
      // A margin call's or ruin's close is a moment of its own, like a stop's: it is not where the strategy's orders fill.
      const at = log.kind[j] === 'stop' || log.kind[j] === 'margin' ? 'stop' : s.closeFill ? 'close' : 'open';
      const key = `${asset}\u0000${log.t[j]}\u0000${at}`;
      changes.push({ asset, t: log.t[j], at: MOMENT_ORDER[at], amount: change * scale, key: day < opts.from ? null : key });
      if (day < opts.from) continue;
      let m = moments.get(key);
      if (!m) moments.set(key, (m = { ticker: asset, day, parts: [] }));
      const shares = Math.abs(change * scale);
      m.parts.push({ strategy: k, shares, price: log.price[j], sign: Math.sign(change), traded: shares / asTraded(k, asset, day) });
    }
  });
  // The account's position in each ticker through every change in time order, where a moment's changes come together.
  changes.sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : a.t - b.t || a.at - b.at));
  const position = new Map<string, number>();
  for (const c of changes) {
    const before = position.get(c.asset) ?? 0;
    position.set(c.asset, before + c.amount);
    const m = c.key === null ? undefined : moments.get(c.key);
    if (m) {
      m.before ??= before;
      m.after = before + c.amount;
    }
  }
  const sides = new Map<string, ModelSide>();
  for (const m of moments.values()) {
    const bought = m.parts.reduce((s, p) => s + (p.sign > 0 ? p.traded : 0), 0);
    const sold = m.parts.reduce((s, p) => s + (p.sign < 0 ? p.traded : 0), 0);
    // Orders that cancel out across the strategies leave nothing to do.
    if (Math.abs(bought - sold) <= 1e-9 * (bought + sold)) continue;
    const side: Side = bought > sold ? 'buy' : 'sell';
    // What is left of the larger side, each of its strategies' orders cut in proportion.
    const kept = (Math.max(bought, sold) - Math.min(bought, sold)) / Math.max(bought, sold);
    const key = `${m.ticker}\u0000${m.day}\u0000${side}`;
    const action = shortAction(side, m.before!, m.after!);
    let s = sides.get(key);
    if (!s) sides.set(key, (s = { ticker: m.ticker, day: m.day, side, ...(action ? { action } : {}), parts: [], value: 0, strategies: [] }));
    // A day's moments on one side that do different things went through 0 between them.
    else if (s.action !== action) s.action = 'flip';
    for (const p of m.parts) {
      if (!s.strategies.includes(p.strategy)) s.strategies.push(p.strategy);
      if ((p.sign > 0) !== (side === 'buy')) continue;
      s.parts.push({ strategy: p.strategy, shares: p.shares * kept, price: p.price });
      s.value += p.shares * kept * p.price;
    }
    s.strategies.sort((a, b) => a - b);
  }
  return [...sides.values()];
}

/** Your fills from `from` on, each day's fills of a ticker on each side added up. */
function yourTrades(fills: Fill[], from: number): { ticker: string; trade: YourTrade }[] {
  const days = new Map<string, Fill[]>();
  for (const f of fills) {
    if (f.date < from) continue;
    const key = `${f.ticker}\u0000${f.date}\u0000${f.side}`;
    days.set(key, [...(days.get(key) ?? []), f]);
  }
  return [...days.values()].map((day) => {
    const quantity = day.reduce((s, f) => s + f.quantity, 0);
    const action = day.every((f) => f.action === day[0].action) ? day[0].action : 'flip';
    return {
      ticker: day[0].ticker,
      trade: {
        day: day[0].date,
        side: day[0].side,
        ...(action ? { action } : {}),
        quantity,
        price: day.reduce((s, f) => s + f.quantity * f.price, 0) / quantity,
        fees: day.reduce((s, f) => s + f.fees, 0),
        lines: day.map((f) => f.line),
      },
    };
  });
}

/** The number of trading days of a ticker after `a` up to and including `b`. */
function daysBetween(days: number[], a: number, b: number): number {
  return barAt(days, b) - barAt(days, a);
}

/** Monday to Friday from `from` to `to`, as UTC midnights. */
function weekdays(from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = Math.floor(from / DAY) * DAY; t <= to; t += DAY) if (![0, 6].includes(new Date(t).getUTCDay())) out.push(t);
  return out;
}

/**
 * Sets your fills against the strategies' trades, ticker by ticker and side by side, share for share in time order. Each
 * trade is sized as `alloc × capital at start ÷ the strategy's equity when the account started`, and counted in shares as
 * traded on the day it is set against, with each strategy's prices converted by its own bars (RawPrices). Your fills of a
 * day go first to the trade of that day (on time); what is left of a trade then takes what is left of your fills of the
 * `lateDays` trading days after it, earliest first (late), set against its price on your fill's day, so a split or a
 * dividend between them is no cost. A trade made under `PARTIAL` of its size has the rest as a partial row, or as waiting
 * while its days are not over; one with no fill is skipped, or waiting. What is left of a day of your fills goes with its
 * first row, which is oversized when it is more than `OVERSIZED` of what it matched; a day with no trade is off plan.
 * Without a capital at start each trade and each day of fills counts as one, so a fill matches a trade or does not, and
 * nothing is partial or oversized. The total is exactly the sum of its parts: slippage, fees, late fills and skipped trades.
 */
export function matchFills(strategies: Followed[], fills: Fill[], opts: MatchOptions): Reconciliation {
  const lateDays = opts.lateDays ?? LATE_DAYS;
  const sized = opts.capital !== null;
  const raw = opts.raw ?? { factor: () => 1, range: () => null };
  const factor = (k: number, ticker: string, day: number) => raw.factor(ticker, strategies[k].bars?.get(ticker), day);
  // Shares can still be matched when a price is not known: they are then taken as they are.
  const asTraded = (k: number, ticker: string, day: number) => {
    const f = factor(k, ticker, day);
    return Number.isFinite(f) ? f : 1;
  };
  const days = new Map<string, number[]>();
  const daysOf = (ticker: string) => {
    let d = days.get(ticker);
    if (!d) {
      const end = Math.max(...strategies.map((s) => (s.bars?.get(ticker)?.t ?? s.t).at(-1) ?? -Infinity), ...fills.filter((f) => f.ticker === ticker).map((f) => f.date));
      days.set(ticker, (d = opts.days?.[ticker] ?? weekdays(opts.from, end)));
    }
    return d;
  };
  const inOrder = <T extends { ticker: string }>(day: (x: T) => number) => (a: T, b: T) => day(a) - day(b) || a.ticker.localeCompare(b.ticker);
  const models = modelTrades(strategies, opts, asTraded).sort(inOrder((m) => m.day));
  const yours = yourTrades(fills, opts.from).sort(inOrder((y) => y.trade.day));
  const before = fills.filter((f) => f.date < opts.from).length;

  /** A trade's shares as traded on `day`, and its price that day; NaN when a strategy's price that day is not known. */
  const sharesOn = (m: ModelSide, day: number) => m.parts.reduce((s, p) => s + p.shares / asTraded(p.strategy, m.ticker, day), 0);
  const priceOn = (m: ModelSide, day: number) => (m.parts.every((p) => Number.isFinite(factor(p.strategy, m.ticker, day))) ? m.value / sharesOn(m, day) : NaN);
  /** What a trade is counted in on `day`: its shares, or one without sizes. */
  const units = (m: ModelSide, day: number) => (sized ? sharesOn(m, day) : 1);

  // How much of each trade is left, from 1, and of each day of your fills, in shares or as one.
  const modelLeft = models.map(() => 1);
  const yoursLeft = yours.map((y) => (sized ? y.trade.quantity : 1));
  const pairs: { mi: number; yi: number; amount: number; daysLate: number | null }[] = [];
  const take = (mi: number, yi: number, daysLate: number | null) => {
    const whole = units(models[mi], yours[yi].trade.day);
    const amount = Math.min(modelLeft[mi] * whole, yoursLeft[yi]);
    if (amount <= 1e-9 * whole) return;
    modelLeft[mi] -= amount / whole;
    yoursLeft[yi] -= amount;
    pairs.push({ mi, yi, amount, daysLate });
  };
  const fits = (m: ModelSide, y: { ticker: string; trade: YourTrade }) => y.ticker === m.ticker && y.trade.side === m.side;
  models.forEach((m, mi) => yours.forEach((y, yi) => fits(m, y) && y.trade.day === m.day && take(mi, yi, null)));
  models.forEach((m, mi) => {
    if (modelLeft[mi] <= 1 - PARTIAL) return;
    const all = daysOf(m.ticker);
    yours.forEach((y, yi) => {
      if (!fits(m, y) || y.trade.day <= m.day) return;
      const late = daysBetween(all, m.day, y.trade.day);
      if (late <= lateDays) take(mi, yi, late);
    });
  });

  /** The part of a trade a row covers, `amount` of what it is counted in on `day`. */
  const part = (m: ModelSide, amount: number, day: number): ModelTrade => ({
    day: m.day,
    side: m.side,
    ...(m.action ? { action: m.action } : {}),
    quantity: sized ? amount : null,
    value: sized ? (amount / units(m, day)) * m.value : null,
    price: priceOn(m, day),
    strategies: m.strategies,
  });
  const blank = (ticker: string, cls: MatchClass): MatchRow => ({ ticker, class: cls, model: null, yours: null, daysLate: null, bps: null, slippage: 0, late: 0, skipped: 0, fees: 0, move: null, outside: false, unpriced: false });
  const rows: MatchRow[] = [];

  yours.forEach((y, yi) => {
    const own = pairs.filter((p) => p.yi === yi).sort((a, b) => (a.daysLate ?? -1) - (b.daysLate ?? -1));
    const left = yoursLeft[yi];
    const whole = sized ? y.trade.quantity : 1;
    const shares = (amount: number) => (sized ? amount : y.trade.quantity);
    let offPlan = own.length === 0 ? y.trade.quantity : 0;
    let oversized = false;
    const extra = own.map(() => 0);
    if (own.length > 0 && left > 1e-9 * whole) {
      const big = left > (OVERSIZED - 1) * (whole - left);
      if (!big) extra[0] = left;
      else if (own[0].daysLate === null) [extra[0], oversized] = [left, true];
      else offPlan = left;
    }
    own.forEach((p, k) => {
      const m = part(models[p.mi], p.amount, y.trade.day);
      const trade: YourTrade = { ...y.trade, quantity: shares(p.amount) + extra[k], fees: k === 0 ? y.trade.fees : 0 };
      const range = raw.range(y.ticker, trade.day);
      const unpriced = !Number.isFinite(m.price);
      const outside = range !== null && (trade.price < range.low * (1 - OUTSIDE) || trade.price > range.high * (1 + OUTSIDE));
      const compared = !outside && !unpriced;
      const worse = compared ? sign(m.side) * (trade.price - m.price) * trade.quantity : 0;
      rows.push({
        ...blank(y.ticker, p.daysLate !== null ? 'late' : k === 0 && oversized ? 'oversized' : 'on time'),
        model: m,
        yours: trade,
        daysLate: p.daysLate,
        bps: compared && p.daysLate === null ? (sign(m.side) * (trade.price - m.price) * 1e4) / m.price : null,
        slippage: p.daysLate === null ? worse : 0,
        late: p.daysLate === null ? 0 : worse,
        fees: trade.fees,
        outside,
        unpriced,
      });
    });
    if (offPlan > 0) {
      const fees = own.length === 0 ? y.trade.fees : 0;
      rows.push({ ...blank(y.ticker, 'off-plan'), yours: { ...y.trade, quantity: offPlan, fees }, fees });
    }
  });

  models.forEach((m, mi) => {
    const left = modelLeft[mi];
    if (left < 1 - 1e-9 && left <= 1 - PARTIAL) return;
    const all = daysOf(m.ticker);
    const waiting = daysBetween(all, m.day, all[all.length - 1] ?? m.day) < lateDays;
    // What it would have made by each strategy's last price, in its own prices.
    const made = m.parts.reduce((s, p) => s + p.shares * ((strategies[p.strategy].bars?.get(m.ticker)?.c.at(-1) ?? opts.last[m.ticker]) - p.price), 0) * sign(m.side);
    rows.push({
      ...blank(m.ticker, waiting ? 'waiting' : left >= 1 - 1e-9 ? 'skipped' : 'partial'),
      model: part(m, left * units(m, m.day), m.day),
      skipped: waiting || !sized ? 0 : left * made,
      move: made / m.value,
    });
  });

  const dayOfRow = (r: MatchRow) => (r.model ?? r.yours)!.day;
  rows.sort((a, b) => dayOfRow(a) - dayOfRow(b) || a.ticker.localeCompare(b.ticker) || CLASSES.indexOf(a.class) - CLASSES.indexOf(b.class));

  const tickers: TickerCost[] = [];
  for (const ticker of [...new Set(rows.map((r) => r.ticker))].sort((a, b) => a.localeCompare(b))) {
    const own = rows.filter((r) => r.ticker === ticker);
    const counts = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<MatchClass, number>;
    let slippage = 0;
    let compared = 0;
    let fees = 0;
    let late = 0;
    let skipped = 0;
    for (const r of own) {
      counts[r.class]++;
      slippage += r.slippage;
      if (r.bps !== null) compared += r.yours!.quantity * r.model!.price;
      fees += r.fees;
      late += r.late;
      skipped += r.skipped;
    }
    tickers.push({ ticker, slippage, bps: compared > 0 ? (slippage / compared) * 1e4 : null, fees, late, skipped, counts });
  }
  const parts = { slippage: 0, fees: 0, late: 0, skipped: 0 };
  for (const t of tickers) {
    parts.slippage += t.slippage;
    parts.fees += t.fees;
    parts.late += t.late;
    parts.skipped += t.skipped;
  }

  const suggested = strategies.flatMap((_, k) => {
    const measured = rows.filter((r) => r.bps !== null && r.model!.strategies.includes(k)).map((r) => r.bps!);
    if (measured.length === 0) return [];
    const bps = Math.max(0, Number(median(measured).toFixed(1)));
    return [{ strategy: k, bps, fills: measured.length, line: `slippage: ${bps} bps` }];
  });

  return { rows, tickers, parts, total: parts.slippage + parts.fees + parts.late + parts.skipped, sized, before, suggested };
}
