import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { brokerNumber, fillColumnsText, matchFills, parseFillColumns, readFills, type Fill, type FillLog, type FillsRead, type Followed, type MatchOptions } from '../src/fills.ts';
import { near } from './helpers.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const TRADED = ['SPY', 'TLT', 'QQQ', 'BRK-B'];

function read(text: string, traded = TRADED, saved = {}): FillsRead {
  const r = readFills(text, traded, saved);
  assert.ok(r.ok, r.ok ? '' : r.reason);
  return r;
}

const brief = (r: FillsRead) => r.fills.map((f) => [new Date(f.date).toISOString().slice(0, 10), f.ticker, f.side, f.quantity, f.price, Number(f.fees.toFixed(10)), f.line]);

// --- Reading -------------------------------------------------------------------------------------------------------

test('a Schwab export with its title above and its totals below', () => {
  const r = read(fixture('fills-schwab.csv'));
  assert.equal(r.format, 'Charles Schwab');
  assert.deepEqual(r.columns, { date: 'Date', ticker: 'Symbol', side: 'Action', quantity: 'Quantity', price: 'Price', fees: ['Fees & Comm'] });
  assert.deepEqual(brief(r), [
    ['2026-04-13', 'SPY', 'buy', 12, 512.4, 0, 3],
    ['2026-04-13', 'TLT', 'sell', 30, 91.85, 0.06, 4],
    // "04/10/2026 as of 04/09/2026": the trade was made on the 9th.
    ['2026-04-09', 'QQQ', 'buy', 5, 441.2, 0, 5],
    ['2026-03-31', 'SPY', 'buy', 1200, 498, 1, 15],
  ]);
  // A dividend; two reinvestments; a MoneyLink transfer; bank interest, a short sale and a split.
  assert.deepEqual(r.left, { dividends: 1, reinvestments: 2, transfers: 1, other: 3 });
  assert.deepEqual(r.untraded, [{ ticker: 'AAPL', rows: 1 }]);
  assert.deepEqual(r.unread, [{ line: 14, why: 'the action "Conversion" is not a purchase or a sale this reads' }]);
  // The title and the totals line.
  assert.equal(r.ignored, 2);
});

test('a Fidelity history with blank lines above and its notes below', () => {
  const r = read(fixture('fills-fidelity.csv'));
  assert.equal(r.format, 'Fidelity');
  assert.deepEqual(r.columns, { date: 'Run Date', ticker: 'Symbol', side: 'Action', quantity: 'Quantity', price: 'Price ($)', fees: ['Commission ($)', 'Fees ($)'] });
  assert.deepEqual(brief(r), [
    ['2026-04-13', 'SPY', 'buy', 12, 512.4, 0, 5],
    // A sale's quantity is written below 0: the action says what it is.
    ['2026-04-13', 'TLT', 'sell', 30, 91.85, 0.06, 6],
    // "PROSPECTUS UNDER SEPARATE COVER" after a purchase does not make it something else; commission and fees add up.
    ['2026-04-10', 'QQQ', 'buy', 5, 441.2, 0.66, 7],
  ]);
  // Interest paid on an "FDIC INSURED DEPOSIT" is interest, not a transfer.
  assert.deepEqual(r.left, { dividends: 1, reinvestments: 1, transfers: 1, other: 1 });
  assert.deepEqual(r.untraded, [{ ticker: 'SPAXX', rows: 1 }]);
  assert.deepEqual(r.unread, []);
  // The disclaimer, the brokerage notice and the download date.
  assert.equal(r.ignored, 3);
});

test('a recent Fidelity export, with account columns and the price before the quantity, reads the same', () => {
  const r = read(fixture('fills-fidelity-accounts.csv'));
  assert.equal(r.format, 'Fidelity');
  assert.deepEqual(brief(r), [
    ['2026-04-13', 'SPY', 'buy', 12, 512.4, 0, 3],
    ['2026-04-13', 'TLT', 'sell', 30, 91.85, 0.06, 4],
  ]);
  assert.deepEqual(r.left, { dividends: 0, reinvestments: 1, transfers: 0, other: 0 });
  assert.equal(r.ignored, 2);
});

test('an Interactive Brokers activity statement: trades by the sign of their quantity, other sections counted', () => {
  const r = read(fixture('fills-ibkr-statement.csv'));
  assert.equal(r.format, 'Interactive Brokers activity statement');
  assert.deepEqual(r.columns, { date: 'Date/Time', ticker: 'Symbol', side: null, quantity: 'Quantity', price: 'T. Price', fees: ['Comm/Fee'] });
  assert.deepEqual(brief(r), [
    ['2026-04-13', 'SPY', 'buy', 12, 512.4, 1, 14],
    ['2026-04-13', 'TLT', 'sell', 30, 91.85, 1.02, 15],
    ['2026-04-09', 'QQQ', 'buy', 1000, 441.2, 5, 17],
  ]);
  assert.deepEqual(r.left, { dividends: 1, reinvestments: 0, transfers: 1, other: 0 });
  // The currency trade comes from a second table of trades with columns of its own.
  assert.deepEqual(r.untraded, [{ ticker: 'AAPL', rows: 1 }, { ticker: 'EUR.USD', rows: 1 }]);
  assert.deepEqual(r.unread, []);
  // Twelve lines of other sections, the closed lot, the subtotal and the totals, the dividend and deposit headers and totals, the codes.
  assert.equal(r.ignored, 22);
});

