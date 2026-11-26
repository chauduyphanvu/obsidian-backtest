// Inline X-Ray Clause Ablation: decomposes a declarative strategy's rules, stops, and rebalance setting into atomic
// AST clauses, runs fast leave-one-out simulations reusing priceMemo indicator buffers, computes marginal Sharpe/DD/CAGR
// attribution and exact causal trade diffs, and supports non-destructive clause muting. Pure; zero Obsidian imports.

import { computeStats, specSignals, type Backtest } from './backtest.ts';
import { commentAt, walk, type Expr, type Rules, type Span, type Spec, type Written } from './dsl.ts';
import { simulate } from './engine.ts';
import { priceMemo } from './price-memo.ts';
import type { Bars } from './types.ts';

export type ClauseKind = 'buy' | 'sell' | 'short' | 'cover' | 'add' | 'stop' | 'rebalance';
export type ClauseVerdict = 'load-bearing' | 'helpful' | 'neutral' | 'destructive';

export interface ClauseAttribution {
  /** Stable clause identifier (e.g. "buy:0", "sell:1", "stop:stopLoss", "rebalance"). */
  id: string;
  /** Short human-readable text of this clause as written. */
  label: string;
  /** Exact source span when known (1-based line, 0-based half-open columns); null if synthetic. */
  span: Span | null;
  kind: ClauseKind;
  /** Full strategy Sharpe minus strategy-without-clause Sharpe (positive = clause helps). */
  deltaSharpe: number;
  /** Full MaxDD minus without-clause MaxDD (positive = clause reduced drawdown). */
  deltaMaxDD: number;
  /** Full CAGR minus without-clause CAGR. */
  deltaCagr: number;
  /** Full exposure minus without-clause exposure. */
  deltaExposure: number;
  /** Number of trades present in full strategy that vanish without this clause. */
  tradesAdded: number;
  /** Number of trades prevented by this clause (present without it, absent with it). */
  tradesBlocked: number;
  /** Entry timestamps of trades causally added or blocked by this clause, for chart hover highlights. */
  affectedTimes: number[];
  verdict: ClauseVerdict;
}

export interface AblationReport {
  clauses: ClauseAttribution[];
  baseSharpe: number;
  elapsedMs: number;
  truncated: boolean;
}

const MAX_CLAUSES = 16;

interface AtomicClause {
  id: string;
  label: string;
  span: Span | null;
  kind: ClauseKind;
  /** Rule-clause metadata for single-pass multi-mute application (null for stop/rebalance). */
  ruleTarget?: { assets: string[]; side: 'buy' | 'sell' | 'short' | 'cover' | 'add'; op: 'and' | 'or'; identity: Expr; leafIdx: number };
  /** Builds a cloned Spec with this clause removed/neutralized. */
  ablate: (spec: Spec) => Spec;
}

/** Flattens a top-level chain of `op` (`and` or `or`) into leaf clauses, keeping `between` and definitions whole. */
function flattenOp(root: Expr, op: 'and' | 'or', wholeSet: Set<Expr>): Expr[] {
  if (root.k === 'logic' && root.op === op && !wholeSet.has(root)) {
    return [...flattenOp(root.a, op, wholeSet), ...flattenOp(root.b, op, wholeSet)];
  }
  return [root];
}

/** Builds a lookup map from Expr object reference to its written text & span from `Written`. */
function writtenLookup(root: Expr, written: Written | null | undefined): {
  text: Map<Expr, string>;
  span: Map<Expr, Span | null>;
  whole: Set<Expr>;
} {
  const text = new Map<Expr, string>();
  const span = new Map<Expr, Span | null>();
  const whole = new Set<Expr>();
  if (!written) return { text, span, whole };
  let k = 0;
  walk(root, (e) => {
    text.set(e, written.parts[k] ?? '');
    span.set(e, written.spans?.[k] ?? null);
    if (written.whole?.includes(k)) whole.add(e);
    k++;
  });
  return { text, span, whole };
}

