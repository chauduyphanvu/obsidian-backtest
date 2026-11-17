import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest, specSignals } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { insideKey, simulate, type FillSeen } from '../src/engine.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY } from './helpers.ts';

const HOUR = 3_600_000;
const J = (d: number) => Date.UTC(2020, 0, d);

function run(src: string, data: Map<string, Bars>) {
  const { spec, errors } = parseSpec(src);
  if (!spec) throw new Error(JSON.stringify(errors));
  return runBacktest(spec, data);
}

test('an add on the day a rebalancing trim is too small for its commission is sized from the position as it is', () => {
  // 2020-01-06 is a Monday, where the weekly rebalance wants to trim AAA by less than ten times the commission.
  const a = bars(Array.from({ length: 20 }, (_, i) => 100 * 1.004 ** i));
  const b = bars(Array.from({ length: 20 }, () => 50));
  const bt = run(`universe: AAA 50%, BBB 50%\ncapital: 10k\ncommission: 5\nentries: 2\nrebalance: weekly\nbuy when true\nadd when bars held >= 3`, new Map([['AAA', a], ['BBB', b]]));
  const tr = bt.run.trades.find((t) => t.asset === 'AAA')!;
  const add = tr.why!.adds![0];
  assert.equal(tr.entries![1].t, J(6));
  assert.ok(bt.run.smallTrades! > 0);
  const k = a.t.indexOf(J(6));
  // Nothing traded AAA between its entries: the trim on Monday was left undone.
  const shares = tr.entries!.reduce((s, e) => s + e.shares, 0);
  assert.ok(Math.abs(add.held - tr.entries![0].shares * a.o[k]) < 1e-9);
  assert.ok(shares * a.o[k] <= 0.5 * add.equity * (1 + 1e-12), `${shares * a.o[k]} against ${0.5 * add.equity}`);
  assert.ok(add.wanted < add.full / 2);
});

test('an add on a bar where a top-up still owed finds the position above its target is sized from the position as it is', () => {
  // BBB has no Monday bar. On Monday AAA's top-up finds too little cash, so the rest is owed; by Tuesday's open AAA has
  // risen above its target, so nothing is owed, and the add pending since Monday's close fills only up to the weight.
  const a = bars([100, 100, 100, 250, 300, 300], { times: [J(1), J(2), J(3), J(6), J(7), J(8)], opens: [100, 100, 100, 100, 300, 300] });
  const b = bars([50, 50, 250, 250, 250], { times: [J(1), J(2), J(3), J(7), J(8)], opens: [50, 50, 50, 250, 250] });
  const src = `universe: AAA 50%, BBB 40%\nentries: 2\nrebalance: weekly\nfor AAA:\n  buy when true\n  add when close > 200\nfor BBB:\n  buy when true\n  add when true`;
  const bt = run(src, new Map([['AAA', a], ['BBB', b]]));
  const tr = bt.run.trades.find((t) => t.asset === 'AAA')!;
  assert.equal(tr.why!.topUps, 1);
  assert.equal(tr.entries![1].t, J(7));
  const add = tr.why!.adds![0];
  const shares = bt.run.states[0].shares;
  assert.ok(Math.abs(add.held - (shares - tr.entries![1].shares) * 300) < 1e-6);
  assert.ok(shares * 300 <= 0.5 * add.equity * (1 + 1e-12), `${shares * 300} against ${0.5 * add.equity}`);
});

// ------------------------------------------------------------------ the long/flat promises over random strategies

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  return {
    next,
    int: (a: number, b: number) => a + Math.floor(next() * (b - a + 1)),
    pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  };
}
type R = ReturnType<typeof rng>;

