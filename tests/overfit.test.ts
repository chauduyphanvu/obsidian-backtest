import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeStats } from '../src/backtest.ts';
import {
  cscv,
  deflatedSharpe,
  excessReturns,
  expectedMaxSharpe,
  moments,
  normCdf,
  normInv,
  pbo,
  perStep,
  STRETCHES,
  stepBlocks,
  stepSharpe,
  stepsPerYear,
  type PboVariant,
  type StepBlocks,
} from '../src/overfit.ts';
import { makeRng, type Rng } from '../src/rng.ts';
import { DAY, near } from './helpers.ts';

const close = (actual: number, expected: number, rel: number) => assert.ok(Math.abs(actual - expected) <= rel * Math.abs(expected), `${actual} is not ${expected} within ${rel}`);

/** Standard normal draws by Box–Muller. */
function normals(rng: Rng): () => number {
  return () => Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next());
}

test('the normal quantile matches published values to full double precision', () => {
  close(normInv(0.975), 1.959963984540054, 1e-15);
  close(normInv(0.99), 2.326347874040841, 1e-15);
  close(normInv(0.999), 3.090232306167813, 1e-15);
  close(normInv(0.75), 0.6744897501960817, 1e-15);
  close(normInv(1e-10), -6.361340902404056, 1e-15);
  close(normInv(1e-300), -37.0470962993612, 1e-14);
  assert.equal(normInv(0.5), 0);
  // Each of the three regions of AS 241: near the middle, between, and far in the tails.
  close(normInv(0.92), 1.4050715603096326, 1e-15);
  close(normInv(0.0001), -3.7190164854556806, 1e-15);
  close(normInv(1e-20), -9.262340089798408, 1e-15);
});

test('the normal quantile is symmetric, and at 0, 1 and outside them is infinite or not a number', () => {
  // Dyadic fractions, whose 1 - p is exact.
  for (const p of [0.25, 0.125, 0.0625, 2 ** -10, 2 ** -20, 2 ** -30, 2 ** -50]) assert.equal(normInv(1 - p), -normInv(p), String(p));
  assert.equal(normInv(0), -Infinity);
  assert.equal(normInv(1), Infinity);
  assert.ok(Number.isNaN(normInv(-0.1)));
  assert.ok(Number.isNaN(normInv(1.1)));
  assert.ok(Number.isNaN(normInv(NaN)));
});

test('the normal distribution function matches published values, tails included', () => {
  assert.equal(normCdf(0), 0.5);
  close(normCdf(-1), 0.15865525393145705, 1e-15);
  close(normCdf(1), 0.8413447460685429, 1e-15);
  close(normCdf(1.959963984540054), 0.975, 1e-15);
  close(normCdf(-5), 2.866515718791939e-7, 1e-14);
  close(normCdf(-6.361340902404056), 1e-10, 1e-14);
  close(normCdf(-10), 7.619853024160526e-24, 1e-14);
  close(normCdf(-37), 5.725571222524577e-300, 1e-13);
  assert.equal(normCdf(-40), 0);
  assert.equal(normCdf(40), 1);
  assert.equal(normCdf(-Infinity), 0);
  assert.equal(normCdf(Infinity), 1);
  assert.ok(Number.isNaN(normCdf(NaN)));
});

test('the normal distribution function is symmetric, rises everywhere, and undoes the quantile', () => {
  let last = 0;
  for (let x = -12; x <= 12; x += 0.01) {
    assert.ok(Math.abs(normCdf(x) + normCdf(-x) - 1) <= 2e-16, String(x));
    assert.ok(normCdf(x) >= last, String(x));
    last = normCdf(x);
  }
  // Far in the tail Φ magnifies a relative error in x about x² times (x·φ(x)/Φ(x) ≈ x²), so the round trip can only be as
  // close as that allows.
  for (let p = 1e-300; p < 0.5; p *= 3.7) {
    const x = normInv(p);
    close(normCdf(x), p, 1e-15 * Math.max(1, x * x));
  }
  for (let p = 0.001; p < 1; p += 0.001) close(normCdf(normInv(p)), p, 5e-15);
});

