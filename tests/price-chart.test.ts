import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import type { ExitReason, Trade } from '../src/engine.ts';
import {
  MARKER_SPACING,
  boughtWording,
  buyAndHold,
  buyPoints,
  clipBars,
  clipTrades,
  decimate,
  exitWording,
  heldIntervals,
  heldShare,
  markerCount,
  markerPath,
  nearestIndex,
  priceRange,
  priceScale,
  priceTicks,
  showMarkers,
  summaryLine,
  tradeAt,
  useLog,
} from '../src/price-chart.ts';
import { DAY, T0, bars, near } from './helpers.ts';

/** A trade for `asset` from day `a` to day `b` after T0; the prices follow the days unless given. */
function trade(a: number, b: number, extra: Partial<Trade> = {}, asset = 'AAA'): Trade {
  return { asset, entryT: T0 + a * DAY, entryPrice: 100 + a, exitT: T0 + b * DAY, exitPrice: 100 + b, ret: 0, reason: 'signal', bars: b - a, pnl: 0, ...extra };
}
const day = (n: number) => T0 + n * DAY;

test('bars are clipped to the window, both ends included', () => {
  const b = bars([10, 11, 12, 13, 14, 15]);
  const all = clipBars(b, day(0), day(5));
  assert.deepEqual(all.c, [10, 11, 12, 13, 14, 15]);
  const mid = clipBars(b, day(1), day(4));
  assert.deepEqual(mid.c, [11, 12, 13, 14]);
  assert.deepEqual(mid.t, [day(1), day(2), day(3), day(4)]);
  // Edges between bars: the first bar at or after `from`, the last at or before `to`.
  assert.deepEqual(clipBars(b, day(1) + 1, day(4) - 1).c, [12, 13]);
  assert.deepEqual(clipBars(b, day(-9), day(99)).c, [10, 11, 12, 13, 14, 15]);
  assert.deepEqual(clipBars(b, day(6), day(9)).c, []);
  assert.deepEqual(clipBars(b, day(2), day(2)).c, [12]);
});

test('a trade partly outside the window is clipped and loses the marker on the outside', () => {
  const held = clipTrades([trade(0, 10)], 'AAA', day(4), day(20));
  assert.equal(held.length, 1);
  assert.equal(held[0].from, day(4));
  assert.equal(held[0].to, day(10));
  assert.equal(held[0].buy, false);
  assert.equal(held[0].sell, true);
  // The trade itself is untouched, so the tooltip can still say when it was bought.
  assert.equal(held[0].trade.entryT, day(0));

  const late = clipTrades([trade(5, 30)], 'AAA', day(0), day(20));
  assert.equal(late[0].from, day(5));
  assert.equal(late[0].to, day(20));
  assert.equal(late[0].buy, true);
  assert.equal(late[0].sell, false);

  const both = clipTrades([trade(0, 30)], 'AAA', day(10), day(20));
  assert.deepEqual([both[0].from, both[0].to, both[0].buy, both[0].sell], [day(10), day(20), false, false]);
});

test('trades entirely outside the window or for other tickers are dropped', () => {
  const trades = [trade(0, 3), trade(4, 8), trade(10, 12), trade(21, 25), trade(5, 6, {}, 'BBB')];
  const held = clipTrades(trades, 'AAA', day(5), day(20));
  assert.deepEqual(
    held.map((w) => [w.trade.entryT, w.trade.exitT]),
    [[day(4), day(8)], [day(10), day(12)]],
  );
  // A trade that ends exactly at the window's start still touches it; one that starts exactly at the end too.
  assert.equal(clipTrades([trade(0, 5)], 'AAA', day(5), day(20)).length, 1);
  assert.equal(clipTrades([trade(20, 25)], 'AAA', day(5), day(20)).length, 1);
  assert.equal(clipTrades([trade(0, 4)], 'AAA', day(5), day(20)).length, 0);
  assert.equal(clipTrades([trade(21, 25)], 'AAA', day(5), day(20)).length, 0);
});

