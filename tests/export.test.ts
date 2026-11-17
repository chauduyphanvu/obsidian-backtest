import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest, type Segment, type Stats, type TradeStats } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import type { AssetState, Trade } from '../src/engine.ts';
import { equityCsv, planProperties, propertyIds, resultProperties, snapshotMarkdown, tradesCsv } from '../src/export.ts';
import { bars, DAY, T0 } from './helpers.ts';

const utc = (y: number, m: number, d: number, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm);

const trade = (o: Partial<Trade>): Trade => ({ asset: 'SPY', entryT: utc(2020, 1, 2), entryPrice: 100, exitT: utc(2020, 1, 10), exitPrice: 110, ret: 0.1, reason: 'signal', bars: 6, pnl: 100, ...o });

test('trades CSV: header, rounding, quoting and an open trade with no sale', () => {
  const csv = tradesCsv(
    [
      trade({ entryPrice: 100.5, exitPrice: 110.123456789, ret: 0.0912345, pnl: 912.349 }),
      trade({ asset: 'BTC,USD', entryT: utc(2020, 1, 3), entryPrice: 5, exitT: utc(2020, 1, 6), exitPrice: 4, ret: -0.2, reason: 'stop loss', bars: 3, pnl: -200 }),
      trade({ asset: 'A"B', entryT: utc(2020, 1, 7), entryPrice: 10, exitT: utc(2020, 1, 8), exitPrice: 11, ret: 0.1, reason: 'open', bars: 2, pnl: 50.5 }),
      trade({ asset: 'FLAT', ret: -0.000001, pnl: -0.001, reason: 'take profit' }),
    ],
    false,
  );
  assert.equal(
    csv,
    [
      'ticker,bought,buy_price,sold,sell_price,return_pct,profit,bars,exit',
      'SPY,2020-01-02,100.5,2020-01-10,110.123457,9.12,912.35,6,signal',
      '"BTC,USD",2020-01-03,5,2020-01-06,4,-20.00,-200.00,3,stop loss',
      '"A""B",2020-01-07,10,,,10.00,50.50,2,open',
      'FLAT,2020-01-02,100,2020-01-10,110,0.00,0.00,6,take profit',
      '',
    ].join('\n'),
  );
});

test('trades CSV: no trades is just the header, and intraday runs keep the time of day', () => {
  assert.equal(tradesCsv([], false), 'ticker,bought,buy_price,sold,sell_price,return_pct,profit,bars,exit\n');
  const csv = tradesCsv([trade({ entryT: utc(2020, 1, 2, 14, 30), exitT: utc(2020, 1, 2, 19, 5) })], true);
  assert.equal(csv.split('\n')[1], 'SPY,2020-01-02 14:30,100,2020-01-02 19:05,110,10.00,100.00,6,signal');
});

test('equity CSV: values to the cent and the strategy drawdown in percent', () => {
  const t = [utc(2020, 1, 1), utc(2020, 1, 2), utc(2020, 1, 3), utc(2020, 1, 4)];
  const csv = equityCsv(t, [100, 110, 99, 104.5], [100, 105, 110.126, 98], 'SPY buy & hold', false);
  assert.equal(
    csv,
    ['date,strategy,SPY buy & hold,drawdown_pct', '2020-01-01,100.00,100.00,0.00', '2020-01-02,110.00,105.00,0.00', '2020-01-03,99.00,110.13,-10.00', '2020-01-04,104.50,98.00,-5.00', ''].join('\n'),
  );
});

test('equity CSV: a benchmark with no value yet has an empty field', () => {
  const t = [utc(2020, 1, 1), utc(2020, 1, 2), utc(2020, 1, 3)];
  const csv = equityCsv(t, [100, 110, 99], [NaN, 100, 105], 'B buy & hold', false);
  assert.equal(csv, ['date,strategy,B buy & hold,drawdown_pct', '2020-01-01,100.00,,0.00', '2020-01-02,110.00,100.00,0.00', '2020-01-03,99.00,105.00,-10.00', ''].join('\n'));
});

test('equity CSV: a benchmark label with a comma is quoted, and intraday dates carry the time', () => {
  const csv = equityCsv([utc(2020, 1, 2, 14, 30), utc(2020, 1, 2, 14, 31)], [1, 2], [1, 1], 'A, B buy & hold', true);
  assert.equal(csv, 'date,strategy,"A, B buy & hold",drawdown_pct\n2020-01-02 14:30,1.00,1.00,0.00\n2020-01-02 14:31,2.00,1.00,0.00\n');
});

// --- Snapshot and properties, on a result built by hand so every figure is known -----------------------------------

