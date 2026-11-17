import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec, type ParseOptions } from '../src/dsl.ts';

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
  assert.deepEqual(spec.stops.SPY.stopLoss, { k: 'pct', v: 0.1 });
  assert.deepEqual(spec.stops.SPY.trailingStop, { k: 'pct', v: 0.15 });
  assert.deepEqual(spec.stops.SPY.takeProfit, { k: 'pct', v: 1.5 });
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

const parse = (src: string, opts?: ParseOptions) => parseSpec(src, opts);
const errorOf = (src: string, pattern: RegExp, opts?: ParseOptions) => {
  const { spec, errors } = parse(src, opts);
  assert.equal(spec, null);
  const hit = errors.find((e) => pattern.test(e.message));
  assert.ok(hit, `no error matching ${pattern} in ${JSON.stringify(errors)}`);
  return hit;
};

test('built-in defaults, defaults from options, and a data line over the default source', () => {
  let spec = ok('universe: SPY\nbuy when true');
  assert.deepEqual([spec.capital, spec.costBps, spec.slippageBps, spec.cash, spec.universe[0].source], [10_000, 0, 0, { k: 'fixed', rate: 0 }, 'yahoo']);
  const defaults = { capital: 5000, costBps: 3, slippageBps: 2, cashRate: '4%', dataSource: 'binance' as const };
  spec = parse('universe: BTCUSDT\ninterval: 1h\nbuy when true', { defaults }).spec!;
  assert.deepEqual([spec.capital, spec.costBps, spec.slippageBps, spec.cash, spec.universe[0].source], [5000, 3, 2, { k: 'fixed', rate: 0.04 }, 'binance']);
  spec = parse('universe: SPY\ndata: yahoo\ncapital: 1k\ncash rate: ^IRX\nbuy when true', { defaults: { ...defaults, capital: undefined } }).spec!;
  assert.deepEqual([spec.capital, spec.universe[0].source, spec.cash], [1000, 'yahoo', { k: 'ticker', ref: { name: '^IRX', source: 'yahoo', id: '^IRX' } }]);
  assert.deepEqual(errorOf('universe: SPY\nbuy when true', /default cash rate/, { defaults: { cashRate: '4' } }), {
    line: 1,
    message: 'The default cash rate "4" in the plugin settings can\'t be read. Use a percentage, such as 4%, or a ticker, such as ^IRX',
  });
});

test('errors point at columns, on continuation lines too', () => {
  const name = errorOf('universe: SPY\nbuy when close > smaa(200)', /Unknown name "smaa"/);
  assert.deepEqual([name.line, name.from, name.to], [2, 17, 21]);
  const cont = errorOf('universe: SPY\nbuy when close > 1\n   and foo > 2', /Unknown name "foo"/);
  assert.deepEqual([cont.line, cont.from, cont.to], [3, 7, 10]);
  // A rule that stops early points at its last token.
  const early = errorOf('universe: SPY\nbuy when close > sma(200)\n  and (rsi(14) < 30', /Expected "\)"/);
  assert.deepEqual([early.line, early.from, early.to], [3, 17, 19]);
  const value = errorOf('universe: SPY\ncosts: lots\nbuy when true', /not a cost/);
  assert.deepEqual([value.line, value.from, value.to], [2, 7, 11]);
  const key = errorOf('universe: SPY\n  leverage: 2\nbuy when true', /Unknown setting "leverage"/);
  assert.deepEqual([key.line, key.from, key.to], [2, 2, 10]);
  const twice = errorOf('universe: SPY, SPY\nbuy when true', /listed twice/);
  assert.deepEqual([twice.from, twice.to], [15, 18]);
  const char = errorOf('universe: SPY\nbuy when close > 1 $', /Unexpected character "\$"/);
  assert.deepEqual([char.from, char.to], [19, 20]);
  // A problem with no place of its own covers the whole line.
  assert.deepEqual(errorOf('universe: SPY\nhello there', /Not a setting or a rule/), { line: 2, message: 'Not a setting or a rule. Rules start with "buy when" or "sell when"' });
});

test('a price compared with a fixed number warns when the prices come from Yahoo', () => {
  const { warnings, spec } = parse('universe: SPY\nbuy when close > 100 and rsi(14) < 30\nsell when 100 < low[2] or close < sma(20)');
  assert.ok(spec);
  assert.deepEqual(
    warnings.map((w) => [w.line, w.from, w.to]),
    [[2, 9, 20], [3, 10, 22]],
  );
  assert.match(warnings[0].message, /^This compares a price with a fixed number\. Yahoo prices are adjusted/);
  assert.deepEqual(parse('universe: binance:BTCUSDT\nbuy when close > 100').warnings, []);
  // The ticker read with "of" decides, and arithmetic on numbers is still a fixed number.
  assert.deepEqual(parse('universe: binance:BTCUSDT\nbuy when close of SPY > 3 * 100').warnings.map((w) => [w.from, w.to]), [[9, 31]]);
  assert.deepEqual(parse('universe: SPY\nbuy when close > open and volume > 1000 and close > sma(20) * 1.1').warnings, []);
});