/** Daily bars made of hourly ones (seven a weekday for a stock, 24 a day for crypto), and the hourly ones, sometimes scaled or with one missing. */
function series(r: R, days: number, crypto: boolean, price: number, vol: number): { daily: Bars; hourly: Bars } {
  const daily: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  const hourly: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let p = price;
  for (let d = 0; d < days; d++) {
    const t = J(1) + d * DAY;
    const wd = new Date(t).getUTCDay();
    if (!crypto && (wd === 0 || wd === 6)) continue;
    const n = crypto ? 24 : 7;
    if (!crypto && r.chance(0.3)) p *= 1 + (r.next() - 0.5) * 0.04;
    const hs: number[][] = [];
    for (let j = 0; j < n; j++) {
      const o = p;
      const c = o * (1 + (r.next() - 0.5) * 2 * vol);
      hs.push([o, Math.max(o, c) * (1 + r.next() * vol), Math.min(o, c) * (1 - r.next() * vol), c]);
      p = c;
    }
    daily.t.push(t);
    daily.o.push(hs[0][0]);
    daily.h.push(Math.max(...hs.map((x) => x[1])));
    daily.l.push(Math.min(...hs.map((x) => x[2])));
    daily.c.push(hs[n - 1][3]);
    daily.v.push(1000 + r.int(0, 1000));
    const k = r.chance(0.2) ? 1 / (0.9 + r.next() * 0.2) : 1;
    const drop = r.chance(0.05) ? r.int(0, n - 1) : -1;
    for (let j = 0; j < n; j++) {
      if (j === drop) continue;
      hourly.t.push(t + (crypto ? 0 : 9.5 * HOUR) + j * HOUR);
      for (const [key, x] of [['o', hs[j][0]], ['h', hs[j][1]], ['l', hs[j][2]], ['c', hs[j][3]]] as const) hourly[key].push(x * k);
      hourly.v.push(100);
    }
  }
  return { daily, hourly };
}

/** A random strategy mixing entries, commission, every sizing, ranking, rebalancing, both fills and magnify, with its prices. */
function randomCase(r: R): { text: string; data: Map<string, Bars> } {
  const names: { sym: string; name: string; crypto: boolean }[] = [];
  const stocks = r.int(1, 3);
  for (let i = 0; i < stocks; i++) names.push({ sym: ['AAA', 'BBB', 'CCC'][i], name: ['AAA', 'BBB', 'CCC'][i], crypto: false });
  if (r.chance(0.3)) names.push({ sym: 'binance:XUSDT', name: 'XUSDT', crypto: true });
  const days = r.int(120, 300);
  const magnify = r.chance(0.3);
  const data = new Map<string, Bars>();
  for (const n of names) {
    const s = series(r, days, n.crypto, r.pick([5, 20, 100, 400]), r.pick([0.003, 0.006, 0.012]));
    data.set(n.name, s.daily);
    if (magnify) data.set(insideKey(n.name, '1h'), s.hourly);
  }
  const ranked = names.length > 1 && r.chance(0.35);
  const weighted = !ranked && names.length > 1 && r.chance(0.5);
  const lines: string[] = [];
  if (weighted) {
    const parts = names.map(() => r.int(1, 5));
    const total = parts.reduce((s, x) => s + x, 0) * (r.chance(0.5) ? 1 : 1.25);
    lines.push(`universe: ${names.map((n, i) => `${n.sym} ${Math.max(1, Math.floor((100 * parts[i]) / total))}%`).join(', ')}`);
  } else lines.push(`universe: ${names.map((n) => n.sym).join(', ')}`);
  lines.push(`capital: ${r.pick(['1000', '10k', '100k', '2500'])}`);
  if (r.chance(0.5)) lines.push(`costs: ${r.pick([1, 5, 20, 50])} bps`);
  if (r.chance(0.4)) lines.push(`slippage: ${r.pick([1, 5, 20])} bps`);
  if (r.chance(0.7)) lines.push(`commission: ${r.pick(['1', '5', '0.5', '20', '0.005 per share', '0.005 per share, min 1', '0.01 per share, min 1, max 1%', '0.05 per share, max 0.5%', '2 per share, min 1'])}`);
  const steps = r.chance(0.7) ? r.int(2, 4) : 1;
  if (steps > 1) lines.push(`entries: ${steps}`);
  const rebalance = r.chance(0.5) ? r.pick(['weekly', 'monthly', 'quarterly']) : null;
  if (rebalance) lines.push(`rebalance: ${rebalance}`);
  const sizing = r.pick(rebalance || weighted ? ['none', 'none', 'invvol'] : ['none', 'none', 'risk', 'invvol']);
  if (sizing === 'risk') lines.push(`risk per trade: ${r.pick(['1%', '2%', '5%'])} at ${r.pick(['1', '2', '3'])} atr(${r.pick([5, 14])})`);
  if (sizing === 'invvol') lines.push(`weighting: inverse volatility(${r.pick([10, 20])})`);
  if (!weighted && names.length > 1 && r.chance(0.3)) lines.push(`size: ${r.pick(['50%', '80%'])}`);
  if (r.chance(0.5)) lines.push('fill: close');
  if (magnify) lines.push('magnify: 1h');
  if (r.chance(0.5)) lines.push(`stop loss: ${r.pick(['2%', '5%', '1 atr(5)', '3%'])}`);
  if (r.chance(0.4)) lines.push(`take profit: ${r.pick(['2%', '4%', '2 atr(5)'])}`);
  if (r.chance(0.3)) lines.push(`trailing stop: ${r.pick(['2%', '4%', '2 atr(5)'])}`);
  if (r.chance(0.2)) lines.push(`cash rate: ${r.pick(['2%', '5%'])}`);
  if (ranked) lines.push(`hold: top ${r.int(1, names.length)} by ${r.pick(['roc(10)', 'rsi(7)', '-stdev(10)', 'close / sma(20)'])}`);
  lines.push(`buy when ${r.pick(['close > sma(10)', 'rsi(5) < 40', 'true', 'close crosses above sma(5)', 'close > close[1]'])}`);
  if (r.chance(0.8)) lines.push(`sell when ${r.pick(['close < sma(20)', 'bars held >= 5', 'rsi(5) > 70', 'close < entry price * 0.97', 'bars held >= 15 or close < sma(30)'])}`);
  if (steps > 1) lines.push(`add when ${r.pick(['close > last entry price * 1.01', 'close < entry price * 0.98', 'true', 'bars held >= 3', 'close > close[1]'])}`);
  return { text: lines.join('\n'), data };
}

