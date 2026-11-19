import { blockName, findBlocks, type BlockSpan } from './blocks.ts';
import type { Spec } from './dsl.ts';
import { lookbackBars } from './runner.ts';

/** How long to wait after a text change before running, in ms: when every price is already saved, and when a download may be needed. */
export const PAUSE_READY = 500;
export const PAUSE_DOWNLOAD = 1500;
/** Moving to another block or note is not typing, so there is nothing to wait out beyond a quick pass over blocks. */
export const PAUSE_SWITCH = 150;

/** What the panel says when it has no block to show. Under the text for a note with no block is the button for a new strategy note. */
export const EMPTY_TEXT = {
  'no-note': 'Open a note to see the result of its strategy block here. The result updates as you type.',
  'no-block': 'This note has no strategy block. Type a block in the note. The result shows here while you type.',
};

/** The strategy block the panel should show. `first` and `last` are 0-based lines of its content, as `findBlocks` reports them. */
export interface Choice {
  /** Position among the note's strategy blocks. */
  index: number;
  count: number;
  first: number;
  last: number;
  text: string;
  /** The block's `name:` setting. */
  name: string | null;
}

/** What the panel's header calls a block. */
export function blockLabel(c: Pick<Choice, 'name' | 'index' | 'count'>): string {
  return c.name ?? (c.count > 1 ? `Strategy ${c.index + 1} of ${c.count}` : 'Strategy');
}

/**
 * Which block to show for a note. The cursor counts as inside a block from its opening fence to its closing fence. Outside every
 * block, the block shown last from this note stays (by position) if the note still has that many blocks; otherwise the first one.
 * A block whose closing fence has not been typed yet runs to the end of the note, as the note itself reads it. Blocks inside
 * callouts and quotes are not seen, because `findBlocks` does not see them. `cursor` is null when there is no cursor to follow.
 */
export function chooseBlock(lines: readonly string[], cursor: number | null, previous: number | null): Choice | null {
  const spans = findBlocks(lines);
  if (spans.length === 0) return null;
  let index = cursor === null ? -1 : spans.findIndex((s) => cursor >= s.first - 1 && cursor <= s.last + 1);
  if (index < 0) index = previous !== null && previous >= 0 && previous < spans.length ? previous : 0;
  const { first, last } = spans[index];
  const text = lines.slice(first, last + 1).join('\n');
  return { index, count: spans.length, first, last, text, name: blockName(text) };
}

/**
 * The text of a note as its view holds it: in source mode the editor's, which is ahead of the file while typing; in
 * reading mode the view's data, since the editor there is not updated when the file changes from outside it.
 */
export function viewText(view: { getMode(): string; data: string; editor: { getValue(): string } }): string {
  return view.getMode() === 'source' ? view.editor.getValue() : view.data;
}

/** Where a block with this text is now: the one at `index` if it still has the text, else the nearest block that has it. */
export function locateBlock(lines: readonly string[], text: string, index: number): BlockSpan | null {
  let best: BlockSpan | null = null;
  let bestAway = Infinity;
  findBlocks(lines).forEach((span, i) => {
    if (lines.slice(span.first, span.last + 1).join('\n') !== text) return;
    const away = Math.abs(i - index);
    if (away < bestAway) {
      best = span;
      bestAway = away;
    }
  });
  return best;
}

/** What the panel is told about a block: which note, which position in it, and its text. */
export interface Shown {
  note: string;
  index: number;
  text: string;
}

export type Change =
  /** Nothing to do. */
  | 'none'
  /** The block is back to what is drawn, so work waiting for another version is dropped. */
  | 'cancel'
  /** The text of the block that is on its way to the panel changed: the user is typing. */
  | 'edit'
  /** Another block or another note. */
  | 'switch';

/**
 * What a new selection asks of the panel. `drawn` is what the panel shows, `pending` what is waiting or running. Work on the
 * same text is never started twice. Position alone does not count as a change: two blocks with the same text give the same result,
 * and the header is relabelled without a run.
 */
