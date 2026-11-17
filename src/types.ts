/** A numeric column of a CSV file beyond its prices, one value for each bar; a cell with no number is NaN. */
export interface Column {
  /** What a rule calls it: the header through `columnName`. */
  name: string;
  /** The header as the file spells it. */
  header: string;
  v: number[];
}

/** A column of a CSV file that a rule cannot read by name, and the reason in a few plain words. */
export interface UnreadColumn {
  name: string;
  why: string;
  /** Set when the column is left out only because the file has more than MAX_COLUMNS of them. */
  limit?: true;
}

/** The most numeric columns beyond its prices that a rule can read from one CSV file; the rest are listed as unread. */
export const MAX_COLUMNS = 50;

/**
 * OHLCV bars, oldest first. `t` is epoch milliseconds; daily bars sit at UTC midnight of their trading date.
 * Only a CSV file can carry the optional fields; every other source leaves them out.
 */
export interface Bars {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
  /** Numeric columns beyond date and prices, in file order, each lined up with `t`. */
  columns?: Column[];
  /** Columns the file has that no rule can read: names that clash, and those past MAX_COLUMNS. */
  unread?: UnreadColumn[];
  /** A file with only a date and columns, no prices: `o`, `h`, `l` and `c` are NaN and `v` is 0, and it cannot be traded. */
  unpriced?: true;
}

export type Source = 'yahoo' | 'binance' | 'csv';

export interface AssetRef {
  /** How the spec and the results refer to it: the ticker, or a CSV file's base name. */
  name: string;
  source: Source;
  /** Ticker for yahoo and binance, vault path for csv. */
  id: string;
}

export interface Asset extends AssetRef {
  /** Target weight as a fraction of equity. */
  weight: number;
}

export function emptyBars(): Bars {
  return { t: [], o: [], h: [], l: [], c: [], v: [] };
}

/**
 * The name a rule uses for a column, from its header: lower case, accents dropped, and every run of other characters
 * (spaces, punctuation) turned into one underscore, with none at either end. "News Sentiment" is `news_sentiment`.
 * Empty when the header has no letter or digit.
 */
export function columnName(header: string): string {
  return header
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The bars from index `from` on, with every column cut the same way; the same object when nothing is cut. */
export function sliceBars(bars: Bars, from: number): Bars {
  if (from <= 0) return bars;
  const out: Bars = { t: bars.t.slice(from), o: bars.o.slice(from), h: bars.h.slice(from), l: bars.l.slice(from), c: bars.c.slice(from), v: bars.v.slice(from) };
  if (bars.columns) out.columns = bars.columns.map((c) => ({ ...c, v: c.v.slice(from) }));
  if (bars.unread) out.unread = bars.unread;
  if (bars.unpriced) out.unpriced = true;
  return out;
}
