import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec, type Defaults } from '../src/dsl.ts';
import { runBlock, runJob, serve, type Bench, type FromWorker, type Ran, type ToWorker } from '../src/jobs.ts';
import { LIMITS, LimitError, runSize } from '../src/limits.ts';
import { Latest, drawHeld } from '../src/live-core.ts';
import { blockFor, bootstrap, randomEntries, walkForward, type BootstrapResult, type RandomEntriesResult, type WalkForwardResult } from '../src/luck.ts';
import { makeRng } from '../src/rng.ts';
import { runSweep, type Parse, type SweepResult } from '../src/sweep.ts';
import { computeTriggers, triggerRun } from '../src/trigger.ts';
import type { Bars } from '../src/types.ts';
import { createJobClient, type JobInput, type MakeWorker, type RunRequest, type RunResult, type TriggersRequest } from '../src/worker-client.ts';
import { bars, near } from './helpers.ts';

const DEFAULTS: Partial<Defaults> = { capital: 25_000, costBps: 5 };
const SRC = 'universe: A 50%, B 50%\nfast = 10 in 5..25 step 5\nslow = 40 in 30..50 step 10\nbuy when sma(fast) > sma(slow)\nsell when sma(fast) < sma(slow)';

function input(source = SRC, seed = 1, withDefaults = true): JobInput {
  const rng = makeRng(seed);
  const data = new Map<string, Bars>(
    ['A', 'B'].map((name) => {
      let c = 100;
      return [name, bars(Array.from({ length: 800 }, () => (c *= 1 + (rng.next() - 0.49) * 0.03)))];
    }),
  );
  const parse: Parse = (overrides) => parseSpec(source, { defaults: DEFAULTS, overrides });
  return { source, ...(withDefaults ? { defaults: DEFAULTS } : {}), parse, backtest: runBacktest(parse({}).spec!, data) };
}

/** A client that is shut down when the test ends, whatever happens. */
function track(t: TestContext, opts: Parameters<typeof createJobClient>[0]) {
  const client = createJobClient(opts);
  t.after(() => client.shutdown());
  return client;
}

/** A worker that cannot start: every job runs on the main thread. */
const noWorker: MakeWorker = () => {
  throw new Error('Workers are not allowed here');
};

const benchOf = (i: JobInput): Bench => ({ source: i.source, parse: i.parse, data: i.backtest.data, backtest: () => i.backtest });

/**
 * A worker in this process: the real message handler, every message copied as postMessage copies it. Messages to it
 * arrive a turn later; its answers arrive at once, so a test can stop a job in the middle. Ending it silences it.
 */
function inProcess(opts: { ready?: boolean | ((made: number) => boolean); failFirstJob?: boolean } = {}) {
  const log: string[] = [];
  let made = 0;
  let jobs = 0;
  const make: MakeWorker = (on) => {
    made++;
    // `ready` as a function says, for the n-th worker made, whether it starts.
    const starts = typeof opts.ready === 'function' ? opts.ready(made) : opts.ready !== false;
    let alive = true;
    const handle = serve((m) => {
      if (alive) on.message(structuredClone(m));
    }, 0);
    // A worker that never gets ready never answers either.
    if (starts) setTimeout(() => alive && on.message({ type: 'ready' }));
    return {
      post: (m: ToWorker) => {
        log.push(m.type === 'job' ? `job ${m.job.kind}` : m.type === 'run' ? `run ${JSON.stringify(m.block.overrides)}` : `${m.type} ${m.id}`);
        const copy = structuredClone(m);
        setTimeout(() => {
          if (!alive || !starts) return;
          if (copy.type === 'job' && opts.failFirstJob && jobs++ === 0) on.error('Out of memory');
          else void handle(copy);
        });
      },
      terminate: () => {
        alive = false;
        log.push('end');
      },
    };
  };
  return { make, log, made: () => made };
}

test('no worker starts until the first job, and two sections of one block send its prices once', async (t) => {
  const w = inProcess();
  const client = track(t, { makeWorker: w.make });
  const block = input();
  const sweep = client.forBlock(block);
  const luck = client.forBlock(block);
  assert.equal(w.made(), 0);
  const a = await sweep.run({ kind: 'sweep' }).done;
  const b = await luck.run({ kind: 'reshuffle', seed: 1, runs: 50 }).done;
  const c = await luck.run({ kind: 'random', seed: 1, runs: 20 }).done;
  const d = await luck.run({ kind: 'walk' }).done;
  assert.equal(w.made(), 1);
  assert.deepEqual(w.log, ['data 1', 'job sweep', 'job reshuffle', 'job random', 'job walk']);
  // The same answers as running the jobs here.
  const here = benchOf(block);
  assert.deepStrictEqual(a, await runJob({ kind: 'sweep' }, here));
  assert.deepStrictEqual(b, await runJob({ kind: 'reshuffle', seed: 1, runs: 50 }, here));
  assert.deepStrictEqual(c, await runJob({ kind: 'random', seed: 1, runs: 20 }, here));
  assert.deepStrictEqual(d, await runJob({ kind: 'walk' }, here));
});

