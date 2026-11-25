// The functions added after the first thirty-four as the language offers them: how they are written, typed and read, the
// pointwise functions with position values inside, the ranking and Connors RSI they make possible, the history they need,
// how they look in the editor, in an explanation and in the bar-by-bar table, and their trigger prices against the engine.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { complete } from '../src/complete.ts';
import { cellText, debugColumns, debugRange, debugRows } from '../src/debug.ts';
import { docFor, shortOf } from '../src/docs.ts';
import { type Expr, INDICATORS, LATER_WORDS, parseSpec, RESERVED } from '../src/dsl.ts';
import { Evaluator } from '../src/evaluate.ts';
import { explainTrade } from '../src/explain.ts';
import { fixFor } from '../src/fixes.ts';
import { tokenize } from '../src/highlight.ts';
import * as ind from '../src/indicators.ts';
import { lookbackBars } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY, T0 } from './helpers.ts';
import { rng } from './random-bars.ts';
import { head, tally, verify, walkBars } from './trigger-helpers.ts';

const NEW = ['sum', 'dema', 'tema', 'kama', 'aroon_up', 'aroon_down', 'psar', 'cmf', 'linreg', 'rsquared', 'efficiency', 'streak'];
const POINTWISE = ['sqrt', 'log', 'exp', 'if'];

const problems = (rule: string, extra = '') => parseSpec(`universe: A\n${extra}buy when true\nsell when ${rule}`).errors.map((e) => e.message);
const failure = (rule: string, extra = '') => parseSpec(`universe: A\n${extra}buy when ${rule}`).errors.map((e) => e.message)[0];
const expr = (text: string, extra = ''): Expr => {
  const { spec, errors } = parseSpec(`universe: A\n${extra}buy when ${text}`);
  assert.deepEqual(errors, [], text);
  return spec!.rules.A.buy;
};
const num = (text: string): Expr => (expr(`${text} > -1000000000`) as Extract<Expr, { k: 'cmp' }>).a;
const args = (text: string) => (num(text) as Extract<Expr, { k: 'ind' }>).args;

test('the table lists every function this file knows about', () => {
  for (const name of NEW) assert.ok(name in INDICATORS, name);
});

// ---------------------------------------------------------------- how they are written

test('numbers have defaults where the usual setting is standard', () => {
  assert.deepEqual(args('sum(20)'), [20]);
  assert.deepEqual(args('dema(20)'), [20]);
  assert.deepEqual(args('tema(20)'), [20]);
  assert.deepEqual(args('kama()'), [10, 2, 30]);
  assert.deepEqual(args('kama(20)'), [20, 2, 30]);
  assert.deepEqual(args('kama(20, 3)'), [20, 3, 30]);
  assert.deepEqual(args('kama(close, 5, 3, 20)'), [5, 3, 20]);
  assert.deepEqual(args('aroon_up()'), [25]);
  assert.deepEqual(args('aroon_down(10)'), [10]);
  assert.deepEqual(args('psar()'), [0.02, 0.2]);
  assert.deepEqual(args('psar(0.01)'), [0.01, 0.2]);
  assert.deepEqual(args('psar(0.01, 0.1)'), [0.01, 0.1]);
  assert.deepEqual(args('cmf()'), [20]);
  assert.deepEqual(args('linreg(90)'), [90]);
  assert.deepEqual(args('rsquared(90)'), [90]);
  assert.deepEqual(args('efficiency(10)'), [10]);
  assert.deepEqual(args('streak()'), []);
});

test('a series can come first where a function reads one, and the ones that read the ticker\'s own bars take none', () => {
  const series = (text: string) => (num(text) as Extract<Expr, { k: 'ind' }>).src;
  assert.equal(series('sum(volume, 5)')!.k, 'series');
  assert.equal(series('dema(rsi(14), 21)')!.k, 'ind');
  assert.equal(series('kama(volume, 10, 2, 30)')!.k, 'series');
  assert.equal(series('linreg(log(close), 90)')!.k, 'math');
  assert.deepEqual(series('rsquared(close, 90)'), { k: 'series', name: 'close' });
  assert.deepEqual(series('efficiency(volume, 10)'), { k: 'series', name: 'volume' });
  // Without one, close.
  assert.deepEqual(series('sum(5)'), { k: 'series', name: 'close' });
  assert.deepEqual(series('streak()'), { k: 'series', name: 'close' });
  assert.equal(series('streak(rsi(14))')!.k, 'ind');
  assert.equal(series('streak(volume)')!.k, 'series');
  for (const name of ['aroon_up', 'aroon_down', 'psar', 'cmf']) {
    assert.equal(series(`${name}()`), null, name);
    assert.equal(failure(`${name}(close) > 0`), `The periods of ${name}() must be numbers or parameters`, name);
  }
});

