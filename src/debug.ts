// "Why didn't it buy here?": every part of a ticker's rules, bar by bar, next to what the run did at that bar. Pure data;
// render-debug.ts draws it. The values come from the same Evaluator over the same prices as the run. What happened comes
// from the run's own records (trades with their `why`, `skipped`, `states`), so the table agrees with the trade list; a
// bar where the run made no trade is explained by reading the rules at that bar, never by simulating again.

import { WARMUP_INPUT, type Backtest } from './backtest.ts';
import { children, findPos, isOneThing, walk, type Expr, type Written } from './dsl.ts';
import { barAt, missingInputAt, periodKey, SMALL_TRADE, type AssetState, type RankPlace, type Trade, type WarmupInput } from './engine.ts';
import { OPS, outcome, type Outcome } from './explain.ts';
import { specEvaluator, type BarRule, type Evaluator, type PosState } from './evaluate.ts';
import { csvLine } from './export.ts';
import { fixed, isIntraday, pair, places, price, shareCount, stamp, ungroupedOrdinal } from './format.ts';
import * as ind from './indicators.ts';
import { flipped } from './price-chart.ts';
import type { Bars } from './types.ts';

export interface DebugColumn {
  id: string;
  group: 'buy' | 'sell' | 'short' | 'cover' | 'add' | 'rank';
  /**
   * test: a comparison; cross: crosses above or below; flag: a condition that compares nothing, such as month_end;
   * join: and, or or not; score and place: the ranking.
   */
  kind: 'test' | 'cross' | 'flag' | 'join' | 'score' | 'place';
  /** The word above the heading: Buy, Sell, Short, Cover, Add or Ranking. */
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
  /**
   * `stage`: the buy rule or ranking decided it at this bar's close, the order filled at this bar, or both (fill: close).
   * `short` and `cover` are a short's entry and exit, as `buy` and `sell` are a long's.
   */
  | { k: 'buy'; stage: 'decided' | 'filled' | 'both'; trade: Trade }
  | { k: 'sell'; stage: 'decided' | 'filled' | 'both'; trade: Trade }
  | { k: 'short'; stage: 'decided' | 'filled' | 'both'; trade: Trade }
  | { k: 'cover'; stage: 'decided' | 'filled' | 'both'; trade: Trade }
  /** The other side's entry rule closed `from` and opened `to` at the same fill. */
  | { k: 'flip'; stage: 'decided' | 'filled' | 'both'; from: Trade; to: Trade }
  /** The buy rule held with the position already open; `short-held`, the short rule with a short already open. */
  | { k: 'long' }
  | { k: 'short-held' }
  /**
   * The buy rule (or with `side`, the short rule) held after a stop or target exit or a margin call, and had to stop
   * holding before it could enter again.
   */
  | { k: 'rearm'; trade: Trade; side?: 'short' }
  /** The buy rule (or the short rule) held but a sizing or stop input was still unknown. */
  | { k: 'warmup'; input: WarmupInput; n: number; side?: 'short' }
  /** The buy rule and the sell rule both held at this close; `cover-first`, the short rule and the cover rule. */
  | { k: 'sell-first' }
  | { k: 'cover-first' }
  /** The buy and short rules both held while flat, so neither side opened. */
  | { k: 'conflict' }
  /** An entry rule held after the run was ruined, when nothing more is traded. */
  | { k: 'ruined' }
  /** An order from this last bar of the run, not filled. */
  | { k: 'pending'; side: NonNullable<AssetState['pending']> }
  /** `entry`: which entry of the position this is (2 for the first add). `stage` as for a buy. */
  | { k: 'add'; stage: 'decided' | 'filled' | 'both'; trade: Trade; entry: number }
  /** The add rule held with the position already built in all its entries. */
  | { k: 'whole' }
  /** The add rule held with room for another entry, and none was made. */
  | { k: 'add-undone' }
  /** The buy rule (or the short rule) held and nothing stood in the way, but no buy (or short sale) was made: there was no cash, or no room. */
  | { k: 'no-cash'; side?: 'short' }
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
  /** The sell rule as the run reads it, with the position when a long is held; null when there is none. */
  sell: Outcome | null;
  /** The short rule, and the cover rule with the position when a short is held; null (or absent) when there is none. */
  short?: Outcome | null;
  cover?: Outcome | null;
  /** A position held at the end of this bar, after its fills, and its side; absent for a long-only row made by hand. */
  held: boolean;
  side?: 'long' | 'short' | null;
  /** The rules had a position to read at this close, and its side. */
  readHeld: boolean;
  readSide?: 'long' | 'short' | null;
  /** The shares bought, all entries together; rebalancing may have changed them since (`resized`). NaN when flat. */
  shares: number;
  resized: boolean;
  /** The entries the position has at the end of this bar, 0 when flat, and how many it may have. */
  entries: number;
  entriesAllowed: number;
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

const SHORT = 22;
/** The decimals of an unknown value in the table: see places. */
const UNKNOWN_PLACES = 2;

// ---------------------------------------------------------------- small helpers

/** The first bar at or after `at`, or t.length. */
function barFrom(t: number[], at: number): number {
  return barAt(t, at - 1) + 1;
}

const isLevelExit = (t: Trade) => t.reason === 'stop loss' || t.reason === 'trailing stop' || t.reason === 'take profit';
const sideOf = (t: Trade): 'long' | 'short' => t.side ?? 'long';
const ENTRY_KINDS = new Set<DebugEvent['k']>(['buy', 'short']);
const MOVES = new Set<DebugEvent['k']>(['buy', 'sell', 'short', 'cover', 'flip']);
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
  /** Each entry after the first, by the time it filled and by the time of the bar its add rule was read at. */
  addFills: Map<number, AddAt>;
  addSignals: Map<number, AddAt>;
  state: AssetState | undefined;
}

