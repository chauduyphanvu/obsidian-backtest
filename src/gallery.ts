// Worked strategies to start from. Each one is a complete block, kept short, with one idea.

export interface Starter {
  title: string;
  /** What it does and when it tends to struggle. */
  description: string;
  /** The block's text, without the fence lines. */
  text: string;
}

export const STARTERS: Starter[] = [
  {
    title: 'Trend following on one fund',
    description:
      'The strategy holds SPY while the price is above its 200-day average. It goes to cash when the price goes below the average. It is weak in a market with no trend: the price crosses the average frequently, and each cross has a small cost.',
    text: `name: Trend following on one fund
universe: SPY
from: 2005-01-01
costs: 5 bps
slippage: 2 bps

buy  when close > sma(200)
sell when close < sma(200)`,
  },
  {
    title: 'Moving-average cross',
    description:
      'The strategy holds QQQ while a fast average is above a slow average. The two lengths have ranges, thus "Try other parameter values" can test them. The "test from" line shows the results before and after 2018. The averages change slowly, thus it is weak in a market that changes direction frequently.',
    text: `name: Moving-average cross
universe: QQQ
from: 2005-01-01
test from: 2018-01-01
costs: 5 bps
slippage: 2 bps

fast = 50 in 20..100 step 10
slow = 200 in 100..250 step 50

buy  when sma(fast) > sma(slow)
sell when sma(fast) < sma(slow)`,
  },
  {
    title: 'Buy dips in an uptrend',
    description:
      'The strategy buys SPY when the 2-day RSI is very low and the price is above its 200-day average. It sells when the RSI is more than 70, after 10 bars, or at an 8% stop loss. It is weak when a dip becomes a long downtrend.',
    text: `name: Buy dips in an uptrend
universe: SPY
from: 2005-01-01
costs: 5 bps
slippage: 2 bps
stop loss: 8%

buy  when rsi(2) < 10 and close > sma(200)
sell when rsi(2) > 70
  or bars held >= 10`,
  },
  {
    title: 'Add to a winner',
    description:
      'The strategy buys one third of a QQQ position when the price is above its 100-day average. After each close 3% above the last entry, it adds one third at the next open. The maximum is three entries. The 8% stop moves with the average entry price. It is weak when the price decreases immediately after the last add.',
    text: `name: Add to a winner
universe: QQQ
from: 2010-01-01
costs: 5 bps
entries: 3
stop loss: 8%

buy  when close > sma(100)
add  when close > last entry price * 1.03
sell when close < sma(100)`,
  },
  {
    title: 'Bitcoin breakout',
    description:
      'The strategy buys Bitcoin on Binance when it closes above its highest price of the last 55 days. The only exit is a trailing stop 3 average true ranges below the highest price since entry. It is weak when a breakout does not continue. Each trade also sells below its highest price, because the stop is below that price.',
    text: `name: Bitcoin breakout
universe: binance:BTCUSDT
from: 2019-01-01
costs: 10 bps
slippage: 5 bps
trailing stop: 3 atr(14)

buy when close > highest(55)[1]`,
  },
  {
    title: 'Momentum rotation',
    description:
      'Each month, the strategy holds the three funds (of six) with the best six-month change. It holds a fund only if that change is more than zero. The part for a fund that it does not hold stays in cash. It is weak when the best funds change quickly, because it buys a fund after its price increases.',
    text: `name: Momentum rotation
universe: SPY, QQQ, IWM, EFA, TLT, GLD
from: 2008-01-01
rebalance: monthly
costs: 5 bps
slippage: 2 bps
hold: top 3 by roc(126)

buy when roc(126) > 0`,
  },
  {
    title: 'Three funds with trend filters',
    description:
      'A 50/30/20 mixture of stocks, bonds and gold. The strategy rebalances to these weights each quarter. It holds each fund only while the price is above its trend line: 100 days for the bond fund and 200 days for the others. The benchmark is SPY. It is weak when stocks increase continuously, because the cash part has no return.',
    text: `name: Three funds with trend filters
universe: SPY 50%, TLT 30%, GLD 20%
from: 2008-01-01
rebalance: quarterly
costs: 5 bps
slippage: 2 bps
benchmark: SPY

buy  when close > sma(200)
sell when close < sma(200)

for TLT:
  buy  when close > sma(100)
  sell when close < sma(100)`,
  },
  {
    title: 'Weights by inverse volatility',
    description:
      'The strategy divides the money between four funds. The weight of each fund is in inverse proportion to its volatility in the last 60 days. The strategy calculates the weights again each month. It holds a fund only while the price is above its 150-day average. It is weak when the volatility of a fund increases suddenly.',
    text: `name: Weights by inverse volatility
universe: SPY 25%, EFA 25%, TLT 25%, GLD 25%
from: 2007-01-01
rebalance: monthly
costs: 5 bps
slippage: 2 bps
weighting: inverse volatility(60)

buy  when close > sma(150)
sell when close < sma(150)`,
  },
  {
    title: 'November to April',
    description:
      'The strategy holds SPY from November to April, and stays in cash from May to October. It tests a calendar pattern that did not occur in all periods. Use it as a test, not as a rule. It is weak when SPY increases much from May to October, because the strategy is in cash then.',
    text: `name: November to April
universe: SPY
from: 2000-01-01
costs: 5 bps
slippage: 2 bps

buy  when month >= 11 or month <= 4
sell when month >= 5 and month <= 10`,
  },
  {
    title: 'Trend, long or short',
    description:
      'The strategy holds SPY while the price is above its 200-day average, and sells it short while the price is below. At each cross, it changes from one side to the other. It is weak in a market with no trend, because each cross is a sale and a short sale, and the two have a cost. It is also weak when the price decreases and then increases quickly, because the short then has a loss.',
    text: `name: Trend, long or short
universe: SPY
from: 2005-01-01
costs: 5 bps

buy   when close > sma(200)
short when close < sma(200)`,
  },
];

export const EMPTY: Starter = {
  title: 'Empty block',
  description: 'One fund and one buy rule, as a start for your strategy.',
  text: `name: My strategy
universe: SPY
costs: 5 bps

buy when close > sma(200)`,
};

/** The text as a fenced block ready to put in a note, ending with a newline. */
export function blockOf(s: Starter): string {
  return `\`\`\`strategy\n${s.text}\n\`\`\`\n`;
}
