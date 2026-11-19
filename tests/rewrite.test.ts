import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec } from '../src/dsl.ts';
import { applyFix } from '../src/fixes.ts';
import { STARTERS } from '../src/gallery.ts';
import { tokenizeBlock } from '../src/highlight.ts';
import { NOTE_CHANGED, findBlock, nameProblem, paramFromNumber, renameLinksInNote, replaceBlockInNote, ruleNumbers, setParamValues, setParamValuesInNote, setSettingInNote, writeBlockInNote, writeValuesInNote, type NewParam } from '../src/rewrite.ts';

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
  assert.equal(NOTE_CHANGED, 'The note changed after the plugin showed this result. The plugin did not write to the note. Do the step again.');
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

// ---------------------------------------------------------------- a number made a parameter

const TREND = ['name: Trend', 'universe: SPY', 'costs: 5 bps', '', 'buy  when close > sma(200)', 'sell when close < sma(200)'];
/** The block with the change made, and what the parser reads from it. */
const made = (lines: string[], p: NewParam) => {
  const text = applyFix(lines, p.fix).join('\n');
  return { text, parsed: parseSpec(text) };
};
/** The offer for the `nth` place (from 0) where `written` starts on a line. */
const at = (lines: string[], row: number, written: string, nth = 0) => {
  let col = -1;
  for (let k = 0; k <= nth; k++) col = lines[row].indexOf(written, col + 1);
  return paramFromNumber(lines, row, col);
};

test('the period of a call becomes a parameter named for its function, in every place the same call is written', () => {
  const p = at(TREND, 4, '200')!;
  assert.equal(p.name, 'sma_n');
  assert.equal(p.declaration, 'sma_n = 200 in 100..400 step 20');
  assert.equal(p.fix.label, 'Make 200 a parameter (2 places)');
  assert.equal(p.places, 2);
  assert.equal(p.context, 'sma(200)');
  // Between the settings and the rules, with a blank line on each side, as the starter strategies have it.
  assert.equal(made(TREND, p).text, ['name: Trend', 'universe: SPY', 'costs: 5 bps', '', 'sma_n = 200 in 100..400 step 20', '', 'buy  when close > sma(sma_n)', 'sell when close < sma(sma_n)'].join('\n'));
  const { spec, errors } = made(TREND, p).parsed;
  assert.deepEqual(errors, []);
  assert.deepEqual(spec!.params.map((q) => [q.name, q.value, q.range]), [['sma_n', 200, { lo: 100, hi: 400, step: 20 }]]);
  // From the other rule, the same change, with that rule's number first.
  const other = at(TREND, 5, '200')!;
  assert.equal(made(TREND, other).text, made(TREND, p).text);
  assert.equal(other.fix.line, 6);
});

test('an equal number that does something else is left alone: a level is not the period of sma(200)', () => {
  const lines = ['universe: SPY', 'buy when close > sma(200) and rsi(2) < 200', 'sell when close < sma(200)'];
  const period = at(lines, 1, '200')!;
  assert.equal(made(lines, period).text.split('\n').slice(-2).join('\n'), 'buy when close > sma(sma_n) and rsi(2) < 200\nsell when close < sma(sma_n)');
  const level = at(lines, 1, '200', 1)!;
  assert.equal(level.name, 'level');
  assert.equal(level.fix.label, 'Make 200 a parameter');
  assert.equal(level.context, 'rsi(2) < 200');
  assert.equal(made(lines, level).text.split('\n').slice(-2).join('\n'), 'buy when close > sma(200) and rsi(2) < level\nsell when close < sma(200)');
  // Two calls that differ are not the same call.
  const differ = ['universe: SPY', 'buy when close > sma(200)', 'sell when close < sma(volume, 200)'];
  assert.equal(at(differ, 1, '200')!.places, 1);
});

