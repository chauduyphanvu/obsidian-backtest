import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { BORROW_FEE, MARGIN_RATE, parseSpec, RESERVED } from '../src/dsl.ts';
import { insideKey, type ExitWhy, type Trade } from '../src/engine.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY, near, T0 } from './helpers.ts';

const HOUR = 3_600_000;
const day = (n: number) => T0 + n * DAY;

function run(src: string, data: Record<string, Bars>): Backtest {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  return runBacktest(spec!, new Map(Object.entries(data)));
}
/** Bars with the given [open, high, low, close] rows, daily from day 0, or at `times`. */
function ohlc(rows: number[][], times = rows.map((_, n) => day(n)), volumes?: number[]): Bars {
  return { t: times, o: rows.map((r) => r[0]), h: rows.map((r) => r[1]), l: rows.map((r) => r[2]), c: rows.map((r) => r[3]), v: volumes ?? rows.map(() => 1000) };
}
const flat = (n: number, price = 100) => ohlc(Array.from({ length: n }, () => [price, price, price, price]));
const errorsOf = (src: string) => parseSpec(src).errors.map((e) => e.message);

// ------------------------------------------------------------------ hand-worked cases

test('a short pays its borrow fee on the value at each close, and its return is measured on what it brought in', () => {
  // Shorted at day 1's open of 100 (100 shares), covered at day 3's open of 80. The fee runs over two nights, on 9,000 and 8,000.
  const bt = run('universe: A\ncapital: 10000\nborrow fee: 0.5%\nshort when close >= 100\ncover when close < 85', { A: bars([100, 90, 80, 80]) });
  const { run: r } = bt;
  const fees = (9000 + 8000) * (0.005 / 365);
  assert.ok(near(fees, 0.232877, 1e-6));
  assert.ok(near(r.borrowFees!, fees, 1e-9));
  assert.equal(r.marginInterest, 0);
  assert.ok(near(r.equity.at(-1)!, 10000 + 10000 - 8000 - fees, 1e-9));
  assert.ok(near(r.equity.at(-1)!, 11999.767123, 1e-6));
  const [t] = r.trades;
  assert.deepEqual([t.side, t.entryT, t.entryPrice, t.exitT, t.exitPrice, t.reason], ['short', day(1), 100, day(3), 80, 'signal']);
  assert.ok(near(t.ret, (100 - 80 - fees / 100) / 100, 1e-12));
  assert.ok(near(t.ret, 0.19997671, 1e-8));
  assert.ok(near(t.borrow!, fees, 1e-12) && near(t.pnl, 2000 - fees, 1e-9));
  assert.deepEqual([r.fills.kind, r.fills.sharesAfter], [['entry', 'sell'], [-100, 0]]);
  // Equity at each close: cash less the shares bought back at the close.
  assert.ok(near(r.equity[1], 20000 - 9000, 1e-9) && near(r.equity[2], 20000 - (9000 * 0.005) / 365 - 8000, 1e-9));
  assert.equal(r.states[0].side, null);
  assert.deepEqual([r.exposure[1], r.netExposure![1]], [9000 / 11000, -9000 / 11000]);
});

