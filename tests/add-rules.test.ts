import assert from 'node:assert/strict';
import { test } from 'node:test';
import { complete } from '../src/complete.ts';
import { helpAt } from '../src/docs.ts';
import { parseSpec } from '../src/dsl.ts';
import { lineKinds, tokenizeBlock } from '../src/highlight.ts';

const BLOCK = [
  'universe: SPY, TLT',
  'entries: 3',
  'buy when close > sma(100)',
  'add when close > last entry price * 1.03',
  '  and entries made < 3',
  'sell when close < sma(100)',
  'for TLT:',
  '  add when entries made == 1 or last entry price > entry price',
  '    and bars held > 5',
];

const shown = (i: number, block = BLOCK) => tokenizeBlock(block)[i].map((t) => `${t.kind}:${block[i].slice(t.from, t.to)}`);
const labels = (above: string[], before: string, block = BLOCK) => complete(block, above, before)?.items.map((i) => i.label) ?? null;

test('the block used here is a real strategy with no warnings', () => {
  const { errors, warnings } = parseSpec(BLOCK.join('\n'));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('an add rule is a rule line, and its continuation lines continue it', () => {
  assert.deepEqual(lineKinds(BLOCK), ['setting', 'setting', 'rule', 'rule', 'continuation', 'rule', 'for', 'rule', 'continuation']);
  assert.deepEqual(lineKinds(['  ADD  WHEN close > 1']), ['rule']);
  // "add" alone, or a setting-like line, is still not a rule.
  assert.deepEqual(lineKinds(['add = 3', 'add something']), ['param', 'other']);
});

test('colouring: a shared add rule, its position values and its continuation line', () => {
  assert.deepEqual(shown(3), ['keyword:add', 'keyword:when', 'series:close', 'operator:>', 'series:last entry price', 'operator:*', 'number:1.03']);
  assert.deepEqual(shown(4), ['keyword:and', 'series:entries made', 'operator:<', 'number:3']);
});

test('colouring: an add rule in a for section reads all four position values', () => {
  assert.deepEqual(shown(7), [
    'keyword:add', 'keyword:when', 'series:entries made', 'operator:==', 'number:1', 'keyword:or', 'series:last entry price', 'operator:>', 'series:entry price',
  ]);
  assert.deepEqual(shown(8), ['keyword:and', 'series:bars held', 'operator:>', 'number:5']);
});

test('colouring: "add" is coloured only at the head of a rule, so it stays free as a parameter', () => {
  const lines = ['add = 3', 'entries: 3', 'buy when close > 1', 'add when close > add * last entry price'];
  const row = tokenizeBlock(lines)[3].map((t) => `${t.kind}:${lines[3].slice(t.from, t.to)}`);
  assert.deepEqual(row, ['keyword:add', 'keyword:when', 'series:close', 'operator:>', 'param:add', 'operator:*', 'series:last entry price']);
});

test('colouring: the three-word name needs all three words, and "last" alone is a parameter', () => {
  const line = 'sell when close > last and close > last entry price and entries   made > 1 and last  entry  price > 2';
  const row = tokenizeBlock(['last = 5', line])[1].map((t) => `${t.kind}:${line.slice(t.from, t.to)}`);
  assert.deepEqual(
    row.filter((x) => /^(param|series):(last|entries)/.test(x)),
    ['param:last', 'series:last entry price', 'series:entries   made', 'series:last  entry  price'],
  );
});

test('colouring: words that are keys of the table of pairs but not names are left alone', () => {
  const lines = ['sell when constructor > 1 and toString > 2 and entries > 3'];
  const row = tokenizeBlock(lines)[0].map((t) => `${t.kind}:${lines[0].slice(t.from, t.to)}`);
  assert.ok(!row.some((x) => x.startsWith('series:con') || x.startsWith('series:toS') || x.startsWith('series:entries')), row.join(' '));
});

test('completion on an add line offers what a sell line offers, and a buy line less', () => {
  for (const letter of 'abcdefghijklmnopqrstuvwxyz'.split('')) {
    assert.deepEqual(labels([], `add when ${letter}`), labels([], `sell when ${letter}`), letter);
  }
  assert.deepEqual(labels([], 'add when la'), ['last entry price']);
  assert.deepEqual(labels([], 'add when en'), ['entry price', 'entries made']);
  assert.equal(labels([], 'buy when la'), null);
  assert.equal(labels([], 'buy when en'), null);
});

test('completion: the head, the word "when", and an add line inside a for section', () => {
  assert.deepEqual(labels([], 'ad'), ['add when']);
  assert.deepEqual(labels([], 'add '), ['when']);
  const above = BLOCK.slice(0, 7);
  assert.deepEqual(labels(above, '  add when en'), ['entry price', 'entries made']);
  assert.deepEqual(labels(above, '  add when la'), ['last entry price']);
});

test('completion on a continuation line follows the rule it continues', () => {
  assert.deepEqual(labels(['add when close > 1'], '  and en'), ['entry price', 'entries made']);
  assert.deepEqual(labels(['add when close > 1'], '  or la'), ['last entry price']);
  assert.deepEqual(labels(['add when close > 1', '  and close < 5'], '  or en'), ['entry price', 'entries made']);
  // A buy rule after an add rule starts again, so its continuation reads no position values.
  assert.equal(labels(['add when close > 1', 'buy when close > 1'], '  or en'), null);
  assert.deepEqual(labels(['buy when close > 1', 'add when close > 1', 'sell when close > 1'], '  and la'), ['last entry price']);
  // And a buy rule's own continuation, after an add rule and a for section.
  assert.equal(labels(['add when close > 1', 'for TLT:', 'buy when close > 1'], '  and la'), null);
});

test('hover help names the add head and the new position values as one span each', () => {
  const at = (row: number, col: number) => helpAt(BLOCK, row, col);
  const head = BLOCK[3].indexOf('add');
  for (const col of [head, head + 2, head + 4, head + 7]) {
    const t = at(3, col)!;
    assert.deepEqual([t.doc.id, t.from, t.to], ['add when', 0, 8], `column ${col}`);
  }
  const last = BLOCK[3].indexOf('last entry price');
  for (const col of [last, last + 5, last + 15]) {
    const t = at(3, col)!;
    assert.deepEqual([t.doc.id, t.from, t.to], ['last entry price', last, last + 16], `column ${col}`);
  }
  const made = BLOCK[4].indexOf('entries made');
  for (const col of [made, made + 8, made + 11]) {
    const t = at(4, col)!;
    assert.deepEqual([t.doc.id, t.from, t.to], ['entries made', made, made + 12], `column ${col}`);
  }
  // In a for section, on the same names and on the older ones.
  assert.equal(at(7, 2)!.doc.id, 'add when');
  assert.equal(at(7, BLOCK[7].indexOf('entries made'))!.doc.id, 'entries made');
  assert.equal(at(7, BLOCK[7].indexOf('last entry price'))!.doc.id, 'last entry price');
  assert.equal(at(7, BLOCK[7].indexOf('entry price', BLOCK[7].indexOf('> ')))!.doc.id, 'entry price');
  assert.equal(at(8, BLOCK[8].indexOf('bars held'))!.doc.id, 'bars held');
  // The `for` word's help now speaks of add rules too.
  assert.match(at(6, 1)!.doc.text, /add rule/);
});

test('hover help on a spelling with underscores and extra spaces finds the same entries', () => {
  const lines = ['sell when entries_made > 1 and last_entry_price < close and entries   made > 2'];
  const id = (col: number) => helpAt(lines, 0, col)?.doc.id;
  assert.equal(id(lines[0].indexOf('entries_made')), 'entries made');
  assert.equal(id(lines[0].indexOf('entries   made')), 'entries made');
});
