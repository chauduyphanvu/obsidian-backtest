import { DAY, isoDate, money, price, signedPct } from './dom.ts';
import type { RunOutput } from './runner.ts';

export interface OrderRow {
  ticker: string;
  action: 'buy' | 'sell';
  /** Target share of the strategy's equity for a buy; 0 for a sell. */
  weight: number;
  /** Dollar size at the backtest's current equity: weight × equity for a buy, current value for a sell. */
  value: number;
  lastClose: number;
  /** For a sell: when the position was opened. */
  since: number | null;
}

export interface HoldingRow {
  ticker: string;
  /** Current value ÷ equity. */
  weight: number;
  since: number;
  lastClose: number;
  /** Open profit of the position as a fraction, from the open trade. */
  gain: number | null;
}

export interface StrategyStatus {
  /** Vault path of the note. */
  note: string;
  /** The strategy's name, or a fallback such as "Strategy 1" given by the caller. */
  strategy: string;
  /** Time of the last bar the decision is based on. */
  asOf: number;
  orders: OrderRow[];
  /** Positions kept: held and not being sold. */
  holdings: HoldingRow[];
  equity: number;
  warnings: string[];
  error: string | null;
  /** asOf is more than `staleDays` calendar days before now: prices are probably out of date. */
  stale: boolean;
}

const STALE_DAYS = 4;

const compare = (a: string, b: string) => a.localeCompare(b, 'en');
const rank = (o: OrderRow) => (o.action === 'sell' ? 0 : 1);
const byAction = (a: OrderRow, b: OrderRow) => rank(a) - rank(b) || compare(a.ticker, b.ticker);

/** The calendar day of a time on the reader's clock, so "today" means their today. */
function localDay(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY;
}

function localDate(t: number): string {
  return isoDate(localDay(t) * DAY);
}

export function statusFrom(note: string, strategy: string, out: RunOutput, now: number, staleDays = STALE_DAYS): StrategyStatus {
  const { run } = out.backtest;
  const asOf = run.t[run.t.length - 1];
  const equity = run.equity[run.equity.length - 1];
  const orders: OrderRow[] = [];
  const holdings: HoldingRow[] = [];
  for (const st of run.states) {
    if (st.pending === 'buy') {
      orders.push({ ticker: st.name, action: 'buy', weight: st.targetWeight, value: st.targetWeight * equity, lastClose: st.lastClose, since: null });
    } else if (st.pending === 'sell') {
      orders.push({ ticker: st.name, action: 'sell', weight: 0, value: st.value, lastClose: st.lastClose, since: st.since });
    } else if (st.long) {
      const open = run.trades.find((t) => t.asset === st.name && t.reason === 'open');
      holdings.push({ ticker: st.name, weight: equity > 0 ? st.value / equity : 0, since: st.since!, lastClose: st.lastClose, gain: open ? open.ret : null });
    }
  }
  orders.sort(byAction);
  return {
    note,
    strategy,
    asOf,
    orders,
    holdings,
    equity,
    warnings: out.warnings,
    error: null,
    stale: localDay(now) - Math.floor(asOf / DAY) > staleDays,
  };
}

export function failedStatus(note: string, strategy: string, message: string): StrategyStatus {
  return { note, strategy, asOf: 0, orders: [], holdings: [], equity: 0, warnings: [], error: message, stale: false };
}

/** Strategies with orders first, those with a sell ahead of buy-only ones; then the rest. Each group by note, then name. */
export function sortStatuses(list: StrategyStatus[]): StrategyStatus[] {
  const group = (s: StrategyStatus) => (s.orders.some((o) => o.action === 'sell') ? 0 : s.orders.length ? 1 : 2);
  return list
    .map((s) => ({ ...s, orders: [...s.orders].sort(byAction) }))
    .sort((a, b) => group(a) - group(b) || compare(a.note, b.note) || compare(a.strategy, b.strategy));
}

