import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec, type Diagnostic } from '../src/dsl.ts';
import { closest, editDistance, fixChanges, fixEdits, fixFor, tickerFix, type Fix } from '../src/fixes.ts';

const errorsOf = (lines: string[]) => parseSpec(lines.join('\n')).errors;

/** The fix for the first problem that has one, found by reading the block the way the editor does. */
function firstFix(lines: string[]): { d: Diagnostic; fix: Fix } | null {
  for (const d of errorsOf(lines)) {
    const fix = fixFor(lines, d);
    if (fix) return { d, fix };
  }
  return null;
}

function apply(lines: string[], f: Fix): string[] {
  const out = [...lines];
  out[f.line - 1] = out[f.line - 1].slice(0, f.from) + f.insert + out[f.line - 1].slice(f.to);
  return out;
}

/** Applies the fix and returns the block's text after it, checking the problem is gone. */
function fixedBlock(lines: string[]): string[] {
  const found = firstFix(lines);
  assert.ok(found, `no fix for: ${errorsOf(lines).map((e) => e.message).join(' / ')}`);
  const after = apply(lines, found.fix);
  assert.ok(
    !errorsOf(after).some((e) => e.line === found.d.line && e.message === found.d.message && e.from === found.d.from),
    `the problem "${found.d.message}" is still there after the fix`,
  );
  return after;
}

const HEAD = 'universe: SPY, TLT';
const RULE = 'buy when close > sma(200)';

test('closeness: swaps count once, case does not count, the threshold grows with length', () => {
  assert.equal(editDistance('clsoe', 'close'), 1);
  assert.equal(editDistance('CLOSE', 'close'), 0);
  assert.equal(editDistance('smaa', 'sma'), 1);
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(closest('smaa', ['sma', 'ema', 'rsi']), 'sma');
  assert.equal(closest('clsoe', ['open', 'close', 'volume']), 'close');
  assert.equal(closest('rebalanse', ['never', 'rebalance', 'size']), 'rebalance');
  // Short words match nothing, however near.
  assert.equal(closest('sm', ['sma', 'ema', 'rsi']), null);
  assert.equal(closest('xx', ['xy']), null);
  // Not a typo when it is already there.
  assert.equal(closest('SMA', ['sma']), null);
  // Too far away, whatever the length.
  assert.equal(closest('banana', ['sma', 'ema', 'rsi', 'roc']), null);
  assert.equal(closest('stdv', ['stdev', 'atr']), 'stdev');
  assert.equal(closest('highst', ['highest', 'lowest']), 'highest');
});

test('closeness: ties go to the same first letter, then the longer shared start, and are otherwise left alone', () => {
  assert.equal(closest('sma5', ['sma', 'ema']), 'sma');
  assert.equal(closest('xma', ['sma', 'ema']), null);
  assert.equal(closest('emaa', ['ema', 'sma']), 'ema');
  // The same distance, but only one keeps the first letter.
  assert.equal(closest('rsa', ['rsi', 'asa']), 'rsi');
  assert.equal(closest('roi', ['roc', 'rsi']), 'roc');
  assert.equal(closest('roi', ['roc', 'rod']), null);
  // Doubled letters are as near to a longer name as to a same-length one, so neither is chosen.
  assert.equal(closest('SPYY', ['SPY', 'SPYG']), null);
});

test('a misspelt setting name', () => {
  const lines = [HEAD, 'rebalanse: monthly', RULE];
  const after = fixedBlock(lines);
  assert.equal(after[1], 'rebalance: monthly');
  const f = firstFix(lines)!.fix;
  assert.deepEqual([f.line, f.from, f.to, f.insert, f.label], [2, 0, 9, 'rebalance', 'Change to rebalance']);
  assert.equal(fixFor(lines, firstFix(lines)!.d)?.hint, 'Possible correction: rebalance.');
  assert.equal(fixedBlock([HEAD, 'stoploss: 5%', RULE])[1], 'stop loss: 5%');
  assert.equal(fixedBlock([HEAD, '  trailing stp: 5%', RULE])[1], '  trailing stop: 5%');
  assert.equal(fixedBlock([HEAD, 'Capitl: 10k', RULE])[1], 'capital: 10k');
});

