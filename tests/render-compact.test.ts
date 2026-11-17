import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { isoDate } from '../src/dom.ts';
import { parseSpec } from '../src/dsl.ts';
import { blockStateKey, compactFacts, fillSentence } from '../src/render.ts';
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

test('a strategy with no name shows its tickers, so folded blocks can be told apart', () => {
  const data = { A: bars([10, 11, 12]), B: bars([10, 11, 12]), C: bars([10, 11, 12]), D: bars([10, 11, 12]) };
  assert.equal(compactFacts(run('universe: A\nbuy when true', data)).tickers, 'A');
  assert.equal(compactFacts(run('universe: A, B, C\nbuy when true', data)).tickers, 'A, B, C');
  assert.equal(compactFacts(run('universe: A, B, C, D\nbuy when true', data)).tickers, '4 tickers');
  assert.equal(compactFacts(run('name: Mine\nuniverse: A\nbuy when true', data)).tickers, null);
});

test('a block is keyed by its note and its name, or by its place when it has no name', () => {
  assert.equal(blockStateKey('Notes/A.md', 'Trend', 0), blockStateKey('Notes/A.md', 'Trend', 3));
  assert.equal(blockStateKey('Notes/A.md', 'Trend', 0), blockStateKey('Notes/A.md', 'trend', 1));
  assert.notEqual(blockStateKey('Notes/A.md', 'Trend', 0), blockStateKey('Notes/B.md', 'Trend', 0));
  assert.notEqual(blockStateKey('Notes/A.md', 'Trend', 0), blockStateKey('Notes/A.md', 'Mean', 0));
  assert.notEqual(blockStateKey('Notes/A.md', null, 0), blockStateKey('Notes/A.md', null, 1));
  assert.notEqual(blockStateKey('Notes/A.md', null, 0), blockStateKey('Notes/A.md', 'block:0', 0));
});

// ---- fill: close

test('the fine print says where a rule fills', () => {
  assert.equal(fillSentence(parseSpec('universe: A\nbuy when true').spec!), 'A rule seen at a close fills at the next open.');
  assert.equal(fillSentence(parseSpec('universe: A\nfill: next open\nbuy when true').spec!), 'A rule seen at a close fills at the next open.');
  assert.equal(fillSentence(parseSpec('universe: A\nfill: close\nbuy when true').spec!), 'A rule seen at a close fills at that close.');
});

test('with fill: close an order that filled at the last close is said, and nothing is waiting for the next open', () => {
  const bought = compactFacts(run('universe: A\ncapital: 1000\nfill: close\nbuy when close > 11', { A: bars([10, 10, 12]) }));
  assert.equal(bought.holding, `Long A since ${day(2)}`);
  assert.equal(bought.order, 'bought A at the last close');
  const sold = compactFacts(run('universe: A\ncapital: 1000\nfill: close\nbuy when true\nsell when close < 9', { A: bars([10, 10, 10, 8]) }));
  assert.equal(sold.holding, 'In cash');
  assert.equal(sold.order, 'sold A at the last close');
  assert.equal(compactFacts(run('universe: A\ncapital: 1000\nfill: close\nbuy when close > 100', { A: bars([10, 10, 12]) })).order, null);
  // Without fill: close the same bars leave an order waiting for the next open.
  assert.equal(compactFacts(run('universe: A\ncapital: 1000\nbuy when close > 11', { A: bars([10, 10, 12]) })).order, 'buys A at the next open');
});

test('with fill: close several tickers share one sentence, and a sell and a buy of one ranking are both said', () => {
  const data = { A: bars([10, 10, 12]), B: bars([10, 10, 12]), C: bars([10, 10, 12]), D: bars([10, 10, 12]) };
  assert.equal(compactFacts(run('universe: A, B\nfill: close\nbuy when close > 11', data)).order, 'bought A and B at the last close');
  assert.equal(compactFacts(run('universe: A, B, C, D\nfill: close\nbuy when close > 11', data)).order, 'bought 4 tickers at the last close');
  const swap = compactFacts(run('universe: A, Z\ncapital: 1000\nfill: close\nbuy when close > 9\nsell when close < 9', { A: bars([8, 8, 8, 10]), Z: bars([10, 10, 10, 8]) }));
  assert.equal(swap.order, 'bought A and sold Z at the last close');
});

test('with fill: close an order still waiting, from a ranking made on a day a ticker has no bar, is for the next close', () => {
  const days = (from: number, to: number, weekdays: boolean) => {
    const out: number[] = [];
    for (let t = from; t <= to; t += DAY) if (!weekdays || ![0, 6].includes(new Date(t).getUTCDay())) out.push(t);
    return out;
  };
  const [from, to] = [Date.UTC(2020, 0, 27), Date.UTC(2020, 1, 29)];
  const cryT = days(from, to, false);
  const stkT = days(from, to, true);
  const STK = bars(stkT.map(() => 100), { times: stkT });
  const CRY = bars(cryT.map((t) => (t < to ? 50 : 150)), { times: cryT });
  const facts = compactFacts(run('universe: STK, CRY\ncapital: 1000\nfill: close\nrebalance: monthly\nhold: top 1 by close', { STK, CRY }));
  assert.equal(facts.order, 'buys CRY and sells STK at the next close');
});
