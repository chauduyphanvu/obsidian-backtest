// Named definitions: `name = expression`, a name for a condition or a number that stands for its expression where used.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { debugColumns, debugRange, debugRows } from '../src/debug.ts';
import { parseSpec, walk, type Expr, type ParseOptions } from '../src/dsl.ts';
import { explainTrade } from '../src/explain.ts';
import { trialHash } from '../src/ledger.ts';
import { lookbackBars } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { bars } from './helpers.ts';
import { walkBars } from './trigger-helpers.ts';

const parse = (src: string, opts?: ParseOptions) => parseSpec(src, opts);
const ok = (src: string, opts?: ParseOptions) => {
  const { spec, errors } = parse(src, opts);
  assert.deepEqual(errors, [], src);
  return spec!;
};
const errorsOf = (src: string) => parse(src).errors;
/** The one error of a block, with where it is: [line, from, to, message]. */
const only = (src: string): [number, number | undefined, number | undefined, string] => {
  const { errors } = parse(src);
  assert.equal(errors.length, 1, `${src}: ${JSON.stringify(errors)}`);
  return [errors[0].line, errors[0].from, errors[0].to, errors[0].message];
};

// ---------------------------------------------------------------- what is a definition

test('a line whose value is not a number is a definition, and a number or a range stays a parameter', () => {
  const spec = ok('universe: SPY\nfast = 50\nslow = 200 in 100..300 step 50\nlimit = -3%\nuptrend = close > sma(slow)\nbuy when uptrend and rsi(2) < fast');
  assert.deepEqual(spec.params.map((p) => p.name), ['fast', 'slow', 'limit']);
  // A number that starts a longer expression is a definition too.
  const spec2 = ok('universe: SPY\nhalf = 0.5 * close\nbuy when close > half');
  assert.deepEqual(spec2.params, []);
  assert.deepEqual(spec2.rules.SPY.buy, { k: 'cmp', op: '>', a: { k: 'series', name: 'close' }, b: { k: 'bin', op: '*', a: { k: 'num', v: 0.5 }, b: { k: 'series', name: 'close' } } });
});

test('a value that starts like a range but is not one keeps the parameter messages', () => {
  assert.match(errorsOf('universe: SPY\nx = 50 in\nbuy when close > sma(20)')[0].message, /Write a parameter as x = 50/);
  assert.match(errorsOf('universe: SPY\nx = 50 in 20..\nbuy when close > sma(20)')[0].message, /Write a parameter as x = 50/);
  assert.match(errorsOf('universe: SPY\nx = 5 in 20..100\nbuy when close > sma(20)')[0].message, /5 is outside the range 20..100/);
  // An empty value is a parameter's mistake too.
  assert.match(errorsOf('universe: SPY\nx =\nbuy when close > sma(20)')[0].message, /Write a parameter as x = 50/);
});

test('the same condition through a definition and written out is one strategy, in rules, score and nesting', () => {
  const defined = ok(
    [
      'universe: SPY, QQQ, TLT',
      'hold: top 2 by score',
      'score = roc(63) - roc(21)',
      'dip = rsi(2) < 10',
      'up = close > sma(200)',
      'calm = up and stdev(20) / close < 2%',
      'buy when calm and dip',
      'sell when not up or up of SPY == false or up[1] and bars held > 5',
    ].join('\n'),
  );
  const plain = ok(
    [
      'universe: SPY, QQQ, TLT',
      'hold: top 2 by roc(63) - roc(21)',
      'buy when (close > sma(200) and stdev(20) / close < 2%) and rsi(2) < 10',
      'sell when not close > sma(200) or (close > sma(200)) of SPY == false or (close > sma(200))[1] and bars held > 5',
    ].join('\n'),
  );
  assert.deepEqual(defined.rules, plain.rules);
  assert.deepEqual(defined.rank, plain.rank);
  assert.equal(trialHash(defined), trialHash(plain));
  const data = new Map(['SPY', 'QQQ', 'TLT'].map((n, i) => [n, walkBars(400, 31 + i)]));
  const [a, b] = [runBacktest(defined, data), runBacktest(plain, data)];
  assert.deepEqual(a.run.equity, b.run.equity);
  assert.deepEqual(a.run.trades.map((t) => [t.asset, t.entryT, t.exitT, t.entryPrice, t.exitPrice]), b.run.trades.map((t) => [t.asset, t.entryT, t.exitT, t.entryPrice, t.exitPrice]));
  assert.ok(a.run.trades.length > 0);
});