/** Within this share, a value is not above its limit: what floating-point arithmetic leaves over. */
const TOLERANCE = 1e-9;

test('over random strategies, cash is never below 0, a ticker bought or added to is within its weight, exposure is at most 100% and equity is finite', () => {
  let fills = 0;
  let adds = 0;
  let rebalancing = 0;
  let undone = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const c = randomCase(rng(seed * 7919));
    const { spec, errors } = parseSpec(c.text);
    assert.ok(spec, `${JSON.stringify(errors)}\n${c.text}`);
    const where = `seed ${seed}:\n${c.text}`;
    const onFill = (f: FillSeen) => {
      fills++;
      assert.ok(f.cash >= -TOLERANCE * spec.capital, `cash ${f.cash} after a ${f.kind} of ${f.asset} at ${f.t}, ${where}`);
      if (f.kind === 'entry' || f.kind === 'add' || f.kind === 'rebalance' || f.kind === 'owed') {
        if (f.kind === 'add') adds++;
        if (f.kind === 'rebalance' || f.kind === 'owed') rebalancing++;
        const value = f.shares * f.price;
        const limit = f.weight * f.equity;
        assert.ok(value <= limit * (1 + TOLERANCE), `${f.asset} worth ${value} after a ${f.kind} at ${new Date(f.t).toISOString()}, above ${limit}, ${where}`);
      }
    };
    const result = simulate({ ...spec, assets: spec.universe, onFill }, c.data, specSignals(spec, c.data));
    for (const x of result.exposure) assert.ok(x <= 1 + TOLERANCE, `exposure ${x}, ${where}`);
    for (const e of result.equity) assert.ok(Number.isFinite(e), `equity ${e}, ${where}`);
    for (const tr of result.trades) assert.ok((tr.entries?.length ?? 1) <= (spec.entries ?? 1), where);
    undone += result.smallTrades ?? 0;
  }
  // The strategies make enough trades of every kind, and leave enough undone for their commission, for the checks to mean something.
  assert.ok(fills > 15_000 && adds > 2_000 && rebalancing > 300 && undone > 500, `${fills} fills, ${adds} adds, ${rebalancing} top-ups, ${undone} left undone`);
});
