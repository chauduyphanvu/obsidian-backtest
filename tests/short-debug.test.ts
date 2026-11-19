// "Rule values, bar by bar" for a strategy that shorts, flips or borrows: the short and cover columns, each read with its own
// side's position, the position words, what happened at each bar, and the file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { debugColumns, debugCsv, debugRange, debugRows, interesting, positionWords, prepareRows, type DebugRow } from '../src/debug.ts';
import { parseSpec } from '../src/dsl.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY, T0 } from './helpers.ts';

function run(src: string, data: Record<string, Bars>): Backtest {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  return runBacktest(spec!, new Map(Object.entries(data)));
}
const rowsOf = (bt: Backtest, asset = 'A'): DebugRow[] => debugRows(bt, asset, 0, debugRange(bt, asset).count);
const day = (n: number) => T0 + n * DAY;
function ohlc(rows: number[][]): Bars {
  return { t: rows.map((_, n) => day(n)), o: rows.map((r) => r[0]), h: rows.map((r) => r[1]), l: rows.map((r) => r[2]), c: rows.map((r) => r[3]), v: rows.map(() => 1000) };
}
const kinds = (row: DebugRow) => row.events.map((e) => e.k);
const FLIP = 'universe: A\ncapital: 10000\nborrow fee: 0%\nbuy when close > 100\nshort when close < 100';
const LEVERED = 'universe: A 200%\ncapital: 10000\nmargin rate: 0%\nbuy when true';

test('a short and its cover: their columns, the position as a short, what happened, and the file', () => {
  const bt = run('universe: A\ncapital: 10000\nborrow fee: 0.5%\nshort when close >= 100\ncover when close < 85', { A: bars([100, 90, 80, 80]) });
  assert.deepEqual(
    debugColumns(bt, 'A').map((c) => [c.group, c.caption, c.heading]),
    [['short', 'Short', 'close >= 100'], ['cover', 'Cover', 'close < 85']],
  );
  const rows = rowsOf(bt);
  assert.deepEqual(rows.map((r) => [r.short, r.cover, r.side, r.readSide]), [
    ['yes', 'no', null, null],
    ['no', 'no', 'short', 'short'],
    ['no', 'yes', 'short', 'short'],
    ['no', 'yes', null, null],
  ]);
  assert.deepEqual(rows.map(positionWords), ['Flat', 'Short, 100 shares', 'Short, 100 shares', 'Flat']);
  assert.deepEqual(rows.map((r) => r.what), [
    'Short rule held: sold short at the next open (2020-01-02) at 100.00.',
    'Sold short at the open at 100.00.',
    'Cover rule held: bought to cover at the next open (2020-01-04) at 80.00.',
    'Bought to cover at the open at 80.00.',
  ]);
  assert.deepEqual(rows.map(kinds), [['short'], ['short'], ['cover'], ['cover']]);
  assert.deepEqual(debugCsv(bt, 'A').trim().split('\n'), [
    'date,close,short: close >= 100 (left),short: close >= 100 (right),short: close >= 100 (result),cover: close < 85 (left),cover: close < 85 (right),cover: close < 85 (result),position,shares,what happened',
    '2020-01-01,100,100,100,yes,100,85,no,flat,,Short rule held: sold short at the next open (2020-01-02) at 100.00.',
    '2020-01-02,90,90,100,no,90,85,no,short,100,Sold short at the open at 100.00.',
    '2020-01-03,80,80,100,no,80,85,yes,short,100,Cover rule held: bought to cover at the next open (2020-01-04) at 80.00.',
    '2020-01-04,80,80,100,no,80,85,yes,flat,,Bought to cover at the open at 80.00.',
  ]);
});

test('a cover rule reads the short\'s position, and a sell rule the long\'s: each is not read while the other side is held', () => {
  const src = 'universe: A\nbuy when close > 100\nsell when bars held >= 3\nshort when close < 100\ncover when bars held >= 2';
  const bt = run(src, { A: bars([101, 101, 101, 99, 99, 99, 99]) });
  const cols = debugColumns(bt, 'A');
  const sell = cols.findIndex((c) => c.group === 'sell');
  const cover = cols.findIndex((c) => c.group === 'cover');
  const rows = rowsOf(bt);
  // Long from day 1 to the flip at day 4's open, short from there; the cover rule holds at the last close.
  assert.deepEqual(rows.map((r) => r.readSide), [null, 'long', 'long', 'long', 'short', 'short', 'short']);
  assert.deepEqual(rows.map((r) => r.cells[sell].outcome), [null, 'no', 'no', 'no', null, null, null]);
  assert.deepEqual(rows.map((r) => r.cells[cover].outcome), [null, null, null, null, 'no', 'no', 'yes']);
  // The whole rules as the run reads them: with no position of its side, bars held is unknown.
  assert.deepEqual(rows.map((r) => r.sell), ['unknown', 'no', 'no', 'no', 'unknown', 'unknown', 'unknown']);
  assert.deepEqual(rows.map((r) => r.cover), ['unknown', 'unknown', 'unknown', 'unknown', 'no', 'no', 'yes']);
  assert.equal(rows.at(-1)!.what, 'An order to buy to cover waits for the next open.');
});