test('an Interactive Brokers Flex query with its header and trailer records', () => {
  const r = read(fixture('fills-ibkr-flex.csv'));
  assert.equal(r.format, 'Interactive Brokers Flex query');
  assert.deepEqual(r.columns, { date: 'TradeDate', ticker: 'Symbol', side: 'Buy/Sell', quantity: 'Quantity', price: 'TradePrice', fees: ['IBCommission'] });
  assert.deepEqual(brief(r), [
    ['2026-04-13', 'SPY', 'buy', 12, 512.4, 1, 5],
    ['2026-04-13', 'TLT', 'sell', 30, 91.85, 1.02, 6],
    // "BRK B" is the strategies' BRK-B.
    ['2026-04-10', 'BRK-B', 'buy', 2, 470.5, 1, 7],
  ]);
  assert.deepEqual(r.untraded, [{ ticker: 'SPY 260515C00520000', rows: 1 }]);
  // A cancelled trade is reported, not read as a purchase.
  assert.deepEqual(r.unread, [{ line: 9, why: 'the action "BUY (Ca.)" is not a purchase or a sale this reads' }]);
  assert.equal(r.ignored, 6);
});

test('a Flex query without header records, its dates written with the time', () => {
  const text = [
    'Symbol,DateTime,Quantity,TradePrice,IBCommission,Buy/Sell',
    'SPY,20260413;093002,12,512.4,-1,BUY',
    'TLT,20260413;155941,-30,91.85,-1.02,SELL',
  ].join('\n');
  const r = read(text);
  assert.equal(r.format, 'Interactive Brokers Flex query');
  assert.deepEqual(brief(r), [
    ['2026-04-13', 'SPY', 'buy', 12, 512.4, 1, 2],
    ['2026-04-13', 'TLT', 'sell', 30, 91.85, 1.02, 3],
  ]);
});

test("another broker's file: columns found by their names, semicolons, dates day first, sides in words", () => {
  const text = ['Export of 13.04.2026', '', 'Trade Date;Ticker;Side;Qty;Fill Price;Commission', '13.04.2026;spy;Bought;12;512,40;1', '14.04.2026;TLT;Sold;30;91.85;0', '25/04/2026;QQQ;Buy;5;441.2;0'].join('\n');
  const r = readFills(text, TRADED);
  assert.ok(r.ok);
  assert.equal(r.format, null);
  assert.deepEqual(r.columns, { date: 'Trade Date', ticker: 'Ticker', side: 'Side', quantity: 'Qty', price: 'Fill Price', fees: ['Commission'] });
  // "512,40" is not a price this reads: decimal commas are not guessed at.
  assert.deepEqual(r.unread, [{ line: 4, why: '"512,40" is not a price' }]);
  assert.deepEqual(brief(r), [
    ['2026-04-14', 'TLT', 'sell', 30, 91.85, 0, 5],
    ['2026-04-25', 'QQQ', 'buy', 5, 441.2, 0, 6],
  ]);
});

test("BOT and SLD, Interactive Brokers' words for a purchase and a sale, are read as them", () => {
  const r = read('Date,Symbol,Action,Quantity,Price\n2026-04-13,SPY,BOT,10,500\n2026-04-14,SPY,SLD,4,505');
  assert.deepEqual(brief(r), [
    ['2026-04-13', 'SPY', 'buy', 10, 500, 0, 2],
    ['2026-04-14', 'SPY', 'sell', 4, 505, 0, 3],
  ]);
  assert.deepEqual(r.unread, []);
});

test('without a side column a trade takes its side from the sign of its quantity', () => {
  const r = read('Date,Symbol,Quantity,Price\n2026-04-13,SPY,10,500\n2026-04-14,SPY,-4,505\n2026-04-15,SPY,0,505');
  assert.deepEqual(brief(r), [
    ['2026-04-13', 'SPY', 'buy', 10, 500, 0, 2],
    ['2026-04-14', 'SPY', 'sell', 4, 505, 0, 3],
  ]);
  assert.deepEqual(r.unread, [{ line: 4, why: '"0" is not a number of shares' }]);
  assert.deepEqual(r.columns.fees, []);
});

