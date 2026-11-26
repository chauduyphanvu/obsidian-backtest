import { blockName, extractBlocks, fencedBlocks, type Block } from './blocks.ts';
import { functionArgs } from './docs.ts';
import { applyLiteralOverrides, extractLiteralSites, INDICATORS, isParamValue, LATER_WORDS, MAX_PERIOD, PARAM_LINE, parseSpec, RESERVED, type Defaults, type LiteralSite } from './dsl.ts';
import { applyFix, fixEdits, type Fix, type FixEdit } from './fixes.ts';
import { tidy } from './format.ts';
import { declaredDefinitions, declaredParams, lineKinds, NUMERIC_SETTINGS, settingKey, tokenizeBlock, type LineKind, type Token } from './highlight.ts';

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
  // A definition such as `half = 0.5*close` may start with a number, but has no value of its own to set.
  if (!m || RESERVED.has(m[1].toLowerCase()) || !isParamValue(m[2])) return line;
  const value = wanted.get(m[1].toLowerCase());
  if (value === undefined || !Number.isFinite(value)) return line;
  const declared = m[2].match(DECLARED);
  if (!declared) return line;
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

/**
 * Rewrites direct numeric literals (and any parameter declarations among them) into `source`, preserving formatting,
 * comments, and line count.
 */
export function setLiteralValues(source: string, sites: readonly LiteralSite[], values: Record<string, number>): string {
  const applied = applyLiteralOverrides(source, sites, values);
  return Object.keys(applied.paramOverrides).length > 0 ? setParamValues(applied.source, applied.paramOverrides) : applied.source;
}

/** Toggles a leading `~` mute marker on a 1-based line inside a strategy block. */
export function toggleMuteLine(source: string, line1Based: number): string {
  const lines = source.split('\n');
  const i = line1Based - 1;
  if (i < 0 || i >= lines.length) return source;
  const raw = lines[i];
  const cr = raw.endsWith('\r') ? '\r' : '';
  const body = cr ? raw.slice(0, -1) : raw;
  const m = body.match(/^(\s*)(.*)$/);
  if (!m || !m[2]) return source;
  const [, indent, rest] = m;
  lines[i] = rest.startsWith('~') ? `${indent}${rest.slice(1)}${cr}` : `${indent}~${rest}${cr}`;
  return lines.join('\n');
}

/** Removes all `~`-muted lines from a strategy block cleanly. */
export function removeMutedLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('~'))
    .join('\n');
}

/** Writes direct literal values into the block that opens on `line` of a note. */
export function writeLiteralValuesInNote(
  process: (edit: (note: string) => string) => Promise<unknown>,
  line: number | undefined,
  source: string,
  values: Record<string, number>,
): Promise<void> {
  const sites = extractLiteralSites(source);
  const next = setLiteralValues(source, sites, values);
  return writeBlockInNote(process, line, source, next);
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

/**
 * The note with the one strategy block whose text is `source` replaced by `text`, for a fix made from a list of every
 * block, which does not know where the block is. Null when no block, or more than one, has that text.
 */
export function fixBlockInNote(note: string, source: string, text: string): string | null {
  const found = extractBlocks(note).filter((b) => b.source === source);
  return found.length === 1 ? replaceBlockInNote(note, found[0].line, source, text) : null;
}

export const NOTE_CHANGED = 'The note changed after the plugin showed this result. The plugin did not write to the note. Do the step again.';

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
const WEIGHT_AT_END = /(\s|\]\])[+-]?\d+(?:\.\d+)?(\s*%)\s*$/;

/** A line naming a strategy with its weight set to `percent`, written after the note, or put in place of the one it had. */
export function withWeight(text: string, percent: number): string {
  const trimmed = text.trimEnd();
  return WEIGHT_AT_END.test(trimmed) ? trimmed.replace(WEIGHT_AT_END, (_, before: string, gap: string) => `${before}${plainNumber(percent)}${gap}`) : `${trimmed} ${plainNumber(percent)}%`;
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
  // A `for X:` line looks like a setting, and what follows it belongs to that ticker's group: only the lines above the
  // first one hold settings of the whole block.
  const groups = was.findIndex((text) => /^\s*for\b/i.test(text));
  const last = (groups < 0 ? was : was.slice(0, groups)).reduce((found, text, i) => (name(text) !== null && !text.trimStart().startsWith('[[') ? i : found), -1);
  return editBlockLines(note, line, source, lang, new Map(), { after: last, text: `${key}: ${value}` });
}

