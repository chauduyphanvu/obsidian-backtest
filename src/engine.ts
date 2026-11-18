import { intervalMs, type CashRate, type Commission, type Fill, type Margin, type Rebalance, type Sizing, type StopLevel, type Stops } from './dsl.ts';
import type { BarRule, PosState } from './evaluate.ts';
import { DAY } from './format.ts';
import * as ind from './indicators.ts';
import type { Asset, Bars } from './types.ts';

/** `margin call` and `ruin` are forced closes of a block that borrows (SimParams.margin). */
export type ExitReason = 'signal' | 'stop loss' | 'trailing stop' | 'take profit' | 'open' | 'margin call' | 'ruin';

/** One entry of a position built in steps. */
export interface TradeEntry {
  /** When it filled, at what price (slippage included), the shares it bought and the money put in, costs not included. */
  t: number;
  price: number;
  shares: number;
  money: number;
  /** The ticker's bar whose close its rule was read at: the buy rule or a ranking for the first, the add rule for the rest. */
  signalT: number;
}

export interface Trade {
  asset: string;
  /** Present only for a short position; a long one leaves it out. */
  side?: 'short';
  /** When the first entry filled. */
  entryT: number;
  /** Fill prices, slippage included; with several entries, the entry price is their average, weighted by shares. */
  entryPrice: number;
  exitT: number;
  exitPrice: number;
  /**
   * Price return after costs on both sides. A short's is measured on the long convention's net basis: what it brought in a
   * share at the entry less what it paid at the exit and in borrow fees, over what it brought in.
   */
  ret: number;
  reason: ExitReason;
  /** Bars from the entry fill to the exit fill, counted in the asset's own bars; to the last bar while still open. */
  bars: number;
  /** Cash profit after costs and slippage, rebalancing trades included; an open position is marked at the last close. */
  pnl: number;
  /** What the engine knew when it bought and sold, recorded as it decided (see explain.ts). */
  why?: TradeWhy;
  /** With `entries` above 1: each entry, the first one first. */
  entries?: TradeEntry[];
  /** For a short: the borrow fees it paid over its life, part of `pnl`. */
  borrow?: number;
}

/** A ranking decision, shared by the trades it made. */
export interface RankDecision {
  /** The time on the run's timeline at whose close it was made. */
  t: number;
  top: number;
  /** Tickers that could be chosen: buy rule true, sell rule not true, score known. */
  eligible: number;
  /** Held tickers it sold, which its buys waited for. */
  sold: string[];
  /** Every ticker at the decision, the eligible ones first and best first, with the time of its bar the decision read (NaN when it had none); null when the universe has more than 12. */
  table: { asset: string; score: number; eligible: boolean; t: number }[] | null;
}

/** One ticker's place in a ranking decision. */
export interface RankPlace {
  decision: RankDecision;
  /** Among the eligible, 0 for the best; -1 when the ticker could not be chosen. */
  place: number;
  score: number;
  /** The ticker's bar the decision read: its bar at the decision, or with `fill: close` on mixed clocks maybe the one before (see simulate); NaN when it had none. */
  t: number;
}

/** Why a position was closed. */
export type ExitWhy =
  /**
   * The exit rule (sell, or cover for a short) held at the close of the ticker's bar `t`; with `flip`, the other side's
   * entry rule held there instead, which closes the position whether or not that side then opens.
   */
  | { k: 'rule'; t: number; flip?: true }
  /** A ranking decision, which read the ticker's bar `t`, did not keep it. */
  | { k: 'rank'; t: number; rank: RankPlace }
  /**
   * A stop or the target: the level the bar reached, the highest price a trailing stop trailed from, and whether the bar
   * opened beyond the level, so the fill was at the open. With `magnify`, `inside` says how the bar was read: looked
   * inside, when `atOpen` is about the smaller bar the level was reached in, or as a whole bar, and why.
   */
  | { k: 'level'; level: number; high: number | null; atOpen: boolean; inside?: InsideWhy }
  /** A margin call made at the close `t`, where equity was below the maintenance share of the gross value of the positions. */
  | { k: 'margin'; t: number; equity: number; gross: number }
  /** Equity fell below 0, or to 0 with a position open, at `t` (an open or a close), so everything was closed there and trading stopped. */
  | { k: 'ruin'; t: number; equity: number };

/**
 * How a bar with a stop or target inside its range was read with `magnify`: through its smaller bars, with the start of
 * the one the level was reached in, or as a whole bar because its smaller bars were not there, were not all there, or
 * did not match it (see lookInside).
 */
export type InsideWhy = { k: 'inside'; t: number } | { k: 'whole'; why: Exclude<InsideVerdict, { ok: true }>['why'] };

export interface TradeWhy {
  /** The ticker's bar whose close the buy was read at: the signal, or the bar a ranking decision read. */
  buyT: number;
  /** With `hold`: the decision that chose it. */
  rank: RankPlace | null;
  /** The buy signals just before this one were held back while `input` warmed up, from the bar `fromT`. */
  warmup: { input: WarmupInput; n: number; fromT: number } | null;
  /** After the stop or target exit at `exitT` the buy rule kept holding, last at `heldT`; it had to stop holding first, and did at `clearedT`, the bar before this signal. */
  rearm: { exitT: number; heldT: number; clearedT: number } | null;
  /** A ranking buy that waited for the sells of its decision. */
  waited: boolean;
  /** The bar whose close the sizing and stop inputs (ATR, volatility) were read at: the last close known at the fill. */
  inputT: number;
  /** Equity the size was measured against, at the fill: at the open, or at the close with `fill: close`. */
  equity: number;
  /** The weight used: the configured one, or the inverse-volatility share. */
  weight: number;
  /** The money the buy wanted: the weight times equity, or the risk-per-trade amount, capped at the weight. */
  wanted: number;
  /** Cash there was just before the buy. */
  cash: number;
  /** Money put in, costs not included, and the shares it bought. */
  spent: number;
  shares: number;
  /** Levels set at the fill, and moved by each later entry of a position built in steps; null when there is none. */
  stopLoss: number | null;
  takeProfit: number | null;
  /** Rebalancing trades during the position's life. */
  topUps: number;
  trims: number;
  /** Costs paid on the position's fills: the buy, rebalancing, and the sell once it is sold; commission included. */
  fees: number;
  /** Null while the position is still held. */
  exit: ExitWhy | null;
  /** With `entries` above 1: each entry after the first, in order. */
  adds?: AddWhy[];
  /** With a commission: what it came to. */
  commission?: CommissionWhy;
}

