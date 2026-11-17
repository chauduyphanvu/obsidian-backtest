// "Why didn't it buy here?": every part of a ticker's rules, bar by bar, next to what the run did at that bar. Pure data;
// render-debug.ts draws it. The values come from the same Evaluator over the same prices as the run. What happened comes
// from the run's own records (trades with their `why`, `skipped`, `states`), so the table agrees with the trade list; a
// bar where the run made no trade is explained by reading the rules at that bar, never by simulating again.

import { WARMUP_INPUT, type Backtest } from './backtest.ts';
import { DAY, minus, price, stamp } from './dom.ts';
import { children, findPos, walk, type CmpOp, type Expr, type Rebalance, type Written } from './dsl.ts';
import type { AssetState, RankPlace, Trade, WarmupInput } from './engine.ts';
import type { Outcome } from './explain.ts';
import { specEvaluator, type BarRule, type Evaluator, type PosState } from './evaluate.ts';
import * as ind from './indicators.ts';
import type { Bars } from './types.ts';

export interface DebugColumn {
  id: string;
  group: 'buy' | 'sell' | 'rank';
  /**
   * test: a comparison; cross: crosses above or below; flag: a condition that compares nothing, such as month_end;
   * join: and, or or not; score and place: the ranking.
   */
  kind: 'test' | 'cross' | 'flag' | 'join' | 'score' | 'place';
  /** The word above the heading: Buy, Sell or Ranking. */
  caption: string;
  /** Short enough for a column; `text` has the whole of it. */
  heading: string;
  /** The user's own text for this part, or for the whole rule when `whole`. */
  text: string;
  /** The whole rule, not a part of it. A rule that is one comparison has only this column. */
  whole: boolean;
  /** How deep in the rule the part sits: 0 for the whole rule, 1 for a part of it, and so on. */
  depth: number;
  /** The comparison as a symbol, for kind test. */
  op: string;
  /** The values are fractions the rule writes as percentages. */
  percent: boolean;
}

export interface DebugCell {
  /** null where the part is not read: a position value while no position is held. */
  outcome: Outcome | null;
  /** The two sides of a comparison; the ranking score in a score column; the place (0 is best, -1 not eligible) and the number eligible in a place column. */
  a: number;
  b: number;
  /** The two sides at the bar before, for a cross. */
  pa: number;
  pb: number;
  /** Why the value is unknown, when that is cheap to tell. */
  note: string;
}

export type DebugEvent =
  /** `stage`: the buy rule or ranking decided it at this bar's close, the order filled at this bar, or both (fill: close). */
  | { k: 'buy'; stage: 'decided' | 'filled' | 'both'; trade: Trade }
  | { k: 'sell'; stage: 'decided' | 'filled' | 'both'; trade: Trade }
  /** The buy rule held with the position already open. */
  | { k: 'long' }
  /** The buy rule held after a stop or target exit, and had to stop holding before it could buy again. */
  | { k: 'rearm'; trade: Trade }
  /** The buy rule held but a sizing or stop input was still unknown. */
  | { k: 'warmup'; input: WarmupInput; n: number }
  /** The buy rule and the sell rule both held at this close. */
  | { k: 'sell-first' }
  /** An order from this last bar of the run, not filled. */
  | { k: 'pending'; side: 'buy' | 'sell' }
  /** The buy rule held and nothing stood in the way, but no buy was made: there was no cash. */
  | { k: 'no-cash' }
  /** A ranking decision kept the position, or chose a ticker that was not bought, or did not choose an eligible one. */
  | { k: 'kept' }
  | { k: 'chosen' }
  | { k: 'ranked-out' };

export interface DebugRank {
  score: number;
  /** 0 for the best; -1 when the ticker could not be chosen; NaN at a bar where no decision was made. */
  place: number;
  eligible: number;
  top: number;
  decision: boolean;
}

export interface DebugRow {
  /** Index among the ticker's bars in the run, from 0. */
  index: number;
  /** Index in the ticker's price bars. */
  bar: number;
  t: number;
  close: number;
  /** One for each of debugColumns. */
  cells: DebugCell[];
  /** The whole buy rule at this close. */
  buy: Outcome;
  /** The top-level parts of the buy rule when it is an `and` chain, else the rule itself. Empty without a written rule. */
  buyChain: Outcome[];
  /** The sell rule as the run reads it, with the position when one is held; null when there is none. */
  sell: Outcome | null;
  /** Long at the end of this bar, after its fills. */
  held: boolean;
  /** The sell rule had a position to read at this close. */
  readHeld: boolean;
  /** The shares bought; rebalancing may have changed them since (`resized`). NaN when flat. */
  shares: number;
  resized: boolean;
  rank: DebugRank | null;
  events: DebugEvent[];
  /** What happened, in plain words; empty when nothing did. */
  what: string;
}

export interface TradeStop {
  trade: Trade;
  /** The row of the bar the decision was read at. */
  index: number;
  /** The row of the bar the buy filled at. */
  fill: number;
}

