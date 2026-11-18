// "Why did this trade happen?": one trade in plain words and the engine's own numbers. Built on
// demand from the record the engine kept as it decided (Trade.why) and the same Evaluator over the
// same prices, so each value shown is the one the run used. Pure data; render-trades.ts draws it.

import { WARMUP_INPUT, type Backtest } from './backtest.ts';
import { findPos, isBool, isOneThing, ownColumns, walk, type CmpOp, type Expr, type StopLevel, type Written } from './dsl.ts';
import { barAt, commissionFee, insideBar, insideKey, type AddWhy, type ExitReason, type ExitWhy, type RankPlace, type Trade, type TradeEntry, type TradeWhy } from './engine.ts';
import { specEvaluator, type Evaluator, type PosState } from './evaluate.ts';
import { DAY, fixed, isIntraday, minus, pair, places, price, shareCount, stamp, ungroupedOrdinal, ungroupedPlural } from './format.ts';
import * as ind from './indicators.ts';
import { flipped } from './price-chart.ts';
import type { Bars } from './types.ts';

export type Outcome = 'yes' | 'no' | 'unknown';

export interface Row {
  /** What the row is about: a rule or a comparison as written, a name, or a whole sentence. */
  label: string;
  /** The numbers behind it; '' when the label says it all. */
  value: string;
  /** For a condition, whether it held; null for a plain statement. */
  outcome: Outcome | null;
  /** 0 for a row of its own; 1 and more for the parts of the condition above it. */
  depth: number;
  /** The label is rule text as the user wrote it. */
  code: boolean;
}

/** The sections of a short are worded as such ("Why it was shorted", "Why it was covered") but keep these ids. */
export interface Section {
  /** `add` is an entry after the first, for a position built in steps; there is one for each. */
  id: 'bought' | 'size' | 'add' | 'sold' | 'result';
  title: string;
  rows: Row[];
}

/** The numbers the words rest on, worked out again from the prices and settings, so they can be checked against the trade. */
export interface Facts {
  /** The bar whose close the buy was read at, and the buy rule there (the short rule, for a short); null when there is no buy rule. */
  buyT: number;
  buyRule: Outcome | null;
  /** The fill: the open (or close) of the fill bar with the slippage, and the shares the money bought there. */
  entryPrice: number;
  shares: number;
  reason: ExitReason;
  /** A rule's exit: the bar it was read at and the outcome there of the rule that closed it (sell, cover, or the other side's entry rule for a flip). */
  sellT: number | null;
  sellRule: Outcome | null;
  /** The stop or target level that was hit, worked out from the fill, the settings and the ATR. */
  level: number | null;
  /** The exit price from the bar and the level or the rule; the last close while still held. */
  exitPrice: number;
  /** Return after costs from those two prices. */
  ret: number;
  /** With `entries` above 1: each entry, the first one first, with the rule read for it (null for the first when there is no buy rule). `entryPrice` is then their average. */
  entries?: { t: number; signalT: number; rule: Outcome | null; price: number; shares: number }[];
}

export interface Explanation {
  asset: string;
  title: string;
  sections: Section[];
  facts: Facts;
}

const evaluators = new WeakMap<Backtest, Evaluator>();

function evaluatorFor(bt: Backtest): Evaluator {
  let ev = evaluators.get(bt);
  if (!ev) evaluators.set(bt, (ev = specEvaluator(bt.spec, bt.data)));
  return ev;
}

export const outcome = (v: number): Outcome => (v === 1 ? 'yes' : v === 0 ? 'no' : 'unknown');
/** The marks that say a part held, did not, or is unknown, in words as well as symbols. */
export const MARK: Record<Outcome, string> = { yes: '✓ yes', no: '✗ no', unknown: '? unknown' };
const row = (label: string, value = '', depth = 0, result: Outcome | null = null, code = false): Row => ({ label, value, outcome: result, depth, code });
/** The decimals of an unknown value here: see places. */
const UNKNOWN_PLACES = 6;

/** Scores with enough decimals that different ones never print the same: each its usual places, plus what it takes. */
function scoreTexts(scores: number[]): string[] {
  const finite = scores.filter(Number.isFinite);
  let extra = 0;
  const key = (x: number) => x.toFixed(Math.min(20, places(x, UNKNOWN_PLACES) + extra));
  while (extra < 10 && finite.some((x, i) => finite.some((y, j) => j < i && x !== y && key(x) === key(y)))) extra++;
  return scores.map((x) => fixed(x, places(x, UNKNOWN_PLACES) + extra));
}

