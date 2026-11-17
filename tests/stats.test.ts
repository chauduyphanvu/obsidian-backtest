import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeStats } from '../src/backtest.ts';
import { calmar, deepStats, periodReturns, rollingReturns, sortino, underwater } from '../src/stats.ts';
import { DAY, near } from './helpers.ts';

/** UTC midnight of a calendar date (month is 1-based). */
const d = (y: number, m: number, day: number) => Date.UTC(y, m - 1, day);

// Crosses a year boundary (Fri 2023-12-29 to Tue 2024-01-02, weekend missing) and four month boundaries.
// The first point is mid-November and the last mid-March, so the first and last periods are partial.
const A_T = [d(2023, 11, 15), d(2023, 11, 30), d(2023, 12, 15), d(2023, 12, 29), d(2024, 1, 2), d(2024, 1, 31), d(2024, 2, 29), d(2024, 3, 10)];
const A_E = [100, 105, 110, 121, 130, 133.1, 119.79, 125];

test('monthly returns run from the last value before the month, with a partial first and last month', () => {
  const m = periodReturns(A_T, A_E, 'month');
  assert.deepEqual(
    m.map((p) => [p.key, p.t, p.partial]),
    [
      ['2023-11', d(2023, 11, 1), true],
      ['2023-12', d(2023, 12, 1), false],
      ['2024-01', d(2024, 1, 1), false],
      ['2024-02', d(2024, 2, 1), false],
      ['2024-03', d(2024, 3, 1), true],
    ],
  );
  // Nov: first value 100 to 105. Dec: 105 to 121. Jan: 121 to 133.1. Feb: 133.1 to 119.79. Mar: 119.79 to 125.
  const expected = [105 / 100 - 1, 121 / 105 - 1, 133.1 / 121 - 1, 119.79 / 133.1 - 1, 125 / 119.79 - 1];
  m.forEach((p, i) => assert.ok(near(p.ret, expected[i], 1e-12), `${p.key}: ${p.ret} vs ${expected[i]}`));
  assert.ok(near(m[2].ret, 0.1, 1e-12));
  assert.ok(near(m[3].ret, -0.1, 1e-12));
});

test('yearly returns cross the year boundary and mark both ends partial', () => {
  const y = periodReturns(A_T, A_E, 'year');
  assert.deepEqual(
    y.map((p) => [p.key, p.t, p.partial]),
    [
      ['2023', d(2023, 1, 1), true],
      ['2024', d(2024, 1, 1), true],
    ],
  );
  // 2023: 100 to 121. 2024: the last value of 2023 (121) to 125.
  assert.ok(near(y[0].ret, 0.21, 1e-12));
  assert.ok(near(y[1].ret, 125 / 121 - 1, 1e-12));
});

test('a first period that holds only the first point is left out', () => {
  // Fri 2023-12-29 is the only December point; January's return starts from it.
  const t = [d(2023, 12, 29), d(2024, 1, 2), d(2024, 1, 31)];
  const e = [100, 104, 110];
  const m = periodReturns(t, e, 'month');
  assert.deepEqual(m.map((p) => p.key), ['2024-01']);
  assert.ok(near(m[0].ret, 0.1, 1e-12));
  assert.equal(m[0].partial, false);
  const y = periodReturns(t, e, 'year');
  assert.deepEqual(y.map((p) => [p.key, p.partial]), [['2024', true]]);
  assert.ok(near(y[0].ret, 0.1, 1e-12));
});

test('data that starts and ends a few days inside a year still covers it', () => {
  // Mon 2021-01-04 is 3 days in, Fri 2021-12-31 is the last day.
  const [full] = periodReturns([d(2021, 1, 4), d(2021, 6, 30), d(2021, 12, 31)], [100, 110, 121], 'year');
  assert.equal(full.partial, false);
  assert.ok(near(full.ret, 0.21, 1e-12));
  // Wed 2021-01-06 is 5 days in.
  const [late] = periodReturns([d(2021, 1, 6), d(2021, 6, 30), d(2021, 12, 31)], [100, 110, 121], 'year');
  assert.equal(late.partial, true);
});

test('a month without data is skipped and the next month measures from the last value before the gap', () => {
  const m = periodReturns([d(2024, 1, 15), d(2024, 1, 31), d(2024, 3, 29)], [100, 110, 99], 'month');
  assert.deepEqual(m.map((p) => p.key), ['2024-01', '2024-03']);
  assert.ok(near(m[1].ret, 99 / 110 - 1, 1e-12));
});

test('sortino: mean over downside deviation, annualised', () => {
  // Three daily steps of +10%, -10%, +10%. Mean 0.1/3, downside deviation sqrt(0.01/3),
  // so the ratio is 1/sqrt(3) per step and the data has 3 steps in 3 days: 365.25 steps a year.
  const t = [0, 1, 2, 3].map((i) => d(2024, 1, 1) + i * DAY);
  assert.ok(near(sortino(t, [100, 110, 99, 108.9]), Math.sqrt(365.25 / 3), 1e-9));
});