test('a setting name written with an underscore, or a rule start misspelt, on a line the parser cannot place', () => {
  const lines = [HEAD, 'stop_loss: 5%', RULE];
  const d = errorsOf(lines)[0];
  assert.equal(d.from, undefined, 'the parser still gives no columns for this problem');
  assert.equal(fixedBlock(lines)[1], 'stop loss: 5%');
  assert.equal(fixedBlock([HEAD, 'buy whn close > 3'])[1], 'buy when close > 3');
  assert.equal(fixedBlock([HEAD, '  sel when close > 3'])[1], '  sell when close > 3');
});

test('a rule start misspelt on a line that continues a rule', () => {
  assert.equal(fixedBlock([HEAD, RULE, 'sel when close > 3'])[2], 'sell when close > 3');
  assert.equal(fixedBlock([HEAD, RULE, 'sell whn close > 3'])[2], 'sell when close > 3');
  assert.equal(fixedBlock([HEAD, 'sell when close > 3', 'byu when close > 3'])[2], 'buy when close > 3');
});

test('a misspelt function', () => {
  assert.equal(fixedBlock([HEAD, 'buy when close > smaa(200)'])[1], 'buy when close > sma(200)');
  assert.equal(fixedBlock([HEAD, 'buy when rsii(14) < 30'])[1], 'buy when rsi(14) < 30');
  assert.equal(fixedBlock([HEAD, 'buy when macd() > 0 and macd_signl() < 1'])[1], 'buy when macd() > 0 and macd_signal() < 1');
  assert.equal(fixedBlock([HEAD, 'buy when close > bb_uper(20, 2)'])[1], 'buy when close > bb_upper(20, 2)');
  // Uppercase is fine in the language, and the fix is written in lowercase like the reference.
  assert.equal(fixedBlock([HEAD, 'buy when close > SMAA(200)'])[1], 'buy when close > sma(200)');
});

test('a misspelt series, calendar value or position value', () => {
  assert.equal(fixedBlock([HEAD, 'buy when clsoe > sma(200)'])[1], 'buy when close > sma(200)');
  assert.equal(fixedBlock([HEAD, 'buy when volum > 5'])[1], 'buy when volume > 5');
  assert.equal(fixedBlock([HEAD, 'buy when month_stat'])[1], 'buy when month_start');
  assert.equal(fixedBlock([HEAD, 'buy when weekdy == 1'])[1], 'buy when weekday == 1');
  assert.equal(fixedBlock([HEAD, RULE, 'sell when entry_pric > 3'])[2], 'sell when entry_price > 3');
  assert.equal(fixedBlock([HEAD, RULE, 'sell when bars_hld > 3'])[2], 'sell when bars_held > 3');
});

test('a misspelt word in a condition', () => {
  assert.equal(fixedBlock([HEAD, 'buy when close crosess above sma(200)'])[1], 'buy when close crosses above sma(200)');
  assert.equal(fixedBlock([HEAD, 'buy when close crosses abov sma(200)'])[1], 'buy when close crosses above sma(200)');
  assert.equal(fixedBlock([HEAD, 'buy when close crosses belw sma(200)'])[1], 'buy when close crosses below sma(200)');
  assert.equal(fixedBlock([HEAD, 'buy when close > 1 adn rsi(2) < 3'])[1], 'buy when close > 1 and rsi(2) < 3');
  assert.equal(fixedBlock([HEAD, 'buy when close abov sma(200)'])[1], 'buy when close above sma(200)');
  assert.equal(fixedBlock([HEAD, 'buy when close is abve sma(200)'])[1], 'buy when close is above sma(200)');
});

test('a misspelt setting value', () => {
  assert.equal(fixedBlock([HEAD, 'rebalance: montly', RULE])[1], 'rebalance: monthly');
  assert.equal(fixedBlock([HEAD, 'rebalance: quarterlly', RULE])[1], 'rebalance: quarterly');
  assert.equal(fixedBlock([HEAD, 'data: yaho', RULE])[1], 'data: yahoo');
  assert.equal(fixedBlock([HEAD, 'data: binnance # prices', RULE])[1], 'data: binance # prices');
  assert.equal(fixedBlock([HEAD, 'interval: 1dd', RULE])[1], 'interval: 1d');
  assert.equal(fixedBlock(['universe: binance:BTCUSDT', 'interval: 1hh', RULE])[1], 'interval: 1h');
});

