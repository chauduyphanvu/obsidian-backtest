import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { insideKey, type Trade } from '../src/engine.ts';
import { explainTrade } from '../src/explain.ts';
import { runBlock, serve, type FromWorker, type ToWorker } from '../src/jobs.ts';
import { randomEntries } from '../src/luck.ts';
import { runSweep, type Parse } from '../src/sweep.ts';
import { emptyBars, type Bars } from '../src/types.ts';
import { DAY, near } from './helpers.ts';

const HOUR = 3_600_000;

/**
 * Hourly bars and the daily bars they make up, from `start`: `hours` a day from `first` hours after midnight (7 from
 * 09:30, as a stock on Yahoo's exchange clock, or 24 from 00:00, as Binance), a gap of up to 6% between some days and of
 * up to 2% between some hours, and moves big enough that stops of a few percent are often inside a day.
 */
function market(seed: number, days: number, hours: number, first: number, weekdays: boolean, start = Date.UTC(2019, 0, 1)): { big: Bars; small: Bars } {
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const big = emptyBars();
  const small = emptyBars();
  let p = 50 + rnd() * 50;
  const drift = (rnd() - 0.4) * 0.002;
  for (let d = start; big.t.length < days; d += DAY) {
    if (weekdays && [0, 6].includes(new Date(d).getUTCDay())) continue;
    p *= 1 + (rnd() < 0.08 ? (rnd() - 0.5) * 0.12 : (rnd() - 0.5) * 0.004);
    const from = small.t.length;
    for (let j = 0; j < hours; j++) {
      const o = j === 0 ? p : p * (1 + (rnd() < 0.06 ? (rnd() - 0.5) * 0.04 : 0));
      const c = o * (1 + drift / hours + (rnd() - 0.5) * (0.08 / Math.sqrt(hours)));
      small.t.push(d + first * HOUR + j * HOUR);
      small.o.push(o);
      small.h.push(Math.max(o, c) * (1 + rnd() * 0.004));
      small.l.push(Math.min(o, c) * (1 - rnd() * 0.004));
      small.c.push(c);
      small.v.push(1000);
      p = c;
    }
    big.t.push(d);
    big.o.push(small.o[from]);
    big.h.push(Math.max(...small.h.slice(from)));
    big.l.push(Math.min(...small.l.slice(from)));
    big.c.push(p);
    big.v.push(1000 * hours);
  }
  return { big, small };
}

/** Prices for A to D, with their hours under insideKey, on Yahoo's clock (7 hours a weekday) or Binance's (24 a day). */
function prices(kind: 'yahoo' | 'binance', seed: number): Map<string, Bars> {
  const data = new Map<string, Bars>();
  ['A', 'B', 'C', 'D'].forEach((name, k) => {
    const m = kind === 'yahoo' ? market(seed + 17 * k, 420, 7, 9.5, true) : market(seed + 17 * k, 420, 24, 0, false);
    data.set(name, m.big);
    data.set(insideKey(name, '1h'), m.small);
  });
  return data;
}

const STRATEGIES = [
  'universe: A\ncosts: 5 bps\nslippage: 3 bps\nstop loss: 2%\ntake profit: 3%\nbuy when sma(5) crosses above sma(20)\nsell when sma(5) crosses below sma(20)',
  'universe: A, B\ntrailing stop: 2%\nbuy when close > sma(10)\nsell when close < sma(10) or bars held >= 15',
  'universe: A, B\ntrailing stop: 1.5 atr(10)\ntake profit: 2 atr(10)\nbuy when close > sma(8)\nsell when close < sma(8)',
  'universe: A, B, C, D\nhold: top 2 by roc(15)\nrebalance: weekly\nstop loss: 2%\ntake profit: 4%\nbuy when close > sma(30)',
  'universe: A\nentries: 3\nstop loss: 2%\ntake profit: 3%\ncommission: 1\nbuy when roc(3) > 0\nadd when close > last entry price\nsell when roc(3) < -2%',
  'universe: A, C\nrisk per trade: 1% at 2 atr(14)\nstop loss: 2 atr(14)\ntake profit: 1.5 atr(14)\nbuy when close > highest(10)[1]\nsell when close < lowest(10)[1]',
  'universe: A, B\nstop loss: 1.5%\ntrailing stop: 2%\ntake profit: 2.5%\nbuy when close > open',
  'universe: A 40%, B 30%, C 20%\nrebalance: monthly\ncommission: 0.01 per share, min 1\nstop loss: 3%\ntake profit: 2%\nbuy when close > ema(20)\nsell when close < ema(20) * 0.97',
];

function run(src: string, data: Map<string, Bars>): Backtest {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, [], src);
  return runBacktest(spec!, data);
}

/** A backtest without its inputs, its notes and what magnify recorded, to compare a run looked inside with one that is not. */
function bare(bt: Backtest) {
  const { spec: _spec, data: _data, notes: _notes, run, ...rest } = bt;
  const { inside: _inside, trades, ...r } = run;
  const plain = (t: Trade) => {
    if (t.why?.exit?.k !== 'level') return t;
    const { inside: _how, ...exit } = t.why.exit;
    return { ...t, why: { ...t.why, exit } };
  };
  return { ...rest, run: { ...r, trades: trades.map(plain) } };
}

