import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closesFence, fenceOf, findBlocks } from '../src/blocks.ts';
import { parseSpec } from '../src/dsl.ts';
import { blockTickers } from '../src/symbols.ts';
import { analyzeBlock, blockDiagnostics, fixForDiagnostic, placeDiagnostic, runStep, unknownTickers, type BlockDiagnostic } from '../src/diagnostics.ts';
import { applyFix } from '../src/fixes.ts';

/** Where a diagnostic points: line, columns, severity and the text under it. */
const at = (lines: string[], d: BlockDiagnostic) => [d.line, d.from, d.to, d.severity, lines[d.line].slice(d.from, d.to)];

function checked(lines: string[], defaults = {}): BlockDiagnostic[] {
  const out = blockDiagnostics(lines, defaults);
  for (const d of out) {
    assert.ok(d.line >= 0 && d.line < lines.length, `line ${d.line} is outside the block`);
    assert.ok(0 <= d.from && d.from < d.to && d.to <= lines[d.line].length, `range ${d.from}..${d.to} is outside ${JSON.stringify(lines[d.line])}`);
  }
  return out;
}

const HEAD = ['universe: SPY', 'buy when close > sma(200)'];

test('a block that reads cleanly, and an empty one, give nothing', () => {
  assert.deepEqual(checked([...HEAD, 'sell when close < sma(200)']), []);
  assert.deepEqual(blockDiagnostics([]), []);
  assert.deepEqual(blockDiagnostics(['']), []);
  assert.deepEqual(blockDiagnostics(['', '   ', '\t']), []);
});

test('an unknown function or name is underlined on its own', () => {
  const lines = ['universe: SPY', 'buy when foo(10) > close'];
  const [d, ...rest] = checked(lines);
  assert.deepEqual(rest, []);
  assert.deepEqual(at(lines, d), [1, 9, 12, 'error', 'foo']);
  assert.match(d.message, /^Unknown name "foo"/);
});

test('an unknown setting is underlined by name', () => {
  const lines = [...HEAD, '', 'colour: red'];
  const [d, ...rest] = checked(lines);
  assert.deepEqual(rest, []);
  assert.deepEqual(at(lines, d), [3, 0, 6, 'error', 'colour']);
  assert.match(d.message, /^Unknown setting "colour"/);
});

test('a setting without a value is underlined by its name', () => {
  const lines = ['universe: SPY', 'costs:', 'buy when close > sma(200)'];
  const out = checked(lines);
  assert.deepEqual(out.map((d) => at(lines, d)), [[1, 0, 5, 'error', 'costs']]);
  assert.equal(out[0].message, '"costs" has no value');
});

test('a bad date is underlined, and so is a bad cost', () => {
  const dates = ['universe: SPY', 'from: 2015-13-45x', 'buy when close > sma(200)'];
  const [d] = checked(dates);
  assert.deepEqual(at(dates, d), [1, 6, 17, 'error', '2015-13-45x']);
  assert.match(d.message, /is not a date/);
  const costs = ['universe: SPY', 'costs: five', ...HEAD.slice(1)];
  assert.deepEqual(at(costs, checked(costs)[0]), [1, 7, 11, 'error', 'five']);
});

test('an unbalanced parenthesis on a continuation line is reported on that line', () => {
  const lines = [...HEAD, '  and (rsi(14) < 30'];
  const [d, ...rest] = checked(lines);
  assert.deepEqual(rest, []);
  assert.deepEqual(at(lines, d), [2, 17, 19, 'error', '30']);
  assert.equal(d.message, 'Write ")" here');
});

test('a mistake inside a continuation line points past the indent', () => {
  const lines = ['universe: SPY', 'buy when close > sma(200)', '   or rsi(14) < nope(3)'];
  const [d] = checked(lines);
  assert.deepEqual(at(lines, d), [2, 16, 20, 'error', 'nope']);
});