test('moments of small samples worked by hand', () => {
  const even = moments([1, 2, 3, 4]);
  assert.equal(even.steps, 4);
  assert.equal(even.mean, 2.5);
  assert.ok(near(even.sd, Math.sqrt(1.25), 1e-15));
  assert.ok(near(even.skew, 0, 1e-15));
  assert.ok(near(even.kurt, 1.64, 1e-14));
  // One step in four is 1: a Bernoulli(1/4), skewness (1 - 2p) / √(p(1 - p)) and kurtosis 3 + (1 - 6p(1 - p)) / (p(1 - p)).
  const lumpy = moments([0, 0, 0, 1]);
  assert.ok(near(lumpy.skew, 2 / Math.sqrt(3), 1e-14));
  assert.ok(near(lumpy.kurt, 7 / 3, 1e-14));
  const flat = moments([0.01, 0.01, 0.01]);
  assert.equal(flat.sd, 0);
  assert.ok(Number.isNaN(flat.skew) && Number.isNaN(flat.kurt));
});

test('a normal sample has skewness near 0 and kurtosis near 3, not 0', () => {
  const draw = normals(makeRng(7));
  const m = moments(Array.from({ length: 200_000 }, draw));
  assert.ok(Math.abs(m.skew) < 0.03, String(m.skew));
  assert.ok(Math.abs(m.kurt - 3) < 0.06, String(m.kurt));
});

/** A run over weekdays from 2020 with the given step returns and cash returns. */
function curve(returns: number[], cash: number[]): { t: number[]; equity: number[]; cashReturn: number[] } {
  const t = [Date.UTC(2020, 0, 1)];
  const equity = [1000];
  const cashReturn = [0];
  returns.forEach((r, i) => {
    t.push(t[t.length - 1] + (new Date(t[t.length - 1]).getUTCDay() === 5 ? 3 : 1) * DAY);
    equity.push(equity[equity.length - 1] * (1 + r + cash[i]));
    cashReturn.push(cash[i]);
  });
  return { t, equity, cashReturn };
}

test('the Sharpe ratio per step is what computeStats annualises', () => {
  const draw = normals(makeRng(3));
  const returns = Array.from({ length: 700 }, () => 0.0004 + 0.01 * draw());
  const cash = returns.map((_, i) => (i < 300 ? 0.0001 : 0.00015));
  const run = curve(returns, cash);
  const excess = excessReturns(run.equity, run.cashReturn);
  assert.equal(excess.length, 700);
  assert.ok(near(excess[10], returns[10], 1e-15));
  const s = stepSharpe(excess)!;
  const stats = computeStats(run.t, run.equity, 1000, run.t.map(() => 1), run.cashReturn);
  const perYear = stepsPerYear(run.t);
  assert.ok(perYear > 250 && perYear < 263, String(perYear));
  assert.ok(near(s.sharpe * Math.sqrt(perYear), stats.sharpe, 1e-12));
  assert.ok(near(perStep(stats.sharpe, perYear), s.sharpe, 1e-14));
  assert.equal(s.steps, 700);
});

test('a run whose excess returns do not vary has no Sharpe ratio shape, as computeStats gives it 0', () => {
  const run = curve([0.001, 0.001, 0.001, 0.001], [0.001, 0.001, 0.001, 0.001]);
  assert.equal(stepSharpe(excessReturns(run.equity, run.cashReturn)), null);
  assert.equal(computeStats(run.t, run.equity, 1000, [1, 1, 1, 1, 1], run.cashReturn).sharpe, 0);
});

