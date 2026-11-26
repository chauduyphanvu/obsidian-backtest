// Inverse Backtesting (Chart-to-Rule Debugging):
// 1. `brushContrast`: given a cluster of selected trades (e.g. losing whipsaws brushed on the chart) vs. remaining trades,
//    computes entry-bar feature separation across orthogonal market-state indicators ranked by ROC-AUC + permutation p-value,
//    and reports the exact DSR trial tax for data-mining honesty.
// 2. `probeBar`: clicks any bar on the price chart to find the blocking rule comparison(s), the minimal threshold shift
//    needed to flip that bar, and the global 20-year counterfactual side effect. Pure; zero Obsidian imports.

import { computeStats, specSignals, type Backtest } from './backtest.ts';
import { extractLiteralSites, parseSpec, walk, type Defaults, type Expr, type Spec } from './dsl.ts';
import { barAt, simulate, type Trade } from './engine.ts';
import { specEvaluator, type PosState } from './evaluate.ts';
import * as ind from './indicators.ts';
import { priceMemo } from './price-memo.ts';
import { makeRng, shuffle } from './rng.ts';
import type { Bars } from './types.ts';

export interface FeatureSeparation {
  name: string;
  /** Ready-to-inject DSL expression representing this feature. */
  expr: string;
  /** ROC-AUC in [0.5, 1.0]: 0.5 = random, 1.0 = perfect separation. */
  auc: number;
  /** Empirical two-sided permutation p-value (200 shuffles). */
  pValue: number;
  selectedMedian: number;
  otherMedian: number;
  /** Optimal split threshold (Youden's J) separating `other` from `selected`. */
  threshold: number;
  /** Suggested filter clause to EXCLUDE the brushed cluster (e.g. "and adx(14) > 18.5"). */
  suggestedClause: string;
  direction: 'higher_in_selected' | 'lower_in_selected';
}

export interface ContrastResult {
  selectedCount: number;
  otherCount: number;
  features: FeatureSeparation[];
  /** Number of candidate features scanned: exact DSR trial tax to record if the user injects a suggested filter. */
  effectiveTrialsCost: number;
}

export interface CounterfactualEffect {
  literalId: string;
  oldValue: number;
  newValue: number;
  percent?: boolean;
  flippedTrades: number;
  deltaSharpe: number;
  deltaMaxDD: number;
}

export interface BarBlocker {
  clause: string;
  /** Observed value of the comparison's left side vs right side at the probed bar. */
  lhs: number;
  rhs: number;
  op: string;
  gap: number;
  counterfactual: CounterfactualEffect | null;
}

export interface BarProbeResult {
  ticker: string;
  t: number;
  close: number;
  position: 'flat' | 'long' | 'short';
  ruleSide: 'buy' | 'sell' | 'cover';
  fired: boolean;
  blockers: BarBlocker[];
}

function plainNumber(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const rounded = Number(n.toPrecision(4));
  return rounded.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 12 });
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Exact Mann-Whitney U / ROC-AUC of `pos` values vs `neg` values (returns raw AUC in [0, 1]). */
export function rawAuc(pos: readonly number[], neg: readonly number[]): number {
  if (pos.length === 0 || neg.length === 0) return 0.5;
  let wins = 0;
  for (const a of pos) {
    for (const b of neg) {
      if (a > b) wins += 1;
      else if (a === b) wins += 0.5;
    }
  }
  return wins / (pos.length * neg.length);
}

/** Finds threshold maximizing Youden's J (TPR - FPR) to separate `selected` from `other`. */
function bestThreshold(selected: number[], other: number[], higherInSelected: boolean): number {
  const all = [...new Set([...selected, ...other])].sort((a, b) => a - b);
  if (all.length === 0) return NaN;
  let bestT = all[Math.floor(all.length / 2)];
  let bestJ = -Infinity;
  for (let i = 0; i < all.length - 1; i++) {
    const mid = (all[i] + all[i + 1]) / 2;
    const selHit = selected.filter((x) => (higherInSelected ? x >= mid : x <= mid)).length / selected.length;
    const othMiss = other.filter((x) => (higherInSelected ? x < mid : x > mid)).length / other.length;
    const j = selHit + othMiss - 1;
    if (j > bestJ) {
      bestJ = j;
      bestT = mid;
    }
  }
  return Number(bestT.toPrecision(4));
}

