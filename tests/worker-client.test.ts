import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec, type Defaults } from '../src/dsl.ts';
import { runJob, serve, type Bench, type FromWorker, type ToWorker } from '../src/jobs.ts';
import { blockFor, bootstrap, randomEntries, walkForward, type BootstrapResult, type RandomEntriesResult, type WalkForwardResult } from '../src/luck.ts';
import { makeRng } from '../src/rng.ts';
import { runSweep, type Parse, type SweepResult } from '../src/sweep.ts';
import type { Bars } from '../src/types.ts';
import { createJobClient, type JobInput, type MakeWorker } from '../src/worker-client.ts';
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
function inProcess(opts: { ready?: boolean; failFirstJob?: boolean } = {}) {
  const log: string[] = [];
  let made = 0;
  let jobs = 0;
  const make: MakeWorker = (on) => {
    made++;
    let alive = true;
    const handle = serve((m) => {
      if (alive) on.message(structuredClone(m));
    }, 0);
    // A worker that never gets ready never answers either.
    if (opts.ready !== false) setTimeout(() => alive && on.message({ type: 'ready' }));
    return {
      post: (m: ToWorker) => {
        log.push(m.type === 'job' ? `job ${m.job.kind}` : `${m.type} ${m.id}`);
        const copy = structuredClone(m);
        setTimeout(() => {
          if (!alive || opts.ready === false) return;
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