test('a flip with fill: close sells the long and shorts at the same close, the short capped by the room the sale leaves', () => {
  const src = 'universe: A\ncapital: 10000\nfill: close\nslippage: 10 bps\nborrow fee: 0%\nbuy when close > 100\nshort when close < 100';
  const { run: r } = run(src, { A: bars([101, 99, 98]) });
  const n = 10000 / (101 * 1.001);
  assert.ok(near(n, 98.91099, 1e-6));
  const proceeds = n * 99 * 0.999;
  assert.ok(near(proceeds, 9782.395, 1e-3));
  // Sized at 100% of the equity before the sale (n × 99), the short is capped by the room after it: the proceeds.
  assert.deepEqual(r.fills.kind, ['entry', 'sell', 'entry']);
  assert.deepEqual([r.fills.t[1], r.fills.t[2]], [day(1), day(1)]);
  assert.ok(r.fills.sharesAfter[1] === 0 && near(r.fills.sharesAfter[2], -n, 1e-9));
  assert.ok(near(r.equity[1], 2 * proceeds - n * 99, 1e-9) && near(r.equity[1], 9772.6, 0.01));
  assert.ok(near(r.equity[2], 2 * proceeds - n * 98, 1e-9) && near(r.equity[2], 9871.51, 0.01));
  const [long, short] = r.trades;
  assert.deepEqual([long.reason, long.side, (long.why!.exit as Extract<ExitWhy, { k: 'rule' }>).flip], ['signal', undefined, true]);
  assert.deepEqual([short.side, short.reason, short.entryT], ['short', 'open', day(1)]);
  // At the last close, the state says what the flip filled: the short and the long it closed.
  const end = run(src, { A: bars([101, 99]) }).run.states[0];
  assert.equal(end.side, 'short');
  assert.equal(end.filled!.side, 'short');
  assert.ok(near(end.filled!.shares, n, 1e-9) && near(end.filled!.closed!, n, 1e-9) && near(end.filled!.price, 99 * 0.999, 1e-12));
});

test('a short\'s stop sits above its entry and its target below; a gap fills at the open, and it trails from the lowest low', () => {
  const levels = 'universe: A\nshort when close == 100\nstop loss: 5%\ntake profit: 10%\ntrailing stop: 5%';
  /** The first trade, shorted at day 1's open of 100 after a flat day, with `bar` the day after. */
  const first = (bar: number[], extra = '', more: Record<string, Bars> = {}): Trade =>
    run(levels + extra, { A: ohlc([[100, 100, 100, 100], [100, 100, 100, 100], bar, [95, 95, 95, 95]]), ...more }).run.trades[0];
  const level = (t: Trade) => t.why!.exit as Extract<ExitWhy, { k: 'level' }>;
  let t = first([108, 110, 107, 109]);
  assert.deepEqual([t.side, t.entryPrice, t.why!.stopLoss, t.why!.takeProfit], ['short', 100, 105, 90]);
  assert.deepEqual([t.exitT, t.exitPrice, t.reason, level(t).atOpen], [day(2), 108, 'stop loss', true]);
  t = first([102, 106, 101, 104]);
  assert.deepEqual([t.exitPrice, t.reason, level(t).atOpen], [105, 'stop loss', false]);
  t = first([88, 106, 87, 95]);
  assert.deepEqual([t.exitPrice, t.reason, level(t).atOpen], [88, 'take profit', true]);
  // Both levels inside the bar: the stop first, unless magnify finds the low came first.
  t = first([100, 106, 89, 95]);
  assert.deepEqual([t.exitPrice, t.reason], [105, 'stop loss']);
  const inside = { [insideKey('A', '1h')]: ohlc([[100, 100, 89, 90], [90, 106, 90, 95]], [day(2) + 14.5 * HOUR, day(2) + 15.5 * HOUR]) };
  t = first([100, 106, 89, 95], '\nmagnify: 1h', inside);
  assert.deepEqual([t.exitPrice, t.reason, level(t).inside], [90, 'take profit', { k: 'inside', t: day(2) + 14.5 * HOUR }]);
  // The trailing level follows the lows, 97 then 95, to 95 × 1.05.
  const trail = run(levels, { A: ohlc([[100, 100, 100, 100], [100, 100, 97, 98], [98, 99, 95, 96], [98, 100, 97, 99], [99, 99, 99, 99]]) });
  t = trail.run.trades[0];
  assert.deepEqual([t.exitT, t.reason, level(t).high, level(t).atOpen], [day(3), 'trailing stop', 95, false]);
  assert.ok(near(t.exitPrice, 99.75, 1e-12) && near(level(t).level, 99.75, 1e-12));
  // An open short reports its levels as prices: the stop above, the target below.
  const open = run(levels, { A: ohlc([[100, 100, 100, 100], [100, 100, 98, 99], [99, 99, 96, 97]]) }).run.states[0];
  assert.equal(open.side, 'short');
  assert.ok(open.shares < 0 && near(open.levels!.stop!, 96 * 1.05, 1e-12) && open.levels!.target === 90);
  assert.deepEqual(open.pos, { entryIdx: 1, entryPrice: 100, lastPrice: 100, entries: 1 });
});

