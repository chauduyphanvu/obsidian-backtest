import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { extractBlocks } from '../src/blocks.ts';
import {
  COLUMNS,
  DASHBOARD_CONCURRENCY,
  DASHBOARD_TEMPLATE,
  emptyText,
  failedRow,
  failureText,
  figures,
  inFolder,
  initialSort,
  parseDashboard,
  rowFrom,
  runRound,
  sortRows,
  summaryText,
  toggleSort,
  type DashRow,
  type DashboardHost,
  type DoneRow,
  type SortState,
} from '../src/dashboard.ts';
import { parseSpec } from '../src/dsl.ts';
import type { RunOutput } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY, T0 } from './helpers.ts';

function run(src: string, data: Record<string, Bars>): RunOutput {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  const map = new Map(Object.entries(data));
  return { spec: spec!, backtest: runBacktest(spec!, map), data: map, warnings: [], prices: [] };
}
const local = (y: number, m: number, d: number, hour = 12, minute = 0) => new Date(y, m - 1, d, hour, minute).getTime();
const NOW = local(2020, 1, 4);

// ---- the block's text

test('an empty block is valid and lists everything by name', () => {
  for (const source of ['', '\n\n', '# nothing but a comment\n']) {
    assert.deepEqual(parseDashboard(source), { config: { folder: null, sort: 'name' }, errors: [] });
  }
});

test('folder and sort are read, whatever the capitals, spacing and slashes', () => {
  assert.deepEqual(parseDashboard('folder: Trading\nsort: return').config, { folder: 'Trading', sort: 'return' });
  assert.deepEqual(parseDashboard('  SORT :  Sharpe  \nFolder:/My notes/Trades/ ').config, { folder: 'My notes/Trades', sort: 'sharpe' });
  assert.deepEqual(parseDashboard('# which ones\nfolder: A\\B\n\nsort: drawdown').errors, []);
  assert.equal(parseDashboard('folder: A\\B').config.folder, 'A/B');
  for (const sort of ['return', 'drawdown', 'sharpe', 'name']) assert.equal(parseDashboard(`sort: ${sort}`).config.sort, sort);
});

test('an unknown line is an error that names both settings, with its line number', () => {
  const { errors } = parseDashboard('sort: return\nshow: everything\nfolder\ncolumns: all');
  assert.deepEqual(errors.map((e) => e.line), [2, 3, 4]);
  for (const e of errors) {
    assert.match(e.message, /folder/);
    assert.match(e.message, /sort/);
    assert.match(e.message, /not a setting/);
  }
});

test('a sort that is not one of the four, an empty folder and a repeated setting are errors', () => {
  const { config, errors } = parseDashboard('sort: best\nfolder:\nfolder: A\nfolder: B\nsort: name');
  assert.deepEqual(errors, [
    { line: 1, message: '"best" is not a way to sort. Use return, drawdown, sharpe or name' },
    { line: 2, message: 'Write the folder after "folder:", such as "folder: Trading"' },
    { line: 3, message: 'folder is already set on line 2' },
    { line: 4, message: 'folder is already set on line 2' },
    { line: 5, message: 'sort is already set on line 1' },
  ]);
  assert.equal(config.sort, 'name');
  assert.equal(parseDashboard('folder: /').errors.length, 1);
});

test('the ready-made block is valid and is found as a backtests block', () => {
  assert.deepEqual(parseDashboard(DASHBOARD_TEMPLATE.split('\n').slice(1, -2).join('\n')).errors, []);
  const found = extractBlocks(`Some text\n\n${DASHBOARD_TEMPLATE}\nMore`, 'backtests');
  assert.equal(found.length, 1);
  assert.deepEqual(parseDashboard(found[0].source), { config: { folder: null, sort: 'return' }, errors: [] });
});

test('a folder takes the notes under it, not a folder that only starts with the same letters', () => {
  assert.equal(inFolder('Trading/Trend.md', 'Trading'), true);
  assert.equal(inFolder('trading/Deep/Trend.md', 'Trading'), true);
  assert.equal(inFolder('Trading notes/Trend.md', 'Trading'), false);
  assert.equal(inFolder('Trading.md', 'Trading'), false);
  assert.equal(inFolder('Other/Trading/Trend.md', 'Trading'), false);
  assert.equal(inFolder('Trading/Deep/Trend.md', 'Trading/Deep'), true);
  assert.equal(inFolder('Anywhere/x.md', null), true);
});

