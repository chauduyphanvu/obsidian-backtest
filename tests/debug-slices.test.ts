import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { CSV_ASK_BYTES, CSV_MAX_BYTES, csvAsk, csvSize, csvSteps, debugCsv, debugRange, debugRows, debugWorkedOut, forgetDebug, holdDebug, inSlices, prepareRows, type Progress } from '../src/debug.ts';
import { parseSpec } from '../src/dsl.ts';
import { makeRng } from '../src/rng.ts';
import type { Bars } from '../src/types.ts';
import { bars } from './helpers.ts';

function series(n: number, seed = 3): Bars {
  const rng = makeRng(seed);
  let c = 100;
  return bars(Array.from({ length: n }, () => (c *= 1 + (rng.next() - 0.495) * 0.03)));
}

function run(src: string, data: Record<string, Bars>): Backtest {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  return runBacktest(spec!, new Map(Object.entries(data)));
}

const RULES =
  'universe: A\ncapital: 10000\nentries: 3\ncommission: 1\nstop loss: 2 atr(14)\nrisk per trade: 1% at 2 atr(14)\nbuy when close > sma(20) and rsi(14) < 70 and zscore(30) > -2\nadd when close > last entry price * 1.02\nsell when close < sma(20) * 0.97 or bars held >= 40';

const all = (b: Backtest, asset = 'A') => debugRows(b, asset, 0, debugRange(b, asset).count);

/** A clock that moves only when a step costs something, and a wait that counts. */
function clock() {
  let t = 0;
  const waits: number[] = [];
  return { now: () => t, spend: (ms: number) => (t += ms), wait: async () => void waits.push(t), waits };
}

function* job(costs: number[], c: ReturnType<typeof clock>): Generator<Progress, string> {
  for (let i = 0; i < costs.length; i++) {
    c.spend(costs[i]);
    yield { done: i + 1, total: costs.length };
  }
  return 'done';
}

test('a job in steps runs a stretch at a time, lets other work in between, and says how far it has got', async () => {
  const c = clock();
  const seen: Progress[] = [];
  // Ten steps of 5 ms with a budget of 12: a stretch ends at the first step that takes it past 12, that is after 3 steps.
  const result = await inSlices(job(Array(10).fill(5), c), { budgetMs: 12, wait: c.wait, now: c.now, onSlice: (p) => seen.push(p) });
  assert.equal(result, 'done');
  assert.deepEqual(seen.map((p) => p.done), [3, 6, 9]);
  assert.equal(c.waits.length, 3);
  // No stretch ran longer than the budget plus the step that crossed it.
  assert.deepEqual(c.waits.map((t, i) => t - (c.waits[i - 1] ?? 0)), [15, 15, 15]);
});

test('a job that fits in one stretch is done without any wait, and an empty one too', async () => {
  const c = clock();
  assert.equal(await inSlices(job([1, 1, 1], c), { budgetMs: 12, wait: c.wait, now: c.now }), 'done');
  assert.equal(await inSlices(job([], c), { budgetMs: 12, wait: c.wait, now: c.now }), 'done');
  assert.equal(c.waits.length, 0);
});

test('a job is stopped between stretches, and a step is never cut in two', async () => {
  const c = clock();
  let ran = 0;
  const steps = (function* (): Generator<Progress, string> {
    for (let i = 0; i < 100; i++) {
      c.spend(30);
      ran++;
      yield { done: i + 1, total: 100 };
    }
    return 'done';
  })();
  let slices = 0;
  assert.equal(await inSlices(steps, { budgetMs: 12, wait: c.wait, now: c.now, stop: () => ++slices >= 3 }), null);
  assert.equal(ran, 3);
});

test('preparing the rows changes nothing about them, and goes in many steps with a count that ends at its total', () => {
  const data = { A: series(900) };
  const plain = all(run(RULES, data));
  const bt = run(RULES, data);
  const progress = [...(function* () {
    const steps = prepareRows(bt, 'A');
    for (let n = steps.next(); !n.done; n = steps.next()) yield n.value;
  })()];
  assert.ok(progress.length >= 10, `${progress.length} steps`);
  assert.deepEqual(progress.map((p) => p.done), progress.map((_, i) => i + 1));
  assert.ok(progress.every((p) => p.total === progress.length));
  assert.deepEqual(all(bt), plain);
  // Letting go of what was worked out changes nothing either.
  forgetDebug(bt);
  assert.deepEqual(all(bt), plain);
});

test('a ranked run prepares every ticker the ranking reads, and the other ticker\'s part of an `of`', () => {
  const data = { A: series(500, 1), B: series(500, 2), C: series(500, 3) };
  const bt = run('universe: A, B, C\ncapital: 10000\nrebalance: monthly\nhold: top 2 by roc(20)\nbuy when close > sma(30) and close of B > sma(10) of B', data);
  const parts = [...(function* () {
    const steps = prepareRows(bt, 'A');
    for (let n = steps.next(); !n.done; n = steps.next()) yield n.value;
  })()];
  // Three tickers each with its own rule and score: far more parts than one ticker has.
  const one = [...(function* () {
    const steps = prepareRows(run('universe: A\ncapital: 10000\nbuy when close > sma(30) and close of B > sma(10) of B', { A: data.A, B: data.B }), 'A');
    for (let n = steps.next(); !n.done; n = steps.next()) yield n.value;
  })()];
  assert.ok(parts.length > 2 * one.length);
  assert.deepEqual(all(bt, 'B'), all(run('universe: A, B, C\ncapital: 10000\nrebalance: monthly\nhold: top 2 by roc(20)\nbuy when close > sma(30) and close of B > sma(10) of B', data), 'B'));
});

