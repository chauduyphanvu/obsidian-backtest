// The `backtests` block: a table of every strategy in the vault, filled in as each one finishes.

import {
  COLUMNS,
  emptyText,
  figures,
  initialSort,
  parseDashboard,
  runRound,
  sortRows,
  summaryText,
  toggleSort,
  type DashRow,
  type DashboardHost,
  type DoneRow,
  type FailedRow,
  type SortKey,
} from './dashboard.ts';
import { h, motionOK } from './dom.ts';
import { shortMessage } from './fixes.ts';
import { drawSpark } from './render-chart.ts';
import { watchText } from './render-now.ts';
import type { Diagnostic } from './dsl.ts';

export type { DashboardHost } from './dashboard.ts';

export function renderDashboardErrors(parent: HTMLElement, errors: Diagnostic[], source: string): void {
  const root = h(parent, 'div', 'bt-root');
  h(root, 'div', 'bt-error-title', errors.length === 1 ? 'This dashboard cannot run' : `This dashboard cannot run: ${errors.length} problems`);
  const lines = source.split('\n');
  const list = h(root, 'ul', 'bt-errors');
  for (const e of errors) {
    const li = h(list, 'li');
    h(li, 'span', 'bt-error-line', `Line ${e.line}`);
    h(li, 'span', undefined, e.message);
    const text = lines[e.line - 1]?.trim();
    if (text) h(li, 'code', 'bt-error-src', text);
  }
}

const DASH = '–';
/** How long a row takes to glide to its new place when the table is sorted again. */
const GLIDE_MS = 240;