/** What the engine knew at an entry after the first. Levels are those in force after it. */
export interface AddWhy {
  /** The ticker's bar whose close the add rule was read at. */
  signalT: number;
  /** As in TradeWhy: the last close known at the fill, equity there, the ticker's weight. */
  inputT: number;
  equity: number;
  weight: number;
  /** A whole position's money at this fill: the weight times equity, or the risk-per-trade amount. */
  full: number;
  /** What the position was worth before the add (or, on a rebalance at the same fill, what the rebalance took it to). */
  held: number;
  /** The money the add wanted: a step of `full`, cut so the position stays within `full`. */
  wanted: number;
  cash: number;
  spent: number;
  shares: number;
  /** The average entry price after it, and the levels moved to it. */
  average: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

/** The commission over a position's life. */
export interface CommissionWhy {
  /** Every fill's: the entries, rebalancing and the exit. */
  paid: number;
  /** The entries' only. */
  entries: number;
  /** The exit's, or for a position still held what selling at the last close would pay. */
  exit: number;
  /** The shares the exit sold, or the shares held at the end. */
  exitShares: number;
}

/** An order waiting that closes the side held and opens the other: a short sale while long, or a buy while short. */
export const isFlip = (st: Pick<AssetState, 'side' | 'pending'>): boolean => (st.side === 'long' && st.pending === 'short') || (st.side === 'short' && st.pending === 'buy');

export interface AssetState {
  name: string;
  /** The configured weight. */
  weight: number;
  /** The side held at the end, null when flat. */
  side: 'long' | 'short' | null;
  since: number | null;
  /**
   * An order from the last bar's signal that would fill at the next open (or, with `fill: close`, one a ranking decision
   * made while the ticker had no bar, for its next close). `add` is the next entry of a position built in steps, on
   * whichever side is held. `sell` closes a long and `cover` a short; `short` while long, or `buy` while short, is a flip:
   * the position closes and the other side opens at the same fill.
   */
  pending: 'buy' | 'sell' | 'add' | 'short' | 'cover' | null;
  /** Negative for a short. */
  shares: number;
  lastClose: number;
  /** Shares at the last close, negative for a short. */
  value: number;
  /** The weight a buy at the next open would use, estimated from the last close; with `entries`, that of the next entry. */
  targetWeight: number;
  /** With `entries` above 1: the entries the open position has made, 0 when flat. */
  entries?: number;
  /**
   * Only with `fill: close`: a position the rules or a ranking decision opened or sold whole at the
   * close of the ticker's last bar, at that close; null when nothing did. Rebalancing trims and
   * top-ups and stop exits are not counted. Price with slippage. A flip fills the new side, with `closed` the shares of the
   * position it closed at the same close.
   */
  filled?: { side: 'buy' | 'sell' | 'add' | 'short' | 'cover'; shares: number; price: number; closed?: number } | null;
  /** While held: the position as the exit and add rules read it at the next bar. */
  pos?: PosState;
  /**
   * Only when not long after a stop or target exit (or a margin call), outside a ranking: the buy rule has to stop holding
   * at a close before it can buy again. `rearmingShort` is the same for the short rule, when not short.
   */
  rearming?: true;
  rearmingShort?: true;
  /**
   * A margin call made at the last close closes this position at the next open, whatever the block's `fill`: `pending` is
   * then its sell or cover.
   */
  marginCall?: true;
  /**
   * While held with a stop or target: the levels in force for the next bar, the trailing stop's moved by the last bar's
   * high (for a short, its low).
   */
  levels?: { stop: number | null; target: number | null };
}

export interface SimParams {
  assets: Asset[];
  from: number | null;
  to: number | null;
  capital: number;
  costBps: number;
  slippageBps: number;
  rebalance: Rebalance;
  /** Per asset name; a missing asset has no stops. */
  stops: Record<string, Stops>;
  cash: CashRate;
  sizing: Sizing;
  /** Hold only the `top` eligible assets with the highest score. */
  rank: { top: number } | null;
  /** When orders fill; absent means next open. */
  fill?: Fill;
  /** Charged on every order besides `costBps`; absent means none. */
  commission?: Commission;
  /** Entries a position is built in: the first by the buy rule or a ranking, the rest by the add signal. Absent means 1. */
  entries?: number;
  /**
   * The size of the smaller bars to look inside each bar with, for the stops and targets of the assets whose smaller bars
   * `data` holds under insideKey; `interval` is the size of the assets' own bars. Absent means none.
   */
  magnify?: string;
  interval?: string;
  /** Borrowing, for a block that shorts or holds more than its equity; absent, the block is long or flat and never borrows. */
  margin?: Margin;
  /** Told about every fill, for tests of the engine's promises; absent in a run. */
  onFill?: (fill: FillSeen) => void;
  /** Told about the book at every close once it is marked, for the same tests; absent in a run. */
  onClose?: (seen: CloseSeen) => void;
}

/** The book at a close as SimParams.onClose sees it: the cash, each asset's shares (in the universe's order) and the closes they are marked at. */
export interface CloseSeen {
  t: number;
  cash: number;
  shares: number[];
  closes: number[];
  equity: number;
}

/** A fill as SimParams.onFill sees it, just after it is made. */
export interface FillSeen {
  t: number;
  asset: string;
  /**
   * The same words for either side, the sign of `shares` giving the side: `entry` opens a long or a short, `sell` closes
   * either by its rules, `trim` and `rebalance` make it smaller or larger, and `margin` is a forced close, by a margin call
   * or ruin.
   */
  kind: 'entry' | 'add' | 'rebalance' | 'owed' | 'trim' | 'sell' | 'stop' | 'margin';
  /** The price it filled at before slippage, and the asset's shares after it, negative for a short. */
  price: number;
  shares: number;
  /** Cash after it. */
  cash: number;
  /** For a buy or a short sale that makes the position larger: the equity it was sized against and the weight it used (the configured one, or its inverse-volatility share); NaN otherwise. */
  equity: number;
  weight: number;
}

/** Per asset, aligned with its bars. */
export interface Signals {
  /** 1 where the buy rule holds. */
  buy: number[];
  /** The sell rule; null when there is none. */
  sell: BarRule | null;
  /** 1 where the short rule holds; absent when there is none. */
  short?: number[];
  /** The cover rule; absent or null when there is none. */
  cover?: BarRule | null;
  /** The ranking score; null outside rank mode. */
  score: number[] | null;
  /** When to make the next entry of a position built in steps; absent or null, no entry after the first is made. */
  add?: BarRule | null;
}

/** An input a buy needs that can still be warming up: the sizing's, or a stop's or target's distance. */
export type WarmupInput = 'risk per trade' | 'inverse volatility' | 'stop loss' | 'trailing stop' | 'take profit';

/** Buy signals not acted on because `input`, measured over `n` bars, was not known yet at the signal. */
export interface Skipped {
  asset: string;
  input: WarmupInput;
  n: number;
  /** Runs of consecutive signals (or ranking decisions) held back, each counted once. */
  count: number;
}

export interface RunResult {
  t: number[];
  equity: number[];
  /** Gross exposure at each close: the value of the positions, long and short, as a fraction of equity. */
  exposure: number[];
  trades: Trade[];
  states: AssetState[];
  costs: number;
  /** Interest earned on cash. */
  interest: number;
  /** The cash rate's return over each step, aligned with `t` (0 on the first bar). */
  cashReturn: number[];
  /** Entries not taken while an input warmed up, in the order first seen. */
  skipped: Skipped[];
  /** With a commission: the commission paid, part of `costs`, and how many adds and rebalancing trades were not made because it would have been too large a share of them. */
  commission?: number;
  smallTrades?: number;
  /** With `magnify`: for each asset that had smaller bars, in the universe's order, what was looked inside. */
  inside?: InsideReport[];
  /** Every fill, rebalancing trims and top-ups included, in the order made: what an account following the run is set against. */
  fills: FillLog;
  /** Only for a block that borrows (SimParams.margin): long value less short value as a fraction of equity, at each close. */
  netExposure?: number[];
  /** Only for a block that borrows: the borrow fees on its shorts and the interest on money owed, both part of the equity. */
  borrowFees?: number;
  marginInterest?: number;
  /** Only for a block that borrows: the margin calls made, and the bars where the buy and short rules both held so neither opened. */
  marginCalls?: number;
  conflicts?: number;
  /** Only for a block that borrows: when equity fell below 0, or to 0 with a position open, and what was still owed after closing everything; null when it never did. */
  ruin?: { t: number; deficit: number } | null;
}

/**
 * A run's fills, one entry per fill in the order made, as columns: when, which asset, what kind of fill, the asset's shares
 * after it and the price it filled at before slippage, in the run's own (adjusted) prices.
 */
export interface FillLog {
  t: number[];
  asset: string[];
  kind: FillSeen['kind'][];
  sharesAfter: number[];
  price: number[];
}

/** What `magnify` did for one asset. */
export interface InsideReport {
  asset: string;
  /** The first bar of the run that has smaller bars, from which on bars were looked inside; null when none has. */
  from: number | null;
  /** Bars from `from` on with a stop or target inside their range: looked inside, or read as whole bars because their smaller bars were missing, not all there or did not match. */
  looked: number;
  whole: number;
}

/**
 * An add or a rebalancing trade is not made when its commission would be this share of its value or more: the ceiling
 * the language puts on `costs`.
 */
export const SMALL_TRADE = 0.1;
const NO_STOPS: Stops = { stopLoss: null, trailingStop: null, takeProfit: null };
/** A ranking decision keeps its whole table for the explanations only up to this many tickers. */
const TABLE_MAX = 12;

/** The commission of one order of `shares` worth `value` at its fill: the minimum applies first, then the cap. */
export function commissionFee(c: Commission, value: number, shares: number): number {
  if (c.k === 'order') return c.fee;
  const fee = Math.max(c.fee * shares, c.min);
  return c.max === null ? fee : Math.min(fee, c.max * value);
}

/**
 * Where `data` holds an asset's smaller bars of size `interval`, for `magnify`. No name a block can give holds a slash: a
 * ticker is letters, digits and `^ . _ = -`, and a CSV file is named by what follows the last slash of its path (dsl.ts
 * parseRef). So no ticker or file is called this, whatever spaces its name has.
 */
export const insideKey = (name: string, interval: string): string => `${name}/${interval}`;
/** Whether a key of `data` is an insideKey, not a ticker. */
export const isInsideKey = (key: string): boolean => key.includes('/');

/** A bar's smaller bars as its stops and targets move through them: their starts, and their opens, highs and lows on the bar's own scale. */
export interface InsidePath {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
}

/** A bar's smaller bars can be looked inside, or why not: there are none, some are missing, or they do not match the bar. */
export type InsideVerdict = { ok: true; path: InsidePath } | { ok: false; why: 'none' | 'missing' | 'mismatch' };

/** How far smaller bars, scaled, may stray from the open, high, low or close of the bar they make up: this share of its range. */
export const INSIDE_TOLERANCE = 0.25;

/**
 * The path inside the bar with open `o`, high `h`, low `l` and close `c`, from its smaller bars `small` at indexes `from` up
 * to `to`, of which there must be `count` (0: any number from 1). The smaller bars may come from another series than the
 * bar, such as Yahoo's intraday bars, which are not adjusted for dividends, under its adjusted daily bars; a split or a
 * dividend changes that adjustment only between two days. So they are scaled by one factor: the root of the smallest times
 * the largest of the bar's open, high, low and close divided by their first open, highest high, lowest low and last close.
 * Scaled, those four must each lie within INSIDE_TOLERANCE of the bar's range of the bar's own, or the smaller bars
 * describe another path. The path then takes the bar's own prices where the smaller bars put them: the first open is
 * the bar's open, the first highest high its high and the first lowest low its low, and every other price is kept
 * inside the bar's range. So nothing inside the bar trades where the bar did not, and only the order comes from the
 * smaller bars.
 */
export function lookInside(o: number, h: number, l: number, c: number, small: Bars, from: number, to: number, count: number): InsideVerdict {
  if (to <= from) return { ok: false, why: 'none' };
  if (count > 0 && to - from !== count) return { ok: false, why: 'missing' };
  let hi = from;
  let lo = from;
  for (let j = from + 1; j < to; j++) {
    if (small.h[j] > small.h[hi]) hi = j;
    if (small.l[j] < small.l[lo]) lo = j;
  }
  const first = small.o[from];
  const last = small.c[to - 1];
  const ratios = [o / first, h / small.h[hi], l / small.l[lo], c / last];
  const k = Math.sqrt(Math.min(...ratios) * Math.max(...ratios));
  const off = Math.max(Math.abs(k * first - o), Math.abs(k * small.h[hi] - h), Math.abs(k * small.l[lo] - l), Math.abs(k * last - c));
  if (!(off <= INSIDE_TOLERANCE * (h - l))) return { ok: false, why: 'mismatch' };
  const within = (x: number) => Math.min(h, Math.max(l, x));
  const path: InsidePath = { t: [], o: [], h: [], l: [] };
  for (let j = from; j < to; j++) {
    const oj = j === from ? o : within(k * small.o[j]);
    path.t.push(small.t[j]);
    path.o.push(oj);
    path.h.push(Math.max(j === hi ? h : within(k * small.h[j]), oj));
    path.l.push(Math.min(j === lo ? l : within(k * small.l[j]), oj));
  }
  return { ok: true, path };
}

/** The index of the first of `t` at or after `at` (t sorted). */
export function firstAtOrAfter(t: number[], at: number): number {
  let a = 0;
  let b = t.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (t[m] < at) a = m + 1;
    else b = m;
  }
  return a;
}