test('the file is made in steps of a few hundred bars, and is the same file as the one made at once', () => {
  const bt = run(RULES, { A: series(1234) });
  const steps = csvSteps(bt, 'A');
  const progress: Progress[] = [];
  let text = '';
  for (let n = steps.next(); ; n = steps.next()) {
    if (n.done) {
      text = n.value;
      break;
    }
    progress.push(n.value);
  }
  assert.deepEqual(progress.map((p) => p.done), [500, 1000, 1234]);
  assert.ok(progress.every((p) => p.total === 1234));
  assert.equal(text, debugCsv(bt, 'A'));
  assert.equal(text.trimEnd().split('\n').length, 1234 + 1);
});

const prepare = (bt: Backtest) => {
  for (const steps = prepareRows(bt, 'A'); !steps.next().done; );
};

test('two views of one result share what was worked out; it is let go when the last of them closes', () => {
  const bt = run(RULES, { A: series(400) });
  const first = holdDebug(bt);
  const second = holdDebug(bt);
  assert.equal(debugWorkedOut(bt), false);
  prepare(bt);
  assert.equal(debugWorkedOut(bt), true);
  first();
  // The other view still has its rows worked out.
  assert.equal(debugWorkedOut(bt), true);
  // Closing a view twice does not count for another.
  first();
  assert.equal(debugWorkedOut(bt), true);
  second();
  assert.equal(debugWorkedOut(bt), false);
  // A view opened later starts again, and gives the same rows.
  const plain = all(run(RULES, { A: series(400) }));
  const third = holdDebug(bt);
  assert.deepEqual(all(bt), plain);
  third();
  assert.equal(debugWorkedOut(bt), false);
});

test('results held apart do not affect each other', () => {
  const a = run(RULES, { A: series(300, 1) });
  const b = run(RULES, { A: series(300, 2) });
  const [releaseA, releaseB] = [holdDebug(a), holdDebug(b)];
  prepare(a);
  prepare(b);
  releaseA();
  assert.deepEqual([debugWorkedOut(a), debugWorkedOut(b)], [false, true]);
  releaseB();
});

const lines = (csv: string) => csv.trimEnd().split('\n');

test('a file of only some bars has the same header and the same rows as those bars have in the whole file', () => {
  const bt = run(RULES, { A: series(1234) });
  const whole = lines(debugCsv(bt, 'A'));
  const part = (from: number, to: number) => {
    const steps = csvSteps(bt, 'A', { from, to });
    const progress: Progress[] = [];
    for (let n = steps.next(); ; n = steps.next()) {
      if (n.done) return { text: lines(n.value), progress };
      progress.push(n.value);
    }
  };
  const window = part(1100, 1160);
  assert.deepEqual(window.text, [whole[0], ...whole.slice(1 + 1100, 1 + 1160)]);
  assert.deepEqual(window.progress, [{ done: 60, total: 60 }]);
  // A range over several steps counts its own bars, and one past the end stops at the last bar.
  const wide = part(100, 1300);
  assert.deepEqual(wide.text, [whole[0], ...whole.slice(1 + 100)]);
  assert.deepEqual(wide.progress.map((p) => [p.done, p.total]), [[500, 1134], [1000, 1134], [1134, 1134]]);
  assert.deepEqual(part(0, 0).text, [whole[0]]);
});

test('the size of the file is worked out before it is made: exactly for a short run, closely for a long one', () => {
  const short = run(RULES, { A: series(150) });
  assert.deepEqual(csvSize(short, 'A'), { bars: 150, bytes: debugCsv(short, 'A').length });
  const long = run(RULES, { A: series(3000, 5) });
  const size = csvSize(long, 'A');
  const actual = debugCsv(long, 'A').length;
  assert.equal(size.bars, 3000);
  assert.ok(Math.abs(size.bytes - actual) / actual < 0.1, `${size.bytes} against ${actual}`);
  assert.deepEqual(csvSize(run('universe: A\nbuy when close > sma(5)', { A: series(10) }), 'A').bars, 10);
});

test('a file that would pass about 20 MB is asked about, in the section, with its size; one too large to make whole offers only the bars shown', () => {
  assert.equal(csvAsk({ bars: 1000, bytes: CSV_ASK_BYTES }, 60), null);
  assert.equal(csvAsk({ bars: 0, bytes: 0 }, 0), null);
  const big = csvAsk({ bars: 300_000, bytes: 125_000_000 }, 60)!;
  assert.deepEqual(big, {
    text: 'The file with all bars is approximately 125 MB (300,000 bars). Save all bars, or only the 60 bars shown?',
    all: true,
  });
  assert.equal(csvAsk({ bars: 40_000, bytes: CSV_ASK_BYTES + 1 }, 1)!.text, 'The file with all bars is approximately 20 MB (40,000 bars). Save all bars, or only the 1 bar shown?');
  const huge = csvAsk({ bars: 1_000_000, bytes: CSV_MAX_BYTES + 1 }, 60)!;
  assert.deepEqual(huge, { text: 'The file with all bars is approximately 400 MB (1,000,000 bars). This is too large to save as one file. Save only the 60 bars shown?', all: false });
});
