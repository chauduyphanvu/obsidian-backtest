import { accountOrders, accountStrategy, borrowedError, errorsBeforeRun, orderSteps, orderText, parseAccount, runAccount, STEP_WORDS, type AccountConfig, type AccountOrder } from './account.ts';
import type { CompareHost } from './compare.ts';
import { priceFailure, type PriceFailure } from './data.ts';
import type { Fill } from './dsl.ts';
import { isFlip, type AssetState } from './engine.ts';
import { DAY, isIntraday as barsIntraday, isoDate, localDate, minus, money, price, shareCount, signedPct, stamp } from './format.ts';
import type { RunOutput } from './runner.ts';
import { fillPhrase, nearest, priceAlone, rulePhrase, type TriggerReport } from './trigger.ts';

/**
 * When an order applies: at the next open (a pending order of a strategy that fills at the next open), at the next
 * close (a pending order of a `fill: close` strategy), or at the last close (what a `fill: close` strategy's rules said
 * to trade at the close that has just passed, which its backtest has already done).
 */
export type OrderTiming = 'next open' | 'next close' | 'last close';

/** The timings in the order they are listed: what is next first, what is already done last. */
export const TIMINGS: readonly OrderTiming[] = ['next open', 'next close', 'last close'];

/** When an order still waiting fills: the next close for a `fill: close` strategy, the next open otherwise. */
export const pendingTiming = (fill?: Fill): OrderTiming => (fill === 'close' ? 'next close' : 'next open');

export const timingPhrase = (when: OrderTiming): string => `at the ${when}`;

const DONE: Record<OrderRow['action'], string> = { buy: 'Bought', sell: 'Sold', short: 'Sold short', cover: 'Bought to cover' };

/**
 * "Buy", "Sell", "Sell short" and "Buy to cover", "Add" for a later entry on either side; "Bought", "Sold", "Sold short",
 * "Bought to cover" and "Added" for an order the backtest has already made.
 */
export function actionWord(o: Pick<OrderRow, 'action' | 'when'> & Pick<Partial<OrderRow>, 'step'>): string {
  const done = o.when === 'last close';
  if ((o.action === 'buy' || o.action === 'short') && o.step && o.step.k > 1) return done ? 'Added' : 'Add';
  return (done ? DONE : STEP_WORDS)[o.action];
}

/** What a strategy that fills at the close needs the reader to know, said once. */
export const CLOSE_FILL_NOTE =
  'A strategy with fill: close gives an order and fills it at the same close. Thus you must send the order immediately before the close. Its orders here are from its rules at the last close.';

/** Said under the orders its backtest has already made. */
export const LAST_CLOSE_NOTE = 'The backtest made these orders at the last close. To make the same trades, you had to send them before that close.';

const DOES = { buy: 'buys', sell: 'sells', add: 'adds', short: 'sells short', cover: 'buys to cover' };
const DID = { buy: 'bought', sell: 'sold', add: 'added', short: 'sold short', cover: 'bought to cover' };

/**
 * How a position's order reads in the positions table: "buys at the next close", "adds at the next open", "bought at the
 * last close", and for a flip both its orders, "sells, then sells short at the next open"; empty for none.
 */
export function positionOrder(st: AssetState, fill?: Fill): string {
  if (st.pending) {
    const flip = isFlip(st);
    return `${flip ? `${DOES[st.side === 'long' ? 'sell' : 'cover']}, then ` : ''}${DOES[st.pending]} ${timingPhrase(st.marginCall ? 'next open' : pendingTiming(fill))}`;
  }
  if (!st.filled) return '';
  const { side, closed } = st.filled;
  return `${closed ? `${DID[side === 'short' ? 'sell' : 'cover']}, then ` : ''}${DID[side]} at the last close`;
}

/** A buy or a short sale opens a position or adds to it; a sell closes a long and a cover a short. A flip is a sell and a short sale, or a cover and a buy. */
export interface OrderRow {
  ticker: string;
  action: 'buy' | 'sell' | 'short' | 'cover';
  when: OrderTiming;
  /** Target share of the strategy's equity for a buy or a short sale; 0 for a sell or a cover. */
  weight: number;
  /** Dollar size at the backtest's current equity: weight × equity for a buy or a short sale, the position's value for a sell or a cover. */
  value: number;
  lastClose: number;
  /** For a sell or a cover: when the position was opened. */
  since: number | null;
  /** For a buy or a short sale of a strategy with `entries` above 1: which entry it is, of how many. */
  step?: { k: number; n: number };
}

