import { BINANCE_INTERVALS, CALENDAR, INDICATORS, NUM, POSITION, REBALANCE, SERIES } from './dsl.ts';
import { commentStart, declaredDefinitions, declaredParams, lineKinds, RULE_HEADS, settingKey, tokenizeBlock, type LineKind, type Token } from './highlight.ts';
import { DATA_SOURCES, SOURCE_PREFIX } from './types.ts';

export type DocKind = 'setting' | 'value' | 'function' | 'series' | 'calendar' | 'position' | 'word' | 'unit' | 'parameter' | 'definition';

/** What the editor says about one word of the language. */
export interface Doc {
  /** Setting, function, series, calendar value or word as written ("stop loss"); a fixed value as "setting=value" ("rebalance=monthly"). */
  id: string;
  kind: DocKind;
  /** The signature line, in the language's own form. */
  signature: string;
  /** One or two plain sentences. */
  text: string;
  /** One example, valid in the language, as it would be written in a block; empty for a parameter. */
  example: string;
  /** One line for the completion list. */
  short: string;
}

/** The settings a value can be chosen from, with the values the language accepts for each. */
export const FIXED_VALUES: Record<string, readonly string[]> = {
  rebalance: REBALANCE,
  data: DATA_SOURCES,
  interval: BINANCE_INTERVALS,
  fill: ['next open', 'close'],
};

const DOCS: Doc[] = [];
const BY_ID = new Map<string, Doc>();

function add(kind: DocKind, id: string, signature: string, short: string, text: string, example: string): void {
  const doc: Doc = { id, kind, signature, short, text, example };
  DOCS.push(doc);
  BY_ID.set(id, doc);
}

const setting = (id: string, signature: string, short: string, text: string, example: string) => add('setting', id, signature, short, text, example);
const word = (id: string, signature: string, short: string, text: string, example: string) => add('word', id, signature, short, text, example);

