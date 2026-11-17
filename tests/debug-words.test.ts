import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { price } from '../src/dom.ts';
import { parseSpec } from '../src/dsl.ts';
import { cellText, debugColumns, debugRange, debugRows, positionWords, type DebugRow } from '../src/debug.ts';
import { makeRng } from '../src/rng.ts';
import type { Bars } from '../src/types.ts';
import { bars } from './helpers.ts';

function run(src: string, data: Record<string, Bars>): Backtest {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  return runBacktest(spec!, new Map(Object.entries(data)));
}
const rowsOf = (bt: Backtest, asset = 'A'): DebugRow[] => debugRows(bt, asset, 0, debugRange(bt, asset).count);

/** The detail line under each column of the row at `i`. */
function details(bt: Backtest, i: number, asset = 'A'): Record<string, string> {
  const row = rowsOf(bt, asset)[i];
  return Object.fromEntries(debugColumns(bt, asset).map((c, n) => [c.text, cellText(c, row.cells[n]).detail]));
}

const wave = (n: number) => Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 9) * 5);

test('a bars_since whose condition has never held says so', () => {
  const bt = run('universe: A\nbuy when bars_since(close > 1000) < 5\nsell when close < 0', { A: bars(wave(120)) });
  assert.equal(details(bt, 100)['bars_since(close > 1000) < 5'], 'the condition has not held yet');
  // It never held before the first bar either, so the early bars say the same.
  assert.equal(details(bt, 0)['bars_since(close > 1000) < 5'], 'the condition has not held yet');
});

test('a bars_since that held, then met a bar where its condition was unknown, is unknown with no reason given', () => {
  // The score is above 0, then missing for a bar, then not above 0: nothing counts from before the gap.
  const d = bars(wave(60));
  d.columns = [{ name: 'score', header: 'score', v: d.t.map((_, i) => (i === 20 ? NaN : i < 20 ? 1 : 0)) }];
  const bt = run('universe: csv:Data/A.csv\nbuy when bars_since(column(score) > 0) < 5\nsell when close < 0', { A: d });
  const [col] = debugColumns(bt, 'A');
  const rows = rowsOf(bt);
  assert.equal(rows[10].cells[0].outcome, 'yes');
  assert.equal(rows[40].cells[0].outcome, 'unknown');
  assert.equal(cellText(col, rows[40].cells[0]).detail, '');
  // The gap itself is the score missing.
  assert.equal(rows[20].cells[0].note, 'the file has no number in that row');
});

test('a window with the same value all through says so, for zscore and for correl', () => {
  const flat = bars(Array.from({ length: 80 }, () => 100));
  const moving = bars(wave(80));
  const z = run('universe: A\nbuy when zscore(close, 20) > 1\nsell when close < 0', { A: flat });
  assert.equal(details(z, 60)['zscore(close, 20) > 1'], 'every value in the window is the same');
  // Before a full window there is nothing to compare yet.
  assert.equal(details(z, 5)['zscore(close, 20) > 1'], 'still warming up');
  // A moving series has a z-score everywhere it is known.
  const m = run('universe: A\nbuy when zscore(close, 20) > 1\nsell when close < 0', { A: moving });
  assert.equal(rowsOf(m)[60].cells[0].outcome === 'unknown', false);

  const c = run('universe: A, B\nbuy when correl(close of B, 20) > 0\nsell when close < 0', { A: moving, B: flat });
  assert.equal(details(c, 60)['correl(close of B, 20) > 0'], 'one of the two series changed by the same amount on every bar in the window');
  assert.equal(details(c, 5)['correl(close of B, 20) > 0'], 'still warming up');
  // The other way round: this ticker is the flat one.
  const d = run('universe: A, B\nbuy when correl(close of B, 20) > 0\nsell when close < 0', { A: flat, B: moving });
  assert.equal(details(d, 60)['correl(close of B, 20) > 0'], 'one of the two series changed by the same amount on every bar in the window');
});

/** A run where an add fills at the open and the position then exits inside the same bar. */
function addThenExit(): { bt: Backtest; row: DebugRow } {
  const src = 'universe: A\ncapital: 10000\nentries: 2\nstop loss: 1%\nbuy when close > sma(5)\nadd when close > last entry price * 1.003\nsell when close < sma(5) * 0.9';
  for (let seed = 1; seed < 400; seed++) {
    const rng = makeRng(seed);
    const closes: number[] = [];
    let c = 100;
    for (let i = 0; i < 160; i++) closes.push((c *= 1 + (rng.next() - 0.47) * 0.03));
    // Wide bars, so a stop is reached in the bar an add fills at the open.
    const lows = closes.map((x, i) => Math.min(x, i ? closes[i - 1] : x) * (1 - rng.next() * 0.025));
    const bt = run(src, { A: bars(closes, { lows }) });
    const row = rowsOf(bt).find((r) => r.events.some((e) => e.k === 'add' && e.stage !== 'decided') && r.events.some((e) => e.k === 'sell' && e.stage !== 'decided'));
    if (row) return { bt, row };
  }
  throw new Error('no run had an add and an exit in one bar');
}

test('events are listed in the order they happened: an add at the open comes before an exit inside the same bar', () => {
  const { bt, row } = addThenExit();
  const kinds = row.events.map((e) => e.k);
  assert.ok(kinds.indexOf('add') < kinds.indexOf('sell'), kinds.join());
  const add = row.what.indexOf('Added entry');
  const exit = row.what.search(/Stopped out|Trailing stop|Take profit/);
  assert.ok(add >= 0 && exit > add, row.what);
  // The position at the end of the bar is flat, which the order now explains.
  assert.equal(positionWords(row), 'Flat');
  const trade = bt.run.trades.find((t) => t.exitT === row.t)!;
  assert.ok(row.what.includes(price(trade.exitPrice)));
});

test('what happens at the open comes first, then what happens inside the bar, then what the close decided', () => {
  // A bar can fill the order decided at the last close, hit a stop, and decide a new order at its own close.
  let seen = 0;
  for (let seed = 1; seed < 150; seed++) {
    const rng = makeRng(seed);
    let c = 100;
    const closes = Array.from({ length: 200 }, () => (c *= 1 + (rng.next() - 0.5) * 0.04));
    const lows = closes.map((x, i) => Math.min(x, i ? closes[i - 1] : x) * (1 - rng.next() * 0.02));
    const bt = run('universe: A\ncapital: 10000\nentries: 3\nstop loss: 1.5%\nbuy when close > sma(4)\nadd when close > last entry price * 1.002\nsell when close < sma(4) * 0.99', { A: bars(closes, { lows }) });
    const phase = (e: DebugRow['events'][number]): number => {
      if (e.k === 'buy' || e.k === 'add') return e.stage === 'filled' ? 0 : 2;
      if (e.k === 'sell') return e.stage === 'filled' ? (e.trade.reason === 'signal' ? 0 : 1) : 2;
      return 3;
    };
    for (const r of rowsOf(bt)) {
      const phases = r.events.map(phase);
      assert.deepEqual(phases, [...phases].sort((a, b) => a - b), `${seed} ${r.t}: ${r.events.map((e) => e.k).join()}`);
      if (new Set(phases).size > 1) seen++;
    }
  }
  assert.ok(seen > 5, `only ${seen} bars with events at different times`);
});
