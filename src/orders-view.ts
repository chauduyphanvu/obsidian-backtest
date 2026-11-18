import { Modal, Notice, setIcon, type App } from 'obsidian';
import { h } from './dom.ts';
import { price, shareCount, signedPct } from './format.ts';
import {
  ACCOUNTS_HEADING,
  ACCOUNTS_NOTE,
  accountOrderText,
  actionWord,
  barLabel,
  barTime,
  basisOf,
  CLOSE_FILL_NOTE,
  LAST_CLOSE_NOTE,
  notOurNoteMessage,
  orderSize,
  ordersMarkdown,
  problemsOf,
  share,
  sortAccounts,
  sortStatuses,
  todoGroups,
  todoRows,
  WATCH_HEADING,
  WATCH_NOTE,
  watchClose,
  watchList,
  type AccountStatus,
  type SaveOutcome,
  type StrategyStatus,
  type TodoRow,
} from './orders.ts';

export interface OrdersHost {
  /** Runs every strategy in the vault; calls onProgress as each finishes. `force` refetches every price once. */
  scan(force: boolean, onProgress: (done: number, total: number) => void): Promise<StrategyStatus[]>;
  /** Every account block's orders, from the runs the scan kept (scanAccounts); called after each scan. */
  accounts(): Promise<AccountStatus[]>;
  /** Opens a note. */
  openNote(path: string): void;
  /** Writes the Markdown to the configured note, unless that note exists and this plugin did not make it. */
  save(markdown: string): Promise<SaveOutcome>;
  now(): number;
}

export class OrdersModal extends Modal {
  private host: OrdersHost;
  /** Counts scans, so the answer to an older one, or one for a closed window, is dropped. */
  private scans = 0;

  constructor(app: App, host: OrdersHost) {
    super(app);
    this.host = host;
  }

  onOpen(): void {
    this.modalEl.classList.add('bt-orders-modal');
    this.titleEl.textContent = "Today's orders";
    void this.load(false);
  }

  onClose(): void {
    this.scans++;
    this.contentEl.replaceChildren();
  }

  private async load(force: boolean): Promise<void> {
    const mine = ++this.scans;
    const current = () => mine === this.scans;
    this.progress(0, 0);
    try {
      const list = await this.host.scan(force, (done, total) => {
        if (current()) this.progress(done, total);
      });
      const accounts = await this.host.accounts();
      if (current()) this.show(sortStatuses(list), sortAccounts(accounts));
    } catch (e) {
      if (current()) this.failed(e instanceof Error ? e.message : String(e));
    }
  }

  private fresh(): HTMLElement {
    this.contentEl.replaceChildren();
    return h(this.contentEl, 'div', 'bt-orders');
  }

  private progress(done: number, total: number): void {
    const status = h(this.fresh(), 'div', 'bt-orders-status', total > 0 ? `Checking strategies… ${done} of ${total}` : 'Checking strategies…');
    status.setAttribute('role', 'status');
  }

  private failed(message: string): void {
    const root = this.fresh();
    h(root, 'p', 'bt-orders-empty', `Couldn't check the strategies. ${message}`);
    h(root, 'button', 'bt-orders-button', 'Try again').addEventListener('click', () => void this.load(false));
  }

  private show(list: StrategyStatus[], accounts: AccountStatus[]): void {
    const root = this.fresh();
    if (list.length === 0) {
      h(root, 'p', 'bt-orders-empty', 'No strategy blocks found. Add one with the command "Insert strategy block".');
      return;
    }
    const todo = todoRows(list);
    this.header(root, list, accounts);
    this.todo(root, todo);
    this.accounts(root, accounts);
    this.watch(root, list);
    this.holding(root, list, todo.length > 0);
    this.closeFills(root, list);
    this.problems(root, list);
    h(root, 'p', 'bt-orders-foot', 'From backtests of your rules on the latest prices. Nothing here places an order.');
  }

