// What the strategy holds now and what the next close could make it do, in the status line at the top of a result: the
// position on the left, the nearest order on the right with how far the close is from it, and a panel that opens under
// the line with the last closes drawn against the price of that order (one ticker) or each ticker's table (several).
// While the prices are old, an amber part above the line says where they end and loads new ones on a click.

import type { Backtest } from './backtest.ts';
import { reveal, revealBox, h, s } from './dom.ts';
import { walk, type Expr, type Spec } from './dsl.ts';
import { specEvaluator } from './evaluate.ts';
import { minus, pct, stamp } from './format.ts';
import { WATCH_WITHIN, watchRows } from './orders.ts';
import { renderPositions } from './render-trades.ts';
import type { RunOutput } from './runner.ts';
import { condition, decisionPhrase, edgePrices, fillPhrase, levelsSentence, nearest, priceAlone, rulePhrase, shownPrice, type Trigger, type TriggerReport } from './trigger.ts';

type Side = Trigger['side'];

const VERB: Record<Side, string> = { buy: 'buys', sell: 'sells', add: 'adds', short: 'shorts', cover: 'covers', rearm: 'buys', rearmShort: 'shorts' };
const NOUN: Record<Side, string> = { buy: 'a buy', sell: 'a sell', add: 'an add', short: 'a short sale', cover: 'a cover', rearm: 'a buy', rearmShort: 'a short sale' };

const capital = (text: string) => text[0].toUpperCase() + text.slice(1);

/** Within this distance an order is close enough that the dot beside the position breathes. */
export const CLOSE_WITHIN = 0.005;

/**
 * The order nearest to being given at the next close, for the folded line of a result: "0.33% from a sell", "SPY 1.2%
 * from a buy", "Sells at an unchanged close". Null when no rule is within WATCH_WITHIN of giving one.
 */
export function watchText(report: TriggerReport, tickers: number): string | null {
  const row = watchRows(report).find((r) => r.now || Math.abs(r.distance) <= WATCH_WITHIN);
  if (!row) return null;
  const who = tickers > 1 ? `${row.ticker} ` : '';
  if (row.now) return `${who}${tickers > 1 ? VERB[row.side] : capital(VERB[row.side])} if the close does not change`;
  const d = Math.abs(row.distance);
  return `${who}${pct(d, d < 0.01 ? 2 : 1)} from ${NOUN[row.side]}`;
}

/**
 * How far the last close is from the price that changes what a rule does: "0.01% away", "1.2% away", "14% away"; for a
 * series of values, the difference: "0.04 away". Two decimals below 1%, so a near order never reads as "0.0%".
 */
export function awayText(distance: number, values?: true): string | null {
  if (!Number.isFinite(distance)) return null;
  const d = Math.abs(distance);
  if (values) return `${shownPrice(d, true)} away`;
  return `${pct(d, d < 0.01 ? 2 : d < 0.1 ? 1 : 0)} away`;
}

/** What the right of the status line says. */
export interface NextOrder {
  /** "Sells if it closes below 730.27", "XLE: sells if it closes below 88.10", "Buys SPY at the next open". */
  text: string;
  /** "0.01% away", or null when no distance applies. */
  away: string | null;
  /** Within WATCH_WITHIN of an order, or an order that an unchanged close gives. */
  near: boolean;
  /** Within CLOSE_WITHIN: the dot breathes. */
  close: boolean;
  /** An order that already waits for the next open or close. */
  due: boolean;
  /** Nothing to watch, said in a quieter colour: "No order is near". */
  quiet: boolean;
  /** The rule the line is about, for the panel under it. */
  trigger: Trigger | null;
}

const said = (text: string, o: Partial<NextOrder> = {}): NextOrder => ({ text, away: null, near: false, close: false, due: false, quiet: true, trigger: null, ...o });

/** A rule whose next close is worth watching: it has a price, and no stop or target acts before it at the next open. */
const watched = (t: Trigger) => t.side !== 'rearm' && t.side !== 'rearmShort' && t.fires.length > 0 && rulePhrase(t) !== null;

