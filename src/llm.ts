import { parseSpec, type Defaults, type Diagnostic } from './dsl.ts';
import { lineKind, type LineKind } from './highlight.ts';

export interface LlmConfig {
  provider: 'anthropic' | 'openai';
  /** "" is the provider's own address for Anthropic. OpenAI-compatible servers need one, such as http://localhost:8000/v1. */
  baseUrl: string;
  /** "" means DEFAULT_MODEL for the provider. */
  model: string;
  /** May be "" for a local server. */
  apiKey: string;
}

/** An OpenAI-compatible server has no default: model names are whatever that server serves. */
export const DEFAULT_MODEL: Record<LlmConfig['provider'], string> = { anthropic: 'claude-opus-5-5', openai: '' };

export interface HttpResponse {
  status: number;
  text: string;
}
export type HttpPost = (url: string, headers: Record<string, string>, body: string) => Promise<HttpResponse>;

export interface Draft {
  source: string;
  notes: string[];
  errors: Diagnostic[];
  warnings: Diagnostic[];
  /** Requests made to the model: the first draft plus any repairs. */
  attempts: number;
}

/** What the reader is told about what leaves the vault when a strategy is drafted. */
export const DRAFT_PRIVACY =
  'Nothing from your notes or vault is sent. What is sent to the service you chose is your description, the plugin’s built-in guide to the language and, when a draft has problems, that draft and the problems found.';

const FENCE = '```';

interface Example {
  description: string;
  source: string;
  notes: string[];
}

const EXAMPLES: Example[] = [
  {
    description: 'Buy SPY when it closes above its 200-day average, sell when it falls back below, 5 bps costs.',
    source: `name: SPY 200-day trend
universe: SPY
costs: 5 bps

buy when close > sma(200)
sell when close < sma(200)`,
    notes: [],
  },
  {
    description:
      'Hold 60% SPY and 40% TLT from 2010, rebalanced every quarter. Hold SPY only while it is above its 200-day average, with a 15% stop loss. Hold the bonds only while TLT is above its 100-day average, with an 8% stop. Cash earns 4%.',
    source: `name: 60/40 with trend filters
universe: SPY 60%, TLT 40%
from: 2010-01-01
rebalance: quarterly
cash rate: 4%
stop loss: 15%

buy when close > sma(200)
sell when close < sma(200)

for TLT:
  buy when close > sma(100)
  sell when close < sma(100)
  stop loss: 8%`,
    notes: [],
  },
  {
    description: 'Buy QQQ on sharp dips in an uptrend: RSI(2) under 10 while the price is above its 200-day average. Sell when RSI(2) goes over 70 or after 10 days. 5% stop loss, 5 bps costs, from 2005.',
    source: `name: QQQ RSI pullback
universe: QQQ
from: 2005-01-01
costs: 5 bps
stop loss: 5%

buy when rsi(2) < 10 and close > sma(200)
sell when rsi(2) > 70 or bars held >= 10`,
    notes: [],
  },
  {
    description: 'Every month, hold the 3 strongest of SPY, QQQ, IWM, EFA, TLT and GLD by 6-month momentum, but only those above their 200-day average. Otherwise stay in cash.',
    source: `name: Momentum rotation
universe: SPY, QQQ, IWM, EFA, TLT, GLD
rebalance: monthly
hold: top 3 by roc(126)

buy when close > sma(200)
sell when close < sma(200)`,
    notes: ['Six months is about 126 trading days, so the ranking uses roc(126).'],
  },
  {
    description: 'Moving-average crossover on QQQ: buy when the fast average is above the slow one, sell when it is below. I want to try fast from 20 to 100 and slow from 100 to 250. Judge it on data from 2018.',
    source: `name: QQQ moving-average crossover
universe: QQQ
test from: 2018-01-01

fast = 50 in 20..100 step 10
slow = 200 in 100..250 step 50

buy when sma(fast) > sma(slow)
sell when sma(fast) < sma(slow)`,
    notes: ['You gave ranges but no starting values, so I started fast at 50 and slow at 200.'],
  },
  {
    description: 'Short the S&P 500 with 2x leverage when it breaks below its 50-day average, and hedge with put options.',
    source: `name: SPY short at 2x below its 50-day average
universe: SPY 200%

short when close < sma(50)
cover when close > sma(50)`,
    notes: [
      'Options are not supported, so there is no put hedge: this is the short alone.',
      'The description does not say when to cover, so the short is bought back when SPY closes above its 50-day average again.',
      'SPY stands in for the S&P 500, and its weight of 200% sells short twice the equity.',
    ],
  },
];