test('the deflated Sharpe ratio of the worked example of Bailey and López de Prado', () => {
  // 100 trials whose annualised Sharpe ratios have variance 0.5, 250 steps a year, five years, skewness -3, kurtosis 10.
  const perYear = 250;
  const variance = 0.5 / perYear;
  const run = { sharpe: perStep(2.5, perYear), steps: 1250, skew: -3, kurt: 10 };
  assert.ok(near(expectedMaxSharpe(100, variance), 0.11317200186513217, 1e-14));
  assert.ok(near(expectedMaxSharpe(100, variance) * Math.sqrt(perYear), 1.789406466273208, 1e-12));
  const d = deflatedSharpe(run, 100, variance)!;
  assert.ok(near(d.sr0, 0.11317200186513217, 1e-14));
  assert.ok(near(d.dsr, 0.9003968344493902, 1e-12));
  assert.equal(Math.round(d.dsr * 1e4) / 1e4, 0.9004);
});

test('one trial deflates nothing: SR0 is 0 and the deflated Sharpe ratio is the probabilistic one', () => {
  assert.equal(expectedMaxSharpe(1, 0.01), 0);
  assert.equal(expectedMaxSharpe(0, 0.01), 0);
  const run = { sharpe: 0.05, steps: 500, skew: 0, kurt: 3 };
  const d = deflatedSharpe(run, 1, 0.01)!;
  assert.equal(d.sr0, 0);
  assert.ok(near(d.dsr, normCdf((0.05 * Math.sqrt(499)) / Math.sqrt(1 + 0.05 * 0.05 / 2)), 1e-15));
  // More tries, or more spread among them, raise the bar.
  assert.ok(expectedMaxSharpe(1000, 0.001) > expectedMaxSharpe(100, 0.001));
  assert.ok(expectedMaxSharpe(100, 0.002) > expectedMaxSharpe(100, 0.001));
  assert.ok(deflatedSharpe(run, 1000, 0.001)!.dsr < deflatedSharpe(run, 10, 0.001)!.dsr);
});

test('SR0 is close to the expected best of many draws with no edge', () => {
  const draw = normals(makeRng(11));
  let sum = 0;
  const rounds = 2000;
  for (let k = 0; k < rounds; k++) {
    let best = -Infinity;
    for (let i = 0; i < 100; i++) best = Math.max(best, 0.03 * draw());
    sum += best;
  }
  // The theorem's approximation of E[max] for 100 draws is within about 1% of the true 2.5076 standard deviations.
  assert.ok(Math.abs(sum / rounds - expectedMaxSharpe(100, 0.03 ** 2)) < 0.03 * 0.06);
});

test('the deflated Sharpe ratio is not told under 3 steps or when the standard error has no real value', () => {
  assert.equal(deflatedSharpe({ sharpe: 0.1, steps: 2, skew: 0, kurt: 3 }, 5, 0.001), null);
  assert.notEqual(deflatedSharpe({ sharpe: 0.1, steps: 3, skew: 0, kurt: 3 }, 5, 0.001), null);
  // 1 - 10·0.2 + (3 - 1)/4·0.04 is below 0.
  assert.equal(deflatedSharpe({ sharpe: 0.2, steps: 500, skew: 10, kurt: 3 }, 5, 0.001), null);
  // Exactly 0: 1 - 5·0.2 + 0.
  assert.equal(deflatedSharpe({ sharpe: 0.2, steps: 500, skew: 5, kurt: 1 }, 5, 0.001), null);
  assert.equal(deflatedSharpe({ sharpe: 0.2, steps: 500, skew: NaN, kurt: 3 }, 5, 0.001), null);
});