export interface TodoRow {
  status: StrategyStatus;
  order: OrderRow;
}

/** Every order of every strategy as one list: sells first, so the cash is there for the buys, then by note and ticker. */
export function todoRows(list: StrategyStatus[]): TodoRow[] {
  return list
    .flatMap((status) => status.orders.map((order) => ({ status, order })))
    .sort((a, b) => rank(a.order) - rank(b.order) || compare(a.status.note, b.status.note) || compare(a.status.strategy, b.status.strategy) || compare(a.order.ticker, b.order.ticker));
}

/** The date of the latest prices behind any strategy that ran; null when none did. */
export function latestAsOf(list: StrategyStatus[]): number | null {
  const times = list.filter((s) => s.error === null).map((s) => s.asOf);
  return times.length ? Math.max(...times) : null;
}

/** A share of a strategy's money as a percentage, such as "20%" or "33.3%". */
export function share(weight: number): string {
  return `${Number((weight * 100).toFixed(1))}%`;
}

/** The size of an order as a share of the strategy's own money, then in dollars at the backtest's equity. */
export function orderSize(o: OrderRow): string {
  const dollars = `about ${money(o.value)}`;
  return o.action === 'buy' ? `${share(o.weight)} of the strategy, ${dollars}` : `Whole position, ${dollars}`;
}

/** What is wrong with a strategy's result, one message each: a failed run, stale prices, price warnings. */
export function problemsOf(s: StrategyStatus): string[] {
  const out: string[] = [];
  if (s.error !== null) out.push(`Couldn't run. ${s.error}`);
  if (s.stale) out.push(`Prices end on ${isoDate(s.asOf)}, so this may be out of date.`);
  out.push(...s.warnings);
  return out;
}

const heldText = (h: HoldingRow) => `${h.ticker} ${share(h.weight)}${h.gain === null ? '' : ` (${signedPct(h.gain)})`}`;

/** The wikilink text for a strategy; a table cell needs the alias separator escaped. */
function link(s: StrategyStatus, inTable: boolean): string {
  const target = s.note.replace(/\.md$/i, '');
  const name = s.strategy.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim();
  return `[[${target}${inTable ? '\\|' : '|'}${name}]]`;
}

/** A note body for today's orders; the date is the reader's today. */
export function ordersMarkdown(list: StrategyStatus[], now: number): string {
  const lines = [`# Today's orders, ${localDate(now)}`, ''];
  if (list.length === 0) return [...lines, 'No strategy blocks found.', ''].join('\n');

  const sorted = sortStatuses(list);
  const through = latestAsOf(sorted);
  if (through !== null) lines.push(`Based on prices through ${isoDate(through)}. From backtests of your rules on the latest prices. Nothing here places an order.`, '');

  lines.push('## To do at the next open', '');
  const todo = todoRows(sorted);
  if (todo.length === 0) {
    lines.push('No strategy has an order for the next open.', '');
  } else {
    lines.push('| Strategy | Action | Ticker | Size | Last close |', '| --- | --- | --- | --- | ---: |');
    for (const { status, order } of todo) {
      lines.push(`| ${link(status, true)} | ${order.action === 'buy' ? 'Buy' : 'Sell'} | ${order.ticker} | ${orderSize(order)} | ${price(order.lastClose)} |`);
    }
    lines.push('');
  }

  const quiet = sorted.filter((s) => s.error === null && s.orders.length === 0);
  if (quiet.length) {
    lines.push('## Nothing to do', '');
    for (const s of quiet) lines.push(`- ${link(s, false)}: ${s.holdings.length ? `Holding ${s.holdings.map(heldText).join(', ')}` : 'In cash'}`);
    lines.push('');
  }

  const problems = sorted.flatMap((s) => problemsOf(s).map((p) => `- ${link(s, false)}: ${p}`));
  if (problems.length) lines.push('## Problems', '', ...problems, '');
  return lines.join('\n');
}