export interface HoldingRow {
  ticker: string;
  /** Current value ÷ equity; a short's is the value of the shares owed. */
  weight: number;
  since: number;
  lastClose: number;
  /** Open profit of the position as a fraction, from the open trade. */
  gain: number | null;
  /** Held short. */
  short?: true;
}

/** A close at the next bar that would make a rule give an order (trigger.ts), for the reader to watch. */
export interface WatchRow {
  ticker: string;
  side: 'buy' | 'sell' | 'add' | 'short' | 'cover';
  /** The rule's part in words, such as "Buys if it closes above 512.30 (+1.2%)", and when its order fills, such as "at the following open". */
  phrase: string;
  /** The same without the share of the last close, for a row that shows the distance apart: "Buys if it closes above 512.30". */
  plain?: string;
  when: string;
  /**
   * The ticker whose close it is about (trigger.ts Trigger.driver), its last close, and the signed share of that to the
   * nearest price where the outcome changes (NaN when none was found, or when the driver is a series of values, whose
   * changes are not shares of it).
   */
  driver: string;
  lastClose: number;
  distance: number;
  /** It gives its order at an unchanged close. */
  now: boolean;
}

export interface StrategyStatus {
  /** Vault path of the note. */
  note: string;
  /** The strategy's name, or a fallback such as "Strategy 1" given by the caller. */
  strategy: string;
  /** Time of the last bar the decision is based on. */
  asOf: number;
  /** The strategy's bar size, such as "1d" or "5m". */
  interval: string;
  /** The run's bars are shorter than a day, whatever `interval` says, as a CSV file of minute bars with no `interval:` line has. */
  intraday?: true;
  orders: OrderRow[];
  /** Positions kept: held, with no order. */
  holdings: HoldingRow[];
  equity: number;
  warnings: string[];
  error: string | null;
  /** The strategy has `fill: close`, so its orders are decided and filled at the same close. */
  closeFill: boolean;
  /**
   * Prices are probably out of date: more than `staleDays` calendar days old for daily bars, more than
   * 3 bars old for shorter ones, and more than 2 bars old for bars of a week or longer.
   */
  stale: boolean;
  /** The closes to watch at the next bar, nearest first (watchRows); absent when no trigger prices were worked out. */
  watch?: WatchRow[];
  /** The block's text, kept for a strategy that did not run, so its problem can be fixed from the list. */
  source?: string;
  /** Why the prices of a strategy that did not run could not load, when a next step can put it right (data.ts). */
  failure?: PriceFailure;
  /** The 0-based line of its note that the block opens on, when the scan knew it. */
  line?: number;
}

const STALE_DAYS = 4;
const STALE_BARS = 3;
/** A weekly bar is complete a week after its date, and the next one a week later: two bars old is normal. */
const STALE_LONG_BARS = 2;
const STEP_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: DAY, w: 7 * DAY };

/** The length of a bar such as "5m" or "1d"; a day for anything unrecognised. */
function barMs(interval: string): number {
  const m = interval.match(/^(\d+)([mhdw])$/);
  return m ? Number(m[1]) * STEP_MS[m[2]] : DAY;
}

const isIntraday = (interval: string) => barMs(interval) < DAY;

/** A time of one of the strategy's bars: the date, with the time of day in UTC (as everywhere in the plugin) for intraday bars. */
export function barTime(s: Pick<StrategyStatus, 'interval'>, t: number): string {
  return isIntraday(s.interval) ? `${stamp(t, true)} UTC` : isoDate(t);
}

/** Where a strategy's prices end: "Prices end on 2026-11-13", or "Prices end at 2026-11-13 14:05 UTC" for intraday bars. */
export const pricesEnd = (s: { asOf: number; intraday?: boolean }): string => (s.intraday ? `Prices end at ${stamp(s.asOf, true)} UTC` : `Prices end on ${isoDate(s.asOf)}`);

