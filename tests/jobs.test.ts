import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec, type Defaults } from '../src/dsl.ts';
import { explainTrade } from '../src/explain.ts';
import { benchFor, runBlock, runJob, serve, stoppedResult, withInputs, type Bench, type FromWorker, type Job, type Progress, type Ran, type ToWorker } from '../src/jobs.ts';
import { blockFor, bootstrap, randomEntries, walkForward } from '../src/luck.ts';
import { makeRng } from '../src/rng.ts';
import { runSweep, type Parse } from '../src/sweep.ts';
import { computeTriggers, triggerRun } from '../src/trigger.ts';
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
  await send({ type: 'job', id: 7, data: 1, block: { source, defaults: DEFAULTS, overrides: {} }, job });
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
  await handle({ type: 'job', id: 1, data: 1, block: { source: TIMING, defaults: DEFAULTS, overrides: {} }, job: { kind: 'sweep' } });
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
  const job = (id: number, job: Job): ToWorker => ({ type: 'job', id, data: 1, block: { source: TIMING, defaults: DEFAULTS, overrides: {} }, job });
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
  const bench = benchFor({ source: TIMING, defaults: DEFAULTS, overrides: {} }, data);
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

// ---------------------------------------------------------------- single runs

/** Strategies that between them touch every part of a result: stops, ranking, close fills, a later benchmark, the split, sizing, intraday bars, no trades. */
const VARIED: { name: string; source: string; data: () => Map<string, Bars> }[] = [
  { name: 'timing with a stop parameter', source: TIMING, data: () => prices(['A', 'B'], 900, 11) },
  { name: 'ranking', source: RANKING, data: () => prices(['A', 'B', 'C', 'D'], 900, 12) },
  {
    name: 'close fills, a split, ATR stops and a benchmark that starts later',
    source: 'universe: A\nbenchmark: E\nfill: close\ntest from: 2021-06-01\ntrailing stop: 3 atr(14)\ntake profit: 4 atr(10)\nbuy when close crosses above sma(20)\nsell when bars held >= 10',
    data: () => {
      const d = prices(['A', 'E'], 900, 13);
      const e = d.get('E')!;
      d.set('E', { t: e.t.slice(200), o: e.o.slice(200), h: e.h.slice(200), l: e.l.slice(200), c: e.c.slice(200), v: e.v.slice(200) });
      return d;
    },
  },
  {
    name: 'per-ticker rules, reading another ticker, risk sizing and interest',
    source:
      'universe: A 40%, B 40%\ncash rate: 3%\nrisk per trade: 1% at 2 atr(14)\nbuy when close > sma(30) and close of B > sma(30) of B\nsell when close < entry price * 0.95\nfor B:\nbuy when rsi(14) < 40\nsell when rsi(14) > 60',
    data: () => prices(['A', 'B'], 900, 14),
  },
  {
    name: 'inverse volatility, quarterly rebalancing and a cash-rate ticker',
    source: 'universe: A 30%, B 30%, C 30%\nweighting: inverse volatility(20)\nrebalance: quarterly\ncash rate: ^IRX\nbuy when close > ema(40)\nsell when close < ema(40)',
    data: () => {
      const d = prices(['A', 'B', 'C'], 900, 15);
      d.set('^IRX', bars(Array.from({ length: 900 }, (_, i) => 3 + Math.sin(i / 50))));
      return d;
    },
  },
  {
    name: 'hourly bars',
    source: 'universe: binance:A\ninterval: 1h\nstop loss: 2%\nbuy when close > sma(24) and weekday <= 5\nsell when close < sma(24)',
    data: () => {
      const d = prices(['A'], 2000, 16);
      const a = d.get('A')!;
      d.set('A', { ...a, t: a.t.map((_, i) => Date.UTC(2023, 0, 2) + i * 3_600_000) });
      return d;
    },
  },
  { name: 'a buy rule that never fires', source: 'universe: A\nbuy when close > 1000000', data: () => prices(['A'], 400, 17) },
];

