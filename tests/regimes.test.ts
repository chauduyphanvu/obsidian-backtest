import assert from 'node:assert/strict';
import { test } from 'node:test';
import { YEAR } from '../src/format.ts';
import { bucketStats, CRISES, crisesFor, crisisResults, regimeBuckets, regimePlan, resolveRegime, STOCK_REGIMES, type RunSeries } from '../src/regimes.ts';
import type { AssetRef } from '../src/types.ts';
import { bars, DAY, near } from './helpers.ts';

const day = (y: number, m: number, d: number, hour = 0) => Date.UTC(y, m - 1, d, hour);
const yahoo = (name: string): AssetRef => ({ name, source: 'yahoo', id: name });
const binance = (name: string): AssetRef => ({ name, source: 'binance', id: name });
const csv = (name: string): AssetRef => ({ name, source: 'csv', id: `${name}.csv` });

// A short average, so a hand-built series settles it within a few bars.
const trend = resolveRegime({ ticker: 'X', condition: 'close > sma(3)', title: 'X against its 3-day average', states: ['Above', 'Below'] });

test('the stock regimes read SPY, the VIX and the 10-year yield on Yahoo, and a Binance-only universe gets Bitcoin instead', () => {
  const stocks = regimePlan([yahoo('SPY')]);
  assert.equal(stocks.source, 'Yahoo');
  assert.deepEqual(stocks.refs.map((r) => `${r.source}:${r.id}`), ['yahoo:SPY', 'yahoo:^VIX', 'yahoo:^TNX']);
  assert.deepEqual(stocks.regimes.map((r) => r.condition), ['close > sma(200)', 'close >= 20', 'close > close[126]']);
  assert.equal(stocks.regimes[2].scaleWindow, 126);
  // 250 bars is the least any block loads, which covers a 200-day average and a 126-day lag.
  assert.equal(stocks.lookback, 250);

  const coins = regimePlan([binance('ETHUSDT'), binance('BTCUSDT')]);
  assert.equal(coins.source, 'Binance');
  assert.deepEqual(coins.refs.map((r) => `${r.source}:${r.id}`), ['binance:BTCUSDT']);
  assert.equal(coins.regimes.length, 2);
  // 30 returns, then the median of 365 of those.
  assert.equal(coins.lookback, 396);
});

test('a strategy that is not all on Binance, or has only a CSV file, gets the stock regimes', () => {
  assert.equal(regimePlan([yahoo('SPY'), binance('BTCUSDT')]).regimes.length, STOCK_REGIMES.length);
  const own = regimePlan([csv('prices')]);
  assert.equal(own.source, 'Yahoo');
  assert.deepEqual(own.refs.map((r) => r.name), ['SPY', '^VIX', '^TNX']);
});

test('Bitcoin’s falls are listed only for a strategy that trades on Binance', () => {
  assert.equal(crisesFor([yahoo('SPY')]).length, 8);
  assert.equal(crisesFor([csv('prices')]).length, 8);
  assert.equal(crisesFor([yahoo('SPY'), binance('BTCUSDT')]).length, 10);
  assert.deepEqual(crisesFor([binance('BTCUSDT')]).filter((c) => c.market === 'bitcoin').map((c) => c.peak), ['2017-12-17', '2021-11-10']);
});

test('every fall runs from an earlier day to a later one', () => {
  for (const c of CRISES) assert.ok(Date.parse(c.peak) < Date.parse(c.trough), c.name);
});

test('a state is not known before its average has enough bars, and a bar takes the state of its own close', () => {
  // Flat at 100, then a close of 150 on bar 4 lifts it over the 3-bar average (100, 100, 150 averages 116.7), and a fall back
  // to 100 on bar 6 takes it under (150, 150, 100 averages 133.3).
  const home = bars([100, 100, 100, 100, 150, 150, 100, 100]);
  // Bar 0 and 1 have too few bars for the average. A close equal to the average is below it.
  assert.deepEqual(regimeBuckets(trend, home, home.t), [-1, -1, 1, 1, 0, 0, 1, 1]);
});