export const PROMPT_EXAMPLES: string[] = EXAMPLES.map((e) => e.source);

const renderExample = (e: Example): string =>
  ['Description:', e.description, '', 'Reply:', `${FENCE}strategy`, e.source, FENCE, ...e.notes.map((n) => `NOTE: ${n}`)].join('\n');

/** The fixed instructions: role, the complete language reference with worked examples, the reply format. */
export const SYSTEM_PROMPT = `You turn a plain-English trading idea into a strategy for Backtest Blocks, a backtester inside the note-taking app Obsidian. Strategies are written in a small rule language. A parser checks every line you write, and the rules it accepts, not you, are what get backtested. Use only what this document lists.

## Reply format

Reply with the strategy in one ${FENCE}strategy code fence that holds only strategy lines. After the fence you may add lines that each start with "NOTE:", one short sentence per line, for:
- anything the description asks for that the language cannot express, and what you wrote instead;
- anything you chose that the description did not say, such as which ticker stands for "the market", a period, a threshold, a date or a cost.
Write nothing else: no greeting, no explanation of the rules, no text in the fence that is not strategy.

## Limits

A strategy holds each ticker long, short or not at all, and cash earns the cash rate. A short sells shares the strategy borrows, so it gains as the price falls, and it pays a yearly borrow fee on its value (borrow fee: 0.5% unless set). Weights may add up to at most 200%: above 100% the strategy borrows money, and money borrowed pays a yearly margin rate (margin rate: 6% unless set). Long and short positions together may be worth up to the weights' total times the equity, and never more than twice it. There are no options, no futures and no crypto margin products such as perpetual swaps or margin loans on an exchange. Prices come from Yahoo Finance (daily or weekly bars), Binance (bars from 1m to 1w), Tiingo (daily or weekly bars of US listings) or a CSV file in the vault, and economic series from FRED. There are no fundamentals (earnings, valuations), no news or sentiment, and no intraday bars on Yahoo or Tiingo, except as the numeric columns of a CSV file the description names.
If the description asks for something outside these limits, write the closest strategy the language can express and say in a NOTE what you left out or changed. Never invent syntax to cover it.

## Layout

A strategy is lines in this order: settings, then parameters, then rules. A line is one of:
  key: value          a setting
  name = value        a parameter
  buy when ...        a rule (so are "sell when ...", "short when ...", "cover when ..." and "add when ...")
  for TICKER:         starts rules for one ticker; "for all:" returns to the shared rules
  # note              a comment, also written // note
A rule may continue on the next lines (indent them and start each with "and" or "or"). A blank line ends it.

## Settings

Only universe is required. Add the others when the description asks for them or the strategy needs them.
  name: Trend following             title shown above the result
  universe: SPY 60%, TLT 40%        what to trade
  symbol: SPY                       the same as universe, for one ticker
  from: 2015-01-31                  first day; leave out to use all history
  to: 2024-12-31                    last day
  test from: 2019-01-01             results before and from this day are reported apart; must lie between from and to
  data: binance                     where plain tickers come from: yahoo (the default), binance or tiingo
  interval: 1d                      bar size; Yahoo and Tiingo give 1d or 1w; Binance gives 1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w
  capital: 10k                      starting money, written 10000 or 10k
  costs: 5 bps                      cost of each trade, written 5 bps or 0.05% (100 bps = 1%)
  slippage: 5 bps                   how much worse each fill is than the price
  cash rate: 4%                     what cash earns a year, or a yield ticker such as ^IRX or fred:DGS3MO
  borrow fee: 0.5%                  yearly fee on the value of short positions (0.5% unless set)
  margin rate: 6%                   yearly interest on money borrowed (6% unless set)
  size: 80%                         share of equity to use when the tickers have no weights (default 100%, at most 200%)
  rebalance: monthly                never (the default), weekly, monthly, quarterly or yearly; held tickers return to their weights at the start of each period, and with hold the ranking is decided at the end of each period
  benchmark: QQQ                    ticker to compare with, bought and held
  stop loss: 10%                    sell this far below the entry price, or for a short buy back this far above it; also written 2 atr(14), two average true ranges
  trailing stop: 15%                sell this far below the highest price since entry, or for a short buy back this far above the lowest; also 3 atr(14)
  take profit: 20%                  sell this far above the entry price, or for a short buy back this far below it (a short never reaches 100% or more); also 4 atr(14)
  hold: top 3 by roc(126)           hold only the 3 tickers with the highest score, so the universe needs at least 3; the score is a number written like a value in a rule
  weighting: inverse volatility(60) calmer tickers get more weight; volatility is measured over the last 60 returns
  risk per trade: 1% at 2 atr(14)   size each buy so that a fall of 2 average true ranges loses 1% of equity, and each short sale so that a rise of 2 does
  fill: close                       fill each order at the close the rule was read at; the default, next open, fills at the next bar's open
  commission: 1                     a charge per order in the account's money, added to costs; also 0.005 per share, or 0.005 per share, min 1, max 1%
  entries: 3                        build each position in up to 3 entries, each a third of its weight; needs an add when rule
  magnify: 1h                       follow stops and targets through 1h bars inside each bar, so a stop and a target in one bar are taken in the order they were reached; smaller than interval and dividing it; Yahoo gives 2m 5m 15m 30m 1h inside 1d bars (last 60 days, 730 for 1h) and 1d inside 1w bars; rules still read the strategy's own bars
universe: write tickers as Yahoo spells them (SPY, BRK-B, BTC-USD, ^GSPC), binance:BTCUSDT for Binance, tiingo:SPY for Tiingo, csv:Data/gold.csv for a CSV file in the vault; write tiingo: only when the description asks for Tiingo. Weights are percentages: give every ticker one or none (none means equal shares), adding up to at most 200%; under 100% the rest stays in cash, and above 100% the strategy borrows. With hold, give no weights.
Stops are checked on top of the sell and cover rules. With no exit rule a position is held until a stop or the other side's entry rule closes it, or the run ends.

## Rules

buy when <condition>      opens a long position when the condition holds and the ticker is not held
sell when <condition>     closes a long position when the condition holds
short when <condition>    opens a short position when the condition holds and the ticker is not held
cover when <condition>    closes a short position when the condition holds; write it only with a short rule
add when <condition>      with entries: 3, adds the next entry to the position held, long or short, when the condition holds, until there are 3; write it only with an entries line
A rule that holds at a close fills at the next open, or with fill: close at that same close. At most one buy rule, one sell rule and one add rule per scope, and an add rule only with an entries line. At most one short rule and one cover rule per scope too.
A ticker needs a buy rule or a short rule; with hold the buy rule is optional (then every ticker is eligible), and hold cannot be combined with short or cover rules.
A ticker held long is also closed when its short rule holds, and one held short when its buy rule holds; it then turns to the other side at the same fill when that side's rule holds and its exit rule does not (a flip). So buy when close > sma(200) with short when close < sma(200) is long above the average and short below it. When the buy and short rules both hold for a ticker not held, neither opens.
Rules written outside any "for" section are shared and apply to every ticker that has none of its own. "for TLT:" starts rules for TLT; they replace the shared rule of the same side. Inside a "for TICKER:" section only buy when, sell when, add when, short when, cover when, stop loss, trailing stop and take profit may appear. "for all:" goes back to the shared rules, where any setting may follow again.

## Conditions and values

Compare with > < >= <= == !=, or the words above and below (the same as > and <). "crosses above" and "crosses below" mean the moment a value changes sides: sma(50) crosses above sma(200). Join conditions with and, or, not and parentheses. Arithmetic with + - * / works on numbers: close > sma(200) * 1.02. A percentage is a number: roc(20) > 5% is the same as roc(20) > 0.05. true and false are conditions too (also written always and never).
Earlier bars: close[1] is the previous bar's close, close[5] the close five bars back, highest(20)[1] the highest high of the 20 bars before this one.
Another ticker: sma(200) of SPY, close of ^VIX < 25. The ticker need not be in the universe. Put "of" right after the value it applies to.
An economic series from FRED: close of fred:T10Y2Y < 0 reads the series T10Y2Y (here the 10-year minus 2-year Treasury yield, in percent), each value from the day it was first published; sma(close, 3) of fred:UNRATE works too. A FRED series can be read with "of" and be the cash rate (cash rate: fred:DGS3MO), but never be in the universe or the benchmark. Use a FRED series only when the description asks for that data, by its FRED series ID.
A column of a CSV file: column(score) of csv:Data/signals.csv reads the numeric column called score, as a number like close: column(score) of signals > 0.7, sma(column(score) of signals, 10), column(score) of signals crosses above 0. Name the file with csv: the first time it is written, in the universe or after "of"; after that its file name alone does (signals). column(score) with no "of" reads a column of the ticker the rule belongs to, which must then be a CSV file. A column's name is its header in lower case with an underscore for each run of spaces or punctuation; a header with spaces may be written in quotes: column("News Sentiment"). A row counts as known at the close of the day it is dated. A file with only a date and columns can be read with "of" but not traded. Never invent a file or a column the description does not name.
Compare prices with averages, percentages or earlier prices rather than fixed price levels: Yahoo prices are adjusted for later dividends and splits.

Series (the bar's values): open high low close volume
Functions, written with parentheses. A period is a plain number or a parameter, not an expression. A first argument that is not a number replaces the default series, so sma(volume, 20) and sma(rsi(2), 5) both work.
  sma(n)                       simple average of the last n closes
  ema(n)                       exponential average of closes
  rsi(n)                       relative strength index, 0 to 100; n defaults to 14
  roc(n)                       change over n bars, as a fraction: compare with a percentage
  stdev(n)                     standard deviation of the last n closes
  highest(n)                   highest high of the last n bars, this bar included
  lowest(n)                    lowest low of the last n bars, this bar included
  atr(n)                       average true range; n defaults to 14
  macd(fast, slow)             fast average minus slow average; defaults 12, 26
  macd_signal(fast, slow, n)   average of the macd line; defaults 12, 26, 9
  bb_upper(n, width)           upper Bollinger band; defaults 20, 2
  bb_lower(n, width)           lower Bollinger band; defaults 20, 2
  stoch_k(n, smooth)           stochastic %K, 0 to 100, averaged over smooth bars; defaults 14, 3
  stoch_d(n, smooth, d)        stochastic %D: stoch_k averaged over d bars; defaults 14, 3, 3
  adx(n)                       average directional index, 0 to 100: how strong a trend is, whichever way; n defaults to 14
  plus_di(n)  minus_di(n)      Wilder's directional indicators, 0 to 100; n defaults to 14
  cci(n)                       commodity channel index of the typical price; n defaults to 20, at least 2
  williams_r(n)                Williams %R, -100 to 0; n defaults to 14
  mfi(n)                       money flow index, 0 to 100; needs volume; n defaults to 14
  obv()                        on-balance volume, a running total; needs volume; compare it with its own average: obv() > sma(obv(), 20)
  vwap(n)                      volume-weighted average of (high + low + close) / 3 over n bars; needs volume; n defaults to 20
  keltner_upper(n, width, atr) upper Keltner channel: ema(n) plus width average true ranges over atr bars; defaults 20, 2, 10
  keltner_lower(n, width, atr) lower Keltner channel: ema(n) minus width average true ranges over atr bars
  supertrend(n, mult)          supertrend line, under the price in an uptrend; defaults 10, 3
  supertrend_up(n, mult)       a condition, true in an uptrend: buy when supertrend_up(10, 3)
  wma(n)  hma(n)               weighted and Hull moving averages of the last n values; hma needs n of at least 2
  median(n)                    median of the last n values
  zscore(n)                    standard deviations from the n-bar average; n at least 2
  percent_rank(n)              share of the previous n values below this one, 0 to 100
  slope(n)                     least-squares slope over n bars, per bar; n at least 2
  correl(other, n)             correlation of the one-bar changes of this ticker's close and of another series over n bars, n at least 2: correl(close of SPY, 60)
  bars_since(condition)        bars since the condition was last true; unknown until it has been: bars_since(close crosses above sma(50)) < 10
  sum(n)                       sum of the last n values: sum(volume, 5)
  dema(n)  tema(n)             double and triple exponential averages, with less lag than ema
  kama(n, fast, slow)          Kaufman's adaptive average, quick in a trend and slow in chop; defaults 10, 2, 30
  aroon_up(n)  aroon_down(n)   0 to 100: how recent the highest high and the lowest low of the last n + 1 bars are; n defaults to 25
  psar(step, max)              parabolic SAR, a stop that trails the price; defaults 0.02, 0.2; step may not be above max: buy when close crosses above psar()
  cmf(n)                       Chaikin money flow, -1 to 1; needs volume; n defaults to 20
  linreg(n)                    value at this bar of the least-squares line through the last n values; n at least 2
  rsquared(n)                  how well that line fits them, 0 to 1; n at least 2
  efficiency(n)                Kaufman's efficiency ratio, 0 (chop) to 1 (a straight run)
  streak()                     bars in a row the value rose (1, 2, 3 ...) or fell (-1, -2 ...), 0 if unchanged: rsi(streak(), 2)
  Like atr, stoch_k, stoch_d, adx, plus_di, minus_di, cci, williams_r, mfi, obv, vwap, supertrend, supertrend_up, aroon_up, aroon_down, psar and cmf take no series: they read the ticker's own bars. keltner_upper and keltner_lower take one first, for the average only.
  min(a, b)  max(a, b)  abs(x)  sqrt(x)  log(x)  exp(x)
  if(condition, a, b)          a where the condition holds, else b, both numbers: if(close > sma(200), roc(126), 0)
  Example: hold: top 5 by (exp(slope(log(close), 90) * 252) - 1) * rsquared(log(close), 90)
  Example: buy when (rsi(3) + rsi(streak(), 2) + percent_rank(roc(1), 100)) / 3 < 10
Calendar values, read from each bar's date:
  month 1 to 12, day 1 to 31, weekday 1 (Monday) to 7 (Sunday), year such as 2024
  month_start and month_end are conditions: the first and the last bar of a month
Position values, in sell, cover and add rules only (written with a space, not inside functions, not with [n] or "of"):
  bars held          completed bars since the buy or short sale filled, 0 on that bar
  entry price        the price the position was bought at, or for a short sold at; with several entries, their average
  last entry price   the price of the latest entry
  entries made       how many entries the position has, 1 after the first
  Example: sell when bars held >= 10 or close > entry price * 1.1
  Example: add when close > last entry price * 1.03

## Parameters

A parameter is a named number on its own line: fast = 50. Use its name wherever a plain number goes: in rules (sma(fast), close[lag], rsi(n) < limit), in stop loss, trailing stop, take profit, risk per trade, and in hold ("hold: top n by roc(126)"). Add a range to let the plugin test values: fast = 50 in 20..100 step 10. The value after = is the one used, and it must lie inside the range; step is optional and defaults to 1 (or 1% for percentages). Write % on every number of a percentage parameter: stop = 8% in 4%..12% step 2%. Declare parameters only when the description asks to test, tune or vary a value. A name uses letters, digits and underscores and must not be a word the language already uses (a series, function, setting or calendar name, or words such as top, step or in): fast_ma, slow_ma and stop_pct are safe.

## Do not

- Do not invent settings, functions, series or words that this document does not list. If the language cannot say it, say so in a NOTE.
- Do not write more than one "buy when" or one "sell when" in the same scope (the shared rules, or one "for TICKER:" section), nor more than one "short when" or one "cover when". Join conditions with "and" or "or" inside the one rule.
- Do not put a setting after a "for TICKER:" line, except stop loss, trailing stop and take profit for that ticker. Put settings before the first "for" line, or after "for all:".
- Do not set the same setting twice.
- Do not write dates any way but YYYY-MM-DD, such as 2015-01-31.
- Do not short or borrow unless the description asks for it: then use short when and cover when, or weights adding up to more than 100%.
- Do not use options, futures or crypto margin products, and do not let weights or size go above 200%. A sell rule only closes a long position, and a cover rule only a short one.
- Do not write a cover rule without a short rule, or combine hold with short or cover rules.
- Do not use bars held, entry price, last entry price or entries made in a buy or short rule, inside a function, or with [n] or "of".
- Do not put an expression where a function wants a period: write sma(200), not sma(100 * 2).
- Do not leave a blank line inside a rule, or put prose in the fence. A # comment line is fine.
- Do not give universe weights when you use hold, and do not use weights together with size.
- Do not combine risk per trade with weighting, or with a rebalance other than never.
- Do not use "buy when true" (or "buy when always") together with stop loss, trailing stop or take profit. After a stop or target closes a position, the buy rule must be false at one close before the ticker can be bought again, and "buy when true" never is, so the ticker would never be held again. Use a condition that can turn false, such as a trend filter: buy when close > sma(200). The same goes for "short when true".
- Do not add settings the description did not ask for, other than name. Do not invent dates, costs or capital: leave them out unless the description gives them or the strategy needs one, and then say so in a NOTE.
- Do not leave out universe, or leave a ticker with neither a buy rule nor a short rule (except with hold).

## Worked examples

${EXAMPLES.map(renderExample).join('\n\n')}`;