/** Fails on any function, class instance (other than Map) or symbol anywhere in a result: nothing postMessage could lose. */
function assertCloneable(v: unknown, path = 'result'): void {
  assert.notEqual(typeof v, 'function', `${path} is a function`);
  assert.notEqual(typeof v, 'symbol', `${path} is a symbol`);
  if (v === null || typeof v !== 'object') return;
  if (v instanceof Map) {
    for (const [k, x] of v) assertCloneable(x, `${path}.get(${String(k)})`);
    return;
  }
  const proto = Object.getPrototypeOf(v);
  assert.ok(proto === Object.prototype || proto === Array.prototype, `${path} is a ${proto?.constructor?.name}`);
  for (const [k, x] of Object.entries(v)) assertCloneable(x, `${path}.${k}`);
}

/** JSON with Maps written out, so two results with the same keys in the same order give the same text. */
const text = (v: unknown) => JSON.stringify(v, (_, x) => (x instanceof Map ? [...x] : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x));

test('a single run in the worker, put back together with its strategy and prices, is exactly what runBacktest gives here', async () => {
  for (const { name, source, data: make } of VARIED) {
    const data = make();
    const parsed = parseSpec(source, { defaults: DEFAULTS });
    assert.deepEqual(parsed.errors, [], name);
    const spec = parsed.spec!;
    const expected = runBacktest(spec, data);
    for (const overrides of [{}, ...(spec.params.length ? [{ [spec.params[0].name]: spec.params[0].range?.lo ?? spec.params[0].value }] : [])]) {
      const direct = Object.keys(overrides).length ? runBacktest(parseSpec(source, { defaults: DEFAULTS, overrides }).spec!, data) : expected;
      const out: FromWorker[] = [];
      const handle = serve((m) => out.push(structuredClone(m)), 0);
      await handle(structuredClone({ type: 'data', id: 1, data } satisfies ToWorker));
      await handle(structuredClone({ type: 'run', id: 3, data: 1, block: { source, defaults: DEFAULTS, overrides } } satisfies ToWorker));
      assert.equal(out.length, 1, name);
      assert.equal(out[0].type, 'ran', `${name}: ${JSON.stringify(out[0])}`);
      const ran = (out[0] as { result: Ran }).result;
      assertCloneable(ran);
      assert.ok(!('spec' in ran) && !('data' in ran), `${name}: the strategy and prices are not sent back`);
      const back = withInputs(ran, direct.spec, data);
      assert.deepStrictEqual(back, direct, name);
      assert.equal(text(back), text(direct), `${name}: same keys in the same order`);
      assert.equal(back.data, data);
      // What the main thread does with a result: explain each trade from the same prices.
      for (const trade of back.run.trades.slice(0, 20)) assert.deepStrictEqual(explainTrade(back, trade), explainTrade(direct, direct.run.trades[back.run.trades.indexOf(trade)]), `${name}: explanation`);
    }
  }
});

/** Paths of own fields whose value is undefined. */
function undefinedFields(v: unknown, path = 'result', out: string[] = []): string[] {
  if (v === null || typeof v !== 'object') return out;
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) out.push(`${path}.${k}`);
    undefinedFields(x, `${path}.${k}`, out);
  }
  return out;
}

test('the copy keeps NaN and objects shared between trades; optional fields are left out rather than undefined, and a copy would keep them either way', () => {
  let nan = false;
  let shared = false;
  const decisions = (ran: Ran) => ran.run.trades.flatMap((t) => (t.why?.rank ? [t.why.rank.decision] : []));
  for (const { name, source, data: make } of VARIED) {
    const ran = runBlock({ source, defaults: DEFAULTS, overrides: {} }, make());
    const copy = structuredClone(ran);
    assert.deepStrictEqual(copy, ran, name);
    assert.deepEqual(undefinedFields(ran), [], name);
    nan ||= ran.benchmark.equity.some(Number.isNaN);
    // A ranking decision is one object shared by the trades it made, in the copy as in the original.
    const before = new Set(decisions(ran)).size;
    assert.equal(new Set(decisions(copy)).size, before, name);
    shared ||= before < decisions(ran).length;
  }
  assert.ok(nan, 'some result holds NaN');
  assert.ok(shared, 'some result shares a ranking decision between trades');
  assert.deepStrictEqual(structuredClone({ a: undefined, b: -0, c: NaN }), { a: undefined, b: -0, c: NaN });
});