const OPS: Record<Exclude<CmpOp, 'xup' | 'xdn'>, string> = { '>': '>', '<': '<', '>=': '≥', '<=': '≤', '==': '=', '!=': '≠' };
const SHORT = 22;

// ---------------------------------------------------------------- small helpers, as explain.ts has them

const outcome = (v: number): Outcome => (v === 1 ? 'yes' : v === 0 ? 'no' : 'unknown');

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

function fixed(x: number, d: number): string {
  if (Number.isNaN(x)) return 'unknown';
  if (!Number.isFinite(x)) return x > 0 ? 'infinity' : '−infinity';
  const digits = Number.isInteger(x) ? 0 : d;
  return minus(x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
}

function places(x: number): number {
  const a = Math.abs(x);
  return a >= 1 || a === 0 || !Number.isFinite(a) ? 2 : a >= 0.01 ? 4 : 6;
}

/** Two values side by side, with enough decimals that different numbers never print the same. */
function pair(a: number, b: number, percent: boolean): [string, string] {
  const f = (x: number, d: number) => (percent && Number.isFinite(x) ? `${fixed(Number((x * 100).toPrecision(12)), d)}%` : fixed(x, d));
  let d = Math.max(places(percent ? a * 100 : a), places(percent ? b * 100 : b));
  while (d < 10 && a !== b && f(a, d) === f(b, d)) d++;
  return [f(a, d), f(b, d)];
}

const shareCount = (x: number) => minus(x.toLocaleString('en-US', { maximumFractionDigits: 4 }));

/** A bar index: the latest bar at or before `at`, or -1. */
function barAt(t: number[], at: number): number {
  let a = 0;
  let b = t.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (t[m] <= at) a = m + 1;
    else b = m;
  }
  return a - 1;
}

/** The first bar at or after `at`, or t.length. */
function barFrom(t: number[], at: number): number {
  return barAt(t, at - 1) + 1;
}

/** The same rhythm as engine.ts uses to find the bars where a ranking decides. */
function periodKey(t: number, mode: Rebalance): number {
  const d = new Date(t);
  switch (mode) {
    case 'weekly':
      return Math.floor((Math.floor(t / DAY) + 3) / 7);
    case 'monthly':
      return d.getUTCFullYear() * 12 + d.getUTCMonth();
    case 'quarterly':
      return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3);
    case 'yearly':
      return d.getUTCFullYear();
    case 'never':
      return 0;
  }
}

const isLevelExit = (t: Trade) => t.reason === 'stop loss' || t.reason === 'trailing stop' || t.reason === 'take profit';
const shorten = (text: string) => (text.length > SHORT ? `${text.slice(0, SHORT - 1).trimEnd()}…` : text);

// ---------------------------------------------------------------- what is worked out once for a result

/** One ticker's bars in the run, and its trades indexed by the bars they happened at. */
interface AssetIx {
  name: string;
  bars: Bars;
  /** Index of the first of its bars that lies in the run, and how many do. */
  first: number;
  count: number;
  trades: Trade[];
  byEntry: Map<number, Trade>;
  byExit: Map<number, Trade>;
  byBuy: Map<number, Trade>;
  bySell: Map<number, Trade>;
  state: AssetState | undefined;
}

interface PlanCol {
  col: DebugColumn;
  expr: Expr | null;
}

/** The columns of a ticker, and the part of the rules each one reads. */
interface Plan {
  cols: PlanCol[];
  /** Indexes in `cols` of the top-level parts of the buy rule: its `and` chain, or the rule itself. */
  chain: number[];
}