/** Draws the dashboard into `el` and starts running the strategies. Returns a cleanup function: once called, nothing more is drawn. */
export function renderDashboard(el: HTMLElement, source: string, host: DashboardHost): () => void {
  el.replaceChildren();
  const { config, errors } = parseDashboard(source);
  if (errors.length) {
    renderDashboardErrors(el, errors, source);
    return () => {};
  }

  const root = h(el, 'div', 'bt-root bt-dash');
  const head = h(root, 'div', 'bt-dash-head');
  h(head, 'div', 'bt-title', config.folder === null ? 'Strategies' : `Strategies in ${config.folder}`);
  const summary = h(head, 'span', 'bt-dash-summary');
  summary.setAttribute('aria-live', 'polite');
  const again = h(head, 'button', 'bt-button', 'Run again');
  again.addEventListener('click', () => start(true));
  const body = h(root, 'div', 'bt-dash-body');

  let alive = true;
  let round = 0;
  let rows: DashRow[] = [];
  let finishedAt: number | null = null;
  let sort = initialSort(config.sort);
  let heads: { key: SortKey; th: HTMLElement }[] = [];
  let tbody: HTMLElement | null = null;
  /** Each row's element, kept across sorts so a row can glide to its new place. */
  let trs = new Map<DashRow, HTMLTableRowElement>();
  /** The near-order chip of each strategy that ran, by note and name, filled when its trigger prices come. */
  let near = new Map<string, string | null>();
  const id = (row: Pick<DashRow, 'note' | 'name'>) => `${row.note}\u0000${row.name}`;

  const message = (text: string): void => {
    body.replaceChildren();
    heads = [];
    tbody = null;
    h(body, 'div', 'bt-note', text);
  };

  const markSort = (): void => {
    for (const { key, th } of heads) th.setAttribute('aria-sort', key === sort.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  };

  /** The name, and under it the trades, or what the row is waiting for or why it did not run. */
  const nameCell = (tr: HTMLElement, row: DashRow, under: string, stale?: string): void => {
    const cell = h(tr, 'td', 'bt-dash-first');
    const link = h(cell, 'button', 'bt-dash-link');
    link.title = `Open ${row.note}`;
    link.addEventListener('click', () => host.openNote(row.note));
    h(link, 'span', 'bt-dash-name', row.name);
    const sub = h(cell, 'span', 'bt-dash-sub', under);
    if (stale) h(sub, 'span', 'bt-dash-stale', ` \u00b7 ${stale}`);
  };

  const runningRow = (tr: HTMLElement, row: DashRow): void => {
    tr.className = 'bt-dash-running';
    nameCell(tr, row, 'The strategy runs…');
    for (const cls of ['bt-dash-spark', 'bt-num', 'bt-num', 'bt-num bt-dash-sharpe', 'bt-dash-state']) h(h(tr, 'td', cls), 'span', 'bt-sk bt-dash-sk');
  };

  const failedRowCells = (tr: HTMLElement, row: FailedRow): void => {
    tr.className = 'bt-dash-failed';
    nameCell(tr, row, 'Cannot run');
    const cell = h(tr, 'td', 'bt-dash-msg');
    cell.colSpan = COLUMNS.length - 1;
    const box = h(cell, 'div', 'bt-dash-msgtext');
    h(box, 'span', 'bt-orders-action bt-orders-fix', 'Fix');
    const fix = host.fix?.(row) ?? null;
    const said = shortMessage(row.reason).head;
    h(box, 'span', 'bt-dash-reason', fix ? `${said} ${fix.text}` : said);
    if (!fix) return;
    const button = h(box, 'button', 'bt-button', fix.label);
    button.type = 'button';
    button.addEventListener('click', () => {
      button.disabled = true;
      fix.write().then(
        () => start(false),
        (e: unknown) => {
          button.disabled = false;
          h(box, 'span', 'bt-dash-reason', `Cannot change the block. ${e instanceof Error ? e.message : String(e)}`);
        },
      );
    });
  };

  const doneRowCells = (tr: HTMLElement, row: DoneRow): void => {
    tr.className = '';
    const f = figures(row);
    nameCell(tr, row, row.trades === 1 ? '1 trade' : `${f.trades} trades`, row.stale ? `prices end ${row.through}` : undefined);
    drawSpark(h(tr, 'td', 'bt-dash-spark'), row.spark, 68, 22);
    const ret = h(tr, 'td', 'bt-num');
    h(ret, 'b', 'bt-dash-value', f.cagr);
    const bench = h(ret, 'span', 'bt-dash-sub', `${f.benchmark} ${row.benchmark.label}`);
    bench.title = row.benchmark.label;
    h(tr, 'td', 'bt-num', f.maxDrawdown);
    h(tr, 'td', 'bt-num bt-dash-sharpe', f.sharpe);
    const state = h(tr, 'td', 'bt-dash-state');
    const pos = h(state, 'span', `bt-fold-held${row.held.length === 0 ? ' bt-chip-cash' : ''}`);
    h(pos, 'span', 'bt-chip-dot');
    h(pos, 'span', undefined, row.now);
    if (row.held.length > 1) pos.title = row.held.join(', ');
    // The orders due, or a fixed-height line that the near-order chip fills when the trigger prices come.
    const next = h(state, 'span', 'bt-dash-next');
    if (row.next.length) for (const line of row.next) h(next, 'span', 'bt-dash-order', line);
    else {
      const chip = near.get(id(row));
      if (chip) {
        h(next, 'span', 'bt-chip-warn');
        next.append(chip);
        next.classList.add('bt-dash-near');
      } else h(next, 'span', 'bt-dash-none', chip === null ? 'No order near' : '');
    }
  };

  const fill = (tr: HTMLTableRowElement, row: DashRow): void => {
    tr.replaceChildren();
    if (row.state === 'done') doneRowCells(tr, row);
    else if (row.state === 'failed') failedRowCells(tr, row);
    else runningRow(tr, row);
  };

  /** Puts the rows in their order. Rows already on the table glide from where they were to their new places. */
  const place = (glide: boolean): void => {
    if (tbody === null) return;
    const before = new Map<HTMLTableRowElement, number>();
    const moving = glide && motionOK();
    if (moving) for (const tr of trs.values()) before.set(tr, tr.getBoundingClientRect().top);
    for (const row of sortRows(rows, sort)) tbody.append(trs.get(row)!);
    if (moving) {
      for (const [tr, top] of before) {
        const dy = top - tr.getBoundingClientRect().top;
        if (Math.abs(dy) < 1) continue;
        tr.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: GLIDE_MS, easing: 'cubic-bezier(.2,.75,.2,1)' });
      }
    }
    summary.textContent = summaryText(rows, finishedAt);
  };

  const drawTable = (): void => {
    body.replaceChildren();
    const wrap = h(body, 'div', 'bt-wide bt-dash-wide');
    const table = h(wrap, 'table', 'bt-table bt-dash-table');
    table.setAttribute('aria-label', 'Strategies');
    const tr = h(h(table, 'thead'), 'tr');
    heads = [];
    for (const c of COLUMNS) {
      const key = c.key;
      const th = h(tr, 'th', c.num ? 'bt-num' : key === 'name' ? 'bt-dash-first' : key === null ? 'bt-dash-spark' : 'bt-dash-state');
      th.scope = 'col';
      if (c.num && key === 'sharpe') th.classList.add('bt-dash-sharpe');
      if (key === null) continue;
      const button = h(th, 'button', 'bt-dash-sort', c.label);
      if (c.hint) button.title = c.hint;
      button.addEventListener('click', () => {
        sort = toggleSort(sort, key);
        markSort();
        place(true);
      });
      heads.push({ key, th });
    }
    markSort();
    tbody = h(table, 'tbody');
    trs = new Map();
    for (const row of rows) {
      const tr = document.createElement('tr');
      trs.set(row, tr);
      fill(tr, row);
    }
    place(false);
  };

  const start = (force: boolean): void => {
    const mine = ++round;
    const current = () => alive && mine === round;
    finishedAt = null;
    rows = [];
    near = new Map();
    summary.textContent = '';
    message('The plugin finds the strategies…');
    let listed = false;
    runRound(host, config, force, {
      current,
      onList(found, inVault) {
        listed = true;
        rows = found;
        if (found.length === 0) {
          message(emptyText(config, inVault));
          summary.textContent = '';
          return;
        }
        drawTable();
      },
      onRow(index, row, out) {
        const was = rows[index];
        const tr = trs.get(was);
        rows[index] = row;
        if (!tr) return;
        trs.delete(was);
        trs.set(row, tr);
        fill(tr, row);
        if (motionOK()) tr.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
        place(true);
        // The near-order chip comes later, in the line kept for it, so the row does not change height.
        if (row.state !== 'done' || !out || row.next.length > 0) return;
        const done = row;
        const said = (text: string | null) => {
          if (!current() || rows[index] !== done) return;
          near.set(id(done), text);
          fill(tr, done);
        };
        const asked = host.triggers?.(out) ?? null;
        if (!asked) said(null);
        else asked.then((report) => said(report ? watchText(report, done.tickers) : null), () => said(null));
      },
    }).then(
      () => {
        if (!current() || rows.length === 0) return;
        finishedAt = host.now();
        summary.textContent = summaryText(rows, finishedAt);
      },
      (e: unknown) => {
        if (current() && !listed) message(`Cannot find the strategies. ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  };

  start(false);
  return () => {
    alive = false;
  };
}
