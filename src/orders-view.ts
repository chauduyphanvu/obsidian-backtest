import { ItemView, Modal, Notice, setIcon, type App, type WorkspaceLeaf } from 'obsidian';
import { orderSteps, type Holding } from './account.ts';
import { h, motionOK, reveal, revealBox, s } from './dom.ts';
import type { LedgerEventSide } from './fill-ledger.ts';
import { shortMessage } from './fixes.ts';
import type { KillSwitchReport } from './killswitch.ts';
import { awayText } from './render-now.ts';
import { fullStop, price, shareCount, signedPct } from './format.ts';
import {
  ACCOUNTS_HEADING,
  ACCOUNTS_NOTE,
  accountOrderBadge,
  actionWord,
  barLabel,
  barTime,
  basisOf,
  CLOSE_FILL_NOTE,
  LAST_CLOSE_NOTE,
  lastCheckText,
  notOurNoteMessage,
  orderSize,
  ordersMarkdown,
  problemsOf,
  share,
  sortAccounts,
  sortStatuses,
  todoGroups,
  todoRows,
  WATCH_NOTE,
  WATCH_RULE,
  WATCH_TITLE,
  WATCH_WITHIN,
  watchClose,
  watchList,
  type AccountStatus,
  type ListFix,
  type SaveOutcome,
  type StrategyStatus,
  type TodoRow,
} from './orders.ts';
import type { Scan } from './orders-badge.ts';

export interface ConfirmFillLeg {
  account: string;
  strategy?: string;
  ticker: string;
  side: LedgerEventSide;
  quantity: number;
  price: number;
  fees: number;
}

export interface OrdersHost {
  /**
   * Runs every strategy in the vault, or joins the scan that runs already (SharedScan); calls onProgress as each finishes.
   * `force` refetches every price once.
   */
  scan(force: boolean, onProgress: (done: number, total: number) => void): Promise<Scan>;
  /** The last scan, when it finished a few minutes ago or less; null when none did. */
  recent(): Scan | null;
  /** Every account block's orders, from the runs the scan kept (scanAccounts); called after each scan. */
  accounts(): Promise<AccountStatus[]>;
  /** Opens the note at a block the list names, a strategy drawn open; at the top of the note when the note no longer has the block. */
  openBlock(note: string, name: string, line: number | undefined, lang: 'strategy' | 'account'): void;
  /** Writes the Markdown to the configured note, unless that note exists and this plugin did not make it. */
  save(markdown: string): Promise<SaveOutcome>;
  now(): number;
  /**
   * What a strategy that did not run offers to put it right (orders.ts ListFix), with the defaults of the settings: for a
   * problem in its block, the button's words, the sentence that offers it, and what writes it into the note (rejects with
   * a message fit to show); for prices that did not load, the step its own card offers. Null when there is nothing.
   */
  fix?(status: StrategyStatus): ListFix | Promise<ListFix | null> | null;
  /** Asks for a starter strategy and makes a new note with it. */
  newNote(): void;
  /** Opens the list in a pane of the right sidebar. */
  openPane(): void;
  /** Evaluates pre-committed `invalidate when` kill-switches across deployed strategies. */
  killSwitches?(): Promise<{ note: string; strategy: string; line?: number; report: KillSwitchReport }[]>;
  /** Appends one or more 1-click confirmed fill legs (2 legs for a Flip) to `fills.jsonl` and refreshes derived holdings. */
  confirmFill?(fill: ConfirmFillLeg | ConfirmFillLeg[], opening?: { holdings: readonly Holding[]; cash: number }): Promise<void>;
}

export class OrdersModal extends Modal {
  private panel: OrdersPanel;

  constructor(app: App, host: OrdersHost) {
    super(app);
    this.panel = new OrdersPanel(this.contentEl, host, () => this.close());
  }

  onOpen(): void {
    this.modalEl.classList.add('bt-orders-modal');
    this.titleEl.textContent = "Today's orders";
    this.panel.start();
  }

  onClose(): void {
    this.panel.stop();
  }
}

export const VIEW_TYPE_ORDERS = 'backtest-orders';

/** Today's orders in a pane that stays open: it shows each scan the status bar or the orders window makes. */
export class OrdersView extends ItemView {
  private host: OrdersHost;
  private panel: OrdersPanel | null = null;

