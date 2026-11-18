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

Under the block you get the strategy's return per year, worst drawdown, Sharpe ratio and other figures next to buy and hold, a chart of both, the positions held now, and a list of every trade, each with the reasons for it. A table you open shows, bar by bar, what every part of the rules said and what the run did, to answer "why didn't it buy here?". If the strategy has parameters, sliders run it again with other values. A result can be folded to one line.

The plugin also gives you:

- in the rule language: indicators such as the stochastic, ADX, supertrend, MFI and z-score, a commission on each order, positions built in several entries, stops and targets followed through smaller bars inside each bar (`magnify`), and any numeric column of a CSV file as a value in a rule;
- starter strategies, and a helper that turns a CSV file into a ticker, a column to read in a rule or a small strategy;
- help while you write: colours, auto-complete, help on hover, "did you mean" fixes and a lookup of tickers;
- a preview panel that shows the result of the block you are editing;
- backtests, parameter sweeps and luck checks, which all run in the background, with limits on how large and how slow one may be;
- `compare` blocks, which chart several strategies together, and `backtests` blocks, which list every strategy in the vault;
- today's orders, as a window and as a count in the status bar;
- forward tests, which freeze a strategy in a note of its own and measure only the bars that come after, with a log of the orders its rules gave;
- saved results, and results written to note properties.

This README is the full guide to the plugin. Every `strategy`, `compare`, `backtests` and `forward` block in it is checked by the plugin's own parser when the tests run.

## What it is not

- It is long or flat only. There is no shorting, no leverage and no options. Weights that add up to more than 100% are rejected, and a sell rule only closes a position you hold.
- It never places orders. "Today's orders" lists the orders your rules give and when each applies. You place any trade yourself, somewhere else.
- It is a backtest on adjusted historical prices. It shows what the rules would have done on past data. It does not predict anything.
- It is not financial advice.

It also does not model taxes, market impact or partial fills. A fill is at the next open (or with `fill: close` at the close the rule was read at, or at a stop or target level), made worse by the slippage you set and charged the costs and commission you set, whatever the size of the trade.

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
| `commission` | `commission: 0.005 per share, min 1` | A charge on every order, on top of `costs`: a fixed amount per order, or an amount per share with an optional minimum and maximum. | the plugin setting (none) |
| `entries` | `entries: 3` | Build each position in up to this many entries, each a part of the whole. Needs an `add when` rule. | 1 |
| `magnify` | `magnify: 1h` | Look inside each bar with smaller bars, so a stop and a target in one bar are taken in the order they were reached. | none |

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
- `fill: close` fills each order at the close it was decided at, as a market-on-close order would, instead of at the next open. It applies to everything that otherwise fills at the next open: buys, sells, adds, ranking decisions, rebalancing and buying again after a stop. Stops and targets still fill inside a bar, and watch a position from the bar after the one it was bought at. The result notes that it assumes you can trade at the close the rule read, and which other tickers a rule read a bar early (see "Reading a result"). The rules are under "How the simulation works": rule 1, and rule 6 for other tickers.
- `commission: 1` charges 1 for each order, in the same money as `capital` (`$1` works too). `commission: 0.005 per share` charges 0.005 for each share, a fraction of a share counting as that fraction. After `per share` you can add `min 1`, so an order pays at least 1, and `max 1%`, so it pays at most 1% of its value; the maximum wins over the minimum, as at brokers that charge this way. `min` and `max` go only with `per share`, and the maximum must be above 0% and under 10%. `commission: 0` means none, whatever the plugin setting says. `costs` and `commission` add together when both are set: `costs` is a share of each fill's value, `commission` an amount for each order. How an order is charged is under "How the simulation works", rules 46 to 50.
- `entries: 3` builds each position in up to 3 entries, and needs an `add when` rule (see "Building a position in entries"). It takes a whole number from 1 to 10.
- `magnify: 1h` follows a bar that holds a stop or target through the 1-hour bars inside it, so the result reads which level was reached first instead of taking the stop first, and a trailing stop moves within the bar. Rules are still read at the strategy's own closes. The size must be shorter than `interval` and divide it evenly. Yahoo gives 2m, 5m, 15m, 30m and 1h bars inside daily bars, for the last 60 days (730 for 1h), and 1d bars inside weekly bars. Binance gives any of its sizes, at most 100,000 for a ticker. A CSV ticker is read whole. What is downloaded and saved is under "Smaller bars for `magnify`" in "Prices and privacy"; the notes under the result say from which day each ticker was looked inside and how many bars were read whole instead. The rules are 58 to 65 under "How the simulation works".
- `size`, `capital`, `costs`, `slippage`, `commission`, `from`, `to`, `test from`, `rebalance`, `data`, `interval`, `fill` and `magnify` take written values only. Parameters can stand in for numbers in rules, stops, `hold`, `weighting`, `risk per trade` and `entries` (see "Parameters and ranges").

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

A buy rule opens a position in a ticker you do not hold when the condition is true at a close. A sell rule closes the position when it is true at a close. Both fill at that ticker's next open, or with `fill: close` at that same close. You can write one buy rule and one sell rule for each scope (see the next part), and with `entries` one `add when` rule (see "Building a position in entries"). Without a sell rule a position is held until a stop closes it or the run ends.

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
- A `buy when`, `sell when` or `add when` inside `for TLT:` replaces the shared rule of the same kind, for TLT only.
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
| `column(score) of signals` | A column of a CSV file (see "Signals from a CSV file"). |

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

Another ticker: `sma(200) of SPY` and `close of ^VIX` read a value from a ticker that does not have to be in the universe. `of` applies to the value just before it, so write `(close - open) of SPY` to apply it to a whole expression. A ticker that is not in the universe is loaded from the default source (the `data` line or the plugin setting), or from the source you name, as in `close of binance:BTCUSDT`. For each bar of the rule's own ticker, you get the other ticker's latest bar that had ended by the time this bar ended (rule 6 under "How the simulation works"). Daily tickers on the same dates line up day for day; a weekly bar dated Monday is read from the following Monday, once its week is over. With `fill: close`, a ticker on other hours than the rule's own is read one bar earlier (rule 6). A column of a CSV file is read the same way: `column(score) of signals` (see "Signals from a CSV file").

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
| `column` | `column(name) of file`, or `column(name)` | A numeric column of a CSV file, by its header: `column(score) of signals`. Read like `close of signals`; see "Signals from a CSV file". |

How they are computed:

- Averages, `stdev`, `highest` and `lowest` need n known values, so the first n - 1 bars are unknown. `roc(n)` needs the value n bars back.
- `ema` smooths with 2 / (n + 1), starting from the simple average of the first n values.
- `rsi` and `atr` use Wilder's smoothing (1 / n), seeded the same way. The first true range is the first bar's high minus low.
- `stdev` divides by n, not by n - 1. The Bollinger bands use the same `stdev`.
- `macd_signal` is an exponential average of the macd line.
- `highest` reads the high and `lowest` the low, unless you give another series.

The functions from `stoch_k` on each have one exact definition:

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
- `correl` is the Pearson correlation of the one-bar changes (value over the bar before, minus 1) of this ticker's close and of the series written first, over the last n bars. The other series is read as `of` reads it (rule 6): at each bar of this ticker, from the other ticker's latest bar that had ended, and with `fill: close` from one bar earlier on another clock, when this ticker's closes are taken one bar earlier too, so both changes cover the same days and are known at the fill. On a day when the other ticker had no new bar its change is 0. A series that does not change over the n bars gives no value.
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

These belong to the open position, so only sell rules and add rules can read them.

- `bars held` (also written `bars_held`) is the number of completed bars since the buy filled. It is 0 on the bar of the fill. With several entries it counts from the first.
- `entry price` (also written `entry_price`) is the price the position was bought at, slippage included. With several entries it is their average price, weighted by the shares each bought.
- `last entry price` (also written `last_entry_price`) is the price of the latest entry, slippage included. With one entry it is the entry price.
- `entries made` (also written `entries_made`) is how many entries the position has: 1 after the buy, and one more for each add.

They cannot be used in a buy rule or a `hold` score, inside a function (`sma(bars held, 2)`), with `[n]`, or with `of`. Write them with spaces or underscores, but not as the single words `bars`, `entry` or `entries`.

```strategy
universe: SPY
buy when close > sma(200)
sell when bars held >= 20 or close < entry price * 0.9
```

### Building a position in entries

`entries: 3` builds each position in up to three entries instead of one. The buy rule (or a ranking with `hold`) makes the first entry, a third of the ticker's weight. An `add when` rule, read at each close while the position is held, makes each later one, until there are three. Each entry is a third of the whole position, so the three together come to the ticker's weight, and an entry is cut when the position would otherwise be worth more than its weight.

```strategy
universe: SPY
entries: 3
stop loss: 8%
buy when close > sma(200)
add when close > last entry price * 1.03
sell when close < sma(200)
```

- The add rule is written like a sell rule and can read the position values, such as `last entry price` and `entries made`. It continues on the next lines with `and` or `or`, and a `for TICKER:` section can have its own.
- `entries` above 1 needs an add rule for every ticker, and an add rule needs an `entries` line. To add only on some tickers' conditions, give the others `add when false`; they then hold one entry's part of their weight.
- At most one entry is added at each close, and none at a close where the sell rule holds. The sell rule, a stop or a target sells the whole position: there are no partial sales.
- The stop loss and take profit are measured from the average entry price, so in the block above the 8% stop moves up with each add. The trailing stop trails from the first entry.
- A rebalance keeps a position at its entries' part of the weight: two entries of three are rebalanced to two thirds of it. It never makes an entry.
- The trade list shows a position once, from its first entry to its sale, at its average price.

The exact rules are 51 to 57 under "How the simulation works".

### Parameters and ranges

A parameter is a named number on its own line:

```
fast = 50
```

Use the name wherever a plain number goes: in rules (`sma(fast)`, `close[lag]`, `rsi(n) < limit`), in `stop loss`, `trailing stop` and `take profit`, in `risk per trade`, in `weighting`, in `hold` (`hold: top n by roc(20)`), and in `entries`.

Add a range to say which values are worth trying:

```
fast = 50 in 20..100 step 10
stop = 8% in 4%..12% step 2%
```

- The value after `=` is the one the block uses. It must lie inside the range.
- `step` is optional. It defaults to 1, or to 1% for a percentage.
- A range can hold at most 200 values.
- Write `%` on every number of a percentage parameter. In a stop distance's share (`stop loss: stop`) and in `risk per trade`, use a percentage parameter. In a period, a `top` count, an ATR multiple or `entries`, use a plain one. Inside a rule either works as a number: `limit = 3%` is 0.03.
- A name is letters, digits and underscores, and starts with a letter or underscore. It cannot be a word the language already uses: a series, a function, a one-word setting, a calendar value, or one of `and or not crosses above below is of buy sell when for all in step at top by true false always never min max abs bars entry bars_held entry_price last_entry_price entries_made`. `fast_ma`, `slow_ma` and `stop_pct` are safe.
- Declare a name once. Names do not care about capital letters. A parameter can sit anywhere in the block.

A range changes nothing by itself: the block runs with the value written. Every declared parameter gets a slider in the result (see "The Parameters bar" under "Reading a result"), and a range also enables "Try other parameter values".

### Comments

Everything after `#` or `//` is ignored, when the mark is at the start of a line or follows a space or tab, except inside the quotes of `column("...")`, where a header may hold one:

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
Line 3: Unknown name "smaa". Series: open, high, low, close, volume. Functions: sma, ema, rsi, roc, stdev, highest, lowest, atr, macd, macd_signal, bb_upper, bb_lower, stoch_k, stoch_d, adx, plus_di, minus_di, cci, williams_r, mfi, obv, vwap, keltner_upper, keltner_lower, supertrend, supertrend_up, wma, hma, median, zscore, percent_rank, slope, correl, bars_since, min, max, abs, column. Dates: month, day, weekday, year, month_start, month_end
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

**A broker's commission.** The same trend rule on SPY, at a broker that charges half a cent a share, at least 1 an order and at most 1% of the order. Every buy and sell pays it, on top of the slippage. The note under the chart says how much the costs came to and how much of that was commission.

```strategy
name: Trend with a commission per share
universe: SPY
from: 2010-01-01
capital: 25k
commission: 0.005 per share, min 1, max 1%
slippage: 2 bps

buy when close > sma(200)
sell when close < sma(200)
```

**Stops read inside each day.** Buy SPY after a close below its 5-day average while it is above its 200-day average, and sell after 5 bars. A 2% stop and a 3% target are close enough that both often fall inside one daily bar. With `magnify: 1h` the plugin reads Yahoo's hourly bars to see which was reached first, instead of taking the stop. Yahoo gives hourly bars for the last 730 days only, so earlier days are read whole, and the notes under the result say so.

```strategy
name: SPY dips, stops read inside each day
universe: SPY
from: 2025-01-01
costs: 5 bps
stop loss: 2%
take profit: 3%
magnify: 1h

buy when close < sma(5) and close > sma(200)
sell when bars held >= 5
```

**A channel breakout with volume.** Buy QQQ when it closes above its upper Keltner channel, on-balance volume is above its own 50-bar average and the 60-bar z-score has not stretched past 2.5. Sell when the close falls under its 20-bar average, or when the money flow index passes 85. `obv` has no fixed starting level, so it is compared with its own average.