/** The index of the last of `t` at or before `at` (t sorted), or -1. */
export function barAt(t: number[], at: number): number {
  let a = 0;
  let b = t.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (t[m] <= at) a = m + 1;
    else b = m;
  }
  return a - 1;
}

/**
 * The smaller bars inside an asset's bar `i`, as simulate reads them: those that start within the bar's span, which is
 * `interval` from its start. A Binance bar must hold every one of them, since Binance makes a bar every interval around the
 * clock; for Yahoo, the loader keeps only days whose regular session it has in full (data.ts parseYahooInside).
 */
export function insideBar(bars: Bars, i: number, source: string, small: Bars, interval: string, magnify: string): InsideVerdict {
  const span = intervalMs(interval);
  const from = firstAtOrAfter(small.t, bars.t[i]);
  const to = firstAtOrAfter(small.t, bars.t[i] + span);
  return lookInside(bars.o[i], bars.h[i], bars.l[i], bars.c[i], small, from, to, insideCount(source, span, intervalMs(magnify)));
}

/** How many smaller bars a bar of `span` must hold: all of them on Binance, any number from 1 elsewhere. */
const insideCount = (source: string, span: number, small: number): number => (source === 'binance' ? span / small : 0);

/** Every time of the series `ts` from `start` to `end`, once each and in order. Each series' times rise, so they merge in one pass. */
function mergeTimes(ts: number[][], start: number, end: number): number[] {
  let out: number[] = [];
  for (const t of ts) {
    const merged: number[] = [];
    let i = 0;
    let j = firstAtOrAfter(t, start);
    const stop = barAt(t, end) + 1;
    while (i < out.length && j < stop) {
      if (out[i] < t[j]) merged.push(out[i++]);
      else if (t[j] < out[i]) merged.push(t[j++]);
      else {
        merged.push(out[i++]);
        j++;
      }
    }
    while (i < out.length) merged.push(out[i++]);
    while (j < stop) merged.push(t[j++]);
    out = merged;
  }
  return out;
}

/**
 * The first input a buy signalled at a bar needs that is still unknown there, with its period; null when all are known.
 * `atr` and `vol` give the ticker's average true range and volatility over `n` bars at that bar.
 */
export function missingInputAt(sizing: Sizing, stops: Stops | undefined, atr: (n: number) => number, vol: (n: number) => number): { input: WarmupInput; n: number } | null {
  if (sizing.k === 'risk' && Number.isNaN(atr(sizing.n))) return { input: 'risk per trade', n: sizing.n };
  if (sizing.k === 'invvol' && Number.isNaN(vol(sizing.n))) return { input: 'inverse volatility', n: sizing.n };
  for (const [input, level] of [['stop loss', stops?.stopLoss], ['trailing stop', stops?.trailingStop], ['take profit', stops?.takeProfit]] as const) {
    if (level?.k === 'atr' && Number.isNaN(atr(level.n))) return { input, n: level.n };
  }
  return null;
}

/** The period of time `t` for a rebalance or ranking: bars with the same key fall in one period. */
export function periodKey(t: number, mode: Rebalance): number {
  switch (mode) {
    case 'weekly':
      // Epoch day 0 was a Thursday; shifting by 3 starts weeks on Monday.
      return Math.floor((Math.floor(t / DAY) + 3) / 7);
    case 'monthly':
      return monthIndex(Math.floor(t / DAY));
    case 'quarterly':
      return Math.floor(monthIndex(Math.floor(t / DAY)) / 3);
    case 'yearly':
      return Math.floor(monthIndex(Math.floor(t / DAY)) / 12);
    case 'never':
      return 0;
  }
}

const seriesKeys = new WeakMap<number[], Partial<Record<Rebalance, number[]>>>();

/** periodKey of each of the times `t`, worked out once per series, since every run of a sweep reads them on every bar. */
export function periodKeys(t: number[], mode: Rebalance): number[] {
  let byMode = seriesKeys.get(t);
  if (!byMode) seriesKeys.set(t, (byMode = {}));
  return (byMode[mode] ??= t.map((x) => periodKey(x, mode)));
}

/**
 * The UTC year times 12 plus the month (0 for January) of the day `day` days after the epoch, as Date gives them, without
 * a Date for every bar: Howard Hinnant's civil_from_days. Its years start in March, which only moves January and February
 * to the end of the year before, and the count of months comes out the same.
 */
function monthIndex(day: number): number {
  const z = day + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  return (era * 400 + yoe) * 12 + Math.floor((5 * doy + 2) / 153) + 2;
}

/**
 * Portfolio simulation. Each asset is either at its target weight, long or short, or in cash.
 *
 * Every order is decided at a close: a rule's buy or sell, a ranking decision, and a rebalance,
 * which belongs to the close of each asset's last bar of a period. An order fills at the asset's
 * next open, or with `fill: close` at that same close, the first price after the decision either
 * way. One that can't fill there waits for the asset's next open (or next close): a ranking order
 * for an asset with no bar at the decision, a ranking buy waiting for the sells of its decision,
 * and a rebalance top-up short of cash, which stays owed until the asset's next rebalance. So with
 * close fills a rebalance trades at each asset's last close of the period, together with the
 * ranking decision made there, and nothing decided on the final bar is left pending unless its
 * asset had no bar then. At each fill point sells go first, then rebalancing and buys; sizes are
 * measured against equity at that open or close, and ATR and volatility are read at the last close
 * known there: the one before the open, or that close itself.
 *
 * Stops and targets fill inside a bar, after the open's orders. A position bought at an open is
 * watched from that bar on; one bought at a close only from its asset's next bar, since the range
 * of the bar it was bought at came before the fill. The trailing level starts from the fill's price
 * before slippage (the open, or the close) and moves with the highs of later completed bars.
 *
 * With `magnify`, a bar that opens between the stop and the target and holds one of them in its range (the stop at the
 * highest the trailing level could reach in it) is read as its smaller bars, one after another, with the same rule: so
 * the smaller bars decide which level comes first and where a gap between them fills, and the trailing level moves with
 * each smaller bar that has ended. Rules, rankings and every fill other than a stop's or a target's stay on the bars.
 *
 * A short holds negative shares. Its stops and target are kept in "side space", as minus the price, so the long's
 * arithmetic runs on (-open, -low, -high): its stop sits above the entry, its target below, and it trails from the lowest
 * low. Only a block that borrows (`margin`) can short or hold more than its equity, and every rule about borrowing is
 * gated behind it (buying room, interest on a negative balance, the borrow fee, margin calls and ruin), so a long-only
 * block within 100% runs the long arithmetic as it always has. From flat, a long opens when buy holds and sell does not,
 * a short when short holds and cover does not, and neither when both would. A position closes on its own exit rule or on
 * the other side's entry rule, and the bar is then read as if flat, so the other side opens at the same fill (a flip)
 * when its entry holds alone. When equity is below the maintenance share of the gross value at a close, every position
 * closes at its next open, before anything else there; when equity falls below 0 at an open or a close (or to 0 with a
 * position open), everything closes there and the run is over, its equity 0 from then on.
 */