// ---- one run as a row

test('a block whose lines end in a carriage return reads as without it', () => {
  const lines = ['# which ones', 'folder: Trading', 'sort: drawdown', 'sort: name', 'colour: red', ''];
  const crlf = parseDashboard(lines.join('\r\n'));
  assert.deepEqual(crlf, parseDashboard(lines.join('\n')));
  assert.deepEqual(crlf.config, { folder: 'Trading', sort: 'drawdown' });
  assert.deepEqual(crlf.errors.map((e) => e.line), [4, 5]);
});

test('a strategy that holds one ticker says "Long" and the ticker', () => {
  const row = rowFrom('Trading/Trend.md', 'Trend', run('universe: A\ncapital: 1000\nbuy when true', { A: bars([10, 10, 12, 15]) }), NOW);
  assert.equal(row.now, 'Long A');
  assert.deepEqual(row.held, ['A']);
  assert.deepEqual(row.next, []);
  assert.equal(row.orders, 0);
  assert.equal(row.trades, 0);
  assert.equal(row.through, '2020-01-04');
  assert.equal(row.asOf, T0 + 3 * DAY);
  assert.equal(row.note, 'Trading/Trend.md');
  assert.equal(row.name, 'Trend');
});

test('a strategy in cash says so', () => {
  const row = rowFrom('n.md', 'S', run('universe: A\nbuy when close > 100', { A: bars([10, 10, 10]) }), NOW);
  assert.equal(row.now, 'In cash');
  assert.deepEqual(row.held, []);
});

test('with several tickers it counts how many are held', () => {
  const data = { A: bars([10, 10, 10, 10]), B: bars([10, 10, 10, 10]), C: bars([10, 10, 10, 10]) };
  assert.equal(rowFrom('n.md', 'S', run('universe: A, B, C\nbuy when close > 5', data), NOW).now, 'Long 3 of 3');
  const one = rowFrom('n.md', 'S', run('universe: A, B, C\nbuy when close > 5\nfor B:\n  buy when close > 50\nfor C:\n  buy when close > 50', data), NOW);
  assert.equal(one.now, 'Long A');
  assert.deepEqual(one.held, ['A']);
});

test('the next orders are written in words, sells first, and a long list is cut', () => {
  // Z is bought on day 1 and its sell rule fires at the last close; A's buy rule first holds then.
  const mixed = rowFrom('n.md', 'S', run('universe: A, Z\ncapital: 1000\nbuy when close > 9\nsell when close < 9', { A: bars([8, 8, 8, 10]), Z: bars([10, 10, 10, 8]) }), NOW);
  assert.deepEqual(mixed.next, ['Sell Z', 'Buy A']);
  assert.equal(mixed.orders, 2);
  assert.equal(mixed.now, 'Long Z');

  const names = ['A', 'B', 'C', 'D', 'E'];
  const closes = bars([5, 5, 20]);
  const many = rowFrom('n.md', 'S', run(`universe: ${names.join(', ')}\nbuy when close > 10`, Object.fromEntries(names.map((n) => [n, closes]))), NOW);
  assert.deepEqual(many.next, ['Buy A, B, C and 2 more']);
  assert.equal(many.orders, 5);
});