test('a missing universe is attached to the first line with code', () => {
  const message = /^Add a universe/;
  const plain = ['buy when close > sma(200)'];
  assert.deepEqual(checked(plain).map((d) => at(plain, d)), [[0, 0, 25, 'error', 'buy when close > sma(200)']]);
  const blankFirst = ['', '', '  buy when close > sma(200)   '];
  const [d] = checked(blankFirst);
  assert.deepEqual(at(blankFirst, d), [2, 2, 27, 'error', 'buy when close > sma(200)']);
  assert.match(d.message, message);
  const commented = ['# trend following', ...plain];
  assert.deepEqual(at(commented, checked(commented)[0]), [1, 0, 25, 'error', 'buy when close > sma(200)']);
});

test('a block with only a comment has nothing else to point at', () => {
  const lines = ['', '# later'];
  const [d] = checked(lines);
  assert.deepEqual(at(lines, d), [1, 0, 7, 'error', '# later']);
});

test('a problem about the whole block covers the trimmed text of a line', () => {
  const lines = ['universe: SPY'];
  const [d] = checked(lines);
  assert.deepEqual(at(lines, d), [0, 0, 13, 'error', 'universe: SPY']);
  assert.match(d.message, /^There is no buy rule/);
  const odd = [...HEAD, '', '   hello there  '];
  assert.deepEqual(at(odd, checked(odd)[0]), [3, 3, 14, 'error', 'hello there']);
});

test('a ticker on a for line that is not in the universe is underlined once, on that line', () => {
  const lines = [...HEAD, 'for QQQ:', '  buy when close > 1', '  stop loss: 5%'];
  assert.deepEqual(checked(lines).map((d) => at(lines, d)), [[2, 4, 7, 'error', 'QQQ']]);
  const spaced = [...HEAD, '  for   QQQ  :  # sleeve', '  stop loss: 5%'];
  assert.deepEqual(checked(spaced).map((d) => at(spaced, d)), [[2, 8, 11, 'error', 'QQQ']]);
});

test('the adjusted-price warning covers the comparison and is not an error', () => {
  const lines = ['universe: SPY', 'buy when close > 100'];
  const [d, ...rest] = checked(lines);
  assert.deepEqual(rest, []);
  assert.deepEqual(at(lines, d), [1, 9, 20, 'warning', 'close > 100']);
  assert.match(d.message, /adjustments for subsequent dividends and splits/);
  const other = ['universe: SPY, TLT', 'buy when close > sma(200)', '  and close of TLT > 50'];
  assert.deepEqual(checked(other).map((x) => at(other, x)), [[2, 6, 23, 'warning', 'close of TLT > 50']]);
});

test('the adjusted-price warning only applies to Yahoo prices', () => {
  assert.deepEqual(checked(['universe: BTCUSDT', 'data: binance', 'buy when close > 100']), []);
  assert.deepEqual(checked(['universe: csv:Data/x.csv', 'buy when close > 100']), []);
});

test('parameter problems point at the value, the name or the range', () => {
  const read = (lines: string[]) => checked(lines).filter((d) => !d.message.startsWith('Unknown name')).map((d) => at(lines, d));
  const rule = 'buy when close > sma(fast)';
  assert.deepEqual(read(['universe: SPY', 'fast = 50 in', rule]), [[1, 7, 12, 'error', '50 in']]);
  assert.deepEqual(read(['universe: SPY', 'fast = 50 in 100..20', rule]), [[1, 13, 20, 'error', '100..20']]);
  assert.deepEqual(read(['universe: SPY', 'fast = 5 in 20..100', rule]), [[1, 7, 8, 'error', '5']]);
  assert.deepEqual(read(['universe: SPY', 'fast = 50 in 20..100 step 0', rule]), [[1, 26, 27, 'error', '0']]);
  assert.deepEqual(read(['universe: SPY', 'fast = 1 in 1..1000', rule]), [[1, 12, 19, 'error', '1..1000']]);
  assert.deepEqual(read(['universe: SPY', 'fast = 50', 'fast = 60', rule]), [[2, 0, 4, 'error', 'fast']]);
  assert.deepEqual(read(['universe: SPY', 'close = 5', 'buy when close > sma(5)']), [[1, 0, 5, 'error', 'close']]);
});