setting('name', 'name: text', 'title shown above the result', 'The title shown above the result. Without it the title is Backtest.', 'name: Trend following');
setting(
  'universe',
  'universe: SPY 60%, TLT 40%',
  'tickers and weights: SPY 60%, TLT 40%',
  'The tickers to trade, each with an optional weight: give every ticker one, or none. Weights add up to at most 200%: what is left under 100% stays in cash, and above 100% the strategy borrows.',
  'universe: SPY 60%, TLT 40%',
);
setting('symbol', 'symbol: SPY', 'one ticker (same as universe)', 'Another way to write universe.', 'symbol: SPY');
setting('from', 'from: 2015-01-31', 'first day, as 2015-01-31', 'The first day of the run. Without it the run starts on the first day every ticker has prices.', 'from: 2015-01-31');
setting('to', 'to: 2024-12-31', 'last day, as 2024-12-31', 'The last day of the run, whole day included, and it must come after from. Without it the run ends on the last day with prices.', 'to: 2024-12-31');
setting(
  'data',
  'data: yahoo | binance | tiingo',
  'where plain tickers come from: yahoo, binance or tiingo',
  'Where tickers written without a prefix come from, the plugin setting deciding without it, though a plain ticker that starts with ^, such as ^VIX or ^IRX, comes from Yahoo whatever data says. yahoo:, binance:, tiingo:, fred: or csv: in front of a ticker picks that ticker’s own source.',
  'data: binance',
);
setting(
  'interval',
  'interval: 1d | 1w | …',
  'bar size: 1d, 1w, or 1h and others on Binance',
  'The bar size, 1d unless you say otherwise. Yahoo and Tiingo give 1d and 1w, Binance gives 1m up to 1w, and one interval applies to every ticker.',
  'interval: 1w',
);
setting('capital', 'capital: 10000', 'starting money, as 10000 or 10k', 'The starting money, written 10000 or 10k (m is millions). Without it the plugin’s Starting money setting is used.', 'capital: 10k');
setting(
  'costs',
  'costs: 5 bps',
  'per trade, as 5 bps or 0.05%',
  'The cost of each trade, written 5 bps or 0.05%. A plain number counts as bps, and the cost must be under 10%.',
  'costs: 5 bps',
);
setting(
  'slippage',
  'slippage: 5 bps',
  'how much worse each fill is than the price, as 5 bps',
  'How much worse each fill is than the price: a buy or a cover fills higher, and a sell or a short sale lower. It is written like costs.',
  'slippage: 5 bps',
);
setting(
  'size',
  'size: 80%',
  'share of equity to use when tickers have no weights',
  'The share of equity to use when the tickers have no weights, up to 200%, borrowing above 100%. You cannot give weights and size together.',
  'size: 80%',
);
setting(
  'rebalance',
  'rebalance: never | weekly | monthly | quarterly | yearly',
  'never, weekly, monthly, quarterly or yearly',
  'How often held tickers go back to their weights. Without it, never.',
  'rebalance: monthly',
);
setting(
  'benchmark',
  'benchmark: QQQ',
  'ticker to compare with, bought and held',
  'The ticker to compare the result with, bought and held. Without it the benchmark is your own tickers at their weights.',
  'benchmark: QQQ',
);
setting(
  'stop loss',
  'stop loss: 10% | 2 atr(14)',
  'sell this far below the entry price (above it for a short), as 10% or 2 atr(14)',
  'Sells when the price falls this far below the entry price, or buys a short back when it rises this far above it, as a percentage or as a number of average true ranges. A percentage must be above 0% and at most 99%.',
  'stop loss: 10%',
);
setting(
  'trailing stop',
  'trailing stop: 15% | 3 atr(14)',
  'sell this far below the highest price since entry (above the lowest for a short)',
  'Sells when the price falls this far below the highest price since entry, or buys a short back when it rises this far above the lowest. A percentage must be above 0% and at most 99%.',
  'trailing stop: 15%',
);
setting(
  'take profit',
  'take profit: 20% | 4 atr(14)',
  'sell this far above the entry price (below it for a short)',
  'Sells when the price rises this far above the entry price, or buys a short back when it falls this far below it. A percentage must be above 0% and at most 1000%, and a short can never reach one of 100% or more.',
  'take profit: 20%',
);
setting(
  'cash rate',
  'cash rate: 4% | ^IRX',
  'what cash earns: 4% a year, or a yield ticker such as ^IRX',
  'What cash earns a year, written 4%, or a ticker whose close is a yearly yield, such as ^IRX or fred:DGS3MO. A rate needs its percent sign and must be at most 50%.',
  'cash rate: 4%',
);
setting(
  'borrow fee',
  'borrow fee: 0.5%',
  'yearly fee on the value of short positions, 0.5% unless set',
  'A yearly fee on the value of each short position at the close, paid for every day it is held and counted in the trade’s return. Without it the plugin’s Borrow fee for shorts setting is used, 0.5% at first, and it must be between 0% and 100%.',
  'borrow fee: 1%',
);
setting(
  'margin rate',
  'margin rate: 6%',
  'yearly interest on money borrowed, 6% unless set',
  'Yearly interest on money borrowed, paid between two bars when cash less the value of the shorts is below 0, as it is when the strategy holds more than its equity. Without it the plugin’s Interest on borrowed money setting is used, 6% at first, and it must be between 0% and 50%.',
  'margin rate: 7%',
);
setting(
  'test from',
  'test from: 2019-01-01',
  'report results before and from this day apart',
  'Reports the results before this day and from it apart. It is one run split in two with nothing re-fitted, and the day must lie after from and before to.',
  'test from: 2019-01-01',
);
setting(
  'hold',
  'hold: top 3 by roc(126)',
  'hold only the best-ranked tickers: top 3 by roc(126)',
  'Holds only the tickers with the highest score, such as the top 3 by roc(126). The score is a number written like a value in a rule, and the universe takes no weights.',
  'hold: top 3 by roc(126)',
);
setting(
  'weighting',
  'weighting: inverse volatility(60)',
  'inverse volatility(60): calmer tickers get more weight',
  'Calmer tickers get more weight: each share is in proportion to 1 divided by the volatility over the last n one-bar returns. The period must be at least 2.',
  'weighting: inverse volatility(60)',
);
setting(
  'risk per trade',
  'risk per trade: 1% at 2 atr(14)',
  'size each buy or short sale by what it risks: 1% at 2 atr(14)',
  'Sizes each buy so that a fall of that many average true ranges loses that share of equity, and each short sale so that a rise does, up to the ticker’s weight. It cannot be used with weighting, or with a rebalance other than never.',
  'risk per trade: 1% at 2 atr(14)',
);
setting(
  'fill',
  'fill: next open | close',
  'when rules fill: at the next open, or at the same close',
  'When a rule fills. With next open, the default, a rule read at a bar’s close fills at the next open; with close it fills at that same close.',
  'fill: close',
);
setting(
  'commission',
  'commission: 1 | 0.005 per share, min 1, max 1%',
  'charge per order: 1, or 0.005 per share, min 1, max 1%',
  'A charge on every order in the account’s money, added to costs: a fixed amount per order, or an amount per share with an optional minimum and a cap as a share of the order’s value. Without it the plugin setting applies, which is none at first.',
  'commission: 0.005 per share, min 1',
);
setting(
  'entries',
  'entries: 3',
  'build each position in up to 3 entries, each a third',
  'Builds each position in up to that many entries, each a step of its whole size: the buy rule makes the first and the add rule each later one. It needs an add rule, and the entries together never go above the ticker’s weight.',
  'entries: 3\nadd when close > last entry price * 1.03',
);
setting(
  'magnify',
  'magnify: 1h',
  'look inside each bar with 1h bars, for stops and targets',
  'Follows a bar that holds a stop or target through smaller bars inside it, such as 1h bars inside daily ones, so the order in which the stop and the target are reached is read, not assumed. Rules stay on the strategy’s own bars, and Yahoo gives 2m to 1h bars inside daily bars for recent days only and 1d bars inside weekly ones.',
  'magnify: 1h',
);

/**
 * What the help says about each function: its arguments' names, in the order INDICATORS lists their defaults, a short and a
 * full description, an example, and what it reads where the usual sentence about its series is not the whole story.
 */
interface FunctionDoc {
  args: string[];
  short: string;
  text: string;
  example: string;
  series?: string;
}