test('definitions can sit anywhere, use parameters and each other in any order, and be used before they are written', () => {
  const spec = ok('universe: SPY\nbuy when strong\nstrong = up and rsi(n) > limit\nn = 14 in 5..20\nup = close > sma(n)\nlimit = 50\nsell when not strong');
  assert.deepEqual(spec.params.map((p) => p.name), ['n', 'limit']);
  assert.deepEqual(spec.written!.rules.SPY.buy!.params.sort(), ['limit', 'n']);
  // A parameter's value, set from outside, reaches into every definition that reads it.
  const other = ok('universe: SPY\nbuy when strong\nstrong = rsi(n) > 50\nn = 14 in 5..20', { overrides: { n: 7 } });
  assert.deepEqual((other.rules.SPY.buy as Extract<Expr, { k: 'cmp' }>).a, { k: 'ind', fn: 'rsi', src: { k: 'series', name: 'close' }, args: [7], params: ['n'] });
});

test('a definition continues over several lines, like a rule', () => {
  const spec = ok('universe: SPY\ntrend = close > sma(200)\n  and rsi(14) > 50\n  and volume > 0\nbuy when trend');
  assert.equal((spec.rules.SPY.buy as Extract<Expr, { k: 'logic' }>).op, 'and');
  assert.equal(spec.written!.rules.SPY.buy!.text, 'trend');
});

// ---------------------------------------------------------------- how a use is checked

test('a position value in a definition is checked where the definition is used, and the error names the definition', () => {
  const src = (rule: string) => `universe: SPY\nheld = bars held > 3\nsince = held and entry price > 0\nbuy when close > sma(5)\n${rule}`;
  assert.deepEqual(errorsOf(src('sell when held')), []);
  assert.deepEqual(errorsOf(src('sell when since')), []);
  const [line, from, to, message] = only('universe: SPY\nheld = bars held > 3\nbuy when held');
  assert.deepEqual([line, from, to], [3, 9, 13]);
  assert.equal(message, '"held" reads "bars held", which only makes sense in a sell, cover or add rule');
  // Through another definition the use in the rule is blamed, not the inside of the first.
  const [l2, f2, t2, m2] = only('universe: SPY\nheld = bars held > 3\nsince = held and close > 1\nshort when since');
  assert.deepEqual([l2, f2, t2], [4, 11, 16]);
  assert.equal(m2, '"since" reads "bars held", which only makes sense in a sell, cover or add rule');
  assert.match(only('universe: SPY\nstale = highest since entry > 5\nbuy when stale')[3], /^"stale" reads "highest since entry"/);
  // The hold score has no position either.
  assert.match(only('universe: SPY, QQQ\nr = position return\nhold: top 1 by r')[3], /^"r" reads "position return"/);
  // A cover rule and an add rule do have one.
  assert.deepEqual(errorsOf('universe: SPY\nentries: 2\nheld = bars held > 3\nshort when close < sma(5)\ncover when held\nbuy when close > sma(5)\nadd when held'), []);
});

