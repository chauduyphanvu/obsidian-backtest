import type { Backtest } from './backtest.ts';
import { h, LAYOUT_MS, motionOK, onWidth, reveal, revealBox, s } from './dom.ts';
import type { Trade } from './engine.ts';
import { explainTrade, MARK, type Explanation } from './explain.ts';
import { boughtText, hasShorts, positionText, sideText } from './export.ts';
import { minus, money, pct, plural, price, signedPct, stamp } from './format.ts';
import { positionOrder } from './orders.ts';
import { tradeExit } from './price-chart.ts';
import { tabInfo } from './tabs.ts';
import { tickerText, type TriggerReport } from './trigger.ts';
import { tradesSentence } from './verdict.ts';

const MAX_TRADE_ROWS = 500;
/** For unique ids across every result on the page. */
let explained = 0;

/**
 * The positions table. With `triggers`, a "Next close" column says at what close each ticker's rules would give an order;
 * it fills in when they arrive, and says "–" when there are none.
 */
export function renderPositions(root: HTMLElement, bt: Backtest, intraday: boolean, triggers: Promise<TriggerReport | null> | null = null): void {
  const table = h(h(root, 'div', 'bt-wide'), 'table', 'bt-table');
  const head = h(h(table, 'thead'), 'tr');
  const columns = [['Ticker', 0], ['Weight', 1], ['Now', 0], ...(triggers ? [['Next close', 0] as const] : []), ['Trades', 1], ['Won', 1], ['Average trade', 1]] as const;
  for (const [text, num] of columns) h(head, 'th', num ? 'bt-num' : undefined, text);
  const body = h(table, 'tbody');
  const cells = new Map<string, HTMLElement>();
  for (const st of bt.run.states) {
    const closed = bt.run.trades.filter((t) => t.asset === st.name && t.reason !== 'open');
    const row = h(body, 'tr');
    h(row, 'td', undefined, st.name);
    h(row, 'td', 'bt-num', pct(st.weight, 0));
    const now = positionText(st, bt.spec.entries ?? 1, intraday);
    const order = positionOrder(st, bt.spec.fill);
    wordCell(row, order ? `${now}, ${order}` : now);
    if (triggers) {
      const cell = h(row, 'td', 'bt-next-close bt-next-close-waiting', '…');
      cell.setAttribute('aria-busy', 'true');
      cells.set(st.name, cell);
    }
    h(row, 'td', 'bt-num', String(closed.length));
    h(row, 'td', 'bt-num', closed.length ? pct(closed.filter((t) => t.ret > 0).length / closed.length, 0) : '–');
    h(row, 'td', 'bt-num', closed.length ? signedPct(closed.reduce((a, t) => a + t.ret, 0) / closed.length) : '–');
  }
  const fill = (report: TriggerReport | null) => {
    for (const [name, cell] of cells) {
      const { text, note } = report ? tickerText(report, name) : { text: '–', note: null };
      cell.replaceChildren(text);
      if (note) h(cell, 'span', 'bt-next-close-note', note);
      cell.classList.remove('bt-next-close-waiting');
      cell.removeAttribute('aria-busy');
    }
  };
  triggers?.then(fill, () => fill(null));
}

/**
 * The Trades tab: the trades in a sentence, every closed trade's return as a bar from the worst to the best, and the list
 * of trades, latest first. Returns a cleanup function.
 */