test('a 150% long borrows a third of its value and pays the margin rate on it, and its cash earns nothing meanwhile', () => {
  // Bought at day 1's open; the 365 nights after it each charge a day's interest on what is owed.
  const A = flat(367);
  const r = run('universe: A 150%\ncapital: 10000\nmargin rate: 6%\nbuy when true', { A }).run;
  const owed = 5000 * (1 + 0.06 / 365) ** 365;
  assert.ok(near(owed, 5309.16, 0.005));
  assert.ok(near(r.equity.at(-1)!, 15000 - owed, 1e-6) && near(r.equity.at(-1)!, 9690.84, 0.005));
  assert.ok(near(r.marginInterest!, owed - 5000, 1e-6));
  assert.deepEqual([r.exposure[1], r.borrowFees, r.interest], [1.5, 0, 0]);
  // With a cash rate, cash earns only the night before the buy: nothing while the balance is below 0.
  const paid = run('universe: A 150%\ncapital: 10000\ncash rate: 2%\nbuy when true', { A }).run;
  assert.ok(near(paid.interest, (10000 * 0.02) / 365, 1e-9));
  assert.ok(paid.marginInterest! > 300);
});

test('long one ticker and short another at 100% each: the borrow fee, and the margin rate only once the fees are owed', () => {
  const src = (rate: string) => `universe: A 100%, B 100%\ncapital: 10000\nmargin rate: ${rate}\nfor A:\n  buy when true\nfor B:\n  short when true`;
  const data = { A: flat(367), B: flat(367) };
  const free = run(src('0%'), data).run;
  assert.deepEqual(free.states.map((s) => s.side), ['long', 'short']);
  assert.ok(near(free.equity.at(-1)!, 9950, 1e-6) && near(free.borrowFees!, 50, 1e-6));
  assert.deepEqual([free.exposure[1], free.netExposure![1]], [2, 0]);
  // At 6% the balance (cash less the short) starts at 0 and falls by each day's fee, which then pays interest.
  let cash = 10000;
  for (let k = 0; k < 365; k++) {
    const balance = cash - 10000;
    if (balance < 0) cash -= (-balance * 0.06) / 365;
    cash -= (10000 * 0.005) / 365;
  }
  const paid = run(src('6%'), data).run;
  assert.ok(near(paid.equity.at(-1)!, cash, 1e-6));
  assert.ok(near(paid.equity.at(-1)!, 9948.5, 0.05), `${paid.equity.at(-1)}`);
});

test('a margin call closes everything at the next open, even with fill: close, and both sides must re-arm', () => {
  // 200 shares bought at 100 with 10,000. At 70 equity is 28.6% of the 14,000 held; at 66 it is 24.2%, so the next open sells.
  const A = ohlc([[100, 100, 100, 100], [100, 100, 70, 70], [70, 70, 66, 66], [65, 65, 60, 60], [60, 70, 60, 70]]);
  for (const fill of ['', '\nfill: close']) {
    const r = run(`universe: A 200%\ncapital: 10000\nmargin rate: 0%${fill}\nbuy when true`, { A }).run;
    assert.equal(r.marginCalls, 1);
    const [t] = r.trades;
    assert.deepEqual([t.exitT, t.exitPrice, t.reason, t.ret], [day(3), 65, 'margin call', -0.35]);
    assert.deepEqual(t.why!.exit, { k: 'margin', t: day(2), equity: 3200, gross: 13200 });
    assert.ok(near(r.equity[3], 3000, 1e-9) && r.equity[4] === 3000);
    assert.equal(r.fills.kind.at(-1), 'margin');
    // buy when true never stops holding, so the long is never armed again.
    assert.deepEqual([r.trades.length, r.states[0].rearming, r.states[0].pending], [1, true, null]);
  }
});

