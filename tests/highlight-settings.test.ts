import assert from 'node:assert/strict';
import { test } from 'node:test';
import { helpAt } from '../src/docs.ts';
import { commentStart, tokenizeBlock } from '../src/highlight.ts';

const shown = (lines: string[], i: number) => tokenizeBlock(lines)[i].map((t) => `${t.kind}:${lines[i].slice(t.from, t.to)}`);
const setting = (line: string) => shown(['universe: SPY', 'n = 3', line], 2);

test('a parameter written as the number of entries is coloured as one, and has its hover help', () => {
  assert.deepEqual(setting('entries: n'), ['key:entries', 'param:n']);
  assert.deepEqual(setting('entries: 3'), ['key:entries', 'number:3']);
  const lines = ['universe: SPY', 'n = 3 in 2..5', 'entries: n'];
  const help = helpAt(lines, 2, 9);
  assert.equal(help?.doc.kind, 'parameter');
  assert.deepEqual([help!.from, help!.to], [9, 10]);
  assert.match(help!.doc.text, /Its value is 3/);
});

test('a bar size is one word, whether it starts with a digit or reads as a number', () => {
  assert.deepEqual(setting('magnify: 1h'), ['key:magnify', 'value:1h']);
  assert.deepEqual(setting('magnify: 15m'), ['key:magnify', 'value:15m']);
  assert.deepEqual(setting('interval: 1d'), ['key:interval', 'value:1d']);
  assert.deepEqual(setting('interval: 15m'), ['key:interval', 'value:15m']);
});

test('a commission colours its amounts as numbers and its words as words, with no comma or space inside a number', () => {
  assert.deepEqual(setting('commission: 1'), ['key:commission', 'number:1']);
  assert.deepEqual(setting('commission: $1.50'), ['key:commission', 'number:$1.50']);
  assert.deepEqual(setting('commission: 1 per order'), ['key:commission', 'number:1', 'value:per', 'value:order']);
  assert.deepEqual(setting('commission: 0.005 per share, min 1, max 1%'), [
    'key:commission', 'number:0.005', 'value:per', 'value:share', 'value:min', 'number:1', 'value:max', 'number:1%',
  ]);
  assert.deepEqual(setting('commission: 0.005 per share # cheap'), ['key:commission', 'number:0.005', 'value:per', 'value:share', 'comment:# cheap']);
});

test('settings with plain values keep their colours', () => {
  assert.deepEqual(setting('capital: 10,000'), ['key:capital', 'number:10,000']);
  assert.deepEqual(setting('capital: 10k'), ['key:capital', 'number:10k']);
  assert.deepEqual(setting('costs: 5 bps'), ['key:costs', 'number:5 bps']);
  assert.deepEqual(setting('fill: close'), ['key:fill', 'value:close']);
  assert.deepEqual(setting('from: 2020-01-01'), ['key:from', 'number:2020-01-01']);
});

test('a # or // inside the quotes of a column name does not start a comment', () => {
  const rule = 'buy when column("a # b") > 1';
  assert.equal(commentStart(rule), -1);
  assert.equal(commentStart('buy when column("a // b") > 1'), -1);
  assert.equal(commentStart(`${rule} # about it`), rule.length + 1);
  assert.equal(commentStart('buy when column( "a # b" ) > 1 // about it'), 'buy when column( "a # b" ) > 1 '.length);
  // Outside a column's name nothing changes, and a quote that is never closed hides nothing.
  assert.equal(commentStart('buy when close > 1 # c'), 'buy when close > 1 '.length);
  assert.equal(commentStart('buy when column("a # b'), 'buy when column("a '.length);
  assert.equal(commentStart('name: Mine "a # b"'), 'name: Mine "a '.length);
  assert.deepEqual(shown(['universe: csv:Data/a.csv', rule + ' # about it'], 1), [
    'keyword:buy', 'keyword:when', 'function:column', 'operator:(', 'series:"a # b"', 'operator:)', 'operator:>', 'number:1', 'comment:# about it',
  ]);
});