test('a definition that reads a position value cannot be read for an earlier bar, with "of", or over a window', () => {
  assert.match(errorsOf('universe: SPY\nheld = bars held > 3\nbuy when true\nsell when held[1]')[0].message, /"bars held" can't be read for an earlier bar with \[n\]/);
  assert.match(errorsOf('universe: SPY, QQQ\nheld = bars held > 3\nbuy when true\nsell when held of QQQ')[0].message, /"bars held" belongs to the open position, so it can't be read with "of"/);
  assert.match(errorsOf('universe: SPY\nheld = bars held > 3\nbuy when true\nsell when held for 2 bars')[0].message, /"bars held" can't be read over several bars/);
});

test('a definition cannot stand where a period, a lag, a window or a setting wants a plain number', () => {
  const at = (rule: string, extra = '') => only(`universe: SPY\nn = (5)\nm = rsi(2)\n${extra}buy when ${rule}`);
  assert.equal(at('close > sma(close, n)')[3], '"n" is a definition, and sma() needs a plain number for its period. Declare it as a parameter instead, as in n = 20');
  assert.match(at('close > sma(m)')[3], /^sma\(\) needs a period/);
  assert.match(at('close[n] > 1')[3], /^"n" is a definition, and bars ago must be a whole number or a parameter/);
  assert.match(at('close > 1 for n bars')[3], /^"n" is a definition, and the number of bars must be a number or a parameter/);
  assert.match(at('count(close > 1, n) > 2')[3], /^"n" is a definition, and count\(\) needs a plain number for its period/);
  assert.equal(at('close > 1', 'stop loss: n\n')[3], '"n" is a definition, and stop loss needs a percentage or a parameter. Declare it as a parameter instead, as in n = 10%');
  assert.match(at('close > 1', 'entries: n\n')[3], /^"n" is a definition, and entries needs a number or a parameter/);
  // The error is where the name is written.
  assert.deepEqual(at('close > sma(close, n)').slice(0, 3), [4, 28, 29]);
});

test('a syntax error inside a definition is reported once, on its own line, and its uses say nothing more', () => {
  const { errors } = parse('universe: SPY\nup = close > sma(\nbuy when up and up\nsell when not up');
  assert.deepEqual(errors.map((e) => [e.line, e.from, e.to, e.message]), [[2, 16, 17, 'The rule ends too early']]);
  // Another definition built on it is not blamed either.
  const more = parse('universe: SPY\nup = close > smaa(10)\ndown = not up\nbuy when down');
  assert.deepEqual(more.errors.map((e) => [e.line, e.message.slice(0, 27)]), [[2, 'Unknown name "smaa". Series']]);
  assert.equal(more.errors[0].from, 13);
  // A bad character is reported where it is, once.
  assert.deepEqual(parse('universe: SPY\nup = close > $5\nbuy when up').errors.map((e) => [e.line, e.from, e.message]), [[2, 13, 'Unexpected character "$"']]);
});

test('a definition that refers to itself, directly or through others, is an error on its line', () => {
  const direct = parse('universe: SPY\na = a + 1\nbuy when a > 1').errors;
  assert.deepEqual(direct.map((e) => [e.line, e.from, e.to, e.message]), [[2, 4, 5, '"a" uses itself. A definition can only be built from other names, as in a = close > sma(200)']]);
  const loop = parse('universe: SPY\na = b + 1\nb = c + 1\nc = a + 1\nd = c\nbuy when d > 1').errors;
  assert.deepEqual(loop.map((e) => [e.line, e.from, e.message.slice(0, 36)]), [
    [2, 4, '"a" leads back to itself through b. '],
    [3, 4, '"b" leads back to itself through c. '],
    [4, 4, '"c" leads back to itself through a. '],
  ]);
  // The words of a position value are not names: a definition called held can read bars held.
  assert.deepEqual(errorsOf('universe: SPY\nheld = bars held > 3\nprice = entry price * 1.1\nbuy when true\nsell when held or close > price'), []);
});

test('definitions made of definitions cannot grow a rule without bound', () => {
  const lines = ['universe: SPY', 'a0 = close > 1'];
  for (let i = 1; i <= 20; i++) lines.push(`a${i} = a${i - 1} and a${i - 1}`);
  lines.push('buy when a20');
  const { errors } = parse(lines.join('\n'));
  assert.ok(errors.length >= 1 && errors.every((e) => /too big once its definitions are filled in|too deeply/.test(e.message)), JSON.stringify(errors));
  // A reasonable chain is fine.
  assert.deepEqual(errorsOf('universe: SPY\na = close > 1\nb = a and a\nc = b and b\nbuy when c'), []);
});

// ---------------------------------------------------------------- names

test('a name follows the parameter rules: not a word of the language, once, whatever the case', () => {
  assert.match(only('universe: SPY\nclose = close > 1\nbuy when true')[3], /"close" is a built-in name/);
  assert.match(only('universe: SPY\nbetween = close > 1\nbuy when true')[3], /"between" is a built-in name/);
  assert.match(only('universe: SPY\nx = close > 1\nX = close > 2\nbuy when x')[3], /"X" is declared twice/);
  assert.deepEqual(only('universe: SPY\nup = close > 1\nup = 5\nbuy when up')[0], 3);
  assert.match(only('universe: SPY\nup = 5\nUp = close > 1\nbuy when close > up')[3], /"Up" is declared twice/);
  // Names do not care about capital letters where they are used.
  assert.deepEqual(errorsOf('universe: SPY\nUpTrend = close > sma(200)\nbuy when uptrend and UPTREND'), []);
  // A definition has no value to set from outside.
  assert.match(errorsOf('universe: SPY\nup = close > 1\nbuy when up')[0]?.message ?? 'none', /none/);
  assert.match(parse('universe: SPY\nup = close > 1\nbuy when up', { overrides: { up: 3 } }).errors[0].message, /There is no parameter "up" to set/);
});

test('a definition no rule or score reads gives a note, and so does one only another unused one reads', () => {
  const { spec, errors, warnings } = parse('universe: SPY\nup = close > sma(200)\nbuy when close > sma(50)');
  assert.ok(spec);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.map((w) => [w.line, w.from, w.to, w.message]), [[2, 0, 2, '"up" is defined but no rule or score reads it. Use it, as in buy when up, or remove the line']]);
  const chained = parse('universe: SPY\nup = close > sma(200)\nboth = up and rsi(2) < 5\nbuy when close > 1').warnings;
  assert.deepEqual(chained.filter((w) => /defined/.test(w.message)).map((w) => w.line), [2, 3]);
  // A number says how to use it.
  assert.match(parse('universe: SPY\ngap = close - open\nbuy when close > 1').warnings[0].message, /as in buy when gap > 0/);
  // Used in the hold score, or only in a section's rule, it is read.
  assert.deepEqual(parse('universe: SPY, QQQ\ns = roc(20)\nhold: top 1 by s').warnings.filter((w) => /defined/.test(w.message)), []);
  assert.deepEqual(parse('universe: SPY, QQQ\nup = close > 1\nbuy when true\nfor QQQ:\n  sell when up').warnings.filter((w) => /defined/.test(w.message)), []);
  // With a problem elsewhere nothing is said about what was not read.
  assert.deepEqual(parse('universe: SPY\nup = close > 1\nbuy when nope').warnings, []);
});

test('the price warning belongs to the use, where the price meets the number', () => {
  const w = parse('universe: SPY\nlevel = close > 100\nbuy when level').warnings;
  assert.deepEqual(w.map((x) => [x.line, x.from, x.to]), [[2, 8, 19]]);
  assert.match(w[0].message, /compares a price with a fixed number/);
  // Read by no rule, the comparison warns of nothing: only the definition does, for being unused.
  assert.deepEqual(parse('universe: SPY\nlevel = close > 100\nbuy when true').warnings.map((x) => /is defined but no rule/.test(x.message)), [true]);
});

// ---------------------------------------------------------------- what the rule table and the explanation show

test('Written.parts has a text for every node, with a definition shown by its name and its parts by their own text', () => {
  const spec = ok('universe: SPY\nup = close > sma(200)\ngap = close / sma(20) - 1\nbuy when up and gap < -3%');
  const w = spec.written!.rules.SPY.buy!;
  assert.equal(w.text, 'up and gap < -3%');
  let nodes = 0;
  walk(spec.rules.SPY.buy, () => nodes++);
  assert.equal(w.parts.length, nodes);
  assert.deepEqual(w.parts, ['up and gap < -3%', 'up', 'close', 'sma(200)', '', 'gap < -3%', 'gap', 'close / sma(20)', 'close', 'sma(20)', '', '1', '-3%', '3%']);
  // Used twice, in a lag and with of, each use is its name and the nodes beneath keep the definition's text.
  const more = ok('universe: SPY, QQQ\nup = close > sma(200)\nbuy when up[1] and up of QQQ').written!.rules.SPY.buy!.parts;
  assert.deepEqual(more, ['up[1] and up of QQQ', 'up[1]', 'up', 'close', 'sma(200)', '', 'up of QQQ', 'up', 'close', 'sma(200)', '']);
});

test('Written.parts stays one text for each node of the tree, whatever a rule is made of', () => {
  const rules = [
    'up and dip',
    'up[1] and dip of QQQ',
    'band for 3 bars or not band within 2 bars',
    'rsi(2) between 10 and 30 and (close crosses sma(5)) for 2 bars',
    'count(up and dip, 4) >= 2 and gap between -2% and 2%',
    'not (band and up) for 3 bars',
    'gap < -3% and up of QQQ == false',
    'close[2] - 1 between gap and 2 * gap',
  ];
  const defs = 'universe: SPY, QQQ\nup = close > sma(200)\ndip = rsi(2) < 10\ngap = close / sma(20) - 1\nband = gap between -3% and 3%\n';
  for (const rule of rules) {
    const spec = ok(`${defs}buy when ${rule}`);
    let nodes = 0;
    walk(spec.rules.SPY.buy, () => nodes++);
    const w = spec.written!.rules.SPY.buy!;
    assert.equal(w.parts.length, nodes, rule);
    assert.equal(w.parts[0], rule);
    assert.ok(w.parts.every((p) => typeof p === 'string'));
  }
});

const wave = (n: number): number[] => Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 7) * 10 + i * 0.05);