test('with the state flipping at a bar, the step into that bar is still counted in the old state', () => {
  const home = bars([100, 100, 100, 100, 150, 150, 100, 100]);
  // The strategy gains 10% on the step into bar 4, the bar the market goes above its average, and 5% on the step after.
  const equity = [100, 100, 100, 100, 110, 115.5, 115.5, 115.5];
  const run: RunSeries = { t: home.t, equity, exposure: equity.map(() => 1), benchmark: equity.map(() => NaN) };
  const [above, below] = bucketStats(run, regimeBuckets(trend, home, run.t), 2);
  // Only the step into bar 5 (+5%) was taken in the state "above", which was known from the close of bar 4.
  assert.ok(near(above.strategy.value, 0.05, 1e-12));
  // The step into bar 4 (+10%) was taken while the state known was "below", so it does not flatter the state it created.
  assert.ok(near(below.strategy.value, 1.1 - 1, 1e-12));
});

test('a weekly strategy reads the daily state at the end of its week, and not the one that began after it', () => {
  // Daily bars on weekdays from Monday 2024-01-01. The close is 100 until Tuesday 01-16, then climbs 50 a day from
  // Wednesday 01-17, which puts it above its 3-day average from that day.
  const times: number[] = [];
  for (let d = 0; d < 35; d++) {
    const at = day(2024, 1, 1) + d * DAY;
    if ((new Date(at).getUTCDay() + 6) % 7 <= 4) times.push(at);
  }
  // Wednesday 01-17 is the 13th weekday of the series, index 12.
  const closes = times.map((_, i) => (i < 12 ? 100 : 100 + 50 * (i - 11)));
  const home = bars(closes, { times });
  assert.equal(times[12], day(2024, 1, 17));
  // Read day by day, the state turns on Wednesday.
  const daily = regimeBuckets(trend, home, times);
  assert.deepEqual([daily[11], daily[12]], [1, 0]);
  // Weekly bars start on Mondays. The bar of 01-08 ends on 01-15, before the climb; the bar of 01-15 ends on 01-22, after
  // Wednesday's and Friday's closes, so it is "above".
  const weeks = [0, 1, 2, 3, 4].map((w) => day(2024, 1, 1) + 7 * w * DAY);
  assert.deepEqual(regimeBuckets(trend, home, weeks), [1, 1, 0, 0, 0]);
});

test('an hourly strategy reads the day before until that day’s bar has ended', () => {
  const closes = [100, 100, 100, 100, 150, 150, 100, 100];
  const home = bars(closes, { start: day(2024, 1, 2) });
  // Hourly bars on 2024-01-06 (home bar 4, the day the market goes above its average) and the day after.
  const sameDay = [14, 15, 20].map((h) => day(2024, 1, 6, h));
  const nextDay = [14, 20].map((h) => day(2024, 1, 7, h));
  // The daily bar of the 6th ends at midnight, so the hours of the 6th still read the state of the 5th ("below").
  assert.deepEqual(regimeBuckets(trend, home, [...sameDay, ...nextDay]), [1, 1, 1, 0, 0]);
});

test('a jump of more than threefold between closes makes the state unknown until it is behind the window', () => {
  const lagged = resolveRegime({ ticker: 'Y', condition: 'close > close[3]', title: 'Y', states: ['Above', 'Below'], scaleWindow: 3 });
  // Quoted in tenths of a percent, then in percent from bar 5 (a tenfold fall).
  const home = bars([40, 41, 42, 43, 44, 4.5, 4.6, 4.7, 4.8, 4.9]);
  // Bars 5, 6 and 7 have the jump within their last 3 bars. Bar 8 compares 4.8 with bar 5's 4.5, both in the new scale.
  assert.deepEqual(regimeBuckets(lagged, home, home.t), [-1, -1, -1, 0, 0, -1, -1, -1, 0, 0]);
  // Without the guard the comparison across the jump reads a fall of 90% as a move.
  const unguarded = resolveRegime({ ticker: 'Y', condition: 'close > close[3]', title: 'Y', states: ['Above', 'Below'] });
  assert.deepEqual(regimeBuckets(unguarded, home, home.t).slice(5, 8), [1, 1, 1]);
});

