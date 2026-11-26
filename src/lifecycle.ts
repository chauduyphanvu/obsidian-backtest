// Continuous Reality Tape & Immutable Deployment Commits:
// Replaces forked `Backtests/Forward/` notes with in-place versioned deployment commits (`live since: YYYY-MM-DD @hash`),
// block-bootstrap return cones, and 3-track Model vs. Point-in-Time Shadow vs. Realized Broker Equity shortfall accounting.
// Pure; zero Obsidian imports.

import { computeStats, maxDrawdown, type Backtest } from './backtest.ts';
import type { Defaults } from './dsl.ts';
import { realizedEquitySeries, utcDay, type LedgerEvent } from './fill-ledger.ts';
import { isoDate } from './format.ts';
import { blockFor } from './luck.ts';
import { hash, stable } from './result-cache.ts';
import { makeRng } from './rng.ts';
import type { Bars } from './types.ts';

export interface SignalLogEntry {
  t: number;
  ticker: string;
  action: 'buy' | 'sell' | 'add' | 'short' | 'cover';
  /** Modeled close/open price observed when the signal was recorded live. */
  price: number;
}

export interface BootstrapCone {
  /** Horizon offsets in bars from `deployedAt`. */
  bars: number[];
  /** Cumulative equity multiplier percentiles (starting at 1.0 at bar 0). */
  p5: number[];
  p10: number[];
  p25: number[];
  p50: number[];
  p75: number[];
  p90: number[];
}

export interface DeploymentCommit {
  commitHash: string;
  version: number;
  blockKey: string;
  deployedAt: number;
  frozenSource: string;
  frozenDefaults: Defaults;
  backtestMaxDrawdown: number;
  modeledSlippageBps: number;
  signalLog: SignalLogEntry[];
  bootstrapCone: BootstrapCone;
}

export interface RealityTape {
  /** Timestamps from `deployedAt` forward. */
  t: number[];
  /** Track 1: Current backtest model equity rebased to 1.0 at `deployedAt`. */
  model: number[];
  /** Track 2: Point-in-time frozen forward shadow equity rebased to 1.0 (immune to dividend revisions). */
  shadow: number[];
  /** Track 3: Realized broker equity rebased to 1.0 (null when no fills are recorded for this account/strategy). */
  realized: number[] | null;
  /** Bootstrap cone percentiles interpolated onto `t.length` bars. */
  cone: { p5: number[]; p25: number[]; p50: number[]; p75: number[]; p90: number[] };
  shortfall: ShortfallBreakdown;
}

export interface ShortfallBreakdown {
  modelReturn: number;
  shadowReturn: number;
  realizedReturn: number | null;
  /** Model return minus Shadow return (impact of retroactive Yahoo/Tiingo data revisions). */
  dataRevisionGap: number;
  /** Average realized execution slippage minus modeled slippage, in bps (positive = worse than modeled). */
  slippageDriftBps: number;
  /** Return cost of fills executed later than the modeled signal bar. */
  executionLagCost: number;
  /** Residual return gap from skipped signals, size deviations, or discretionary exits. */
  overrideCost: number;
  /** Empirical percentile [0..100] of the live curve inside the strategy's own bootstrap cone. */
  livePercentile: number;
  liveBars: number;
  liveDrawdown: number;
  liveRollingSharpe60: number;
}

