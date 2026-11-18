// "Explaining a trade" for a short, a flip and a block that borrows: the mirrored words, levels and return, and the forced
// closes of a margin call and a ruin.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import type { Trade } from '../src/engine.ts';
import { explainTrade, type Explanation, type Row, type Section } from '../src/explain.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY, near, T0 } from './helpers.ts';

function run(src: string, data: Record<string, Bars>): Backtest {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  return runBacktest(spec!, new Map(Object.entries(data)));
}
const day = (n: number) => T0 + n * DAY;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
function ohlc(rows: number[][]): Bars {
  return { t: rows.map((_, n) => day(n)), o: rows.map((r) => r[0]), h: rows.map((r) => r[1]), l: rows.map((r) => r[2]), c: rows.map((r) => r[3]), v: rows.map(() => 1000) };
}
const section = (ex: Explanation, id: Section['id']) => ex.sections.find((s) => s.id === id)!.rows;
const table = (ex: Explanation, id: Section['id']) => section(ex, id).map((r) => [r.label, r.value, r.outcome, r.depth]);
const find = (ex: Explanation, id: Section['id'], label: string | RegExp): Row => {
  const hit = section(ex, id).find((r) => (typeof label === 'string' ? r.label === label : label.test(r.label)));
  assert.ok(hit, `no row ${label} in ${id}: ${JSON.stringify(table(ex, id))}`);
  return hit;
};
const titles = (ex: Explanation) => ex.sections.map((s) => s.title);
const RETURN = 'A short is measured on what it brought in a share, less what covering it cost and its borrow fees, over what it brought in';

test('a short: why it was shorted and covered, what it took in, and its return with the borrow fees', () => {
  // Shorted at day 1's open of 100 (100 shares), covered at day 3's open of 80. The fee runs over two nights, on 90 and 80.
  const bt = run('universe: A\ncapital: 10000\nborrow fee: 0.5%\nshort when close >= 100\ncover when close < 85', { A: bars([100, 90, 80, 80]) });
  const [t] = bt.run.trades;
  const ex = explainTrade(bt, t);
  const perShare = ((90 + 80) * 0.005) / 365;
  assert.equal(ex.title, 'A: shorted 2020-01-02 at 100.00, covered 2020-01-04 at 80.00');
  assert.deepEqual(titles(ex), ['Why it was shorted', 'How much', 'Why it was covered', 'Result']);
  assert.deepEqual(table(ex, 'bought'), [
    ['The short rule was read at the close of 2020-01-01.', '', null, 0],
    ['short when close >= 100', 'close 100 ≥ 100', 'yes', 0],
  ]);
  assert.deepEqual(table(ex, 'size'), [
    ['Portfolio value at the open of 2020-01-02', '$10,000.00', null, 0],
    ['Weight', '100% of that: $10,000.00', null, 0],
    ['Money taken in', '$10,000.00, for 100 shares sold short', null, 0],
    ['Filled at the open of 2020-01-02', '100.00; the close the rule read was 100.00', null, 0],
  ]);
  assert.deepEqual(table(ex, 'sold'), [
    ['The cover rule was read at the close of 2020-01-03.', '', null, 0],
    ['cover when close < 85', 'close 80 < 85', 'yes', 0],
    ['Covered at the open of 2020-01-04', '80.00', null, 0],
  ]);
  assert.deepEqual(table(ex, 'result'), [
    ['Return after costs', '+20.00%', null, 0],
    [RETURN, '(100.00 − 80.00 − 0.002329) ÷ 100.00', null, 0],
    ['Profit', '+$1,999.77', null, 0],
    ['Borrow fees', '$0.23, part of the profit', null, 0],
    ['Held', '2 bars, from 2020-01-02 to 2020-01-04', null, 0],
  ]);
  assert.ok(near(t.borrow! / 100, perShare, 1e-15));
  // The return is the engine's to the last bit, borrow fees included.
  assert.equal(ex.facts.ret, t.ret);
  assert.ok(near(ex.facts.ret, (100 - 80 - perShare) / 100, 1e-15));
  assert.deepEqual([ex.facts.buyRule, ex.facts.sellRule, ex.facts.entryPrice, ex.facts.exitPrice], ['yes', 'yes', 100, 80]);
});