test('Bitcoin’s volatility regime is unknown until a year of 30-day volatilities exists, then above or below their median', () => {
  const [, volatility] = regimePlan([binance('BTCUSDT')]).regimes;
  const swing = (n: number, size: number, from: number) => Array.from({ length: n }, (_, i) => from * (i % 2 === 0 ? 1 + size : 1 / (1 + size)));
  // 400 calm days (±2%), 60 much calmer (±0.2%), then 30 wild (±10%). Each series restarts at 100 after the one before.
  const closes: number[] = [];
  for (const [n, size] of [[400, 0.02], [60, 0.002], [30, 0.1]] as const) closes.push(...swing(n, size, 100));
  const home = bars(closes);
  const buckets = regimeBuckets(volatility, home, home.t);
  assert.equal(buckets[100], -1);
  // The first 30-day volatility is known on bar 30 and the median needs 365 of them.
  assert.equal(buckets[393], -1);
  assert.notEqual(buckets[394], -1);
  // At the end of the calm stretch the 30-day volatility is a tenth of what it was; at the end of the wild one it is five times.
  assert.equal(buckets[459], 1);
  assert.equal(buckets[489], 0);
});

test('a state is known only from data up to the bar: changing later prices does not change an earlier state', () => {
  const closes = [100, 100, 100, 100, 150, 150, 100, 100, 160, 90];
  const first = regimeBuckets(trend, bars(closes), bars(closes).t);
  const later = regimeBuckets(trend, bars([...closes.slice(0, 7), 5, 5, 5]), bars(closes).t);
  assert.deepEqual(later.slice(0, 7), first.slice(0, 7));
});

/** A run of daily bars from `closes`, with unit exposure unless given. */
const series = (equity: number[], more: Partial<RunSeries> = {}): RunSeries => ({
  t: equity.map((_, i) => day(2024, 1, 1) + i * DAY),
  equity,
  exposure: equity.map(() => 1),
  benchmark: equity.map(() => NaN),
  ...more,
});

test('figures for each state on a worked example: steps, shares, compounded returns, the benchmark’s, exposure and drawdown', () => {
  // Steps: +10%, -10%, +10%, -10%, +10%. The state at the close before each: unknown, 0, 1, 1, 0.
  const equity = [100, 110, 99, 108.9, 98.01, 107.811];
  const run = series(equity, { exposure: [0, 1, 1, 0.5, 0.25, 1], benchmark: [NaN, NaN, 100, 102, 101, 103.02] });
  const [first, second, unknown] = bucketStats(run, [-1, 0, 1, 1, 0, 0], 2);

  // State 0 takes steps 2 and 5: 0.9 * 1.1. Each is a stretch of its own, and the first falls 10% from its starting 110.
  assert.equal(first.steps, 2);
  assert.ok(near(first.share, 2 / 5, 1e-12));
  assert.ok(near(first.strategy.value, 0.9 * 1.1 - 1, 1e-12));
  assert.equal(first.strategy.perYear, false);
  assert.ok(near(first.exposure, 1, 1e-12));
  assert.ok(near(first.worstDrawdown, -0.1, 1e-12));
  // The benchmark's value is unknown on step 2, so only step 5 counts: 103.02 / 101.
  assert.ok(near(first.benchmark.value, 103.02 / 101 - 1, 1e-12));

  // State 1 takes steps 3 and 4: 1.1 * 0.9, from 99 up to 108.9 and down to 98.01.
  assert.ok(near(second.strategy.value, 1.1 * 0.9 - 1, 1e-12));
  assert.ok(near(second.exposure, (0.5 + 0.25) / 2, 1e-12));
  assert.ok(near(second.worstDrawdown, 98.01 / 108.9 - 1, 1e-12));
  assert.ok(near(second.benchmark.value, (102 / 100) * (101 / 102) - 1, 1e-12));

  // Step 1 is its own bucket, where nothing was known yet.
  assert.equal(unknown.steps, 1);
  assert.ok(near(unknown.strategy.value, 0.1, 1e-12));
  assert.ok(Number.isNaN(unknown.benchmark.value));
  assert.equal(unknown.worstDrawdown, 0);
  assert.equal(first.steps + second.steps + unknown.steps, 5);
});

