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

setting('name', 'name: text', 'title shown above the result', 'The title shown above the result. Without it, the title is Backtest.', 'name: Trend following');
setting(
  'universe',
  'universe: SPY 60%, TLT 40%',
  'tickers and weights: SPY 60%, TLT 40%',
  'The tickers to trade, each with an optional weight: give a weight to all tickers or to none. The maximum total weight is 200%: below 100%, the remaining weight stays in cash, and above 100%, the strategy borrows.',
  'universe: SPY 60%, TLT 40%',
);
setting('symbol', 'symbol: SPY', 'one ticker (same as universe)', 'The same as universe.', 'symbol: SPY');
setting('from', 'from: 2015-01-31', 'first day, as 2015-01-31', 'The first day of the run. Without it, the run starts on the first day that all tickers have prices.', 'from: 2015-01-31');
setting('to', 'to: 2024-12-31', 'last day, as 2024-12-31', 'The last day of the run, all of that day included, and it must be after from. Without it, the run ends on the last day with prices.', 'to: 2024-12-31');
setting(
  'data',
  'data: yahoo | binance | tiingo',
  'where tickers without a prefix come from: yahoo, binance or tiingo',
  'The source of tickers without a prefix (if there is no data line, the plugin setting is the source). A ticker that starts with ^ always comes from Yahoo, and a prefix (yahoo:, binance:, tiingo:, fred: or csv:) sets the source of one ticker.',
  'data: binance',
);
setting(
  'interval',
  'interval: 1d | 1w | …',
  'bar size: 1d, 1w, or 1h and others on Binance',
  'The bar size for all tickers, 1d if you do not write it. Yahoo and Tiingo give 1d and 1w bars, and Binance gives bars from 1m to 1w.',
  'interval: 1w',
);
setting('capital', 'capital: 10000', 'capital at the start, as 10000 or 10k', 'The capital at the start of the run, as 10000 or 10k (m is millions). Without it, the plugin uses its Start capital setting.', 'capital: 10k');
setting(
  'costs',
  'costs: 5 bps',
  'cost of each trade, as 5 bps or 0.05%',
  'The cost of each trade, as 5 bps or 0.05%. A number without a unit counts as bps, and the cost must be less than 10%.',
  'costs: 5 bps',
);
setting(
  'slippage',
  'slippage: 5 bps',
  'how much worse each fill is than the price, as 5 bps',
  'How much worse each fill is than the price: a buy or a cover fills higher, and a sell or a short sale fills lower. Write it as you write costs.',
  'slippage: 5 bps',
);
setting(
  'size',
  'size: 80%',
  'share of equity to use when tickers have no weights',
  'The share of equity to use when the tickers have no weights, a maximum of 200%: above 100%, the strategy borrows. You cannot use weights and size together.',
  'size: 80%',
);
setting(
  'rebalance',
  'rebalance: never | weekly | monthly | quarterly | yearly',
  'never, weekly, monthly, quarterly or yearly',
  'How frequently the strategy sets the held tickers back to their weights. Without it, the value is never.',
  'rebalance: monthly',
);
setting(
  'benchmark',
  'benchmark: QQQ',
  'ticker to compare with, bought and held',
  'The ticker to compare the result with, bought and held. Without it, the benchmark is the tickers of the block at their weights.',
  'benchmark: QQQ',
);
setting(
  'stop loss',
  'stop loss: 10% | 2 atr(14)',
  'sell this far below the entry price (above it for a short), as 10% or 2 atr(14)',
  'Sells when the price moves this far below the entry price, or covers a short when the price moves this far above it. Write a percentage, more than 0% and a maximum of 99%, or a number of average true ranges.',
  'stop loss: 10%',
);
setting(
  'trailing stop',
  'trailing stop: 15% | 3 atr(14)',
  'sell this far below the highest price since entry (above the lowest for a short)',
  'Sells when the price moves this far below the highest price since entry, or covers a short when it moves this far above the lowest. A percentage must be more than 0% and a maximum of 99%.',
  'trailing stop: 15%',
);
setting(
  'take profit',
  'take profit: 20% | 4 atr(14)',
  'sell this far above the entry price (below it for a short)',
  'Sells when the price moves this far above the entry price, or covers a short when it moves this far below it. A percentage must be more than 0% and a maximum of 1000%, and for a short, a take profit of 100% or more cannot occur.',
  'take profit: 20%',
);
setting(
  'cash rate',
  'cash rate: 4% | ^IRX',
  'interest on cash: 4% a year, or a yield ticker, for example ^IRX',
  'The yearly interest on cash: a rate, as 4%, or a ticker with a yearly yield as its close, for example ^IRX or fred:DGS3MO. A rate must have its percent sign, and the maximum is 50%.',
  'cash rate: 4%',
);
setting(
  'borrow fee',
  'borrow fee: 0.5%',
  'yearly fee on the value of short positions, default 0.5%',
  'A yearly fee on the value of each short position at the close, for each day of the position, included in the trade’s return. Without it, the plugin uses its Borrow fee for shorts setting (default 0.5%), and the fee must be between 0% and 100%.',
  'borrow fee: 1%',
);
setting(
  'margin rate',
  'margin rate: 6%',
  'yearly interest on borrowed money, default 6%',
  'Yearly interest on borrowed money: the strategy pays it between two bars when cash minus the shorts is less than 0, for example with leverage. Without it, the plugin uses its Interest on borrowed money setting (default 6%), and the rate must be between 0% and 50%.',
  'margin rate: 7%',
);
setting(
  'test from',
  'test from: 2019-01-01',
  'show results before this day and from this day apart',
  'Shows the results before this day and from this day apart. It is one run, divided in two with no new fit, and the day must be after from and before to.',
  'test from: 2019-01-01',
);
setting(
  'hold',
  'hold: top 3 by roc(126)',
  'hold only the tickers with the highest score: top 3 by roc(126)',
  'Holds only the tickers with the highest score, for example the top 3 by roc(126). Write the score as a value in a rule, and give no weights in the universe.',
  'hold: top 3 by roc(126)',
);
setting(
  'weighting',
  'weighting: inverse volatility(60)',
  'inverse volatility(60): less volatility, more weight',
  'Tickers with less volatility receive more weight: each weight is in proportion to 1 divided by the volatility of the last n one-bar returns. The minimum period is 2.',
  'weighting: inverse volatility(60)',
);
setting(
  'risk per trade',
  'risk per trade: 1% at 2 atr(14)',
  'size each buy or short sale by its risk: 1% at 2 atr(14)',
  'Sizes each buy or short sale: a move of that many average true ranges against it costs that share of equity (maximum: the ticker’s weight). You cannot use it with weighting, or with a rebalance other than never.',
  'risk per trade: 1% at 2 atr(14)',
);
setting(
  'fill',
  'fill: next open | close',
  'when orders fill: at the next open, or at the same close',
  'When the orders from the rules fill. With next open (the default), an order at the close of a bar fills at the next open, and with close, at that close.',
  'fill: close',
);
setting(
  'commission',
  'commission: 1 | 0.005 per share, min 1, max 1%',
  'charge for each order: 1, or 0.005 per share, min 1, max 1%',
  'A charge in the account currency: a constant value for each order, or a value per share with an optional minimum and maximum. The plugin adds it to costs, the maximum is a percentage of the order value, and without it, the plugin setting (default none) applies.',
  'commission: 0.005 per share, min 1',
);
setting(
  'entries',
  'entries: 3',
  'open each position in a maximum of 3 entries, one third each',
  'Opens each position in a maximum of that many equal entries: the buy rule makes the first, and the add rule makes the others. It must have an add rule, and the entries together are not more than the ticker’s weight.',
  'entries: 3\nadd when close > last entry price * 1.03',
);
setting(
  'magnify',
  'magnify: 1h',
  'read stops and targets on 1h bars in each bar',
  'Reads stops and targets on smaller bars in each bar to find which one the price touches first, but rules use the strategy bars. Yahoo gives 2m to 1h bars in daily bars for the last 60 days (730 for 1h), and 1d bars in weekly bars.',
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
    text: 'Exponential average that starts from the simple average of the first n values.',
    example: 'buy when close > ema(50)',
  },
  rsi: {
    args: ['n'],
    short: 'relative strength index, 0 to 100',
    text: 'Relative strength index, 0 to 100, from Wilder averages of the up and down changes.',
    example: 'buy when rsi(14) < 30',
  },
  roc: {
    args: ['n'],
    short: 'change in n bars, as a fraction',
    text: 'Change in n bars, as a fraction: compare it with a percentage, as in roc(20) > 5%.',
    example: 'buy when roc(20) > 5%',
  },
  stdev: {
    args: ['n'],
    short: 'standard deviation of the last n closes',
    text: 'Standard deviation of the last n closes, with division by n.',
    example: 'buy when close > sma(20) + stdev(20)',
  },
  highest: {
    args: ['n'],
    short: 'highest high of the last n bars (add [1] to remove this bar)',
    text: 'Highest high of the last n bars, this bar included (add [1] to remove this bar).',
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
    text: 'Average true range, as a Wilder average.',
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
    text: 'Exponential average of the macd line, with a period of signal bars.',
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
    text: 'Stochastic %K, 0 to 100: where the close is in the high-low range of the last n bars, averaged across smooth bars (1 for none).',
    example: 'buy when stoch_k(14, 3) < 20',
  },
  stoch_d: {
    args: ['n', 'smooth', 'd'],
    short: 'stochastic %D: the d-bar average of stoch_k',
    text: 'Stochastic %D: the d-bar average of stoch_k, with the same n and smooth.',
    example: 'buy when stoch_k() crosses above stoch_d()',
  },
  adx: {
    args: ['n'],
    short: 'average directional index, 0 to 100',
    text: 'Average directional index, 0 to 100: the strength of the trend, up or down, as the n-bar Wilder average of 100 * |plus_di - minus_di| / (plus_di + minus_di).',
    example: 'buy when adx(14) > 25 and plus_di(14) > minus_di(14)',
  },
  plus_di: {
    args: ['n'],
    short: 'plus directional indicator, 0 to 100',
    text: 'Plus directional indicator, 0 to 100: 100 times the n-bar Wilder average of the up movement, divided by that of the true range.',
    example: 'buy when plus_di(14) > minus_di(14)',
  },
  minus_di: {
    args: ['n'],
    short: 'minus directional indicator, 0 to 100',
    text: 'Minus directional indicator, 0 to 100: 100 times the n-bar Wilder average of the down movement, divided by that of the true range.',
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
    text: 'Williams %R, from -100 to 0: -100 * (highest high - close) / (highest high - lowest low) of the last n bars.',
    example: 'buy when williams_r(14) < -80',
  },
  mfi: {
    args: ['n'],
    short: 'money flow index, 0 to 100',
    text: 'Money flow index, 0 to 100: 100 - 100 / (1 + up flow / down flow) of the last n bars, with flow = typical price * volume.',
    example: 'buy when mfi(14) < 20',
    series: 'It has no series argument, the ticker must have volume, and the flow of a bar is up when its typical price increased.',
  },
  obv: {
    args: [],
    short: 'on-balance volume, a total of volume',
    text: 'On-balance volume: a total, 0 on the first bar, that adds the bar volume when the close increases and subtracts it when the close decreases.',
    example: 'buy when obv() > sma(obv(), 20)',
    series: 'It has no series argument, and the ticker must have volume.',
  },
  vwap: {
    args: ['n'],
    short: 'volume-weighted average price of the last n bars',
    text: 'Volume-weighted average of the typical price (high + low + close) / 3 of the last n bars.',
    example: 'buy when close > vwap(20)',
    series: 'It has no series argument, and the ticker must have volume.',
  },
  keltner_upper: {
    args: ['n', 'width', 'atr'],
    short: 'upper Keltner channel',
    text: 'Upper Keltner channel: the n-bar exponential average plus width times the average true range of the last atr bars of the ticker.',
    example: 'buy when close > keltner_upper(20, 2, 10)',
  },
  keltner_lower: {
    args: ['n', 'width', 'atr'],
    short: 'lower Keltner channel',
    text: 'Lower Keltner channel: the n-bar exponential average minus width times the average true range of the last atr bars of the ticker.',
    example: 'buy when close < keltner_lower(20, 2, 10)',
  },
  supertrend: {
    args: ['n', 'mult'],
    short: 'supertrend line, below the price in an uptrend',
    text: 'Supertrend line: the lower band in an uptrend, the upper in a downtrend, at (high + low) / 2 minus or plus mult n-bar average true ranges.',
    series: 'It has no series argument, and a band only moves nearer to the price until the close crosses it.',
    example: 'buy when close > supertrend(10, 3)',
  },
  supertrend_up: {
    args: ['n', 'mult'],
    short: 'condition: the supertrend is in an uptrend',
    text: 'A condition: true when the supertrend is in an uptrend (its line is below the price), and false in a downtrend.',
    example: 'buy when supertrend_up(10, 3)',
  },
  wma: {
    args: ['n'],
    short: 'weighted average of the last n values',
    text: 'Linear weighted average of the last n values: the newest value has the weight n, and each bar before it has 1 less.',
    example: 'buy when close > wma(20)',
  },
  hma: {
    args: ['n'],
    short: 'Hull moving average',
    text: 'Hull moving average: the sqrt(n)-bar weighted average of twice the (n / 2)-bar weighted average minus the n-bar one, with n / 2 and sqrt(n) rounded down.',
    example: 'buy when close > hma(21)',
  },
  median: {
    args: ['n'],
    short: 'median of the last n values',
    text: 'Median of the last n values: for an even n, the average of the two middle values.',
    example: 'buy when close > median(20)',
  },
  zscore: {
    args: ['n'],
    short: 'standard deviations from the n-bar average',
    text: 'How many standard deviations the value is from the average of the last n values, with stdev (division by n), unknown when all are equal.',
    example: 'buy when zscore(20) < -2',
  },
  percent_rank: {
    args: ['n'],
    short: 'percentage of the previous n values less than this one',
    text: 'The percentage of the previous n values that are less than this value, from 0 to 100.',
    example: 'buy when percent_rank(100) > 95',
  },
  slope: {
    args: ['n'],
    short: 'least-squares slope of n bars, per bar',
    text: 'Slope of the least-squares line through the last n values, in the units of the series per bar.',
    example: 'buy when slope(90) / close > 0.1%',
  },
  correl: {
    args: ['n'],
    short: 'correlation with a different ticker, -1 to 1',
    text: 'Correlation (-1 to 1) of the last n one-bar changes of the first series and this ticker’s close, unknown if one is constant.',
    example: 'buy when correl(close of SPY, 60) < 0.5',
    series: 'It reads close for this ticker, and the series you write first as of reads it, aligned with the bars of this ticker.',
  },
  count: {
    args: ['n'],
    short: 'how many of the last n bars a condition held',
    text: 'How many of the last n bars the condition held on, this bar included, unknown while one of them is unknown.',
    example: 'buy when count(close > close[1], 10) >= 7',
    series: 'It has no series argument, only a condition.',
  },
  bars_since: {
    args: [],
    short: 'bars since a condition was last true',
    text: 'Bars since the condition was last true: 0 on a bar where it is true, and unknown until it is true for the first time.',
    example: 'buy when bars_since(close crosses above sma(50)) < 10',
    series: 'It has no series argument, only a condition.',
  },
  sum: {
    args: ['n'],
    short: 'sum of the last n values',
    text: 'Sum of the last n values.',
    example: 'buy when sum(volume, 5) > 5 * sma(volume, 50)',
  },
  dema: {
    args: ['n'],
    short: 'double exponential average, less lag than ema',
    text: 'Double exponential average, 2 * e1 - e2, with e1 = ema(n) and e2 the n-bar ema of e1: it has less lag than ema.',
    example: 'buy when close > dema(50)',
  },
  tema: {
    args: ['n'],
    short: 'triple exponential average, less lag than ema',
    text: 'Triple exponential average, 3 * e1 - 3 * e2 + e3, with e1 = ema(n), e2 = ema of e1 and e3 = ema of e2 (n bars each): less lag than dema.',
    example: 'buy when close > tema(30)',
  },
  kama: {
    args: ['n', 'fast', 'slow'],
    short: 'Kaufman adaptive average: fast in a trend, slow in a range',
    text: 'Kaufman adaptive average: on each bar it moves sc = (ER * (2 / (fast + 1) - 2 / (slow + 1)) + 2 / (slow + 1)) squared of the distance to the price, with ER the n-bar efficiency ratio.',
    series: 'It reads close, or the series you write first, and starts from the value of the bar before the first known ER.',
    example: 'buy when close > kama(10, 2, 30)',
  },
  aroon_up: {
    args: ['n'],
    short: 'aroon up, 0 to 100: 100 on the bar of the high',
    text: 'Aroon up, 0 to 100: 100 * (n - bars since the highest high of the last n + 1 bars) / n, with the newest of equal highs.',
    example: 'buy when aroon_up(25) > 70 and aroon_down(25) < 30',
    series: 'It has no series argument and reads the highs of the ticker.',
  },
  aroon_down: {
    args: ['n'],
    short: 'aroon down, 0 to 100: 100 on the bar of the low',
    text: 'Aroon down, 0 to 100: 100 * (n - bars since the lowest low of the last n + 1 bars) / n, with the newest of equal lows.',
    example: 'sell when aroon_down(25) > 70',
    series: 'It has no series argument and reads the lows of the ticker.',
  },
  psar: {
    args: ['step', 'max'],
    short: 'parabolic SAR, a stop below the price in an uptrend',
    text: 'Parabolic SAR, a stop below the lows in an uptrend and above the highs in a downtrend: a bar across it changes the trend, and the first trend is up if the second close is higher.',
    example: 'buy when close crosses above psar()',
    series: 'It has no series argument, and its speed increases by step at each new high or low, from step to max (step cannot be more than max).',
  },
  cmf: {
    args: ['n'],
    short: 'Chaikin money flow, -1 to 1',
    text: 'Chaikin money flow, -1 to 1: the sum of ((close - low) - (high - close)) / (high - low) * volume of the last n bars, divided by their volume.',
    example: 'buy when cmf(20) > 0.1',
    series: 'It has no series argument, the ticker must have volume, and a bar with no range adds 0.',
  },
  linreg: {
    args: ['n'],
    short: 'least-squares line, at this bar',
    text: 'The value at this bar of the least-squares line through the last n values, with slope(n) as its slope per bar.',
    example: 'buy when close > linreg(50)',
  },
  rsquared: {
    args: ['n'],
    short: 'fit of a line to the last n values, 0 to 1',
    text: 'R squared of the least-squares line through the last n values, 0 to 1 (1 when all are on a line), unknown for equal values.',
    example: 'buy when slope(90) > 0 and rsquared(90) > 0.8',
  },
  efficiency: {
    args: ['n'],
    short: 'Kaufman efficiency ratio, 0 to 1 (1 for a straight move)',
    text: 'Kaufman efficiency ratio, 0 to 1: |x - x[n]| divided by the sum of |x - x[1]| in the last n bars, unknown with no move.',
    example: 'buy when efficiency(20) > 0.3 and close > sma(50)',
  },
  streak: {
    args: [],
    short: 'bars in a row up (1, 2, ...) or down (-1, -2, ...)',
    text: 'Bars in a row the value increased (1, 2, 3, ...) or decreased (-1, -2, ...), 0 if it did not change, unknown on the first bar.',
    example: 'buy when streak() <= -3',
    series: 'It reads close, or the series you write first, as in streak(volume), and after an unknown value it is unknown until the next known change.',
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
  const series = doc.series ?? (def.src === null ? 'It has no series argument.' : `It reads ${def.src}, or the series you write first, as in ${sample}.`);
  add('function', name, functionSignature(name), doc.short, `${doc.text} ${series}`, doc.example);
}
add('function', 'min', 'min(a, b)', 'the smaller value', 'The smaller of two values.', 'buy when close > min(sma(20), sma(50))');
add('function', 'max', 'max(a, b)', 'the larger value', 'The larger of two values.', 'buy when close > max(sma(20), sma(50))');
add('function', 'abs', 'abs(x)', 'value without its sign', 'The value without its sign.', 'buy when abs(close - open) > atr(14)');
add('function', 'sqrt', 'sqrt(x)', 'square root', 'The square root of the value, unknown for a value less than 0.', 'buy when stdev(roc(1), 20) * sqrt(252) < 20%');
add('function', 'log', 'log(x)', 'natural logarithm', 'The natural logarithm of the value, unknown for 0 or less.', 'buy when slope(log(close), 90) > 0.1%');
add('function', 'exp', 'exp(x)', 'e to the power x', 'e to the power of the value, unknown when the result is too large.', 'buy when exp(slope(log(close), 90) * 252) - 1 > 20%');
add(
  'function',
  'if',
  'if(condition, a, b)',
  'a where the condition holds, b where it does not',
  'The number a where the condition holds and b where it does not, or unknown where the condition is unknown. a and b are numbers, not conditions.',
  'buy when if(close > sma(200), roc(126), 0) > 5%',
);
add(
  'function',
  'column',
  'column(name) of file',
  'a column of a CSV file: column(score) of signals',
  'Reads a numeric column of a CSV file by its header in lowercase, with underscores for spaces, for example column(score) of signals. A row counts as known at the close of its date.',
  'buy when column(score) of csv:Data/signals.csv > 0.7',
);

