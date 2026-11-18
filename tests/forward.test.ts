import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maxDrawdown } from '../src/backtest.ts';
import { extractBlocks } from '../src/blocks.ts';
import { parseSpec, type Defaults } from '../src/dsl.ts';
import {
  appendLog,
  checkOf,
  CHANGED,
  forwardChanged,
  forwardFigures,
  isForwardNote,
  makeForward,
  newRows,
  parseForward,
  pinDefaults,
  readLog,
  revisions,
  worstFalls,
  type ForwardStart,
  type LogOrder,
  type LogRow,
} from '../src/forward.ts';
import { stable } from '../src/result-cache.ts';
import { NOTE_CHANGED } from '../src/rewrite.ts';
import { DEFAULT_SETTINGS, defaultsFrom } from '../src/settings-core.ts';
import { DAY } from './helpers.ts';

const utc = (y: number, m: number, d: number, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm);

const DEFAULTS: Defaults = { capital: 10_000, costBps: 0, slippageBps: 0, cashRate: '0%', dataSource: 'yahoo' };
/** Everything different from the defaults above, so a setting left to the defaults shows. */
const OTHER: Defaults = { capital: 1, costBps: 99, slippageBps: 98, cashRate: '9%', dataSource: 'binance', commission: { k: 'order', fee: 9 } };

const STRATEGY = ['name: Trend following', 'universe: SPY', 'buy when close > sma(200)', 'sell when close < sma(200)'].join('\n');
const LINK = '[[Trend following#Trend following]]';

function started(over: Partial<ForwardStart> = {}): string {
  const made = makeForward({ source: STRATEGY, defaults: DEFAULTS, started: utc(2026, 11, 13), intraday: false, link: LINK, name: 'Trend following', ...over });
  assert.ok(made.ok, made.ok ? '' : made.message);
  return made.note;
}

const body = (note: string, which = 0) => extractBlocks(note, 'forward')[which].source;

/** The block's spec with the defaults it had, and again from its pinned text under other defaults, which must be the same. */
function pinned(source: string, defaults: Defaults, others: Partial<Defaults>[] = [defaults, {}, OTHER]): string {
  const before = parseSpec(source, { defaults });
  assert.deepEqual(before.errors, []);
  const frozen = pinDefaults(source, defaults);
  for (const other of others) {
    const after = parseSpec(frozen, { defaults: other });
    assert.deepEqual(after.errors, [], frozen);
    assert.equal(stable(after.spec), stable(before.spec));
  }
  return frozen;
}

const lines = (text: string) => text.split('\n');
const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

// --- Starting ---------------------------------------------------------------------------------------------------------

test('a new note holds the property, a forward block that parses cleanly, and an empty log', () => {
  const note = started();
  assert.ok(note.startsWith('---\nbacktest_forward: true\n---\n'));
  assert.ok(isForwardNote(note));
  assert.ok(note.includes(`taken from ${LINK}`));
  assert.ok(note.endsWith('\n## Log\n'));

  const { forward, errors } = parseForward(body(note));
  assert.deepEqual(errors, []);
  assert.equal(forward!.started, utc(2026, 11, 13));
  assert.equal(forward!.intraday, false);
  assert.equal(forward!.from, LINK);
  assert.equal(forward!.check, checkOf(forward!.source, forward!.started));
  assert.equal(forwardChanged(forward!), false);
  assert.ok(forward!.source.startsWith(STRATEGY));
  assert.deepEqual(parseSpec(forward!.source).errors, []);
  assert.deepEqual(extractBlocks(note), [], 'the frozen rules are not a strategy block, so no scan or dashboard finds them');
});

test('a block written by hand in the README style parses, with comments and blank lines in the header and Windows line ends', () => {
  const frozen = 'universe: SPY\nbuy when rsi(2) < 10\nsell when rsi(2) > 70';
  const text = ['# Forward test from the Dip buyer note', '', 'started: 2026-11-13', 'from: [[Dip buyer]]', `check: ${checkOf(frozen, utc(2026, 11, 13))}`, '---', frozen].join('\n');
  const a = parseForward(text);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.forward, { started: utc(2026, 11, 13), intraday: false, from: '[[Dip buyer]]', check: checkOf(frozen, utc(2026, 11, 13)), source: frozen });
  assert.deepEqual(parseForward(text.replace(/\n/g, '\r\n')).forward!.source.replace(/\r/g, ''), frozen);
  assert.equal(forwardChanged(parseForward(text.replace(/\n/g, '\r\n')).forward!), false);
});

test('an intraday strategy starts at a time of day, and the time is read back', () => {
  const note = started({ started: utc(2026, 11, 13, 15, 30), intraday: true });
  assert.ok(body(note).startsWith('started: 2026-11-13 15:30\n'));
  const { forward } = parseForward(body(note));
  assert.equal(forward!.started, utc(2026, 11, 13, 15, 30));
  assert.equal(forward!.intraday, true);
  assert.ok(note.includes('after the bar of 2026-11-13 15:30 UTC'));
});

test('a strategy that leaves everything to the defaults gets all six pinned, and reads back as the very same spec', () => {
  const frozen = pinned(STRATEGY, DEFAULTS);
  assert.deepEqual(lines(frozen).slice(lines(STRATEGY).length), [
    '',
    '# Pinned when the forward test began, so a later change to the plugin settings cannot move it.',
    'capital: 10000',
    'costs: 0 bps',
    'slippage: 0 bps',
    'commission: 0',
    'cash rate: 0%',
    'data: yahoo',
  ]);
  assert.equal(frozen.slice(0, STRATEGY.length), STRATEGY, 'the lines of the strategy stay where they were');
});

