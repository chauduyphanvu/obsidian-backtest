// Forward tests: a strategy's rules frozen in a note the plugin owns, how the prices after that day have gone, and a log of the
// orders the rules gave. Pure; the caller reads the clock and the note's text and runs the strategy.

import { maxDrawdown } from './backtest.ts';
import { closesFence, extractBlocks, fenceOf, type Block } from './blocks.ts';
import { commentAt, parseSpec, type Commission, type Defaults, type Diagnostic } from './dsl.ts';
import { barAt, firstAtOrAfter, type RunResult } from './engine.ts';
import { isoDate, localDate, median, plural, price, stamp, tidy } from './format.ts';
import { hash } from './result-cache.ts';
import { NOTE_CHANGED } from './rewrite.ts';
import type { Bars } from './types.ts';

/** The note property that tells the plugin it made the note, as `ORDERS_MARKER` does for the orders note. */
export const FORWARD_MARKER = 'backtest_forward';

export const CHANGED = 'The rules or the start were changed after the forward test began, so this is no longer a forward test.';

/** A forward test is compared with earlier periods only from this many bars on. */
export const MIN_FORWARD_BARS = 5;
/** ...and only when the prices have this many times as many bars before the start as the test has had since. */
export const HISTORY_FACTOR = 3;

export type Refusal = { ok: false; message: string };

const FRONT_MATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const MARKER_LINE = new RegExp(`^${FORWARD_MARKER}:[ \\t]*true[ \\t]*$`);

/** Whether the note's properties say the plugin made it as a forward test. */
export function isForwardNote(note: string): boolean {
  const front = note.match(FRONT_MATTER);
  return front !== null && front[1].split(/\r?\n/).some((line) => MARKER_LINE.test(line));
}

/** The text a check is made of: the lines as a note holds them, whatever their endings and however many blank lines follow. */
const textOf = (source: string): string => source.replace(/\r/g, '').trimEnd();

/**
 * What the `check:` line holds for a forward test that started at `started` with a frozen text: an earlier start would
 * count bars already seen. It catches an edit by mistake; it is no protection against a deliberate one.
 */
export const checkOf = (source: string, started: number): string => hash(`${started}\n${textOf(source)}`).toString(36);

const WHEN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/;

/** A date, or a date and time of day (UTC, as everywhere in the plugin), as epoch milliseconds; null for anything else, such as 2026-02-30. */
function parseWhen(text: string): { t: number; intraday: boolean } | null {
  const m = text.match(WHEN);
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0'].map(Number);
  const t = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(t);
  const real = back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d && h < 24 && mi < 60;
  return real ? { t, intraday: m[4] !== undefined } : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Starting a forward test

/** `1`, `0.005 per share, min 1, max 1%`, or `0` for none: what `commission:` reads back as the same charge. */
function commissionText(c: Commission | undefined): string {
  if (!c) return '0';
  if (c.k === 'order') return plain(c.fee);
  return [`${plain(c.fee)} per share`, ...(c.min > 0 ? [`min ${plain(c.min)}`] : []), ...(c.max !== null ? [`max ${plain(tidy(c.max * 100))}%`] : [])].join(', ');
}

/** A number in plain digits that reads back as the very same number: the language reads no exponent. */
const plain = (x: number): string => x.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });

/** The name rule the parser reads a setting line with (dsl.ts keeps it to itself). */
const SETTING_NAME = /^([A-Za-z]+(?: +[A-Za-z]+)*)\s*:/;

/** Which of the settings the block writes itself, and whether its last line sits in a `for TICKER:` section, where settings are refused. */
function scan(source: string, keys: string[]): { given: Set<string>; scoped: boolean } {
  const given = new Set<string>();
  let scoped = false;
  for (const raw of source.split(/\r?\n/)) {
    const comment = commentAt(raw);
    const text = (comment < 0 ? raw : raw.slice(0, comment)).trim();
    const name = /^for\s/i.test(text) && text.endsWith(':') ? text.slice(4, -1).trim() : '';
    if (name) {
      scoped = name.toLowerCase() !== 'all';
      continue;
    }
    const key = text.match(SETTING_NAME)?.[1].toLowerCase().replace(/\s+/g, ' ');
    if (key !== undefined && keys.includes(key)) given.add(key);
  }
  return { given, scoped };
}

