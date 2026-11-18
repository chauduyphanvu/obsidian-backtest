// The main thread's side of the background workers. There are two, each taking its jobs in turn: one for single
// backtests (a block, a slider, a scan), so these never wait behind a sweep, and one for sweeps and luck checks. Each
// block's prices are sent to a worker once and dropped when no block uses them, every job has a time budget, and the
// same jobs run on the main thread instead when no worker can start. At the end, `BlockDrawing` holds what one drawing
// of a block runs with.

import type { Backtest } from './backtest.ts';
import type { DataDeps } from './data.ts';
import { parseSpec, type Defaults, type ParseResult, type Spec } from './dsl.ts';
import { benchWith, jobOverrides, runBlock, runJob, stoppedResult, withInputs, type Bench, type Block, type FromWorker, type Job, type JobOf, type Kind, type Ran, type Results, type Sofar, type ToWorker } from './jobs.ts';
import { LIMITS, LimitError, runSize, sizeRefusal, timeMessage, type RunSize } from './limits.ts';
import { lookbackBars, Runner, type RunOutput } from './runner.ts';
import { pause, type Parse } from './sweep.ts';
import { computeTriggers, type TriggerReport, type TriggerRun } from './trigger.ts';
import type { Bars } from './types.ts';

/** The worker's bundled code, put in by esbuild.config.mjs. Read only when a worker starts, so the unit tests never need it. */
declare const WORKER_CODE: string;

/** A worker left idle this long is ended; the next job starts a fresh one and sends it prices again. */
const IDLE_MS = 60_000;
/** A worker that has not said it is ready by then is ended, and its task runs on the main thread. */
const START_MS = 5_000;
/** Slow starts in a row, in one lane, after which workers are taken as unable to start. */
const SLOW_STARTS = 2;

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

/** One backtest of a block's text on prices loaded here. */
export interface RunRequest {
  /** The text, the parser defaults and the parameter values to run it with. */
  block: Block;
  prices: Map<string, Bars>;
  /** For the size limits (limits.ts runSize). */
  size: RunSize;
  /** Work nobody is looking at yet, such as a scan of the vault: it waits for the runs of blocks on screen. */
  background?: boolean;
  /** No size limits, and `LIMITS.anywayMs` to run instead of `LIMITS.runMs`. */
  anyway?: boolean;
}

/** A single run's result, without the strategy and prices (jobs.ts withInputs puts them back). */
export interface RunResult {
  backtest: Ran;
  /** How long the backtest took on the main thread, when it ran there; null when it ran in a worker. */
  hereMs: number | null;
}

/** The trigger prices of a run (trigger.ts), worked out on the prices it ran on. */
export interface TriggersRequest {
  spec: Spec;
  prices: Map<string, Bars>;
  run: TriggerRun;
  /** The run's size: on the main thread, a run too large for it gets no trigger prices. */
  size: RunSize;
  background?: boolean;
}

/** One block's single runs. `close` stops them and lets the workers drop the prices once nobody else uses them. */
export interface BlockRuns {
  /**
   * The result, or null when the runs were closed first. Rejects with a LimitError when the run is too large or takes too
   * long, and otherwise with the run's own error.
   */
  run(req: RunRequest): Promise<RunResult | null>;
  /**
   * The trigger prices of a run, on the same lane as the runs. Null when the runs were closed first, when they would take
   * too long, or when they would run on the main thread for a run larger than its limits; rejects with their own error.
   */
  triggers(req: TriggersRequest): Promise<TriggerReport | null>;
  close(): void;
}

export interface JobClient {
  forBlock(input: JobInput): BlockJobs;
  runs(): BlockRuns;
  /** True once no worker could start, so everything runs on the main thread. */
  foreground(): boolean;
  shutdown(): void;
}

interface Lane {
  worker: WorkerPort | null;
  ready: boolean;
  startTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** The blocks whose prices this lane's worker holds. */
  sent: Set<number>;
  queue: Task[];
  current: Task | null;
  /** Workers in a row that did not say they were ready in time. */
  slowStarts: number;
}