test('with each bar its own one smaller bar, every strategy gives exactly the result it gives without magnify', () => {
  let walked = 0;
  for (const seed of [3, 11]) {
    const data = prices('yahoo', seed);
    const own = new Map(data);
    for (const name of ['A', 'B', 'C', 'D']) {
      const b = data.get(name)!;
      own.set(insideKey(name, '1h'), { ...b, t: b.t.map((t) => t + 9.5 * HOUR) });
    }
    for (const src of STRATEGIES) {
      for (const fill of ['', '\nfill: close']) {
        const plain = run(src + fill, data);
        const looked = run(`${src + fill}\nmagnify: 1h`, own);
        assert.deepStrictEqual(bare(looked), bare(plain), src + fill);
        assert.ok(plain.notes.every((n) => looked.notes.includes(n)));
        walked += looked.run.inside!.reduce((s, r) => s + r.looked, 0);
      }
    }
  }
  assert.ok(walked > 500, `only ${walked} bars looked inside`);
});

test('without the setting nothing changes: hours in the prices are not read', () => {
  const data = prices('binance', 5);
  const without = new Map([...data].filter(([name]) => !name.includes(' ')));
  for (const src of STRATEGIES) {
    const a = run(`data: binance\n${src}`, data);
    const b = run(`data: binance\n${src}`, without);
    assert.deepStrictEqual({ ...a, data: null }, { ...b, data: null });
    assert.equal(a.run.inside, undefined);
  }
});

/** The bar indexes of `t` that a trade held through, stop checks included: from its entry bar, up to its exit bar for a sale at an open. */
function heldBars(t: Trade, bars: Bars, last: number): [number, number] {
  const first = bars.t.indexOf(t.entryT);
  return [first, t.reason === 'open' ? last : bars.t.indexOf(t.exitT) - (t.reason === 'signal' ? 1 : 0)];
}

test('magnify changes no trade that never had a level inside its bars, and nothing before the first exit it decides', () => {
  // Fixed stops and targets with no slippage, so a trade's levels and its trailing high can be worked out from it.
  const SIMPLE = [
    'universe: A, B\ncapital: 1000\nstop loss: 2%\ntake profit: 3%\nbuy when close > sma(5)\nsell when close < sma(5)',
    'universe: A, B\ncapital: 1000\ntrailing stop: 2.5%\nbuy when close > sma(10)\nsell when close < sma(10)',
    'universe: A, B, C\ncapital: 1000\nstop loss: 4%\ntrailing stop: 3%\ntake profit: 6%\nbuy when roc(2) > 0\nsell when roc(2) < 0 or bars held >= 6',
  ];
  let untouched = 0;
  let changed = 0;
  for (const kind of ['yahoo', 'binance'] as const) {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const data = prices(kind, seed);
      const head = kind === 'binance' ? 'data: binance\n' : '';
      for (const src of [...SIMPLE, ...STRATEGIES]) {
        const plain = run(head + src, data);
        const looked = run(`${head + src}\nmagnify: 1h`, data);
        // Before the first exit decided inside a bar, the two runs are the same at every close.
        const firstInside = Math.min(...looked.run.trades.filter((t) => t.why?.exit?.k === 'level' && t.why.exit.inside?.k === 'inside').map((t) => t.exitT));
        for (let k = 0; k < plain.run.t.length && plain.run.t[k] < firstInside; k++) assert.equal(looked.run.equity[k], plain.run.equity[k], `${src} at ${k}`);
        if (looked.run.equity.some((e, k) => e !== plain.run.equity[k])) changed++;
        if (!SIMPLE.includes(src)) continue;
        const spec = looked.spec;
        for (const t of plain.run.trades) {
          if (t.reason !== 'signal' && t.reason !== 'open') continue;
          const bars = data.get(t.asset)!;
          const why = t.why!;
          const trail = spec.stops[t.asset].trailingStop;
          const target = why.takeProfit ?? Infinity;
          let high = t.entryPrice;
          let inside = false;
          const [from, to] = heldBars(t, bars, bars.t.length - 1);
          for (let i = from; i <= to && !inside; i++) {
            const reach = Math.max(why.stopLoss ?? -Infinity, trail?.k === 'pct' ? Math.max(high, bars.h[i]) * (1 - trail.v) : -Infinity);
            inside = bars.l[i] <= reach || bars.h[i] >= target;
            high = Math.max(high, bars.h[i]);
          }
          if (inside) continue;
          const same = looked.run.trades.find((u) => u.asset === t.asset && u.entryT === t.entryT && u.entryPrice === t.entryPrice);
          if (!same) continue;
          assert.deepEqual([same.exitT, same.exitPrice, same.reason, same.ret, same.bars], [t.exitT, t.exitPrice, t.reason, t.ret, t.bars], `${src}\n${t.asset} ${t.entryT}`);
          untouched++;
        }
      }
    }
  }
  assert.ok(untouched > 200, `only ${untouched} trades compared`);
  assert.ok(changed > 20, `only ${changed} runs changed by magnify`);
});

