import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accountOrders,
  accountStrategy,
  allocations,
  borrowedError,
  errorsBeforeRun,
  orderSteps,
  parseAccount,
  runAccount,
  sharesAfterOrders,
  type AccountConfig,
  type AccountStrategy,
} from '../src/account.ts';
import { runBacktest } from '../src/backtest.ts';
import type { CompareHost } from '../src/compare.ts';
import { parseSpec } from '../src/dsl.ts';
import type { AssetState } from '../src/engine.ts';
import { accountOrderText, scanAccounts } from '../src/orders.ts';
import type { RunOutput } from '../src/runner.ts';
import { bars, near } from './helpers.ts';

const PLAN_BLOCK = `name: Main brokerage
holdings: SPY 120, TLT 50, QQQ 10
cash: 4,200
whole shares: yes
skip under: 1%
fills: Broker/schwab.csv
fills from: 2026-06-01
capital at start: 48,000

[[Trend following]] 40%
[[Sector rotation]] 40%
[[Dip buyer]] 20%`;

// --- Parsing -------------------------------------------------------------------------------------------------------

test("the plan's account block reads without errors", () => {
  const { config, entries, errors } = parseAccount(PLAN_BLOCK);
  assert.deepEqual(errors, []);
  assert.deepEqual(config, {
    name: 'Main brokerage',
    holdings: [
      { ticker: 'SPY', shares: 120 },
      { ticker: 'TLT', shares: 50 },
      { ticker: 'QQQ', shares: 10 },
    ],
    cash: 4200,
    wholeShares: true,
    skipUnder: 0.01,
    fills: 'Broker/schwab.csv',
    fillsFrom: Date.UTC(2026, 5, 1),
    capitalAtStart: 48_000,
    fillColumns: null,
  });
  assert.deepEqual(entries.map((e) => [e.link, e.weight, e.line]), [
    ['Trend following', 0.4, 10],
    ['Sector rotation', 0.4, 11],
    ['Dip buyer', 0.2, 12],
  ]);
  assert.deepEqual(parseAccount(PLAN_BLOCK.replace(/\n/g, '\r\n')), parseAccount(PLAN_BLOCK));
});

test('settings take other spellings, and the defaults are whole shares, no band and no cash', () => {
  const { config, errors } = parseAccount('Holdings: btcusdt 0.25; SPY 1,200, brk-b 3\nCASH: $1,000.50\nWhole Shares: NO\nfills: [[Broker/fid.csv]]\nfills from: 2026-06-01\n[[A]]');
  assert.deepEqual(errors, []);
  assert.deepEqual(config.holdings, [
    { ticker: 'BTCUSDT', shares: 0.25 },
    { ticker: 'SPY', shares: 1200 },
    { ticker: 'BRK-B', shares: 3 },
  ]);
  assert.equal(config.cash, 1000.5);
  assert.equal(config.wholeShares, false);
  assert.equal(config.fills, 'Broker/fid.csv');
  const plain = parseAccount('cash: 48k\n[[A]]').config;
  assert.equal(plain.cash, 48_000);
  assert.equal(plain.wholeShares, true);
  assert.equal(plain.skipUnder, 0);
  assert.deepEqual(parseAccount('holdings: none\ncash: 10\n[[A]]').config.holdings, []);
  assert.deepEqual(parseAccount('holdings:\ncash: 10\n[[A]]').errors, []);
});

test('a fills file needs the day the account started following the strategies', () => {
  assert.deepEqual(parseAccount('cash: 1\nfills: Broker/x.csv\n[[A]]').errors, [
    { line: 2, message: 'fills needs a fills from line: the first day the account followed its strategies, such as fills from: 2026-06-01' },
  ]);
  assert.deepEqual(parseAccount('cash: 1\nfills from: 2026-06-01\n[[A]]').errors, []);
});

test('the fills columns setting is read with the block', () => {
  const { config, errors } = parseAccount('cash: 1\nfills columns: date = When; fees = Fee + Tax\n[[A]]');
  assert.deepEqual(errors, []);
  assert.deepEqual(config.fillColumns, { date: 'When', fees: ['Fee', 'Tax'] });
  const bad = parseAccount('cash: 1\nfills columns: when = Date\n[[A]]').errors;
  assert.equal(bad.length, 1);
  assert.match(bad[0].message, /"when = Date" does not say which column holds what/);
});

test('a holding that is not a ticker and its shares is an error that points at it', () => {
  const line = 'holdings: SPY 120, TLT fifty';
  assert.deepEqual(parseAccount(`${line}\n[[A]]`).errors, [
    { line: 1, message: '"TLT fifty" is not a holding. Write each as a ticker and its shares, such as SPY 120', from: 19, to: 28 },
  ]);
  assert.match(parseAccount('holdings: SPY\n[[A]]').errors[0].message, /"SPY" is not a holding/);
  assert.match(parseAccount('holdings: SPY 10k\n[[A]]').errors[0].message, /"SPY 10k" is not a holding/);
  assert.match(parseAccount('holdings: S&P 10\n[[A]]').errors[0].message, /"S&P 10" is not a holding/);
  assert.deepEqual(parseAccount('holdings: SPY 0\n[[A]]').errors, [{ line: 1, message: 'SPY has no shares: leave it out instead', from: 10, to: 15 }]);
  assert.deepEqual(parseAccount('holdings: SPY 1, spy 2\n[[A]]').errors, [{ line: 1, message: 'SPY is listed twice', from: 17, to: 22 }]);
  // The second of two that are spelled the same is the one pointed at.
  assert.deepEqual(parseAccount('holdings: SPY 1, SPY 1\n[[A]]').errors, [{ line: 1, message: 'SPY is listed twice', from: 17, to: 22 }]);
  assert.deepEqual(parseAccount('name: name\nholdings: X 1\n[[A]]').errors, []);
  assert.deepEqual(parseAccount('cash: 1\nfills: fills\n[[A]]').errors[0], {
    line: 2,
    message: "fills takes the vault path of the broker's CSV file, such as Broker/schwab.csv",
    from: 7,
    to: 12,
  });
});