const ADJUSTED = 'Yahoo adjusts prices for splits and dividends: compare them with an average, not with a constant number.';
add('series', 'open', 'open', "the bar's open", `The open price of each bar of the ticker of the rule. ${ADJUSTED}`, 'buy when open > close[1]');
add('series', 'high', 'high', "the bar's high", `The highest price of each bar of the ticker of the rule. ${ADJUSTED}`, 'buy when high > high[1]');
add('series', 'low', 'low', "the bar's low", `The lowest price of each bar of the ticker of the rule. ${ADJUSTED}`, 'buy when low < low[1]');
add('series', 'close', 'close', "the bar's close", `The close price of each bar of the ticker of the rule. ${ADJUSTED}`, 'buy when close > sma(200)');
add('series', 'volume', 'volume', "the bar's volume", 'The traded volume of each bar of the ticker of the rule.', 'buy when volume > sma(volume, 20)');

const calendar = (id: string, signature: string, short: string, text: string, example: string) => add('calendar', id, signature, short, `${text} The plugin reads it from the date of each bar, in UTC.`, example);
calendar('month', 'month', 'month of the bar, 1 to 12', 'The month of the bar, 1 to 12.', 'buy when month == 11');
calendar('day', 'day', 'day of the month, 1 to 31', 'The day of the month, 1 to 31.', 'sell when month == 5 and day > 20');
calendar('weekday', 'weekday', '1 = Monday to 7 = Sunday', 'The day of the week: 1 for Monday to 7 for Sunday.', 'buy when weekday == 1');
calendar('year', 'year', 'the year, as 2024', 'The year, for example 2024.', 'buy when year >= 2010');
calendar('month_start', 'month_start', 'first bar of a month', 'A condition: the first bar of a month.', 'buy when month_start');
calendar('month_end', 'month_end', 'last bar of a month', 'A condition: the last bar of a month.', 'buy when month_end');
calendar('quarter', 'quarter', 'quarter of the bar, 1 to 4', 'The quarter of the year of the bar, 1 to 4.', 'buy when quarter == 4');
calendar('week_start', 'week_start', 'first bar of a week', 'A condition: the first bar of a week, which starts on Monday.', 'buy when week_start');
calendar('week_end', 'week_end', 'last bar of a week', 'A condition: the last bar of a week, which starts on Monday.', 'sell when week_end');
calendar('quarter_start', 'quarter_start', 'first bar of a quarter', 'A condition: the first bar of a quarter.', 'buy when quarter_start');
calendar('quarter_end', 'quarter_end', 'last bar of a quarter', 'A condition: the last bar of a quarter.', 'sell when quarter_end');
calendar('year_start', 'year_start', 'first bar of a year', 'A condition: the first bar of a year.', 'buy when year_start');
calendar('year_end', 'year_end', 'last bar of a year', 'A condition: the last bar of a year.', 'sell when year_end');
calendar('trading_day', 'trading_day', 'number of the day in its month, of the days with a bar', 'The day number in the month, of days with a bar: 1 on the month’s first such day, unknown in the data’s first month.', 'sell when trading_day == 3');
calendar('trading_days_left', 'trading_days_left', 'remaining days with a bar in the month', 'Days with a bar after this day in its month, 0 on the month’s last such day: after the last bar, holidays also count.', 'buy when trading_days_left == 3');