interface Common {
  id: number;
  lane: Lane;
  /** The block's prices, and the id they have in the workers. */
  prices: Map<string, Bars>;
  data: number;
  /** Lower goes first; equal ones go in the order asked. */
  priority: number;
  /** Running on the main thread rather than in a worker. */
  here: boolean;
  stopped: boolean;
  settled: boolean;
  /** How long its worker may go without a word before the task is ended. */
  budgetMs: number;
  watchdog?: ReturnType<typeof setTimeout>;
  /** The open tasks of whoever asked, this one among them until it settles. */
  mine: Set<Task>;
}

interface JobTask extends Common {
  type: 'job';
  input: JobInput;
  job: Job;
  opts: RunOptions;
  sofar: Sofar;
  waited: boolean;
  /** The section's benches on the main thread, by the values they run with. */
  benches: Map<string, Bench>;
  resolve: (r: Results[Kind] | null) => void;
  reject: (e: Error) => void;
}

interface RunTask extends Common {
  type: 'run';
  block: Block;
  size: RunSize;
  anyway: boolean;
  resolve: (r: RunResult | null) => void;
  reject: (e: Error) => void;
}

interface TriggersTask extends Common {
  type: 'triggers';
  spec: Spec;
  run: TriggerRun;
  size: RunSize;
  resolve: (r: TriggerReport | null) => void;
  reject: (e: Error) => void;
}

type Task = JobTask | RunTask | TriggersTask;

const BACKGROUND = 1;

/**
 * Jobs run one at a time in each of two workers. Single runs go to one, by priority and then in the order asked; sweeps
 * and luck checks go to the other, in the order asked. Stopping a running job ends its worker at once, so stopping never
 * waits for a long step to finish, and so does a job that goes past its time budget; the jobs still queued then go to a
 * fresh worker, which is sent their prices again.
 */
