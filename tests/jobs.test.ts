import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec, type Defaults } from '../src/dsl.ts';
import { benchFor, runJob, serve, stoppedResult, type Bench, type FromWorker, type Job, type Progress, type ToWorker } from '../src/jobs.ts';
import { blockFor, bootstrap, randomEntries, walkForward } from '../src/luck.ts';
import { makeRng } from '../src/rng.ts';
import { runSweep, type Parse } from '../src/sweep.ts';
import type { Bars } from '../src/types.ts';
import { bars } from './helpers.ts';

const DEFAULTS: Partial<Defaults> = { capital: 25_000, costBps: 5, slippageBps: 2, cashRate: '2%' };

function prices(names: string[], n: number, seed: number): Map<string, Bars> {
  const rng = makeRng(seed);
  return new Map(
    names.map((name) => {
      let c = 100;
      return [name, bars(Array.from({ length: n }, () => (c *= 1 + (rng.next() - 0.49) * 0.03)))];
    }),
  );
}

const TIMING = 'universe: A 50%, B 50%\nstop loss: stop\nfast = 10 in 5..15 step 5\nstop = 8% in 6%..10% step 2%\nbuy when close > sma(fast)\nsell when close < sma(fast)';
const RANKING = 'universe: A, B, C, D\nrebalance: monthly\nhold: top 2 by roc(n)\nn = 20 in 10..30 step 10\nbuy when close > sma(50)';

/** The block as the note runs it today: the main thread's parser with the plugin's defaults. */
function today(source: string, data: Map<string, Bars>) {
  const parse: Parse = (overrides) => parseSpec(source, { defaults: DEFAULTS, overrides });
  return { parse, bt: runBacktest(parse({}).spec!, data) };
}

/** Sends one job through the worker's message handler, every message copied as postMessage would; returns all it sent. */
async function viaWorker(source: string, data: Map<string, Bars>, job: Job): Promise<FromWorker[]> {
  const out: FromWorker[] = [];
  const handle = serve((m) => out.push(structuredClone(m)), 0);
  const send = (m: ToWorker) => handle(structuredClone(m));
  await send({ type: 'data', id: 1, data });
  await send({ type: 'job', id: 7, data: 1, block: { source, defaults: DEFAULTS }, job });
  return out;
}

const resultOf = (out: FromWorker[]) => {
  const last = out[out.length - 1];
  assert.equal(last.type, 'done', JSON.stringify(last));
  return (last as { result: unknown }).result;
};

/** Every field is a number, string, boolean or null, inside plain objects and arrays: nothing a worker could not send whole. */
function assertPlain(v: unknown, path = 'result'): void {
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return;
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertPlain(x, `${path}[${i}]`));
    return;
  }
  assert.ok(typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype, `${path} is ${typeof v === 'object' ? Object.getPrototypeOf(v)?.constructor?.name : typeof v}`);
  for (const [k, x] of Object.entries(v as object)) assertPlain(x, `${path}.${k}`);
}

test('a sweep in the worker gives exactly what runSweep gives on the main thread, as plain data', async () => {
  const data = prices(['A', 'B'], 900, 1);
  const { parse } = today(TIMING, data);
  const expected = await runSweep(TIMING, data, { parse });
  assert.equal(expected.points.length, 9);
  const got = resultOf(await viaWorker(TIMING, data, { kind: 'sweep' }));
  assert.deepStrictEqual(got, expected);
  assertPlain(got);
});

test('the luck checks in the worker give exactly what they give on the main thread, as plain data', async () => {
  const data = prices(['A', 'B'], 900, 2);
  const { parse, bt } = today(TIMING, data);
  assert.ok(bt.run.trades.length > 10);
  const reshuffle = resultOf(await viaWorker(TIMING, data, { kind: 'reshuffle', seed: 3, runs: 200 }));
  assert.deepStrictEqual(reshuffle, bootstrap(bt.run.t, bt.run.equity, { seed: 3, runs: 200, blockBars: blockFor(bt) }));
  assertPlain(reshuffle);
  const random = resultOf(await viaWorker(TIMING, data, { kind: 'random', seed: 3, runs: 40 }));
  assert.deepStrictEqual(random, await randomEntries(bt, { seed: 3, runs: 40 }));
  assertPlain(random);
  const walk = resultOf(await viaWorker(TIMING, data, { kind: 'walk' }));
  assert.ok(walk !== null);
  assert.deepStrictEqual(walk, await walkForward(TIMING, data, { parse }));
  assertPlain(walk);
});

test('random picks for a ranking in the worker give exactly what they give on the main thread', async () => {
  const data = prices(['A', 'B', 'C', 'D'], 700, 4);
  const { bt } = today(RANKING, data);
  const random = resultOf(await viaWorker(RANKING, data, { kind: 'random', seed: 5, runs: 30 }));
  const expected = await randomEntries(bt, { seed: 5, runs: 30 });
  assert.equal(expected.mode, 'picks');
  assert.deepStrictEqual(random, expected);
  assertPlain(random);
});