const FUNCTION_DOCS: Record<string, FunctionDoc> = {
  sma: {
    args: ['n'],
    short: 'simple average of the last n closes',
    text: 'Simple average of the last n closes.',
    example: 'buy when close > sma(200)',
  },
  ema: {
    args: ['n'],
    short: 'exponential average',
    text: 'Exponential average, started from the simple average of the first n values.',
    example: 'buy when close > ema(50)',
  },
  rsi: {
    args: ['n'],
    short: 'relative strength index, 0 to 100',
    text: 'Relative strength index, from 0 to 100, with Wilder’s smoothing.',
    example: 'buy when rsi(14) < 30',
  },
  roc: {
    args: ['n'],
    short: 'change over n bars, as a fraction',
    text: 'Change over n bars, as a fraction, so compare it with a percentage: roc(20) > 5%.',
    example: 'buy when roc(20) > 5%',
  },
  stdev: {
    args: ['n'],
    short: 'standard deviation of the last n closes',
    text: 'Standard deviation of the last n closes, dividing by n.',
    example: 'buy when close > sma(20) + stdev(20)',
  },
  highest: {
    args: ['n'],
    short: 'highest high of the last n bars; add [1] to leave out this bar',
    text: 'Highest high of the last n bars, this bar included; add [1] to leave out this bar.',
    example: 'buy when close > highest(20)[1]',
  },
  lowest: {
    args: ['n'],
    short: 'lowest low of the last n bars',
    text: 'Lowest low of the last n bars, this bar included.',
    example: 'sell when close < lowest(20)[1]',
  },
  atr: {
    args: ['n'],
    short: 'average true range',
    text: 'Average true range, with Wilder’s smoothing.',
    example: 'buy when close > close[1] + atr(14)',
  },
  macd: {
    args: ['fast', 'slow'],
    short: 'fast average minus slow average',
    text: 'The fast exponential average minus the slow one.',
    example: 'buy when macd() > 0',
  },
  macd_signal: {
    args: ['fast', 'slow', 'signal'],
    short: 'average of the macd line',
    text: 'Exponential average of the macd line over signal bars.',
    example: 'buy when macd() crosses above macd_signal()',
  },
  bb_upper: {
    args: ['n', 'width'],
    short: 'upper Bollinger band',
    text: 'Upper Bollinger band: the average plus width standard deviations.',
    example: 'buy when close > bb_upper(20, 2)',
  },
  bb_lower: {
    args: ['n', 'width'],
    short: 'lower Bollinger band',
    text: 'Lower Bollinger band: the average minus width standard deviations.',
    example: 'buy when close < bb_lower(20, 2)',
  },
  stoch_k: {
    args: ['n', 'smooth'],
    short: 'stochastic %K, 0 to 100',
    text: 'Stochastic %K, from 0 to 100: where the close sits between the lowest low and the highest high of the last n bars, averaged over smooth bars (1 for no averaging).',
    example: 'buy when stoch_k(14, 3) < 20',
  },
  stoch_d: {
    args: ['n', 'smooth', 'd'],
    short: 'stochastic %D: stoch_k averaged over d bars',
    text: 'Stochastic %D: stoch_k, with the same n and smooth, averaged over d more bars.',
    example: 'buy when stoch_k() crosses above stoch_d()',
  },
  adx: {
    args: ['n'],
    short: 'average directional index, 0 to 100',
    text: 'Wilder’s average directional index, from 0 to 100: how strong the trend is, whichever way, as the n-bar Wilder average of 100 * |plus_di - minus_di| / (plus_di + minus_di).',
    example: 'buy when adx(14) > 25 and plus_di(14) > minus_di(14)',
  },
  plus_di: {
    args: ['n'],
    short: 'plus directional indicator, 0 to 100',
    text: 'Wilder’s plus directional indicator, from 0 to 100: the Wilder average over n bars of upward movement, divided by that of the true range, times 100.',
    example: 'buy when plus_di(14) > minus_di(14)',
  },
  minus_di: {
    args: ['n'],
    short: 'minus directional indicator, 0 to 100',
    text: 'Wilder’s minus directional indicator, from 0 to 100: the Wilder average over n bars of downward movement, divided by that of the true range, times 100.',
    example: 'sell when minus_di(14) > plus_di(14)',
  },
  cci: {
    args: ['n'],
    short: 'commodity channel index of the typical price',
    text: 'Commodity channel index: the typical price (high + low + close) / 3 minus its n-bar average, divided by 0.015 times its mean absolute deviation from that average.',
    example: 'buy when cci(20) < -100',
  },
  williams_r: {
    args: ['n'],
    short: 'Williams %R, -100 to 0',
    text: 'Williams %R, from -100 to 0: -100 * (highest high - close) / (highest high - lowest low) over the last n bars.',
    example: 'buy when williams_r(14) < -80',
  },
  mfi: {
    args: ['n'],
    short: 'money flow index, 0 to 100',
    text: 'Money flow index, from 0 to 100: 100 - 100 / (1 + money flowing in / money flowing out) over the last n bars, where a bar’s flow is its typical price times its volume, counted in when the typical price rose and out when it fell.',
    example: 'buy when mfi(14) < 20',
    series: 'It takes no series and needs volume.',
  },
  obv: {
    args: [],
    short: 'on-balance volume, a running total',
    text: 'On-balance volume: a running total that adds a bar’s volume when the close rose and takes it off when it fell, starting at 0 on the first bar.',
    example: 'buy when obv() > sma(obv(), 20)',
    series: 'It takes no series and needs volume.',
  },
  vwap: {
    args: ['n'],
    short: 'volume-weighted average price of the last n bars',
    text: 'Volume-weighted average of the typical price (high + low + close) / 3 over the last n bars.',
    example: 'buy when close > vwap(20)',
    series: 'It takes no series and needs volume.',
  },
  keltner_upper: {
    args: ['n', 'width', 'atr'],
    short: 'upper Keltner channel',
    text: 'Upper Keltner channel: the n-bar exponential average plus width times the average true range over atr bars, which is read from the ticker’s own bars.',
    example: 'buy when close > keltner_upper(20, 2, 10)',
  },
  keltner_lower: {
    args: ['n', 'width', 'atr'],
    short: 'lower Keltner channel',
    text: 'Lower Keltner channel: the n-bar exponential average minus width times the average true range over atr bars, which is read from the ticker’s own bars.',
    example: 'buy when close < keltner_lower(20, 2, 10)',
  },
  supertrend: {
    args: ['n', 'mult'],
    short: 'supertrend line, under the price in an uptrend',
    text: 'Supertrend line: bands at (high + low) / 2 plus and minus mult average true ranges over n bars, each moving only towards the price until the close crosses it, the lower band in an uptrend and the upper in a downtrend.',
    example: 'buy when close > supertrend(10, 3)',
  },
  supertrend_up: {
    args: ['n', 'mult'],
    short: 'condition: the supertrend is in an uptrend',
    text: 'A condition that is true while the supertrend is in an uptrend, with its line under the price, and false in a downtrend.',
    example: 'buy when supertrend_up(10, 3)',
  },
  wma: {
    args: ['n'],
    short: 'weighted average of the last n values',
    text: 'Linearly weighted average of the last n values, the newest weighing n and the oldest 1.',
    example: 'buy when close > wma(20)',
  },
  hma: {
    args: ['n'],
    short: 'Hull moving average',
    text: 'Hull moving average: the weighted average over sqrt(n) bars of twice the weighted average over n / 2 bars minus the one over n bars, with n / 2 and sqrt(n) rounded down.',
    example: 'buy when close > hma(21)',
  },
  median: {
    args: ['n'],
    short: 'median of the last n values',
    text: 'Median of the last n values, the mean of the two middle ones when n is even.',
    example: 'buy when close > median(20)',
  },
  zscore: {
    args: ['n'],
    short: 'standard deviations from the n-bar average',
    text: 'How many standard deviations the value is from its average over the last n values, dividing by n as stdev does, and unknown when they are all equal.',
    example: 'buy when zscore(20) < -2',
  },
  percent_rank: {
    args: ['n'],
    short: 'share of the previous n values below this one',
    text: 'The share of the previous n values that are below this one, from 0 to 100.',
    example: 'buy when percent_rank(100) > 95',
  },
  slope: {
    args: ['n'],
    short: 'least-squares slope over n bars, per bar',
    text: 'Slope of the least-squares line through the last n values, in the series’ units per bar.',
    example: 'buy when slope(90) / close > 0.1%',
  },
  correl: {
    args: ['n'],
    short: 'correlation with another ticker, -1 to 1',
    text: 'Correlation, from -1 to 1, of the one-bar changes of this ticker’s close and of the series written first, over the last n bars, unknown when either one is constant.',
    example: 'buy when correl(close of SPY, 60) < 0.5',
    series: 'It reads close for this ticker; the series written first is read as of reads it, so it lines up with this ticker’s bars.',
  },
  count: {
    args: ['n'],
    short: 'how many of the last n bars a condition held',
    text: 'How many of the last n bars the condition held, this one included, and unknown while any of them is unknown.',
    example: 'buy when count(close > close[1], 10) >= 7',
    series: 'It takes no series, only a condition.',
  },
  bars_since: {
    args: [],
    short: 'bars since a condition was last true',
    text: 'Bars since the condition was last true: 0 on a bar where it is, and unknown until it has been true.',
    example: 'buy when bars_since(close crosses above sma(50)) < 10',
    series: 'It takes no series, only a condition.',
  },
};

