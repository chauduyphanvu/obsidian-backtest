# Backtest Blocks reference

Backtest Blocks is an Obsidian plugin that backtests a trading strategy written as a short block of rules inside a note. You write the rules in a code block marked `strategy`. The plugin gets prices (or reads a CSV file in your vault), runs the rules over that history, and draws the result in place of the block. A strategy can hold each ticker long, hold it short or stay out of it, and can borrow to hold positions worth up to twice its equity.

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

- in the rule language: short positions and leverage up to 2×, with a borrow fee, interest on borrowed money and margin calls; indicators such as the stochastic, ADX, supertrend, MFI and z-score, a commission on each order, positions built in several entries, stops and targets followed through smaller bars inside each bar (`magnify`), and any numeric column of a CSV file as a value in a rule;
- starter strategies, and a helper that turns a CSV file into a ticker, a column to read in a rule or a small strategy;
- help while you write: colours, auto-complete, help on hover, "did you mean" fixes and a lookup of tickers;
- a preview panel that shows the result of the block you are editing;
- backtests, parameter sweeps and luck checks, which all run in the background, with limits on how large and how slow one may be;
- `compare` blocks, which chart several strategies together, and `backtests` blocks, which list every strategy in the vault;
- today's orders, as a window and as a count in the status bar;
- forward tests, which freeze a strategy in a note of its own and measure only the bars that come after, with a log of the orders its rules gave;
- saved results, and results written to note properties.

This is the full guide to the plugin; the [README](../README.md) is the short one. Every `strategy`, `compare`, `account`, `backtests` and `forward` block in it is checked by the plugin's own parser when the tests run.

## What it is not

- It is long, short or leveraged up to 2× gross: long and short positions together are worth at most twice the equity. There are no options and no futures. Weights that add up to more than 200% are rejected; a sell rule only closes a long position you hold, and a cover rule only a short one.
- Shorts and borrowing follow a few plain rules: one borrow fee for every short, one rate on money owed, and a margin call that closes everything (see "Going short", "Leverage" and "Margin calls and ruin"). Hard-to-borrow stocks, recalls of borrowed shares and short-sale restrictions are not modelled.
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
- a definition, written `name = expression`, such as `uptrend = close > sma(200)`;
- a rule, starting with `buy when`, `sell when`, `short when`, `cover when` or `add when`, which may continue on the lines after it;
- a `for` line, which starts rules for one ticker or several;
- a comment, or a blank line.

Only `universe` is required, plus a buy rule or a short rule. The one exception is `hold`, which makes the buy rule optional. Keywords, setting names, function names and parameter names do not care about capital letters.

The parser reads the whole block and reports every problem at once, with the line number. Settings, parameters and definitions can come in any order, and a parameter or a definition can be used above the line that declares it. What does depend on order is the `for` lines: after `for TICKER:`, rules and stops belong to that ticker until `for all:` (see "Per-ticker sections"). A good habit is settings first, then parameters and definitions, then the shared rules, then the `for` sections.

Dates are always written `2015-01-31`. A percentage is written with a percent sign (`5%`) and counts as the number 0.05 wherever a number is expected.

### Settings

| Setting | Example | What it does | Default |
| --- | --- | --- | --- |
| `name` | `name: Trend following` | Title shown above the result. | `Backtest` |
| `universe` | `universe: SPY 60%, TLT 40%` | The tickers to trade, each with an optional weight. Required. | none |
| `symbol` | `symbol: SPY` | Another way to write `universe`. | none |
| `from` | `from: 2015-01-31` | First day of the run. | the first day every ticker has prices |
| `to` | `to: 2024-12-31` | Last day of the run, whole day included. | the last day with prices |
| `data` | `data: binance` | Where plain tickers come from: `yahoo`, `binance` or `tiingo`. A ticker that starts with `^` comes from Yahoo. | the plugin setting (Yahoo) |
| `interval` | `interval: 1h` | Bar size. Yahoo and Tiingo give `1d` and `1w`. Binance gives `1m` `3m` `5m` `15m` `30m` `1h` `2h` `4h` `6h` `8h` `12h` `1d` `3d` `1w`. | `1d` |
| `capital` | `capital: 10k` | Starting money, as `10000` or `10k` (`m` is millions; `$`, commas and underscores are ignored). | the plugin setting (10000) |
| `costs` | `costs: 5 bps` | Cost of each trade, as `5 bps` or `0.05%`. A plain number is bps. Must be under 10%. | the plugin setting (0 bps) |
| `slippage` | `slippage: 5 bps` | How much worse each fill is than the price. Same forms as `costs`. | the plugin setting (0 bps) |
| `size` | `size: 80%` | Share of equity to use when the tickers have no weights. Up to 200%; above 100% the strategy borrows (see "Leverage"). | `100%` |
| `rebalance` | `rebalance: monthly` | `never`, `weekly`, `monthly`, `quarterly` or `yearly`. | `never` |
| `benchmark` | `benchmark: QQQ` | Ticker to compare with, bought and held. | your own tickers at their weights, bought and held |
| `stop loss` | `stop loss: 10%` | Sell this far below the entry price, or for a short buy back this far above it. Also written `2 atr(14)`. | none |
| `trailing stop` | `trailing stop: 15%` | Sell this far below the highest price since entry, or for a short buy back this far above the lowest. Also `3 atr(14)`. | none |
| `take profit` | `take profit: 20%` | Sell this far above the entry price, or for a short buy back this far below it. Also `4 atr(14)`. | none |
| `cash rate` | `cash rate: 4%` | What cash earns a year, or a ticker that quotes a yield, such as `^IRX` or `fred:DGS3MO`. | the plugin setting (0%) |
| `borrow fee` | `borrow fee: 1%` | Yearly fee on the value of short positions (see "Going short"). | the plugin setting (0.5%) |
| `margin rate` | `margin rate: 7%` | Yearly interest on money borrowed (see "Leverage"). | the plugin setting (6%) |
| `test from` | `test from: 2019-01-01` | Reports the results before this day and from it apart. | none |
| `hold` | `hold: top 3 by roc(126)` | Hold only the best-ranked tickers. | none |
| `weighting` | `weighting: inverse volatility(60)` | Calmer tickers get more weight. | the weights as written |
| `risk per trade` | `risk per trade: 1% at 2 atr(14)` | Size each buy or short sale by what it risks. | the weight |
| `fill` | `fill: close` | When an order fills: `next open`, or `close` for the same close the rule was read at. | `next open` |
| `commission` | `commission: 0.005 per share, min 1` | A charge on every order, on top of `costs`: a fixed amount per order, or an amount per share with an optional minimum and maximum. | the plugin setting (none) |
| `entries` | `entries: 3` | Build each position in up to this many entries, each a part of the whole. Needs an `add when` rule. | 1 |
| `magnify` | `magnify: 1h` | Look inside each bar with smaller bars, so a stop and a target in one bar are taken in the order they were reached. | none |

More on the values:

- `bps` means hundredths of a percent: 100 bps is 1%.
- `from` and `to` must be real dates, and `to` must come after `from`. `test from` must lie after `from` and before `to`.
- A setting can be written once. A second `capital:` line is an error.
- A stop loss or trailing stop must be above 0% and at most 99%. A take profit must be above 0% and at most 1000%. A short can never reach a take profit of 100% or more, since the price would have to fall to 0, and the parser notes it.
- `2 atr(14)` means two average true ranges. `atr` alone means `atr(14)`, so `2.5 atr` works.
- `cash rate: 4` without a percent sign is an error, as is a rate above 50%.
- `borrow fee` and `margin rate` are yearly percentages, written with the percent sign: a borrow fee must be between 0% and 100%, a margin rate between 0% and 50%. Only a block that can borrow uses them, and only one that shorts pays a borrow fee (see "Going short" and "Leverage").
- `hold: top 3 by roc(126)` means: hold the 3 tickers with the highest score. The universe must have at least that many tickers. The score is a number written like a value in a rule, so `roc(126)`, `close / sma(200)` or `-stdev(20)` all work. The ranking rules are under "How the simulation works".
- `weighting: inverse volatility(60)` measures volatility over the last 60 one-bar returns. The period must be at least 2.
- `risk per trade: 1% at 2 atr(14)` sizes each buy so that a fall of 2 average true ranges loses 1% of equity, and each short sale so that a rise of 2 does. It cannot be used with `weighting`, or with a `rebalance` other than `never`.
- `fill: close` fills each order at the close it was decided at, as a market-on-close order would, instead of at the next open. It applies to everything that otherwise fills at the next open: buys, sells, adds, ranking decisions, rebalancing and buying again after a stop. Stops and targets still fill inside a bar, and watch a position from the bar after the one it was bought at. The result notes that it assumes you can trade at the close the rule read, and which other tickers a rule read a bar early (see "Reading a result"). The rules are under "How the simulation works": rule 1, and rule 6 for other tickers.
- `commission: 1` charges 1 for each order, in the same money as `capital` (`$1` works too). `commission: 0.005 per share` charges 0.005 for each share, a fraction of a share counting as that fraction. After `per share` you can add `min 1`, so an order pays at least 1, and `max 1%`, so it pays at most 1% of its value; the maximum wins over the minimum, as at brokers that charge this way. `min` and `max` go only with `per share`, and the maximum must be above 0% and under 10%. `commission: 0` means none, whatever the plugin setting says. `costs` and `commission` add together when both are set: `costs` is a share of each fill's value, `commission` an amount for each order. How an order is charged is under "How the simulation works", rules 46 to 50.
- `entries: 3` builds each position in up to 3 entries, and needs an `add when` rule (see "Building a position in entries"). It takes a whole number from 1 to 10.
- `magnify: 1h` follows a bar that holds a stop or target through the 1-hour bars inside it, so the result reads which level was reached first instead of taking the stop first, and a trailing stop moves within the bar. Rules are still read at the strategy's own closes. The size must be shorter than `interval` and divide it evenly. Yahoo gives 2m, 5m, 15m, 30m and 1h bars inside daily bars, for the last 60 days (730 for 1h), and 1d bars inside weekly bars. Binance gives any of its sizes, at most 100,000 for a ticker. A CSV or Tiingo ticker is read whole. What is downloaded and saved is under "Smaller bars for `magnify`" in "Prices and privacy"; the notes under the result say from which day each ticker was looked inside and how many bars were read whole instead. The rules are 58 to 65 under "How the simulation works".
- `size`, `capital`, `costs`, `slippage`, `commission`, `borrow fee`, `margin rate`, `from`, `to`, `test from`, `rebalance`, `data`, `interval`, `fill` and `magnify` take written values only. Parameters can stand in for numbers in rules, stops, `hold`, `weighting`, `risk per trade` and `entries` (see "Parameters and ranges").

### Tickers and sources

The `universe` line lists tickers, separated by commas, each with an optional weight: `universe: SPY 60%, TLT 40%`.

- A plain ticker comes from the source named by `data`, or by the plugin setting when the block has no `data` line. A plain ticker that starts with `^`, an index or a yield such as `^VIX` or `^IRX`, comes from Yahoo whatever `data` says, since only Yahoo has them: with `data: tiingo`, `close of ^VIX` and the cash rate `^IRX` still read Yahoo. Write `tiingo:^VIX` to ask Tiingo all the same.
- Put `yahoo:`, `binance:`, `tiingo:`, `fred:` or `csv:` in front of a ticker to choose its source: `universe: SPY, binance:BTCUSDT`.
- Write Yahoo tickers the way Yahoo spells them: `SPY`, `BRK-B`, `BTC-USD`, `^GSPC`. Binance tickers are market symbols such as `BTCUSDT`. Tiingo tickers are US stocks, ETFs and funds, such as `tiingo:SPY` or `tiingo:BRK-B`. Letters in Yahoo, Binance, Tiingo and FRED tickers are turned into capitals. A ticker may hold letters, digits and `^ . _ = -`.
- Tiingo and FRED need an API key each, chosen in the plugin settings ("Tiingo API key" and "FRED API key"). Without one, a block that uses them stops with "Tiingo needs an API key to load SPY. Choose the secret that holds it under "Tiingo API key" in the plugin settings." (or the same for FRED).
- A FRED ticker is an economic series, written by its FRED series ID, such as `fred:T10Y2Y` (the 10-year Treasury yield minus the 2-year) or `fred:DGS3MO` (the 3-month Treasury bill yield). It holds values, not prices, so it cannot be traded: a rule reads it with `of`, as in `close of fred:T10Y2Y < 0`, and `cash rate` can take it. In the universe or as the benchmark it gives "fred:T10Y2Y is a series of values from FRED, not prices, so it cannot be traded. A rule can read it instead, as in close of fred:T10Y2Y > 0" (or "cannot be the benchmark"). Each value is dated by the day it was first published, not the day it is for (see "Where prices come from"). Its open, high, low and close are all that value, and its volume is 0, so `mfi`, `obv` and `vwap` cannot read it. A value can be zero or below.
- A CSV ticker is a path from the vault's root, such as `csv:Data/gold.csv`. The path cannot contain spaces or commas. Rules and the result call it by the file name without `.csv`, here `gold`.
- Sources can be mixed, but one `interval` applies to every ticker, so it has to be valid for the source of each one, the benchmark's included. A cash-rate ticker is the exception: it only needs daily closes. A FRED series, like a CSV file, has rows of its own spacing, which `interval` does not set.
- A ticker listed twice is an error.
- Two different sources cannot share a name in one block. A CSV file named like a ticker the block also uses, such as `csv:Data/SPY.csv` with `SPY`, gives "SPY is used for two different things here: yahoo:SPY and csv:Data/SPY.csv. Rename the CSV file or use one of them." This covers the universe, tickers read with `of`, the benchmark and the cash-rate ticker. Writing a CSV ticker's bare name, as in `close of gold`, reads that file.

Weights:

- A weight is a percentage after the ticker. Give every ticker a weight or none of them.
- Weights must add up to at most 200%. Up to 100%, what is left stays in cash; above it, the strategy borrows (see "Leverage").
- With no weights, each ticker gets an equal share of `size` (100% unless you set it). You cannot give weights and `size` together.
- With `hold`, give no weights: each ticker held gets `size` divided by the number held.

### Rules and continuation lines

```
buy when <condition>
sell when <condition>
short when <condition>
cover when <condition>
```

A buy rule opens a long position in a ticker you do not hold when the condition is true at a close. A sell rule closes the position when it is true at a close. Both fill at that ticker's next open, or with `fill: close` at that same close. A short rule and a cover rule do the same for a short position (see "Going short"). You can write one rule of each kind for each scope (see the next part), and with `entries` one `add when` rule (see "Building a position in entries"). Without a sell rule a position is held until a stop closes it, the short rule turns it short, or the run ends.

A rule can continue on the following lines. Indent them and start each with `and` or `or`:

```strategy
universe: SPY
buy when close > sma(200)
  and rsi(14) < 70
sell when close < sma(200)
  or rsi(14) > 85
```

A rule ends at the first blank line, or at a line that is a setting, a parameter, a definition, a `for` line or another rule. Do not leave a blank line in the middle of a rule. A definition continues the same way (see "Definitions").

### Per-ticker sections

A line such as `for TLT:` starts a section for one ticker. A line such as `for SPY, QQQ:` starts one for several: each ticker listed gets the rules and stops that follow, as if they were written under a `for` line of its own. `for all:` goes back to the rules every ticker shares.

- Rules written before any `for` line, or after `for all:`, are shared. They apply to every ticker that has no rule of its own for that side.
- A `buy when`, `sell when`, `add when`, `short when` or `cover when` inside `for TLT:` replaces the shared rule of the same kind, for TLT only. Inside `for SPY, QQQ:` it does so for each of them.
- Inside a `for` section you can also write `stop loss`, `trailing stop` and `take profit`. Each one replaces the shared setting of the same kind for that ticker. The kinds you leave out stay as they are in the shared settings.
- Any other setting inside a `for` section is an error, because it applies to the whole strategy. Put it above the first `for` line or after `for all:`.
- Each ticker must be in the universe, and a message points at the one that is not, as in `"for SPY, QQQ:" names QQQ, which is not in the universe`. For a CSV ticker, use the file name. List a ticker once on a line, and write `for all:` on its own, not with others.
- A rule of one kind written twice for a ticker is an error, whichever sections the two come from: with `for SPY, QQQ:` above a `buy when`, a later `for QQQ:` with its own `buy when` says "There is already a buy rule for QQQ". Join the conditions with `and` or `or` instead.
- Every ticker needs a buy rule or a short rule, shared or its own.

### Conditions and operators

A condition compares numbers and joins the comparisons.

| Written | Means |
| --- | --- |
| `>` `<` `>=` `<=` `==` `!=` | The usual comparisons. `==` and `!=` also compare two conditions, as in `uptrend of SPY == false`. |
| `above`, `below` | The same as `>` and `<`. You can write `is above` and `is below`. |
| `crosses above`, `crosses below` | `a crosses above b` is true on a bar where a is above b and was at or below b on the previous bar. `crosses below` is the mirror of it. |
| `crosses` | `a crosses b` is true on a bar where a crosses above b or crosses below it: either way. |
| `between` | `a between lo and hi` means `a >= lo and a <= hi`, with a read twice, so both ends are included: `rsi(2) between 10 and 30`. |
| `for n bars`, `within n bars` | `cond for 3 bars` is true when the condition held on each of the last 3 bars, this one included. `cond within 3 bars` is true when it held on at least one of them (see "Windows of bars"). |
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
3. the windows `for n bars` and `within n bars`, on the comparison before them and a `not` in front of it. So `a and b for 3 bars` reads as `a and (b for 3 bars)`, and `not up for 3 bars` as `(not up) for 3 bars`, out of the trend on each of the 3 bars. Use brackets to apply a window to more, as in `(a and b) for 3 bars`, or to keep it inside a `not`, as in `not (up for 3 bars)`.
4. `not`
5. comparisons (`>`, `<`, `>=`, `<=`, `==`, `!=`, `above`, `below`, `crosses above`, `crosses below`, `crosses`, `between`). They do not chain: write `a < b and b < c`, not `a < b < c`.
6. `+` and `-`
7. `*` and `/`
8. a leading `-`
9. `[n]` and `of`, then function calls and brackets

So `not close > 1 + 2 * 3 or close < 0 and volume > 5` reads as `(not (close > 1 + (2 * 3))) or ((close < 0) and (volume > 5))`. `rsi(2) between 10 and 30 and close > sma(200)` reads as `(rsi(2) between 10 and 30) and (close > sma(200))`, and `not rsi(2) between 10 and 30` as `not (rsi(2) between 10 and 30)`. In the rule values table and in "Explain this trade", a `between` is one part that opens into its two comparisons, and a window is one part that shows the count it rests on.

A rule has to be a condition: `buy when sma(200)` is an error. Both sides of a comparison have to be numbers, and `and`, `or` and `not` need conditions on their sides. A rule can nest at most 64 levels of brackets, functions and operators, a long chain such as `a + b + c + ...` counting one level for each term; deeper is an error.

Another ticker: `sma(200) of SPY` and `close of ^VIX` read a value from a ticker that does not have to be in the universe. `of` applies to the value just before it, so write `(close - open) of SPY` to apply it to a whole expression. A ticker that is not in the universe is loaded from the default source (the `data` line or the plugin setting), or from the source you name, as in `close of binance:BTCUSDT`. For each bar of the rule's own ticker, you get the other ticker's latest bar that had ended by the time this bar ended (rule 6 under "How the simulation works"). Daily tickers on the same dates line up day for day; a weekly bar dated Monday is read from the following Monday, once its week is over. With `fill: close`, a ticker on other hours than the rule's own is read one bar earlier (rule 6). A column of a CSV file is read the same way: `column(score) of signals` (see "Signals from a CSV file").

Earlier bars: `close[5]` is the close five bars back. It works on any value: `highest(20)[1]` is the highest high of the 20 bars before this one.

### Windows of bars

`cond for n bars` is true when the condition held on each of the last n bars, this one included, and `cond within n bars` when it held on at least one of them (`bar` is also accepted, as in `for 1 bar`). The number is a whole number from 1 to 10000, or a parameter whose value is one.

```strategy
universe: SPY
days = 5 in 3..10
buy when close > sma(200) for days bars and rsi(2) < 10 within 3 bars
sell when count(close < close[1], 5) >= 4
```

- They are built on `count(condition, n)`, which says how many of the last n bars the condition held, this one included: `x for n bars` is `count(x, n) == n`, and `x within n bars` is `count(x, n) >= 1`. You can write `count` yourself, as in `count(close > close[1], 10) >= 7`.
- A window is unknown until n bars have been read, and while any of its bars is unknown (rule 33). So `x within 3 bars` is unknown on a bar where an earlier bar of the window is unknown, even if the condition held on another.
- A window applies to a condition, so `close for 3 bars` is an error. It binds at the level of a comparison, with a `not` in front of it: `a and b for 3 bars` reads as `a and (b for 3 bars)`, and `not up for 3 bars` as `(not up) for 3 bars`.
- A position value cannot be read over a window, since it belongs to the open position at the bar being read: `bars held > 3 for 2 bars` and `count(bars held > 3, 2)` are errors. Read it outside the window, as in `sell when bars held > 5 and close < sma(20) for 3 bars`.
- The history a rule needs grows by n for a window (rule 4); with a parameter, by the largest value of its range.

### Series

These are the bar's own values for the ticker the rule belongs to: `open`, `high`, `low`, `close` and `volume`. With Yahoo data the prices are adjusted (see "How far to trust it").

### Functions

Most functions read a series and take one or more periods. Without a series they read the one in the table. To read another, write it first: `sma(volume, 20)`, or `sma(rsi(2), 5)`. Periods must be plain numbers or parameters, whole numbers from 1 to 10000. `slope`, `zscore`, `cci`, `hma`, `linreg`, `rsquared` and `correl` need a period of at least 2. A Bollinger or Keltner `width`, the supertrend `mult` and the `psar` `step` and `max` can be any number above 0, and `psar` refuses a `step` above its `max`. Empty brackets use the defaults: `macd()`, `rsi()`, `atr()`.