test('a name says what the number does: a window, a lag, a factor, a band width, a period after a series', () => {
  const lines = [
    'universe: SPY',
    'buy when close > sma(50) for 3 bars and close[1] > last entry price * 1.03',
    '  and bb_upper(20, 2) > close and sma(volume, 30) > volume and close crosses above 50',
  ];
  assert.equal(at(lines, 1, '3 bars')!.name, 'n_bars');
  assert.equal(at(lines, 1, '3 bars')!.context, 'for 3 bars');
  assert.equal(at(lines, 1, '1]')!.name, 'lag');
  assert.equal(at(lines, 1, '1]')!.context, 'close[1]');
  assert.equal(at(lines, 1, '1.03')!.name, 'factor');
  assert.equal(at(lines, 1, '1.03')!.context, 'last entry price * 1.03');
  assert.equal(at(lines, 2, '20')!.name, 'bb_upper_n');
  assert.equal(at(lines, 2, '2)')!.name, 'bb_upper_width');
  assert.equal(at(lines, 2, '30')!.name, 'sma_n');
  assert.equal(at(lines, 2, '50')!.name, 'level');
  assert.equal(at(lines, 2, '50')!.context, 'close crosses above 50');
});

test('a setting\'s number is named for the setting and keeps its percentage', () => {
  const lines = ['universe: SPY', 'stop loss: 8%', 'trailing stop: 3 atr(14)', 'entries: 3', 'hold: top 1 by roc(126)', 'buy when roc(126) > 5%', 'add when close > sma(20)'];
  const stop = at(lines, 1, '8%')!;
  assert.equal(stop.declaration, 'stop_loss = 8% in 4%..16% step 1%');
  const { text, parsed } = made(lines, stop);
  assert.match(text, /^stop loss: stop_loss$/m);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.spec!.stops.SPY.stopLoss, { k: 'pct', v: 0.08 });
  assert.equal(at(lines, 2, '3')!.name, 'trailing_stop');
  assert.equal(at(lines, 3, '3')!.name, 'max_entries');
  assert.equal(at(lines, 4, '1')!.name, 'top_n');
  // The same call in a setting and in a rule changes in both.
  const roc = at(lines, 4, '126')!;
  assert.equal(roc.fix.label, 'Make 126 a parameter (2 places)');
  assert.deepEqual(made(lines, roc).parsed.errors, []);
  // A percentage in a rule stays one: 5% is 0.05.
  const level = at(lines, 5, '5%')!;
  assert.equal(level.declaration, 'level = 5% in 3%..10% step 1%');
  assert.equal(made(lines, level).parsed.spec!.params[0].value, 0.05);
});

test('the new line goes after the last parameter, or above the first rule when no setting is above it', () => {
  const after = ['universe: SPY', 'fast = 50 in 20..100 step 10', '  # a comment', 'buy when sma(fast) > sma(200)'];
  assert.equal(made(after, at(after, 3, '200')!).text, ['universe: SPY', 'fast = 50 in 20..100 step 10', 'sma_n = 200 in 100..400 step 20', '  # a comment', 'buy when sma(fast) > sma(sma_n)'].join('\n'));
  const first = ['buy when close > sma(200)', 'universe: SPY'];
  assert.equal(made(first, at(first, 0, '200')!).text, ['sma_n = 200 in 100..400 step 20', '', 'buy when close > sma(sma_n)', 'universe: SPY'].join('\n'));
  const tight = ['universe: SPY', 'buy when close > sma(200)'];
  assert.equal(made(tight, at(tight, 1, '200')!).text, ['universe: SPY', '', 'sma_n = 200 in 100..400 step 20', '', 'buy when close > sma(sma_n)'].join('\n'));
});

test('a name the block uses, or one the language keeps, gets a number after it', () => {
  const lines = ['universe: SPY', 'level = 3', 'level_2 = close > 1', 'buy when rsi(2) < 10 and close > level'];
  const p = at(lines, 3, '10')!;
  assert.equal(p.name, 'level_3');
  assert.deepEqual(made(lines, p).parsed.errors, []);
});