test('an open trade has no sell marker and its band runs to the window end', () => {
  const open = trade(10, 15, { reason: 'open' });
  const [w] = clipTrades([open], 'AAA', day(0), day(15));
  assert.deepEqual([w.from, w.to, w.buy, w.sell], [day(10), day(15), true, false]);
  const [later] = clipTrades([open], 'AAA', day(0), day(18));
  assert.equal(later.to, day(18));
});

test('held periods join trades that touch and keep gaps between others', () => {
  const held = clipTrades([trade(0, 5), trade(5, 8), trade(10, 12), trade(11, 14)], 'AAA', day(0), day(20));
  assert.deepEqual(heldIntervals(held), [
    { from: day(0), to: day(8) },
    { from: day(10), to: day(14) },
  ]);
  assert.deepEqual(heldIntervals([]), []);
});

test('the share of the window held is measured by time and clipped to the window', () => {
  const held = clipTrades([trade(0, 25), trade(40, 60), trade(80, 150, { reason: 'open' })], 'AAA', day(10), day(110));
  // Inside the window of 100 days: day 10 to 25 (15), 40 to 60 (20), 80 to 110 (30).
  assert.ok(near(heldShare(held, day(10), day(110)), 0.65, 1e-12));
  assert.equal(heldShare([], day(0), day(10)), 0);
  assert.equal(heldShare(clipTrades([trade(0, 10)], 'AAA', day(0), day(10)), day(0), day(10)), 1);
  assert.equal(heldShare(held, day(5), day(5)), 0);
});

test('buy and hold is the last close over the first, within the window', () => {
  assert.ok(near(buyAndHold([50, 60, 40, 75]) as number, 0.5, 1e-12));
  assert.ok(near(buyAndHold([80, 100, 60]) as number, -0.25, 1e-12));
  assert.equal(buyAndHold([10]), null);
  assert.equal(buyAndHold([]), null);
  const clipped = clipBars(bars([10, 20, 30, 40, 50]), day(1), day(3));
  // Only 20, 30 and 40 are inside the window: 40 / 20 - 1, not 50 / 10 - 1.
  assert.deepEqual(clipped.c, [20, 30, 40]);
  assert.ok(near(buyAndHold(clipped.c) as number, 1, 1e-12));
});

test('a price range over a factor of exactly 3 is linear, over more is log', () => {
  assert.equal(useLog(100, 300), false);
  assert.equal(useLog(100, 300.01), true);
  assert.equal(useLog(100, 150), false);
  assert.equal(useLog(0, 500), false);
  assert.equal(useLog(-5, 500), false);
});

test('the price range covers the markers, and a flat price gets room', () => {
  const held = clipTrades([trade(0, 5, { entryPrice: 8, exitPrice: 120 })], 'AAA', day(0), day(10));
  assert.deepEqual(priceRange([10, 50, 100], held), { lo: 8, hi: 120 });
  // A marker outside the window is not drawn, so it does not stretch the axis.
  const clipped = clipTrades([trade(0, 5, { entryPrice: 8, exitPrice: 120 })], 'AAA', day(2), day(10));
  assert.deepEqual(priceRange([10, 50, 100], clipped), { lo: 10, hi: 120 });
  assert.deepEqual(priceRange([10, 50, 100], []), { lo: 10, hi: 100 });
  assert.deepEqual(priceRange([200, 200], []), { lo: 198, hi: 202 });
  assert.deepEqual(priceRange([0, 0], []), { lo: -1, hi: 1 });
});

test('the price scale puts the low at the bottom and the high at the top', () => {
  const lin = priceScale(100, 200, false, 10, 110);
  assert.equal(lin(100), 110);
  assert.equal(lin(200), 10);
  assert.equal(lin(150), 60);
  assert.equal(lin(175), 35);
  const log = priceScale(1, 100, true, 0, 100);
  assert.ok(near(log(1), 100, 1e-9));
  assert.ok(near(log(100), 0, 1e-9));
  assert.ok(near(log(10), 50, 1e-9));
  assert.ok(near(log(Math.sqrt(100)), 50, 1e-9));
});