/** Characters a link `[[Note#Name]]` cannot hold in its name. */
const LINK_BREAKERS = /[#|[\]^]/;

/**
 * Why `name` cannot be the new name of the strategy called `current` (null for none), in a note whose other strategy
 * blocks have the names `others`; null when it can. Names are told apart in any capitals, as links and records tell them.
 */
export function nameProblem(name: string, current: string | null, others: readonly (string | null)[]): string | null {
  const wanted = name.trim();
  if (!wanted) return 'Write a name.';
  if (wanted === current) return 'The strategy has this name now. Write a different name.';
  if (LINK_BREAKERS.test(wanted)) return 'A name cannot contain #, |, [, ] or ^. These characters break the links to the strategy.';
  if (blockName(`name: ${wanted}`) !== wanted) return 'A name cannot contain // after a space. The plugin reads the text after it as a comment.';
  if (others.some((o) => o?.toLowerCase() === wanted.toLowerCase())) return `Another strategy in this note has the name "${wanted}". Write a different name.`;
  return null;
}

/** A link with a name after its `#`: the note, the name (`#` included, as the blocks read it), and an alias. */
const NAMED_LINK = /\[\[([^[\]|#\r\n]*)#([^[\]|\r\n]*)((?:\|[^[\]\r\n]*)?)\]\]/g;
/** A line of a compare or account block that names a strategy by its vault path, as compare.ts parseLine reads it, and its weight. */
const NAMED_PATH = /^(\s*)(.+?\.md)#(.*?)(\s[+-]?\d+(?:\.\d+)?\s*%)?\s*$/i;

/**
 * The note with every link to the strategy `from` of one note written to name `to` instead, and how many changed:
 * `[[Note#From]]` and `[[Note#From|alias]]` in its `compare`, `account` and `forward` blocks, a vault path
 * `Folder/Note.md#From` in its compare and account blocks, and with `everywhere` (a forward test's note, whose text names
 * its strategy too) links anywhere in it. `isTarget` tells whether a link's note, as written, is the strategy's note. The
 * name is matched in any capitals, as the blocks match it; the spaces around it, the alias, the weight and the `>` markers
 * of a callout stay.
 */
export function renameLinksInNote(note: string, isTarget: (link: string) => boolean, from: string, to: string, everywhere: boolean): { text: string; count: number } {
  const wanted = from.trim().toLowerCase();
  let count = 0;
  const swap = (name: string, link: string): string | null => {
    // A link with no note before its `#` is to a heading of its own note.
    if (name.trim().toLowerCase() !== wanted || !link.trim() || !isTarget(link.trim())) return null;
    count++;
    const lead = name.match(/^\s*/)![0];
    return lead + to + name.slice(lead.length).match(/\s*$/)![0];
  };
  const links = (text: string): string => text.replace(NAMED_LINK, (all, link: string, name: string, alias: string) => {
    const now = swap(name, link);
    return now === null ? all : `[[${link}#${now}${alias}]]`;
  });
  const listLine = (text: string): string => {
    if (text.trim().startsWith('[[')) return links(text);
    const m = text.match(NAMED_PATH);
    const now = m ? swap(m[3], m[2]) : null;
    return m && now !== null ? `${m[1]}${m[2]}#${now}${text.slice(m[1].length + m[2].length + 1 + m[3].length)}` : text;
  };

  const lines = note.split('\n');
  const done = new Set<number>();
  for (const [lang, change] of [['compare', listLine], ['account', listLine], ['forward', links]] as const) {
    for (const block of fencedBlocks(note, lang)) {
      if (block.source === '') continue;
      block.source.split('\n').forEach((was, i) => {
        const at = block.line + 1 + i;
        const cr = lines[at].endsWith('\r') ? '\r' : '';
        const body = cr ? lines[at].slice(0, -1) : lines[at];
        // Only the line's text past a callout's `>` markers is the block's.
        if (!body.endsWith(was)) return;
        lines[at] = body.slice(0, body.length - was.length) + change(was) + cr;
        done.add(at);
      });
    }
  }
  if (everywhere) for (let i = 0; i < lines.length; i++) if (!done.has(i)) lines[i] = links(lines[i]);
  return { text: count > 0 ? lines.join('\n') : note, count };
}

/** Most positions a slider offers, so the step stays easy to hit and to walk with the arrow keys. */
const MAX_POSITIONS = { whole: 120, percent: 100, other: 60 };

function decimals(x: number): number {
  const text = String(tidy(Math.abs(x)));
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(6, text.length - dot - 1);
}

/** 1, 2, 5, 10, 20, 50 and so on, from `from` up. */
function niceSteps(from: number): number[] {
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(from)); e <= 7; e++) {
    for (const m of [1, 2, 5]) if (m * 10 ** e >= from * (1 - 1e-9)) out.push(tidy(m * 10 ** e));
  }
  return out;
}

/**
 * A range around a value that has none: about half to double, on a step that keeps the grid on the value. A whole number
 * stays whole and at least 1, so it is always a length the parser accepts, and a `period` stays at most MAX_PERIOD; a
 * percentage stays above 0 and below 100%. `most` is the most values it may have; without it, as many as a slider can
 * offer. In the units the block is written in.
 */
export function around(v: number, percent: boolean, most?: number, period = false): { lo: number; hi: number; step: number } {
  const whole = !percent && Number.isInteger(v);
  let lo = 0;
  let hi = 10;
  if (v > 0) {
    lo = v / 2;
    hi = percent ? Math.max(v, Math.min(2 * v, 99)) : 2 * v;
    if (whole) {
      lo = Math.max(1, Math.ceil(lo));
      hi = Math.max(hi, v + 4);
      if (period) hi = Math.min(MAX_PERIOD, hi);
    }
  } else if (v < 0) {
    lo = 2 * v;
    hi = v / 2;
  }
  const unit = whole ? 1 : Math.min(0.1, 10 ** -decimals(v));
  const candidates = percent ? [unit, 1, 5, 10, 50].filter((c) => c >= unit * (1 - 1e-9)) : niceSteps(unit);
  const limit = most ?? (whole ? MAX_POSITIONS.whole : percent ? MAX_POSITIONS.percent : MAX_POSITIONS.other);
  const positions = (step: number) => Math.floor((hi - lo) / step + 1e-9) + 1;
  const step = candidates.find((c) => positions(c) <= limit) ?? candidates[candidates.length - 1];
  return { lo: tidy(v - Math.floor((v - lo) / step + 1e-9) * step), hi: tidy(v + Math.floor((hi - v) / step + 1e-9) * step), step };
}

/** Most values the range of a new parameter has, so that a sweep of two of them stays well inside what one sweep may run. */
const NEW_PARAM_VALUES = 16;

/** A number of a block that can become a parameter, and the change that makes it one. */
export interface NewParam {
  /** The number as the block writes it: "200", "8%". */
  number: string;
  name: string;
  /** The line that declares it: "sma_n = 200 in 100..400 step 20". */
  declaration: string;
  /** The number with the call or comparison it is in, as the block writes it: "sma(200)", "rsi(2) < 10". */
  context: string;
  /** How many places the name takes the number's place in. */
  places: number;
  /**
   * The change, labelled "Make 200 a parameter (2 places)": the name in place of the number, in every place, then the new
   * line. Columns are in the block as it is, as for any fix.
   */
  fix: Fix;
}

/** What is read once for a block, for each of its numbers. */
interface Reading {
  lines: string[];
  tokens: Token[][];
  kinds: LineKind[];
  defaults: Partial<Defaults>;
  /** The block's parameters, in lower case. */
  params: Set<string>;
  /** How many times each message of the block's errors comes, before any change; read when first asked for. */
  errors: () => Map<string, number>;
}

interface Call {
  /** Indexes of the function's token and of its two brackets. */
  fn: number;
  open: number;
  close: number;
}

const COMPARE = ['>', '<', '>=', '<=', '==', '!='];
/** Names for the number of a setting whose own name a parameter cannot take. */
const SETTING_NAMES: Record<string, string> = { hold: 'top_n', entries: 'max_entries' };

function errorCounts(source: string, defaults: Partial<Defaults>, overrides?: Record<string, number>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of parseSpec(source, { defaults, overrides }).errors) counts.set(e.message, (counts.get(e.message) ?? 0) + 1);
  return counts;
}

function reading(lines: string[], defaults: Partial<Defaults>): Reading {
  let errors: Map<string, number> | undefined;
  return {
    lines,
    tokens: tokenizeBlock(lines),
    kinds: lineKinds(lines),
    defaults,
    params: new Set(declaredParams(lines).map((p) => p.name.toLowerCase())),
    errors: () => (errors ??= errorCounts(lines.join('\n'), defaults)),
  };
}

/** The tokens of one line, with the questions asked of them. */
class Row {
  readonly line: string;
  readonly toks: Token[];

  constructor(line: string, toks: Token[]) {
    this.line = line;
    this.toks = toks;
  }

  text(k: number): string {
    const t = this.toks[k];
    return t ? this.line.slice(t.from, t.to) : '';
  }

  op(k: number, ...ops: string[]): boolean {
    return this.toks[k]?.kind === 'operator' && ops.includes(this.text(k));
  }

  word(k: number, ...words: string[]): boolean {
    return this.toks[k]?.kind === 'keyword' && words.includes(this.text(k).toLowerCase());
  }

  /** The bracket that matches the one at `k`, on this line; -1 when it is not on it. */
  matching(k: number): number {
    const pair: Record<string, string> = { '(': ')', '[': ']', ')': '(', ']': '[' };
    const open = this.text(k);
    const step = open === '(' || open === '[' ? 1 : -1;
    let depth = 0;
    for (let j = k; j >= 0 && j < this.toks.length; j += step) {
      if (this.op(j, open)) depth++;
      else if (this.op(j, pair[open]) && --depth === 0) return j;
    }
    return -1;
  }

  /** Where the value whose last token is `k` starts: a call with its brackets, a lag, a ticker after `of`. */
  startOf(k: number): number {
    let j = k;
    if (this.toks[j]?.kind === 'ticker' && this.word(j - 1, 'of')) j -= 2;
    while (this.op(j, ']') && this.matching(j) > 0) j = this.matching(j) - 1;
    if (this.op(j, ')') && this.matching(j) >= 0) {
      const open = this.matching(j);
      return this.toks[open - 1]?.kind === 'function' ? this.toks[open - 1].from : this.toks[open].from;
    }
    return this.toks[Math.max(0, j)].from;
  }

  /** Where the value whose first token is `k` ends; the end of the line's code when there is none. */
  endOf(k: number): number {
    if (k >= this.toks.length || this.toks[k].kind === 'comment') {
      let last = Math.min(k, this.toks.length) - 1;
      while (last > 0 && this.toks[last].kind === 'comment') last--;
      return this.toks[last].to;
    }
    let j = k;
    if (this.toks[j].kind === 'function' && this.op(j + 1, '(') && this.matching(j + 1) > 0) j = this.matching(j + 1);
    else if (this.op(j, '(') && this.matching(j) > 0) j = this.matching(j);
    while (this.op(j + 1, '[') && this.matching(j + 1) > 0) j = this.matching(j + 1);
    if (this.word(j + 1, 'of') && this.toks[j + 2]?.kind === 'ticker') j += 2;
    return this.toks[j].to;
  }

  /** The call whose brackets hold token `k`, on this line. */
  callAround(k: number): Call | null {
    let depth = 0;
    for (let j = k - 1; j >= 0; j--) {
      if (this.op(j, ')')) depth++;
      else if (this.op(j, '(') && depth-- === 0) {
        const close = this.matching(j);
        const fn = this.toks[j - 1];
        return close > k && fn && (fn.kind === 'function' || fn.kind === 'value') ? { fn: j - 1, open: j, close } : null;
      }
    }
    return null;
  }

  /** The arguments of a call, each as the indexes of its first and last token. */
  args(call: Call): [number, number][] {
    const out: [number, number][] = [];
    let depth = 0;
    let first = call.open + 1;
    for (let j = call.open + 1; j < call.close; j++) {
      if (this.op(j, '(', '[')) depth++;
      else if (this.op(j, ')', ']')) depth--;
      else if (depth === 0 && this.op(j, ',')) {
        out.push([first, j - 1]);
        first = j + 1;
      }
    }
    if (first < call.close) out.push([first, call.close - 1]);
    return out;
  }

  /** A call's text without its spaces, in lower case, so the same call written twice reads the same. */
  key(call: Call): string {
    return this.line.slice(this.toks[call.fn].from, this.toks[call.close].to).replace(/\s+/g, '').toLowerCase();
  }

  code(call: Call): string {
    return this.line.slice(this.toks[call.fn].from, this.toks[call.close].to);
  }
}

/**
 * The name a period gets from its function: `sma_n`, `macd_slow`, `bb_upper_width`; null for a number that is not one of a
 * function's numbers, such as an argument of max().
 */
function periodName(row: Row, call: Call, arg: number, params: Set<string>): string | null {
  const fn = row.text(call.fn).toLowerCase();
  const def = INDICATORS[fn];
  // `inverse volatility(60)` in `weighting` is a period with no entry of its own.
  if (!def) return row.toks[call.fn].kind === 'value' ? `${fn}_n` : null;
  const args = row.args(call);
  const [a, b] = args[0];
  const plain = a === b && (row.toks[a].kind === 'number' || params.has(row.text(a).toLowerCase()));
  // The parser reads a first value as the series when it is not a plain number, or when there is one value too many.
  const lead = def.lead !== undefined || (def.src !== null && (!plain || args.length > def.params.length)) ? 1 : 0;
  const name = functionArgs(fn)[arg - lead];
  return name === undefined ? null : `${fn}_${name}`;
}

/** What number `i` of a line does: the name that says so, the code to show it with, and the call it is a period of. */
function role(r: Reading, rowIndex: number, i: number): { name: string; context: string; period: { call: Call; arg: number } | null } {
  const row = new Row(r.lines[rowIndex], r.tokens[rowIndex]);
  const t = row.toks[i];
  const span = (from: number, to: number) => row.line.slice(from, to);
  const plainRole = (name: string, context: string) => ({ name, context, period: null });

  if (row.word(i - 1, 'for', 'within') && /^bars?$/i.test(row.text(i + 1))) return plainRole('n_bars', span(row.toks[i - 1].from, row.toks[i + 1].to));
  if (row.op(i - 1, '[') && row.op(i + 1, ']')) return plainRole('lag', span(row.startOf(i - 2), row.toks[i + 1].to));
  const call = row.callAround(i);
  if (call) {
    const arg = row.args(call).findIndex(([a, b]) => a === i && b === i);
    const name = arg < 0 ? null : periodName(row, call, arg, r.params);
    if (name) return { name, context: row.code(call), period: { call, arg } };
  }
  // A setting's own number; the score after `by` in `hold` reads like a rule.
  const key = r.kinds[rowIndex] === 'setting' ? settingKey(row.line) : null;
  if (key && !row.toks.some((x, k) => x.from < t.from && row.word(k, 'by'))) {
    const name = key === 'risk per trade' && row.toks[i + 1]?.kind === 'function' ? 'risk_distance' : (SETTING_NAMES[key] ?? key.replace(/ /g, '_'));
    return plainRole(name, span(row.line.search(/\S/), row.endOf(row.toks.length)));
  }
  // A minus sign in front belongs to the number.
  let p = i - 1;
  if (row.op(p, '-') && (p === 0 || (row.toks[p - 1].kind === 'operator' && !row.op(p - 1, ')', ']')) || row.toks[p - 1].kind === 'keyword')) p--;
  const from = row.toks[p + 1].from;
  if (row.op(p, '*', '/') || (p === i - 1 && row.op(p, '+', '-'))) return plainRole(row.op(p, '*', '/') ? 'factor' : 'offset', span(row.startOf(p - 1), t.to));
  if (row.op(i + 1, '*', '/', '+', '-')) return plainRole(row.op(i + 1, '*', '/') ? 'factor' : 'offset', span(from, row.endOf(i + 2)));
  let c = row.word(p, 'and') && row.word(p - 2, 'between') ? p - 2 : p;
  if (row.op(c, ...COMPARE) || row.word(c, 'above', 'below', 'between')) {
    if (row.word(c, 'above', 'below') && row.word(c - 1, 'crosses', 'is')) c--;
    return plainRole('level', span(c > 0 ? row.startOf(c - 1) : row.toks[c].from, t.to));
  }
  c = i + 1;
  if (row.op(c, ...COMPARE) || row.word(c, 'above', 'below', 'crosses', 'is')) {
    if (row.word(c, 'crosses', 'is') && row.word(c + 1, 'above', 'below')) c++;
    return plainRole('level', span(from, row.endOf(c + 1)));
  }
  return plainRole('value', call ? row.code(call) : span(from, t.to));
}

/** A name for a new parameter that the block does not use and the language does not keep for itself: `level`, then `level_2`. */
function freeName(lines: string[], base: string): string {
  const taken = new Set([...declaredParams(lines), ...declaredDefinitions(lines)].map((p) => p.name.toLowerCase()));
  const free = (name: string) => !taken.has(name) && !RESERVED.has(name) && !LATER_WORDS.has(name);
  if (free(base)) return base;
  let k = 2;
  while (!free(`${base}_${k}`)) k++;
  return `${base}_${k}`;
}

/** Whether the numbers of a line can become parameters: a rule's, a definition's, or a setting's that takes a parameter. */
function holdsNumbers(r: Reading, rowIndex: number): boolean {
  const kind = r.kinds[rowIndex];
  if (kind === 'rule' || kind === 'continuation' || kind === 'define') return true;
  const key = kind === 'setting' ? settingKey(r.lines[rowIndex]) : null;
  return key !== null && NUMERIC_SETTINGS.includes(key);
}

/** The number at argument `arg` of every call written as `key`, in the lines whose numbers can become parameters. */
function sameCalls(r: Reading, key: string, arg: number): { line: number; from: number; to: number }[] {
  const out: { line: number; from: number; to: number }[] = [];
  r.tokens.forEach((toks, rowIndex) => {
    if (!holdsNumbers(r, rowIndex)) return;
    const row = new Row(r.lines[rowIndex], toks);
    toks.forEach((t, k) => {
      if ((t.kind !== 'function' && t.kind !== 'value') || !row.op(k + 1, '(')) return;
      const call = { fn: k, open: k + 1, close: row.matching(k + 1) };
      if (call.close < 0 || row.key(call) !== key) return;
      const [a, b] = row.args(call)[arg] ?? [-1, -2];
      if (a === b && toks[a].kind === 'number') out.push({ line: rowIndex + 1, from: toks[a].from, to: toks[a].to });
    });
  });
  return out;
}

/** Where the new line goes: after the last parameter, else after the settings above the first rule, else above that rule. */
function declarationEdit(r: Reading, text: string): FixEdit {
  const width = (k: number) => r.lines[k].replace(/\r$/, '').length;
  const at = (k: number, insert: string): FixEdit => ({ line: k + 1, from: width(k), to: width(k), insert });
  const last = r.kinds.lastIndexOf('param');
  if (last >= 0) return at(last, `\n${r.lines[last].match(/^\s*/)![0]}${text}`);
  let body = r.kinds.findIndex((k) => k === 'rule' || k === 'for' || k === 'define');
  if (body < 0) body = r.lines.length;
  const setting = r.kinds.slice(0, body).lastIndexOf('setting');
  // Between blank lines, as the starter strategies lay out their parameters.
  if (setting >= 0) return at(setting, `\n\n${text}${setting + 1 < r.lines.length && r.kinds[setting + 1] !== 'blank' ? '\n' : ''}`);
  return body < r.lines.length ? { line: body + 1, from: 0, to: 0, insert: `${text}\n\n` } : at(r.lines.length - 1, `\n${text}`);
}

function fromNumber(r: Reading, rowIndex: number, col: number): NewParam | null {
  if (!holdsNumbers(r, rowIndex)) return null;
  const toks = r.tokens[rowIndex];
  const i = toks.findIndex((t) => t.from <= col && col < t.to);
  if (i < 0 || toks[i].kind !== 'number') return null;
  const written = r.lines[rowIndex].slice(toks[i].from, toks[i].to);
  const percent = written.includes('%');
  const value = Number(written.replace('%', '').trim());
  const found = role(r, rowIndex, i);
  const name = freeName(r.lines, found.name);
  const places = found.period
    ? sameCalls(r, new Row(r.lines[rowIndex], toks).key(found.period.call), found.period.arg).map((e) => ({ ...e, insert: name }))
    : [{ line: rowIndex + 1, from: toks[i].from, to: toks[i].to, insert: name }];
  if (places.length === 0) return null;
  // The number under the cursor first, so the editor marks it as the place of the change.
  places.sort((a, b) => Number(b.line === rowIndex + 1 && b.from === toks[i].from) - Number(a.line === rowIndex + 1 && a.from === toks[i].from));
  const number = plainNumber(value) + (percent ? '%' : '');
  const unit = percent ? '%' : '';
  const declare = (lo: number, hi: number, step: number) => `${name} = ${number} in ${plainNumber(lo)}${unit}..${plainNumber(hi)}${unit} step ${plainNumber(step)}${unit}`;
  const build = (declaration: string): Fix => ({
    ...places[0],
    label: `Make ${number} a parameter${places.length > 1 ? ` (${places.length} places)` : ''}`,
    hint: `Add ${declaration}, and write ${name} in place of ${number}.`,
    also: [...places.slice(1), declarationEdit(r, declaration)],
  });
  const scale = around(value, percent, NEW_PARAM_VALUES, found.period !== null);
  const source = applyFix(r.lines, build(declare(scale.lo, scale.hi, scale.step))).join('\n');
  const reads = (overrides?: Record<string, number>) => [...errorCounts(source, r.defaults, overrides)].every(([m, n]) => n <= (r.errors().get(m) ?? 0));
  if (!reads()) return null;
  // Each end of the range moves in, a step at a time, to a value the block reads, as a slider's range does.
  const readsAt = (x: number) => reads({ [name]: percent ? tidy(x / 100) : x });
  const near = (x: number) => Math.abs(x - value) < scale.step / 2;
  let { lo, hi } = scale;
  while (!near(hi) && !readsAt(hi)) hi = tidy(hi - scale.step);
  while (!near(lo) && !readsAt(lo)) lo = tidy(lo + scale.step);
  const declaration = declare(lo, hi, scale.step);
  return { number, name, declaration, context: found.context, places: places.length, fix: build(declaration) };
}

/**
 * The change that makes the number at column `col` of line `row` (both 0-based) a parameter with a range: a number of a
 * rule, a definition, or a setting that takes a parameter. Its name says what the number does there (`sma_n` for the
 * period of sma, `level` for a value a rule compares with, `stop_loss` for that setting), and is one the block does not
 * use yet. The same call written in other places (sma(200) in both rules) changes with it; an equal number that does
 * something else does not. The range is the one a slider gives a value with none, in at most 16 values, cut to values the
 * block reads. Null when there is no such number there, or when the changed block would have a problem it did not have.
 */
export function paramFromNumber(lines: string[], row: number, col: number, defaults: Partial<Defaults> = {}): NewParam | null {
  return fromNumber(reading(lines, defaults), row, col);
}

/** Each number of a block's rules and definitions that can become a parameter, each change once: sma(200) in two rules is one. */
export function ruleNumbers(lines: string[], defaults: Partial<Defaults> = {}): NewParam[] {
  const r = reading(lines, defaults);
  const out: NewParam[] = [];
  const seen = new Set<string>();
  r.kinds.forEach((kind, rowIndex) => {
    if (kind !== 'rule' && kind !== 'continuation' && kind !== 'define') return;
    for (const t of r.tokens[rowIndex]) {
      const found = t.kind === 'number' ? fromNumber(r, rowIndex, t.from) : null;
      if (!found) continue;
      const key = fixEdits(found.fix)
        .slice(0, -1)
        .map((e) => `${e.line}:${e.from}`)
        .sort()
        .join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(found);
    }
  });
  return out;
}
