import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { actionWord, barLabel, basisOf, CLOSE_FILL_NOTE, failedStatus, LAST_CLOSE_NOTE, mapLimit, notOurNoteMessage, orderSize, ordersMarkdown, ordersSavePlan, positionOrder, problemsOf, sortStatuses, statusFrom, todoGroups, todoRows, type OrderRow, type StrategyStatus } from '../src/orders.ts';
import type { AssetState } from '../src/engine.ts';
import type { RunOutput } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY, T0 } from './helpers.ts';

function run(src: string, data: Record<string, Bars>, warnings: string[] = []): RunOutput {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  const map = new Map(Object.entries(data));
  return { spec: spec!, backtest: runBacktest(spec!, map), data: map, warnings, prices: [] };
}
const day = (n: number) => T0 + n * DAY;
/** A time on the reader's clock; the tests must not depend on the machine's time zone. */
const local = (y: number, m: number, d: number, hour = 12, minute = 0) => new Date(y, m - 1, d, hour, minute).getTime();
// Bars end on 2020-01-03 in the single-ticker runs below.
const NOW = local(2020, 1, 4);

test('a pending buy becomes a buy order sized at the target weight', () => {
  const out = run('universe: A\ncapital: 1000\nbuy when close > 11', { A: bars([10, 10, 12]) });
  assert.deepEqual(statusFrom('Notes/Trend.md', 'Trend', out, NOW), {
    note: 'Notes/Trend.md',
    strategy: 'Trend',
    asOf: day(2),
    interval: '1d',
    orders: [{ ticker: 'A', action: 'buy', when: 'next open', weight: 1, value: 1000, lastClose: 12, since: null }],
    holdings: [],
    equity: 1000,
    warnings: [],
    error: null,
    closeFill: false,
    stale: false,
  });
});

test('a pending sell becomes a sell order for the whole position and is not a holding', () => {
  // Bought at day 1's open (10): 100 shares, 800 after the close at 8, when the sell rule fires.
  const out = run('universe: A\ncapital: 1000\nbuy when true\nsell when close < 9', { A: bars([10, 10, 10, 8]) });
  const s = statusFrom('n.md', 'S', out, NOW);
  assert.deepEqual(s.orders, [{ ticker: 'A', action: 'sell', when: 'next open', weight: 0, value: 800, lastClose: 8, since: day(1) }]);
  assert.deepEqual(s.holdings, []);
  assert.equal(s.equity, 800);
});

test('a held position with no order is a holding with its open gain', () => {
  const out = run('universe: A\ncapital: 1000\nbuy when true', { A: bars([10, 10, 12, 15]) });
  const s = statusFrom('n.md', 'S', out, NOW);
  assert.deepEqual(s.orders, []);
  assert.deepEqual(s.holdings, [{ ticker: 'A', weight: 1, since: day(1), lastClose: 15, gain: 0.5 }]);
  assert.equal(s.equity, 1500);
});

test('costs come off the open gain', () => {
  const out = run('universe: A\ncapital: 1000\ncosts: 100 bps\nbuy when true', { A: bars([10, 10, 20]) });
  const [h] = statusFrom('n.md', 'S', out, NOW).holdings;
  assert.ok(Math.abs(h.gain! - (20 * 0.99) / (10 * 1.01) + 1) < 1e-12);
});

test('a strategy in cash has no orders and no holdings', () => {
  const s = statusFrom('n.md', 'S', run('universe: A\ncapital: 1000\nbuy when close > 100', { A: bars([10, 10, 10]) }), NOW);
  assert.deepEqual([s.orders, s.holdings, s.equity], [[], [], 1000]);
});

test('with several tickers one can be held while another has an order', () => {
  // A is bought at day 2's open (20): 25 shares for half of 1000. B's rule first holds at the last close.
  const out = run('universe: A 50%, B 50%\ncapital: 1000\nbuy when close > 15', { A: bars([10, 20, 20, 20]), B: bars([10, 10, 10, 20]) });
  const s = statusFrom('n.md', 'S', out, NOW);
  assert.deepEqual(s.orders, [{ ticker: 'B', action: 'buy', when: 'next open', weight: 0.5, value: 500, lastClose: 20, since: null }]);
  assert.deepEqual(s.holdings, [{ ticker: 'A', weight: 0.5, since: day(2), lastClose: 20, gain: 0 }]);
});