interface CandidateFeature {
  name: string;
  expr: string;
  compute: (bars: Bars, extras: Map<string, Bars>) => number[] | null;
}

const CANDIDATES: CandidateFeature[] = [
  { name: 'ADX(14)', expr: 'adx(14)', compute: (b) => ind.adx(b.h, b.l, b.c, 14) },
  { name: 'Efficiency(20)', expr: 'efficiency(20)', compute: (b) => ind.efficiency(b.c, 20) },
  {
    name: 'ATR(14) %',
    expr: 'atr(14) / close',
    compute: (b) => {
      const a = ind.atr(b.h, b.l, b.c, 14);
      return a.map((v, i) => (b.c[i] > 0 ? v / b.c[i] : NaN));
    },
  },
  { name: 'RSI(2)', expr: 'rsi(2)', compute: (b) => ind.rsi(b.c, 2) },
  { name: 'RSI(14)', expr: 'rsi(14)', compute: (b) => ind.rsi(b.c, 14) },
  { name: 'Z-Score(20)', expr: 'zscore(20)', compute: (b) => ind.zscore(b.c, 20) },
  {
    name: 'Dist from SMA(50)',
    expr: 'close / sma(50) - 1',
    compute: (b) => {
      const s = ind.sma(b.c, 50);
      return s.map((v, i) => (v > 0 ? b.c[i] / v - 1 : NaN));
    },
  },
  {
    name: 'Dist from SMA(200)',
    expr: 'close / sma(200) - 1',
    compute: (b) => {
      const s = ind.sma(b.c, 200);
      return s.map((v, i) => (v > 0 ? b.c[i] / v - 1 : NaN));
    },
  },
  { name: 'ROC(20)', expr: 'roc(20)', compute: (b) => ind.roc(b.c, 20) },
  { name: 'ROC(126)', expr: 'roc(126)', compute: (b) => ind.roc(b.c, 126) },
  { name: 'R-Squared(30)', expr: 'rsquared(30)', compute: (b) => ind.rsquared(b.c, 30) },
  { name: 'Stochastic %K(14)', expr: 'stoch_k(14, 3)', compute: (b) => ind.stochK(b.h, b.l, b.c, 14, 3) },
  {
    name: 'Rel Volume(20)',
    expr: 'volume / sma(volume, 20)',
    compute: (b) => {
      if (!b.v.some((x) => x > 0)) return null;
      const sv = ind.sma(b.v, 20);
      return sv.map((v, i) => (v > 0 ? b.v[i] / v : NaN));
    },
  },
  {
    name: '60-bar Drawdown',
    expr: 'close / highest(60) - 1',
    compute: (b) => {
      const hi = ind.highest(b.h, 60);
      return hi.map((v, i) => (v > 0 ? b.c[i] / v - 1 : NaN));
    },
  },
];

/**
 * Compares entry-bar market-state features of `selectedTradeIndices` (brushed trades) against all other closed trades,
 * ranking separating features by ROC-AUC and computing 200-shuffle permutation p-values + DSR trial tax.
 */
