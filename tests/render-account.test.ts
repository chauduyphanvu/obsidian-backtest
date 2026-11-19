import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { accountOrders, type AccountStrategy } from '../src/account.ts';
import type { AssetState, FillLog } from '../src/engine.ts';
import { headerGuess, readFills, type FillsRead, type MatchRow, type Reconciliation } from '../src/fills.ts';
import { asOfLine, costHeadline, costParts, dollars, fillsSetup, matchCells, matchNotes, orderRows, picksText, planLines, rawWanted, readLines, readNone, tickerCells } from '../src/render-account.ts';
import type { RunOutput } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { bars } from './helpers.ts';

const T = Date.UTC(2026, 10, 13);

function state(name: string, o: Partial<AssetState> = {}): AssetState {
  const st: AssetState = { name, weight: 1, side: null, since: null, pending: null, shares: 0, lastClose: 100, value: 0, targetWeight: 0, ...o };
  st.side = st.shares > 0 ? 'long' : st.shares < 0 ? 'short' : null;
  st.value = st.shares * st.lastClose;
  return st;
}
const strat = (label: string, alloc: number, equity: number, states: AssetState[], o: Partial<AccountStrategy> = {}): AccountStrategy => ({
  label,
  alloc,
  equity,
  asOf: T,
  states,
  closeFill: false,
  rebalance: 'never',
  sizing: 'fixed',
  cost: 0.001,
  ...o,
});
const account = { holdings: [], cash: 0, wholeShares: true, skipUnder: 0 };

test('each order says what to do, how much, and which strategy it comes from', () => {
  // The two-strategy account of the account tests: A buys TLT, B sells SPY and opens QQQ.
  const A = strat('A', 0.5, 1000, [state('SPY', { shares: 5 }), state('TLT', { pending: 'buy', targetWeight: 0.4, lastClose: 50 })]);
  const B = strat('B', 0.5, 2000, [state('SPY', { shares: 10, pending: 'sell' }), state('QQQ', { pending: 'buy', targetWeight: 0.5, lastClose: 200 })]);
  const holdings = [
    { ticker: 'SPY', shares: 50 },
    { ticker: 'TLT', shares: 100 },
    { ticker: 'AAPL', shares: 10 },
  ];
  const plan = accountOrders({ ...account, cash: 10_000, holdings }, [A, B]);
  assert.deepEqual(orderRows(plan, ['A', 'B']), [
    { ticker: 'TLT', order: 'Sell', shares: '20', price: '50.00', value: '$1,000', holding: '100 → 80', from: 'A +$4,000, drift −$5,000', side: -1 },
    { ticker: 'QQQ', order: 'Buy', shares: '25', price: '200.00', value: '$5,000', holding: '0 → 25', from: 'B +$5,000', side: 1 },
    { ticker: 'SPY', order: 'No order', shares: '', price: '100.00', value: '', holding: '50 → 50', from: 'B −$5,000, drift +$5,000', side: 0 },
  ]);
  assert.deepEqual(planLines(plan), [
    'The strategies use $20k: the cash and the holdings of the tickers that they trade, at the last closes. Cash after the orders: $6,000.',
    'No orders for these holdings, because no strategy in the block trades them: AAPL 10.',
  ]);
});

test('a closing order sells all, a small resize is skipped, and buys cut to the cash say so', () => {
  const close = accountOrders({ ...account, holdings: [{ ticker: 'SPY', shares: 3 }] }, [strat('A', 1, 1000, [state('SPY', { shares: 2, pending: 'sell' })])]);
  assert.deepEqual(orderRows(close, ['A']).map((r) => [r.order, r.shares, r.side]), [['Sell all', '3', -1]]);
  const small = accountOrders({ ...account, cash: 5, skipUnder: 0.05, holdings: [{ ticker: 'SPY', shares: 10 }] }, [strat('A', 1, 1000, [state('SPY', { shares: 9.9 })])]);
  assert.equal(orderRows(small, ['A'])[0].order, 'Skip: small');
  const cut = accountOrders({ ...account, cash: 1000 }, [strat('A', 1, 1000, [state('SPY', { pending: 'buy', targetWeight: 2, lastClose: 100 })])]);
  assert.deepEqual(orderRows(cut, ['A']).map((r) => [r.order, r.shares]), [['Buy, made smaller for the cash', '10']]);
  assert.match(planLines(cut).at(-1)!, /^The buys cost \$2,000\. This is more than the cash and the sales can pay \(\$1,000\)\. Thus the plugin makes each buy smaller\.$/);
});

