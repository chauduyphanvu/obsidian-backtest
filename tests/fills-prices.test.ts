import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillColumnsText, matchFills, parseFillColumns, rawPrices, type FillLog, type Followed } from '../src/fills.ts';
import { fillsSetup, matchCells, tradingDays } from '../src/render-account.ts';
import type { RunOutput } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { near } from './helpers.ts';

// Each strategy's fills are converted with its own bars, and set against yours as traded: in shares as traded, at the
// prices of the day of your fill. The cases an independent review found, worked out by hand.

const d = (m: number, day: number) => Date.UTC(2026, m - 1, day);
const bars = (t: number[], o: number[], c: number[] = o, spread = 0): Bars => ({
  t,
  o,
  h: o.map((x, i) => Math.max(x, c[i]) + spread),
  l: o.map((x, i) => Math.min(x, c[i]) - spread),
  c,
  v: t.map(() => 1),
});
const one = (t: number, shares: number, price: number, kind: FillLog['kind'][number] = 'entry'): FillLog => ({ t: [t], asset: ['SPY'], kind: [kind], sharesAfter: [shares], price: [price] });
const none: FillLog = { t: [], asset: [], kind: [], sharesAfter: [], price: [] };
const follow = (label: string, alloc: number, t: number[], equity: number, log: FillLog, own?: Bars): Followed => ({
  label,
  alloc,
  log,
  t,
  equity: t.map(() => equity),
  ...(own ? { bars: new Map([['SPY', own]]) } : {}),
});
const buy = (date: number, quantity: number, price: number) => ({ date, ticker: 'SPY', side: 'buy' as const, quantity, price, fees: 0, line: 2 });

// A $1 dividend goes ex on Wednesday June 3. Daily prices as traded are 100 until then and 99 after.
const DAYS = [d(5, 26), d(5, 27), d(5, 28), d(5, 29), d(6, 1), d(6, 2), d(6, 3), d(6, 4), d(6, 5), d(6, 8)];
const RAW = bars(DAYS, DAYS.map((t) => (t < d(6, 3) ? 100 : 99)));
// Daily adjusted prices take 1% off the days before the ex-date; a weekly bar carries its Friday's adjustment.
const DAILY = bars(DAYS, RAW.c.map((x, i) => x * (DAYS[i] < d(6, 3) ? 0.99 : 1)));
const WEEKLY = bars([d(5, 25), d(6, 1)], [99, 100], [99, 99]);
const PRICED = rawPrices(new Map(), new Map([['SPY', RAW]]), new Set(['SPY']));

test("a weekly strategy's fill is converted with its own weekly bars, though a daily strategy trades the same ticker", () => {
  // The weekly strategy buys 100 shares at Monday's open: 100 in its bars, and 100 as traded.
  const weekly = follow('Weekly', 0.5, WEEKLY.t, 10_000, one(d(6, 1), 100, 100), WEEKLY);
  const daily = follow('Daily', 0.5, DAILY.t, 10_000, none, DAILY);
  const r = matchFills([weekly, daily], [buy(d(6, 1), 50, 100)], { from: d(5, 30), capital: 10_000, last: { SPY: 99 }, raw: PRICED });
  assert.deepEqual(r.rows.map((x) => [x.class, x.model!.price, x.bps]), [['on time', 100, 0]]);
});

test("a daily strategy's fill keeps its price when an hourly strategy trades the same ticker", () => {
  const raw = bars([d(6, 1), d(6, 2), d(6, 3)], [100, 100, 100]);
  const daily = follow('Daily', 0.5, raw.t, 10_000, one(d(6, 2), 10, 99), bars(raw.t, [99, 99, 99]));
  const hours = [d(6, 3) + 13.5 * 3_600_000, d(6, 3) + 14.5 * 3_600_000];
  const hourly = follow('Hourly', 0.5, hours, 10_000, none, bars(hours, [99, 99]));
  const r = matchFills([daily, hourly], [buy(d(6, 2), 5, 100.05)], { from: d(6, 1), capital: 10_000, last: { SPY: 99 }, raw: rawPrices(new Map(), new Map([['SPY', raw]]), new Set(['SPY'])) });
  assert.equal(r.rows[0].unpriced, false);
  assert.ok(near(r.rows[0].model!.price, 100, 1e-9));
  assert.ok(near(r.rows[0].bps!, 5, 1e-6));
});

