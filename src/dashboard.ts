// The `backtests` block: one table with every strategy in the vault. Pure; the host finds and runs the strategies.

import { blockDisplayName, extractBlocks } from './blocks.ts';
import { priceFailure, type PriceFailure } from './data.ts';
import type { Diagnostic } from './dsl.ts';
import type { AssetState } from './engine.ts';
import { isoDate, minus, pct } from './format.ts';
import { actionWord, barTime, mapLimit, statusFrom, timingPhrase, TIMINGS, type ListFix, type OrderRow } from './orders.ts';
import { sparkSeries, type SparkSeries } from './render-chart.ts';
import type { RunOutput } from './runner.ts';
import type { TriggerReport } from './trigger.ts';

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
# All strategies in the vault. To show only one folder, add: folder: Trading
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
      errors.push({ line, message: `${key} is also set on line ${before}` });
      return;
    }
    seen.set(key, line);
    const value = m[2].trim();
    if (key === 'folder') {
      const folder = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
      if (!folder) errors.push({ line, message: 'Write the folder after "folder:", for example "folder: Trading"' });
      else config.folder = folder;
    } else {
      const sort = SORTS.find((s) => s === value.toLowerCase());
      if (!sort) errors.push({ line, message: `"${value}" is not a sort order. Use return, drawdown, sharpe or name` });
      else config.sort = sort;
    }
  });
  return { config, errors };
}

/** Whether a note's vault path lies under the folder (capital letters do not matter). A null folder takes every note. */
export function inFolder(note: string, folder: string | null): boolean {
  return folder === null || note.toLowerCase().startsWith(`${folder.toLowerCase()}/`);
}

/** Where a row's block is: its note, its name, and the 0-based line its block opens on, when the finder knew it. */
interface Place {
  note: string;
  name: string;
  line?: number;
}

export interface PendingRow extends Place {
  state: 'running';
}

export interface FailedRow extends Place {
  state: 'failed';
  reason: string;
  /** The block's text, so a problem in it can be fixed from the table. */
  source?: string;
  /** Why its prices did not load, when a next step can put it right (data.ts). */
  failure?: PriceFailure;
}

/** The latest figures of one strategy, as plain values. */
export interface DoneRow extends Place {
  state: 'done';
  /** Return per year, as a fraction. */
  cagr: number;
  benchmark: { label: string; cagr: number };
  /** At or below 0, as a fraction. */
  maxDrawdown: number;
  sharpe: number;
  trades: number;
  /** What it holds, such as "Long SPY", "Short SPY", "Long 2 of 5" or "In cash". */
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
  /** The value of the strategy and of its benchmark, cut down to a sparkline's points. */
  spark: SparkSeries;
  /** How many tickers it trades, for the near-order chip. */
  tickers: number;
}

export type DashRow = PendingRow | FailedRow | DoneRow;

const MORE_AFTER = 3;

/** "Long SPY", "Short SPY", "Long 2 of 5", "Long 2, short 1 of 5" or "In cash"; a short held is listed as "SPY (short)". */
function holding(states: AssetState[]): { now: string; held: string[] } {
  const on = states.filter((s) => s.side !== null);
  const shorts = on.filter((s) => s.side === 'short').length;
  const side = shorts === 0 ? 'Long' : shorts === on.length ? 'Short' : null;
  const now =
    on.length === 0 ? 'In cash' : on.length === 1 ? `${side} ${on[0].name}` : side ? `${side} ${on.length} of ${states.length}` : `Long ${on.length - shorts}, short ${shorts} of ${states.length}`;
  return { now, held: on.map((s) => (s.side === 'short' ? `${s.name} (short)` : s.name)) };
}

/** The order the next-orders lines come in: what makes positions smaller first, as in today's orders, then what makes them larger. */
const LINE_KINDS = ['sell', 'cover', 'buy', 'short', 'add'] as const;

/**
 * "Sell TLT, GLD", "Buy to cover SPY", "Buy SPY at the next close", "Add QQQ", "Bought SPY at the last close": sells and
 * covers first, then buys and short sales, then adds to positions held. An order for the next open, the usual one, says
 * no time.
 */