export function renderTrades(root: HTMLElement, bt: Backtest, intraday: boolean): () => void {
  const all: Trade[] = bt.run.trades;
  if (all.length === 0) return () => {};
  const closed = all.filter((t) => t.reason !== 'open');
  const d = h(root, 'details', 'bt-details');
  h(d, 'summary', undefined, `Trades (${all.length})`);
  const won = closed.filter((t) => t.ret > 0).length;
  tabInfo(d, 'Trades', closed.length ? `${closed.length.toLocaleString('en-US')} closed · ${pct(won / closed.length, 0)} won` : `${all.length} open`);
  let stop = () => {};
  // Built on first open: a long run can have thousands of rows.
  d.addEventListener(
    'toggle',
    () => {
      const lead = tradesSentence(bt);
      if (lead) h(d, 'p', 'bt-tab-lead', lead);
      const rows = new Map<Trade, HTMLTableRowElement>();
      if (closed.length >= 2) {
        const read = h(d, 'div', 'bt-tab-read');
        const idle = 'The return of each closed trade, from the worst to the best. Move the pointer to a trade to see it. Click a trade to find it in the list.';
        read.textContent = idle;
        const chart = h(d, 'div', 'bt-chart bt-payoff');
        stop = onWidth(chart, (width) => drawPayoff(chart, read, idle, width, closed, intraday, rows));
      }
      const shown = all.slice(-MAX_TRADE_ROWS).reverse();
      if (shown.length < all.length) h(d, 'div', 'bt-note', `The list shows the last ${shown.length} of ${all.length} trades.`);
      const table = h(h(d, 'div', 'bt-scroll bt-trades'), 'table', 'bt-table');
      const head = h(h(table, 'thead'), 'tr');
      // A run that shorts says each trade's side, and its entry and exit are opened and closed rather than bought and sold.
      const sides = hasShorts(all);
      const columns = sides
        ? ([['Why', 0], ['Ticker', 0], ['Side', 0], ['Opened', 0], ['At', 1], ['Closed', 0], ['At', 1], ['Return', 1], ['Profit', 1], ['Exit', 0]] as const)
        : ([['Why', 0], ['Ticker', 0], ['Bought', 0], ['At', 1], ['Sold', 0], ['At', 1], ['Return', 1], ['Profit', 1], ['Exit', 0]] as const);
      for (const [text, num] of columns) h(head, 'th', num ? 'bt-num' : undefined, text);
      const body = h(table, 'tbody');
      for (const t of shown) {
        const row = h(body, 'tr');
        rows.set(t, row);
        explainButton(h(row, 'td', 'bt-why-cell'), row, bt, t, columns.length);
        h(row, 'td', undefined, t.asset);
        if (sides) h(row, 'td', undefined, sideText(t));
        wordCell(row, boughtText(t, intraday));
        h(row, 'td', 'bt-num', price(t.entryPrice));
        if (t.reason === 'open') h(row, 'td', undefined, '–');
        else wordCell(row, stamp(t.exitT, intraday));
        h(row, 'td', 'bt-num', price(t.exitPrice));
        h(row, 'td', 'bt-num', signedPct(t.ret));
        h(row, 'td', 'bt-num', (t.pnl > 0 ? '+' : '') + minus(money(t.pnl)));
        h(row, 'td', undefined, tradeExit(t, all));
      }
    },
    { once: true },
  );
  return () => stop();
}