test('Stop ends the worker at once and keeps the variants the sweep had finished; the next job starts a fresh worker with the prices', async (t) => {
  const w = inProcess();
  const client = track(t, { makeWorker: w.make });
  const block = input();
  const jobs = client.forBlock(block);
  const seen: number[] = [];
  const running = jobs.run(
    { kind: 'sweep' },
    {
      onProgress: (done) => {
        seen.push(done);
        if (done === 4) running.stop();
      },
    },
  );
  const stopped = (await running.done)!;
  assert.deepEqual(seen, [1, 2, 3, 4]);
  let done = 0;
  assert.deepStrictEqual(stopped, await runSweep(SRC, block.backtest.data, { parse: block.parse, onProgress: (d) => (done = d), shouldStop: () => done >= 4 }));
  assert.deepEqual(w.log, ['data 1', 'job sweep', 'end']);
  await jobs.run({ kind: 'reshuffle', seed: 1, runs: 10 }).done;
  assert.equal(w.made(), 2);
  assert.deepEqual(w.log.slice(3), ['data 1', 'job reshuffle']);
});

test('a job waits while another block\'s job runs, and Stop takes a waiting job off the queue at once', async (t) => {
  const w = inProcess();
  const client = track(t, { makeWorker: w.make });
  const one = client.forBlock(input(SRC, 1));
  const two = client.forBlock(input(SRC, 2));
  const waits: boolean[] = [];
  const first = one.run({ kind: 'sweep' });
  const second = two.run({ kind: 'reshuffle', seed: 1, runs: 10 }, { onWait: (on) => waits.push(on) });
  const third = two.run({ kind: 'walk' });
  assert.deepEqual(waits, [true]);
  third.stop();
  assert.equal(await third.done, null);
  await first.done;
  await second.done;
  assert.deepEqual(waits, [true, false]);
  assert.deepEqual(w.log, ['data 1', 'job sweep', 'data 2', 'job reshuffle']);
});

test('closing a section stops its job; the worker drops a block\'s prices when no section uses them', async (t) => {
  const w = inProcess();
  const client = track(t, { makeWorker: w.make });
  const block = input();
  const sweep = client.forBlock(block);
  const luck = client.forBlock(block);
  await luck.run({ kind: 'reshuffle', seed: 1, runs: 10 }).done;
  let late = 0;
  const running = sweep.run({ kind: 'sweep' }, { onProgress: () => late++ });
  sweep.close();
  const stopped = (await running.done)!;
  assert.deepEqual([stopped.stopped, stopped.points.length, late], [true, 0, 0]);
  // The other section still uses the prices; a fresh worker gets them again for its job.
  await luck.run({ kind: 'reshuffle', seed: 2, runs: 10 }).done;
  luck.close();
  assert.deepEqual(w.log, ['data 1', 'job reshuffle', 'job sweep', 'end', 'data 1', 'job reshuffle', 'drop 1']);
});

test('an idle worker is ended after a while, and shutdown ends a running one and settles its job', async (t) => {
  const w = inProcess();
  const client = track(t, { makeWorker: w.make, idleMs: 20 });
  const jobs = client.forBlock(input());
  await jobs.run({ kind: 'reshuffle', seed: 1, runs: 10 }).done;
  assert.ok(!w.log.includes('end'));
  await sleep(60);
  assert.equal(w.log.at(-1), 'end');
  const running = jobs.run({ kind: 'walk' });
  const queued = jobs.run({ kind: 'sweep' });
  client.shutdown();
  assert.equal(await running.done, null);
  assert.equal((await queued.done)!.stopped, true);
  assert.equal(w.log.at(-1), 'end');
});

test('when no worker can be made, the same jobs run on the main thread, and Stop still works there', async (t) => {
  let tries = 0;
  const client = track(t, {
    makeWorker: () => {
      tries++;
      throw new Error('Workers are not allowed here');
    },
  });
  const block = input();
  const jobs = client.forBlock(block);
  assert.deepStrictEqual(await jobs.run({ kind: 'sweep' }).done, await runJob({ kind: 'sweep' }, benchOf(block)));
  assert.deepStrictEqual(await jobs.run({ kind: 'random', seed: 4, runs: 12 }).done, await runJob({ kind: 'random', seed: 4, runs: 12 }, benchOf(block)));
  const running = jobs.run({ kind: 'sweep' }, { onProgress: (d) => d === 4 && running.stop() });
  const stopped = (await running.done)!;
  assert.deepEqual([stopped.stopped, stopped.tried], [true, 4]);
  assert.equal(tries, 1);
});

test('a worker that fails while starting is given up for good, and its job runs on the main thread', async (t) => {
  let made = 0;
  const client = track(t, {
    makeWorker: (on) => {
      made++;
      setTimeout(() => on.error('Refused by the content security policy'));
      return { post: () => {}, terminate: () => {} };
    },
  });
  const block = input();
  const jobs = client.forBlock(block);
  const progress: number[] = [];
  const result = await jobs.run({ kind: 'sweep' }, { onProgress: (d) => progress.push(d) }).done;
  assert.deepStrictEqual(result, await runJob({ kind: 'sweep' }, benchOf(block)));
  assert.equal(progress.length, 15);
  await jobs.run({ kind: 'reshuffle', seed: 1, runs: 10 }).done;
  assert.equal(made, 1);
});

