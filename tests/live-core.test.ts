import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockName } from '../src/blocks.ts';
import { parseSpec } from '../src/dsl.ts';
import { Latest, PAUSE_DOWNLOAD, PAUSE_READY, PAUSE_SWITCH, ReadyMemo, blockLabel, changeKind, chooseBlock, drawHeld, loadNeeds, locateBlock, viewText, waitFor, type Shown } from '../src/live-core.ts';

const BODY_A = ['name: Trend', 'universe: SPY', 'buy when close > sma(200)'];
const BODY_B = ['universe: QQQ', 'buy when rsi(2) < 10'];
const BODY_C = ['name: Rotation', 'universe: SPY, TLT', 'buy when true'];

/** A note from parts; a part given as a body array becomes a closed strategy block, a string is a plain line. */
function note(...parts: (string | string[])[]): string[] {
  return parts.flatMap((p) => (typeof p === 'string' ? [p] : ['```strategy', ...p, '```']));
}

test('a note with no strategy block has nothing to show', () => {
  assert.equal(chooseBlock([], 0, null), null);
  assert.equal(chooseBlock(['Some text', '```python', 'print(1)', '```'], 1, null), null);
  assert.equal(chooseBlock(['```strategy-notes', 'x', '```'], 1, null), null);
});

test('the cursor inside a block picks it, with its lines and text', () => {
  const lines = note('# Title', '', BODY_A, 'after');
  assert.deepEqual(chooseBlock(lines, 4, null), { index: 0, count: 1, first: 3, last: 5, text: BODY_A.join('\n'), name: 'Trend' });
  assert.equal(chooseBlock(lines, 3, null)!.index, 0);
  assert.equal(chooseBlock(lines, 5, null)!.index, 0);
});

test('the cursor on either fence line counts as inside the block', () => {
  const lines = note('intro', BODY_A, 'between', BODY_B);
  // 0 intro, 1 open, 2-4 body, 5 close, 6 between, 7 open, 8-9 body, 10 close
  assert.equal(chooseBlock(lines, 1, null)!.index, 0);
  assert.equal(chooseBlock(lines, 5, null)!.index, 0);
  assert.equal(chooseBlock(lines, 7, null)!.index, 1);
  assert.equal(chooseBlock(lines, 10, null)!.index, 1);
});

test('between blocks and after the last one, the block shown before stays', () => {
  const lines = note('intro', BODY_A, 'between', BODY_B, 'outro');
  assert.equal(chooseBlock(lines, 6, 1)!.index, 1);
  assert.equal(chooseBlock(lines, 6, 0)!.index, 0);
  assert.equal(chooseBlock(lines, 11, 1)!.index, 1);
  assert.equal(chooseBlock(lines, 0, 1)!.index, 1);
});

test('with nothing shown before, the first block is shown', () => {
  const lines = note('intro', BODY_A, 'between', BODY_B, 'outro');
  for (const at of [0, 6, 11]) assert.equal(chooseBlock(lines, at, null)!.index, 0);
});

test('the cursor wins over the block shown before', () => {
  const lines = note(BODY_A, BODY_B, BODY_C);
  const c = chooseBlock(lines, 7, 0)!;
  assert.equal(c.index, 1);
  assert.equal(c.count, 3);
  assert.equal(c.text, BODY_B.join('\n'));
  assert.equal(chooseBlock(lines, 12, 0)!.name, 'Rotation');
});

test('a block that is gone leaves the one at its position, or the first when there are too few', () => {
  const three = note(BODY_A, BODY_B, BODY_C);
  assert.equal(chooseBlock(three, null, 2)!.text, BODY_C.join('\n'));
  // The last block was deleted: position 2 no longer exists.
  const two = note(BODY_A, BODY_B);
  assert.equal(chooseBlock(two, null, 2)!.index, 0);
  // The middle one was deleted while shown: its position now holds the one that followed.
  const withoutMiddle = note(BODY_A, BODY_C);
  assert.equal(chooseBlock(withoutMiddle, null, 1)!.name, 'Rotation');
  assert.equal(chooseBlock(withoutMiddle, null, -1)!.index, 0);
});