test('what trading the orders as one spares is said in money and in costs', () => {
  const A = strat('A', 0.5, 1000, [state('SPY', { pending: 'buy', targetWeight: 0.5 })]);
  const B = strat('B', 0.5, 1000, [state('SPY', { shares: 5, pending: 'sell' })]);
  const plan = accountOrders({ ...account, cash: 500, holdings: [{ ticker: 'SPY', shares: 5 }] }, [A, B]);
  assert.equal(planLines(plan)[1], 'The plugin adds the orders of the strategies together. Compared with one order for each strategy, this saves $500 of trades and $0.50 of costs.');
});

test('orders on the short side say so, a flip gives both steps, and short holdings read with a minus', () => {
  // 13,000 in cash, SPY and XLE short, GME short that no strategy trades: 10,000 managed. The strategy flips SPY to a
  // long of 60%, covers XLE and sells QQQ short.
  const S = strat(
    'S',
    1,
    1000,
    [state('SPY', { shares: -5, pending: 'buy', targetWeight: 0.6 }), state('XLE', { shares: -1, pending: 'cover' }), state('QQQ', { pending: 'short', targetWeight: 0.2 })],
    { borrows: true },
  );
  const holdings = [
    { ticker: 'SPY', shares: -20 },
    { ticker: 'XLE', shares: -10 },
    { ticker: 'GME', shares: -10 },
  ];
  const plan = accountOrders({ ...account, cash: 13_000, holdings }, [S]);
  assert.deepEqual(
    orderRows(plan, ['S']).map((r) => [r.ticker, r.order, r.shares, r.value, r.holding, r.side]),
    [
      ['SPY', 'Flip: buy to cover 20, then buy 60', '80', '$8,000', '−20 → 60', 1],
      ['XLE', 'Buy to cover all', '10', '$1,000', '−10 → 0', 1],
      ['QQQ', 'Sell short', '20', '$2,000', '0 → −20', -1],
    ],
  );
  assert.deepEqual(planLines(plan), [
    'The strategies use $10k: the cash and the holdings of the tickers that they trade, at the last closes. Cash after the orders: $6,000.',
    'No orders for these holdings, because no strategy in the block trades them: GME −10.',
  ]);
  // Held long and flipped to a short of 50, and a short added to.
  const flip = accountOrders({ ...account, cash: 7000, holdings: [{ ticker: 'SPY', shares: 30 }] }, [strat('S', 1, 1000, [state('SPY', { shares: 10, pending: 'short', targetWeight: 0.5 })])]);
  assert.deepEqual(orderRows(flip, ['S']).map((r) => [r.order, r.shares, r.side]), [['Flip: sell 30, then sell short 50', '80', -1]]);
  const more = accountOrders({ ...account, cash: 15_000, holdings: [{ ticker: 'SPY', shares: -50 }] }, [strat('S', 1, 1000, [state('SPY', { shares: -6 })])]);
  assert.deepEqual(orderRows(more, ['S']).map((r) => [r.order, r.shares, r.holding]), [['Sell short', '10', '−50 → −60']]);
});

test('an account that borrows: cash below 0 reads with a minus', () => {
  // 120 SPY and 2,000 borrowed: 10,000 managed, which a strategy at 150% holds 15,000 of.
  const L = strat('L', 1, 1000, [state('SPY', { shares: 15 })], { borrows: true });
  const plan = accountOrders({ ...account, cash: -2000, holdings: [{ ticker: 'SPY', shares: 120 }] }, [L]);
  assert.deepEqual(orderRows(plan, ['L']).map((r) => [r.order, r.shares]), [['Buy', '30']]);
  assert.equal(planLines(plan)[0], 'The strategies use $10k: the cash and the holdings of the tickers that they trade, at the last closes. Cash after the orders: −$5,000.');
});

