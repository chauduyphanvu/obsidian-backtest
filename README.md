# Backtest Blocks

Write a trading strategy as a few readable rules in a note, and see its backtest drawn right under it. Long, short, or leveraged up to 2×.

```strategy
name: Trend following
universe: SPY
from: 2005-01-01
costs: 5 bps

buy  when close > sma(200)
sell when close < sma(200)
```

In reading view (or live preview, with the cursor outside the block) the block becomes its result:

- a sentence on how it did against buy and hold, then return per year, total return, worst drawdown, Sharpe ratio, volatility, time invested and trades side by side, and a chart of both you can read bar by bar, with the market's big falls marked;
- what it holds now, and the closes that would trigger its next order;
- every trade, with **Explain this trade** to see why it happened;
- sliders for parameters, sweeps of their ranges, and **Was it luck?** checks;
- regimes and crises, a price chart with the trades, and the rule values bar by bar.

The full guide to the language and the engine is [docs/reference.md](https://github.com/chauduyphanvu/obsidian-backtest/blob/main/docs/reference.md). In the editor, hovering a word shows what it means.

## Install

- Install from Obsidian's **Settings → Community plugins → Browse** once it's listed there. Until then, use [BRAT](https://github.com/TfTHacker/obsidian42-brat) with `chauduyphanvu/obsidian-backtest`.
- By hand: copy `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/chauduyphanvu/obsidian-backtest/releases) into `<vault>/.obsidian/plugins/backtest-blocks/`, then enable **Backtest Blocks** under Community plugins.

Needs Obsidian 1.11.4 or later. Tested on desktop (macOS); phone layouts have only been checked in Obsidian's mobile emulation.

## Quick start

1. Run **Insert strategy block** from the command palette and pick one of ten starters, or type a `strategy` block yourself.
2. Leave the block and the result appears. If something is underlined, hover it to see the problem, often with a one-click fix.
3. Change a number, or move a slider, and the result runs again.

## The language

A block is settings, optional parameters and definitions, and rules. Only `universe` and a buy or short rule are required.

```strategy
name: Three funds
universe: SPY 50%, TLT 30%, GLD 20%
from: 2010-01-01
rebalance: quarterly
costs: 5 bps
stop loss: 10%

n = 200 in 100..300 step 20

buy  when close > sma(n)
sell when close < sma(n)

for GLD:
  buy when close > sma(100) and rsi(14) < 70
```

**Settings**

| Setting | Example |
| --- | --- |
| Tickers and dates | `universe: SPY 60%, TLT 40%` · `from: 2010-01-01` · `to: 2024-12-31` · `test from: 2019-01-01` |
| Data | `data: yahoo` (or `binance`, `tiingo`) · `interval: 1d` (Binance down to `1m`) |
| Money and costs | `capital: 10k` · `costs: 5 bps` · `slippage: 2 bps` · `commission: 0.005 per share, min 1` · `cash rate: 4%` |
| Sizing | `size: 80%` · `rebalance: monthly` · `weighting: inverse volatility(60)` · `risk per trade: 1% at 2 atr(14)` · `entries: 3` |
| Ranking | `hold: top 3 by roc(126)` |
| Exits | `stop loss: 8%` · `trailing stop: 3 atr(14)` · `take profit: 20%` |
| Fills | `fill: close` (default: next open) · `magnify: 1h` (follow stops inside each bar) |
| Shorts and leverage | `borrow fee: 0.5%` · `margin rate: 6%` |
| Other | `name: My strategy` · `benchmark: QQQ` |

**Rules:** `buy when`, `sell when`, `short when`, `cover when`, `add when`. A rule continues on the next lines with `and` or `or`. Rules under `for TLT:` (or `for SPY, QQQ:`) apply to those tickers only; `for all:` goes back to the shared ones.

**Conditions:** `>` `<` `>=` `<=` `==` `!=`, `above`, `below`, `crosses above`, `crosses below` (`crosses` for either), `rsi(2) between 10 and 30`, `and`, `or`, `not`, `+ - * /`, brackets. `close > sma(50) for 3 bars` holds on each of the last 3 bars, and `within 3 bars` on at least one. `close[1]` is the previous bar; `sma(50) of SPY` reads another ticker.

**Values**

- Series: `open`, `high`, `low`, `close`, `volume`.
- Indicators: `sma` `ema` `wma` `hma` `rsi` `roc` `stdev` `highest` `lowest` `atr` `macd` `macd_signal` `bb_upper` `bb_lower` `keltner_upper` `keltner_lower` `stoch_k` `stoch_d` `adx` `plus_di` `minus_di` `cci` `williams_r` `mfi` `obv` `vwap` `supertrend` `supertrend_up` `median` `zscore` `percent_rank` `slope` `correl` `count` `bars_since` `min` `max` `abs`.
- Calendar: `month`, `day`, `weekday`, `year`, `month_start`, `month_end`.
- The open position: `bars held`, `entry price`, `last entry price`, `entries made`, `highest since entry`, `lowest since entry`, `position return`.
- A CSV column: `column(score) of signals`.

**Parameters:** `fast = 50 in 20..100 step 10` gives a slider and lets **Try other parameter values** sweep the range.

**Definitions:** `uptrend = close > sma(200)` names a condition or a number; use the name in rules, as in `buy when uptrend and rsi(2) < 10`.

**Tickers:** `SPY` (Yahoo), `binance:BTCUSDT`, `tiingo:SPY`, `fred:T10Y2Y` (an economic series, read in rules with `of`) or `csv:Data/gold.csv` (a file in your vault). Weights are optional and may add up to 200%.

## Shorts and leverage

```strategy
name: Trend, long or short
universe: SPY
from: 2005-01-01
costs: 5 bps

buy   when close > sma(200)
short when close < sma(200)
```

- `short when` opens a short and `cover when` closes it. With a buy rule and a short rule, a ticker flips sides on one signal.
- Weights above 100% borrow money, up to 2× the equity, long and short together.
- Shorts pay a borrow fee (0.5% a year by default). Borrowed money pays interest (6% a year by default).
- Below 25% equity to positions, a margin call closes everything at the next open. A run that loses all its equity stops there.

A block with no short rule and weights within 100% never borrows and pays none of this.

## More blocks

**Compare and combine** strategies from other notes. With weights, the block draws a combined line and suggests how to split between them:

```compare
[[Trend following]] 50%
[[Pullbacks#QQQ RSI pullback]] 50%
```

**All strategies in one table**, with their figures and next orders. The command **Insert strategy dashboard** adds one:

```backtests
sort: return
```

**An account** turns your strategies into orders in shares for a real account, and compares your broker's fills with the signals (Schwab, Fidelity, Interactive Brokers, or any CSV):

```account
name: Main brokerage
holdings: SPY 120, TLT 50
cash: 4,200

[[Trend following]] 60%
[[Pullbacks#QQQ RSI pullback]] 40%
```

**Forward tests:** **Start a forward test** under a result freezes the rules in a note of their own and measures only the bars that come after.

## Today's orders

**Show today's orders** (or the ribbon icon) runs every strategy in the vault and lists what to do at the next open or close, which closes to watch, and each account's orders. The status bar shows the count. The plugin never places an order: you place trades yourself.

## Commands

| Command | Does |
| --- | --- |
| Insert strategy block | Pick a starter strategy. |
| Use a CSV file in a strategy | Turn a CSV file into a ticker, a column or a small strategy. |
| Draft a strategy from a description | A model writes a draft from plain English (choose a provider in the settings first). |
| Open strategy preview | Shows the result of the block you're editing, in the sidebar. |
| Fix the problem at the cursor | Applies the "did you mean" fix. |
| Insert strategy dashboard | Inserts a `backtests` block. |
| Show today's orders | Opens the orders window. |
| Save this note's results to its properties | Writes each strategy's figures to `bt_` properties. |
| Clear saved prices | Removes the price cache. |

## Settings

Defaults for starting money, costs, slippage, commission, cash interest, the borrow fee and margin interest; where plain tickers come from; how long saved prices are kept; API keys for Tiingo, FRED and drafting, picked from Obsidian's secret storage, never stored by the plugin; and switches for the start-up order check and the ticker lookup.

## Network and privacy

The plugin contacts only these hosts:

- `query1.finance.yahoo.com` and `query2.finance.yahoo.com`: Yahoo prices, and ticker lookup while you type;
- `data-api.binance.vision`: Binance prices, and its list of markets for the ticker lookup;
- `api.tiingo.com` and `api.stlouisfed.org`: Tiingo prices and FRED series, only with your API key;
- `api.anthropic.com`, or a server address you enter: only when you draft a strategy.

On its own it does two things, and each has a setting to turn it off: the order check a few seconds after start-up, and the ticker lookup. Requests carry tickers, never the text of your notes. There is no telemetry, analytics or remote code. Prices are cached in the plugin's folder. The full list of requests is in the [reference](https://github.com/chauduyphanvu/obsidian-backtest/blob/main/docs/reference.md#network-requests).

## Limits

- A backtest on past prices predicts nothing. This is not financial advice.
- Fills happen at the next open or the close, with the costs, slippage and commission you set. Taxes, market impact and partial fills are not modelled.
- Yahoo and Tiingo prices are adjusted for dividends and splits, so compare prices with averages, not fixed numbers. Yahoo lists only tickers that exist today, which flatters baskets.
- Shorts are modelled simply: one borrow fee for every stock, with no hard-to-borrow lists, recalls or short-sale restrictions.
- The more variants you try on one history, the more the best one flatters. **Was it luck?** counts your tries and shows how much luck could explain.

The engine is checked by unit tests with hand-worked cases, and against a second, independent backtester. The reference says what [has and hasn't been checked](https://github.com/chauduyphanvu/obsidian-backtest/blob/main/docs/reference.md#how-far-to-trust-it).

## Development

```
npm install
npm test           # unit tests
npm run build      # type check, then bundle into dist/
npm run check      # everything a push or release must pass
```

Developed with Node 26. Release steps and the source layout are in the [reference](https://github.com/chauduyphanvu/obsidian-backtest/blob/main/docs/reference.md#development).

## Licence

MIT. See [LICENSE](https://github.com/chauduyphanvu/obsidian-backtest/blob/main/LICENSE).