test('each setting says what is wrong with its value', () => {
  const error = (line: string) => {
    const { errors } = parseAccount(`${line}\ncash: 1\n[[A]]`);
    assert.equal(errors.length, 1, line);
    return errors[0].message;
  };
  assert.equal(parseAccount('cash: -100\n[[A]]').errors[0].message, "Cash can't be below 0: the account holds no borrowed money");
  assert.equal(parseAccount('cash: lots\n[[A]]').errors[0].message, '"lots" is not an amount of cash. Write it as 4,200 or 4200.50');
  assert.equal(error('capital at start: 0'), '"0" is not an amount above 0. Write the account\'s value on the day in fills from, such as 48,000');
  assert.equal(error('whole shares: maybe'), 'whole shares is yes or no');
  assert.equal(error('skip under: 1'), '"1" is not a share of the account. Write it as 1%, or 0% to make every order');
  assert.equal(error('skip under: 100%'), 'skip under must be under 100%');
  assert.equal(error('fills: Broker/schwab.xlsx'), "fills takes the vault path of the broker's CSV file, such as Broker/schwab.csv");
  assert.equal(error('fills from: 2026-02-30'), '"2026-02-30" is not a date. Write it as 2026-06-01');
  assert.equal(error('fills from: June 1'), '"June 1" is not a date. Write it as 2026-06-01');
  assert.equal(error('name:'), 'Write the name of the account after "name:"');
  // The error points at the value.
  assert.deepEqual(parseAccount('skip under:   5 percent\ncash: 1\n[[A]]').errors[0], { line: 1, message: '"5 percent" is not a share of the account. Write it as 1%, or 0% to make every order', from: 14, to: 23 });
});

test('an unknown setting, a setting given twice and a line that is neither are errors', () => {
  assert.deepEqual(parseAccount('cash: 1\nbroker: Schwab\n[[A]]').errors, [
    { line: 2, message: '"broker" is not a setting of an account. The settings are name, holdings, cash, whole shares, skip under, fills, fills from, capital at start and fills columns' },
  ]);
  assert.deepEqual(parseAccount('cash: 1\ncash: 2\n[[A]]').errors, [{ line: 2, message: 'cash is already set on line 1' }]);
  assert.match(parseAccount('cash: 1\nSPY 120\n[[A]]').errors[0].message, /^This line is neither a setting nor a strategy/);
  // Comments and blank lines are skipped and counted.
  assert.deepEqual(parseAccount('# My account\n\ncash: 1\n   # more\n[[A]]').entries[0].line, 5);
});

test("strategies are listed as in a compare block, and 0% lists one with none of the money", () => {
  const { entries, errors } = parseAccount('cash: 1\n[[A]] 60%\n[[B#Second|Two]] 0%\nResearch/C.md 40%');
  assert.deepEqual(errors, []);
  assert.deepEqual(entries.map((e) => [e.link, e.block, e.label, e.weight]), [
    ['A', null, null, 0.6],
    ['B', 'Second', 'Two', 0],
    ['Research/C.md', null, null, 0.4],
  ]);
  assert.deepEqual(parseAccount('cash: 1\n[[A]] 50%\n[[B]] -5%').errors, [{ line: 3, message: "A weight can't be below 0%", from: 6, to: 9 }]);
  assert.deepEqual(allocations(entries), [0.6, 0, 0.4]);
});

test('without weights the strategies share the account equally', () => {
  const { entries, errors } = parseAccount('cash: 1\n[[A]]\n[[B]]\n[[C]]\n[[D]]');
  assert.deepEqual(errors, []);
  assert.deepEqual(allocations(entries), [0.25, 0.25, 0.25, 0.25]);
  assert.deepEqual(allocations(parseAccount('cash: 1\n[[A]]').entries), [1]);
});

test('the rules on the list of strategies', () => {
  assert.deepEqual(parseAccount('cash: 1').errors, [{ line: 1, message: 'Add the strategies the account follows, such as [[Trend following]] 60%' }]);
  assert.deepEqual(parseAccount('cash: 1\n[[A]]\n[[a.md]]').errors, [{ line: 3, message: 'This strategy is already listed on line 2' }]);
  assert.deepEqual(parseAccount('cash: 1\n[[A]] 50%\n[[B]]').errors, [{ line: 3, message: 'Give every strategy a weight, or none of them' }]);
  assert.deepEqual(parseAccount('cash: 1\n[[A]] 70%\n[[B]] 40%').errors, [{ line: 3, message: "The weights add up to 110%, and they can't add up to more than 100%" }]);
  const nine = Array.from({ length: 9 }, (_, i) => `[[N${i}]]`).join('\n');
  assert.deepEqual(parseAccount(`cash: 1\n${nine}`).errors, [{ line: 10, message: 'An account follows at most 8 strategies' }]);
  assert.deepEqual(parseAccount('[[A]]').errors, [{ line: 1, message: "Write the account's cash, its holdings or both, such as cash: 10,000" }]);
  assert.deepEqual(parseAccount('holdings: SPY 1\n[[A]]').errors, []);
});

// --- Orders --------------------------------------------------------------------------------------------------------

const T = Date.UTC(2026, 10, 13);

function state(name: string, o: Partial<AssetState> = {}): AssetState {
  const st: AssetState = { name, weight: 1, side: null, since: null, pending: null, shares: 0, lastClose: 100, value: 0, targetWeight: 0, ...o };
  st.side = st.shares > 0 ? 'long' : st.shares < 0 ? 'short' : null;
  st.value = st.shares * st.lastClose;
  return st;
}

function strat(label: string, alloc: number, equity: number, states: AssetState[], o: Partial<AccountStrategy> = {}): AccountStrategy {
  return { label, alloc, equity, asOf: T, states, closeFill: false, rebalance: 'never', sizing: 'fixed', cost: 0, ...o };
}

const account = (o: Partial<AccountConfig>) => ({ holdings: [], cash: 0, wholeShares: true, skipUnder: 0, ...o });

test("a strategy's shares once its waiting orders are made", () => {
  assert.equal(sharesAfterOrders(state('A', { shares: 7 }), 1000), 7);
  assert.equal(sharesAfterOrders(state('A', { shares: 7, pending: 'sell' }), 1000), 0);
  // A buy at 40% of 1,000 at a last close of 50 is 8 shares; an add puts them on top of what is held.
  assert.equal(sharesAfterOrders(state('A', { pending: 'buy', targetWeight: 0.4, lastClose: 50 }), 1000), 8);
  assert.equal(sharesAfterOrders(state('A', { shares: 3, pending: 'add', targetWeight: 0.4, lastClose: 50 }), 1000), 11);
  assert.equal(sharesAfterOrders(state('A', { shares: 3, lastClose: NaN }), 1000), 0);
});

