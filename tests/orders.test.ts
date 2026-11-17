import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { failedStatus, latestAsOf, orderSize, ordersMarkdown, problemsOf, sortStatuses, statusFrom, todoRows, type OrderRow, type StrategyStatus } from '../src/orders.ts';
import type { RunOutput } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY, T0 } from './helpers.ts';

function run(src: string, data: Record<string, Bars>, warnings: string[] = []): RunOutput {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  const map = new Map(Object.entries(data));
  return { spec: spec!, backtest: runBacktest(spec!, map), data: map, warnings };
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
    orders: [{ ticker: 'A', action: 'buy', weight: 1, value: 1000, lastClose: 12, since: null }],
    holdings: [],
    equity: 1000,
    warnings: [],
    error: null,
    stale: false,
  });
});

test('a pending sell becomes a sell order for the whole position and is not a holding', () => {
  // Bought at day 1's open (10): 100 shares, 800 after the close at 8, when the sell rule fires.
  const out = run('universe: A\ncapital: 1000\nbuy when true\nsell when close < 9', { A: bars([10, 10, 10, 8]) });
  const s = statusFrom('n.md', 'S', out, NOW);
  assert.deepEqual(s.orders, [{ ticker: 'A', action: 'sell', weight: 0, value: 800, lastClose: 8, since: day(1) }]);
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
  assert.deepEqual(s.orders, [{ ticker: 'B', action: 'buy', weight: 0.5, value: 500, lastClose: 20, since: null }]);
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

function status(note: string, strategy: string, orders: Array<[OrderRow['action'], string]> = [], more: Partial<StrategyStatus> = {}): StrategyStatus {
  return {
    note,
    strategy,
    asOf: day(2),
    orders: orders.map(([action, ticker]) => ({ ticker, action, weight: action === 'buy' ? 0.5 : 0, value: 100, lastClose: 10, since: null })),
    holdings: [],
    equity: 1000,
    warnings: [],
    error: null,
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
  assert.deepEqual(f, { note: 'n.md', strategy: 'S', asOf: 0, orders: [], holdings: [], equity: 0, warnings: [], error: "Couldn't load XYZ from yahoo: HTTP 404", stale: false });
  assert.deepEqual(problemsOf(f), ["Couldn't run. Couldn't load XYZ from yahoo: HTTP 404"]);
  assert.equal(latestAsOf([f]), null);
  assert.equal(latestAsOf([f, status('a.md', 'A', [], { asOf: day(5) }), status('b.md', 'B', [], { asOf: day(3) })]), day(5));
});

test('order sizes are a share of the strategy with dollars second', () => {
  const order = (action: OrderRow['action'], weight: number, value: number): OrderRow => ({ ticker: 'A', action, weight, value, lastClose: 1, since: null });
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
      orders: [{ ticker: 'QQQ', action: 'buy', weight: 0.2, value: 2100, lastClose: 380.1, since: null }],
    }),
    failedStatus('Strategies/Broken.md', 'Broken', "Couldn't load XYZ from yahoo: HTTP 404"),
    status('Strategies/Old.md', 'Old one', [], { asOf: Date.UTC(2026, 10, 1), stale: true, warnings: ["Couldn't refresh SPY (HTTP 500); using prices saved on 2026-10-30."] }),
    status('Strategies/Trend.md', 'Trend following', [['sell', 'SPY']], {
      ...base,
      orders: [{ ticker: 'SPY', action: 'sell', weight: 0, value: 10_500, lastClose: 412.34, since: Date.UTC(2026, 0, 5) }],
    }),
    status('Strategies/Idle.md', 'Strategy 2', [], base),
  ];
}

test('the Markdown lists the orders, what is held, and the problems', () => {
  assert.equal(
    ordersMarkdown(sample(), SAMPLE_NOW),
    [
      "# Today's orders, 2026-11-17",
      '',
      'Based on prices through 2026-11-16. From backtests of your rules on the latest prices. Nothing here places an order.',
      '',
      '## To do at the next open',
      '',
      '| Strategy | Action | Ticker | Size | Last close |',
      '| --- | --- | --- | --- | ---: |',
      '| [[Strategies/Trend\\|Trend following]] | Sell | SPY | Whole position, about $10.5k | 412.34 |',
      '| [[Strategies/Rotation\\|Rotation]] | Buy | QQQ | 20% of the strategy, about $2,100 | 380.10 |',
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
      "# Today's orders, 2026-11-17",
      '',
      'Based on prices through 2026-11-16. From backtests of your rules on the latest prices. Nothing here places an order.',
      '',
      '## To do at the next open',
      '',
      'No strategy has an order for the next open.',
      '',
      '## Nothing to do',
      '',
      '- [[a|A]]: In cash',
      '',
    ].join('\n'),
  );
  assert.equal(ordersMarkdown([], SAMPLE_NOW), "# Today's orders, 2026-11-17\n\nNo strategy blocks found.\n");
});

test('the Markdown heading is the reader\'s date, and a name cannot break the link', () => {
  const late = local(2026, 11, 17, 23, 59);
  const early = local(2026, 11, 17, 0, 0);
  const odd = status('a.md', 'Odd [one] | two', [['buy', 'X']], { asOf: SAMPLE_ASOF });
  for (const now of [late, early]) assert.ok(ordersMarkdown([odd], now).startsWith("# Today's orders, 2026-11-17\n"));
  assert.ok(ordersMarkdown([odd], SAMPLE_NOW).includes('| [[a\\|Odd one two]] | Buy | X |'));
});