test('with no cursor to follow, as in reading mode, the same fallback applies', () => {
  const lines = note(BODY_A, BODY_B);
  assert.equal(chooseBlock(lines, null, null)!.index, 0);
  assert.equal(chooseBlock(lines, null, 1)!.index, 1);
});

test('two blocks with the same text are told apart by where the cursor is', () => {
  const lines = note(BODY_A, BODY_A);
  assert.equal(chooseBlock(lines, 1, null)!.index, 0);
  const second = chooseBlock(lines, 6, null)!;
  assert.equal(second.index, 1);
  assert.equal(second.first, 6);
  assert.equal(second.text, BODY_A.join('\n'));
});

test('a block with no closing fence yet runs to the end of the note and previews as typed', () => {
  const lines = ['intro', '```strategy', 'universe: SPY', 'buy when close > sma(200)'];
  const c = chooseBlock(lines, 3, null)!;
  assert.deepEqual([c.first, c.last, c.text], [2, 3, 'universe: SPY\nbuy when close > sma(200)']);
  // The cursor on the opening fence, and no cursor at all, give the same block.
  assert.equal(chooseBlock(lines, 1, null)!.text, c.text);
  assert.equal(chooseBlock(lines, null, null)!.text, c.text);
});

test('a block whose opening fence was just typed is empty, and is still the one the cursor is in', () => {
  const lines = ['text', '```strategy'];
  const c = chooseBlock(lines, 1, null)!;
  assert.deepEqual([c.index, c.first, c.last, c.text, c.name], [0, 2, 1, '', null]);
  const closed = ['```strategy', '```'];
  assert.equal(chooseBlock(closed, 0, null)!.text, '');
  assert.equal(chooseBlock(closed, 1, null)!.text, '');
});

test('an unclosed block takes in the text after it, because the note reads it that way', () => {
  const lines = ['```strategy', 'universe: SPY', '', 'More text', '```strategy', 'universe: QQQ', '```'];
  // The second opening fence does not close the first block, so it is part of it; the lone ``` ends it.
  const blocks = chooseBlock(lines, 1, null)!;
  assert.equal(blocks.count, 1);
  assert.equal(blocks.last, 5);
});

test('fences of different lengths and kinds are read as the editor reads them', () => {
  const example = ['````markdown', '```strategy', 'universe: SPY', '```', '````'];
  assert.equal(chooseBlock(example, 2, null), null);
  const long = ['````strategy', 'universe: SPY', '```', 'buy when true', '````'];
  const c = chooseBlock(long, 1, null)!;
  assert.deepEqual([c.first, c.last], [1, 3]);
  const tildes = ['~~~strategy', 'universe: SPY', '~~~'];
  assert.equal(chooseBlock(tildes, 1, null)!.text, 'universe: SPY');
});

test('a block inside a list item is found with its indentation, one inside a callout is not', () => {
  const list = ['- item', '  ```strategy', '  universe: SPY', '  buy when true', '  ```'];
  const c = chooseBlock(list, 2, null)!;
  assert.equal(c.text, '  universe: SPY\n  buy when true');
  const callout = ['> [!note]', '> ```strategy', '> universe: SPY', '> buy when true', '> ```'];
  assert.equal(chooseBlock(callout, 2, null), null);
});

test('a note with other code blocks around the strategy block counts only the strategy blocks', () => {
  const lines = ['```python', 'x = 1', '```', ...note(BODY_A), '```text', 'hello', '```', ...note(BODY_B)];
  const c = chooseBlock(lines, 14, null)!;
  assert.equal(c.index, 1);
  assert.equal(c.count, 2);
});