test('columns saved in the block are used for headers no alias knows, and the rest are still guessed', () => {
  const text = 'When,What,Instrument,Shares,Px,Commission\n2026-04-13,Buy,SPY,10,500,1';
  assert.equal(readFills(text, TRADED).ok, false);
  const saved = parseFillColumns('date = When; side = What; ticker = Instrument; quantity = Shares; price = Px');
  assert.ok(typeof saved !== 'string');
  const r = read(text, TRADED, saved);
  assert.deepEqual(r.columns, { date: 'When', ticker: 'Instrument', side: 'What', quantity: 'Shares', price: 'Px', fees: ['Commission'] });
  assert.deepEqual(brief(r), [['2026-04-13', 'SPY', 'buy', 10, 500, 1, 2]]);
});

test('a saved column wins over one an alias would pick, and a saved header that is missing finds no table', () => {
  const text = 'Date,Settlement Date,Symbol,Quantity,Price\n2026-04-13,2026-04-14,SPY,10,500';
  assert.equal(read(text, TRADED, { date: 'Settlement Date' }).fills[0].date, day(2026, 4, 14));
  assert.equal(read(text).fills[0].date, day(2026, 4, 13));
  assert.equal(readFills(text, TRADED, { price: 'Fill Price' }).ok, false);
});

test('a file with no table of trades says what it needs', () => {
  const r = readFills('Name,Value\nA,1', TRADED);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /a date, a symbol, a quantity and a price.*fills columns/);
  assert.equal(readFills('', TRADED).ok, false);
});

test('rows that cannot be read are reported with their line, and a totals row is not', () => {
  const text = ['Date,Action,Symbol,Quantity,Price', 'someday,Buy,SPY,1,500', '2026-04-13,Buy,,1,500', '2026-04-13,Buy,SPY,1,', '2026-04-13,Buy,SPY,1,-', 'Total,,,,'].join('\n');
  const r = read(text);
  assert.deepEqual(r.unread, [
    { line: 2, why: '"someday" is not a date' },
    { line: 3, why: 'it names no ticker' },
    { line: 4, why: '"" is not a price' },
    { line: 5, why: '"-" is not a price' },
  ]);
  assert.equal(r.ignored, 1);
});

test('numbers as brokers write them', () => {
  assert.equal(brokerNumber('$1,234.56'), 1234.56);
  assert.equal(brokerNumber('-$5,123.40'), -5123.4);
  assert.equal(brokerNumber('$-1,776.83'), -1776.83);
  assert.equal(brokerNumber('($45.00)'), -45);
  assert.equal(brokerNumber(' 12 '), 12);
  assert.equal(brokerNumber('.5'), 0.5);
  for (const bad of ['', '--', 'N/A', '1.2.3', '1e5', undefined]) assert.ok(Number.isNaN(brokerNumber(bad)), String(bad));
});

test('a fills columns setting reads back as written, and its mistakes are named', () => {
  const text = 'date = Run Date; ticker = Symbol; side = Action; quantity = Quantity; price = Price ($); fees = Commission ($) + Fees ($)';
  const c = parseFillColumns(text);
  assert.deepEqual(c, { date: 'Run Date', ticker: 'Symbol', side: 'Action', quantity: 'Quantity', price: 'Price ($)', fees: ['Commission ($)', 'Fees ($)'] });
  assert.equal(fillColumnsText(c as object), text);
  assert.deepEqual(parseFillColumns(' PRICE=Px ;'), { price: 'Px' });
  assert.match(parseFillColumns('cost = Fee') as string, /"cost = Fee" does not say which column holds what/);
  assert.equal(parseFillColumns('price = Px; price = Py'), 'price is named twice');
  assert.equal(parseFillColumns('price ='), 'Write the header of the price column after "price ="');
  assert.equal(parseFillColumns('fees = A + '), 'Write each fees header between the + signs');
  assert.match(parseFillColumns(' ; ') as string, /Name at least one column/);
});

// --- Matching ------------------------------------------------------------------------------------------------------

const june = (d: number) => day(2026, 6, d);
const may = (d: number) => day(2026, 5, d);
/** Weekdays from May 18 to June 30, 2026. */
const WEEKDAYS = Array.from({ length: 44 }, (_, i) => day(2026, 5, 18 + i)).filter((t) => ![0, 6].includes(new Date(t).getUTCDay()));

function log(rows: [number, string, number, number][]): FillLog {
  return { t: rows.map((r) => r[0]), asset: rows.map((r) => r[1]), kind: rows.map(() => 'entry'), sharesAfter: rows.map((r) => r[2]), price: rows.map((r) => r[3]) };
}

const strategy = (label: string, alloc: number, equity: number, rows: [number, string, number, number][]): Followed => ({
  label,
  alloc,
  log: log(rows),
  t: WEEKDAYS,
  equity: WEEKDAYS.map((t) => (t < june(1) ? equity : equity * 1.1)),
});

