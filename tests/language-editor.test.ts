// What the editor does with the newer language: definitions, ranges and windows, lists on a `for` line and the position
// values that read the bars since the entry.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { complete } from '../src/complete.ts';
import { analyzeBlock } from '../src/diagnostics.ts';
import { docFor, helpAt } from '../src/docs.ts';
import { fixFor } from '../src/fixes.ts';
import { declaredDefinitions, declaredParams, lineKind, lineKinds, tokenizeBlock } from '../src/highlight.ts';
import { parseSpec } from '../src/dsl.ts';
import { SYSTEM_PROMPT } from '../src/llm.ts';
import { setParamValues } from '../src/rewrite.ts';

const BLOCK = [
  'universe: SPY, QQQ',
  'fast = 50 in 20..100 step 10',
  'uptrend = close > sma(200)',
  'stretch = close / sma(20) - 1',
  '  and volume > 0',
  'buy when uptrend and stretch < -3% for 3 bars',
  'sell when not uptrend or rsi(2) between 10 and 30',
  'for SPY, QQQ:',
  '  sell when position return > 20%',
];

const shown = (lines: string[], i: number) => tokenizeBlock(lines)[i].map((t) => `${t.kind}:${lines[i].slice(t.from, t.to)}`);
const labels = (above: string[], before: string, block = BLOCK) => complete(block, above, before)?.items.map((i) => i.label) ?? null;

// ---------------------------------------------------------------- lines and colours

test('a line of a name and a number is a parameter, and any other value makes it a definition', () => {
  const kinds = lineKinds(BLOCK);
  assert.deepEqual(kinds, ['setting', 'param', 'define', 'define', 'continuation', 'rule', 'rule', 'for', 'rule']);
  assert.deepEqual(['x = 5', 'x = 5 in 1..9', 'x = -3%', 'x = 5 * close', 'x = close > 1', 'x = 5 in', 'x ='].map((l) => lineKind(l, false)), ['param', 'param', 'param', 'define', 'define', 'param', 'param']);
  // A built-in name is neither.
  assert.equal(lineKind('close = 5', false), 'other');
  assert.equal(lineKind('between = close > 1', false), 'other');
  assert.deepEqual(declaredParams(BLOCK).map((p) => p.name), ['fast']);
  assert.deepEqual(declaredDefinitions(BLOCK), [
    { name: 'uptrend', value: 'close > sma(200)' },
    { name: 'stretch', value: 'close / sma(20) - 1 and volume > 0' },
  ]);
});

test('a definition is coloured like a parameter wherever its name is written', () => {
  assert.deepEqual(shown(BLOCK, 2), ['key:uptrend', 'series:close', 'operator:>', 'function:sma', 'operator:(', 'number:200', 'operator:)']);
  assert.deepEqual(shown(BLOCK, 3), ['key:stretch', 'series:close', 'operator:/', 'function:sma', 'operator:(', 'number:20', 'operator:)', 'operator:-', 'number:1']);
  assert.deepEqual(shown(BLOCK, 4), ['keyword:and', 'series:volume', 'operator:>', 'number:0']);
  assert.deepEqual(shown(BLOCK, 5), [
    'keyword:buy', 'keyword:when', 'param:uptrend', 'keyword:and', 'param:stretch', 'operator:<', 'operator:-', 'number:3%', 'keyword:for', 'number:3', 'keyword:bars',
  ]);
  assert.deepEqual(shown(BLOCK, 6).slice(0, 4), ['keyword:sell', 'keyword:when', 'keyword:not', 'param:uptrend']);
});

test('between, within, crosses, windows and the new position values are coloured as words of the language', () => {
  assert.deepEqual(shown(BLOCK, 6).slice(-8), ['function:rsi', 'operator:(', 'number:2', 'operator:)', 'keyword:between', 'number:10', 'keyword:and', 'number:30']);
  const line = (text: string) => tokenizeBlock([text])[0].map((t) => `${t.kind}:${text.slice(t.from, t.to)}`);
  assert.deepEqual(line('buy when close crosses sma(50)'), ['keyword:buy', 'keyword:when', 'series:close', 'keyword:crosses', 'function:sma', 'operator:(', 'number:50', 'operator:)']);
  assert.deepEqual(line('buy when close > 1 within 2 bars'), ['keyword:buy', 'keyword:when', 'series:close', 'operator:>', 'number:1', 'keyword:within', 'number:2', 'keyword:bars']);
  assert.deepEqual(line('buy when close > 1 for 1 bar'), ['keyword:buy', 'keyword:when', 'series:close', 'operator:>', 'number:1', 'keyword:for', 'number:1', 'keyword:bar']);
  assert.deepEqual(line('sell when close < highest since entry - 3 * atr(22)'), [
    'keyword:sell', 'keyword:when', 'series:close', 'operator:<', 'series:highest since entry', 'operator:-', 'number:3', 'operator:*', 'function:atr', 'operator:(', 'number:22', 'operator:)',
  ]);
  assert.deepEqual(line('sell when lowest_since_entry < position return'), ['keyword:sell', 'keyword:when', 'series:lowest_since_entry', 'operator:<', 'series:position return']);
  // Alone, highest and lowest are still functions, and position is no word.
  assert.deepEqual(line('buy when close > highest(20)[1] and position > 1').slice(4, 6), ['function:highest', 'operator:(']);
  assert.ok(!line('buy when position > 1').some((t) => t.startsWith('series:position')));
  // A window's count is a parameter's name when it is one.
  const withParam = ['n = 3 in 2..5', 'buy when close > 1 for n bars'];
  assert.deepEqual(shown(withParam, 1).slice(-3), ['keyword:for', 'param:n', 'keyword:bars']);
});

