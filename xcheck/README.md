# Cross-check against Rearview

Runs our engine (`src/`) and Rearview, a separate backtester, on the same synthetic prices and the
same strategies, and compares everything they produce. Not part of `npm test`.

```sh
RVW=path/to/rvw node xcheck/run.ts   # every indicator and case
node xcheck/run.ts                   # the same, with rvw on PATH
node xcheck/run.ts e-stop-target-gaps q-stops-slippage -v   # some cases; -v lists explained trades and totals
```

It needs Rearview's command-line tool, `rvw`: the script uses the path in the `RVW` environment
variable when it is set, and otherwise looks for `rvw` on `PATH`. Without it the script says so and
exits 0. It exits 1 on any difference it can't explain. Everything it writes goes to
`.scratch/xcheck/`: the import folder and Rearview's store (rebuilt when the data changes), each
case's Rearview run under `runs/<case>/`, and `report.json`.

## The data

`data.ts` generates nine tickers over 3,000 weekdays from 2 January 2013 (1 January, 4 July and
25 December are holidays), in whole cents, written once in Rearview's import format. Volume changes from bar to bar (a hash of the ticker and
the bar, so the prices do not move), for the indicators that weigh by it; no case's rules read it. Our engine
reads the same `bars.csv` through `parseCsv`, a ticker at a time.

| Ticker | Shape |
|---|---|
| TRND | upward drift, opens at the previous close |
| MREV | mean-reverting around 50 |
| CHOP | trends that flip every 60 to 250 days |
| VOLA | 3.5% daily moves, small overnight gaps |
| GAPY | one day in ten gaps 3% to 15%, through stops and targets |
| LATE | lists 640 bars later, on a month's last day |
| HOLE | no bar on 3% of days |
| WK1, WK2 | for the weekly rebalance |

TRND, MREV, CHOP, VOLA and LATE have a calm first trading day each month (open, high, low and close
at the previous close) and open the second day at that price; WK1 and WK2 do the same each week.
Rearview decides a scheduled rebalance at the close of a period's first day and fills it the next
morning, where we fill at the first day's open; on these days both see one price, so the two can be
compared exactly. `series/w.csv` gives Rearview the per-ticker weights of the rebalancing cases.

Rearview's store also holds TWIN, CHOP's bars under another id, which our engine never sees, and
`series/twin.csv`, 1 on TWIN and 0 on every other ticker. Rearview opens no side of a security it
holds the other side of, so where we flip CHOP from long to short at one open, Rearview's script goes
long CHOP and short TWIN in the same account; its trades on TWIN are compared as CHOP's.

## What is compared

- **Indicators**: our values against `rvw eval` on every bar of every ticker, warm-up included,
  to 1e-9: the first twelve functions and the later ones listed under "Indicator differences".