test("orders of two strategies at the same open net, whatever each one's prices are adjusted by", () => {
  // The weekly strategy buys 50 at Monday's open, 100 in its bars; the daily one sells its 50 at the same open, 99 in its own.
  const t = [d(5, 29), d(6, 1), d(6, 2), d(6, 3), d(6, 4), d(6, 5), d(6, 8), d(6, 9), d(6, 10), d(6, 11)];
  const weekly = follow('Weekly', 0.5, t, 10_000, one(d(6, 1), 50, 100));
  const daily = follow('Daily', 0.5, t, 10_000, { t: [d(5, 1), d(6, 1)], asset: ['SPY', 'SPY'], kind: ['entry', 'sell'], sharesAfter: [50, 0], price: [95, 99] });
  const r = matchFills([weekly, daily], [], { from: d(5, 30), capital: 20_000, last: { SPY: 99 } });
  assert.deepEqual(r.rows, []);
  assert.equal(r.total, 0);
  // A stop the same day is a moment of its own: it does not net with the open.
  const stopped = follow('Daily', 0.5, t, 10_000, { t: [d(5, 1), d(6, 1)], asset: ['SPY', 'SPY'], kind: ['entry', 'stop'], sharesAfter: [50, 0], price: [95, 97] });
  assert.deepEqual(matchFills([weekly, stopped], [], { from: d(5, 30), capital: 20_000, last: { SPY: 99 } }).rows.map((x) => x.model!.side), ['buy', 'sell']);
});

test('a late fill after a split is set against the price of its own day, in its own shares', () => {
  // The strategy buys 100 split-adjusted shares at 50 on Tuesday June 2, 100 as traded; a 2-for-1 split takes effect on
  // the Wednesday. You buy 100 shares at 50.50 on the Thursday: the same position, 0.50 a share dearer.
  const days = [d(6, 1), d(6, 2), d(6, 3), d(6, 4), d(6, 5), d(6, 8), d(6, 9), d(6, 10), d(6, 11)];
  const adjusted = bars(days, days.map(() => 50), days.map(() => 50), 0.25);
  const raw = bars(days, days.map((t) => (t < d(6, 3) ? 100 : 50)), days.map((t) => (t < d(6, 3) ? 100 : 50)), 0.5);
  const S = follow('A', 1, days, 10_000, one(d(6, 2), 100, 50), adjusted);
  const r = matchFills([S], [buy(d(6, 4), 100, 50.5)], { from: d(6, 1), capital: 10_000, last: { SPY: 50 }, raw: rawPrices(new Map(), new Map([['SPY', raw]]), new Set(['SPY'])), days: { SPY: days } });
  assert.deepEqual(r.rows.map((x) => [x.class, x.daysLate, x.model!.quantity, x.model!.price, x.yours!.quantity, x.outside]), [['late', 2, 100, 50, 100, false]]);
  assert.ok(near(r.total, 50));
});

test('a late fill after an ex-dividend day is set against the price of its own day, so the dividend is not a cost', () => {
  const days = [d(6, 1), d(6, 2), d(6, 3), d(6, 4), d(6, 5), d(6, 8), d(6, 9), d(6, 10), d(6, 11)];
  const raw = bars(days, days.map((t) => (t < d(6, 3) ? 100 : 99)));
  const S = follow('A', 1, days, 9_900, one(d(6, 2), 100, 99), bars(days, days.map(() => 99)));
  const r = matchFills([S], [buy(d(6, 4), 100, 99)], { from: d(6, 1), capital: 9_900, last: { SPY: 99 }, raw: rawPrices(new Map(), new Map([['SPY', raw]]), new Set(['SPY'])) });
  assert.deepEqual(r.rows.map((x) => [x.class, x.model!.price, x.late]), [['late', 99, 0]]);
});

test("the strategies' shares are counted as they traded that day, not after a later split", () => {
  // The strategy buys 100 split-adjusted shares at 25 on June 2, before a 4-for-1 split on June 10: 25 shares at 100.
  const days = [d(6, 1), d(6, 2), d(6, 3), d(6, 4), d(6, 5), d(6, 8), d(6, 9), d(6, 10), d(6, 11), d(6, 12), d(6, 15)];
  const adjusted = bars(days, days.map((t) => (t < d(6, 10) ? 25 : 26)));
  const raw = bars(days, days.map((t) => (t < d(6, 10) ? 100 : 26)));
  const S = follow('A', 1, days, 2_500, one(d(6, 2), 100, 25), adjusted);
  const r = matchFills([S], [buy(d(6, 2), 25, 100)], { from: d(6, 1), capital: 2_500, last: { SPY: 26 }, raw: rawPrices(new Map(), new Map([['SPY', raw]]), new Set(['SPY'])) });
  assert.deepEqual(r.rows.map((x) => [x.class, x.model!.quantity, x.model!.value, x.model!.price, x.yours!.quantity]), [['on time', 25, 2500, 100, 25]]);
  assert.equal(r.total, 0);
  // Not followed, the trade not made counts in the run's own money: 100 shares from 25 to 26.
  const skipped = matchFills([S], [], { from: d(6, 1), capital: 2_500, last: { SPY: 26 }, raw: rawPrices(new Map(), new Map([['SPY', raw]]), new Set(['SPY'])) });
  assert.deepEqual(skipped.rows.map((x) => [x.class, x.model!.quantity, x.skipped]), [['skipped', 25, 100]]);
});

