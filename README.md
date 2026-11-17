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

Under the block you get the strategy's return per year, worst drawdown, Sharpe ratio and other figures next to buy and hold, a chart of both, the positions held now, and a list of every trade.

This README is the full guide to the plugin. Every `strategy` block and `compare` block in it is checked by the plugin's own parser when the tests run.

## What it is not

- It is long or flat only. There is no shorting, no leverage and no options. Weights that add up to more than 100% are rejected, and a sell rule only closes a position you hold.
- It never places orders. "Today's orders" lists what your rules would do at the next open. You place any trade yourself, somewhere else.
- It is a backtest on adjusted historical prices. It shows what the rules would have done on past data. It does not predict anything.
- It is not financial advice.

It also does not model taxes, market impact or partial fills. A fill is at the next open (or at a stop or target level), made worse by the slippage you set, whatever the size of the trade.

## Install

Manual install:

1. Get `main.js`, `manifest.json` and `styles.css`: from a release if one is published, or build them (below).
2. Create the folder `<vault>/.obsidian/plugins/backtest-blocks/` and copy the three files into it.
3. In Obsidian, open Settings, then Community plugins. Turn off restricted mode if it is on, reload the plugin list, and enable Backtest Blocks.

The minimum Obsidian version is 1.11.4 (`minAppVersion` in `manifest.json`). The manifest does not mark the plugin desktop-only, but it has never been run on a phone (see "How far to trust it").

To build from source, run `npm install` and then `npm run build`. The three files land in `dist/`. The tests run `.ts` files directly with Node, so use a Node version that does that without flags; the project is developed and released with Node 26.

## Writing a strategy

### The shape of a block

A strategy is a code block whose language is `strategy`. The fence can be backticks or tildes. In reading view, and in live preview while the cursor is outside it, the block is replaced by its result. In source mode, or with the cursor inside it, you see the text.

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
- `size`, `capital`, `costs`, `slippage`, `from`, `to`, `test from`, `rebalance`, `data` and `interval` take written values only. Parameters can stand in for numbers in rules, stops, `hold`, `weighting` and `risk per trade` (see "Parameters and ranges").

### Tickers and sources

The `universe` line lists tickers, separated by commas, each with an optional weight: `universe: SPY 60%, TLT 40%`.

- A plain ticker comes from the source named by `data`, or by the plugin setting when the block has no `data` line.
- Put `yahoo:`, `binance:` or `csv:` in front of a ticker to choose its source: `universe: SPY, binance:BTCUSDT`.
- Write Yahoo tickers the way Yahoo spells them: `SPY`, `BRK-B`, `BTC-USD`, `^GSPC`. Binance tickers are market symbols such as `BTCUSDT`. Letters in Yahoo and Binance tickers are turned into capitals. A ticker may hold letters, digits and `^ . _ = -`.
- A CSV ticker is a path from the vault's root, such as `csv:Data/gold.csv`. The path cannot contain spaces or commas. Rules and the result call it by the file name without `.csv`, here `gold`.
- Sources can be mixed, but one `interval` applies to every ticker, so it has to be valid for each source.
- A ticker listed twice is an error.

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

A buy rule opens a position in a ticker you do not hold when the condition is true at a close. A sell rule closes the position when it is true at a close. Both fill at that ticker's next open. You can write one buy rule and one sell rule for each scope (see the next part). Without a sell rule a position is held until a stop closes it or the run ends.

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

A rule has to be a condition: `buy when sma(200)` is an error. Both sides of a comparison have to be numbers, and `and`, `or` and `not` need conditions on their sides.

Another ticker: `sma(200) of SPY` and `close of ^VIX` read a value from a ticker that does not have to be in the universe. `of` applies to the value just before it, so write `(close - open) of SPY` to apply it to a whole expression. A ticker that is not in the universe is loaded from the default source (the `data` line or the plugin setting), or from the source you name, as in `close of binance:BTCUSDT`. For each bar of the rule's own ticker, you get that other ticker's latest bar at or before that time.

