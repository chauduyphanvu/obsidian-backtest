// Work kept for the next run on the same prices: what is kept, what is not, and that every run reads exactly what it
// would have worked out on its own.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { debugRange, debugRows } from '../src/debug.ts';
import { parseSpec, type Expr, type Spec } from '../src/dsl.ts';
import { apartKey, Evaluator, specEvaluator } from '../src/evaluate.ts';
import { explainTrade } from '../src/explain.ts';
import { runBlock } from '../src/jobs.ts';
import { walkForward } from '../src/luck.ts';
import { MEMO_BYTES, PriceMemo, priceMemo } from '../src/price-memo.ts';
import { makeRng } from '../src/rng.ts';
import { runSweep } from '../src/sweep.ts';
import type { Bars } from '../src/types.ts';
import { DAY } from './helpers.ts';

/** A random walk on weekdays (a stock) or every day (a coin) from Monday 6 January 2020. */
function walk(seed: number, count: number, everyDay = false, volume = 1000): Bars {
  const rng = makeRng(seed);
  const b: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let p = 50 + 100 * rng.next();
  for (let t = Date.UTC(2020, 0, 6); b.t.length < count; t += DAY) {
    if (!everyDay && [0, 6].includes(new Date(t).getUTCDay())) continue;
    const o = p * (1 + (rng.next() - 0.5) * 0.004);
    p = o * (1 + (rng.next() - 0.49) * 0.03);
    b.t.push(t);
    b.o.push(o);
    b.h.push(Math.max(o, p) * (1 + rng.next() * 0.01));
    b.l.push(Math.min(o, p) * (1 - rng.next() * 0.01));
    b.c.push(p);
    b.v.push(volume);
  }
  return b;
}

const spec = (source: string): Spec => {
  const { spec, errors } = parseSpec(source);
  assert.deepEqual(errors, [], source);
  return spec!;
};

/** The same bars in a map of their own that is never shared: what a run works out with nothing kept. */
const alone = (data: Map<string, Bars>) => new Map(data);

// ---------------------------------------------------------------- the memo itself

test('a map that is not shared keeps nothing', () => {
  const memo = new PriceMemo(1000);
  const data = new Map<string, Bars>();
  let made = 0;
  for (let i = 0; i < 3; i++) memo.get(data, 'k', () => [++made], (v) => v.length);
  assert.equal(made, 3);
  assert.equal(memo.bytes, 0);
});

test('a shared map keeps each answer once, and an error is not kept', () => {
  const memo = new PriceMemo(1000);
  const data = new Map<string, Bars>();
  memo.share(data);
  let made = 0;
  const first = memo.get(data, 'k', () => [++made, 0], (v) => v.length);
  assert.equal(memo.get(data, 'k', () => [++made, 0], (v) => v.length), first);
  assert.equal(made, 1);
  assert.equal(memo.bytes, 16);
  let tries = 0;
  const fail = () => {
    tries++;
    throw new Error('no volume');
  };
  assert.throws(() => memo.get(data, 'bad', fail, () => 1), /no volume/);
  assert.throws(() => memo.get(data, 'bad', fail, () => 1), /no volume/);
  assert.equal(tries, 2);
  assert.equal(memo.bytes, 16);
  // A later call that succeeds is kept as usual.
  assert.deepEqual(memo.get(data, 'bad', () => [1], (v) => v.length), [1]);
  assert.equal(memo.bytes, 24);
});

test('beyond the cap the least recently used answers go, whichever map they belong to', () => {
  const memo = new PriceMemo(8 * 10);
  const [a, b] = [new Map<string, Bars>(), new Map<string, Bars>()];
  memo.share(a);
  memo.share(b);
  const made: string[] = [];
  const get = (data: Map<string, Bars>, key: string) => memo.get(data, key, () => (made.push(key), [1, 2, 3, 4]), (v) => v.length);
  get(a, 'x');
  get(b, 'y');
  get(a, 'x'); // x is now used more recently than y
  get(a, 'z'); // 12 numbers: y goes
  assert.equal(memo.bytes, 64);
  get(a, 'x');
  get(a, 'z');
  get(b, 'y'); // made again; x is the least recently used now, and goes
  get(a, 'z');
  get(a, 'x');
  assert.deepEqual(made, ['x', 'y', 'z', 'y', 'x']);
  assert.equal(memo.bytes, 64);
});