/** Which bar a decision rests on, such as "close of 2026-11-13". */
export function barLabel(s: Pick<StrategyStatus, 'asOf' | 'interval'>): string {
  if (isIntraday(s.interval)) return `${s.interval} bar from ${barTime(s, s.asOf)}`;
  return s.interval.endsWith('w') ? `weekly bar from ${barTime(s, s.asOf)}` : `close of ${barTime(s, s.asOf)}`;
}

const compare = (a: string, b: string) => a.localeCompare(b, 'en');
/** What closes a position comes first, so the cash and the room to borrow are there for what opens one; an add goes with its side. */
const RANK: Record<OrderRow['action'], number> = { sell: 0, cover: 1, buy: 2, short: 3 };
const rank = (o: OrderRow) => RANK[o.action];
const closes = (o: OrderRow) => o.action === 'sell' || o.action === 'cover';
const byAction = (a: OrderRow, b: OrderRow) => rank(a) - rank(b) || compare(a.ticker, b.ticker);

/** The calendar day of a time on the reader's clock, so "today" means their today. */
function localDay(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY;
}

/** A trigger is worth watching within this share of the last close, and always for a strategy with `fill: close`. */
export const WATCH_WITHIN = 0.02;

/** How near a watch row is, for listing the nearest first: 0 for one that fires at an unchanged close, last for one with no share to go by. */
const nearness = (w: WatchRow) => (w.now ? 0 : Number.isNaN(w.distance) ? Infinity : Math.abs(w.distance));

/**
 * The trigger prices worth watching at the next close: those that give an order at an unchanged close or within
 * WATCH_WITHIN of it, and every one of a strategy that fills at the close, whose orders have to be placed before it.
 * A rule solved for a series of values has no close to be within a share of, so it is watched only in the other two cases.
 */
export function watchRows(report: TriggerReport): WatchRow[] {
  const rows: WatchRow[] = [];
  for (const t of report.triggers) {
    const phrase = rulePhrase(t);
    const near = nearest(t);
    if (t.side === 'rearm' || t.side === 'rearmShort' || phrase === null || near === null) continue;
    if (!report.closeFill && !near.now && (t.values || !(Math.abs(near.distance) <= WATCH_WITHIN))) continue;
    rows.push({
      ticker: t.ticker,
      side: t.side,
      phrase,
      plain: rulePhrase(t, priceAlone) ?? phrase,
      when: fillPhrase(report.closeFill),
      driver: t.driver,
      lastClose: t.last,
      distance: t.values ? NaN : near.distance,
      now: near.now,
    });
  }
  return rows.sort((a, b) => nearness(a) - nearness(b) || compare(a.ticker, b.ticker));
}

/** The last close a row to watch is about, with the ticker named when its rule reads another's: "512.30", "512.30 (SPY)". */
export const watchClose = (row: WatchRow): string => `${minus(price(row.lastClose))}${row.driver === row.ticker ? '' : ` (${row.driver})`}`;

/**
 * What a list of every block (today's orders, the dashboard) offers for a strategy that did not run: the sentence that
 * says how to put it right, and a button that writes a correction into the block (`write`, after which the list runs
 * again) or opens what puts it right, such as the settings (`open`). A sentence alone has neither.
 */
export interface ListFix {
  label?: string;
  text: string;
  write?: () => Promise<void>;
  open?: () => void;
}

/** Every strategy's rows to watch as one list, nearest first. */
export function watchList(list: StrategyStatus[]): { status: StrategyStatus; row: WatchRow }[] {
  return list
    .flatMap((status) => (status.watch ?? []).map((row) => ({ status, row })))
    .sort((a, b) => nearness(a.row) - nearness(b.row) || compare(a.status.note, b.status.note) || compare(a.row.ticker, b.row.ticker));
}

export const WATCH_HEADING = 'Monitor at the next close';
/** The same group in the window, which says its rule in a few words and keeps WATCH_NOTE behind a link at its foot. */
export const WATCH_TITLE = 'Watch at the next close';
export const WATCH_RULE = `closes ${WATCH_WITHIN * 100}% or less from an order`;