test('sells come before buys, then tickers', () => {
  // Z is bought on day 1 and its sell rule fires at the last close; A's buy rule first holds then.
  const out = run('universe: A, Z\ncapital: 1000\nbuy when close > 9\nsell when close < 9', { A: bars([8, 8, 8, 10]), Z: bars([10, 10, 10, 8]) });
  assert.deepEqual(
    statusFrom('n.md', 'S', out, NOW).orders.map((o) => [o.action, o.ticker]),
    [['sell', 'Z'], ['buy', 'A']],
  );
});

test('prices are stale when they end more than the allowed calendar days before today', () => {
  const out = run('universe: A\nbuy when close > 11', { A: bars([10, 10, 12]) });
  const stale = (now: number, days?: number) => statusFrom('n.md', 'S', out, now, days).stale;
  // The last bar is 2020-01-03: four days later is still fine, five is not, whatever the hour.
  assert.equal(stale(local(2020, 1, 7, 23, 59)), false);
  assert.equal(stale(local(2020, 1, 8, 0, 0)), true);
  assert.equal(stale(local(2020, 1, 3, 0, 0), 0), false);
  assert.equal(stale(local(2020, 1, 3, 23, 59), 0), false);
  assert.equal(stale(local(2020, 1, 4, 0, 0), 0), true);
  assert.equal(stale(local(2020, 1, 13), 10), false);
  assert.equal(stale(local(2020, 1, 14), 10), true);
  assert.equal(stale(local(2020, 1, 1)), false);
});

test('warnings from loading the prices are kept', () => {
  const out = run('universe: A\nbuy when close > 11', { A: bars([10, 10, 12]) }, ["Couldn't refresh A (HTTP 500); using prices saved on 2020-01-02."]);
  assert.deepEqual(statusFrom('n.md', 'S', out, NOW).warnings, ["Couldn't refresh A (HTTP 500); using prices saved on 2020-01-02."]);
});

function status(note: string, strategy: string, orders: Array<[OrderRow['action'], string, OrderRow['when']?]> = [], more: Partial<StrategyStatus> = {}): StrategyStatus {
  return {
    note,
    strategy,
    asOf: day(2),
    interval: '1d',
    orders: orders.map(([action, ticker, when = 'next open']) => ({ ticker, action, when, weight: action === 'buy' ? 0.5 : 0, value: 100, lastClose: 10, since: null })),
    holdings: [],
    equity: 1000,
    warnings: [],
    error: null,
    closeFill: false,
    stale: false,
    ...more,
  };
}

test('statuses with orders come first, sells ahead of buys; then by note and name', () => {
  const list = [
    status('b.md', 'B', [['buy', 'X']]),
    status('c.md', 'C'),
    status('a.md', 'A2', [['buy', 'X']]),
    status('d.md', 'D', [['buy', 'M'], ['sell', 'Z'], ['sell', 'Q']]),
    failedStatus('a.md', 'A1', 'No prices'),
    status('a.md', 'A1b', [['buy', 'X']]),
  ];
  const before = JSON.stringify(list);
  const sorted = sortStatuses(list);
  assert.deepEqual(sorted.map((s) => s.strategy), ['D', 'A1b', 'A2', 'B', 'A1', 'C']);
  assert.deepEqual(sorted[0].orders.map((o) => [o.action, o.ticker]), [['sell', 'Q'], ['sell', 'Z'], ['buy', 'M']]);
  assert.equal(JSON.stringify(list), before);
});

test('the to-do list puts every sell ahead of every buy', () => {
  const rows = todoRows([status('a.md', 'A', [['buy', 'X'], ['buy', 'B']]), status('b.md', 'B', [['sell', 'Y']]), status('c.md', 'C', [['sell', 'A']])]);
  assert.deepEqual(rows.map((r) => [r.status.note, r.order.action, r.order.ticker]), [
    ['b.md', 'sell', 'Y'],
    ['c.md', 'sell', 'A'],
    ['a.md', 'buy', 'B'],
    ['a.md', 'buy', 'X'],
  ]);
});

test('a failed strategy has an error, no orders and no price date', () => {
  const f = failedStatus('n.md', 'S', "Couldn't load XYZ from yahoo: HTTP 404");
  assert.deepEqual(f, { note: 'n.md', strategy: 'S', asOf: 0, interval: '1d', orders: [], holdings: [], equity: 0, warnings: [], error: "Couldn't load XYZ from yahoo: HTTP 404", closeFill: false, stale: false });
  assert.deepEqual(problemsOf(f), ["Couldn't run. Couldn't load XYZ from yahoo: HTTP 404"]);
  assert.equal(basisOf([f]), null);
});

