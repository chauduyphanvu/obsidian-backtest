// The `forward` block: the figures since the test began, how they compare with earlier stretches, the orders that changed
// since they were logged, and the log with the button that adds to it. The plugin says how to run the rules and how to write the note.

import { spanStats } from './backtest.ts';
import { colourSource, h } from './dom.ts';
import type { Diagnostic } from './dsl.ts';
import {
  CHANGED,
  forwardChanged,
  forwardFigures,
  logRows,
  newRows,
  parseForward,
  readLog,
  revisions,
  type ForwardBlock,
  type ForwardFigures,
  type ForwardLog,
  type LogRow,
  type Refusal,
} from './forward.ts';
import { pct, plural, signedPct, stamp } from './format.ts';
import type { RunOutput } from './runner.ts';

export interface ForwardHost {
  /** The note's text now and the 0-based line the block opens on; null when the block is not in a note that can be read. */
  note(): Promise<{ text: string; line: number | undefined } | null>;
  /** Runs the frozen rules, reusing a recent result unless `force` (Results.runSource). */
  run(source: string, force: boolean): Promise<RunOutput>;
  /** Adds the rows to the note's log and brings `Checked through` up to the time (writeLog). */
  append(rows: LogRow[], checkedThrough: number): Promise<{ ok: true; added: number } | Refusal>;
  /** Opens the note a link such as `Note name` points to. */
  open(target: string): void;
}

/** What a `from:` link shows and where it leads: `[[Note#Name|Label]]` reads "Note#Name" and opens "Note". */
export function linkParts(from: string): { label: string; target: string } {
  const inner = from.replace(/^\[\[|\]\]$/g, '');
  const label = inner.split('|')[0];
  return { label, target: label.split('#')[0] };
}

/** The two sentences about how the forward test compares with earlier stretches of as many bars, or why it does not yet. */
export function windowLines(f: ForwardFigures): string[] {
  const w = f.windows;
  if (!w.ok) return [w.message];
  return [
    `The gain beat ${pct(w.beaten, 0)} of the ${w.count} earlier stretches of ${plural(f.bars, 'bar')}. The middle one gained ${signedPct(w.typicalReturn)}.`,
    `The worst fall, ${pct(f.worstFall ?? NaN)}, was milder than in ${pct(w.milder, 0)} of them. The middle one fell ${pct(w.typicalFall)}.`,
  ];
}

export interface LogLine {
  text: string;
  /** The button's label; null when there is nothing to add. */
  button: string | null;
}

/**
 * What the log says about itself and what its button offers: the bars with orders that are new to it, or only that no order
 * was given since it was last checked. `through` is the time of the run's last bar.
 */
export function logLine(log: Pick<ForwardLog, 'forward' | 'bars' | 'checkedThrough'>, rows: LogRow[], through: number): LogLine {
  const at = (t: number) => stamp(t, log.forward.intraday);
  const fresh = newRows(log, rows).length;
  const checked = log.checkedThrough === null ? 'It has not been checked yet.' : `It was checked through ${at(log.checkedThrough)}.`;
  if (fresh > 0) return { text: `${plural(fresh, 'bar')} since then gave orders. ${checked}`, button: `Add ${plural(fresh, 'new bar')} to the log` };
  if (log.checkedThrough === null || log.checkedThrough < through) return { text: `No new bar gave an order. ${checked}`, button: `Mark the log checked through ${at(through)}` };
  return { text: `The log is up to date through ${at(log.checkedThrough)}.`, button: null };
}