export function simulate(p: SimParams, data: Map<string, Bars>, signals: Map<string, Signals>): RunResult {
  const atClose = p.fill === 'close';
  const newArm = () => ({ armed: true, stoppedT: 0, blockedT: null as number | null, cleared: null as { exitT: number; heldT: number; clearedT: number; idx: number } | null });
  const steps = p.entries ?? 1;
  const assets = p.assets.map((a, order) => {
    const bars = data.get(a.name);
    if (!bars || bars.t.length === 0) throw new Error(`No price data for ${a.name}`);
    return {
      name: a.name,
      order,
      weight: a.weight,
      bars,
      source: a.source,
      sig: signals.get(a.name)!,
      stops: p.stops[a.name] ?? NO_STOPS,
      i: -1, // index of the latest bar at or before the current time
      shares: 0,
      lastClose: NaN,
      entryT: 0,
      entryIdx: 0,
      entryPrice: 0,
      highWater: 0,
      // Levels fixed when the position opens; the trailing one moves with highWater.
      hard: -Infinity,
      trail: null as { mul: number } | { dist: number } | null,
      target: Infinity,
      // Cash paid in and taken out over the position's life, for its profit.
      cashIn: 0,
      cashOut: 0,
      // A short's borrow fees: in all, and summed per share held.
      borrow: 0,
      borrowPS: 0,
      // After a stop or target exit (or a margin call), that side's entry rule must stop holding before it can fire again.
      arm: { long: newArm(), short: newArm() },
      // A margin call closes the position at the asset's next open.
      called: false,
      pending: null as AssetState['pending'],
      // Place in the latest ranking decision (0 is the best score), for funding buys in that order.
      rankPos: Infinity,
      // The last signal or decision for this asset was held back while an input warmed up.
      heldBack: false,
      // The rebalance period whose top-up could not be fully paid for; it is completed as cash arrives.
      owed: null as number | null,

      // The rest only records why, for the trade explanations.
      buyWhy: null as Pick<TradeWhy, 'buyT' | 'rank' | 'warmup' | 'rearm'> | null,
      sellWhy: null as ExitWhy | null,
      why: null as TradeWhy | null,
      fees: 0,
      topUps: 0,
      trims: 0,
      waited: false,
      heldFrom: 0,
      heldInput: null as { input: WarmupInput; n: number } | null,
      warm: null as TradeWhy['warmup'],
      lastFill: null as (NonNullable<AssetState['filled']> & { t: number }) | null,

      // A position built in steps: entries made, what they bought, the latest fill, and the ATR distances its levels keep.
      made: 0,
      lastEntryPrice: 0,
      entryShares: 0,
      entryMoney: 0,
      entryComm: 0,
      comm: 0,
      slDist: NaN,
      tpDist: NaN,
      addT: 0,
      entryList: [] as TradeEntry[],
      addList: [] as AddWhy[],

      // With magnify: the smaller bars, where each bar's start and end among them, how many a bar must hold, the first
      // bar of the run that has any, and the bars with a level inside them that were looked inside or read whole.
      inside: null as { bars: Bars; from: Int32Array; to: Int32Array; count: number; first: number; looked: number; whole: number } | null,
    };
  });
  type A = (typeof assets)[number];

  // Start once every asset has data, so the weights mean the same thing throughout.
  const start = Math.max(p.from ?? -Infinity, ...assets.map((a) => a.bars.t[0]));
  const end = p.to ?? Infinity;
  const timeline = mergeTimes(assets.map((a) => a.bars.t), start, end);
  if (timeline.length < 2) throw new Error('No bars in the chosen date range');

  for (const a of assets) {
    while (a.i + 1 < a.bars.t.length && a.bars.t[a.i + 1] < start) a.i++;
    if (a.i >= 0) a.lastClose = a.bars.c[a.i];
  }

  const span = p.magnify && p.interval ? intervalMs(p.interval) : NaN;
  for (const a of assets) {
    const small = span > 0 ? data.get(insideKey(a.name, p.magnify!)) : undefined;
    if (!small) continue;
    const n = a.bars.t.length;
    const from = new Int32Array(n);
    const to = new Int32Array(n);
    let first = -1;
    for (let i = 0, j = 0; i < n; i++) {
      while (j < small.t.length && small.t[j] < a.bars.t[i]) j++;
      from[i] = j;
      while (j < small.t.length && small.t[j] < a.bars.t[i] + span) j++;
      to[i] = j;
      if (first < 0 && to[i] > from[i] && a.bars.t[i] >= start && a.bars.t[i] <= end) first = i;
    }
    a.inside = { bars: small, from, to, count: insideCount(a.source, span, intervalMs(p.magnify!)), first, looked: 0, whole: 0 };
  }

  const memo = new Map<string, number[]>();
  const cached = (key: string, make: () => number[]) => {
    let v = memo.get(key);
    if (!v) memo.set(key, (v = make()));
    return v;
  };
  const atrAt = (a: A, n: number, idx: number) => (idx < 0 ? NaN : cached(`atr ${a.name} ${n}`, () => ind.atr(a.bars.h, a.bars.l, a.bars.c, n))[idx]);
  const volAt = (a: A, n: number, idx: number) => (idx < 0 ? NaN : cached(`vol ${a.name} ${n}`, () => ind.stdev(ind.returns(a.bars.c), n))[idx]);

  const rateBars = p.cash.k === 'ticker' ? data.get(p.cash.ref.name) : null;
  if (p.cash.k === 'ticker' && !rateBars) throw new Error(`No data for the cash rate ticker ${p.cash.ref.name}`);
  // The yield quoted at the close of the timeline's bar k: that of the rate's latest bar ended by then. A row of values
  // (FRED) is known at the end of the day it is dated, whatever its spacing, where a monthly bar would end a month later.
  const rateIdx = !rateBars ? null : rateBars.values ? ind.endedBy(rateBars.t, ind.barEnds(timeline), ind.valueEnds(rateBars.t)) : ind.alignByEnd(rateBars.t, timeline);
  const rateAt = (k: number): number => {
    if (!rateBars) return p.cash.k === 'fixed' ? p.cash.rate : 0;
    return rateIdx![k] < 0 ? 0 : rateBars.c[rateIdx![k]] / 100;
  };

  const decisions = !p.rank ? null : p.rebalance === 'never' ? timeline.map(() => 1) : ind.periodEnds(timeline, (x) => periodKey(x, p.rebalance));
  // A ranking compares tickers' closes, and with close fills trades at them. When the ranked tickers keep different clocks
  // (ind.clockOf), the closes of one period come hours apart, so a decision may read a ticker's bar of that period only
  // when every ticker trading at that time is on its clock. Otherwise it reads each ticker's latest bar that had ended by
  // the time the decision's bar began: on a day when stocks and crypto both trade, both their previous days; on a day only
  // crypto trades, crypto's own day against the stocks' last one. That is the rule evaluate.ts's clocksApart applies to
  // `of`, made one decision for every ticker, since each order the decision fills must not rest on a later close. A ticker
  // read a bar early is still sold by its own sell rule at its close, and not bought at a close where that rule holds.
  const clocks = atClose && p.rank ? assets.map((a) => ind.clockOf(a.source, a.bars.t)) : null;
  const mixed = clocks !== null && new Set(clocks).size > 1;
  const endedAt = mixed ? assets.map((a) => ind.endedBy(a.bars.t, timeline)) : null;
  const keys = assets.map((a) => periodKeys(a.bars.t, p.rebalance));
  /** Whether the asset's current bar is the one its rebalance fills at: its first bar of a period (at the open), or its last (at the close). */
  const rebalances = (a: A) =>
    atClose
      ? p.rebalance !== 'never' && cached(`end ${a.name}`, () => ind.periodEnds(a.bars.t, (x) => periodKey(x, p.rebalance)))[a.i] === 1
      : a.i > 0 && keys[a.order][a.i] !== keys[a.order][a.i - 1];

  const cost = p.costBps / 10_000;
  const slip = p.slippageBps / 10_000;
  const charge = p.commission ?? null;
  const m = p.margin ?? null;
  let cash = p.capital;
  let costs = 0;
  let interest = 0;
  let commission = 0;
  let smallTrades = 0;
  let borrowFees = 0;
  let marginInterest = 0;
  let marginCalls = 0;
  let conflicts = 0;
  let ruin = null as { t: number; deficit: number } | null;
  // A margin call made at a close, while the positions it closes wait for their next open.
  let call = null as Extract<ExitWhy, { k: 'margin' }> | null;
  /** The commission of the latest buy or sell, and whether the latest buy was not made because it was too small for it. */
  let lastFee = 0;
  let small = false;
  // Positions the latest ranking decision sells; its buys wait until these have filled.
  let waiting = new Set<A>();
  const trades: Trade[] = [];
  const equity: number[] = [];
  const exposure: number[] = [];
  const netExposure: number[] = [];
  const cashReturn: number[] = [];
  const fills: FillLog = { t: [], asset: [], kind: [], sharesAfter: [], price: [] };
  const logFill = (fill: FillSeen) => {
    fills.t.push(fill.t);
    fills.asset.push(fill.asset);
    fills.kind.push(fill.kind);
    fills.sharesAfter.push(fill.shares);
    fills.price.push(fill.price);
    p.onFill?.(fill);
  };

  /** Where fillOrders measures a block's room: equity at the fill, and the price each asset is marked at there. */
  let fillEquity = 0;
  let markOf = (a: A): number => a.lastClose;
  /**
   * What a buy or a short sale may use: the cash, or for a block that borrows its room, the gross value it may still add,
   * L·E − gross = cash − 2·S + (L − 1)·E, with S the value of its shorts and E the equity at the fill. With no shorts and
   * L = 1 that is the cash.
   */
  const funds = (): number => {
    if (!m) return cash;
    let shorts = 0;
    for (const a of assets) if (a.shares < 0) shorts -= a.shares * markOf(a);
    return cash - 2 * shorts + (m.cap - 1) * fillEquity;
  };
  /** Whether a block that borrows owes money or shares now. */
  const borrowing = (): boolean => cash < 0 || assets.some((a) => a.shares < 0);
  const commissionOf =(value: number, shares: number): number => commissionFee(charge!, value, shares);
  /**
   * The most a buy filled at `fill` can spend, with its costs and commission paid on top from the cash there is. Value
   * plus costs plus commission rises with the value, so the answer is the larger of the values at which the capped and
   * the uncapped commission use up the cash; the uncapped one is the smaller of the values at the minimum and per share.
   * For a block that borrows, the room (funds) takes the place of the cash, for buys and short sales alike.
   */
  const affordable = (fill: number): number => {
    const money = funds();
    if (!charge) return money / (1 + cost);
    if (charge.k === 'order') return (money - charge.fee) / (1 + cost);
    const uncapped = Math.min((money - charge.min) / (1 + cost), money / (1 + cost + charge.fee / fill));
    return charge.max === null ? uncapped : Math.max(money / (1 + cost + charge.max), uncapped);
  };
  /** Whether a commission would be too large a share of an add or a rebalancing trade worth `value` to make it. */
  const tooSmall = (value: number, shares: number) => charge !== null && commissionOf(value, shares) >= SMALL_TRADE * value;
  const sell = (a: A, shares: number, price: number) => {
    const value = shares * price * (1 - slip);
    const fee = value * cost;
    if (!charge) {
      cash += value - fee;
      costs += fee;
      a.fees += fee;
      a.cashOut += value - fee;
      a.shares -= shares;
      return;
    }
    // A sale pays its commission from what it brings in and the cash there is, and never takes cash below 0, unless the
    // block is borrowing already (cash below 0, or a short open): then it owes the whole commission.
    lastFee = m && borrowing() ? commissionOf(value, shares) : Math.min(commissionOf(value, shares), cash + value - fee);
    cash += value - fee - lastFee;
    costs += fee + lastFee;
    commission += lastFee;
    a.fees += fee + lastFee;
    a.comm += lastFee;
    a.cashOut += value - fee - lastFee;
    a.shares -= shares;
  };
  /** Buys up to `notional` with the cash there is; returns what it spent. An `adjust`ment too small for its commission is not made. */
  const buy = (a: A, notional: number, price: number, adjust = false): number => {
    if (!charge) {
      const spend = Math.min(notional, funds() / (1 + cost));
      if (spend <= 0) return 0;
      cash -= spend * (1 + cost);
      costs += spend * cost;
      a.fees += spend * cost;
      a.cashIn += spend * (1 + cost);
      a.shares += spend / (price * (1 + slip));
      return spend;
    }
    const fill = price * (1 + slip);
    const spend = Math.min(notional, affordable(fill));
    small = false;
    if (spend <= 0) return 0;
    lastFee = commissionOf(spend, spend / fill);
    small = adjust && lastFee >= SMALL_TRADE * spend;
    if (small) return 0;
    cash -= spend * (1 + cost) + lastFee;
    costs += spend * cost + lastFee;
    commission += lastFee;
    a.fees += spend * cost + lastFee;
    a.comm += lastFee;
    a.cashIn += spend * (1 + cost) + lastFee;
    a.shares += spend / fill;
    return spend;
  };
  /**
   * Sells short up to `notional` of proceeds (shares times the price less slippage) within the room there is; returns the
   * proceeds before costs. An `adjust`ment too small for its commission is not made.
   */
  const sellShort = (a: A, notional: number, price: number, adjust = false): number => {
    const fill = price * (1 - slip);
    const value = Math.min(notional, affordable(fill));
    small = false;
    if (value <= 0) return 0;
    lastFee = charge ? commissionOf(value, value / fill) : 0;
    small = adjust && charge !== null && lastFee >= SMALL_TRADE * value;
    if (small) return 0;
    const fee = value * cost;
    cash += value - fee - lastFee;
    costs += fee + lastFee;
    commission += lastFee;
    a.fees += fee + lastFee;
    a.comm += lastFee;
    a.cashOut += value - fee - lastFee;
    a.shares -= value / fill;
    return value;
  };
  /** Buys back `shares` of a short, paying its costs and commission whatever the cash. */
  const cover = (a: A, shares: number, price: number) => {
    const value = shares * price * (1 + slip);
    const fee = value * cost;
    lastFee = charge ? commissionOf(value, shares) : 0;
    cash -= value + fee + lastFee;
    costs += fee + lastFee;
    commission += lastFee;
    a.fees += fee + lastFee;
    a.comm += lastFee;
    a.cashIn += value + fee + lastFee;
    a.shares += shares;
  };
  const close = (a: A, t: number, price: number, reason: ExitReason, exit: ExitWhy | null) => {
    const short = a.shares < 0;
    const exitPrice = reason === 'open' ? price : price * (short ? 1 + slip : 1 - slip);
    const held = a.shares;
    if (reason !== 'open') {
      if (short) cover(a, -a.shares, price);
      else sell(a, a.shares, price);
      const kind = reason === 'signal' ? 'sell' : reason === 'margin call' || reason === 'ruin' ? 'margin' : 'stop';
      logFill({ t, asset: a.name, kind, price, shares: a.shares, cash, equity: NaN, weight: NaN });
    }
    a.owed = null;
    const why = a.why!;
    why.topUps = a.topUps;
    why.trims = a.trims;
    why.fees = a.fees;
    why.exit = exit;
    const n = Math.abs(held);
    // Each side's commission per share: the exit's (or what closing at the last close would pay), and the entries'.
    const exitFee = !charge ? 0 : reason === 'open' ? commissionOf(n * price, n) : lastFee;
    let ret = (exitPrice * (1 - cost)) / (a.entryPrice * (1 + cost)) - 1;
    if (charge && !short) ret = (exitPrice * (1 - cost) - exitFee / held) / (a.entryPrice * (1 + cost) + a.entryComm / a.entryShares) - 1;
    if (short) {
      const basis = a.entryPrice * (1 - cost) - (charge ? a.entryComm / a.entryShares : 0);
      ret = (basis - exitPrice * (1 + cost) - exitFee / n - a.borrowPS) / basis;
    }
    if (charge) why.commission = { paid: a.comm, entries: a.entryComm, exit: exitFee, exitShares: n };
    if (steps > 1) why.adds = a.addList;
    const trade: Trade = {
      asset: a.name,
      entryT: a.entryT,
      entryPrice: a.entryPrice,
      exitT: t,
      exitPrice,
      ret,
      reason,
      bars: a.i - a.entryIdx,
      pnl: a.cashOut - a.cashIn + (reason === 'open' ? a.shares * price : 0),
      why,
    };
    if (steps > 1) trade.entries = a.entryList;
    if (short) {
      trade.side = 'short';
      trade.borrow = a.borrow;
    }
    trades.push(trade);
  };
  type Size = Pick<TradeWhy, 'equity' | 'weight' | 'wanted' | 'cash' | 'spent' | 'shares'>;
  /** `price` is the open or close it filled at, before slippage; `known` the bar whose close the ATR is read at. */
  const openPosition = (a: A, t: number, price: number, known: number, size: Size) => {
    const short = a.shares < 0;
    const fill = price * (short ? 1 - slip : 1 + slip);
    // Side space: the levels and the high-water mark of a short are kept as minus its prices.
    const at = short ? -fill : fill;
    // Distances in ATR keep the value they were set with for the position's life (known: see missingInput).
    const dist = (s: StopLevel) => (s.k === 'atr' ? s.mult * atrAt(a, s.n, known) : NaN);
    const { stopLoss, trailingStop, takeProfit } = a.stops;
    a.entryT = t;
    a.entryIdx = a.i;
    a.entryPrice = fill;
    a.highWater = short ? -price : price;
    a.hard = !stopLoss ? -Infinity : stopLoss.k === 'pct' ? (short ? -fill * (1 + stopLoss.v) : fill * (1 - stopLoss.v)) : at - dist(stopLoss);
    a.target = !takeProfit ? Infinity : takeProfit.k === 'pct' ? (short ? -fill * (1 - takeProfit.v) : fill * (1 + takeProfit.v)) : at + dist(takeProfit);
    a.trail = !trailingStop ? null : trailingStop.k === 'pct' ? { mul: short ? 1 + trailingStop.v : 1 - trailingStop.v } : { dist: dist(trailingStop) };
    a.slDist = stopLoss?.k === 'atr' ? dist(stopLoss) : NaN;
    a.tpDist = takeProfit?.k === 'atr' ? dist(takeProfit) : NaN;
    a.made = 1;
    a.lastEntryPrice = fill;
    a.entryShares = size.shares;
    a.entryMoney = size.spent;
    a.entryComm = charge ? lastFee : 0;
    a.entryList = steps > 1 ? [{ t, price: fill, shares: size.shares, money: size.spent, signalT: a.buyWhy!.buyT }] : [];
    a.addList = [];
    a.why = {
      ...a.buyWhy!,
      waited: a.waited,
      inputT: a.bars.t[known],
      ...size,
      stopLoss: a.hard === -Infinity ? null : short ? -a.hard : a.hard,
      takeProfit: a.target === Infinity ? null : short ? -a.target : a.target,
      topUps: 0,
      trims: 0,
      fees: 0,
      exit: null,
    };
  };

  /**
   * Another entry of an open position: the average entry price moves, and the stop loss and take profit with it (an
   * ATR distance keeps the ATR of the first entry). The trailing level keeps trailing from the first entry on.
   */
  const addToPosition = (a: A, t: number, fill: number, shares: number, size: Omit<AddWhy, 'signalT' | 'average' | 'stopLoss' | 'takeProfit'>) => {
    const short = a.shares < 0;
    a.made++;
    a.entryMoney += size.spent;
    a.entryShares += shares;
    a.entryComm += lastFee;
    a.entryPrice = a.entryMoney / a.entryShares;
    a.lastEntryPrice = fill;
    const { stopLoss, takeProfit } = a.stops;
    if (short) {
      if (stopLoss) a.hard = stopLoss.k === 'pct' ? -a.entryPrice * (1 + stopLoss.v) : -a.entryPrice - a.slDist;
      if (takeProfit) a.target = takeProfit.k === 'pct' ? -a.entryPrice * (1 - takeProfit.v) : -a.entryPrice + a.tpDist;
    } else {
      if (stopLoss) a.hard = stopLoss.k === 'pct' ? a.entryPrice * (1 - stopLoss.v) : a.entryPrice - a.slDist;
      if (takeProfit) a.target = takeProfit.k === 'pct' ? a.entryPrice * (1 + takeProfit.v) : a.entryPrice + a.tpDist;
    }
    const why = a.why!;
    why.stopLoss = a.hard === -Infinity ? null : short ? -a.hard : a.hard;
    why.takeProfit = a.target === Infinity ? null : short ? -a.target : a.target;
    a.entryList.push({ t, price: fill, shares, money: size.spent, signalT: a.addT });
    a.addList.push({ signalT: a.addT, ...size, average: a.entryPrice, stopLoss: why.stopLoss, takeProfit: why.takeProfit });
  };

  /** The trailing level when the highest price since entry is `high`; -Infinity without a trailing stop. In side space for a short. */
  const trailFrom = (a: A, high: number) => (!a.trail ? -Infinity : 'mul' in a.trail ? high * a.trail.mul : high - a.trail.dist);
  /**
   * Checks a bar, or one of its smaller bars with `inside`, against the stops and the target, and closes the position when
   * the low reaches the stop or the high the target; true when it did. Otherwise the bar's high moves the trailing level
   * for the bars after it. For a short the prices come in side space, (-open, -low, -high), and go back out as prices.
   */
  const reach = (a: A, t: number, o: number, h: number, l: number, inside?: InsideWhy): boolean => {
    const short = a.shares < 0;
    const px = (x: number) => (short ? -x : x);
    const trail = trailFrom(a, a.highWater);
    const stop = Math.max(a.hard, trail);
    const how = inside ? { inside } : {};
    if (l <= stop && o < a.target) {
      const trailing = trail > a.hard;
      close(a, t, px(Math.min(o, stop)), trailing ? 'trailing stop' : 'stop loss', { k: 'level', level: px(stop), high: trailing ? px(a.highWater) : null, atOpen: o < stop, ...how });
    } else if (h >= a.target) {
      close(a, t, px(Math.max(o, a.target)), 'take profit', { k: 'level', level: px(a.target), high: null, atOpen: o > a.target, ...how });
    } else {
      a.highWater = Math.max(a.highWater, h);
      return false;
    }
    const arm = short ? a.arm.short : a.arm.long;
    arm.armed = false;
    arm.stoppedT = t;
    return true;
  };

  const missingInput = (a: A, idx: number) => missingInputAt(p.sizing, a.stops, (n) => atrAt(a, n, idx), (n) => volAt(a, n, idx));
  const skipped: Skipped[] = [];
  /** Whether a buy signalled at the asset's current bar can go ahead; counts it as skipped when it can't. */
  const ready = (a: A): boolean => {
    const missing = missingInput(a, a.i);
    if (missing && !a.heldBack) {
      const row = skipped.find((x) => x.asset === a.name && x.input === missing.input && x.n === missing.n);
      if (row) row.count++;
      else skipped.push({ asset: a.name, ...missing, count: 1 });
      a.heldFrom = a.bars.t[a.i];
    }
    a.warm = !missing && a.heldBack && a.heldInput ? { ...a.heldInput, fromT: a.heldFrom } : null;
    if (missing) a.heldInput = missing;
    a.heldBack = missing !== null;
    return !a.heldBack;
  };

  const configured = new Map(assets.map((a) => [a, a.weight]));
  /**
   * Target weights for the assets held or being bought. Inverse volatility shares out those
   * assets' configured weights by 1 / volatility, measured up to `idx(a)`; an asset whose volatility
   * is 0 (or, for a buy not yet signalled, unknown) keeps its configured weight. Read only: without
   * inverse volatility every call gives the same map.
   */
  const targetWeights = (entering: Set<A>, idx: (a: A) => number): Map<A, number> => {
    if (p.sizing.k !== 'invvol') return configured;
    const out = new Map(configured);
    const n = p.sizing.n;
    const known = assets
      .filter((a) => a.shares !== 0 || entering.has(a))
      .map((a) => ({ a, vol: volAt(a, n, idx(a)) }))
      .filter((x) => x.vol > 0);
    const total = known.reduce((s, x) => s + x.a.weight, 0);
    const inverse = known.reduce((s, x) => s + 1 / x.vol, 0);
    for (const x of known) out.set(x.a, (total * (1 / x.vol)) / inverse);
    return out;
  };
  /**
   * Risk sizing: the value that loses `risk` of equity if the price moves `mult` ATRs against the position, capped at the
   * weight. For a short, the value is what the sale brings in.
   */
  const riskNotional = (a: A, weight: number, equityNow: number, price: number, signalIdx: number, short = false): number => {
    if (p.sizing.k !== 'risk') return weight * equityNow;
    const atr = atrAt(a, p.sizing.n, signalIdx);
    if (!(atr > 0)) return weight * equityNow;
    const shares = (p.sizing.risk * equityNow) / (p.sizing.mult * atr);
    return Math.min(shares * price * (short ? 1 - slip : 1 + slip), weight * equityNow);
  };

  /**
   * Fills the orders due at this point of the bar: at its open, or at its close with fill: close.
   * Every reduction first (exits by the rules, the closing half of a flip, then rebalancing trims), then every increase
   * (entries, top-ups, owed amounts and adds). A ticker is rebalanced at its own bar, so one closed on the period's first
   * or last day still is.
   */
  const fillOrders = (t: number, live: A[], isLive: Set<A>) => {
    const priceOf = (a: A) => (atClose ? a.bars.c[a.i] : a.bars.o[a.i]);
    // The last close known at the fill: for an open, the one before it.
    const known = (a: A) => (isLive.has(a) && !atClose ? a.i - 1 : a.i);
    const mark = (a: A) => (a.shares === 0 ? 0 : a.shares * (isLive.has(a) ? priceOf(a) : a.lastClose));
    const equityNow = cash + assets.reduce((s, a) => s + mark(a), 0);
    fillEquity = equityNow;
    markOf = (a) => (isLive.has(a) ? priceOf(a) : a.lastClose);
    for (const a of live) {
      if (a.shares === 0) continue;
      const long = a.shares > 0;
      if (long ? a.pending !== 'sell' && a.pending !== 'short' : a.pending !== 'cover' && a.pending !== 'buy') continue;
      const shares = long ? a.shares : -a.shares;
      close(a, t, priceOf(a), 'signal', a.sellWhy);
      a.lastFill = { side: long ? 'sell' : 'cover', shares, price: priceOf(a) * (long ? 1 - slip : 1 + slip), t };
    }
    for (const a of waiting) if (a.shares === 0) waiting.delete(a);
    const entering = new Set(live.filter((a) => (a.pending === 'buy' || a.pending === 'short') && a.shares === 0 && waiting.size === 0));
    if (waiting.size > 0) for (const a of live) if (a.pending === 'buy' && a.shares === 0) a.waited = true;
    const weights = targetWeights(entering, known);
    type Buy = { a: A; notional: number; kind: 'entry' | 'rebalance' | 'owed' | 'add'; weight: number; full: number; held: number; short: boolean };
    const buys: Buy[] = [];
    for (const a of live) {
      const price = priceOf(a);
      const short = a.shares < 0 || (a.shares === 0 && a.pending === 'short');
      // A position built in steps is rebalanced to its entries' share of the weight.
      const part = steps > 1 ? a.made / steps : 1;
      /**
       * What the position is worth once this fill's rebalancing of it is done, which an add is sized against: the target
       * when a trim is made or a top-up is ordered, and what it is worth now when a trim is too small for its commission
       * or nothing is traded. A top-up that buys less than it wants is caught where it fills. A short's is its size.
       */
      let held = short ? -a.shares * price : a.shares * price;
      if (entering.has(a)) {
        const weight = weights.get(a)!;
        const full = riskNotional(a, weight, equityNow, price, known(a), short);
        buys.push({ a, notional: steps > 1 ? full / steps : full, kind: 'entry', weight, full, held: 0, short });
      } else if (a.shares !== 0 && rebalances(a)) {
        const target = (steps > 1 ? weights.get(a)! * part : weights.get(a)!) * equityNow;
        const delta = target - held;
        if (delta < 0) {
          if (tooSmall(-delta * (short ? 1 + slip : 1 - slip), -delta / price)) smallTrades++;
          else {
            if (short) cover(a, -delta / price, price);
            else sell(a, -delta / price, price);
            a.trims++;
            held = target;
            logFill({ t, asset: a.name, kind: 'trim', price, shares: a.shares, cash, equity: NaN, weight: NaN });
          }
        } else {
          buys.push({ a, notional: delta, kind: 'rebalance', weight: 0, full: 0, held: 0, short });
          held = target;
        }
      } else if (a.shares !== 0 && a.owed === keys[a.order][a.i]) {
        // The rest of this period's top-up; a debt from an earlier period has lapsed.
        const target = (steps > 1 ? weights.get(a)! * part : weights.get(a)!) * equityNow;
        const delta = target - held;
        if (delta > 0) {
          buys.push({ a, notional: delta, kind: 'owed', weight: 0, full: 0, held: 0, short });
          held = target;
        } else a.owed = null;
      }
      if (a.pending === 'add' && a.shares !== 0 && a.made < steps) {
        // One more step of a whole position, cut so the position stays within it.
        const weight = weights.get(a)!;
        const full = riskNotional(a, weight, equityNow, price, known(a), short);
        const notional = Math.min(full / steps, full - held);
        if (notional > 0) buys.push({ a, notional, kind: 'add', weight, full, held, short });
      }
      // A ranking buy stays wanted until it fills or the next decision replaces it.
      if (!(p.rank && a.pending === 'buy')) a.pending = null;
    }
    if (p.rank) buys.sort((x, y) => x.a.rankPos - y.a.rankPos || x.a.order - y.a.order);
    // Positions whose top-up at this fill bought less than it wanted; an add after it is sized from what they are worth.
    const fellShort = new Set<A>();
    for (let { a, notional, kind, weight, full, held, short } of buys) {
      if (kind === 'add' && fellShort.has(a)) {
        held = Math.abs(a.shares) * priceOf(a);
        notional = Math.min(full / steps, full - held);
      }
      const entry = kind === 'entry';
      if (entry) {
        a.cashIn = 0;
        a.cashOut = 0;
        a.fees = 0;
        a.topUps = 0;
        a.trims = 0;
        a.comm = 0;
        a.borrow = 0;
        a.borrowPS = 0;
      }
      const before = cash;
      const fill = priceOf(a) * (short ? 1 - slip : 1 + slip);
      const starved = charge !== null && affordable(fill) < notional;
      const spent = short ? sellShort(a, notional, priceOf(a), !entry) : buy(a, notional, priceOf(a), !entry);
      if (spent > 0) logFill({ t, asset: a.name, kind, price: priceOf(a), shares: a.shares, cash, equity: equityNow, weight: weights.get(a)! });
      if (small && (kind === 'add' || kind === 'rebalance')) smallTrades++;
      if (kind === 'rebalance' || kind === 'owed') {
        // The debt is for the period the rebalance opens: this one at an open, the next one at a close. A top-up left
        // undone because it was too small for its commission is owed nothing; one short of cash is.
        const owes = notional - spent > 1e-9 * notional && (!charge || spent > 0 || starved);
        a.owed = owes ? keys[a.order][a.i] + (atClose ? 1 : 0) : null;
        if (spent > 0) a.topUps++;
        if (spent < notional) fellShort.add(a);
      }
      if (entry && a.shares !== 0) {
        const shares = Math.abs(a.shares);
        openPosition(a, t, priceOf(a), known(a), { equity: equityNow, weight, wanted: notional, cash: before, spent, shares });
        // A flip: the position this fill closed, on the other side.
        const flipped = a.lastFill !== null && a.lastFill.t === t && (a.lastFill.side === 'sell' || a.lastFill.side === 'cover') ? a.lastFill.shares : 0;
        a.lastFill = { side: short ? 'short' : 'buy', shares, price: a.entryPrice, t, ...(flipped ? { closed: flipped } : {}) };
        a.pending = null;
      }
      if (kind === 'add' && spent > 0) {
        const shares = spent / fill;
        addToPosition(a, t, fill, shares, { inputT: a.bars.t[known(a)], equity: equityNow, weight, full, held, wanted: notional, cash: before, spent, shares });
        a.lastFill = { side: 'add', shares, price: fill, t };
      }
    }
  };

  /** The open position as the rules of `side` (1 long, -1 short) read it; null when that side is not held. */
  const position = (a: A, side: 1 | -1 = 1): PosState | null =>
    (side > 0 ? a.shares > 0 : a.shares < 0) ? { entryIdx: a.entryIdx, entryPrice: a.entryPrice, lastPrice: a.lastEntryPrice, entries: a.made } : null;

  /**
   * A block that borrows, over `span` ms: the balance B = cash − short value at the last closes earns the cash rate `r`
   * when above 0 and pays the margin rate when below, and each short pays its borrow fee. Short-sale proceeds earn
   * nothing of their own.
   */
  const accrue = (margin: Margin, span: number, r: number) => {
    let shorts = 0;
    for (const a of assets) if (a.shares < 0) shorts -= a.shares * a.lastClose;
    const balance = cash - shorts;
    if (balance > 0) {
      interest += balance * r;
      cash += balance * r;
    } else if (balance < 0) {
      const owed = (-balance * margin.rate * span) / DAY / 365;
      marginInterest += owed;
      cash -= owed;
    }
    for (const a of assets) {
      if (a.shares >= 0) continue;
      const perShare = (a.lastClose * margin.borrowFee * span) / DAY / 365;
      const fee = -a.shares * perShare;
      borrowFees += fee;
      cash -= fee;
      a.cashIn += fee;
      a.borrow += fee;
      a.borrowPS += perShare;
    }
  };
  /** Equity with each position marked at `at`. */
  const worth = (at: (a: A) => number): number => {
    let total = cash;
    for (const a of assets) if (a.shares !== 0) total += a.shares * at(a);
    return total;
  };
  /** Equity at `level` ruins the run: below 0, or at 0 with a position still open. Flat at exactly 0 owes nothing. */
  const ruined = (level: number): boolean => level < 0 || (level <= 0 && assets.some((a) => a.shares !== 0));
  /** Equity reached `level` (0 or below) at `t`: everything closes at `at`, and the run is over. */
  const ruinAt = (t: number, at: (a: A) => number, level: number) => {
    const why: ExitWhy = { k: 'ruin', t, equity: level };
    for (const a of assets) if (a.shares !== 0) close(a, t, at(a), 'ruin', why);
    ruin = { t, deficit: Math.max(0, -cash) };
    for (const a of assets) {
      a.pending = null;
      a.called = false;
    }
    call = null;
    waiting = new Set();
  };
  const lastT = timeline[timeline.length - 1];
  /** A ticker whose prices end before the run does: there is no open left to close a position in it at. */
  const ended = (a: A) => a.i >= 0 && a.bars.t[a.i] < lastT && !(a.i + 1 < a.bars.t.length && a.bars.t[a.i + 1] <= lastT);
  /**
   * A margin call at the close `t`: every position closes at its next open, pending orders are cancelled and every side
   * must re-arm. Positions in tickers whose prices have ended can't be closed; when they are all that is held, a call
   * would do nothing, so none is made.
   */
  const marginCall = (t: number, level: number, gross: number) => {
    if (!assets.some((a) => a.shares !== 0 && !ended(a))) return;
    marginCalls++;
    call = { k: 'margin', t, equity: level, gross };
    for (const a of assets) {
      a.pending = null;
      a.owed = null;
      a.called = a.shares !== 0 && !ended(a);
      for (const side of [a.arm.long, a.arm.short]) {
        side.armed = false;
        side.stoppedT = t;
        side.blockedT = null;
      }
    }
    waiting = new Set();
  };

  /** Re-arms a side that is not held once its entry rule does not hold at a close; while it still holds, notes the bar. */
  const rearm = (a: A, arm: A['arm']['long'], wants: boolean) => {
    if (wants) {
      if (!arm.armed) arm.blockedT = a.bars.t[a.i];
      return;
    }
    if (!arm.armed && arm.blockedT !== null) arm.cleared = { exitT: arm.stoppedT, heldT: arm.blockedT, clearedT: a.bars.t[a.i], idx: a.i };
    arm.armed = true;
    arm.blockedT = null;
  };
  /** Orders the entry of `side` at the asset's current bar, when that side is armed and the inputs it needs are known. */
  const enter = (a: A, side: 'buy' | 'short') => {
    const arm = side === 'buy' ? a.arm.long : a.arm.short;
    if (!arm.armed || !ready(a)) return;
    a.pending = side;
    const c = arm.cleared;
    a.buyWhy = { buyT: a.bars.t[a.i], rank: null, warmup: a.warm, rearm: c && c.idx === a.i - 1 ? { exitT: c.exitT, heldT: c.heldT, clearedT: c.clearedT } : null };
  };
  /** Each side's entry as the asset's current bar reads it when flat: its rule holds and its exit rule does not. */
  const entryHolds = (a: A) => ({
    long: a.sig.buy[a.i] === 1 && !(a.sig.sell !== null && a.sig.sell(a.i, null) === 1),
    short: a.sig.short?.[a.i] === 1 && !(!!a.sig.cover && a.sig.cover(a.i, null) === 1),
  });
  /** After an exit ordered at this close, the bar read as if flat: the other side opens at the same fill when its entry holds alone. */
  const flipTo = (a: A, side: 'buy' | 'short') => {
    if (!a.sig.short) return;
    const e = entryHolds(a);
    if (e.long && e.short) conflicts++;
    else if (side === 'buy' ? e.long : e.short) enter(a, side);
  };

  for (let k = 0; k < timeline.length; k++) {
    const t = timeline[k];
    if (k > 0) {
      const prev = timeline[k - 1];
      const r = (rateAt(k - 1) * (t - prev)) / DAY / 365;
      cashReturn.push(r);
      if (!m) {
        if (cash > 0) {
          interest += cash * r;
          cash += cash * r;
        }
      } else if (!ruin) accrue(m, t - prev, r);
    } else {
      cashReturn.push(0);
    }

    const live: A[] = [];
    for (const a of assets) {
      if (a.i + 1 < a.bars.t.length && a.bars.t[a.i + 1] === t) {
        a.i++;
        live.push(a);
      }
    }
    const isLive = new Set(live);

    if (!ruin) step(k, t, live, isLive);
    for (const a of live) a.lastClose = a.bars.c[a.i];

    if (!m) {
      let invested = 0;
      for (const a of assets) if (a.shares > 0) invested += a.shares * a.lastClose;
      const total = cash + invested;
      equity.push(total);
      exposure.push(total > 0 ? invested / total : 0);
    } else {
      let invested = 0;
      let gross = 0;
      for (const a of assets) {
        if (a.shares === 0) continue;
        invested += a.shares * a.lastClose;
        gross += Math.abs(a.shares) * a.lastClose;
      }
      let total = cash + invested;
      if (!ruin && ruined(total)) ruinAt(t, (a) => a.lastClose, total);
      if (ruin) {
        total = gross = invested = 0;
      } else if (!call && gross > 0 && total < m.maintenance * gross) marginCall(t, total, gross);
      equity.push(total);
      exposure.push(total > 0 ? gross / total : 0);
      netExposure.push(total > 0 ? invested / total : 0);
    }
    if (p.onClose && !ruin) p.onClose({ t, cash, shares: assets.map((a) => a.shares), closes: assets.map((a) => a.lastClose), equity: equity[k] });
  }

  /** One bar of the timeline, up to its close's fills: stops reached while it ruins the run leave the rest undone. */
  function step(k: number, t: number, live: A[], isLive: Set<A>): void {
    if (m) {
      // At the open, before anything else: ruin, then the margin call made at the last close.
      const at = (a: A) => (isLive.has(a) ? a.bars.o[a.i] : a.lastClose);
      const level = worth(at);
      if (ruined(level)) return ruinAt(t, at, level);
      if (call) {
        for (const a of live) {
          if (!a.called) continue;
          a.called = false;
          close(a, t, a.bars.o[a.i], 'margin call', call);
        }
        if (!assets.some((a) => a.called)) call = null;
      }
    }

    if (!atClose) fillOrders(t, live, isLive);

    // Inside the bar: the open comes first, so a gap through the stop or the target fills there;
    // when stop and target both lie inside the bar, the stop is taken first. With magnify, a bar that opens between the
    // levels and holds one in its range is followed through its smaller bars instead, each read the same way. A short's
    // bar is read in side space, (-open, -low, -high).
    for (const a of live) {
      if (a.shares === 0) continue;
      const short = a.shares < 0;
      const { o, h, l } = short ? { o: -a.bars.o[a.i], h: -a.bars.l[a.i], l: -a.bars.h[a.i] } : { o: a.bars.o[a.i], h: a.bars.h[a.i], l: a.bars.l[a.i] };
      const ins = a.inside;
      if (ins && o > Math.max(a.hard, trailFrom(a, a.highWater)) && o < a.target && h > l && (h >= a.target || l <= Math.max(a.hard, trailFrom(a, Math.max(a.highWater, h))))) {
        const seen = lookInside(a.bars.o[a.i], a.bars.h[a.i], a.bars.l[a.i], a.bars.c[a.i], ins.bars, ins.from[a.i], ins.to[a.i], ins.count);
        if (seen.ok) {
          ins.looked++;
          const path = seen.path;
          for (let j = 0; j < path.t.length; j++) {
            const hit = short ? reach(a, t, -path.o[j], -path.l[j], -path.h[j], { k: 'inside', t: path.t[j] }) : reach(a, t, path.o[j], path.h[j], path.l[j], { k: 'inside', t: path.t[j] });
            if (hit) break;
          }
          continue;
        }
        if (ins.first >= 0 && a.i >= ins.first) ins.whole++;
        reach(a, t, o, h, l, { k: 'whole', why: seen.why });
        continue;
      }
      reach(a, t, o, h, l);
    }

    // Close: read the rules, then (with fill: close) fill what they decided, then mark the book.
    for (const a of live) a.lastClose = a.bars.c[a.i];
    if (m) {
      const level = worth((a) => a.lastClose);
      if (ruined(level)) return ruinAt(t, (a) => a.lastClose, level);
    }
    const sells = (a: A) => a.sig.sell !== null && a.sig.sell(a.i, position(a)) === 1;
    const covers = (a: A) => !!a.sig.cover && a.sig.cover(a.i, position(a, -1)) === 1;
    const adds = (a: A) => a.made < steps && !!a.sig.add && a.sig.add(a.i, position(a, a.shares < 0 ? -1 : 1)) === 1;
    // A buy whose sizing or stop input is still warming up waits for a later signal.
    for (const a of live) {
      if (a.shares > 0) {
        if (a.sig.short) rearm(a, a.arm.short, a.sig.short[a.i] === 1);
        if (sells(a)) {
          a.pending = 'sell';
          a.sellWhy = { k: 'rule', t: a.bars.t[a.i] };
          flipTo(a, 'short');
        } else if (a.sig.short?.[a.i] === 1) {
          a.pending = 'sell';
          a.sellWhy = { k: 'rule', t: a.bars.t[a.i], flip: true };
          flipTo(a, 'short');
        } else if (adds(a)) {
          a.pending = 'add';
          a.addT = a.bars.t[a.i];
        }
      } else if (a.shares < 0) {
        rearm(a, a.arm.long, a.sig.buy[a.i] === 1);
        if (covers(a)) {
          a.pending = 'cover';
          a.sellWhy = { k: 'rule', t: a.bars.t[a.i] };
          flipTo(a, 'buy');
        } else if (a.sig.buy[a.i] === 1) {
          a.pending = 'cover';
          a.sellWhy = { k: 'rule', t: a.bars.t[a.i], flip: true };
          flipTo(a, 'buy');
        } else if (adds(a)) {
          a.pending = 'add';
          a.addT = a.bars.t[a.i];
        }
      } else if (!p.rank) {
        const wantsBuy = a.sig.buy[a.i] === 1;
        const wantsShort = a.sig.short?.[a.i] === 1;
        rearm(a, a.arm.long, wantsBuy);
        if (a.sig.short) rearm(a, a.arm.short, wantsShort);
        const longEntry = wantsBuy && !sells(a);
        const shortEntry = wantsShort && !(!!a.sig.cover && a.sig.cover(a.i, null) === 1);
        if (longEntry && shortEntry) conflicts++;
        if (longEntry && !shortEntry && a.arm.long.armed) enter(a, 'buy');
        else if (shortEntry && !longEntry && a.arm.short.armed) enter(a, 'short');
        else a.heldBack = false;
      }
    }

    // Ranking: on a decision bar hold the top scores among the eligible; in between, sell rules
    // and stops can still exit, and a freed slot waits for the next decision.
    if (p.rank && decisions![k] === 1) {
      const lag = mixed && new Set(live.map((a) => clocks![a.order])).size > 1;
      /** The bar of each ticker this decision reads. */
      const at = assets.map((a) => (!mixed || (isLive.has(a) && !lag) ? a.i : endedAt![a.order][k]));
      const read = (a: A) => at[a.order];
      const readT = (a: A) => (read(a) < 0 ? NaN : a.bars.t[read(a)]);
      const score = (a: A) => (read(a) < 0 ? NaN : a.sig.score![read(a)]);
      const sellsAt = (a: A, j: number) => a.sig.sell !== null && a.sig.sell(j, position(a)) === 1;
      const eligible = assets.filter((a) => read(a) >= 0 && a.sig.buy[read(a)] === 1 && !sellsAt(a, read(a)) && Number.isFinite(score(a)));
      eligible.sort((x, y) => score(y) - score(x) || x.order - y.order);
      const chosen = new Set(eligible.slice(0, p.rank.top));
      const keeps = (a: A) => chosen.has(a) && !(read(a) !== a.i && isLive.has(a) && sells(a));
      for (const a of assets) a.rankPos = Infinity;
      eligible.forEach((a, n) => (a.rankPos = n));
      // A sell that can never fill (the ticker has no later bar in the run) is not waited for.
      const fills = (a: A) => (atClose && isLive.has(a)) || (a.i + 1 < a.bars.t.length && a.bars.t[a.i + 1] <= end);
      let decision: RankDecision | null = null;
      const placeOf = (a: A): RankPlace => {
        decision ??= {
          t,
          top: p.rank!.top,
          eligible: eligible.length,
          sold: [],
          table:
            assets.length > TABLE_MAX
              ? null
              : [...eligible, ...assets.filter((x) => !Number.isFinite(x.rankPos))].map((x) => ({ asset: x.name, score: score(x), eligible: Number.isFinite(x.rankPos), t: readT(x) })),
        };
        return { decision, place: Number.isFinite(a.rankPos) ? a.rankPos : -1, score: score(a), t: readT(a) };
      };
      waiting = new Set();
      for (const a of assets) {
        if (keeps(a)) {
          // A ticker kept is not added to by the decision; an add its own rule ordered at this close stands.
          a.pending = a.shares === 0 ? (ready(a) ? 'buy' : null) : a.pending === 'add' ? 'add' : null;
          if (a.pending === 'buy') {
            a.buyWhy = { buyT: readT(a), rank: placeOf(a), warmup: a.warm, rearm: null };
            a.waited = false;
          }
        } else if (a.shares > 0) {
          a.pending = 'sell';
          const rank = placeOf(a);
          a.sellWhy = sells(a) ? { k: 'rule', t: a.bars.t[a.i] } : { k: 'rank', t: readT(a), rank };
          if (fills(a)) {
            waiting.add(a);
            rank.decision.sold.push(a.name);
          }
        } else {
          a.pending = null;
        }
        if (!keeps(a) || a.shares > 0) a.heldBack = false;
      }
    }

    if (atClose) fillOrders(t, live, isLive);
  }

  const last = timeline[timeline.length - 1];
  for (const a of assets) if (a.shares !== 0) close(a, last, a.lastClose, 'open', null);
  trades.sort((x, y) => x.entryT - y.entryT);

  const equityNow = equity[equity.length - 1];
  const finalWeights = targetWeights(new Set(assets.filter((a) => (a.pending === 'buy' || a.pending === 'short') && a.shares === 0)), (a) => a.i);
  return {
    t: timeline,
    equity,
    exposure,
    trades,
    states: assets.map((a) => {
      const short = a.shares < 0;
      const goingShort = a.pending === 'short' || (short && a.pending !== 'buy');
      const st: AssetState = {
        name: a.name,
        weight: a.weight,
        side: a.shares > 0 ? 'long' : short ? 'short' : null,
        since: a.shares !== 0 ? a.entryT : null,
        pending: a.pending,
        shares: a.shares,
        lastClose: a.lastClose,
        value: a.shares * a.lastClose,
        targetWeight: equityNow > 0 ? riskNotional(a, finalWeights.get(a)!, equityNow, a.lastClose, a.i, goingShort) / equityNow : finalWeights.get(a)!,
      };
      if (steps > 1) {
        // The next entry: a step of a whole position, cut for an add so the position stays within it. An add with no room
        // left at the last close is not reported, as the next open would not make it unless the price fell. One that only
        // the cash stands in the way of is, as a buy is: the sales and trims at that open are paid out first.
        const full = st.targetWeight;
        if (a.pending === 'buy' || a.pending === 'short') st.targetWeight = full / steps;
        if (a.pending === 'add') {
          const room = Math.min(full / steps, full - (equityNow > 0 ? Math.abs(st.value) / equityNow : 0));
          if (room > 0) st.targetWeight = room;
          else st.pending = null;
        }
        st.entries = a.shares !== 0 ? a.made : 0;
      }
      if (atClose) {
        const f = a.lastFill;
        st.filled = f && f.t === a.bars.t[a.i] ? { side: f.side, shares: f.shares, price: f.price, ...(f.closed ? { closed: f.closed } : {}) } : null;
      }
      if (a.shares !== 0) {
        st.pos = position(a, short ? -1 : 1)!;
        const px = (x: number) => (short ? -x : x);
        const stop = Math.max(a.hard, trailFrom(a, a.highWater));
        if (stop > -Infinity || a.target < Infinity) st.levels = { stop: stop > -Infinity ? px(stop) : null, target: a.target < Infinity ? px(a.target) : null };
      }
      if (!p.rank && !a.arm.long.armed && a.shares <= 0) st.rearming = true;
      if (!p.rank && a.sig.short && !a.arm.short.armed && a.shares >= 0) st.rearmingShort = true;
      if (a.called) {
        st.pending = short ? 'cover' : 'sell';
        st.marginCall = true;
      }
      return st;
    }),
    costs,
    interest,
    cashReturn,
    skipped,
    fills,
    ...(charge ? { commission, smallTrades } : {}),
    ...(p.magnify
      ? { inside: assets.flatMap((a) => (a.inside ? [{ asset: a.name, from: a.inside.first < 0 ? null : a.bars.t[a.inside.first], looked: a.inside.looked, whole: a.inside.whole }] : [])) }
      : {}),
    ...(m ? { netExposure, borrowFees, marginInterest, marginCalls, conflicts, ruin } : {}),
  };
}
