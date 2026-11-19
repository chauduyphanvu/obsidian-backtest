import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { priceFailure, type DataDeps } from '../src/data.ts';
import { parseSpec } from '../src/dsl.ts';
import { lookbackBars, Runner, type Waiting } from '../src/runner.ts';
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
  assert.equal(out.backtest.cashRateNote, 'Cash receives the bills rate');
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

/** A CSV file of `n` bars, `stepDays` apart from 1 January 2000, with closes 1, 2, 3, … */
const spaced = (n: number, stepDays: number) =>
  ['date,open,high,low,close', ...Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2000, 0, 1) + i * stepDays * 86_400_000).toISOString().slice(0, 10);
    return `${d},${i + 1},${i + 1},${i + 1},${i + 1}`;
  })].join('\n');

test("a CSV file's lookback is counted in its own bars, whatever the block's interval", async () => {
  // Weekly rows and a 100-bar average: the 400 days the daily interval would give hold only 57 weekly bars.
  const weekly = new Runner(deps({ 'w.csv': spaced(1500, 7) }));
  const w = weekly.parse('universe: csv:w.csv\nfrom: 2020-01-01\nbuy when close > sma(100)\nsell when close < sma(100)').spec!;
  const wd = (await weekly.loadPrices(w)).data.get('w')!;
  const before = wd.t.filter((t) => t < w.from!).length;
  assert.ok(before >= lookbackBars(w), `${before} weekly bars before "from", ${lookbackBars(w)} needed`);
  // A rising series is above its average from the first bar, so the buy seen at that close fills at the next open.
  const out = await weekly.run(w);
  const start = wd.t.findIndex((t) => t >= w.from!);
  assert.equal(out.backtest.run.trades[0]?.entryT, wd.t[start + 1]);

  // Minute rows: about as many bars as the lookback before "from", not the whole file.
  const minutes = ['date,open,high,low,close', ...Array.from({ length: 20_000 }, (_, i) => {
    const t = new Date(Date.UTC(2020, 0, 1) + i * 60_000).toISOString().slice(0, 16).replace('T', ' ');
    return `${t},1,1,1,1`;
  })].join('\n');
  const minute = new Runner(deps({ 'm.csv': minutes }));
  const m = minute.parse('universe: csv:m.csv\nfrom: 2020-01-10\nbuy when close > sma(300)').spec!;
  const md = (await minute.loadPrices(m)).data.get('m')!;
  const kept = md.t.filter((t) => t < m.from!).length;
  assert.ok(kept >= lookbackBars(m) && kept < 2 * lookbackBars(m), `${kept} minute bars kept before "from", ${lookbackBars(m)} needed`);

  // A daily file loads exactly as before: the block's daily interval already fits it.
  const daily = new Runner(deps({ 'd.csv': spaced(3000, 1) }));
  const dspec = daily.parse('universe: csv:d.csv\nfrom: 2005-01-01\nbuy when close > sma(50)').spec!;
  const dd = (await daily.loadPrices(dspec)).data.get('d')!;
  assert.equal(dd.t[0], dspec.from! - Math.ceil(lookbackBars(dspec) * 1.6) * 86_400_000);
});

test('a cash-rate ticker that cannot load says where the cash rate comes from', async () => {
  // A block with no cash rate line reads it from the settings, so the ticker named in the message is nowhere in the block.
  const runner = new Runner(deps({ 'prices/a.csv': csv([10, 11, 12]) }), { cashRate: 'csv:rates/missing.csv' });
  const { spec } = runner.parse('universe: csv:prices/a.csv\nbuy when close > 1');
  await assert.rejects(runner.run(spec!), /There is no file at rates\/missing\.csv\. The cash rate comes from this ticker\. The ticker is in the "cash rate" line of the block\. If the block has no such line, it is in the plugin setting "Interest on cash"\./);
  // The longer message keeps why it failed, for the step the card offers.
  await assert.rejects(runner.run(spec!), (e) => priceFailure(e)?.kind === 'csv');
});

test('loading prices tells how many tickers are in, of how many, and which are still on their way, in the block\'s order', async () => {
  const files: Record<string, string> = { 'a.csv': csv([10, 11, 12]), 'b.csv': csv([20, 21, 22]), 'c.csv': csv([5, 5, 5]) };
  // Each file comes when the test lets it, so the order they come in is the test's.
  const gates = new Map<string, () => void>();
  const d: DataDeps = {
    ...deps(files),
    readVaultFile: (path) => new Promise((resolve) => gates.set(path, () => resolve(files[path] ?? null))),
  };
  const runner = new Runner(d);
  const { spec } = runner.parse('universe: csv:a.csv, csv:b.csv\nbenchmark: csv:c.csv\nbuy when close > 1');
  const heard: [number, number, string[]][] = [];
  const loading = runner.loadPrices(spec!, false, (done, total, waiting: Waiting[]) => heard.push([done, total, waiting.map((w) => `${w.name} ${w.source} ${w.id}`)]));
  const turn = () => new Promise((r) => setTimeout(r, 0));
  await turn();
  gates.get('b.csv')!();
  await turn();
  gates.get('c.csv')!();
  gates.get('a.csv')!();
  await loading;
  assert.deepEqual(heard, [
    [0, 3, ['a csv a.csv', 'b csv b.csv', 'c csv c.csv']],
    [1, 3, ['a csv a.csv', 'c csv c.csv']],
    [2, 3, ['a csv a.csv']],
    [3, 3, []],
  ]);
  // A ticker that fails is done too, so the count never waits for it.
  const failing = new Runner(deps({ 'a.csv': csv([10, 11, 12]) }));
  const counts: number[] = [];
  const { spec: missing } = failing.parse('universe: csv:a.csv, csv:gone.csv\nbuy when close > 1');
  await assert.rejects(failing.loadPrices(missing!, false, (done) => counts.push(done)));
  assert.deepEqual(counts.slice(-1), [2]);
});