  constructor(leaf: WorkspaceLeaf, host: OrdersHost) {
    super(leaf);
    this.host = host;
    this.navigation = false;
  }

  getViewType(): string {
    return VIEW_TYPE_ORDERS;
  }

  getDisplayText(): string {
    return "Today's orders";
  }

  getIcon(): string {
    return 'list-checks';
  }

  async onOpen(): Promise<void> {
    this.contentEl.classList.add('bt-orders-pane');
    this.panel = new OrdersPanel(this.contentEl, this.host, null);
    this.panel.start();
  }

  async onClose(): Promise<void> {
    this.panel?.stop();
    this.panel = null;
  }

  /** A scan that finished elsewhere. */
  offer(scan: Scan): void {
    void this.panel?.offer(scan);
  }
}

/** Opens the pane in the right sidebar, or shows it if it is open already. */
export async function openOrdersPane(app: App): Promise<void> {
  const { workspace } = app;
  let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_ORDERS)[0] ?? null;
  if (!leaf) {
    leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_ORDERS, active: true });
  }
  await workspace.revealLeaf(leaf);
}

/** The list of today's orders, drawn into the orders window or the pane. */
export class OrdersPanel {
  private el: HTMLElement;
  private host: OrdersHost;
  /** Closes the window the list is in; null in the pane, which stays open. */
  private close: (() => void) | null;
  /** Counts scans, so the answer to an older one, or one for a closed list, is dropped. */
  private scans = 0;
  /** The scan on show, so the same scan offered again is not drawn again. */
  private shown: Scan | null = null;

  constructor(el: HTMLElement, host: OrdersHost, close: (() => void) | null) {
    this.el = el;
    this.host = host;
    this.close = close;
  }

  /** Shows the orders: in the pane, those of a recent scan when there is one; else those of a new scan. */
  start(): void {
    const recent = this.close === null ? this.host.recent() : null;
    if (recent) void this.offer(recent);
    else void this.load(false);
  }

  stop(): void {
    this.scans++;
    this.shown = null;
    this.el.replaceChildren();
  }

  /** Shows a scan that finished, with the accounts worked out from its runs, unless it is on show already. */
  async offer(scan: Scan): Promise<void> {
    if (scan === this.shown) return;
    this.shown = scan;
    const mine = ++this.scans;
    try {
      const accounts = await this.host.accounts();
      if (mine === this.scans) this.show(scan, sortAccounts(accounts));
    } catch (e) {
      if (mine === this.scans) this.failed(e instanceof Error ? e.message : String(e));
    }
  }

  private async load(force: boolean): Promise<void> {
    const mine = ++this.scans;
    const current = () => mine === this.scans;
    this.shown = null;
    this.progress(0, 0);
    let scan: Scan;
    try {
      scan = await this.host.scan(force, (done, total) => {
        if (current()) this.progress(done, total);
      });
    } catch (e) {
      if (current()) this.failed(e instanceof Error ? e.message : String(e));
      return;
    }
    if (current()) await this.offer(scan);
  }

  private fresh(): HTMLElement {
    this.el.replaceChildren();
    return h(this.el, 'div', 'bt-orders');
  }

  private progress(done: number, total: number): void {
    const status = h(this.fresh(), 'div', 'bt-orders-status', total > 0 ? `The plugin runs ${done} of ${total} strategies…` : 'The plugin runs the strategies…');
    status.setAttribute('role', 'status');
  }

  private failed(message: string): void {
    const root = this.fresh();
    h(root, 'p', 'bt-orders-empty', `Cannot run the strategies. ${message}`);
    h(root, 'button', 'bt-orders-button', 'Run again').addEventListener('click', () => void this.load(false));
  }