export function brushContrast(
  spec: Spec,
  data: Map<string, Bars>,
  bt: Backtest,
  selectedTradeIndices: readonly number[],
  seed = 7,
  permutations = 200,
): ContrastResult {
  const closed = bt.run.trades.map((tr, i) => ({ tr, i })).filter((x) => x.tr.reason !== 'open');
  const selSet = new Set(selectedTradeIndices);
  const selected = closed.filter((x) => selSet.has(x.i));
  const other = closed.filter((x) => !selSet.has(x.i));
  if (selected.length < 2 || other.length < 2) {
    return { selectedCount: selected.length, otherCount: other.length, features: [], effectiveTrialsCost: 0 };
  }

  // Build candidate list including any already-loaded priced extra series (e.g. ^VIX, FRED), using specEvaluator for exact clock alignment.
  const evaluator = specEvaluator(spec, data);
  const allCandidates: CandidateFeature[] = [...CANDIDATES];
  for (const extra of spec.extras) {
    const eb = data.get(extra.name);
    if (!eb || eb.t.length === 0 || eb.unpriced) continue;
    allCandidates.push({
      name: `${extra.name} close`,
      expr: `close of ${extra.name}`,
      compute: (_b, _extras) => null,
    });
  }

  // Precompute feature arrays per traded asset.
  const perAsset = new Map<string, Map<string, number[]>>();
  const signalBarOf = (tr: Trade): number => {
    const b = data.get(tr.asset);
    if (!b) return -1;
    const t = tr.why?.buyT ?? tr.entryT;
    return barAt(b.t, t);
  };

  const rand = makeRng(seed);
  const features: FeatureSeparation[] = [];

  for (const cand of allCandidates) {
    const selVals: number[] = [];
    const othVals: number[] = [];
    const extraMatch = cand.expr.match(/^close of (.+)$/);
    const evalFor = (tr: Trade): number => {
      let map = perAsset.get(tr.asset);
      if (!map) perAsset.set(tr.asset, (map = new Map()));
      let arr = map.get(cand.expr);
      if (arr === undefined) {
        if (extraMatch) {
          arr = evaluator.series({ k: 'of', asset: extraMatch[1], a: { k: 'series', name: 'close' } }, tr.asset);
        } else {
          const b = data.get(tr.asset);
          arr = (b ? cand.compute(b, data) : null) ?? [];
        }
        map.set(cand.expr, arr);
      }
      const idx = signalBarOf(tr);
      return idx >= 0 && idx < arr.length ? arr[idx] : NaN;
    };
    for (const { tr } of selected) {
      const v = evalFor(tr);
      if (Number.isFinite(v)) selVals.push(v);
    }
    for (const { tr } of other) {
      const v = evalFor(tr);
      if (Number.isFinite(v)) othVals.push(v);
    }
    if (selVals.length < 2 || othVals.length < 2) continue;

    const rAuc = rawAuc(selVals, othVals);
    const higherInSelected = rAuc >= 0.5;
    const auc = higherInSelected ? rAuc : 1 - rAuc;

    // Two-sided permutation test
    const combined = [...selVals, ...othVals];
    const nSel = selVals.length;
    let extreme = 0;
    for (let k = 0; k < permutations; k++) {
      const perm = shuffle([...combined], rand);
      const pAuc = rawAuc(perm.slice(0, nSel), perm.slice(nSel));
      const pSym = pAuc >= 0.5 ? pAuc : 1 - pAuc;
      if (pSym >= auc - 1e-12) extreme++;
    }
    const pValue = (extreme + 1) / (permutations + 1);
    const threshold = bestThreshold(selVals, othVals, higherInSelected);
    // To filter OUT the selected cluster, keep the opposite side of the threshold.
    const keepOp = higherInSelected ? '<' : '>';
    const suggestedClause = `and ${cand.expr} ${keepOp} ${plainNumber(threshold)}`;

    features.push({
      name: cand.name,
      expr: cand.expr,
      auc,
      pValue,
      selectedMedian: median(selVals),
      otherMedian: median(othVals),
      threshold,
      suggestedClause,
      direction: higherInSelected ? 'higher_in_selected' : 'lower_in_selected',
    });
  }

  features.sort((a, b) => b.auc - a.auc || a.pValue - b.pValue);
  return {
    selectedCount: selected.length,
    otherCount: other.length,
    features,
    effectiveTrialsCost: features.length,
  };
}

