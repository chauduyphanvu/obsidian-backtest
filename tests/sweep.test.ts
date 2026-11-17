import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Stats } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { makeRng } from '../src/rng.ts';
import { grid, runSweep, splitSummary, summarize, sweepLimit, sweepParams, sweepSize, type SweepParam, type SweepPoint, type SweepResult } from '../src/sweep.ts';
import type { Bars } from '../src/types.ts';
import { bars, near, DAY } from './helpers.ts';

const spec = (src: string) => {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  return spec!;
};

/** Daily bars over calendar days from `from` to `to`, each close the last times `growth(day)`. */
function daily(from: string, to: string, growth: (d: Date) => number): Bars {
  const closes: number[] = [];
  const times: number[] = [];
  let c = 100;
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY) {
    if (times.length) c *= growth(new Date(t));
    closes.push(c);
    times.push(t);
  }
  return bars(closes, { times });
}

test('the grid steps through each range, adds a declared value that is off the steps, and changes the last parameter fastest', () => {
  const s = spec('universe: A\nfast = 25 in 20..40 step 10\nslow = 5 in 4..6\nlag = 1\nbuy when sma(fast) > sma(slow) and close > close[lag]');
  const params = sweepParams(s);
  assert.deepEqual(params, [
    { name: 'fast', percent: false, values: [20, 25, 30, 40], declared: 25 },
    { name: 'slow', percent: false, values: [4, 5, 6], declared: 5 },
  ]);
  assert.equal(sweepSize(s), 12);
  assert.deepEqual([...grid(params)].slice(0, 4), [[0, 0], [0, 1], [0, 2], [1, 0]]);
  assert.equal([...grid(params)].length, 12);
  // Percentages are fractions, rounded so the steps read cleanly.
  assert.deepEqual(sweepParams(spec('universe: A\nstop = 8% in 4%..12% step 2%\nstop loss: stop\nbuy when true'))[0].values, [0.04, 0.06, 0.08, 0.1, 0.12]);
  assert.equal(sweepSize(spec('universe: A\nn = 5\nbuy when close > sma(n)')), 1);
});

test('a sweep above the limit is refused with a clear message', async () => {
  assert.equal(sweepLimit(2000), null);
  assert.match(sweepLimit(2001)!, /2,001 variants.*the most this runs at once is 2,000/);
  const src = 'universe: A\nfast = 25 in 20..40 step 10\nslow = 5 in 4..6\nbuy when sma(fast) > sma(slow)';
  await assert.rejects(runSweep(src, new Map([['A', bars([1, 2, 3])]]), { maxRuns: 10 }), /12 variants.*most this runs at once is 10/);
});

test('a variant that fails to parse is recorded with its error, and the others run', async () => {
  const A = bars(Array.from({ length: 30 }, (_, i) => 100 + i));
  const progress: number[] = [];
  const r = await runSweep('universe: A\nn = 2 in 0..2\nbuy when close > sma(n)', new Map([['A', A]]), { onProgress: (done, total) => progress.push(done * 10 + total) });
  assert.deepEqual(r.points.map((p) => [p.values.n, p.error === null]), [[0, false], [1, true], [2, true]]);
  assert.match(r.points[0].error!, /sma\(\): 0 is not a valid period/);
  assert.equal(r.points[0].stats, null);
  assert.ok(r.points[1].stats && r.points[2].trades === 1);
  assert.deepEqual(progress, [13, 23, 33]);
  assert.deepEqual([r.tried, r.total, r.stopped], [3, 3, false]);
});

test('a sweep can be stopped part way', async () => {
  const A = bars(Array.from({ length: 30 }, (_, i) => 100 + i));
  let done = 0;
  const r = await runSweep('universe: A\nn = 2 in 1..10\nbuy when close > sma(n)', new Map([['A', A]]), { onProgress: (d) => (done = d), shouldStop: () => done >= 4 });
  assert.deepEqual([r.tried, r.total, r.stopped, r.points.length], [4, 10, true, 4]);
});

