// The `backtests` block: one table with every strategy in the vault. Pure; the host finds and runs the strategies.

import { isoDate, minus, pct } from './dom.ts';
import type { Diagnostic } from './dsl.ts';
import type { AssetState } from './engine.ts';
import { actionWord, barTime, mapLimit, statusFrom, timingPhrase, TIMINGS, type OrderRow } from './orders.ts';
import type { RunOutput } from './runner.ts';

export const SORTS = ['return', 'drawdown', 'sharpe', 'name'] as const;
export type DashboardSort = (typeof SORTS)[number];

export interface DashboardConfig {
  /** Only notes under this folder; null for the whole vault. */
  folder: string | null;
  /** What the table is sorted by to begin with. */
  sort: DashboardSort;
}

/** The text inserted by the command "Insert strategy dashboard". */
export const DASHBOARD_TEMPLATE = `\`\`\`backtests
# Every strategy in the vault. To list one folder only, add: folder: Trading
sort: return
\`\`\`
`;

const SETTINGS = 'The two settings are folder (for example "folder: Trading") and sort (return, drawdown, sharpe or name)';
const LINE = /^([A-Za-z]+)\s*:\s*(.*)$/;

/** Reads the lines of a `backtests` block. `config` holds every setting that was read, even when `errors` is not empty. */
export function parseDashboard(source: string): { config: DashboardConfig; errors: Diagnostic[] } {
  const config: DashboardConfig = { folder: null, sort: 'name' };
  const errors: Diagnostic[] = [];
  const seen = new Map<string, number>();
  source.split(/\r?\n/).forEach((raw, i) => {
    const text = raw.trim();
    if (!text || text.startsWith('#')) return;
    const line = i + 1;
    const m = text.match(LINE);
    const key = m?.[1].toLowerCase();
    if (!m || (key !== 'folder' && key !== 'sort')) {
      errors.push({ line, message: `This line is not a setting. ${SETTINGS}` });
      return;
    }
    const before = seen.get(key);
    if (before !== undefined) {
      errors.push({ line, message: `${key} is already set on line ${before}` });
      return;
    }
    seen.set(key, line);
    const value = m[2].trim();
    if (key === 'folder') {
      const folder = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
      if (!folder) errors.push({ line, message: 'Write the folder after "folder:", such as "folder: Trading"' });
      else config.folder = folder;
    } else {
      const sort = SORTS.find((s) => s === value.toLowerCase());
      if (!sort) errors.push({ line, message: `"${value}" is not a way to sort. Use return, drawdown, sharpe or name` });
      else config.sort = sort;
    }
  });
  return { config, errors };
}

/** Whether a note's vault path lies under the folder (capital letters do not matter). A null folder takes every note. */
export function inFolder(note: string, folder: string | null): boolean {
  return folder === null || note.toLowerCase().startsWith(`${folder.toLowerCase()}/`);
}

export interface PendingRow {
  state: 'running';
  note: string;
  name: string;
}

export interface FailedRow {
  state: 'failed';
  note: string;
  name: string;
  reason: string;
}

/** The latest figures of one strategy, as plain values. */
export interface DoneRow {
  state: 'done';
  note: string;
  name: string;
  /** Return per year, as a fraction. */
  cagr: number;
  benchmark: { label: string; cagr: number };
  /** At or below 0, as a fraction. */
  maxDrawdown: number;
  sharpe: number;
  trades: number;
  /** What it holds, such as "Long SPY", "Long 2 of 5" or "In cash". */
  now: string;
  /** The tickers held now. */
  held: string[];
  /** The orders in words, one line for each of selling and buying at each timing; empty for none. */
  next: string[];
  orders: number;
  /** The last bar the figures rest on, such as "2026-11-13". */
  through: string;
  asOf: number;
  /** The prices are probably out of date. */
  stale: boolean;
}

export type DashRow = PendingRow | FailedRow | DoneRow;

const MORE_AFTER = 3;

function holding(states: AssetState[]): { now: string; held: string[] } {
  const held = states.filter((s) => s.long).map((s) => s.name);
  const now = held.length === 0 ? 'In cash' : held.length === 1 ? `Long ${held[0]}` : `Long ${held.length} of ${states.length}`;
  return { now, held };
}