test('the next orders give a time unless it is the next open, and what filled at the last close is said in the past', () => {
  const next = (src: string, data: Record<string, Bars>) => rowFrom('n.md', 'S', run(src, data), NOW);
  // The usual order says no time; the column's hint says it is for the next open.
  assert.deepEqual(next('universe: A\ncapital: 1000\nbuy when close > 11', { A: bars([10, 10, 12]) }).next, ['Buy A']);
  const bought = next('universe: A\ncapital: 1000\nfill: close\nbuy when close > 11', { A: bars([10, 10, 12]) });
  assert.deepEqual([bought.next, bought.orders, bought.now], [['Bought A at the last close'], 1, 'Long A']);
  const swap = next('universe: A, Z\ncapital: 1000\nfill: close\nbuy when close > 9\nsell when close < 9', { A: bars([8, 8, 8, 10]), Z: bars([10, 10, 10, 8]) });
  assert.deepEqual([swap.next, swap.orders], [['Sold Z at the last close', 'Bought A at the last close'], 2]);
  const names = ['A', 'B', 'C', 'D', 'E'];
  const many = next(`universe: ${names.join(', ')}\nfill: close\nbuy when close > 10`, Object.fromEntries(names.map((n) => [n, bars([5, 5, 20])])));
  assert.deepEqual(many.next, ['Bought A, B, C and 2 more at the last close']);
  assert.equal(next('universe: A\nfill: close\nbuy when true', { A: bars([10, 10, 12, 15]) }).next.length, 0);
  assert.match(COLUMNS.find((c) => c.key === 'next')!.hint!, /next open.*another time.*Bought and Sold.*last close/);
});

test('an order a close-fill ranking could not fill yet is for the next close', () => {
  const days = (weekdays: boolean) => {
    const out: number[] = [];
    for (let t = Date.UTC(2020, 0, 27); t <= Date.UTC(2020, 1, 29); t += DAY) if (!weekdays || ![0, 6].includes(new Date(t).getUTCDay())) out.push(t);
    return out;
  };
  const [stkT, cryT] = [days(true), days(false)];
  const data = { STK: bars(stkT.map(() => 100), { times: stkT }), CRY: bars(cryT.map((t) => (t < Date.UTC(2020, 1, 29) ? 50 : 150)), { times: cryT }) };
  const row = rowFrom('n.md', 'S', run('universe: STK, CRY\ncapital: 1000\nfill: close\nrebalance: monthly\nhold: top 1 by close', data), local(2020, 3, 1));
  assert.deepEqual(row.next, ['Sell STK at the next close', 'Buy CRY at the next close']);
});

test('the figures come from the run and the prices are called old after four days', () => {
  const out = run('universe: A\ncapital: 1000\nbuy when true', { A: bars([10, 10, 12, 15]) });
  const row = rowFrom('n.md', 'S', out, NOW);
  assert.equal(row.cagr, out.backtest.stats.cagr);
  assert.equal(row.maxDrawdown, out.backtest.stats.maxDrawdown);
  assert.equal(row.sharpe, out.backtest.stats.sharpe);
  assert.deepEqual(row.benchmark, { label: out.backtest.benchmark.label, cagr: out.backtest.benchmark.stats.cagr });
  assert.equal(row.stale, false);
  assert.equal(rowFrom('n.md', 'S', out, local(2020, 1, 20)).stale, true);
});

test('trades counts closed trades only', () => {
  // Bought on day 1, sold on day 3 at a loss, then bought again and still held.
  const out = run('universe: A\nbuy when close > 9\nsell when close < 9', { A: bars([10, 10, 8, 8, 12, 12]) });
  assert.equal(rowFrom('n.md', 'S', out, NOW).trades, out.backtest.tradeStats.count);
  assert.equal(out.backtest.tradeStats.count, 1);
  assert.equal(out.backtest.tradeStats.open, 1);
});

test('figures are written like the result view, with a dash for what cannot be worked out', () => {
  const row: DoneRow = { ...done('A', 0.123456), maxDrawdown: -0.4567, sharpe: -0.001, trades: 12, benchmark: { label: 'SPY buy & hold', cagr: NaN } };
  assert.deepEqual(figures(row), { cagr: '12.3%', benchmark: '\u2013', maxDrawdown: '\u221245.7%', sharpe: '0.00', trades: '12' });
  assert.equal(figures({ ...row, sharpe: -1.234 }).sharpe, '\u22121.23');
  assert.equal(figures({ ...row, sharpe: NaN }).sharpe, '\u2013');
});

test('a failure keeps its reason, whether it was an Error or text', () => {
  assert.deepEqual(failedRow('n.md', 'S', new Error('Yahoo has no prices for XYZ. Check the ticker.')), {
    state: 'failed',
    note: 'n.md',
    name: 'S',
    reason: 'Yahoo has no prices for XYZ. Check the ticker.',
  });
  assert.equal(failedRow('n.md', 'S', 'boom').reason, 'boom');
  assert.equal(failureText(failedRow('n.md', 'S', new Error('Line 3: Unknown name'))), "Couldn't run. Line 3: Unknown name");
});