test('ruin: equity at 0 or below closes everything, and the run is over with its equity at 0', () => {
  const at = (open: number) => ohlc([[100, 100, 100, 100], [100, 100, 70, 70], [70, 70, 66, 66], [open, 65, open, 60], [60, 80, 60, 80], [80, 90, 80, 90]]);
  const bt = run('universe: A 200%\ncapital: 10000\nmargin rate: 0%\nbuy when true', { A: at(45) });
  const r = bt.run;
  // 200 shares at 45 are worth 9,000 against 10,000 owed: 1,000 short, and the margin call never gets to fill.
  assert.deepEqual(r.ruin, { t: day(3), deficit: 1000 });
  assert.deepEqual(r.equity.slice(3), [0, 0, 0]);
  assert.deepEqual(r.exposure.slice(3), [0, 0, 0]);
  assert.deepEqual(r.trades.map((t) => [t.exitT, t.exitPrice, t.reason]), [[day(3), 45, 'ruin']]);
  assert.deepEqual(r.trades[0].why!.exit, { k: 'ruin', t: day(3), equity: -1000 });
  assert.equal(r.marginCalls, 1);
  assert.ok(r.fills.t.every((t) => t <= day(3)));
  assert.deepEqual([bt.stats.totalReturn, bt.stats.cagr, bt.stats.maxDrawdown], [-1, -1, -1]);
  assert.ok(Number.isFinite(bt.stats.volatility) && Number.isFinite(bt.stats.sharpe));
  // An open of 50 leaves exactly nothing: that is ruin too.
  assert.deepEqual(run('universe: A 200%\ncapital: 10000\nmargin rate: 0%\nbuy when true', { A: at(50) }).run.ruin, { t: day(3), deficit: 0 });
});

test('when the buy and short rules both hold, neither side opens and the bar is counted', () => {
  const bt = run('universe: A\nbuy when true\nshort when true', { A: flat(5) });
  assert.deepEqual([bt.run.trades.length, bt.run.conflicts, bt.run.fills.t.length], [0, 5, 0]);
  assert.ok(bt.notes.includes('Buy and short rules both held on 5 bars, so neither opened a position.'));
  // A sell rule that holds vetoes the long, so the short opens alone.
  assert.equal(run('universe: A\nbuy when true\nsell when true\nshort when true', { A: flat(5) }).run.trades[0].side, 'short');
});

test('rebalancing a 50% short covers some when the price rises and shorts more when it falls', () => {
  // Shorted 50 shares on Thursday 2 January at 100; the week turns on Monday 6 January, which opens at 120 or 80.
  const week = (open: number) => ohlc([...Array.from({ length: 5 }, () => [100, 100, 100, 100]), [open, open, open, open]]);
  const src = 'universe: A 50%\ncapital: 10000\nborrow fee: 0%\nrebalance: weekly\nshort when true';
  const up = run(src, { A: week(120) }).run;
  assert.deepEqual([up.fills.kind, up.fills.sharesAfter], [['entry', 'trim'], [-50, -37.5]]);
  const down = run(src, { A: week(80) }).run;
  assert.deepEqual([down.fills.kind, down.fills.sharesAfter], [['entry', 'rebalance'], [-50, -68.75]]);
  assert.deepEqual([up.trades[0].why!.trims, down.trades[0].why!.topUps], [1, 1]);
});