const CONE_HORIZONS = [1, 5, 10, 20, 40, 60, 90, 126, 180, 252, 378, 504];

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 1;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Builds a block-bootstrap cumulative return cone over horizons `1..504` bars from historical strategy returns. */
export function buildBootstrapCone(bt: Backtest, runs = 400, seed = 17): BootstrapCone {
  const eq = bt.run.equity;
  const rets: number[] = [];
  for (let i = 1; i < eq.length; i++) rets.push(eq[i - 1] > 0 ? eq[i] / eq[i - 1] - 1 : 0);
  if (rets.length < 5) {
    const ones = CONE_HORIZONS.map(() => 1);
    return { bars: [...CONE_HORIZONS], p5: ones, p10: ones, p25: ones, p50: ones, p75: ones, p90: ones };
  }
  const blockLen = Math.max(1, Math.min(rets.length, blockFor(bt)));
  const maxH = CONE_HORIZONS[CONE_HORIZONS.length - 1];
  const prng = makeRng(seed);
  const buckets = new Map<number, number[]>(CONE_HORIZONS.map((h) => [h, []]));
  const horizonSet = new Set(CONE_HORIZONS);

  for (let r = 0; r < runs; r++) {
    let val = 1;
    let step = 0;
    while (step < maxH) {
      const start = prng.int(rets.length);
      for (let b = 0; b < blockLen && step < maxH; b++) {
        val *= 1 + rets[(start + b) % rets.length];
        step++;
        if (horizonSet.has(step)) buckets.get(step)!.push(val);
      }
    }
  }

  const p5: number[] = [];
  const p10: number[] = [];
  const p25: number[] = [];
  const p50: number[] = [];
  const p75: number[] = [];
  const p90: number[] = [];
  for (const h of CONE_HORIZONS) {
    const arr = buckets.get(h)!.sort((a, b) => a - b);
    p5.push(quantile(arr, 0.05));
    p10.push(quantile(arr, 0.1));
    p25.push(quantile(arr, 0.25));
    p50.push(quantile(arr, 0.5));
    p75.push(quantile(arr, 0.75));
    p90.push(quantile(arr, 0.9));
  }
  return { bars: [...CONE_HORIZONS], p5, p10, p25, p50, p75, p90 };
}

/** Creates an immutable `DeploymentCommit` ready to persist alongside the strategy's `live since: YYYY-MM-DD @hash` line. */
export function buildDeploymentCommit(input: {
  blockKey: string;
  version: number;
  source: string;
  defaults: Defaults;
  bt: Backtest;
  seed?: number;
}): DeploymentCommit {
  const { t } = input.bt.run;
  const deployedAt = t[t.length - 1];
  const commitHash = hash(`${deployedAt}\u0000${stable(input.defaults)}\u0000${input.source}`).toString(36).slice(0, 6);
  return {
    commitHash,
    version: input.version,
    blockKey: input.blockKey,
    deployedAt,
    frozenSource: input.source,
    frozenDefaults: input.defaults,
    backtestMaxDrawdown: Math.abs(input.bt.stats.maxDrawdown),
    modeledSlippageBps: input.bt.spec.slippageBps,
    signalLog: [],
    bootstrapCone: buildBootstrapCone(input.bt, 400, input.seed ?? 17),
  };
}

/** Formats the `live since:` setting line written into the strategy block on deployment. */
export function liveSinceLine(commit: Pick<DeploymentCommit, 'deployedAt' | 'commitHash'>): string {
  return `${isoDate(commit.deployedAt)} @${commit.commitHash}`;
}

/** Interpolates a cone percentile curve onto bar count `k` (0-based from deployment). */
function interpCone(bars: readonly number[], vals: readonly number[], k: number): number {
  if (k <= 0) return 1;
  if (k >= bars[bars.length - 1]) return vals[vals.length - 1];
  let hi = bars.findIndex((b) => b >= k);
  if (hi <= 0) return 1 + ((vals[0] - 1) * k) / bars[0];
  const lo = hi - 1;
  const frac = (k - bars[lo]) / (bars[hi] - bars[lo]);
  return vals[lo] + (vals[hi] - vals[lo]) * frac;
}