/** Said under the closes to watch. */
export const WATCH_NOTE = `The closes at the next bar that make a rule give an order. The plugin calculates them from the rules as they are written. The list shows each close that is ${WATCH_WITHIN * 100}% or less from the last close. It also shows each rule that gives an order if the close does not change, and all closes of a strategy with fill: close. You must send the orders of that strategy before the close.`;

/**
 * Whether a run's prices are probably out of date at `now` (StrategyStatus.stale), and the time of its last bar. The
 * calendar-day rule of daily bars counts the reader's own days, which leaves room for a weekend and a holiday.
 */
export function pricesOld(out: Pick<RunOutput, 'spec' | 'backtest'>, now: number, staleDays = STALE_DAYS): { old: boolean; asOf: number } {
  const { t } = out.backtest.run;
  const { interval } = out.spec;
  const asOf = t[t.length - 1];
  const old = isIntraday(interval)
    ? now - asOf > STALE_BARS * barMs(interval)
    : barMs(interval) >= 7 * DAY
      ? now - asOf > STALE_LONG_BARS * barMs(interval)
      : localDay(now) - Math.floor(asOf / DAY) > staleDays;
  return { old, asOf };
}

export function statusFrom(note: string, strategy: string, out: RunOutput, now: number, staleDays = STALE_DAYS, triggers: TriggerReport | null = null): StrategyStatus {
  const { run } = out.backtest;
  const { interval } = out.spec;
  const closeFill = out.spec.fill === 'close';
  const pending = pendingTiming(out.spec.fill);
  const { old, asOf } = pricesOld(out, now, staleDays);
  const equity = run.equity[run.equity.length - 1];
  const orders: OrderRow[] = [];
  const holdings: HoldingRow[] = [];
  const n = out.spec.entries ?? 1;
  /** A buy's entry: the next one for an order waiting, the latest for one made at the last close. */
  const step = (k: number) => (n > 1 ? { step: { k, n } } : {});
  for (const st of run.states) {
    const before = orders.length;
    const made = st.entries ?? 0;
    const opening = (action: 'buy' | 'short', when: OrderTiming, weight: number, value: number, k: number) =>
      orders.push({ ticker: st.name, action, when, weight, value, lastClose: st.lastClose, since: null, ...step(k) });
    const closing = (action: 'sell' | 'cover', when: OrderTiming, value: number, since: number | null) =>
      orders.push({ ticker: st.name, action, when, weight: 0, value, lastClose: st.lastClose, since });
    // A flip closes the position held and opens the other side: two orders, the first entry of the new position second.
    const flip = isFlip(st);
    // A margin call closes the position at the next open even when the strategy fills at the close.
    if (st.pending === 'sell' || st.pending === 'cover' || flip) closing(st.side === 'short' ? 'cover' : 'sell', st.marginCall ? 'next open' : pending, Math.abs(st.value), st.since);
    if (st.pending === 'buy' || st.pending === 'short' || st.pending === 'add') {
      const action = st.pending === 'short' || (st.pending === 'add' && st.side === 'short') ? 'short' : 'buy';
      opening(action, pending, st.targetWeight, st.targetWeight * equity, flip ? 1 : made + 1);
    }
    if (st.filled) {
      // A whole position bought or sold at the last close, or an entry added to one, valued there; a flip, the position it
      // closed and the one it opened.
      const { side, shares, closed } = st.filled;
      const value = shares * st.lastClose;
      if (side === 'sell' || side === 'cover' || closed) {
        const exited = run.trades.filter((t) => t.asset === st.name && t.reason !== 'open').pop();
        closing(side === 'sell' || side === 'short' ? 'sell' : 'cover', 'last close', closed ? closed * st.lastClose : value, exited?.entryT ?? null);
      }
      if (side !== 'sell' && side !== 'cover') opening(side === 'short' || (side === 'add' && st.side === 'short') ? 'short' : 'buy', 'last close', equity > 0 ? value / equity : 0, value, made);
    }
    if (orders.length === before && st.side !== null) {
      const open = run.trades.find((t) => t.asset === st.name && t.reason === 'open');
      holdings.push({ ticker: st.name, weight: equity > 0 ? Math.abs(st.value) / equity : 0, since: st.since!, lastClose: st.lastClose, gain: open ? open.ret : null, ...(st.side === 'short' ? { short: true as const } : {}) });
    }
  }
  orders.sort(byAction);
  return {
    note,
    strategy,
    asOf,
    interval,
    orders,
    holdings,
    equity,
    warnings: out.warnings,
    error: null,
    closeFill,
    stale: old,
    ...(barsIntraday(run.t) ? { intraday: true as const } : {}),
    ...(triggers ? { watch: watchRows(triggers) } : {}),
  };
}