  private show(scan: Scan, accounts: AccountStatus[]): void {
    const list = sortStatuses(scan.statuses);
    // A pane drawn again keeps its place.
    const top = this.el.scrollTop;
    const root = this.fresh();
    if (list.length === 0) {
      h(root, 'p', 'bt-orders-empty', 'The vault has no strategy blocks.');
      h(root, 'button', 'bt-orders-button', 'New strategy note').addEventListener('click', () => {
        this.close?.();
        this.host.newNote();
      });
      return;
    }
    const todo = todoRows(list);
    this.header(root, list, accounts, scan.at);
    const ksHost = h(root, 'div', 'bt-orders-ks-host');
    if (this.host.killSwitches) {
      void this.host.killSwitches().then((alerts) => {
        const active = alerts.filter((a) => a.report.status !== 'healthy');
        if (active.length === 0) return;
        const sec = this.group(ksHost, 'Thesis Kill-Switches', `${active.length} ${active.length === 1 ? 'alert' : 'alerts'}`);
        for (const a of active) {
          const item = h(sec, 'div', `bt-ks bt-ks-${a.report.status}`);
          h(item, 'span', 'bt-ks-badge', a.report.status === 'halted' ? 'Stopped — stop rule tripped' : 'Near stop rule');
          this.link(item, { note: a.note, strategy: a.strategy, line: a.line });
          if (a.report.trippedClauses.length) h(item, 'span', 'bt-ks-detail', a.report.trippedClauses.join(' · '));
        }
      }, () => {});
    }
    this.todo(root, todo);
    this.accounts(root, accounts);
    const watching = this.watch(root, list);
    this.problems(root, list);
    this.holding(root, list);
    this.closeFills(root, list);
    const foot = h(root, 'div', 'bt-orders-foot');
    h(foot, 'span', undefined, 'From backtests of your rules on the last prices. The plugin does not send orders.');
    if (watching) {
      // What the watch group's few words stand for, behind a link, for the reader who asks.
      const how = h(foot, 'button', 'bt-orders-help', 'How the closes are found');
      how.type = 'button';
      how.setAttribute('aria-expanded', 'false');
      const { box, inner } = revealBox(root, 'bt-orders-how');
      h(inner, 'p', 'bt-orders-muted', WATCH_NOTE);
      how.addEventListener('click', () => {
        const open = how.getAttribute('aria-expanded') !== 'true';
        how.setAttribute('aria-expanded', String(open));
        reveal(box, open);
      });
    }
    this.el.scrollTop = top;
  }

  private header(root: HTMLElement, list: StrategyStatus[], accounts: AccountStatus[], checked: number): void {
    const basis = basisOf(list);
    const head = h(root, 'div', 'bt-orders-head');
    const asof = h(head, 'div', 'bt-orders-asof', basis === null ? 'The plugin loaded no prices' : basis.text);
    if (basis?.note) h(asof, 'div', 'bt-orders-muted', basis.note);
    if (this.close === null) h(asof, 'div', 'bt-orders-muted', lastCheckText(checked, this.host.now()));
    const actions = h(head, 'div', 'bt-orders-actions');
    const button = (icon: string, label: string, quiet: boolean) => {
      const b = h(actions, 'button', quiet ? 'bt-orders-button bt-orders-quiet' : 'bt-orders-button');
      setIcon(h(b, 'span', 'bt-orders-icon'), icon);
      h(b, 'span', undefined, label);
      return b;
    };
    const save = button('file-text', 'Save as note', true);
    save.addEventListener('click', () => void this.save(save, list, accounts));
    const close = this.close;
    if (close) {
      button('panel-right', 'Keep in the sidebar', true).addEventListener('click', () => {
        this.host.openPane();
        close();
      });
    }
    button('refresh-cw', 'Refresh prices', false).addEventListener('click', () => void this.load(true));
  }