test('the orders are for the next open after the last bar, said once when every strategy agrees', () => {
  assert.equal(asOfLine([{ label: 'A', asOf: T }, { label: 'B', asOf: T }]), "For the next open, from the last bar of the strategies, 2026-11-13.");
  assert.equal(asOfLine([{ label: 'A', asOf: T }, { label: 'B', asOf: T + 14.5 * 3_600_000 }]), "For the next open, from the last bar of each strategy: A 2026-11-13, B 2026-11-13 14:30.");
});

test('money to the cent', () => {
  assert.deepEqual([dollars(1234.567), dollars(-12.3), dollars(-0.001), dollars(0)], ['$1,234.57', '−$12.30', '$0.00', '$0.00']);
});

// --- Fills ----------------------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const log = (rows: [number, string, number][]): FillLog => ({
  t: rows.map((r) => r[0]),
  asset: rows.map((r) => r[1]),
  kind: rows.map(() => 'entry' as const),
  sharesAfter: rows.map((r) => r[2]),
  price: rows.map(() => 100),
});

function fakeRun(label: string, universe: { name: string; source: 'yahoo' | 'binance' | 'tiingo' | 'csv' }[], data: [string, Bars][], prices: { name: string; source: string }[], fills: FillLog) {
  const run = { t: data[0][1].t, equity: data[0][1].t.map(() => 1000), fills };
  const out = { spec: { universe: universe.map((u) => ({ ...u, id: u.name })) }, data: new Map(data), prices, backtest: { run } } as unknown as RunOutput;
  return { label, alloc: 0.5, out };
}

test('what the fills are set against: each ticker from the strategy whose prices end latest, and which are adjusted', () => {
  const shortSpy = bars([1, 2, 3], { start: T });
  const longSpy = bars([1, 2, 3, 4], { start: T });
  const btc = bars([5, 6, 7], { start: T });
  const a = fakeRun('A', [{ name: 'SPY', source: 'yahoo' }], [['SPY', shortSpy]], [{ name: 'SPY', source: 'yahoo' }], log([[T, 'SPY', 3]]));
  // B's SPY came from Tiingo, standing in for Yahoo.
  const b = fakeRun('B', [{ name: 'SPY', source: 'yahoo' }, { name: 'BTCUSDT', source: 'binance' }], [['SPY', longSpy], ['BTCUSDT', btc]], [{ name: 'SPY', source: 'tiingo' }, { name: 'BTCUSDT', source: 'binance' }], log([[T + DAY, 'BTCUSDT', 1]]));
  const setup = fillsSetup([a, b]);
  assert.deepEqual([...setup.bars.keys()], ['SPY', 'BTCUSDT']);
  assert.equal(setup.bars.get('SPY'), longSpy);
  assert.deepEqual(setup.last, { SPY: 4, BTCUSDT: 7 });
  // Each strategy keeps its own bars of what it trades.
  assert.deepEqual(setup.followed.map((f) => [...f.bars!.values()]), [[shortSpy], [longSpy, btc]]);
  assert.deepEqual([...setup.adjusted.values()], [{ name: 'SPY', source: 'tiingo', id: 'SPY' }]);
  assert.deepEqual(setup.followed.map((f) => [f.label, f.alloc, f.log.asset]), [['A', 0.5, ['SPY']], ['B', 0.5, ['BTCUSDT']]]);
  // Prices as they traded are wanted only for adjusted tickers traded from the day the account started following.
  assert.deepEqual(rawWanted(setup, [], T).map((r) => r.name), ['SPY']);
  assert.deepEqual(rawWanted(setup, [], T + DAY), []);
  assert.deepEqual(rawWanted(setup, [{ date: T + DAY, ticker: 'SPY' }], T + DAY).map((r) => r.name), ['SPY']);
  assert.deepEqual(rawWanted(setup, [{ date: T, ticker: 'SPY' }], T + DAY), []);
});