test('step blocks sum excess returns and their squares over 48 equal stretches', () => {
  const returns = Array.from({ length: 96 }, (_, i) => (i % 3) * 0.01 - 0.01);
  const cash = returns.map(() => 0.0002);
  const run = curve(returns, cash);
  const { steps, blocks } = stepBlocks(run.equity, run.cashReturn);
  assert.equal(steps, 96);
  assert.equal(blocks.s.length, STRETCHES);
  assert.equal(blocks.q.length, STRETCHES);
  const excess = excessReturns(run.equity, run.cashReturn);
  for (let j = 0; j < STRETCHES; j++) {
    assert.ok(near(blocks.s[j], excess[2 * j] + excess[2 * j + 1], 1e-15));
    assert.ok(near(blocks.q[j], excess[2 * j] ** 2 + excess[2 * j + 1] ** 2, 1e-15));
  }
  // Uneven lengths spread the extra steps; every step is in one stretch.
  const odd = curve(Array.from({ length: 101 }, (_, i) => 0.001 * i), new Array(101).fill(0));
  const b = stepBlocks(odd.equity, odd.cashReturn).blocks;
  const total = excessReturns(odd.equity, odd.cashReturn).reduce((s, x) => s + x, 0);
  assert.ok(near(b.s.reduce((s, x) => s + x, 0), total, 1e-12));
  // A run shorter than 48 steps leaves some stretches empty.
  const short = stepBlocks([1, 1.1, 1.21], [0, 0, 0]);
  assert.equal(short.steps, 2);
  assert.equal(short.blocks.s.filter((x) => x !== 0).length, 2);
});

/** Sums of a group of steps. */
const sums = (steps: number[]) => ({ s: steps.reduce((a, x) => a + x, 0), q: steps.reduce((a, x) => a + x * x, 0) });
/** A variant from its steps in each group. */
const variant = (groups: number[][]): StepBlocks => {
  const each = groups.map(sums);
  return { s: each.map((g) => g.s), q: each.map((g) => g.q) };
};
/** Two steps a group, μ ± 0.01: a Sharpe ratio of μ / 0.01 within the group. */
const pair = (mu: number) => [mu + 0.01, mu - 0.01];

test('CSCV worked by hand: 4 groups, 3 variants', () => {
  // A does well early and badly late, B never earns, C earns the same in every group. Per-half Sharpe ratios:
  // A is 2 on groups {0,1}, -1 on {2,3} and about 0.277 on the others; B is 0; C is 1.
  const A = variant([pair(0.02), pair(0.02), pair(-0.01), pair(-0.01)]);
  const B = variant([pair(0), pair(0), pair(0), pair(0)]);
  const C = variant([pair(0.01), pair(0.01), pair(0.01), pair(0.01)]);
  const { pbo: p, logits } = cscv([A, B, C], [2, 2, 2, 2]);
  // Training on {0,1} picks A, last of 3 on {2,3}: ω = 1/4. Training on {2,3} picks C, second on {0,1}: ω = 2/4, λ = 0,
  // which counts as overfit. The other four pick C, first on the other half: ω = 3/4.
  const ln3 = Math.log(3);
  assert.deepEqual(
    [...logits].sort((a, b) => a - b).map((x) => Math.round(x * 1e12) / 1e12),
    [-ln3, 0, ln3, ln3, ln3, ln3].map((x) => Math.round(x * 1e12) / 1e12),
  );
  assert.equal(p, 2 / 6);
});

test('CSCV ties: the first in grid order wins training, and a tie on the test half takes the middle rank', () => {
  // Two groups, so two splits. V0 and V1 tie on group 0; V1 is better on group 1.
  const V0 = variant([pair(0.01), pair(-0.01)]);
  const V1 = variant([pair(0.01), pair(0.01)]);
  const V2 = variant([pair(0), pair(0)]);
  const { logits, pbo: p } = cscv([V0, V1, V2], [2, 2]);
  // Train on group 0: V0 (first of the tie), last on group 1: ω = 1/4. Train on group 1: V1, which on group 0 ties V0
  // above V2: rank 1 + (2 + 1) / 2 = 2.5, ω = 2.5/4.
  assert.ok(near(logits[0], Math.log(1 / 3), 1e-12));
  assert.ok(near(logits[1], Math.log(5 / 3), 1e-12));
  assert.equal(p, 0.5);
});

/** `count` variants of `steps` noise returns each, with `edge` added to the returns of variant `skilled`. */
function sweepOf(rng: Rng, count: number, steps: number, edge = 0, skilled = -1): PboVariant[] {
  const draw = normals(rng);
  return Array.from({ length: count }, (_, v) => {
    const returns = Array.from({ length: steps }, () => 0.01 * draw() + (v === skilled ? edge : 0));
    const run = curve(returns, new Array(steps).fill(0));
    return stepBlocks(run.equity, run.cashReturn);
  });
}

