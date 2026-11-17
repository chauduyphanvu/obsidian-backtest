import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBlocks } from '../src/blocks.ts';

test('finds strategy blocks with their names and lines, and skips other languages', () => {
  const note = ['# Note', '```strategy', 'name: First one', 'universe: SPY', '```', 'text', '```js', 'name: no', '```', '~~~~strategy', 'universe: QQQ', '~~~~', '```strategy', 'unterminated'].join('\n');
  assert.deepEqual(extractBlocks(note), [
    { name: 'First one', source: 'name: First one\nuniverse: SPY', line: 1 },
    { name: null, source: 'universe: QQQ', line: 9 },
    { name: null, source: 'unterminated', line: 12 },
  ]);
  assert.deepEqual(extractBlocks('```compare\n[[A]]\n```', 'compare'), [{ name: null, source: '[[A]]', line: 0 }]);
});