test("lateness is counted in trading days, whatever the strategy's bars are, and said so", () => {
  // A weekly strategy buys at Monday June 1's open; without prices as traded, the days counted are Monday to Friday.
  const weeks = [d(5, 25), d(6, 1), d(6, 8), d(6, 15), d(6, 22), d(6, 29), d(7, 6), d(7, 13)];
  const S = follow('W', 1, weeks, 10_000, one(d(6, 1), 100, 100));
  const at = (day: number) => matchFills([S], [buy(day, 100, 100)], { from: d(5, 30), capital: 10_000, last: { SPY: 100 } }).rows;
  const next = at(d(6, 2));
  assert.deepEqual(next.map((x) => [x.class, x.daysLate]), [['late', 1]]);
  assert.equal(matchCells(next[0])[2], 'Late by 1 trading day');
  // June 8 is the fifth weekday after June 1, and June 9 the sixth.
  assert.deepEqual(at(d(6, 8)).map((x) => [x.class, x.daysLate]), [['late', 5]]);
  assert.deepEqual(at(d(6, 9)).map((x) => x.class), ['skipped', 'off-plan']);
  // A trade in the last week of the data waits only until 5 trading days have passed.
  const end = follow('W', 1, [d(6, 1), d(6, 8)], 10_000, one(d(6, 1), 100, 100));
  assert.deepEqual(matchFills([end], [], { from: d(5, 30), capital: 10_000, last: { SPY: 100 } }).rows.map((x) => x.class), ['skipped']);
  // Trading days come from the prices as traded where they were loaded, else from a strategy's own daily bars.
  const daily = { label: 'D', alloc: 1, out: { spec: { universe: [{ name: 'BTCUSDT', source: 'binance', id: 'BTCUSDT' }], fill: 'next open' }, data: new Map([['BTCUSDT', bars([d(6, 6), d(6, 7)], [1, 1])]]), prices: [], backtest: { run: { t: [], equity: [], fills: none } } } } as unknown as Parameters<typeof fillsSetup>[0][number];
  const yahoo = { ...daily, out: { ...daily.out, spec: { universe: [{ name: 'SPY', source: 'yahoo', id: 'SPY' }], fill: 'next open' }, data: new Map([['SPY', WEEKLY]]), prices: [{ name: 'SPY', source: 'yahoo' }] } } as typeof daily;
  const setup = fillsSetup([daily, yahoo]);
  assert.deepEqual(tradingDays(setup, new Map([['SPY', RAW]])), { BTCUSDT: [d(6, 6), d(6, 7)], SPY: DAYS });
  assert.deepEqual(tradingDays(setup, new Map()), { BTCUSDT: [d(6, 6), d(6, 7)] });
});

test("each strategy keeps its own bars and whether it fills at the close", () => {
  const run = (label: string, b: Bars, fill: string) =>
    ({ label, alloc: 0.5, out: { spec: { universe: [{ name: 'SPY', source: 'yahoo', id: 'SPY' }], fill }, data: new Map([['SPY', b]]), prices: [], backtest: { run: { t: b.t, equity: b.t.map(() => 1), fills: none } } } }) as unknown as Parameters<typeof fillsSetup>[0][number];
  const setup = fillsSetup([run('W', WEEKLY, 'next open'), run('D', DAILY, 'close')]);
  assert.deepEqual(setup.followed.map((f) => [f.bars!.get('SPY'), f.closeFill]), [
    [WEEKLY, false],
    [DAILY, true],
  ]);
});

test('a fills columns header with a +, a ; or a quote is written in quotes and reads back as it was', () => {
  const columns = { date: 'Trade Date', ticker: 'The "Symbol"', side: 'Buy;Sell', quantity: 'Qty', price: 'Price (USD)', fees: ['Comm+Fees', 'Reg. fee'] };
  const text = fillColumnsText(columns);
  assert.equal(text, 'date = Trade Date; ticker = "The ""Symbol"""; side = "Buy;Sell"; quantity = Qty; price = Price (USD); fees = "Comm+Fees" + Reg. fee');
  assert.deepEqual(parseFillColumns(text), columns);
  assert.deepEqual(parseFillColumns('fees = "A + B"+C; price = "Px"'), { fees: ['A + B', 'C'], price: 'Px' });
  assert.equal(parseFillColumns('price = "Px'), 'A header in quotation marks must have a closing quotation mark: "Px');
});