test('two strategies sharing a ticker: targets, orders and what each strategy brings to them', () => {
  // 10,000 in cash, SPY and TLT worth 5,000 each, AAPL that no strategy trades. The strategies manage 20,000, half each.
  // A (equity 1,000) holds 5 SPY at 100, half its equity, and buys TLT at 40% at the next open at 50.
  // B (equity 2,000) sells its 10 SPY and buys QQQ at 50% at 200.
  const A = strat('A', 0.5, 1000, [state('SPY', { shares: 5 }), state('TLT', { pending: 'buy', targetWeight: 0.4, lastClose: 50 })]);
  const B = strat('B', 0.5, 2000, [state('SPY', { shares: 10, pending: 'sell' }), state('QQQ', { pending: 'buy', targetWeight: 0.5, lastClose: 200 })]);
  const plan = accountOrders(
    account({
      cash: 10_000,
      holdings: [
        { ticker: 'SPY', shares: 50 },
        { ticker: 'TLT', shares: 100 },
        { ticker: 'AAPL', shares: 10 },
      ],
    }),
    [A, B],
  );
  assert.equal(plan.managed, 20_000);
  assert.deepEqual(plan.unmanaged, [{ ticker: 'AAPL', shares: 10 }]);
  const brief = plan.orders.map((o) => [o.ticker, o.kind, o.holding, o.target, o.shares]);
  // SPY: 10,000 x 50% = 5,000, 50 shares. TLT: 10,000 x 40% = 4,000, 80 shares. QQQ: 10,000 x 50% = 5,000, 25 shares.
  assert.deepEqual(brief, [
    ['TLT', 'resize', 100, 80, -20],
    ['QQQ', 'open', 0, 25, 25],
    ['SPY', 'resize', 50, 50, 0],
  ]);
  const [tlt, qqq, spy] = plan.orders;
  // A's TLT buy is 4,000 at the account's size; the account holds 5,000 already, 5,000 more than the strategies did.
  assert.deepEqual(tlt.parts, [4000, 0]);
  assert.equal(tlt.drift, -5000);
  assert.deepEqual(qqq.parts, [0, 5000]);
  // B's SPY sale is 5,000; the account's SPY is 5,000 short of the 10,000 the strategies held, so nothing is left to do.
  assert.deepEqual(spy.parts, [0, -5000]);
  assert.equal(spy.drift, 5000);
  for (const o of plan.orders) assert.ok(near(o.parts.reduce((s, x) => s + x, 0) + o.drift, (o.target - o.holding) * o.price, 1e-9), o.ticker);
  assert.equal(plan.cashAfter, 10_000 + 1000 - 5000);
  assert.equal(plan.saved, 0);
});

test('netting: one strategy selling what another buys is traded once, and what that spares is counted', () => {
  // A sells its 5 SPY (5,000 at the account's size), B buys 25% of its 2,000 (2,500 at the account's size).
  const A = strat('A', 0.5, 1000, [state('SPY', { shares: 5, pending: 'sell' })], { cost: 0.001 });
  const B = strat('B', 0.5, 2000, [state('SPY', { pending: 'buy', targetWeight: 0.25 })], { cost: 0.003 });
  const plan = accountOrders(account({ cash: 20_000 }), [A, B]);
  const [spy] = plan.orders;
  assert.deepEqual(spy.parts, [-5000, 2500]);
  // 7,500 traded apart, 2,500 together: 5,000 spared, at the strategies' costs weighted by what each trades: 12.5 on 7,500.
  assert.equal(spy.saved, 5000);
  assert.ok(near(spy.savedCost, 5000 * (12.5 / 7500), 1e-9));
  assert.equal(plan.saved, 5000);
  assert.ok(near(plan.savedCost, spy.savedCost));
  // The account holds no SPY, so it buys B's 2,500: 25 shares.
  assert.deepEqual([spy.kind, spy.shares], ['open', 25]);
});

test('the band skips small resizes only: never an opening or a closing order', () => {
  // The strategy wants 50.5% of the account in SPY and 0.3% in IWM; the account holds 50 SPY and 0.5 of XLE, which the strategy sells.
  const S = strat('S', 1, 1000, [
    state('SPY', { shares: 5.05 }),
    state('IWM', { pending: 'buy', targetWeight: 0.003 }),
    state('XLE', { shares: 1, pending: 'sell' }),
  ]);
  const holdings = [
    { ticker: 'SPY', shares: 50 },
    { ticker: 'XLE', shares: 0.5 },
  ];
  // Managed: 4,950 in cash, 5,000 of SPY and 50 of XLE: 10,000.
  const banded = accountOrders(account({ cash: 4950, holdings, skipUnder: 0.01 }), [S]);
  const by = (p: typeof banded, t: string) => p.orders.find((o) => o.ticker === t)!;
  // SPY's half share (50 against 1% of 10,000) is skipped; IWM's 0.3 share opens a position, rounded to 0 shares;
  // the fraction of XLE is sold whole.
  assert.deepEqual([by(banded, 'SPY').skipped, by(banded, 'SPY').shares], [true, 0]);
  assert.deepEqual([by(banded, 'IWM').skipped, by(banded, 'IWM').kind, by(banded, 'IWM').shares], [false, 'open', 0]);
  assert.deepEqual([by(banded, 'XLE').skipped, by(banded, 'XLE').kind, by(banded, 'XLE').shares], [false, 'close', -0.5]);
  assert.ok(banded.notes.includes("IWM: the strategies' position comes to under half a share, so it is not bought."));
  // Without the band the half share rounds up to one.
  const plain = accountOrders(account({ cash: 4950, holdings }), [S]);
  assert.deepEqual([by(plain, 'SPY').skipped, by(plain, 'SPY').shares], [false, 1]);
  // In fractions, IWM is bought as it is.
  const fractions = accountOrders(account({ cash: 4950, holdings, wholeShares: false, skipUnder: 0.01 }), [S]);
  assert.ok(near(by(fractions, 'IWM').shares, 0.3, 1e-12));
});

