import { extractBlocks, type Block } from './blocks.ts';
import { isParamValue, PARAM_LINE, RESERVED } from './dsl.ts';

/** The declared value at the start of what follows "=": a number and its optional "%", the way dsl.ts reads the first part of a parameter's value. */
const DECLARED = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(\s*%)?/;
/** The same comment rule the language uses. */
const COMMENT = /(^|\s)(#|\/\/)/;

/** A number written in plain digits: no floating-point tail, and never an exponent, which the language would not read. */
export function plainNumber(x: number): string {
  const r = Number(x.toPrecision(12));
  return r === 0 ? '0' : r.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

const same = (a: number, b: number) => Number(a.toPrecision(12)) === Number(b.toPrecision(12));

function rewriteLine(line: string, wanted: Map<string, number>): string {
  const comment = line.match(COMMENT);
  const code = comment ? line.slice(0, comment.index! + comment[1].length) : line;
  const text = code.trim();
  const m = text.match(PARAM_LINE);
  if (!m || RESERVED.has(m[1].toLowerCase())) return line;
  const value = wanted.get(m[1].toLowerCase());
  if (value === undefined || !Number.isFinite(value)) return line;
  const declared = m[2].match(DECLARED);
  if (!declared) return line;
  // A definition such as `half = 0.5 * close` may start with a number, but has no value of its own to set.
  if (!isParamValue(m[2]) && /^\s+\S/.test(m[2].slice(declared[0].length))) return line;
  // One "%" anywhere in the value makes the whole parameter a percentage, whichever number carries it.
  const percent = m[2].includes('%');
  if (same(Number(declared[1]) / (percent ? 100 : 1), value)) return line;
  const from = code.length - code.trimStart().length + text.length - m[2].length;
  return line.slice(0, from) + plainNumber(percent ? value * 100 : value) + (declared[2] ?? '') + line.slice(from + declared[0].length);
}

/**
 * The block's text with each named parameter's declared value replaced and nothing else changed: spacing, comments, the
 * range and the order of the lines stay. A percentage stays a percentage, and `values` hold fractions for those, as
 * `ParseOptions.overrides` does. Names the block does not declare are ignored, and so is a value that is already there.
 */
export function setParamValues(source: string, values: Record<string, number>): string {
  const wanted = new Map(Object.entries(values).map(([name, v]) => [name.toLowerCase(), v]));
  // Split on "\n" only, so a line keeps its "\r".
  return source.split('\n').map((line) => rewriteLine(line, wanted)).join('\n');
}

const normal = (text: string) => text.replace(/\r/g, '').trimEnd();

/** The block of `lang` whose opening fence is on `line` (0-based) of the note, when its text is still `source`. */
export function findBlock(note: string, line: number, source: string, lang = 'strategy'): { block: Block; index: number } | null {
  const blocks = extractBlocks(note, lang);
  const index = blocks.findIndex((b) => b.line === line);
  return index >= 0 && normal(blocks[index].source) === normal(source) ? { block: blocks[index], index } : null;
}

/**
 * The note with the values written into the block that opens on `line`, or null when that is no longer a block with the
 * text `source` (the note changed since the block was drawn). Only the lines that change are touched, so quote and callout
 * markers and line endings stay as they were.
 */
export function setParamValuesInNote(note: string, line: number, source: string, values: Record<string, number>): string | null {
  const found = findBlock(note, line, source);
  if (!found) return null;
  const was = found.block.source.split('\n');
  const now = setParamValues(found.block.source, values).split('\n');
  const lines = note.split('\n');
  for (let i = 0; i < was.length; i++) {
    if (now[i] === was[i]) continue;
    const raw = lines[line + 1 + i];
    const cr = raw.endsWith('\r') ? '\r' : '';
    const body = cr ? raw.slice(0, -1) : raw;
    if (!body.endsWith(was[i])) return null;
    lines[line + 1 + i] = body.slice(0, body.length - was[i].length) + now[i] + cr;
  }
  return lines.join('\n');
}

/** Callout and quote markers at the start of a line, every level of them. */
const QUOTES = /^(?:[ \t]*>[ \t]?)*/;

/**
 * The note with the whole text of the block that opens on `line` replaced by `text`, or null when that is no longer a
 * block with the text `source`. Each new line gets the callout or quote markers of the block's opening fence and the
 * note's line ending.
 */
export function replaceBlockInNote(note: string, line: number, source: string, text: string): string | null {
  const found = findBlock(note, line, source);
  // An empty block has no lines to tell its place by; a drawn result never comes from one.
  if (!found || found.block.source === '') return null;
  const lines = note.split('\n');
  const fence = lines[line];
  const cr = fence.endsWith('\r') ? '\r' : '';
  const prefix = fence.match(QUOTES)![0];
  const now = text.split(/\r?\n/).map((l) => prefix + l + cr);
  lines.splice(line + 1, found.block.source.split('\n').length, ...now);
  return lines.join('\n');
}

export const NOTE_CHANGED = 'The note has changed since this result was drawn, so nothing was written. Try again.';

/**
 * Changes the block that opens on `line` of a note with `change`, through `process`, which edits the note's text in place
 * (Obsidian's `vault.process`). Rejects with a message fit to show when nothing was written: the block has no known place,
 * or `change` found it no longer there with the text it was drawn from.
 */
export async function writeInNote(process: (edit: (note: string) => string) => Promise<unknown>, line: number | undefined, change: (note: string, line: number) => string | null): Promise<void> {
  if (line === undefined) throw new Error(NOTE_CHANGED);
  let written = false;
  await process((note) => {
    const next = change(note, line);
    written = next !== null;
    return next ?? note;
  });
  if (!written) throw new Error(NOTE_CHANGED);
}

/** Writes values into the block that opens on `line` of a note (see setParamValuesInNote). */
export function writeValuesInNote(
  process: (edit: (note: string) => string) => Promise<unknown>,
  line: number | undefined,
  source: string,
  values: Record<string, number>,
): Promise<void> {
  return writeInNote(process, line, (note, at) => setParamValuesInNote(note, at, source, values));
}

/** Replaces the whole text of the block that opens on `line` of a note (see replaceBlockInNote). */
export function writeBlockInNote(process: (edit: (note: string) => string) => Promise<unknown>, line: number | undefined, source: string, text: string): Promise<void> {
  return writeInNote(process, line, (note, at) => replaceBlockInNote(note, at, source, text));
}

/**
 * The note with lines of the block of `lang` that opens on `line` changed: `edits` maps a 0-based line of the block's text
 * to its new text, and `insert` puts a new line after the one given (-1 for before the first). Each line keeps what comes
 * before the block's text on it, a quote or callout's `>` markers, and its line ending; a new line takes those of the line
 * it follows, or of the first. Null when that is no longer a block with the text `source`.
 */
function editBlockLines(note: string, line: number, source: string, lang: string, edits: Map<number, string>, insert?: { after: number; text: string }): string | null {
  const found = findBlock(note, line, source, lang);
  if (!found) return null;
  const was = found.block.source.split('\n');
  const lines = note.split('\n');
  const around = (i: number): { before: string; cr: string } | null => {
    const raw = lines[line + 1 + i];
    const cr = raw.endsWith('\r') ? '\r' : '';
    const body = cr ? raw.slice(0, -1) : raw;
    return body.endsWith(was[i]) ? { before: body.slice(0, body.length - was[i].length), cr } : null;
  };
  for (const [i, text] of edits) {
    const at = around(i);
    if (!at) return null;
    lines[line + 1 + i] = at.before + text + at.cr;
  }
  if (insert) {
    const at = around(Math.max(insert.after, 0));
    if (!at) return null;
    lines.splice(line + 2 + insert.after, 0, at.before + insert.text + at.cr);
  }
  return lines.join('\n');
}

/** A weight at the end of a line naming a strategy, as compare.ts reads one. */
const WEIGHT_AT_END = /(?<=\s|\]\])[+-]?\d+(?:\.\d+)?(\s*%)\s*$/;

