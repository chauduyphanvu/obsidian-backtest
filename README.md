# Backtest Blocks

Backtest Blocks is an Obsidian plugin that backtests a trading strategy written as a short block of rules inside a note. You write the rules in a code block marked `strategy`. The plugin gets prices (or reads a CSV file in your vault), runs the rules over that history, and draws the result in place of the block. A strategy is long or flat: each ticker is either held or not.

```strategy
name: Trend following
universe: SPY
from: 2005-01-01
costs: 5 bps

buy  when close > sma(200)
sell when close < sma(200)
```

Under the block you get the strategy's return per year, worst drawdown, Sharpe ratio and other figures next to buy and hold, a chart of both, the positions held now, and a list of every trade, each with the reasons for it. If the strategy has parameters, sliders run it again with other values. A result can be folded to one line.

The plugin also gives you:

- starter strategies, and a helper that turns a CSV file into a ticker or a small strategy;
- help while you write: colours, auto-complete, help on hover, "did you mean" fixes and a lookup of tickers;
- a preview panel that shows the result of the block you are editing;
- parameter sweeps and luck checks, which run in the background;
- `compare` blocks, which chart several strategies together, and `backtests` blocks, which list every strategy in the vault;
- today's orders, as a window and as a count in the status bar;
- saved results, and results written to note properties.

This README is the full guide to the plugin. Every `strategy`, `compare` and `backtests` block in it is checked by the plugin's own parser when the tests run.

## What it is not

- It is long or flat only. There is no shorting, no leverage and no options. Weights that add up to more than 100% are rejected, and a sell rule only closes a position you hold.
- It never places orders. "Today's orders" lists the orders your rules give and when each applies. You place any trade yourself, somewhere else.
- It is a backtest on adjusted historical prices. It shows what the rules would have done on past data. It does not predict anything.
- It is not financial advice.

It also does not model taxes, market impact or partial fills. A fill is at the next open (or with `fill: close` at the close the rule was read at, or at a stop or target level), made worse by the slippage you set, whatever the size of the trade.

## Install

Manual install:

1. Get `main.js`, `manifest.json` and `styles.css`: from a release if one is published, or build them (below).
2. Create the folder `<vault>/.obsidian/plugins/backtest-blocks/` and copy the three files into it.
3. In Obsidian, open Settings, then Community plugins. Turn off restricted mode if it is on, reload the plugin list, and enable Backtest Blocks.

The minimum Obsidian version is 1.11.4 (`minAppVersion` in `manifest.json`). The manifest does not mark the plugin desktop-only, but it has never been run on a phone (see "How far to trust it").

Two features use the network on their own: the check for orders at start-up, and the ticker lookup in the editor. Both are on by default and each has a setting (see "Network requests").

To build from source, run `npm install` and then `npm run build`. The three files land in `dist/`. The tests run `.ts` files directly with Node, so use a Node version that does that without flags; the project is developed and released with Node 26.

## Writing a strategy

### The shape of a block

A strategy is a code block whose language is `strategy`. The fence can be backticks or tildes. In reading view, and in live preview while the cursor is outside it, the block is replaced by its result. In source mode, or with the cursor inside it, you see the text; the strategy preview panel (see "Strategy preview") shows the result next to it.

Each line is one of these:

- a setting, written `key: value`, such as `universe: SPY`;
- a parameter, written `name = value`, such as `fast = 50`;
- a rule, starting with `buy when` or `sell when`, which may continue on the lines after it;
- a `for` line, which starts rules for one ticker;
- a comment, or a blank line.

Only `universe` is required, plus a buy rule. The one exception is `hold`, which makes the buy rule optional. Keywords, setting names, function names and parameter names do not care about capital letters.

The parser reads the whole block and reports every problem at once, with the line number. Settings and parameters can come in any order, and a parameter can be used above the line that declares it. What does depend on order is the `for` lines: after `for TICKER:`, rules and stops belong to that ticker until `for all:` (see "Per-ticker sections"). A good habit is settings first, then parameters, then the shared rules, then the `for` sections.

Dates are always written `2015-01-31`. A percentage is written with a percent sign (`5%`) and counts as the number 0.05 wherever a number is expected.

### Settings

| Setting | Example | What it does | Default |
| --- | --- | --- | --- |
| `name` | `name: Trend following` | Title shown above the result. | `Backtest` |
| `universe` | `universe: SPY 60%, TLT 40%` | The tickers to trade, each with an optional weight. Required. | none |
| `symbol` | `symbol: SPY` | Another way to write `universe`. | none |
| `from` | `from: 2015-01-31` | First day of the run. | the first day every ticker has prices |
| `to` | `to: 2024-12-31` | Last day of the run, whole day included. | the last day with prices |
| `data` | `data: binance` | Where plain tickers come from: `yahoo` or `binance`. | the plugin setting (Yahoo) |
| `interval` | `interval: 1h` | Bar size. Yahoo gives `1d` and `1w`. Binance gives `1m` `3m` `5m` `15m` `30m` `1h` `2h` `4h` `6h` `8h` `12h` `1d` `3d` `1w`. | `1d` |
| `capital` | `capital: 10k` | Starting money, as `10000` or `10k` (`m` is millions; `$`, commas and underscores are ignored). | the plugin setting (10000) |
| `costs` | `costs: 5 bps` | Cost of each trade, as `5 bps` or `0.05%`. A plain number is bps. Must be under 10%. | the plugin setting (0 bps) |
| `slippage` | `slippage: 5 bps` | How much worse each fill is than the price. Same forms as `costs`. | the plugin setting (0 bps) |
| `size` | `size: 80%` | Share of equity to use when the tickers have no weights. Up to 100%. | `100%` |
| `rebalance` | `rebalance: monthly` | `never`, `weekly`, `monthly`, `quarterly` or `yearly`. | `never` |
| `benchmark` | `benchmark: QQQ` | Ticker to compare with, bought and held. | your own tickers at their weights, bought and held |
| `stop loss` | `stop loss: 10%` | Sell this far below the entry price. Also written `2 atr(14)`. | none |
| `trailing stop` | `trailing stop: 15%` | Sell this far below the highest price since entry. Also `3 atr(14)`. | none |
| `take profit` | `take profit: 20%` | Sell this far above the entry price. Also `4 atr(14)`. | none |
| `cash rate` | `cash rate: 4%` | What cash earns a year, or a ticker that quotes a yield, such as `^IRX`. | the plugin setting (0%) |
| `test from` | `test from: 2019-01-01` | Reports the results before this day and from it apart. | none |
| `hold` | `hold: top 3 by roc(126)` | Hold only the best-ranked tickers. | none |
| `weighting` | `weighting: inverse volatility(60)` | Calmer tickers get more weight. | the weights as written |
| `risk per trade` | `risk per trade: 1% at 2 atr(14)` | Size each buy by what it risks. | the weight |
| `fill` | `fill: close` | When an order fills: `next open`, or `close` for the same close the rule was read at. | `next open` |

More on the values:

- `bps` means hundredths of a percent: 100 bps is 1%.
- `from` and `to` must be real dates, and `to` must come after `from`. `test from` must lie after `from` and before `to`.
- A setting can be written once. A second `capital:` line is an error.
- A stop loss or trailing stop must be above 0% and at most 99%. A take profit must be above 0% and at most 1000%.
- `2 atr(14)` means two average true ranges. `atr` alone means `atr(14)`, so `2.5 atr` works.
- `cash rate: 4` without a percent sign is an error, as is a rate above 50%.
- `hold: top 3 by roc(126)` means: hold the 3 tickers with the highest score. The universe must have at least that many tickers. The score is a number written like a value in a rule, so `roc(126)`, `close / sma(200)` or `-stdev(20)` all work. The ranking rules are under "How the simulation works".
- `weighting: inverse volatility(60)` measures volatility over the last 60 one-bar returns. The period must be at least 2.
- `risk per trade: 1% at 2 atr(14)` sizes each buy so that a fall of 2 average true ranges loses 1% of equity. It cannot be used with `weighting`, or with a `rebalance` other than `never`.
- `fill: close` fills each order at the close it was decided at, as a market-on-close order would, instead of at the next open. It applies to everything that otherwise fills at the next open: buys and sells from the rules, ranking decisions, rebalancing, and buying again after a stop. Stops and targets still fill inside a bar, and watch a position from the bar after the one it was bought at. The result notes that it assumes you can trade at the same close the rule read, and, when a rule or a ranking reads other tickers, which ones it read a bar early and which closes it took as known at the fill. The rules are under "How the simulation works", rule 6 for other tickers.
- `size`, `capital`, `costs`, `slippage`, `from`, `to`, `test from`, `rebalance`, `data`, `interval` and `fill` take written values only. Parameters can stand in for numbers in rules, stops, `hold`, `weighting` and `risk per trade` (see "Parameters and ranges").

### Tickers and sources

The `universe` line lists tickers, separated by commas, each with an optional weight: `universe: SPY 60%, TLT 40%`.

- A plain ticker comes from the source named by `data`, or by the plugin setting when the block has no `data` line.
- Put `yahoo:`, `binance:` or `csv:` in front of a ticker to choose its source: `universe: SPY, binance:BTCUSDT`.
- Write Yahoo tickers the way Yahoo spells them: `SPY`, `BRK-B`, `BTC-USD`, `^GSPC`. Binance tickers are market symbols such as `BTCUSDT`. Letters in Yahoo and Binance tickers are turned into capitals. A ticker may hold letters, digits and `^ . _ = -`.
- A CSV ticker is a path from the vault's root, such as `csv:Data/gold.csv`. The path cannot contain spaces or commas. Rules and the result call it by the file name without `.csv`, here `gold`.
- Sources can be mixed, but one `interval` applies to every ticker, so it has to be valid for the source of each one, the benchmark's included. A cash-rate ticker is the exception: it only needs daily closes.
- A ticker listed twice is an error.
- Two different sources cannot share a name in one block. A CSV file named like a ticker the block also uses, such as `csv:Data/SPY.csv` with `SPY`, gives "SPY is used for two different things here: yahoo:SPY and csv:Data/SPY.csv. Rename the CSV file or use one of them." This covers the universe, tickers read with `of`, the benchmark and the cash-rate ticker. Writing a CSV ticker's bare name, as in `close of gold`, reads that file.

Weights:

- A weight is a percentage after the ticker. Give every ticker a weight or none of them.
- Weights must add up to at most 100%. What is left stays in cash.
- With no weights, each ticker gets an equal share of `size` (100% unless you set it). You cannot give weights and `size` together.
- With `hold`, give no weights: each ticker held gets `size` divided by the number held.

### Rules and continuation lines

```
buy when <condition>
sell when <condition>
```

A buy rule opens a position in a ticker you do not hold when the condition is true at a close. A sell rule closes the position when it is true at a close. Both fill at that ticker's next open, or with `fill: close` at that same close. You can write one buy rule and one sell rule for each scope (see the next part). Without a sell rule a position is held until a stop closes it or the run ends.

A rule can continue on the following lines. Indent them and start each with `and` or `or`:

```strategy
universe: SPY
buy when close > sma(200)
  and rsi(14) < 70
sell when close < sma(200)
  or rsi(14) > 85
```

A rule ends at the first blank line, or at a line that is a setting, a parameter, a `for` line or another rule. Do not leave a blank line in the middle of a rule.

### Per-ticker sections

A line such as `for TLT:` starts a section for one ticker. `for all:` goes back to the rules every ticker shares.

- Rules written before any `for` line, or after `for all:`, are shared. They apply to every ticker that has no rule of its own for that side.
- A `buy when` or `sell when` inside `for TLT:` replaces the shared rule of the same side, for TLT only.
- Inside a `for` section you can also write `stop loss`, `trailing stop` and `take profit`. Each one replaces the shared setting of the same kind for that ticker. The kinds you leave out stay as they are in the shared settings.
- Any other setting inside a `for` section is an error, because it applies to the whole strategy. Put it above the first `for` line or after `for all:`.
- The ticker must be in the universe. For a CSV ticker, use the file name.
- Every ticker needs a buy rule, shared or its own.

### Conditions and operators

A condition compares numbers and joins the comparisons.

