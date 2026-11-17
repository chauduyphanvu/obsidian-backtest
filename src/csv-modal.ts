import { Modal, type App } from 'obsidian';
import { cleanedPath, csvColumn, csvStrategy, csvTicker, dateOrderIsAmbiguous, dateSeparator, inspectCsv, remapCsv, type CsvInspection, type CsvMapping, type CsvRead, type CsvRow, type CsvSignal, type CsvUnread, type DateOrder } from './csv-import.ts';
import { h, price } from './dom.ts';

export interface CsvHost {
  /** Vault paths of every .csv file. */
  files(): string[];
  read(path: string): Promise<string>;
  /** Writes a new file at or near `path` without replacing anything; resolves to the path used. */
  create(path: string, text: string): Promise<string>;
  /** Inserts text at the cursor of the note being edited; false when no note is open for editing. */
  insert(text: string): boolean;
}

/** Files shown at once; typing narrows the rest. */
const MOST_SHOWN = 200;

/** What the menu for each column offers when the file has none; a role with no entry must be chosen. */
const ROLES = [
  { key: 'date', label: 'Date' },
  { key: 'open', label: 'Open', none: 'none (use close)' },
  { key: 'high', label: 'High', none: 'none (open or close)' },
  { key: 'low', label: 'Low', none: 'none (open or close)' },
  { key: 'close', label: 'Close' },
  { key: 'volume', label: 'Volume', none: 'none (use 0)' },
  { key: 'adjClose', label: 'Adjusted close', none: 'none' },
] as const;

const COLUMNS = [
  { label: 'Date', key: 'date' },
  { label: 'Open', key: 'open' },
  { label: 'High', key: 'high' },
  { label: 'Low', key: 'low' },
  { label: 'Close', key: 'close' },
  { label: 'Volume', key: 'volume' },
] as const;

const NOTE = 'bt-note bt-csv-note';

interface Open {
  path: string;
  text: string;
  found: CsvInspection;
  mapping: CsvMapping;
}

/** Names of the file's columns for a menu; a repeated or empty name gets its column number. */
function columnLabels(header: string[]): string[] {
  return header.map((name, i) => (name === '' || header.indexOf(name) !== header.lastIndexOf(name) ? `${name || 'no name'} (column ${i + 1})` : name));
}

const volume = (v: number) => Math.round(v).toLocaleString('en-US');
/** A column's value as short as it can be without hiding what it is. */
const value = (x: number) => (Number.isInteger(x) ? x.toLocaleString('en-US') : String(Number(x.toPrecision(6))));
const signalStats = (s: CsvSignal, rows: number) => `${value(s.first.value)} on ${s.first.date} to ${value(s.last.value)} on ${s.last.date}. ${s.count.toLocaleString('en-US')} of ${rows.toLocaleString('en-US')} rows have a number.`;
const cellsOf = (r: CsvRow) => [r.date, price(r.open), price(r.high), price(r.low), price(r.close), volume(r.volume)];

export class CsvModal extends Modal {
  private host: CsvHost;
  private root: HTMLElement | null = null;
  /** Counts file reads, so an answer that comes after another choice or after closing is dropped. */
  private ticket = 0;

  constructor(app: App, host: CsvHost) {
    super(app);
    this.host = host;
  }

  onOpen(): void {
    this.modalEl.classList.add('bt-csv-modal');
    this.titleEl.textContent = 'Use a CSV file in a strategy';
    this.root = h(this.contentEl, 'div', 'bt-csv');
    this.showList();
  }

  onClose(): void {
    this.ticket++;
    this.contentEl.replaceChildren();
  }

  private fresh(): HTMLElement {
    this.ticket++;
    this.root!.replaceChildren();
    return this.root!;
  }

