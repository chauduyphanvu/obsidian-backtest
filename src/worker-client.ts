// The main thread's side of the worker that runs sweeps and luck checks: one shared worker taking jobs in turn, each
// block's prices sent to it once, and the same jobs run on the main thread instead when no worker can start.

import type { Backtest } from './backtest.ts';
import type { Defaults } from './dsl.ts';
import { benchWith, jobOverrides, runJob, stoppedResult, type Bench, type FromWorker, type Job, type JobOf, type Kind, type Results, type Sofar, type ToWorker } from './jobs.ts';
import { pause, type Parse } from './sweep.ts';
import type { Bars } from './types.ts';

/** The worker's bundled code, put in by esbuild.config.mjs. Read only when a worker starts, so the unit tests never need it. */
declare const WORKER_CODE: string;

/** A worker left idle this long is ended; the next job starts a fresh one and sends it prices again. */
const IDLE_MS = 60_000;
/** A worker that has not said it is ready by then is taken as unable to start. */
const START_MS = 5_000;

export interface WorkerPort {
  post(m: ToWorker): void;
  terminate(): void;
}

/** Starts a worker that reports to `on`. Throws when none can be made. */
export type MakeWorker = (on: { message: (m: FromWorker) => void; error: (message: string) => void }) => WorkerPort;

/**
 * What a section knows of its block (a `SweepInput` fits): its text, how to parse it, and the run on screen, whose prices
 * the jobs use and whose parameter values the luck checks use (jobOverrides). Without `defaults` the text can't be parsed
 * elsewhere, so its jobs run here.
 */
export interface JobInput {
  source: string;
  defaults?: Partial<Defaults>;
  parse: Parse;
  backtest: Backtest;
}

export interface RunOptions {
  onProgress?: (done: number, total: number) => void;
  /** True when the job has to wait for another block's job, false when it then starts. */
  onWait?: (waiting: boolean) => void;
}

export interface Running<R> {
  /** The result. A stopped job gives what it had finished, or null when there is nothing to show. */
  done: Promise<R | null>;
  stop(): void;
}

/** One section's jobs. `close` stops them, and the worker forgets the block's prices once no section uses them. */
export interface BlockJobs {
  run<K extends Kind>(job: JobOf<K>, opts?: RunOptions): Running<Results[K]>;
  close(): void;
}

export interface JobClient {
  forBlock(input: JobInput): BlockJobs;
  shutdown(): void;
}

interface Task {
  id: number;
  /** The block's prices, by the id they have in the worker. */
  data: number;
  input: JobInput;
  job: Job;
  opts: RunOptions;
  sofar: Sofar;
  /** Running on the main thread rather than in the worker. */
  here: boolean;
  waited: boolean;
  stopped: boolean;
  settled: boolean;
  resolve: (r: Results[Kind] | null) => void;
  reject: (e: Error) => void;
  /** The section's open tasks, this one among them until it settles. */
  mine: Set<Task>;
  /** The section's benches on the main thread, by the values they run with. */
  benches: Map<string, Bench>;
}

/**
 * Jobs run one at a time in a single worker, in the order asked. Several sections can ask at once; the later ones
 * wait. Stopping a running job ends the worker at once, so stopping never waits for a long step to finish.
 */
