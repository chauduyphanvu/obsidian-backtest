import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { extractBlocks } from '../src/blocks.ts';
import { parseSpec } from '../src/dsl.ts';
import { appendLog, forwardFigures, forwardLink, makeForward, readLog, writeLog, type LogOrder, type LogRow } from '../src/forward.ts';
import { linkParts, logLine, renderForward, windowLines, type ForwardHost } from '../src/render-forward.ts';
import { NOTE_CHANGED } from '../src/rewrite.ts';
import { createNote, type NewFiles } from '../src/vault-writes.ts';
import { bars, DAY } from './helpers.ts';

const utc = (y: number, m: number, d: number, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm);
const order = (action: LogOrder['action'], ticker: string, close: number): LogOrder => ({ action, ticker, close });
const row = (t: number, orders: LogOrder[]): LogRow => ({ t, orders, value: 10_000 });

const DEFAULTS = { capital: 10_000, costBps: 0, slippageBps: 0, cashRate: '0%', dataSource: 'yahoo' as const };
const STRATEGY = 'name: Swing\nuniverse: SPY\nbuy when close > sma(4)\nsell when close < sma(4)';

function started(over: { started?: number; intraday?: boolean } = {}): string {
  const made = makeForward({ source: STRATEGY, defaults: DEFAULTS, started: utc(2026, 11, 13), intraday: false, link: '[[Swing note#Swing]]', name: 'Swing', ...over });
  assert.ok(made.ok);
  return made.note;
}

test('a from link shows its note and strategy, drops an alias, and opens the strategy', () => {
  // Written as Obsidian shows a link to a heading.
  assert.deepEqual(linkParts('[[Trend following#Trend following]]'), { label: 'Trend following > Trend following', target: 'Trend following#Trend following' });
  assert.deepEqual(linkParts('[[Trend#Mixed # Case|Mine]]'), { label: 'Trend > Mixed # Case', target: 'Trend#Mixed # Case' });
  assert.deepEqual(linkParts('[[Research/Three sleeves|Sleeves]]'), { label: 'Research/Three sleeves', target: 'Research/Three sleeves' });
  assert.deepEqual(linkParts('[[Plain]]'), { label: 'Plain', target: 'Plain' });
});

test('a link to a strategy is the note without .md and the strategy name, when a link can hold it', () => {
  assert.equal(forwardLink('Trading/Trend.md', 'Trend following'), '[[Trading/Trend#Trend following]]');
  assert.equal(forwardLink('Trend.md', null), '[[Trend]]');
  assert.equal(forwardLink('Trend', ''), '[[Trend]]');
  assert.equal(forwardLink('Trend.md', 'Mixed # Case'), '[[Trend#Mixed # Case]]');
  for (const name of ['A|B', 'A]B', 'A[B', 'A\nB']) assert.equal(forwardLink('Trend.md', name), '[[Trend]]', JSON.stringify(name));
});

test('the sentences under the figures say how the gain and the fall compare with earlier stretches', () => {
  const before = [100, 102, 101, 103, 105, 104, 106, 108, 107, 109, 111, 110, 112, 114, 113, 115, 117, 116, 118, 120];
  const equity = [...before, 118.9, 122, 124, 125, 126];
  const f = forwardFigures(equity.map((_, i) => i * DAY), equity, equity, 19 * DAY);
  assert.deepEqual(windowLines(f), [
    'The return was better than in 67% of the 15 previous periods of 5 bars. Their median return was +3.9%.',
    'The worst drawdown, −0.9%, was smaller than in 53% of them. Their median worst drawdown was −0.9%.',
  ]);
  assert.deepEqual(windowLines(forwardFigures(equity.map((_, i) => i * DAY), equity, equity, 21 * DAY)), ['The plugin compares previous periods when the test has 5 bars. It must have 2 more bars.']);
});