test('order sizes are a share of the strategy with dollars second', () => {
  const order = (action: OrderRow['action'], weight: number, value: number): OrderRow => ({ ticker: 'A', action, when: 'next open', weight, value, lastClose: 1, since: null });
  assert.equal(orderSize(order('buy', 0.2, 2100)), '20% of the strategy, about $2,100');
  assert.equal(orderSize(order('buy', 1 / 3, 33_333)), '33.3% of the strategy, about $33.3k');
  assert.equal(orderSize(order('sell', 0, 10_500)), 'Whole position, about $10.5k');
});

const SAMPLE_NOW = local(2026, 11, 17);
const SAMPLE_ASOF = Date.UTC(2026, 10, 16);

function sample(): StrategyStatus[] {
  const base = { asOf: SAMPLE_ASOF, equity: 10_500 };
  return [
    status('Strategies/Quiet.md', 'Quiet', [], {
      ...base,
      holdings: [
        { ticker: 'SPY', weight: 0.5, since: Date.UTC(2026, 0, 5), lastClose: 600, gain: 0.123 },
        { ticker: 'QQQ', weight: 0.3, since: Date.UTC(2026, 2, 2), lastClose: 500, gain: -0.02 },
      ],
    }),
    status('Strategies/Rotation.md', 'Rotation', [['buy', 'QQQ']], {
      ...base,
      orders: [{ ticker: 'QQQ', action: 'buy', when: 'next open', weight: 0.2, value: 2100, lastClose: 380.1, since: null }],
    }),
    failedStatus('Strategies/Broken.md', 'Broken', "Couldn't load XYZ from yahoo: HTTP 404"),
    status('Strategies/Old.md', 'Old one', [], { asOf: Date.UTC(2026, 10, 1), stale: true, warnings: ["Couldn't refresh SPY (HTTP 500); using prices saved on 2026-10-30."] }),
    status('Strategies/Trend.md', 'Trend following', [['sell', 'SPY']], {
      ...base,
      orders: [{ ticker: 'SPY', action: 'sell', when: 'next open', weight: 0, value: 10_500, lastClose: 412.34, since: Date.UTC(2026, 0, 5) }],
    }),
    status('Strategies/Idle.md', 'Strategy 2', [], base),
  ];
}

test('the Markdown lists the orders, what is held, and the problems', () => {
  assert.equal(
    ordersMarkdown(sample(), SAMPLE_NOW),
    [
      '---',
      'backtest_orders: true',
      '---',
      '',
      "# Today's orders, 2026-11-17",
      '',
      'Based on the close of 2026-11-16. From backtests of your rules on the latest prices. Nothing here places an order.',
      '',
      '## To do at the next open',
      '',
      '| Strategy | Action | Ticker | Size | Last close | Based on |',
      '| --- | --- | --- | --- | ---: | --- |',
      '| [[Strategies/Trend\\|Trend following]] | Sell | SPY | Whole position, about $10.5k | 412.34 | Close of 2026-11-16 |',
      '| [[Strategies/Rotation\\|Rotation]] | Buy | QQQ | 20% of the strategy, about $2,100 | 380.10 | Close of 2026-11-16 |',
      '',
      '## Nothing to do',
      '',
      '- [[Strategies/Idle|Strategy 2]]: In cash',
      '- [[Strategies/Old|Old one]]: In cash',
      '- [[Strategies/Quiet|Quiet]]: Holding SPY 50% (+12.3%), QQQ 30% (−2.0%)',
      '',
      '## Problems',
      '',
      "- [[Strategies/Broken|Broken]]: Couldn't run. Couldn't load XYZ from yahoo: HTTP 404",
      '- [[Strategies/Old|Old one]]: Prices end on 2026-11-01, so this may be out of date.',
      "- [[Strategies/Old|Old one]]: Couldn't refresh SPY (HTTP 500); using prices saved on 2026-10-30.",
      '',
    ].join('\n'),
  );
});