test('slippage, costs and a commission make a short sale take in less and its cover pay more', () => {
  const src = 'universe: A\ncapital: 10000\nborrow fee: 1%\ncosts: 10 bps\nslippage: 20 bps\ncommission: 1 per order\nshort when close < 100\ncover when close > 120';
  const bt = run(src, { A: ohlc([[100, 100, 99, 99], [98, 99, 97, 98], [97, 97, 95, 125], [125, 125, 125, 125]]) });
  const [t] = bt.run.trades;
  const ex = explainTrade(bt, t);
  assert.equal(find(ex, 'size', 'Filled at the open of 2020-01-02').value, '98.00, less 20 bps slippage: 97.80; the close the rule read was 99.00');
  assert.match(find(ex, 'size', 'Money taken in').value, /^\$9,\d{3}\.\d\d less \$9\.\d\d costs and \$1\.00 commission, for \d+\.\d+ shares sold short$/);
  assert.equal(find(ex, 'sold', 'Covered at the open of 2020-01-04').value, '125.00, plus 20 bps slippage: 125.25');
  // The engine's formula: (entry × (1 − costs) − commission a share − exit × (1 + costs) − commission a share − borrow) / basis.
  assert.ok(near(ex.facts.ret, t.ret, 1e-15), `${ex.facts.ret} vs ${t.ret}`);
  assert.ok(t.ret < (97.8 - 125.25) / 97.8);
  assert.match(find(ex, 'result', RETURN).value, /^\(97\.\d\d − 125\.\d\d − 0\.\d+\) ÷ 97\.\d\d$/);
});

test('a short\'s stop sits above its fill: a gap through it covers at the open, a bar rising through it at the stop', () => {
  const src = 'universe: A\ncapital: 10000\nborrow fee: 0%\nstop loss: 10%\nshort when close < 100';
  const gap = run(src, { A: ohlc([[100, 100, 99, 99], [98, 99, 97, 98], [112, 115, 111, 114], [114, 114, 114, 114]]) });
  const g = explainTrade(gap, gap.run.trades[0]);
  assert.deepEqual(table(g, 'sold'), [
    ['Stop loss at 107.80', '10% over the 98.00 fill', null, 0],
    ['On 2020-01-03 the bar opened at 112.00, above the stop, so it was covered at the open.', '', null, 0],
    ['Covered at the open', '112.00', null, 0],
  ]);
  assert.deepEqual([g.facts.level, g.facts.exitPrice, g.facts.ret], [gap.run.trades[0].why!.stopLoss, 112, gap.run.trades[0].ret]);
  const inside = run(src, { A: ohlc([[100, 100, 99, 99], [98, 99, 97, 98], [100, 109, 99, 105], [105, 105, 105, 105]]) });
  const i = explainTrade(inside, inside.run.trades[0]);
  assert.equal(section(i, 'sold')[1].label, 'On 2020-01-03 the bar rose to 109.00, through the stop, so it was covered at the stop.');
  assert.deepEqual(table(i, 'sold')[2], ['Covered at the stop', '107.80', null, 0]);
  assert.equal(i.facts.exitPrice, inside.run.trades[0].exitPrice);
});

