import type { Defaults } from './dsl.ts';
import { lineKinds, tokenizeBlock } from './highlight.ts';
import { DATA_SOURCES, plainSource, SOURCE_PREFIX, type DataSource } from './types.ts';

export interface LookupDeps {
  /** GET a URL and return its body; rejects on a network error. */
  fetchText(url: string): Promise<string>;
  now(): number;
  /** Waits between requests; without it they are not spaced out, only limited to a couple at once. */
  sleep?: (ms: number) => Promise<void>;
}

/** The sources tickers are looked up at. Tiingo's and FRED's are never sent anywhere, and a CSV file is not a ticker. */
export type LookupSource = 'yahoo' | 'binance';

export const isLookupSource = (s: string): s is LookupSource => s === 'yahoo' || s === 'binance';

export interface SymbolHit {
  ticker: string;
  name: string;
  /** Exchange and kind, as "NYSEArca · ETF". */
  detail: string;
  source: LookupSource;
}

export type Verdict = 'known' | 'unknown' | 'unsure';

const SEARCH_LIMIT = 8;
const OTHER_SOURCE_LIMIT = 3;
const AT_ONCE = 2;
const WAITING = 16;
const GAP_MS = 250;
/** After a request fails, the same one is not sent again for this long. */
const RETRY_AFTER_MS = 30_000;
/** After this many failures in a row a host is left alone for a while. */
const FAILURES_BEFORE_PAUSE = 3;
const PAUSE_MS = 60_000;
const BINANCE_REFRESH_MS = 6 * 3_600_000;
const SEARCHES_KEPT = 300;
const VERDICTS_KEPT = 1000;
/** What a ticker sent to either host may look like; anything else is not sent. */
const SENDABLE = /^[A-Za-z0-9^._=-]{1,24}$/;
const QUOTES = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'BTC', 'ETH', 'BNB', 'EUR', 'TRY', 'BRL', 'GBP', 'JPY', 'AUD'];

interface Quote {
  symbol: string;
  name: string;
  detail: string;
}

/** What one Yahoo search answered. `full` is set when it filled its page, so the ticker could be further down. */
interface Found {
  quotes: Quote[];
  full: boolean;
}

/** A map that keeps the most recently used entries. */
class Recent<V> {
  private map = new Map<string, V>();
  private max: number;
  constructor(max: number) {
    this.max = max;
  }
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

interface BinanceList {
  symbols: string[];
  set: Set<string>;
  at: number;
}

/** The parts of a Yahoo search answer read here. Nothing checks the JSON against it, so each field is looked at before use. */
interface YahooSearchAnswer {
  quotes?: ({ symbol?: unknown; quoteType?: unknown; exchDisp?: unknown; exchange?: unknown; typeDisp?: unknown; longname?: unknown; shortname?: unknown } | null)[];
}

function parseYahooSearch(text: string): Found {
  const body = JSON.parse(text) as YahooSearchAnswer | null;
  if (!Array.isArray(body?.quotes)) throw new Error('Yahoo did not send a list of tickers');
  const out: Quote[] = [];
  for (const q of body.quotes) {
    // Options are not something a strategy here reads, and they would crowd the list.
    if (typeof q?.symbol !== 'string' || q.quoteType === 'OPTION') continue;
    const detail = [q.exchDisp ?? q.exchange, q.typeDisp ?? q.quoteType].filter((x) => typeof x === 'string' && x).join(' · ');
    out.push({ symbol: q.symbol, name: String(q.longname ?? q.shortname ?? ''), detail });
  }
  return { quotes: out, full: body.quotes.length >= SEARCH_LIMIT };
}

function parseBinancePrices(text: string): string[] {
  const rows = JSON.parse(text) as unknown;
  if (!Array.isArray(rows)) throw new Error('Binance did not send prices');
  const symbols = (rows as ({ symbol?: unknown } | null)[]).map((r) => r?.symbol).filter((s): s is string => typeof s === 'string' && /^[A-Z0-9]{3,20}$/.test(s));
  if (symbols.length === 0) throw new Error('Binance sent no markets');
  return symbols;
}

function binanceName(symbol: string): string {
  const quote = QUOTES.find((q) => symbol.length > q.length && symbol.endsWith(q));
  return quote ? `${symbol.slice(0, -quote.length)} / ${quote}` : symbol;
}

/** The markets that start with the query (the usual quotes first), then ones that hold it. */
function binanceMatches(symbols: string[], query: string, limit: number): SymbolHit[] {
  const q = query.toUpperCase();
  const rank = (s: string) => {
    const quote = QUOTES.findIndex((x) => s.endsWith(x));
    return quote < 0 ? QUOTES.length : quote;
  };
  const starts = symbols.filter((s) => s.startsWith(q)).sort((a, b) => Number(b === q) - Number(a === q) || rank(a) - rank(b) || a.length - b.length || (a < b ? -1 : 1));
  const holds = starts.length < limit ? symbols.filter((s) => !s.startsWith(q) && s.includes(q)).sort((a, b) => rank(a) - rank(b) || a.length - b.length) : [];
  return [...starts, ...holds].slice(0, limit).map((s) => ({ ticker: s, name: binanceName(s), detail: 'Binance', source: 'binance' }));
}

/**
 * Looks tickers up while the user writes a strategy. Each request carries only a ticker the user typed
 * (Yahoo), or nothing at all (Binance's list of markets). A request that fails gives no hits and an
 * "unsure" verdict, never an error, and is tried again later. Nothing is asked for twice in a session.
 */
export class SymbolLookup {
  private deps: LookupDeps;
  private searches = new Recent<Found>(SEARCHES_KEPT);
  private verdicts = new Recent<'known' | 'unknown'>(VERDICTS_KEPT);
  private inflight = new Map<string, Promise<unknown>>();
  private failedAt = new Map<string, number>();
  private failures: Record<LookupSource, { count: number; until: number }> = { yahoo: { count: 0, until: 0 }, binance: { count: 0, until: 0 } };
  private binance: BinanceList | null = null;
  private active = 0;
  private waiting: (() => void)[] = [];
  private lastStart = -Infinity;

