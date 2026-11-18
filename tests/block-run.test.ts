import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import type { DataDeps } from '../src/data.ts';
import { serve, type ToWorker } from '../src/jobs.ts';
import { makeRng } from '../src/rng.ts';
import { defaultsFrom, normalizeSettings } from '../src/settings-core.ts';
import { BlockDrawing, createJobClient, type BlockRuns, type MakeWorker, type RunRequest } from '../src/worker-client.ts';
import { DAY, T0 } from './helpers.ts';

const SRC = 'universe: csv:a.csv\nn = 20 in 10..40 step 5\nbuy when close > sma(n)\nsell when close < sma(n)';

function prices(): string {
  const rng = makeRng(7);
  let c = 100;
  const rows = Array.from({ length: 700 }, (_, i) => {
    const o = c;
    c *= 1 + (rng.next() - 0.48) * 0.03;
    return `${new Date(T0 + i * DAY).toISOString().slice(0, 10)},${o},${Math.max(o, c)},${Math.min(o, c)},${c}`;
  });
  return ['date,open,high,low,close', ...rows].join('\n');
}

function deps(files: Record<string, string>): DataDeps {
  return {
    fetchText: () => Promise.reject(new Error('no network in tests')),
    readVaultFile: async (path) => files[path] ?? null,
    cacheRead: async () => null,
    cacheWrite: async () => {},
    now: () => T0 + 800 * DAY,
  };
}

/** A worker in this process: the real message handler, answering a turn after it is asked. */
const inProcess: MakeWorker = (on) => {
  const handle = serve((m) => on.message(structuredClone(m)), 0);
  setTimeout(() => on.message({ type: 'ready' }));
  return { post: (m: ToWorker) => void setTimeout(() => void handle(structuredClone(m))), terminate: () => {} };
};
const noWorker: MakeWorker = () => {
  throw new Error('Workers are not allowed here');
};

function drawn(t: TestContext, make: MakeWorker, settings: ReturnType<typeof normalizeSettings>, more: { anyway?: boolean } = {}) {
  const client = createJobClient({ makeWorker: make });
  t.after(() => client.shutdown());
  const runs = client.runs();
  // As the plugin draws a block: the defaults are read from the settings once, here.
  const drawing = new BlockDrawing({ source: SRC, defaults: defaultsFrom(settings), deps: deps({ 'a.csv': prices() }), freshForMs: 6 * 3_600_000, runs, ...more });
  return { drawing, runs };
}

test('a block\'s slider runs use the defaults it was drawn with, so the result agrees with its own spec however the settings change after', async (t) => {
  for (const [label, make] of [['worker', inProcess], ['here', noWorker]] as const) {
    const settings = normalizeSettings({ capital: 10_000 });
    const { drawing, runs } = drawn(t, make, settings);
    const { spec } = drawing.parse();
    const first = (await drawing.run(spec!))!;
    assert.equal(first.spec.capital, 10_000);
    // The reader changes the settings that shape a result, and drags a slider on the block that is still on screen.
    settings.capital = 50_000;
    settings.commission = '5';
    settings.costs = '25 bps';
    settings.cashRate = 'BIL';
    const rerun = drawing.sliders(first);
    const next = (await rerun.rerun({ n: 25 }, true))!;
    assert.equal(next.spec.capital, 10_000, label);
    assert.ok(!next.spec.commission, label);
    assert.equal(next.spec.costBps, 0, label);
    // Its figures are those of its own spec, on its own prices.
    assert.deepStrictEqual(next.backtest.run, runBacktest(next.spec, next.data).run, label);
    assert.equal(next.backtest.run.commission ?? 0, 0, label);
    assert.ok(next.backtest.run.trades.length > 0, label);
    // The luck checks and the sweep are given what the drawing parsed with.
    assert.deepStrictEqual(drawing.defaults, defaultsFrom(normalizeSettings({ capital: 10_000 })));
    assert.deepStrictEqual(drawing.parse({ n: 25 }).spec, next.spec);
    assert.equal(rerun.accepts({ n: 25 }), true);
    runs.close();
  }
});

test('a block drawn after the settings changed uses the new ones, and keeps them through its own slider runs', async (t) => {
  const settings = normalizeSettings({ capital: 10_000 });
  const old = drawn(t, inProcess, settings);
  settings.capital = 50_000;
  settings.commission = '5';
  const { drawing } = drawn(t, inProcess, settings);
  const first = (await drawing.run(drawing.parse().spec!))!;
  const next = (await drawing.sliders(first).rerun({ n: 25 }, true))!;
  assert.equal(first.spec.capital, 50_000);
  assert.equal(next.spec.capital, 50_000);
  assert.deepEqual(next.spec.commission, { k: 'order', fee: 5 });
  assert.ok(next.backtest.run.commission! > 0);
  assert.deepStrictEqual(next.backtest.run, runBacktest(next.spec, next.data).run);
  assert.equal(old.drawing.defaults.capital, 10_000);
});

/** Runs that record what they are asked and answer nothing. */
function recording(): { runs: BlockRuns; asked: RunRequest[] } {
  const asked: RunRequest[] = [];
  return { asked, runs: { run: (req) => (asked.push(req), Promise.resolve(null)), triggers: () => Promise.resolve(null), close: () => {}, isClosed: () => false } };
}

test('a result run with "Run it anyway" keeps that with it: the sliders of a block drawn again from the kept result are not refused', async (t) => {
  const settings = normalizeSettings(null);
  const files = deps({ 'a.csv': prices() });
  const make = (anyway: boolean, runs: BlockRuns) => new BlockDrawing({ source: SRC, defaults: defaultsFrom(settings), deps: files, freshForMs: 1, runs, anyway });
  const client = createJobClient({ makeWorker: inProcess });
  t.after(() => client.shutdown());
  const ranAnyway = make(true, client.runs());
  const big = (await ranAnyway.run(ranAnyway.parse().spec!))!;
  const plain = make(false, client.runs());
  const small = (await plain.run(plain.parse().spec!))!;

  // The result is shown again from the kept results by a block that has no say in it.
  const again = recording();
  const drawing = make(false, again.runs);
  assert.equal(drawing.anyway, false);
  drawing.follow(big);
  assert.equal(drawing.anyway, true);
  await drawing.sliders(big).rerun({ n: 25 }, true);
  assert.equal(again.asked[0].anyway, true);
  // The request carries the drawing's defaults and the values asked for.
  assert.deepStrictEqual(again.asked[0].block.defaults, defaultsFrom(settings));
  assert.deepStrictEqual(again.asked[0].block.overrides, { n: 25 });

  // A result that was not run that way does not turn it on, and nothing is written into the shared result.
  const other = recording();
  const ordinary = make(false, other.runs);
  ordinary.follow(small);
  await ordinary.sliders(small).rerun({ n: 25 }, true);
  assert.equal(other.asked[0].anyway, false);
  assert.ok(!('anyway' in big) && !('anyway' in small));
});