test('the Markdown with nothing to do, no problems, and no strategies', () => {
  assert.equal(
    ordersMarkdown([status('a.md', 'A', [], { asOf: SAMPLE_ASOF })], SAMPLE_NOW),
    [
      '---',
      'backtest_orders: true',
      '---',
      '',
      "# Today's orders, 2026-11-17",
      '',
      'Based on the close of 2026-11-16. From backtests of your rules on the latest prices. Nothing here places an order.',
      '',
      '## To do',
      '',
      'No strategy has an order.',
      '',
      '## Nothing to do',
      '',
      '- [[a|A]]: In cash',
      '',
    ].join('\n'),
  );
  assert.equal(ordersMarkdown([], SAMPLE_NOW), "---\nbacktest_orders: true\n---\n\n# Today's orders, 2026-11-17\n\nNo strategy blocks found.\n");
});

test('the Markdown heading is the reader\'s date, and a name cannot break the link', () => {
  const late = local(2026, 11, 17, 23, 59);
  const early = local(2026, 11, 17, 0, 0);
  const odd = status('a.md', 'Odd [one] | two', [['buy', 'X']], { asOf: SAMPLE_ASOF });
  for (const now of [late, early]) assert.ok(ordersMarkdown([odd], now).includes("\n# Today's orders, 2026-11-17\n"));
  assert.ok(ordersMarkdown([odd], SAMPLE_NOW).includes('| [[a\\|Odd one two]] | Buy | X |'));
});

// --- fill: close --------------------------------------------------------------------------------------------------

/** 27 January to 29 February 2020: CRY every day, STK on weekdays, so a ranking made on Saturday the 29th leaves STK no bar to trade at. */
function weekendRanking(source: string): RunOutput {
  const days = (weekdays: boolean) => {
    const out: number[] = [];
    for (let t = Date.UTC(2020, 0, 27); t <= Date.UTC(2020, 1, 29); t += DAY) if (!weekdays || ![0, 6].includes(new Date(t).getUTCDay())) out.push(t);
    return out;
  };
  const [stkT, cryT] = [days(true), days(false)];
  return run(source, { STK: bars(stkT.map(() => 100), { times: stkT }), CRY: bars(cryT.map((t) => (t < Date.UTC(2020, 1, 29) ? 50 : 150)), { times: cryT }) });
}

test('with fill: close a buy made at the last close is an order at the last close, and the strategy is marked', () => {
  const out = run('universe: A\ncapital: 1000\nfill: close\nbuy when close > 11', { A: bars([10, 10, 12]) });
  const s = statusFrom('n.md', 'S', out, NOW);
  assert.equal(s.closeFill, true);
  assert.deepEqual(s.orders, [{ ticker: 'A', action: 'buy', when: 'last close', weight: 1, value: 1000, lastClose: 12, since: null }]);
  assert.deepEqual(s.holdings, [], 'the position is already covered by its order');
  assert.equal(s.equity, 1000);
});

test('with fill: close a sell made at the last close is an order at the last close, with the day the position was opened', () => {
  // Bought at day 0's close (10): 100 shares. Sold at day 3's close (8): 800.
  const out = run('universe: A\ncapital: 1000\nfill: close\nbuy when true\nsell when close < 9', { A: bars([10, 10, 10, 8]) });
  const s = statusFrom('n.md', 'S', out, NOW);
  assert.deepEqual(s.orders, [{ ticker: 'A', action: 'sell', when: 'last close', weight: 0, value: 800, lastClose: 8, since: day(0) }]);
  assert.deepEqual(s.holdings, []);
});

test('with fill: close a position with nothing decided at the last close is a holding, and no order is listed', () => {
  const s = statusFrom('n.md', 'S', run('universe: A\ncapital: 1000\nfill: close\nbuy when true', { A: bars([10, 10, 12, 15]) }), NOW);
  assert.deepEqual(s.orders, []);
  assert.deepEqual(s.holdings, [{ ticker: 'A', weight: 1, since: day(0), lastClose: 15, gain: 0.5 }]);
  assert.equal(s.closeFill, true);
});

test('with fill: close an order a ranking could not fill, for a ticker with no bar, is for the next close', () => {
  const s = statusFrom('n.md', 'S', weekendRanking('universe: STK, CRY\ncapital: 1000\nfill: close\nrebalance: monthly\nhold: top 1 by close'), NOW);
  assert.deepEqual(
    s.orders.map((o) => [o.action, o.ticker, o.when]),
    [['sell', 'STK', 'next close'], ['buy', 'CRY', 'next close']],
  );
  // Without fill: close the same ranking waits for the next open.
  const open = statusFrom('n.md', 'S', weekendRanking('universe: STK, CRY\ncapital: 1000\nrebalance: monthly\nhold: top 1 by close'), NOW);
  assert.ok(open.orders.length > 0 && open.orders.every((o) => o.when === 'next open'));
  assert.equal(open.closeFill, false);
});