test('a flip is one event: the other side\'s rule closed the position and opened the other side at the same fill', () => {
  const bt = run(FLIP, { A: ohlc([[101, 101, 101, 101], [101, 102, 100, 102], [102, 102, 99, 99], [98, 98, 97, 97], [97, 97, 97, 97]]) });
  const rows = rowsOf(bt);
  assert.deepEqual(rows.map(kinds), [['buy'], ['buy'], ['flip'], ['flip'], ['short-held']]);
  assert.deepEqual(rows.map((r) => r.what), [
    'Buy rule held: bought at the next open (2020-01-02) at 101.00.',
    'Bought at the open at 101.00.',
    'Short rule held: flipped to short, sold and sold short at the next open (2020-01-04) at 98.00.',
    'Flipped to short: sold and sold short at the open at 98.00.',
    'Short rule held, but a short position was open.',
  ]);
  assert.deepEqual(rows.map(positionWords), ['Flat', 'Long, 99.0099 shares', 'Long, 99.0099 shares', 'Short, 99.0099 shares', 'Short, 99.0099 shares']);
  // With fill: close the decision and both fills are one bar, and the way back is a cover and a buy.
  const close = rowsOf(run(`${FLIP}\nfill: close`, { A: bars([99, 101, 102]) }));
  assert.deepEqual(close.map((r) => r.what), [
    'Short rule held: sold short at this close at 99.00.',
    'Buy rule held: flipped to long, bought to cover and bought at this close at 101.00.',
    'Buy rule held, but a long position was open.',
  ]);
});

test('an order from the last bar says a short sale, a cover, or a flip as its two orders', () => {
  const pending = (src: string, data: Record<string, Bars>) => rowsOf(run(src, data)).at(-1)!.what;
  assert.equal(pending('universe: A\nshort when close < 11', { A: bars([12, 12, 10]) }), 'An order to sell short waits for the next open.');
  assert.equal(pending('universe: A\nshort when true\ncover when close < 9', { A: bars([10, 10, 10, 8]) }), 'An order to buy to cover waits for the next open.');
  assert.equal(pending(FLIP, { A: bars([101, 101, 99]) }), 'An order to sell and sell short waits for the next open.');
  assert.equal(pending(FLIP, { A: bars([99, 99, 101]) }), 'An order to buy to cover and buy waits for the next open.');
});

test('a short\'s stop, target and trailing stop name the cover, and the short rule then has to stop holding', () => {
  const src = 'universe: A\ncapital: 10000\nborrow fee: 0%\ntake profit: 10%\nshort when close < 100';
  const rows = rowsOf(run(src, { A: ohlc([[100, 100, 99, 99], [98, 99, 97, 98], [95, 96, 85, 90], [90, 90, 90, 90], [101, 101, 101, 101], [99, 99, 99, 99]]) }));
  assert.deepEqual(rows.map((r) => r.what), [
    'Short rule held: sold short at the next open (2020-01-02) at 98.00.',
    'Sold short at the open at 98.00.',
    'Take profit hit: bought to cover at 88.20. Short rule held, but after this take profit, the rule must become false first.',
    'Short rule held, but after the take profit on 2020-01-03, the rule must become false first.',
    '',
    'An order to sell short waits for the next open.',
  ]);
  const trail = rowsOf(run('universe: A\ncapital: 10000\nborrow fee: 0%\ntrailing stop: 5%\nshort when close < 100', { A: ohlc([[100, 100, 99, 99], [98, 99, 97, 98], [97, 97, 93, 94], [95, 99, 94, 98]]) }));
  assert.equal(trail[3].what, 'Trailing stop hit: bought to cover at 97.65. Short rule held, but after this trailing stop, the rule must become false first.');
  // The waiting is the same wherever the window starts.
  const bt = run(src, { A: ohlc([[100, 100, 99, 99], [98, 99, 97, 98], [95, 96, 85, 90], [90, 90, 90, 90], [91, 91, 91, 91], [101, 101, 101, 101], [99, 99, 99, 99]]) });
  const all = rowsOf(bt);
  for (let from = 0; from < all.length; from++) assert.deepEqual(debugRows(bt, 'A', from, all.length), all.slice(from), `from ${from}`);
});