Earlier bars: `close[5]` is the close five bars back. It works on any value: `highest(20)[1]` is the highest high of the 20 bars before this one.

### Series

These are the bar's own values for the ticker the rule belongs to: `open`, `high`, `low`, `close` and `volume`. With Yahoo data the prices are adjusted (see "How far to trust it").

### Functions

Most functions read a series and take one or more periods. Without a series they read the one in the table. To read another, write it first: `sma(volume, 20)`, or `sma(rsi(2), 5)`. Periods must be plain numbers or parameters, whole numbers from 1 to 10000. A Bollinger `width` can be any number above 0. Empty brackets use the defaults: `macd()`, `rsi()`, `atr()`.

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

A range changes nothing by itself: the block runs with the value written. See "Try other parameter values" under "Reading a result".

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
Line 3: Unknown name "smaa". Series: open, high, low, close, volume. Functions: sma, ema, rsi, roc, stdev, highest, lowest, atr, macd, macd_signal, bb_upper, bb_lower, min, max, abs. Dates: month, day, weekday, year, month_start, month_end
Line 4: The rule ends too early
```

Besides errors, the parser gives one kind of note that does not stop the run: a comparison of a price with a fixed number on Yahoo data, such as `close > 100`. Yahoo prices are adjusted for later dividends and splits, so old prices are lower than what actually traded. Compare a price with an average, a percentage or an earlier price instead. The note appears as an underline in the editor and under the title in the result.

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

**Another ticker as a filter.** Hold QQQ while it is above its 200-day average and the VIX is below 25. Leave when the trend breaks or the VIX goes above 35. The VIX is not in the universe, so it is only read, never traded. You will see the fixed-price note on these lines. A volatility index has no dividends or splits to adjust, so it does not matter here.

```strategy
name: QQQ unless volatility spikes
universe: QQQ
from: 2005-01-01
costs: 5 bps

buy when close > sma(200) and close of ^VIX < 25
sell when close < sma(200)
  or close of ^VIX > 35
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

## How the simulation works

These are the engine's rules. Each is exact.

**Timing**

1. Rules are read at the close of each bar. A buy or sell that is true at a close fills at that ticker's next open, the next bar of that ticker.
2. An order from the last bar in the prices is not filled. It stays pending and is reported in the result and in "Today's orders".
3. The run starts on `from`, or on the first day every ticker in the universe has prices if that is later. Tickers read only with `of`, and the benchmark, do not delay the start. The result warns when the run starts more than 7 days after `from`. It ends on `to`, or on the last bar.
4. Bars before the start still feed the indicators, so `sma(200)` is known on the first day. Yahoo and CSV give the whole history. For Binance the plugin fetches 500 bars before `from`, so a longer lookback leaves the rules unknown for longer.
5. The run has one step for each time at which any ticker in the universe has a bar. A ticker with no bar that day keeps its last close for valuing the position.

**Sizing and cash**

6. Equity is cash plus every position at its latest close. Money is in cash until a rule buys. Positions can hold fractions of a share.
7. A buy of a ticker with weight w spends w times equity, valued at the open of the fill, but never more than the cash available. The rest stays in cash.
8. A position is sized once, when it is bought. It then drifts with the price until it is sold or a rebalance resizes it.
9. With `weighting: inverse volatility(n)`, the tickers being held or bought share out the sum of their configured weights in proportion to 1 divided by their volatility, the standard deviation of the last n one-bar returns up to the last close before the fill. A ticker whose volatility is unknown or 0 keeps its configured weight.
10. With `risk per trade: r at m atr(n)`, the buy is for r times equity, divided by m times the ATR, shares. The ATR is its value at the close before the fill. The value of the buy is capped at the ticker's weight, and the size is fixed at entry. Without a known ATR the weight is used. The distance used for sizing is separate from any `stop loss` line.

**Costs, slippage and interest**

