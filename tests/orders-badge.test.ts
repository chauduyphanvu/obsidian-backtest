import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { failedStatus, sortStatuses, todoRows, type OrderRow, type StrategyStatus, type WatchRow } from '../src/orders.ts';
import { badgeView, ordersText, OrdersBadge, START_DELAY_MS, type BadgeElement, type BadgeHost } from '../src/orders-badge.ts';
import { DAY, T0 } from './helpers.ts';

// An HTMLElement is what the plugin passes in.
null as unknown as HTMLElement satisfies BadgeElement;

function status(strategy: string, orders: Array<[OrderRow['action'], string, OrderRow['when']?]> = [], more: Partial<StrategyStatus> = {}): StrategyStatus {
  return {
    note: `${strategy}.md`,
    strategy,
    asOf: T0 + 2 * DAY,
    interval: '1d',
    orders: orders.map(([action, ticker, when = 'next open']) => ({ ticker, action, when, weight: action === 'buy' ? 0.5 : 0, value: 100, lastClose: 10, since: null })),
    holdings: [],
    equity: 1000,
    warnings: [],
    error: null,
    closeFill: false,
    stale: false,
    ...more,
  };
}
const ready = (statuses: StrategyStatus[]) => badgeView({ kind: 'ready', statuses });

// ---- the words

test('orders due are counted in words, with one order in the singular', () => {
  assert.equal(ordersText(1), '1 order today');
  assert.equal(ordersText(2), '2 orders today');
  assert.equal(ordersText(0), 'No orders today');
  assert.equal(ready([status('Trend', [['buy', 'TLT']])]).text, '1 order today');
  assert.equal(ready([status('Trend', [['buy', 'TLT'], ['sell', 'SPY']]), status('Pullback')]).text, '2 orders today');
});

test('the tooltip lists the orders in words, sells first', () => {
  const v = ready([status('Trend following', [['buy', 'TLT'], ['sell', 'SPY']]), status('Pullback', [['buy', 'QQQ']])]);
  assert.equal(v.tooltip, ['Sell SPY at the next open, Trend following', 'Buy QQQ at the next open, Pullback', 'Buy TLT at the next open, Trend following', 'Click to open the orders window.'].join('\n'));
  assert.equal(v.mark, 'none');
  assert.equal(v.orders, 3);
});

test('short sales and covers are counted as orders and named in the tooltip, covers with the sells', () => {
  const v = ready([status('Flip', [['short', 'SPY'], ['sell', 'SPY'], ['cover', 'QQQ']]), status('Trend', [['buy', 'TLT']])]);
  assert.deepEqual([v.text, v.orders], ['4 orders today', 4]);
  assert.deepEqual(v.tooltip.split('\n'), ['Sell SPY at the next open, Flip', 'Buy to cover QQQ at the next open, Flip', 'Buy TLT at the next open, Trend', 'Sell short SPY at the next open, Flip', 'Click to open the orders window.']);
  assert.equal(ready([status('Done', [['short', 'SPY', 'last close'], ['cover', 'QQQ', 'last close']])]).tooltip.split('\n').slice(0, 2).join('; '), 'Bought to cover QQQ at the last close, Done; Sold short SPY at the last close, Done');
});

test('the tooltip says Add for a later entry and Buy for the first', () => {
  const base = status('Adding', [['buy', 'QQQ'], ['buy', 'SPY'], ['buy', 'GLD', 'last close'], ['buy', 'TLT', 'last close']]);
  const orders = base.orders.map((o, i) => ({ ...o, step: { k: [1, 2, 2, 1][i], n: 3 } }));
  assert.deepEqual(ready([{ ...base, orders }]).tooltip.split('\n'), [
    'Buy QQQ at the next open, Adding',
    'Add SPY at the next open, Adding',
    'Added GLD at the last close, Adding',
    'Bought TLT at the last close, Adding',
    'Click to open the orders window.',
  ]);
});

