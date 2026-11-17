import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ItemView, MarkdownView, type App, type WorkspaceLeaf } from 'obsidian';
import { h } from './dom.ts';
import type { Diagnostic } from './dsl.ts';
import { hintFor } from './fixes.ts';
import { Latest, blockLabel, changeKind, chooseBlock, locateBlock, waitFor, type Choice, type Shown } from './live-core.ts';
import { debounce } from './result-cache.ts';

export const VIEW_TYPE_LIVE = 'backtest-live';

/** What the panel needs from the plugin. */
export interface LiveHost {
  /**
   * Draws the strategy's result into `el` (clearing it first). Resolves when drawn, with a function that disposes of it. Rejects
   * when the run fails. When `signal` aborts before then, the run is stopped and the draw resolves with nothing drawn. A draw
   * that fails lets go of what it held.
   */
  show(source: string, el: HTMLElement, opts: { notePath: string; apply: (values: Record<string, number>) => Promise<void>; signal: AbortSignal }): Promise<() => void>;
  /** True when the block parses and every ticker's prices are already saved, so running it needs no download. */
  pricesReady(source: string): Promise<boolean>;
  /** The block's problems, empty when it can run. */
  errors(source: string): Diagnostic[];
  /** The block's text with these parameter values written in. */
  rewrite(source: string, values: Record<string, number>): string;
}

/** After the last edit or cursor move, how long to wait before reading the note. Reading is cheap; this keeps it to once per burst. */
const LOOK_AFTER_MS = 80;
/** Problems listed before "and N more". An unclosed fence can pull in the rest of the note. */
const MAX_ERRORS = 6;
/** The longest to wait for a new result's charts to draw before showing it anyway. */
const SETTLE_MS = 200;

const openViews = new Set<LiveView>();

/** Tells every open panel that a note's text or cursor changed. */
export function pokeLiveViews(): void {
  for (const view of openViews) view.poke();
}

/** An editor extension that calls `onChange` when the text or the selection changed. It only schedules; nothing is read here. */
export function liveEditorExtension(onChange: () => void): Extension {
  return EditorView.updateListener.of((update) => {
    if (update.docChanged || update.selectionSet) onChange();
  });
}

/** Opens the panel in the right sidebar, or shows it if it is open already. The editor keeps the focus. */
export async function openLivePanel(app: App): Promise<void> {
  const { workspace } = app;
  let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_LIVE)[0] ?? null;
  if (!leaf) {
    leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_LIVE, active: false });
  }
  await workspace.revealLeaf(leaf);
}

type Reading = { kind: 'no-note' } | { kind: 'no-block' } | { kind: 'block'; view: MarkdownView; note: string; noteName: string; choice: Choice };
type BlockReading = Extract<Reading, { kind: 'block' }>;
type Problem = { kind: 'errors'; errors: Diagnostic[]; text: string } | { kind: 'failed'; message: string; retry: () => void };
interface Drawn {
  el: HTMLElement;
  dispose: () => void;
  note: string;
  index: number;
}

const EMPTY_TEXT = {
  'no-note': 'Open a note to see the result of its strategy block here. The result updates as you type.',
  'no-block': 'This note has no strategy block yet. Type one, or run the command "Insert strategy block", and its result will appear here as you write.',
};

