// What a short, flipping, leveraged, margin-called or ruined result says outside the page: the folded line, the trades CSV,
// the snapshot note and the note properties, the dashboard row and the words of the price chart.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { nextLines, rowFrom } from '../src/dashboard.ts';
import { parseSpec } from '../src/dsl.ts';
import { resultProperties, snapshotMarkdown, tradesCsv } from '../src/export.ts';
import { isoDate } from '../src/format.ts';
import type { OrderRow } from '../src/orders.ts';
import { exitWording, tradeExit } from '../src/price-chart.ts';
import { compactFacts } from '../src/render.ts';
import type { RunOutput } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY, T0 } from './helpers.ts';

function run(src: string, data: Record<string, Bars>): RunOutput {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  const map = new Map(Object.entries(data));
  return { spec: spec!, backtest: runBacktest(spec!, map), data: map, warnings: [], prices: [] };
}
const day = (n: number) => T0 + n * DAY;
const date = (n: number) => isoDate(day(n));
/** Bars with the given [open, high, low, close] rows, daily from day 0. */
function ohlc(rows: number[][]): Bars {
  return { t: rows.map((_, n) => day(n)), o: rows.map((r) => r[0]), h: rows.map((r) => r[1]), l: rows.map((r) => r[2]), c: rows.map((r) => r[3]), v: rows.map(() => 1000) };
}

const FLIP = 'universe: A\nbuy when close > 100\nshort when close < 100';
const SHORT_COVER = 'universe: A\ncapital: 10000\nborrow fee: 0.5%\nshort when close >= 100\ncover when close < 85';
/** 200 shares bought at 100 with 10,000: at 66 equity is below 25% of the position, so the next open sells at 65. */
const CALLED = ohlc([[100, 100, 100, 100], [100, 100, 70, 70], [70, 70, 66, 66], [65, 65, 60, 60], [60, 70, 60, 70]]);
/** The same, but the next open is 45: 9,000 against 10,000 owed, so the run is ruined there. */
const RUINED = ohlc([[100, 100, 100, 100], [100, 100, 70, 70], [70, 70, 66, 66], [45, 65, 45, 60], [60, 80, 60, 80], [80, 90, 80, 90]]);
const LEVERED = 'universe: A 200%\ncapital: 10000\nmargin rate: 0%\nbuy when true';

// ------------------------------------------------------------------ the folded line

test('the folded line names a short held, with the day it was sold short', () => {
  const facts = compactFacts(run('universe: A\nshort when true', { A: bars([10, 10, 12, 15]) }));
  assert.equal(facts.holding, `Short A since ${date(1)}`);
  assert.equal(facts.order, null);
  // Several held say which side, in the dashboard's words; only longs keep "Holds".
  const both = compactFacts(run('universe: A, B\nfor A:\nbuy when true\nfor B:\nshort when true', { A: bars([10, 10, 12]), B: bars([10, 10, 12]) }));
  assert.equal(both.holding, 'Long 1, short 1 of 2');
  const shorts = compactFacts(run('universe: A, B, C\nshort when close < 11', { A: bars([10, 10, 9]), B: bars([10, 10, 9]), C: bars([12, 12, 12]) }));
  assert.equal(shorts.holding, 'Short 2 of 3');
});

test('a ruined run averages its net exposure over the bars its gross exposure covers', () => {
  const out = run(LEVERED, { A: RUINED });
  assert.ok(out.backtest.run.ruin);
  // Long only, so net is gross at every bar up to the ruin; the bars after it, at 0, count in neither.
  assert.ok(out.backtest.stats.exposure > 1);
  assert.equal(out.backtest.stats.netExposure, out.backtest.stats.exposure);
});

test('the folded line says a short sale and a cover waiting for the next open', () => {
  assert.equal(compactFacts(run('universe: A\nshort when close < 11', { A: bars([12, 12, 10]) })).order, 'sells short A at the next open');
  const cover = compactFacts(run('universe: A\nshort when true\ncover when close < 9', { A: bars([10, 10, 10, 8]) }));
  assert.deepEqual([cover.holding, cover.order], [`Short A since ${date(1)}`, 'buys to cover A at the next open']);
});

test('a flip waiting for the next open is said as its two orders, in the order they fill', () => {
  const toShort = compactFacts(run(FLIP, { A: bars([101, 101, 99]) }));
  assert.deepEqual([toShort.holding, toShort.order], [`Long A since ${date(1)}`, 'sells A and sells short A at the next open']);
  const toLong = compactFacts(run(FLIP, { A: bars([99, 99, 101]) }));
  assert.deepEqual([toLong.holding, toLong.order], [`Short A since ${date(1)}`, 'buys to cover A and buys A at the next open']);
});