test('after a stop, a side re-arms whenever it is not held: the buy rule clears during a short, and the long comes back', () => {
  // The long bought at 105 is stopped at 94.5 on day 2 with the buy rule still holding. On day 3 high volume makes the sell
  // rule veto the long and the short rule hold, so it shorts on day 4. That day the buy rule stops holding, which re-arms
  // the long; on day 5 it holds again, which covers the short and buys at day 6's open.
  const rows = [[105, 105, 105, 105], [105, 106, 104, 105], [105, 105, 90, 101], [101, 102, 101, 102], [102, 103, 98, 99], [99, 104, 99, 103], [103, 104, 103, 104]];
  const volume = [1000, 1000, 1000, 9000, 3000, 3000, 3000];
  const src = 'universe: A\nstop loss: 10%\nbuy when close > 100\nsell when volume > 5000\nshort when volume > 5000\ncover when volume < 2000';
  const r = run(src, { A: ohlc(rows, undefined, volume) }).run;
  assert.deepEqual(
    r.trades.map((t) => [t.side ?? 'long', t.entryT, t.exitT, t.reason]),
    [['long', day(1), day(2), 'stop loss'], ['short', day(4), day(6), 'signal'], ['long', day(6), day(6), 'open']],
  );
  assert.equal((r.trades[1].why!.exit as Extract<ExitWhy, { k: 'rule' }>).flip, true);
  // The buy that came back was signalled the bar after the buy rule cleared, so it says so.
  assert.deepEqual(r.trades[2].why!.rearm, { exitT: day(2), heldT: day(3), clearedT: day(4) });
  assert.deepEqual([r.fills.kind.slice(-2), r.fills.t.slice(-2)], [['sell', 'entry'], [day(6), day(6)]]);
  // Had the buy rule not cleared during the short, the long would still wait to re-arm.
  const held = run(src, { A: ohlc(rows.map((x, i) => (i === 4 ? [102, 103, 101, 101] : x)), undefined, volume) }).run;
  assert.deepEqual(held.trades.map((t) => [t.side ?? 'long', t.reason]), [['long', 'stop loss'], ['short', 'signal']]);
  assert.deepEqual([held.states[0].side, held.states[0].rearming], [null, true]);
});

test('the benchmark of a block that borrows holds its tickers long, scaled to 100%', () => {
  const A = bars([100, 110, 121, 133.1]);
  const bt = run('universe: A 200%\ncapital: 1000\nmargin rate: 0%\nbuy when true', { A });
  assert.deepEqual(bt.benchmark.equity.map((e) => Math.round(e * 1e6) / 1e6), [1000, 1100, 1210, 1331]);
  assert.ok(near(bt.run.equity.at(-1)!, 1000 + 20 * 33.1 - 0, 1e-9));
  const short = run('universe: A\nshort when true', { A });
  assert.deepEqual(short.benchmark.equity.map((e) => Math.round(e * 1e6) / 1e6), [1e4, 1.1e4, 1.21e4, 1.331e4]);
});

// ------------------------------------------------------------------ the language

test('short and cover rules: heads, position values, short-only blocks and the margin they bring', () => {
  const ok = (src: string) => {
    const { spec, errors } = parseSpec(src);
    assert.deepEqual(errors, []);
    return spec!;
  };
  // Long-only within 100% carries no margin at all.
  assert.ok(!('margin' in ok('universe: SPY 60%, TLT 40%\nbuy when true')));
  const s = ok('universe: SPY\nshort when close < sma(200)\ncover when bars held > 20');
  assert.deepEqual(s.rules.SPY.buy, { k: 'bool', v: false });
  assert.equal(s.rules.SPY.sell, null);
  assert.equal(s.rules.SPY.short!.k, 'cmp');
  assert.equal(s.written!.rules.SPY.buy, null);
  assert.equal(s.written!.rules.SPY.short!.text, 'close < sma(200)');
  assert.equal(s.written!.rules.SPY.cover!.text, 'bars held > 20');
  assert.deepEqual(s.margin, { cap: 1, borrowFee: BORROW_FEE, rate: MARGIN_RATE, maintenance: 0.25 });
  assert.deepEqual([BORROW_FEE, MARGIN_RATE], [0.005, 0.06]);
  // Rule heads are read in any case. short and cover stay free as parameter names, as strategies written before shorts
  // use them (sma(short) > sma(long)), and a rule head and a parameter of the same name live side by side.
  assert.ok(ok('universe: SPY\nSHORT WHEN close < 1\nCover When close > 2').rules.SPY.cover);
  assert.ok(!RESERVED.has('short') && !RESERVED.has('cover'));
  const crossover = ok('universe: SPY\nshort = 20\nlong = 50\nbuy when sma(short) > sma(long)\nsell when sma(short) < sma(long)');
  assert.deepEqual([crossover.rules.SPY.short ?? null, crossover.margin ?? null], [null, null]);
  const both = ok('universe: SPY\nshort = 20\ncover = 50\nshort when close < sma(short)\ncover when close > sma(cover)');
  assert.deepEqual([both.written!.rules.SPY.short!.text, both.written!.rules.SPY.cover!.text], ['close < sma(short)', 'close > sma(cover)']);
  // A short rule reads no position, as a buy rule does; a cover rule can.
  assert.match(errorsOf('universe: SPY\nshort when bars held > 1')[0], /"bars held" only makes sense in a sell, cover or add rule/);
  assert.match(errorsOf('universe: SPY\nbuy when true\ncover when close > 1')[0], /"cover when" closes a short, so it needs a short rule that says when to go short/);
  assert.match(errorsOf('universe: SPY, QQQ\nfor SPY:\n  buy when true\nfor QQQ:\n  short when true\n  cover when true\nfor all:\ncover when close > 1\nbuy when true').join('\n'), /needs a short rule for SPY/);
  assert.match(errorsOf('universe: SPY\nshort when true\nshort when false')[0], /There is already a short rule/);
  // A ticker needs a buy rule or a short rule.
  assert.match(errorsOf('universe: SPY, QQQ\nfor SPY:\n  short when true')[0], /There is no buy rule for QQQ/);
  // A rule with the wrong head says what heads there are.
  assert.match(errorsOf('universe: SPY\nsell short when true\nbuy when true')[0], /Rules start with "buy when", "sell when", "short when" or "cover when"/);
});

