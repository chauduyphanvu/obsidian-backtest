// Position values that read the bars since the entry: `highest since entry`, `lowest since entry` and `position return`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { cellText, debugColumns, debugRange, debugRows } from '../src/debug.ts';
import { parseSpec, POSITION, RESERVED, type Expr } from '../src/dsl.ts';
import { Evaluator, type PosState } from '../src/evaluate.ts';
import { explainTrade } from '../src/explain.ts';
import { lookbackBars } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { bars, near } from './helpers.ts';
import { head, tally, verify, walkBars } from './trigger-helpers.ts';

const N = NaN;
const parse = (src: string) => {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, [], src);
  return spec!;
};
const sellRule = (text: string) => parse(`universe: A\nbuy when true\nsell when ${text}`).rules.A.sell!;
/** The number a position value is, as a part of a rule that compares it. */
const value = (text: string): Expr => (sellRule(`${text} > 0`) as Extract<Expr, { k: 'cmp' }>).a;

// Five bars. Each open is the close before, but for bar 2 (10.4 after a close of 10.5).
const closes = [10, 10.5, 10.8, 11, 9.5];
const opens = [10, 10, 10.4, 11, 10];
const lows = [10, 9.8, 10, 10.2, 9];
/** Bar 0 either stays at its close (a high of 10) or spikes to 13, which only a position filled before it could have seen. */
const flat = bars(closes, { opens, highs: [10, 12, 11, 11.5, 10.2], lows });
const spike = bars(closes, { opens, highs: [13, 12, 11, 11.5, 10.2], lows: [9, 9.8, 10, 10.2, 9] });

// ---------------------------------------------------------------- how they are written

test('the three values, with spaces or underscores, in sell, cover and add rules only', () => {
  for (const [name, words] of Object.entries(POSITION)) assert.ok(RESERVED.has(name), `${name} is reserved`);
  assert.equal(POSITION.highest_since_entry, 'highest since entry');
  assert.equal(POSITION.lowest_since_entry, 'lowest since entry');
  assert.equal(POSITION.position_return, 'position return');
  const same = (a: string, b: string) => assert.deepEqual(sellRule(a), sellRule(b));
  same('close < highest since entry - 3 * atr(22)', 'close < highest_since_entry - 3 * atr(22)');
  same('close > lowest since entry * 1.1', 'close > lowest_since_entry * 1.1');
  same('position return > 20%', 'position_return > 20%');
  same('HIGHEST   SINCE  ENTRY > 1', 'highest_since_entry > 1');
  assert.deepEqual(sellRule('position return > 20%'), { k: 'cmp', op: '>', a: { k: 'pos', name: 'position_return' }, b: { k: 'num', v: 0.2 } });
  for (const word of ['highest since entry', 'lowest since entry', 'position return']) {
    const buy = parseSpec(`universe: A\nbuy when ${word} > 1`).errors;
    assert.deepEqual(buy.map((e) => [e.line, e.from, e.to, e.message]), [[2, 9, 9 + word.length, `"${word}" only makes sense in a sell, cover or add rule`]]);
    assert.equal(parseSpec(`universe: A\nbuy when close > 1\nshort when ${word} > 1`).errors[0].message, `"${word}" only makes sense in a sell, cover or add rule`);
    assert.equal(parseSpec(`universe: A\nbuy when close > 1\nsell when ${word} > 1`).errors.length, 0);
    assert.equal(parseSpec(`universe: A\nbuy when close > 1\nshort when close < 1\ncover when ${word} > 1`).errors.length, 0);
    assert.equal(parseSpec(`universe: A\nentries: 2\nbuy when close > 1\nadd when ${word} > 1`).errors.length, 0);
  }
});

