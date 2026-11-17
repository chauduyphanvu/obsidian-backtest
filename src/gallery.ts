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
      'Holds SPY while its price is above its 200-day average and moves to cash when it falls below. It tends to struggle in sideways markets, where the price keeps crossing the average and each crossing costs a little.',
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
      'Holds QQQ while a fast average is above a slow one. Both lengths declare ranges, so "Try other parameter values" can sweep them, and "test from" reports the years from 2018 apart. It reacts late, so it tends to struggle in choppy markets.',
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
    title: 'Dip buyer in an uptrend',
    description:
      'Buys SPY when a 2-day RSI is very low but the price is still above its 200-day average. It sells when RSI recovers, after 10 bars, or at an 8% stop. It tends to struggle when a dip turns into a long decline.',
    text: `name: Dip buyer in an uptrend
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
    title: 'Adding to a winner',
    description:
      'Opens a third of a QQQ position when it is above its 100-day average, then adds a third at the next open after each close 3% above the latest entry, up to three entries. The 8% stop moves with the average entry price. It tends to struggle when a rise reverses soon after the last add.',
    text: `name: Adding to a winner
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
      'Buys Bitcoin from Binance when it closes above its highest price of the last 55 days. The only exit is a trailing stop 3 average true ranges below the highest price since entry. It tends to struggle when breakouts fail and reverse, and it gives back part of each gain before the stop is hit.',
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
      'Each month, holds the three of six funds with the best six-month change, and only those whose change is above zero. A slot with no such fund stays in cash. It tends to struggle when leadership changes quickly, because it buys what has already risen.',
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
      'A 50/30/20 mix of stocks, bonds and gold, brought back to those weights each quarter. Each fund is held only while it is above its own trend line, a quicker 100-day line for the bond fund and 200 days for the others. It is compared with holding SPY alone, and it tends to struggle when stocks rise steadily and the cash share earns nothing.',
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
    title: 'Calm funds get more weight',
    description:
      'Four funds share their money in proportion to how calm each has been over the last 60 days, worked out again each month, and each is held only while above its 150-day average. It tends to struggle when a calm fund suddenly becomes volatile.',
    text: `name: Calm funds get more weight
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
      'Holds SPY from November to April and sits in cash from May to October. It tests an old calendar habit, which has not held in every period, so treat it as something to test and not a rule. It tends to struggle in strong summers, when it misses the gains.',
    text: `name: November to April
universe: SPY
from: 2000-01-01
costs: 5 bps
slippage: 2 bps

buy  when month >= 11 or month <= 4
sell when month >= 5 and month <= 10`,
  },
];

export const EMPTY: Starter = {
  title: 'Empty block',
  description: 'One fund and one buy rule to build on.',
  text: `name: My strategy
universe: SPY
costs: 5 bps

buy when close > sma(200)`,
};

/** The text as a fenced block ready to put in a note, ending with a newline. */
export function blockOf(s: Starter): string {
  return `\`\`\`strategy\n${s.text}\n\`\`\`\n`;
}