/** The call as written, with each default from INDICATORS: `rsi(n = 14)`, `sma(n)`, and a leading series or condition where the function needs one. */
export function functionSignature(name: string): string {
  const def = INDICATORS[name];
  const names = FUNCTION_DOCS[name].args;
  const lead = def.lead === 'series' ? ['other'] : def.lead === 'condition' ? ['condition'] : [];
  return `${name}(${[...lead, ...def.params.map((d, i) => (d === null ? names[i] : `${names[i]} = ${d}`))].join(', ')})`;
}

for (const name of Object.keys(INDICATORS)) {
  const def = INDICATORS[name];
  const doc = FUNCTION_DOCS[name];
  const sample = `${name}(volume, ${def.params.map((d) => d ?? 20).join(', ')})`;
  const series = doc.series ?? (def.src === null ? 'It takes no series.' : `Without a series it reads ${def.src}; write another first, as in ${sample}.`);
  add('function', name, functionSignature(name), doc.short, `${doc.text} ${series}`, doc.example);
}
add('function', 'min', 'min(a, b)', 'the smaller value', 'The smaller of two values.', 'buy when close > min(sma(20), sma(50))');
add('function', 'max', 'max(a, b)', 'the larger value', 'The larger of two values.', 'buy when close > max(sma(20), sma(50))');
add('function', 'abs', 'abs(x)', 'value without its sign', 'The value without its sign.', 'buy when abs(close - open) > atr(14)');
add(
  'function',
  'column',
  'column(name) of file',
  'a column of a CSV file: column(score) of signals',
  'Reads a numeric column of a CSV file by its header, in lower case with underscores for spaces, such as column(score) of signals. A row counts as known at the close of the day it is dated.',
  'buy when column(score) of csv:Data/signals.csv > 0.7',
);

const ADJUSTED = 'With Yahoo data prices are adjusted for splits and dividends, so compare them with an average, not a fixed number.';
add('series', 'open', 'open', "the bar's open", `The open price of each bar of the ticker the rule belongs to. ${ADJUSTED}`, 'buy when open > close[1]');
add('series', 'high', 'high', "the bar's high", `The highest price of each bar of the ticker the rule belongs to. ${ADJUSTED}`, 'buy when high > high[1]');
add('series', 'low', 'low', "the bar's low", `The lowest price of each bar of the ticker the rule belongs to. ${ADJUSTED}`, 'buy when low < low[1]');
add('series', 'close', 'close', "the bar's close", `The close price of each bar of the ticker the rule belongs to. ${ADJUSTED}`, 'buy when close > sma(200)');
add('series', 'volume', 'volume', "the bar's volume", 'The traded volume of each bar of the ticker the rule belongs to.', 'buy when volume > sma(volume, 20)');