test('highest, lowest and position alone keep their meanings, and the words after them are checked', () => {
  const fn = sellRule('close < highest(20) and close > lowest(5)');
  assert.equal(JSON.stringify(fn).includes('"fn":"highest"') && JSON.stringify(fn).includes('"fn":"lowest"'), true);
  // "position" is free for a parameter, as "last" is.
  assert.deepEqual(parseSpec('universe: A\nposition = 3\nbuy when close > sma(position)\nsell when position return > 0.1').errors, []);
  assert.match(parseSpec('universe: A\nbuy when true\nsell when highest since > 1').errors[0].message, /^"highest since" needs "entry" after it, as in highest since entry$/);
  assert.match(parseSpec('universe: A\nbuy when true\nsell when lowest since high > 1').errors[0].message, /^"lowest since" needs "entry" after it, as in lowest since entry$/);
  assert.match(parseSpec('universe: A\nbuy when true\nsell when highest > 1').errors[0].message, /^highest\(\) needs a period/);
  assert.match(parseSpec('universe: A\nbuy when true\nsell when position > 1').errors[0].message, /^Unknown name "position"/);
});

test('they cannot go inside a function, over a window, with [n] or with of, and each says so', () => {
  const msg = (rule: string) => parseSpec(`universe: A, B\nbuy when true\nsell when ${rule}`).errors.map((e) => e.message);
  assert.deepEqual(msg('highest since entry[1] > 1'), ['"highest since entry" can\'t be read for an earlier bar with [n]']);
  assert.deepEqual(msg('position return of B > 0'), ['"position return" belongs to the open position, so it can\'t be read with "of"']);
  assert.deepEqual(msg('sma(highest since entry, 3) > 1'), ['"highest since entry" can\'t go inside sma(): it only exists while a position is open']);
  assert.match(msg('lowest since entry < 1 for 3 bars')[0], /^"lowest since entry" can't be read over several bars/);
  // A "hold" score has no position either.
  assert.match(parseSpec('universe: A, B\nhold: top 1 by position return').errors[0].message, /^"position return" only makes sense in a sell, cover or add rule/);
});

test('the history a rule needs does not change for a position value', () => {
  const plain = parse('universe: A\nfrom: 2020-01-01\nbuy when close > sma(300)\nsell when close < 1');
  const since = parse('universe: A\nfrom: 2020-01-01\nbuy when close > sma(300)\nsell when close < highest since entry - atr(14) or position return > 1');
  assert.equal(lookbackBars(since), lookbackBars(plain));
});

// ---------------------------------------------------------------- what they hold, bar by bar

test('highest since entry: the fill price before slippage, the highs after it, and the fill bar\'s own high when it filled at that bar\'s open', () => {
  const ev = new Evaluator(new Map([['A', flat]]));
  const rule = ev.compile(value('highest since entry'), 'A');
  // Filled at bar 1's open (10): bar 1's high of 12 counts, then 12, 12, 12 as the later highs stay below it.
  const open: PosState = { entryIdx: 1, entryPrice: 10.1 };
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => rule(i, open)), [N, 12, 12, 12, 12]);
  // The price it filled at is the base: a position whose bars never go above it holds that.
  const low = new Evaluator(new Map([['A', bars([10, 9, 9, 9], { opens: [10, 10, 9, 9], highs: [10, 10, 9, 9] })]])).compile(value('highest since entry'), 'A');
  assert.deepEqual([0, 1, 2, 3].map((i) => low(i, { entryIdx: 1, entryPrice: 10.1 })), [N, 10, 10, 10]);
  // Not held, or read for a bar before the entry: unknown.
  assert.deepEqual([rule(2, null), rule(0, open)], [N, N]);
});

test('with fill: close the fill bar\'s own range came before the fill, so only the close counts from it', () => {
  const ev = new Evaluator(new Map([['A', spike]]));
  const rule = ev.compile(value('highest since entry'), 'A');
  const lowest = ev.compile(value('lowest since entry'), 'A');
  // Filled at bar 0's close (10): its high of 13 and low of 9 do not count; bar 1's high of 12 does.
  const closed: PosState = { entryIdx: 0, entryPrice: 10, atClose: true };
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => rule(i, closed)), [10, 12, 12, 12, 12]);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => lowest(i, closed)), [10, 9.8, 9.8, 9.8, 9]);
  // At an open the same bar counts in full.
  const open: PosState = { entryIdx: 0, entryPrice: 10 };
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => rule(i, open)), [13, 13, 13, 13, 13]);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => lowest(i, open)), [9, 9, 9, 9, 9]);
});

