import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { parseSpec, type Defaults } from '../src/dsl.ts';
import type { Trade } from '../src/engine.ts';
import { benchFor, runJob, serve, type FromWorker, type Job, type ToWorker } from '../src/jobs.ts';
import { matchTurnover, pickRules, placeHoldings, randomEntries, randomPicks, randomTiming } from '../src/luck.ts';
import { randomPicksWorks, randomTimingWorks } from '../src/render-luck.ts';
import { makeRng, type Rng } from '../src/rng.ts';
import type { Bars } from '../src/types.ts';
import { bars } from './helpers.ts';

function walk(rng: Rng, n: number, vol: number): Bars {
  let c = 100;
  return bars(Array.from({ length: n }, () => (c *= 1 + (rng.next() - 0.48) * vol)), { start: Date.UTC(2015, 0, 1) });
}

function prices(names: string[], seed: number, n = 800, vol = 0.05): Map<string, Bars> {
  const rng = makeRng(seed);
  return new Map(names.map((name) => [name, walk(rng, n, vol)]));
}

function backtest(src: string, data: Map<string, Bars>, defaults: Partial<Defaults> = {}): Backtest {
  const { spec, errors } = parseSpec(src, { defaults });
  assert.deepEqual(errors, []);
  return runBacktest(spec!, data);
}

const mean = (x: number[]) => x.reduce((s, y) => s + y, 0) / x.length;

const ENTRIES = 'universe: A 60%, B 40%\ncosts: 5 bps\nentries: 3\nbuy when close > sma(10)\nadd when close > last entry price * 1.01\nsell when close < sma(10)';

/** What one holding looks like in bars: how long it lasts and where its entries fall, whichever bars it falls on. */
function shapes(trades: Trade[], bars: Bars): string[] {
  return trades
    .map((t) => `${t.bars}:${(t.entries ?? []).map((e) => bars.t.indexOf(e.t) - bars.t.indexOf(t.entryT)).join(',')}`)
    .sort();
}

test('placed holdings keep their later entries, and the same arrangement is drawn with or without them', () => {
  const lengths = [5, 8, 3, 6];
  const adds = [[2], [3, 6], [], [1, 4, 5]];
  const shape = (h: { entry: number; exit: number; adds?: number[] }) => `${h.exit - h.entry}:${(h.adds ?? []).join(',')}`;
  for (let seed = 1; seed <= 50; seed++) {
    const placed = placeHoldings(lengths, 10, 80, makeRng(seed), adds);
    assert.deepEqual(placed.map(shape).sort(), ['3:', '5:2', '6:1,4,5', '8:3,6']);
    // A holding with no later entries has no `adds` at all, as before.
    assert.ok(placed.every((h) => (h.exit - h.entry === 3) === !('adds' in h)));
    // Where the holdings sit does not depend on whether entries come with them.
    assert.deepEqual(
      placed.map(({ entry, exit }) => ({ entry, exit })),
      placeHoldings(lengths, 10, 80, makeRng(seed)),
    );
  }
  // Without entries a holding is exactly what it was.
  assert.deepEqual(placeHoldings([2, 2], 0, 5, makeRng(9)), [{ entry: 0, exit: 2 }, { entry: 3, exit: 5 }]);
});

test('a holding that has to give back a bar drops the entries that would fall outside it', () => {
  // Two holdings of 4 bars need 10 bars and 9 are free, so one gives a bar back. Its entry at bar 3 (or, for the other, the
  // one at bar 4) no longer falls inside it.
  const seen = new Set<string>();
  for (let seed = 1; seed <= 30; seed++) {
    const placed = placeHoldings([4, 4], 0, 8, makeRng(seed), [[1, 3], [2, 4]]);
    seen.add(placed.map((h) => `${h.exit - h.entry}:${h.adds}`).sort().join(' '));
  }
  assert.deepEqual([...seen].sort(), ['3:1 4:2', '3:2 4:1,3']);
});