test('price ticks are even steps on a linear axis and 1-2-5 on a log axis', () => {
  assert.deepEqual(priceTicks(90, 250, false, 5), [100, 120, 140, 160, 180, 200, 220, 240]);
  assert.deepEqual(priceTicks(0.5, 2.4, false, 4), [0.5, 1, 1.5, 2]);
  assert.deepEqual(priceTicks(15, 480, true, 5), [20, 50, 100, 200]);
  for (const v of priceTicks(7, 9000, true, 5)) assert.ok(v >= 7 && v <= 9000);
});

test('the nearest bar is the closest in time, the earlier one on a tie, and clamped at the ends', () => {
  const t = [day(0), day(1), day(3), day(7)];
  assert.equal(nearestIndex(t, day(1)), 1);
  assert.equal(nearestIndex(t, day(1) + DAY / 2 - 1), 1);
  assert.equal(nearestIndex(t, day(2)), 1);
  assert.equal(nearestIndex(t, day(2) + 1), 2);
  assert.equal(nearestIndex(t, day(5) + 1), 3);
  assert.equal(nearestIndex(t, day(-4)), 0);
  assert.equal(nearestIndex(t, day(99)), 3);
  assert.equal(nearestIndex([day(0)], day(5)), 0);
});

test('the trade on at a time includes the day it was sold and prefers the later of two that meet', () => {
  const a = trade(0, 10);
  const b = trade(10, 20, { reason: 'stop loss' });
  const c = trade(30, 40, { reason: 'open' });
  const held = clipTrades([a, b, c], 'AAA', day(0), day(40));
  assert.equal(tradeAt(held, day(0)), a);
  assert.equal(tradeAt(held, day(5)), a);
  assert.equal(tradeAt(held, day(10)), b);
  assert.equal(tradeAt(held, day(20)), b);
  assert.equal(tradeAt(held, day(25)), null);
  assert.equal(tradeAt(held, day(40)), c);
  assert.equal(tradeAt(held, day(-1)), null);
  assert.equal(tradeAt([], day(5)), null);
});

test('the trade on at a time follows the clipped band, so an open trade covers the rest of the window', () => {
  const open = trade(30, 35, { reason: 'open' });
  const held = clipTrades([trade(0, 20), open], 'AAA', day(10), day(50));
  assert.equal(tradeAt(held, day(10))?.entryT, day(0));
  assert.equal(tradeAt(held, day(40)), open);
  assert.equal(tradeAt(held, day(50)), open);
  assert.equal(tradeAt(held, day(25)), null);
  assert.equal(tradeAt(held, day(9)), null);
});

test('markers are dropped when there is less than one per 14 pixels', () => {
  assert.equal(MARKER_SPACING, 14);
  assert.equal(showMarkers(50, 700), true);
  assert.equal(showMarkers(51, 700), false);
  assert.equal(showMarkers(0, 10), true);
  assert.equal(showMarkers(24, 300), false);
  assert.equal(showMarkers(21, 300), true);

  const trades = [trade(0, 5), trade(6, 9), trade(10, 20, { reason: 'open' }), trade(0, 50)];
  // The first starts before the window (a sell only), the second has both, the third is open (a buy only), the fourth has neither.
  const held = clipTrades(trades, 'AAA', day(1), day(30));
  assert.equal(markerCount(held), 1 + 2 + 1 + 0);
  assert.equal(markerCount([]), 0);
});

test('three hundred trades leave no room for markers at any ordinary width', () => {
  const many = Array.from({ length: 300 }, (_, i) => trade(i * 10, i * 10 + 4));
  const held = clipTrades(many, 'AAA', day(0), day(3000));
  assert.equal(markerCount(held), 600);
  assert.equal(showMarkers(markerCount(held), 800), false);
  assert.equal(showMarkers(markerCount(held), 8400), true);
});