export function nextLines(orders: OrderRow[]): string[] {
  // A later entry of a position built in steps is an add, on either side.
  const kindOf = (o: OrderRow): string => ((o.action === 'buy' || o.action === 'short') && !!o.step && o.step.k > 1 ? 'add' : o.action);
  return TIMINGS.flatMap((when) =>
    LINE_KINDS.flatMap((kind) => {
      const group = orders.filter((o) => o.when === when && kindOf(o) === kind);
      if (group.length === 0) return [];
      const more = group.length - MORE_AFTER;
      const named = `${group.slice(0, MORE_AFTER).map((o) => o.ticker).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
      return [`${actionWord(group[0])} ${named}${when === 'next open' ? '' : ` ${timingPhrase(when)}`}`];
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
    spark: sparkSeries(bt),
    tickers: bt.run.states.length,
  };
}

export function failedRow(note: string, name: string, error: unknown, source?: string): FailedRow {
  const failure = priceFailure(error);
  return { state: 'failed', note, name, reason: error instanceof Error ? error.message : String(error), ...(source === undefined ? {} : { source }), ...(failure ? { failure } : {}) };
}


/** Two decimals, with no "-0.00" for a value too small to show. */
const ratio = (x: number) => (Number.isFinite(x) ? minus((Math.round(x * 100) / 100 || 0).toFixed(2)) : '–');

/** The figures of a row as the table writes them. */
export function figures(row: DoneRow): { cagr: string; benchmark: string; maxDrawdown: string; sharpe: string; trades: string } {
  return { cagr: pct(row.cagr), benchmark: pct(row.benchmark.cagr), maxDrawdown: pct(row.maxDrawdown), sharpe: ratio(row.sharpe), trades: String(row.trades) };
}

export type SortKey = 'name' | 'return' | 'benchmark' | 'drawdown' | 'sharpe' | 'trades' | 'now' | 'next' | 'through';

export interface Column {
  /** The sort it gives, or null for a column that has none (the sparkline). */
  key: SortKey | null;
  label: string;
  /** Right-aligned figures. */
  num: boolean;
  /** Said when the pointer rests on the heading. */
  hint?: string;
}

/**
 * Six columns that fit a note: the trades go under the name, the benchmark's return under the strategy's, and the date of
 * the prices into the line above the table.
 */
export const COLUMNS: Column[] = [
  { key: 'name', label: 'Strategy', num: false },
  { key: null, label: '', num: false },
  { key: 'return', label: 'Return per year', num: true, hint: "The strategy's return per year, with the benchmark's under it" },
  { key: 'drawdown', label: 'Worst drawdown', num: true },
  { key: 'sharpe', label: 'Sharpe', num: true, hint: 'Sharpe ratio' },
  {
    key: 'next',
    label: 'Now and next',
    num: false,
    hint: 'What the strategy holds after the last bar, and its orders for the next open, if a line does not give a different time. A strategy with fill: close made the Bought and Sold orders at the last close',
  },
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
  /** Every strategy block in the vault. Called once when a round starts, with whether it is forced: the place to drop saved results. */
  find(force: boolean): Promise<(Place & { source: string })[]>;
  /** Runs one strategy, reusing a recent result. `force` fetches its prices again. `notePath` resolves DAG links. */
  run(source: string, force: boolean, notePath?: string): Promise<RunOutput>;
  /** Opens the note at the strategy's block, drawn open. */
  openBlock(note: string, name: string, line?: number): void;
  /** Asks for a starter strategy and makes a new note with it. */
  newNote(): void;
  now(): number;
  /** The trigger prices of a result `run` gave, for the near-order chip; null when there are none. */
  triggers?(out: RunOutput): Promise<TriggerReport | null> | null;
  /** What a strategy that did not run offers to put it right, as in today's orders (orders.ts ListFix); null when there is nothing. */
  fix?(row: FailedRow): ListFix | Promise<ListFix | null> | null;
}

/** Strategies run side by side, as in today's orders. */
export const DASHBOARD_CONCURRENCY = 3;

export interface Round {
  /** Gives the strategies found, all still running, and how many the vault holds before `folder` takes any out. */
  onList(rows: DashRow[], inVault: number): void;
  /** One strategy finished, by its place in the list, with its run when it ran. */
  onRow(index: number, row: DoneRow | FailedRow, out?: RunOutput): void;
  /** False once nothing should be drawn or started any more. */
  current(): boolean;
}

/**
 * Finds the strategies, then runs them a few at a time, reporting each as it finishes. A strategy that cannot run
 * becomes a row with its reason. Rejects only when the strategies cannot be listed.
 */
export async function runRound(host: DashboardHost, config: DashboardConfig, force: boolean, round: Round): Promise<void> {
  const found = await host.find(force);
  if (!round.current()) return;
  const list = found.filter((f) => inFolder(f.note, config.folder));
  const at = (f: Place) => (f.line === undefined ? {} : { line: f.line });
  round.onList(
    list.map((f) => ({ state: 'running', note: f.note, name: f.name, ...at(f) })),
    found.length,
  );
  await mapLimit(list, DASHBOARD_CONCURRENCY, async (f, i) => {
    if (!round.current()) return;
    let row: DoneRow | FailedRow;
    let out: RunOutput | undefined;
    try {
      out = await host.run(f.source, force, f.note);
      row = { ...rowFrom(f.note, f.name, out, host.now()), ...at(f) };
    } catch (e) {
      row = { ...failedRow(f.note, f.name, e, f.source), ...at(f) };
    }
    if (round.current()) round.onRow(i, row, out);
  });
}

const plural = (n: number) => `${n} ${n === 1 ? 'strategy' : 'strategies'}`;

function clock(t: number): string {
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${isoDate(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * The line above the table: how far the run has got, or how many strategies, the last bar of their prices and when the
 * figures were worked out: "5 strategies · prices through 2026-11-18 · calculated at 2026-11-18 22:41".
 */
export function summaryText(rows: DashRow[], finishedAt: number | null): string {
  if (finishedAt === null) return `The plugin runs ${rows.filter((r) => r.state !== 'running').length} of ${rows.length}…`;
  const done = rows.filter((r): r is DoneRow => r.state === 'done');
  const latest = done.length ? done.reduce((a, r) => (r.asOf > a.asOf ? r : a)) : null;
  return [plural(rows.length), ...(latest ? [`prices through ${latest.through}`] : []), `calculated at ${clock(finishedAt)}`].join(' \u00b7 ');
}

/** The message in place of the table when there is nothing to list. */
export function emptyText(config: DashboardConfig, inVault: number): string {
  if (inVault === 0) return 'The vault has no strategy blocks.';
  return `The folder "${config.folder}" has no strategy blocks. Make sure that its name is correct, or remove the folder line.`;
}

export interface FoundStrategy {
  note: string;
  name: string;
  source: string;
  /** The 0-based line of the note that the block's opening fence is on. */
  line: number;
}

/** Sections of a note that cannot hold a fenced block. Anything else, or a kind not listed, might. */
const PLAIN_SECTIONS = ['heading', 'paragraph', 'thematicBreak', 'yaml', 'table', 'html', 'text', 'element'];

/**
 * Whether a note might hold a strategy block, from the kinds of section Obsidian found in it (null while it has not read the
 * note yet). A block in a list, a callout or a quote has no section of its own, only that of the list, callout or quote.
 */
export function mayHoldStrategy(sections: readonly string[] | null): boolean {
  return sections === null || sections.some((type) => !PLAIN_SECTIONS.includes(type));
}

/** Notes read between pauses that let the window redraw. */
export const NOTES_PER_PAUSE = 50;

export interface VaultNotes<N> {
  /** The kinds of section the note has, from what Obsidian already knows; null when it does not know yet. */
  sections(note: N): readonly string[] | null;
  read(note: N): Promise<string>;
  /** Gives the window a moment to redraw. */
  pause(): Promise<void>;
}

/**
 * Every strategy block in the notes, or every block of `lang`. Notes that cannot hold one are not read, and the reading
 * pauses now and then so a large vault does not freeze the window.
 */
export async function findStrategies<N extends { path: string; basename: string }>(notes: readonly N[], vault: VaultNotes<N>, lang = 'strategy'): Promise<FoundStrategy[]> {
  const found: FoundStrategy[] = [];
  let read = 0;
  for (const note of notes) {
    if (!mayHoldStrategy(vault.sections(note))) continue;
    if (++read % NOTES_PER_PAUSE === 0) await vault.pause();
    const text = await vault.read(note);
    if (!text.includes(lang)) continue;
    extractBlocks(text, lang).forEach((b, i, all) => found.push({ note: note.path, name: blockDisplayName(note.basename, b.name, i, all.length), source: b.source, line: b.line }));
  }
  return found;
}
