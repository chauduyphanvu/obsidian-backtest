import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec } from '../src/dsl.ts';
import { NOTE_CHANGED, findBlock, replaceBlockInNote, setParamValues, setParamValuesInNote, writeBlockInNote, writeValuesInNote } from '../src/rewrite.ts';

const block = (...params: string[]) => ['universe: SPY', ...params, 'buy when rsi(2) < fast', 'sell when rsi(2) > fast'].join('\n');

test('a plain value is replaced and the rest of the line is kept', () => {
  assert.equal(setParamValues('fast = 50', { fast: 80 }), 'fast = 80');
  assert.equal(setParamValues('fast=50', { fast: 80 }), 'fast=80');
  assert.equal(setParamValues('fast   =   50', { fast: 80 }), 'fast   =   80');
  assert.equal(setParamValues('  fast = 50', { fast: 80 }), '  fast = 80');
});

test('the range and step are left alone', () => {
  assert.equal(setParamValues('fast = 50 in 20..100 step 10', { fast: 80 }), 'fast = 80 in 20..100 step 10');
  assert.equal(setParamValues('fast = 50 in 20 .. 100', { fast: 60 }), 'fast = 60 in 20 .. 100');
  assert.equal(setParamValues('fast = 50   in   20..100   step   10', { fast: 60 }), 'fast = 60   in   20..100   step   10');
});

test('a percentage stays a percentage', () => {
  assert.equal(setParamValues('stop = 8%', { stop: 0.065 }), 'stop = 6.5%');
  assert.equal(setParamValues('stop = 8 %', { stop: 0.1 }), 'stop = 10 %');
  assert.equal(setParamValues('stop = 8% in 4%..12% step 2%', { stop: 0.06 }), 'stop = 6% in 4%..12% step 2%');
  assert.equal(setParamValues('stop = .08%', { stop: 0.0012 }), 'stop = 0.12%');
});

test('a percentage whose "%" is only on the range keeps the value without one', () => {
  assert.equal(setParamValues('stop = 8 in 4%..12%', { stop: 0.1 }), 'stop = 10 in 4%..12%');
});

test('numbers carry no floating-point noise', () => {
  assert.equal(setParamValues('x = 1', { x: 0.1 + 0.2 }), 'x = 0.3');
  assert.equal(setParamValues('stop = 1%', { stop: 0.07 }), 'stop = 7%');
  assert.equal(setParamValues('stop = 1%', { stop: 0.1 + 0.2 }), 'stop = 30%');
  assert.equal(setParamValues('x = 1', { x: 1 / 3 }), 'x = 0.333333333333');
  assert.equal(setParamValues('x = 1', { x: 1.15 * 3 }), 'x = 3.45');
});

test('numbers never come out with an exponent', () => {
  assert.equal(setParamValues('x = 1', { x: 1e-7 }), 'x = 0.0000001');
  assert.equal(setParamValues('x = 1', { x: 2.5e25 }), 'x = 25000000000000000000000000');
  assert.equal(setParamValues('x = 1', { x: -0 }), 'x = 0');
});

test('negative and leading-dot values', () => {
  assert.equal(setParamValues('x = -5', { x: -10 }), 'x = -10');
  assert.equal(setParamValues('x = 5', { x: -2.5 }), 'x = -2.5');
  assert.equal(setParamValues('x = .5', { x: 2 }), 'x = 2');
  assert.equal(setParamValues('x = -.5 in -1..1 step .5', { x: 0.5 }), 'x = 0.5 in -1..1 step .5');
});

test('a comment is kept, with the spacing before it', () => {
  assert.equal(setParamValues('fast = 50   # the trend filter', { fast: 80 }), 'fast = 80   # the trend filter');
  assert.equal(setParamValues('fast = 50 // fast = 50', { fast: 80 }), 'fast = 80 // fast = 50');
  assert.equal(setParamValues('fast = 50 in 20..100 # note', { fast: 80 }), 'fast = 80 in 20..100 # note');
  assert.equal(setParamValues('# fast = 50', { fast: 80 }), '# fast = 50');
  // A # stuck to the number starts no comment, so the parser reads no parameter there and nothing is written.
  assert.equal(setParamValues('fast = 50#x', { fast: 80 }), 'fast = 50#x');
});