// A holds 60% of the account and had 10,000 the day before June 1; B 40% with 5,000. At 20,000 of capital, A's shares count 1.2 times and B's 1.6 times.
const A = strategy('A', 0.6, 10_000, [
  [may(20), 'TLT', 30, 48],
  [june(2), 'SPY', 10, 100],
  [june(2), 'TLT', 0, 50],
  [june(8), 'IWM', 4, 150],
  [june(9), 'XLK', 10, 100],
  [june(10), 'SPY', 0, 100],
]);
const B = strategy('B', 0.4, 5_000, [
  [may(20), 'GLD', 10, 175],
  [june(2), 'SPY', 5, 100],
  [june(3), 'QQQ', 2, 200],
  [june(8), 'GLD', 0, 180],
  [june(10), 'SPY', 10, 100],
  [june(29), 'DIA', 3, 400],
]);

const fill = (date: number, ticker: string, side: 'buy' | 'sell', quantity: number, price: number, fees: number, line: number): Fill => ({ date, ticker, side, quantity, price, fees, line });
const FILLS: Fill[] = [
  fill(may(28), 'SPY', 'buy', 1, 95, 0, 2),
  fill(june(2), 'SPY', 'buy', 12, 100.5, 0.6, 3),
  fill(june(2), 'SPY', 'buy', 8, 100.5, 0.4, 4),
  fill(june(2), 'TLT', 'sell', 20, 49.9, 0.2, 5),
  fill(june(5), 'QQQ', 'buy', 3, 202, 0, 6),
  fill(june(9), 'XLK', 'buy', 20, 100, 0, 7),
  fill(june(10), 'SPY', 'sell', 4, 99.5, 0.1, 8),
  fill(june(12), 'XLE', 'buy', 5, 80, 0.5, 9),
];
const TICKERS = ['SPY', 'TLT', 'QQQ', 'IWM', 'GLD', 'XLK', 'XLE', 'DIA'];
const OPTS: MatchOptions = {
  from: june(1),
  capital: 20_000,
  last: { SPY: 101, TLT: 52, QQQ: 205, IWM: 160, GLD: 170, XLK: 104, XLE: 82, DIA: 401 },
  days: Object.fromEntries(TICKERS.map((t) => [t, WEEKDAYS])),
};

const summary = (rows: ReturnType<typeof matchFills>['rows']) => rows.map((r) => [new Date((r.model ?? r.yours)!.day).toISOString().slice(5, 10), r.ticker, r.class]);

test('fills are classed against the netted trades of the strategies', () => {
  const r = matchFills([A, B], FILLS, OPTS);
  assert.deepEqual(summary(r.rows), [
    ['06-02', 'SPY', 'on time'],
    ['06-02', 'TLT', 'on time'],
    ['06-02', 'TLT', 'partial'],
    ['06-03', 'QQQ', 'late'],
    ['06-08', 'GLD', 'skipped'],
    ['06-08', 'IWM', 'skipped'],
    ['06-09', 'XLK', 'oversized'],
    ['06-10', 'SPY', 'on time'],
    ['06-12', 'XLE', 'off-plan'],
    ['06-29', 'DIA', 'waiting'],
  ]);
  assert.equal(r.before, 1);
  assert.equal(r.sized, true);
});

test("the strategies' trades are sized by allocation times capital at start over their equity before fills from", () => {
  const r = matchFills([A, B], FILLS, OPTS);
  const at = (ticker: string, d: number) => r.rows.find((x) => x.ticker === ticker && x.model?.day === june(d))!.model!;
  // SPY on June 2: A's 10 shares count 1.2 times and B's 5 count 1.6 times.
  assert.deepEqual(at('SPY', 2), { day: june(2), side: 'buy', quantity: 20, value: 2000, price: 100, strategies: [0, 1] });
  // SPY on June 10: A sells 12 and B buys 8 at the account's size, which nets to a sale of 4.
  assert.deepEqual(at('SPY', 10), { day: june(10), side: 'sell', quantity: 4, value: 400, price: 100, strategies: [0, 1] });
  // A's TLT bought before June 1 is the position its sale on June 2 closes: 36 shares, of which you sold 20.
  const tlt = r.rows.filter((x) => x.ticker === 'TLT').map((x) => x.model);
  assert.deepEqual(tlt, [
    { day: june(2), side: 'sell', quantity: 20, value: 1000, price: 50, strategies: [0] },
    { day: june(2), side: 'sell', quantity: 16, value: 800, price: 50, strategies: [0] },
  ]);
  // B's 2 QQQ are 3.2 shares; you bought 3 of them late, and the 0.2 left is within what counts as the whole trade.
  assert.ok(near(at('QQQ', 3).quantity!, 3) && near(at('QQQ', 3).value!, 600));
  const unfollowed = matchFills([A, B], [], OPTS).rows.find((x) => x.ticker === 'QQQ')!.model!;
  assert.ok(near(unfollowed.quantity!, 3.2) && near(unfollowed.value!, 640));
});