export function failedStatus(note: string, strategy: string, message: string, source?: string, failure?: PriceFailure | null): StrategyStatus {
  return {
    note,
    strategy,
    asOf: 0,
    interval: '1d',
    orders: [],
    holdings: [],
    equity: 0,
    warnings: [],
    error: message,
    closeFill: false,
    stale: false,
    ...(source === undefined ? {} : { source }),
    ...(failure ? { failure } : {}),
  };
}

/** Strategies with orders first, those with a sell or a cover ahead of the others; then the rest. Each group by note, then name. */
export function sortStatuses(list: StrategyStatus[]): StrategyStatus[] {
  const group = (s: StrategyStatus) => (s.orders.some(closes) ? 0 : s.orders.length ? 1 : 2);
  return list
    .map((s) => ({ ...s, orders: [...s.orders].sort(byAction) }))
    .sort((a, b) => group(a) - group(b) || compare(a.note, b.note) || compare(a.strategy, b.strategy));
}

export interface TodoRow {
  status: StrategyStatus;
  order: OrderRow;
}

/** Every order of every strategy as one list: by timing, then sells and covers first so the cash is there for the buys, then by note and ticker. */
export function todoRows(list: StrategyStatus[]): TodoRow[] {
  const when = (o: OrderRow) => TIMINGS.indexOf(o.when);
  return list
    .flatMap((status) => status.orders.map((order) => ({ status, order })))
    .sort(
      (a, b) =>
        when(a.order) - when(b.order) ||
        rank(a.order) - rank(b.order) ||
        compare(a.status.note, b.status.note) ||
        compare(a.status.strategy, b.status.strategy) ||
        compare(a.order.ticker, b.order.ticker),
    );
}

/** The rows of `todoRows` under one heading for each timing that has any, in the order of `TIMINGS`. */
export function todoGroups(rows: TodoRow[]): { when: OrderTiming; heading: string; rows: TodoRow[] }[] {
  return TIMINGS.map((when) => ({
    when,
    heading: when === 'last close' ? 'Traded at the last close' : `To do at the ${when}`,
    rows: rows.filter((r) => r.order.when === when),
  })).filter((g) => g.rows.length > 0);
}

export interface Basis {
  /** Which bar the orders are based on, such as "Based on the close of 2026-11-13". */
  text: string;
  /** Said when the strategies' last bars differ: that `text` is the oldest. */
  note: string | null;
}

/**
 * The bar the list as a whole rests on. When the strategies with orders end on different bars, the oldest is named,
 * because that is the one to doubt; with no orders anywhere, the oldest of the strategies that ran. Null when none ran.
 */
export function basisOf(list: StrategyStatus[]): Basis | null {
  const ran = list.filter((s) => s.error === null);
  const withOrders = ran.filter((s) => s.orders.length > 0);
  const pool = withOrders.length > 0 ? withOrders : ran;
  if (pool.length === 0) return null;
  const oldest = pool.reduce((a, s) => (s.asOf < a.asOf ? s : a));
  const differ = pool.some((s) => s.asOf !== oldest.asOf);
  return {
    text: `Based on the ${barLabel(oldest)}`,
    note: differ ? (withOrders.length > 0 ? 'This bar is before the bars of the other orders. Each order shows its bar.' : 'This bar is before the last bars of the other strategies.') : null,
  };
}

/** A share of a strategy's money as a percentage, such as "20%" or "33.3%". */
export function share(weight: number): string {
  return `${Number((weight * 100).toFixed(1))}%`;
}

