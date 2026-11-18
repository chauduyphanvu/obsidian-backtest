// The "Versions" section: each version of the block's text that was run, with its figures and what changed from the one
// before, the changed lines on a click, and a way to put an older text back into the note.

import { h } from './dom.ts';
import type { Defaults } from './dsl.ts';
import { minus, pct, plural } from './format.ts';
import { defaultsHash, lineDiff, MAX_VERSIONS, versionHash, type BlockLedger, type DiffLine, type Ledger, type Version, type VersionFigures } from './ledger.ts';

export interface VersionsInput {
  ledger: BlockLedger;
  /** The block's text as it is now, and the defaults it is drawn with. */
  source: string;
  defaults: Defaults;
  /**
   * Writes a version's text in place of the block's; absent where that can't be done (the preview panel, a block that
   * can't be edited). A rejection means nothing was written, and its message says why in words fit to show.
   */
  restore?: (text: string) => Promise<void>;
}

/** A time on the reader's clock, to the minute: "2026-11-17 14:03". */
export function localStamp(t: number): string {
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

const ratio = (x: number | null) => (x === null ? '–' : minus(x.toFixed(2)));
const share = (x: number | null) => (x === null ? '–' : pct(x));
const signed = (x: number, text: string) => (x > 0 ? `+${text}` : x < 0 ? minus(`-${text}`) : 'unchanged');

/** A version's figures in one line. */
export function figuresText(f: VersionFigures): string {
  return `${share(f.cagr)} a year, worst drawdown ${share(f.maxDrawdown)}, Sharpe ratio ${ratio(f.sharpe)}, ${plural(f.trades, 'trade')}`;
}

/** What changed from `before` to `after`: lines added and removed, then the return a year and the Sharpe ratio. */
export function changeText(before: Version, after: Version): string {
  const diff = lineDiff(before.text, after.text);
  const added = diff.filter((d) => d.op === 'added').length;
  const removed = diff.filter((d) => d.op === 'removed').length;
  const lines = [...(added ? [`${plural(added, 'line')} added`] : []), ...(removed ? [`${plural(removed, 'line')} removed`] : [])];
  const parts = [lines.length ? lines.join(', ') : 'the same text with other default settings'];
  const a = before.figures;
  const b = after.figures;
  if (a.cagr !== null && b.cagr !== null) {
    const points = (b.cagr - a.cagr) * 100;
    parts.push(`return a year ${signed(Number(points.toFixed(1)), `${Math.abs(points).toFixed(1)} points`)}`);
  }
  if (a.sharpe !== null && b.sharpe !== null) {
    const d = b.sharpe - a.sharpe;
    parts.push(`Sharpe ratio ${signed(Number(d.toFixed(2)), Math.abs(d).toFixed(2))}`);
  }
  return parts.join('; ');
}

export interface VersionRow {
  version: Version;
  when: string;
  figures: string;
  /** The version kept before it, which its change is against; null for the oldest kept. */
  previous: Version | null;
  change: string | null;
  /** The block's text and defaults now. */
  current: boolean;
  /** Run with other defaults than the block is drawn with now, which fill in what its text leaves out. */
  otherDefaults: boolean;
}

/** The versions newest first, each against the one kept before it. */
export function versionRows(versions: readonly Version[], now: { hash: string; defaults: string }): VersionRow[] {
  return versions
    .map((version, i) => {
      const previous = i > 0 ? versions[i - 1] : null;
      return {
        version,
        when: localStamp(version.at),
        figures: figuresText(version.figures),
        previous,
        change: previous ? changeText(previous, version) : null,
        current: version.hash === now.hash,
        otherDefaults: version.defaults !== now.defaults,
      };
    })
    .reverse();
}

export const RESTORE = 'Restore this version';
export const RESTORED = "Done: the block now has this version's text.";

const normal = (text: string) => text.replace(/\r/g, '').trimEnd();

/** Appends a collapsed "Versions" section. Returns a cleanup function. */
export function renderVersions(parent: HTMLElement, input: VersionsInput): () => void {
  const details = h(parent, 'details', 'bt-details bt-versions');
  h(details, 'summary', undefined, 'Versions');
  let stop = () => {};
  details.addEventListener('toggle', () => (stop = fill(h(details, 'div', 'bt-versions-body'), input)), { once: true });
  return () => stop();
}

function fill(body: HTMLElement, input: VersionsInput): () => void {
  let gone = false;
  const now = { hash: versionHash(input.source, input.defaults), defaults: defaultsHash(input.defaults) };
  const draw = (l: Ledger) => {
    if (gone) return;
    body.replaceChildren();
    const rows = versionRows(l.versions, now);
    if (rows.length === 0) {
      h(body, 'p', 'bt-note', 'No version of this block has been recorded yet.');
      return;
    }
    h(
      body,
      'p',
      'bt-note',
      `${plural(rows.length, 'version')} of this block, newest first: each text that was run, with the default settings it was run with. The first one and the latest ${MAX_VERSIONS} are kept.`,
    );
    const list = h(body, 'ol', 'bt-versions-list');
    for (const row of rows) versionItem(h(list, 'li', row.current ? 'bt-version bt-version-current' : 'bt-version'), row, input);
  };
  void input.ledger.read().then(draw);
  const unwatch = input.ledger.watch(draw);
  return () => {
    gone = true;
    unwatch();
  };
}

function versionItem(li: HTMLElement, row: VersionRow, input: VersionsInput): void {
  const head = h(li, 'div', 'bt-version-head');
  h(head, 'span', 'bt-version-when', row.when);
  if (row.current) h(head, 'span', 'bt-version-tag', 'This version');
  h(li, 'div', 'bt-version-figures', row.figures);
  h(li, 'div', 'bt-version-change', row.change ? `Against the version before: ${row.change}.` : 'The oldest version kept.');
  if (row.otherDefaults) h(li, 'div', 'bt-version-change', 'Run with other default settings than the block has now.');
  const actions = h(li, 'div', 'bt-run-row');
  const shown = h(li, 'pre', 'bt-version-diff');
  shown.hidden = true;
  const label = row.previous ? ['Show the changes', 'Hide the changes'] : ['Show the text', 'Hide the text'];
  const toggle = h(actions, 'button', 'bt-button', label[0]);
  toggle.addEventListener('click', () => {
    if (shown.childElementCount === 0) {
      const lines: DiffLine[] = row.previous ? lineDiff(row.previous.text, row.version.text) : row.version.text.split(/\r?\n/).map((text) => ({ op: 'same', text }));
      for (const d of lines) h(shown, 'span', `bt-diff-line bt-diff-${d.op}`, `${d.op === 'added' ? '+' : d.op === 'removed' ? '−' : ' '} ${d.text}`);
    }
    shown.hidden = !shown.hidden;
    toggle.textContent = label[shown.hidden ? 0 : 1];
  });
  const restore = input.restore;
  if (!restore || normal(row.version.text) === normal(input.source)) return;
  const put = h(actions, 'button', 'bt-button', RESTORE);
  const said = h(actions, 'span', 'bt-note');
  put.addEventListener('click', async () => {
    put.disabled = true;
    said.textContent = '';
    try {
      await restore(row.version.text);
      said.textContent = RESTORED;
    } catch (e) {
      said.textContent = e instanceof Error ? e.message : String(e);
      put.disabled = false;
    }
  });
}