test('pinned values come from the defaults, and a later change to them does not move the spec', () => {
  const settings = { ...DEFAULT_SETTINGS, capital: 25_000.5, costs: '0.07%', slippage: '3 bps', commission: '0.005 per share, min 1, max 1%', cashRate: '^IRX' };
  const defaults = defaultsFrom(settings);
  assert.equal(defaults.costBps, 0.07 * 100, 'a default can carry a floating-point tail');
  const frozen = pinned(STRATEGY, defaults);
  assert.ok(frozen.includes('capital: 25000.5\n'));
  assert.ok(frozen.includes('costs: 7.000000000000001 bps\n'));
  assert.ok(frozen.includes('slippage: 3 bps\n'));
  assert.ok(frozen.includes('commission: 0.005 per share, min 1, max 1%\n'));
  assert.ok(frozen.includes('cash rate: ^IRX\n'));
  // Another capital or cost in the settings later changes the strategy as written, never the frozen text.
  const moved = parseSpec(STRATEGY, { defaults: OTHER }).spec;
  assert.notEqual(stable(moved), stable(parseSpec(STRATEGY, { defaults }).spec));
  assert.equal(stable(parseSpec(frozen, { defaults: OTHER }).spec), stable(parseSpec(STRATEGY, { defaults }).spec));
});

test('a block that can borrow also gets its borrow fee and margin rate pinned, so a later change to those settings does not move it', () => {
  const rates: Defaults = { ...DEFAULTS, borrowFee: 0.35 / 100, marginRate: 7.25 / 100 };
  const others = [rates, {}, OTHER, { ...OTHER, borrowFee: 0.03, marginRate: 0.12 }];
  const short = [STRATEGY, 'short when close < sma(50)'].join('\n');
  assert.deepEqual(lines(pinned(short, rates, others)).slice(-2), ['borrow fee: 0.35%', 'margin rate: 7.25%']);
  // Weights above 100% borrow too, and the plugin's own rate is pinned when the settings give none. A block that never
  // shorts pays no borrow fee, so none is pinned for it.
  const levered = pinned('universe: SPY 150%\nbuy when close > sma(200)', DEFAULTS, others);
  assert.deepEqual(lines(levered).slice(-2), ['data: yahoo', 'margin rate: 6%']);
  assert.deepEqual(lines(pinned('universe: SPY 150%\nbuy when close > sma(200)\nshort when close < sma(50)', DEFAULTS, others)).slice(-2), ['borrow fee: 0.5%', 'margin rate: 6%']);
  // A rate the block writes stays as it is, and only the other is pinned.
  const own = pinned([short, 'borrow fee: 2%'].join('\n'), rates, others);
  assert.equal(count(own, /^borrow fee:/gm), 1);
  assert.equal(lines(own).at(-1), 'margin rate: 7.25%');
  // A long-only block within 100% gets neither: it pays no borrow fee and no margin interest.
  assert.ok(!/borrow fee|margin rate/.test(pinned(STRATEGY, rates, others)));
});

test('every form of commission, and none, reads back as the same charge', () => {
  const forms: [Defaults['commission'], string][] = [
    [undefined, 'commission: 0'],
    [{ k: 'order', fee: 1 }, 'commission: 1'],
    [{ k: 'order', fee: 0.35 }, 'commission: 0.35'],
    [{ k: 'share', fee: 0.005, min: 0, max: null }, 'commission: 0.005 per share'],
    [{ k: 'share', fee: 0.005, min: 1, max: null }, 'commission: 0.005 per share, min 1'],
    [{ k: 'share', fee: 0.005, min: 0, max: 0.01 }, 'commission: 0.005 per share, max 1%'],
    [{ k: 'share', fee: 0.005, min: 1.5, max: 0.075 }, 'commission: 0.005 per share, min 1.5, max 7.5%'],
    [{ k: 'share', fee: 0.005, min: 1, max: 0.07 }, 'commission: 0.005 per share, min 1, max 7%'],
  ];
  for (const [commission, line] of forms) {
    const defaults = { ...DEFAULTS, ...(commission ? { commission } : {}) };
    const frozen = pinned(STRATEGY, defaults);
    assert.ok(lines(frozen).includes(line), `${line} in\n${frozen}`);
  }
});

test('a Binance default is pinned, and the ticker with no prefix stays on Binance', () => {
  const source = 'universe: BTCUSDT\nbuy when close > sma(50)\nsell when close < sma(50)';
  const defaults: Defaults = { ...DEFAULTS, dataSource: 'binance', cashRate: '3%' };
  const frozen = pinned(source, defaults);
  assert.ok(lines(frozen).includes('data: binance'));
  assert.equal(parseSpec(frozen, { defaults: DEFAULTS }).spec!.universe[0].source, 'binance');
});

test('a setting the block writes itself is never written twice, whatever its case, spacing or comment', () => {
  const source = [
    'name: Mixed',
    'universe: SPY',
    '  CAPITAL : 5k   # my own',
    'Cash   Rate: 4%',
    'commission: 0 // none for me',
    'buy when close > sma(200)',
    'sell when close < sma(200)',
    '# slippage: 50 bps stays a comment',
  ].join('\n');
  const frozen = pinned(source, { ...DEFAULTS, slippageBps: 4 });
  for (const key of ['capital', 'cash rate', 'commission']) assert.equal(count(frozen, new RegExp(`^\\s*${key.replace(' ', '\\s+')}\\s*:`, 'gmi')), 1, key);
  assert.deepEqual(lines(frozen).slice(-3), ['costs: 0 bps', 'slippage: 4 bps', 'data: yahoo'], 'a commented-out setting does not count as written');
  assert.equal(parseSpec(frozen).spec!.capital, 5000);
});

test('a block that writes all six settings is left as it is', () => {
  const source = [STRATEGY, 'capital: 20k', 'costs: 5 bps', 'slippage: 0.02%', 'commission: 1', 'cash rate: ^IRX', 'data: yahoo'].join('\n');
  assert.equal(pinned(source, OTHER), source);
});

test('a block that ends in a for section gets "for all:" before the pinned settings, which are refused inside a section', () => {
  const source = ['universe: SPY, QQQ', 'buy when close > sma(50)', 'sell when close < sma(50)', 'for SPY:', 'stop loss: 10%'].join('\n');
  assert.ok(parseSpec(`${source}\ncapital: 5`).errors.length > 0, 'the parser refuses a setting in a section');
  const frozen = pinned(source, DEFAULTS);
  assert.ok(lines(frozen).includes('for all:'));
  assert.equal(count(frozen, /^for all:$/gm), 1);
  // A block that already went back to "for all:" needs no second one.
  const back = pinned([source, 'for all:', 'costs: 5 bps'].join('\n'), DEFAULTS);
  assert.equal(count(back, /^for all:$/gm), 1);
  assert.equal(count(back, /^costs:/gm), 1);
});

