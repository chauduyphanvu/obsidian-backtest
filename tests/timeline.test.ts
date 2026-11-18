// The run's timeline: every bar time of its tickers within its dates, once each and in order.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY } from './helpers.ts';

const HOUR = 3_600_000;

/** Bars at the given times, with closes that move so the strategy trades. */
const at = (times: number[]): Bars => bars(times.map((_, i) => 100 + 5 * Math.sin(i / 3)), { times });

test('the timeline holds each bar time of every ticker from the latest first bar on, once, however their calendars differ', () => {
  const stocks: number[] = [];
  for (let t = Date.UTC(1969, 11, 1); t <= Date.UTC(1970, 2, 31); t += DAY) if (![0, 6].includes(new Date(t).getUTCDay())) stocks.push(t);
  const coin = Array.from({ length: 120 }, (_, i) => Date.UTC(1969, 11, 1) + i * DAY);
  // Mondays only, starting later than the others; and a ticker whose bars fall at noon, between everyone else's.
  const weekly = coin.filter((t) => new Date(t).getUTCDay() === 1 && t >= Date.UTC(1969, 11, 15));
  const noon = stocks.filter((_, i) => i % 3 === 0).map((t) => t + 12 * HOUR);
  const data = new Map<string, Bars>([
    ['STK', at(stocks)],
    ['CRY', at(coin)],
    ['WK', at(weekly)],
    ['NOON', at(noon)],
  ]);
  for (const dates of ['', 'from: 1970-01-10\nto: 1970-03-01\n']) {
    const spec = parseSpec(`universe: binance:CRY, STK, WK, NOON\n${dates}rebalance: weekly\nbuy when close > sma(3)`).spec!;
    const run = runBacktest(spec, data).run;
    const from = Math.max(spec.from ?? -Infinity, ...[...data.values()].map((b) => b.t[0]));
    const to = spec.to ?? Infinity;
    const want = [...new Set([...data.values()].flatMap((b) => b.t.filter((t) => t >= from && t <= to)))].sort((x, y) => x - y);
    assert.deepEqual(run.t, want, dates || 'all dates');
    assert.equal(run.t[0], dates ? Date.UTC(1970, 0, 10) : Date.UTC(1969, 11, 15));
  }
});