test('wrong numbers of arguments and lengths out of range are refused in plain words', () => {
  assert.equal(failure('sum() > 0'), 'sum() must have a period, for example sum(20)');
  assert.equal(failure('dema() > 0'), 'dema() must have a period, for example dema(20)');
  assert.equal(failure('rsquared() > 0'), 'rsquared() must have a period, for example rsquared(20)');
  // A first argument that is not needed for the periods is the series, so it takes 4 numbers or more to be too many.
  assert.equal(failure('kama(10, 2, 30, 5, 6) > 0'), 'kama() can have a maximum of 3 numbers');
  assert.equal(failure('psar(0.02, 0.2, 1) > 0'), 'psar() can have a maximum of 2 numbers');
  assert.equal(failure('streak(5) > 0'), 'streak() must have only a series, not numbers, for example streak(close)');
  assert.equal(failure('streak(close, 5) > 0'), 'streak() cannot have arguments');
  assert.equal(failure('kama(0) > 0'), 'kama(): 0 is not a permitted period. Use a whole number from 1 to 10000');
  assert.equal(failure('kama(10, 2, 0) > 0'), 'kama(): 0 is not a permitted period. Use a whole number from 1 to 10000');
  assert.equal(failure('cmf(1.5) > 0'), 'cmf(): 1.5 is not a permitted period. Use a whole number from 1 to 10000');
  assert.equal(failure('dema(10001) > 0'), 'dema(): 10001 is not a permitted period. Use a whole number from 1 to 10000');
  assert.equal(failure('aroon_up(0) > 0'), 'aroon_up(): 0 is not a permitted period. Use a whole number from 1 to 10000');
  // These need at least two bars: a line through one value says nothing.
  for (const name of ['linreg', 'rsquared']) assert.equal(failure(`${name}(1) > 0`), `${name}(): 1 is not a permitted period. Use a whole number from 2 to 10000`, name);
  // A length of 1 is fine where it means something.
  for (const name of ['sum', 'dema', 'tema', 'aroon_up', 'aroon_down', 'cmf', 'efficiency']) assert.deepEqual(parseSpec(`universe: A\nbuy when ${name}(1) > 0`).errors, [], name);
});

test('psar refuses a step above its maximum, and either of them 0 or below, with an example', () => {
  const example = 'Use a step that is not more than the maximum, for example psar(0.02, 0.2)';
  assert.equal(failure('psar(0.3, 0.2) > 0'), `psar(): the step 0.3 is more than the maximum 0.2. ${example}`);
  // The default maximum counts when only the step is written.
  assert.equal(failure('psar(0.3) > 0'), `psar(): the step 0.3 is more than the maximum 0.2. ${example}`);
  assert.equal(failure('psar(0.5, 0.4) > 0', ''), `psar(): the step 0.5 is more than the maximum 0.4. ${example}`);
  assert.equal(failure('psar(0, 0.2) > 0'), 'psar(): 0 is not a permitted step');
  assert.equal(failure('psar(0.02, 0) > 0'), 'psar(): 0 is not a permitted maximum');
  // Equal is fine, and so is a step or maximum above 1.
  assert.deepEqual(parseSpec('universe: A\nbuy when psar(0.2, 0.2) > 0 and psar(0.5, 1.5) > 0').errors, []);
  // A parameter in the step is checked at the value it has.
  assert.match(failure('psar(st) > 0', 'st = 0.4\n'), /^psar\(\): the step 0.4 is more than the maximum 0.2/);
  assert.deepEqual(parseSpec('universe: A\nst = 0.02 in 0.01..0.2 step 0.01\nbuy when psar(st) > 0').errors, []);
});

test('sqrt, log and exp take one number, and if takes a condition and two numbers', () => {
  assert.equal(failure('sqrt() > 0'), 'sqrt() must have 1 value, for example sqrt(stdev(20))');
  assert.equal(failure('log(1, 2) > 0'), 'log() must have 1 value, for example log(close)');
  assert.equal(failure('exp() > 0'), 'exp() must have 1 value, for example exp(slope(log(close), 90) * 252)');
  assert.equal(failure('log(close > 1) > 0'), 'log() must have a number, not a condition');
  const example = 'if(close > sma(200), roc(126), 0)';
  assert.equal(failure('if(close > 1, 2) > 0'), `if() must have a condition and two numbers, for example ${example}`);
  assert.equal(failure('if() > 0'), `if() must have a condition and two numbers, for example ${example}`);
  assert.equal(failure('if(close > 1, 2, 3, 4) > 0'), `if() must have a condition and two numbers, for example ${example}`);
  assert.equal(failure('if(close, 1, 2) > 0'), `The first value of if() must be a condition, not a number, for example ${example}`);
  assert.equal(failure('if(close > 1, close > 2, 3) > 0'), `The second and third values of if() must be numbers, not conditions, for example ${example}`);
  assert.equal(failure('if(close > 1, 2, close > 3) > 0'), `The second and third values of if() must be numbers, not conditions, for example ${example}`);
  // The whole is a number, so a rule needs a comparison around it.
  assert.match(failure('if(close > 1, 2, 3)'), /A rule must have a condition/);
  assert.deepEqual(parseSpec('universe: A\nbuy when if(close > sma(200), roc(126), 0) > 5% and sqrt(stdev(20)) < log(close) + exp(1)').errors, []);
});

