import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bucketStats, CRISES, regimePlan, STOCK_REGIMES, type CrisisResult } from '../src/regimes.ts';
import { crisisRow, growthCell, recoveryText, regimeRows } from '../src/render-regimes.ts';
import { DAY } from './helpers.ts';

const t = (n: number) => Date.UTC(2024, 0, 1) + n * DAY;

test('a return says whether it is per year, and an unknown one is a dash', () => {
  assert.deepEqual(growthCell({ value: 0.123, perYear: true }), ['+12.3%', 'a year']);
  assert.deepEqual(growthCell({ value: -0.04, perYear: false }), ['−4.0%', 'in all']);
  assert.deepEqual(growthCell({ value: NaN, perYear: false }), ['–', null]);
});

test('the rows of a regime are its states in order, then the steps where it was not known, and only those with a step in them', () => {
  const run = { t: [t(0), t(1), t(2), t(3), t(4)], equity: [100, 110, 99, 108.9, 98.01], exposure: [0, 1, 1, 0.5, 0.25], benchmark: [NaN, NaN, 100, 102, 101] };
  const rows = regimeRows(bucketStats(run, [-1, 0, 1, 1, 1], 2), ['Above', 'Below']);
  assert.deepEqual(rows.map((r) => r.label), ['Above', 'Below', 'Not known yet']);
  // One step of four in "above": a quarter of the time, -10% from 110 to 99, no benchmark value (unknown at that step), fully invested.
  assert.deepEqual(rows[0].cells, [['25%', null], ['−10.0%', 'in all'], ['–', null], ['100%', null], ['−10.0%', null]]);
  // A state with no step is left out, and so is the unknown one when everything was known.
  const known = regimeRows(bucketStats(run, [1, 1, 1, 1, 1], 2), ['Above', 'Below']);
  assert.deepEqual(known.map((r) => r.label), ['Below']);
  assert.equal(known[0].cells[0][0], '100%');
});

test('a share under a tenth of the time is given to a decimal', () => {
  const equity = Array.from({ length: 101 }, (_, i) => 100 + i);
  const run = { t: equity.map((_, i) => t(i)), equity, exposure: equity.map(() => 1), benchmark: equity };
  const rows = regimeRows(bucketStats(run, equity.map((_, i) => (i === 50 ? 1 : 0)), 2), ['Above', 'Below']);
  assert.deepEqual(rows.map((r) => r.cells[0][0]), ['99%', '1.0%']);
});

test('the day the strategy was back at its high is a date, with the time of day for an intraday run, or why there is none', () => {
  const at = Date.UTC(2020, 2, 29, 15, 0);
  assert.equal(recoveryText({ kind: 'back', t: at }, false), '2020-03-29');
  assert.equal(recoveryText({ kind: 'back', t: at }, true), '2020-03-29 15:00');
  assert.equal(recoveryText({ kind: 'held' }, false), 'Never below it');
  assert.equal(recoveryText({ kind: 'not' }, false), 'Not by the end');
});

test('the row of a fall has its name and days, then the strategy’s and the benchmark’s return, the drawdown, the exposure and the recovery', () => {
  const result: CrisisResult = {
    crisis: CRISES.find((c) => c.name === 'Covid crash')!,
    strategy: -0.1089,
    benchmark: -0.2,
    worstDrawdown: -0.1089,
    exposure: 0.3,
    recovery: { kind: 'not' },
  };
  const row = crisisRow(result, false);
  assert.equal(row.label, 'Covid crash');
  assert.equal(row.dates, '2020-02-19 to 2020-03-23');
  assert.deepEqual(row.cells, [['−10.9%', null], ['−20.0%', null], ['−10.9%', null], ['30%', null], ['Not by the end', null]]);
  assert.equal(crisisRow({ ...result, benchmark: NaN, strategy: 0.05 }, false).cells.slice(0, 2).map((c) => c[0]).join(' '), '+5.0% –');
});

test('the README gives the buttons, the falls, the rules and the words of the section as the code has them', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const universe of [[{ name: 'SPY', source: 'yahoo' as const, id: 'SPY' }], [{ name: 'BTCUSDT', source: 'binance' as const, id: 'BTCUSDT' }]]) {
    const plan = regimePlan(universe);
    assert.ok(readme.includes(`"Load ${plan.refs.map((r) => r.name).join(', ')} from ${plan.source}"`), plan.source);
  }
  for (const c of CRISES) assert.ok(readme.includes(`${c.peak} to ${c.trough}`), c.name);
  for (const r of STOCK_REGIMES) assert.ok(readme.includes(`\`${r.condition}\``), r.condition);
  const run = { t: [t(0), t(1)], equity: [100, 110], exposure: [0, 1], benchmark: [100, 101] };
  assert.ok(readme.includes(`"${regimeRows(bucketStats(run, [-1, -1], 2), ['A', 'B'])[0].label}"`));
  for (const kind of ['held', 'not'] as const) assert.ok(readme.includes(`"${recoveryText({ kind }, false)}"`), kind);
  assert.ok(readme.includes('`BTCUSDT`') && readme.includes('last 30 daily returns') && readme.includes('last 365 days'));
});