| Written | Means |
| --- | --- |
| `>` `<` `>=` `<=` `==` `!=` | The usual comparisons. |
| `above`, `below` | The same as `>` and `<`. You can write `is above` and `is below`. |
| `crosses above`, `crosses below` | `a crosses above b` is true on a bar where a is above b and was at or below b on the previous bar. `crosses below` is the mirror of it. |
| `and`, `or`, `not` | Join conditions. |
| `( )` | Group. |
| `+ - * /` | Arithmetic on numbers. A leading `-` negates. Dividing by 0 gives an unknown value. |
| `true`, `false` | Conditions that always or never hold. `always` and `never` mean the same. |
| `close[1]` | The value one bar earlier. The number must be a whole number, or a parameter that is one. |
| `sma(200) of SPY` | The value of another ticker (see below). |

From loosest to tightest, the order is:

1. `or`
2. `and`
3. `not`
4. comparisons (`>`, `<`, `>=`, `<=`, `==`, `!=`, `above`, `below`, `crosses above`, `crosses below`). They do not chain: write `a < b and b < c`, not `a < b < c`.
5. `+` and `-`
6. `*` and `/`
7. a leading `-`
8. `[n]` and `of`, then function calls and brackets

So `not close > 1 + 2 * 3 or close < 0 and volume > 5` reads as `(not (close > 1 + (2 * 3))) or ((close < 0) and (volume > 5))`.

A rule has to be a condition: `buy when sma(200)` is an error. Both sides of a comparison have to be numbers, and `and`, `or` and `not` need conditions on their sides. A rule can nest at most 64 levels of brackets, functions and operators, a long chain such as `a + b + c + ...` counting one level for each term; deeper is an error.

Another ticker: `sma(200) of SPY` and `close of ^VIX` read a value from a ticker that does not have to be in the universe. `of` applies to the value just before it, so write `(close - open) of SPY` to apply it to a whole expression. A ticker that is not in the universe is loaded from the default source (the `data` line or the plugin setting), or from the source you name, as in `close of binance:BTCUSDT`. For each bar of the rule's own ticker, you get the other ticker's latest bar that had ended by the time this bar ended (rule 6 under "How the simulation works"). Daily tickers on the same dates line up day for day; a weekly bar dated Monday is read from the following Monday, once its week is over. With `fill: close`, a ticker on other hours than the rule's own is read one bar earlier (rule 6).

Earlier bars: `close[5]` is the close five bars back. It works on any value: `highest(20)[1]` is the highest high of the 20 bars before this one.

### Series

These are the bar's own values for the ticker the rule belongs to: `open`, `high`, `low`, `close` and `volume`. With Yahoo data the prices are adjusted (see "How far to trust it").

### Functions

Most functions read a series and take one or more periods. Without a series they read the one in the table. To read another, write it first: `sma(volume, 20)`, or `sma(rsi(2), 5)`. Periods must be plain numbers or parameters, whole numbers from 1 to 10000. `slope`, `zscore`, `cci`, `hma` and `correl` need a period of at least 2. A Bollinger or Keltner `width` and the supertrend `mult` can be any number above 0. Empty brackets use the defaults: `macd()`, `rsi()`, `atr()`.

Some functions read the ticker's own high, low, close and volume and take no series, as `atr` does: `stoch_k`, `stoch_d`, `adx`, `plus_di`, `minus_di`, `cci`, `williams_r`, `mfi`, `obv`, `vwap`, `supertrend` and `supertrend_up`. `mfi`, `obv` and `vwap` need volume. A ticker whose prices have none, such as a CSV file without a `volume` column or an index with no volume, stops the run with "X has no volume, which mfi() needs". `bars_since` takes a condition instead of a series, and `correl` takes the other ticker's series first.

| Function | Arguments (defaults) | Meaning |
| --- | --- | --- |
| `sma` | `sma(n)` or `sma(series, n)` | Simple average of the last n closes. |
| `ema` | `ema(n)` | Exponential average. |
| `rsi` | `rsi(n = 14)` | Relative strength index, 0 to 100. |
| `roc` | `roc(n)` | Change over n bars, as a fraction. Compare it with a percentage: `roc(20) > 5%`. |
| `stdev` | `stdev(n)` | Standard deviation of the last n closes. |
| `highest` | `highest(n)` | Highest high of the last n bars, this bar included. Add `[1]` to leave out this bar. |
| `lowest` | `lowest(n)` | Lowest low of the last n bars, this bar included. |
| `atr` | `atr(n = 14)` | Average true range. It takes no series. |
| `macd` | `macd(fast = 12, slow = 26)` | Fast average minus slow average. |
| `macd_signal` | `macd_signal(fast = 12, slow = 26, signal = 9)` | Average of the macd line over `signal` bars. |
| `bb_upper` | `bb_upper(n = 20, width = 2)` | Upper Bollinger band: the average plus `width` standard deviations. |
| `bb_lower` | `bb_lower(n = 20, width = 2)` | Lower Bollinger band: the average minus `width` standard deviations. |
| `stoch_k` | `stoch_k(n = 14, smooth = 3)` | Stochastic %K, 0 to 100: where the close sits in the range of the last n bars, averaged over `smooth` bars. |
| `stoch_d` | `stoch_d(n = 14, smooth = 3, d = 3)` | Stochastic %D: `stoch_k` averaged over `d` more bars. |
| `adx` | `adx(n = 14)` | Average directional index, 0 to 100: how strong a trend is, whichever way it points. |
| `plus_di` | `plus_di(n = 14)` | Plus directional indicator, 0 to 100: how much of the range was upward movement. |
| `minus_di` | `minus_di(n = 14)` | Minus directional indicator, 0 to 100: how much of the range was downward movement. |
| `cci` | `cci(n = 20)` | Commodity channel index of the typical price. |
| `williams_r` | `williams_r(n = 14)` | Williams %R, -100 to 0: how far the close is below the highest high of the last n bars. |
| `mfi` | `mfi(n = 14)` | Money flow index, 0 to 100, a volume-weighted RSI. |
| `obv` | `obv()` | On-balance volume: a running total of volume, up on rising closes and down on falling ones. |
| `vwap` | `vwap(n = 20)` | Volume-weighted average of the typical price over the last n bars. |
| `keltner_upper` | `keltner_upper(n = 20, width = 2, atr = 10)` or `keltner_upper(series, n, width, atr)` | Upper Keltner channel: the exponential average plus `width` average true ranges. |
| `keltner_lower` | `keltner_lower(n = 20, width = 2, atr = 10)` or `keltner_lower(series, n, width, atr)` | Lower Keltner channel: the exponential average minus `width` average true ranges. |
| `supertrend` | `supertrend(n = 10, mult = 3)` | Supertrend line: under the price in an uptrend, over it in a downtrend. |
| `supertrend_up` | `supertrend_up(n = 10, mult = 3)` | A condition: true in an uptrend. `buy when supertrend_up(10, 3)` is a whole rule. |
| `wma` | `wma(n)` or `wma(series, n)` | Weighted average of the last n values; the newest weighs most. |
| `hma` | `hma(n)` or `hma(series, n)` | Hull moving average: smooth, with little lag. |
| `median` | `median(n)` or `median(series, n)` | Median of the last n values. |
| `zscore` | `zscore(n)` or `zscore(series, n)` | How many standard deviations the value is above its n-bar average. |
| `percent_rank` | `percent_rank(n)` or `percent_rank(series, n)` | Where the value ranks among the previous n values, 0 to 100. |
| `slope` | `slope(n)` or `slope(series, n)` | Least-squares slope over n bars, in the series' units per bar. Divide by the price for a fraction: `slope(90) / close > 0.1%`. |
| `correl` | `correl(other, n)` | Correlation, -1 to 1, between this ticker's close and another series, such as `correl(close of SPY, 60)`. |
| `bars_since` | `bars_since(condition)` | Bars since the condition was last true: `bars_since(close crosses above sma(50)) < 10`. |
| `min` | `min(a, b)` | The smaller value. |
| `max` | `max(a, b)` | The larger value. |
| `abs` | `abs(x)` | The value without its sign. |

How they are computed:

- Averages, `stdev`, `highest` and `lowest` need n known values, so the first n - 1 bars are unknown. `roc(n)` needs the value n bars back.
- `ema` smooths with 2 / (n + 1), starting from the simple average of the first n values.
- `rsi` and `atr` use Wilder's smoothing (1 / n), seeded the same way. The first true range is the first bar's high minus low.
- `stdev` divides by n, not by n - 1. The Bollinger bands use the same `stdev`.
- `macd_signal` is an exponential average of the macd line.
- `highest` reads the high and `lowest` the low, unless you give another series.

The functions added later each have one exact definition:

- `stoch_k` is 100 * (close - lowest low) / (highest high - lowest low) over the last n bars, averaged over `smooth` bars with a simple average (`smooth = 1` leaves it raw), and `stoch_d` is the simple average of that over `d` more bars. A range with no height gives no value. The first n + smooth - 2 bars are unknown.
- `williams_r` is -100 * (highest high - close) / (highest high - lowest low) over the last n bars.
- `cci` is the typical price, (high + low + close) / 3, minus its simple average over n bars, divided by 0.015 times its mean absolute deviation from that average. A window of equal values gives no value.
- `mfi` takes each bar's money flow, the typical price times the volume, as flowing in when the typical price rose from the bar before and out when it fell, adds up each over the last n bars, and gives 100 - 100 / (1 + in / out). With no flow out it is 100, and with none either way it is 50, as for `rsi`. The first n bars are unknown.
- `obv` starts at 0 on the first bar and then adds the bar's volume when the close rose and takes it off when it fell. It has no fixed starting level, so compare it with itself, as in `obv() > sma(obv(), 20)`, not with a number.
- `vwap` is the sum of the typical price times the volume over the last n bars, over the sum of their volume. It is a rolling average, not one that restarts each day, and it is unknown while none of the n bars traded.
- `plus_di`, `minus_di` and `adx` are Wilder's. The true range and the upward and downward movement (a rise in the high that is larger than the fall in the low, and the other way round) start with the second bar. Each is smoothed with Wilder's smoothing (1 / n) seeded with the simple average of the first n; the DI lines are 100 times the smoothed movement over the smoothed true range, and `adx` is the same smoothing of 100 * |+DI - -DI| / (+DI + -DI), seeded with the simple average of the first n of those. The first n bars of the DI lines are unknown, and the first 2n - 1 of `adx`. They start from the second bar, where `atr` counts the first bar's high minus low.
- `keltner_upper` and `keltner_lower` are the exponential average of the series (close, unless you give another) over n bars, as `ema` gives it, plus or minus `width` times the `atr` over `atr` bars, which always reads the ticker's own bars.
- `supertrend` has bands at (high + low) / 2 plus and minus `mult` times `atr(n)`. The upper band only falls and the lower only rises while the trend lasts: each takes the new value only when it is nearer the price, or when the close of the bar before had crossed it. In a downtrend the close above the upper band makes an uptrend, and in an uptrend the close below the lower band makes a downtrend. The line is the lower band in an uptrend and the upper band in a downtrend, and `supertrend_up` is true in an uptrend. The first bar where `atr` is known starts in a downtrend, so the trend a run starts with is the one the history before `from` leads to.
- `wma` weighs the last n values 1 to n, the newest n. `hma` is `wma` over the root of n (rounded down) of 2 * `wma` over half of n (rounded down) minus `wma` over n.
- `median` is the middle of the last n values, or the mean of the two middle ones when n is even.
- `zscore` is the value minus its simple average over n bars, divided by `stdev` of the same bars (which divides by n, not n - 1). A window of equal values gives no value.
- `percent_rank` is 100 times the number of the previous n values that are below this one, divided by n. Earlier values equal to this one do not count as below it. The first n bars are unknown.
- `slope` is the slope of the least-squares straight line through the last n values, against the bar number. A window of equal values has slope 0.
- `correl` is the Pearson correlation of the one-bar changes (value over the bar before, minus 1) of this ticker's close and of the series written first, over the last n bars. The other series is read as `of` reads it (rule 6): at each bar of this ticker, from the other ticker's latest bar that had ended, and with `fill: close` from one bar earlier on another clock. On a day when the other ticker had no new bar its change is 0. A series that does not change over the n bars gives no value.
- `bars_since` is 0 on a bar where its condition is true, and otherwise the number of bars since it last was. It is unknown until the condition has been true once, and after a bar where the condition was unknown it is unknown until the condition is next true. It counts back only as far as the prices loaded, which is the history the condition needs plus 250 bars (rule 4).
- Every function above that needs a full window gives no value while the window has fewer than n known values, so a gap of unknown values makes it unknown until it is full of known ones again. `adx`, `plus_di`, `minus_di`, `supertrend`, `supertrend_up` and `obv`, like `ema`, stay unknown once an unknown value has reached them.

