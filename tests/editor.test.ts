import assert from 'node:assert/strict';
import { test } from 'node:test';
import { complete, tickers } from '../src/complete.ts';
import { tokenizeBlock } from '../src/highlight.ts';

const BLOCK = `name: Three sleeves
universe: SPY 50%, binance:BTCUSDT 20%, csv:Data/gold.csv 30%
costs: 10 bps  # per side
stop loss: 8%

buy  when close > sma(200) and rsi(14) of ^VIX < 30.5
       or close crosses above highest(high, 50)[1]

for BTCUSDT:
  sell when not true
nonsense here`.split('\n');

const shown = (i: number) => tokenizeBlock(BLOCK)[i].map((t) => `${t.kind}:${BLOCK[i].slice(t.from, t.to)}`);

test('settings: key, tickers, numbers, free text, comments', () => {
  assert.deepEqual(shown(0), ['key:name', 'value:Three sleeves']);
  assert.deepEqual(shown(1), ['key:universe', 'ticker:SPY', 'number:50%', 'ticker:binance:BTCUSDT', 'number:20%', 'ticker:csv:Data/gold.csv', 'number:30%']);
  assert.deepEqual(shown(2), ['key:costs', 'number:10 bps', 'comment:# per side']);
  assert.deepEqual(shown(3), ['key:stop loss', 'number:8%']);
});

test('rules, continuation lines and "of" tickers', () => {
  assert.deepEqual(shown(5), [
    'keyword:buy', 'keyword:when', 'series:close', 'operator:>', 'function:sma', 'operator:(', 'number:200', 'operator:)',
    'keyword:and', 'function:rsi', 'operator:(', 'number:14', 'operator:)', 'keyword:of', 'ticker:^VIX', 'operator:<', 'number:30.5',
  ]);
  assert.deepEqual(shown(6).slice(0, 5), ['keyword:or', 'series:close', 'keyword:crosses', 'keyword:above', 'function:highest']);
  assert.deepEqual(shown(6).slice(-3), ['operator:[', 'number:1', 'operator:]']);
});

test('for headers, constants, and lines that are neither', () => {
  assert.deepEqual(shown(8), ['keyword:for', 'ticker:BTCUSDT']);
  assert.deepEqual(shown(9), ['keyword:sell', 'keyword:when', 'keyword:not', 'value:true']);
  assert.deepEqual(shown(4), []);
  // A line after a rule continues it; unknown words in it stay uncoloured.
  assert.deepEqual(shown(10), []);
});

const labels = (above: string[], before: string, block = BLOCK) => complete(block, above, before)?.items.map((i) => i.label) ?? null;

test('tickers the block names', () => {
  assert.deepEqual(tickers(BLOCK), ['SPY', 'BTCUSDT', 'gold']);
});

test('line starts offer settings and rule openers', () => {
  assert.deepEqual(labels([], 'st'), ['stop loss']);
  assert.deepEqual(labels([], 'b'), ['buy when', 'benchmark']);
  assert.deepEqual(labels([], 's'), ['sell when', 'symbol', 'size', 'stop loss']);
  assert.equal(labels([], ''), null);
  const r = complete(BLOCK, [], '  tr')!;
  assert.deepEqual([r.from, r.items[0].insert], [2, 'trailing stop: ']);
  // Inside a rule, a new line can also continue it.
  assert.deepEqual(labels(['buy when close > 1'], 'a'), ['and']);
  assert.equal(labels([], 'a'), null);
});

test('setting values', () => {
  assert.deepEqual(labels([], 'rebalance: '), ['never', 'weekly', 'monthly', 'quarterly', 'yearly']);
  assert.deepEqual(labels([], 'rebalance: m'), ['monthly']);
  assert.equal(labels([], 'rebalance: monthly'), null);
  assert.deepEqual(labels([], 'data: '), ['yahoo', 'binance']);
  assert.deepEqual(labels([], 'interval: 1'), ['1m', '15m', '1h', '12h', '1d', '1w']);
  assert.equal(labels([], 'name: s'), null);
  assert.equal(labels([], 'universe: S'), null);
});

test('inside a rule: series, functions and words', () => {
  assert.deepEqual(labels([], 'buy when c'), ['close', 'crosses above', 'crosses below']);
  assert.deepEqual(labels([], 'buy when close > s'), ['sma', 'stdev']);
  assert.equal(complete(BLOCK, [], 'buy when close > sm')!.items[0].insert, 'sma(');
  assert.deepEqual(labels([], 'buy when close > sma(h'), ['high', 'highest']);
  assert.deepEqual(labels(['buy when close > 1'], '   or rs'), ['rsi']);
  assert.deepEqual(labels([], 'buy '), ['when']);
  assert.deepEqual(labels([], 'sell when close crosses '), ['above', 'below']);
  // Nothing while typing a number, after a finished word, or outside a rule.
  assert.equal(labels([], 'buy when close > sma(2'), null);
  assert.equal(labels([], 'buy when close'), null);
  assert.equal(labels([], 'buy when close > '), null);
  assert.equal(labels([], 'something el'), null);
});

test('tickers after "of" and "for"', () => {
  assert.deepEqual(labels([], 'buy when close of '), ['SPY', 'BTCUSDT', 'gold']);
  assert.deepEqual(labels([], 'buy when close of b'), ['BTCUSDT']);
  assert.deepEqual(labels([], 'for '), ['SPY', 'BTCUSDT', 'gold', 'all']);
  assert.equal(complete(BLOCK, [], 'for g')!.items[0].insert, 'gold:');
});