/**
 * The order the status line names: one that already waits (`due`, the words of the folded line), else the rule nearest
 * to giving one at the next close, else why there is none to watch.
 */
export function nextOrder(report: TriggerReport | null, out: { backtest: Backtest; spec: Spec }, due: string | null): NextOrder {
  const several = out.backtest.run.states.length > 1;
  if (due && /at the next (open|close)/.test(due)) return said(capital(due), { due: true, quiet: false });
  if (!report) return due ? said(capital(due)) : said('');
  let best: { t: Trigger; d: number; now: boolean } | null = null;
  for (const t of report.triggers) {
    if (!watched(t)) continue;
    const n = nearest(t);
    if (!n) continue;
    const d = Math.abs(n.distance);
    const better = !best || (n.now && !best.now) || (n.now === best.now && (Number.isNaN(best.d) || d < best.d));
    if (better) best = { t, d, now: n.now };
  }
  if (best) {
    const { t, d, now } = best;
    const who = t.driver === t.ticker ? 'it' : t.driver;
    const words = `${VERB[t.side]} ${condition(t, who, priceAlone)}`;
    const near = now || d <= WATCH_WITHIN;
    return {
      text: several ? `${t.ticker}: ${words}` : capital(words),
      away: awayText(nearest(t)!.distance, t.values),
      near,
      close: now || d <= CLOSE_WITHIN,
      due: false,
      quiet: false,
      trigger: t,
    };
  }
  if (due) return said(capital(due));
  if (report.triggers.some((t) => t.blocked === 'ranking')) {
    const when = decisionPhrase(report);
    return said(when ? `The ranking selects again ${when}` : 'Only the ranking buys');
  }
  if (report.triggers.some((t) => t.blocked === 'warmup')) return said('No order is possible at the next close');
  return said(report.triggers.length ? 'No order is near the last close' : '');
}

/**
 * The status line's order alone, to paste somewhere: "SPY: sells if it closes below 730.27 (0.33% away). Prices to
 * 2026-11-18." One ticker's rule is named by its ticker, as several tickers' rules already are.
 */
export function orderLine(order: NextOrder, several: boolean, pricesTo: string): string {
  const t = order.trigger;
  const text = t && !several ? `${t.ticker}: ${order.text[0].toLowerCase()}${order.text.slice(1)}` : order.text;
  return `${text}${order.away ? ` (${order.away})` : ''}. Prices to ${pricesTo}.`;
}

/** What the left of the status line says: the position and, for one ticker held, since when and how it has done. */
export interface Holding {
  /** Long, short, or several tickers with at least one held; null in cash. */
  held: 'long' | 'short' | 'several' | null;
  text: string;
  /** "since 2026-04-09 · +8.6%", or null. */
  more: string | null;
}

interface StatusInput {
  out: RunOutput;
  holding: Holding;
  /** The order that already waits, in the words of the folded line, or null. */
  due: string | null;
  triggers: Promise<TriggerReport | null> | null;
  intraday: boolean;
  /** For a run that stops at a `to` date: the date of its last bar, as it has no next close. */
  ended: string | null;
}

/**
 * The status line and the panel it opens. The left is drawn at once; the right keeps its height while the trigger
 * prices are worked out, so the result under it does not move when they come. `age` says where the prices end while they
 * are old (orders.ts pricesEnd), or null, and changes that part alone; a click on it runs `refresh`.
 */
