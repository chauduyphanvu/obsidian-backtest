import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { bootstrap, matchTurnover, monthOfBars, pickRules, placeHoldings, randomEntries, randomPicks, randomTiming, returnOverDrawdown, walkForward, walkPlan, walkWindows } from '../src/luck.ts';
import { randomTimingWorks, randomVerdict } from '../src/render-luck.ts';
import { makeRng, type Rng } from '../src/rng.ts';
import { quantile } from '../src/sweep.ts';
import type { Bars } from '../src/types.ts';
import { bars, near, DAY } from './helpers.ts';

const YEAR = 365.25 * DAY;

function backtest(src: string, data: Record<string, Bars>): Backtest {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  return runBacktest(spec!, new Map(Object.entries(data)));
}

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

function walk(rng: Rng, n: number, vol = 0.02): Bars {
  let c = 100;
  return bars(Array.from({ length: n }, () => (c *= 1 + (rng.next() - 0.5) * vol)), { start: Date.UTC(2015, 0, 1) });
}

test('the generator repeats itself for a seed and stays in range', () => {
  const a = makeRng(1);
  assert.deepEqual([a.next(), a.next(), a.next()], [0.4256499295588583, 0.79042171058245, 0.6910148127935827]);
  const b = makeRng(1);
  assert.deepEqual([b.int(10), b.int(10), b.int(10)], [4, 7, 6]);
  const c = makeRng(2);
  assert.notEqual(c.next(), 0.4256499295588583);
  const r = makeRng(42);
  let sum = 0;
  for (let i = 0; i < 100_000; i++) {
    const x = r.next();
    assert.ok(x >= 0 && x < 1);
    sum += x;
  }
  assert.ok(Math.abs(sum / 100_000 - 0.5) < 0.005);
});

test('quantiles interpolate between ranks', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.05), 1.2);
  assert.ok(Number.isNaN(quantile([], 0.5)));
});

test('one month of bars, from the spacing of the data', () => {
  const days = Array.from({ length: 366 }, (_, i) => Date.UTC(2020, 0, 1) + i * DAY);
  assert.equal(monthOfBars(days), 30);
  const weekdays = days.filter((t) => new Date(t).getUTCDay() % 6 !== 0);
  assert.equal(monthOfBars(weekdays), 22);
  assert.equal(monthOfBars(days.filter((_, i) => i % 7 === 0)), 4);
});

test('reshuffling a steady series gives the same path every time', () => {
  const t = Array.from({ length: 101 }, (_, i) => Date.UTC(2020, 0, 1) + i * DAY);
  const equity = t.map((_, i) => 100 * 1.001 ** i);
  const r = bootstrap(t, equity, { seed: 5, runs: 200, blockBars: 7 });
  const cagr = 1.001 ** (100 / (100 * DAY / YEAR)) - 1;
  assert.ok(near(r.actual.cagr, cagr, 1e-9));
  for (const v of r.cagr.values) assert.ok(near(v, cagr, 1e-9));
  assert.ok(near(r.cagr.lo, cagr, 1e-9) && near(r.cagr.hi, cagr, 1e-9));
  assert.deepEqual([r.maxDrawdown.lo, r.maxDrawdown.hi, r.lossShare, r.blockBars, r.runs], [0, 0, 0, 7, 200]);
});

test('reshuffling a three-step series: one-step blocks draw any sequence, whole-run blocks only rotate it', () => {
  // Steps of -10%, +50% and -20%.
  const t = [0, 1, 2, 3].map((i) => Date.UTC(2020, 0, 1) + i * 122 * DAY);
  const equity = [1, 0.9, 1.35, 1.08];
  const years = (t[3] - t[0]) / YEAR;
  const g = [0.9, 1.5, 0.8];
  const finals = new Set<string>();
  const dds = new Set<string>();
  for (const a of g) {
    for (const b of g) {
      for (const c of g) {
        finals.add((a * b * c).toFixed(9));
        let v = 1;
        let peak = 1;
        let dd = 0;
        for (const x of [a, b, c]) {
          v *= x;
          peak = Math.max(peak, v);
          dd = Math.min(dd, v / peak - 1);
        }
        dds.add(dd.toFixed(9));
      }
    }
  }
  const one = bootstrap(t, equity, { seed: 3, runs: 500, blockBars: 1 });
  const seenFinals = new Set(one.cagr.values.map((c) => ((1 + c) ** years).toFixed(9)));
  assert.deepEqual([...seenFinals].sort(), [...finals].sort());
  for (const d of one.maxDrawdown.values) assert.ok(dds.has(d.toFixed(9)));
  assert.equal(one.lossShare, one.cagr.values.filter((c) => c < 0).length / 500);

  // A block as long as the run starts anywhere and wraps: always the same three steps, so the same end.
  const whole = bootstrap(t, equity, { seed: 3, runs: 300, blockBars: 3 });
  for (const c of whole.cagr.values) assert.ok(near((1 + c) ** years, 1.08, 1e-9));
  assert.equal(whole.lossShare, 0);
  // -10% then +50% then -20% falls 20% from the high; +50%, -20%, -10% and -20%, -10%, +50% fall 28%.
  assert.deepEqual([...new Set(whole.maxDrawdown.values.map((d) => d.toFixed(9)))].sort(), ['-0.200000000', '-0.280000000']);
  assert.ok(near(whole.actual.maxDrawdown, -0.2));
});