test('a worker that never says it is ready is given up after a while', async (t) => {
  const w = inProcess({ ready: false });
  const client = track(t, { makeWorker: w.make, startMs: 30 });
  const block = input();
  const result = await client.forBlock(block).run({ kind: 'reshuffle', seed: 1, runs: 10 }).done;
  assert.deepStrictEqual(result, await runJob({ kind: 'reshuffle', seed: 1, runs: 10 }, benchOf(block)));
  assert.equal(w.log.at(-1), 'end');
});

test('after one worker slow to start, the next job tries a fresh worker', async (t) => {
  const w = inProcess({ ready: (n) => n > 1 });
  const client = track(t, { makeWorker: w.make, startMs: 30 });
  const block = input();
  const jobs = client.forBlock(block);
  const job = { kind: 'reshuffle', seed: 1, runs: 10 } as const;
  assert.deepStrictEqual(await jobs.run(job).done, await runJob(job, benchOf(block)));
  assert.equal(client.foreground(), false);
  assert.deepStrictEqual(await jobs.run(job).done, await runJob(job, benchOf(block)));
  assert.equal(w.made(), 2);
  assert.equal(w.log.filter((m) => m === 'job reshuffle').length, 2);
  assert.equal(client.foreground(), false);
});

test('two workers in a row slow to start give up on workers for good', async (t) => {
  const w = inProcess({ ready: false });
  const client = track(t, { makeWorker: w.make, startMs: 30 });
  const block = input();
  const jobs = client.forBlock(block);
  const job = { kind: 'reshuffle', seed: 1, runs: 10 } as const;
  await jobs.run(job).done;
  assert.equal(client.foreground(), false);
  assert.deepStrictEqual(await jobs.run(job).done, await runJob(job, benchOf(block)));
  assert.equal(client.foreground(), true);
  await jobs.run(job).done;
  assert.equal(w.made(), 2);
});

test('a worker that dies during a job fails that job with a message; the next job starts a fresh worker', async (t) => {
  const w = inProcess({ failFirstJob: true });
  const client = track(t, { makeWorker: w.make });
  const jobs = client.forBlock(input());
  await assert.rejects(jobs.run({ kind: 'sweep' }).done, /^Error: The run stopped unexpectedly: Out of memory$/);
  assert.equal((await jobs.run({ kind: 'sweep' }).done)!.points.length, 15);
  assert.equal(w.made(), 2);
});

test('a job that fails in the worker rejects with its message', async (t) => {
  const w = inProcess();
  const client = track(t, { makeWorker: w.make });
  const jobs = client.forBlock(input('universe: A\nn = 5\nbuy when close > sma(n)'));
  await assert.rejects(jobs.run({ kind: 'walk' }).done, /needs a parameter with a range/);
});

test('without the parser defaults a block\'s text cannot be parsed in a worker, so its jobs run here', async (t) => {
  const w = inProcess();
  const client = track(t, { makeWorker: w.make });
  const block = input(SRC, 1, false);
  assert.deepStrictEqual(await client.forBlock(block).run({ kind: 'sweep' }).done, await runJob({ kind: 'sweep' }, benchOf(block)));
  assert.equal(w.made(), 0);
});

test('messages from an ended worker are ignored', async (t) => {
  const sent: ((m: FromWorker) => void)[] = [];
  const client = track(t, {
    makeWorker: (on) => {
      sent.push(on.message);
      setTimeout(() => on.message({ type: 'ready' }));
      return { post: () => {}, terminate: () => {} };
    },
  });
  const jobs = client.forBlock(input());
  const first = jobs.run({ kind: 'reshuffle', seed: 1, runs: 10 });
  await sleep(5);
  first.stop();
  assert.equal(await first.done, null);
  const second = jobs.run({ kind: 'reshuffle', seed: 1, runs: 10 });
  // The first worker's late answer, under the id the second job happens to have in the second worker, changes nothing.
  sent[0]({ type: 'done', id: 2, result: { runs: -1 } as unknown as BootstrapResult });
  second.stop();
  assert.equal(await second.done, null);
});