test('weights and size up to 200%, the margin terms, and their settings', () => {
  const spec = (src: string) => parseSpec(src).spec;
  assert.deepEqual(spec('universe: SPY 150%, TLT 50%\nbuy when true')!.margin, { cap: 2, borrowFee: 0.005, rate: 0.06, maintenance: 0.25 });
  assert.equal(spec('universe: SPY 80%, TLT 40%\nbuy when true')!.margin!.cap, 0.8 + 0.4);
  assert.deepEqual(spec('universe: SPY, TLT\nsize: 150%\nbuy when true')!.universe.map((a) => a.weight), [0.75, 0.75]);
  assert.equal(spec('universe: SPY, TLT\nsize: 150%\nbuy when true')!.margin!.cap, 1.5);
  // A short below 100% still borrows its shares, so its cap is 1.
  assert.equal(spec('universe: SPY 50%\nshort when true')!.margin!.cap, 1);
  assert.match(errorsOf('universe: SPY 150%, TLT 60%\nbuy when true')[0], /^Weights add up to 210\.0%\. The most is 200%/);
  assert.match(errorsOf('universe: SPY, TLT\nsize: 201%\nbuy when true')[0], /size must be a percentage/);
  // A ranking can hold more than its equity, but not go short yet.
  const ranked = spec('universe: SPY, QQQ, TLT\nsize: 150%\nhold: top 2 by roc(20)')!;
  assert.deepEqual([ranked.universe[0].weight, ranked.margin!.cap], [0.75, 1.5]);
  assert.match(errorsOf('universe: SPY, QQQ\nhold: top 1 by roc(20)\nshort when true')[0], /^A ranking can't also go short yet; /);
  assert.deepEqual(parseSpec('universe: SPY, QQQ\nhold: top 1 by roc(20)\nbuy when true\nshort when true').errors.map((e) => e.line), [4]);
  // The rates: per block, then the defaults, then the built-in ones; only a block that borrows carries them.
  const m = spec('universe: SPY\nborrow fee: 1%\nmargin rate: 7.5%\nshort when true')!.margin!;
  assert.deepEqual([m.borrowFee, m.rate], [0.01, 0.075]);
  const d = parseSpec('universe: SPY\nshort when true', { defaults: { borrowFee: 0.02, marginRate: 0.04 } }).spec!.margin!;
  assert.deepEqual([d.borrowFee, d.rate], [0.02, 0.04]);
  assert.equal(spec('universe: SPY\nborrow fee: 0%\nmargin rate: 0%\nshort when true')!.margin!.borrowFee, 0);
  assert.ok(!('margin' in spec('universe: SPY\nborrow fee: 1%\nbuy when true')!));
  assert.match(errorsOf('universe: SPY\nborrow fee: 1\nshort when true')[0], /^Write the borrow fee as a yearly percentage, such as 0\.5%/);
  assert.match(errorsOf('universe: SPY\nmargin rate: 51%\nshort when true')[0], /^The margin rate must be between 0% and 50% a year/);
  assert.match(errorsOf('universe: SPY\nborrow fee: 101%\nshort when true')[0], /^The borrow fee must be between 0% and 100% a year/);
});

test('a percentage take profit of 100% or more is flagged where a short can never reach it', () => {
  const warned = (src: string) => parseSpec(src).warnings.map((w) => [w.line, w.message]);
  assert.deepEqual(warned('universe: SPY\ntake profit: 150%\nbuy when true\nshort when false'), [
    [2, "A short can't reach a take profit of 150%: the price would have to fall to 0 or below, so its shorts never take profit. Use one under 100%, or a multiple of the average true range"],
  ]);
  assert.deepEqual(warned('universe: SPY\ntake profit: 150%\nbuy when true'), []);
  assert.deepEqual(warned('universe: SPY\ntake profit: 90%\nshort when true'), []);
  assert.deepEqual(warned('universe: SPY, QQQ\nfor QQQ:\n  take profit: 100%\nshort when true').map(([l]) => l), [3]);
});

test('a margin call is not held open by a ticker whose prices have ended, so a later one is still made', () => {
  const px = (cs: number[]) => ohlc(cs.map((c, i) => { const o = i ? cs[i - 1] : c; return [o, Math.max(o, c), Math.min(o, c), c]; }));
  // A's prices end on day 2. B rallies into a margin call at day 3's close, is covered at day 4's open, re-arms above
  // 100, is shorted again at day 6's open and rallies until a second margin call.
  const A = px([100, 100, 100]);
  const B = px([90, 90, 90, 135, 105, 95, 90, 99, 110, 120, 130, 140, 150, 160]);
  const r = run('universe: A 10%, B 150%\ncapital: 10000\nborrow fee: 0%\nmargin rate: 0%\nfor A:\n  short when true\nfor B:\n  short when close < 100\n  cover when close > 400', { A, B }).run;
  assert.equal(r.marginCalls, 2);
  assert.equal(r.ruin, null);
  assert.deepEqual(r.trades.map((t) => [t.asset, t.reason]), [['B', 'margin call'], ['A', 'open'], ['B', 'margin call']]);
  // A can't be closed, so it is not reported as closing at the next open either.
  assert.deepEqual([r.states[0].side, r.states[0].pending, r.states[0].marginCall], ['short', null, undefined]);
});

test('a position in a ticker whose prices have ended does not set off a margin call at every close', () => {
  // A is shorted at 100 and its prices end at 180; B is bought at 100. At day 2's close equity is 2,000 against 28,000
  // held: the call sells B at day 3's open. A's short still leaves equity under 25% of what is held, but nothing left
  // can be closed, so no more calls are made.
  const A = ohlc([[100, 100, 100, 100], [100, 100, 100, 100], [100, 180, 100, 180]]);
  const B = flat(12);
  const r = run('universe: A 100%, B 100%\ncapital: 10000\nborrow fee: 0%\nmargin rate: 0%\nfor A:\n  short when true\nfor B:\n  buy when close > 50', { A, B }).run;
  assert.equal(r.marginCalls, 1);
  assert.deepEqual(r.trades.map((t) => [t.asset, t.reason, t.exitT]), [['B', 'margin call', day(3)], ['A', 'open', day(11)]]);
});

test('a ruined run averages its exposure over the bars before the ruin', () => {
  const at = ohlc([[100, 100, 100, 100], [100, 100, 70, 70], [70, 70, 66, 66], [45, 65, 45, 60], [60, 80, 60, 80], [80, 90, 80, 90]]);
  const bt = run('universe: A 200%\ncapital: 10000\nmargin rate: 0%\nbuy when true', { A: at });
  const ex = bt.run.exposure;
  assert.deepEqual(ex.slice(3), [0, 0, 0]);
  assert.ok(Math.abs(bt.stats.exposure - (ex[0] + ex[1] + ex[2]) / 3) < 1e-12, `${bt.stats.exposure}`);
});