### Calendar values

These are read from each bar's date in UTC.

| Value | Meaning |
| --- | --- |
| `month` | Month of the bar, 1 to 12. |
| `day` | Day of the month, 1 to 31. |
| `weekday` | 1 for Monday to 7 for Sunday. |
| `year` | The year, such as 2024. |
| `month_start` | A condition: the first bar of a month. |
| `month_end` | A condition: the last bar of a month. |

For example, `buy when month_end` or `sell when month == 5 and day > 20`.

### Position values

These belong to the open position, so only sell rules can read them.

- `bars held` (also written `bars_held`) is the number of completed bars since the buy filled. It is 0 on the bar of the fill.
- `entry price` (also written `entry_price`) is the price the position was bought at, slippage included.

They cannot be used in a buy rule or a `hold` score, inside a function (`sma(bars held, 2)`), with `[n]`, or with `of`. Write them with a space or an underscore, but not as the single words `bars` or `entry`.

```strategy
universe: SPY
buy when close > sma(200)
sell when bars held >= 20 or close < entry price * 0.9
```

### Parameters and ranges

A parameter is a named number on its own line:

```
fast = 50
```

Use the name wherever a plain number goes: in rules (`sma(fast)`, `close[lag]`, `rsi(n) < limit`), in `stop loss`, `trailing stop` and `take profit`, in `risk per trade`, in `weighting`, and in `hold` (`hold: top n by roc(20)`).

Add a range to say which values are worth trying:

```
fast = 50 in 20..100 step 10
stop = 8% in 4%..12% step 2%
```

- The value after `=` is the one the block uses. It must lie inside the range.
- `step` is optional. It defaults to 1, or to 1% for a percentage.
- A range can hold at most 200 values.
- Write `%` on every number of a percentage parameter. In a stop distance's share (`stop loss: stop`) and in `risk per trade`, use a percentage parameter. In a period, a `top` count or an ATR multiple, use a plain one. Inside a rule either works as a number: `limit = 3%` is 0.03.
- A name is letters, digits and underscores, and starts with a letter or underscore. It cannot be a word the language already uses: a series, a function, a one-word setting, a calendar value, or one of `and or not crosses above below is of buy sell when for all in step at top by true false always never min max abs bars entry bars_held entry_price`. `fast_ma`, `slow_ma` and `stop_pct` are safe.
- Declare a name once. Names do not care about capital letters. A parameter can sit anywhere in the block.

A range changes nothing by itself: the block runs with the value written. Every declared parameter gets a slider in the result (see "The Parameters bar" under "Reading a result"), and a range also enables "Try other parameter values".

### Comments

Everything after `#` or `//` is ignored, when the mark is at the start of a line or follows a space or tab:

```
buy when close > sma(200)   # the trend filter
```

### When something is wrong

The editor underlines the problem (see "Editing help"). In reading view the block shows "This strategy can't run yet", and lists each problem with its line number, its message and the line itself. For this block:

```text
universe: SPY
costs: lots
buy when close > smaa(200)
sell when bars held > 5 or
```

the messages are:

```text
Line 2: "lots" is not a cost. Write it as 5 bps or 0.05%
Line 3: Unknown name "smaa". Series: open, high, low, close, volume. Functions: sma, ema, rsi, roc, stdev, highest, lowest, atr, macd, macd_signal, bb_upper, bb_lower, stoch_k, stoch_d, adx, plus_di, minus_di, cci, williams_r, mfi, obv, vwap, keltner_upper, keltner_lower, supertrend, supertrend_up, wma, hma, median, zscore, percent_rank, slope, correl, bars_since, min, max, abs. Dates: month, day, weekday, year, month_start, month_end
Line 4: The rule ends too early
```

Besides errors, the parser gives one kind of note that does not stop the run: a comparison of a price with a fixed number on Yahoo data, such as `close > 100`. Yahoo prices are adjusted for later dividends and splits, so old prices are lower than what actually traded. Compare a price with an average, a percentage or an earlier price instead. There is no note when every ticker the comparison reads is an index (its ticker starts with `^`), because Yahoo does not adjust index levels. The note appears as an underline in the editor and under the title in the result.

### Worked examples

Each of these is a complete block.

**A mix with rebalancing and a rule for one ticker.** SPY is bought on the first day and held. TLT is held only while it is above its 100-day average. Both go back to 60% and 40% each quarter. The 15% stop is shared; TLT has a tighter 8% one of its own. Because `buy when true` is never false, SPY is not bought again after its stop closes it (see "Re-arming" in the next section).

```strategy
name: 60/40 with a bond trend filter
universe: SPY 60%, TLT 40%
from: 2010-01-01
rebalance: quarterly
cash rate: 4%
stop loss: 15%

buy when true

for TLT:
  buy when close > sma(100)
  sell when close < sma(100)
  stop loss: 8%
```

**A pullback with stops and a time exit.** Buy sharp dips in an uptrend. Sell when RSI recovers or once `bars held` reaches 10, and cut a bad trade at 5%.

```strategy
name: QQQ RSI pullback
universe: QQQ
from: 2005-01-01
costs: 5 bps
slippage: 2 bps
stop loss: 5%

buy when rsi(2) < 10 and close > sma(200)
sell when rsi(2) > 70
  or bars held >= 10
```

**Top-N rotation.** Each month, hold the 3 strongest of six ETFs by six-month momentum, but only those above their 200-day average. Choices are made on the last day of each month. A slot with no eligible ticker stays in cash. Weights are left out of the universe because `hold` gives each ticker held a third.

```strategy
name: Momentum rotation
universe: SPY, QQQ, IWM, EFA, TLT, GLD
from: 2008-01-01
rebalance: monthly
hold: top 3 by roc(126)

buy when close > sma(200)
sell when close < sma(200)
```

**Inverse-volatility weighting.** Four ETFs with base weights, each held while above its 150-day average. Calmer ones get more of the combined weight of those held, and the shares are worked out again each month.

```strategy
name: Inverse volatility
universe: SPY 30%, TLT 30%, GLD 20%, DBC 20%
from: 2007-01-01
rebalance: monthly
weighting: inverse volatility(60)

buy when close > sma(150)
sell when close < sma(150)
```

**Filling at the close.** The same trend rule on SPY, but each order fills at the close the rule was read at, as a market-on-close order would, instead of at the next open. The result assumes you can trade at that closing price. A real order can only come near it, by being placed just before the close.

```strategy
name: Trend at the close
universe: SPY
from: 2010-01-01
costs: 5 bps
slippage: 2 bps
fill: close

buy when close > sma(200)
sell when close < sma(200)
```

**Parameters with ranges, and a test date.** Three numbers have ranges. The results before 2018 and from 2018 on are reported apart.

```strategy
name: QQQ moving-average crossover
universe: QQQ
from: 2005-01-01
test from: 2018-01-01
costs: 5 bps

fast = 50 in 20..100 step 10
slow = 200 in 100..250 step 50
stop = 8% in 4%..12% step 2%

buy when sma(fast) > sma(slow)
sell when sma(fast) < sma(slow)
stop loss: stop
```

**Another ticker as a filter.** Hold QQQ while it is above its 200-day average and the VIX is below 25. Leave when the trend breaks or the VIX goes above 35. The VIX is not in the universe, so it is only read, never traded. It is an index, which Yahoo does not adjust, so comparing it with a fixed number gets no note.

```strategy
name: QQQ unless volatility spikes
universe: QQQ
from: 2005-01-01
costs: 5 bps

buy when close > sma(200) and close of ^VIX < 25
sell when close < sma(200)
  or close of ^VIX > 35
```

**Trend direction and strength.** Hold SPY while the supertrend points up, the trend is strong (ADX above 20) and the close is above its 50-bar volume-weighted average. Leave as soon as the supertrend turns down. `supertrend_up` is a condition, so it needs no comparison.

```strategy
name: Supertrend with trend strength
universe: SPY
from: 2005-01-01
costs: 5 bps

buy when supertrend_up(10, 3) and adx(14) > 20 and close > vwap(50)
sell when not supertrend_up(10, 3)
```

**A dip after a fresh high, away from bonds.** Buy QQQ when the stochastic is oversold within 30 bars of a 100-bar high, and its returns do not move with TLT's. Sell when the stochastic is overbought, or 60 bars after the last 100-bar high. `bars_since` counts from the last bar its condition was true, and `correl` reads TLT as `of` does.

```strategy
name: Oversold dips after a high
universe: QQQ
from: 2005-01-01
costs: 5 bps

buy when stoch_k(14, 3) < 20
  and bars_since(close > highest(100)[1]) < 30
  and correl(close of TLT, 60) < 0.3
sell when stoch_k(14, 3) > 80
  or bars_since(close > highest(100)[1]) > 60
```

**Binance, hourly bars, ATR stop and risk sizing.** A breakout on hourly bars. The stop sits 3 average true ranges below the fill. The position is sized so that a fall to that distance loses 1% of equity, up to the weight (here 100%). Set `from` on short intervals: the plugin stops after 300 requests of 1000 bars each.

```strategy
name: BTC hourly breakout
data: binance
universe: BTCUSDT
interval: 1h
from: 2023-01-01
costs: 10 bps
slippage: 5 bps
stop loss: 3 atr(24)
risk per trade: 1% at 3 atr(24)

buy when close > highest(48)[1]
sell when close < lowest(24)[1]
```

**A CSV file.** The file is in the vault at `Data/gold.csv`, with a header row:

```csv
date,open,high,low,close,volume
2024-01-02,2063.5,2078.1,2049.0,2062.4,1200
2024-01-03,2062.4,2070.0,2038.8,2041.9,1500
```

```strategy
name: Gold from my own file
universe: csv:Data/gold.csv
capital: 25k
costs: 3 bps

buy when close > sma(100)
sell when close < sma(100)
```

The formats a CSV file can take are listed under "Prices and privacy".

### Starter strategies

The command "Insert strategy block" opens a window called "Start from a strategy". It lists eight strategies and an "Empty block", each with a few lines on what it does and when it tends to struggle. Choose an entry with the mouse or the arrow keys (Home and End jump to the first and last) to see its text, coloured as it is in a result. "Insert", Enter, or a double-click on an entry puts the block at the cursor of the note you are editing, on its own line. The command works only while a note is open for editing.

| Starter | What it shows |
| --- | --- |
| Trend following on one fund | A buy and a sell rule on one fund, with costs and slippage. |
| Moving-average cross | Parameters with ranges, for "Try other parameter values", and `test from`. |
| Dip buyer in an uptrend | A short RSI, an exit by `bars held`, and a stop loss. |
| Bitcoin breakout | A Binance ticker, a breakout rule and an ATR trailing stop as the only exit. |
| Momentum rotation | `hold: top 3 by roc(126)`, chosen monthly. |
| Three funds with trend filters | Weights, quarterly rebalancing, a `for` section and a benchmark. |
| Calm funds get more weight | `weighting: inverse volatility(60)`. |
| November to April | The `month` calendar value. |

The starters are examples of the language, not advice. Each is long or flat and charges costs and slippage. How a strategy did on past prices says nothing about future prices (see "How far to trust it").

## How the simulation works

These are the engine's rules. Each is exact.

**Timing**