/**
 * Click-any-bar counterfactual probe: explains why the strategy did or did not fire on `barIndex` of `ticker`,
 * solves for the minimal numeric threshold shift needed to flip each failing comparison, and simulates the global
 * side effect of that relaxation across the full history.
 */
export function probeBar(
  source: string,
  spec: Spec,
  data: Map<string, Bars>,
  bt: Backtest,
  ticker: string,
  barIndex: number,
  defaults: Partial<Defaults> = {},
  overrides?: Record<string, number>,
): BarProbeResult | null {
  const b = data.get(ticker);
  const rules = spec.rules[ticker];
  if (!b || !rules || barIndex < 0 || barIndex >= b.t.length) return null;

  priceMemo.share(data);
  const t = b.t[barIndex];
  const close = b.c[barIndex];
  // Determine position on this bar from trade intervals (include final bar for still-open trades).
  const openTrade = bt.run.trades.find((tr) => tr.asset === ticker && tr.entryT <= t && (tr.reason === 'open' ? t <= tr.exitT : t < tr.exitT));
  const position: BarProbeResult['position'] = openTrade ? (openTrade.side === 'short' ? 'short' : 'long') : 'flat';
  const ruleSide: BarProbeResult['ruleSide'] = position === 'flat' ? 'buy' : position === 'short' ? 'cover' : 'sell';
  const expr = ruleSide === 'buy' ? rules.buy : ruleSide === 'cover' ? rules.cover : rules.sell;
  if (!expr) return { ticker, t, close, position, ruleSide, fired: false, blockers: [] };

  const pos: PosState | null = openTrade
    ? {
        entryIdx: Math.max(0, barAt(b.t, openTrade.entryT)),
        entryPrice: openTrade.entryPrice,
        ...(position === 'short' ? { short: true as const } : {}),
        ...(spec.fill === 'close' ? { atClose: true as const } : {}),
      }
    : null;

  const evaluator = specEvaluator(spec, data);
  const evalAt = (sub: Expr): number => (ruleSide === 'buy' ? evaluator.series(sub, ticker)[barIndex] : evaluator.compile(sub, ticker)(barIndex, pos));
  const firedVal = evalAt(expr);
  const fired = firedVal === 1;

  // Build exact walk-order index map upfront so 2nd+ comparisons never desync from `written.parts`/`written.spans`.
  const idxMap = new Map<Expr, number>();
  let walkCount = 0;
  walk(expr, (e) => idxMap.set(e, walkCount++));

  // Walk comparison nodes to find failing comparisons on this bar (respecting `not` polarity).
  const sites = extractLiteralSites(source);
  const blockers: BarBlocker[] = [];
  const written = spec.written?.rules[ticker]?.[ruleSide];

  const visit = (node: Expr, negated: boolean): void => {
    if (node.k === 'cmp') {
      const idx = idxMap.get(node) ?? -1;
      const lhs = evalAt(node.a);
      const rhs = evalAt(node.b);
      const val = evalAt(node);
      const failed = negated ? val === 1 : val !== 1;
      if (failed && Number.isFinite(lhs) && Number.isFinite(rhs)) {
        const sp = idx >= 0 ? (written?.spans?.[idx] ?? null) : null;
        const rhsIdx = idxMap.get(node.b) ?? -1;
        const rhsSpan = rhsIdx >= 0 ? (written?.spans?.[rhsIdx] ?? null) : null;
        const lookupSpan = rhsSpan ?? sp;
        const clause = (idx >= 0 ? written?.parts[idx] : undefined) ?? `${node.op}`;
        const gap = lhs - rhs;
        let counterfactual: CounterfactualEffect | null = null;
        // Support both positive numeric literals (`rhs: num`) and negated literals (`rhs: -num`), using node.b's span so `between` works too.
        const rhsLiteral = node.b.k === 'num' ? { val: node.b.v, neg: false } : node.b.k === 'neg' && node.b.a.k === 'num' ? { val: -node.b.a.v, neg: true } : null;
        if (rhsLiteral && lookupSpan) {
          const site = sites.find(
            (s) =>
              s.span.line === lookupSpan.line &&
              s.span.from >= lookupSpan.from &&
              s.span.to <= lookupSpan.to &&
              Math.abs(s.value - Math.abs(rhsLiteral.val)) < 1e-9,
          );
          if (site) {
            const eps = site.domain.integer ? 1 : Math.max(Math.abs(lhs) * 0.01, site.domain.step * 0.25, site.percent ? 0.0025 : 0.01);
            let target = rhsLiteral.val;
            const wantLess = negated ? node.op === '>' || node.op === '>=' : node.op === '<' || node.op === '<=';
            const wantMore = negated ? node.op === '<' || node.op === '<=' : node.op === '>' || node.op === '>=';
            if (wantLess) target = lhs + eps;
            else if (wantMore) target = lhs - eps;
            // If the literal in source has a unary `-` outside the site span, flip sign before clamping against site domain.
            const rawSiteVal = rhsLiteral.neg ? -target : target;
            const clampedSiteVal = Number(
              Math.min(site.domain.max, Math.max(site.domain.min, site.domain.integer ? Math.round(rawSiteVal) : rawSiteVal)).toPrecision(4),
            );
            const effectiveRhs = rhsLiteral.neg ? -clampedSiteVal : clampedSiteVal;
            const flipsBar =
              node.op === '<'
                ? negated ? !(lhs < effectiveRhs) : lhs < effectiveRhs
                : node.op === '<='
                  ? negated ? !(lhs <= effectiveRhs) : lhs <= effectiveRhs
                  : node.op === '>'
                    ? negated ? !(lhs > effectiveRhs) : lhs > effectiveRhs
                    : node.op === '>='
                      ? negated ? !(lhs >= effectiveRhs) : lhs >= effectiveRhs
                      : true;
            if (clampedSiteVal !== site.value && flipsBar) {
              const cfParsed = parseSpec(source, { defaults, overrides, literalOverrides: { [site.id]: clampedSiteVal } });
              if (cfParsed.spec) {
                const cfRun = simulate({ ...cfParsed.spec, assets: cfParsed.spec.universe }, data, specSignals(cfParsed.spec, data));
                const cfRuin = cfRun.ruin ? cfRun.t.indexOf(cfRun.ruin.t) : undefined;
                const cfStats = computeStats(cfRun.t, cfRun.equity, cfParsed.spec.capital, cfRun.exposure, cfRun.cashReturn, cfRuin, cfRun.netExposure);
                counterfactual = {
                  literalId: site.id,
                  oldValue: site.value,
                  newValue: clampedSiteVal,
                  ...(site.percent ? { percent: true } : {}),
                  flippedTrades: cfRun.trades.length - bt.run.trades.length,
                  deltaSharpe: (Number.isFinite(cfStats.sharpe) ? cfStats.sharpe : 0) - (Number.isFinite(bt.stats.sharpe) ? bt.stats.sharpe : 0),
                  deltaMaxDD: (Number.isFinite(cfStats.maxDrawdown) ? cfStats.maxDrawdown : 0) - (Number.isFinite(bt.stats.maxDrawdown) ? bt.stats.maxDrawdown : 0),
                };
              }
            }
          }
        }
        blockers.push({ clause: negated ? `not (${clause})` : clause, lhs, rhs, op: node.op, gap, counterfactual });
      }
      return;
    }
    if (node.k === 'logic') {
      visit(node.a, negated);
      visit(node.b, negated);
    } else if (node.k === 'not') {
      visit(node.a, !negated);
    }
  };
  visit(expr, false);

  return { ticker, t, close, position, ruleSide, fired, blockers };
}