test('the position values go inside the pointwise functions in sell rules, and nowhere a buy rule can read them', () => {
  assert.deepEqual(problems('if(bars held > 3, close, entry price) < close'), []);
  assert.deepEqual(problems('sqrt(bars held) >= 2 and exp(entries made) > 1 and log(last entry price) > 0'), []);
  assert.match(failure('if(bars held > 1, 1, 0) > 0'), /You can use "bars held" only in a sell, cover or add rule/);
  assert.match(problems('sma(if(bars held > 3, close, 1), 5) > 0')[0], /You cannot use "bars held" in sma\(\)/);
  assert.match(problems('if(bars held > 3, close, 1)[1] > 0')[0], /for a previous bar with \[n\]/);
});

test('a function added after 0.7.0 can still name a parameter, which the block then means by it', () => {
  for (const name of [...NEW, ...POINTWISE]) {
    assert.deepEqual(parseSpec(`universe: A\n${name} = 5\nbuy when close > sma(${name})`).errors, [], name);
    assert.match(parseSpec(`universe: A\n${name} = 5\nbuy when ${name}(close) > 0`).errors[0]?.message ?? '', new RegExp(`"${name}" is a parameter in this block\\. Thus you cannot use ${name}\\(\\) here`), name);
    assert.ok(!RESERVED.has(name) && LATER_WORDS.has(name), name);
  }
});

test('every function except the conditions is a number', () => {
  for (const name of NEW) {
    const { params } = INDICATORS[name];
    const call = `${name}(${params.map((d) => d ?? 20).join(', ')})`;
    assert.match(failure(call), /A rule must have a condition/, name);
  }
  for (const call of ['sqrt(close)', 'log(close)', 'exp(close)', 'if(close > 1, 2, 3)']) assert.match(failure(call), /A rule must have a condition/, call);
});

// ---------------------------------------------------------------- how they are read

/** Bars with a trend, noise, and volume that moves. */
function market(len: number, seed = 3, volume = true, bias = 0.46): Bars {
  const u = rng(seed);
  const out: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let px = 100;
  for (let i = 0; i < len; i++) {
    const open = px * (1 + (u() - 0.5) * 0.004);
    const close = open * (1 + (u() - bias) * 0.03);
    out.t.push(T0 + i * DAY);
    out.o.push(open);
    out.c.push(close);
    out.h.push(Math.max(open, close) * (1 + u() * 0.01));
    out.l.push(Math.min(open, close) * (1 - u() * 0.01));
    out.v.push(volume ? Math.round(1e6 * (0.5 + u())) : 0);
    px = close;
  }
  return out;
}

const values = (text: string, data: Record<string, Bars>, extra = ''): number[] => {
  const { spec, errors } = parseSpec(`universe: A\n${extra}buy when ${text}`);
  assert.deepEqual(errors, [], text);
  const e = spec!.rules.A.buy;
  return new Evaluator(new Map(Object.entries(data))).series(e.k === 'cmp' ? e.a : e, 'A');
};
const at = (text: string, data: Record<string, Bars>) => values(`${text} > -1000000000`, data);

test('each function reads the ticker\'s own bars, or the series given, and gives the array its indicator gives', () => {
  const m = market(400);
  const A = { A: m };
  assert.deepEqual(at('sum(20)', A), ind.sum(m.c, 20));
  assert.deepEqual(at('sum(volume, 5)', A), ind.sum(m.v, 5));
  assert.deepEqual(at('dema(20)', A), ind.dema(m.c, 20));
  assert.deepEqual(at('tema(20)', A), ind.tema(m.c, 20));
  assert.deepEqual(at('kama(10, 2, 30)', A), ind.kama(m.c, 10, 2, 30));
  assert.deepEqual(at('kama()', A), ind.kama(m.c, 10, 2, 30));
  assert.deepEqual(at('aroon_up(25)', A), ind.aroonUp(m.h, 25));
  assert.deepEqual(at('aroon_down(25)', A), ind.aroonDown(m.l, 25));
  assert.deepEqual(at('psar(0.02, 0.2)', A), ind.psar(m.h, m.l, m.c, 0.02, 0.2));
  assert.deepEqual(at('cmf(20)', A), ind.cmf(m.h, m.l, m.c, m.v, 20));
  assert.deepEqual(at('linreg(50)', A), ind.linreg(m.c, 50));
  assert.deepEqual(at('rsquared(50)', A), ind.rsquared(m.c, 50));
  assert.deepEqual(at('efficiency(20)', A), ind.efficiency(m.c, 20));
  assert.deepEqual(at('streak()', A), ind.streak(m.c));
  assert.deepEqual(at('streak(volume)', A), ind.streak(m.v));
  assert.deepEqual(at('kama(rsi(14), 10, 2, 30)', A), ind.kama(ind.rsi(m.c, 14), 10, 2, 30));
  assert.deepEqual(at('linreg(log(close), 90)', A), ind.linreg(m.c.map(Math.log), 90));
});