test('holdings are placed without overlap, inside the bars, with the lengths kept', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const rng = makeRng(seed);
    const lengths = [5, 1, 3, 0, 8];
    const placed = placeHoldings(lengths, 10, 40, rng);
    assert.deepEqual(placed.map((h) => h.exit - h.entry).sort((a, b) => a - b), [1, 1, 3, 5, 8]);
    assert.ok(placed[0].entry >= 10 && placed[placed.length - 1].exit <= 40);
    for (let k = 1; k < placed.length; k++) assert.ok(placed[k].entry > placed[k - 1].exit);
  }
  // Exactly enough room leaves one arrangement per order: packed end to end.
  const packed = placeHoldings([2, 2], 0, 5, makeRng(9));
  assert.deepEqual(packed, [{ entry: 0, exit: 2 }, { entry: 3, exit: 5 }]);
  // One bar short: the longest holding gives a bar back. With nothing left to give, it refuses.
  assert.deepEqual(placeHoldings([3, 3], 0, 6, makeRng(1)).map((h) => h.exit - h.entry).sort(), [2, 3]);
  assert.throws(() => placeHoldings([1, 1], 0, 2, makeRng(1)), /do not fit/);
});

test('random timing keeps each ticker\'s trade count and holding lengths, never overlaps and never goes above 100% invested', () => {
  const rng = makeRng(11);
  const bt = backtest('universe: A 60%, B 40%\ncosts: 10 bps\nslippage: 5 bps\nstop loss: 2%\nbuy when close > sma(5)\nsell when close < sma(5)', { A: walk(rng, 400, 0.08), B: walk(rng, 400, 0.08) });
  const lengths = (trades: { asset: string; bars: number }[], name: string) =>
    trades.filter((t) => t.asset === name).map((t) => Math.max(1, t.bars)).sort((a, b) => a - b);
  assert.ok(bt.run.trades.length > 20 && bt.run.trades.some((t) => t.reason === 'stop loss'));
  for (let seed = 1; seed <= 10; seed++) {
    const v = randomTiming(bt, makeRng(seed));
    for (const name of ['A', 'B']) {
      assert.deepEqual(lengths(v.run.trades, name), lengths(bt.run.trades, name));
      const mine = v.run.trades.filter((t) => t.asset === name);
      for (let k = 1; k < mine.length; k++) assert.ok(mine[k].entryT > mine[k - 1].exitT);
    }
    assert.ok(v.run.trades.every((t) => t.reason === 'signal'));
    assert.ok(v.run.exposure.every((x) => x <= 1 + 1e-12));
    assert.deepEqual(v.run.t, bt.run.t);
  }
});