const stats = (o: Partial<Stats> = {}): Stats => ({ totalReturn: 0.5, cagr: 0.1234, maxDrawdown: -0.2351, volatility: 0.15, sharpe: 0.876, sortino: 1.1, exposure: 0.634, ...o });
const tradeStats = (o: Partial<TradeStats> = {}): TradeStats => ({ count: 2, open: 1, winRate: 0.5, avgReturn: 0.03, ...o });
const state = (name: string, long: boolean, o: Partial<AssetState> = {}): AssetState => ({
  name,
  weight: 0.5,
  long,
  since: long ? utc(2020, 1, 7) : null,
  pending: null,
  shares: 0,
  lastClose: 0,
  value: 0,
  targetWeight: 0.5,
  ...o,
});

function result(opts: { states?: AssetState[]; trades?: Trade[]; segments?: Segment[] | null; source?: string } = {}): Backtest {
  const { spec } = parseSpec(opts.source ?? 'name: Trend following\nuniverse: SPY, TLT\ncapital: 10000\nbuy when true');
  const t = [utc(2020, 1, 1), utc(2020, 1, 2), utc(2020, 1, 3)];
  return {
    spec: spec!,
    data: new Map(),
    run: {
      t,
      equity: [10000, 11000, 12000],
      exposure: [1, 1, 1],
      trades: opts.trades ?? [trade({}), trade({ asset: 'TLT', entryT: utc(2020, 1, 7), entryPrice: 50, reason: 'open', ret: 0.04, pnl: 20 })],
      states: opts.states ?? [state('SPY', true), state('TLT', false)],
      costs: 0,
      interest: 0,
      cashReturn: [0, 0, 0],
      skipped: [],
    },
    stats: stats(),
    tradeStats: tradeStats(),
    drawdown: [0, 0, 0],
    benchmark: { label: 'SPY buy & hold', equity: [10000, 10500, 11000], drawdown: [0, 0, 0], stats: stats({ totalReturn: 0.1, cagr: 0.0789, maxDrawdown: -0.34, sharpe: 0.5, exposure: 1 }) },
    interest: 0,
    cashRateNote: 'Cash earns nothing',
    segments: opts.segments ?? null,
    notes: [],
  };
}

const NOW = utc(2026, 11, 17, 8, 30);

test('result properties: keys, rounding and the held tickers', () => {
  assert.deepEqual(resultProperties(result(), NOW), {
    bt_return_per_year: 12.3,
    bt_worst_drawdown: -23.5,
    bt_sharpe: 0.88,
    bt_trades: 2,
    bt_invested: 63,
    bt_from: '2020-01-01',
    bt_to: '2020-01-03',
    bt_benchmark_return_per_year: 7.9,
    bt_last_run: '2026-11-17',
    bt_position: 'SPY',
  });
  assert.equal(resultProperties(result({ states: [state('SPY', true), state('TLT', true)] }), NOW).bt_position, 'SPY, TLT');
  assert.equal(resultProperties(result({ states: [state('SPY', false), state('TLT', false)] }), NOW).bt_position, 'cash');
});

test('result properties: an id goes between bt_ and the rest of every key', () => {
  const bt = result();
  const plain = Object.keys(resultProperties(bt, NOW));
  assert.deepEqual(Object.keys(resultProperties(bt, NOW, '')), plain);
  const keys = Object.keys(resultProperties(bt, NOW, 'trend_following'));
  assert.deepEqual(keys, plain.map((k) => `bt_trend_following_${k.slice(3)}`));
  assert.equal(keys[0], 'bt_trend_following_return_per_year');
  assert.equal(resultProperties(bt, NOW, '2').bt_2_sharpe, 0.88);
});

test('property ids: a note with one strategy keeps plain keys, named or not', () => {
  assert.deepEqual(propertyIds([]), []);
  assert.deepEqual(propertyIds(['Trend following']), ['']);
  assert.deepEqual(propertyIds([null]), ['']);
});

test('property ids: with several strategies a name gives its slug and an unnamed one its position', () => {
  assert.deepEqual(propertyIds(['Trend following', null, 'Trend / momentum (v2)!', '日本株']), ['trend_following', '2', 'trend_momentum_v2', '日本株']);
});

test('property ids: two unnamed strategies, or equal slugs, never share a key', () => {
  assert.deepEqual(propertyIds([null, null]), ['1', '2']);
  // "Trend A" and "Trend-A" both read as trend_a: the second falls back to its position.
  assert.deepEqual(propertyIds(['Trend A', 'Trend-A', 'trend a']), ['trend_a', '2', '3']);
  // A name with no letters or digits has no slug.
  assert.deepEqual(propertyIds(['📈', '---']), ['1', '2']);
});