test('a short\'s target sits below its fill, and a gap through it covers at the open before the stop above', () => {
  const src = 'universe: A\ncapital: 10000\nborrow fee: 0%\ntake profit: 10%\nstop loss: 5%\nshort when close < 100';
  const within = run(src, { A: ohlc([[100, 100, 99, 99], [98, 99, 97, 98], [95, 96, 85, 90], [90, 90, 90, 90]]) });
  const w = explainTrade(within, within.run.trades[0]);
  assert.deepEqual(table(w, 'sold'), [
    ['Take profit at 88.20', '10% under the 98.00 fill', null, 0],
    ['On 2020-01-03 the bar fell to 85.00, through the target, so it was covered at the target.', '', null, 0],
    ['Covered at the target', '88.20', null, 0],
  ]);
  const gap = run(src, { A: ohlc([[100, 100, 99, 99], [98, 99, 97, 98], [80, 104, 79, 90], [90, 90, 90, 90]]) });
  const g = explainTrade(gap, gap.run.trades[0]);
  assert.deepEqual(table(g, 'sold').map((r) => r[0]), [
    'Take profit at 88.20',
    'On 2020-01-03 the bar opened at 80.00, below the target, so it was covered at the open.',
    'The bar later rose through the stop at 102.90 too, but the open came first.',
    'Covered at the open',
  ]);
  assert.equal(g.facts.ret, gap.run.trades[0].ret);
  // Both levels inside one bar that opened between them: the stop is taken first, as for a long.
  const both = run(src, { A: ohlc([[100, 100, 99, 99], [98, 99, 97, 98], [98, 104, 87, 90], [90, 90, 90, 90]]) });
  const b = explainTrade(both, both.run.trades[0]);
  assert.equal(both.run.trades[0].reason, 'stop loss');
  assert.equal(section(b, 'sold').at(-2)!.label, 'The take profit at 88.20 was inside this bar too. When both are, the stop is taken first.');
});

test('a short\'s trailing stop trails from the lowest low, above it, and the stop loss is the higher one', () => {
  const src = 'universe: A\ncapital: 10000\nborrow fee: 0%\ntrailing stop: 5%\nstop loss: 20%\nshort when close < 100';
  const bt = run(src, { A: ohlc([[100, 100, 99, 99], [98, 99, 97, 98], [97, 97, 95, 96], [96, 96, 93, 94], [95, 99, 94, 98], [98, 98, 98, 98]]) });
  const [t] = bt.run.trades;
  const ex = explainTrade(bt, t);
  assert.equal(t.reason, 'trailing stop');
  assert.deepEqual(table(ex, 'sold'), [
    ['Trailing stop at 97.65', '5% over 93.00, the lowest price from the short sale to the bar before', null, 0],
    ['The stop loss, at 117.60, was higher.', '', null, 0],
    ['On 2020-01-05 the bar rose to 99.00, through the stop, so it was covered at the stop.', '', null, 0],
    ['Covered at the stop', '97.65', null, 0],
  ]);
  assert.ok(near(ex.facts.level!, 93 * 1.05, 1e-12) && ex.facts.exitPrice === t.exitPrice && ex.facts.ret === t.ret);
  // On its first bar it trails from the open it was sold short at.
  const first = run(src, { A: ohlc([[100, 100, 99, 99], [98, 104, 97, 103], [103, 103, 103, 103]]) });
  assert.equal(find(explainTrade(first, first.run.trades[0]), 'sold', /^Trailing stop at/).value, '5% over 98.00, the open it was sold short at');
});

test('an ATR stop of a short is that many ATRs over the fill', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 - i * 0.2);
  const data = bars([...closes, 120, 120], { highs: [...closes.map((c) => c + 1), 125, 120], lows: [...closes.map((c) => c - 1), 99, 120] });
  const bt = run('universe: A\ncapital: 10000\nborrow fee: 0%\nstop loss: 2 atr(14)\nshort when close < sma(20)', { A: data });
  const t = bt.run.trades.find((x) => x.reason === 'stop loss')!;
  const ex = explainTrade(bt, t);
  const row = find(ex, 'sold', /^Stop loss at/);
  assert.match(row.value, /^2 × ATR\(14\) [\d.]+ \(at the close of [\d-]+\) = [\d.]+ over the [\d.]+ fill$/);
  assert.ok(near(ex.facts.level!, t.why!.stopLoss!, 1e-9) && ex.facts.level! > t.entryPrice);
});