test('random timing on a fill: close strategy keeps each holding\'s length and fills at closes', () => {
  const rng = makeRng(11);
  const data: Record<string, Bars> = { A: walk(rng, 400, 0.08), B: walk(rng, 400, 0.08) };
  const bt = backtest('universe: A 60%, B 40%\nfill: close\nstop loss: 2%\nbuy when close > sma(5)\nsell when close < sma(5)', data);
  const lengths = (trades: { asset: string; bars: number }[], name: string) => trades.filter((t) => t.asset === name).map((t) => Math.max(1, t.bars)).sort((a, b) => a - b);
  assert.ok(bt.run.trades.length > 20 && bt.run.trades.some((t) => t.reason === 'stop loss'));
  for (let seed = 1; seed <= 10; seed++) {
    const v = randomTiming(bt, makeRng(seed));
    for (const name of ['A', 'B']) assert.deepEqual(lengths(v.run.trades, name), lengths(bt.run.trades, name));
    assert.ok(v.run.trades.length > 0 && v.run.trades.every((t) => t.reason === 'signal'));
    // The rule's own fills are at closes, so the placed ones are too: the price is the close of the bar it filled on.
    for (const t of v.run.trades) {
      const b = data[t.asset];
      assert.equal(t.entryPrice, b.c[b.t.indexOf(t.entryT)]);
      assert.equal(t.exitPrice, b.c[b.t.indexOf(t.exitT)]);
    }
  }
});

test('random picks for a ranking: only tickers its rules allow, on its decision bars, no more at once than it holds, about as many trades', async () => {
  const rng = makeRng(4);
  const data = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((n) => [n, walk(rng, 700)]));
  const bt = backtest('universe: A, B, C, D, E\nrebalance: monthly\ncosts: 5 bps\nhold: top 2 by roc(20)\nbuy when close > sma(50)', data);
  assert.ok(bt.run.trades.length > 10);
  const rules = pickRules(bt);
  const redraw = await matchTurnover(bt, rules, 1);
  let trades = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const run = randomPicks(bt, makeRng(seed), redraw, rules);
    trades += run.trades.length;
    assert.deepEqual(run.t, bt.run.t);
    assert.ok(run.exposure.every((x) => x <= 1 + 1e-12));
    for (const t of bt.run.t) assert.ok(run.trades.filter((tr) => tr.entryT <= t && (t < tr.exitT || tr.reason === 'open')).length <= 2);
    for (const tr of run.trades) {
      // Bought at the first open of a month, after close > sma(50) at the month's last close.
      assert.equal(new Date(tr.entryT).getUTCDate(), 1);
      const b = data[tr.asset];
      const i = b.t.indexOf(tr.entryT) - 1;
      const sma = b.c.slice(i - 49, i + 1).reduce((s, x) => s + x, 0) / 50;
      assert.ok(b.c[i] > sma);
    }
  }
  const ratio = trades / 10 / bt.run.trades.length;
  assert.ok(ratio > 0.6 && ratio < 1.6, `random picks traded ${ratio.toFixed(2)} times as often`);
  // A score drawn afresh every bar trades far more than one that sticks.
  assert.ok(randomPicks(bt, makeRng(1), 1, rules).trades.length > randomPicks(bt, makeRng(1), 0.003, rules).trades.length);
  const r = await randomEntries(bt, { seed: 1, runs: 20 });
  assert.deepEqual([r.mode, r.redraw, r.runs], ['picks', redraw, 20]);
});

test('random entries: an informative rule beats nearly every random variant, a coin-flip rule does not', async () => {
  // High volume on a bar announces five rising bars when `informative`; otherwise the same number
  // of rising runs falls at times the volume knows nothing about.
  const make = (seed: number, informative: boolean): Bars => {
    const rng = makeRng(seed);
    const n = 1500;
    const flags = Array.from({ length: n }, () => rng.next() < 0.02);
    const runs = informative ? flags : Array.from({ length: n }, () => rng.next() < 0.02);
    const up = new Array<boolean>(n).fill(false);
    runs.forEach((f, i) => {
      if (f) for (let k = 1; k <= 5 && i + k < n; k++) up[i + k] = true;
    });
    let c = 100;
    const b = bars(Array.from({ length: n }, (_, i) => (c *= 1 + (rng.next() - 0.5) * 0.02 + (up[i] ? 0.01 : 0))), { start: Date.UTC(2015, 0, 1) });
    b.v = flags.map((f) => (f ? 2000 : 1000));
    return b;
  };
  const rule = 'universe: A\ncosts: 5 bps\nbuy when volume > 1500\nsell when bars held >= 4';
  const share = async (seed: number, informative: boolean) => {
    const r = await randomEntries(backtest(rule, { A: make(seed, informative) }), { seed, runs: 100 });
    assert.equal(r.mode, 'timing');
    assert.equal(r.runs, 100);
    assert.ok(r.random.trades.every((n) => n === r.strategy.trades));
    return { cagr: 1 - r.atLeast.cagr / r.runs, ratio: 1 - r.atLeast.ratio / r.runs };
  };
  const good = await share(1, true);
  assert.ok(good.cagr >= 0.95 && good.ratio >= 0.9, JSON.stringify(good));
  const coin: number[] = [];
  for (let seed = 1; seed <= 8; seed++) coin.push((await share(seed, false)).cagr);
  const mean = coin.reduce((s, x) => s + x, 0) / coin.length;
  assert.ok(mean > 0.2 && mean < 0.8, JSON.stringify(coin));
  assert.ok(coin.filter((x) => x >= 0.95).length <= 2, JSON.stringify(coin));
});