test('the log line offers the new bars, or only to mark the day, or nothing when it is up to date', () => {
  const forward = parseStarted();
  const through = utc(2026, 11, 20);
  const log = (checkedThrough: number | null, bars: { t: number; orders: string[] }[] = []) => ({ forward, bars, checkedThrough });
  const two = [row(utc(2026, 11, 16), [order('buy', 'SPY', 1)]), row(utc(2026, 11, 18), [order('sell', 'SPY', 1)])];

  assert.deepEqual(logLine(log(null), two, through), { text: '2 bars that are not in the log gave orders. The log has no "Checked through" date.', button: 'Add 2 new bars to the log' });
  assert.deepEqual(logLine(log(utc(2026, 11, 17), [{ t: utc(2026, 11, 16), orders: ['Buy SPY'] }]), two, through), {
    text: '1 bar that are not in the log gave orders. The log is checked through 2026-11-17.',
    button: 'Add 1 new bar to the log',
  });
  assert.deepEqual(logLine(log(null), [], through), { text: 'No new bar gave an order. The log has no "Checked through" date.', button: 'Set "Checked through" to 2026-11-20' });
  assert.deepEqual(logLine(log(utc(2026, 11, 17)), [], through), { text: 'No new bar gave an order. The log is checked through 2026-11-17.', button: 'Set "Checked through" to 2026-11-20' });
  assert.deepEqual(logLine(log(through, [{ t: utc(2026, 11, 16), orders: ['Buy SPY'] }]), two.slice(0, 1), through), { text: 'The log is up to date through 2026-11-20.', button: null });
});

test('the log line names times of day for an intraday test', () => {
  const forward = parseStarted(true);
  const log = { forward, bars: [], checkedThrough: utc(2026, 11, 13, 16, 30) };
  assert.deepEqual(logLine(log, [], utc(2026, 11, 13, 17, 30)), { text: 'No new bar gave an order. The log is checked through 2026-11-13 16:30.', button: 'Set "Checked through" to 2026-11-13 17:30' });
});

function parseStarted(intraday = false) {
  const note = started(intraday ? { started: utc(2026, 11, 13, 15, 30), intraday: true } : {});
  const log = readLog(note);
  assert.ok(log.ok);
  return log.forward;
}

/** The edit a note gets through `vault.process`: handed the text, it returns the new text. */
function store(text: string) {
  const file = { text, edits: 0 };
  const process = async (edit: (note: string) => string): Promise<void> => {
    file.edits++;
    file.text = edit(file.text);
  };
  return { file, process };
}

test('writing the log goes through process, with the block line asked for at that time', async () => {
  const note = started();
  const line = extractBlocks(note, 'forward')[0].line;
  const x = store(note);
  const rows = [row(utc(2026, 11, 16), [order('buy', 'SPY', 100)]), row(utc(2026, 11, 17), [order('sell', 'SPY', 99)])];
  const now = utc(2026, 11, 18, 12);
  assert.deepEqual(await writeLog(x.process, line, rows, utc(2026, 11, 18), now), { ok: true, added: 2 });
  const expected = appendLog(note, line, rows, utc(2026, 11, 18), now);
  assert.ok(expected.ok);
  assert.equal(x.file.text, expected.note);

  // Asking again adds nothing and leaves the text as it was.
  assert.deepEqual(await writeLog(x.process, line, rows, utc(2026, 11, 18), now), { ok: true, added: 0 });
  assert.equal(x.file.text, expected.note);
});

test('a note that changed, or that is not the plugin\'s, is left as it is and the reason comes back', async () => {
  const note = started();
  const line = extractBlocks(note, 'forward')[0].line;
  const rows = [row(utc(2026, 11, 16), [order('buy', 'SPY', 100)])];

  const moved = store(note);
  assert.deepEqual(await writeLog(moved.process, line + 1, rows, utc(2026, 11, 18), 0), { ok: false, message: NOTE_CHANGED });
  assert.equal(moved.file.text, note);

  const edited = store(note.replace('sma(4)', 'sma(5)'));
  const refused = await writeLog(edited.process, line, rows, utc(2026, 11, 18), 0);
  assert.ok(!refused.ok && refused.message.startsWith('The rules or the start changed after the forward test started'));
  assert.equal(edited.file.text, note.replace('sma(4)', 'sma(5)'));

  const foreign = store('# My note\n\n## Log\n');
  const notOurs = await writeLog(foreign.process, undefined, rows, utc(2026, 11, 18), 0);
  assert.ok(!notOurs.ok && notOurs.message.includes('did not make this note as a forward test'));
  assert.equal(foreign.file.text, '# My note\n\n## Log\n');
});

test('a process that never runs the edit says the note changed, and one that fails fails', async () => {
  const rows = [row(utc(2026, 11, 16), [order('buy', 'SPY', 100)])];
  assert.deepEqual(await writeLog(async () => {}, 0, rows, 0, 0), { ok: false, message: NOTE_CHANGED });
  await assert.rejects(() => writeLog(async () => Promise.reject(new Error('disk full')), 0, rows, 0, 0), /disk full/);
});