```strategy
name: Channel breakout with volume
universe: QQQ
from: 2010-01-01
costs: 5 bps

buy when close > keltner_upper(20, 2, 10)
  and obv() > sma(obv(), 50)
  and zscore(close, 60) < 2.5
sell when close < sma(20)
  or mfi(14) > 85
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

The formats a CSV file can take are listed under "Prices and privacy". The other columns of a file can drive rules too (see "Signals from a CSV file").

### Starter strategies

The command "Insert strategy block" opens a window called "Start from a strategy". It lists nine strategies and an "Empty block", each with a few lines on what it does and when it tends to struggle. Choose an entry with the mouse or the arrow keys (Home and End jump to the first and last) to see its text, coloured as it is in a result. "Insert", Enter, or a double-click on an entry puts the block at the cursor of the note you are editing, on its own line. The command works only while a note is open for editing.

| Starter | What it shows |
| --- | --- |
| Trend following on one fund | A buy and a sell rule on one fund, with costs and slippage. |
| Moving-average cross | Parameters with ranges, for "Try other parameter values", and `test from`. |
| Dip buyer in an uptrend | A short RSI, an exit by `bars held`, and a stop loss. |
| Adding to a winner | A position built in three entries with `entries: 3` and an `add when` rule, and a stop that follows the average entry price. |
| Bitcoin breakout | A Binance ticker, a breakout rule and an ATR trailing stop as the only exit. |
| Momentum rotation | `hold: top 3 by roc(126)`, chosen monthly. |
| Three funds with trend filters | Weights, quarterly rebalancing, a `for` section and a benchmark. |
| Calm funds get more weight | `weighting: inverse volatility(60)`. |
| November to April | The `month` calendar value. |

The starters are examples of the language, not advice. Each is long or flat and charges costs. How a strategy did on past prices says nothing about future prices (see "How far to trust it").

## How the simulation works

These are the engine's rules. Each is exact.

**Timing**

1. Rules are read at the close of each bar. A buy or sell that is true at a close fills at that ticker's next open, the next bar of that ticker. With `fill: close` it fills at that same close instead, and so does everything else that would fill at the next open: ranking decisions, adds, rebalancing and buying again after a stop (rules 17, 18, 23, 26, 27, 31 and 51 say how).
2. An order from the last bar in the prices is not filled. It stays pending and is reported in the result and in "Today's orders". With `fill: close` it has filled at that last close, so nothing is left pending, except an order from a ranking decision made at a time a ticker had no bar, which fills at that ticker's next close.
3. The run starts on `from`, or on the first day every ticker in the universe has prices if that is later. Tickers read only with `of`, and the benchmark, do not delay the start. The result warns when the run starts more than 7 days after `from`. It ends on `to`, or on the last bar.
4. Bars before the start feed the indicators. With `from` set, every ticker's prices start a lookback before it: the longest chain of windows and lags in the block's rules, `hold` score, ATR stops and sizing. Nested windows add up, `[n]` adds n, and `ema`, `rsi`, `atr`, `macd`, `plus_di`, `minus_di`, `keltner_upper`, `keltner_lower`, `supertrend` and `supertrend_up` count five times their period, and `adx` ten times, because they depend on where they started. `bars_since` adds 250 bars to what its condition needs, and counts back no further than the prices loaded. A period or lag given by a parameter with a range counts at the largest value of its range, so the sliders, "Try other parameter values" and "Was it luck?" can try any value in it on the prices already loaded. The lookback is at least 250 bars, and for daily and longer bars it reaches 1.6 times as far in calendar time, for weekends and holidays. A CSV file's lookback is counted in its own rows, whatever `interval` says: at least that many rows, and as far in time as its own bar size, the shortest gap between its rows, calls for. Older prices are left out even when they are saved, so the same block gives the same result every time. Without `from`, the whole history is used.
5. The run has one step for each time at which any ticker in the universe has a bar. A ticker with no bar that day keeps its last close for valuing the position.
6. A value read with `of`, the benchmark's value and a cash-rate ticker's yield come from that series' latest bar that had ended by the end of the strategy's bar. A bar ends at its start plus its series' step, the shortest gap between its bars. From a step of 20 days on, the step is counted in calendar months, so a monthly bar dated the 1st ends on the 1st of the next month. Daily series on the same dates line up day for day, whichever days each trades; a weekly bar dated Monday is read from the following Monday; an hourly rule reads a daily bar from that day's 23:00 bar on. With `fill: close`, a rule reads a ticker that keeps other hours than its own ticker one bar early: from that ticker's latest bar that had ended by the time the rule's own bar began, so never its bar of the same day, week or hour. Two tickers keep other hours when the prices show it: they come from different sources (Yahoo, Binance or a CSV file), they have bars on different days of the week (crypto trades at weekends, stocks do not), or their bars are of different sizes. A stock's rule that reads `close of binance:BTCUSDT` therefore reads Bitcoin's previous day, and an hourly rule reads a daily bar from the next day's first hour on. Tickers on the same hours are read as before, and the result notes that it takes the other ticker's close as known at the moment of the fill, which is not true for a market that closes later, such as a New York stock read by a Tokyo one. Binance tickers of one bar size all close at the same moment and get no such note. The benchmark and a cash-rate ticker decide no orders and are read the same way with either fill. A column of a CSV file is read from the file's latest row that had ended: on each bar of the rule's own ticker, `column(score) of signals` is that row's value. In a file with prices a row is a bar, and its columns end with it, as its close does. A file with no prices, a file of signals, holds dated values: a row ends at the end of the day it is dated (UTC), however far apart the rows are, or, when its rows are less than a day apart, at its time plus the shortest gap between them. So a row dated Tuesday is known at Tuesday's close, and an order it decides fills at Wednesday's open. With `fill: close`, a rule whose ticker keeps other hours than the file reads it one row early, as it reads any such ticker.

**Sizing and cash**

7. Equity is cash plus every position at its latest close. Money is in cash until a rule buys. Positions can hold fractions of a share.
8. A buy of a ticker with weight w spends w times equity, valued at the open of the fill (at its close with `fill: close`), but never more than the cash available, with its costs and commission paid on top (rules 14 and 47). The rest stays in cash. With `entries`, each entry spends a part of it (rule 52).
9. A position is sized once, when it is bought, and with `entries` each entry when it is bought. It then drifts with the price until it is sold or a rebalance resizes it.
10. With `weighting: inverse volatility(n)`, the tickers being held or bought share out the sum of their configured weights in proportion to 1 divided by their volatility, the standard deviation of the last n one-bar returns up to the last close before the fill (up to the fill's own close with `fill: close`). A ticker whose volatility is 0 keeps its configured weight.
11. With `risk per trade: r at m atr(n)`, the buy is for r times equity, divided by m times the ATR, shares. The ATR is its value at the close before the fill (at the fill's own close with `fill: close`). The value of the buy is capped at the ticker's weight, and the size is fixed at entry. The distance used for sizing is separate from any `stop loss` line.

**Warm-up**

12. A buy is not taken while an input it needs is still unknown at the close of the signal: the ATR for `risk per trade`, the volatility for `weighting: inverse volatility`, or the ATR of an ATR stop loss, trailing stop or take profit. The buy fills after the first later close at which the inputs are known and the buy rule still holds. In a `hold` strategy the ticker is skipped until the next decision.
13. The result notes how many buy signals each such input held back (signals on consecutive bars count once). It also notes when a buy rule or `hold` score was unknown for more than 5 bars at the start of the run, with the day it became known.

**Costs, slippage and interest**

14. `costs` is a percentage of the value of every fill: buys, sells, stops, targets and rebalancing trades. On a buy it is paid on top of the price; on a sell it comes out of the proceeds. A `commission` is charged as well (rules 46 to 50).
15. `slippage` makes each fill worse by that fraction: a buy fills at the price times (1 + slippage), a sell, including a stop or a target, at the price times (1 - slippage). Costs are charged on the slipped value.
16. Between two bars, cash earns the rate times the calendar days between them divided by 365, using the rate known at the earlier bar. With a ticker, the rate is the close of its latest bar that had ended by the end of the earlier bar (rule 6), read as a yearly percentage: a close of 4.2 is 4.2%. Before that ticker's first such bar cash earns nothing. Only cash earns interest.

**Rebalancing**

17. With a `rebalance` other than `never`, each held ticker goes back to its target weight at the open of its own first bar in each new period, so a ticker that does not trade on the period's first day is rebalanced at its first bar after it. The weight is measured against equity at that open. Sells are made before buys. A rebalance resizes held positions only; it never opens one. Weeks start on Monday; months, quarters and years follow the calendar in UTC. With `fill: close` each held ticker goes back to its target weight at the close of its own last bar in each period instead, measured against equity at that close: the same close at which a ranking decides. A position built in entries goes back to its entries' part of its target weight (rule 53), and with a `commission` a trim or top-up too small for it is not made (rule 49).
18. When a ticker's top-up finds too little cash, for example because another ticker is trimmed only at its own first bar a day later, the rest stays wanted. It is bought at that ticker's later bars in the same period as cash comes in, and lapses when the period ends. With `fill: close` a top-up decided at a period's last close stays wanted at the ticker's closes in the next period, and lapses at its next rebalance. A position sold or stopped in the meantime is owed nothing, and so is a top-up left undone because it was too small for its commission (rule 49). A top-up only spends cash there is, so nothing is borrowed.
19. Rebalancing trades are slipped and charged like any other. They change a position without closing it, so they are not listed as trades.
20. With inverse-volatility weighting, the weights are worked out again at each rebalance.

**Stops, targets and gaps**

21. Stops and targets are set when the position opens, from the fill price, slippage included. A stop loss is the fill price times (1 - x), or the fill price minus x ATR. A take profit is the fill price times (1 + x), or the fill price plus x ATR. Each later entry of a position built in entries sets them again from the average entry price (rule 55).
22. An ATR distance uses the ATR at the close before the fill (at the fill's own close with `fill: close`) and keeps it for the life of the position, later entries included. That ATR is always known, because a buy waits for it (rule 12).
23. The trailing level is the highest high since entry times (1 - x), or minus x ATR. It moves only at the end of a bar: a bar's high counts from the next bar on. Inside a bar looked inside with `magnify`, it moves at the end of each smaller bar (rule 60). On the entry bar it trails the open. With `fill: close` it starts from the close the position was bought at. With several entries it trails from the first: an add does not move it.
24. After the bar's open orders, each position is checked against the bar. If the low reaches the stop (the higher of the stop loss and the trailing level), it exits at the stop, or at the open if the bar opened below it. If the high reaches the take profit, it exits at the target, or at the open if the bar opened above it.
25. If both levels lie inside the bar, the stop is taken first, unless `magnify` looks inside the bar (rules 58 to 65). If the bar opens at or above the target, the target fills at the open, even if the bar later falls through the stop.
26. A position can be stopped out on the bar it is bought. With `fill: close` it cannot: it was bought at that bar's close, after the bar's range, so its stops and target watch it from its next bar on.
27. Within a bar, the order is: pending sells fill at the open; then the rebalance (with any top-up still owed) and pending buys and adds, sells first; then stops and targets; then, at the close, the rules are read for the next open. With `fill: close`: stops and targets; then, at the close, the rules are read and what they decide fills at once, sells first, then the rebalance (with any top-up still owed) and the buys and adds; then the positions are valued at that close.
28. A sell rule and the stops both apply, whichever comes first. A buy is skipped when the sell rule is also true at the same close, and so is an add.

**Re-arming**

29. After an exit by stop loss, trailing stop or take profit, the buy rule has to be false, or unknown, at one close before it can buy that ticker again. A sell-rule exit does not wait. In a `hold` strategy this rule does not apply: a stopped-out ticker can be chosen again at the next decision.

**Ranking (`hold`)**

30. With `hold: top N by score`, a decision is made at each close when `rebalance` is `never`, and otherwise at the last bar of each period. The tickers that can be chosen are those whose buy rule is true (every ticker if there is no buy rule), whose sell rule is not true, and whose score is known.
31. The N highest scores are chosen. Ties go to the ticker listed first. Held tickers not chosen are sold at their next open. Chosen tickers not held are bought once every sell of that decision has filled, at their own next open from then on: the same open as the last sell when both trade then. With `fill: close` the sells and buys fill at the decision's close; a ticker with no bar at that time trades at its next close, and the buys wait for its sell. A buy that has not filled stays wanted until it fills or the next decision replaces it, and a decision that keeps a ticker cancels a sell of it that has not filled. When cash is short, the best score is bought first. With `fill: close` and ranked tickers that keep different hours (rule 6), a decision made at a time when tickers on different hours have a bar reads every ticker's previous bar (its buy rule, sell rule and score) and fills at the decision's close; when only tickers on one set of hours have a bar, it reads their bars and the others' latest finished ones. A ticker read a bar early is still sold by its own sell rule at its close, and is not bought at a close where its sell rule holds.
32. Between decisions, a sell rule or a stop can still exit a position. The freed slot waits for the next decision. Each ticker held gets `size` divided by N.

**Unknown values**

33. A value is unknown while an indicator is still warming up, when you look back past the start of the data, when a ticker read with `of` has no bar that has ended yet (or a file of signals no row that has: rule 6), when a cell of a CSV column is empty or holds no number, after a division by 0, and when `crosses` needs a previous bar that is unknown. `bars_since` is unknown until its condition has been true. `month_start` is unknown on the first bar of the data.
34. A comparison with an unknown value is unknown. `and` is false if either side is false, and otherwise unknown if either side is unknown. `or` is true if either side is true, and otherwise unknown if either side is unknown. `not` of unknown is unknown.
35. A rule only fires when it is true. Unknown never buys or sells, and counts as "not holding" for the re-arm rule.

**Benchmark, statistics and the split**

36. The benchmark holds the same weights as the strategy (or the one ticker you name) from the first open the strategy could have bought at (the first close with `fill: close`), with the same costs, commission, slippage, fills, rebalancing and cash rate, and no rules, stops or entries in steps. A `hold` strategy is compared with holding every ticker in equal parts of the same total size.
37. A benchmark whose prices start after the run does is measured from its own first bar. Before then it has no value, its line starts there, and its figures, and those of each `test from` part, cover only its own dates. The result notes it when the benchmark starts more than 7 days after the run.
38. Return per year is the compound growth rate over the time the run covers, in years of 365.25 days. Worst drawdown is the lowest value of equity divided by its highest previous value, minus 1, at the closes.
39. Sharpe ratio: for each step, take the return of equity minus what cash earned over the same step. Divide the mean of those by their standard deviation (dividing by the count, not by the count minus 1), and multiply by the square root of the steps in a year, where steps a year is the number of steps divided by the years covered. It is not scaled with 252. The benchmark's Sharpe ratio is worked out the same way.
40. The Sortino ratio takes the same returns above cash and divides their mean by their downside deviation: the square root of the mean, over every step, of the squared returns below 0 (a step at or above 0 counts as 0). It is scaled the same way, and is the same figure in the parameter sweep and under "More statistics".
41. A Sharpe or Sortino ratio is 0 when the deviation it divides by is below 1e-12 a step. That is rounding noise, not risk: a run that only earns a fixed cash rate would otherwise show a ratio made of noise, such as -3.42.
42. The volatility shown under "Time invested" is the standard deviation of the one-step returns times the same square root. "Time invested" is the average share of equity held in positions at the closes.
43. The trade count and the share won count closed trades only. A trade is won when its return after costs is above 0. A position still open at the end is not sold in the run: equity values it at the last close, and it is listed as "still held". Its return counts the exit cost, and the commission, as if it were sold at that close, without slippage. A position built in several entries is one trade.
44. A trade's return is its sell price times (1 - costs) over its buy price times (1 + costs), minus 1, with slippage in both prices. With several entries the buy price is their average, weighted by the shares each bought. With a `commission`, the sell price first loses the exit's commission divided by the shares sold, and the buy price gains the entries' commission divided by the shares they bought. Its profit is cash in and out of that ticker, rebalancing trades and commission included.
45. `test from` splits one run in two, at that date. It is not a second run: nothing is reset or re-fitted, and a position open at the date carries over. Each part is measured from the last close before it, so the second part includes the move into its first day and the two parts' growth multiplies to the whole run's. A trade belongs to the part in which it was bought.

**Commission**

46. `commission` is charged on every order, as well as `costs`: each fill of a buy, a sell, a stop or target exit, a rebalancing trim or top-up, a ranking trade and an entry. A fixed commission is charged once for an order. A per-share one is the fee times the shares, a fraction of a share counting as that fraction; `min` raises it to at least that much for an order, and `max` then caps it at that share of the order's value, so an order too small for the minimum pays the cap instead.
47. On a buy the commission is paid on top, like `costs`: the buy is cut so that its value, costs and commission together fit in the cash there is. When the cash cannot pay the commission, nothing is bought. What the buy wanted, its weight or its risk, is unchanged; only the cut to the cash is larger.
48. On a sale the commission comes out of the proceeds, and then out of cash. It never takes cash below 0: a position worth less than its commission is sold for what it brings in and the cash there is.
49. An add (rule 51), a rebalancing trim or a top-up is not made when its commission would be 10% of its value or more, the ceiling the language puts on `costs`. These trades only adjust a position, and with a fixed charge the smallest of them can cost more than they move, such as topping up the few cents of interest that cash earned. A buy that opens a position and a sale that closes one are always made. The result notes how many trades were left undone.
50. The benchmark pays the same commission (rule 36). The costs paid, under the chart, include the commission and say how much of them it was.

**Building a position in entries**

51. With `entries: n`, a position is built in up to n entries. The buy rule or a ranking makes the first; the `add when` rule makes each later one. The add rule is read at each close of a ticker held with fewer than n entries, after the sell rule, and its order fills like a buy: at the ticker's next open, or with `fill: close` at that same close. It makes at most one entry a close, and none at a close where the sell rule holds. With `entries` above 1, a ticker with no add rule is an error, and so is an add rule without an `entries` line.
52. Each entry spends 1/n of what one buy of the whole position would spend at that fill (rules 8, 10 and 11): the weight, or its inverse-volatility share, times equity, or the risk-per-trade amount capped at the weight. An add is cut so the position is worth at most that whole amount after it, and like every buy it is cut to the cash there is. So the entries never take a ticker above its weight, nor the strategy above 100% invested. An add with nothing left to buy is not made and does not count.
53. A rebalance takes a position with k of its n entries to k/n of its target weight; it never makes an entry. When a rebalance and an add fall on the same fill, the add is sized against what the position is worth once the rebalance's trades are made. A trim left undone for its commission (rule 49) leaves the position as it is. A top-up that buys less than it wanted, for lack of cash or for its commission, leaves the add sized from the position as it then is. A top-up still owed (rule 18) that finds the position at or above its target buys nothing. With `hold`, the ranking makes the first entry and the add rule the others, at any close: a decision that keeps a ticker does not add to it, and one that drops it sells it whole. When cash is short, adds are paid for along with the buys: in ranking order with `hold`, and in the order of the universe without it.
54. In sell and add rules, `bars held` counts from the first entry's fill, `entry price` is the average fill price of the entries weighted by their shares, `last entry price` is the fill price of the latest entry, and `entries made` is the number of entries. Rebalancing changes none of them.
55. Each entry sets the stop loss and take profit again from the new average entry price: the average times (1 - x) or (1 + x), or minus or plus the ATR distance set at the first entry (rule 22). The trailing stop keeps trailing from the first entry (rule 23). The new shares are watched by the stops from the bar they were bought at, or with `fill: close` from the next bar, as a buy is (rule 26).
56. The sell rule, a stop, a target and a ranking sell the whole position. There are no partial sales.
57. A position is one trade from its first entry to its sale: its entry price is the average of its entries, its bars held count from the first, and the trade count and share won count it once. An add left waiting at the last bar is reported like a buy, and "Today's orders" lists it as "Add SPY", with "Step 2 of 3". It is not reported when the position is already worth its whole weight at the last close, as there is no room for it. One that only the cash stands in the way of is reported, as a buy is, since the sales and trims at that open are paid out first.

**Looking inside bars (`magnify`)**

58. `magnify: 1h` follows the stops and targets of each Yahoo or Binance ticker in the universe through the 1h bars inside the strategy's own bars. It changes nothing else: rules are read at the closes of the strategy's own bars, and buys, sells, adds, ranking decisions and rebalancing fill where they would without it (rule 27). Indicators, `of`, ATR distances and sizing never read the smaller bars. The size must be shorter than `interval` and divide it evenly, and the ticker's source must give it (see the setting). A CSV ticker is read whole.
59. A bar is looked inside when a position is held in it after the orders at its open (so a position bought or added to at that open counts, with the levels it set), the bar opens above the stop and below the target, and its high reaches the target or its low reaches the stop at the highest the trailing level could rise to within the bar (from the bar's high). Any other bar comes out the same either way, and is read whole as in rules 24 and 25.
60. Inside, the smaller bars are read one after another, each by rules 24 and 25: when a smaller bar's low reaches the stop it exits at the stop, or at that smaller bar's open if it opened below it; when its high reaches the target it exits at the target, or at its open if it opened above it; when both lie inside one smaller bar, the stop is taken first. The trailing level moves at the end of each smaller bar with its high, so a high counts from the next smaller bar on. The exit belongs to the bar: it is dated with it, and pays slippage, costs and commission as any exit.
61. A bar's smaller bars are those that start within it, from its start to its start plus `interval`. On Binance a bar must have all of them, such as 24 one-hour bars in a day. Yahoo's intraday bars are read on the exchange's clock, as its daily bars are dated by the exchange's day, and a day's bars are kept only when they cover that day's regular session, as Yahoo's answer gives it, from its open to its close, one after another, each a whole bar. A day with a gap is left out, and so is a day that closes early whose last bar Yahoo leaves empty.
62. The smaller bars must match the bar. Each of the bar's open, high, low and close is divided by the smaller bars' first open, highest high, lowest low and last close. The smaller bars are scaled by the square root of the smallest of the four ratios times the largest, and the four prices scaled must each lie within a quarter of the bar's range (high minus low) of the bar's own. One factor is right for a whole bar: Yahoo adjusts its daily prices for splits and dividends and its intraday prices for splits only, and an adjustment changes only between one day and the next. Then the bar's own prices go where the smaller bars put them: the first smaller bar opens at the bar's open, the first one with the highest high reaches the bar's high, the first with the lowest low the bar's low, and every other price is kept within the bar's range. So nothing fills at a price the bar did not reach, and only the order comes from the smaller bars.
63. A bar of rule 59 whose smaller bars are not there, are not all there or do not match is read whole, and so is every bar before a ticker's smaller bars start. The notes say from which bar each ticker was looked inside and why not earlier, how many bars with a level inside them were looked inside, and how many in that time were read whole.
64. Smaller bars are loaded from the run's first day, or from the earliest the source gives them if that is later, counted back from the start of the current day in UTC; no history before the run is loaded for them, since nothing is held there. Yahoo gives 2m to 30m bars for the last 60 days and 1h bars for the last 730, of which the last 59 and 729 days are loaded, and its daily bars as far back as its weekly ones. Binance gives every size from the market's start, and at most 100,000 are loaded for a ticker: 69 days of 1m bars, 347 days of 5m bars, 2.9 years of 15m bars or 11.4 years of 1h bars. They are saved like other prices, Binance's in a file of their own kept to that count, and count as bars toward the size of a run.
65. With `fill: close`, a position bought at a close is watched from its next bar (rule 26), which is looked inside as any. A position built in `entries` is followed with its levels as its entries set them, so an add filled at an open moves the stop loss and the take profit for the rest of that bar (rule 55). A universe of stocks and crypto looks inside each ticker with its own source's bars, from its own first day of them.

## Reading a result

From the top:

1. **Title and summary.** The `name` (or "Backtest"), on a button that folds the result to one line (see "Folding a result"). Then a line of what was run: tickers and weights, sizing, the number of entries, rebalancing, bar size, costs, commission, slippage, stops, and parameter values. Percentages are written as the block writes them (`12%`, not `12.0%`), and a parameter that is a stop is shown once, as the stop.
2. **Refresh prices.** A button that fetches the prices again and runs the block again.
3. **The strategy as written**, coloured.
4. **Parameters.** Only when the strategy declares parameters: a bar with a slider for each one (see "The Parameters bar").
5. **Notes.** What the run has to say, one line each:
   - prices that could not be refreshed (see "Prices and privacy");
   - buy signals held back while a sizing or stop input warmed up, and a buy rule or `hold` score still unknown at the start of the run;
   - adds and rebalancing trades left undone because their commission would have been too large a part of them (rule 49);
   - with `fill: close`, that the run assumes you can trade at the close the rule read, and which other tickers a rule read a bar early or took as known at the fill (a CSV file whose columns are read says this in its own note);
   - with `magnify`, from which day each ticker was looked inside and why not earlier, how many bars with a stop or target inside them were looked inside, and how many were read whole because their smaller bars were missing or did not match;
   - when a rule reads a column of a CSV file, how its rows must be dated, and with `fill: close` which row an order at a close rests on (see "Signals from a CSV file");
   - a benchmark whose prices start later, and a warning when the run starts more than 7 days after `from`;
   - the parser's notes, with their line number.
6. **Six figures.** Return per year, total return, worst drawdown and Sharpe ratio, each with the benchmark's value underneath. Then "Time invested", with volatility a year underneath. Then "Trades": the count of closed trades, how many were won and the average return. It says "none closed yet" when only open positions exist, and "the buy rule never fired" when there were none.
7. **The chart.** The strategy and the benchmark on a log scale, with the final value of each in the key above it. Underneath, the drawdown from the previous high. Hover or tap to see the date, both values, both drawdowns and the share invested. A benchmark whose prices start later is drawn from its first value, and shows "–" before it. With `test from`, the test period is shaded.
8. **A short note.** The dates, the starting money, "A rule seen at a close fills at the next open." (with `fill: close`: "A rule seen at a close fills at that close."), with `magnify` "A bar with a stop or target inside it is followed through its 1h bars, where it has them.", costs paid with the commission in them ("Costs paid: $812.40, of which $96.00 commission."), and interest earned on cash. Then "Prices through" a date, from Yahoo, Binance or your CSV files.
9. **Before and after the test date**, only with `test from`. A table of return per year (strategy and benchmark), worst drawdown, Sharpe ratio and trades, for each part.
10. **Positions.** One row for each ticker: its weight, whether you are long since a date or in cash (with `entries`, how many entries the position has, such as "2 of 3 entries"), whether an order is waiting (for the next open, or with `fill: close` for the next close) or was made at the last close, the closed trades, the share won and the average trade.
11. **Trades.** A list you open, newest first: a button, ticker, bought, price, sold, price, return after costs, profit and how it ended: "sell rule", "stop loss", "trailing stop", "take profit" or "still held". It shows the latest 500 trades. Intraday times are in UTC. A position bought in several entries is one row: its bought date is the first entry's, followed by the number of entries ("2024-03-01, 3 entries"), and its price is their average. The button at the start of each row, "Explain this trade", says why the trade happened (see "Explaining a trade").
12. **More statistics.** A table for the strategy and the benchmark: Sortino ratio, return per year divided by worst drawdown, best and worst year, the share of months with a gain, the longest time below a previous high, and best and worst month. Then a chart of the return in each calendar year, and a table of the strategy's return by month. Years the data only partly covers are faded. The Sortino ratio here takes off what cash earned, like the Sharpe ratio, and is the same figure as in the parameter sweep (rule 40 under "How the simulation works"). A benchmark whose prices start later is measured from its first value.
13. **Regimes and crises.** A section you open, in two parts:
   - *By market state.* How the strategy did while the market was in each of a few states: SPY above or below its 200-day average, the VIX at 20 or higher or under 20, and the 10-year yield (`^TNX`) above or below its close 126 trading days earlier. A strategy that trades only on Binance gets Bitcoin's states instead: `BTCUSDT` above or below its 200-day average, and its volatility (the standard deviation of its last 30 daily returns) above or below the median of that over the last 365 days. A strategy that mixes Yahoo and Binance tickers, or reads only CSV files, gets the stock market's.
   - *Market falls.* Each fall of the market from its closing high to its closing low that the run covers in full: the S&P 500's 2000-03-24 to 2002-10-09, 2007-10-09 to 2009-03-09, 2011-04-29 to 2011-10-03, 2015-05-21 to 2016-02-11, 2018-09-20 to 2018-12-24, 2020-02-19 to 2020-03-23, 2022-01-03 to 2022-10-12 and 2025-02-19 to 2025-04-08, and for a strategy with a Binance ticker Bitcoin's 2017-12-17 to 2018-12-15 and 2021-11-10 to 2022-11-21. For each fall: the strategy's return and the benchmark's from the close of the peak day to the close of the trough day, the worst fall within that time, the average share of equity held at its closes, and the day the strategy's value got back to the highest it had reached before the fall began ("Never below it" when it did not fall below that, "Not by the end" when it had not got back by the run's last bar). A run covers a fall when a bar of it had ended by the close of the peak day and its last bar is on the trough day or later. With weekly or hourly bars the figures are taken at the last bar that had ended by each of those closes, which for a daily run is the bar of that day. A run that covers none of the falls says so. This part needs no prices besides the run's own, and is drawn at once.

   Each state is worked out with the rule language on its own ticker's daily bars, as `close > sma(200)`, `close >= 20` and `close > close[126]`, so a close equal to its average counts as below it, and a VIX of exactly 20 as 20 or higher. A bar of the run takes the latest daily bar that had ended when its own bar ended, as `of` does (rule 6 under "How the simulation works"), so a weekly or hourly strategy is put in the same states a daily one would be. The step from one close to the next is put in the state known at the first, so a state is never read from the step it is judged by. A state is unknown until its ticker has enough bars, and `^TNX`'s also for 126 bars after a jump of more than threefold between two closes, which is how a series quoted in other units shows. Those steps are listed as "Not known yet". For each state the table gives its share of the run's steps, the strategy's return compounded over them (per year once they add up to a year or more, otherwise the total, and each says which), the benchmark's over the same steps (steps where the benchmark has no value are left out), the average share of equity held, and the worst fall within one unbroken stretch in the state, counting the value where the stretch began as a high.

   The market's prices are not part of the run and are not fetched with it. The part for market states shows a button, "Load SPY, ^VIX, ^TNX from Yahoo" (for Bitcoin, "Load BTCUSDT from Binance"), and fetches them only when you press it. When they are already saved and still fresh (see "What is saved on disk"), it reads them from the saved files and shows the table without a button. They are saved like any other prices, with the history the rules need before the run's first day, and the same block gives the same result whether or not they were ever loaded.
14. **Prices and trades.** The price of one ticker with the periods you held it shaded, and a marker for each buy and sell. A position bought in several entries has a buy marker for each entry, at its fill price; the tooltip says how many entries it had, the first one's day and their average price. With more than one ticker there is one button for each, or a list when there are more than 12. Above it: the number of trades, the share of the time held, and what holding it throughout returned. When there are too many trades to mark at the chart's width, only the shaded bands are drawn.
15. **Rule values, bar by bar.** A section you open: a table of what every part of the rules said at each bar and what the run did there (see "Rule values, bar by bar").
16. **Try other parameter values.** Shown when a parameter is declared with a range, such as `fast = 50 in 20..100 step 10`. A button runs every combination of the ranges, up to 2,000 combinations. Then it shows a chart for one ranged parameter, or a heatmap for two. They show where the values written in the note rank among all the variants, the median variant, and whether the best variant's neighbours do similarly well. With `test from` set, the view starts on the period before the date, the best variant is chosen on that period, and its result after the date is shown. The line under the reading says which period chose the best values ("Best before 2015-01-01: fast = 40, slow = 250"). If you switch the view to the whole run or to the period after the date, that line no longer suggests values, because values picked there have seen the test period and their later result would not be a fair test. To put a variant's values into the block, click or tap its point on the chart, its cell in the heatmap, or its row in the table of best variants, then press "Use these values in the block". The best variant has the same button, except on a view that includes the test period. It writes the numbers the way "Write these values to the block" does (see "The Parameters bar"). The button is off while it writes, and the line next to it says "Done: the block now uses these values." only once the write has happened. If the note has changed since the result was drawn, nothing is written and the line says so. Nothing is written to the note unless you press the button.
17. **Was it luck?** A button that runs three checks. *Reshuffled history* resamples the run's returns in blocks, to give a range for return per year and for worst drawdown. It shows how much the path and the drawdown depended on the order of the returns; it says nothing about whether the average return will persist, because every version is made from the run's own returns. *Random entries* makes the same number and length of trades at random times, to see how often random timing does as well, with the strategy's costs, commission and slippage. A position built in `entries` keeps how many it made and puts the later ones the same number of bars after its first. For a `hold` strategy this check is *Random picks*: it runs the strategy's rules, stops and add rule but ranks the tickers they allow at random. *Walk-forward* runs only when a parameter has a range: it picks the best values on a training window, applies them to the next unseen window, and repeats. Each window is measured from the last close before it, so the test windows' growth multiplies to the line's. When a slider under "Parameters" has moved, the checks test the run shown, with the slider's values, and a line above them says so ("These checks test the run shown, with fast 25. The block says fast 10."); walk-forward then draws "Values shown" instead of "Values in the note". "Try other parameter values" always ranks the values written in the block.
18. **Save buttons.** "Save trades as CSV", "Save value history as CSV" and "Keep this result as a note" (see "Saving results").

Every backtest runs in the background, so the note stays usable while it runs: a block's own run, its sliders, the strategy preview, a `compare` block, a `forward` block, "Today's orders", the count in the status bar and a `backtests` block. These runs have a background worker of their own, so they never wait for a sweep, and the runs of blocks on screen go before those of the vault's scans. The variants and the checks run in a second worker. A bar shows how far they have got, and "Stop" ends them at once. A stopped sweep shows the variants it had finished, and a stopped check says it stopped; "Run checks again" runs them again. When several blocks run checks at once they take turns, and a block that waits says "Waiting for another run to finish…". A worker that has not started after 5 seconds is ended and its run happens in the foreground; the next run tries a new one. Where Obsidian cannot start a background worker (one fails to start, or two in a row are that slow), everything runs in the foreground, and Obsidian does not respond while a backtest runs (see "When a backtest is too large"); the variants and checks then run a few backtests at a time between repaints.

A result is kept in memory (the latest 40, and no more than about 100 MB of them), so scrolling or switching views does not run it again. It runs again when the block's text or the plugin's defaults change, when the modified time of a CSV file it reads changes (or the file goes missing), when the prices it was worked out from are older than the "Keep saved prices for" time, or when you press Refresh prices. Prices a failed download left on their saved copy count from when the result was worked out, so a result made offline is not run again at every drawing. "Refresh prices" in the orders window and "Run again" under a `backtests` block count prices as fresh only from when they began, so they reuse no result worked out from older ones, even one that finished after they began.

A result on screen keeps the defaults it was worked out with, including its sliders, sweep and checks. When you change a default setting that shapes it (starting money, costs, slippage, commission, interest on cash, where plain tickers come from), the block says "The default settings were changed after this result was worked out. It still has the old ones." with a "Run again" button. A block that writes all of these itself says nothing.

### Folding a result

The title is a button. Click it to fold the result to one line, and click again to open it. The line shows the strategy's name, return per year, worst drawdown, what it holds now ("Long SPY since 2026-03-02", with `entries` "Long SPY since 2026-03-02, 2 of 3 entries", "Holds 2 of 5" or "In cash") and any order waiting or made at the last close ("buys TLT at the next open", "adds to SPY at the next open"). A strategy with no name shows its tickers after "Backtest". A small mark says how many notes the result has. The chart, the tables and the sections are drawn only when the block is first opened.

The setting "How results first appear" decides how a block starts: Full (the default) opens it, Compact folds it. Obsidian draws a block again when you scroll or switch views, and the block comes back the way you left it for the rest of the session. A named block is remembered by its name, and an unnamed one by its place in the note. A block that can't run always shows in full, with its problems.

### The Parameters bar

A strategy that declares parameters gets a "Parameters" bar under its text, with a slider for each parameter and its value in the block's own form (`50`, `8%`). With a range, the slider follows it (`in 20..100 step 10`). Without one, it runs from about half to double the value, in whole steps for whole numbers, and is cut back to values the language accepts: for `n = 2` in `zscore(n)` it starts at 2, not 1, and for `entries: n` it stops at 10.

- Drag a slider, or use the arrow keys, and the strategy runs again with that value on the prices already loaded. While you drag, the figures, the key and the main chart follow and the rest of the result dims. When you let go, the whole result is drawn again, so a section you had open closes.
- One run is out at a time. While it runs, the latest slider position waits and the positions it passed are skipped, so a slow strategy follows the drag a few times a second without falling behind. Where Obsidian cannot start a background worker, a strategy that takes more than 12 ms to run does not run at every step; the bar then says "This strategy takes too long to run again at every step of a drag. It runs when you let go of the slider."
- Nothing is downloaded while you drag. A value that needs more price history than is loaded leaves the result as it was, and the bar says so. The history loads once, when you let go of the slider, and the bar says "Loading more price history…" while it does.
- A value the language rejects is not run. The bar says why and keeps the last result that ran.
- When the result on screen differs from the block, a line says so ("Showing fast 80. The block says fast 50.") and shows two buttons. "Reset" goes back to the block's values. "Write these values to the block" changes only those numbers in the note; spacing, comments, ranges and `%` stay as they were. The button is missing where the block cannot be edited, such as in some embeds. Both buttons are off while the write runs. If the note has changed since the result was drawn, nothing is written, and the bar says so under the buttons: "Couldn't write the values to the block. The note has changed since this result was drawn, so nothing was written. Try again."
- When Obsidian draws the block again, the sliders go back to the block's values.

### Explaining a trade

The button "Explain this trade", a small arrow at the start of each row of the trade list, opens a box under the row. Click it again to close the box. The box has four parts. Its numbers are worked out again from the same prices when you open it.

- **Why it was bought.** The close the buy rule was read at. The rule as you wrote it, with the value of each part there and whether it held (✓ yes, ✗ no, ? unknown). For `crosses above` and `crosses below`, the bar before. For `of` and `column`, which bar of the other ticker, or row of the CSV file, was read. With `fill: close`, when the fill came at a later close than the one the rule or the ranking read. The parameter values. With `hold`, the ticker's place in the ranking, and the whole ranking when there are 12 tickers or fewer. Then anything that made the buy wait: an input still warming up, a stop or target exit after which the rule had to stop holding first, or the sells of the same ranking.
- **How much.** The portfolio's value at the fill; the weight, or the risk per trade with its ATR, or the volatility for `weighting: inverse volatility`; any cut for lack of cash; the money, the costs and the commission, and the shares; and the fill price at the open (with `fill: close`, the close) with the slippage.
- **Why it was sold**, or **Why it is still held**. The sell rule with its values, or the stop or target: where it was, how it was set, the ATR or highest price behind it, and whether the bar opened beyond it or crossed it during the bar. With `hold`, the ranking it dropped out of. With `magnify`, an exit decided inside a bar names the smaller bar the level was reached in and its start (Yahoo's on the exchange's clock, Binance's in UTC), and, when the stop and the target were both inside the bar, that its smaller bars show which came first; a bar read whole says why: no smaller bars for it, some missing, or not matching it. For a position still held: the sell rule at the last close, and whether a sell is waiting.
- **Result.** Return and profit after costs, the bars held, the number of entries and their average price when there were several, the costs paid with the commission in them, and how often rebalancing topped the position up or trimmed it.

With `entries`, "How much" is about the first entry, and each later entry gets a part of its own before the sale: the add rule at the close it was read at, with its values; the whole position, the step of it the entry was, and any cut to keep the position within its weight or to the cash there was; the money and the fill; and the new average entry price, with where the stop loss and take profit moved. A stop that sold the position says it was measured from the average entry price.

### Rule values, bar by bar

The section "Rule values, bar by bar" answers "why didn't it buy here?". It stays shut until you open it. It shows one ticker at a time, with a button for each ticker when there is more than one (a list when there are more than 12), as a table with one row for each bar. It opens on the last 60 bars of the run. A long run takes a moment to open: a line counts the parts of the rules being worked out, and the note stays usable. After that only the rows on screen are built.

- **Moving.** "← Earlier" and "Later →" move by one window of 60 bars. "Go to date" shows the first bar on or after a date, with 8 bars before it. "← Previous trade" and "Next trade →" go to the bar each buy was decided at, the close the rule or the ranking was read at, and mark it.
- **The filter.** "Only bars where something happened or nearly happened" hides a bar where the buy rule did not hold, no position was held, nothing was recorded for the bar (a buy, a sale, an add, a wait) and the buy rule did not nearly hold. "Nearly" means the buy rule is two or more parts joined by `and`, every part held but one, and that one was false. A part that is unknown does not count as a near miss.
- **The columns.** The date (with the time, in UTC, on short bars) and the close, then "What happened" and "Position", so they are in view before the rule columns. The date stays in view when the table is scrolled sideways. Then one column for each part of the buy rule, headed with your own text, with the two values it compared and ✓ yes, ✗ no or ? unknown, and one for the whole rule. A rule that is a single comparison has just the one column. Long text is cut in the heading; the whole text is in its tooltip and in the list under the table. Then the same for the sell rule and, with an `add when` rule, for its parts. With `hold`, a "Score" column and a "Place" column follow.
  - A comparison with `bars held` or another position value shows a dash while no position is held, and `entries made`, `last entry price` and `entry price` show their value at that bar.
  - Sell columns are dimmed on bars with no position but still show what the rule said, because a buy is skipped when the sell rule holds at the same close.
  - Add columns are read only while a position has room for another entry, and show a dash when none is held or all entries are made.
  - "Place" is the place among the tickers that could be chosen, at the bars where the ranking decides.
  - "Position" reads "Flat", "Long, 62.66 shares", or with `entries` "Long, 2 of 3 entries, 62.66 shares". When a rebalance has resized the position it reads "Long, bought 62.66 shares". It is the position at the end of the bar, after the bar's fills, so a bar that added an entry and then hit its stop reads "Flat".
- **Unknown values** are shown as unknown, with the reason where it is easy to tell: an indicator still warming up, a `bars_since` whose condition has not held yet, a `zscore` window in which every value is the same, a `correl` window in which one of the two series changes by the same amount on every bar, another ticker with no finished bar yet, no position held, looking back past the first bar, a CSV file with no number in that row, or dividing by 0.
- **What happened** is taken from the run's own record of its trades, not worked out again, so it agrees with the list of trades. Within one bar it lists things in the order they happened: orders from the last close filling at the open, then a stop or target reached during the bar, then what the close decided. It says what each bar did: a buy decided at this close and filled at the next open (with the date and the price), or at this close with `fill: close`; the fill itself; a sale by the sell rule; a stop loss, trailing stop or take profit; a position kept or dropped by the ranking. It also says why no buy happened: the buy rule held but the position was already long, the sell rule held too, the buy was waiting for the rule to stop holding after a stop, an input such as an ATR was still unknown, or an order is pending after the last bar.
  - An add reads "Add rule held: added entry 2 of 3 at the next open (2020-01-09) at 109.00." on the bar that decided it, and "Added entry 2 of 3 at the open at 109.55. Average entry price now 107.17; stop loss moved to 100.74." on the bar that filled it.
  - It says when the add rule held with the position already whole. When the add rule held and no entry followed, the run does not record why, so it names every cause that fits: no cash was free, or the position was already as large as its weight allows, and, when some trades were left undone for their commission, that the commission would have been 10% or more of the add.
- **Save as CSV** writes every bar of the ticker's run to the "Folder for saved results", as `<name> rule values <ticker> <date>`, with a line that says how many bars are done while it is made. When the file would be over about 20 MB, the section first says how big it would be and asks whether to save every bar ("Save every bar") or only the bars shown. A file too large to make whole, over about 400 MB, offers only the bars shown. The bars shown are saved as `<name> rule values <ticker> bars 121 to 180 <date>`, the numbers being the first and last bar shown. It has the date (or the time, in UTC), the close, for each comparison its two values and its result (a cross also has the values of the bar before), for each other part its result (`yes`, `no` or `unknown`), the position (`flat` or `long`), the shares, with `entries` above 1 the number of entries, and what happened. Values are plain numbers, headings use your own text, and fields with commas are quoted.

### When a backtest is too large

Two limits keep one strategy from holding up Obsidian.

- **Size.** Before a run starts, the plugin counts its bars across every ticker it loads (the benchmark, tickers read with `of` and the smaller bars of `magnify` included), and the values its rules work out: each part of a ticker's buy, sell and add rules and `hold` score on each of its bars. A run with more than 1,000,000 bars, or more than 25 million rule values, does not start. The block says "This backtest is too large to run", gives the numbers and the limit ("This run has 2.1 million bars across 40 tickers; the limit is 1 million."), and what makes it smaller: a later `from` date, a longer `interval` or fewer tickers. When most of its bars are the smaller bars of `magnify`, it suggests a longer `magnify` size instead of a longer `interval`.
- **Time.** A run still going after 10 seconds is stopped. The block says "This backtest took too long", how long it ran and how many bars it has.

Both have a button that runs the block as it is: "Run it anyway" after a size refusal, and "Run it anyway, for up to 2 minutes" after a time stop. Either way the run has no size limit and up to 2 minutes, and so do the block's sliders afterwards, also when the result is shown again from the kept results. A run stopped after 2 minutes has no button.

Where Obsidian cannot start a background worker, a run cannot be stopped and Obsidian does not respond while it runs, so the limits are stricter: 200,000 bars, 4 million rule values, and 200 million prices read by functions, where `sma(200)` on 1,000 bars reads 200,000. The message then starts "Backtests run in the foreground here".

A strategy that hits a limit in "Today's orders", the status bar count, a `backtests` block or a `compare` block is listed as one that could not run, with the same message, and the others still run. The strategy preview shows the message with its button, and a `forward` block shows it with "Try again". A sweep or a luck check that goes 2 minutes without finishing one backtest is stopped and says so.

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

The "Next" column lists the orders: sells first, then buys, then adds to positions held ("Buy B", "Add A"). More than three tickers in one line are cut after three ("Sell A, B, C and 2 more"). An order for the next open has no time after it ("Sell TLT, GLD"). An order for the next close ends "at the next close", and what a strategy with `fill: close` did at the last close reads "Bought SPY at the last close", "Added SPY at the last close" or "Sold SPY at the last close". A dash means no order.

Rows appear as each strategy finishes, three at a time; until then a row says "Running…". A strategy that cannot run shows why across its row and does not stop the others. Click a column heading to sort by it, and again to reverse; strategies that could not run or are still running stay at the bottom. Under the table are the number of strategies, when the figures were worked out, and "Run again", which lists the vault again, drops the results kept in memory once, when the round starts, and runs everything with fresh prices. On a narrow pane the table scrolls sideways and the strategy's name stays in view. If the vault has no strategies, the block says so and how to add one.

## Today's orders

The command "Show today's orders", or the ribbon icon of the same name, opens a window. It runs every `strategy` block in every note of the vault that has the word "strategy" in it, and lists the orders each one has and when each applies. Blocks are found as described under "Comparing and combining strategies": ones in callouts count, examples inside a longer fence do not.

- **To do at the next open.** One row for each order of a strategy that fills at the next open: Buy or Sell, the ticker, the size, the strategy (click it to open its note), the last close, and which bar it is based on, such as "Based on the close of 2026-11-13". For strategies with bars shorter than a day the row shows the time too, in UTC, such as "Based on the 5m bar starting 2026-11-13 14:05 UTC". Sells are listed first. A buy's size is its target share of the strategy and about how many dollars that is at the backtest's current value, which grows or shrinks from the block's `capital`. A sell is the whole position. With `entries`, a buy says which entry it is ("Step 1 of 3") and is sized as that entry, and an add is listed as "Add" ("Add SPY"), with "Step 2 of 3" and that entry's size. Scale the percentage to your own money. The dollar figures are about the backtest, not about your account.
- **To do at the next close.** Orders of a strategy with `fill: close` that could not fill at the close they were decided at. This happens when a ranking decision is made at a time a ticker has no bar: its order waits for that ticker's next close. The rows look like the ones above.
- **Traded at the last close.** What a strategy with `fill: close` did at the close that has just passed. Its backtest has already bought or sold, so the row says Bought or Sold. To match it, the order had to be placed before that close. A buy shows its share of the strategy, a sell the whole position and the day it was opened.
- **Holding.** Strategies that hold something or have no order, and what they hold. A position that has an order row, including one bought at the last close, is not listed again here.
- **Strategies that fill at the close.** The strategies with `fill: close`, under this note: "A strategy with fill: close decides and fills an order at the same close, so the order has to be placed just before a close. What is listed for it is what its rules said at the last close."
- **Problems.** A block that could not run (one that is too large or takes too long to run is listed here with its message, see "When a backtest is too large"), prices that are out of date, and any warning from loading prices. For daily bars, prices are out of date when they end more than 4 calendar days ago. For bars shorter than a day, they are out of date when the last bar is more than 3 bars old, and for weekly bars when it is more than 2 bars old.

A group with no rows is left out. When no strategy has an order, the window says "Nothing to do. No strategy has an order."

The header says which bar the orders are based on. Orders under "To do at the next open" are for the open after that bar, and under "To do at the next close" for the close after it. "Traded at the last close" is that bar's own close. When the strategies with orders end on different bars, the header shows the oldest and says so, and each row shows its own. Yahoo's bar for the current day is used once the exchange's regular session has closed, when Yahoo's answer gives that time; until then, and when it does not, the orders refer to the previous close. Check the date.

Refresh prices downloads each ticker once, however many strategies use it, then runs the strategies again, three at a time. "Save as note" writes the same list to the note named in the "Note for today’s orders" setting, creating it if it does not exist and replacing its whole contents each time. The saved note has one section for each group that has rows ("To do at the next open", "To do at the next close", "Traded at the last close"), or "To do" with "No strategy has an order." when there are none, and names the strategies with `fill: close` under "Strategies that fill at the close". The generated note starts with the property `backtest_orders: true`. An existing note is replaced only if it has that property; otherwise nothing is written and the window says "<path> already exists and was not made by Backtest Blocks. Choose another note in settings." With no note set, it says so. Nothing in the window places an order.

A block with no `name` is listed under its note's file name, or "file name 1", "file name 2" when a note has several.

### In the status bar

A few seconds after Obsidian starts, the plugin runs every strategy in the vault quietly, from saved prices where they are fresh, and shows how many orders there are in the status bar, counting every group in the window: "2 orders today", "1 order today" or "No orders today". Rest the pointer on it to see the first five, each with its timing, such as "Sell SPY at the next open, Trend following", "Add SPY at the next open, Built in entries" or "Bought TLT at the last close, Close mover". Click it, or press Enter when it has focus, to open the window.

- A small dot after the text means some strategy could not run, has old prices or came with a price warning. The tooltip says how many.
- When no strategy could run, or the check itself failed, it says "Couldn't check orders", and it checks again 10 minutes later. It shows nothing when the vault has no strategies.
- It checks again by itself once its answer is older than the "Keep saved prices for" time, and it takes the answer of the orders window whenever you open that, so the two agree.
- Where there is no status bar, as on a phone, a notice with the same text appears once at start-up when there are orders, and nothing appears otherwise.
- The setting "Check for orders when Obsidian starts" turns this off. Turning it off hides the count and stops the checks at once. Turning it on starts them again after a few seconds. With it off, the status bar stays empty, even when you open the orders window; the window and the ribbon icon still work.
- Like the window, the check fetches prices for every strategy's tickers (see "Network requests").

## Forward tests

A backtest runs rules over prices that were already there when you wrote them, so the prices may have shaped the rules. A forward test starts a clock instead. It freezes the rules and the day, and measures only the bars that come after that day, which the rules could not have been chosen on. It places no order and holds no money: it is a backtest of the frozen rules, read from the first bar after the start.

**Starting one.** "Start a forward test", in the row of buttons under a result, writes a note of its own to the folder `Forward` inside the "Folder for saved results" (`Backtests/Forward` by default) and opens it in a new tab. The note is named `<name> forward test <date>`, the date being the last bar the result had, with `-2`, `-3` and so on when that name is taken. It starts from the text on screen, with the slider values written into it as "Keep this result as a note" does. A block in the strategy preview panel has no button. A strategy with a `to` line is refused, with "This strategy stops at a "to" date, so it never sees a new bar. Take the "to" line out before starting a forward test.", and so is one that cannot run.

The note holds the property `backtest_forward: true`, a heading, a `forward` block and an empty `## Log` section:

