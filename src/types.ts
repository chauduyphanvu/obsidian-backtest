/** OHLCV bars, oldest first. `t` is epoch milliseconds; daily bars sit at UTC midnight of their trading date. */
export interface Bars {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
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