test('the tooltip gives each order its own timing, and the count is every order the window lists', () => {
  const list = [
    status('Open', [['buy', 'SPY']]),
    { ...status('Close', [['buy', 'TLT', 'next close'], ['buy', 'GLD', 'last close'], ['sell', 'QQQ', 'last close']]), closeFill: true },
  ];
  const v = ready(list);
  assert.equal(
    v.tooltip,
    ['Buy SPY at the next open, Open', 'Buy TLT at the next close, Close', 'Sold QQQ at the last close, Close', 'Bought GLD at the last close, Close', 'Click to open the orders window.'].join('\n'),
  );
  assert.deepEqual([v.text, v.orders], ['4 orders today', todoRows(list).length]);
});

test('a long list of orders is cut after five', () => {
  const v = ready([status('S', ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((t) => ['buy', t] as [OrderRow['action'], string]))]);
  const lines = v.tooltip.split('\n');
  assert.deepEqual(lines.slice(0, 5), ['A', 'B', 'C', 'D', 'E'].map((t) => `Buy ${t} at the next open, S`));
  assert.equal(lines[5], 'and 2 more');
  assert.equal(v.text, '7 orders today');
});

test('no orders says so and offers the holdings', () => {
  const v = ready([status('Trend'), status('Pullback')]);
  assert.deepEqual([v.text, v.mark, v.orders], ['No orders today', 'none', 0]);
  assert.equal(v.tooltip, 'No strategy has an order.\nClick to see the holdings of each strategy.');
});

test('the three nearest closes to watch follow the orders in the tooltip, and are not counted as orders', () => {
  const watch = (ticker: string, distance: number, now = false): WatchRow => ({ ticker, side: 'buy', phrase: `Buys if it closes above ${ticker}`, when: 'at the open after that close', driver: ticker, lastClose: 10, distance, now });
  const v = ready([
    status('Trend', [['sell', 'SPY']], { watch: [watch('QQQ', 0.015), watch('IWM', -0.019)] }),
    status('Dip', [], { watch: [watch('TLT', 0.004), watch('GLD', 0.05, true)] }),
  ]);
  assert.deepEqual(v.tooltip.split('\n'), [
    'Sell SPY at the next open, Trend',
    'Monitor at the next close:',
    'GLD buys if it closes above GLD, Dip',
    'TLT buys if it closes above TLT, Dip',
    'QQQ buys if it closes above QQQ, Trend',
    'Click to open the orders window.',
  ]);
  assert.deepEqual([v.text, v.orders], ['1 order today', 1]);
  assert.deepEqual(ready([status('Dip', [], { watch: [watch('TLT', 0.004)] })]).tooltip.split('\n'), [
    'No strategy has an order.',
    'Monitor at the next close:',
    'TLT buys if it closes above TLT, Dip',
    'Click to see the holdings of each strategy.',
  ]);
});

test('a vault with no strategies shows nothing at all', () => {
  assert.deepEqual(ready([]), { text: null, tooltip: '', mark: 'none', orders: 0 });
});

test('strategies that could not run or have old prices mark the count and are named in the tooltip', () => {
  const v = ready([
    status('Trend', [['buy', 'TLT']]),
    failedStatus('b.md', 'Broken', 'Yahoo has no prices for XYZ. Check the ticker.'),
    status('Stale one', [], { stale: true }),
    status('Stale two', [['sell', 'GLD']], { stale: true }),
  ]);
  assert.equal(v.text, '2 orders today');
  assert.equal(v.mark, 'warning');
  assert.equal(v.tooltip, ['Sell GLD at the next open, Stale two', 'Buy TLT at the next open, Trend', "1 strategy did not run.", '2 strategies have prices that are out of date.', 'Click to open the orders window.'].join('\n'));
});

test('one strategy with old prices is named in the singular', () => {
  const v = ready([status('A', [], { stale: true }), status('B')]);
  assert.deepEqual([v.text, v.mark], ['No orders today', 'warning']);
  assert.match(v.tooltip, /^No strategy has an order\.\n1 strategy has prices that are out of date\.\n/);
});

