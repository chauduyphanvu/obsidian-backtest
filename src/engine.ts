import type { Rebalance } from './dsl.ts';
import type { Asset, Bars } from './types.ts';

export type ExitReason = 'signal' | 'stop loss' | 'trailing stop' | 'take profit' | 'open';

export interface Trade {
  asset: string;
  entryT: number;
  entryPrice: number;
  exitT: number;
  exitPrice: number;
  /** Price return after costs on both sides. */
  ret: number;
  reason: ExitReason;
}

export interface AssetState {
  name: string;
  weight: number;
  long: boolean;
  since: number | null;
  /** An order from the last bar's signal that would fill at the next open. */
  pending: 'buy' | 'sell' | null;
}

export interface SimParams {
  assets: Asset[];
  from: number | null;
  to: number | null;
  capital: number;
  costBps: number;
  rebalance: Rebalance;
  stopLoss: number | null;
  trailingStop: number | null;
  takeProfit: number | null;
}

/** Per asset, aligned with its bars: 1 where the condition holds. `sell` is null when there is no sell rule. */
export interface Signals {
  buy: number[];
  sell: number[] | null;
}

export interface RunResult {
  t: number[];
  equity: number[];
  /** Fraction of equity invested at each close. */
  exposure: number[];
  trades: Trade[];
  states: AssetState[];
  costs: number;
}

const DAY = 86_400_000;

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
  const assets = p.assets.map((a) => {
    const bars = data.get(a.name);
    if (!bars || bars.t.length === 0) throw new Error(`No price data for ${a.name}`);
    return {
      name: a.name,
      weight: a.weight,
      bars,
      sig: signals.get(a.name)!,
      i: -1, // index of the latest bar at or before the current time
      shares: 0,
      lastClose: NaN,
      entryT: 0,
      entryPrice: 0,
      highWater: 0,
      // After a stop or target exit, the buy rule must stop holding before it can fire again.
      armed: true,
      pending: null as 'buy' | 'sell' | null,
    };
  });

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

  const cost = p.costBps / 10_000;
  let cash = p.capital;
  let costs = 0;
  let prevPeriod: number | null = null;
  const trades: Trade[] = [];
  const equity: number[] = [];
  const exposure: number[] = [];

  type A = (typeof assets)[number];
  const sell = (a: A, shares: number, price: number) => {
    const fee = shares * price * cost;
    cash += shares * price - fee;
    costs += fee;
    a.shares -= shares;
  };
  const buy = (a: A, notional: number, price: number) => {
    const spend = Math.min(notional, cash / (1 + cost));
    if (spend <= 0) return;
    cash -= spend * (1 + cost);
    costs += spend * cost;
    a.shares += spend / price;
  };
  const close = (a: A, t: number, price: number, reason: ExitReason) => {
    if (reason !== 'open') sell(a, a.shares, price);
    trades.push({
      asset: a.name,
      entryT: a.entryT,
      entryPrice: a.entryPrice,
      exitT: t,
      exitPrice: price,
      ret: (price * (1 - cost)) / (a.entryPrice * (1 + cost)) - 1,
      reason,
    });
  };

  for (const t of timeline) {
    const live: A[] = [];
    for (const a of assets) {
      if (a.i + 1 < a.bars.t.length && a.bars.t[a.i + 1] === t) {
        a.i++;
        live.push(a);
      }
    }

    // Open: yesterday's orders and the scheduled rebalance, sells before buys.
    const period = periodKey(t, p.rebalance);
    const rebalance = prevPeriod !== null && period !== prevPeriod;
    prevPeriod = period;
    const mark = (a: A) => (a.shares === 0 ? 0 : a.shares * (live.includes(a) ? a.bars.o[a.i] : a.lastClose));
    const equityAtOpen = cash + assets.reduce((s, a) => s + mark(a), 0);
    const buys: { a: A; notional: number; entry: boolean }[] = [];
    for (const a of live) {
      const open = a.bars.o[a.i];
      if (a.pending === 'sell' && a.shares > 0) {
        close(a, t, open, 'signal');
      } else if (a.pending === 'buy' && a.shares === 0) {
        buys.push({ a, notional: a.weight * equityAtOpen, entry: true });
      } else if (rebalance && a.shares > 0) {
        const delta = a.weight * equityAtOpen - a.shares * open;
        if (delta < 0) sell(a, -delta / open, open);
        else buys.push({ a, notional: delta, entry: false });
      }
      a.pending = null;
    }
    for (const { a, notional, entry } of buys) {
      const open = a.bars.o[a.i];
      buy(a, notional, open);
      if (entry && a.shares > 0) {
        a.entryT = t;
        a.entryPrice = open;
        a.highWater = open;
      }
    }

    // Inside the bar: a gap through the stop fills at the open; when stop and target both lie
    // inside the bar, the stop is taken first.
    for (const a of live) {
      if (a.shares === 0) continue;
      const { o, h, l } = { o: a.bars.o[a.i], h: a.bars.h[a.i], l: a.bars.l[a.i] };
      const hard = p.stopLoss !== null ? a.entryPrice * (1 - p.stopLoss) : -Infinity;
      const trail = p.trailingStop !== null ? a.highWater * (1 - p.trailingStop) : -Infinity;
      const stop = Math.max(hard, trail);
      const target = p.takeProfit !== null ? a.entryPrice * (1 + p.takeProfit) : Infinity;
      if (l <= stop) {
        close(a, t, Math.min(o, stop), trail > hard ? 'trailing stop' : 'stop loss');
        a.armed = false;
      } else if (h >= target) {
        close(a, t, Math.max(o, target), 'take profit');
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

    for (const a of live) {
      const wantsBuy = a.sig.buy[a.i] === 1;
      const wantsSell = a.sig.sell !== null && a.sig.sell[a.i] === 1;
      if (a.shares > 0) {
        if (wantsSell) a.pending = 'sell';
      } else {
        if (!wantsBuy) a.armed = true;
        if (wantsBuy && !wantsSell && a.armed) a.pending = 'buy';
      }
    }
  }

  const last = timeline[timeline.length - 1];
  for (const a of assets) if (a.shares > 0) close(a, last, a.lastClose, 'open');
  trades.sort((x, y) => x.entryT - y.entryT);

  return {
    t: timeline,
    equity,
    exposure,
    trades,
    states: assets.map((a) => ({ name: a.name, weight: a.weight, long: a.shares > 0, since: a.shares > 0 ? a.entryT : null, pending: a.pending })),
    costs,
  };
}
