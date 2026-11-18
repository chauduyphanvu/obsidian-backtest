import { DAY } from './format.ts';
import { columnName, DATA_SOURCES, plainSource, SOURCE_PREFIX, type Asset, type AssetRef, type DataSource, type Source } from './types.ts';

export type SeriesName = 'open' | 'high' | 'low' | 'close' | 'volume';
export type CmpOp = '>' | '<' | '>=' | '<=' | '==' | '!=' | 'xup' | 'xdn' | 'xany';
/** Values read from the bar's UTC date. */
export type CalName = 'month' | 'day' | 'weekday' | 'year' | 'month_start' | 'month_end';
/** Values that belong to the open position, so only sell and add rules can read them. */
export type PosName = 'bars_held' | 'entry_price' | 'last_entry_price' | 'entries_made' | 'highest_since_entry' | 'lowest_since_entry' | 'position_return';

// `params` on `ind`, `param` on `lag` and `nParam` below name the parameter a period or a lag came
// from, when one did, so the history loaded can cover every value of its range (see lookbackBars).
export type Expr =
  | { k: 'num'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'series'; name: SeriesName }
  | { k: 'ind'; fn: string; src: Expr | null; args: number[]; params?: (string | null)[] }
  | { k: 'math'; fn: 'min' | 'max' | 'abs'; args: Expr[] }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: Expr; b: Expr }
  | { k: 'neg'; a: Expr }
  | { k: 'cmp'; op: CmpOp; a: Expr; b: Expr }
  | { k: 'logic'; op: 'and' | 'or'; a: Expr; b: Expr }
  | { k: 'not'; a: Expr }
  | { k: 'lag'; a: Expr; n: number; param?: string }
  | { k: 'of'; a: Expr; asset: string }
  /** A numeric column of a CSV file, by `columnName`: of the rule's own ticker, or of another through `of`. */
  | { k: 'column'; name: string }
  | { k: 'cal'; name: CalName }
  | { k: 'pos'; name: PosName };

export type Rebalance = 'never' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
/** When an order read at a bar's close fills: at the ticker's next open, or at that same close. */
export type Fill = 'next open' | 'close';
export const FILL: Fill[] = ['next open', 'close'];

export interface Rules {
  /** For a ticker with only short rules, the parser's `false`: it never goes long. */
  buy: Expr;
  sell: Expr | null;
  /** When to make the next entry of a position built in steps, on whichever side is held; present only with an `entries` line. */
  add?: Expr;
  /** When to go short and when to cover, mirroring buy and sell; present only when written. */
  short?: Expr;
  cover?: Expr;
}

/** A ticker's rules in the order buy, sell, add, short, cover, without the ones it does not have. */
export const ruleExprs = (r: Rules): Expr[] => [r.buy, r.sell, r.add, r.short, r.cover].filter((e): e is Expr => !!e);

/**
 * A rule or score as the user wrote it: the whole text, with continuation lines joined by a space;
 * the text of each node of its expression in `walk` order ('' for a part the parser filled in, such
 * as the close an sma reads); and the parameters it reads, by their declared names.
 */
export interface Written {
  text: string;
  parts: string[];
  params: string[];
}

/** A stop distance: a fraction of the price, or a multiple of the average true range. */
export type StopLevel = { k: 'pct'; v: number } | { k: 'atr'; mult: number; n: number; nParam?: string };

export interface Stops {
  stopLoss: StopLevel | null;
  trailingStop: StopLevel | null;
  takeProfit: StopLevel | null;
}

/** What uninvested cash earns: a fixed yearly rate, or a ticker whose close is a yearly yield in percent. */
export type CashRate = { k: 'fixed'; rate: number } | { k: 'ticker'; ref: AssetRef };

/**
 * A charge per order on top of `costs`, in the account's money: a fixed amount per order, or an amount per share
 * (fractions of a share counted as fractions) raised to `min` and then capped at `max` times the order's value.
 */
export type Commission = { k: 'order'; fee: number } | { k: 'share'; fee: number; min: number; max: number | null };

export type Sizing = { k: 'fixed' } | { k: 'invvol'; n: number; nParam?: string } | { k: 'risk'; risk: number; mult: number; n: number; nParam?: string };

export interface Param {
  name: string;
  /** The value used, after overrides. Percentages are fractions. */
  value: number;
  declared: number;
  percent: boolean;
  range: { lo: number; hi: number; step: number } | null;
  line: number;
}

/**
 * What a block that borrows pays and may hold: gross positions (long value plus short value) up to `cap` times equity, a
 * yearly `borrowFee` on the value of its shorts, a yearly `rate` on the money it owes, and a margin call when equity falls
 * below `maintenance` times the gross value of its positions at a close. Rates are fractions.
 */
export interface Margin {
  cap: number;
  borrowFee: number;
  rate: number;
  maintenance: number;
}

/** Equity below this share of the gross value of the positions at a close brings a margin call. */
export const MAINTENANCE = 0.25;
/** The most a block may hold, long and short together, as a multiple of its equity. */
export const MAX_GROSS = 2;

export interface Spec {
  name: string | null;
  universe: Asset[];
  /** Tickers the rules read with `of` that are not held. */
  extras: AssetRef[];
  benchmark: AssetRef | null;
  from: number | null;
  to: number | null;
  /** Start of the out-of-sample part: results before and from this day are reported apart. */
  testFrom: number | null;
  interval: string;
  capital: number;
  costBps: number;
  slippageBps: number;
  rebalance: Rebalance;
  cash: CashRate;
  /** Stops per universe asset name, with the shared ones already filled in. */
  stops: Record<string, Stops>;
  /** Hold the `top` assets with the highest `by` score. */
  rank: { top: number; by: Expr } | null;
  sizing: Sizing;
  params: Param[];
  /** Rules per universe asset name, with the shared rules already filled in. */
  rules: Record<string, Rules>;
  /** Absent means next open. */
  fill?: Fill;
  /** The rules and the ranking score as written, per universe asset name; null where the parser supplied the rule. */
  written?: { rules: Record<string, WrittenRules>; rank: Written | null };
  /** Charged on every order besides `costBps`; absent when there is none. */
  commission?: Commission;
  /** The number of entries a position is built in; absent when the block has no `entries` line. */
  entries?: number;
  /** The smaller bar size each bar is looked inside with, for stops and targets; absent when the block has no `magnify` line. */
  magnify?: string;
  /** Present only when the block can borrow: it has a short or cover rule, or its weights add up to more than 100%. */
  margin?: Margin;
}

/** A ticker's rules as written; null where the parser supplied the rule, absent where the block has none of that kind. */
export interface WrittenRules {
  buy: Written | null;
  sell: Written | null;
  add?: Written | null;
  short?: Written | null;
  cover?: Written | null;
}

export interface Defaults {
  capital: number;
  costBps: number;
  slippageBps: number;
  /** Text of a `cash rate` setting, such as "0%" or "^IRX". */
  cashRate: string;
  dataSource: DataSource;
  /** Used when the block has no `commission` line; absent means none. */
  commission?: Commission;
  /** Yearly rates as fractions for a block that borrows and has no `borrow fee` or `margin rate` line; absent means BORROW_FEE and MARGIN_RATE. */
  borrowFee?: number;
  marginRate?: number;
}

/** The yearly borrow fee on shorts and interest on money owed when neither the block nor the plugin settings give one. */
export const BORROW_FEE = 0.005;
export const MARGIN_RATE = 0.06;

export interface ParseOptions {
  defaults?: Partial<Defaults>;
  /** Parameter name to the value to use instead of the declared one (a fraction for percentages). */
  overrides?: Record<string, number>;
}

export interface Diagnostic {
  /** 1-based line inside the block. */
  line: number;
  message: string;
  /** 0-based columns in that line, half-open; absent means the whole line. */
  from?: number;
  to?: number;
}

export interface ParseResult {
  spec: Spec | null;
  errors: Diagnostic[];
  /** Things worth knowing that do not stop the run. */
  warnings: Diagnostic[];
}

export interface IndicatorDef {
  /** The series used when none is given (null: the function takes no series). */
  src: SeriesName | null;
  /** The numeric parameters with their defaults (null: required). */
  params: (number | null)[];
  /** Parameters that are any number above 0 rather than a whole period, by position, with what a message calls them. */
  real?: Record<number, string>;
  /** The shortest the first period can be, when that is more than 1. */
  min?: number;
  /** A first argument the function cannot do without: the other ticker's series, or a condition. */
  lead?: 'series' | 'condition';
}

/** Functions that read a series or a condition and take periods. Those that need high, low or volume read the ticker's own bars. */
export const INDICATORS: Record<string, IndicatorDef> = {
  sma: { src: 'close', params: [null] },
  ema: { src: 'close', params: [null] },
  rsi: { src: 'close', params: [14] },
  roc: { src: 'close', params: [null] },
  stdev: { src: 'close', params: [null] },
  highest: { src: 'high', params: [null] },
  lowest: { src: 'low', params: [null] },
  atr: { src: null, params: [14] },
  macd: { src: 'close', params: [12, 26] },
  macd_signal: { src: 'close', params: [12, 26, 9] },
  bb_upper: { src: 'close', params: [20, 2], real: { 1: 'band width' } },
  bb_lower: { src: 'close', params: [20, 2], real: { 1: 'band width' } },
  stoch_k: { src: null, params: [14, 3] },
  stoch_d: { src: null, params: [14, 3, 3] },
  adx: { src: null, params: [14] },
  plus_di: { src: null, params: [14] },
  minus_di: { src: null, params: [14] },
  cci: { src: null, params: [20], min: 2 },
  williams_r: { src: null, params: [14] },
  mfi: { src: null, params: [14] },
  obv: { src: null, params: [] },
  vwap: { src: null, params: [20] },
  keltner_upper: { src: 'close', params: [20, 2, 10], real: { 1: 'band width' } },
  keltner_lower: { src: 'close', params: [20, 2, 10], real: { 1: 'band width' } },
  supertrend: { src: null, params: [10, 3], real: { 1: 'multiplier' } },
  supertrend_up: { src: null, params: [10, 3], real: { 1: 'multiplier' } },
  wma: { src: 'close', params: [null] },
  hma: { src: 'close', params: [null], min: 2 },
  median: { src: 'close', params: [null] },
  zscore: { src: 'close', params: [null], min: 2 },
  percent_rank: { src: 'close', params: [null] },
  slope: { src: 'close', params: [null], min: 2 },
  correl: { src: 'close', params: [null], min: 2, lead: 'series' },
  count: { src: null, params: [null], lead: 'condition' },
  bars_since: { src: null, params: [], lead: 'condition' },
};

/** Functions whose value is a condition, 1 or 0, so a rule can be written with them alone. */
export const CONDITIONS = ['supertrend_up'];

export const SERIES: SeriesName[] = ['open', 'high', 'low', 'close', 'volume'];
export const CALENDAR: CalName[] = ['month', 'day', 'weekday', 'year', 'month_start', 'month_end'];
/** How each position value is written. */
export const POSITION: Record<PosName, string> = {
  bars_held: 'bars held',
  entry_price: 'entry price',
  last_entry_price: 'last entry price',
  entries_made: 'entries made',
  highest_since_entry: 'highest since entry',
  lowest_since_entry: 'lowest since entry',
  position_return: 'position return',
};
export const BINANCE_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'];
const YAHOO_INTERVALS = ['1d', '1w'];
/**
 * The bars Yahoo serves inside its daily bars, with the days of history each reaches back: its chart API answers a request
 * for older ones with "The requested range must be within the last 60 days" (730 for 1h). Its 1m bars reach back 30 days
 * but only 8 days a request, so they are not offered. Inside a weekly bar, Yahoo's daily bars serve its whole history.
 */
export const YAHOO_INSIDE_DAYS: Record<string, number> = { '2m': 60, '5m': 60, '15m': 60, '30m': 60, '1h': 730 };
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** The length of a bar size such as 5m, 1h, 1d or 1w in milliseconds; NaN for anything else. */
export function intervalMs(interval: string): number {
  const m = interval.match(/^(\d+)([mhdw])$/);
  return m ? Number(m[1]) * UNIT_MS[m[2]] : NaN;
}
export const REBALANCE: Rebalance[] = ['never', 'weekly', 'monthly', 'quarterly', 'yearly'];