test('a failed strategy is not a close-fill one', () => {
  assert.equal(failedStatus('n.md', 'S', 'x').closeFill, false);
});

test('the to-do list goes by timing first, then sells ahead of buys, and the groups carry their headings', () => {
  const list = [
    status('a.md', 'A', [['buy', 'X'], ['buy', 'M', 'last close']], { closeFill: true }),
    status('b.md', 'B', [['sell', 'Y', 'next close'], ['buy', 'Z', 'next close'], ['sell', 'Q', 'last close']], { closeFill: true }),
    status('c.md', 'C', [['sell', 'W']]),
  ];
  const rows = todoRows(list);
  assert.deepEqual(rows.map((r) => [r.order.when, r.order.action, r.order.ticker]), [
    ['next open', 'sell', 'W'],
    ['next open', 'buy', 'X'],
    ['next close', 'sell', 'Y'],
    ['next close', 'buy', 'Z'],
    ['last close', 'sell', 'Q'],
    ['last close', 'buy', 'M'],
  ]);
  const groups = todoGroups(rows);
  assert.deepEqual(groups.map((g) => [g.when, g.heading, g.rows.length]), [
    ['next open', 'To do at the next open', 2],
    ['next close', 'To do at the next close', 2],
    ['last close', 'Traded at the last close', 2],
  ]);
  assert.deepEqual(todoGroups(rows.filter((r) => r.order.when === 'next close')).map((g) => g.when), ['next close']);
  assert.deepEqual(todoGroups([]), []);
});

test('an order made at the last close is worded in the past, the others as something to do', () => {
  const o = (action: OrderRow['action'], when: OrderRow['when']) => ({ action, when });
  assert.deepEqual([actionWord(o('buy', 'next open')), actionWord(o('sell', 'next open')), actionWord(o('buy', 'next close')), actionWord(o('sell', 'next close'))], ['Buy', 'Sell', 'Buy', 'Sell']);
  assert.deepEqual([actionWord(o('buy', 'last close')), actionWord(o('sell', 'last close'))], ['Bought', 'Sold']);
});

test('a position\'s order is worded as the positions table words it', () => {
  const st = (o: Partial<AssetState>): AssetState => ({ name: 'A', weight: 1, long: false, since: null, pending: null, shares: 0, lastClose: 1, value: 0, targetWeight: 1, ...o });
  assert.equal(positionOrder(st({}), undefined), '');
  assert.equal(positionOrder(st({ pending: 'buy' }), undefined), 'buys at the next open');
  assert.equal(positionOrder(st({ pending: 'sell' }), 'next open'), 'sells at the next open');
  assert.equal(positionOrder(st({ pending: 'buy' }), 'close'), 'buys at the next close');
  assert.equal(positionOrder(st({ filled: { side: 'buy', shares: 1, price: 1 } }), 'close'), 'bought at the last close');
  assert.equal(positionOrder(st({ filled: { side: 'sell', shares: 1, price: 1 } }), 'close'), 'sold at the last close');
  assert.equal(positionOrder(st({ filled: null }), 'close'), '');
});

