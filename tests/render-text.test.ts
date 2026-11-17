import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BootstrapResult } from '../src/luck.ts';
import { reshuffleVerdict } from '../src/render-luck.ts';
import { bestWords } from '../src/render-sweep.ts';

const TRY_IT = 'To try it, change those lines in the block; the note stays the record of what you chose.';
const UNFAIR = 'Values picked on this view have seen the test period, so their later result is not a fair test.';

test('without a test date the best values are offered as before', () => {
  assert.deepEqual(bestWords('all', null), { label: 'Best variant here: ', advice: TRY_IT });
});

test('with a test date, values chosen before it name that period and are offered', () => {
  assert.deepEqual(bestWords('before', '2015-01-01'), { label: 'Best before 2015-01-01: ', advice: TRY_IT });
});

test('with a test date, values chosen on the whole run or after it are not offered, and the one sentence says why', () => {
  assert.deepEqual(bestWords('all', '2015-01-01'), { label: 'Best on the whole run: ', advice: UNFAIR });
  assert.deepEqual(bestWords('after', '2015-01-01'), { label: 'Best from 2015-01-01 on: ', advice: UNFAIR });
});

const spread = (lo: number, median: number, hi: number) => ({ lo, median, hi, values: [lo, median, hi] });
const boot = (o: Partial<BootstrapResult> = {}): BootstrapResult => ({
  runs: 1000,
  blockBars: 21,
  seed: 1,
  cagr: spread(0.02, 0.08, 0.14),
  maxDrawdown: spread(-0.3, -0.2, -0.1),
  lossShare: 0,
  actual: { cagr: 0.08, maxDrawdown: -0.22 },
  ...o,
});

test('the reshuffled-history verdict opens with what the check shows, and ends by saying what it does not', () => {
  const text = reshuffleVerdict(boot());
  assert.ok(text.startsWith('This shows how much the path and the drawdown depended on the order of the returns. '));
  assert.ok(text.includes('In 1,000 reshuffles of this run’s own returns, the middle 90% made between 2.0% and 14.0% a year (this run: 8.0%), with worst drawdowns between −30.0% and −10.0% (this run: −22.0%).'));
  assert.ok(text.endsWith('It says nothing about whether the average return will persist, because every version is made from this run’s own returns.'));
});

test('the verdict no longer says that none of the reshuffles lost money', () => {
  assert.ok(!/None of the/.test(reshuffleVerdict(boot())));
  assert.ok(!/lost money/.test(reshuffleVerdict(boot({ lossShare: 0.12 }))));
});

test('some reshuffles ending below the start are reported with their share', () => {
  assert.ok(reshuffleVerdict(boot({ lossShare: 0.12 })).includes(' 12% of the reshuffled versions ended below the starting value.'));
  assert.ok(reshuffleVerdict(boot({ lossShare: 0.004 })).includes(' 0.4% of the reshuffled versions ended below the starting value.'));
});

test('a drawdown milder or deeper than the reshuffles is called out', () => {
  assert.ok(reshuffleVerdict(boot({ actual: { cagr: 0.08, maxDrawdown: -0.15 } })).includes('milder than in most of them'));
  assert.ok(reshuffleVerdict(boot({ actual: { cagr: 0.08, maxDrawdown: -0.4 } })).includes('deeper than in almost all of them'));
  assert.ok(!/milder|deeper/.test(reshuffleVerdict(boot())));
});
