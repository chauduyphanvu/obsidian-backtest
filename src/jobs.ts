// Single backtests, the sweep and the luck checks as jobs: plain data in, progress and plain data out, so the same
// functions run in a worker (see worker.ts and worker-client.ts) or, when no worker can start, on the main thread.

import { runBacktest, type Backtest } from './backtest.ts';
import { parseCsv } from './data.ts';
import { parseSpec, type Defaults, type Spec } from './dsl.ts';
import { blockFor, bootstrap, randomEntries, walkForward, type BootstrapResult, type RandomEntriesResult, type WalkForwardResult } from './luck.ts';
import { priceMemo } from './price-memo.ts';
import { baseSpec, runSweep, sweepParams, sweepSize, type Parse, type SweepPoint, type SweepResult } from './sweep.ts';
import { computeTriggers, type TriggerReport, type TriggerRun } from './trigger.ts';
import type { Bars } from './types.ts';

/** A block's text, the parser defaults and the values a job puts on top, so a worker parses it exactly as the note does. */
export interface Block {
  source: string;
  defaults: Partial<Defaults>;
  /** Parameter values that replace the block's own for this job (see jobOverrides); empty for the block as written. */
  overrides: Record<string, number>;
}

export type Job = { kind: 'sweep' } | { kind: 'reshuffle'; seed: number; runs: number } | { kind: 'random'; seed: number; runs: number } | { kind: 'walk' };
export type Kind = Job['kind'];
export type JobOf<K extends Kind> = Extract<Job, { kind: K }>;

/** What each job returns. A walk-forward that is stopped returns null. */
export interface Results {
  sweep: SweepResult;
  reshuffle: BootstrapResult;
  random: RandomEntriesResult;
  walk: WalkForwardResult | null;
}

/** What a job works on: the block's text, its prices, and the block as written, run once on them. */
export interface Bench {
  source: string;
  parse: Parse;
  data: Map<string, Bars>;
  backtest: () => Backtest;
}

/**
 * The parameter values a job runs with in place of the block's, from the run on screen, which a slider may have drawn with
 * other values. The sweep ranks the values written in the block, so it runs the block as written. The luck checks test
 * the run on screen, so they run with its values: the reshuffle, random entries and walk-forward all start from the run
 * that was drawn.
 */
export function jobOverrides(kind: Kind, shown: Spec): Record<string, number> {
  if (kind === 'sweep') return {};
  return Object.fromEntries(shown.params.filter((p) => p.value !== p.declared).map((p) => [p.name, p.value]));
}

/**
 * The bench a job works on, the same wherever it runs: the block read with `parse`, `overrides` on top, run once on `data`
 * when a job first needs it.
 */
export function benchWith(source: string, parse: Parse, data: Map<string, Bars>, overrides: Record<string, number>): Bench {
  const withValues: Parse = (values) => parse({ ...overrides, ...values });
  let bt: Backtest | undefined;
  return { source, parse: withValues, data, backtest: () => (bt ??= runBacktest(baseSpec(withValues), data)) };
}

/** A bench built from plain data, as a worker has to. */
export function benchFor(block: Block, data: Map<string, Bars>): Bench {
  return benchWith(block.source, (overrides) => parseSpec(block.source, { defaults: block.defaults, overrides }), data, block.overrides);
}

/** A backtest without the strategy and the prices it ran on: whoever asked for it holds both, so they are not sent back. */
export type Ran = Omit<Backtest, 'spec' | 'data'>;

/** One backtest of a block's text, read with its defaults and values as the note reads it, on its prices. */
export function runBlock(block: Block, data: Map<string, Bars>): Ran {
  const { spec, errors } = parseSpec(block.source, { defaults: block.defaults, overrides: block.overrides });
  if (!spec) throw new Error(`Line ${errors[0].line}: ${errors[0].message}`);
  // A block's prices are sent once and read by each run its slider makes.
  priceMemo.share(data);
  const { spec: _spec, data: _data, ...ran } = runBacktest(spec, data);
  return ran;
}

/** A result put back together with the strategy and prices it ran on: the same object runBacktest(spec, data) returns. */
export function withInputs(ran: Ran, spec: Spec, data: Map<string, Bars>): Backtest {
  return { spec, data, ...ran };
}

export interface Hooks {
  /** After each step; `sofar` is the sweep's or random entries' result so far, which grows as the job runs. */
  onProgress?: (done: number, total: number, sofar?: SweepResult | RandomEntriesResult) => void;
  shouldStop?: () => boolean;
  /** Lets other work in between batches. */
  pause?: () => Promise<void>;
}

type Runner<K extends Kind> = (job: JobOf<K>, bench: Bench, hooks: Hooks) => Promise<Results[K]>;

const RUNNERS: { [K in Kind]: Runner<K> } = {
  sweep: (_, b, hooks) => runSweep(b.source, b.data, { parse: b.parse, ...hooks }),
  reshuffle: async (job, b) => {
    const bt = b.backtest();
    return bootstrap(bt.run.t, bt.run.equity, { seed: job.seed, runs: job.runs, blockBars: blockFor(bt) });
  },
  random: (job, b, hooks) => randomEntries(b.backtest(), { seed: job.seed, runs: job.runs, ...hooks }),
  walk: (_, b, hooks) => walkForward(b.source, b.data, { parse: b.parse, ...hooks }),
};