test('the range keeps to values the block reads, and nothing is offered where a parameter cannot stand', () => {
  // hma() needs a period of 2 or more, so the range does not reach 1.
  assert.equal(at(['universe: SPY', 'buy when hma(2) > close'], 1, '2')!.declaration, 'hma_n = 2 in 2..6 step 1');
  // A weight, a date, a cost, a parameter's own value, and a word.
  const other = ['universe: SPY 60%, QQQ 40%', 'from: 2010-01-01', 'costs: 5 bps', 'fast = 50 in 20..100', 'buy when sma(fast) > close'];
  for (const [row, written] of [[0, '60'], [1, '2010'], [2, '5'], [3, '50'], [4, 'sma']] as const) assert.equal(at(other, row, written), null, `${row}: ${written}`);
});

test('every number a starter strategy offers becomes a parameter the block reads, at its value and at each end of its range', () => {
  let offered = 0;
  for (const s of STARTERS) {
    const lines = s.text.split('\n');
    tokenizeBlock(lines).forEach((tokens, row) => {
      for (const t of tokens.filter((x) => x.kind === 'number')) {
        const p = paramFromNumber(lines, row, t.from);
        if (!p) continue;
        offered++;
        const text = applyFix(lines, p.fix).join('\n');
        const { spec, errors } = parseSpec(text);
        assert.deepEqual(errors, [], `${s.title}: ${p.declaration}`);
        const param = spec!.params.find((q) => q.name === p.name)!;
        assert.equal(param.value, Number(p.number.replace('%', '')) / (param.percent ? 100 : 1));
        for (const end of [param.range!.lo, param.range!.hi]) assert.deepEqual(parseSpec(text, { overrides: { [p.name]: end } }).errors, [], `${s.title}: ${p.name} = ${end}`);
      }
    });
  }
  assert.ok(offered >= 30, `${offered} numbers offered`);
});

test('the numbers of the rules are listed once for each change, with the code around each', () => {
  const dips = STARTERS.find((s) => s.title === 'Buy dips in an uptrend')!.text.split('\n');
  assert.deepEqual(
    ruleNumbers(dips).map((p) => [p.context, p.fix.label]),
    [
      ['rsi(2)', 'Make 2 a parameter (2 places)'],
      ['rsi(2) < 10', 'Make 10 a parameter'],
      ['sma(200)', 'Make 200 a parameter'],
      ['rsi(2) > 70', 'Make 70 a parameter'],
      ['bars held >= 10', 'Make 10 a parameter'],
    ],
  );
  // The stop loss is a setting, not a rule.
  assert.ok(!ruleNumbers(dips).some((p) => p.name === 'stop_loss'));
});

/** The links of the renamed strategy's note: by its name, by its path with or without .md, and by another path that names it. */
const isTrend = (link: string) => ['Trend', 'Ideas/Trend', 'Ideas/Trend.md'].includes(link);

test('renaming a strategy rewrites the links to it in compare and account blocks, alias, weight and path kept', () => {
  const note = [
    '# Mix',
    '```compare',
    '[[Trend#Trend]] 60%',
    '[[Ideas/Trend#trend|Slow one]]',
    '[[Ideas/Trend.md# Trend ]] 10%',
    'Ideas/Trend.md#Trend 40%',
    'Ideas/Trend.md#trend',
    '[[Trend#Trend following]] 20%',
    '[[Other#Trend]] 5%',
    '[[Trend]]',
    '```',
    '```account',
    'cash: 1,000',
    '[[Trend#Trend]] 100%',
    '```',
    'Prose that links [[Trend#Trend]] stays as written.',
  ].join('\n');
  const { text, count } = renameLinksInNote(note, isTrend, 'Trend', 'Trend v2', false);
  assert.equal(count, 6);
  assert.deepEqual(text.split('\n'), [
    '# Mix',
    '```compare',
    '[[Trend#Trend v2]] 60%',
    '[[Ideas/Trend#Trend v2|Slow one]]',
    '[[Ideas/Trend.md# Trend v2 ]] 10%',
    'Ideas/Trend.md#Trend v2 40%',
    'Ideas/Trend.md#Trend v2',
    // A longer name, another note with a strategy of that name, and a link to the note alone are other strategies.
    '[[Trend#Trend following]] 20%',
    '[[Other#Trend]] 5%',
    '[[Trend]]',
    '```',
    '```account',
    'cash: 1,000',
    '[[Trend#Trend v2]] 100%',
    '```',
    'Prose that links [[Trend#Trend]] stays as written.',
  ]);
});