test('PBO of variants with no edge is near one half', () => {
  // With no edge the training winner's rank on the test half is uniform, so P(rank ≤ (N + 1)/2) is 1/2. One sweep's PBO
  // still swings widely (the splits share their data), so the mean of a dozen is checked.
  const found: number[] = [];
  for (let seed = 1; seed <= 12; seed++) {
    const r = pbo(sweepOf(makeRng(seed), 20, 960));
    assert.equal(r.short, null);
    assert.equal(r.groups, 16);
    assert.equal(r.splits, 12_870);
    assert.equal(r.variants, 20);
    found.push(r.pbo!);
  }
  const mean = found.reduce((s, x) => s + x, 0) / found.length;
  assert.ok(mean > 0.4 && mean < 0.65, JSON.stringify(found));
});

test('PBO of a sweep with one variant that has a real edge is near 0', () => {
  // The skilled variant earns 0.25 standard deviations a step above the others.
  for (let seed = 1; seed <= 10; seed++) {
    const r = pbo(sweepOf(makeRng(seed), 20, 960, 0.0025, 7));
    assert.ok(r.pbo! < 0.02, `${seed}: ${r.pbo}`);
  }
});

test('PBO needs 5 variants and 20 steps a group, and leaves out runs of another length', () => {
  assert.deepEqual(pbo([]), { pbo: null, short: 'variants', variants: 0, leftOut: 0, steps: 0, groups: 16, splits: 0 });
  assert.equal(pbo(sweepOf(makeRng(1), 4, 400)).short, 'variants');
  const short = pbo(sweepOf(makeRng(1), 6, 319));
  assert.equal(short.short, 'steps');
  assert.equal(short.pbo, null);
  assert.equal(pbo(sweepOf(makeRng(1), 6, 320)).short, null);
  // Two variants on a shorter history are left out; the five others are enough.
  const mixed = [...sweepOf(makeRng(2), 5, 400), ...sweepOf(makeRng(3), 2, 380)];
  const r = pbo(mixed);
  assert.equal(r.variants, 5);
  assert.equal(r.leftOut, 2);
  assert.equal(r.steps, 400);
  assert.notEqual(r.pbo, null);
  // Left out, four would be too few.
  const few = pbo([...sweepOf(makeRng(2), 4, 400), ...sweepOf(makeRng(3), 3, 380)]);
  assert.deepEqual([few.short, few.variants, few.leftOut], ['variants', 4, 3]);
});

test('PBO joins the stretches into 12 groups above 150 variants', () => {
  const r = pbo(sweepOf(makeRng(4), 151, 240));
  assert.equal(r.groups, 12);
  assert.equal(r.splits, 924);
  assert.equal(r.short, null);
  assert.ok(r.pbo! > 0.2 && r.pbo! < 0.8, String(r.pbo));
  assert.equal(pbo(sweepOf(makeRng(4), 151, 239)).short, 'steps');
  assert.equal(pbo(sweepOf(makeRng(4), 150, 240)).short, 'steps');
});

test('PBO is the same computed from the stretches as from the groups worked out directly', () => {
  const variants = sweepOf(makeRng(9), 6, 333);
  const r = pbo(variants);
  // 333 steps: stretch j starts at floor(j·333/48); group g of 16 is stretches 3g to 3g + 2.
  const start = (j: number) => Math.floor((j * 333) / 48);
  const n = Array.from({ length: 16 }, (_, g) => start(3 * g + 3) - start(3 * g));
  assert.equal(n.reduce((a, x) => a + x, 0), 333);
  const joined = variants.map(({ blocks }) => ({
    s: n.map((_, g) => blocks.s[3 * g] + blocks.s[3 * g + 1] + blocks.s[3 * g + 2]),
    q: n.map((_, g) => blocks.q[3 * g] + blocks.q[3 * g + 1] + blocks.q[3 * g + 2]),
  }));
  assert.equal(r.pbo, cscv(joined, n).pbo);
});