/** A line naming a strategy with its weight set to `percent`, written after the note, or put in place of the one it had. */
export function withWeight(text: string, percent: number): string {
  const trimmed = text.trimEnd();
  return WEIGHT_AT_END.test(trimmed) ? trimmed.replace(WEIGHT_AT_END, (_, gap: string) => `${plainNumber(percent)}${gap}`) : `${trimmed} ${plainNumber(percent)}%`;
}

/**
 * The note with weights written on the lines of a `compare` or `account` block that name its strategies: `weights` gives
 * each line (1-based, as CompareEntry.line counts) its whole percentage. Null when the block changed since it was drawn.
 */
export function setWeightsInNote(note: string, line: number, source: string, lang: string, weights: { line: number; percent: number }[]): string | null {
  const was = source.replace(/\r/g, '').split('\n');
  return editBlockLines(note, line, source, lang, new Map(weights.map((w) => [w.line - 1, withWeight(was[w.line - 1] ?? '', w.percent)])));
}

const SETTING_AT = /^(\s*)([A-Za-z][A-Za-z ]*?)\s*:/;

/**
 * The note with a setting of the block written as `key: value`: in place of the line that sets it, or else after the last
 * line that sets something, or else first. Null when the block changed since it was drawn.
 */
export function setSettingInNote(note: string, line: number, source: string, lang: string, key: string, value: string): string | null {
  const was = source.replace(/\r/g, '').split('\n');
  const name = (text: string) => text.match(SETTING_AT)?.[2].toLowerCase().replace(/\s+/g, ' ') ?? null;
  const at = was.findIndex((text) => name(text) === key.toLowerCase());
  if (at >= 0) return editBlockLines(note, line, source, lang, new Map([[at, `${was[at].match(SETTING_AT)![1]}${key}: ${value}`]]));
  const last = was.reduce((found, text, i) => (name(text) !== null && !text.trimStart().startsWith('[[') ? i : found), -1);
  return editBlockLines(note, line, source, lang, new Map(), { after: last, text: `${key}: ${value}` });
}