test('random timing with entries keeps each position\'s number of entries and the bars between them', () => {
  const data = prices(['A', 'B'], 5);
  const bt = backtest(ENTRIES, data);
  const counts = (bt.run.trades as Trade[]).map((t) => t.entries!.length);
  assert.ok(counts.includes(1) && counts.includes(2) && counts.includes(3), `entries per trade: ${[...new Set(counts)]}`);
  for (let seed = 1; seed <= 10; seed++) {
    const v = randomTiming(bt, makeRng(seed));
    for (const name of ['A', 'B']) {
      const mine = (trades: Trade[]) => trades.filter((t) => t.asset === name);
      assert.deepEqual(shapes(mine(v.run.trades), data.get(name)!), shapes(mine(bt.run.trades), data.get(name)!));
      const own = mine(v.run.trades);
      for (let k = 1; k < own.length; k++) assert.ok(own[k].entryT > own[k - 1].exitT);
    }
    assert.ok(v.run.exposure.every((x) => x <= 1 + 1e-12));
    // Exposure follows the strategy's, where a position built in one go (before) sat at about 1.5 times as much.
    assert.ok(Math.abs(mean(v.run.exposure) / mean(bt.run.exposure) - 1) < 0.05, `${mean(v.run.exposure)} against ${mean(bt.run.exposure)}`);
  }
});

test('random timing with entries and fill: close keeps the entries and fills them at closes', () => {
  const data = prices(['A', 'B'], 6);
  const bt = backtest(ENTRIES.replace('entries: 3', 'entries: 3\nfill: close'), data);
  assert.ok(bt.run.trades.some((t) => (t.entries?.length ?? 0) === 3));
  for (let seed = 1; seed <= 5; seed++) {
    const v = randomTiming(bt, makeRng(seed));
    for (const name of ['A', 'B']) {
      const b = data.get(name)!;
      const mine = (trades: Trade[]) => trades.filter((t) => t.asset === name);
      assert.deepEqual(shapes(mine(v.run.trades), b), shapes(mine(bt.run.trades), b));
      for (const t of mine(v.run.trades)) for (const e of t.entries!) assert.equal(e.price, b.c[b.t.indexOf(e.t)]);
    }
  }
});

test('random timing pays the strategy\'s commission on every order it makes, in the setting or the plugin default', () => {
  const data = prices(['A', 'B'], 5);
  const fixed = backtest(ENTRIES.replace('costs: 5 bps', 'costs: 5 bps\ncommission: 5'), data);
  const defaulted = backtest(ENTRIES, data, { commission: { k: 'order', fee: 5 } });
  for (const bt of [fixed, defaulted]) {
    assert.ok(bt.run.commission! > 1000);
    for (let seed = 1; seed <= 5; seed++) {
      const run = randomTiming(bt, makeRng(seed)).run;
      // One order for each entry and each exit, so five times that.
      const orders = run.trades.reduce((s, t) => s + t.entries!.length + (t.reason === 'open' ? 0 : 1), 0);
      assert.equal(run.commission, orders * 5);
    }
  }
  // Without entries, only commission: each trade is two orders.
  const plain = backtest('universe: A\ncommission: 2\nbuy when close > sma(10)\nsell when close < sma(10)', data);
  const run = randomTiming(plain, makeRng(1)).run;
  assert.equal(run.commission, run.trades.reduce((s, t) => s + 1 + (t.reason === 'open' ? 0 : 1), 0) * 2);
});

test('random picks add to a position, with the strategy\'s own add rule', async () => {
  const data = prices(['A', 'B', 'C', 'D', 'E'], 4, 700, 0.03);
  const src = 'universe: A, B, C, D, E\nrebalance: monthly\ncosts: 5 bps\nentries: 2\nhold: top 2 by roc(20)\nbuy when close > sma(50)\nadd when close > last entry price * 1.02';
  const bt = backtest(src, data);
  assert.ok(bt.run.trades.some((t) => t.entries!.length === 2));
  const rules = pickRules(bt);
  assert.ok([...rules.values()].every((r) => r.add));
  const redraw = await matchTurnover(bt, rules, 1);
  let several = 0;
  for (let seed = 1; seed <= 5; seed++) {
    const run = randomPicks(bt, makeRng(seed), redraw, rules);
    several += run.trades.filter((t) => t.entries!.length > 1).length;
    assert.ok(run.exposure.every((x) => x <= 1 + 1e-12));
  }
  assert.ok(several > 0, 'random picks never added');
  // A ranking with no add rule makes none.
  assert.ok([...pickRules(backtest('universe: A, B, C\nhold: top 2 by roc(20)\nbuy when close > sma(50)', prices(['A', 'B', 'C'], 1))).values()].every((r) => r.add === null));
});