test('sortino with cash returns measures returns above them, as computeStats does', () => {
  // Steps of +10%, -10%, +10% against 1% a step from cash: excess +9%, -11%, +9%.
  const t = [0, 1, 2, 3].map((i) => d(2024, 1, 1) + i * DAY);
  const equity = [100, 110, 99, 108.9];
  const cash = [0, 0.01, 0.01, 0.01];
  const expected = (0.07 / 3 / Math.sqrt(0.11 ** 2 / 3)) * Math.sqrt(365.25);
  assert.ok(near(sortino(t, equity, cash), expected, 1e-9));
  assert.ok(near(computeStats(t, equity, 100, [1, 1, 1, 1], cash).sortino, expected, 1e-9));
  assert.ok(near(deepStats(t, equity, cash).sortino, expected, 1e-9));
  // A series that starts later uses the cash returns from its own first value.
  assert.ok(near(deepStats([d(2023, 12, 31), ...t], [NaN, ...equity], [0, 0.5, ...cash.slice(1)]).sortino, expected, 1e-9));
});

test('sortino is 0 without a down step', () => {
  const t = [0, 1, 2, 3].map((i) => d(2024, 1, 1) + i * DAY);
  assert.equal(sortino(t, [100, 101, 101, 105]), 0);
});

test('sortino is 0 when the only falls are rounding noise', () => {
  const t = [0, 1, 2].map((i) => d(2024, 1, 1) + i * DAY);
  // A fall of 1e-14 has a downside deviation of 7e-15: below 1e-12, so it counts as none.
  assert.equal(sortino(t, [1, 1 - 1e-14, 1 + 2e-14]), 0);
});

test('a series that starts with NaN is measured from its first value', () => {
  // The first two points (November) have no value: the series starts at 110 on 15 December.
  const late = [NaN, NaN, ...A_E.slice(2)];
  assert.deepEqual(deepStats(A_T, late), deepStats(A_T.slice(2), A_E.slice(2)));
  const months = periodReturns(A_T, late, 'month');
  assert.deepEqual(months[0], { key: '2023-12', t: d(2023, 12, 1), ret: 121 / 110 - 1, partial: true });
  assert.equal(months.length, 4);
});

test('calmar: return per year over the worst drawdown', () => {
  // 365 days, 100 to 150 with a drop from 120 to 90 (-25%).
  const t = [d(2021, 1, 1), d(2021, 4, 1), d(2021, 9, 1), d(2022, 1, 1)];
  const perYear = 1.5 ** (365.25 / 365) - 1;
  assert.ok(near(calmar(t, [100, 120, 90, 150]), perYear / 0.25, 1e-9));
});

test('calmar is 0 without a drawdown', () => {
  assert.equal(calmar([d(2021, 1, 1), d(2021, 7, 1), d(2022, 1, 1)], [100, 100, 130]), 0);
});

test('rolling returns use the last point at or before t minus the window, across missing weekends', () => {
  // Fri 5, Mon 8, Tue 9, Fri 12, Mon 15, Fri 19 January 2024.
  const t = [d(2024, 1, 5), d(2024, 1, 8), d(2024, 1, 9), d(2024, 1, 12), d(2024, 1, 15), d(2024, 1, 19)];
  const e = [100, 102, 104, 106, 108, 110];
  // 7 days: Jan 12 looks back to Jan 5 exactly, Jan 15 to Jan 8, Jan 19 to Jan 12. Earlier points lack history.
  const week = rollingReturns(t, e, 7);
  assert.deepEqual(week.t, [d(2024, 1, 12), d(2024, 1, 15), d(2024, 1, 19)]);
  assert.ok(near(week.ret[0], 106 / 100 - 1, 1e-12));
  assert.ok(near(week.ret[1], 108 / 102 - 1, 1e-12));
  assert.ok(near(week.ret[2], 110 / 106 - 1, 1e-12));
  // 5 days: Jan 15 looks back to Wed Jan 10, which has no point, so it uses Tue Jan 9;
  // Jan 19 looks back to Sun Jan 14 and uses Fri Jan 12.
  const five = rollingReturns(t, e, 5);
  assert.deepEqual(five.t, [d(2024, 1, 12), d(2024, 1, 15), d(2024, 1, 19)]);
  assert.ok(near(five.ret[0], 106 / 100 - 1, 1e-12));
  assert.ok(near(five.ret[1], 108 / 104 - 1, 1e-12));
  assert.ok(near(five.ret[2], 110 / 106 - 1, 1e-12));
});

test('rolling returns are empty when no point has enough history', () => {
  const t = [d(2024, 1, 5), d(2024, 1, 8), d(2024, 1, 9)];
  assert.deepEqual(rollingReturns(t, [100, 102, 104], 30), { t: [], ret: [] });
});

// Day offsets from 2020-01-01.
const days = (...n: number[]) => n.map((x) => d(2020, 1, 1) + x * DAY);

