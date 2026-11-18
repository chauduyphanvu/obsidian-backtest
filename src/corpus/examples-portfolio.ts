import type { CorpusExample } from './types.ts';

/** Strategies over several tickers, and over the account: weights, rebalancing, rankings, sections, shorts, leverage and other data. */
export const PORTFOLIO_EXAMPLES: CorpusExample[] = [
  {
    title: '60/40 rebalanced yearly',
    description: 'I want a classic 60/40: 60% SPY and 40% TLT, put back to those weights once a year. Start in 2005 with 100k, and show me SPY alone as the comparison.',
    source: `name: 60/40 rebalanced yearly
universe: SPY 60%, TLT 40%
from: 2005-01-01
capital: 100k
rebalance: yearly
benchmark: SPY

buy when true`,
    notes: [],
    tags: ['portfolio', 'rebalance', 'benchmark', 'buy and hold'],
  },
  {
    title: '70/30 left to drift',
    description: 'Put 70% in VTI and 30% in BND at the start of 2012, no rebalancing, just let them drift until the end of 2023.',
    source: `name: 70/30 left to drift
universe: VTI 70%, BND 30%
from: 2012-01-01
to: 2023-12-31
rebalance: never

buy when true`,
    notes: [],
    tags: ['portfolio', 'rebalance', 'buy and hold', 'dates'],
  },
  {
    title: 'Three giants reset weekly',
    description: 'Hold a few big tech stocks in equal amounts and keep rebalancing them often.',
    source: `name: Three giants reset weekly
universe: AAPL, MSFT, NVDA
rebalance: weekly

buy when true`,
    notes: ['You named no stocks, so I used three large tech names: AAPL, MSFT and NVDA.', 'I read "often" as weekly.'],
    tags: ['portfolio', 'rebalance', 'equal weight'],
  },
  {
    title: '60% stocks, 20% bonds, 20% cash',
    description: 'Put 60% in SPY and 20% in TLT and leave the other 20% in cash, which pays me 4%. Reset the weights every month.',
    source: `name: 60% stocks, 20% bonds, 20% cash
universe: SPY 60%, TLT 20%
cash rate: 4%
rebalance: monthly

buy when true`,
    notes: [],
    tags: ['portfolio', 'cash', 'rebalance'],
  },
  {
    title: 'Blended momentum, top 4',
    description:
      'Each month, hold the 4 strongest of SPY, QQQ, IWM, EFA, EEM, TLT, IEF and GLD. Score each one by averaging its 3, 6 and 12 month returns, and skip anything whose score is negative.',
    source: `name: Blended momentum, top 4
universe: SPY, QQQ, IWM, EFA, EEM, TLT, IEF, GLD
rebalance: monthly
hold: top 4 by score

score = (roc(63) + roc(126) + roc(252)) / 3

buy when score > 0
sell when score < 0`,
    notes: ['A month is about 21 trading days, so 3, 6 and 12 months are roc(63), roc(126) and roc(252).'],
    tags: ['rotation', 'ranking', 'definitions', 'momentum'],
  },
  {
    title: 'Weekly momentum, top 3',
    description:
      'Use weekly bars. From SPY, QQQ, IWM, EFA and EEM hold the 3 with the best 26-week return, but only those above their 40-week average. Pick again every month, and judge the results from 2018 on.',
    source: `name: Weekly momentum, top 3
universe: SPY, QQQ, IWM, EFA, EEM
interval: 1w
test from: 2018-01-01
rebalance: monthly
hold: top 3 by roc(26)

buy when close > sma(40)
sell when close < sma(40)`,
    notes: [],
    tags: ['rotation', 'ranking', 'weekly', 'test period'],
  },
  {
    title: 'Calm funds get more weight',
    description: "I don't want to pick weights. Hold SPY, TLT and GLD, but give the calmer ones more money, going by the last 60 days of returns. Reset it monthly.",
    source: `name: Calm funds get more weight
universe: SPY, TLT, GLD
rebalance: monthly
weighting: inverse volatility(60)

buy when true`,
    notes: [],
    tags: ['weighting', 'portfolio', 'rebalance'],
  },
  {
    title: 'Breakouts sized by risk',
    description:
      'Breakout system on SPY, QQQ, IWM and EFA: buy a close above the previous 100-day high, sell below the previous 50-day low. Risk 1% of the account on each trade, with a stop 2 ATRs away.',
    source: `name: Breakouts sized by risk
universe: SPY, QQQ, IWM, EFA
stop loss: 2 atr(14)
risk per trade: 1% at 2 atr(14)

buy when close > highest(100)[1]
sell when close < lowest(50)[1]`,
    notes: ['You gave no length for the average true range, so I used 14 bars.'],
    tags: ['breakout', 'risk', 'sizing', 'stops'],
  },
  {
    title: 'Fast stocks, slow havens',
    description:
      'SPY, QQQ, TLT and GLD, reset each month. The stock funds buy above their 50-day average, the bonds and gold above their 200-day, and each sells when it closes back under its own average. Add a 12% trailing stop on the stock funds only.',
    source: `name: Fast stocks, slow havens
universe: SPY, QQQ, TLT, GLD
rebalance: monthly

buy when close > sma(200)
sell when close < sma(200)

for SPY, QQQ:
  buy when close > sma(50)
  sell when close < sma(50)
  trailing stop: 12%`,
    notes: [],
    tags: ['sections', 'trend', 'stops', 'rebalance'],
  },
  {
    title: 'One early entry, a shared exit',
    description:
      'SPY, QQQ, IWM and EFA. Buy each above its 200-day average, except QQQ, which I want in earlier on the 50-day. Everything sells under the 200-day, and all four get a 10% stop loss.',
    source: `name: One early entry, a shared exit
universe: SPY, QQQ, IWM, EFA

buy when close > sma(200)

for QQQ:
  buy when close > sma(50)

for all:
  sell when close < sma(200)
  stop loss: 10%`,
    notes: [],
    tags: ['sections', 'for all', 'trend', 'stops'],
  },
  {
    title: 'A stop for each fund',
    description:
      'Hold SPY 40%, TLT 30% and GLD 30%, each only above its 150-day average, rebalanced every quarter. Stops: a 10% stop loss on SPY, 6% on TLT, and on gold an 8% trailing stop with a 30% take profit.',
    source: `name: A stop for each fund
universe: SPY 40%, TLT 30%, GLD 30%
rebalance: quarterly

buy when close > sma(150)
sell when close < sma(150)

for SPY:
  stop loss: 10%

for TLT:
  stop loss: 6%

for GLD:
  trailing stop: 8%
  take profit: 30%`,
    notes: [],
    tags: ['sections', 'stops', 'trend', 'rebalance'],
  },
  {
    title: 'Sectors with a market filter',
    description:
      "Buy XLK, XLV, XLF and XLE when they're above their 100-day average, but only while SPY is above its 200-day. Sell a fund under its 100-day, or all of them if SPY drops under its 200-day.",
    source: `name: Sectors with a market filter
universe: XLK, XLV, XLF, XLE

market_up = close of SPY > sma(200) of SPY

buy when close > sma(100) and market_up
sell when close < sma(100) or not market_up`,
    notes: [],
    tags: ['trend', 'filter', 'definitions', 'other tickers'],
  },
  {
    title: 'Stocks while the curve is normal',
    description:
      'Hold half SPY and half QQQ while the 10-year minus 2-year Treasury spread is above zero and the fund is above its 200-day average. Get out when the curve inverts or the trend breaks. Cash earns the 3-month T-bill rate.',
    source: `name: Stocks while the curve is normal
universe: SPY 50%, QQQ 50%
cash rate: fred:DGS3MO

curve_ok = close of fred:T10Y2Y > 0

buy when curve_ok and close > sma(200)
sell when not curve_ok or close < sma(200)`,
    notes: ["I used FRED's T10Y2Y for the spread and DGS3MO for the 3-month bill yield."],
    tags: ['fred', 'macro', 'filter', 'cash', 'definitions'],
  },
  {
    title: 'SPY unless unemployment rises',
    description: 'Stay in SPY unless unemployment is rising.',
    source: `name: SPY unless unemployment rises
symbol: SPY

jobless_rising = close of fred:UNRATE > sma(close, 12) of fred:UNRATE

buy when not jobless_rising
sell when jobless_rising`,
    notes: [
      'I read "rising" as the unemployment rate (FRED series UNRATE) being above its 12-month average.',
      'UNRATE has one reading a month, so its average covers the last 12 readings.',
    ],
    tags: ['fred', 'macro', 'filter', 'definitions'],
  },
  {
    title: 'BTC and ETH trend',
    description: "BTC and ETH from Binance, 60/40, daily bars: hold each while it's above its 100-day average. Costs are 10 bps.",
    source: `name: BTC and ETH trend
data: binance
universe: BTCUSDT 60%, ETHUSDT 40%
interval: 1d
costs: 10 bps

buy when close > sma(100)
sell when close < sma(100)`,
    notes: ['Binance quotes in USDT, so BTCUSDT and ETHUSDT stand for bitcoin and ether.'],
    tags: ['crypto', 'binance', 'trend', 'data'],
  },
  {
    title: 'Trend on Tiingo prices',
    description: 'Use my Tiingo key for the prices. SPY, QQQ and IWM, in the market above the 200-day average and out below it.',
    source: `name: Trend on Tiingo prices
data: tiingo
universe: SPY, QQQ, IWM

buy when close > sma(200)
sell when close < sma(200)`,
    notes: [],
    tags: ['tiingo', 'trend', 'data'],
  },
  {
    title: 'Tiingo stock, Yahoo bonds and bitcoin',
    description: 'Take SPY from Tiingo and the rest from Yahoo (say Yahoo outright). 70% SPY, 20% TLT, 10% bitcoin, put back to those weights each year.',
    source: `name: Tiingo stock, Yahoo bonds and bitcoin
data: yahoo
universe: tiingo:SPY 70%, TLT 20%, BTC-USD 10%
rebalance: yearly

buy when true`,
    notes: ['Yahoo spells bitcoin BTC-USD.'],
    tags: ['tiingo', 'yahoo', 'crypto', 'data', 'rebalance'],
  },
  {
    title: 'SPY and my gold file',
    description: 'My vault has Data/gold.csv with gold prices. Hold half in that file and half in SPY, each only while above its 100-day average.',
    source: `name: SPY and my gold file
universe: SPY 50%, csv:Data/gold.csv 50%

buy when close > sma(100)
sell when close < sma(100)`,
    notes: [],
    tags: ['csv', 'trend', 'data'],
  },
  {
    title: 'Stocks on my risk score',
    description:
      "My file Data/regime.csv has a daily column called risk_on, between 0 and 1. Keep 70% in SPY while it's above 0.5 and sell when it drops below 0.5. The other 30% sits in TLT all the time.",
    source: `name: Stocks on my risk score
universe: SPY 70%, TLT 30%

for SPY:
  buy when column(risk_on) of csv:Data/regime.csv > 0.5
  sell when column(risk_on) of regime < 0.5

for TLT:
  buy when true`,
    notes: [],
    tags: ['csv', 'signals', 'column', 'sections'],
  },
  {
    title: 'Top 2 by my own score',
    description:
      'I scored three funds myself and saved each as a CSV with prices and a score column: Data/spy_scored.csv, Data/efa_scored.csv and Data/eem_scored.csv. Each month hold the two with the highest score.',
    source: `name: Top 2 by my own score
universe: csv:Data/spy_scored.csv, csv:Data/efa_scored.csv, csv:Data/eem_scored.csv
rebalance: monthly
hold: top 2 by column(score)`,
    notes: [],
    tags: ['csv', 'signals', 'column', 'ranking', 'rotation'],
  },
  {
    title: 'Long above, short below the 200-day',
    description: 'SPY and QQQ: long above the 200-day average, short below it, flipping each way.',
    source: `name: Long above, short below the 200-day
universe: SPY, QQQ

buy when close > sma(200)
short when close < sma(200)`,
    notes: ['You gave no weights, so each fund gets half the equity, long or short.'],
    tags: ['shorts', 'trend', 'flip'],
  },
  {
    title: 'Large caps long, small caps short',
    description: "Be long SPY while it's above its 100-day average and short IWM while it's under its own 100-day, half the account each.",
    source: `name: Large caps long, small caps short
universe: SPY 50%, IWM 50%

for SPY:
  buy when close > sma(100)
  sell when close < sma(100)

for IWM:
  short when close < sma(100)
  cover when close > sma(100)`,
    notes: [],
    tags: ['shorts', 'sections', 'trend'],
  },
  {
    title: 'Short the weak sectors',
    description: 'Short JETS and KRE when each is under its 100-day average and buy them back once they close over their 50-day. My broker charges 2% a year to borrow.',
    source: `name: Short the weak sectors
universe: JETS, KRE
borrow fee: 2%

short when close < sma(100)
cover when close > sma(50)`,
    notes: ['You gave no weights, so each fund is sold short for half the equity.'],
    tags: ['shorts', 'borrow fee', 'trend'],
  },
  {
    title: 'Leveraged 60/40',
    description: 'Run a 60/40 at 2x: 120% SPY and 80% TLT, reset every quarter. Margin costs me 5% a year.',
    source: `name: Leveraged 60/40
universe: SPY 120%, TLT 80%
rebalance: quarterly
margin rate: 5%

buy when true`,
    notes: [],
    tags: ['leverage', 'margin', 'rebalance', 'portfolio'],
  },
  {
    title: 'Trend at 1.5x',
    description: 'Trend following on a few index funds, with a bit of leverage.',
    source: `name: Trend at 1.5x
universe: SPY, QQQ, EFA
size: 150%

buy when close > sma(150)
sell when close < sma(150)`,
    notes: [
      'You named no funds, so I used SPY, QQQ and EFA.',
      'I read "a bit of leverage" as 150% of the equity, shared equally between the funds.',
      'You gave no trend length, so each fund is held while above its 150-day average.',
    ],
    tags: ['leverage', 'size', 'trend'],
  },
  {
    title: 'Build in thirds',
    description:
      'SPY and QQQ, half each. Buy a first third of the position above the 100-day average, add another third each time the price is 3% over my last purchase, up to three. Sell under the 100-day average.',
    source: `name: Build in thirds
universe: SPY 50%, QQQ 50%
entries: 3

buy when close > sma(100)
add when close > last entry price * 1.03
sell when close < sma(100)`,
    notes: [],
    tags: ['entries', 'trend', 'adding'],
  },
  {
    title: 'SPY and QQQ held, no options',
    description: 'Hold SPY and QQQ and write monthly covered calls on both to collect the premium.',
    source: `name: SPY and QQQ held, no options
universe: SPY, QQQ

buy when true`,
    notes: ['Options are not supported, so there are no covered calls: this only holds the two funds, half each.'],
    tags: ['unsupported', 'options', 'buy and hold'],
  },
  {
    title: 'Oil and gold ETFs for futures',
    description: 'Trend-follow crude oil and gold futures: long when the market is trending up and flat otherwise.',
    source: `name: Oil and gold ETFs for futures
universe: USO, GLD

buy when close > sma(100)
sell when close < sma(100)`,
    notes: ['Futures are not supported, so USO and GLD, two ETFs that follow oil and gold, stand in.', 'You gave no trend length, so I used the 100-day average.'],
    tags: ['unsupported', 'futures', 'trend'],
  },
  {
    title: 'Seven large stocks, no P/E screen',
    description: 'Buy the 5 cheapest of AAPL, MSFT, JPM, XOM, JNJ, PG and KO by P/E ratio, rebalanced every quarter.',
    source: `name: Seven large stocks, no P/E screen
universe: AAPL, MSFT, JPM, XOM, JNJ, PG, KO
rebalance: quarterly

buy when true`,
    notes: [
      'The language has no earnings or valuation data, so there is no P/E ranking.',
      'This holds all seven equally and resets them each quarter. Narrow the list to your five cheapest by hand if you want only those.',
    ],
    tags: ['unsupported', 'fundamentals', 'rebalance'],
  },
  {
    title: 'Momentum, long leg only',
    description: 'Each month go long the 3 strongest of SPY, QQQ, IWM, EFA, EEM, TLT, GLD and DBC by 6-month momentum, and short the 3 weakest.',
    source: `name: Momentum, long leg only
universe: SPY, QQQ, IWM, EFA, EEM, TLT, GLD, DBC
rebalance: monthly
hold: top 3 by roc(126)`,
    notes: [
      'A ranking cannot go short, so the 3 weakest are not sold short: this holds the top 3 only.',
      'Six months is about 126 trading days, so the ranking uses roc(126).',
    ],
    tags: ['unsupported', 'rotation', 'ranking'],
  },
];
