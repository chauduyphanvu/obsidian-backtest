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

const strategy = (...body: string[]) => ['```strategy', ...body, '```'];

test('a block from a note with Windows line endings is the same block, name and comments included', () => {
  const note = strategy('universe: SPY # tickers', 'name: Trend // old', 'buy when true');
  assert.deepEqual(extractBlocks(note.join('\r\n')), extractBlocks(note.join('\n')));
  assert.deepEqual(extractBlocks(note.join('\r\n')).map((b) => b.name), ['Trend']);
  // Even when the block has a problem, so the name is read from its line.
  const broken = strategy('name: Trend # a', 'nonsense here');
  assert.deepEqual(extractBlocks(broken.join('\r\n')).map((b) => b.name), ['Trend']);
});

test('a strategy example inside a longer fence of another language is not a block', () => {
  const note = ['# How to', '````markdown', ...strategy('name: Example only', 'universe: SPY', 'buy when true'), '````', '', ...strategy('name: Real', 'universe: SPY', 'buy when true')].join('\n');
  assert.deepEqual(
    extractBlocks(note).map((b) => [b.name, b.line]),
    [['Real', 9]],
  );
  const tilde = ['~~~~text', ...strategy('universe: A'), '~~~~'].join('\n');
  assert.deepEqual(extractBlocks(tilde), []);
});

test('a body line that starts with backticks does not end the block unless it closes the fence', () => {
  const longer = ['````strategy', 'name: A', 'universe: SPY', '```', 'buy when true', '````'].join('\n');
  assert.deepEqual(extractBlocks(longer).map((b) => b.source), ['name: A\nuniverse: SPY\n```\nbuy when true']);
  const other = ['~~~strategy', 'universe: SPY', '```', 'buy when true', '~~~'].join('\n');
  assert.deepEqual(extractBlocks(other).map((b) => b.source), ['universe: SPY\n```\nbuy when true']);
  const text = ['```strategy', 'universe: SPY', '```js and more', 'buy when true', '```'].join('\n');
  assert.deepEqual(extractBlocks(text).map((b) => b.source), ['universe: SPY\n```js and more\nbuy when true']);
  // A closing fence may be longer than the opening one.
  assert.deepEqual(extractBlocks(['```strategy', 'universe: SPY', '`````', 'after'].join('\n')).map((b) => b.source), ['universe: SPY']);
});

test('the name loses a trailing comment, from the parser or from the line', () => {
  const named = (name: string, ...more: string[]) => extractBlocks(strategy(`name: ${name}`, 'universe: SPY', 'buy when true', ...more).join('\n'))[0].name;
  assert.equal(named('Trend # v2'), 'Trend');
  assert.equal(named('Trend // v2'), 'Trend');
  assert.equal(named('Trend #hashtag'), 'Trend');
  assert.equal(named('Gold C#'), 'Gold C#');
  // A block with another problem does not parse, and its name still reads the same way.
  assert.equal(named('Trend # v2', 'nonsense line'), 'Trend');
  assert.equal(named('  Spaced   out  ', 'nonsense line'), 'Spaced   out');
  assert.equal(extractBlocks(strategy('universe: SPY', 'buy when true').join('\n'))[0].name, null);
  assert.equal(extractBlocks(strategy('name: # nothing', 'universe: SPY').join('\n'))[0].name, null);
});

test('blocks inside callouts and quotes lose one level of ">"', () => {
  const callout = ['> [!note]', '> ```strategy', '> name: In callout', '>', '> universe: SPY', '> buy when true', '> ```', 'after'].join('\n');
  assert.deepEqual(extractBlocks(callout), [{ name: 'In callout', source: 'name: In callout\n\nuniverse: SPY\nbuy when true', line: 1 }]);
  const nested = ['> > ```strategy', '> > universe: SPY', '> > buy when true', '> > ```'].join('\n');
  assert.deepEqual(extractBlocks(nested).map((b) => b.source), ['universe: SPY\nbuy when true']);
  const nospace = ['>```strategy', '>universe: SPY', '>```'].join('\n');
  assert.deepEqual(extractBlocks(nospace).map((b) => b.source), ['universe: SPY']);
});

test('a quote that ends ends its block, and the lines after it are read again', () => {
  const note = ['> ```strategy', '> universe: SPY', 'plain text', '```strategy', 'universe: QQQ', '```'].join('\n');
  assert.deepEqual(extractBlocks(note).map((b) => [b.source, b.line]), [['universe: SPY', 0], ['universe: QQQ', 3]]);
  // A fence opened outside a quote keeps its lines as they are.
  const plain = ['```strategy', 'universe: SPY', '> not a quote', '```'].join('\n');
  assert.deepEqual(extractBlocks(plain).map((b) => b.source), ['universe: SPY\n> not a quote']);
  // An example inside a quoted longer fence is skipped too.
  assert.deepEqual(extractBlocks(['> ````markdown', '> ```strategy', '> universe: SPY', '> ```', '> ````'].join('\n')), []);
});

test('Windows line ends give the same blocks, without carriage returns in the text', () => {
  const lines = ['# Note', '```strategy', 'name: Crlf # c', 'universe: SPY', 'buy when true', '```', '> ```strategy', '> universe: QQQ', '> ```', ''];
  const lf = extractBlocks(lines.join('\n'));
  const crlf = extractBlocks(lines.join('\r\n'));
  assert.deepEqual(crlf, lf);
  assert.deepEqual(crlf.map((b) => [b.name, b.line]), [['Crlf', 1], [null, 6]]);
  assert.ok(crlf.every((b) => !b.source.includes('\r')));
});

test('a long run of spaces or fence characters is read in linear time', () => {
  // Up to three tries, so a pause or the other test files running alongside don't count; a slow reader is slow every time.
  let best = Infinity;
  for (let i = 0; i < 3 && best >= 2000; i++) {
    const t0 = performance.now();
    extractBlocks(['```strategy', `name:${' '.repeat(50_000)}x${' '.repeat(50_000)}`, '```'].join('\n'));
    extractBlocks('```strategy\n'.repeat(20_000));
    extractBlocks(`> ${'> '.repeat(50_000)}\`\`\`strategy\nuniverse: SPY\n`);
    best = Math.min(best, performance.now() - t0);
  }
  assert.ok(best < 2000, `${best.toFixed(0)} ms`);
});