test('the Markdown groups the orders by timing and says once what fill: close means', () => {
  const list = [
    status('Strategies/Trend.md', 'Trend following', [['sell', 'SPY']], { asOf: SAMPLE_ASOF }),
    status('Strategies/Close.md', 'Close mover', [['buy', 'TLT', 'last close']], { asOf: SAMPLE_ASOF, closeFill: true }),
    status('Strategies/Rank.md', 'Ranker', [['buy', 'CRY', 'next close']], { asOf: SAMPLE_ASOF, closeFill: true }),
    status('Strategies/Quiet.md', 'Quiet close', [], { asOf: SAMPLE_ASOF, closeFill: true }),
  ];
  assert.equal(
    ordersMarkdown(list, SAMPLE_NOW),
    [
      '---',
      'backtest_orders: true',
      '---',
      '',
      "# Today's orders, 2026-11-17",
      '',
      'Based on the close of 2026-11-16. From backtests of your rules on the latest prices. Nothing here places an order.',
      '',
      '## To do at the next open',
      '',
      '| Strategy | Action | Ticker | Size | Last close | Based on |',
      '| --- | --- | --- | --- | ---: | --- |',
      '| [[Strategies/Trend\\|Trend following]] | Sell | SPY | Whole position, about $100 | 10.00 | Close of 2026-11-16 |',
      '',
      '## To do at the next close',
      '',
      '| Strategy | Action | Ticker | Size | Last close | Based on |',
      '| --- | --- | --- | --- | ---: | --- |',
      '| [[Strategies/Rank\\|Ranker]] | Buy | CRY | 50% of the strategy, about $100 | 10.00 | Close of 2026-11-16 |',
      '',
      '## Traded at the last close',
      '',
      LAST_CLOSE_NOTE,
      '',
      '| Strategy | Action | Ticker | Size | Last close | Based on |',
      '| --- | --- | --- | --- | ---: | --- |',
      '| [[Strategies/Close\\|Close mover]] | Bought | TLT | 50% of the strategy, about $100 | 10.00 | Close of 2026-11-16 |',
      '',
      '## Nothing to do',
      '',
      '- [[Strategies/Quiet|Quiet close]]: In cash',
      '',
      '## Strategies that fill at the close',
      '',
      CLOSE_FILL_NOTE,
      '',
      '- [[Strategies/Close|Close mover]]',
      '- [[Strategies/Rank|Ranker]]',
      '- [[Strategies/Quiet|Quiet close]]',
      '',
    ].join('\n'),
  );
  assert.equal(ordersSavePlan(ordersMarkdown(list, SAMPLE_NOW)), 'replace');
});

test('the Markdown leaves out the close-fill section when no strategy fills at the close', () => {
  assert.ok(!ordersMarkdown(sample(), SAMPLE_NOW).includes('fill at the close'));
});

// --- Intraday strategies -------------------------------------------------------------------------------------------

test('weekly prices are stale when the last bar is more than 2 bars old', () => {
  // Weekly bars dated Monday 23 December 2019 to Monday 6 January 2020; the last covers that week.
  const monday = Date.UTC(2019, 11, 23);
  const out = run('universe: A\ninterval: 1w\nbuy when close > 11', { A: bars([10, 10, 12], { start: monday, step: 7 * DAY }) });
  const last = Date.UTC(2020, 0, 6);
  const stale = (now: number) => statusFrom('n.md', 'S', out, now).stale;
  // Its bar is complete a week later, and the next one a week after that: up to two weeks is normal.
  assert.equal(stale(last + 5 * DAY), false);
  assert.equal(stale(last + 14 * DAY), false);
  assert.equal(stale(last + 14 * DAY + 1), true);
});

const HOUR = 3_600_000;
const HOURLY_START = Date.UTC(2026, 10, 13, 10, 0);
const hourly = (n: number, src = 'universe: binance:A\ninterval: 1h\ncapital: 1000\nbuy when close > 11') => {
  // Closes of 10 until the last bar, which closes at 12: a buy order at the last bar.
  const closes = Array.from({ length: n }, (_, i) => (i === n - 1 ? 12 : 10));
  return run(src, { A: bars(closes, { start: HOURLY_START, step: HOUR }) });
};
const LAST_BAR = HOURLY_START + 4 * HOUR;

test('intraday prices are stale when the last bar is more than 3 bars old, whatever the date', () => {
  const out = hourly(5);
  assert.equal(out.backtest.run.t[4], LAST_BAR);
  const stale = (now: number) => statusFrom('n.md', 'S', out, now).stale;
  assert.equal(stale(LAST_BAR + 3 * HOUR), false);
  assert.equal(stale(LAST_BAR + 3 * HOUR + 1), true);
  assert.equal(stale(LAST_BAR + HOUR), false);
  // Four days is fine for a daily strategy and far too long for an hourly one.
  assert.equal(stale(LAST_BAR + 4 * DAY), true);
  const fiveMinutes = run('universe: binance:A\ninterval: 5m\nbuy when close > 11', { A: bars([10, 10, 12], { start: HOURLY_START, step: 300_000 }) });
  const last5 = HOURLY_START + 2 * 300_000;
  assert.equal(statusFrom('n.md', 'S', fiveMinutes, last5 + 15 * 60_000).stale, false);
  assert.equal(statusFrom('n.md', 'S', fiveMinutes, last5 + 15 * 60_000 + 1).stale, true);
});

test('a daily strategy keeps the calendar-day rule', () => {
  const out = run('universe: A\nbuy when close > 11', { A: bars([10, 10, 12]) });
  assert.equal(statusFrom('n.md', 'S', out, local(2020, 1, 7, 23, 59)).stale, false);
  assert.equal(statusFrom('n.md', 'S', out, local(2020, 1, 8, 0, 0)).stale, true);
});