const READ: FillsRead = {
  ok: true,
  format: 'Charles Schwab',
  columns: { date: 'Date', ticker: 'Symbol', side: 'Action', quantity: 'Quantity', price: 'Price', fees: ['Fees & Comm'] },
  fills: [{ date: T, ticker: 'SPY', side: 'buy', quantity: 1, price: 1, fees: 0, line: 2 }],
  left: { dividends: 3, reinvestments: 1, transfers: 0, other: 2 },
  untraded: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((ticker, i) => ({ ticker, rows: 9 - i })),
  unread: [5, 6, 7, 8].map((line) => ({ line, why: 'it has no ticker' })),
  ignored: 4,
};

test('what was read from the file and what was left out, each kind counted', () => {
  assert.deepEqual(readLines(READ), [
    'The plugin read 1 buy or sell as a Charles Schwab export.',
    'Not included, because they are not buys or sells of shares: 3 dividends, 1 reinvestment, 2 other rows.',
    'Not included, because no strategy in the block trades them: A (9), B (8), C (7), D (6), E (5), F (4) and 2 others.',
    'The plugin cannot read 4 rows: line 5: it has no ticker; line 6: it has no ticker; line 7: it has no ticker; ….',
  ]);
  const plain = { ...READ, format: null, fills: [], left: { dividends: 0, reinvestments: 0, transfers: 0, other: 0 }, untraded: [], unread: [] };
  assert.deepEqual(readLines(plain), ['The plugin read 0 buys and sells from the names of its columns.']);
});

test('a file of which no row could be read is not compared, and says so; a format starting with a vowel takes "an"', () => {
  const none = { ...READ, fills: [], untraded: [], unread: [{ line: 2, why: 'the plugin cannot read the action "SLD" as a buy or a sell' }] };
  assert.equal(readNone(none), true);
  assert.equal(readNone(READ), false);
  // Rows of tickers no strategy trades were read, so the columns are right.
  assert.equal(readNone({ ...none, untraded: [{ ticker: 'A', rows: 1 }] }), false);
  assert.deepEqual(readLines({ ...none, format: null, left: { dividends: 0, reinvestments: 0, transfers: 0, other: 0 } }), [
    'The plugin read 0 buys and sells from the names of its columns.',
    'The plugin cannot read 1 row: line 2: the plugin cannot read the action "SLD" as a buy or a sell.',
    'The plugin read no row as a buy or a sell. Thus it compares no trades. Make sure that each part of a trade has the correct column.',
  ]);
  assert.equal(readLines({ ...READ, format: 'Interactive Brokers Flex query' })[0], 'The plugin read 1 buy or sell as an Interactive Brokers Flex query export.');
});

function row(o: Partial<MatchRow>): MatchRow {
  return { ticker: 'SPY', class: 'on time', model: null, yours: null, daysLate: null, bps: null, slippage: 0, late: 0, skipped: 0, fees: 0, move: null, outside: false, unpriced: false, ...o };
}
const model = (o: Partial<NonNullable<MatchRow['model']>> = {}) => ({ day: T, side: 'buy' as const, quantity: 10, value: 1000, price: 100, strategies: [0], ...o });
const yours = (o: Partial<NonNullable<MatchRow['yours']>> = {}) => ({ day: T, side: 'buy' as const, quantity: 10, price: 100.5, fees: 1, lines: [2], ...o });

test('the headline is the sum of the parts: a cost, a gain, nothing, or no trade at all', () => {
  assert.equal(costHeadline({ rows: [row({})], total: 12.345 }, T), 'From 2026-11-13, the differences between your trades and the strategies cost $12.35.');
  assert.equal(costHeadline({ rows: [row({})], total: -40 }, T), 'From 2026-11-13, the differences between your trades and the strategies made $40.00.');
  assert.equal(costHeadline({ rows: [row({})], total: 0.001 }, T), 'From 2026-11-13, the differences between your trades and the strategies cost nothing.');
  assert.equal(costHeadline({ rows: [], total: 0 }, T), 'From 2026-11-13, you and the strategies did not trade.');
  assert.deepEqual(costParts({ parts: { slippage: 5, fees: 2, late: -1, skipped: 30 } }).map((p) => [p.name, p.value]), [
    ['Slippage', '$5.00'],
    ['Fees', '$2.00'],
    ['Late fills', '−$1.00'],
    ['Trades not made', '$30.00'],
  ]);
});

