import { docFor, shortOf, valueId, FIXED_VALUES } from './docs.ts';
import { CALENDAR, INDICATORS, POSITION, SERIES, SETTINGS, STOP_SETTINGS } from './dsl.ts';
import { declaredParams, lineKind, settingKey } from './highlight.ts';
import type { Suggestion } from './symbols.ts';

export interface Completion {
  label: string;
  /** Text that replaces what has been typed of the word. */
  insert: string;
  detail: string;
  /** Set on a ticker that came from a lookup. */
  hit?: boolean;
}

export interface CompletionResult {
  /** Column where the word being completed starts. */
  from: number;
  items: Completion[];
}

const entry = (id: string, insert = id, detail = shortOf(id)): Completion => ({ label: id, insert, detail });

const VALUE_HINTS: Record<string, Completion[]> = {
  ...Object.fromEntries(Object.entries(FIXED_VALUES).map(([key, values]) => [key, values.map((v) => entry(v, v, shortOf(valueId(key, v))))])),
  'stop loss': [
    { label: '10%', insert: '10%', detail: 'below the entry price' },
    { label: '2 atr(14)', insert: '2 atr(14)', detail: 'two average true ranges below the entry price' },
  ],
  'trailing stop': [
    { label: '15%', insert: '15%', detail: 'below the highest high since entry' },
    { label: '3 atr(14)', insert: '3 atr(14)', detail: 'three average true ranges below the highest high' },
  ],
  'take profit': [
    { label: '20%', insert: '20%', detail: 'above the entry price' },
    { label: '4 atr(14)', insert: '4 atr(14)', detail: 'four average true ranges above the entry price' },
  ],
  slippage: [{ label: '5 bps', insert: '5 bps', detail: 'each fill 0.05% worse than the price' }],
  'cash rate': [
    { label: '4%', insert: '4%', detail: 'a fixed yearly rate' },
    { label: '^IRX', insert: '^IRX', detail: '13-week Treasury bill yield, from Yahoo' },
  ],
  'test from': [{ label: '2019-01-01', insert: '2019-01-01', detail: 'results before and from this day are shown apart' }],
  hold: [{ label: 'top 3 by roc(126)', insert: 'top 3 by roc(126)', detail: 'the 3 tickers with the highest score' }],
  weighting: [{ label: 'inverse volatility(60)', insert: 'inverse volatility(60)', detail: 'weights by 1 / volatility of the last 60 returns' }],
  'risk per trade': [{ label: '1% at 2 atr(14)', insert: '1% at 2 atr(14)', detail: 'lose 1% of equity if the price falls 2 average true ranges' }],
  commission: [
    { label: '1', insert: '1', detail: 'a fixed 1 for each order' },
    { label: '0.005 per share, min 1', insert: '0.005 per share, min 1', detail: '0.005 a share, at least 1 an order' },
  ],
  entries: [{ label: '3', insert: '3', detail: 'each position in up to 3 entries, each a third; needs an add rule' }],
  magnify: [
    { label: '1h', insert: '1h', detail: 'stops and targets followed through 1-hour bars inside each bar' },
    { label: '5m', insert: '5m', detail: 'stops and targets followed through 5-minute bars inside each bar' },
    { label: '1d', insert: '1d', detail: 'daily bars inside each weekly bar' },
  ],
};

const FUNCTIONS = [...Object.keys(INDICATORS), 'min', 'max', 'abs'];

/** A function's signature and what it does, as one line. */
const functionDetail = (f: string) => `${docFor(f)!.signature} \u00b7 ${shortOf(f)}`;

const POSITION_WORDS: Completion[] = Object.values(POSITION).map((p) => entry(p));
const CALENDAR_WORDS: Completion[] = CALENDAR.map((c) => entry(c));

const WORDS: Completion[] = [
  entry('and', 'and '),
  entry('or', 'or '),
  entry('not', 'not '),
  entry('crosses above', 'crosses above '),
  entry('crosses below', 'crosses below '),
  entry('above', 'above '),
  entry('below', 'below '),
  entry('of', 'of '),
  entry('true', 'true'),
];