/**
 * "Sell TLT, GLD", "Buy SPY at the next close", "Bought SPY at the last close": sells first, as in today's orders.
 * An order for the next open, the usual one, says no time.
 */
function nextLines(orders: OrderRow[]): string[] {
  return TIMINGS.flatMap((when) =>
    (['sell', 'buy'] as const).flatMap((action) => {
      const tickers = orders.filter((o) => o.when === when && o.action === action).map((o) => o.ticker);
      if (tickers.length === 0) return [];
      const more = tickers.length - MORE_AFTER;
      const named = `${tickers.slice(0, MORE_AFTER).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
      return [`${actionWord({ action, when })} ${named}${when === 'next open' ? '' : ` ${timingPhrase(when)}`}`];
    }),
  );
}

export function rowFrom(note: string, name: string, out: RunOutput, now: number): DoneRow {
  const { backtest: bt } = out;
  const status = statusFrom(note, name, out, now);
  return {
    state: 'done',
    note,
    name,
    cagr: bt.stats.cagr,
    benchmark: { label: bt.benchmark.label, cagr: bt.benchmark.stats.cagr },
    maxDrawdown: bt.stats.maxDrawdown,
    sharpe: bt.stats.sharpe,
    trades: bt.tradeStats.count,
    ...holding(bt.run.states),
    next: nextLines(status.orders),
    orders: status.orders.length,
    through: barTime(status, status.asOf),
    asOf: status.asOf,
    stale: status.stale,
  };
}

export function failedRow(note: string, name: string, error: unknown): FailedRow {
  return { state: 'failed', note, name, reason: error instanceof Error ? error.message : String(error) };
}

export const failureText = (row: FailedRow): string => `Couldn't run. ${row.reason}`;

/** Two decimals, with no "-0.00" for a value too small to show. */
const ratio = (x: number) => (Number.isFinite(x) ? minus((Math.round(x * 100) / 100 || 0).toFixed(2)) : '–');

/** The figures of a row as the table writes them. */
export function figures(row: DoneRow): { cagr: string; benchmark: string; maxDrawdown: string; sharpe: string; trades: string } {
  return { cagr: pct(row.cagr), benchmark: pct(row.benchmark.cagr), maxDrawdown: pct(row.maxDrawdown), sharpe: ratio(row.sharpe), trades: String(row.trades) };
}

export type SortKey = 'name' | 'return' | 'benchmark' | 'drawdown' | 'sharpe' | 'trades' | 'now' | 'next' | 'through';

export interface Column {
  key: SortKey;
  label: string;
  /** Right-aligned figures. */
  num: boolean;
  /** Said when the pointer rests on the heading. */
  hint?: string;
}

export const COLUMNS: Column[] = [
  { key: 'name', label: 'Strategy', num: false },
  { key: 'return', label: 'Return per year', num: true },
  { key: 'benchmark', label: 'Benchmark per year', num: true, hint: "The benchmark's return per year. Its name is under each figure." },
  { key: 'drawdown', label: 'Worst drawdown', num: true },
  { key: 'sharpe', label: 'Sharpe ratio', num: true },
  { key: 'trades', label: 'Trades', num: true },
  { key: 'now', label: 'Now', num: false, hint: 'What the strategy holds after the last bar' },
  { key: 'next', label: 'Next', num: false, hint: 'Orders for the next open, unless a line gives another time. Bought and Sold were made at the last close by a strategy with fill: close' },
  { key: 'through', label: 'Prices through', num: false, hint: 'The last bar the figures rest on' },
];

export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

/** Words sort from A, and everything else starts with the best or latest: the highest return, the smallest drawdown, the most orders, the newest prices. */
const WORDS: SortKey[] = ['name', 'now'];
const firstDirection = (key: SortKey): SortState['dir'] => (WORDS.includes(key) ? 'asc' : 'desc');

export const initialSort = (sort: DashboardSort): SortState => ({ key: sort, dir: firstDirection(sort) });

/** Clicking the column that is sorted reverses it; clicking another sorts by that one. */
export function toggleSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: firstDirection(key) };
}

const compare = (a: string, b: string) => a.localeCompare(b, 'en');
const byName = (a: DashRow, b: DashRow) => compare(a.name, b.name) || compare(a.note, b.note);

function valueOf(row: DoneRow, key: SortKey): number | string | null {
  const value = {
    name: row.name,
    return: row.cagr,
    benchmark: row.benchmark.cagr,
    drawdown: row.maxDrawdown,
    sharpe: row.sharpe,
    trades: row.trades,
    now: row.now,
    next: row.orders,
    through: row.asOf,
  }[key];
  return typeof value === 'number' && !Number.isFinite(value) ? null : value;
}

/**
 * The rows in the order the table shows them. Strategies that ran come first, by the chosen column and then by name;
 * those without a figure for it come after them, then the ones that could not run, then the ones still running.
 */
export function sortRows(rows: DashRow[], sort: SortState): DashRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const done = rows.filter((r): r is DoneRow => r.state === 'done');
  const known = done.filter((r) => valueOf(r, sort.key) !== null);
  known.sort((a, b) => {
    const x = valueOf(a, sort.key)!;
    const y = valueOf(b, sort.key)!;
    const order = typeof x === 'string' ? compare(x, y as string) : x - (y as number);
    return sign * order || byName(a, b);
  });
  const unknown = done.filter((r) => valueOf(r, sort.key) === null).sort(byName);
  const failed = rows.filter((r) => r.state === 'failed').sort(byName);
  const running = rows.filter((r) => r.state === 'running').sort(byName);
  return [...known, ...unknown, ...failed, ...running];
}

export interface DashboardHost {
  /** Every strategy block in the vault. */
  find(): Promise<{ note: string; name: string; source: string }[]>;
  /** Runs one strategy, reusing a recent result. `force` drops saved results first. */
  run(source: string, force: boolean): Promise<RunOutput>;
  openNote(path: string): void;
  now(): number;
}

/** Strategies run side by side, as in today's orders. */
export const DASHBOARD_CONCURRENCY = 3;

export interface Round {
  /** Gives the strategies found, all still running, and how many the vault holds before `folder` takes any out. */
  onList(rows: DashRow[], inVault: number): void;
  /** One strategy finished, by its place in the list. */
  onRow(index: number, row: DoneRow | FailedRow): void;
  /** False once nothing should be drawn or started any more. */
  current(): boolean;
}

/**
 * Finds the strategies, then runs them a few at a time, reporting each as it finishes. A strategy that cannot run
 * becomes a row with its reason. Rejects only when the strategies cannot be listed.
 */
export async function runRound(host: DashboardHost, config: DashboardConfig, force: boolean, round: Round): Promise<void> {
  const found = await host.find();
  if (!round.current()) return;
  const list = found.filter((f) => inFolder(f.note, config.folder));
  round.onList(
    list.map((f) => ({ state: 'running', note: f.note, name: f.name })),
    found.length,
  );
  await mapLimit(list, DASHBOARD_CONCURRENCY, async (f, i) => {
    if (!round.current()) return;
    let row: DoneRow | FailedRow;
    try {
      row = rowFrom(f.note, f.name, await host.run(f.source, force), host.now());
    } catch (e) {
      row = failedRow(f.note, f.name, e);
    }
    if (round.current()) round.onRow(i, row);
  });
}

const plural = (n: number) => `${n} ${n === 1 ? 'strategy' : 'strategies'}`;

function clock(t: number): string {
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${isoDate(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The line under the table: how many strategies, then how far the run has got or when the figures were worked out. */
export function summaryText(rows: DashRow[], finishedAt: number | null): string {
  if (finishedAt === null) return `Running ${rows.filter((r) => r.state !== 'running').length} of ${rows.length}…`;
  return `${plural(rows.length)}. Figures worked out ${clock(finishedAt)}.`;
}

/** The message in place of the table when there is nothing to list. */
export function emptyText(config: DashboardConfig, inVault: number): string {
  if (inVault === 0) return 'No strategy blocks found in the vault. Add one with the command "Insert strategy block".';
  return `No strategy blocks found in the folder "${config.folder}". Check its name, or remove the folder line.`;
}
