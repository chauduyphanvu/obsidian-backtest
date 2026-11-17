import { findBlocks, type BlockSpan } from './diagnostics.ts';

/** How long to wait after a text change before running, in ms: when every price is already saved, and when a download may be needed. */
export const PAUSE_READY = 500;
export const PAUSE_DOWNLOAD = 1500;
/** Moving to another block or note is not typing, so there is nothing to wait out beyond a quick pass over blocks. */
export const PAUSE_SWITCH = 150;

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

// The same comment rule the language uses.
const COMMENT = /(^|\s)(#|\/\/).*$/;

export function blockName(text: string): string | null {
  for (const line of text.split('\n')) {
    const m = line.replace(COMMENT, '').match(/^\s*name\s*:\s*(.+?)\s*$/i);
    if (m) return m[1];
  }
  return null;
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