test('a flip: the long is closed by the short rule, and the short says the same rule closed the long', () => {
  const src = 'universe: A\ncapital: 10000\nborrow fee: 0%\nbuy when close > 100\nshort when close < 100';
  const bt = run(src, { A: ohlc([[101, 101, 101, 101], [101, 102, 100, 102], [102, 102, 99, 99], [98, 98, 97, 97], [97, 97, 97, 97]]) });
  const [long, short] = bt.run.trades;
  const l = explainTrade(bt, long);
  assert.deepEqual(table(l, 'sold'), [
    ['The short rule was read at the close of 2020-01-03. It closes a long position.', '', null, 0],
    ['short when close < 100', 'close 99 < 100', 'yes', 0],
    ['So the position flipped: a short position was opened at the same fill.', '', null, 0],
    ['Sold at the open of 2020-01-04', '98.00', null, 0],
  ]);
  assert.deepEqual([l.facts.sellT, l.facts.sellRule], [day(2), 'yes']);
  const s = explainTrade(bt, short);
  assert.equal(s.title, 'A: shorted 2020-01-04 at 98.00, still held');
  assert.equal(section(s, 'bought')[2].label, 'The same rule closed the long position held until then, so the position flipped at the same fill.');
  assert.deepEqual(table(s, 'sold').slice(1), [['No order to cover it is waiting.', '', null, 0]]);
  assert.equal(find(s, 'result', 'A short still held counts the cost of covering at the last close in its return, without slippage.').value, '');
  // The other way, with fill: close: the buy rule closes the short.
  const back = run(`${src}\nfill: close`, { A: bars([99, 101]) });
  const c = explainTrade(back, back.run.trades[0]);
  assert.deepEqual(table(c, 'sold').map((r) => r[0]), [
    'The buy rule was read at the close of 2020-01-02. It closes a short position.',
    'buy when close > 100',
    'So the position flipped: a long position was opened at the same fill.',
    'Covered at the close of 2020-01-02, the close the rule read',
  ]);
});

test('a short still held: its cover rule at the last close, and the order waiting, a cover or a flip', () => {
  const cover = run('universe: A\nshort when true\ncover when close < 9', { A: bars([10, 10, 10, 8]) });
  const c = explainTrade(cover, cover.run.trades[0]);
  assert.deepEqual(table(c, 'sold').map((r) => r[0]), [
    'Still held at the end of the run. It is valued at the last close, 2020-01-04.',
    'The cover rule at the close of 2020-01-04:',
    'cover when close < 9',
    'An order to cover it is waiting for the next open.',
  ]);
  const flip = run('universe: A\nbuy when close > 100\nshort when close < 100', { A: bars([99, 99, 101]) });
  assert.equal(section(explainTrade(flip, flip.run.trades[0]), 'sold').at(-1)!.label, 'An order to cover it and buy is waiting for the next open.');
  const sell = run('universe: A\nbuy when close > 100\nshort when close < 100', { A: bars([101, 101, 99]) });
  assert.equal(section(explainTrade(sell, sell.run.trades[0]), 'sold').at(-1)!.label, 'An order to sell it and sell short is waiting for the next open.');
});

test('a short built in entries: each one sold short, the stop moved over the average', () => {
  const src = 'universe: A\ncapital: 10000\nborrow fee: 1%\nentries: 2\nstop loss: 10%\nshort when close < 100\nadd when close < last entry price\ncover when close > 120';
  const bt = run(src, { A: ohlc([[100, 100, 99, 99], [98, 99, 97, 98], [97, 97, 95, 95], [95, 95, 94, 94], [94, 94, 94, 94]]) });
  const [t] = bt.run.trades;
  const ex = explainTrade(bt, t);
  assert.equal(ex.title, 'A: shorted in 2 entries from 2020-01-02, at 96.47 on average, still held');
  assert.equal(find(ex, 'add', 'The stop loss moved to').value, '106.11, 10% over the average');
  assert.match(find(ex, 'add', 'Money taken in').value, /shares sold short$/);
  assert.equal(find(ex, 'result', 'Sold short in 2 entries of the 2 allowed').value, 'at 96.47 on average');
  assert.ok(near(ex.facts.ret, t.ret, 1e-12));
});

