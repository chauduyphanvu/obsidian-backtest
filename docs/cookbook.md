# Backtest Blocks Cookbook

Worked recipes for [Backtest Blocks](../README.md), ordered from single-ticker baselines to multi-note portfolios and live fill tracking. Every `strategy`, `signal`, `regime`, `universe`, `compare`, `account`, and `backtests` block in this guide is validated against the plugin's own parser and backtest engine in the test suite.

For the full language grammar, indicator formulas, and simulation rules, see [docs/reference.md](reference.md).

## Contents

- [Part 1 — Basics (First Strategies)](#part-1--basics-first-strategies)
  - [1. Simple trend filter](#1-simple-trend-filter)
  - [2. Moving-average crossover with confirmation](#2-moving-average-crossover-with-confirmation)
  - [3. Short-term RSI mean reversion](#3-short-term-rsi-mean-reversion)
  - [4. Multi-asset allocation with periodic rebalancing](#4-multi-asset-allocation-with-periodic-rebalancing)
  - [5. Exits and risk controls](#5-exits-and-risk-controls)
- [Part 2 — Rules, Position Logic & Real-World Realism](#part-2--rules-position-logic--real-world-realism)
  - [6. Per-ticker rules and stops](#6-per-ticker-rules-and-stops)
  - [7. Scaling in across multiple entries](#7-scaling-in-across-multiple-entries)
  - [8. Volatility-aware sizing and risk per trade](#8-volatility-aware-sizing-and-risk-per-trade)
  - [9. Cross-ticker, macro, and CSV regime filters](#9-cross-ticker-macro-and-csv-regime-filters)
  - [10. Calendar and seasonal rules](#10-calendar-and-seasonal-rules)
  - [11. Execution realism: costs, commissions, cash yield, close fills, and `magnify`](#11-execution-realism-costs-commissions-cash-yield-close-fills-and-magnify)
  - [12. Crypto and intraday timeframes](#12-crypto-and-intraday-timeframes)
- [Part 3 — Rotation, Shorts & Leverage](#part-3--rotation-shorts--leverage)
  - [13. Cross-sectional and dual momentum rotation](#13-cross-sectional-and-dual-momentum-rotation)
  - [14. Long/short trend following](#14-longshort-trend-following)
  - [15. Relative-strength and pairs trading](#15-relative-strength-and-pairs-trading)
  - [16. Leveraged multi-asset portfolio](#16-leveraged-multi-asset-portfolio)
- [Part 4 — Testing & Debugging Workflows](#part-4--testing--debugging-workflows)
  - [17. Parameter tuning without curve-fitting](#17-parameter-tuning-without-curve-fitting)
  - [18. Clause attribution and simplification](#18-clause-attribution-and-simplification)
  - [19. Stress-testing edge durability](#19-stress-testing-edge-durability)
  - [20. Debugging why a trade did or did not happen](#20-debugging-why-a-trade-did-or-did-not-happen)
- [Part 5 — Multi-Note Systems, Portfolios & Live Operation](#part-5--multi-note-systems-portfolios--live-operation)
  - [21. Shared vault building blocks (`signal`, `regime`, `universe`)](#21-shared-vault-building-blocks-signal-regime-universe)
  - [22. Strategy inheritance and parent-vs-child diffs](#22-strategy-inheritance-and-parent-vs-child-diffs)
  - [23. Comparing and combining strategies](#23-comparing-and-combining-strategies)
  - [24. Active book evaluation (`book: active` and In Book)](#24-active-book-evaluation-book-active-and-in-book)
  - [25. Going live with stop rules and fill tracking](#25-going-live-with-stop-rules-and-fill-tracking)
  - [26. Automating vault checks and research via CLI and MCP](#26-automating-vault-checks-and-research-via-cli-and-mcp)

---

## Part 1 — Basics (First Strategies)

### 1. Simple trend filter

**When to use it:** Start here as a baseline before adding filters or extra tickers. It stays invested during long uptrends and moves to cash during sustained declines.

```strategy
name: SPY 200-day trend
universe: SPY
from: 2005-01-01
costs: 5 bps
cash rate: ^IRX

buy  when close > sma(200)
sell when close < sma(200)
```

**How it works and what to watch for:**
- Rules evaluate at each bar's close and fill at the next trading day's open. Because `sma(200)` needs 200 prior closes, the engine automatically loads warm-up history before `from`.
- `cash rate: ^IRX` credits idle cash with the 13-week Treasury bill yield rather than 0%, which matters whenever a strategy sits in cash for 20–40% of the sample.
- Watch out for whipsaws in sideways markets (such as 2015 or 2022–2023). Comparing this baseline against more complex variants tells you whether extra clauses actually pay for their complexity.

### 2. Moving-average crossover with confirmation

**When to use it:** Use a dual moving-average crossover with a persistence window when a single close across a moving average triggers too many false flips.

```strategy
name: Confirmed MA crossover
universe: QQQ
from: 2005-01-01
costs: 5 bps

buy  when ema(50) crosses above sma(200)
  or ((close > ema(50) and ema(50) > sma(200)) for 3 bars)
sell when close < sma(200) for 3 bars
```

**How it works and what to watch for:**
- `a crosses above b` is true only on the single bar where `a > b` and `a <= b` on the previous bar. If the strategy was stopped out or started mid-trend, a pure crossover rule would wait months for the next cross; pairing it with a `for 3 bars` confirmation state lets it re-enter cleanly.
- Precedence matters: `for 3 bars` binds tighter than `and`, so `a and b for 3 bars` means `a and (b for 3 bars)`. Wrap `(a and b) for 3 bars` in parentheses when you want both conditions to hold together on all three bars.
- Confirmation delays entries and exits by a few days. In sharp crashes, waiting 3 bars below `sma(200)` adds slippage relative to an immediate exit—check both in the trade list.

### 3. Short-term RSI mean reversion

**When to use it:** Use short-horizon mean reversion to buy sharp pullbacks inside a longer-term uptrend and exit quickly on a rebound.

```strategy
name: SPY RSI(2) pullback
universe: SPY
from: 2005-01-01
costs: 5 bps
slippage: 2 bps

uptrend = close > sma(200)

buy when uptrend
  and rsi(2) between 2 and 15
  and roc(1) < -1% within 3 bars
sell when rsi(2) > 70 or close > sma(5)
```

**How it works and what to watch for:**
- `between 2 and 15` is inclusive at both ends (`rsi(2) >= 2 and rsi(2) <= 15`). Excluding extreme readings below 2 avoids catching falling knives on rare crash days, though you should test whether that lower bound actually helps (see Recipe 18).
- `roc(1) < -1% within 3 bars` requires at least one 1% down day in the last 3 bars (today included), filtering out quiet drift dips that barely moved price.
- Mean-reversion strategies trade far more often than trend followers and hold overnight gap risk. Always include realistic `costs` and `slippage`, and check exposure-adjusted returns alongside CAGR.

### 4. Multi-asset allocation with periodic rebalancing

**When to use it:** Use static weights with scheduled rebalancing to benchmark a diversified portfolio or build a permanent-allocation sleeve.

```strategy
name: 60/30/10 quarterly rebalanced
universe: SPY 60%, TLT 30%, GLD 10%
from: 2005-01-01
rebalance: quarterly
costs: 5 bps

buy when true
```

**How it works and what to watch for:**
- `buy when true` keeps every asset invested from the first available bar. `rebalance: quarterly` resets drifted weights at the start of each calendar quarter (`weekly`, `monthly`, `quarterly`, and `yearly` are supported).
- Either give every ticker in `universe` a percentage weight or give none of them weights (which splits `size` equally).
- The default benchmark inherits the block's initial weights and `rebalance` schedule, so a `buy when true` block matches its default benchmark 1:1. To isolate the rebalancing premium against drifting buy-and-hold, expand **Clauses** and mute `rebalance: quarterly`, set `benchmark: SPY`, or place a `rebalance: quarterly` block next to a `rebalance: never` block inside `compare`.

### 5. Exits and risk controls

**When to use it:** Add explicit price stops and profit targets when you want intrabar protection rather than waiting for a closing indicator to flip.

```strategy
name: ATR breakout with stops
universe: QQQ
from: 2010-01-01
costs: 5 bps
slippage: 3 bps
stop loss: 2 atr(14)
trailing stop: 3 atr(14)
take profit: 25%

buy  when close > highest(20)[1] and close > sma(200)
sell when close < lowest(10)[1]
```

**How it works and what to watch for:**
- `highest(20)[1]` is the highest high of the 20 bars *before* today. Without `[1]`, `highest(20)` includes today's high, so `close > highest(20)` can never be true.
- Stops (`stop loss`, `trailing stop`, `take profit`) accept either percentages (`10%`) or ATR multiples (`2 atr(14)`). ATR stops adapt to changing volatility instead of getting shaken out during high-vol regimes.
- With default `next open` fills, stops begin checking intrabar highs and lows on the entry bar itself (starting from the entry open); with `fill: close`, stop checks begin on the following bar. If a bar gaps past a stop, it fills at that bar's open. After a stop closes a position, the `buy when` rule must turn false on at least one close before buying again, preventing immediate same-signal re-entry.

---

## Part 2 — Rules, Position Logic & Real-World Realism

### 6. Per-ticker rules and stops

**When to use it:** Use `for TICKER:` sections when one strategy manages assets with different behavior (for example, equities, bonds, and gold) inside a single capital pool.

```strategy
name: Multi-asset custom rules
universe: SPY 40%, QQQ 20%, TLT 25%, GLD 15%
from: 2006-01-01
rebalance: quarterly
costs: 5 bps
stop loss: 10%

buy  when close > sma(200)
sell when close < sma(200)

for SPY, QQQ:
  stop loss: 12%
  buy  when close > sma(150) and rsi(14) < 75
  sell when close < sma(150)

for TLT:
  stop loss: 7%
  buy  when close > sma(100)
  sell when close < sma(100)

for all:
  # Shared rules or stops written after "for all:" apply to any ticker
  # that does not define its own override.
  trailing stop: 15%
```

**How it works and what to watch for:**
- Only rules (`buy`, `sell`, `add`, `short`, `cover`) and the three stop settings (`stop loss`, `trailing stop`, `take profit`) can sit inside a `for` section. Portfolio-wide settings (`from`, `costs`, `rebalance`, `capital`) belong above the first `for` line or after `for all:`.
- `for SPY, QQQ:` applies the same override to multiple tickers at once. Any ticker not overridden (here `GLD`) inherits the shared rules and shared `stop loss: 10%`.
- Adding custom rules for every single ticker multiplies degrees of freedom quickly. Keep overrides grounded in asset-class differences (like bond vs. equity volatility), not per-ticker curve-fitting.

### 7. Scaling in across multiple entries

**When to use it:** Use `entries:` and `add when` to build a position in tranches—either pyramiding into strength or averaging into pullbacks—while enforcing position-level exit limits.

```strategy
name: 3-tranche trend pyramid
universe: SPY, QQQ
from: 2010-01-01
entries: 3
costs: 5 bps
stop loss: 8%

buy when close > sma(200) and rsi(14) < 65
add when close > last entry price * 1.03
  and entries made < 3
  and close > sma(50)
sell when close < sma(200)
  or (bars held >= 60 and position return < 0%)
  or close < highest since entry - 3 * atr(22)
```

**How it works and what to watch for:**
- With `entries: 3`, the initial `buy when` deploys one-third of the ticker's target weight; each `add when` adds another third up to 3 entries total (at most one add per close, and never on a bar where `sell when` also holds).
- Position values (`bars held`, `entry price`, `last entry price`, `entries made`, `highest since entry`, `lowest since entry`, `position return`) are only valid in `sell`, `cover`, and `add` rules—never in `buy`, `short`, or `hold` scores, and never inside rolling windows like `for n bars`.
- `stop loss` and `take profit` measure from the share-weighted average `entry price`, so pyramiding moves your stop up automatically. Exits always close the entire position (no partial exits).

### 8. Volatility-aware sizing and risk per trade

**When to use it:** Use `weighting: inverse volatility(N)` when combining calm and volatile assets in one portfolio, or `risk per trade:` when sizing each trade to lose a fixed percentage of equity at its stop distance.

```strategy
name: Risk-parity trend basket
universe: SPY, TLT, GLD, DBC
from: 2007-01-01
weighting: inverse volatility(60)
rebalance: monthly
costs: 5 bps

buy  when close > sma(150)
sell when close < sma(150)
```

```strategy
name: ATR-sized breakout
universe: SPY, QQQ, IWM, EFA, GLD
from: 2010-01-01
risk per trade: 1% at 2 atr(14)
stop loss: 2 atr(14)
costs: 5 bps

buy  when close > highest(40)[1] and close > sma(200)
sell when close < lowest(20)[1]
```

**How it works and what to watch for:**
- `weighting: inverse volatility(60)` rescales weights across currently active positions inversely to their 60-bar return volatility, keeping calmer assets (like `TLT`) from being dominated by equities. It redistributes only the combined configured weight of active tickers—if 1 of 4 tickers is in an uptrend, that ticker stays at 25% weight rather than scaling up to 100% equity.
- `risk per trade: 1% at 2 atr(14)` sizes each new entry so a 2-ATR adverse move costs roughly 1% of account equity, capped at the ticker's configured weight (`weight * equity`, 20% each in a 5-ticker equal-weight basket) and available cash.
- You cannot combine `risk per trade` with `weighting` or with a `rebalance` schedule other than `never`, because `risk per trade` fixes each position's size at entry rather than resizing on a calendar schedule.

### 9. Cross-ticker, macro, and CSV regime filters

**When to use it:** Gate entries using market-wide volatility (`^VIX`), another benchmark (`of SPY`), a FRED economic series (`fred:`), or your own custom signal table (`csv:`).

```strategy
name: Macro-gated equity trend
universe: QQQ
from: 2010-01-01
costs: 5 bps
cash rate: fred:DGS3MO

curve_ok = close of fred:T10Y2Y > -0.25
vol_calm = close of ^VIX < 28
spy_up   = close of SPY > sma(200) of SPY

buy  when close > sma(100) and spy_up and vol_calm and curve_ok
sell when close < sma(100) or close of ^VIX > 35
```

```strategy
name: CSV breadth filter
universe: SPY
from: 2015-01-01
costs: 5 bps

# Reads the "breadth" column from <vault>/Data/breadth.csv
buy  when close > sma(200) and column(breadth) of csv:Data/breadth.csv > 50
sell when close < sma(200) or column(breadth) of csv:Data/breadth.csv < 35
```

**How it works and what to watch for:**
- `of` applies only to the expression immediately before it: write `sma(200) of SPY`, or `(close - open) of SPY` when wrapping arithmetic.
- Tickers starting with `^` (such as `^VIX` or `^IRX`) always load from Yahoo even when `data: tiingo` is set.
- `fred:` series (like `fred:T10Y2Y` for the 10Y–2Y Treasury spread or `fred:DGS3MO` for 3-month T-bills) require a FRED API key in plugin settings. Observations are dated by ALFRED publication date to avoid look-ahead bias (early historical observations uploaded together in ALFRED's initial vintage use estimated publication lags and may include pre-vintage revisions), and FRED series cannot be traded in `universe`.
- `csv:` paths are relative to your vault root and cannot contain spaces or commas. Use `column("Header Name")` in quotes if a CSV column header contains spaces.

### 10. Calendar and seasonal rules

**When to use it:** Capture turn-of-the-month flows, seasonal windows, or day-of-week filters using UTC calendar fields derived from each bar's timestamp.

```strategy
name: Turn-of-month plus winter filter
universe: SPY
from: 2005-01-01
costs: 5 bps
cash rate: ^IRX

turn_of_month = month_end or trading_days_left <= 3 or trading_day <= 3
winter_months = month >= 11 or month <= 4

buy  when (turn_of_month or (winter_months and close > sma(200)))
  and weekday != 5
sell when not turn_of_month
  and (not winter_months or close < sma(200))
```

**How it works and what to watch for:**
- Calendar conditions (`month_start`, `month_end`, `week_start`, `week_end`, `quarter_start`, `quarter_end`, `year_start`, `year_end`) are booleans you can write directly in rules. Numeric calendar values (`month` 1–12, `day` 1–31, `weekday` 1=Mon to 7=Sun, `year`, `quarter` 1–4, `trading_day`, `trading_days_left`) are compared against numbers.
- `trading_day` and `trading_days_left` count actual trading days in the data rather than calendar days, so holidays are handled automatically. Note that `trading_days_left` on the final live bar assumes no upcoming unscheduled market holidays.
- Seasonal effects are easy to data-mine. Always pair calendar hypotheses with an out-of-sample split (`test from:`) and check whether the effect persists across decades.

### 11. Execution realism: costs, commissions, cash yield, close fills, and `magnify`

**When to use it:** Configure realistic friction, broker fee schedules, close-auction execution, and intrabar stop resolution before trusting a high-turnover or tight-stop strategy.

```strategy
name: Realistic swing model
universe: SPY 50%, QQQ 50%
from: 2015-01-01
capital: 50k
costs: 3 bps
slippage: 2 bps
commission: 0.005 per share, min 1, max 1%
cash rate: 4%
fill: close
stop loss: 3%
take profit: 6%
magnify: 1h

buy  when close > sma(200) and rsi(3) < 20
sell when rsi(3) > 75 or bars held >= 10
```

**How it works and what to watch for:**
- `costs` (proportional fee in bps) and `commission` (fixed per order or per-share with `min`/`max` caps) add together. `slippage` worsens every fill price in the direction of the trade.
- `fill: close` executes signals at the same bar's closing price (like a market-on-close order) instead of the next bar's open. Because a real MOC order must be placed slightly before the closing print is final, check sensitivity against the default `next open` fill too.
- `magnify: 1h` inspects 1-hour bars inside each daily bar whenever a stop loss, trailing stop, or take profit falls inside the bar's high–low range, resolving which level was hit first and updating trailing stops intrabar. Yahoo provides 1h sub-bars for the last 730 days (and 2m–30m for 60 days); older bars fall back to whole-bar resolution and the result notes the exact coverage boundary.

### 12. Crypto and intraday timeframes

**When to use it:** Test 24/7 crypto markets and intraday bars (`1m` to `1w`) using Binance spot market data without an API key.

```strategy
name: BTC 4h trend breakout
data: binance
universe: BTCUSDT, ETHUSDT
interval: 4h
from: 2021-01-01
costs: 10 bps
slippage: 5 bps
trailing stop: 4 atr(14)
magnify: 15m

buy  when close > ema(120) and supertrend_up(10, 3)
sell when not supertrend_up(10, 3)
```

**How it works and what to watch for:**
- Binance supports `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, and `1w`. Setting `data: binance` applies Binance to every ticker in the block (use per-ticker prefixes like `binance:BTCUSDT` only when mixing sources on daily or weekly bars). Yahoo and Tiingo support `1d` and `1w` only, so do not mix a Yahoo ticker into a `4h` block.
- `magnify` must be strictly smaller than `interval` and divide it evenly (here `15m` divides `4h` into 16 sub-bars). Binance caps magnified downloads at 100,000 sub-bars per ticker.
- Crypto maker/taker fees and wide spreads during volatility spikes eat thin intraday edges quickly. Model at least 10–15 bps total friction per side and verify breakeven costs in the stress panel (Recipe 19).

---

## Part 3 — Rotation, Shorts & Leverage

### 13. Cross-sectional and dual momentum rotation

**When to use it:** Rotate capital into the strongest assets in a basket while moving into cash (or a defensive asset) when absolute trend turns negative.

```strategy
name: Sector dual momentum
universe: XLK, XLF, XLV, XLE, XLI, XLY, XLP, XLU, TLT
from: 2008-01-01
hold: top 3 by roc(126)
rebalance: monthly
costs: 5 bps
cash rate: ^IRX

buy  when close > sma(200) and roc(126) > 0%
sell when close < sma(200)
```

**How it works and what to watch for:**
- `hold: top 3 by roc(126)` ranks eligible tickers by 6-month return and allocates `size / 3` (equal weight) to the top 3. Do not attach explicit `%` weights in `universe:` when using `hold`.
- Adding `buy when close > sma(200) and roc(126) > 0%` turns pure relative momentum into *dual* momentum: if fewer than 3 tickers pass the absolute filter, the remaining slots stay in cash earning `^IRX`. Note that `sell when close < sma(200)` still exits daily between monthly rebalances, holding that slot in cash until the next monthly ranking date.
- You can use any numeric expression as the ranking score—for example risk-adjusted momentum like `roc(126) / (stdev(roc(1), 60) * sqrt(252))` or composite scores using `if(...)`. Watch out for survivorship bias when building multi-ticker baskets: choosing today's well-known ETFs or individual stocks in hindsight flatters historical rotation returns.

### 14. Long/short trend following

**When to use it:** Trade both sides of a trend to profit in sustained bear markets or reduce equity beta.

```strategy
name: Long/short trend with ADX filter
universe: SPY, TLT, GLD
from: 2006-01-01
costs: 5 bps
slippage: 2 bps
borrow fee: 0.75%
stop loss: 3 atr(14)

strong_trend = adx(14) > 20

buy   when close > sma(150) and strong_trend
sell  when close < sma(150)
short when close < sma(150) and strong_trend
cover when close > sma(150)
```

**How it works and what to watch for:**
- `short when` opens a short and `cover when` closes it. If a ticker is long and `short when` triggers without `cover when` also holding—and without `buy when` still holding—the engine closes the long and flips short at the same fill. If both `buy when` and `short when` hold on the same bar, the conflict closes the open position and stays flat.
- Shorts accrue a daily borrow fee (`borrow fee`, default 0.5%/yr) on their marked-to-market value, and short sale proceeds do not earn the `cash rate`.
- Stop losses and trailing stops mirror automatically for shorts (a stop loss sits *above* the short entry price; a trailing stop follows `lowest since entry` from above). Note that `hold:` rankings cannot be combined with `short when`.

### 15. Relative-strength and pairs trading

**When to use it:** Trade the spread between two correlated assets—going long the lagging leg and short the leading leg—to isolate relative value from broad market direction.

```strategy
name: QQQ/SPY z-score pairs
universe: QQQ 50%, SPY 50%
from: 2010-01-01
costs: 5 bps
slippage: 2 bps
borrow fee: 0.5%

spread = zscore(close of QQQ / close of SPY, 60)

for QQQ:
  buy   when spread < -2
  sell  when spread > -0.25 or spread < -3.5
  short when spread > 2
  cover when spread < 0.25 or spread > 3.5

for SPY:
  short when spread < -2
  cover when spread > -0.25 or spread < -3.5
  buy   when spread > 2
  sell  when spread < 0.25 or spread > 3.5
```

**How it works and what to watch for:**
- Defining `spread` with explicit `of` references (`close of QQQ / close of SPY`) guarantees both `for QQQ:` and `for SPY:` evaluate the exact same ratio series on every bar.
- Avoid putting a per-ticker price `stop loss` on a market-neutral pair: stops evaluate each leg independently against its own price, so a broad market rally can stop out only the short leg and leave an unhedged directional position. Instead, enforce a symmetric **spread stop** (`spread < -3.5` / `spread > 3.5`) in the rules so both legs exit together on structural divergence.
- With 50% on each leg, the strategy is dollar-neutral (100% gross, roughly 0% net when active), though QQQ typically carries higher market beta than SPY—adjust leg weights (for example `QQQ 45%, SPY 55%`) if you want closer beta neutrality. Increasing weights up to `QQQ 100%, SPY 100%` runs 200% gross, the engine's maximum cap. Expand **Figures vs. buy and hold** to check **Exposure, gross** (and its `net` figure underneath).

### 16. Leveraged multi-asset portfolio

**When to use it:** Scale a diversified low-volatility mix (like stocks + Treasuries) above 100% gross weight to test whether excess return clears real financing costs.

```strategy
name: Leveraged 60/40 trend
universe: SPY 90%, TLT 60%
from: 2008-01-01
rebalance: quarterly
costs: 5 bps
margin rate: 6%

buy  when close > sma(200)
sell when close < sma(200)
```

**How it works and what to watch for:**
- Weights (or `size`) may sum up to 200% gross (2x equity). Whenever cash minus short obligations is negative, the borrowed balance accrues `margin rate` daily (default 6%/yr). The default benchmark scales the leveraged weights back down to 100% (here 60% SPY / 40% TLT), so the comparison directly shows whether leverage beat unleveraged 60/40 after borrowing costs.
- If equity ever drops below 25% of gross position value at a close (maintenance margin), a margin call liquidates all positions at the next open. If equity hits zero, the run stops in ruin.
- Always test leverage under high-rate regimes (such as 2022–2024, when both `SPY` and `TLT` fell together while borrowing costs rose). A strategy that relies on 0% margin rates will look far worse at `margin rate: 6%` or `7%`.

---

## Part 4 — Testing & Debugging Workflows

### 17. Parameter tuning without curve-fitting

**When to use it:** Explore parameter sensitivity while keeping an untouched out-of-sample holdout and tracking how many combinations you tested.

```strategy
name: Dual MA out-of-sample check
universe: SPY
from: 2005-01-01
test from: 2019-01-01
costs: 5 bps

fast = 50 in 20..100 step 10
slow = 200 in 120..300 step 20

buy  when sma(fast) > sma(slow)
sell when sma(fast) < sma(slow)
```

**How it works and what to watch for:**
- On blocks without declared parameters (and without DAG links), you can drag any number directly in the rendered rules to see the chart update live against a dashed ghost line of the original run, with **Reset** and **Write to block** buttons. Once you declare parameters like `fast = 50 in 20..100 step 10`, drag the parameter values or sliders instead and open **Try other values** for a full parameter sweep grid (which also computes Probability of Backtest Overfitting, PBO, when at least 5 valid variants run).
- `test from: 2019-01-01` adds the **Before and after the test date** table (Return per year, benchmark per year, Worst drawdown, Sharpe ratio, and Trades). Pick broad, flat plateaus on the sweep grid before the split date—never an isolated peak.
- Open **Was it luck?** after sweeping to review the strategy's cumulative trial count and Deflated Sharpe Ratio alongside block-bootstrap reshuffled history, random entries, and walk-forward tests. Check the **Regimes and crises** tab as well to see whether performance held up across bull, bear, sideways, and crash periods.

### 18. Clause attribution and simplification

**When to use it:** Audit a multi-clause strategy to see which conditions genuinely improve risk-adjusted returns and which ones add complexity without helping.

```strategy
name: Pullback clause audit
universe: SPY
from: 2005-01-01
costs: 5 bps
stop loss: 10%

buy when close > sma(200)
  and rsi(2) < 15
  ~and adx(14) > 15
  and close < sma(5)
sell when close > sma(5)
```

**How it works and what to watch for:**
- Prefix any rule clause or setting line with `~` in the note (or run **Toggle mute on the clause at the cursor**) to turn it off without deleting it. Above, `~and adx(14) > 15` is skipped by the parser so you can compare results while keeping the line in your note.
- Expand the **Clauses** strip inside the rendered rules box to see leave-one-out attribution for every active rule clause, stop, and rebalance setting (note that lines already prefixed with `~` in source are skipped before parsing and do not appear here):
  - Header tallies group active clauses into **`key`** (large positive Sharpe or drawdown impact), **`helpful`** (modest positive impact), **`no effect`** (minimal impact on Sharpe, drawdown, or trades), and **`hurts`** (lowers Sharpe without meaningfully cutting drawdown). Individual rows show exact Sharpe/drawdown deltas (`+0.xx SR · -x.x% DD`) or `no effect` / `hurts`.
- Hover a clause row to highlight the exact trades it added or blocked on the equity chart. Click active clauses inside **Clauses** to mute them live in the card, and click **Delete N muted** to remove those interactively muted clauses from the note permanently.

### 19. Stress-testing edge durability

**When to use it:** Check whether a strategy survives realistic execution friction, small parameter shifts, timing delays, and the removal of outlier periods before putting capital behind it.

```strategy
name: Stress-check candidate
universe: QQQ
from: 2008-01-01
costs: 5 bps
slippage: 2 bps

buy  when close > sma(150) and rsi(14) < 70
sell when close < sma(150)
```

**How it works and what to watch for:**
- Every strategy card runs a 32-path stress battery across four axes and summarizes the verdict as **Holds up**, **Sensitive**, or **Fragile**, overlaid as a shaded band on the chart:
  - **Params ±15%** — deterministically perturbs rule, stop, sizing, and parameter literals by ±8%/±12%/±15% across 12 paths (leaving settings such as `costs`, `capital`, and `from` unchanged) and reports **`±15% pass`** (share of neighbors with positive Sharpe).
  - **Friction 3×** — tests 2× and 3× costs, +15/+30/+50 bps per side, and 25% adverse intrabar fills, reporting **`Costs break at`** (breakeven bps where Sharpe crosses 0, or `>100 bps` if Sharpe remains positive across every tested friction path). If you want to test an even harsher regime (such as 5× costs on illiquid small-caps), bump `costs:` directly in the block and compare.
  - **Delay +1d** — delays signals by +1 and +2 bars and shifts rebalance dates or start dates, reporting **`+1 bar delay`** Sharpe.
  - **Outliers** — removes the best calendar year, best month, best 20-bar stretch, and top 1/3/5 trades, reporting **`Without best yr`** Sharpe.
- Click the axis pills (`All`, `Params ±15%`, `Friction 3×`, `Delay +1d`, `Outliers`) to isolate which failure mode drives fragility. A pill highlights when that axis cuts Sharpe by more than 40% or below 0.

### 20. Debugging why a trade did or did not happen

**When to use it:** Investigate a missed entry, a frustrating whipsaw cluster, or a losing streak directly from the chart instead of guessing in the dark.

```strategy
name: Debuggable momentum pullback
universe: SPY
from: 2010-01-01
costs: 5 bps

buy when close > sma(200)
  and rsi(14) < 45
  and adx(14) > 18
sell when close < sma(200) or rsi(14) > 75
```

**How it works and what to watch for:**
- **Why didn't it fire on this bar?** Open **Prices and trades** and click any bar on the price chart. A panel appears below the chart showing the ticker's position on that date, whether the active rule (`buy`, `sell`, or `cover`) fired, every comparison that blocked it (`observed X vs Y`), and a counterfactual threshold (`Relax to ...: +N trades, ΔSR, ΔDD`) already showing the full-history impact—with a one-click **`Try <value>`** button (on non-DAG blocks) that writes that threshold directly into the block (undoable with standard editor Undo).
- **What separates losing trades from winners?** On the same **Prices and trades** chart, drag across a span covering at least 2 closed trades (leaving at least 2 outside). The **Feature contrast** table ranks 14 market-state indicators (such as `ADX(14)`, `Efficiency(20)`, `ATR(14) %`, `RSI(14)`, `Z-Score(20)`, `Dist from SMA(200)`, plus any `of` series like `^VIX`) by ROC-AUC and permutation p-value.
- On non-DAG blocks, clicking **`+ Test muted`** inserts the suggested filter under your entry rule as a `~`-muted line annotated with `# contrast AUC ..., +N trials` so you have an explicit record of how many candidate features were scanned. For bar-by-bar inspection of every sub-expression, also open **Rule values, bar by bar**.

---

## Part 5 — Multi-Note Systems, Portfolios & Live Operation

### 21. Shared vault building blocks (`signal`, `regime`, `universe`)

**When to use it:** Define reusable universes, macro regimes, and entry signals once in dedicated notes so multiple strategies stay consistent and update together when a definition changes.

In a note named `Core ETFs.md`:

```universe
name: Core ETFs
SPY, QQQ, IWM, EFA, TLT, GLD
```

In a note named `Macro Regimes.md`:

```regime
name: Macro Regimes
risk_on = close of SPY > sma(200) of SPY and close of ^VIX < 28
risk_off = close of SPY < sma(200) of SPY or close of ^VIX > 32
```

In a note named `Momentum Signals.md`:

```signal
name: Momentum Signals
pullback = rsi(2) < 15 and close > sma(200)
rebound  = rsi(2) > 70 or close > sma(5)
```

Then compose them in any strategy note:

```strategy
name: Composed ETF pullback
universe: [[Core ETFs]]
from: 2010-01-01
costs: 5 bps

buy  when [[Macro Regimes#risk_on]] and [[Momentum Signals#pullback]]
sell when [[Macro Regimes#risk_off]] or [[Momentum Signals#rebound]]
```

**How it works and what to watch for:**
- `universe` blocks list comma- or newline-separated tickers (with optional weights) and expand wherever `universe: [[Note]]` or `universe: [[Note#Block Name]]` appears.
- `signal` and `regime` blocks export named expressions (`name = expr`) or a single anonymous expression. Reference a specific export with `[[Note#export_name]]`.
- Backtest Blocks detects reference cycles automatically and hashes the expanded strategy source, so edits to `Macro Regimes.md` take effect whenever a downstream strategy renders or refreshes. Each `signal`, `regime`, and `universe` card also displays a **`Used by N strategies`** table listing every downstream note that depends on it.

### 22. Strategy inheritance and parent-vs-child diffs

**When to use it:** Test a hypothesis (like adding a volatility filter or changing a stop) as a clean child note that inherits from a frozen parent strategy, rather than duplicating or overwriting the parent.

In a parent note named `Trend Core.md`:

```strategy
name: Trend Core
universe: SPY 60%, TLT 40%
from: 2006-01-01
rebalance: quarterly
costs: 5 bps

buy  when close > sma(200)
sell when close < sma(200)
```

In a child note testing a volatility filter on top of `Trend Core`:

```strategy
name: Trend Core + VIX guard
extends: [[Trend Core]]
stop loss: 10%

buy when base and close of ^VIX < 30
```

**How it works and what to watch for:**
- `extends: [[Trend Core]]` inherits all settings (except `live since`), parameters, definitions, shared rules, per-ticker `for` sections, and `invalidate when` rules from the parent. Anything you write in the child overrides the corresponding parent setting or rule.
- Inside a child rule, `base` expands to the parent's rule expression for that same side (`(close > sma(200))` here), so you can refine an entry or exit without copy-pasting the parent logic.
- A child strategy automatically renders a **`vs. Trend Core`** diff strip above its chart showing marginal **Sharpe**, **Max DD**, and **CAGR** deltas plus counts of losing trades avoided, winners dropped, and new trades added. Hover the trade diff summary to mark the differing trade dates on the chart.
- Each named child keeps its own trial count in **Was it luck?**—if you branch heavily across many child notes, keep track of the parent family's total exploration rather than judging a winning child in isolation.

### 23. Comparing and combining strategies

**When to use it:** Evaluate multiple strategy notes side by side on their overlapping history, inspect their return correlation, and track your whole vault from one index note.

```compare
[[Trend Core]] 50%
[[Composed ETF pullback]] 30%
[[Sector dual momentum]] 20%
```

```backtests
# Overview of all strategies in the Strategies folder, highest Sharpe first
folder: Strategies
sort: sharpe
```

**How it works and what to watch for:**
- A `compare` block accepts 2 to 8 strategies (as `[[Note]]`, `[[Note#Strategy Name]]`, or `Folder/Note.md`). When you supply weights summing to 100% or less, it aligns all strategies to their common overlap window, charts the monthly-rebalanced portfolio (assuming zero rebalancing cost and 0% interest on any unallocated weight below 100%), computes pairwise correlations, shows what each strategy adds to the mix, and offers **How to split** weighting suggestions.
- A `backtests` dashboard block lists every strategy in the vault (or under `folder:`) with sparklines, return per year, worst drawdown, Sharpe, current holdings, and upcoming orders. Valid `sort:` values are `return`, `drawdown`, `sharpe`, and `name`.
- Remember that weights chosen on the same historical sample used to pick the strategies flatter the blended curve—treat `compare` weights as a starting point, not an exact forecast.

### 24. Active book evaluation (`book: active` and In Book)

**When to use it:** Judge every new research idea by how it changes your *actual* portfolio—drawdowns, tail correlation, sleeve redundancy, and turnover—instead of looking only at standalone Sharpe.

```account
name: Core Live Book
book: active
holdings: SPY 120, TLT 80, GLD 25
cash: 12,500
whole shares: yes
skip under: 1%

[[Trend Core]] 50%
[[Sector dual momentum]] 30%
[[SPY RSI(2) pullback]] 20%
```

**How it works and what to watch for:**
- Adding `book: active` to an `account` block designates it as your vault's active portfolio. Once set, every strategy card in your vault displays a **`Standalone` / `In Book`** toggle in its header bar.
- Switching any candidate strategy to **`In Book`** opens an interactive portfolio panel with:
  - A **0–50% sleeve weight slider** (5% steps) and a **`Use optimal N%`** button. The blended book rebalances daily (so blended figures can differ slightly from `compare`'s monthly blend).
  - Marginal **`ΔBook Sharpe`**, **`ΔBook Max DD`**, **`ΔBook Calmar`**, and **`Drawdown corr`** (return correlation strictly during your active book's worst 10% drawdown decile—low or negative values hedge drawdowns, high values mean it falls with your book).
  - **`Sleeve overlap & redundancy`** (`R²`, correlation, and active overlap against each existing sleeve in the book).
  - A collapsible **`Live transition ticket`** showing estimated net Buy/Sell share orders (unrounded estimates before applying `whole shares` or `skip under`) and dollar turnover required to fund the new sleeve from your current holdings.

### 25. Going live with stop rules and fill tracking

**When to use it:** Freeze a strategy's live rules, pre-commit objective halt conditions before trading real money, reconcile actual broker fills against modeled signals, and review daily execution in **Today's orders**.

```strategy
name: Live SPY Trend
universe: SPY
from: 2005-01-01
costs: 5 bps
slippage: 2 bps
cash rate: ^IRX
# live since: YYYY-MM-DD @hash is added automatically when you click "Start live tracking"

buy  when close > sma(200)
sell when close < sma(200)

invalidate when live drawdown > 1.25 * backtest max drawdown
  or (live bars >= 60 and live percentile < 5%)
  or (live bars >= 60 and live rolling_sharpe(60) < -0.5)
  or live slippage > 2 * modeled slippage
```

Pair it with an active, broker-backed `account` block to generate daily share orders and reconcile broker CSV exports:

```account
name: Main brokerage
book: active
holdings: SPY 140
cash: 6,400
whole shares: yes
skip under: 1%
fills: Broker/schwab.csv
fills from: 2026-04-01
capital at start: 85,000

[[Live SPY Trend]] 100%
```

**How it works and what to watch for:**
- Adding `invalidate when` surfaces **`Start live tracking`** on the strategy card (you can also start live tracking on any strategy from its `⋯` menu). Clicking it writes `live since: YYYY-MM-DD @hash` to pin the live commit in place. If you edit the rules later, the header marks `Live v1 (...) · edited` and offers **`Update live rules → v2`** so live tracking never silently rewrites history. (If you prefer a separate frozen note instead of in-place tracking, use **Start a forward test** from the `⋯` menu to create a `forward` block.)
- Supported `invalidate when` metrics are `live drawdown`, `backtest max drawdown` (or `backtest drawdown`), `live percentile` (position inside the bootstrap return cone, e.g. `< 5%`), `live rolling_sharpe(60)` (fixed 60-bar rolling Sharpe, also `live sharpe`), `live slippage`, `modeled slippage`, `live bars`, and `live return`, with optional `%` and `bps` units (for example `live slippage > 25 bps`). Within 15% of any threshold the banner warns **Near stop rule**; once breached it flags **Stopped — stop rule tripped**.
- Live fill tracking works through two complementary surfaces:
  - In **Today's orders**, clicking **`Confirm fill`** on an account order appends a fill record to `<snapshotFolder>/_ledger/fills.jsonl`, which feeds **Realized**, **Slippage drift**, **Lag cost**, and **Overrides** directly into the live strip on deployed strategy cards (matching the account marked `book: active`).
  - Inside the `account` block itself, `fills:` reads CSV exports from Schwab, Fidelity, Interactive Brokers, or custom headers (`fills columns:`) to reconcile historical fills against modeled signals across four buckets: **Slippage**, **Fees**, **Late fills**, and **Trades not made**.
- Run **Show today's orders** (or click its ribbon icon and **Keep in the sidebar**) each session to see every pending open/close order, near-trigger price levels, and netted account share orders. The plugin never transmits orders automatically; you place trades at your broker.

### 26. Automating vault checks and research via CLI and MCP

**When to use it:** Lint every strategy note in CI or a pre-commit hook, run headless backtests from scripts, or let an AI assistant validate and test strategies directly against the plugin's exact parser and engine.

```bash
# Check every strategy block in one or more notes (exits 1 on errors)
node backtest-blocks.mjs check Strategies/*.md

# Apply unambiguous auto-fixes in place (for example typos in indicator names)
node backtest-blocks.mjs check --fix Strategies/Trend.md

# Run a single strategy block on live prices using the vault's plugin settings
node backtest-blocks.mjs run Strategies/Trend.md --block "Trend Core" --json

# Look up exact syntax and behavior for any keyword, indicator, or setting
node backtest-blocks.mjs explain "risk per trade"

# Start the MCP server (check_strategy, run_backtest, explain_word, list_words)
node backtest-blocks.mjs mcp
```

To register the MCP server in Claude Code:

```bash
claude mcp add backtest-blocks -- node /path/to/backtest-blocks.mjs mcp
```

**How it works and what to watch for:**
- `backtest-blocks.mjs` ships in every release and runs on Node.js 20+ with no separate install step.
- `run` automatically reads `.obsidian/plugins/backtest-blocks/data.json` from the enclosing vault (or `--vault`), so default capital, costs, slippage, commission, cash rate, and borrow/margin rates match Obsidian. Both `run --json` and the MCP `run_backtest` tool include automatic `stress` breaking points and `ablation` clause verdicts in their structured output. Prices cache in `$XDG_CACHE_HOME/backtest-blocks` (defaulting to `~/.cache/backtest-blocks`; use `--refresh` to force a reload).
- Set `TIINGO_API_KEY` and `FRED_API_KEY` in your shell environment when running notes that reference `tiingo:` or `fred:` tickers from the command line or MCP.