test('the buy and short rules both holding while flat is said, and so is a short rule held back by the cover rule', () => {
  const both = rowsOf(run('universe: A\nbuy when true\nshort when true', { A: bars([10, 10, 10]) }));
  assert.deepEqual(both.map((r) => r.what), Array(3).fill('The buy and short rules held together. Thus no position opened.'));
  const vetoed = rowsOf(run('universe: A\nshort when true\ncover when true', { A: bars([10, 10, 10]) }));
  assert.deepEqual(vetoed.map((r) => r.what), Array(3).fill('Short rule held, but the cover rule also held. Thus no short sale.'));
});

test('a margin call: decided at a close, filled at the next open even with fill: close, then both sides wait to re-arm', () => {
  const A = ohlc([[100, 100, 100, 100], [100, 100, 70, 70], [70, 70, 66, 66], [65, 65, 60, 60], [60, 70, 60, 70]]);
  for (const fill of ['', 'fill: close\n']) {
    const bt = run(fill + LEVERED, { A });
    const rows = rowsOf(bt);
    assert.equal(rows[2].what, "Margin call (equity below 25% of the value of the positions): sold at the next open (2020-01-04) at 65.00.");
    assert.equal(rows[3].what, 'Margin call: sold at the open at 65.00. Buy rule held, but after this margin call, the rule must become false first.');
    assert.equal(rows[4].what, 'Buy rule held, but after the margin call on 2020-01-04, the rule must become false first.');
    // A window that starts after the call knows the rule is still waiting.
    for (let from = 0; from < rows.length; from++) assert.deepEqual(debugRows(bt, 'A', from, rows.length), rows.slice(from), `${fill}from ${from}`);
  }
});

test('a margin call made at the last close is an order pending for the next open, whatever the fill', () => {
  for (const fill of ['', 'fill: close\n']) {
    const rows = rowsOf(run(fill + LEVERED, { A: ohlc([[100, 100, 100, 100], [100, 100, 70, 70], [70, 70, 66, 66]]) }));
    assert.ok(rows.at(-1)!.what.endsWith('Margin call (equity below 25% of the value of the positions): an order to sell waits for the next open.'), rows.at(-1)!.what);
  }
});

test('a ruin closes everything, and nothing more is traded after it', () => {
  const bt = run(LEVERED, { A: ohlc([[100, 100, 100, 100], [100, 100, 70, 70], [70, 70, 66, 66], [45, 65, 45, 60], [60, 80, 60, 80], [80, 90, 80, 90]]) });
  const rows = rowsOf(bt);
  assert.deepEqual(rows.slice(3).map((r) => r.what), [
    'The equity decreased to zero. Thus all positions closed and the run stopped: sold at 45.00.',
    'No trades occurred after the ruin on 2020-01-04.',
    'No trades occurred after the ruin on 2020-01-04.',
  ]);
  const short = rowsOf(run('universe: A\ncapital: 10000\nmargin rate: 0%\nborrow fee: 0%\nshort when true', { A: ohlc([[100, 100, 100, 100], [100, 100, 100, 100], [150, 150, 150, 150], [210, 210, 210, 210], [210, 210, 210, 210]]) }));
  assert.equal(short[3].what, 'The equity decreased to zero. Thus all positions closed and the run stopped: bought to cover at 210.00.');
});

test('a short built in entries: the entries and the shares sold short, resized by rebalancing', () => {
  const src = 'universe: A\ncapital: 10000\nborrow fee: 1%\nentries: 2\nstop loss: 10%\nshort when close < 100\nadd when close < last entry price\ncover when close > 120';
  const rows = rowsOf(run(src, { A: ohlc([[100, 100, 99, 99], [98, 99, 97, 98], [97, 97, 95, 95], [95, 95, 94, 94], [94, 94, 94, 94]]) }));
  assert.equal(rows[3].what, 'Added entry 2 of 2 at the open at 95.00. Average entry price changed to 96.47, stop loss moved to 106.11. Short rule held, but a short position was open.');
  assert.equal(positionWords(rows[4]), 'Short, 2 of 2 entries, 104.4562 shares');
  const resized = rowsOf(run('universe: A 50%\nrebalance: weekly\nshort when true', { A: bars(Array.from({ length: 20 }, (_, i) => 100 + i)) }));
  assert.match(positionWords(resized.at(-1)!), /^Short, sold [\d.]+ shares short$/);
});