```forward
started: 2026-11-13
from: [[Trend following#Trend following]]
check: 1myl6jgligj
---
name: Trend following
universe: SPY
from: 2005-01-01
costs: 5 bps

buy  when close > sma(200)
sell when close < sma(200)

# Pinned when the forward test began, so a later change to the plugin settings cannot move it.
capital: 10000
slippage: 0 bps
commission: 0
cash rate: 0%
data: yahoo
```

- `started` is the last bar the result had: a date, or for bars shorter than a day a date and a time in UTC, such as `2026-11-13 15:30`. Only bars after it count.
- `from` is a link to the strategy the test was started from. It is only shown, and clicking it opens that note. The test runs the text below the line.
- `check` is a short code worked out from the frozen text (see below).
- A line with `---` ends the three settings. What follows is the strategy, frozen.

**Pinned defaults.** The plugin's defaults would change a strategy that leaves a setting out whenever you changed them, so the frozen text writes down each of `capital`, `costs`, `slippage`, `commission`, `cash rate` and `data` that the strategy leaves out, as lines at the end under a comment. `commission: 0` is written when there is none. A setting the strategy writes itself stays as it is, since a second line would be an error. If the strategy ends inside a `for` section, where settings are refused, `for all:` is written first. The lines go at the end so that no line of the strategy moves. Read with any defaults, the frozen text is the very same strategy as the one on screen was with the defaults it had; the tests compare what the parser makes of both.