1. Rules are read at the close of each bar. A buy or sell that is true at a close fills at that ticker's next open, the next bar of that ticker. With `fill: close` it fills at that same close instead, and so does everything else that would fill at the next open: ranking decisions, rebalancing and buying again after a stop (rules 17, 18, 23, 26, 27 and 31 say how).
2. An order from the last bar in the prices is not filled. It stays pending and is reported in the result and in "Today's orders". With `fill: close` it has filled at that last close, so nothing is left pending, except an order from a ranking decision made at a time a ticker had no bar, which fills at that ticker's next close.
3. The run starts on `from`, or on the first day every ticker in the universe has prices if that is later. Tickers read only with `of`, and the benchmark, do not delay the start. The result warns when the run starts more than 7 days after `from`. It ends on `to`, or on the last bar.
4. Bars before the start feed the indicators. With `from` set, every ticker's prices start a lookback before it: the longest chain of windows and lags in the block's rules, `hold` score, ATR stops and sizing. Nested windows add up, `[n]` adds n, and `ema`, `rsi`, `atr`, `macd`, `plus_di`, `minus_di`, `keltner_upper`, `keltner_lower`, `supertrend` and `supertrend_up` count five times their period, and `adx` ten times, because they depend on where they started. `bars_since` adds 250 bars to what its condition needs, and counts back no further than the prices loaded. A period or lag given by a parameter with a range counts at the largest value of its range, so the sliders, "Try other parameter values" and "Was it luck?" can try any value in it on the prices already loaded. The lookback is at least 250 bars, and for daily and longer bars it reaches 1.6 times as far in calendar time, for weekends and holidays. Older prices are left out even when they are saved, so the same block gives the same result every time. Without `from`, the whole history is used.
5. The run has one step for each time at which any ticker in the universe has a bar. A ticker with no bar that day keeps its last close for valuing the position.
6. A value read with `of`, the benchmark's value and a cash-rate ticker's yield come from that series' latest bar that had ended by the end of the strategy's bar. A bar ends at its start plus its series' step, the shortest gap between its bars. From a step of 20 days on, the step is counted in calendar months, so a monthly bar dated the 1st ends on the 1st of the next month. Daily series on the same dates line up day for day, whichever days each trades; a weekly bar dated Monday is read from the following Monday; an hourly rule reads a daily bar from that day's 23:00 bar on. With `fill: close`, a rule reads a ticker that keeps other hours than its own ticker one bar early: from that ticker's latest bar that had ended by the time the rule's own bar began, so never its bar of the same day, week or hour. Two tickers keep other hours when the prices show it: they come from different sources (Yahoo, Binance or a CSV file), they have bars on different days of the week (crypto trades at weekends, stocks do not), or their bars are of different sizes. A stock's rule that reads `close of binance:BTCUSDT` therefore reads Bitcoin's previous day, and an hourly rule reads a daily bar from the next day's first hour on. Tickers on the same hours are read as before, and the result notes that it takes the other ticker's close as known at the moment of the fill, which is not true for a market that closes later, such as a New York stock read by a Tokyo one. Binance tickers of one bar size all close at the same moment and get no such note. The benchmark and a cash-rate ticker decide no orders and are read the same way with either fill.

**Sizing and cash**