11. `costs` is a percentage of the value of every fill: buys, sells, stops, targets and rebalancing trades. On a buy it is paid on top of the price; on a sell it comes out of the proceeds.
12. `slippage` makes each fill worse by that fraction: a buy fills at the price times (1 + slippage), a sell, including a stop or a target, at the price times (1 - slippage). Costs are charged on the slipped value.
13. Between two bars, cash earns the rate times the calendar days between them divided by 365, using the rate known at the earlier bar. With a ticker, the rate is that ticker's latest close at or before the earlier bar, read as a yearly percentage: a close of 4.2 is 4.2%. Only cash earns interest.

**Rebalancing**

14. With a `rebalance` other than `never`, on the first bar of each new period every ticker that is held, and has a bar on that day, goes back to its target weight at that bar's open. Sells are made before buys. A rebalance resizes held positions only; it never opens one. A ticker with no bar on that day waits for the next period. Weeks start on Monday; months, quarters and years follow the calendar in UTC.
15. Rebalancing trades are slipped and charged like any other. They change a position without closing it, so they are not listed as trades.
16. With inverse-volatility weighting, the weights are worked out again at each rebalance.

**Stops, targets and gaps**

17. Stops and targets are set when the position opens, from the fill price, slippage included. A stop loss is the fill price times (1 - x), or the fill price minus x ATR. A take profit is the fill price times (1 + x), or the fill price plus x ATR.
18. An ATR distance uses the ATR at the close before the fill and keeps it for the life of the position. If the ATR is unknown then, that level is not set.
19. The trailing level is the highest high since entry times (1 - x), or minus x ATR. It moves only at the end of a bar: a bar's high counts from the next bar on. On the entry bar it trails the open.
20. After the bar's open orders, each position is checked against the bar. If the low reaches the stop (the higher of the stop loss and the trailing level), it exits at the stop, or at the open if the bar opened below it. If the high reaches the take profit, it exits at the target, or at the open if the bar opened above it.
21. If both levels lie inside the bar, the stop is taken first. If the bar opens at or above the target, the target fills at the open, even if the bar later falls through the stop.
22. A position can be stopped out on the bar it is bought.
23. Within a bar, the order is: pending sells fill at the open; then the rebalance and pending buys, sells first; then stops and targets; then, at the close, the rules are read for the next open.
24. A sell rule and the stops both apply, whichever comes first. A buy is skipped when the sell rule is also true at the same close.

**Re-arming**

25. After an exit by stop loss, trailing stop or take profit, the buy rule has to be false, or unknown, at one close before it can buy that ticker again. A sell-rule exit does not wait. In a `hold` strategy this rule does not apply: a stopped-out ticker can be chosen again at the next decision.

**Ranking (`hold`)**

26. With `hold: top N by score`, a decision is made at each close when `rebalance` is `never`, and otherwise at the last bar of each period. The tickers that can be chosen are those whose buy rule is true (every ticker if there is no buy rule), whose sell rule is not true, and whose score is known.
27. The N highest scores are chosen. Ties go to the ticker listed first. Chosen tickers not held are bought at the next open, and held tickers not chosen are sold.
28. Between decisions, a sell rule or a stop can still exit a position. The freed slot waits for the next decision. Each ticker held gets `size` divided by N.

**Unknown values**

29. A value is unknown while an indicator is still warming up, when you look back past the start of the data, when a ticker read with `of` has no bar yet, after a division by 0, and when `crosses` needs a previous bar that is unknown. `month_start` is unknown on the first bar of the data.
30. A comparison with an unknown value is unknown. `and` is false if either side is false, and otherwise unknown if either side is unknown. `or` is true if either side is true, and otherwise unknown if either side is unknown. `not` of unknown is unknown.
31. A rule only fires when it is true. Unknown never buys or sells, and counts as "not holding" for the re-arm rule.

**Benchmark, statistics and the split**

