import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec, walk } from '../src/dsl.ts';
import { LIMITS, LimitError, WeighedCache, amount, anywayLabel, duration, resultBytes, runSize, sizeRefusal, timeMessage, type RunSize } from '../src/limits.ts';
import type { Bars } from '../src/types.ts';
import { bars } from './helpers.ts';

const closes = (n: number) => bars(Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 9) * 10 + i * 0.01));
const prices = (lengths: Record<string, number>) => new Map<string, Bars>(Object.entries(lengths).map(([name, n]) => [name, closes(n)]));
const spec = (source: string) => {
  const { spec, errors } = parseSpec(source);
  assert.deepEqual(errors, [], source);
  return spec!;
};
const size = (over: Partial<RunSize>): RunSize => ({ bars: 1000, tickers: 1, ruleWork: 0, windowWork: 0, ...over });

test('a run is measured by the bars it loads, and by its rule parts and function periods on each ticker\'s bars', () => {
  const s = spec('universe: A, B\nbenchmark: C\nbuy when close > sma(20)\nsell when close < sma(20)');
  const data = prices({ A: 300, B: 200, C: 500 });
  let parts = 0;
  walk(s.rules.A.buy, () => parts++);
  walk(s.rules.A.sell!, () => parts++);
  assert.equal(parts, 8);
  // The benchmark's bars are loaded, so they count; its rules are none, so they add nothing else.
  assert.deepEqual(runSize(s, data), { bars: 1000, tickers: 3, ruleWork: 8 * 300 + 8 * 200, windowWork: 40 * 300 + 40 * 200 });
});

test('the ranking score, per-ticker rules and readings of other tickers all count, each on its own ticker\'s bars', () => {
  const s = spec('universe: A, B, C\nhold: top 1 by roc(50)\nbuy when close > sma(10) of C\nfor C:\nbuy when highest(30) > close');
  const data = prices({ A: 100, B: 100, C: 400 });
  // A and B: close > sma(10) of C is 5 parts (cmp, series, of, ind, series), roc(50) 2 parts; C: highest(30) > close is 4 parts.
  assert.deepEqual(runSize(s, data), { bars: 600, tickers: 3, ruleWork: 7 * 100 + 7 * 100 + 6 * 400, windowWork: 60 * 100 + 60 * 100 + 80 * 400 });
});

test('the add rule counts like the buy and sell rules', () => {
  const big = Array.from({ length: 30 }, (_, k) => `sma(${k * 300 + 2}) > 0`).join(' and ');
  const data = prices({ A: 30_000 });
  const asSell = runSize(spec(`universe: A\nentries: 2\nbuy when true\nadd when true\nsell when ${big}`), data);
  const asAdd = runSize(spec(`universe: A\nentries: 2\nbuy when true\nsell when true\nadd when ${big}`), data);
  assert.deepEqual(asAdd, asSell);
  assert.ok(asAdd.windowWork > 3e9);
  assert.match(sizeRefusal(asAdd, 'here')!, /^Backtests run in the foreground here/);
});

test('a run whose bars are mostly the smaller bars of magnify is told that a longer magnify size makes it smaller', () => {
  const s = spec('universe: A\nmagnify: 1h\nstop loss: 2%\nbuy when true');
  const hours = closes(1_200_000);
  const size = runSize(s, new Map([['A', closes(50_000)], ['A/1h', hours]]));
  assert.deepEqual(size, { bars: 1_250_000, tickers: 1, ruleWork: 50_000, windowWork: 0, inside: 1_200_000 });
  assert.equal(
    sizeRefusal(size, 'worker'),
    'This run has 1.3 million bars across 1 ticker; the limit is 1 million. Most of them are the smaller bars of "magnify", so a longer "magnify" size, a later "from" date or fewer tickers make it smaller.',
  );
  // When the smaller bars are the lesser part, the advice is as for any run.
  assert.match(sizeRefusal({ ...size, bars: 2_500_000 }, 'worker')!, /\. A later "from" date, a longer "interval" or fewer tickers make it smaller\.$/);
});

test('below every limit nothing is refused, in the worker or here', () => {
  const s = runSize(spec('universe: A\nbuy when close > sma(200)\nsell when close < sma(200)'), prices({ A: 5000 }));
  assert.equal(sizeRefusal(s, 'worker'), null);
  assert.equal(sizeRefusal(s, 'here'), null);
});

test('too many bars is refused with the numbers and what makes the run smaller', () => {
  assert.equal(
    sizeRefusal(size({ bars: 2_134_567, tickers: 40 }), 'worker'),
    'This run has 2.1 million bars across 40 tickers; the limit is 1 million. A later "from" date, a longer "interval" or fewer tickers make it smaller.',
  );
  assert.equal(sizeRefusal(size({ bars: LIMITS.worker.bars }), 'worker'), null);
  assert.match(sizeRefusal(size({ bars: LIMITS.worker.bars + 1 }), 'worker')!, /has 1,000,001 bars across 1 ticker; the limit is 1,000,000\./);
});

test('long rules on many bars are refused with the values they would work out', () => {
  assert.equal(
    sizeRefusal(size({ bars: 300_000, ruleWork: 36_000_000 }), 'worker'),
    'Its rules work out 36 million values, one for each part of a ticker\'s rules on each of its bars; the limit is 25 million. Shorter rules, a later "from" date, a longer "interval" or fewer tickers make it smaller.',
  );
});

