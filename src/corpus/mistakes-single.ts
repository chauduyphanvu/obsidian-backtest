import type { CorpusMistake } from './types.ts';

/** Blocks with a mistake a writer is likely to make on a single ticker, what the parser says about each, and the block put right. */
export const SINGLE_MISTAKES: CorpusMistake[] = [
  {
    title: 'A crossing written "crosses over"',
    why: 'A crossing is written "crosses above", "crosses below" or just "crosses", and no other word may follow "crosses".',
    broken: `name: SPY golden cross
universe: SPY

buy when sma(50) crosses over sma(200)
sell when sma(50) crosses below sma(200)`,
    errors: [
      { line: 4, message: 'Unknown name "over". Series: open, high, low, close, volume. Functions: sma, ema, rsi, roc, stdev, highest, lowest, atr, macd, macd_signal, bb_upper, bb_lower, stoch_k, stoch_d, adx, plus_di, minus_di, cci, williams_r, mfi, obv, vwap, keltner_upper, keltner_lower, supertrend, supertrend_up, wma, hma, median, zscore, percent_rank, slope, correl, count, bars_since, sum, dema, tema, kama, aroon_up, aroon_down, psar, cmf, linreg, rsquared, efficiency, streak, min, max, abs, sqrt, log, exp, if, column. Dates: month, day, weekday, year, month_start, month_end, quarter, week_start, week_end, quarter_start, quarter_end, year_start, year_end, trading_day, trading_days_left' },
    ],
    fixed: `name: SPY golden cross
universe: SPY

buy when sma(50) crosses above sma(200)
sell when sma(50) crosses below sma(200)`,
  },
  {
    title: 'An invented function',
    why: 'Only the functions the language lists exist, so the lower Bollinger band is bb_lower, not bollinger_lower.',
    broken: `name: SPY lower band dip
universe: SPY

buy when close < bollinger_lower(20, 2)
sell when close > sma(20)`,
    errors: [
      { line: 4, message: 'Unknown name "bollinger_lower". Series: open, high, low, close, volume. Functions: sma, ema, rsi, roc, stdev, highest, lowest, atr, macd, macd_signal, bb_upper, bb_lower, stoch_k, stoch_d, adx, plus_di, minus_di, cci, williams_r, mfi, obv, vwap, keltner_upper, keltner_lower, supertrend, supertrend_up, wma, hma, median, zscore, percent_rank, slope, correl, count, bars_since, sum, dema, tema, kama, aroon_up, aroon_down, psar, cmf, linreg, rsquared, efficiency, streak, min, max, abs, sqrt, log, exp, if, column. Dates: month, day, weekday, year, month_start, month_end, quarter, week_start, week_end, quarter_start, quarter_end, year_start, year_end, trading_day, trading_days_left' },
    ],
    fixed: `name: SPY lower band dip
universe: SPY

buy when close < bb_lower(20, 2)
sell when close > sma(20)`,
  },
  {
    title: 'An invented setting',
    why: 'Only the listed settings exist, and the cost of each trade is written costs.',
    broken: `name: SPY 200-day trend
universe: SPY
fees: 5 bps

buy when close > sma(200)
sell when close < sma(200)`,
    errors: [
      { line: 3, message: 'Unknown setting "fees". Settings: name, universe, symbol, from, to, data, interval, capital, costs, size, rebalance, benchmark, stop loss, trailing stop, take profit, slippage, cash rate, test from, hold, weighting, risk per trade, fill, commission, entries, magnify, borrow fee, margin rate' },
    ],
    fixed: `name: SPY 200-day trend
universe: SPY
costs: 5 bps

buy when close > sma(200)
sell when close < sma(200)`,
  },
  {
    title: 'A date not written YYYY-MM-DD',
    why: 'Every date is written year-month-day with two digits each for month and day, as in 2015-01-31.',
    broken: `name: SPY 200-day trend
universe: SPY
from: 01/31/2015

buy when close > sma(200)
sell when close < sma(200)`,
    errors: [
      { line: 3, message: '"01/31/2015" is not a date. Write it as 2015-01-31' },
    ],
    fixed: `name: SPY 200-day trend
universe: SPY
from: 2015-01-31

buy when close > sma(200)
sell when close < sma(200)`,
  },
  {
    title: 'An expression where a period goes',
    why: 'A period is a plain number or a parameter, never an expression, so write sma(200) rather than sma(100 * 2).',
    broken: `name: SPY 200-day trend
universe: SPY

buy when close > sma(100 * 2)
sell when close < sma(100 * 2)`,
    errors: [
      { line: 4, message: 'sma() must have a period, for example sma(20)' },
      { line: 5, message: 'sma() must have a period, for example sma(20)' },
    ],
    fixed: `name: SPY 200-day trend
universe: SPY

buy when close > sma(200)
sell when close < sma(200)`,
  },
  {
    title: 'A definition where a period goes',
    why: 'A period must be a plain number or a parameter, so a name for a calculation such as 20 * 5 cannot stand there: write the number, as in length = 100.',
    broken: `name: SPY 100-day trend
universe: SPY

length = 20 * 5

buy when close > sma(length)
sell when close < sma(length)`,
    errors: [
      { line: 6, message: '"length" is a definition. Thus sma() reads it as its series, and a period is also necessary, for example sma(length, 20). A period must be a number or a parameter, for example length = 20' },
      { line: 7, message: '"length" is a definition. Thus sma() reads it as its series, and a period is also necessary, for example sma(length, 20). A period must be a number or a parameter, for example length = 20' },
    ],
    fixed: `name: SPY 100-day trend
universe: SPY

length = 100

buy when close > sma(length)
sell when close < sma(length)`,
  },
  {
    title: 'bars held in a buy rule',
    why: 'A position value such as bars held only exists while a position is open, so it belongs in a sell, cover or add rule, never a buy rule.',
    broken: `name: SPY trend held at least 10 bars
universe: SPY

buy when close > sma(200) and bars held >= 10
sell when close < sma(200)`,
    errors: [
      { line: 4, message: 'You can use "bars held" only in a sell, cover or add rule' },
    ],
    fixed: `name: SPY trend held at least 10 bars
universe: SPY

buy when close > sma(200)
sell when close < sma(200) and bars held >= 10`,
  },
  {
    title: 'A position value over a window of bars',
    why: 'A position value cannot be read over a window ("for n bars", "within n bars"), so put the window on the other conditions.',
    broken: `name: SPY trend exit with a profit
universe: SPY

buy when close > sma(200)
sell when (close < sma(20) and position return > 5%) for 3 bars`,
    errors: [
      { line: 5, message: 'A rule cannot read "position return" for more than one bar. It is a value of the open position at this bar only. Read it in a condition with no window, for example sell when bars held > 5 and close < sma(20) for 3 bars' },
    ],
    fixed: `name: SPY trend exit with a profit
universe: SPY

buy when close > sma(200)
sell when close < sma(20) for 3 bars and position return > 5%`,
  },
  {
    title: 'A blank line inside a rule',
    why: 'A blank line ends a rule, so a line that continues one must follow it directly.',
    broken: `name: SPY trend with RSI
universe: SPY

buy when close > sma(200)

  and rsi(14) > 50
sell when close < sma(200)`,
    errors: [
      { line: 6, message: 'Not a setting or a rule. Rules start with "buy when", "sell when", "short when" or "cover when"' },
    ],
    fixed: `name: SPY trend with RSI
universe: SPY

buy when close > sma(200)
  and rsi(14) > 50
sell when close < sma(200)`,
  },
  {
    title: 'A markdown fence around the block',
    why: 'The block is bare lines of the language, so a fence of backticks around it is not part of it.',
    broken: `\`\`\`
name: SPY 200-day trend
universe: SPY

buy when close > sma(200)
sell when close < sma(200)
\`\`\``,
    errors: [
      { line: 1, message: 'Not a setting or a rule. Rules start with "buy when", "sell when", "short when" or "cover when"' },
      { line: 7, message: 'Unexpected character "`"' },
    ],
    fixed: `name: SPY 200-day trend
universe: SPY

buy when close > sma(200)
sell when close < sma(200)`,
  },
  {
    title: 'A sentence of prose in the block',
    why: 'Every line of the block is a setting, a parameter, a definition, a rule or a # comment, so a sentence of explanation goes outside it, or after a # as a comment.',
    broken: `Here is the strategy you asked for:
name: SPY 200-day trend
universe: SPY

buy when close > sma(200)
sell when close < sma(200)`,
    errors: [
      { line: 1, message: 'Unknown setting "Here is the strategy you asked for". Settings: name, universe, symbol, from, to, data, interval, capital, costs, size, rebalance, benchmark, stop loss, trailing stop, take profit, slippage, cash rate, test from, hold, weighting, risk per trade, fill, commission, entries, magnify, borrow fee, margin rate' },
    ],
    fixed: `name: SPY 200-day trend
universe: SPY

buy when close > sma(200)
sell when close < sma(200)`,
  },
  {
    title: 'A stop or target without a percent sign',
    why: 'Stop loss, trailing stop and take profit are a percentage such as 20% or a multiple of the average true range such as 4 atr(14), never a bare number.',
    broken: `name: SPY trend with a target
universe: SPY
take profit: 20

buy when close > sma(200)
sell when close < sma(200)`,
    errors: [
      { line: 3, message: 'Take profit must be a percentage (for example 10%) or a multiple of the average true range (for example 2 atr(14))' },
    ],
    fixed: `name: SPY trend with a target
universe: SPY
take profit: 20%

buy when close > sma(200)
sell when close < sma(200)`,
  },
  {
    title: '"buy if" instead of "buy when"',
    why: 'A rule starts with "buy when", "sell when", "short when", "cover when" or "add when", not "if".',
    broken: `name: SPY 200-day trend
universe: SPY

buy if close > sma(200)
sell if close < sma(200)`,
    errors: [
      { line: 4, message: 'Not a setting or a rule. Rules start with "buy when", "sell when", "short when" or "cover when"' },
      { line: 5, message: 'Not a setting or a rule. Rules start with "buy when", "sell when", "short when" or "cover when"' },
    ],
    fixed: `name: SPY 200-day trend
universe: SPY

buy when close > sma(200)
sell when close < sma(200)`,
  },
  {
    title: 'A window counted in days',
    why: 'A window is counted in bars, written "for 5 bars" or "within 5 bars", whatever the interval.',
    broken: `name: SPY confirmed uptrend
universe: SPY

buy when close > sma(200) for 5 days
sell when close < sma(200)`,
    errors: [
      { line: 4, message: 'Write "bars" after the number, for example close > sma(200) for 3 bars' },
    ],
    fixed: `name: SPY confirmed uptrend
universe: SPY

buy when close > sma(200) for 5 bars
sell when close < sma(200)`,
  },
  {
    title: 'Hourly bars from Yahoo',
    why: 'Plain tickers come from Yahoo unless data: binance says otherwise, and Yahoo gives only 1d and 1w bars; the smaller bars come from Binance.',
    broken: `name: BTC hourly trend
universe: BTCUSDT
interval: 1h

buy when close > sma(200)
sell when close < sma(200)`,
    errors: [
      { line: 3, message: 'Yahoo data comes as 1d or 1w bars, not "1h"' },
    ],
    fixed: `name: BTC hourly trend
data: binance
universe: BTCUSDT
interval: 1h

buy when close > sma(200)
sell when close < sma(200)`,
  },
  {
    title: 'add when without entries',
    why: 'An add rule needs an entries line that says how many entries a position is built in, such as entries: 3.',
    broken: `name: SPY scaling in
universe: SPY

buy when close > sma(200) and rsi(14) < 50
add when close > last entry price * 1.03
sell when close < entry price * 0.92`,
    errors: [
      { line: 5, message: '"add when" must have an entries line that gives the number of entries for each position, for example entries: 3' },
    ],
    fixed: `name: SPY scaling in
universe: SPY
entries: 3

buy when close > sma(200) and rsi(14) < 50
add when close > last entry price * 1.03
sell when close < entry price * 0.92`,
  },
  {
    title: 'A parameter where only a written value goes',
    why: 'A parameter can stand in for a number in rules, stops, hold, weighting, risk per trade and entries, but a setting such as costs takes its value written out.',
    broken: `name: SPY trend, trying costs
universe: SPY
costs: trade_cost

trade_cost = 5 in 0..20 step 5

buy when close > sma(200)
sell when close < sma(200)`,
    errors: [
      { line: 3, message: '"trade_cost" is not a cost. Write it as 5 bps or 0.05%' },
    ],
    fixed: `name: SPY trend, trying costs
universe: SPY
costs: 5 bps

buy when close > sma(200)
sell when close < sma(200)`,
  },
];