test('decimation keeps every bar below two per pixel, and the first and last above', () => {
  const small = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(decimate(small, 3), [0, 1, 2, 3, 4, 5]);
  // Six bars over two pixel columns is more than two per pixel: each column keeps its low and high bar.
  assert.deepEqual(decimate(small, 2), [0, 2, 3, 5]);
  assert.deepEqual(decimate([5], 100), [0]);
  assert.deepEqual(decimate([], 100), []);

  const n = 10_000;
  const c = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 50) * 20 + (i % 97) * 0.1);
  c[4321] = 500;
  c[7777] = -50;
  const idx = decimate(c, 200);
  assert.ok(idx.length <= 2 * 200 + 2, `${idx.length} points`);
  assert.ok(idx.length >= 200);
  assert.equal(idx[0], 0);
  assert.equal(idx[idx.length - 1], n - 1);
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1], 'indices rise');
  // A spike up or down is a bar the line must show.
  assert.ok(idx.includes(4321));
  assert.ok(idx.includes(7777));
});

test('decimation does not repeat a bar that is both the first and a column extreme', () => {
  const c = Array.from({ length: 1000 }, (_, i) => 1000 - i);
  const idx = decimate(c, 10);
  assert.equal(idx[0], 0);
  assert.equal(idx[idx.length - 1], 999);
  assert.equal(new Set(idx).size, idx.length);
  assert.ok(idx.length <= 22);
});

test('a buy marker sits below the price with its tip up, a sell above with its tip down', () => {
  assert.equal(markerPath('buy', 100, 50), 'M100.0,52.0L95.0,61.0L105.0,61.0Z');
  assert.equal(markerPath('sell', 100, 50), 'M100.0,48.0L95.0,39.0L105.0,39.0Z');
});

test('exit reasons are worded as in the trades table', () => {
  const words: [ExitReason, string][] = [
    ['signal', 'sell rule'],
    ['stop loss', 'stop loss'],
    ['trailing stop', 'trailing stop'],
    ['take profit', 'take profit'],
    ['open', 'still held'],
  ];
  for (const [reason, text] of words) assert.equal(exitWording(reason), text);
});

test('the summary line gives the trade count, the time held and the buy and hold return', () => {
  assert.equal(summaryLine(12, 0.634, 2.213), '12 trades, held 63% of the time. Bought and held, it returned 221.3% over this period.');
  assert.equal(summaryLine(2, 0.9, 12.5), '2 trades, held 90% of the time. Bought and held, it returned 1250% over this period.');
  assert.equal(summaryLine(1, 0.5, -0.1234), '1 trade, held 50% of the time. Bought and held, it returned −12.3% over this period.');
  assert.equal(summaryLine(0, 0, 0.05), 'No trades. Bought and held, it returned 5.0% over this period.');
  assert.equal(summaryLine(3, 0.04, null), '3 trades, held 4.0% of the time.');
});

const entry = (a: number, price: number) => ({ t: day(a), price, shares: 1, money: price, signalT: day(a - 1) });

test('a trade made in one go has one buy marker, where the buy was, exactly as before entries existed', () => {
  const held = clipTrades([trade(2, 9), trade(5, 20, { reason: 'open' }), trade(0, 6)], 'AAA', day(1), day(12));
  assert.deepEqual(held.map((w) => buyPoints(w).length), [1, 1, 0]);
  for (const w of held) assert.equal(buyPoints(w).length, w.buy ? 1 : 0);
  assert.deepEqual(buyPoints(held[0]), [{ t: day(2), price: 102 }]);
  // A trade made under `entries` that happened to make one entry is the same.
  const [one] = clipTrades([trade(2, 9, { entries: [entry(2, 102)] })], 'AAA', day(0), day(20));
  assert.deepEqual(buyPoints(one), [{ t: day(2), price: 102 }]);
});