test('another ticker is read with of, line for line, and the functions that read the ticker\'s own bars read that ticker\'s', () => {
  const [a, b] = [market(300, 8), market(300, 9)];
  const AB = { A: a, B: b };
  assert.deepEqual(at('streak() of B', AB), ind.streak(b.c));
  assert.deepEqual(at('psar() of B', AB), ind.psar(b.h, b.l, b.c, 0.02, 0.2));
  assert.deepEqual(at('aroon_up(14) of B', AB), ind.aroonUp(b.h, 14));
  assert.deepEqual(at('cmf(14) of B', AB), ind.cmf(b.h, b.l, b.c, b.v, 14));
  assert.deepEqual(at('dema(close, 20) of B', AB), ind.dema(b.c, 20));
});

test('a rule that uses a function that is still unknown never fires', () => {
  const m = market(120);
  const { spec } = parseSpec('universe: A\nbuy when tema(30) > -1000 and linreg(40) > 0');
  const bt = runBacktest(spec!, new Map([['A', m]]));
  // tema(30) is first known at index 3 * 29 = 87, so the signal is read at the close of that bar and fills at the next open.
  assert.equal(bt.run.trades[0].entryT, m.t[88]);
  const none = runBacktest(parseSpec('universe: A\nbuy when kama(10, 2, 30) > 0 and dema(100) > 0').spec!, new Map([['A', m]]));
  assert.equal(none.run.trades.length, 0);
});

test('cmf says so when the prices have no volume', () => {
  const none = market(60, 3, false);
  assert.throws(() => at('cmf(14)', { A: none }), /^Error: A has no volume, but cmf\(\) must have volume/);
  assert.throws(() => at('cmf(14) of IDX', { A: market(60), IDX: none }), /IDX has no volume/);
  assert.doesNotThrow(() => at('aroon_up(14)', { A: none }));
  assert.doesNotThrow(() => at('psar()', { A: none }));
});

test('sqrt, log and exp are unknown where the result is not a number, and if picks a branch where the condition is known', () => {
  const b = bars([4, 0, -1, 1, 710]);
  const A = { A: b };
  assert.deepEqual(at('sqrt(close)', A), [2, 0, NaN, 1, Math.sqrt(710)]);
  assert.deepEqual(at('log(close)', A), [Math.log(4), NaN, NaN, 0, Math.log(710)]);
  // e to the 710 is too large for a number, so it is unknown, and e to the 709 still is one.
  assert.deepEqual(at('exp(close)', A), [Math.exp(4), 1, Math.exp(-1), Math.E, NaN]);
  assert.equal(at('exp(close - 1)', A)[4], Math.exp(709));
  // A number that was unknown stays so through them.
  assert.deepEqual(at('sqrt(roc(1))', { A: bars([1, 4, 4, 1]) }), [NaN, Math.sqrt(3), 0, NaN]);
  const c = bars([1, 2, 3, 4, 5]);
  assert.deepEqual(at('if(close > 2.5, close * 10, -1)', { A: c }), [-1, -1, 30, 40, 50]);
  // The condition unknown: unknown. The branch not picked unknown: no matter. The branch picked unknown: unknown.
  assert.deepEqual(at('if(close > sma(3), 1, 0)', { A: c }), [NaN, NaN, 1, 1, 1]);
  assert.deepEqual(at('if(close > 100, roc(3), 7)', { A: c }), [7, 7, 7, 7, 7]);
  assert.deepEqual(at('if(close > 0, roc(3), 7)', { A: c }), [NaN, NaN, NaN, 3, 1.5]);
});

test('sqrt, log, exp and if work with position values in a sell rule, as abs does', () => {
  const m = market(300, 5, true, 0.48);
  const trades = (rule: string) => runBacktest(parseSpec(`universe: A\nbuy when close > sma(5)\nsell when ${rule}`).spec!, new Map([['A', m]])).run.trades.map((t) => [t.entryT, t.exitT]);
  const wanted = trades('bars held >= 3');
  assert.ok(wanted.length > 10);
  assert.deepEqual(trades('if(bars held >= 3, 1, 0) == 1'), wanted);
  assert.deepEqual(trades('sqrt(bars held) >= 1.7'), wanted);
  assert.deepEqual(trades('exp(log(bars held + 1)) > 3.5'), wanted);
  assert.deepEqual(trades('log(bars held + 1) > 1.2'), wanted);
  // The branch picked decides: the entry price on the first bars, a fixed 1 once 3 bars have passed.
  assert.deepEqual(trades('if(bars held >= 3, 1, entry price * 2) < 2'), wanted);
});