export function changeKind(drawn: Shown | null, pending: Shown | null, selected: Shown): Change {
  const same = (a: Shown | null) => a !== null && a.note === selected.note && a.text === selected.text;
  if (same(pending)) return 'none';
  if (same(drawn)) return pending ? 'cancel' : 'none';
  const base = pending ?? drawn;
  return base && base.note === selected.note && base.index === selected.index ? 'edit' : 'switch';
}

/** How long to wait, in ms, before running a change. Text with problems makes no request, so it only waits out the typing. */
export function waitFor(change: 'edit' | 'switch', pace: { errors: boolean; pricesReady: boolean }): number {
  if (change === 'switch') return PAUSE_SWITCH;
  return pace.errors || pace.pricesReady ? PAUSE_READY : PAUSE_DOWNLOAD;
}

/**
 * The panel's draws, one at a time. Starting a draw ends the one before it, so a burst of edits leaves one run going and
 * not a queue of them, and `stop` ends the one going, as when the panel closes. A draw that has finished is not touched
 * (see `drawHeld`).
 */
export class Latest {
  private current: AbortController | null = null;

  start(): AbortSignal {
    this.current?.abort();
    this.current = new AbortController();
    return this.current.signal;
  }

  stop(): void {
    this.current?.abort();
    this.current = null;
  }
}

/**
 * Draws with `draw`, which holds things (a run, the prices a worker keeps) until `release` is called. They are let go at
 * once when the draw fails or when `signal` aborts before it has finished. Once it has finished only the returned `release`
 * lets them go, since by then the result is on screen. `release` may be called more than once.
 */
export async function drawHeld(draw: () => Promise<void>, release: () => void, signal: AbortSignal): Promise<() => void> {
  signal.addEventListener('abort', release, { once: true });
  if (signal.aborted) release();
  try {
    await draw();
  } catch (e) {
    signal.removeEventListener('abort', release);
    release();
    throw e;
  }
  signal.removeEventListener('abort', release);
  return release;
}

/**
 * What loading a block's prices depends on: its tickers and where they come from, the interval, the dates, the smaller bars
 * and how far back its rules read. Two texts with the same answer need the same saved files, whatever their rules say.
 */
export function loadNeeds(spec: Spec): string {
  const refs = [...spec.universe, ...spec.extras, ...(spec.benchmark ? [spec.benchmark] : []), ...(spec.cash.k === 'ticker' ? [spec.cash.ref] : [])];
  return JSON.stringify([spec.interval, spec.from, spec.to, spec.magnify, lookbackBars(spec), refs.map((r) => `${r.source}:${r.id}`).sort()]);
}

/** Answers to "is every price saved and fresh?", kept per `loadNeeds` until they could change, so a pause in typing costs no file reading. */
export class ReadyMemo {
  private known = new Map<string, { ready: boolean; until: number }>();
  private now: () => number;
  private most: number;
  /** Counts `changed`, so an answer worked out before a change is not kept after it. */
  private turns = 0;

  constructor(now: () => number = Date.now, most = 100) {
    this.now = now;
    this.most = most;
  }

  /** The answer, or undefined when there is none or it has run out. */
  get(needs: string): boolean | undefined {
    const hit = this.known.get(needs);
    if (!hit) return undefined;
    if (this.now() >= hit.until) {
      this.known.delete(needs);
      return undefined;
    }
    return hit.ready;
  }

  /** Taken before working an answer out, and given to `set` with it. */
  turn(): number {
    return this.turns;
  }

  /**
   * `until` is when a yes stops being true: when the oldest saved file stops being fresh. An answer from a `turn` that a
   * change has since ended is dropped: a file written while it was worked out may have changed it.
   */
  set(needs: string, ready: boolean, until: number, turn = this.turns): void {
    if (turn !== this.turns) return;
    this.known.delete(needs);
    this.known.set(needs, { ready, until });
    if (this.known.size > this.most) this.known.delete(this.known.keys().next().value!);
  }

  /** A price file was written or removed, or the settings that decide freshness changed. */
  changed(): void {
    this.turns++;
    this.known.clear();
  }
}