32. The benchmark holds the same weights as the strategy (or the one ticker you name) from the first open the strategy could have bought at, with the same costs, slippage, rebalancing and cash rate, and no rules or stops. A `hold` strategy is compared with holding every ticker in equal parts of the same total size.
33. Return per year is the compound growth rate over the time the run covers, in years of 365.25 days. Worst drawdown is the lowest value of equity divided by its highest previous value, minus 1, at the closes.
34. Sharpe ratio: for each step, take the return of equity minus what cash earned over the same step. Divide the mean of those by their standard deviation (dividing by the count, not by the count minus 1), and multiply by the square root of the steps in a year, where steps a year is the number of steps divided by the years covered. It is not scaled with 252. The benchmark's Sharpe ratio is worked out the same way.
35. The volatility shown under "Time invested" is the standard deviation of the one-step returns times the same square root. "Time invested" is the average share of equity held in positions at the closes.
36. The trade count and the share won count closed trades only. A trade is won when its return after costs is above 0. A position still open at the end is not sold in the run: equity values it at the last close, and it is listed as "still held". Its return counts the exit cost as if it were sold at that close, without slippage.
37. A trade's return is its sell price times (1 - costs) over its buy price times (1 + costs), minus 1, with slippage in both prices. Its profit is cash in and out of that ticker, rebalancing trades included.
38. `test from` splits one run in two, at that date. It is not a second run: nothing is reset or re-fitted, and a position open at the date carries over. Each part is measured on its own, from its own first value. A trade belongs to the part in which it was bought.

## Reading a result

From the top:

1. **Title and summary.** The `name` (or "Backtest"), then a line of what was run: tickers and weights, sizing, rebalancing, bar size, costs, slippage, stops, and parameter values.
2. **Refresh prices.** A button that fetches the prices again and runs the block again.
3. **The strategy as written**, coloured.
4. **Notes.** Prices that could not be refreshed (see "Prices and privacy"), the parser's notes with their line number, and a warning when the run starts more than 7 days after `from`.
5. **Six figures.** Return per year, total return, worst drawdown and Sharpe ratio, each with the benchmark's value underneath. Then "Time invested", with volatility a year underneath. Then "Trades": the count of closed trades, how many were won and the average return. It says "none closed yet" when only open positions exist, and "the buy rule never fired" when there were none.
6. **The chart.** The strategy and the benchmark on a log scale, with the final value of each in the key above it. Underneath, the drawdown from the previous high. Hover or tap to see the date, both values, both drawdowns and the share invested. With `test from`, the test period is shaded.
7. **A short note.** The dates, the starting money, "A rule seen at a close fills at the next open.", costs paid, and interest earned on cash. Then "Prices through" a date, from Yahoo, Binance or your CSV files.
8. **Before and after the test date**, only with `test from`. A table of return per year (strategy and benchmark), worst drawdown, Sharpe ratio and trades, for each part.
9. **Positions.** One row for each ticker: its weight, whether you are long since a date or in cash, whether an order is waiting for the next open, the closed trades, the share won and the average trade.
10. **Trades.** A list you open, newest first: ticker, bought, price, sold, price, return after costs, profit and how it ended: "sell rule", "stop loss", "trailing stop", "take profit" or "still held". It shows the latest 500 trades. Intraday times are in UTC.
11. **More statistics.** A table for the strategy and the benchmark: Sortino ratio, return per year divided by worst drawdown, best and worst year, the share of months with a gain, the longest time below a previous high, and best and worst month. Then a chart of the return in each calendar year, and a table of the strategy's return by month. Years the data only partly covers are faded. The Sortino ratio here is the mean return divided by the downside deviation (steps with a loss), scaled the same way as Sharpe. Unlike the Sharpe ratio, it does not take off what cash earned.
12. **Prices and trades.** The price of one ticker with the periods you held it shaded, and a marker for each buy and sell. With more than one ticker there is one button for each, or a list when there are more than 12. Above it: the number of trades, the share of the time held, and what holding it throughout returned. When there are too many trades to mark at the chart's width, only the shaded bands are drawn.
13. **Try other parameter values.** Shown when a parameter is declared with a range, such as `fast = 50 in 20..100 step 10`. A button runs every combination of the ranges, up to 2,000 combinations. Then it shows a chart for one ranged parameter, or a heatmap for two. They show where the values written in the note rank among all the variants, the median variant, and whether the best variant's neighbours do similarly well. With `test from` set, the view starts on the period before the date, the best variant is chosen on that period, and its result after the date is shown. The line under the reading says which period chose the best values ("Best before 2015-01-01: fast = 40, slow = 250"). If you switch the view to the whole run or to the period after the date, that line no longer suggests values, because values picked there have seen the test period and their later result would not be a fair test. Nothing is written back to the note.
14. **Was it luck?** A button that runs three checks. *Reshuffled history* resamples the run's returns in blocks, to give a range for return per year and for worst drawdown. It shows how much the path and the drawdown depended on the order of the returns; it says nothing about whether the average return will persist, because every version is made from the run's own returns. *Random entries* makes the same number and length of trades at random times, to see how often random timing does as well. *Walk-forward* runs only when a parameter has a range: it picks the best values on a training window, applies them to the next unseen window, and repeats.
15. **Save buttons.** "Save trades as CSV", "Save value history as CSV" and "Keep this result as a note" (see "Saving results").