test('in a forward test the from line and the text that names the strategy change, and the frozen rules stay', () => {
  const note = [
    '---',
    'backtest_forward: true',
    '---',
    '',
    '# Forward test of Trend',
    '',
    'The plugin froze the rules below after the bar of 2026-11-13. They are from [[Ideas/Trend#Trend]].',
    '',
    '```forward',
    'started: 2026-11-13',
    'from: [[Ideas/Trend#Trend]]',
    'check: abc',
    '---',
    'name: Trend',
    'universe: SPY',
    '```',
  ].join('\r\n');
  const { text, count } = renameLinksInNote(note, isTrend, 'Trend', 'Trend v2', true);
  assert.equal(count, 2);
  const lines = text.split('\r\n');
  assert.equal(lines[6], 'The plugin froze the rules below after the bar of 2026-11-13. They are from [[Ideas/Trend#Trend v2]].');
  assert.equal(lines[10], 'from: [[Ideas/Trend#Trend v2]]');
  assert.equal(lines[13], 'name: Trend');
  assert.equal(lines[4], '# Forward test of Trend');
  // Elsewhere only the forward block counts.
  assert.equal(renameLinksInNote(note, isTrend, 'Trend', 'Trend v2', false).count, 1);
  // A link to a heading of the note itself names no other note, whatever finds it.
  assert.equal(renameLinksInNote(`${note}\r\nSee [[#Trend]].`, () => true, 'Trend', 'Trend v2', true).count, 2);
});

test('a link in a callout keeps its markers, and a note with no link to the strategy comes back as it was', () => {
  const note = ['> [!note] Mix', '> ```compare', '> [[Trend#Trend]] 50%', '> [[Other#Swing]] 50%', '> ```'].join('\n');
  assert.equal(renameLinksInNote(note, isTrend, 'Trend', 'Fast', false).text, note.replace('[[Trend#Trend]]', '[[Trend#Fast]]'));
  const none = renameLinksInNote(note, isTrend, 'Swing', 'Slow', false);
  assert.deepEqual(none, { text: note, count: 0 });
});

test('a new name is refused when it is empty, the same, in another block of the note, or breaks a link', () => {
  assert.equal(nameProblem('  ', 'Trend', []), 'Write a name.');
  assert.equal(nameProblem('Trend ', 'Trend', []), 'The strategy has this name now. Write a different name.');
  for (const bad of ['Trend #2', 'A|B', 'A [x]', 'A^B']) assert.equal(nameProblem(bad, 'Trend', []), 'A name cannot contain #, |, [, ] or ^. These characters break the links to the strategy.', bad);
  assert.equal(nameProblem('A // B', 'Trend', []), 'A name cannot contain // after a space. The plugin reads the text after it as a comment.');
  assert.equal(nameProblem('swing', 'Trend', ['Swing', null]), 'Another strategy in this note has the name "swing". Write a different name.');
  assert.equal(nameProblem('Trend v2', 'Trend', ['Swing', null]), null);
  // Other capitals of the same name, and a first name for a block that had none, are names to write.
  assert.equal(nameProblem('TREND', 'Trend', ['Swing']), null);
  assert.equal(nameProblem('Dip', null, ['Swing']), null);
});

test('the new name is written on the block\'s name line, or added after its settings when it has none', () => {
  const note = ['# N', '```strategy', 'name: Trend', 'universe: SPY', '', 'buy when close > sma(200)', '```'].join('\n');
  assert.equal(setSettingInNote(note, 1, 'name: Trend\nuniverse: SPY\n\nbuy when close > sma(200)', 'strategy', 'name', 'Trend v2'), note.replace('name: Trend', 'name: Trend v2'));
  const unnamed = ['```strategy', 'universe: SPY', 'buy when true', '```'].join('\n');
  assert.equal(setSettingInNote(unnamed, 0, 'universe: SPY\nbuy when true', 'strategy', 'name', 'Dip'), ['```strategy', 'universe: SPY', 'name: Dip', 'buy when true', '```'].join('\n'));
});