export const SETTINGS = [
  'name', 'universe', 'symbol', 'from', 'to', 'data', 'interval', 'capital', 'costs', 'size', 'rebalance', 'benchmark',
  'stop loss', 'trailing stop', 'take profit', 'slippage', 'cash rate', 'test from', 'hold', 'weighting', 'risk per trade', 'fill',
  'commission', 'entries', 'magnify', 'borrow fee', 'margin rate',
];
/** The settings a `for TICKER:` section can hold. */
export const STOP_SETTINGS = ['stop loss', 'trailing stop', 'take profit'];

/** Names a parameter can't take. */
export const RESERVED = new Set([
  'and', 'or', 'not', 'crosses', 'above', 'below', 'is', 'of', 'buy', 'sell', 'when', 'for', 'all', 'in', 'step', 'at', 'top', 'by',
  'true', 'false', 'always', 'never', 'min', 'max', 'abs', 'bars', 'entry', 'bars_held', 'entry_price', 'last_entry_price', 'entries_made',
  'between', 'within', 'highest_since_entry', 'lowest_since_entry', 'position_return',
  ...SERIES, ...Object.keys(INDICATORS), ...CALENDAR, ...SETTINGS.filter((s) => !s.includes(' ')),
]);

/** `name = value`, optionally followed by `in lo..hi step s`. A single `=`, so `x == 1` stays a comparison. */
export const PARAM_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*(.*)$/;

/** A number as a setting or parameter writes it, with an optional `%`. */
export const NUM = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*%)?`;
const PARAM_VALUE = new RegExp(String.raw`^(${NUM})(?:\s+in\s+(${NUM})\s*\.\.\s*(${NUM})(?:\s+step\s+(${NUM}))?)?$`, 'id');
/** What a parameter's value starts with: a number, alone or followed by `in`. Any other value after `name =` defines a name. */
const PARAM_SHAPE = new RegExp(String.raw`^(?:${NUM})(?:\s+in\b|$)`, 'i');
/** Whether the value of a `name = value` line is a parameter's (an empty one is too, so the parameter's message explains it). */
export const isParamValue = (value: string): boolean => value === '' || PARAM_SHAPE.test(value);
const MAX_PARAM_VALUES = 200;
/** The longest period a function or a setting can take, so a range reaching past it needs no more history than this. */
export const MAX_PERIOD = 10_000;
const MAX_ENTRIES = 10;
/** `2 atr(14)`, `2.5 atr` or `k atr(n)`; a name needs a space before atr, so a parameter called `flatr` stays itself. The period is trimmed by the caller. */
const ATR_DISTANCE = /^(\d+(?:\.\d+)?|\.\d+|[A-Za-z_][A-Za-z0-9_]*(?=\s))\s*atr\s*(?:\(([^)]*)\))?$/i;
/** A setting's name: words with runs of spaces between them, so no two parts of the pattern compete for the same spaces. */
const SETTING_NAME = /^([A-Za-z]+(?: +[A-Za-z]+)*)\s*:/;
const SETTING_LINE = new RegExp(SETTING_NAME.source + String.raw`\s*(.*)$`);
/** The most tokens of definitions that reading one rule may go through, so definitions built from definitions cannot grow without bound. */
const MAX_GROWN = 3000;
/** Deepest an expression may nest: brackets, function calls and operators each add a level. */
const MAX_DEPTH = 64;
const TOO_DEEP = `This rule nests too deeply. Keep it to at most ${MAX_DEPTH} levels of brackets, functions and operators`;

/** Where a problem is: a line, and columns in it when they are known. */
interface At {
  line: number;
  from?: number;
  to?: number;
}

class SpecError extends Error {
  at: At;
  constructor(at: At, message: string) {
    super(message);
    this.at = at;
  }
}

/** A position value read where no position can be: kept apart so a definition that reads one is blamed at its use. */
class PositionError extends SpecError {
  pos: PosName;
  constructor(at: At, message: string, pos: PosName) {
    super(at, message);
    this.pos = pos;
  }
}

/** Stops a rule that uses a definition with an error of its own, which is reported on the definition's line, not again here. */
class Quiet extends Error {}

function diag(at: At, message: string): Diagnostic {
  return at.from === undefined ? { line: at.line, message } : { line: at.line, message, from: at.from, to: at.to };
}

interface Tok {
  t: 'num' | 'id' | 'sym' | 'op' | 'end';
  s: string;
  v: number;
  line: number;
  from: number;
  to: number;
}

const at = (t: Tok): At => ({ line: t.line, from: t.from, to: t.to });
/** From the start of `a` to the end of `b`; the whole line when they sit on different lines. */
const span = (a: Tok, b: Tok): At => (a.line === b.line ? { line: a.line, from: a.from, to: Math.max(a.to, b.to) } : { line: a.line });

/** `offset` is the column of `text[0]` in its line. */
function lex(text: string, line: number, offset: number, out: Tok[]): void {
  let i = 0;
  const push = (t: Tok['t'], s: string, from: number, to: number, v = 0) => out.push({ t, s, v, line, from: offset + from, to: offset + to });
  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\s+/))) {
      i += m[0].length;
    } else if ((m = rest.match(/^(\d+(?:\.\d+)?|\.\d+)(\s*%)?/))) {
      push('num', m[0], i, i + m[0].length, m[2] ? Number(m[1]) / 100 : Number(m[1]));
      i += m[0].length;
    } else if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/))) {
      const word = m[0].toLowerCase();
      const start = i;
      i += m[0].length;
      if (word === 'of') {
        // A ticker can hold characters that are operators elsewhere (BTC-USD, BRK.B, ^VIX).
        const sym = text.slice(i).match(/^\s*([A-Za-z0-9^:/._=-]+)/);
        if (!sym) throw new SpecError({ line, from: offset + start, to: offset + i }, 'Expected a ticker after "of"');
        push('op', 'of', start, i);
        push('sym', sym[1], i + sym[0].length - sym[1].length, i + sym[0].length);
        i += sym[0].length;
      } else if (word === 'column' && (m = text.slice(i).match(/^(\s*\(\s*)(?:"([^"]*)"|([A-Za-z0-9_]+))(\s*\))/))) {
        // A column's name is read as written, so a name may start with a digit or sit in quotes with spaces in it.
        const written = m[2] !== undefined ? m[2].length + 2 : m[3].length;
        const nameAt = i + m[1].length;
        push('id', word, start, i);
        push('op', '(', i + m[1].indexOf('('), i + m[1].indexOf('(') + 1);
        push('sym', m[2] ?? m[3], nameAt, nameAt + written);
        push('op', ')', nameAt + written + m[4].indexOf(')'), nameAt + written + m[4].indexOf(')') + 1);
        i = nameAt + written + m[4].length;
      } else {
        push('id', word, start, i);
      }
    } else if ((m = rest.match(/^(>=|<=|==|!=|[()[\],+\-*/><=])/))) {
      push('op', m[0], i, i + m[0].length);
      i += m[0].length;
    } else {
      throw new SpecError({ line, from: offset + i, to: offset + i + 1 }, `Unexpected character "${rest[0]}"`);
    }
  }
}

/**
 * Where a line's comment starts: at a `#` or `//` at the start of the line or after a space or tab, but not inside the
 * quotes of `column("...")`, where a header may hold one. -1 when the line has none.
 */