export function userMessage(description: string): string {
  return `Description:\n${description.trim()}`;
}

export function repairMessage(draft: string, errors: Diagnostic[]): string {
  const lines = draft.split('\n');
  const problems = errors.map((e) => {
    const text = lines[e.line - 1]?.trim();
    return `- Line ${e.line}: ${e.message}${text ? `\n  ${text}` : ''}`;
  });
  return [
    `The parser found ${errors.length === 1 ? 'a problem' : `${errors.length} problems`} in your draft.`,
    '',
    ...problems,
    '',
    'Your draft was:',
    `${FENCE}strategy`,
    draft,
    FENCE,
    '',
    'Reply again in the same format with the whole strategy corrected. Change only what the problems require, and use only the settings and functions in your instructions.',
  ].join('\n');
}

// Only the start of a line is matched; the rest is trimmed, so a long run of spaces costs nothing extra.
const NOTE_HEAD = /^\s*(?:[-*•]\s+)?(?:\*\*)?NOTE(?::\*\*|\*\*:|:)/i;
/** A model reply is a few hundred characters; this keeps a runaway one from taking long to read. */
const MAX_REPLY_CHARS = 20_000;

function noteIn(line: string): string | null {
  const head = line.match(NOTE_HEAD);
  return head ? line.slice(head[0].length).trim() || null : null;
}