7. Equity is cash plus every position at its latest close. Money is in cash until a rule buys. Positions can hold fractions of a share.
8. A buy of a ticker with weight w spends w times equity, valued at the open of the fill (at its close with `fill: close`), but never more than the cash available. The rest stays in cash.
9. A position is sized once, when it is bought. It then drifts with the price until it is sold or a rebalance resizes it.
10. With `weighting: inverse volatility(n)`, the tickers being held or bought share out the sum of their configured weights in proportion to 1 divided by their volatility, the standard deviation of the last n one-bar returns up to the last close before the fill (up to the fill's own close with `fill: close`). A ticker whose volatility is 0 keeps its configured weight.
11. With `risk per trade: r at m atr(n)`, the buy is for r times equity, divided by m times the ATR, shares. The ATR is its value at the close before the fill (at the fill's own close with `fill: close`). The value of the buy is capped at the ticker's weight, and the size is fixed at entry. The distance used for sizing is separate from any `stop loss` line.

**Warm-up**

12. A buy is not taken while an input it needs is still unknown at the close of the signal: the ATR for `risk per trade`, the volatility for `weighting: inverse volatility`, or the ATR of an ATR stop loss, trailing stop or take profit. The buy fills after the first later close at which the inputs are known and the buy rule still holds. In a `hold` strategy the ticker is skipped until the next decision.
13. The result notes how many buy signals each such input held back (signals on consecutive bars count once). It also notes when a buy rule or `hold` score was unknown for more than 5 bars at the start of the run, with the day it became known.

**Costs, slippage and interest**

14. `costs` is a percentage of the value of every fill: buys, sells, stops, targets and rebalancing trades. On a buy it is paid on top of the price; on a sell it comes out of the proceeds.
15. `slippage` makes each fill worse by that fraction: a buy fills at the price times (1 + slippage), a sell, including a stop or a target, at the price times (1 - slippage). Costs are charged on the slipped value.
16. Between two bars, cash earns the rate times the calendar days between them divided by 365, using the rate known at the earlier bar. With a ticker, the rate is the close of its latest bar that had ended by the end of the earlier bar (rule 6), read as a yearly percentage: a close of 4.2 is 4.2%. Before that ticker's first such bar cash earns nothing. Only cash earns interest.

**Rebalancing**

17. With a `rebalance` other than `never`, each held ticker goes back to its target weight at the open of its own first bar in each new period, so a ticker that does not trade on the period's first day is rebalanced at its first bar after it. The weight is measured against equity at that open. Sells are made before buys. A rebalance resizes held positions only; it never opens one. Weeks start on Monday; months, quarters and years follow the calendar in UTC. With `fill: close` each held ticker goes back to its target weight at the close of its own last bar in each period instead, measured against equity at that close: the same close at which a ranking decides.
18. When a ticker's top-up finds too little cash, for example because another ticker is trimmed only at its own first bar a day later, the rest stays wanted. It is bought at that ticker's later bars in the same period as cash comes in, and lapses when the period ends. With `fill: close` a top-up decided at a period's last close stays wanted at the ticker's closes in the next period, and lapses at its next rebalance. A position sold or stopped in the meantime is owed nothing. A top-up only spends cash there is, so nothing is borrowed.
19. Rebalancing trades are slipped and charged like any other. They change a position without closing it, so they are not listed as trades.
20. With inverse-volatility weighting, the weights are worked out again at each rebalance.

**Stops, targets and gaps**

21. Stops and targets are set when the position opens, from the fill price, slippage included. A stop loss is the fill price times (1 - x), or the fill price minus x ATR. A take profit is the fill price times (1 + x), or the fill price plus x ATR.
22. An ATR distance uses the ATR at the close before the fill (at the fill's own close with `fill: close`) and keeps it for the life of the position. That ATR is always known, because a buy waits for it (rule 12).
23. The trailing level is the highest high since entry times (1 - x), or minus x ATR. It moves only at the end of a bar: a bar's high counts from the next bar on. On the entry bar it trails the open. With `fill: close` it starts from the close the position was bought at.
24. After the bar's open orders, each position is checked against the bar. If the low reaches the stop (the higher of the stop loss and the trailing level), it exits at the stop, or at the open if the bar opened below it. If the high reaches the take profit, it exits at the target, or at the open if the bar opened above it.
25. If both levels lie inside the bar, the stop is taken first. If the bar opens at or above the target, the target fills at the open, even if the bar later falls through the stop.
26. A position can be stopped out on the bar it is bought. With `fill: close` it cannot: it was bought at that bar's close, after the bar's range, so its stops and target watch it from its next bar on.
27. Within a bar, the order is: pending sells fill at the open; then the rebalance (with any top-up still owed) and pending buys, sells first; then stops and targets; then, at the close, the rules are read for the next open. With `fill: close`: stops and targets; then, at the close, the rules are read and what they decide fills at once, sells first, then the rebalance (with any top-up still owed) and the buys; then the positions are valued at that close.
28. A sell rule and the stops both apply, whichever comes first. A buy is skipped when the sell rule is also true at the same close.

**Re-arming**

29. After an exit by stop loss, trailing stop or take profit, the buy rule has to be false, or unknown, at one close before it can buy that ticker again. A sell-rule exit does not wait. In a `hold` strategy this rule does not apply: a stopped-out ticker can be chosen again at the next decision.

**Ranking (`hold`)**

30. With `hold: top N by score`, a decision is made at each close when `rebalance` is `never`, and otherwise at the last bar of each period. The tickers that can be chosen are those whose buy rule is true (every ticker if there is no buy rule), whose sell rule is not true, and whose score is known.
31. The N highest scores are chosen. Ties go to the ticker listed first. Held tickers not chosen are sold at their next open. Chosen tickers not held are bought once every sell of that decision has filled, at their own next open from then on: the same open as the last sell when both trade then. With `fill: close` the sells and buys fill at the decision's close; a ticker with no bar at that time trades at its next close, and the buys wait for its sell. A buy that has not filled stays wanted until it fills or the next decision replaces it, and a decision that keeps a ticker cancels a sell of it that has not filled. When cash is short, the best score is bought first. With `fill: close` and ranked tickers that keep different hours (rule 6), a decision made at a time when tickers on different hours have a bar reads every ticker's previous bar (its buy rule, sell rule and score) and fills at the decision's close; when only tickers on one set of hours have a bar, it reads their bars and the others' latest finished ones. A ticker read a bar early is still sold by its own sell rule at its close, and is not bought at a close where its sell rule holds.
32. Between decisions, a sell rule or a stop can still exit a position. The freed slot waits for the next decision. Each ticker held gets `size` divided by N.

**Unknown values**

33. A value is unknown while an indicator is still warming up, when you look back past the start of the data, when a ticker read with `of` has no bar that has ended yet, after a division by 0, and when `crosses` needs a previous bar that is unknown. `bars_since` is unknown until its condition has been true. `month_start` is unknown on the first bar of the data.
34. A comparison with an unknown value is unknown. `and` is false if either side is false, and otherwise unknown if either side is unknown. `or` is true if either side is true, and otherwise unknown if either side is unknown. `not` of unknown is unknown.
35. A rule only fires when it is true. Unknown never buys or sells, and counts as "not holding" for the re-arm rule.

**Benchmark, statistics and the split**

36. The benchmark holds the same weights as the strategy (or the one ticker you name) from the first open the strategy could have bought at (the first close with `fill: close`), with the same costs, slippage, fills, rebalancing and cash rate, and no rules or stops. A `hold` strategy is compared with holding every ticker in equal parts of the same total size.
37. A benchmark whose prices start after the run does is measured from its own first bar. Before then it has no value, its line starts there, and its figures, and those of each `test from` part, cover only its own dates. The result notes it when the benchmark starts more than 7 days after the run.
38. Return per year is the compound growth rate over the time the run covers, in years of 365.25 days. Worst drawdown is the lowest value of equity divided by its highest previous value, minus 1, at the closes.
39. Sharpe ratio: for each step, take the return of equity minus what cash earned over the same step. Divide the mean of those by their standard deviation (dividing by the count, not by the count minus 1), and multiply by the square root of the steps in a year, where steps a year is the number of steps divided by the years covered. It is not scaled with 252. The benchmark's Sharpe ratio is worked out the same way.
40. The Sortino ratio takes the same returns above cash and divides their mean by their downside deviation: the square root of the mean, over every step, of the squared returns below 0 (a step at or above 0 counts as 0). It is scaled the same way, and is the same figure in the parameter sweep and under "More statistics".
41. A Sharpe or Sortino ratio is 0 when the deviation it divides by is below 1e-12 a step. That is rounding noise, not risk: a run that only earns a fixed cash rate would otherwise show a ratio made of noise, such as -3.42.
42. The volatility shown under "Time invested" is the standard deviation of the one-step returns times the same square root. "Time invested" is the average share of equity held in positions at the closes.
43. The trade count and the share won count closed trades only. A trade is won when its return after costs is above 0. A position still open at the end is not sold in the run: equity values it at the last close, and it is listed as "still held". Its return counts the exit cost as if it were sold at that close, without slippage.
44. A trade's return is its sell price times (1 - costs) over its buy price times (1 + costs), minus 1, with slippage in both prices. Its profit is cash in and out of that ticker, rebalancing trades included.
45. `test from` splits one run in two, at that date. It is not a second run: nothing is reset or re-fitted, and a position open at the date carries over. Each part is measured from the last close before it, so the second part includes the move into its first day and the two parts' growth multiplies to the whole run's. A trade belongs to the part in which it was bought.

## Reading a result

From the top:

1. **Title and summary.** The `name` (or "Backtest"), on a button that folds the result to one line (see "Folding a result"). Then a line of what was run: tickers and weights, sizing, rebalancing, bar size, costs, slippage, stops, and parameter values. Percentages are written as the block writes them (`12%`, not `12.0%`), and a parameter that is a stop is shown once, as the stop.
2. **Refresh prices.** A button that fetches the prices again and runs the block again.
3. **The strategy as written**, coloured.
4. **Parameters.** Only when the strategy declares parameters: a bar with a slider for each one (see "The Parameters bar").
5. **Notes.** Prices that could not be refreshed (see "Prices and privacy"); notes from the run itself: buy signals held back while a sizing or stop input warmed up, a buy rule or `hold` score still unknown at the start of the run, a benchmark whose prices start later, and, with `fill: close`, that the run assumes you can trade at the close the rule read, and which other tickers it read a bar early or took as known at the fill; the parser's notes with their line number; and a warning when the run starts more than 7 days after `from`.
6. **Six figures.** Return per year, total return, worst drawdown and Sharpe ratio, each with the benchmark's value underneath. Then "Time invested", with volatility a year underneath. Then "Trades": the count of closed trades, how many were won and the average return. It says "none closed yet" when only open positions exist, and "the buy rule never fired" when there were none.
7. **The chart.** The strategy and the benchmark on a log scale, with the final value of each in the key above it. Underneath, the drawdown from the previous high. Hover or tap to see the date, both values, both drawdowns and the share invested. A benchmark whose prices start later is drawn from its first value, and shows "–" before it. With `test from`, the test period is shaded.
8. **A short note.** The dates, the starting money, "A rule seen at a close fills at the next open." (with `fill: close`: "A rule seen at a close fills at that close."), costs paid, and interest earned on cash. Then "Prices through" a date, from Yahoo, Binance or your CSV files.
9. **Before and after the test date**, only with `test from`. A table of return per year (strategy and benchmark), worst drawdown, Sharpe ratio and trades, for each part.
10. **Positions.** One row for each ticker: its weight, whether you are long since a date or in cash, whether an order is waiting (for the next open, or with `fill: close` for the next close) or was made at the last close, the closed trades, the share won and the average trade.
11. **Trades.** A list you open, newest first: a button, ticker, bought, price, sold, price, return after costs, profit and how it ended: "sell rule", "stop loss", "trailing stop", "take profit" or "still held". It shows the latest 500 trades. Intraday times are in UTC. The button at the start of each row, "Explain this trade", says why the trade happened (see "Explaining a trade").
12. **More statistics.** A table for the strategy and the benchmark: Sortino ratio, return per year divided by worst drawdown, best and worst year, the share of months with a gain, the longest time below a previous high, and best and worst month. Then a chart of the return in each calendar year, and a table of the strategy's return by month. Years the data only partly covers are faded. The Sortino ratio here takes off what cash earned, like the Sharpe ratio, and is the same figure as in the parameter sweep (rule 40 under "How the simulation works"). A benchmark whose prices start later is measured from its first value.
13. **Prices and trades.** The price of one ticker with the periods you held it shaded, and a marker for each buy and sell. With more than one ticker there is one button for each, or a list when there are more than 12. Above it: the number of trades, the share of the time held, and what holding it throughout returned. When there are too many trades to mark at the chart's width, only the shaded bands are drawn.
14. **Try other parameter values.** Shown when a parameter is declared with a range, such as `fast = 50 in 20..100 step 10`. A button runs every combination of the ranges, up to 2,000 combinations. Then it shows a chart for one ranged parameter, or a heatmap for two. They show where the values written in the note rank among all the variants, the median variant, and whether the best variant's neighbours do similarly well. With `test from` set, the view starts on the period before the date, the best variant is chosen on that period, and its result after the date is shown. The line under the reading says which period chose the best values ("Best before 2015-01-01: fast = 40, slow = 250"). If you switch the view to the whole run or to the period after the date, that line no longer suggests values, because values picked there have seen the test period and their later result would not be a fair test. To put a variant's values into the block, click or tap its point on the chart, its cell in the heatmap, or its row in the table of best variants, then press "Use these values in the block". The best variant has the same button, except on a view that includes the test period. It writes the numbers the way "Write these values to the block" does (see "The Parameters bar"). The button is off while it writes, and the line next to it says "Done: the block now uses these values." only once the write has happened. If the note has changed since the result was drawn, nothing is written and the line says so. Nothing is written to the note unless you press the button.
15. **Was it luck?** A button that runs three checks. *Reshuffled history* resamples the run's returns in blocks, to give a range for return per year and for worst drawdown. It shows how much the path and the drawdown depended on the order of the returns; it says nothing about whether the average return will persist, because every version is made from the run's own returns. *Random entries* makes the same number and length of trades at random times, to see how often random timing does as well. *Walk-forward* runs only when a parameter has a range: it picks the best values on a training window, applies them to the next unseen window, and repeats. Each window is measured from the last close before it, so the test windows' growth multiplies to the line's. When a slider under "Parameters" has moved, the checks test the run shown, with the slider's values, and a line above them says so ("These checks test the run shown, with fast 25. The block says fast 10."); walk-forward then draws "Values shown" instead of "Values in the note". "Try other parameter values" always ranks the values written in the block.
16. **Save buttons.** "Save trades as CSV", "Save value history as CSV" and "Keep this result as a note" (see "Saving results").

The variants and the checks run in the background, so the note stays usable while they run. A bar shows how far they have got, and "Stop" ends them at once. A stopped sweep shows the variants it had finished, and a stopped check says it stopped; "Run checks again" runs them again. When several blocks run at once they take turns, and a block that waits says "Waiting for another run to finish…". Where Obsidian cannot start a background worker, they run in the foreground, a few backtests at a time between repaints.

A result is kept in memory (the latest 40), so scrolling or switching views does not run it again. It runs again when the block's text or the plugin's defaults change, when the modified time of a CSV file it reads changes (or the file goes missing), when the kept result is older than the "Keep saved prices for" time, or when you press Refresh prices.

### Folding a result

The title is a button. Click it to fold the result to one line, and click again to open it. The line shows the strategy's name, return per year, worst drawdown, what it holds now ("Long SPY since 2026-03-02", "Holds 2 of 5" or "In cash") and any order waiting or made at the last close ("buys TLT at the next open"). A strategy with no name shows its tickers after "Backtest". A small mark says how many notes the result has. The chart, the tables and the sections are drawn only when the block is first opened.

The setting "How results first appear" decides how a block starts: Full (the default) opens it, Compact folds it. Obsidian draws a block again when you scroll or switch views, and the block comes back the way you left it for the rest of the session. A named block is remembered by its name, and an unnamed one by its place in the note. A block that can't run always shows in full, with its problems.

### The Parameters bar

A strategy that declares parameters gets a "Parameters" bar under its text, with a slider for each parameter and its value in the block's own form (`50`, `8%`). With a range, the slider follows it (`in 20..100 step 10`). Without one, it runs from about half to double the value, in whole steps for whole numbers.

- Drag a slider, or use the arrow keys, and the strategy runs again with that value on the prices already loaded. While you drag, the figures, the key and the main chart follow and the rest of the result dims. When you let go, the whole result is drawn again, so a section you had open closes.
- Nothing is downloaded while you drag. A value that needs more price history than is loaded leaves the result as it was, and the bar says so. The history loads once, when you let go of the slider, and the bar says "Loading more price history…" while it does.
- A value the language rejects is not run. The bar says why and keeps the last result that ran.
- When the result on screen differs from the block, a line says so ("Showing fast 80. The block says fast 50.") and shows two buttons. "Reset" goes back to the block's values. "Write these values to the block" changes only those numbers in the note; spacing, comments, ranges and `%` stay as they were. The button is missing where the block cannot be edited, such as in some embeds. Both buttons are off while the write runs. If the note has changed since the result was drawn, nothing is written, and the bar says so under the buttons: "Couldn't write the values to the block. The note has changed since this result was drawn, so nothing was written. Try again."
- When Obsidian draws the block again, the sliders go back to the block's values.

### Explaining a trade

The button "Explain this trade", a small arrow at the start of each row of the trade list, opens a box under the row. Click it again to close the box. The box has four parts. Its numbers are worked out again from the same prices when you open it.

- **Why it was bought.** The close the buy rule was read at. The rule as you wrote it, with the value of each part there and whether it held (✓ yes, ✗ no, ? unknown). For `crosses above` and `crosses below`, the bar before. For `of`, which bar of the other ticker was read. With `fill: close`, when the fill came at a later close than the one the rule or the ranking read. The parameter values. With `hold`, the ticker's place in the ranking, and the whole ranking when there are 12 tickers or fewer. Then anything that made the buy wait: an input still warming up, a stop or target exit after which the rule had to stop holding first, or the sells of the same ranking.
- **How much.** The portfolio's value at the fill; the weight, or the risk per trade with its ATR, or the volatility for `weighting: inverse volatility`; any cut for lack of cash; the money and the shares; and the fill price at the open (with `fill: close`, the close) with the slippage.
- **Why it was sold**, or **Why it is still held**. The sell rule with its values, or the stop or target: where it was, how it was set, the ATR or highest price behind it, and whether the bar opened beyond it or crossed it during the bar. With `hold`, the ranking it dropped out of. For a position still held: the sell rule at the last close, and whether a sell is waiting.
- **Result.** Return and profit after costs, the bars held, the costs paid, and how often rebalancing topped the position up or trimmed it.

## Comparing and combining strategies

A code block marked `compare` puts the equity curves of strategies from other notes on one chart, and can combine them into one portfolio. To list the figures of every strategy in the vault side by side, use a `backtests` block (see "All strategies in one table").

```compare
# One line for each strategy
[[Trend following]] 50%
[[Pullbacks#QQQ RSI pullback|QQQ dips]] 30%
Research/Three sleeves.md 20%
```

Each line names one strategy:

- `[[Note name]]` is the first `strategy` block in that note.
- `[[Note name#Strategy name]]` is the block whose `name:` setting is that (capital letters do not matter, and a comment after the name, such as `name: Trend # v2`, is not part of it).
- `[[Note name|Label]]` or `[[Note name#Strategy name|Label]]` uses the label in the chart and tables.
- A vault path that ends in `.md` works too, with an optional `#Strategy name`: `Research/Three sleeves.md#Second one`.
- A weight can follow the note, such as `40%`.
- A line that starts with `#` is a comment. Blank lines are skipped.

The rules: at least 2 strategies and at most 8. List each strategy once. Give every line a weight or none. Weights must be above 0% and add up to at most 100%.

Blocks are found the way the editor finds them. A `strategy` block inside a callout or a quote counts. One inside a longer fence of another kind, such as an example shown in a four-backtick `markdown` block, does not.

What you get:

- A title and the dates every strategy covers, from the latest start to the earliest end. Between a strategy's own dates its last value is carried forward. Each line is rescaled to start at the plugin's "Starting money" setting (not each strategy's own `capital`), and the title line says so. A key shows each line's final value.
- With weights, a "Combined" line. It holds the strategies at those weights and goes back to them on the first date of each month. Any weight not used stays in cash that earns nothing. The line is drawn on top.
- A table of return per year, total return, worst drawdown and Sharpe ratio for each line. As in a strategy's own result, the Sharpe ratio takes off what cash earned over each step, using the strategy's own cash rate. For the "Combined" line it takes off the average of the strategies' cash returns, weighted by their weights as if they added up to 100%.
- How alike they move. With two strategies it is a sentence about the correlation of their returns. With three or more it is a table of correlations, from 1 (move together) to -1 (move against each other).

Each strategy runs as written, with the plugin's defaults for what it leaves out. If one cannot run, the comparison says which line and why.

## All strategies in one table

A code block marked `backtests` lists every strategy in the vault with its latest figures, so one note gives the overview. The command "Insert strategy dashboard" inserts one. Strategies are found as in "Today's orders". It reads the results themselves, so it needs no note properties (see "Note properties" for the other way to list strategies).

```backtests
# Only the notes under Trading, best return per year first
folder: Trading
sort: return
```

An empty block is valid: it lists everything, by name. Each of the two settings is optional and can be written once. A line that starts with `#` is a comment.

| Setting | What it does |
| --- | --- |
| `folder: Trading` | Lists only strategies in notes under that folder, subfolders included. Capital letters do not matter. |
| `sort: return` | How the table is sorted at first: `return` (highest first), `drawdown` (smallest first), `sharpe` (highest first) or `name` (A to Z). The default is `name`. |

Any other line is an error, shown with its line number like the errors of a `compare` block.

Each strategy is one row: its name with its note's name under it (click to open the note), return per year, the benchmark's return per year (its name under the figure), worst drawdown, Sharpe ratio, trades, what it holds now ("Long SPY", "Long 2 of 5" or "In cash"), its orders in words, and the date its prices go through, with "may be old" when they are out of date by the rule under "Today's orders". The figures are the ones in the strategy's own result.

The "Next" column lists the orders, sells first. An order for the next open has no time after it ("Sell TLT, GLD"). An order for the next close ends "at the next close", and what a strategy with `fill: close` did at the last close reads "Bought SPY at the last close" or "Sold SPY at the last close". A dash means no order.

Rows appear as each strategy finishes, three at a time; until then a row says "Running…". A strategy that cannot run shows why across its row and does not stop the others. Click a column heading to sort by it, and again to reverse; strategies that could not run or are still running stay at the bottom. Under the table are the number of strategies, when the figures were worked out, and "Run again", which lists the vault again, drops the results kept in memory once, when the round starts, and runs everything with fresh prices. On a narrow pane the table scrolls sideways and the strategy's name stays in view. If the vault has no strategies, the block says so and how to add one.

## Today's orders

The command "Show today's orders", or the ribbon icon of the same name, opens a window. It runs every `strategy` block in every note of the vault that has the word "strategy" in it, and lists the orders each one has and when each applies. Blocks are found as described under "Comparing and combining strategies": ones in callouts count, examples inside a longer fence do not.

- **To do at the next open.** One row for each order of a strategy that fills at the next open: Buy or Sell, the ticker, the size, the strategy (click it to open its note), the last close, and which bar it is based on, such as "Based on the close of 2026-11-13". For strategies with bars shorter than a day the row shows the time too, in UTC, such as "Based on the 5m bar starting 2026-11-13 14:05 UTC". Sells are listed first. A buy's size is its target share of the strategy and about how many dollars that is at the backtest's current value, which grows or shrinks from the block's `capital`. A sell is the whole position. Scale the percentage to your own money. The dollar figures are about the backtest, not about your account.
- **To do at the next close.** Orders of a strategy with `fill: close` that could not fill at the close they were decided at. This happens when a ranking decision is made at a time a ticker has no bar: its order waits for that ticker's next close. The rows look like the ones above.
- **Traded at the last close.** What a strategy with `fill: close` did at the close that has just passed. Its backtest has already bought or sold, so the row says Bought or Sold. To match it, the order had to be placed before that close. A buy shows its share of the strategy, a sell the whole position and the day it was opened.
- **Holding.** Strategies that hold something or have no order, and what they hold. A position that has an order row, including one bought at the last close, is not listed again here.
- **Strategies that fill at the close.** The strategies with `fill: close`, under this note: "A strategy with fill: close decides and fills an order at the same close, so the order has to be placed just before a close. What is listed for it is what its rules said at the last close."
- **Problems.** A block that could not run, prices that are out of date, and any warning from loading prices. For daily bars, prices are out of date when they end more than 4 calendar days ago. For bars shorter than a day, they are out of date when the last bar is more than 3 bars old, and for weekly bars when it is more than 2 bars old.

A group with no rows is left out. When no strategy has an order, the window says "Nothing to do. No strategy has an order."

The header says which bar the orders are based on. Orders under "To do at the next open" are for the open after that bar, and under "To do at the next close" for the close after it. "Traded at the last close" is that bar's own close. When the strategies with orders end on different bars, the header shows the oldest and says so, and each row shows its own. Yahoo's bar for the current day is used once the exchange's regular session has closed, when Yahoo's answer gives that time; until then, and when it does not, the orders refer to the previous close. Check the date.

Refresh prices downloads each ticker once, however many strategies use it, then runs the strategies again, three at a time. "Save as note" writes the same list to the note named in the "Note for today’s orders" setting, creating it if it does not exist and replacing its whole contents each time. The saved note has one section for each group that has rows ("To do at the next open", "To do at the next close", "Traded at the last close"), or "To do" with "No strategy has an order." when there are none, and names the strategies with `fill: close` under "Strategies that fill at the close". The generated note starts with the property `backtest_orders: true`. An existing note is replaced only if it has that property; otherwise nothing is written and the window says "<path> already exists and was not made by Backtest Blocks. Choose another note in settings." With no note set, it says so. Nothing in the window places an order.

A block with no `name` is listed under its note's file name, or "file name 1", "file name 2" when a note has several.

### In the status bar

A few seconds after Obsidian starts, the plugin runs every strategy in the vault quietly, from saved prices where they are fresh, and shows how many orders there are in the status bar, counting every group in the window: "2 orders today", "1 order today" or "No orders today". Rest the pointer on it to see the first five, each with its timing, such as "Sell SPY at the next open, Trend following" or "Bought TLT at the last close, Close mover". Click it, or press Enter when it has focus, to open the window.

- A small dot after the text means some strategy could not run, has old prices or came with a price warning. The tooltip says how many.
- When no strategy could run, or the check itself failed, it says "Couldn't check orders". It shows nothing when the vault has no strategies.
- It checks again by itself once its answer is older than the "Keep saved prices for" time, and it takes the answer of the orders window whenever you open that, so the two agree.
- Where there is no status bar, as on a phone, a notice with the same text appears once at start-up when there are orders, and nothing appears otherwise.
- The setting "Check for orders when Obsidian starts" turns this off. Turning it off hides the count and stops the checks at once. Turning it on starts them again after a few seconds. With it off, the status bar stays empty, even when you open the orders window; the window and the ribbon icon still work.
- Like the window, the check fetches prices for every strategy's tickers (see "Network requests").

## Saving results

Three buttons under a result write files to the "Folder for saved results" (default `Backtests`), created if needed. A file is named `<name> trades|value|result <date>`, where `<name>` is the block's `name` (or "Backtest") with characters that Obsidian cannot use in a file name replaced by spaces, and `<date>` is the day it was saved, in UTC. If the file exists, ` (2)`, ` (3)` and so on are added. A notice shows the path.

- **Save trades as CSV** has the columns `ticker`, `bought`, `buy_price`, `sold`, `sell_price`, `return_pct`, `profit`, `bars` and `exit`. Open positions have no `sold` or `sell_price`. `exit` is `signal`, `stop loss`, `trailing stop`, `take profit` or `open`.
- **Save value history as CSV** has the columns `date`, `strategy`, the benchmark's label (such as `SPY buy & hold`) and `drawdown_pct`, one row for each step of the run. The benchmark's field is empty before its first price.
- **Keep this result as a note** writes a note with the tag `backtest/snapshot` and a `created` date. It holds the strategy as plain text in a `text` block, so it does not run again, with the parameter values that were on screen, then the figures, the split before and after the test date if there is one, the positions now, and the latest 30 trades.

### Note properties

The command "Save this note's results to its properties" runs the strategies in the active note and writes the main figures of each to the note's properties (front matter). The setting "Write results to note properties" does the same for the note a block is in, a moment after its blocks have rendered: a note with several blocks is written once, from the kept results, without running anything again. A block drawn in the strategy preview panel does not trigger it. It is off by default, because it edits your notes.

| Property | Value |
| --- | --- |
| `bt_return_per_year` | Return per year, in percent, to 1 decimal. |
| `bt_worst_drawdown` | Worst drawdown, in percent, to 1 decimal (negative). |
| `bt_sharpe` | Sharpe ratio, to 2 decimals. |
| `bt_trades` | Number of closed trades. |
| `bt_invested` | Time invested, in percent. |
| `bt_from` | First day of the run. |
| `bt_to` | Last day of the run. |
| `bt_benchmark_return_per_year` | The benchmark's return per year, in percent. |
| `bt_last_run` | The day the figures were last changed. |
| `bt_position` | The tickers held now, or `cash`. |

A note with one strategy uses the plain `bt_` keys above. When a note holds more than one strategy, each block gets its own keys, with a part between `bt_` and the rest of the key. A block with a `name` uses it: "Trend following" writes `bt_trend_following_sharpe`, `bt_trend_following_trades` and so on. The name is turned into lower case, and each run of characters that are not letters or digits becomes `_`. A block with no name, a name with no letters or digits, or a name that would give the same keys as an earlier block uses its position in the note instead: `bt_2_return_per_year` for the second block. No two blocks share a key. Renaming or reordering blocks changes their keys.

The plugin owns every property that starts with `bt_`. It updates them, and when every strategy in the note ran, it removes `bt_` properties that no strategy in the note produces any more, such as the keys of a block you deleted or renamed. Do not name your own properties `bt_...`. If a block could not run, nothing is removed, so its earlier figures stay. A property is written only when its value changed, and `bt_last_run` (for each block, the day its figures last changed) moves only when something else in the note changed, so opening a note on a new day does not edit it. Properties let a Base list your strategies. A `backtests` block lists them without properties (see "All strategies in one table").

## Drafting from plain English

The command "Draft a strategy from a description" opens a window where you type what you want. A model writes a draft in the plugin's language, the parser checks it, and you decide whether to insert it. You need to choose a provider in the settings first.

Providers:

- **Anthropic.** You choose an API key (required). The model is `claude-opus-5-5`, or the name in the "Model" setting. Requests go to `api.anthropic.com`, or to the "Server address" if you set one; both settings can stay empty.
- **OpenAI-compatible server.** Enter the server's address (such as `http://localhost:8000/v1`) and the model name its server uses; both are required. The key is optional, for servers that need none. Requests go to the address followed by `/chat/completions`, with the temperature set to 0.

The key is not saved in the plugin's settings file. You pick it from Obsidian's secret storage, and the plugin saves only the name of the secret. The key is sent only to the service you chose, as a request header.

What is sent, exactly:

- A fixed set of instructions that comes with the plugin: the language reference, the limits (long or flat only), the reply format and worked examples. It holds nothing from your vault. This is the plugin's built-in guide to the language.
- The description you typed.
- If the parser finds errors in the draft, up to two repair requests follow. Each one sends the conversation so far (your description and the model's earlier replies), the parser's messages with the lines they are about, and the draft.

Nothing from your notes or vault is sent: not your notes, your strategies, prices or results. What is sent is your description, the built-in guide and, when a draft has problems, that draft and the problems found. The only setting that leaves the plugin is the API key, as described above. The window and the settings say the same.

What happens to the reply:

- The plugin pulls the strategy and any lines starting with `NOTE:` out of the reply. The notes are shown as "The model's notes": they say what the model chose or could not express (for example, that shorting is not supported).
- The parser checks the draft. After the repairs, the draft is shown even if it still has problems, with the problems listed.
- The draft is never run. Nothing is fetched and no backtest is made. It runs only after you press "Insert into note", which puts a `strategy` block at the cursor of the note you have open for editing; from then on it is an ordinary block. With no note open for editing, it asks you to open one.
- "Try again" asks again. Pressing Ctrl+Enter or Cmd+Enter in the box sends the description.

The model may get a strategy wrong. Read the draft and the model's notes before you insert it.

## Editing help

Inside a `strategy` block the editor helps you write it.

- **Colours.** The parts of a block are coloured with your theme's code colours: setting and parameter names, keywords (`buy`, `when`, `and`, `of`, `for`), functions, series and calendar values, numbers and values, tickers, parameters used in rules, operators, and comments in italics. The result shows the block coloured the same way.
- **Auto-complete.** A pop-up offers what can come next, with a line of help for each item. At the start of a line it offers `buy when`, `sell when`, `for`, and the settings (only the stops inside a `for` section). After `of` and `for` it offers the tickers named in your `universe`, `symbol` and `benchmark` lines. After a setting name it offers values, such as the choices for `rebalance`, `data`, `interval` and `fill`. Inside a rule it offers series, calendar values, your parameters, functions and words such as `crosses above`. `bars held` and `entry price` are offered only in sell rules. It stays quiet while you type a number.
- **Underlines.** Problems are underlined with a wavy line, in the theme's error colour. Notes (such as the fixed-price one) are underlined in its warning colour. Hover the underline to read the message, which starts with "Problem:" or "Note:". The editor reads the block with the same parser as the result, using the plugin's defaults.
- **Help on hover.** Hold the pointer over a word in a `strategy` block to see what it means: its form, one or two sentences, and an example. This covers settings and their fixed values (`monthly`, `yahoo`, `1h`, `next open`), functions, series, calendar and position values, rule words (`crosses above`, `of`, `for all`, `and`), `%` and `bps`, the `[n]` lag, and `in ... step` on a parameter line. A two-word name such as `bars held` is one word. A parameter you declared shows its value and range wherever it is used. When the spot also has a problem, the problem comes first and the help under it.
- **Fixes.** When a problem looks like a typo, the tooltip offers a button such as "Change to sma". It covers a misspelt setting, function, series, word in a condition, setting value (`montly`, `yaho`), `for` ticker or parameter name, and habits from other languages: `&&`, `||`, `!` before a word, `=>` and `=<`. A fix is offered only when the corrected block no longer has that problem, and none is offered when two words are equally close. Clicking it is an ordinary edit. The command "Fix the problem at the cursor" does the same from the keyboard for the problem at the cursor, or else the first one on its line. In the list that replaces a result when the block cannot run, the same suggestion is a sentence ("Did you mean sma?").
- **Ticker lookup.** With the setting "Look tickers up while writing" on, which is the default, typing a ticker on a `universe`, `symbol`, `benchmark` or `cash rate` line offers real ones with their names, from Yahoo and Binance. The tickers already in the block are offered at once. A ticker from the other source is written with its prefix, such as `binance:BTCUSDT`. Typing `csv:` offers the CSV files in your vault. Only the ticker word is completed, so a weight such as `SPY 60%` is left alone. A ticker its source does not know, in the universe or after `of`, is underlined as a note ("Yahoo has no ticker called SPYY."), with a button to change it to a near one when there is one. When the same ticker is written on a `for` line or after `of`, the button changes every place and says how many ("Change to SPY (2 places)"). It is offered only if the block has no new problem afterwards. That note never stops a run, and it waits until the cursor leaves the ticker. The lookup sends tickers over the network; see "Network requests" for what and when.

### Strategy preview

A strategy block shows its result only when the cursor leaves it in live preview, and never in source mode. The command "Open strategy preview" opens a panel in the right sidebar that shows the result of the block you are writing, so you can see it without moving the cursor away.

- **Which block.** The block the cursor is in, counting its opening and closing fence lines. When the cursor is outside every block, the panel keeps the block it last showed from that note, or else shows the note's first block. In reading view there is no cursor, so the same rule applies. A block you have not closed yet is shown as soon as it reads cleanly. A strategy block inside a callout or a quote is not shown here. Opening another note makes the panel follow that note. A note with no strategy block gets a short message that says how to start.
- **The heading** names the note and the strategy: its `name`, or "Strategy 2 of 3".
- **When it updates.** After you stop typing: about half a second when the prices for every ticker are already saved, about a second and a half otherwise, so typing a ticker does not send a request for every letter. Moving the cursor into another block, or opening another note, updates it after a short pause. Typing elsewhere in the note does nothing.
- **Problems.** While the block has problems, they are listed at the top in the same words as in the note. The last result that ran stays underneath, dimmed, with a line saying it is the last version that ran. If nothing has run yet, only the problems show. A run that fails, such as a ticker with no prices, shows "The backtest couldn't run", the reason and a "Try again" button over the dimmed last result in the same way.
- The result is always shown open, whatever "How results first appear" says. The panel keeps its scroll position and any section you opened, such as the trade list, when the same block updates. It runs nothing while it is hidden, for example when the sidebar is collapsed.
- The buttons that write values into the block ("Write these values to the block" and "Use these values in the block") change the block in the note, if it still has the text the result was drawn from. If you have changed it since, the panel says so and writes nothing.
- The panel never writes the note's properties, even with "Write results to note properties" on.

## Settings

Settings are under Community plugins, then Backtest Blocks.

| Setting | What it does | Default |
| --- | --- | --- |
| Starting money | Used when a strategy has no `capital` line. | 10000 |
| Costs per trade | Used when a strategy has no `costs` line, such as `5 bps`. | `0 bps` |
| Slippage per fill | How much worse each fill is than the price, such as `5 bps`. | `0 bps` |
| Interest on cash | A rate such as `4%`, or a ticker whose price is a yield, such as `^IRX`. A `cash rate` line overrides it. | `0%` |
| Where plain tickers come from | Yahoo or Binance, for tickers written without a prefix such as `binance:`. | Yahoo |
| Keep saved prices for | Hours before saved prices are fetched again, from 1 to 168. | 6 |
| Saved prices | A button, "Clear saved prices", that removes every price file the plugin saved. | |
| Write results to note properties | When a note's strategies have run, save their main figures to the note's properties. Properties that start with `bt_` belong to the plugin: it updates them and removes ones no strategy in the note produces any more. This edits your notes. | off |
| Note for today’s orders | Vault path of the note to write them to, such as `Trading/Orders.md`. The note is rewritten each time you save, and an existing note is replaced only if the plugin made it. Empty for none. | empty |
| Folder for saved results | Vault folder where saved results go. | `Backtests` |
| How results first appear | Full opens every result. Compact shows one line for each strategy, which opens on a click and suits a note with several (see "Folding a result"). | Full |
| Check for orders when Obsidian starts | Runs every strategy in the vault shortly after start-up and shows how many orders are due in the status bar (see "Today's orders"). This fetches prices for every strategy's tickers. Turning it off hides the count and stops the checks at once. | on |
| Look tickers up while writing | Suggests matching tickers and marks ones that do not exist. What you type where a ticker goes, and the Yahoo tickers named in strategy blocks on screen, are sent to Yahoo's search, one ticker at a time. Nothing else from your notes is sent (see "Network requests"). | on |
| Provider | The service that turns a description into a strategy: Anthropic, or an OpenAI-compatible server. | Anthropic |
| Server address | Anthropic: empty for Anthropic's own address, or a proxy. OpenAI-compatible: required, such as `http://localhost:8000/v1`. | empty |
| Model | Anthropic: empty for `claude-opus-5-5`. OpenAI-compatible: required, the name of the model on your server. | empty |
| API key | A secret in Obsidian's secret storage. Only its name is saved in the settings. Required for Anthropic; empty is fine for a server that needs no key. | none |

The costs, slippage and cash rate settings are checked the way the language would read them, and a value that cannot be read is not saved.

## Commands

The command palette shows each name with "Backtest Blocks:" in front.

| Command | What it does |
| --- | --- |
| Insert strategy block | Opens the starter strategies and inserts the one you choose at the cursor. |
| Use a CSV file in a strategy | Opens the CSV helper: choose a file in the vault, see how it is read, fix its columns if needed, and insert its ticker or a small strategy. |
| Draft a strategy from a description | Opens the drafting window. |
| Open strategy preview | Opens the strategy preview in the right sidebar. |
| Fix the problem at the cursor | Applies the "did you mean" fix for the problem at the cursor. |
| Insert strategy dashboard | Inserts a `backtests` block at the cursor. |
| Show today's orders | Opens the list of orders: what to do at the next open or close, and what `fill: close` strategies already did at the last close. |
| Save this note's results to its properties | Runs the note's strategies and writes their results to its properties. |
| Clear saved prices | Removes the saved price files. |

"Insert strategy block", "Fix the problem at the cursor" and "Insert strategy dashboard" are offered only while a note is open for editing. The list icon in the ribbon opens the same window as "Show today's orders".

## Prices and privacy

### Where prices come from

- **Yahoo.** The unofficial chart endpoint behind Yahoo Finance, on `query1.finance.yahoo.com` and `query2.finance.yahoo.com`. Yahoo does not publish it as an API, can change or rate-limit it without notice, and its terms allow personal use only. The plugin asks for the whole history each time, as daily or weekly bars. If a request fails or Yahoo sends something other than price data, it tries again, on `query1`, then `query2`, then `query1`, waiting 0.5 and then 1.5 seconds. Open, high, low and close are adjusted for splits and dividends. The bar for the current day is left out until the exchange's regular session has closed, when Yahoo's answer gives that time, and otherwise until the next day; weekly bars wait for the week to end. A ticker Yahoo does not know gives "Yahoo has no prices for X. Check the ticker."
- **Binance.** The public market-data endpoint `data-api.binance.vision` (klines, 1000 bars a request). It needs no key. The bar still open is left out. A refresh asks only for bars newer than the saved ones. A ticker it does not know gives "Binance has no market called X".
- **CSV files in your vault.** Read directly, with no network. The file needs a header row with a date column (`date`, `time`, `timestamp` or `datetime`) and `open`, `high`, `low` and `close` columns; `volume` is optional. The separator can be a comma, semicolon or tab. Dates can be `2024-01-31` (with an optional time, read as UTC, or with a zone after the time, such as `2024-01-31 14:30-05:00`), `01/31/2024` or `01-31-2024`, `31/01/2024` or `31-01-2024` (read as day first when some first number is above 12 and no second number is), `31.01.2024`, or Unix seconds or milliseconds. When dates such as `02/01/2024` or `02-01-2024` could be either, a file read as it is takes them month first, and "Use a CSV file in a strategy" says so and asks which. An `adj close` column, if present, adjusts the other prices. Rows with an unreadable date, a price at or below 0, or a high or low that does not contain the open and close are skipped. Rows are sorted by date. Numbers need a decimal point. Prices are not saved: the file is read each time a block runs. A result is kept in memory (see "Reading a result"), and it runs again when the file's modified time changes. The command "Use a CSV file in a strategy" helps with a file that does not fit (see below).

### Using a CSV file

The command "Use a CSV file in a strategy" opens a window that finds the CSV files in your vault, shows how the plugin reads one, and puts a ticker or a small strategy into your note.

1. **Choose a file.** The box at the top narrows the list as you type. The arrow keys and Enter work too.
2. **See how it was read.** The window shows the number of rows, the first and last date, and the first and last rows. It lists anything doubtful in plain words: rows that were skipped and why, dates that could be read two ways, no volume column, rows out of date order, long gaps, dates with a time of day, and a history too short for the starter strategy.
3. **Insert it.** "Insert the ticker" puts `csv:<path>` at the cursor. "Insert a strategy using it" puts a complete block with the file as `symbol`, `costs: 5 bps` and a 100-day trend rule. When no note is open for editing, the text is shown with a "Copy" button instead.

A strategy cannot name a file whose path has a space or a comma in it, because the `universe` line is split at commas and spaces and has no way to quote a path. The window says so and inserts nothing. Rename the file or its folder, for example with a dash. A path with other unusual characters, such as a bracket or an accented letter, works on a `universe`, `symbol` or `benchmark` line but not after `of` in a rule; the window says so.

When the plugin cannot read a file as it is, the window says why: for example the columns have other names, there are only dates and closes, the numbers use a decimal comma, or the dates are written with month names. It guesses which column is which and lets you choose each one, and, for dates like 02/01/2024 or 02-01-2024 that could be read two ways, whether they are day first or month first. The window asks "Dates such as 02/01/2024 are", writing the date with the file's own separator. A preview shows the first rows as they would be read. "Save a cleaned copy and use it" writes a new file next to the original with `-clean` added to its name (`-clean-2` and so on when that name is taken). It never replaces a file and never changes the original. The copy has the header `date,open,high,low,close,volume`, dates as `2024-01-31`, oldest first, and a decimal point. Rows that cannot be read are left out and counted.

The cleaned copy fills what the file lacks:

- No open, high or low: the open is the close, the high is the larger of the open and the close, and the low is the smaller. A file with only dates and closes gets all three equal to the close. Then a fill at the next open is made at that bar's close, a stop can only act at a close, and the average true range counts only moves from one close to the next.
- No volume: 0 on every bar, as for any file without a volume column.
- An adjusted-close column you choose scales the prices, as an `adj close` column does.

### What is saved on disk

Prices from Yahoo and Binance are saved in `<plugin folder>/cache`, one JSON file for each source, ticker and interval. The plugin folder is `<vault>/.obsidian/plugins/backtest-blocks/`. The files are treated as fresh for the "Keep saved prices for" time (6 hours by default). After that the plugin fetches again. If the fetch fails and a saved copy exists, the copy is used and the result says: "Couldn't refresh X (reason); using prices saved on DATE." If you sync the `.obsidian` folder, the saved prices go with it. "Clear saved prices" removes the folder.

The plugin's settings are in `data.json` in the plugin folder. Results are kept in memory only.

### Network requests

The plugin contacts these hosts, and no others:

- `query1.finance.yahoo.com` and `query2.finance.yahoo.com`, when a block uses a Yahoo ticker. The request holds the ticker and the bar size.
- `data-api.binance.vision`, when a block uses a Binance ticker. The request holds the market symbol, the bar size and a start time.
- `api.anthropic.com`, only when you draft a strategy with the Anthropic provider and no server address.
- The server address you enter, only when you draft a strategy. That can be a server on your own machine.

Two features make requests on their own, to the Yahoo and Binance hosts above and no others:

- The check for orders when Obsidian starts runs every strategy in the vault a few seconds after start-up. It fetches the prices of every ticker they use that are not saved, or are older than the "Keep saved prices for" time. The setting "Check for orders when Obsidian starts" turns it off. The orders window and a `backtests` block do the same when you open them.
- The ticker lookup, while "Look tickers up while writing" is on, which is the default, sends two kinds of request. Neither carries a note's name or text.
  - A search on `query2.finance.yahoo.com`, then `query1`, at the path `/v1/finance/search`. The query is only a ticker: the word you typed where a ticker goes (250 ms after the last key, and only when it is not already one of the block's tickers), or a Yahoo ticker that a strategy block on screen names in its `universe`, `symbol`, `benchmark` or `cash rate` line or after `of` (0.7 seconds after typing stops, at most 6 each time, and not the one the cursor is in). At most 24 characters from `A-Z a-z 0-9 ^ . _ = -` are sent, and nothing else. Starting what you type with `binance:` or `csv:` keeps it from being sent. A CSV file, even when a rule names it by its bare file name, is never looked up.
  - The list of Binance prices, `data-api.binance.vision/api/v3/ticker/price`. It carries no parameters and no text from your notes. It is fetched the first time a Binance ticker is checked or a plain word is completed, and again after 6 hours.
  - Answers are kept in memory only. At most 2 lookups run at once. A failed lookup is silent and is not repeated for 30 seconds, and 3 failures in a row pause that host for 60 seconds.

Nothing else leaves your vault. There is no telemetry, no analytics, no update check and no remote code. No note's text is sent anywhere. The only words taken from your notes are ticker symbols, and only for the lookup above; what is described under "Drafting from plain English" goes to a model. The plugin sets no `User-Agent` of its own: the request carries whatever Obsidian's `requestUrl` sends.

## How far to trust it

**What has been checked**

- Unit tests cover the language, the indicators, the engine's rules (fills, costs, slippage, stops, gaps, rebalancing, ranking, sizing, warm-up, interest, reading other tickers by bar end, the test split), the lookback, the statistics, the comparison, the Yahoo, Binance and CSV readers with saved responses, the saved-price logic with a fake network, orders and the status bar count, the `backtests` block, the explanation of each trade, rewriting parameter values in a note, the background jobs with a fake worker, the starter strategies and the CSV helper, hover help, fixes and the ticker lookup with a fake network, exports, settings and drafting with a fake model.
- A cross-check against a second backtester. `xcheck/` generates nine synthetic tickers over 3,000 days and runs 29 strategy pairs and 55 indicator expressions through this engine and through Rearview, a separate backtester that is not part of this repository. It compares the indicator values on every bar, every trade's days, prices, reason and bars held, the equity curve and exposure day by day, and the totals and pending orders. Five of the 29 cases fill at the close, against Rearview's `fill same_close`. The check found one real bug (a bar that opened above the take-profit and then fell through the stop was booked as a stop loss), which is fixed. The two engines differ by design in some rules, and the check explains a difference only when it matches one of them: sizing (money here, shares there), the re-arm rule, a halted ticker, the trailing stop on the entry bar (and, with `fill: close`, where it starts), slipped targets, the timing of a rebalance, how bars held are counted, a sell rule while flat, the first ATR (which also moves `keltner_upper`, `keltner_lower` and `supertrend` by a bar), how interest counts days, and the Sharpe ratio. The table is in `xcheck/README.md`. Of the 22 functions added after the first twelve, 20 are compared with Rearview's on every bar of every ticker, to 1e-9: `obv` through a sum of signed volume and `vwap` through Rearview's `vwma` of the typical price, and `correl` only on tickers that have every day. The check is run by hand and is not part of `npm test`. It still passes after the fixes in the next point.
- An independent review of the engine and the statistics, which confirmed each finding with a script. It found defects that are now fixed, each with a test: on mixed calendars (stocks with crypto) a ticker could miss its rebalance and a ranking buy could leave its slot in cash; a ticker with longer bars, a daily benchmark or a daily yield on shorter bars could be read before its bar had ended; entries were sized or left without their ATR stop while those inputs warmed up; and results could depend on which prices happened to be saved. It also corrected statistics (a benchmark whose prices start later, Sharpe and Sortino made of rounding noise, the `test from` split, two different Sortino ratios), and runs of more than about 125,000 bars no longer fail. A review finds what it looks for; this one does not show that no other defects remain.
- A trial in a running desktop Obsidian 1.15, with live prices, of the parts that depend on Obsidian itself. These worked: the Parameters bar and its sliders; writing values into the block from the bar and from a sweep, in reading view and in live preview, including right after typing in the note; "Explain this trade"; the sweep in the background worker; the strategy preview panel as the cursor, the text and the problems change; "Fix the problem at the cursor" and the underlines; the `backtests` block; the starter strategies window; the CSV helper's file list and its reading of a file; folded results with the Compact setting; and the count in the status bar.

**What has not been checked against anything**

The second backtester has nothing to compare these with, so they rest on the unit tests (and the review) only: inverse-volatility weighting, a cash rate from a ticker, ATR take-profits, `entry price` in sell rules, calendar values (`month`, `month_start` and the others), yearly rebalancing, ranking with `rebalance: never`, stops in ranking or rebalancing strategies, slippage on rebalances with weights under 100%, `of` on a day the other ticker has no bar, the benchmark, `test from`, and weekly or intraday bars. The cross-check of `fill: close` uses daily bars only. The direction `supertrend_up` (the line it follows is compared), `bars_since`, and `correl` on tickers with missing days or other calendars have nothing to compare with either; the unit tests check each against a second implementation written from its definition, on thousands of random bars.

Also not checked:

- A real phone. The plugin has never been run on one, though the manifest does not rule it out. The result view, with the Parameters bar, has been looked at in Obsidian's phone emulation on a computer. The other newer parts (the preview panel, the windows, the `backtests` table) have been drawn at phone width only in a browser with stand-ins for Obsidian's own objects.
- Five things have not been tried in a running Obsidian: the hover help pop-ups, the ticker lookup's suggestions, the CSV helper's save of a cleaned copy, undoing a one-click fix, and the fallback that runs sweeps and checks in the foreground when the background worker cannot start. They have been checked by unit tests and in a browser only.
- Drafting has never been run against a live model at the time of writing. The tests use a fake server.
- The drawing of the charts and the layout uses the DOM and has no automated tests. Only helpers such as tick spacing and marker placement are tested.
- The cross-check used made-up prices. It says nothing about the data feeds.

**Limits of any backtest**

- Yahoo prices are adjusted for later dividends and splits, so old prices are lower than what actually traded. A rule that compares a price with a fixed number, such as `close > 100`, then means something different in 2005 than today. The plugin warns about it on that line, unless every ticker it reads is an index, which Yahoo does not adjust. Compare with averages, percentages or earlier prices.
- Yahoo only lists tickers that exist now. A test over a basket of today's tickers is a test of survivors, which flatters the results.
- A backtest overstates what to expect, and more so after you have tried many variants. Each rule, parameter or variant you try on the same history raises the chance that the one that looks best fits noise. `test from`, "Try other parameter values" and "Was it luck?" help you see this. They do not remove it.
- Real fills differ from the next open and from the close: spreads, size and liquidity, outages, and your taxes are not in the numbers. A run with `fill: close` assumes you can trade at a closing price that is not known until the close. A real order can only come near it, by being placed just before the close.

## Development

```
npm test           # unit tests, each .ts file run directly by Node
npm run typecheck  # tsc --noEmit
npm run build      # type check, then bundle into dist/
node xcheck/run.ts # optional cross-check; needs the second backtester's command-line tool
```

Obsidian loads one script for a plugin, so the background worker is built into `main.js`: `npm run build` bundles `src/worker.ts` first (`esbuild.config.mjs`) and embeds its text in the main bundle, which starts it from that text.

The cross-check runs 29 cases and 55 indicator expressions. It needs Rearview's command-line tool, `rvw`: the path in the `RVW` environment variable, or else `rvw` on `PATH`. Without it the script says so and exits 0.

Pushing a tag equal to the `version` in `manifest.json` runs `.github/workflows/release.yml`. It runs the tests, builds, and creates a draft GitHub release with `main.js`, `manifest.json` and `styles.css` attached. `versions.json` maps each plugin version to the minimum Obsidian version.

Layout of `src/`:

- `dsl.ts`, `docs.ts`, `complete.ts`, `highlight.ts`, `diagnostics.ts`, `fixes.ts`, `editor.ts`, `symbols.ts`: the language and the editor (parser, help text for hover and auto-complete, colours, underlines, "did you mean" fixes, ticker lookup).
- `evaluate.ts`, `indicators.ts`: evaluating rules, and the indicator maths.
- `engine.ts`, `backtest.ts`, `stats.ts`, `explain.ts`: the simulation, the benchmark, the statistics, and the reasons behind each trade.
- `data.ts`, `runner.ts`, `result-cache.ts`: prices and their cache, running a block, and keeping results in memory.
- `compare.ts`, `dashboard.ts`, `orders.ts`, `orders-badge.ts`, `export.ts`, `rewrite.ts`: the compare block, the `backtests` block (its parser, sorting and running), orders, the status bar count of orders, the files, notes and properties a result can become, and writing parameter values into a block's text.
- `sweep.ts`, `luck.ts`, `rng.ts`: parameter sweeps and the luck checks (reshuffled history, random entries, walk-forward), and the seeded random numbers they use.
- `jobs.ts`, `worker.ts`, `worker-client.ts`: the sweeps and luck checks as jobs, the background worker that runs them, and the plugin's side of it, which starts the worker, sends it prices and stops it.
- `llm.ts`, `llm-modal.ts`: drafting.
- `gallery.ts`, `gallery-modal.ts`, `csv-import.ts`, `csv-modal.ts`: the starter strategies and the CSV helper, each with its logic and its window.
- `live-core.ts`, `live-view.ts`: the strategy preview panel: choosing the block to show, and the panel.
- `render.ts`, `render-params.ts`, `render-trades.ts`, `render-stats.ts`, `render-price.ts`, `price-chart.ts`, `render-sweep.ts`, `render-luck.ts`, `render-compare.ts`, `render-dashboard.ts`, `render-actions.ts`, `orders-view.ts`, `dom.ts`: drawing results, charts, tables and windows. `render-params.ts` draws the Parameters bar, `render-sweep.ts` and `render-luck.ts` the sweep and luck sections, `render-compare.ts` the compare block and `render-dashboard.ts` the `backtests` block.
- `main.ts`, `blocks.ts`, `settings.ts`, `settings-core.ts`, `types.ts`: the plugin itself, settings and shared types.

`styles/*.css` are joined into `styles.css` when you build. `tests/` holds the unit tests, including `readme.test.ts`, which checks every `strategy`, `compare` and `backtests` block in this file.

## Licence

MIT. See `LICENSE`.
