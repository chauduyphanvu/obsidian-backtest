import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { commissionFee } from '../src/engine.ts';
import { explainTrade, type Explanation, type Section } from '../src/explain.ts';
import { commissionText, summary } from '../src/render.ts';
import { DEFAULT_SETTINGS, defaultsFrom, normalizeSettings, validateSetting } from '../src/settings-core.ts';
import type { Bars } from '../src/types.ts';
import { bars, near, DAY } from './helpers.ts';

function run(src: string, data: Record<string, Bars>) {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  return runBacktest(spec!, new Map(Object.entries(data)));
}
const errorOf = (src: string, re: RegExp) => {
  const { errors } = parseSpec(src);
  assert.ok(errors.some((e) => re.test(e.message)), `no error matching ${re} in ${JSON.stringify(errors)}`);
};
const rows = (ex: Explanation, id: Section['id']) => ex.sections.find((s) => s.id === id)!.rows.map((r) => [r.label, r.value]);

test('commission: the forms it is written in, and what is wrong with the others', () => {
  const c = (line: string) => parseSpec(`universe: SPY\nbuy when true\n${line}`).spec!.commission;
  assert.deepEqual(c('commission: 1'), { k: 'order', fee: 1 });
  assert.deepEqual(c('commission: $2.5 per order'), { k: 'order', fee: 2.5 });
  assert.deepEqual(c('commission: 0.005 per share'), { k: 'share', fee: 0.005, min: 0, max: null });
  assert.deepEqual(c('commission: 0.005 per share, min 1'), { k: 'share', fee: 0.005, min: 1, max: null });
  assert.deepEqual(c('commission: 0.005 per share, max 1%, min $1'), { k: 'share', fee: 0.005, min: 1, max: 0.01 });
  assert.equal(c('commission: 0'), undefined);
  assert.equal(parseSpec('universe: SPY\nbuy when true').spec!.commission, undefined);
  errorOf('universe: SPY\nbuy when true\ncommission: lots', /"lots" is not a commission. Write it as 1 for a fixed amount per order, or as 0.005 per share/);
  errorOf('universe: SPY\nbuy when true\ncommission: 1, min 2', /"min" and "max" go with a commission per share/);
  errorOf('universe: SPY\nbuy when true\ncommission: 0 per share', /per share must be above 0/);
  errorOf('universe: SPY\nbuy when true\ncommission: 0.01 per share, min 1, min 2', /"min" is written twice/);
  errorOf('universe: SPY\nbuy when true\ncommission: 0.01 per share, max 10%', /above 0% and under 10%/);
  errorOf('universe: SPY\nbuy when true\ncommission: 0.01 per share, max 1', /percentage of the order's value/);
  errorOf('universe: SPY\nbuy when true\ncommission: 0.01 per share, cap 1%', /Can't read "cap 1%"/);
  errorOf('universe: SPY\nbuy when true\nfor SPY:\n  commission: 1', /"commission" applies to the whole strategy/);
});

test('the plugin setting is the default, checked like a block line, and a block line overrides it, 0 included', () => {
  assert.equal(validateSetting('commission', '0.005 per share, min 1'), null);
  assert.match(validateSetting('commission', 'free')!, /is not a commission/);
  assert.equal(normalizeSettings({ commission: 'free' }).commission, '0');
  assert.equal(normalizeSettings({ commission: ' 1 ' }).commission, '1');
  assert.deepEqual(defaultsFrom(DEFAULT_SETTINGS), { capital: 10000, costBps: 0, slippageBps: 0, cashRate: '0%', dataSource: 'yahoo' });
  const defaults = defaultsFrom({ ...DEFAULT_SETTINGS, commission: '2' });
  assert.deepEqual(defaults.commission, { k: 'order', fee: 2 });
  assert.deepEqual(parseSpec('universe: SPY\nbuy when true', { defaults }).spec!.commission, { k: 'order', fee: 2 });
  assert.deepEqual(parseSpec('universe: SPY\nbuy when true\ncommission: 3', { defaults }).spec!.commission, { k: 'order', fee: 3 });
  assert.equal(parseSpec('universe: SPY\nbuy when true\ncommission: 0', { defaults }).spec!.commission, undefined);
});

test('a fixed commission: paid on top of each buy, out of each sale, in the return, the profit, the costs and the benchmark', () => {
  // Bought at 10 on day 1 with 1000 - 2 = 998 (99.8 shares); sold at 12 on day 3 for 1197.6 - 2; bought again on day 4.
  const A = bars([10, 10, 12, 12, 12]);
  const r = run('universe: A\ncapital: 1000\ncommission: 2\nbuy when true\nsell when close > close[1]', { A });
  assert.deepEqual(r.run.equity, [1000, 998, 1197.6, 1195.6, 1193.6]);
  assert.equal(r.run.costs, 6);
  assert.equal(r.run.commission, 6);
  assert.equal(r.run.smallTrades, 0);
  const [first, second] = r.run.trades;
  assert.ok(near(first.ret, (12 - 2 / 99.8) / (10 + 2 / 99.8) - 1));
  assert.ok(near(first.pnl, 195.6));
  assert.deepEqual(first.why!.commission, { paid: 4, entries: 2, exit: 2, exitShares: 99.8 });
  // Still held: its return counts the commission a sale at the last close would pay.
  const shares = 1193.6 / 12;
  assert.ok(near(second.ret, (12 - 2 / shares) / (12 + 2 / shares) - 1));
  assert.deepEqual(second.why!.commission, { paid: 2, entries: 2, exit: 2, exitShares: shares });
  // The benchmark buys once, with the same commission.
  assert.deepEqual(r.benchmark.equity, [1000, 998, 1197.6, 1197.6, 1197.6]);
});

test('a commission per share: the minimum, the cap, and fractions of a share', () => {
  const flat = bars([10, 10, 10]);
  const price10 = (capital: number, line: string) => run(`universe: A\ncapital: ${capital}\n${line}\nbuy when true`, { A: flat });
  // 99.9 shares would pay 0.999, so the minimum of 1 applies: 999 bought, 1 paid.
  let r = price10(1000, 'commission: 0.01 per share, min 1, max 1%');
  assert.ok(near(r.run.states[0].shares, 99.9) && near(r.run.commission!, 1) && near(r.run.equity[1], 999));
  // A large order pays per share: 100000 / (1 + 0.001) at 10 is 9990.00999 shares, at 0.01 each.
  r = price10(100_000, 'commission: 0.01 per share, min 1, max 1%');
  assert.ok(near(r.run.commission!, 99.9000999000999, 1e-9) && near(r.run.states[0].shares, 9990.00999000999, 1e-9));
  // A small order pays the cap, below the minimum: 50 / 1.01 bought, 1% of it paid.
  r = price10(50, 'commission: 0.01 per share, min 1, max 1%');
  assert.ok(near(r.run.equity[1], 50 / 1.01) && near(r.run.commission!, 50 / 1.01 / 100));
  // Fractions of a share pay their fraction: 0.5 a share on 1.99 shares.
  assert.ok(near(commissionFee({ k: 'share', fee: 0.5, min: 0, max: null }, 19.9, 1.99), 0.995));
  // Percentage costs and the commission add together: (1000 - 1) / 1.01 bought.
  r = price10(1000, 'costs: 100 bps\ncommission: 1');
  const spent = 999 / 1.01;
  assert.ok(near(r.run.costs, spent * 0.01 + 1) && near(r.run.commission!, 1) && near(r.run.equity[1], spent));
});

test('a buy the cash cannot pay the commission for is not made, and a sale never takes cash below 0', () => {
  const flat = bars([10, 10, 10]);
  const none = run('universe: A\ncapital: 1\ncommission: 2\nbuy when true', { A: flat });
  assert.deepEqual([none.run.trades.length, none.run.equity], [0, [1, 1, 1]]);
  // 7 bought at 10 with 3 paid; the price falls to 1, so the sale brings in 0.7 and pays that much, not 3.
  const A = bars([10, 10, 1, 1], { opens: [10, 10, 1, 1] });
  const r = run('universe: A\ncapital: 10\ncommission: 3\nbuy when true\nsell when close < 5', { A });
  assert.deepEqual(r.run.equity, [10, 7, 0.7, 0]);
  assert.equal(r.run.trades[0].why!.commission!.paid, 3.7);
  assert.equal(r.run.commission, 3.7);
});

test('a rebalancing trade too small for its commission is not made, and the result says so', () => {
  // 90% in A at a flat 10: 9000 bought with 1 paid, 999 left in cash. In February the 90% of 9999 is 8999.1, a trim of
  // 0.9, whose commission of 1 is far over 10% of it.
  const start = Date.UTC(2020, 0, 30);
  const flat = bars([10, 10, 10, 10], { start });
  const r = run('universe: A 90%\ncapital: 10000\ncommission: 1\nrebalance: monthly\nbuy when true', { A: flat });
  assert.equal(r.run.states[0].shares, 900);
  assert.equal(r.run.smallTrades, 1);
  assert.equal(r.run.trades[0].why!.trims, 0);
  assert.ok(r.notes.includes('1 add or rebalancing trade was not made because the commission would have been 10% of its value or more.'));
  // A trim worth ten times its commission or more is made: A doubles, so 500 of it is sold for 1.
  const A = bars([10, 20, 20, 20], { opens: [10, 10, 20, 20], start });
  const B = bars([10, 10, 10, 10], { start });
  const big = run('universe: A 50%, B 50%\ncapital: 1000\ncommission: 1\nrebalance: monthly\nbuy when true', { A, B });
  assert.deepEqual(big.run.trades.map((t) => [t.why!.trims, t.why!.topUps]), [[1, 0], [0, 1]]);
  assert.equal(big.run.smallTrades, 0);
});

test('the explanation gives each fill\'s commission, and the costs paid say how much of them it was', () => {
  const A = bars([10, 10, 12, 12]);
  const bt = run('universe: A\ncapital: 1000\ncosts: 10 bps\ncommission: 2\nbuy when true\nsell when close > 11', { A });
  const ex = explainTrade(bt, bt.run.trades[0]);
  const spent = 998 / 1.001;
  assert.ok(rows(ex, 'size').some(([l, v]) => l === 'The costs and commission are paid on top, so the $1,000.00 in cash covered' && v === '$997.00'));
  assert.ok(rows(ex, 'size').some(([l, v]) => l === 'Money put in' && v === `$997.00 plus $1.00 costs and $2.00 commission, for ${(spent / 10).toLocaleString('en-US', { maximumFractionDigits: 4 })} shares`));
  const paid = bt.run.trades[0].why!.fees;
  assert.ok(rows(ex, 'result').some(([l, v]) => l === 'Costs paid' && v === `$${paid.toFixed(2)}, of which $4.00 commission`));
  assert.ok(near(ex.facts.ret, bt.run.trades[0].ret, 1e-12));
});

test('the summary names the commission', () => {
  const spec = (extra: string) => parseSpec(`universe: SPY\nbuy when true\n${extra}`).spec!;
  assert.equal(summary(spec('commission: 1')), 'SPY, commission 1 an order');
  assert.equal(summary(spec('costs: 5 bps\ncommission: 0.005 per share, min 1, max 1%')), 'SPY, 5 bps costs, commission 0.005 a share, at least 1, at most 1% of the order');
  assert.equal(commissionText({ k: 'share', fee: 0.01, min: 0, max: null }), 'commission 0.01 a share');
  assert.equal(summary(spec('costs: 5 bps')), 'SPY, 5 bps costs');
});

test('an hourly run counts the commission the same way', () => {
  const A = bars([10, 10, 10, 10], { step: 3_600_000 });
  const r = run('data: binance\nuniverse: AUSDT\ninterval: 1h\ncapital: 100\ncommission: 1\nbuy when true', { AUSDT: A });
  assert.deepEqual(r.run.equity, [100, 99, 99, 99]);
  assert.ok(r.run.t[1] - r.run.t[0] < DAY);
});