  constructor(deps: LookupDeps) {
    this.deps = deps;
  }

  /** A few tickers that match what was typed, best first. */
  async search(query: string, source: LookupSource): Promise<SymbolHit[]> {
    const q = query.trim();
    if (!SENDABLE.test(q)) return [];
    try {
      if (source === 'binance') return binanceMatches((await this.binanceList()).symbols, q, SEARCH_LIMIT);
      return this.hitsOf((await this.yahoo(q)).quotes);
    } catch {
      return [];
    }
  }

  /** Whether the source knows the ticker; "unsure" when it could not be asked. */
  async check(ticker: string, source: LookupSource): Promise<Verdict> {
    const t = ticker.trim().toUpperCase();
    if (!SENDABLE.test(t)) return 'unsure';
    const kept = source === 'yahoo' ? this.peek(t, source) : null;
    if (kept) return kept;
    try {
      let verdict: 'known' | 'unknown';
      if (source === 'binance') {
        verdict = (await this.binanceList()).set.has(t) ? 'known' : 'unknown';
      } else {
        const found = await this.yahoo(t);
        if (found.quotes.some((q) => q.symbol.toUpperCase() === t)) verdict = 'known';
        // A full page without the ticker proves nothing: it could be on the next one.
        else if (found.full) return 'unsure';
        else verdict = 'unknown';
      }
      this.verdicts.set(`${source}|${t}`, verdict);
      return verdict;
    } catch {
      return 'unsure';
    }
  }

  /** What is already known about a ticker, with no request: null when it has not been asked about, or could not be. */
  peek(ticker: string, source: LookupSource): 'known' | 'unknown' | null {
    const t = ticker.trim().toUpperCase();
    if (source === 'binance') return this.binance ? (this.binance.set.has(t) ? 'known' : 'unknown') : null;
    return this.verdicts.get(`${source}|${t}`) ?? null;
  }

  /** The tickers a search for `query` already found, with no request; null when it has not been made. */
  peekSearch(query: string, source: LookupSource): SymbolHit[] | null {
    const q = query.trim();
    if (!SENDABLE.test(q)) return [];
    if (source === 'binance') return this.binance ? binanceMatches(this.binance.symbols, q, SEARCH_LIMIT) : null;
    const found = this.searches.get(q.toUpperCase());
    return found ? this.hitsOf(found.quotes) : null;
  }