test('a status carries its strategy\'s bar interval', () => {
  assert.equal(statusFrom('n.md', 'S', hourly(5), LAST_BAR).interval, '1h');
  assert.equal(statusFrom('n.md', 'S', run('universe: A\nbuy when true', { A: bars([10, 10, 12]) }), NOW).interval, '1d');
});

test('the bar an order rests on is named with its date, and its time of day when intraday', () => {
  assert.equal(barLabel({ asOf: Date.UTC(2026, 10, 13), interval: '1d' }), 'close of 2026-11-13');
  assert.equal(barLabel({ asOf: Date.UTC(2026, 10, 9), interval: '1w' }), 'weekly bar starting 2026-11-09');
  assert.equal(barLabel({ asOf: Date.UTC(2026, 10, 13, 14, 5), interval: '5m' }), '5m bar starting 2026-11-13 14:05 UTC');
  assert.equal(barLabel({ asOf: Date.UTC(2026, 10, 13, 16), interval: '4h' }), '4h bar starting 2026-11-13 16:00 UTC');
});

test('an intraday strategy\'s stale warning names the time', () => {
  const s = status('a.md', 'A', [], { interval: '1h', asOf: Date.UTC(2026, 10, 13, 14), stale: true });
  assert.deepEqual(problemsOf(s), ['Prices end at 2026-11-13 14:00 UTC, so this may be out of date.']);
  assert.deepEqual(problemsOf(status('a.md', 'A', [], { stale: true, asOf: Date.UTC(2026, 10, 13) })), ['Prices end on 2026-11-13, so this may be out of date.']);
});

test('the header names the oldest bar among the strategies with orders when they differ', () => {
  const older = status('a.md', 'A', [['buy', 'X']], { asOf: Date.UTC(2026, 10, 12) });
  const newer = status('b.md', 'B', [['buy', 'Y']], { asOf: Date.UTC(2026, 10, 13) });
  const quietButOld = status('c.md', 'C', [], { asOf: Date.UTC(2026, 10, 2) });
  assert.deepEqual(basisOf([newer]), { text: 'Based on the close of 2026-11-13', note: null });
  assert.deepEqual(basisOf([newer, older, quietButOld]), { text: 'Based on the close of 2026-11-12', note: 'This is the oldest among the orders. Each order shows its own.' });
  assert.deepEqual(basisOf([newer, { ...newer, note: 'x.md' }]), { text: 'Based on the close of 2026-11-13', note: null });
});

test('with no orders the header names the oldest strategy that ran, and a failure is ignored', () => {
  const a = status('a.md', 'A', [], { asOf: Date.UTC(2026, 10, 12) });
  const b = status('b.md', 'B', [], { asOf: Date.UTC(2026, 10, 13) });
  assert.deepEqual(basisOf([b, a, failedStatus('c.md', 'C', 'x')]), { text: 'Based on the close of 2026-11-12', note: 'This is the oldest among the strategies checked.' });
  assert.equal(basisOf([]), null);
});

test('an intraday header and row say which bar, with the time', () => {
  const s = status('a.md', 'A', [['buy', 'X']], { interval: '5m', asOf: Date.UTC(2026, 10, 13, 14, 5) });
  assert.equal(basisOf([s])!.text, 'Based on the 5m bar starting 2026-11-13 14:05 UTC');
  const md = ordersMarkdown([s], SAMPLE_NOW);
  assert.ok(md.includes('Based on the 5m bar starting 2026-11-13 14:05 UTC. From backtests'));
  assert.ok(md.includes('| 5m bar starting 2026-11-13 14:05 UTC |'));
});

test('the Markdown lists the oldest date in the header and each row\'s own', () => {
  const md = ordersMarkdown(
    [status('a.md', 'A', [['buy', 'X']], { asOf: Date.UTC(2026, 10, 12) }), status('b.md', 'B', [['sell', 'Y']], { asOf: Date.UTC(2026, 10, 13) })],
    SAMPLE_NOW,
  );
  assert.ok(md.includes('Based on the close of 2026-11-12. This is the oldest among the orders. Each order shows its own. From backtests'));
  assert.ok(md.includes('| Sell | Y | Whole position, about $100 | 10.00 | Close of 2026-11-13 |'));
  assert.ok(md.includes('| Buy | X | 50% of the strategy, about $100 | 10.00 | Close of 2026-11-12 |'));
});

