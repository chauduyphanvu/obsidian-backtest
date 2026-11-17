import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { isoDate } from '../src/dom.ts';
import { parseSpec } from '../src/dsl.ts';
import { blockStateKey, compactFacts } from '../src/render.ts';
import type { RunOutput } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY, T0 } from './helpers.ts';

function run(src: string, data: Record<string, Bars>): RunOutput {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  const map = new Map(Object.entries(data));
  return { spec: spec!, backtest: runBacktest(spec!, map), data: map, warnings: [], prices: [] };
}
const day = (n: number) => isoDate(T0 + n * DAY);

test('a held ticker is named with the day it was bought', () => {
  const facts = compactFacts(run('universe: A\nbuy when true', { A: bars([10, 10, 12, 15]) }));
  assert.equal(facts.holding, `Long A since ${day(1)}`);
  assert.equal(facts.order, null);
});

test('a strategy with nothing held is in cash', () => {
  const facts = compactFacts(run('universe: A\nbuy when close > 100', { A: bars([10, 10, 12, 15]) }));
  assert.equal(facts.holding, 'In cash');
  assert.equal(facts.order, null);
});

test('the figures are the return per year and the worst drawdown', () => {
  const out = run('universe: A\nbuy when true', { A: bars([10, 10, 12, 9, 15]) });
  const { cagr, maxDrawdown } = out.backtest.stats;
  const facts = compactFacts(out);
  assert.equal(facts.figures.length, 2);
  assert.match(facts.figures[0], /^[+\u2212]?\d+(\.\d)?% a year$/);
  assert.match(facts.figures[1], /^worst drawdown \u2212\d+\.\d%$/);
  assert.ok(cagr > 0 && maxDrawdown < 0);
  assert.ok(facts.figures[0].startsWith('+'));
});

test('a buy waiting for the next open is said', () => {
  const facts = compactFacts(run('universe: A\nbuy when close > 11', { A: bars([10, 10, 12]) }));
  assert.equal(facts.holding, 'In cash');
  assert.equal(facts.order, 'buys A at the next open');
});

test('a sell waiting for the next open is said', () => {
  const facts = compactFacts(run('universe: A\nbuy when true\nsell when close < 9', { A: bars([10, 10, 10, 8]) }));
  assert.equal(facts.order, 'sells A at the next open');
});

test('several tickers: how many are held, and which orders are due', () => {
  const data = { A: bars([10, 10, 12, 15]), B: bars([10, 10, 9, 8]), C: bars([10, 11, 12, 13]) };
  const held = compactFacts(run('universe: A, B, C\nbuy when close > 9.5 of A', data));
  assert.equal(held.holding, 'Holds 3 of 3');
  const some = compactFacts(run('universe: A, B, C\nbuy when close > 11', data));
  assert.equal(some.holding, 'Holds 2 of 3');
});

test('one holding among several is named, two or more are counted', () => {
  const data = { A: bars([10, 10, 12, 15]), B: bars([10, 10, 9, 8]), C: bars([10, 10, 12, 13]) };
  const one = compactFacts(run('universe: A, B, C\nfor A:\nbuy when true\nfor B:\nbuy when false\nfor C:\nbuy when false', data));
  assert.equal(one.holding, `Long A since ${day(1)}`);
  const two = compactFacts(run('universe: A, B, C\nfor A:\nbuy when true\nfor B:\nbuy when false\nfor C:\nbuy when true', data));
  assert.equal(two.holding, 'Holds 2 of 3');
});

test('orders for several tickers share one sentence, and a long list is counted', () => {
  const data = { A: bars([10, 10, 12]), B: bars([10, 10, 12]), C: bars([10, 10, 12]), D: bars([10, 10, 12]) };
  assert.equal(compactFacts(run('universe: A, B\nbuy when close > 11', data)).order, 'buys A and B at the next open');
  assert.equal(compactFacts(run('universe: A, B, C, D\nbuy when close > 11', data)).order, 'buys 4 tickers at the next open');
});

test('a block is keyed by its note and its name, or by its place when it has no name', () => {
  assert.equal(blockStateKey('Notes/A.md', 'Trend', 0), blockStateKey('Notes/A.md', 'Trend', 3));
  assert.equal(blockStateKey('Notes/A.md', 'Trend', 0), blockStateKey('Notes/A.md', 'trend', 1));
  assert.notEqual(blockStateKey('Notes/A.md', 'Trend', 0), blockStateKey('Notes/B.md', 'Trend', 0));
  assert.notEqual(blockStateKey('Notes/A.md', 'Trend', 0), blockStateKey('Notes/A.md', 'Mean', 0));
  assert.notEqual(blockStateKey('Notes/A.md', null, 0), blockStateKey('Notes/A.md', null, 1));
  assert.notEqual(blockStateKey('Notes/A.md', null, 0), blockStateKey('Notes/A.md', 'block:0', 0));
});
