// The `backtests` block: a table of every strategy in the vault, filled in as each one finishes.

import {
  COLUMNS,
  emptyText,
  failureText,
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
  type SortKey,
} from './dashboard.ts';
import { h } from './dom.ts';
import type { Diagnostic } from './dsl.ts';

export type { DashboardHost } from './dashboard.ts';

export function renderDashboardErrors(parent: HTMLElement, errors: Diagnostic[], source: string): void {
  const root = h(parent, 'div', 'bt-root');
  h(root, 'div', 'bt-error-title', errors.length === 1 ? "This dashboard can't run yet" : `This dashboard can't run yet: ${errors.length} problems`);
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

const noteName = (path: string) => path.replace(/^.*\//, '').replace(/\.md$/i, '');
const DASH = '–';

/** Draws the dashboard into `el` and starts running the strategies. Returns a cleanup function: once called, nothing more is drawn. */
export function renderDashboard(el: HTMLElement, source: string, host: DashboardHost): () => void {
  el.replaceChildren();
  const { config, errors } = parseDashboard(source);
  if (errors.length) {
    renderDashboardErrors(el, errors, source);
    return () => {};
  }

  const root = h(el, 'div', 'bt-root bt-dash');
  h(root, 'div', 'bt-title', config.folder === null ? 'Strategies' : `Strategies in ${config.folder}`);
  const body = h(root, 'div', 'bt-dash-body');
  const foot = h(root, 'div', 'bt-dash-foot');
  const summary = h(foot, 'span', 'bt-dash-summary');
  const again = h(foot, 'button', 'bt-button', 'Run again');
  again.addEventListener('click', () => start(true));

  let alive = true;
  let round = 0;
  let rows: DashRow[] = [];
  let finishedAt: number | null = null;
  let sort = initialSort(config.sort);
  let heads: { key: SortKey; th: HTMLElement }[] = [];
  let tbody: HTMLElement | null = null;

  const message = (text: string): void => {
    body.replaceChildren();
    heads = [];
    tbody = null;
    h(body, 'div', 'bt-note', text);
  };

  const markSort = (): void => {
    for (const { key, th } of heads) th.setAttribute('aria-sort', key === sort.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  };

  const nameCell = (tr: HTMLElement, row: DashRow): void => {
    const cell = h(tr, 'td', 'bt-dash-first');
    const link = h(cell, 'button', 'bt-dash-link');
    link.title = `Open ${row.note}`;
    link.addEventListener('click', () => host.openNote(row.note));
    h(link, 'span', 'bt-dash-name', row.name);
    h(link, 'span', 'bt-dash-notename', noteName(row.note));
  };

  const messageRow = (tbody: HTMLElement, row: DashRow, text: string, cls: string): void => {
    const tr = h(tbody, 'tr', cls);
    nameCell(tr, row);
    const cell = h(tr, 'td', 'bt-dash-msg');
    cell.colSpan = COLUMNS.length - 1;
    h(cell, 'div', 'bt-dash-msgtext', text);
  };

  const doneRow = (tbody: HTMLElement, row: DoneRow): void => {
    const tr = h(tbody, 'tr');
    nameCell(tr, row);
    const f = figures(row);
    h(tr, 'td', 'bt-num', f.cagr);
    const bench = h(tr, 'td', 'bt-num');
    h(bench, 'div', undefined, f.benchmark);
    h(bench, 'div', 'bt-dash-sub', row.benchmark.label).title = row.benchmark.label;
    h(tr, 'td', 'bt-num', f.maxDrawdown);
    h(tr, 'td', 'bt-num', f.sharpe);
    h(tr, 'td', 'bt-num', f.trades);
    const now = h(tr, 'td', 'bt-dash-now', row.now);
    if (row.held.length > 0) now.title = row.held.join(', ');
    const next = h(tr, 'td', 'bt-dash-next');
    if (row.next.length === 0) h(next, 'span', 'bt-dash-none', DASH);
    for (const line of row.next) h(next, 'div', undefined, line);
    const through = h(tr, 'td', 'bt-dash-through');
    h(through, 'div', undefined, row.through);
    if (row.stale) h(through, 'div', 'bt-dash-sub', 'may be old');
  };

  const drawRows = (): void => {
    if (tbody === null) return;
    tbody.replaceChildren();
    for (const row of sortRows(rows, sort)) {
      if (row.state === 'done') doneRow(tbody, row);
      else if (row.state === 'failed') messageRow(tbody, row, failureText(row), 'bt-dash-failed');
      else messageRow(tbody, row, 'Running…', 'bt-dash-running');
    }
    summary.textContent = summaryText(rows, finishedAt);
  };

  const drawTable = (): void => {
    body.replaceChildren();
    const wrap = h(body, 'div', 'bt-wide bt-dash-wide');
    const table = h(wrap, 'table', 'bt-table bt-dash-table');
    table.setAttribute('aria-label', 'Strategies');
    const tr = h(h(table, 'thead'), 'tr');
    heads = COLUMNS.map((c) => {
      const th = h(tr, 'th', c.num ? 'bt-num' : c.key === 'name' ? 'bt-dash-first' : undefined);
      th.scope = 'col';
      const button = h(th, 'button', 'bt-dash-sort', c.label);
      if (c.hint) button.title = c.hint;
      button.addEventListener('click', () => {
        sort = toggleSort(sort, c.key);
        markSort();
        drawRows();
      });
      return { key: c.key, th };
    });
    markSort();
    tbody = h(table, 'tbody');
  };

  const start = (force: boolean): void => {
    const mine = ++round;
    const current = () => alive && mine === round;
    finishedAt = null;
    rows = [];
    summary.textContent = '';
    message('Looking for strategies…');
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
        drawRows();
      },
      onRow(index, row) {
        rows[index] = row;
        drawRows();
      },
    }).then(
      () => {
        if (!current() || rows.length === 0) return;
        finishedAt = host.now();
        summary.textContent = summaryText(rows, finishedAt);
      },
      (e: unknown) => {
        if (current() && !listed) message(`Couldn't list the strategies. ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  };

  start(false);
  return () => {
    alive = false;
  };
}