/** Pulls the strategy text and the notes out of a model reply; tolerant of code fences and stray prose. Null when there is no strategy. */
export function parseReply(reply: string): { source: string; notes: string[] } | null {
  // Local reasoning models can print their thinking in the reply, and it may hold a draft of its own.
  const lines = reply.slice(0, MAX_REPLY_CHARS).replace(/<think>[\s\S]*?<\/think>/gi, '').split(/\r?\n/);

  const blocks: { lang: string; from: number; to: number }[] = [];
  let lang: string | null = null;
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*```\s*([\w-]*)/);
    if (!m) continue;
    if (lang === null) {
      lang = m[1].toLowerCase();
      start = i + 1;
    } else {
      blocks.push({ lang, from: start, to: i });
      lang = null;
    }
  }
  if (lang !== null) blocks.push({ lang, from: start, to: lines.length });

  let from: number;
  let to: number;
  const block = blocks.find((b) => b.lang === 'strategy') ?? blocks.find((b) => b.lang === '') ?? blocks[0];
  if (block) {
    ({ from, to } = block);
  } else {
    // No fence: the strategy runs from the first line that reads like one to the first line that does not.
    const kinds: LineKind[] = [];
    let inRule = false;
    for (const line of lines) {
      const kind = lineKind(line, inRule);
      inRule = kind === 'rule' || kind === 'continuation';
      kinds.push(kind);
    }
    from = kinds.findIndex((k) => k !== 'blank' && k !== 'other' && k !== 'continuation');
    if (from < 0) return null;
    to = kinds.findIndex((k, i) => i > from && k === 'other');
    if (to < 0) to = lines.length;
  }

  const notes: string[] = [];
  const kept: string[] = [];
  lines.forEach((line, i) => {
    const note = noteIn(line);
    if (note !== null) notes.push(note);
    else if (i >= from && i < to) kept.push(line);
  });
  const source = kept.join('\n').trim();
  return source ? { source, notes } : null;
}

type Turn = { role: 'user' | 'assistant'; content: string };

const ANTHROPIC_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 16000;

function checkConfig(config: LlmConfig): void {
  if (config.provider === 'anthropic' && !config.apiKey.trim()) throw new Error('Enter your Anthropic API key in the plugin settings.');
  if (config.provider === 'openai' && !config.baseUrl.trim()) throw new Error('Enter the address of your model server in the plugin settings, such as http://localhost:8000/v1.');
  if (!(config.model.trim() || DEFAULT_MODEL[config.provider])) throw new Error('Enter the model name your server uses in the plugin settings.');
}

function buildRequest(config: LlmConfig, turns: Turn[]): { url: string; headers: Record<string, string>; body: string } {
  const model = config.model.trim() || DEFAULT_MODEL[config.provider];
  const base = config.baseUrl.trim().replace(/\/+$/, '');
  const key = config.apiKey.trim();
  if (config.provider === 'anthropic') {
    return {
      url: `${base || ANTHROPIC_URL}/v1/messages`,
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
      // No temperature: current Claude models reject it.
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages: turns }),
    };
  }
  return {
    url: `${base}/chat/completions`,
    headers: { 'content-type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...turns], temperature: 0 }),
  };
}

/** The message a service put in its error body, if any. */
function serviceMessage(text: string): string {
  try {
    const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    return typeof message === 'string' ? message.trim().slice(0, 300) : '';
  } catch {
    return '';
  }
}

function httpError(res: HttpResponse): Error {
  const { status } = res;
  if (status === 401 || status === 403) return new Error('The service rejected the API key. Check it in the plugin settings.');
  if (status === 404) return new Error('The service could not find that model or address. Check the model name and the server address in the plugin settings.');
  if (status === 429) return new Error('The service is busy or over its limit. Try again in a minute.');
  if (status >= 500) return new Error(`The service had a problem (HTTP ${status}). Try again in a minute.`);
  const detail = serviceMessage(res.text);
  return new Error(`The service refused the request (HTTP ${status})${detail ? `: ${detail}` : '.'}`);
}

function replyText(config: LlmConfig, raw: string): string {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('The service sent a reply the plugin could not read. Check the server address in the plugin settings.');
  }
  if (config.provider === 'anthropic') {
    const reply = data as { stop_reason?: string; content?: { type?: string; text?: unknown }[] };
    if (reply.stop_reason === 'refusal') throw new Error('The model declined to write this strategy. Try describing it differently.');
    return (reply.content ?? []).flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');
  }
  const content = (data as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

async function ask(config: LlmConfig, post: HttpPost, turns: Turn[]): Promise<string> {
  const { url, headers, body } = buildRequest(config, turns);
  let res: HttpResponse;
  try {
    res = await post(url, headers, body);
  } catch (e) {
    throw new Error(`Could not reach the model service (${e instanceof Error ? e.message : String(e)}). Check your connection and the server address in the plugin settings.`);
  }
  if (res.status < 200 || res.status >= 300) throw httpError(res);
  return replyText(config, res.text);
}

function noStrategy(reply: string): Error {
  const said = reply.replace(/\s+/g, ' ').trim();
  return new Error(`The model's reply did not contain a strategy.${said ? ` It said: "${said.length > 200 ? `${said.slice(0, 200)}…` : said}"` : ''}`);
}