test('index levels are not adjusted, so comparing them with a number gives no warning', () => {
  assert.deepEqual(parse('universe: SPY\nbuy when close of ^VIX < 20').warnings, []);
  assert.deepEqual(parse('universe: ^GSPC, ^NDX\nbuy when close > 4000').warnings, []);
  // One adjusted ticker among them is enough for the warning.
  assert.equal(parse('universe: ^GSPC, SPY\nbuy when close > 4000').warnings.length, 1);
});

test('slippage, cash rate and test from', () => {
  const spec = ok('universe: SPY\nfrom: 2010-01-01\nto: 2020-12-31\ntest from: 2018-01-01\nslippage: 0.05%\ncash rate: 4.5%\nbuy when true');
  assert.deepEqual([spec.slippageBps, spec.cash, spec.testFrom], [5, { k: 'fixed', rate: 0.045 }, Date.UTC(2018, 0, 1)]);
  assert.equal(ok('universe: SPY\nslippage: 3 bps\nbuy when true').slippageBps, 3);
  assert.deepEqual(ok('universe: SPY\ncash rate: yahoo:^irx\nbuy when true').cash, { k: 'ticker', ref: { name: '^IRX', source: 'yahoo', id: '^IRX' } });
  errorOf('universe: SPY\ncash rate: 60%\nbuy when true', /between 0% and 50%/);
  errorOf('universe: SPY\ncash rate: 4\nbuy when true', /yearly percentage, such as 4%/);
  errorOf('universe: SPY\nfrom: 2010-01-01\ntest from: 2010-01-01\nbuy when true', /must be after "from"/);
  errorOf('universe: SPY\nto: 2010-01-01\ntest from: 2010-01-01\nbuy when true', /must be before "to"/);
});

test('stops as ATR multiples, and stops for one ticker', () => {
  const spec = ok(`universe: SPY 50%, TLT 50%
stop loss: 10%
trailing stop: 2.5 atr
take profit: 4 atr(10)
buy when true
for TLT:
  stop loss: 2 atr(14)
  take profit: 30%`);
  assert.deepEqual(spec.stops.SPY, { stopLoss: { k: 'pct', v: 0.1 }, trailingStop: { k: 'atr', mult: 2.5, n: 14 }, takeProfit: { k: 'atr', mult: 4, n: 10 } });
  assert.deepEqual(spec.stops.TLT, { stopLoss: { k: 'atr', mult: 2, n: 14 }, trailingStop: { k: 'atr', mult: 2.5, n: 14 }, takeProfit: { k: 'pct', v: 0.3 } });
  const other = errorOf('universe: SPY 50%, TLT 50%\nbuy when true\nfor TLT:\n  costs: 5 bps', /"costs" applies to the whole strategy/);
  assert.deepEqual([other.line, other.from, other.to], [4, 2, 7]);
  errorOf('universe: SPY\nbuy when true\nfor QQQ:\n  stop loss: 5%', /not in the universe/);
  errorOf('universe: SPY\nbuy when true\nfor SPY:\n  stop loss: 5%\n  stop loss: 6%', /set twice for SPY/);
  errorOf('universe: SPY\nstop loss: two atr\nbuy when true', /needs a number/);
  errorOf('universe: SPY\nstop loss: 2 atr(0)\nbuy when true', /atr\(\): 0 is not a valid period/);
  errorOf('universe: SPY\nstop loss: tight\nbuy when true', /percentage, such as 10%, or a multiple of the average true range/);
});

test('ranking with hold: equal shares of size, optional buy rule', () => {
  const spec = ok('universe: SPY, QQQ, TLT\nsize: 80%\nhold: top 2 by roc(126)');
  assert.deepEqual(spec.rank, { top: 2, by: { k: 'ind', fn: 'roc', src: { k: 'series', name: 'close' }, args: [126] } });
  assert.deepEqual(spec.universe.map((a) => a.weight), [0.4, 0.4, 0.4]);
  assert.deepEqual(spec.rules.QQQ, { buy: { k: 'bool', v: true }, sell: null });
  assert.equal(ok('universe: SPY, QQQ\nhold: top 1 by close\nbuy when close > sma(200)').rules.SPY.buy.k, 'cmp');
  errorOf('universe: SPY 50%, QQQ 50%\nhold: top 1 by close', /Leave the weights out/);
  errorOf('universe: SPY, QQQ\nhold: top 3 by close', /"top 3" is more tickers than the universe has \(2\)/);
  errorOf('universe: SPY, QQQ\nhold: best 1', /Write it as top 3 by roc\(126\)/);
  errorOf('universe: SPY, QQQ\nhold: top 1 by close > 1', /The ranking needs a number/);
  const pos = errorOf('universe: SPY, QQQ\nhold: top 1 by bars held', /"bars held" only makes sense in a sell rule/);
  assert.deepEqual([pos.line, pos.from, pos.to], [2, 15, 24]);
});