test('with fill: close a flip made at the last close is said in the past, and so is a short sale', () => {
  const toShort = compactFacts(run(`${FLIP}\nfill: close`, { A: bars([101, 99]) }));
  assert.deepEqual([toShort.holding, toShort.order], [`Short A since ${date(1)}`, 'sold A and sold short A at the last close']);
  const toLong = compactFacts(run(`${FLIP}\nfill: close`, { A: bars([99, 101]) }));
  assert.equal(toLong.order, 'bought to cover A and bought A at the last close');
  const opened = compactFacts(run('universe: A\nfill: close\nshort when close < 11', { A: bars([12, 10]) }));
  assert.equal(opened.order, 'sold short A at the last close');
  const covered = compactFacts(run('universe: A\nfill: close\nshort when close < 11\ncover when close > 11', { A: bars([12, 10, 12]) }));
  assert.equal(covered.order, 'bought to cover A at the last close');
});

test('a margin call made at the last close is said as such, for the next open even with fill: close', () => {
  // The call is made at the close of 66, the last bar.
  const called = ohlc([[100, 100, 100, 100], [100, 100, 70, 70], [70, 70, 66, 66]]);
  for (const fill of ['', 'fill: close\n']) {
    const facts = compactFacts(run(fill + LEVERED, { A: called }));
    assert.deepEqual([facts.holding, facts.order], [`Long A since ${fill ? date(0) : date(1)}`, 'margin call: sells A at the next open']);
  }
  const short = ohlc([[100, 100, 100, 100], [100, 100, 100, 100], [100, 140, 100, 140], [140, 190, 140, 190]]);
  const out = run('universe: A\ncapital: 10000\nmargin rate: 0%\nborrow fee: 0%\nshort when true', { A: short });
  assert.equal(out.backtest.run.states[0].marginCall, true);
  assert.equal(compactFacts(out).order, 'margin call: buys to cover A at the next open');
});

// ------------------------------------------------------------------ exit words

test('a trade\'s exit: the cover rule for a short, a flip when the other side opened, else the rule that closed it', () => {
  const close = run(`${FLIP}\nfill: close`, { A: bars([101, 99, 101, 102]) }).backtest.run.trades;
  assert.deepEqual(
    close.map((t) => [t.side ?? 'long', tradeExit(t, close)]),
    [['long', 'flipped to short'], ['short', 'flipped to long'], ['long', 'not closed']],
  );
  const covered = run(SHORT_COVER, { A: bars([100, 90, 80, 80]) }).backtest.run.trades;
  assert.equal(tradeExit(covered[0], covered), 'cover rule');
  // The buy rule closes the short, but a sell rule that holds too keeps the long from opening: no flip.
  const vetoed = run('universe: A\nbuy when close > 100\nsell when close > 105\nshort when close < 100', { A: bars([99, 99, 106, 106]) }).backtest.run.trades;
  assert.deepEqual(vetoed.map((t) => [t.side ?? 'long', tradeExit(t, vetoed)]), [['short', 'buy rule']]);
  // Forced closes keep their names, and a long's words are what they were.
  const called = run(LEVERED, { A: CALLED }).backtest.run.trades;
  assert.equal(tradeExit(called[0], called), 'margin call');
  const ruined = run(LEVERED, { A: RUINED }).backtest.run.trades;
  assert.equal(tradeExit(ruined[0], ruined), 'ruin');
  const long = run('universe: A\nbuy when close > 10\nsell when close < 10', { A: bars([10, 12, 9, 9]) }).backtest.run.trades;
  assert.equal(tradeExit(long[0], long), 'sell rule');
  assert.equal(exitWording('signal'), 'sell rule');
});

// ------------------------------------------------------------------ the trades CSV, the snapshot and the properties

test('the trades CSV of a run that shorts gets a side column at the end, so the others keep their places', () => {
  const out = run(`${FLIP}\nfill: close`, { A: bars([101, 99, 101]) });
  const lines = tradesCsv(out.backtest.run.trades, false).trim().split('\n');
  assert.equal(lines[0], 'ticker,bought,buy_price,sold,sell_price,return_pct,profit,bars,exit,side');
  assert.deepEqual(
    lines.slice(1).map((l) => { const f = l.split(','); return [f[0], f[1], f[8], f[9]]; }),
    [['A', date(0), 'signal', 'long'], ['A', date(1), 'signal', 'short'], ['A', date(2), 'open', 'long']],
  );
  // With entries the side still comes last.
  const steps = run('universe: A\nentries: 2\nshort when close < 100\nadd when close < 99\ncover when close > 105', { A: bars([99, 98, 97, 106, 106]) });
  const head = tradesCsv(steps.backtest.run.trades, false).split('\n')[0];
  assert.equal(head, 'ticker,bought,buy_price,sold,sell_price,return_pct,profit,bars,exit,entries,entry_dates,entry_prices,entry_shares,side');
  // A leveraged long run has no short, so it has no side column.
  assert.equal(tradesCsv(run(LEVERED, { A: CALLED }).backtest.run.trades, false).split('\n')[0], 'ticker,bought,buy_price,sold,sell_price,return_pct,profit,bars,exit');
});