export interface ForwardStart {
  /** The strategy as shown, with the slider values already written into it. */
  source: string;
  /** The plugin defaults in force now. */
  defaults: Defaults;
  /** The time of the last bar the result had: the forward test is the bars after it. */
  started: number;
  /** Whether the strategy's bars are inside a day, so `started` is written with the time of day. */
  intraday: boolean;
  /** Where the strategy was taken from: `[[Note#Name]]`. */
  link: string;
  /** The name for the note's heading. */
  name: string;
}

/**
 * The strategy's text with the plugin defaults it leaves open written down as settings, so a later change to the
 * settings can't move a running test. A setting the block already writes is left as it is, since a second one is an error.
 * The lines go at the end, because a parameter's line number is part of the spec and must not move.
 */
export function pinDefaults(source: string, defaults: Defaults): string {
  const pins: [string, string][] = [
    ['capital', plain(defaults.capital)],
    ['costs', `${plain(defaults.costBps)} bps`],
    ['slippage', `${plain(defaults.slippageBps)} bps`],
    ['commission', commissionText(defaults.commission)],
    ['cash rate', defaults.cashRate.trim()],
    ['data', defaults.dataSource],
  ];
  const { given, scoped } = scan(source, pins.map(([key]) => key));
  const open = pins.filter(([key]) => !given.has(key));
  const body = source.replace(/\r/g, '').trimEnd();
  if (open.length === 0) return body;
  return [
    body,
    '',
    '# Pinned when the forward test began, so a later change to the plugin settings cannot move it.',
    ...(scoped ? ['for all:'] : []),
    ...open.map(([key, value]) => `${key}: ${value}`),
  ].join('\n');
}