test('a parameter used as the wrong kind of value is underlined where it is used', () => {
  const lines = ['universe: SPY', 'stop = 8', 'stop loss: stop', 'buy when close > sma(2)'];
  const [d] = checked(lines);
  assert.deepEqual(at(lines, d), [2, 11, 15, 'error', 'stop']);
  assert.match(d.message, /must be a percentage/);
});

test('a bad parameter also leaves its uses unknown, each underlined once', () => {
  const lines = ['universe: SPY', 'fast = 50 in', 'buy when close > sma(fast)'];
  assert.deepEqual(checked(lines).map((d) => at(lines, d)), [
    [1, 7, 12, 'error', '50 in'],
    [2, 21, 25, 'error', 'fast'],
  ]);
  // A definition with a mistake in it is reported once, on its own line, and its uses say nothing more.
  const defined = ['universe: SPY', 'fast = abc', 'buy when close > fast and fast < 1'];
  assert.deepEqual(checked(defined).map((d) => at(defined, d)), [[1, 7, 10, 'error', 'abc']]);
});

test('results come in line order, then column order, errors before warnings', () => {
  const lines = ['universe: SPY', 'buy when close > 100 and nope', 'interval: 1h'];
  assert.deepEqual(checked(lines).map((d) => at(lines, d)), [
    [1, 9, 20, 'warning', 'close > 100'],
    [1, 25, 29, 'error', 'nope'],
    [2, 10, 12, 'error', '1h'],
  ]);
});

test('the defaults are used when the block is read', () => {
  assert.deepEqual(checked(HEAD, { cashRate: '4%' }), []);
  const [d] = checked(HEAD, { cashRate: 'banana split' });
  assert.deepEqual(at(HEAD, d), [0, 0, 13, 'error', 'universe: SPY']);
  assert.match(d.message, /default cash rate/);
  // A block that sets its own cash rate does not depend on the default.
  assert.deepEqual(checked([...HEAD, 'cash rate: 2%'], { cashRate: 'banana split' }), []);
  // Binance as the default source also removes the Yahoo warning.
  assert.deepEqual(checked(['universe: BTCUSDT', 'buy when close > 100'], { dataSource: 'binance' }), []);
});

test('tabs, indents and carriage returns do not move the columns', () => {
  const lines = ['universe:\tSPY', 'buy when\tclose >\tsma(zz)'];
  assert.deepEqual(checked(lines).map((d) => at(lines, d)), [[1, 21, 23, 'error', 'zz']]);
  const crlf = ['universe: SPY\r', 'buy when close > sma(zz)\r'];
  assert.deepEqual(checked(crlf).map((d) => at(crlf, d)), [[1, 21, 23, 'error', 'zz']]);
});

test('placeDiagnostic keeps ranges inside the line', () => {
  const lines = ['', '  buy when close > sma(200)  ', ''];
  const place = (d: { line: number; from?: number; to?: number }) => at(lines, placeDiagnostic(lines, { ...d, message: 'm' }, 'error'));
  assert.deepEqual(place({ line: 2, from: 11, to: 16 }), [1, 11, 16, 'error', 'close']);
  // Past the end of the line: clamped.
  assert.deepEqual(place({ line: 2, from: 25, to: 99 }), [1, 25, 29, 'error', '0)  ']);
  // Empty, backwards, negative or starting beyond the line: the whole trimmed line.
  const whole = [1, 2, 27, 'error', 'buy when close > sma(200)'];
  assert.deepEqual(place({ line: 2, from: 5, to: 5 }), whole);
  assert.deepEqual(place({ line: 2, from: 9, to: 4 }), whole);
  assert.deepEqual(place({ line: 2, from: -1, to: 4 }), whole);
  assert.deepEqual(place({ line: 2, from: 40, to: 45 }), whole);
  assert.deepEqual(place({ line: 2, from: 3 }), whole);
  assert.deepEqual(place({ line: 2 }), whole);
  // A blank line, a line past the end, or line 0 moves to the first line with code, ignoring the columns.
  assert.deepEqual(place({ line: 1, from: 0, to: 3 }), whole);
  assert.deepEqual(place({ line: 3, from: 0, to: 3 }), whole);
  assert.deepEqual(place({ line: 9, from: 0, to: 3 }), whole);
  assert.deepEqual(place({ line: 0 }), whole);
});

