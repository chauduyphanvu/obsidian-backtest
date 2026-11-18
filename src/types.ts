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
 * Only a CSV file can carry `columns`, `unread` and `unpriced`, and only a FRED series `values`; other sources leave them out.
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
  /**
   * A series of values rather than prices, such as a FRED series: each row is dated the day its value was first published,
   * with the value in `o`, `h`, `l` and `c` (zero and below included) and `v` 0. It cannot be traded or be the benchmark.
   */
  values?: true;
}

/** Where a ticker's bars come from, as a block writes it before a colon: `binance:BTCUSDT`. */
export const SOURCES = ['yahoo', 'binance', 'csv', 'tiingo', 'fred'] as const;
export type Source = (typeof SOURCES)[number];

/** The sources a block's plain tickers can come from (`data:` and the plugin setting). */
export const DATA_SOURCES = ['yahoo', 'binance', 'tiingo'] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

/**
 * Where a ticker written without a prefix comes from: one that starts with ^, an index or a yield such as ^VIX or ^IRX,
 * from Yahoo, the only source that has them, whatever `data` says; any other from `data`.
 */
export const plainSource = <S extends string>(ticker: string, data: S): S | 'yahoo' => (ticker.startsWith('^') ? 'yahoo' : data);

/** A source written in front of a ticker, as in `fred:T10Y2Y`; group 1 is the source. */
export const SOURCE_PREFIX = new RegExp(`^(${SOURCES.join('|')}):`, 'i');

/** The services whose requests carry an API key from the user's secret storage. */
export type KeyedService = 'tiingo' | 'fred';

export interface AssetRef {
  /** How the spec and the results refer to it: the ticker, or a CSV file's base name. */
  name: string;
  source: Source;
  /** Ticker for yahoo, binance and tiingo, series ID for fred, vault path for csv. */
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
  if (bars.values) out.values = true;
  return out;
}
