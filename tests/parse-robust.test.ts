import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec } from '../src/dsl.ts';
import { makeRng } from '../src/rng.ts';

/** parseSpec's answer, or the exception it threw. */
function attempt(src: string): ReturnType<typeof parseSpec> | Error {
  try {
    return parseSpec(src);
  } catch (e) {
    return e as Error;
  }
}

const FRAGMENTS = [
  'universe:', 'universe: SPY, TLT', 'buy when', 'sell when', 'for SPY:', 'for all:', 'hold: top', 'by', 'weighting:', 'risk per trade:',
  'stop loss:', 'trailing stop:', 'take profit:', 'cash rate:', 'benchmark:', 'from:', 'test from:', 'interval:', 'data:', 'rebalance:',
  'size:', 'capital:', 'costs:', 'slippage:', 'name:', 'x =', 'n = 5 in 1..9 step 2', 'in', 'step', '..', 'atr', 'atr(', 'inverse volatility(',
  'sma(', 'ema(', 'rsi', 'macd_signal(', 'bb_upper(', 'highest(', 'min(', 'max(', 'abs(', 'close', 'open', 'volume', 'month_start', 'bars held',
  'entry price', 'of', 'of SPY', 'of csv:a/b.csv', 'of binance:BTCUSDT', 'crosses', 'above', 'below', 'is', 'not', 'and', 'or', 'true', 'never',
  '(', ')', '[', ']', '[1]', ',', '+', '-', '*', '/', '>', '<', '>=', '==', '!=', '=', '%', '5', '0', '-3', '2.5', '.5', '1e9', '99999999999999999999',
  '2015-01-31', '2015-02-30', '#', '//', ':', '^IRX', 'csv:', 'yahoo:', '$10k', '1d', '1h', '1w', 'top 3 by roc(126)', '1% at 2 atr(14)',
  ' ', '  ', '\t', '\r', '\0', '\u0007', ' ', '﻿', 'é', '😀', '"', "'", '\\', '\n', '\n\n',
];

test('parseSpec never throws on random text made of the language and odd characters', () => {
  const rng = makeRng(7);
  for (let k = 0; k < 4000; k++) {
    const parts: string[] = [];
    const n = 1 + rng.int(30);
    for (let i = 0; i < n; i++) parts.push(FRAGMENTS[rng.int(FRAGMENTS.length)]);
    const src = parts.join(rng.int(3) === 0 ? '' : rng.int(2) ? ' ' : '\n');
    const out = attempt(src);
    assert.ok(!(out instanceof Error), `${JSON.stringify(src)} threw ${out instanceof Error ? out.message : ''}`);
  }
  for (let k = 0; k < 500; k++) {
    const src = Array.from({ length: rng.int(200) }, () => String.fromCharCode(rng.int(0x3000))).join('');
    const out = attempt(src);
    assert.ok(!(out instanceof Error), `${JSON.stringify(src)} threw ${out instanceof Error ? out.message : ''}`);
  }
});

const NEWER = [
  'universe: SPY, TLT', 'buy when', 'sell when', 'for SPY, TLT:', 'for SPY,:', 'for all, SPY:', 'up =', 'up = close > 1', 'down = not up', 'x = x + 1', 'n = 3', 'n = 3 in 2..9',
  'up', 'down', 'x', 'n', 'between', 'within', 'for', 'bars', 'bar', 'for 3 bars', 'within 2 bars', 'for n bars', 'count(', 'count(close > 1, 3)', 'close crosses', 'crosses',
  'highest since entry', 'lowest since entry', 'position return', 'highest_since_entry', 'position', 'since', 'highest since', 'and', 'or', 'not', '(', ')', ',', ':',
  'close', 'sma(5)', '> 1', '< 2', '== false', 'of SPY', '[1]', '\n', '\n', '  ', ' ',
];

test('parseSpec never throws on random text made of definitions, ranges, windows and lists', () => {
  const rng = makeRng(11);
  for (let k = 0; k < 4000; k++) {
    const parts: string[] = [];
    const n = 1 + rng.int(30);
    for (let i = 0; i < n; i++) parts.push(NEWER[rng.int(NEWER.length)]);
    const src = parts.join(rng.int(3) === 0 ? '' : rng.int(2) ? ' ' : '\n');
    const out = attempt(src);
    assert.ok(!(out instanceof Error), `${JSON.stringify(src)} threw ${out instanceof Error ? out.message : ''}`);
  }
});