Some functions read the ticker's own high, low, close and volume and take no series, as `atr` does: `stoch_k`, `stoch_d`, `adx`, `plus_di`, `minus_di`, `cci`, `williams_r`, `mfi`, `obv`, `vwap`, `supertrend`, `supertrend_up`, `aroon_up`, `aroon_down`, `psar` and `cmf`. `mfi`, `obv`, `vwap` and `cmf` need volume. A ticker whose prices have none, such as a CSV file without a `volume` column, a FRED series or an index with no volume, stops the run with "X has no volume, which mfi() needs". `bars_since` and `count` take a condition instead of a series, and `correl` takes the other ticker's series first.

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
| `count` | `count(condition, n)` | How many of the last n bars the condition held, this one included: `count(close > close[1], 10) >= 7`. Unknown until n bars have been read and while any of them is unknown. |
| `bars_since` | `bars_since(condition)` | Bars since the condition was last true: `bars_since(close crosses above sma(50)) < 10`. |
| `sum` | `sum(n)` or `sum(series, n)` | Sum of the last n values: `sum(volume, 5)`. |
| `dema` | `dema(n)` or `dema(series, n)` | Double exponential average, with less lag than `ema`. |
| `tema` | `tema(n)` or `tema(series, n)` | Triple exponential average, with less lag still. |
| `kama` | `kama(n = 10, fast = 2, slow = 30)` or `kama(series, n, fast, slow)` | Kaufman's adaptive average: it follows the price closely in a trend and slowly in chop. |
| `aroon_up` | `aroon_up(n = 25)` | Aroon up, 0 to 100: how recent the highest high of the last n + 1 bars is. It takes no series. |
| `aroon_down` | `aroon_down(n = 25)` | Aroon down, 0 to 100: how recent the lowest low of the last n + 1 bars is. It takes no series. |
| `psar` | `psar(step = 0.02, max = 0.2)` | Wilder's parabolic SAR, a stop that trails the price: under it in an uptrend, over it in a downtrend. It takes no series. |
| `cmf` | `cmf(n = 20)` | Chaikin money flow, -1 to 1: buying against selling pressure, weighted by volume. It takes no series and needs volume. |
| `linreg` | `linreg(n)` or `linreg(series, n)` | The value at this bar of the least-squares line through the last n values. |
| `rsquared` | `rsquared(n)` or `rsquared(series, n)` | How well that line fits them, 0 to 1. |
| `efficiency` | `efficiency(n)` or `efficiency(series, n)` | Kaufman's efficiency ratio, 0 to 1: how straight the move over n bars was. |
| `streak` | `streak()` or `streak(series)` | Bars in a row the value rose (1, 2, 3, ...) or fell (-1, -2, ...). |
| `min` | `min(a, b)` | The smaller value. |
| `max` | `max(a, b)` | The larger value. |
| `abs` | `abs(x)` | The value without its sign. |
| `sqrt` | `sqrt(x)` | The square root, unknown below 0: `stdev(roc(1), 20) * sqrt(252)`. |
| `log` | `log(x)` | The natural logarithm, unknown at 0 and below: `slope(log(close), 90)`. |
| `exp` | `exp(x)` | e to the power x, unknown when too large to hold. |
| `if` | `if(condition, a, b)` | `a` where the condition holds and `b` where it does not, unknown where the condition is unknown. `a` and `b` are numbers: `if(close > sma(200), roc(126), 0)`. |
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
- `count` is the number of the last n bars on which its condition was true, this bar included. It is unknown on the first n - 1 bars and on any bar where one of the n is unknown. `cond for n bars` and `cond within n bars` are `count(cond, n) == n` and `count(cond, n) >= 1`.
- `bars_since` is 0 on a bar where its condition is true, and otherwise the number of bars since it last was. It is unknown until the condition has been true once, and after a bar where the condition was unknown it is unknown until the condition is next true. It counts back only as far as the prices loaded, which is the history the condition needs plus 250 bars (rule 4).
- `sum` adds up the last n values as a running total, moved on one bar at a time and added up again from scratch every n bars, so rounding cannot build up over a long series.
- `dema` is 2 * e1 - e2 and `tema` is 3 * e1 - 3 * e2 + e3, where e1 is the `ema` of the series over n bars, e2 the `ema` of e1 and e3 the `ema` of e2, each exactly as `ema` gives it, seeded with the simple average of its first n values. The first 2n - 2 bars of `dema` are unknown, and the first 3n - 3 of `tema`.
- `efficiency` is |x - x[n]| divided by the sum of |x - x[1]| over the last n bars, so it is 1 when the value rose or fell on every bar and near 0 when it ended where it began after a lot of movement. A window in which the value did not change gives no value. The first n bars are unknown.
- `kama` is the previous value plus sc * (x - the previous value), where sc = (ER * (2 / (fast + 1) - 2 / (slow + 1)) + 2 / (slow + 1)) squared, and ER is the `efficiency` over n bars, taken as 0 for a window that did not move. Its first value is at the first bar where ER is known, the n-th bar after the first known value, and it starts from the value of the bar before that one, which is TA-Lib's convention: where `ema` starts from an average, `kama` starts from one price, so what a run starts with is what the history before `from` leads to (rule 4).
- `aroon_up` is 100 * (n - k) / n, where k is the number of bars since the highest high of the last n + 1 bars, this one and the n before it: 100 when this bar made the high, 0 when it was n bars ago. When several bars share the highest high, the most recent is the one counted. `aroon_down` is the same for the lowest low. The first n bars are unknown.
- `psar` is Wilder's parabolic SAR. It starts on the first two bars that have a high, low and close. The first trend is up when the second close is above the first and down otherwise (equal included). The first SAR is the first bar's low in an uptrend and its high in a downtrend, and the extreme point is the second bar's high or low. The second bar is tested like any later one, so if it crosses that SAR the trend reverses on that bar and the value shown there is already the reversed one. After that, each bar the SAR moves the share af of the way to the extreme point, but not above the lows of the two bars before in an uptrend, or below their highs in a downtrend. af starts at `step`, grows by `step` each time the trend makes a new extreme (a higher high in an uptrend, a lower low in a downtrend) and stops at `max`. A bar whose low is below the SAR in an uptrend, or whose high is above it in a downtrend, reverses the trend on that bar: the SAR becomes the old extreme point (or the bar's own high or low, if that is further out), the extreme point becomes the bar's low or high, and af goes back to `step`. The first bar is unknown. A run starts with the trend the history before `from` leads to (rule 4).
- `cmf` is the sum over the last n bars of ((close - low) - (high - close)) / (high - low) * volume, divided by the sum of their volume, from -1 to 1. A bar with no range (high equal to low) adds 0 to the top, and its volume still counts below. It is unknown while none of the n bars traded. The first n - 1 bars are unknown.
- `linreg` is the value at the last bar of the least-squares straight line through the last n values, against the bar number: their average plus `slope` times (n - 1) / 2. `rsquared` is the share of the spread of those values the line explains, the square of their correlation with the bar number, from 0 to 1, and a window of equal values gives no value. The first n - 1 bars of both are unknown.
- `streak` is 1, 2, 3, ... on the bars where the value rose from the bar before and the one before it also did, -1, -2, -3, ... for falls, and 0 on a bar equal to the one before. It needs the change from the bar before, so it is unknown on the first bar and where either value is unknown, and counts again from the next known change as if the data began there. It counts back only as far as the prices loaded, which is 250 bars more than what its series needs (rule 4). Connors RSI is `(rsi(3) + rsi(streak(), 2) + percent_rank(roc(1), 100)) / 3`.
- `sqrt`, `log`, `exp` and `if` work on each bar's values on their own, so they can be used with position values (`sell when close < if(bars held > 10, sma(20), entry price * 0.95)`) as `abs` can. `sqrt` is unknown below 0, `log` at 0 and below, and `exp` where the result is too large to hold (above about e to the 709). `if(condition, a, b)` is `a` where the condition holds and `b` where it does not, and unknown where the condition is unknown, whatever `a` and `b` are there; where it is known, only the one it picks counts, so `if(close > sma(200), roc(126), 0)` is 0 on a bar below the average even while `roc(126)` is still unknown. `a` and `b` must be numbers, and the whole is a number, so a rule needs a comparison around it.
- Every function above that needs a full window gives no value while the window has fewer than n known values, so a gap of unknown values makes it unknown until it is full of known ones again. `adx`, `plus_di`, `minus_di`, `supertrend`, `supertrend_up`, `obv`, `dema`, `tema`, `kama` and `psar`, like `ema`, stay unknown once an unknown value has reached them.

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
| `quarter` | Quarter of the bar, 1 to 4. |
| `week_start` | A condition: the first bar of a week. Weeks start on Monday, as `rebalance: weekly` counts them. |
| `week_end` | A condition: the last bar of a week. |
| `quarter_start` | A condition: the first bar of a quarter. |
| `quarter_end` | A condition: the last bar of a quarter. |
| `year_start` | A condition: the first bar of a year. |
| `year_end` | A condition: the last bar of a year. |
| `trading_day` | The number of the bar's day within its month, counting the days that have a bar: 1 on the month's first such day. |
| `trading_days_left` | The days that have a bar left in the month after the bar's day: 0 on the month's last such day. |

For example, `buy when month_end` or `sell when month == 5 and day > 20`.

Each `_start` is unknown on the first bar of the data, whose period may have begun before it. Each `_end` is known on the last bar too: it holds when the next bar the data expects, one step on from the last (skipping Saturday and Sunday unless the data has weekend bars), falls in another period, so a holiday after the last price is not known. All of them are read from the bars' own dates, so they look ahead only as far as a calendar does.

`trading_day` and `trading_days_left` count days, not bars: on hourly or other short bars every bar of a day has the same number, and a day with no bar is not counted, so they follow the market's own calendar, `trading_day` from the start of the month and `trading_days_left` to its end. `trading_day` is unknown through the first month of the data, whose first days may be missing. A run loads a month and a week of bars before `from` for it, whatever `interval` is (rule 4), so it is known from the run's first bar. `trading_days_left` reads the dates of the bars after this one in the month; past the last bar it counts the days the data would go on to have, stepping as above, so it does not know a holiday that is still to come. The turn of the month, held from the day with three trading days left until the third trading day of the next month, is:

```strategy
universe: SPY
buy when trading_days_left == 3
sell when trading_day == 3
```

### Position values

These belong to the open position, so only sell, cover and add rules can read them.

- `bars held` (also written `bars_held`) is the number of completed bars since the buy filled, or for a short since the short sale filled. It is 0 on the bar of the fill. With several entries it counts from the first.
- `entry price` (also written `entry_price`) is the price the position was bought at, slippage included, or for a short the price it was sold at. With several entries it is their average price, weighted by the shares of each.
- `last entry price` (also written `last_entry_price`) is the price of the latest entry, slippage included. With one entry it is the entry price.
- `entries made` (also written `entries_made`) is how many entries the position has: 1 after the buy or the short sale, and one more for each add.
- `highest since entry` (also written `highest_since_entry`) is the highest price since the position's first entry: the price the first entry filled at, before slippage, then the high of each later bar, and the high of the fill bar too when it filled at that bar's open. With `fill: close` the fill bar's range came before the fill, so it does not count. It is the same high-water mark the trailing stop trails from (rule 23), kept for a short as well, where it is the highest price, not the best.
- `lowest since entry` (also written `lowest_since_entry`) is the same with lows: the first entry's fill price before slippage, then the low of each later bar (and of the fill bar when it filled at its open).
- `position return` (also written `position_return`) is the open position's return at this close before costs: `close / entry price - 1` for a long and `1 - close / entry price` for a short, where the entry price is the one above, an average with several entries.

They are read at the close of each bar, so the bar being read counts: `highest since entry` includes this bar's high. They cannot be used in a buy or short rule or a `hold` score, inside a function (`sma(bars held, 2)`), over a window of bars (`for n bars`, `within n bars`, `count`), with `[n]`, or with `of`. Write them with spaces or underscores, but not as the single words `bars`, `entry`, `entries`, `highest`, `lowest` or `position`: `highest` and `lowest` alone are the functions, and `position` alone is free to use as a parameter's name, as `last` is.

```strategy
universe: SPY
buy when close > sma(200)
sell when bars held >= 20 or close < entry price * 0.9
```

A chandelier exit on closes, and a profit target that also ends a stale position:

```strategy
universe: SPY
buy when close > sma(200)
sell when close < highest since entry - 3 * atr(22)
  or position return > 20%
  or bars held > 30
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
- With short rules, the add rule adds to whichever side is held, so a short is built in entries the same way, each entry a short sale.
- `entries` above 1 needs an add rule for every ticker, and an add rule needs an `entries` line. To add only on some tickers' conditions, give the others `add when false`; they then hold one entry's part of their weight.
- At most one entry is added at each close, and none at a close where the sell rule holds, or for a short the cover rule. The sell rule, a stop or a target sells the whole position: there are no partial sales.
- The stop loss and take profit are measured from the average entry price, so in the block above the 8% stop moves up with each add. The trailing stop trails from the first entry.
- A rebalance keeps a position at its entries' part of the weight: two entries of three are rebalanced to two thirds of it. It never makes an entry.
- The trade list shows a position once, from its first entry to its sale, at its average price.

The exact rules are 51 to 57 under "How the simulation works".

### Going short

A short sale sells shares the strategy has borrowed, and buys them back later. It gains when the price falls and loses when it rises, and a price has no limit on how far it can rise. Two rules trade a short, written like the buy and sell rules:

```strategy
name: SPY short below its average
universe: SPY
from: 2005-01-01
costs: 5 bps

short when close < sma(200)
cover when close > sma(200)
```

- A short rule sells short a ticker you do not hold when its condition is true at a close. A cover rule buys the short back when its condition is true at a close. Both fill as a buy and a sell do: at the ticker's next open, or with `fill: close` at that same close.
- A block can trade one side or both. Every ticker needs a buy rule or a short rule, and a ticker with only short rules never goes long. A cover rule needs a short rule. A block with `hold` can't have short rules: its ranking only buys.
- From cash, a ticker goes long when its buy rule holds and its sell rule does not, and short when its short rule holds and its cover rule does not. When both would happen, neither does, and the result says on how many bars that was: "Buy and short rules both held on 12 bars, so neither opened a position." A position held is still closed on such a bar when the other side's rule holds (rule 68), so a long can end on its short rule with nothing opened in its place.
- A long position is closed by its sell rule or by the short rule, a short by its cover rule or by the buy rule. The bar is then read again as if the ticker were in cash, so the other side opens at the same fill when its entry holds on its own: a flip. With only a buy rule and a short rule, as in the starter "Trend, long or short", the ticker is held from the first close its 200-day average is known, long above the average and short below it:

```strategy
name: Trend, long or short
universe: SPY
from: 2005-01-01
costs: 5 bps

buy   when close > sma(200)
short when close < sma(200)
```

- A short is sized as a buy is, by its weight, `size` or `risk per trade`, and the value is what the sale brings in. Entries and `add when`, rebalancing, stops and the position values all work for a short: `entry price` is the price it was sold at, and `bars held` counts from the sale.
- Stops are mirrored. A stop loss sits above the price the short was sold at and a take profit below it, a trailing stop follows the lowest low since the sale from above, and a bar that opens beyond a level fills there at the open. A short can gain at most 100%, when the price falls to 0, so a percentage take profit of 100% or more is never reached, and the parser notes it.
- After a stop or target closes a short, the short rule has to stop holding at a close before the ticker is shorted again, as the buy rule does after a long's (rule 29). Each side waits on its own, so a long that was stopped out can turn short at once.
- A short pays a borrow fee for every day it is held: a yearly rate on its value at the last close, `borrow fee: 1%` in the block, or else the plugin setting "Borrow fee for shorts", 0.5% unless you change it. The fee is part of the trade's profit and return, and the result notes the total: "Borrow fees for shorts: $123."
- The money a sale brings in earns no interest of its own: cash earns the cash rate only on what is left after setting the value of the shorts aside (rule 73).
- A short's return is measured on what the sale brought in: the sale price less costs, minus the buy-back price with its costs, the commission and the borrow fees, over the sale price less costs (rule 75).
- Under the result, Positions says "Short since 2026-04-09" for a short held, and when the run has a short trade the trade list has a "Side" column, "Long" or "Short". A short closed by its cover rule ends with "cover rule", and a position closed by the other side's entry with "flipped to short" or "flipped to long".

### Leverage

Weights that add up to more than 100% hold more than the equity, with borrowed money:

```strategy
name: 60/40 at one and a half times
universe: SPY 90%, TLT 60%
from: 2008-01-01
rebalance: quarterly
margin rate: 6%

buy when true
```

- Weights may add up to at most 200%, and so may `size`. A block's cap is its own weights' total, at least 1 and at most 2: the block above may hold positions worth up to 1.5 times its equity, long and short together (its gross), and a block whose weights add up to 100% or less may hold up to its equity, shorts included.
- A buy or a short sale may use the room there is at its fill: cash − 2 × S + (L − 1) × E, where S is the value of the shorts, E the equity and L the cap. Spending all of it takes the gross to L times the equity. A short counts twice, as the money its sale brought in is in the cash but owed back, and its value is part of the gross. With no shorts and a cap of 1 the room is the cash, so such a block buys as one that never borrows.
- Sells and covers never wait for room. Between rebalances, positions drift with their prices and may go above the cap; nothing is cut for that except by a margin call (see the next part).
- Money owed pays interest. Between two bars, when the cash less the value of the shorts is below 0, that amount pays the margin rate for the days between them: `margin rate: 7%` in the block, or else the plugin setting "Interest on borrowed money", 6% unless you change it. When it is above 0, it earns the cash rate. The result notes the total: "Interest on borrowed money: $456."
- For a block that can borrow, the "Time invested" figure becomes "Exposure": the average gross over equity, such as "150%", with the net, long less short, under it: "gross, net 50%".
- The benchmark holds the same tickers with their weights scaled down to 100%, so it never borrows, and a ticker the block shorts is held long (rule 79).

### Margin calls and ruin

A block that borrows can lose more than its equity. Two rules deal with that.

- **Margin call.** At each close, when equity is below 25% of the gross value of the positions, every position is closed at its ticker's next open, before anything else there, also with `fill: close`. Orders waiting are cancelled, and each side's entry rule has to stop holding at a close before it opens again, as after a stop. These exits read "margin call", and the result says how many calls there were: "2 margin calls: equity fell below 25% of the positions' value, and every position was closed at the next open."
- **Ruin.** When equity is below 0, or at 0 with a position still open, at an open or at a close, every position is closed there and the run stops. Equity is 0 from then on, and nothing more is traded or charged. These exits read "ruin", and the result says when it happened and what the account still owed once everything was closed: "Ruined on 2022-03-04: equity fell to zero and the run stopped there; the account owed $1,000 more." Return per year and worst drawdown are then −100%, and the Sharpe ratio and the other figures made from returns count only the bars up to the ruin.

A broker works differently: it sets a level for each position, asks for more money first, and sells the biggest losers until the shortfall is covered. Closing everything at once is a simpler and harsher rule (see "How far to trust it"). The exact rules for shorts, leverage, margin calls and ruin are 66 to 79 under "How the simulation works".

### Parameters and ranges

A parameter is a named number on its own line:

```
fast = 50
```

A line `name = value` is a parameter when its value is a number, or a number followed by a range. Any other value makes it a definition (see "Definitions"). A value that starts like a range but is not one, such as `fast = 50 in 20`, is still a parameter, and gets the parameter's message.

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
- The words added after 0.7.0 are the exception, so a block written before them keeps working: `count sum dema tema kama aroon_up aroon_down psar cmf linreg rsquared efficiency streak sqrt log exp if between within quarter week_start week_end quarter_start quarter_end year_start year_end trading_day trading_days_left highest_since_entry lowest_since_entry position_return`. A parameter or definition can take one of them, and in that block the name means it. The word's own meaning is then not available there, and calling it as a function says so: with `count = 5`, `count(close > close[1], 10)` gives "count is your parameter in this block, so count() can't be used here". `between` and `within` still open a range or a window where they follow a value.
- Declare a name once, among parameters and definitions together. Names do not care about capital letters. A parameter can sit anywhere in the block.

A range changes nothing by itself: the block runs with the value written. Every declared parameter gets a slider in the result (see "The Parameters bar" under "Reading a result"), and a range also enables "Try other parameter values".

### Definitions

A definition gives a name to a condition or to a number, so a long rule can be read in pieces and a piece written once:

```strategy
universe: QQQ
uptrend = close > sma(200)
stretch = close / sma(20) - 1
buy when uptrend and stretch < -3%
sell when not uptrend or uptrend of SPY == false
```

- It is a line `name = expression`. A value that is a number, or a number with a range, is a parameter instead (see "Parameters and ranges"). Like a rule, a definition may continue on the lines after it that start with `and` or `or`.
- Use the name wherever the condition or the number could be written: in a rule, in the `hold` score, and in other definitions. A definition can use parameters and other definitions, whichever comes first in the block, but one that leads back to itself, directly or through others, is an error on its own line.
- Where it is used it is replaced by its expression, so the strategy that runs has only ordinary expressions: `uptrend of SPY` reads the whole condition for SPY, `uptrend[1]` is the whole condition one bar earlier, `not uptrend` is its opposite, and `uptrend for 3 bars` is a window over it. A strategy written with definitions gives exactly the result of the same strategy written without them, and the same trigger prices.
- Each use is checked where it stands. A definition that reads `bars held` or another position value is fine in a sell, cover or add rule, and an error in a buy rule, which names the definition: `"held" reads "bars held", which only makes sense in a sell, cover or add rule`. A definition cannot stand where a period or a plain number is wanted, as in `sma(n)`, `close[n]`, `for n bars` or `stop loss: n`; make that name a parameter instead.
- A mistake inside a definition is reported once, on the definition's own line, and the places that use it say nothing more.
- A name follows the rules for a parameter's name, and is unique among the parameters and definitions of the block. A definition that no rule or `hold` score reads gives a note, since it does nothing.
- Definitions made of definitions are filled in wherever they are used, so a rule that reads more than 3,000 words and symbols of definitions in all, nested ones counted each time they are read, is an error.

In the rule values table and in "Explain this trade", a rule shows a definition by its name, with the parts of its expression below it as they are written on its line. The parameters a definition reads are listed with the rule's own. The editor colours a definition's name like a parameter's, offers it as you type a rule, and shows its text when you hover it. It has no slider, since it has no value of its own to change.

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
Line 3: Unknown name "smaa". Series: open, high, low, close, volume. Functions: sma, ema, rsi, roc, stdev, highest, lowest, atr, macd, macd_signal, bb_upper, bb_lower, stoch_k, stoch_d, adx, plus_di, minus_di, cci, williams_r, mfi, obv, vwap, keltner_upper, keltner_lower, supertrend, supertrend_up, wma, hma, median, zscore, percent_rank, slope, correl, count, bars_since, sum, dema, tema, kama, aroon_up, aroon_down, psar, cmf, linreg, rsquared, efficiency, streak, min, max, abs, sqrt, log, exp, if, column. Dates: month, day, weekday, year, month_start, month_end, quarter, week_start, week_end, quarter_start, quarter_end, year_start, year_end, trading_day, trading_days_left
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

**An economic series as a filter, and interest from FRED.** Hold SPY while it is above its 200-day average and the yield curve is not inverted: FRED's series `T10Y2Y` is the 10-year Treasury yield minus the 2-year, in percentage points, and below 0 the curve is inverted. Cash earns the 3-month Treasury bill yield, FRED's `DGS3MO`. Both need the "FRED API key" setting. Each value counts from the day FRED first published it, so the rules never read a spread before it was known. Comparing a FRED value with a fixed number gets no note: FRED's values are not adjusted.

```strategy
name: SPY while the curve is normal
universe: SPY
from: 2005-01-01
cash rate: fred:DGS3MO

buy when close > sma(200) and close of fred:T10Y2Y > 0
sell when close < sma(200) or close of fred:T10Y2Y < 0
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

The command "Insert strategy block" opens a window called "Start from a strategy". It lists ten strategies and an "Empty block", each with a few lines on what it does and when it tends to struggle. Choose an entry with the mouse or the arrow keys (Home and End jump to the first and last) to see its text, coloured as it is in a result. "Insert", Enter, or a double-click on an entry puts the block at the cursor of the note you are editing, on its own line. The command works only while a note is open for editing.

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
| Trend, long or short | A `short when` rule beside the buy rule, so the fund is held long above its 200-day average and short below it, flipping at each crossing. |

The starters are examples of the language, not advice. Each charges costs, and all but "Trend, long or short" are long or flat. How a strategy did on past prices says nothing about future prices (see "How far to trust it").

## How the simulation works

These are the engine's rules. Each is exact.

**Timing**