test('with a slider moved, the luck checks test the run on screen and the sweep ranks the block as written, alike in the worker and here', async (t) => {
  // fast's slider walks 7, 12, 17, 22: 17 is off the sweep's grid. slow has no range; its slider still moves it.
  const source = 'universe: A 50%, B 50%\nfast = 12 in 5..25 step 5\nslow = 40\nbuy when sma(fast) > sma(slow)\nsell when sma(fast) < sma(slow)';
  const base = input(source, 3);
  const data = base.backtest.data;
  const values = { fast: 17, slow: 45 };
  // What main.ts hands the sections after the slider moves: the block's text and parser, and the run drawn with its values.
  const shown = runBacktest(base.parse(values).spec!, data);
  assert.notDeepEqual(shown.stats, base.backtest.stats);
  const slid: JobInput = { ...base, backtest: shown };
  const jobs = [{ kind: 'sweep' }, { kind: 'reshuffle', seed: 1, runs: 200 }, { kind: 'random', seed: 1, runs: 40 }, { kind: 'walk' }] as const;
  const results: Record<string, unknown[]> = {};
  for (const [label, make] of [['worker', inProcess().make], ['here', noWorker]] as const) {
    const client = track(t, { makeWorker: make });
    const section = client.forBlock(slid);
    results[label] = [];
    for (const job of jobs) results[label].push(await section.run(job).done);
    section.close();
  }
  assert.deepStrictEqual(results.worker, results.here);
  const [sweep, reshuffle, random, walk] = results.here as [SweepResult, BootstrapResult, RandomEntriesResult, WalkForwardResult];
  assert.deepStrictEqual(sweep, await runSweep(source, data, { parse: base.parse }));
  assert.deepStrictEqual(reshuffle, bootstrap(shown.run.t, shown.run.equity, { seed: 1, runs: 200, blockBars: blockFor(shown) }));
  assert.deepStrictEqual(random, await randomEntries(shown, { seed: 1, runs: 40 }));
  assert.deepStrictEqual(walk, await walkForward(source, data, { parse: (o) => base.parse({ ...values, ...o }) }));
  // Walk-forward compares against the run on screen: its value 17 is tried, and the line follows the slider's run.
  assert.ok(walk.params[0].values.includes(17));
  const w = walk.windows[0];
  const at = (x: number) => shown.run.t.indexOf(x);
  assert.ok(near(w.declaredReturn, shown.run.equity[at(w.testTo)] / shown.run.equity[at(w.testFrom) - 1] - 1, 1e-12));
});

test('entries and a commission reach the luck checks alike in the worker and here: the worker reads them from the text and the defaults', async (t) => {
  // `entries` and the add rule come from the block's text; the commission only from the plugin's defaults.
  const defaults: Partial<Defaults> = { ...DEFAULTS, commission: { k: 'share', fee: 0.01, min: 1, max: null } };
  const source = 'universe: A 50%, B 50%\nentries: 3\nbuy when close > sma(10)\nadd when close > last entry price * 1.01\nsell when close < sma(10)';
  const base = input(source, 4);
  const parse: Parse = (overrides) => parseSpec(source, { defaults, overrides });
  const block: JobInput = { ...base, defaults, parse, backtest: runBacktest(parse({}).spec!, base.backtest.data) };
  assert.ok(block.backtest.run.commission! > 0 && block.backtest.run.trades.some((tr) => tr.entries!.length === 3));
  const results: Record<string, RandomEntriesResult> = {};
  for (const [label, make] of [['worker', inProcess().make], ['here', noWorker]] as const) {
    const section = track(t, { makeWorker: make }).forBlock(block);
    results[label] = (await section.run({ kind: 'random', seed: 5, runs: 30 }).done) as RandomEntriesResult;
    section.close();
  }
  assert.deepStrictEqual(results.worker, results.here);
  assert.deepStrictEqual(results.here, await randomEntries(block.backtest, { seed: 5, runs: 30 }));
  // The same block with neither feature gives other numbers, so both were really in the tries.
  const plain = input('universe: A 50%, B 50%\nbuy when close > sma(10)\nsell when close < sma(10)', 4);
  assert.notDeepEqual(results.here.random.cagr, (await randomEntries(plain.backtest, { seed: 5, runs: 30 })).random.cagr);
});

test('one worker keeps a block\'s prices once and a separate run for each set of values, never reusing the wrong one', async (t) => {
  const w = inProcess();
  const client = track(t, { makeWorker: w.make });
  const declared = input();
  const shown = runBacktest(declared.parse({ fast: 25 }).spec!, declared.backtest.data);
  const a = client.forBlock(declared);
  const b = client.forBlock({ ...declared, backtest: shown });
  const job = { kind: 'reshuffle', seed: 2, runs: 50 } as const;
  for (let round = 0; round < 2; round++) {
    assert.deepStrictEqual(await b.run(job).done, bootstrap(shown.run.t, shown.run.equity, { seed: 2, runs: 50, blockBars: blockFor(shown) }));
    assert.deepStrictEqual(await a.run(job).done, bootstrap(declared.backtest.run.t, declared.backtest.run.equity, { seed: 2, runs: 50, blockBars: blockFor(declared.backtest) }));
  }
  assert.deepEqual(w.log.filter((m) => m.startsWith('data')), ['data 1']);
});

// ---------------------------------------------------------------- single runs

/** A run of the block behind `input` with `overrides`, as main.ts asks for one. */
function request(block: JobInput, overrides: Record<string, number> = {}, more: Partial<RunRequest> = {}): RunRequest {
  const data = block.backtest.data;
  return { block: { source: block.source, defaults: DEFAULTS, overrides }, prices: data, size: runSize(block.parse(overrides).spec!, data), ...more };
}
const direct = (req: RunRequest): Ran => runBlock(req.block, req.prices);
/** What a run gives, without how long it took here. */
const ranOf = async (p: Promise<RunResult | null>) => (await p)?.backtest ?? null;
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** The latest run or job a worker was sent. */
const lastWork = (posts: ToWorker[]) => [...posts].reverse().find((m) => m.type === 'run' || m.type === 'job')!;