test('property ids: a position never takes a key that a name already uses', () => {
  assert.deepEqual(propertyIds(['2', null, null]), ['2', '2_2', '3']);
  // "x" with "benchmark_return_per_year" and "x_benchmark" with "return_per_year" make the same key.
  const ids = propertyIds(['x', 'x benchmark', 'x']);
  assert.deepEqual(ids, ['x', '2', '3']);
  const keys = ids.flatMap((id) => Object.keys(resultProperties(result(), NOW, id)));
  assert.equal(new Set(keys).size, keys.length);
});

test('result properties: a figure that cannot be worked out is left empty', () => {
  const bt = result();
  bt.stats = stats({ cagr: NaN });
  assert.equal(resultProperties(bt, NOW).bt_return_per_year, '');
});

test('result properties come out of a real run', () => {
  const { spec } = parseSpec('universe: A\ncapital: 1000\nbuy when true');
  const bt = runBacktest(spec!, new Map([['A', bars([10, 11, 12.1, 13.31], { start: T0, step: DAY })]]));
  const p = resultProperties(bt, NOW);
  assert.equal(p.bt_from, '2020-01-01');
  assert.equal(p.bt_to, '2020-01-04');
  assert.equal(p.bt_trades, 0);
  assert.equal(p.bt_position, 'A');
  // The buy fills at the second bar's open, so one bar in four is spent in cash.
  assert.equal(p.bt_invested, 75);
});

const SNAPSHOT = [
  '---',
  'tags: [backtest/snapshot]',
  'created: 2026-11-17',
  '---',
  '',
  '# Trend following',
  '',
  'Snapshot taken on 2026-11-17. The run covers 2020-01-01 to 2020-01-03, starting with $10k, and is compared with SPY buy & hold.',
  '',
  '## Strategy',
  '',
  'Kept as plain text, so it does not run again.',
  '',
  '```text',
  'universe: SPY, TLT',
  'buy when close > sma(200)',
  '```',
  '',
  '## Figures',
  '',
  '|  | Strategy | SPY buy & hold |',
  '| --- | ---: | ---: |',
  '| Return per year | 12.3% | 7.9% |',
  '| Total return | 50.0% | 10.0% |',
  '| Worst drawdown | −23.5% | −34.0% |',
  '| Sharpe ratio | 0.88 | 0.50 |',
  '| Time invested | 63% | 100% |',
  '| Trades | 2 closed, 1 open | – |',
  '| Share won | 50% | – |',
  '',
  '## Positions now',
  '',
  '| Ticker | Weight | Now |',
  '| --- | ---: | --- |',
  '| SPY | 50% | Long since 2020-01-07 |',
  '| TLT | 50% | In cash, buys at the next open |',
  '',
  '## Latest trades',
  '',
  '| Ticker | Bought | At | Sold | At | Return | Exit |',
  '| --- | --- | ---: | --- | ---: | ---: | --- |',
  '| TLT | 2020-01-07 | 50.00 | – | – | +4.0% | still held |',
  '| SPY | 2020-01-02 | 100.00 | 2020-01-10 | 110.00 | +10.0% | sell rule |',
  '',
].join('\n');

test('snapshot: front matter, a text fence, figures, positions and trades, newest first', () => {
  const bt = result({ states: [state('SPY', true), state('TLT', false, { pending: 'buy' })] });
  const md = snapshotMarkdown({ name: 'Trend following', source: '\nuniverse: SPY, TLT\nbuy when close > sma(200)\n', backtest: bt, now: NOW });
  assert.equal(md, SNAPSHOT);
  assert.ok(!md.includes('```strategy'));
});

test('snapshot: the before and after table appears when the run has a test date', () => {
  const part = (label: string, from: number, to: number, o: Partial<Stats>): Segment => ({
    label,
    from,
    to,
    stats: stats(o),
    benchmarkStats: stats({ cagr: 0.05 }),
    tradeStats: tradeStats({ count: 3, open: 0 }),
  });
  const bt = result({ segments: [part('Before 2020-01-03', utc(2020, 1, 1), utc(2020, 1, 2), { cagr: 0.2, totalReturn: 12, sharpe: -0.123 }), part('From 2020-01-03', utc(2020, 1, 3), utc(2020, 1, 3), { cagr: -0.1 })] });
  const md = snapshotMarkdown({ name: 'T', source: 'x', backtest: bt, now: NOW });
  assert.ok(
    md.includes(
      [
        '## Before and after the test date',
        '',
        '| Period | Dates | Return per year | Total return | Worst drawdown | Sharpe ratio | Trades | SPY buy & hold, return per year |',
        '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
        '| Before 2020-01-03 | 2020-01-01 to 2020-01-02 | 20.0% | 1200% | −23.5% | −0.12 | 3 | 5.0% |',
        '| From 2020-01-03 | 2020-01-03 to 2020-01-03 | −10.0% | 50.0% | −23.5% | 0.88 | 3 | 5.0% |',
        '',
      ].join('\n'),
    ),
  );
  assert.ok(!snapshotMarkdown({ name: 'T', source: 'x', backtest: result(), now: NOW }).includes('Before and after'));
});