test('the rule table has a column for a definition by its name, opening into its parts when it joins conditions', () => {
  const src = 'universe: A\nup = close > sma(20) and rsi(5) > 40\ndip = rsi(2) < 30\nbuy when up and dip\nsell when not up';
  const spec = ok(src);
  const bt = runBacktest(spec, new Map<string, Bars>([['A', bars(wave(160))]]));
  const cols = debugColumns(bt, 'A').map((c) => [c.group, c.depth, c.text]);
  assert.deepEqual(cols.filter((c) => c[0] === 'buy'), [
    ['buy', 1, 'up'],
    ['buy', 2, 'close > sma(20)'],
    ['buy', 2, 'rsi(5) > 40'],
    ['buy', 1, 'dip'],
    ['buy', 0, 'up and dip'],
  ]);
  assert.deepEqual(cols.filter((c) => c[0] === 'sell').map((c) => c[2]), ['up', 'close > sma(20)', 'rsi(5) > 40', 'not up']);
  const rows = debugRows(bt, 'A', 0, debugRange(bt, 'A').count);
  // The column of a definition says what the plain expression says.
  const plain = runBacktest(ok('universe: A\nbuy when (close > sma(20) and rsi(5) > 40) and rsi(2) < 30\nsell when not (close > sma(20) and rsi(5) > 40)'), new Map<string, Bars>([['A', bars(wave(160))]]));
  const plainRows = debugRows(plain, 'A', 0, debugRange(plain, 'A').count);
  assert.deepEqual(rows.map((r) => [r.buy, r.sell]), plainRows.map((r) => [r.buy, r.sell]));
  assert.ok(rows.some((r) => r.buy === 'yes'));
});

