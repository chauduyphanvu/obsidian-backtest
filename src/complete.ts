import { BINANCE_INTERVALS, REBALANCE, SERIES, SETTINGS } from './dsl.ts';
import { lineKind, settingKey } from './highlight.ts';

export interface Completion {
  label: string;
  /** Text that replaces what has been typed of the word. */
  insert: string;
  detail: string;
}

export interface CompletionResult {
  /** Column where the word being completed starts. */
  from: number;
  items: Completion[];
}

const SETTING_HELP: Record<string, string> = {
  name: 'title shown above the result',
  universe: 'tickers and weights: SPY 60%, TLT 40%',
  symbol: 'one ticker (same as universe)',
  from: 'first day, as 2015-01-31',
  to: 'last day, as 2024-12-31',
  data: 'where plain tickers come from: yahoo or binance',
  interval: 'bar size: 1d, 1w, or 1h and others on Binance',
  capital: 'starting money, as 10000 or 10k',
  costs: 'per trade, as 5 bps or 0.05%',
  size: 'share of equity to use when tickers have no weights',
  rebalance: 'never, weekly, monthly, quarterly or yearly',
  benchmark: 'ticker to compare with, bought and held',
  'stop loss': 'sell this far below the entry price, as 10%',
  'trailing stop': 'sell this far below the highest price since entry',
  'take profit': 'sell this far above the entry price',
};

const FUNCTION_HELP: Record<string, string> = {
  sma: 'sma(n) · simple average of the last n closes; sma(series, n) for another series',
  ema: 'ema(n) · exponential average',
  rsi: 'rsi(n = 14) · relative strength index, 0 to 100',
  roc: 'roc(n) · change over n bars, compare with a percentage',
  stdev: 'stdev(n) · standard deviation of the last n closes',
  highest: 'highest(n) · highest high of the last n bars; add [1] to leave out this bar',
  lowest: 'lowest(n) · lowest low of the last n bars',
  atr: 'atr(n = 14) · average true range',
  macd: 'macd(fast = 12, slow = 26) · fast average minus slow average',
  macd_signal: 'macd_signal(12, 26, 9) · average of the macd line',
  bb_upper: 'bb_upper(n = 20, width = 2) · upper Bollinger band',
  bb_lower: 'bb_lower(n = 20, width = 2) · lower Bollinger band',
  min: 'min(a, b) · the smaller value',
  max: 'max(a, b) · the larger value',
  abs: 'abs(x) · value without its sign',
};

const SERIES_HELP: Record<string, string> = { open: "the bar's open", high: "the bar's high", low: "the bar's low", close: "the bar's close", volume: "the bar's volume" };

const WORDS: Completion[] = [
  { label: 'and', insert: 'and ', detail: 'both conditions hold' },
  { label: 'or', insert: 'or ', detail: 'either condition holds' },
  { label: 'not', insert: 'not ', detail: 'the condition does not hold' },
  { label: 'crosses above', insert: 'crosses above ', detail: 'was at or below, is now above' },
  { label: 'crosses below', insert: 'crosses below ', detail: 'was at or above, is now below' },
  { label: 'above', insert: 'above ', detail: 'same as >' },
  { label: 'below', insert: 'below ', detail: 'same as <' },
  { label: 'of', insert: 'of ', detail: "another ticker's value: sma(200) of SPY" },
  { label: 'true', insert: 'true', detail: 'always holds' },
];

/** Names the block's universe and benchmark can be referred to by. */
export function tickers(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const key = settingKey(line);
    if (key !== 'universe' && key !== 'symbol' && key !== 'benchmark') continue;
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

  let inRule = false;
  for (const line of above) {
    const kind = lineKind(line, inRule);
    inRule = kind === 'rule' || kind === 'continuation';
  }

  if (/^\s*$/.test(head)) {
    if (/^\d/.test(word)) return null;
    const starts: Completion[] = [
      { label: 'buy when', insert: 'buy when ', detail: 'condition that opens a position' },
      { label: 'sell when', insert: 'sell when ', detail: 'condition that closes it' },
      ...(inRule ? WORDS.slice(0, 2).map((w) => ({ ...w, detail: `continue the rule: ${w.detail}` })) : []),
      ...SETTINGS.map((s) => ({ label: s, insert: `${s}: `, detail: SETTING_HELP[s] })),
      { label: 'for', insert: 'for ', detail: 'rules for one ticker: for TLT:' },
    ];
    return match(starts);
  }
  if (/^\s*(buy|sell)\s+$/i.test(head)) return match([{ label: 'when', insert: 'when ', detail: '' }], true);
  if (/^\s*for\s+$/i.test(head)) return match([...names(':', 'rules for this ticker only'), { label: 'all', insert: 'all:', detail: 'back to the rules every ticker shares' }], true);

  const key = settingKey(head);
  if (key && /:\s*$/.test(head)) {
    const values = key === 'rebalance' ? REBALANCE : key === 'data' ? ['yahoo', 'binance'] : key === 'interval' ? BINANCE_INTERVALS : [];
    return match(values.map((v) => ({ label: v, insert: v, detail: key === 'interval' && v !== '1d' && v !== '1w' ? 'Binance only' : '' })), true);
  }
  if (key) return null;

  const kind = lineKind(before, inRule);
  if (kind !== 'rule' && kind !== 'continuation') return null;
  if (/\bof\s+$/i.test(head)) return match(names('', 'read this ticker instead'), true);
  if (/\bcrosses\s+$/i.test(head)) return match([{ label: 'above', insert: 'above ', detail: '' }, { label: 'below', insert: 'below ', detail: '' }], true);
  if (/^\d/.test(word) || /[\d.]$/.test(head)) return null;
  return match([
    ...SERIES.map((s) => ({ label: s, insert: s, detail: SERIES_HELP[s] })),
    ...Object.keys(FUNCTION_HELP).map((f) => ({ label: f, insert: `${f}(`, detail: FUNCTION_HELP[f] })),
    ...WORDS,
  ]);
}