- **Each case** in `cases/<name>/`: `case.strategy` (ours), `case.rvw` (Rearview's) and
  `case.json` (what it tests, how to compare, which documented differences it may show). Rearview
  runs in a cash account with 6 share decimals, fills at the next open, commission and slippage
  as ours (our `costs` as its percentage commission, our `commission` as its amount per trade, or
  per share with its minimum), the cash rate times 360/365 (it counts a 360-day year) and our
  first and last day.
  The `s` cases sell short or borrow (see "Shorts and leverage" below).
  The `y` cases fill at the close instead: our `fill: close` against Rearview's `fill same_close`
  (a plain rule with costs and slippage, stops and targets on gaps, a trailing stop, a monthly
  rebalance and a ranking). There the orders filled at the last close are compared too: our
  `filled` state against Rearview's signal fills that day.
  - Trades are matched by ticker and entry day: entry and exit prices to Rearview's rounding
    (1.5e-6), exit day, reason and bars held exactly; P&L to 1e-8 of capital where sizing agrees.
  - The `z` cases cover `commission` (`z1` to `z3`) and positions built in `entries` (`z4` to
    `z7`): our `entries: n` and `add when` against Rearview's `add when`, `max adds n - 1`,
    `size` of 1/n of equity and `max position 100%`. There a trade's entry price is the average of
    its buys in both engines, and each entry's day and price is compared with Rearview's buys from
    the trade's first day to its exit.
  - Equity: levels up to the first trade that isn't in both runs, to 1e-6, and daily returns on
    every day no such trade was open, to 1e-7. `direct` compares with Rearview's daily equity;
    `replay` with Rearview's own fills replayed with our sizing, for one ticker that gaps, where
    Rearview's sizing at the signal close leaves cash over after a gap down.
  - Daily exposure, final equity, costs, interest, shares held, CAGR, max drawdown, average
    exposure, Sharpe (rescaled, below) and the orders left pending for the next open.

### Shorts and leverage

A block that borrows (a short rule, or weights above 100%) runs in Rearview's Reg T account. Its
room is ours: we may add gross value (long plus short) up to L times equity at the fill, L the
weights' total (at most 2), and Rearview gets an exposure limit of gross L times equity inside its
own 2× (initial margin 50%). An initial margin of 1/L would do the same, but 1/1.5 isn't a whole
number of millionths. Its maintenance is set to ours, 25% of each position's value, so a margin call
comes at the same close. The margin rate and a flat borrow fee are ours times 360/365, like the cash
rate; a case that borrows writes both, at rates that come out to whole millionths.

- Our `short when` and `cover when` are Rearview's `enter short when` and `exit short when`, with
  `and not <cover>` on the entry as for buys. A trade's side is compared too.
- Rearview sells short whole shares only, of its own equity: a short's shares agree to within one,
  plus what the two runs' equity differed by at the signal close, in shares; its P&L is compared at
  Rearview's shares. The cases run on $1B, where a share is below 1e-7 of equity.
- Exposure is compared gross, long plus short, and net, long less short, every day. Margin interest
  and borrow fees are compared as totals beside the cash interest, and shares held as signed counts.

| Case | What it covers |
|---|---|
| `s1-short-trend` | short only on a trend, 100% |
| `s2-flip` | long above SMA(50), short below, flipping at one open; the 100% cap cuts the new side |
| `s3-leverage` | 150% long over two tickers, the margin rate; the cap cuts almost half the entries |
| `s4-short-stops` | a 50% short with a stop loss above and a take profit below, costs and a commission |
| `s5-long-short` | one ticker long 100% and another short 100%, the 200% cap |
| `s6-short-trail` | a short's trailing stop, from the lowest low |
| `s7-margin-call` | a short left open through a rise: two margin calls, each closing it at the next open |
| `s8-close-flip` | `s2` with `fill: close` against Rearview's `fill same_close`: both fills of a flip at one close |

Rearview rounds prices, cash and commissions to millionths of a dollar and quantities to
millionths of a share. Each rounding is below 1e-10 of a $100,000 account; the observed worst
deviations are 1e-8 (risk sizing, where Rearview also rounds the ATR distance) and below. In the
`s` cases Rearview's whole-share shorts leave equity up to 1e-7 apart.

## Differences both engines document

A trade that differs only by one of these is counted as explained, and so is a trade the other
run held at the same time as an explained one (`knock`).

| | Ours | Rearview | How the check handles it |
|---|---|---|---|
| Sizing | money: weight × equity at the open, at the slipped price | shares: % of equity at the signal close; cut to cash at the fill | gap-free tickers or `replay`; no slippage with weights under 100%, nor on a short |
| Sizing after a night's charges | interest or a borrow fee charged the night before a fill is out of the equity it sizes from | sized at the close before the charge | where the cap cuts both at the fill (`s2`), or none: no cash rate in `s3`, no borrow fee in `s5` |
| Size of one position | a ticker's weight, up to 200% | at most 100% of equity | 150% over two tickers (`s3`) |
| Flip | one side closes and the other opens at one fill | opens no side of a security it holds the other side of | shorts on TWIN, CHOP's twin (`s2`, `s5`) |
| Short shares | fractions of a share | whole shares | $1B accounts; shares to within one, P&L at Rearview's |
| Costs at the cap | an entry the cap cuts leaves room for its costs: gross stays within L × equity after them | its exposure limit reads equity before the commission | costs only where entries stay under the cap (`s4`, 50%) |
| Interest with a short open | on the cash less the short's value at the last close: a short's gain or loss moves it daily | on the cash without the short-sale proceeds, which stay at what the sale brought in | no cash rate with shorts; no margin rate with a long and a short both open (`s5`); a short alone owes nothing in either |
| Margin call | equity below 25% of the gross value at a close closes every position at the next open | maintenance, set to 25% of each position, sells whole positions at the next open, the biggest unrealised loss first, until the shortfall is covered | one position (`s7`), which both close |
| `rearm` | after a stop or target exit that side's entry rule must stop holding first; after a margin call, both sides' | enters again whenever the entry holds | explained |
| `halt` | an entry waits for the ticker's next bar | an entry on a day without a bar is cancelled | explained |
| `trail` | on the entry bar the trailing stop trails the open | trails the fill, slippage included | explained; replayed our way |
| Targets | slipped like every fill | limit orders, never slipped | compared after our slippage |
| Rebalance | fills at the period's first open | decided at the first close, filled the next day | calm days; fills and costs moved back a day |
| Rebalance, close fills | fills at the close of the period's last day | fills at the close of its first day | calm days; fills and costs moved back a day |
| `closetrail` | with close fills the trailing stop starts from the close it bought at | also trails the high of the bar it bought at, made before the fill | explained when that high set Rearview's level and its exit matches it |
| Bars held | 0 at the entry bar's close | 1 | `bars held >= N` is `bars_held >= N+1` |
| Sell (cover) rule while flat | blocks a buy (a short) | ignored | Rearview entries add `and not <exit>` |
| ATR | first true range = first bar's high - low | starts on the second bar | ATR cases start in 2014; values agree from bar 400 |
| Interest, borrow fee | act/365 | act/360 | rate × 360/365 |
| Sharpe | above the cash rate, √(steps a year), population deviation | no cash rate, √252, sample deviation | rescaled, without a cash rate |
| Stops after a top-up | stay at the first fill | move to the average cost | not combined (stops in rotation aren't checked) |
| Stops after an add | move to the average entry price | move to the average cost | the same: `z5` and `z7` compare them |
| Small trades | an add or rebalancing trade whose commission is 10% of its value or more is not made | made | `z3` charges 0.3 a trade, under 10% of its smallest rebalancing trade (3.43) |

## Indicator differences

Every indicator expression matches on every bar of every ticker, with the same first bar, except where this table says so.
Where a definition has no single standard, both engines keep the one written in `docs/reference.md` and in the docs; the choices
are below.

| | Ours | Rearview | How the check handles it |
|---|---|---|---|
| `atr`, and what is built on it (`keltner_upper`, `keltner_lower`, `supertrend`) | first true range = first bar's high - low | starts on the second bar | compared from bar 400, as `atr(14)` |
| `plus_di`, `minus_di`, `adx` | Wilder's: true range and movement from the second bar | the same | none: identical, first bar included |
| `stoch_k(n, smooth)`, `stoch_d(n, smooth, d)` | `%K` averaged over `smooth` bars (3 unless given), `%D` over `d` more | `stoch_k(n)` is raw, `stoch_d(n, m)` averages it | `stoch_k(n, 1)` against `stoch_k(n)`, and the smoothed forms against `sma` of theirs |
| `obv` | running total from 0 on the first bar | none | the change in ours over 100 bars against `sum` of volume times the sign of the change in the close |
| `vwap(n)` | volume-weighted average of the typical price (high + low + close) / 3 | `vwma(x, n)` of any series | `vwma((high + low + close) / 3, n)` |
| `hma(n)` | `n / 2` and `sqrt(n)` rounded down | the same | none; Hull's formula leaves the rounding open |
| `percent_rank(n)` | the share of the previous `n` values strictly below this one | the same | none |
| `correl(other, n)` | the other ticker's value at each of this ticker's bars, as `of` reads it, so both changes span the same days | the other ticker's own previous day | tickers that have every day; HOLE, with missing days, is left out |
| `supertrend_up`, `bars_since` | conditions on bars | none | not compared; `supertrend`'s line is |

## Not covered

Rearview has nothing to compare these with, or compares them only through a rule that differs:
a commission's maximum (`max 1%`), adds or rebalancing trades left undone for their commission,
entries combined with rebalancing, a ranking, risk per trade, inverse volatility, ATR stops or
slippage, inverse-volatility weighting, a cash rate from a ticker, ATR take-profits, `entry price` in sell
rules, calendar values (`month`, `month_start`, ...), yearly rebalancing, ranking with
`rebalance: never`, stops in ranking or rebalancing strategies, slippage on rebalances with
weights under 100%, `of` on a day the other ticker has no bar, the benchmark, `test from`, and
weekly or intraday bars. Among the functions: `supertrend_up`, `bars_since`, and `correl` of tickers
with missing days or on other calendars. `magnify`, which follows stops and targets through smaller
bars inside each bar, has no counterpart in Rearview, which reads each bar whole as our engine does
without it; every case runs without it.

For shorts and leverage: a gap through a short's stop or target and slippage on a short (sizing in
money against shares, above), a margin call with more than one position open, ruin (Rearview stops
the run where equity reaches zero), interest on a short's gains and losses, a short's stops with
`fill: close`, and adds or rebalancing with a short. Ours refuses short rules in a ranking.