test('the whole random-entries check runs on a strategy with entries and commission, and holds the trade count fixed', async () => {
  const data = prices(['A', 'B'], 5);
  const bt = backtest(ENTRIES.replace('costs: 5 bps', 'costs: 5 bps\ncommission: 0.01 per share, min 1'), data);
  const r = await randomEntries(bt, { seed: 1, runs: 20 });
  assert.deepEqual([r.mode, r.skip, r.runs], ['timing', null, 20]);
  assert.ok(r.random.trades.every((n) => n === r.strategy.trades));
  assert.ok(r.random.cagr.every(Number.isFinite));
  const again = await randomEntries(bt, { seed: 1, runs: 20 });
  assert.deepEqual(again.random, r.random);
});

test('the section says what random tries keep, naming commission and entries only when the strategy has them', () => {
  assert.equal(
    randomTimingWorks({}),
    'Each try keeps the number of trades of each ticker and how long each trade was held, with the same weights, costs, slippage and cash rate. It puts those holdings at random dates. Stops are off, because the holding lengths include their exits.',
  );
  assert.equal(
    randomPicksWorks({}, '12 trades', 14),
    'Each try uses the same rules, dates, number held, stops and costs. But it ranks the tickers that the rules let it hold in a random sequence, not by the score. Each random pick stays for some time. Thus the tries trade approximately as frequently as the strategy (12 trades on average, compared with 14).',
  );
  const both = { commission: { k: 'order' as const, fee: 1 }, entries: 3 };
  assert.match(randomTimingWorks(both), /with the same weights, costs, commission, slippage, entries and cash rate\. It puts those holdings at random dates\. A position with more than one entry keeps its number of entries\. Its subsequent entries are the same number of bars after its first entry\. Stops are off/);
  assert.match(randomTimingWorks({ commission: both.commission }), /same weights, costs, commission, slippage and cash rate\. It puts those holdings at random dates\. Stops are off/);
  assert.match(randomPicksWorks(both, '1 trade', 1), /^Each try uses the same rules, dates, number held, stops, costs, commission and entries\. But it ranks/);
});

// ---------------------------------------------------------------- the worker's copy of the block

const DEFAULTS: Partial<Defaults> = { capital: 25_000, costBps: 5, commission: { k: 'share', fee: 0.01, min: 1, max: null } };

async function viaWorker(source: string, data: Map<string, Bars>, job: Job): Promise<unknown> {
  const out: FromWorker[] = [];
  const handle = serve((m) => out.push(structuredClone(m)), 0);
  const send = (m: ToWorker) => handle(structuredClone(m));
  await send({ type: 'data', id: 1, data });
  await send({ type: 'job', id: 7, data: 1, block: { source, defaults: DEFAULTS, overrides: {} }, job });
  const last = out[out.length - 1];
  assert.equal(last.type, 'done', JSON.stringify(last));
  return (last as { result: unknown }).result;
}

