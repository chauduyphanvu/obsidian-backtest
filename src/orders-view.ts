import { Modal, Notice, setIcon, type App } from 'obsidian';
import { h, motionOK, reveal, revealBox, s } from './dom.ts';
import { shortMessage } from './fixes.ts';
import { awayText } from './render-now.ts';
import { price, shareCount, signedPct } from './format.ts';
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
  /**
   * The fix for a strategy that did not run because its block has a problem, with the defaults of the settings: the
   * button's words, the sentence that offers it, and what writes it into the note (rejects with a message fit to show).
   * Null when there is none.
   */
  fix?(status: StrategyStatus): { label: string; text: string; write(): Promise<void> } | null;
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
    const status = h(this.fresh(), 'div', 'bt-orders-status', total > 0 ? `The plugin runs ${done} of ${total} strategies…` : 'The plugin runs the strategies…');
    status.setAttribute('role', 'status');
  }

  private failed(message: string): void {
    const root = this.fresh();
    h(root, 'p', 'bt-orders-empty', `Cannot run the strategies. ${message}`);
    h(root, 'button', 'bt-orders-button', 'Run again').addEventListener('click', () => void this.load(false));
  }

  private show(list: StrategyStatus[], accounts: AccountStatus[]): void {
    const root = this.fresh();
    if (list.length === 0) {
      h(root, 'p', 'bt-orders-empty', 'The vault has no strategy blocks. Add one with the command "Insert strategy block".');
      return;
    }
    const todo = todoRows(list);
    this.header(root, list, accounts);
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
  }

  private header(root: HTMLElement, list: StrategyStatus[], accounts: AccountStatus[]): void {
    const basis = basisOf(list);
    const head = h(root, 'div', 'bt-orders-head');
    const asof = h(head, 'div', 'bt-orders-asof', basis === null ? 'The plugin loaded no prices' : basis.text);
    if (basis?.note) h(asof, 'div', 'bt-orders-muted', basis.note);
    const actions = h(head, 'div', 'bt-orders-actions');
    const button = (icon: string, label: string, quiet: boolean) => {
      const b = h(actions, 'button', quiet ? 'bt-orders-button bt-orders-quiet' : 'bt-orders-button');
      setIcon(h(b, 'span', 'bt-orders-icon'), icon);
      h(b, 'span', undefined, label);
      return b;
    };
    const save = button('file-text', 'Save as note', true);
    save.addEventListener('click', () => void this.save(save, list, accounts));
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
      this.link(box, { note: a.note, strategy: a.name });
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
      const fix = s.error !== null && first ? (this.host.fix?.(s) ?? null) : null;
      const said = s.error !== null ? shortMessage(s.error).head : text;
      h(what, 'div', 'bt-orders-muted', fix ? `${said} ${fix.text}` : said);
      if (!fix) continue;
      const px = h(item, 'div', 'bt-orders-px');
      const button = h(px, 'button', 'bt-orders-button', fix.label);
      button.type = 'button';
      button.addEventListener('click', () => {
        button.disabled = true;
        fix.write().then(
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
    }
  }
}

/** A check mark in a circle, for a group with nothing to do. */
function checkIcon(parent: HTMLElement): void {
  const svg = s(parent, 'svg', { width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': 'true' });
  s(svg, 'circle', { cx: 9, cy: 9, r: 8, fill: 'currentColor', opacity: 0.15 });
  s(svg, 'path', { d: 'M5.5 9.2l2.3 2.3 4.7-4.9', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
}