test('lowest since entry mirrors it with lows, the same for either side', () => {
  const ev = new Evaluator(new Map([['A', flat]]));
  const rule = ev.compile(value('lowest since entry'), 'A');
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => rule(i, { entryIdx: 1, entryPrice: 10 })), [N, 9.8, 9.8, 9.8, 9]);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => rule(i, { entryIdx: 1, entryPrice: 10, short: true })), [N, 9.8, 9.8, 9.8, 9]);
  // Entered at bar 3 at its open, 11: lows 10.2 then 9.
  assert.deepEqual([2, 3, 4].map((i) => rule(i, { entryIdx: 3, entryPrice: 11 })), [N, 10.2, 9]);
});

test('position return: close over the entry price less 1 for a long, 1 less that for a short, before costs', () => {
  const ev = new Evaluator(new Map([['A', flat]]));
  const rule = ev.compile(value('position return'), 'A');
  const long = [0, 1, 2, 3, 4].map((i) => rule(i, { entryIdx: 1, entryPrice: 10 }));
  assert.ok(long.slice(1).every((x, k) => near(x, [10.5, 10.8, 11, 9.5][k] / 10 - 1)), JSON.stringify(long));
  const short = [1, 2, 3, 4].map((i) => rule(i, { entryIdx: 1, entryPrice: 10, short: true }));
  assert.ok(short.every((x, k) => near(x, 1 - [10.5, 10.8, 11, 9.5][k] / 10)), JSON.stringify(short));
  assert.deepEqual(rule(2, null), N);
  // Held several entries, the entry price is their average.
  assert.ok(near(rule(3, { entryIdx: 1, entryPrice: 10.5, entries: 2 }), 11 / 10.5 - 1));
});

test('the running value is right whatever order the bars are asked in, and for another position', () => {
  const ev = new Evaluator(new Map([['A', flat]]));
  const rule = ev.compile(value('highest since entry'), 'A');
  const a: PosState = { entryIdx: 1, entryPrice: 10 };
  assert.equal(rule(3, a), 12);
  // Back to an earlier bar of the same position: worked out again, not kept from the later one.
  assert.equal(rule(1, a), 12);
  assert.equal(rule(0, a), N);
  // Another position of the same ticker, entered later, reads its own bars.
  assert.deepEqual([3, 4].map((i) => rule(i, { entryIdx: 3, entryPrice: 11 })), [11.5, 11.5]);
  assert.equal(rule(2, a), 12);
  // The same entry bar filled at a close is another position.
  assert.equal(rule(2, { entryIdx: 1, entryPrice: 10.5, atClose: true }), 11);
  assert.equal(rule(1, { entryIdx: 1, entryPrice: 10.5, atClose: true }), 10.5);
});

// ---------------------------------------------------------------- in a run

const run = (src: string, data: Bars) => runBacktest(parse(src), new Map([['A', data]]));

test('a rule on highest since entry exits when the close falls that far from the high, the fill bar\'s high counting at an open', () => {
  // Bought at day 1's open (10). Day 1's high of 12 gives 12 - 1.4 = 10.6, and its close of 10.5 is below: sold at day 2's open.
  const bt = run('universe: A\ncapital: 1000\nbuy when close == 10\nsell when close < highest since entry - 1.4', flat);
  assert.deepEqual(bt.run.trades.map((t) => [t.entryPrice, t.exitT, t.exitPrice, t.reason]), [[10, flat.t[2], 10.4, 'signal']]);
});

