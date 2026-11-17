import type { CashRate, Fill, Rebalance, Sizing, StopLevel, Stops } from './dsl.ts';
import type { BarRule, PosState } from './evaluate.ts';
import * as ind from './indicators.ts';
import type { Asset, Bars } from './types.ts';

export type ExitReason = 'signal' | 'stop loss' | 'trailing stop' | 'take profit' | 'open';

export interface Trade {
  asset: string;
  entryT: number;
  /** Fill prices, slippage included. */
  entryPrice: number;
  exitT: number;
  exitPrice: number;
  /** Price return after costs on both sides. */
  ret: number;
  reason: ExitReason;
  /** Bars from the entry fill to the exit fill, counted in the asset's own bars; to the last bar while still open. */
  bars: number;
  /** Cash profit after costs and slippage, rebalancing trades included; an open position is marked at the last close. */
  pnl: number;
  /** What the engine knew when it bought and sold, recorded as it decided (see explain.ts). */
  why?: TradeWhy;
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
  /** The sell rule held at the close of the ticker's bar `t`. */
  | { k: 'rule'; t: number }
  /** A ranking decision, which read the ticker's bar `t`, did not keep it. */
  | { k: 'rank'; t: number; rank: RankPlace }
  /** A stop or the target: the level the bar reached, the highest price a trailing stop trailed from, and whether the bar opened beyond the level, so the fill was at the open. */
  | { k: 'level'; level: number; high: number | null; atOpen: boolean };

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
  /** Levels set at the fill; null when there is none. */
  stopLoss: number | null;
  takeProfit: number | null;
  /** Rebalancing trades during the position's life. */
  topUps: number;
  trims: number;
  /** Costs paid on the position's fills: the buy, rebalancing, and the sell once it is sold. */
  fees: number;
  /** Null while the position is still held. */
  exit: ExitWhy | null;
}

export interface AssetState {
  name: string;
  /** The configured weight. */
  weight: number;
  long: boolean;
  since: number | null;
  /** An order from the last bar's signal that would fill at the next open (or, with `fill: close`, one a ranking decision made while the ticker had no bar, for its next close). */
  pending: 'buy' | 'sell' | null;
  shares: number;
  lastClose: number;
  /** Shares at the last close. */
  value: number;
  /** The weight a buy at the next open would use, estimated from the last close. */
  targetWeight: number;
  /**
   * Only with `fill: close`: a position the rules or a ranking decision opened or sold whole at the
   * close of the ticker's last bar, at that close; null when nothing did. Rebalancing trims and
   * top-ups and stop exits are not counted. Price with slippage.
   */
  filled?: { side: 'buy' | 'sell'; shares: number; price: number } | null;
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
}

/** Per asset, aligned with its bars. */
export interface Signals {
  /** 1 where the buy rule holds. */
  buy: number[];
  /** The sell rule; null when there is none. */
  sell: BarRule | null;
  /** The ranking score; null outside rank mode. */
  score: number[] | null;
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
  /** Fraction of equity invested at each close. */
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
}

const DAY = 86_400_000;
const NO_STOPS: Stops = { stopLoss: null, trailingStop: null, takeProfit: null };
/** A ranking decision keeps its whole table for the explanations only up to this many tickers. */
const TABLE_MAX = 12;

function periodKey(t: number, mode: Rebalance): number {
  const d = new Date(t);
  switch (mode) {
    case 'weekly':
      // Epoch day 0 was a Thursday; shifting by 3 starts weeks on Monday.
      return Math.floor((Math.floor(t / DAY) + 3) / 7);
    case 'monthly':
      return d.getUTCFullYear() * 12 + d.getUTCMonth();
    case 'quarterly':
      return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3);
    case 'yearly':
      return d.getUTCFullYear();
    case 'never':
      return 0;
  }
}

/**
 * Long/flat portfolio simulation. Each asset is either at its target weight or in cash.
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
 */