test('no function reads a later bar, through the evaluator and across other tickers', () => {
  const [a, b] = [market(300, 8), market(300, 9)];
  const texts = [
    'sum(20)', 'dema(20)', 'tema(10)', 'kama(10, 2, 30)', 'aroon_up(25)', 'aroon_down(10)', 'psar()', 'cmf(20)', 'linreg(30)', 'rsquared(30)',
    'efficiency(10)', 'streak()', 'streak(rsi(5))', 'if(close > sma(20), roc(10), 0)', 'exp(slope(log(close), 20) * 20) - 1', 'sqrt(stdev(10))',
    'kama(close of B, 10, 2, 30)', 'psar() of B', 'streak() of B', 'rsquared(log(close) of B, 20)',
  ];
  const cut = (x: Bars, k: number): Bars => ({ t: x.t.slice(0, k), o: x.o.slice(0, k), h: x.h.slice(0, k), l: x.l.slice(0, k), c: x.c.slice(0, k), v: x.v.slice(0, k) });
  for (const text of texts) {
    const { spec, errors } = parseSpec(`universe: A\nbuy when ${text} > -1000000000`);
    assert.deepEqual(errors, [], text);
    const e = (spec!.rules.A.buy as Extract<Expr, { k: 'cmp' }>).a;
    const whole = new Evaluator(new Map([['A', a], ['B', b]])).series(e, 'A');
    for (const k of [1, 2, 5, 21, 30, 59, 60, 61, 120, 299]) {
      const part = new Evaluator(new Map([['A', cut(a, k)], ['B', cut(b, k)]])).series(e, 'A');
      assert.deepEqual(part, whole.slice(0, k), `${text}: the first ${k} values depend on later bars`);
    }
  }
});

// ---------------------------------------------------------------- what they make possible

test('a Clenow momentum ranking runs: the annualised slope of the log price times the fit, as the score of hold', () => {
  const [A, B, C] = [walkBars(500, 1), walkBars(500, 2), walkBars(500, 3)];
  const { spec, errors } = parseSpec('universe: A, B, C\nhold: top 2 by (exp(slope(log(close), 90) * 252) - 1) * rsquared(log(close), 90)\nrebalance: monthly');
  assert.deepEqual(errors, []);
  const data = new Map([['A', A], ['B', B], ['C', C]]);
  const score = new Evaluator(data).series(spec!.rank!.by, 'A');
  const byHand = ind.slope(A.c.map(Math.log), 90).map((s, i) => (Math.exp(s * 252) - 1) * ind.rsquared(A.c.map(Math.log), 90)[i]);
  assert.deepEqual(score, byHand);
  assert.ok(score.slice(89).every((x) => !Number.isNaN(x)) && score.slice(0, 89).every(Number.isNaN));
  const bt = runBacktest(spec!, data);
  assert.ok(bt.run.trades.length > 5, String(bt.run.trades.length));
  // At each month's first bar from the score's first known one, the two held are the two with the best scores.
  const scores = ['A', 'B', 'C'].map((n) => new Evaluator(data).series(spec!.rank!.by, n));
  const decided = bt.run.trades.filter((t) => t.entryT > A.t[100]);
  assert.ok(decided.length > 3);
  const first = bt.run.trades[0];
  const k = A.t.indexOf(first.entryT);
  const ranked = [0, 1, 2].sort((x, y) => scores[y][k - 1] - scores[x][k - 1]).slice(0, 2).map((i) => 'ABC'[i]);
  assert.ok(ranked.includes(first.asset), `${first.asset} entered at ${new Date(first.entryT).toISOString()} but the best scores were ${ranked}`);
});

test('Connors RSI is written with streak and runs', () => {
  const m = market(1500, 3);
  const crsi = '(rsi(3) + rsi(streak(), 2) + percent_rank(roc(1), 100)) / 3';
  const { spec, errors } = parseSpec(`universe: A\nbuy when ${crsi} < 15\nsell when ${crsi} > 70`);
  assert.deepEqual(errors, []);
  const e = (spec!.rules.A.buy as Extract<Expr, { k: 'cmp' }>).a;
  const got = new Evaluator(new Map([['A', m]])).series(e, 'A');
  const [a, b, c] = [ind.rsi(m.c, 3), ind.rsi(ind.streak(m.c), 2), ind.percentRank(ind.roc(m.c, 1), 100)];
  assert.deepEqual(got, a.map((x, i) => (x + b[i] + c[i]) / 3));
  // Known from bar 101 (the rank needs the 100 changes before this one), and a score from 0 to 100.
  assert.ok(got.slice(0, 101).every(Number.isNaN) && got.slice(101).every((x) => x >= 0 && x <= 100));
  const bt = runBacktest(spec!, new Map([['A', m]]));
  assert.ok(bt.run.trades.length >= 10, String(bt.run.trades.length));
  assert.ok(bt.run.trades.every((t) => t.entryT >= m.t[102]));
});

// ---------------------------------------------------------------- the history a run needs