test('a for line colours each ticker of its list, and "all" as a keyword', () => {
  assert.deepEqual(shown(BLOCK, 7), ['keyword:for', 'ticker:SPY', 'ticker:QQQ']);
  assert.deepEqual(shown(['for  SPY ,QQQ  :   # c'], 0), ['keyword:for', 'ticker:SPY', 'ticker:QQQ', 'comment:# c']);
  assert.deepEqual(shown(['for all:'], 0), ['keyword:for', 'keyword:all']);
});

test('the diagnostics keep a definition\'s colours and put an error on its own line', () => {
  const lines = ['universe: SPY', 'up = close > smaa(10)', 'buy when up'];
  const { tokens, diagnostics } = analyzeBlock(lines);
  assert.deepEqual(diagnostics.map((d) => [d.line, d.from, d.to, d.severity]), [[1, 13, 17, 'error']]);
  assert.ok(tokens[1].some((t) => t.kind === 'key') && tokens[2].some((t) => t.kind === 'param'));
});

// ---------------------------------------------------------------- hover help

test('hovering a definition shows its text, wherever its name is written', () => {
  const declared = helpAt(BLOCK, 2, 2)!;
  assert.deepEqual([declared.doc.kind, declared.doc.signature, declared.doc.short], ['definition', 'uptrend = close > sma(200)', 'definition: close > sma(200)']);
  assert.equal(declared.doc.text, 'Your definition. Wherever you write uptrend, it means close > sma(200).');
  const used = helpAt(BLOCK, 5, BLOCK[5].indexOf('uptrend') + 3)!;
  assert.deepEqual([used.from, used.to, used.doc.id], [BLOCK[5].indexOf('uptrend'), BLOCK[5].indexOf('uptrend') + 7, 'uptrend']);
  // A definition over several lines shows all of them.
  assert.equal(helpAt(BLOCK, 5, BLOCK[5].indexOf('stretch'))!.doc.short, 'definition: close / sma(20) - 1 and volume > 0');
  // A parameter is still a parameter.
  assert.equal(helpAt(BLOCK, 1, 1)!.doc.kind, 'parameter');
});

test('hovering the new words shows their help', () => {
  const id = (row: number, word: string, plus = 0) => helpAt(BLOCK, row, BLOCK[row].indexOf(word) + plus)?.doc.id;
  assert.equal(id(5, 'for 3'), 'for … bars');
  assert.equal(id(6, 'between'), 'between');
  assert.equal(id(7, 'for'), 'for');
  assert.equal(id(8, 'position return', 3), 'position return');
  const line = ['buy when close crosses sma(50) and rsi(2) < 5 within 3 bars', 'sell when highest_since_entry > lowest since entry'];
  assert.equal(helpAt(line, 0, line[0].indexOf('crosses'))!.doc.id, 'crosses');
  assert.equal(helpAt(line, 0, line[0].indexOf('within'))!.doc.id, 'within');
  assert.equal(helpAt(line, 1, line[1].indexOf('highest_since_entry'))!.doc.id, 'highest since entry');
  assert.equal(helpAt(line, 1, line[1].indexOf('lowest since entry') + 8)!.doc.id, 'lowest since entry');
  assert.deepEqual(docFor('count')!.signature, 'count(condition, n)');
});

// ---------------------------------------------------------------- completion

