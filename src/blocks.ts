import { parseSpec } from './dsl.ts';

export interface Block {
  /** The block's `name:` setting, when it has one. */
  name: string | null;
  /** Text between the fences, without the `>` markers of a callout or quote it sits in. */
  source: string;
  /** 0-based line of the opening fence in the note. */
  line: number;
}

/** A line that opens or closes a fenced code block: the fence, and what follows it. */
export function fenceOf(line: string): { fence: string; info: string } | null {
  const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  return m ? { fence: m[1], info: m[2].trim() } : null;
}

/** Whether a line closes a block opened with `fence`: only fence characters, at least as many. */
export function closesFence(line: string, fence: string): boolean {
  const m = line.match(/^\s*(`{3,}|~{3,})\s*$/);
  return !!m && m[1][0] === fence[0] && m[1].length >= fence.length;
}

/** Lines of a strategy block in a note: 0-based indexes of its first and last content line (`last` is below `first` for an empty block). */
export interface BlockSpan {
  first: number;
  last: number;
}

/**
 * The strategy blocks in a note, found from the top because a fence can only be read in context.
 * Lines after `upTo` are read only to finish a block that is still open there. A fence that is
 * never closed runs to the end, as in the note itself.
 */
export function findBlocks(lines: Iterable<string>, upTo = Infinity): BlockSpan[] {
  const out: BlockSpan[] = [];
  let fence: string | null = null;
  let strategy = false;
  let start = 0;
  let i = 0;
  for (const line of lines) {
    if (fence === null) {
      if (i > upTo) return out;
      const open = fenceOf(line);
      if (open) {
        fence = open.fence;
        strategy = open.info === 'strategy';
        start = i + 1;
      }
    } else if (closesFence(line, fence)) {
      if (strategy) out.push({ first: start, last: i - 1 });
      fence = null;
    }
    i++;
  }
  if (fence !== null && strategy) out.push({ first: start, last: i - 1 });
  return out;
}

const QUOTE_MARKER = /^[ \t]*>[ \t]?/;
// The same comment rule the language uses.
const COMMENT = /(^|\s)(#|\/\/).*$/;

/** Takes off up to `max` leading `>` markers; `levels` says how many there were. */
function unquote(line: string, max = Infinity): { text: string; levels: number } {
  let text = line;
  let levels = 0;
  while (levels < max) {
    const m = text.match(QUOTE_MARKER);
    if (!m) break;
    text = text.slice(m[0].length);
    levels++;
  }
  return { text, levels };
}

const NAME_LINE = /^\s*name\s*:\s*(.+?)\s*$/i;

/** A block's `name:` line as written, minus its comment; null when it has none. */
export function blockName(text: string): string | null {
  for (const line of text.split('\n')) {
    const m = line.replace(COMMENT, '').match(NAME_LINE);
    if (m) return m[1];
  }
  return null;
}

/** The text without the `name:` line that blockName reads. */
export function withoutName(text: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => NAME_LINE.test(line.replace(COMMENT, '')));
  return at < 0 ? text : [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n');
}

/** The name the parser reads; when the block has other problems, the `name:` line as written, minus its comment. */
function nameOf(source: string): string | null {
  try {
    const { spec } = parseSpec(source);
    if (spec) return spec.name;
  } catch {
    // Fall through to reading the line.
  }
  return blockName(source);
}

/** A block as `fencedBlocks` finds it: its text, its opening fence's line, and its last line in the note. */
export interface Fenced {
  source: string;
  line: number;
  /** 0-based line of the closing fence, or of the block's last line when no fence closes it. */
  end: number;
}

/**
 * The fenced code blocks of one language in a note, in order. Fences are read as the editor reads them: a fence
 * closes only on a line of fence characters at least as long as the one that opened it, so an example inside a
 * longer fence of another language is not a block. A block in a callout or quote has one `>` level taken off each
 * of its lines.
 */
export function fencedBlocks(markdown: string, lang: string): Fenced[] {
  const out: Fenced[] = [];
  const lines = markdown.split(/\r?\n/);
  let open: { fence: string; levels: number; wanted: boolean; line: number; body: string[] } | null = null;
  const finish = (end: number) => {
    if (open?.wanted) out.push({ source: open.body.join('\n'), line: open.line, end });
    open = null;
  };

  for (let i = 0; i < lines.length; i++) {
    if (open === null) {
      const { text, levels } = unquote(lines[i]);
      const f = fenceOf(text);
      if (f) open = { fence: f.fence, levels, wanted: f.info === lang, line: i, body: [] };
      continue;
    }
    const { text, levels } = unquote(lines[i], open.levels);
    if (levels < open.levels) {
      // The quote ended without closing the fence; this line belongs to whatever comes next.
      finish(i - 1);
      i--;
    } else if (closesFence(text, open.fence)) {
      finish(i);
    } else {
      open.body.push(text);
    }
  }
  finish(lines.length - 1);
  return out;
}

/** The fenced code blocks of one language in a note, in order, with their names (see `fencedBlocks`). */
export function extractBlocks(markdown: string, lang = 'strategy'): Block[] {
  return fencedBlocks(markdown, lang).map(({ source, line }) => ({ name: nameOf(source), source, line }));
}

/**
 * The strategy block the cursor on `line` (0-based) is in, from its opening fence to its closing fence, with its place
 * among the note's strategy blocks; null when the cursor is in none. Only that block's name is read.
 */
export function blockAt(markdown: string, line: number): { block: Block; index: number } | null {
  const blocks = fencedBlocks(markdown, 'strategy');
  const index = blocks.findIndex((b) => line >= b.line && line <= b.end);
  if (index < 0) return null;
  const { source, line: at } = blocks[index];
  return { block: { name: nameOf(source), source, line: at }, index };
}

/** Whether a note has a strategy block, without reading any block's settings. */
export const hasStrategyBlock = (markdown: string): boolean => markdown.includes('strategy') && fencedBlocks(markdown, 'strategy').length > 0;

/**
 * The block of `lang` that a list or a link names, with its place among the note's blocks of that language: the one that
 * opens on `line` while it is still that block (a block with no name goes by its note's name in a list), else the one
 * called `name` in any capitals. Null when the note has neither.
 */
export function targetBlock(markdown: string, name: string | null, line: number | null, lang = 'strategy'): { block: Block; index: number } | null {
  const blocks = extractBlocks(markdown, lang);
  const called = (b: Block) => name !== null && b.name?.toLowerCase() === name.toLowerCase();
  let index = blocks.findIndex((b) => b.line === line && (b.name === null || called(b)));
  if (index < 0) index = blocks.findIndex(called);
  return index < 0 ? null : { block: blocks[index], index };
}