test('the worst drawdown is within one unbroken stretch: a fall in another state is not carried over', () => {
  // State 0 gains 10%, state 1 falls 20%, then state 0 falls 5%. Measured against the 110 reached before, the fall at the
  // end would be 24%; within its own stretch, which starts at 88, it is 5%.
  const run = series([100, 110, 88, 83.6]);
  const [zero, one] = bucketStats(run, [0, 1, 0, 0], 2);
  assert.ok(near(zero.worstDrawdown, -0.05, 1e-12));
  assert.ok(near(one.worstDrawdown, -0.2, 1e-12));
  assert.ok(near(zero.strategy.value, 1.1 * 0.95 - 1, 1e-12));
});

test('a return is per year only when the steps of its state add up to a year or more', () => {
  // 400 daily steps of +0.1%.
  const equity = Array.from({ length: 401 }, (_, i) => 100 * 1.001 ** i);
  const long = bucketStats(series(equity), equity.map(() => 0), 1);
  assert.equal(long[0].strategy.perYear, true);
  const covered = 400 * DAY;
  assert.ok(near(long[0].strategy.value, (1.001 ** 400) ** (YEAR / covered) - 1, 1e-12));

  const short = bucketStats(series(equity.slice(0, 101)), new Array(101).fill(0), 1);
  assert.equal(short[0].strategy.perYear, false);
  assert.ok(near(short[0].strategy.value, 1.001 ** 100 - 1, 1e-12));
  // A state with no steps has nothing to report.
  assert.equal(short[1].steps, 0);
  assert.ok(Number.isNaN(short[1].exposure));
});

test('a state that covers a year in several stretches is per year', () => {
  // 200 days in, 100 out, 200 in: 400 days in the state, with the 100 in between taken by the other.
  const equity = Array.from({ length: 501 }, (_, i) => 100 * 1.001 ** i);
  const bucket = Array.from({ length: 501 }, (_, i) => (i >= 200 && i < 300 ? 1 : 0));
  const [state] = bucketStats(series(equity), bucket, 2);
  assert.equal(state.steps, 400);
  assert.equal(state.strategy.perYear, true);
});

test('the benchmark is annualised on its own steps, and is NaN where it has none', () => {
  const equity = Array.from({ length: 401 }, (_, i) => 100 * 1.001 ** i);
  const bench = equity.map((e, i) => (i < 300 ? NaN : e));
  const [state] = bucketStats(series(equity, { benchmark: bench }), equity.map(() => 0), 1);
  // 100 steps of benchmark: under a year, so a total.
  assert.equal(state.benchmark.perYear, false);
  assert.ok(near(state.benchmark.value, 1.001 ** 100 - 1, 1e-12));
  assert.equal(state.strategy.perYear, true);
  const [none] = bucketStats(series(equity), equity.map(() => 0), 1);
  assert.ok(Number.isNaN(none.benchmark.value));
});

test('buckets never change the series they are given', () => {
  const run = series([100, 110, 99, 108.9], { benchmark: [NaN, 100, 101, 102] });
  const before = JSON.stringify(run);
  bucketStats(run, [0, 1, 0, 1], 2);
  assert.equal(JSON.stringify(run), before);
});