test('a margin call closes at the next open even with fill: close, and says how far equity fell', () => {
  const bt = run('universe: A 200%\ncapital: 10000\nmargin rate: 0%\nfill: close\nbuy when true', { A: ohlc([[100, 100, 100, 100], [100, 100, 70, 70], [70, 70, 66, 66], [65, 65, 60, 60], [60, 70, 60, 70]]) });
  const [t] = bt.run.trades;
  const ex = explainTrade(bt, t);
  assert.deepEqual(table(ex, 'sold'), [
    [
      'A margin call was made at the close of 2020-01-03: equity was below 25% of the value of the positions, long and short together, so every position was closed at the next open.',
      '$3,200.00 against $13,200.00, 24.24%',
      null,
      0,
    ],
    ['Sold at the open of 2020-01-04', '65.00', null, 0],
  ]);
  assert.deepEqual([ex.facts.exitPrice, ex.facts.ret], [t.exitPrice, t.ret]);
});

test('after a margin call the buy rule has to stop holding before it buys again, and the next buy says so', () => {
  const A = ohlc([[100, 100, 100, 100], [100, 100, 70, 70], [70, 70, 66, 66], [65, 65, 60, 60], [60, 70, 60, 70], [70, 70, 40, 40], [40, 60, 40, 60], [60, 60, 60, 60]]);
  const bt = run('universe: A 200%\ncapital: 10000\nmargin rate: 0%\nbuy when close > 50', { A });
  const [called, again] = bt.run.trades;
  assert.deepEqual([called.reason, again.why!.rearm], ['margin call', { exitT: day(2), heldT: day(4), clearedT: day(5) }]);
  assert.equal(
    section(explainTrade(bt, again), 'bought').at(-1)!.label,
    'After the margin call on 2020-01-03 the buy rule still held, last on 2020-01-05. After a margin call the rule has to stop holding before it can buy again: it did not hold on 2020-01-06, and held again at the next close.',
  );
});

test('a position a margin call made at the last close is closing waits for the next open, whatever the fill', () => {
  const bt = run('universe: A 200%\ncapital: 10000\nmargin rate: 0%\nfill: close\nbuy when true', { A: ohlc([[100, 100, 100, 100], [100, 100, 70, 70], [70, 70, 66, 66]]) });
  const ex = explainTrade(bt, bt.run.trades[0]);
  assert.equal(
    section(ex, 'sold').at(-1)!.label,
    'A margin call was made at the last close: equity was below 25% of the value of the positions, long and short together, so an order to sell it is waiting for the next open.',
  );
});