export function runJob<K extends Kind>(job: JobOf<K>, bench: Bench, hooks: Hooks = {}): Promise<Results[K]> {
  return (RUNNERS[job.kind] as Runner<K>)(job, bench, hooks);
}

/** What a worker has sent of a job's result so far: the sweep's finished variants, or random entries' latest result. */
export interface Sofar {
  points: SweepPoint[];
  random: RandomEntriesResult | null;
}

/**
 * The result of a job ended from outside (its worker stopped), from what it had sent: the same as the job returns
 * when it notices a stop itself at that point. Null when there is nothing to show. It reads the block's text and
 * nothing else: this runs on the main thread, where a backtest of a block that only a worker may run would freeze the window.
 */
export function stoppedResult<K extends Kind>(kind: K, bench: Bench, sofar: Sofar): Results[K] | null {
  if (kind === 'sweep') {
    const spec = baseSpec(bench.parse);
    const result: SweepResult = { params: sweepParams(spec), points: sofar.points, tried: sofar.points.length, total: sweepSize(spec), stopped: true };
    return result as Results[K];
  }
  if (kind === 'random' && sofar.random) return { ...sofar.random, stopped: true } as Results[K];
  return null;
}

// ---------------------------------------------------------------- the worker's side of the messages

export type ToWorker =
  | { type: 'data'; id: number; data: Map<string, Bars> }
  | { type: 'drop'; id: number }
  | { type: 'job'; id: number; data: number; block: Block; job: Job }
  | { type: 'run'; id: number; data: number; block: Block }
  | { type: 'triggers'; id: number; data: number; spec: Spec; run: TriggerRun }
  | { type: 'csv'; id: number; text: string };

export interface Progress {
  type: 'progress';
  id: number;
  done: number;
  total: number;
  /** Sweep variants finished since the last message. */
  points?: SweepPoint[];
  /** Random entries' result so far. */
  random?: RandomEntriesResult;
}

export type FromWorker =
  | { type: 'ready' }
  | Progress
  | { type: 'done'; id: number; result: Results[Kind] }
  | { type: 'ran'; id: number; result: Ran }
  | { type: 'error'; id: number; message: string }
  | { type: 'triggered'; id: number; result: TriggerReport }
  | { type: 'parsed'; id: number; bars: Bars };

/** At most one progress message this often, so a fast job does not flood the main thread. */
const PROGRESS_MS = 50;
/** Benches kept per block's prices. Each slider position a luck check runs at makes one, so the oldest go. */
const BENCHES = 4;

/** A worker stops by being ended, so its jobs never need to let anything in. */
const free = () => Promise.resolve();

const failure = (id: number, e: unknown): FromWorker => ({ type: 'error', id, message: e instanceof Error ? e.message : String(e) });

/**
 * Handles the messages a worker receives. Prices arrive once per block (`data`) and stay until dropped; each job
 * names the prices it reads. Every job runs to the end in one go: the main thread stops one by ending the worker.
 * Progress goes out at most once every `every` milliseconds. A single run (`run`) is not kept: its result is sent and
 * forgotten, so a slider's many values do not pile up here. The trigger prices of a run (`triggers`) come with the
 * strategy and the run's end, so they too need only the prices. A CSV file's text (`csv`) is parsed into bars and sent back.
 */
export function serve(post: (m: FromWorker) => void, every = PROGRESS_MS): (m: ToWorker) => Promise<void> {
  const sets = new Map<number, { data: Map<string, Bars>; benches: Map<string, Bench> }>();
  return async (m) => {
    if (m.type === 'data') sets.set(m.id, { data: m.data, benches: new Map() });
    else if (m.type === 'drop') sets.delete(m.id);
    else if (m.type === 'run') {
      let reply: FromWorker;
      try {
        reply = { type: 'ran', id: m.id, result: runBlock(m.block, sets.get(m.data)!.data) };
      } catch (e) {
        reply = failure(m.id, e);
      }
      post(reply);
    } else if (m.type === 'triggers') {
      let reply: FromWorker;
      try {
        reply = { type: 'triggered', id: m.id, result: computeTriggers(m.spec, sets.get(m.data)!.data, m.run) };
      } catch (e) {
        reply = failure(m.id, e);
      }
      post(reply);
    } else if (m.type === 'csv') {
      let reply: FromWorker;
      try {
        reply = { type: 'parsed', id: m.id, bars: parseCsv(m.text) };
      } catch (e) {
        reply = failure(m.id, e);
      }
      post(reply);
    } else {
      const set = sets.get(m.data)!;
      const key = JSON.stringify(m.block);
      let bench = set.benches.get(key);
      if (!bench) {
        set.benches.set(key, (bench = benchFor(m.block, set.data)));
        if (set.benches.size > BENCHES) set.benches.delete(set.benches.keys().next().value!);
      }
      let last = -Infinity;
      let sent = 0;
      const onProgress: Hooks['onProgress'] = (done, total, sofar) => {
        const now = performance.now();
        if (now - last < every) return;
        last = now;
        const msg: Progress = { type: 'progress', id: m.id, done, total };
        if (sofar && 'points' in sofar) {
          msg.points = sofar.points.slice(sent);
          sent = sofar.points.length;
        } else if (sofar) msg.random = sofar;
        post(msg);
      };
      try {
        post({ type: 'done', id: m.id, result: await runJob(m.job, bench, { onProgress, pause: free }) });
      } catch (e) {
        post(failure(m.id, e));
      }
    }
  };
}