test('random entries says when the check has nothing to vary', async () => {
  const A = bars(Array.from({ length: 60 }, (_, i) => 100 + i));
  assert.equal((await randomEntries(backtest('universe: A\nbuy when close > 1000', { A }), { seed: 1 })).skip, 'no-trades');
  assert.equal((await randomEntries(backtest('universe: A\nbuy when true', { A }), { seed: 1 })).skip, 'always-invested');
  const B = bars(Array.from({ length: 60 }, (_, i) => 100 - i / 2));
  assert.equal((await randomEntries(backtest('universe: A, B\nhold: top 2 by roc(5)', { A, B }), { seed: 1 })).skip, 'holds-everything');
  // Mostly invested: say so through `invested`, but still run.
  const r = await randomEntries(backtest('universe: A\nbuy when close > close[1]\nsell when close < 0', { A }), { seed: 1, runs: 5 });
  assert.equal(r.skip, null);
  assert.ok(r.invested > 0.9);
  assert.ok(returnOverDrawdown({ cagr: 0.1, maxDrawdown: 0 }) === Infinity && returnOverDrawdown({ cagr: 0.1, maxDrawdown: -0.2 }) === 0.5);
});

// ---------------------------------------------------------------- short and leveraged strategies

test('placed holdings keep their side, and where they sit does not depend on it', () => {
  const lengths = [5, 8, 3, 6];
  const shorts = [true, false, true, false];
  for (let seed = 1; seed <= 30; seed++) {
    const placed = placeHoldings(lengths, 10, 80, makeRng(seed), undefined, shorts);
    assert.deepEqual(placed.map((h) => `${h.exit - h.entry}${h.short ? ' short' : ''}`).sort(), ['3 short', '5 short', '6', '8']);
    assert.ok(placed.every((h) => h.short === true || !('short' in h)));
    assert.deepEqual(placed.map(({ entry, exit }) => ({ entry, exit })), placeHoldings(lengths, 10, 80, makeRng(seed)));
  }
});

test('random timing of a strategy that goes long and short keeps each trade\'s side and length, and shorts at the open as the strategy does', async () => {
  const rng = makeRng(21);
  const data = { A: walk(rng, 400, 0.08), B: walk(rng, 400, 0.08) };
  const rules = 'buy when close > sma(10) * 1.02\nsell when close < sma(10)\nshort when close < sma(10) * 0.98\ncover when close > sma(10)';
  const bt = backtest(`universe: A 50%, B 50%\ncosts: 10 bps\n${rules}`, data);
  const sides = (trades: { asset: string; bars: number; side?: 'short' }[], name: string) =>
    trades
      .filter((t) => t.asset === name)
      .map((t) => `${Math.max(1, t.bars)}${t.side ? ' short' : ''}`)
      .sort();
  assert.ok(bt.run.trades.filter((t) => t.side === 'short').length > 10 && bt.run.trades.filter((t) => !t.side).length > 10);
  for (let seed = 1; seed <= 10; seed++) {
    const v = randomTiming(bt, makeRng(seed));
    for (const name of ['A', 'B']) {
      assert.deepEqual(sides(v.run.trades, name), sides(bt.run.trades, name));
      const b = data[name as 'A' | 'B'];
      for (const t of v.run.trades.filter((x) => x.asset === name)) assert.equal(t.entryPrice, b.o[b.t.indexOf(t.entryT)]);
    }
    assert.ok(v.run.trades.every((t) => t.reason === 'signal' || t.reason === 'open'));
    assert.ok(v.run.borrowFees! > 0 && v.run.netExposure!.some((x) => x < 0), 'the random runs pay the borrow fee and hold shorts');
  }
  // A trend that flips straight from one side to the other is in the market the whole time, long or short: nothing to vary.
  const flips = backtest('universe: A 50%, B 50%\nbuy when close > sma(10)\nshort when close < sma(10)', data);
  assert.equal((await randomEntries(flips, { seed: 1 })).skip, 'always-invested');
});

