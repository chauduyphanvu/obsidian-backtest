// The "Rule values, bar by bar" section: a window of bars for one ticker, each with the value of every part of its rules
// and what the run did there. The rows come from debug.ts, built only for the bars on screen.

import type { Backtest } from './backtest.ts';
import {
  barOnOrAfter,
  cellText,
  csvAsk,
  csvSize,
  debugColumns,
  csvSteps,
  debugRange,
  debugRows,
  holdDebug,
  inSlices,
  interesting,
  positionWords,
  prepareRows,
  tradeStops,
  type DebugColumn,
  type DebugRow,
} from './debug.ts';
import { h } from './dom.ts';
import { MARK } from './explain.ts';
import { isoDate, price, stamp } from './format.ts';

export interface DebugInput {
  backtest: Backtest;
  intraday: boolean;
  /** Writes a CSV file under this title and tells the user where it went. */
  save: (title: string, csv: string) => Promise<void> | void;
}

/** Bars shown at once, and how many of them come before a bar jumped to. */
const WINDOW = 60;
const BEFORE = 8;
/** Up to this many tickers get a button each; more get a drop-down. */
const MAX_BUTTONS = 12;

/** Appends a collapsed "Rule values, bar by bar" section to `parent`. Built the first time it is opened. Returns a cleanup function. */
export function renderDebug(parent: HTMLElement, input: DebugInput): () => void {
  const details = h(parent, 'details', 'bt-details');
  h(details, 'summary', undefined, 'Rule values, bar by bar');
  const view = { open: true };
  // The result is shared with every other block that shows it, so what is worked out goes only when the last view closes.
  const release = holdDebug(input.backtest);
  details.addEventListener('toggle', () => build(h(details, 'div', 'bt-debug-body'), input, view), { once: true });
  return () => {
    view.open = false;
    release();
  };
}