test('each variant matches a backtest run with those values', async () => {
  const A = daily('2020-01-01', '2020-12-31', (d) => 1 + 0.01 * Math.sin(d.getTime() / DAY / 7));
  const src = 'universe: A\nn = 10 in 5..15 step 5\nbuy when close > sma(n)\nsell when close < sma(n)';
  const r = await runSweep(src, new Map([['A', A]]));
  for (const p of r.points) {
    const direct = runBacktest(parseSpec(src, { overrides: p.values }).spec!, new Map([['A', A]]));
    assert.deepEqual(p.stats, direct.stats);
    assert.equal(p.trades, direct.run.trades.length);
  }
});

const stats = (cagr: number): Stats => ({ totalReturn: cagr, cagr, maxDrawdown: -0.1, volatility: 0.1, sharpe: cagr * 2, sortino: cagr * 3, exposure: 1 });

/** A finished sweep over hand-picked results, laid out on the grid in order. */
function result(params: SweepParam[], cagrs: (number | null)[]): SweepResult {
  const points: SweepPoint[] = [...grid(params)].map((index, k) => ({
    values: Object.fromEntries(params.map((p, d) => [p.name, p.values[index[d]]])),
    index,
    stats: cagrs[k] === null ? null : stats(cagrs[k]!),
    before: null,
    after: null,
    trades: 1,
    error: cagrs[k] === null ? 'broken' : null,
  }));
  return { params, points, tried: points.length, total: points.length, stopped: false };
}

test('summarize: ranks, the median and a lonely spike', () => {
  const one: SweepParam[] = [{ name: 'n', percent: false, values: [1, 2, 3, 4, 5, 6], declared: 2 }];
  const s = summarize(result(one, [0.1, 0.2, 0.5, 0.2, 0.1, null]), 'cagr', { benchmark: stats(0.15) })!;
  assert.equal(s.best.values.n, 3);
  assert.equal(s.declared!.values.n, 2);
  // 0.5 is ahead of it; the other 0.2 ties and shares the rank.
  assert.equal(s.declaredRank, 2);
  assert.ok(near(s.median, 0.2));
  assert.deepEqual([s.failed, s.idle], [1, 0]);
  assert.equal(s.shareBeatingBenchmark, 3 / 5);
  assert.deepEqual(s.ranked.map((p) => p.values.n), [3, 2, 4, 1, 5]);
  // Neighbours 2 and 4 make 0.2. The bottom quarter sits at 0.1, so they keep 1 - 0.3/0.4 of the lead.
  assert.deepEqual(s.neighbours.points.map((p) => p.values.n), [2, 4]);
  assert.ok(near(s.neighbours.median, 0.2) && near(s.neighbours.worst, 0.2));
  assert.ok(near(s.neighbours.kept, 0.25));
  assert.equal(s.neighbours.verdict, 'spike');
});

test('summarize: a plateau on a 2-parameter grid, neighbours across both parameters', () => {
  const two: SweepParam[] = [
    { name: 'a', percent: false, values: [1, 2, 3], declared: 1 },
    { name: 'b', percent: false, values: [10, 20, 30], declared: 30 },
  ];
  // The middle is best; its four neighbours are close, the corners weak.
  const s = summarize(result(two, [0.1, 0.45, 0.1, 0.44, 0.5, 0.46, 0.1, 0.43, 0.1]), 'cagr')!;
  assert.deepEqual(s.best.values, { a: 2, b: 20 });
  assert.deepEqual(s.neighbours.points.map((p) => p.values), [{ a: 1, b: 20 }, { a: 3, b: 20 }, { a: 2, b: 10 }, { a: 2, b: 30 }]);
  assert.ok(near(s.neighbours.median, 0.445));
  assert.ok(near(s.neighbours.worst, 0.43));
  assert.ok(near(s.neighbours.kept, 1 - 0.055 / 0.4));
  assert.equal(s.neighbours.verdict, 'plateau');
  assert.deepEqual(s.declared!.values, { a: 1, b: 30 });
  assert.equal(s.declaredRank, 6);
  // Worst drawdown reads higher (closer to 0) as better too.
  assert.equal(summarize(result(two, [0.1, 0.45, 0.1, 0.44, 0.5, 0.46, 0.1, 0.43, 0.1]), 'maxDrawdown')!.neighbours.verdict, 'flat');
});