/** The parts of one rule, in the order the trade explanation lists them, then the whole rule. */
function ruleColumns(group: 'buy' | 'sell', e: Expr, w: Written, params: { name: string; percent: boolean }[]): { cols: PlanCol[]; chain: number[] } {
  const texts = new Map<Expr, string>();
  let k = 0;
  walk(e, (x) => texts.set(x, w.parts[k++] ?? ''));
  const text = (x: Expr) => texts.get(x) || '';
  const percentText = (s: string) => s.trim().endsWith('%') || params.some((p) => p.percent && p.name.toLowerCase() === s.trim().toLowerCase());
  const caption = group === 'buy' ? 'Buy' : 'Sell';

  const order: { x: Expr; depth: number }[] = [];
  const visit = (x: Expr, depth: number) => {
    order.push({ x, depth });
    if (x.k === 'logic') {
      const parts: Expr[] = [];
      const flat = (y: Expr): void => {
        if (y.k === 'logic' && y.op === x.op) {
          flat(y.a);
          flat(y.b);
        } else parts.push(y);
      };
      flat(x);
      for (const p of parts) visit(p, depth + 1);
    } else if (x.k === 'not') visit(x.a, depth + 1);
  };
  visit(e, 0);

  const make = (x: Expr, depth: number, whole: boolean, n: number): PlanCol => {
    const label = whole ? w.text : text(x) || `part ${n}`;
    const cmp = x.k === 'cmp' ? x : null;
    const cross = cmp !== null && (cmp.op === 'xup' || cmp.op === 'xdn');
    const kind: DebugColumn['kind'] = cmp ? (cross ? 'cross' : 'test') : x.k === 'logic' || x.k === 'not' ? 'join' : 'flag';
    const op = cmp ? (cmp.op === 'xup' ? 'crosses above' : cmp.op === 'xdn' ? 'crosses below' : OPS[cmp.op]) : '';
    return {
      expr: x,
      col: {
        id: `${group}:${n}`,
        group,
        kind,
        caption,
        heading: whole && kind === 'join' ? 'Whole rule' : shorten(label),
        text: label,
        whole,
        depth,
        op,
        percent: cmp !== null && (percentText(text(cmp.a)) || percentText(text(cmp.b))),
      },
    };
  };
  if (order.length === 1) return { cols: [make(e, 0, true, 0)], chain: [0] };
  const cols = order.slice(1).map(({ x, depth }, n) => make(x, depth, false, n));
  cols.push(make(e, 0, true, cols.length));
  // The chain a near miss is judged on: the parts directly under an `and`, else the whole rule.
  const chain = e.k === 'logic' && e.op === 'and' ? cols.flatMap((c, n) => (c.col.depth === 1 ? [n] : [])) : [cols.length - 1];
  return { cols, chain };
}

/** A ticker's rules, evaluated once over its whole series (what the Evaluator memoises) or ready to read at a bar. */
interface Sig {
  buy: number[];
  sell: BarRule | null;
  score: number[] | null;
}

class Ctx {
  bt: Backtest;
  ev: Evaluator;
  intraday: boolean;
  atClose: boolean;
  private assets = new Map<string, AssetIx>();
  private plans = new Map<string, Plan>();
  private moments = new Map<string, number[]>();
  private decisions: number[] | null = null;
  private rankings = new Map<number, string[]>();
  private sigs = new Map<string, Sig>();

  constructor(bt: Backtest) {
    this.bt = bt;
    this.ev = specEvaluator(bt.spec, bt.data);
    this.intraday = bt.run.t.some((t) => t % DAY !== 0);
    this.atClose = bt.spec.fill === 'close';
  }

  asset(name: string): AssetIx {
    let ix = this.assets.get(name);
    if (ix) return ix;
    const bars = this.bt.data.get(name);
    if (!bars) throw new Error(`The result has no prices for ${name}`);
    const { run } = this.bt;
    const first = barFrom(bars.t, run.t[0]);
    const last = barAt(bars.t, run.t[run.t.length - 1]);
    const trades = run.trades.filter((t) => t.asset === name);
    const index = (pick: (t: Trade) => number | null) => {
      const m = new Map<number, Trade>();
      for (const t of trades) {
        const at = pick(t);
        if (at !== null && !Number.isNaN(at)) m.set(at, t);
      }
      return m;
    };
    ix = {
      name,
      bars,
      first,
      count: Math.max(0, last - first + 1),
      trades,
      byEntry: index((t) => t.entryT),
      byExit: index((t) => (t.reason === 'open' ? null : t.exitT)),
      byBuy: index((t) => t.why?.buyT ?? null),
      bySell: index((t) => (t.why?.exit && t.why.exit.k !== 'level' ? t.why.exit.t : null)),
      state: run.states.find((s) => s.name === name),
    };
    this.assets.set(name, ix);
    return ix;
  }

  sig(name: string): Sig {
    let sig = this.sigs.get(name);
    if (!sig) {
      const { spec } = this.bt;
      const rules = spec.rules[name];
      sig = {
        buy: this.ev.eval(rules.buy, name),
        sell: rules.sell ? this.ev.compile(rules.sell, name) : null,
        score: spec.rank ? this.ev.eval(spec.rank.by, name) : null,
      };
      this.sigs.set(name, sig);
    }
    return sig;
  }

  plan(name: string): Plan {
    let plan = this.plans.get(name);
    if (plan) return plan;
    const { spec } = this.bt;
    const rules = spec.rules[name];
    const written = spec.written?.rules[name];
    const cols: PlanCol[] = [];
    let chain: number[] = [];
    if (written?.buy) {
      const buy = ruleColumns('buy', rules.buy, written.buy, spec.params);
      chain = buy.chain;
      cols.push(...buy.cols);
    }
    if (rules.sell && written?.sell) cols.push(...ruleColumns('sell', rules.sell, written.sell, spec.params).cols);
    if (spec.rank) {
      const by = spec.written?.rank?.text ?? 'the score';
      const rank = { group: 'rank', caption: 'Ranking', whole: false, depth: 0, op: '', percent: false } as const;
      cols.push({ expr: null, col: { ...rank, id: 'rank:score', kind: 'score', heading: 'Score', text: by } });
      cols.push({ expr: null, col: { ...rank, id: 'rank:place', kind: 'place', heading: 'Place', text: 'Place among the tickers that could be chosen, at the bars where the ranking decides' } });
    }
    plan = { cols, chain };
    this.plans.set(name, plan);
    return plan;
  }