A result is kept in memory (the latest 40), so scrolling or switching views does not run it again. It runs again when the block's text or the plugin's defaults change, when the modified time of a CSV file it reads changes (or the file goes missing), when the kept result is older than the "Keep saved prices for" time, or when you press Refresh prices.

## Comparing and combining strategies

A code block marked `compare` puts the equity curves of strategies from other notes on one chart, and can combine them into one portfolio.

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

## Today's orders

The command "Show today's orders" opens a window. It runs every `strategy` block in every note of the vault that has the word "strategy" in it, and lists what each would do at the next open. Blocks are found as described under "Comparing and combining strategies": ones in callouts count, examples inside a longer fence do not.

- **To do at the next open.** One row for each order: Buy or Sell, the ticker, the size, the strategy (click it to open its note), the last close, and which bar it is based on, such as "Based on the close of 2026-11-13". For strategies with bars shorter than a day the row shows the time too, in UTC, such as "Based on the 5m bar starting 2026-11-13 14:05 UTC". Sells are listed first. A buy's size is its target share of the strategy and about how many dollars that is at the backtest's current value, which grows or shrinks from the block's `capital`. A sell is the whole position. Scale the percentage to your own money. The dollar figures are about the backtest, not about your account.
- **Holding.** Strategies that hold something or have no order, and what they hold.
- **Problems.** A block that could not run, prices that are out of date, and any warning from loading prices. For daily bars, prices are out of date when they end more than 4 calendar days ago. For bars shorter than a day, they are out of date when the last bar is more than 3 bars old.

The header says which bar the orders are based on. The orders are for the open after that bar. When the strategies with orders end on different bars, the header shows the oldest and says so, and each row shows its own. Yahoo's bar for the current day is left out, even after the close, so until the next day the orders can refer to yesterday's close. Check the date.

Refresh prices downloads each ticker once, however many strategies use it, then runs the strategies again, three at a time. "Save as note" writes the same list to the note named in the "Note for today's orders" setting, creating it if it does not exist and replacing its whole contents each time. The generated note starts with the property `backtest_orders: true`. An existing note is replaced only if it has that property; otherwise nothing is written and the window says "<path> already exists and was not made by Backtest Blocks. Choose another note in settings." With no note set, it says so. Nothing in the window places an order.

A block with no `name` is listed under its note's file name, or "file name 1", "file name 2" when a note has several.

## Saving results

Three buttons under a result write files to the "Folder for saved results" (default `Backtests`), created if needed. A file is named `<name> trades|value|result <date>`, where `<name>` is the block's `name` (or "Backtest") with characters that Obsidian cannot use in a file name replaced by spaces, and `<date>` is the day it was saved, in UTC. If the file exists, ` (2)`, ` (3)` and so on are added. A notice shows the path.

