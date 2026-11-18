import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { explainTrade, type Explanation, type Section } from '../src/explain.ts';
import { tradesCsv } from '../src/export.ts';
import { randomPicks, randomTiming } from '../src/luck.ts';
import { actionWord, orderSize, positionOrder, statusFrom } from '../src/orders.ts';
import { compactFacts, summary } from '../src/render.ts';
import { makeRng } from '../src/rng.ts';
import type { RunOutput } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { bars, near, DAY, T0 } from './helpers.ts';

function run(src: string, data: Record<string, Bars>): Backtest {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  return runBacktest(spec!, new Map(Object.entries(data)));
}
const output = (bt: Backtest): RunOutput => ({ spec: bt.spec, backtest: bt, data: bt.data, warnings: [], prices: [] });
const day = (n: number) => T0 + n * DAY;
const errorOf = (src: string, re: RegExp) => {
  const { errors } = parseSpec(src);
  assert.ok(errors.some((e) => re.test(e.message)), `no error matching ${re} in ${JSON.stringify(errors)}`);
  return errors.find((e) => re.test(e.message))!;
};
const rows = (ex: Explanation, id: Section['id'], k = 0) => ex.sections.filter((s) => s.id === id)[k].rows.map((r) => [r.label, r.value, r.outcome]);

// ---------------------------------------------------------------- the language