test('inside a rule a definition is offered with its text, and so are the new words', () => {
  const found = complete(BLOCK, [], 'buy when upt')!;
  assert.deepEqual(found.items.map((i) => [i.label, i.insert, i.detail]), [['uptrend', 'uptrend', 'definition: close > sma(200)']]);
  assert.deepEqual(labels([], 'buy when str'), ['stretch']);
  // In another definition too, before or after it is written.
  assert.deepEqual(labels([], 'dip = upt'), ['uptrend']);
  assert.deepEqual(labels([], 'buy when close > 1 betw'), ['between']);
  assert.deepEqual(labels([], 'buy when close > 1 with'), ['within']);
  assert.deepEqual(labels([], 'buy when close > 1 f'), ['fast', 'for']);
  assert.deepEqual(labels([], 'buy when close cros'), ['crosses', 'crosses above', 'crosses below']);
  assert.deepEqual(labels([], 'buy when coun'), ['count']);
  assert.equal(complete(BLOCK, [], 'buy when coun')!.items[0].insert, 'count(');
  // Position values after a sell, cover or add head, and in a definition, not after a buy.
  assert.deepEqual(labels([], 'sell when highest s'), ['highest since entry']);
  assert.deepEqual(labels([], 'sell when posi'), ['position return']);
  assert.deepEqual(labels([], 'buy when posi'), null);
  assert.deepEqual(labels([], 'cover when lowest'), ['lowest since entry', 'lowest']);
  assert.deepEqual(labels([], 'held = position r'), ['position return']);
});

test('after a comma on a for line the tickers not listed yet are offered', () => {
  assert.deepEqual(labels([], 'for '), ['SPY', 'QQQ', 'all']);
  assert.deepEqual(labels([], 'for SPY, '), ['QQQ']);
  assert.deepEqual(labels([], 'for SPY, Q'), ['QQQ']);
  assert.equal(complete(BLOCK, [], 'for SPY, Q')!.items[0].insert, 'QQQ:');
  assert.deepEqual(labels([], 'for QQQ,SPY, '), null);
});

test('a definition line continues over the lines below it, like a rule', () => {
  assert.deepEqual(labels(['uptrend = close > 1'], '  and rs'), ['rsi']);
  assert.deepEqual(labels(['uptrend = close > 1', '  and rsi(2) < 5'], '  or vol'), ['volume']);
});

// ---------------------------------------------------------------- did you mean

test('a misspelt definition, and the word after "crosses", get a fix', () => {
  const fixed = (lines: string[]) => {
    const d = parseSpec(lines.join('\n')).errors[0];
    const f = fixFor(lines, d);
    assert.ok(f, `no fix for ${d.message}`);
    const out = [...lines];
    out[f.line - 1] = out[f.line - 1].slice(0, f.from) + f.insert + out[f.line - 1].slice(f.to);
    return out;
  };
  assert.equal(fixed(['universe: SPY', 'uptrend = close > sma(200)', 'buy when uptrnd'])[2], 'buy when uptrend');
  assert.equal(fixed(['universe: SPY', 'uptrend = close > sma(200)', 'stretch = uptrnd and volume > 0', 'buy when stretch'])[2], 'stretch = uptrend and volume > 0');
  assert.equal(fixed(['universe: SPY', 'buy when close crosses abov 1'])[1], 'buy when close crosses above 1');
  assert.equal(fixed(['universe: SPY', 'buy when close betwen 1 and 3'])[1], 'buy when close between 1 and 3');
  assert.equal(fixed(['universe: SPY, QQQ', 'buy when true', 'for SPY, QQQQ:', '  sell when close < 1'])[2], 'for SPY, QQQ:');
});

// ---------------------------------------------------------------- writing values back

test('a definition line is left alone when parameter values are written back, even if it starts with a number', () => {
  const text = ['universe: SPY', 'fast = 50 in 20..100 step 10', 'half = 0.5 * close', 'buy when close > half and rsi(2) < fast'].join('\n');
  assert.equal(setParamValues(text, { fast: 70, half: 2 }), ['universe: SPY', 'fast = 70 in 20..100 step 10', 'half = 0.5 * close', 'buy when close > half and rsi(2) < fast'].join('\n'));
  // Nothing in the Parameters bar is a definition: the spec lists parameters only.
  assert.deepEqual(parseSpec(text).spec!.params.map((p) => p.name), ['fast']);
});

// ---------------------------------------------------------------- the drafting prompt

test('the prompt teaches definitions, between, windows, count, either-way crosses, lists and the new position values', () => {
  for (const part of [
    /name = expression +a definition/,
    /uptrend = close > sma\(200\)/,
    /for SPY, QQQ:/,
    /rsi\(2\) between 10 and 30/,
    /"condition for 3 bars"/,
    /count\(condition, n\)/,
    /"crosses" alone means either way/,
    /highest since entry/,
    /lowest since entry/,
    /position return/,
    /uptrend of SPY == false/,
  ]) assert.match(SYSTEM_PROMPT, part);
});