test('the shown text keeps its own lines: line numbers of parameters do not move, and trailing blank lines and CR are dropped', () => {
  const source = ['universe: SPY', 'fast = 50 in 20..100 step 10', 'buy when sma(fast) > sma(200)', 'sell when sma(fast) < sma(200)', '', ''].join('\r\n');
  const frozen = pinned(source.replace(/\r/g, ''), DEFAULTS);
  assert.ok(!frozen.includes('\r'));
  assert.equal(pinDefaults(source, DEFAULTS), frozen);
  assert.equal(parseSpec(frozen).spec!.params[0].line, 2);
});

test('the block is fenced longer than any run of backticks in the strategy', () => {
  const source = [STRATEGY, '# a ```` run in a comment'].join('\n');
  const note = started({ source });
  assert.ok(note.includes('\n`````forward\n'));
  const { forward, errors } = parseForward(body(note));
  assert.deepEqual(errors, []);
  assert.ok(forward!.source.includes('# a ```` run in a comment'));
  assert.equal(forwardChanged(forward!), false);
});

test('a strategy with a "to" date, one that does not run, and a link that cannot be written are refused with a plain message', () => {
  const to = makeForward({ source: `${STRATEGY}\nto: 2024-12-31`, defaults: DEFAULTS, started: utc(2026, 11, 13), intraday: false, link: LINK, name: 'x' });
  assert.equal(to.ok, false);
  assert.ok(!to.ok && to.message.includes('"to" date') && to.message.includes('never sees a new bar'));

  const broken = makeForward({ source: 'universe: SPY\nbuy when close >', defaults: DEFAULTS, started: utc(2026, 11, 13), intraday: false, link: LINK, name: 'x' });
  assert.ok(!broken.ok && broken.message.startsWith("This strategy has a problem, so a forward test can't start from it. Line 2:"));

  for (const link of ['Trend following#x', '[[Trend]following]]', '[[]]', '[[Two\nlines]]']) {
    const bad = makeForward({ source: STRATEGY, defaults: DEFAULTS, started: utc(2026, 11, 13), intraday: false, link, name: 'x' });
    assert.ok(!bad.ok && bad.message.includes("can't be written into a note"), link);
  }
});

test('a "from" date is fine, and the heading falls back when the strategy has no name', () => {
  const note = started({ source: `${STRATEGY}\nfrom: 2020-01-01`, name: '  ' });
  assert.ok(note.includes('\n# Forward test\n'));
});

// --- Reading ----------------------------------------------------------------------------------------------------------

test('the check follows the start and the frozen text: an edit shows, trailing blank lines and line ends do not', () => {
  const { forward } = parseForward(body(started()));
  assert.equal(forwardChanged({ ...forward!, source: forward!.source.replace('sma(200)', 'sma(100)') }), true);
  assert.equal(forwardChanged({ ...forward!, source: `${forward!.source}\n\n\n` }), false);
  assert.equal(forwardChanged({ ...forward!, source: forward!.source.replace(/\n/g, '\r\n') }), false);
  assert.equal(forwardChanged({ ...forward!, source: ` ${forward!.source}` }), true);
  assert.equal(forwardChanged({ ...forward!, check: 'abc' }), true);
  // Moving the start back would make bars already seen count as forward ones.
  assert.equal(forwardChanged({ ...forward!, started: forward!.started - 30 * 86_400_000 }), true);
  assert.equal(CHANGED, 'The rules or the start were changed after the forward test began, so this is no longer a forward test.');
});

test('every missing or malformed part of a block is a problem with its line', () => {
  const ok = ['started: 2026-11-13', 'from: [[Note#Name]]', 'check: abc123', '---', 'universe: SPY'];
  const parse = (...changes: [number, string | null][]) => {
    const text = ok
      .map((l, i) => {
        const hit = changes.find(([at]) => at === i);
        return hit ? hit[1] : l;
      })
      .filter((l): l is string => l !== null);
    return parseForward(text.join('\n'));
  };
  assert.deepEqual(parse().errors, []);

  assert.deepEqual(parse([0, null]).errors, [{ line: 3, message: 'Add a "started:" line above the ---' }]);
  assert.deepEqual(parse([1, null]).errors, [{ line: 3, message: 'Add a "from:" line above the ---' }]);
  assert.deepEqual(parse([2, null]).errors, [{ line: 3, message: 'Add a "check:" line above the ---' }]);
  assert.deepEqual(parse([4, null]).errors, [{ line: 4, message: 'There is no strategy below the ---' }]);
  assert.deepEqual(parse([4, '', ]).errors, [{ line: 4, message: 'There is no strategy below the ---' }]);

  assert.deepEqual(parse([0, 'started: yesterday']).errors, [
    { line: 1, message: '"yesterday" is not a date. Write it as 2026-11-13, or as 2026-11-13 15:30 for bars inside a day' },
  ]);
  for (const bad of ['2026-02-30', '2026-13-01', '2026-11-13 24:00', '2026-11-13 12:60', '13-11-2026', '2026-11-13 9:30']) {
    assert.equal(parse([0, `started: ${bad}`]).errors.length, 1, bad);
  }
  assert.deepEqual(parse([1, 'from: Note#Name']).errors, [{ line: 2, message: 'Write the strategy as [[Note name#Strategy name]]' }]);
  assert.deepEqual(parse([2, 'check: not a code!']).errors, [{ line: 3, message: '"not a code!" is not a check code. Leave the line as the plugin wrote it' }]);
  assert.deepEqual(parse([0, 'started:']).errors, [{ line: 1, message: '"started" has no value' }, { line: 4, message: 'Add a "started:" line above the ---' }]);
});

test('an unknown setting, a repeated one, a line that is no setting, and a missing --- each give one problem', () => {
  const frozen = 'universe: SPY';
  assert.deepEqual(parseForward(`started: 2026-11-13\nfrom: [[A]]\ncheck: abc\nstop: 5\n---\n${frozen}`).errors, [
    { line: 4, message: 'Unknown setting "stop". Settings: started, from, check' },
  ]);
  assert.deepEqual(parseForward(`started: 2026-11-13\nstarted: 2026-11-14\nfrom: [[A]]\ncheck: abc\n---\n${frozen}`).errors, [{ line: 2, message: '"started" is set twice' }]);
  assert.deepEqual(parseForward(`started: 2026-11-13\nhello\nfrom: [[A]]\ncheck: abc\n---\n${frozen}`).errors, [
    { line: 2, message: 'Not a setting. Write started:, from: and check: lines, then ---' },
  ]);
  const none = parseForward('started: 2026-11-13\nfrom: [[A]]\ncheck: abc\nuniverse: SPY');
  assert.equal(none.forward, null);
  assert.deepEqual(none.errors, [{ line: 4, message: 'Add a line with --- after started, from and check, and the strategy below it' }]);
});