test('entries and add when: how they are written, and what is wrong without one of them', () => {
  const spec = parseSpec('universe: SPY, TLT\nentries: 3\nbuy when true\nadd when close > last entry price * 1.03\nfor TLT:\n  add when entries made < 2\n    and close > entry price').spec!;
  assert.equal(spec.entries, 3);
  assert.equal(JSON.stringify(spec.rules.SPY.add).match(/"name":"last_entry_price"/g)!.length, 1);
  assert.match(JSON.stringify(spec.rules.TLT.add), /"name":"entries_made".*"name":"entry_price"/);
  assert.equal(spec.written!.rules.TLT.add!.text, 'entries made < 2 and close > entry price');
  // Without the settings nothing changes in the spec.
  const plain = parseSpec('universe: SPY\nbuy when true\nsell when close < entry price').spec!;
  assert.deepEqual([plain.entries, 'add' in plain.rules.SPY, 'add' in plain.written!.rules.SPY], [undefined, false, false]);
  // `entries: 1` with an add rule is allowed and adds nothing, so a parameter can sweep from 1.
  assert.equal(parseSpec('universe: SPY\nn = 1 in 1..4\nentries: n\nbuy when true\nadd when true').spec!.entries, 1);
  const missing = errorOf('universe: SPY\nentries: 3\nbuy when true', /"entries: 3" builds each position in 3 entries, so it needs an add rule that says when to make the next one/);
  assert.equal(missing.line, 2);
  errorOf('universe: SPY, TLT\nentries: 2\nbuy when true\nfor SPY:\n  add when true', /needs an add rule for TLT/);
  errorOf('universe: SPY\nbuy when true\nadd when true', /"add when" needs an entries line/);
  errorOf('universe: SPY\nentries: 0\nbuy when true\nadd when true', /entries must be a whole number from 1 to 10, not 0/);
  errorOf('universe: SPY\nentries: 11\nbuy when true\nadd when true', /from 1 to 10, not 11/);
  errorOf('universe: SPY\nentries: 2.5\nbuy when true\nadd when true', /not 2.5/);
  errorOf('universe: SPY\nentries: 2\nbuy when true\nadd when true\nadd when false', /There is already a add rule|already an add rule|There is already/);
  errorOf('universe: SPY\nentries: 2\nbuy when entries made > 0\nadd when true', /"entries made" only makes sense in a sell, cover or add rule/);
  errorOf('universe: SPY\nentries: 2\nbuy when true\nadd when entries > 1', /"entries" on its own is not a name. Write "entries made"/);
  errorOf('universe: SPY\nentries: 2\nbuy when true\nadd when true\nsell when last_entry_price[1] > 1', /can't be read for an earlier bar/);
  // "last" stays free for a parameter, and the new values work in sell rules without entries.
  assert.ok(parseSpec('universe: SPY\nlast = 3\nbuy when close > close[last]\nsell when close < last entry price * 0.9 or entries made > 1').spec);
});

test('the summary line names the entries', () => {
  const spec = parseSpec('universe: SPY\nentries: 3\nbuy when true\nadd when true').spec!;
  assert.equal(summary(spec), 'SPY, bought in up to 3 entries, no costs');
});

// ---------------------------------------------------------------- sizing

test('three entries of a third each; the last one cut so the position stays within its weight', () => {
  // Day 1: 300 at 10 (30 shares). Day 2 closes at 11, above the last entry: at day 3's open, equity is 930 and a third of
  // it is 310. Day 3 closes at 12: at day 4's open equity is 988.18, a third 329.39, but the position is worth 698.18,
  // so the step is cut to 290, which takes it to its whole weight.
  const A = bars([10, 10, 11, 12, 13, 14, 13, 12, 12]);
  const bt = run('universe: A\ncapital: 900\nentries: 3\nadd when close > last entry price\nbuy when true', { A });
  assert.equal(bt.run.trades.length, 1);
  const t = bt.run.trades[0];
  assert.deepEqual(t.entries!.map((e) => [e.t, e.price, e.signalT]), [[day(1), 10, day(0)], [day(3), 11, day(2)], [day(4), 12, day(3)]]);
  assert.ok(near(t.entries![0].money, 300) && near(t.entries![1].money, 310) && near(t.entries![2].money, 290));
  assert.ok(near(t.entries![1].shares, 310 / 11) && near(t.entries![2].shares, 290 / 12));
  const shares = 30 + 310 / 11 + 290 / 12;
  assert.ok(near(t.entryPrice, 900 / shares));
  assert.equal(t.entryT, day(1));
  assert.equal(t.bars, 7);
  assert.ok(near(t.ret, 12 / (900 / shares) - 1));
  assert.ok(near(bt.run.equity[8], shares * 12));
  const [first, second] = t.why!.adds!;
  assert.deepEqual([first.signalT, first.equity, first.full, first.held, first.wanted, first.cash], [day(2), 930, 930, 330, 310, 600]);
  assert.ok(near(second.held, 698.1818181818182) && near(second.wanted, 290) && near(second.full / 3, 988.1818181818182 / 3));
  assert.equal(bt.run.states[0].entries, 3);
  assert.equal(bt.tradeStats.open, 1);
});

test('an add is cut to the weight, not only to cash, and one with nothing left to buy is not made', () => {
  // 50% weight in two entries: 250 at 10. At 20 the position is worth 500 of 1250, the weight 625: the add buys 125.
  const A = bars([10, 10, 20, 20, 20]);
  const bt = run('universe: A 50%\ncapital: 1000\nentries: 2\nadd when close > entry price * 1.5\nbuy when true', { A });
  const t = bt.run.trades[0];
  assert.ok(near(t.entries![1].money, 125) && near(t.entries![1].shares, 6.25));
  assert.ok(near(t.entryPrice, 12));
  assert.ok(near(bt.run.states[0].value, 625) && near(bt.run.equity[4], 1250));
  // At 30 it is worth 750 of 1500, its whole weight already: no add, and the entry is not counted.
  const B = bars([10, 10, 30, 30, 30]);
  const full = run('universe: A 50%\ncapital: 1000\nentries: 2\nadd when close > entry price * 1.5\nbuy when true', { A: B });
  assert.deepEqual([full.run.trades[0].entries!.length, full.run.states[0].entries], [1, 1]);
});

test('an add cut to the cash there is, when another ticker holds the rest', () => {
  // A 40% and B 60%, two entries each. B adds at once (add when true) and rises to 12; A falls to 9 and adds then
  // (add when close < entry price). At day 3's open equity is 1100, so A's step is 220, but only 200 is in cash.
  const A = bars([10, 10, 9, 9, 9]);
  const B = bars([10, 10, 12, 12, 12]);
  const bt = run('universe: A 40%, B 60%\ncapital: 1000\nentries: 2\nbuy when true\nadd when close < entry price\nfor B:\n  add when true', { A, B });
  const a = bt.run.trades.find((t) => t.asset === 'A')!;
  const add = a.why!.adds![0];
  assert.deepEqual([add.equity, add.cash, add.spent], [1100, 200, 200]);
  assert.ok(near(add.wanted, 220));
  assert.ok(near(a.entryPrice, 400 / (20 + 200 / 9)));
  const ex = explainTrade(bt, a);
  assert.ok(rows(ex, 'add').some(([l, v]) => l === 'Only $200.00 was in cash, so the add was cut to what that covers' && v === '$200.00'));
});

test('a rebalance keeps a position at its entries\' part of the weight and never completes it', () => {
  // 31 January: one entry of two in each, 250 each. A doubles. On 1 February each goes back to half of its 50%:
  // A is trimmed from 500 to 312.5 and B topped up from 250 to 312.5.
  const start = Date.UTC(2020, 0, 30);
  const A = bars([10, 20, 20, 20], { opens: [10, 10, 20, 20], start });
  const B = bars([10, 10, 10, 10], { start });
  const bt = run('universe: A 50%, B 50%\ncapital: 1000\nentries: 2\nrebalance: monthly\nbuy when true\nadd when false', { A, B });
  assert.deepEqual(bt.run.states.map((s) => [s.shares, s.entries]), [[15.625, 1], [31.25, 1]]);
  assert.deepEqual(bt.run.equity, [1000, 1250, 1250, 1250]);
  assert.ok(near(bt.run.exposure[2], 625 / 1250));
});

test('steps with risk per trade and inverse volatility: each entry is a part of the buy rule 10 or 11 would make', () => {
  // ATR(2) is 2 throughout; 1% of 1000 at 1 ATR is 5 shares, 50 at 10, so each of two entries is 25.
  const A = bars([10, 10, 10, 10, 10], { highs: [11, 11, 11, 11, 11], lows: [9, 9, 9, 9, 9] });
  const risk = run('universe: A\ncapital: 1000\nrisk per trade: 1% at 1 atr(2)\nentries: 2\nbuy when atr(2) > 0\nadd when true', { A });
  assert.deepEqual(risk.run.trades[0].entries!.map((e) => e.money), [25, 25]);
  const vol = run('universe: A 50%, B 50%\ncapital: 1000\nweighting: inverse volatility(2)\nentries: 2\nbuy when true\nadd when true', {
    A: bars([10, 11, 10, 11, 10, 11, 10]),
    B: bars([10, 10.5, 10, 10.5, 10, 10.5, 10]),
  });
  for (const t of vol.run.trades) for (const add of t.why!.adds!) assert.ok(add.wanted <= add.full / 2 + 1e-9 && add.full < 1000 * 1.0001);
});

// ---------------------------------------------------------------- stops and the order of events

test('the stop loss moves to the average entry price after each entry', () => {
  // 500 at 10 (stop 9). Day 2 closes at 12: the add buys 500 at 12, so the average is 1000 / 91.67 = 10.91 and the stop
  // 9.82. Day 4's low of 9.7 takes it, though it is above the first stop.
  const A = bars([10, 10, 12, 12, 10.5, 10.5], { opens: [10, 10, 10, 12, 12, 10.5], lows: [10, 10, 10, 12, 9.7, 10.5] });
  const bt = run('universe: A\ncapital: 1000\nentries: 2\nadd when close > last entry price\nbuy when true\nstop loss: 10%', { A });
  const t = bt.run.trades[0];
  const avg = 1000 / (50 + 500 / 12);
  assert.deepEqual([t.reason, t.exitT], ['stop loss', day(4)]);
  assert.ok(near(t.exitPrice, avg * 0.9) && near(t.why!.stopLoss!, avg * 0.9));
  assert.ok(near(t.why!.adds![0].stopLoss!, avg * 0.9) && near(t.why!.adds![0].average, avg));
  const ex = explainTrade(bt, t);
  assert.deepEqual(rows(ex, 'sold')[0].slice(0, 2), [`Stop loss at ${(avg * 0.9).toFixed(2)}`, `10% under the ${avg.toFixed(2)} average entry price of the 2 entries`]);
  assert.ok(near(ex.facts.level!, avg * 0.9) && near(ex.facts.ret, t.ret, 1e-12));
});

test('an add filled at an open is checked against the stops in that bar with the levels it set; the trail stays with the first entry', () => {
  // 500 at 10 (stop 9). Day 2 closes at 11: the add fills at day 3's gap down to 8 (56.25 shares), the average is
  // 950 / 106.25 = 8.94 and the stop 8.05, above that open: the whole position is sold at the open.
  const A = bars([10, 10, 11, 8, 8], { opens: [10, 10, 10, 8, 8], lows: [10, 10, 10, 7.5, 8] });
  const bt = run('universe: A\ncapital: 1000\nentries: 2\nadd when close > last entry price\nbuy when true\nstop loss: 10%', { A });
  const t = bt.run.trades[0];
  assert.deepEqual([t.entries!.length, t.reason, t.exitT, t.exitPrice], [2, 'stop loss', day(3), 8]);
  assert.deepEqual(t.why!.exit, { k: 'level', level: (950 / 106.25) * 0.9, high: null, atOpen: true });
  assert.ok(near(bt.run.equity[3], 900));
  // A trailing stop keeps the high since the first entry: 15 on day 2, so 13.5, which day 3's open of 12 is under.
  // After it, "buy when true" never stops holding, so A is not bought again (rule 29).
  const B = bars([10, 10, 12, 12, 12], { opens: [10, 10, 10, 12, 12], highs: [10, 10, 15, 12, 12] });
  const trail = run('universe: A\ncapital: 1000\nentries: 2\nadd when close > last entry price\nbuy when true\ntrailing stop: 10%', { A: B });
  assert.deepEqual(trail.run.trades.map((x) => [x.entries!.length, x.reason, x.exitT, x.exitPrice, x.why!.exit]), [
    [2, 'trailing stop', day(3), 12, { k: 'level', level: 13.5, high: 15, atOpen: true }],
  ]);
});

test('with fill: close entries fill at the close the add rule read, and the stops watch them from the next bar', () => {
  // The same prices as the three-entry case, filled at the closes: 300 at 10, 310 at 11, 290 at 12.
  const A = bars([10, 10, 11, 12, 13]);
  const bt = run('universe: A\ncapital: 900\nentries: 3\nfill: close\nadd when close > last entry price\nbuy when true', { A });
  const t = bt.run.trades[0];
  assert.deepEqual(t.entries!.map((e) => [e.t, e.signalT, e.price]), [[day(0), day(0), 10], [day(2), day(2), 11], [day(3), day(3), 12]]);
  assert.ok(near(t.entries![2].money, 290));
  // 300 at 10 sets the stop at 9. Day 1's low of 9.5 comes before its close, where 320 more is bought at 12: the average
  // is 10.94 and the stop 9.85 from then on, so day 2's low of 9.8 takes it, and day 1's did not.
  const B = bars([10, 12, 12, 12], { lows: [10, 9.5, 9.8, 12] });
  const stopped = run('universe: A\ncapital: 900\nentries: 3\nfill: close\nadd when close > last entry price\nbuy when true\nstop loss: 10%', { A: B });
  const avg = 620 / (30 + 320 / 12);
  assert.deepEqual(stopped.run.trades.map((x) => [x.entries!.length, x.reason, x.exitT]), [[2, 'stop loss', day(2)]]);
  assert.ok(near(stopped.run.trades[0].exitPrice, avg * 0.9));
  // The order made at the last close is reported as an entry.
  const last = run('universe: A\ncapital: 900\nentries: 3\nfill: close\nadd when close > last entry price\nbuy when true', { A: bars([10, 10, 11]) });
  assert.deepEqual(last.run.states[0].filled, { side: 'add', shares: 310 / 11, price: 11 });
  const status = statusFrom('n.md', 'S', output(last), day(3));
  assert.deepEqual(status.orders.map((o) => [actionWord(o), o.when, o.step]), [['Added', 'last close', { k: 2, n: 3 }]]);
});

test('an add is skipped at a close where the sell rule holds', () => {
  const A = bars([10, 10, 12, 12, 12]);
  const bt = run('universe: A\ncapital: 1000\nentries: 3\nadd when true\nbuy when true\nsell when close > 11', { A });
  // Entry 1 on day 1, entry 2 on day 2 (the add rule held at day 1's close); at day 2's close the sell rule holds.
  assert.deepEqual(bt.run.trades.map((t) => [t.entries!.length, t.exitT, t.reason]), [[2, day(3), 'signal']]);
});

test('with hold the ranking makes the first entry and the add rule the next, at a decision too', () => {
  // A ranks first throughout. Its first entry is half of 1000; day 2 closes at 11, above its entry price, at a decision
  // that keeps it, and the add fills on day 3.
  const A = bars([10, 10, 11, 11, 11]);
  const B = bars([5, 5, 5, 5, 5]);
  const bt = run('universe: A, B\ncapital: 1000\nhold: top 1 by close\nentries: 2\nadd when close > entry price', { A, B });
  const t = bt.run.trades[0];
  assert.deepEqual(t.entries!.map((e) => [e.t, e.money]), [[day(1), 500], [day(3), 500]]);
  assert.equal(t.why!.rank!.place, 0);
  const ex = explainTrade(bt, t);
  assert.equal(ex.facts.entries![0].rule, null);
  assert.equal(ex.facts.entries![1].rule, 'yes');
});

test('commission on each entry, and an add too small for its commission is not made', () => {
  // 50% weight, two entries, 1 a trade: 250 at 10 (25 shares, 749 left). At 29.6 the position is worth 740 of the
  // weight's 744.5: an add of 4.5 would pay 1, over 10% of it.
  const A = bars([10, 10, 29.6, 29.6]);
  const bt = run('universe: A 50%\ncapital: 1000\ncommission: 1\nentries: 2\nadd when close > entry price * 1.5\nbuy when true', { A });
  assert.deepEqual([bt.run.trades[0].entries!.length, bt.run.smallTrades, bt.run.states[0].pending], [1, 1, 'add']);
  // Each entry pays: two entries and the return counts both, per share bought.
  const B = bars([10, 10, 11, 11]);
  const two = run('universe: A\ncapital: 1000\ncommission: 1\nentries: 2\nadd when close > entry price\nbuy when true\nsell when close[1] > 10.5', { A: B });
  const t = two.run.trades[0];
  assert.deepEqual([t.entries!.length, t.why!.commission!.entries, t.why!.commission!.paid], [2, 2, 2]);
  const ex = explainTrade(two, t);
  assert.ok(near(ex.facts.ret, t.ret, 1e-12));
});

// ---------------------------------------------------------------- what the result says

test('an add waiting at the last bar: the positions, the folded line and today\'s orders', () => {
  // Day 2 closes at 11, above the first entry's 10: the second of three entries waits for the next open.
  const bt = run('universe: A\ncapital: 900\nentries: 3\nadd when close > last entry price\nbuy when true', { A: bars([10, 10, 11]) });
  const st = bt.run.states[0];
  assert.deepEqual([st.pending, st.entries, st.side === 'long'], ['add', 1, true]);
  assert.ok(near(st.targetWeight, 1 / 3));
  assert.equal(positionOrder(st), 'adds at the next open');
  assert.equal(compactFacts(output(bt)).order, 'adds to A at the next open');
  assert.equal(compactFacts(output(bt)).holding, `Long A since ${new Date(day(1)).toISOString().slice(0, 10)}, 1 of 3 entries`);
  const status = statusFrom('n.md', 'S', output(bt), day(3));
  assert.equal(status.orders.length, 1);
  const order = status.orders[0];
  assert.deepEqual([actionWord(order), order.ticker, order.step], ['Add', 'A', { k: 2, n: 3 }]);
  assert.equal(orderSize(order), 'Step 2 of 3: 33.3% of the strategy, about $310');
  assert.equal(status.holdings.length, 0);
  // A first entry waiting: a buy, of a third.
  const buy = run('universe: A\ncapital: 900\nentries: 3\nadd when true\nbuy when close > 10', { A: bars([10, 10, 11]) });
  const b = statusFrom('n.md', 'S', output(buy), day(3)).orders[0];
  assert.deepEqual([actionWord(b), b.step, orderSize(b)], ['Buy', { k: 1, n: 3 }, 'Step 1 of 3: 33.3% of the strategy, about $300']);
});

test('the trades file gains the entries at the end, and the explanation has a part for each entry', () => {
  const A = bars([10, 10, 11, 12, 13]);
  const bt = run('universe: A\ncapital: 900\nentries: 3\nadd when close > last entry price\nbuy when true\nstop loss: 20%', { A });
  const lines = tradesCsv(bt.run.trades, false).trim().split('\n');
  assert.equal(lines[0], 'ticker,bought,buy_price,sold,sell_price,return_pct,profit,bars,exit,entries,entry_dates,entry_prices,entry_shares');
  assert.match(lines[1], /^A,2020-01-02,10\.929163,,,.*,open,3,2020-01-02;2020-01-04;2020-01-05,10;11;12,30;28\.181818;24\.166667$/);
  const ex = explainTrade(bt, bt.run.trades[0]);
  assert.equal(ex.title, 'A: bought in 3 entries from 2020-01-02, at 10.93 on average, still held');
  assert.deepEqual(ex.sections.map((s) => s.title), ['Why it was bought', 'How much: entry 1 of 3', 'Entry 2 of 3', 'Entry 3 of 3', 'Why it is still held', 'Result']);
  assert.deepEqual(rows(ex, 'size').find((r) => String(r[0]).startsWith('Each of')), ['Each of the 3 entries is 1/3 of a whole position, $900.00', '$300.00', null]);
  const second = rows(ex, 'add', 0);
  assert.deepEqual(second.slice(0, 2), [['The add rule was read at the close of 2020-01-03.', '', null], ['add when close > last entry price', 'close 11 > last entry price 10', 'yes']]);
  assert.ok(second.some(([l, v]) => l === 'The stop loss moved to' && v === '8.39, 20% under the average'));
  const third = rows(ex, 'add', 1);
  assert.ok(third.some(([l, v]) => l === 'The position was worth $698.18, so the entry was cut to what keeps it within a whole position' && v === '$290.00'));
  assert.ok(rows(ex, 'result').some(([l, v]) => l === 'Bought in 3 entries of the 3 allowed' && v === 'at 10.93 on average'));
});

test('the luck checks run on a strategy built in steps', () => {
  const walk = (seed: number) => {
    let x = seed;
    const c: number[] = [];
    let p = 50;
    for (let i = 0; i < 300; i++) c.push((p *= 1 + ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 0.04));
    return bars(c);
  };
  const bt = run('universe: A\nentries: 3\nbuy when close > sma(20)\nadd when close > last entry price * 1.02\nsell when close < sma(20)', { A: walk(3) });
  assert.ok(bt.run.trades.length > 2);
  assert.ok(randomTiming(bt, makeRng(1)).run.equity.length === bt.run.equity.length);
  const ranked = run('universe: A, B\nhold: top 1 by roc(10)\nentries: 2\nadd when close > entry price', { A: walk(3), B: walk(7) });
  assert.equal(randomPicks(ranked, makeRng(1), 0.1).equity.length, ranked.run.equity.length);
});