  private showList(): void {
    const root = this.fresh();
    const files = [...this.host.files()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
    if (files.length === 0) {
      h(root, 'p', 'bt-csv-empty', 'There are no CSV files in this vault. Add one with a row for each day and at least a date column and a close column, then open this window again.');
      return;
    }
    const input = h(root, 'input', 'bt-csv-filter');
    input.type = 'search';
    input.placeholder = 'Type to narrow the list of CSV files';
    input.setAttribute('aria-label', 'Narrow the list of CSV files');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-controls', 'bt-csv-files');
    input.setAttribute('aria-expanded', 'true');
    const count = h(root, 'div', 'bt-csv-count');
    count.setAttribute('role', 'status');
    const list = h(root, 'ul', 'bt-csv-files');
    list.id = 'bt-csv-files';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'CSV files');

    let shown: string[] = [];
    let at = 0;
    const mark = () => {
      [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === at)));
      const current = list.children[at] as HTMLElement | undefined;
      if (current) {
        input.setAttribute('aria-activedescendant', current.id);
        current.scrollIntoView({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
    };
    const draw = () => {
      const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      const found = files.filter((f) => words.every((w) => f.toLowerCase().includes(w)));
      shown = found.slice(0, MOST_SHOWN);
      at = 0;
      list.replaceChildren();
      shown.forEach((path, i) => {
        const li = h(list, 'li', 'bt-csv-file');
        li.id = `bt-csv-file-${i}`;
        li.setAttribute('role', 'option');
        const slash = path.lastIndexOf('/') + 1;
        if (slash > 0) h(li, 'span', 'bt-csv-dir', path.slice(0, slash));
        h(li, 'span', 'bt-csv-name', path.slice(slash));
        li.addEventListener('click', () => void this.showFile(path));
      });
      count.textContent =
        found.length === 0
          ? `No CSV file matches "${input.value.trim()}".`
          : found.length > shown.length
            ? `Showing the first ${shown.length} of ${found.length} files. Type to narrow the list.`
            : words.length > 0
              ? `${found.length} of ${files.length} files`
              : `${files.length} ${files.length === 1 ? 'file' : 'files'}`;
      mark();
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        at = Math.max(0, Math.min(shown.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
        mark();
      } else if (e.key === 'Enter' && !e.isComposing && shown[at] !== undefined) {
        e.preventDefault();
        void this.showFile(shown[at]);
      }
    });
    draw();
    input.focus();
  }

  private bar(root: HTMLElement, path: string): void {
    const bar = h(root, 'div', 'bt-csv-bar');
    h(bar, 'button', 'bt-csv-back', 'Back').addEventListener('click', () => this.showList());
    h(bar, 'code', 'bt-csv-path', path);
  }

  private async showFile(path: string): Promise<void> {
    const root = this.fresh();
    const mine = this.ticket;
    this.bar(root, path);
    const status = h(root, 'div', 'bt-csv-status', 'Reading the file…');
    status.setAttribute('role', 'status');
    let text: string;
    try {
      text = await this.host.read(path);
    } catch (e) {
      if (mine !== this.ticket) return;
      status.remove();
      h(root, 'div', 'bt-error-title', "Couldn't read the file");
      h(root, 'p', 'bt-csv-lead', e instanceof Error ? e.message : String(e));
      return;
    }
    if (mine !== this.ticket) return;
    status.remove();
    const found = inspectCsv(text);
    const mapping: CsvMapping = { ...found.columns, dateOrder: found.ambiguousDates ? 'month-first' : null };
    const file: Open = { path, text, found, mapping };
    if (found.read) this.showRead(root, file, found);
    else this.showUnread(root, file, found);
    root.querySelector<HTMLElement>('.bt-csv-back')?.focus();
  }

  private showRead(root: HTMLElement, file: Open, found: CsvRead): void {
    h(root, 'div', 'bt-csv-title', 'The plugin can read this file.');
    const adjusted = found.columns.adjClose === null ? '' : ` Prices are scaled by the "${found.header[found.columns.adjClose]}" column.`;
    h(root, 'p', 'bt-csv-lead', `${found.rows.toLocaleString('en-US')} rows, from ${found.first} to ${found.last}.${adjusted}`);
    if (!found.priced) {
      h(root, 'p', 'bt-csv-lead', 'This file has no prices. A strategy can read its columns but cannot trade it.');
      for (const doubt of found.doubts) h(root, 'div', 'bt-warning', doubt);
      this.signals(root, file.path, found);
      // Headers the reader does not know, such as o, h, l and c, can still be prices: the form makes a copy that has them.
      const fix = h(root, 'details', 'bt-csv-fix');
      h(fix, 'summary', undefined, 'Are some of these columns prices? Choose them yourself');
      this.form(fix, file);
      return;
    }
    // A column that has the usual name needs no explanation.
    const used = (key: keyof CsvMapping, label: string) => {
      const i = found.columns[key];
      if (typeof i !== 'number') return key === 'volume' ? 'not in the file: 0' : 'not in the file';
      return found.header[i].toLowerCase() === label.toLowerCase() ? null : `from "${found.header[i]}"`;
    };
    const rows = [...found.head.map(cellsOf), ...(found.tail.length > 0 && found.rows > found.head.length + found.tail.length ? [null] : []), ...found.tail.map(cellsOf)];
    this.table(root, COLUMNS.map((c) => ({ label: c.label, from: used(c.key, c.label) })), rows);
    for (const doubt of found.doubts) h(root, 'div', 'bt-warning', doubt);
    this.actions(root, file.path);
    this.signals(root, file.path, found);
    const fix = h(root, 'details', 'bt-csv-fix');
    fix.open = found.ambiguousDates;
    h(fix, 'summary', undefined, 'Something looks wrong? Choose the columns or the date order yourself');
    this.form(fix, file);
  }

  private showUnread(root: HTMLElement, file: Open, found: CsvUnread): void {
    h(root, 'div', 'bt-error-title', "The plugin can't read this file as it is");
    h(root, 'p', 'bt-csv-lead', found.reason);
    if (found.header.length > 0) {
      h(root, 'div', 'bt-csv-label', 'How the file looks');
      this.table(root, found.header.map((name) => ({ label: name || 'no name', from: null })), found.rawRows, true);
    }
    this.form(root, file);
  }

  /** A small table; a null row stands for the rows left out in between. */
  private table(parent: HTMLElement, head: { label: string; from: string | null }[], rows: (string[] | null)[], raw = false): void {
    const table = h(h(parent, 'div', 'bt-wide'), 'table', raw ? 'bt-csv-table bt-csv-raw' : 'bt-csv-table');
    const tr = h(h(table, 'thead'), 'tr');
    for (const c of head) {
      const th = h(tr, 'th');
      h(th, 'div', 'bt-csv-role', c.label);
      if (c.from !== null) h(th, 'div', 'bt-csv-from', c.from);
    }
    const body = h(table, 'tbody');
    for (const row of rows) {
      const r = h(body, 'tr', row === null ? 'bt-csv-gap' : undefined);
      if (row === null) h(r, 'td', undefined, '…').colSpan = head.length;
      else head.forEach((_, i) => h(r, 'td', undefined, row[i] ?? ''));
    }
  }

  /** The two ways to use a file that can be named in a strategy, or why it cannot. */
  private actions(parent: HTMLElement, path: string): void {
    const box = h(parent, 'div', 'bt-csv-actions-box');
    const ticker = csvTicker(path);
    if (!ticker.ok) {
      h(box, 'div', 'bt-warning', ticker.reason);
      return;
    }
    const strategy = csvStrategy(path);
    const row = h(box, 'div', 'bt-csv-actions');
    h(row, 'button', undefined, 'Insert the ticker').addEventListener('click', () => this.deliver(box, ticker.text));
    if (strategy.ok) h(row, 'button', 'mod-cta', 'Insert a strategy using it').addEventListener('click', () => this.deliver(box, strategy.text));
    if (ticker.note) h(box, 'div', NOTE, ticker.note);
    if (!strategy.ok) h(box, 'div', NOTE, strategy.reason);
  }

  /** The columns a rule can read, each with a button that inserts the text that reads it, and why any could not be read. */
  private signals(parent: HTMLElement, path: string, found: CsvRead): void {
    for (const sentence of found.unreadable) h(parent, 'div', 'bt-warning', sentence);
    if (found.signals.length === 0) return;
    const box = h(parent, 'div', 'bt-csv-actions-box');
    h(box, 'div', 'bt-csv-label', found.priced ? 'Other columns a rule can read' : 'Columns a rule can read');
    const list = h(box, 'ul', 'bt-csv-signals');
    let note: string | null = null;
    let reason: string | null = null;
    for (const signal of found.signals) {
      const li = h(list, 'li', 'bt-csv-signal');
      const head = h(li, 'div', 'bt-csv-signal-head');
      h(head, 'code', 'bt-csv-signal-name', signal.name);
      if (signal.header !== signal.name) h(head, 'span', 'bt-csv-from', `from "${signal.header}"`);
      h(li, 'div', 'bt-csv-signal-stats', signalStats(signal, found.rows));
      const rule = csvColumn(path, signal.name, found.priced);
      if (!rule.ok) {
        reason = rule.reason;
        continue;
      }
      note = rule.note;
      const row = h(li, 'div', 'bt-csv-signal-rule');
      h(row, 'code', undefined, rule.text);
      const insert = h(row, 'button', undefined, 'Insert');
      insert.setAttribute('aria-label', `Insert ${rule.text}`);
      insert.addEventListener('click', () => this.deliver(box, rule.text));
    }
    if (reason) h(box, 'div', 'bt-warning', reason);
    if (note) h(box, 'div', NOTE, note);
    h(box, 'div', NOTE, found.dating);
  }

  /** Puts the text in the note, or shows it to copy when no note is open for editing. */
  private deliver(box: HTMLElement, text: string): void {
    if (this.host.insert(text)) {
      this.close();
      return;
    }
    box.replaceChildren();
    h(box, 'p', 'bt-csv-lead', 'No note is open for editing. Copy this text and paste it into a note.');
    const pre = h(box, 'pre', 'bt-source bt-csv-copy', text);
    const row = h(box, 'div', 'bt-csv-actions');
    const copy = h(row, 'button', 'mod-cta', 'Copy');
    const said = h(row, 'span', 'bt-csv-status');
    said.setAttribute('role', 'status');
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(
        () => (said.textContent = 'Copied'),
        () => {
          window.getSelection()?.selectAllChildren(pre);
          said.textContent = 'The text is selected. Press Ctrl+C or Cmd+C to copy it.';
        },
      );
    });
    copy.focus();
  }

  /** Menus to say which column is which, a live look at the result, and the button that saves it. */
  private form(parent: HTMLElement, file: Open): void {
    const { header } = file.found;
    const labels = columnLabels(header);
    const box = h(parent, 'div', 'bt-csv-form');
    const grid = h(box, 'div', 'bt-csv-fields');
    const showPicks = ROLES.filter((r) => r.key !== 'adjClose' || file.mapping.adjClose !== null);
    for (const role of showPicks) {
      const field = h(grid, 'label', 'bt-csv-field');
      h(field, 'span', 'bt-csv-label', role.label);
      const select = h(field, 'select', 'dropdown');
      const current = file.mapping[role.key];
      h(select, 'option', undefined, 'none' in role ? role.none : 'Choose a column').value = '';
      labels.forEach((label, i) => (h(select, 'option', undefined, label).value = String(i)));
      select.value = current === null ? '' : String(current);
      select.addEventListener('change', () => {
        file.mapping[role.key] = select.value === '' ? null : Number(select.value);
        refresh();
      });
    }
    const order = h(box, 'label', 'bt-csv-field bt-csv-order');
    const orderLabel = h(order, 'span', 'bt-csv-label');
    const choose = h(order, 'select', 'dropdown');
    const monthFirst = h(choose, 'option');
    monthFirst.value = 'month-first';
    const dayFirst = h(choose, 'option');
    dayFirst.value = 'day-first';
    /** The question in the file's own way of writing dates: 02/01/2024 or 02-01-2024. */
    const ask = (sep: string) => {
      const date = (a: string, b: string) => `${a}${sep}${b}${sep}2024`;
      orderLabel.textContent = `Dates such as ${date('02', '01')} are`;
      monthFirst.textContent = `month first, so 2 January is ${date('01', '02')}`;
      dayFirst.textContent = `day first, so 2 January is ${date('02', '01')}`;
    };
    ask('/');
    choose.value = file.mapping.dateOrder ?? 'month-first';
    choose.addEventListener('change', () => {
      file.mapping.dateOrder = choose.value as DateOrder;
      refresh();
    });
    const preview = h(box, 'div', 'bt-csv-preview');
    const foot = h(box, 'div', 'bt-csv-actions');
    const save = h(foot, 'button', 'mod-cta', 'Save a cleaned copy and use it');
    const problem = h(box, 'div', NOTE);
    problem.setAttribute('role', 'status');

    const refresh = () => {
      const { mapping } = file;
      const ambiguous = mapping.date !== null && dateOrderIsAmbiguous(file.text, mapping.date);
      order.hidden = !ambiguous;
      if (ambiguous) ask(dateSeparator(file.text, mapping.date!));
      if (!ambiguous) mapping.dateOrder = null;
      else if (mapping.dateOrder === null) mapping.dateOrder = choose.value as DateOrder;
      preview.replaceChildren();
      problem.textContent = '';
      const cleaned = remapCsv(file.text, mapping);
      save.disabled = !cleaned.ok;
      if (!cleaned.ok) {
        h(preview, 'div', 'bt-warning', cleaned.reason);
        return;
      }
      h(preview, 'div', 'bt-csv-label', `How it would be read: ${cleaned.rows.toLocaleString('en-US')} rows, from ${cleaned.first} to ${cleaned.last}`);
      this.table(preview, COLUMNS.map((c) => ({ label: c.label, from: null })), cleaned.sample.map(cellsOf));
      for (const note of cleaned.notes) h(preview, 'div', 'bt-warning', note);
    };
    save.addEventListener('click', () => void this.save(file, problem));
    refresh();
  }

  private async save(file: Open, problem: HTMLElement): Promise<void> {
    const cleaned = remapCsv(file.text, file.mapping);
    if (!cleaned.ok) return;
    const mine = this.ticket;
    problem.textContent = 'Saving…';
    let saved: string;
    try {
      saved = await this.host.create(cleanedPath(file.path), cleaned.text);
    } catch (e) {
      if (mine === this.ticket) problem.textContent = `Couldn't save the file: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    if (mine !== this.ticket) return;
    const root = this.fresh();
    this.bar(root, saved);
    h(root, 'div', 'bt-csv-title', 'Saved a cleaned copy');
    h(root, 'p', 'bt-csv-lead', `${saved} has ${cleaned.rows.toLocaleString('en-US')} rows, from ${cleaned.first} to ${cleaned.last}. The original is unchanged.`);
    for (const note of cleaned.notes) h(root, 'div', 'bt-warning', note);
    this.actions(root, saved);
    root.querySelector<HTMLElement>('.bt-csv-back')?.focus();
  }
}