test('long chains and loops of definitions are normal errors, and a long list of tickers is read', () => {
  const chain = (n: number, backwards: boolean) => {
    const lines = Array.from({ length: n }, (_, i) => `a${i} = ${i === 0 ? 'close > 1' : `a${i - 1} and close > 1`}`);
    return ['universe: SPY', ...(backwards ? lines.reverse() : lines), `buy when a${n - 1}`].join('\n');
  };
  for (const backwards of [false, true]) {
    const out = attempt(chain(3000, backwards));
    assert.ok(!(out instanceof Error), `a chain of 3000 definitions, ${backwards ? 'last first' : 'in order'}: ${out instanceof Error ? out.message : ''}`);
    assert.ok(out.errors.some((e) => /nests too deeply/.test(e.message)));
  }
  assert.deepEqual(attempt(chain(40, true)) instanceof Error ? ['threw'] : (attempt(chain(40, true)) as ReturnType<typeof parseSpec>).errors, []);
  const loop = attempt(['universe: SPY', ...Array.from({ length: 2000 }, (_, i) => `a${i} = a${(i + 1) % 2000} and close > 1`), 'buy when a0'].join('\n'));
  assert.ok(!(loop instanceof Error) && loop.errors.length > 0);
  const names = Array.from({ length: 50_000 }, (_, i) => `T${i}`);
  const out = attempt(`universe: ${names.join(', ')}\nbuy when true\nfor ${names.join(', ')}:\n  sell when close < 1`);
  assert.ok(!(out instanceof Error) && out.errors.length === 0);
});

const deep = (rule: string) => `universe: SPY\nbuy when ${rule}`;

test('parseSpec never throws on adversarial text, and nesting past 64 levels is a normal error', () => {
  const tooDeep = /nests too deeply/;
  const cases: [string, RegExp | null][] = [
    [deep('('.repeat(100_000) + 'close > 1' + ')'.repeat(100_000)), tooDeep],
    [deep('('.repeat(100_000)), tooDeep],
    [deep('not '.repeat(100_000) + 'true'), tooDeep],
    [deep('close > ' + '-'.repeat(100_000) + '1'), tooDeep],
    [deep('close > ' + '1 + '.repeat(100_000) + '1'), tooDeep],
    [deep('true' + ' and true'.repeat(100_000)), tooDeep],
    [deep('close' + '[1]'.repeat(100_000) + ' > 0'), tooDeep],
    [deep('close' + ' of SPY'.repeat(100_000) + ' > 0'), tooDeep],
    [deep('sma('.repeat(10_000) + 'close, 2' + ', 2)'.repeat(10_000) + ' > 0'), tooDeep],
    [deep('close > ' + 'x'.repeat(1_000_000)), /Unknown name/],
    ['universe: ' + 'SPY, '.repeat(100_000) + 'TLT\nbuy when true', /listed twice/],
    ['buy when close > 1\n'.repeat(50_000), null],
    [' '.repeat(1_000_000), null],
    ['\0\u0001\u0002\u001b[31m\r\n  ﻿', null],
  ];
  for (const [src, expected] of cases) {
    const out = attempt(src);
    assert.ok(!(out instanceof Error), `${JSON.stringify(src.slice(0, 60))} threw ${out instanceof Error ? out.message : ''}`);
    if (expected) assert.ok(out.errors.some((e) => expected.test(e.message)), `${JSON.stringify(src.slice(0, 60))}: ${JSON.stringify(out.errors.slice(0, 2))}`);
  }
  // 64 levels still parse.
  assert.deepEqual(parseSpec(deep('('.repeat(60) + 'close > 1' + ')'.repeat(60))).errors, []);
  assert.deepEqual(parseSpec(deep('true' + ' and true'.repeat(60))).errors, []);
});

test('every line the parser reads is read in linear time, even with long runs of spaces', () => {
  const pad = ' '.repeat(20_000);
  const lines = [
    `for${pad}x`, `for${pad}:x`, `for x${pad}`, `a${pad}x`, `stop${pad}loss${pad}x`, `name${pad}`, `x =${pad}5${pad}x`, `x = 5 in${pad}1${pad}..${pad}x`,
    `stop loss: 2 atr(${pad}x`, `stop loss: 2${pad}atr${pad}x`, `weighting: inverse volatility(${pad}x`, `risk per trade: 1%${pad}at${pad}2 atr(${pad}x`,
    `hold: top${pad}3${pad}by${pad}x`, `costs: 5${pad}x`, `cash rate: 5${pad}x`, `capital: 5${pad}x`, `universe: SPY${pad}5${pad}x`,
    `buy when close${pad}>${pad}5${pad}%${pad}x`, `buy${pad}when${pad}x`, `buy when close of${pad}x`, `x${pad}#${pad}y`, `#${pad}`, pad,
  ];
  for (const line of lines) {
    const started = performance.now();
    attempt(`universe: SPY\nbuy when true\n${line}`);
    const ms = performance.now() - started;
    assert.ok(ms < 100, `${JSON.stringify(line.replace(/ {2,}/g, (s) => `<${s.length} spaces>`))} took ${ms.toFixed(0)} ms`);
  }
});