/** Names the block's universe and benchmark can be referred to by; `keys` narrows the lines read. */
export function tickers(lines: string[], keys: string[] = ['universe', 'symbol', 'benchmark']): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const key = settingKey(line);
    if (!key || !keys.includes(key)) continue;
    for (const part of line.slice(line.indexOf(':') + 1).split(',')) {
      const ref = part.trim().split(/\s+/)[0];
      if (!ref) continue;
      const csv = /^csv:/i.test(ref);
      const id = ref.replace(/^(yahoo|binance|csv):/i, '');
      const name = csv ? id.split('/').pop()!.replace(/\.csv$/i, '') : id.toUpperCase();
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/**
 * What can come next. `before` is the cursor's line up to the cursor; `above` the block's lines
 * before that line and `block` every line of the block.
 */
export function complete(block: string[], above: string[], before: string): CompletionResult | null {
  const word = before.match(/[A-Za-z0-9_]*$/)![0];
  const from = before.length - word.length;
  const head = before.slice(0, from);
  const match = (items: Completion[], allowEmpty = false): CompletionResult | null => {
    if (!word && !allowEmpty) return null;
    const w = word.toLowerCase();
    const hits = items.filter((i) => i.label.toLowerCase().startsWith(w));
    // Nothing left to add once the only match is fully typed.
    if (hits.length === 0 || (hits.length === 1 && hits[0].insert.trim().toLowerCase() === w)) return null;
    return { from, items: hits };
  };
  const names = (suffix: string, detail: string) => tickers(block).map((t) => ({ label: t, insert: t + suffix, detail }));
  const params = declaredParams(block);

  // Read the lines above the way the parser does: whether a rule is open, which side it is, and
  // which "for" section the cursor sits in.
  let inRule = false;
  let sellOrAdd = false;
  let section: string | null = null;
  for (const line of above) {
    const kind = lineKind(line, inRule);
    inRule = kind === 'rule' || kind === 'continuation';
    if (kind === 'rule') sellOrAdd = /^\s*(sell|add)/i.test(line);
    if (kind === 'for') {
      const name = line.match(/^\s*for\s+(.+?)\s*:/i)![1];
      section = name.toLowerCase() === 'all' ? null : name;
    }
  }

  /** Inside an expression: series, values, parameters, functions and words. */
  const expression = (positions: boolean): CompletionResult | null => {
    if (/\bof\s+$/i.test(head)) return match(names('', 'read this ticker instead'), true);
    if (/\bcrosses\s+$/i.test(head)) return match([{ label: 'above', insert: 'above ', detail: '' }, { label: 'below', insert: 'below ', detail: '' }], true);
    if (/^\d/.test(word) || /[\d.]$/.test(head)) return null;
    return match([
      ...SERIES.map((s) => entry(s)),
      ...(positions ? POSITION_WORDS : []),
      ...CALENDAR_WORDS,
      ...params.map((p) => ({ label: p.name, insert: p.name, detail: `parameter: ${p.value}` })),
      ...FUNCTIONS.map((f) => entry(f, `${f}(`, functionDetail(f))),
      ...WORDS,
    ]);
  };

  if (/^\s*$/.test(head)) {
    if (/^\d/.test(word)) return null;
    // A "for" section can only hold rules and stops of its own.
    const settings = section === null ? SETTINGS : STOP_SETTINGS;
    const starts: Completion[] = [
      entry('buy when', 'buy when '),
      entry('sell when', 'sell when '),
      entry('add when', 'add when '),
      ...(inRule ? WORDS.slice(0, 2).map((w) => ({ ...w, detail: `continue the rule: ${w.detail}` })) : []),
      ...settings.map((s) => entry(s, `${s}: `, section === null ? shortOf(s) : `${shortOf(s)}, for ${section} only`)),
      entry('for', 'for '),
    ];
    return match(starts);
  }
  if (/^\s*(buy|sell|add)\s+$/i.test(head)) return match([{ label: 'when', insert: 'when ', detail: '' }], true);
  if (/^\s*for\s+$/i.test(head)) return match([...names(':', 'rules for this ticker only'), entry('all', 'all:', shortOf('for all'))], true);

  const key = settingKey(head);
  if (key === 'hold' && /:\s*top\s+\S+\s+by\s/i.test(head)) return expression(false);
  if (key) {
    const percents = STOP_SETTINGS.includes(key) ? params.filter((p) => p.value.includes('%')).map((p) => ({ label: p.name, insert: p.name, detail: `parameter: ${p.value}` })) : [];
    // A value can be several words (`next open`), so it is matched as a whole, from the first thing after the colon.
    const afterColon = before.slice(before.indexOf(':') + 1);
    const valueFrom = before.length - afterColon.trimStart().length;
    const typed = before.slice(valueFrom).toLowerCase();
    const hits = [...(VALUE_HINTS[key] ?? []), ...percents].filter((i) => i.label.toLowerCase().startsWith(typed));
    if (hits.length === 0 || (hits.length === 1 && hits[0].insert.toLowerCase() === typed)) return null;
    return { from: valueFrom, items: hits };
  }

  const kind = lineKind(before, inRule);
  if (kind !== 'rule' && kind !== 'continuation') return null;
  return expression(kind === 'rule' ? /^\s*(sell|add)/i.test(before) : sellOrAdd);
}

/** Where the cursor is when a ticker is being written on a `universe`, `symbol`, `benchmark` or `cash rate` line. */
export interface TickerPosition {
  /** Column where the ticker, with any `binance:` style prefix, starts. */
  from: number;
  /** What has been typed of it. */
  word: string;
}

const TICKER_LINES = ['universe', 'symbol', 'benchmark', 'cash rate'];

/**
 * The ticker being typed, or null when the cursor is somewhere else on the line: after a weight
 * (`SPY 60`), in a number, or in a comment. Only the ticker word counts, so weights are left alone.
 */
export function tickerPosition(before: string): TickerPosition | null {
  const key = settingKey(before);
  if (!key || !TICKER_LINES.includes(key) || /(^|\s)(#|\/\/)/.test(before)) return null;
  const rest = before.slice(before.indexOf(':') + 1);
  const part = rest.slice(rest.lastIndexOf(',') + 1).trimStart();
  if (!/^[A-Za-z0-9^:/._=-]*$/.test(part) || /^[\d.]+$/.test(part)) return null;
  return { from: before.length - part.length, word: part };
}

/** The tickers a block's universe lines write, as written (`binance:BTCUSDT`, `csv:Data/gold.csv`), without repeats. */
export function writtenTickers(lines: string[], keys: string[] = ['universe', 'symbol']): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const key = settingKey(line);
    if (!key || !keys.includes(key)) continue;
    for (const part of line.replace(/(^|\s)(#|\/\/).*$/, '').slice(line.indexOf(':') + 1).split(',')) {
      const ref = part.trim().split(/\s+/)[0];
      if (ref && !out.some((o) => o.toLowerCase() === ref.toLowerCase())) out.push(ref);
    }
  }
  return out;
}

const CSV_SHOWN = 20;

/**
 * What a ticker position can offer without a lookup: the vault's CSV files after `csv:` (paths with a
 * space or comma cannot be written in a block), or else the tickers the block's universe already names
 * and the line has not (`taken`).
 */
export function localTickers(block: string[], pos: TickerPosition, taken: string[], csvPaths: readonly string[]): Completion[] {
  const word = pos.word.toLowerCase();
  if (word.startsWith('csv:')) {
    const typed = word.slice(4);
    const name = (p: string) => p.split('/').pop()!.toLowerCase();
    return csvPaths
      .filter((p) => !/[\s,]/.test(p) && p.toLowerCase().includes(typed))
      .sort((a, b) => Number(name(b).startsWith(typed)) - Number(name(a).startsWith(typed)) || a.length - b.length)
      .slice(0, CSV_SHOWN)
      .map((p) => ({ label: `csv:${p}`, insert: `csv:${p}`, detail: 'file in your vault' }));
  }
  const used = new Set(taken.map((t) => t.toLowerCase()));
  return writtenTickers(block)
    .filter((t) => t.toLowerCase().startsWith(word) && !used.has(t.toLowerCase()))
    .map((t) => ({ label: t, insert: t, detail: 'in this block' }));
}

/** Lookup hits as completions: the ticker as the block needs it, then its name and exchange. */
export function hitCompletions(hits: Suggestion[], own: Completion[]): Completion[] {
  const have = new Set(own.map((o) => o.insert.toLowerCase()));
  return hits
    .filter((s) => !have.has(s.written.toLowerCase()))
    .map((s) => ({ label: s.written, insert: s.written, detail: [s.hit.name, s.hit.detail].filter(Boolean).join(' \u00b7 '), hit: true }));
}