test('the snapshot note: a short held, the trades with their side, and the exposure of a block that borrows', () => {
  const out = run(`${FLIP}\nfill: close`, { A: bars([101, 99, 101, 98]) });
  const md = snapshotMarkdown({ name: 'Flip', source: FLIP, backtest: out.backtest, now: day(9) });
  assert.ok(md.includes(`| A | 100% | Short since ${date(3)}, sold, then sold short at the last close |`), md);
  assert.ok(md.includes('| Ticker | Side | Opened | At | Closed | At | Return | Exit |'), md);
  assert.ok(md.includes(`| A | Short | ${date(3)} | 98.00 | – | – | 0.0% | not closed |`), md);
  assert.ok(md.includes(`| A | Long | ${date(2)} | 101.00 | ${date(3)} | 98.00 | −3.0% | flipped to short |`), md);
  assert.ok(md.includes(`| A | Short | ${date(1)} | 99.00 | ${date(2)} | 101.00 | −2.0% | flipped to long |`), md);
  const { stats, run: r } = out.backtest;
  const net = r.netExposure!.reduce((s, x) => s + x, 0) / r.netExposure!.length;
  assert.ok(md.includes(`| Exposure | ${Math.round(stats.exposure * 100)}% gross, net ${Math.round(net * 100)}% | 100% |`), md);
  assert.ok(!md.includes('Time invested'));
  // A long-only block keeps its words.
  const long = snapshotMarkdown({ name: 'L', source: '', backtest: run('universe: A\nbuy when true', { A: bars([10, 11, 12]) }).backtest, now: day(9) });
  assert.ok(long.includes('| Time invested |') && long.includes('| Ticker | Bought | At | Sold | At | Return | Exit |') && !long.includes('Side'));
});

test('note properties: a short held is named as such, and invested is the gross exposure', () => {
  const short = resultProperties(run('universe: A\nshort when true', { A: bars([10, 10, 12, 15]) }).backtest, day(9));
  assert.equal(short.bt_position, 'A (short)');
  const mixed = resultProperties(run('universe: A, B\nfor A:\nbuy when true\nfor B:\nshort when true', { A: bars([10, 10, 12]), B: bars([10, 10, 12]) }).backtest, day(9));
  assert.equal(mixed.bt_position, 'A, B (short)');
  const levered = run('universe: A 150%\ncapital: 10000\nmargin rate: 0%\nbuy when true', { A: bars([100, 100, 100, 100]) }).backtest;
  // 150% of equity held from the second of four bars.
  assert.equal(levered.stats.exposure, (3 * 1.5) / 4);
  assert.equal(resultProperties(levered, day(9)).bt_invested, 113);
});

// ------------------------------------------------------------------ the dashboard

test('the dashboard names a short held, and counts longs and shorts held together', () => {
  const short = rowFrom('n.md', 'S', run('universe: A\nshort when true', { A: bars([10, 10, 12]) }), day(9));
  assert.deepEqual([short.now, short.held], ['Short A', ['A (short)']]);
  const data = { A: bars([10, 10, 12]), B: bars([10, 10, 12]), C: bars([10, 10, 12]) };
  const shorts = rowFrom('n.md', 'S', run('universe: A, B, C\nfor A:\nshort when true\nfor B:\nshort when true\nfor C:\nbuy when false', data), day(9));
  assert.equal(shorts.now, 'Short 2 of 3');
  const mixed = rowFrom('n.md', 'S', run('universe: A, B, C\nfor A:\nbuy when true\nfor B:\nshort when true\nfor C:\nbuy when true', data), day(9));
  assert.deepEqual([mixed.now, mixed.held], ['Long 2, short 1 of 3', ['A', 'B (short)', 'C']]);
});

test('the dashboard\'s next orders: sells and covers first, then buys and short sales, then adds, each timing on its own', () => {
  const order = (ticker: string, action: OrderRow['action'], when: OrderRow['when'] = 'next open', step?: OrderRow['step']): OrderRow => ({
    ticker,
    action,
    when,
    weight: 0,
    value: 0,
    lastClose: 1,
    since: null,
    ...(step ? { step } : {}),
  });
  const rows = [
    order('D', 'short'),
    order('E', 'buy', 'next open', { k: 2, n: 2 }),
    order('B', 'cover'),
    order('C', 'buy'),
    order('A', 'sell'),
    order('F', 'short', 'last close'),
    order('G', 'cover', 'last close'),
    order('H', 'short', 'next open', { k: 2, n: 3 }),
  ];
  assert.deepEqual(nextLines(rows), ['Sell A', 'Buy to cover B', 'Buy C', 'Sell short D', 'Add E, H', 'Bought to cover G at the last close', 'Sold short F at the last close']);
  // From a run: a short sale waiting, and a flip as its two orders.
  const next = (src: string, data: Record<string, Bars>) => rowFrom('n.md', 'S', run(src, data), day(9)).next;
  assert.deepEqual(next('universe: A\nshort when close < 11', { A: bars([12, 12, 10]) }), ['Sell short A']);
  assert.deepEqual(next(FLIP, { A: bars([101, 101, 99]) }), ['Sell A', 'Sell short A']);
  assert.deepEqual(next(FLIP, { A: bars([99, 99, 101]) }), ['Buy to cover A', 'Buy A']);
});