const BELONGS = 'Only sell, cover and add rules can read it, and not in a function, in a window of bars, with [n] or with of.';
add(
  'position',
  POSITION.bars_held,
  'bars held',
  'completed bars since the entry filled, 0 on that bar',
  `Completed bars since the buy filled, or the short sale (the first of more entries): it is 0 on the bar of the fill. ${BELONGS}`,
  'sell when bars held >= 20',
);
add(
  'position',
  POSITION.entry_price,
  'entry price',
  'the price the position was bought or sold short at',
  `The price the position was bought at, slippage included, or for a short the price it was sold at (for more entries, the average). ${BELONGS}`,
  'sell when close < entry price * 0.9',
);
add(
  'position',
  POSITION.last_entry_price,
  'last entry price',
  'the price of the last entry',
  `The fill price of the last entry of the position, slippage included, and with one entry, the same as entry price. ${BELONGS}`,
  'sell when close < last entry price * 0.95',
);
add(
  'position',
  POSITION.entries_made,
  'entries made',
  'how many entries the position has',
  `The number of entries of the open position: 1 after the buy or short sale, plus 1 for each add. ${BELONGS}`,
  'sell when entries made == 1 and bars held >= 10',
);
add(
  'position',
  POSITION.highest_since_entry,
  'highest since entry',
  'the highest price since the first entry',
  `The maximum of the first fill price before slippage and each next high (and the fill bar high for a fill at its open). ${BELONGS}`,
  'sell when close < highest since entry - 3 * atr(22)',
);
add(
  'position',
  POSITION.lowest_since_entry,
  'lowest since entry',
  'the lowest price since the first entry',
  `The minimum of the first fill price before slippage and each next low (and the fill bar low for a fill at its open). ${BELONGS}`,
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
  'in a range, the two ends included',
  'True when a is lo or more and hi or less: rsi(2) between 10 and 30 is rsi(2) >= 10 and rsi(2) <= 30. It is one comparison that does not chain: not rsi(2) between 10 and 30 is true when rsi(2) is not in the range.',
  'buy when rsi(2) between 10 and 30',
);
word(
  'for … bars',
  'condition for n bars',
  'held on each of the last n bars',
  'True when the condition held on each of the last n bars, this bar included, and unknown until all n are known. It applies to the comparison before it and to a not in front of that (not up for 3 bars is (not up) for 3 bars): use brackets for more.',
  'buy when close > sma(200) for 3 bars',
);
word(
  'within',
  'condition within n bars',
  'held on one or more of the last n bars',
  'True when the condition held on one or more of the last n bars, this bar included, and unknown until all n are known. n is an integer from 1 to 10000 or a parameter, and you can also write bar.',
  'sell when rsi(2) > 90 within 3 bars',
);
word(
  'buy when',
  'buy when condition',
  'condition that opens a long position',
  'Opens a long position in a ticker that the strategy does not hold when the condition is true at a close. It fills at the next open of that ticker, unless fill is close.',
  'buy when close > sma(200)',
);
word(
  'sell when',
  'sell when condition',
  'condition that closes a long position',
  'Closes a long position when the condition is true at a close. Without a sell rule, the strategy holds a position until a stop or a short rule closes it, or until the run ends.',
  'sell when close < sma(200)',
);
word(
  'add when',
  'add when condition',
  'condition that adds the next entry',
  'Adds the next entry to the open position, long or short, when the condition is true at a close, up to the number in entries. It must have an entries line, and the plugin ignores it at a close where the sell rule (for a short, the cover rule) holds.',
  'entries: 3\nadd when close > last entry price * 1.03',
);
word(
  'short when',
  'short when condition',
  'condition that opens a short position',
  'Sells short a ticker that the strategy does not hold when the condition is true at a close, and fills as a buy does. It also closes a long position in the ticker, and opens the short at the same fill if the buy rule does not hold there.',
  'short when close < sma(200)',
);
word(
  'cover when',
  'cover when condition',
  'condition that closes a short position',
  'Buys a short position back when the condition is true at a close, and it must have a short rule. Without a cover rule, the strategy holds a short until a stop or the buy rule closes it, or until the run ends.',
  'short when close < sma(200)\ncover when close > sma(200)',
);
word(
  'for',
  'for TICKER:',
  'rules and stops for one or more tickers: for TLT:',
  'Starts rules for one ticker, or for more tickers with commas between them (for SPY, TLT:), and each must be in the universe. A buy, sell, short, cover or add rule, stop loss, trailing stop or take profit below it replaces the shared one for those tickers only.',
  'for SPY, TLT:',
);
word('for all', 'for all:', 'back to the rules that all tickers share', 'Goes back to the rules that all tickers share. The lines after it apply to all tickers, but a rule in a for section replaces the shared rule for its tickers.', 'for all:');
word(
  'and',
  'a and b',
  'the two conditions hold',
  'True when the two conditions are true. A rule can continue on the next line: indent the line and start it with and or or.',
  'buy when close > sma(200) and rsi(14) < 70',
);
word('or', 'a or b', 'one or more of the conditions hold', 'True when one or more of the conditions are true. The plugin applies it last: a and b or c is (a and b) or c.', 'sell when close < sma(200) or rsi(14) > 85');
word(
  'not',
  'not a',
  'the condition does not hold',
  'True when the condition after it is not true. The plugin applies it after a comparison and before and: not close > 1 is not (close > 1), and not up for 3 bars is (not up) for 3 bars.',
  'buy when not close < sma(200)',
);
word(
  'crosses',
  'a crosses b',
  'crossed above or below',
  'True on a bar where a crosses b: a is not on the same side of b as on the previous bar. Write crosses above or crosses below for one direction only.',
  'buy when close crosses sma(50)',
);
word(
  'crosses above',
  'a crosses above b',
  'was at or below, then above',
  'True on a bar where a is above b and was at or below b on the previous bar.',
  'buy when sma(50) crosses above sma(200)',
);
word(
  'crosses below',
  'a crosses below b',
  'was at or above, then below',
  'True on a bar where a is below b and was at or above b on the previous bar.',
  'sell when sma(50) crosses below sma(200)',
);
word('above', 'a above b', 'same as >', 'The same as >. You can also write is above.', 'buy when close above sma(200)');
word('below', 'a below b', 'same as <', 'The same as <. You can also write is below.', 'sell when close below sma(200)');
word(
  'of',
  'value of TICKER',
  'a value of a different ticker: sma(200) of SPY',
  'Reads a value from a different ticker, in the universe or not. For each bar, it reads the ticker’s last bar that ended at or before the end of this bar.',
  'buy when close > sma(200) and close of ^VIX < 25',
);
word(
  'tiingo:',
  'tiingo:TICKER',
  'a ticker from Tiingo, for example tiingo:SPY',
  'Downloads the daily prices of this ticker from Tiingo, adjusted for splits and dividends, with the key from the Tiingo API key setting. Tiingo gives 1d and 1w bars of US stocks, ETFs and funds.',
  'universe: tiingo:SPY',
);
word(
  'fred:',
  'fred:SERIES',
  'a FRED data series, for example fred:T10Y2Y',
  'A series from FRED, with each value from the day FRED first published it and the key from the FRED API key setting. Rules read it with of, and cash rate can use it as a yield (fred:DGS3MO), but you cannot trade it or make it the benchmark.',
  'buy when close of fred:T10Y2Y > 0',
);
word(
  '[n]',
  'value[n]',
  'the value n bars before: close[5]',
  'The value n bars before this bar: close[5] is the close five bars before. It works on all values, and n must be an integer or a parameter with an integer value.',
  'buy when close > close[5]',
);
word(
  'in … step',
  'name = 50 in 20..100 step 10',
  'a range for a sweep: 50 in 20..100 step 10',
  'Gives a parameter a range of values for a sweep, but the block runs with the value before in, which must be in the range. The step is optional: without it, the step is 1, or 1% for a percentage.',
  'fast = 50 in 20..100 step 10',
);
word(
  'top … by',
  'hold: top 3 by score',
  'hold the 3 tickers with the highest score',
  'In hold: the number of tickers to hold, and the score that sets their sequence, written as a value in a rule. The universe must have that number of tickers or more.',
  'hold: top 3 by roc(126)',
);
word(
  'at',
  'risk per trade: 1% at 2 atr(14)',
  'share of equity at risk for a stop distance',
  'In risk per trade: the word between the share of equity at risk and the move against the position, in average true ranges.',
  'risk per trade: 1% at 2 atr(14)',
);
word('true', 'true', 'always holds', 'A condition that always holds. You can also write always.', 'buy when true');
word('false', 'false', 'does not hold', 'A condition that does not hold. You can also write never.', 'sell when false');
add('unit', '%', '5%', 'a percentage: 5% counts as 0.05', 'A percentage. It counts as the number 0.05 where you can write a number: roc(20) > 5% is roc(20) > 0.05.', 'buy when roc(20) > 5%');
add('unit', 'bps', '5 bps', 'basis points: 100 bps is 1%', 'Basis points: hundredths of a percent, thus 100 bps is 1%. In costs and slippage, a number without a unit also counts as bps.', 'costs: 5 bps');

