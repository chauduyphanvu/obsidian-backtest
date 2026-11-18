import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suggestWeights, type Allocation } from '../src/allocate.ts';
import { alignCurves, combine, type Aligned } from '../src/compare.ts';
import { combinedNote, compareLines } from '../src/render-compare.ts';
import { addsRows, splitNotes, splitRows } from '../src/render-split.ts';

/** Weekdays from 2015 on, `n` of them. */
function weekdays(n: number): number[] {
  const out: number[] = [];
  for (let t = Date.UTC(2015, 0, 1); out.length < n; t += 86_400_000) if (![0, 6].includes(new Date(t).getUTCDay())) out.push(t);
  return out;
}

function aligned(days: number): Aligned {
  const t = weekdays(days);
  return alignCurves([
    { label: 'A', t, equity: t.map((_, i) => 100 * (1 + 0.1 * Math.sin(i / 15)) * 1.0004 ** i) },
    { label: 'B', t, equity: t.map((_, i) => 100 * (1 + 0.05 * Math.cos(i / 11)) * 1.0002 ** i) },
    { label: 'C', t, equity: t.map((_, i) => 100 * (1 + 0.08 * Math.sin(i / 7 + 1)) * 1.0003 ** i) },
  ]);
}

test('the table starts with the weights as written, then each method that has its months, with the figures of its line', () => {
  const a = aligned(800);
  const alloc = suggestWeights(a, 0.9);
  const rows = splitRows({ aligned: a, weights: [0.4, 0.3, 0.2] }, alloc);
  assert.deepEqual(rows.map((r) => r.name), ['As written', 'Equal weights', 'Inverse volatility', 'Minimum variance', 'Maximum diversification']);
  assert.deepEqual(rows[0].weights, ['40%', '30%', '20%']);
  assert.equal(rows[0].percents, null);
  for (const r of rows.slice(1)) {
    assert.equal(r.percents!.reduce((s, p) => s + p, 0), 90, r.name);
    assert.deepEqual(r.weights, r.percents!.map((p) => `${p}%`));
    assert.equal(r.figures.length, 3);
    assert.match(r.figures[0], /^−?\d+\.\d%$/);
  }
  assert.deepEqual(rows[1].percents, [30, 30, 30]);
});

test('what each strategy adds: the line with it less the line without it, and nothing for one at 0%', () => {
  const a = aligned(300);
  const rows = addsRows({ aligned: a, labels: ['A', 'B', 'C'], weights: [0.5, 0.5, 0] });
  assert.deepEqual(rows.map((r) => r.label), ['A', 'B', 'C']);
  assert.deepEqual(rows[2].cells, ['0.0 pts', '0.0 pts', '0.00']);
  assert.match(rows[0].cells[0], /^[+−]?\d+\.\d pts$/);
});

test('the notes say how many months the suggestions rest on, and which methods need more', () => {
  const alloc = (o: Partial<Allocation>): Allocation => ({ months: 30, still: [], shrinkage: null, suggestions: [], ...o });
  const labels = ['A', 'B', 'C'];
  assert.match(splitNotes(alloc({ months: 4 }), labels)[0], /^From 4 full months the strategies have in common\./);
  assert.equal(splitNotes(alloc({ months: 4 }), labels)[1], 'Inverse volatility needs 6 full months, and minimum variance and maximum diversification 24.');
  assert.equal(splitNotes(alloc({ months: 12 }), labels)[1], 'Minimum variance and maximum diversification need 24 full months.');
  assert.match(splitNotes(alloc({ shrinkage: 0.31 }), labels)[1], /pulled 31% of the way towards one average correlation/);
  assert.equal(splitNotes(alloc({ still: [1] }), labels)[1], 'B barely moved over these months, so the methods that size by risk give it nothing.');
});

test('a strategy at 0% is drawn as a line of its own but is not in Combined', () => {
  const a = aligned(120);
  const curves = ['A', 'B', 'C'].map((label) => ({ label, t: a.t, equity: [] }));
  const { lines, combined } = compareLines({ curves, weights: [0.6, 0, 0.4] }, a);
  assert.deepEqual(lines.map((l) => [l.mark, l.label]), [['1', 'A'], ['2', 'B'], ['3', 'C']]);
  assert.deepEqual(lines[1].values, a.series[1]);
  // Combined is the same with B in it at 0% as with B left out.
  assert.deepEqual(combined!.values, combine(a, [0.6, 0, 0.4]));
  const twoOnly = { t: a.t, series: [a.series[0], a.series[2]] };
  combined!.values.forEach((v, i) => assert.ok(Math.abs(v - combine(twoOnly, [0.6, 0.4])[i]) < 1e-12));
  assert.equal(compareLines({ curves, weights: null }, a).combined, null);
});

test('the note under the chart names the strategies at 0% and the cash', () => {
  const lines = [{ mark: '1' }, { mark: '2' }, { mark: '3' }];
  assert.equal(
    combinedNote(lines, [0.5, 0, 0.3]),
    'Combined: 1 at 50%, 3 at 30%. It goes back to those weights on the first date of each month. 2 is listed at 0%: drawn, but not in Combined. The other 20% is cash that earns nothing.',
  );
  assert.equal(combinedNote(lines.slice(0, 2), [0.5, 0.5]), 'Combined: each strategy at 50%. It goes back to those weights on the first date of each month.');
  assert.equal(combinedNote(lines, [0.5, 0, 0]), 'Combined: 1 at 50%. It goes back to those weights on the first date of each month. 2, 3 are listed at 0%: drawn, but not in Combined. The other 50% is cash that earns nothing.');
});