test('the name is read as the language reads it', () => {
  assert.equal(blockName('name: Trend following\nuniverse: SPY'), 'Trend following');
  assert.equal(blockName('universe: SPY\nNAME :  Trend # v2'), 'Trend');
  assert.equal(blockName('universe: SPY\nname: A // b'), 'A');
  assert.equal(blockName('universe: SPY\n# name: Hidden'), null);
  assert.equal(blockName('universe: SPY'), null);
  assert.equal(blockName('  name: Indented'), 'Indented');
  assert.equal(blockName(''), null);
});

test('the header names the strategy, or its position when it has no name', () => {
  assert.equal(blockLabel({ name: 'Trend', index: 1, count: 3 }), 'Trend');
  assert.equal(blockLabel({ name: null, index: 1, count: 3 }), 'Strategy 2 of 3');
  assert.equal(blockLabel({ name: null, index: 0, count: 1 }), 'Strategy');
});

test('a block is found again after lines above it changed', () => {
  const before = note('a', BODY_A, BODY_B);
  const text = BODY_B.join('\n');
  assert.deepEqual(locateBlock(before, text, 1), { first: 7, last: 8 });
  const after = note('a', 'b', 'c', BODY_A, BODY_B);
  assert.deepEqual(locateBlock(after, text, 1), { first: 9, last: 10 });
});

test('a block with the same text twice is found at its own position first', () => {
  const lines = note(BODY_A, BODY_A, BODY_A);
  const text = BODY_A.join('\n');
  assert.deepEqual(locateBlock(lines, text, 1), { first: 6, last: 8 });
  assert.deepEqual(locateBlock(lines, text, 2), { first: 11, last: 13 });
  // Its position is gone: the nearest block with the text is used.
  assert.deepEqual(locateBlock(note(BODY_A, BODY_A), text, 2), { first: 6, last: 8 });
});

test('a block whose text changed, or that was deleted, is not found', () => {
  const lines = note(BODY_A, BODY_B);
  assert.equal(locateBlock(lines, 'universe: SPY\nbuy when close > sma(150)', 0), null);
  assert.equal(locateBlock(note(BODY_B), BODY_A.join('\n'), 0), null);
  assert.equal(locateBlock([], BODY_A.join('\n'), 0), null);
});

const shown = (index: number, text: string, path = 'a.md'): Shown => ({ note: path, index, text });

test('the first block shown, and a move to another block or note, are switches', () => {
  assert.equal(changeKind(null, null, shown(0, 'x')), 'switch');
  assert.equal(changeKind(shown(0, 'x'), null, shown(1, 'y')), 'switch');
  assert.equal(changeKind(shown(0, 'x'), null, shown(0, 'x', 'b.md')), 'switch');
  assert.equal(changeKind(shown(0, 'x'), null, shown(0, 'y', 'b.md')), 'switch');
});

test('a change to the text of the block shown is an edit', () => {
  assert.equal(changeKind(shown(1, 'x'), null, shown(1, 'xy')), 'edit');
});

test('nothing changed: the same text, or the same text moved to another position', () => {
  assert.equal(changeKind(shown(1, 'x'), null, shown(1, 'x')), 'none');
  assert.equal(changeKind(shown(1, 'x'), null, shown(0, 'x')), 'none');
});

test('the same text in two blocks of one note does not run again', () => {
  assert.equal(changeKind(shown(0, 'x'), null, shown(1, 'x')), 'none');
});

test('the same text in another note is not the same result', () => {
  assert.equal(changeKind(shown(0, 'x'), null, shown(0, 'x', 'b.md')), 'switch');
});

test('typing again while a run is waiting or on its way is still an edit of that block', () => {
  const drawn = shown(0, 'a');
  assert.equal(changeKind(drawn, shown(0, 'ab'), shown(0, 'abc')), 'edit');
  assert.equal(changeKind(null, shown(0, 'ab'), shown(0, 'abc')), 'edit');
});

