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
  const st: AssetState = { name, weight: 1, long: false, since: null, pending: null, shares: 0, lastClose: 100, value: 0, targetWeight: 0, ...o };
  st.long = st.shares > 0;
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
    { ticker: 'SPY', order: 'Nothing to do', shares: '', price: '100.00', value: '', holding: '50 → 50', from: 'B −$5,000, drift +$5,000', side: 0 },
  ]);
  assert.deepEqual(planLines(plan), [
    'The strategies manage $20k: the cash and the holdings of the tickers they trade, at the last closes. Cash after the orders: $6,000.',
    'Left as they are, as no strategy listed trades them: AAPL 10.',
  ]);
});

test('a closing order sells all, a small resize is skipped, and buys cut to the cash say so', () => {
  const close = accountOrders({ ...account, holdings: [{ ticker: 'SPY', shares: 3 }] }, [strat('A', 1, 1000, [state('SPY', { shares: 2, pending: 'sell' })])]);
  assert.deepEqual(orderRows(close, ['A']).map((r) => [r.order, r.shares, r.side]), [['Sell all', '3', -1]]);
  const small = accountOrders({ ...account, cash: 5, skipUnder: 0.05, holdings: [{ ticker: 'SPY', shares: 10 }] }, [strat('A', 1, 1000, [state('SPY', { shares: 9.9 })])]);
  assert.equal(orderRows(small, ['A'])[0].order, 'Skip: small');
  const cut = accountOrders({ ...account, cash: 1000 }, [strat('A', 1, 1000, [state('SPY', { pending: 'buy', targetWeight: 2, lastClose: 100 })])]);
  assert.deepEqual(orderRows(cut, ['A']).map((r) => [r.order, r.shares]), [['Buy, cut to the cash', '10']]);
  assert.match(planLines(cut).at(-1)!, /^The buys come to \$2,000, more than the cash and the sales bring \(\$1,000\), so each is cut to fit\.$/);
});

test('what trading the orders as one spares is said in money and in costs', () => {
  const A = strat('A', 0.5, 1000, [state('SPY', { pending: 'buy', targetWeight: 0.5 })]);
  const B = strat('B', 0.5, 1000, [state('SPY', { shares: 5, pending: 'sell' })]);
  const plan = accountOrders({ ...account, cash: 500, holdings: [{ ticker: 'SPY', shares: 5 }] }, [A, B]);
  assert.equal(planLines(plan)[1], 'Trading their orders as one, rather than each strategy on its own, spares $500 of trades and $0.50 of their costs.');
});

