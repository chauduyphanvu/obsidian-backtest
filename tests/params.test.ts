import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paramValues, parseSpec, type ParseOptions } from '../src/dsl.ts';

const ok = (src: string, opts?: ParseOptions) => {
  const { spec, errors } = parseSpec(src, opts);
  assert.deepEqual(errors, []);
  return spec!;
};
const errorOf = (src: string, pattern: RegExp, opts?: ParseOptions) => {
  const { spec, errors } = parseSpec(src, opts);
  assert.equal(spec, null);
  const hit = errors.find((e) => pattern.test(e.message));
  assert.ok(hit, `no error matching ${pattern} in ${JSON.stringify(errors)}`);
  return hit;
};

const BLOCK = `universe: SPY
buy when sma(fast) > sma(slow) and close > bb_lower(20, band) and close > close[lag]
stop loss: stop

fast = 50 in 20..100 step 10
slow = 200
stop = 8% in 4%..12% step 2%
band = 2.5 in 1..3 step 0.5
lag = 2`;

test('parameters are declared in any order and resolve to plain numbers', () => {
  const spec = ok(BLOCK);
  assert.deepEqual(spec.params, [
    { name: 'fast', value: 50, declared: 50, percent: false, range: { lo: 20, hi: 100, step: 10 }, line: 5 },
    { name: 'slow', value: 200, declared: 200, percent: false, range: null, line: 6 },
    { name: 'stop', value: 0.08, declared: 0.08, percent: true, range: { lo: 0.04, hi: 0.12, step: 0.02 }, line: 7 },
    { name: 'band', value: 2.5, declared: 2.5, percent: false, range: { lo: 1, hi: 3, step: 0.5 }, line: 8 },
    { name: 'lag', value: 2, declared: 2, percent: false, range: null, line: 9 },
  ]);
  const json = JSON.stringify(spec.rules.SPY.buy);
  assert.match(json, /"fn":"sma","src":\{"k":"series","name":"close"\},"args":\[50\]/);
  assert.match(json, /"args":\[200\]/);
  assert.match(json, /"fn":"bb_lower".*"args":\[20,2.5\]/);
  assert.match(json, /"k":"lag","a":\{"k":"series","name":"close"\},"n":2/);
  assert.deepEqual(spec.stops.SPY.stopLoss, { k: 'pct', v: 0.08 });
  assert.deepEqual(paramValues(spec.params[0]), [20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.deepEqual(paramValues(spec.params[2]), [0.04, 0.06, 0.08, 0.1, 0.12]);
  assert.deepEqual(paramValues(spec.params[1]), [200]);
});

test('a parameter in a rule is a number; the step defaults to 1, or 1% for percentages', () => {
  const spec = ok('universe: SPY\nlimit = 3% in 1%..5%\nn = 5 in 1..10\nbuy when roc(20) > limit and rsi(n) < 30');
  assert.deepEqual(spec.params.map((p) => p.range), [{ lo: 0.01, hi: 0.05, step: 0.01 }, { lo: 1, hi: 10, step: 1 }]);
  assert.match(JSON.stringify(spec.rules.SPY.buy), /"b":\{"k":"num","v":0.03\}.*"fn":"rsi".*"args":\[5\]/);
  // Names are matched without regard to case.
  assert.equal(ok('universe: SPY\nN = 4\nbuy when close > sma(n)').params[0].name, 'N');
});

test('a parameter can set the number held by a ranking', () => {
  assert.equal(ok('universe: SPY, QQQ, TLT\nn = 2 in 1..3\nhold: top n by roc(20)').rank!.top, 2);
  errorOf('universe: SPY, QQQ\nn = 50%\nhold: top n by close', /"top" must be a number, but "n" is a percentage/);
  errorOf('universe: SPY\nk = 2\nstop loss: k\nbuy when true', /Stop loss must be a percentage, but "k" is a number/);
  assert.deepEqual(ok('universe: SPY\nk = 2.5\nstop loss: k atr(10)\nbuy when true').stops.SPY.stopLoss, { k: 'atr', mult: 2.5, n: 10 });
});

test('overrides replace declared values, even outside the range', () => {
  const spec = ok(BLOCK, { overrides: { fast: 30, STOP: 0.2 } });
  assert.match(JSON.stringify(spec.rules.SPY.buy), /"args":\[30\]/);
  assert.deepEqual(spec.stops.SPY.stopLoss, { k: 'pct', v: 0.2 });
  assert.deepEqual([spec.params[0].value, spec.params[0].declared], [30, 50]);
  assert.deepEqual(errorOf(BLOCK, /no parameter "slowest"/, { overrides: { slowest: 1 } }), {
    line: 1,
    message: 'There is no parameter "slowest" to set. First, add it to the block, for example slowest = 50',
  });
  // An override still has to make sense where it is used.
  errorOf(BLOCK, /sma\(\): 2.5 is not a permitted period/, { overrides: { fast: 2.5 } });
});

test('declaration errors point at the part that is wrong', () => {
  const twice = errorOf('universe: SPY\nx = 1\nx = 2\nbuy when true', /"x" is also set on line 2/);
  assert.deepEqual([twice.line, twice.from, twice.to], [3, 0, 1]);
  const order = errorOf('x = 5 in 10..1\nuniverse: SPY\nbuy when true', /The first number of the range is larger than the second/);
  assert.deepEqual([order.line, order.from, order.to], [1, 9, 14]);
  const outside = errorOf('x = 50 in 1..10\nuniverse: SPY\nbuy when true', /50 is not in the range 1..10/);
  assert.deepEqual([outside.from, outside.to], [4, 6]);
  const step = errorOf('x = 5 in 1..10 step 0\nuniverse: SPY\nbuy when true', /step must be more than 0/);
  assert.deepEqual([step.from, step.to], [20, 21]);
  errorOf('x = 5 in 1..1000\nuniverse: SPY\nbuy when true', /This range has 1000 values\. The maximum is 200/);
  errorOf('x = 5% in 1%..300% step 1%\nuniverse: SPY\nbuy when true', /This range has 300 values/);
  errorOf('x = 5 in\nuniverse: SPY\nbuy when true', /Write a parameter as x = 50/);
  // Any other value that is not a number is a definition, here of a name that does not exist.
  errorOf('x = fast\nuniverse: SPY\nbuy when true', /Unknown name "fast"/);
  const reserved = errorOf('close = 5\nuniverse: SPY\nbuy when true', /"close" is a built-in name/);
  assert.deepEqual([reserved.from, reserved.to], [0, 5]);
  errorOf('universe: SPY\nfast = 2.5\nbuy when close > sma(fast)', /sma\(\): 2.5 is not a permitted period/);
});

test('a single "=" line closes the rule above it, while "==" continues it', () => {
  const spec = ok('universe: SPY\nbuy when close > 1 and\n  x == 3\nx = 3');
  assert.match(JSON.stringify(spec.rules.SPY.buy), /"op":"==","a":\{"k":"num","v":3\},"b":\{"k":"num","v":3\}/);
});