/** An entry after the first: its trade and its place in `trade.entries`. */
interface AddAt {
  trade: Trade;
  k: number;
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

const CAPTIONS = { buy: 'Buy', sell: 'Sell', short: 'Short', cover: 'Cover', add: 'Add' } as const;

/** The parts of one rule, in the order the trade explanation lists them, then the whole rule. */
function ruleColumns(group: keyof typeof CAPTIONS, e: Expr, w: Written, params: { name: string; percent: boolean }[]): { cols: PlanCol[]; chain: number[] } {
  const texts = new Map<Expr, string>();
  let k = 0;
  walk(e, (x) => texts.set(x, w.parts[k++] ?? ''));
  const text = (x: Expr) => texts.get(x) || '';
  const percentText = (s: string) => s.trim().endsWith('%') || params.some((p) => p.percent && p.name.toLowerCase() === s.trim().toLowerCase());
  const caption = CAPTIONS[group];

  const order: { x: Expr; depth: number }[] = [];
  const visit = (x: Expr, depth: number) => {
    order.push({ x, depth });
    if (x.k === 'logic') {
      const parts: Expr[] = [];
      // A definition's name, or a `between`, is one part, not opened into the chain it sits in.
      const flat = (y: Expr, top = false): void => {
        if (y.k === 'logic' && y.op === x.op && (top || !isOneThing(y, text))) {
          flat(y.a);
          flat(y.b);
        } else parts.push(y);
      };
      flat(x, true);
      for (const p of parts) visit(p, depth + 1);
    } else if (x.k === 'not') visit(x.a, depth + 1);
  };
  visit(e, 0);

  const make = (x: Expr, depth: number, whole: boolean, n: number): PlanCol => {
    const label = whole ? w.text : text(x) || `part ${n}`;
    const cmp = x.k === 'cmp' ? x : null;
    const cross = cmp !== null && (cmp.op === 'xup' || cmp.op === 'xdn' || cmp.op === 'xany');
    const kind: DebugColumn['kind'] = cmp ? (cross ? 'cross' : 'test') : x.k === 'logic' || x.k === 'not' ? 'join' : 'flag';
    const op = cmp ? (cmp.op === 'xup' ? 'crosses above' : cmp.op === 'xdn' ? 'crosses below' : cmp.op === 'xany' ? 'crosses' : OPS[cmp.op]) : '';
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
  short: number[] | null;
  cover: BarRule | null;
  add: BarRule | null;
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
    this.intraday = isIntraday(bt.run.t);
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
    const addFills = new Map<number, AddAt>();
    const addSignals = new Map<number, AddAt>();
    for (const trade of trades) {
      trade.entries?.forEach((e, k) => {
        if (k === 0) return;
        addFills.set(e.t, { trade, k });
        addSignals.set(e.signalT, { trade, k });
      });
    }
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
      addFills,
      addSignals,
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
        short: rules.short ? this.ev.eval(rules.short, name) : null,
        cover: rules.cover ? this.ev.compile(rules.cover, name) : null,
        add: rules.add ? this.ev.compile(rules.add, name) : null,
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
    if (rules.short && written?.short) cols.push(...ruleColumns('short', rules.short, written.short, spec.params).cols);
    if (rules.cover && written?.cover) cols.push(...ruleColumns('cover', rules.cover, written.cover, spec.params).cols);
    if (rules.add && written?.add) cols.push(...ruleColumns('add', rules.add, written.add, spec.params).cols);
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

  private firstEvents = new WeakMap<Expr, Map<string, number>>();

  /**
   * The first bar where a condition holds or is unknown, or the number of bars when neither ever happens. Before it a
   * `bars_since` of the condition has had nothing to count from.
   */
  firstEvent(cond: Expr, asset: string): number {
    let byAsset = this.firstEvents.get(cond);
    if (!byAsset) this.firstEvents.set(cond, (byAsset = new Map()));
    let first = byAsset.get(asset);
    if (first === undefined) {
      const v = this.ev.eval(cond, asset);
      first = v.findIndex((x) => x === 1 || Number.isNaN(x));
      if (first < 0) first = v.length;
      byAsset.set(asset, first);
    }
    return first;
  }

  private calls: { t: number; trade: Trade }[] | null = null;

  /** The run's margin calls, in order: the close each was made at, and a trade it closed. Each disarms every side of every ticker there. */
  marginCalls(): { t: number; trade: Trade }[] {
    if (!this.calls) {
      const seen = new Map<number, Trade>();
      for (const trade of this.bt.run.trades) if (trade.why?.exit?.k === 'margin' && !seen.has(trade.why.exit.t)) seen.set(trade.why.exit.t, trade);
      this.calls = [...seen].sort((a, b) => a[0] - b[0]).map(([t, trade]) => ({ t, trade }));
    }
    return this.calls;
  }

  /** Whether the run held buy signals back for this ticker while an input warmed up. */
  everHeldBack(name: string): boolean {
    return this.bt.run.skipped.some((s) => s.asset === name);
  }

  /**
   * The first input a buy needs that is unknown at bar `bar`: the check the engine makes before it buys (engine.ts
   * missingInputAt), made here again to say where the signals it counted in `run.skipped` were.
   */
  missingInput(ix: AssetIx, bar: number): { input: WarmupInput; n: number } | null {
    return missingInputAt(this.bt.spec.sizing, this.bt.spec.stops[ix.name], (n) => this.atr(ix, n)[bar], (n) => this.vol(ix, n)[bar]);
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
      const sells = sig.sell !== null && sig.sell(j, holding ? posOf(ix, holding, t, this.atClose) : null) === 1;
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

/** Lets go of what the table worked out over the whole run for this result: one array of the run's length for each part of the rules. */
export function forgetDebug(bt: Backtest): void {
  contexts.delete(bt);
}

/** How many views are open on each result. A result is shared by every block that shows it, so one view closing must not take what the others read. */
const views = new WeakMap<Backtest, number>();

/**
 * Registers a view of this result's rule values. The returned function closes it; what was worked out for the result is
 * let go when the last view closes. Closing a view again does nothing.
 */
export function holdDebug(bt: Backtest): () => void {
  views.set(bt, (views.get(bt) ?? 0) + 1);
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    const left = (views.get(bt) ?? 1) - 1;
    if (left > 0) views.set(bt, left);
    else {
      views.delete(bt);
      forgetDebug(bt);
    }
  };
}

/** Whether the rule values of this result are held, as they are once a table has worked them out and until its last view closes. */
export function debugWorkedOut(bt: Backtest): boolean {
  return contexts.has(bt);
}

/** How far a job done in steps has got. */
export interface Progress {
  done: number;
  total: number;
}

/** Every expression the rows of `asset` evaluate over the whole series, an expression after the ones inside it, with the ticker it is read on. */
function wholeSeriesParts(cx: Ctx, asset: string): [Expr, string][] {
  const out: [Expr, string][] = [];
  const visit = (e: Expr, name: string): void => {
    for (const c of children(e)) visit(c, e.k === 'of' ? e.asset : name);
    // A part that reads the position is worked out a bar at a time; the parts inside it are what is worked out once.
    if (!findPos(e)) out.push([e, name]);
  };
  const { spec } = cx.bt;
  for (const name of spec.rank ? spec.universe.map((a) => a.name) : [asset]) {
    const r = spec.rules[name];
    for (const e of [r.buy, r.sell, r.short, r.cover, r.add, spec.rank?.by]) if (e) visit(e, name);
  }
  return out;
}

/**
 * Works out, one part of the rules at a time, the values over the whole run that the rows of `asset` read, so that a
 * caller can let other work in between (see inSlices). Rows built afterwards find them worked out. The cost is the same
 * as building the rows without it: about 15 ns for each part on each bar, which a long run makes noticeable.
 */
export function* prepareRows(bt: Backtest, asset: string): Generator<Progress, void> {
  const cx = ctxOf(bt);
  const ix = cx.asset(asset);
  const parts = wholeSeriesParts(cx, asset);
  const inputs: (() => void)[] = [];
  const { sizing, stops } = bt.spec;
  if (cx.everHeldBack(asset)) {
    if (sizing.k === 'risk') inputs.push(() => cx.atr(ix, sizing.n));
    if (sizing.k === 'invvol') inputs.push(() => cx.vol(ix, sizing.n));
    for (const level of [stops[asset]?.stopLoss, stops[asset]?.trailingStop, stops[asset]?.takeProfit]) if (level?.k === 'atr') inputs.push(() => cx.atr(ix, level.n));
  }
  const total = parts.length + inputs.length;
  let done = 0;
  for (const [e, name] of parts) {
    cx.ev.eval(e, name);
    yield { done: ++done, total };
  }
  for (const work of inputs) {
    work();
    yield { done: ++done, total };
  }
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

/** How many of a trade's entries had filled by time `t`. A trade made in one go has one. */
function entriesBy(tr: Trade, t: number): number {
  if (!tr.entries) return 1;
  let n = 0;
  while (n < tr.entries.length && tr.entries[n].t <= t) n++;
  return n;
}

/**
 * What the rules read of the position at the close of `t`: its first entry's bar, its average and latest entry prices and
 * the entries made by then. The average and the latest are what the trade's records say they were at that bar, not the
 * final ones. With fill: close the rules are read before the close's own orders fill.
 */
function posOf(ix: AssetIx, tr: Trade, t: number, atClose: boolean): PosState {
  const entryIdx = barAt(ix.bars.t, tr.entryT);
  const side: Pick<PosState, 'short' | 'atClose'> = { ...(sideOf(tr) === 'short' ? { short: true as const } : {}), ...(atClose ? { atClose: true as const } : {}) };
  if (!tr.entries) return { entryIdx, entryPrice: tr.entryPrice, ...side };
  const n = Math.max(1, entriesBy(tr, atClose ? t - 1 : t));
  const entries = tr.entries.slice(0, n);
  const average = n === 1 ? entries[0].price : tr.why?.adds?.[n - 2]?.average ?? entries.reduce((s, e) => s + e.money, 0) / entries.reduce((s, e) => s + e.shares, 0);
  return { entryIdx, entryPrice: average, lastPrice: entries[n - 1].price, entries: n, ...side };
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
  const allowed = spec.entries ?? 1;

  // After a stop or target exit a side's entry rule has to stop holding before it can enter again (rule 29), and after a
  // margin call both sides' rules; not with `hold`.
  const calls = cx.marginCalls();
  let call = 0;
  let stopped: Trade | null = null;
  let stoppedShort: Trade | null = null;
  if (!spec.rank) {
    const t0 = ix.bars.t[ix.first + lo];
    while (call < calls.length && calls[call].t < t0) call++;
    const before = calls.slice(0, call);
    stopped = disarmedBefore(ix, t0, 'long', sig.buy, before, lo);
    if (sig.short) stoppedShort = disarmedBefore(ix, t0, 'short', sig.short, before, lo);
  }

  for (let k = lo; k < hi; k++) {
    const b = ix.first + k;
    const t = ix.bars.t[b];
    const after = openAfter(ix, t);
    const reading = openAtRead(ix, t, cx.atClose);
    const pos = reading ? posOf(ix, reading, t, cx.atClose) : null;
    const readSide = reading ? sideOf(reading) : null;
    // The add rule is read only while a position has room for another entry, and each exit rule only with its own side held.
    const room = pos !== null && (pos.entries ?? 1) < allowed;
    const posFor = (group: DebugColumn['group']) => (group === 'sell' ? (readSide === 'long' ? pos : null) : group === 'cover' ? (readSide === 'short' ? pos : null) : pos);

    const cells = readers.map((r): DebugCell => {
      // A part that compares a position value has nothing to compare while no position is held. Joins are still worked out
      // the way the engine does, with the position unknown, since a buy is skipped when the sell rule holds without it.
      if (r.col.group === 'add' && !room) return na();
      const p = posFor(r.col.group);
      if (r.out === null || (r.readsPos && !p && (r.col.kind === 'test' || r.col.kind === 'cross'))) return na();
      const o = outcome(r.out(b, p));
      const cell: DebugCell = { outcome: o, a: NaN, b: NaN, pa: NaN, pb: NaN, note: '' };
      if (r.a && r.b) {
        cell.a = r.a(b, p);
        cell.b = r.b(b, p);
        if (r.col.kind === 'cross' && b > 0) {
          cell.pa = r.a(b - 1, p);
          cell.pb = r.b(b - 1, p);
        }
      }
      if (o === 'unknown') cell.note = whyUnknown(cx, r.expr!, asset, b, p);
      return cell;
    });

    const buy = outcome(sig.buy[b]);
    const sell = sig.sell ? outcome(sig.sell(b, posFor('sell'))) : null;
    const short = sig.short ? outcome(sig.short[b]) : null;
    const cover = sig.cover ? outcome(sig.cover(b, posFor('cover'))) : null;
    const chain = plan.chain.map((n) => cells[n].outcome ?? 'unknown');

    const bought = ix.byBuy.get(t);
    const sold = ix.bySell.get(t);
    const entered = ix.byEntry.get(t);
    const exited = ix.byExit.get(t);
    if (!spec.rank) {
      // A margin call made at a close before this bar disarmed both sides.
      while (call < calls.length && calls[call].t < t) stopped = stoppedShort = calls[call++].trade;
      if (exited && isLevelExit(exited)) {
        if (sideOf(exited) === 'short') stoppedShort = exited;
        else stopped = exited;
      }
      if (readSide === 'long') stopped = null;
      else if (stopped && buy !== 'yes') stopped = null;
      if (readSide === 'short') stoppedShort = null;
      else if (stoppedShort && short !== 'yes') stoppedShort = null;
    }

    // In the order they happened within the bar: orders from the last close fill at the open, a stop or target is reached
    // inside the bar, and the close reads the rules and decides, or with fill: close decides and fills. At one moment an
    // exit comes before an entry, as orders fill.
    const entryKind = (tr: Trade): 'buy' | 'short' => (sideOf(tr) === 'short' ? 'short' : 'buy');
    const exitKind = (tr: Trade): 'sell' | 'cover' => (sideOf(tr) === 'short' ? 'cover' : 'sell');
    const timed: { at: 'open' | 'inside' | 'close'; event: DebugEvent }[] = [];
    if (entered) timed.push({ at: bought === entered ? 'close' : 'open', event: { k: entryKind(entered), stage: bought === entered ? 'both' : 'filled', trade: entered } });
    if (exited) timed.push({ at: sold === exited ? 'close' : isLevelExit(exited) ? 'inside' : 'open', event: { k: exitKind(exited), stage: sold === exited ? 'both' : 'filled', trade: exited } });
    if (bought && bought !== entered) timed.push({ at: 'close', event: { k: entryKind(bought), stage: 'decided', trade: bought } });
    if (sold && sold !== exited) timed.push({ at: 'close', event: { k: exitKind(sold), stage: 'decided', trade: sold } });
    const addFill = ix.addFills.get(t);
    const addSignal = ix.addSignals.get(t);
    const addMade = (a: AddAt) => ({ trade: a.trade, entry: a.k + 1 });
    if (addFill) {
      const both = addFill.trade.entries![addFill.k].signalT === t;
      timed.push({ at: both ? 'close' : 'open', event: { k: 'add', stage: both ? 'both' : 'filled', ...addMade(addFill) } });
    }
    if (addSignal && (addSignal.trade !== addFill?.trade || addSignal.k !== addFill.k)) timed.push({ at: 'close', event: { k: 'add', stage: 'decided', ...addMade(addSignal) } });
    const moment = { open: 0, inside: 1, close: 2 };
    const entryLast = (e: DebugEvent) => Number(ENTRY_KINDS.has(e.k));
    const events = flips(
      timed.sort((x, y) => moment[x.at] - moment[y.at] || entryLast(x.event) - entryLast(y.event)).map((x) => x.event),
      bt.run.trades,
    );

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
    const ruin = bt.run.ruin;
    if (ruin && t >= ruin.t) {
      // The ruin's own bar says it in its exit; nothing is traded after it.
      if (t > ruin.t && (buy === 'yes' || short === 'yes')) events.push({ k: 'ruined' });
    } else if (!spec.rank) {
      // A bar that bought or sold already says more than that the rule holds with a position open.
      const moved = events.some((e) => MOVES.has(e.k));
      const decided = (side: 'long' | 'short') => !!bought && sideOf(bought) === side;
      if (buy === 'yes' && readSide === 'long') {
        if (pending !== 'sell' && pending !== 'short' && !moved) events.push({ k: 'long' });
      } else if (short === 'yes' && readSide === 'short') {
        if (pending !== 'cover' && pending !== 'buy' && !moved) events.push({ k: 'short-held' });
      } else if (!reading && buy === 'yes' && sell !== 'yes' && short === 'yes' && cover !== 'yes') {
        events.push({ k: 'conflict' });
      } else if (!reading) {
        const missing = checkInputs && (buy === 'yes' || short === 'yes') ? cx.missingInput(ix, b) : null;
        if (buy === 'yes' && !decided('long')) {
          if (sell === 'yes') events.push({ k: 'sell-first' });
          else if (stopped) events.push({ k: 'rearm', trade: stopped });
          else if (missing) events.push({ k: 'warmup', ...missing });
          else if (pending !== 'buy') events.push({ k: 'no-cash' });
        }
        if (short === 'yes' && !decided('short')) {
          if (cover === 'yes') events.push({ k: 'cover-first' });
          else if (stoppedShort) events.push({ k: 'rearm', trade: stoppedShort, side: 'short' });
          else if (missing) events.push({ k: 'warmup', ...missing, side: 'short' });
          else if (pending !== 'short') events.push({ k: 'no-cash', side: 'short' });
        }
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
    // The rules that close the position held, or the orders that do, leave no add to speak of.
    const exits = readSide === 'short' ? cover === 'yes' || buy === 'yes' || pending === 'cover' || pending === 'buy' : sell === 'yes' || short === 'yes' || pending === 'sell' || pending === 'short';
    if (reading && pos && sig.add && !sold && !exits) {
      const addHeld = sig.add(b, pos) === 1;
      const moved = events.some((e) => MOVES.has(e.k) || e.k === 'add');
      if (addHeld && !moved && !room) events.push({ k: 'whole' });
      else if (addHeld && !addSignal && pending !== 'add' && room) events.push({ k: 'add-undone' });
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
      short,
      cover,
      held: after !== null,
      side: after ? sideOf(after) : null,
      readHeld: reading !== null,
      readSide,
      shares: after?.entries ? after.entries.slice(0, entriesBy(after, t)).reduce((n, e) => n + e.shares, 0) : after?.why?.shares ?? NaN,
      resized: !!after?.why && after.why.topUps + after.why.trims > 0,
      entries: after ? entriesBy(after, t) : 0,
      entriesAllowed: allowed,
      rank,
      events,
      what: '',
    };
    row.what = words(cx, ix, row);
    rows.push(row);
  }
  return rows;
}

/**
 * The trade whose exit disarmed a side before the time `t0` when its entry rule has held at every close since, so it is
 * still waiting to stop holding: the side's last trade, closed by a stop or target, or a margin call (`calls`, those made
 * before `t0`) after it. Null when the side is armed.
 */
function disarmedBefore(ix: AssetIx, t0: number, side: 'long' | 'short', rule: number[], calls: { t: number; trade: Trade }[], lo: number): Trade | null {
  let p = ix.trades.length - 1;
  while (p >= 0 && !(sideOf(ix.trades[p]) === side && ix.trades[p].reason !== 'open' && ix.trades[p].exitT < t0)) p--;
  let by: Trade | null = p >= 0 && isLevelExit(ix.trades[p]) ? ix.trades[p] : null;
  // A stop exit's own close reads the rule again; a margin call is made after its close was read. The later one counts:
  // a side entered again since had stopped holding first, which the walk below finds.
  let from = by ? barAt(ix.bars.t, by.exitT) : -1;
  const last = calls.at(-1);
  if (last && (!by || last.t >= by.exitT)) {
    by = last.trade;
    from = barAt(ix.bars.t, last.t) + 1;
  }
  if (!by) return null;
  for (let j = from; j < ix.first + lo; j++) if (rule[j] !== 1) return null;
  return by;
}

/** An exit by the other side's entry rule that opened that side at the same fill, and that entry, as one flip. */
function flips(events: DebugEvent[], trades: Trade[]): DebugEvent[] {
  const out: DebugEvent[] = [];
  const joined = new Set<Trade>();
  for (const e of events) {
    if ((e.k === 'sell' || e.k === 'cover') && flipped(e.trade, trades)) {
      const exit = e.trade;
      const to = events.find((x): x is Extract<DebugEvent, { k: 'buy' | 'short' }> => (x.k === 'buy' || x.k === 'short') && x.stage === e.stage && x.trade.entryT === exit.exitT);
      if (to) {
        out.push({ k: 'flip', stage: e.stage, from: exit, to: to.trade });
        joined.add(to.trade);
        continue;
      }
    }
    if ((e.k === 'buy' || e.k === 'short') && joined.has(e.trade)) continue;
    out.push(e);
  }
  return out;
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
    if (x.k === 'column') return 'the file has no number in that row';
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
    if (x.k === 'ind') return whyIndicator(cx, x, a, j);
    if (x.k === 'bin' && x.op === '/') return 'divides by 0';
    if (x.k === 'cmp' && (x.op === 'xup' || x.op === 'xdn' || x.op === 'xany')) return 'the bar before is unknown';
    return '';
  };
  return visit(e, asset, i);
}

/**
 * Why an indicator is unknown at bar `j` although what it reads is known, when that can be told from its inputs. A window
 * with one value all through has no spread to measure, which is not the same as a window not yet full. Nothing is said of a
 * `bars_since` that was reset by an unknown bar, where no cheap reason fits.
 */
function whyIndicator(cx: Ctx, x: Extract<Expr, { k: 'ind' }>, asset: string, j: number): string {
  const warming = 'still warming up';
  if (x.src && findPos(x.src)) return x.fn === 'bars_since' ? '' : warming;
  if (x.fn === 'bars_since') return j < cx.firstEvent(x.src!, asset) ? 'the condition has not held yet' : '';
  const n = x.args[0];
  if (x.fn === 'count') return j - n + 1 < 0 ? `fewer than ${n} bars so far` : 'the condition was unknown on one of the bars';
  const window = (series: number[], length: number): number[] | null => {
    const w = j - length + 1 < 0 ? null : series.slice(j - length + 1, j + 1);
    return w && !w.some(Number.isNaN) ? w : null;
  };
  const same = (w: number[] | null) => w !== null && w.every((v) => v === w[0]);
  if (x.fn === 'zscore') {
    const series = x.src ? cx.ev.eval(x.src, asset) : cx.bt.data.get(asset)?.c;
    return series && same(window(series, n)) ? 'every value in the window is the same' : warming;
  }
  if (x.fn === 'correl' && x.src) {
    const both = [cx.bt.data.get(asset)?.c, cx.ev.eval(x.src, asset)];
    // Each series' changes over the n bars, as correl reads them, which is one more price than bars.
    const changes = both.map((series) => {
      const w = series ? window(series, n + 1) : null;
      return w ? ind.returns(w).slice(1) : null;
    });
    return changes.some(same) ? 'one of the two series changed by the same amount on every bar in the window' : warming;
  }
  return warming;
}

// ---------------------------------------------------------------- what happened, in words

/** "2nd of 5". */
const placeWords = (place: number, eligible: number) => `${ungroupedOrdinal(place + 1)} of ${eligible}`;

function words(cx: Ctx, ix: AssetIx, row: DebugRow): string {
  const when = (t: number) => stamp(t, cx.intraday);
  const ranked = cx.bt.spec.rank !== null;
  /** Where an order that was decided at this bar fills: at this close, or at a later bar, at its open unless the block fills at the close. */
  const fillWords = (fillT: number, at: number, atOpen = !cx.atClose) => {
    if (fillT === row.t) return `at this close at ${price(at)}`;
    if (!atOpen) return `at the close of ${when(fillT)} at ${price(at)}`;
    return `at ${fillT === ix.bars.t[row.bar + 1] ? 'the next open' : 'the open'} (${when(fillT)}) at ${price(at)}`;
  };
  const atFill = cx.atClose ? 'the close' : 'the open';
  const marginCall = `Margin call (equity below ${Number(((cx.bt.spec.margin?.maintenance ?? 0) * 100).toFixed(1))}% of the positions' value)`;
  /** What closed a position whose exit was decided at this bar. */
  const closedBy = (tr: Trade): string => {
    const exit = tr.why?.exit;
    const short = sideOf(tr) === 'short';
    if (exit?.k === 'rank') return 'The ranking no longer holds it';
    if (exit?.k === 'margin') return marginCall;
    if (exit?.k === 'rule' && exit.flip) return short ? 'Buy rule held' : 'Short rule held';
    return short ? 'Cover rule held' : 'Sell rule held';
  };
  const out: string[] = [];
  for (const e of row.events) {
    switch (e.k) {
      case 'buy':
      case 'short': {
        const tr = e.trade;
        const [did, rule] = e.k === 'short' ? ['sold short', 'Short rule held'] : ['bought', 'Buy rule held'];
        // With entries, the trade's entry price is the average of them all; the first entry filled at its own.
        const first = tr.entries?.[0].price ?? tr.entryPrice;
        const entry = tr.entries ? ` entry 1 of ${row.entriesAllowed}` : '';
        if (e.stage === 'filled') {
          out.push(`${did.replace(/^./, (c) => c.toUpperCase())}${entry} at ${atFill} at ${price(first)}.`);
        } else {
          const rank = tr.why?.rank;
          const why = rank ? `Chosen by the ranking, ${placeWords(rank.place, rank.decision.eligible)}` : rule;
          out.push(`${why}: ${did}${entry} ${fillWords(tr.entryT, first)}.`);
        }
        break;
      }
      case 'sell':
      case 'cover': {
        const tr = e.trade;
        const did = e.k === 'cover' ? 'bought to cover' : 'sold';
        const at = price(tr.exitPrice);
        if (tr.why?.exit?.k === 'ruin') out.push(`Equity fell to zero, so every position was closed and the run stopped: ${did} at ${at}.`);
        else if (e.stage === 'filled') {
          if (tr.reason === 'stop loss') out.push(`Stopped out at ${at}.`);
          else if (tr.reason === 'trailing stop') out.push(`Trailing stop hit: ${did} at ${at}.`);
          else if (tr.reason === 'take profit') out.push(`Take profit hit: ${did} at ${at}.`);
          else if (tr.reason === 'margin call') out.push(`Margin call: ${did} at the open at ${at}.`);
          else out.push(`${did.replace(/^./, (c) => c.toUpperCase())} at ${atFill} at ${at}.`);
        } else {
          // A margin call closes at the next open whatever the block's fill.
          out.push(`${closedBy(tr)}: ${did} ${fillWords(tr.exitT, tr.exitPrice, tr.reason === 'margin call' || !cx.atClose)}.`);
        }
        break;
      }
      case 'flip': {
        const to = e.to;
        const short = sideOf(to) === 'short';
        const both = short ? 'sold and sold short' : 'bought to cover and bought';
        const first = to.entries?.[0].price ?? to.entryPrice;
        if (e.stage === 'filled') out.push(`Flipped to ${short ? 'short' : 'long'}: ${both} at ${atFill} at ${price(first)}.`);
        else out.push(`${short ? 'Short' : 'Buy'} rule held: flipped to ${short ? 'short' : 'long'}, ${both} ${fillWords(to.entryT, first)}.`);
        break;
      }
      case 'add': {
        const en = e.trade.entries![e.entry - 1];
        const entry = `entry ${e.entry} of ${row.entriesAllowed}`;
        const moved = e.stage === 'decided' ? '' : movedWords(e.trade, e.entry);
        if (e.stage === 'filled') out.push(`Added ${entry} at ${cx.atClose ? 'the close' : 'the open'} at ${price(en.price)}.${moved}`);
        else out.push(`Add rule held: added ${entry} ${fillWords(en.t, en.price)}.${moved}`);
        break;
      }
      case 'whole':
        out.push('Add rule held but the position was already whole.');
        break;
      case 'add-undone': {
        // The run records no add that was left undone, so every reason that fits is named; the commission only when the run left some adds or trades undone for it.
        const small = cx.bt.run.smallTrades ? `, or its commission would be ${SMALL_TRADE * 100}% or more of it` : '';
        out.push(`Add rule held, but no entry was made: no cash was free, or the position was already as large as its weight allows${small}.`);
        break;
      }
      case 'long':
        out.push('Buy rule held but already long.');
        break;
      case 'short-held':
        out.push('Short rule held but already short.');
        break;
      case 'rearm':
        out.push(
          `${e.side === 'short' ? 'Short' : 'Buy'} rule held but waiting for the rule to stop holding after ${e.trade.exitT === row.t ? 'this' : 'the'} ${e.trade.reason}${e.trade.exitT === row.t ? '' : ` on ${when(e.trade.exitT)}`}.`,
        );
        break;
      case 'warmup':
        if (e.side === 'short') out.push(`Short rule held, but the short sale waited: ${WARMUP_INPUT[e.input](e.n)} was still unknown.`);
        else out.push(`${ranked ? 'Chosen, but the buy' : 'Buy rule held, but the buy'} waited: ${WARMUP_INPUT[e.input](e.n)} was still unknown.`);
        break;
      case 'sell-first':
        out.push('Buy rule held, but the sell rule held too, so no buy.');
        break;
      case 'cover-first':
        out.push('Short rule held, but the cover rule held too, so no short sale.');
        break;
      case 'conflict':
        out.push('Buy and short rules both held, so neither opened a position.');
        break;
      case 'ruined':
        out.push(`Nothing more was traded after the ruin on ${when(cx.bt.run.ruin!.t)}.`);
        break;
      case 'pending': {
        // An order for the other side closes the position held first: a flip, said as its two orders.
        const held = ix.state?.side ?? null;
        const order = { buy: held === 'short' ? 'buy to cover and buy' : 'buy', sell: 'sell', add: 'add', short: held === 'long' ? 'sell and sell short' : 'sell short', cover: 'buy to cover' }[e.side];
        // A margin call made at this close closes the position at the next open, whatever the block's fill.
        if (ix.state?.marginCall) out.push(`${marginCall}: order pending to ${order} at the next open.`);
        else out.push(`Order pending: ${order} at the next ${cx.atClose ? 'close' : 'open'}.`);
        break;
      }
      case 'no-cash':
        if (e.side === 'short') out.push('Short rule held, but no short sale was made: there was no room left for it.');
        else out.push('Buy rule held, but no buy was made: no cash was free.');
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

/** What an add moved: the average entry price, and the stop loss and take profit that follow it. Starts with a space; empty when the trade does not say. */
function movedWords(trade: Trade, entry: number): string {
  const add = trade.why?.adds?.[entry - 2];
  if (!add) return '';
  const parts = [`average entry price now ${price(add.average)}`];
  if (add.stopLoss !== null) parts.push(`stop loss moved to ${price(add.stopLoss)}`);
  if (add.takeProfit !== null) parts.push(`take profit moved to ${price(add.takeProfit)}`);
  return ` ${parts.join('; ').replace(/^./, (c) => c.toUpperCase())}.`;
}

/** "Flat", or "Long" or "Short" with the entries made, when a position is built in several, and the shares that were bought or sold short. */
export function positionWords(row: DebugRow): string {
  if (!row.held) return 'Flat';
  const short = row.side === 'short';
  const side = short ? 'Short' : 'Long';
  const long = row.entriesAllowed > 1 ? `${side}, ${row.entries} of ${row.entriesAllowed} entries` : side;
  if (Number.isNaN(row.shares)) return long;
  if (!row.resized) return `${long}, ${shareCount(row.shares)} shares`;
  return short ? `${long}, sold ${shareCount(row.shares)} shares short` : `${long}, bought ${shareCount(row.shares)} shares`;
}

/** The text of one cell: the values compared and, for a cross or an unknown, a second line. */
export function cellText(col: DebugColumn, cell: DebugCell): { main: string; detail: string } {
  if (col.kind === 'score') return { main: fixed(cell.a, places(cell.a, UNKNOWN_PLACES)), detail: '' };
  if (col.kind === 'place') return { main: Number.isNaN(cell.a) ? '–' : cell.a < 0 ? 'not eligible' : `${ungroupedOrdinal(cell.a + 1)} of ${cell.b}`, detail: '' };
  if (cell.outcome === null) return { main: '–', detail: '' };
  const note = cell.outcome === 'unknown' ? cell.note : '';
  if (col.kind === 'test') {
    const [a, b] = pair(cell.a, cell.b, col.percent, UNKNOWN_PLACES);
    return { main: `${a} ${col.op} ${b}`, detail: note };
  }
  if (col.kind === 'cross') {
    const [a, b] = pair(cell.a, cell.b, col.percent, UNKNOWN_PLACES);
    const [pa, pb] = pair(cell.pa, cell.pb, col.percent, UNKNOWN_PLACES);
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
  return row.events.length > 0 || row.held || row.buy === 'yes' || row.short === 'yes' || nearMiss(row);
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

/** Bars of the file made between one step and the next. */
const CSV_BARS = 500;
/** A file bigger than this is asked about before it is made: the whole run, or only the bars on screen. */
export const CSV_ASK_BYTES = 20_000_000;
/** A file bigger than this is not made whole at all: it is one string, which the engine limits to about 536 million characters, and an estimate can be a little low. */
export const CSV_MAX_BYTES = 400_000_000;
/** Bars read to work out how long a row of the file is. */
const CSV_SAMPLE = 200;

/** What a file's rows and heading are made of, for one ticker. */
function csvLayout(bt: Backtest, asset: string) {
  const cx = ctxOf(bt);
  const cols = debugColumns(bt, asset);
  const entries = (bt.spec.entries ?? 1) > 1;
  const header = csvLine([cx.intraday ? 'time (UTC)' : 'date', 'close', ...cols.flatMap(csvHeads), 'position', 'shares', ...(entries ? ['entries'] : []), 'what happened']);
  const row = (r: DebugRow) => csvLine([stamp(r.t, cx.intraday), num(r.close), ...cols.flatMap((c, n) => csvFields(c, r.cells[n])), r.held ? (r.side ?? 'long') : 'flat', num(r.shares), ...(entries ? [r.entries] : []), r.what]);
  return { count: cx.asset(asset).count, header, row };
}

/**
 * Makes the file in steps of a few hundred bars, so a caller can let other work in between (see inSlices), and returns
 * it at the end: the bars of the ticker in the run, all of them or those from `range.from` up to but not including
 * `range.to`, with the columns of the table, values as plain numbers and outcomes as yes, no or unknown.
 */
export function* csvSteps(bt: Backtest, asset: string, range?: { from: number; to: number }): Generator<Progress, string> {
  const { count, header, row } = csvLayout(bt, asset);
  const first = Math.max(0, Math.min(count, range?.from ?? 0));
  const last = Math.max(first, Math.min(count, range?.to ?? count));
  const parts = [header];
  for (let from = first; from < last; from += CSV_BARS) {
    const to = Math.min(last, from + CSV_BARS);
    let text = '';
    for (const r of debugRows(bt, asset, from, to)) text += row(r);
    parts.push(text);
    yield { done: to - first, total: last - first };
  }
  return parts.join('');
}

/**
 * How big the file of the whole run will be, worked out from a sample of its rows in the middle of the run: exact for a run
 * of a few hundred bars, and within a few per cent for a longer one. Sizes are in characters, which is bytes for a file that
 * is nearly all numbers.
 */
export function csvSize(bt: Backtest, asset: string): { bars: number; bytes: number } {
  const { count, header, row } = csvLayout(bt, asset);
  const from = count <= CSV_SAMPLE ? 0 : Math.floor((count - CSV_SAMPLE) / 2);
  const sample = debugRows(bt, asset, from, from + CSV_SAMPLE);
  const length = sample.reduce((n, r) => n + row(r).length, 0);
  return { bars: count, bytes: header.length + (sample.length ? Math.round((length / sample.length) * count) : 0) };
}

/**
 * What to ask the reader before making the file of the whole run, or null when it is small enough to just make. `all` is
 * whether the whole run may be offered; `shown` is how many bars the table shows.
 */
export function csvAsk(size: { bars: number; bytes: number }, shown: number): { text: string; all: boolean } | null {
  if (size.bytes <= CSV_ASK_BYTES) return null;
  const about = `about ${Math.round(size.bytes / 1e6).toLocaleString('en-US')} MB (${size.bars.toLocaleString('en-US')} bars)`;
  const bars = `${shown.toLocaleString('en-US')} ${shown === 1 ? 'bar' : 'bars'}`;
  if (size.bytes > CSV_MAX_BYTES) return { text: `The file with every bar would be ${about}, too large to save as one file. Save only the ${bars} shown?`, all: false };
  return { text: `The file with every bar would be ${about}. Save every bar, or only the ${bars} shown?`, all: true };
}

/** The whole file at once. */
export function debugCsv(bt: Backtest, asset: string): string {
  const steps = csvSteps(bt, asset);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/**
 * Runs a job done in steps a few steps at a time, each stretch taking about `budgetMs`, and lets other work in between,
 * so the window never freezes for long. A job that finishes within the first stretch is done at once, with no wait.
 * `onSlice` hears how far it has got after each stretch. Gives null when `stop` says so between stretches.
 */
export async function inSlices<T>(
  steps: Generator<Progress, T>,
  opts: { budgetMs?: number; wait?: () => Promise<void>; now?: () => number; onSlice?: (p: Progress) => void; stop?: () => boolean } = {},
): Promise<T | null> {
  const { budgetMs = 12, wait = () => new Promise<void>((resolve) => setTimeout(resolve, 0)), now = () => performance.now() } = opts;
  for (;;) {
    const start = now();
    let last: Progress | null = null;
    for (;;) {
      const next = steps.next();
      if (next.done) return next.value;
      last = next.value;
      if (now() - start >= budgetMs) break;
    }
    opts.onSlice?.(last);
    await wait();
    if (opts.stop?.()) return null;
  }
}
