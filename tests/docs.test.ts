import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ALL_DOCS, FIXED_VALUES, docFor, functionSignature, helpAt, shortOf, valueId } from '../src/docs.ts';
import { BINANCE_INTERVALS, CALENDAR, INDICATORS, POSITION, REBALANCE, SERIES, SETTINGS, parseSpec } from '../src/dsl.ts';

test('every setting, function, series, calendar value, position value and fixed value has an entry', () => {
  const missing: string[] = [];
  const need = (id: string) => {
    if (!docFor(id)) missing.push(id);
  };
  SETTINGS.forEach(need);
  [...Object.keys(INDICATORS), 'min', 'max', 'abs'].forEach(need);
  SERIES.forEach(need);
  CALENDAR.forEach(need);
  Object.values(POSITION).forEach(need);
  ['buy when', 'sell when', 'for', 'for all', 'and', 'or', 'not', 'crosses above', 'crosses below', 'above', 'below', 'of', '[n]', 'in … step', 'top … by', '%', 'bps'].forEach(need);
  for (const [key, values] of Object.entries(FIXED_VALUES)) values.forEach((v) => need(valueId(key, v)));
  assert.deepEqual(missing, []);
});

test('the fixed values are the ones the language accepts', () => {
  assert.deepEqual(FIXED_VALUES.rebalance, REBALANCE);
  assert.deepEqual(FIXED_VALUES.interval, BINANCE_INTERVALS);
  assert.deepEqual(FIXED_VALUES.fill, ['next open', 'close']);
  for (const v of FIXED_VALUES.data) assert.deepEqual(parseSpec(`universe: SPY\ndata: ${v}\nbuy when true`).errors, []);
});

test('each entry has a signature, a text of one or two sentences, a short form and an example', () => {
  for (const d of ALL_DOCS) {
    assert.ok(d.signature, `${d.id}: no signature`);
    assert.ok(d.short && !/[.!]$/.test(d.short), `${d.id}: short form is missing or ends with a full stop`);
    assert.ok(d.example, `${d.id}: no example`);
    const sentences = d.text.split(/(?<=[.])\s+(?=[A-Z])/);
    assert.ok(sentences.length <= 2, `${d.id}: ${sentences.length} sentences`);
    assert.ok(d.text.endsWith('.'), `${d.id}: the text should end with a full stop`);
    assert.ok(!/!|\p{Extended_Pictographic}/u.test(d.text + d.short), `${d.id}: no exclamation marks or emoji`);
  }
  assert.equal(new Set(ALL_DOCS.map((d) => d.id)).size, ALL_DOCS.length, 'duplicate ids');
});

/** A minimal valid block holding the example: settings above a rule, rules and for lines after a buy rule. */
function blockAround(example: string): string {
  const lines = example.split('\n');
  const own = (re: RegExp) => lines.some((l) => re.test(l));
  const head = lines.filter((l) => !/^\s*(buy|sell)\s+when\b|^\s*for\s/i.test(l));
  const rules = lines.filter((l) => /^\s*(buy|sell)\s+when\b|^\s*for\s/i.test(l));
  return [
    ...(own(/^(universe|symbol)\s*:/i) ? [] : ['universe: SPY, QQQ, TLT']),
    ...head,
    ...(own(/^\s*buy\s+when\b/i) ? [] : ['buy when close > sma(200)']),
    ...rules,
  ].join('\n');
}

test('every example parses in a minimal block', () => {
  const failures: string[] = [];
  for (const d of ALL_DOCS) {
    const block = blockAround(d.example);
    const { errors } = parseSpec(block);
    if (errors.length) failures.push(`${d.id}: ${errors.map((e) => `line ${e.line}: ${e.message}`).join('; ')}\n${block}`);
  }
  assert.deepEqual(failures, []);
});

