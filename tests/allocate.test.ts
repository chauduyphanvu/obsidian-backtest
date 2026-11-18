import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COVARIANCE_MONTHS,
  maximumDiversification,
  minimumVariance,
  monthlyReturns,
  monthlyWeights,
  projectSimplex,
  shrunkCovariance,
  strategyAdds,
  suggestWeights,
  VOLATILITY_MONTHS,
  weightsFrom,
  wholePercents,
} from '../src/allocate.ts';
import { alignCurves, combine, monthStarts, rebalanced, type Aligned } from '../src/compare.ts';
import { near } from './helpers.ts';

const close = (a: number[], b: number[], eps = 1e-9) => a.length === b.length && a.every((x, i) => near(x, b[i], eps));
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

// --- Projection onto the simplex -------------------------------------------------------------------------------------

test('the nearest weights with none below 0 that add up to the total: hand-worked', () => {
  assert.deepEqual(projectSimplex([0.5, 0.5], 1), [0.5, 0.5]);
  assert.deepEqual(projectSimplex([2, 0], 1), [1, 0]);
  assert.deepEqual(projectSimplex([0.6, 0.6, 0], 1), [0.5, 0.5, 0]);
  // Sorted 1, 0.5, -1: the first two stay in with theta = (1.5 - 0.8) / 2 = 0.35.
  assert.ok(close(projectSimplex([1, 0.5, -1], 0.8), [0.65, 0.15, 0]));
  // A point already on it stays; one far below is pulled up evenly.
  assert.ok(close(projectSimplex([0.2, 0.3, 0.5], 1), [0.2, 0.3, 0.5]));
  assert.ok(close(projectSimplex([-3, -3, -3, -3], 1), [0.25, 0.25, 0.25, 0.25]));
  assert.ok(close(projectSimplex([5], 0.4), [0.4]));
});

// --- Shrinkage -----------------------------------------------------------------------------------------------------

test("the shrunk covariance matches Ledoit and Wolf's covCor, computed separately", () => {
  // From scratchpad covcor.py: covCor.m transcribed in plain Python, matrix by matrix.
  const three = shrunkCovariance([
    [0.02, -0.01, 0.03, 0.0, -0.02, 0.04, 0.01, -0.03],
    [0.01, 0.0, 0.02, -0.01, -0.01, 0.03, 0.02, -0.02],
    [-0.01, 0.02, 0.0, 0.01, 0.03, -0.02, 0.0, 0.01],
  ]);
  assert.ok(near(three.shrinkage, 0.11031388074394922, 1e-12));
  const want3 = [
    [0.000525, 0.0003020408862744631, -0.00026424147904441397],
    [0.0003020408862744631, 0.000275, -0.00017293667176915964],
    [-0.00026424147904441397, -0.00017293667176915964, 0.000225],
  ];
  three.cov.forEach((row, i) => assert.ok(close(row, want3[i], 1e-15), `row ${i}`));

  const four = shrunkCovariance([
    [0.05, -0.02, 0.01, 0.03, -0.04, 0.02, 0.0, 0.01, -0.01, 0.02],
    [0.01, 0.01, 0.0, 0.02, -0.01, 0.0, 0.01, 0.0, 0.01, 0.0],
    [0.02, -0.03, 0.04, 0.0, -0.02, 0.05, -0.01, 0.02, 0.0, -0.02],
    [-0.01, 0.02, 0.01, -0.02, 0.03, 0.0, 0.02, -0.01, 0.01, 0.02],
  ]);
  assert.ok(near(four.shrinkage, 0.19571025086686175, 1e-12));
  const want4 = [
    [0.000601, 6.195589800602254e-5, 0.0002412060799852757, -0.00024477998481145643],
    [6.195589800602254e-5, 6.5e-5, -2.6746426763843104e-5, -5.633712582352866e-5],
    [0.0002412060799852757, -2.6746426763843104e-5, 0.000645, -0.0001857062879058015],
    [-0.00024477998481145643, -5.633712582352866e-5, -0.0001857062879058015, 0.000241],
  ];
  four.cov.forEach((row, i) => assert.ok(close(row, want4[i], 1e-15), `row ${i}`));
});