test('tabs are kept', () => {
  assert.equal(setParamValues('\tfast\t=\t50\tin\t20..100\t# c', { fast: 80 }), '\tfast\t=\t80\tin\t20..100\t# c');
});

test('Windows line endings are kept, with and without a comment', () => {
  assert.equal(setParamValues('universe: SPY\r\nfast = 50\r\nslow = 200 # slow\r\nbuy when close > sma(fast)\r\n', { fast: 80, slow: 250 }), 'universe: SPY\r\nfast = 80\r\nslow = 250 # slow\r\nbuy when close > sma(fast)\r\n');
  assert.equal(setParamValues('fast = 50 in 20..100 step 10\r', { fast: 70 }), 'fast = 70 in 20..100 step 10\r');
});

test('a name that is the start of another name does not touch it', () => {
  const text = 'fast = 50\nfast_ma = 20\nfastest = 9\nslow_fast = 4';
  assert.equal(setParamValues(text, { fast: 55 }), 'fast = 55\nfast_ma = 20\nfastest = 9\nslow_fast = 4');
  assert.equal(setParamValues(text, { fast_ma: 25 }), 'fast = 50\nfast_ma = 25\nfastest = 9\nslow_fast = 4');
});

test('names do not care about capital letters, as in the language', () => {
  assert.equal(setParamValues('Fast = 50', { fast: 80 }), 'Fast = 80');
  assert.equal(setParamValues('fast = 50', { FAST: 80 }), 'fast = 80');
});

test('names the block does not declare are ignored', () => {
  const text = block('fast = 50');
  assert.equal(setParamValues(text, { nothing: 1 }), text);
  assert.equal(setParamValues(text, {}), text);
});

test('a value that is already there leaves the text exactly as it was', () => {
  assert.equal(setParamValues('fast = 50.0 in 20..100', { fast: 50 }), 'fast = 50.0 in 20..100');
  assert.equal(setParamValues('stop = 8.0 %', { stop: 0.08 }), 'stop = 8.0 %');
  assert.equal(setParamValues('stop = 7%', { stop: 0.07 }), 'stop = 7%');
});

test('lines that are not parameters are never changed', () => {
  const text = ['name: fast = 5', 'universe: SPY', 'buy when close > sma(fast) and x == 3', 'x = 3 == 4', 'for SPY:', 'stop loss: 8%'].join('\n');
  // `x = 3 == 4` is a definition of a condition, so it has no value to write either.
  assert.equal(setParamValues(text, { fast: 9, x: 9, name: 1, stop: 0.5 }), text);
});

test('words the language already uses are not parameters', () => {
  assert.equal(setParamValues('close = 5\nsma = 3', { close: 1, sma: 2 }), 'close = 5\nsma = 3');
});

test('a value outside the declared range is still written', () => {
  assert.equal(setParamValues('fast = 50 in 20..100', { fast: 500 }), 'fast = 500 in 20..100');
});

test('a value off the step is written as given', () => {
  assert.equal(setParamValues('fast = 55 in 20..100 step 10', { fast: 57 }), 'fast = 57 in 20..100 step 10');
});

test('a line that is not a valid parameter is left alone', () => {
  assert.equal(setParamValues('fast = abc', { fast: 5 }), 'fast = abc');
  assert.equal(setParamValues('fast =', { fast: 5 }), 'fast =');
});

test('a non-finite value is ignored', () => {
  assert.equal(setParamValues('fast = 50', { fast: Number.NaN }), 'fast = 50');
  assert.equal(setParamValues('fast = 50', { fast: Infinity }), 'fast = 50');
});

test('several parameters at once, in any order, with every other line untouched', () => {
  const text = ['name: Test  ', 'universe: SPY', 'fast = 50 in 20..100 step 10  # f', 'stop = 8%', '', 'slow = 200', 'buy when sma(fast) > sma(slow)', 'stop loss: stop'].join('\n');
  const next = setParamValues(text, { slow: 150, stop: 0.06, fast: 30 });
  assert.equal(next, ['name: Test  ', 'universe: SPY', 'fast = 30 in 20..100 step 10  # f', 'stop = 6%', '', 'slow = 150', 'buy when sma(fast) > sma(slow)', 'stop loss: stop'].join('\n'));
});