test('random timing of a leveraged block runs with its margin: gross above 100%, interest on the money borrowed', () => {
  const rng = makeRng(31);
  const data = { A: walk(rng, 400, 0.04), B: walk(rng, 400, 0.04) };
  const bt = backtest('universe: A 75%, B 75%\nbuy when close > sma(10)\nsell when close < sma(10)', data);
  assert.ok(bt.spec.margin && Math.max(...bt.run.exposure) > 1.4);
  for (let seed = 1; seed <= 5; seed++) {
    const v = randomTiming(bt, makeRng(seed)).run;
    assert.ok(Math.max(...v.exposure) > 1.4 && Math.max(...v.exposure) <= 2 + 1e-9, String(Math.max(...v.exposure)));
    assert.ok(v.marginInterest! > 0 && v.marginCalls !== undefined);
  }
});

test('a strategy short the whole time has no timing to vary, as one long the whole time has not', async () => {
  const A = bars(Array.from({ length: 60 }, (_, i) => 100 - i / 2));
  const short = await randomEntries(backtest('universe: A\nshort when true', { A }), { seed: 1 });
  const long = await randomEntries(backtest('universe: A\nbuy when true', { A }), { seed: 1 });
  assert.deepEqual([short.skip, short.invested], ['always-invested', long.invested]);
});

test('reshuffling a run that was ruined stops at the ruin: every path that draws the fall ends at nothing, and the run itself is −100%', () => {
  const t = Array.from({ length: 11 }, (_, i) => Date.UTC(2020, 0, 1) + i * 36.525 * DAY);
  const equity = [100, 110, 120, 60, 10, 0, 0, 0, 0, 0, 0];
  const r = bootstrap(t, equity, { seed: 3, runs: 200, blockBars: 1 });
  assert.ok(r.cagr.values.every(Number.isFinite) && r.maxDrawdown.values.every(Number.isFinite));
  assert.deepEqual([r.actual.cagr, r.actual.maxDrawdown], [-1, -1]);
  // Five steps, one of them the fall to 0: a path of five one-step blocks draws it 1 − (4/5)^5 of the time, about 67%.
  const ruined = r.cagr.values.filter((x) => x === -1).length / r.runs;
  assert.ok(Math.abs(ruined - (1 - 0.8 ** 5)) < 0.08, String(ruined));
});

test('random entries of a short strategy: the same trades by side, and the section words them so', async () => {
  const rng = makeRng(41);
  const bt = backtest('universe: A\nshort when close < sma(10)\ncover when close > sma(10)', { A: walk(rng, 400, 0.06) });
  const r = await randomEntries(bt, { seed: 2, runs: 10 });
  assert.deepEqual([r.mode, r.skip, r.runs], ['timing', null, 10]);
  assert.ok(r.random.trades.every((n) => n === r.strategy.trades) && r.random.cagr.every(Number.isFinite));
  assert.match(randomVerdict({ ...r, invested: 0.95 }, false, true, 10), / The strategy is in its tickers, long or short, 95% of the time\. Thus random timing is almost the same as holding all the time/);
  assert.match(randomVerdict({ ...r, invested: 0.95 }, false, false, 10), / The strategy is invested 95% of the time\. Thus random timing/);
  assert.equal(randomVerdict({ ...r, skip: 'always-invested' }, false, true, 10), 'The strategy holds its tickers, long or short, all the time. Thus there is no timing to change.');
  assert.equal(randomVerdict({ ...r, skip: 'always-invested' }, false, false, 10), 'The strategy holds its tickers all the time. Thus there is no timing to change.');
  assert.equal(
    randomTimingWorks(bt.spec, true),
    'Each try keeps the number of trades of each ticker, the side of each trade (long or short), and how long each trade was held, with the same weights, costs, slippage, cash rate, borrow fee and margin rate. It puts those holdings at random dates. Stops are off, because the holding lengths include their exits.',
  );
  assert.match(randomTimingWorks(backtest('universe: A 150%\nbuy when true', { A: walk(rng, 50) }).spec), /with the same weights, costs, slippage, cash rate and margin rate\. It puts/);
});

