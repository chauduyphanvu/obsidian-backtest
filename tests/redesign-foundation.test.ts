// The shared pieces of the redesign: short problem messages with a suggestion and a fix to apply, and the downsampled
// series a sparkline draws.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { applyFix, fixWord, shortMessage, suggestion } from '../src/fixes.ts';
import { sparkSeries } from '../src/render-chart.ts';
import { bars } from './helpers.ts';

test('an unknown name is cut to the sentence that names it, the list kept apart', () => {
  const { errors } = parseSpec('universe: SPY\nbuy when close > sam(200)');
  const { head, rest } = shortMessage(errors[0].message);
  assert.equal(head, 'Unknown name "sam".');
  assert.match(rest, /^Series: open, high, low, close/);
  assert.equal(`${head} ${rest}`, errors[0].message);
  assert.deepEqual(shortMessage(`Line 2: ${errors[0].message}`).head, 'Line 2: Unknown name "sam".');
  assert.deepEqual(shortMessage('Unknown setting "fro".'), { head: 'Unknown setting "fro".', rest: '' });
});

test('a suggestion names the word and what a function does, and its fix makes the block run', () => {
  const lines = ['universe: SPY', 'buy when close > smaa(200)', 'sell when close < sma(200)'];
  const d = parseSpec(lines.join('\n')).errors[0];
  const found = suggestion(lines, d);
  assert.ok(found);
  assert.equal(found.fix.label, 'Change to sma');
  assert.equal(fixWord(found.fix), 'sma');
  assert.equal(found.text, 'Did you mean sma, the simple average of the last n closes?');
  const fixed = applyFix(lines, found.fix);
  assert.equal(fixed[1], 'buy when close > sma(200)');
  assert.deepEqual(parseSpec(fixed.join('\n')).errors, []);
});

test('a habit keeps its own sentence, and a word that is not a function is offered alone', () => {
  const habit = ['universe: SPY', 'buy when close > sma(20) && close > sma(50)'];
  const h = suggestion(habit, parseSpec(habit.join('\n')).errors[0]);
  assert.equal(h?.text, 'Write and, not &&.');
  const setting = ['universe: SPY', 'rebalanse: monthly', 'buy when close > sma(20)'];
  const s = suggestion(setting, parseSpec(setting.join('\n')).errors[0]);
  assert.equal(s?.text, 'Did you mean rebalance?');
});

test('a sparkline keeps the first and the last bar and at most about n points', () => {
  const closes = Array.from({ length: 1000 }, (_, i) => 100 + i / 10);
  const { spec } = parseSpec('universe: A\nbuy when close > sma(20)\nsell when close < sma(20)');
  const data = new Map([['A', bars(closes)]]);
  const bt = runBacktest(spec!, data);
  const series = sparkSeries(bt, 120);
  assert.ok(series.benchmark.length <= 121 && series.benchmark.length >= 100);
  assert.equal(series.strategy.length, series.benchmark.length);
  assert.equal(series.benchmark[0], bt.benchmark.equity[0]);
  assert.equal(series.benchmark.at(-1), bt.benchmark.equity.at(-1));
  assert.equal(series.strategy.at(-1), bt.run.equity.at(-1));
});