- **Save trades as CSV** has the columns `ticker`, `bought`, `buy_price`, `sold`, `sell_price`, `return_pct`, `profit`, `bars` and `exit`. Open positions have no `sold` or `sell_price`. `exit` is `signal`, `stop loss`, `trailing stop`, `take profit` or `open`.
- **Save value history as CSV** has the columns `date`, `strategy`, the benchmark's label (such as `SPY buy & hold`) and `drawdown_pct`, one row for each step of the run.
- **Keep this result as a note** writes a note with the tag `backtest/snapshot` and a `created` date. It holds the strategy as plain text in a `text` block, so it does not run again, then the figures, the split before and after the test date if there is one, the positions now, and the latest 30 trades.

### Note properties

The command "Save this note's results to its properties" runs the strategies in the active note and writes the main figures of each to the note's properties (front matter). The setting "Write results to note properties" does the same for the note a block is in, a moment after its blocks have rendered: a note with several blocks is written once, from the kept results, without running anything again. It is off by default, because it edits your notes.

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

The plugin owns every property that starts with `bt_`. It updates them, and when every strategy in the note ran, it removes `bt_` properties that no strategy in the note produces any more, such as the keys of a block you deleted or renamed. Do not name your own properties `bt_...`. If a block could not run, nothing is removed, so its earlier figures stay. A property is written only when its value changed, and `bt_last_run` (for each block, the day its figures last changed) moves only when something else in the note changed, so opening a note on a new day does not edit it. Properties let a Base list your strategies.

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
- **Auto-complete.** A pop-up offers what can come next, with a line of help for each item. At the start of a line it offers `buy when`, `sell when`, `for`, and the settings (only the stops inside a `for` section). After `of` and `for` it offers the tickers named in your `universe`, `symbol` and `benchmark` lines. After a setting name it offers values, such as the choices for `rebalance`, `data` and `interval`. Inside a rule it offers series, calendar values, your parameters, functions and words such as `crosses above`. `bars held` and `entry price` are offered only in sell rules. It stays quiet while you type a number.
- **Underlines.** Problems are underlined with a wavy line, in the theme's error colour. Notes (such as the fixed-price one) are underlined in its warning colour. Hover the underline to read the message, which starts with "Problem:" or "Note:". The editor reads the block with the same parser as the result, using the plugin's defaults.

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
| Clear saved prices | A button that removes every price file the plugin saved. | |
| Write results to note properties | When a note's strategies have run, save their main figures to the note's properties. Properties that start with `bt_` belong to the plugin: it updates them and removes ones no strategy in the note produces any more. This edits your notes. | off |
| Note for today's orders | Vault path of the note to write them to, such as `Trading/Orders.md`. The note is rewritten each time you save, and an existing note is replaced only if the plugin made it. Empty for none. | empty |
| Folder for saved results | Vault folder where saved results go. | `Backtests` |
| Provider | The service that turns a description into a strategy: Anthropic, or an OpenAI-compatible server. | Anthropic |
| Server address | Anthropic: empty for Anthropic's own address, or a proxy. OpenAI-compatible: required, such as `http://localhost:8000/v1`. | empty |
| Model | Anthropic: empty for `claude-opus-5-5`. OpenAI-compatible: required, the name of the model on your server. | empty |
| API key | A secret in Obsidian's secret storage. Only its name is saved in the settings. Required for Anthropic; empty is fine for a server that needs no key. | none |

The costs, slippage and cash rate settings are checked the way the language would read them, and a value that cannot be read is not saved.

## Commands

The command palette shows each name with "Backtest Blocks:" in front.

| Command | What it does |
| --- | --- |
| Insert strategy block | Inserts a starting block at the cursor (the example at the top of this README). |
| Draft a strategy from a description | Opens the drafting window. |
| Show today's orders | Opens the list of orders for the next open. |
| Save this note's results to its properties | Runs the note's strategies and writes their results to its properties. |
| Clear saved prices | Removes the saved price files. |

