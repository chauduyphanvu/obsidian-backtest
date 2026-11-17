import type { CashRate, Rebalance, Sizing, StopLevel, Stops } from './dsl.ts';
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
}

export interface AssetState {
  name: string;
  /** The configured weight. */
  weight: number;
  long: boolean;
  since: number | null;
  /** An order from the last bar's signal that would fill at the next open. */
  pending: 'buy' | 'sell' | null;
  shares: number;
  lastClose: number;
  /** Shares at the last close. */
  value: number;
  /** The weight a buy at the next open would use, estimated from the last close. */
  targetWeight: number;
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
}

const DAY = 86_400_000;
const NO_STOPS: Stops = { stopLoss: null, trailingStop: null, takeProfit: null };

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
 * Long/flat portfolio simulation. A rule seen at a bar's close fills at that asset's next open.
 * Each asset is either at its target weight or in cash; stops and targets fill inside the bar.
 */
export function simulate(p: SimParams, data: Map<string, Bars>, signals: Map<string, Signals>): RunResult {
  const assets = p.assets.map((a, order) => {
    const bars = data.get(a.name);
    if (!bars || bars.t.length === 0) throw new Error(`No price data for ${a.name}`);
    return {
      name: a.name,
      order,
      weight: a.weight,
      bars,
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
    a.cashOut += value - fee;
    a.shares -= shares;
  };
  const buy = (a: A, notional: number, price: number) => {
    const spend = Math.min(notional, cash / (1 + cost));
    if (spend <= 0) return;
    cash -= spend * (1 + cost);
    costs += spend * cost;
    a.cashIn += spend * (1 + cost);
    a.shares += spend / (price * (1 + slip));
  };
  const close = (a: A, t: number, price: number, reason: ExitReason) => {
    const exitPrice = reason === 'open' ? price : price * (1 - slip);
    if (reason !== 'open') sell(a, a.shares, price);
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
    });
  };
  const openPosition = (a: A, t: number, open: number) => {
    const fill = open * (1 + slip);
    // Distances in ATR use its value at the close before the fill, and keep it for the position's life.
    const dist = (s: StopLevel) => (s.k === 'atr' ? s.mult * atrAt(a, s.n, a.i - 1) : NaN);
    const known = (x: number, dflt: number) => (Number.isNaN(x) ? dflt : x);
    const { stopLoss, trailingStop, takeProfit } = a.stops;
    a.entryT = t;
    a.entryIdx = a.i;
    a.entryPrice = fill;
    a.highWater = open;
    a.hard = !stopLoss ? -Infinity : known(stopLoss.k === 'pct' ? fill * (1 - stopLoss.v) : fill - dist(stopLoss), -Infinity);
    a.target = !takeProfit ? Infinity : known(takeProfit.k === 'pct' ? fill * (1 + takeProfit.v) : fill + dist(takeProfit), Infinity);
    a.trail = !trailingStop ? null : trailingStop.k === 'pct' ? { mul: 1 - trailingStop.v } : Number.isNaN(dist(trailingStop)) ? null : { dist: dist(trailingStop) };
  };

  /**
   * Target weights for the assets held or being bought. Inverse volatility shares out those
   * assets' configured weights by 1 / volatility, measured up to `idx(a)`; an asset with unknown
   * volatility keeps its configured weight.
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

    // Open: yesterday's orders and the scheduled rebalance, sells before buys. Each asset is
    // rebalanced at its own first bar of a period, so a ticker closed on the period's first day still is.
    const rebalances = (a: A) => a.i > 0 && periodKey(a.bars.t[a.i], p.rebalance) !== periodKey(a.bars.t[a.i - 1], p.rebalance);
    const isLive = new Set(live);
    const mark = (a: A) => (a.shares === 0 ? 0 : a.shares * (isLive.has(a) ? a.bars.o[a.i] : a.lastClose));
    const equityAtOpen = cash + assets.reduce((s, a) => s + mark(a), 0);
    for (const a of live) if (a.pending === 'sell' && a.shares > 0) close(a, t, a.bars.o[a.i], 'signal');
    for (const a of waiting) if (a.shares === 0) waiting.delete(a);
    const entering = new Set(live.filter((a) => a.pending === 'buy' && a.shares === 0 && waiting.size === 0));
    // Volatility as of the last close before this open.
    const weights = targetWeights(entering, (a) => (isLive.has(a) ? a.i - 1 : a.i));
    const buys: { a: A; notional: number; entry: boolean }[] = [];
    for (const a of live) {
      const open = a.bars.o[a.i];
      if (entering.has(a)) {
        buys.push({ a, notional: riskNotional(a, weights.get(a)!, equityAtOpen, open, a.i - 1), entry: true });
      } else if (a.shares > 0 && rebalances(a)) {
        const delta = weights.get(a)! * equityAtOpen - a.shares * open;
        if (delta < 0) sell(a, -delta / open, open);
        else buys.push({ a, notional: delta, entry: false });
      }
      // A ranking buy stays wanted until it fills or the next decision replaces it.
      if (!(p.rank && a.pending === 'buy')) a.pending = null;
    }
    if (p.rank) buys.sort((x, y) => x.a.rankPos - y.a.rankPos || x.a.order - y.a.order);
    for (const { a, notional, entry } of buys) {
      if (entry) {
        a.cashIn = 0;
        a.cashOut = 0;
      }
      buy(a, notional, a.bars.o[a.i]);
      if (entry && a.shares > 0) {
        openPosition(a, t, a.bars.o[a.i]);
        a.pending = null;
      }
    }

    // Inside the bar: the open comes first, so a gap through the stop or the target fills there;
    // when stop and target both lie inside the bar, the stop is taken first.
    for (const a of live) {
      if (a.shares === 0) continue;
      const { o, h, l } = { o: a.bars.o[a.i], h: a.bars.h[a.i], l: a.bars.l[a.i] };
      const trail = !a.trail ? -Infinity : 'mul' in a.trail ? a.highWater * a.trail.mul : a.highWater - a.trail.dist;
      const stop = Math.max(a.hard, trail);
      if (l <= stop && o < a.target) {
        close(a, t, Math.min(o, stop), trail > a.hard ? 'trailing stop' : 'stop loss');
        a.armed = false;
      } else if (h >= a.target) {
        close(a, t, Math.max(o, a.target), 'take profit');
        a.armed = false;
      } else {
        // The trailing level only moves on completed bars.
        a.highWater = Math.max(a.highWater, h);
      }
    }

    // Close: mark the book, then read the rules for the next open.
    let invested = 0;
    for (const a of live) a.lastClose = a.bars.c[a.i];
    for (const a of assets) if (a.shares > 0) invested += a.shares * a.lastClose;
    const total = cash + invested;
    equity.push(total);
    exposure.push(total > 0 ? invested / total : 0);

    const position = (a: A): PosState | null => (a.shares > 0 ? { entryIdx: a.entryIdx, entryPrice: a.entryPrice } : null);
    const sells = (a: A) => a.sig.sell !== null && a.sig.sell(a.i, position(a)) === 1;
    for (const a of live) {
      if (a.shares > 0) {
        if (sells(a)) a.pending = 'sell';
      } else if (!p.rank) {
        const wantsBuy = a.sig.buy[a.i] === 1;
        if (!wantsBuy) a.armed = true;
        if (wantsBuy && !sells(a) && a.armed) a.pending = 'buy';
      }
    }

    // Ranking: on a decision bar hold the top scores among the eligible; in between, sell rules
    // and stops can still exit, and a freed slot waits for the next decision.
    if (p.rank && decisions![k] === 1) {
      const score = (a: A) => a.sig.score![a.i];
      const eligible = assets.filter((a) => a.i >= 0 && a.sig.buy[a.i] === 1 && !sells(a) && Number.isFinite(score(a)));
      eligible.sort((x, y) => score(y) - score(x) || x.order - y.order);
      const chosen = new Set(eligible.slice(0, p.rank.top));
      for (const a of assets) a.rankPos = Infinity;
      eligible.forEach((a, n) => (a.rankPos = n));
      // A sell that can never fill (the ticker has no later bar in the run) is not waited for.
      const fills = (a: A) => a.i + 1 < a.bars.t.length && a.bars.t[a.i + 1] <= end;
      waiting = new Set();
      for (const a of assets) {
        if (chosen.has(a)) {
          a.pending = a.shares === 0 ? 'buy' : null;
        } else if (a.shares > 0) {
          a.pending = 'sell';
          if (fills(a)) waiting.add(a);
        } else {
          a.pending = null;
        }
      }
    }
  }

  const last = timeline[timeline.length - 1];
  for (const a of assets) if (a.shares > 0) close(a, last, a.lastClose, 'open');
  trades.sort((x, y) => x.entryT - y.entryT);

  const equityNow = equity[equity.length - 1];
  const finalWeights = targetWeights(new Set(assets.filter((a) => a.pending === 'buy' && a.shares === 0)), (a) => a.i);
  return {
    t: timeline,
    equity,
    exposure,
    trades,
    states: assets.map((a) => ({
      name: a.name,
      weight: a.weight,
      long: a.shares > 0,
      since: a.shares > 0 ? a.entryT : null,
      pending: a.pending,
      shares: a.shares,
      lastClose: a.lastClose,
      value: a.shares * a.lastClose,
      targetWeight: equityNow > 0 ? riskNotional(a, finalWeights.get(a)!, equityNow, a.lastClose, a.i) / equityNow : finalWeights.get(a)!,
    })),
    costs,
    interest,
    cashReturn,
  };
}