test('the parts of the short and cover rules are worked out ahead with the others, and a short held or wanted is worth showing', () => {
  const total = (src: string) => {
    const bt = run(src, { A: bars([10, 11, 12, 11, 10]) });
    let last = 0;
    for (const p of prepareRows(bt, 'A')) last = p.total;
    return last;
  };
  const both = total('universe: A\nshort when close < sma(3)\ncover when close > sma(5)');
  const short = total('universe: A\nshort when close < sma(3)');
  assert.ok(both > short && short > total('universe: A\nshort when true'), `${both}, ${short}`);
  // The same parts as a buy and a sell rule, and the parser's false buy rule.
  assert.equal(both, total('universe: A\nbuy when close < sma(3)\nsell when close > sma(5)') + 1);
  const rows = rowsOf(run('universe: A\nshort when close < 11', { A: bars([12, 12, 10, 10]) }));
  assert.deepEqual(rows.map(interesting), [false, false, true, true]);
});

// ------------------------------------------------------------------ the table agrees with the trade list

function walk(n: number, seed: number, drift: number): Bars {
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let p = 50 + rnd() * 50;
  for (let d = T0; out.t.length < n; d += DAY) {
    const o = p * (1 + (rnd() < 0.08 ? (rnd() - 0.5) * 0.12 : (rnd() - 0.5) * 0.01));
    const c = o * (1 + drift + (rnd() - 0.5) * 0.05);
    out.t.push(d);
    out.o.push(o);
    out.c.push(c);
    out.h.push(Math.max(o, c) * (1 + rnd() * 0.02));
    out.l.push(Math.min(o, c) * (1 - rnd() * 0.02));
    out.v.push(1000);
    p = c;
  }
  return out;
}

const AGREE = [
  'universe: A, B\ntrailing stop: 2 atr(10)\nborrow fee: 1%\nbuy when close > sma(10)\nshort when close < sma(10)',
  'universe: A\nslippage: 3 bps\nstop loss: 4%\ntake profit: 7%\nshort when sma(5) crosses below sma(20)\ncover when sma(5) crosses above sma(20)',
  'universe: A 100%, B 50%\nmargin rate: 8%\nrebalance: weekly\nfor A:\nbuy when close > sma(15)\nsell when close < sma(15)\nfor B:\nshort when close < sma(15)\ncover when close > sma(15) or bars held >= 12',
  'universe: A\nentries: 3\nstop loss: 8%\nshort when roc(5) < -2%\nadd when entries made < 3 and close > last entry price\ncover when close < entry price * 0.95 or bars held >= 10',
];

test('over shorts, flips and leverage, each bar\'s position and every entry and exit the table names agree with the trade list', () => {
  const data = { A: walk(300, 7, -0.0004), B: walk(300, 11, 0.0003) };
  const seen = new Set<string>();
  for (const src of AGREE) {
    for (const fill of ['', 'fill: close\n']) {
      const bt = run(fill + src, data);
      for (const asset of ['A', 'B'].filter((a) => bt.spec.rules[a])) {
        const trades = bt.run.trades.filter((t) => t.asset === asset);
        const rows = rowsOf(bt, asset);
        const where = (r: DebugRow) => `${fill + src}\n${asset} ${new Date(r.t).toISOString().slice(0, 10)}: ${r.what}`;
        const opened = new Set<unknown>();
        const closed = new Set<unknown>();
        for (const r of rows) {
          const on = trades.find((t) => t.entryT <= r.t && (t.reason === 'open' || r.t < t.exitT)) ?? null;
          assert.equal(r.side, on ? (on.side ?? 'long') : null, where(r));
          assert.ok(!kinds(r).includes('no-cash'), where(r));
          for (const e of r.events) {
            seen.add(e.k);
            const entry = e.k === 'buy' || e.k === 'short' ? e.trade : e.k === 'flip' ? e.to : null;
            const exit = e.k === 'sell' || e.k === 'cover' ? e.trade : e.k === 'flip' ? e.from : null;
            const filled = 'stage' in e && e.stage !== 'decided';
            if (entry) assert.equal(entry.side === 'short', e.k === 'short' || (e.k === 'flip' && e.to.side === 'short'), where(r));
            if (entry && filled) {
              assert.equal(entry.entryT, r.t, where(r));
              opened.add(entry);
            }
            if (exit && filled) {
              assert.equal(exit.exitT, r.t, where(r));
              closed.add(exit);
            }
          }
        }
        // Every trade's entry and exit is named at the bar it filled.
        for (const t of trades) {
          assert.ok(opened.has(t), `${fill + src}\n${asset}: no entry named for the trade of ${new Date(t.entryT).toISOString()}`);
          if (t.reason !== 'open') assert.ok(closed.has(t), `${fill + src}\n${asset}: no exit named for the trade closed ${new Date(t.exitT).toISOString()}`);
        }
      }
    }
  }
  for (const k of ['buy', 'sell', 'short', 'cover', 'flip', 'short-held', 'rearm', 'add']) assert.ok(seen.has(k), `no event ${k}: ${[...seen]}`);
});