1. Rules are read at the close of each bar. A buy or sell that is true at a close fills at that ticker's next open, the next bar of that ticker. With `fill: close` it fills at that same close instead, and so does everything else that would fill at the next open: ranking decisions, adds, rebalancing and buying again after a stop (rules 17, 18, 23, 26, 27, 31 and 51 say how).
2. An order from the last bar in the prices is not filled. It stays pending and is reported in the result and in "Today's orders". With `fill: close` it has filled at that last close, so nothing is left pending, except an order from a ranking decision made at a time a ticker had no bar, which fills at that ticker's next close.
3. The run starts on `from`, or on the first day every ticker in the universe has prices if that is later. Tickers read only with `of`, and the benchmark, do not delay the start. The result warns when the run starts more than 7 days after `from`. It ends on `to`, or on the last bar.
4. Bars before the start feed the indicators. With `from` set, every ticker's prices start a lookback before it: the longest chain of windows and lags in the block's rules, `hold` score, ATR stops and sizing. Nested windows add up, `[n]` adds n, a `for n bars` or `within n bars` window and `count(condition, n)` add n to what the condition needs, and `ema`, `rsi`, `atr`, `macd`, `plus_di`, `minus_di`, `keltner_upper`, `keltner_lower`, `supertrend` and `supertrend_up` count five times their period, and `adx` ten times, because they depend on where they started. `dema` counts ten times its period and `tema` fifteen times, and `kama` its period plus ten times the time constant of its slowest smoothing, ((slow + 1) / 2) squared bars, up to 50,000, for the same reason: 2,414 bars for `kama(10, 2, 30)`. `aroon_up`, `aroon_down`, `efficiency` and `kama` read one value more than their period, so they count one bar more, as `percent_rank` does. `bars_since` and `streak` add 250 bars to what they read, and count back no further than the prices loaded, and `psar`, which depends on the trend it began in, reads 250 bars. `month_start` and the other `_start` values need the bar before, and `trading_day` needs the data to begin before the month of the run's first bar: it reaches back 38 days, a month and a week for the days a month may lack, which is as many bars as that many days hold at the run's `interval`, so it is known from the first bar at any bar size. A period or lag given by a parameter with a range counts at the largest value of its range, so the sliders, "Try other parameter values" and "Was it luck?" can try any value in it on the prices already loaded. The lookback is at least 250 bars, and for daily and longer bars it reaches 1.6 times as far in calendar time, for weekends and holidays. A CSV file's lookback is counted in its own rows, whatever `interval` says: at least that many rows, and as far in time as its own bar size, the shortest gap between its rows, calls for. Older prices are left out even when they are saved, so the same block gives the same result every time. Without `from`, the whole history is used.
5. The run has one step for each time at which any ticker in the universe has a bar. A ticker with no bar that day keeps its last close for valuing the position.
6. A value read with `of`, the benchmark's value and a cash-rate ticker's yield come from that series' latest bar that had ended by the end of the strategy's bar. A bar ends at its start plus its series' step, the shortest gap between its bars. From a step of 20 days on, the step is counted in calendar months, so a monthly bar dated the 1st ends on the 1st of the next month. Daily series on the same dates line up day for day, whichever days each trades; a weekly bar dated Monday is read from the following Monday; an hourly rule reads a daily bar from that day's 23:00 bar on. With `fill: close`, a rule reads a ticker that keeps other hours than its own ticker one bar early: from that ticker's latest bar that had ended by the time the rule's own bar began, so never its bar of the same day, week or hour. Two tickers keep other hours when the prices show it: they come from different sources (Yahoo or Tiingo, which date a listing's bars alike, Binance, FRED or a CSV file), they have bars on different days of the week (crypto trades at weekends, stocks do not), or their bars are of different sizes. A stock's rule that reads `close of binance:BTCUSDT` therefore reads Bitcoin's previous day, and an hourly rule reads a daily bar from the next day's first hour on. Tickers on the same hours are read as before, and the result notes that it takes the other ticker's close as known at the moment of the fill, which is not true for a market that closes later, such as a New York stock read by a Tokyo one. Binance tickers of one bar size all close at the same moment and get no such note. The benchmark and a cash-rate ticker decide no orders and are read the same way with either fill. A column of a CSV file is read from the file's latest row that had ended: on each bar of the rule's own ticker, `column(score) of signals` is that row's value. In a file with prices a row is a bar, and its columns end with it, as its close does. A file with no prices, a file of signals, holds dated values: a row ends at the end of the day it is dated (UTC), however far apart the rows are, or, when its rows are less than a day apart, at its time plus the shortest gap between them. So a row dated Tuesday is known at Tuesday's close, and an order it decides fills at Wednesday's open. With `fill: close`, a rule whose ticker keeps other hours than the file reads it one row early, as it reads any such ticker. A FRED series holds dated values in the same way, read by `of` and as a cash rate alike: each row is dated the day a value was first published and ends at the end of that day (UTC), so a monthly series is read from the day each month's value came out, not a month after it.

**Sizing and cash**

7. Equity is cash plus every position at its latest close. Money is in cash until a rule buys. Positions can hold fractions of a share. A short holds a negative number of shares (rule 67).
8. A buy of a ticker with weight w spends w times equity, valued at the open of the fill (at its close with `fill: close`), but never more than the cash available, with its costs and commission paid on top (rules 14 and 47). The rest stays in cash. With `entries`, each entry spends a part of it (rule 52). A block that can borrow spends its room instead of its cash (rule 70).
9. A position is sized once, when it is bought, and with `entries` each entry when it is bought. It then drifts with the price until it is sold or a rebalance resizes it.
10. With `weighting: inverse volatility(n)`, the tickers being held or bought share out the sum of their configured weights in proportion to 1 divided by their volatility, the standard deviation of the last n one-bar returns up to the last close before the fill (up to the fill's own close with `fill: close`). A ticker whose volatility is 0 keeps its configured weight.
11. With `risk per trade: r at m atr(n)`, the buy is for r times equity, divided by m times the ATR, shares. The ATR is its value at the close before the fill (at the fill's own close with `fill: close`). The value of the buy is capped at the ticker's weight, and the size is fixed at entry. The distance used for sizing is separate from any `stop loss` line.

**Warm-up**

12. A buy is not taken while an input it needs is still unknown at the close of the signal: the ATR for `risk per trade`, the volatility for `weighting: inverse volatility`, or the ATR of an ATR stop loss, trailing stop or take profit. The buy fills after the first later close at which the inputs are known and the buy rule still holds. In a `hold` strategy the ticker is skipped until the next decision.
13. The result notes how many buy signals each such input held back (signals on consecutive bars count once). It also notes when a buy rule or `hold` score was unknown for more than 5 bars at the start of the run, with the day it became known.

**Costs, slippage and interest**

14. `costs` is a percentage of the value of every fill: buys, sells, stops, targets and rebalancing trades. On a buy it is paid on top of the price; on a sell it comes out of the proceeds. A `commission` is charged as well (rules 46 to 50).
15. `slippage` makes each fill worse by that fraction: a buy fills at the price times (1 + slippage), a sell, including a stop or a target, at the price times (1 - slippage). Costs are charged on the slipped value.
16. Between two bars, cash earns the rate times the calendar days between them divided by 365, using the rate known at the earlier bar. With a ticker, the rate is the close of its latest bar that had ended by the end of the earlier bar (rule 6), read as a yearly percentage: a close of 4.2 is 4.2%. Before that ticker's first such bar cash earns nothing. Only cash earns interest. A block that can borrow earns it, and pays the margin rate, by rule 73 instead.

**Rebalancing**

17. With a `rebalance` other than `never`, each held ticker goes back to its target weight at the open of its own first bar in each new period, so a ticker that does not trade on the period's first day is rebalanced at its first bar after it. The weight is measured against equity at that open. Sells are made before buys. A rebalance resizes held positions only; it never opens one. Weeks start on Monday; months, quarters and years follow the calendar in UTC. With `fill: close` each held ticker goes back to its target weight at the close of its own last bar in each period instead, measured against equity at that close: the same close at which a ranking decides. A position built in entries goes back to its entries' part of its target weight (rule 53), and with a `commission` a trim or top-up too small for it is not made (rule 49).
18. When a ticker's top-up finds too little cash, for example because another ticker is trimmed only at its own first bar a day later, the rest stays wanted. It is bought at that ticker's later bars in the same period as cash comes in, and lapses when the period ends. With `fill: close` a top-up decided at a period's last close stays wanted at the ticker's closes in the next period, and lapses at its next rebalance. A position sold or stopped in the meantime is owed nothing, and so is a top-up left undone because it was too small for its commission (rule 49). A top-up only spends cash there is, so nothing is borrowed, unless the block can borrow: then it spends the room there is (rule 70).
19. Rebalancing trades are slipped and charged like any other. They change a position without closing it, so they are not listed as trades.
20. With inverse-volatility weighting, the weights are worked out again at each rebalance.

**Stops, targets and gaps**

21. Stops and targets are set when the position opens, from the fill price, slippage included. A stop loss is the fill price times (1 - x), or the fill price minus x ATR. A take profit is the fill price times (1 + x), or the fill price plus x ATR. Each later entry of a position built in entries sets them again from the average entry price (rule 55). A short's are mirrored (rule 72).
22. An ATR distance uses the ATR at the close before the fill (at the fill's own close with `fill: close`) and keeps it for the life of the position, later entries included. That ATR is always known, because a buy waits for it (rule 12).
23. The trailing level is the highest high since entry times (1 - x), or minus x ATR. It moves only at the end of a bar: a bar's high counts from the next bar on. Inside a bar looked inside with `magnify`, it moves at the end of each smaller bar (rule 60). On the entry bar it trails the open. With `fill: close` it starts from the close the position was bought at. With several entries it trails from the first: an add does not move it.
24. After the bar's open orders, each position is checked against the bar. If the low reaches the stop (the higher of the stop loss and the trailing level), it exits at the stop, or at the open if the bar opened below it. If the high reaches the take profit, it exits at the target, or at the open if the bar opened above it.
25. If both levels lie inside the bar, the stop is taken first, unless `magnify` looks inside the bar (rules 58 to 65). If the bar opens at or above the target, the target fills at the open, even if the bar later falls through the stop.
26. A position can be stopped out on the bar it is bought. With `fill: close` it cannot: it was bought at that bar's close, after the bar's range, so its stops and target watch it from its next bar on.
27. Within a bar, the order is: pending sells fill at the open; then the rebalance (with any top-up still owed) and pending buys and adds, sells first; then stops and targets; then, at the close, the rules are read for the next open. With `fill: close`: stops and targets; then, at the close, the rules are read and what they decide fills at once, sells first, then the rebalance (with any top-up still owed) and the buys and adds; then the positions are valued at that close. A block that can borrow checks for ruin before anything else at the open, then closes what a margin call called (rules 76 and 77), and at each fill makes every order that makes a position smaller before every one that makes one larger (rule 69).
28. A sell rule and the stops both apply, whichever comes first. A buy is skipped when the sell rule is also true at the same close, and so is an add. A short is skipped when the cover rule is true at the same close, and so is an add to a short (rule 68).

**Re-arming**

29. After an exit by stop loss, trailing stop or take profit, the buy rule has to be false, or unknown, at one close before it can buy that ticker again. After such an exit of a short, the short rule has to be false, or unknown, at one close before it can short the ticker again. Each side re-arms on its own, at any close where it is not held, so a long that was stopped out can turn short at once; a margin call makes both sides re-arm (rule 76). A sell-rule exit does not wait. In a `hold` strategy this rule does not apply: a stopped-out ticker can be chosen again at the next decision.

**Ranking (`hold`)**

30. With `hold: top N by score`, a decision is made at each close when `rebalance` is `never`, and otherwise at the last bar of each period. The tickers that can be chosen are those whose buy rule is true (every ticker if there is no buy rule), whose sell rule is not true, and whose score is known.
31. The N highest scores are chosen. Ties go to the ticker listed first. Held tickers not chosen are sold at their next open. Chosen tickers not held are bought once every sell of that decision has filled, at their own next open from then on: the same open as the last sell when both trade then. With `fill: close` the sells and buys fill at the decision's close; a ticker with no bar at that time trades at its next close, and the buys wait for its sell. A buy that has not filled stays wanted until it fills or the next decision replaces it, and a decision that keeps a ticker cancels a sell of it that has not filled. When cash is short, the best score is bought first. With `fill: close` and ranked tickers that keep different hours (rule 6), a decision made at a time when tickers on different hours have a bar reads every ticker's previous bar (its buy rule, sell rule and score) and fills at the decision's close; when only tickers on one set of hours have a bar, it reads their bars and the others' latest finished ones. A ticker read a bar early is still sold by its own sell rule at its close, and is not bought at a close where its sell rule holds.
32. Between decisions, a sell rule or a stop can still exit a position. The freed slot waits for the next decision. Each ticker held gets `size` divided by N.

**Unknown values**

33. A value is unknown while an indicator is still warming up, when you look back past the start of the data, when a ticker read with `of` has no bar that has ended yet (or a file of signals no row that has: rule 6), when a cell of a CSV column is empty or holds no number, after a division by 0, and when `crosses` needs a previous bar that is unknown. `count`, and so `for n bars` and `within n bars`, is unknown until n bars have been read and while any of them is unknown. `between` is unknown when any of its three values is. `bars_since` is unknown until its condition has been true. `month_start` and the other `_start` values are unknown on the first bar of the data, and `trading_day` through its first month. `streak` is unknown on the first bar and after an unknown value, until the next change that is known. `sqrt` of a number below 0, `log` of 0 or less and `exp` of a number too large to hold are unknown, `efficiency` and `rsquared` over a window where nothing changes are unknown, and so is `cmf` while none of its bars traded. `if(condition, a, b)` is unknown where its condition is, and otherwise only the value it picks counts.
34. A comparison with an unknown value is unknown. `and` is false if either side is false, and otherwise unknown if either side is unknown. `or` is true if either side is true, and otherwise unknown if either side is unknown. `not` of unknown is unknown.
35. A rule only fires when it is true. Unknown never buys or sells, and counts as "not holding" for the re-arm rule.

**Benchmark, statistics and the split**

36. The benchmark holds the same weights as the strategy (or the one ticker you name) from the first open the strategy could have bought at (the first close with `fill: close`), with the same costs, commission, slippage, fills, rebalancing and cash rate, and no rules, stops or entries in steps. A `hold` strategy is compared with holding every ticker in equal parts of the same total size. Weights that add up to more than 100% are scaled down to 100%, and a ticker the strategy shorts is held long (rule 79).
37. A benchmark whose prices start after the run does is measured from its own first bar. Before then it has no value, its line starts there, and its figures, and those of each `test from` part, cover only its own dates. The result notes it when the benchmark starts more than 7 days after the run.
38. Return per year is the compound growth rate over the time the run covers, in years of 365.25 days. Worst drawdown is the lowest value of equity divided by its highest previous value, minus 1, at the closes.
39. Sharpe ratio: for each step, take the return of equity minus what cash earned over the same step. Divide the mean of those by their standard deviation (dividing by the count, not by the count minus 1), and multiply by the square root of the steps in a year, where steps a year is the number of steps divided by the years covered. It is not scaled with 252. The benchmark's Sharpe ratio is worked out the same way.
40. The Sortino ratio takes the same returns above cash and divides their mean by their downside deviation: the square root of the mean, over every step, of the squared returns below 0 (a step at or above 0 counts as 0). It is scaled the same way, and is the same figure in the parameter sweep and under "More figures".
41. A Sharpe or Sortino ratio is 0 when the deviation it divides by is below 1e-12 a step. That is rounding noise, not risk: a run that only earns a fixed cash rate would otherwise show a ratio made of noise, such as -3.42.
42. Volatility is the standard deviation of the one-step returns times the same square root. "Time invested" is the average share of equity held in positions at the closes. For a block that can borrow it is "Exposure" instead (rule 67).
43. The trade count and the share won count closed trades only. A trade is won when its return after costs is above 0. A position still open at the end is not sold in the run: equity values it at the last close, and it is listed as "still held". Its return counts the exit cost, and the commission, as if it were sold at that close, without slippage. A position built in several entries is one trade.
44. A trade's return is its sell price times (1 - costs) over its buy price times (1 + costs), minus 1, with slippage in both prices. With several entries the buy price is their average, weighted by the shares each bought. With a `commission`, the sell price first loses the exit's commission divided by the shares sold, and the buy price gains the entries' commission divided by the shares they bought. Its profit is cash in and out of that ticker, rebalancing trades and commission included. A short's return is in rule 75.
45. `test from` splits one run in two, at that date. It is not a second run: nothing is reset or re-fitted, and a position open at the date carries over. Each part is measured from the last close before it, so the second part includes the move into its first day and the two parts' growth multiplies to the whole run's. A trade belongs to the part in which it was bought.

**Commission**

46. `commission` is charged on every order, as well as `costs`: each fill of a buy, a sell, a stop or target exit, a rebalancing trim or top-up, a ranking trade and an entry. A fixed commission is charged once for an order. A per-share one is the fee times the shares, a fraction of a share counting as that fraction; `min` raises it to at least that much for an order, and `max` then caps it at that share of the order's value, so an order too small for the minimum pays the cap instead.
47. On a buy the commission is paid on top, like `costs`: the buy is cut so that its value, costs and commission together fit in the cash there is (in the room, for a block that can borrow: rule 70). When the cash cannot pay the commission, nothing is bought. What the buy wanted, its weight or its risk, is unchanged; only the cut to the cash is larger.
48. On a sale the commission comes out of the proceeds, and then out of cash. It never takes cash below 0: a position worth less than its commission is sold for what it brings in and the cash there is. A block that is borrowing pays the whole commission (rule 74).
49. An add (rule 51), a rebalancing trim or a top-up is not made when its commission would be 10% of its value or more, the ceiling the language puts on `costs`. These trades only adjust a position, and with a fixed charge the smallest of them can cost more than they move, such as topping up the few cents of interest that cash earned. A buy that opens a position and a sale that closes one are always made. The result notes how many trades were left undone.
50. The benchmark pays the same commission (rule 36). The costs paid, under the chart, include the commission and say how much of them it was.

**Building a position in entries**

51. With `entries: n`, a position is built in up to n entries. The buy rule or a ranking makes the first; the `add when` rule makes each later one. The add rule is read at each close of a ticker held with fewer than n entries, after the sell rule, and its order fills like a buy: at the ticker's next open, or with `fill: close` at that same close. It makes at most one entry a close, and none at a close where the sell rule holds. With `entries` above 1, a ticker with no add rule is an error, and so is an add rule without an `entries` line.
52. Each entry spends 1/n of what one buy of the whole position would spend at that fill (rules 8, 10 and 11): the weight, or its inverse-volatility share, times equity, or the risk-per-trade amount capped at the weight. An add is cut so the position is worth at most that whole amount after it, and like every buy it is cut to the cash there is, or for a block that can borrow to its room (rule 70). So the entries never take a ticker above its weight, nor the strategy above 100% invested, or above its cap for a block that can borrow. An add with nothing left to buy is not made and does not count.
53. A rebalance takes a position with k of its n entries to k/n of its target weight; it never makes an entry. When a rebalance and an add fall on the same fill, the add is sized against what the position is worth once the rebalance's trades are made. A trim left undone for its commission (rule 49) leaves the position as it is. A top-up that buys less than it wanted, for lack of cash or for its commission, leaves the add sized from the position as it then is. A top-up still owed (rule 18) that finds the position at or above its target buys nothing. With `hold`, the ranking makes the first entry and the add rule the others, at any close: a decision that keeps a ticker does not add to it, and one that drops it sells it whole. When cash is short, adds are paid for along with the buys: in ranking order with `hold`, and in the order of the universe without it.
54. In sell and add rules, `bars held` counts from the first entry's fill, `entry price` is the average fill price of the entries weighted by their shares, `last entry price` is the fill price of the latest entry, and `entries made` is the number of entries. `highest since entry` and `lowest since entry` read the bars from the first entry's fill, whatever is added after it, and `position return` uses the average entry price. Rebalancing changes none of them.
55. Each entry sets the stop loss and take profit again from the new average entry price: the average times (1 - x) or (1 + x), or minus or plus the ATR distance set at the first entry (rule 22). The trailing stop keeps trailing from the first entry (rule 23). The new shares are watched by the stops from the bar they were bought at, or with `fill: close` from the next bar, as a buy is (rule 26).
56. The sell rule, a stop, a target and a ranking sell the whole position. There are no partial sales.
57. A position is one trade from its first entry to its sale: its entry price is the average of its entries, its bars held count from the first, and the trade count and share won count it once. An add left waiting at the last bar is reported like a buy, and "Today's orders" lists it as "Add SPY", with "Step 2 of 3". It is not reported when the position is already worth its whole weight at the last close, as there is no room for it. One that only the cash stands in the way of is reported, as a buy is, since the sales and trims at that open are paid out first.

**Looking inside bars (`magnify`)**

58. `magnify: 1h` follows the stops and targets of each Yahoo or Binance ticker in the universe through the 1h bars inside the strategy's own bars. It changes nothing else: rules are read at the closes of the strategy's own bars, and buys, sells, adds, ranking decisions and rebalancing fill where they would without it (rule 27). Indicators, `of`, ATR distances and sizing never read the smaller bars. The size must be shorter than `interval` and divide it evenly, and the ticker's source must give it (see the setting). A CSV or Tiingo ticker is read whole.
59. A bar is looked inside when a position is held in it after the orders at its open (so a position bought or added to at that open counts, with the levels it set), the bar opens above the stop and below the target, and its high reaches the target or its low reaches the stop at the highest the trailing level could rise to within the bar (from the bar's high). Any other bar comes out the same either way, and is read whole as in rules 24 and 25.
60. Inside, the smaller bars are read one after another, each by rules 24 and 25: when a smaller bar's low reaches the stop it exits at the stop, or at that smaller bar's open if it opened below it; when its high reaches the target it exits at the target, or at its open if it opened above it; when both lie inside one smaller bar, the stop is taken first. The trailing level moves at the end of each smaller bar with its high, so a high counts from the next smaller bar on. The exit belongs to the bar: it is dated with it, and pays slippage, costs and commission as any exit.
61. A bar's smaller bars are those that start within it, from its start to its start plus `interval`. On Binance a bar must have all of them, such as 24 one-hour bars in a day. Yahoo's intraday bars are read on the exchange's clock, as its daily bars are dated by the exchange's day, and a day's bars are kept only when they cover that day's regular session, as Yahoo's answer gives it, from its open to its close, one after another, each a whole bar. A day with a gap is left out, and so is a day that closes early whose last bar Yahoo leaves empty.
62. The smaller bars must match the bar. Each of the bar's open, high, low and close is divided by the smaller bars' first open, highest high, lowest low and last close. The smaller bars are scaled by the square root of the smallest of the four ratios times the largest, and the four prices scaled must each lie within a quarter of the bar's range (high minus low) of the bar's own. One factor is right for a whole bar: Yahoo adjusts its daily prices for splits and dividends and its intraday prices for splits only, and an adjustment changes only between one day and the next. Then the bar's own prices go where the smaller bars put them: the first smaller bar opens at the bar's open, the first one with the highest high reaches the bar's high, the first with the lowest low the bar's low, and every other price is kept within the bar's range. So nothing fills at a price the bar did not reach, and only the order comes from the smaller bars.
63. A bar of rule 59 whose smaller bars are not there, are not all there or do not match is read whole, and so is every bar before a ticker's smaller bars start. The notes say from which bar each ticker was looked inside and why not earlier, how many bars with a level inside them were looked inside, and how many in that time were read whole.
64. Smaller bars are loaded from the run's first day, or from the earliest the source gives them if that is later, counted back from the start of the current day in UTC; no history before the run is loaded for them, since nothing is held there. Yahoo gives 2m to 30m bars for the last 60 days and 1h bars for the last 730, of which the last 59 and 729 days are loaded, and its daily bars as far back as its weekly ones. Binance gives every size from the market's start, and at most 100,000 are loaded for a ticker: 69 days of 1m bars, 347 days of 5m bars, 2.9 years of 15m bars or 11.4 years of 1h bars. They are saved like other prices, Binance's in a file of their own kept to that count, and count as bars toward the size of a run.
65. With `fill: close`, a position bought at a close is watched from its next bar (rule 26), which is looked inside as any. A position built in `entries` is followed with its levels as its entries set them, so an add filled at an open moves the stop loss and the take profit for the rest of that bar (rule 55). A universe of stocks and crypto looks inside each ticker with its own source's bars, from its own first day of them.

**Shorts and leverage**

66. A block can borrow when it has a short or cover rule, or when its weights, or with `hold` its `size`, add up to more than 100%. Rules 67 to 79 are about such a block. Any other block runs by rules 1 to 65 alone.
67. A short holds a negative number of shares, so at a close it counts against equity by its shares times the close. The gross value of the positions is the value of the longs plus that of the shorts, and the net value the first less the second. For a block that can borrow, the figure "Time invested" (rule 42) becomes "Exposure": the average of the gross value over equity at the closes, with the net under it. Without shorts, gross and net are the same number, which for a block that cannot borrow is its "Time invested".
68. At a close, a ticker not held goes long when its buy rule holds and its sell rule does not, and short when its short rule holds and its cover rule does not, each only once its side is re-armed (rule 29) and its inputs are known (rule 12). When both would happen, neither does, and the bar is counted for the result's note. A ticker held long is closed by its sell rule, or by its short rule whatever its cover rule says; one held short by its cover rule, or by its buy rule whatever its sell rule says. The bar is then read again as if the ticker were not held: the other side opens at the same fill when its entry holds and the closed side's entry does not, a flip, and when both hold neither opens and the bar is counted. An exit rule read while the ticker is not held, to hold back an entry, reads no position, so a comparison with `bars held` or another position value in it is unknown there. The add rule adds to whichever side is held, and not at a close where that side is closed. With `hold` there are no short rules.
69. At a fill, every order that makes a position smaller goes first: sells, covers, the closing half of a flip and rebalancing trims of either side. Every order that makes one larger follows: entries, the opening half of a flip, top-ups, top-ups still owed and adds. So a flip is two fills at the same open, or with `fill: close` at the same close, where the new position is watched by its stops from the next bar (rule 26).
70. A buy or a short sale at a fill may use the room there is: cash − 2 × S + (L − 1) × E, where S is the value of the shorts and E the equity, both at the prices of the fill (a ticker's open, or with `fill: close` its close, and the last close of a ticker with no bar there), and L is the cap: the block's weights' total, or its `size` with `hold`, but at least 1 and at most 2. The room is what takes the gross value to L times equity, and with no shorts and L = 1 it is the cash, as in rule 8. The costs and the commission of the order are paid out of it (rule 47). Sells and covers are never held back by it, and positions can drift above the cap as prices move: only a margin call (rule 76) closes them by force.
71. A short is sized as a buy is: its weight, or its inverse-volatility share, times equity is the value of the sale at the price less slippage (rules 8 and 10). With `risk per trade: r at m atr(n)`, the sale is r times equity divided by m times the ATR, in shares, capped at the weight, so that a rise of m ATRs loses r of equity (rule 11). With `entries`, each entry of a short is a step of it (rule 52). A rebalance takes a short back to its target by its value: a short whose price rose is trimmed by buying some back, one whose price fell is topped up by selling more, within the room; what the room cannot pay stays owed as in rule 18.
72. A short's stops and target are a long's turned upside down (rules 21 to 25). The stop loss is the fill price times (1 + x), or plus x ATR; the take profit the fill price times (1 − x), or minus x ATR; the trailing level the lowest low since entry times (1 + x), or plus x ATR, which starts from the open on the entry bar, or with `fill: close` from the close the short was sold at. A bar whose high reaches the stop exits at the stop, or at the open if the bar opened above it. A bar whose low reaches the target exits at the target, or at the open if it opened below it, even when the bar later rises through the stop. When both levels lie inside the bar the stop is taken first, unless `magnify` looks inside it (rules 58 to 65). A percentage take profit of 100% or more is never reached, and the parser notes it.
73. Between two bars, the balance B, the cash less the value of the shorts at the earlier bar's closes, earns the cash rate when it is above 0 (rule 16), and pays the margin rate when it is below 0, for the calendar days between the bars divided by 365. So what a short sale brings in earns nothing of its own, and money borrowed to hold more than the equity pays the margin rate. Each short also pays its borrow fee: its shares times its last close, times the fee, times the days between the bars divided by 365. The fee is part of the trade's profit and return (rule 75), not of the costs paid under the chart. The result notes the total of the borrow fees and of the interest paid, and how many margin calls there were.
74. A sale made while the block is borrowing, with cash below 0 or a short open, pays its whole commission even when that takes cash further below 0, where rule 48 would cap it. A short sale pays its costs and commission out of what it brings in, and buying a short back pays them on top, whatever the cash.
75. A short trade's return is (e × (1 − c) − m − x × (1 + c) − n − b) ÷ (e × (1 − c) − m), where e is the price it was sold at and x the price it was bought back at, slippage included in both, c is `costs`, m is the entries' commission divided by the shares they sold, n the exit's commission divided by the shares bought back, and b the borrow fees paid per share. With several entries e is their average price. A short still open at the end is valued at the last close, and its return counts buying it back there without slippage (rule 43). Its profit is the cash in and out of that ticker, borrow fees included.
76. At each close, once what `fill: close` fills there is filled, when equity is below 25% of the gross value of the positions, a margin call is made: every position is closed at its ticker's next open, before anything else there, also with `fill: close`. Orders waiting are cancelled, top-ups still owed lapse, and both sides of every ticker must re-arm (rule 29). No new call is made while the positions of one wait for their open. These exits are "margin call".
77. At each open, before a margin call's exits, at each close after the stops and before the rules are read, and at each close once its fills are made, equity is measured at the prices of that moment: the open of a ticker with a bar then, otherwise its last close. When it is below 0, or 0 with a position open, the run is ruined: every position is closed there, with slippage, costs and commission, and the run stops. Nothing is traded after it, no interest or fee is paid or earned, and equity and exposure are 0 at every later close. These exits are "ruin", and the result says when it happened and what the account still owed: the cash below 0 once everything was closed.
78. A ruined run's total return and return per year are −100%, and so is its worst drawdown. Its Sharpe ratio, Sortino ratio and volatility, and the returns of its years and months, count only the steps up to the ruin.
79. The benchmark buys and holds the block's tickers, long whatever side the strategy trades them on (rule 36). When their weights, or with `hold` its `size`, add up to more than 100%, they are scaled down to add up to 100%, so the benchmark never borrows.

## Reading a result

From the top:

1. **Title.** The `name` (or "Backtest"), on a button that folds the result to one line (see "Folding a result"). Beside it, what the run holds now ("Long SPY since 2026-04-09", "Holds 3 of 9", "In cash"), and, when a rule is close to giving an order, a mark that says how close: "0.33% from a sell", with several tickers "SPY 0.33% from a sell", or "Sells at an unchanged close" when the last close would already give it. It counts as close within 2% of the last close (see "Trigger prices"), and appears once those prices are worked out. At the far end, a button that fetches the prices again and runs the block again ("Refresh prices").
2. **Summary.** A line of what was run: tickers and weights, sizing, the number of entries, rebalancing, bar size, costs, commission, slippage, stops, and parameter values. Percentages are written as the block writes them (`12%`, not `12.0%`), and a parameter that is a stop is shown once, as the stop.
3. **The strategy as written**, coloured. Its settings, the lines the summary already says in words, are folded away; "Show the whole block" shows them, and "Fold the settings" hides them again. Settings under a `for` line are a ticker's own and stay in view, and so do parameters and rules.
4. **Parameters.** Only when the strategy declares parameters: a bar with a slider for each one (see "The Parameters bar").
5. **Notes.** What the run has to say, one line each:
   - prices that could not be refreshed (see "Prices and privacy"), and Tiingo standing in for Yahoo;
   - how many values of a FRED series came in a backfill and how they were dated (see "Where prices come from");
   - buy signals held back while a sizing or stop input warmed up, and a buy rule or `hold` score still unknown at the start of the run;
   - adds and rebalancing trades left undone because their commission would have been too large a part of them (rule 49);
   - for a block that can borrow, each only when there is one: the borrow fees for shorts ("Borrow fees for shorts: $123."), the interest on borrowed money ("Interest on borrowed money: $456."), the margin calls ("2 margin calls: equity fell below 25% of the positions' value, and every position was closed at the next open."), a ruin ("Ruined on 2022-03-04: equity fell to zero and the run stopped there; the account owed $1,000 more.") and the bars where the buy and short rules both held ("Buy and short rules both held on 12 bars, so neither opened a position.");
   - with `fill: close`, that the run assumes you can trade at the close the rule read, and which other tickers a rule read a bar early or took as known at the fill (a CSV file whose columns are read says this in its own note);
   - with `magnify`, from which day each ticker was looked inside and why not earlier, how many bars with a stop or target inside them were looked inside, and how many were read whole because their smaller bars were missing or did not match;
   - when a rule reads a column of a CSV file, how its rows must be dated, and with `fill: close` which row an order at a close rests on (see "Signals from a CSV file");
   - a benchmark whose prices start later, and a warning when the run starts more than 7 days after `from`;
   - the parser's notes, with their line number.
6. **The verdict.** A sentence that sets the strategy's return per year against the benchmark's and its worst fall against the benchmark's: "7.2% a year against 10.6% for buy and hold — but its worst fall was 24%, not 55%." The strategy's figures are underlined in its colour and the benchmark's in its own. The words follow the figures: "— but" when one is better and the other worse, "and its worst fall was deeper" when both are worse, "the same as" for the same return. A run whose rules never opened a position says "No rule opened a position, so the money stayed in cash." and what the benchmark made over the same time, and a ruined run says when it was ruined. A smaller sentence under it compares the Sharpe ratios ("A slightly higher Sharpe ratio, 0.66 against 0.63", "slightly" for a difference under 0.1), says how much of the time the run was in the market, or for a block that can borrow its average gross and net exposure, and, for a run of two whole calendar years or more, in how many of them it beat the benchmark. When it beat it in 4 years or fewer and the benchmark fell in each of them, it names them: "It beat buy and hold only in falling years: 2008, 2018 and 2022."
7. **The figures.** One row each for return per year, total return, worst drawdown, Sharpe ratio and volatility, then "Time invested" or, for a block that can borrow, "Exposure, gross" with the net under it (rule 67). Each row gives the strategy's figure, a dot for each on a line between them, the benchmark's figure and the difference ("3.3 pts lower", "30.7 pts shallower", "0.03 higher"). Each row's line runs from 0, which is marked, past both figures, so the gap between the dots reads against their size. Then "Trades": the count of closed trades, how many were won and the average return; it says "none closed yet" when only open positions exist, and "no rule opened a position" when there were none. "More figures" adds rows for the Sortino ratio, return per year divided by worst drawdown, best and worst year, the share of months with a gain, the longest time below a previous high, and best and worst month, the best and worst with the year or month they came in, and the longest time below a high with "still below" when it had not got back by the end. The Sortino ratio here takes off what cash earned, like the Sharpe ratio, and is the same figure as in the parameter sweep (rule 40 under "How the simulation works"). A benchmark whose prices start later is measured from its first value. Under the figures, once the block has had more than one try, a line gives the count and the chance that the Sharpe ratio reflects a real edge (see "How many tries").
8. **The chart.** The strategy and the benchmark on a log scale, each line ending in its last value. The space between them is shaded in the colour of whichever is ahead. The market falls the run covers (see "Regimes and crises" below) are shaded behind both panels and named where there is room. Under the lines, a strip shows the time held: solid where the run held positions, fainter where it held part of its money, and hatched where it was short. Underneath, the drawdown from the previous high, with the worst of each marked. Above the chart, a line reads the last bar: its date, each value and how far it is below its high, and how much was invested ("100% invested", "In cash", for a block that can borrow "Exposure 146% gross, net 146%"). Move across the chart, or touch it, and the line reads that bar instead, and names the market fall it lies in. Buttons on the right show the last 10 years, 5 years or year alone; each is offered only when the run is clearly longer. The span you pick stays when a slider draws another run. A benchmark whose prices start later is drawn from its first value, and reads "–" before it. With `test from`, the test period is shaded and labelled. A ruined run's line ends at its last close before the ruin, and reads "ruined" after it.
9. **Before and after the test date**, only with `test from`. A table of return per year (strategy and benchmark), worst drawdown, Sharpe ratio and trades, for each part.
10. **At the next close.** What the run holds now, with an open trade's return so far, and at what close of the next bar its rules would give an order (see "Trigger prices"). With one ticker it is a sentence, "Sells if it closes below 730.03 (−0.3%), at the following open.", and a scale of the closes searched: the closes that give the order shaded and named ("sells here"), each edge marked with the price the sentence gives, the last close as a dot, and a held ticker's stop and target where they fall on it. A flip, such as a sell and a short sale at the same closes, shares one scale ("sells and shorts here"). With several tickers the sentence names the order nearest to being given, within 2% of the last close, or says no rule is that close, and a table follows with one row for each ticker: its weight, whether you are long or short since a date ("Short since 2026-04-09") or in cash (with `entries`, how many entries the position has, such as "2 of 3 entries"), whether an order is waiting (for the next open, or with `fill: close` for the next close) or was made at the last close, at what close of the next bar its rules would give an order ("Next close"), the closed trades, the share won and the average trade. A run with a `to` date has no next close: the panel is headed "At the end of the run" and says what it held then.
11. **The sections, as tabs.** Each opens under the tabs, one at a time; click an open one to close it. The first four have a line under their name of what is in them: "67 closed · 30% won", "ahead in 3 of 21", "up in 57%", "better in 7 of 7 falls". The rest are in a row after them, "Look deeper". The left and right arrow keys move along a row of tabs. A section is built the first time it opens, and the tab you had open stays open when a slider draws another run.
12. **Trades.** A sentence first: how many closed trades were won, what winners and losers made on average, and, with 10 closed trades or more, what the five best made against all of them together. Then every closed trade's return as a bar, from the worst to the best; point at one to read its ticker, dates, bars held, return and profit, and click it to find it in the list (one older than the latest 500 says it is not in the list). The list is newest first: a button, ticker, bought, price, sold, price, return after costs, profit and how it ended: "sell rule", "stop loss", "trailing stop", "take profit" or "still held", and for a short "cover rule". A position closed by the other side's entry ends with "flipped to short" or "flipped to long", and one closed by force with "margin call" or "ruin". When the run has a short trade, a "Side" column says "Long" or "Short", the dates are headed "Opened" and "Closed", and a short's first date and price are its sale and the second its buy-back. It shows the latest 500 trades. Intraday times are in UTC. A position bought in several entries is one row: its bought date is the first entry's, followed by the number of entries ("2024-03-01, 3 entries"), and its price is their average. The button at the start of each row, "Explain this trade", says why the trade happened (see "Explaining a trade").
13. **Years.** In how many whole calendar years the strategy was ahead of the benchmark, level (within 0.05 points) and behind, and, when every year it was ahead the benchmark fell, that too. Then a bar for each year: the strategy's return less the benchmark's, above the line when the strategy was ahead. Point at a year to compare the two returns. Years the data only partly covers are faded and are not counted.
14. **Months.** The share of months with a gain, and the best and worst month. Then a grid, a row for each year and a column for each month, each cell shaded by the month's return, and the year's return at the end of the row. Point at a month to read its return. A month with no change is outlined, most often from being in cash. A year the data only partly covers has its return in a lighter type.
15. **Regimes and crises.** In two parts:
   - *Market falls.* Each fall of the market from its closing high to its closing low that the run covers in full: the S&P 500's 2000-03-24 to 2002-10-09, 2007-10-09 to 2009-03-09, 2011-04-29 to 2011-10-03, 2015-05-21 to 2016-02-11, 2018-09-20 to 2018-12-24, 2020-02-19 to 2020-03-23, 2022-01-03 to 2022-10-12 and 2025-02-19 to 2025-04-08, and for a strategy with a Binance ticker Bitcoin's 2017-12-16 to 2018-12-15 and 2021-11-08 to 2022-11-21. A sentence says in how many the strategy did better than the benchmark, by more than 0.05 points as the Years tab counts it, and, when it did better in all of them, names the one it beat by the least if that was under a point. For each fall: its dates, the strategy's return and the benchmark's from the close of the peak day to the close of the trough day, on a line with a dot for each, all on one scale, the worst fall within that time, the average share of equity held at its closes, and the day the strategy's value got back to the highest it had reached before the fall began ("Never below it" when it did not fall below that, "Not by the end" when it had not got back by the run's last bar). A run covers a fall when a bar of it had ended by the close of the peak day and its last bar is on the trough day or later. With weekly or hourly bars the figures are taken at the last bar that had ended by each of those closes, which for a daily run is the bar of that day. A run that covers none of the falls says so. This part needs no prices besides the run's own, and is drawn at once.
   - *By market state.* How the strategy did while the market was in each of a few states: SPY above or below its 200-day average, the VIX at 20 or higher or under 20, and the 10-year yield (`^TNX`) above or below its close 126 trading days earlier. A strategy that trades only on Binance gets Bitcoin's states instead: `BTCUSDT` above or below its 200-day average, and its volatility (the standard deviation of its last 30 daily returns) above or below the median of that over the last 365 days. A strategy that mixes Yahoo and Binance tickers, or reads only CSV files, gets the stock market's.

   Each state is worked out with the rule language on its own ticker's daily bars, as `close > sma(200)`, `close >= 20` and `close > close[126]`, so a close equal to its average counts as below it, and a VIX of exactly 20 as 20 or higher. A bar of the run takes the latest daily bar that had ended when its own bar ended, as `of` does (rule 6 under "How the simulation works"), so a weekly or hourly strategy is put in the same states a daily one would be. The step from one close to the next is put in the state known at the first, so a state is never read from the step it is judged by. A state is unknown until its ticker has enough bars, and `^TNX`'s also for 126 bars after a jump of more than threefold between two closes, which is how a series quoted in other units shows. Those steps are listed as "Not known yet". For each state the table gives its share of the run's steps, the strategy's return compounded over them (per year once they add up to a year or more, otherwise the total, and each says which), the benchmark's over the same steps (steps where the benchmark has no value are left out), the average share of equity held, long and short together, and the worst fall within one unbroken stretch in the state, counting the value where the stretch began as a high.

   The market's prices are not part of the run and are not fetched with it. The part for market states shows a button, "Load SPY, ^VIX, ^TNX from Yahoo" (for Bitcoin, "Load BTCUSDT from Binance"), and fetches them only when you press it. When they are already saved and still fresh (see "What is saved on disk"), it reads them from the saved files and shows the table without a button. They are saved like any other prices, with the history the rules need before the run's first day, and the same block gives the same result whether or not they were ever loaded.
16. **Prices and trades.** The price of one ticker with the periods you held it shaded, and a marker for each buy and sell. A short is shaded too, apart from a long ("Held short" in the key), and marked where it was sold short and where it was bought to cover. A position bought in several entries has a buy marker for each entry, at its fill price; the tooltip says how many entries it had, the first one's day and their average price. With more than one ticker there is one button for each, or a list when there are more than 12. Above it: the number of trades, the share of the time held, and what holding it throughout returned. When there are too many trades to mark at the chart's width, only the shaded bands are drawn.
17. **Rule values, bar by bar.** A table of what every part of the rules said at each bar and what the run did there (see "Rule values, bar by bar").
18. **Try other parameter values.** Shown when a parameter is declared with a range, such as `fast = 50 in 20..100 step 10`. A button runs every combination of the ranges, up to 2,000 combinations. Then it shows a chart for one ranged parameter, or a heatmap for two. They show where the values written in the note rank among all the variants, the median variant, and whether the best variant's neighbours do similarly well. With `test from` set, the view starts on the period before the date, the best variant is chosen on that period, and its result after the date is shown. The line under the reading says which period chose the best values ("Best before 2015-01-01: fast = 40, slow = 250"). If you switch the view to the whole run or to the period after the date, that line no longer suggests values, because values picked there have seen the test period and their later result would not be a fair test. To put a variant's values into the block, click or tap its point on the chart, its cell in the heatmap, or its row in the table of best variants, then press "Use these values in the block". The best variant has the same button, except on a view that includes the test period. It writes the numbers the way "Write these values to the block" does (see "The Parameters bar"). The button is off while it writes, and the line next to it says "Done: the block now uses these values." only once the write has happened. If the note has changed since the result was drawn, nothing is written and the line says so. Nothing is written to the note unless you press the button. Under it all, "How often the best fell back" says how often the best variant on one half of the history did worse than most on the other half (see "The overfitting check of a sweep").
19. **Was it luck?** First *How many tries*, which needs no extra run: how many sets of rules and values of the block have been run, and the chance that the Sharpe ratio shown reflects a real edge once they are allowed for (see "How many tries"). Then a button that runs three checks. *Reshuffled history* resamples the run's returns in blocks, to give a range for return per year and for worst drawdown. It shows how much the path and the drawdown depended on the order of the returns; it says nothing about whether the average return will persist, because every version is made from the run's own returns. *Random entries* makes the same number and length of trades at random times, to see how often random timing does as well, with the strategy's costs, commission and slippage. A position built in `entries` keeps how many it made and puts the later ones the same number of bars after its first. For a `hold` strategy this check is *Random picks*: it runs the strategy's rules, stops and add rule but ranks the tickers they allow at random. *Walk-forward* runs only when a parameter has a range: it picks the best values on a training window, applies them to the next unseen window, and repeats. Each window is measured from the last close before it, so the test windows' growth multiplies to the line's. When a slider under "Parameters" has moved, the checks test the run shown, with the slider's values, and a line above them says so ("These checks test the run shown, with fast 25. The block says fast 10."); walk-forward then draws "Values shown" instead of "Values in the note". "Try other parameter values" always ranks the values written in the block.
20. **Versions.** Each version of the block's text that was run, newest first, with its figures and what changed (see "Versions").
21. **Save buttons.** "Save trades as CSV", "Save value history as CSV" and "Keep this result as a note" (see "Saving results").
22. **A short note.** The dates, the starting money, "A rule seen at a close fills at the next open." (with `fill: close`: "A rule seen at a close fills at that close."), with `magnify` "A bar with a stop or target inside it is followed through its 1h bars, where it has them.", costs paid with the commission in them ("Costs paid: $812.40, of which $96.00 commission."), and interest earned on cash. Then "Prices through" a date, from Yahoo, Binance, Tiingo or your CSV files.

Every backtest runs in the background, so the note stays usable while it runs: a block's own run, its sliders, the strategy preview, a `compare` block, a `forward` block, "Today's orders", the count in the status bar and a `backtests` block. These runs have a background worker of their own, so they never wait for a sweep, and the runs of blocks on screen go before those of the vault's scans. The variants and the checks run in a second worker. A bar shows how far they have got, and "Stop" ends them at once. A stopped sweep shows the variants it had finished, and a stopped check says it stopped; "Run checks again" runs them again. When several blocks run checks at once they take turns, and a block that waits says "Waiting for another run to finish…". A worker that has not started after 5 seconds is ended and its run happens in the foreground; the next run tries a new one. Where Obsidian cannot start a background worker (one fails to start, or two in a row are that slow), everything runs in the foreground, and Obsidian does not respond while a backtest runs (see "When a backtest is too large"); the variants and checks then run a few backtests at a time between repaints.

A result is kept in memory (the latest 40, and no more than about 100 MB of them), with its trigger prices once they are worked out, so scrolling or switching views does not run it again. It runs again when the block's text or the plugin's defaults change, when the modified time of a CSV file it reads changes (or the file goes missing), when the prices it was worked out from are older than the "Keep saved prices for" time, or when you press Refresh prices. Prices a failed download left on their saved copy count from when the result was worked out, so a result made offline is not run again at every drawing. "Refresh prices" in the orders window and "Run again" under a `backtests` block count prices as fresh only from when they began, so they reuse no result worked out from older ones, even one that finished after they began.

A result on screen keeps the defaults it was worked out with, including its sliders, sweep and checks. When you change a default setting that shapes it (starting money, costs, slippage, commission, interest on cash, where plain tickers come from, and for a block that can borrow the interest on borrowed money, and for one that shorts the borrow fee), the block says "The default settings were changed after this result was worked out. It still has the old ones." with a "Run again" button. A block that writes all of these itself says nothing.

### Folding a result

The title is a button. Click it to fold the result to one line, and click again to open it. The line shows the strategy's name, a small chart of the strategy's value against the benchmark's over the run, return per year, worst drawdown, what it holds now ("Long SPY since 2026-03-02", with `entries` "Long SPY since 2026-03-02, 2 of 3 entries", "Holds 2 of 5" or "In cash", and a short in the same words with "Short", and for several with shorts among them "Short 2 of 5" or "Long 2, short 1 of 5") and any order waiting or made at the last close ("buys TLT at the next open", "adds to SPY at the next open", for a flip "sells A and sells short A", and after a margin call "margin call: sells A at the next open"), and how near a rule is to giving an order, as the title says it open. A strategy with no name shows its tickers after "Backtest". A small mark says how many notes the result has. The chart, the tables and the sections are drawn only when the block is first opened.

The setting "How results first appear" decides how a block starts: Full (the default) opens it, Compact folds it. Obsidian draws a block again when you scroll or switch views, and the block comes back the way you left it for the rest of the session. A named block is remembered by its name, and an unnamed one by its place in the note. A block that can't run always shows in full, with its problems.

### The Parameters bar

A strategy that declares parameters gets a "Parameters" bar under its text, with a slider for each parameter and its value in the block's own form (`50`, `8%`). With a range, the slider follows it (`in 20..100 step 10`). Without one, it runs from about half to double the value, in whole steps for whole numbers, and is cut back to values the language accepts: for `n = 2` in `zscore(n)` it starts at 2, not 1, and for `entries: n` it stops at 10.

- Drag a slider, or use the arrow keys, and the strategy runs again with that value on the prices already loaded. While you drag, the figures, the key and the main chart follow and the rest of the result dims. When you let go, the whole result is drawn again; the tab you had open, and the span of the chart, stay as they were.
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
- **The columns.** The date (with the time, in UTC, on short bars) and the close, then "What happened" and "Position", so they are in view before the rule columns. The date stays in view when the table is scrolled sideways. Then one column for each part of the buy rule, headed with your own text, with the two values it compared and ✓ yes, ✗ no or ? unknown, and one for the whole rule. A rule that is a single comparison has just the one column. Long text is cut in the heading; the whole text is in its tooltip and in the list under the table. Then the same for the sell rule, for the short and cover rules when the block has them, and, with an `add when` rule, for its parts. With `hold`, a "Score" column and a "Place" column follow.
  - A comparison with `bars held` or another position value shows a dash while no position is held, and `entries made`, `last entry price` and `entry price` show their value at that bar.
  - Sell columns are dimmed on bars with no position but still show what the rule said, because a buy is skipped when the sell rule holds at the same close.
  - Add columns are read only while a position has room for another entry, and show a dash when none is held or all entries are made.
  - "Place" is the place among the tickers that could be chosen, at the bars where the ranking decides.
  - "Position" reads "Flat", "Long, 62.66 shares", or with `entries` "Long, 2 of 3 entries, 62.66 shares". When a rebalance has resized the position it reads "Long, bought 62.66 shares". A short position reads "Short" where a long reads "Long". It is the position at the end of the bar, after the bar's fills, so a bar that added an entry and then hit its stop reads "Flat".
- **Unknown values** are shown as unknown, with the reason where it is easy to tell: an indicator still warming up, a `bars_since` whose condition has not held yet, a `zscore`, `rsquared` or `efficiency` window in which every value is the same, the square root of a negative number or the log of 0 or less, a `trading_day` in the first month of the data, a `correl` window in which one of the two series changes by the same amount on every bar, another ticker with no finished bar yet, no position held, looking back past the first bar, a CSV file with no number in that row, or dividing by 0.
- **What happened** is taken from the run's own record of its trades, not worked out again, so it agrees with the list of trades. Within one bar it lists things in the order they happened: orders from the last close filling at the open, then a stop or target reached during the bar, then what the close decided. It says what each bar did: a buy decided at this close and filled at the next open (with the date and the price), or at this close with `fill: close`; the fill itself; a sale by the sell rule; a stop loss, trailing stop or take profit; a position kept or dropped by the ranking. It also says why no buy happened: the buy rule held but the position was already long, the sell rule held too, the buy was waiting for the rule to stop holding after a stop, an input such as an ATR was still unknown, or an order is pending after the last bar.
  - An add reads "Add rule held: added entry 2 of 3 at the next open (2020-01-09) at 109.00." on the bar that decided it, and "Added entry 2 of 3 at the open at 109.55. Average entry price now 107.17; stop loss moved to 100.74." on the bar that filled it.
  - It says when the add rule held with the position already whole. When the add rule held and no entry followed, the run does not record why, so it names every cause that fits: no cash was free, or the position was already as large as its weight allows, and, when some trades were left undone for their commission, that the commission would have been 10% or more of the add.
- **Save as CSV** writes every bar of the ticker's run to the "Folder for saved results", as `<name> rule values <ticker> <date>`, with a line that says how many bars are done while it is made. When the file would be over about 20 MB, the section first says how big it would be and asks whether to save every bar ("Save every bar") or only the bars shown. A file too large to make whole, over about 400 MB, offers only the bars shown. The bars shown are saved as `<name> rule values <ticker> bars 121 to 180 <date>`, the numbers being the first and last bar shown. It has the date (or the time, in UTC), the close, for each comparison its two values and its result (a cross also has the values of the bar before), for each other part its result (`yes`, `no` or `unknown`), the position (`flat` or `long`), the shares, with `entries` above 1 the number of entries, and what happened. Values are plain numbers, headings use your own text, and fields with commas are quoted.

### Trigger prices

"At the next close" says, for each ticker, at what close of the next bar its rules would give an order: for one ticker in a sentence over a scale of those closes, for several in the "Next close" column of its table. For a ticker in cash that is its buy rule: "Buys if it closes above 512.30 (+1.2%), at the following open", or with `fill: close` "Buys if it closes above 512.30 (+1.2%), at that close", since the order then fills at the close the rule read. For a ticker held it is its sell rule and, with `entries`, its add rule while entries are left: "Sells if it closes below 480.10 (−2.0%), at the following open. Adds if it closes above 530.00 (+3.4%), at the following open." The percentage is measured from the last close. A block with short rules gets the same for its short side: for a ticker in cash its short rule too ("Shorts if it closes below 730.03 (−0.3%), at the following open"), and for a ticker held short its cover rule ("Covers if it closes above …") and the buy rule that would turn it long. A short's stop sits above the last close and its target below it.

- A rule that would give its order at an unchanged close says which close would stop it: "Sells unless it closes above 506.00 (+1.0%)". One that gives it at every close tried says "whatever the next close", and one that gives none says so with the closes tried: "The sell rule gives no order at any close from 470.00 (−8.0%) to 550.00 (+8.0%)." A rule can give its order on both sides: "Buys if it closes below 95.00 (−5.0%) or above 105.00 (+5.0%)".
- A rule that reads another ticker with `of` and not its own close is solved for that ticker's close: `buy when close of SPY > sma(200) of SPY` on TLT says "Buys if SPY closes above 512.30 (+1.2%)", with TLT's own bar taken where it was.
- A rule that reads a FRED series that way, and not its own close, is solved for the series' next value: `sell when close of fred:T10Y2Y < -0.3` says "Sells if T10Y2Y's next value is below −0.3 (−0.24)". The values tried are spaced evenly, since a series of values can be 0 or below, and the change in brackets is a difference from the last value, not a percentage. Such a price is listed under "Watch at the next close" only when it gives its order at an unchanged value, or with `fill: close`.
- A held ticker's stop and target follow: "The stop at 470.00 (−4.1%) sells during the bar if the price reaches it." They act inside the bar, before its close (rule 24), so a rule's closes are given only between them, and "below" in a sell rule's price reaches down to the stop. A stop above the last close, such as a trailing stop moved up by a long last bar, sells at the next open unless the price opens above it, and the column says that instead ("The stop at 11.64 (+16.4%) is above the last close, so it sells at the next open unless the price opens above it."); so does a target below the last close.
- After a stop or target exit, a buy rule that still holds has to stop holding before the ticker is bought again (rule 29): "After a stop or target exit, the buy rule must stop holding before SPY is bought again: it does if SPY closes below 480.00 (−2.0%)."
- With `hold`, a ticker in cash is bought only by the ranking, and the column says when it next decides: "Bought only when the ranking picks it, next at the close of 2026-11-30", the last bar of the period the next bar falls in, or "at the next close" with `rebalance: never` (rule 30). A held ticker shows its sell rule, then "The ranking decides again at the close of 2026-11-30."
- A buy whose sizing or stop input is still warming up at the next bar, or whose rule still is, cannot be made there (rule 12): "Can't buy at the next close: the 14-bar ATR for the stop loss is still unknown there."
- "–" when an order is already waiting, since the next bar fills it first, and for a CSV file in the universe.

The prices are worked out after the result is drawn, in the background worker the run used, and "…" shows until they arrive. They are worked out once for each result and kept with it: for the block as written, and for a slider's value once you let go of it, not while you drag. A strategy with a `to` date has no next close, and no column.

**How a price is found.** The plugin adds one bar after the ticker's last. It starts where the series' next bar would: one step on (its shortest gap between bars), skipping Saturday and Sunday for a ticker that has no weekend bars; holidays are not known. It opens at the last close, closes at the close tried, its high and low are its open and close, and its volume is that of the last bar. The rules are worked out again on a copy of the prices with that bar added; the prices of the run are never changed. The closes tried span 5 standard deviations of the last 60 log returns either side of the last close, at least 2% and at most 50%: 48 closes spaced evenly on a log scale, then each place where what the rules say changes is narrowed down by halving until the closes either side of it are within 0.01% of each other and within a quarter of a cent (of a millionth, below 1), and the cent between them, if there is one, is tried, so the cents either side of every change are known. "Above 512.30" and "below 512.30" name the cent next to those that give the order: a close of 512.30 gives none, and 512.31 does. "Unless it closes below 498.20" names the last cent that still gives the order: 498.20 does, and 498.19 does not. "Between" names the cents either side, as "above" and "below" do. Nothing outside the closes tried is known: "above 512.30" means from 512.31 to the top of the range. A FRED series solved for gets one new value instead, dated the last day the next bar can read it, its open, high, low and close the value tried. Its values tried span 5 times the root mean square of its last 60 changes either side of its last value (of all its changes when those 60 are all 0, and half its last value, or 1 when that is 0, when it has never changed): 48 values spaced evenly, each change narrowed down until the values either side of it are within 0.01% of the range apart. To be quick, the rules are read on only as many of the last bars as they need, unless they read `bars_since`, `obv`, `streak` or `psar`, which depend on all of history, or cutting the bars would change how a series lines up with the others. Every part of the rules must then have the same value at the last bar as in the run itself; when one has not, as an exponential average with a long memory has not, the whole history is read.

**What a price assumes.** A price is exact when the rules read nothing of the next bar but its close. Otherwise a line under it says what it assumes:

- "it opens at its last close", for a rule that reads `open`;
- "it trades only between its open and its close", for `high` and `low` and the functions that read them: `atr`, `stoch_k`, `stoch_d`, `adx`, `plus_di`, `minus_di`, `cci`, `williams_r`, `mfi`, `vwap`, `keltner_upper`, `keltner_lower`, `supertrend`, `supertrend_up`, `aroon_up`, `aroon_down`, `psar`, `cmf`, `highest since entry`, `lowest since entry`, and `highest` and `lowest` of the high and low. A rule such as `high > highest(20)[1]` is then solved for the close, though a high above the close would also buy;
- "its volume is that of its last bar", for `volume`, `mfi`, `obv`, `vwap` and `cmf`;
- "^VIX is unchanged", for another ticker the rule reads with `of`, which gets a bar of its own at its last close. Read a bar back, as in `close[1] of ^VIX`, it needs nothing assumed. With `fill: close`, a ticker that keeps other hours is read a bar early (rule 6), so its bar is usually known already. A ticker on other hours read with next-open fills waits for its bar that ends with the rule's own: a stock read with `close of binance:BTCUSDT` on a Friday reads Bitcoin's Monday at Monday's close, so Bitcoin's Saturday and Sunday, when they are not in the prices yet, are taken as unchanged ("BTCUSDT is unchanged until that close");
- "UNRATE publishes no new value by that close", for a FRED series the rule reads, and "signals has no new row by that close" for a CSV file of columns with no prices. Such a series has a row only when a value comes out, so it gets none: `close[1] of fred:UNRATE` is still the value before the last one. Read a bar back, it is assumed too, since a new value would move every row back by one;
- "T10Y2Y publishes one new value by that close", for a FRED series the rule is solved for;
- "the next bar is dated 2026-11-16", for calendar values such as `weekday` and `month_end`.

A price is what the rules say at a close, not a forecast, and the order follows only when the bar does close there. An add is given only while the position is below its whole size at that close, measured with the other positions where they were.

### When a backtest is too large

Two limits keep one strategy from holding up Obsidian.

- **Size.** Before a run starts, the plugin counts its bars across every ticker it loads (the benchmark, tickers read with `of` and the smaller bars of `magnify` included), and the values its rules work out: each part of a ticker's buy, sell and add rules and `hold` score on each of its bars. A run with more than 1,000,000 bars, or more than 25 million rule values, does not start. The block says "This backtest is too large to run", gives the numbers and the limit ("This run has 2.1 million bars across 40 tickers; the limit is 1 million."), and what makes it smaller: a later `from` date, a longer `interval` or fewer tickers. When most of its bars are the smaller bars of `magnify`, it suggests a longer `magnify` size instead of a longer `interval`.
- **Time.** A run still going after 10 seconds is stopped. The block says "This backtest took too long", how long it ran and how many bars it has.

Both have a button that runs the block as it is: "Run it anyway" after a size refusal, and "Run it anyway, for up to 2 minutes" after a time stop. Either way the run has no size limit and up to 2 minutes, and so do the block's sliders afterwards, also when the result is shown again from the kept results. A run stopped after 2 minutes has no button.

Where Obsidian cannot start a background worker, a run cannot be stopped and Obsidian does not respond while it runs, so the limits are stricter: 200,000 bars, 4 million rule values, and 200 million prices read by functions, where `sma(200)` on 1,000 bars reads 200,000. The message then starts "Backtests run in the foreground here".

A strategy that hits a limit in "Today's orders", the status bar count, a `backtests` block or a `compare` block is listed as one that could not run, with the same message, and the others still run. The strategy preview shows the message with its button, and a `forward` block shows it with "Try again". A sweep or a luck check that goes 2 minutes without finishing one backtest is stopped and says so.

### How many tries

Each strategy block keeps a count of its tries, and "Was it luck?" uses it. A try is a set of rules and values that ran and traded:

- the run shown when the block is drawn, in the note or in the strategy preview;
- each result a slider under "Parameters" shows;
- each variant of "Try other parameter values" and of the walk-forward check.

Each counts once, however often it runs. Two blocks that trade alike are one try however they are written: spacing, comments, `name:`, `test from`, and a parameter set to 20 or the number 20 written in. Anything that can change a trade makes another: the rules, the tickers, the dates, the costs, the default settings the block leaves to the plugin, and, with `from`, a parameter range that loads more history before that date. Not counted: runs that never traded, the reshuffles and random entries of "Was it luck?", the runs of the orders window, the status bar and the `compare`, `backtests` and `forward` blocks, and whatever you tried somewhere else. A block the plugin can't find in its note counts nothing.

The count belongs to the block: its note and its `name:`, or without a name its place among the note's strategy blocks, so give a block a `name:` to keep its count when blocks move around the note. Renaming or moving the note, or a folder above it, keeps the count; a new note made at the old path afterwards, such as another "Untitled", starts a count of its own.

"How many tries" gives the number of tries since the count began, and the chance that the Sharpe ratio of the run shown reflects a real edge: its deflated Sharpe ratio (Bailey and López de Prado, "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and Non-Normality", 2014). In words: with N tries and no edge at all, the best of them would still show a positive Sharpe ratio, and a higher one the more the tries' Sharpe ratios differ. The check works out that expected best, SR₀ = √V · ((1 − γ) Φ⁻¹(1 − 1/N) + γ Φ⁻¹(1 − 1/(N e))), where V is the variance of the tries' Sharpe ratios and γ is Euler's constant, and gives the probability that the run's own Sharpe ratio is above it, Φ((SR − SR₀) √(T − 1) / √(1 − γ₃ SR + (γ₄ − 1)/4 · SR²)), where T is the number of bars and γ₃ and γ₄ are the skewness and kurtosis of the run's returns above cash. The Sharpe ratios here are per bar: the plugin's Sharpe ratio before it is turned into one a year. A try on other bars, weekly say, is compared through its Sharpe ratio a year. With one try, SR₀ is 0. It says so when the chance can't be told: the run never traded, barely moves against cash, has under 3 bars, or has returns so lopsided or heavy-tailed that the formula has no answer. N is an upper bound: neighbouring variants are alike, so they make fewer independent tries than their count, and the chance errs on the low side.

"Start the count again" asks first, in place ("Start again" or "Keep the count"), then forgets the tries counted so far and counts from the run shown. Once there is more than one try, a line under the figures gives the count and the chance as well.

### The overfitting check of a sweep

Under the reading of a sweep, "How often the best fell back" gives the probability of backtest overfitting (Bailey, Borwein, López de Prado and Zhu, "The Probability of Backtest Overfitting", 2017), worked out by combinatorially symmetric cross-validation. Each variant's returns above cash are summed over 48 equal stretches of the run. The stretches are joined into 16 parts (12 with more than 150 variants), and the parts are split into two halves in every way there is: 12,870 ways for 16 parts, 924 for 12. In each split, the variant with the best Sharpe ratio on one half is ranked among all variants on the other half, ties sharing the middle rank, and the check is the share of splits in which it ranked in the bottom half, a split in which it ranked exactly in the middle counting as half. Near 0 means picking the best held up on the half it had not seen. Near one half or above means it did no better than picking at random. The check uses the variants that ran and traded, needs at least 5 of them and 20 bars in each part, and leaves out variants that ran over a different number of bars, saying how many. A stopped sweep uses the variants it finished. One sweep's figure swings widely, since every split reuses the same history: for variants with no edge at all it averages one half, but a single sweep can give anything from under 10% to over 90%.

### Versions

A block keeps each version of its text that was run, with the default settings it ran with, whether it was drawn in the note or in the strategy preview. The Versions section lists them newest first: the date and time, return per year, worst drawdown, Sharpe ratio and trades, and what changed from the version before (lines added and removed, and the change in return per year and Sharpe ratio). "Show the changes" shows the changed lines; the oldest version kept has "Show the text" instead. "Restore this version" puts that text in place of the block's, keeping the `>` markers of a callout or quote on every line and the note's line endings. The text it replaces is a version too, so it can be put back the same way. If the note has changed since the block was drawn, nothing is written and the line next to the button says so. The button is not offered in the strategy preview, nor where the block can't be edited. A version run with other default settings than the block has now says so: restoring its text does not bring back those settings. The first version and the latest 100 are kept.

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

The rules: at least 2 strategies and at most 8. List each strategy once. Give every line a weight or none. A weight can't be below 0%, at least one must be above 0%, and together they add up to at most 100%. A strategy at `0%` is listed but not in the combination: its line is drawn and its figures are in the table, Combined leaves it out, and it counts toward the 2.

Blocks are found the way the editor finds them. A `strategy` block inside a callout or a quote counts. One inside a longer fence of another kind, such as an example shown in a four-backtick `markdown` block, does not.

What you get:

- A title and the dates every strategy covers, from the latest start to the earliest end. Between a strategy's own dates its last value is carried forward. Each line is rescaled to start at the plugin's "Starting money" setting (not each strategy's own `capital`), and the title line says so. A key shows each line's final value.
- With weights, a "Combined" line. It holds the strategies at those weights and goes back to them on the first date of each month. Any weight not used stays in cash that earns nothing. A strategy at 0% is not in it, and the note under the chart names it. The line is drawn on top.
- A table of return per year, total return, worst drawdown and Sharpe ratio for each line. As in a strategy's own result, the Sharpe ratio takes off what cash earned over each step, using the strategy's own cash rate. For the "Combined" line it takes off the average of the strategies' cash returns, weighted by their weights as if they added up to 100%.
- How alike they move. With two strategies it is a sentence about the correlation of their returns. With three or more it is a table of correlations, from 1 (move together) to -1 (move against each other).

- With weights, "How to split" (below).

Each strategy runs as written, with the plugin's defaults for what it leaves out. If one cannot run, the comparison says which line and why.

### How to split

Under a `compare` block with weights, and in an `account` block with two strategies or more, "How to split" suggests other weights for the same strategies. Each set adds up to the total the block's weights add up to (if they add up to 80%, so does each set, and the rest stays in cash), and no weight is below 0%.

| Row | How its weights are set |
| --- | --- |
| As written | The block's own weights. |
| Equal weights | The same weight for each strategy. |
| Inverse volatility | Each strategy in proportion to 1 ÷ the volatility of its monthly returns. Needs 6 full months. |
| Minimum variance | The weights whose mix varied least, from how the strategies' monthly returns vary and move together. Needs 24 full months. |
| Maximum diversification | The weights whose mix has the highest ratio of the strategies' own volatilities, weighted, to the mix's. Needs 24 full months. |

The returns are those of each full calendar month the strategies have in common. How they move together is estimated with the covariances pulled towards one average correlation (Ledoit and Wolf, 2004), which steadies an estimate from few months; the notes say how far. A strategy whose monthly returns barely moved, as one that sat in cash does, gets nothing from the three methods that size by risk, since they would put almost everything in it.

Each row has the return per year, worst drawdown and Sharpe ratio of its combined line. A method's line works its weights out again at the start of each month from the months before it only, with equal weights until it has the months it needs, and holds them through the month, so its figures are ones that following the method could have had. The weights in the row are the ones it gives for the month to come, from every full month, rounded by largest remainders to the decimals the block writes its weights with (whole percentages for `40%`, tenths for `33.3%`, at most hundredths), so they add up to exactly the block's total. When the weights add up to less than one such step, such as 0.004% written in hundredths, no other set is offered, and a note says why.

"Use these weights" writes a row's weights into the block: in place of the weight on each strategy's line, or after the note on a line with none. Comments and other lines are left as they are. If the block changed since the table was drawn, nothing is written and the table says: "The note has changed since this result was drawn, so nothing was written. Try again."

Under the table, "What each strategy adds" takes the combined line at the weights written and, for each strategy, the same line without it, its weight spread over the others in proportion to theirs. The figures are the first less the second: above 0 is better in all three columns.

These are estimates from the past. Weights chosen on the same history the strategies were chosen on flatter the mix. The month-by-month lines keep later months out of each month's weights; they do not undo that.

## Accounts

A code block marked `account` describes one brokerage account: what it holds, its cash, and the strategies it follows with their share of it. It shows the orders that bring the account to what those strategies hold together, how to split it between them, and, given a file of your broker's trades, how your fills compare with the strategies' trades.

```account
name: Main brokerage
holdings: SPY 120, TLT 50, QQQ 10
cash: 4,200
whole shares: yes
skip under: 1%
fills: Broker/schwab.csv
fills from: 2026-06-01
capital at start: 48,000

[[Trend following]] 40%
[[Pullbacks#QQQ RSI pullback]] 40%
Research/Three sleeves.md 20%
```

| Setting | What it does |
| --- | --- |
| `name: Main brokerage` | The name at the top of the block and in the orders window. Without it, the note's name. |
| `holdings: SPY 120, TLT 50` | What the account holds: each ticker as the strategies spell it, with its shares, separated by commas or semicolons. A negative number of shares is a short, `SPY -50`, which needs a listed strategy that can borrow, as a cash below 0 does. `holdings: none` for nothing. |
| `cash: 4,200` | Its cash, such as `4,200`, `$4,200.50` or `48k`. It can be below 0 when a listed strategy that gets some of the money can borrow: one that shorts or holds more than 100%. A strategy at `0%` doesn't count. The block needs `cash`, `holdings` or both. |
| `whole shares: yes` | `yes`, the default, rounds orders to whole shares. `no` trades fractions, to 8 decimals. |
| `skip under: 1%` | Leaves out a resize worth less than this share of the money the strategies manage, however many shares it is. Opening or closing a position follows a signal and is never left out. The default, 0%, makes every order. |
| `fills: Broker/schwab.csv` | Your broker's CSV export of trades, by its path in the vault, or as `[[Broker/schwab.csv]]`. Needs `fills from`. |
| `fills from: 2026-06-01` | The first day the account followed the strategies. Fills before it are not compared. |
| `capital at start: 48,000` | What the account was worth that day. Without it, sizes are not compared. |
| `fills columns: date = Trade Date; ticker = Symbol` | The headers of the fills file that hold each part of a trade (`date`, `ticker`, `side`, `quantity`, `price` and `fees`, with several fees columns joined by `+`), where they are not the usual ones. A header with a `+`, a `;` or a `"` in it is written in quotes, with a `"` inside doubled: `fees = "Comm+Fees"`. The form for an unrecognised file writes it. |

The strategies are listed as in a `compare` block, at most 8. Each weight is a share of the money the strategies manage: the cash and the holdings of tickers a listed strategy trades, at the last closes. What the weights leave over stays in cash. Without weights each strategy gets an equal share. A strategy at `0%` gets none of the money, so what the account holds of its tickers is sold, unless another strategy holds them. A line that starts with `#` is a comment, and a mistake is shown with its line, as in a `compare` block. Holdings of tickers no listed strategy trades are left alone.

**Orders for this account.** For each ticker: Buy, Sell, "Sell all", "Sell short", "Buy to cover", "Flip" for a change of side, "Nothing to do" or "Skip: small"; the shares; the last close; the order's value; the shares held and the strategies' target; and where the order comes from: each strategy's own order at the account's size, and the drift, what it takes to bring the holding back to the strategies' positions. A ticker's target is the sum, over the strategies, of their share of the money the strategies manage times the share of their equity the ticker comes to once their orders waiting for the next open are made. Sales are listed first. Buys are cut, with "cut to the cash", when they come to more than the cash and the sales bring: each in the same proportion, rounded down, and then a whole share at a time back to the buys that lost the most to the rounding while the cash allows. Under the table: the money the strategies manage, the cash after the orders, what trading the strategies' orders as one spares against each trading on its own (in money traded and in their costs), and the holdings left alone. The orders are for the next open after the strategies' last bar, and the price of a ticker two strategies trade is the last close of the one whose prices end latest.

**How to split** is the table described under "Comparing and combining strategies". "Use these weights" writes the weights on the block's strategy lines.

**Your fills against the signals.** With `fills` and `fills from`, the block reads your broker's file and sets your fills against the strategies' trades from that day on.

- **Reading the file.** Columns are found by their headers, never by their place, so a column added or moved does not matter. Lines above the table and totals and notes under it are skipped. These are recognised: Charles Schwab's transaction history, Fidelity's account history, and Interactive Brokers' activity statement (its Trades section) and a Flex query of trades. Another file reads when its headers are the usual ones, such as Date, Symbol, Action, Quantity, Price and Commission. Without a buy or sell column, the sign of the quantity says which. Dates are read in numbers, such as `04/13/2026` or `2026-04-13`, or with the month's name, such as `Apr 13, 2026`; a date without its year is not read. Where Interactive Brokers lists an order and the executions that filled it, each order is read once. When the date, ticker, quantity or price can't be found, the block shows a form with a menu for each part, guessed from the line with the most columns; "Save these columns in the block" writes the `fills columns` line, and the block reads the file again. Short sales and buys to cover, such as Schwab's "Sell Short" and "Buy to Cover", are read as trades. Dividends, reinvestments, transfers and other activity, such as interest, fees and options, are left out and counted, and so are trades of tickers no listed strategy trades. BRK/B, BRK.B and BRK B are all Yahoo's BRK-B.
- **Matching.** The strategies' trades are sized to the account, each as its share of `capital at start` ÷ its own equity on `fills from`, and counted in shares as they traded that day: a later split does not change them. Their orders of a ticker at the same moment, the open of a bar, are netted into one, whatever each strategy's prices are adjusted by; a strategy that fills at the close, and a stop, are moments of their own, so a position opened and stopped out the same day is a purchase and a sale. Each day's purchases of a ticker, and its sales, are then matched share for share in time order, purchases with purchases and sales with sales. Your shares of a day go first to the strategies' trade of that day: **on time**. What is left of a trade then takes what is left of your shares of the 5 trading days after it, earliest first: **late**, set against the strategies' price on the day of your fill, so a dividend or a split between the two days is not counted as a cost. Trading days are the days of the ticker's prices as traded, where the block loaded them, else those of a strategy's own daily bars of it, else Monday to Friday, as for a ticker only weekly strategies trade. So buying on one day what the strategies bought over two is one fill late and one on time, and a trade bought over two days is one fill on time and one late. A trade made under 70% has the rest as a **partial** row, counted like a trade not made; a shortfall smaller than that is not counted. A trade with no fill is **not made**, or **waiting** while its 5 days are not over. Shares of yours left over go with that day's first row, which is **oversized** when they are more than 30% of what it matched. A day of yours that matches no trade is **off plan**. Without `capital at start` each trade and each day of yours count as one, so nothing is partial or oversized, and trades not made are not counted in money.
- **Prices.** Yahoo's and Tiingo's prices are adjusted for later dividends and splits, so they are not what you paid. For the tickers that you or the strategies traded since `fills from`, the block loads the daily prices as they traded (see "Network requests"), and only when the file has fills from that day on. Each strategy's price is converted with its own bars: by the close as traded over the bar's own close, at the last day the bar covers, so a weekly strategy's at its week's last day. A strategy with bars shorter than a day is not compared on price. Binance and CSV prices are as traded already. A fill more than 3% outside the range its day traded in is most likely from a split and is not compared on price. When the prices as traded can't be loaded, the ticker's fills are matched but not compared on price, and a note says so.
- **What is shown.** "Not following the rules cost $X since 2026-06-01" (or "made", when it came out ahead), and its four parts: **slippage**, your price against the strategies' on the same day times your shares, above 0 when yours was worse; **fees**, from the file; **late fills**, the same for fills on a later day; and **trades not made**, what the strategies' trades or the parts of them not made would have made by the last close, below 0 for a loss avoided. The total is exactly the sum of the four, not a second run of the whole account: a trade off plan counts only its fees. Then a row for each ticker, and, for each strategy with fills compared, the median slippage as a line to copy into its block, such as `slippage: 4.2 bps`, so its backtest pays what you pay. The plugin's own settings are not changed. "Every trade" lists each row with the strategies' trade, yours and the cost.

What to keep in mind:

- A rebalance due at the next open shows a bar late: the block shows it once the strategy's backtest has made it.
- The size of a new position of a strategy that sizes by inverse volatility or by risk per trade is an estimate from the last close.
- Dividends and reinvestments are left out. A dividend is in your cash only once you write it in `cash`, and shares a reinvestment bought are not compared with anything.
- A fill far outside its day's range is left out of the price comparison as a likely split. The strategies' shares are counted as they traded on the day, while what a trade not made would have made is in the strategies' own prices, which a later split does not change.

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

Each strategy is one row: its name with its note's name under it (click to open the note), return per year, the benchmark's return per year (its name under the figure), worst drawdown, Sharpe ratio, trades, what it holds now ("Long SPY", "Long 2 of 5" or "In cash", with "Short" for a short and "Long 2, short 1 of 5" for both), its orders in words, and the date its prices go through, with "may be old" when they are out of date by the rule under "Today's orders". The figures are the ones in the strategy's own result.

The "Next" column lists the orders: sells first, then buys, then adds to positions held ("Buy B", "Add A"). A short's orders read "Sell short" and "Buy to cover", and a buy to cover is listed with the sells. More than three tickers in one line are cut after three ("Sell A, B, C and 2 more"). An order for the next open has no time after it ("Sell TLT, GLD"). An order for the next close ends "at the next close", and what a strategy with `fill: close` did at the last close reads "Bought SPY at the last close", "Added SPY at the last close" or "Sold SPY at the last close". A dash means no order.

Rows appear as each strategy finishes, three at a time; until then a row says "Running…". A strategy that cannot run shows why across its row and does not stop the others. Click a column heading to sort by it, and again to reverse; strategies that could not run or are still running stay at the bottom. Under the table are the number of strategies, when the figures were worked out, and "Run again", which lists the vault again, drops the results kept in memory once, when the round starts, and runs everything with fresh prices. On a narrow pane the table scrolls sideways and the strategy's name stays in view. If the vault has no strategies, the block says so and how to add one.

## Today's orders

The command "Show today's orders", or the ribbon icon of the same name, opens a window. It runs every `strategy` block in every note of the vault that has the word "strategy" in it, and lists the orders each one has and when each applies. Blocks are found as described under "Comparing and combining strategies": ones in callouts count, examples inside a longer fence do not.

- **To do at the next open.** One row for each order of a strategy that fills at the next open: Buy or Sell, or for a short "Sell short" or "Buy to cover", the ticker, the size, the strategy (click it to open its note), the last close, and which bar it is based on, such as "Based on the close of 2026-11-13". For strategies with bars shorter than a day the row shows the time too, in UTC, such as "Based on the 5m bar starting 2026-11-13 14:05 UTC". Sells and buys to cover are listed first, so the cash is there for the buys. A flip is two rows: "Sell" then "Sell short", or "Buy to cover" then "Buy". A buy's size is its target share of the strategy and about how many dollars that is at the backtest's current value, which grows or shrinks from the block's `capital`. A sell is the whole position. With `entries`, a buy says which entry it is ("Step 1 of 3") and is sized as that entry, and an add is listed as "Add" ("Add SPY"), with "Step 2 of 3" and that entry's size. Scale the percentage to your own money. The dollar figures are about the backtest, not about your account.
- **To do at the next close.** Orders of a strategy with `fill: close` that could not fill at the close they were decided at. This happens when a ranking decision is made at a time a ticker has no bar: its order waits for that ticker's next close. The rows look like the ones above.
- **Traded at the last close.** What a strategy with `fill: close` did at the close that has just passed. Its backtest has already bought or sold, so the row says Bought or Sold, or for a short "Sold short" or "Bought to cover". To match it, the order had to be placed before that close. A buy shows its share of the strategy, a sell the whole position and the day it was opened.
- **Watch at the next close.** The trigger prices worth watching (see "Trigger prices"), nearest first: those that give an order at an unchanged close or within 2% of the last close, and every one of a strategy with `fill: close`, whose orders have to be placed before the close. Each row has Buy, Sell or Add in a dashed outline, the ticker, the price in words with when its order fills, such as "Buys if it closes above 512.30 (+1.2%), at the following open" or "Shorts if it closes below 730.03 (−0.3%), at the following open", the strategy, the last close (with the other ticker named, as in "512.30 (SPY)", when the rule reads another ticker's close), and the bar it is based on. A close to watch is not an order and is not counted as one.
- **Accounts.** For each `account` block in the vault (see "Accounts"), its orders in shares, from the results of the strategies just run: Buy or Sell, the ticker, the shares ("Sell all 30 shares" for a position closed), the last close and the shares held, with "Sell short", "Buy to cover" and "Flip" for a short's orders. An account with nothing to trade says so, and one that can't be worked out says why. These are the strategies' orders netted at the account's size, so they are not counted again in the status bar.
- **Holding.** Strategies that hold something or have no order, and what they hold. A position that has an order row, including one bought at the last close, is not listed again here.
- **Strategies that fill at the close.** The strategies with `fill: close`, under this note: "A strategy with fill: close decides and fills an order at the same close, so the order has to be placed just before a close. What is listed for it is what its rules said at the last close."
- **Problems.** A block that could not run (one that is too large or takes too long to run is listed here with its message, see "When a backtest is too large"), prices that are out of date, and any warning from loading prices. For daily bars, prices are out of date when they end more than 4 calendar days ago. For bars shorter than a day, they are out of date when the last bar is more than 3 bars old, and for weekly bars when it is more than 2 bars old.

A group with no rows is left out. When no strategy has an order, the window says "Nothing to do. No strategy has an order."

The header says which bar the orders are based on. Orders under "To do at the next open" are for the open after that bar, and under "To do at the next close" for the close after it. "Traded at the last close" is that bar's own close. When the strategies with orders end on different bars, the header shows the oldest and says so, and each row shows its own. Yahoo's bar for the current day is used once the exchange's regular session has closed, when Yahoo's answer gives that time; until then, and when it does not, the orders refer to the previous close. Check the date.

Refresh prices downloads each ticker once, however many strategies use it, then runs the strategies again, three at a time. Each Tiingo ticker is a request to Tiingo, whose free plan allows about 50 an hour, so a vault with many Tiingo tickers can reach that limit when the window or the check at start-up refreshes them all. "Save as note" writes the same list to the note named in the "Note for today’s orders" setting, creating it if it does not exist and replacing its whole contents each time. The saved note has one section for each group that has rows ("To do at the next open", "To do at the next close", "Traded at the last close"), or "To do" with "No strategy has an order." when there are none, then "Accounts" as a table of each account's orders with a line for each account with none, then "Watch at the next close" as a table when there is a close to watch, and names the strategies with `fill: close` under "Strategies that fill at the close". The generated note starts with the property `backtest_orders: true`. An existing note is replaced only if it has that property; otherwise nothing is written and the window says "<path> already exists and was not made by Backtest Blocks. Choose another note in settings." With no note set, it says so. Nothing in the window places an order.

A block with no `name` is listed under its note's file name, or "file name 1", "file name 2" when a note has several.

### In the status bar

A few seconds after Obsidian starts, the plugin runs every strategy in the vault quietly, from saved prices where they are fresh, and shows how many orders there are in the status bar, counting every group in the window: "2 orders today", "1 order today" or "No orders today". Rest the pointer on it to see the first five, each with its timing, such as "Sell SPY at the next open, Trend following", "Add SPY at the next open, Built in entries" or "Bought TLT at the last close, Close mover". Under "Watch at the next close:" follow the three nearest closes to watch from the window's group, such as "QQQ buys if it closes above 512.30 (+1.2%), Momentum"; they are not counted in the number. Click it, or press Enter when it has focus, to open the window.

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
check: qcdcqvjvib
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

**Pinned defaults.** The plugin's defaults would change a strategy that leaves a setting out whenever you changed them, so the frozen text writes down each of `capital`, `costs`, `slippage`, `commission`, `cash rate` and `data` that the strategy leaves out, and for a strategy that borrows also `margin rate`, and `borrow fee` when it shorts, as lines at the end under a comment. `commission: 0` is written when there is none. A setting the strategy writes itself stays as it is, since a second line would be an error. If the strategy ends inside a `for` section, where settings are refused, `for all:` is written first. The lines go at the end so that no line of the strategy moves. Read with any defaults, the frozen text is the very same strategy as the one on screen was with the defaults it had; the tests compare what the parser makes of both.

**The check.** The `check` line holds a code made from the `started` time and the frozen text, since an earlier start would count bars the rules may have been chosen on. Blank lines at the text's end and the kind of line ending do not count; any other change does. The `from` line is not part of it, so a link Obsidian updates when a note is renamed does not matter. When it no longer matches, the block says "The rules or the start were changed after the forward test began, so this is no longer a forward test." and shows nothing else, no figures and no log button. It is there to catch a slip. It protects nothing: whoever edits the text can write a new code. To go on, put the rules and the start back as they were, or start a new test.

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

Each row is a bar, its orders in words (sells first, "Add" for a later entry of a position built in steps, and "Sell short" and "Buy to cover" for a short), the close each order rested on, what the strategy was worth at that close, and the day the row was logged, on your own calendar. Nothing is written when Obsidian starts or when a block is drawn. The button under the log, "Add 3 new bars to the log" (with the number of bars that gave orders after the last one logged and the last one checked), writes the rows, and moves `Checked through` up to the last bar. When no bar gave an order, the button reads "Mark the log checked through" and the day, so the log can say that nothing was due. With nothing to add and the day recorded, there is no button.

The button edits the note in one step. It adds only the bars after the last logged one and after `Checked through`, so pressing it again adds nothing, a bar already checked is never added later, and it never rewrites a row, whatever you did to one. `Checked through` never moves back. It writes nothing, and says why, when the note has no `backtest_forward` property (a note the plugin did not make), when the frozen rules were changed, when there is no `## Log` heading, or when the table was changed by hand so that the bar of its last row cannot be read: its rule row is gone or a bar is not a date. A note with Windows line endings keeps them.

**What is in the log, and what is not.** The log lists the orders the rules gave, read from the run's own record of each trade:

- A buy or an add is dated at the bar its rule was read at (a ranking's decision is dated at the bar it was made). A sell by the sell rule or by a ranking is dated at the bar it was read at. With the default fill at the next open, that is the bar before the fill; with `fill: close` it is the bar of the fill itself.
- An order still waiting after the last bar is listed at that bar.
- Exits by a stop, a trailing stop or a take profit are left out, and so are rebalancing trades. The rules did not give them: the run makes them by itself, at levels you set or at the start of a period.

**Revisions.** Prices from Yahoo are adjusted for dividends and splits after the fact, so a run made today can give different orders for a bar than the one the log was written from. The block compares the orders in the log with the orders today's run gives for the same bars, from the start to the last bar checked, and lists each bar where they differ: "The log says Buy SPY on 2026-12-03; today's prices give no order there." It compares orders and never closes, which change with every dividend. A bar that gave an order today and has none in the log says "The log has no order on 2026-12-03; today's prices give Buy SPY there." The log is never changed to match, and such a bar is not added to it: it keeps what it said.

## Saving results

Three buttons under a result write files to the "Folder for saved results" (default `Backtests`), created if needed. A fourth, "Start a forward test", writes a note to the `Forward` folder inside it (see "Forward tests"). The table "Rule values, bar by bar" has a "Save as CSV" button of its own that writes there too. A file is named `<name> trades|value|result <date>`, where `<name>` is the block's `name` (or "Backtest") with characters that Obsidian cannot use in a file name replaced by spaces, and `<date>` is the day it was saved, in UTC. If the file exists, ` (2)`, ` (3)` and so on are added. A notice shows the path.

- **Save trades as CSV** has the columns `ticker`, `bought`, `buy_price`, `sold`, `sell_price`, `return_pct`, `profit`, `bars` and `exit`. Open positions have no `sold` or `sell_price`. `exit` is `signal`, `stop loss`, `trailing stop`, `take profit` or `open`, and for a block that can borrow also `margin call` or `ruin`. A run with a short trade has a `side` column at the end, which says whether each trade was long or short. For a short, `bought` and `buy_price` are when and at what price it was sold short, and `sold` and `sell_price` when and at what price it was bought back, so the columns keep their places whatever the side. A strategy with `entries` above 1 has four more columns at the end: `entries`, the number of entries, and `entry_dates`, `entry_prices` and `entry_shares`, each entry's value separated by semicolons; `bought` is then the first entry and `buy_price` the average.
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
| `bt_invested` | Time invested, in percent; for a block that can borrow, the average gross exposure. |
| `bt_from` | First day of the run. |
| `bt_to` | Last day of the run. |
| `bt_benchmark_return_per_year` | The benchmark's return per year, in percent. |
| `bt_last_run` | The day the figures were last changed. |
| `bt_position` | The tickers held now, with a short marked as in `SPY (short)`, or `cash`. |

A note with one strategy uses the plain `bt_` keys above. When a note holds more than one strategy, each block gets its own keys, with a part between `bt_` and the rest of the key. A block with a `name` uses it: "Trend following" writes `bt_trend_following_sharpe`, `bt_trend_following_trades` and so on. The name is turned into lower case, and each run of characters that are not letters or digits becomes `_`. A block with no name, a name with no letters or digits, or a name that would give the same keys as an earlier block uses its position in the note instead: `bt_2_return_per_year` for the second block. No two blocks share a key. Renaming or reordering blocks changes their keys.

The plugin owns every property that starts with `bt_`. It updates them, and when every strategy in the note ran, it removes `bt_` properties that no strategy in the note produces any more, such as the keys of a block you deleted or renamed. Do not name your own properties `bt_...`. If a block could not run, nothing is removed, so its earlier figures stay. A property is written only when its value changed, and `bt_last_run` (for each block, the day its figures last changed) moves only when something else in the note changed, so opening a note on a new day does not edit it. Properties let a Base list your strategies. A `backtests` block lists them without properties (see "All strategies in one table").

## Drafting from plain English

The command "Draft a strategy from a description" opens a window where you type what you want. A model writes a draft in the plugin's language, the parser checks it, and you decide whether to insert it. You need to choose a provider in the settings first.

Providers:

- **Anthropic.** You choose an API key (required). The model is `claude-opus-5-5`, or the name in the "Model" setting. Requests go to `api.anthropic.com`, or to the "Server address" if you set one; both settings can stay empty.
- **OpenAI-compatible server.** Enter the server's address (such as `http://localhost:8000/v1`) and the model name its server uses; both are required. The key is optional, for servers that need none. Requests go to the address followed by `/chat/completions`, with the temperature set to 0.

The key is not saved in the plugin's settings file. You pick it from Obsidian's secret storage, and the plugin saves only the name of the secret. The key is sent only to the service you chose, as a request header.

What is sent, exactly:

- A fixed set of instructions that comes with the plugin (its language part is also published as `llms-full.txt`, see "For language models and tools"): the language reference, the limits (long, short or leveraged up to 2×, with no options or futures), the reply format and worked examples. It holds nothing from your vault. This is the plugin's built-in guide to the language.
- The description you typed.
- If the parser finds errors in the draft, up to two repair requests follow. Each one sends the conversation so far (your description and the model's earlier replies), the parser's messages with the lines they are about, and the draft.

Nothing from your notes or vault is sent: not your notes, your strategies, prices or results. What is sent is your description, the built-in guide and, when a draft has problems, that draft and the problems found. The only setting that leaves the plugin is the API key, as described above. The window and the settings say the same.

What happens to the reply:

- The plugin pulls the strategy and any lines starting with `NOTE:` out of the reply. The notes are shown as "The model's notes": they say what the model chose or could not express (for example, that options are not supported).
- The parser checks the draft. After the repairs, the draft is shown even if it still has problems, with the problems listed.
- The draft is never run. Nothing is fetched and no backtest is made. It runs only after you press "Insert into note", which puts a `strategy` block at the cursor of the note you have open for editing; from then on it is an ordinary block. With no note open for editing, it asks you to open one.
- "Try again" asks again. Pressing Ctrl+Enter or Cmd+Enter in the box sends the description.

The model may get a strategy wrong. Read the draft and the model's notes before you insert it.

## Editing help

Inside a `strategy` block the editor helps you write it.

- **Colours.** The parts of a block are coloured with your theme's code colours: setting and parameter names, keywords (`buy`, `short`, `add`, `when`, `and`, `of`, `for`, `between`, `within`), functions, series and calendar values, numbers and values, tickers, parameters and definitions used in rules, operators, and comments in italics. The result shows the block coloured the same way.
- **Auto-complete.** A pop-up offers what can come next, with a line of help for each item. At the start of a line it offers `buy when`, `sell when`, `add when`, `short when`, `cover when`, `for`, and the settings (only the stops inside a `for` section). After `of` and `for` it offers the tickers named in your `universe`, `symbol` and `benchmark` lines (after a comma on a `for` line, the ones it does not list yet), and after `of` also `tiingo:` and `fred:` once you type their first letters. After a setting name it offers values, such as the choices for `rebalance`, `data`, `interval` and `fill`. Inside a rule it offers series, calendar values, your parameters and definitions, functions and words such as `crosses above`, `between` and `within`. `bars held`, `entry price`, `last entry price`, `entries made`, `highest since entry`, `lowest since entry` and `position return` are offered only in sell, cover and add rules, and in definitions. After `column(` it offers the column names of the CSV files the block names with `csv:`, for the files the plugin has already read (a block that has run, or the CSV helper, reads one); a file it has not read yet offers none. It stays quiet while you type a number.
- **Underlines.** Problems are underlined with a wavy line, in the theme's error colour. Notes (such as the fixed-price one) are underlined in its warning colour. Hover the underline to read the message, which starts with "Problem:" or "Note:". The editor reads the block with the same parser as the result, using the plugin's defaults.
- **Help on hover.** Hold the pointer over a word in a `strategy` block to see what it means: its form, one or two sentences, and an example. This covers settings and their fixed values (`monthly`, `yahoo`, `1h`, `next open`), functions, series, calendar and position values, rule words (`crosses above`, `of`, `for all`, `and`), a ticker written with `tiingo:` or `fred:`, `%` and `bps`, the `[n]` lag, and `in ... step` on a parameter line. A name of several words such as `bars held` or `last entry price` is one word, and so is a rule's start such as `add when` or `short when`. A parameter you declared shows its value and range wherever it is used, and a definition its text. When the spot also has a problem, the problem comes first and the help under it.
- **Fixes.** When a problem looks like a typo, the tooltip offers a button such as "Change to sma". It covers the start of a rule (`sel whn`, `ad when`, `shrt when`), a misspelt setting, function (`column` included), series, word in a condition (`crosses abov`, `betwen`), setting value (`montly`, `yaho`), `for` ticker, parameter or definition name, and habits from other languages: `&&`, `||`, `!` before a word, `=>` and `=<`. A fix is offered only when the corrected block no longer has that problem, and none is offered when two words are equally close. Clicking it is an ordinary edit. The command "Fix the problem at the cursor" does the same from the keyboard for the problem at the cursor, or else the first one on its line. In the list that replaces a result when the block cannot run, the same suggestion is a sentence ("Did you mean sma?").
- **Ticker lookup.** With the setting "Look tickers up while writing" on, which is the default, typing a ticker on a `universe`, `symbol`, `benchmark` or `cash rate` line offers real ones with their names, from Yahoo and Binance. The tickers already in the block are offered at once. A ticker from the other source is written with its prefix, such as `binance:BTCUSDT`. Typing `csv:` offers the CSV files in your vault, and typing the start of `tiingo:` offers it. Tiingo tickers and FRED series are not looked up, nor are the tickers of a block whose tickers come from Tiingo, so they get no suggestions and no note. Only the ticker word is completed, so a weight such as `SPY 60%` is left alone. A ticker its source does not know, in the universe or after `of`, is underlined as a note ("Yahoo has no ticker called SPYY."), with a button to change it to a near one when there is one. When the same ticker is written on a `for` line or after `of`, the button changes every place and says how many ("Change to SPY (2 places)"). It is offered only if the block has no new problem afterwards. That note never stops a run, and it waits until the cursor leaves the ticker. The lookup sends tickers over the network; see "Network requests" for what and when.

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
| Interest on cash | A rate such as `4%`, or a ticker whose price is a yield, such as `^IRX` or `fred:DGS3MO`. A `cash rate` line overrides it. | `0%` |
| Borrow fee for shorts | A yearly fee on the value of each short position, such as `0.5%`. A `borrow fee` line overrides it. | `0.5%` |
| Interest on borrowed money | A yearly rate on the money a strategy owes when it holds more than its equity, such as `6%`. A `margin rate` line overrides it. | `6%` |
| Where plain tickers come from | Yahoo, Binance or Tiingo, for tickers written without a prefix such as `binance:`. Tiingo needs its API key. | Yahoo |
| Keep saved prices for | Hours before saved prices are fetched again, from 1 to 168. | 6 |
| Saved prices | A button, "Clear saved prices", that removes every price file the plugin saved. | |
| Tiingo API key | A secret in Obsidian's secret storage, for `tiingo:` tickers, `data: tiingo` and the setting below. Only its name is saved in the settings. It is read when a request goes out, and sent to `api.tiingo.com` in the request's `Authorization` header. | none |
| FRED API key | A secret in Obsidian's secret storage, for `fred:` series. Only its name is saved in the settings. It is read when a request goes out, and sent to `api.stlouisfed.org` in the request's web address, the only place FRED takes it. | none |
| When Yahoo fails, use Tiingo | When a Yahoo ticker of a US listing cannot be loaded and its saved copy is more than 3 days old, or there is none, load it from Tiingo instead, and say so in the result (see "Where prices come from"). Needs the Tiingo API key. | off |
| Write results to note properties | When a note's strategies have run, save their main figures to the note's properties. Properties that start with `bt_` belong to the plugin: it updates them and removes ones no strategy in the note produces any more. This edits your notes. | off |
| Note for today’s orders | Vault path of the note to write them to, such as `Trading/Orders.md`. The note is rewritten each time you save, and an existing note is replaced only if the plugin made it. Empty for none. | empty |
| Folder for saved results | Vault folder where saved results go. | `Backtests` |
| How results first appear | Full opens every result. Compact shows one line for each strategy, which opens on a click and suits a note with several (see "Folding a result"). | Full |
| Check for orders when Obsidian starts | Runs every strategy in the vault shortly after start-up and shows how many orders are due in the status bar (see "Today's orders"). This fetches prices for every strategy's tickers. Turning it off hides the count and stops the checks at once. | on |
| Look tickers up while writing | Suggests matching tickers and marks ones that do not exist. What you type where a ticker goes, and the Yahoo tickers named in strategy blocks on screen, are sent to Yahoo's search, one ticker at a time. Tiingo tickers and FRED series are never sent. Nothing else from your notes is sent (see "Network requests"). | on |
| Provider | The service that turns a description into a strategy: Anthropic, or an OpenAI-compatible server. | Anthropic |
| Server address | Anthropic: empty for Anthropic's own address, or a proxy. OpenAI-compatible: required, such as `http://localhost:8000/v1`. | empty |
| Model | Anthropic: empty for `claude-opus-5-5`. OpenAI-compatible: required, the name of the model on your server. | empty |
| API key | A secret in Obsidian's secret storage. Only its name is saved in the settings. Required for Anthropic; empty is fine for a server that needs no key. | none |

The costs, slippage, commission, cash rate, borrow fee and borrowed-money settings are checked the way the language would read them, and a value that cannot be read is not saved.

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
- **Tiingo.** The end-of-day prices of `api.tiingo.com` (`/tiingo/daily/<ticker>/prices`), for US stocks, ETFs and mutual funds. It needs an API key, which a free Tiingo account gives; the plugin sends it in the request's `Authorization` header, never in the web address. The plugin asks for the whole daily history each time, from 1900, because Tiingo's adjusted prices change after every dividend. Open, high, low, close and volume are Tiingo's adjusted ones (`adjOpen`, `adjHigh`, `adjLow`, `adjClose`, `adjVolume`), so they are adjusted for splits and dividends as Yahoo's are. Each bar is dated by its exchange day. The bar for the current day is left out until 16:00 in New York. Tiingo makes a day's prices final in the evening, at about 17:30 to 20:00 New York time, so a run between the close and then may not have that day yet, or may have prices Tiingo corrects later; the next refresh replaces them. Weekly bars are made from the daily ones: each is dated on the Monday its week starts, holiday or not, as Yahoo dates its weekly bars, and is used once the week is over. A ticker Tiingo does not know gives "Tiingo has no prices for X. Check the ticker." Tiingo's free plan allows about 50 requests an hour and 1,000 a day, and each ticker and bar size is one request.
- **Tiingo in place of Yahoo.** With the setting "When Yahoo fails, use Tiingo" on, a Yahoo ticker whose three tries all fail is taken from its saved copy while that is less than 3 days old, then from Tiingo, then from an older saved copy. A ticker Yahoo says it does not know is not tried at Tiingo. Only tickers of US listings stand in: not one that starts with `^`, or ends in a dot suffix such as `.L`, a currency after a dash such as `-USD`, or a suffix after `=`. It covers daily and weekly bars, never the smaller bars of `magnify`. The result says "Couldn't load SPY from Yahoo (HTTP 503); using Tiingo's prices instead." for each ticker, and "Prices through" names Tiingo as where that ticker's prices came from. Tiingo's prices are saved under Tiingo's name, apart from Yahoo's.
- **FRED.** The series observations of `api.stlouisfed.org`, for the economic series of the Federal Reserve Bank of St. Louis. It needs an API key, which a free FRED account gives. FRED takes the key only in the web address, so it is in the address of every FRED request; it goes over HTTPS, and the plugin keeps it out of every message, file and result. The plugin asks for each series as ALFRED keeps it, in a few requests: the days the series was published on (its vintage dates); the series as it stood on the first of those days, which holds its past from before ALFRED kept each release; then every later value as it was first released (`output_type=4`), 1,500 publication days at a time, since FRED answers for at most 2,000 at once. A daily series such as DGS3MO, published nearly every weekday since 2005, takes six requests. So a value revised after its first release is read as first released. Each value is dated by the day it was first published, not the day it is for: the unemployment rate for March counts from the day in April it came out. Many series came into ALFRED with their past in one go, on the day the series was added, as the figures known that day. So when more than 5 values were first published on the series' first day, those values are taken for such a backfill, and each is dated instead the median delay after the end of its period that the series' other values show, or one whole period after it when there are none, and never later than it was published. Only the date is estimated: the value is the figure of that first day, which for an old period may already include revisions made before the series was added. Many values first published together on a later day, such as a week of daily values put out at once, are dated the day they came out. The result says how many values were dated as a backfill. A missing value (`.`) is left out. A series FRED does not know gives "FRED has no series called X. Check the series ID, such as T10Y2Y."
- **CSV files in your vault.** Read directly, with no network. The file needs a header row with a date column (`date`, `time`, `timestamp` or `datetime`) and `open`, `high`, `low` and `close` columns; `volume` is optional. The separator can be a comma, semicolon or tab. Dates can be `2024-01-31` (with an optional time, read as UTC, or with a zone after the time, such as `2024-01-31 14:30-05:00`), `01/31/2024` or `01-31-2024`, `31/01/2024` or `31-01-2024` (read as day first when some first number is above 12 and no second number is), `31.01.2024`, or Unix seconds or milliseconds. When dates such as `02/01/2024` or `02-01-2024` could be either, a file read as it is takes them month first, and "Use a CSV file in a strategy" says so and asks which. An `adj close` column, if present, adjusts the other prices. Every other column that holds numbers is kept for rules to read, and a file with a date column and such columns but no header that looks like a price is a file of signals (see "Signals from a CSV file"). Rows with an unreadable date, a price at or below 0, or a high or low that does not contain the open and close are skipped. Rows are sorted by date. Numbers need a decimal point. Prices are not saved: the file is read each time a block runs. A result is kept in memory (see "Reading a result"), and it runs again when the file's modified time changes. The command "Use a CSV file in a strategy" helps with a file that does not fit (see below).
- **Smaller bars for `magnify`.** A block with `magnify` also loads the smaller bars for each Yahoo or Binance ticker in its universe, from the same hosts, and never for a CSV file or a Tiingo ticker. Yahoo answers in one request for each ticker, for a limited window (rule 64); the saved file is about 200 KB for 1h bars and 260 KB for 5m bars. Binance gives 1,000 bars a request, about 170 KB each, so a first load of the 100,000 bars the plugin keeps for a ticker is up to 100 requests, and the saved file is about 6 MB. Later refreshes ask Binance only for newer bars, and Yahoo for its window again. Smaller bars count as bars toward the size of a run (see "When a backtest is too large").

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
- **Only a CSV file has columns.** `column(score) of SPY`, or `column(score)` in a rule of a Yahoo, Binance or Tiingo ticker, is an error as soon as the block is read, naming the ticker. A column that the file does not have is found when the file is read: the run stops and says which file, which column was asked for and which columns the file has.
- **A file of signals.** A file that has a date column and columns with numbers, and no header that the "Use a CSV file in a strategy" window takes for a price (`open`, `high`, `low`, `close`, and names such as `price`, `last`, `settle`, `value`, `nav`, `adj close` or `close price`), has no prices. A rule can read its columns with `of`, but it cannot be traded: in `universe`, as the `benchmark`, as a `cash rate`, or with `close of signals`, the run stops and says it has no prices, only columns. (A file with only some of the price columns, such as a date and a close, or a date and a `price` column, is still not read as it is: see "Using a CSV file". To read such a column as a signal, give it another name.) Without any price header, `volume` is a column like the rest.
- **Dated rows.** Rows are sorted by date. When a date comes twice, the first row of the file keeps it, with its own values in every column. An `adj close` column scales the prices and nothing else.

**What date a row must carry.** A row is known at the end of the day it is dated (rule 6 under "How the simulation works"). A row dated Tuesday is known at Tuesday's close, so a rule read at that close can use it, and the order it gives fills at Wednesday's open. So date each row with the day whose close its value was computed from. A value worked out from Tuesday's close belongs on the row dated Tuesday. If you file it under Wednesday, the rules see it a day late. If a value worked out from Wednesday's data carries the date Tuesday, the rules see the future, and the backtest looks better than anything you could have done. The plugin cannot tell which of these a file does. Dating the rows wrongly is the classic way to cheat by accident, so the result carries a note whenever a rule reads a column, and the helper window repeats the rule.

- A file of signals is read as dated values, however far apart its rows are: in a weekly or monthly file, or one with a row only on the days something happened, each row is known at the end of the day it is dated, and a file with a single row is read from the end of that day on. In a file whose rows are less than a day apart, such as one an hour, a row is known at its time plus the shortest gap between rows, so date each row with the start of the span its value was worked out over.
- A file with prices is a file of bars, and its columns belong to their bar: they are known when it ends, as its close is. A weekly file's row dated Monday, columns and all, is read from the next Monday, so a value written on a weekly or monthly bar must come from that bar's close or before. The step is the shortest gap between its rows, counted in calendar months from a step of 20 days.
- With `fill: close`, a rule reads a ticker on other hours one bar earlier (rule 6). A file counts as being on other hours when it comes from another source than the ticker the rule trades (a Yahoo ticker and a CSV file are two sources), or has rows on other days of the week, or has rows of another length. Then a rule at Tuesday's close reads the row dated Monday: the order fills at Tuesday's close, before Tuesday's row is known at the end of that day. Two CSV files with rows on the same days are read day for day, and the result notes that it takes the row as known at the moment of the fill. The file's note says which rule reads which row.
- A CSV file is read each time a block runs and is never saved in the plugin's cache, so a changed file is read afresh, and a result runs again when the file's modified time changes.

### What is saved on disk

Prices from Yahoo, Binance and Tiingo are saved in `<plugin folder>/cache`, one JSON file for each source, ticker and interval, and a FRED series in one file whatever the interval, with the note on its backfill when it has one. The plugin folder is `<vault>/.obsidian/plugins/backtest-blocks/`. The file names hold the source and the ticker or series ID only. No API key is saved there or in the settings, which hold only the names of the secrets. The smaller bars of `magnify` are saved the same way, under their own bar size. Binance's are kept in a file of their own, apart from a block's own bars of that size, and cut to the latest 100,000 each time they are refreshed. The files are treated as fresh for the "Keep saved prices for" time (6 hours by default). After that the plugin fetches again. If the fetch fails and a saved copy exists, the copy is used and the result says: "Couldn't refresh X (reason); using prices saved on DATE." An `account` block with a `fills` line also saves the daily prices as they traded, unadjusted for later dividends and splits, of the Yahoo and Tiingo tickers it compares your fills on, in files of their own whose names start with `raw-`. If you sync the `.obsidian` folder, the saved prices go with it. "Clear saved prices" removes the folder.

Each strategy block's tries and versions (see "How many tries" and "Versions") are saved in `<plugin folder>/ledger`, one JSON file for each block, named by a hash of its note and its name or place. A file is written about 2 seconds after a change, and when the plugin is turned off. Before writing, the plugin reads the file again and merges it with what it holds, so a copy that a sync brought in from another device is joined, not overwritten: the tries and versions of both are kept, less the tries from before the latest "Start the count again". Deleting the folder forgets every block's tries and versions.

The plugin's settings are in `data.json` in the plugin folder. Results are kept in memory only; of what a block has done, only its tries and versions are saved. A forward test is a note in your vault, not a file in the plugin folder (see "Forward tests").

### Network requests

The plugin contacts these hosts, and no others:

- `query1.finance.yahoo.com` and `query2.finance.yahoo.com`, when a block uses a Yahoo ticker. The request holds the ticker, the bar size and a start and end time.
- `data-api.binance.vision`, when a block uses a Binance ticker. The request holds the market symbol, the bar size and a start time.
- `api.tiingo.com`, when a block uses a Tiingo ticker, or Tiingo stands in for Yahoo. The request holds the ticker, a start day and the bar size (daily) in its address, and your Tiingo API key in its `Authorization` header.
- `api.stlouisfed.org`, when a block uses a FRED series. Each request's address holds the series ID, your FRED API key and the answer's format, and either a page of the days the series was published on, or the real-time days asked for: the first of those days, or a window of later ones with `output_type=4`, which asks for each value as first released.
- A block with `magnify` makes the same requests for its smaller bars, to the Yahoo and Binance hosts.
- A `forward` block runs its frozen rules like a `strategy` block, so it makes the same requests as a block with those tickers, when it is drawn and when you press "Refresh prices".
- The "Regimes and crises" section makes the same requests as a block with those tickers, to the same hosts, for the daily bars of SPY, `^VIX` and `^TNX` from Yahoo, or of `BTCUSDT` from Binance for a strategy that trades only there, and only when you press its button "Load SPY, ^VIX, ^TNX from Yahoo" (or "Load BTCUSDT from Binance"). It asks for nothing before you open the section, and nothing when those prices are already saved and fresh.
- An `account` block with a `fills` line makes the same daily request to Yahoo, or to Tiingo for a ticker whose prices came from Tiingo, for each ticker that you or its strategies traded since `fills from`, to read the prices as they traded each day. It asks only when your file has fills from that day on, and only when that ticker's saved copy is missing or no longer fresh, and never for a Binance or CSV ticker, whose prices are as traded already. Your file itself is read from the vault and sent nowhere.
- `api.anthropic.com`, only when you draft a strategy with the Anthropic provider and no server address.
- The server address you enter, only when you draft a strategy. That can be a server on your own machine.

Two features make requests on their own, to the price hosts above and no others:

- The check for orders when Obsidian starts runs every strategy in the vault a few seconds after start-up. It fetches the prices of every ticker they use, Tiingo tickers and FRED series included, and the smaller bars of a block with `magnify`, that are not saved or are older than the "Keep saved prices for" time. The setting "Check for orders when Obsidian starts" turns it off. The orders window and a `backtests` block do the same when you open them. Each Tiingo ticker and bar size is one request, and Tiingo's free plan allows about 50 an hour.
- The ticker lookup, while "Look tickers up while writing" is on, which is the default, sends two kinds of request. Neither carries a note's name or text.
  - A search on `query2.finance.yahoo.com`, then `query1`, at the path `/v1/finance/search`. The query is only a ticker: the word you typed where a ticker goes (250 ms after the last key, and only when it is not already one of the block's tickers), or a Yahoo ticker that a strategy block on screen names in its `universe`, `symbol`, `benchmark` or `cash rate` line or after `of` (0.7 seconds after typing stops, at most 6 each time, and not the one the cursor is in). At most 24 characters from `A-Z a-z 0-9 ^ . _ = -` are sent, and nothing else. Starting what you type with `binance:`, `csv:`, `tiingo:` or `fred:` keeps it from being sent. A CSV file, a Tiingo ticker and a FRED series, even when a rule names one by its bare name, are never looked up, and neither is any plain ticker of a block whose tickers come from Tiingo.
  - The list of Binance prices, `data-api.binance.vision/api/v3/ticker/price`. It carries no parameters and no text from your notes. It is fetched the first time a Binance ticker is checked or a plain word is completed, and again after 6 hours.
  - Answers are kept in memory only. At most 2 lookups run at once. A failed lookup is silent and is not repeated for 30 seconds, and 3 failures in a row pause that host for 60 seconds.

The command line and MCP server (see "For language models and tools") contact the same price hosts, from the machine they run on, only when they run a backtest (`run`, or the `run_backtest` tool), and with the `User-Agent` `backtest-blocks`. Checking a block, explaining a word and the rest make no requests.

Nothing else leaves your vault. There is no telemetry, no analytics, no update check and no remote code. No note's text is sent anywhere. The only words taken from your notes are ticker symbols, and only for the lookup above; what is described under "Drafting from plain English" goes to a model. The plugin sets no `User-Agent` of its own: the request carries whatever Obsidian's `requestUrl` sends.

## How far to trust it

**What has been checked**

- Unit tests cover the language, the indicators (the newer ones each against a second implementation written from its definition), the engine's rules (fills, costs, commission, slippage, stops, gaps, rebalancing, ranking, sizing, positions built in entries, looking inside bars with `magnify`, warm-up, interest, short positions, flips and leverage with their fees, interest, margin calls and ruin, reading other tickers and CSV columns by when their bars or rows end, the test split), the lookback, the statistics, the comparison, the Yahoo, Binance and CSV readers with saved responses, the saved-price logic with a fake network, orders and the status bar count, the `backtests` block, the explanation of each trade, the bar-by-bar table (against every trade of varied runs), rewriting parameter values in a note, the background jobs with a fake worker, the size and time limits, the starter strategies and the CSV helper, hover help, fixes and the ticker lookup with a fake network, exports, settings and drafting with a fake model.
- A cross-check against a second backtester. `xcheck/` generates nine synthetic tickers over 3,000 days and runs 44 strategy pairs and 55 indicator expressions through this engine and through Rearview, a separate backtester that is not part of this repository. It compares the indicator values on every bar, every trade's days, prices, reason and bars held, the equity curve and exposure day by day, and the totals and pending orders. Seven of the 44 cases fill at the close, against Rearview's `fill same_close`, three charge a `commission` (a fixed one, one per share with a minimum, and one on rebalancing trades), and four build positions in `entries` (with a stop and target, a trailing stop, and filled at the close), where each entry's day and price is compared. The check found one real bug (a bar that opened above the take-profit and then fell through the stop was booked as a stop loss), which is fixed. The two engines differ by design in some rules, and the check explains a difference only when it matches one of them: sizing (money here, shares there), the re-arm rule, a halted ticker, the trailing stop on the entry bar (and, with `fill: close`, where it starts), slipped targets, the timing of a rebalance, how bars held are counted, a sell rule while flat, the first ATR (which also moves `keltner_upper`, `keltner_lower` and `supertrend` by a bar), how interest counts days, the Sharpe ratio, and adds and rebalancing trades too small for their commission (rule 49), which Rearview makes. The table is in `xcheck/README.md`. Of the 22 functions added after the first twelve, 20 are compared with Rearview's on every bar of every ticker, to 1e-9: `obv` through a sum of signed volume and `vwap` through Rearview's `vwma` of the typical price, and `correl` only on tickers that have every day. Cases that short or borrow compare short positions opened and closed by rules, flips between long and short, a short's stop and target, borrow fees, and leverage with interest on borrowed money, against Rearview's margin account. Their prices stay clear of a margin call, so margin calls and ruin are not compared, and `xcheck/README.md` lists where the two engines' rules for borrowing differ. The check is run by hand and is not part of `npm test`. It passes with the code of this release.
- Short selling and leverage have checks of their own. Hand-worked cases, with the figures worked out by hand: a short paying a borrow fee, a flip filled at the close with slippage, a short's stops (a gap through the stop, a stop inside the bar, the target at the open, `magnify`, and a trailing stop from the lowest low), 150% long paying a 6% margin rate for a year, a long in one ticker and a short in another at 100% each, a margin call at the 25% level, a ruin, the buy and short rules holding together, rebalancing a 50% short, and each side re-arming on its own. A reflection test runs short strategies on random prices and the same rules as long ones on the prices turned upside down, and checks that their trades match in time, reason and bars held. A reference simulator, written apart from the engine in the test file for one ticker with fills at the next open, agrees with the engine to 1e-9 of the starting money over 200 random long, short and leveraged cases, margin calls and ruins included. A fuzz test over 800 random long, short and leveraged strategies checks that equity is always cash plus the positions at their closes, that the gross value is within the cap after each buy or short sale, that an exit leaves no shares, that what a run pays is never below 0, that every fill lies inside its bar, that a margin call closes every position at its next bar, and that nothing trades after a ruin. Eight of the cross-check's cases short or borrow: a short on a trend, a flip filled at the next open and one filled at the close, 150% long paying margin interest, a short with a stop, a target, costs and a commission, a short with a trailing stop, one ticker long and another short at 100% each, and two margin calls, which land on the same day at the same price in both. Where the two differ by design, the cases are chosen around it, and `xcheck/README.md` lists each difference: Rearview waits a day between closing one side and opening the other, sizes from the signal's close rather than after the night's interest, keeps shorts to whole shares, leaves a short's daily gain or loss out of the balance it charges interest on, and on a margin call sells the biggest losers first rather than everything. Before this release, every figure of the long-only strategies in this reference and among the starters, and of 1,000 random long-only strategies, was compared with the release before, and none had changed.
- The "Regimes and crises" section has unit tests on hand-built prices, with the figures worked out by hand: that a state is read only from daily bars that had ended, so the step into the bar where a state turns is not put in the state it created, on daily, weekly and hourly runs; that a tenfold change in the scale of `^TNX` makes its state unknown until it is 126 bars behind; the share, compounded return, the benchmark's return over the same steps, exposure and worst drawdown of each state, including a fall in one stretch not being carried into another; when a return is per year; which falls a run covers, at the day and at the bar edges, for daily, weekly and hourly runs; the day equity got back to its earlier high; the Binance-only and CSV-only cases; and that loading the market's prices leaves a run's own prices and result as they were.
- Forward tests have unit tests with figures worked out by hand: that the frozen text reads back as the very same strategy (compared with what the parser makes of each) under any defaults, whether the strategy writes none, some or all of the pinned settings, ends inside a `for` section, or has a commission; the refusal of a `to` line; that the check follows the text and ignores trailing blank lines and line endings; every problem a block can have, with its line; the gain and the fall of a forward test against earlier stretches of the same length on a series worked out by hand, ties, and the wait for 5 bars and for 3 times as many before; the fast window method against working every window out on its own, on random and flat series; which bar each order of a run is dated at, against the bar each trade really filled at, with fills at the next open and at the close, entries, rankings, stops and rebalancing; appending to the log (once, never rewriting a row, only after the last logged bar, a table changed by hand refused, Windows and Unix line endings, with and without a final line break); and revisions. The `forward` block in this file is parsed and its check verified. The write goes through a stand-in for Obsidian's `vault.process`.
- An independent review of the engine and the statistics, which confirmed each finding with a script. It found defects that are now fixed, each with a test: on mixed calendars (stocks with crypto) a ticker could miss its rebalance and a ranking buy could leave its slot in cash; a ticker with longer bars, a daily benchmark or a daily yield on shorter bars could be read before its bar had ended; entries were sized or left without their ATR stop while those inputs warmed up; and results could depend on which prices happened to be saved. It also corrected statistics (a benchmark whose prices start later, Sharpe and Sortino made of rounding noise, the `test from` split, two different Sortino ratios), and runs of more than about 125,000 bars no longer fail. A review finds what it looks for; this one does not show that no other defects remain.
- A trial in a running desktop Obsidian 1.15, with live prices, of the parts that depend on Obsidian itself, made before this release. These worked: the Parameters bar and its sliders; writing values into the block from the bar and from a sweep, in reading view and in live preview, including right after typing in the note; "Explain this trade"; the sweep in the background worker; the strategy preview panel as the cursor, the text and the problems change; "Fix the problem at the cursor" and the underlines; the `backtests` block; the starter strategies window; the CSV helper's file list and its reading of a file; folded results with the Compact setting; and the count in the status bar.
- A second trial in the same desktop Obsidian 1.15, with live prices, of parts of this release. These worked: a strategy with `commission` and `entries` with an `add when` rule (the result, its costs line and the colouring of the add rule); a strategy using `supertrend_up`, `adx` and `zscore`; a `magnify: 1h` strategy on a Yahoo ticker, with its note; a strategy reading `column(score)` from a signals CSV file, with its dating note; the time limit of 10 seconds stopping a slow strategy on one-minute Binance bars, with its message and button; and the "Rule values, bar by bar" table opening, moving to a trade and showing the buy, sell and add columns.
- A third trial in desktop Obsidian 1.15, with live prices, of every command, block, window and setting, in a vault of its own, on 17 November 2026. It found eight defects, now fixed, each with a test: Yahoo bars stamped at the exchange's midnight (weekly bars, currency pairs) were dated a day early in summer; a CSV file's lookback was worked out from `interval` rather than from its own rows, so a weekly file started with indicators still warming up; ticker suggestions did not show while typing at a normal pace; hovering a chart raised an error in Obsidian; two-word values were not completed after their space; and three messages did not say which file, which setting or which range. Besides what the first two trials covered, these worked: the size refusal and "Run it anyway"; the time limit; the foreground fallback, with workers blocked; the bar-by-bar table's paging, dates, trade steps, filter and CSV save; the line and "Run again" after a default setting changes; offline runs on saved prices; the three save buttons; the sweep with its Stop and "Use these values in the block"; the luck checks and "Shuffle again"; `compare` blocks and their errors; the `backtests` block's folders, sorting and "Run again"; "Today's orders" with its note, its refusal of a note the plugin did not make, and the status bar setting; note properties; completion, hover help, underlines, one-click fixes and their undo; the ticker lookup; the preview panel with its slider; all nine starter strategies; the CSV helper on awkward files, its form for choosing columns and its cleaned copy; drafting against a stand-in server in both formats; every field of the settings tab; clearing saved prices; turning the plugin off and on, and a reload; the result view at phone width in Obsidian's phone emulation; and every strategy block in this README.
- A fourth trial in desktop Obsidian 1.15, with live prices, on 17 November 2026, of fixes to how the plugin keeps track of runs. Each defect was first seen in 0.4.1 in Obsidian, then gone with the fix: after "Run again" under a `backtests` block, or "Refresh prices" in the orders window, pressed while another round was running, 9 and 11 strategies stayed on prices three days old; a result worked out late in its prices' freshness kept today's orders on them; "Run checks again" could start while "Shuffle again" ran, and Stop then left checks running; the preview panel stopped following the block after "Try again" and an undo; a block that went away while its kept result came back was still drawn; one slow start of a background worker sent every later run to the foreground; and the count in the status bar waited the full "Keep saved prices for" time after "Couldn't check orders" when every strategy failed. Also tried again with the fixes: a result made offline, which is kept without trying the download at every drawing; a block and its Refresh prices; a slider and writing its value; the sweep, run to the end and stopped; the luck checks; today's orders saved as a note; and a CSV block after its file changed.
- Trigger prices against the engine. For each price a report gives, a test adds the bar the price assumes, once at the price and once 0.015% beyond it, runs the strategy again and checks that the order is there at the price and gone beyond it: the nine starter strategies at 41 points of their history, and 160 random strategies at 6 points each (closes, averages, crosses, other tickers read with `of`, `fill: close`, stops, targets, trailing stops, `entries`, `bars_since`), about 640 prices in all, worked out on prices cut short where that is allowed and checked on the whole prices. Since the engine reads the same made-up bar, this checks the search and the reading of the rules, not what the bar assumes. For rules that read FRED series and CSV files of columns, a second test makes the next bar itself, as the engine would get it: the ticker's own bar and no new row of the series, or, for a rule solved for a FRED series, the series' next value; at the prices, just beyond them and at closes across the range, the order must be there exactly where the report says (a monthly, a daily and a weekly series at 26 points each, with both fills, and 4 rules solved for a series that goes below 0, at 26 points of 3 series). Unit tests add a stop reached inside the bar, a stop above the last close, the re-arm after a stop, warm-up, a stock read by Bitcoin's close, `month_end`, the words, and that the run's own prices and state are left as they were.

- The overfitting checks have unit tests: the normal distribution and its inverse against values worked out to many more digits; the deflated Sharpe ratio against the worked example of Bailey and López de Prado (100 tries whose Sharpe ratios a year have a variance of 0.5, a Sharpe ratio of 2.5 a year over 5 years of 250 bars, skewness −3 and kurtosis 10 give SR₀ = 0.1132 a bar and a deflated Sharpe ratio of 0.9004); the probability of backtest overfitting against a case worked by hand (4 parts, 3 variants) and on made-up sweeps (about one half for variants with no edge, also for 3 to 7 of them, near 0 with one real edge); that blocks that trade alike count as one try and that anything that can change a trade counts as another; how two copies of a block's record merge; and the changed lines against a slower count of the longest common run of lines.

- The `account` block has unit tests with figures worked out by hand: the target and order of each ticker for every kind of order a strategy can have waiting, two strategies sharing a ticker, netting and what it spares, the band, whole and fractional shares, buys cut to the cash, a strategy at 0%, and the notes. "How to split" has them for the simplex projection and each method against cases worked by hand, for the shrinkage against the formula of Ledoit and Wolf, for weights that use no later month, and for whole percentages that add up. The broker files are read from example files with titles above and notes under the table: Schwab, Fidelity (two accounts in one file), an Interactive Brokers activity statement and a Flex query, and files with renamed columns. The matching has a test for each kind of fill, a split, prices as they traded, and that the total is exactly the sum of its parts. An independent review of these parts found five defects, now fixed, each with a test: a day of fills could cover only one trade, so buying on one day what the strategies bought over two, or over two days what they bought on one, was costed wrongly; a position opened and stopped out the same day left a trade that was never there; a date with the month's name, such as `Apr 13, 2026`, was read as 2001; the band left out a large sale of a single expensive share; and buys cut to the cash could all come to nothing when one still fitted. An Interactive Brokers file that lists both an order and its executions is read once per order. A second review found six more, now fixed, each with a test: every strategy's fills of a ticker were converted with one strategy's bars, so a weekly strategy's were off by a dividend, and a daily one's were not compared at all once an hourly strategy traded the ticker too; orders at the same open did not net when their strategies' prices were adjusted differently; a late fill was compared across a split or a dividend; the strategies' shares were counted after later splits; lateness was counted in the strategy's own bars, so in weeks for a weekly one; "Use these weights" wrote whole percentages, which could add up to less than the block's total, or to 0%; and a `fills columns` header with a `+` in it did not read back. Writing weights and the `fills columns` line into the block is tested in callouts and with Windows line endings, and refused when the block changed. Yahoo's prices as they traded are worked back from a hand-made answer with a 4-for-1 split, and the orders window's Accounts group from strategies run on made-up prices.

**What has not been checked against anything**

The second backtester has nothing to compare these with, so they rest on the unit tests (and the review) only:

- Forward tests: the comparison with earlier stretches is arithmetic with no second implementation. The `forward` block, its buttons and the note they write were tried in a running Obsidian on 2026-11-17: starting one with a slider moved, the log button (a second press adds nothing), edited rules and an edited start, a note not made as a forward test, and default settings changed after the start. A forward test shows how rules did on bars they were not chosen on; a few bars, or a few weeks, say little about them. The log is dated from the run's own record of its orders, and a revision to adjusted prices can still change what a past bar would have given.
- `magnify`: Rearview reads each bar whole.
- A column of a CSV file as a value in a rule.
- A commission's `max`, and adds or rebalancing trades left undone for their commission.
- Entries combined with a rebalance, a ranking, risk per trade, inverse-volatility weighting, ATR stops, slippage or a commission.
- Margin calls and ruin, and shorts combined with `entries`, `risk per trade`, `magnify`, rebalancing, a commission or `fill: close`. Margin calls and ruin rest on the reference simulator and the fuzz test above.
- Inverse-volatility weighting, a cash rate from a ticker, ATR take-profits, `entry price` in sell rules, calendar values (`month`, `month_start` and the others), yearly rebalancing, ranking with `rebalance: never`, stops in ranking or rebalancing strategies, slippage on rebalances with weights under 100%, `of` on a day the other ticker has no bar, the benchmark, `test from`, and weekly or intraday bars. The cross-check of `fill: close` uses daily bars only.
- The functions with no counterpart: `supertrend_up` (the line it follows is compared), `bars_since`, and `correl` on tickers with missing days or other calendars. The unit tests check each against a second implementation written from its definition, on thousands of random bars.
- The functions and calendar values added after those: `sum`, `dema`, `tema`, `kama`, `aroon_up`, `aroon_down`, `psar`, `cmf`, `linreg`, `rsquared`, `efficiency`, `streak`, `sqrt`, `log`, `exp`, `if`, `quarter`, the `week`, `quarter` and `year` conditions, `trading_day` and `trading_days_left`. They are not in the cross-check, so they rest on the unit tests alone: values worked out by hand, a second implementation written from each definition and compared on thousands of random bars with gaps (for `psar` also the properties of the line, that it is always on the far side of the bar, and for the calendar values the same days counted with `Date`), a check that no value reads a later bar, and the history each needs. `kama` and `psar` follow conventions (TA-Lib's seed, the first two bars) that other programs differ on, so their values can differ from a charting package's by where they started even when each follows its own definition. The history a run loads for them is chosen from tests on made-up prices, not proved: `kama` over a long stretch of chop and `psar` before any reversal can still start a little differently from a run with all the history.

Also not checked:

- The `account` block, "How to split" under a `compare` block, the form for naming a file's columns and the orders window's Accounts group were tried in a running Obsidian on 2026-11-17, at desktop and phone width, and the cost of not following the rules was worked out again by hand from a file of 13 fills, the same from each broker's format. The broker files they read are built from each broker's documented headers and action words, not from real exports: a broker that names a column or words an action differently needs a `fills columns` line, or its rows are listed as not read. Prices as they traded have not been downloaded from the live services: Yahoo's are worked back from its split events, which assumes its prices are adjusted for splits as its documentation says, and Tiingo's are its own unadjusted fields.
- Trigger prices were tried in a running Obsidian on 2026-11-17 on live prices: the "Next close" column for a trend, a ticker held with its stop and target, a ranking, `fill: close`, a rule reading `high` and a ticker read with `of`, the orders window's "Watch at the next close", the saved orders note and the tooltip. One level was worked out again by hand. Holidays, an exchange's half days, and the hours of a market that is closed overnight are not known when the next bar is placed.
- The Parameters bar with `entries` as a parameter has not been tried in a running Obsidian, nor the bar-by-bar table's question before a CSV file of over 20 MB. They have been checked by unit tests and, for what is drawn, in headless Chrome, with stand-ins for Obsidian's own objects.
- `magnify` has been checked on four saved real Yahoo responses and on a comparison of SPY's hourly and 5-minute bars with its daily bars (492 sessions), and three live pages of Binance's bars were downloaded. In the plugin it has been run on live prices only with SPY's 1-hour bars, and the smaller bars of exchanges with a lunch break, such as Tokyo or Hong Kong, and of futures or currencies have not been tried. A day whose smaller bars do not cover its session or do not match the bar is read whole, and the notes say so (rule 63).
- The "Regimes and crises" section was tried in a running Obsidian on 2026-11-17, with SPY, `^VIX` and `^TNX` from Yahoo and `BTCUSDT` from Binance, at desktop and phone width. Buy and hold's return through three falls was worked out again by hand from the saved closes, and the dates of Bitcoin's falls were checked against Binance's daily closes. The dates of the falls are entered by hand, with the closing high and low of the S&P 500 and of Bitcoin, and the plugin does not check them against prices. Yahoo has quoted `^TNX` in different units at different times, and the section takes a jump of more than threefold between two closes for such a change; a real move that large would be taken for one in the same way. A state is a description of what already happened, read from data known at each close. A few years in a state is a few separate stretches, since a 200-day average turns only a few times in a decade, so a figure for a state says little more than that, and a strategy chosen because it did well in one state has been fitted to this history again.
- The result as drawn since 0.7.0 (the verdict, the figures, the chart and its read-out, "At the next close" and its scale, the tabs and the folded line) was tried in a running Obsidian on 2026-11-18, light and dark, at desktop, preview-panel and phone width, with long, short, leveraged, ranked, weekly, hourly and `to`-dated blocks and an hourly run of about 77,000 bars. The verdict's figures were checked by hand against the run's end values. Its sentences are fixed wording filled in with the run's figures, not written by a model.
- The count of tries, "How many tries", the overfitting check of a sweep and the Versions section were tried in a running Obsidian on 2026-11-17: tries from sliders, a sweep and a walk-forward check, the count after a reload, a renamed note and the strategy preview, a restored version, and one refused after the note changed. Their words, figures and the writing of a restored version into a note have unit tests.
- A real phone. The plugin has never been run on one, though the manifest does not rule it out. The result view, with the Parameters bar, has been looked at in Obsidian's phone emulation on a computer. The other newer parts (the preview panel, the windows, the `backtests` table, the bar-by-bar table) have been drawn at phone width only in a browser with stand-ins for Obsidian's own objects.
- Drafting has never been run against a live model at the time of writing. The tests use a fake server, and the third trial a stand-in server.
- The drawing of the charts and the layout uses the DOM and has no automated tests. Only helpers such as tick spacing and marker placement are tested.
- The cross-check used made-up prices. It says nothing about the data feeds.
- Tiingo and FRED were first run against the live services on 2026-11-17, in an isolated Obsidian with keys from a password manager. Tiingo's SPY gave the same 31 trades as Yahoo's from 2015 and a return a year 0.1 point apart; `data: tiingo` read a plain `^VIX` from Yahoo; with Yahoo failing, a ticker with no saved copy came from Tiingo with its note; offline, saved Tiingo and FRED copies were used with a note. That run found that FRED refuses an answer covering more than 2,000 publication days, which every daily series has, and that an answer of first releases leaves out what a series held when ALFRED first kept it (T10Y2Y before 2014, DGS3MO before 2005); both are why a series is now asked for as described under "FRED". FRED's `realtime_start` in such an answer was seen to be the day each value came out. No file the plugin wrote held either key. These still rest on the documentation alone: how Tiingo spells a share class such as `BRK-B` and words its answer for a ticker it does not know.

**Limits of any backtest**

- Yahoo prices are adjusted for later dividends and splits, so old prices are lower than what actually traded. A rule that compares a price with a fixed number, such as `close > 100`, then means something different in 2005 than today. The plugin warns about it on that line, unless every ticker it reads is an index, which Yahoo does not adjust. Compare with averages, percentages or earlier prices.
- Tiingo's prices are adjusted for later dividends and splits too, and the same note is given for them. Its weekly bars are made from its adjusted daily ones, where Yahoo adjusts a whole week by its last day, so the two can differ a little in a week with a dividend.
- A FRED value is read as it was first published, never as revised later, so a series can look different from FRED's chart today: the rules see what could have been known. A value from a backfill is the exception: it is the figure known on the day the series came into ALFRED, which may already include revisions, and its date is an estimate, from the delay of the series' other values. A value counts as known at the end of the day it was published (UTC). With `fill: close` every value is read from the day after it was published, since many come out after the close.
- Yahoo only lists tickers that exist now. A test over a basket of today's tickers is a test of survivors, which flatters the results.
- A backtest overstates what to expect, and more so after you have tried many variants. Each rule, parameter or variant you try on the same history raises the chance that the one that looks best fits noise. `test from`, "Try other parameter values" and "Was it luck?" help you see this. They do not remove it, and "How many tries" counts only what you tried in the plugin.
- Shorts and borrowing are modelled simply. Every short pays the same borrow fee, whatever its stock would really cost to borrow: there are no hard-to-borrow lists, no per-stock borrow rates, no recalls of borrowed shares and no short-sale price restrictions (Rule 201 of Regulation SHO). A short pays a stock's dividends only through the adjusted prices: the price does not drop on the day a dividend is paid, so the short does not gain that drop, which is about what paying the dividend would cost. Money borrowed pays one rate, however much is borrowed. A broker's margin call sets a level for each position and sells the biggest losers first until the shortfall is covered; here equity is set against 25% of the gross value, and a call closes everything.
- Real fills differ from the next open and from the close: spreads, size and liquidity, outages, and your taxes are not in the numbers. A run with `fill: close` assumes you can trade at a closing price that is not known until the close. A real order can only come near it, by being placed just before the close.

## For language models and tools

The language is small enough for a model to learn from one document, and the plugin's parser can check what a model writes outside Obsidian too.

### Files for models

These are made from the plugin's code by `npm run generate`, and a test fails when one no longer matches it, so they list exactly what the parser takes:

- `llms.txt`: an index of the files below, in the layout of llmstxt.org.
- `llms-full.txt`: everything a writer needs. What a block is, the language (the same text the drafting command sends, see "Drafting from plain English"), worked examples, and how to check a block.
- `docs/language.json`: every function, series, calendar and position value, setting (with its fixed values), word and unit, with its form, meaning and an example, and the names a parameter can't take.
- `docs/corpus/examples.jsonl`: requests in plain English and the blocks that answer them, with what the writer told the reader, one JSON object a line. Every block parses with no problems, and together they use every word of the language.
- `docs/corpus/mistakes.jsonl`: blocks with a mistake a writer is likely to make, the parser's exact messages, and the block put right.
- `docs/grammar/strategy.lark` and `docs/grammar/strategy.gbnf`: the text of one block (without its fence) as a grammar, for models that generate under one: Lark for grammar-constrained tools such as OpenAI's, vLLM and llguidance, GBNF for llama.cpp.

The grammar keeps a model to the language's shape: known settings with their values, known function names, rules, parameters, definitions and `for` lines. It takes more than the parser does, though. A name can be any identifier, an expression is a flat run of operands and operators, and what a block means (which names exist, which rule may read what) is the parser's to say. Words must be in lower case, as the examples write them, while the parser also takes `Buy When`. So check what a grammar produces, as with any other draft.

### The command line

Each release carries `backtest-blocks.mjs`, one file for Node.js 20 or later with no install step. It reads notes as they are in a vault, or a bare block on standard input (`-`).

- `check <note>...` checks every `strategy` block in each note, or the whole text when it has no strategy fence, and prints each problem as `note.md:12:5: error: message`, with the line and column counted in the note, past the markers of a callout or quote. The count of blocks and problems goes to standard error. It exits with 0 when no block has an error, 1 when one has or a note has no strategy block, and 2 when the command is wrong or a note can't be read; the other notes are still checked and their problems printed. Warnings don't fail it. `--json` prints the problems as data.
- `run <note> [--block name|n]` backtests one block on live prices and prints the verdict, return per year, total return, worst drawdown and Sharpe ratio against the benchmark, the trades and what it holds now. A note with several blocks needs `--block`, by name or number from 1. CSV files are read from the vault the note is in (the folder above it that holds `.obsidian`), or from `--vault`, as Obsidian reads them, and never from outside it. Prices are saved in `$XDG_CACHE_HOME/backtest-blocks` or `~/.cache/backtest-blocks` (`--cache` chooses another folder) and kept for the plugin's default time; `--refresh` fetches them again. Tiingo and FRED read their keys from `TIINGO_API_KEY` and `FRED_API_KEY`. It uses the plugin's default settings, and `--json` prints the result as data with the last ten trades.
- `explain <word>` prints a word's form, meaning and example, as the editor's help does, and suggests near words for one it doesn't know. A word can be given as a block writes it: `sma(200)`, `stop loss: 10%`, `rebalance: monthly`. `words` lists every word (`--json` gives `language.json`), and `guide` prints `llms-full.txt`.

### The MCP server

`node backtest-blocks.mjs mcp` serves the same over standard input and output, for Claude Code (`claude mcp add backtest-blocks -- node /path/to/backtest-blocks.mjs mcp`), Claude Desktop, Codex or any other MCP client:

- Tools: `check_strategy` (a block or a note; errors and warnings with their lines), `run_backtest` (a block or a note, with `block`, `vault_path` and `refresh`; the same result as `run`), `explain_word` and `list_words`. Only `run_backtest` reaches the network.
- Resources: the guide, the word list, the examples, the mistakes and both grammars.
- Prompt: `write_strategy`, which gives a model the drafting command's own instructions and the idea, and asks it to check its block with `check_strategy` before it replies.

## Development

```
npm test           # unit tests, each .ts file run directly by Node
npm run generate   # write llms.txt, llms-full.txt and the files for models under docs/
npm run typecheck  # tsc --noEmit
npm run build      # type check, then bundle into dist/
npm run check      # everything a push or release must pass (ci/check.sh)
node xcheck/run.ts # optional cross-check; needs the second backtester's command-line tool
```

Obsidian loads one script for a plugin, so the background workers are built into `main.js`: `npm run build` bundles `src/worker.ts` first (`esbuild.config.mjs`) and embeds its text in the main bundle, which starts them from that text. It then bundles `src/cli/bin.ts` with the MCP SDK into `dist/backtest-blocks.mjs`, which the check runs on two notes in `tests/fixtures/cli/`.

The cross-check runs 44 cases and 55 indicator expressions (`xcheck/README.md` lists them and the differences it explains). It needs Rearview's command-line tool, `rvw`: the path in the `RVW` environment variable, or else `rvw` on `PATH`. Without it the script says so and exits 0.

The checks run on your own machine; the repository has no hosted workflow. `sh ci/check.sh` (or `npm run check`) runs the tests, the type check and build, checks the built files and the version files against each other, and runs the cross-check when `rvw` is found; it stops at the first failure. A file `ci/local.env`, which is not in git, can set `RVW` for that machine. `git config core.hooksPath ci/hooks`, run once in a clone, makes every push run the check first.

`sh ci/release.sh` releases the `version` in `manifest.json`. It refuses unless you are on `main` with nothing uncommitted and `main` matches the remote, the tag and the release do not exist yet, and the whole check passes with the cross-check. Then it tags the commit, pushes the tag and publishes a GitHub release with `main.js`, `manifest.json`, `styles.css` and `backtest-blocks.mjs`, using `ci/notes/<version>.md` as the notes when that file exists. `--dry-run` runs every check and changes nothing; `--draft` leaves the release as a draft. It needs the GitHub command-line tool, `gh`. `versions.json` maps each plugin version to the minimum Obsidian version.

Layout of `src/`:

- `dsl.ts`, `docs.ts`, `complete.ts`, `highlight.ts`, `diagnostics.ts`, `fixes.ts`, `editor.ts`, `symbols.ts`: the language and the editor (parser, help text for hover and auto-complete, colours, underlines, "did you mean" fixes, ticker lookup).
- `evaluate.ts`, `indicators.ts`: evaluating rules, and the indicator maths.
- `engine.ts`, `backtest.ts`, `stats.ts`, `explain.ts`, `debug.ts`: the simulation (commission, entries and looking inside bars included), the benchmark, the statistics, the reasons behind each trade, and the value of each part of the rules at each bar.
- `price-memo.ts`: work kept for the next run on the same prices, so a sweep, a walk-forward or a slider works out each indicator and the benchmark once.
- `data.ts`, `runner.ts`, `result-cache.ts`: prices and their cache (the smaller bars of `magnify` and the columns of CSV files included), running a block, and keeping results in memory.
- `price-store.ts`: the saved price files, in the vault and in memory, the column names of the CSV files read, and whether a block's prices are all saved and fresh.
- `fred.ts`: a FRED series as rows a rule can read, each value dated by the day it was first published, and the values of a backfill dated by the series' usual delay instead.
- `results.ts`: running a block's text and keeping the result, so a block drawn again, the other blocks, the orders and the note properties reuse a recent run.
- `strategy-block.ts`: a strategy block's drawings: running it or reusing a kept result, drawing the result and its sections, and what a drawing leaves behind until the block is drawn again or goes away.
- `store.ts`: small records kept in the plugin's folder, one file for each, written a moment after they change and merged with any copy a sync brought in meanwhile.
- `vault-writes.ts`: writing into the vault: a note's `bt_` properties once its blocks have rendered, saved results under a dated name, and the CSV helper's cleaned copies under a free name.
- `compare.ts`, `dashboard.ts`, `orders.ts`, `orders-badge.ts`, `export.ts`, `rewrite.ts`: the compare block, the `backtests` block (its parser, sorting and running), orders, the status bar count of orders, the files, notes and properties a result can become, and writing parameter values into a block's text.
- `trigger.ts`: trigger prices: the closes at a ticker's next bar that would make its rules give an order, found by working the rules out again with that bar added, and how they are said in words.
- `sweep.ts`, `luck.ts`, `rng.ts`: parameter sweeps and the luck checks (reshuffled history, random entries, walk-forward), and the seeded random numbers they use.
- `regimes.ts`, `render-regimes.ts`: the "Regimes and crises" section: the market states and falls, putting each step of a run in the state known before it, the figures for each state and fall, and drawing them.
- `jobs.ts`, `worker.ts`, `worker-client.ts`, `limits.ts`: backtests, sweeps and luck checks as jobs, the two background workers that run them (one for single backtests, one for sweeps and luck checks), the plugin's side of them, which starts the workers, sends them prices and stops them, and the limits on how large one backtest may be and how long it may run.
- `overfit.ts`: the maths of the overfitting checks: the normal distribution, the deflated Sharpe ratio, and the probability of backtest overfitting by combinatorially symmetric cross-validation.
- `ledger.ts`: each block's record of the variants it ran and the versions of its text, how two copies of a record merge, and the lines that changed between two versions.
- `render-versions.ts`: the Versions section: each version of a block's text that was run, with its figures, the lines that changed from the one before, and putting an older one back.
- `llm.ts`, `llm-modal.ts`, `language-guide.ts`, `examples.ts`: drafting, and the guide to the language and worked examples it sends, which `llms-full.txt` carries too.
- `llm-files.ts`, `corpus/`, `grammar.ts`: the files for models (`npm run generate` writes them from `scripts/generate.ts`): the word list, the worked examples and mistakes, and the grammar with its Lark and GBNF forms and the recognizer the tests use.
- `cli/bin.ts`, `cli/main.ts`, `cli/node-deps.ts`, `cli/report.ts`, `cli/mcp.ts`: the command line and MCP server, `backtest-blocks.mjs`: the program, its commands, prices and files on Node, a run as text or data, and the MCP tools.
- `forward.ts`: forward tests: the note made from a strategy with the plugin defaults pinned in its text, reading its `forward` block and checking that the rules were not edited, the figures since the start against earlier stretches of the same length, the bars where a run's rules gave an order, and the log of orders with its appending and its comparison with today's prices.
- `render-forward.ts`: drawing the `forward` block: its figures, the sentences under them, the revisions, the log line and the button that adds to the log.
- `gallery.ts`, `gallery-modal.ts`, `csv-import.ts`, `csv-modal.ts`: the starter strategies and the CSV helper, each with its logic and its window.
- `account.ts`: the `account` block's settings and strategies, and the orders that bring an account to what its strategies hold together, netted across them.
- `allocate.ts`: how to split money between strategies: equal weights, inverse volatility, minimum variance and maximum diversification from monthly returns, worked out again each month from the months before it, and weights in whole percentages.
- `fills.ts`: a broker's export of trades read into fills (Charles Schwab, Fidelity, Interactive Brokers, or any file whose columns are named), and those fills set against the strategies' trades: slippage, fees, late fills and trades not made.
- `render-split.ts`: drawing "How to split" under a weighted `compare` block and in an `account` block, with its button that writes the weights into the block.
- `render-account.ts`: drawing the `account` block: its orders, how to split, and your fills against the strategies' trades, with the form that names an unrecognised file's columns.
- `live-core.ts`, `live-view.ts`: the strategy preview panel: choosing the block to show, and the panel.
- `render.ts`, `render-chart.ts`, `render-versus.ts`, `verdict.ts`, `render-now.ts`, `tabs.ts`, `render-params.ts`, `render-trades.ts`, `render-stats.ts`, `render-price.ts`, `price-chart.ts`, `render-debug.ts`, `render-sweep.ts`, `render-luck.ts`, `render-compare.ts`, `render-dashboard.ts`, `render-actions.ts`, `orders-view.ts`, `dom.ts`: drawing results, charts, tables and windows. `render.ts` lays out a result and its folded line, `verdict.ts` words its verdict and picks its figures, `render-versus.ts` draws them, `render-chart.ts` draws its value chart and the small one on the folded line, `render-now.ts` the "At the next close" panel, its scales and the mark of a near order, `tabs.ts` turns its sections into tabs, `render-stats.ts` draws the Years and Months tabs, `render-params.ts` the Parameters bar, `render-debug.ts` the bar-by-bar table, `render-sweep.ts` and `render-luck.ts` the sweep and luck sections, `render-compare.ts` the compare block and `render-dashboard.ts` the `backtests` block.
- `main.ts`, `blocks.ts`, `settings.ts`, `settings-core.ts`, `types.ts`: the plugin itself, settings and shared types.
- `format.ts`: how numbers, dates and times are written, and the ticks of chart axes, for the logic and the drawing alike.

`styles/*.css` are joined into `styles.css` when you build. `tests/` holds the unit tests, including `readme.test.ts`, which checks every `strategy`, `compare`, `account`, `backtests` and `forward` block in this reference and in the README.

## Licence

MIT. See `LICENSE`.