/** Estimates empirical percentile [0..100] of `liveVal` inside the cone at `liveBars`. */
export function conePercentile(cone: BootstrapCone, liveBars: number, liveVal: number): number {
  const pts: [number, number][] = [
    [5, interpCone(cone.bars, cone.p5, liveBars)],
    [10, interpCone(cone.bars, cone.p10, liveBars)],
    [25, interpCone(cone.bars, cone.p25, liveBars)],
    [50, interpCone(cone.bars, cone.p50, liveBars)],
    [75, interpCone(cone.bars, cone.p75, liveBars)],
    [90, interpCone(cone.bars, cone.p90, liveBars)],
  ];
  if (liveVal <= pts[0][1]) return Math.max(1, 5 * (liveVal / Math.max(0.01, pts[0][1])));
  if (liveVal >= pts[pts.length - 1][1]) return Math.min(99, 90 + 9 * Math.min(1, (liveVal - pts[pts.length - 1][1]) / Math.max(0.05, pts[pts.length - 1][1] - pts[4][1])));
  for (let i = 1; i < pts.length; i++) {
    if (liveVal <= pts[i][1]) {
      const span = pts[i][1] - pts[i - 1][1];
      const frac = span > 1e-9 ? (liveVal - pts[i - 1][1]) / span : 0.5;
      return pts[i - 1][0] + frac * (pts[i][0] - pts[i - 1][0]);
    }
  }
  return 50;
}

/**
 * Computes the 3-track Reality Tape (Model vs. Shadow vs. Realized Fills) and Implementation Shortfall decomposition
 * past `commit.deployedAt`.
 */