const money = (x: number) => minus(`${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
/** A share, such as a weight or a stop distance, without trailing zeros: 50%, 33.3%. */
const share = (x: number) => `${minus(Number((x * 100).toPrecision(10)).toLocaleString('en-US', { maximumFractionDigits: 2 }))}%`;
/** A return or a rate, always with two decimals: +6.00%. */
const percent = (x: number) => `${x > 0 ? '+' : ''}${minus((x * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}%`;

export const OPS: Record<Exclude<CmpOp, 'xup' | 'xdn' | 'xany'>, string> = { '>': '>', '<': '<', '>=': '≥', '<=': '≤', '==': '=', '!=': '≠' };

/** One trade's explanation, worked out on demand. */
export function explainTrade(bt: Backtest, trade: Trade): Explanation {
  const why = trade.why;
  if (!why) throw new Error(`The trade in ${trade.asset} has no record of how it was decided`);
  return new Explainer(bt, trade, why).build();
}

class Explainer {
  private bt: Backtest;
  private trade: Trade;
  private why: TradeWhy;
  private ev: Evaluator;
  private bars: Bars;
  private intraday: boolean;
  private atClose: boolean;
  private slip: number;
  private cost: number;
  private facts: Facts;
  /** Every entry of a position built in steps; empty otherwise. */
  private entries: TradeEntry[];
  /** A short, whose prices move the other way: 1 for a long, -1 for a short. */
  private short: boolean;
  private s: 1 | -1;
  /** For a short, the parts of its return a share: what it brought in, what covering it cost, and its borrow fees. */
  private shortReturn: { basis: number; cover: number; borrow: number } | null = null;

  constructor(bt: Backtest, trade: Trade, why: TradeWhy) {
    this.bt = bt;
    this.trade = trade;
    this.why = why;
    this.ev = evaluatorFor(bt);
    this.bars = bt.data.get(trade.asset)!;
    this.intraday = isIntraday(bt.run.t);
    this.atClose = bt.spec.fill === 'close';
    this.slip = bt.spec.slippageBps / 10_000;
    this.cost = bt.spec.costBps / 10_000;
    this.facts = { buyT: why.buyT, buyRule: null, entryPrice: NaN, shares: NaN, reason: trade.reason, sellT: null, sellRule: null, level: null, exitPrice: NaN, ret: NaN };
    this.entries = trade.entries ?? [];
    if (trade.entries) this.facts.entries = [];
    this.short = trade.side === 'short';
    this.s = this.short ? -1 : 1;
  }

  build(): Explanation {
    const { trade } = this;
    // In this order: each section fills in the facts the next one uses.
    const n = this.bt.spec.entries ?? 1;
    const [opened, closed] = this.short ? ['shorted', 'covered'] : ['bought', 'sold'];
    const sections: Section[] = [
      { id: 'bought', title: `Why it was ${opened}`, rows: this.bought() },
      { id: 'size', title: n > 1 ? `How much: entry 1 of ${n}` : 'How much', rows: this.size() },
      ...(this.why.adds ?? []).map((add, j): Section => ({ id: 'add', title: `Entry ${j + 2} of ${n}`, rows: this.added(add, j) })),
      { id: 'sold', title: trade.reason === 'open' ? 'Why it is still held' : `Why it was ${closed}`, rows: this.sold() },
      { id: 'result', title: 'Result', rows: this.result() },
    ];
    const sold = trade.reason === 'open' ? 'still held' : `${closed} ${this.date(trade.exitT)} at ${price(trade.exitPrice)}`;
    const bought =
      this.entries.length > 1
        ? `${opened} in ${this.entries.length} entries from ${this.date(trade.entryT)}, at ${price(trade.entryPrice)} on average`
        : `${opened} ${this.date(trade.entryT)} at ${price(trade.entryPrice)}`;
    return { asset: trade.asset, title: `${trade.asset}: ${bought}, ${sold}`, sections, facts: this.facts };
  }

  // ---------------------------------------------------------------- words for times

  private date(t: number): string {
    return stamp(t, this.intraday) + (this.intraday ? ' UTC' : '');
  }
  private closeOf(t: number): string {
    return this.intraday ? `the close of the bar starting ${this.date(t)}` : `the close of ${this.date(t)}`;
  }
  private openOf(t: number): string {
    return this.intraday ? `the open of the bar starting ${this.date(t)}` : `the open of ${this.date(t)}`;
  }

  // ---------------------------------------------------------------- the buy

  private bought(): Row[] {
    const { why, trade, bt } = this;
    const rows: Row[] = [];
    const i = barAt(this.bars.t, why.buyT);
    if (why.rank) {
      const d = why.rank.decision;
      const read = d.t === why.buyT ? '' : `, which read its bar of ${this.date(why.buyT)}`;
      rows.push(row(`Chosen at the ranking made at ${this.closeOf(d.t)}${read}.`));
    } else {
      rows.push(row(`The ${this.entryRule} rule was read at ${this.closeOf(why.buyT)}.`));
    }
    const rules = bt.spec.rules[trade.asset];
    const written = bt.spec.written?.rules[trade.asset]?.[this.entryRule] ?? null;
    const entry = this.short ? rules.short : rules.buy;
    if (written && entry) {
      const rule = this.rule(`${this.entryRule} when`, entry, written, i, null);
      this.facts.buyRule = rule.result;
      this.facts.entries?.push({ t: trade.entryT, signalT: why.buyT, rule: rule.result, price: NaN, shares: NaN });
      rows.push(...rule.rows);
    } else if (why.rank) {
      rows.push(row('There is no buy rule, so every ticker with a known score could be chosen.'));
      this.facts.entries?.push({ t: trade.entryT, signalT: why.buyT, rule: null, price: NaN, shares: NaN });
    }
    if (why.rank) rows.push(...this.ranking(why.rank));
    rows.push(...this.flippedFrom());
    rows.push(...this.waits());
    return rows;
  }

  /** The rule that opens this side: buy, or short. */
  private get entryRule(): 'buy' | 'short' {
    return this.short ? 'short' : 'buy';
  }

  /** When the position on the other side was closed at the same fill, so this one flipped it. */
  private flippedFrom(): Row[] {
    const { trade } = this;
    const before = this.bt.run.trades.find((t) => t.asset === trade.asset && t.exitT === trade.entryT && t.reason === 'signal' && (t.side === 'short') !== this.short);
    if (!before) return [];
    const was = before.side === 'short' ? 'short' : 'long';
    const exit = before.why?.exit;
    if (exit?.k === 'rule' && exit.flip) return [row(`The same rule closed the ${was} position held until then, so the position flipped at the same fill.`)];
    return [row(`The ${was === 'short' ? 'cover' : 'sell'} rule closed the ${was} position held until then at the same fill, so the position flipped.`)];
  }

  /** What held the buy back, when that is what set its timing. */
  private waits(): Row[] {
    const { why } = this;
    const rows: Row[] = [];
    const [order, verb] = this.short ? ['short sale', 'sell short'] : ['buy', 'buy'];
    if (why.warmup) {
      const w = why.warmup;
      const what = why.rank ? `It was chosen from ${this.date(w.fromT)} on` : `The ${this.entryRule} rule held from ${this.date(w.fromT)} on`;
      rows.push(row(`${what}, but ${WARMUP_INPUT[w.input](w.n)} was still unknown. A ${order} waits until the inputs it needs are known, so this was the first close it could ${verb} at.`));
    }
    if (why.rearm) {
      const r = why.rearm;
      // A margin call disarms every side at the close it is made at, held or not.
      const call = this.bt.run.trades.some((t) => t.why?.exit?.k === 'margin' && t.why.exit.t === r.exitT);
      const before = this.bt.run.trades.find((t) => t.asset === this.trade.asset && t.exitT === r.exitT && t.reason !== 'open' && t.reason !== 'signal');
      const exit = call ? 'the margin call' : before ? `the ${before.reason}` : 'the stop';
      rows.push(
        row(
          `After ${exit} on ${this.date(r.exitT)} the ${this.entryRule} rule still held, last on ${this.date(r.heldT)}. After ${call ? 'a margin call' : 'a stop or target exit'} the rule has to stop holding before it can ${verb} again: it did not hold on ${this.date(r.clearedT)}, and held again at the next close.`,
        ),
      );
    }
    if (why.waited && why.rank) {
      const sold = why.rank.decision.sold;
      rows.push(row(`The buy waited until the sells of the same ranking had filled${sold.length ? ` (${sold.join(', ')})` : ''}, so their cash was there.`));
    }
    return rows;
  }

  private ranking(r: RankPlace): Row[] {
    const d = r.decision;
    const by = this.bt.spec.written?.rank?.text ?? 'the score';
    const rows: Row[] = [];
    const table = d.table ?? [];
    const texts = scoreTexts(table.map((x) => x.score));
    const mine = table.findIndex((x) => x.asset === this.trade.asset);
    const myScore = mine >= 0 ? texts[mine] : scoreTexts([r.score])[0];
    if (r.place >= 0) {
      const held = d.top === 1 ? 'Only the best is held' : `The best ${d.top} are held`;
      const verdict = r.place < d.top ? held : `${held}, so it was sold`;
      rows.push(row(`Ranked ${ungroupedOrdinal(r.place + 1)} of ${d.eligible} by ${by}. ${verdict}.`, `${by} ${myScore}`));
    } else {
      rows.push(row(`At this ranking it could not be chosen: ${this.ineligible(this.trade.asset, r.t)}.`, `${by} ${myScore}`));
    }
    if (d.table) {
      rows.push(row(`The ranking at ${this.closeOf(d.t)}, by ${by}:`));
      let n = 0;
      d.table.forEach((x, k) => {
        const me = x.asset === this.trade.asset ? ' (this one)' : '';
        // With fill: close on mixed clocks a decision can read a ticker's bar before its own (see simulate).
        const bar = x.t === d.t || Number.isNaN(x.t) ? '' : `, its bar of ${this.date(x.t)}`;
        if (x.eligible) {
          n++;
          const tied = d.table!.filter((y) => y.eligible && y !== x && y.score === x.score).map((y) => y.asset);
          const tie = tied.length ? `, tied with ${tied.join(' and ')}: the ticker listed first in the universe ranks higher` : '';
          rows.push(row(`${n}. ${x.asset}${me}`, `${texts[k]}${bar}${tie}`, 1, n <= d.top ? 'yes' : 'no'));
        } else {
          rows.push(row(`${x.asset}${me}`, `could not be chosen: ${this.ineligible(x.asset, x.t)}${bar}`, 1, 'no'));
        }
      });
    }
    return rows;
  }

  /** Why a ticker was not eligible at a decision that read its bar at `t`: the same tests the engine makes. */
  private ineligible(asset: string, t: number): string {
    const bars = this.bt.data.get(asset)!;
    const i = barAt(bars.t, t);
    const rank = this.bt.spec.rank;
    if (i < 0) return 'it had no bar to read yet';
    if (this.ev.eval(this.bt.spec.rules[asset].buy, asset)[i] !== 1) return 'its buy rule did not hold';
    if (rank && !Number.isFinite(this.ev.eval(rank.by, asset)[i])) return 'its score was unknown';
    return 'its sell rule held';
  }

  // ---------------------------------------------------------------- rules

  /** The rule at bar `i`: one row for a single test, or the rule and then each of its parts. */
  private rule(head: string, e: Expr, written: Written, i: number, pos: PosState | null): { rows: Row[]; result: Outcome } {
    const asset = this.trade.asset;
    const texts = new Map<Expr, string>();
    let k = 0;
    walk(e, (x) => texts.set(x, written.parts[k++] ?? ''));
    const text = (x: Expr) => texts.get(x) || '';
    const at = (x: Expr, j: number) => (j < 0 ? NaN : findPos(x) ? this.ev.compile(x, asset)(j, pos) : this.ev.eval(x, asset)[j]);
    const percentText = (s: string) => s.trim().endsWith('%') || this.bt.spec.params.some((p) => p.percent && p.name.toLowerCase() === s.trim().toLowerCase());
    // A number written out, such as 30, 5% or -2, needs no value beside it.
    const literal = (x: Expr) => (x.k === 'num' || (x.k === 'neg' && x.a.k === 'num')) && /^-?\s*\d*\.?\d+\s*%?$/.test(text(x).trim());
    const side = (x: Expr, shown: string) => (literal(x) ? text(x) : `${text(x)} ${shown}`);

    const value = (x: Expr): string => {
      if (x.k === 'cmp') {
        const pct = percentText(text(x.a)) || percentText(text(x.b));
        const [a, b] = pair(at(x.a, i), at(x.b, i), pct, UNKNOWN_PLACES);
        let out: string;
        const truth = (y: Expr) => {
          const v = at(y, i);
          return y.k === 'bool' ? text(y) : `${text(y)} ${Number.isNaN(v) ? 'is unknown' : v === 1 ? 'holds' : 'does not hold'}`;
        };
        if (x.op === 'xany') {
          const [va, vb, pa, pb] = [at(x.a, i), at(x.b, i), at(x.a, i - 1), at(x.b, i - 1)];
          const [fa, fb] = pair(pa, pb, pct, UNKNOWN_PLACES);
          const now = Number.isNaN(va) || Number.isNaN(vb) ? 'is unknown against' : va > vb ? 'is above' : va < vb ? 'is below' : 'is equal to';
          const then = Number.isNaN(pa) || Number.isNaN(pb) ? 'unknown' : pa > pb ? 'above' : pa < pb ? 'below' : 'equal to';
          out = `${side(x.a, a)} ${now} ${side(x.b, b)}; the bar before it was ${fa}, ${then} ${fb}`;
        } else if (isBool(x.a) && isBool(x.b)) {
          out = `${truth(x.a)} ${OPS[x.op as keyof typeof OPS]} ${truth(x.b)}`;
        } else if (x.op === 'xup' || x.op === 'xdn') {
          const up = x.op === 'xup';
          const [va, vb, pa, pb] = [at(x.a, i), at(x.b, i), at(x.a, i - 1), at(x.b, i - 1)];
          const [fa, fb] = pair(pa, pb, pct, UNKNOWN_PLACES);
          const now = Number.isNaN(va) || Number.isNaN(vb) ? 'is unknown against' : (up ? va > vb : va < vb) ? (up ? 'is above' : 'is below') : up ? 'is not above' : 'is not below';
          const then = Number.isNaN(pa) || Number.isNaN(pb) ? 'unknown' : (up ? pa <= pb : pa >= pb) ? (up ? 'at or below' : 'at or above') : up ? 'above' : 'below';
          out = `${side(x.a, a)} ${now} ${side(x.b, b)}; the bar before it was ${fa}, ${then} ${fb}`;
        } else {
          out = `${side(x.a, a)} ${OPS[x.op as keyof typeof OPS]} ${side(x.b, b)}`;
        }
        const reads = this.reads(x, asset, i);
        return reads ? `${out}; ${reads}` : out;
      }
      if (x.k === 'lag') return `${ungroupedPlural(x.n, 'bar')} earlier${i - x.n >= 0 ? `, on ${this.date(this.bars.t[i - x.n])}` : ''}`;
      if (x.k === 'ind' && x.fn === 'supertrend_up') {
        const trend = at(x, i);
        return Number.isNaN(trend) ? '' : `${trend === 1 ? 'uptrend' : 'downtrend'}, the line is at ${fixed(at({ ...x, fn: 'supertrend' }, i), 2)}`;
      }
      return this.reads(x, asset, i);
    };

    const rows: Row[] = [];
    const visit = (x: Expr, depth: number, label: string) => {
      const result = outcome(at(x, i));
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
        rows.push(row(label, x.op === 'and' ? 'all of these must hold' : 'one of these is enough', depth, result, true));
        for (const p of parts) visit(p, depth + 1, text(p));
      } else if (x.k === 'not') {
        rows.push(row(label, 'holds when the part below does not', depth, result, true));
        visit(x.a, depth + 1, text(x.a));
      } else {
        rows.push(row(label, value(x), depth, result, true));
      }
    };
    visit(e, 0, `${head} ${written.text}`);
    if (written.params.length) {
      const named = written.params.map((n) => this.bt.spec.params.find((p) => p.name === n)).filter((p) => p !== undefined);
      const shown = (v: number) => String(Number(v.toPrecision(12)));
      rows.push(row('Parameters', named.map((p) => `${p.name} = ${p.percent ? `${shown(p.value * 100)}%` : shown(p.value)}`).join(', ')));
    }
    return { rows, result: outcome(at(e, i)) };
  }

  /** Which bar of another ticker each `of` in `e` read, for the asset's bar `i`. */
  private reads(e: Expr, asset: string, i: number): string {
    const out: string[] = [];
    const visit = (x: Expr, a: string, j: number) => {
      if (x.k === 'of') {
        if (x.asset === a) return visit(x.a, a, j);
        const k = this.ev.barOf(x.asset, a, j);
        const bars = this.bt.data.get(x.asset)!;
        const unit = ownColumns(x.a).length > 0 ? 'row' : 'bar';
        const said = k < 0 ? `${x.asset} had no finished ${unit} yet` : `${x.asset}'s ${unit} of ${this.date(bars.t[k])}`;
        if (!out.includes(said)) out.push(said);
        if (k >= 0) visit(x.a, x.asset, k);
        return;
      }
      if (x.k === 'lag') return visit(x.a, a, j - x.n);
      if (x.k === 'ind' && x.src) return visit(x.src, a, j);
      if (x.k === 'math') return x.args.forEach((y) => visit(y, a, j));
      if ('a' in x) visit(x.a, a, j);
      if ('b' in x) visit(x.b, a, j);
    };
    if (i >= 0) visit(e, asset, i);
    return out.length ? `read from ${out.join(' and ')}` : '';
  }

  // ---------------------------------------------------------------- the size and the fill

  private size(): Row[] {
    const { why, trade, bt } = this;
    const spec = bt.spec;
    const n = spec.entries ?? 1;
    const rows: Row[] = [];
    const { px, fill } = this.fillOf(trade.entryT);
    this.facts.entryPrice = fill;
    this.facts.shares = why.spent / fill;
    if (this.facts.entries?.length) Object.assign(this.facts.entries[0], { price: fill, shares: why.spent / fill });
    rows.push(row(`Portfolio value ${this.atFill(trade.entryT)}`, money(why.equity)));

    const configured = spec.universe.find((a) => a.name === trade.asset)?.weight ?? why.weight;
    const inputs = this.closeOf(why.inputT);
    const inputIdx = barAt(this.bars.t, why.inputT);
    const ofThat = `${share(why.weight)} of that: ${money(why.weight * why.equity)}`;
    let whole = why.weight * why.equity;
    if (spec.sizing.k === 'risk') {
      const s = spec.sizing;
      const atr = ind.atr(this.bars.h, this.bars.l, this.bars.c, s.n)[inputIdx];
      const amount = s.risk * why.equity;
      const each = s.mult * atr;
      const riskShares = amount / each;
      rows.push(row('Risk per trade', `${share(s.risk)} of that: ${money(amount)}`));
      rows.push(row(`Distance: ${fixed(s.mult, 4)} × ATR(${s.n}) at ${inputs}`, `${fixed(s.mult, 4)} × ${fixed(atr, 4)} = ${fixed(each, 4)} a share`));
      rows.push(row(`Shares that lose ${money(amount)} over that distance`, `${shareCount(riskShares)}, worth ${money(riskShares * fill)} at the fill`));
      if (riskShares * fill > why.weight * why.equity) rows.push(row(`That is more than its weight, so the ${this.short ? 'short sale' : 'buy'} is capped at the weight`, ofThat));
      else whole = riskShares * fill;
    } else if (spec.sizing.k === 'invvol') {
      const vol = ind.stdev(ind.returns(this.bars.c), spec.sizing.n)[inputIdx];
      rows.push(row(`Volatility of its last ${spec.sizing.n} one-bar returns, at ${inputs}`, vol > 0 ? share(vol) : `${Number.isNaN(vol) ? 'unknown' : '0'}, so it keeps its configured weight`));
      rows.push(row(`Weight by inverse volatility, from its configured ${share(configured)}`, ofThat));
    } else if (spec.rank && spec.rank.top > 1) {
      rows.push(row(`Weight: each of the ${spec.rank.top} held gets the same share`, ofThat));
    } else {
      rows.push(row('Weight', ofThat));
    }
    if (n > 1) rows.push(row(`Each of the ${n} entries is 1/${n} of a whole position, ${money(whole)}`, money(why.wanted)));
    rows.push(...this.paid(why, 'buy'));
    if (this.atClose) {
      rows.push(row(`Filled at ${this.closeOf(trade.entryT)}${this.readAt(why.buyT, trade.entryT, why.rank ? 'ranking' : 'rule')}`, this.slipped(px, fill, this.entrySlip)));
    } else {
      rows.push(row(`Filled at ${this.openOf(trade.entryT)}`, `${this.slipped(px, fill, this.entrySlip)}${this.readBefore(trade.entryT, why.buyT)}`));
    }
    return rows;
  }

  /** Slippage makes an entry dearer: a buy pays more, a short sale gets less. An exit the other way. */
  private get entrySlip(): 'plus' | 'less' {
    return this.short ? 'less' : 'plus';
  }
  private get exitSlip(): 'plus' | 'less' {
    return this.short ? 'plus' : 'less';
  }

  /** The price an entry filled at the open (or close) of the bar at `t`, before and after slippage. */
  private fillOf(t: number): { px: number; fill: number } {
    const k = barAt(this.bars.t, t);
    const px = this.atClose ? this.bars.c[k] : this.bars.o[k];
    return { px, fill: px * (1 + this.s * this.slip) };
  }

  private atFill(t: number): string {
    return this.atClose ? `at ${this.closeOf(t)}` : `at ${this.openOf(t)}`;
  }

  /** After an open fill: the close the rule read, when it is the bar just before. */
  private readBefore(filled: number, read: number): string {
    const k = barAt(this.bars.t, filled);
    return k > 0 && this.bars.t[k - 1] === read ? `; the close the rule read was ${price(this.bars.c[k - 1])}` : '';
  }

  /**
   * What is paid on top of a buy: any cut to the cash there was, then the money put in with its costs and commission. A
   * block that can borrow is cut by its room instead, and a short sale takes money in, less its costs.
   */
  private paid(b: Pick<TradeWhy, 'wanted' | 'spent' | 'cash' | 'shares'>, what: 'buy' | 'add'): Row[] {
    const rows: Row[] = [];
    const commission = this.bt.spec.commission;
    const margin = this.bt.spec.margin;
    const fee = b.spent * this.cost;
    const comm = commission ? commissionFee(commission, b.spent, b.shares) : 0;
    const charges = [this.cost > 0 ? 'costs' : '', comm > 0 ? 'commission' : ''].filter(Boolean);
    if (b.spent < b.wanted * (1 - 1e-9)) {
      const onTop = charges.join(' and ') || 'costs';
      const withCharges = charges.length ? ` with its ${charges.join(' and ')}` : '';
      if (margin) {
        const order = what === 'add' ? 'add' : this.short ? 'short sale' : 'buy';
        rows.push(row(`Positions, long and short together, may come to at most ${share(margin.cap)} of equity, so the ${order} was cut to the room left${withCharges}`, money(b.spent)));
      } else if (b.cash >= b.wanted * (1 - 1e-9)) rows.push(row(`The ${onTop} ${onTop === 'commission' ? 'is' : 'are'} paid on top, so the ${money(b.cash)} in cash covered`, money(b.spent)));
      else rows.push(row(`Only ${money(b.cash)} was in cash, so the ${what} was cut to what that covers${withCharges}`, money(b.spent)));
    }
    const extra = [fee > 0 ? `${money(fee)} costs` : '', comm > 0 ? `${money(comm)} commission` : ''].filter(Boolean);
    if (this.short) rows.push(row('Money taken in', `${money(b.spent)}${extra.length ? ` less ${extra.join(' and ')}` : ''}, for ${shareCount(b.shares)} shares sold short`));
    else rows.push(row('Money put in', `${money(b.spent)}${extra.length ? ` plus ${extra.join(' and ')}` : ''}, for ${shareCount(b.shares)} shares`));
    return rows;
  }

  /** An entry after the first: the add rule at its close, the size of the step, the fill, and where the levels moved. */
  private added(add: AddWhy, j: number): Row[] {
    const { trade, bt } = this;
    const spec = bt.spec;
    const n = spec.entries ?? 1;
    const entry = this.entries[j + 1];
    const rows: Row[] = [row(`The add rule was read at ${this.closeOf(add.signalT)}.`)];
    const rule = bt.spec.rules[trade.asset].add;
    const written = bt.spec.written?.rules[trade.asset]?.add;
    let outcome: Outcome | null = null;
    if (rule && written) {
      const r = this.rule('add when', rule, written, barAt(this.bars.t, add.signalT), this.positionBefore(j + 1));
      outcome = r.result;
      rows.push(...r.rows);
    }
    const { px, fill } = this.fillOf(entry.t);
    this.facts.entries?.push({ t: entry.t, signalT: add.signalT, rule: outcome, price: fill, shares: add.spent / fill });
    rows.push(row(`Portfolio value ${this.atFill(entry.t)}`, money(add.equity)));
    const whole = spec.sizing.k === 'risk' ? 'A whole position by risk per trade, capped at its weight' : `A whole position, ${share(add.weight)} of that`;
    rows.push(row(whole, money(add.full)));
    rows.push(row(`One entry is 1/${n} of it`, money(add.full / n)));
    if (add.wanted < (add.full / n) * (1 - 1e-9)) {
      rows.push(row(`The position was worth ${money(add.held)}, so the entry was cut to what keeps it within a whole position`, money(add.wanted)));
    }
    rows.push(...this.paid(add, 'add'));
    if (this.atClose) rows.push(row(`Filled at ${this.closeOf(entry.t)}${this.readAt(add.signalT, entry.t, 'rule')}`, this.slipped(px, fill, this.entrySlip)));
    else rows.push(row(`Filled at ${this.openOf(entry.t)}`, `${this.slipped(px, fill, this.entrySlip)}${this.readBefore(entry.t, add.signalT)}`));
    rows.push(row(`Average entry price of the ${j + 2} entries`, price(add.average)));
    const stops = spec.stops[trade.asset];
    const [under, over] = this.ways;
    if (add.stopLoss !== null && stops.stopLoss) rows.push(row('The stop loss moved to', `${price(add.stopLoss)}, ${this.distance(stops.stopLoss, under, 'the average')}`));
    if (add.takeProfit !== null && stops.takeProfit) rows.push(row('The take profit moved to', `${price(add.takeProfit)}, ${this.distance(stops.takeProfit, over, 'the average')}`));
    return rows;
  }

  /** Where a stop sits from the price it is measured from, then a target: under and over for a long, over and under for a short. */
  private get ways(): ['under' | 'over', 'under' | 'over'] {
    return this.short ? ['over', 'under'] : ['under', 'over'];
  }

  /** A stop's or target's distance from a price, as set at the first entry. */
  private distance(s: StopLevel, way: 'under' | 'over', from: string): string {
    if (s.k === 'pct') return `${share(s.v)} ${way} ${from}`;
    const atr = ind.atr(this.bars.h, this.bars.l, this.bars.c, s.n)[barAt(this.bars.t, this.why.inputT)];
    return `${fixed(s.mult, 4)} × ATR(${s.n}) ${fixed(atr, 4)} (at ${this.closeOf(this.why.inputT)}) = ${fixed(s.mult * atr, 4)} ${way} ${from}`;
  }

  /** The position as a rule read it before entry number `made + 1`: its first `made` entries. */
  private positionBefore(made: number): PosState {
    const first = this.entries[0];
    let money = first.money;
    let shares = first.shares;
    for (let k = 1; k < made; k++) {
      money += this.entries[k].money;
      shares += this.entries[k].shares;
    }
    return { entryIdx: barAt(this.bars.t, first.t), entryPrice: made === 1 ? first.price : money / shares, lastPrice: this.entries[made - 1].price, entries: made, ...this.sidePos };
  }

  /** What the rules read of the position's side and fill: that it is short, and that it filled at a close. */
  private get sidePos(): Pick<PosState, 'short' | 'atClose'> {
    return { ...(this.short ? { short: true as const } : {}), ...(this.atClose ? { atClose: true as const } : {}) };
  }

  /** After a close fill at `filled`: that it is the close the decision read at `read`, or which close it read instead. */
  private readAt(read: number, filled: number, by: 'rule' | 'ranking'): string {
    return read === filled ? `, the close the ${by} read` : `; the ${by} read ${this.closeOf(read)}`;
  }

  private slipped(px: number, fill: number, way: 'plus' | 'less'): string {
    if (this.slip === 0) return price(px);
    return `${price(px)}, ${way} ${fixed(this.bt.spec.slippageBps, 2)} bps slippage: ${price(fill)}`;
  }

  // ---------------------------------------------------------------- the exit

  private sold(): Row[] {
    const { trade, why } = this;
    const exit = why.exit;
    if (trade.reason === 'open' || !exit) return this.held();
    if (exit.k === 'level') return this.level(exit);
    const rows: Row[] = [];
    const j = barAt(this.bars.t, trade.exitT);
    const rules = this.bt.spec.rules[trade.asset];
    const written = this.bt.spec.written?.rules[trade.asset];
    const verb = this.short ? 'Covered' : 'Sold';
    let px = this.atClose ? this.bars.c[j] : this.bars.o[j];
    let at = this.atClose ? `${verb} at ${this.closeOf(trade.exitT)}${this.readAt(exit.t, trade.exitT, exit.k === 'rank' ? 'ranking' : 'rule')}` : `${verb} at ${this.openOf(trade.exitT)}`;
    if (exit.k === 'rule' && exit.flip) {
      // The other side's entry rule, read as if flat: it closes this side whether or not the other then opens.
      const [other, side] = this.short ? (['buy', 'short'] as const) : (['short', 'long'] as const);
      this.facts.sellT = exit.t;
      rows.push(row(`The ${other} rule was read at ${this.closeOf(exit.t)}. It closes a ${side} position.`));
      const e = this.short ? rules.buy : rules.short;
      const w = written?.[other];
      if (e && w) {
        const rule = this.rule(`${other} when`, e, w, barAt(this.bars.t, exit.t), null);
        this.facts.sellRule = rule.result;
        rows.push(...rule.rows);
      }
      if (flipped(trade, this.bt.run.trades)) rows.push(row(`So the position flipped: a ${this.short ? 'long' : 'short'} position was opened at the same fill.`));
    } else if (exit.k === 'rule') {
      const name = this.short ? 'cover' : 'sell';
      this.facts.sellT = exit.t;
      rows.push(row(`The ${name} rule was read at ${this.closeOf(exit.t)}.`));
      const w = written?.[name];
      const e = this.short ? rules.cover : rules.sell;
      if (e && w) {
        const rule = this.rule(`${name} when`, e, w, barAt(this.bars.t, exit.t), this.position());
        this.facts.sellRule = rule.result;
        rows.push(...rule.rows);
      }
    } else if (exit.k === 'rank') {
      rows.push(row(`At the ranking made at ${this.closeOf(exit.rank.decision.t)}:`));
      rows.push(...this.ranking(exit.rank));
    } else if (exit.k === 'margin') {
      // Even with fill: close, a margin call closes at the next open.
      const level = this.bt.spec.margin?.maintenance ?? 0;
      rows.push(
        row(
          `A margin call was made at ${this.closeOf(exit.t)}: equity was below ${share(level)} of the value of the positions, long and short together, so every position was closed at the next open.`,
          `${money(exit.equity)} against ${money(exit.gross)}, ${share(exit.equity / exit.gross)}`,
        ),
      );
      px = this.bars.o[j];
      at = `${verb} at ${this.openOf(trade.exitT)}`;
    } else {
      // A ruin closes at the open or the close it is found at; a ticker with no bar then at its last close.
      const live = this.bars.t[j] === trade.exitT;
      const raw = trade.exitPrice / (1 - this.s * this.slip);
      const atOpen = live && Math.abs(raw - this.bars.o[j]) <= Math.abs(raw - this.bars.c[j]);
      const when = !live ? `on ${this.date(exit.t)}` : atOpen ? `at ${this.openOf(exit.t)}` : `at ${this.closeOf(exit.t)}`;
      rows.push(row(`Equity fell to ${money(exit.equity)} ${when}, so every position was closed there and the run stopped.`));
      px = atOpen ? this.bars.o[j] : this.bars.c[j];
      at = !live ? `${verb} at its last close, ${this.closeOf(this.bars.t[j])}` : `${verb} at ${atOpen ? this.openOf(trade.exitT) : this.closeOf(trade.exitT)}`;
    }
    this.exitAt(px, true);
    rows.push(row(at, this.slipped(px, px * (1 - this.s * this.slip), this.exitSlip)));
    return rows;
  }

  /** The position as its sell rule reads it: every entry made. */
  private position(): PosState {
    if (this.entries.length > 1) return this.positionBefore(this.entries.length);
    return { entryIdx: barAt(this.bars.t, this.trade.entryT), entryPrice: this.trade.entryPrice, ...this.sidePos };
  }

  /**
   * The exit at `px`, slipped when `sold`, and the return after costs and commission from the entries' prices. A short's
   * is measured on what it brought in a share, less what covering it cost and its borrow fees, as the engine does.
   */
  private exitAt(px: number, sold: boolean): void {
    const exitPrice = sold ? px * (1 - this.s * this.slip) : px;
    this.facts.exitPrice = exitPrice;
    const entries = this.facts.entries;
    if (entries && entries.length > 1) {
      let money = 0;
      let shares = 0;
      for (const e of entries) {
        money += e.price * e.shares;
        shares += e.shares;
      }
      this.facts.entryPrice = money / shares;
    }
    const c = this.bt.spec.commission;
    const held = this.why.commission?.exitShares;
    if (this.short) {
      let entryFees = 0;
      let entryShares = 0;
      if (c) {
        for (const e of entries && entries.length > 1 ? entries : [{ price: this.facts.entryPrice, shares: this.facts.shares }]) {
          entryFees += commissionFee(c, e.price * e.shares, e.shares);
          entryShares += e.shares;
        }
      }
      const basis = this.facts.entryPrice * (1 - this.cost) - (c ? entryFees / entryShares : 0);
      const cover = exitPrice * (1 + this.cost) + (c && held ? this.why.commission!.exit / held : 0);
      const borrow = this.borrowPerShare();
      this.shortReturn = { basis, cover, borrow };
      this.facts.ret = (basis - exitPrice * (1 + this.cost) - (c && held ? this.why.commission!.exit / held : 0) - borrow) / basis;
      return;
    }
    if (!c || held === undefined) {
      this.facts.ret = (exitPrice * (1 - this.cost)) / (this.facts.entryPrice * (1 + this.cost)) - 1;
      return;
    }
    // What the exit paid, as the run recorded it: a sale pays no more than it brings in and the cash there was (rule 48).
    const exitFee = this.why.commission!.exit;
    let entryFees = 0;
    let entryShares = 0;
    for (const e of entries && entries.length > 1 ? entries : [{ price: this.facts.entryPrice, shares: this.facts.shares }]) {
      entryFees += commissionFee(c, e.price * e.shares, e.shares);
      entryShares += e.shares;
    }
    this.facts.ret = (exitPrice * (1 - this.cost) - exitFee / held) / (this.facts.entryPrice * (1 + this.cost) + entryFees / entryShares) - 1;
  }

  /**
   * A short's borrow fee a share over its life, as the engine accrued it: at each step of the run's timeline after the
   * entry's, up to the exit's, the yearly fee on the ticker's last close before the step, for the step's days.
   */
  private borrowPerShare(): number {
    const fee = this.bt.spec.margin?.borrowFee ?? 0;
    const t = this.bt.run.t;
    let total = 0;
    for (let k = barAt(t, this.trade.entryT) + 1; k < t.length && t[k] <= this.trade.exitT; k++) {
      const close = this.bars.c[barAt(this.bars.t, t[k - 1])];
      total += (close * fee * (t[k] - t[k - 1])) / DAY / 365;
    }
    return total;
  }

  /** A stop or the target: where it sat, how it was set, and what the bar did. */
  private level(exit: Extract<ExitWhy, { k: 'level' }>): Row[] {
    const { trade, why } = this;
    const stops = this.bt.spec.stops[trade.asset];
    const j = barAt(this.bars.t, trade.exitT);
    const [o, h, l] = [this.bars.o[j], this.bars.h[j], this.bars.l[j]];
    const inputIdx = barAt(this.bars.t, why.inputT);
    const atr = (s: StopLevel) => (s.k === 'atr' ? ind.atr(this.bars.h, this.bars.l, this.bars.c, s.n)[inputIdx] : NaN);
    const distance = (s: StopLevel, from: string, way: 'under' | 'over') => this.distance(s, way, from);
    const fill = this.entries.length > 1 ? `the ${price(trade.entryPrice)} average entry price of the ${this.entries.length} entries` : `the ${price(trade.entryPrice)} fill`;
    const rows: Row[] = [];
    // With magnify: the smaller bar the level was reached in, its open, high and low on the bar's scale, and its words.
    const size = this.bt.spec.magnify;
    const inside = exit.inside;
    const seen = inside?.k === 'inside' ? { ...this.smallBar(j, inside.t), at: this.smallTime(inside.t) } : null;
    const [so, sh, sl] = seen ? [seen.o, seen.h, seen.l] : [o, h, l];
    const smaller = seen ? `the ${size} bar starting ${seen.at}` : '';
    /** Why a bar with both levels inside it was read whole, so the stop came first. */
    const whole = inside?.k === 'whole' ? { none: `There are no ${size} bars for this bar`, missing: `Some of this bar's ${size} bars are missing`, mismatch: `This bar's ${size} bars do not match it` }[inside.why] : null;
    // A short's prices move the other way: its target is below the fill and its stop above, `k` turns one into the other.
    const k = this.s;
    const short = this.short;
    const past = (a: number, b: number) => k * a > k * b;
    const best = (high: number, low: number) => (short ? low : high);
    const worst = (high: number, low: number) => (short ? high : low);
    const [beyond, behind] = short ? ['below', 'above'] : ['above', 'below'];
    const [toward, against] = short ? ['fell to', 'rose to'] : ['reached', 'fell to'];
    const [under, over] = this.ways;
    const done = short ? 'it was covered' : 'it sold';
    let level: number;
    if (trade.reason === 'take profit') {
      const s = stops.takeProfit!;
      level = s.k === 'pct' ? trade.entryPrice * (1 + k * s.v) : trade.entryPrice + k * s.mult * atr(s);
      rows.push(row(`Take profit at ${price(level)}`, distance(s, fill, over)));
      if (seen && past(so, level)) rows.push(row(`On ${this.date(trade.exitT)}, ${smaller} opened at ${price(so)}, ${beyond} the target, so ${done} at that open.`));
      else if (seen) rows.push(row(`On ${this.date(trade.exitT)}, in ${smaller}, the price ${toward} ${price(best(sh, sl))}, through the target, so ${done} at the target.`));
      else if (past(o, level)) rows.push(row(`On ${this.date(trade.exitT)} the bar opened at ${price(o)}, ${beyond} the target, so ${done} at the open.`));
      else rows.push(row(`On ${this.date(trade.exitT)} the bar ${toward} ${price(best(h, l))}, through the target, so ${done} at the target.`));
      const stopIn = why.stopLoss !== null && k * worst(h, l) <= k * why.stopLoss;
      if (seen && stopIn) rows.push(row(`The stop at ${price(why.stopLoss!)} was inside this bar too. Its ${size} bars show the target was reached first.`));
      else if (past(o, level) && stopIn) rows.push(row(`The bar later ${short ? 'rose' : 'fell'} through the stop at ${price(why.stopLoss!)} too, but the open came first.`));
      else if (whole) rows.push(row(`${whole}, so it was read whole.`));
    } else {
      if (trade.reason === 'trailing stop') {
        const s = stops.trailingStop!;
        const high = exit.high!;
        level = s.k === 'pct' ? high * (1 - k * s.v) : high - k * s.mult * atr(s);
        const first = j === barAt(this.bars.t, trade.entryT) + (this.atClose ? 1 : 0);
        const since = this.entries.length > 1 ? 'the first entry' : short ? 'the short sale' : 'the buy';
        const most = short ? 'lowest' : 'highest';
        const highest = seen
          ? `${price(high)}, the ${most} price from ${since} to the ${size} bar before`
          : first
            ? `${price(high)}, the ${this.atClose ? 'close' : 'open'} it was ${short ? 'sold short' : 'bought'} at`
            : `${price(high)}, the ${most} price from ${since} to the bar before`;
        rows.push(row(`Trailing stop at ${price(level)}`, distance(s, highest, under)));
        if (why.stopLoss !== null) rows.push(row(`The stop loss, at ${price(why.stopLoss)}, was ${short ? 'higher' : 'lower'}.`));
      } else {
        const s = stops.stopLoss!;
        level = s.k === 'pct' ? trade.entryPrice * (1 - k * s.v) : trade.entryPrice - k * s.mult * atr(s);
        rows.push(row(`Stop loss at ${price(level)}`, distance(s, fill, under)));
      }
      if (seen && past(level, so)) rows.push(row(`On ${this.date(trade.exitT)}, ${smaller} opened at ${price(so)}, ${behind} the stop, so ${done} at that open.`));
      else if (seen) rows.push(row(`On ${this.date(trade.exitT)}, in ${smaller}, the price ${against} ${price(worst(sh, sl))}, through the stop, so ${done} at the stop.`));
      else if (past(level, o)) rows.push(row(`On ${this.date(trade.exitT)} the bar opened at ${price(o)}, ${behind} the stop, so ${done} at the open.`));
      else rows.push(row(`On ${this.date(trade.exitT)} the bar ${against} ${price(worst(h, l))}, through the stop, so ${done} at the stop.`));
      if (why.takeProfit !== null && k * best(h, l) >= k * why.takeProfit) {
        const target = `The take profit at ${price(why.takeProfit)} was inside this bar too.`;
        if (seen) rows.push(row(`${target} Its ${size} bars show the stop was reached first.`));
        else if (whole) rows.push(row(`${target} ${whole}, so the stop is taken first, as for any bar read whole.`));
        else if (size && past(level, o)) rows.push(row(`${target} The bar opened ${behind} the stop, so the stop came first.`));
        else rows.push(row(`${target} When both are, the stop is taken first.`));
      } else if (whole) rows.push(row(`${whole}, so it was read whole.`));
    }
    this.facts.level = level;
    const atOpen = trade.reason === 'take profit' ? past(so, level) : past(level, so);
    const px = atOpen ? so : level;
    this.exitAt(px, true);
    const where = atOpen ? (seen ? `the open of that ${size} bar` : 'the open') : trade.reason === 'take profit' ? 'the target' : 'the stop';
    rows.push(row(`${short ? 'Covered' : 'Sold'} at ${where}`, this.slipped(px, px * (1 - k * this.slip), this.exitSlip)));
    if (this.atClose && j === barAt(this.bars.t, trade.entryT) + 1) rows.push(row(`${short ? 'Sold short' : 'Bought'} at a close, the position was watched by its stops from the next bar on.`));
    return rows;
  }

  /** With magnify: the smaller bar starting at `t` inside the ticker's bar `j`, on the bar's own scale, as the run walked it. */
  private smallBar(j: number, t: number): { o: number; h: number; l: number } {
    const { spec } = this.bt;
    const asset = this.trade.asset;
    const source = spec.universe.find((a) => a.name === asset)!.source;
    const seen = insideBar(this.bars, j, source, this.bt.data.get(insideKey(asset, spec.magnify!))!, spec.interval, spec.magnify!);
    const k = seen.ok ? seen.path.t.indexOf(t) : -1;
    if (!seen.ok || k < 0) throw new Error(`The ${spec.magnify} bars of ${asset} no longer hold the one the exit was decided in`);
    return { o: seen.path.o[k], h: seen.path.h[k], l: seen.path.l[k] };
  }

  /** A smaller bar's start: Yahoo's are on the exchange's clock (data.ts parseYahooInside), Binance's in UTC. */
  private smallTime(t: number): string {
    const source = this.bt.spec.universe.find((a) => a.name === this.trade.asset)!.source;
    return `${stamp(t, true)} ${source === 'yahoo' ? '(exchange time)' : 'UTC'}`;
  }

  private held(): Row[] {
    const { trade, bt } = this;
    const rows: Row[] = [];
    const j = barAt(this.bars.t, bt.run.t[bt.run.t.length - 1]);
    this.exitAt(this.bars.c[j], false);
    rows.push(row(`Still held at the end of the run. It is valued at the last close, ${this.date(this.bars.t[j])}.`, price(this.bars.c[j])));
    const name = this.short ? 'cover' : 'sell';
    const exit = this.short ? bt.spec.rules[trade.asset].cover : bt.spec.rules[trade.asset].sell;
    const written = bt.spec.written?.rules[trade.asset]?.[name];
    if (exit && written) {
      rows.push(row(`The ${name} rule at ${this.closeOf(this.bars.t[j])}:`));
      rows.push(...this.rule(`${name} when`, exit, written, j, this.position()).rows);
    }
    const state = bt.run.states.find((s) => s.name === trade.asset);
    const pending = state?.pending;
    // An order to open the other side closes this one first: a flip.
    const [closing, flip, order] = this.short ? (['cover', 'buy', 'cover it'] as const) : (['sell', 'short', 'sell it'] as const);
    if (state?.marginCall) {
      const level = share(bt.spec.margin?.maintenance ?? 0);
      rows.push(row(`A margin call was made at the last close: equity was below ${level} of the value of the positions, long and short together, so an order to ${order} is waiting for the next open.`));
    } else if (pending === closing || pending === flip) {
      rows.push(row(`An order to ${order}${pending === flip ? (this.short ? ' and buy' : ' and sell short') : ''} is waiting for the ${this.atClose ? 'next close' : 'next open'}.`));
    } else rows.push(row(`No order to ${order} is waiting.`));
    return rows;
  }

  // ---------------------------------------------------------------- the result

  private result(): Row[] {
    const { trade, why } = this;
    const rows: Row[] = [];
    const open = trade.reason === 'open';
    const short = this.short;
    rows.push(row(open ? 'Return so far, after costs' : 'Return after costs', percent(trade.ret)));
    const r = this.shortReturn;
    if (r) {
      rows.push(
        row(
          'A short is measured on what it brought in a share, less what covering it cost and its borrow fees, over what it brought in',
          `(${price(r.basis)} − ${price(r.cover)} − ${price(r.borrow)}) ÷ ${price(r.basis)}`,
        ),
      );
    }
    rows.push(row(open ? 'Profit so far' : 'Profit', `${trade.pnl > 0 ? '+' : ''}${money(trade.pnl)}`));
    if (short) rows.push(row(open ? 'Borrow fees so far' : 'Borrow fees', `${money(trade.borrow ?? 0)}, part of the profit`));
    rows.push(row('Held', `${ungroupedPlural(trade.bars, 'bar')}, from ${this.date(trade.entryT)} to ${this.date(trade.exitT)}`));
    if (this.entries.length > 1) rows.push(row(`${short ? 'Sold short' : 'Bought'} in ${this.entries.length} entries of the ${this.bt.spec.entries} allowed`, `at ${price(trade.entryPrice)} on average`));
    if (why.fees > 0) {
      const toSell = open ? `; ${short ? 'covering' : 'selling'} at the last close would cost ${money(trade.exitPrice * Math.abs(this.sharesHeld()) * this.cost + (why.commission?.exit ?? 0))} more` : '';
      const ofWhich = why.commission && why.commission.paid > 0 ? `, of which ${money(why.commission.paid)} commission` : '';
      rows.push(row(open ? 'Costs paid so far' : 'Costs paid', `${money(why.fees)}${ofWhich}${toSell}`));
    }
    if (why.topUps || why.trims) {
      const [up, down] = short ? ['shorted more', 'covered part of it'] : ['topped it up', 'trimmed it'];
      const parts = [why.topUps ? `${up} ${times(why.topUps)}` : '', why.trims ? `${down} ${times(why.trims)}` : ''].filter(Boolean);
      rows.push(row(`Rebalancing ${parts.join(' and ')}.`));
    }
    if (open) rows.push(row(short ? 'A short still held counts the cost of covering at the last close in its return, without slippage.' : 'A position still held counts the cost of selling at the last close in its return, without slippage.'));
    return rows;
  }

  /** Shares held at the end: the open position's. */
  private sharesHeld(): number {
    return this.bt.run.states.find((s) => s.name === this.trade.asset)?.shares ?? 0;
  }
}

function times(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}
