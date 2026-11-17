// "Why did this trade happen?": one trade in plain words and the engine's own numbers. Built on
// demand from the record the engine kept as it decided (Trade.why) and the same Evaluator over the
// same prices, so each value shown is the one the run used. Pure data; render-trades.ts draws it.

import { WARMUP_INPUT, type Backtest } from './backtest.ts';
import { DAY, minus, price, stamp } from './dom.ts';
import { findPos, walk, type CmpOp, type Expr, type StopLevel, type Written } from './dsl.ts';
import { commissionFee, type AddWhy, type ExitReason, type ExitWhy, type RankPlace, type Trade, type TradeEntry, type TradeWhy } from './engine.ts';
import { specEvaluator, type Evaluator, type PosState } from './evaluate.ts';
import * as ind from './indicators.ts';
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

export interface Section {
  /** `add` is an entry after the first, for a position built in steps; there is one for each. */
  id: 'bought' | 'size' | 'add' | 'sold' | 'result';
  title: string;
  rows: Row[];
}

/** The numbers the words rest on, worked out again from the prices and settings, so they can be checked against the trade. */
export interface Facts {
  /** The bar whose close the buy was read at, and the buy rule there; null when there is no buy rule. */
  buyT: number;
  buyRule: Outcome | null;
  /** The fill: the open (or close) of the fill bar with the slippage, and the shares the money bought there. */
  entryPrice: number;
  shares: number;
  reason: ExitReason;
  /** A sell rule's exit: the bar it was read at and the rule's outcome there. */
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

/** Index of the bar at time `t`, or of the latest bar before it. */
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

const outcome = (v: number): Outcome => (v === 1 ? 'yes' : v === 0 ? 'no' : 'unknown');
const row = (label: string, value = '', depth = 0, result: Outcome | null = null, code = false): Row => ({ label, value, outcome: result, depth, code });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** A number with `d` decimals, or none when it is whole. */
function fixed(x: number, d: number): string {
  if (Number.isNaN(x)) return 'unknown';
  if (!Number.isFinite(x)) return x > 0 ? 'infinity' : '−infinity';
  const digits = Number.isInteger(x) ? 0 : d;
  return minus(x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
}

function places(x: number): number {
  const a = Math.abs(x);
  return a >= 1 || a === 0 ? 2 : a >= 0.01 ? 4 : 6;
}

/** Scores with enough decimals that different ones never print the same: each its usual places, plus what it takes. */
function scoreTexts(scores: number[]): string[] {
  const finite = scores.filter(Number.isFinite);
  let extra = 0;
  const key = (x: number) => x.toFixed(Math.min(20, places(x) + extra));
  while (extra < 10 && finite.some((x, i) => finite.some((y, j) => j < i && x !== y && key(x) === key(y)))) extra++;
  return scores.map((x) => fixed(x, places(x) + extra));
}

/** Two values side by side, with enough decimals that different numbers never print the same. */
function pair(a: number, b: number, percent: boolean): [string, string] {
  const f = (x: number, d: number) => (percent && Number.isFinite(x) ? `${fixed(Number((x * 100).toPrecision(12)), d)}%` : fixed(x, d));
  let d = Math.max(places(percent ? a * 100 : a), places(percent ? b * 100 : b));
  while (d < 10 && a !== b && f(a, d) === f(b, d)) d++;
  return [f(a, d), f(b, d)];
}

const money = (x: number) => minus(`${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
/** A share, such as a weight or a stop distance, without trailing zeros: 50%, 33.3%. */
const share = (x: number) => `${minus(Number((x * 100).toPrecision(10)).toLocaleString('en-US', { maximumFractionDigits: 2 }))}%`;
/** A return or a rate, always with two decimals: +6.00%. */
const percent = (x: number) => `${x > 0 ? '+' : ''}${minus((x * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}%`;
const shareCount = (x: number) => minus(x.toLocaleString('en-US', { maximumFractionDigits: 4 }));

const OPS: Record<Exclude<CmpOp, 'xup' | 'xdn'>, string> = { '>': '>', '<': '<', '>=': '≥', '<=': '≤', '==': '=', '!=': '≠' };

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

  constructor(bt: Backtest, trade: Trade, why: TradeWhy) {
    this.bt = bt;
    this.trade = trade;
    this.why = why;
    this.ev = evaluatorFor(bt);
    this.bars = bt.data.get(trade.asset)!;
    this.intraday = bt.run.t.some((t) => t % DAY !== 0);
    this.atClose = bt.spec.fill === 'close';
    this.slip = bt.spec.slippageBps / 10_000;
    this.cost = bt.spec.costBps / 10_000;
    this.facts = { buyT: why.buyT, buyRule: null, entryPrice: NaN, shares: NaN, reason: trade.reason, sellT: null, sellRule: null, level: null, exitPrice: NaN, ret: NaN };
    this.entries = trade.entries ?? [];
    if (trade.entries) this.facts.entries = [];
  }

  build(): Explanation {
    const { trade } = this;
    // In this order: each section fills in the facts the next one uses.
    const n = this.bt.spec.entries ?? 1;
    const sections: Section[] = [
      { id: 'bought', title: 'Why it was bought', rows: this.bought() },
      { id: 'size', title: n > 1 ? `How much: entry 1 of ${n}` : 'How much', rows: this.size() },
      ...(this.why.adds ?? []).map((add, j): Section => ({ id: 'add', title: `Entry ${j + 2} of ${n}`, rows: this.added(add, j) })),
      { id: 'sold', title: trade.reason === 'open' ? 'Why it is still held' : 'Why it was sold', rows: this.sold() },
      { id: 'result', title: 'Result', rows: this.result() },
    ];
    const sold = trade.reason === 'open' ? 'still held' : `sold ${this.date(trade.exitT)} at ${price(trade.exitPrice)}`;
    const bought = this.entries.length > 1 ? `bought in ${this.entries.length} entries from ${this.date(trade.entryT)}, at ${price(trade.entryPrice)} on average` : `bought ${this.date(trade.entryT)} at ${price(trade.entryPrice)}`;
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
      rows.push(row(`The buy rule was read at ${this.closeOf(why.buyT)}.`));
    }
    const rules = bt.spec.rules[trade.asset];
    const written = bt.spec.written?.rules[trade.asset]?.buy ?? null;
    if (written) {
      const rule = this.rule('buy when', rules.buy, written, i, null);
      this.facts.buyRule = rule.result;
      this.facts.entries?.push({ t: trade.entryT, signalT: why.buyT, rule: rule.result, price: NaN, shares: NaN });
      rows.push(...rule.rows);
    } else if (why.rank) {
      rows.push(row('There is no buy rule, so every ticker with a known score could be chosen.'));
      this.facts.entries?.push({ t: trade.entryT, signalT: why.buyT, rule: null, price: NaN, shares: NaN });
    }
    if (why.rank) rows.push(...this.ranking(why.rank));
    rows.push(...this.waits());
    return rows;
  }

  /** What held the buy back, when that is what set its timing. */
  private waits(): Row[] {
    const { why } = this;
    const rows: Row[] = [];
    if (why.warmup) {
      const w = why.warmup;
      const what = why.rank ? `It was chosen from ${this.date(w.fromT)} on` : `The buy rule held from ${this.date(w.fromT)} on`;
      rows.push(row(`${what}, but ${WARMUP_INPUT[w.input](w.n)} was still unknown. A buy waits until the inputs it needs are known, so this was the first close it could buy at.`));
    }
    if (why.rearm) {
      const r = why.rearm;
      const before = this.bt.run.trades.find((t) => t.asset === this.trade.asset && t.exitT === r.exitT && t.reason !== 'open' && t.reason !== 'signal');
      const exit = before ? `the ${before.reason}` : 'the stop';
      rows.push(
        row(
          `After ${exit} on ${this.date(r.exitT)} the buy rule still held, last on ${this.date(r.heldT)}. After a stop or target exit the rule has to stop holding before it can buy again: it did not hold on ${this.date(r.clearedT)}, and held again at the next close.`,
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
      rows.push(row(`Ranked ${ordinal(r.place + 1)} of ${d.eligible} by ${by}. ${verdict}.`, `${by} ${myScore}`));
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
        const [a, b] = pair(at(x.a, i), at(x.b, i), pct);
        let out: string;
        if (x.op === 'xup' || x.op === 'xdn') {
          const up = x.op === 'xup';
          const [va, vb, pa, pb] = [at(x.a, i), at(x.b, i), at(x.a, i - 1), at(x.b, i - 1)];
          const [fa, fb] = pair(pa, pb, pct);
          const now = Number.isNaN(va) || Number.isNaN(vb) ? 'is unknown against' : (up ? va > vb : va < vb) ? (up ? 'is above' : 'is below') : up ? 'is not above' : 'is not below';
          const then = Number.isNaN(pa) || Number.isNaN(pb) ? 'unknown' : (up ? pa <= pb : pa >= pb) ? (up ? 'at or below' : 'at or above') : up ? 'above' : 'below';
          out = `${side(x.a, a)} ${now} ${side(x.b, b)}; the bar before it was ${fa}, ${then} ${fb}`;
        } else {
          out = `${side(x.a, a)} ${OPS[x.op]} ${side(x.b, b)}`;
        }
        const reads = this.reads(x, asset, i);
        return reads ? `${out}; ${reads}` : out;
      }
      if (x.k === 'lag') return `${plural(x.n, 'bar')} earlier${i - x.n >= 0 ? `, on ${this.date(this.bars.t[i - x.n])}` : ''}`;
      return this.reads(x, asset, i);
    };

    const rows: Row[] = [];
    const visit = (x: Expr, depth: number, label: string) => {
      const result = outcome(at(x, i));
      if (x.k === 'logic') {
        const parts: Expr[] = [];
        const flat = (y: Expr): void => {
          if (y.k === 'logic' && y.op === x.op) {
            flat(y.a);
            flat(y.b);
          } else parts.push(y);
        };
        flat(x);
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
        const said = k < 0 ? `${x.asset} had no finished bar yet` : `${x.asset}'s bar of ${this.date(bars.t[k])}`;
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
      if (riskShares * fill > why.weight * why.equity) rows.push(row(`That is more than its weight, so the buy is capped at the weight`, ofThat));
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
      rows.push(row(`Filled at ${this.closeOf(trade.entryT)}${this.readAt(why.buyT, trade.entryT, why.rank ? 'ranking' : 'rule')}`, this.slipped(px, fill, 'plus')));
    } else {
      rows.push(row(`Filled at ${this.openOf(trade.entryT)}`, `${this.slipped(px, fill, 'plus')}${this.readBefore(trade.entryT, why.buyT)}`));
    }
    return rows;
  }

  /** The price filled at the open (or close) of the bar at `t`, before and after slippage. */
  private fillOf(t: number): { px: number; fill: number } {
    const k = barAt(this.bars.t, t);
    const px = this.atClose ? this.bars.c[k] : this.bars.o[k];
    return { px, fill: px * (1 + this.slip) };
  }

  private atFill(t: number): string {
    return this.atClose ? `at ${this.closeOf(t)}` : `at ${this.openOf(t)}`;
  }

  /** After an open fill: the close the rule read, when it is the bar just before. */
  private readBefore(filled: number, read: number): string {
    const k = barAt(this.bars.t, filled);
    return k > 0 && this.bars.t[k - 1] === read ? `; the close the rule read was ${price(this.bars.c[k - 1])}` : '';
  }

  /** What is paid on top of a buy: any cut to the cash there was, then the money put in with its costs and commission. */
  private paid(b: Pick<TradeWhy, 'wanted' | 'spent' | 'cash' | 'shares'>, what: 'buy' | 'add'): Row[] {
    const rows: Row[] = [];
    const commission = this.bt.spec.commission;
    const fee = b.spent * this.cost;
    const comm = commission ? commissionFee(commission, b.spent, b.shares) : 0;
    const charges = [this.cost > 0 ? 'costs' : '', comm > 0 ? 'commission' : ''].filter(Boolean);
    if (b.spent < b.wanted * (1 - 1e-9)) {
      const onTop = charges.join(' and ') || 'costs';
      if (b.cash >= b.wanted * (1 - 1e-9)) rows.push(row(`The ${onTop} ${onTop === 'commission' ? 'is' : 'are'} paid on top, so the ${money(b.cash)} in cash covered`, money(b.spent)));
      else rows.push(row(`Only ${money(b.cash)} was in cash, so the ${what} was cut to what that covers${charges.length ? ` with its ${charges.join(' and ')}` : ''}`, money(b.spent)));
    }
    const extra = [fee > 0 ? `${money(fee)} costs` : '', comm > 0 ? `${money(comm)} commission` : ''].filter(Boolean);
    rows.push(row('Money put in', `${money(b.spent)}${extra.length ? ` plus ${extra.join(' and ')}` : ''}, for ${shareCount(b.shares)} shares`));
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
    if (this.atClose) rows.push(row(`Filled at ${this.closeOf(entry.t)}${this.readAt(add.signalT, entry.t, 'rule')}`, this.slipped(px, fill, 'plus')));
    else rows.push(row(`Filled at ${this.openOf(entry.t)}`, `${this.slipped(px, fill, 'plus')}${this.readBefore(entry.t, add.signalT)}`));
    rows.push(row(`Average entry price of the ${j + 2} entries`, price(add.average)));
    const stops = spec.stops[trade.asset];
    if (add.stopLoss !== null && stops.stopLoss) rows.push(row('The stop loss moved to', `${price(add.stopLoss)}, ${this.distance(stops.stopLoss, 'under', 'the average')}`));
    if (add.takeProfit !== null && stops.takeProfit) rows.push(row('The take profit moved to', `${price(add.takeProfit)}, ${this.distance(stops.takeProfit, 'over', 'the average')}`));
    return rows;
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
    return { entryIdx: barAt(this.bars.t, first.t), entryPrice: made === 1 ? first.price : money / shares, lastPrice: this.entries[made - 1].price, entries: made };
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
    if (exit.k === 'rule') {
      this.facts.sellT = exit.t;
      rows.push(row(`The sell rule was read at ${this.closeOf(exit.t)}.`));
      const written = this.bt.spec.written?.rules[trade.asset]?.sell;
      const sell = this.bt.spec.rules[trade.asset].sell;
      if (sell && written) {
        const rule = this.rule('sell when', sell, written, barAt(this.bars.t, exit.t), this.position());
        this.facts.sellRule = rule.result;
        rows.push(...rule.rows);
      }
    } else {
      rows.push(row(`At the ranking made at ${this.closeOf(exit.rank.decision.t)}:`));
      rows.push(...this.ranking(exit.rank));
    }
    const px = this.atClose ? this.bars.c[j] : this.bars.o[j];
    this.exitAt(px, true);
    const at = this.atClose ? `Sold at ${this.closeOf(trade.exitT)}${this.readAt(exit.t, trade.exitT, exit.k === 'rank' ? 'ranking' : 'rule')}` : `Sold at ${this.openOf(trade.exitT)}`;
    rows.push(row(at, this.slipped(px, px * (1 - this.slip), 'less')));
    return rows;
  }

  /** The position as its sell rule reads it: every entry made. */
  private position(): PosState {
    if (this.entries.length > 1) return this.positionBefore(this.entries.length);
    return { entryIdx: barAt(this.bars.t, this.trade.entryT), entryPrice: this.trade.entryPrice };
  }

  /** The exit at `px`, slipped when `sold`, and the return after costs and commission from the entries' prices. */
  private exitAt(px: number, sold: boolean): void {
    const exitPrice = sold ? px * (1 - this.slip) : px;
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
    if (!c || held === undefined) {
      this.facts.ret = (exitPrice * (1 - this.cost)) / (this.facts.entryPrice * (1 + this.cost)) - 1;
      return;
    }
    const value = sold ? held * px * (1 - this.slip) : held * px;
    const exitFee = commissionFee(c, value, held);
    let entryFees = 0;
    let entryShares = 0;
    for (const e of entries && entries.length > 1 ? entries : [{ price: this.facts.entryPrice, shares: this.facts.shares }]) {
      entryFees += commissionFee(c, e.price * e.shares, e.shares);
      entryShares += e.shares;
    }
    this.facts.ret = (exitPrice * (1 - this.cost) - exitFee / held) / (this.facts.entryPrice * (1 + this.cost) + entryFees / entryShares) - 1;
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
    let level: number;
    if (trade.reason === 'take profit') {
      const s = stops.takeProfit!;
      level = s.k === 'pct' ? trade.entryPrice * (1 + s.v) : trade.entryPrice + s.mult * atr(s);
      rows.push(row(`Take profit at ${price(level)}`, distance(s, fill, 'over')));
      if (o > level) rows.push(row(`On ${this.date(trade.exitT)} the bar opened at ${price(o)}, above the target, so it sold at the open.`));
      else rows.push(row(`On ${this.date(trade.exitT)} the bar reached ${price(h)}, through the target, so it sold at the target.`));
      if (o > level && why.stopLoss !== null && l <= why.stopLoss) rows.push(row(`The bar later fell through the stop at ${price(why.stopLoss)} too, but the open came first.`));
    } else {
      if (trade.reason === 'trailing stop') {
        const s = stops.trailingStop!;
        const high = exit.high!;
        level = s.k === 'pct' ? high * (1 - s.v) : high - s.mult * atr(s);
        const first = j === barAt(this.bars.t, trade.entryT) + (this.atClose ? 1 : 0);
        const since = this.entries.length > 1 ? 'the first entry' : 'the buy';
        const highest = first ? `${price(high)}, the ${this.atClose ? 'close' : 'open'} it was bought at` : `${price(high)}, the highest price from ${since} to the bar before`;
        rows.push(row(`Trailing stop at ${price(level)}`, distance(s, highest, 'under')));
        if (why.stopLoss !== null) rows.push(row(`The stop loss, at ${price(why.stopLoss)}, was lower.`));
      } else {
        const s = stops.stopLoss!;
        level = s.k === 'pct' ? trade.entryPrice * (1 - s.v) : trade.entryPrice - s.mult * atr(s);
        rows.push(row(`Stop loss at ${price(level)}`, distance(s, fill, 'under')));
      }
      if (o < level) rows.push(row(`On ${this.date(trade.exitT)} the bar opened at ${price(o)}, below the stop, so it sold at the open.`));
      else rows.push(row(`On ${this.date(trade.exitT)} the bar fell to ${price(l)}, through the stop, so it sold at the stop.`));
      if (why.takeProfit !== null && h >= why.takeProfit) rows.push(row(`The take profit at ${price(why.takeProfit)} was inside this bar too. When both are, the stop is taken first.`));
    }
    this.facts.level = level;
    const atOpen = trade.reason === 'take profit' ? o > level : o < level;
    const px = atOpen ? o : level;
    this.exitAt(px, true);
    rows.push(row(`Sold at ${atOpen ? 'the open' : trade.reason === 'take profit' ? 'the target' : 'the stop'}`, this.slipped(px, px * (1 - this.slip), 'less')));
    if (this.atClose && j === barAt(this.bars.t, trade.entryT) + 1) rows.push(row('Bought at a close, the position was watched by its stops from the next bar on.'));
    return rows;
  }

  private held(): Row[] {
    const { trade, bt } = this;
    const rows: Row[] = [];
    const j = barAt(this.bars.t, bt.run.t[bt.run.t.length - 1]);
    this.exitAt(this.bars.c[j], false);
    rows.push(row(`Still held at the end of the run. It is valued at the last close, ${this.date(this.bars.t[j])}.`, price(this.bars.c[j])));
    const sell = bt.spec.rules[trade.asset].sell;
    const written = bt.spec.written?.rules[trade.asset]?.sell;
    if (sell && written) {
      rows.push(row(`The sell rule at ${this.closeOf(this.bars.t[j])}:`));
      rows.push(...this.rule('sell when', sell, written, j, this.position()).rows);
    }
    const state = bt.run.states.find((s) => s.name === trade.asset);
    if (state?.pending === 'sell') rows.push(row(`An order to sell it is waiting for the ${this.atClose ? 'next close' : 'next open'}.`));
    else rows.push(row('No order to sell it is waiting.'));
    return rows;
  }

  // ---------------------------------------------------------------- the result

  private result(): Row[] {
    const { trade, why } = this;
    const rows: Row[] = [];
    const open = trade.reason === 'open';
    rows.push(row(open ? 'Return so far, after costs' : 'Return after costs', percent(trade.ret)));
    rows.push(row(open ? 'Profit so far' : 'Profit', `${trade.pnl > 0 ? '+' : ''}${money(trade.pnl)}`));
    rows.push(row('Held', `${plural(trade.bars, 'bar')}, from ${this.date(trade.entryT)} to ${this.date(trade.exitT)}`));
    if (this.entries.length > 1) rows.push(row(`Bought in ${this.entries.length} entries of the ${this.bt.spec.entries} allowed`, `at ${price(trade.entryPrice)} on average`));
    if (why.fees > 0) {
      const toSell = open ? `; selling at the last close would cost ${money(trade.exitPrice * this.sharesHeld() * this.cost + (why.commission?.exit ?? 0))} more` : '';
      const ofWhich = why.commission && why.commission.paid > 0 ? `, of which ${money(why.commission.paid)} commission` : '';
      rows.push(row(open ? 'Costs paid so far' : 'Costs paid', `${money(why.fees)}${ofWhich}${toSell}`));
    }
    if (why.topUps || why.trims) {
      const parts = [why.topUps ? `topped it up ${times(why.topUps)}` : '', why.trims ? `trimmed it ${times(why.trims)}` : ''].filter(Boolean);
      rows.push(row(`Rebalancing ${parts.join(' and ')}.`));
    }
    if (open) rows.push(row('A position still held counts the cost of selling at the last close in its return, without slippage.'));
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
