// A broker's record of trades read into fills, and those fills set against the trades the strategies made. Pure; the
// caller reads the file and hands in each strategy's run.

import { detectCsvSeparator, parseCsvTime, slashedDatesAreDayFirst, splitCsvLine } from './data.ts';
import type { FillSeen } from './engine.ts';
import { DAY } from './format.ts';

export type Side = 'buy' | 'sell';

/** One trade from the broker's file. */
export interface Fill {
  /** The trade's day, as UTC midnight. */
  date: number;
  /** As the strategies spell it when one of them trades it. */
  ticker: string;
  side: Side;
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
}

const PRESETS: readonly Preset[] = [
  { name: 'Charles Schwab', signature: ['date', 'action', 'symbol', 'quantity', 'price', 'fees & comm'], buy: /^buy$/i, sell: /^sell$/i },
  { name: 'Fidelity', signature: ['run date', 'action', 'symbol', 'quantity', 'price'], buy: /^you bought\b/i, sell: /^you sold\b/i },
  { name: 'Interactive Brokers Flex query', signature: ['symbol', 'quantity', 'tradeprice'], buy: /^buy$/i, sell: /^sell$/i },
  { name: 'Interactive Brokers activity statement', signature: ['datadiscriminator', 'symbol', 'date/time', 'quantity', 't price'], buy: null, sell: null },
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
const BUY_WORDS = /\b(?:buy|bought|purchased?)\b/i;
const SELL_WORDS = /\b(?:sell|sold|sale)\b/i;

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

/**
 * The day a cell names: "04/12/2026", Schwab's "04/12/2026 as of 04/10/2026" (the trade was on the 10th), Interactive
 * Brokers' "2026-01-02, 10:00:00", a Flex query's "20260102" or "20260102;100000". NaN when there is none.
 */
function dayOf(cell: string, dayFirst: boolean): number {
  const t = parseCsvTime(dateText(cell), dayFirst);
  return Number.isFinite(t) ? Math.floor(t / DAY) * DAY : NaN;
}

function dateText(cell: string): string {
  const asOf = cell.match(/\bas of\s+(\S+)/i);
  const text = (asOf ? asOf[1] : cell).split(/[;,]/)[0].trim();
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
  const marked = lines.some((l) => /^"?(?:Trades"?,"?Header|HEADER)"?,/.test(l));
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
    const discriminator = names.indexOf('datadiscriminator');
    const wide = Math.max(3, Math.ceil(table.header.length / 2));
    const dayFirst = slashedDatesAreDayFirst(table.rows.map((r) => dateText(r.cells[at.date] ?? '')));

    for (const { cells, line } of table.rows) {
      if (cells.length < wide || cells.every((c) => c === '')) {
        ignored++;
        continue;
      }
      // A statement lists the lots each sale closed under the order; only the orders are trades.
      if (discriminator >= 0 && !/^(?:order|trade)$/i.test(cells[discriminator] ?? '')) {
        ignored++;
        continue;
      }
      const action = at.side >= 0 ? (cells[at.side] ?? '').trim() : '';
      let side: Side | null = null;
      if (action) {
        if (preset?.buy?.test(action)) side = 'buy';
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
      fills.push({ date, ticker, side, quantity: Math.abs(signed), price, fees: paid, line });
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

const ROLE_FORMS = 'date, ticker, side, quantity, price and fees';

/**
 * Reads a `fills columns` setting: `date = Run Date; ticker = Symbol; side = Action; quantity = Quantity; price = Price ($);
 * fees = Commission ($) + Fees ($)`. Parts not named are found by their usual headers. A string is the problem with it.
 */
export function parseFillColumns(text: string): Partial<FillColumns> | string {
  const out: Partial<FillColumns> = {};
  for (const part of text.split(';')) {
    if (!part.trim()) continue;
    const m = part.match(/^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/);
    const role = FILL_ROLES.find((r) => r === m?.[1].toLowerCase());
    if (!m || !role) return `"${part.trim()}" does not say which column holds what. Write each as a part, =, and the header, such as price = Price ($); the parts are ${ROLE_FORMS}`;
    if (role in out) return `${role} is named twice`;
    if (!m[2]) return `Write the header of the ${role} column after "${role} ="`;
    if (role === 'fees') {
      const headers = m[2].split('+').map((h) => h.trim());
      if (headers.some((h) => !h)) return 'Write each fees header between the + signs';
      out.fees = headers;
    } else out[role] = m[2];
  }
  if (Object.keys(out).length === 0) return `Name at least one column, such as date = Trade Date; the parts are ${ROLE_FORMS}`;
  return out;
}

/** The text of a `fills columns` setting for these columns: what `parseFillColumns` reads back as the same. */
export function fillColumnsText(c: Partial<FillColumns>): string {
  return FILL_ROLES.flatMap((role) => {
    if (role === 'fees') return c.fees?.length ? [`fees = ${c.fees.join(' + ')}`] : [];
    return c[role] ? [`${role} = ${c[role]}`] : [];
  }).join('; ');
}

// --- Matching ----------------------------------------------------------------------------------------------------

/**
 * A strategy run's fills, one entry per fill in time order, as columns: when, which asset, what kind of fill, the asset's
 * shares after it and the price it filled at before slippage, in the run's own (adjusted) prices.
 */
export interface FillLog {
  t: number[];
  asset: string[];
  kind: FillSeen['kind'][];
  sharesAfter: number[];
  price: number[];
}

/** A strategy the account follows: its share of the account, its fills, and its run's times and equity. */
export interface Followed {
  label: string;
  alloc: number;
  log: FillLog;
  t: number[];
  equity: number[];
}

/** Prices as the broker sees them, unadjusted for later dividends and splits. */
export interface RawPrices {
  /** What a price of the run at time `t` is multiplied by to be the broker's price that day. */
  factor(ticker: string, t: number): number;
  /** The unadjusted low and high of the ticker's day; null when they are not known. */
  range(ticker: string, day: number): { low: number; high: number } | null;
}

export interface MatchOptions {
  /** The `fills from` day: trades before it are not compared. */
  from: number;
  /** The `capital at start`; null leaves sizes and money of trades not made unmeasured. */
  capital: number | null;
  /** The last price of each ticker the strategies trade, in the run's prices. */
  last: Record<string, number>;
  /** The bar times of each ticker the strategies trade. */
  times: Record<string, number[]>;
  /** Without it, the run's prices are compared as they are and no fill is checked against its day's range. */
  raw?: RawPrices;
  /** How many bars after the strategies' trade a fill still counts as late rather than off plan. */
  lateBars?: number;
}

export const LATE_BARS = 5;
/** A fill this far short of the strategies' size is partial, and this far over it oversized. */
export const PARTIAL = 0.7;
export const OVERSIZED = 1.3;
/** A price this far outside its day's range is more likely a split than a fill. */
export const OUTSIDE = 0.03;

export type MatchClass = 'on time' | 'partial' | 'oversized' | 'late' | 'skipped' | 'waiting' | 'off-plan';

export interface ModelTrade {
  day: number;
  side: Side;
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
  quantity: number;
  price: number;
  fees: number;
  lines: number[];
}

export interface MatchRow {
  ticker: string;
  class: MatchClass;
  /** The strategies' trade of the day, netted across them; null for a fill of yours that matches none. */
  model: ModelTrade | null;
  /** Your fills of the day, added up; null for a trade you did not make. */
  yours: YourTrade | null;
  /** For a late fill: how many bars after the strategies' trade it came. */
  barsLate: number | null;
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

interface Building {
  ticker: string;
  day: number;
  t: number;
  /** Shares at the account's size (or per unit of capital without one), signed, and their value in the run's prices. */
  shares: number;
  value: number;
  gross: number;
  weighted: number;
  /** Each strategy's part: its shares at the account's size and their price, for the result of a trade not made. */
  parts: { strategy: number; shares: number; price: number }[];
}

const sideOf = (b: Building): Side => (b.value > 0 ? 'buy' : 'sell');

/** The strategies' trades from `from` on, each day's fills of a ticker netted across them and sized to the account. */
function modelTrades(strategies: Followed[], opts: MatchOptions): Building[] {
  const trades = new Map<string, Building>();
  strategies.forEach((s, k) => {
    const start = equityAt(s, opts.from);
    const scale = start > 0 ? (s.alloc * (opts.capital ?? 1)) / start : 0;
    const held = new Map<string, number>();
    const { log } = s;
    for (let j = 0; j < log.t.length; j++) {
      const asset = log.asset[j];
      const change = log.sharesAfter[j] - (held.get(asset) ?? 0);
      held.set(asset, log.sharesAfter[j]);
      const day = Math.floor(log.t[j] / DAY) * DAY;
      if (day < opts.from || change === 0 || scale === 0) continue;
      const key = `${asset}\u0000${day}`;
      let b = trades.get(key);
      if (!b) trades.set(key, (b = { ticker: asset, day, t: log.t[j], shares: 0, value: 0, gross: 0, weighted: 0, parts: [] }));
      const shares = change * scale;
      b.shares += shares;
      b.value += shares * log.price[j];
      b.gross += Math.abs(shares * log.price[j]);
      b.weighted += Math.abs(shares * log.price[j]) * log.price[j];
      b.parts.push({ strategy: k, shares, price: log.price[j] });
    }
  });
  // Fills that cancel out across the strategies leave nothing to do.
  return [...trades.values()].filter((b) => Math.abs(b.value) > 1e-9 * b.gross);
}

/** Your fills from `from` on, each day's fills of a ticker added up. */
function yourTrades(fills: Fill[], from: number): { ticker: string; trade: YourTrade }[] {
  const days = new Map<string, { ticker: string; fills: Fill[] }>();
  for (const f of fills) {
    if (f.date < from) continue;
    const key = `${f.ticker}\u0000${f.date}`;
    const d = days.get(key) ?? { ticker: f.ticker, fills: [] };
    d.fills.push(f);
    days.set(key, d);
  }
  return [...days.values()].map(({ ticker, fills: day }) => {
    const net = day.reduce((s, f) => s + sign(f.side) * f.quantity, 0);
    const side: Side = net >= 0 ? 'buy' : 'sell';
    // The price is that of the fills on the side the day comes to.
    const same = day.filter((f) => f.side === side);
    const traded = same.reduce((s, f) => s + f.quantity, 0);
    return {
      ticker,
      trade: {
        day: day[0].date,
        side,
        quantity: Math.abs(net),
        price: same.reduce((s, f) => s + f.quantity * f.price, 0) / traded,
        fees: day.reduce((s, f) => s + f.fees, 0),
        lines: day.map((f) => f.line),
      },
    };
  });
}

/** The number of trading days of a ticker after `a` up to and including `b`. */
function daysBetween(days: number[], a: number, b: number): number {
  const upTo = (d: number) => {
    let lo = 0;
    let hi = days.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid] <= d) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return upTo(b) - upTo(a);
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Sets your fills against the strategies' trades. Each day's trades of a ticker are netted across the strategies and,
 * with a capital at start, sized as `alloc × capital at start ÷ the strategy's equity when the account started`. A fill
 * the same day with the same side is on time (partial or oversized by its value, when sizes are known), one within
 * `lateBars` trading days after is late, and a trade with none is skipped, or waiting while its days are not over. Fills
 * that match no trade are off plan. The total is exactly the sum of its parts: slippage, fees, late fills and skipped trades.
 */
export function matchFills(strategies: Followed[], fills: Fill[], opts: MatchOptions): Reconciliation {
  const lateBars = opts.lateBars ?? LATE_BARS;
  const sized = opts.capital !== null;
  const raw = opts.raw ?? { factor: () => 1, range: () => null };
  const days = new Map<string, number[]>();
  const daysOf = (ticker: string) => {
    let d = days.get(ticker);
    if (!d) days.set(ticker, (d = [...new Set((opts.times[ticker] ?? []).map((t) => Math.floor(t / DAY) * DAY))].sort((a, b) => a - b)));
    return d;
  };

  const models = modelTrades(strategies, opts).sort((a, b) => a.day - b.day || a.ticker.localeCompare(b.ticker));
  const yours = yourTrades(fills, opts.from).sort((a, b) => a.trade.day - b.trade.day || a.ticker.localeCompare(b.ticker));
  const before = fills.filter((f) => f.date < opts.from).length;

  const model = (b: Building): ModelTrade => ({
    day: b.day,
    side: sideOf(b),
    quantity: sized ? Math.abs(b.shares) : null,
    value: sized ? Math.abs(b.value) : null,
    price: (b.weighted / b.gross) * raw.factor(b.ticker, b.t),
    strategies: [...new Set(b.parts.map((p) => p.strategy))],
  });
  const blank = (ticker: string, cls: MatchClass): MatchRow => ({ ticker, class: cls, model: null, yours: null, barsLate: null, bps: null, slippage: 0, late: 0, skipped: 0, fees: 0, move: null, outside: false });

  const rows: MatchRow[] = [];
  const matched = new Set<number>();
  const taken = new Set<number>();
  /** A fill of yours set against a trade of the strategies: its price compared, unless it is outside its day's range. */
  const pair = (mi: number, yi: number, cls: MatchClass, barsLate: number | null) => {
    matched.add(mi);
    taken.add(yi);
    const m = model(models[mi]);
    const y = yours[yi].trade;
    const range = raw.range(yours[yi].ticker, y.day);
    const outside = range !== null && (y.price < range.low * (1 - OUTSIDE) || y.price > range.high * (1 + OUTSIDE));
    const worse = outside ? 0 : sign(m.side) * (y.price - m.price) * y.quantity;
    rows.push({
      ...blank(yours[yi].ticker, cls),
      model: m,
      yours: y,
      barsLate,
      bps: outside || barsLate !== null ? null : (sign(m.side) * (y.price - m.price) * 1e4) / m.price,
      slippage: barsLate === null ? worse : 0,
      late: barsLate === null ? 0 : worse,
      fees: y.fees,
      outside,
    });
  };

  /** Whether a day of your fills can stand for a trade: same ticker and side, not used yet, and not bought and sold back to nothing. */
  const fits = (y: { ticker: string; trade: YourTrade }, k: number, b: Building) => !taken.has(k) && y.ticker === b.ticker && y.trade.side === sideOf(b) && y.trade.quantity > 0;
  // Fills of the same day first, so a late fill is never taken from the trade of its own day.
  models.forEach((b, mi) => {
    const yi = yours.findIndex((y, k) => fits(y, k, b) && y.trade.day === b.day);
    if (yi < 0) return;
    const ratio = sized ? (yours[yi].trade.quantity * yours[yi].trade.price) / Math.abs(b.value) : 1;
    pair(mi, yi, ratio < PARTIAL ? 'partial' : ratio > OVERSIZED ? 'oversized' : 'on time', null);
  });
  models.forEach((b, mi) => {
    if (matched.has(mi)) return;
    const all = daysOf(b.ticker);
    const yi = yours.findIndex((y, k) => fits(y, k, b) && y.trade.day > b.day && daysBetween(all, b.day, y.trade.day) <= lateBars);
    if (yi >= 0) {
      pair(mi, yi, 'late', daysBetween(all, b.day, yours[yi].trade.day));
      return;
    }
    const last = opts.last[b.ticker];
    const m = model(b);
    const waiting = daysBetween(all, b.day, all[all.length - 1] ?? b.day) < lateBars;
    rows.push({
      ...blank(b.ticker, waiting ? 'waiting' : 'skipped'),
      model: m,
      skipped: waiting || !sized ? 0 : b.parts.reduce((s, p) => s + p.shares * (last - p.price), 0),
      move: (sign(m.side) * (last - b.weighted / b.gross)) / (b.weighted / b.gross),
    });
  });
  yours.forEach((y, yi) => {
    if (!taken.has(yi)) rows.push({ ...blank(y.ticker, 'off-plan'), yours: y.trade, fees: y.trade.fees });
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