const calendar = (id: string, signature: string, short: string, text: string, example: string) => add('calendar', id, signature, short, `${text} It is read from each bar’s date in UTC.`, example);
calendar('month', 'month', 'month of the bar, 1 to 12', 'The month of the bar, 1 to 12.', 'buy when month == 11');
calendar('day', 'day', 'day of the month, 1 to 31', 'The day of the month, 1 to 31.', 'sell when month == 5 and day > 20');
calendar('weekday', 'weekday', '1 = Monday to 7 = Sunday', 'The day of the week: 1 for Monday to 7 for Sunday.', 'buy when weekday == 1');
calendar('year', 'year', 'the year, as 2024', 'The year, such as 2024.', 'buy when year >= 2010');
calendar('month_start', 'month_start', 'first bar of a month', 'A condition: the first bar of a month.', 'buy when month_start');
calendar('month_end', 'month_end', 'last bar of a month', 'A condition: the last bar of a month.', 'buy when month_end');

const BELONGS = 'Only sell, cover and add rules can read it, and not inside a function, over a window of bars, with [n] or with of.';
add(
  'position',
  POSITION.bars_held,
  'bars held',
  'completed bars since the entry filled, 0 on that bar',
  `The number of completed bars since the buy filled (for a short, the short sale), or with several entries the first; it is 0 on the bar of the fill. ${BELONGS}`,
  'sell when bars held >= 20',
);
add(
  'position',
  POSITION.entry_price,
  'entry price',
  'the price the position was bought or sold short at',
  `The price the position was bought at, slippage included, or for a short the price it was sold at; with several entries, their average price. ${BELONGS}`,
  'sell when close < entry price * 0.9',
);
add(
  'position',
  POSITION.last_entry_price,
  'last entry price',
  'the price of the latest entry',
  `The price the latest entry of the position filled at, slippage included; with one entry it is the entry price. ${BELONGS}`,
  'sell when close < last entry price * 0.95',
);
add(
  'position',
  POSITION.entries_made,
  'entries made',
  'how many entries the position has',
  `How many entries the open position has made: 1 after the buy or short sale, then one more for each add. ${BELONGS}`,
  'sell when entries made == 1 and bars held >= 10',
);
add(
  'position',
  POSITION.highest_since_entry,
  'highest since entry',
  'the highest price since the position was entered',
  `The highest price since the position's first entry: its fill price before slippage, then the high of each later bar, and of the fill bar too when it filled at that bar's open. ${BELONGS}`,
  'sell when close < highest since entry - 3 * atr(22)',
);
add(
  'position',
  POSITION.lowest_since_entry,
  'lowest since entry',
  'the lowest price since the position was entered',
  `The lowest price since the position's first entry: its fill price before slippage, then the low of each later bar, and of the fill bar too when it filled at that bar's open. ${BELONGS}`,
  'short when close < sma(200)\ncover when close > lowest since entry + 3 * atr(22)',
);
add(
  'position',
  POSITION.position_return,
  'position return',
  'the open position’s return at this close, before costs',
  `The open position's return at this close before costs: close / entry price - 1 for a long, 1 - close / entry price for a short. ${BELONGS}`,
  'sell when position return > 20% or bars held > 30',
);