  /** ATR over a ticker's whole series: the same indicator the engine reads its sizing and stop distances from. */
  atr(ix: AssetIx, n: number): number[] {
    const key = `atr ${ix.name} ${n}`;
    let v = this.moments.get(key);
    if (!v) this.moments.set(key, (v = ind.atr(ix.bars.h, ix.bars.l, ix.bars.c, n)));
    return v;
  }

  vol(ix: AssetIx, n: number): number[] {
    const key = `vol ${ix.name} ${n}`;
    let v = this.moments.get(key);
    if (!v) this.moments.set(key, (v = ind.stdev(ind.returns(ix.bars.c), n)));
    return v;
  }

  /** Whether the run held buy signals back for this ticker while an input warmed up. */
  everHeldBack(name: string): boolean {
    return this.bt.run.skipped.some((s) => s.asset === name);
  }

  /**
   * The first input a buy needs that is unknown at bar `bar`: the check the engine makes before it buys (engine.ts
   * missingInput), repeated here to say where the signals it counted in `run.skipped` were.
   */
  missingInput(ix: AssetIx, bar: number): { input: WarmupInput; n: number } | null {
    const { sizing } = this.bt.spec;
    if (sizing.k === 'risk' && Number.isNaN(this.atr(ix, sizing.n)[bar])) return { input: 'risk per trade', n: sizing.n };
    if (sizing.k === 'invvol' && Number.isNaN(this.vol(ix, sizing.n)[bar])) return { input: 'inverse volatility', n: sizing.n };
    const stops = this.bt.spec.stops[ix.name];
    if (!stops) return null;
    for (const [input, level] of [['stop loss', stops.stopLoss], ['trailing stop', stops.trailingStop], ['take profit', stops.takeProfit]] as const) {
      if (level?.k === 'atr' && Number.isNaN(this.atr(ix, level.n)[bar])) return { input, n: level.n };
    }
    return null;
  }

  /** Whether a ranking decides at the timeline time `t`. */
  decides(t: number): boolean {
    const { spec, run } = this.bt;
    if (!spec.rank) return false;
    if (spec.rebalance === 'never') return true;
    this.decisions ??= ind.periodEnds(run.t, (x) => periodKey(x, spec.rebalance));
    const k = barAt(run.t, t);
    return k >= 0 && run.t[k] === t && this.decisions[k] === 1;
  }

  /**
   * The tickers that could be chosen at time `t`, best first, ties to the ticker listed first. For each ticker its latest
   * bar at or before then counts, and it is eligible when its buy rule holds, its sell rule does not and its score is
   * known: the tests engine.ts makes. The place a trade recorded is taken from the trade, not from here.
   */
  ranking(t: number): string[] {
    let r = this.rankings.get(t);
    if (r) return r;
    const eligible: { name: string; score: number; order: number }[] = [];
    this.bt.spec.universe.forEach((a, order) => {
      const ix = this.asset(a.name);
      const j = barAt(ix.bars.t, t);
      if (j < 0) return;
      const sig = this.sig(a.name);
      const score = sig.score![j];
      const holding = openAtRead(ix, t, this.atClose);
      const sells = sig.sell !== null && sig.sell(j, holding ? posOf(ix, holding) : null) === 1;
      if (sig.buy[j] === 1 && !sells && Number.isFinite(score)) eligible.push({ name: a.name, score, order });
    });
    eligible.sort((x, y) => y.score - x.score || x.order - y.order);
    r = eligible.map((x) => x.name);
    if (this.rankings.size > 64) this.rankings.clear();
    this.rankings.set(t, r);
    return r;
  }
}

const contexts = new WeakMap<Backtest, Ctx>();

function ctxOf(bt: Backtest): Ctx {
  let cx = contexts.get(bt);
  if (!cx) contexts.set(bt, (cx = new Ctx(bt)));
  return cx;
}

/** The last trade that started at or before time `t`. Trades of one ticker never overlap and are in order. */
function startedBy(ix: AssetIx, t: number): Trade | null {
  let a = 0;
  let b = ix.trades.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (ix.trades[m].entryT <= t) a = m + 1;
    else b = m;
  }
  return a > 0 ? ix.trades[a - 1] : null;
}

/** The trade held at the end of the bar at time `t`, after the fills of that bar. */
function openAfter(ix: AssetIx, t: number): Trade | null {
  const tr = startedBy(ix, t);
  return tr && (tr.reason === 'open' || t < tr.exitT) ? tr : null;
}

/**
 * The trade the rules had to read at the close of `t`. With next-open fills that is the one held after the bar's fills.
 * With fill: close the rules are read before the close's own orders fill, so a buy at this close is not yet held, and a
 * sell at this close still is; a stop or target exit came before the reading and is gone.
 */