test('a warning about the prices marks the count too', () => {
  const v = ready([status('A', [['buy', 'X']], { warnings: ["Couldn't refresh X (HTTP 500); using prices saved on 2020-01-02."] }), status('B', [], { warnings: ['w'] })]);
  assert.equal(v.mark, 'warning');
  assert.match(v.tooltip, /2 strategies have price warnings\./);
  assert.match(ready([status('A', [], { warnings: ['w'] })]).tooltip, /1 strategy has a price warning\./);
});

test('a strategy that failed and has old prices is counted once, as a failure', () => {
  const v = ready([status('A'), { ...failedStatus('b.md', 'B', 'x'), stale: true }]);
  assert.match(v.tooltip, /1 strategy did not run\./);
  assert.doesNotMatch(v.tooltip, /old prices/);
});

test('when no strategy could be checked the badge says so and is marked as an error', () => {
  const v = ready([failedStatus('a.md', 'A', 'x'), failedStatus('b.md', 'B', 'y')]);
  assert.deepEqual([v.text, v.mark, v.orders], ["Cannot calculate orders", 'error', 0]);
  assert.equal(v.tooltip, "2 strategies did not run.\nClick to see the problems.");
});

test('while checking, and when the check itself failed', () => {
  assert.deepEqual(badgeView({ kind: 'checking' }), { text: "Today's orders…", tooltip: "The plugin calculates today's orders.", mark: 'none', orders: 0 });
  const failed = badgeView({ kind: 'failed', message: 'The vault could not be read' });
  assert.deepEqual([failed.text, failed.mark], ["Cannot calculate orders", 'error']);
  assert.equal(failed.tooltip, "Cannot run the strategies.\nThe vault could not be read\nClick to open the orders window.");
  assert.equal(badgeView({ kind: 'failed', message: '' }).tooltip, "Cannot run the strategies.\nClick to open the orders window.");
});

test('the count is always the number of orders the orders window lists', () => {
  const mixes: StrategyStatus[][] = [
    [],
    [status('A')],
    [status('A', [['buy', 'X']]), status('B', [['sell', 'Y'], ['buy', 'Z']]), failedStatus('c.md', 'C', 'x')],
    [status('A', [['buy', 'X']], { stale: true }), status('A', [['buy', 'X']]), status('B', [], { warnings: ['w'] })],
    [failedStatus('a.md', 'A', 'x')],
  ];
  for (const list of mixes) {
    const listed = todoRows(sortStatuses(list)).length;
    assert.equal(ready(list).orders, listed);
    if (list.length > 0 && !list.every((s) => s.error !== null)) assert.equal(ready(list).text, ordersText(listed));
  }
});

// ---- the badge

class FakeEl implements BadgeElement {
  textContent: string | null = '';
  classes = new Set<string>();
  attrs = new Map<string, string>();
  handlers: Record<string, Array<(e: { key?: string; preventDefault(): void }) => void>> = { click: [], keydown: [] };
  classList = {
    add: (...tokens: string[]) => tokens.forEach((t) => this.classes.add(t)),
    toggle: (token: string, force?: boolean) => {
      const on = force ?? !this.classes.has(token);
      if (on) this.classes.add(token);
      else this.classes.delete(token);
      return on;
    },
  };
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  addEventListener(type: 'click' | 'keydown', listener: (e: { key?: string; preventDefault(): void }) => void): void {
    this.handlers[type].push(listener);
  }
  press(key: string): { prevented: boolean } {
    const out = { prevented: false };
    for (const h of this.handlers.keydown) h({ key, preventDefault: () => (out.prevented = true) });
    return out;
  }
  click(): void {
    for (const h of this.handlers.click) h({ preventDefault() {} });
  }
  get hidden(): boolean {
    return this.classes.has('bt-badge-hidden');
  }
}

