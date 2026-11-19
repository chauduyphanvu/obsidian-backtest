import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAccount } from '../src/account.ts';
import { parseCompare } from '../src/compare.ts';
import { NOTE_CHANGED, findBlock, setSettingInNote, setWeightsInNote, withWeight, writeInNote } from '../src/rewrite.ts';

test('a weight is put in place of the one a line has, or after the note when it has none', () => {
  assert.equal(withWeight('[[Trend following]] 40%', 35), '[[Trend following]] 35%');
  assert.equal(withWeight('[[Trend following]]   12.5 %', 7), '[[Trend following]]   7 %');
  assert.equal(withWeight('[[Trend following]]', 60), '[[Trend following]] 60%');
  assert.equal(withWeight('  Research/Old.md#Second one 0%  ', 25), '  Research/Old.md#Second one 25%');
  // A number in the label is not a weight.
  assert.equal(withWeight('[[A|Top 10%]]', 30), '[[A|Top 10%]] 30%');
  assert.equal(withWeight('[[A]] 40%', 0), '[[A]] 0%');
  // A weight written right after the link, as a compare or account block reads it, is replaced too, and the line still reads.
  assert.equal(withWeight('[[Trend]]40%', 35), '[[Trend]]35%');
  const read = parseCompare(['[[Trend]]40%', '[[Dip]] 60%'].map((l, i) => (i === 0 ? withWeight(l, 35) : withWeight(l, 65))).join('\n'));
  assert.deepEqual([read.errors, read.entries.map((e) => e.weight)], [[], [0.35, 0.65]]);
});

const fence = '```';
const COMPARE = ['# Ideas', '', `${fence}compare`, '[[Trend following]] 40%', '[[Pullbacks#QQQ RSI pullback]] 60%', fence, 'After'].join('\n');

test('weights are written on the lines that name the strategies, and only there', () => {
  const source = '[[Trend following]] 40%\n[[Pullbacks#QQQ RSI pullback]] 60%';
  const { entries } = parseCompare(source);
  const next = setWeightsInNote(COMPARE, 2, source, 'compare', entries.map((e, i) => ({ line: e.line, percent: [25, 75][i] })));
  assert.equal(next, COMPARE.replace('40%', '25%').replace('60%', '75%'));
  // The block read back has the new weights.
  assert.deepEqual(parseCompare(findBlock(next!, 2, source.replace('40%', '25%').replace('60%', '75%'), 'compare')!.block.source).entries.map((e) => e.weight), [0.25, 0.75]);
});

test('a block whose text changed since it was drawn, or another language at that line, gets nothing', () => {
  const source = '[[Trend following]] 40%\n[[Pullbacks#QQQ RSI pullback]] 60%';
  assert.equal(setWeightsInNote(COMPARE, 2, `${source}\n[[More]] 10%`, 'compare', [{ line: 1, percent: 30 }]), null);
  assert.equal(setWeightsInNote(COMPARE, 2, source, 'account', [{ line: 1, percent: 30 }]), null);
  assert.equal(setWeightsInNote(COMPARE, 3, source, 'compare', [{ line: 1, percent: 30 }]), null);
  // A strategy block is still found without saying its language.
  const note = `${fence}strategy\nuniverse: SPY\nbuy when true\n${fence}`;
  assert.equal(findBlock(note, 0, 'universe: SPY\nbuy when true')?.index, 0);
});

test('in a callout every line keeps its markers, and Windows line endings stay', () => {
  const note = ['> [!note] Accounts', `> ${fence}account`, '> cash: 1,000', '> [[A]] 50%', '> [[B]] 50%', `> ${fence}`].join('\r\n');
  const source = 'cash: 1,000\n[[A]] 50%\n[[B]] 50%';
  const next = setWeightsInNote(note, 1, source, 'account', [{ line: 2, percent: 70 }, { line: 3, percent: 30 }]);
  assert.equal(next, note.replace('[[A]] 50%', '[[A]] 70%').replace('[[B]] 50%', '[[B]] 30%'));
  const set = setSettingInNote(note, 1, source, 'account', 'fills columns', 'date = Run Date');
  assert.equal(set, note.replace('> cash: 1,000\r\n', '> cash: 1,000\r\n> fills columns: date = Run Date\r\n'));
});

const ACCOUNT = [`${fence}account`, 'name: Main', 'cash: 4,200', '  fills: Broker/x.csv', '', '[[A]] 60%', '[[B]] 40%', fence].join('\n');
const SOURCE = 'name: Main\ncash: 4,200\n  fills: Broker/x.csv\n\n[[A]] 60%\n[[B]] 40%';

test('a setting is written in place of the line that sets it, keeping its indent', () => {
  const next = setSettingInNote(ACCOUNT, 0, SOURCE, 'account', 'fills', 'Broker/y.csv');
  assert.equal(next, ACCOUNT.replace('  fills: Broker/x.csv', '  fills: Broker/y.csv'));
  // However its name is spelled.
  const caps = ACCOUNT.replace('  fills:', '  Fills :');
  assert.equal(setSettingInNote(caps, 0, SOURCE.replace('  fills:', '  Fills :'), 'account', 'fills', 'z.csv'), ACCOUNT.replace('  fills: Broker/x.csv', '  fills: z.csv'));
});

test('a new setting goes after the last line that sets something, or first', () => {
  const next = setSettingInNote(ACCOUNT, 0, SOURCE, 'account', 'fills columns', 'price = Px');
  assert.equal(next, ACCOUNT.replace('  fills: Broker/x.csv\n', '  fills: Broker/x.csv\nfills columns: price = Px\n'));
  const { config, errors } = parseAccount(SOURCE.replace('  fills: Broker/x.csv\n', '  fills: Broker/x.csv\nfills columns: price = Px\n'));
  assert.deepEqual(config.fillColumns, { price: 'Px' });
  assert.deepEqual(errors.map((e) => e.message), ['Add a fills from line: the first day that the account followed its strategies, for example fills from: 2026-06-01']);
  const bare = [`${fence}account`, '[[A]]', fence].join('\n');
  assert.equal(setSettingInNote(bare, 0, '[[A]]', 'account', 'cash', '100'), [`${fence}account`, 'cash: 100', '[[A]]', fence].join('\n'));
});

test('a write through the note goes through only when the block is as drawn, and says so when not', async () => {
  let note = ACCOUNT;
  const process = async (edit: (text: string) => string) => (note = edit(note));
  await writeInNote(process, 0, (text, line) => setSettingInNote(text, line, SOURCE, 'account', 'cash', '5,000'));
  assert.ok(note.includes('cash: 5,000'));
  const before = note;
  await assert.rejects(writeInNote(process, 0, (text, line) => setSettingInNote(text, line, SOURCE, 'account', 'cash', '6,000')), { message: NOTE_CHANGED });
  assert.equal(note, before);
  await assert.rejects(writeInNote(process, undefined, () => 'x'), { message: NOTE_CHANGED });
});