test('a value that is a different choice, not a typo, gets no fix', () => {
  // Hourly bars are real Binance bars; the problem is the source, and changing the size would hide it.
  assert.equal(firstFix([HEAD, 'interval: 1h', RULE]), null);
  assert.equal(firstFix([HEAD, 'rebalance: daily', RULE]), null);
  assert.equal(firstFix([HEAD, 'data: stooq', RULE]), null);
});

test('a ticker in a for line that is not in the universe but is close to one that is', () => {
  const lines = [HEAD, RULE, 'for TLTT:', '  buy when close > 1', '  stop loss: 5%'];
  const errors = errorsOf(lines);
  assert.deepEqual(errors.map((e) => [e.line, e.from, e.to]), [[3, 4, 8]], 'one problem, on the for line, at the name');
  const f = fixFor(lines, errors[0])!;
  assert.deepEqual([f.line, f.from, f.to, f.insert, f.label], [3, 4, 8, 'TLT', 'Change to TLT']);
  assert.deepEqual(apply(lines, f)[2], 'for TLT:');
  assert.deepEqual(errorsOf(apply(lines, f)), []);
  assert.equal(fixedBlock([HEAD, RULE, 'for tlt2:', '  stop loss: 5%'])[2], 'for TLT:');
  assert.equal(fixedBlock([HEAD, RULE, '  for   TLTT  :  # sleeve', '  stop loss: 5%'])[2], '  for   TLT  :  # sleeve');
  assert.equal(fixFor(lines, errors[0])?.hint, 'Possible correction: TLT.');
});

test('a ticker in a for line that is not close to anything gets no fix', () => {
  assert.equal(firstFix([HEAD, RULE, 'for GLD:', '  buy when close > 1']), null);
});

test('a ticker from a CSV file is matched by its file name', () => {
  assert.equal(fixedBlock(['universe: csv:Data/gold.csv, SPY', RULE, 'for gld:', '  stop loss: 5%'])[2], 'for gold:');
});

test('a misspelt parameter name', () => {
  assert.equal(fixedBlock([HEAD, 'fast = 50 in 20..100', 'buy when close > sma(fats)'])[2], 'buy when close > sma(fast)');
  assert.equal(fixedBlock([HEAD, 'stop = 8%', 'stop loss: stp', RULE])[2], 'stop loss: stop');
  assert.equal(fixedBlock([HEAD, 'limit = 5%', 'take profit: limt', RULE])[2], 'take profit: limit');
  assert.equal(fixedBlock([HEAD, 'lag = 2', 'buy when close > close[lgg]'])[2], 'buy when close > close[lag]');
  assert.equal(fixedBlock(['universe: SPY, QQQ, TLT', 'picks = 2', 'hold: top pcks by roc(20)', RULE])[2], 'hold: top picks by roc(20)');
  assert.equal(fixedBlock([HEAD, 'window = 20', 'weighting: inverse volatility(windw)', RULE])[2], 'weighting: inverse volatility(window)');
  // The nearest of several wins; a parameter of another kind is not offered where it would not parse.
  assert.equal(fixedBlock([HEAD, 'fast = 50', 'slow = 200', 'buy when sma(fsat) > sma(slow)'])[3], 'buy when sma(fast) > sma(slow)');
});

test('habits from other languages', () => {
  const and = [HEAD, 'buy when close > 5 && rsi(2) < 3'];
  assert.equal(fixedBlock(and)[1], 'buy when close > 5 and rsi(2) < 3');
  assert.equal(fixFor(and, errorsOf(and)[0])?.hint, 'Write and, not &&.');
  assert.equal(fixedBlock([HEAD, 'buy when close > 5||rsi(2) < 3'])[1], 'buy when close > 5 or rsi(2) < 3');
  assert.equal(fixedBlock([HEAD, 'buy when close > 5 & rsi(2) < 3'])[1], 'buy when close > 5 and rsi(2) < 3');
  assert.equal(fixedBlock([HEAD, 'buy when !close > 5'])[1], 'buy when not close > 5');
  assert.equal(fixedBlock([HEAD, 'buy when !(close > 5)'])[1], 'buy when not (close > 5)');
  assert.equal(fixedBlock([HEAD, 'buy when close => 5'])[1], 'buy when close >= 5');
  assert.equal(fixedBlock([HEAD, 'buy when close =< sma(5)'])[1], 'buy when close <= sma(5)');
  assert.equal(fixedBlock([HEAD, 'buy when close>=5 && close=>3'])[1], 'buy when close>=5 and close=>3');
  const f = firstFix([HEAD, 'buy when close => 5'])!.fix;
  assert.deepEqual([f.from, f.to, f.insert, f.label], [15, 17, '>=', 'Change to >=']);
});