export function simulate(p: SimParams, data: Map<string, Bars>, signals: Map<string, Signals>): RunResult {
  const atClose = p.fill === 'close';
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
      // After a stop or target exit, the buy rule must stop holding before it can fire again.
      armed: true,
      pending: null as 'buy' | 'sell' | null,
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
      stoppedT: 0,
      blockedT: null as number | null,
      cleared: null as { exitT: number; heldT: number; clearedT: number; idx: number } | null,
      lastFill: null as { side: 'buy' | 'sell'; shares: number; price: number; t: number } | null,
    };
  });
  type A = (typeof assets)[number];

  // Start once every asset has data, so the weights mean the same thing throughout.
  const start = Math.max(p.from ?? -Infinity, ...assets.map((a) => a.bars.t[0]));
  const end = p.to ?? Infinity;
  const times = new Set<number>();
  for (const a of assets) for (const t of a.bars.t) if (t >= start && t <= end) times.add(t);
  const timeline = [...times].sort((x, y) => x - y);
  if (timeline.length < 2) throw new Error('No bars in the chosen date range');

  for (const a of assets) {
    while (a.i + 1 < a.bars.t.length && a.bars.t[a.i + 1] < start) a.i++;
    if (a.i >= 0) a.lastClose = a.bars.c[a.i];
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
  // The yield quoted at the close of the timeline's bar k: that of the rate's latest bar ended by then.
  const rateIdx = rateBars ? ind.alignByEnd(rateBars.t, timeline) : null;
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
  /** Whether the asset's current bar is the one its rebalance fills at: its first bar of a period (at the open), or its last (at the close). */
  const rebalances = (a: A) =>
    atClose
      ? p.rebalance !== 'never' && cached(`end ${a.name}`, () => ind.periodEnds(a.bars.t, (x) => periodKey(x, p.rebalance)))[a.i] === 1
      : a.i > 0 && periodKey(a.bars.t[a.i], p.rebalance) !== periodKey(a.bars.t[a.i - 1], p.rebalance);

  const cost = p.costBps / 10_000;
  const slip = p.slippageBps / 10_000;
  let cash = p.capital;
  let costs = 0;
  let interest = 0;
  // Positions the latest ranking decision sells; its buys wait until these have filled.
  let waiting = new Set<A>();
  const trades: Trade[] = [];
  const equity: number[] = [];
  const exposure: number[] = [];
  const cashReturn: number[] = [];

  const sell = (a: A, shares: number, price: number) => {
    const value = shares * price * (1 - slip);
    const fee = value * cost;
    cash += value - fee;
    costs += fee;
    a.fees += fee;
    a.cashOut += value - fee;
    a.shares -= shares;
  };
  /** Buys up to `notional` with the cash there is; returns what it spent. */
  const buy = (a: A, notional: number, price: number): number => {
    const spend = Math.min(notional, cash / (1 + cost));
    if (spend <= 0) return 0;
    cash -= spend * (1 + cost);
    costs += spend * cost;
    a.fees += spend * cost;
    a.cashIn += spend * (1 + cost);
    a.shares += spend / (price * (1 + slip));
    return spend;
  };
  const close = (a: A, t: number, price: number, reason: ExitReason, exit: ExitWhy | null) => {
    const exitPrice = reason === 'open' ? price : price * (1 - slip);
    if (reason !== 'open') sell(a, a.shares, price);
    a.owed = null;
    const why = a.why!;
    why.topUps = a.topUps;
    why.trims = a.trims;
    why.fees = a.fees;
    why.exit = exit;
    trades.push({
      asset: a.name,
      entryT: a.entryT,
      entryPrice: a.entryPrice,
      exitT: t,
      exitPrice,
      ret: (exitPrice * (1 - cost)) / (a.entryPrice * (1 + cost)) - 1,
      reason,
      bars: a.i - a.entryIdx,
      pnl: a.cashOut - a.cashIn + (reason === 'open' ? a.shares * price : 0),
      why,
    });
  };
  type Size = Pick<TradeWhy, 'equity' | 'weight' | 'wanted' | 'cash' | 'spent' | 'shares'>;
  /** `price` is the open or close it filled at, before slippage; `known` the bar whose close the ATR is read at. */
  const openPosition = (a: A, t: number, price: number, known: number, size: Size) => {
    const fill = price * (1 + slip);
    // Distances in ATR keep the value they were set with for the position's life (known: see missingInput).
    const dist = (s: StopLevel) => (s.k === 'atr' ? s.mult * atrAt(a, s.n, known) : NaN);
    const { stopLoss, trailingStop, takeProfit } = a.stops;
    a.entryT = t;
    a.entryIdx = a.i;
    a.entryPrice = fill;
    a.highWater = price;
    a.hard = !stopLoss ? -Infinity : stopLoss.k === 'pct' ? fill * (1 - stopLoss.v) : fill - dist(stopLoss);
    a.target = !takeProfit ? Infinity : takeProfit.k === 'pct' ? fill * (1 + takeProfit.v) : fill + dist(takeProfit);
    a.trail = !trailingStop ? null : trailingStop.k === 'pct' ? { mul: 1 - trailingStop.v } : { dist: dist(trailingStop) };
    a.why = {
      ...a.buyWhy!,
      waited: a.waited,
      inputT: a.bars.t[known],
      ...size,
      stopLoss: a.hard === -Infinity ? null : a.hard,
      takeProfit: a.target === Infinity ? null : a.target,
      topUps: 0,
      trims: 0,
      fees: 0,
      exit: null,
    };
  };

  /** The first input a buy signalled at bar `idx` needs that is still unknown there, with its period; null when all are known. */
  const missingInput = (a: A, idx: number): { input: WarmupInput; n: number } | null => {
    if (p.sizing.k === 'risk' && Number.isNaN(atrAt(a, p.sizing.n, idx))) return { input: 'risk per trade', n: p.sizing.n };
    if (p.sizing.k === 'invvol' && Number.isNaN(volAt(a, p.sizing.n, idx))) return { input: 'inverse volatility', n: p.sizing.n };
    for (const [input, level] of [['stop loss', a.stops.stopLoss], ['trailing stop', a.stops.trailingStop], ['take profit', a.stops.takeProfit]] as const) {
      if (level?.k === 'atr' && Number.isNaN(atrAt(a, level.n, idx))) return { input, n: level.n };
    }
    return null;
  };
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

  /**
   * Target weights for the assets held or being bought. Inverse volatility shares out those
   * assets' configured weights by 1 / volatility, measured up to `idx(a)`; an asset whose volatility
   * is 0 (or, for a buy not yet signalled, unknown) keeps its configured weight.
   */
  const targetWeights = (entering: Set<A>, idx: (a: A) => number): Map<A, number> => {
    const out = new Map(assets.map((a) => [a, a.weight]));
    if (p.sizing.k !== 'invvol') return out;
    const n = p.sizing.n;
    const known = assets
      .filter((a) => a.shares > 0 || entering.has(a))
      .map((a) => ({ a, vol: volAt(a, n, idx(a)) }))
      .filter((x) => x.vol > 0);
    const total = known.reduce((s, x) => s + x.a.weight, 0);
    const inverse = known.reduce((s, x) => s + 1 / x.vol, 0);
    for (const x of known) out.set(x.a, (total * (1 / x.vol)) / inverse);
    return out;
  };
  /** Risk sizing: the value that loses `risk` of equity if the price falls `mult` ATRs, capped at the weight. */
  const riskNotional = (a: A, weight: number, equityNow: number, price: number, signalIdx: number): number => {
    if (p.sizing.k !== 'risk') return weight * equityNow;
    const atr = atrAt(a, p.sizing.n, signalIdx);
    if (!(atr > 0)) return weight * equityNow;
    const shares = (p.sizing.risk * equityNow) / (p.sizing.mult * atr);
    return Math.min(shares * price * (1 + slip), weight * equityNow);
  };

  /**
   * Fills the orders due at this point of the bar: at its open, or at its close with fill: close.
   * Sells first, then the rebalance (with any top-up still owed) and the buys. A ticker is
   * rebalanced at its own bar, so one closed on the period's first or last day still is.
   */
  const fillOrders = (t: number, live: A[], isLive: Set<A>) => {
    const priceOf = (a: A) => (atClose ? a.bars.c[a.i] : a.bars.o[a.i]);
    // The last close known at the fill: for an open, the one before it.
    const known = (a: A) => (isLive.has(a) && !atClose ? a.i - 1 : a.i);
    const mark = (a: A) => (a.shares === 0 ? 0 : a.shares * (isLive.has(a) ? priceOf(a) : a.lastClose));
    const equityNow = cash + assets.reduce((s, a) => s + mark(a), 0);
    for (const a of live) {
      if (a.pending !== 'sell' || a.shares === 0) continue;
      const shares = a.shares;
      close(a, t, priceOf(a), 'signal', a.sellWhy);
      a.lastFill = { side: 'sell', shares, price: priceOf(a) * (1 - slip), t };
    }
    for (const a of waiting) if (a.shares === 0) waiting.delete(a);
    const entering = new Set(live.filter((a) => a.pending === 'buy' && a.shares === 0 && waiting.size === 0));
    if (waiting.size > 0) for (const a of live) if (a.pending === 'buy' && a.shares === 0) a.waited = true;
    const weights = targetWeights(entering, known);
    const buys: { a: A; notional: number; entry: boolean; weight: number }[] = [];
    for (const a of live) {
      const price = priceOf(a);
      if (entering.has(a)) {
        const weight = weights.get(a)!;
        buys.push({ a, notional: riskNotional(a, weight, equityNow, price, known(a)), entry: true, weight });
      } else if (a.shares > 0 && rebalances(a)) {
        const delta = weights.get(a)! * equityNow - a.shares * price;
        if (delta < 0) {
          sell(a, -delta / price, price);
          a.trims++;
        } else buys.push({ a, notional: delta, entry: false, weight: 0 });
      } else if (a.shares > 0 && a.owed === periodKey(a.bars.t[a.i], p.rebalance)) {
        // The rest of this period's top-up; a debt from an earlier period has lapsed.
        const delta = weights.get(a)! * equityNow - a.shares * price;
        if (delta > 0) buys.push({ a, notional: delta, entry: false, weight: 0 });
        else a.owed = null;
      }
      // A ranking buy stays wanted until it fills or the next decision replaces it.
      if (!(p.rank && a.pending === 'buy')) a.pending = null;
    }
    if (p.rank) buys.sort((x, y) => x.a.rankPos - y.a.rankPos || x.a.order - y.a.order);
    for (const { a, notional, entry, weight } of buys) {
      if (entry) {
        a.cashIn = 0;
        a.cashOut = 0;
        a.fees = 0;
        a.topUps = 0;
        a.trims = 0;
      }
      const before = cash;
      const spent = buy(a, notional, priceOf(a));
      if (!entry) {
        // The debt is for the period the rebalance opens: this one at an open, the next one at a close.
        a.owed = notional - spent > 1e-9 * notional ? periodKey(a.bars.t[a.i], p.rebalance) + (atClose ? 1 : 0) : null;
        if (spent > 0) a.topUps++;
      }
      if (entry && a.shares > 0) {
        openPosition(a, t, priceOf(a), known(a), { equity: equityNow, weight, wanted: notional, cash: before, spent, shares: a.shares });
        a.lastFill = { side: 'buy', shares: a.shares, price: a.entryPrice, t };
        a.pending = null;
      }
    }
  };

  for (let k = 0; k < timeline.length; k++) {
    const t = timeline[k];
    if (k > 0) {
      const prev = timeline[k - 1];
      const r = (rateAt(k - 1) * (t - prev)) / DAY / 365;
      cashReturn.push(r);
      if (cash > 0) {
        interest += cash * r;
        cash += cash * r;
      }
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

    if (!atClose) fillOrders(t, live, isLive);

    // Inside the bar: the open comes first, so a gap through the stop or the target fills there;
    // when stop and target both lie inside the bar, the stop is taken first.
    for (const a of live) {
      if (a.shares === 0) continue;
      const { o, h, l } = { o: a.bars.o[a.i], h: a.bars.h[a.i], l: a.bars.l[a.i] };
      const trail = !a.trail ? -Infinity : 'mul' in a.trail ? a.highWater * a.trail.mul : a.highWater - a.trail.dist;
      const stop = Math.max(a.hard, trail);
      if (l <= stop && o < a.target) {
        const trailing = trail > a.hard;
        close(a, t, Math.min(o, stop), trailing ? 'trailing stop' : 'stop loss', { k: 'level', level: stop, high: trailing ? a.highWater : null, atOpen: o < stop });
        a.armed = false;
        a.stoppedT = t;
      } else if (h >= a.target) {
        close(a, t, Math.max(o, a.target), 'take profit', { k: 'level', level: a.target, high: null, atOpen: o > a.target });
        a.armed = false;
        a.stoppedT = t;
      } else {
        // The trailing level only moves on completed bars.
        a.highWater = Math.max(a.highWater, h);
      }
    }

    // Close: read the rules, then (with fill: close) fill what they decided, then mark the book.
    for (const a of live) a.lastClose = a.bars.c[a.i];
    const position = (a: A): PosState | null => (a.shares > 0 ? { entryIdx: a.entryIdx, entryPrice: a.entryPrice } : null);
    const sells = (a: A) => a.sig.sell !== null && a.sig.sell(a.i, position(a)) === 1;
    // A buy whose sizing or stop input is still warming up waits for a later signal.
    for (const a of live) {
      if (a.shares > 0) {
        if (sells(a)) {
          a.pending = 'sell';
          a.sellWhy = { k: 'rule', t: a.bars.t[a.i] };
        }
      } else if (!p.rank) {
        const wantsBuy = a.sig.buy[a.i] === 1;
        if (!wantsBuy) {
          if (!a.armed && a.blockedT !== null) a.cleared = { exitT: a.stoppedT, heldT: a.blockedT, clearedT: a.bars.t[a.i], idx: a.i };
          a.armed = true;
          a.blockedT = null;
        }
        if (wantsBuy && !sells(a) && a.armed) {
          if (ready(a)) {
            a.pending = 'buy';
            const c = a.cleared;
            a.buyWhy = { buyT: a.bars.t[a.i], rank: null, warmup: a.warm, rearm: c && c.idx === a.i - 1 ? { exitT: c.exitT, heldT: c.heldT, clearedT: c.clearedT } : null };
          }
        } else {
          a.heldBack = false;
          if (wantsBuy && !a.armed) a.blockedT = a.bars.t[a.i];
        }
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
          a.pending = a.shares === 0 && ready(a) ? 'buy' : null;
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

    let invested = 0;
    for (const a of assets) if (a.shares > 0) invested += a.shares * a.lastClose;
    const total = cash + invested;
    equity.push(total);
    exposure.push(total > 0 ? invested / total : 0);
  }

  const last = timeline[timeline.length - 1];
  for (const a of assets) if (a.shares > 0) close(a, last, a.lastClose, 'open', null);
  trades.sort((x, y) => x.entryT - y.entryT);

  const equityNow = equity[equity.length - 1];
  const finalWeights = targetWeights(new Set(assets.filter((a) => a.pending === 'buy' && a.shares === 0)), (a) => a.i);
  return {
    t: timeline,
    equity,
    exposure,
    trades,
    states: assets.map((a) => {
      const st: AssetState = {
        name: a.name,
        weight: a.weight,
        long: a.shares > 0,
        since: a.shares > 0 ? a.entryT : null,
        pending: a.pending,
        shares: a.shares,
        lastClose: a.lastClose,
        value: a.shares * a.lastClose,
        targetWeight: equityNow > 0 ? riskNotional(a, finalWeights.get(a)!, equityNow, a.lastClose, a.i) / equityNow : finalWeights.get(a)!,
      };
      if (atClose) {
        const f = a.lastFill;
        st.filled = f && f.t === a.bars.t[a.i] ? { side: f.side, shares: f.shares, price: f.price } : null;
      }
      return st;
    }),
    costs,
    interest,
    cashReturn,
    skipped,
  };
}