test('round trip: the rewritten block parses to the values asked for', () => {
  const text = ['universe: SPY', 'fast = 50 in 20..100 step 10', 'slow = 200', 'stop = 8% in 4%..12% step 2%', 'limit = 2.5', 'buy when close > sma(fast) and rsi(2) < 30 and close > sma(slow)', 'sell when close < sma(fast)', 'stop loss: stop'].join('\n');
  const asked = { fast: 60, slow: 150, stop: 0.06, limit: 0.1 + 0.2 };
  const parsed = parseSpec(setParamValues(text, asked));
  assert.deepEqual(parsed.errors, []);
  for (const p of parsed.spec!.params) assert.equal(p.value, Number(asked[p.name as keyof typeof asked].toPrecision(12)), p.name);
});

test('round trip over every form of parameter line', () => {
  const forms: [string, number, number][] = [
    ['fast = 50', 50, 60],
    ['fast=50', 50, 60],
    ['fast = 50 in 20..100', 50, 70],
    ['fast = 50 in 20..100 step 10', 50, 70],
    ['fast = 50 in 20 .. 100 step 10', 50, 70],
    ['fast = 50 # c', 50, 60],
    ['fast = 50 in 20..100 step 10 // c', 50, 70],
    ['fast = 5%', 0.05, 0.0725],
    ['fast = 5 %', 0.05, 0.0725],
    ['fast = 5% in 1%..10% step 0.5%', 0.05, 0.0725],
    ['fast = 5 in 1%..10%', 0.05, 0.0725],
    ['fast = .5', 0.5, 0.75],
    ['fast = 2.5 in 1..5 step .5', 2.5, 4.5],
    ['\tFast\t=\t50\tin\t20..100', 50, 90],
    ['fast = 50.0', 50, 51],
  ];
  for (const [line, was, asked] of forms) {
    const text = block(line);
    const before = parseSpec(text);
    assert.deepEqual(before.errors, [], line);
    assert.equal(before.spec!.params[0].declared, was, line);
    const next = setParamValues(text, { fast: asked });
    const after = parseSpec(next);
    // A value off the range is still written; the parser then says so, and the number is still the one asked for.
    const value = after.spec ? after.spec.params[0].declared : Number(next.match(/fast\s*=\s*(\S+)/i)![1].replace('%', '')) / (/%/.test(line) ? 100 : 1);
    assert.equal(Number(value.toPrecision(12)), asked, line);
    assert.equal(next.split('\n').length, text.split('\n').length, line);
  }
});

test('the parameters the parser sees are the ones the rewrite finds', () => {
  const text = ['universe: SPY', 'Fast = 50', 'fast_ma = 20 # x', '   slow  =  200', 'buy when close > sma(fast) and close > sma(fast_ma) and close > sma(slow)'].join('\n');
  const parsed = parseSpec(text);
  const names = parsed.spec!.params.map((p) => p.name);
  const values = Object.fromEntries(names.map((n) => [n, 33]));
  for (const p of parseSpec(setParamValues(text, values)).spec!.params) assert.equal(p.value, 33, p.name);
});

const NOTE = ['# Title', '', '```strategy', 'universe: SPY', 'fast = 50', 'buy when close > sma(fast)', '```', '', 'text', '', '```strategy', 'universe: QQQ', 'fast = 20 # keep', 'buy when close > sma(fast)', '```', ''].join('\n');

test('findBlock needs the block to open on that line with that text', () => {
  const second = NOTE.split('\n').slice(11, 13).join('\n');
  assert.equal(findBlock(NOTE, 10, second.replace('SPY', 'QQQ'))?.index, undefined);
  assert.equal(findBlock(NOTE, 10, 'universe: QQQ\nfast = 20 # keep\nbuy when close > sma(fast)')?.index, 1);
  assert.equal(findBlock(NOTE, 2, 'universe: SPY\nfast = 50\nbuy when close > sma(fast)')?.index, 0);
  assert.equal(findBlock(NOTE, 3, 'universe: SPY\nfast = 50\nbuy when close > sma(fast)'), null);
  assert.equal(findBlock(NOTE, 2, 'universe: SPY\nfast = 51\nbuy when close > sma(fast)'), null);
});

test('findBlock ignores line endings and trailing blank space in the text it is given', () => {
  assert.ok(findBlock(NOTE, 2, 'universe: SPY\r\nfast = 50\r\nbuy when close > sma(fast)\r\n'));
});

