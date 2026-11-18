import type { CorpusExample } from './types.ts';

/** Strategies on one ticker: trend, breakouts, volatility, mean reversion, momentum, exits, intraday and the calendar. */
export const SINGLE_EXAMPLES: CorpusExample[] = [
  {
    title: 'SPY golden cross',
    description: 'Buy SPY when the 50-day average crosses above the 200-day average and sell when it crosses back below. Count 5 bps for each trade.',
    source: `name: SPY golden cross
universe: SPY
costs: 5 bps

buy when sma(50) crosses above sma(200)
sell when sma(50) crosses below sma(200)`,
    notes: [],
    tags: ['trend', 'crossover', 'costs'],
  },
  {
    title: 'QQQ confirmed uptrend',
    description: 'Only buy QQQ once it has been above its 200-day average for 5 days in a row, and sell after 3 straight days below it. I want fewer false signals than a plain crossover.',
    source: `name: QQQ confirmed uptrend
universe: QQQ

buy when close above sma(200) for 5 bars
sell when close below sma(200) for 3 bars`,
    notes: [],
    tags: ['trend', 'filter', 'windows'],
  },
  {
    title: 'AAPL MACD crossover',
    description: 'Trade Apple on MACD crossovers. Start with 10k and a 1 dollar commission on every order.',
    source: `name: AAPL MACD crossover
universe: AAPL
capital: 10k
commission: 1

buy when macd() crosses above macd_signal()
sell when macd() crosses below macd_signal()`,
    notes: ['You gave no MACD periods, so macd() and macd_signal() use their usual 12, 26 and 9.'],
    tags: ['trend', 'macd', 'crossover', 'costs'],
  },
  {
    title: 'MSFT strong uptrend',
    description: 'Microsoft, strong uptrends only: ADX above 25, +DI above -DI and Aroon up above 70. Get out when the trend is no longer strong or Aroon down passes Aroon up.',
    source: `name: MSFT strong uptrend
universe: MSFT

trending = adx(14) > 25

buy when trending
  and plus_di(14) > minus_di(14)
  and aroon_up(25) > 70
sell when not trending or aroon_down(25) > aroon_up(25)`,
    notes: ['You gave no lengths, so ADX and the DI lines use 14 bars and Aroon uses 25.'],
    tags: ['trend', 'definitions', 'multi-line'],
  },
  {
    title: 'QQQ supertrend with parabolic SAR',
    description: 'On QQQ I want the supertrend and the parabolic SAR to agree: buy when the supertrend points up and the price is above the SAR, and sell when the price falls under either line.',
    source: `name: QQQ supertrend with parabolic SAR
universe: QQQ

buy when supertrend_up(10, 3) and close > psar(0.02, 0.2)
sell when close < supertrend(10, 3) or close < psar(0.02, 0.2)`,
    notes: ['You gave no numbers, so the supertrend uses 10 bars and a multiple of 3, and the SAR its usual step of 0.02 and maximum of 0.2.'],
    tags: ['trend', 'trailing line'],
  },
  {
    title: 'SPY TEMA and DEMA crossover',
    description: 'A moving-average crossover on SPY with less lag: the 10-day triple exponential average against the 30-day double exponential average.',
    source: `name: SPY TEMA and DEMA crossover
universe: SPY

buy when tema(10) crosses above dema(30)
sell when tema(10) crosses below dema(30)`,
    notes: ['You did not say which way to trade it, so it buys when the faster average crosses above the slower one and sells when it crosses back below.'],
    tags: ['trend', 'crossover', 'moving averages'],
  },
  {
    title: 'SPY adaptive average',
    description: "Use Kaufman's adaptive moving average on the S&P 500: be in while the price is above it and the market is trending rather than choppy.",
    source: `name: SPY adaptive average
universe: SPY

buy when close > kama(10, 2, 30) and efficiency(10) > 0.3
sell when close < kama(10, 2, 30)`,
    notes: [
      'SPY stands in for the S&P 500.',
      'KAMA uses its usual 10, 2 and 30, and trending means an efficiency ratio over 0.3.',
      'You did not say when to sell, so it sells when the price falls under the average.',
    ],
    tags: ['trend', 'adaptive', 'moving averages'],
  },
  {
    title: 'SPY regression trend',
    description: 'Buy SPY when its 90-day trend is clean: the log-price regression line rises faster than 15% a year, it fits well (R-squared above 0.7) and the price is above the line. Sell when the trend turns down.',
    source: `name: SPY regression trend
universe: SPY

annual = exp(slope(log(close), 90) * 252) - 1

buy when annual > 15% and rsquared(log(close), 90) > 0.7 and log(close) > linreg(log(close), 90)
sell when annual < 0`,
    notes: ['A year is taken as 252 trading days.'],
    tags: ['trend', 'regression', 'definitions'],
  },
  {
    title: 'QQQ 20-day breakout',
    description: "Turtle-style breakout on QQQ: buy a new 20-day high, sell a new 10-day low. Test 2010 through 2024, and fill at the next day's open.",
    source: `name: QQQ 20-day breakout
universe: QQQ
from: 2010-01-01
to: 2024-12-31
fill: next open

buy when close > highest(20)[1]
sell when close < lowest(10)[1]`,
    notes: ['2010 through 2024 is read as 2010-01-01 to 2024-12-31.'],
    tags: ['breakout', 'channel', 'test period'],
  },
  {
    title: 'SPY squeeze breakout',
    description: 'Volatility squeeze on SPY: when the Bollinger bands have sat inside the Keltner channel in the last few days and the price then breaks above the channel, buy. Sell when it closes under its 20-day exponential average.',
    source: `name: SPY squeeze breakout
universe: SPY

squeeze = bb_upper(20, 2) < keltner_upper(20, 1.5, 10) and bb_lower(20, 2) > keltner_lower(20, 1.5, 10)

buy when squeeze within 5 bars and close > keltner_upper(20, 1.5, 10)
sell when close < ema(20)`,
    notes: [
      '"The last few days" is taken as 5 bars.',
      'The bands use 20 bars and 2 deviations and the channel 20 bars, 1.5 average true ranges and 10 bars, the usual squeeze settings.',
    ],
    tags: ['volatility', 'breakout', 'definitions', 'windows'],
  },
  {
    title: 'NVDA breakout with volume',
    description: 'Buy NVDA breakouts only when volume agrees: a new 50-day high, the money flow index over 60 and on-balance volume above its 20-day average. Sell when it closes under the 20-day volume-weighted average or Chaikin money flow goes negative.',
    source: `name: NVDA breakout with volume
universe: NVDA

buy when close > highest(50)[1] and mfi(14) > 60 and obv() > sma(obv(), 20)
sell when close < vwap(20) or cmf(20) < 0`,
    notes: ['You gave no lengths for the money flow index and Chaikin money flow, so they use 14 and 20 bars.'],
    tags: ['breakout', 'volume'],
  },
  {
    title: 'NVDA momentum with ATR stops',
    description: 'Momentum on NVDA: buy when the 60-day gain is over 15%, the price is above its 50-day exponential average and annualized volatility is under 40%. Stop loss 2 ATR, trailing stop 3 ATR, take profit 6 ATR. Sell if the 60-day gain turns negative.',
    source: `name: NVDA momentum with ATR stops
universe: NVDA
stop loss: 2 atr(14)
trailing stop: 3 atr(14)
take profit: 6 atr(14)

buy when roc(60) > 15% and close > ema(50) and stdev(roc(1), 20) * sqrt(252) < 40%
sell when roc(60) < 0`,
    notes: [
      'No ATR length was given, so the stops use 14 bars.',
      'Annualized volatility is the standard deviation of daily returns over 20 bars times the square root of 252.',
    ],
    tags: ['momentum', 'volatility', 'stops'],
  },
  {
    title: 'GLD RSI bounce',
    description: 'Buy gold (GLD) when the 14-day RSI drops under a level I can tune from 20 to 40, with a stop loss I can tune from 4% to 12%. Sell the first time RSI(14) crosses 50. Judge it on data from 2018.',
    source: `name: GLD RSI bounce
universe: GLD
test from: 2018-01-01
stop loss: stop_pct

limit = 30 in 20..40 step 5
stop_pct = 8% in 4%..12% step 2%

buy when rsi(14) < limit
sell when rsi(14) crosses 50`,
    notes: ['You gave ranges but no starting values, so I started the RSI level at 30 and the stop at 8%.'],
    tags: ['mean reversion', 'parameters', 'stops', 'test period'],
  },
  {
    title: 'SPY Bollinger dip',
    description: 'Buy SPY when it closes below the lower Bollinger band but is still above its 100-day weighted moving average. Sell when it gets back up to its 20-day median.',
    source: `name: SPY Bollinger dip
universe: SPY

buy when close < bb_lower(20, 2) and close > wma(100)
sell when close > median(20)`,
    notes: ['The band uses the usual 20 bars and 2 standard deviations.'],
    tags: ['mean reversion', 'bollinger'],
  },
  {
    title: 'SPY Connors RSI',
    description: "Connors RSI idea on SPY: average RSI(3), the 2-day RSI of the up and down streak, and the percent rank of today's return over 100 days. Buy when that average is under 10 and the price is above its 200-day average, sell when it closes above its 5-day average.",
    source: `name: SPY Connors RSI
universe: SPY

buy when (rsi(3) + rsi(streak(), 2) + percent_rank(roc(1), 100)) / 3 < 10 and close > sma(200)
sell when close > sma(5)`,
    notes: [],
    tags: ['mean reversion', 'rsi', 'composite'],
  },
  {
    title: 'SPY three-day slide',
    description: 'Buy SPY after a three-day slide of more than 4% while it is above its 200-day average. Sell once it has bounced 5% off its low since I bought, or after 5 days. 5% stop loss.',
    source: `name: SPY three-day slide
universe: SPY
stop loss: 5%

buy when sum(roc(1), 3) < -4% and close > sma(200)
sell when close > lowest since entry * 1.05 or bars held >= 5`,
    notes: ['The slide is the sum of the last three daily returns.'],
    tags: ['mean reversion', 'exits', 'stops'],
  },
  {
    title: 'XLP CCI and Williams %R',
    description: 'Buy XLP when CCI(20) is under -100 and Williams %R(14) is under -80, as long as it holds above its 100-day average. Sell when CCI is back over 0 or Williams %R rises above -20.',
    source: `name: XLP CCI and Williams %R
universe: XLP

buy when cci(20) < -100 and williams_r(14) < -80 and close > sma(100)
sell when cci(20) > 0 or williams_r(14) > -20`,
    notes: [],
    tags: ['mean reversion', 'oscillators'],
  },
  {
    title: 'SPY pullback to the 50-day average',
    description: 'In an uptrend (50-day average above the 200-day), buy SPY on a pullback: the price within one average true range of the 50-day average, the stochastic %K crossing above %D, and RSI(14) between 40 and 50. Sell if it closes under the 200-day average.',
    source: `name: SPY pullback to the 50-day average
universe: SPY

distance = abs(close - sma(50))

buy when sma(50) > sma(200)
  and distance < atr(14)
  and stoch_k(14, 3) crosses above stoch_d(14, 3, 3)
  and rsi(14) between 40 and 50
sell when close < sma(200)`,
    notes: ['The stochastic uses its usual 14, 3 and 3.', 'You gave no length for the average true range, so it uses 14 bars.'],
    tags: ['trend', 'pullback', 'oscillators', 'definitions', 'multi-line'],
  },
  {
    title: 'SPY dip after a fresh breakout',
    description: 'Buy a quick dip right after a breakout: SPY is above its 200-day average, crossed above it less than 30 days ago, and RSI(2) was under 10 at some point in the last 3 days. Sell when it falls back under the 200-day average.',
    source: `name: SPY dip after a fresh breakout
universe: SPY

buy when close > sma(200) and bars_since(close crosses above sma(200)) < 30 and rsi(2) < 10 within 3 bars
sell when close < sma(200)`,
    notes: [],
    tags: ['mean reversion', 'trend', 'windows'],
  },
  {
    title: 'SPY momentum with steady days',
    description: 'Time-series momentum on SPY: be in when the price is above where it was some months ago, but only if at least 6 of the last 10 days were up days. I want to try lookbacks from 3 to 12 months.',
    source: `name: SPY momentum with steady days
universe: SPY

lookback = 126 in 63..252 step 21

buy when close > close[lookback] and count(close > close[1], 10) >= 6
sell when close < close[lookback]`,
    notes: ['Three to twelve months is 63 to 252 trading days in steps of a month (21 days), and I started at 6 months (126).'],
    tags: ['momentum', 'parameters'],
  },
  {
    title: 'SPY with VIX and correlation filters',
    description: "Hold SPY while it is above its 200-day average, the VIX is under 25, and SPY and the VIX are still moving against each other (correlation under -0.5 over the last 30 days). Leave when SPY loses its 200-day average or the VIX goes over 30.",
    source: `name: SPY with VIX and correlation filters
universe: SPY

buy when close > sma(200)
  and close of ^VIX < 25
  and correl(close of ^VIX, 30) < -0.5
sell when close < sma(200) or close of ^VIX > 30`,
    notes: [],
    tags: ['trend', 'filter', 'other ticker', 'volatility', 'multi-line'],
  },
  {
    title: 'QQQ dips in a SPY uptrend',
    description: 'Buy QQQ dips (3-day RSI under 20) only when both QQQ and SPY are above their 200-day averages. Get out when SPY loses its 200-day average, or when QQQ has closed under its own average two days running.',
    source: `name: QQQ dips in a SPY uptrend
universe: QQQ

uptrend = close > sma(200)

buy when uptrend and uptrend of SPY and rsi(3) < 20
sell when uptrend of SPY == false or (not uptrend and not uptrend[1])`,
    notes: [],
    tags: ['mean reversion', 'filter', 'other ticker', 'definitions'],
  },
  {
    title: 'SPY RSI(2) by regime',
    description: 'Buy SPY on RSI(2) dips, but be pickier in a downtrend: RSI(2) under 15 while it is above its 200-day average, under 5 while it is below. Sell when RSI(2) is over 70.',
    source: `name: SPY RSI(2) by regime
universe: SPY

buy when rsi(2) < if(close > sma(200), 15, 5)
sell when rsi(2) > 70`,
    notes: [],
    tags: ['mean reversion', 'regime', 'rsi'],
  },
  {
    title: 'QQQ buffer between two averages',
    description: 'Buy QQQ only when it is above both its 50-day and its 200-day average, and sell only when it is below both, so there is a buffer in between.',
    source: `name: QQQ buffer between two averages
universe: QQQ

buy when close > max(sma(50), sma(200))
sell when close < min(sma(50), sma(200))`,
    notes: [],
    tags: ['trend', 'moving averages'],
  },
  {
    title: 'SPY pyramid in three entries',
    description: "Build a SPY position in three steps: buy a third when it's above its 200-day average and RSI(14) is under 50. Add the second third when the price is 2% above my last purchase and the last third when it's 4% above that one. Sell everything if it falls 8% below my average cost.",
    source: `name: SPY pyramid in three entries
universe: SPY
entries: 3

buy when close > sma(200) and rsi(14) < 50
add when close > last entry price * (1 + 0.02 * entries made)
sell when close < entry price * 0.92`,
    notes: ['Your average cost is entry price, which is the average of the entries made so far.'],
    tags: ['scaling in', 'entries', 'exits'],
  },
  {
    title: 'SPY entry with three exits',
    description: "Buy SPY when it crosses above its 20-day average while it's above its 200-day average. Sell when I'm up 20%, after 30 days, or when the price falls 3 average true ranges (22-day) below the highest price since I bought.",
    source: `name: SPY entry with three exits
universe: SPY

buy when close > sma(200) and close crosses above sma(20)
sell when position return > 20% or bars held > 30 or close < highest since entry - 3 * atr(22)`,
    notes: [],
    tags: ['exits', 'trailing', 'trend'],
  },
  {
    title: 'BTC hourly Hull trend',
    description: 'Bitcoin on Binance hourly bars since the start of 2024: buy when the 24-hour Hull average is rising and the price is above the 200-hour weighted average, sell when the Hull average turns down. Costs 10 bps and slippage 5 bps.',
    source: `name: BTC hourly Hull trend
data: binance
universe: BTCUSDT
interval: 1h
from: 2024-01-01
costs: 10 bps
slippage: 5 bps

buy when hma(24) > hma(24)[1] and close > wma(200)
sell when hma(24) < hma(24)[1]`,
    notes: ["BTCUSDT is Binance's Bitcoin pair."],
    tags: ['intraday', 'crypto', 'trend', 'costs'],
  },
  {
    title: 'ETH 15-minute dips',
    description: 'Scalp Ether on 15-minute Binance bars through 2025: buy when RSI(14) drops under 30 and sell when it is over 60, with a 1% stop and a 2% target.',
    source: `name: ETH 15-minute dips
data: binance
universe: ETHUSDT
interval: 15m
from: 2025-01-01
to: 2025-12-31
stop loss: 1%
take profit: 2%

buy when rsi(14) < 30
sell when rsi(14) > 60`,
    notes: ["ETHUSDT is Binance's Ether pair, and through 2025 is read as 2025-01-01 to 2025-12-31."],
    tags: ['intraday', 'crypto', 'mean reversion', 'stops'],
  },
  {
    title: 'BTC daily trend with hourly stops',
    description: 'Bitcoin daily trend from Binance: buy above the 50-day average, sell below it, with an 8% stop and a 20% target. A daily bar can reach both, so look at the hourly bars to see which came first.',
    source: `name: BTC daily trend with hourly stops
data: binance
universe: BTCUSDT
interval: 1d
magnify: 1h
stop loss: 8%
take profit: 20%

buy when close > sma(50)
sell when close < sma(50)`,
    notes: [],
    tags: ['crypto', 'trend', 'stops', 'magnify'],
  },
  {
    title: 'QQQ 30-week trend',
    description: 'Weekly chart trend on QQQ from Yahoo: in while the weekly close is above its 30-week average, out below it.',
    source: `name: QQQ 30-week trend
data: yahoo
universe: QQQ
interval: 1w

buy when close > sma(30)
sell when close < sma(30)`,
    notes: [],
    tags: ['trend', 'weekly'],
  },
  {
    title: 'AAPL gap up on heavy volume',
    description: 'Buy Apple the day after it beats earnings estimates and sell a week later.',
    source: `name: AAPL gap up on heavy volume
universe: AAPL

buy when open > close[1] * 1.03 and close > (high + low) / 2 and zscore(volume, 20) > 2
sell when bars held >= 5`,
    notes: [
      'Earnings dates and estimates are not available, so a gap up of more than 3% that holds above the middle of the day on unusually heavy volume stands in for a beat.',
      'Unusually heavy volume is more than 2 standard deviations above its 20-day average.',
      'A week is taken as 5 trading days.',
    ],
    tags: ['unsupported', 'fundamentals', 'gap', 'volume'],
  },
  {
    title: 'SPY buy and hold',
    description: 'Own SPY and sell a covered call against it every month for income.',
    source: `name: SPY buy and hold
universe: SPY

buy when true`,
    notes: ['Options are not supported, so no calls are sold: this is the SPY shares alone, bought on the first day and held.'],
    tags: ['unsupported', 'options', 'buy and hold'],
  },
  {
    title: 'SPY RSI swings',
    description: "Trade SPY on 5-minute bars: buy when RSI(14) goes under 30 and sell when it's over 70.",
    source: `name: SPY RSI swings
universe: SPY

buy when rsi(14) < 30
sell when rsi(14) > 70`,
    notes: ['Yahoo has no intraday bars for stocks, so the 5-minute interval is left out and the rules read daily bars.'],
    tags: ['unsupported', 'intraday', 'mean reversion', 'rsi'],
  },
  {
    title: 'QQQ trend with target and trailing stop',
    description: "Buy QQQ while it's above its 200-day average. Sell half when I'm up 10% and the rest if it falls 5% from its high.",
    source: `name: QQQ trend with target and trailing stop
universe: QQQ
trailing stop: 5%
take profit: 10%

buy when close > sma(200)`,
    notes: ['A sale always closes the whole position, so the 10% take profit sells all of it rather than half.'],
    tags: ['unsupported', 'partial exit', 'stops'],
  },
  {
    title: 'SPY Halloween effect',
    description: 'Sell in May: buy SPY at the end of October and sell it at the end of April.',
    source: `name: SPY Halloween effect
universe: SPY
fill: close

buy when month == 10 and month_end
sell when month == 4 and month_end`,
    notes: ['fill: close trades at the closing price of those last days of the month, as your wording suggests, rather than at the next open.'],
    tags: ['calendar', 'seasonal'],
  },
  {
    title: 'SPY turn of the month',
    description: "I've read that stocks do best around the turn of the month. Be in SPY for the last few days of each month and the first few of the next.",
    source: `name: SPY turn of the month
universe: SPY

buy when trading_days_left == 3
sell when trading_day == 3`,
    notes: ['"The last few days" is taken as the last 3 trading days of the month and "the first few" as the first 3 of the next.'],
    tags: ['calendar', 'seasonal'],
  },
  {
    title: 'SPY turnaround Tuesday',
    description: "Buy SPY at Monday's close when it fell more than 1% that day, and sell at Tuesday's close.",
    source: `name: SPY turnaround Tuesday
universe: SPY
fill: close

buy when weekday == 1 and roc(1) < -1%
sell when weekday == 2`,
    notes: ['fill: close makes both trades at those closes instead of the next open.'],
    tags: ['calendar', 'weekday', 'mean reversion'],
  },
  {
    title: 'QQQ weekend hold',
    description: 'Hold QQQ over the weekend only: buy at the last close of each week when it is above its 50-day average, and sell at the first close of the next week.',
    source: `name: QQQ weekend hold
universe: QQQ
fill: close

buy when week_end and close > sma(50)
sell when week_start`,
    notes: ['fill: close trades at the closes you named instead of the next open.'],
    tags: ['calendar', 'weekday', 'trend'],
  },
  {
    title: 'SPY payday window',
    description: 'Buy SPY from the 25th of the month and hold it into the first trading day of the next month.',
    source: `name: SPY payday window
universe: SPY

buy when day >= 25
sell when month_start`,
    notes: ['If the 25th is not a trading day, the buy comes on the next one.'],
    tags: ['calendar', 'seasonal'],
  },
  {
    title: 'SPY first and fourth quarters',
    description: 'I only want to be invested in the first and fourth quarters: in from the first day of the year to the end of March, and from the first day of October to the end of the year.',
    source: `name: SPY first and fourth quarters
universe: SPY

buy when year_start or (quarter_start and quarter == 4)
sell when (quarter_end and quarter == 1) or year_end`,
    notes: [],
    tags: ['calendar', 'seasonal'],
  },
  {
    title: 'SPY without 2022',
    description: 'Buy and hold SPY, but I want to be in cash for all of 2022.',
    source: `name: SPY without 2022
universe: SPY

buy when year != 2022
sell when year == 2022`,
    notes: [],
    tags: ['calendar', 'buy and hold'],
  },
];