test('in the worker the entries and the commission come from the block\'s text and defaults, and the luck check gives what it gives here', async () => {
  const data = prices(['A', 'B'], 5);
  // `commission` comes from the plugin's default here, and `entries` from the block's own text.
  const source = ENTRIES;
  const { spec, errors } = parseSpec(source, { defaults: DEFAULTS });
  assert.deepEqual(errors, []);
  assert.deepEqual([spec!.entries, spec!.commission], [3, DEFAULTS.commission]);
  const bt = runBacktest(spec!, data);
  const here = await randomEntries(bt, { seed: 3, runs: 25 });
  const worker = await viaWorker(source, data, { kind: 'random', seed: 3, runs: 25 });
  assert.deepStrictEqual(worker, here);
  // The bench in the worker is the same block read the same way, so its run has the same entries and commission.
  const bench = benchFor({ source, defaults: DEFAULTS, overrides: {} }, data);
  assert.equal(bench.backtest().run.commission, bt.run.commission);
  assert.deepEqual(await runJob({ kind: 'random', seed: 3, runs: 25 }, bench), here);
  // Both differ from the same block run without them, so the check was not passing for the wrong reason.
  const without = await randomEntries(backtest(source.replace('entries: 3\n', '').replace(/add when.*\n/, ''), data), { seed: 3, runs: 25 });
  assert.notDeepEqual(without.random.cagr, here.random.cagr);
});

test('a ranking block with entries gives the same random picks in the worker and here', async () => {
  const data = prices(['A', 'B', 'C', 'D', 'E'], 4, 700, 0.03);
  const source = 'universe: A, B, C, D, E\nrebalance: monthly\nentries: 2\nhold: top 2 by roc(20)\nbuy when close > sma(50)\nadd when close > last entry price * 1.02';
  const bt = backtest(source, data, DEFAULTS);
  const here = await randomEntries(bt, { seed: 2, runs: 12 });
  assert.equal(here.mode, 'picks');
  assert.deepStrictEqual(await viaWorker(source, data, { kind: 'random', seed: 2, runs: 12 }), here);
});

// ---------------------------------------------------------------- strategies without entries are untouched

/** A digest of the random runs of strategies with neither entries nor commission, recorded before the luck checks learned about them. */
const NOTHING_NEW: Record<string, string> = {
  trend: 'dbb7e19123057834',
  stops: 'b5afed87a1d0da89',
  close: 'b1e3efbad0f6d7a1',
  rebalance: '38c68e44d0f63564',
  rank: 'f74c6e50cc931a33',
};

const PLAIN: Record<string, string> = {
  trend: 'universe: A\ncosts: 5 bps\nslippage: 3 bps\nbuy when close > sma(10)\nsell when close < sma(10)',
  stops: 'universe: A 60%, B 40%\ncosts: 10 bps\nslippage: 5 bps\nstop loss: 2%\nbuy when close > sma(5)\nsell when close < sma(5)',
  close: 'universe: A 50%, B 50%\nfill: close\nstop loss: 3%\ntrailing stop: 4%\nbuy when close > sma(8)\nsell when close < sma(8)',
  rebalance: 'universe: A 40%, B 30%, C 30%\nrebalance: monthly\ncosts: 5 bps\nbuy when close > sma(20)\nsell when close < sma(20)',
  rank: 'universe: A, B, C, D, E\nrebalance: monthly\ncosts: 5 bps\nhold: top 2 by roc(20)\nbuy when close > sma(50)',
};

async function digest(name: string): Promise<string> {
  const data = prices(['A', 'B', 'C', 'D', 'E'], 77, 700, 0.07);
  const bt = backtest(PLAIN[name], data);
  const parts: unknown[] = [];
  for (const seed of [1, 2, 3]) {
    if (bt.spec.rank) {
      const rules = pickRules(bt);
      const redraw = await matchTurnover(bt, rules, seed);
      const run = randomPicks(bt, makeRng(seed), redraw, rules);
      parts.push(redraw, run.trades, run.equity, run.exposure, run.cashReturn);
    } else {
      const v = randomTiming(bt, makeRng(seed));
      parts.push([...v.holdings], v.run.trades, v.run.equity, v.run.exposure, v.run.cashReturn);
    }
    parts.push(await randomEntries(bt, { seed, runs: 8 }));
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

test('strategies with no entries and no commission get exactly the random runs they got before', async () => {
  const got: Record<string, string> = {};
  for (const name of Object.keys(PLAIN)) got[name] = await digest(name);
  if (process.env.PRINT_DIGESTS) console.log(JSON.stringify(got, null, 2));
  assert.deepEqual(got, NOTHING_NEW);
});