word(
  'between',
  'a between lo and hi',
  'inside a range, both ends included',
  'True when a is at least lo and at most hi, so rsi(2) between 10 and 30 means rsi(2) >= 10 and rsi(2) <= 30. It does not chain, and it is read as one comparison, so not rsi(2) between 10 and 30 holds outside the range.',
  'buy when rsi(2) between 10 and 30',
);
word(
  'for … bars',
  'condition for n bars',
  'held on each of the last n bars',
  'True when the condition held on each of the last n bars, this one included, and unknown until all n are known. It applies to the comparison before it, so a and b for 3 bars means a and (b for 3 bars): use brackets for more.',
  'buy when close > sma(200) for 3 bars',
);
word(
  'within',
  'condition within n bars',
  'held on at least one of the last n bars',
  'True when the condition held on at least one of the last n bars, this one included, and unknown until all n are known. n is a whole number from 1 to 10000 or a parameter, and bar is also accepted.',
  'sell when rsi(2) > 90 within 3 bars',
);
word(
  'buy when',
  'buy when condition',
  'condition that opens a long position',
  'Opens a long position in a ticker you do not hold when the condition is true at a close. It fills at that ticker’s next open, unless the fill setting says close.',
  'buy when close > sma(200)',
);
word(
  'sell when',
  'sell when condition',
  'condition that closes a long position',
  'Closes a long position when the condition is true at a close. Without a sell rule a position is held until a stop or a short rule closes it, or the run ends.',
  'sell when close < sma(200)',
);
word(
  'add when',
  'add when condition',
  'condition that adds the next entry',
  'Adds the next entry to the position held, long or short, when the condition is true at a close, until the entries setting’s count is made. It needs an entries line, and it is skipped at a close where the sell rule, or for a short the cover rule, holds.',
  'entries: 3\nadd when close > last entry price * 1.03',
);
word(
  'short when',
  'short when condition',
  'condition that opens a short position',
  'Sells short a ticker you do not hold when the condition is true at a close, so the position gains as the price falls; it fills as a buy would. A ticker held long is closed by it, and turns short at the same fill when the buy rule does not hold there too.',
  'short when close < sma(200)',
);
word(
  'cover when',
  'cover when condition',
  'condition that closes a short position',
  'Buys a short position back when the condition is true at a close; it needs a short rule. Without a cover rule a short is held until a stop or the buy rule closes it, or the run ends.',
  'short when close < sma(200)\ncover when close > sma(200)',
);
word(
  'for',
  'for TICKER:',
  'rules and stops for one ticker or several: for TLT:',
  'Starts rules for one ticker, or for several separated by commas, as in for SPY, TLT:; each must be in the universe. A buy, sell, short, cover or add rule, stop loss, trailing stop or take profit written below it replaces the shared one for those tickers only.',
  'for SPY, TLT:',
);
word('for all', 'for all:', 'back to the rules every ticker shares', 'Goes back to the rules every ticker shares. What you write after it applies to every ticker that has no rule of its own.', 'for all:');
word(
  'and',
  'a and b',
  'both conditions hold',
  'True when both conditions are true. A rule can continue on the next line: indent it and start it with and or or.',
  'buy when close > sma(200) and rsi(14) < 70',
);
word('or', 'a or b', 'either condition holds', 'True when either condition is true. It binds loosest, so a and b or c reads as (a and b) or c.', 'sell when close < sma(200) or rsi(14) > 85');
word(
  'not',
  'not a',
  'the condition does not hold',
  'True when the condition after it is not true. It binds tighter than and but looser than a comparison, so not close > 1 reads as not (close > 1).',
  'buy when not close < sma(200)',
);
word(
  'crosses',
  'a crosses b',
  'changed sides: crossed above or below',
  'True on a bar where a crosses above or below b: it is on the other side of b than it was on the previous bar. Write crosses above or crosses below for one direction only.',
  'buy when close crosses sma(50)',
);
word(
  'crosses above',
  'a crosses above b',
  'was at or below, is now above',
  'True on a bar where a is above b and was at or below b on the previous bar.',
  'buy when sma(50) crosses above sma(200)',
);
word(
  'crosses below',
  'a crosses below b',
  'was at or above, is now below',
  'True on a bar where a is below b and was at or above b on the previous bar.',
  'sell when sma(50) crosses below sma(200)',
);
word('above', 'a above b', 'same as >', 'The same as >. You can also write is above.', 'buy when close above sma(200)');
word('below', 'a below b', 'same as <', 'The same as <. You can also write is below.', 'sell when close below sma(200)');
word(
  'of',
  'value of TICKER',
  "another ticker's value: sma(200) of SPY",
  'Reads a value from another ticker, which does not have to be in the universe. For each bar you get that ticker’s latest bar that had ended by the time this bar ended.',
  'buy when close > sma(200) and close of ^VIX < 25',
);
word(
  'tiingo:',
  'tiingo:TICKER',
  'a ticker from Tiingo, such as tiingo:SPY',
  'Takes this ticker’s daily prices from Tiingo, adjusted for splits and dividends, with the key chosen under Tiingo API key in the plugin settings. Tiingo gives 1d and 1w bars of US stocks, ETFs and funds.',
  'universe: tiingo:SPY',
);
word(
  'fred:',
  'fred:SERIES',
  'an economic series from FRED, such as fred:T10Y2Y',
  'A series from FRED, each value counted from the day it was first published, with the key chosen under FRED API key in the plugin settings. Rules read it with of, as in close of fred:T10Y2Y, and cash rate takes a yield such as fred:DGS3MO, but it cannot be traded or be the benchmark.',
  'buy when close of fred:T10Y2Y > 0',
);
word(
  '[n]',
  'value[n]',
  'the value n bars earlier: close[5]',
  'The value n bars earlier, so close[5] is the close five bars back. It works on any value, and n must be a whole number or a parameter that is one.',
  'buy when close > close[5]',
);
word(
  'in … step',
  'name = 50 in 20..100 step 10',
  'a range to try: 50 in 20..100 step 10',
  'Gives a parameter a range of values worth trying; the block still runs with the value before in, which must lie inside the range. The step is optional and is 1 unless you write it, or 1% for a percentage.',
  'fast = 50 in 20..100 step 10',
);
word(
  'top … by',
  'hold: top 3 by score',
  'hold the 3 tickers with the highest score',
  'Inside hold: how many tickers to hold, and the score that ranks them, written like a value in a rule. The universe must have at least that many tickers.',
  'hold: top 3 by roc(126)',
);
word(
  'at',
  'risk per trade: 1% at 2 atr(14)',
  'share of equity risked at a stop distance',
  'Inside risk per trade: it joins the share of equity at risk to the distance, in average true ranges, that the price is assumed to move against the position.',
  'risk per trade: 1% at 2 atr(14)',
);
word('true', 'true', 'always holds', 'A condition that always holds. always means the same.', 'buy when true');
word('false', 'false', 'never holds', 'A condition that never holds. never means the same.', 'sell when false');
add('unit', '%', '5%', 'a percentage: 5% counts as 0.05', 'A percentage. It counts as the number 0.05 wherever a number is expected, so roc(20) > 5% means roc(20) > 0.05.', 'buy when roc(20) > 5%');
add('unit', 'bps', '5 bps', 'basis points: 100 bps is 1%', 'Basis points: hundredths of a percent, so 100 bps is 1%. In costs and slippage a plain number counts as bps too.', 'costs: 5 bps');

const PERIOD = /^(\d+)([mhdw])$/;
const UNIT_NAME = { m: 'minute', h: 'hour', d: 'day', w: 'week' } as const;
const value = (id: string, short: string, text: string, example: string) => {
  const [key, v] = id.split('=');
  add('value', id, `${key}: ${v}`, short, text, example);
};