// --- Saving over a note --------------------------------------------------------------------------------------------

test('the generated note starts with the marker that lets it be replaced', () => {
  for (const list of [[], sample()]) {
    const md = ordersMarkdown(list, SAMPLE_NOW);
    assert.ok(md.startsWith('---\nbacktest_orders: true\n---\n'));
    assert.equal(ordersSavePlan(md), 'replace');
  }
});

test('saving creates a missing note, replaces one with the marker and refuses any other', () => {
  assert.equal(ordersSavePlan(null), 'create');
  assert.equal(ordersSavePlan('---\nbacktest_orders: true\n---\n\n# Today'), 'replace');
  assert.equal(ordersSavePlan('---\r\ntags: [a]\r\nbacktest_orders: true\r\n---\r\nBody'), 'replace');
  assert.equal(ordersSavePlan('﻿---\nbacktest_orders:   true  \n---\n'), 'replace');
  assert.equal(ordersSavePlan(''), 'refuse');
  assert.equal(ordersSavePlan('# My own orders note\n'), 'refuse');
  assert.equal(ordersSavePlan('---\ntags: [a]\n---\nbacktest_orders: true\n'), 'refuse');
  assert.equal(ordersSavePlan('---\nbacktest_orders: false\n---\n'), 'refuse');
  assert.equal(ordersSavePlan('---\nbacktest_orders: truely\n---\n'), 'refuse');
  assert.equal(ordersSavePlan('---\nother_backtest_orders: true\n---\n'), 'refuse');
  // The marker has to be in the front matter, which has to start the note and be closed.
  assert.equal(ordersSavePlan('Notes\n---\nbacktest_orders: true\n---\n'), 'refuse');
  assert.equal(ordersSavePlan('---\nbacktest_orders: true\n'), 'refuse');
});

test('the message for a note that is not ours names the note and what to do', () => {
  assert.equal(notOurNoteMessage('Trading/Orders.md'), 'Trading/Orders.md already exists and was not made by Backtest Blocks. Choose another note in settings.');
});

// --- Running several at once ---------------------------------------------------------------------------------------

test('mapLimit keeps results in order and never runs more than the limit at once', async () => {
  let active = 0;
  let most = 0;
  const out = await mapLimit([5, 1, 4, 2, 3, 6, 0], 3, async (n, i) => {
    active++;
    most = Math.max(most, active);
    await new Promise((r) => setTimeout(r, n));
    active--;
    return `${i}:${n}`;
  });
  assert.deepEqual(out, ['0:5', '1:1', '2:4', '3:2', '4:3', '5:6', '6:0']);
  assert.equal(most, 3);
  assert.deepEqual(await mapLimit([], 3, async (x) => x), []);
  assert.deepEqual(await mapLimit([1, 2], 10, async (x) => x * 2), [2, 4]);
});

test('the orders window words a later entry as Add, in the list, its grouping and the note it saves', () => {
  const data = { A: bars([10, 10, 12, 15]), B: bars([5, 5, 5, 20]) };
  const src = (fill: string) => `universe: A, B\ncapital: 1000\nentries: 3\n${fill}buy when close > 9\nadd when close > last entry price * 1.01\nsell when close < 5`;
  const shown = (fill: string) => {
    const status = statusFrom('Notes/Adding.md', 'Adding', run(src(fill), data), NOW);
    return { status, rows: todoRows([status]) };
  };
  const open = shown('');
  // What the window draws for each row: the action word and the size line.
  assert.deepEqual(
    todoGroups(open.rows).flatMap((g) => g.rows.map(({ order }) => [g.when, actionWord(order), order.ticker, orderSize(order).split(':')[0]])),
    [
      ['next open', 'Add', 'A', 'Step 3 of 3'],
      ['next open', 'Buy', 'B', 'Step 1 of 3'],
    ],
  );
  assert.match(ordersMarkdown([open.status], NOW), /\| Add \| A \| Step 3 of 3: /);
  assert.match(ordersMarkdown([open.status], NOW), /\| Buy \| B \| Step 1 of 3: /);
  const close = shown('fill: close\n');
  assert.deepEqual(close.rows.map(({ order }) => [actionWord(order), order.ticker]), [['Added', 'A'], ['Bought', 'B']]);
  assert.match(ordersMarkdown([close.status], NOW), /\| Added \| A \| Step 3 of 3: /);
});