  private async save(button: HTMLButtonElement, list: StrategyStatus[], accounts: AccountStatus[]): Promise<void> {
    button.disabled = true;
    try {
      const outcome = await this.host.save(ordersMarkdown(list, this.host.now(), accounts));
      new Notice(
        outcome.kind === 'none'
          ? "Select a note for today's orders in the plugin settings"
          : outcome.kind === 'refused'
            ? notOurNoteMessage(outcome.path)
            : `Saved today's orders to ${outcome.path}`,
      );
    } catch (e) {
      new Notice(`Cannot save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      button.disabled = false;
    }
  }

  /** A group: its heading, a few words of what it holds, and how many, with the count at the right. */
  private group(root: HTMLElement, title: string, count: string, rule?: string): HTMLElement {
    const section = h(root, 'section', 'bt-orders-section');
    const head = h(section, 'div', 'bt-orders-heading');
    h(head, 'span', 'bt-orders-heading-text', title);
    if (rule) h(head, 'span', 'bt-orders-rule', rule);
    h(head, 'span', 'bt-orders-count', count);
    return section;
  }

  /** The strategy's name, as a link that opens its note at the block. */
  private link(parent: HTMLElement, s: Pick<StrategyStatus, 'note' | 'strategy' | 'line'>, lang: 'strategy' | 'account' = 'strategy'): void {
    const link = h(parent, 'button', 'bt-orders-link', s.strategy);
    link.title = `Open ${s.note}`;
    link.addEventListener('click', () => {
      this.host.openBlock(s.note, s.strategy, s.line, lang);
      this.close?.();
    });
  }

  /** One list for each timing that has an order: at the next open, at the next close, and what was already made at the last close. */
  private todo(root: HTMLElement, rows: TodoRow[]): void {
    const groups = todoGroups(rows);
    if (groups.length === 0) {
      // No order is an answer, said as one.
      const section = this.group(root, 'To do at the next open', '0 orders');
      const empty = h(section, 'div', 'bt-orders-none');
      checkIcon(empty);
      const text = h(empty, 'span');
      h(text, 'b', undefined, 'Nothing to send.');
      text.append(' No rule gave an order at the last close.');
      return;
    }
    for (const { when, heading, rows: group } of groups) {
      const section = this.group(root, heading, group.length === 1 ? '1 order' : `${group.length} orders`);
      if (when === 'last close') h(section, 'p', 'bt-orders-muted', LAST_CLOSE_NOTE);
      const list = h(section, 'ul', when === 'last close' ? 'bt-orders-list bt-orders-done' : 'bt-orders-list');
      for (const { status, order } of group) {
        const row = h(list, 'li', 'bt-orders-row');
        h(row, 'span', `bt-orders-action bt-orders-${order.action}`, actionWord(order));
        const what = h(row, 'div', 'bt-orders-what');
        const who = h(what, 'div', 'bt-orders-who');
        h(who, 'b', 'bt-orders-ticker', order.ticker);
        h(who, 'span', 'bt-orders-sep', ' \u00b7 ');
        this.link(who, status);
        h(what, 'div', 'bt-orders-muted', orderSize(order));
        const px = h(row, 'div', 'bt-orders-px');
        h(px, 'span', undefined, `last ${price(order.lastClose)}`);
        h(px, 'small', undefined, order.since !== null ? `held since ${barTime(status, order.since)}` : `the ${barLabel(status)}`);
      }
    }
  }

  /** Each account block's orders in shares, the strategies' orders netted at the account's size; one with none says so. */
  private accounts(root: HTMLElement, accounts: AccountStatus[]): void {
    if (accounts.length === 0) return;
    const section = this.group(root, ACCOUNTS_HEADING, accounts.length === 1 ? '1 account' : `${accounts.length} accounts`);
    h(section, 'p', 'bt-orders-muted', ACCOUNTS_NOTE);
    for (const a of accounts) {
      const box = h(section, 'div', 'bt-orders-hold');
      this.link(box, { note: a.note, strategy: a.name, line: a.line }, 'account');
      if (a.error !== null) {
        h(box, 'div', 'bt-orders-muted', `Cannot calculate the orders. ${a.error}`);
        continue;
      }
      if (a.orders.length === 0) {
        h(box, 'div', 'bt-orders-muted', 'No orders');
        continue;
      }
      const list = h(box, 'ul', 'bt-orders-list');
      for (const o of a.orders) {
        const badge = accountOrderBadge(o);
        const row = h(list, 'li', 'bt-orders-row');
        h(row, 'span', `bt-orders-action bt-orders-${badge.style}`, badge.action);
        const what = h(row, 'div', 'bt-orders-what');
        h(h(what, 'div', 'bt-orders-who'), 'b', 'bt-orders-ticker', o.ticker);
        h(what, 'div', 'bt-orders-muted', badge.text);
        const px = h(row, 'div', 'bt-orders-px');
        h(px, 'span', undefined, `last ${price(o.price)}`);
        h(px, 'small', undefined, `held ${shareCount(o.holding)}`);
        if (this.host.confirmFill) {
          const cfBtn = h(row, 'button', 'bt-chip-button bt-orders-confirm', 'Confirm fill');
          cfBtn.type = 'button';
          cfBtn.addEventListener('click', () => {
            cfBtn.disabled = true;
            const steps = orderSteps(o);
            const legs: ConfirmFillLeg[] = steps.map((st) => ({
              account: a.name,
              ...(a.strategyKey ? { strategy: a.strategyKey } : {}),
              ticker: o.ticker,
              side: st.action,
              quantity: st.shares,
              price: o.price,
              fees: 0,
            }));
            void this.host
              .confirmFill!(legs, a.opening)
              .then(
                () => {
                  const summary =
                    legs.length === 2
                      ? `flip (${legs.map((l) => `${l.side} ${shareCount(l.quantity)}`).join(', then ')})`
                      : `${legs[0].side} ${shareCount(legs[0].quantity)}`;
                  new Notice(`Logged ${summary} ${o.ticker} at last close ${price(o.price)} ($0 fees; editable in fills.jsonl)`);
                  void this.load(false);
                },
                (e: unknown) => {
                  cfBtn.disabled = false;
                  new Notice(`Cannot log fill: ${e instanceof Error ? e.message : String(e)}`);
                },
              );
          });
        }
      }
    }
  }

  /**
   * The closes at the next bar that would give an order, nearest first: a row for each, with a bar that fills as the last
   * close nears the price. Returns whether there were any.
   */
  private watch(root: HTMLElement, list: StrategyStatus[]): boolean {
    const rows = watchList(list);
    if (rows.length === 0) return false;
    const section = this.group(root, WATCH_TITLE, rows.length === 1 ? '1 rule' : `${rows.length} rules`, WATCH_RULE);
    const items = h(section, 'ul', 'bt-orders-list bt-orders-watch');
    const bars: [HTMLElement, number][] = [];
    for (const { status, row } of rows) {
      const item = h(items, 'li', 'bt-orders-row');
      h(item, 'span', `bt-orders-action bt-orders-${row.side === 'add' ? 'buy' : row.side}`, { buy: 'Buy', sell: 'Sell', add: 'Add', short: 'Sell short', cover: 'Buy to cover' }[row.side]);
      const what = h(item, 'div', 'bt-orders-what');
      const who = h(what, 'div', 'bt-orders-who');
      h(who, 'b', 'bt-orders-ticker', row.ticker);
      h(who, 'span', 'bt-orders-sep', ' \u00b7 ');
      this.link(who, status);
      h(what, 'div', 'bt-orders-muted', `${row.plain ?? row.phrase}, ${row.when}`);
      const px = h(item, 'div', 'bt-orders-px');
      h(px, 'span', undefined, `last ${watchClose(row)}`);
      h(px, 'small', undefined, `the ${barLabel(status)}`);
      const prox = h(item, 'div', 'bt-orders-prox');
      if (row.now) {
        const bar = h(prox, 'span', 'bt-orders-bar');
        bar.setAttribute('aria-hidden', 'true');
        bars.push([h(bar, 'i'), 1]);
        h(prox, 'span', 'bt-orders-away', 'Gives the order if the close does not change');
      } else if (Number.isFinite(row.distance)) {
        const bar = h(prox, 'span', 'bt-orders-bar');
        bar.setAttribute('aria-hidden', 'true');
        bars.push([h(bar, 'i'), Math.max(0, Math.min(1, 1 - Math.abs(row.distance) / WATCH_WITHIN))]);
        h(prox, 'span', 'bt-orders-away', awayText(row.distance) ?? '');
      } else prox.remove();
    }
    // The bars fill once, from empty, when the window opens.
    const fill = () => {
      for (const [bar, k] of bars) bar.style.setProperty('transform', `scaleX(${k.toFixed(3)})`);
    };
    if (motionOK()) window.requestAnimationFrame(() => window.requestAnimationFrame(fill));
    else fill();
    return true;
  }

  /** What each strategy holds, folded: those with a position, then those in cash. */
  private holding(root: HTMLElement, list: StrategyStatus[]): void {
    const ran = list.filter((s) => s.error === null);
    if (ran.length === 0) return;
    const held = ran.filter((s) => s.holdings.length > 0);
    const cash = ran.filter((s) => s.holdings.length === 0 && s.orders.length === 0);
    if (held.length + cash.length === 0) return;
    const section = h(root, 'details', 'bt-orders-section bt-orders-holdings');
    const summary = h(section, 'summary', 'bt-orders-heading');
    h(summary, 'span', 'bt-orders-heading-text', 'Holdings');
    const counts = [held.length ? `${held.length} ${held.length === 1 ? 'strategy holds' : 'strategies hold'}` : '', cash.length ? `${cash.length} in cash` : ''].filter(Boolean);
    h(summary, 'span', 'bt-orders-rule', counts.join(', '));
    const box = h(section, 'div', 'bt-orders-quiet');
    for (const s of [...held, ...cash]) {
      const line = h(box, 'div', 'bt-orders-quiet-row');
      this.link(line, s);
      h(
        line,
        'span',
        'bt-orders-muted',
        s.holdings.length === 0
          ? 'In cash'
          : s.holdings
              .map((p) => {
                const since = `since ${barTime(s, p.since)}`;
                return `${p.short ? 'short ' : ''}${p.ticker} ${share(p.weight)}, ${p.gain === null ? since : `${signedPct(p.gain)} ${since}`}`;
              })
              .join('; '),
      );
    }
  }

  /** What a `fill: close` strategy's orders mean, once, with the strategies it applies to. */
  private closeFills(root: HTMLElement, list: StrategyStatus[]): void {
    const atClose = list.filter((s) => s.closeFill);
    if (atClose.length === 0) return;
    const section = this.group(root, 'Strategies that fill at the close', atClose.length === 1 ? '1 strategy' : `${atClose.length} strategies`);
    h(section, 'p', 'bt-orders-muted', CLOSE_FILL_NOTE);
    const items = h(section, 'ul', 'bt-orders-fills');
    for (const s of atClose) this.link(h(items, 'li'), s);
  }

  /** One row for each problem: the block, the message cut short, and a button for the fix when there is one. */
  private problems(root: HTMLElement, list: StrategyStatus[]): void {
    const found = list.flatMap((s) => problemsOf(s).map((text, k) => ({ s, text, first: k === 0 })));
    if (found.length === 0) return;
    const blocks = new Set(found.map((f) => f.s)).size;
    const section = this.group(root, 'Problems', blocks === 1 ? '1 block' : `${blocks} blocks`);
    const items = h(section, 'ul', 'bt-orders-list bt-orders-problems');
    for (const { s, text, first } of found) {
      const item = h(items, 'li', s.error === null ? 'bt-orders-row bt-orders-problem' : 'bt-orders-row bt-orders-problem bt-orders-problem-error');
      h(item, 'span', 'bt-orders-action bt-orders-fix', s.error === null ? 'Check' : 'Fix');
      const what = h(item, 'div', 'bt-orders-what');
      const who = h(what, 'div', 'bt-orders-who');
      this.link(who, s);
      const said = s.error !== null ? shortMessage(s.error).head : text;
      const words = h(what, 'div', 'bt-orders-muted', said);
      // A run whose prices did not load can wait for a ticker search before its fix is known.
      const show = (fix: ListFix | null) => {
        if (!fix) return;
        if (fix.text) words.textContent = `${fullStop(said)} ${fix.text}`;
        const { label, write, open } = fix;
        if (!label || !(write || open)) return;
        const px = h(item, 'div', 'bt-orders-px');
        const button = h(px, 'button', 'bt-orders-button', label);
        button.type = 'button';
        button.addEventListener('click', () => {
          if (!write) {
            open?.();
            return;
          }
          button.disabled = true;
          write().then(
            () => {
              button.textContent = 'Changed';
              void this.load(false);
            },
            (e: unknown) => {
              button.disabled = false;
              new Notice(`Cannot change the block. ${e instanceof Error ? e.message : String(e)}`);
            },
          );
        });
      };
      const asked = s.error !== null && first ? (this.host.fix?.(s) ?? null) : null;
      if (asked instanceof Promise) void asked.then(show, () => {});
      else show(asked);
    }
  }
}

/** A check mark in a circle, for a group with nothing to do. */
function checkIcon(parent: HTMLElement): void {
  const svg = s(parent, 'svg', { width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': 'true' });
  s(svg, 'circle', { cx: 9, cy: 9, r: 8, fill: 'currentColor', opacity: 0.15 });
  s(svg, 'path', { d: 'M5.5 9.2l2.3 2.3 4.7-4.9', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
}