test('the block around an example is the shape the test claims', () => {
  assert.equal(blockAround('rebalance: monthly'), 'universe: SPY, QQQ, TLT\nrebalance: monthly\nbuy when close > sma(200)');
  assert.equal(blockAround('sell when bars held >= 20'), 'universe: SPY, QQQ, TLT\nbuy when close > sma(200)\nsell when bars held >= 20');
  assert.equal(blockAround('symbol: SPY'), 'symbol: SPY\nbuy when close > sma(200)');
  assert.equal(blockAround('for TLT:'), 'universe: SPY, QQQ, TLT\nbuy when close > sma(200)\nfor TLT:');
});

test('every function signature carries the defaults from INDICATORS', () => {
  for (const [name, def] of Object.entries(INDICATORS)) {
    const sig = docFor(name)!.signature;
    assert.equal(sig, functionSignature(name));
    const m = sig.match(/^(\w+)\((.*)\)$/);
    assert.ok(m && m[1] === name, `${name}: ${sig}`);
    const args = m![2] === '' ? [] : m![2].split(', ');
    // A function that needs a series or a condition first shows it before its numbers, with no default.
    const lead = def.lead ? 1 : 0;
    assert.equal(args.length, def.params.length + lead, `${name}: ${sig} has the wrong number of arguments`);
    args.slice(lead).forEach((a, i) => {
      const [, dflt] = a.split(' = ');
      assert.equal(dflt === undefined ? null : Number(dflt), def.params[i], `${name} argument ${i}: ${a}`);
    });
    // The text says which series a function reads, from the same table.
    const t = docFor(name)!.text;
    assert.ok(def.src === null ? t.includes('no series') : t.includes(`reads ${def.src}`), `${name}: ${t}`);
  }
  assert.equal(docFor('rsi')!.signature, 'rsi(n = 14)');
  assert.equal(docFor('macd_signal')!.signature, 'macd_signal(fast = 12, slow = 26, signal = 9)');
  assert.equal(docFor('sma')!.signature, 'sma(n)');
});

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replaceAll('`', '');

test('texts say what the README says, in its words, where it states a rule', () => {
  const same: [string, string][] = [
    ['roc', 'as a fraction'],
    ['%', 'counts as the number 0.05 wherever a number is expected'],
    ['bps', 'hundredths of a percent'],
    ['of', 'latest bar that had ended by the time this bar ended'],
    ['of', 'does not have to be in the universe'],
    ['bars held', 'completed bars since the buy filled'],
    ['bars held', 'it is 0 on the bar of the fill'],
    ['entry price', 'the price the position was bought at, slippage included'],
    ['crosses above', 'a is above b and was at or below b on the previous bar'],
    ['highest', 'Highest high of the last n bars, this bar included'],
    ['lowest', 'Lowest low of the last n bars, this bar included'],
    ['stdev', 'Standard deviation of the last n closes'],
    ['month_start', 'the first bar of a month'],
    ['month_end', 'the last bar of a month'],
    ['weekday', '1 for Monday to 7 for Sunday'],
    ['stop loss', 'above 0% and at most 99%'],
    ['trailing stop', 'above 0% and at most 99%'],
    ['take profit', 'above 0% and at most 1000%'],
    ['cash rate', 'such as ^IRX'],
    ['weighting', 'The period must be at least 2'],
    ['risk per trade', 'cannot be used with weighting, or with a rebalance other than never'],
    ['test from', 'lie after from and before to'],
    ['to', 'whole day included'],
    ['rebalance=weekly', 'Weeks start on Monday'],
    ['data=yahoo', 'SPY, BRK-B, BTC-USD'],
    ['data=binance', 'BTCUSDT'],
    ['data', 'comes from Yahoo whatever data says'],
  ];
  const lower = (x: string) => x.toLowerCase();
  const missing = same.filter(([id, phrase]) => !lower(docFor(id)!.text).includes(lower(phrase)) || !lower(readme).includes(lower(phrase)));
  assert.deepEqual(missing, []);
});