## Prices and privacy

### Where prices come from

- **Yahoo.** The unofficial chart endpoint behind Yahoo Finance, on `query1.finance.yahoo.com` and `query2.finance.yahoo.com`. Yahoo does not publish it as an API, can change or rate-limit it without notice, and its terms allow personal use only. The plugin asks for the whole history each time, as daily or weekly bars. If a request fails or Yahoo sends something other than price data, it tries again, on `query1`, then `query2`, then `query1`, waiting 0.5 and then 1.5 seconds. Open, high, low and close are adjusted for splits and dividends. The bar for the current day is left out. A ticker Yahoo does not know gives "Yahoo has no prices for X. Check the ticker."
- **Binance.** The public market-data endpoint `data-api.binance.vision` (klines, 1000 bars a request). It needs no key. The bar still open is left out. A refresh asks only for bars newer than the saved ones. A ticker it does not know gives "Binance has no market called X".
- **CSV files in your vault.** Read directly, with no network. The file needs a header row with a date column (`date`, `time`, `timestamp` or `datetime`) and `open`, `high`, `low` and `close` columns; `volume` is optional. The separator can be a comma, semicolon or tab. Dates can be `2024-01-31` (with an optional time, read as UTC), `01/31/2024`, `31/01/2024` (read as day first when some first number is above 12 and no second number is), `31.01.2024`, or Unix seconds or milliseconds. An `adj close` column, if present, adjusts the other prices. Rows with an unreadable date, a price at or below 0, or a high or low that does not contain the open and close are skipped. Rows are sorted by date. Prices are not saved: the file is read each time a block runs. A result is kept in memory (see "Reading a result"), and it runs again when the file's modified time changes.

### What is saved on disk

Prices from Yahoo and Binance are saved in `<plugin folder>/cache`, one JSON file for each source, ticker and interval. The plugin folder is `<vault>/.obsidian/plugins/backtest-blocks/`. The files are treated as fresh for the "Keep saved prices for" time (6 hours by default). After that the plugin fetches again. If the fetch fails and a saved copy exists, the copy is used and the result says: "Couldn't refresh X (reason); using prices saved on DATE." If you sync the `.obsidian` folder, the saved prices go with it. "Clear saved prices" removes the folder.

The plugin's settings are in `data.json` in the plugin folder. Results are kept in memory only.

### Network requests

The plugin contacts these hosts, and no others:

- `query1.finance.yahoo.com` and `query2.finance.yahoo.com`, when a block uses a Yahoo ticker. The request holds the ticker and the bar size.
- `data-api.binance.vision`, when a block uses a Binance ticker. The request holds the market symbol, the bar size and a start time.
- `api.anthropic.com`, only when you draft a strategy with the Anthropic provider and no server address.
- The server address you enter, only when you draft a strategy. That can be a server on your own machine.

Nothing else leaves your vault. There is no telemetry, no analytics, no update check and no remote code. Your notes are never sent anywhere; only what is described under "Drafting from plain English" goes to a model.

## How far to trust it

**What has been checked**

- Unit tests cover the language, the indicators, the engine's rules (fills, costs, slippage, stops, gaps, rebalancing, ranking, sizing, interest, the test split), the statistics, the comparison, the Yahoo, Binance and CSV readers with saved responses, the saved-price logic with a fake network, orders, exports, settings and drafting with a fake model.
- A cross-check against a second backtester. `xcheck/` generates nine synthetic tickers over 3,000 days and runs 24 strategy pairs and 24 indicator expressions through this engine and through Rearview, a separate backtester that is not part of this repository. It compares the indicator values on every bar, every trade's days, prices, reason and bars held, the equity curve and exposure day by day, and the totals and pending orders. It found one real bug (a bar that opened above the take-profit and then fell through the stop was booked as a stop loss), which is fixed. The two engines differ by design in some rules, and the check explains a difference only when it matches one of them: sizing (money here, shares there), the re-arm rule, a halted ticker, the trailing stop on the entry bar, slipped targets, the timing of a rebalance, how bars held are counted, a sell rule while flat, the first ATR, how interest counts days, and the Sharpe ratio. The table is in `xcheck/README.md`. The check is run by hand and is not part of `npm test`.