value('rebalance=never', 'positions are never put back to their weights', 'Held positions are never put back to their weights. This is the default.', 'rebalance: never');
const PERIODS = { weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year' } as const;
for (const [name, unit] of Object.entries(PERIODS)) {
  value(
    `rebalance=${name}`,
    `back to the weights at the start of each ${unit}`,
    `Each held ticker goes back to its target weight at the open of its first bar in each new ${unit}. ${name === 'weekly' ? 'Weeks start on Monday.' : 'A rebalance never opens a position.'}`,
    `rebalance: ${name}`,
  );
}
value(
  'data=yahoo',
  'Yahoo prices, adjusted for splits and dividends',
  'Plain tickers come from Yahoo, spelt the way Yahoo spells them, such as SPY, BRK-B, BTC-USD or ^GSPC. Yahoo gives 1d and 1w bars.',
  'data: yahoo',
);
value('data=binance', 'Binance market symbols, such as BTCUSDT', 'Plain tickers are Binance market symbols, such as BTCUSDT, though one that starts with ^, such as ^VIX, still comes from Yahoo. Binance gives bars from 1m up to 1w.', 'data: binance');
value(
  'data=tiingo',
  'Tiingo prices, adjusted for splits and dividends',
  'Plain tickers come from Tiingo, with the key chosen under Tiingo API key in the plugin settings, though one that starts with ^, such as ^VIX or the cash rate ^IRX, still comes from Yahoo, which alone has them. Tiingo gives 1d and 1w bars of US stocks, ETFs and funds.',
  'data: tiingo',
);
for (const v of BINANCE_INTERVALS) {
  const [, count, unit] = v.match(PERIOD)!;
  const both = v === '1d' || v === '1w';
  const bars = both ? (v === '1d' ? 'daily' : 'weekly') : `${count}-${UNIT_NAME[unit as keyof typeof UNIT_NAME]}`;
  value(
    `interval=${v}`,
    both ? `${bars} bars` : `${bars} bars, Binance only`,
    both
      ? `${bars[0].toUpperCase()}${bars.slice(1)} bars, from Yahoo, Tiingo or Binance.${v === '1w' ? ' A weekly bar is used once its week is over.' : ''}`
      : `${count}-${UNIT_NAME[unit as keyof typeof UNIT_NAME]} bars. Only Binance gives them, so the block needs data: binance or a binance: ticker.`,
    both ? `interval: ${v}` : `data: binance\ninterval: ${v}`,
  );
}
value('fill=next open', 'a rule read at a close fills at the next open', 'A rule read at a bar’s close fills at that ticker’s next open. This is the default.', 'fill: next open');
value('fill=close', 'a rule read at a close fills at that same close', 'A rule read at a bar’s close fills at that same close.', 'fill: close');

/** Every entry, in the order they are written above. */
export const ALL_DOCS: readonly Doc[] = DOCS;

export function docFor(id: string): Doc | undefined {
  return BY_ID.get(id);
}

/** The one-line description of an entry, for the completion list. */
export function shortOf(id: string): string {
  return BY_ID.get(id)?.short ?? '';
}

export function valueId(setting: string, value: string): string {
  return `${setting.toLowerCase()}=${value.toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

/** A span of a line that has help, and the entry for it. */
export interface HelpTarget {
  from: number;
  to: number;
  doc: Doc;
}

const PARAM_DECL = new RegExp(String.raw`^(${NUM})(?:\s+in\s+(${NUM})\s*\.\.\s*(${NUM})(?:\s+step\s+(${NUM}))?)?$`);

function parameterDoc(name: string, written: string): Doc {
  const m = written.match(PARAM_DECL);
  const signature = `${name} = ${written}`;
  if (!m) return { id: name, kind: 'parameter', signature, short: `parameter: ${written}`, text: 'Your parameter. Its value is not a number yet, so the block cannot use it.', example: '' };
  const percent = [m[1], m[2], m[3], m[4]].some((s) => s?.includes('%'));
  const shown = (s: string) => s.replace(/\s+/g, '');
  const range = m[2] === undefined ? 'with no range' : `with a range of ${shown(m[2])} to ${shown(m[3])} in steps of ${m[4] === undefined ? (percent ? '1%' : '1') : shown(m[4])}`;
  const rule = percent ? ` Inside a rule ${shown(m[1])} counts as the number ${Number(shown(m[1]).replace('%', '')) / 100}.` : '';
  return { id: name, kind: 'parameter', signature, short: `parameter: ${written}`, text: `Your parameter. It is set to ${shown(m[1])}, ${range}.${rule}`, example: '' };
}

function definitionDoc(name: string, written: string): Doc {
  return { id: name, kind: 'definition', signature: `${name} = ${written}`, short: `definition: ${written}`, text: `Your definition. Wherever you write ${name}, it means ${written}.`, example: '' };
}

const WORD_ALIASES: Record<string, string> = {
  bars_held: POSITION.bars_held,
  entry_price: POSITION.entry_price,
  last_entry_price: POSITION.last_entry_price,
  entries_made: POSITION.entries_made,
  highest_since_entry: POSITION.highest_since_entry,
  lowest_since_entry: POSITION.lowest_since_entry,
  position_return: POSITION.position_return,
  always: 'true',
  never: 'false',
};

const spaced = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

/**
 * What the character at column `col` of line `row` of a block means, from the block's tokens: the span
 * it belongs to and its entry. Two-word names (`stop loss`, `bars held`, `crosses above`) are one span.
 */
export function helpAt(lines: string[], row: number, col: number, tokens: Token[][] = tokenizeBlock(lines), kinds: LineKind[] = lineKinds(lines)): HelpTarget | null {
  const line = lines[row];
  if (line === undefined || col < 0 || col >= line.length) return null;
  const kind = kinds[row];
  const toks = tokens[row] ?? [];
  const target = (from: number, to: number, id: string): HelpTarget | null => {
    const doc = BY_ID.get(id);
    return doc ? { from, to, doc } : null;
  };
  const text = (t: Token) => line.slice(t.from, t.to);

  if (kind === 'setting') {
    const colon = line.indexOf(':');
    const key = settingKey(line)!;
    const keyFrom = line.length - line.trimStart().length;
    const keyTo = keyFrom + line.slice(keyFrom, colon).trimEnd().length;
    if (col >= keyFrom && col < keyTo) return target(keyFrom, keyTo, key);
    if (key in FIXED_VALUES && col > colon) {
      const end = commentStart(line);
      const code = line.slice(colon + 1, end < 0 ? line.length : end);
      const from = colon + 1 + (code.length - code.trimStart().length);
      const to = colon + 1 + code.trimEnd().length;
      if (col >= from && col < to) return target(from, to, valueId(key, line.slice(from, to)));
      return null;
    }
  }

  const i = toks.findIndex((t) => t.from <= col && col < t.to);
  if (i < 0) return null;
  const t = toks[i];
  const here = text(t).toLowerCase();

  if (t.kind === 'param' || (t.kind === 'key' && (kind === 'param' || kind === 'define'))) {
    const declared = declaredParams(lines).find((p) => p.name.toLowerCase() === here);
    if (declared) return { from: t.from, to: t.to, doc: parameterDoc(declared.name, declared.value) };
    const defined = declaredDefinitions(lines).find((p) => p.name.toLowerCase() === here);
    return defined ? { from: t.from, to: t.to, doc: definitionDoc(defined.name, defined.value) } : null;
  }

  if (t.kind === 'function') return target(t.from, t.to, here);
  if (t.kind === 'series' && i >= 2 && toks[i - 2].kind === 'function' && text(toks[i - 2]).toLowerCase() === 'column' && text(toks[i - 1]) === '(') return target(t.from, t.to, 'column');
  if (t.kind === 'series') {
    const id = spaced(here);
    return target(t.from, t.to, WORD_ALIASES[id] ?? id);
  }

  const lag = lagSpan(line, toks, i);
  if (lag) return target(lag.from, lag.to, '[n]');

  if (t.kind === 'number') {
    if (/%$/.test(here)) return target(t.from, t.to, '%');
    if (/bps?$/.test(here)) return target(t.from, t.to, 'bps');
    return null;
  }
  if (t.kind === 'operator') return here === '..' ? target(t.from, t.to, 'in … step') : null;
  if (t.kind === 'ticker') {
    const prefix = here.match(SOURCE_PREFIX);
    return prefix && here.length > prefix[0].length ? target(t.from, t.to, prefix[0]) : null;
  }
  if (t.kind === 'value') {
    if (kind === 'setting') return settingKey(line) === 'weighting' ? target(t.from, t.to, 'weighting') : null;
    return target(t.from, t.to, WORD_ALIASES[here] ?? here);
  }
  if (t.kind !== 'keyword') return null;

  const next = toks[i + 1];
  const prev = toks[i - 1];
  const nextWord = next && next.kind === 'keyword' ? text(next).toLowerCase() : '';
  const prevWord = prev && prev.kind === 'keyword' ? text(prev).toLowerCase() : '';
  switch (here) {
    case 'buy':
    case 'sell':
    case 'add':
    case 'short':
    case 'cover':
      return next && nextWord === 'when' ? target(t.from, next.to, `${here} when`) : null;
    case 'when':
      return prev && RULE_HEADS.includes(prevWord) ? target(prev.from, t.to, `${prevWord} when`) : null;
    case 'for':
      if (kind !== 'for') return target(t.from, t.to, 'for … bars');
      return next && text(next).toLowerCase() === 'all' ? target(t.from, next.to, 'for all') : target(t.from, t.to, 'for');
    case 'all':
      return kind === 'for' && prev ? target(prev.from, t.to, 'for all') : null;
    case 'crosses':
      return nextWord === 'above' || nextWord === 'below' ? target(t.from, next!.to, `crosses ${nextWord}`) : target(t.from, t.to, 'crosses');
    case 'above':
    case 'below':
      return prevWord === 'crosses' ? target(prev!.from, t.to, `crosses ${here}`) : prevWord === 'is' ? target(prev!.from, t.to, here) : target(t.from, t.to, here);
    case 'is':
      return nextWord === 'above' || nextWord === 'below' ? target(t.from, next!.to, nextWord) : null;
    case 'in':
    case 'step':
      return kind === 'param' ? target(t.from, t.to, 'in … step') : null;
    case 'top':
    case 'by':
      return target(t.from, t.to, 'top … by');
    default:
      return target(t.from, t.to, here);
  }
}

/** The `[` ... `]` around token `i`, when it sits between them or is one of them. */
function lagSpan(line: string, toks: Token[], i: number): { from: number; to: number } | null {
  const is = (k: number, c: string) => toks[k].kind === 'operator' && line.slice(toks[k].from, toks[k].to) === c;
  let open = -1;
  for (let k = i; k >= 0 && open < 0; k--) {
    if (is(k, '[')) open = k;
    else if (is(k, ']') && k < i) return null;
  }
  for (let k = Math.max(open, i); open >= 0 && k < toks.length; k++) {
    if (is(k, ']')) return { from: toks[open].from, to: toks[k].to };
    if (is(k, '[') && k > open) return null;
  }
  return null;
}
