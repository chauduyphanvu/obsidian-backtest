// `between`, `crosses` either way, condition windows (`for n bars`, `within n bars`) and `count(condition, n)`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { debugColumns, debugRange, debugRows, cellText } from '../src/debug.ts';
import { parseSpec, walk, type Expr } from '../src/dsl.ts';
import { Evaluator } from '../src/evaluate.ts';
import { explainTrade } from '../src/explain.ts';
import * as ind from '../src/indicators.ts';
import { trialHash } from '../src/ledger.ts';
import { makeRng } from '../src/rng.ts';
import { lookbackBars } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { bars } from './helpers.ts';

const N = NaN;

const ruleOf = (rule: string, extra = '') => {
  const { spec, errors } = parseSpec(`universe: A\n${extra}buy when ${rule}`);
  assert.deepEqual(errors, [], rule);
  return spec!;
};
const exprOf = (rule: string, extra = ''): Expr => ruleOf(rule, extra).rules.A.buy;
/** The rule's value at each bar of `closes`, or of `b` when given. */
const values = (rule: string, closes: number[], b: Bars = bars(closes), extra = ''): number[] => new Evaluator(new Map([['A', b]])).eval(exprOf(rule, extra), 'A');
const errorOf = (rule: string, extra = ''): [number, number | undefined, number | undefined, string] => {
  const { errors } = parseSpec(`universe: A\n${extra}buy when ${rule}`);
  assert.equal(errors.length, 1, `${rule}: ${JSON.stringify(errors)}`);
  return [errors[0].line, errors[0].from, errors[0].to, errors[0].message];
};
/** Where `part` is written in a one-line rule, as [from, to] in its line. */
const where = (rule: string, part: string): [number, number] => [`buy when ${rule}`.indexOf(part), `buy when ${rule}`.indexOf(part) + part.length];

// ---------------------------------------------------------------- between

test('between is a comparison: a >= lo and a <= hi, with both ends included', () => {
  assert.deepEqual(exprOf('rsi(2) between 10 and 30'), exprOf('rsi(2) >= 10 and rsi(2) <= 30'));
  assert.deepEqual(exprOf('close between sma(5) and sma(5) * 1.1'), exprOf('close >= sma(5) and close <= sma(5) * 1.1'));
  // With the rest of a rule: it takes its own "and", and the next one is a join.
  assert.deepEqual(exprOf('rsi(2) between 10 and 30 and close > sma(200)'), exprOf('(rsi(2) >= 10 and rsi(2) <= 30) and close > sma(200)'));
  assert.deepEqual(exprOf('close > sma(200) and rsi(2) between 10 and 30'), exprOf('close > sma(200) and (rsi(2) >= 10 and rsi(2) <= 30)'));
  assert.deepEqual(exprOf('not rsi(2) between 10 and 30'), exprOf('not (rsi(2) >= 10 and rsi(2) <= 30)'));
  assert.deepEqual(exprOf('rsi(2) between 10 and 30 or volume between 1 and 5'), exprOf('(rsi(2) >= 10 and rsi(2) <= 30) or (volume >= 1 and volume <= 5)'));
  // Arithmetic and lags belong to the values.
  assert.deepEqual(exprOf('close[1] - 1 between 5 + 1 and 9'), exprOf('close[1] - 1 >= 5 + 1 and close[1] - 1 <= 9'));
});

test('between at each bar, with the ends in and an unknown value unknown', () => {
  const c = [1, 5, 10, 20, 30, 31, 40];
  assert.deepEqual(values('close between 10 and 30', c), [0, 0, 1, 1, 1, 0, 0]);
  assert.deepEqual(values('not close between 10 and 30', c), [1, 1, 0, 0, 0, 1, 1]);
  // sma(3) is unknown for two bars, and so is the range it bounds.
  assert.deepEqual(values('close between 0 and sma(3)', [1, 2, 3, 4, 5]), [N, N, 0, 0, 0]);
  assert.deepEqual(values('close between 0 and sma(3)', [1, 2, 3, 2, 1]), [N, N, 0, 1, 1]);
  // False wins over unknown, as `and` says: the low end already fails.
  assert.deepEqual(values('close between 10 and sma(3)', [1, 2, 3, 4, 5]), [0, 0, 0, 0, 0]);
});