**The check.** The `check` line holds a code made from the frozen text. Blank lines at its end and the kind of line ending do not count; any other change does. When it no longer matches, the block says "The rules were changed after the forward test began, so this is no longer a forward test." and shows nothing else, no figures and no log button. It is there to catch a slip. It protects nothing: whoever edits the text can write a new code. To go on, put the rules back as they were, or start a new test.

**The figures.** The block runs the frozen text as any strategy block runs, with the same prices, the same kept results and a "Refresh prices" button. It is not part of "Today's orders", the count in the status bar or the note properties. It shows four figures and what they are set against:

- **Since the start.** The strategy's growth from the close of the last bar at or before `started` to the last bar, with the benchmark's under it.
- **Worst fall.** The largest fall from a high since the start, measured from the close of the bar before the first new one, so a fall that began earlier is not counted. The benchmark's is under it.
- **Bars.** How many bars have come after `started`.
- **Time invested.** The average share of equity invested over those bars.

Under the figures, once there are enough bars, two sentences set the gain and the fall against earlier stretches: "The gain beat 67% of the 15 earlier stretches of 5 bars. The middle one gained +3.9%." and "The worst fall, −0.9%, was milder than in 53% of them. The middle one fell −0.9%." An earlier stretch is any run of as many bars as the test has had, that ends on or before `started`. A stretch that did exactly as well counts half. The sentences appear from 5 bars after the start, and only when there are at least 3 times as many bars before the start as after it; until then the block says how many more bars it needs, such as "Earlier periods are compared from 5 bars on: 2 more bars to go." The stretches overlap, and they are the period the rules may have been chosen on, so the comparison flatters the rules. It sets the figures in context and tests nothing.