test('slippage, fees, late fills and skipped trades, and a total that is exactly their sum', () => {
  const r = matchFills([A, B], FILLS, OPTS);
  const row = (ticker: string, cls: string) => r.rows.find((x) => x.ticker === ticker && x.class === cls)!;
  // SPY on June 2: 20 shares bought 0.50 above the strategies' 100.
  const spy = row('SPY', 'on time');
  assert.deepEqual(spy.yours, { day: june(2), side: 'buy', quantity: 20, price: 100.5, fees: 1, lines: [3, 4] });
  assert.ok(near(spy.slippage, 10) && near(spy.bps!, 50));
  // TLT sold 0.10 below the strategies' 50 is worse for you: 2 on 20 shares, 20 bps.
  assert.ok(near(row('TLT', 'on time').slippage, 2) && near(row('TLT', 'on time').bps!, 20));
  // The 16 of the strategies' 36 you did not sell rose from 50 to 52: a loss of 32 avoided.
  assert.ok(near(row('TLT', 'partial').skipped, -32) && row('TLT', 'partial').yours === null);
  // QQQ bought two trading days late at 202 against 200: 6 on 3 shares, counted as late, not slippage.
  const qqq = row('QQQ', 'late');
  assert.equal(qqq.daysLate, 2);
  assert.ok(near(qqq.late, 6) && qqq.slippage === 0 && qqq.bps === null);
  // IWM not bought: 4.8 shares that rose from 150 to 160 are a gain missed.
  assert.ok(near(row('IWM', 'skipped').skipped, 48) && near(row('IWM', 'skipped').move!, 10 / 150));
  // GLD not sold: 16 shares that fell from 180 to 170 are a loss taken.
  assert.ok(near(row('GLD', 'skipped').skipped, 160) && near(row('GLD', 'skipped').move!, 10 / 180));
  // The trade at the end of the data may still be made: it costs nothing yet.
  assert.equal(row('DIA', 'waiting').skipped, 0);
  assert.equal(row('XLE', 'off-plan').fees, 0.5);

  assert.ok(near(r.parts.slippage, 14) && near(r.parts.fees, 1.8) && near(r.parts.late, 6) && near(r.parts.skipped, 176));
  assert.ok(near(r.total, 197.8));
  // Exactly, in the order the figures are added up: rows into tickers, tickers into parts, parts into the total.
  assert.equal(r.total, r.parts.slippage + r.parts.fees + r.parts.late + r.parts.skipped);
  for (const part of ['slippage', 'fees', 'late', 'skipped'] as const) {
    assert.equal(r.parts[part], r.tickers.reduce((s, t) => s + t[part], 0), part);
    for (const t of r.tickers) assert.equal(t[part], r.rows.filter((x) => x.ticker === t.ticker).reduce((s, x) => s + x[part], 0), `${t.ticker} ${part}`);
  }
});

test('each ticker sums its own rows, with slippage in basis points of the value compared', () => {
  const r = matchFills([A, B], FILLS, OPTS);
  const spy = r.tickers.find((t) => t.ticker === 'SPY')!;
  // 10 on 2,000 and 2 on 398: 12 on 2,398 compared at the strategies' price of 100.
  assert.ok(near(spy.slippage, 12) && near(spy.bps!, (12 / 2400) * 1e4));
  assert.ok(near(spy.fees, 1.1));
  assert.equal(spy.counts['on time'], 2);
  assert.equal(r.tickers.find((t) => t.ticker === 'IWM')!.bps, null);
  assert.deepEqual(r.tickers.map((t) => t.ticker), ['DIA', 'GLD', 'IWM', 'QQQ', 'SPY', 'TLT', 'XLE', 'XLK']);
});

test("a suggested slippage line for each strategy, from the median of the fills its trades were part of", () => {
  const r = matchFills([A, B], FILLS, OPTS);
  // A: SPY twice at 50, TLT at 20 and XLK at 0, so a median of 35. B: SPY twice at 50. The late QQQ fill is not slippage.
  assert.deepEqual(r.suggested, [
    { strategy: 0, bps: 35, fills: 4, line: 'slippage: 35 bps' },
    { strategy: 1, bps: 50, fills: 2, line: 'slippage: 50 bps' },
  ]);
  // Fills better than the strategies' prices suggest no slippage, never one below 0.
  const better = matchFills([A], [fill(june(2), 'SPY', 'buy', 12, 99, 0, 2)], OPTS);
  assert.deepEqual(better.suggested, [{ strategy: 0, bps: 0, fills: 1, line: 'slippage: 0 bps' }]);
});