test('between does not chain, and its mistakes are reported at the word that is wrong', () => {
  const chained = 'rsi(2) between 10 and 30 between 1 and 2';
  const from = `buy when ${chained}`.lastIndexOf('between');
  assert.deepEqual(errorOf(chained), [2, from, from + 'between'.length, 'Unexpected "between"']);
});

const NO_AND = '"between" takes two values joined by "and", as in rsi(2) between 10 and 30';

test('the words of between in a rule: what is missing or is not a number', () => {
  assert.equal(errorOf('rsi(2) between 10')[3], NO_AND);
  assert.deepEqual(errorOf('rsi(2) between 10 or 30'), [2, ...where('rsi(2) between 10 or 30', 'or'), NO_AND]);
  assert.deepEqual(errorOf('rsi(2) between 10 and month_end'), [2, ...where('rsi(2) between 10 and month_end', 'between'), '"between" needs a number, not a condition']);
  assert.equal(errorOf('month_end between 1 and 2')[3], '"between" needs a number, not a condition');
  assert.match(errorOf('rsi(2) between and 30')[3], /^Unknown name "and"/);
});

test('between warns on a price against fixed numbers as the other comparisons do', () => {
  const warn = (rule: string) => parseSpec(`universe: SPY\nbuy when ${rule}`).warnings.map((w) => [w.line, w.from, w.to]);
  assert.deepEqual(warn('close between 100 and 200'), [[2, 9, 34]]);
  assert.deepEqual(warn('close between sma(20) and 200'), [[2, 9, 38]]);
  assert.deepEqual(warn('rsi(2) between 10 and 30'), []);
  assert.deepEqual(warn('close between sma(10) and sma(20)'), []);
  assert.deepEqual(warn('close > 100'), [[2, 9, 20]]);
  assert.deepEqual(parseSpec('universe: BTCUSDT\ndata: binance\nbuy when close between 100 and 200').warnings, []);
});

test('between in the parts of a rule: the whole text, then each side as it means', () => {
  const w = ruleOf('rsi(2) between 10 and 30').written!.rules.A.buy!;
  let nodes = 0;
  walk(ruleOf('rsi(2) between 10 and 30').rules.A.buy, () => nodes++);
  assert.equal(w.parts.length, nodes);
  // The empty texts are the close that rsi reads, which the parser fills in.
  assert.deepEqual(w.parts, ['rsi(2) between 10 and 30', 'rsi(2) >= 10', 'rsi(2)', '', '10', 'rsi(2) <= 30', 'rsi(2)', '', '30']);
});

// ---------------------------------------------------------------- crosses

test('crosses with no direction holds where the value crosses above or below', () => {
  assert.equal((exprOf('close crosses sma(5)') as Extract<Expr, { k: 'cmp' }>).op, 'xany');
  assert.equal((exprOf('close crosses above sma(5)') as Extract<Expr, { k: 'cmp' }>).op, 'xup');
  assert.equal((exprOf('close crosses below sma(5)') as Extract<Expr, { k: 'cmp' }>).op, 'xdn');
  // a: 1 2 3 2 1 against 2: above at bar 2, below at bar 4. Touching 2 is neither.
  const a = [1, 2, 3, 2, 1];
  assert.deepEqual(values('close crosses 2', a), [N, 0, 1, 0, 1]);
  assert.deepEqual(values('close crosses above 2', a), [N, 0, 1, 0, 0]);
  assert.deepEqual(values('close crosses below 2', a), [N, 0, 0, 0, 1]);
  // From the other side: 3 2 1 2 3.
  assert.deepEqual(values('close crosses 2', [3, 2, 1, 2, 3]), [N, 0, 1, 0, 1]);
  // Both sides move: close against its own average.
  assert.deepEqual(values('close crosses sma(2)', [1, 3, 1, 3, 3]), [N, N, 1, 1, 0]);
});

test('crosses is unknown when the bar before is unknown, and needs a bar more history', () => {
  assert.deepEqual(values('close crosses sma(3)', [1, 2, 3, 4, 3, 2, 1]), [N, N, N, 0, 1, 0, 0]);
  const spec = (rule: string) => ruleOf(rule, 'from: 2020-01-01\n');
  const wide = lookbackBars(ruleOf('close crosses sma(500)', 'from: 2020-01-01\n'));
  assert.equal(wide, lookbackBars(spec('close crosses above sma(500)')));
  assert.equal(wide, 501);
  assert.equal(lookbackBars(spec('close > sma(500)')), 500);
});