test('sizing: inverse volatility, risk per trade, and what does not mix', () => {
  assert.deepEqual(ok('universe: SPY, TLT\nweighting: inverse volatility(60)\nbuy when true').sizing, { k: 'invvol', n: 60 });
  assert.deepEqual(ok('universe: SPY\nrisk per trade: 1% at 2 atr(14)\nbuy when true').sizing, { k: 'risk', risk: 0.01, mult: 2, n: 14 });
  assert.deepEqual(ok('universe: SPY\nrisk per trade: 0.5% at 1.5 atr\nbuy when true').sizing, { k: 'risk', risk: 0.005, mult: 1.5, n: 14 });
  assert.deepEqual(ok('universe: SPY\nbuy when true').sizing, { k: 'fixed' });
  errorOf('universe: SPY\nweighting: inverse volatility(60)\nrisk per trade: 1% at 2 atr(14)\nbuy when true', /either "weighting" or "risk per trade"/);
  errorOf('universe: SPY\nrebalance: monthly\nrisk per trade: 1% at 2 atr(14)\nbuy when true', /can't be combined with "rebalance: monthly"/);
  errorOf('universe: SPY\nweighting: inverse volatility\nbuy when true', /inverse volatility\(60\)/);
  errorOf('universe: SPY\nweighting: inverse volatility(1)\nbuy when true', /1 is not a valid period/);
  errorOf('universe: SPY\nrisk per trade: 1 at 2 atr\nbuy when true', /risk per trade must be a percentage/);
});

test('position values only in sell rules, and never lagged or read with "of"', () => {
  const spec = ok('universe: SPY\nbuy when true\nsell when bars held >= 5 or close < entry price * 0.9 or bars_held > entry_price');
  const json = JSON.stringify(spec.rules.SPY.sell);
  assert.equal(json.match(/"k":"pos","name":"bars_held"/g)!.length, 2);
  assert.equal(json.match(/"k":"pos","name":"entry_price"/g)!.length, 2);
  const buy = errorOf('universe: SPY\nbuy when bars held > 1', /"bars held" only makes sense in a sell rule/);
  assert.deepEqual([buy.line, buy.from, buy.to], [2, 9, 18]);
  errorOf('universe: SPY\nbuy when true\nsell when bars_held[1] > 2', /"bars held" can't be read for an earlier bar/);
  errorOf('universe: SPY\nbuy when true\nsell when (close - entry price) of QQQ > 1', /"entry price" belongs to the open position/);
  errorOf('universe: SPY\nbuy when true\nsell when sma(bars held, 2) > 1', /can't go inside sma\(\)/);
  errorOf('universe: SPY\nbuy when true\nsell when bars > 1', /Write "bars held"/);
});

test('calendar values', () => {
  const buy = ok('universe: SPY\nbuy when month == 12 and weekday <= 2 and day > 20 and year >= 2020 or month_end\nsell when month_start').rules.SPY;
  const json = JSON.stringify(buy);
  for (const name of ['month', 'weekday', 'day', 'year', 'month_end', 'month_start']) assert.match(json, new RegExp(`"k":"cal","name":"${name}"`));
  errorOf('universe: SPY\nbuy when month', /needs a condition/);
});

test('one name for two different price sources is an error, wherever the second one is named', () => {
  const said = (src: string) => parseSpec(src).errors.map((e) => [e.line, e.message]);
  const twice = (a: string, b: string, name = 'SPY') => `${name} is used for two different things here: ${a} and ${b}. Rename the CSV file or use one of them.`;
  assert.deepEqual(said('universe: SPY\nbenchmark: csv:Benchmarks/SPY.csv\nbuy when close of csv:Alt/SPY.csv > 0'), [
    [2, twice('yahoo:SPY', 'csv:Benchmarks/SPY.csv')],
    [3, twice('yahoo:SPY', 'csv:Alt/SPY.csv')],
  ]);
  assert.deepEqual(said('universe: csv:Data/SPY.csv\nbenchmark: SPY\nbuy when true'), [[2, twice('csv:Data/SPY.csv', 'yahoo:SPY')]]);
  assert.deepEqual(said('universe: csv:Data/gold.csv\ncash rate: binance:GOLD\nbuy when true'), [[2, twice('csv:Data/gold.csv', 'binance:GOLD', 'gold')]]);
  assert.deepEqual(said('universe: SPY\nbenchmark: csv:B/^IRX.csv\ncash rate: ^IRX\nbuy when true'), [[3, twice('csv:B/^IRX.csv', 'yahoo:^IRX', '^IRX')]]);
  assert.deepEqual(said('universe: SPY\nbuy when true'), []);
  assert.deepEqual(parseSpec('universe: SPY\nbuy when true', { defaults: { cashRate: 'csv:x/SPY.csv' } }).errors.map((e) => [e.line, e.message]), [
    [1, twice('yahoo:SPY', 'csv:x/SPY.csv')],
  ]);
  // The same source twice is one ticker, and a bare name reads the CSV of that name.
  ok('universe: csv:Data/gold.csv\nbenchmark: csv:Data/gold.csv\nbuy when close of gold > 0 and close of csv:Data/gold.csv > 0');
  ok('universe: SPY\nbenchmark: yahoo:SPY\ncash rate: ^IRX\nbuy when close of yahoo:SPY > 0');
});