test('each trade in the table: how it went, both sides, your price against theirs and its cost', () => {
  assert.deepEqual(matchCells(row({ model: model(), yours: yours(), bps: 50, slippage: 5, fees: 1 })), ['2026-11-13', 'SPY', 'On time', 'Buy 10 at 100.00', 'Buy 10 at 100.50', '+50.0 bps', '$6.00']);
  assert.deepEqual(matchCells(row({ class: 'late', model: model({ quantity: null, value: null }), yours: yours({ day: T + 2 * DAY }), daysLate: 2, late: 5, fees: 1 }))[2], 'Late by 2 trading days');
  assert.deepEqual(matchCells(row({ class: 'late', model: model({ quantity: null }), yours: yours(), daysLate: 1 }))[3], 'Buy at 100.00');
  const skipped = matchCells(row({ class: 'skipped', model: model({ side: 'sell' }), move: -0.031, skipped: -31 }));
  assert.deepEqual(skipped.slice(2), ['Not made, loss of 3.1% if made', 'Sell 10 at 100.00', '–', '', '−$31.00']);
  assert.equal(matchCells(row({ class: 'partial', model: model({ quantity: 4 }), move: 0.05, skipped: 20 }))[2], 'Part filled: the remaining shares not made, profit of 5.0% if made');
  assert.deepEqual(matchCells(row({ class: 'waiting', model: model() })).slice(-1), ['']);
  assert.deepEqual(matchCells(row({ class: 'off-plan', yours: yours({ day: T + DAY }), fees: 1 })), ['2026-11-14', 'SPY', 'Off plan', '–', 'Buy 10 at 100.50', '', '$1.00']);
  assert.equal(matchCells(row({ model: model(), yours: yours({ price: 400 }), outside: true }))[5], 'not in the day’s range');
  assert.equal(matchCells(row({ model: model({ price: NaN }), yours: yours(), unpriced: true }))[3], 'Buy 10 at unknown');
});

test('trades on the short side in the table: a short sale, a cover and a flip each way', () => {
  const cells = matchCells(row({ model: model({ side: 'sell', action: 'short' }), yours: yours({ side: 'sell', action: 'short', price: 99.5 }), bps: 50, slippage: 5, fees: 1 }));
  assert.deepEqual(cells.slice(3), ['Sell short 10 at 100.00', 'Sell short 10 at 99.50', '+50.0 bps', '$6.00']);
  assert.equal(matchCells(row({ model: model({ action: 'cover' }), yours: yours() }))[3], 'Buy to cover 10 at 100.00');
  // Your file need not say it was a cover: a purchase is then a purchase.
  assert.equal(matchCells(row({ model: model({ action: 'cover' }), yours: yours() }))[4], 'Buy 10 at 100.50');
  assert.equal(matchCells(row({ model: model({ action: 'flip' }) }))[3], 'Flip to long 10 at 100.00');
  assert.equal(matchCells(row({ class: 'off-plan', yours: yours({ side: 'sell', action: 'flip' }) }))[4], 'Flip to short 10 at 100.50');
});

test('each ticker: how its trades went and what they cost, part by part', () => {
  const counts = { 'on time': 3, partial: 1, oversized: 0, late: 1, skipped: 0, waiting: 0, 'off-plan': 2 };
  assert.deepEqual(tickerCells({ ticker: 'SPY', slippage: 4.5, bps: 3.04, fees: 2, late: -1, skipped: 0, counts }), ['SPY', '3 on time, 1 part filled, 1 late, 2 off plan', '$4.50 (3.0 bps)', '$2.00', '−$1.00', '$0.00']);
  assert.equal(tickerCells({ ticker: 'SPY', slippage: 0, bps: null, fees: 0, late: 0, skipped: 0, counts })[2], '$0.00');
});

