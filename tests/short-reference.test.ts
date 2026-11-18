import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { simulate, type SimParams, type Signals } from '../src/engine.ts';
import type { Bars } from '../src/types.ts';
import { DAY, T0 } from './helpers.ts';

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
  return { next, pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)], chance: (p: number) => next() < p };
}
type R = ReturnType<typeof rng>;

/** Daily prices from 100 with daily moves of about `vol`, and now and then a gap at the open of about `gap`. */
function walk(r: R, n: number, vol: number, gap = 0): Bars {
  const out: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = gap > 0 && r.chance(0.03) ? p * (1 + (r.next() - 0.5) * 2 * gap) : p * (1 + (r.next() - 0.5) * vol * 0.4);
    const c = o * (1 + (r.next() - 0.5) * 2 * vol);
    out.t.push(T0 + i * DAY);
    out.o.push(o);
    out.h.push(Math.max(o, c) * (1 + r.next() * vol * 0.5));
    out.l.push(Math.min(o, c) * (1 - r.next() * vol * 0.5));
    out.c.push(c);
    out.v.push(1000);
    p = c;
  }
  return out;
}

// ------------------------------------------------------------------ reflection

test('a short strategy on prices P trades as the mirrored long strategy does on C − P', () => {
  const C = 400;
  let compared = 0;
  let stopped = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed * 104729);
    const P = walk(r, 260, 0.02);
    if (P.l.some((x) => x <= 0) || P.h.some((x) => x >= C)) continue;
    // The mirror swaps highs and lows; the true range, so the ATR, is the same on both.
    const M: Bars = { t: P.t, o: P.o.map((x) => C - x), h: P.l.map((x) => C - x), l: P.h.map((x) => C - x), c: P.c.map((x) => C - x), v: P.v };
    const common = `capital: 10000\nborrow fee: 0%\nmargin rate: 0%\nstop loss: 2 atr(5)\ntake profit: 3 atr(5)\ntrailing stop: 2.5 atr(5)${r.chance(0.5) ? '\nfill: close' : ''}`;
    const long = parseSpec(`universe: A\n${common}\nbuy when close > sma(10)\nsell when close < sma(20) or bars held >= 15 or close < entry price - 6`).spec!;
    const short = parseSpec(`universe: A\n${common}\nshort when close < sma(10)\ncover when close > sma(20) or bars held >= 15 or close > entry price + 6`).spec!;
    assert.ok(long && short && short.margin && !long.margin);
    const a = runBacktest(long, new Map([['A', M]])).run.trades;
    const b = runBacktest(short, new Map([['A', P]])).run.trades;
    const where = `seed ${seed}`;
    assert.equal(b.length, a.length, where);
    assert.ok(a.length > 3, where);
    a.forEach((x, i) => {
      const y = b[i];
      assert.deepEqual([y.side, y.entryT, y.exitT, y.reason, y.bars], ['short', x.entryT, x.exitT, x.reason, x.bars], `${where}, trade ${i}`);
      assert.ok(Math.abs(y.entryPrice - (C - x.entryPrice)) <= 1e-9 * C, `${where}, trade ${i}: entry ${y.entryPrice} against ${C - x.entryPrice}`);
      assert.ok(Math.abs(y.exitPrice - (C - x.exitPrice)) <= 1e-9 * C, `${where}, trade ${i}: exit ${y.exitPrice} against ${C - x.exitPrice}`);
      if (x.reason.includes('stop') || x.reason === 'take profit') stopped++;
    });
    compared += a.length;
  }
  assert.ok(compared > 300 && stopped > 60, `${compared} trades, ${stopped} by stops or targets`);
});

// ------------------------------------------------------------------ an independent reference

const CAPITAL = 10_000;

interface Case {
  bars: Bars;
  weight: number;
  cost: number;
  slip: number;
  cashRate: number;
  borrowFee: number;
  marginRate: number;
  buy: number[];
  sell: number[];
  short: number[];
  cover: number[];
}