test('with whole shares and a band, a resize of one share or less is skipped only when it is worth less than the band', () => {
  // One share of BRK.A-like 5,000 is 5% of 100,000; the strategy wants 2.8 shares where the account holds 2.
  const S = strat('S', 1, 100_000, [state('XYZ', { shares: 2.8, lastClose: 5000 })]);
  const holdings = [{ ticker: 'XYZ', shares: 2 }];
  // 0.8 of a share is 4,000, above the band of 1,000: it rounds to one share.
  const whole = accountOrders(account({ cash: 90_000, holdings, skipUnder: 0.01 }), [S]);
  assert.deepEqual([whole.orders[0].skipped, whole.orders[0].shares], [false, 1]);
  // 0.1 of a share is 500, under the band: skipped.
  const small = accountOrders(account({ cash: 90_000, holdings, skipUnder: 0.01 }), [strat('S', 1, 100_000, [state('XYZ', { shares: 2.1, lastClose: 5000 })])]);
  assert.deepEqual([small.orders[0].skipped, small.orders[0].shares], [true, 0]);
  // Unbanded, 0.8 of a share rounds to one.
  assert.equal(accountOrders(account({ cash: 90_000, holdings }), [S]).orders[0].shares, 1);
  // In fractions the band alone decides: 0.8 of a share is 4,000, above 1%.
  const fractions = accountOrders(account({ cash: 90_000, holdings, skipUnder: 0.01, wholeShares: false }), [S]);
  assert.deepEqual([fractions.orders[0].skipped, fractions.orders[0].shares], [false, 0.8]);
  // 1.2 shares are more than one: the order is made, rounded to one share.
  const more = accountOrders(account({ cash: 90_000, holdings, skipUnder: 0.01 }), [strat('S', 1, 100_000, [state('XYZ', { shares: 3.2, lastClose: 5000 })])]);
  assert.deepEqual([more.orders[0].skipped, more.orders[0].shares], [false, 1]);
});

test('whole shares never sell more than is held, and a closing order sells a fraction too', () => {
  // 10.6 shares held and a target of 0.04 shares: a resize rounded to a sale of 11 is cut to the 10.6 held.
  const S = strat('S', 1, 1000, [state('SPY', { shares: 0.004 })]);
  const plan = accountOrders(account({ cash: 0, holdings: [{ ticker: 'SPY', shares: 10.6 }] }), [S]);
  assert.equal(plan.orders[0].shares, -10.6);
  assert.equal(plan.cashAfter, 1060);
  // A small sale that rounds away is 0, not -0.
  const tiny = accountOrders(account({ cash: 0, holdings: [{ ticker: 'SPY', shares: 10 }] }), [strat('S', 1, 1000, [state('SPY', { shares: 9.96 })])]);
  assert.ok(Object.is(tiny.orders[0].shares, 0));
});

test('buys are cut to the cash and what the sales bring', () => {
  // The strategy holds half in SPY at 300 and half in TLT at 100. The account has 1,000 of TLT and no cash.
  const S = strat('S', 1, 1000, [state('SPY', { pending: 'buy', targetWeight: 0.5, lastClose: 300 }), state('TLT', { shares: 5 })]);
  const holdings = [{ ticker: 'TLT', shares: 10 }];
  // TLT's 5 shares sold bring 500; SPY's 1.67 shares round to 2, which cost 600: cut to 1.
  const whole = accountOrders(account({ holdings }), [S]);
  const spy = whole.orders.find((o) => o.ticker === 'SPY')!;
  assert.deepEqual([spy.shares, spy.cut], [1, true]);
  assert.equal(whole.cashAfter, 200);
  assert.ok(whole.notes.some((n) => n.startsWith('The buys come to $600')));
  // In fractions 1.67 shares cost exactly what the sale brings, and nothing is cut.
  const fractions = accountOrders(account({ holdings, wholeShares: false }), [S]);
  const fspy = fractions.orders.find((o) => o.ticker === 'SPY')!;
  assert.equal(fspy.cut, false);
  // Shares to 8 decimals leave a few millionths over.
  assert.ok(near(fractions.cashAfter, 0, 1e-5) && fractions.cashAfter >= 0);
  // With the trim skipped by a wide band, only the cash pays: 100 buys a third of a share.
  const banded = accountOrders(account({ cash: 100, holdings: [{ ticker: 'TLT', shares: 9.5 }], wholeShares: false, skipUnder: 0.5 }), [S]);
  const bspy = banded.orders.find((o) => o.ticker === 'SPY')!;
  assert.equal(banded.orders.find((o) => o.ticker === 'TLT')!.skipped, true);
  assert.ok(bspy.cut && near(bspy.shares, 1 / 3, 1e-8) && bspy.shares * 300 <= 100);
  assert.ok(banded.cashAfter >= 0);
});

test('a strategy listed at 0% gets no money, and what the account holds of its tickers is sold', () => {
  const Z = strat('Z', 0, 1000, [state('XLE', { shares: 5 })]);
  const A = strat('A', 1, 1000, [state('SPY', { shares: 10 })]);
  const plan = accountOrders(account({ cash: 0, holdings: [{ ticker: 'XLE', shares: 10 }, { ticker: 'SPY', shares: 10 }] }), [A, Z]);
  const xle = plan.orders.find((o) => o.ticker === 'XLE')!;
  assert.deepEqual([xle.kind, xle.shares, xle.parts], ['close', -10, [0, 0]]);
  // The proceeds buy SPY: 2,000 managed, all of it in SPY.
  assert.deepEqual(plan.orders.find((o) => o.ticker === 'SPY')!.shares, 10);
});

test('the price of a ticker two strategies trade is the one whose prices end latest', () => {
  const A = strat('A', 0.5, 1000, [state('SPY', { shares: 5, lastClose: 100 })]);
  const B = strat('B', 0.5, 1000, [state('SPY', { shares: 5, lastClose: 101 })], { asOf: T + 86_400_000 });
  const plan = accountOrders(account({ cash: 1000 }), [A, B]);
  assert.equal(plan.orders[0].price, 101);
});

test('notes: a rebalance a bar late, sizes that are estimates, fills at the close', () => {
  const S = strat('Rotation', 1, 1000, [state('SPY', { shares: 5 }), state('TLT', { pending: 'buy', targetWeight: 0.2 })], { rebalance: 'monthly', sizing: 'invvol' });
  const C = strat('Closer', 0, 1000, [state('QQQ', { shares: 1 })], { closeFill: true, sizing: 'risk' });
  const { notes } = accountOrders(account({ cash: 1000 }), [S, C]);
  assert.deepEqual(notes, [
    'Rotation rebalances monthly. A rebalance due at the next open shows here a bar late, once its backtest has made it.',
    'Rotation sizes positions by inverse volatility, so the size of a new one here is an estimate from the last close.',
    'Closer fills at the close: what it holds here already includes what it traded at the last close.',
  ]);
  // A strategy in cash has nothing to rebalance.
  assert.deepEqual(accountOrders(account({ cash: 1000 }), [strat('R', 1, 1000, [state('SPY')], { rebalance: 'weekly' })]).notes, []);
});