test('a cursor move that changes nothing does not restart the run that is on its way', () => {
  assert.equal(changeKind(shown(0, 'a'), shown(0, 'ab'), shown(0, 'ab')), 'none');
  assert.equal(changeKind(null, shown(0, 'ab'), shown(0, 'ab')), 'none');
});

test('going back to the text on screen drops the run that was waiting', () => {
  assert.equal(changeKind(shown(0, 'a'), shown(0, 'ab'), shown(0, 'a')), 'cancel');
  // Back in the block on screen after wandering to another one.
  assert.equal(changeKind(shown(0, 'a'), shown(1, 'b'), shown(0, 'a')), 'cancel');
});

test('leaving a block with a run waiting asks for the other block instead', () => {
  assert.equal(changeKind(shown(0, 'a'), shown(0, 'ab'), shown(1, 'b')), 'switch');
  assert.equal(changeKind(shown(0, 'a'), shown(0, 'ab'), shown(0, 'ab', 'b.md')), 'switch');
});

test('a block deleted above the one shown moves its position but is not a change', () => {
  assert.equal(changeKind(shown(2, 'x'), null, shown(1, 'x')), 'none');
});

test('waiting: a short quick pass for a switch, and the typing pause for an edit', () => {
  assert.equal(waitFor('switch', { errors: false, pricesReady: false }), PAUSE_SWITCH);
  assert.equal(waitFor('switch', { errors: true, pricesReady: true }), PAUSE_SWITCH);
  assert.equal(waitFor('edit', { errors: false, pricesReady: true }), PAUSE_READY);
  assert.equal(waitFor('edit', { errors: false, pricesReady: false }), PAUSE_DOWNLOAD);
  // Problems in the text mean no download, so there is no reason to wait long.
  assert.equal(waitFor('edit', { errors: true, pricesReady: false }), PAUSE_READY);
  assert.ok(PAUSE_READY < PAUSE_DOWNLOAD && PAUSE_SWITCH < PAUSE_READY);
});

test('typing a ticker letter by letter is one edit after another, never a switch', () => {
  let drawn: Shown | null = shown(0, 'universe: S');
  let pending: Shown | null = null;
  const kinds: string[] = [];
  for (const typed of ['universe: SP', 'universe: SPY', 'universe: SPYG']) {
    const next = shown(0, typed);
    kinds.push(changeKind(drawn, pending, next));
    pending = next;
  }
  assert.deepEqual(kinds, ['edit', 'edit', 'edit']);
  // The run for the last version finishes and is drawn; the cursor then moves inside the block.
  drawn = pending;
  pending = null;
  assert.equal(changeKind(drawn, pending, shown(0, 'universe: SPYG')), 'none');
});

test('a new draw ends the one before it, and stop ends the one going', () => {
  const latest = new Latest();
  const first = latest.start();
  assert.equal(first.aborted, false);
  const second = latest.start();
  assert.equal(first.aborted, true);
  assert.equal(second.aborted, false);
  latest.stop();
  assert.equal(second.aborted, true);
  // Stopping with nothing going is fine, and a draw after it starts clean.
  latest.stop();
  assert.equal(latest.start().aborted, false);
});

test('a draw that is ended before it finishes lets go of what it held at once; one that has finished is left alone', async () => {
  const latest = new Latest();
  let released = 0;
  const release = () => void released++;
  let finish!: () => void;
  const slow = drawHeld(() => new Promise<void>((resolve) => (finish = resolve)), release, latest.start());
  latest.start();
  assert.equal(released, 1);
  finish();
  const done = await slow;
  assert.equal(released, 1);
  // The draw that has finished is on screen: a newer draw starting does not touch it.
  const shown = await drawHeld(async () => {}, release, latest.start());
  latest.start();
  latest.stop();
  assert.equal(released, 1);
  shown();
  done();
  assert.equal(released, 3);
});