/**
 * One ticker, next-open fills, no commission and no stops, written from the rules as stated rather than from the engine:
 * the balance (cash less the shorts at the last closes) earns the cash rate or pays the margin rate, shorts pay the borrow
 * fee, a position closes on its exit rule or the other side's entry rule and flips when the other entry holds alone, a
 * margin call at a close sells everything at the next open, and equity at 0 or below with a position open ends the run.
 */
function reference(c: Case): { equity: number[]; calls: number; ruined: boolean; flips: number; conflicts: number; shorts: number } {
  const { o, h, l, c: close, t } = c.bars;
  const L = Math.min(2, Math.max(1, c.weight));
  let cash = CAPITAL;
  let q = 0;
  let pending: 'buy' | 'sell' | 'short' | 'cover' | null = null;
  let called = false;
  let ruined = false;
  const armed = { buy: true, short: true };
  const stats = { calls: 0, flips: 0, conflicts: 0, shorts: 0 };
  const equity: number[] = [];
  const closeAt = (px: number) => {
    if (q > 0) {
      const v = q * px * (1 - c.slip);
      cash += v - v * c.cost;
    } else if (q < 0) {
      const v = -q * px * (1 + c.slip);
      cash -= v + v * c.cost;
    }
    q = 0;
  };
  const ruins = (e: number) => e < 0 || (e <= 0 && q !== 0);
  void h;
  void l;
  for (let k = 0; k < t.length; k++) {
    if (k > 0 && !ruined) {
      const span = t[k] - t[k - 1];
      const r = (c.cashRate * span) / DAY / 365;
      const balance = cash - (q < 0 ? -q * close[k - 1] : 0);
      if (balance > 0) cash += balance * r;
      else if (balance < 0) cash -= (-balance * c.marginRate * span) / DAY / 365;
      if (q < 0) cash -= -q * ((close[k - 1] * c.borrowFee * span) / DAY / 365);
    }
    if (ruined) {
      equity.push(0);
      continue;
    }
    // The open: ruin first, then the margin call, then the orders of the last close.
    if (ruins(cash + q * o[k])) {
      closeAt(o[k]);
      ruined = true;
      equity.push(0);
      continue;
    }
    if (called) {
      closeAt(o[k]);
      called = false;
    }
    if (pending) {
      const sized = cash + q * o[k];
      if ((q > 0 && (pending === 'sell' || pending === 'short')) || (q < 0 && (pending === 'cover' || pending === 'buy'))) closeAt(o[k]);
      if (q === 0 && (pending === 'buy' || pending === 'short')) {
        // Long or short, the size is the weight of the equity before the orders, within the room L·E − gross.
        const x = Math.min(c.weight * sized, (cash + (L - 1) * sized) / (1 + c.cost));
        if (x > 0 && pending === 'buy') {
          cash -= x * (1 + c.cost);
          q = x / (o[k] * (1 + c.slip));
        } else if (x > 0) {
          cash += x - x * c.cost;
          q = -(x / (o[k] * (1 - c.slip)));
          stats.shorts++;
        }
      }
      pending = null;
    }
    // The close: ruin, then the rules.
    if (ruins(cash + q * close[k])) {
      closeAt(close[k]);
      ruined = true;
      equity.push(0);
      continue;
    }
    const want = { buy: c.buy[k] === 1, short: c.short[k] === 1 };
    const entry = { buy: want.buy && c.sell[k] !== 1, short: want.short && c.cover[k] !== 1 };
    const rearm = (side: 'buy' | 'short') => {
      if (!want[side]) armed[side] = true;
    };
    /** The other side opens at the same fill when its entry holds alone. */
    const flip = (side: 'buy' | 'short') => {
      if (entry.buy && entry.short) stats.conflicts++;
      else if (entry[side] && armed[side]) {
        pending = side;
        stats.flips++;
      }
    };
    if (q > 0) {
      rearm('short');
      if (c.sell[k] === 1 || want.short) {
        pending = 'sell';
        flip('short');
      }
    } else if (q < 0) {
      rearm('buy');
      if (c.cover[k] === 1 || want.buy) {
        pending = 'cover';
        flip('buy');
      }
    } else {
      rearm('buy');
      rearm('short');
      if (entry.buy && entry.short) stats.conflicts++;
      else if (entry.buy && armed.buy) pending = 'buy';
      else if (entry.short && armed.short) pending = 'short';
    }
    const e = cash + q * close[k];
    const gross = Math.abs(q) * close[k];
    if (!called && gross > 0 && e < 0.25 * gross) {
      stats.calls++;
      called = true;
      pending = null;
      armed.buy = armed.short = false;
    }
    equity.push(e);
  }
  return { equity, ruined, ...stats };
}