test('a "---" inside the strategy belongs to it, and a block with problems has no forward', () => {
  const frozen = 'universe: SPY\n---\n# a rule';
  const text = `started: 2026-11-13\nfrom: [[A]]\ncheck: ${checkOf(frozen, utc(2026, 11, 13))}\n---\n${frozen}`;
  assert.equal(parseForward(text).forward!.source, frozen);
  assert.equal(parseForward('---\nuniverse: SPY').forward, null);
});

test('isForwardNote reads the property the way the orders note does', () => {
  assert.equal(isForwardNote('---\nbacktest_forward: true\n---\n# x'), true);
  assert.equal(isForwardNote('---\r\nbacktest_forward: true\r\n---\r\n# x'), true);
  assert.equal(isForwardNote('---\ntags: a\nbacktest_forward: true\n---\n'), true);
  assert.equal(isForwardNote('---\nbacktest_forward: false\n---\n'), false);
  assert.equal(isForwardNote('---\nbacktest_orders: true\n---\n'), false);
  assert.equal(isForwardNote('backtest_forward: true\n'), false, 'the property must be in the front matter');
  assert.equal(isForwardNote('# x\n---\nbacktest_forward: true\n---\n'), false);
});

// --- Figures ----------------------------------------------------------------------------------------------------------

/**
 * Twenty bars before the start (index 0 to 19, the last one the start) and five after. Over every 5 steps ending at or before
 * the start the series gains between 3.5% and 6.9%, and it falls by 0.85% to 0.98% at its worst inside each.
 */
const BEFORE = [100, 102, 101, 103, 105, 104, 106, 108, 107, 109, 111, 110, 112, 114, 113, 115, 117, 116, 118, 120];
const AFTER = [118.9, 122, 124, 125, 126];

test('the forward return, the benchmark and the worst fall are measured from the close of the start bar', () => {
  const equity = [...BEFORE, ...AFTER];
  const t = equity.map((_, i) => i * DAY);
  const bench = equity.map((_, i) => 50 + i);
  const f = forwardFigures(t, equity, bench, 19 * DAY);
  assert.equal(f.first, 20);
  assert.equal(f.bars, 5);
  assert.equal(f.strategy, 126 / 120 - 1);
  assert.equal(f.benchmark, 74 / 69 - 1);
  assert.equal(f.worstFall, 118.9 / 120 - 1);
});

test('the window shares on a hand-worked series', () => {
  const equity = [...BEFORE, ...AFTER];
  const f = forwardFigures(equity.map((_, i) => i * DAY), equity, equity, 19 * DAY);
  assert.ok(f.windows.ok);
  // 15 windows of 5 steps end at index 5 to 19. Ten gained less than 126 / 120 = 5%: those ending at 5, 6, 8, 9, 11, 12, 14, 15, 17 and 18
  // (4.0%, 3.9%, 3.9%, 3.8%, 3.8%, 3.7%, 3.7%, 3.6%, 3.6%, 3.5%). The other five gained 6.2% to 6.9%.
  assert.equal(f.windows.count, 15);
  assert.equal(f.windows.beaten, 10 / 15);
  // Their worst falls: -0.98% (ending at 5 and 6), -0.95% (7 to 9), -0.93% (10 to 12), -0.90% (13 to 15), -0.88% (16 to 18), -0.85% (19).
  // The forward fall of -0.92% is shallower than the first eight and deeper than the last seven.
  assert.equal(f.windows.milder, 8 / 15);
  // The middle one of the 15 gains is the 8th, the window ending at 8 (107 / 103); the middle fall is -0.93%: 107 / 108.
  assert.equal(f.windows.typicalReturn, 107 / 103 - 1);
  assert.equal(f.windows.typicalFall, 107 / 108 - 1);
});

test('a window that did exactly as well, or fell exactly as far, counts half', () => {
  const flat = Array.from({ length: 30 }, () => 100);
  const f = forwardFigures(flat.map((_, i) => i * DAY), flat, flat, 24 * DAY);
  assert.ok(f.windows.ok);
  assert.equal(f.windows.count, 20);
  assert.equal(f.windows.beaten, 0.5);
  assert.equal(f.windows.milder, 0.5);
  assert.equal(f.strategy, 0);
  assert.equal(f.worstFall, 0);
});

test('the comparison waits for 5 forward bars and for 3 times as many bars before, and says how many more are needed', () => {
  const make = (before: number, after: number) => {
    const equity = Array.from({ length: before + after }, (_, i) => 100 + i);
    return forwardFigures(equity.map((_, i) => i * DAY), equity, equity, (before - 1) * DAY);
  };
  assert.deepEqual(make(40, 0).windows, { ok: false, message: 'Earlier periods are compared from 5 bars on: 5 more bars to go.' });
  assert.equal(make(40, 0).strategy, null);
  assert.equal(make(40, 0).worstFall, null);
  assert.equal(make(40, 0).bars, 0);
  assert.deepEqual(make(40, 1).windows, { ok: false, message: 'Earlier periods are compared from 5 bars on: 4 more bars to go.' });
  assert.deepEqual(make(40, 4).windows, { ok: false, message: 'Earlier periods are compared from 5 bars on: 1 more bar to go.' });
  assert.ok(make(15, 5).windows.ok, '15 bars before is exactly 3 times 5');
  assert.deepEqual(make(14, 5).windows, {
    ok: false,
    message: 'Earlier periods are compared only when there are 3 times as many bars before the start as since it. Needed: 1 more bar of earlier prices.',
  });
  assert.deepEqual(make(10, 20).windows, {
    ok: false,
    message: 'Earlier periods are compared only when there are 3 times as many bars before the start as since it. Needed: 50 more bars of earlier prices.',
  });
  assert.ok(make(10, 20).strategy! > 0, 'the return is shown whatever the windows say');
});