test('crosses in a rule that runs: the order is given at the bar it crosses, either way', () => {
  // The close crosses 10 upwards at day 1 and back down at day 4, and 11.5 is passed at day 2.
  const A = bars([9, 11, 12, 12, 9, 9, 9], { opens: [9, 9, 11, 12, 12, 9, 9] });
  const spec = parseSpec('universe: A\ncapital: 1000\nbuy when close crosses 10\nsell when close > 11.5').spec!;
  const bt = runBacktest(spec, new Map([['A', A]]));
  // Bought at day 2's open (11) and sold at day 3's (12); bought again after the cross down, at day 5's open (9).
  assert.deepEqual(bt.run.trades.map((t) => [t.entryT, t.entryPrice, t.exitPrice, t.reason]), [[A.t[2], 11, 12, 'signal'], [A.t[5], 9, 9, 'open']]);
  const [up, down] = bt.run.trades.map((t) => explainTrade(bt, t).sections.find((s) => s.id === 'bought')!.rows[1]);
  assert.equal(up.value, 'close 11 is above 10; the bar before it was 9, below 10');
  assert.equal(down.value, 'close 9 is below 10; the bar before it was 12, above 10');
  // The table says "crosses" and shows the bar before.
  const cols = debugColumns(bt, 'A');
  const col = cols.findIndex((c) => c.group === 'buy');
  assert.deepEqual([cols[col].kind, cols[col].op], ['cross', 'crosses']);
  const rows = debugRows(bt, 'A', 0, debugRange(bt, 'A').count);
  assert.equal(cellText(cols[col], rows[4].cells[col]).main, '9 vs 10');
  assert.equal(cellText(cols[col], rows[4].cells[col]).detail, 'before 12 vs 10');
  assert.deepEqual(rows.map((r) => r.buy), ['unknown', 'yes', 'no', 'no', 'yes', 'no', 'no']);
});

// ---------------------------------------------------------------- windows and count

test('count(condition, n) counts the last n bars, this one included, and is unknown while any of them is', () => {
  const cond = [0, 0, 1, 0, 0, 0, 1, 0];
  assert.deepEqual(ind.count(cond, 3), [N, N, 1, 1, 1, 0, 1, 1]);
  assert.deepEqual(ind.count(cond, 1), cond);
  assert.deepEqual(ind.count([1, 1, 1], 3), [N, N, 3]);
  assert.deepEqual(ind.count([1, 1, 1], 4), [N, N, N]);
  // An unknown bar makes every window it is in unknown, and the windows after it are known again.
  assert.deepEqual(ind.count([1, 1, N, 1, 1, 1, 0], 2), [N, 2, N, N, 2, 2, 1]);
  assert.deepEqual(ind.count([N, 1, 1], 3), [N, N, N]);
  assert.deepEqual(ind.count([1, 1, 1, N, 1, 1, 1], 3), [N, N, 3, N, N, N, 3]);
});

/** What count says, worked out the slow way for every window. */
function slowCount(cond: number[], n: number): number[] {
  return cond.map((_, i) => {
    if (i < n - 1) return N;
    const w = cond.slice(i - n + 1, i + 1);
    return w.some(Number.isNaN) ? N : w.filter((x) => x === 1).length;
  });
}

test('count agrees with counting each window by hand, on random conditions with gaps', () => {
  const rng = makeRng(77);
  for (let round = 0; round < 40; round++) {
    const len = 1 + rng.int(60);
    const cond = Array.from({ length: len }, () => (rng.next() < 0.08 ? N : rng.next() < 0.5 ? 1 : 0));
    const n = 1 + rng.int(12);
    assert.deepEqual(ind.count(cond, n), slowCount(cond, n), `${JSON.stringify(cond)} over ${n}`);
  }
});

