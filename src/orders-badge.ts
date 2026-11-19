// The count of today's orders in the status bar, worked out quietly after start-up.

import { HOUR } from './format.ts';
import { actionWord, problemsOf, timingPhrase, todoRows, WATCH_HEADING, watchList, type StrategyStatus } from './orders.ts';

export type BadgeState = { kind: 'checking' } | { kind: 'failed'; message: string } | { kind: 'ready'; statuses: StrategyStatus[] };

export interface BadgeView {
  /** What the status bar says; null when there is nothing to say, and the badge is not shown at all. */
  text: string | null;
  /** The longer answer, one line each, shown when the pointer rests on the badge. */
  tooltip: string;
  /** `warning` when some strategy could not run or has old prices; `error` when no answer could be had. */
  mark: 'none' | 'warning' | 'error';
  /** How many orders the orders window lists. */
  orders: number;
}

/** Orders named in the tooltip before "and 3 more". */
const LISTED = 5;
/** Closes to watch named in the tooltip, the nearest first; they are not counted as orders. */
const WATCHED = 3;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const strategies = (n: number) => `${n} ${plural(n, 'strategy', 'strategies')}`;

export const ordersText = (n: number): string => (n === 0 ? 'No orders today' : `${n} ${plural(n, 'order', 'orders')} today`);

/** What is wrong, one line for each kind: a strategy that could not run, old prices, or a warning about the prices. */
function problemLines(list: StrategyStatus[]): string[] {
  const failed = list.filter((s) => s.error !== null).length;
  const old = list.filter((s) => s.error === null && s.stale).length;
  const warned = list.filter((s) => s.error === null && !s.stale && problemsOf(s).length > 0).length;
  return [
    ...(failed > 0 ? [`${strategies(failed)} did not run.`] : []),
    ...(old > 0 ? [`${strategies(old)} ${plural(old, 'has', 'have')} prices that are out of date.`] : []),
    ...(warned > 0 ? [`${strategies(warned)} ${plural(warned, 'has a price warning', 'have price warnings')}.`] : []),
  ];
}

export function badgeView(state: BadgeState): BadgeView {
  if (state.kind === 'checking') return { text: "Today's orders…", tooltip: "The plugin calculates today's orders.", mark: 'none', orders: 0 };
  if (state.kind === 'failed') {
    return { text: 'Cannot calculate orders', tooltip: ['Cannot run the strategies.', state.message, 'Click to open the orders window.'].filter(Boolean).join('\n'), mark: 'error', orders: 0 };
  }

  const list = state.statuses;
  if (list.length === 0) return { text: null, tooltip: '', mark: 'none', orders: 0 };
  const problems = problemLines(list);
  if (list.every((s) => s.error !== null)) {
    return { text: 'Cannot calculate orders', tooltip: [...problems, 'Click to see the problems.'].join('\n'), mark: 'error', orders: 0 };
  }

  const rows = todoRows(list);
  const mark = list.some((s) => problemsOf(s).length > 0) ? 'warning' : 'none';
  const orders = rows.map(({ status, order }) => `${actionWord(order)} ${order.ticker} ${timingPhrase(order.when)}, ${status.strategy}`);
  const more = orders.length - LISTED;
  const watched = watchList(list).slice(0, WATCHED);
  const watch = watched.length ? [`${WATCH_HEADING}:`, ...watched.map(({ status, row }) => `${row.ticker} ${row.phrase[0].toLowerCase()}${row.phrase.slice(1)}, ${status.strategy}`)] : [];
  const lines =
    rows.length === 0
      ? ['No strategy has an order.', ...watch, ...problems, 'Click to see the holdings of each strategy.']
      : [...orders.slice(0, LISTED), ...(more > 0 ? [`and ${more} more`] : []), ...watch, ...problems, 'Click to open the orders window.'];
  return { text: ordersText(rows.length), tooltip: lines.join('\n'), mark, orders: rows.length };
}

export interface BadgeHost {
  /** Runs every strategy in the vault from saved prices where fresh; same as the orders window's scan without forcing. */
  scan(): Promise<StrategyStatus[]>;
  /** Opens the orders window. */
  open(): void;
  /** Shows a short message (Obsidian's Notice). */
  notify(text: string): void;
}

export interface BadgeOptions {
  /** Hours an answer stays current. Read at each look, so a changed setting counts. After that the badge checks again by itself. */
  refreshHours: () => number;
  /** Wait before the first check, so start-up is not slowed. */
  delayMs?: number;
  now?: () => number;
}