/** Replaces all target leaf indices in a top-level `op` chain with `replacement` in a single pass. */
function replaceManyInChain(root: Expr, op: 'and' | 'or', wholeSet: Set<Expr>, targetIdxs: ReadonlySet<number>, replacement: Expr): Expr {
  const leaves = flattenOp(root, op, wholeSet);
  if (leaves.length <= 1) return replacement;
  const kept = leaves.map((leaf, i) => (targetIdxs.has(i) ? replacement : leaf));
  let acc = kept[0];
  for (let i = 1; i < kept.length; i++) acc = { k: 'logic', op, a: acc, b: kept[i] };
  return acc;
}

/** Finds the 1-based line span of a setting line like `stop loss: 8%` or `rebalance: monthly` in `source`. */
function findSettingSpan(source: string, key: string): Span | null {
  const re = new RegExp(`^\\s*(${key.replace(/\s+/g, '\\s+')})\\s*:(.*)$`, 'i');
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '');
    const c = commentAt(raw);
    const code = c < 0 ? raw : raw.slice(0, c);
    if (code.trimStart().startsWith('~')) continue;
    if (re.test(code)) {
      const from = code.length - code.trimStart().length;
      return { line: i + 1, from, to: code.trimEnd().length };
    }
  }
  return null;
}

/** Extracts all atomic ablatable clauses from `spec` and `source`, scoping per-ticker `for` overrides cleanly. */
export function extractClauses(spec: Spec, source = ''): AtomicClause[] {
  const clauses: AtomicClause[] = [];
  if (spec.universe.length === 0) return clauses;

  const sides: ('buy' | 'sell' | 'short' | 'cover' | 'add')[] = ['buy', 'sell', 'add', 'short', 'cover'];
  for (const side of sides) {
    // Group assets that share identical rule text/AST for this side so `for TICKER:` overrides stay isolated.
    const groups = new Map<string, { assets: string[]; expr: Expr; written: Written | null | undefined }>();
    for (const a of spec.universe) {
      const expr = spec.rules[a.name]?.[side];
      const written = spec.written?.rules[a.name]?.[side];
      if (!expr) continue;
      if (expr.k === 'bool' && !written) continue;
      const sig = written ? `${written.text}\u0000${written.spans?.[0]?.line ?? ''}` : JSON.stringify(expr);
      const existing = groups.get(sig);
      if (existing) existing.assets.push(a.name);
      else groups.set(sig, { assets: [a.name], expr, written });
    }
    const multiGroup = groups.size > 1;
    const isEntry = side === 'buy' || side === 'short' || side === 'add';
    const op: 'and' | 'or' = isEntry ? 'and' : 'or';
    const identity: Expr = isEntry ? { k: 'bool', v: true } : { k: 'bool', v: false };

    for (const { assets, expr, written } of groups.values()) {
      const info = writtenLookup(expr, written);
      const leaves = flattenOp(expr, op, info.whole);
      const scopePrefix = multiGroup ? `${assets.join(',')}:` : '';
      const labelPrefix = multiGroup ? `[${assets.join(',')}] ` : '';
      leaves.forEach((leaf, idx) => {
        const label = info.text.get(leaf) || written?.text || `${side} rule`;
        const sp = info.span.get(leaf) ?? null;
        const id = `${scopePrefix}${side}:${idx}`;
        clauses.push({
          id,
          label: `${labelPrefix}${leaves.length === 1 ? `${side} when ${label}` : label}`,
          span: sp,
          kind: side,
          ruleTarget: { assets, side, op, identity, leafIdx: idx },
          ablate: (s) => {
            const nextRules: Record<string, Rules> = { ...s.rules };
            for (const assetName of assets) {
              const r = s.rules[assetName];
              const cur = r?.[side];
              if (!cur) continue;
              const aWritten = s.written?.rules[assetName]?.[side];
              const aInfo = writtenLookup(cur, aWritten);
              const aLeaves = flattenOp(cur, op, aInfo.whole);
              const replaced = aLeaves.length === 1 && !isEntry ? null : idx < aLeaves.length ? replaceManyInChain(cur, op, aInfo.whole, new Set([idx]), identity) : cur;
              nextRules[assetName] = { ...r, [side]: replaced } as Rules;
            }
            return { ...s, rules: nextRules };
          },
        });
      });
    }
  }

  // Active stops
  const stopKinds: [keyof Spec['stops'][string], string][] = [
    ['stopLoss', 'stop loss'],
    ['trailingStop', 'trailing stop'],
    ['takeProfit', 'take profit'],
  ];
  for (const [field, name] of stopKinds) {
    const anyActive = spec.universe.some((a) => spec.stops[a.name]?.[field] !== null);
    if (!anyActive) continue;
    const sample = spec.universe.map((a) => spec.stops[a.name]?.[field]).find((x) => x !== null)!;
    const desc = sample.k === 'pct' ? `${Number((sample.v * 100).toPrecision(4))}%` : `${sample.mult} atr(${sample.n})`;
    clauses.push({
      id: `stop:${field}`,
      label: `${name}: ${desc}`,
      span: source ? findSettingSpan(source, name) : null,
      kind: 'stop',
      ablate: (s) => {
        const stops: Spec['stops'] = {};
        for (const a of s.universe) stops[a.name] = { ...s.stops[a.name], [field]: null };
        return { ...s, stops };
      },
    });
  }

  // Active rebalance (skip when `hold` ranking drives rebalance cadence)
  if (spec.rebalance !== 'never' && !spec.rank) {
    clauses.push({
      id: 'rebalance',
      label: `rebalance: ${spec.rebalance}`,
      span: source ? findSettingSpan(source, 'rebalance') : null,
      kind: 'rebalance',
      ablate: (s) => ({ ...s, rebalance: 'never' }),
    });
  }

  return clauses;
}