/** Workers whose answers are given by hand. `answer` replies to the latest run or job posted to a worker. */
function byHand() {
  const workers: { posts: ToWorker[]; alive: boolean; on: Parameters<MakeWorker>[0] }[] = [];
  const make: MakeWorker = (on) => {
    const w = { posts: [] as ToWorker[], alive: true, on };
    workers.push(w);
    return { post: (m) => w.posts.push(m), terminate: () => (w.alive = false) };
  };
  const prices = new Map<number, Map<string, Bars>>();
  const answer = (k: number) => {
    const w = workers[k];
    for (const m of w.posts) if (m.type === 'data') prices.set(m.id, m.data);
    const last = lastWork(w.posts);
    if (last.type !== 'run') throw new Error('not a run');
    w.on.message({ type: 'ran', id: last.id, result: runBlock(last.block, prices.get(last.data)!) });
  };
  const runs = (k: number) => workers[k].posts.flatMap((m) => (m.type === 'run' ? [JSON.stringify(m.block.overrides)] : []));
  return { make, workers, answer, runs };
}

test('a block\'s runs go to a worker of their own, which gets its prices once and gives exactly what runs here', async (t) => {
  const w = inProcess();
  const client = track(t, { makeWorker: w.make });
  const block = input();
  const runs = client.runs();
  for (const fast of [10, 15, 20]) {
    const req = request(block, { fast });
    assert.deepStrictEqual(await runs.run(req), { backtest: direct(req), hereMs: null });
  }
  assert.deepEqual(w.log, ['data 1', 'run {"fast":10}', 'run {"fast":15}', 'run {"fast":20}']);
  assert.equal(w.made(), 1);
  runs.close();
  assert.equal(w.log.at(-1), 'drop 1');
});

test('a sweep never holds up a single run: they go to different workers', async (t) => {
  const w = byHand();
  const client = track(t, { makeWorker: w.make });
  const block = input();
  const sweep = client.forBlock(block).run({ kind: 'sweep' });
  const runs = client.runs();
  const ran = runs.run(request(block));
  assert.equal(w.workers.length, 2);
  assert.deepEqual(w.workers[0].posts.map((m) => m.type), ['data', 'job']);
  assert.deepEqual(w.workers[1].posts.map((m) => m.type), ['data', 'run']);
  w.answer(1);
  assert.deepStrictEqual(await ranOf(ran), direct(request(block)));
  sweep.stop();
  assert.equal((await sweep.done)!.stopped, true);
});

test('runs of blocks on screen go before background runs asked for earlier, and each kind keeps its order', async (t) => {
  const w = byHand();
  const client = track(t, { makeWorker: w.make });
  const block = input();
  const runs = client.runs();
  const asked = [
    runs.run(request(block, { fast: 5 })),
    runs.run(request(block, { fast: 10 }, { background: true })),
    runs.run(request(block, { fast: 15 }, { background: true })),
    runs.run(request(block, { fast: 20 })),
    runs.run(request(block, { fast: 25 })),
  ];
  for (let i = 0; i < 5; i++) {
    w.answer(0);
    await flush();
  }
  await Promise.all(asked);
  assert.deepEqual(w.runs(0), ['{"fast":5}', '{"fast":20}', '{"fast":25}', '{"fast":10}', '{"fast":15}']);
});

test('a run past its time is stopped by ending its worker; the next run goes to a fresh worker with its prices', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = byHand();
  const client = track(t, { makeWorker: w.make });
  const one = input(SRC, 1);
  const two = input(SRC, 2);
  const runs = client.runs();
  const other = client.runs();
  const slow = runs.run(request(one));
  const next = other.run(request(two));
  w.workers[0].on.message({ type: 'ready' });
  t.mock.timers.tick(LIMITS.runMs - 1);
  await flush();
  assert.equal(w.workers[0].alive, true);
  t.mock.timers.tick(1);
  await assert.rejects(slow, (e: unknown) => {
    assert.ok(e instanceof LimitError);
    assert.deepEqual([e.kind, e.anyway], ['time', true]);
    assert.equal(e.message, `This backtest was stopped after 10 seconds, the most one run may take. It has 1,600 bars across 2 tickers. A later "from" date, a longer "interval", fewer tickers or shorter periods make it faster.`);
    return true;
  });
  assert.equal(w.workers[0].alive, false);
  assert.deepEqual(w.workers[1].posts.map((m) => m.type), ['data', 'run']);
  w.answer(1);
  assert.deepStrictEqual(await ranOf(next), direct(request(two)));
  // The first block's prices were in the ended worker: its next run sends them again.
  const again = runs.run(request(one, { fast: 15 }));
  await flush();
  assert.deepEqual(w.workers[1].posts.map((m) => (m.type === 'data' ? `data ${m.id}` : m.type)), ['data 2', 'run', 'data 1', 'run']);
  w.answer(1);
  assert.deepStrictEqual(await ranOf(again), direct(request(one, { fast: 15 })));
});

