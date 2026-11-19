import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockAt, extractBlocks, hasStrategyBlock, targetBlock } from '../src/blocks.ts';

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

test('a list or a link finds its block by its line while that is still it, else by its name', () => {
  const note = ['# Two', ...strategy('name: Trend', 'universe: SPY'), '', ...strategy('universe: QQQ'), '', ...strategy('name: Swing', 'universe: TLT')].join('\n');
  const at = (name: string | null, line: number | null) => {
    const found = targetBlock(note, name, line);
    return found && [found.block.name, found.block.line, found.index];
  };
  assert.deepEqual(at('Trend', 1), ['Trend', 1, 0]);
  // A block with no name goes by its note's name in a list: its line finds it.
  assert.deepEqual(at('Two 2', 6), [null, 6, 1]);
  // The note changed since the list was made: the name finds the block, in any capitals.
  assert.deepEqual(at('swing', 1), ['Swing', 10, 2]);
  assert.deepEqual(at('Swing', null), ['Swing', 10, 2]);
  assert.deepEqual(at('Swing', 40), ['Swing', 10, 2]);
  assert.equal(at('Gone', 1), null);
  assert.equal(at('Two 2', 7), null);
  assert.equal(at(null, null), null);
  // Other kinds of block, such as an account, by their language.
  const account = targetBlock(`${note}\n\n\`\`\`account\nname: Main\ncash: 1000\n\`\`\``, 'Main', 15, 'account');
  assert.deepEqual(account && [account.block.line, account.index], [15, 0]);
});

test('the cursor finds the strategy block it is in, from its opening fence to its closing fence, and its place in the note', () => {
  const note = ['# Two', ...strategy('name: Trend', 'universe: SPY'), '', '```js', 'x', '```', ...strategy('universe: QQQ'), 'after'].join('\n');
  const at = (line: number) => {
    const found = blockAt(note, line);
    return found && [found.block.name, found.block.line, found.index];
  };
  assert.equal(at(0), null);
  assert.deepEqual([1, 2, 3, 4].map(at), Array(4).fill(['Trend', 1, 0]));
  assert.equal(at(5), null);
  // A block of another language is not a strategy.
  assert.equal(at(7), null);
  assert.deepEqual([9, 10, 11].map(at), Array(3).fill([null, 9, 1]));
  assert.equal(at(12), null);
  // The same block, text and place, as the list of the note's blocks gives it.
  assert.deepEqual(blockAt(note, 2), { block: extractBlocks(note)[0], index: 0 });
});

test('the cursor finds a block in a callout, one with no closing fence yet, and an empty one', () => {
  const callout = ['> [!note]', '> ```strategy', '> name: Inside', '> universe: SPY', '> ```', 'after'].join('\n');
  assert.deepEqual(blockAt(callout, 3)?.block, { name: 'Inside', source: 'name: Inside\nuniverse: SPY', line: 1 });
  assert.equal(blockAt(callout, 5), null);
  // A quote that ends without a closing fence ends the block with it.
  const quote = ['> ```strategy', '> universe: SPY', 'after'].join('\n');
  assert.equal(blockAt(quote, 1)?.index, 0);
  assert.equal(blockAt(quote, 2), null);
  const open = ['text', '```strategy', 'universe: SPY', '', 'buy when'].join('\n');
  assert.equal(blockAt(open, 4)?.block.line, 1);
  const empty = ['```strategy', '```', 'after'].join('\n');
  assert.equal(blockAt(empty, 1)?.index, 0);
  assert.equal(blockAt(empty, 2), null);
});

test('a note has a strategy block only when a strategy fence opens one', () => {
  assert.equal(hasStrategyBlock(['# Note', ...strategy('universe: SPY')].join('\n')), true);
  assert.equal(hasStrategyBlock('A note about a strategy, with no block.'), false);
  assert.equal(hasStrategyBlock(['````md', '```strategy', 'universe: SPY', '```', '````'].join('\n')), false);
});