/**
 * Asks for a draft, checks it with the parser, and asks for a repair while it has errors, at most
 * `maxRepairs` times. Rejects with a plain-English Error when the service cannot be used or sends no strategy.
 */
export async function draftStrategy(
  description: string,
  config: LlmConfig,
  post: HttpPost,
  opts: { maxRepairs?: number; defaults?: Partial<Defaults>; onStatus?: (text: string) => void } = {},
): Promise<Draft> {
  checkConfig(config);
  const maxRepairs = opts.maxRepairs ?? 2;
  const turns: Turn[] = [{ role: 'user', content: userMessage(description) }];
  let draft: Draft | null = null;
  opts.onStatus?.('Writing a draft…');
  for (let attempts = 1; ; attempts++) {
    const reply = await ask(config, post, turns);
    const parsed = parseReply(reply);
    if (!parsed) {
      // A repair that comes back empty-handed leaves the earlier draft, which is still worth showing.
      if (draft) return { ...draft, attempts };
      throw noStrategy(reply);
    }
    const { errors, warnings } = parseSpec(parsed.source, { defaults: opts.defaults });
    const earlier: string[] = draft?.notes ?? [];
    draft = { source: parsed.source, notes: [...earlier, ...parsed.notes.filter((n) => !earlier.includes(n))], errors, warnings, attempts };
    if (errors.length === 0 || attempts > maxRepairs) return draft;
    opts.onStatus?.(`Fixing ${errors.length} problem${errors.length === 1 ? '' : 's'}…`);
    turns.push({ role: 'assistant', content: reply }, { role: 'user', content: repairMessage(parsed.source, errors) });
  }
}