/** A fence longer than any run of backticks inside, so the text cannot end it early. */
function fenced(text: string, lang: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

const WIKILINK = /^\[\[[^[\]\r\n]+\]\]$/;

/** The link to a strategy for the `from:` line: the note's path without `.md`, and `#Name` when the strategy has a name a link can hold. */
export function forwardLink(notePath: string, name: string | null): string {
  const note = notePath.replace(/\.md$/i, '');
  return name && !/[[\]|\r\n]/.test(name) ? `[[${note}#${name}]]` : `[[${note}]]`;
}

/**
 * The text of a new forward test note: its property, the `forward` block with the frozen strategy, and an empty log.
 * Refuses a strategy that does not run, and one with a `to:` date, which never sees a new bar.
 */
export function makeForward(input: ForwardStart): { ok: true; note: string } | Refusal {
  if (!WIKILINK.test(input.link)) return { ok: false, message: `The link ${input.link} can't be written into a note. Write it as [[Note name#Strategy name]].` };
  const { spec, errors } = parseSpec(input.source, { defaults: input.defaults });
  if (!spec) return { ok: false, message: `This strategy has a problem, so a forward test can't start from it. Line ${errors[0].line}: ${errors[0].message}` };
  if (spec.to !== null) return { ok: false, message: 'This strategy stops at a "to" date, so it never sees a new bar. Take the "to" line out before starting a forward test.' };

  const frozen = pinDefaults(input.source, input.defaults);
  const started = stamp(input.started, input.intraday);
  const title = input.name.trim();
  // The start as it reads back from its line, which keeps whole minutes.
  const block = ['started: ' + started, `from: ${input.link}`, `check: ${checkOf(frozen, parseWhen(started)!.t)}`, '---', frozen].join('\n');
  const note = [
    ['---', `${FORWARD_MARKER}: true`, '---'].join('\n'),
    `# Forward test${title ? ` of ${title}` : ''}`,
    `The rules below were frozen after the bar of ${started}${input.intraday ? ' UTC' : ''}, taken from ${input.link}. Only bars after that count. Nothing here places an order.`,
    fenced(block, 'forward'),
    '## Log',
  ].join('\n\n');
  return { ok: true, note: note + '\n' };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a forward block

export interface ForwardBlock {
  /** The time of the last bar the strategy had when the test began; the test is the bars after it. */
  started: number;
  /** Whether `started` was written with a time of day, so the log's bar times have one too. */
  intraday: boolean;
  /** The link as written, `[[Note#Name]]`. */
  from: string;
  check: string;
  /** The frozen strategy text. */
  source: string;
}

const KEYS = ['started', 'from', 'check'];
const SETTING = /^([A-Za-z]+(?: +[A-Za-z]+)*)\s*:\s*(.*)$/;

/** Reads the text of a `forward` block. `forward` is null when `errors` is not empty. */
export function parseForward(body: string): { forward: ForwardBlock | null; errors: Diagnostic[] } {
  const lines = body.split(/\r?\n/);
  const rule = lines.findIndex((l) => l.trim() === '---');
  if (rule < 0) return { forward: null, errors: [{ line: lines.length, message: 'Add a line with --- after started, from and check, and the strategy below it' }] };

  const errors: Diagnostic[] = [];
  const found = new Map<string, { value: string; line: number }>();
  for (let i = 0; i < rule; i++) {
    const text = lines[i].trim();
    if (!text || text.startsWith('#')) continue;
    const m = text.match(SETTING);
    const key = m?.[1].toLowerCase().replace(/\s+/g, ' ');
    if (!m || key === undefined) errors.push({ line: i + 1, message: 'Not a setting. Write started:, from: and check: lines, then ---' });
    else if (!KEYS.includes(key)) errors.push({ line: i + 1, message: `Unknown setting "${m[1]}". Settings: ${KEYS.join(', ')}` });
    else if (found.has(key)) errors.push({ line: i + 1, message: `"${key}" is set twice` });
    else if (!m[2]) errors.push({ line: i + 1, message: `"${key}" has no value` });
    else found.set(key, { value: m[2], line: i + 1 });
  }

  const started = found.get('started');
  const when = started ? parseWhen(started.value) : null;
  if (started && !when) errors.push({ line: started.line, message: `"${started.value}" is not a date. Write it as 2026-11-13, or as 2026-11-13 15:30 for bars inside a day` });
  const from = found.get('from');
  if (from && !WIKILINK.test(from.value)) errors.push({ line: from.line, message: 'Write the strategy as [[Note name#Strategy name]]' });
  const check = found.get('check');
  if (check && !/^[0-9a-z]+$/.test(check.value)) errors.push({ line: check.line, message: `"${check.value}" is not a check code. Leave the line as the plugin wrote it` });
  for (const key of KEYS) if (!found.has(key)) errors.push({ line: rule + 1, message: `Add a "${key}:" line above the ---` });

  const source = lines.slice(rule + 1).join('\n');
  if (!textOf(source)) errors.push({ line: rule + 1, message: 'There is no strategy below the ---' });
  errors.sort((a, b) => a.line - b.line);
  if (errors.length > 0) return { forward: null, errors };
  return { forward: { started: when!.t, intraday: when!.intraday, from: from!.value, check: check!.value, source }, errors };
}

/** Whether the start or the frozen text is no longer the one the check was made from. */
export const forwardChanged = (f: Pick<ForwardBlock, 'check' | 'source' | 'started'>): boolean => f.check !== checkOf(f.source, f.started);

// ---------------------------------------------------------------------------------------------------------------------
// Figures

/** What a stretch of the run's equity did, set against the same-length stretches before the test began. */
export interface Windows {
  ok: true;
  /** How many earlier stretches there are. */
  count: number;
  /** The share of earlier stretches that gained less than the forward test did; one that gained exactly as much counts half. */
  beaten: number;
  /** The share of earlier stretches whose worst fall was deeper than the forward test's; one that fell exactly as far counts half. */
  milder: number;
  /** The middle gain and the middle worst fall of the earlier stretches. */
  typicalReturn: number;
  typicalFall: number;
}

export interface ForwardFigures {
  /** The index of the first bar after `started`; the number of bars when there is none. */
  first: number;
  /** How many bars have come since. */
  bars: number;
  /** Growth from the close of the last bar at or before `started` to the last bar; null with no bar since, or no value to start from. */
  strategy: number | null;
  benchmark: number | null;
  /** The worst fall of the strategy since the start (at or below 0); null with no bar since. */
  worstFall: number | null;
  windows: Windows | { ok: false; message: string };
}

/** The part of a run of values that decides a fall: its highest and lowest value and its worst fall from a high to a later low. */
interface Part {
  hi: number;
  lo: number;
  worst: number;
}

const join = (a: Part, b: Part): number => Math.min(a.worst, b.worst, b.lo / a.hi - 1);

/**
 * The worst fall (a fraction at or below 0) inside each stretch of `steps + 1` values, starting at each value in turn.
 * Each stretch is the end of one block of that length and the start of the next, so a whole series takes one pass.
 */
export function worstFalls(values: number[], steps: number): number[] {
  const w = steps + 1;
  const n = values.length;
  const pre: Part[] = [];
  const suf: Part[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = values[i];
    if (i % w === 0) pre.push({ hi: x, lo: x, worst: 0 });
    else {
      const p = pre[i - 1];
      const hi = Math.max(p.hi, x);
      pre.push({ hi, lo: Math.min(p.lo, x), worst: Math.min(p.worst, x / hi - 1) });
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    const x = values[i];
    if (i === n - 1 || i % w === w - 1) suf[i] = { hi: x, lo: x, worst: 0 };
    else {
      const s = suf[i + 1];
      suf[i] = { hi: Math.max(s.hi, x), lo: Math.min(s.lo, x), worst: Math.min(s.worst, s.lo / x - 1) };
    }
  }
  const out: number[] = [];
  for (let a = 0; a + w <= n; a++) out.push(a % w === 0 ? suf[a].worst : join(suf[a], pre[a + w - 1]));
  return out;
}

/** The share of `values` that are below `x`, with each equal one counting half. */
function shareBelow(values: number[], x: number): number {
  let below = 0;
  for (const v of values) below += v < x ? 1 : v === x ? 0.5 : 0;
  return below / values.length;
}

/**
 * How the run has gone since `started`, from the run's times, its equity and the benchmark's (`benchmark` is aligned with `t`,
 * and NaN before it has a price). Growth is measured from the close of the last bar at or before `started`, as the segments of
 * a backtest are. The earlier stretches are every one of as many steps that ends at or before `started`; they are compared only
 * from MIN_FORWARD_BARS bars on, and only when there are HISTORY_FACTOR times as many bars before the start as since it.
 */
export function forwardFigures(t: number[], equity: number[], benchmark: number[], started: number): ForwardFigures {
  const n = t.length;
  const first = firstAtOrAfter(t, started + 1);
  const bars = n - first;
  const more = (k: number) => `Earlier periods are compared from ${plural(MIN_FORWARD_BARS, 'bar')} on: ${plural(k, 'more bar')} to go.`;
  if (bars === 0) return { first, bars, strategy: null, benchmark: null, worstFall: null, windows: { ok: false, message: more(MIN_FORWARD_BARS) } };

  const base = Math.max(0, first - 1);
  const steps = n - 1 - base;
  const growth = (series: number[]): number | null => {
    let from = base;
    while (from < n && Number.isNaN(series[from])) from++;
    const ratio = series[n - 1] / series[from] - 1;
    return from < n - 1 && Number.isFinite(ratio) ? ratio : null;
  };
  const strategy = equity[n - 1] / equity[base] - 1;
  const fall = maxDrawdown(equity.slice(base));

  let windows: ForwardFigures['windows'];
  if (bars < MIN_FORWARD_BARS) windows = { ok: false, message: more(MIN_FORWARD_BARS - bars) };
  else if (first < HISTORY_FACTOR * bars) {
    windows = {
      ok: false,
      message: `Earlier periods are compared only when there are ${HISTORY_FACTOR} times as many bars before the start as since it. Needed: ${plural(HISTORY_FACTOR * bars - first, 'more bar')} of earlier prices.`,
    };
  } else {
    const before = equity.slice(0, first);
    const gains = before.slice(steps).map((v, a) => v / before[a] - 1);
    const falls = worstFalls(before, steps);
    windows = {
      ok: true,
      count: gains.length,
      beaten: shareBelow(gains, strategy),
      milder: shareBelow(falls, fall),
      typicalReturn: median(gains),
      typicalFall: median(falls),
    };
  }
  return { first, bars, strategy, benchmark: growth(benchmark), worstFall: fall, windows };
}

// ---------------------------------------------------------------------------------------------------------------------
// The log

/** An order a bar gave, and the close it rested on. */
export interface LogOrder {
  action: 'buy' | 'sell' | 'add';
  ticker: string;
  close: number;
}

/** A bar that gave orders, and what the strategy was worth at it. */
export interface LogRow {
  t: number;
  orders: LogOrder[];
  value: number;
}

/**
 * The bars of a run where the rules gave an order, earliest first: each bar's orders, the close each rested on and what the
 * strategy was worth there. A buy or an add is dated at the bar its rule or ranking was read at, a sell at the bar its sell rule
 * or ranking was read at, and an order still waiting at the last bar at that bar. Stops, targets and rebalancing are left
 * out: the rules did not give them, and the run makes them by itself.
 */
export function logRows(bt: { run: Pick<RunResult, 't' | 'equity' | 'trades' | 'states'>; data: Map<string, Bars> }): LogRow[] {
  const { run, data } = bt;
  const byBar = new Map<number, LogOrder[]>();
  const give = (t: number, action: LogOrder['action'], ticker: string): void => {
    const bars = data.get(ticker);
    const at = bars ? barAt(bars.t, t) : -1;
    byBar.set(t, [...(byBar.get(t) ?? []), { action, ticker, close: bars && at >= 0 ? bars.c[at] : NaN }]);
  };
  for (const trade of run.trades) {
    const why = trade.why;
    if (!why) continue;
    give(why.rank ? why.rank.decision.t : why.buyT, 'buy', trade.asset);
    for (const add of why.adds ?? []) give(add.signalT, 'add', trade.asset);
    if (why.exit?.k === 'rule') give(why.exit.t, 'sell', trade.asset);
    else if (why.exit?.k === 'rank') give(why.exit.rank.decision.t, 'sell', trade.asset);
  }
  const last = run.t[run.t.length - 1];
  for (const st of run.states) if (st.pending) give(last, st.pending === 'short' ? 'sell' : st.pending === 'cover' ? 'buy' : st.pending, st.name);
  return [...byBar]
    .sort(([a], [b]) => a - b)
    .map(([t, orders]) => ({ t, orders, value: run.equity[barAt(run.t, t)] }));
}

/** A bar in a note's log: its time and its orders as words, such as "Buy SPY". */
export interface LoggedBar {
  t: number;
  orders: string[];
}

const WORD: Record<LogOrder['action'], string> = { buy: 'Buy', sell: 'Sell', add: 'Add' };
const HEAD = ['Bar', 'Orders', 'Closes', 'Value', 'Logged'];
const CHECKED = 'Checked through:';

/** Sells first, so the cash is there for the buys; then by ticker. */
const inOrder = (orders: LogOrder[]): LogOrder[] =>
  [...orders].sort((a, b) => Number(a.action !== 'sell') - Number(b.action !== 'sell') || a.ticker.localeCompare(b.ticker, 'en'));

const orderWords = (orders: LogOrder[]): string[] => inOrder(orders).map((o) => `${WORD[o.action]} ${o.ticker}`);

const tableLine = (cells: string[]): string => `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;

/** The cells of a table line, with an escaped bar read as the character. */
function cellsOf(line: string): string[] {
  const text = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return text.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

const RULE_CELL = /^:?-{3,}:?$/;

/** The `forward` block that opens on the 0-based `line`, or the first one when there is no line. */
function forwardBlock(note: string, line: number | undefined): Block | null {
  const blocks = extractBlocks(note, 'forward');
  return (line === undefined ? blocks[0] : blocks.find((b) => b.line === line)) ?? null;
}

interface Located {
  forward: ForwardBlock;
  lines: string[];
  /** The line of the `## Log` heading. */
  heading: number;
  /** The line of `Checked through:`, or -1. */
  checked: number;
  checkedThrough: number | null;
  /** The first and last line of the table, or null when there is none. */
  table: { from: number; to: number } | null;
  /** The logged bars in the order of the table. */
  bars: LoggedBar[];
}

/** Finds the forward block and the log in a note, or says why not. */
function locate(note: string, line: number | undefined): { ok: true; at: Located } | Refusal {
  const block = forwardBlock(note, line);
  if (!block) return { ok: false, message: line === undefined ? 'This note has no forward block.' : NOTE_CHANGED };
  const { forward, errors } = parseForward(block.source);
  if (!forward) return { ok: false, message: `The forward block can't be read. Line ${errors[0].line}: ${errors[0].message}` };

  const lines = note.split('\n');
  const text = lines.map((l) => l.replace(/\r$/, ''));
  // A heading inside a code block, such as a comment in the frozen strategy, is not one.
  const inFence: boolean[] = [];
  let fence: string | null = null;
  for (const l of text) {
    if (fence === null) {
      fence = fenceOf(l)?.fence ?? null;
      inFence.push(fence !== null);
    } else {
      inFence.push(true);
      if (closesFence(l, fence)) fence = null;
    }
  }
  const heading = text.findIndex((l, i) => !inFence[i] && /^##[ \t]+Log[ \t]*$/i.test(l));
  if (heading < 0) return { ok: false, message: 'This note has no "## Log" heading.' };
  let end = text.findIndex((l, i) => i > heading && !inFence[i] && /^#{1,2}[ \t]/.test(l));
  if (end < 0) end = text.length;
  const inLog = (i: number) => i > heading && i < end && !inFence[i];

  const checked = text.findIndex((l, i) => inLog(i) && l.startsWith(CHECKED));
  const checkedThrough = checked < 0 ? null : (parseWhen(text[checked].slice(CHECKED.length).trim())?.t ?? null);

  const from = text.findIndex((l, i) => inLog(i) && l.trimStart().startsWith('|'));
  let table: Located['table'] = null;
  const bars: LoggedBar[] = [];
  if (from >= 0) {
    let to = from;
    while (to + 1 < end && text[to + 1].trimStart().startsWith('|')) to++;
    table = { from, to };
    const edited = { ok: false as const, message: "The log table was changed by hand, so the last logged bar can't be read." };
    if (to === from || !cellsOf(text[from + 1]).every((c) => RULE_CELL.test(c))) return edited;
    for (let i = from + 2; i <= to; i++) {
      const [bar, orders = ''] = cellsOf(text[i]);
      const when = parseWhen(bar);
      if (!when) return edited;
      bars.push({ t: when.t, orders: orders ? orders.split(';').map((o) => o.trim()) : [] });
    }
  }
  return { ok: true, at: { forward, lines, heading, checked, checkedThrough, table, bars } };
}

/** What a forward note holds: its block, when its log was last checked, and the bars logged. */
export interface ForwardLog {
  ok: true;
  forward: ForwardBlock;
  checkedThrough: number | null;
  bars: LoggedBar[];
}

/** Reads the forward block and the log of a note, or says why they can't be read. `forwardBlockLine` is as for `appendLog`. */
export function readLog(note: string, forwardBlockLine?: number): ForwardLog | Refusal {
  const found = locate(note, forwardBlockLine);
  return found.ok ? { ok: true, forward: found.at.forward, checkedThrough: found.at.checkedThrough, bars: found.at.bars } : found;
}

/**
 * The rows that are new to the log: after the start, the last bar logged and the last bar checked, one for each bar,
 * earliest first. A bar already checked is not new, even when today's prices give it an order the log does not have:
 * that is a revision, and the log keeps what it said.
 */
export function newRows(log: Pick<ForwardLog, 'forward' | 'bars' | 'checkedThrough'>, rows: LogRow[]): LogRow[] {
  const last = Math.max(log.forward.started, log.checkedThrough ?? -Infinity, ...log.bars.map((b) => b.t));
  const unseen = new Map<number, LogRow>();
  for (const r of rows) if (r.t > last && r.orders.length > 0 && !unseen.has(r.t)) unseen.set(r.t, r);
  return [...unseen.values()].sort((a, b) => a.t - b.t);
}

/**
 * Puts `chunk` after line `after` in the note's own line endings (`cr` is "\r" or ""). Unless it continues a table, it is set
 * apart from the lines around it by blank ones.
 */
function insertAfter(lines: string[], after: number, chunk: string[], cr: string, continues = false): void {
  const atEnd = after === lines.length - 1;
  const next = lines[after + 1];
  const apart = !continues;
  const add = [...(apart ? [''] : []), ...chunk, ...(apart && next !== undefined && next.trim() !== '' ? [''] : [])].map((l) => l + cr);
  if (atEnd) {
    // The note had no line break after its last line, and still has none after the new last one.
    lines[after] += cr;
    add[add.length - 1] = chunk[chunk.length - 1];
  }
  lines.splice(after + 1, 0, ...add);
}

/**
 * The note with new rows added to its log and `Checked through` brought up to `checkedThrough`, or why not. Only the bars
 * after the last one logged and the last one checked are added (after the start, for a new log), so asking again changes nothing, and a row that is
 * there is never rewritten. Refused when the note is not one the plugin made as a forward test, when the frozen rules were
 * changed, when there is no log heading, and when the table was changed by hand so that its last bar can't be read.
 * `forwardBlockLine` is the 0-based line the block opened on when it was drawn.
 */
export function appendLog(note: string, forwardBlockLine: number | undefined, rows: LogRow[], checkedThrough: number, now: number): { ok: true; note: string; added: number } | Refusal {
  if (!isForwardNote(note)) return { ok: false, message: `This note was not made as a forward test by Backtest Blocks (it has no ${FORWARD_MARKER} property), so nothing was written.` };
  const found = locate(note, forwardBlockLine);
  if (!found.ok) return found.message === NOTE_CHANGED ? found : { ok: false, message: `${found.message} Nothing was written.` };
  const { forward, lines, heading, checked, table, bars } = found.at;
  if (forwardChanged(forward)) return { ok: false, message: `${CHANGED} Nothing was written.` };

  const intraday = forward.intraday;
  const logged = localDate(now);
  const added = newRows({ forward, bars, checkedThrough: found.at.checkedThrough }, rows).map((r) =>
    tableLine([stamp(r.t, intraday), orderWords(r.orders).join('; '), inOrder(r.orders).map((o) => `${o.ticker} ${price(o.close)}`).join('; '), `$${price(r.value)}`, logged]),
  );

  const cr = note.includes('\r\n') ? '\r' : '';
  const out = [...lines];
  const checkedText = `${CHECKED} ${stamp(checkedThrough, intraday)}`;
  const newer = found.at.checkedThrough === null || checkedThrough > found.at.checkedThrough;

  // A line is replaced in place first, then lines are added from the bottom up, so the line numbers still to be used stay right.
  if (checked >= 0 && newer) out[checked] = checkedText + (out[checked].endsWith('\r') ? '\r' : '');
  const newTable = added.length > 0 && !table ? [tableLine(HEAD), tableLine(HEAD.map((_, i) => (i === 3 ? '---:' : '---'))), ...added] : [];
  if (added.length > 0 && table) insertAfter(out, table.to, added, cr, true);
  else if (newTable.length > 0 && checked >= 0) insertAfter(out, checked, newTable, cr);
  if (checked < 0) insertAfter(out, heading, [checkedText, ...(newTable.length > 0 ? ['', ...newTable] : [])], cr);
  return { ok: true, note: out.join('\n'), added: added.length };
}

/**
 * Adds to the log of a note through `process`, which edits the note's text in place (Obsidian's `vault.process`), so the
 * note is read and written in one step. The line is the one the block is on now, asked for again at the time of writing.
 * Says what was written, or why nothing was.
 */
export async function writeLog(
  process: (edit: (note: string) => string) => Promise<unknown>,
  forwardBlockLine: number | undefined,
  rows: LogRow[],
  checkedThrough: number,
  now: number,
): Promise<{ ok: true; added: number } | Refusal> {
  let result: { ok: true; added: number } | Refusal = { ok: false, message: NOTE_CHANGED };
  await process((note) => {
    const r = appendLog(note, forwardBlockLine, rows, checkedThrough, now);
    result = r.ok ? { ok: true, added: r.added } : r;
    return r.ok ? r.note : note;
  });
  return result;
}

/** A bar where what the log says is not what today's prices give. */
export interface Revision {
  t: number;
  message: string;
}

/**
 * The bars, from the start to the last one checked, where the orders in the log are not the ones today's run gives. Orders are
 * compared and closes are not: a dividend since then changes every adjusted close. A bar not logged yet is new, not a revision.
 */
export function revisions(log: Pick<ForwardLog, 'forward' | 'checkedThrough' | 'bars'>, today: LogRow[]): Revision[] {
  const { started, intraday } = log.forward;
  const through = Math.max(log.checkedThrough ?? -Infinity, ...log.bars.map((b) => b.t));
  const said = new Map(log.bars.map((b) => [b.t, b.orders]));
  const now = new Map(today.filter((r) => r.t > started && r.t <= through && r.orders.length > 0).map((r) => [r.t, orderWords(r.orders)]));
  const same = (a: string[], b: string[]) => {
    const [x, y] = [[...a].sort(), [...b].sort()];
    return x.length === y.length && x.every((w, i) => w === y[i]);
  };
  const out: Revision[] = [];
  for (const t of [...new Set([...said.keys(), ...now.keys()])].sort((a, b) => a - b)) {
    const was = said.get(t) ?? [];
    const is = now.get(t) ?? [];
    if (same(was, is)) continue;
    const day = stamp(t, intraday);
    out.push({
      t,
      message:
        was.length === 0
          ? `The log has no order on ${day}; today's prices give ${is.join(', ')} there.`
          : `The log says ${was.join(', ')} on ${day}; today's prices give ${is.length === 0 ? 'no order' : is.join(', ')} there.`,
    });
  }
  return out;
}