test('with two strategies the target is the sample covariance itself, so nothing is shrunk', () => {
  const r = shrunkCovariance([
    [0.01, -0.02, 0.03, 0.0],
    [0.02, 0.01, -0.01, 0.01],
  ]);
  assert.equal(r.shrinkage, 0);
  // Variances over T, not T - 1: 0.01, -0.02, 0.03, 0 have a mean of 0.005 and squared deviations adding up to 0.0013.
  assert.ok(near(r.cov[0][0], 0.0013 / 4, 1e-15));
  assert.equal(r.cov[0][1], r.cov[1][0]);
});

test('shrinking keeps the variances, keeps the matrix symmetric and pulls correlations towards their average', () => {
  const rows = [
    [0.03, -0.01, 0.02, 0.0, -0.02, 0.04, 0.01, -0.03, 0.02, 0.01, -0.01, 0.0],
    [0.02, -0.01, 0.01, 0.01, -0.02, 0.03, 0.0, -0.02, 0.01, 0.02, 0.0, -0.01],
    [-0.01, 0.02, 0.0, 0.01, 0.03, -0.02, 0.0, 0.01, -0.01, 0.0, 0.02, 0.01],
  ];
  const { cov, shrinkage } = shrunkCovariance(rows);
  const plain = shrunkCovariance(rows.slice(0, 2)).cov;
  assert.ok(shrinkage > 0 && shrinkage <= 1);
  assert.ok(near(cov[0][0], plain[0][0], 1e-15) && near(cov[1][1], plain[1][1], 1e-15));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.equal(cov[i][j], cov[j][i]);
  // Strategies 1 and 2 move together more than the average pair, so their covariance comes down.
  assert.ok(cov[0][1] < plain[0][1]);
});

// --- Optimisers ----------------------------------------------------------------------------------------------------

test('minimum variance of two unrelated strategies: in inverse proportion to their variances, scaled to the total', () => {
  // Variances 0.04 and 0.01: weights 0.01 / 0.05 and 0.04 / 0.05.
  assert.ok(close(minimumVariance([[0.04, 0], [0, 0.01]], 1), [0.2, 0.8]));
  assert.ok(close(minimumVariance([[0.04, 0], [0, 0.01]], 0.6), [0.12, 0.48]));
});

test('minimum variance stays at the edge when the best mix would hold one strategy below 0', () => {
  // Volatilities 0.1 and 0.2, correlation 0.9: unconstrained, w1 = (0.04 - 0.018) / (0.01 + 0.04 - 0.036) = 1.57.
  assert.ok(close(minimumVariance([[0.01, 0.018], [0.018, 0.04]], 1), [1, 0]));
  // With a third, unrelated strategy of volatility 0.15, the second drops out and the other two split by inverse variance:
  // 1/0.01 and 1/0.0225, so 9/13 and 4/13. At that point the second's marginal variance (0.0125) is above the others' (0.0069).
  const w = minimumVariance(
    [
      [0.01, 0.018, 0],
      [0.018, 0.04, 0],
      [0, 0, 0.0225],
    ],
    1,
  );
  assert.ok(close(w, [9 / 13, 0, 4 / 13]), w.join(' '));
});

test('minimum variance of three unrelated strategies, inside the simplex', () => {
  const w = minimumVariance(
    [
      [0.01, 0, 0],
      [0, 0.04, 0],
      [0, 0, 0.04],
    ],
    0.9,
  );
  // In proportion to 100, 25 and 25.
  assert.ok(close(w, [0.6, 0.15, 0.15]), w.join(' '));
});

test('minimum variance converges on badly conditioned covariances within its steps', () => {
  const sd = [0.05, 0.0501, 0.0502];
  const cov = sd.map((a, i) => sd.map((b, j) => (i === j ? a * a : 0.99 * a * b)));
  const w = minimumVariance(cov, 1);
  assert.ok(near(sum(w), 1, 1e-12) && w.every((x) => x >= 0));
  // At the optimum every strategy held has the same marginal variance.
  const marginal = cov.map((row) => row.reduce((s, c, j) => s + c * w[j], 0));
  assert.ok(marginal.every((m) => near(m, marginal[0], 1e-9)), marginal.join(' '));
  assert.deepEqual(minimumVariance([[0, 0], [0, 0]], 1), [0.5, 0.5]);
});

