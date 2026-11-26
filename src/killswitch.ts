// Executable Pre-Committed Kill-Switches (`invalidate when ...`): parses and evaluates live thesis invalidation rules
// against the Reality Tape, backtest expectations, and bootstrap cone percentiles. Pure; zero Obsidian imports.

import type { DeploymentCommit, ShortfallBreakdown } from './lifecycle.ts';

export interface KillSwitchContext {
  /** Positive fraction, e.g. 0.14 for a 14% live drawdown. */
  liveDrawdown: number;
  /** Positive fraction, e.g. 0.20 for a 20% backtest max drawdown. */
  backtestMaxDrawdown: number;
  /** Live percentile inside the bootstrap cone as a fraction [0..1] (5% = 0.05). */
  livePercentile: number;
  /** Rolling Sharpe over the last ~60 live bars (or custom window). */
  liveRollingSharpe: number;
  /** Realized average slippage in bps. */
  liveSlippageBps: number;
  /** Modeled slippage in bps. */
  modeledSlippageBps: number;
  /** Number of bars elapsed since `live since`. */
  liveBars: number;
  /** Cumulative live return as a fraction. */
  liveReturn: number;
}

export interface KillSwitchCheck {
  clause: string;
  tripped: boolean;
  /** True when within 15% of tripping. */
  near: boolean;
}

export interface KillSwitchReport {
  status: 'healthy' | 'warning' | 'halted';
  trippedClauses: string[];
  checks: KillSwitchCheck[];
  error?: string;
}

type Tok = { k: 'num' | 'id' | 'op' | 'end'; s: string; v: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\s+/))) {
      i += m[0].length;
    } else if ((m = rest.match(/^(\d+(?:\.\d+)?|\.\d+)(\s*%)?/))) {
      out.push({ k: 'num', s: m[0], v: m[2] ? Number(m[1]) / 100 : Number(m[1]) });
      i += m[0].length;
    } else if ((m = rest.match(/^(>=|<=|==|!=|[()+\-*/><])/))) {
      out.push({ k: 'op', s: m[0], v: 0 });
      i += m[0].length;
    } else if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/))) {
      out.push({ k: 'id', s: m[0].toLowerCase(), v: 0 });
      i += m[0].length;
    } else {
      throw new Error(`Unexpected character "${rest[0]}" in invalidate when rule`);
    }
  }
  out.push({ k: 'end', s: '', v: 0 });
  return out;
}

/** Builds a `KillSwitchContext` from a deployment commit and its computed live shortfall breakdown. */
export function killSwitchContext(commit: DeploymentCommit, sf: ShortfallBreakdown): KillSwitchContext {
  return {
    liveDrawdown: sf.liveDrawdown,
    backtestMaxDrawdown: commit.backtestMaxDrawdown,
    livePercentile: sf.livePercentile / 100,
    liveRollingSharpe: sf.liveRollingSharpe60,
    liveSlippageBps: Math.max(0, commit.modeledSlippageBps + sf.slippageDriftBps),
    modeledSlippageBps: commit.modeledSlippageBps,
    liveBars: sf.liveBars,
    liveReturn: sf.realizedReturn ?? sf.shadowReturn,
  };
}