test('a single run that fails in the worker sends the same message the main thread would throw', async () => {
  const data = prices(['A'], 200, 1);
  const out: FromWorker[] = [];
  const handle = serve((m) => out.push(m), 0);
  await handle({ type: 'data', id: 1, data });
  await handle({ type: 'run', id: 2, data: 1, block: { source: 'universe: A, B\nbuy when close > sma(5)', defaults: DEFAULTS, overrides: {} } });
  const { spec } = parseSpec('universe: A, B\nbuy when close > sma(5)', { defaults: DEFAULTS });
  assert.throws(() => runBacktest(spec!, data), (e: Error) => {
    assert.deepEqual(out, [{ type: 'error', id: 2, message: e.message }]);
    return true;
  });
});

test('a single run is not kept in the worker, and the luck checks there still find the prices', async () => {
  const data = prices(['A', 'B'], 400, 1);
  const out: FromWorker[] = [];
  const handle = serve((m) => out.push(m), 0);
  await handle({ type: 'data', id: 1, data });
  for (let fast = 5; fast <= 15; fast += 5) await handle({ type: 'run', id: fast, data: 1, block: { source: TIMING, defaults: DEFAULTS, overrides: { fast } } });
  await handle({ type: 'job', id: 20, data: 1, block: { source: TIMING, defaults: DEFAULTS, overrides: {} }, job: { kind: 'reshuffle', seed: 1, runs: 10 } });
  assert.deepEqual(out.map((m) => m.type), ['ran', 'ran', 'ran', 'done']);
});

test('trigger prices in the worker are exactly what they are here, as plain data, from the strategy and the end of its run', async () => {
  let priced = 0;
  for (const { name, source, data: make } of VARIED) {
    const data = make();
    const { spec } = parseSpec(source, { defaults: DEFAULTS });
    const bt = runBacktest(spec!, data);
    const expected = computeTriggers(spec!, data, triggerRun(bt.run));
    const out: FromWorker[] = [];
    const handle = serve((m) => out.push(structuredClone(m)), 0);
    await handle(structuredClone({ type: 'data', id: 1, data } satisfies ToWorker));
    await handle(structuredClone({ type: 'triggers', id: 4, data: 1, spec: spec!, run: triggerRun(bt.run) } satisfies ToWorker));
    assert.equal(out.length, 1, name);
    assert.equal(out[0].type, 'triggered', `${name}: ${JSON.stringify(out[0])}`);
    const got = (out[0] as { result: unknown }).result;
    assert.deepStrictEqual(got, expected, name);
    assertPlain(got);
    assert.deepEqual(undefinedFields(expected), [], name);
    priced += expected.triggers.filter((t) => t.fires.length > 0).length;
  }
  assert.ok(priced >= 3, `only ${priced} tickers had a price`);
});

test('trigger prices that fail in the worker send their message', async () => {
  const data = prices(['A'], 200, 1);
  const out: FromWorker[] = [];
  const handle = serve((m) => out.push(m), 0);
  await handle({ type: 'data', id: 1, data });
  const { spec } = parseSpec('universe: A\nbuy when close > sma(5)', { defaults: DEFAULTS });
  const run = triggerRun(runBacktest(spec!, data).run);
  await handle({ type: 'triggers', id: 2, data: 1, spec: { ...spec!, universe: [...spec!.universe, { name: 'B', source: 'yahoo', id: 'B', weight: 1 }] }, run });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'error');
});