**What has not been checked against anything**

The second backtester has nothing to compare these with, so they rest on the unit tests only: inverse-volatility weighting, a cash rate from a ticker, ATR take-profits, `entry price` in sell rules, calendar values (`month`, `month_start` and the others), yearly rebalancing, ranking with `rebalance: never`, stops in ranking or rebalancing strategies, slippage on rebalances with weights under 100%, `of` on a day the other ticker has no bar, the benchmark, `test from`, and weekly or intraday bars.

Also not checked:

- The plugin has never been run on a phone, though the manifest does not rule it out.
- Drafting has never been run against a live model at the time of writing. The tests use a fake server.
- The drawing of the charts and the layout uses the DOM and has no automated tests. Only helpers such as tick spacing and marker placement are tested.
- The cross-check used made-up prices. It says nothing about the data feeds.

**Limits of any backtest**

- Yahoo prices are adjusted for later dividends and splits, so old prices are lower than what actually traded. A rule that compares a price with a fixed number, such as `close > 100`, then means something different in 2005 than today. The plugin warns about it on that line. Compare with averages, percentages or earlier prices.
- Yahoo only lists tickers that exist now. A test over a basket of today's tickers is a test of survivors, which flatters the results.
- A backtest overstates what to expect, and more so after you have tried many variants. Each rule, parameter or variant you try on the same history raises the chance that the one that looks best fits noise. `test from`, "Try other parameter values" and "Was it luck?" help you see this. They do not remove it.
- Real fills differ from the next open: spreads, size and liquidity, outages, and your taxes are not in the numbers.

## Development

```
npm test           # unit tests, each .ts file run directly by Node
npm run typecheck  # tsc --noEmit
npm run build      # type check, then bundle into dist/
node xcheck/run.ts # optional cross-check; needs the second backtester's command-line tool
```

The cross-check needs Rearview's command-line tool, found through the `RVW` environment variable. Without it the script says so and exits 0.

Pushing a tag equal to the `version` in `manifest.json` runs `.github/workflows/release.yml`. It runs the tests, builds, and creates a draft GitHub release with `main.js`, `manifest.json` and `styles.css` attached. `versions.json` maps each plugin version to the minimum Obsidian version.

Layout of `src/`:

- `dsl.ts`, `complete.ts`, `highlight.ts`, `diagnostics.ts`, `editor.ts`: the language and the editor (parser, help text, colours, underlines, auto-complete).
- `evaluate.ts`, `indicators.ts`: evaluating rules, and the indicator maths.
- `engine.ts`, `backtest.ts`, `stats.ts`: the simulation, the benchmark and the statistics.
- `data.ts`, `runner.ts`, `result-cache.ts`: prices and their cache, running a block, and keeping results in memory.
- `compare.ts`, `orders.ts`, `export.ts`: the compare block, orders, and the files, notes and properties a result can become.
- `sweep.ts`, `luck.ts`, `rng.ts`: parameter sweeps and the luck checks (reshuffled history, random entries, walk-forward), and the seeded random numbers they use.
- `llm.ts`, `llm-modal.ts`: drafting.
- `render*.ts`, `price-chart.ts`, `dom.ts`, `orders-view.ts`: drawing results, charts and windows. `render-sweep.ts` and `render-luck.ts` draw the sweep and luck sections, and `render-compare.ts` the compare block.
- `main.ts`, `blocks.ts`, `settings.ts`, `settings-core.ts`, `types.ts`: the plugin itself, settings and shared types.

`styles/*.css` are joined into `styles.css` when you build. `tests/` holds the unit tests, including `readme.test.ts`, which checks every `strategy` and `compare` block in this file.

## Licence

MIT. See `LICENSE`.
