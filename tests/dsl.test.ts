import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec } from '../src/dsl.ts';

const ok = (src: string) => {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  return spec!;
};
const fails = (src: string, pattern: RegExp, line?: number) => {
  const { spec, errors } = parseSpec(src);
  assert.equal(spec, null);
  const hit = errors.find((e) => pattern.test(e.message));
  assert.ok(hit, `no error matching ${pattern} in ${JSON.stringify(errors)}`);
  if (line !== undefined) assert.equal(hit.line, line);
};

test('the example from the design parses', () => {
  const spec = ok(`universe: SPY
from: 2010-01-01

buy  when close crosses above sma(200)
sell when close crosses below sma(200)
       or rsi(14) > 80

size: 100% of equity
costs: 5 bps`);
  assert.deepEqual(spec.universe, [{ name: 'SPY', source: 'yahoo', id: 'SPY', weight: 1 }]);
  assert.equal(spec.from, Date.UTC(2010, 0, 1));
  assert.equal(spec.costBps, 5);
  const sell = spec.rules.SPY.sell!;
  assert.equal(sell.k, 'logic');
  assert.deepEqual(spec.rules.SPY.buy, {
    k: 'cmp',
    op: 'xup',
    a: { k: 'series', name: 'close' },
    b: { k: 'ind', fn: 'sma', src: { k: 'series', name: 'close' }, args: [200] },
  });
});

test('weights, sources and per-ticker rules', () => {
  const spec = ok(`universe: SPY 50%, binance:BTCUSDT 20%, csv:Data/Gold Futures/gold.csv 10%
buy when close > sma(50)
for btcusdt:
  buy when rsi(14) < 30
  sell when rsi(14) > 70
for all:
sell when close < sma(50)`.replace('Gold Futures/', ''));
  assert.deepEqual(spec.universe.map((a) => [a.name, a.source, a.weight]), [
    ['SPY', 'yahoo', 0.5],
    ['BTCUSDT', 'binance', 0.2],
    ['gold', 'csv', 0.1],
  ]);
  assert.equal((spec.rules.BTCUSDT.buy as { op: string }).op, '<');
  assert.equal((spec.rules.SPY.sell as { op: string }).op, '<');
  assert.equal((spec.rules.gold.buy as { op: string }).op, '>');
});

test('unweighted tickers split the size equally', () => {
  assert.deepEqual(ok('universe: SPY, TLT\nsize: 80%\nbuy when true').universe.map((a) => a.weight), [0.4, 0.4]);
});

test('precedence: not is looser than a comparison, and tighter than or', () => {
  const buy = ok('universe: SPY\nbuy when not close > 1 + 2 * 3 or close < 0 and volume > 5').rules.SPY.buy;
  assert.equal(buy.k, 'logic');
  if (buy.k !== 'logic') return;
  assert.equal(buy.op, 'or');
  assert.equal(buy.a.k, 'not');
  assert.equal(buy.b.k, 'logic');
  const cmp = (buy.a as { a: { b: unknown } }).a.b;
  assert.deepEqual(cmp, { k: 'bin', op: '+', a: { k: 'num', v: 1 }, b: { k: 'bin', op: '*', a: { k: 'num', v: 2 }, b: { k: 'num', v: 3 } } });
});

test('lag, of, percentages and word comparisons', () => {
  const spec = ok('universe: QQQ\nbuy when close is above highest(20)[1] and sma(200) of ^VIX below 25 and roc(20) > 5%');
  assert.deepEqual(spec.extras, [{ name: '^VIX', source: 'yahoo', id: '^VIX' }]);
  const json = JSON.stringify(spec.rules.QQQ.buy);
  assert.match(json, /"k":"lag".*"n":1/);
  assert.match(json, /"k":"of".*"asset":"\^VIX"/);
  assert.match(json, /"v":0.05/);
});

test('"of" with a universe ticker does not add an extra', () => {
  const spec = ok('universe: SPY 50%, BTC-USD 50%\nbuy when close of btc-usd > sma(close, 50) of BTC-USD');
  assert.deepEqual(spec.extras, []);
});

test('indicator arguments', () => {
  const buy = ok('universe: SPY\nbuy when sma(rsi(2), 5) < 30 and macd() > macd_signal() and close < bb_lower(20, 2.5)').rules.SPY.buy;
  const json = JSON.stringify(buy);
  assert.match(json, /"fn":"sma","src":\{"k":"ind","fn":"rsi".*"args":\[2\]\},"args":\[5\]/);
  assert.match(json, /"fn":"macd_signal".*"args":\[12,26,9\]/);
  assert.match(json, /"fn":"bb_lower".*"args":\[20,2.5\]/);
});

test('settings', () => {
  const spec = ok(`name: Trend
universe: SPY
to: 2020-12-31
capital: $25k
costs: 0.1%
rebalance: Monthly
benchmark: QQQ
stop loss: 10%
trailing stop: 15%
take profit: 150%
buy when true  # comment`);
  assert.equal(spec.name, 'Trend');
  assert.equal(spec.capital, 25_000);
  assert.equal(spec.costBps, 10);
  assert.equal(spec.rebalance, 'monthly');
  assert.equal(spec.benchmark!.name, 'QQQ');
  assert.equal(spec.stopLoss, 0.1);
  assert.equal(spec.trailingStop, 0.15);
  assert.equal(spec.takeProfit, 1.5);
  assert.equal(spec.to, Date.UTC(2020, 11, 31) + 86_400_000 - 1);
  assert.equal(spec.rules.SPY.sell, null);
});

test('errors carry the line they are on', () => {
  fails('universe: SPY\nbuy when close > smaa(200)', /Unknown name "smaa"/, 2);
  fails('universe: SPY\nbuy when close > sma(200)\n  and (rsi(14) < 30', /Expected "\)"/, 3);
  fails('universe: SPY\nbuy when sma(200)', /needs a condition/);
  fails('universe: SPY\nbuy when close > sma()', /needs a period/);
  fails('universe: SPY\nbuy when close > 1 and 5', /"and" needs a condition/);
  fails('universe: SPY\nleverage: 2\nbuy when true', /Unknown setting "leverage"/, 2);
  fails('universe: SPY 80%, TLT 40%\nbuy when true', /120\.0%.*no leverage/, 1);
  fails('universe: SPY 80%, TLT\nbuy when true', /every ticker a weight/);
  fails('universe: SPY\nsell when close < 1', /no buy rule/);
  fails('buy when true', /Add a universe/);
  fails('universe: SPY\nfrom: 1/2/2020\nbuy when true', /not a date/, 2);
  fails('universe: SPY\ninterval: 1h\nbuy when true', /Yahoo data comes as 1d or 1w/, 2);
  fails('universe: SPY\nfor TLT:\nbuy when true', /not in the universe/, 3);
  fails('universe: SPY\nbuy when true\nbuy when false', /already a buy rule/, 3);
  fails('universe: SPY\nhello there', /Not a setting or a rule/, 2);
});

test('several errors are reported together', () => {
  const { errors } = parseSpec('universe: SPY\ncosts: lots\nbuy when close >');
  assert.deepEqual(errors.map((e) => e.line), [2, 3]);
});
