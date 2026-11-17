import type { Backtest } from './backtest.ts';
import { h, minus, money, pct, price, signedPct, stamp } from './dom.ts';
import type { Trade } from './engine.ts';
import { explainTrade, type Explanation, type Outcome } from './explain.ts';
import { positionOrder } from './orders.ts';

const MAX_TRADE_ROWS = 500;
const COLUMNS = 9;
/** For unique ids across every result on the page. */
let explained = 0;

export function renderPositions(root: HTMLElement, bt: Backtest, intraday: boolean): void {
  const table = h(h(root, 'div', 'bt-wide'), 'table', 'bt-table');
  const head = h(h(table, 'thead'), 'tr');
  for (const [text, num] of [['Ticker', 0], ['Weight', 1], ['Now', 0], ['Trades', 1], ['Won', 1], ['Average trade', 1]] as const) {
    h(head, 'th', num ? 'bt-num' : undefined, text);
  }
  const body = h(table, 'tbody');
  for (const st of bt.run.states) {
    const closed = bt.run.trades.filter((t) => t.asset === st.name && t.reason !== 'open');
    const row = h(body, 'tr');
    h(row, 'td', undefined, st.name);
    h(row, 'td', 'bt-num', pct(st.weight, 0));
    const now = st.long ? `Long since ${stamp(st.since!, intraday)}` : 'In cash';
    const order = positionOrder(st, bt.spec.fill);
    h(row, 'td', undefined, order ? `${now}, ${order}` : now);
    h(row, 'td', 'bt-num', String(closed.length));
    h(row, 'td', 'bt-num', closed.length ? pct(closed.filter((t) => t.ret > 0).length / closed.length, 0) : '–');
    h(row, 'td', 'bt-num', closed.length ? signedPct(closed.reduce((a, t) => a + t.ret, 0) / closed.length) : '–');
  }
}

export function renderTrades(root: HTMLElement, bt: Backtest, intraday: boolean): void {
  const all: Trade[] = bt.run.trades;
  if (all.length === 0) return;
  const d = h(root, 'details', 'bt-details');
  h(d, 'summary', undefined, `Trades (${all.length})`);
  // Built on first open: a long run can have thousands of rows.
  d.addEventListener(
    'toggle',
    () => {
      const shown = all.slice(-MAX_TRADE_ROWS).reverse();
      if (shown.length < all.length) h(d, 'div', 'bt-note', `Showing the latest ${shown.length} of ${all.length}.`);
      const table = h(h(d, 'div', 'bt-scroll bt-trades'), 'table', 'bt-table');
      const head = h(h(table, 'thead'), 'tr');
      for (const [text, num] of [['Why', 0], ['Ticker', 0], ['Bought', 0], ['At', 1], ['Sold', 0], ['At', 1], ['Return', 1], ['Profit', 1], ['Exit', 0]] as const) {
        h(head, 'th', num ? 'bt-num' : undefined, text);
      }
      const body = h(table, 'tbody');
      for (const t of shown) {
        const row = h(body, 'tr');
        explainButton(h(row, 'td', 'bt-why-cell'), row, bt, t);
        h(row, 'td', undefined, t.asset);
        h(row, 'td', undefined, stamp(t.entryT, intraday));
        h(row, 'td', 'bt-num', price(t.entryPrice));
        h(row, 'td', undefined, t.reason === 'open' ? '–' : stamp(t.exitT, intraday));
        h(row, 'td', 'bt-num', price(t.exitPrice));
        h(row, 'td', 'bt-num', signedPct(t.ret));
        h(row, 'td', 'bt-num', (t.pnl > 0 ? '+' : '') + minus(money(t.pnl)));
        h(row, 'td', undefined, t.reason === 'open' ? 'still held' : t.reason === 'signal' ? 'sell rule' : t.reason);
      }
    },
    { once: true },
  );
}

/** A button that opens the trade's explanation in a row right under it, worked out on the first click. */
function explainButton(cell: HTMLElement, row: HTMLTableRowElement, bt: Backtest, trade: Trade): void {
  const id = `bt-why-${++explained}`;
  const button = h(cell, 'button', 'bt-why');
  button.type = 'button';
  button.setAttribute('aria-label', 'Explain this trade');
  button.title = 'Explain this trade';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', id);
  let open: HTMLTableRowElement | null = null;
  button.addEventListener('click', () => {
    if (open) {
      open.remove();
      open = null;
      button.setAttribute('aria-expanded', 'false');
      return;
    }
    open = document.createElement('tr');
    open.className = 'bt-explain-tr';
    const td = h(open, 'td');
    td.colSpan = COLUMNS;
    const box = h(td, 'div', 'bt-explain');
    box.id = id;
    try {
      renderExplanation(box, explainTrade(bt, trade));
    } catch (e) {
      h(box, 'div', 'bt-warning', `This trade can't be explained: ${e instanceof Error ? e.message : String(e)}`);
    }
    row.after(open);
    button.setAttribute('aria-expanded', 'true');
  });
}

const MARK: Record<Outcome, string> = { yes: '✓ yes', no: '✗ no', unknown: '? unknown' };

/** Draws an explanation: a title, then each section's rows, the parts of a rule indented under it. */
export function renderExplanation(el: HTMLElement, ex: Explanation): void {
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', ex.title);
  h(el, 'div', 'bt-explain-title', ex.title);
  for (const section of ex.sections) {
    if (section.rows.length === 0) continue;
    const box = h(el, 'div', 'bt-explain-section');
    h(box, 'div', 'bt-explain-heading', section.title);
    const list = h(box, 'ul', 'bt-explain-rows');
    for (const r of section.rows) {
      const li = h(list, 'li', `bt-explain-row${r.code ? ' bt-explain-code' : ''}`);
      if (r.depth > 0) li.style.setProperty('--bt-depth', String(r.depth));
      const text = h(li, 'div', 'bt-explain-text');
      h(text, 'span', 'bt-explain-label', r.label);
      if (r.value) h(text, 'span', 'bt-explain-value', r.value);
      if (r.outcome) h(li, 'span', `bt-explain-mark bt-explain-${r.outcome}`, MARK[r.outcome]);
    }
  }
}