/** The size of an order as a share of the strategy's own money, then in dollars at the backtest's equity; for an entry of several, which one. */
export function orderSize(o: OrderRow): string {
  const dollars = `about ${money(o.value)}`;
  if (closes(o)) return `Full position, ${dollars}`;
  const size = `${share(o.weight)} of the strategy, ${dollars}`;
  return o.step ? `Step ${o.step.k} of ${o.step.n}: ${size}` : size;
}

/** What is wrong with a strategy's result, one message each: a failed run, stale prices, price warnings. */
export function problemsOf(s: StrategyStatus): string[] {
  const out: string[] = [];
  if (s.error !== null) out.push(`The strategy did not run. ${s.error}`);
  if (s.stale) out.push(`${pricesEnd(s)}. Thus this result is possibly out of date.`);
  out.push(...s.warnings);
  return out;
}

const heldText = (h: HoldingRow) => `${h.short ? 'short ' : ''}${h.ticker} ${share(h.weight)}${h.gain === null ? '' : ` (${signedPct(h.gain)})`}`;

/** The wikilink text for a strategy; a table cell needs the alias separator escaped. */
function link(s: Pick<StrategyStatus, 'note' | 'strategy'>, inTable: boolean): string {
  const target = s.note.replace(/\.md$/i, '');
  const name = s.strategy.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim();
  return `[[${target}${inTable ? '\\|' : '|'}${name}]]`;
}

/** The first line of the generated note: how the plugin knows, before it rewrites the note, that it made it. */
export const ORDERS_MARKER = 'backtest_orders';

const FRONT_MATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const MARKER_LINE = new RegExp(`^${ORDERS_MARKER}:[ \\t]*true[ \\t]*$`);

/** What saving today's orders does to the configured note, given its current text (null when it does not exist). */
export function ordersSavePlan(existing: string | null): 'create' | 'replace' | 'refuse' {
  if (existing === null) return 'create';
  const front = existing.match(FRONT_MATTER);
  const ours = front !== null && front[1].split(/\r?\n/).some((line) => MARKER_LINE.test(line));
  return ours ? 'replace' : 'refuse';
}

/** When the list in the pane was worked out, in local time: "Last check: 14:05", with the date first when that was not today. */
export function lastCheckText(at: number, now: number): string {
  const d = new Date(at);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `Last check: ${localDate(at) === localDate(now) ? time : `${localDate(at)} ${time}`}`;
}

export const notOurNoteMessage = (path: string): string => `The note ${path} is in the vault, but Backtest Blocks did not make it. Select a different note in the settings.`;

/** What saving did: wrote the note, left an existing note of the reader's alone, or had no note to write. */
export type SaveOutcome = { kind: 'saved' | 'refused'; path: string } | { kind: 'none' };

/** Runs `fn` over the items, at most `limit` at a time; results come back in the order of the items. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Strategies run side by side when today's orders are worked out. */
const ORDERS_CONCURRENCY = 3;

/** What a scan of the vault for today's orders needs from the plugin. */
export interface ScanHost {
  /** Drops the kept results, so every strategy runs again. */
  clear(): void;
  /** Every strategy block in the vault, with the line each opens on when known. */
  find(): Promise<{ note: string; name: string; source: string; line?: number }[]>;
  /** Runs a block's text (Results.runSource). */
  run(source: string, opts: { freshForMs?: number; background: boolean }): Promise<RunOutput>;
  /** The trigger prices of a result `run` gave (Results.triggers); absent, or null for a result, when there are none. */
  triggers?(out: RunOutput): Promise<TriggerReport | null> | null;
}

/** Every strategy in the vault, run and read as today's orders. `force` refetches every price once. */
export async function scanOrders(host: ScanHost, force: boolean, onProgress: (done: number, total: number) => void): Promise<StrategyStatus[]> {
  const started = Date.now();
  // Results are dropped so every strategy runs again. A price fetched since the scan began is fresh for the strategies
  // that come after, so each ticker is downloaded once however many strategies use it.
  if (force) host.clear();
  const found = await host.find();
  let done = 0;
  onProgress(0, found.length);
  return mapLimit(found, ORDERS_CONCURRENCY, async (f) => {
    let status: StrategyStatus;
    try {
      const freshForMs = force ? Date.now() - started : undefined;
      const out = await host.run(f.source, { freshForMs, background: true });
      // A strategy is listed without its closes to watch when those could not be worked out.
      const triggers = (await host.triggers?.(out)?.catch(() => null)) ?? null;
      status = statusFrom(f.note, f.name, out, Date.now(), undefined, triggers);
    } catch (e) {
      status = failedStatus(f.note, f.name, e instanceof Error ? e.message : String(e), f.source, priceFailure(e));
    }
    onProgress(++done, found.length);
    return f.line === undefined ? status : { ...status, line: f.line };
  });
}

