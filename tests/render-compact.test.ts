import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { isoDate } from '../src/format.ts';
import { blockStateKey, compactFacts, fillSentence, summary } from '../src/render.ts';
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
  assert.equal(fillSentence(parseSpec('universe: A\nbuy when true').spec!), 'An order fills at the next open after its rule is true.');
  assert.equal(fillSentence(parseSpec('universe: A\nfill: next open\nbuy when true').spec!), 'An order fills at the next open after its rule is true.');
  assert.equal(fillSentence(parseSpec('universe: A\nfill: close\nbuy when true').spec!), 'An order fills at the close where its rule is true.');
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

// ---- the line under the title

const summaryOf = (src: string, overrides: Record<string, number> = {}) => {
  const { spec, errors } = parseSpec(src, { overrides });
  assert.deepEqual(errors, [], src);
  return summary(spec!, src);
};

test('a stop that is a parameter is said once, as a stop, and a percentage is written as the block writes it', () => {
  const src = 'universe: SPY\ncosts: 5 bps\nfast = 50\nslow = 200\nstop = 12%\nbuy when sma(fast) > sma(slow)\nstop loss: stop';
  assert.equal(summaryOf(src), 'SPY, 5 bps costs, 12% stop, fast 50, slow 200');
  assert.equal(summaryOf(src, { stop: 0.125 }), 'SPY, 5 bps costs, 12.5% stop, fast 50, slow 200');
});

test('a stop written as a number is not rounded to a whole percent', () => {
  assert.equal(summaryOf('universe: SPY\nbuy when close > sma(50)\nstop loss: 12.5%'), 'SPY, no costs, 12.5% stop');
  assert.equal(summaryOf('universe: SPY\nbuy when close > sma(50)\nstop loss: 10%\ntrailing stop: 15%\ntake profit: 2 atr(14)'), 'SPY, no costs, 10% stop, 15% trailing stop, 2 ATR target');
});

test('a percentage parameter that is not a stop is listed without a needless decimal', () => {
  const src = 'universe: SPY\nband = 3%\nbuy when roc(10) > band';
  assert.equal(summaryOf(src), 'SPY, no costs, band 3%');
  assert.equal(summaryOf('universe: SPY\nband = 2.5%\nbuy when roc(10) > band'), 'SPY, no costs, band 2.5%');
  assert.equal(summaryOf('universe: SPY\nx = 0.1\nbuy when close > x'), 'SPY, no costs, x 0.1');
});

test('a parameter that is a stop is kept in the list when the stops are not spelt out', () => {
  const src = 'universe: SPY, TLT\nstop = 12%\nbuy when close > sma(50)\nstop loss: stop\nfor TLT:\n  stop loss: 5%';
  assert.match(summaryOf(src), /stops per ticker, stop 12%$/);
});

test('a stop that names a parameter in a comment or another setting is not taken for a stop parameter', () => {
  const src = 'universe: SPY\nstop = 12%\nbuy when roc(10) > stop # stop loss: stop\nstop loss: 5%';
  assert.equal(summaryOf(src), 'SPY, no costs, 5% stop, stop 12%');
});

test('a parameter used as the period of a stop is still listed', () => {
  assert.equal(summaryOf('universe: SPY\nn = 14\nbuy when close > sma(50)\nstop loss: 2 atr(n)'), 'SPY, no costs, 2 ATR stop, n 14');
});