test('a ticker with no price is not managed, and nothing is ordered for it', () => {
  const S = strat('S', 1, 1000, [state('NEW', { lastClose: NaN }), state('SPY', { shares: 5 })]);
  const plan = accountOrders(account({ cash: 1000, holdings: [{ ticker: 'NEW', shares: 3 }] }), [S]);
  assert.deepEqual(plan.unmanaged, [{ ticker: 'NEW', shares: 3 }]);
  assert.deepEqual(plan.orders.map((o) => o.ticker), ['SPY']);
});

// --- From a run ----------------------------------------------------------------------------------------------------

test("an account's strategies are found and run as a compare block's are, each with its share", async () => {
  const fence = '```';
  const notes: Record<string, string> = { Trend: `${fence}strategy\nname: First\nuniverse: A\nbuy when true\n${fence}`, Dips: `${fence}strategy\nuniverse: A\nbuy when close < 12\n${fence}` };
  const data = new Map([['A', bars([10, 11, 12, 11, 13])]]);
  const host: CompareHost<{ basename: string; text: string }> = {
    note: (link) => (link in notes ? { basename: link, text: notes[link] } : null),
    read: async (f) => f.text,
    run: async (source) => {
      const spec = parseSpec(source).spec!;
      return { spec, backtest: runBacktest(spec, data), data, warnings: [], prices: [] };
    },
  };
  const runs = await runAccount(parseAccount('cash: 1\n[[Trend]]\n[[Dips|Buying dips]]').entries, host);
  assert.deepEqual(runs.map((r) => [r.label, r.alloc, r.entry.line]), [
    ['First', 0.5, 2],
    ['Buying dips', 0.5, 3],
  ]);
  assert.equal(runs[0].out.backtest.run.t.length, 5);
  await assert.rejects(runAccount(parseAccount('cash: 1\n[[Trend]] 50%\n[[Nowhere]] 0%').entries, host), { message: 'Line 3: there is no note called "Nowhere".' });
});

test("a run's last states, equity and costs, read into what the account needs", () => {
  const data = new Map([['A', bars([90, 95, 99, 101])]]);
  const spec = parseSpec('universe: A\ncapital: 1000\ncosts: 5 bps\nslippage: 2 bps\nbuy when close > 100\nsell when close < 80').spec!;
  const out = { spec, backtest: runBacktest(spec, data) };
  const s = accountStrategy('Trend', 0.4, out);
  assert.equal(s.label, 'Trend');
  assert.equal(s.alloc, 0.4);
  assert.equal(s.equity, out.backtest.run.equity[3]);
  assert.equal(s.asOf, out.backtest.run.t[3]);
  assert.ok(near(s.cost, 0.0007, 1e-15));
  assert.equal(s.closeFill, false);
  // The buy waits for the next open: the shares after it are its target weight of the equity at the last close.
  const [st] = s.states;
  assert.equal(st.pending, 'buy');
  assert.ok(near(sharesAfterOrders(st, s.equity), (st.targetWeight * s.equity) / 101, 1e-12));
});

test('with fill: close the state already holds what the last close bought', () => {
  const data = new Map([['A', bars([90, 95, 99, 101])]]);
  const spec = parseSpec('universe: A\ncapital: 1000\nfill: close\nbuy when close > 100\nsell when close < 80').spec!;
  const s = accountStrategy('Closer', 1, { spec, backtest: runBacktest(spec, data) });
  const [st] = s.states;
  assert.equal(s.closeFill, true);
  assert.equal(st.pending, null);
  assert.equal(st.filled?.side, 'buy');
  assert.ok(st.shares > 0);
  assert.equal(sharesAfterOrders(st, s.equity), st.shares);
  // So an account in cash buys what the strategy bought.
  const plan = accountOrders(account({ cash: 1000, wholeShares: false }), [s]);
  assert.ok(near(plan.orders[0].shares, (st.shares * 1000) / s.equity, 1e-8));
});

test('a resize of one share or less is made when it is worth more than the band', () => {
  // Two strategies hold 2 BKNG at 5,000 between them, half each; B sells, so the account's target is 1 share.
  const st = (o: Partial<AssetState>) => state('BKNG', { shares: 2, lastClose: 5000, ...o });
  const plan = accountOrders(account({ holdings: [{ ticker: 'BKNG', shares: 2 }], skipUnder: 0.01 }), [strat('A', 0.5, 10_000, [st({})]), strat('B', 0.5, 10_000, [st({ pending: 'sell' })])]);
  // The sale of 1 share is 5,000, far above the band of 100.
  assert.deepEqual([plan.orders[0].kind, plan.orders[0].skipped, plan.orders[0].shares], ['resize', false, -1]);
});

test('buys cut to the cash get whole shares back, largest remainder first, while the cash allows', () => {
  // Two buys of one share at 600 each with 1,000 of cash: both cut to 0 would leave 1,000 unused.
  const S = strat('S', 1, 10_000, [state('AAA', { pending: 'buy', targetWeight: 0.5, lastClose: 600 }), state('BBB', { pending: 'buy', targetWeight: 0.5, lastClose: 600 })]);
  const plan = accountOrders(account({ cash: 1000 }), [S]);
  assert.deepEqual(plan.orders.map((o) => [o.ticker, o.shares, o.cut]), [
    ['AAA', 1, true],
    ['BBB', 0, true],
  ]);
  assert.equal(plan.cashAfter, 400);
  // 640 of cash: CCC's 1.92 shares at 100 round to 2 and DDD's 0.64 at 500 to 1, 700 in all. Cut by 640/700 they are
  // 1.83 and 0.91, so 1 and 0, which leaves 540: DDD's larger remainder comes back first, and then CCC's share no longer fits.
  const T = strat('T', 1, 10_000, [state('CCC', { pending: 'buy', targetWeight: 0.3, lastClose: 100 }), state('DDD', { pending: 'buy', targetWeight: 0.5, lastClose: 500 })]);
  const two = accountOrders(account({ cash: 640 }), [T]);
  assert.deepEqual(two.orders.map((o) => [o.ticker, o.shares]), [
    ['CCC', 1],
    ['DDD', 1],
  ]);
  assert.equal(two.cashAfter, 40);
});

