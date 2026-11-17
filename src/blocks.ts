import { closesFence, fenceOf } from './diagnostics.ts';
import { parseSpec } from './dsl.ts';

export interface Block {
  /** The block's `name:` setting, when it has one. */
  name: string | null;
  /** Text between the fences, without the `>` markers of a callout or quote it sits in. */
  source: string;
  /** 0-based line of the opening fence in the note. */
  line: number;
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

/** The name the parser reads; when the block has other problems, the `name:` line as written, minus its comment. */
function nameOf(source: string): string | null {
  try {
    const { spec } = parseSpec(source);
    if (spec) return spec.name;
  } catch {
    // Fall through to reading the line.
  }
  for (const line of source.split('\n')) {
    const m = line.replace(COMMENT, '').match(/^\s*name\s*:\s*(.+?)\s*$/i);
    if (m) return m[1];
  }
  return null;
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