test('for n bars holds when the condition held on each of the last n bars, within n bars on at least one', () => {
  const closes = [9, 9, 11, 9, 9, 9, 11, 9];
  assert.deepEqual(values('close > 10', closes), [0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(values('close > 10 within 3 bars', closes), [N, N, 1, 1, 1, 0, 1, 1]);
  assert.deepEqual(values('close > 10 for 1 bar', closes), [0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(values('close < 10 for 2 bars', closes), [N, 1, 0, 0, 1, 1, 0, 0]);
  assert.deepEqual(values('close < 10 for 3 bars', closes), [N, N, 0, 0, 0, 1, 0, 0]);
  assert.deepEqual(values('count(close > 10, 3) >= 1', closes), values('close > 10 within 3 bars', closes));
  assert.deepEqual(values('count(close < 10, 3) == 3', closes), values('close < 10 for 3 bars', closes));
  // The word "bar" does for one bar, and bars is read the same.
  assert.deepEqual(values('close > 10 within 1 bars', closes), values('close > 10 within 1 bar', closes));
});

test('a window is read from its own bars, so a condition about a bar before this one counts the same', () => {
  // close > close[1] on 3 8 4 5 6 7: unknown at bar 0, then 1 0 1 1 1.
  const closes = [3, 8, 4, 5, 6, 7];
  assert.deepEqual(values('close > close[1]', closes), [N, 1, 0, 1, 1, 1]);
  assert.deepEqual(values('close > close[1] for 3 bars', closes), [N, N, N, 0, 0, 1]);
  assert.deepEqual(values('close > close[1] within 2 bars', closes), [N, N, 1, 1, 1, 1]);
  assert.deepEqual(values('count(close > close[1], 4) >= 3', closes), [N, N, N, N, 1, 1]);
});

test('a window binds at the comparison; brackets apply it to more', () => {
  assert.deepEqual(exprOf('close > 1 and rsi(2) < 5 for 3 bars'), exprOf('close > 1 and count(rsi(2) < 5, 3) == 3'));
  assert.deepEqual(exprOf('(close > 1 and rsi(2) < 5) for 3 bars'), exprOf('count(close > 1 and rsi(2) < 5, 3) == 3'));
  assert.deepEqual(exprOf('not close > 1 within 3 bars'), exprOf('not count(close > 1, 3) >= 1'));
  assert.deepEqual(exprOf('close > 1 for 3 bars or rsi(2) < 5 within 2 bars'), exprOf('count(close > 1, 3) == 3 or count(rsi(2) < 5, 2) >= 1'));
  // A window over a window: the streak of 3 happened within the last 5 bars.
  assert.deepEqual(exprOf('close > 1 for 3 bars within 5 bars'), exprOf('count(count(close > 1, 3) == 3, 5) >= 1'));
  // A definition, a comparison with a number, an of and between: all conditions, so all take a window.
  assert.deepEqual(exprOf('rsi(2) between 10 and 30 for 2 bars'), exprOf('count(rsi(2) >= 10 and rsi(2) <= 30, 2) == 2'));
  assert.deepEqual(exprOf('close of A > 1 for 2 bars'), exprOf('count(close of A > 1, 2) == 2'));
  assert.deepEqual(exprOf('month_end within 25 bars'), exprOf('count(month_end, 25) >= 1'));
});

test('a window\'s n is a whole number from 1 to 10000, or a parameter that is one', () => {
  assert.equal(errorOf('close > 1 for 0 bars')[3], '"for" needs a whole number of bars from 1 to 10000, as in close > sma(200) for 3 bars');
  assert.equal(errorOf('close > 1 within 2.5 bars')[3], '"within" needs a whole number of bars from 1 to 10000, as in close > sma(200) within 3 bars');
  assert.equal(errorOf('close > 1 for 10001 bars')[3], '"for" needs a whole number of bars from 1 to 10000, as in close > sma(200) for 3 bars');
  assert.deepEqual(errorOf('close > 1 for -3 bars').slice(0, 1), [2]);
  assert.equal(errorOf('close > 1 for rsi(2) bars')[3], '"for" needs a whole number of bars from 1 to 10000, as in close > sma(200) for 3 bars');
  assert.deepEqual(errorOf('close > 1 for 0 bars').slice(1, 3), where('close > 1 for 0 bars', '0'));
  assert.equal(errorOf('close > 1 for 3')[3], 'Write "bars" after the number, as in close > sma(200) for 3 bars');
  assert.equal(errorOf('close > 1 for 3 days')[3], 'Write "bars" after the number, as in close > sma(200) for 3 bars');
  assert.equal(errorOf('close for 3 bars')[3], '"for" needs a condition before it, as in close > sma(200) for 3 bars');
});

test('a parameter can give the number of bars, and its range counts at its widest for the history', () => {
  const spec = ruleOf('close > sma(50) for n bars', 'n = 3 in 3..399 step 3\nfrom: 2020-01-01\n');
  assert.deepEqual(spec.written!.rules.A.buy!.params, ['n']);
  assert.equal(lookbackBars(spec), 50 + 399);
  assert.equal(lookbackBars(ruleOf('close > sma(50) for 399 bars', 'from: 2020-01-01\n')), 50 + 399);
  assert.equal(lookbackBars(ruleOf('count(close > sma(50), n) > 2', 'n = 3 in 3..399 step 3\nfrom: 2020-01-01\n')), 50 + 399);
  // A value of the parameter that is not whole is the same mistake as a number that is not.
  assert.match(errorOf('close > 1 for n bars', 'n = 2.5\n')[3], /^"for" needs a whole number of bars/);
  // A strategy trades the same with the parameter as with its number, so the ledger counts them as one.
  assert.equal(trialHash(ruleOf('close > sma(50) for n bars', 'n = 3\nfrom: 2020-01-01\n')), trialHash(ruleOf('close > sma(50) for 3 bars', 'from: 2020-01-01\n')));
  // Set from outside, it reaches the window.
  const set = parseSpec('universe: A\nn = 3 in 2..6\nbuy when close > 1 for n bars', { overrides: { n: 5 } }).spec!;
  assert.deepEqual((set.rules.A.buy as Extract<Expr, { k: 'cmp' }>).b, { k: 'num', v: 5 });
});

test('count written out: a condition and a number of bars, in the places a function can stand', () => {
  assert.equal(errorOf('count(close > 1)')[3], 'count() takes a condition and a number of bars, as in count(close > close[1], 10)');
  assert.equal(errorOf('count(close > 1, 2, 3) > 1')[3], 'count() takes a condition and a number of bars, as in count(close > close[1], 10)');
  assert.equal(errorOf('count(close, 3) > 1')[3], 'count() needs a condition, not a number, as in count(close > close[1], 10)');
  assert.match(errorOf('count(close > 1, 0) > 1')[3], /^count\(\): 0 is not a valid period/);
  assert.match(errorOf('count(close > 1, rsi(2)) > 1')[3], /^count\(\) periods must be plain numbers/);
  assert.deepEqual(errorOf('count(close > 1, 3)'), [2, ...where('count(close > 1, 3)', 'count(close > 1, 3)'), 'A rule needs a condition, such as close > sma(200)']);
  const e = exprOf('count(close > close[1], 10) >= 7') as Extract<Expr, { k: 'cmp' }>;
  assert.deepEqual(e.a, { k: 'ind', fn: 'count', src: { k: 'cmp', op: '>', a: { k: 'series', name: 'close' }, b: { k: 'lag', a: { k: 'series', name: 'close' }, n: 1 } }, args: [10] });
  // The score of a ranking can count too.
  assert.ok(parseSpec('universe: A, B\nhold: top 1 by count(close > open, 20)').spec);
});

test('a position value cannot be read over a window, and the error says so at the window', () => {
  const rule = 'bars held > 3 for 2 bars';
  const [line, from, to, message] = (() => {
    const { errors } = parseSpec(`universe: A\nbuy when true\nsell when ${rule}`);
    assert.equal(errors.length, 1);
    return [errors[0].line, errors[0].from, errors[0].to, errors[0].message];
  })();
  assert.deepEqual([line, from, to], [3, 10, 34]);
  assert.equal(message, '"bars held" can\'t be read over several bars: it only exists for the open position at this bar. Read it outside the window, as in sell when bars held > 5 and close < sma(20) for 3 bars');
  const inside = parseSpec('universe: A\nbuy when true\nsell when count(entry price > 1, 3) > 1').errors;
  assert.deepEqual(inside.map((e) => e.message), ['"entry price" can\'t go inside count(): it only exists while a position is open']);
  assert.deepEqual(parseSpec('universe: A\nbuy when true\nsell when bars held > 3 and close > 1 for 2 bars').errors, []);
  assert.match(parseSpec('universe: A\nbuy when true\nsell when (position return > 1) within 4 bars').errors[0].message, /"position return" can't be read over several bars/);
});

test('words that can open a window or a range are not names a parameter can take', () => {
  for (const word of ['between', 'within', 'count']) {
    const { errors } = parseSpec(`universe: A\n${word} = 5\nbuy when close > sma(5)`);
    assert.match(errors[0].message, new RegExp(`"${word}" is a built-in name`));
  }
  // A "for" inside a rule is not a section: it needs a number of bars, and a line that ends in a colon is the section.
  assert.deepEqual(parseSpec('universe: A\nbuy when close > sma(20)\n  for 3 bars\nsell when close < 1').errors, []);
  const joined = parseSpec('universe: A\nbuy when close > sma(20)\n  for 3 bars\nsell when close < 1').spec!;
  assert.equal(joined.written!.rules.A.buy!.text, 'close > sma(20) for 3 bars');
  assert.deepEqual(parseSpec('universe: A\nbuy when close > sma(20)\nfor A:\n  sell when close < 1').errors, []);
});

// ---------------------------------------------------------------- a window over a column with a gap

test('an unknown bar makes every window that holds it unknown, and the rule does not fire there', () => {
  const b = bars([10, 11, 12, 13, 14, 15, 16, 17]);
  b.columns = [{ name: 'score', header: 'score', v: [1, 1, N, 1, 1, 1, 0, 1] }];
  const rule = 'column(score) > 0 for 2 bars';
  const spec = parseSpec(`universe: csv:Data/A.csv\nbuy when ${rule}`).spec!;
  const got = new Evaluator(new Map([['A', b]])).eval(spec.rules.A.buy, 'A');
  assert.deepEqual(got, [N, 1, N, N, 1, 1, 0, 0]);
  const within = parseSpec('universe: csv:Data/A.csv\nbuy when column(score) > 0 within 2 bars').spec!;
  assert.deepEqual(new Evaluator(new Map([['A', b]])).eval(within.rules.A.buy, 'A'), [N, 1, N, N, 1, 1, 1, 1]);
});

// ---------------------------------------------------------------- what the table and the explanation say

test('the table and the explanation show a window as written, with the count it rests on', () => {
  const A = bars([9, 11, 12, 12, 15, 9, 9, 9], { opens: [9, 9, 11, 12, 12, 15, 9, 9] });
  const spec = parseSpec('universe: A\ncapital: 1000\nbuy when close > 10 for 2 bars\nsell when close < 10 within 2 bars').spec!;
  const bt = runBacktest(spec, new Map([['A', A]]));
  const [t] = bt.run.trades;
  // Day 2 closes the second bar above 10: the buy fills at day 3's open, 12. Day 5 closes below 10: out at day 6's open.
  assert.deepEqual([t.entryPrice, t.exitPrice, t.exitT], [12, 9, A.t[6]]);
  const ex = explainTrade(bt, t);
  const rows = (id: 'bought' | 'sold') => ex.sections.find((s) => s.id === id)!.rows.map((r) => [r.label, r.value, r.outcome]);
  assert.deepEqual(rows('bought')[1], ['buy when close > 10 for 2 bars', 'count(close > 10, 2) 2 = 2', 'yes']);
  assert.deepEqual(rows('sold')[1], ['sell when close < 10 within 2 bars', 'count(close < 10, 2) 1 ≥ 1', 'yes']);
  const cols = debugColumns(bt, 'A');
  assert.deepEqual(cols.filter((c) => c.group === 'buy').map((c) => [c.kind, c.heading, c.op]), [['test', 'close > 10 for 2 bars', '=']]);
  const rowsOf = debugRows(bt, 'A', 0, debugRange(bt, 'A').count);
  const buyCol = cols.findIndex((c) => c.group === 'buy');
  assert.deepEqual(rowsOf.map((r) => r.cells[buyCol].outcome), ['unknown', 'no', 'yes', 'yes', 'yes', 'no', 'no', 'no']);
  assert.equal(cellText(cols[buyCol], rowsOf[2].cells[buyCol]).main, '2 = 2');
});

test('the unknown start of a window says why in the table', () => {
  const A = bars([9, 11, 12, 12, 15, 9, 9, 9]);
  const bt = runBacktest(parseSpec('universe: A\nbuy when close > 10 for 3 bars').spec!, new Map([['A', A]]));
  const cols = debugColumns(bt, 'A');
  const rows = debugRows(bt, 'A', 0, 3);
  assert.equal(cellText(cols[0], rows[1].cells[0]).detail, 'fewer than 3 bars so far');
});