test('long periods are refused only on the main thread, where a run cannot be stopped', () => {
  const heavy = size({ bars: 150_000, ruleWork: 600_000, windowWork: 1_500_000_000 });
  assert.equal(sizeRefusal(heavy, 'worker'), null);
  assert.equal(
    sizeRefusal(heavy, 'here'),
    'Backtests run in the foreground here, so Obsidian does not respond while one runs. Its functions read 1.5 billion prices, the period of each function on each bar; the limit here is 200 million. Shorter periods, a later "from" date or a longer "interval" make it smaller.',
  );
});

test('on the main thread every limit is stricter, and says why', () => {
  for (const key of ['bars', 'ruleWork', 'windowWork'] as const) assert.ok(LIMITS.here[key] < LIMITS.worker[key], key);
  const refusal = sizeRefusal(size({ bars: 300_000 }), 'here')!;
  assert.equal(refusal, 'Backtests run in the foreground here, so Obsidian does not respond while one runs. This run has 300,000 bars across 1 ticker; the limit here is 200,000. A later "from" date, a longer "interval" or fewer tickers make it smaller.');
  assert.equal(sizeRefusal(size({ bars: 300_000 }), 'worker'), null);
});

test('amounts read as words above a million, never the same as the limit they are compared with', () => {
  assert.equal(amount(999_999), '999,999');
  assert.equal(amount(1_000_000), '1 million');
  assert.equal(amount(2_134_567), '2.1 million');
  assert.equal(amount(36_000_000), '36 million');
  assert.equal(amount(1_500_000_000), '1.5 billion');
  assert.equal(amount(1_040_000, 1_000_000), '1.04 million');
  assert.equal(amount(1_000_000, 1_040_000), '1 million');
  assert.equal(amount(1_000_400, 1_000_000), '1,000,400');
});

test('durations are whole seconds or minutes', () => {
  assert.equal(duration(1000), '1 second');
  assert.equal(duration(LIMITS.runMs), '10 seconds');
  assert.equal(duration(LIMITS.anywayMs), '2 minutes');
});

test('a stopped run says how long it ran, how large it is, and what makes it faster', () => {
  assert.equal(
    timeMessage(10_000, size({ bars: 900_000, tickers: 3 })),
    'This backtest was stopped after 10 seconds, the most one run may take. It has 900,000 bars across 3 tickers. A later "from" date, a longer "interval", fewer tickers or shorter periods make it faster.',
  );
  assert.equal(timeMessage(120_000, null), 'This was stopped after 2 minutes without finishing a backtest, the most one may take.');
});

test('a limit error says which limit, and whether it may be run anyway', () => {
  const e = new LimitError('time', 'stopped', true);
  assert.ok(e instanceof Error);
  assert.deepEqual([e.kind, e.anyway, e.message, e.name], ['time', true, 'stopped', 'LimitError']);
  assert.equal(anywayLabel(e), 'Run it anyway, for up to 2 minutes');
  assert.equal(anywayLabel(new LimitError('size', 'too large', true)), 'Run it anyway');
});

test('a result is weighed by its prices, steps, trades and fills', () => {
  const data = prices({ A: 2000, B: 2000 });
  const bt = runBacktest(spec('universe: A, B\nbuy when close > sma(10)\nsell when close < sma(10)'), data);
  assert.ok(bt.run.trades.length > 10);
  assert.equal(resultBytes({ data, backtest: bt }), 64 * 4000 + 100 * bt.run.t.length + 600 * bt.run.trades.length + 40 * bt.run.fills.t.length);
});

/** A cache of numbers that weigh what they are. */
function weighed(maxEntries: number, maxWeight: number, clock = { t: 0 }) {
  return new WeighedCache<number>({ maxEntries, maxAgeMs: 1000, weigh: (x) => x, maxWeight, now: () => clock.t });
}

test('a weighed cache drops the least recently used entries once their weight passes the limit', () => {
  const cache = weighed(10, 100);
  cache.set('a', 40);
  cache.set('b', 40);
  assert.equal(cache.get('a'), 40);
  cache.set('c', 40);
  // b was used least recently.
  assert.deepEqual(['a', 'b', 'c'].map((k) => cache.get(k)), [40, undefined, 40]);
  assert.equal(cache.weight, 80);
  cache.set('d', 500);
  assert.deepEqual(['a', 'c', 'd'].map((k) => cache.get(k)), [undefined, undefined, 500]);
  assert.equal(cache.weight, 500);
});

test('a weighed cache keeps its count limit and its weights in step', () => {
  const cache = weighed(3, 1000);
  for (const [i, k] of ['a', 'b', 'c', 'd', 'e'].entries()) cache.set(k, i + 1);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map((k) => cache.get(k)), [undefined, undefined, 3, 4, 5]);
  assert.equal(cache.weight, 12);
  cache.set('c', 10);
  assert.equal(cache.weight, 19);
  cache.delete('d');
  assert.equal(cache.weight, 15);
  cache.clear();
  assert.equal(cache.weight, 0);
  assert.equal(cache.get('e'), undefined);
});

test('an expired entry stops counting once it is read', () => {
  const clock = { t: 0 };
  const cache = weighed(10, 100, clock);
  cache.set('a', 60);
  clock.t = 1000;
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.weight, 0);
  cache.set('b', 60);
  assert.equal(cache.get('b'), 60);
});