test('a start between bars, before the first bar and after the last', () => {
  const equity = [...BEFORE, ...AFTER];
  const t = equity.map((_, i) => i * DAY);
  // The start bar is the last one at or before `started`, and the first forward bar the first one after it.
  assert.equal(forwardFigures(t, equity, equity, 19 * DAY + 1).first, 20);
  assert.equal(forwardFigures(t, equity, equity, 19 * DAY - 1).first, 19);
  assert.equal(forwardFigures(t, equity, equity, 100 * DAY).first, 25);
  const early = forwardFigures(t, equity, equity, -DAY);
  assert.equal(early.first, 0);
  assert.equal(early.bars, 25);
  assert.equal(early.strategy, 126 / 100 - 1);
  assert.equal(early.windows.ok, false);
});

test('a benchmark that starts late is measured from its first price, and one with none gives no figure', () => {
  const equity = [...BEFORE, ...AFTER];
  const t = equity.map((_, i) => i * DAY);
  const late = equity.map((_, i) => (i < 22 ? NaN : 10 * (i - 21)));
  assert.equal(forwardFigures(t, equity, late, 19 * DAY).benchmark, 30 / 10 - 1);
  assert.equal(forwardFigures(t, equity, equity.map(() => NaN), 19 * DAY).benchmark, null);
  assert.equal(forwardFigures(t, equity, equity.map((_, i) => (i < 24 ? NaN : 5)), 19 * DAY).benchmark, null, 'one value is no change');
});