test('an answer larger than the whole cap is given but not kept, and pushes nothing out', () => {
  const memo = new PriceMemo(8 * 10);
  const data = new Map<string, Bars>();
  memo.share(data);
  memo.get(data, 'small', () => [1, 2], (v) => v.length);
  let made = 0;
  const big = () => (made++, new Array<number>(11).fill(1));
  assert.equal(memo.get(data, 'big', big, (v) => v.length).length, 11);
  memo.get(data, 'big', big, (v) => v.length);
  assert.equal(made, 2);
  assert.equal(memo.bytes, 16);
});

test('runs keep at most 64 MB', () => {
  assert.equal(MEMO_BYTES, 64 * 2 ** 20);
});

// ---------------------------------------------------------------- indicators

test('the apart key names each series and its source in name order, and only with fill: close', () => {
  const text = 'universe: BBB, AAA\nbenchmark: binance:CCC\nbuy when close > sma(5) of binance:DDD';
  assert.equal(apartKey(spec(text)), '');
  assert.equal(apartKey(spec(`${text}\nfill: close`)), '[["AAA","yahoo"],["BBB","yahoo"],["CCC","binance"],["DDD","binance"]]');
  // The source of a name decides its clock: another source, another key.
  assert.notEqual(apartKey(spec('universe: AAA\nfill: close\nbuy when close > sma(5) of DDD')), apartKey(spec('universe: AAA\nfill: close\nbuy when close > sma(5) of binance:DDD')));
});

test('a fill: close spec and a next-open spec on the same prices never read each other\'s series', () => {
  // A stock on weekdays reads a coin that trades every day: with fill: close a stock's bar reads the coin's day before.
  const data = new Map([
    ['STK', walk(1, 80)],
    ['CRY', walk(2, 112, true)],
  ]);
  priceMemo.share(data);
  const rule = 'universe: STK\nbuy when sma(close of binance:CRY, 3) > sma(close, 5)';
  const [open, close] = [spec(rule), spec(`${rule}\nfill: close`)];
  const left = (s: Spec) => (s.rules.STK.buy as Extract<Expr, { k: 'cmp' }>).a;
  const fresh = (s: Spec) => specEvaluator(s, alone(data)).eval(left(s), 'STK');
  const want = { open: fresh(open), close: fresh(close) };
  assert.notDeepEqual(want.open, want.close);
  // Either order, and again once both are kept.
  for (const order of [
    [open, close, open],
    [close, open, close],
  ]) {
    for (const s of order) assert.deepEqual(specEvaluator(s, data).eval(left(s), 'STK'), s === open ? want.open : want.close);
  }
  // Within one fill the series is worked out once and shared, the same array for every run.
  assert.equal(specEvaluator(close, data).eval(left(close), 'STK'), specEvaluator(close, data).eval(left(close), 'STK'));
  // A bare Evaluator, which knows nothing of the spec, shares nothing.
  assert.notEqual(new Evaluator(data).eval(left(open), 'STK'), new Evaluator(data).eval(left(open), 'STK'));
});

test('a failing indicator and the checks of a strategy\'s tickers run again on every run', () => {
  const data = new Map([
    ['A', walk(3, 60, false, 0)],
    ['F', { ...walk(4, 60), unpriced: true as const, columns: [{ name: 'x', header: 'x', v: new Array<number>(60).fill(1) }] }],
  ]);
  priceMemo.share(data);
  const before = priceMemo.bytes;
  for (let i = 0; i < 2; i++) {
    assert.throws(() => runBacktest(spec('universe: A\nbuy when mfi(14) > 50'), data), /A has no volume/);
    assert.throws(() => runBacktest(spec('universe: csv:F.csv\nbuy when true'), data), /F has no prices, only columns/);
  }
  assert.equal(priceMemo.bytes, before);
});

// ---------------------------------------------------------------- the benchmark