const lookback = (rule: string, extra = '') => {
  const { spec, errors } = parseSpec(`universe: A\n${extra}buy when ${rule}`);
  assert.deepEqual(errors, [], rule);
  return lookbackBars(spec!);
};

test('lookbackBars covers each function: its window, and the settling of the ones that start from where they began', () => {
  // The run keeps at least 250 bars, so these use periods that need more.
  for (const name of ['sum', 'cmf', 'linreg', 'rsquared']) assert.equal(lookback(`${name}(300) > 0`), 300, name);
  // A window of n + 1 values counts one more, as percent_rank does.
  for (const name of ['aroon_up', 'aroon_down', 'efficiency']) assert.equal(lookback(`${name}(300) > 0`), 301, name);
  // Averages that depend on where they started count five times their period for each smoothing.
  assert.equal(lookback('dema(300) > 0'), 3000);
  assert.equal(lookback('tema(100) > 0'), 1500);
  // kama: ten time constants of its slowest smoothing, ((slow + 1) / 2) squared bars each, as five periods of an ema are,
  // after the n + 1 values of its efficiency ratio. At efficiency 0 for all of them, under 0.005% of where it began is left.
  assert.equal(lookback('kama(10, 2, 30) > 0'), 11 + 2403);
  assert.equal(lookback('kama(300, 2, 30) > 0'), 301 + 2403);
  assert.equal(lookback('kama(10, 2, 3) > 0'), 250);
  assert.equal(lookback('kama(10, 2, 1000) > 0'), 11 + 50_000);
  assert.ok((1 - (2 / 31) ** 2) ** 2403 < 5e-5);
  // streak counts back no further than the prices loaded; psar reads that much history for the trend it began in.
  assert.equal(lookback('streak() > 0'), 250);
  assert.equal(lookback('sma(streak(), 300) > 0'), 250 + 300);
  assert.equal(lookback('rsi(streak(), 2) > 0'), 250 + 1 + 10);
  assert.equal(lookback('psar() > 0'), 250);
  assert.equal(lookback('sma(psar(), 100) > 0'), 250 + 100);
  // The pointwise functions add nothing, but what is inside them.
  assert.equal(lookback('sqrt(sma(300)) > 0'), 300);
  assert.equal(lookback('if(close > sma(300), roc(100), 0) > 0'), 300);
  assert.equal(lookback('if(close > sma(100), roc(280), 0) > 0'), 280);
  assert.equal(lookback('exp(slope(log(close), 90) * 252) * rsquared(log(close), 400) > 0'), 400);
});

test('lookbackBars nests, and counts a parameter with a range at the top of its range', () => {
  assert.equal(lookback('sma(rsquared(100), 200) > 0'), 300);
  assert.equal(lookback('rsquared(sma(close, 100), 200) > 0'), 300);
  assert.equal(lookback('sma(dema(close, 60), 40) > 0'), 600 + 40);
  const p = (name: string, rule: string, range: string) => lookback(rule, `${name} = ${range.split(' in ')[0]} in ${range.split(' in ')[1]}\n`);
  assert.equal(p('n', 'dema(n) > 0', '20 in 20..300 step 40'), 3000);
  // 20..400 step 60 stops at 380.
  assert.equal(p('n', 'kama(n, 2, 30) > 0', '20 in 20..400 step 60'), 381 + 2403);
  // 10..100 step 30 stops at 100: ten time constants of (101 / 2) squared bars.
  assert.equal(p('s', 'kama(10, 2, s) > 0', '30 in 10..100 step 30'), 11 + 25_503);
  assert.equal(p('n', 'aroon_up(n) > 0', '25 in 10..350 step 20'), 351);
  // A multiplier is not a length: psar's step and maximum add nothing.
  assert.equal(p('m', 'psar(0.02, m) > 0', '0.2 in 0.1..0.5 step 0.1'), 250);
});