test('"entry" or "bars" alone, with the second word missing or misspelt', () => {
  assert.equal(fixedBlock([HEAD, RULE, 'sell when bars hled > 3'])[2], 'sell when bars held > 3');
  assert.equal(fixedBlock([HEAD, RULE, 'sell when entry prce > 3'])[2], 'sell when entry price > 3');
  assert.equal(fixedBlock([HEAD, RULE, 'sell when entry > 3'])[2], 'sell when entry price > 3');
});

test('no fix where nothing is near enough, or where the fix would not remove the problem', () => {
  assert.equal(firstFix([HEAD, 'buy when foo(10) > close']), null);
  assert.equal(firstFix([HEAD, 'buy when close > zzzzz']), null);
  assert.equal(firstFix([HEAD, 'colour: red', RULE]), null);
  // `sm` is too short to be sure, and `xma` is as near to sma as to ema.
  assert.equal(firstFix([HEAD, 'buy when close > sm(200)']), null);
  assert.equal(firstFix([HEAD, 'buy when close > xma(200)']), null);
  // A position value can only be read in a sell rule, so "entry_pric" in a buy rule has no fix.
  assert.equal(firstFix([HEAD, 'buy when close > entry_pric']), null);
});

test('a fix is never offered when the edit gives the line a new problem', () => {
  // `sma` needs a period, so changing the misspelt name to it would leave "needs a period".
  assert.equal(firstFix([HEAD, 'buy when close > smaa()']), null);
});

test('a warning gets no fix, and neither does a problem that is not about a word', () => {
  const warn = parseSpec([HEAD, 'buy when close > 100'].join('\n')).warnings[0];
  assert.equal(fixFor([HEAD, 'buy when close > 100'], warn), null);
  assert.equal(firstFix(['universe: SPY']), null);
  assert.equal(firstFix([HEAD, 'costs: lots', RULE]), null);
});

test('the fix is checked against the defaults the block is read with', () => {
  const lines = [HEAD, 'rebalanse: monthly', RULE];
  const d = errorsOf(lines)[0];
  assert.ok(fixFor(lines, d, { dataSource: 'binance' }));
});

test('the parser still gives the columns these fixes rely on', () => {
  // If any of these start to differ, fixFor places its edits from the line instead and these cases need a look.
  const cases: [string[], RegExp, string][] = [
    [[HEAD, 'rebalanse: monthly', RULE], /^Unknown setting/, 'rebalanse'],
    [[HEAD, 'buy when close > smaa(200)'], /^Unknown name/, 'smaa'],
    [[HEAD, 'buy when close crosess above 1'], /^Unexpected "crosess"/, 'crosess'],
    [[HEAD, 'buy when close crosses abov 1'], /^Unknown name "abov"/, 'abov'],
    [[HEAD, 'rebalance: montly', RULE], /must be one of/, 'montly'],
    [[HEAD, 'buy when close > 1 && 2'], /^Unexpected character "&"/, '&'],
  ];
  for (const [lines, re, text] of cases) {
    const d = errorsOf(lines).find((e) => re.test(e.message))!;
    assert.ok(d, `no problem matching ${re}`);
    assert.equal(lines[d.line - 1].slice(d.from, d.to), text);
  }
});

