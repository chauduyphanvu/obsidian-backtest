import { parseSpec, type Defaults, type Diagnostic } from './dsl.ts';
import { fixFor, tickerFix, type Fix } from './fixes.ts';
import { lineKind, tokenizeBlock, type Token } from './highlight.ts';
import { blockTickers, unknownTickerMessage, type SymbolLookup, type TickerRef } from './symbols.ts';

export interface BlockDiagnostic {
  /** 0-based line within the block. */
  line: number;
  /** Columns in that line, half-open and inside it. */
  from: number;
  to: number;
  severity: 'error' | 'warning';
  message: string;
  /** The parser's problem this was placed from, as the parser wrote it (1-based line). */
  origin?: Diagnostic;
  /** Set when the note is that the ticker's source does not know it. */
  ticker?: TickerRef;
}

export interface BlockAnalysis {
  /** Colour tokens per line, in ascending order and inside their line. */
  tokens: Token[][];
  diagnostics: BlockDiagnostic[];
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
  return { line, from, to, severity, message: d.message, origin: d };
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

/** The part of the lookup these functions read: what it already knows, never a request. */
export type KnownTickers = Pick<SymbolLookup, 'peek' | 'peekSearch'>;

/** A note for each of these tickers that the lookup knows its source does not have. Ones not yet asked about, and ones it was unsure about, give nothing. */
export function unknownTickers(refs: TickerRef[], lookup: KnownTickers): BlockDiagnostic[] {
  return refs
    .filter((ref) => lookup.peek(ref.ticker, ref.source) === 'unknown')
    .map((ref) => ({ line: ref.line, from: ref.from, to: ref.to, severity: 'warning' as const, message: unknownTickerMessage(ref.ticker, ref.source), ticker: ref }));
}

/**
 * The one-click correction for a problem in a block, or null. A parser error is corrected as `fixFor`
 * does; an unknown ticker by the nearest ticker of the same source that the lookup knows to exist,
 * the block's own tickers first and then what searching for it found.
 */
export function fixForDiagnostic(lines: string[], d: BlockDiagnostic, defaults: Partial<Defaults>, lookup: KnownTickers | null): Fix | null {
  if (d.origin && d.severity === 'error') return fixFor(lines, d.origin, defaults);
  if (!d.ticker || !lookup) return null;
  const t = d.ticker;
  const at = { line: d.line + 1, from: d.from, to: d.to };
  const own = blockTickers(lines, defaults)
    .filter((r) => r.source === t.source && r.ticker !== t.ticker && lookup.peek(r.ticker, r.source) === 'known')
    .map((r) => r.ticker);
  const found = (lookup.peekSearch(t.ticker, t.source) ?? []).filter((h) => h.source === t.source).map((h) => h.ticker);
  return tickerFix(lines, at, own, defaults) ?? tickerFix(lines, at, found, defaults);
}