// --- Shorts and borrowed money -------------------------------------------------------------------------------------

const BORROWED = "Cash can't be below 0: the account holds no borrowed money";
const spec = (source: string) => parseSpec(`universe: A\ncapital: 1000\n${source}`).spec!;

test('a holding below 0 is a short, written with either minus sign', () => {
  const { config, errors } = parseAccount('holdings: SPY -50, TLT 20; QQQ −1,200\ncash: 1\n[[A]]');
  assert.deepEqual(errors, []);
  assert.deepEqual(config.holdings, [
    { ticker: 'SPY', shares: -50 },
    { ticker: 'TLT', shares: 20 },
    { ticker: 'QQQ', shares: -1200 },
  ]);
  assert.deepEqual(parseAccount('holdings: SPY -0\n[[A]]').errors, [{ line: 1, message: 'SPY has no shares: leave it out instead', from: 10, to: 16 }]);
  assert.match(parseAccount('holdings: SPY -10k\n[[A]]').errors[0].message, /"SPY -10k" is not a holding/);
  assert.match(parseAccount('holdings: SPY --5\n[[A]]').errors[0].message, /"SPY --5" is not a holding/);
});

test('cash below 0 waits for the strategies: one that can borrow allows it, and without one the error stands', () => {
  const parsed = parseAccount('cash: -2,000\n[[Lev]]');
  assert.equal(parsed.config.cash, -2000);
  assert.deepEqual(parsed.errors, [{ line: 1, message: BORROWED, from: 6, to: 12 }]);
  assert.equal(parsed.borrowed, parsed.errors[0]);
  assert.deepEqual(errorsBeforeRun(parsed), []);
  const long = { out: { spec: spec('buy when true') } };
  const short = { out: { spec: spec('short when close > 11') } };
  const leveraged = { out: { spec: parseSpec('universe: A 150%\nbuy when true').spec! } };
  assert.equal(borrowedError(parsed, [long]), parsed.borrowed);
  assert.equal(borrowedError(parsed, [long, short]), null);
  assert.equal(borrowedError(parsed, [leveraged]), null);
  assert.equal(parseAccount('cash: −2,000\n[[A]]').config.cash, -2000);
  // Other errors still stop the block before its strategies run; cash of 0 or more has nothing to lift.
  assert.deepEqual(errorsBeforeRun(parseAccount('cash: -1\nskip under: 1\n[[A]]')).map((e) => e.line), [2]);
  assert.deepEqual([parseAccount('cash: -0\n[[A]]').errors, parseAccount('cash: -0\n[[A]]').config.cash], [[], 0]);
  const words = parseAccount('cash: -lots\n[[A]]');
  assert.deepEqual([words.errors.map((e) => e.message), words.borrowed], [['"-lots" is not an amount of cash. Write it as 4,200 or 4200.50'], null]);
  assert.equal(borrowedError(parseAccount('cash: 5\n[[A]]'), [long]), null);
});

test("a strategy's shares on the short side once its waiting orders are made", () => {
  // A short at 40% of 1,000 at a last close of 50 is 8 shares; a flip ends on the other side; an add adds to the short.
  assert.equal(sharesAfterOrders(state('A', { pending: 'short', targetWeight: 0.4, lastClose: 50 }), 1000), -8);
  assert.equal(sharesAfterOrders(state('A', { shares: 7, pending: 'short', targetWeight: 0.4, lastClose: 50 }), 1000), -8);
  assert.equal(sharesAfterOrders(state('A', { shares: -7, pending: 'buy', targetWeight: 0.4, lastClose: 50 }), 1000), 8);
  assert.equal(sharesAfterOrders(state('A', { shares: -3, pending: 'add', targetWeight: 0.4, lastClose: 50 }), 1000), -11);
  assert.equal(sharesAfterOrders(state('A', { shares: -5, pending: 'cover' }), 1000), 0);
  assert.equal(sharesAfterOrders(state('A', { shares: -5 }), 1000), -5);
});

test('a long strategy and a short one on the same ticker net into one order, and what that spares adds up', () => {
  // A buys SPY with all of its 1,000 and B shorts it with half of its 1,000; the account's 20,000 is split equally.
  const A = strat('A', 0.5, 1000, [state('SPY', { pending: 'buy', targetWeight: 1 })], { cost: 0.001 });
  const B = strat('B', 0.5, 1000, [state('SPY', { pending: 'short', targetWeight: 0.5 })], { cost: 0.003, borrows: true });
  const plan = accountOrders(account({ cash: 20_000 }), [A, B]);
  const [spy] = plan.orders;
  // A's 10,000 long and B's 5,000 short come to 5,000 long: 50 shares bought, and 10,000 of trades spared.
  assert.deepEqual(spy.parts, [10_000, -5_000]);
  assert.deepEqual([spy.kind, spy.target, spy.shares], ['open', 50, 50]);
  assert.equal(spy.saved, 10_000);
  // At the strategies' costs weighted by what each trades: 10 and 15 on 15,000.
  assert.ok(near(spy.savedCost, 10_000 * (25 / 15_000), 1e-9));
  assert.ok(near(spy.parts[0] + spy.parts[1] + spy.drift, (spy.target - spy.holding) * spy.price, 1e-9));
  // B short all of its equity cancels A out: nothing to trade, and all 20,000 spared.
  const even = accountOrders(account({ cash: 20_000 }), [A, strat('B', 0.5, 1000, [state('SPY', { pending: 'short', targetWeight: 1 })], { borrows: true })]);
  assert.deepEqual(even.orders.map((o) => [o.kind, o.target, o.shares, o.saved]), [['open', 0, 0, 20_000]]);
  assert.deepEqual(even.notes, []);
  // With three quarters of the account, B's short outweighs A's long: the account sells short 100 shares.
  const shorter = accountOrders(account({ cash: 20_000 }), [{ ...A, alloc: 0.25 }, strat('B', 0.75, 1000, [state('SPY', { pending: 'short', targetWeight: 1 })], { borrows: true })]);
  assert.deepEqual(shorter.orders.map((o) => [o.target, o.shares, o.saved]), [[-100, -100, 10_000]]);
  assert.deepEqual(orderSteps(shorter.orders[0]), [{ action: 'short', shares: 100 }]);
  // A short sale brings cash.
  assert.equal(shorter.cashAfter, 30_000);
});

