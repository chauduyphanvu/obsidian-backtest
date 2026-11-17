import { parseSpec, type Defaults, type Diagnostic } from './dsl.ts';
import { lineKind, tokenizeBlock, type Token } from './highlight.ts';

export interface BlockDiagnostic {
  /** 0-based line within the block. */
  line: number;
  /** Columns in that line, half-open and inside it. */
  from: number;
  to: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface BlockAnalysis {
  /** Colour tokens per line, in ascending order and inside their line. */
  tokens: Token[][];
  diagnostics: BlockDiagnostic[];
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

/**
 * Turns a parser diagnostic into a range on a line of the block. A range that is empty or starts
 * outside its line, and a problem reported on a line with no code (line 1 holds the ones about the
 * block as a whole), falls back to the first line with code, or the first line with anything
 * on it, and covers its trimmed text.
 */
export function placeDiagnostic(lines: string[], d: Diagnostic, severity: BlockDiagnostic['severity']): BlockDiagnostic {
  const hasCode = (i: number) => i >= 0 && i < lines.length && lineKind(lines[i], false) !== 'blank';
  const own = d.line - 1;
  const onCode = hasCode(own);
  const firstCode = lines.findIndex((_, i) => hasCode(i));
  const line = onCode ? own : firstCode >= 0 ? firstCode : Math.max(0, lines.findIndex((l) => l.trim()));
  const text = lines[line] ?? '';
  const exact = onCode && d.from !== undefined && d.to !== undefined && d.from >= 0 && d.from < d.to && d.from < text.length;
  const from = exact ? d.from! : text.length - text.trimStart().length;
  const to = exact ? Math.min(d.to!, text.length) : text.trimEnd().length;
  return { line, from, to, severity, message: d.message };
}

/** Parses one block's lines and returns where to underline. Empty blocks give nothing. */
export function blockDiagnostics(lines: string[], defaults: Partial<Defaults> = {}): BlockDiagnostic[] {
  if (lines.every((l) => !l.trim())) return [];
  const { errors, warnings } = parseSpec(lines.join('\n'), { defaults });
  return [...errors.map((d) => placeDiagnostic(lines, d, 'error')), ...warnings.map((d) => placeDiagnostic(lines, d, 'warning'))].sort(
    (a, b) => a.line - b.line || a.from - b.from || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1),
  );
}

/** Everything the editor draws for one block: colours and underlines. */
export function analyzeBlock(lines: string[], defaults: Partial<Defaults> = {}): BlockAnalysis {
  const tokens = tokenizeBlock(lines).map((row, i) =>
    row.filter((t) => t.from >= 0 && t.from < t.to && t.to <= lines[i].length).sort((a, b) => a.from - b.from),
  );
  return { tokens, diagnostics: blockDiagnostics(lines, defaults) };
}