test('a ruin is priced where it was found: at a close when equity fell below 0 at the close, at the open when at the open', () => {
  const src = 'universe: A 200%\ncapital: 10000\nmargin rate: 0%\nslippage: 10 bps\nbuy when true';
  // The open of 95 leaves equity above 0; the close of 45 does not.
  const atClose = run(src, { A: ohlc([[100, 100, 100, 100], [100, 100, 100, 100], [95, 95, 45, 45], [45, 45, 45, 45]]) });
  const c = explainTrade(atClose, atClose.run.trades[0]);
  assert.equal(atClose.run.trades[0].reason, 'ruin');
  assert.match(section(c, 'sold')[0].label, /^Equity fell to −\$[\d,]+\.\d\d at the close of 2020-01-03, so every position was closed there and the run stopped\.$/);
  assert.deepEqual(table(c, 'sold')[1], ['Sold at the close of 2020-01-03', '45.00, less 10 bps slippage: 44.96', null, 0]);
  assert.deepEqual([c.facts.exitPrice, c.facts.ret], [atClose.run.trades[0].exitPrice, atClose.run.trades[0].ret]);
  const atOpen = run(src, { A: ohlc([[100, 100, 100, 100], [100, 100, 70, 70], [70, 70, 66, 66], [45, 65, 45, 60], [60, 80, 60, 80]]) });
  const o = explainTrade(atOpen, atOpen.run.trades[0]);
  assert.match(section(o, 'sold')[0].label, /at the open of 2020-01-04, so every position was closed there and the run stopped\.$/);
  assert.equal(section(o, 'sold')[1].label, 'Sold at the open of 2020-01-04');
  assert.deepEqual([o.facts.exitPrice, o.facts.ret], [atOpen.run.trades[0].exitPrice, atOpen.run.trades[0].ret]);
  // A short ruined by a price that runs away from it.
  const short = run('universe: A\ncapital: 10000\nmargin rate: 0%\nborrow fee: 0%\nshort when true', { A: ohlc([[100, 100, 100, 100], [100, 100, 100, 100], [150, 150, 150, 150], [210, 210, 210, 210], [210, 210, 210, 210]]) });
  const s = explainTrade(short, short.run.trades[0]);
  assert.deepEqual(table(s, 'sold').map((r) => r[0]), [
    'Equity fell to −$1,000.00 at the open of 2020-01-04, so every position was closed there and the run stopped.',
    'Covered at the open of 2020-01-04',
  ]);
  assert.equal(find(s, 'result', RETURN).value, '(100.00 − 210.00 − 0.00) ÷ 100.00');
});

test('a buy cut by a block\'s room, not its cash: it may hold more than its equity, up to its weights\' total', () => {
  const bt = run('universe: A 150%\ncapital: 1000\ncommission: 5 per order\nbuy when true', { A: bars([10, 10, 10]) });
  const ex = explainTrade(bt, bt.run.trades[0]);
  assert.deepEqual(table(ex, 'size').slice(1, 3), [
    ['Weight', '150% of that: $1,500.00', null, 0],
    ['Positions, long and short together, may come to at most 150% of equity, so the buy was cut to the room left with its commission', '$1,495.00', null, 0],
  ]);
});

// ---------------------------------------------------------------- the explanation agrees with the trade

function walk(n: number, seed: number, drift: number): Bars {
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let p = 50 + rnd() * 50;
  for (let d = Date.UTC(2019, 0, 1); out.t.length < n; d += DAY) {
    if ([0, 6].includes(new Date(d).getUTCDay())) continue;
    const gap = rnd() < 0.08 ? (rnd() - 0.5) * 0.12 : (rnd() - 0.5) * 0.01;
    const o = p * (1 + gap);
    const c = o * (1 + drift + (rnd() - 0.5) * 0.05);
    out.t.push(d);
    out.o.push(o);
    out.c.push(c);
    out.h.push(Math.max(o, c) * (1 + rnd() * 0.02));
    out.l.push(Math.min(o, c) * (1 - rnd() * 0.02));
    out.v.push(1000);
    p = c;
  }
  return out;
}

const SHORT_STRATEGIES = [
  'universe: A\ncosts: 5 bps\nslippage: 3 bps\nborrow fee: 2%\nstop loss: 4%\ntake profit: 7%\nshort when sma(5) crosses below sma(20)\ncover when sma(5) crosses above sma(20)',
  'universe: A, B\ntrailing stop: 2 atr(10)\nborrow fee: 1%\nbuy when close > sma(10)\nshort when close < sma(10)',
  'universe: A 100%, B 50%\nmargin rate: 8%\nrebalance: weekly\ncommission: 0.01 per share, min 1\nfor A:\nbuy when close > sma(15)\nsell when close < sma(15)\nfor B:\nshort when close < sma(15)\ncover when close > sma(15) or bars held >= 12',
  'universe: A 150%\nmargin rate: 6%\ncosts: 5 bps\ntrailing stop: 6%\nbuy when close > ema(20)\nsell when close < ema(20) * 0.97',
  'universe: B\nrisk per trade: 1% at 2 atr(14)\nstop loss: 2 atr(14)\nshort when close < lowest(20)[1]\ncover when close > highest(10)[1]',
  'universe: A\nentries: 3\ncommission: 0.5\nslippage: 5 bps\nstop loss: 8%\nshort when roc(5) < -2%\nadd when entries made < 3 and close > last entry price\ncover when close < entry price * 0.95 or bars held >= 10',
];