test('analyzeBlock: a block with errors still gets its colours', () => {
  const lines = ['universe: SPY', 'fast = 50 in 20..100', 'buy when sma(fast) > close and nope(3)'];
  const { tokens, diagnostics } = analyzeBlock(lines);
  assert.deepEqual(diagnostics.map((d) => at(lines, d)), [[2, 31, 35, 'error', 'nope']]);
  const kinds = (i: number) => tokens[i].map((t) => `${t.kind}:${lines[i].slice(t.from, t.to)}`);
  assert.deepEqual(kinds(0), ['key:universe', 'ticker:SPY']);
  assert.deepEqual(kinds(1), ['key:fast', 'operator:=', 'number:50', 'keyword:in', 'number:20', 'operator:..', 'number:100']);
  // Parameter names are known to the colouring, so `fast` is a parameter inside the rule.
  assert.deepEqual(kinds(2).slice(0, 7), ['keyword:buy', 'keyword:when', 'function:sma', 'operator:(', 'param:fast', 'operator:)', 'operator:>']);
});

test('analyzeBlock: tokens are in ascending order and inside their line', () => {
  const lines = `name: Three sleeves  # label
universe: SPY 50%, binance:BTCUSDT 20%, csv:Data/gold.csv 30%
costs: 10 bps  # per side
fast = 50 in 20..100 step 10   # sweep
hold: top 2 by roc(fast) of SPY
weighting: inverse volatility(60)
risk per trade: 1% at 2 atr(14)
stop loss: 2 atr(14)
cash rate: ^IRX

buy  when close > sma(200) and rsi(14) of ^VIX < 30.5
       or close crosses above highest(high, 50)[1]
sell when bars held >= 5 or close < entry price * 0.9 and month_end
for BTCUSDT:
  trailing stop: 3 atr(14)
nonsense here`.split('\n');
  const { tokens } = analyzeBlock(lines);
  assert.equal(tokens.length, lines.length);
  tokens.forEach((row, i) => {
    assert.ok(row.length > 0 || !lines[i].trim() || i === lines.length - 1, `line ${i} has no tokens`);
    row.forEach((t, k) => {
      assert.ok(0 <= t.from && t.from < t.to && t.to <= lines[i].length, `token ${t.kind} ${t.from}..${t.to} in line ${i}`);
      if (k > 0) assert.ok(row[k - 1].from <= t.from, `line ${i}: token ${k} starts before the one before it`);
    });
  });
});

test('fenceOf reads opening and closing fences', () => {
  assert.deepEqual(fenceOf('```strategy'), { fence: '```', info: 'strategy' });
  assert.deepEqual(fenceOf('  ~~~~  strategy  '), { fence: '~~~~', info: 'strategy' });
  assert.deepEqual(fenceOf('```'), { fence: '```', info: '' });
  assert.deepEqual(fenceOf('```js'), { fence: '```', info: 'js' });
  assert.equal(fenceOf('``'), null);
  assert.equal(fenceOf('text ```'), null);
});

const NOTE = `# Note
\`\`\`js
\`\`\`strategy
const notInBlock = 1;
\`\`\`

\`\`\`strategy
universe: SPY
buy when close > sma(200)
\`\`\`
text
~~~strategy
~~~
\`\`\`\`md
\`\`\`strategy
universe: QQQ
\`\`\`
\`\`\`\`
\`\`\`strategy
universe: TLT`.split('\n');

test('findBlocks finds strategy blocks only, however fences nest', () => {
  const found = findBlocks(NOTE);
  assert.deepEqual(found, [
    { first: 7, last: 8 },
    { first: 12, last: 11 },
    { first: 19, last: 19 },
  ]);
  assert.equal(NOTE[found[0].first], 'universe: SPY');
  assert.equal(NOTE[found[2].first], 'universe: TLT');
});