/** Every closed trade's return as a bar, sorted from the worst to the best: gains up, losses down. */
function drawPayoff(chart: HTMLElement, read: HTMLElement, idle: string, width: number, closed: Trade[], intraday: boolean, rows: Map<Trade, HTMLTableRowElement>): void {
  chart.querySelector('svg')?.remove();
  const sorted = [...closed].sort((a, b) => a.ret - b.ret);
  const n = sorted.length;
  const left = 4;
  const plotW = width - 2 * left;
  const step = plotW / n;
  const gap = step >= 4 ? 1 : 0;
  const top = 6;
  const plotH = Math.round(Math.min(140, Math.max(90, width * 0.18)));
  const height = top + plotH + 22;
  // Sorted, so the ends are the extremes; a spread would pass more trades than a call takes arguments.
  const hi = Math.max(0, sorted[n - 1].ret);
  const lo = Math.min(0, sorted[0].ret);
  const y = (v: number) => top + ((hi - v) / (hi - lo || 1)) * plotH;
  const y0 = y(0);
  const svg = s(chart, 'svg', { width, height, class: 'bt-svg', role: 'img', 'aria-label': `The returns of ${n} closed trades, from the worst to the best` });
  const hl = s(svg, 'rect', { y: top, width: step, height: plotH, class: 'bt-stats-hl', visibility: 'hidden' });
  const bars = { gain: '', loss: '' };
  sorted.forEach((t, i) => {
    const x0 = left + i * step;
    const w = Math.max(step - gap, 0.6);
    const [a, b] = [y(Math.max(t.ret, 0)), y(Math.min(t.ret, 0))];
    const len = Math.max(b - a, 1);
    const top1 = t.ret > 0 ? a : y0;
    bars[t.ret > 0 ? 'gain' : 'loss'] += `M${x0.toFixed(2)},${top1.toFixed(2)}h${w.toFixed(2)}v${len.toFixed(2)}h${(-w).toFixed(2)}Z`;
  });
  if (bars.loss) s(svg, 'path', { d: bars.loss, class: 'bt-payoff-loss' });
  if (bars.gain) s(svg, 'path', { d: bars.gain, class: 'bt-payoff-gain' });
  s(svg, 'line', { x1: left, x2: left + plotW, y1: y0, y2: y0, class: 'bt-baseline' });
  const lost = sorted.filter((t) => t.ret <= 0);
  const won = sorted.filter((t) => t.ret > 0);
  const avg = (list: Trade[]) => list.reduce((a, t) => a + t.ret, 0) / list.length;
  for (const [list, from] of [[lost, 0], [won, lost.length]] as const) {
    if (list.length === 0) continue;
    const w = list.length * step;
    const text = w >= 150 ? `${list.length.toLocaleString('en-US')} ${list === won ? 'won' : 'lost'}, ${signedPct(avg(list))} on average` : w >= 50 ? `${list.length.toLocaleString('en-US')} ${list === won ? 'won' : 'lost'}` : '';
    if (text) s(svg, 'text', { x: left + (from + list.length / 2) * step, y: height - 5, class: 'bt-axis', 'text-anchor': 'middle' }, text);
  }
  const hit = s(svg, 'rect', { x: left, y: 0, width: plotW, height, fill: 'transparent' });
  const at = (clientX: number) => Math.min(n - 1, Math.max(0, Math.floor((clientX - svg.getBoundingClientRect().left - left) / step)));
  const say = (t: Trade) => `${t.asset}${t.side === 'short' ? ', short' : ''} · ${stamp(t.entryT, intraday)} to ${stamp(t.exitT, intraday)} · ${plural(t.bars, 'bar')} · ${signedPct(t.ret)}, ${(t.pnl > 0 ? '+' : '') + minus(money(t.pnl))}`;
  hit.addEventListener('pointermove', (e) => {
    const i = at((e).clientX);
    hl.setAttribute('x', String(left + i * step));
    hl.setAttribute('visibility', 'visible');
    read.textContent = say(sorted[i]);
  });
  hit.addEventListener('pointerleave', () => {
    hl.setAttribute('visibility', 'hidden');
    read.textContent = idle;
  });
  hit.addEventListener('click', (e) => {
    const t = sorted[at((e as MouseEvent).clientX)];
    const row = rows.get(t);
    if (!row) {
      read.textContent = `${say(t)} · not in the list. The list shows only the last ${MAX_TRADE_ROWS} trades.`;
      return;
    }
    row.scrollIntoView?.({ block: 'nearest' });
    row.classList.add('bt-row-flash');
    window.setTimeout(() => row.classList.remove('bt-row-flash'), 1600);
  });
}

/** A cell whose text breaks only at its spaces, so a date in it stays whole: a browser would break it at its hyphens. */
function wordCell(row: HTMLElement, text: string): void {
  const cell = h(row, 'td');
  text.split(' ').forEach((word, i) => {
    if (i > 0) cell.append(' ');
    h(cell, 'span', 'bt-nowrap', word);
  });
}

/** A button that opens the trade's explanation in a row right under it, worked out on the first click. */
function explainButton(cell: HTMLElement, row: HTMLTableRowElement, bt: Backtest, trade: Trade, columns: number): void {
  const id = `bt-why-${++explained}`;
  const button = h(cell, 'button', 'bt-why');
  button.type = 'button';
  button.setAttribute('aria-label', 'Show the reasons for this trade');
  button.title = 'Show the reasons for this trade';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', id);
  let open: { row: HTMLTableRowElement; box: HTMLElement } | null = null;
  button.addEventListener('click', () => {
    // The reasons open and close like the other parts of a result: the space eases, the text fades.
    if (open) {
      const { row: gone, box } = open;
      open = null;
      button.setAttribute('aria-expanded', 'false');
      reveal(box, false);
      if (!motionOK()) gone.remove();
      else window.setTimeout(() => gone.remove(), LAYOUT_MS + 60);
      return;
    }
    const tr = createEl('tr');
    tr.className = 'bt-explain-tr';
    const td = h(tr, 'td');
    td.colSpan = columns;
    const { box, inner } = revealBox(td, 'bt-explain-reveal');
    const explain = h(inner, 'div', 'bt-explain');
    explain.id = id;
    try {
      renderExplanation(explain, explainTrade(bt, trade));
    } catch (e) {
      h(explain, 'div', 'bt-warning', `Cannot show the reasons for this trade: ${e instanceof Error ? e.message : String(e)}`);
    }
    row.after(tr);
    reveal(box, true);
    open = { row: tr, box };
    button.setAttribute('aria-expanded', 'true');
  });
}

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