  /**
   * Tickers to offer for what is being typed, each with how a block whose plain tickers come from
   * `blockSource` writes it. A typed `binance:` or `yahoo:` prefix limits the search to that source;
   * without one the block's source comes first and the other adds a few. A word for another source
   * (`csv:`, `tiingo:`, `fred:`, or a plain word in a block whose tickers come from Tiingo) is not looked up.
   */
  async suggest(word: string, blockSource: DataSource): Promise<Suggestion[]> {
    const { prefix, query, sources } = this.plan(word, blockSource);
    if (!query) return [];
    const found = await Promise.all(sources.map((s) => this.search(query, s)));
    return this.combine(prefix, blockSource, sources, found);
  }

  /** As `suggest`, from what is already known: null while a search is still to be made. */
  peekSuggest(word: string, blockSource: DataSource): Suggestion[] | null {
    const { prefix, query, sources } = this.plan(word, blockSource);
    if (!query) return [];
    const found = sources.map((s) => this.peekSearch(query, s));
    return found.every((f): f is SymbolHit[] => f !== null) ? this.combine(prefix, blockSource, sources, found) : null;
  }

  private plan(word: string, blockSource: DataSource): { prefix: string; query: string; sources: LookupSource[] } {
    const m = word.match(SOURCE_PREFIX);
    const prefix = m ? m[0] : '';
    const source = m ? m[1].toLowerCase() : plainSource(word, blockSource);
    if (!isLookupSource(source)) return { prefix, query: '', sources: [] };
    const sources: LookupSource[] = m ? [source] : [source, source === 'yahoo' ? 'binance' : 'yahoo'];
    return { prefix, query: word.slice(prefix.length), sources };
  }

  private combine(prefix: string, blockSource: DataSource, sources: LookupSource[], found: SymbolHit[][]): Suggestion[] {
    const seen = new Set<string>();
    return found.flatMap((hits, i) =>
      hits
        .slice(0, i === 0 ? SEARCH_LIMIT : OTHER_SOURCE_LIMIT)
        .filter((h) => !seen.has(`${h.source}|${h.ticker}`) && seen.add(`${h.source}|${h.ticker}`))
        .map((hit) => ({ hit, written: writtenAs(hit, blockSource, prefix) })),
    );
  }

  private hitsOf(quotes: Quote[]): SymbolHit[] {
    return quotes.slice(0, SEARCH_LIMIT).map((q) => ({ ticker: q.symbol, name: q.name, detail: q.detail, source: 'yahoo' as const }));
  }

  private yahoo(query: string): Promise<Found> {
    const key = query.toUpperCase();
    const kept = this.searches.get(key);
    if (kept) return Promise.resolve(kept);
    return this.once(`yahoo|${key}`, 'yahoo', async () => {
      let failure: unknown = new Error('no host sent an answer');
      for (const host of ['query2', 'query1']) {
        try {
          const text = await this.request('yahoo', `https://${host}.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=${SEARCH_LIMIT}&newsCount=0`);
          const found = parseYahooSearch(text);
          this.searches.set(key, found);
          return found;
        } catch (e) {
          failure = e;
        }
      }
      throw failure;
    });
  }

  private binanceList(): Promise<BinanceList> {
    const have = this.binance;
    if (have && this.deps.now() - have.at < BINANCE_REFRESH_MS) return Promise.resolve(have);
    const load = this.once('binance|list', 'binance', async () => {
      const symbols = parseBinancePrices(await this.request('binance', 'https://data-api.binance.vision/api/v3/ticker/price'));
      return (this.binance = { symbols, set: new Set(symbols), at: this.deps.now() });
    });
    // An older list is better than none.
    return have ? load.catch(() => have) : load;
  }

