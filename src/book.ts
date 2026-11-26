// Ambient "In My Book" Evaluation Mode: computes how any candidate strategy changes the user's Active Book
// (marginal Sharpe, Max DD, Calmar, worst-decile Tail-Drawdown Correlation, sleeve R^2 redundancy, and today's net
// transition share orders). Pure; zero Obsidian imports.

import type { Holding } from './account.ts';
import { computeStats, drawdowns, type Backtest, type Stats } from './backtest.ts';
import { alignCurves, type EntryRun } from './compare.ts';

export interface BookSleeve {
  name: string;
  weight: number;
  /** Daily/step returns aligned to `ActiveBookSnapshot.t`. */
  returns: number[];
  /** 1 where sleeve had non-zero exposure on that bar. */
  activeMask: Uint8Array;
}

export interface ActiveBookSnapshot {
  name: string;
  notePath: string;
  t: number[];
  equity: number[];
  returns: number[];
  drawdown: number[];
  stats: Stats;
  sleeves: BookSleeve[];
  holdings: Holding[];
  cash: number;
  capital: number;
  /** Latest known close price per ticker across all book sleeves (for valuing non-candidate holdings). */
  prices?: Record<string, number>;
  /** Weighted book cash-return series aligned to `t` (prevents candidate cash rate from leaking into `bookBefore.sharpe`). */
  cashReturn?: number[];
}

export interface SleeveRedundancy {
  sleeve: string;
  /** Squared return correlation [0..1]. */
  rSquared: number;
  /** Signed return correlation [-1..1]. */
  correlation: number;
  /** Jaccard overlap of active invested bars [0..1]. */
  activeOverlap: number;
}

export interface TransitionOrder {
  ticker: string;
  action: 'buy' | 'sell';
  deltaDollars: number;
  deltaShares: number;
  price: number;
}

export interface BookImpact {
  bookName: string;
  weight: number;
  suggestedWeight: number;
  t: number[];
  bookBeforeEquity: number[];
  bookAfterEquity: number[];
  bookBefore: Stats;
  bookAfter: Stats;
  deltaSharpe: number;
  /** Positive means blending the candidate reduced worst drawdown. */
  deltaMaxDD: number;
  deltaCalmar: number;
  /** Pearson correlation strictly on bars inside the Active Book's worst 10% drawdown decile. */
  tailDrawdownCorrelation: number;
  fullCorrelation: number;
  redundancy: SleeveRedundancy[];
  transitionOrders: TransitionOrder[];
  estimatedTurnoverDollars: number;
}

function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  const denom = Math.sqrt(va * vb);
  return denom > 1e-12 ? cov / denom : 0;
}

function calmar(s: Stats): number {
  if (!Number.isFinite(s.cagr) || !Number.isFinite(s.maxDrawdown)) return NaN;
  const dd = Math.abs(s.maxDrawdown);
  return dd > 1e-6 ? s.cagr / dd : s.cagr > 0 ? 10 : 0;
}