test('a run asked for anyway has the longer time, and once that passes it offers nothing more', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = byHand();
  const client = track(t, { makeWorker: w.make });
  const runs = client.runs();
  const slow = runs.run(request(input(), {}, { anyway: true }));
  w.workers[0].on.message({ type: 'ready' });
  t.mock.timers.tick(LIMITS.runMs);
  await flush();
  assert.equal(w.workers[0].alive, true);
  t.mock.timers.tick(LIMITS.anywayMs - LIMITS.runMs);
  await assert.rejects(slow, (e: unknown) => e instanceof LimitError && e.kind === 'time' && !e.anyway && /stopped after 2 minutes/.test(e.message));
});

test('a run too large for a worker is refused before anything starts, unless asked for anyway', async (t) => {
  const w = inProcess();
  const client = track(t, { makeWorker: w.make });
  const block = input();
  const huge = request(block, {}, { size: { bars: 2_000_000, tickers: 40, ruleWork: 0, windowWork: 0 } });
  await assert.rejects(client.runs().run(huge), (e: unknown) => e instanceof LimitError && e.kind === 'size' && e.anyway && /^This run has 2 million bars across 40 tickers; the limit is 1 million\./.test(e.message));
  assert.equal(w.made(), 0);
  assert.deepStrictEqual(await ranOf(client.runs().run({ ...huge, anyway: true })), direct(huge));
});

test('when no worker can be made, runs happen here with the stricter limits of the main thread', async (t) => {
  const client = track(t, { makeWorker: noWorker });
  const block = input();
  const runs = client.runs();
  const req = request(block, { fast: 15 });
  const here = (await runs.run(req))!;
  assert.deepStrictEqual(here.backtest, direct(req));
  // Here it says how long the backtest took, for whether a slider drag may redo it.
  assert.ok(here.hereMs !== null && here.hereMs >= 0 && here.hereMs < 5000);
  assert.equal(client.foreground(), true);
  const big = request(block, {}, { size: { bars: 300_000, tickers: 1, ruleWork: 0, windowWork: 0 } });
  await assert.rejects(runs.run(big), (e: unknown) => e instanceof LimitError && /^Backtests run in the foreground here.*the limit here is 200,000\./.test(e.message));
  assert.deepStrictEqual(await ranOf(runs.run({ ...big, anyway: true })), direct(big));
});

test('a worker that fails while starting sends its run here, which checks the main thread\'s limits first', async (t) => {
  const client = track(t, {
    makeWorker: (on) => {
      setTimeout(() => on.error('Refused by the content security policy'));
      return { post: () => {}, terminate: () => {} };
    },
  });
  const block = input();
  const size = { bars: 300_000, tickers: 1, ruleWork: 0, windowWork: 0 };
  // Fits a worker, so it is sent to one; that worker never starts, and here it is too large.
  await assert.rejects(client.runs().run(request(block, {}, { size })), (e: unknown) => e instanceof LimitError && /the limit here is 200,000/.test(e.message));
  assert.equal(client.foreground(), true);
  assert.deepStrictEqual(await ranOf(client.runs().run(request(block))), direct(request(block)));
});

test('closing a block\'s runs stops a waiting run and a running one, and the worker drops the prices only when no one uses them', async (t) => {
  const w = byHand();
  const client = track(t, { makeWorker: w.make });
  const block = input();
  const section = client.forBlock(block);
  const first = client.runs();
  const second = client.runs();
  const running = first.run(request(block));
  const waiting = first.run(request(block, { fast: 15 }));
  const queued = second.run(request(input(SRC, 2)));
  first.close();
  assert.equal(await running, null);
  assert.equal(await waiting, null);
  assert.equal(w.workers[0].alive, false);
  // The other block's run goes on in a fresh worker; the section still holds the first block's prices.
  assert.deepEqual(w.workers[1].posts.map((m) => m.type), ['data', 'run']);
  w.answer(1);
  await queued;
  const late = first.run(request(block));
  assert.equal(await late, null);
  second.close();
  assert.deepEqual(w.workers[1].posts.map((m) => (m.type === 'data' || m.type === 'drop' ? `${m.type} ${m.id}` : m.type)), ['data 2', 'run', 'drop 2']);
  section.close();
});

test('a block whose runs move to other prices lets the old ones go', async (t) => {
  const w = inProcess();
  const client = track(t, { makeWorker: w.make });
  const runs = client.runs();
  await runs.run(request(input(SRC, 1)));
  await runs.run(request(input(SRC, 2)));
  runs.close();
  assert.deepEqual(w.log, ['data 1', 'run {}', 'drop 1', 'data 2', 'run {}', 'drop 2']);
});