test('summarize: a variant that never trades is cash, and is left out of the ranking', () => {
  const one: SweepParam[] = [{ name: 'n', percent: false, values: [1, 2, 3, 4], declared: 4 }];
  const r = result(one, [0.1, 0.2, 0.15, 0.05]);
  // n = 2 sits in cash the whole run: it would otherwise win.
  r.points[1].trades = 0;
  r.points[3].trades = 0;
  const s = summarize(r, 'cagr')!;
  assert.equal(s.best.values.n, 3);
  assert.deepEqual([s.ranked.length, s.idle, s.failed, s.declaredRank], [2, 2, 0, null]);
  assert.deepEqual(s.neighbours.points.map((p) => p.values.n), []);
  assert.equal(s.neighbours.verdict, 'none');
});

test('summarize: nothing to read when no variant ran', () => {
  const one: SweepParam[] = [{ name: 'n', percent: false, values: [1, 2], declared: 1 }];
  assert.equal(summarize(result(one, [null, null]), 'cagr'), null);
  assert.equal(summarize(result(one, [0.1, null]), 'cagr')!.neighbours.verdict, 'none');
});

test('with test from, the pick is made on the part before only, and its later result is reported', async () => {
  // March rises 1% a day in 2015-2016, September 2% a day from 2017: the best month before the
  // split is March, which does nothing after it; over the whole run September wins.
  const A = daily('2015-01-01', '2018-12-31', (d) => {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    return y < 2017 ? (m === 3 ? 1.01 : 1) : m === 9 ? 1.02 : 1;
  });
  const src = 'universe: A\ntest from: 2017-01-01\nm = 6 in 1..12\nbuy when month == m\nsell when month != m';
  const r = await runSweep(src, new Map([['A', A]]));
  assert.equal(r.points.length, 12);
  const all = summarize(r, 'totalReturn')!;
  assert.equal(all.best.values.m, 9);
  const split = splitSummary(r, 'totalReturn')!;
  assert.equal(split.chosen.values.m, 3);
  // Bought at the open of 2 March (the close of 1 March), out at the open of 2 April: 30 rising days a year.
  assert.ok(near(split.chosenBefore, 1.01 ** 60 - 1, 1e-9));
  assert.ok(near(split.chosenAfter, 0));
  // September did better after the split, and so did August, which sells at the open of 2 September
  // and so still holds through 1 September's rise. The other nine tie with March.
  assert.equal(split.chosenAfterRank, 3);
  assert.ok(near(split.declaredBefore, 0) && near(split.declaredAfter, 0));
  assert.ok(near(split.medianAfter, 0));
  assert.equal(split.count, 12);
  // Without the split there is nothing to pick on.
  assert.equal(splitSummary(await runSweep(src.replace('test from: 2017-01-01\n', ''), new Map([['A', A]])), 'totalReturn'), null);
});

test('a 10 by 10 sweep over 4 tickers and 3000 bars takes a few seconds at most', async () => {
  const rng = makeRng(7);
  const data = new Map<string, Bars>();
  for (const name of ['A', 'B', 'C', 'D']) {
    let c = 100;
    data.set(name, bars(Array.from({ length: 3000 }, () => (c *= 1 + (rng.next() - 0.49) * 0.03)), { start: Date.UTC(2010, 0, 1) }));
  }
  const src = 'universe: A 25%, B 25%, C 25%, D 25%\ncosts: 5 bps\nfast = 20 in 10..100 step 10\nslow = 100 in 100..280 step 20\nbuy when sma(fast) > sma(slow)\nsell when sma(fast) < sma(slow)';
  const start = performance.now();
  const r = await runSweep(src, data);
  const ms = performance.now() - start;
  assert.equal(r.points.length, 100);
  assert.ok(r.points.every((p) => p.error === null));
  assert.ok(ms < 5000, `took ${Math.round(ms)} ms`);
});
