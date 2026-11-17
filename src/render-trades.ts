import type { Backtest } from './backtest.ts';
import { h, minus, money, pct, price, signedPct, stamp } from './dom.ts';
import type { Trade } from './engine.ts';

const MAX_TRADE_ROWS = 500;

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
    h(row, 'td', undefined, now + (st.pending ? `, ${st.pending === 'buy' ? 'buys' : 'sells'} at the next open` : ''));
    h(row, 'td', 'bt-num', String(closed.length));
    h(row, 'td', 'bt-num', closed.length ? pct(closed.filter((t) => t.ret > 0).length / closed.length, 0) : '–');
    h(row, 'td', 'bt-num', closed.length ? signedPct(closed.reduce((a, t) => a + t.ret, 0) / closed.length) : '–');
  }
}

export function renderTrades(root: HTMLElement, all: Trade[], intraday: boolean): void {
  if (all.length === 0) return;
  const d = h(root, 'details', 'bt-details');
  h(d, 'summary', undefined, `Trades (${all.length})`);
  // Built on first open: a long run can have thousands of rows.
  d.addEventListener(
    'toggle',
    () => {
      const shown = all.slice(-MAX_TRADE_ROWS).reverse();
      if (shown.length < all.length) h(d, 'div', 'bt-note', `Showing the latest ${shown.length} of ${all.length}.`);
      const table = h(h(d, 'div', 'bt-scroll'), 'table', 'bt-table');
      const head = h(h(table, 'thead'), 'tr');
      for (const [text, num] of [['Ticker', 0], ['Bought', 0], ['At', 1], ['Sold', 0], ['At', 1], ['Return', 1], ['Profit', 1], ['Exit', 0]] as const) {
        h(head, 'th', num ? 'bt-num' : undefined, text);
      }
      const body = h(table, 'tbody');
      for (const t of shown) {
        const row = h(body, 'tr');
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