test('without a capital at start no fill is partial or oversized, and trades not made have no money', () => {
  const r = matchFills([A, B], FILLS, { ...OPTS, capital: null });
  assert.equal(r.sized, false);
  const classes = new Map(r.rows.map((x) => [`${x.ticker} ${new Date((x.model ?? x.yours)!.day).getUTCDate()}`, x.class]));
  assert.equal(classes.get('TLT 2'), 'on time');
  assert.equal(classes.get('XLK 9'), 'on time');
  const iwm = r.rows.find((x) => x.ticker === 'IWM')!;
  assert.equal(iwm.class, 'skipped');
  assert.equal(iwm.skipped, 0);
  assert.ok(near(iwm.move!, 10 / 150));
  assert.equal(iwm.model!.quantity, null);
  assert.equal(r.parts.skipped, 0);
  // The prices still compare: slippage needs no sizes.
  assert.ok(near(r.parts.slippage, 14));
});

const qqqOnly = (rows: ReturnType<typeof matchFills>['rows']) => rows.filter((r) => r.ticker === 'QQQ');

test('a fill after the late window is off plan, and the trade it might have been is skipped', () => {
  const late = matchFills([B], [fill(june(11), 'QQQ', 'buy', 3, 202, 0, 2)], OPTS);
  // June 4, 5, 8, 9, 10 and 11 are six trading days after June 3.
  assert.deepEqual(summary(qqqOnly(late.rows)), [
    ['06-03', 'QQQ', 'skipped'],
    ['06-11', 'QQQ', 'off-plan'],
  ]);
  const inTime = qqqOnly(matchFills([B], [fill(june(10), 'QQQ', 'buy', 3, 202, 0, 2)], OPTS).rows);
  assert.equal(inTime[0].class, 'late');
  assert.equal(inTime[0].daysLate, 5);
  assert.equal(qqqOnly(matchFills([B], [fill(june(11), 'QQQ', 'buy', 3, 202, 0, 2)], { ...OPTS, lateDays: 6 }).rows)[0].class, 'late');
});

test('a fill on the wrong side is off plan, and one before the trade is not taken as late', () => {
  const r = matchFills([B], [fill(june(3), 'QQQ', 'sell', 3, 199, 0, 2), fill(june(2), 'QQQ', 'buy', 3, 199, 0, 3)], OPTS);
  assert.deepEqual(summary(qqqOnly(r.rows)), [
    ['06-02', 'QQQ', 'off-plan'],
    ['06-03', 'QQQ', 'skipped'],
    ['06-03', 'QQQ', 'off-plan'],
  ]);
});

test("a same-day fill is taken by that day's trade before an earlier trade can take it as late", () => {
  const S = strategy('S', 1, 10_000, [
    [june(2), 'SPY', 10, 100],
    [june(4), 'SPY', 20, 100],
  ]);
  // 20 on June 4: 10 for that day's trade, and the 10 left over for June 2's, late.
  const r = matchFills([S], [fill(june(4), 'SPY', 'buy', 20, 100, 0, 2)], { ...OPTS, capital: 10_000 });
  assert.deepEqual(summary(r.rows), [
    ['06-02', 'SPY', 'late'],
    ['06-04', 'SPY', 'on time'],
  ]);
  // 10 on June 4 go to that day's trade, and June 2's is skipped.
  const ten = matchFills([S], [fill(june(4), 'SPY', 'buy', 10, 100, 0, 2)], { ...OPTS, capital: 10_000 });
  assert.deepEqual(summary(ten.rows), [
    ['06-02', 'SPY', 'skipped'],
    ['06-04', 'SPY', 'on time'],
  ]);
  // 30 on June 4: the 10 more than both trades make the day oversized.
  const thirty = matchFills([S], [fill(june(4), 'SPY', 'buy', 35, 100, 0, 2)], { ...OPTS, capital: 10_000 });
  assert.deepEqual(thirty.rows.map((x) => [x.class, x.model!.quantity, x.yours!.quantity]), [
    ['late', 10, 10],
    ['oversized', 10, 25],
  ]);
});

test('trades of two strategies that cancel out leave nothing to do', () => {
  const X = strategy('X', 0.5, 10_000, [
    [may(20), 'SPY', 10, 100],
    [june(2), 'SPY', 0, 100],
  ]);
  const Y = strategy('Y', 0.5, 10_000, [[june(2), 'SPY', 10, 100]]);
  assert.deepEqual(matchFills([X, Y], [], OPTS).rows, []);
});

test('a strategy with no share of the account has no trades to follow', () => {
  const r = matchFills([{ ...A, alloc: 0 }], [fill(june(2), 'SPY', 'buy', 12, 100, 0, 2)], OPTS);
  assert.deepEqual(summary(r.rows), [['06-02', 'SPY', 'off-plan']]);
});