test('in a note, only the lines of that block that change are written', () => {
  const next = setParamValuesInNote(NOTE, 10, 'universe: QQQ\nfast = 20 # keep\nbuy when close > sma(fast)', { fast: 25 });
  assert.equal(next, NOTE.replace('fast = 20 # keep', 'fast = 25 # keep'));
});

test('in a note, the first block is not touched when the second is written', () => {
  const next = setParamValuesInNote(NOTE, 10, 'universe: QQQ\nfast = 20 # keep\nbuy when close > sma(fast)', { fast: 99 })!;
  assert.ok(next.includes('fast = 50\n'));
});

test('a note that changed since the block was drawn is not written', () => {
  const edited = NOTE.replace('fast = 20', 'fast = 21');
  assert.equal(setParamValuesInNote(edited, 10, 'universe: QQQ\nfast = 20 # keep\nbuy when close > sma(fast)', { fast: 25 }), null);
  assert.equal(setParamValuesInNote(`new first line\n${NOTE}`, 10, 'universe: QQQ\nfast = 20 # keep\nbuy when close > sma(fast)', { fast: 25 }), null);
});

test('a block in a callout keeps its quote markers', () => {
  const note = ['> [!note]', '> ```strategy', '> universe: SPY', '> fast = 50', '> buy when close > sma(fast)', '> ```', ''].join('\n');
  const src = 'universe: SPY\nfast = 50\nbuy when close > sma(fast)';
  assert.equal(setParamValuesInNote(note, 1, src, { fast: 70 }), note.replace('> fast = 50', '> fast = 70'));
});

test('a note with Windows line endings keeps them', () => {
  const note = NOTE.replace(/\n/g, '\r\n');
  const next = setParamValuesInNote(note, 2, 'universe: SPY\nfast = 50\nbuy when close > sma(fast)', { fast: 70 })!;
  assert.equal(next, note.replace('fast = 50', 'fast = 70'));
  assert.ok(!/[^\r]\n/.test(next));
});

test('writing the values already in the note changes nothing', () => {
  assert.equal(setParamValuesInNote(NOTE, 2, 'universe: SPY\nfast = 50\nbuy when close > sma(fast)', { fast: 50 }), NOTE);
});

// ---- writing through the vault

/** A note held in memory, edited the way `vault.process` edits one: the function gets the text and gives the new text. */
function memoryNote(text: string) {
  const note = { text, runs: 0 };
  const process = async (edit: (text: string) => string) => {
    note.runs++;
    note.text = edit(note.text);
    return note.text;
  };
  return { note, process };
}

const WRITE_SRC = 'universe: QQQ\nfast = 20 # keep\nbuy when close > sma(fast)';
const WRITE_NOTE = `Intro\n\n\`\`\`strategy\n${WRITE_SRC}\n\`\`\`\n`;

test('writeValuesInNote writes the values into the block and resolves', async () => {
  const { note, process } = memoryNote(WRITE_NOTE);
  await writeValuesInNote(process, 2, WRITE_SRC, { fast: 25 });
  assert.equal(note.text, WRITE_NOTE.replace('fast = 20', 'fast = 25'));
});

test('writeValuesInNote rejects, with a message fit to show, when the block has changed', async () => {
  const { note, process } = memoryNote(WRITE_NOTE.replace('fast = 20', 'fast = 21'));
  await assert.rejects(writeValuesInNote(process, 2, WRITE_SRC, { fast: 25 }), (e: unknown) => e instanceof Error && e.message === NOTE_CHANGED);
  assert.equal(note.text, WRITE_NOTE.replace('fast = 20', 'fast = 21'));
  assert.equal(NOTE_CHANGED, 'The note has changed since this result was drawn, so nothing was written. Try again.');
});

test('writeValuesInNote rejects without touching the note when the block has no known place', async () => {
  const { note, process } = memoryNote(WRITE_NOTE);
  await assert.rejects(writeValuesInNote(process, undefined, WRITE_SRC, { fast: 25 }), (e: unknown) => e instanceof Error && e.message === NOTE_CHANGED);
  assert.equal(note.runs, 0);
  assert.equal(note.text, WRITE_NOTE);
});

