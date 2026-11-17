import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import type { DataDeps } from '../src/data.ts';
import { parseSpec } from '../src/dsl.ts';
import { lookbackBars, Runner } from '../src/runner.ts';
import { near } from './helpers.ts';

const csv = (closes: number[]) => ['date,open,high,low,close', ...closes.map((c, i) => `2020-01-0${i + 1},${c},${c},${c},${c}`)].join('\n');

function deps(files: Record<string, string>): DataDeps & { read: string[] } {
  const read: string[] = [];
  return {
    read,
    fetchText: () => Promise.reject(new Error('no network in tests')),
    readVaultFile: async (path) => {
      read.push(path);
      return files[path] ?? null;
    },
    cacheRead: async () => null,
    cacheWrite: async () => {},
    now: () => Date.UTC(2020, 1, 1),
  };
}

test('the runner parses with its defaults and loads the cash-rate ticker with the prices', async () => {
  const d = deps({ 'prices/a.csv': csv([10, 10, 10]), 'rates/bills.csv': csv([36.5, 36.5, 36.5]) });
  const runner = new Runner(d, { capital: 1000, cashRate: 'csv:rates/bills.csv' });
  const { spec, errors } = runner.parse('universe: csv:prices/a.csv\nlimit = 20\nbuy when close > limit', { limit: 11 });
  assert.deepEqual(errors, []);
  assert.deepEqual(spec!.cash, { k: 'ticker', ref: { name: 'bills', source: 'csv', id: 'rates/bills.csv' } });
  const out = await runner.run(spec!);
  assert.deepEqual(d.read.sort(), ['prices/a.csv', 'rates/bills.csv']);
  // Never invested: 1000 earns 36.5% a year for two one-day steps.
  assert.ok(near(out.backtest.run.equity[2], 1000 * 1.001 * 1.001));
  assert.ok(near(out.backtest.interest, 1000 * 1.001 * 1.001 - 1000));
  assert.equal(out.backtest.cashRateNote, 'Cash earns the bills rate');
});

const parsed = (src: string) => {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  return spec!;
};

test('lookbackBars: the longest chain of windows and lags in the spec, at least 250 bars', () => {
  assert.equal(lookbackBars(parsed('universe: A\nbuy when close > sma(200)')), 250);
  // Nested windows add, [n] adds n, and recursive indicators count five times their period.
  assert.equal(lookbackBars(parsed('universe: A\nbuy when sma(close, 300)[10] > 0')), 310);
  assert.equal(lookbackBars(parsed('universe: A\nbuy when sma(ema(close, 100), 50) > 0')), 550);
  assert.equal(lookbackBars(parsed('universe: A\nbuy when rsi(60) > 50')), 301);
  assert.equal(lookbackBars(parsed('universe: A\nbuy when macd_signal(12, 60, 9) > 0')), 345);
  assert.equal(lookbackBars(parsed('universe: A\nbuy when close crosses above highest(400)[1]')), 402);
  assert.equal(lookbackBars(parsed('universe: A\nbuy when roc(300) of SPY > 0')), 300);
  // The sell rule, the ranking score, stops and sizing count too.
  assert.equal(lookbackBars(parsed('universe: A\nbuy when true\nsell when close < sma(260)')), 260);
  assert.equal(lookbackBars(parsed('universe: A, B\nhold: top 1 by roc(270)')), 270);
  assert.equal(lookbackBars(parsed('universe: A\nbuy when true\nfor A:\n  trailing stop: 3 atr(60)')), 301);
  assert.equal(lookbackBars(parsed('universe: A\nrisk per trade: 1% at 2 atr(70)\nbuy when true')), 351);
  assert.equal(lookbackBars(parsed('universe: A, B\nweighting: inverse volatility(400)\nbuy when true')), 401);
});

test('lookbackBars: a period or lag set by a parameter with a range counts at the largest value of the range', () => {
  assert.equal(lookbackBars(parsed('universe: A\nslow = 200 in 100..300 step 50\nbuy when close > sma(slow)')), 300);
  // The declared value counts when it is the largest, and a parameter without a range counts as written.
  // (100..295 step 50 steps through 100 to 250, and the declared 290 is tried as well.)
  assert.equal(lookbackBars(parsed('universe: A\nslow = 290 in 100..295 step 50\nbuy when close > sma(slow)')), 290);
  assert.equal(lookbackBars(parsed('universe: A\nslow = 280\nbuy when close > sma(slow)')), 280);
  // Recursive indicators, nested windows, lags, ATR stops and sizing.
  assert.equal(lookbackBars(parsed('universe: A\nn = 20 in 10..100 step 10\nbuy when rsi(n) > 50')), 501);
  assert.equal(lookbackBars(parsed('universe: A\na = 100 in 50..150 step 50\nb = 50 in 20..120 step 50\nbuy when sma(ema(close, a), b) > 0')), 5 * 150 + 120);
  assert.equal(lookbackBars(parsed('universe: A\nlag = 5 in 1..300 step 50\nbuy when close > close[lag]')), 251);
  assert.equal(lookbackBars(parsed('universe: A\nn = 14 in 10..80 step 10\nbuy when true\nstop loss: 2 atr(n)')), 401);
  assert.equal(lookbackBars(parsed('universe: A\nn = 14 in 10..90 step 10\nrisk per trade: 1% at 2 atr(n)\nbuy when true')), 451);
  assert.equal(lookbackBars(parsed('universe: A, B\nn = 60 in 20..420 step 100\nweighting: inverse volatility(n)\nbuy when true')), 421);
  assert.equal(lookbackBars(parsed('universe: A, B\nn = 60 in 20..300 step 40\nhold: top 1 by roc(n)')), 300);
  // A period range reaching past what the parser accepts needs no more than its longest valid period.
  assert.equal(lookbackBars(parsed('universe: A\nn = 50 in 50..19950 step 100\nbuy when close > sma(n)')), 9950);
  // Any value of the range, as a sweep tries it, asks for the same history: the block's.
  const block = 'universe: A\nslow = 200 in 100..300 step 50\nbuy when close > sma(slow)';
  for (const slow of [100, 150, 300]) assert.equal(lookbackBars(parseSpec(block, { overrides: { slow } }).spec!), 300);
});