test("against unadjusted prices: the strategies' price is converted, and a fill outside its day's range is not compared", () => {
  const S = strategy('S', 1, 10_000, [[june(2), 'SPY', 10, 100]]);
  // A 2-for-1 split later: the run's price of 100 was 200 that day, which ranged from 198 to 204.
  const raw = { factor: () => 2, range: () => ({ low: 198, high: 204 }) };
  const inRange = matchFills([S], [fill(june(2), 'SPY', 'buy', 10, 201, 0, 2)], { ...OPTS, capital: 20_000, raw });
  assert.equal(inRange.rows[0].model!.price, 200);
  assert.ok(near(inRange.rows[0].bps!, 50) && near(inRange.rows[0].slippage, 10));
  assert.equal(inRange.rows[0].class, 'on time');
  // 210 is just inside 204 + 3%; 211 is not.
  assert.equal(matchFills([S], [fill(june(2), 'SPY', 'buy', 10, 210, 0, 2)], { ...OPTS, capital: 20_000, raw }).rows[0].outside, false);
  const outside = matchFills([S], [fill(june(2), 'SPY', 'buy', 10, 211, 0, 2)], { ...OPTS, capital: 20_000, raw });
  assert.equal(outside.rows[0].outside, true);
  assert.equal(outside.rows[0].bps, null);
  assert.equal(outside.rows[0].slippage, 0);
  assert.deepEqual(outside.suggested, []);
  // The skipped trade's result stays in the run's own prices.
  const skipped = matchFills([S], [], { ...OPTS, capital: 10_000, raw, last: { SPY: 110 } });
  assert.ok(near(skipped.parts.skipped, 100));
});

test("a day's purchases and sales are added up apart and matched each on its own side", () => {
  const S = strategy('S', 1, 10_000, [[june(2), 'SPY', 10, 100]]);
  const opts = { ...OPTS, capital: 10_000 };
  // 12 bought in two fills and 4 sold: the purchases are the trade, a little over its size, and the sale is off plan.
  const both = matchFills([S], [fill(june(2), 'SPY', 'buy', 6, 101, 0.1, 2), fill(june(2), 'SPY', 'buy', 6, 102, 0.1, 3), fill(june(2), 'SPY', 'sell', 4, 103, 0.1, 4)], opts);
  assert.deepEqual(both.rows.map((x) => [x.class, x.yours]), [
    ['on time', { day: june(2), side: 'buy', quantity: 12, price: 101.5, fees: 0.2, lines: [2, 3] }],
    ['off-plan', { day: june(2), side: 'sell', quantity: 4, price: 103, fees: 0.1, lines: [4] }],
  ]);
  // Bought 4 and sold them back: 4 of the 10 were bought, so the rest is partial, and the sale is off plan.
  const back = matchFills([S], [fill(june(2), 'SPY', 'buy', 4, 101, 0, 2), fill(june(2), 'SPY', 'sell', 4, 103, 0, 3)], opts);
  assert.deepEqual(summary(back.rows), [
    ['06-02', 'SPY', 'on time'],
    ['06-02', 'SPY', 'partial'],
    ['06-02', 'SPY', 'off-plan'],
  ]);
});

test('a file that starts with a byte order mark reads the same', () => {
  const text = fixture('fills-schwab.csv');
  assert.deepEqual(readFills(`﻿${text}`, TRADED), readFills(text, TRADED));
});

test('without fills or trades the figures are all 0', () => {
  const r = matchFills([], [], OPTS);
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.parts, { slippage: 0, fees: 0, late: 0, skipped: 0 });
  assert.equal(r.total, 0);
  assert.deepEqual(r.suggested, []);
});

// --- Found by review ----------------------------------------------------------------------------------------------

const ONE = (rows: [number, string, number, number][]): Followed => strategy('S', 1, 10_000, rows);
const SIZED = { ...OPTS, capital: 10_000, last: { ...OPTS.last, SPY: 120 } };
const costs = (r: ReturnType<typeof matchFills>) => r.rows.map((x) => [x.class, x.model?.quantity ?? null, x.yours?.quantity ?? null, x.slippage, x.late, x.skipped]);

test('one day of your fills covers two trades of the strategies: what is left after the same day fills the earlier one late', () => {
  // The strategy buys 10 on June 2 at 100 and 10 more on June 3 at 101; you buy all 20 on June 3 at 101.
  const r = matchFills([ONE([[june(2), 'SPY', 10, 100], [june(3), 'SPY', 20, 101]])], [fill(june(3), 'SPY', 'buy', 20, 101, 0, 2)], SIZED);
  assert.deepEqual(costs(r), [
    ['late', 10, 10, 0, 10, 0],
    ['on time', 10, 10, 0, 0, 0],
  ]);
  assert.equal(r.rows[0].daysLate, 1);
  assert.equal(r.total, 10);
});

test('one trade of the strategies covered by two days of your fills: the second day is a late fill of the rest', () => {
  // The strategy buys 20 on June 2 at 100; you buy 10 that day at 100 and 10 the next at 105.
  const r = matchFills([ONE([[june(2), 'SPY', 20, 100]])], [fill(june(2), 'SPY', 'buy', 10, 100, 0, 2), fill(june(3), 'SPY', 'buy', 10, 105, 0, 3)], SIZED);
  assert.deepEqual(costs(r), [
    ['on time', 10, 10, 0, 0, 0],
    ['late', 10, 10, 0, 50, 0],
  ]);
  assert.equal(r.total, 50);
});

