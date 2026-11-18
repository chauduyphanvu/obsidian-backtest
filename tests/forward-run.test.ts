import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maxDrawdown, runBacktest, spanStats, type Backtest } from '../src/backtest.ts';
import { extractBlocks } from '../src/blocks.ts';
import { parseSpec, type Defaults } from '../src/dsl.ts';
import { appendLog, forwardFigures, logRows, makeForward, newRows, parseForward, readLog, revisions, type LogRow } from '../src/forward.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY, T0 } from './helpers.ts';

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

function run(source: string, closes: Record<string, number[]>): Backtest {
  const { spec, errors } = parseSpec(source);
  assert.deepEqual(errors, []);
  return runBacktest(spec!, new Map(Object.entries(closes).map(([name, c]): [string, Bars] => [name, bars(c)])));
}

const words = (rows: LogRow[]) => rows.map((r) => [day(r.t), r.orders.map((o) => `${o.action} ${o.ticker} ${o.close}`)]);

test('a rule strategy logs the bar each order was read at: buys, sells and the order still waiting', () => {
  const closes = [10, 11, 13, 14, 15, 11, 10, 13, 14, 15, 16];
  const bt = run('universe: A\nbuy when close > 12\nsell when close < 12', { A: closes });
  assert.deepEqual(words(logRows(bt)), [
    ['2020-01-03', ['buy A 13']],
    ['2020-01-06', ['sell A 11']],
    ['2020-01-08', ['buy A 13']],
  ]);
  // The run fills those at the next open: the buy on the 4th, the sell on the 7th, the second buy on the 9th.
  assert.deepEqual(bt.run.trades.map((t) => [day(t.entryT), t.reason === 'open' ? null : day(t.exitT)]), [['2020-01-04', '2020-01-07'], ['2020-01-09', null]]);

  const waiting = run('universe: A\nbuy when close > 12\nsell when close < 12', { A: [10, 11, 13] });
  assert.deepEqual(words(logRows(waiting)), [['2020-01-03', ['buy A 13']]]);
  assert.equal(waiting.run.trades.length, 0, 'nothing has filled yet, so the order comes from the last bar');
  assert.equal(logRows(waiting)[0].value, waiting.run.equity[2]);
});

test('with fill: close the order is dated at the bar it filled at', () => {
  const bt = run('universe: A\nbuy when close > 12\nsell when close < 12\nfill: close', { A: [10, 11, 13, 14, 15, 11, 10, 13, 14, 15] });
  assert.deepEqual(words(logRows(bt)), [
    ['2020-01-03', ['buy A 13']],
    ['2020-01-06', ['sell A 11']],
    ['2020-01-08', ['buy A 13']],
  ]);
  assert.deepEqual(bt.run.trades.map((t) => day(t.entryT)), ['2020-01-03', '2020-01-08']);
});

test('the bar each order is dated at is the one before its fill, or the same bar with fill: close, on a run of varied strategies', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + 12 * Math.sin(i / 4) + (i % 7));
  for (const fill of ['next open', 'close']) {
    for (const rules of ['buy when close > sma(5)\nsell when close < sma(5)', 'buy when rsi(3) < 40\nsell when rsi(3) > 60', 'entries: 2\nbuy when close > sma(8)\nadd when close > sma(4) * 1.02\nsell when close < sma(8)']) {
      const bt = run(`universe: A\nfill: ${fill}\n${rules}`, { A: closes });
      const rows = logRows(bt);
      const barsOf = bt.data.get('A')!.t;
      const next = (t: number) => (fill === 'close' ? t : barsOf[barsOf.indexOf(t) + 1]);
      const at = (action: string) => new Set(rows.filter((r) => r.orders.some((o) => o.action === action)).map((r) => next(r.t)));
      assert.ok(bt.run.trades.length > 2, `${fill}: ${rules}`);
      for (const trade of bt.run.trades) {
        assert.ok(at('buy').has(trade.entryT), `${fill} buy at ${day(trade.entryT)}`);
        if (trade.reason === 'signal') assert.ok(at('sell').has(trade.exitT), `${fill} sell at ${day(trade.exitT)}`);
      }
      // Every bar listed has a close of its own bar and a value.
      for (const r of rows) {
        assert.ok(r.orders.every((o) => o.close === bt.data.get(o.ticker)!.c[barsOf.indexOf(r.t)]));
        assert.equal(r.value, bt.run.equity[bt.run.t.indexOf(r.t)]);
      }
    }
  }
});

test('stops and targets and rebalancing are not orders the rules gave', () => {
  const stopped = run('universe: A\nbuy when close > 12\nsell when close < 12\nstop loss: 5%', { A: [10, 11, 13, 14, 15, 11, 10, 13, 14, 12] });
  assert.deepEqual(stopped.run.trades.map((t) => t.reason), ['stop loss', 'stop loss']);
  assert.deepEqual(words(logRows(stopped)), [['2020-01-03', ['buy A 13']], ['2020-01-08', ['buy A 13']]], 'the buys, and no sells');

  const a = [10, 11, 12, 11, 10, 9, 10, 11, 12, 13, 14, 15, 16, 14, 13, 12];
  const b = [10, 10, 10, 11, 12, 13, 12, 11, 10, 9, 8, 9, 10, 11, 12, 13];
  const balanced = run('universe: A 50%, B 50%\nrebalance: weekly\nbuy when true', { A: a, B: b });
  assert.deepEqual(words(logRows(balanced)), [['2020-01-01', ['buy A 10', 'buy B 10']]], 'rebalancing trades are left out');
});

