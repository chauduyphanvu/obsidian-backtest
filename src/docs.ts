import { BINANCE_INTERVALS, CALENDAR, INDICATORS, POSITION, REBALANCE, SERIES } from './dsl.ts';
import { commentStart, declaredParams, lineKinds, settingKey, tokenizeBlock, type LineKind, type Token } from './highlight.ts';

export type DocKind = 'setting' | 'value' | 'function' | 'series' | 'calendar' | 'position' | 'word' | 'unit' | 'parameter';

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
  data: ['yahoo', 'binance'],
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
  'The tickers to trade, each with an optional weight: give every ticker one, or none. Weights add up to at most 100%, and what is left stays in cash.',
  'universe: SPY 60%, TLT 40%',
);
setting('symbol', 'symbol: SPY', 'one ticker (same as universe)', 'Another way to write universe.', 'symbol: SPY');
setting('from', 'from: 2015-01-31', 'first day, as 2015-01-31', 'The first day of the run. Without it the run starts on the first day every ticker has prices.', 'from: 2015-01-31');
setting('to', 'to: 2024-12-31', 'last day, as 2024-12-31', 'The last day of the run, whole day included, and it must come after from. Without it the run ends on the last day with prices.', 'to: 2024-12-31');
setting(
  'data',
  'data: yahoo | binance',
  'where plain tickers come from: yahoo or binance',
  'Where tickers written without a prefix come from. Without it the plugin setting decides, and yahoo:, binance: or csv: in front of a ticker picks that ticker’s own source.',
  'data: binance',
);
setting(
  'interval',
  'interval: 1d | 1w | …',
  'bar size: 1d, 1w, or 1h and others on Binance',
  'The bar size, 1d unless you say otherwise. Yahoo gives 1d and 1w, Binance gives 1m up to 1w, and one interval applies to every ticker.',
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
  'How much worse each fill is than the price: a buy fills higher and a sell lower. It is written like costs.',
  'slippage: 5 bps',
);
setting('size', 'size: 80%', 'share of equity to use when tickers have no weights', 'The share of equity to use when the tickers have no weights, up to 100%. You cannot give weights and size together.', 'size: 80%');
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
  'sell this far below the entry price, as 10% or 2 atr(14)',
  'Sells when the price falls this far below the entry price, as a percentage or as a number of average true ranges. A percentage must be above 0% and at most 99%.',
  'stop loss: 10%',
);
setting(
  'trailing stop',
  'trailing stop: 15% | 3 atr(14)',
  'sell this far below the highest price since entry',
  'Sells when the price falls this far below the highest price since entry. A percentage must be above 0% and at most 99%.',
  'trailing stop: 15%',
);
setting(
  'take profit',
  'take profit: 20% | 4 atr(14)',
  'sell this far above the entry price',
  'Sells when the price rises this far above the entry price. A percentage must be above 0% and at most 1000%.',
  'take profit: 20%',
);
setting(
  'cash rate',
  'cash rate: 4% | ^IRX',
  'what cash earns: 4% a year, or a yield ticker such as ^IRX',
  'What cash earns a year, written 4%, or a ticker whose close is a yearly yield, such as ^IRX. A rate needs its percent sign and must be at most 50%.',
  'cash rate: 4%',
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
  'size each buy by what it risks: 1% at 2 atr(14)',
  'Sizes each buy so that a fall of that many average true ranges loses that share of equity, up to the ticker’s weight. It cannot be used with weighting, or with a rebalance other than never.',
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

/** Names of a function's arguments, in the order INDICATORS lists their defaults. */
const ARGUMENTS: Record<string, string[]> = {
  sma: ['n'],
  ema: ['n'],
  rsi: ['n'],
  roc: ['n'],
  stdev: ['n'],
  highest: ['n'],
  lowest: ['n'],
  atr: ['n'],
  macd: ['fast', 'slow'],
  macd_signal: ['fast', 'slow', 'signal'],
  bb_upper: ['n', 'width'],
  bb_lower: ['n', 'width'],
  stoch_k: ['n', 'smooth'],
  stoch_d: ['n', 'smooth', 'd'],
  adx: ['n'],
  plus_di: ['n'],
  minus_di: ['n'],
  cci: ['n'],
  williams_r: ['n'],
  mfi: ['n'],
  obv: [],
  vwap: ['n'],
  keltner_upper: ['n', 'width', 'atr'],
  keltner_lower: ['n', 'width', 'atr'],
  supertrend: ['n', 'mult'],
  supertrend_up: ['n', 'mult'],
  wma: ['n'],
  hma: ['n'],
  median: ['n'],
  zscore: ['n'],
  percent_rank: ['n'],
  slope: ['n'],
  correl: ['n'],
  bars_since: [],
};

const FUNCTION_TEXT: Record<string, [string, string]> = {
  sma: ['simple average of the last n closes', 'Simple average of the last n closes.'],
  ema: ['exponential average', 'Exponential average, started from the simple average of the first n values.'],
  rsi: ['relative strength index, 0 to 100', 'Relative strength index, from 0 to 100, with Wilder’s smoothing.'],
  roc: ['change over n bars, as a fraction', 'Change over n bars, as a fraction, so compare it with a percentage: roc(20) > 5%.'],
  stdev: ['standard deviation of the last n closes', 'Standard deviation of the last n closes, dividing by n.'],
  highest: ['highest high of the last n bars; add [1] to leave out this bar', 'Highest high of the last n bars, this bar included; add [1] to leave out this bar.'],
  lowest: ['lowest low of the last n bars', 'Lowest low of the last n bars, this bar included.'],
  atr: ['average true range', 'Average true range, with Wilder’s smoothing.'],
  macd: ['fast average minus slow average', 'The fast exponential average minus the slow one.'],
  macd_signal: ['average of the macd line', 'Exponential average of the macd line over signal bars.'],
  bb_upper: ['upper Bollinger band', 'Upper Bollinger band: the average plus width standard deviations.'],
  bb_lower: ['lower Bollinger band', 'Lower Bollinger band: the average minus width standard deviations.'],
  stoch_k: [
    'stochastic %K, 0 to 100',
    'Stochastic %K, from 0 to 100: where the close sits between the lowest low and the highest high of the last n bars, averaged over smooth bars (1 for no averaging).',
  ],
  stoch_d: ['stochastic %D: stoch_k averaged over d bars', 'Stochastic %D: stoch_k, with the same n and smooth, averaged over d more bars.'],
  adx: [
    'average directional index, 0 to 100',
    'Wilder’s average directional index, from 0 to 100: how strong the trend is, whichever way, as the n-bar Wilder average of 100 * |plus_di - minus_di| / (plus_di + minus_di).',
  ],
  plus_di: [
    'plus directional indicator, 0 to 100',
    'Wilder’s plus directional indicator, from 0 to 100: the Wilder average over n bars of upward movement, divided by that of the true range, times 100.',
  ],
  minus_di: [
    'minus directional indicator, 0 to 100',
    'Wilder’s minus directional indicator, from 0 to 100: the Wilder average over n bars of downward movement, divided by that of the true range, times 100.',
  ],
  cci: [
    'commodity channel index of the typical price',
    'Commodity channel index: the typical price (high + low + close) / 3 minus its n-bar average, divided by 0.015 times its mean absolute deviation from that average.',
  ],
  williams_r: [
    'Williams %R, -100 to 0',
    'Williams %R, from -100 to 0: -100 * (highest high - close) / (highest high - lowest low) over the last n bars.',
  ],
  mfi: [
    'money flow index, 0 to 100',
    'Money flow index, from 0 to 100: 100 - 100 / (1 + money flowing in / money flowing out) over the last n bars, where a bar’s flow is its typical price times its volume, counted in when the typical price rose and out when it fell.',
  ],
  obv: [
    'on-balance volume, a running total',
    'On-balance volume: a running total that adds a bar’s volume when the close rose and takes it off when it fell, starting at 0 on the first bar.',
  ],
  vwap: ['volume-weighted average price of the last n bars', 'Volume-weighted average of the typical price (high + low + close) / 3 over the last n bars.'],
  keltner_upper: [
    'upper Keltner channel',
    'Upper Keltner channel: the n-bar exponential average plus width times the average true range over atr bars, which is read from the ticker’s own bars.',
  ],
  keltner_lower: [
    'lower Keltner channel',
    'Lower Keltner channel: the n-bar exponential average minus width times the average true range over atr bars, which is read from the ticker’s own bars.',
  ],
  supertrend: [
    'supertrend line, under the price in an uptrend',
    'Supertrend line: bands at (high + low) / 2 plus and minus mult average true ranges over n bars, each moving only towards the price until the close crosses it, the lower band in an uptrend and the upper in a downtrend.',
  ],
  supertrend_up: ['condition: the supertrend is in an uptrend', 'A condition that is true while the supertrend is in an uptrend, with its line under the price, and false in a downtrend.'],
  wma: ['weighted average of the last n values', 'Linearly weighted average of the last n values, the newest weighing n and the oldest 1.'],
  hma: [
    'Hull moving average',
    'Hull moving average: the weighted average over sqrt(n) bars of twice the weighted average over n / 2 bars minus the one over n bars, with n / 2 and sqrt(n) rounded down.',
  ],
  median: ['median of the last n values', 'Median of the last n values, the mean of the two middle ones when n is even.'],
  zscore: [
    'standard deviations from the n-bar average',
    'How many standard deviations the value is from its average over the last n values, dividing by n as stdev does, and unknown when they are all equal.',
  ],
  percent_rank: ['share of the previous n values below this one', 'The share of the previous n values that are below this one, from 0 to 100.'],
  slope: ['least-squares slope over n bars, per bar', 'Slope of the least-squares line through the last n values, in the series’ units per bar.'],
  correl: [
    'correlation with another ticker, -1 to 1',
    'Correlation, from -1 to 1, of the one-bar changes of this ticker’s close and of the series written first, over the last n bars, unknown when either one is constant.',
  ],
  bars_since: ['bars since a condition was last true', 'Bars since the condition was last true: 0 on a bar where it is, and unknown until it has been true.'],
};

/** What a function's text says about the series it reads, where the usual sentence is not the whole story. */
const SERIES_TEXT: Record<string, string> = {
  mfi: 'It takes no series and needs volume.',
  obv: 'It takes no series and needs volume.',
  vwap: 'It takes no series and needs volume.',
  correl: 'It reads close for this ticker; the series written first is read as of reads it, so it lines up with this ticker’s bars.',
  bars_since: 'It takes no series, only a condition.',
};

const FUNCTION_EXAMPLE: Record<string, string> = {
  sma: 'buy when close > sma(200)',
  ema: 'buy when close > ema(50)',
  rsi: 'buy when rsi(14) < 30',
  roc: 'buy when roc(20) > 5%',
  stdev: 'buy when close > sma(20) + stdev(20)',
  highest: 'buy when close > highest(20)[1]',
  lowest: 'sell when close < lowest(20)[1]',
  atr: 'buy when close > close[1] + atr(14)',
  macd: 'buy when macd() > 0',
  macd_signal: 'buy when macd() crosses above macd_signal()',
  bb_upper: 'buy when close > bb_upper(20, 2)',
  bb_lower: 'buy when close < bb_lower(20, 2)',
  stoch_k: 'buy when stoch_k(14, 3) < 20',
  stoch_d: 'buy when stoch_k() crosses above stoch_d()',
  adx: 'buy when adx(14) > 25 and plus_di(14) > minus_di(14)',
  plus_di: 'buy when plus_di(14) > minus_di(14)',
  minus_di: 'sell when minus_di(14) > plus_di(14)',
  cci: 'buy when cci(20) < -100',
  williams_r: 'buy when williams_r(14) < -80',
  mfi: 'buy when mfi(14) < 20',
  obv: 'buy when obv() > sma(obv(), 20)',
  vwap: 'buy when close > vwap(20)',
  keltner_upper: 'buy when close > keltner_upper(20, 2, 10)',
  keltner_lower: 'buy when close < keltner_lower(20, 2, 10)',
  supertrend: 'buy when close > supertrend(10, 3)',
  supertrend_up: 'buy when supertrend_up(10, 3)',
  wma: 'buy when close > wma(20)',
  hma: 'buy when close > hma(21)',
  median: 'buy when close > median(20)',
  zscore: 'buy when zscore(20) < -2',
  percent_rank: 'buy when percent_rank(100) > 95',
  slope: 'buy when slope(90) / close > 0.1%',
  correl: 'buy when correl(close of SPY, 60) < 0.5',
  bars_since: 'buy when bars_since(close crosses above sma(50)) < 10',
};

/** The call as written, with each default from INDICATORS: `rsi(n = 14)`, `sma(n)`, and a leading series or condition where the function needs one. */
export function functionSignature(name: string): string {
  const def = INDICATORS[name];
  const names = ARGUMENTS[name];
  const lead = def.lead === 'series' ? ['other'] : def.lead === 'condition' ? ['condition'] : [];
  return `${name}(${[...lead, ...def.params.map((d, i) => (d === null ? names[i] : `${names[i]} = ${d}`))].join(', ')})`;
}

for (const name of Object.keys(INDICATORS)) {
  const def = INDICATORS[name];
  const [short, meaning] = FUNCTION_TEXT[name];
  const sample = `${name}(volume, ${def.params.map((d) => d ?? 20).join(', ')})`;
  const series = SERIES_TEXT[name] ?? (def.src === null ? 'It takes no series.' : `Without a series it reads ${def.src}; write another first, as in ${sample}.`);
  add('function', name, functionSignature(name), short, `${meaning} ${series}`, FUNCTION_EXAMPLE[name]);
}
add('function', 'min', 'min(a, b)', 'the smaller value', 'The smaller of two values.', 'buy when close > min(sma(20), sma(50))');
add('function', 'max', 'max(a, b)', 'the larger value', 'The larger of two values.', 'buy when close > max(sma(20), sma(50))');
add('function', 'abs', 'abs(x)', 'value without its sign', 'The value without its sign.', 'buy when abs(close - open) > atr(14)');

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

const BELONGS = 'Only sell and add rules can read it, and not inside a function, with [n] or with of.';
add(
  'position',
  POSITION.bars_held,
  'bars held',
  'completed bars since the buy filled, 0 on that bar',
  `The number of completed bars since the buy filled, or with several entries the first; it is 0 on the bar of the fill. ${BELONGS}`,
  'sell when bars held >= 20',
);
add(
  'position',
  POSITION.entry_price,
  'entry price',
  'the price the position was bought at',
  `The price the position was bought at, slippage included, or with several entries their average price. ${BELONGS}`,
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
  `How many entries the open position has made: 1 after the buy, then one more for each add. ${BELONGS}`,
  'sell when entries made == 1 and bars held >= 10',
);

word(
  'buy when',
  'buy when condition',
  'condition that opens a position',
  'Opens a position in a ticker you do not hold when the condition is true at a close. It fills at that ticker’s next open, unless the fill setting says close.',
  'buy when close > sma(200)',
);
word(
  'sell when',
  'sell when condition',
  'condition that closes it',
  'Closes the position when the condition is true at a close. Without a sell rule a position is held until a stop closes it or the run ends.',
  'sell when close < sma(200)',
);
word(
  'add when',
  'add when condition',
  'condition that adds the next entry',
  'Adds the next entry to a position held when the condition is true at a close, until the entries setting’s count is made. It needs an entries line, and it is skipped at a close where the sell rule holds.',
  'entries: 3\nadd when close > last entry price * 1.03',
);
word(
  'for',
  'for TICKER:',
  'rules and stops for one ticker: for TLT:',
  'Starts rules for one ticker, which must be in the universe. A buy or sell rule, stop loss, trailing stop or take profit written below it replaces the shared one for that ticker only.',
  'for TLT:',
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
word('at', 'risk per trade: 1% at 2 atr(14)', 'share of equity risked at a stop distance', 'Inside risk per trade: it joins the share of equity at risk to the distance, in average true ranges, that the price is assumed to fall.', 'risk per trade: 1% at 2 atr(14)');
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
value('data=binance', 'Binance market symbols, such as BTCUSDT', 'Plain tickers are Binance market symbols, such as BTCUSDT. Binance gives bars from 1m up to 1w.', 'data: binance');
for (const v of BINANCE_INTERVALS) {
  const [, count, unit] = v.match(PERIOD)!;
  const both = v === '1d' || v === '1w';
  const bars = both ? (v === '1d' ? 'daily' : 'weekly') : `${count}-${UNIT_NAME[unit as keyof typeof UNIT_NAME]}`;
  value(
    `interval=${v}`,
    both ? `${bars} bars` : `${bars} bars, Binance only`,
    both
      ? `${bars[0].toUpperCase()}${bars.slice(1)} bars, from Yahoo or Binance.${v === '1w' ? ' A weekly bar is used once its week is over.' : ''}`
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

const NUM = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*%)?`;
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

const WORD_ALIASES: Record<string, string> = {
  bars_held: POSITION.bars_held,
  entry_price: POSITION.entry_price,
  last_entry_price: POSITION.last_entry_price,
  entries_made: POSITION.entries_made,
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

  if (t.kind === 'param' || (t.kind === 'key' && kind === 'param')) {
    const declared = declaredParams(lines).find((p) => p.name.toLowerCase() === here);
    if (!declared) return null;
    const doc = parameterDoc(declared.name, declared.value);
    return { from: t.from, to: t.to, doc };
  }

  if (t.kind === 'function') return target(t.from, t.to, here);
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
      return next && nextWord === 'when' ? target(t.from, next.to, `${here} when`) : null;
    case 'when':
      return prev && (prevWord === 'buy' || prevWord === 'sell') ? target(prev.from, t.to, `${prevWord} when`) : null;
    case 'for':
      return kind === 'for' && next && text(next).toLowerCase() === 'all' ? target(t.from, next.to, 'for all') : target(t.from, t.to, 'for');
    case 'all':
      return kind === 'for' && prev ? target(prev.from, t.to, 'for all') : null;
    case 'crosses':
      return nextWord === 'above' || nextWord === 'below' ? target(t.from, next!.to, `crosses ${nextWord}`) : null;
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