test('random entries can be stopped, and the same seed gives the same answer', async () => {
  const rng = makeRng(3);
  const bt = backtest('universe: A\nbuy when close > sma(10)\nsell when close < sma(10)', { A: walk(rng, 300) });
  let done = 0;
  const stopped = await randomEntries(bt, { seed: 2, runs: 50, onProgress: (d) => (done = d), shouldStop: () => done >= 8 });
  assert.deepEqual([stopped.runs, stopped.stopped], [8, true]);
  const a = await randomEntries(bt, { seed: 2, runs: 20 });
  const b = await randomEntries(bt, { seed: 2, runs: 20 });
  assert.deepEqual(a.random, b.random);
  assert.notDeepEqual((await randomEntries(bt, { seed: 3, runs: 20 })).random.cagr, a.random.cagr);
});

// March rises 1% a day in 2015-2016, September from 2017. A variant holds through one month a year.
const seasons = (y: number, m: number) => (y < 2017 ? (m === 3 ? 1.01 : 1) : m === 9 ? 1.01 : 1);
const MONTHLY = 'universe: A\nm = 6 in 1..12\nbuy when month == m\nsell when month != m';

test('walk-forward windows: train, then test on the stretch right after, moving on by the test length', () => {
  const A = daily('2015-01-01', '2019-12-31', () => 1);
  const iso = (i: number) => new Date(A.t[i]).toISOString().slice(0, 10);
  const w = walkWindows(A.t, 24, 12);
  assert.deepEqual(
    w.map((x) => [iso(x.train[0]), iso(x.train[1]), iso(x.test[0]), iso(x.test[1])]),
    [
      ['2015-01-01', '2016-12-31', '2017-01-01', '2017-12-31'],
      ['2016-01-01', '2017-12-31', '2018-01-01', '2018-12-31'],
      ['2017-01-01', '2018-12-31', '2019-01-01', '2019-12-31'],
    ],
  );
  // A short last stretch is kept from a quarter of the test length.
  const B = daily('2015-01-01', '2017-04-15', () => 1);
  assert.equal(walkWindows(B.t, 24, 12).length, 1);
  assert.equal(walkWindows(daily('2015-01-01', '2017-03-15', () => 1).t, 24, 12).length, 0);
});

test('walk-forward lengths come from the history, and too little history is refused', () => {
  const years = (n: number) => daily('2010-01-01', `${2010 + n - 1}-12-31`, () => 1).t;
  assert.deepEqual(walkPlan(years(12)), { trainMonths: 48, testMonths: 12 });
  assert.deepEqual(walkPlan(years(6)), { trainMonths: 36, testMonths: 12 });
  assert.deepEqual(walkPlan(years(5)), { trainMonths: 24, testMonths: 12 });
  assert.deepEqual(walkPlan(years(2)), { trainMonths: 12, testMonths: 3 });
  assert.throws(() => walkPlan(daily('2010-01-01', '2011-03-31', () => 1).t), /must have approximately two years of prices or more.*This run is 1\.2 years long/);
  assert.throws(() => walkPlan(years(4), 4, 1), /must have 5 years of prices or more\. This run is 4\.0 years long/);
});

test('walk-forward picks each window on its training stretch only, then follows that pick through the test stretch', async () => {
  const A = daily('2015-01-01', '2019-12-31', (d) => seasons(d.getUTCFullYear(), d.getUTCMonth() + 1));
  const r = (await walkForward(MONTHLY, new Map([['A', A]]), { metric: 'totalReturn', trainYears: 2, testYears: 1 }))!;
  // 2017's best month was September, but the first pick only saw 2015-2016, where March won. Over
  // 2016-2017, March's 30 rising days beat September's 29. Over 2017-2018 September wins.
  assert.deepEqual(r.windows.map((w) => w.chosen.m), [3, 3, 9]);
  assert.ok(near(r.windows[0].trainScore, 1.01 ** 60 - 1, 1e-9));
  assert.deepEqual(r.windows.map((w) => Number(w.testReturn.toFixed(9))), [0, 0, Number((1.01 ** 29 - 1).toFixed(9))]);
  assert.deepEqual(r.windows.map((w) => w.declaredReturn), [0, 0, 0]);
  assert.equal(r.changes, 1);
  assert.deepEqual([r.variants, r.failed, r.idle], [12, 0, 0]);
  // The stitched line starts at the close before the first test stretch.
  assert.equal(new Date(r.t[0]).toISOString().slice(0, 10), '2016-12-31');
  assert.equal(r.t.length, r.equity.length);
  assert.ok(near(r.equity[r.equity.length - 1], 10_000 * 1.01 ** 29, 1e-6));
  assert.ok(near(r.stats.totalReturn, 1.01 ** 29 - 1, 1e-9));
  assert.ok(near(r.declared.stats.totalReturn, 0));
  // With hindsight, September (87 rising days) looks best, and makes three Septembers over the same dates.
  assert.deepEqual(r.hindsight.values, { m: 9 });
  assert.ok(near(r.hindsight.stats.totalReturn, 1.01 ** 87 - 1, 1e-9));
});