test('with fill: close the same strategy does not see the fill bar\'s high', () => {
  // Bought at day 0's close (10). The high of 13 that day came before: the high is 12 (day 1), the line 10.2, first crossed by day 4's 9.5.
  const bt = run('universe: A\ncapital: 1000\nfill: close\nbuy when close == 10\nsell when close < highest since entry - 1.8', spike);
  assert.deepEqual(bt.run.trades.map((t) => [t.entryT, t.entryPrice, t.exitT, t.exitPrice, t.reason]), [[spike.t[0], 10, spike.t[4], 9.5, 'signal']]);
});

test('position return counts slippage in the entry price, and a short is the mirror', () => {
  // 1% slippage: bought at day 1's open, 10 * 1.01 = 10.1. Day 2's close of 10.8 is 6.9% up, over the 5%: sold at day 3's open, 11 less slippage.
  const long = run('universe: A\ncapital: 1000\nslippage: 100 bps\nbuy when close == 10\nsell when position return > 5%', flat);
  assert.equal(long.run.trades.length, 1);
  assert.ok(near(long.run.trades[0].entryPrice, 10.1) && near(long.run.trades[0].exitPrice, 11 * 0.99) && long.run.trades[0].exitT === flat.t[3]);
  // A short from day 1's open, 10; the price falls to 9.2 at day 2 (8% up for a short) and the cover fills at day 3's open, 9.3.
  const fall = bars([10, 9.8, 9.2, 9, 9.5], { opens: [10, 10, 9.7, 9.3, 9], highs: [10, 10.1, 9.8, 9.4, 9.6], lows: [10, 9.7, 9.1, 8.9, 8.8] });
  const short = run('universe: A\ncapital: 1000\nshort when close == 10\ncover when position return > 7%', fall);
  const [t] = short.run.trades;
  assert.deepEqual([t.side, t.entryPrice, t.exitT, t.exitPrice, t.reason], ['short', 10, fall.t[3], 9.3, 'signal']);
});

test('a short reads the highest price since entry as a price, with the fill bar\'s high', () => {
  const fall = bars([10, 9.8, 9.2, 9, 9.5], { opens: [10, 10, 9.7, 9.3, 9], highs: [10, 10.1, 9.8, 9.4, 9.6], lows: [10, 9.7, 9.1, 8.9, 8.8] });
  // Day 1's high of 10.1 counts: 10.1 - 0.25 = 9.85 is above every close after, so the short is never covered.
  const kept = run('universe: A\ncapital: 1000\nshort when close == 10\ncover when close > highest since entry - 0.25', fall);
  assert.deepEqual(kept.run.trades.map((t) => [t.side, t.reason]), [['short', 'open']]);
  // The lowest since entry: 9.7 on day 1, 9.1 on day 2, 8.9 on day 3, 8.8 on day 4. A rise of 0.4 from it first comes at day 4 (9.5 > 9.2).
  const rebound = run('universe: A\ncapital: 1000\nshort when close == 10\ncover when close > lowest since entry + 0.4', fall);
  assert.deepEqual(rebound.run.trades.map((t) => [t.side, t.entryPrice, t.reason]), [['short', 10, 'open']]);
  assert.deepEqual(rebound.run.states[0].pos, { entryIdx: 1, entryPrice: 10, lastPrice: 10, entries: 1, short: true });
});

test('a position built in entries reads its bars from the first entry, and the average as its entry price', () => {
  // Bought at day 1's open, 10; day 2 closes above 11, so an add fills at day 3's open, 11. The high of 15 on day 2 came before the add.
  const b = bars([10, 10.8, 11.5, 12.5, 13, 11, 9.5], { opens: [10, 10, 10.5, 11, 12, 12, 12], highs: [10, 11, 15, 13, 14, 12.5, 12], lows: [10, 9.9, 10.5, 11, 12, 10, 9] });
  const src = (exit: string) => `universe: A\ncapital: 1000\nentries: 2\nbuy when close == 10\nadd when close > 11\nsell when ${exit}`;
  // From the first entry the high is 15, so 15 - 3.5 = 11.5 is first crossed by day 5's close of 11: out at day 6's open, 12.
  const first = run(src('close < highest since entry - 3.5'), b);
  assert.deepEqual(first.run.trades.map((t) => [t.entries!.length, t.exitT, t.exitPrice]), [[2, b.t[6], 12]]);
  // Counted from the add the high would be 14 and the line 10.5, not crossed by day 5.
  const average = first.run.trades[0].entryPrice;
  assert.ok(near(average, 1000 / (500 / 10 + 500 / 11)));
  const ret = run(src('position return > 0.19'), b);
  // The average entry price, 10.476..., makes day 3's close of 12.5 a 19.3% return; before the add day 2's 11.5 over 10 would be 15%.
  assert.deepEqual(ret.run.trades.map((t) => [t.exitT, t.exitPrice]), [[b.t[4], 12]]);
});