test('the benchmark is kept for what it holds and how: weights, a ranking\'s top k, the capital and the costs', () => {
  const data = new Map([
    ['A', walk(5, 300)],
    ['B', walk(6, 300)],
    ['C', walk(7, 300)],
    ['D', walk(8, 300)],
  ]);
  priceMemo.share(data);
  // A ranking holds size / top of each ticker it picks, and its benchmark top / 4 of that: 0.225 of each ticker, except
  // that with the top 3 it rounds to 0.22499999999999998, which a benchmark kept for the top 2 must not stand in for.
  const ranked = (top: number, capital = '10k', costs = 5) =>
    `universe: A, B, C, D\nsize: 90%\ncapital: ${capital}\ncosts: ${costs} bps\nrebalance: monthly\nhold: top ${top} by roc(10)\nbuy when true`;
  const weighted = (a: number) => `universe: A ${a}%, B ${100 - a}%\nrebalance: monthly\nbuy when close > sma(5)`;
  const variants = [ranked(2), ranked(3), ranked(2), ranked(1), ranked(3), ranked(2, '20k'), ranked(2, '10k', 50), weighted(60), weighted(40), weighted(60)];
  const seen = new Map<string, number[]>();
  for (const text of variants) {
    const got = runBacktest(spec(text), data).benchmark;
    assert.deepEqual(got, runBacktest(spec(text), alone(data)).benchmark, text);
    seen.set(text, got.equity);
  }
  assert.notDeepEqual(seen.get(ranked(2)), seen.get(ranked(3)));
  assert.deepEqual(seen.get(ranked(2)), seen.get(ranked(1)));
  assert.notDeepEqual(seen.get(weighted(60)), seen.get(weighted(40)));
  assert.equal(new Set([...seen.values()].map((e) => e.join())).size, 6);
});

// ---------------------------------------------------------------- whole runs

const ROTATION = 'universe: A, B, C\nrebalance: monthly\nhold: top k by roc(lb)\nk = 2 in 1..3\nlb = 20 in 10..30 step 10\nstop loss: 8%\nbuy when close > sma(lb)\nsell when close < lowest(low, lb)[1]';

test('a sweep on shared prices gives every variant exactly what a run of it alone gives', async () => {
  const data = new Map([
    ['A', walk(8, 800)],
    ['B', walk(9, 800)],
    ['C', walk(10, 800)],
  ]);
  const sweep = await runSweep(ROTATION, data, { pause: async () => {} });
  assert.equal(sweep.points.length, 9);
  for (const p of sweep.points) {
    const bt = runBacktest(parseSpec(ROTATION, { overrides: p.values }).spec!, alone(data));
    assert.deepEqual([p.stats, p.trades], [bt.stats, bt.run.trades.length], JSON.stringify(p.values));
  }
  // A walk-forward on the same prices afterwards reads what the sweep kept, and gets what it gets on a map of its own.
  const walked = (prices: Map<string, Bars>) => walkForward(ROTATION, prices, { pause: async () => {}, trainYears: 1, testYears: 1 });
  const [kept, own] = [await walked(data), await walked(alone(data))];
  assert.ok(kept && kept.windows.length >= 2);
  assert.deepEqual(kept, own);
});

test('slider runs on a block\'s prices, and the explanations and bar-by-bar values of their results, match runs alone', () => {
  const data = new Map([
    ['A', walk(11, 300)],
    ['B', walk(12, 300)],
    ['C', walk(13, 300)],
  ]);
  const slider: Record<string, number>[] = [{}, { lb: 10 }, { lb: 30, k: 1 }, { lb: 10 }, {}];
  for (const overrides of slider) {
    const ran = runBlock({ source: ROTATION, defaults: {}, overrides }, data);
    const { spec: _spec, data: _data, ...own } = runBacktest(parseSpec(ROTATION, { overrides }).spec!, alone(data));
    assert.deepEqual(ran, own, JSON.stringify(overrides));
  }
  const sharedBt = runBacktest(spec(ROTATION), data);
  const ownBt = runBacktest(spec(ROTATION), alone(data));
  assert.ok(ownBt.run.trades.length > 3);
  for (let i = 0; i < ownBt.run.trades.length; i++) assert.deepEqual(explainTrade(sharedBt, sharedBt.run.trades[i]), explainTrade(ownBt, ownBt.run.trades[i]));
  for (const asset of ['A', 'B', 'C']) {
    const { count } = debugRange(ownBt, asset);
    assert.deepEqual(debugRows(sharedBt, asset, 0, count), debugRows(ownBt, asset, 0, count), asset);
  }
});