  private header(root: HTMLElement, list: StrategyStatus[], accounts: AccountStatus[]): void {
    const basis = basisOf(list);
    const head = h(root, 'div', 'bt-orders-head');
    const asof = h(head, 'div', 'bt-orders-asof', basis === null ? 'No prices were loaded' : basis.text);
    if (basis?.note) h(asof, 'div', 'bt-orders-muted', basis.note);
    const actions = h(head, 'div', 'bt-orders-actions');
    const button = (icon: string, label: string) => {
      const b = h(actions, 'button', 'bt-orders-button');
      setIcon(h(b, 'span', 'bt-orders-icon'), icon);
      h(b, 'span', undefined, label);
      return b;
    };
    button('refresh-cw', 'Refresh prices').addEventListener('click', () => void this.load(true));
    const save = button('file-text', 'Save as note');
    save.addEventListener('click', () => void this.save(save, list, accounts));
  }

  private async save(button: HTMLButtonElement, list: StrategyStatus[], accounts: AccountStatus[]): Promise<void> {
    button.disabled = true;
    try {
      const outcome = await this.host.save(ordersMarkdown(list, this.host.now(), accounts));
      new Notice(
        outcome.kind === 'none'
          ? "Choose a note for today's orders in the plugin's settings"
          : outcome.kind === 'refused'
            ? notOurNoteMessage(outcome.path)
            : `Saved today's orders to ${outcome.path}`,
      );
    } catch (e) {
      new Notice(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      button.disabled = false;
    }
  }

  private heading(parent: HTMLElement, text: string, tag: 'div' | 'summary' = 'div'): HTMLElement {
    return h(parent, tag, 'bt-orders-heading', text);
  }

  /** The strategy's name, as a link that opens its note. */
  private link(parent: HTMLElement, s: Pick<StrategyStatus, 'note' | 'strategy'>): void {
    const link = h(parent, 'button', 'bt-orders-link', s.strategy);
    link.title = `Open ${s.note}`;
    link.addEventListener('click', () => {
      this.host.openNote(s.note);
      this.close();
    });
  }

  /** One list for each timing that has an order: at the next open, at the next close, and what was already made at the last close. */
  private todo(root: HTMLElement, rows: TodoRow[]): void {
    const groups = todoGroups(rows);
    if (groups.length === 0) {
      const section = h(root, 'section', 'bt-orders-section');
      this.heading(section, 'To do');
      h(section, 'p', 'bt-orders-none', 'Nothing to do. No strategy has an order.');
      return;
    }
    for (const { when, heading, rows: group } of groups) {
      const section = h(root, 'section', 'bt-orders-section');
      this.heading(section, heading);
      if (when === 'last close') h(section, 'p', 'bt-orders-muted', LAST_CLOSE_NOTE);
      const list = h(section, 'ul', when === 'last close' ? 'bt-orders-list bt-orders-done' : 'bt-orders-list');
      for (const { status, order } of group) {
        const row = h(list, 'li', 'bt-orders-row');
        h(row, 'span', `bt-orders-action bt-orders-${order.action}`, actionWord(order));
        const what = h(row, 'div', 'bt-orders-what');
        h(what, 'span', 'bt-orders-ticker', order.ticker);
        h(what, 'span', undefined, orderSize(order));
        const detail = h(row, 'div', 'bt-orders-detail');
        this.link(detail, status);
        h(detail, 'span', undefined, `Last close ${price(order.lastClose)}`);
        h(detail, 'span', undefined, `Based on the ${barLabel(status)}`);
        if (order.since !== null) h(detail, 'span', undefined, `Held since ${barTime(status, order.since)}`);
      }
    }
  }

  /** Each account block's orders in shares, the strategies' orders netted at the account's size; one with none says so. */
  private accounts(root: HTMLElement, accounts: AccountStatus[]): void {
    if (accounts.length === 0) return;
    const section = h(root, 'section', 'bt-orders-section');
    this.heading(section, ACCOUNTS_HEADING);
    h(section, 'p', 'bt-orders-muted', ACCOUNTS_NOTE);
    for (const a of accounts) {
      const box = h(section, 'div', 'bt-orders-hold');
      this.link(box, { note: a.note, strategy: a.name });
      if (a.error !== null) {
        h(box, 'div', 'bt-orders-muted', `Couldn't be worked out. ${a.error}`);
        continue;
      }
      if (a.orders.length === 0) {
        h(box, 'div', 'bt-orders-muted', 'Nothing to trade');
        continue;
      }
      const list = h(box, 'ul', 'bt-orders-list');
      for (const o of a.orders) {
        const row = h(list, 'li', 'bt-orders-row');
        h(row, 'span', `bt-orders-action bt-orders-${o.shares > 0 ? 'buy' : 'sell'}`, o.shares > 0 ? 'Buy' : 'Sell');
        const what = h(row, 'div', 'bt-orders-what');
        h(what, 'span', 'bt-orders-ticker', o.ticker);
        h(what, 'span', undefined, accountOrderText(o).replace(/^\S+ /, ''));
        const detail = h(row, 'div', 'bt-orders-detail');
        h(detail, 'span', undefined, `Last close ${price(o.price)}`);
        h(detail, 'span', undefined, `Held ${shareCount(o.holding)}`);
      }
    }
  }

  /** The closes at the next bar that would give an order, nearest first: what to keep an eye on before that close. */
  private watch(root: HTMLElement, list: StrategyStatus[]): void {
    const rows = watchList(list);
    if (rows.length === 0) return;
    const section = h(root, 'section', 'bt-orders-section');
    this.heading(section, WATCH_HEADING);
    h(section, 'p', 'bt-orders-muted', WATCH_NOTE);
    const items = h(section, 'ul', 'bt-orders-list bt-orders-watch');
    for (const { status, row } of rows) {
      const item = h(items, 'li', 'bt-orders-row');
      h(item, 'span', `bt-orders-action bt-orders-${row.side === 'sell' ? 'sell' : 'buy'}`, { buy: 'Buy', sell: 'Sell', add: 'Add' }[row.side]);
      const what = h(item, 'div', 'bt-orders-what');
      h(what, 'span', 'bt-orders-ticker', row.ticker);
      h(what, 'span', undefined, `${row.phrase}, ${row.when}`);
      const detail = h(item, 'div', 'bt-orders-detail');
      this.link(detail, status);
      h(detail, 'span', undefined, `Last close ${watchClose(row)}`);
      h(detail, 'span', undefined, `Based on the ${barLabel(status)}`);
    }
  }

  /** Strategies with a position kept or no order at all; one with only orders is already covered above. */
  private holding(root: HTMLElement, list: StrategyStatus[], collapsed: boolean): void {
    const held = list.filter((s) => s.error === null && (s.holdings.length > 0 || s.orders.length === 0));
    if (held.length === 0) return;
    const section = h(root, 'details', 'bt-orders-section');
    section.open = !collapsed;
    this.heading(section, `Holding (${held.length})`, 'summary');
    for (const s of held) {
      const box = h(section, 'div', 'bt-orders-hold');
      this.link(box, s);
      if (s.holdings.length === 0) {
        h(box, 'div', 'bt-orders-muted', 'In cash');
        continue;
      }
      const items = h(box, 'ul', 'bt-orders-held');
      for (const p of s.holdings) {
        const item = h(items, 'li');
        h(item, 'span', 'bt-orders-ticker', p.ticker);
        const since = `since ${barTime(s, p.since)}`;
        h(item, 'span', 'bt-orders-muted', `${share(p.weight)} of the strategy, ${p.gain === null ? since : `${signedPct(p.gain)} ${since}`}`);
      }
    }
  }

  /** What a `fill: close` strategy's orders mean, once, with the strategies it applies to. */
  private closeFills(root: HTMLElement, list: StrategyStatus[]): void {
    const atClose = list.filter((s) => s.closeFill);
    if (atClose.length === 0) return;
    const section = h(root, 'section', 'bt-orders-section');
    this.heading(section, 'Strategies that fill at the close');
    h(section, 'p', 'bt-orders-muted', CLOSE_FILL_NOTE);
    const items = h(section, 'ul', 'bt-orders-fills');
    for (const s of atClose) this.link(h(items, 'li'), s);
  }

  private problems(root: HTMLElement, list: StrategyStatus[]): void {
    const found = list.flatMap((s) => problemsOf(s).map((text) => ({ s, text })));
    if (found.length === 0) return;
    const section = h(root, 'section', 'bt-orders-section');
    this.heading(section, 'Problems');
    const items = h(section, 'ul', 'bt-orders-problems');
    for (const { s, text } of found) {
      const item = h(items, 'li', s.error === null ? 'bt-orders-problem' : 'bt-orders-problem bt-orders-problem-error');
      this.link(item, s);
      h(item, 'div', 'bt-orders-muted', text);
    }
  }
}