test('findBlocks reads only as far as the lines it is asked about, except to finish a block', () => {
  let pulled = 0;
  const counted = function* (lines: string[]) {
    for (const l of lines) {
      pulled++;
      yield l;
    }
  };
  const long = ['```strategy', ...Array.from({ length: 50 }, (_, i) => `# line ${i}`), '```', ...Array.from({ length: 5000 }, () => 'text'), '```strategy', 'universe: SPY', '```'];
  assert.deepEqual(findBlocks(counted(long), 3), [{ first: 1, last: 50 }]);
  assert.ok(pulled <= 53, `read ${pulled} lines`);
  pulled = 0;
  assert.deepEqual(findBlocks(counted(long), 60), [{ first: 1, last: 50 }]);
  assert.ok(pulled < 100, `read ${pulled} lines`);
  assert.equal(findBlocks(long).length, 2);
});

test('closesFence needs only fence characters, at least as many as the opening', () => {
  assert.ok(closesFence('```', '```'));
  assert.ok(closesFence('  ````  ', '```'));
  assert.ok(closesFence('~~~', '~~~'));
  assert.ok(!closesFence('```', '````'));
  assert.ok(!closesFence('~~~', '```'));
  assert.ok(!closesFence('```strategy', '```'));
  assert.ok(!closesFence('``` x', '```'));
});

/** A lookup that knows only what it is told, the way the editor reads it while drawing. */
function known(verdicts: Record<string, 'known' | 'unknown'>, found: Record<string, string[]> = {}) {
  return {
    peek: (ticker: string, source: string) => verdicts[`${source}|${ticker.toUpperCase()}`] ?? null,
    peekSearch: (query: string) =>
      (found[query.toUpperCase()] ?? []).map((t) => ({ ticker: t, name: '', detail: '', source: 'yahoo' as const })),
  };
}

test('a problem keeps the parser’s own diagnostic, so a fix can be worked out from it', () => {
  const lines = ['universe: SPY', 'buy when close > smaa(200)'];
  const [d] = blockDiagnostics(lines);
  assert.equal(d.origin?.line, 2);
  assert.match(d.origin!.message, /^Unknown name "smaa"/);
  const fix = fixForDiagnostic(lines, d, {}, null);
  assert.deepEqual([fix?.line, fix?.from, fix?.to, fix?.insert], [2, 17, 21, 'sma']);
});

test('unknownTickers: a note for each ticker the lookup knows its source does not have', () => {
  const lines = ['universe: SPYY, TLT, binance:BTCUSDTT, csv:Data/x.csv', 'benchmark: QQQ', 'buy when close of ^VXI > 1'];
  const lookup = known({ 'yahoo|SPYY': 'unknown', 'yahoo|TLT': 'known', 'binance|BTCUSDTT': 'unknown', 'yahoo|^VXI': 'unknown' });
  const refs = blockTickers(lines);
  const notes = unknownTickers(refs, lookup);
  assert.deepEqual(
    notes.map((d) => [d.line, lines[d.line].slice(d.from, d.to), d.severity, d.message]),
    [
      [0, 'SPYY', 'warning', 'Yahoo has no ticker with the name SPYY.'],
      [0, 'binance:BTCUSDTT', 'warning', 'Binance has no market with the name BTCUSDTT.'],
      [2, '^VXI', 'warning', 'Yahoo has no ticker with the name ^VXI.'],
    ],
  );
  // Not yet asked about (QQQ) and not known (unsure) give nothing, and the caller can leave one out, such as a ticker being typed.
  assert.deepEqual(unknownTickers(refs.filter((r) => r.ticker !== 'SPYY'), lookup).map((d) => d.ticker!.ticker), ['BTCUSDTT', '^VXI']);
  assert.deepEqual(unknownTickers(refs, known({})), []);
  // Price source for tickers without a prefix decides which source is asked.
  const binance = unknownTickers(blockTickers(['data: binance', 'universe: ABCUSDT']), known({ 'binance|ABCUSDT': 'unknown' }));
  assert.equal(binance[0].message, 'Binance has no market with the name ABCUSDT.');
});