test('tickerFix: the nearest known ticker, with a source prefix kept', () => {
  const lines = ['universe: SPYY, TLT', RULE];
  assert.equal(tickerFix(lines, { line: 1, from: 10, to: 14 }, ['SPY', 'SPYG']), null, 'two equally near candidates');
  const f = tickerFix(lines, { line: 1, from: 10, to: 14 }, ['SPY', 'GLD'])!;
  assert.deepEqual([f.line, f.from, f.to, f.insert, f.label], [1, 10, 14, 'SPY', 'Change to SPY']);
  assert.equal(apply(lines, f)[0], 'universe: SPY, TLT');
  const prefixed = ['universe: binance:BTCUSDTT', RULE];
  const g = tickerFix(prefixed, { line: 1, from: 10, to: 26 }, ['BTCUSDT', 'BTCUSDC'])!;
  assert.equal(apply(prefixed, g)[0], 'universe: binance:BTCUSDT');
  assert.equal(tickerFix(lines, { line: 1, from: 10, to: 14 }, ['GLD', 'QQQ']), null);
  assert.equal(tickerFix(lines, { line: 1, from: 10, to: 14 }, []), null);
  // A candidate already in the universe would make the ticker appear twice.
  assert.equal(tickerFix(['universe: SPYY, SPY', RULE], { line: 1, from: 10, to: 14 }, ['SPY']), null);
  // Yahoo spells some tickers with characters the distance has to treat as letters.
  const odd = ['universe: BRK.B', RULE];
  assert.equal(apply(odd, tickerFix(odd, { line: 1, from: 10, to: 15 }, ['BRK-B'])!)[0], 'universe: BRK-B');
});

/** The block after every edit of a fix, in the coordinates of the block before it. */
function applyAll(lines: string[], f: Fix): string[] {
  const out = [...lines];
  const edits = fixEdits(f).sort((a, b) => b.line - a.line || b.from - a.from);
  for (const e of edits) out[e.line - 1] = out[e.line - 1].slice(0, e.from) + e.insert + out[e.line - 1].slice(e.to);
  return out;
}

const problems = (lines: string[]) => {
  const { errors, warnings } = parseSpec(lines.join('\n'));
  return [...errors, ...warnings].map((d) => `${d.line}: ${d.message}`);
};

test('tickerFix: the same ticker named on `for` lines and after `of` changes with it, so the block stays consistent', () => {
  const lines = ['universe: SPYY, QQQ', 'buy when close > sma(50)', 'for SPYY:', '  stop loss: 5%'];
  assert.deepEqual(problems(lines), []);
  const f = tickerFix(lines, { line: 1, from: 10, to: 14 }, ['SPY', 'GLD'])!;
  assert.ok(f);
  assert.equal(f.label, 'Change to SPY (2 places)');
  assert.equal(f.hint, 'Possible correction: SPY.');
  assert.deepEqual(applyAll(lines, f), ['universe: SPY, QQQ', 'buy when close > sma(50)', 'for SPY:', '  stop loss: 5%']);
  assert.deepEqual(problems(applyAll(lines, f)), []);

  const of = ['universe: SPYY, QQQ', 'buy when close of SPYY > sma(50) of spyy', 'for spyy:', '  stop loss: 5%'];
  const g = tickerFix(of, { line: 1, from: 10, to: 14 }, ['SPY'])!;
  assert.deepEqual(applyAll(of, g), ['universe: SPY, QQQ', 'buy when close of SPY > sma(50) of SPY', 'for SPY:', '  stop loss: 5%']);
  assert.deepEqual(problems(applyAll(of, g)), []);
  assert.equal(g.label, 'Change to SPY (4 places)');
});

test('tickerFix: a prefix is kept where it is written, and a prefix of another source is another ticker', () => {
  const lines = ['universe: binance:BTCUSDTT', 'buy when close > sma(20)', 'for BTCUSDTT:', '  stop loss: 5%', 'sell when close of yahoo:BTCUSDTT < sma(20)'];
  const f = tickerFix(lines, { line: 1, from: 10, to: 26 }, ['BTCUSDT'])!;
  const after = applyAll(lines, f);
  assert.equal(after[0], 'universe: binance:BTCUSDT');
  assert.equal(after[2], 'for BTCUSDT:');
  assert.equal(after[4], 'sell when close of yahoo:BTCUSDTT < sma(20)');
  assert.deepEqual(problems(after), []);
});

test('tickerFix: a fix that gives the block a new problem anywhere in it is not offered', () => {
  // SPY would clash with the file named spy.csv, which a rule on another line reads.
  const lines = ['universe: SPYY, QQQ', 'buy when close of csv:Data/spy.csv > 1'];
  assert.deepEqual(problems(lines), []);
  assert.equal(tickerFix(lines, { line: 1, from: 10, to: 14 }, ['SPY']), null);
  // The same edit is fine when the block has no such file.
  assert.ok(tickerFix(['universe: SPYY, QQQ', 'buy when close > 1'], { line: 1, from: 10, to: 14 }, ['SPY']));
});