function build(body: HTMLElement, input: DebugInput, life: { open: boolean }): void {
  const bt = input.backtest;
  const tickers = bt.spec.universe.map((a) => a.name);
  let asset = tickers[0];
  let count = 0;
  let columns: DebugColumn[] = [];
  let stops = tradeStops(bt, asset);
  let start = 0;
  /** The row to point at: a trade's decision, or the date jumped to. */
  let focus: number | null = null;
  let filter = false;

  const picker = tickers.length > 1 ? h(body, 'div', 'bt-debug-picker') : null;
  const controls = h(body, 'div', 'bt-debug-controls');
  const saveError = h(body, 'div', 'bt-warning');
  saveError.hidden = true;
  const ask = h(body, 'div', 'bt-note bt-debug-ask');
  ask.hidden = true;
  const saving = h(body, 'div', 'bt-note');
  saving.hidden = true;
  const status = h(body, 'div', 'bt-note bt-debug-status');
  const box = h(body, 'div', 'bt-wide bt-debug-scroll');
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', 'Rule values for each bar');
  box.tabIndex = 0;
  const legend = h(body, 'div', 'bt-debug-legend');

  const button = (parent: HTMLElement, text: string, onClick: () => void): HTMLButtonElement => {
    const b = h(parent, 'button', 'bt-button bt-debug-button', text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };

  const windowControls = h(controls, 'div', 'bt-debug-group');
  const earlier = button(windowControls, '← Earlier', () => move(start - WINDOW));
  const later = button(windowControls, 'Later →', () => move(start + WINDOW));
  const dateLabel = h(windowControls, 'label', 'bt-debug-date');
  h(dateLabel, 'span', undefined, 'Go to date');
  const date = h(dateLabel, 'input');
  date.type = 'date';
  date.addEventListener('change', () => {
    const t = Date.parse(`${date.value}T00:00:00Z`);
    if (Number.isNaN(t)) return;
    focus = barOnOrAfter(bt, asset, t);
    start = focus - BEFORE;
    draw();
  });

  const tradeControls = h(controls, 'div', 'bt-debug-group');
  const previous = button(tradeControls, '← Previous trade', () => goTo(-1));
  const next = button(tradeControls, 'Next trade →', () => goTo(1));
  const tradeNote = h(tradeControls, 'span', 'bt-debug-trade');

  const options = h(controls, 'div', 'bt-debug-group');
  const filterLabel = h(options, 'label', 'bt-debug-filter');
  const check = h(filterLabel, 'input');
  check.type = 'checkbox';
  h(filterLabel, 'span', undefined, 'Only bars where something happened or nearly happened');
  check.addEventListener('change', () => {
    filter = check.checked;
    draw();
  });
  /** The bars the table shows now, as the first and the end of the window. */
  const shownBars = (): { from: number; to: number } => {
    const from = Math.max(0, Math.min(Math.floor(start), count - WINDOW));
    return { from, to: Math.min(count, from + WINDOW) };
  };
  /** Asks in the section, not in a dialog of the browser; resolves with the answer, or null for cancel. */
  const choose = (question: { text: string; all: boolean }, shown: number): Promise<'all' | 'window' | null> =>
    new Promise((resolve) => {
      ask.replaceChildren();
      h(ask, 'div', undefined, question.text);
      const row = h(ask, 'div', 'bt-debug-ask-buttons');
      const answer = (value: 'all' | 'window' | null) => () => {
        ask.hidden = true;
        resolve(value);
      };
      if (question.all) button(row, 'Save every bar', answer('all'));
      button(row, `Save the ${shown} ${shown === 1 ? 'bar' : 'bars'} shown`, answer('window'));
      button(row, 'Cancel', answer(null));
      ask.hidden = false;
    });
  const save = button(options, 'Save as CSV', async () => {
    const name = asset;
    save.disabled = true;
    saveError.hidden = true;
    ask.hidden = true;
    try {
      // The file is made a few hundred bars at a time, so a long run does not freeze the window.
      if (!(await ensure(name))) return;
      // A file of the whole run can be over a hundred megabytes: past about 20 MB the reader chooses first.
      const shown = shownBars();
      const question = csvAsk(csvSize(bt, name), shown.to - shown.from);
      const choice = question ? await choose(question, shown.to - shown.from) : 'all';
      if (choice === null) return;
      const part = choice === 'window';
      const csv = await inSlices(csvSteps(bt, name, part ? shown : undefined), {
        onSlice: (p) => {
          saving.textContent = `Making the file: ${p.done.toLocaleString('en-US')} of ${p.total.toLocaleString('en-US')} bars.`;
          saving.hidden = false;
        },
        stop: () => !life.open,
      });
      saving.hidden = true;
      const title = `${bt.spec.name ?? 'Backtest'} rule values ${name}${part ? ` bars ${shown.from + 1} to ${shown.to}` : ''}`;
      if (csv !== null) await input.save(title, csv);
    } catch (e) {
      saveError.textContent = `The file couldn't be saved: ${e instanceof Error ? e.message : String(e)}`;
      saveError.hidden = false;
    } finally {
      saving.hidden = true;
      save.disabled = false;
    }
  });

  /**
   * Works out what the rows of a ticker read over the whole run, a part of the rules at a time with the window free in
   * between: a long run takes a moment, and the table is drawn when it is done. False when the section was closed first.
   */
  const worked = new Map<string, Promise<boolean>>();
  const ready = new Set<string>();
  function ensure(name: string): Promise<boolean> {
    let done = worked.get(name);
    if (!done) {
      done = inSlices(prepareRows(bt, name), {
        onSlice: (p) => {
          if (asset === name) status.textContent = `Working out the rule values: ${p.done} of ${p.total} parts.`;
        },
        stop: () => !life.open,
      }).then((result) => {
        if (result !== null) ready.add(name);
        return result !== null;
      });
      worked.set(name, done);
    }
    return done;
  }
  function move(to: number): void {
    start = to;
    focus = null;
    draw();
  }

  /** Points at the trade before or after the row in view: the one decided before `focus`, else before the window. */
  function goTo(step: 1 | -1): void {
    const from = focus ?? (step === 1 ? start - 1 : start);
    const stop = step === 1 ? stops.find((s) => s.index > from) : [...stops].reverse().find((s) => s.index < from);
    if (!stop) return;
    focus = stop.index;
    start = stop.index - BEFORE;
    draw();
  }

  function pick(name: string): void {
    asset = name;
    stops = tradeStops(bt, asset);
    focus = null;
    start = Number.POSITIVE_INFINITY;
    columns = debugColumns(bt, asset);
    count = debugRange(bt, asset).count;
    drawLegend();
    box.replaceChildren();
    status.textContent = 'Working out the rule values.';
    void ensure(name).then((ok) => {
      if (ok && asset === name) draw();
    });
  }

  function draw(): void {
    // Until its values are worked out, a ticker's rows would be worked out all at once here.
    if (!life.open || !ready.has(asset)) return;
    const range = debugRange(bt, asset);
    start = Math.max(0, Math.min(Math.floor(start), count - WINDOW));
    const end = Math.min(count, start + WINDOW);
    earlier.disabled = start <= 0;
    later.disabled = end >= count;
    if (count > 0) {
      date.min = isoDate(range.from);
      date.max = isoDate(range.to);
    }

    const k = focus === null ? -1 : stops.findIndex((s) => s.index === focus);
    previous.disabled = !stops.some((s) => s.index < (focus ?? start));
    next.disabled = !stops.some((s) => s.index > (focus ?? start - 1));
    tradeNote.textContent = stops.length === 0 ? 'No trades' : k >= 0 ? `Trade ${k + 1} of ${stops.length}` : `${stops.length} ${stops.length === 1 ? 'trade' : 'trades'}`;

    const rows = debugRows(bt, asset, start, end);
    if (rows.length === 0) {
      status.textContent = `${asset} has no bars in this run.`;
      drawTable(box, columns, rows, focus, input.intraday, false);
      return;
    }
    const shown = filter ? rows.filter((r) => interesting(r) || r.index === focus) : rows;
    status.textContent =
      `${asset}: bars ${start + 1} to ${end} of ${count}, ${stamp(rows[0].t, input.intraday)} to ${stamp(rows[rows.length - 1].t, input.intraday)}` +
      (filter ? `. ${shown.length} of these ${rows.length} shown.` : '.') +
      (input.intraday ? ' Times are in UTC.' : '');
    drawTable(box, columns, shown, focus, input.intraday, filter);
  }

  function drawLegend(): void {
    legend.replaceChildren();
    h(legend, 'div', 'bt-debug-legend-title', 'The columns, as you wrote them');
    const list = h(legend, 'ul', 'bt-debug-legend-list');
    for (const c of columns) {
      const li = h(list, 'li');
      h(li, 'span', 'bt-debug-legend-caption', c.caption);
      h(li, 'span', c.kind === 'score' || c.kind === 'place' ? 'bt-debug-legend-text' : 'bt-debug-legend-text bt-debug-code', `${c.kind === 'score' ? 'Score: ' : ''}${c.text}`);
    }
    const shorts = columns.some((c) => c.group === 'short' || c.group === 'cover');
    const dimmed = shorts
      ? 'sell rule columns are dimmed where no long was held, and cover rule columns where no short was'
      : 'sell rule columns are dimmed on the others';
    h(legend, 'div', 'bt-debug-legend-key', `✓ yes, ✗ no, ? unknown, – not read (the part needs an open position and none was held, or, for an add rule, a position that can still take another entry). A shaded row is a bar where a position was held at the close; ${dimmed}.`);
  }

  if (picker) {
    if (tickers.length > MAX_BUTTONS) {
      const select = h(picker, 'select', 'dropdown bt-debug-select');
      select.setAttribute('aria-label', 'Ticker');
      for (const name of tickers) h(select, 'option', undefined, name).value = name;
      select.addEventListener('change', () => pick(tickers[select.selectedIndex]));
    } else {
      const group = h(picker, 'div', 'bt-debug-buttons');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Ticker');
      const buttons = tickers.map((name) => {
        const b = h(group, 'button', 'bt-debug-pick', name);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(name === asset));
        b.addEventListener('click', () => {
          buttons.forEach((other) => other.setAttribute('aria-pressed', String(other === b)));
          pick(name);
        });
        return b;
      });
    }
  }
  pick(asset);
}