test('every explanation of a short, a flip or a leveraged trade agrees with its trade, with either kind of fill', () => {
  const data = { A: walk(400, 7, -0.0004), B: walk(400, 11, 0.0003) };
  let checked = 0;
  let shorts = 0;
  for (const src of SHORT_STRATEGIES) {
    for (const fill of ['', 'fill: close\n']) {
      const bt = run(fill + src, data);
      assert.ok(bt.run.trades.length > 0, `no trades for ${fill + src}`);
      for (const t of bt.run.trades) {
        const ex = explainTrade(bt, t);
        const why = t.why!;
        const where = `${fill + src}\n${ex.title}`;
        const f = ex.facts;
        const short = t.side === 'short';
        assert.equal(f.buyT, why.buyT);
        assert.equal(f.buyRule, 'yes', `entry rule at the signal: ${where}`);
        assert.equal(section(ex, 'bought')[0].label, `The ${short ? 'short' : 'buy'} rule was read at the close of ${iso(why.buyT)}.`);
        assert.ok(near(f.entryPrice, t.entryPrice, 1e-12 * t.entryPrice), `entry ${f.entryPrice} vs ${t.entryPrice}: ${where}`);
        assert.equal(f.reason, t.reason);
        if (why.exit?.k === 'rule') assert.equal(f.sellRule, 'yes', `exit rule at its bar: ${where}`);
        if (why.exit?.k === 'level') assert.ok(near(f.level!, why.exit.level, 1e-9 * why.exit.level), `level ${f.level} vs ${why.exit.level}: ${where}`);
        if (t.reason === 'stop loss') assert.ok(near(f.level!, why.stopLoss!, 1e-9 * f.level!), `stop loss level: ${where}`);
        if (t.reason === 'take profit') assert.ok(near(f.level!, why.takeProfit!, 1e-9 * f.level!), `target level: ${where}`);
        if (short && why.stopLoss !== null) assert.ok(why.stopLoss > t.entryPrice, `a short's stop is above its entry: ${where}`);
        if (short && why.takeProfit !== null) assert.ok(why.takeProfit < t.entryPrice, `a short's target is below its entry: ${where}`);
        assert.ok(near(f.exitPrice, t.exitPrice, 1e-12 * t.exitPrice), `exit ${f.exitPrice} vs ${t.exitPrice}: ${where}`);
        assert.ok(near(f.ret, t.ret, 1e-12), `return ${f.ret} vs ${t.ret}: ${where}`);
        assert.equal(titles(ex)[0], short ? 'Why it was shorted' : 'Why it was bought');
        checked++;
        if (short) shorts++;
      }
    }
  }
  assert.ok(checked > 300 && shorts > 150, `${checked} trades checked, ${shorts} of them short`);
});

/** Trades of every kind of exit the engine makes for a short, so none is left unexplained. */
test('the strategies above between them close shorts by every exit there is', () => {
  const data = { A: walk(400, 7, -0.0004), B: walk(400, 11, 0.0003) };
  const seen = new Set<string>();
  for (const src of SHORT_STRATEGIES) {
    for (const t of run(src, data).run.trades.filter((x: Trade) => x.side === 'short')) seen.add(t.why?.exit?.k === 'rule' && t.why.exit.flip ? 'flip' : t.reason);
  }
  for (const reason of ['signal', 'flip', 'stop loss', 'trailing stop', 'take profit', 'open']) assert.ok(seen.has(reason), `no short closed by ${reason}: ${[...seen]}`);
});