function openAtRead(ix: AssetIx, t: number, atClose: boolean): Trade | null {
  if (!atClose) return openAfter(ix, t);
  const tr = startedBy(ix, t - 1);
  if (!tr) return null;
  return tr.reason === 'open' || (tr.reason === 'signal' ? t <= tr.exitT : t < tr.exitT) ? tr : null;
}

function posOf(ix: AssetIx, tr: Trade): PosState {
  return { entryIdx: barAt(ix.bars.t, tr.entryT), entryPrice: tr.entryPrice };
}

// ---------------------------------------------------------------- columns and rows

/** How many of the ticker's bars lie in the run, and the first and last time. */
export function debugRange(bt: Backtest, asset: string): { count: number; from: number; to: number } {
  const ix = ctxOf(bt).asset(asset);
  return { count: ix.count, from: ix.count ? ix.bars.t[ix.first] : NaN, to: ix.count ? ix.bars.t[ix.first + ix.count - 1] : NaN };
}

/** The row of the first bar at or after time `t`, or the last row when there is none. */
export function barOnOrAfter(bt: Backtest, asset: string, t: number): number {
  const ix = ctxOf(bt).asset(asset);
  return Math.max(0, Math.min(ix.count - 1, barFrom(ix.bars.t, t) - ix.first));
}

export function debugColumns(bt: Backtest, asset: string): DebugColumn[] {
  return ctxOf(bt).plan(asset).cols.map((c) => c.col);
}

/** What one column reads, ready to evaluate at a bar. */
interface Reader {
  col: DebugColumn;
  expr: Expr | null;
  readsPos: boolean;
  out: BarRule | null;
  a: BarRule | null;
  b: BarRule | null;
}

const na = (a = NaN, b = NaN): DebugCell => ({ outcome: null, a, b, pa: NaN, pb: NaN, note: '' });