test('the short forms are one line and come from the same table', () => {
  assert.equal(shortOf('rebalance=monthly'), docFor('rebalance=monthly')!.short);
  assert.equal(shortOf('nothing'), '');
  for (const d of ALL_DOCS) assert.ok(!d.short.includes('\n'), d.id);
});

const BLOCK = [
  'name: Trend',
  'universe: SPY 60%, TLT 40%',
  'rebalance: monthly',
  'stop loss: 2 atr(14)',
  'costs: 5 bps',
  'fast = 50 in 20..100 step 10',
  'stop = 8%',
  'lag = 2',
  '',
  'buy when sma(fast) crosses above sma(200) and close[lag] is above 5%',
  '  or not bars_held > 3',
  'sell when bars held >= 20 or close < entry price * 0.9 or close of ^VIX > roc(20)',
  'for all:',
  '  stop loss: stop',
  'hold: top 3 by roc(fast)',
  'interval: 1h',
];

/** The entry and the text it covers for the character at `col` of line `row`. */
function at(row: number, col: number) {
  const t = helpAt(BLOCK, row, col);
  return t ? { id: t.doc.id, text: BLOCK[row].slice(t.from, t.to) } : null;
}
const where = (row: number, needle: string, nth = 0) => {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = BLOCK[row].indexOf(needle, i + 1);
  assert.ok(i >= 0, `${needle} not on line ${row}`);
  return i;
};

test('help for a setting name, whole when it has two words', () => {
  assert.deepEqual(at(0, 2), { id: 'name', text: 'name' });
  assert.deepEqual(at(3, 0), { id: 'stop loss', text: 'stop loss' });
  assert.deepEqual(at(3, 6), { id: 'stop loss', text: 'stop loss' });
  assert.deepEqual(at(3, 8), { id: 'stop loss', text: 'stop loss' });
  assert.equal(at(3, 9), null);
});

test('help for a fixed setting value, and for units', () => {
  assert.deepEqual(at(2, where(2, 'monthly') + 3), { id: 'rebalance=monthly', text: 'monthly' });
  assert.deepEqual(at(15, where(15, '1h')), { id: 'interval=1h', text: '1h' });
  assert.deepEqual(at(15, where(15, '1h') + 1), { id: 'interval=1h', text: '1h' });
  assert.deepEqual(at(4, where(4, 'bps')), { id: 'bps', text: '5 bps' });
  assert.deepEqual(at(1, where(1, '60%')), { id: '%', text: '60%' });
  assert.equal(at(1, where(1, 'SPY')), null);
});

test('help for functions, series, calendar words and position values inside rules', () => {
  assert.deepEqual(at(9, where(9, 'sma')), { id: 'sma', text: 'sma' });
  assert.deepEqual(at(9, where(9, 'sma', 1) + 1), { id: 'sma', text: 'sma' });
  assert.deepEqual(at(3, where(3, 'atr')), { id: 'atr', text: 'atr' });
  assert.deepEqual(at(9, where(9, 'close') + 2), { id: 'close', text: 'close' });
  assert.deepEqual(at(11, where(11, 'bars held') + 5), { id: 'bars held', text: 'bars held' });
  assert.deepEqual(at(10, where(10, 'bars_held') + 2), { id: 'bars held', text: 'bars_held' });
  assert.deepEqual(at(11, where(11, 'entry price') + 8), { id: 'entry price', text: 'entry price' });
  // The numbers and operators in between say nothing.
  assert.equal(at(9, where(9, '200')), null);
  assert.equal(at(11, where(11, ' >= ')), null);
});

