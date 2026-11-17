import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { csvSteps, debugCsv, debugRange, debugRows, forgetDebug, inSlices, prepareRows, type Progress } from '../src/debug.ts';
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
