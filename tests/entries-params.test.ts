import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { acceptedScale, createRequester, sliderScale, sliderValues } from '../src/render-params.ts';
import { setParamValues } from '../src/rewrite.ts';
import { makeRng } from '../src/rng.ts';
import { runSweep, sweepParams } from '../src/sweep.ts';
import type { Bars } from '../src/types.ts';
import { bars } from './helpers.ts';

const rng = makeRng(4);
let c = 100;
const A = bars(Array.from({ length: 800 }, () => (c *= 1 + (rng.next() - 0.48) * 0.03)));
const data = new Map<string, Bars>([['A', A]]);

const RULES = 'buy when close > sma(20)\nadd when close > last entry price * 1.02\nsell when close < sma(20)';
const BLOCK = `universe: A\nn = 3 in 1..5\nentries: n\n${RULES}`;

test('a sweep over the number of entries runs every value, and each matches the block written with that value', async () => {
  const sweep = await runSweep(BLOCK, data, {});
  assert.deepEqual(sweepParams(parseSpec(BLOCK).spec!).map((p) => [p.name, p.values]), [['n', [1, 2, 3, 4, 5]]]);
  assert.deepEqual(sweep.points.map((p) => [p.values.n, p.error]), [[1, null], [2, null], [3, null], [4, null], [5, null]]);
  for (const point of sweep.points) {
    const direct = runBacktest(parseSpec(BLOCK, { overrides: { n: point.values.n } }).spec!, data);
    assert.equal(point.stats!.cagr, direct.stats.cagr, `n = ${point.values.n}`);
    assert.equal(point.trades, direct.run.trades.length);
  }
  // A value of 1 reads and runs: its add rule never makes an entry, so it is the same strategy with no adds at all.
  const one = parseSpec(BLOCK, { overrides: { n: 1 } });
  assert.deepEqual([one.errors, one.warnings], [[], []]);
  const plain = runBacktest(parseSpec(`universe: A\nbuy when close > sma(20)\nsell when close < sma(20)`).spec!, data);
  assert.equal(sweep.points[0].stats!.cagr, plain.stats.cagr);
  // More entries is a different run, not the same one drawn again.
  assert.equal(new Set(sweep.points.map((p) => p.stats!.cagr)).size, 5);
});

test('"Use these values in the block" writes the value of the best variant and nothing else, and the block reads with it', async () => {
  const sweep = await runSweep(BLOCK, data, {});
  const best = sweep.points.reduce((a, b) => (b.stats!.cagr > a.stats!.cagr ? b : a));
  const written = setParamValues(BLOCK, best.values);
  assert.equal(written, BLOCK.replace('n = 3 in 1..5', `n = ${best.values.n} in 1..5`));
  const { spec, errors, warnings } = parseSpec(written);
  assert.deepEqual([errors, warnings], [[], []]);
  assert.equal(spec!.entries, best.values.n);
  assert.equal(spec!.params[0].declared, best.values.n);
});

test('the slider for a ranged number of entries has the block\'s range, and every value on it reads', () => {
  const p = parseSpec(BLOCK).spec!.params[0];
  assert.deepEqual(sliderScale(p), { lo: 1, hi: 5, step: 1 });
  for (const n of sliderValues(p)) assert.deepEqual(parseSpec(BLOCK, { overrides: { n } }).errors, [], `n = ${n}`);
  const accepts = (n: number) => parseSpec(BLOCK, { overrides: { n } }).spec !== null;
  assert.deepEqual(acceptedScale(p, accepts), { lo: 1, hi: 5, step: 1 });
});

test('without an add rule the values above 1 say so in plain words, in the sweep and at a slider', async () => {
  const noAdd = 'universe: A\nn = 1 in 1..4\nentries: n\nbuy when close > sma(20)\nsell when close < sma(20)';
  const sweep = await runSweep(noAdd, data, {});
  assert.deepEqual(sweep.points.map((p) => p.error === null), [true, false, false, false]);
  const said = '"entries: 2" builds each position in 2 entries, so it needs an add rule that says when to make the next one, such as add when close > last entry price * 1.03';
  assert.equal(sweep.points[1].error, said);
  // The bar asks the block to run with the slider's value and reports the message in a sentence of its own.
  const shown: unknown[] = [];
  const failures: string[] = [];
  const requester = createRequester(
    {
      rerun: async (values) => {
        const parsed = parseSpec(noAdd, { overrides: values });
        if (!parsed.spec) throw new Error(`Line ${parsed.errors[0].line}: ${parsed.errors[0].message}`);
        return null;
      },
    },
    { shown: (o) => shown.push(o), waiting: () => {}, loading: () => {}, failed: (e) => failures.push(e instanceof Error ? e.message : String(e)) },
  );
  requester.request({ n: 2 }, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, [`Line 3: ${said}`]);
});

test('a ranged number of entries past 10 is refused with the limits named, and a derived slider never reaches it', () => {
  const wide = `universe: A\nn = 3 in 1..12\nentries: n\n${RULES}`;
  const refused = parseSpec(wide, { overrides: { n: 11 } });
  assert.deepEqual(refused.errors.map((e) => e.message), ['entries must be a whole number from 1 to 10, not 11']);
  // The block's own range is the block's: its slider reaches 12. A slider the plugin works out stops at 10.
  assert.equal(sliderScale(parseSpec(wide).spec!.params[0]).hi, 12);
  const plain = parseSpec(`universe: A\nn = 10\nentries: n\n${RULES}`).spec!.params[0];
  assert.equal(sliderScale(plain).hi, 20);
  assert.equal(acceptedScale(plain, (n) => parseSpec(`universe: A\nn = 10\nentries: n\n${RULES}`, { overrides: { n } }).spec !== null).hi, 10);
});