/** Calendar days from 2020-02-01 to 2020-04-30, with a strategy that falls with the market from its peak day, 2020-02-19. */
function covid(start = day(2020, 2, 1), last = day(2020, 4, 30)): RunSeries {
  const t: number[] = [];
  for (let at = start; at <= last; at += DAY) t.push(at);
  const value = (at: number): number => {
    if (at <= day(2020, 2, 19)) return 100 + (at - day(2020, 2, 1)) / DAY / 18;
    if (at < day(2020, 3, 1)) return 95;
    if (at <= day(2020, 3, 23)) return 90;
    // Back at the peak's 101 on 2020-03-29: 90 on the 23rd, then 2 a day.
    return 90 + 2 * ((at - day(2020, 3, 23)) / DAY);
  };
  return {
    t,
    equity: t.map(value),
    exposure: t.map((at) => (at < day(2020, 3, 1) ? 1 : 0)),
    benchmark: t.map((at) => (at <= day(2020, 2, 19) ? 100 : at <= day(2020, 3, 23) ? 80 : 90)),
  };
}

const covidFall = CRISES.find((c) => c.name === 'Covid crash')!;

test('a fall is measured from the close of the peak day to the close of the trough day', () => {
  const [r] = crisisResults(covid(), [covidFall]);
  assert.equal(r.crisis, covidFall);
  // 101 on the peak day, 90 on the trough day.
  assert.ok(near(r.strategy, 90 / 101 - 1, 1e-12));
  assert.ok(near(r.benchmark, 80 / 100 - 1, 1e-12));
  assert.ok(near(r.worstDrawdown, 90 / 101 - 1, 1e-12));
  // The steps of 2020-02-20 to 2020-03-23: ten days of Feb at full exposure, then 23 days of March with none.
  assert.ok(near(r.exposure, 10 / 33, 1e-12));
});

test('a run is shown a fall only when it covers the peak day’s close and the trough day', () => {
  // Starts the day after the peak day: the close of the peak day is not in it.
  assert.deepEqual(crisisResults(covid(day(2020, 2, 20)), [covidFall]), []);
  // Starts on the peak day: its close is the first value.
  assert.equal(crisisResults(covid(day(2020, 2, 19)), [covidFall]).length, 1);
  // Ends the day before the trough day, then on it.
  assert.deepEqual(crisisResults(covid(day(2020, 2, 1), day(2020, 3, 22)), [covidFall]), []);
  assert.equal(crisisResults(covid(day(2020, 2, 1), day(2020, 3, 23)), [covidFall]).length, 1);
  // A run of a year that covers none of the falls.
  const none = series(Array.from({ length: 300 }, (_, i) => 100 + i));
  assert.deepEqual(crisisResults(none, CRISES), []);
});

test('only the falls a run covers are listed, in order', () => {
  const t: number[] = [];
  for (let at = day(2019, 12, 1); at <= day(2023, 1, 31); at += DAY) t.push(at);
  const equity = t.map((_, i) => 100 + i / 10);
  const found = crisisResults({ t, equity, exposure: t.map(() => 1), benchmark: equity }, CRISES).map((r) => r.crisis.name);
  assert.deepEqual(found, ['Covid crash', '2022 bear market', 'Bitcoin 2022']);
});

test('the date the strategy got back to its high from before the fall', () => {
  const [r] = crisisResults(covid(), [covidFall]);
  // The high before the fall is 101, on the peak day. 90 on 03-23, then 92, 94, 96, 98, 100, 102: back on 03-29.
  assert.deepEqual(r.recovery, { kind: 'back', t: day(2020, 3, 29) });
});

test('a strategy that never fell below its high says so, and one that is still below at the end says that', () => {
  const t = covid().t;
  const flat = { t, equity: t.map(() => 100), exposure: t.map(() => 0), benchmark: covid().benchmark };
  assert.deepEqual(crisisResults(flat, [covidFall])[0].recovery, { kind: 'held' });
  assert.equal(crisisResults(flat, [covidFall])[0].strategy, 0);
  assert.equal(crisisResults(flat, [covidFall])[0].worstDrawdown, 0);
  const stuck = { ...covid(), equity: t.map((at) => (at <= day(2020, 2, 19) ? 100 : 90)) };
  assert.deepEqual(crisisResults(stuck, [covidFall])[0].recovery, { kind: 'not' });
});