/** Hourly Binance klines from 1 July 2023 served page by page, with a cache in memory. */
function binance(n: number): DataDeps & { starts: number[] } {
  const T0 = Date.UTC(2023, 6, 1);
  const HOUR = 3_600_000;
  const rows: unknown[][] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const c = p * (1 + Math.sin(i / 7) * 0.01);
    rows.push([T0 + i * HOUR, String(p), String(Math.max(p, c) * 1.001), String(Math.min(p, c) * 0.999), String(c), '1', T0 + (i + 1) * HOUR - 1]);
    p = c;
  }
  const store = new Map<string, string>();
  const starts: number[] = [];
  return {
    starts,
    fetchText: async (url) => {
      const start = Number(new URL(url).searchParams.get('startTime'));
      starts.push(start);
      return JSON.stringify(rows.filter((r) => (r[0] as number) >= start).slice(0, 1000));
    },
    readVaultFile: async () => null,
    cacheRead: async (k) => store.get(k) ?? null,
    cacheWrite: async (k, v) => void store.set(k, v),
    now: () => T0 + n * HOUR,
  };
}

test('prices start the lookback before "from", whatever the cache holds, so a run gives the same answer every time', async () => {
  const d = binance(2500);
  const runner = new Runner(d);
  const A = parsed('universe: BTCUSDT\ndata: binance\ninterval: 1h\nfrom: 2023-09-01\nbuy when close > ema(30)\nsell when close < ema(30)');
  const since = Date.UTC(2023, 8, 1) - 250 * 3_600_000;
  const first = await runner.run(A);
  assert.equal(d.starts[0], since);
  assert.equal(first.data.get('BTCUSDT')!.t[0], since);
  // A run from an earlier date refreshes the saved prices with more history...
  await runner.run(parsed('universe: BTCUSDT\ndata: binance\ninterval: 1h\nfrom: 2023-07-05\nbuy when true'));
  // ...which the first block does not use: an EMA seeded earlier would differ.
  const again = await runner.run(A);
  assert.equal(again.data.get('BTCUSDT')!.t[0], since);
  assert.deepEqual(again.backtest.run.equity, first.backtest.run.equity);
  assert.ok(first.backtest.run.trades.length > 0);
});

test('a variant from the top of a range is as well served by the loaded prices as the declared value', async () => {
  const d = binance(2500);
  const runner = new Runner(d);
  const block = 'universe: BTCUSDT\ndata: binance\ninterval: 1h\nfrom: 2023-08-01\nslow = 100 in 50..400 step 50\nbuy when close > sma(slow)\nsell when close < sma(slow)';
  const out = await runner.run(parsed(block));
  const from = Date.UTC(2023, 7, 1);
  assert.equal(out.data.get('BTCUSDT')!.t[0], from - 400 * 3_600_000);
  // The variant with slow = 400, run on those prices as a sweep runs it, knows its average from the first bar.
  const variant = runBacktest(parseSpec(block, { overrides: { slow: 400 } }).spec!, out.data);
  assert.deepEqual(variant.notes, []);
  assert.equal(variant.run.t[0], from);
});

test('daily and longer intervals reach 1.6 times as far back, for days without trading', async () => {
  const asked: number[] = [];
  const runner = new Runner({
    fetchText: async (url) => {
      asked.push(Number(new URL(url).searchParams.get('startTime')));
      return '[]';
    },
    readVaultFile: async () => null,
    cacheRead: async () => null,
    cacheWrite: async () => {},
    now: () => Date.UTC(2024, 0, 1),
  });
  await assert.rejects(runner.run(parsed('universe: BTCUSDT\ndata: binance\nfrom: 2023-06-01\nbuy when true')));
  assert.equal(asked[0], Date.UTC(2023, 5, 1) - 400 * 86_400_000);
});