// ---- sorting

function done(name: string, cagr: number, more: Partial<DoneRow> = {}): DoneRow {
  return {
    state: 'done',
    note: `${name}.md`,
    name,
    cagr,
    benchmark: { label: 'SPY buy & hold', cagr: 0.08 },
    maxDrawdown: -0.2,
    sharpe: 0.5,
    trades: 5,
    now: 'In cash',
    held: [],
    next: [],
    orders: 0,
    through: '2020-01-03',
    asOf: T0,
    stale: false,
    ...more,
  };
}
const running = (name: string): DashRow => ({ state: 'running', note: `${name}.md`, name });
const failed = (name: string): DashRow => failedRow(`${name}.md`, name, new Error('x'));
const names = (rows: DashRow[]) => rows.map((r) => r.name);

test('the first sort sends words from A and figures from the best', () => {
  assert.deepEqual(initialSort('name'), { key: 'name', dir: 'asc' });
  for (const key of ['return', 'drawdown', 'sharpe'] as const) assert.deepEqual(initialSort(key), { key, dir: 'desc' });
});

test('rows sort by the chosen column, ties by name', () => {
  const rows = [done('B', 0.1), done('A', 0.1), done('C', 0.3), done('D', -0.2)];
  assert.deepEqual(names(sortRows(rows, initialSort('return'))), ['C', 'A', 'B', 'D']);
  assert.deepEqual(names(sortRows(rows, { key: 'return', dir: 'asc' })), ['D', 'A', 'B', 'C']);
  assert.deepEqual(names(sortRows(rows, initialSort('name'))), ['A', 'B', 'C', 'D']);
  assert.deepEqual(names(sortRows(rows, { key: 'name', dir: 'desc' })), ['D', 'C', 'B', 'A']);
});

test('a smaller drawdown is better and comes first', () => {
  const rows = [done('A', 0, { maxDrawdown: -0.5 }), done('B', 0, { maxDrawdown: -0.1 }), done('C', 0, { maxDrawdown: -0.3 })];
  assert.deepEqual(names(sortRows(rows, initialSort('drawdown'))), ['B', 'C', 'A']);
});

test('every column can be sorted', () => {
  const rows = [
    done('A', 0.1, { benchmark: { label: 'x', cagr: 0.05 }, sharpe: 1.2, trades: 3, now: 'Long SPY', orders: 0, asOf: T0 }),
    done('B', 0.2, { benchmark: { label: 'x', cagr: 0.09 }, sharpe: 0.4, trades: 9, now: 'In cash', orders: 2, asOf: T0 + DAY }),
    done('C', 0.3, { benchmark: { label: 'x', cagr: 0.01 }, sharpe: 0.8, trades: 6, now: 'Long 2 of 5', orders: 1, asOf: T0 + 2 * DAY }),
  ];
  const order = (key: SortState['key']) => names(sortRows(rows, { key, dir: key === 'now' ? 'asc' : 'desc' }));
  assert.deepEqual(order('benchmark'), ['B', 'A', 'C']);
  assert.deepEqual(order('sharpe'), ['A', 'C', 'B']);
  assert.deepEqual(order('trades'), ['B', 'C', 'A']);
  assert.deepEqual(order('now'), ['B', 'C', 'A']);
  assert.deepEqual(order('next'), ['B', 'C', 'A']);
  assert.deepEqual(order('through'), ['C', 'B', 'A']);
  assert.deepEqual(COLUMNS.map((c) => c.key).sort(), ['benchmark', 'drawdown', 'name', 'next', 'now', 'return', 'sharpe', 'through', 'trades']);
});

test('failed and unfinished rows stay at the bottom, whichever way the table is sorted', () => {
  const rows = [running('R2'), failed('F1'), done('B', 0.1), running('R1'), done('A', 0.3), failed('E0')];
  for (const dir of ['asc', 'desc'] as const) {
    for (const key of ['name', 'return', 'sharpe'] as const) {
      assert.deepEqual(names(sortRows(rows, { key, dir })).slice(2), ['E0', 'F1', 'R1', 'R2'], `${key} ${dir}`);
    }
  }
  assert.deepEqual(names(sortRows(rows, initialSort('return'))).slice(0, 2), ['A', 'B']);
});