export class LiveView extends ItemView {
  private host: LiveHost;
  private followed: MarkdownView | null = null;
  /** The block shown last from each note, by position, for when the cursor is outside every block. */
  private lastIndex = new Map<string, number>();
  /** What the panel shows (a result, or problems with its text), and what is waiting or running. */
  private drawn: Shown | null = null;
  private pending: Shown | null = null;
  private result: Drawn | null = null;
  private problem: Problem | null = null;
  private empty: keyof typeof EMPTY_TEXT | null = null;
  private running = false;
  private timer: number | undefined;
  /** Counts runs, so the answer of an older one is dropped when a newer one has started. */
  private runId = 0;
  /** The run in flight: a newer run, or closing the panel, stops it. */
  private latest = new Latest();
  /** Counts looks at the note, so a look that was waiting for an answer gives way to a newer one. */
  private looks = 0;
  private look = debounce(() => void this.refresh(), LOOK_AFTER_MS);
  private head!: HTMLElement;
  private heading!: HTMLElement;
  private status!: HTMLElement;
  private body!: HTMLElement;
  private top!: HTMLElement;
  private stage!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, host: LiveHost) {
    super(leaf);
    this.host = host;
    this.navigation = false;
  }

  getViewType(): string {
    return VIEW_TYPE_LIVE;
  }

  getDisplayText(): string {
    return 'Strategy preview';
  }

  getIcon(): string {
    return 'line-chart';
  }

  async onOpen(): Promise<void> {
    openViews.add(this);
    this.contentEl.classList.add('bt-live-view');
    const root = h(this.contentEl, 'div', 'bt-live');
    this.head = h(root, 'div', 'bt-live-head');
    this.heading = h(this.head, 'div', 'bt-live-title');
    this.status = h(this.head, 'div', 'bt-live-status');
    this.body = h(root, 'div', 'bt-live-body');
    this.top = h(this.body, 'div', 'bt-live-top');
    // A new result is drawn here, out of sight, so the old one stays until the new one is ready.
    this.stage = h(root, 'div', 'bt-live-stage');
    const { workspace } = this.app;
    this.registerEvent(workspace.on('active-leaf-change', () => this.poke()));
    this.registerEvent(workspace.on('file-open', () => this.poke()));
    this.registerEvent(workspace.on('layout-change', () => this.poke()));
    workspace.onLayoutReady(() => this.poke());
    void this.refresh();
  }

  async onClose(): Promise<void> {
    openViews.delete(this);
    this.look.cancel();
    this.cancelRun();
    this.dropResult();
  }

  onResize(): void {
    this.poke();
  }

  /** Something may have changed: look at the note once typing and cursor moves have settled. */
  poke(): void {
    this.look();
  }

  /** The note the panel follows: the active editor, and when the panel itself is active, the one that was. */
  private followedView(): MarkdownView | null {
    const { workspace } = this.app;
    const active = workspace.getActiveViewOfType(MarkdownView);
    if (active) return (this.followed = active);
    if (this.followed?.containerEl.isConnected && this.followed.file) return this.followed;
    const recent = workspace.getMostRecentLeaf()?.view;
    if (recent instanceof MarkdownView) return (this.followed = recent);
    const found: MarkdownView[] = [];
    workspace.iterateRootLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView) found.push(leaf.view);
    });
    return (this.followed = found[0] ?? null);
  }

  private read(): Reading {
    const view = this.followedView();
    const file = view?.file;
    if (!view || !file) return { kind: 'no-note' };
    const { editor } = view;
    // Reading mode has no cursor to follow.
    const cursor = view.getMode() === 'source' ? editor.getCursor('head').line : null;
    const choice = chooseBlock(editor.getValue().split('\n'), cursor, this.lastIndex.get(file.path) ?? null);
    return choice ? { kind: 'block', view, note: file.path, noteName: file.basename, choice } : { kind: 'no-block' };
  }

  private async refresh(): Promise<void> {
    const seq = ++this.looks;
    // A panel nobody can see, such as a collapsed sidebar, does not run anything. Showing it again looks at the note again.
    if (!this.containerEl.isShown()) return;
    const reading = this.read();
    if (reading.kind !== 'block') {
      this.showEmpty(reading.kind);
      return;
    }
    const { note, choice } = reading;
    this.lastIndex.set(note, choice.index);
    const selected: Shown = { note, index: choice.index, text: choice.text };
    let change = changeKind(this.drawn, this.pending, selected);
    const errors = change === 'edit' || change === 'switch' ? this.host.errors(selected.text) : [];
    let pricesReady = false;
    if (change === 'edit' && errors.length === 0) {
      try {
        pricesReady = await this.host.pricesReady(selected.text);
      } catch {
        pricesReady = false;
      }
      if (seq !== this.looks) return;
      // A run may have finished while waiting for the answer.
      change = changeKind(this.drawn, this.pending, selected);
    }
    if (change === 'none' || change === 'cancel') {
      if (change === 'cancel') this.cancelRun();
      this.relabel(reading);
      return;
    }
    this.pending = selected;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.run(reading, selected), waitFor(change, { errors: errors.length > 0, pricesReady }));
    if (this.empty) {
      this.empty = null;
      this.paint();
    }
  }

  private async run(reading: BlockReading, selected: Shown): Promise<void> {
    this.timer = undefined;
    if (!this.containerEl.isShown()) {
      if (this.pending === selected) this.pending = null;
      return;
    }
    const id = ++this.runId;
    const signal = this.latest.start();
    const errors = this.host.errors(selected.text);
    if (errors.length > 0) {
      this.showProblem(reading, selected, { kind: 'errors', errors, text: selected.text });
      return;
    }
    this.running = true;
    this.paint();
    const el = h(this.stage, 'div', 'bt-live-result');
    let dispose: (() => void) | null = null;
    const drop = () => {
      dispose?.();
      el.remove();
    };
    try {
      dispose = await this.host.show(selected.text, el, { notePath: reading.note, apply: (values) => this.apply(reading, selected, values), signal });
      if (id !== this.runId) return drop();
      if (this.result && this.sameBlock(selected)) restoreOpen(el, openDetails(this.result.el));
      await settle();
      if (id !== this.runId) return drop();
    } catch (e) {
      el.remove();
      if (id === this.runId) this.showProblem(reading, selected, { kind: 'failed', message: e instanceof Error ? e.message : String(e), retry: () => void this.retry(reading, selected) });
      return;
    }
    const scroll = this.sameBlock(selected) ? this.body.scrollTop : 0;
    this.dropResult();
    this.body.append(el);
    this.result = { el, dispose, note: selected.note, index: selected.index };
    this.problem = null;
    this.arrived(reading, selected);
    this.body.scrollTop = scroll;
  }

  private async retry(reading: BlockReading, selected: Shown): Promise<void> {
    this.pending = selected;
    await this.run(reading, selected);
  }

  private showProblem(reading: BlockReading, selected: Shown, problem: Problem): void {
    // A last version belongs to one block: another block has none.
    if (!this.sameBlock(selected)) {
      this.dropResult();
      this.body.scrollTop = 0;
    }
    this.problem = problem;
    this.arrived(reading, selected);
  }

  /** What was asked for is now on screen. */
  private arrived(reading: BlockReading, selected: Shown): void {
    this.running = false;
    this.drawn = selected;
    if (this.pending === selected) this.pending = null;
    this.setHeading(reading);
    this.paint();
  }

  /** The text on screen is still what the note says, but its position or name may have changed. */
  private relabel(reading: BlockReading): void {
    const { drawn, result } = this;
    if (!drawn || drawn.note !== reading.note || drawn.text !== reading.choice.text) return;
    drawn.index = reading.choice.index;
    if (result) result.index = reading.choice.index;
    this.setHeading(reading);
  }

  private sameBlock(selected: Shown): boolean {
    return this.result !== null && this.result.note === selected.note && this.result.index === selected.index;
  }

  private cancelRun(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.runId++;
    this.latest.stop();
    this.pending = null;
    if (this.running) {
      this.running = false;
      this.status.textContent = '';
    }
  }

  private dropResult(): void {
    this.result?.dispose();
    this.result?.el.remove();
    this.result = null;
  }

  private showEmpty(kind: keyof typeof EMPTY_TEXT): void {
    if (this.empty === kind) return;
    this.cancelRun();
    this.dropResult();
    this.problem = null;
    this.drawn = null;
    this.empty = kind;
    this.head.hidden = true;
    this.top.replaceChildren();
    this.status.textContent = '';
    h(this.top, 'div', 'bt-note bt-live-empty', EMPTY_TEXT[kind]);
  }

  private setHeading(reading: BlockReading): void {
    this.head.hidden = false;
    this.heading.replaceChildren();
    h(this.heading, 'span', 'bt-live-note', reading.noteName);
    this.heading.append(' · ');
    h(this.heading, 'span', 'bt-live-strategy', blockLabel(reading.choice));
  }

  /** Redraws what sits above the result: problems, the line about the last version, or the wait for the first one. */
  private paint(): void {
    const { problem, result, top } = this;
    top.replaceChildren();
    this.status.textContent = this.running ? 'Updating…' : '';
    if (problem) {
      const box = h(top, 'div', 'bt-root');
      if (problem.kind === 'errors') drawErrors(box, problem.errors, problem.text);
      else {
        h(box, 'div', 'bt-error-title', "The backtest couldn't run");
        h(box, 'div', 'bt-note', problem.message);
        h(box, 'button', 'bt-button', 'Try again').addEventListener('click', problem.retry);
      }
      if (result) h(top, 'div', 'bt-note bt-live-last', 'The result below is the last version that ran.');
    } else if (!result) {
      h(top, 'div', 'bt-note', 'Running the strategy…');
    }
    if (result) {
      const stale = problem !== null;
      result.el.classList.toggle('bt-live-dim', stale);
      result.el.inert = stale;
    }
  }

  /** Writes parameter values into the block in the editor, if the block is still what the result was drawn from. */
  private async apply(reading: BlockReading, selected: Shown, values: Record<string, number>): Promise<void> {
    const { view } = reading;
    if (view.file?.path !== reading.note) throw new Error('That note is no longer open in its editor. Open it again, then write the values.');
    const lines = view.editor.getValue().split('\n');
    const at = locateBlock(lines, selected.text, selected.index);
    if (!at) throw new Error('The block has changed since this result was drawn. Wait for the panel to update, then write the values again.');
    const next = this.host.rewrite(selected.text, values);
    if (next === selected.text) return;
    view.editor.replaceRange(next, { line: at.first, ch: 0 }, { line: at.last, ch: lines[at.last].length });
  }
}