function drawTable(box: HTMLElement, columns: DebugColumn[], rows: DebugRow[], focus: number | null, intraday: boolean, filtered: boolean): void {
  box.replaceChildren();
  if (rows.length === 0) {
    h(box, 'div', 'bt-note bt-debug-empty', filtered ? 'No bar in this window has anything that happened or nearly happened. Turn the filter off to see every bar.' : 'There are no bars to show.');
    return;
  }
  const table = h(box, 'table', 'bt-table bt-debug-table');
  const head = h(h(table, 'thead'), 'tr');
  h(head, 'th', 'bt-debug-sticky', intraday ? 'Time (UTC)' : 'Date').scope = 'col';
  h(head, 'th', 'bt-num', 'Close').scope = 'col';
  // What people open the table for comes straight after the close, before the rule columns that can run far off to the right.
  h(head, 'th', 'bt-debug-what', 'What happened').scope = 'col';
  const position = h(head, 'th', undefined, 'Position');
  position.scope = 'col';
  position.title = 'The position at the end of the bar, after the bar\'s fills';
  for (const c of columns) {
    const th = h(head, 'th', `bt-debug-head bt-debug-head-${c.group}`);
    th.scope = 'col';
    h(th, 'span', 'bt-debug-caption', c.caption);
    const heading = h(th, 'span', c.kind === 'score' || c.kind === 'place' ? 'bt-debug-heading' : 'bt-debug-heading bt-debug-code', c.heading);
    th.title = `${c.caption}: ${c.text}`;
    if (c.heading !== c.text) heading.title = c.text;
  }

  const body = h(table, 'tbody');
  let target: HTMLElement | null = null;
  for (const row of rows) {
    const tr = h(body, 'tr', `bt-debug-row${row.held ? ' bt-debug-held' : ''}${row.side === 'short' ? ' bt-debug-held-short' : ''}${row.index === focus ? ' bt-debug-focus' : ''}`);
    if (row.index === focus) {
      target = tr;
      tr.setAttribute('aria-current', 'true');
    }
    const when = h(tr, 'th', 'bt-debug-sticky', stamp(row.t, intraday));
    when.scope = 'row';
    h(tr, 'td', 'bt-num', price(row.close));
    h(tr, 'td', 'bt-debug-what', row.what);
    h(tr, 'td', 'bt-debug-position', positionWords(row));
    columns.forEach((c, n) => drawCell(tr, c, row, n));
  }
  if (target) {
    // Two rows of context above the bar, just under the sticky heading.
    let first: Element = target;
    for (let i = 0; i < 2 && first.previousElementSibling; i++) first = first.previousElementSibling;
    box.scrollTop = Math.max(0, first.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - table.tHead!.offsetHeight);
  }
}

