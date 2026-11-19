// What the strategy holds now and what the next close could make it do: in words, on a scale of the closes searched with
// the ones that give an order shaded, and for a strategy with several tickers in a table beside each ticker.

import type { Backtest } from './backtest.ts';
import { h } from './dom.ts';
import { pct } from './format.ts';
import { WATCH_WITHIN, positionOrder, watchRows } from './orders.ts';
import { renderPositions } from './render-trades.ts';
import { edgePrices, fillPhrase, rulePhrase, shownPrice, tickerText, watchable, type Trigger, type TriggerReport } from './trigger.ts';

type Side = Trigger['side'];

const VERB: Record<Side, string> = { buy: 'buys', sell: 'sells', add: 'adds', short: 'shorts', cover: 'covers', rearm: 'buys', rearmShort: 'shorts' };
const NOUN: Record<Side, string> = { buy: 'a buy', sell: 'a sell', add: 'an add', short: 'a short sale', cover: 'a cover', rearm: 'a buy', rearmShort: 'a short sale' };

const capital = (text: string) => text[0].toUpperCase() + text.slice(1);

/**
 * The order nearest to being given at the next close, for the line at the top of a result: "0.33% from a sell", "SPY 1.2%
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

export interface NowInput {
  bt: Backtest;
  intraday: boolean;
  /** What it holds, in the words of the folded line: "Long SPY since 2026-04-09". */
  holding: string;
  triggers: Promise<TriggerReport | null> | null;
}

/** The "At the next close" panel. */
export function renderNow(root: HTMLElement, input: NowInput): void {
  const { bt, intraday, triggers } = input;
  const states = bt.run.states;
  const one = states.length === 1 ? states[0] : null;
  const box = h(root, 'div', 'bt-now');
  const head = h(box, 'div', 'bt-now-head');
  // A run that stops at a `to` date has no next close: the panel says what it held at its end.
  h(head, 'span', 'bt-now-title', watchable(bt.spec) ? 'At the next close' : 'At the end of the run');
  const open = one ? bt.run.trades.find((t) => t.asset === one.name && t.reason === 'open') : undefined;
  h(head, 'span', 'bt-now-held', open ? `${input.holding}, ${pct(open.ret)} on this trade` : input.holding);
  const say = h(box, 'div', 'bt-now-say');
  const rulers = h(box, 'div', 'bt-rulers');
  if (!one) renderPositions(box, bt, intraday, triggers);

  // What is already waiting for the next open or close, as the positions table says it.
  const waiting = one ? positionOrder(one, bt.spec.fill) : '';
  const plain = () => {
    say.replaceChildren(waiting ? `${capital(waiting)}.` : one ? '' : 'Refer to the table below for each ticker.');
    say.hidden = !say.textContent;
  };
  if (!triggers) {
    plain();
    return;
  }
  say.textContent = 'The plugin calculates the trigger prices…';
  say.classList.add('bt-now-waiting');
  say.setAttribute('aria-busy', 'true');
  const fill = (report: TriggerReport | null) => {
    say.classList.remove('bt-now-waiting');
    say.removeAttribute('aria-busy');
    if (!report) return plain();
    if (one) {
      const { text, note } = tickerText(report, one.name);
      if (text === '–') plain();
      else {
        say.replaceChildren(text);
        if (note) h(say, 'span', 'bt-now-note', ` ${note}`);
      }
      // A flip gives two orders at the same closes, such as a sell and a short sale: one scale says both.
      const same = new Map<string, Trigger[]>();
      for (const t of report.triggers) {
        if (t.ticker !== one.name) continue;
        const key = JSON.stringify([t.driver, t.range, t.fires]);
        same.set(key, [...(same.get(key) ?? []), t]);
      }
      for (const [first, ...also] of same.values()) ruler(rulers, first, also);
      return;
    }
    // Several tickers: the nearest order in words and on a scale, each ticker's in the table.
    const near = watchRows(report).find((r) => r.now || Math.abs(r.distance) <= WATCH_WITHIN);
    const t = near && report.triggers.find((x) => x.ticker === near.ticker && x.side === near.side);
    if (!near || !t) {
      say.textContent = `No rule is ${pct(WATCH_WITHIN, 0)} or less from an order at the next close.`;
      return;
    }
    say.textContent = `${near.ticker}: ${near.phrase}, ${fillPhrase(report.closeFill)}.`;
    ruler(rulers, t);
  };
  triggers.then(fill, () => fill(null));
}

/**
 * A scale of the closes searched for one rule: the closes that give its order shaded, each edge named with the price
 * the sentence gives, the last close as a dot, and a held ticker's stop and target where they fall on it.
 */
export function ruler(parent: HTMLElement, t: Trigger, also: Trigger[] = []): void {
  const drawn = (x: Trigger) => !x.blocked && x.fires.length > 0 && x.side !== 'rearm' && x.side !== 'rearmShort' && rulePhrase(x) !== null;
  if (!drawn(t)) return;
  const others = also.filter(drawn);
  const { lo, hi } = t.range;
  const span = hi - lo;
  if (!(span > 0)) return;
  const at = (v: number) => Math.min(100, Math.max(0, ((v - lo) / span) * 100));
  const box = h(parent, 'div', 'bt-ruler');
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', [t, ...others].map((x) => `${rulePhrase(x)}.`).join(' '));
  h(box, 'div', 'bt-ruler-track');
  const verb = [t, ...others].map((x) => VERB[x.side]).join(' and ');
  for (const b of t.fires) {
    const [a, z] = [at(b.lo ?? lo), at(b.hi ?? hi)];
    const zone = h(box, 'div', 'bt-ruler-zone');
    zone.style.left = `${a.toFixed(2)}%`;
    zone.style.width = `${Math.max(z - a, 0.4).toFixed(2)}%`;
    // Named at its outer end, away from the last close in the middle.
    const name = h(box, 'div', 'bt-ruler-zone-label', `${verb} here`);
    if (b.lo === null) name.classList.add('bt-ruler-start');
    else if (b.hi === null) name.classList.add('bt-ruler-end');
    else {
      name.style.left = `${((a + z) / 2).toFixed(2)}%`;
      name.classList.add('bt-ruler-mid');
    }
  }
  for (const e of edgePrices(t)) {
    const x = at(e.edge).toFixed(2);
    const tick = h(box, 'div', 'bt-ruler-edge');
    tick.style.left = `${x}%`;
    // Beside its tick on the side where the rule gives no order.
    const label = h(box, 'div', `bt-ruler-price ${e.side === 'hi' ? 'bt-ruler-after' : 'bt-ruler-before'}`, shownPrice(e.shown, t.values));
    label.style.left = `${x}%`;
  }
  if (t.levels && t.driver === t.ticker) {
    for (const [name, v] of [['stop', t.levels.stop], ['target', t.levels.target]] as const) {
      if (v === null || v <= lo || v >= hi) continue;
      const tick = h(box, 'div', 'bt-ruler-level');
      tick.style.left = `${at(v).toFixed(2)}%`;
      tick.title = `${name[0].toUpperCase()}${name.slice(1)} at ${shownPrice(v)}`;
    }
  }
  const dot = h(box, 'div', 'bt-ruler-dot');
  dot.style.left = `${at(t.last).toFixed(2)}%`;
  const last = h(box, 'div', 'bt-ruler-last', `${t.values ? 'last value' : 'last close'} ${shownPrice(t.last, t.values)}`);
  last.style.left = `${at(t.last).toFixed(2)}%`;
}