test('a draw that fails lets go of what it held, and a draw started after its end was asked for is let go too', async () => {
  const latest = new Latest();
  let released = 0;
  const release = () => void released++;
  await assert.rejects(
    drawHeld(() => Promise.reject(new Error('boom')), release, latest.start()),
    /boom/,
  );
  assert.equal(released, 1);
  // The failed draw is no longer listening: ending it later lets go of nothing more.
  latest.stop();
  assert.equal(released, 1);
  const late = latest.start();
  latest.stop();
  await drawHeld(async () => {}, release, late);
  assert.equal(released, 2);
});

const needs = (src: string) => loadNeeds(parseSpec(src).spec!);

test('what loading a block needs changes with its tickers, dates, interval and reach, and not with its rules', () => {
  const base = needs('universe: SPY, QQQ\nbuy when close > sma(50)');
  assert.equal(needs('universe: SPY, QQQ\nbuy when close > sma(20) and rsi(14) < 70\nsell when close < sma(10)'), base);
  assert.equal(needs('universe: QQQ, SPY\nbuy when close > sma(50)'), base);
  assert.notEqual(needs('universe: SPY, QQQ, IWM\nbuy when close > sma(50)'), base);
  assert.notEqual(needs('universe: SPY, QQQ\nfrom: 2020-01-01\nbuy when close > sma(50)'), base);
  assert.notEqual(needs('universe: SPY, QQQ\nbuy when close > sma(400)'), base);
  assert.notEqual(needs('universe: SPY, QQQ\ninterval: 1w\nbuy when close > sma(50)'), base);
  assert.notEqual(needs('universe: SPY, binance:QQQ\nbuy when close > sma(50)'), base);
  assert.notEqual(needs('universe: SPY, QQQ\nbenchmark: TLT\nbuy when close > sma(50)'), base);
  assert.notEqual(needs('universe: SPY, QQQ\nbuy when close of IWM > sma(50) of IWM'), base);
  assert.notEqual(needs('universe: SPY, QQQ\ncash rate: ^IRX\nbuy when close > sma(50)'), base);
  assert.notEqual(needs('data: binance\ninterval: 1h\nuniverse: BTCUSDT\nmagnify: 5m\nbuy when close > sma(50)'), needs('data: binance\ninterval: 1h\nuniverse: BTCUSDT\nbuy when close > sma(50)'));
});

test('an answer worked out while a price file was written is not kept', () => {
  const memo = new ReadyMemo(() => 1000);
  const turn = memo.turn();
  // The answer was being worked out from the files as they were; a download then wrote one.
  memo.changed();
  memo.set('a', false, Infinity, turn);
  assert.equal(memo.get('a'), undefined);
  memo.set('a', true, 2000, memo.turn());
  assert.equal(memo.get('a'), true);
});

test('an answer is kept until it runs out or a price file changes, and a no stays until a file changes', () => {
  let now = 1000;
  const memo = new ReadyMemo(() => now, 2);
  assert.equal(memo.get('a'), undefined);
  memo.set('a', true, 1500);
  memo.set('b', false, Infinity);
  assert.deepEqual([memo.get('a'), memo.get('b')], [true, false]);
  now = 1499;
  assert.equal(memo.get('a'), true);
  now = 1500;
  assert.equal(memo.get('a'), undefined);
  now = 9e12;
  assert.equal(memo.get('b'), false);
  memo.changed();
  assert.equal(memo.get('b'), undefined);
  // Only the latest few are kept.
  memo.set('x', true, Infinity);
  memo.set('y', true, Infinity);
  memo.set('z', true, Infinity);
  assert.deepEqual([memo.get('x'), memo.get('y'), memo.get('z')], [undefined, true, true]);
});

test('the panel reads a note in reading mode from its file\'s text, which its editor there is not kept up to date with', () => {
  const view = (mode: string) => ({ getMode: () => mode, data: 'costs: 7 bps', editor: { getValue: () => 'costs: 5 bps' } });
  assert.equal(viewText(view('preview')), 'costs: 7 bps');
  // While typing, the editor is ahead of the file.
  assert.equal(viewText(view('source')), 'costs: 5 bps');
});