/** Evaluates a single `invalidate when` boolean expression (supports `and`, `or`, `not`, arithmetic, comparisons). */
function evalExpr(src: string, ctx: KillSwitchContext): { value: boolean; near: boolean } {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const isId = (w: string) => peek().k === 'id' && peek().s === w;
  const isOp = (s: string) => peek().k === 'op' && peek().s === s;

  type BoolRes = { value: boolean; near: boolean };

  const parseOr = (): BoolRes => {
    let a = parseAnd();
    while (isId('or')) {
      next();
      const b = parseAnd();
      const value = a.value || b.value;
      a = { value, near: !value && (a.near || b.near) };
    }
    return a;
  };
  const parseAnd = (): BoolRes => {
    let a = parseNot();
    while (isId('and')) {
      next();
      const b = parseNot();
      const value = a.value && b.value;
      // Only warn on an `and` conjunction when both sides are true or near (never when one side is far from tripping).
      const near = !value && ((a.value && b.near) || (b.value && a.near) || (a.near && b.near));
      a = { value, near };
    }
    return a;
  };
  const parseNot = (): BoolRes => {
    if (isId('not')) {
      next();
      const inner = parseNot();
      return { value: !inner.value, near: false };
    }
    return parseCmp();
  };
  const parseCmp = (): BoolRes => {
    if (isOp('(')) {
      const save = i;
      next();
      try {
        const inner = parseOr();
        if (isOp(')')) {
          next();
          return inner;
        }
      } catch {
        // Fall back to numeric parenthesized expression on lhs of a comparison.
      }
      i = save;
    }
    const lhs = parseSum();
    const t = peek();
    if (t.k !== 'op' || !['>', '<', '>=', '<=', '==', '!='].includes(t.s)) {
      throw new Error(`Expected comparison operator (>, <, >=, <=) in invalidate when rule`);
    }
    next();
    const rhs = parseSum();
    const res =
      t.s === '>' ? lhs > rhs : t.s === '<' ? lhs < rhs : t.s === '>=' ? lhs >= rhs : t.s === '<=' ? lhs <= rhs : t.s === '==' ? lhs === rhs : lhs !== rhs;
    let near = false;
    if (!res && Math.abs(rhs) > 1e-9) {
      const gap = Math.abs(lhs - rhs) / Math.abs(rhs);
      if (gap <= 0.15) near = true;
    }
    return { value: res, near };
  };
  const parseSum = (): number => {
    let a = parseProd();
    while (isOp('+') || isOp('-')) {
      const op = next().s;
      const b = parseProd();
      a = op === '+' ? a + b : a - b;
    }
    return a;
  };
  const parseProd = (): number => {
    let a = parseUnary();
    while (isOp('*') || isOp('/')) {
      const op = next().s;
      const b = parseUnary();
      a = op === '*' ? a * b : b === 0 ? NaN : a / b;
    }
    return a;
  };
  const parseUnary = (): number => {
    if (isOp('-')) {
      next();
      return -parseUnary();
    }
    if (isOp('+')) {
      next();
      return parseUnary();
    }
    return parseAtom();
  };
  const parseAtom = (): number => {
    const t = next();
    if (t.k === 'num') {
      // Allow optional trailing `bps` unit (e.g. `live slippage > 25 bps`).
      if (isId('bps')) next();
      return t.v;
    }
    if (t.k === 'op' && t.s === '(') {
      const v = parseSum();
      if (!isOp(')')) throw new Error('Missing ")" in invalidate when rule');
      next();
      return v;
    }
    if (t.k === 'id') {
      if (t.s === 'live') {
        const w = next();
        if (w.s === 'drawdown') return ctx.liveDrawdown;
        if (w.s === 'percentile') return ctx.livePercentile;
        if (w.s === 'slippage') return ctx.liveSlippageBps;
        if (w.s === 'bars') return ctx.liveBars;
        if (w.s === 'return') return ctx.liveReturn;
        if (w.s === 'rolling_sharpe' || w.s === 'sharpe') {
          if (isOp('(')) {
            next();
            if (peek().k === 'num') next();
            if (!isOp(')')) throw new Error('Missing ")" after live rolling_sharpe(...)');
            next();
          }
          return ctx.liveRollingSharpe;
        }
        throw new Error(`Unknown live metric "live ${w.s}"`);
      }
      if (t.s === 'backtest') {
        const w1 = next();
        if (w1.s === 'max') {
          const w2 = next();
          if (w2.s === 'drawdown') return ctx.backtestMaxDrawdown;
        }
        if (w1.s === 'drawdown') return ctx.backtestMaxDrawdown;
        throw new Error(`Unknown backtest metric "backtest ${w1.s}"`);
      }
      if (t.s === 'modeled') {
        const w = next();
        if (w.s === 'slippage') return ctx.modeledSlippageBps;
        throw new Error(`Unknown modeled metric "modeled ${w.s}"`);
      }
      throw new Error(`Unknown identifier "${t.s}" in invalidate when rule`);
    }
    throw new Error(`Unexpected token "${t.s}" in invalidate when rule`);
  };

  const out = parseOr();
  if (peek().k !== 'end') throw new Error(`Unexpected "${peek().s}" in invalidate when rule`);
  return out;
}

/** Splits an `invalidate when` expression into top-level `or` clauses (respecting parentheses) for granular reporting. */
function splitOrClauses(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /^\s+or\s+/i.test(expr.slice(i))) {
      const m = expr.slice(i).match(/^\s+or\s+/i)!;
      parts.push(expr.slice(start, i).trim());
      i += m[0].length - 1;
      start = i + 1;
    }
  }
  const tail = expr.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

const DUMMY_CTX: KillSwitchContext = {
  liveDrawdown: 0,
  backtestMaxDrawdown: 0.1,
  livePercentile: 0.5,
  liveRollingSharpe: 0,
  liveSlippageBps: 0,
  modeledSlippageBps: 5,
  liveBars: 0,
  liveReturn: 0,
};

/** Validates the syntax and metric names of an `invalidate when` rule at parse time; returns null if valid or an error message. */
export function validateKillSwitch(invalidateExpr: string): string | null {
  if (!invalidateExpr.trim()) return 'Write a condition after "invalidate when", for example live drawdown > 1.25 * backtest max drawdown';
  const clauses = splitOrClauses(invalidateExpr);
  if (clauses.length === 0) return 'Write a condition after "invalidate when"';
  try {
    for (const clause of clauses) evalExpr(clause, DUMMY_CTX);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Evaluates a strategy's `invalidate when` rule against live reality context. */
export function evaluateKillSwitch(invalidateExpr: string | undefined, ctx: KillSwitchContext): KillSwitchReport {
  if (!invalidateExpr || !invalidateExpr.trim()) {
    return { status: 'healthy', trippedClauses: [], checks: [] };
  }
  const clauses = splitOrClauses(invalidateExpr);
  const checks: KillSwitchCheck[] = [];
  const trippedClauses: string[] = [];
  let anyNear = false;
  try {
    for (const clause of clauses) {
      const { value, near } = evalExpr(clause, ctx);
      checks.push({ clause, tripped: value, near });
      if (value) trippedClauses.push(clause);
      if (near) anyNear = true;
    }
  } catch (e) {
    // Fail-visible: a broken stop rule must never silently report healthy.
    return { status: 'warning', trippedClauses: [], checks: [], error: e instanceof Error ? e.message : String(e) };
  }
  const status: KillSwitchReport['status'] = trippedClauses.length > 0 ? 'halted' : anyNear ? 'warning' : 'healthy';
  return { status, trippedClauses, checks };
}