**The log.** Under `## Log`, the note keeps a line `Checked through:` with the last bar looked at, and a table of the bars where the rules gave an order:

| Bar | Orders | Closes | Value | Logged |
| --- | --- | --- | ---: | --- |
| 2026-11-16 | Sell TLT; Buy SPY | TLT 91.20; SPY 5,123.46 | $10,420.35 | 2026-11-17 |

Each row is a bar, its orders in words (sells first, "Add" for a later entry of a position built in steps), the close each order rested on, what the strategy was worth at that close, and the day the row was logged, on your own calendar. Nothing is written when Obsidian starts or when a block is drawn. The button under the log, "Add 3 new bars to the log" (with the number of bars that gave orders since the last logged one), writes the rows, and moves `Checked through` up to the last bar. When no bar gave an order, the button reads "Mark the log checked through" and the day, so the log can say that nothing was due. With nothing to add and the day recorded, there is no button.

The button edits the note in one step. It adds only the bars after the last logged one, so pressing it again adds nothing, and it never rewrites a row, whatever you did to one. `Checked through` never moves back. It writes nothing, and says why, when the note has no `backtest_forward` property (a note the plugin did not make), when the frozen rules were changed, when there is no `## Log` heading, or when the table was changed by hand so that the bar of its last row cannot be read: its rule row is gone or a bar is not a date. A note with Windows line endings keeps them.

