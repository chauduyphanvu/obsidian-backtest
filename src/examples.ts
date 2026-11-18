/** A worked example: what a user asked for, the block that answers it, and the NOTE lines a writer adds. */
export interface Example {
  description: string;
  source: string;
  notes: string[];
}

export const EXAMPLES: Example[] = [
  {
    description: 'Buy SPY when it closes above its 200-day average, sell when it falls back below, 5 bps costs.',
    source: `name: SPY 200-day trend
universe: SPY
costs: 5 bps

buy when close > sma(200)
sell when close < sma(200)`,
    notes: [],
  },
  {
    description:
      'Hold 60% SPY and 40% TLT from 2010, rebalanced every quarter. Hold SPY only while it is above its 200-day average, with a 15% stop loss. Hold the bonds only while TLT is above its 100-day average, with an 8% stop. Cash earns 4%.',
    source: `name: 60/40 with trend filters
universe: SPY 60%, TLT 40%
from: 2010-01-01
rebalance: quarterly
cash rate: 4%
stop loss: 15%

buy when close > sma(200)
sell when close < sma(200)

for TLT:
  buy when close > sma(100)
  sell when close < sma(100)
  stop loss: 8%`,
    notes: [],
  },
  {
    description: 'Buy QQQ on sharp dips in an uptrend: RSI(2) under 10 while the price is above its 200-day average. Sell when RSI(2) goes over 70 or after 10 days. 5% stop loss, 5 bps costs, from 2005.',
    source: `name: QQQ RSI pullback
universe: QQQ
from: 2005-01-01
costs: 5 bps
stop loss: 5%

buy when rsi(2) < 10 and close > sma(200)
sell when rsi(2) > 70 or bars held >= 10`,
    notes: [],
  },
  {
    description: 'Every month, hold the 3 strongest of SPY, QQQ, IWM, EFA, TLT and GLD by 6-month momentum, but only those above their 200-day average. Otherwise stay in cash.',
    source: `name: Momentum rotation
universe: SPY, QQQ, IWM, EFA, TLT, GLD
rebalance: monthly
hold: top 3 by roc(126)

buy when close > sma(200)
sell when close < sma(200)`,
    notes: ['Six months is about 126 trading days, so the ranking uses roc(126).'],
  },
  {
    description: 'Moving-average crossover on QQQ: buy when the fast average is above the slow one, sell when it is below. I want to try fast from 20 to 100 and slow from 100 to 250. Judge it on data from 2018.',
    source: `name: QQQ moving-average crossover
universe: QQQ
test from: 2018-01-01

fast = 50 in 20..100 step 10
slow = 200 in 100..250 step 50

buy when sma(fast) > sma(slow)
sell when sma(fast) < sma(slow)`,
    notes: ['You gave ranges but no starting values, so I started fast at 50 and slow at 200.'],
  },
  {
    description: 'Short the S&P 500 with 2x leverage when it breaks below its 50-day average, and hedge with put options.',
    source: `name: SPY short at 2x below its 50-day average
universe: SPY 200%

short when close < sma(50)
cover when close > sma(50)`,
    notes: [
      'Options are not supported, so there is no put hedge: this is the short alone.',
      'The description does not say when to cover, so the short is bought back when SPY closes above its 50-day average again.',
      'SPY stands in for the S&P 500, and its weight of 200% sells short twice the equity.',
    ],
  },
];

export const PROMPT_EXAMPLES: string[] = EXAMPLES.map((e) => e.source);