test('underwater: longest stretch runs from the last high to the first point back at it', () => {
  // High 110 on day 1, back to 110 on day 4 (3 days). New high 120 on day 5, below until 125 on day 9 (4 days).
  const t = days(0, 1, 2, 3, 4, 5, 6, 7, 8, 9);
  const u = underwater(t, [100, 110, 105, 100, 110, 120, 90, 95, 119, 125]);
  assert.deepEqual(u, { longestDays: 4, longestFrom: t[5], longestTo: t[9], currentDays: 0 });
});

test('underwater: still below the high at the end', () => {
  const t = days(0, 1, 2, 3, 4, 5, 6, 7, 8, 9);
  const u = underwater(t, [100, 110, 105, 100, 110, 120, 90, 95, 119, 117]);
  assert.deepEqual(u, { longestDays: 4, longestFrom: t[5], longestTo: null, currentDays: 4 });
});

test('underwater: an earlier stretch can be longer than the one still open', () => {
  const t = days(0, 1, 2, 3, 4, 5, 6);
  // High 110 on day 1, back at 110 on day 5 (4 days); then a dip on day 6 is still open (1 day).
  const u = underwater(t, [100, 110, 100, 100, 100, 110, 105]);
  assert.deepEqual(u, { longestDays: 4, longestFrom: t[1], longestTo: t[5], currentDays: 1 });
});

test('underwater: nothing to report without a drawdown', () => {
  assert.deepEqual(underwater(days(0, 1, 2, 3), [100, 100, 101, 105]), { longestDays: 0, longestFrom: null, longestTo: null, currentDays: 0 });
});

test('underwater counts calendar days, not rows, when weekends are missing', () => {
  // Fri 5 Jan 100, Mon 8 Jan 90, Tue 9 Jan 95, Fri 12 Jan 100: four rows, seven days.
  const t = [d(2024, 1, 5), d(2024, 1, 8), d(2024, 1, 9), d(2024, 1, 12)];
  assert.deepEqual(underwater(t, [100, 90, 95, 100]), { longestDays: 7, longestFrom: t[0], longestTo: t[3], currentDays: 0 });
});

// Years 2018 (from mid-November) and 2021 (to the end of March) are partial; 2019 and 2020 are whole.
const S_T = [d(2018, 11, 15), d(2018, 12, 31), d(2019, 6, 30), d(2019, 12, 31), d(2020, 6, 30), d(2020, 12, 31), d(2021, 3, 31)];
const S_E = [100, 120, 90, 132, 100, 99, 108.9];

test('deepStats: best and worst year ignore partial years when a full year exists', () => {
  const s = deepStats(S_T, S_E);
  // 2018 (+20%, partial) and 2021 (+10%, partial) are left out; 2019 is 120 to 132 and 2020 is 132 to 99.
  assert.equal(s.bestYear?.key, '2019');
  assert.ok(near(s.bestYear!.ret, 0.1, 1e-12));
  assert.equal(s.worstYear?.key, '2020');
  assert.ok(near(s.worstYear!.ret, -0.25, 1e-12));
});

test('deepStats: month counts and extremes', () => {
  const s = deepStats(S_T, S_E);
  // Months: 2018-12 +20%, 2019-06 -25%, 2019-12 +46.7%, 2020-06 -24.2%, 2020-12 -1%, 2021-03 +10%.
  assert.equal(s.months, 6);
  assert.equal(s.positiveMonths, 0.5);
  assert.equal(s.bestMonth?.key, '2019-12');
  assert.ok(near(s.bestMonth!.ret, 132 / 90 - 1, 1e-12));
  assert.equal(s.worstMonth?.key, '2019-06');
  assert.ok(near(s.worstMonth!.ret, -0.25, 1e-12));
});

test('deepStats: time under water and the ratios come from the same series', () => {
  const s = deepStats(S_T, S_E);
  // High 132 on 2019-12-31 is never regained: 366 days of 2020 plus 90 days to 2021-03-31.
  assert.deepEqual(s.underwater, { longestDays: 456, longestFrom: d(2019, 12, 31), longestTo: null, currentDays: 456 });
  assert.equal(s.sortino, sortino(S_T, S_E));
  assert.equal(s.calmar, calmar(S_T, S_E));
  assert.ok(s.sortino > 0 && s.calmar > 0);
});

test('deepStats: a series shorter than a year falls back to the partial year', () => {
  const s = deepStats([d(2024, 3, 10), d(2024, 3, 20)], [100, 105]);
  assert.equal(s.bestYear?.key, '2024');
  assert.equal(s.worstYear?.key, '2024');
  assert.ok(near(s.bestYear!.ret, 0.05, 1e-12));
  assert.equal(s.months, 1);
  assert.equal(s.positiveMonths, 1);
});

test('deepStats: a flat series has no gains and no drawdown', () => {
  const s = deepStats([d(2024, 1, 2), d(2024, 2, 1), d(2024, 3, 1)], [100, 100, 100]);
  assert.equal(s.positiveMonths, 0);
  assert.equal(s.sortino, 0);
  assert.equal(s.calmar, 0);
  assert.deepEqual(s.underwater, { longestDays: 0, longestFrom: null, longestTo: null, currentDays: 0 });
});