/** Builds a cached `ActiveBookSnapshot` from the sleeves of the user's Active Book `account` block. */
export function buildBookSnapshot(
  name: string,
  notePath: string,
  runs: EntryRun[],
  weights: number[],
  holdings: Holding[] = [],
  cash = 0,
  capital = 10_000,
): ActiveBookSnapshot | null {
  if (runs.length === 0) return null;
  const curves = runs.map((r) => ({ label: r.label, t: r.out.backtest.run.t, equity: r.out.backtest.run.equity }));
  let aligned: ReturnType<typeof alignCurves>;
  try {
    aligned = alignCurves(curves);
  } catch {
    return null;
  }
  if (!aligned || aligned.t.length < 3) return null;
  const n = aligned.t.length;
  const wSum = weights.reduce((s, w) => s + w, 0);
  const normWeights = wSum > 0 ? weights.map((w) => w / Math.max(1, wSum)) : weights.map(() => 1 / runs.length);

  // Collect latest close prices across every sleeve so `bookValue` values holdings even when candidate trades different tickers.
  const prices: Record<string, number> = {};
  for (const r of runs) {
    for (const st of r.out.backtest.run.states) {
      if (st.lastClose > 0) prices[st.name.toUpperCase()] = st.lastClose;
    }
  }

  // Per-sleeve returns & active masks on `aligned.t` (activeMask reads actual exposure, not |ret| > 0, so cash interest doesn't fake 100% overlap).
  const sleeves: BookSleeve[] = runs.map((r, idx) => {
    const eq = aligned.series[idx];
    const srcT = r.out.backtest.run.t;
    const srcExp = r.out.backtest.run.exposure;
    const returns = new Array<number>(n - 1);
    const activeMask = new Uint8Array(n - 1);
    let si = 0;
    for (let i = 1; i < n; i++) {
      const ret = eq[i - 1] > 0 ? eq[i] / eq[i - 1] - 1 : 0;
      returns[i - 1] = ret;
      while (si + 1 < srcT.length && srcT[si + 1] <= aligned.t[i]) si++;
      activeMask[i - 1] = srcT[si] <= aligned.t[i] && (srcExp[si] ?? 0) > 1e-9 ? 1 : 0;
    }
    return { name: r.label, weight: normWeights[idx], returns, activeMask };
  });

  // Daily-rebalanced combined book equity curve & book-own cash return series
  const equity = new Array<number>(n);
  const returns = new Array<number>(n - 1);
  const exposure = new Array<number>(n).fill(Math.min(1, wSum > 0 ? wSum : 1));
  const bookCash = new Array<number>(n).fill(0);
  const sleeveCursors = runs.map(() => 0);
  equity[0] = capital;
  for (let i = 1; i < n; i++) {
    let r = 0;
    let cr = 0;
    for (let s = 0; s < sleeves.length; s++) {
      r += sleeves[s].weight * sleeves[s].returns[i - 1];
      const st = runs[s].out.backtest.run.t;
      const sc = runs[s].out.backtest.run.cashReturn;
      let ci = sleeveCursors[s];
      while (ci + 1 < st.length && st[ci + 1] <= aligned.t[i]) ci++;
      sleeveCursors[s] = ci;
      if (st[ci] === aligned.t[i]) cr += sleeves[s].weight * (sc[ci] ?? 0);
    }
    returns[i - 1] = r;
    bookCash[i] = cr;
    equity[i] = equity[i - 1] * (1 + r);
  }
  const dd = drawdowns(equity);
  const stats = computeStats(aligned.t, equity, capital, exposure, bookCash);
  return { name, notePath, t: aligned.t, equity, returns, drawdown: dd, stats, sleeves, holdings, cash, capital, prices, cashReturn: bookCash };
}

/**
 * Evaluates adding `candidateBt` into `book` at allocation `weight` (0..0.5), computing marginal Sharpe/MaxDD/Calmar,
 * tail-drawdown correlation, sleeve redundancy, optimal weight, and today's net share transition orders.
 */