**What is in the log, and what is not.** The log lists the orders the rules gave, read from the run's own record of each trade:

- A buy or an add is dated at the bar its rule was read at (a ranking's decision is dated at the bar it was made). A sell by the sell rule or by a ranking is dated at the bar it was read at. With the default fill at the next open, that is the bar before the fill; with `fill: close` it is the bar of the fill itself.
- An order still waiting after the last bar is listed at that bar.
- Exits by a stop, a trailing stop or a take profit are left out, and so are rebalancing trades. The rules did not give them: the run makes them by itself, at levels you set or at the start of a period.

**Revisions.** Prices from Yahoo are adjusted for dividends and splits after the fact, so a run made today can give different orders for a bar than the one the log was written from. The block compares the orders in the log with the orders today's run gives for the same bars, from the start to the last bar checked, and lists each bar where they differ: "The log says Buy SPY on 2026-12-03; today's prices give no order there." It compares orders and never closes, which change with every dividend. A bar that gave an order today and has none in the log says "The log has no order on 2026-12-03; today's prices give Buy SPY there." The log is never changed to match: it keeps what it said.

## Saving results

Three buttons under a result write files to the "Folder for saved results" (default `Backtests`), created if needed. A fourth, "Start a forward test", writes a note to the `Forward` folder inside it (see "Forward tests"). The table "Rule values, bar by bar" has a "Save as CSV" button of its own that writes there too. A file is named `<name> trades|value|result <date>`, where `<name>` is the block's `name` (or "Backtest") with characters that Obsidian cannot use in a file name replaced by spaces, and `<date>` is the day it was saved, in UTC. If the file exists, ` (2)`, ` (3)` and so on are added. A notice shows the path.

- **Save trades as CSV** has the columns `ticker`, `bought`, `buy_price`, `sold`, `sell_price`, `return_pct`, `profit`, `bars` and `exit`. Open positions have no `sold` or `sell_price`. `exit` is `signal`, `stop loss`, `trailing stop`, `take profit` or `open`. A strategy with `entries` above 1 has four more columns at the end: `entries`, the number of entries, and `entry_dates`, `entry_prices` and `entry_shares`, each entry's value separated by semicolons; `bought` is then the first entry and `buy_price` the average.
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

- **Colours.** The parts of a block are coloured with your theme's code colours: setting and parameter names, keywords (`buy`, `add`, `when`, `and`, `of`, `for`), functions, series and calendar values, numbers and values, tickers, parameters used in rules, operators, and comments in italics. The result shows the block coloured the same way.
- **Auto-complete.** A pop-up offers what can come next, with a line of help for each item. At the start of a line it offers `buy when`, `sell when`, `add when`, `for`, and the settings (only the stops inside a `for` section). After `of` and `for` it offers the tickers named in your `universe`, `symbol` and `benchmark` lines. After a setting name it offers values, such as the choices for `rebalance`, `data`, `interval` and `fill`. Inside a rule it offers series, calendar values, your parameters, functions and words such as `crosses above`. `bars held`, `entry price`, `last entry price` and `entries made` are offered only in sell and add rules. After `column(` it offers the column names of the CSV files the block names with `csv:`, for the files the plugin has already read (a block that has run, or the CSV helper, reads one); a file it has not read yet offers none. It stays quiet while you type a number.
- **Underlines.** Problems are underlined with a wavy line, in the theme's error colour. Notes (such as the fixed-price one) are underlined in its warning colour. Hover the underline to read the message, which starts with "Problem:" or "Note:". The editor reads the block with the same parser as the result, using the plugin's defaults.
- **Help on hover.** Hold the pointer over a word in a `strategy` block to see what it means: its form, one or two sentences, and an example. This covers settings and their fixed values (`monthly`, `yahoo`, `1h`, `next open`), functions, series, calendar and position values, rule words (`crosses above`, `of`, `for all`, `and`), `%` and `bps`, the `[n]` lag, and `in ... step` on a parameter line. A name of several words such as `bars held` or `last entry price` is one word, and `add when` is too. A parameter you declared shows its value and range wherever it is used. When the spot also has a problem, the problem comes first and the help under it.
- **Fixes.** When a problem looks like a typo, the tooltip offers a button such as "Change to sma". It covers the start of a rule (`sel whn`, `ad when`), a misspelt setting, function (`column` included), series, word in a condition, setting value (`montly`, `yaho`), `for` ticker or parameter name, and habits from other languages: `&&`, `||`, `!` before a word, `=>` and `=<`. A fix is offered only when the corrected block no longer has that problem, and none is offered when two words are equally close. Clicking it is an ordinary edit. The command "Fix the problem at the cursor" does the same from the keyboard for the problem at the cursor, or else the first one on its line. In the list that replaces a result when the block cannot run, the same suggestion is a sentence ("Did you mean sma?").
- **Ticker lookup.** With the setting "Look tickers up while writing" on, which is the default, typing a ticker on a `universe`, `symbol`, `benchmark` or `cash rate` line offers real ones with their names, from Yahoo and Binance. The tickers already in the block are offered at once. A ticker from the other source is written with its prefix, such as `binance:BTCUSDT`. Typing `csv:` offers the CSV files in your vault. Only the ticker word is completed, so a weight such as `SPY 60%` is left alone. A ticker its source does not know, in the universe or after `of`, is underlined as a note ("Yahoo has no ticker called SPYY."), with a button to change it to a near one when there is one. When the same ticker is written on a `for` line or after `of`, the button changes every place and says how many ("Change to SPY (2 places)"). It is offered only if the block has no new problem afterwards. That note never stops a run, and it waits until the cursor leaves the ticker. The lookup sends tickers over the network; see "Network requests" for what and when.

### Strategy preview

A strategy block shows its result only when the cursor leaves it in live preview, and never in source mode. The command "Open strategy preview" opens a panel in the right sidebar that shows the result of the block you are writing, so you can see it without moving the cursor away.

- **Which block.** The block the cursor is in, counting its opening and closing fence lines. When the cursor is outside every block, the panel keeps the block it last showed from that note, or else shows the note's first block. In reading view there is no cursor, so the same rule applies. A block you have not closed yet is shown as soon as it reads cleanly. A strategy block inside a callout or a quote is not shown here. Opening another note makes the panel follow that note. A note with no strategy block gets a short message that says how to start.
- **The heading** names the note and the strategy: its `name`, or "Strategy 2 of 3".
- **When it updates.** After you stop typing: about half a second when the prices for every ticker are already saved (a block with `magnify` needs its smaller bars saved too), about a second and a half otherwise, so typing a ticker does not send a request for every letter. Moving the cursor into another block, or opening another note, updates it after a short pause. Typing elsewhere in the note does nothing. A run that a newer edit replaces is stopped, so only one run is going at a time. Closing the panel stops it too.
- **Problems.** While the block has problems, they are listed at the top in the same words as in the note. The last result that ran stays underneath, dimmed, with a line saying it is the last version that ran. If nothing has run yet, only the problems show. A run that fails, such as a ticker with no prices, shows "The backtest couldn't run", the reason and a "Try again" button over the dimmed last result in the same way. A run that is too large or takes too long shows its message with the "Run it anyway" button, as in the note (see "When a backtest is too large").
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
| Commission per order | Used when a strategy has no `commission` line, such as `1` or `0.005 per share, min 1`. It is charged on top of the costs. | `0` (none) |
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

The costs, slippage, commission and cash rate settings are checked the way the language would read them, and a value that cannot be read is not saved.

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
- **CSV files in your vault.** Read directly, with no network. The file needs a header row with a date column (`date`, `time`, `timestamp` or `datetime`) and `open`, `high`, `low` and `close` columns; `volume` is optional. The separator can be a comma, semicolon or tab. Dates can be `2024-01-31` (with an optional time, read as UTC, or with a zone after the time, such as `2024-01-31 14:30-05:00`), `01/31/2024` or `01-31-2024`, `31/01/2024` or `31-01-2024` (read as day first when some first number is above 12 and no second number is), `31.01.2024`, or Unix seconds or milliseconds. When dates such as `02/01/2024` or `02-01-2024` could be either, a file read as it is takes them month first, and "Use a CSV file in a strategy" says so and asks which. An `adj close` column, if present, adjusts the other prices. Every other column that holds numbers is kept for rules to read, and a file with a date column and such columns but no header that looks like a price is a file of signals (see "Signals from a CSV file"). Rows with an unreadable date, a price at or below 0, or a high or low that does not contain the open and close are skipped. Rows are sorted by date. Numbers need a decimal point. Prices are not saved: the file is read each time a block runs. A result is kept in memory (see "Reading a result"), and it runs again when the file's modified time changes. The command "Use a CSV file in a strategy" helps with a file that does not fit (see below).
- **Smaller bars for `magnify`.** A block with `magnify` also loads the smaller bars for each Yahoo or Binance ticker in its universe, from the same hosts, and never for a CSV file. Yahoo answers in one request for each ticker, for a limited window (rule 64); the saved file is about 200 KB for 1h bars and 260 KB for 5m bars. Binance gives 1,000 bars a request, about 170 KB each, so a first load of the 100,000 bars the plugin keeps for a ticker is up to 100 requests, and the saved file is about 6 MB. Later refreshes ask Binance only for newer bars, and Yahoo for its window again. Smaller bars count as bars toward the size of a run (see "When a backtest is too large").

### Using a CSV file

The command "Use a CSV file in a strategy" opens a window that finds the CSV files in your vault, shows how the plugin reads one, and puts a ticker or a small strategy into your note.

1. **Choose a file.** The box at the top narrows the list as you type. The arrow keys and Enter work too.
2. **See how it was read.** The window shows the number of rows, the first and last date, and the first and last rows. It lists anything doubtful in plain words: rows that were skipped and why, dates that could be read two ways, no volume column, rows out of date order, long gaps, dates with a time of day, and a history too short for the starter strategy.
3. **Read its columns.** A column besides the date, the prices and the volume that holds numbers is listed with the name a rule writes it by, its first and last value with their dates, and how many rows have a number. Its "Insert" button puts the text that reads it at the cursor, such as `column(score) of csv:Data/signals.csv`, and the window repeats how a row of this file must be dated: it is known at the end of the day it is dated in a file of signals or of daily prices, when its bar ends in a file of weekly or monthly prices, and at its time plus the shortest gap between rows in a file whose rows are less than a day apart. A file with only a date and columns is described as one with no prices: "This file has no prices. A strategy can read its columns but cannot trade it." It gets the "Insert" buttons for its columns and nothing that would trade it. Its columns may still be prices under names the plugin does not know, such as `o`, `h`, `l` and `c`: "Are some of these columns prices? Choose them yourself" opens the form described below.
4. **Insert it.** "Insert the ticker" puts `csv:<path>` at the cursor. "Insert a strategy using it" puts a complete block with the file as `symbol`, `costs: 5 bps` and a 100-day trend rule. When no note is open for editing, the text is shown with a "Copy" button instead.

A strategy cannot name a file whose path has a space or a comma in it, because the `universe` line is split at commas and spaces and has no way to quote a path. The window says so and inserts nothing. Rename the file or its folder, for example with a dash. A path with other unusual characters, such as a bracket or an accented letter, works on a `universe`, `symbol` or `benchmark` line but not after `of` in a rule; the window says so.

When the plugin cannot read a file as it is, the window says why: for example the columns have other names, there are only dates and closes, the numbers use a decimal comma, or the dates are written with month names. A file with a date and one column that looks like a price, such as `Price`, `Last`, `Settle`, `Value`, `NAV` or `Adj Close`, cannot be read as it is either, because that column is taken for a price. The window adds that a column holding something other than prices can be given another name, which makes the file one of signals. It guesses which column is which and lets you choose each one, and, for dates like 02/01/2024 or 02-01-2024 that could be read two ways, whether they are day first or month first. The window asks "Dates such as 02/01/2024 are", writing the date with the file's own separator. A preview shows the first rows as they would be read. "Save a cleaned copy and use it" writes a new file next to the original with `-clean` added to its name (`-clean-2` and so on when that name is taken). It never replaces a file and never changes the original. The copy has the header `date,open,high,low,close,volume`, dates as `2024-01-31`, oldest first, and a decimal point. Rows that cannot be read are left out and counted. Every other column that holds numbers is kept after `volume`, under its own header, so rules can still read it; a column that would have the same name as another, or past the 50 a file can have (see "Signals from a CSV file"), is left out, and the window says so.

The cleaned copy fills what the file lacks:

- No open, high or low: the open is the close, the high is the larger of the open and the close, and the low is the smaller. A file with only dates and closes gets all three equal to the close. Then a fill at the next open is made at that bar's close, a stop can only act at a close, and the average true range counts only moves from one close to the next.
- No volume: 0 on every bar, as for any file without a volume column.
- An adjusted-close column you choose scales the prices, as an `adj close` column does.

### Signals from a CSV file

A CSV file can carry more than prices. Every column besides the date, the prices and the volume that holds numbers is a column a rule can read: a model's score, a sentiment figure, an economic series, anything worked out outside the plugin. `column(score) of signals` is the `score` column of the file `signals.csv`, read the way `close of signals` is. `column(score)` alone is the column of the ticker the rule belongs to, which then has to be a CSV file. A column is a number like any other, so it works inside functions, with `[n]`, in comparisons and crosses, in buy, sell and add rules, and in `hold`.

The file is `Data/signals.csv` in the vault:

```csv
date,score,news sentiment
2024-01-02,0.41,-0.2
2024-01-03,0.77,0.1
2024-01-04,0.82,
```

```strategy
name: SPY on a model score
universe: SPY
from: 2018-01-01
costs: 5 bps

buy  when column(score) of csv:Data/signals.csv > 0.7
sell when column(score) of signals < 0.3
  or sma(column("news sentiment") of signals, 5) < 0
```

More forms: `column(score) of signals crosses above 0.5`, and `hold: top 3 by column(score)`, which ranks tickers that are CSV files by their own `score` columns. `sma(column(score), 10) of signals` averages the file's own rows and then reads the result like any other value of that file, while `sma(column(score) of signals, 10)` averages what the rule's ticker read on its own bars. They use different calendars, as `sma(10) of SPY` and `sma(close of SPY, 10)` do.

- **Naming the file.** The first time a file is written in a block it is named with `csv:` and its path, in the universe or after `of`: `column(score) of csv:Data/signals.csv`. From then on its file name does: `of signals`. A path cannot hold spaces or commas.
- **The name of a column** is its header in lower case, with accents dropped and every run of other characters, such as spaces and punctuation, turned into one underscore, with none at either end. `Score` is `score`, `News Sentiment` and `news-sentiment` are `news_sentiment`, and `10Y yield` is `10y_yield`. A header may also be written as it is in quotes, `column("News Sentiment")`, and is read the same way, so capitals, spaces and hyphens do not matter. A name may start with a digit. The helper window shows each name as a rule must write it.
- **Clashes.** Two headers that become the same name, such as `News Sentiment` and `news-sentiment`, cannot be told apart. Neither can be read, and a rule that asks for it stops with a message that names both headers. A header with no letter or digit cannot be read either.
- **Empty cells.** A cell that is empty or holds anything but a number is unknown for that row, never zero, so a rule that reads it does not fire. Numbers need a decimal point, with no thousands separator and no percent sign: `5%` is not a number. A column with no number in it is not a column.
- **At most 50 columns** with numbers can be read from one file. A rule that asks for one past the first 50 stops with a message that says so.
- **Only a CSV file has columns.** `column(score) of SPY`, or `column(score)` in a rule of a Yahoo or Binance ticker, is an error as soon as the block is read, naming the ticker. A column that the file does not have is found when the file is read: the run stops and says which file, which column was asked for and which columns the file has.
- **A file of signals.** A file that has a date column and columns with numbers, and no header that the "Use a CSV file in a strategy" window takes for a price (`open`, `high`, `low`, `close`, and names such as `price`, `last`, `settle`, `value`, `nav`, `adj close` or `close price`), has no prices. A rule can read its columns with `of`, but it cannot be traded: in `universe`, as the `benchmark`, as a `cash rate`, or with `close of signals`, the run stops and says it has no prices, only columns. (A file with only some of the price columns, such as a date and a close, or a date and a `price` column, is still not read as it is: see "Using a CSV file". To read such a column as a signal, give it another name.) Without any price header, `volume` is a column like the rest.
- **Dated rows.** Rows are sorted by date. When a date comes twice, the first row of the file keeps it, with its own values in every column. An `adj close` column scales the prices and nothing else.

**What date a row must carry.** A row is known at the end of the day it is dated (rule 6 under "How the simulation works"). A row dated Tuesday is known at Tuesday's close, so a rule read at that close can use it, and the order it gives fills at Wednesday's open. So date each row with the day whose close its value was computed from. A value worked out from Tuesday's close belongs on the row dated Tuesday. If you file it under Wednesday, the rules see it a day late. If a value worked out from Wednesday's data carries the date Tuesday, the rules see the future, and the backtest looks better than anything you could have done. The plugin cannot tell which of these a file does. Dating the rows wrongly is the classic way to cheat by accident, so the result carries a note whenever a rule reads a column, and the helper window repeats the rule.

- A file of signals is read as dated values, however far apart its rows are: in a weekly or monthly file, or one with a row only on the days something happened, each row is known at the end of the day it is dated, and a file with a single row is read from the end of that day on. In a file whose rows are less than a day apart, such as one an hour, a row is known at its time plus the shortest gap between rows, so date each row with the start of the span its value was worked out over.
- A file with prices is a file of bars, and its columns belong to their bar: they are known when it ends, as its close is. A weekly file's row dated Monday, columns and all, is read from the next Monday, so a value written on a weekly or monthly bar must come from that bar's close or before. The step is the shortest gap between its rows, counted in calendar months from a step of 20 days.
- With `fill: close`, a rule reads a ticker on other hours one bar earlier (rule 6). A file counts as being on other hours when it comes from another source than the ticker the rule trades (a Yahoo ticker and a CSV file are two sources), or has rows on other days of the week, or has rows of another length. Then a rule at Tuesday's close reads the row dated Monday: the order fills at Tuesday's close, before Tuesday's row is known at the end of that day. Two CSV files with rows on the same days are read day for day, and the result notes that it takes the row as known at the moment of the fill. The file's note says which rule reads which row.
- A CSV file is read each time a block runs and is never saved in the plugin's cache, so a changed file is read afresh, and a result runs again when the file's modified time changes.

### What is saved on disk

Prices from Yahoo and Binance are saved in `<plugin folder>/cache`, one JSON file for each source, ticker and interval. The plugin folder is `<vault>/.obsidian/plugins/backtest-blocks/`. The smaller bars of `magnify` are saved the same way, under their own bar size. Binance's are kept in a file of their own, apart from a block's own bars of that size, and cut to the latest 100,000 each time they are refreshed. The files are treated as fresh for the "Keep saved prices for" time (6 hours by default). After that the plugin fetches again. If the fetch fails and a saved copy exists, the copy is used and the result says: "Couldn't refresh X (reason); using prices saved on DATE." If you sync the `.obsidian` folder, the saved prices go with it. "Clear saved prices" removes the folder.

The plugin's settings are in `data.json` in the plugin folder. Results are kept in memory only. A forward test is a note in your vault, not a file in the plugin folder (see "Forward tests").

### Network requests

The plugin contacts these hosts, and no others:

- `query1.finance.yahoo.com` and `query2.finance.yahoo.com`, when a block uses a Yahoo ticker. The request holds the ticker, the bar size and a start and end time.
- `data-api.binance.vision`, when a block uses a Binance ticker. The request holds the market symbol, the bar size and a start time.
- A block with `magnify` makes the same requests for its smaller bars, to the same two hosts.
- A `forward` block runs its frozen rules like a `strategy` block, so it makes the same requests as a block with those tickers, when it is drawn and when you press "Refresh prices".
- The "Regimes and crises" section makes the same requests as a block with those tickers, to the same hosts, for the daily bars of SPY, `^VIX` and `^TNX` from Yahoo, or of `BTCUSDT` from Binance for a strategy that trades only there, and only when you press its button "Load SPY, ^VIX, ^TNX from Yahoo" (or "Load BTCUSDT from Binance"). It asks for nothing before you open the section, and nothing when those prices are already saved and fresh.
- `api.anthropic.com`, only when you draft a strategy with the Anthropic provider and no server address.
- The server address you enter, only when you draft a strategy. That can be a server on your own machine.

Two features make requests on their own, to the Yahoo and Binance hosts above and no others:

- The check for orders when Obsidian starts runs every strategy in the vault a few seconds after start-up. It fetches the prices of every ticker they use, and the smaller bars of a block with `magnify`, that are not saved or are older than the "Keep saved prices for" time. The setting "Check for orders when Obsidian starts" turns it off. The orders window and a `backtests` block do the same when you open them.
- The ticker lookup, while "Look tickers up while writing" is on, which is the default, sends two kinds of request. Neither carries a note's name or text.
  - A search on `query2.finance.yahoo.com`, then `query1`, at the path `/v1/finance/search`. The query is only a ticker: the word you typed where a ticker goes (250 ms after the last key, and only when it is not already one of the block's tickers), or a Yahoo ticker that a strategy block on screen names in its `universe`, `symbol`, `benchmark` or `cash rate` line or after `of` (0.7 seconds after typing stops, at most 6 each time, and not the one the cursor is in). At most 24 characters from `A-Z a-z 0-9 ^ . _ = -` are sent, and nothing else. Starting what you type with `binance:` or `csv:` keeps it from being sent. A CSV file, even when a rule names it by its bare file name, is never looked up.
  - The list of Binance prices, `data-api.binance.vision/api/v3/ticker/price`. It carries no parameters and no text from your notes. It is fetched the first time a Binance ticker is checked or a plain word is completed, and again after 6 hours.
  - Answers are kept in memory only. At most 2 lookups run at once. A failed lookup is silent and is not repeated for 30 seconds, and 3 failures in a row pause that host for 60 seconds.

Nothing else leaves your vault. There is no telemetry, no analytics, no update check and no remote code. No note's text is sent anywhere. The only words taken from your notes are ticker symbols, and only for the lookup above; what is described under "Drafting from plain English" goes to a model. The plugin sets no `User-Agent` of its own: the request carries whatever Obsidian's `requestUrl` sends.

## How far to trust it

**What has been checked**

- Unit tests cover the language, the indicators (the newer ones each against a second implementation written from its definition), the engine's rules (fills, costs, commission, slippage, stops, gaps, rebalancing, ranking, sizing, positions built in entries, looking inside bars with `magnify`, warm-up, interest, reading other tickers and CSV columns by when their bars or rows end, the test split), the lookback, the statistics, the comparison, the Yahoo, Binance and CSV readers with saved responses, the saved-price logic with a fake network, orders and the status bar count, the `backtests` block, the explanation of each trade, the bar-by-bar table (against every trade of varied runs), rewriting parameter values in a note, the background jobs with a fake worker, the size and time limits, the starter strategies and the CSV helper, hover help, fixes and the ticker lookup with a fake network, exports, settings and drafting with a fake model.
- A cross-check against a second backtester. `xcheck/` generates nine synthetic tickers over 3,000 days and runs 36 strategy pairs and 55 indicator expressions through this engine and through Rearview, a separate backtester that is not part of this repository. It compares the indicator values on every bar, every trade's days, prices, reason and bars held, the equity curve and exposure day by day, and the totals and pending orders. Six of the 36 cases fill at the close, against Rearview's `fill same_close`, three charge a `commission` (a fixed one, one per share with a minimum, and one on rebalancing trades), and four build positions in `entries` (with a stop and target, a trailing stop, and filled at the close), where each entry's day and price is compared. The check found one real bug (a bar that opened above the take-profit and then fell through the stop was booked as a stop loss), which is fixed. The two engines differ by design in some rules, and the check explains a difference only when it matches one of them: sizing (money here, shares there), the re-arm rule, a halted ticker, the trailing stop on the entry bar (and, with `fill: close`, where it starts), slipped targets, the timing of a rebalance, how bars held are counted, a sell rule while flat, the first ATR (which also moves `keltner_upper`, `keltner_lower` and `supertrend` by a bar), how interest counts days, the Sharpe ratio, and adds and rebalancing trades too small for their commission (rule 49), which Rearview makes. The table is in `xcheck/README.md`. Of the 22 functions added after the first twelve, 20 are compared with Rearview's on every bar of every ticker, to 1e-9: `obv` through a sum of signed volume and `vwap` through Rearview's `vwma` of the typical price, and `correl` only on tickers that have every day. The check is run by hand and is not part of `npm test`. It passes with the code of this release.
- The "Regimes and crises" section has unit tests on hand-built prices, with the figures worked out by hand: that a state is read only from daily bars that had ended, so the step into the bar where a state turns is not put in the state it created, on daily, weekly and hourly runs; that a tenfold change in the scale of `^TNX` makes its state unknown until it is 126 bars behind; the share, compounded return, the benchmark's return over the same steps, exposure and worst drawdown of each state, including a fall in one stretch not being carried into another; when a return is per year; which falls a run covers, at the day and at the bar edges, for daily, weekly and hourly runs; the day equity got back to its earlier high; the Binance-only and CSV-only cases; and that loading the market's prices leaves a run's own prices and result as they were.
- Forward tests have unit tests with figures worked out by hand: that the frozen text reads back as the very same strategy (compared with what the parser makes of each) under any defaults, whether the strategy writes none, some or all of the pinned settings, ends inside a `for` section, or has a commission; the refusal of a `to` line; that the check follows the text and ignores trailing blank lines and line endings; every problem a block can have, with its line; the gain and the fall of a forward test against earlier stretches of the same length on a series worked out by hand, ties, and the wait for 5 bars and for 3 times as many before; the fast window method against working every window out on its own, on random and flat series; which bar each order of a run is dated at, against the bar each trade really filled at, with fills at the next open and at the close, entries, rankings, stops and rebalancing; appending to the log (once, never rewriting a row, only after the last logged bar, a table changed by hand refused, Windows and Unix line endings, with and without a final line break); and revisions. The `forward` block in this file is parsed and its check verified. The write goes through a stand-in for Obsidian's `vault.process`.
- An independent review of the engine and the statistics, which confirmed each finding with a script. It found defects that are now fixed, each with a test: on mixed calendars (stocks with crypto) a ticker could miss its rebalance and a ranking buy could leave its slot in cash; a ticker with longer bars, a daily benchmark or a daily yield on shorter bars could be read before its bar had ended; entries were sized or left without their ATR stop while those inputs warmed up; and results could depend on which prices happened to be saved. It also corrected statistics (a benchmark whose prices start later, Sharpe and Sortino made of rounding noise, the `test from` split, two different Sortino ratios), and runs of more than about 125,000 bars no longer fail. A review finds what it looks for; this one does not show that no other defects remain.
- A trial in a running desktop Obsidian 1.15, with live prices, of the parts that depend on Obsidian itself, made before this release. These worked: the Parameters bar and its sliders; writing values into the block from the bar and from a sweep, in reading view and in live preview, including right after typing in the note; "Explain this trade"; the sweep in the background worker; the strategy preview panel as the cursor, the text and the problems change; "Fix the problem at the cursor" and the underlines; the `backtests` block; the starter strategies window; the CSV helper's file list and its reading of a file; folded results with the Compact setting; and the count in the status bar.
- A second trial in the same desktop Obsidian 1.15, with live prices, of parts of this release. These worked: a strategy with `commission` and `entries` with an `add when` rule (the result, its costs line and the colouring of the add rule); a strategy using `supertrend_up`, `adx` and `zscore`; a `magnify: 1h` strategy on a Yahoo ticker, with its note; a strategy reading `column(score)` from a signals CSV file, with its dating note; the time limit of 10 seconds stopping a slow strategy on one-minute Binance bars, with its message and button; and the "Rule values, bar by bar" table opening, moving to a trade and showing the buy, sell and add columns.
- A third trial in desktop Obsidian 1.15, with live prices, of every command, block, window and setting, in a vault of its own, on 17 November 2026. It found eight defects, now fixed, each with a test: Yahoo bars stamped at the exchange's midnight (weekly bars, currency pairs) were dated a day early in summer; a CSV file's lookback was worked out from `interval` rather than from its own rows, so a weekly file started with indicators still warming up; ticker suggestions did not show while typing at a normal pace; hovering a chart raised an error in Obsidian; two-word values were not completed after their space; and three messages did not say which file, which setting or which range. Besides what the first two trials covered, these worked: the size refusal and "Run it anyway"; the time limit; the foreground fallback, with workers blocked; the bar-by-bar table's paging, dates, trade steps, filter and CSV save; the line and "Run again" after a default setting changes; offline runs on saved prices; the three save buttons; the sweep with its Stop and "Use these values in the block"; the luck checks and "Shuffle again"; `compare` blocks and their errors; the `backtests` block's folders, sorting and "Run again"; "Today's orders" with its note, its refusal of a note the plugin did not make, and the status bar setting; note properties; completion, hover help, underlines, one-click fixes and their undo; the ticker lookup; the preview panel with its slider; all nine starter strategies; the CSV helper on awkward files, its form for choosing columns and its cleaned copy; drafting against a stand-in server in both formats; every field of the settings tab; clearing saved prices; turning the plugin off and on, and a reload; the result view at phone width in Obsidian's phone emulation; and every strategy block in this README.
- A fourth trial in desktop Obsidian 1.15, with live prices, on 17 November 2026, of fixes to how the plugin keeps track of runs. Each defect was first seen in 0.4.1 in Obsidian, then gone with the fix: after "Run again" under a `backtests` block, or "Refresh prices" in the orders window, pressed while another round was running, 9 and 11 strategies stayed on prices three days old; a result worked out late in its prices' freshness kept today's orders on them; "Run checks again" could start while "Shuffle again" ran, and Stop then left checks running; the preview panel stopped following the block after "Try again" and an undo; a block that went away while its kept result came back was still drawn; one slow start of a background worker sent every later run to the foreground; and the count in the status bar waited the full "Keep saved prices for" time after "Couldn't check orders" when every strategy failed. Also tried again with the fixes: a result made offline, which is kept without trying the download at every drawing; a block and its Refresh prices; a slider and writing its value; the sweep, run to the end and stopped; the luck checks; today's orders saved as a note; and a CSV block after its file changed.

**What has not been checked against anything**

The second backtester has nothing to compare these with, so they rest on the unit tests (and the review) only:

- Forward tests: the comparison with earlier stretches is arithmetic with no second implementation, and the `forward` block, its buttons and the note they write have not been tried in a running Obsidian. A forward test shows how rules did on bars they were not chosen on; a few bars, or a few weeks, say little about them. The log is dated from the run's own record of its orders, and a revision to adjusted prices can still change what a past bar would have given.
- `magnify`: Rearview reads each bar whole.
- A column of a CSV file as a value in a rule.
- A commission's `max`, and adds or rebalancing trades left undone for their commission.
- Entries combined with a rebalance, a ranking, risk per trade, inverse-volatility weighting, ATR stops, slippage or a commission.
- Inverse-volatility weighting, a cash rate from a ticker, ATR take-profits, `entry price` in sell rules, calendar values (`month`, `month_start` and the others), yearly rebalancing, ranking with `rebalance: never`, stops in ranking or rebalancing strategies, slippage on rebalances with weights under 100%, `of` on a day the other ticker has no bar, the benchmark, `test from`, and weekly or intraday bars. The cross-check of `fill: close` uses daily bars only.
- The functions with no counterpart: `supertrend_up` (the line it follows is compared), `bars_since`, and `correl` on tickers with missing days or other calendars. The unit tests check each against a second implementation written from its definition, on thousands of random bars.

Also not checked:

- The Parameters bar with `entries` as a parameter has not been tried in a running Obsidian, nor the bar-by-bar table's question before a CSV file of over 20 MB. They have been checked by unit tests and, for what is drawn, in headless Chrome, with stand-ins for Obsidian's own objects.
- `magnify` has been checked on four saved real Yahoo responses and on a comparison of SPY's hourly and 5-minute bars with its daily bars (492 sessions), and three live pages of Binance's bars were downloaded. In the plugin it has been run on live prices only with SPY's 1-hour bars, and the smaller bars of exchanges with a lunch break, such as Tokyo or Hong Kong, and of futures or currencies have not been tried. A day whose smaller bars do not cover its session or do not match the bar is read whole, and the notes say so (rule 63).
- The "Regimes and crises" section's own prices have not been downloaded in a running Obsidian. Its drawing has been looked at only in a headless browser, at desktop width, with stand-ins for Obsidian's own objects and made-up prices, and not in Obsidian or at phone width. The dates of the falls are entered by hand, with the closing high and low of the S&P 500 and of Bitcoin, and the plugin does not check them against prices. Yahoo has quoted `^TNX` in different units at different times, and the section takes a jump of more than threefold between two closes for such a change; a real move that large would be taken for one in the same way. A state is a description of what already happened, read from data known at each close. A few years in a state is a few separate stretches, since a 200-day average turns only a few times in a decade, so a figure for a state says little more than that, and a strategy chosen because it did well in one state has been fitted to this history again.
- A real phone. The plugin has never been run on one, though the manifest does not rule it out. The result view, with the Parameters bar, has been looked at in Obsidian's phone emulation on a computer. The other newer parts (the preview panel, the windows, the `backtests` table, the bar-by-bar table) have been drawn at phone width only in a browser with stand-ins for Obsidian's own objects.
- Drafting has never been run against a live model at the time of writing. The tests use a fake server, and the third trial a stand-in server.
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
npm run check      # everything a push or release must pass (ci/check.sh)
node xcheck/run.ts # optional cross-check; needs the second backtester's command-line tool
```

Obsidian loads one script for a plugin, so the background workers are built into `main.js`: `npm run build` bundles `src/worker.ts` first (`esbuild.config.mjs`) and embeds its text in the main bundle, which starts them from that text.

The cross-check runs 36 cases and 55 indicator expressions (`xcheck/README.md` lists them and the differences it explains). It needs Rearview's command-line tool, `rvw`: the path in the `RVW` environment variable, or else `rvw` on `PATH`. Without it the script says so and exits 0.

The checks run on your own machine; the repository has no hosted workflow. `sh ci/check.sh` (or `npm run check`) runs the tests, the type check and build, checks the built files and the version files against each other, and runs the cross-check when `rvw` is found; it stops at the first failure. A file `ci/local.env`, which is not in git, can set `RVW` for that machine. `git config core.hooksPath ci/hooks`, run once in a clone, makes every push run the check first.

`sh ci/release.sh` releases the `version` in `manifest.json`. It refuses unless you are on `main` with nothing uncommitted and `main` matches the remote, the tag and the release do not exist yet, and the whole check passes with the cross-check. Then it tags the commit, pushes the tag and publishes a GitHub release with `main.js`, `manifest.json` and `styles.css`, using `ci/notes/<version>.md` as the notes when that file exists. `--dry-run` runs every check and changes nothing; `--draft` leaves the release as a draft. It needs the GitHub command-line tool, `gh`. `versions.json` maps each plugin version to the minimum Obsidian version.

Layout of `src/`:

- `dsl.ts`, `docs.ts`, `complete.ts`, `highlight.ts`, `diagnostics.ts`, `fixes.ts`, `editor.ts`, `symbols.ts`: the language and the editor (parser, help text for hover and auto-complete, colours, underlines, "did you mean" fixes, ticker lookup).
- `evaluate.ts`, `indicators.ts`: evaluating rules, and the indicator maths.
- `engine.ts`, `backtest.ts`, `stats.ts`, `explain.ts`, `debug.ts`: the simulation (commission, entries and looking inside bars included), the benchmark, the statistics, the reasons behind each trade, and the value of each part of the rules at each bar.
- `price-memo.ts`: work kept for the next run on the same prices, so a sweep, a walk-forward or a slider works out each indicator and the benchmark once.
- `data.ts`, `runner.ts`, `result-cache.ts`: prices and their cache (the smaller bars of `magnify` and the columns of CSV files included), running a block, and keeping results in memory.
- `price-store.ts`: the saved price files, in the vault and in memory, the column names of the CSV files read, and whether a block's prices are all saved and fresh.
- `results.ts`: running a block's text and keeping the result, so a block drawn again, the other blocks, the orders and the note properties reuse a recent run.
- `strategy-block.ts`: a strategy block's drawings: running it or reusing a kept result, drawing the result and its sections, and what a drawing leaves behind until the block is drawn again or goes away.
- `store.ts`: small records kept in the plugin's folder, one file for each, written a moment after they change and merged with any copy a sync brought in meanwhile.
- `vault-writes.ts`: writing into the vault: a note's `bt_` properties once its blocks have rendered, saved results under a dated name, and the CSV helper's cleaned copies under a free name.
- `compare.ts`, `dashboard.ts`, `orders.ts`, `orders-badge.ts`, `export.ts`, `rewrite.ts`: the compare block, the `backtests` block (its parser, sorting and running), orders, the status bar count of orders, the files, notes and properties a result can become, and writing parameter values into a block's text.
- `sweep.ts`, `luck.ts`, `rng.ts`: parameter sweeps and the luck checks (reshuffled history, random entries, walk-forward), and the seeded random numbers they use.
- `regimes.ts`, `render-regimes.ts`: the "Regimes and crises" section: the market states and falls, putting each step of a run in the state known before it, the figures for each state and fall, and drawing them.
- `jobs.ts`, `worker.ts`, `worker-client.ts`, `limits.ts`: backtests, sweeps and luck checks as jobs, the two background workers that run them (one for single backtests, one for sweeps and luck checks), the plugin's side of them, which starts the workers, sends them prices and stops them, and the limits on how large one backtest may be and how long it may run.
- `overfit.ts`: the maths of the overfitting checks: the normal distribution, the deflated Sharpe ratio, and the probability of backtest overfitting by combinatorially symmetric cross-validation.
- `ledger.ts`: each block's record of the variants it ran and the versions of its text, how two copies of a record merge, and the lines that changed between two versions.
- `llm.ts`, `llm-modal.ts`: drafting.
- `forward.ts`: forward tests: the note made from a strategy with the plugin defaults pinned in its text, reading its `forward` block and checking that the rules were not edited, the figures since the start against earlier stretches of the same length, the bars where a run's rules gave an order, and the log of orders with its appending and its comparison with today's prices.
- `render-forward.ts`: drawing the `forward` block: its figures, the sentences under them, the revisions, the log line and the button that adds to the log.
- `gallery.ts`, `gallery-modal.ts`, `csv-import.ts`, `csv-modal.ts`: the starter strategies and the CSV helper, each with its logic and its window.
- `live-core.ts`, `live-view.ts`: the strategy preview panel: choosing the block to show, and the panel.
- `render.ts`, `render-params.ts`, `render-trades.ts`, `render-stats.ts`, `render-price.ts`, `price-chart.ts`, `render-debug.ts`, `render-sweep.ts`, `render-luck.ts`, `render-compare.ts`, `render-dashboard.ts`, `render-actions.ts`, `orders-view.ts`, `dom.ts`: drawing results, charts, tables and windows. `render-params.ts` draws the Parameters bar, `render-debug.ts` the bar-by-bar table, `render-sweep.ts` and `render-luck.ts` the sweep and luck sections, `render-compare.ts` the compare block and `render-dashboard.ts` the `backtests` block.
- `main.ts`, `blocks.ts`, `settings.ts`, `settings-core.ts`, `types.ts`: the plugin itself, settings and shared types.
- `format.ts`: how numbers, dates and times are written, and the ticks of chart axes, for the logic and the drawing alike.

`styles/*.css` are joined into `styles.css` when you build. `tests/` holds the unit tests, including `readme.test.ts`, which checks every `strategy`, `compare`, `backtests` and `forward` block in this file.

## Licence

MIT. See `LICENSE`.