function files(existing: string[] = []) {
  const have = new Set(existing);
  const made: string[] = [];
  const folders: string[] = [];
  const f: NewFiles = {
    exists: async (p) => have.has(p),
    createFolder: async (p) => {
      folders.push(p);
      have.add(p);
    },
    create: async (p) => {
      have.add(p);
      made.push(p);
    },
  };
  return { f, made, folders };
}

test('a forward note goes in its folder, made when it is missing, under a clean name and a free one', async () => {
  const x = files();
  assert.equal(await createNote(x.f, 'Backtests/Forward', 'Trend: SPY/QQQ forward test 2026-11-13', 'text'), 'Backtests/Forward/Trend SPY QQQ forward test 2026-11-13.md');
  assert.deepEqual(x.folders, ['Backtests/Forward']);
  assert.equal(await createNote(x.f, 'Backtests/Forward', 'Trend: SPY/QQQ forward test 2026-11-13', 'text'), 'Backtests/Forward/Trend SPY QQQ forward test 2026-11-13-2.md');
  assert.deepEqual(x.folders, ['Backtests/Forward'], 'the folder is made once');
  assert.equal(x.made.length, 2);
});

// --- The block, drawn into a stand-in for the page ---------------------------------------------------------------

class El {
  className = '';
  hidden = false;
  disabled = false;
  attrs: Record<string, string> = {};
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  children: (El | string)[] = [];
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(text: string) {
    this.children = [text];
  }
  appendChild(child: El): El {
    this.children.push(child);
    return child;
  }
  append(...nodes: (El | string)[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(): void {
    this.children = [];
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  addEventListener(type: string, listener: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  click(): void {
    for (const listener of this.listeners.click ?? []) listener({ preventDefault() {}, stopPropagation() {} });
  }
  all(): El[] {
    return [this, ...this.children.flatMap((c) => (typeof c === 'string' ? [] : c.all()))];
  }
  find(tag: string, text?: string): El | undefined {
    return this.all().find((e) => e.tag === tag && (text === undefined || e.textContent === text));
  }
  has(text: string): boolean {
    return this.textContent.includes(text);
  }
}

const later = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A forward test over 70 bars of one ticker, started at bar 49, whose note is held in memory and written through `writeLog`. */
function stage(over: { failRun?: boolean; refuse?: boolean; source?: string } = {}) {
  const closes = Array.from({ length: 70 }, (_, i) => 100 + 10 * Math.sin(i / 3) + i * 0.05);
  const data = new Map([['A', bars(closes)]]);
  const defaults = { capital: 10_000, costBps: 0, slippageBps: 0, cashRate: '0%', dataSource: 'yahoo' as const };
  const source = over.source ?? 'name: Swing\nuniverse: A\nbuy when close > sma(4)\nsell when close < sma(4)';
  const made = makeForward({ source, defaults, started: data.get('A')!.t[49], intraday: false, link: '[[Swing note#Swing]]', name: 'Swing' });
  assert.ok(made.ok);
  const file = { text: made.note };
  const calls = { run: 0, append: [] as { rows: LogRow[]; through: number }[], opened: [] as string[] };
  const host: ForwardHost = {
    note: async () => ({ text: file.text, line: extractBlocks(file.text, 'forward')[0].line }),
    run: async (source) => {
      calls.run++;
      if (over.failRun) throw new Error('Yahoo has no prices for A.');
      const { spec } = parseSpec(source);
      return { spec: spec!, backtest: runBacktest(spec!, data), data, warnings: ['Prices are three days old.'], prices: [] };
    },
    append: async (rows, through) => {
      calls.append.push({ rows, through });
      if (over.refuse) return { ok: false, message: 'The note changed after the plugin showed this result. The plugin did not write to the note. Do the step again.' };
      return writeLog(async (edit) => void (file.text = edit(file.text)), extractBlocks(file.text, 'forward')[0].line, rows, through, utc(2026, 11, 17, 12));
    },
    open: (target) => void calls.opened.push(target),
  };
  return { file, calls, host, source: extractBlocks(file.text, 'forward')[0].source, last: data.get('A')!.t[69] };
}

// Each test file runs in a process of its own, so the page stays a stand-in for the whole run of this file.
(globalThis as { document?: unknown }).document = { createElement: (tag: string) => new El(tag) };

function draw(source: string, host: ForwardHost): { root: El; stop: () => void } {
  const root = new El('div');
  const stop = renderForward(root as unknown as HTMLElement, source, host);
  return { root, stop };
}

const press = (button: El): void => button.click();

test('a forward block runs its rules, shows its figures, and its button logs the new bars once', async () => {
  const x = stage();
  const { root } = draw(x.source, x.host);
  assert.ok(root.has('The plugin runs the frozen rules'));
  await later();
  assert.equal(x.calls.run, 1);
  for (const part of ['Since the start', 'Worst drawdown', 'Time invested', 'The test started after the bar of 2020-02-19, from Swing note > Swing.', 'The last bar is 2020-03-10.', 'Prices are three days old.', 'The frozen rules', 'The log has no "Checked through" date.']) {
    assert.ok(root.has(part), part);
  }
  assert.ok(root.has('The plugin compares previous periods only if there are 3 times as many bars'), 'with 20 bars since and 50 before, the comparison waits');

  root.find('a', 'Swing note > Swing')!.click();
  assert.deepEqual(x.calls.opened, ['Swing note#Swing']);

  const button = root.find('button', 'Add 2 new bars to the log')!;
  assert.ok(button);
  press(button);
  await later();
  assert.equal(x.calls.append.length, 1);
  assert.equal(x.calls.append[0].through, x.last);
  assert.ok(x.file.text.includes('Checked through: 2020-03-10') && x.file.text.includes('| 2020-02-23 | Buy A |'));
  // The block draws itself again from the note as it is now: nothing is left to add.
  assert.ok(root.has('The log is up to date through 2020-03-10.'));
  assert.equal(root.find('button', 'Add 2 new bars to the log'), undefined);
  assert.equal(x.calls.run, 1, 'the rules are not run again to draw the log');
});

test('a forward test of a block that can borrow shows its exposure, gross and net, as the result does', async () => {
  const x = stage({ source: 'name: Swing\nuniverse: A\nbuy when close > sma(4)\nshort when close < sma(4)' });
  const { root } = draw(x.source, x.host);
  await later();
  const tile = root.all().find((e) => e.className === 'bt-tile' && e.textContent.startsWith('Exposure'));
  // Always long or short after the start: about 100% gross, and a net between −100% and 100%.
  assert.match(tile?.textContent ?? '', /^Exposure\d+%gross, net −?\d+%$/);
  assert.ok(!root.has('Time invested'));
});

test('a refused write is said, and the button can be pressed again', async () => {
  const x = stage({ refuse: true });
  const { root } = draw(x.source, x.host);
  await later();
  const button = root.find('button', 'Add 2 new bars to the log')!;
  press(button);
  await later();
  const warning = root.all().find((e) => e.className === 'bt-warning' && e.textContent.startsWith('The note changed after'));
  assert.ok(warning && !warning.hidden);
  assert.equal(button.disabled, false);
  assert.ok(!x.file.text.includes('Checked through'));
});

test('rules edited after the start show the warning and nothing else, and run nothing', async () => {
  const x = stage();
  const { root } = draw(x.source.replace('sma(4)', 'sma(5)'), x.host);
  await later();
  assert.ok(root.has('The rules or the start changed after the forward test started. As a result, this is not a forward test.'));
  assert.equal(x.calls.run, 0);
  assert.equal(root.find('button'), undefined);
});

test('a block that cannot be read lists its problems with their lines', () => {
  const x = stage();
  const { root } = draw('started: yesterday\n---\nuniverse: A', x.host);
  assert.ok(root.has('This forward test cannot run: 3 problems') && root.has('Line 1') && root.has('is not a date'));
  assert.equal(x.calls.run, 0);
});

test('a run that fails says so and can be tried again; a block drawn away before its run ends draws nothing', async () => {
  const failing = stage({ failRun: true });
  const { root } = draw(failing.source, failing.host);
  await later();
  assert.ok(root.has('The frozen rules did not run') && root.has('Yahoo has no prices for A.'));
  assert.ok(root.find('button', 'Run again'));

  const away = stage();
  const drawn = draw(away.source, away.host);
  drawn.stop();
  await later();
  assert.ok(!drawn.root.has('Since the start'), 'nothing is drawn once the block has gone');
});