test('snapshot: only the latest 30 trades, a fence that outgrows backticks in the text, and a pipe in a ticker', () => {
  const many = Array.from({ length: 35 }, (_, i) => trade({ asset: `T${i}`, entryT: utc(2020, 1, 1) + i * DAY }));
  const md = snapshotMarkdown({ name: '', source: 'a ```` b', backtest: result({ trades: many }), now: NOW });
  assert.ok(md.includes('# Backtest\n'));
  assert.ok(md.includes('Showing the latest 30 of 35.'));
  assert.ok(md.includes('| T34 |') && md.includes('| T5 |') && !md.includes('| T4 |'));
  assert.ok(md.includes('`````text\na ```` b\n`````\n'));
  const piped = snapshotMarkdown({ name: 'p', source: 'x', backtest: result({ trades: [trade({ asset: 'A|B' })] }), now: NOW });
  assert.ok(piped.includes('| A\\|B |'));
  assert.ok(snapshotMarkdown({ name: 'p', source: 'x', backtest: result({ trades: [] }), now: NOW }).includes('## Latest trades\n\nNo trades.\n'));
});

// --- What to write to a note's front matter ------------------------------------------------------------------------

const figures = (id: string, o: Record<string, string | number> = {}): Record<string, string | number> => ({ ...resultProperties(result(), NOW, id), ...o });

test('a note with no properties yet gets every figure', () => {
  const produced = figures('');
  assert.deepEqual(planProperties(undefined, produced, true), { set: produced, remove: [] });
  assert.deepEqual(planProperties({ title: 'x' }, produced, true), { set: produced, remove: [] });
});

test('figures that did not change give nothing to write, and the last-run date stays as it was', () => {
  const produced = figures('');
  const before = { ...produced, bt_last_run: '2026-11-10', title: 'x' };
  assert.deepEqual(planProperties(before, produced, true), { set: {}, remove: [] });
  assert.deepEqual(planProperties(before, produced, false), { set: {}, remove: [] });
});

test('when a figure changes, it is written together with the last-run date', () => {
  const produced = figures('', { bt_sharpe: 1.1 });
  const before = { ...figures(''), bt_last_run: '2026-11-10' };
  assert.deepEqual(planProperties(before, produced, true), { set: { bt_sharpe: 1.1, bt_last_run: '2026-11-17' }, remove: [] });
});

test('a missing last-run date is written even when nothing else changed', () => {
  const produced = figures('');
  const { bt_last_run: _, ...before } = produced;
  assert.deepEqual(planProperties(before, produced, true), { set: { bt_last_run: '2026-11-17' }, remove: [] });
});

test('with several strategies each has its own last-run key, and all follow a change in any', () => {
  const produced = { ...figures('trend'), ...figures('2', { bt_2_sharpe: 9 }) };
  const before = { ...figures('trend'), ...figures('2'), bt_trend_last_run: '2026-11-10', bt_2_last_run: '2026-11-10' };
  assert.deepEqual(planProperties(before, produced, true), { set: { bt_2_sharpe: 9, bt_trend_last_run: '2026-11-17', bt_2_last_run: '2026-11-17' }, remove: [] });
});

test('when every strategy ran, bt_ keys that none produces any more are removed, and other properties stay', () => {
  const produced = figures('');
  const old = figures('trend_following');
  const before = { ...produced, ...old, bt_last_run: '2026-11-10', status: 'draft', btx: 1, 'Bt_other': 2 };
  const plan = planProperties(before, produced, true);
  assert.deepEqual(plan.remove.sort(), Object.keys(old).sort());
  // Removing something counts as a change, so the date moves.
  assert.deepEqual(plan.set, { bt_last_run: '2026-11-17' });
});

test('when a strategy did not run, old keys are left alone', () => {
  const produced = figures('trend');
  const before = { ...figures('momentum'), ...produced };
  assert.deepEqual(planProperties(before, produced, false), { set: {}, remove: [] });
});

test('a note that produced nothing is left alone', () => {
  assert.deepEqual(planProperties({ ...figures('') }, {}, true), { set: {}, remove: [] });
});

test('going from several strategies to one removes the keys of the others', () => {
  const before = { ...figures('trend'), ...figures('2') };
  const produced = figures('');
  const plan = planProperties(before, produced, true);
  assert.equal(plan.remove.length, Object.keys(before).length);
  assert.deepEqual(Object.keys(plan.set).sort(), Object.keys(produced).sort());
});