test('a ranking strategy logs its decisions together: what it sold and what it bought at the same bar', () => {
  const bt = run('universe: A, B\nhold: top 1 by roc(1)\nbuy when true', {
    A: [10, 11, 12, 11, 10, 9, 10, 11, 12, 13],
    B: [10, 10, 10, 11, 12, 13, 12, 11, 10, 9],
  });
  assert.deepEqual(words(logRows(bt)), [
    ['2020-01-02', ['buy A 11']],
    ['2020-01-04', ['sell A 11', 'buy B 11']],
    ['2020-01-07', ['sell B 12', 'buy A 10']],
  ]);
});

test('an add and a pending add are logged as adds', () => {
  const bt = run('universe: A\nentries: 2\nbuy when close > 12\nadd when close > 14\nsell when close < 12', { A: [10, 11, 13, 14, 15, 16, 11, 10, 13, 14, 15] });
  assert.deepEqual(words(logRows(bt)), [
    ['2020-01-03', ['buy A 13']],
    ['2020-01-05', ['add A 15']],
    ['2020-01-07', ['sell A 11']],
    ['2020-01-09', ['buy A 13']],
    ['2020-01-11', ['add A 15']],
  ]);
  assert.equal(bt.run.states[0].pending, 'add');
});

test('a run with no trades and no waiting order has no rows', () => {
  assert.deepEqual(logRows(run('universe: A\nbuy when close > 100', { A: [10, 11, 12, 13] })), []);
});

test('spanStats gives what the test split gives, and the forward figures agree with it', () => {
  const closes = Array.from({ length: 120 }, (_, i) => 100 + 15 * Math.sin(i / 6) + i * 0.1);
  const bt = run('universe: A\ntest from: 1970-01-01\nbuy when close > sma(5)\nsell when close < sma(5)', { A: closes });
  const split = runBacktest(parseSpec(`universe: A\ntest from: ${day(T0 + 80 * DAY)}\nbuy when close > sma(5)\nsell when close < sma(5)`).spec!, bt.data);
  const [before, from] = split.segments!;
  assert.deepEqual(spanStats(split, 0, 80), { stats: before.stats, benchmarkStats: before.benchmarkStats });
  assert.deepEqual(spanStats(split, 80, 120), { stats: from.stats, benchmarkStats: from.benchmarkStats });

  const { t, equity } = bt.run;
  const started = t[99];
  const f = forwardFigures(t, equity, bt.benchmark.equity, started);
  const span = spanStats(bt, f.first, t.length);
  assert.equal(f.first, 100);
  assert.equal(f.strategy, span.stats.totalReturn);
  assert.equal(f.benchmark, span.benchmarkStats.totalReturn);
  assert.equal(f.worstFall, span.stats.maxDrawdown);
  assert.equal(f.worstFall, maxDrawdown(equity.slice(99)));
  assert.ok(span.stats.exposure >= 0 && span.stats.exposure <= 1);
});

test('a forward test from start to log: frozen text, a later run, new bars logged once, and a revision when prices change', () => {
  const defaults: Defaults = { capital: 10_000, costBps: 5, slippageBps: 0, cashRate: '0%', dataSource: 'yahoo' };
  const source = 'name: Swing\nuniverse: A\nbuy when close > sma(4)\nsell when close < sma(4)';
  const closes = Array.from({ length: 70 }, (_, i) => 100 + 10 * Math.sin(i / 3) + i * 0.05);
  const seen = closes.slice(0, 50);
  const first = runBacktest(parseSpec(source, { defaults }).spec!, new Map([['A', bars(seen)]]));
  const startedAt = first.run.t[first.run.t.length - 1];

  const made = makeForward({ source, defaults, started: startedAt, intraday: false, link: '[[Swing note#Swing]]', name: 'Swing' });
  assert.ok(made.ok);
  const block = extractBlocks(made.note, 'forward')[0];
  const { forward } = parseForward(block.source);
  assert.equal(forward!.started, startedAt);

  // Twenty bars later, the frozen text runs on the longer prices; its figures and log use only the bars after the start.
  const later = runBacktest(parseSpec(forward!.source).spec!, new Map([['A', bars(closes)]]));
  assert.equal(stableRun(later.run.equity.slice(0, 50)), stableRun(first.run.equity), 'the frozen text reads back as the same strategy, so the first 50 bars agree');
  const rows = logRows(later);
  const fresh = newRows({ forward: forward!, bars: [], checkedThrough: null }, rows);
  assert.ok(fresh.length >= 2 && fresh.every((r) => r.t > startedAt));

  const through = later.run.t[later.run.t.length - 1];
  const a = appendLog(made.note, block.line, rows, through, Date.UTC(2026, 10, 17, 12));
  assert.ok(a.ok);
  assert.equal(a.added, fresh.length);
  const again = appendLog(a.note, block.line, rows, through, Date.UTC(2026, 10, 17, 12));
  assert.ok(again.ok && again.note === a.note && again.added === 0);

  const log = readLog(a.note, block.line);
  assert.ok(log.ok);
  assert.deepEqual(revisions(log, rows), []);
  // The same bars with a changed price: an order near a threshold moves, and the log says where.
  const moved = closes.map((c, i) => (i === Math.floor((fresh[0].t - T0) / DAY) ? c - 30 : c));
  const rerun = runBacktest(parseSpec(forward!.source).spec!, new Map([['A', bars(moved)]]));
  const said = revisions(log, logRows(rerun));
  assert.equal(day(fresh[0].t), '2020-02-23');
  assert.equal(said[0].message, "The log says Buy A on 2020-02-23; today's prices give no order there.");
  assert.ok(said.every((r) => r.t >= fresh[0].t), 'bars before the changed price agree');
});

const stableRun = (xs: number[]) => JSON.stringify(xs);