test('a strategy with no figure for the column comes after those that have one, in either direction', () => {
  const rows = [done('A', NaN), done('B', 0.1), done('C', 0.3), done('D', NaN)];
  assert.deepEqual(names(sortRows(rows, { key: 'return', dir: 'desc' })), ['C', 'B', 'A', 'D']);
  assert.deepEqual(names(sortRows(rows, { key: 'return', dir: 'asc' })), ['B', 'C', 'A', 'D']);
});

test('sorting leaves its input alone', () => {
  const rows = [done('B', 0.1), done('A', 0.3)];
  const before = JSON.stringify(rows);
  sortRows(rows, initialSort('return'));
  assert.equal(JSON.stringify(rows), before);
});

test('clicking the sorted column reverses it and another column starts from its best', () => {
  let s = initialSort('return');
  s = toggleSort(s, 'return');
  assert.deepEqual(s, { key: 'return', dir: 'asc' });
  s = toggleSort(s, 'return');
  assert.deepEqual(s, { key: 'return', dir: 'desc' });
  s = toggleSort(s, 'name');
  assert.deepEqual(s, { key: 'name', dir: 'asc' });
  assert.deepEqual(toggleSort(s, 'sharpe'), { key: 'sharpe', dir: 'desc' });
  assert.deepEqual(toggleSort({ key: 'now', dir: 'asc' }, 'next'), { key: 'next', dir: 'desc' });
});

// ---- running the strategies

type Found = { note: string; name: string; source: string };
const found = (name: string, note = `${name}.md`): Found => ({ note, name, source: `universe: ${name}\nbuy when true` });

function fakeHost(list: Found[], opts: { fail?: string[]; gate?: () => Promise<void> } = {}) {
  const calls: { source: string; force: boolean }[] = [];
  let active = 0;
  let peak = 0;
  const host: DashboardHost = {
    find: async () => list,
    run: async (source, force) => {
      calls.push({ source, force });
      active++;
      peak = Math.max(peak, active);
      try {
        await (opts.gate ? opts.gate() : Promise.resolve());
        if (opts.fail?.some((f) => source.includes(`universe: ${f}`))) throw new Error('Yahoo has no prices. Check the ticker.');
        return run(source, { [source.match(/universe: (\w+)/)![1]]: bars([10, 10, 12, 15]) });
      } finally {
        active--;
      }
    },
    openNote: () => {},
    now: () => NOW,
  };
  return { host, calls, peak: () => peak };
}

function recorder(current: () => boolean = () => true) {
  const events: string[] = [];
  const state = { rows: [] as DashRow[], inVault: -1 };
  return {
    events,
    state,
    round: {
      current,
      onList(rows: DashRow[], inVault: number) {
        state.rows = rows;
        state.inVault = inVault;
        events.push(`list ${rows.length}`);
      },
      onRow(index: number, row: DoneRow | DashRow) {
        state.rows[index] = row;
        events.push(`${row.state} ${row.name}`);
      },
    },
  };
}

test('a round lists everything as running, then reports each strategy as it finishes', async () => {
  const { host } = fakeHost([found('A'), found('B'), found('C')]);
  const r = recorder();
  await runRound(host, { folder: null, sort: 'name' }, false, r.round);
  assert.equal(r.events[0], 'list 3');
  assert.deepEqual(r.events.slice(1).sort(), ['done A', 'done B', 'done C']);
  assert.deepEqual(r.state.rows.map((x) => x.state), ['done', 'done', 'done']);
  assert.equal(r.state.inVault, 3);
});

test('a strategy that cannot run becomes a row with its reason, and the others carry on', async () => {
  const { host } = fakeHost([found('A'), found('B'), found('C')], { fail: ['B'] });
  const r = recorder();
  await runRound(host, { folder: null, sort: 'name' }, false, r.round);
  assert.deepEqual(r.state.rows.map((x) => x.state), ['done', 'failed', 'done']);
  assert.equal((r.state.rows[1] as { reason: string }).reason, 'Yahoo has no prices. Check the ticker.');
});