test('fixForDiagnostic: an unknown ticker is changed to a known one, the block’s own first', () => {
  const lines = ['universe: SPYY, TLT', 'buy when close of TLTT > 1'];
  const lookup = known({ 'yahoo|SPYY': 'unknown', 'yahoo|TLT': 'known', 'yahoo|TLTT': 'unknown', 'yahoo|SPY': 'known' }, { SPYY: ['SPY', 'SPYY.DE'], TLTT: ['TLT'] });
  const [first, second] = unknownTickers(blockTickers(lines), lookup);
  const a = fixForDiagnostic(lines, first, {}, lookup)!;
  assert.deepEqual([a.line, a.from, a.to, a.insert, a.label], [1, 10, 14, 'SPY', 'Change to SPY']);
  const b = fixForDiagnostic(lines, second, {}, lookup)!;
  assert.deepEqual([b.line, b.from, b.to, b.insert], [2, 18, 22, 'TLT']);
  // The block's own TLT is preferred, and the same word from a search is not needed.
  assert.equal(fixForDiagnostic(lines, second, {}, known({ 'yahoo|TLT': 'known', 'yahoo|TLTT': 'unknown' }))!.insert, 'TLT');
  // Nothing near enough, or nothing found: no fix, and no fix without a lookup.
  assert.equal(fixForDiagnostic(lines, first, {}, known({ 'yahoo|SPYY': 'unknown' }, { SPYY: ['SPYY.DE', 'GLD'] })), null);
  assert.equal(fixForDiagnostic(lines, first, {}, null), null);
  // A suggestion that is not known to exist is not offered from the block's own tickers.
  assert.equal(fixForDiagnostic(lines, second, {}, known({ 'yahoo|TLT': 'unknown', 'yahoo|TLTT': 'unknown' })), null);
});

test('a warning from the parser gets no fix', () => {
  const lines = ['universe: SPY', 'buy when close > 100'];
  const [d] = blockDiagnostics(lines);
  assert.equal(d.severity, 'warning');
  assert.equal(fixForDiagnostic(lines, d, {}, null), null);
});

test('a CSV file referred to by its bare name is not looked up, underlined or offered a replacement', () => {
  const lines = ['universe: SPY, csv:Data/myfund.csv', 'buy when close of myfund > sma(20) of myfund'];
  assert.deepEqual(parseSpec(lines.join('\n')).errors, []);
  const asked: string[] = [];
  const lookup = {
    peek: (ticker: string) => (asked.push(ticker), 'unknown' as const),
    peekSearch: (query: string) => (asked.push(query), [{ ticker: 'MYFUND.L', name: '', detail: '', source: 'yahoo' as const }]),
  };
  const notes = unknownTickers(blockTickers(lines), lookup);
  assert.deepEqual(notes.map((d) => d.ticker?.ticker), ['SPY']);
  assert.ok(!asked.includes('MYFUND'));
  for (const d of notes) assert.equal(fixForDiagnostic(lines, d, {}, lookup), null);
});

test('fixForDiagnostic: a ticker named on a `for` line changes with the one in the universe, and a clash elsewhere stops the fix', () => {
  const lookup = known({ 'yahoo|SPYY': 'unknown', 'yahoo|QQQ': 'known' }, { SPYY: ['SPY'] });
  const lines = ['universe: SPYY, QQQ', 'buy when close > sma(50)', 'for SPYY:', '  stop loss: 5%'];
  const [note] = unknownTickers(blockTickers(lines), lookup);
  const fix = fixForDiagnostic(lines, note, {}, lookup)!;
  assert.deepEqual([fix.line, fix.from, fix.to, fix.insert, fix.label], [1, 10, 14, 'SPY', 'Change to SPY (2 places)']);
  assert.deepEqual(fix.also, [{ line: 3, from: 4, to: 8, insert: 'SPY' }]);

  const clash = ['universe: SPYY, QQQ', 'buy when close of csv:Data/spy.csv > 1'];
  const [again] = unknownTickers(blockTickers(clash), lookup);
  assert.equal(fixForDiagnostic(clash, again, {}, lookup), null);
});

