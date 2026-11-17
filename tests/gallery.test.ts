import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { extractBlocks } from '../src/blocks.ts';
import { parseSpec } from '../src/dsl.ts';
import { blockOf, EMPTY, STARTERS, type Starter } from '../src/gallery.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY } from './helpers.ts';

const MAX_LINES = 14;
const MIN_LINES = 6;

/** A daily price walk with slow swings between rising and falling stretches, the same every run. */
function synthetic(name: string, n = 9500): Bars {
  let seed = [...name].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const closes: number[] = [];
  const opens: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price * (1 + 0.004 * (next() - 0.5));
    price *= Math.exp(0.0003 + 0.0015 * Math.sin(i / 170) + 0.024 * (next() - 0.5));
    opens.push(open);
    closes.push(price);
    highs.push(Math.max(open, price) * (1 + 0.006 * next()));
    lows.push(Math.min(open, price) * (1 - 0.006 * next()));
  }
  return bars(closes, { opens, highs, lows, start: Date.UTC(1998, 0, 1) });
}

function run(s: Starter) {
  const { spec, errors } = parseSpec(s.text);
  assert.deepEqual(errors, [], s.title);
  const refs = [...spec!.universe, ...spec!.extras, ...(spec!.benchmark ? [spec!.benchmark] : [])];
  return runBacktest(spec!, new Map(refs.map((r) => [r.name, synthetic(r.name)])));
}

test('there are about eight starters with their own titles and plain descriptions', () => {
  assert.ok(STARTERS.length >= 8 && STARTERS.length <= 10);
  assert.equal(new Set(STARTERS.map((s) => s.title.toLowerCase())).size, STARTERS.length);
  for (const s of STARTERS) {
    assert.ok(s.title.length > 0 && s.title.length <= 40, s.title);
    assert.ok(s.description.length >= 60 && s.description.length <= 420, `${s.title}: ${s.description.length} characters`);
    assert.doesNotMatch(s.description + s.title, /!|[^\x20-\x7e]/, `${s.title}: no exclamation marks or special characters`);
    assert.match(s.description, /struggle/, `${s.title} says when it tends to struggle`);
    assert.doesNotMatch(s.description, /\b(profit|profits|outperform\w*|beat|beats|guarantee\w*|always wins?)\b/i, `${s.title} makes no performance promise`);
  }
});

test('every starter parses with no errors and no warnings, and declares its title as its name', () => {
  for (const s of STARTERS) {
    const { spec, errors, warnings } = parseSpec(s.text);
    assert.deepEqual(errors, [], s.title);
    assert.deepEqual(warnings, [], s.title);
    assert.equal(spec!.name, s.title);
  }
});

test('every starter stays short and uses no tabs or trailing spaces', () => {
  for (const s of STARTERS) {
    const lines = s.text.split('\n');
    assert.ok(lines.length >= MIN_LINES && lines.length <= MAX_LINES, `${s.title} has ${lines.length} lines`);
    assert.equal(s.text, s.text.trim(), s.title);
    assert.ok(lines.every((l) => l === l.trimEnd() && !l.includes('\t')), s.title);
  }
});

test('every starter runs on synthetic prices and makes trades', () => {
  for (const s of STARTERS) {
    const bt = run(s);
    assert.ok(bt.run.equity.length > 500, `${s.title} ran for ${bt.run.equity.length} bars`);
    assert.ok(bt.run.equity.every(Number.isFinite), `${s.title} has equity that is not a number`);
    assert.ok(bt.run.trades.length > 0, `${s.title} made no trades`);
  }
});

test('nothing in a starter suggests shorting or leverage', () => {
  const words = /\b(short|shorts|shorting|shorted|leverage|leveraged|margin|options?|puts?|calls?|borrow\w*|inverse (etf|fund)s?|2x|3x)\b/i;
  const leveraged = /\b(TQQQ|SQQQ|UPRO|SPXU|SPXS|SDS|SSO|QLD|QID|SH|PSQ|UVXY|SVXY|TMF|TMV|TNA|TZA|SOXL|SOXS)\b/;
  for (const s of [...STARTERS, EMPTY]) {
    const all = `${s.title}\n${s.description}\n${s.text}`;
    assert.doesNotMatch(all, words, s.title);
    assert.doesNotMatch(all, leveraged, s.title);
    const { spec } = parseSpec(s.text);
    const held = spec!.rank ? spec!.universe.slice(0, spec!.rank.top) : spec!.universe;
    assert.ok(held.reduce((sum, a) => sum + a.weight, 0) <= 1 + 1e-9, s.title);
  }
});

test('together the starters show the main parts of the language', () => {
  const specs = STARTERS.map((s) => parseSpec(s.text).spec!);
  const any = (pick: (s: (typeof specs)[number]) => boolean) => specs.some(pick);
  assert.ok(any((s) => s.params.filter((p) => p.range).length >= 2 && s.testFrom !== null), 'two ranged parameters and a test date');
  assert.ok(any((s) => s.universe.some((a) => a.source === 'binance')), 'a Binance ticker');
  assert.ok(any((s) => Object.values(s.stops).some((st) => st.trailingStop?.k === 'atr')), 'an ATR trailing stop');
  assert.ok(any((s) => Object.values(s.stops).some((st) => st.stopLoss?.k === 'pct')), 'a percentage stop');
  assert.ok(any((s) => s.rank !== null && s.rebalance === 'monthly'), 'monthly ranking');
  assert.ok(any((s) => s.rebalance === 'quarterly' && s.benchmark !== null && s.universe.every((a) => a.weight < 1)), 'weights, quarterly, a benchmark');
  assert.ok(any((s) => s.sizing.k === 'invvol'), 'inverse volatility');
  const text = STARTERS.map((s) => s.text).join('\n');
  assert.match(text, /^for \w+:$/m);
  assert.match(text, /bars held/);
  assert.match(text, /\brsi\(/);
  assert.match(text, /\bmonth\b/);
});

test('a starter becomes a fenced block that the editor finds again', () => {
  for (const s of [...STARTERS, EMPTY]) {
    const block = blockOf(s);
    assert.ok(block.startsWith('```strategy\n') && block.endsWith('\n```\n'), s.title);
    const found = extractBlocks(`Some text\n\n${block}\nMore text\n`);
    assert.equal(found.length, 1);
    assert.equal(found[0].source, s.text);
  }
});

test('the empty block is a valid skeleton to build on', () => {
  const { spec, errors, warnings } = parseSpec(EMPTY.text);
  assert.deepEqual([errors, warnings], [[], []]);
  assert.equal(spec!.universe.length, 1);
  assert.ok(EMPTY.text.split('\n').length <= MAX_LINES);
  assert.equal(EMPTY.title, 'Empty block');
});

test('the synthetic prices cover each starter from its first day', () => {
  const first = Date.UTC(1998, 0, 1);
  for (const s of STARTERS) {
    const { spec } = parseSpec(s.text);
    assert.ok(spec!.from === null || spec!.from - 700 * DAY > first, s.title);
  }
});