test('maximum diversification: least variance on the correlations, divided by each volatility, scaled back', () => {
  // Volatilities 0.1, 0.2 and 0.1; strategies 1 and 2 correlate at 0.5 and the third with neither. On the correlations the
  // least-variance mix is 2/7, 2/7 and 3/7; divided by the volatilities, 20/7, 10/7, 30/7, so 1/3, 1/6 and 1/2.
  const sd = [0.1, 0.2, 0.1];
  const corr = [
    [1, 0.5, 0],
    [0.5, 1, 0],
    [0, 0, 1],
  ];
  const cov = corr.map((row, i) => row.map((c, j) => c * sd[i] * sd[j]));
  assert.ok(close(maximumDiversification(cov, 1), [1 / 3, 1 / 6, 1 / 2]));
  assert.ok(close(maximumDiversification(cov, 0.6), [0.2, 0.1, 0.3]));
  // For two strategies it is inverse volatility, whatever their correlation.
  assert.ok(close(maximumDiversification([[0.01, 0.012], [0.012, 0.04]], 1), [2 / 3, 1 / 3]));
});

// --- Monthly returns and weights -------------------------------------------------------------------------------------

/** Weekday times from a start date for `n` points. */
function weekdays(from: number, n: number): number[] {
  const out: number[] = [];
  for (let t = from; out.length < n; t += 86_400_000) if (![0, 6].includes(new Date(t).getUTCDay())) out.push(t);
  return out;
}

/** A seeded series of daily returns around `drift` with a spread of `vol`, part shared through `common`. */
function curves(n: number, days: number, seed = 7): Aligned {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31 - 0.5;
  };
  const t = weekdays(Date.UTC(2015, 0, 1), days);
  const vols = [0.004, 0.008, 0.012, 0.006, 0.01];
  const series = Array.from({ length: n }, () => [1]);
  for (let i = 1; i < days; i++) {
    const common = rand();
    series.forEach((v, k) => v.push(v[i - 1] * (1 + 0.0003 + vols[k] * (0.6 * common + rand()))));
  }
  return { t, series, cash: series.map(() => t.map(() => 1)) };
}

test('monthly returns run from the first point of one month to the first point of the next', () => {
  const t = [Date.UTC(2020, 0, 30), Date.UTC(2020, 1, 3), Date.UTC(2020, 1, 20), Date.UTC(2020, 2, 2), Date.UTC(2020, 2, 31), Date.UTC(2020, 3, 1), Date.UTC(2020, 3, 2)];
  const series = [[1, 1.1, 1.2, 1.32, 1.0, 1.188, 2]];
  assert.deepEqual(monthStarts(t), [1, 3, 5]);
  // February: 1.1 to 1.32; March: 1.32 to 1.188. The part of January and the April still running are left out.
  const r = monthlyReturns({ t, series });
  assert.equal(r[0].length, 2);
  assert.ok(near(r[0][0], 0.2) && near(r[0][1], -0.1));
});

test('with too few months, or no movement, the estimates fall back to equal weights', () => {
  const few = [
    [0.01, 0.02],
    [0.03, -0.01],
  ];
  assert.deepEqual(weightsFrom('inverse volatility', few, 0.8), [0.4, 0.4]);
  assert.deepEqual(weightsFrom('minimum variance', few, 0.8), [0.4, 0.4]);
  const flat = [Array(30).fill(0), Array(30).fill(0.0001)];
  assert.deepEqual(weightsFrom('maximum diversification', flat, 1), [0.5, 0.5]);
});

test('a strategy that barely moved is left out of the methods that size by risk', () => {
  const months = 30;
  const moving = Array.from({ length: months }, (_, i) => (i % 2 ? 0.03 : -0.02));
  const other = Array.from({ length: months }, (_, i) => (i % 3 ? 0.02 : -0.03));
  const cash = Array.from({ length: months }, () => 0.004);
  for (const method of ['inverse volatility', 'minimum variance', 'maximum diversification'] as const) {
    const w = weightsFrom(method, [moving, cash, other], 1);
    assert.equal(w[1], 0, method);
    assert.ok(near(sum(w), 1, 1e-12), method);
  }
  assert.deepEqual(weightsFrom('equal', [moving, cash, other], 0.9).map((x) => Number(x.toFixed(12))), [0.3, 0.3, 0.3]);
});

test('inverse volatility weights are in inverse proportion to each volatility', () => {
  const a = Array.from({ length: 12 }, (_, i) => (i % 2 ? 0.02 : -0.02));
  const b = a.map((x) => 2 * x);
  assert.ok(close(weightsFrom('inverse volatility', [a, b], 0.9), [0.6, 0.3]));
});