test('the high since entry is the high-water mark the trailing stop trails from, for both fills and both sides', () => {
  for (const fill of ['', 'fill: close\n']) {
    for (const seed of [3, 4, 5, 6]) {
      const data = walkBars(150, seed, { vol: 0.02 });
      const last = data.t.length - 1;
      const ev = new Evaluator(new Map([['A', data]]));
      // A 90% trail never closes the position here, so the state at the end holds the mark as the engine kept it.
      const long = run(`universe: A\ncapital: 10000\n${fill}trailing stop: 90%\nbuy when true`, data).run.states[0];
      assert.equal(long.side, 'long');
      const high = ev.compile(value('highest since entry'), 'A')(last, long.pos!);
      assert.ok(near(high, long.levels!.stop! / (1 - 0.9), 1e-9 * high), `${fill}long ${seed}: ${high} against ${long.levels!.stop! / 0.1}`);
      const short = run(`universe: A\ncapital: 10000\n${fill}trailing stop: 90%\nshort when true`, data).run.states[0];
      assert.equal(short.side, 'short');
      const low = ev.compile(value('lowest since entry'), 'A')(last, short.pos!);
      assert.ok(near(low, short.levels!.stop! / 1.9, 1e-9 * low), `${fill}short ${seed}: ${low} against ${short.levels!.stop! / 1.9}`);
    }
  }
});

// ---------------------------------------------------------------- the rule table, the explanation and the engine agree

test('the rule table reads the position as the engine does, at an open fill and a close fill', () => {
  const table = (src: string, data: Bars) => {
    const bt = run(src, data);
    const cols = debugColumns(bt, 'A');
    const col = cols.findIndex((c) => c.group === 'sell');
    const rows = debugRows(bt, 'A', 0, debugRange(bt, 'A').count);
    return { bt, cols, col, rows };
  };
  const open = table('universe: A\ncapital: 1000\nbuy when close == 10\nsell when close < highest since entry - 1.4', flat);
  const cell = (t: typeof open, i: number) => t.rows[i].cells[t.col];
  // Day 0: no position. Day 1: the position was bought at that open and its high is 12, so the line is 10.6.
  assert.equal(cell(open, 0).outcome, null);
  assert.ok(near(cell(open, 1).a, 10.5) && near(cell(open, 1).b, 10.6));
  assert.equal(cell(open, 1).outcome, 'yes');
  assert.equal(cellText(open.cols[open.col], cell(open, 1)).main, '10.50 < 10.60');
  const closed = table('universe: A\ncapital: 1000\nfill: close\nbuy when close == 10\nsell when close < highest since entry - 1.8', spike);
  assert.deepEqual([1, 2, 3, 4].map((i) => cell(closed, i).b), [10.2, 10.2, 10.2, 10.2].map((x) => x));
  assert.deepEqual([1, 2, 3, 4].map((i) => cell(closed, i).outcome), ['no', 'no', 'no', 'yes']);
  // Short: the table's position says it is short, so a return reads as a short's.
  const fall = bars([10, 9.8, 9.2, 9, 9.5], { opens: [10, 10, 9.7, 9.3, 9], highs: [10, 10.1, 9.8, 9.4, 9.6], lows: [10, 9.7, 9.1, 8.9, 8.8] });
  const sh = table('universe: A\ncapital: 1000\nshort when close == 10\ncover when position return > 7%', fall);
  const cover = sh.cols.findIndex((c) => c.group === 'cover');
  // Day 2's return is 8%, over the 7%: the cover fills at day 3's open, so day 3 has no position to read.
  assert.deepEqual([1, 2, 3].map((i) => sh.rows[i].cells[cover].a.toFixed(3)), ['0.020', '0.080', 'NaN']);
  assert.deepEqual([1, 2, 3].map((i) => sh.rows[i].cells[cover].outcome), ['no', 'yes', null]);
});