// --- Accounts ---------------------------------------------------------------------------------------------------------

/** One `account` block's orders: what the account trades at the next open to hold what its strategies hold together. */
export interface AccountStatus {
  note: string;
  /** The block's `name:`, else its note's name. */
  name: string;
  /** Its orders with shares to trade, sales first. */
  orders: AccountOrder[];
  /** The latest of its strategies' last bars; null when they did not run. */
  asOf: number | null;
  error: string | null;
  /** The 0-based line of its note that the block opens on, when the scan knew it. */
  line?: number;
}

/** What the scan of the vault's accounts needs from the plugin. */
export interface AccountScanHost {
  /** Every `account` block in the vault, with the line each opens on when known. */
  find(): Promise<{ note: string; name: string; source: string; line?: number }[]>;
  /** How the block in `note` finds and runs the strategies it lists; runs already kept are reused. */
  strategies(note: string): CompareHost<{ basename: string }>;
  /** Optional event-sourced `fills.jsonl` projection overriding static holdings & cash for `accountName`. */
  project?(accountName: string, config: AccountConfig): Promise<AccountConfig>;
}

export const ACCOUNTS_HEADING = 'Accounts';
export const ACCOUNTS_NOTE =
  'What each account block trades at the next open, in shares. The plugin adds the orders of its strategies together at the size of the account. Each holding changes to the positions of the strategies. The block shows the source of each order.';