function errorsIn(root: HTMLElement, errors: Diagnostic[], source: string): void {
  h(root, 'div', 'bt-error-title', errors.length === 1 ? "This forward test can't be read" : `This forward test can't be read: ${errors.length} problems`);
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

/** Draws a `forward` block into `parent` (which the caller has emptied). Returns a cleanup function. */
export function renderForward(parent: HTMLElement, source: string, host: ForwardHost): () => void {
  const root = h(parent, 'div', 'bt-root bt-fwd');
  const { forward, errors } = parseForward(source);
  if (!forward) {
    errorsIn(root, errors, source);
    return () => {};
  }
  if (forwardChanged(forward)) {
    h(root, 'div', 'bt-title', 'Forward test');
    h(root, 'div', 'bt-warning', CHANGED);
    h(root, 'div', 'bt-note', 'Start a new forward test from the strategy, or put the rules back as they were.');
    return () => {};
  }

  let stopped = false;
  const head = h(root, 'div', 'bt-head');
  h(head, 'div', 'bt-title', 'Forward test');
  const refresh = h(head, 'button', 'bt-button', 'Refresh prices');
  const body = h(root, 'div', 'bt-fwd-body');
  const message = (text: string): void => {
    body.replaceChildren();
    h(body, 'div', 'bt-note', text);
  };

  const paint = async (out: RunOutput): Promise<void> => {
    const bt = out.backtest;
    const { t } = bt.run;
    const through = t[t.length - 1];
    const at = (time: number) => stamp(time, forward.intraday);
    const figs = forwardFigures(t, bt.run.equity, bt.benchmark.equity, forward.started);
    const span = figs.bars > 0 ? spanStats(bt, figs.first, t.length) : null;
    const rows = logRows(bt);
    const note = await host.note();
    if (stopped) return;
    const log = note ? readLog(note.text, note.line) : null;
    body.replaceChildren();

    const sub = h(body, 'div', 'bt-sub');
    sub.append(`Started after the bar of ${at(forward.started)}${forward.intraday ? ' UTC' : ''}, from `);
    const { label, target } = linkParts(forward.from);
    const link = h(sub, 'a', 'internal-link bt-fwd-link', label);
    link.setAttribute('data-href', target);
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      host.open(target);
    });
    sub.append(`. The last bar is ${at(through)}.`);
    for (const text of out.warnings) h(body, 'div', 'bt-warning', text);

    if (span === null) {
      h(body, 'div', 'bt-note', `No bar has come since the test began. ${windowLines(figs)[0]}`);
    } else {
      const tiles = h(h(body, 'div', 'bt-fwd-tiles-box'), 'div', 'bt-fwd-tiles');
      const tile = (name: string, value: string, hint: string): void => {
        const el = h(tiles, 'div', 'bt-tile');
        h(el, 'div', 'bt-tile-label', name);
        h(el, 'div', 'bt-tile-value', value);
        h(el, 'div', 'bt-tile-sub', hint);
      };
      const vs = (text: string) => `${bt.benchmark.label} ${text}`;
      tile('Since the start', signedPct(figs.strategy ?? NaN), vs(signedPct(figs.benchmark ?? NaN)));
      tile('Worst fall', pct(figs.worstFall ?? NaN), vs(pct(span.benchmarkStats.maxDrawdown)));
      tile('Bars', String(figs.bars), `after ${at(forward.started)}`);
      tile('Time invested', pct(span.stats.exposure, 0), 'of the bars since');
      for (const line of windowLines(figs)) h(body, 'div', 'bt-note', line);
      if (figs.windows.ok) h(body, 'div', 'bt-note', 'The earlier stretches overlap and are the period the rules may have been chosen on, so this flatters them.');
    }

    if (log !== null) logSection(body, log, rows, through);
    const rules = h(body, 'details', 'bt-details');
    h(rules, 'summary', undefined, 'The frozen rules');
    colourSource(h(rules, 'pre', 'bt-source'), forward.source.trim());
  };

  const logSection = (into: HTMLElement, log: ForwardLog | Refusal, rows: LogRow[], through: number): void => {
    const section = h(into, 'div', 'bt-fwd-log');
    h(section, 'div', 'bt-fwd-heading', 'Log');
    if (!log.ok) {
      h(section, 'div', 'bt-note', `The log can't be used. ${log.message}`);
      return;
    }
    const changed = revisions(log, rows);
    if (changed.length > 0) {
      const list = h(section, 'ul', 'bt-fwd-revisions');
      for (const r of changed) h(list, 'li', undefined, r.message);
      h(section, 'div', 'bt-note', 'Prices adjusted for dividends and splits since then can move an order that was close to its threshold. The log keeps what it said.');
    }
    const line = logLine(log, rows, through);
    h(section, 'div', 'bt-note', line.text);
    if (line.button === null) return;
    const button = h(section, 'button', 'bt-button', line.button);
    const problem = h(section, 'div', 'bt-warning');
    problem.hidden = true;
    button.addEventListener('click', () => {
      button.disabled = true;
      void host
        .append(rows, through)
        .then((r) => {
          if (stopped) return;
          if (r.ok) return load(false, true);
          problem.textContent = r.message;
          problem.hidden = false;
          button.disabled = false;
        })
        .catch((e: unknown) => {
          problem.textContent = `Couldn't write to the note. ${e instanceof Error ? e.message : String(e)}`;
          problem.hidden = false;
          button.disabled = false;
        });
    });
  };

  let latest: RunOutput | null = null;
  /** Runs the rules (or, with `kept`, draws the last run again), then draws. */
  const load = async (force: boolean, kept = false): Promise<void> => {
    refresh.disabled = true;
    try {
      if (!kept || latest === null) {
        message('Running the frozen rules…');
        latest = await host.run(forward.source, force);
      }
      if (!stopped) await paint(latest);
    } catch (e) {
      if (stopped) return;
      body.replaceChildren();
      h(body, 'div', 'bt-error-title', "The frozen rules couldn't run");
      h(body, 'div', 'bt-note', e instanceof Error ? e.message : String(e));
      h(body, 'button', 'bt-button', 'Try again').addEventListener('click', () => void load(false));
    } finally {
      refresh.disabled = false;
    }
  };
  refresh.addEventListener('click', () => void load(true));
  void load(false);
  return () => {
    stopped = true;
  };
}