test('the notes under the costs say what was not compared and why', () => {
  const rec = (o: Partial<Reconciliation>): Reconciliation => ({ rows: [], tickers: [], parts: { slippage: 0, fees: 0, late: 0, skipped: 0 }, total: 0, sized: true, before: 0, suggested: [], ...o });
  assert.equal(matchNotes(rec({}), T).length, 1);
  const notes = matchNotes(
    rec({
      sized: false,
      before: 2,
      rows: [row({ outside: true, yours: yours() }), row({ unpriced: true, yours: yours() }), row({ unpriced: true, yours: yours() }), row({ class: 'waiting', model: model() })],
    }),
    T,
  );
  assert.deepEqual(notes.slice(1), [
    'This block has no capital at start. Thus the plugin does not compare sizes or show the trades not made in money.',
    '1 fill of yours is more than 3% above or below the range of the day as it traded. The usual cause is a split. The plugin does not compare it on price.',
    'The plugin does not compare 2 fills on price, because the prices of that day as they traded are unknown.',
    '1 trade of the strategies is pending. A fill in the next days counts as late.',
    'The plugin does not include 2 fills before 2026-11-13.',
  ]);
});

// --- Naming the columns by hand -----------------------------------------------------------------------------------------

const ODD = ['My broker export', 'Generated 2026-11-14', '', 'When;What;Ticker symbol;Units;Paid each;Charges', '2026-11-13;Bought;SPY;10;100.5;1', 'Total;;;;;1'].join('\n');

test("an unrecognised export's header is the line with the most columns, and its parts are named by hand", () => {
  assert.equal(readFills(ODD, ['SPY']).ok, false);
  const guess = headerGuess(ODD)!;
  assert.deepEqual(guess.header, ['When', 'What', 'Ticker symbol', 'Units', 'Paid each', 'Charges']);
  // Only Units is a usual header, of the quantity.
  assert.deepEqual([guess.at.date, guess.at.ticker, guess.at.quantity, guess.at.price, guess.fees], [-1, -1, 3, -1, []]);
  assert.deepEqual(picksText(guess.header, { date: 0, ticker: 2, side: -1, quantity: -1, price: -1, fees: -1 }), { missing: ['quantity', 'price'] });
  const picked = picksText(guess.header, { date: 0, ticker: 2, side: 1, quantity: 3, price: 4, fees: 5 });
  assert.deepEqual(picked, { text: 'date = When; ticker = Ticker symbol; side = What; quantity = Units; price = Paid each; fees = Charges' });
  // Saved in the block, the same file reads.
  const read = readFills(ODD, ['SPY'], { date: 'When', ticker: 'Ticker symbol', side: 'What', quantity: 'Units', price: 'Paid each', fees: ['Charges'] });
  assert.ok(read.ok);
  assert.deepEqual(read.fills.map((f) => [f.ticker, f.side, f.quantity, f.price, f.fees]), [['SPY', 'buy', 10, 100.5, 1]]);
  // Without a side, the quantity's sign says.
  assert.equal((picksText(guess.header, { date: 0, ticker: 2, side: -1, quantity: 3, price: 4, fees: -1 }) as { text: string }).text, 'date = When; ticker = Ticker symbol; quantity = Units; price = Paid each');
});

test('the header guess finds the usual names, the saved ones, and a statement’s table under its section', () => {
  const statement = readFileSync(new URL('./fixtures/fills-ibkr-statement.csv', import.meta.url), 'utf8');
  const g = headerGuess(statement)!;
  assert.ok(g.header.includes('Symbol') && g.header.includes('T. Price'), g.header.join('|'));
  assert.equal(g.header[g.at.ticker], 'Symbol');
  const fidelity = readFileSync(new URL('./fixtures/fills-fidelity.csv', import.meta.url), 'utf8');
  const f = headerGuess(fidelity, { price: 'Amount ($)' })!;
  assert.equal(f.header[f.at.date], 'Run Date');
  assert.equal(f.header[f.at.price], 'Amount ($)');
  assert.equal(headerGuess('just one column\nand another line'), null);
});
