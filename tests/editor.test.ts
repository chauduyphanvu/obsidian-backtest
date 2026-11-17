import assert from 'node:assert/strict';
import { test } from 'node:test';
import { complete, tickers } from '../src/complete.ts';
import { lineKind, tokenize, tokenizeBlock } from '../src/highlight.ts';

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
  assert.deepEqual(labels([], 's'), ['sell when', 'symbol', 'size', 'stop loss', 'slippage']);
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

const V2 = `universe: SPY, QQQ, TLT
fast = 50 in 20..100 step 10   # sweep
stop = 8%
hold: top n by roc(fast) of SPY
weighting: inverse volatility(60)
risk per trade: 1% at 2 atr(14)
cash rate: ^IRX
slippage: 5 bps
test from: 2019-01-01
stop loss: stop
buy when sma(fast) > close and month_end
sell when bars held >= n or close < entry price * 0.9 or weekday == 5
for TLT:
  trailing stop: 3 atr(14)
n = 2`.split('\n');

const shownV2 = (i: number) => tokenizeBlock(V2)[i].map((t) => `${t.kind}:${V2[i].slice(t.from, t.to)}`);

test('parameter declarations: name as a key, numbers, in and step', () => {
  assert.deepEqual(shownV2(1), ['key:fast', 'operator:=', 'number:50', 'keyword:in', 'number:20', 'operator:..', 'number:100', 'keyword:step', 'number:10', 'comment:# sweep']);
  assert.deepEqual(shownV2(2), ['key:stop', 'operator:=', 'number:8%']);
  assert.deepEqual(shownV2(14), ['key:n', 'operator:=', 'number:2']);
  assert.equal(lineKind(V2[1], true), 'param');
  // A built-in name is not a parameter, so inside a rule the line continues it.
  assert.equal(lineKind('  close = 5', true), 'continuation');
});

test('new settings colour their values, with parameters where numbers go', () => {
  assert.deepEqual(shownV2(3), ['key:hold', 'keyword:top', 'param:n', 'keyword:by', 'function:roc', 'operator:(', 'param:fast', 'operator:)', 'keyword:of', 'ticker:SPY']);
  assert.deepEqual(shownV2(4), ['key:weighting', 'value:inverse', 'value:volatility', 'operator:(', 'number:60', 'operator:)']);
  assert.deepEqual(shownV2(5), ['key:risk per trade', 'number:1%', 'keyword:at', 'number:2', 'function:atr', 'operator:(', 'number:14', 'operator:)']);
  assert.deepEqual(shownV2(6), ['key:cash rate', 'ticker:^IRX']);
  assert.deepEqual(shownV2(7), ['key:slippage', 'number:5 bps']);
  assert.deepEqual(shownV2(8), ['key:test from', 'number:2019-01-01']);
  assert.deepEqual(shownV2(9), ['key:stop loss', 'param:stop']);
  assert.deepEqual(shownV2(13), ['key:trailing stop', 'number:3', 'function:atr', 'operator:(', 'number:14', 'operator:)']);
});

test('rules colour parameters, position values and calendar values', () => {
  assert.deepEqual(shownV2(10), ['keyword:buy', 'keyword:when', 'function:sma', 'operator:(', 'param:fast', 'operator:)', 'operator:>', 'series:close', 'keyword:and', 'series:month_end']);
  assert.deepEqual(shownV2(11), [
    'keyword:sell', 'keyword:when', 'series:bars held', 'operator:>=', 'param:n', 'keyword:or', 'series:close', 'operator:<',
    'series:entry price', 'operator:*', 'number:0.9', 'keyword:or', 'series:weekday', 'operator:==', 'number:5',
  ]);
  // Without the block's parameter names a line leaves them uncoloured.
  assert.ok(!tokenize(V2[10], 'rule').some((t) => t.kind === 'param'));
});

test('completions: position values in sell rules only, calendar values and parameters everywhere in a rule', () => {
  assert.deepEqual(labels([], 'sell when ba', V2), ['bars held']);
  assert.equal(labels([], 'buy when ba', V2), null);
  assert.deepEqual(labels(['sell when close > 1'], '  or en', V2), ['entry price']);
  assert.equal(labels(['buy when close > 1'], '  or en', V2), null);
  assert.deepEqual(labels([], 'buy when month_', V2), ['month_start', 'month_end']);
  assert.deepEqual(labels([], 'buy when we', V2), ['weekday']);
  const fast = complete(V2, [], 'buy when close > sma(fa')!.items;
  assert.deepEqual(fast.map((i) => [i.label, i.detail]), [['fast', 'parameter: 50 in 20..100 step 10']]);
  assert.deepEqual(labels([], 'hold: top 3 by ro', V2), ['roc']);
  assert.equal(labels([], 'hold: top 3 by ba', V2), null);
});

test('completions: hints for the new settings, and only stops inside a for section', () => {
  assert.deepEqual(labels([], 'hold: '), ['top 3 by roc(126)']);
  assert.deepEqual(labels([], 'weighting: '), ['inverse volatility(60)']);
  assert.deepEqual(labels([], 'risk per trade: '), ['1% at 2 atr(14)']);
  assert.deepEqual(labels([], 'cash rate: '), ['4%', '^IRX']);
  assert.deepEqual(labels([], 'slippage: '), ['5 bps']);
  assert.deepEqual(labels([], 'test from: '), ['2019-01-01']);
  assert.deepEqual(labels([], 'stop loss: ', V2), ['10%', '2 atr(14)', 'stop']);
  assert.deepEqual(labels([], 'r'), ['rebalance', 'risk per trade']);
  assert.deepEqual(labels([], 'ca'), ['capital', 'cash rate']);
  assert.deepEqual(labels(['for TLT:'], 's'), ['sell when', 'stop loss']);
  assert.equal(labels(['for TLT:'], 'c'), null);
  assert.deepEqual(labels(['for TLT:', 'for all:'], 'c'), ['capital', 'costs', 'cash rate']);
});