test('no month after the first point of a month changes the weights set there', () => {
  const full = curves(3, 900);
  const starts = monthStarts(full.t);
  const cut = starts[30];
  // The same curves up to the 30th month start, then something else entirely.
  const changed: Aligned = { ...full, series: full.series.map((s, k) => s.map((v, i) => (i <= cut ? v : v * (1 + 0.3 * Math.sin(i * (k + 1)))))) };
  const truncated: Aligned = { t: full.t.slice(0, cut + 1), series: full.series.map((s) => s.slice(0, cut + 1)), cash: full.cash.map((c) => c.slice(0, cut + 1)) };
  for (const method of ['inverse volatility', 'minimum variance', 'maximum diversification'] as const) {
    const a = monthlyWeights(full, method, 1);
    const b = monthlyWeights(changed, method, 1);
    const c = monthlyWeights(truncated, method, 1);
    for (const at of [0, ...starts.filter((i) => i <= cut)]) {
      assert.deepEqual(b.get(at), a.get(at), `${method} at ${at}`);
      assert.deepEqual(c.get(at), a.get(at), `${method} at ${at}`);
    }
    // After the cut they do change.
    assert.notDeepEqual(b.get(starts[40]), a.get(starts[40]), method);
  }
});

test('each method holds equal weights until it has the months it needs, then its own', () => {
  const aligned = curves(3, 900);
  const starts = monthStarts(aligned.t);
  const vol = monthlyWeights(aligned, 'inverse volatility', 1);
  const mv = monthlyWeights(aligned, 'minimum variance', 1);
  const equal = [1 / 3, 1 / 3, 1 / 3];
  // At start j the first j months are known.
  assert.deepEqual(vol.get(starts[VOLATILITY_MONTHS - 1]), equal);
  assert.notDeepEqual(vol.get(starts[VOLATILITY_MONTHS]), equal);
  assert.deepEqual(mv.get(starts[COVARIANCE_MONTHS - 1]), equal);
  assert.notDeepEqual(mv.get(starts[COVARIANCE_MONTHS]), equal);
  assert.deepEqual(vol.get(0), equal);
});

test('suggestions: only equal weights and inverse volatility under 24 months, all four from 24', () => {
  const short = suggestWeights(curves(3, 400), 1);
  assert.ok(short.months < COVARIANCE_MONTHS);
  assert.deepEqual(short.suggestions.map((s) => s.method), ['equal', 'inverse volatility']);
  assert.equal(short.shrinkage, null);
  const long = suggestWeights(curves(3, 900), 0.9);
  assert.ok(long.months >= COVARIANCE_MONTHS);
  assert.deepEqual(long.suggestions.map((s) => s.method), ['equal', 'inverse volatility', 'minimum variance', 'maximum diversification']);
  assert.ok(long.shrinkage !== null && long.shrinkage >= 0 && long.shrinkage <= 1);
  for (const s of long.suggestions) {
    assert.ok(near(sum(s.weights), 0.9, 1e-9) && s.weights.every((w) => w >= 0), s.method);
    assert.equal(sum(s.percents), 90, s.method);
    assert.equal(s.values[0], 1);
    assert.equal(s.values.length, long.suggestions[0].values.length);
    assert.equal(s.cashReturn.length, s.values.length);
  }
  // Fewer than 6 months: equal weights alone.
  assert.deepEqual(suggestWeights(curves(2, 100), 1).suggestions.map((s) => s.method), ['equal']);
});

test("a suggestion's latest weights come from every full month, and its line holds them from the last month on", () => {
  const aligned = curves(3, 900);
  const starts = monthStarts(aligned.t);
  const { suggestions } = suggestWeights(aligned, 1);
  for (const s of suggestions) {
    assert.deepEqual(s.weights, weightsFrom(s.method, monthlyReturns(aligned), 1), s.method);
    assert.deepEqual(monthlyWeights(aligned, s.method, 1).get(starts[starts.length - 1]), s.weights, s.method);
  }
  // The equal-weight line is the plain combination.
  assert.deepEqual(suggestions[0].values, combine(aligned, [1 / 3, 1 / 3, 1 / 3]));
});

