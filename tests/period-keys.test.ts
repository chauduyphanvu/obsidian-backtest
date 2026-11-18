// Rebalance and ranking periods, worked out without Date, against Date itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { specSignals } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { periodKey, periodKeys, simulate, type FillSeen } from '../src/engine.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY } from './helpers.ts';

const HOUR = 3_600_000;

/** The periods as they were first defined, through Date. */
const byDate = {
  monthly: (t: number) => new Date(t).getUTCFullYear() * 12 + new Date(t).getUTCMonth(),
  quarterly: (t: number) => new Date(t).getUTCFullYear() * 4 + Math.floor(new Date(t).getUTCMonth() / 3),
  yearly: (t: number) => new Date(t).getUTCFullYear(),
};

test('monthly, quarterly and yearly keys match Date at every hour of every day from 1800 to 2200', () => {
  let checked = 0;
  for (let day = Date.UTC(1800, 0, 1); day <= Date.UTC(2200, 11, 31); day += DAY) {
    // Midnight, the first and last millisecond of the day, and hours in between, before and after 1970 alike.
    for (const t of [day, day + 1, day + 9.5 * HOUR, day + 21 * HOUR, day + DAY - 1]) {
      for (const mode of ['monthly', 'quarterly', 'yearly'] as const) {
        const [got, want] = [periodKey(t, mode), byDate[mode](t)];
        if (got !== want) assert.fail(`${mode} ${new Date(t).toISOString()}: ${got}, Date gives ${want}`);
      }
      checked++;
    }
  }
  assert.equal(checked, (5 * (Date.UTC(2201, 0, 1) - Date.UTC(1800, 0, 1))) / DAY);
});

test('a weekly key changes on Mondays only, and never a key for "never"', () => {
  let prev = periodKey(Date.UTC(1799, 11, 31), 'weekly');
  for (let day = Date.UTC(1800, 0, 1); day <= Date.UTC(2200, 11, 31); day += DAY) {
    const monday = new Date(day).getUTCDay() === 1;
    const key = periodKey(day, 'weekly');
    if (key !== prev + (monday ? 1 : 0)) assert.fail(`weekly ${new Date(day).toISOString()}: ${key} after ${prev}`);
    if (periodKey(day + DAY - 1, 'weekly') !== key) assert.fail(`weekly changes within ${new Date(day).toISOString()}`);
    if (periodKey(day, 'never') !== 0) assert.fail('never');
    prev = key;
  }
});

test('the keys of a series are worked out once per series and rebalance mode', () => {
  const t = [Date.UTC(1969, 11, 30), Date.UTC(1969, 11, 31), Date.UTC(1970, 0, 1), Date.UTC(1970, 3, 1)];
  const monthly = periodKeys(t, 'monthly');
  assert.deepEqual(monthly, t.map((x) => periodKey(x, 'monthly')));
  assert.deepEqual(monthly, [1969 * 12 + 11, 1969 * 12 + 11, 1970 * 12, 1970 * 12 + 3]);
  assert.equal(periodKeys(t, 'monthly'), monthly);
  assert.deepEqual(periodKeys(t, 'yearly'), [1969, 1969, 1970, 1970]);
  // Another series with the same times gets its own keys.
  const copy = [...t];
  assert.notEqual(periodKeys(copy, 'monthly'), monthly);
  assert.deepEqual(periodKeys(copy, 'monthly'), monthly);
});

test('a monthly rebalance across the start of 1970 trades on the first bar of each month only', () => {
  // Two tickers on weekdays from November 1969 to March 1970, one rising and one falling, so every rebalance trades.
  const times: number[] = [];
  for (let t = Date.UTC(1969, 10, 3); t <= Date.UTC(1970, 2, 31); t += DAY) if (![0, 6].includes(new Date(t).getUTCDay())) times.push(t);
  const data = new Map<string, Bars>([
    ['A', bars(times.map((_, i) => 100 * 1.01 ** i), { times })],
    ['B', bars(times.map((_, i) => 100 * 0.99 ** i), { times })],
  ]);
  for (const fill of ['', 'fill: close\n']) {
    const spec = parseSpec(`universe: A 50%, B 50%\nrebalance: monthly\n${fill}buy when true`).spec!;
    const seen: FillSeen[] = [];
    simulate({ ...spec, assets: spec.universe, onFill: (f) => seen.push(f) }, data, specSignals(spec, data));
    const rebalances = seen.filter((f) => f.kind === 'trim' || f.kind === 'rebalance').map((f) => f.t);
    // At the open of each month's first bar, or with fill: close at the close of each month's last bar: the final bar,
    // Tuesday 31 March, is one, as the next weekday is in April.
    const next = (i: number) => (i + 1 < times.length ? times[i + 1] : times[i] + DAY);
    const want = times.filter((t, i) => (fill ? byDate.monthly(next(i)) !== byDate.monthly(t) : i > 0 && byDate.monthly(times[i - 1]) !== byDate.monthly(t)));
    assert.deepEqual([...new Set(rebalances)], want, fill || 'next open');
    assert.equal(want.length, fill ? 5 : 4);
  }
});
