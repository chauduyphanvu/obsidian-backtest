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

/** A block's `name:` line as written, minus its comment; null when it has none. */
export function blockName(text: string): string | null {
  for (const line of text.split('\n')) {
    const m = line.replace(COMMENT, '').match(/^\s*name\s*:\s*(.+?)\s*$/i);
    if (m) return m[1];
  }
  return null;
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

/**
 * The fenced code blocks of one language in a note, in order. Fences are read as the editor reads them: a fence
 * closes only on a line of fence characters at least as long as the one that opened it, so an example inside a
 * longer fence of another language is not a block. A block in a callout or quote has one `>` level taken off each
 * of its lines.
 */
export function extractBlocks(markdown: string, lang = 'strategy'): Block[] {
  const out: Block[] = [];
  const lines = markdown.split(/\r?\n/);
  let open: { fence: string; levels: number; wanted: boolean; line: number; body: string[] } | null = null;
  const finish = () => {
    if (open?.wanted) {
      const source = open.body.join('\n');
      out.push({ name: nameOf(source), source, line: open.line });
    }
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
      finish();
      i--;
    } else if (closesFence(text, open.fence)) {
      finish();
    } else {
      open.body.push(text);
    }
  }
  finish();
  return out;
}
