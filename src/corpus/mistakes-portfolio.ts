import type { CorpusMistake } from './types.ts';

/** Mistakes in multi-ticker and account-level blocks: weights, rankings, sections, sizing and data sources. */
export const PORTFOLIO_MISTAKES: CorpusMistake[] = [
  {
    title: 'A setting inside a for section',
    why: 'Inside a "for TICKER:" section only the rules and the three stops may appear; any other setting goes above the first "for" line or after "for all:".',
    broken: `name: 60/40 with a bond filter
universe: SPY 60%, TLT 40%

buy when close > sma(200)
sell when close < sma(200)

for TLT:
  buy when close > sma(100)
  sell when close < sma(100)
  rebalance: quarterly`,
    errors: [
      { line: 10, message: '"rebalance" is a setting for the full strategy. Put it above the first "for" line or after "for all:"' },
    ],
    fixed: `name: 60/40 with a bond filter
universe: SPY 60%, TLT 40%
rebalance: quarterly

buy when close > sma(200)
sell when close < sma(200)

for TLT:
  buy when close > sma(100)
  sell when close < sma(100)`,
  },
  {
    title: 'The same setting twice',
    why: 'A setting may be written only once in a block.',
    broken: `name: Three funds, monthly
universe: SPY, TLT, GLD
costs: 5 bps
rebalance: monthly
costs: 10 bps

buy when close > sma(150)
sell when close < sma(150)`,
    errors: [
      { line: 5, message: '"costs" is also set on line 3' },
    ],
    fixed: `name: Three funds, monthly
universe: SPY, TLT, GLD
costs: 5 bps
rebalance: monthly

buy when close > sma(150)
sell when close < sma(150)`,
  },
  {
    title: 'A cover rule that closes a long',
    why: 'A cover rule closes a short and is written only with a short rule; a long position is closed by a sell rule.',
    broken: `name: Trend with an exit
universe: SPY, QQQ

buy when close > sma(200)
cover when close < sma(200)`,
    errors: [
      { line: 5, message: '"cover when" closes a short. Thus it must have a short rule for SPY that tells when to go short, for example short when close < sma(200)' },
    ],
    fixed: `name: Trend with an exit
universe: SPY, QQQ

buy when close > sma(200)
sell when close < sma(200)`,
  },
  {
    title: 'A ranking that also shorts',
    why: 'A "hold" ranking only buys, so it cannot be combined with short or cover rules.',
    broken: `name: Momentum with a short side
universe: SPY, QQQ, IWM, EFA, EEM, TLT
rebalance: monthly
hold: top 3 by roc(126)

short when close < sma(200)
cover when close > sma(200)`,
    errors: [
      { line: 6, message: 'A strategy with "hold" cannot go short. Remove the short and cover rules. Or remove the "hold" line to trade each ticker with its rules' },
    ],
    fixed: `name: Momentum with a short side
universe: SPY, QQQ, IWM, EFA, EEM, TLT
rebalance: monthly
hold: top 3 by roc(126)`,
  },
  {
    title: 'Weights together with a ranking',
    why: 'With "hold" the universe carries no weights: each ticker held gets an equal share of the size.',
    broken: `name: Top 2 with weights
universe: SPY 40%, QQQ 30%, TLT 30%
rebalance: monthly
hold: top 2 by roc(126)`,
    errors: [
      { line: 2, message: 'Do not write weights in the universe when you use "hold". Each ticker that the strategy holds has an equal part of size' },
    ],
    fixed: `name: Top 2 with weights
universe: SPY, QQQ, TLT
rebalance: monthly
hold: top 2 by roc(126)`,
  },
  {
    title: 'Weights together with size',
    why: 'Give the weights in the universe or a size, never both.',
    broken: `name: Weights and size
universe: SPY 60%, TLT 40%
size: 80%
rebalance: quarterly

buy when true`,
    errors: [
      { line: 3, message: 'Use weights in the universe or "size". You cannot use the two together' },
    ],
    fixed: `name: Weights and size
universe: SPY 48%, TLT 32%
rebalance: quarterly

buy when true`,
  },
  {
    title: 'Weighting together with risk per trade',
    why: 'Size positions by "weighting" or by "risk per trade", never both.',
    broken: `name: Calm funds with a risk budget
universe: SPY, QQQ, IWM
weighting: inverse volatility(60)
risk per trade: 1% at 2 atr(14)

buy when close > highest(100)[1]
sell when close < lowest(50)[1]`,
    errors: [
      { line: 4, message: 'Use "weighting" or "risk per trade". You cannot use the two together' },
    ],
    fixed: `name: Calm funds with a risk budget
universe: SPY, QQQ, IWM
risk per trade: 1% at 2 atr(14)

buy when close > highest(100)[1]
sell when close < lowest(50)[1]`,
  },
  {
    title: 'Risk per trade with a rebalance',
    why: '"risk per trade" sizes a position once, when it is bought, so it cannot be combined with a rebalance other than never.',
    broken: `name: Rebalanced breakouts
universe: SPY, QQQ, IWM
rebalance: monthly
risk per trade: 1% at 2 atr(14)

buy when close > highest(100)[1]
sell when close < lowest(50)[1]`,
    errors: [
      { line: 4, message: '"risk per trade" sizes each position one time, when the strategy buys it. Thus you cannot use it with "rebalance: monthly". Remove one of them' },
    ],
    fixed: `name: Rebalanced breakouts
universe: SPY, QQQ, IWM
risk per trade: 1% at 2 atr(14)

buy when close > highest(100)[1]
sell when close < lowest(50)[1]`,
  },
  {
    title: 'Weights above 200%',
    why: 'Weights may add up to at most 200%, long and short positions together.',
    broken: `name: Too much leverage
universe: SPY 150%, TLT 100%
rebalance: quarterly

buy when true`,
    errors: [
      { line: 2, message: 'The total of the weights is 250.0%. It cannot be more than 200%: long and short positions together can be a maximum of 2 times the equity' },
    ],
    fixed: `name: Too much leverage
universe: SPY 100%, TLT 100%
rebalance: quarterly

buy when true`,
  },
  {
    title: 'A section for a ticker outside the universe',
    why: 'Every ticker in a "for" line must be in the universe.',
    broken: `name: Rules for a fund not held
universe: SPY, TLT

buy when close > sma(200)
sell when close < sma(200)

for QQQ:
  buy when close > sma(50)
  sell when close < sma(50)`,
    errors: [
      { line: 7, message: '"for QQQ:" names a ticker that is not in the universe' },
    ],
    fixed: `name: Rules for a fund not held
universe: SPY, TLT, QQQ

buy when close > sma(200)
sell when close < sma(200)

for QQQ:
  buy when close > sma(50)
  sell when close < sma(50)`,
  },
  {
    title: 'No universe',
    why: 'Every strategy needs a universe line, or a symbol line for one ticker.',
    broken: `name: Trend following
from: 2010-01-01
costs: 5 bps

buy when close > sma(200)
sell when close < sma(200)`,
    errors: [
      { line: 1, message: 'Add a universe, for example "universe: SPY" or "universe: SPY 60%, TLT 40%"' },
    ],
    fixed: `name: Trend following
universe: SPY
from: 2010-01-01
costs: 5 bps

buy when close > sma(200)
sell when close < sma(200)`,
  },
  {
    title: 'A ticker with no rule',
    why: 'Every ticker needs a buy rule or a short rule, a shared one or its own; only with "hold" is the buy rule optional.',
    broken: `name: Three funds, two with rules
universe: SPY, QQQ, TLT

for SPY:
  buy when close > sma(200)
  sell when close < sma(200)

for QQQ:
  buy when close > sma(100)
  sell when close < sma(100)`,
    errors: [
      { line: 1, message: 'There is no buy rule for TLT. Add one, for example "buy when close > sma(200)"' },
    ],
    fixed: `name: Three funds, two with rules
universe: SPY, QQQ, TLT

for SPY:
  buy when close > sma(200)
  sell when close < sma(200)

for QQQ:
  buy when close > sma(100)
  sell when close < sma(100)

for TLT:
  buy when close > sma(150)
  sell when close < sma(150)`,
  },
  {
    title: 'Two buy rules in one scope',
    why: 'Write at most one buy rule in a scope, and join conditions with "and" or "or" inside it.',
    broken: `name: Dip buyer
universe: SPY, QQQ

buy when close > sma(200)
buy when rsi(2) < 10
sell when rsi(2) > 70`,
    errors: [
      { line: 5, message: 'There are two buy rules. Put the conditions in one rule with "and" or "or"' },
    ],
    fixed: `name: Dip buyer
universe: SPY, QQQ

buy when close > sma(200) and rsi(2) < 10
sell when rsi(2) > 70`,
  },
  {
    title: 'A ticker section after a list that has it',
    why: 'A "for SPY, QQQ:" list already gives QQQ its rules, so a later "for QQQ:" may not write a rule of the same kind again.',
    broken: `name: Own entry for QQQ
universe: SPY, QQQ

for SPY, QQQ:
  buy when close > sma(200)
  sell when close < sma(200)

for QQQ:
  buy when close > sma(50)
  sell when close < sma(50)`,
    errors: [
      { line: 9, message: 'There are two buy rules for QQQ. Put the conditions in one rule with "and" or "or"' },
      { line: 10, message: 'There are two sell rules for QQQ. Put the conditions in one rule with "and" or "or"' },
    ],
    fixed: `name: Own entry for QQQ
universe: SPY, QQQ

for SPY:
  buy when close > sma(200)
  sell when close < sma(200)

for QQQ:
  buy when close > sma(50)
  sell when close < sma(50)`,
  },
  {
    title: 'Weights for only some tickers',
    why: 'Give every ticker in the universe a weight, or none of them.',
    broken: `name: Part weighted
universe: SPY 60%, TLT, GLD

buy when true`,
    errors: [
      { line: 2, message: 'Give each ticker a weight, or give no weights' },
    ],
    fixed: `name: Part weighted
universe: SPY 60%, TLT 20%, GLD 20%

buy when true`,
  },
  {
    title: 'A FRED series in the universe',
    why: 'A FRED series holds values, not prices, so a rule can read it with "of" but it cannot be traded.',
    broken: `name: SPY with the yield curve
universe: SPY, fred:T10Y2Y

buy when close > sma(200) and close of fred:T10Y2Y > 0
sell when close < sma(200)`,
    errors: [
      { line: 2, message: 'fred:T10Y2Y is a series of values from FRED, not prices. The strategy cannot trade it. Use it in a rule, for example close of fred:T10Y2Y > 0' },
    ],
    fixed: `name: SPY with the yield curve
universe: SPY

buy when close > sma(200) and close of fred:T10Y2Y > 0
sell when close < sma(200)`,
  },
];