test('explaining a trade shows the definition by its name, with its parts below, and lists the parameters inside it', () => {
  const A = bars([10, 12, 12, 15, 9, 9, 9], { opens: [10, 10, 12, 12, 15, 9, 9] });
  const spec = ok('universe: A\ncapital: 1000\nlimit = 10 in 5..15\nbig = close > limit and volume > 0\nbuy when big\nsell when not big');
  const bt = runBacktest(spec, new Map([['A', A]]));
  const ex = explainTrade(bt, bt.run.trades[0]);
  const rows = ex.sections.find((s) => s.id === 'bought')!.rows.map((r) => [r.label, r.value, r.outcome, r.depth]);
  assert.deepEqual(rows, [
    ['The buy rule was read at the close of 2020-01-02.', '', null, 0],
    ['buy when big', 'all of these must hold', 'yes', 0],
    ['close > limit', 'close 12 > limit 10', 'yes', 1],
    ['volume > 0', 'volume 1,000 > 0', 'yes', 1],
    ['Parameters', 'limit = 10', null, 0],
  ]);
  // Where it is used under a not, its name is a row of its own and its parts sit below it.
  const sold = ex.sections.find((s) => s.id === 'sold')!.rows.map((r) => [r.label, r.outcome, r.depth]);
  assert.deepEqual(sold.slice(1, 5), [['sell when not big', 'yes', 0], ['big', 'no', 1], ['close > limit', 'no', 2], ['volume > 0', 'yes', 2]]);
});

// ---------------------------------------------------------------- history

test('the history a rule needs counts what a definition stands for', () => {
  const plain = ok('universe: SPY\nfrom: 2015-01-01\nbuy when close > sma(300)');
  const defined = ok('universe: SPY\nfrom: 2015-01-01\nlong = sma(300)\nbuy when close > long');
  assert.equal(lookbackBars(defined), lookbackBars(plain));
  assert.ok(lookbackBars(defined) >= 300);
  const swept = ok('universe: SPY\nfrom: 2015-01-01\nn = 100 in 50..500 step 50\nlong = sma(n)\nbuy when close > long');
  assert.ok(lookbackBars(swept) >= 500);
});