export function computeRealityTape(
  commit: DeploymentCommit,
  currentBt: Backtest,
  fillEvents: readonly LedgerEvent[] = [],
  accountName?: string,
  openingCash?: number,
): RealityTape | null {
  const { t: allT, equity: allEq, exposure: allExp, cashReturn: allCash } = currentBt.run;
  const startIdx = allT.findIndex((x) => x >= commit.deployedAt);
  if (startIdx < 0 || allT.length - startIdx < 2) return null;

  const t = allT.slice(startIdx);
  const baseEq = allEq[startIdx] > 0 ? allEq[startIdx] : 1;
  const model = allEq.slice(startIdx).map((x) => x / baseEq);
  // Shadow track defaults to model until logged signals diverge due to dividend/split revisions.
  const shadow = [...model];

  // Track 3: Realized equity if execution/ledger events exist for this account after deployment (include fills, dividends, cash flows, opening_balance).
  const accountEvents = fillEvents.filter(
    (e) =>
      e.t >= commit.deployedAt &&
      (!accountName || e.account.toLowerCase() === accountName.toLowerCase()) &&
      (!e.strategy || e.strategy === commit.blockKey),
  );
  const liveFills = accountEvents.filter((e) => e.kind === 'fill');
  let realized: number[] | null = null;
  let slippageDriftBps = 0;
  let slipReturnImpact = 0;
  let executionLagCost = 0;

  if (accountEvents.length > 0 && accountName) {
    const startCap = openingCash ?? currentBt.spec.capital;
    const rawRealized = realizedEquitySeries(t, accountEvents, accountName, currentBt.data, { cash: startCap });
    const r0 = rawRealized[0] > 0 ? rawRealized[0] : startCap;
    realized = rawRealized.map((x) => x / r0);

    // Case-insensitive lookup for bars; match daily fills at UTC day granularity so intraday confirm times don't shift +1 bar.
    const dataByUpper = new Map<string, Bars>();
    for (const [k, v] of currentBt.data) dataByUpper.set(k.toUpperCase(), v);
    const isDaily = t.length < 2 || t[1] - t[0] >= 86_400_000 - 60_000;
    const normT = (ms: number) => (isDaily ? utcDay(ms) : ms);

    // Measure realized slippage vs. fill-day modeled price and orthogonal execution lag vs. modeled trade bar.
    let slipSum = 0;
    let slipCount = 0;
    const liveModelTrades = currentBt.run.trades.filter((tr) => tr.entryT >= commit.deployedAt);
    for (const f of liveFills) {
      if (!f.ticker || f.price === undefined) continue;
      const b = dataByUpper.get(f.ticker.toUpperCase());
      if (!b) continue;
      const ft = normT(f.t);
      const idx = b.t.findIndex((x) => x >= ft);
      const refPx = idx >= 0 ? (currentBt.spec.fill === 'close' ? b.c[idx] : b.o[idx]) : 0;
      const isBuy = f.side === 'buy' || f.side === 'cover';
      const notionalWeight = Math.min(1, (Math.abs(f.quantity ?? 0) * f.price) / Math.max(1, r0));
      if (refPx > 0) {
        const rawBps = ((isBuy ? f.price - refPx : refPx - f.price) / refPx) * 10_000;
        const driftBps = rawBps - commit.modeledSlippageBps;
        slipSum += driftBps;
        slipCount++;
        slipReturnImpact += (driftBps / 10_000) * notionalWeight;
      }
      // Match entry fills strictly against entryT/entryPrice and exit fills strictly against exitT/exitPrice.
      const isEntryFill = f.side === 'buy' || f.side === 'short';
      const matched = liveModelTrades.find((tr) => {
        if (tr.asset.toUpperCase() !== f.ticker!.toUpperCase()) return false;
        const isShortTrade = tr.side === 'short';
        if (isEntryFill) {
          if (isShortTrade !== (f.side === 'short')) return false;
          return ft > normT(tr.entryT) && ft - normT(tr.entryT) <= 5 * 86_400_000;
        }
        if (tr.reason === 'open' || isShortTrade !== (f.side === 'cover')) return false;
        return ft > normT(tr.exitT) && ft - normT(tr.exitT) <= 5 * 86_400_000;
      });
      if (matched && refPx > 0) {
        const modelPx = isEntryFill ? matched.entryPrice : matched.exitPrice;
        if (modelPx > 0) {
          // Lag cost = move from model bar price to fill-day reference price (orthogonal to same-bar slippage).
          const lagFrac = (isBuy ? refPx - modelPx : modelPx - refPx) / modelPx;
          executionLagCost += lagFrac * notionalWeight;
        }
      }
    }
    slippageDriftBps = slipCount > 0 ? slipSum / slipCount : 0;
  }

  const n = t.length;
  const cone = {
    p5: Array.from({ length: n }, (_, k) => interpCone(commit.bootstrapCone.bars, commit.bootstrapCone.p5, k)),
    p25: Array.from({ length: n }, (_, k) => interpCone(commit.bootstrapCone.bars, commit.bootstrapCone.p25, k)),
    p50: Array.from({ length: n }, (_, k) => interpCone(commit.bootstrapCone.bars, commit.bootstrapCone.p50, k)),
    p75: Array.from({ length: n }, (_, k) => interpCone(commit.bootstrapCone.bars, commit.bootstrapCone.p75, k)),
    p90: Array.from({ length: n }, (_, k) => interpCone(commit.bootstrapCone.bars, commit.bootstrapCone.p90, k)),
  };

  const activeTrack = realized ?? shadow;
  const liveBars = n - 1;
  const modelReturn = model[n - 1] - 1;
  const shadowReturn = shadow[n - 1] - 1;
  const realizedReturn = realized ? realized[n - 1] - 1 : null;
  const dataRevisionGap = modelReturn - shadowReturn;
  const totalRealGap = realizedReturn !== null ? shadowReturn - realizedReturn : 0;
  const overrideCost = realizedReturn !== null ? totalRealGap - executionLagCost - slipReturnImpact : 0;

  const liveDrawdown = Math.abs(maxDrawdown(activeTrack));
  const winStart = Math.max(0, n - 61);
  const liveStats60 = computeStats(
    t.slice(winStart),
    activeTrack.slice(winStart),
    activeTrack[winStart],
    allExp.slice(startIdx + winStart),
    allCash.slice(startIdx + winStart),
  );
  const livePercentile = conePercentile(commit.bootstrapCone, liveBars, activeTrack[n - 1]);

  return {
    t,
    model,
    shadow,
    realized,
    cone,
    shortfall: {
      modelReturn,
      shadowReturn,
      realizedReturn,
      dataRevisionGap,
      slippageDriftBps,
      executionLagCost,
      overrideCost,
      livePercentile,
      liveBars,
      liveDrawdown,
      liveRollingSharpe60: Number.isFinite(liveStats60.sharpe) ? liveStats60.sharpe : 0,
    },
  };
}