const PERIOD = /^(\d+)([mhdw])$/;
const UNIT_NAME = { m: 'minute', h: 'hour', d: 'day', w: 'week' } as const;
const value = (id: string, short: string, text: string, example: string) => {
  const [key, v] = id.split('=');
  add('value', id, `${key}: ${v}`, short, text, example);
};

value('rebalance=never', 'no rebalance of held positions', 'The strategy does not set held positions back to their weights. This is the default.', 'rebalance: never');
const PERIODS = { weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year' } as const;
for (const [name, unit] of Object.entries(PERIODS)) {
  value(
    `rebalance=${name}`,
    `back to the weights at the start of each ${unit}`,
    `The strategy sets each held ticker back to its target weight at the open of its first bar in each new ${unit}. ${name === 'weekly' ? 'Weeks start on Monday.' : 'A rebalance does not open a position.'}`,
    `rebalance: ${name}`,
  );
}
value(
  'data=yahoo',
  'Yahoo prices, adjusted for splits and dividends',
  'Tickers without a prefix come from Yahoo: write them as Yahoo does, for example SPY, BRK-B, BTC-USD or ^GSPC. Yahoo gives 1d and 1w bars.',
  'data: yahoo',
);
value('data=binance', 'Binance market symbols, for example BTCUSDT', 'Tickers without a prefix are Binance market symbols, for example BTCUSDT, but a ticker that starts with ^ (for example ^VIX) comes from Yahoo. Binance gives bars from 1m to 1w.', 'data: binance');
value(
  'data=tiingo',
  'Tiingo prices, adjusted for splits and dividends',
  'Tickers without a prefix come from Tiingo, with the key from the Tiingo API key setting, but tickers that start with ^ come from Yahoo. Tiingo gives 1d and 1w bars of US stocks, ETFs and funds.',
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
      ? `${bars[0].toUpperCase()}${bars.slice(1)} bars, from Yahoo, Tiingo or Binance.${v === '1w' ? ' The plugin uses a weekly bar only after its week ends.' : ''}`
      : `${count}-${UNIT_NAME[unit as keyof typeof UNIT_NAME]} bars, only from Binance. The block must have data: binance or a binance: ticker.`,
    both ? `interval: ${v}` : `data: binance\ninterval: ${v}`,
  );
}
value('fill=next open', 'an order at a close fills at the next open', 'An order at the close of a bar fills at the next open of that ticker. This is the default.', 'fill: next open');
value('fill=close', 'an order at a close fills at that same close', 'An order at the close of a bar fills at that same close.', 'fill: close');

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
  if (!m) return { id: name, kind: 'parameter', signature, short: `parameter: ${written}`, text: 'Your parameter. The block cannot use it because its value is not a number.', example: '' };
  const percent = [m[1], m[2], m[3], m[4]].some((s) => s?.includes('%'));
  const shown = (s: string) => s.replace(/\s+/g, '');
  const range = m[2] === undefined ? 'with no range' : `with a range of ${shown(m[2])} to ${shown(m[3])} in steps of ${m[4] === undefined ? (percent ? '1%' : '1') : shown(m[4])}`;
  const rule = percent ? ` In a rule, ${shown(m[1])} counts as the number ${Number(shown(m[1]).replace('%', '')) / 100}.` : '';
  return { id: name, kind: 'parameter', signature, short: `parameter: ${written}`, text: `Your parameter. Its value is ${shown(m[1])}, ${range}.${rule}`, example: '' };
}

function definitionDoc(name: string, written: string): Doc {
  return { id: name, kind: 'definition', signature: `${name} = ${written}`, short: `definition: ${written}`, text: `Your definition. When you write ${name}, the plugin reads ${written}.`, example: '' };
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