test('a sweep or a luck check that goes too long without finishing a step is stopped; each step restarts its clock', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = byHand();
  const client = track(t, { makeWorker: w.make });
  const running = client.forBlock(input()).run({ kind: 'sweep' });
  w.workers[0].on.message({ type: 'ready' });
  const job = lastWork(w.workers[0].posts);
  for (let done = 1; done <= 3; done++) {
    t.mock.timers.tick(LIMITS.stepMs - 1);
    w.workers[0].on.message({ type: 'progress', id: job.id, done, total: 15, points: [] });
  }
  await flush();
  assert.equal(w.workers[0].alive, true);
  t.mock.timers.tick(LIMITS.stepMs);
  await assert.rejects(running.done, (e: unknown) => e instanceof LimitError && e.kind === 'time' && !e.anyway && e.message === 'This was stopped after 2 minutes without finishing a backtest, the most one may take.');
  assert.equal(w.workers[0].alive, false);
});

test('shutdown ends single runs too', async (t) => {
  const w = byHand();
  const client = track(t, { makeWorker: w.make });
  const runs = client.runs();
  const running = runs.run(request(input()));
  const waiting = runs.run(request(input(), { fast: 15 }));
  client.shutdown();
  assert.deepEqual([await running, await waiting], [null, null]);
  assert.equal(w.workers[0].alive, false);
});

test('prices used by a block\'s runs and by a section are dropped from both workers once the last of them closes', async (t) => {
  const w = inProcess();
  const client = track(t, { makeWorker: w.make });
  const block = input();
  const section = client.forBlock(block);
  const runs = client.runs();
  await runs.run(request(block));
  await section.run({ kind: 'reshuffle', seed: 1, runs: 10 }).done;
  runs.close();
  assert.ok(!w.log.includes('drop 1'));
  section.close();
  assert.deepEqual(w.log, ['data 1', 'run {}', 'data 1', 'job reshuffle', 'drop 1', 'drop 1']);
});

// ---------------------------------------------------------------- nothing runs on the main thread while a worker exists

/** Prices that count every read: a backtest on them cannot run without reading them. */
function counted(prices: Map<string, Bars>): { prices: Map<string, Bars>; reads: () => number; reset: () => void } {
  let reads = 0;
  const seen = new Map(prices);
  const bump = <T>(f: () => T): T => (reads++, f());
  const map = new (class extends Map<string, Bars> {
    override get = (k: string) => bump(() => seen.get(k));
    override has = (k: string) => bump(() => seen.has(k));
    override keys = () => bump(() => seen.keys());
    override values = () => bump(() => seen.values());
    override entries = () => bump(() => seen.entries());
    override [Symbol.iterator] = () => bump(() => seen[Symbol.iterator]());
    override forEach = (f: (v: Bars, k: string, m: Map<string, Bars>) => void) => bump(() => seen.forEach(f));
  })();
  return { prices: map, reads: () => reads, reset: () => (reads = 0) };
}

/** A block whose own run has been made, with prices that count reads. */
function watched(source = SRC): { block: JobInput; reads: () => number } {
  const base = input(source);
  const c = counted(base.backtest.data);
  c.reset();
  return { block: { ...base, backtest: { ...base.backtest, data: c.prices } }, reads: c.reads };
}

test('stopping a sweep, closing its section, drawing the block again and unloading never run a backtest on the main thread', async (t) => {
  for (const how of ['stop', 'close', 'queued', 'shutdown'] as const) {
    const w = byHand();
    const client = track(t, { makeWorker: w.make });
    const { block, reads } = watched();
    const section = client.forBlock(block);
    const running = section.run({ kind: 'sweep' });
    // Another section's job waits behind it, as the next slider position's sections do.
    const waiting = client.forBlock(block).run({ kind: 'sweep' });
    w.workers[0].on.message({ type: 'ready' });
    if (how === 'stop') running.stop();
    else if (how === 'close') section.close();
    else if (how === 'queued') waiting.stop();
    else client.shutdown();
    const first = how === 'queued' ? null : await running.done;
    const second = how === 'close' || how === 'stop' ? null : await waiting.done;
    for (const result of [first, second]) {
      if (result) assert.deepEqual([result.stopped, result.tried, result.total], [true, 0, 15], how);
    }
    assert.equal(reads(), 0, `${how}: a backtest ran on the main thread`);
    client.shutdown();
  }
});

// ---------------------------------------------------------------- the preview panel's runs

/** What the plugin does to show a block in the preview panel: one set of runs for each draw, let go of when the draw is ended or fails. */
function panelShow(client: ReturnType<typeof createJobClient>, latest: Latest, block: JobInput, overrides: Record<string, number> = {}, after: () => Promise<void> = async () => {}) {
  const runs = client.runs();
  const signal = latest.start();
  return drawHeld(
    async () => {
      if ((await runs.run(request(block, overrides))) === null) return;
      await after();
    },
    () => runs.close(),
    signal,
  );
}