/** The problems with a block, in the words of the result shown in the note, without repeating the block itself. */
export function drawErrors(root: HTMLElement, errors: Diagnostic[], text: string): void {
  h(root, 'div', 'bt-error-title', errors.length === 1 ? "This strategy can't run yet" : `This strategy can't run yet: ${errors.length} problems`);
  const lines = text.split('\n');
  const list = h(root, 'ul', 'bt-errors');
  for (const e of errors.slice(0, MAX_ERRORS)) {
    const li = h(list, 'li');
    h(li, 'span', 'bt-error-line', `Line ${e.line}`);
    h(li, 'span', undefined, e.message);
    const line = lines[e.line - 1]?.trim();
    if (line) h(li, 'code', 'bt-error-src', line);
    const hint = hintFor(lines, e);
    if (hint) h(li, 'span', 'bt-error-hint', hint);
  }
  if (errors.length > MAX_ERRORS) h(root, 'div', 'bt-note', `And ${errors.length - MAX_ERRORS} more.`);
}

/** Which sections of a result are open, by their titles, so the next result can open the same ones. */
function openDetails(el: HTMLElement): Map<string, boolean> {
  const seen = new Map<string, number>();
  const state = new Map<string, boolean>();
  for (const d of el.querySelectorAll('details')) {
    const title = d.querySelector('summary')?.textContent ?? '';
    const n = seen.get(title) ?? 0;
    seen.set(title, n + 1);
    state.set(`${title}#${n}`, d.open);
  }
  return state;
}

function restoreOpen(el: HTMLElement, state: Map<string, boolean>): void {
  const seen = new Map<string, number>();
  for (const d of el.querySelectorAll('details')) {
    const title = d.querySelector('summary')?.textContent ?? '';
    const n = seen.get(title) ?? 0;
    seen.set(title, n + 1);
    if (state.get(`${title}#${n}`)) d.open = true;
  }
}

/** Gives a result's charts a moment to draw, so the panel does not show them empty for a frame. */
function settle(): Promise<void> {
  const frame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  const wait = new Promise<void>((resolve) => window.setTimeout(resolve, SETTLE_MS));
  return Promise.race([frame().then(frame), wait]);
}