/** Replaces the timers with ones that only move when told to, and counts the ones waiting. */
let clock = { t: 0, next: 1, timers: new Map<number, { fn: () => void; at: number }>() };
const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
beforeEach(() => {
  clock = { t: 1_000_000, next: 1, timers: new Map() };
  globalThis.setTimeout = ((fn: () => void, ms = 0) => {
    const id = clock.next++;
    clock.timers.set(id, { fn, at: clock.t + ms });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => void clock.timers.delete(id)) as unknown as typeof clearTimeout;
});
afterEach(() => {
  globalThis.setTimeout = real.setTimeout;
  globalThis.clearTimeout = real.clearTimeout;
});
const pending = () => clock.timers.size;
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
/** Moves the clock on, firing every timer that falls due on the way (including ones they set), and lets answers arrive. */
async function advance(ms: number): Promise<void> {
  const end = clock.t + ms;
  for (;;) {
    const due = [...clock.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    clock.timers.delete(due[0]);
    clock.t = Math.max(clock.t, due[1].at);
    due[1].fn();
    await flush();
  }
  clock.t = end;
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

function setup(opts: { el?: FakeEl | null; scan?: () => Promise<StrategyStatus[]>; hours?: () => number } = {}) {
  const log = { scans: 0, opened: 0, notices: [] as string[] };
  const el = opts.el === undefined ? new FakeEl() : opts.el;
  const host: BadgeHost = {
    scan: () => {
      log.scans++;
      return opts.scan ? opts.scan() : Promise.resolve([status('Trend', [['buy', 'TLT']])]);
    },
    open: () => log.opened++,
    notify: (text) => log.notices.push(text),
  };
  const badge = new OrdersBadge(el, host, { refreshHours: opts.hours ?? (() => 6), now: () => clock.t });
  return { badge, el, log };
}

test('the badge is hidden until it has something to say, and does nothing before start', async () => {
  const { el, log } = setup();
  assert.equal(el!.hidden, true);
  await advance(60 * MINUTE);
  assert.equal(log.scans, 0);
  assert.equal(pending(), 0);
});

test('the first check waits a few seconds, then shows the count', async () => {
  const { badge, el, log } = setup();
  badge.start();
  await advance(START_DELAY_MS - 1);
  assert.equal(log.scans, 0);
  assert.equal(el!.hidden, true);
  await advance(1);
  assert.equal(log.scans, 1);
  assert.equal(el!.textContent, '1 order today');
  assert.equal(el!.hidden, false);
  assert.equal(el!.attrs.get('aria-label'), 'Buy TLT at the next open, Trend\nClick to open the orders window.');
  assert.deepEqual(log.notices, []);
  badge.stop();
});

test('while the first check runs the badge says it is checking', async () => {
  let finish!: (list: StrategyStatus[]) => void;
  const { badge, el } = setup({ scan: () => new Promise((resolve) => (finish = resolve)) });
  badge.start();
  await advance(START_DELAY_MS);
  assert.equal(el!.textContent, "Today's orders…");
  assert.equal(el!.hidden, false);
  finish([status('A')]);
  await flush();
  assert.equal(el!.textContent, 'No orders today');
  badge.stop();
});

test('a vault with no strategies leaves the badge hidden', async () => {
  const { badge, el } = setup({ scan: async () => [] });
  badge.start();
  await advance(START_DELAY_MS);
  assert.equal(el!.hidden, true);
  badge.stop();
});

test('a mark shows on the badge when something could not be checked, and goes when it can', async () => {
  let list = [status('A', [['buy', 'X']]), failedStatus('b.md', 'B', 'x')];
  const { badge, el } = setup({ scan: async () => list });
  badge.start();
  await advance(START_DELAY_MS);
  assert.equal(el!.classes.has('bt-badge-warning'), true);
  assert.equal(el!.classes.has('bt-badge-error'), false);
  list = [status('A', [['buy', 'X']])];
  await advance(6 * HOUR);
  assert.equal(el!.classes.has('bt-badge-warning'), false);
  badge.stop();
});

test('clicking, or pressing Enter or Space, opens the orders window; other keys do not', () => {
  const { el, log } = setup();
  el!.click();
  assert.equal(log.opened, 1);
  assert.equal(el!.press('Enter').prevented, true);
  assert.equal(el!.press(' ').prevented, true);
  assert.equal(log.opened, 3);
  assert.equal(el!.press('a').prevented, false);
  assert.equal(el!.press('Tab').prevented, false);
  assert.equal(log.opened, 3);
  assert.equal(el!.attrs.get('role'), 'button');
  assert.equal(el!.attrs.get('tabindex'), '0');
});

test('it checks again when its answer is older than the hours it was given, and not before', async () => {
  const { badge, log } = setup({ hours: () => 6 });
  badge.start();
  await advance(START_DELAY_MS);
  assert.equal(log.scans, 1);
  await advance(6 * HOUR - 6 * MINUTE);
  assert.equal(log.scans, 1);
  await advance(10 * MINUTE);
  assert.equal(log.scans, 2);
  await advance(6 * HOUR + 5 * MINUTE);
  assert.equal(log.scans, 3);
  badge.stop();
});

test('the hours are read each time, so a changed setting counts', async () => {
  let hours = 6;
  const { badge, log } = setup({ hours: () => hours });
  badge.start();
  await advance(START_DELAY_MS);
  hours = 1;
  await advance(HOUR + 5 * MINUTE);
  assert.equal(log.scans, 2);
  badge.stop();
});

test('it never starts a second check while one is running', async () => {
  let finish!: (list: StrategyStatus[]) => void;
  const { badge, log } = setup({ scan: () => new Promise((resolve) => (finish = resolve)) });
  badge.start();
  await advance(START_DELAY_MS);
  await advance(30 * HOUR);
  assert.equal(log.scans, 1);
  finish([]);
  await flush();
  await advance(MINUTE);
  assert.equal(log.scans, 1);
  badge.stop();
});

test('the orders window\'s answer replaces the badge and counts as a fresh check', async () => {
  const { badge, el, log } = setup();
  badge.start();
  await advance(START_DELAY_MS);
  await advance(5 * HOUR);
  badge.show([status('A', [['buy', 'X'], ['buy', 'Y']])]);
  assert.equal(el!.textContent, '2 orders today');
  await advance(2 * HOUR);
  assert.equal(log.scans, 1);
  await advance(4 * HOUR + 10 * MINUTE);
  assert.equal(log.scans, 2);
  badge.stop();
});

test('an answer given before the first check is due means no check is needed', async () => {
  const { badge, el, log } = setup();
  badge.start();
  badge.show([status('A')]);
  await advance(START_DELAY_MS + MINUTE);
  assert.equal(log.scans, 0);
  assert.equal(el!.textContent, 'No orders today');
  badge.stop();
});

test('an answer from the window wins over a check still running', async () => {
  let finish!: (list: StrategyStatus[]) => void;
  const { badge, el } = setup({ scan: () => new Promise((resolve) => (finish = resolve)) });
  badge.start();
  await advance(START_DELAY_MS);
  badge.show([status('A', [['sell', 'X']])]);
  finish([status('A')]);
  await flush();
  assert.equal(el!.textContent, '1 order today');
  badge.stop();
});

test('show does nothing before start or after stop', async () => {
  const { badge, el } = setup();
  badge.show([status('A', [['buy', 'X']])]);
  assert.equal(el!.hidden, true);
  badge.start();
  badge.stop();
  badge.show([status('A', [['buy', 'X']])]);
  assert.equal(el!.hidden, true);
});

test('stop leaves no timer behind, whatever the badge was doing', async () => {
  const idle = setup();
  idle.badge.start();
  assert.equal(pending(), 1);
  idle.badge.stop();
  assert.equal(pending(), 0);

  const waiting = setup();
  waiting.badge.start();
  await advance(START_DELAY_MS);
  assert.equal(pending(), 1);
  waiting.badge.stop();
  assert.equal(pending(), 0);
  await advance(100 * HOUR);
  assert.equal(waiting.log.scans, 1);
});

test('stopping while a check runs drops its answer and sets no timer', async () => {
  let finish!: (list: StrategyStatus[]) => void;
  const { badge, el, log } = setup({ scan: () => new Promise((resolve) => (finish = resolve)) });
  badge.start();
  await advance(START_DELAY_MS);
  badge.stop();
  finish([status('A', [['buy', 'X']])]);
  await flush();
  assert.equal(el!.textContent, "Today's orders…");
  assert.equal(pending(), 0);
  await advance(100 * HOUR);
  assert.equal(log.scans, 1);
});

test('a check that fails shows it, never throws out of the timer, and is tried again later', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  let fail = true;
  const { badge, el, log } = setup({ scan: () => (fail ? Promise.reject(new Error('The vault could not be read')) : Promise.resolve([status('A', [['buy', 'X']])])) });
  badge.start();
  await advance(START_DELAY_MS);
  assert.equal(el!.textContent, "Cannot calculate orders");
  assert.equal(el!.classes.has('bt-badge-error'), true);
  assert.match(el!.attrs.get('aria-label')!, /The vault could not be read/);
  fail = false;
  await advance(5 * MINUTE);
  assert.equal(log.scans, 1);
  await advance(10 * MINUTE);
  assert.equal(log.scans, 2);
  assert.equal(el!.textContent, '1 order today');
  assert.equal(el!.classes.has('bt-badge-error'), false);
  badge.stop();
  await new Promise((resolve) => real.setTimeout(resolve, 0));
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, []);
});

test('when every strategy failed it says so and tries again as soon as after a failed check', async () => {
  let fail = true;
  const { badge, el, log } = setup({ scan: async () => (fail ? [failedStatus('a.md', 'A', 'offline'), failedStatus('b.md', 'B', 'offline')] : [status('A', [['buy', 'X']])]) });
  badge.start();
  await advance(START_DELAY_MS);
  assert.equal(el!.textContent, "Cannot calculate orders");
  assert.equal(el!.classes.has('bt-badge-error'), true);
  fail = false;
  await advance(5 * MINUTE);
  assert.equal(log.scans, 1);
  await advance(10 * MINUTE);
  assert.equal(log.scans, 2);
  assert.equal(el!.textContent, '1 order today');
  badge.stop();
});

test('a scan that throws at once, or with something that is not an Error, is handled the same way', async () => {
  const thrown = setup({
    scan: () => {
      throw new Error('boom');
    },
  });
  thrown.badge.start();
  await advance(START_DELAY_MS);
  assert.equal(thrown.el!.textContent, "Cannot calculate orders");
  thrown.badge.stop();

  const text = setup({ scan: () => Promise.reject('plain text') });
  text.badge.start();
  await advance(START_DELAY_MS);
  assert.match(text.el!.attrs.get('aria-label')!, /plain text/);
  text.badge.stop();
});

test('start can be called twice without a second schedule', async () => {
  const { badge, log } = setup();
  badge.start();
  badge.start();
  assert.equal(pending(), 1);
  await advance(START_DELAY_MS);
  assert.equal(log.scans, 1);
  badge.stop();
});

// ---- turning the badge off and on

test('turning the badge off hides it, stops its timers and drops an answer still on the way', async () => {
  let finish!: (list: StrategyStatus[]) => void;
  const { badge, el, log } = setup({ scan: () => new Promise((resolve) => (finish = resolve)) });
  badge.start();
  await advance(START_DELAY_MS);
  assert.equal(el!.textContent, "Today's orders…");
  badge.turnOff();
  assert.equal(el!.hidden, true);
  assert.equal(el!.textContent, '');
  assert.equal(pending(), 0);
  finish([status('A', [['buy', 'X']])]);
  await flush();
  assert.equal(el!.hidden, true);
  assert.equal(el!.textContent, '');
  await advance(100 * HOUR);
  assert.equal(log.scans, 1);
  assert.equal(pending(), 0);
});

test('turning the badge off after it showed a count hides the count', async () => {
  const { badge, el } = setup();
  badge.start();
  await advance(START_DELAY_MS);
  assert.equal(el!.textContent, '1 order today');
  badge.turnOff();
  assert.equal(el!.hidden, true);
  assert.equal(el!.textContent, '');
  assert.equal(pending(), 0);
});

test('with the badge off the orders window leaves it hidden, as before the first start', async () => {
  const { badge, el } = setup();
  badge.show([status('A', [['buy', 'X']])]);
  assert.equal(el!.hidden, true);
  badge.start();
  await advance(START_DELAY_MS);
  badge.turnOff();
  badge.show([status('A', [['buy', 'X'], ['sell', 'Y']])]);
  assert.equal(el!.hidden, true);
  assert.equal(el!.textContent, '');
});

test('turning the badge on again checks after the usual wait, even when the last answer is recent', async () => {
  const { badge, el, log } = setup();
  badge.start();
  await advance(START_DELAY_MS);
  assert.equal(log.scans, 1);
  badge.turnOff();
  await advance(MINUTE);
  badge.start();
  assert.equal(pending(), 1);
  assert.equal(el!.hidden, true);
  await advance(START_DELAY_MS);
  assert.equal(log.scans, 2);
  assert.equal(el!.textContent, '1 order today');
  assert.equal(pending(), 1);
  // And it goes on checking by itself afterwards.
  await advance(7 * HOUR);
  assert.ok(log.scans >= 3);
  badge.stop();
});

test('turning the badge off and on while a check runs leaves one timer, not two', async () => {
  let finish!: (list: StrategyStatus[]) => void;
  const { badge, log } = setup({ scan: () => new Promise((resolve) => (finish = resolve)) });
  badge.start();
  await advance(START_DELAY_MS);
  badge.turnOff();
  badge.start();
  finish([status('A', [['buy', 'X']])]);
  await flush();
  assert.equal(pending(), 1);
  badge.stop();
  assert.equal(pending(), 0);
  assert.equal(log.scans, 1);
});

test('stop is final: the badge cannot be started again after it', async () => {
  const { badge } = setup();
  badge.start();
  badge.stop();
  badge.start();
  assert.equal(pending(), 0);
});

// ---- no status bar

test('with no status bar the start-up check says the count once when there are orders', async () => {
  const { badge, log } = setup({ el: null, scan: async () => [status('A', [['buy', 'X'], ['sell', 'Y']])] });
  badge.start();
  await advance(START_DELAY_MS);
  assert.deepEqual(log.notices, ['2 orders today']);
  await advance(100 * HOUR);
  assert.equal(log.scans, 1);
  assert.deepEqual(log.notices, ['2 orders today']);
  assert.equal(pending(), 0);
});

test('with no status bar there is never a notice when there are no orders, none to check, or the check fails', async () => {
  for (const scan of [async () => [status('A')], async () => [], async () => [failedStatus('a.md', 'A', 'x')], () => Promise.reject(new Error('x'))]) {
    const { badge, log } = setup({ el: null, scan });
    badge.start();
    await advance(START_DELAY_MS);
    assert.equal(log.scans, 1);
    assert.deepEqual(log.notices, []);
    badge.stop();
  }
});

test('with a status bar there is no notice, even with orders', async () => {
  const { badge, log } = setup();
  badge.start();
  await advance(START_DELAY_MS);
  assert.deepEqual(log.notices, []);
  badge.stop();
});

test('with no status bar, show changes nothing and sends no notice', () => {
  const { badge, log } = setup({ el: null });
  badge.start();
  badge.show([status('A', [['buy', 'X']])]);
  assert.deepEqual(log.notices, []);
  badge.stop();
});
