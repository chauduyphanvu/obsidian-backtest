// What the "Prices and trades" charts show and where it goes. No DOM: render-price.ts draws what this decides.

import { moneyTicks, niceStep, pct } from './dom.ts';
import type { ExitReason, Trade } from './engine.ts';
import type { Bars } from './types.ts';

/** A ticker's closes inside the window. */
export interface Closes {
  t: number[];
  c: number[];
}

/** One trade as the window shows it. */
export interface WindowTrade {
  trade: Trade;
  /** The part of the holding period inside the window; an open trade runs to the window's end. */
  from: number;
  to: number;
  /** Whether the buy and the sell happened inside the window, so each can be marked. An open trade has no sell. */
  buy: boolean;
  sell: boolean;
}

/** Plot width allowed per marker before the markers stop being useful. */
export const MARKER_SPACING = 14;
/** How far a marker reaches from its price, ring included. */
export const MARKER_REACH = 13;

/** First index in the ascending `t` whose value is at least `time`, or, with `past`, greater than it. */
function bound(t: number[], time: number, past = false): number {
  let a = 0;
  let b = t.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (t[mid] < time || (past && t[mid] === time)) a = mid + 1;
    else b = mid;
  }
  return a;
}

/** The bars with `from <= t <= to`. */
export function clipBars(bars: Bars, from: number, to: number): Closes {
  const a = bound(bars.t, from);
  const b = bound(bars.t, to, true);
  return { t: bars.t.slice(a, b), c: bars.c.slice(a, b) };
}

/**
 * The ticker's trades that touch the window, in the order given. A trade that starts or ends outside is
 * clipped to the window and loses the marker for the side that is outside; one entirely outside is dropped.
 */
export function clipTrades(trades: Trade[], ticker: string, from: number, to: number): WindowTrade[] {
  const out: WindowTrade[] = [];
  for (const trade of trades) {
    if (trade.asset !== ticker || trade.exitT < from || trade.entryT > to) continue;
    const open = trade.reason === 'open';
    out.push({
      trade,
      from: Math.max(trade.entryT, from),
      to: open ? to : Math.min(trade.exitT, to),
      buy: trade.entryT >= from,
      sell: !open && trade.exitT <= to,
    });
  }
  return out;
}

/** Where one trade's buy markers go in the window: one for each entry in it, at its own fill price. */
export function buyPoints(w: WindowTrade): { t: number; price: number }[] {
  const fills = w.trade.entries ?? [{ t: w.trade.entryT, price: w.trade.entryPrice }];
  return fills.filter((e) => e.t >= w.from && e.t <= w.to).map((e) => ({ t: e.t, price: e.price }));
}

/** The periods the strategy held the ticker, with trades that touch or overlap joined. Needs `held` in time order. */
export function heldIntervals(held: WindowTrade[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const w of held) {
    const last = out[out.length - 1];
    if (last && w.from <= last.to) last.to = Math.max(last.to, w.to);
    else out.push({ from: w.from, to: w.to });
  }
  return out;
}

/** The share of the window, by time, that the ticker was held. */
export function heldShare(held: WindowTrade[], from: number, to: number): number {
  if (to <= from) return 0;
  return heldIntervals(held).reduce((sum, p) => sum + (p.to - p.from), 0) / (to - from);
}

/** Return from the first close to the last, or null with fewer than two bars. */
export function buyAndHold(c: number[]): number | null {
  return c.length < 2 ? null : c[c.length - 1] / c[0] - 1;
}

/** The trade that was on at `time` (the day it was sold included), matching the shaded bands. Of two that meet at one time, the later. */
export function tradeAt(held: WindowTrade[], time: number): Trade | null {
  for (let i = held.length - 1; i >= 0; i--) {
    if (held[i].from <= time && time <= held[i].to) return held[i].trade;
  }
  return null;
}

/** Index of the bar nearest `time` (the earlier one on a tie); times outside the data give the first or last bar. */
export function nearestIndex(t: number[], time: number): number {
  const b = bound(t, time);
  if (b === 0) return 0;
  if (b === t.length) return t.length - 1;
  return time - t[b - 1] <= t[b] - time ? b - 1 : b;
}

/** Prices that range over a factor of more than 3 read better on a log axis. */
export function useLog(lo: number, hi: number): boolean {
  return lo > 0 && hi / lo > 3;
}