test('the orders are for the next open after the last bar, said once when every strategy agrees', () => {
  assert.equal(asOfLine([{ label: 'A', asOf: T }, { label: 'B', asOf: T }]), "For the next open, from the strategies' last bar, 2026-11-13.");
  assert.equal(asOfLine([{ label: 'A', asOf: T }, { label: 'B', asOf: T + 14.5 * 3_600_000 }]), "For the next open, from each strategy's last bar: A 2026-11-13, B 2026-11-13 14:30.");
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
  unread: [5, 6, 7, 8].map((line) => ({ line, why: 'it names no ticker' })),
  ignored: 4,
};

test('what was read from the file and what was left out, each kind counted', () => {
  assert.deepEqual(readLines(READ), [
    'Read 1 purchase or sale as a Charles Schwab export.',
    'Left out, as they are not purchases or sales of shares: 3 dividends, 1 reinvestment, 2 other rows.',
    'Left out, as no strategy listed trades them: A (9), B (8), C (7), D (6), E (5), F (4) and 2 others.',
    '4 rows could not be read: line 5: it names no ticker; line 6: it names no ticker; line 7: it names no ticker; ….',
  ]);
  const plain = { ...READ, format: null, fills: [], left: { dividends: 0, reinvestments: 0, transfers: 0, other: 0 }, untraded: [], unread: [] };
  assert.deepEqual(readLines(plain), ['Read 0 purchases and sales by the names of its columns.']);
});

test('a file of which no row could be read is not compared, and says so; a format starting with a vowel takes "an"', () => {
  const none = { ...READ, fills: [], untraded: [], unread: [{ line: 2, why: 'the action "SLD" is not a purchase or a sale this reads' }] };
  assert.equal(readNone(none), true);
  assert.equal(readNone(READ), false);
  // Rows of tickers no strategy trades were read, so the columns are right.
  assert.equal(readNone({ ...none, untraded: [{ ticker: 'A', rows: 1 }] }), false);
  assert.deepEqual(readLines({ ...none, format: null, left: { dividends: 0, reinvestments: 0, transfers: 0, other: 0 } }), [
    'Read 0 purchases and sales by the names of its columns.',
    '1 row could not be read: line 2: the action "SLD" is not a purchase or a sale this reads.',
    'As no row could be read as a purchase or a sale, nothing is compared. Check which column holds each part of a trade.',
  ]);
  assert.equal(readLines({ ...READ, format: 'Interactive Brokers Flex query' })[0], 'Read 1 purchase or sale as an Interactive Brokers Flex query export.');
});

function row(o: Partial<MatchRow>): MatchRow {
  return { ticker: 'SPY', class: 'on time', model: null, yours: null, daysLate: null, bps: null, slippage: 0, late: 0, skipped: 0, fees: 0, move: null, outside: false, unpriced: false, ...o };
}
const model = (o: Partial<NonNullable<MatchRow['model']>> = {}) => ({ day: T, side: 'buy' as const, quantity: 10, value: 1000, price: 100, strategies: [0], ...o });
const yours = (o: Partial<NonNullable<MatchRow['yours']>> = {}) => ({ day: T, side: 'buy' as const, quantity: 10, price: 100.5, fees: 1, lines: [2], ...o });

test('the headline is the sum of the parts: a cost, a gain, nothing, or no trade at all', () => {
  assert.equal(costHeadline({ rows: [row({})], total: 12.345 }, T), 'Not following the rules cost $12.35 since 2026-11-13.');
  assert.equal(costHeadline({ rows: [row({})], total: -40 }, T), 'Not following the rules made $40.00 since 2026-11-13.');
  assert.equal(costHeadline({ rows: [row({})], total: 0.001 }, T), 'Not following the rules cost nothing since 2026-11-13.');
  assert.equal(costHeadline({ rows: [], total: 0 }, T), 'Neither the strategies nor you traded since 2026-11-13.');
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
  assert.deepEqual(skipped.slice(2), ['Not made, would have lost 3.1%', 'Sell 10 at 100.00', '–', '', '−$31.00']);
  assert.equal(matchCells(row({ class: 'partial', model: model({ quantity: 4 }), move: 0.05, skipped: 20 }))[2], 'Partial: the rest not made, would have made 5.0%');
  assert.deepEqual(matchCells(row({ class: 'waiting', model: model() })).slice(-1), ['']);
  assert.deepEqual(matchCells(row({ class: 'off-plan', yours: yours({ day: T + DAY }), fees: 1 })), ['2026-11-14', 'SPY', 'Off plan', '–', 'Buy 10 at 100.50', '', '$1.00']);
  assert.equal(matchCells(row({ model: model(), yours: yours({ price: 400 }), outside: true }))[5], 'outside the day');
  assert.equal(matchCells(row({ model: model({ price: NaN }), yours: yours(), unpriced: true }))[3], 'Buy 10 at unknown');
});

test('each ticker: how its trades went and what they cost, part by part', () => {
  const counts = { 'on time': 3, partial: 1, oversized: 0, late: 1, skipped: 0, waiting: 0, 'off-plan': 2 };
  assert.deepEqual(tickerCells({ ticker: 'SPY', slippage: 4.5, bps: 3.04, fees: 2, late: -1, skipped: 0, counts }), ['SPY', '3 on time, 1 partial, 1 late, 2 off plan', '$4.50 (3.0 bps)', '$2.00', '−$1.00', '$0.00']);
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
    'Without capital at start, sizes are not compared and trades not made are not counted in money.',
    '1 fill of yours is more than 3% outside the day’s range as it traded, most likely from a split, and is not compared on price.',
    '2 fills are not compared on price, as the prices that day as they traded are not known.',
    '1 trade of the strategies is still waiting: a fill in the next days counts as late.',
    '2 fills before 2026-11-13 are left out.',
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