/** The rows for bars `from` up to but not including `to`, counted among the ticker's bars in the run. */
export function debugRows(bt: Backtest, asset: string, from: number, to: number): DebugRow[] {
  const cx = ctxOf(bt);
  const ix = cx.asset(asset);
  const { spec } = bt;
  const lo = Math.max(0, Math.floor(from));
  const hi = Math.min(ix.count, Math.floor(to));
  const rows: DebugRow[] = [];
  if (lo >= hi) return rows;

  const plan = cx.plan(asset);
  const sig = cx.sig(asset);
  const readers = plan.cols.map(({ col, expr }): Reader => ({
    col,
    expr,
    readsPos: expr !== null && findPos(expr) !== null,
    out: expr ? cx.ev.compile(expr, asset) : null,
    a: expr?.k === 'cmp' ? cx.ev.compile(expr.a, asset) : null,
    b: expr?.k === 'cmp' ? cx.ev.compile(expr.b, asset) : null,
  }));
  const scoreCol = plan.cols.findIndex((c) => c.col.kind === 'score');
  const placeCol = plan.cols.findIndex((c) => c.col.kind === 'place');
  const top = spec.rank?.top ?? 0;
  const lastBar = ix.first + ix.count - 1;
  const checkInputs = cx.everHeldBack(asset);

  // After a stop or target exit the buy rule has to stop holding before it can buy again (rule 29); not with `hold`.
  let stopped: Trade | null = null;
  if (!spec.rank) {
    const t0 = ix.bars.t[ix.first + lo];
    let p = ix.trades.length - 1;
    while (p >= 0 && !(ix.trades[p].reason !== 'open' && ix.trades[p].exitT < t0)) p--;
    if (p >= 0 && isLevelExit(ix.trades[p])) {
      stopped = ix.trades[p];
      for (let j = barAt(ix.bars.t, stopped.exitT); j < ix.first + lo; j++) {
        if (sig.buy[j] !== 1) {
          stopped = null;
          break;
        }
      }
    }
  }

  for (let k = lo; k < hi; k++) {
    const b = ix.first + k;
    const t = ix.bars.t[b];
    const after = openAfter(ix, t);
    const reading = openAtRead(ix, t, cx.atClose);
    const pos = reading ? posOf(ix, reading) : null;

    const cells = readers.map((r): DebugCell => {
      // A part that compares a position value has nothing to compare while no position is held. Joins are still worked out
      // the way the engine does, with the position unknown, since a buy is skipped when the sell rule holds without it.
      if (r.out === null || (r.readsPos && !pos && (r.col.kind === 'test' || r.col.kind === 'cross'))) return na();
      const o = outcome(r.out(b, pos));
      const cell: DebugCell = { outcome: o, a: NaN, b: NaN, pa: NaN, pb: NaN, note: '' };
      if (r.a && r.b) {
        cell.a = r.a(b, pos);
        cell.b = r.b(b, pos);
        if (r.col.kind === 'cross' && b > 0) {
          cell.pa = r.a(b - 1, pos);
          cell.pb = r.b(b - 1, pos);
        }
      }
      if (o === 'unknown') cell.note = whyUnknown(cx, r.expr!, asset, b, pos);
      return cell;
    });

    const buy = outcome(sig.buy[b]);
    const sell = sig.sell ? outcome(sig.sell(b, pos)) : null;
    const chain = plan.chain.map((n) => cells[n].outcome ?? 'unknown');

    const bought = ix.byBuy.get(t);
    const sold = ix.bySell.get(t);
    const entered = ix.byEntry.get(t);
    const exited = ix.byExit.get(t);
    if (!spec.rank) {
      if (exited && isLevelExit(exited)) stopped = exited;
      if (reading) stopped = null;
      else if (stopped && buy !== 'yes') stopped = null;
    }

    const events: DebugEvent[] = [];
    if (entered) events.push({ k: 'buy', stage: bought === entered ? 'both' : 'filled', trade: entered });
    if (exited) events.push({ k: 'sell', stage: sold === exited ? 'both' : 'filled', trade: exited });
    if (bought && bought !== entered) events.push({ k: 'buy', stage: 'decided', trade: bought });
    if (sold && sold !== exited) events.push({ k: 'sell', stage: 'decided', trade: sold });

    let rank: DebugRank | null = null;
    if (sig.score) {
      const recorded = recordedPlace(bought, sold, t);
      const decision = recorded !== null || cx.decides(t);
      let place = NaN;
      let eligible = 0;
      if (recorded) {
        place = recorded.place;
        eligible = recorded.decision.eligible;
      } else if (decision) {
        const chosen = cx.ranking(t);
        place = chosen.indexOf(asset);
        eligible = chosen.length;
      }
      rank = { score: sig.score[b], place, eligible, top, decision };
      cells[scoreCol] = na(rank.score);
      cells[placeCol] = na(rank.place, rank.eligible);
    }

    const isLast = b === lastBar;
    const pending = isLast ? ix.state?.pending ?? null : null;
    if (!spec.rank) {
      if (buy === 'yes' && reading) {
        // A bar that bought or sold already says more than that the rule holds with a position open.
        if (pending !== 'sell' && !events.some((e) => e.k === 'buy' || e.k === 'sell')) events.push({ k: 'long' });
      } else if (buy === 'yes' && !reading && !bought) {
        const missing = checkInputs ? cx.missingInput(ix, b) : null;
        if (sell === 'yes') events.push({ k: 'sell-first' });
        else if (stopped) events.push({ k: 'rearm', trade: stopped });
        else if (missing) events.push({ k: 'warmup', ...missing });
        else if (pending !== 'buy') events.push({ k: 'no-cash' });
      }
    } else if (rank && rank.decision && rank.place >= 0) {
      const chosen = rank.place < top;
      if (reading && chosen) events.push({ k: 'kept' });
      else if (!reading && chosen && !bought) {
        const missing = checkInputs ? cx.missingInput(ix, b) : null;
        if (missing) events.push({ k: 'warmup', ...missing });
        else if (pending !== 'buy') events.push({ k: 'chosen' });
      } else if (!reading && !chosen) events.push({ k: 'ranked-out' });
    }
    if (pending) events.push({ k: 'pending', side: pending });

    const row: DebugRow = {
      index: k,
      bar: b,
      t,
      close: ix.bars.c[b],
      cells,
      buy,
      buyChain: chain,
      sell,
      held: after !== null,
      readHeld: reading !== null,
      shares: after?.why?.shares ?? NaN,
      resized: !!after?.why && after.why.topUps + after.why.trims > 0,
      rank,
      events,
      what: '',
    };
    row.what = words(cx, ix, row);
    rows.push(row);
  }
  return rows;
}

/** The place a trade recorded at the ranking that read this bar, when one did. */
function recordedPlace(bought: Trade | undefined, sold: Trade | undefined, t: number): RankPlace | null {
  if (bought?.why?.rank && bought.why.rank.t === t) return bought.why.rank;
  const exit = sold?.why?.exit;
  if (exit?.k === 'rank' && exit.rank.t === t) return exit.rank;
  return null;
}

/** Why a part is unknown at bar `i`, when it can be told from its own pieces. */
function whyUnknown(cx: Ctx, e: Expr, asset: string, i: number, pos: PosState | null): string {
  const value = (x: Expr, a: string, j: number): number => (j < 0 ? NaN : findPos(x) ? (pos ? cx.ev.compile(x, a)(j, pos) : NaN) : cx.ev.eval(x, a)[j]);
  const visit = (x: Expr, a: string, j: number): string => {
    if (!Number.isNaN(value(x, a, j))) return '';
    if (x.k === 'pos') return 'no position is held';
    if (x.k === 'of') {
      if (x.asset === a) return visit(x.a, a, j);
      const k = cx.ev.barOf(x.asset, a, j);
      return k < 0 ? `${x.asset} had no finished bar yet` : visit(x.a, x.asset, k);
    }
    if (x.k === 'lag') return j - x.n < 0 ? 'looks back past the first bar' : visit(x.a, a, j - x.n);
    for (const c of children(x)) {
      const why = visit(c, a, j);
      if (why) return why;
    }
    if (x.k === 'ind') return 'still warming up';
    if (x.k === 'bin' && x.op === '/') return 'divides by 0';
    if (x.k === 'cmp' && (x.op === 'xup' || x.op === 'xdn')) return 'the bar before is unknown';
    return '';
  };
  return visit(e, asset, i);
}