test('the folder takes out other notes, and the vault count says how many there were', async () => {
  const { host, calls } = fakeHost([found('A', 'Trading/A.md'), found('B', 'Other/B.md'), found('C', 'Trading/Deep/C.md')]);
  const r = recorder();
  await runRound(host, { folder: 'Trading', sort: 'name' }, false, r.round);
  assert.deepEqual(r.state.rows.map((x) => x.name), ['A', 'C']);
  assert.equal(r.state.inVault, 3);
  assert.equal(calls.length, 2);

  const none = recorder();
  await runRound(host, { folder: 'Nowhere', sort: 'name' }, false, none.round);
  assert.deepEqual(none.events, ['list 0']);
  assert.match(emptyText({ folder: 'Nowhere', sort: 'name' }, none.state.inVault), /folder "Nowhere"/);
});

test('an empty vault says how to add a strategy', async () => {
  const { host } = fakeHost([]);
  const r = recorder();
  await runRound(host, { folder: null, sort: 'name' }, false, r.round);
  assert.deepEqual(r.events, ['list 0']);
  assert.equal(emptyText({ folder: null, sort: 'name' }, 0), 'No strategy blocks found in the vault. Add one with the command "Insert strategy block".');
});

test('force is passed on to every run', async () => {
  const { host, calls } = fakeHost([found('A'), found('B')]);
  await runRound(host, { folder: null, sort: 'name' }, true, recorder().round);
  assert.deepEqual(calls.map((c) => c.force), [true, true]);
  const second = fakeHost([found('A')]);
  await runRound(second.host, { folder: null, sort: 'name' }, false, recorder().round);
  assert.deepEqual(second.calls.map((c) => c.force), [false]);
});

test('no more than three strategies run at once', async () => {
  const gate = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  const list = Array.from({ length: 10 }, (_, i) => found(`T${i}`));
  const { host, peak, calls } = fakeHost(list, { gate });
  await runRound(host, { folder: null, sort: 'name' }, false, recorder().round);
  assert.equal(calls.length, 10);
  assert.equal(peak(), DASHBOARD_CONCURRENCY);
});

test('once the round is no longer current nothing more is drawn or started', async () => {
  let live = true;
  const gate = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  const list = Array.from({ length: 12 }, (_, i) => found(`T${i}`));
  const { host, calls } = fakeHost(list, { gate });
  const r = recorder(() => live);
  const finished = runRound(host, { folder: null, sort: 'name' }, false, r.round);
  await new Promise((resolve) => setTimeout(resolve, 8));
  live = false;
  const drawn = r.events.length;
  await finished;
  assert.equal(r.events.length, drawn);
  assert.ok(calls.length < 12, `${calls.length} runs were started`);
});

test('a round that is dropped while the vault is searched does not list anything', async () => {
  let live = true;
  const { host } = fakeHost([found('A')]);
  const slow: DashboardHost = {
    ...host,
    find: async () => {
      live = false;
      return host.find();
    },
  };
  const r = recorder(() => live);
  await runRound(slow, { folder: null, sort: 'name' }, false, r.round);
  assert.deepEqual(r.events, []);
});

test('when the strategies cannot be listed the round rejects with the reason', async () => {
  const host: DashboardHost = { ...fakeHost([]).host, find: async () => Promise.reject(new Error('Vault is closed')) };
  await assert.rejects(runRound(host, { folder: null, sort: 'name' }, false, recorder().round), /Vault is closed/);
});

// ---- the line under the table

test('the line under the table counts the strategies and says when the figures were worked out', () => {
  const rows = [done('A', 0.1), failed('B')];
  assert.equal(summaryText(rows, local(2026, 11, 17, 14, 5)), '2 strategies. Figures worked out 2026-11-17 14:05.');
  assert.equal(summaryText([done('A', 0.1)], local(2026, 1, 2, 9, 30)), '1 strategy. Figures worked out 2026-01-02 09:30.');
});

test('while it runs the line says how far it has got', () => {
  assert.equal(summaryText([done('A', 0.1), running('B'), running('C'), failed('D')], null), 'Running 2 of 4\u2026');
  assert.equal(summaryText([running('A')], null), 'Running 0 of 1\u2026');
});