test('a position opened and stopped out the same day is a purchase and a sale, each matched on its own side', () => {
  const S: Followed = { ...ONE([]), log: { t: [june(2), june(2)], asset: ['SPY', 'SPY'], kind: ['entry', 'stop'], sharesAfter: [10, 0], price: [100, 95] } };
  const r = matchFills([S], [fill(june(2), 'SPY', 'buy', 10, 100, 0, 2), fill(june(2), 'SPY', 'sell', 10, 95, 0, 3)], SIZED);
  assert.deepEqual(r.rows.map((x) => [x.class, x.model!.side, x.model!.quantity, x.yours!.quantity]), [
    ['on time', 'buy', 10, 10],
    ['on time', 'sell', 10, 10],
  ]);
  assert.equal(r.total, 0);
  // Not followed at all, the two trades cancel: bought at 100 and sold at 95 is a loss of 50 avoided.
  const none = matchFills([S], [], SIZED);
  assert.deepEqual(none.rows.map((x) => [x.class, x.model!.side, x.skipped]), [
    ['skipped', 'buy', 200],
    ['skipped', 'sell', -250],
  ]);
  assert.equal(none.total, -50);
});

test('a trade made under 70% has the rest as a partial row, costed as a trade not made, and a small shortfall is not', () => {
  // The strategy buys 20 on June 2 at 100, and SPY ends at 120.
  const S = ONE([[june(2), 'SPY', 20, 100]]);
  const half = matchFills([S], [fill(june(2), 'SPY', 'buy', 10, 100, 0, 2)], SIZED);
  assert.deepEqual(costs(half), [
    ['on time', 10, 10, 0, 0, 0],
    ['partial', 10, null, 0, 0, 200],
  ]);
  const most = matchFills([S], [fill(june(2), 'SPY', 'buy', 15, 100, 0, 2)], SIZED);
  assert.deepEqual(costs(most), [['on time', 15, 15, 0, 0, 0]]);
});

test('dates with the name of the month are read in their own year, and one without a year is not read', () => {
  const at = (cell: string) => {
    const r = read(`Date,Action,Symbol,Quantity,Price\n${cell},Buy,SPY,10,512.4\n`);
    return [r.fills.map((f) => new Date(f.date).toISOString().slice(0, 10)), r.unread.map((u) => u.why)];
  };
  assert.deepEqual(at('"Apr 13, 2026"'), [['2026-04-13'], []]);
  assert.deepEqual(at('"April 13, 2026"'), [['2026-04-13'], []]);
  assert.deepEqual(at('13 Apr 2026'), [['2026-04-13'], []]);
  assert.deepEqual(at('"Dec 31, 2025, 4:00 PM"'), [['2025-12-31'], []]);
  assert.deepEqual(at('Apr 13'), [[], ['"Apr 13" is not a date']]);
  // Numeric dates still take what follows a comma as the time.
  assert.deepEqual(at('"2026-04-13, 09:30:02"'), [['2026-04-13'], []]);
  assert.deepEqual(at('04/13/26'), [['2026-04-13'], []]);
});

test('an Interactive Brokers file with orders and their executions reads each order once', () => {
  const r = read(fixture('fills-ibkr-flex-executions.csv'));
  assert.deepEqual(brief(r), [
    ['2026-04-13', 'SPY', 'buy', 12, 512.4, 1, 5],
    ['2026-04-13', 'TLT', 'sell', 30, 91.85, 1.02, 8],
  ]);
  assert.deepEqual(r.unread, []);
  // Executions alone are each a fill; a closed lot never is.
  const executions = fixture('fills-ibkr-flex-executions.csv')
    .split('\n')
    .filter((l) => !l.endsWith('"ORDER"'))
    .join('\n');
  assert.deepEqual(brief(read(executions)).map((f) => [f[1], f[3]]), [['SPY', 7], ['SPY', 5], ['TLT', 30]]);
  // The same in an activity statement, by its DataDiscriminator.
  const statement = [
    'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Comm/Fee',
    'Trades,Data,Order,Stocks,USD,SPY,"2026-04-13, 09:30:02",12,512.4,-1',
    'Trades,Data,Execution,Stocks,USD,SPY,"2026-04-13, 09:30:02",7,512.38,-0.6',
    'Trades,Data,Execution,Stocks,USD,SPY,"2026-04-13, 09:30:03",5,512.43,-0.4',
    'Trades,Data,ClosedLot,Stocks,USD,SPY,2026-01-05,3,500,',
  ].join('\n');
  assert.deepEqual(brief(read(statement)).map((f) => [f[1], f[3]]), [['SPY', 12]]);
});