// ---------------------------------------------------------------- what happened, in words

/** "2nd of 5". */
const placeWords = (place: number, eligible: number) => `${ordinal(place + 1)} of ${eligible}`;

function words(cx: Ctx, ix: AssetIx, row: DebugRow): string {
  const when = (t: number) => stamp(t, cx.intraday);
  const ranked = cx.bt.spec.rank !== null;
  /** Where an order that was decided at this bar fills: at this close, or at a later bar. */
  const fillWords = (fillT: number, at: number) => {
    if (fillT === row.t) return `at this close at ${price(at)}`;
    if (cx.atClose) return `at the close of ${when(fillT)} at ${price(at)}`;
    return `at ${fillT === ix.bars.t[row.bar + 1] ? 'the next open' : 'the open'} (${when(fillT)}) at ${price(at)}`;
  };
  const out: string[] = [];
  for (const e of row.events) {
    switch (e.k) {
      case 'buy': {
        const tr = e.trade;
        if (e.stage === 'filled') {
          out.push(`Bought at ${cx.atClose ? 'the close' : 'the open'} at ${price(tr.entryPrice)}.`);
        } else {
          const rank = tr.why?.rank;
          const why = rank ? `Chosen by the ranking, ${placeWords(rank.place, rank.decision.eligible)}` : 'Buy rule held';
          out.push(`${why}: bought ${fillWords(tr.entryT, tr.entryPrice)}.`);
        }
        break;
      }
      case 'sell': {
        const tr = e.trade;
        if (e.stage === 'filled') {
          if (tr.reason === 'stop loss') out.push(`Stopped out at ${price(tr.exitPrice)}.`);
          else if (tr.reason === 'trailing stop') out.push(`Trailing stop hit: sold at ${price(tr.exitPrice)}.`);
          else if (tr.reason === 'take profit') out.push(`Take profit hit: sold at ${price(tr.exitPrice)}.`);
          else out.push(`Sold at ${cx.atClose ? 'the close' : 'the open'} at ${price(tr.exitPrice)}.`);
        } else {
          const why = tr.why?.exit?.k === 'rank' ? 'The ranking no longer holds it' : 'Sell rule held';
          out.push(`${why}: sold ${fillWords(tr.exitT, tr.exitPrice)}.`);
        }
        break;
      }
      case 'long':
        out.push('Buy rule held but already long.');
        break;
      case 'rearm':
        out.push(`Buy rule held but waiting for the rule to stop holding after ${e.trade.exitT === row.t ? 'this' : 'the'} ${e.trade.reason}${e.trade.exitT === row.t ? '' : ` on ${when(e.trade.exitT)}`}.`);
        break;
      case 'warmup':
        out.push(`${ranked ? 'Chosen, but the buy' : 'Buy rule held, but the buy'} waited: ${WARMUP_INPUT[e.input](e.n)} was still unknown.`);
        break;
      case 'sell-first':
        out.push('Buy rule held, but the sell rule held too, so no buy.');
        break;
      case 'pending':
        out.push(`Order pending: ${e.side} at the next ${cx.atClose ? 'close' : 'open'}.`);
        break;
      case 'no-cash':
        out.push('Buy rule held, but no buy was made: no cash was free.');
        break;
      case 'kept':
        out.push(`Kept by the ranking, ${placeWords(row.rank!.place, row.rank!.eligible)}.`);
        break;
      case 'chosen':
        out.push(`Chosen by the ranking, ${placeWords(row.rank!.place, row.rank!.eligible)}, but no buy followed: no cash was free.`);
        break;
      case 'ranked-out':
        out.push(`Ranked ${placeWords(row.rank!.place, row.rank!.eligible)}: only the best ${row.rank!.top} ${row.rank!.top === 1 ? 'is' : 'are'} held.`);
        break;
    }
  }
  return out.join(' ');
}

/** "Flat", or "Long" with the shares that were bought. */
export function positionWords(row: DebugRow): string {
  if (!row.held) return 'Flat';
  if (Number.isNaN(row.shares)) return 'Long';
  return row.resized ? `Long, bought ${shareCount(row.shares)} shares` : `Long, ${shareCount(row.shares)} shares`;
}

/** The marks that say a part held, did not, or is unknown, in words as well as symbols. */
export const MARK: Record<Outcome, string> = { yes: '✓ yes', no: '✗ no', unknown: '? unknown' };