test('the explanation of a trade works out the values with the position the rule read', () => {
  const sold = (src: string, data: Bars) => {
    const bt = run(src, data);
    return explainTrade(bt, bt.run.trades[0]).sections.find((s) => s.id === 'sold')!.rows[1];
  };
  assert.equal(sold('universe: A\ncapital: 1000\nbuy when close == 10\nsell when close < highest since entry - 1.4', flat).value, 'close 10.50 < highest since entry - 1.4 10.60');
  assert.equal(sold('universe: A\ncapital: 1000\nfill: close\nbuy when close == 10\nsell when close < highest since entry - 1.8', spike).value, 'close 9.50 < highest since entry - 1.8 10.20');
  const fall = bars([10, 9.8, 9.2, 9, 9.5], { opens: [10, 10, 9.7, 9.3, 9], highs: [10, 10.1, 9.8, 9.4, 9.6], lows: [10, 9.7, 9.1, 8.9, 8.8] });
  assert.equal(sold('universe: A\ncapital: 1000\nshort when close == 10\ncover when position return > 7%', fall).value, 'position return 8% > 7%');
});

test('on random prices the rule table and the engine agree on every bar the rule held, for both fills', () => {
  for (const fill of ['', 'fill: close\n']) {
    for (const rule of ['sell when close < highest since entry - 2 * atr(5) or position return > 8%', 'sell when close > lowest since entry * 1.05 or position return < -4%']) {
      const data = walkBars(300, 41, { vol: 0.03 });
      const src = `universe: A\n${fill}buy when rsi(3) < 40\n${rule}`;
      const bt = run(src, data);
      const exits = bt.run.trades.filter((t) => t.reason === 'signal');
      assert.ok(exits.length > 3, src);
      const rows = debugRows(bt, 'A', 0, debugRange(bt, 'A').count);
      // With next-open fills a sell read at the last bar is still waiting, so it has no exit yet.
      const readable = fill === '' ? rows.slice(0, -1) : rows;
      const held = readable.filter((r) => r.sell === 'yes' && r.readHeld).map((r) => r.t);
      const read = exits.map((t) => (fill === '' ? data.t[data.t.indexOf(t.exitT) - 1] : t.exitT));
      assert.deepEqual(held, read, src);
    }
  }
});

// ---------------------------------------------------------------- trigger prices

test('trigger prices for a rule on the high since entry and on the return: each price gives the order inside and not outside', () => {
  const seen = tally();
  const full = walkBars(900, 5, { vol: 0.03 });
  const sources = [
    'universe: A\ncapital: 10000\nbuy when close > sma(20)\nsell when close < highest since entry - 2 * atr(14)',
    'universe: A\ncapital: 10000\nfill: close\nbuy when close > sma(20)\nsell when close < highest since entry - 2 * atr(14) or position return > 10%',
    'universe: A\ncapital: 10000\nbuy when rsi(3) < 40\nsell when position return > 6% or position return < -4%',
    'universe: A\ncapital: 10000\nbuy when close > sma(20)\nshort when close < sma(20) and rsi(3) > 40\nsell when close < highest since entry * 0.95\ncover when close > lowest since entry * 1.05',
  ];
  sources.forEach((src, k) => {
    const spec = parse(src);
    for (let cut = 620; cut <= 900; cut += 9) verify(spec, new Map([['A', head(full, cut)]]), `${src.split('\n').slice(2).join(' / ')}, ${cut}`, seen);
  });
  assert.ok(seen.sell >= 10 && seen.cover >= 1, JSON.stringify(seen));
});