export function createJobClient(opts: { makeWorker: MakeWorker; idleMs?: number; startMs?: number }): JobClient {
  const idleMs = opts.idleMs ?? IDLE_MS;
  const startMs = opts.startMs ?? START_MS;
  let worker: WorkerPort | null = null;
  let ready = false;
  /** Set for good once a worker fails to start: every job then runs here. */
  let noWorker = false;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** The blocks whose prices the current worker holds. */
  const sent = new Set<number>();
  const ids = new WeakMap<Map<string, Bars>, number>();
  /** Sections using each block's prices. */
  const users = new Map<number, number>();
  const queue: Task[] = [];
  let current: Task | null = null;
  let lastData = 0;
  let lastTask = 0;

  /** The values a task runs with: the same here and in the worker. */
  const overridesOf = (task: Task) => jobOverrides(task.job.kind, task.input.backtest.spec);
  const benchOf = (task: Task): Bench => {
    const overrides = overridesOf(task);
    const key = JSON.stringify(overrides);
    let bench = task.benches.get(key);
    if (!bench) task.benches.set(key, (bench = benchWith(task.input.source, task.input.parse, task.input.backtest.data, overrides)));
    return bench;
  };

  function settle(task: Task, result: Results[Kind] | null, error?: Error): void {
    if (task.settled) return;
    task.settled = true;
    task.mine.delete(task);
    if (error) task.reject(error);
    else task.resolve(result);
  }

  function kill(): void {
    clearTimeout(startTimer);
    clearTimeout(idleTimer);
    worker?.terminate();
    worker = null;
    ready = false;
    sent.clear();
  }

  function next(): void {
    current = null;
    pump();
  }

  function pump(): void {
    if (current) return;
    clearTimeout(idleTimer);
    const task = queue.shift();
    if (!task) {
      if (worker) idleTimer = setTimeout(kill, idleMs);
      return;
    }
    current = task;
    if (task.waited) task.opts.onWait?.(false);
    if (task.input.defaults !== undefined && start()) runThere(task);
    else runHere(task);
  }

  /** Makes sure a worker is there, unless none can start. */
  function start(): boolean {
    if (worker) return true;
    if (noWorker) return false;
    try {
      const me: WorkerPort = opts.makeWorker({
        message: (m) => {
          if (worker === me) onMessage(m);
        },
        error: (message) => {
          if (worker === me) onError(message);
        },
      });
      worker = me;
    } catch {
      noWorker = true;
      return false;
    }
    ready = false;
    startTimer = setTimeout(() => onError('The worker did not start'), startMs);
    return true;
  }

  function runThere(task: Task): void {
    const w = worker!;
    if (!sent.has(task.data)) {
      w.post({ type: 'data', id: task.data, data: task.input.backtest.data });
      sent.add(task.data);
    }
    w.post({ type: 'job', id: task.id, data: task.data, block: { source: task.input.source, defaults: task.input.defaults!, overrides: overridesOf(task) }, job: task.job });
  }

  function runHere(task: Task): void {
    task.here = true;
    const bench = benchOf(task);
    // A turn later, so the section paints its progress bar first and `run` never calls back before it returns.
    pause()
      .then(() =>
        task.stopped
          ? stoppedResult(task.job.kind, bench, task.sofar)
          : runJob(task.job, bench, {
              onProgress: (done, total) => {
                if (!task.stopped) task.opts.onProgress?.(done, total);
              },
              shouldStop: () => task.stopped,
            }),
      )
      .then(
        (r) => settle(task, r),
        (e) => settle(task, null, e instanceof Error ? e : new Error(String(e))),
      )
      .then(() => {
        if (current === task) next();
      });
  }

  function onMessage(m: FromWorker): void {
    if (m.type === 'ready') {
      ready = true;
      clearTimeout(startTimer);
      return;
    }
    const task = current;
    if (!task || task.here || m.id !== task.id) return;
    if (m.type === 'progress') {
      for (const p of m.points ?? []) task.sofar.points.push(p);
      if (m.random) task.sofar.random = m.random;
      task.opts.onProgress?.(m.done, m.total);
      return;
    }
    if (m.type === 'done') settle(task, m.result);
    else settle(task, null, new Error(m.message));
    next();
  }

  function onError(message: string): void {
    const task = current && !current.here ? current : null;
    const started = ready;
    kill();
    if (!started) {
      // A content-security policy or an old web view: a worker won't start next time either.
      noWorker = true;
      if (task) {
        task.sofar = { points: [], random: null };
        runHere(task);
      }
      return;
    }
    if (task) {
      settle(task, null, new Error(`The run stopped unexpectedly: ${message}`));
      next();
    }
  }

  function stop(task: Task): void {
    if (task.settled || task.stopped) return;
    task.stopped = true;
    const at = queue.indexOf(task);
    if (at >= 0) {
      queue.splice(at, 1);
      settle(task, stoppedResult(task.job.kind, benchOf(task), task.sofar));
    } else if (task === current && !task.here) {
      kill();
      settle(task, stoppedResult(task.job.kind, benchOf(task), task.sofar));
      next();
    }
    // On the main thread the job sees the stop at its next step and returns what it finished.
  }

  function forBlock(input: JobInput): BlockJobs {
    const data = input.backtest.data;
    let id = ids.get(data);
    if (id === undefined) ids.set(data, (id = ++lastData));
    const dataId = id;
    users.set(dataId, (users.get(dataId) ?? 0) + 1);
    const mine = new Set<Task>();
    const benches = new Map<string, Bench>();
    let closed = false;
    return {
      run<K extends Kind>(job: JobOf<K>, o: RunOptions = {}): Running<Results[K]> {
        let resolve!: Task['resolve'];
        let reject!: Task['reject'];
        const done = new Promise<Results[Kind] | null>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        const task: Task = { id: ++lastTask, data: dataId, input, job, opts: o, sofar: { points: [], random: null }, here: false, waited: false, stopped: false, settled: false, resolve, reject, mine, benches };
        mine.add(task);
        queue.push(task);
        if (current) {
          task.waited = true;
          o.onWait?.(true);
        }
        pump();
        return { done: done as Promise<Results[K] | null>, stop: () => stop(task) };
      },
      close() {
        if (closed) return;
        closed = true;
        for (const task of [...mine]) stop(task);
        const left = users.get(dataId)! - 1;
        if (left > 0) {
          users.set(dataId, left);
          return;
        }
        users.delete(dataId);
        if (sent.delete(dataId)) worker?.post({ type: 'drop', id: dataId });
      },
    };
  }

  return {
    forBlock,
    shutdown() {
      for (const task of [...queue, ...(current ? [current] : [])]) stop(task);
      kill();
    },
  };
}

/** A worker started from the bundled code, as Obsidian loads one main.js and nothing else. */
const blobWorker: MakeWorker = (on) => {
  const url = URL.createObjectURL(new Blob([WORKER_CODE], { type: 'text/javascript' }));
  const revoke = () => URL.revokeObjectURL(url);
  let worker: Worker;
  try {
    worker = new Worker(url);
  } catch (e) {
    revoke();
    throw e;
  }
  // The address is needed only until the worker has loaded its code.
  worker.addEventListener('message', revoke, { once: true });
  worker.addEventListener('error', revoke, { once: true });
  worker.onmessage = (e: MessageEvent<FromWorker>) => on.message(e.data);
  worker.onerror = (e: ErrorEvent) => on.error(e.message || 'The worker could not start');
  return {
    post: (m) => worker.postMessage(m),
    terminate: () => {
      revoke();
      worker.terminate();
    },
  };
};

let shared: JobClient | null = null;

/** The jobs of one section of a result block. The worker starts with the first job. */
export function blockJobs(input: JobInput): BlockJobs {
  return (shared ??= createJobClient({ makeWorker: blobWorker })).forBlock(input);
}

/** Ends the worker and every job, for the plugin's `onunload`. */
export function shutdownWorkers(): void {
  shared?.shutdown();
  shared = null;
}