/** The text of one cell: the values compared and, for a cross or an unknown, a second line. */
export function cellText(col: DebugColumn, cell: DebugCell): { main: string; detail: string } {
  if (col.kind === 'score') return { main: fixed(cell.a, places(cell.a)), detail: '' };
  if (col.kind === 'place') return { main: Number.isNaN(cell.a) ? '–' : cell.a < 0 ? 'not eligible' : `${ordinal(cell.a + 1)} of ${cell.b}`, detail: '' };
  if (cell.outcome === null) return { main: '–', detail: '' };
  const note = cell.outcome === 'unknown' ? cell.note : '';
  if (col.kind === 'test') {
    const [a, b] = pair(cell.a, cell.b, col.percent);
    return { main: `${a} ${col.op} ${b}`, detail: note };
  }
  if (col.kind === 'cross') {
    const [a, b] = pair(cell.a, cell.b, col.percent);
    const [pa, pb] = pair(cell.pa, cell.pb, col.percent);
    return { main: `${a} vs ${b}`, detail: [`before ${pa} vs ${pb}`, note].filter(Boolean).join('; ') };
  }
  return { main: '', detail: note };
}

// ---------------------------------------------------------------- the filter and the trade list

/**
 * A bar where the buy rule, an `and` chain of two or more parts, failed by one part: every other part held and exactly one
 * was false. A part that is unknown is not a near miss, since it may fail once it is known.
 */
export function nearMiss(row: DebugRow): boolean {
  if (row.buy === 'yes' || row.buyChain.length < 2) return false;
  const no = row.buyChain.filter((o) => o === 'no').length;
  const yes = row.buyChain.filter((o) => o === 'yes').length;
  return no === 1 && yes === row.buyChain.length - 1;
}

/** Whether a bar is worth showing when only the ones where something happened or nearly happened are wanted. */
export function interesting(row: DebugRow): boolean {
  return row.events.length > 0 || row.held || row.buy === 'yes' || nearMiss(row);
}

/** Each trade of the ticker with the rows of its decision and its fill, in order. */
export function tradeStops(bt: Backtest, asset: string): TradeStop[] {
  const ix = ctxOf(bt).asset(asset);
  const row = (t: number) => Math.max(0, Math.min(ix.count - 1, barAt(ix.bars.t, t) - ix.first));
  return ix.trades.map((trade) => ({ trade, index: row(trade.why?.buyT ?? trade.entryT), fill: row(trade.entryT) }));
}

/** The ranking at time `t` as computed from the rules, apart from the places trades recorded: the tickers that could be chosen, best first. */
export function rankingAt(bt: Backtest, t: number): string[] {
  return ctxOf(bt).ranking(t);
}

// ---------------------------------------------------------------- CSV

const csvField = (v: string | number): string => {
  const x = String(v);
  return /[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
};
const csvLine = (fields: (string | number)[]): string => fields.map(csvField).join(',') + '\n';
const num = (x: number): string => (Number.isFinite(x) ? String(Number(x.toPrecision(12))) : '');

/** The names of the fields a column makes in the CSV, with the user's own text in them. */
function csvHeads(col: DebugColumn): string[] {
  const name = col.kind === 'join' && col.whole ? `${col.group} rule` : `${col.group}: ${col.text}`;
  switch (col.kind) {
    case 'test':
      return [`${name} (left)`, `${name} (right)`, `${name} (result)`];
    case 'cross':
      return [`${name} (left)`, `${name} (right)`, `${name} (left before)`, `${name} (right before)`, `${name} (result)`];
    case 'score':
      return [`rank score: ${col.text}`];
    case 'place':
      return ['rank place', 'rank eligible'];
    default:
      return [name];
  }
}

function csvFields(col: DebugColumn, cell: DebugCell): string[] {
  const result = cell.outcome ?? '';
  switch (col.kind) {
    case 'test':
      return [num(cell.a), num(cell.b), result];
    case 'cross':
      return [num(cell.a), num(cell.b), num(cell.pa), num(cell.pb), result];
    case 'score':
      return [num(cell.a)];
    case 'place':
      return Number.isNaN(cell.a) ? ['', ''] : [cell.a < 0 ? '' : String(cell.a + 1), String(cell.b)];
    default:
      return [result];
  }
}

/** Every bar of the ticker in the run, with the columns of the table: values as plain numbers, outcomes as yes, no or unknown. */
export function debugCsv(bt: Backtest, asset: string): string {
  const cx = ctxOf(bt);
  const cols = debugColumns(bt, asset);
  const rows = debugRows(bt, asset, 0, cx.asset(asset).count);
  let out = csvLine([cx.intraday ? 'time (UTC)' : 'date', 'close', ...cols.flatMap(csvHeads), 'position', 'shares', 'what happened']);
  for (const r of rows) {
    out += csvLine([stamp(r.t, cx.intraday), num(r.close), ...cols.flatMap((c, n) => csvFields(c, r.cells[n])), r.held ? 'long' : 'flat', num(r.shares), r.what]);
  }
  return out;
}