/** A small deterministic generator, so a failure can be run again. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test('the fast window falls agree with working each window out on its own, flat stretches and ties included', () => {
  const rand = lcg(7);
  for (let round = 0; round < 60; round++) {
    const n = 2 + Math.floor(rand() * 60);
    const flat = rand() < 0.3;
    const values: number[] = [100];
    for (let i = 1; i < n; i++) values.push(flat && rand() < 0.7 ? values[i - 1] : Math.round(values[i - 1] * (0.95 + rand() * 0.1) * 100) / 100);
    for (const steps of [1, 2, 3, 5, 8, Math.max(1, n - 1)]) {
      if (steps + 1 > n) continue;
      const naive = Array.from({ length: n - steps }, (_, a) => maxDrawdown(values.slice(a, a + steps + 1)));
      assert.deepEqual(worstFalls(values, steps), naive, `${n} values, ${steps} steps, round ${round}`);
    }
  }
  assert.deepEqual(worstFalls([1, 2], 5), []);
  assert.deepEqual(worstFalls([], 1), []);
});

test('the shares agree with comparing every earlier window one by one', () => {
  const rand = lcg(11);
  for (let round = 0; round < 40; round++) {
    const before = 15 + Math.floor(rand() * 80);
    const bars = 5 + Math.floor(rand() * Math.max(1, Math.floor(before / 3) - 4));
    const flat = rand() < 0.25;
    const equity: number[] = [1000];
    for (let i = 1; i < before + bars; i++) equity.push(flat && rand() < 0.6 ? equity[i - 1] : Math.round(equity[i - 1] * (0.97 + rand() * 0.06) * 100) / 100);
    const t = equity.map((_, i) => i * DAY);
    const f = forwardFigures(t, equity, equity, (before - 1) * DAY);
    assert.ok(f.windows.ok, `${before} before, ${bars} after`);

    const forwardGain = equity[before + bars - 1] / equity[before - 1] - 1;
    const forwardFall = maxDrawdown(equity.slice(before - 1));
    const gains: number[] = [];
    const falls: number[] = [];
    for (let j = bars; j < before; j++) {
      gains.push(equity[j] / equity[j - bars] - 1);
      falls.push(maxDrawdown(equity.slice(j - bars, j + 1)));
    }
    const half = (list: number[], x: number) => list.reduce((s, v) => s + (v < x ? 1 : v === x ? 0.5 : 0), 0) / list.length;
    const middle = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
    assert.equal(f.strategy, forwardGain);
    assert.equal(f.worstFall, forwardFall);
    assert.equal(f.windows.count, gains.length);
    assert.equal(f.windows.beaten, half(gains, forwardGain));
    assert.equal(f.windows.milder, half(falls, forwardFall));
    if (gains.length % 2 === 1) {
      assert.equal(f.windows.typicalReturn, middle(gains));
      assert.equal(f.windows.typicalFall, middle(falls));
    }
  }
});

// --- The log ----------------------------------------------------------------------------------------------------------

const NOW = utc(2026, 11, 17, 12);
const order = (action: LogOrder['action'], ticker: string, close: number): LogOrder => ({ action, ticker, close });
const row = (t: number, orders: LogOrder[], value = 10_420.35): LogRow => ({ t, orders, value });

const R1 = row(utc(2026, 11, 16), [order('buy', 'SPY', 5123.456), order('sell', 'TLT', 91.2)]);
const R2 = row(utc(2026, 11, 19), [order('add', 'SPY', 5200)], 10_900);

const logOf = (note: string, line?: number) => {
  const r = readLog(note, line);
  assert.ok(r.ok, r.ok ? '' : r.message);
  return r;
};

const added = (note: string, rows: LogRow[], through: number, line?: number) => {
  const r = appendLog(note, line, rows, through, NOW);
  assert.ok(r.ok, r.ok ? '' : r.message);
  return r;
};

test('the first append writes the check line and the table under the heading, and nothing else changes', () => {
  const note = started();
  const r = added(note, [R1], utc(2026, 11, 17));
  assert.equal(r.added, 1);
  assert.equal(
    r.note.slice(note.indexOf('## Log')),
    [
      '## Log',
      '',
      'Checked through: 2026-11-17',
      '',
      '| Bar | Orders | Closes | Value | Logged |',
      '| --- | --- | --- | ---: | --- |',
      '| 2026-11-16 | Sell TLT; Buy SPY | TLT 91.20; SPY 5,123.46 | $10,420.35 | 2026-11-17 |',
      '',
    ].join('\n'),
  );
  assert.equal(r.note.slice(0, note.indexOf('## Log')), note.slice(0, note.indexOf('## Log')));
  const log = logOf(r.note);
  assert.equal(log.checkedThrough, utc(2026, 11, 17));
  assert.deepEqual(log.bars, [{ t: utc(2026, 11, 16), orders: ['Sell TLT', 'Buy SPY'] }]);
});

test('asking again changes nothing, and later bars are added after the last logged one with the check line moved in place', () => {
  const once = added(started(), [R1], utc(2026, 11, 17)).note;
  const again = added(once, [R1], utc(2026, 11, 17));
  assert.equal(again.note, once);
  assert.equal(again.added, 0);

  const twice = added(once, [R1, R2], utc(2026, 11, 20));
  assert.equal(twice.added, 1);
  assert.equal(count(twice.note, /Checked through:/g), 1);
  assert.ok(twice.note.includes('Checked through: 2026-11-20\n'));
  assert.ok(twice.note.includes('| 2026-11-19 | Add SPY | SPY 5,200.00 | $10,900.00 | 2026-11-17 |\n'));
  assert.ok(twice.note.includes('| 2026-11-16 | Sell TLT; Buy SPY | TLT 91.20; SPY 5,123.46 | $10,420.35 | 2026-11-17 |\n'));
  assert.deepEqual(logOf(twice.note).bars.map((b) => b.t), [utc(2026, 11, 16), utc(2026, 11, 19)]);

  const thrice = added(twice.note, [R1, R2], utc(2026, 11, 20));
  assert.equal(thrice.note, twice.note);
});

test('a bar is added only when it is after the last logged one, however the rows come', () => {
  const note = added(started(), [R2], utc(2026, 11, 20)).note;
  // R1 is before the last logged bar: it is not slipped in above it, even though it is new.
  const r = added(note, [R1], utc(2026, 11, 20));
  assert.equal(r.added, 0);
  assert.equal(r.note, note);
});

test('rows at or before the start, without orders, repeated, or out of order are handled', () => {
  const rows = [
    row(utc(2026, 11, 13), [order('buy', 'SPY', 1)]),
    row(utc(2026, 11, 12), [order('buy', 'SPY', 1)]),
    row(utc(2026, 11, 24), [order('sell', 'SPY', 9)]),
    row(utc(2026, 11, 18), []),
    row(utc(2026, 11, 20), [order('buy', 'QQQ', 5)]),
    row(utc(2026, 11, 20), [order('buy', 'IWM', 5)]),
  ];
  const r = added(started(), rows, utc(2026, 11, 25));
  assert.equal(r.added, 2);
  assert.deepEqual(logOf(r.note).bars, [
    { t: utc(2026, 11, 20), orders: ['Buy QQQ'] },
    { t: utc(2026, 11, 24), orders: ['Sell SPY'] },
  ]);
});

test('checking with no new orders still records the day, once, and never moves it back', () => {
  const note = started();
  const checked = added(note, [], utc(2026, 11, 17));
  assert.equal(checked.added, 0);
  assert.ok(checked.note.endsWith('## Log\n\nChecked through: 2026-11-17\n'));
  assert.equal(added(checked.note, [], utc(2026, 11, 17)).note, checked.note);
  assert.equal(added(checked.note, [], utc(2026, 11, 14)).note, checked.note, 'older prices do not move it back');
  assert.ok(added(checked.note, [], utc(2026, 11, 18)).note.endsWith('## Log\n\nChecked through: 2026-11-18\n'));
});

test('a row already in the table is never rewritten, whatever was done to it by hand', () => {
  const once = added(started(), [R1], utc(2026, 11, 17)).note;
  const edited = once.replace('| Sell TLT; Buy SPY |', '| Sell TLT; Buy SPY (placed at 9:31) |').replace('$10,420.35', 'about 10.4k');
  const r = added(edited, [R1, R2], utc(2026, 11, 20));
  assert.ok(r.note.includes('| 2026-11-16 | Sell TLT; Buy SPY (placed at 9:31) | TLT 91.20; SPY 5,123.46 | about 10.4k | 2026-11-17 |'));
  assert.equal(r.added, 1);
});

test('text around the log is kept: other sections, notes under the heading and a table that is not the log', () => {
  const note = started().replace(/\n$/, '\n\nMy notes on the log.\n\n## Later\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n');
  const r = added(note, [R1], utc(2026, 11, 17));
  assert.ok(r.note.includes('## Log\n\nChecked through: 2026-11-17\n\n| Bar |'));
  assert.ok(r.note.includes('| 2026-11-16 | Sell TLT; Buy SPY | TLT 91.20; SPY 5,123.46 | $10,420.35 | 2026-11-17 |\n\nMy notes on the log.\n\n## Later\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'));
  assert.deepEqual(logOf(r.note).bars.length, 1);
  assert.equal(added(r.note, [R1, R2], utc(2026, 11, 20)).note.includes('| 1 | 2 |'), true);
});

test('a heading in the frozen text is not the log heading', () => {
  const source = `${STRATEGY}\n## Log\n# Checked through: nowhere`;
  const note = started({ source });
  const r = added(note, [R1], utc(2026, 11, 17));
  assert.ok(r.note.indexOf('| Bar |') > r.note.lastIndexOf('```'));
  assert.deepEqual(logOf(r.note).bars.length, 1);
  assert.equal(forwardChanged(logOf(r.note).forward), false);
});

test('with two forward blocks the one named by its line is used, and a line with none is NOTE_CHANGED', () => {
  const a = started();
  const b = started({ started: utc(2026, 11, 18), name: 'Second' });
  const note = `${a}\n${b}`;
  const secondIn = (text: string) => text.split('\n').findIndex((l, i) => l.startsWith('```forward') && i > 10);
  const second = secondIn(note);
  const r = added(note, [R1, R2], utc(2026, 11, 20), second);
  // The second test began on 2026-11-18, so the bar of the 16th is not part of it. Lines were added above the block, so it moved down.
  assert.equal(r.added, 1);
  assert.ok(secondIn(r.note) > second);
  assert.deepEqual(logOf(r.note, secondIn(r.note)).bars.map((x) => x.t), [utc(2026, 11, 19)]);
  assert.equal(readLog(r.note, second).ok, false);
  const gone = appendLog(note, second + 1, [R1], utc(2026, 11, 20), NOW);
  assert.deepEqual(gone, { ok: false, message: NOTE_CHANGED });
});

test('a note the plugin did not make is refused, and so is one whose frozen rules were edited', () => {
  const note = started();
  const noProperty = appendLog(note.replace('backtest_forward: true', 'tags: [x]'), undefined, [R1], utc(2026, 11, 17), NOW);
  assert.ok(!noProperty.ok && noProperty.message.includes('was not made as a forward test') && noProperty.message.includes('backtest_forward'));
  assert.equal(appendLog(note.replace(/^---\n[\s\S]*?\n---\n/, ''), undefined, [R1], utc(2026, 11, 17), NOW).ok, false);

  const edited = appendLog(note.replace('sma(200)', 'sma(100)'), undefined, [R1], utc(2026, 11, 17), NOW);
  assert.ok(!edited.ok && edited.message === `${CHANGED} Nothing was written.`);

  const noBlock = appendLog('---\nbacktest_forward: true\n---\n\n## Log\n', undefined, [R1], utc(2026, 11, 17), NOW);
  assert.deepEqual(noBlock, { ok: false, message: 'This note has no forward block. Nothing was written.' });

  const broken = appendLog(note.replace(/check: \w+/, 'check:'), undefined, [R1], utc(2026, 11, 17), NOW);
  assert.ok(!broken.ok && broken.message.includes("The forward block can't be read. Line 3:"));

  const noHeading = appendLog(note.replace('\n## Log\n', '\n## Diary\n'), undefined, [R1], utc(2026, 11, 17), NOW);
  assert.ok(!noHeading.ok && noHeading.message.includes('no "## Log" heading'));
});

test('a table edited by hand so the last bar cannot be read is refused, and nothing is written', () => {
  const once = added(started(), [R1, R2], utc(2026, 11, 20)).note;
  const refused = (edited: string) => {
    assert.notEqual(edited, once);
    const r = appendLog(edited, undefined, [row(utc(2026, 11, 25), [order('buy', 'SPY', 1)])], utc(2026, 11, 26), NOW);
    assert.ok(!r.ok && r.message === "The log table was changed by hand, so the last logged bar can't be read. Nothing was written.", edited);
    assert.equal(readLog(edited).ok, false);
  };
  refused(once.replace('| 2026-11-19 |', '| last Friday |'));
  refused(once.replace('| 2026-11-16 |', '| 16 Nov |'));
  refused(once.replace('| 2026-11-19 |', '| 2026-02-30 |'));
  refused(once.replace('| --- | --- | --- | ---: | --- |\n', ''));
  refused(once.replace('| --- | --- | --- | ---: | --- |', '| lots | of | words |'));
  refused(once.replace(/\| Bar[^\n]*\n\| ---[^\n]*\n/, '| Bar |\n'));
  refused(once.replace('| 2026-11-19 |', '|  |'));
});

test('a table the reader trimmed of rows, or of its Checked through line, is added to from what is left', () => {
  const once = added(started(), [R1, R2], utc(2026, 11, 20)).note;
  const noCheck = once.replace('Checked through: 2026-11-20\n\n', '');
  const r = added(noCheck, [R1, R2, row(utc(2026, 11, 23), [order('sell', 'SPY', 5300)])], utc(2026, 11, 24));
  assert.equal(r.added, 1);
  assert.ok(r.note.includes('## Log\n\nChecked through: 2026-11-24\n\n| Bar |'));
  assert.deepEqual(logOf(r.note).bars.map((b) => b.t), [utc(2026, 11, 16), utc(2026, 11, 19), utc(2026, 11, 23)]);

  const noRows = once.replace(/\| 2026-11-1[69] [^\n]*\n/g, '');
  assert.equal(logOf(noRows).bars.length, 0);
  assert.equal(added(noRows, [R1, R2], utc(2026, 11, 20)).added, 0, 'the bars checked stay checked, rows or no rows');
  const bare = noRows.replace('Checked through: 2026-11-20\n\n', '');
  assert.equal(added(bare, [R1, R2], utc(2026, 11, 20)).added, 2, 'with no rows and no check line left, the log starts from the start of the test again');

  const unreadable = once.replace('Checked through: 2026-11-20', 'Checked through: soon');
  assert.equal(logOf(unreadable).checkedThrough, null);
  assert.ok(added(unreadable, [], utc(2026, 11, 20)).note.includes('Checked through: 2026-11-20\n'));
});

test('a note with Windows line ends keeps them, whether or not it ends with a line break', () => {
  const crlf = (text: string) => text.replace(/\n/g, '\r\n');
  const noBareLf = (text: string) => assert.ok(!/(?<!\r)\n/.test(text), JSON.stringify(text.slice(-200)));
  for (const trim of [false, true]) {
    const note = crlf(trim ? started().trimEnd() : started());
    const first = added(note, [R1], utc(2026, 11, 17));
    noBareLf(first.note);
    assert.equal(first.note.endsWith('\r\n'), !trim);
    assert.ok(!first.note.endsWith('\r') || first.note.endsWith('\r\n'));
    assert.equal(logOf(first.note).bars.length, 1);

    const second = added(first.note, [R1, R2], utc(2026, 11, 20));
    noBareLf(second.note);
    assert.equal(second.note.endsWith('\r\n'), !trim);
    assert.ok(second.note.includes('Checked through: 2026-11-20\r\n'));
    assert.deepEqual(logOf(second.note).bars.map((b) => b.t), [utc(2026, 11, 16), utc(2026, 11, 19)]);
    assert.equal(added(second.note, [R1, R2], utc(2026, 11, 20)).note, second.note);
    assert.equal(forwardChanged(logOf(second.note).forward), false);
  }
});

test('a note with Unix line ends and no final line break stays without one', () => {
  const note = started().trimEnd();
  const first = added(note, [R1], utc(2026, 11, 17));
  assert.ok(!first.note.endsWith('\n') && !first.note.includes('\r'));
  const second = added(first.note, [R2], utc(2026, 11, 20));
  assert.ok(second.note.endsWith('| 2026-11-17 |') && !second.note.includes('\r'));
  assert.equal(logOf(second.note).bars.length, 2);
});

test('an intraday log keeps the time of day in the bar and in the check line', () => {
  const note = started({ started: utc(2026, 11, 13, 15, 30), intraday: true });
  const rows = [row(utc(2026, 11, 13, 15, 30), [order('buy', 'SPY', 1)]), row(utc(2026, 11, 13, 16, 30), [order('buy', 'SPY', 5000)])];
  const r = added(note, rows, utc(2026, 11, 13, 17, 30));
  assert.equal(r.added, 1, 'the start bar itself is not part of the test');
  assert.ok(r.note.includes('Checked through: 2026-11-13 17:30\n'));
  assert.ok(r.note.includes('| 2026-11-13 16:30 | Buy SPY | SPY 5,000.00 |'));
  assert.deepEqual(logOf(r.note).bars, [{ t: utc(2026, 11, 13, 16, 30), orders: ['Buy SPY'] }]);
});

test('a ticker with a bar in it is escaped in the table and read back whole', () => {
  const r = added(started(), [row(utc(2026, 11, 16), [order('buy', 'A|B', 1)])], utc(2026, 11, 17));
  assert.ok(r.note.includes('| Buy A\\|B | A\\|B 1.00 |'));
  assert.deepEqual(logOf(r.note).bars[0].orders, ['Buy A|B']);
});

test('readLog says why a note has no log to read', () => {
  assert.deepEqual(readLog('# nothing'), { ok: false, message: 'This note has no forward block.' });
  assert.deepEqual(readLog(started().replace('\n## Log\n', '\n## Diary\n')), { ok: false, message: 'This note has no "## Log" heading.' });
});

test('newRows are the bars with orders after the last one logged, one each, earliest first', () => {
  const log = logOf(added(started(), [R1], utc(2026, 11, 17)).note);
  const later = row(utc(2026, 11, 20), [order('buy', 'QQQ', 1)]);
  assert.deepEqual(newRows(log, [later, R2, R1, row(utc(2026, 11, 18), []), later]), [R2, later]);
  assert.deepEqual(newRows(log, [R1]), []);
  assert.deepEqual(newRows(logOf(started()), [R1, row(utc(2026, 11, 13), [order('buy', 'SPY', 1)])]), [R1], 'with nothing logged, the bars after the start');
});

test('a bar already checked is never added, though revised prices now give an order there: the log keeps what it said', () => {
  const note = added(started(), [R1], utc(2026, 11, 20)).note;
  // Today's prices give an order on the 18th, checked with none, and on the 23rd, not checked yet.
  const revised = row(utc(2026, 11, 18), [order('sell', 'SPY', 98)]);
  const fresh = row(utc(2026, 11, 23), [order('buy', 'SPY', 99)]);
  const log = logOf(note);
  assert.deepEqual(revisions(log, [R1, revised]).map((r) => r.t), [utc(2026, 11, 18)]);
  assert.deepEqual(newRows(log, [R1, revised, fresh]), [fresh]);
  assert.deepEqual(newRows(log, [R1, revised]), []);
  const again = added(note, [R1, revised], utc(2026, 11, 20));
  assert.deepEqual([again.added, again.note], [0, note]);
  const later = added(note, [R1, revised, fresh], utc(2026, 11, 23));
  assert.deepEqual(logOf(later.note).bars.map((b) => b.t), [utc(2026, 11, 16), utc(2026, 11, 23)]);
});

// --- Revisions --------------------------------------------------------------------------------------------------------

test('a revision names each bar where the log and today disagree about the orders, and nothing else', () => {
  const note = added(
    started(),
    [
      row(utc(2026, 12, 3), [order('buy', 'SPY', 100)]),
      row(utc(2026, 12, 4), [order('sell', 'SPY', 101), order('buy', 'TLT', 90)]),
      row(utc(2026, 12, 8), [order('buy', 'SPY', 100)]),
    ],
    utc(2026, 12, 10),
  ).note;
  const log = logOf(note);
  const today: LogRow[] = [
    row(utc(2026, 11, 10), [order('buy', 'OLD', 1)]),
    // 12-03 gave no order today; 12-04 gives the same orders in another order, and another price.
    row(utc(2026, 12, 4), [order('buy', 'TLT', 87), order('sell', 'SPY', 97)]),
    row(utc(2026, 12, 7), [order('buy', 'QQQ', 5)]),
    row(utc(2026, 12, 8), [order('sell', 'SPY', 100)]),
    row(utc(2026, 12, 11), [order('buy', 'QQQ', 5)]),
  ];
  assert.deepEqual(revisions(log, today), [
    { t: utc(2026, 12, 3), message: "The log says Buy SPY on 2026-12-03; today's prices give no order there." },
    { t: utc(2026, 12, 7), message: "The log has no order on 2026-12-07; today's prices give Buy QQQ there." },
    { t: utc(2026, 12, 8), message: "The log says Buy SPY on 2026-12-08; today's prices give Sell SPY there." },
  ]);
});

test('the same orders at other closes are no revision, and neither is a bar that is not logged yet', () => {
  const note = added(started(), [row(utc(2026, 12, 3), [order('buy', 'SPY', 100)])], utc(2026, 12, 4)).note;
  const log = logOf(note);
  assert.deepEqual(revisions(log, [row(utc(2026, 12, 3), [order('buy', 'SPY', 97.5)], 1)]), []);
  assert.deepEqual(revisions(log, [row(utc(2026, 12, 3), [order('buy', 'SPY', 97.5)]), row(utc(2026, 12, 7), [order('sell', 'SPY', 1)])]), []);
  assert.deepEqual(revisions(logOf(started()), [row(utc(2026, 12, 3), [order('buy', 'SPY', 1)])]), [], 'a log never checked has nothing to compare');
});

test('several orders on a bar are listed in full in the message, and an intraday bar names its time', () => {
  const note = added(
    started({ started: utc(2026, 11, 13, 15, 30), intraday: true }),
    [row(utc(2026, 11, 13, 16, 30), [order('buy', 'SPY', 1), order('buy', 'QQQ', 1)])],
    utc(2026, 11, 13, 17, 30),
  ).note;
  const out = revisions(logOf(note), [row(utc(2026, 11, 13, 16, 30), [order('sell', 'IWM', 1), order('buy', 'SPY', 1)])]);
  assert.deepEqual(out.map((r) => r.message), ["The log says Buy QQQ, Buy SPY on 2026-11-13 16:30; today's prices give Sell IWM, Buy SPY there."]);
});