export function commentAt(line: string): number {
  const quoted = [...line.matchAll(/column\s*\(\s*"[^"]*"/gi)].map((m) => [m.index, m.index + m[0].length]);
  for (const m of line.matchAll(/(^|\s)(#|\/\/)/g)) {
    const at = m.index + m[1].length;
    if (!quoted.some(([a, b]) => at > a && at < b)) return at;
  }
  return -1;
}

export function isBool(e: Expr): boolean {
  switch (e.k) {
    case 'bool':
    case 'cmp':
    case 'logic':
    case 'not':
      return true;
    case 'cal':
      return e.name === 'month_start' || e.name === 'month_end';
    case 'ind':
      return CONDITIONS.includes(e.fn);
    case 'lag':
    case 'of':
      return isBool(e.a);
    default:
      return false;
  }
}

const COLUMN_USAGE = 'column needs the name of a column in brackets, as in column(score) of signals. A name is letters, digits and underscores; a header with spaces goes in quotes, as in column("News Sentiment")';

/**
 * Whether a part of a rule that joins conditions stands for one thing the user wrote, so a table of its parts keeps it whole
 * instead of opening it into the chain it sits in: a definition's name, or `a between lo and hi`, which is two comparisons.
 * `text` gives the text of a part, from `Written.parts`.
 */
export function isOneThing(e: Expr, text: (x: Expr) => string): boolean {
  const own = text(e);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(own)) return true;
  return e.k === 'logic' && e.op === 'and' && e.a.k === 'cmp' && e.a.op === '>=' && e.b.k === 'cmp' && e.b.op === '<=' && own.startsWith(`${text(e.a.a)} between `);
}

/** The first position value the expression reads, or null when it reads none. */
export function findPos(e: Expr): PosName | null {
  switch (e.k) {
    case 'pos':
      return e.name;
    case 'ind':
      return e.src ? findPos(e.src) : null;
    case 'math':
      for (const a of e.args) {
        const p = findPos(a);
        if (p) return p;
      }
      return null;
    case 'bin':
    case 'cmp':
    case 'logic':
      return findPos(e.a) ?? findPos(e.b);
    case 'neg':
    case 'not':
    case 'lag':
    case 'of':
      return findPos(e.a);
    default:
      return null;
  }
}

/** The expressions directly inside `e`, in the order they are written. */
export function children(e: Expr): Expr[] {
  switch (e.k) {
    case 'ind':
      return e.src ? [e.src] : [];
    case 'math':
      return e.args;
    case 'bin':
    case 'cmp':
    case 'logic':
      return [e.a, e.b];
    case 'neg':
    case 'not':
    case 'lag':
    case 'of':
      return [e.a];
    default:
      return [];
  }
}

/** Calls `fn` on `e` and then on everything inside it, depth first, in the order written: the order of `Written.parts`. */
export function walk(e: Expr, fn: (e: Expr) => void): void {
  fn(e);
  for (const c of children(e)) walk(c, fn);
}

/** A price series as it is, maybe lagged: null for the rule's own ticker, the name for `of`; undefined otherwise. */
function barePrice(e: Expr): string | null | undefined {
  if (e.k === 'series') return e.name === 'volume' ? undefined : null;
  if (e.k === 'lag') return barePrice(e.a);
  if (e.k === 'of') return barePrice(e.a) === undefined ? undefined : e.asset;
  return undefined;
}

function isFixed(e: Expr): boolean {
  switch (e.k) {
    case 'num':
      return true;
    case 'neg':
      return isFixed(e.a);
    case 'bin':
      return isFixed(e.a) && isFixed(e.b);
    case 'math':
      return e.args.every(isFixed);
    default:
      return false;
  }
}

/** The first column an expression reads from the ticker its rule belongs to: one that no `of` sends to another ticker. */
export function ownColumns(e: Expr): Extract<Expr, { k: 'column' }>[] {
  if (e.k === 'column') return [e];
  return e.k === 'of' ? [] : children(e).flatMap(ownColumns);
}

const SOURCE_NAME: Record<Source, string> = { yahoo: 'Yahoo', binance: 'Binance', csv: 'a CSV file', tiingo: 'Tiingo', fred: 'FRED' };
const COLUMN_EXAMPLE = 'column(score) of csv:Data/signals.csv';

/** Why a column cannot be read from a ticker whose prices come from `source`. */
function notCsv(name: string, asset: string, source: Source): string {
  return `${asset} comes from ${SOURCE_NAME[source]}, not from a CSV file, so it has no column called ${name}. Name the file, as in ${COLUMN_EXAMPLE.replace('score', name)}`;
}

/** A `name = expression` line: a name for a condition or a number, replaced by its expression wherever it is used. */
interface Definition {
  /** As written. */
  name: string;
  nameAt: At;
  line: number;
  /** Its expression's tokens, with the end token last. */
  toks: Tok[];
  /** `new` until its expression is checked on its own, then `ok`, or `bad` once an error was reported on its line. */
  state: 'new' | 'busy' | 'ok' | 'bad';
  used: boolean;
  /** Whether it is a condition rather than a number, once checked. */
  bool?: boolean;
}

interface ExprContext {
  resolveAsset(sym: Tok): string;
  defs: Map<string, Definition>;
  /**
   * Checks a definition's expression on its own, once, where position values are allowed; false when it has an error.
   * `via` is the token that names it, in the definition being read when it is read from another.
   */
  checkDef(d: Definition, via?: Tok): boolean;
  /** Reading a definition to check it, not to use it: it is not counted as used. */
  checking?: true;
  /** Where a ticker `resolveAsset` named gets its prices from. */
  sourceOf(name: string): Source | null;
  params: Map<string, Param>;
  /** Position values only exist while a position is open, which only sell and add rules see. */
  positions: boolean;
  /** A price compared with a fixed number; `asset` is the `of` ticker, or null for the rule's own. */
  priceVsNumber(at: At, asset: string | null): void;
  /** The block's text from the start of token `a` to the end of token `b`, lines joined by a space. */
  text(a: Tok, b: Tok): string;
}

class ExprParser {
  private i = 0;
  private toks: Tok[];
  private ctx: ExprContext;
  /** How deep the parse is in nested brackets, calls and prefix operators. */
  private nesting = 0;
  /** Depth of each expression built so far; leaves are 1. */
  private depths = new WeakMap<Expr, number>();
  /** The first and last token of each expression, its brackets included. */
  private spans = new Map<Expr, [number, number]>();
  /** Text and place of the nodes that are not made of this parser's own tokens: a definition's, and ones made up for `between` and windows. */
  private told = new Map<Expr, { text: string; at: At | null }>();
  /** Numbers that are a parameter's value, with its name. */
  private paramOf = new Map<Expr, string>();
  /** The expression a definition stands for where it is used, with the definition's name. */
  private defUse = new Map<Expr, string>();
  /** Parameters read, by their declared names. */
  private used = new Set<string>();
  /** How many tokens of definitions have been read so far for the expression, nested ones included, shared with the parsers that read them. */
  private grown: { tokens: number };

  constructor(toks: Tok[], ctx: ExprContext, parent?: ExprParser) {
    this.toks = toks;
    this.ctx = ctx;
    this.nesting = parent?.nesting ?? 0;
    this.grown = parent?.grown ?? { tokens: 0 };
  }

  /** The parsed expression as written; call after parseCondition or parseNumber. */
  written(root: Expr): Written {
    const parts: string[] = [];
    walk(root, (e) => parts.push(this.textOf(e)));
    return { text: this.ctx.text(this.toks[0], this.toks[this.toks.length - 2]), parts, params: [...this.used] };
  }

  private textOf(e: Expr): string {
    const s = this.spans.get(e);
    return s ? this.ctx.text(this.toks[s[0]], this.toks[s[1]]) : (this.told.get(e)?.text ?? '');
  }

  private placeOf(e: Expr): At | null {
    const s = this.spans.get(e);
    return s ? span(this.toks[s[0]], this.toks[s[1]]) : (this.told.get(e)?.at ?? null);
  }

  private mark<T extends Expr>(e: T, start: number): T {
    this.spans.set(e, [start, this.i - 1]);
    return e;
  }

  /** A copy of `e` that reads as `e` does: the same text, place and depth for every node. */
  private copy<T extends Expr>(e: T): T {
    const out = structuredClone(e);
    const was: Expr[] = [];
    walk(e, (x) => was.push(x));
    let k = 0;
    walk(out, (y) => {
      const x = was[k++];
      const s = this.spans.get(x);
      if (s) this.spans.set(y, s);
      else this.told.set(y, { text: this.textOf(x), at: this.placeOf(x) });
      const d = this.depths.get(x);
      if (d !== undefined) this.depths.set(y, d);
    });
    return out;
  }

  /** `e` as text for a node made up from it. */
  private said<T extends Expr>(e: T, text: string): T {
    this.told.set(e, { text, at: null });
    return e;
  }

  parseCondition(): Expr {
    const e = this.or();
    this.expectEnd();
    if (!isBool(e)) throw new SpecError(this.spanFrom(0), 'A rule needs a condition, such as close > sma(200)');
    return e;
  }

  /** A definition's expression: a condition or a number. */
  parseValue(): Expr {
    const e = this.or();
    this.expectEnd();
    return e;
  }

  parseNumber(what: string): Expr {
    const e = this.or();
    this.expectEnd();
    if (isBool(e)) throw new SpecError(this.spanFrom(0), `${what} needs a number, such as roc(126), not a condition`);
    return e;
  }

  private expectEnd(): void {
    const t = this.peek();
    if (t.t !== 'end') throw new SpecError(at(t), `Unexpected "${t.s}"`);
  }
  private spanFrom(start: number): At {
    return span(this.toks[start], this.toks[Math.max(start, this.i - 1)]);
  }
  private peek(): Tok {
    return this.toks[this.i];
  }
  private next(): Tok {
    return this.toks[this.i++];
  }
  private isOp(s: string): boolean {
    const t = this.peek();
    return t.t === 'op' && t.s === s;
  }
  private isId(s: string): boolean {
    const t = this.peek();
    return t.t === 'id' && t.s === s;
  }
  private expect(s: string): void {
    const t = this.next();
    if (t.t !== 'op' || t.s !== s) throw new SpecError(at(t), `Expected "${s}"${t.t === 'end' ? '' : ` but found "${t.s}"`}`);
  }
  private needBool(e: Expr, t: Tok, word: string): Expr {
    if (!isBool(e)) throw new SpecError(at(t), `"${word}" needs a condition on each side, such as close > sma(200)`);
    return e;
  }
  private needNum(e: Expr, t: Tok, what: string): Expr {
    if (isBool(e)) throw new SpecError(at(t), `${what} needs a number, not a condition`);
    return e;
  }
  /** Runs `fn` one level deeper, refusing to go past MAX_DEPTH before the call stack runs out. */
  private deeper<T>(fn: () => T): T {
    if (++this.nesting > MAX_DEPTH) throw new SpecError(at(this.peek()), TOO_DEEP);
    try {
      return fn();
    } finally {
      this.nesting--;
    }
  }
  /** `e` with its depth recorded; a chain such as a + b + c + ... grows one level per term. */
  private node<T extends Expr>(e: T, t: Tok, ...kids: Expr[]): T {
    let d = 1;
    for (const k of kids) d = Math.max(d, 1 + (this.depths.get(k) ?? 1));
    if (d > MAX_DEPTH) throw new SpecError(at(t), TOO_DEEP);
    this.depths.set(e, d);
    return e;
  }

  private or(): Expr {
    return this.deeper(() => {
      const start = this.i;
      let a = this.and();
      while (this.isId('or')) {
        const t = this.next();
        const b = this.and();
        a = this.mark(this.node({ k: 'logic', op: 'or', a: this.needBool(a, t, 'or'), b: this.needBool(b, t, 'or') }, t, a, b), start);
      }
      return a;
    });
  }

  private and(): Expr {
    const start = this.i;
    let a = this.not();
    while (this.isId('and')) {
      const t = this.next();
      const b = this.not();
      a = this.mark(this.node({ k: 'logic', op: 'and', a: this.needBool(a, t, 'and'), b: this.needBool(b, t, 'and') }, t, a, b), start);
    }
    return a;
  }

  private not(): Expr {
    if (this.isId('not')) {
      const start = this.i;
      const t = this.next();
      const a = this.deeper(() => this.not());
      return this.mark(this.node({ k: 'not', a: this.needBool(a, t, 'not') }, t, a), start);
    }
    return this.cmp();
  }

  private cmpOp(): CmpOp | null {
    const t = this.peek();
    if (t.t === 'op' && ['>', '<', '>=', '<=', '==', '!=', '='].includes(t.s)) {
      this.next();
      return t.s === '=' ? '==' : (t.s as CmpOp);
    }
    if (t.t !== 'id') return null;
    if (t.s === 'crosses') {
      this.next();
      if (this.isId('above')) {
        this.next();
        return 'xup';
      }
      if (this.isId('below')) {
        this.next();
        return 'xdn';
      }
      return 'xany';
    }
    if (t.s === 'is') {
      const after = this.toks[this.i + 1];
      if (after.t === 'id' && (after.s === 'above' || after.s === 'below')) this.next();
    }
    if (this.isId('above')) {
      this.next();
      return '>';
    }
    if (this.isId('below')) {
      this.next();
      return '<';
    }
    return null;
  }

  private cmp(): Expr {
    const start = this.i;
    const a = this.sum();
    if (this.isId('between')) return this.windows(this.between(a, start), start);
    const t = this.peek();
    const op = this.cmpOp();
    if (!op) return this.windows(a, start);
    const b = this.sum();
    // Two conditions can be compared for equality, as in uptrend of SPY == false: they are 1 and 0 where they are known.
    const conditions = (op === '==' || op === '!=') && isBool(a) && isBool(b);
    const e: Expr = this.mark(
      this.node({ k: 'cmp', op, a: conditions ? a : this.needNum(a, t, 'A comparison'), b: conditions ? b : this.needNum(b, t, 'A comparison') }, t, a, b),
      start,
    );
    const pa = barePrice(a);
    const pb = barePrice(b);
    const price = pa !== undefined && isFixed(b) ? pa : pb !== undefined && isFixed(a) ? pb : undefined;
    if (price !== undefined) this.ctx.priceVsNumber(this.spanFrom(start), price);
    return this.windows(e, start);
  }

  /** `a between lo and hi`: a >= lo and a <= hi, with a read twice. */
  private between(a: Expr, start: number): Expr {
    const t = this.next();
    const example = 'rsi(2) between 10 and 30';
    const lo = this.sum();
    if (!this.isId('and')) throw new SpecError(at(this.peek()), `"between" takes two values joined by "and", as in ${example}`);
    this.next();
    const hi = this.sum();
    this.needNum(a, t, '"between"');
    this.needNum(lo, t, '"between"');
    this.needNum(hi, t, '"between"');
    const [aText, loText, hiText] = [this.textOf(a), this.textOf(lo), this.textOf(hi)];
    const low = this.said(this.node({ k: 'cmp', op: '>=', a, b: lo }, t, a, lo), `${aText} >= ${loText}`);
    const again = this.copy(a);
    const high = this.said(this.node({ k: 'cmp', op: '<=', a: again, b: hi }, t, again, hi), `${aText} <= ${hiText}`);
    const e: Expr = this.mark(this.node({ k: 'logic', op: 'and', a: low, b: high }, t, low, high), start);
    const pa = barePrice(a);
    if (pa !== undefined && (isFixed(lo) || isFixed(hi))) this.ctx.priceVsNumber(this.spanFrom(start), pa);
    return e;
  }

  /**
   * `cond for n bars` and `cond within n bars`, read on the comparison, so `a and b for 3 bars` is `a and (b for 3 bars)`:
   * count(cond, n) is n, or at least 1.
   */
  private windows(cond: Expr, start: number): Expr {
    let e = cond;
    while (this.isId('for') || this.isId('within')) {
      const t = this.next();
      const every = t.s === 'for';
      const example = every ? 'close > sma(200) for 3 bars' : 'close > sma(200) within 3 bars';
      if (!isBool(e)) throw new SpecError(at(t), `"${t.s}" needs a condition before it, as in ${example}`);
      const n = this.next();
      const p = n.t === 'id' ? this.ctx.params.get(n.s) : undefined;
      const v = n.t === 'num' ? n.v : p?.value;
      if (n.t === 'id' && this.ctx.defs.has(n.s)) {
        throw new SpecError(at(n), `"${n.s}" is a definition, and the number of bars must be a number or a parameter. Declare it as a parameter instead, as in ${n.s} = 3`);
      }
      if (v === undefined || !Number.isInteger(v) || v < 1 || v > MAX_PERIOD) {
        throw new SpecError(at(n), `"${t.s}" needs a whole number of bars from 1 to ${MAX_PERIOD}, as in ${example}`);
      }
      const unit = this.next();
      if (unit.t !== 'id' || (unit.s !== 'bars' && unit.s !== 'bar')) throw new SpecError(at(unit), `Write "bars" after the number, as in ${example}`);
      const pos = findPos(e);
      if (pos) {
        throw new SpecError(
          this.spanFrom(start),
          `"${POSITION[pos]}" can't be read over several bars: it only exists for the open position at this bar. Read it outside the window, as in sell when bars held > 5 and close < sma(20) for 3 bars`,
        );
      }
      if (p) this.used.add(p.name);
      const [condText, nText] = [this.textOf(e), this.ctx.text(n, n)];
      const counted: Expr = this.said(
        this.node(p ? { k: 'ind', fn: 'count', src: e, args: [v], params: [p.name] } : { k: 'ind', fn: 'count', src: e, args: [v] }, t, e),
        `count(${condText}, ${nText})`,
      );
      const target = this.said(this.node({ k: 'num', v: every ? v : 1 }, t), every ? nText : '1');
      e = this.mark(this.node({ k: 'cmp', op: every ? '==' : '>=', a: counted, b: target }, t, counted, target), start);
    }
    return e;
  }

  private sum(): Expr {
    const start = this.i;
    let a = this.prod();
    while (this.isOp('+') || this.isOp('-')) {
      const t = this.next();
      const b = this.prod();
      a = this.mark(this.node({ k: 'bin', op: t.s as '+' | '-', a: this.needNum(a, t, `"${t.s}"`), b: this.needNum(b, t, `"${t.s}"`) }, t, a, b), start);
    }
    return a;
  }

  private prod(): Expr {
    const start = this.i;
    let a = this.unary();
    while (this.isOp('*') || this.isOp('/')) {
      const t = this.next();
      const b = this.unary();
      a = this.mark(this.node({ k: 'bin', op: t.s as '*' | '/', a: this.needNum(a, t, `"${t.s}"`), b: this.needNum(b, t, `"${t.s}"`) }, t, a, b), start);
    }
    return a;
  }

  private unary(): Expr {
    if (this.isOp('-')) {
      const start = this.i;
      const t = this.next();
      const a = this.deeper(() => this.unary());
      return this.mark(this.node({ k: 'neg', a: this.needNum(a, t, '"-"') }, t, a), start);
    }
    return this.postfix();
  }

  private postfix(): Expr {
    const start = this.i;
    let e = this.primary();
    for (;;) {
      if (this.isOp('[')) {
        const open = this.next();
        const n = this.next();
        const p = n.t === 'id' ? this.ctx.params.get(n.s) : undefined;
        const v = n.t === 'num' ? n.v : p?.value;
        if (n.t === 'id' && this.ctx.defs.has(n.s)) {
          throw new SpecError(at(n), `"${n.s}" is a definition, and bars ago must be a whole number or a parameter. Declare it as a parameter instead, as in ${n.s} = 5`);
        }
        if (v === undefined || !Number.isInteger(v) || v < 0) throw new SpecError(at(n), 'Bars ago must be a whole number, as in close[1]');
        this.expect(']');
        const pos = findPos(e);
        if (pos) throw new SpecError(span(open, this.toks[this.i - 1]), `"${POSITION[pos]}" can't be read for an earlier bar with [n]`);
        if (p) this.used.add(p.name);
        e = this.mark(this.node(p ? { k: 'lag', a: e, n: v, param: p.name } : { k: 'lag', a: e, n: v }, open, e), start);
      } else if (this.isOp('of')) {
        const of = this.next();
        const sym = this.next();
        const pos = findPos(e);
        if (pos) throw new SpecError(span(of, sym), `"${POSITION[pos]}" belongs to the open position, so it can't be read with "of"`);
        const asset = this.ctx.resolveAsset(sym);
        const source = this.ctx.sourceOf(asset);
        const read = ownColumns(e)[0];
        if (read && source !== null && source !== 'csv') throw new SpecError(span(of, sym), notCsv(read.name, asset, source));
        e = this.mark(this.node({ k: 'of', a: e, asset }, of, e), start);
      } else {
        return e;
      }
    }
  }

  private primary(): Expr {
    const start = this.i;
    const t = this.next();
    if (t.t === 'op' && t.s === '(') {
      const e = this.or();
      this.expect(')');
      return this.mark(e, start);
    }
    return this.mark(this.leaf(t), start);
  }

  private leaf(t: Tok): Expr {
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'id') {
      if (t.s === 'true' || t.s === 'always') return { k: 'bool', v: true };
      if (t.s === 'false' || t.s === 'never') return { k: 'bool', v: false };
      if ((SERIES as string[]).includes(t.s)) return { k: 'series', name: t.s as SeriesName };
      if (t.s === 'min' || t.s === 'max' || t.s === 'abs') return this.math(t);
      if (t.s === 'column' && this.isOp('(')) return this.column(t);
      if ((t.s === 'highest' || t.s === 'lowest') && this.isId('since')) return this.position(t)!;
      if (t.s in INDICATORS) return this.indicator(t);
      if ((CALENDAR as string[]).includes(t.s)) return { k: 'cal', name: t.s as CalName };
      const pos = this.position(t);
      if (pos) return pos;
      const d = this.ctx.defs.get(t.s);
      if (d) return this.definition(t, d);
      const p = this.ctx.params.get(t.s);
      if (p) {
        this.used.add(p.name);
        const e: Expr = { k: 'num', v: p.value };
        this.paramOf.set(e, p.name);
        return e;
      }
      if (t.s === 'column') throw new SpecError(at(t), COLUMN_USAGE);
      const known = [
        `Series: ${SERIES.join(', ')}`,
        `Functions: ${Object.keys(INDICATORS).join(', ')}, min, max, abs, column`,
        `Dates: ${CALENDAR.join(', ')}`,
        ...(this.ctx.params.size ? [`Parameters: ${[...this.ctx.params.values()].map((x) => x.name).join(', ')}`] : []),
        ...(this.ctx.defs.size ? [`Definitions: ${[...this.ctx.defs.values()].map((x) => x.name).join(', ')}`] : []),
      ];
      throw new SpecError(at(t), `Unknown name "${t.s}". ${known.join('. ')}`);
    }
    throw new SpecError(at(t), t.t === 'end' ? 'The rule ends too early' : `Unexpected "${t.s}"`);
  }

  /** `column(score)`: the name was read as one token, so the brackets and the name are all that follow. */
  private column(t: Tok): Expr {
    this.next();
    const name = this.peek();
    if (name.t !== 'sym') throw new SpecError(span(t, name), COLUMN_USAGE);
    this.next();
    this.expect(')');
    const key = columnName(name.s);
    if (!key) throw new SpecError(at(name), `A column's name needs a letter or a digit, and "${name.s}" has none`);
    return { k: 'column', name: key };
  }

  /** Each column the expression reads from its rule's own ticker, with where it was written. */
  ownColumns(root: Expr): { name: string; at: At }[] {
    return ownColumns(root).map((e) => ({ name: e.name, at: this.placeOf(e)! }));
  }

  private position(t: Tok): Expr | null {
    let name: PosName;
    let end = t;
    const pairs: Record<string, [string, PosName]> = { bars: ['held', 'bars_held'], entry: ['price', 'entry_price'], entries: ['made', 'entries_made'] };
    if (Object.hasOwn(POSITION, t.s)) {
      name = t.s as PosName;
    } else if ((t.s === 'highest' || t.s === 'lowest') && this.isId('since')) {
      this.next();
      if (!this.isId('entry')) throw new SpecError(at(this.peek()), `"${t.s} since" needs "entry" after it, as in ${t.s} since entry`);
      end = this.next();
      name = t.s === 'highest' ? 'highest_since_entry' : 'lowest_since_entry';
    } else if (t.s === 'position' && this.isId('return')) {
      // "position" alone stays free for a parameter's name.
      end = this.next();
      name = 'position_return';
    } else if (Object.hasOwn(pairs, t.s)) {
      const [second, full] = pairs[t.s];
      if (!this.isId(second)) throw new SpecError(at(t), `"${t.s}" on its own is not a name. Write "${t.s} ${second}"`);
      end = this.next();
      name = full;
    } else if (t.s === 'last' && this.isId('entry') && this.toks[this.i + 1].t === 'id' && this.toks[this.i + 1].s === 'price') {
      // "last" alone stays free for a parameter's name.
      this.next();
      end = this.next();
      name = 'last_entry_price';
    } else {
      return null;
    }
    if (!this.ctx.positions) throw new PositionError(span(t, end), `"${POSITION[name]}" only makes sense in a sell, cover or add rule`, name);
    return { k: 'pos', name };
  }

  /** A definition used: its expression read again where it stands, so a position value in it is checked for this rule. */
  private definition(t: Tok, d: Definition): Expr {
    if (!this.ctx.checkDef(d, t)) throw new Quiet();
    if ((this.grown.tokens += d.toks.length) > MAX_GROWN) {
      throw new SpecError(at(t), 'This rule grows too big once its definitions are filled in. Use fewer definitions inside definitions, or write them shorter');
    }
    const sub = new ExprParser(d.toks, this.ctx, this);
    let root: Expr;
    try {
      root = sub.parseValue();
    } catch (e) {
      if (e instanceof PositionError) throw new PositionError(at(t), `"${d.name}" reads "${POSITION[e.pos]}", which only makes sense in a sell, cover or add rule`, e.pos);
      throw e;
    }
    if (!this.ctx.checking) d.used = true;
    for (const n of sub.used) this.used.add(n);
    walk(root, (x) => this.told.set(x, { text: sub.textOf(x), at: sub.placeOf(x) }));
    this.told.delete(root);
    this.depths.set(root, sub.depths.get(root) ?? 1);
    this.defUse.set(root, d.name);
    return root;
  }

  private args(): { e: Expr; at: At }[] {
    const out: { e: Expr; at: At }[] = [];
    if (!this.isOp('(')) return out;
    this.next();
    if (this.isOp(')')) {
      this.next();
      return out;
    }
    for (;;) {
      const start = this.i;
      const e = this.or();
      out.push({ e, at: this.spanFrom(start) });
      if (this.isOp(',')) this.next();
      else break;
    }
    this.expect(')');
    return out;
  }

  private math(t: Tok): Expr {
    const fn = t.s as 'min' | 'max' | 'abs';
    const start = this.i - 1;
    const args = this.args();
    const want = fn === 'abs' ? 1 : 2;
    if (args.length !== want) throw new SpecError(this.spanFrom(start), `${fn}() takes ${want} value${want > 1 ? 's' : ''}`);
    for (const a of args) this.needNum(a.e, t, `${fn}()`);
    return this.node({ k: 'math', fn, args: args.map((a) => a.e) }, t, ...args.map((a) => a.e));
  }

  private indicator(t: Tok): Expr {
    const def = INDICATORS[t.s];
    const start = this.i - 1;
    const args = this.args();
    let src: Expr | null = def.src ? { k: 'series', name: def.src } : null;
    let rest = args;
    if (def.lead === 'condition') {
      const counts = def.params.length > 0;
      const example = counts ? `${t.s}(close > close[1], 10)` : `${t.s}(close crosses above sma(50))`;
      if (args.length !== 1 + def.params.length) {
        throw new SpecError(this.spanFrom(start), counts ? `${t.s}() takes a condition and a number of bars, as in ${example}` : `${t.s}() takes one condition, as in ${example}`);
      }
      if (!isBool(args[0].e)) throw new SpecError(args[0].at, `${t.s}() needs a condition, not a number, as in ${example}`);
      src = args[0].e;
      rest = args.slice(1);
    } else if (def.lead === 'series') {
      if (args.length === 0 || args[0].e.k === 'num') throw new SpecError(this.spanFrom(start), `${t.s}() needs the other ticker's series first, as in ${t.s}(close of SPY, 60)`);
      src = this.needNum(args[0].e, t, `${t.s}()`);
      rest = args.slice(1);
    } else if (def.src && args.length > 0 && (args[0].e.k !== 'num' || args.length > def.params.length)) {
      src = this.needNum(args[0].e, t, `${t.s}()`);
      rest = args.slice(1);
    }
    if (src) {
      const pos = findPos(src);
      if (pos) throw new SpecError(args[0].at, `"${POSITION[pos]}" can't go inside ${t.s}(): it only exists while a position is open`);
    }
    if (rest.length > def.params.length) {
      throw new SpecError(this.spanFrom(start), def.params.length === 0 ? `${t.s}() takes no arguments` : `${t.s}() takes at most ${def.params.length} number${def.params.length > 1 ? 's' : ''}`);
    }
    const nums = def.params.map((dflt, i) => {
      const a = rest[i];
      if (!a) {
        if (dflt === null) throw new SpecError(this.spanFrom(start), `${t.s}() needs a period, as in ${t.s}(${def.lead === 'series' ? 'close of SPY, 20' : '20'})`);
        return dflt;
      }
      const named = this.defUse.get(a.e);
      if (named !== undefined) throw new SpecError(a.at, `"${named}" is a definition, and ${t.s}() needs a plain number for its period. Declare it as a parameter instead, as in ${named} = 20`);
      if (a.e.k !== 'num') throw new SpecError(a.at, `${t.s}() periods must be plain numbers`);
      const n = a.e.v;
      const noun = def.real?.[i];
      const shortest = i === 0 ? (def.min ?? 1) : 1;
      if (noun ? n <= 0 : !Number.isInteger(n) || n < shortest || n > MAX_PERIOD) {
        throw new SpecError(a.at, `${t.s}(): ${n} is not a valid ${noun ?? 'period'}${noun ? '' : `. Use a whole number from ${shortest} to ${MAX_PERIOD}`}`);
      }
      return n;
    });
    const params = def.params.map((_, i) => (rest[i] ? (this.paramOf.get(rest[i].e) ?? null) : null));
    const e: Expr = params.some((p) => p !== null) ? { k: 'ind', fn: t.s, src, args: nums, params } : { k: 'ind', fn: t.s, src, args: nums };
    return this.node(e, t, ...(src ? [src] : []));
  }
}

function parseRef(text: string, defaultSource: Source, where: At): AssetRef {
  const prefix = text.match(SOURCE_PREFIX);
  const m = prefix && text.length > prefix[0].length ? prefix : null;
  const source = m ? (m[1].toLowerCase() as Source) : plainSource(text, defaultSource);
  const raw = m ? text.slice(m[0].length) : text;
  if (source === 'csv') {
    const base = raw.split('/').pop()!.replace(/\.csv$/i, '');
    if (!base) throw new SpecError(where, `"${text}" is not a CSV path`);
    return { name: base, source, id: raw };
  }
  if (!/^[A-Za-z0-9^._=-]+$/.test(raw)) throw new SpecError(where, `"${raw}" is not a ticker`);
  const id = raw.toUpperCase();
  return { name: id, source, id };
}

/** Why a FRED series cannot `role`: it holds values, not prices a position could be bought or held at. */
function notPrices(ref: AssetRef, role: string): string {
  return `fred:${ref.id} is a series of values from FRED, not prices, so it cannot ${role}. A rule can read it instead, as in close of fred:${ref.id} > 0`;
}

/** The error for a ref whose name is already taken by a different source or file; null when there is no clash. */
function clash(ref: AssetRef, known: AssetRef[]): string | null {
  const other = known.find((a) => a.name.toLowerCase() === ref.name.toLowerCase());
  if (!other || (other.source === ref.source && other.id === ref.id)) return null;
  return `${other.name} is used for two different things here: ${other.source}:${other.id} and ${ref.source}:${ref.id}. Rename the CSV file or use one of them.`;
}

/** The largest of the usual bar sizes that fits a whole number of times into `interval`; null when none is smaller. */
function sizeInside(interval: string): string | null {
  const big = intervalMs(interval);
  return ['1d', '1h', '15m', '5m', '1m'].find((s) => intervalMs(s) < big && big % intervalMs(s) === 0) ?? null;
}

/** Why `magnify: size` can't look inside the strategy's `interval` bars of these sources; null when it can. */
function magnifyProblem(size: string, interval: string, sources: Source[]): string | null {
  const small = intervalMs(size);
  const big = intervalMs(interval);
  if (Number.isNaN(big)) return null;
  const example = sizeInside(interval);
  const such = example ? `, such as ${example}` : '';
  if (Number.isNaN(small)) return `magnify takes a bar size smaller than the strategy's ${interval} bars${such}`;
  if (small >= big) {
    return example ? `magnify needs bars shorter than the strategy's ${interval} bars${such}` : `${interval} bars are the shortest there are, so magnify can't look inside them`;
  }
  if (big % small !== 0) return `A ${interval} bar does not hold a whole number of ${size} bars. Use a size that divides it${such}`;
  if (sources.every((s) => s === 'csv')) return 'magnify looks inside bars with smaller bars from Yahoo or Binance, and CSV files have none';
  if (sources.every((s) => s === 'csv' || s === 'tiingo')) {
    return `magnify looks inside bars with smaller bars from Yahoo or Binance, and ${sources.includes('csv') ? 'Tiingo and CSV files have' : 'Tiingo has'} none here`;
  }
  if (sources.includes('yahoo')) {
    if (interval === '1w' && size !== '1d') return `Yahoo can look inside weekly bars with 1d bars only, not ${size}`;
    const offered = Object.keys(YAHOO_INSIDE_DAYS);
    if (interval === '1d' && !offered.includes(size)) return `Yahoo can look inside daily bars with ${offered.join(', ')} bars, not ${size}`;
  }
  if (sources.includes('binance') && !BINANCE_INTERVALS.includes(size)) return `Binance can look inside bars with ${BINANCE_INTERVALS.filter((s) => intervalMs(s) < big && big % intervalMs(s) === 0).join(', ')} bars, not ${size}`;
  return null;
}

function parseDate(text: string, where: At): number {
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  if (Number.isNaN(ms)) throw new SpecError(where, `"${text}" is not a date. Write it as 2015-01-31`);
  return ms;
}

function parsePercent(text: string, where: At, what: string, max: number): number {
  const m = text.match(/^(\d+(?:\.\d+)?)\s*%/);
  if (!m || Number(m[1]) <= 0 || Number(m[1]) > max) throw new SpecError(where, `${what} must be a percentage, such as 10%`);
  return Number(m[1]) / 100;
}

function parseCapital(text: string, where: At): number {
  const m = text.replace(/[$,_\s]/g, '').match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
  const mult = m && m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1;
  if (!m || Number(m[1]) * mult <= 0) throw new SpecError(where, `"${text}" is not an amount. Write it as 10000 or 10k`);
  return Number(m[1]) * mult;
}

function parseBps(what: string) {
  return (text: string, where: At): number => {
    const m = text.match(/^(\d+(?:\.\d+)?)\s*(bps?|%)?$/i);
    if (!m) throw new SpecError(where, `"${text}" is not ${what === 'Costs' ? 'a cost' : 'a slippage'}. Write it as 5 bps or 0.05%`);
    const bps = m[2] === '%' ? Number(m[1]) * 100 : Number(m[1]);
    if (bps >= 1000) throw new SpecError(where, `${what} must be under 10% per trade`);
    return bps;
  };
}

const COMMISSION_FORMS = 'Write it as 1 for a fixed amount per order, or as 0.005 per share, with min 1 or max 1% after it if you want them';

/** `1`, `1 per order`, `0.005 per share`, `0.005 per share, min 1, max 1%`; null for no commission (`0`). */
function parseCommission(text: string, where: At): Commission | null {
  const parts = text.split(',').map((x) => x.trim());
  const head = parts[0].match(/^\$?\s*(\d+(?:\.\d+)?|\.\d+)(?:\s+per\s+(order|share))?$/i);
  if (!head) throw new SpecError(where, `"${text}" is not a commission. ${COMMISSION_FORMS}`);
  const fee = Number(head[1]);
  if (head[2]?.toLowerCase() !== 'share') {
    if (parts.length > 1) throw new SpecError(where, '"min" and "max" go with a commission per share, as in 0.005 per share, min 1, max 1%');
    return fee === 0 ? null : { k: 'order', fee };
  }
  if (fee === 0) throw new SpecError(where, 'The commission per share must be above 0');
  let min: number | null = null;
  let max: number | null = null;
  for (const part of parts.slice(1)) {
    const m = part.match(/^(min|max)\s+(.*)$/i);
    if (!m) throw new SpecError(where, `Can't read "${part}". After the amount per share, write min 1 or max 1%`);
    const which = m[1].toLowerCase();
    if ((which === 'min' ? min : max) !== null) throw new SpecError(where, `"${which}" is written twice`);
    if (which === 'min') {
      const v = m[2].match(/^\$?\s*(\d+(?:\.\d+)?|\.\d+)$/);
      if (!v || Number(v[1]) <= 0) throw new SpecError(where, 'The minimum must be an amount above 0, as in min 1');
      min = Number(v[1]);
    } else {
      const v = m[2].match(/^(\d+(?:\.\d+)?|\.\d+)\s*%$/);
      if (!v || Number(v[1]) <= 0 || Number(v[1]) >= 10) throw new SpecError(where, 'The maximum must be a percentage of the order\'s value, above 0% and under 10%, as in max 1%');
      max = Number(v[1]) / 100;
    }
  }
  return { k: 'share', fee, min: min ?? 0, max };
}

/** The values a parameter's range steps through, rounded so 0.1 + 0.2 reads as 0.3. */
export function paramValues(p: Param): number[] {
  if (!p.range) return [p.value];
  const { lo, hi, step } = p.range;
  const count = Math.floor((hi - lo) / step + 1e-9) + 1;
  return Array.from({ length: count }, (_, k) => Number((lo + k * step).toPrecision(12)));
}

interface ParamLine {
  name: string;
  nameAt: At;
  value: string;
  valueFrom: number;
  line: number;
}

function parseParam(p: ParamLine): Param {
  const m = p.value.match(PARAM_VALUE);
  const whole: At = { line: p.line, from: p.valueFrom, to: p.valueFrom + p.value.length };
  if (!m) throw new SpecError(whole, `Write a parameter as ${p.name} = 50, or with a range to try, as ${p.name} = 50 in 20..100 step 10`);
  const part = (g: number): At => {
    const [from, to] = m.indices![g]!;
    return { line: p.line, from: p.valueFrom + from, to: p.valueFrom + to };
  };
  const pieces = [m[1], m[2], m[3], m[4]];
  const percent = pieces.some((s) => s !== undefined && s.includes('%'));
  const num = (s: string) => Number(s.replace('%', '').trim()) / (percent ? 100 : 1);
  const value = num(m[1]);
  let range: Param['range'] = null;
  if (m[2] !== undefined) {
    const lo = num(m[2]);
    const hi = num(m[3]);
    const step = m[4] !== undefined ? num(m[4]) : percent ? 0.01 : 1;
    const bounds: At = { line: p.line, from: part(2).from, to: part(3).to };
    if (m[4] !== undefined && step <= 0) throw new SpecError(part(4), 'The step must be above 0');
    if (lo > hi) throw new SpecError(bounds, `The range starts above where it ends. Write the smaller number first, as ${m[3]}..${m[2]}`);
    if (value < lo || value > hi) throw new SpecError(part(1), `${m[1]} is outside the range ${m[2]}..${m[3]}`);
    const count = Math.floor((hi - lo) / step + 1e-9) + 1;
    if (count > MAX_PARAM_VALUES) throw new SpecError(bounds, `This range has ${count} values. The most is ${MAX_PARAM_VALUES}: use a larger step`);
    range = { lo, hi, step };
  }
  return { name: p.name, value, declared: value, percent, range, line: p.line };
}

interface SettingLine {
  key: string;
  value: string;
  line: number;
  keyAt: At;
  valueAt: At;
}

type RuleSide = 'buy' | 'sell' | 'add' | 'short' | 'cover';

/** The tickers of a `for` line, each with where its name is written and the list as written; null after `for all:` or before any `for` line. */
type ScopeItem = { name: string; at: At; label: string };
type Scope = ScopeItem[] | null;

/** Something that takes the tokens of the lines after its first one: a rule, or a definition. */
interface Open {
  toks: Tok[];
}

interface RawRule extends Open {
  side: RuleSide;
  scope: Scope;
  line: number;
  head: At;
}

const BUILTIN_DEFAULTS: Defaults = { capital: 10_000, costBps: 0, slippageBps: 0, cashRate: '0%', dataSource: 'yahoo' };

export function parseSpec(source: string, opts: ParseOptions = {}): ParseResult {
  const given = opts.defaults ?? {};
  const defaults: Defaults = {
    capital: given.capital ?? BUILTIN_DEFAULTS.capital,
    costBps: given.costBps ?? BUILTIN_DEFAULTS.costBps,
    slippageBps: given.slippageBps ?? BUILTIN_DEFAULTS.slippageBps,
    cashRate: given.cashRate ?? BUILTIN_DEFAULTS.cashRate,
    dataSource: given.dataSource ?? BUILTIN_DEFAULTS.dataSource,
    commission: given.commission,
    borrowFee: given.borrowFee,
    marginRate: given.marginRate,
  };
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const settings = new Map<string, SettingLine>();
  const scoped: { scope: NonNullable<Scope>; s: SettingLine }[] = [];
  const decls: (ParamLine | Definition)[] = [];
  const rawRules: RawRule[] = [];
  let scope: Scope = null;
  let open: Open | null = null;

  /** Runs `fn`, which reports a problem by throwing; false when it did (one of a definition that already has its error is not reported again). */
  const guard = (fn: () => void): boolean => {
    try {
      fn();
      return true;
    } catch (e) {
      if (e instanceof Quiet) return false;
      if (!(e instanceof SpecError)) throw e;
      errors.push(diag(e.at, e.message));
      return false;
    }
  };

  /** The tickers a `for` line names, with the problems of the list reported once; null for `for all:`. */
  const readScope = (text: string, lead: number, line: number): Scope => {
    const names = text.slice(3, -1);
    if (names.trim().toLowerCase() === 'all') return null;
    const label = names.trim();
    const list: NonNullable<Scope> = [];
    let offset = lead + 3;
    for (const piece of names.split(',')) {
      const name = piece.trim();
      const from = offset + piece.length - piece.trimStart().length;
      const where: At = { line, from, to: from + name.length };
      offset += piece.length + 1;
      if (!name) errors.push(diag({ line, from: lead, to: lead + text.length }, 'Name a ticker between the commas, as in for SPY, QQQ:'));
      else if (name.toLowerCase() === 'all') errors.push(diag(where, '"all" means every ticker, so it can\'t be listed with others. Write it alone, as in for all:'));
      else if (list.some((x) => x.name.toLowerCase() === name.toLowerCase())) errors.push(diag(where, `${name} is listed twice. List each ticker once, as in for SPY, QQQ:`));
      else list.push({ name, at: where, label });
    }
    return list;
  };

  /** Each line without its comment, for quoting rules as written. */
  const plainLines: string[] = [];
  source.split('\n').forEach((rawLine, idx) => {
    const line = idx + 1;
    const raw = rawLine.replace(/\r$/, '');
    const comment = commentAt(raw);
    // The space or tab before the mark goes with the comment.
    const stripped = comment < 0 ? raw : raw.slice(0, Math.max(0, comment - 1));
    plainLines.push(stripped);
    const text = stripped.trim();
    const lead = stripped.length - stripped.trimStart().length;
    if (!text) {
      open = null;
      return;
    }
    let m: RegExpMatchArray | null;
    const forName = /^for\s/i.test(text) && text.endsWith(':') ? text.slice(4, -1).trim() : '';
    if (forName) {
      open = null;
      scope = readScope(text, lead, line);
    } else if ((m = text.match(/^(buy|sell|add|short|cover)\s+when\b(.*)$/i))) {
      const exprFrom = text.length - m[2].length;
      const rule: RawRule = { side: m[1].toLowerCase() as RawRule['side'], scope, line, head: { line, from: lead, to: lead + exprFrom }, toks: [] };
      open = rule;
      rawRules.push(rule);
      guard(() => lex(m![2], line, lead + exprFrom, rule.toks));
    } else if ((m = text.match(SETTING_LINE)) && SETTINGS.includes(m[1].toLowerCase().replace(/\s+/g, ' '))) {
      open = null;
      const key = m[1].toLowerCase().replace(/\s+/g, ' ').replace(/^symbol$/, 'universe');
      const keyAt = { line, from: lead, to: lead + m[1].length };
      const s: SettingLine = { key, value: m[2], line, keyAt, valueAt: { line, from: lead + text.length - m[2].length, to: lead + text.length } };
      if (!m[2]) errors.push(diag(keyAt, `"${key}" has no value`));
      else if (scope !== null) {
        if (STOP_SETTINGS.includes(key)) scoped.push({ scope, s });
        else errors.push(diag(keyAt, `"${key}" applies to the whole strategy. Put it above the first "for" line or after "for all:"`));
      } else if (settings.has(key)) errors.push(diag(keyAt, `"${key}" is set twice`));
      else settings.set(key, s);
    } else if ((m = text.match(PARAM_LINE)) && !RESERVED.has(m[1].toLowerCase())) {
      const nameAt = { line, from: lead, to: lead + m[1].length };
      const valueFrom = lead + text.length - m[2].length;
      if (isParamValue(m[2])) {
        open = null;
        decls.push({ name: m[1], nameAt, value: m[2], valueFrom, line });
      } else {
        const def: Definition = { name: m[1], nameAt, line, toks: [], state: 'new', used: false };
        open = def;
        decls.push(def);
        if (!guard(() => lex(m![2], line, valueFrom, def.toks))) def.state = 'bad';
      }
    } else if (open) {
      const into: Open = open;
      if (!guard(() => lex(text, line, lead, into.toks)) && 'state' in into) (into as Definition).state = 'bad';
    } else if ((m = text.match(PARAM_LINE))) {
      errors.push(diag({ line, from: lead, to: lead + m[1].length }, `"${m[1]}" is a built-in name. Give the parameter another name, such as my_${m[1].toLowerCase()}`));
    } else if ((m = text.match(SETTING_NAME))) {
      errors.push(diag({ line, from: lead, to: lead + m[1].length }, `Unknown setting "${m[1]}". Settings: ${SETTINGS.join(', ')}`));
    } else {
      errors.push({ line, message: 'Not a setting or a rule. Rules start with "buy when", "sell when", "short when" or "cover when"' });
    }
  });

  // Parameters and definitions first, so every other line can use them wherever they sit.
  const params = new Map<string, Param>();
  const defs = new Map<string, Definition>();
  for (const p of decls) {
    guard(() => {
      const key = p.name.toLowerCase();
      if (params.has(key) || defs.has(key)) throw new SpecError(p.nameAt, `"${p.name}" is declared twice`);
      if ('toks' in p) defs.set(key, p);
      else params.set(key, parseParam(p));
    });
  }
  for (const [name, v] of Object.entries(opts.overrides ?? {})) {
    const p = params.get(name.toLowerCase());
    if (p) p.value = v;
    else errors.push({ line: 1, message: `There is no parameter "${name}" to set. Declare it in the block first, such as ${name} = 50` });
  }

  const get = <T>(key: string, parse: (value: string, where: At) => T, dflt: T): T => {
    const s = settings.get(key);
    if (!s) return dflt;
    let out = dflt;
    guard(() => {
      out = parse(s.value.trim(), s.valueAt);
    });
    return out;
  };
  const oneOf = <T extends string>(options: readonly T[], what: string) => (value: string, where: At): T => {
    const v = value.toLowerCase() as T;
    if (!options.includes(v)) throw new SpecError(where, `${what} must be one of: ${options.join(', ')}`);
    return v;
  };
  /** A setting number, written out or as a parameter's name. */
  const plain = (text: string, where: At, what: string, example: string): number => {
    const p = params.get(text.toLowerCase());
    const d = defs.get(text.toLowerCase());
    if (d) throw new SpecError(where, `"${d.name}" is a definition, and ${what} needs a number or a parameter. Declare it as a parameter instead, as in ${d.name} = 10`);
    if (p) {
      if (p.percent) throw new SpecError(where, `${what} needs a plain number, and "${p.name}" is a percentage`);
      return p.value;
    }
    if (!/^\d+(\.\d+)?$/.test(text)) throw new SpecError(where, `${what} needs a number, as in ${example}`);
    return Number(text);
  };
  const percentage = (text: string, where: At, what: string, max: number): number => {
    const p = params.get(text.toLowerCase());
    const d = defs.get(text.toLowerCase());
    if (d) throw new SpecError(where, `"${d.name}" is a definition, and ${what} needs a percentage or a parameter. Declare it as a parameter instead, as in ${d.name} = 10%`);
    if (!p) return parsePercent(text, where, what, max * 100);
    if (!p.percent) throw new SpecError(where, `${what} needs a percentage, and "${p.name}" is a plain number. Declare it as ${p.name} = 10%`);
    if (p.value <= 0 || p.value > max) throw new SpecError(where, `${what} is ${Number((p.value * 100).toPrecision(6))}% here, but must be above 0% and at most ${max * 100}%`);
    return p.value;
  };
  const period = (text: string, where: At, what: string, min: number): number => {
    const n = text === '' ? 14 : plain(text, where, what, `${what.replace(/\(\)$/, '')}(14)`);
    if (!Number.isInteger(n) || n < min || n > MAX_PERIOD) throw new SpecError(where, `${what}: ${n} is not a valid period. Use a whole number from ${min} to ${MAX_PERIOD}`);
    return n;
  };
  /** `{ nParam }` when a period is written as a parameter's name, to spread into the setting's value. */
  const periodParam = (text: string): { nParam: string } | object => {
    const p = params.get(text.toLowerCase());
    return p ? { nParam: p.name } : {};
  };
  const stopLevel = (what: string, max: number) => (text: string, where: At): StopLevel => {
    const m = text.match(ATR_DISTANCE);
    if (!m) {
      const p = params.get(text.toLowerCase());
      if (!p && !defs.has(text.toLowerCase()) && !/^\d+(\.\d+)?\s*%/.test(text)) throw new SpecError(where, `${what} must be a percentage, such as 10%, or a multiple of the average true range, such as 2 atr(14)`);
      return { k: 'pct', v: percentage(text, where, what, max) };
    }
    const mult = plain(m[1], where, `The ${what} distance`, '2 atr(14)');
    if (!(mult > 0)) throw new SpecError(where, `The ${what} distance must be above 0`);
    const n = m[2]?.trim() ?? '';
    return { k: 'atr', mult, n: period(n, where, 'atr()', 1), ...periodParam(n) };
  };

  const defaultSource = get('data', oneOf(DATA_SOURCES, 'data'), defaults.dataSource as Source);
  const size = get('size', (v, w) => parsePercent(v, w, 'size', MAX_GROSS * 100), null as number | null);
  const rebalance = get('rebalance', oneOf(REBALANCE, 'rebalance'), 'never' as Rebalance);

  let rankTop: number | null = null;
  let rankBy: { text: string; from: number; line: number } | null = null;
  const hold = settings.get('hold');
  if (hold) {
    guard(() => {
      const m = hold.value.match(/^top\s+(\S+)\s+by\s+(.+)$/i);
      if (!m) throw new SpecError(hold.valueAt, 'Write it as top 3 by roc(126): how many tickers to hold, and the score that ranks them');
      const top = plain(m[1], hold.valueAt, '"top"', 'top 3 by roc(126)');
      if (!Number.isInteger(top) || top < 1) throw new SpecError(hold.valueAt, `"top" must be a whole number from 1, not ${top}`);
      rankTop = top;
      rankBy = { text: m[2], from: hold.valueAt.from! + hold.value.length - m[2].length, line: hold.line };
    });
  }

  const universe: Asset[] = [];
  const u = settings.get('universe');
  if (!u) {
    errors.push({ line: 1, message: 'Add a universe, such as "universe: SPY" or "universe: SPY 60%, TLT 40%"' });
  } else {
    guard(() => {
      const weights: (number | null)[] = [];
      for (const pm of u.value.matchAll(/[^,]+/g)) {
        const part = pm[0].trim();
        if (!part) continue;
        const from = u.valueAt.from! + pm.index! + pm[0].length - pm[0].trimStart().length;
        const partAt: At = { line: u.line, from, to: from + part.length };
        const m = part.match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)\s*%)?$/);
        if (!m) throw new SpecError(partAt, `Can't read "${part}". Write a ticker and an optional weight, such as SPY 60%`);
        const ref = parseRef(m[1], defaultSource, partAt);
        if (ref.source === 'fred') throw new SpecError(partAt, notPrices(ref, 'be traded'));
        if (universe.some((a) => a.name.toLowerCase() === ref.name.toLowerCase())) throw new SpecError(partAt, `${ref.name} is listed twice`);
        universe.push({ ...ref, weight: 0 });
        weights.push(m[2] === undefined ? null : Number(m[2]) / 100);
      }
      if (universe.length === 0) throw new SpecError(u.valueAt, 'The universe is empty');
      const given = weights.filter((w) => w !== null).length;
      if (rankTop !== null) {
        if (given !== 0) throw new SpecError(u.valueAt, 'Leave the weights out of the universe when "hold" ranks the tickers: each one held gets an equal share of size');
        universe.forEach((a) => (a.weight = (size ?? 1) / rankTop!));
        return;
      }
      if (given !== 0 && given !== weights.length) throw new SpecError(u.valueAt, 'Give every ticker a weight, or none');
      if (given !== 0 && size !== null) throw new SpecError(settings.get('size')!.keyAt, 'Use either weights in the universe or "size", not both');
      universe.forEach((a, i) => (a.weight = weights[i] ?? (size ?? 1) / universe.length));
      if (universe.some((a) => a.weight <= 0)) throw new SpecError(u.valueAt, 'Weights must be above 0%');
      const total = universe.reduce((s, a) => s + a.weight, 0);
      if (total > MAX_GROSS + 1e-9) {
        throw new SpecError(u.valueAt, `Weights add up to ${(total * 100).toFixed(1)}%. The most is ${MAX_GROSS * 100}%: long and short positions together may be at most ${MAX_GROSS} times the equity`);
      }
    });
  }
  if (hold && rankTop !== null && universe.length > 0 && rankTop > universe.length) {
    errors.push(diag(hold.valueAt, `"top ${rankTop}" is more tickers than the universe has (${universe.length})`));
  }

  const extras: AssetRef[] = [];
  /** The name of the ticker `sym` stands for, added to the extras when it is a new one and `register` says so. */
  const resolveAsset = (sym: Tok, register = true): string => {
    const lower = sym.s.toLowerCase();
    const known = [...universe, ...extras].find((a) => a.name.toLowerCase() === lower);
    if (known) return known.name;
    const ref = parseRef(sym.s, defaultSource, at(sym));
    const problem = clash(ref, [...universe, ...extras]);
    if (problem) throw new SpecError(at(sym), problem);
    const same = [...universe, ...extras].find((a) => a.name.toLowerCase() === ref.name.toLowerCase());
    if (same) return same.name;
    if (register) extras.push(ref);
    return ref.name;
  };
  const findAsset = (name: string) => universe.find((a) => a.name.toLowerCase() === name.toLowerCase());

  const priceChecks: { at: At; asset: string | null; scope: string[] | null }[] = [];
  const text = (a: Tok, b: Tok): string => {
    if (a.line === b.line) return plainLines[a.line - 1].slice(a.from, b.to);
    const parts = [plainLines[a.line - 1].slice(a.from)];
    for (let l = a.line + 1; l < b.line; l++) parts.push(plainLines[l - 1]);
    parts.push(plainLines[b.line - 1].slice(0, b.to));
    return parts.map((s) => s.trim()).join(' ');
  };
  const context = (positions: boolean, ruleScope: string[] | null): ExprContext => ({
    resolveAsset,
    sourceOf: (name) => [...universe, ...extras].find((a) => a.name === name)?.source ?? null,
    params,
    defs,
    checkDef,
    positions,
    priceVsNumber: (where, asset) => priceChecks.push({ at: where, asset, scope: ruleScope }),
    text,
  });
  /**
   * Reads a definition's expression on its own, once, where position values are allowed: its mistakes are reported on its
   * own line, and the places that use it say nothing more. Whether a position value suits a rule is checked where it is used.
   */
  const checkDef = (d: Definition, via?: Tok): boolean => {
    if (via && reading.length) reading[reading.length - 1].via = via;
    if (d.state === 'busy') {
      // It is being read already, so it leads back to itself: each definition of the loop says so on its own line.
      const loop = reading.slice(reading.findIndex((x) => x.d === d));
      loop.forEach((x, k) => {
        const next = loop[(k + 1) % loop.length].d;
        const how = next === x.d ? 'uses itself' : `leads back to itself through ${next.name}`;
        if (x.via) errors.push(diag(at(x.via), `"${x.d.name}" ${how}. A definition can only be built from other names, as in ${x.d.name} = close > sma(200)`));
      });
      throw new Quiet();
    }
    if (d.state === 'new') {
      if (via && reading.length >= MAX_DEPTH) throw new SpecError(at(via), TOO_DEEP);
      d.state = 'busy';
      reading.push({ d, via: null });
      const alone: ExprContext = { ...context(true, null), checking: true, resolveAsset: (sym) => resolveAsset(sym, false), priceVsNumber: () => {} };
      d.state = guard(() => (d.bool = isBool(new ExprParser(d.toks, alone).parseValue()))) ? 'ok' : 'bad';
      reading.pop();
    }
    return d.state === 'ok';
  };
  /** The definitions being read to check them, innermost last, each with the token of its own line that names the next one. */
  const reading: { d: Definition; via: Tok | null }[] = [];
  const endTok = (toks: Tok[], fallback: At): Tok => {
    const last = toks[toks.length - 1];
    return last ? { ...last, t: 'end', s: '' } : { t: 'end', s: '', v: 0, line: fallback.line, from: fallback.from!, to: fallback.to! };
  };

  /** A ticker on a `for` line that is not in the universe is reported once, however many rules and stops sit under it. */
  const reported = new Set<string>();
  const unknownScope = (list: NonNullable<Scope>, item: ScopeItem): void => {
    const key = `${item.at.line}:${item.at.from}`;
    if (reported.has(key)) return;
    reported.add(key);
    errors.push(diag(item.at, list.length === 1 ? `"for ${item.label}:" names a ticker that is not in the universe` : `"for ${item.label}:" names ${item.name}, which is not in the universe`));
  };
  /** The universe's assets a section names, in the order listed; null when one is not there (reported), or when the universe has nothing to look in. */
  const sectionAssets = (list: NonNullable<Scope>): Asset[] | null => {
    const found = list.map((item) => ({ item, asset: findAsset(item.name) }));
    for (const f of found) if (!f.asset && universe.length) unknownScope(list, f.item);
    return found.every((f) => f.asset) ? found.map((f) => f.asset!) : null;
  };
  /** Each ticker's own rules on `r.scope`'s line (or the shared ones), where nothing of this kind has been written yet. */
  const targetsOf = (r: RawRule, assets: Asset[] | null): Partial<Record<RuleSide, Expr>>[] => {
    if (assets === null) {
      if (shared[r.side]) throw new SpecError(r.head, `There is already a ${r.side} rule. Join conditions with "and" or "or"`);
      return [shared];
    }
    return assets.map((asset, k) => {
      if (!own.has(asset.name)) own.set(asset.name, {});
      const target = own.get(asset.name)!;
      if (target[r.side]) throw new SpecError(r.head, `There is already a ${r.side} rule for ${r.scope![k].name}. Join conditions with "and" or "or"`);
      return target;
    });
  };
  const shared: Partial<Record<RuleSide, Expr>> = {};
  const own = new Map<string, Partial<Record<RuleSide, Expr>>>();
  const addHeads: At[] = [];
  /** Where the short and cover rules are written, for the errors about them. */
  const shortHeads = new Map<Expr, At>();
  const writtenOf = new Map<Expr, Written>();
  /** The columns each rule reads from its own ticker, which must be a CSV file wherever the rule applies. */
  const ownReads = new Map<Expr, { name: string; at: At }[]>();
  for (const d of defs.values()) d.toks.push(endTok(d.toks, d.nameAt));
  for (const d of defs.values()) checkDef(d);
  for (const r of rawRules) {
    guard(() => {
      let ruleScope: string[] | null = null;
      let assets: Asset[] | null = null;
      if (r.scope !== null) {
        assets = sectionAssets(r.scope);
        if (assets === null) return;
        ruleScope = assets.map((a) => a.name);
      }
      const targets = targetsOf(r, assets);
      r.toks.push(endTok(r.toks, r.head));
      // Like a buy rule, a short rule is read while flat, so it has no position to read.
      const parser = new ExprParser(r.toks, context(r.side !== 'buy' && r.side !== 'short', ruleScope));
      const e = parser.parseCondition();
      for (const target of targets) target[r.side] = e;
      writtenOf.set(e, parser.written(e));
      ownReads.set(e, parser.ownColumns(e));
      if (r.side === 'add') addHeads.push(r.head);
      if (r.side === 'short' || r.side === 'cover') shortHeads.set(e, r.head);
    });
  }

  let rank: Spec['rank'] = null;
  let rankWritten: Written | null = null;
  let rankReads: { name: string; at: At }[] = [];
  if (rankTop !== null && rankBy !== null) {
    const by: { text: string; from: number; line: number } = rankBy;
    guard(() => {
      const toks: Tok[] = [];
      lex(by.text, by.line, by.from, toks);
      toks.push(endTok(toks, hold!.valueAt));
      const parser = new ExprParser(toks, context(false, null));
      rank = { top: rankTop!, by: parser.parseNumber('The ranking') };
      rankWritten = parser.written(rank.by);
      rankReads = parser.ownColumns(rank.by);
    });
  }

  const entriesLine = settings.get('entries');
  const entries = get(
    'entries',
    (v, w) => {
      const n = plain(v, w, 'entries', 'entries: 3');
      if (!Number.isInteger(n) || n < 1 || n > MAX_ENTRIES) throw new SpecError(w, `entries must be a whole number from 1 to ${MAX_ENTRIES}, not ${n}`);
      return n;
    },
    null as number | null,
  );
  if (!entriesLine && addHeads.length) errors.push(diag(addHeads[0], '"add when" needs an entries line that says how many entries a position is built in, such as entries: 3'));

  const checked = new Set<string>();
  const ownColumnsOf = (reads: { name: string; at: At }[], a: Asset): void => {
    if (a.source === 'csv') return;
    for (const r of reads) {
      const key = `${r.at.line}:${r.at.from}:${r.at.to}`;
      if (checked.has(key)) continue;
      checked.add(key);
      errors.push(diag(r.at, `column(${r.name}) reads a column of the ticker the rule belongs to, and ${a.name} comes from ${SOURCE_NAME[a.source]}, not from a CSV file. Name the file instead, as in ${COLUMN_EXAMPLE.replace('score', r.name)}`));
    }
  };
  for (const a of universe) ownColumnsOf(rankReads, a);
  const rules: Record<string, Rules> = {};
  const writtenRules: Record<string, WrittenRules> = {};
  const noAdd: string[] = [];
  /** The first short or cover rule a ticker reads, for the error that a ranking can't short; null when none does. */
  let shortHead: At | null = null;
  const coverReported = new Set<At>();
  for (const a of universe) {
    const short = own.get(a.name)?.short ?? shared.short;
    const cover = own.get(a.name)?.cover ?? shared.cover;
    // A ticker with only short rules never goes long: its buy rule is the parser's false.
    const buy = own.get(a.name)?.buy ?? shared.buy ?? (rankTop !== null ? ({ k: 'bool', v: true } as Expr) : short ? ({ k: 'bool', v: false } as Expr) : undefined);
    const sell = own.get(a.name)?.sell ?? shared.sell ?? null;
    const add = own.get(a.name)?.add ?? shared.add;
    for (const e of [buy, sell, add, short, cover]) if (e) ownColumnsOf(ownReads.get(e) ?? [], a);
    shortHead ??= (short && shortHeads.get(short)) || (cover && shortHeads.get(cover)) || null;
    if (cover && !short) {
      const head = shortHeads.get(cover)!;
      if (!coverReported.has(head)) {
        coverReported.add(head);
        errors.push(diag(head, `"cover when" closes a short, so it needs a short rule${universe.length > 1 ? ` for ${a.name}` : ''} that says when to go short, such as short when close < sma(200)`));
      }
    }
    if (buy) {
      rules[a.name] = add && entriesLine ? { buy, sell, add } : { buy, sell };
      writtenRules[a.name] = { buy: writtenOf.get(buy) ?? null, sell: sell ? (writtenOf.get(sell) ?? null) : null };
      if (add && entriesLine) writtenRules[a.name].add = writtenOf.get(add) ?? null;
      if (short) {
        rules[a.name].short = short;
        writtenRules[a.name].short = writtenOf.get(short) ?? null;
        if (cover) {
          rules[a.name].cover = cover;
          writtenRules[a.name].cover = writtenOf.get(cover) ?? null;
        }
      }
    } else if (errors.length === 0) errors.push({ line: 1, message: `There is no buy rule${universe.length > 1 ? ` for ${a.name}` : ''}. Add one, such as "buy when close > sma(200)"` });
    if (!add) noAdd.push(a.name);
  }
  if (rankTop !== null && shortHead) {
    errors.push(diag(shortHead, 'A ranking can\'t also go short yet; remove the short and cover rules, or the "hold" line to trade each ticker by its own rules'));
  }
  if (entries !== null && entries > 1 && noAdd.length && universe.length) {
    const whom = noAdd.length === universe.length ? '' : ` for ${noAdd.join(', ')}`;
    errors.push(
      diag(
        entriesLine!.keyAt,
        `"entries: ${entries}" builds each position in ${entries} entries, so it needs an add rule${whom} that says when to make the next one, such as add when close > last entry price * 1.03`,
      ),
    );
  }

  const interval = get('interval', (v) => v.toLowerCase(), '1d');
  const benchmark = get(
    'benchmark',
    (v, w) => {
      const ref = parseRef(v, defaultSource, w);
      if (ref.source === 'fred') throw new SpecError(w, notPrices(ref, 'be the benchmark'));
      const problem = clash(ref, [...universe, ...extras]);
      if (problem) throw new SpecError(w, problem);
      return ref;
    },
    null as AssetRef | null,
  );
  const cashSetting = settings.get('cash rate');
  const parseCash = (text: string, where: At): CashRate => {
    const m = text.match(/^(-?\d+(?:\.\d+)?)\s*(%)?$/);
    if (!m) return { k: 'ticker', ref: parseRef(text, defaultSource, where) };
    if (!m[2]) throw new SpecError(where, 'Write the cash rate as a yearly percentage, such as 4%, or as a ticker that quotes a yield, such as ^IRX');
    const rate = Number(m[1]) / 100;
    if (rate < 0 || rate > 0.5) throw new SpecError(where, 'The cash rate must be between 0% and 50% a year');
    return { k: 'fixed', rate };
  };
  let cash: CashRate = { k: 'fixed', rate: 0 };
  if (cashSetting) {
    cash = get('cash rate', parseCash, cash);
  } else {
    try {
      cash = parseCash(defaults.cashRate.trim(), { line: 1 });
    } catch (e) {
      if (!(e instanceof SpecError)) throw e;
      errors.push({ line: 1, message: `The default cash rate "${defaults.cashRate}" in the plugin settings can't be read. Use a percentage, such as 4%, or a ticker, such as ^IRX` });
    }
  }
  const cashClash = cash.k === 'ticker' ? clash(cash.ref, [...universe, ...extras, ...(benchmark ? [benchmark] : [])]) : null;
  if (cashClash) errors.push(diag(cashSetting?.valueAt ?? { line: 1 }, cashClash));

  // The cash-rate ticker is left out: a yield only needs daily closes, which Yahoo serves for any interval. A FRED series,
  // like a CSV file, has rows of its own size.
  const sources = new Set([...universe, ...extras, ...(benchmark ? [benchmark] : [])].map((a) => a.source));
  const intervalAt = settings.get('interval')?.valueAt ?? { line: 1 };
  if (sources.has('yahoo') && !YAHOO_INTERVALS.includes(interval)) {
    errors.push(diag(intervalAt, `Yahoo data comes as 1d or 1w bars, not "${interval}"`));
  } else if (sources.has('tiingo') && !YAHOO_INTERVALS.includes(interval)) {
    errors.push(diag(intervalAt, `Tiingo data comes as 1d or 1w bars, not "${interval}"`));
  } else if (sources.has('binance') && !BINANCE_INTERVALS.includes(interval)) {
    errors.push(diag(intervalAt, `Binance intervals: ${BINANCE_INTERVALS.join(', ')}`));
  }
  const magnify = get('magnify', (v) => v.toLowerCase(), null as string | null);
  const magnifyLine = settings.get('magnify');
  const magnifyError = magnify !== null && universe.length > 0 ? magnifyProblem(magnify, interval, universe.map((a) => a.source)) : null;
  if (magnifyError) errors.push(diag(magnifyLine!.valueAt, magnifyError));

  const from = get('from', parseDate, null as number | null);
  const to = get('to', (v, w) => parseDate(v, w) + DAY - 1, null as number | null);
  if (from !== null && to !== null && to <= from) errors.push(diag(settings.get('to')!.valueAt, '"to" is before "from"'));
  const testFrom = get(
    'test from',
    (v, w) => {
      const d = parseDate(v, w);
      if (from !== null && d <= from) throw new SpecError(w, '"test from" must be after "from"');
      if (to !== null && d > to - DAY) throw new SpecError(w, '"test from" must be before "to"');
      return d;
    },
    null as number | null,
  );

  const shareStops: Stops = {
    stopLoss: get('stop loss', stopLevel('stop loss', 0.99), null as StopLevel | null),
    trailingStop: get('trailing stop', stopLevel('trailing stop', 0.99), null as StopLevel | null),
    takeProfit: get('take profit', stopLevel('take profit', 1000), null as StopLevel | null),
  };
  /** Where each take profit is written, for the warning about shorts. */
  const targetAt = new Map<StopLevel, At>();
  if (shareStops.takeProfit) targetAt.set(shareStops.takeProfit, settings.get('take profit')!.valueAt);
  const ownStops = new Map<string, Partial<Stops>>();
  const STOP_FIELD: Record<string, keyof Stops> = { 'stop loss': 'stopLoss', 'trailing stop': 'trailingStop', 'take profit': 'takeProfit' };
  for (const { scope: list, s } of scoped) {
    guard(() => {
      const assets = sectionAssets(list);
      if (assets === null) return;
      const field = STOP_FIELD[s.key];
      const level = stopLevel(s.key, s.key === 'take profit' ? 1000 : 0.99)(s.value.trim(), s.valueAt);
      for (const asset of assets) {
        const mine = ownStops.get(asset.name) ?? {};
        ownStops.set(asset.name, mine);
        if (mine[field] !== undefined) throw new SpecError(s.keyAt, `"${s.key}" is set twice for ${asset.name}`);
        mine[field] = level;
      }
      if (field === 'takeProfit') targetAt.set(level, s.valueAt);
    });
  }
  const stops: Record<string, Stops> = {};
  for (const a of universe) stops[a.name] = { ...shareStops, ...ownStops.get(a.name) };
  // A short gains at most 100%, when the price falls to 0, so a percentage target that far away is never reached.
  const unreachable = new Set<At>();
  for (const a of universe) {
    const target = stops[a.name].takeProfit;
    if (!rules[a.name]?.short || target?.k !== 'pct' || target.v < 1) continue;
    const where = targetAt.get(target)!;
    if (unreachable.has(where)) continue;
    unreachable.add(where);
    warnings.push(diag(where, `A short can't reach a take profit of ${Number((target.v * 100).toPrecision(6))}%: the price would have to fall to 0 or below, so its shorts never take profit. Use one under 100%, or a multiple of the average true range`));
  }

  const weighting = get(
    'weighting',
    (v, w): Sizing => {
      const m = v.match(/^inverse\s+volatility\s*\(([^)]*)\)$/i);
      if (!m || !m[1].trim()) throw new SpecError(w, 'Write it as inverse volatility(60): the number of bars to measure volatility over');
      return { k: 'invvol', n: period(m[1].trim(), w, 'inverse volatility()', 2), ...periodParam(m[1].trim()) };
    },
    null as Sizing | null,
  );
  const risk = get(
    'risk per trade',
    (v, w): Sizing => {
      const m = v.match(new RegExp(String.raw`^(\S+?)\s+at\s+` + ATR_DISTANCE.source.slice(1), 'i'));
      if (!m) throw new SpecError(w, 'Write it as 1% at 2 atr(14): the share of equity to lose if the price moves that many average true ranges against the position');
      const share = percentage(m[1], w, 'risk per trade', 1);
      const mult = plain(m[2], w, 'The risk distance', '1% at 2 atr(14)');
      if (!(mult > 0)) throw new SpecError(w, 'The risk distance must be above 0');
      const n = m[3]?.trim() ?? '';
      return { k: 'risk', risk: share, mult, n: period(n, w, 'atr()', 1), ...periodParam(n) };
    },
    null as Sizing | null,
  );
  const riskLine = settings.get('risk per trade');
  if (weighting && risk) errors.push(diag(riskLine!.keyAt, 'Use either "weighting" or "risk per trade", not both'));
  else if (risk && rebalance !== 'never') {
    errors.push(diag(riskLine!.keyAt, `"risk per trade" sizes each position once, when it is bought, so it can't be combined with "rebalance: ${rebalance}". Remove one of them`));
  }

  // Yahoo and Tiingo adjust prices for dividends and splits, but Yahoo not index levels (tickers starting with ^).
  const adjustedBy = (name: string) => [...universe, ...extras].find((a) => a.name === name && (a.source === 'yahoo' || a.source === 'tiingo') && !a.id.startsWith('^'))?.source;
  const seen = new Set<string>();
  for (const c of priceChecks) {
    const names = c.asset !== null ? [c.asset] : (c.scope ?? universe.map((a) => a.name));
    const key = `${c.at.line}:${c.at.from}:${c.at.to}`;
    const by = new Set(names.map(adjustedBy).filter((s) => s !== undefined));
    if (seen.has(key) || by.size === 0) continue;
    seen.add(key);
    const whose = by.has('yahoo') ? (by.has('tiingo') ? 'Yahoo and Tiingo' : 'Yahoo') : 'Tiingo';
    warnings.push(diag(c.at, `This compares a price with a fixed number. ${whose} prices are adjusted for later dividends and splits, so old prices are lower than what actually traded.`));
  }

  const spec: Spec = {
    name: get('name', (v) => v, null as string | null),
    universe,
    extras,
    benchmark,
    from,
    to,
    testFrom,
    interval,
    capital: get('capital', parseCapital, defaults.capital),
    costBps: get('costs', parseBps('Costs'), defaults.costBps),
    slippageBps: get('slippage', parseBps('Slippage'), defaults.slippageBps),
    rebalance,
    cash,
    stops,
    rank,
    sizing: risk ?? weighting ?? { k: 'fixed' },
    params: [...params.values()],
    rules,
    fill: get('fill', (v, w) => oneOf(FILL, 'fill')(v.replace(/\s+/g, ' '), w), 'next open' as Fill),
    written: { rules: writtenRules, rank: rankWritten },
  };
  const commission = settings.has('commission') ? get('commission', parseCommission, null) : (defaults.commission ?? null);
  if (commission) spec.commission = commission;
  // Only a block that can borrow carries the margin terms, so a long-only one within 100% runs as it always has.
  const yearly = (what: string, max: number) => (text: string, where: At): number => {
    const m = text.match(/^(\d+(?:\.\d+)?|\.\d+)\s*%$/);
    if (!m) throw new SpecError(where, `Write the ${what} as a yearly percentage, such as ${what === 'borrow fee' ? '0.5%' : '6%'}`);
    const rate = Number(m[1]) / 100;
    if (rate > max) throw new SpecError(where, `The ${what} must be between 0% and ${max * 100}% a year`);
    return rate;
  };
  const borrowFee = get('borrow fee', yearly('borrow fee', 1), defaults.borrowFee ?? BORROW_FEE);
  const marginRate = get('margin rate', yearly('margin rate', 0.5), defaults.marginRate ?? MARGIN_RATE);
  const gross = rankTop !== null ? (size ?? 1) : universe.reduce((s, a) => s + a.weight, 0);
  const shorts = Object.values(rules).some((r) => r.short);
  if (shorts || gross > 1 + 1e-9) {
    // A block that never shorts pays no borrow fee, so a change to that setting does not change it.
    spec.margin = { cap: Math.min(MAX_GROSS, Math.max(1, gross)), borrowFee: shorts ? borrowFee : 0, rate: marginRate, maintenance: MAINTENANCE };
  }
  if (entries !== null) spec.entries = entries;
  if (magnify !== null) spec.magnify = magnify;

  // With a problem elsewhere a rule may not have been read at all, so a name it would have used is not reported as unused.
  if (errors.length === 0) {
    for (const d of defs.values()) {
      if (!d.used) warnings.push(diag(d.nameAt, `"${d.name}" is defined but no rule or score reads it. Use it, as in buy when ${d.name}${d.bool ? '' : ' > 0'}, or remove the line`));
    }
  }
  errors.sort((a, b) => a.line - b.line);
  warnings.sort((a, b) => a.line - b.line);
  return { spec: errors.length ? null : spec, errors, warnings };
}