/** The prices the axis must cover: every close and every price a marker sits on. A flat price gets a little room. */
export function priceRange(c: number[], held: WindowTrade[]): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  const see = (v: number) => {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  };
  for (const v of c) see(v);
  for (const w of held) {
    for (const p of buyPoints(w)) see(p.price);
    if (w.sell) see(w.trade.exitPrice);
  }
  if (hi <= lo) {
    const room = Math.abs(lo) * 0.01 || 1;
    return { lo: lo - room, hi: hi + room };
  }
  return { lo, hi };
}

/** Maps a price to a y pixel: `lo` at `bottom`, `hi` at `top`. */
export function priceScale(lo: number, hi: number, log: boolean, top: number, bottom: number): (v: number) => number {
  const [a, b] = log ? [Math.log(lo), Math.log(hi)] : [lo, hi];
  return (v) => bottom - (((log ? Math.log(v) : v) - a) / (b - a)) * (bottom - top);
}

/** Gridline prices: about `count` even steps on a linear axis, 1-2-5 steps on a log axis. */
export function priceTicks(lo: number, hi: number, log: boolean, count: number): number[] {
  if (log) return moneyTicks(lo, hi);
  const step = niceStep(hi - lo, count);
  const out: number[] = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9; k++) out.push(k * step);
  return out;
}

/** Indices of the closes to draw: about two per pixel, keeping each pixel column's low and high, and always the first and last bar. */
export function decimate(c: number[], plotW: number): number[] {
  const n = c.length;
  const columns = Math.max(1, Math.floor(plotW));
  if (n <= columns * 2) return Array.from({ length: n }, (_, i) => i);
  const out = [0];
  const keep = (i: number) => {
    if (i > out[out.length - 1]) out.push(i);
  };
  for (let k = 0; k < columns; k++) {
    const a = Math.floor((k * n) / columns);
    const b = Math.floor(((k + 1) * n) / columns);
    let lo = a;
    let hi = a;
    for (let i = a + 1; i < b; i++) {
      if (c[i] < c[lo]) lo = i;
      if (c[i] > c[hi]) hi = i;
    }
    keep(Math.min(lo, hi));
    keep(Math.max(lo, hi));
  }
  keep(n - 1);
  return out;
}

/** How many buy and sell markers the window would carry. */
export function markerCount(held: WindowTrade[]): number {
  return held.reduce((sum, w) => sum + buyPoints(w).length + (w.sell ? 1 : 0), 0);
}

/** Markers are drawn only when there is room for about one per `MARKER_SPACING` pixels. */
export function showMarkers(count: number, plotW: number): boolean {
  return count * MARKER_SPACING <= plotW;
}

/**
 * A marker pointing at the fill price (x, y): a buy sits below it with its tip up, a sell above it with its tip down.
 * The tip is 2px from the price so it does not cover the line.
 */
export function markerPath(kind: 'buy' | 'sell', x: number, y: number): string {
  const dir = kind === 'buy' ? 1 : -1;
  const f = (v: number) => v.toFixed(1);
  return `M${f(x)},${f(y + 2 * dir)}L${f(x - 5)},${f(y + 11 * dir)}L${f(x + 5)},${f(y + 11 * dir)}Z`;
}

/** What the tooltip says about the buying: the day and price, or for a position built in entries their number, the first day and the average price. */
export function boughtWording(trade: Trade, when: (t: number) => string, price: (v: number) => string): string {
  const n = trade.entries?.length ?? 1;
  return n > 1 ? `${n} entries from ${when(trade.entryT)}, ${price(trade.entryPrice)} on average` : `${when(trade.entryT)} at ${price(trade.entryPrice)}`;
}

/** Why a position ended, worded as in the trades table. */
export function exitWording(reason: ExitReason): string {
  return reason === 'open' ? 'still held' : reason === 'signal' ? 'sell rule' : reason;
}

/** One line above the chart: how often the strategy held the ticker, and what simply holding it would have returned. */
export function summaryLine(tradeCount: number, share: number, hold: number | null): string {
  const mine = tradeCount === 0 ? 'No trades.' : `${tradeCount} ${tradeCount === 1 ? 'trade' : 'trades'}, held ${pct(share, share < 0.1 ? 1 : 0)} of the time.`;
  return hold === null ? mine : `${mine} Bought and held, it returned ${pct(hold, Math.abs(hold) >= 10 ? 0 : 1)} over this period.`;
}