test('a position built in entries has a buy marker for each entry, at its own fill price', () => {
  const entries = [entry(2, 100), entry(5, 110), entry(8, 125)];
  const t = trade(2, 15, { entries, entryPrice: 111.7 });
  const [whole] = clipTrades([t], 'AAA', day(0), day(30));
  assert.deepEqual(buyPoints(whole), [{ t: day(2), price: 100 }, { t: day(5), price: 110 }, { t: day(8), price: 125 }]);
  // The window cuts away the entries before it, as it does a buy.
  const [late] = clipTrades([t], 'AAA', day(4), day(30));
  assert.deepEqual(buyPoints(late).map((p) => p.price), [110, 125]);
  // And after it, for a position that is still held at the window's end.
  const [open] = clipTrades([{ ...t, reason: 'open' }], 'AAA', day(0), day(6));
  assert.deepEqual(buyPoints(open).map((p) => p.price), [100, 110]);
  // The entry on the window's first and last day counts.
  assert.deepEqual(buyPoints(clipTrades([t], 'AAA', day(5), day(5))[0]).map((p) => p.price), [110]);
});

test('the markers of a position built in entries are counted one by one, with the sell', () => {
  const t = trade(2, 15, { entries: [entry(2, 100), entry(5, 110), entry(8, 125)] });
  assert.equal(markerCount(clipTrades([t], 'AAA', day(0), day(30))), 4);
  assert.equal(markerCount(clipTrades([t], 'AAA', day(4), day(30))), 3);
  assert.equal(markerCount(clipTrades([t, trade(20, 25)], 'AAA', day(0), day(30))), 4 + 2);
});

test('the price axis covers the price of every entry', () => {
  const closes = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];
  const t = trade(0, 9, { entries: [entry(0, 100), entry(4, 80), entry(7, 140)], entryPrice: 106.7, exitPrice: 109 });
  assert.deepEqual(priceRange(closes, clipTrades([t], 'AAA', day(0), day(9))), { lo: 80, hi: 140 });
  // A marker off the window does not stretch it.
  assert.deepEqual(priceRange(closes.slice(5), clipTrades([t], 'AAA', day(5), day(9))), { lo: 105, hi: 140 });
});

test('the tooltip says how many entries and the average, or the day and price of a single buy', () => {
  const when = (t: number) => `day ${(t - T0) / DAY}`;
  const money = (v: number) => v.toFixed(2);
  assert.equal(boughtWording(trade(2, 9), when, money), 'day 2 at 102.00');
  assert.equal(boughtWording(trade(2, 9, { entries: [entry(2, 102)] }), when, money), 'day 2 at 102.00');
  assert.equal(boughtWording(trade(2, 9, { entries: [entry(2, 100), entry(5, 110)], entryPrice: 105 }), when, money), '2 entries from day 2, 105.00 on average');
});

test('on a real run every entry of every trade gets its marker, on the bar it filled at its fill price', () => {
  const closes = Array.from({ length: 300 }, (_, i) => 100 + i * 0.4 + 8 * Math.sin(i / 7));
  const data = new Map([['AAA', bars(closes)]]);
  const { spec, errors } = parseSpec('universe: AAA\nentries: 3\nbuy when close > sma(10)\nadd when close > last entry price * 1.01\nsell when close < sma(10)');
  assert.deepEqual(errors, []);
  const bt = runBacktest(spec!, data);
  assert.ok(bt.run.trades.some((t) => t.entries!.length === 3));
  const held = clipTrades(bt.run.trades, 'AAA', day(0), day(299));
  const points = held.flatMap(buyPoints);
  assert.equal(points.length, bt.run.trades.reduce((s, t) => s + t.entries!.length, 0));
  assert.equal(markerCount(held), points.length + held.filter((w) => w.sell).length);
  const b = data.get('AAA')!;
  for (const p of points) assert.ok(b.t.includes(p.t));
  assert.deepEqual(points, bt.run.trades.flatMap((t) => t.entries!.map((e) => ({ t: e.t, price: e.price }))));
});