/** Every account block in the vault, its strategies run (from the kept results where the strategies were just run) and netted into orders. */
export async function scanAccounts(host: AccountScanHost): Promise<AccountStatus[]> {
  const found = await host.find();
  return mapLimit(found, ORDERS_CONCURRENCY, async (f) => {
    const status: AccountStatus = { note: f.note, name: f.name, orders: [], asOf: null, error: null, ...(f.line === undefined ? {} : { line: f.line }) };
    const parsed = parseAccount(f.source);
    const { config, entries } = parsed;
    const errors = errorsBeforeRun(parsed);
    if (errors.length) return { ...status, error: `Line ${errors[0].line}: ${errors[0].message}` };
    try {
      const runs = await runAccount(entries, host.strategies(f.note));
      const borrowed = borrowedError(parsed, runs);
      if (borrowed) return { ...status, error: `Line ${borrowed.line}: ${borrowed.message}` };
      const strategies = runs.map((r) => accountStrategy(r.label, r.alloc, r.out));
      const effectiveConfig = host.project ? await host.project(f.name, config) : config;
      const plan = accountOrders(effectiveConfig, strategies);
      return { ...status, orders: plan.orders.filter((o) => o.shares !== 0), asOf: Math.max(...strategies.map((s) => s.asOf)) };
    } catch (e) {
      return { ...status, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

/** An account's order in words: "Buy 12 shares", "Sell all 30 shares", "Sell short 5 shares", "Flip: sell 50 shares, then sell short 30 shares". */
export function accountOrderText(o: Pick<AccountOrder, 'shares' | 'kind' | 'holding'>): string {
  return orderText(o, (n) => `${shareCount(n)} ${n === 1 ? 'share' : 'shares'}`);
}

/**
 * An account's order as the orders window lists it: the badge ("Buy", "Sell short", "Flip"), its style (a flip's by its
 * direction), and the rest of accountOrderText after the badge's words.
 */
export function accountOrderBadge(o: Pick<AccountOrder, 'shares' | 'kind' | 'holding'>): { action: string; style: OrderRow['action']; text: string } {
  const steps = orderSteps(o);
  const text = accountOrderText(o);
  if (steps.length === 2) return { action: 'Flip', style: o.shares > 0 ? 'buy' : 'sell', text: text.slice('Flip: '.length) };
  const action = STEP_WORDS[steps[0].action];
  return { action, style: steps[0].action, text: text.slice(action.length + 1) };
}

/** Accounts by name, as the window and the note list them. */
export const sortAccounts = (list: AccountStatus[]): AccountStatus[] => [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));

/** A note body for today's orders; the date is the reader's today. */
export function ordersMarkdown(list: StrategyStatus[], now: number, accounts: AccountStatus[] = []): string {
  const lines = ['---', `${ORDERS_MARKER}: true`, '---', '', `# Today's orders, ${localDate(now)}`, ''];
  if (list.length === 0) return [...lines, 'The vault has no strategy blocks.', ''].join('\n');

  const sorted = sortStatuses(list);
  const basis = basisOf(sorted);
  if (basis !== null) lines.push(`${basis.text}. ${basis.note ? `${basis.note} ` : ''}From backtests of your rules on the last prices. The plugin does not send orders.`, '');

  const groups = todoGroups(todoRows(sorted));
  if (groups.length === 0) lines.push('## To do', '', 'No strategy has an order.', '');
  for (const { when, heading, rows } of groups) {
    lines.push(`## ${heading}`, '');
    if (when === 'last close') lines.push(LAST_CLOSE_NOTE, '');
    lines.push('| Strategy | Action | Ticker | Size | Last close | Based on |', '| --- | --- | --- | --- | ---: | --- |');
    for (const { status, order } of rows) {
      const basisCell = barLabel(status).replace(/^./, (c) => c.toUpperCase());
      lines.push(`| ${link(status, true)} | ${actionWord(order)} | ${order.ticker} | ${orderSize(order)} | ${price(order.lastClose)} | ${basisCell} |`);
    }
    lines.push('');
  }

  if (accounts.length) {
    lines.push(`## ${ACCOUNTS_HEADING}`, '', ACCOUNTS_NOTE, '');
    const sortedAccounts = sortAccounts(accounts);
    const trading = sortedAccounts.filter((a) => a.orders.length);
    if (trading.length) {
      lines.push('| Account | Order | Ticker | Last close |', '| --- | --- | --- | ---: |');
      for (const a of trading) for (const o of a.orders) lines.push(`| ${link({ note: a.note, strategy: a.name }, true)} | ${accountOrderText(o)} | ${o.ticker} | ${price(o.price)} |`);
      lines.push('');
    }
    const rest = sortedAccounts.filter((a) => !a.orders.length);
    for (const a of rest) lines.push(`- ${link({ note: a.note, strategy: a.name }, false)}: ${a.error === null ? 'no orders' : `the plugin cannot calculate the orders. ${a.error}`}`);
    if (rest.length) lines.push('');
  }

  const watching = watchList(sorted);
  if (watching.length) {
    lines.push(`## ${WATCH_HEADING}`, '', WATCH_NOTE, '', '| Strategy | Ticker | Trigger | Last close | Based on |', '| --- | --- | --- | ---: | --- |');
    for (const { status, row } of watching) {
      const basisCell = barLabel(status).replace(/^./, (c) => c.toUpperCase());
      lines.push(`| ${link(status, true)} | ${row.ticker} | ${row.phrase}, ${row.when} | ${watchClose(row)} | ${basisCell} |`);
    }
    lines.push('');
  }

  const quiet = sorted.filter((s) => s.error === null && s.orders.length === 0);
  if (quiet.length) {
    lines.push('## No orders', '');
    for (const s of quiet) lines.push(`- ${link(s, false)}: ${s.holdings.length ? `Holds ${s.holdings.map(heldText).join(', ')}` : 'In cash'}`);
    lines.push('');
  }

  const atClose = sorted.filter((s) => s.closeFill);
  if (atClose.length) lines.push('## Strategies that fill at the close', '', CLOSE_FILL_NOTE, '', ...atClose.map((s) => `- ${link(s, false)}`), '');

  const problems = sorted.flatMap((s) => problemsOf(s).map((p) => `- ${link(s, false)}: ${p}`));
  if (problems.length) lines.push('## Problems', '', ...problems, '');
  return lines.join('\n');
}