test('runStep: a ticker its source does not know changes to a near one of the block or its usual spelling, without a request', async () => {
  const asked: string[] = [];
  const lookup = { search: async (q: string) => (asked.push(q), []) };
  // A typo of another ticker in the block, written in each place the block names it.
  const typo = ['universe: SPYY, TLT', 'benchmark: SPY', 'buy when close > sma(200)', 'for SPYY:', '  stop loss: 5%'];
  const step = await runStep(typo, { kind: 'ticker', ref: 'SPYY', source: 'yahoo' }, {}, lookup);
  assert.equal(step.text, 'Did you mean SPY?');
  assert.ok(step.action?.kind === 'change');
  assert.equal(step.action.label, 'Change to SPY (2 places)');
  assert.deepEqual(applyFix(typo, step.action.fix), ['universe: SPY, TLT', 'benchmark: SPY', 'buy when close > sma(200)', 'for SPY:', '  stop loss: 5%']);
  // Yahoo writes a share class after a dash.
  const brk = ['universe: BRK.B', 'buy when close > sma(200)'];
  const share = await runStep(brk, { kind: 'ticker', ref: 'BRK.B', source: 'yahoo' }, {}, null);
  assert.deepEqual([share.text, share.action?.label], ['Did you mean BRK-B?', 'Change to BRK-B']);
  assert.deepEqual(asked, []);
});

test('runStep: the ticker lookup is asked only while it is on, and with no confident correction the step says where to look', async () => {
  const lines = ['universe: QQQM, IWMM', 'buy when close > sma(200)'];
  const ticker = { kind: 'ticker' as const, ref: 'IWMM', source: 'yahoo' as const };
  const asked: string[] = [];
  const found = { search: async (q: string) => (asked.push(q), [{ ticker: 'IWM', name: 'iShares Russell 2000', detail: 'NYSEArca · ETF', source: 'yahoo' as const }]) };
  const step = await runStep(lines, ticker, {}, found);
  assert.deepEqual(asked, ['IWMM']);
  assert.deepEqual([step.text, step.action?.label], ['Did you mean IWM?', 'Change to IWM']);
  const nothing = await runStep(lines, ticker, {}, { search: async () => [] });
  assert.deepEqual(nothing, { text: 'To find the ticker, search for the name on finance.yahoo.com.', action: null });
  // With the lookup off nothing is sent, and the step says the setting can find tickers.
  const off = await runStep(lines, ticker, {}, null);
  assert.deepEqual(off, { text: 'To find the ticker, search for the name on finance.yahoo.com. Or turn on the setting "Find tickers while you type". Then the editor shows tickers while you write them.', action: null });
  const binance = await runStep(['universe: binance:BTCUSD', 'buy when true'], { kind: 'ticker', ref: 'BTCUSD', source: 'binance' }, {}, { search: async () => [] });
  assert.equal(binance.text, 'To find the symbol, search for the coin on binance.com. A symbol has the two currencies together, for example BTCUSDT.');
  // A FRED series is never looked up; a ticker the block does not name, as a cash rate from the settings, is not changed.
  const fred = await runStep(['universe: SPY', 'buy when close of fred:T10Y2YY > 0'], { kind: 'ticker', ref: 'T10Y2YY', source: 'fred' }, {}, found);
  assert.deepEqual(fred, { text: 'To find the series ID, search for the series on fred.stlouisfed.org.', action: null });
  assert.deepEqual(asked, ['IWMM']);
  const cash = await runStep(['universe: SPY', 'buy when true'], { kind: 'ticker', ref: 'BILLL', source: 'yahoo' }, {}, null);
  assert.equal(cash.action, null);
});

test('runStep: a key opens the settings, a missing CSV file the CSV helper, and no network says that prices load once', async () => {
  const lines = ['universe: tiingo:SPY', 'buy when true'];
  assert.deepEqual(await runStep(lines, { kind: 'key', service: 'tiingo', setting: 'Tiingo API key', rejected: false }, {}, null), { text: '', action: { kind: 'settings', label: 'Open settings' } });
  assert.deepEqual(await runStep(lines, { kind: 'csv', path: 'Data/gold.csv' }, {}, null), {
    text: 'The CSV helper lists the CSV files of the vault and shows how the plugin reads each one.',
    action: { kind: 'csv', label: 'Use a CSV file' },
  });
  assert.deepEqual(await runStep(lines, { kind: 'offline' }, {}, null), {
    text: 'The plugin must have a connection to the internet to load the prices of a ticker the first time. After that, it can use the saved prices.',
    action: null,
  });
});