test('each function is known, and settled, from the first bar of a run that has the history lookbackBars asks for', () => {
  const full = market(7000, 21);
  const cut = (x: Bars, from: number): Bars => ({ t: x.t.slice(from), o: x.o.slice(from), h: x.h.slice(from), l: x.l.slice(from), c: x.c.slice(from), v: x.v.slice(from) });
  // [expression, how far from the full-history value it may be, relative, when run from the lookback: windowed ones depend on nothing before their window (only rounding), and the others on where they started]
  const cases: [string, number][] = [
    ['sum(300)', 1e-9], ['aroon_up(300)', 0], ['aroon_down(300)', 0], ['cmf(300)', 1e-9], ['linreg(300)', 1e-9], ['rsquared(300)', 1e-9], ['efficiency(300)', 1e-9],
    ['dema(60)', 1e-6], ['tema(40)', 1e-6], ['kama(10, 2, 30)', 1e-4], ['kama(30, 3, 40)', 1e-4],
    ['psar(0.02, 0.2)', 0], ['psar(0.1, 0.3)', 0], ['streak()', 0], ['rsi(streak(), 2)', 0], ['sma(psar(), 50)', 0],
  ];
  const starts = [2500, 3300, 4100, 5200, 6100];
  for (const [text, tol] of cases) {
    const { spec, errors } = parseSpec(`universe: A\nbuy when ${text} > -1000000000`);
    assert.deepEqual(errors, [], text);
    const lb = lookbackBars(spec!);
    const e = (spec!.rules.A.buy as Extract<Expr, { k: 'cmp' }>).a;
    const all = new Evaluator(new Map([['A', full]])).series(e, 'A');
    // A run needs its history before it, so a start is tried only where the bars reach back that far.
    const fits = starts.filter((s) => s >= lb);
    assert.ok(fits.length >= 2, `${text}: ${lb} bars of history leave too few starts to try`);
    for (const s of fits) {
      const part = new Evaluator(new Map([['A', cut(full, s - lb)]])).series(e, 'A');
      const [got, want] = [part[lb], all[s]];
      assert.ok(!Number.isNaN(got), `${text}: unknown at the first bar of a run starting at bar ${s} with ${lb} bars before it`);
      assert.ok(Math.abs(got - want) <= tol * Math.max(1, Math.abs(want)), `${text}: ${got} with ${lb} bars of history, ${want} with all of it, at bar ${s}`);
    }
  }
});

// ---------------------------------------------------------------- how they look in the editor

test('every function is coloured as a function, in a rule and where a score is written', () => {
  for (const name of [...NEW, ...POINTWISE]) {
    const line = `buy when ${name}(10) > ${name}(5)`;
    const kinds = tokenize(line, 'rule').map((t) => [line.slice(t.from, t.to), t.kind]);
    assert.deepEqual(kinds.filter(([text]) => text === name).map(([, kind]) => kind), ['function', 'function'], name);
  }
  assert.ok(tokenize('hold: top 2 by exp(slope(log(close), 90) * 252)', 'setting').filter((t) => t.kind === 'function').length === 3);
  // A parameter whose name starts like a function is still a parameter.
  assert.deepEqual(tokenize('buy when sum_n > 3', 'rule', ['sum_n']).map((t) => t.kind), ['keyword', 'keyword', 'param', 'operator', 'number']);
});

test('every function completes, with its signature and what it does', () => {
  for (const name of [...NEW, ...POINTWISE]) {
    const found = complete([], [], `buy when ${name.slice(0, 3)}`)!.items.find((i) => i.label === name);
    assert.ok(found, name);
    assert.equal(found.insert, `${name}(`);
    assert.equal(found.detail, `${docFor(name)!.signature} · ${shortOf(name)}`);
  }
  const sig = (name: string) => docFor(name)!.signature;
  assert.equal(sig('sum'), 'sum(n)');
  assert.equal(sig('kama'), 'kama(n = 10, fast = 2, slow = 30)');
  assert.equal(sig('aroon_up'), 'aroon_up(n = 25)');
  assert.equal(sig('psar'), 'psar(step = 0.02, max = 0.2)');
  assert.equal(sig('cmf'), 'cmf(n = 20)');
  assert.equal(sig('streak'), 'streak()');
  assert.equal(sig('sqrt'), 'sqrt(x)');
  assert.equal(sig('if'), 'if(condition, a, b)');
});

test('the help says whether a function reads a series, needs volume, or reads the ticker\'s own bars', () => {
  assert.match(docFor('cmf')!.text, /no series argument, the ticker must have volume, and a bar with no range adds 0/);
  assert.match(docFor('aroon_up')!.text, /no series argument and reads the highs of the ticker/);
  assert.match(docFor('aroon_down')!.text, /reads the lows of the ticker/);
  assert.match(docFor('psar')!.text, /no series argument, and its speed increases by step at each new high or low, from step to max \(step cannot be more than max\)/);
  assert.match(docFor('streak')!.text, /or the series you write first, as in streak\(volume\)/);
  assert.match(docFor('sum')!.text, /or the series you write first, as in sum\(volume, 20\)/);
});

test('a misspelt new name is corrected to the right one', () => {
  const fixed = (line: string) => {
    const lines = ['universe: SPY', line];
    const d = parseSpec(lines.join('\n')).errors[0];
    const fix = fixFor(lines, d);
    assert.ok(fix, `no fix for ${line}`);
    return line.slice(0, fix.from) + fix.insert + line.slice(fix.to);
  };
  assert.equal(fixed('buy when close > rsqared(20)'), 'buy when close > rsquared(20)');
  assert.equal(fixed('buy when aroon_upp(25) > 70'), 'buy when aroon_up(25) > 70');
  assert.equal(fixed('buy when close > kamaa()'), 'buy when close > kama()');
});

// ---------------------------------------------------------------- how they look in an explanation and in the bar-by-bar table

function run(src: string, data: Record<string, Bars>): Backtest {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, [], src);
  return runBacktest(spec!, new Map(Object.entries(data)));
}