test('a burst of edits leaves one panel run going: each newer one stops the older, so none waits behind it, and closing the panel stops the last', async (t) => {
  const w = byHand();
  const client = track(t, { makeWorker: w.make });
  const latest = new Latest();
  const block = input();
  const alive = () => w.workers.filter((x) => x.alive);
  const edits = [1, 2, 3, 4].map((fast) => {
    const shown = panelShow(client, latest, block, { fast: fast * 5 });
    // At every step the only run out is the newest one.
    assert.equal(alive().length, 1);
    assert.deepEqual(w.workers.at(-1)!.posts.flatMap((m) => (m.type === 'run' ? [JSON.stringify(m.block.overrides)] : [])), [`{"fast":${fast * 5}}`]);
    return shown;
  });
  // The older draws ended without a result; the newest is still waiting for its answer.
  await Promise.all(edits.slice(0, -1));
  w.answer(w.workers.length - 1);
  const shown = await edits[3];
  assert.equal(alive().length, 1);
  // Nothing queued behind: the one run was answered and the worker is idle.
  latest.stop();
  shown();
  assert.equal(w.workers.length, 4);
});

test('closing the panel while a run is out ends it and lets the prices go', async (t) => {
  const w = byHand();
  const client = track(t, { makeWorker: w.make });
  const latest = new Latest();
  const shown = panelShow(client, latest, input());
  latest.stop();
  await shown;
  assert.equal(w.workers[0].alive, false);
});

test('a result on screen is not touched by a newer edit starting; its prices go when it is let go', async (t) => {
  const w = inProcess();
  const client = track(t, { makeWorker: w.make });
  const latest = new Latest();
  const one = input(SRC, 1);
  const two = input(SRC, 2);
  const release = await panelShow(client, latest, one);
  void panelShow(client, latest, two);
  assert.ok(!w.log.includes('drop 1'));
  release();
  assert.ok(w.log.includes('drop 1'));
});

test('a draw that fails after its run lets its prices go instead of leaving them in the worker', async (t) => {
  const w = inProcess();
  const client = track(t, { makeWorker: w.make });
  const latest = new Latest();
  await assert.rejects(
    panelShow(client, latest, input(), {}, () => Promise.reject(new Error('The result could not be drawn'))),
    /could not be drawn/,
  );
  assert.deepEqual(w.log, ['data 1', 'run {}', 'drop 1']);
  // A run refused for its size never sent its prices, and its draw fails the same way.
  const huge = input(SRC, 2);
  await assert.rejects(
    drawHeld(
      async () => void (await client.runs().run(request(huge, {}, { size: { bars: 2_000_000, tickers: 40, ruleWork: 0, windowWork: 0 } }))),
      () => {},
      latest.start(),
    ),
    (e: unknown) => e instanceof LimitError,
  );
  assert.ok(!w.log.includes('data 2'));
});

// ---------------------------------------------------------------- trigger prices

/** The trigger prices of the run behind `input`, as Results asks for them. */
function triggersOf(block: JobInput, more: Partial<TriggersRequest> = {}): TriggersRequest {
  const bt = block.backtest;
  return { spec: bt.spec, prices: bt.data, run: triggerRun(bt.run), size: runSize(bt.spec, bt.data), ...more };
}
const triggersHere = (block: JobInput) => computeTriggers(block.backtest.spec, block.backtest.data, triggerRun(block.backtest.run));

test('trigger prices go to the runs\' worker, which already holds the prices of the run, and give exactly what they give here', async (t) => {
  const w = inProcess();
  const client = track(t, { makeWorker: w.make });
  const block = input();
  const runs = client.runs();
  await runs.run(request(block));
  const report = await runs.triggers(triggersOf(block));
  assert.deepStrictEqual(report, triggersHere(block));
  assert.ok(report!.triggers.length === 2);
  assert.deepEqual(w.log.map((m) => m.split(' ')[0]), ['data', 'run', 'triggers']);
  runs.close();
  assert.equal(w.log.at(-1), 'drop 1');
});

test('when no worker can be made, trigger prices are worked out here, except for a run too large for the main thread', async (t) => {
  const client = track(t, { makeWorker: noWorker });
  const block = input();
  const runs = client.runs();
  assert.deepStrictEqual(await runs.triggers(triggersOf(block)), triggersHere(block));
  assert.equal(await runs.triggers(triggersOf(block, { size: { bars: 300_000, tickers: 1, ruleWork: 0, windowWork: 0 } })), null);
});

test('closing the runs drops trigger prices still on their way, and ones past the time a run may take are left out, not failed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = byHand();
  const client = track(t, { makeWorker: w.make });
  const block = input();
  const runs = client.runs();
  const waiting = runs.triggers(triggersOf(block));
  runs.close();
  assert.equal(await waiting, null);
  const slow = client.runs().triggers(triggersOf(block));
  w.workers.at(-1)!.on.message({ type: 'ready' });
  t.mock.timers.tick(LIMITS.runMs);
  assert.equal(await slow, null);
  assert.equal(w.workers.at(-1)!.alive, false);
});

test('trigger prices that fail in the worker reject with the message', async (t) => {
  const w = inProcess();
  const client = track(t, { makeWorker: w.make });
  const block = input();
  const broken = { ...block.backtest.spec, universe: [...block.backtest.spec.universe, { name: 'C', source: 'yahoo' as const, id: 'C', weight: 0.5 }] };
  await assert.rejects(client.runs().triggers(triggersOf(block, { spec: broken })));
});