test('a job that fails in the worker sends its message, as the main thread would throw it', async () => {
  const data = prices(['A'], 200, 1);
  const out = await viaWorker('universe: A\nn = 5\nbuy when close > sma(n)', data, { kind: 'walk' });
  assert.deepEqual(out, [{ type: 'error', id: 7, message: 'Walk-forward needs a parameter with a range to choose from, such as fast = 50 in 20..100 step 10.' }]);
});

test('the worker sends progress no more often than asked, with the sweep variants finished since the last message', async () => {
  const data = prices(['A', 'B'], 400, 1);
  const out: FromWorker[] = [];
  const handle = serve((m) => out.push(structuredClone(m)), 60_000);
  await handle({ type: 'data', id: 1, data });
  await handle({ type: 'job', id: 1, data: 1, block: { source: TIMING, defaults: DEFAULTS }, job: { kind: 'sweep' } });
  // Only the first step's progress goes out within a minute; the finished result follows.
  assert.deepEqual(
    out.map((m) => [m.type, (m as Progress).points?.length]),
    [
      ['progress', 1],
      ['done', undefined],
    ],
  );
});

test('the worker keeps a block\'s prices for its later jobs', async () => {
  const data = prices(['A', 'B'], 400, 1);
  const out: FromWorker[] = [];
  const handle = serve((m) => out.push(m), 0);
  const job = (id: number, job: Job): ToWorker => ({ type: 'job', id, data: 1, block: { source: TIMING, defaults: DEFAULTS }, job });
  await handle({ type: 'data', id: 1, data });
  await handle(job(1, { kind: 'reshuffle', seed: 1, runs: 10 }));
  await handle(job(2, { kind: 'random', seed: 1, runs: 5 }));
  await handle(job(3, { kind: 'reshuffle', seed: 1, runs: 10 }));
  const done = out.filter((m) => m.type === 'done') as { id: number; result: unknown }[];
  assert.deepEqual(done.map((m) => m.id), [1, 2, 3]);
  assert.deepStrictEqual(done[2].result, done[0].result);
});

test('a sweep ended from outside keeps the variants it had sent: the same as a sweep that stops itself there', async () => {
  const data = prices(['A', 'B'], 600, 3);
  const { parse, bt } = today(TIMING, data);
  const bench: Bench = { source: TIMING, parse, data, backtest: () => bt };
  const out = await viaWorker(TIMING, data, { kind: 'sweep' });
  for (const k of [0, 1, 4, 8]) {
    let done = 0;
    const itself = await runSweep(TIMING, data, { parse, onProgress: (d) => (done = d), shouldStop: () => done >= k });
    const sent = out.slice(0, k).flatMap((m) => (m as Progress).points ?? []);
    assert.deepStrictEqual(stoppedResult('sweep', bench, { points: sent, random: null }), itself);
  }
});

test('random entries ended from outside keep the tries they had sent: the same as when they stop themselves there', async () => {
  const data = prices(['A', 'B'], 600, 3);
  const { bt } = today(TIMING, data);
  const bench: Bench = { source: TIMING, parse: today(TIMING, data).parse, data, backtest: () => bt };
  const out = await viaWorker(TIMING, data, { kind: 'random', seed: 2, runs: 30 });
  for (const k of [1, 9, 29]) {
    let done = 0;
    const itself = await randomEntries(bt, { seed: 2, runs: 30, onProgress: (d) => (done = d), shouldStop: () => done >= k });
    assert.deepStrictEqual(stoppedResult('random', bench, { points: [], random: (out[k - 1] as Progress).random! }), itself);
  }
  // Nothing sent yet, and the checks that have nothing to show when stopped.
  assert.equal(stoppedResult('random', bench, { points: [], random: null }), null);
  assert.equal(stoppedResult('walk', bench, { points: [], random: null }), null);
  assert.equal(stoppedResult('reshuffle', bench, { points: [], random: null }), null);
});

test('a bench built from the text runs the block as written once, the same as the note does', () => {
  const data = prices(['A', 'B'], 300, 1);
  const bench = benchFor({ source: TIMING, defaults: DEFAULTS }, data);
  assert.equal(bench.backtest(), bench.backtest());
  assert.deepStrictEqual(bench.backtest().stats, today(TIMING, data).bt.stats);
  assert.equal(bench.backtest().spec.capital, 25_000);
});

test('runJob on the main thread is the same as the functions it calls, and stops when asked', async () => {
  const data = prices(['A', 'B'], 500, 6);
  const { parse, bt } = today(TIMING, data);
  const bench: Bench = { source: TIMING, parse, data, backtest: () => bt };
  assert.deepStrictEqual(await runJob({ kind: 'sweep' }, bench), await runSweep(TIMING, data, { parse }));
  let done = 0;
  const stopped = await runJob({ kind: 'sweep' }, bench, { onProgress: (d) => (done = d), shouldStop: () => done >= 2 });
  assert.deepEqual([stopped.tried, stopped.stopped], [2, true]);
});