test('the high before the fall is the best value the run had before it, not the value on the peak day', () => {
  // Rose to 120, fell to 100 by the peak day, to 90 at the trough, and is back to 100 afterwards: still below 120.
  const t = covid().t;
  const equity = t.map((at) => (at < day(2020, 2, 10) ? 120 : at <= day(2020, 2, 19) ? 100 : at <= day(2020, 3, 23) ? 90 : 100));
  const r = crisisResults({ ...covid(), equity }, [covidFall])[0];
  assert.deepEqual(r.recovery, { kind: 'not' });
  // Back above 120 later gives the date.
  const later = t.map((at, i) => (at > day(2020, 4, 20) ? 125 : equity[i]));
  assert.deepEqual(crisisResults({ ...covid(), equity: later }, [covidFall])[0].recovery, { kind: 'back', t: day(2020, 4, 21) });
});

test('a benchmark whose prices start after the fall began has no figure for it', () => {
  const run = { ...covid(), benchmark: covid().t.map((at) => (at < day(2020, 3, 1) ? NaN : 85)) };
  assert.ok(Number.isNaN(crisisResults(run, [covidFall])[0].benchmark));
});

test('a weekly strategy takes the last bar that had ended by the close of each day', () => {
  // Weekly bars from Monday 2020-01-06. The peak day, Wednesday 02-19, is in the bar of 02-17, which ends on 02-24, so the
  // bar of 02-10 (ended 02-17) is the last ended by the close of 02-19. The trough day, Monday 03-23, closes 03-24: the bar of
  // 03-16 ended on 03-23, and the bar of 03-23 is still going.
  const t: number[] = [];
  for (let at = day(2020, 1, 6); at <= day(2020, 4, 27); at += 7 * DAY) t.push(at);
  const equity = t.map((at) => (at < day(2020, 2, 17) ? 100 : at < day(2020, 3, 23) ? 70 : 90));
  const run: RunSeries = { t, equity, exposure: t.map(() => 1), benchmark: equity };
  const [r] = crisisResults(run, [covidFall]);
  assert.ok(near(r.strategy, 70 / 100 - 1, 1e-12));
  // Cut at the bar of 03-16, the run has not reached the trough day.
  const part = (from: number, to: number): RunSeries => ({ t: t.slice(from, to), equity: equity.slice(from, to), exposure: t.slice(from, to).map(() => 1), benchmark: equity.slice(from, to) });
  assert.deepEqual(crisisResults(part(0, t.indexOf(day(2020, 3, 16)) + 1), [covidFall]), []);
  // A run that starts in the week of the peak day has no bar that had ended by its close.
  assert.deepEqual(crisisResults(part(t.indexOf(day(2020, 2, 17)), t.length), [covidFall]), []);
});

test('an hourly strategy takes the last hour of the peak day and of the trough day', () => {
  // Hours 14:00 to 20:00 UTC on weekdays from 2020-02-03 to 2020-03-31.
  const t: number[] = [];
  for (let d = day(2020, 2, 3); d <= day(2020, 3, 31); d += DAY) {
    const weekday = (new Date(d).getUTCDay() + 6) % 7;
    if (weekday < 5) for (let h = 14; h <= 20; h++) t.push(d + h * 3_600_000);
  }
  const equity = t.map((at) => (at < day(2020, 2, 20) ? 100 : at < day(2020, 3, 24) ? 80 : 90));
  const run: RunSeries = { t, equity, exposure: t.map(() => 1), benchmark: equity };
  const [r] = crisisResults(run, [covidFall]);
  assert.ok(near(r.strategy, 80 / 100 - 1, 1e-12));
});

test('crisisResults never changes the series it is given', () => {
  const run = covid();
  const before = JSON.stringify(run);
  crisisResults(run, CRISES);
  assert.equal(JSON.stringify(run), before);
});