test('a flip takes the holding through 0: it sells all and sells short, or covers all and buys', () => {
  // 7,000 in cash and 30 SPY at 100 make 10,000. The strategy, long, flips to a short of half its equity: 50 shares.
  const toShort = strat('S', 1, 1000, [state('SPY', { shares: 10, pending: 'short', targetWeight: 0.5 })], { borrows: true });
  const plan = accountOrders(account({ cash: 7000, holdings: [{ ticker: 'SPY', shares: 30 }] }), [toShort]);
  const [spy] = plan.orders;
  assert.deepEqual([spy.kind, spy.holding, spy.target, spy.shares, spy.skipped], ['flip', 30, -50, -80, false]);
  assert.deepEqual(orderSteps(spy), [
    { action: 'sell', shares: 30 },
    { action: 'short', shares: 50 },
  ]);
  assert.equal(plan.cashAfter, 15_000);
  // A fraction held is sold whole, and the short is in whole shares.
  const fraction = accountOrders(account({ cash: 6950, holdings: [{ ticker: 'SPY', shares: 30.5 }] }), [toShort]);
  assert.deepEqual(orderSteps(fraction.orders[0]), [
    { action: 'sell', shares: 30.5 },
    { action: 'short', shares: 50 },
  ]);
  // Short 20 with 12,000 in cash, 10,000 managed; the strategy flips to a long of 60%: 20 covered, then 60 bought.
  const toLong = strat('S', 1, 1000, [state('SPY', { shares: -5, pending: 'buy', targetWeight: 0.6 })], { borrows: true });
  const back = accountOrders(account({ cash: 12_000, holdings: [{ ticker: 'SPY', shares: -20 }] }), [toLong]);
  assert.equal(back.managed, 10_000);
  assert.deepEqual([back.orders[0].kind, back.orders[0].shares, back.orders[0].cut], ['flip', 80, false]);
  assert.deepEqual(orderSteps(back.orders[0]), [
    { action: 'cover', shares: 20 },
    { action: 'buy', shares: 60 },
  ]);
  assert.equal(back.cashAfter, 4000);
  // A short of under half a share is not made: the flip only sells.
  const tiny = accountOrders(account({ cash: 7000, holdings: [{ ticker: 'SPY', shares: 30 }] }), [strat('S', 1, 1000, [state('SPY', { shares: 10, pending: 'short', targetWeight: 0.004 })], { borrows: true })]);
  assert.deepEqual(orderSteps(tiny.orders[0]), [{ action: 'sell', shares: 30 }]);
  assert.ok(tiny.notes.includes("SPY: the strategies' position comes to under half a share, so it is not sold short."));
});

test('whole shares on the short side: a cover never goes past 0, and the band and rounding work as for a long', () => {
  // Short 10.6 shares where the strategy is short 0.004 of a share: a cover rounded to 11 is cut to the 10.6 owed.
  const plan = accountOrders(account({ cash: 2060, holdings: [{ ticker: 'SPY', shares: -10.6 }] }), [strat('S', 1, 1000, [state('SPY', { shares: -0.004 })], { borrows: true })]);
  assert.deepEqual([plan.orders[0].kind, plan.orders[0].shares], ['resize', 10.6]);
  assert.equal(plan.cashAfter, 1000);
  // Short 50 in an account of 10,000 where the strategy is short 50.6: 60 to sell short is under a band of 1%, and without it rounds to 1 share.
  const S = strat('S', 1, 1000, [state('SPY', { shares: -5.06 })], { borrows: true });
  const holdings = [{ ticker: 'SPY', shares: -50 }];
  assert.deepEqual(accountOrders(account({ cash: 15_000, holdings, skipUnder: 0.01 }), [S]).orders.map((o) => [o.skipped, o.shares]), [[true, 0]]);
  assert.deepEqual(accountOrders(account({ cash: 15_000, holdings }), [S]).orders.map((o) => [o.skipped, o.shares]), [[false, -1]]);
  // A new short rounds to whole shares; one under half a share is not made, and says so.
  const open = (targetWeight: number) => accountOrders(account({ cash: 1000 }), [strat('S', 1, 1000, [state('SPY', { pending: 'short', targetWeight })], { borrows: true })]);
  assert.equal(open(0.26).orders[0].shares, -3);
  assert.equal(open(0.03).orders[0].shares, 0);
  assert.deepEqual(open(0.03).notes, ["SPY: the strategies' position comes to under half a share, so it is not sold short."]);
  // In fractions the short is as it is.
  assert.ok(near(accountOrders(account({ cash: 1000, wholeShares: false }), [strat('S', 1, 1000, [state('SPY', { pending: 'short', targetWeight: 0.26 })])]).orders[0].shares, -2.6, 1e-12));
});