function randomCase(r: R): Case {
  const n = 120 + Math.floor(r.next() * 100);
  const bars = walk(r, n, r.pick([0.01, 0.02, 0.04]), r.pick([0, 0.2, 0.4, 0.8]));
  const signal = (p: number) => bars.t.map(() => (r.chance(p) ? 1 : 0));
  return {
    bars,
    weight: r.pick([0.5, 1, 1.5, 2, 2]),
    cost: r.pick([0, 0.001, 0.005]),
    slip: r.pick([0, 0.0005, 0.002]),
    cashRate: r.pick([0, 0.03]),
    borrowFee: r.pick([0, 0.005, 0.2]),
    marginRate: r.pick([0, 0.06, 0.3]),
    buy: signal(r.pick([0.05, 0.15, 0.4])),
    sell: signal(r.pick([0, 0.1, 0.3])),
    short: signal(r.pick([0.05, 0.15, 0.4])),
    cover: signal(r.pick([0, 0.1, 0.3])),
  };
}

test('over random long, short and leveraged cases, the engine\'s equity is the reference\'s to 1e-9', () => {
  const seen = { calls: 0, ruins: 0, flips: 0, conflicts: 0, shorts: 0 };
  for (let seed = 1; seed <= 200; seed++) {
    const c = randomCase(rng(seed * 7907));
    const ref = reference(c);
    const params: SimParams = {
      assets: [{ name: 'A', source: 'yahoo', id: 'A', weight: c.weight }],
      from: null,
      to: null,
      capital: CAPITAL,
      costBps: c.cost * 10_000,
      slippageBps: c.slip * 10_000,
      rebalance: 'never',
      stops: {},
      cash: { k: 'fixed', rate: c.cashRate },
      sizing: { k: 'fixed' },
      rank: null,
      margin: { cap: Math.min(2, Math.max(1, c.weight)), borrowFee: c.borrowFee, rate: c.marginRate, maintenance: 0.25 },
    };
    const sig: Signals = { buy: c.buy, sell: (i) => c.sell[i], score: null, short: c.short, cover: (i) => c.cover[i] };
    // The costs and slippage in bps round-trip to the same fractions the reference uses.
    assert.equal(params.costBps / 10_000, c.cost);
    assert.equal(params.slippageBps / 10_000, c.slip);
    const run = simulate(params, new Map([['A', c.bars]]), new Map([['A', sig]]));
    const where = `seed ${seed}`;
    assert.equal(run.equity.length, ref.equity.length, where);
    run.equity.forEach((e, k) => assert.ok(Math.abs(e - ref.equity[k]) <= 1e-9 * CAPITAL, `${where}, bar ${k}: ${e} against ${ref.equity[k]}`));
    assert.equal(run.marginCalls, ref.calls, where);
    assert.equal(run.conflicts, ref.conflicts, where);
    assert.equal(run.ruin !== null, ref.ruined, where);
    assert.equal(run.trades.filter((t) => t.side === 'short').length, ref.shorts, where);
    seen.calls += ref.calls;
    seen.ruins += ref.ruined ? 1 : 0;
    seen.flips += ref.flips;
    seen.conflicts += ref.conflicts;
    seen.shorts += ref.shorts;
  }
  assert.ok(seen.calls > 20 && seen.ruins > 5 && seen.flips > 500 && seen.conflicts > 500 && seen.shorts > 1000, JSON.stringify(seen));
});