  /** Runs `fn` unless the same thing is running (then they share it) or failed a moment ago or the host is paused. */
  private once<T>(key: string, source: LookupSource, fn: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const now = this.deps.now();
    if (now < this.failures[source].until || now - (this.failedAt.get(key) ?? -Infinity) < RETRY_AFTER_MS) return Promise.reject(new Error('not sent again at this time'));
    const run = fn()
      .then(
        (value) => {
          this.failures[source].count = 0;
          this.failedAt.delete(key);
          return value;
        },
        (e) => {
          this.failedAt.set(key, this.deps.now());
          const f = this.failures[source];
          if (++f.count >= FAILURES_BEFORE_PAUSE) [f.count, f.until] = [0, this.deps.now() + PAUSE_MS];
          throw e;
        },
      )
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  /** One request, once a slot is free and the last one is at least a moment behind. */
  private async request(source: LookupSource, url: string): Promise<string> {
    if (this.active >= AT_ONCE) {
      if (this.waiting.length >= WAITING) throw new Error('too many requests in the queue');
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      const wait = this.lastStart + GAP_MS - this.deps.now();
      if (wait > 0) await this.deps.sleep?.(wait);
      this.lastStart = this.deps.now();
      return await this.deps.fetchText(url);
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export interface Suggestion {
  hit: SymbolHit;
  /** What goes into the block: the ticker, with a source prefix when the block's own source is another one. */
  written: string;
}

/** How a hit is written in a block whose plain tickers come from `blockSource`; `typedPrefix` is a prefix the user already wrote. */
export function writtenAs(hit: SymbolHit, blockSource: DataSource, typedPrefix = ''): string {
  if (typedPrefix) return typedPrefix + hit.ticker;
  return hit.source === plainSource(hit.ticker, blockSource) ? hit.ticker : `${hit.source}:${hit.ticker}`;
}

const DATA_LINE = new RegExp(String.raw`^\s*data\s*:\s*(${DATA_SOURCES.join('|')})\s*$`, 'i');

/** Where plain tickers in a block come from: its `data` line, or the plugin's default. */
export function blockSource(lines: string[], defaults: Partial<Defaults> = {}): DataSource {
  for (const line of lines) {
    const m = line.replace(/(^|\s)(#|\/\/).*$/, '').match(DATA_LINE);
    if (m) return m[1].toLowerCase() as DataSource;
  }
  return defaults.dataSource ?? 'yahoo';
}

/** A ticker written in a block, with the source that serves it. */
export interface TickerRef {
  /** 0-based line within the block. */
  line: number;
  /** Columns of the ticker as written, with any `binance:` style prefix. */
  from: number;
  to: number;
  /** Column where the ticker itself starts, after a prefix. */
  idFrom: number;
  /** The ticker in capitals, as sent. */
  ticker: string;
  source: LookupSource;
}

/** The name the parser gives a `csv:` file: its file name without the ending, as `parseRef` reads it. */
const csvName = (path: string): string => path.split('/').pop()!.replace(/\.csv$/i, '').toLowerCase();

/**
 * Every Yahoo or Binance ticker a block names: universe, symbol, benchmark, cash rate and `of` tickers. CSV files are not
 * tickers, and neither is a bare name that the parser resolves to a CSV file the block names (`of myfund` for
 * `csv:Data/myfund.csv`, whatever the capitals), so none of them is ever sent to a lookup. Nor is a Tiingo ticker or a FRED
 * series, written with its prefix, by a bare name the parser resolves to one, or plain in a block whose tickers come from Tiingo.
 */
export function blockTickers(lines: string[], defaults: Partial<Defaults> = {}): TickerRef[] {
  const tokens = tokenizeBlock(lines);
  const kinds = lineKinds(lines);
  const plain = blockSource(lines, defaults);
  const others = new Set<string>();
  lines.forEach((line, i) => {
    if (kinds[i] === 'for') return;
    for (const t of tokens[i]) {
      const written = t.kind === 'ticker' ? line.slice(t.from, t.to) : '';
      const m = written.match(SOURCE_PREFIX);
      if (!m || written.length === m[0].length) continue;
      const id = written.slice(m[0].length);
      if (m[1].toLowerCase() === 'csv') others.add(csvName(id));
      else if (!isLookupSource(m[1].toLowerCase())) others.add(id.toLowerCase());
    }
  });
  const out: TickerRef[] = [];
  lines.forEach((line, i) => {
    if (kinds[i] === 'for') return;
    for (const t of tokens[i]) {
      if (t.kind !== 'ticker') continue;
      const written = line.slice(t.from, t.to);
      const m = written.match(SOURCE_PREFIX);
      const source = m ? m[1].toLowerCase() : plainSource(written, plain);
      const id = written.slice(m ? m[0].length : 0);
      if (!isLookupSource(source) || !/^[A-Za-z0-9^._=-]+$/.test(id) || /^[\d.]+$/.test(id)) continue;
      if (!m && others.has(id.toLowerCase())) continue;
      out.push({ line: i, from: t.from, to: t.to, idFrom: t.from + (m ? m[0].length : 0), ticker: id.toUpperCase(), source });
    }
  });
  return out;
}

/** What to tell the user about a ticker its source does not know. */
export function unknownTickerMessage(ticker: string, source: LookupSource): string {
  return source === 'yahoo' ? `Yahoo has no ticker with the name ${ticker}.` : `Binance has no market with the name ${ticker}.`;
}