test('writeValuesInNote rejects when the note cannot be written', async () => {
  const failing = async () => {
    throw new Error('The file is locked');
  };
  await assert.rejects(writeValuesInNote(failing, 2, WRITE_SRC, { fast: 25 }), /The file is locked/);
});

// ---- restoring a version: the whole text of a block

const SECOND = 'universe: QQQ\nfast = 20 # keep\nbuy when close > sma(fast)';

test('a block\'s whole text is replaced, longer or shorter, and nothing around it', () => {
  const longer = 'name: Back\nuniverse: QQQ\nfast = 30\nbuy when close > sma(fast)\nsell when close < sma(fast)';
  const lines = NOTE.split('\n');
  assert.equal(replaceBlockInNote(NOTE, 10, SECOND, longer), [...lines.slice(0, 11), ...longer.split('\n'), ...lines.slice(14)].join('\n'));
  assert.equal(replaceBlockInNote(NOTE, 10, SECOND, 'universe: QQQ\nbuy when true'), [...lines.slice(0, 11), 'universe: QQQ', 'buy when true', ...lines.slice(14)].join('\n'));
  // The first block is left as it was.
  assert.ok(replaceBlockInNote(NOTE, 10, SECOND, 'universe: QQQ\nbuy when true')!.startsWith(lines.slice(0, 11).join('\n')));
  // The same text gives the same note.
  assert.equal(replaceBlockInNote(NOTE, 10, SECOND, SECOND), NOTE);
});

test('a block whose note changed since it was drawn is not replaced', () => {
  assert.equal(replaceBlockInNote(NOTE.replace('fast = 20', 'fast = 21'), 10, SECOND, 'universe: QQQ\nbuy when true'), null);
  assert.equal(replaceBlockInNote(`new first line\n${NOTE}`, 10, SECOND, 'universe: QQQ\nbuy when true'), null);
  assert.equal(replaceBlockInNote('```strategy\n```\n', 0, '', 'universe: QQQ'), null);
});

test('a block in a callout gets the callout\'s markers on every new line, the empty ones too', () => {
  const note = ['> [!note]', '> ```strategy', '> universe: SPY', '> fast = 50', '> buy when close > sma(fast)', '> ```', 'after'].join('\n');
  const src = 'universe: SPY\nfast = 50\nbuy when close > sma(fast)';
  assert.equal(
    replaceBlockInNote(note, 1, src, 'universe: SPY\n\nbuy when true'),
    ['> [!note]', '> ```strategy', '> universe: SPY', '> ', '> buy when true', '> ```', 'after'].join('\n'),
  );
  const nested = note.replace(/^> /gm, '> > ');
  assert.equal(replaceBlockInNote(nested, 1, src, 'universe: QQQ'), ['> > [!note]', '> > ```strategy', '> > universe: QQQ', '> > ```', 'after'].join('\n'));
});

test('a note with Windows line endings keeps them on the new lines, whichever ending the text has', () => {
  const note = NOTE.replace(/\n/g, '\r\n');
  const next = replaceBlockInNote(note, 2, 'universe: SPY\nfast = 50\nbuy when close > sma(fast)', 'universe: SPY\r\nfast = 60\nbuy when true')!;
  assert.equal(next, note.replace('fast = 50\r\nbuy when close > sma(fast)', 'fast = 60\r\nbuy when true'));
  assert.ok(!/[^\r]\n/.test(next));
});

test('writeBlockInNote writes the text, or rejects with the same message as a write of values', async () => {
  const { note, process } = memoryNote(WRITE_NOTE);
  await writeBlockInNote(process, 2, WRITE_SRC, 'universe: SPY\nbuy when true');
  assert.equal(note.text, 'Intro\n\n```strategy\nuniverse: SPY\nbuy when true\n```\n');
  await assert.rejects(writeBlockInNote(process, 2, WRITE_SRC, 'universe: QQQ'), (e: unknown) => e instanceof Error && e.message === NOTE_CHANGED);
  assert.equal(note.text, 'Intro\n\n```strategy\nuniverse: SPY\nbuy when true\n```\n');
  const untouched = memoryNote(WRITE_NOTE);
  await assert.rejects(writeBlockInNote(untouched.process, undefined, WRITE_SRC, 'universe: SPY'), (e: unknown) => e instanceof Error && e.message === NOTE_CHANGED);
  assert.equal(untouched.note.runs, 0);
});