test('walk-forward: changing prices after a training stretch never changes that stretch\'s pick', async () => {
  const base = daily('2015-01-01', '2019-12-31', (d) => seasons(d.getUTCFullYear(), d.getUTCMonth() + 1));
  // May 2017 now rises 3% a day: a far better month, but only after the first training stretch.
  const later = daily('2015-01-01', '2019-12-31', (d) => (d.getUTCFullYear() === 2017 && d.getUTCMonth() === 4 ? 1.03 : seasons(d.getUTCFullYear(), d.getUTCMonth() + 1)));
  const opts = { metric: 'totalReturn' as const, trainYears: 2, testYears: 1 };
  const a = (await walkForward(MONTHLY, new Map([['A', base]]), opts))!;
  const b = (await walkForward(MONTHLY, new Map([['A', later]]), opts))!;
  assert.deepEqual(b.windows[0].chosen, a.windows[0].chosen);
  assert.equal(b.windows[0].trainScore, a.windows[0].trainScore);
  // The second stretch trains on 2016-2017, which does see May 2017.
  assert.deepEqual(b.windows[1].chosen, { m: 5 });
});

test('walk-forward measures each stretch from the last close before it, so the stitched test stretches multiply to the whole', async () => {
  // A 50% jump on 1 January 2016, held only by the December variant (in from early December, out
  // on 2 January). The second training stretch starts that day: measured from the close before it,
  // the jump counts, and December (+50%) beats March 2016 (+1.01^30 - 1, about 35%).
  const jump = (d: Date) => (d.getUTCFullYear() === 2016 && d.getUTCMonth() === 0 && d.getUTCDate() === 1 ? 1.5 : seasons(d.getUTCFullYear(), d.getUTCMonth() + 1));
  const A = daily('2015-01-01', '2019-12-31', jump);
  const opts = { metric: 'totalReturn' as const, trainYears: 2, testYears: 1 };
  const r = (await walkForward(MONTHLY, new Map([['A', A]]), opts))!;
  assert.deepEqual(r.windows.map((w) => w.chosen.m), [3, 12, 9]);
  assert.ok(near(r.windows[1].trainScore, 0.5, 1e-9));
  // The test stretches' growth multiplies to the stitched line's, for the picks and the note's values.
  const product = (xs: number[]) => xs.reduce((p, x) => p * (1 + x), 1);
  assert.ok(near(product(r.windows.map((w) => w.testReturn)), 1 + r.stats.totalReturn, 1e-9));
  assert.ok(near(product(r.windows.map((w) => w.declaredReturn)), 1 + r.declared.stats.totalReturn, 1e-9));
  // A pick reads nothing after its stretch: a jump on the first bar after it changes neither pick nor score.
  const after = daily('2015-01-01', '2019-12-31', (d) => (d.getUTCFullYear() === 2017 && d.getUTCMonth() === 0 && d.getUTCDate() === 1 ? 3 : jump(d)));
  const b = (await walkForward(MONTHLY, new Map([['A', after]]), opts))!;
  assert.deepEqual([b.windows[0].chosen, b.windows[0].trainScore], [r.windows[0].chosen, r.windows[0].trainScore]);
});

test('walk-forward refuses without a range, with too little history, and can be stopped', async () => {
  const A = daily('2015-01-01', '2019-12-31', () => 1);
  await assert.rejects(walkForward('universe: A\nn = 5\nbuy when close > sma(n)', new Map([['A', A]])), /must have a parameter with a range/);
  const short = daily('2015-01-01', '2016-02-28', () => 1);
  await assert.rejects(walkForward(MONTHLY, new Map([['A', short]])), /approximately two years/);
  let done = 0;
  assert.equal(await walkForward(MONTHLY, new Map([['A', A]]), { onProgress: (d) => (done = d), shouldStop: () => done >= 3 }), null);
});