test('every explanation of a run looked inside agrees with its trade, with either kind of fill and on either clock', () => {
  let checked = 0;
  let inside = 0;
  let atOpen = 0;
  let whole = 0;
  for (const kind of ['yahoo', 'binance'] as const) {
    const data = prices(kind, 7);
    // Some hours missing and some that do not match, so some bars are read whole.
    for (const name of ['A', 'B']) {
      const s = data.get(insideKey(name, '1h'))!;
      const keep = s.t.map((_, i) => i % 97 !== 5);
      const cut = (xs: number[]) => xs.filter((_, i) => keep[i]);
      data.set(insideKey(name, '1h'), { t: cut(s.t), o: cut(s.o), h: cut(s.h).map((x, i) => (i % 89 === 3 ? x * 1.05 : x)), l: cut(s.l), c: cut(s.c), v: cut(s.v) });
    }
    const head = kind === 'binance' ? 'data: binance\n' : '';
    for (const src of STRATEGIES) {
      for (const fill of ['', 'fill: close\n']) {
        const bt = run(`${head + fill + src}\nmagnify: 1h`, data);
        for (const t of bt.run.trades) {
          const ex = explainTrade(bt, t);
          const why = t.why!;
          const where = `${kind} ${fill + src}\n${ex.title}`;
          const f = ex.facts;
          assert.equal(f.reason, t.reason, where);
          assert.ok(near(f.entryPrice, t.entryPrice, 1e-12 * t.entryPrice), `entry: ${where}`);
          if (why.exit?.k === 'level') {
            assert.ok(near(f.level!, why.exit.level, 1e-9 * why.exit.level), `level ${f.level} vs ${why.exit.level}: ${where}`);
            if (why.exit.inside?.k === 'inside') {
              inside++;
              if (why.exit.atOpen) atOpen++;
              assert.ok(ex.sections.find((s) => s.id === 'sold')!.rows.some((r) => r.label.includes(' 1h bar starting ')), where);
            }
            if (why.exit.inside?.k === 'whole') whole++;
          }
          if (t.reason === 'stop loss') assert.ok(near(f.level!, why.stopLoss!, 1e-9 * f.level!), `stop loss level: ${where}`);
          if (t.reason === 'take profit') assert.ok(near(f.level!, why.takeProfit!, 1e-9 * f.level!), `target level: ${where}`);
          assert.ok(near(f.exitPrice, t.exitPrice, 1e-12 * t.exitPrice), `exit ${f.exitPrice} vs ${t.exitPrice}: ${where}`);
          assert.ok(near(f.ret, t.ret, 1e-12), `return ${f.ret} vs ${t.ret}: ${where}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 1000 && inside > 300 && atOpen > 10 && whole > 10, `${checked} trades, ${inside} exits inside a bar, ${atOpen} at a smaller bar's open, ${whole} read whole`);
});

test('the hours travel with the prices to every re-run: a single run in the worker, a sweep, random picks', async () => {
  const data = prices('binance', 9);
  const source = 'data: binance\nuniverse: A, B, C, D\nhold: top 2 by roc(n)\nn = 10 in 5..15 step 5\nstop loss: 2%\ntake profit: 3%\nmagnify: 1h';
  const parse: Parse = (overrides) => parseSpec(source, { overrides });
  const bt = runBacktest(parse({}).spec!, data);
  assert.ok(bt.run.inside!.every((r) => r.looked > 0));
  // The worker gets the prices once, as a structured clone, and runs the block on them.
  const out: FromWorker[] = [];
  const handle = serve((m) => out.push(structuredClone(m)), 0);
  await handle(structuredClone({ type: 'data', id: 1, data } satisfies ToWorker));
  await handle({ type: 'run', id: 2, data: 1, block: { source, defaults: {}, overrides: {} } });
  const ran = out.at(-1)!;
  assert.equal(ran.type, 'ran');
  if (ran.type === 'ran') assert.deepStrictEqual(ran.result.run, bt.run);
  assert.deepStrictEqual(runBlock({ source, defaults: {}, overrides: {} }, data).run, bt.run);
  // Every variant of a sweep is the backtest of its values, looked inside.
  const sweep = await runSweep(source, data, { parse, pause: () => Promise.resolve() });
  for (const point of sweep.points) {
    const variant = runBacktest(parse(point.values).spec!, data);
    assert.deepStrictEqual([point.trades, point.stats], [variant.run.trades.length, variant.stats]);
  }
  // Random picks keep the strategy's stops, so they are looked inside too: without the hours they come out otherwise.
  const picks = await randomEntries(bt, { seed: 4, runs: 6, pause: () => Promise.resolve() });
  const without = new Map([...data].filter(([name]) => !name.includes(' ')));
  const plain = await randomEntries(runBacktest(parse({}).spec!, without), { seed: 4, runs: 6, pause: () => Promise.resolve() });
  assert.equal(picks.mode, 'picks');
  assert.notDeepEqual(picks, plain);
});