/** Applies a set of muted clause IDs to a Spec non-destructively in a single pass per `(asset, side)` so `written.whole` never desyncs. */
export function applyClauseMutes(spec: Spec, source: string, mutedIds: ReadonlySet<string>): Spec {
  if (mutedIds.size === 0) return spec;
  let cur = spec;
  const all = extractClauses(spec, source);
  // Group rule mutes per (asset, side) so all muted leaf indices are replaced against the original AST & wholeSet at once.
  const ruleMutes = new Map<string, { asset: string; side: 'buy' | 'sell' | 'short' | 'cover' | 'add'; op: 'and' | 'or'; identity: Expr; idxs: Set<number> }>();
  for (const clause of all) {
    if (!mutedIds.has(clause.id)) continue;
    if (clause.ruleTarget) {
      const { assets, side, op, identity, leafIdx } = clause.ruleTarget;
      for (const asset of assets) {
        const k = `${asset}\u0000${side}`;
        let bucket = ruleMutes.get(k);
        if (!bucket) ruleMutes.set(k, (bucket = { asset, side, op, identity, idxs: new Set() }));
        bucket.idxs.add(leafIdx);
      }
    } else {
      cur = clause.ablate(cur);
    }
  }
  if (ruleMutes.size > 0) {
    const nextRules: Record<string, Rules> = { ...cur.rules };
    for (const { asset, side, op, identity, idxs } of ruleMutes.values()) {
      const r = nextRules[asset];
      const origExpr = spec.rules[asset]?.[side];
      if (!r || !origExpr) continue;
      const origWritten = spec.written?.rules[asset]?.[side];
      const origInfo = writtenLookup(origExpr, origWritten);
      const leaves = flattenOp(origExpr, op, origInfo.whole);
      const isEntry = side === 'buy' || side === 'short' || side === 'add';
      const allMuted = leaves.every((_, i) => idxs.has(i));
      const replaced = allMuted && !isEntry ? null : replaceManyInChain(origExpr, op, origInfo.whole, idxs, identity);
      nextRules[asset] = { ...r, [side]: replaced } as Rules;
    }
    cur = { ...cur, rules: nextRules };
  }
  return cur;
}