export function createJobClient(opts: { makeWorker: MakeWorker; idleMs?: number; startMs?: number }): JobClient {
  const idleMs = opts.idleMs ?? IDLE_MS;
  const startMs = opts.startMs ?? START_MS;
  const lane = (): Lane => ({ worker: null, ready: false, sent: new Set(), queue: [], current: null, slowStarts: 0 });
  const short = lane();
  const long = lane();
  /** Set for good once a worker fails to start: every job then runs here. */
  let noWorker = false;
  const ids = new WeakMap<Map<string, Bars>, number>();
  /** Sections and blocks using each block's prices. */
  const users = new Map<number, number>();
  let lastData = 0;
  let lastTask = 0;

  const idOf = (prices: Map<string, Bars>): number => {
    let id = ids.get(prices);
    if (id === undefined) ids.set(prices, (id = ++lastData));
    return id;
  };
  const use = (id: number) => users.set(id, (users.get(id) ?? 0) + 1);
  const release = (id: number) => {
    const left = users.get(id)! - 1;
    if (left > 0) {
      users.set(id, left);
      return;
    }
    users.delete(id);
    for (const l of [short, long]) if (l.sent.delete(id)) l.worker?.post({ type: 'drop', id });
  };

  /** The values a section's job runs with: the same here and in the worker. */
  const overridesOf = (task: JobTask) => jobOverrides(task.job.kind, task.input.backtest.spec);
  const benchOf = (task: JobTask): Bench => {
    const overrides = overridesOf(task);
    const key = JSON.stringify(overrides);
    let bench = task.benches.get(key);
    if (!bench) task.benches.set(key, (bench = benchWith(task.input.source, task.input.parse, task.input.backtest.data, overrides)));
    return bench;
  };
  const stoppedOf = (task: Task) => (task.type === 'job' ? stoppedResult(task.job.kind, benchOf(task), task.sofar) : null);

  function settle(task: Task, result: unknown, error?: Error): void {
    if (task.settled) return;
    task.settled = true;
    clearTimeout(task.watchdog);
    task.mine.delete(task);
    if (error) task.reject(error);
    else (task.resolve as (r: unknown) => void)(result);
  }

  function kill(l: Lane): void {
    clearTimeout(l.startTimer);
    clearTimeout(l.idleTimer);
    l.worker?.terminate();
    l.worker = null;
    l.ready = false;
    l.sent.clear();
  }

  function next(l: Lane): void {
    l.current = null;
    pump(l);
  }

  function enqueue(task: Task): void {
    const { queue } = task.lane;
    const at = queue.findIndex((q) => q.priority > task.priority);
    if (at < 0) queue.push(task);
    else queue.splice(at, 0, task);
  }

  /** Settles a single run that is too large for where it would run, or trigger prices of one too large for the main thread; true when it did. */
  function refused(task: Task, where: 'worker' | 'here'): boolean {
    if (task.type === 'triggers') {
      if (where === 'worker' || sizeRefusal(task.size, 'here') === null) return false;
      settle(task, null);
      return true;
    }
    if (task.type !== 'run' || task.anyway) return false;
    const why = sizeRefusal(task.size, where);
    if (why === null) return false;
    settle(task, null, new LimitError('size', why, true));
    return true;
  }

  function pump(l: Lane): void {
    while (!l.current) {
      clearTimeout(l.idleTimer);
      const task = l.queue.shift();
      if (!task) {
        if (l.worker) l.idleTimer = setTimeout(() => kill(l), idleMs);
        return;
      }
      let there = (task.type !== 'job' || task.input.defaults !== undefined) && !noWorker;
      if (refused(task, there ? 'worker' : 'here')) continue;
      if (there && !start(l)) {
        there = false;
        if (refused(task, 'here')) continue;
      }
      l.current = task;
      if (task.type === 'job' && task.waited) task.opts.onWait?.(false);
      if (there) runThere(task);
      else runHere(task);
    }
  }

  /** Makes sure the lane has a worker, unless none can start. */
  function start(l: Lane): boolean {
    if (l.worker) return true;
    if (noWorker) return false;
    try {
      const me: WorkerPort = opts.makeWorker({
        message: (m) => {
          if (l.worker === me) onMessage(l, m);
        },
        error: (message) => {
          if (l.worker === me) onError(l, message);
        },
      });
      l.worker = me;
    } catch {
      noWorker = true;
      return false;
    }
    l.ready = false;
    l.startTimer = setTimeout(() => onSlowStart(l), startMs);
    return true;
  }

  /** (Re)starts the task's clock: it is ended when its worker says nothing for its budget. */
  function arm(task: Task): void {
    clearTimeout(task.watchdog);
    task.watchdog = setTimeout(() => expire(task), task.budgetMs);
  }

  function expire(task: Task): void {
    const l = task.lane;
    if (l.current !== task || task.settled) return;
    kill(l);
    // Trigger prices only add to a result, so going past their time leaves them out rather than failing anything.
    if (task.type === 'triggers') settle(task, null);
    else settle(task, null, new LimitError('time', timeMessage(task.budgetMs, task.type === 'run' ? task.size : null), task.type === 'run' && !task.anyway));
    next(l);
  }

  function runThere(task: Task): void {
    const l = task.lane;
    const w = l.worker!;
    if (!l.sent.has(task.data)) {
      w.post({ type: 'data', id: task.data, data: task.prices });
      l.sent.add(task.data);
    }
    if (task.type === 'run') w.post({ type: 'run', id: task.id, data: task.data, block: task.block });
    else if (task.type === 'triggers') w.post({ type: 'triggers', id: task.id, data: task.data, spec: task.spec, run: task.run });
    else w.post({ type: 'job', id: task.id, data: task.data, block: { source: task.input.source, defaults: task.input.defaults!, overrides: overridesOf(task) }, job: task.job });
    arm(task);
  }

  function runHere(task: Task): void {
    task.here = true;
    // Nothing can stop it here, so no clock either: the size limits keep it short.
    clearTimeout(task.watchdog);
    const l = task.lane;
    let work: () => Promise<unknown>;
    if (task.type === 'run') {
      work = async () => {
        if (task.stopped) return null;
        const started = performance.now();
        const backtest = runBlock(task.block, task.prices);
        return { backtest, hereMs: performance.now() - started } satisfies RunResult;
      };
    } else if (task.type === 'triggers') {
      work = async () => (task.stopped ? null : computeTriggers(task.spec, task.prices, task.run));
    } else {
      const bench = benchOf(task);
      work = () =>
        task.stopped
          ? Promise.resolve(stoppedResult(task.job.kind, bench, task.sofar))
          : runJob(task.job, bench, {
              onProgress: (done, total) => {
                if (!task.stopped) task.opts.onProgress?.(done, total);
              },
              shouldStop: () => task.stopped,
            });
    }
    // A turn later, so the caller paints first and `run` never calls back before it returns.
    pause()
      .then(work)
      .then(
        (r) => settle(task, r),
        (e) => settle(task, null, e instanceof Error ? e : new Error(String(e))),
      )
      .then(() => {
        if (l.current === task) next(l);
      });
  }

  function onMessage(l: Lane, m: FromWorker): void {
    if (m.type === 'ready') {
      l.ready = true;
      l.slowStarts = 0;
      clearTimeout(l.startTimer);
      return;
    }
    const task = l.current;
    if (!task || task.here || m.id !== task.id) return;
    if (m.type === 'progress') {
      if (task.type !== 'job') return;
      arm(task);
      for (const p of m.points ?? []) task.sofar.points.push(p);
      if (m.random) task.sofar.random = m.random;
      task.opts.onProgress?.(m.done, m.total);
      return;
    }
    if (m.type === 'error') settle(task, null, new Error(m.message));
    else if (m.type === 'ran') settle(task, { backtest: m.result, hereMs: null } satisfies RunResult);
    else if (m.type === 'triggered') settle(task, m.result);
    else settle(task, m.result);
    next(l);
  }

  function onError(l: Lane, message: string): void {
    if (!l.ready) {
      // A content-security policy or an old web view: a worker won't start next time either.
      noWorker = true;
      moveHere(l);
      return;
    }
    const task = l.current && !l.current.here ? l.current : null;
    kill(l);
    if (task) {
      settle(task, null, new Error(`The run stopped unexpectedly: ${message}`));
      next(l);
    }
  }

  /** A worker slow to start, as at a busy start-up, may start next time: only a second slow start in a row gives up on workers. */
  function onSlowStart(l: Lane): void {
    if (++l.slowStarts >= SLOW_STARTS) noWorker = true;
    moveHere(l);
  }

  /** Ends a lane's worker that never started, and runs its task on the main thread instead. */
  function moveHere(l: Lane): void {
    const task = l.current && !l.current.here ? l.current : null;
    kill(l);
    if (!task) return;
    if (task.type === 'job') task.sofar = { points: [], random: null };
    if (refused(task, 'here')) next(l);
    else runHere(task);
  }

  function stop(task: Task): void {
    if (task.settled || task.stopped) return;
    task.stopped = true;
    const l = task.lane;
    const at = l.queue.indexOf(task);
    if (at >= 0) {
      l.queue.splice(at, 1);
      settle(task, stoppedOf(task));
    } else if (task === l.current && !task.here) {
      kill(l);
      settle(task, stoppedOf(task));
      next(l);
    }
    // On the main thread a job sees the stop at its next step and returns what it finished; a single run is not started.
  }

  /** Stops tasks, the waiting ones first, so that stopping a running one does not start one of the others. */
  function stopAll(tasks: Iterable<Task>): void {
    const list = [...tasks];
    for (const task of list) if (task.lane.current !== task) stop(task);
    for (const task of list) stop(task);
  }

  /** A promise and the functions that settle it. */
  function deferred<R>() {
    let resolve!: (r: R | null) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<R | null>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function forBlock(input: JobInput): BlockJobs {
    const prices = input.backtest.data;
    const data = idOf(prices);
    use(data);
    const mine = new Set<Task>();
    const benches = new Map<string, Bench>();
    let closed = false;
    return {
      run<K extends Kind>(job: JobOf<K>, o: RunOptions = {}): Running<Results[K]> {
        const { promise, resolve, reject } = deferred<Results[Kind]>();
        const task: JobTask = {
          type: 'job',
          id: ++lastTask,
          lane: long,
          prices,
          data,
          priority: 0,
          here: false,
          stopped: false,
          settled: false,
          budgetMs: LIMITS.stepMs,
          mine,
          input,
          job,
          opts: o,
          sofar: { points: [], random: null },
          waited: false,
          benches,
          resolve,
          reject,
        };
        mine.add(task);
        enqueue(task);
        if (long.current) {
          task.waited = true;
          o.onWait?.(true);
        }
        pump(long);
        return { done: promise as Promise<Results[K] | null>, stop: () => stop(task) };
      },
      close() {
        if (closed) return;
        closed = true;
        stopAll(mine);
        release(data);
      },
    };
  }

  function runs(): BlockRuns {
    const mine = new Set<Task>();
    /** The prices this block's runs last used, held in the workers until it runs on others or closes. */
    let held: number | null = null;
    let closed = false;
    const hold = (prices: Map<string, Bars>): number => {
      const data = idOf(prices);
      if (held !== data) {
        use(data);
        if (held !== null) release(held);
        held = data;
      }
      return data;
    };
    return {
      run(req) {
        if (closed) return Promise.resolve(null);
        const data = hold(req.prices);
        const { promise, resolve, reject } = deferred<RunResult>();
        const task: RunTask = {
          type: 'run',
          id: ++lastTask,
          lane: short,
          prices: req.prices,
          data,
          priority: req.background ? BACKGROUND : 0,
          here: false,
          stopped: false,
          settled: false,
          budgetMs: req.anyway ? LIMITS.anywayMs : LIMITS.runMs,
          mine,
          block: req.block,
          size: req.size,
          anyway: req.anyway ?? false,
          resolve,
          reject,
        };
        mine.add(task);
        enqueue(task);
        pump(short);
        return promise;
      },
      triggers(req) {
        if (closed) return Promise.resolve(null);
        const data = hold(req.prices);
        const { promise, resolve, reject } = deferred<TriggerReport>();
        const task: TriggersTask = {
          type: 'triggers',
          id: ++lastTask,
          lane: short,
          prices: req.prices,
          data,
          priority: req.background ? BACKGROUND : 0,
          here: false,
          stopped: false,
          settled: false,
          budgetMs: LIMITS.runMs,
          mine,
          spec: req.spec,
          run: req.run,
          size: req.size,
          resolve,
          reject,
        };
        mine.add(task);
        enqueue(task);
        pump(short);
        return promise;
      },
      close() {
        if (closed) return;
        closed = true;
        stopAll(mine);
        if (held !== null) release(held);
        held = null;
      },
    };
  }

  return {
    forBlock,
    runs,
    foreground: () => noWorker,
    shutdown() {
      for (const l of [short, long]) {
        stopAll([...l.queue, ...(l.current ? [l.current] : [])]);
        kill(l);
      }
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
const client = () => (shared ??= createJobClient({ makeWorker: blobWorker }));

/** The jobs of one section of a result block. The worker starts with the first job. */
export function blockJobs(input: JobInput): BlockJobs {
  return client().forBlock(input);
}

/** The single runs of one block, or of one scan. The worker starts with the first run. */
export function blockRuns(): BlockRuns {
  return client().runs();
}

/** True once no worker could start, so runs happen on the main thread and cannot be stopped. */
export function runsInForeground(): boolean {
  return shared?.foreground() ?? false;
}

/** Ends the workers and every job, for the plugin's `onunload`. */
export function shutdownWorkers(): void {
  shared?.shutdown();
  shared = null;
}

// ---------------------------------------------------------------- one drawing of a block

/** How long each backtest run on the main thread took, for whether a slider drag may redo it there. */
const hereMs = new WeakMap<Backtest, number>();
/** Results that were run without the size limits because the reader asked for it. Kept here, not on the result, which is shared. */
const ranAnyway = new WeakSet<RunOutput>();

export interface DrawingOptions {
  source: string;
  /** What the plugin's settings imply, read once by whoever draws the block. */
  defaults: Defaults;
  deps: DataDeps;
  freshForMs: number;
  /** The block's runs: drawing it again or its going away stops them. */
  runs: BlockRuns;
  /** Run without the size limits and with the longer time limit (limits.ts). */
  anyway?: boolean;
  /** A scan of the vault, whose runs wait for those of the blocks on screen. */
  background?: boolean;
}

/** What the sliders of a drawing need: redoing the run with other values, whether a drag may do that at every step, and which values read. */
export interface Sliders {
  rerun(values: Record<string, number>, settled: boolean): Promise<RunOutput | null>;
  followsDrag(): boolean;
  accepts(values: Record<string, number>): boolean;
}

export class BlockDrawing {
  readonly source: string;
  readonly defaults: Defaults;
  /** How old saved prices may be for this drawing, and so the prices of a result it reuses. */
  readonly freshForMs: number;
  /** Whether runs have no size limits. A result that was run that way turns it on for whoever shows it again (`follow`). */
  anyway: boolean;
  private runner: Runner;
  private runs: BlockRuns;
  private background: boolean;

  constructor(o: DrawingOptions) {
    this.source = o.source;
    this.defaults = o.defaults;
    this.freshForMs = o.freshForMs;
    this.anyway = o.anyway ?? false;
    this.background = o.background ?? false;
    this.runs = o.runs;
    this.runner = new Runner(o.deps, o.defaults, { freshForMs: o.freshForMs });
  }

  /** The block's text read with these defaults, and `overrides` in place of its parameters' values. */
  parse = (overrides?: Record<string, number>): ParseResult => parseSpec(this.source, { defaults: this.defaults, overrides });

  /** Takes up what a kept result carries: that it was run without the size limits. */
  follow(out: RunOutput): void {
    if (ranAnyway.has(out)) this.anyway = true;
  }

  /**
   * One backtest of the block's text with `overrides`, on prices loaded here. It runs in a background worker, where it can
   * be stopped, or on the main thread when none can start. Null when the runs were closed first; rejects with a
   * LimitError when it is too large or takes too long.
   */
  async backtest(spec: Spec, data: RunOutput['data'], overrides: Record<string, number> = {}): Promise<Backtest | null> {
    const ran = await this.runs.run({
      block: { source: this.source, defaults: this.defaults, overrides },
      prices: data,
      size: runSize(spec, data),
      background: this.background,
      anyway: this.anyway,
    });
    if (!ran) return null;
    const backtest = withInputs(ran.backtest, spec, data);
    if (ran.hereMs !== null) hereMs.set(backtest, ran.hereMs);
    return backtest;
  }

  /** Loads the prices of `spec`, the block's text read with `overrides`, and runs it. Null when the runs were closed first. */
  async run(spec: Spec, o: { force?: boolean; overrides?: Record<string, number> } = {}): Promise<RunOutput | null> {
    const { data, warnings, prices } = await this.runner.loadPrices(spec, o.force ?? false);
    const backtest = await this.backtest(spec, data, o.overrides);
    if (!backtest) return null;
    const out = { spec, backtest, data, warnings, prices };
    if (this.anyway) ranAnyway.add(out);
    return out;
  }

  /**
   * The sliders of the result `first`, the block as written. Other parameter values run on the prices already loaded; ones
   * that need more history than that fetch it only once the slider is released, since a drag passes through many values and
   * each would start its own download.
   */
  sliders(first: RunOutput): Sliders {
    let lastMs = hereMs.get(first.backtest) ?? Infinity;
    return {
      rerun: async (values, settled) => {
        const parsed = this.parse(values);
        if (!parsed.spec) throw new Error(`Line ${parsed.errors[0].line}: ${parsed.errors[0].message}`);
        let next: RunOutput | null;
        if (lookbackBars(parsed.spec) <= lookbackBars(first.spec)) {
          const backtest = await this.backtest(parsed.spec, first.data, values);
          next = backtest && { ...first, spec: parsed.spec, backtest };
        } else if (settled) next = await this.run(parsed.spec, { overrides: values });
        else return null;
        if (next) lastMs = hereMs.get(next.backtest) ?? lastMs;
        return next;
      },
      // Where runs happen on the main thread, a drag redoes only a block that runs within a frame.
      followsDrag: () => !runsInForeground() || lastMs <= LIMITS.dragMs,
      accepts: (values) => this.parse(values).spec !== null,
    };
  }
}