function drawCell(tr: HTMLElement, col: DebugColumn, row: DebugRow, n: number): void {
  const cell = row.cells[n];
  const text = cellText(col, cell);
  if (col.kind === 'score' || col.kind === 'place') {
    h(tr, 'td', 'bt-num', text.main);
    return;
  }
  // Each exit rule is in play only while its own side is held.
  const idle = col.group === 'sell' ? !row.readHeld || row.readSide === 'short' : col.group === 'cover' && row.readSide !== 'short';
  const td = h(tr, 'td', `bt-debug-cell bt-debug-${cell.outcome ?? 'na'}${idle ? ' bt-debug-idle' : ''}`);
  if (cell.outcome === null) {
    td.textContent = '–';
    const why =
      col.group === 'add' && row.readHeld
        ? 'the position already had all its entries'
        : col.group === 'cover' && row.readHeld
          ? 'it needs a short position, and a long was held'
          : col.group === 'sell' && row.readSide === 'short'
            ? 'it needs a long position, and a short was held'
            : 'it needs an open position, and none was held';
    td.title = `${col.caption}: ${col.text}\nNot read: ${why}.`;
    return;
  }
  if (text.main) h(td, 'span', 'bt-debug-values', text.main);
  h(td, 'span', 'bt-debug-mark', MARK[cell.outcome]);
  if (text.detail) h(td, 'span', 'bt-debug-detail', text.detail);
  const notInPlay = col.group === 'cover' ? 'No short was held, so the cover rule was not in play.' : row.readSide === 'short' ? 'No long was held, so the sell rule was not in play.' : 'No position was held, so the sell rule was not in play.';
  td.title = [`${col.caption}: ${col.text}`, text.main, MARK[cell.outcome], text.detail, idle ? notInPlay : ''].filter(Boolean).join('\n');
}