export function analyzeBookImpact(book: ActiveBookSnapshot, candidateBt: Backtest, weight = 0.15): BookImpact | null {
  let aligned: ReturnType<typeof alignCurves>;
  try {
    aligned = alignCurves([
      { label: book.name, t: book.t, equity: book.equity },
      { label: candidateBt.spec.name ?? 'Candidate', t: candidateBt.run.t, equity: candidateBt.run.equity },
    ]);
  } catch {
    return null;
  }
  if (aligned.t.length < 5) return null;
  const n = aligned.t.length;
  const bookEq = aligned.series[0].map((x) => (x * book.capital) / aligned.series[0][0]);
  const candEq = aligned.series[1];

  const bookRet = new Array<number>(n - 1);
  const candRet = new Array<number>(n - 1);
  const candActive = new Uint8Array(n - 1);
  const candT = candidateBt.run.t;
  const candExp = candidateBt.run.exposure;
  const candCash = candidateBt.run.cashReturn;
  const alignedCandCash = new Array<number>(n).fill(0);
  const alignedBookCash = new Array<number>(n).fill(0);
  const bookTimeMap = new Map<number, number>();
  for (let i = 0; i < book.t.length; i++) bookTimeMap.set(book.t[i], i);
  let ci = 0;
  for (let i = 1; i < n; i++) {
    bookRet[i - 1] = bookEq[i - 1] > 0 ? bookEq[i] / bookEq[i - 1] - 1 : 0;
    candRet[i - 1] = candEq[i - 1] > 0 ? candEq[i] / candEq[i - 1] - 1 : 0;
    while (ci + 1 < candT.length && candT[ci + 1] <= aligned.t[i]) ci++;
    candActive[i - 1] = candT[ci] <= aligned.t[i] && (candExp[ci] ?? 0) > 1e-9 ? 1 : 0;
    alignedCandCash[i] = candT[ci] === aligned.t[i] ? (candCash[ci] ?? 0) : 0;
    const bi = bookTimeMap.get(aligned.t[i]);
    alignedBookCash[i] = bi !== undefined && book.cashReturn ? (book.cashReturn[bi] ?? 0) : 0;
  }

  const blend = (w: number): { equity: number[]; stats: Stats } => {
    const eq = new Array<number>(n);
    const cashSeries = w === 0 ? alignedBookCash : alignedBookCash.map((c, i) => (1 - w) * c + w * alignedCandCash[i]);
    eq[0] = book.capital;
    for (let i = 1; i < n; i++) eq[i] = eq[i - 1] * (1 + (1 - w) * bookRet[i - 1] + w * candRet[i - 1]);
    return { equity: eq, stats: computeStats(aligned.t, eq, book.capital, new Array<number>(n).fill(1), cashSeries) };
  };

  const wClamped = Math.max(0, Math.min(0.5, weight));
  const before = blend(0);
  const after = blend(wClamped);

  // Suggest weight maximizing blended Sharpe across 5%..50% (0 if candidate never helps).
  let suggestedWeight = 0;
  let bestSharpe = before.stats.sharpe;
  for (let w = 0.05; w <= 0.501; w += 0.05) {
    const probe = blend(w);
    if (Number.isFinite(probe.stats.sharpe) && probe.stats.sharpe > bestSharpe + 0.005) {
      bestSharpe = probe.stats.sharpe;
      suggestedWeight = Number(w.toFixed(2));
    }
  }

  // Tail-drawdown correlation: restrict strictly to bars in the Active Book's worst 10% drawdown decile.
  const bookDd = drawdowns(bookEq);
  const sortedDd = [...bookDd.slice(1)].sort((a, b) => a - b);
  const decileCutoff = sortedDd[Math.max(2, Math.floor(sortedDd.length * 0.1))];
  const tailBook: number[] = [];
  const tailCand: number[] = [];
  for (let i = 1; i < n; i++) {
    if (bookDd[i] <= decileCutoff) {
      tailBook.push(bookRet[i - 1]);
      tailCand.push(candRet[i - 1]);
    }
  }
  const fullCorrelation = pearson(bookRet, candRet);
  const tailDrawdownCorrelation = tailBook.length >= 3 ? pearson(tailBook, tailCand) : fullCorrelation;

  // Sleeve redundancy against every existing sleeve in the Active Book (aligned by timestamp onto `aligned.t`, safe across stock/crypto calendars).
  const bookTimeToIdx = new Map<number, number>();
  for (let i = 1; i < book.t.length; i++) bookTimeToIdx.set(book.t[i], i - 1);
  const redundancy: SleeveRedundancy[] = book.sleeves
    .map((s) => {
      const alignedSleeveRet = new Array<number>(candRet.length);
      const alignedSleeveAct = new Uint8Array(candRet.length);
      let lastAct = 0;
      for (let i = 1; i < n; i++) {
        const bi = bookTimeToIdx.get(aligned.t[i]);
        if (bi !== undefined && bi < s.returns.length) {
          alignedSleeveRet[i - 1] = s.returns[bi];
          lastAct = s.activeMask[bi] ?? 0;
        } else {
          // Carried bar where sleeve's calendar had no new bar (0 return, carry previous exposure state).
          alignedSleeveRet[i - 1] = 0;
        }
        alignedSleeveAct[i - 1] = lastAct;
      }
      const corr = pearson(alignedSleeveRet, candRet);
      let both = 0;
      let either = 0;
      for (let i = 0; i < candActive.length; i++) {
        if (alignedSleeveAct[i] || candActive[i]) either++;
        if (alignedSleeveAct[i] && candActive[i]) both++;
      }
      return {
        sleeve: s.name,
        correlation: Number.isFinite(corr) ? corr : 0,
        rSquared: Number.isFinite(corr) ? corr * corr : 0,
        activeOverlap: either > 0 ? both / either : 0,
      };
    })
    .sort((a, b) => b.rSquared - a.rSquared);

  // Live Transition Ticket: scale existing book holdings by (1 - w) and add w * candidate targets so funding trims & overlaps net cleanly.
  const latestPrice = new Map<string, number>();
  for (const [k, v] of Object.entries(book.prices ?? {})) latestPrice.set(k.toUpperCase(), v);
  for (const st of candidateBt.run.states) latestPrice.set(st.name.toUpperCase(), st.lastClose);
  const currentDollars = new Map<string, number>();
  for (const h of book.holdings) {
    const tk = h.ticker.toUpperCase();
    const px = latestPrice.get(tk) ?? 0;
    if (px > 0) currentDollars.set(tk, (currentDollars.get(tk) ?? 0) + h.shares * px);
  }
  const holdingsVal = [...currentDollars.values()].reduce((s, v) => s + v, 0);
  const bookValue = Math.max(book.capital, book.cash + holdingsVal);
  const candidateBudget = bookValue * wClamped;
  const candEqNow = candidateBt.run.equity[candidateBt.run.equity.length - 1] || 1;
  const targetDollars = new Map<string, number>();
  for (const [tk, cur] of currentDollars) targetDollars.set(tk, cur * (1 - wClamped));
  for (const st of candidateBt.run.states) {
    if (st.side === null || !(st.lastClose > 0)) continue;
    const tk = st.name.toUpperCase();
    const shareOfCand = st.value / candEqNow;
    targetDollars.set(tk, (targetDollars.get(tk) ?? 0) + shareOfCand * candidateBudget);
  }
  const allTickers = new Set([...currentDollars.keys(), ...targetDollars.keys()]);
  const transitionOrders: TransitionOrder[] = [];
  for (const tk of allTickers) {
    const px = latestPrice.get(tk) ?? 0;
    if (!(px > 0)) continue;
    const delta = (targetDollars.get(tk) ?? 0) - (currentDollars.get(tk) ?? 0);
    if (Math.abs(delta) < 1) continue;
    transitionOrders.push({
      ticker: tk,
      action: delta >= 0 ? 'buy' : 'sell',
      deltaDollars: Math.abs(delta),
      deltaShares: Math.abs(delta) / px,
      price: px,
    });
  }
  // List funding sells before buys.
  transitionOrders.sort((a, b) => (a.action === b.action ? b.deltaDollars - a.deltaDollars : a.action === 'sell' ? -1 : 1));
  const estimatedTurnoverDollars = transitionOrders.reduce((s, o) => s + o.deltaDollars, 0);

  return {
    bookName: book.name,
    weight: wClamped,
    suggestedWeight,
    t: aligned.t,
    bookBeforeEquity: before.equity,
    bookAfterEquity: after.equity,
    bookBefore: before.stats,
    bookAfter: after.stats,
    deltaSharpe: (after.stats.sharpe ?? 0) - (before.stats.sharpe ?? 0),
    deltaMaxDD: (after.stats.maxDrawdown ?? 0) - (before.stats.maxDrawdown ?? 0),
    deltaCalmar: calmar(after.stats) - calmar(before.stats),
    tailDrawdownCorrelation,
    fullCorrelation,
    redundancy,
    transitionOrders,
    estimatedTurnoverDollars,
  };
}