export function statusView(
  parent: HTMLElement,
  o: { open?: boolean; copy?: Copy; refresh: () => void },
): { show(input: StatusInput): void; open(): boolean; age(end: string | null): void } {
  const box = h(parent, 'div', 'bt-status-box');
  // A button of its own: the line is a button too, and one cannot hold the other.
  const old = h(box, 'button', 'bt-status-old');
  old.type = 'button';
  old.hidden = true;
  h(old, 'span', 'bt-chip-warn');
  const oldText = h(old, 'span', 'bt-status-old-text');
  h(old, 'span', 'bt-status-old-act', 'Click to load new prices.');
  old.addEventListener('click', o.refresh);
  const line = h(box, 'button', 'bt-status');
  line.type = 'button';
  const pos = h(line, 'span', 'bt-status-pos');
  const dot = h(pos, 'span', 'bt-status-dot');
  const posText = h(pos, 'span', 'bt-status-held');
  const posMore = h(pos, 'span', 'bt-status-more-text');
  const next = h(line, 'span', 'bt-status-next');
  const chev = h(line, 'span', 'bt-status-chevron');
  chev.setAttribute('aria-hidden', 'true');
  const svg = s(chev, 'svg', { width: 12, height: 12, viewBox: '0 0 12 12' });
  s(svg, 'path', { d: 'M2.5 4.5l3.5 3.5 3.5-3.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const { box: panel, inner } = revealBox(box, 'bt-status-panel', o.open);
  let opened = o.open ?? false;
  let fill: (() => void) | null = null;
  const sync = () => {
    line.setAttribute('aria-expanded', String(opened));
    if (opened && fill) {
      fill();
      fill = null;
    }
  };
  line.addEventListener('click', () => {
    opened = !opened;
    sync();
    reveal(panel, opened);
  });
  let shown = 0;
  return {
    show(input) {
      const ask = ++shown;
      const { holding } = input;
      posText.textContent = holding.text;
      posMore.textContent = holding.more ?? '';
      posMore.hidden = !holding.more;
      dot.className = `bt-status-dot${holding.held === null ? ' bt-status-cash' : holding.held === 'short' ? ' bt-status-short' : ''}`;
      line.classList.remove('bt-near', 'bt-due');
      next.replaceChildren();
      next.classList.toggle('bt-waiting', !!input.triggers);
      if (input.triggers) h(next, 'span', 'bt-sk bt-status-sk');
      inner.replaceChildren();
      const draw = (report: TriggerReport | null) => {
        if (ask !== shown) return;
        const order = input.ended ? said(`The run ends on ${input.ended}`) : nextOrder(report, input.out, input.due);
        next.classList.remove('bt-waiting');
        next.replaceChildren();
        line.classList.toggle('bt-near', order.near);
        line.classList.toggle('bt-due', order.due);
        dot.classList.toggle('bt-breathe', order.close);
        if (order.text) h(next, 'span', `bt-status-order${order.quiet ? ' bt-quiet' : ''}`, order.text);
        if (order.away) h(next, 'span', 'bt-status-away', order.away);
        fill = () => panelFor(inner, input, report, order, o.copy);
        sync();
        line.setAttribute('aria-label', [holding.text, holding.more, order.text, order.away].filter(Boolean).join('. '));
      };
      if (input.triggers) input.triggers.then(draw, () => draw(null));
      else draw(null);
    },
    open: () => opened,
    age(end) {
      old.hidden = end === null;
      oldText.textContent = end === null ? '' : `${end}. They can be old.`;
      box.classList.toggle('bt-old', end !== null);
      line.classList.toggle('bt-old', end !== null);
    },
  };
}

/** Puts text on the clipboard; `what` names it in the message that says so. */
type Copy = (text: string, what: string) => void;

/**
 * The panel under the status line: for one ticker, the last closes against the order's price and the rule in words; for
 * several, each ticker's row. Under the words, a button copies the order line when there is an order to name.
 */
function panelFor(box: HTMLElement, input: StatusInput, report: TriggerReport | null, order: NextOrder, copy?: Copy): void {
  box.replaceChildren();
  const bt = input.out.backtest;
  const wrap = h(box, 'div', 'bt-status-in');
  const several = bt.run.states.length > 1;
  const copyButton = (parent: HTMLElement) => {
    if (!copy || order.quiet || !order.text) return;
    const line = orderLine(order, several, stamp(bt.run.t[bt.run.t.length - 1], input.intraday));
    const button = h(h(parent, 'div', 'bt-status-copy'), 'button', 'bt-chip-button', 'Copy');
    button.type = 'button';
    button.setAttribute('aria-label', 'Copy the order as text');
    button.addEventListener('click', () => copy(line, 'the order'));
  };
  if (several) {
    renderPositions(wrap, bt, input.intraday, input.triggers);
    copyButton(wrap);
    return;
  }
  const t = order.trigger;
  if (!t || !report) {
    const side = h(wrap, 'div', 'bt-status-side');
    h(side, 'p', 'bt-status-say', order.text ? `${order.text}.` : 'The plugin cannot calculate the price of the next order.');
    copyButton(side);
    return;
  }
  const other = otherSide(input.out, t);
  nextChart(wrap, input.out, t, other);
  const side = h(wrap, 'div', 'bt-status-side');
  const said: string[] = [];
  said.push(t.driver === t.ticker ? `The last close was ${shownPrice(t.last, t.values)}.` : `The last ${t.values ? 'value' : 'close'} of ${t.driver} was ${shownPrice(t.last, t.values)}.`);
  if (other) said.push(`The value of ${other.label} is now ${shownPrice(other.values[other.values.length - 1])}.`);
  const who = t.driver === t.ticker ? 'it' : t.driver;
  said.push(`${capital(VERB[t.side])} ${condition(t, who, priceAlone)}, ${fillPhrase(report.closeFill)}.`);
  const levels = levelsSentence(t);
  if (levels) said.push(levels);
  const p = h(side, 'p', 'bt-status-say', said.join(' '));
  if (t.assumptions.length) h(p, 'span', 'bt-status-note', ` These prices are correct only if ${t.assumptions.length === 1 ? t.assumptions[0] : `${t.assumptions.slice(0, -1).join(', ')} and ${t.assumptions[t.assumptions.length - 1]}`}.`);
  copyButton(side);
}

const RULE_OF: Record<Side, 'buy' | 'sell' | 'add' | 'short' | 'cover' | null> = { buy: 'buy', sell: 'sell', add: 'add', short: 'short', cover: 'cover', rearm: null, rearmShort: null };

/**
 * The other side of the rule behind an order, when the rule is one comparison of the ticker's own close with something in
 * prices, such as `close < sma(200)`: its name as written and its values, aligned with the ticker's bars. Null for any other
 * rule, or for a value nowhere near the close (an RSI, a count), which the closes' scale cannot show.
 */
export function otherSide(out: Pick<RunOutput, 'spec' | 'data'>, t: Trigger): { label: string; values: number[] } | null {
  const kind = RULE_OF[t.side];
  if (!kind || t.driver !== t.ticker || t.values) return null;
  const rule = out.spec.rules[t.ticker]?.[kind] ?? null;
  const written = out.spec.written?.rules[t.ticker]?.[kind] ?? null;
  if (!rule || !written || rule.k !== 'cmp') return null;
  const isClose = (e: Expr) => e.k === 'series' && e.name === 'close';
  const side = isClose(rule.a) ? rule.b : isClose(rule.b) ? rule.a : null;
  if (!side) return null;
  let usable = true;
  walk(side, (e) => {
    if (e.k === 'pos' || e.k === 'cal' || e.k === 'column') usable = false;
  });
  if (!usable) return null;
  const nodes: Expr[] = [];
  walk(rule, (e) => nodes.push(e));
  const label = written.parts[nodes.indexOf(side)]?.trim();
  if (!label) return null;
  try {
    const values = specEvaluator(out.spec as Spec, out.data).eval(side, t.ticker);
    const last = values[values.length - 1];
    if (!Number.isFinite(last) || last < t.last * 0.5 || last > t.last * 2) return null;
    return { label, values };
  } catch {
    return null;
  }
}

/** Bars of history the panel's chart shows. */
const SHOWN_BARS = 30;

/**
 * The last closes of the ticker against the price that gives the order: the closes as a line, the rule's other side as a
 * dotted line when there is one, each price where the order starts as a dashed line, and the closes that give it shaded
 * beside the next bar.
 */
function nextChart(parent: HTMLElement, out: RunOutput, t: Trigger, other: { label: string; values: number[] } | null): void {
  const bars = out.data.get(t.driver);
  if (!bars || bars.c.length < 2) return;
  const closes = bars.c.slice(-SHOWN_BARS);
  const others = other ? other.values.slice(-closes.length) : [];
  const edges = edgePrices(t);
  const width = 360;
  const height = 132;
  const [padL, padR, padT, padB] = [46, 10, 10, 20];
  const known = [...closes, ...others, ...edges.map((e) => e.shown)].filter(Number.isFinite);
  let lo = Math.min(...known);
  let hi = Math.max(...known);
  const pad = (hi - lo) * 0.12 || hi * 0.01 || 1;
  lo -= pad;
  hi += pad;
  const n = closes.length;
  const x = (i: number) => padL + (i / n) * (width - padL - padR);
  const y = (v: number) => padT + ((hi - v) / (hi - lo)) * (height - padT - padB);
  const box = h(parent, 'div', 'bt-next-chart');
  const svg = s(box, 'svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'bt-svg',
    role: 'img',
    'aria-label': `The last ${n} closes of ${t.driver}${other ? ` and ${other.label}` : ''}, against the price of the next order`,
  });
  // The closes that give the order, beside the next bar.
  for (const b of t.fires) {
    const top = y(Math.min(hi, b.hi ?? hi));
    const bottom = y(Math.max(lo, b.lo ?? lo));
    if (bottom - top < 0.5) continue;
    s(svg, 'rect', { class: 'bt-next-zone', x: x(n - 0.5).toFixed(1), y: top.toFixed(1), width: (x(n) - x(n - 0.5) + 4).toFixed(1), height: (bottom - top).toFixed(1) });
  }
  const step = niceGrid(lo, hi);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    s(svg, 'line', { class: 'bt-grid', x1: padL, x2: width - padR, y1: y(v).toFixed(1), y2: y(v).toFixed(1) });
    s(svg, 'text', { class: 'bt-axis', x: padL - 6, y: y(v).toFixed(1), dy: '0.32em', 'text-anchor': 'end' }, step >= 1 ? minus(Math.round(v).toLocaleString('en-US')) : shownPrice(v));
  }
  const path = (vals: number[]) =>
    vals
      .map((v, i) => (Number.isFinite(v) ? `${x(i).toFixed(1)},${y(v).toFixed(1)}` : ''))
      .filter(Boolean)
      .join('L');
  if (others.length > 1) s(svg, 'path', { class: 'bt-next-other', d: `M${path(others)}` });
  s(svg, 'path', { class: 'bt-next-close', d: `M${path(closes)}` });
  for (const e of edges) {
    const ey = y(e.shown).toFixed(1);
    s(svg, 'line', { class: 'bt-next-edge', x1: padL, x2: x(n).toFixed(1), y1: ey, y2: ey });
  }
  const first = edges[0];
  if (first) {
    const word = capital(VERB[t.side]);
    // Said as the sentence says it: "below 730.27" when the order needs a lower close, "at 730.27 or below" when an
    // unchanged close gives it.
    const b = t.fires[0];
    const below = t.fires.length === 1 && b.lo === null;
    const unless = t.fires.length === 1 && ((b.lo === null && b.hi! >= t.last) || (b.hi === null && b.lo! <= t.last));
    const where = unless ? `at ${shownPrice(first.shown)} or ${below ? 'below' : 'above'}` : `${below ? 'below' : 'above'} ${shownPrice(first.shown)}`;
    s(svg, 'text', { class: 'bt-axis bt-next-edge-label', x: padL + 4, y: (y(first.shown) + (below ? 13 : -6)).toFixed(1) }, `${word} ${where}`);
  }
  s(svg, 'circle', { class: 'bt-next-last', cx: x(n - 1).toFixed(1), cy: y(closes[n - 1]).toFixed(1), r: 4 });
  s(svg, 'text', { class: 'bt-axis', x: x(0).toFixed(1), y: height - 4 }, `Last ${n} closes`);
  if (other) s(svg, 'text', { class: 'bt-axis', x: width - padR, y: height - 4, 'text-anchor': 'end' }, `— close · ┈ ${other.label}`);
}

/** A round step for a few grid lines between `lo` and `hi`. */
function niceGrid(lo: number, hi: number): number {
  const raw = (hi - lo) / 3;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