test('the cash of a line whose weights change is averaged at the weights held through each step', () => {
  // Two curves; the first earns 1% a step on its cash, the second nothing. The suggestion's weights are equal throughout.
  const t = weekdays(Date.UTC(2020, 0, 1), 60);
  const aligned = alignCurves([
    { label: 'A', t, equity: t.map((_, i) => 1 + 0.01 * i), cash: t.map((_, i) => 1.01 ** i) },
    { label: 'B', t, equity: t.map((_, i) => 1 + 0.02 * Math.sin(i)), cash: t.map(() => 1) },
  ]);
  const [equal] = suggestWeights(aligned, 0.5).suggestions;
  assert.equal(equal.cashReturn[0], 0);
  equal.cashReturn.slice(1).forEach((x, i) => assert.ok(near(x, 0.005, 1e-12), `step ${i + 1}`));
});

test('what each strategy adds: the line without it spreads its weight over the others', () => {
  const aligned = curves(3, 300);
  const weights = [0.5, 0.3, 0.1];
  const adds = strategyAdds(aligned, weights);
  assert.deepEqual(adds.values, combine(aligned, weights));
  // Without the first, the others hold 0.9 between them in the same proportion: 0.675 and 0.225.
  assert.ok(close(adds.without[0].values, combine(aligned, [0, 0.675, 0.225]), 1e-12));
  assert.ok(close(adds.without[2].values, combine(aligned, [0.5625, 0.3375, 0]), 1e-12));
  // A strategy alone leaves only cash behind it.
  const alone = strategyAdds(aligned, [0.6, 0, 0]);
  assert.ok(alone.without[0].values.every((v) => v === 1));
  assert.deepEqual(alone.without[1].values, alone.values);
});

test('a line whose weights change each month is valued like combine, month by month', () => {
  // Jan 30, Jan 31, Feb 3, Feb 4, Mar 2, Mar 3. A doubles on Feb 4; B halves on Mar 3.
  const t = [Date.UTC(2020, 0, 30), Date.UTC(2020, 0, 31), Date.UTC(2020, 1, 3), Date.UTC(2020, 1, 4), Date.UTC(2020, 2, 2), Date.UTC(2020, 2, 3)];
  const aligned = { t, series: [[1, 1, 1, 2, 2, 2], [1, 1, 1, 1, 1, 0.5]] };
  const asked: number[] = [];
  const v = rebalanced(aligned, (i) => {
    asked.push(i);
    return i === 0 ? [0.5, 0.5] : i === 2 ? [1, 0] : [0, 0.5];
  });
  assert.deepEqual(asked, [0, 2, 4]);
  // Feb 3: 1, all in A. Feb 4: 2. Mar 2: 2, half in B and half in cash. Mar 3: 1 in cash plus 0.5.
  assert.deepEqual(v, [1, 1, 1, 2, 2, 1.5]);
  // Constant weights give exactly what combine gives.
  const c = curves(3, 200);
  assert.deepEqual(rebalanced(c, () => [0.2, 0.3, 0.4]), combine(c, [0.2, 0.3, 0.4]));
  assert.throws(() => rebalanced(aligned, (i) => (i === 0 ? [0.5, 0.5] : [0.7, 0.7])), /cannot add up to more than 100%/);
});

// --- Whole percentages ---------------------------------------------------------------------------------------------

test('weights in whole percentages by largest remainders, adding up to exactly the total', () => {
  assert.deepEqual(wholePercents([1 / 3, 1 / 3, 1 / 3], 1), [34, 33, 33]);
  assert.deepEqual(wholePercents([0.4, 0.4, 0.2], 1), [40, 40, 20]);
  // 66.7 and 33.3: the larger remainder gets the last percent.
  assert.deepEqual(wholePercents([2 / 3, 1 / 3], 1), [67, 33]);
  // A total of 87.5% becomes 87%: never more than written. Quotas 49.71 and 37.29 give 49 and 37, and 50 for the larger remainder.
  assert.deepEqual(wholePercents([0.5, 0.375], 0.875), [50, 37]);
  // A tiny weight can round to 0%.
  assert.deepEqual(wholePercents([0.996, 0.004], 1), [100, 0]);
  assert.deepEqual(wholePercents([0, 0], 1), [0, 0]);
  // Rounding noise in the weights does not move a percent.
  assert.deepEqual(wholePercents([0.3 + 1e-15, 0.7 - 1e-15], 1), [30, 70]);
  for (let k = 1; k <= 7; k++) {
    const w = Array.from({ length: k }, (_, i) => (i + 1) / ((k * (k + 1)) / 2));
    const p = wholePercents(w, 0.95);
    assert.equal(sum(p), 95, `${k}`);
    assert.ok(p.every((x) => Number.isInteger(x) && x >= 0));
  }
});