/** What the badge uses of the status bar item, which an HTMLElement provides. */
export interface BadgeElement {
  textContent: string | null;
  classList: { add(...tokens: string[]): void; toggle(token: string, force?: boolean): boolean };
  setAttribute(name: string, value: string): void;
  addEventListener(type: 'click' | 'keydown', listener: (e: { key?: string; preventDefault(): void }) => void): void;
}

const readyState = (statuses: StrategyStatus[]): BadgeState => ({ kind: 'ready', statuses });

export const START_DELAY_MS = 5000;
/** How often the badge looks at the clock. A timer of hours would stop while the computer sleeps. */
const LOOK_EVERY_MS = 5 * 60_000;
/** After a check that failed, the next try comes this soon. */
const RETRY_MS = 10 * 60_000;

export class OrdersBadge {
  private el: BadgeElement | null;
  private host: BadgeHost;
  private refreshHours: () => number;
  private delayMs: number;
  private now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  private running = false;
  /** Counts answers that replace what is shown, so the answer of an older check is dropped. */
  private generation = 0;
  /** Counts the times the badge was switched off, so a check that began before does not set a timer after. */
  private epoch = 0;
  private startup = true;
  private lastTry: number | null = null;
  private lastFailed = false;
  /** Whether an answer is on show, so a later check keeps it up instead of saying "Checking". */
  private shown = false;

  /** `el` is the status bar item; null where there is no status bar, as on a phone. */
  constructor(el: BadgeElement | null, host: BadgeHost, opts: BadgeOptions) {
    this.el = el;
    this.host = host;
    this.refreshHours = opts.refreshHours;
    this.delayMs = opts.delayMs ?? START_DELAY_MS;
    this.now = opts.now ?? Date.now;
    if (el === null) return;
    el.classList.add('bt-badge', 'mod-clickable', 'bt-badge-hidden');
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.addEventListener('click', () => host.open());
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      host.open();
    });
  }

  /** Starts checking after a short wait, and again whenever the answer gets old. Works again after `turnOff`. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.lastTry = null;
    this.schedule(this.delayMs);
  }

  /** Shows what the orders window just worked out, so the two agree. While the badge is off it stays hidden. */
  show(list: StrategyStatus[]): void {
    if (!this.started || this.stopped) return;
    this.generation++;
    this.answered(readyState(list));
  }

  /** The badge is switched off in the settings: no more checks, and nothing on show. `start` switches it on again. */
  turnOff(): void {
    this.started = false;
    this.cancel();
    this.shown = false;
    this.paint({ text: null, tooltip: '', mark: 'none', orders: 0 });
  }

  /** Ends the badge's work for good, when the plugin unloads. */
  stop(): void {
    this.stopped = true;
    this.cancel();
  }

  /** No timer, and an answer on its way is dropped. */
  private cancel(): void {
    this.generation++;
    this.epoch++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      // A timer has nowhere to report an error to; a check that fails shows it in the badge.
      void this.tick().catch(() => undefined);
    }, ms);
  }

  private due(): boolean {
    if (this.lastTry === null) return true;
    return this.now() - this.lastTry >= (this.lastFailed ? RETRY_MS : this.refreshHours() * HOUR);
  }

  private async tick(): Promise<void> {
    const mine = this.epoch;
    try {
      if (!this.running && this.due()) await this.check();
    } finally {
      // With no status bar nobody sees a later answer, so only the first check is made. A badge turned off, or off and on
      // again, while this check ran has its own timer.
      if (mine === this.epoch && this.el !== null) this.schedule(LOOK_EVERY_MS);
    }
  }

  private async check(): Promise<void> {
    const startup = this.startup;
    this.startup = false;
    this.running = true;
    const mine = this.generation;
    if (!this.shown) this.paint(badgeView({ kind: 'checking' }));
    let state: BadgeState;
    try {
      state = readyState(await this.host.scan());
    } catch (e) {
      state = { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
    } finally {
      this.running = false;
    }
    if (mine !== this.generation) return;
    const view = this.answered(state);
    if (startup && this.el === null && view.orders > 0 && view.text !== null) this.host.notify(view.text);
  }

  private answered(state: BadgeState): BadgeView {
    const view = badgeView(state);
    this.lastTry = this.now();
    // "Couldn't check orders", whether the check failed or every strategy did, is tried again soon.
    this.lastFailed = view.mark === 'error';
    this.shown = true;
    this.paint(view);
    return view;
  }

  private paint(view: BadgeView): void {
    const el = this.el;
    if (el === null) return;
    el.classList.toggle('bt-badge-hidden', view.text === null);
    el.classList.toggle('bt-badge-warning', view.mark === 'warning');
    el.classList.toggle('bt-badge-error', view.mark === 'error');
    el.textContent = view.text ?? '';
    el.setAttribute('aria-label', view.tooltip);
  }
}