test('the cash: a short sale brings it, a cover spends it and is never cut, and a strategy that borrows lets it go below 0', () => {
  // Short 50 SPY with 9,000 in cash: 4,000 managed. The strategy covers SPY and buys QQQ at 130 with all of its equity:
  // 30.77 shares, rounded to 31, which cost 4,030.
  const S = strat('S', 1, 1000, [state('SPY', { shares: -5, pending: 'cover' }), state('QQQ', { pending: 'buy', targetWeight: 1, lastClose: 130 })], { borrows: true });
  const plan = accountOrders(account({ cash: 9000, holdings: [{ ticker: 'SPY', shares: -50 }] }), [S]);
  // The cover's 5,000 is paid in full, which leaves 4,000 for QQQ: 30 shares.
  assert.deepEqual(plan.orders.map((o) => [o.ticker, o.kind, o.shares, o.cut]), [
    ['SPY', 'close', 50, false],
    ['QQQ', 'open', 30, true],
  ]);
  assert.equal(plan.cashAfter, 100);
  assert.ok(plan.notes.includes('The buys come to $4,030, more than the cash and the sales bring after the covers ($4,000), so each is cut to fit.'), plan.notes.join('|'));
  // Selling 5 SPY short brings 500, which with the 1,000 of cash pays for 14 QQQ.
  const proceeds = accountOrders(account({ cash: 1000 }), [strat('S', 1, 1000, [state('SPY', { pending: 'short', targetWeight: 0.5 }), state('QQQ', { pending: 'buy', targetWeight: 1.4 })], { borrows: true })]);
  assert.deepEqual(proceeds.orders.map((o) => [o.ticker, o.shares, o.cut]), [
    ['QQQ', 14, false],
    ['SPY', -5, false],
  ]);
  assert.equal(proceeds.cashAfter, 100);
  // A strategy at 150% borrows half of the 10,000: the account buys 150 shares and ends 5,000 below 0.
  const lev = (o: Partial<AccountStrategy>, lastClose = 100) => strat('L', 1, 1000, [state('SPY', { pending: 'buy', targetWeight: 1.5, lastClose })], o);
  const borrowed = accountOrders(account({ cash: 10_000 }), [lev({ borrows: true })]);
  assert.deepEqual([borrowed.orders[0].shares, borrowed.orders[0].cut, borrowed.cashAfter], [150, false, -5000]);
  // A strategy that does not borrow is held to the cash, as before.
  assert.deepEqual(accountOrders(account({ cash: 10_000 }), [lev({})]).orders.map((o) => [o.shares, o.cut]), [[100, true]]);
  // Rounding past what the strategy borrows is cut, as rounding past the cash is: 93.75 shares at 160 round to 94, which is 15,040.
  const rounded = accountOrders(account({ cash: 10_000 }), [lev({ borrows: true }, 160)]);
  assert.deepEqual([rounded.orders[0].shares, rounded.orders[0].cut, rounded.cashAfter], [93, true, -4880]);
  assert.match(rounded.notes[0], /more than the cash, the sales and the strategies' borrowing allow/);
});

test('sales and covers come before purchases and short sales, each by ticker', () => {
  // 10,000 in cash, 10 SPY and 10 TLT short. The strategy sells SPY, covers TLT, buys QQQ and sells IWM short.
  const S = strat('S', 1, 1000, [
    state('QQQ', { pending: 'buy', targetWeight: 0.3 }),
    state('IWM', { pending: 'short', targetWeight: 0.3 }),
    state('TLT', { shares: -1, pending: 'cover' }),
    state('SPY', { shares: 1, pending: 'sell' }),
  ], { borrows: true });
  const plan = accountOrders(account({ cash: 10_000, holdings: [{ ticker: 'SPY', shares: 10 }, { ticker: 'TLT', shares: -10 }] }), [S]);
  assert.deepEqual(plan.orders.map((o) => [o.ticker, o.shares]), [
    ['SPY', -10],
    ['TLT', 10],
    ['IWM', -30],
    ['QQQ', 30],
  ]);
  assert.equal(plan.managed, 10_000);
  assert.equal(plan.cashAfter, 10_000);
});

test('notes: a strategy that holds a short rebalances, and one that sizes sizes its short sales too', () => {
  const S = strat('Shorts', 1, 1000, [state('SPY', { shares: -5 }), state('TLT', { pending: 'short', targetWeight: 0.2 })], { rebalance: 'monthly', sizing: 'invvol' });
  assert.deepEqual(accountOrders(account({ cash: 1000 }), [S]).notes, [
    'Shorts rebalances monthly. A rebalance due at the next open shows here a bar late, once its backtest has made it.',
    'Shorts sizes positions by inverse volatility, so the size of a new one here is an estimate from the last close.',
  ]);
});

test('an order in words on the short side, for the orders window', () => {
  assert.equal(accountOrderText({ shares: -5, kind: 'open', holding: 0 }), 'Sell short 5 shares');
  assert.equal(accountOrderText({ shares: -2, kind: 'resize', holding: -5 }), 'Sell short 2 shares');
  assert.equal(accountOrderText({ shares: 1, kind: 'resize', holding: -5 }), 'Buy to cover 1 share');
  assert.equal(accountOrderText({ shares: 5, kind: 'close', holding: -5 }), 'Buy to cover all 5 shares');
  assert.equal(accountOrderText({ shares: -80, kind: 'flip', holding: 30 }), 'Flip: sell 30 shares, then sell short 50 shares');
  assert.equal(accountOrderText({ shares: 80, kind: 'flip', holding: -20 }), 'Flip: buy to cover 20 shares, then buy 60 shares');
  assert.equal(accountOrderText({ shares: -30, kind: 'flip', holding: 30 }), 'Sell all 30 shares');
});

const FENCE = '```';
const BORROWING: Record<string, string> = {
  Short: `${FENCE}strategy\nuniverse: A\ncapital: 1000\nshort when close > 11\ncover when close < 9\n${FENCE}`,
  Lev: `${FENCE}strategy\nuniverse: A 150%\ncapital: 1000\nbuy when true\n${FENCE}`,
  Hold: `${FENCE}strategy\nuniverse: A\ncapital: 1000\nbuy when true\n${FENCE}`,
};

test("the vault's accounts: cash below 0 is allowed where a strategy borrows, and a short strategy's order is a short sale", async () => {
  const data = new Map([['A', bars([10, 11, 12])]]);
  const run = async (source: string): Promise<RunOutput> => {
    const s = parseSpec(source).spec!;
    return { spec: s, backtest: runBacktest(s, data), data, warnings: [], prices: [] };
  };
  const host = (sources: string[]) => ({
    find: async () => sources.map((source, i) => ({ note: `${i}.md`, name: String(i), source })),
    strategies: (): CompareHost<{ basename: string; text: string }> => ({
      note: (link) => (link in BORROWING ? { basename: link, text: BORROWING[link] } : null),
      read: async (f) => f.text,
      run,
    }),
  });
  const [lev, plain, short] = await scanAccounts(host(['cash: -500\nholdings: A 100\n[[Lev]]', 'cash: -500\nholdings: A 100\n[[Hold]]', 'cash: 2,000\n[[Short]]']));
  assert.equal(lev.error, null);
  assert.equal(plain.error, `Line 1: ${BORROWED}`);
  // Short all of 2,000 at the last close of 12: 166.67 shares, rounded to 167.
  assert.deepEqual(short.orders.map((o) => [o.ticker, o.kind, o.shares, accountOrderText(o)]), [['A', 'open', -167, 'Sell short 167 shares']]);
  const s = accountStrategy('Short', 1, await run(BORROWING.Short.split('\n').slice(1, -1).join('\n')));
  assert.equal(s.borrows, true);
  assert.equal(accountStrategy('Hold', 1, await run(BORROWING.Hold.split('\n').slice(1, -1).join('\n'))).borrows, false);
});