test('an explanation labels each new word with its value', () => {
  const m = market(500, 41);
  const bt = run(
    'universe: A\nbuy when close > kama(10, 2, 30) and streak() >= 1 and psar() < close and if(close > sma(50), roc(20), 0) > -5%\nsell when bars held > 8 or close < if(bars held > 2, sma(20), entry price * 0.9)',
    { A: m },
  );
  assert.ok(bt.run.trades.length > 0);
  const t = bt.run.trades[1] ?? bt.run.trades[0];
  const ex = explainTrade(bt, t);
  const rows = (id: string) => ex.sections.find((s) => s.id === id)!.rows.filter((r) => r.code);
  const byLabel = (id: string, label: string) => rows(id).find((r) => r.label === label)!;
  assert.match(byLabel('bought', 'close > kama(10, 2, 30)').value, /^close [0-9.]+ > kama\(10, 2, 30\) [0-9.]+$/);
  assert.match(byLabel('bought', 'streak() >= 1').value, /^streak\(\) [0-9]+ ≥ 1$/);
  assert.match(byLabel('bought', 'psar() < close').value, /^psar\(\) [0-9.]+ < close [0-9.]+$/);
  assert.match(byLabel('bought', 'if(close > sma(50), roc(20), 0) > -5%').value, /^if\(close > sma\(50\), roc\(20\), 0\) [−0-9.]+% > -5%$/);
  assert.equal(byLabel('bought', 'close > kama(10, 2, 30)').outcome, 'yes');
});

test('the bar-by-bar table gives the reason a new word is unknown', () => {
  const wave = (n: number) => Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 9) * 5);
  const flat = bars(Array.from({ length: 80 }, () => 100));
  const moving = bars(wave(120));
  const bt = (src: string, d: Bars) => run(`universe: A\nbuy when ${src}\nsell when close < 0`, { A: d });
  const details = (b: Backtest, i: number) => {
    const row = debugRows(b, 'A', 0, debugRange(b, 'A').count)[i];
    return Object.fromEntries(debugColumns(b, 'A').map((c, n) => [c.text, cellText(c, row.cells[n]).detail]));
  };
  const sq = bt('sqrt(close - 100) > 1', moving);
  assert.equal(details(sq, 40)['sqrt(close - 100) > 1'], 'the square root of a negative number');
  const lg = bt('log(close - 104) > 1', moving);
  assert.equal(details(lg, 0)['log(close - 104) > 1'], 'the log of 0 or less');
  const ex = bt('exp(close * 10) > 1', moving);
  assert.equal(details(ex, 5)['exp(close * 10) > 1'], 'a number that is too large');
  // A window where nothing changes has no efficiency and no fit, which is not the same as a window not yet full.
  for (const rule of ['efficiency(10) > 0.5', 'rsquared(10) > 0.5']) {
    const f = bt(rule, flat);
    assert.equal(details(f, 60)[rule], 'all values in the window are the same', rule);
    assert.equal(details(f, 2)[rule], 'its warm-up is not complete', rule);
  }
  // if says why the value it picked is unknown: its condition's average is its warm-up is not complete.
  const c = bt('if(close > sma(50), 1, 0) > 0', moving);
  assert.equal(details(c, 10)['if(close > sma(50), 1, 0) > 0'], 'its warm-up is not complete');
  assert.equal(details(c, 80)['if(close > sma(50), 1, 0) > 0'], '');
});

// ---------------------------------------------------------------- trigger prices

test('trigger prices for rules that read the new words agree with the engine, inside the price and outside it', () => {
  const rules = [
    'buy when close > kama(10, 2, 30)\nsell when close < kama(10, 2, 30)',
    'buy when close crosses above psar()\nsell when close < psar()',
    'buy when close > dema(20)\nsell when close < tema(20)',
    'buy when streak() <= -2\nsell when streak() >= 2',
    'buy when aroon_up(10) > 70 and aroon_down(10) < 30\nsell when aroon_down(10) > 70',
    'buy when cmf(10) > 0.05\nsell when cmf(10) < -0.05',
    'buy when close > linreg(20) and rsquared(20) > 0.5\nsell when close < linreg(20)',
    'buy when efficiency(10) > 0.3 and close > sma(20)\nsell when close < sma(20)',
    'buy when if(close > sma(50), roc(10), 0) > 1%\nsell when close < sma(50)',
    'buy when exp(slope(log(close), 20) * 20) > 1.02\nsell when sqrt(close) < sqrt(sma(close, 50))',
  ];
  const seen = tally();
  const A = walkBars(700, 1);
  for (const [k, body] of rules.entries()) {
    const src = `universe: A\n${body}`;
    const { spec, errors } = parseSpec(src);
    assert.deepEqual(errors, [], src);
    for (const cut of [430, 470, 510, 560, 600, 650, 700]) verify(spec!, new Map([['A', head(A, cut)]]), `rule ${k}, ${cut} bars:\n${src}\n`, seen);
  }
  assert.ok(seen.buy >= 18 && seen.sell >= 22, JSON.stringify(seen));
});