test('tickerFix: problems the block already had do not stop a fix, even when they name the ticker', () => {
  const lines = ['universe: SPYY, QQQ', 'colour: red', 'buy when close > sma(50)', 'for SPYY:', '  stop loss: 5%'];
  assert.ok(problems(lines).length > 0);
  const f = tickerFix(lines, { line: 1, from: 10, to: 14 }, ['SPY'])!;
  assert.ok(f);
  assert.deepEqual(problems(applyAll(lines, f)), problems(lines));
});

test('fixChanges: every edit of a fix as a position in the note, none when a line is missing', () => {
  const lines = ['universe: SPYY, QQQ', 'buy when close > sma(50)', 'for SPYY:', '  stop loss: 5%'];
  const f = tickerFix(lines, { line: 1, from: 10, to: 14 }, ['SPY'])!;
  // The block starts at line 5 of a note whose lines are 30 characters apart.
  const start = (line: number) => (line <= lines.length ? (4 + line - 1) * 30 : null);
  assert.deepEqual(fixChanges(f, start), [
    { from: 120 + 10, to: 120 + 14, insert: 'SPY' },
    { from: 180 + 4, to: 180 + 8, insert: 'SPY' },
  ]);
  assert.equal(fixChanges(f, (line) => (line === 1 ? 0 : null)), null);
  const one = fixFor(['universe: SPY', 'buy when close > smaa(200)'], parseSpec('universe: SPY\nbuy when close > smaa(200)').errors[0])!;
  assert.deepEqual(fixChanges(one, (line) => line * 100), [{ from: 200 + 17, to: 200 + 21, insert: 'sma' }]);
});

test('an add rule\'s start misspelt is offered a fix as buy and sell are', () => {
  const entries = [HEAD, 'entries: 2', RULE];
  assert.equal(fixedBlock([...entries, 'ad when close > last entry price'])[3], 'add when close > last entry price');
  assert.equal(fixedBlock([...entries, 'add wen close > last entry price'])[3], 'add when close > last entry price');
  assert.equal(fixedBlock([...entries, 'ad wen close > last entry price'])[3], 'add when close > last entry price');
  assert.equal(fixedBlock([...entries, '  dad when close > last entry price'])[3], '  add when close > last entry price');
  // On a line that continues another rule, and with the sell rule before it.
  assert.equal(fixedBlock([...entries, 'sell when close < sma(100)', 'ad when close > last entry price'])[4], 'add when close > last entry price');
  const found = firstFix([...entries, 'add wen close > 3'])!;
  assert.equal(found.fix.hint, 'Possible correction: add when.');
  // A word that is already a rule head is not a typo, and the two-letter reach is only for a rule head.
  assert.equal(closest('ad', ['buy', 'sell', 'add']), null);
  assert.equal(fixedBlock([HEAD, 'by when close > 3'])[1], 'buy when close > 3');
});

test('a short or cover rule\'s start misspelt is offered a fix as buy and sell are', () => {
  assert.equal(fixedBlock([HEAD, 'shrt when close < sma(200)'])[1], 'short when close < sma(200)');
  assert.equal(fixedBlock([HEAD, 'short wen close < sma(200)'])[1], 'short when close < sma(200)');
  const short = [HEAD, 'short when close < sma(200)'];
  assert.equal(fixedBlock([...short, 'covr when close > sma(200)'])[2], 'cover when close > sma(200)');
  assert.equal(fixedBlock([...short, '  cvoer when close > sma(200)'])[2], '  cover when close > sma(200)');
  assert.equal(firstFix([...short, 'cover wen close > 3'])!.fix.hint, 'Possible correction: cover when.');
});

test('a parameter written for the number of entries, misspelt, is offered the parameter', () => {
  const lines = [HEAD, 'steps = 3 in 2..5', 'entries: stepz', RULE, 'add when close > last entry price * 1.01'];
  const found = firstFix(lines)!;
  assert.equal(found.fix.hint, 'Possible correction: steps.');
  assert.equal(apply(lines, found.fix)[2], 'entries: steps');
});