function classifyClause(deltaSharpe: number, deltaMaxDD: number, tradesTouched: number): ClauseVerdict {
  if (deltaSharpe < -0.02 && deltaMaxDD <= 0.002) return 'destructive';
  if (Math.abs(deltaSharpe) < 0.02 && Math.abs(deltaMaxDD) < 0.01 && tradesTouched <= 3) return 'neutral';
  if (deltaSharpe >= 0.15 || deltaMaxDD >= 0.08) return 'load-bearing';
  return deltaSharpe < -0.02 ? 'destructive' : 'helpful';
}

export interface AblationHooks {
  onProgress?: (done: number, total: number) => void;
  shouldStop?: () => boolean;
}

/**
 * Runs leave-one-out ablation over every atomic clause of `spec` (capped at MAX_CLAUSES), reusing `priceMemo` indicator
 * arrays so each ablation executes in a few milliseconds.
 */
export function runAblation(spec: Spec, data: Map<string, Bars>, baseBt: Backtest, source = '', hooks?: AblationHooks): AblationReport {
  const started = performance.now();
  priceMemo.share(data);
  const all = extractClauses(spec, source);
  const truncated = all.length > MAX_CLAUSES;
  const list = all.slice(0, MAX_CLAUSES);

  const tradeKey = (t: { asset: string; entryT: number; side?: 'short' }) => `${t.asset}:${t.side ?? 'long'}:${t.entryT}`;
  const baseKeys = new Set(baseBt.run.trades.map(tradeKey));
  const clauses: ClauseAttribution[] = [];

  for (let i = 0; i < list.length; i++) {
    if (hooks?.shouldStop?.()) break;
    const c = list[i];
    const ablated = c.ablate(spec);
    const sigs = specSignals(ablated, data);
    const run = simulate({ ...ablated, assets: ablated.universe }, data, sigs);
    const stats = computeStats(run.t, run.equity, ablated.capital, run.exposure, run.cashReturn, run.ruin ? run.t.indexOf(run.ruin.t) : undefined, run.netExposure);

    const withoutKeys = new Set(run.trades.map(tradeKey));
    let tradesAdded = 0;
    let tradesBlocked = 0;
    const affectedTimes: number[] = [];
    for (const t of baseBt.run.trades) {
      if (!withoutKeys.has(tradeKey(t))) {
        tradesAdded++;
        affectedTimes.push(t.entryT);
      }
    }
    for (const t of run.trades) {
      if (!baseKeys.has(tradeKey(t))) {
        tradesBlocked++;
        affectedTimes.push(t.entryT);
      }
    }
    affectedTimes.sort((a, b) => a - b);

    const deltaSharpe = (Number.isFinite(baseBt.stats.sharpe) ? baseBt.stats.sharpe : 0) - (Number.isFinite(stats.sharpe) ? stats.sharpe : 0);
    const deltaMaxDD = (Number.isFinite(baseBt.stats.maxDrawdown) ? baseBt.stats.maxDrawdown : 0) - (Number.isFinite(stats.maxDrawdown) ? stats.maxDrawdown : 0);
    const deltaCagr = (Number.isFinite(baseBt.stats.cagr) ? baseBt.stats.cagr : 0) - (Number.isFinite(stats.cagr) ? stats.cagr : 0);
    const deltaExposure = (Number.isFinite(baseBt.stats.exposure) ? baseBt.stats.exposure : 0) - (Number.isFinite(stats.exposure) ? stats.exposure : 0);

    clauses.push({
      id: c.id,
      label: c.label,
      span: c.span,
      kind: c.kind,
      deltaSharpe,
      deltaMaxDD,
      deltaCagr,
      deltaExposure,
      tradesAdded,
      tradesBlocked,
      affectedTimes,
      verdict: classifyClause(deltaSharpe, deltaMaxDD, tradesAdded + tradesBlocked),
    });
    hooks?.onProgress?.(i + 1, list.length);
  }

  return {
    clauses,
    baseSharpe: baseBt.stats.sharpe,
    elapsedMs: performance.now() - started,
    truncated,
  };
}
