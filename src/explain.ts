// "Why did this trade happen?": one trade in plain words and the engine's own numbers. Built on
// demand from the record the engine kept as it decided (Trade.why) and the same Evaluator over the
// same prices, so each value shown is the one the run used. Pure data; render-trades.ts draws it.

import { WARMUP_INPUT, type Backtest } from './backtest.ts';
import { findPos, isBool, ownColumns, walk, wholeParts, type CmpOp, type Expr, type StopLevel, type Written } from './dsl.ts';
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
  if (!why) throw new Error(`The trade in ${trade.asset} has no record of its decisions`);
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
      { id: 'sold', title: trade.reason === 'open' ? 'Why it is not closed' : `Why it was ${closed}`, rows: this.sold() },
      { id: 'result', title: 'Result', rows: this.result() },
    ];
    const sold = trade.reason === 'open' ? 'not closed' : `${closed} ${this.date(trade.exitT)} at ${price(trade.exitPrice)}`;
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
    return this.intraday ? `the close of the bar that starts at ${this.date(t)}` : `the close of ${this.date(t)}`;
  }
  private openOf(t: number): string {
    return this.intraday ? `the open of the bar that starts at ${this.date(t)}` : `the open of ${this.date(t)}`;
  }

  // ---------------------------------------------------------------- the buy

  private bought(): Row[] {
    const { why, trade, bt } = this;
    const rows: Row[] = [];
    const i = barAt(this.bars.t, why.buyT);
    if (why.rank) {
      const d = why.rank.decision;
      const read = d.t === why.buyT ? '' : ` For this ticker, the ranking read the bar of ${this.date(why.buyT)}.`;
      rows.push(row(`The ranking at ${this.closeOf(d.t)} selected it.${read}`));
    } else {
      rows.push(row(`The run read the ${this.entryRule} rule at ${this.closeOf(why.buyT)}.`));
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
      rows.push(row('There is no buy rule. Thus the ranking can select each ticker that has a known score.'));
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
    if (exit?.k === 'rule' && exit.flip) return [row(`The same rule closed the ${was} position held until then. Thus the position flipped at the same fill.`)];
    return [row(`The ${was === 'short' ? 'cover' : 'sell'} rule closed the ${was} position held until then, at the same fill. Thus the position flipped.`)];
  }

  /** What held the buy back, when that is what set its timing. */
  private waits(): Row[] {
    const { why } = this;
    const rows: Row[] = [];
    const [order, verb] = this.short ? ['short sale', 'sell short'] : ['buy', 'buy'];
    if (why.warmup) {
      const w = why.warmup;
      const what = why.rank ? `The ranking selected it from ${this.date(w.fromT)}` : `The ${this.entryRule} rule held from ${this.date(w.fromT)}`;
      rows.push(row(`${what}. But ${WARMUP_INPUT[w.input](w.n)} was unknown at that time. A ${order} waits until all its inputs are known. This close was the first close where the ${order} had all its inputs.`));
    }
    if (why.rearm) {
      const r = why.rearm;
      // A margin call disarms every side at the close it is made at, held or not.
      const call = this.bt.run.trades.some((t) => t.why?.exit?.k === 'margin' && t.why.exit.t === r.exitT);
      const before = this.bt.run.trades.find((t) => t.asset === this.trade.asset && t.exitT === r.exitT && t.reason !== 'open' && t.reason !== 'signal');
      const exit = call ? 'the margin call' : before ? `the ${before.reason}` : 'the stop';
      rows.push(
        row(
          `After ${exit} on ${this.date(r.exitT)}, the ${this.entryRule} rule continued to hold. The last close where it held was ${this.date(r.heldT)}. After ${call ? 'a margin call' : 'a stop or target exit'}, the rule must become false before it can ${verb} again. The rule did not hold on ${this.date(r.clearedT)}, and it held again at the next close.`,
        ),
      );
    }
    if (why.waited && why.rank) {
      const sold = why.rank.decision.sold;
      rows.push(row(`The buy waited until the sells of the same ranking filled${sold.length ? ` (${sold.join(', ')})` : ''}. Thus the cash from these sells was available.`));
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
      const held = d.top === 1 ? 'The strategy holds only the best' : `The strategy holds the best ${d.top}`;
      const verdict = r.place < d.top ? held : `${held}. Thus the strategy sold it`;
      rows.push(row(`It ranked ${ungroupedOrdinal(r.place + 1)} of ${d.eligible} by ${by}. ${verdict}.`, `${by} ${myScore}`));
    } else {
      rows.push(row(`This ranking did not include it: ${this.ineligible(this.trade.asset, r.t)}.`, `${by} ${myScore}`));
    }
    if (d.table) {
      rows.push(row(`The ranking at ${this.closeOf(d.t)}, by ${by}:`));
      let n = 0;
      d.table.forEach((x, k) => {
        const me = x.asset === this.trade.asset ? ' (this ticker)' : '';
        // With fill: close on mixed clocks a decision can read a ticker's bar before its own (see simulate).
        const bar = x.t === d.t || Number.isNaN(x.t) ? '' : `, its bar of ${this.date(x.t)}`;
        if (x.eligible) {
          n++;
          const tied = d.table!.filter((y) => y.eligible && y !== x && y.score === x.score).map((y) => y.asset);
          const tie = tied.length ? `, the same score as ${tied.join(' and ')}: the ticker that is first in the universe ranks higher` : '';
          rows.push(row(`${n}. ${x.asset}${me}`, `${texts[k]}${bar}${tie}`, 1, n <= d.top ? 'yes' : 'no'));
        } else {
          rows.push(row(`${x.asset}${me}`, `not included: ${this.ineligible(x.asset, x.t)}${bar}`, 1, 'no'));
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
    if (i < 0) return 'it had no bar to read at that time';
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
    const wholes = wholeParts(e, written);
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
          const now = Number.isNaN(va) || Number.isNaN(vb) ? 'cannot be compared with' : va > vb ? 'is above' : va < vb ? 'is below' : 'is equal to';
          const then = Number.isNaN(pa) || Number.isNaN(pb) ? 'unknown' : pa > pb ? 'above' : pa < pb ? 'below' : 'equal to';
          out = `${side(x.a, a)} ${now} ${side(x.b, b)}. On the bar before: ${fa}, ${then} ${fb}`;
        } else if (isBool(x.a) && isBool(x.b)) {
          out = `${truth(x.a)} ${OPS[x.op as keyof typeof OPS]} ${truth(x.b)}`;
        } else if (x.op === 'xup' || x.op === 'xdn') {
          const up = x.op === 'xup';
          const [va, vb, pa, pb] = [at(x.a, i), at(x.b, i), at(x.a, i - 1), at(x.b, i - 1)];
          const [fa, fb] = pair(pa, pb, pct, UNKNOWN_PLACES);
          const now = Number.isNaN(va) || Number.isNaN(vb) ? 'cannot be compared with' : (up ? va > vb : va < vb) ? (up ? 'is above' : 'is below') : up ? 'is not above' : 'is not below';
          const then = Number.isNaN(pa) || Number.isNaN(pb) ? 'unknown' : (up ? pa <= pb : pa >= pb) ? (up ? 'at or below' : 'at or above') : up ? 'above' : 'below';
          out = `${side(x.a, a)} ${now} ${side(x.b, b)}. On the bar before: ${fa}, ${then} ${fb}`;
        } else {
          out = `${side(x.a, a)} ${OPS[x.op as keyof typeof OPS]} ${side(x.b, b)}`;
        }
        const reads = this.reads(x, asset, i);
        return reads ? `${out} (${reads})` : out;
      }
      if (x.k === 'lag') return `${ungroupedPlural(x.n, 'bar')} before${i - x.n >= 0 ? `, on ${this.date(this.bars.t[i - x.n])}` : ''}`;
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
          if (y.k === 'logic' && y.op === x.op && (top || !wholes.has(y))) {
            flat(y.a);
            flat(y.b);
          } else parts.push(y);
        };
        flat(x, true);
        rows.push(row(label, x.op === 'and' ? 'all of these must hold' : 'one or more of these must hold', depth, result, true));
        for (const p of parts) visit(p, depth + 1, text(p));
      } else if (x.k === 'not') {
        rows.push(row(label, 'holds when the part below does not hold', depth, result, true));
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
        const said = k < 0 ? `${x.asset} had no full ${unit} at that time` : `the ${x.asset} ${unit} of ${this.date(bars.t[k])}`;
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
      rows.push(row(`Shares with a loss of ${money(amount)} if the price moves that distance`, `${shareCount(riskShares)}, worth ${money(riskShares * fill)} at the fill`));
      if (riskShares * fill > why.weight * why.equity) rows.push(row(`That is more than its weight. Thus the ${this.short ? 'short sale' : 'buy'} is cut to the weight`, ofThat));
      else whole = riskShares * fill;
    } else if (spec.sizing.k === 'invvol') {
      const vol = ind.stdev(ind.returns(this.bars.c), spec.sizing.n)[inputIdx];
      rows.push(row(`Volatility of its last ${spec.sizing.n} one-bar returns, at ${inputs}`, vol > 0 ? share(vol) : `${Number.isNaN(vol) ? 'unknown' : '0'}: it keeps its base weight`));
      rows.push(row(`Weight by inverse volatility, from its base weight of ${share(configured)}`, ofThat));
    } else if (spec.rank && spec.rank.top > 1) {
      rows.push(row(`Weight: each of the ${spec.rank.top} tickers held has the same share`, ofThat));
    } else {
      rows.push(row('Weight', ofThat));
    }
    if (n > 1) rows.push(row(`Each of the ${n} entries is 1/${n} of a full position, ${money(whole)}`, money(why.wanted)));
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
    return k > 0 && this.bars.t[k - 1] === read ? `. The rule read a close of ${price(this.bars.c[k - 1])}` : '';
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
        rows.push(row(`Long and short positions together can be at most ${share(margin.cap)} of equity. Thus the ${order} was cut to fit this limit${withCharges}`, money(b.spent)));
      } else if (b.cash >= b.wanted * (1 - 1e-9)) rows.push(row(`The ${onTop} ${onTop === 'commission' ? 'is' : 'are'} added to the money put in. Thus the ${money(b.cash)} in cash was sufficient for`, money(b.spent)));
      else rows.push(row(`Only ${money(b.cash)} was in cash. Thus the ${what} was cut to fit this cash${withCharges}`, money(b.spent)));
    }
    const extra = [fee > 0 ? `${money(fee)} costs` : '', comm > 0 ? `${money(comm)} commission` : ''].filter(Boolean);
    if (this.short) rows.push(row('Money received', `${money(b.spent)}${extra.length ? ` less ${extra.join(' and ')}` : ''}, for ${shareCount(b.shares)} shares sold short`));
    else rows.push(row('Money put in', `${money(b.spent)}${extra.length ? ` plus ${extra.join(' and ')}` : ''}, for ${shareCount(b.shares)} shares`));
    return rows;
  }

  /** An entry after the first: the add rule at its close, the size of the step, the fill, and where the levels moved. */
  private added(add: AddWhy, j: number): Row[] {
    const { trade, bt } = this;
    const spec = bt.spec;
    const n = spec.entries ?? 1;
    const entry = this.entries[j + 1];
    const rows: Row[] = [row(`The run read the add rule at ${this.closeOf(add.signalT)}.`)];
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
    const whole = spec.sizing.k === 'risk' ? 'A full position by risk per trade, with its weight as the limit' : `A full position, ${share(add.weight)} of that`;
    rows.push(row(whole, money(add.full)));
    rows.push(row(`One entry is 1/${n} of it`, money(add.full / n)));
    if (add.wanted < (add.full / n) * (1 - 1e-9)) {
      rows.push(row(`The value of the position was ${money(add.held)}. Thus the entry was cut to keep the position at or below a full position`, money(add.wanted)));
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

  /** Where a stop sits from the price it is measured from, then a target: below and above for a long, above and below for a short. */
  private get ways(): ['below' | 'above', 'below' | 'above'] {
    return this.short ? ['above', 'below'] : ['below', 'above'];
  }

  /** A stop's or target's distance from a price, as set at the first entry. */
  private distance(s: StopLevel, way: 'below' | 'above', from: string): string {
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
    return read === filled ? `, the close the ${by} read` : ` (the ${by} read ${this.closeOf(read)})`;
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
      rows.push(row(`The run read the ${other} rule at ${this.closeOf(exit.t)}. This rule closes a ${side} position.`));
      const e = this.short ? rules.buy : rules.short;
      const w = written?.[other];
      if (e && w) {
        const rule = this.rule(`${other} when`, e, w, barAt(this.bars.t, exit.t), null);
        this.facts.sellRule = rule.result;
        rows.push(...rule.rows);
      }
      if (flipped(trade, this.bt.run.trades)) rows.push(row(`Thus the position flipped: a ${this.short ? 'long' : 'short'} position opened at the same fill.`));
    } else if (exit.k === 'rule') {
      const name = this.short ? 'cover' : 'sell';
      this.facts.sellT = exit.t;
      rows.push(row(`The run read the ${name} rule at ${this.closeOf(exit.t)}.`));
      const w = written?.[name];
      const e = this.short ? rules.cover : rules.sell;
      if (e && w) {
        const rule = this.rule(`${name} when`, e, w, barAt(this.bars.t, exit.t), this.position());
        this.facts.sellRule = rule.result;
        rows.push(...rule.rows);
      }
    } else if (exit.k === 'rank') {
      rows.push(row(`The ranking at ${this.closeOf(exit.rank.decision.t)}:`));
      rows.push(...this.ranking(exit.rank));
    } else if (exit.k === 'margin') {
      // Even with fill: close, a margin call closes at the next open.
      const level = this.bt.spec.margin?.maintenance ?? 0;
      rows.push(
        row(
          `A margin call occurred at ${this.closeOf(exit.t)}. The equity was below ${share(level)} of the value of all long and short positions. Thus all positions closed at the next open.`,
          `${money(exit.equity)} compared with ${money(exit.gross)}, ${share(exit.equity / exit.gross)}`,
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
      rows.push(row(`The equity decreased to ${money(exit.equity)} ${when}. Thus all positions closed there and the run stopped.`));
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
    const distance = (s: StopLevel, from: string, way: 'below' | 'above') => this.distance(s, way, from);
    const fill = this.entries.length > 1 ? `the ${price(trade.entryPrice)} average entry price of the ${this.entries.length} entries` : `the ${price(trade.entryPrice)} fill`;
    const rows: Row[] = [];
    // With magnify: the smaller bar the level was reached in, its open, high and low on the bar's scale, and its words.
    const size = this.bt.spec.magnify;
    const inside = exit.inside;
    const seen = inside?.k === 'inside' ? { ...this.smallBar(j, inside.t), at: this.smallTime(inside.t) } : null;
    const [so, sh, sl] = seen ? [seen.o, seen.h, seen.l] : [o, h, l];
    const smaller = seen ? `the ${size} bar that starts at ${seen.at}` : '';
    /** Why a bar with both levels inside it was read whole, so the stop came first. */
    const whole = inside?.k === 'whole' ? { none: `There are no ${size} bars for this bar`, missing: `Some ${size} bars of this bar are missing`, mismatch: `The ${size} bars of this bar do not agree with it` }[inside.why] : null;
    // A short's prices move the other way: its target is below the fill and its stop above, `k` turns one into the other.
    const k = this.s;
    const short = this.short;
    const past = (a: number, b: number) => k * a > k * b;
    const best = (high: number, low: number) => (short ? low : high);
    const worst = (high: number, low: number) => (short ? high : low);
    const [beyond, behind] = short ? ['below', 'above'] : ['above', 'below'];
    const [toward, against] = short ? ['decreased to', 'increased to'] : ['increased to', 'decreased to'];
    const [under, over] = this.ways;
    const done = short ? 'it was covered' : 'it sold';
    let level: number;
    if (trade.reason === 'take profit') {
      const s = stops.takeProfit!;
      level = s.k === 'pct' ? trade.entryPrice * (1 + k * s.v) : trade.entryPrice + k * s.mult * atr(s);
      rows.push(row(`Take profit at ${price(level)}`, distance(s, fill, over)));
      if (seen && past(so, level)) rows.push(row(`On ${this.date(trade.exitT)}, ${smaller} opened at ${price(so)}, ${beyond} the target. Thus ${done} at that open.`));
      else if (seen) rows.push(row(`On ${this.date(trade.exitT)}, in ${smaller}, the price ${toward} ${price(best(sh, sl))}, through the target. Thus ${done} at the target.`));
      else if (past(o, level)) rows.push(row(`On ${this.date(trade.exitT)}, the bar opened at ${price(o)}, ${beyond} the target. Thus ${done} at the open.`));
      else rows.push(row(`On ${this.date(trade.exitT)}, the price ${toward} ${price(best(h, l))}, through the target. Thus ${done} at the target.`));
      const stopIn = why.stopLoss !== null && k * worst(h, l) <= k * why.stopLoss;
      if (seen && stopIn) rows.push(row(`The stop at ${price(why.stopLoss!)} was also in this bar. Its ${size} bars show that the price touched the target first.`));
      else if (past(o, level) && stopIn) rows.push(row(`Then the price also ${short ? 'increased' : 'decreased'} through the stop at ${price(why.stopLoss!)}, but the open came first.`));
      else if (whole) rows.push(row(`${whole}. Thus the run did not examine this bar with smaller bars.`));
    } else {
      if (trade.reason === 'trailing stop') {
        const s = stops.trailingStop!;
        const high = exit.high!;
        level = s.k === 'pct' ? high * (1 - k * s.v) : high - k * s.mult * atr(s);
        const first = j === barAt(this.bars.t, trade.entryT) + (this.atClose ? 1 : 0);
        const since = this.entries.length > 1 ? 'the first entry' : short ? 'the short sale' : 'the buy';
        const most = short ? 'lowest' : 'highest';
        const highest = seen
          ? `${price(high)}, the ${most} price from ${since} to the previous ${size} bar`
          : first
            ? `${price(high)}, the ${this.atClose ? 'close' : 'open'} it was ${short ? 'sold short' : 'bought'} at`
            : `${price(high)}, the ${most} price from ${since} to the previous bar`;
        rows.push(row(`Trailing stop at ${price(level)}`, distance(s, highest, under)));
        if (why.stopLoss !== null) rows.push(row(`The stop loss, at ${price(why.stopLoss)}, was ${short ? 'higher' : 'lower'}.`));
      } else {
        const s = stops.stopLoss!;
        level = s.k === 'pct' ? trade.entryPrice * (1 - k * s.v) : trade.entryPrice - k * s.mult * atr(s);
        rows.push(row(`Stop loss at ${price(level)}`, distance(s, fill, under)));
      }
      if (seen && past(level, so)) rows.push(row(`On ${this.date(trade.exitT)}, ${smaller} opened at ${price(so)}, ${behind} the stop. Thus ${done} at that open.`));
      else if (seen) rows.push(row(`On ${this.date(trade.exitT)}, in ${smaller}, the price ${against} ${price(worst(sh, sl))}, through the stop. Thus ${done} at the stop.`));
      else if (past(level, o)) rows.push(row(`On ${this.date(trade.exitT)}, the bar opened at ${price(o)}, ${behind} the stop. Thus ${done} at the open.`));
      else rows.push(row(`On ${this.date(trade.exitT)}, the price ${against} ${price(worst(h, l))}, through the stop. Thus ${done} at the stop.`));
      if (why.takeProfit !== null && k * best(h, l) >= k * why.takeProfit) {
        const target = `The take profit at ${price(why.takeProfit)} was also in this bar.`;
        if (seen) rows.push(row(`${target} Its ${size} bars show that the price touched the stop first.`));
        else if (whole) rows.push(row(`${target} ${whole}. Thus the run did not examine this bar with smaller bars, and the stop comes first.`));
        else if (size && past(level, o)) rows.push(row(`${target} The bar opened ${behind} the stop. Thus the stop came first.`));
        else rows.push(row(`${target} When the two levels are in one bar, the stop comes first.`));
      } else if (whole) rows.push(row(`${whole}. Thus the run did not examine this bar with smaller bars.`));
    }
    this.facts.level = level;
    const atOpen = trade.reason === 'take profit' ? past(so, level) : past(level, so);
    const px = atOpen ? so : level;
    this.exitAt(px, true);
    const where = atOpen ? (seen ? `the open of that ${size} bar` : 'the open') : trade.reason === 'take profit' ? 'the target' : 'the stop';
    rows.push(row(`${short ? 'Covered' : 'Sold'} at ${where}`, this.slipped(px, px * (1 - k * this.slip), this.exitSlip)));
    if (this.atClose && j === barAt(this.bars.t, trade.entryT) + 1) rows.push(row(`The ${short ? 'short sale' : 'buy'} filled at a close. Thus its stops applied from the next bar.`));
    return rows;
  }

  /** With magnify: the smaller bar starting at `t` inside the ticker's bar `j`, on the bar's own scale, as the run walked it. */
  private smallBar(j: number, t: number): { o: number; h: number; l: number } {
    const { spec } = this.bt;
    const asset = this.trade.asset;
    const source = spec.universe.find((a) => a.name === asset)!.source;
    const seen = insideBar(this.bars, j, source, this.bt.data.get(insideKey(asset, spec.magnify!))!, spec.interval, spec.magnify!);
    const k = seen.ok ? seen.path.t.indexOf(t) : -1;
    if (!seen.ok || k < 0) throw new Error(`The ${spec.magnify} bars of ${asset} changed and do not contain the bar of the exit`);
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
    rows.push(row(`The position is open at the end of the run. Its value uses the last close, ${this.date(this.bars.t[j])}.`, price(this.bars.c[j])));
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
      rows.push(row(`A margin call occurred at the last close. The equity was below ${level} of the value of all long and short positions. Thus an order to ${order} waits for the next open.`));
    } else if (pending === closing || pending === flip) {
      rows.push(row(`An order to ${order}${pending === flip ? (this.short ? ' and buy' : ' and sell short') : ''} waits for the ${this.atClose ? 'next close' : 'next open'}.`));
    } else rows.push(row(`There is no order to ${order}.`));
    return rows;
  }

  // ---------------------------------------------------------------- the result

  private result(): Row[] {
    const { trade, why } = this;
    const rows: Row[] = [];
    const open = trade.reason === 'open';
    const short = this.short;
    rows.push(row(open ? 'Return to date, after costs' : 'Return after costs', percent(trade.ret)));
    const r = this.shortReturn;
    if (r) {
      rows.push(
        row(
          'Return of a short: the money received for each share, less the cover cost and borrow fees, divided by the money received',
          `(${price(r.basis)} − ${price(r.cover)} − ${price(r.borrow)}) ÷ ${price(r.basis)}`,
        ),
      );
    }
    rows.push(row(open ? 'Profit to date' : 'Profit', `${trade.pnl > 0 ? '+' : ''}${money(trade.pnl)}`));
    if (short) rows.push(row(open ? 'Borrow fees to date' : 'Borrow fees', `${money(trade.borrow ?? 0)}, part of the profit`));
    rows.push(row('Held', `${ungroupedPlural(trade.bars, 'bar')}, from ${this.date(trade.entryT)} to ${this.date(trade.exitT)}`));
    if (this.entries.length > 1) rows.push(row(`${short ? 'Sold short' : 'Bought'} in ${this.entries.length} of the ${this.bt.spec.entries} entries`, `at ${price(trade.entryPrice)} on average`));
    if (why.fees > 0) {
      const toSell = open ? `. To ${short ? 'cover' : 'sell'} at the last close costs ${money(trade.exitPrice * Math.abs(this.sharesHeld()) * this.cost + (why.commission?.exit ?? 0))} more` : '';
      const ofWhich = why.commission && why.commission.paid > 0 ? ` (${money(why.commission.paid)} commission)` : '';
      rows.push(row(open ? 'Costs paid to date' : 'Costs paid', `${money(why.fees)}${ofWhich}${toSell}`));
    }
    if (why.topUps || why.trims) {
      const [up, down] = short ? ['shorted more', 'covered part of it'] : ['added to it', 'sold part of it'];
      const parts = [why.topUps ? `${up} ${times(why.topUps)}` : '', why.trims ? `${down} ${times(why.trims)}` : ''].filter(Boolean);
      rows.push(row(`The rebalances ${parts.join(' and ')}.`));
    }
    if (open) rows.push(row(short ? 'The return of an open short includes the cost to cover at the last close, without slippage.' : 'The return of an open position includes the cost to sell at the last close, without slippage.'));
    return rows;
  }

  /** Shares held at the end: the open position's. */
  private sharesHeld(): number {
    return this.bt.run.states.find((s) => s.name === this.trade.asset)?.shares ?? 0;
  }
}

function times(n: number): string {
  return n === 1 ? '1 time' : `${n} times`;
}