test('help for rule words: heads, two-word comparisons, "is above", "of", not', () => {
  assert.deepEqual(at(9, 0), { id: 'buy when', text: 'buy when' });
  assert.deepEqual(at(9, 6), { id: 'buy when', text: 'buy when' });
  assert.deepEqual(at(11, 2), { id: 'sell when', text: 'sell when' });
  assert.deepEqual(at(9, where(9, 'crosses')), { id: 'crosses above', text: 'crosses above' });
  assert.deepEqual(at(9, where(9, 'above')), { id: 'crosses above', text: 'crosses above' });
  assert.deepEqual(at(9, where(9, ' and ') + 2), { id: 'and', text: 'and' });
  assert.deepEqual(at(9, where(9, 'is above')), { id: 'above', text: 'is above' });
  assert.deepEqual(at(10, where(10, 'or') + 1), { id: 'or', text: 'or' });
  assert.deepEqual(at(10, where(10, 'not')), { id: 'not', text: 'not' });
  assert.deepEqual(at(11, where(11, 'of')), { id: 'of', text: 'of' });
  assert.equal(at(11, where(11, '^VIX')), null);
});

test('help for for lines, the lag, a parameter line and hold', () => {
  assert.deepEqual(at(12, 1), { id: 'for all', text: 'for all' });
  assert.deepEqual(at(12, 5), { id: 'for all', text: 'for all' });
  assert.deepEqual(at(9, where(9, '[')), { id: '[n]', text: '[lag]' });
  assert.deepEqual(at(5, where(5, 'in')), { id: 'in … step', text: 'in' });
  assert.deepEqual(at(5, where(5, 'step')), { id: 'in … step', text: 'step' });
  assert.deepEqual(at(5, where(5, '..')), { id: 'in … step', text: '..' });
  assert.deepEqual(at(14, where(14, 'top')), { id: 'top … by', text: 'top' });
  assert.deepEqual(at(14, where(14, 'by')), { id: 'top … by', text: 'by' });
});

test('a parameter, wherever it is used, shows its declared value and range', () => {
  const tip = (row: number, col: number) => helpAt(BLOCK, row, col)!.doc;
  const fast = tip(5, 1);
  assert.equal(fast.kind, 'parameter');
  assert.equal(fast.signature, 'fast = 50 in 20..100 step 10');
  assert.match(fast.text, /set to 50, with a range of 20 to 100 in steps of 10/);
  assert.equal(tip(9, where(9, 'fast')).signature, fast.signature);
  assert.equal(tip(14, where(14, 'fast')).signature, fast.signature);
  const stop = tip(13, where(13, 'stop', 1));
  assert.match(stop.text, /set to 8%, with no range/);
  assert.match(stop.text, /counts as the number 0.08/);
  assert.match(tip(9, where(9, 'lag') + 1).text, /set to 2, with no range/);
});

test('nothing for a comment, a blank, a plain name or a ticker', () => {
  const lines = ['name: Trend # buy when', 'universe: SPY', '', 'buy when close > 1  # sma(200)'];
  assert.equal(helpAt(lines, 0, 10), null);
  assert.equal(helpAt(lines, 1, 11), null);
  assert.equal(helpAt(lines, 2, 0), null);
  assert.equal(helpAt(lines, 3, 22), null);
  assert.equal(helpAt(lines, 3, 99), null);
  assert.equal(helpAt(lines, 9, 0), null);
  assert.equal(helpAt(lines, 3, -1), null);
});

test('fill has help and values keyed by its name', () => {
  assert.equal(docFor('fill')!.example, 'fill: close');
  assert.equal(docFor('fill=next open')!.example, 'fill: next open');
  assert.equal(valueId('Fill', 'Next  Open'), 'fill=next open');
});

test('hovering fill and its values shows their help', () => {
  const lines = ['universe: SPY', 'fill: next open', 'fill: close', 'buy when true'];
  const id = (row: number, col: number) => helpAt(lines, row, col)?.doc.id;
  assert.equal(id(1, 1), 'fill');
  assert.equal(id(1, 8), 'fill=next open');
  assert.equal(id(1, 12), 'fill=next open');
  assert.equal(id(2, 8), 'fill=close');
  assert.deepEqual(helpAt(lines, 1, 8) && [helpAt(lines, 1, 8)!.from, helpAt(lines, 1, 8)!.to], [6, 15]);
});
