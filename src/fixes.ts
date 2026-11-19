import { FUNCTIONS, tickers } from './complete.ts';
import { CALENDAR, NUM, POSITION, SERIES, SETTINGS, parseSpec, type Defaults, type Diagnostic } from './dsl.ts';
import { declaredDefinitions, declaredParams, NUMERIC_SETTINGS, RULE_HEADS, settingKey, tokenizeBlock } from './highlight.ts';
import { shortOf } from './docs.ts';
import { SOURCE_PREFIX } from './types.ts';

/**
 * One change to a block's text. Columns are in line `line` (1-based, as in a parser Diagnostic). `to` can go past the end of
 * the line, with one column for each line break, to remove whole lines.
 */
export interface FixEdit {
  line: number;
  from: number;
  to: number;
  insert: string;
}

/** A change to a block's text, and how to offer it. */
export interface Fix extends FixEdit {
  /** For the button: "Change to sma". */
  label: string;
  /** For places that can only show text: "Possible correction: sma."; empty when the problem's message already says what the fix does. */
  hint: string;
  /** Further changes that go with this one, so the block stays consistent. Columns are in the block as it is before any change. */
  also?: FixEdit[];
}

/** Every change a fix makes, the first one first. */
export function fixEdits(f: Fix): FixEdit[] {
  return [{ line: f.line, from: f.from, to: f.to, insert: f.insert }, ...(f.also ?? [])];
}

/**
 * The changes of a fix as positions in a note, all in the note as it is before any of them. `lineStart` gives where a block's
 * line (1-based) starts in the note, or null when the note has no such line; then nothing is offered.
 */
export function fixChanges(f: Fix, lineStart: (line: number) => number | null): { from: number; to: number; insert: string }[] | null {
  const out: { from: number; to: number; insert: string }[] = [];
  for (const e of fixEdits(f)) {
    const start = lineStart(e.line);
    if (start === null) return null;
    out.push({ from: start + e.from, to: start + e.to, insert: e.insert });
  }
  return out;
}

/** How many edits apart a typed word may be from a candidate, by the length of the typed word. */
function allowance(length: number): number {
  return length <= 2 ? 0 : length <= 5 ? 1 : length <= 9 ? 2 : 3;
}

/** Edit distance where swapping two neighbouring letters is one step. Case does not count. */
export function editDistance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[x.length][y.length];
}

/** Smaller sorts first: distance, then a different first letter, then a shorter shared start. */
function closeness(word: string, candidate: string): number[] {
  const w = word.toLowerCase();
  const c = candidate.toLowerCase();
  let shared = 0;
  while (shared < w.length && shared < c.length && w[shared] === c[shared]) shared++;
  return [editDistance(w, c), w[0] === c[0] ? 0 : 1, -shared];
}

const compare = (a: number[], b: number[]) => a.reduce((out, x, i) => out || x - b[i], 0);

/** Candidates within reach of a typed word, nearest first. A word that is already a candidate has no typo. `reach` is how many edits away one may be. */
function ranked(word: string, candidates: readonly string[], reach = allowance(word.length)): { value: string; key: number[] }[] {
  const seen = new Set<string>();
  const out: { value: string; key: number[] }[] = [];
  for (const value of candidates) {
    if (seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    const key = closeness(word, value);
    if (key[0] >= 1 && key[0] <= reach) out.push({ value, key });
  }
  return out.sort((a, b) => compare(a.key, b.key));
}

/** The candidate nearest to a typed word, or null when none is near enough or two are equally near. */
export function closest(word: string, candidates: readonly string[], reach?: number): string | null {
  const [best, next] = ranked(word, candidates, reach);
  return best && (!next || compare(best.key, next.key) !== 0) ? best.value : null;
}

interface Edit extends FixEdit {
  /** What to call the new text in a label, when it carries spaces for the neighbours. */
  shown?: string;
  /** Other places the same change is made. */
  also?: FixEdit[];
}

interface Context {
  lines: string[];
  d: Diagnostic;
  defaults: Partial<Defaults>;
  /** The block's problems before the edit. */
  errors: Diagnostic[];
  /**
   * Any problem the block did not have before, anywhere in it, counts against the edit; otherwise only one on the
   * edited line that touches the new text does. `problems` are the block's problems and notes before the edit.
   */
  strict?: { problems: Diagnostic[] };
}

const textOf = (lines: string[], line: number, from: number, to: number): string => lines[line - 1]?.slice(from, to) ?? '';

function applied(lines: string[], e: Edit): string[] {
  const start = (line: number) => lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
  const places = [{ line: e.line, from: e.from, to: e.to, insert: e.insert }, ...(e.also ?? [])].map((x) => ({ from: start(x.line) + x.from, to: start(x.line) + x.to, insert: x.insert }));
  let text = lines.join('\n');
  // From the end backwards, so the places of the edits still to make stay right.
  for (const x of places.sort((a, b) => b.from - a.from)) text = text.slice(0, x.from) + x.insert + text.slice(x.to);
  return text.split('\n');
}

const errorsOf = (lines: string[], defaults: Partial<Defaults>): Diagnostic[] => parseSpec(lines.join('\n'), { defaults }).errors;

const problemsOf = (lines: string[], defaults: Partial<Defaults>): Diagnostic[] => {
  const { errors, warnings } = parseSpec(lines.join('\n'), { defaults });
  return [...errors, ...warnings];
};

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether the edit makes the problem go away without a new one in its place: the same message no
 * longer starts where the problem started, and nothing that was not there before touches the new text.
 */
function removes(ctx: Context, e: Edit): boolean {
  const edited = applied(ctx.lines, e);
  if (ctx.strict) {
    // A problem that names the old text now names the new text, and is still the same problem.
    // The character before is matched and put back, not looked behind at: iOS before 16.4 has no lookbehind.
    const typed = new RegExp(`(^|[^A-Za-z0-9_])${escaped(textOf(ctx.lines, e.line, e.from, e.to))}(?![A-Za-z0-9_])`, 'gi');
    const had = ctx.strict.problems.map((b) => ({ line: b.line, message: b.message.replace(typed, (_, before: string) => before + e.insert) }));
    return !problemsOf(edited, ctx.defaults).some((x) => !had.some((b) => b.line === x.line && b.message === x.message));
  }
  const after = errorsOf(edited, ctx.defaults);
  if (after.some((x) => x.line === ctx.d.line && x.message === ctx.d.message && x.from === ctx.d.from)) return false;
  return !after.some((x) => {
    if (x.line !== e.line || ctx.errors.some((b) => b.line === x.line && b.message === x.message)) return false;
    return x.from === undefined || (x.from < e.from + e.insert.length && (x.to ?? Infinity) > e.from);
  });
}

function fix(e: Edit, replaced: string, habit = false): Fix {
  const word = (e.shown ?? e.insert).trim();
  const places = e.also?.length ? ` (${e.also.length + 1} places)` : '';
  return {
    line: e.line,
    from: e.from,
    to: e.to,
    insert: e.insert,
    label: `Change to ${word}${places}`,
    hint: habit ? `Write ${word}, not ${replaced}.` : `Possible correction: ${word}.`,
    ...(e.also?.length ? { also: e.also } : {}),
  };
}

/** The most fixes offered for one problem, when several candidates are equally near. */
const MAX_FIXES = 3;

/** The nearest candidate whose edit passes `removes`, or the ones that are equally near, the first few of them. */
function pick(ctx: Context, word: string, candidates: readonly string[], build: (candidate: string) => Edit | null): Fix[] {
  const good = ranked(word, candidates)
    .slice(0, 4)
    .flatMap((c) => {
      const edit = build(c.value);
      return edit && removes(ctx, edit) ? [{ edit, key: c.key }] : [];
    });
  return good
    .filter((g) => compare(g.key, good[0].key) === 0)
    .slice(0, MAX_FIXES)
    .map((g) => fix(g.edit, word));
}

/** A fix whose label and hint are its own, not the word it writes; none when it does not pass `removes`. */
function offer(ctx: Context, e: Edit, label: string, hint: string): Fix[] {
  return removes(ctx, e) ? [{ line: e.line, from: e.from, to: e.to, insert: e.insert, label, hint }] : [];
}

const NAMES = [...SERIES, ...CALENDAR, ...Object.keys(POSITION), 'true', 'false', 'always', 'never'];
/** Words that can follow a finished value in a condition. */
const CONNECTIVES = ['and', 'or', 'crosses', 'above', 'below', 'is', 'between', 'within', 'for'];

/** A rule's start written wrong, such as `sel whn`, on a line that begins with it. */
function ruleHead(lineNo: number, line: string): Edit | null {
  const m = line.match(/^(\s*)([A-Za-z]+)(\s+)([A-Za-z]+)(?!\w)/);
  if (!m) return null;
  const a = m[2].toLowerCase();
  const b = m[4].toLowerCase();
  // The word after it makes a rule head likely, so a two-letter start such as `ad` is within reach of `add`.
  const first = RULE_HEADS.includes(a) ? a : closest(a, RULE_HEADS, Math.max(1, allowance(a.length)));
  const second = b === 'when' ? b : closest(b, ['when']);
  if (!first || !second || (a === first && b === second)) return null;
  return { line: lineNo, from: m[1].length, to: m[1].length + m[2].length + m[3].length + m[4].length, insert: `${first} ${second}` };
}

function unknownSetting(ctx: Context, name: string): Fix[] {
  const { d } = ctx;
  if (d.from === undefined || d.to === undefined) return [];
  const typed = textOf(ctx.lines, d.line, d.from, d.to).replace(/\s+/g, ' ');
  const whole = pick(ctx, typed, SETTINGS, (c) => ({ line: d.line, from: d.from!, to: d.to!, insert: c }));
  if (whole.length) return whole;
  // `fro TLT:` reads as a setting called "fro TLT".
  const m = typed.match(/^(\S+) (\S+)$/);
  if (!m || !tickers(ctx.lines, ['universe', 'symbol']).some((t) => t.toLowerCase() === m[2].toLowerCase())) return [];
  return pick(ctx, m[1], ['for'], (c) => ({ line: d.line, from: d.from!, to: d.from! + m[1].length, insert: c }));
}

function unknownName(ctx: Context, word: string): Fix[] {
  const { d } = ctx;
  if (d.from === undefined || d.to === undefined || textOf(ctx.lines, d.line, d.from, d.to).toLowerCase() !== word) return [];
  const call = ctx.lines[d.line - 1].slice(d.to).trimStart().startsWith('(');
  const params = [...declaredParams(ctx.lines), ...declaredDefinitions(ctx.lines)].map((p) => p.name);
  // After "crosses" a direction is as likely as a value.
  const direction = /\bcrosses\s+$/i.test(ctx.lines[d.line - 1].slice(0, d.from)) ? ['above', 'below'] : [];
  const candidates = call ? FUNCTIONS : [...NAMES, ...params, ...direction];
  return pick(ctx, word, candidates, (c) => ({ line: d.line, from: d.from!, to: d.to!, insert: c }));
}

function unexpected(ctx: Context, found: string): Fix[] {
  const { d } = ctx;
  if (d.from === undefined || d.to === undefined) return [];
  const line = ctx.lines[d.line - 1];
  if ((found === '>' || found === '<') && line[d.from - 1] === '=') {
    const insert = found === '>' ? '>=' : '<=';
    return [fix({ line: d.line, from: d.from - 1, to: d.to, insert }, `=${found}`, true)];
  }
  if (!/^[A-Za-z_]+$/.test(found) || textOf(ctx.lines, d.line, d.from, d.to).toLowerCase() !== found) return [];
  if (found === 'is') {
    const next = line.slice(d.to).match(/^(\s+)([A-Za-z]+)/);
    const from = d.to + (next?.[1].length ?? 0);
    return next ? pick(ctx, next[2], ['above', 'below'], (c) => ({ line: d.line, from, to: from + next[2].length, insert: c })) : [];
  }
  if (!line.slice(0, d.from).trim()) {
    const head = ruleHead(d.line, line);
    if (head) return removes(ctx, head) ? [fix(head, line.slice(head.from, head.to))] : [];
  }
  return pick(ctx, found, CONNECTIVES, (c) => ({ line: d.line, from: d.from!, to: d.to!, insert: c }));
}

/** `&&`, `||` and a leading `!` as they are written in other languages. */
function habit(ctx: Context, found: string): Fix[] {
  const { d } = ctx;
  if (d.from === undefined) return [];
  const line = ctx.lines[d.line - 1];
  const at = d.from;
  if (line[at] !== found) return [];
  const spaced = (word: string, run: number): Edit => {
    const before = at > 0 && !/\s/.test(line[at - 1]) ? ' ' : '';
    const after = at + run < line.length && !/\s/.test(line[at + run]) ? ' ' : '';
    return { line: d.line, from: at, to: at + run, insert: `${before}${word}${after}`, shown: word };
  };
  let edit: Edit | null = null;
  if (found === '&' || found === '|') {
    const run = line.slice(at).match(found === '&' ? /^&+/ : /^\|+/)![0].length;
    edit = spaced(found === '&' ? 'and' : 'or', run);
  } else if (found === '!' && /[A-Za-z_(]/.test(line[at + 1] ?? '')) {
    edit = { line: d.line, from: at, to: at + 1, insert: 'not ', shown: 'not' };
  }
  return edit && removes(ctx, edit) ? [fix(edit, line.slice(edit.from, edit.to), true)] : [];
}

/** The option list a "must be one of" style message carries, for a value typed in its range. */
function optionsOf(message: string): string[] | null {
  const m = message.match(/^[A-Za-z ]+ must be one of: (.+)$/) ?? message.match(/^Binance intervals: (.+)$/);
  if (m) return m[1].split(', ');
  return /^(Yahoo|Tiingo) data comes as 1d or 1w bars, not "/.test(message) ? ['1d', '1w'] : null;
}

function settingValue(ctx: Context, options: string[]): Fix[] {
  const { d } = ctx;
  if (d.from === undefined || d.to === undefined) return [];
  const typed = textOf(ctx.lines, d.line, d.from, d.to).trim().replace(/\s+/g, ' ');
  return pick(ctx, typed, options, (c) => ({ line: d.line, from: d.from!, to: d.to!, insert: c }));
}

/** The ticker on a `for` line the parser says is not in the universe; the problem's range is the name as written. */
function forTicker(ctx: Context): Fix[] {
  const { d } = ctx;
  if (d.from === undefined || d.to === undefined) return [];
  return pick(ctx, textOf(ctx.lines, d.line, d.from, d.to), tickers(ctx.lines, ['universe', 'symbol']), (c) => ({ line: d.line, from: d.from!, to: d.to!, insert: c }));
}

/** `entry` or `bars` alone, with the second word missing or misspelt. */
function onItsOwn(ctx: Context, first: string, second: string): Fix[] {
  const { d } = ctx;
  if (d.from === undefined || d.to === undefined || textOf(ctx.lines, d.line, d.from, d.to).toLowerCase() !== first) return [];
  const next = ctx.lines[d.line - 1].slice(d.to).match(/^(\s+)([A-Za-z_]+)/);
  if (next) {
    return pick(ctx, next[2], [second], (c) => ({ line: d.line, from: d.from!, to: d.to! + next[1].length + next[2].length, insert: `${first} ${c}` }));
  }
  const edit = { line: d.line, from: d.to, to: d.to, insert: ` ${second}`, shown: `${first} ${second}` };
  return removes(ctx, edit) ? [fix(edit, first)] : [];
}

/** A line that is neither a setting nor a rule: a rule's start or a setting's name written wrong. */
function notARule(ctx: Context): Fix[] {
  const line = ctx.lines[ctx.d.line - 1];
  const head = ruleHead(ctx.d.line, line);
  if (head) return removes(ctx, head) ? [fix(head, line.slice(head.from, head.to))] : [];
  const m = line.match(/^(\s*)([A-Za-z_][A-Za-z_ ]*?)\s*:/);
  if (!m) return [];
  const typed = m[2].replace(/_/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  const edit = (c: string): Edit => ({ line: ctx.d.line, from: m[1].length, to: m[1].length + m[2].length, insert: c });
  if (SETTINGS.includes(typed)) return removes(ctx, edit(typed)) ? [fix(edit(typed), m[2])] : [];
  return pick(ctx, typed, SETTINGS, edit);
}

/** A word in a setting's value or a `[n]` that should have been the name of a parameter. */
function parameterName(ctx: Context): Fix[] {
  const { d } = ctx;
  const line = ctx.lines[d.line - 1];
  const params = declaredParams(ctx.lines).map((p) => p.name);
  if (!params.length || d.from === undefined || d.to === undefined) return [];
  if (/^The number in \[n\] must be a whole number/.test(d.message)) {
    const typed = textOf(ctx.lines, d.line, d.from, d.to);
    return /^[A-Za-z_]\w*$/.test(typed) ? pick(ctx, typed, params, (c) => ({ line: d.line, from: d.from!, to: d.to!, insert: c })) : [];
  }
  const key = settingKey(line);
  if (!key || !NUMERIC_SETTINGS.includes(key)) return [];
  const known = new Set(['atr', 'top', 'by', 'at', 'inverse', 'volatility', 'of', ...FUNCTIONS, ...NAMES, ...params.map((p) => p.toLowerCase())]);
  const colon = line.indexOf(':');
  const value = line.slice(colon + 1).replace(/(^|\s)(#|\/\/).*$/, '');
  const unknown = [...value.matchAll(/[A-Za-z_]\w*/g)].filter((w) => !known.has(w[0].toLowerCase()));
  if (unknown.length !== 1) return [];
  const from = colon + 1 + unknown[0].index;
  return pick(ctx, unknown[0][0], params, (c) => ({ line: d.line, from, to: from + unknown[0][0].length, insert: c }));
}

/** `crosses over` or `crosses under`, which the problem covers, as the crossing it most likely means. */
function crossing(ctx: Context, word: string): Fix[] {
  const { d } = ctx;
  if (d.from === undefined || d.to === undefined) return [];
  const insert = word === 'over' ? 'crosses above' : 'crosses below';
  return offer(ctx, { line: d.line, from: d.from, to: d.to, insert }, `Change to ${insert}`, `Possible correction: ${insert}.`);
}

/** A parameter's value outside its own range, which the problem covers: the value moved to the nearer end, or that end moved to the value. */
function outOfRange(ctx: Context): Fix[] {
  const { d } = ctx;
  if (d.from === undefined || d.to === undefined) return [];
  const line = ctx.lines[d.line - 1];
  const m = line.slice(d.to).match(new RegExp(String.raw`^(\s+in\s+)(${NUM})(\s*\.\.\s*)(${NUM})`, 'i'));
  if (!m) return [];
  const value = line.slice(d.from, d.to);
  const loFrom = d.to + m[1].length;
  const above = Number(value.replace('%', '')) > Number(m[4].replace('%', ''));
  const [end, from] = above ? [m[4], loFrom + m[2].length + m[3].length] : [m[2], loFrom];
  const range = above ? `${m[2]}..${value}` : `${value}..${m[4]}`;
  return [
    ...offer(ctx, { line: d.line, from: d.from, to: d.to, insert: end }, `Change to ${end}`, `Possible correction: ${end}.`),
    ...offer(ctx, { line: d.line, from, to: from + end.length, insert: value }, `Change the range to ${range}`, `Change the range to ${range}.`),
  ];
}

/** The blank lines just above a line that continues a rule or a definition, removed. */
function blankLines(ctx: Context): Fix[] {
  const { lines, d } = ctx;
  let first = d.line;
  while (first > 1 && !lines[first - 2].trim()) first--;
  const blank = lines.slice(first - 1, d.line - 1);
  if (!blank.length) return [];
  const width = blank.reduce((n, l) => n + l.length + 1, 0);
  return offer(ctx, { line: first, from: 0, to: width, insert: '' }, blank.length === 1 ? 'Remove the blank line' : 'Remove the blank lines', '');
}

/**
 * The corrections for a problem the parser reported: the one for a likely typo, the equally near ones when two or three are,
 * or the different ways to put a problem right, such as a value outside its range. `lines` are the block's lines and `d`
 * the parser's problem for them; each edit is in the same coordinates (the problem's line is 1-based). Each is offered
 * only after applying it to a copy of the block and reading that copy again: the problem at that spot must be gone, with
 * no new one in its place. None when there is no correction.
 */
export function fixesFor(lines: string[], d: Diagnostic, defaults: Partial<Defaults> = {}): Fix[] {
  const ctx: Context = { lines, d, defaults, errors: errorsOf(lines, defaults) };
  const m = (re: RegExp) => d.message.match(re);
  let found: RegExpMatchArray | null;
  if ((found = m(/^Unknown setting "(.+?)"\./))) return unknownSetting(ctx, found[1]);
  if ((found = m(/^Unknown name "(.+?)"\./))) return unknownName(ctx, found[1]);
  if ((found = m(/^Unexpected character "(.)"$/))) return habit(ctx, found[1]);
  if ((found = m(/^Unexpected "(.+)"$/))) return unexpected(ctx, found[1]);
  if (m(/^"for .+?:" names (?:a ticker that is not|.+, which is not) in the universe$/)) return forTicker(ctx);
  if ((found = m(/^"(entry|bars)" is not a complete name\. Write "(?:entry|bars) (price|held)"$/))) return onItsOwn(ctx, found[1], found[2]);
  if (/^Not a setting or a rule/.test(d.message)) return notARule(ctx);
  if ((found = m(/^Write "crosses above" or "crosses below", not "crosses (over|under)"\.$/))) return crossing(ctx, found[1]);
  if (m(/^.+ is not in the range .+\.\..+\. Change the value or the range\.$/)) return outOfRange(ctx);
  if (m(/^A blank line ends the (?:rule|definition) on line \d+\. Remove the blank line\.$/)) return blankLines(ctx);
  if ((found = m(/^Write the date with dashes: (\d{4}-\d{2}-\d{2})\.$/)) && d.from !== undefined && d.to !== undefined) {
    return offer(ctx, { line: d.line, from: d.from, to: d.to, insert: found[1] }, `Change to ${found[1]}`, '');
  }
  const options = optionsOf(d.message);
  if (options) return settingValue(ctx, options);
  return parameterName(ctx);
}

/** The correction for a problem the parser reported, when there is exactly one (see `fixesFor`), or null. */
export function fixFor(lines: string[], d: Diagnostic, defaults: Partial<Defaults> = {}): Fix | null {
  const found = fixesFor(lines, d, defaults);
  return found.length === 1 ? found[0] : null;
}

/** A block's lines with a fix made, every edit of it in the block as it was before any of them. */
export function applyFix(lines: string[], f: Fix): string[] {
  return applied(lines, f);
}

/** The word a fix writes, as its button names it: "sma" for "Change to sma (2 places)". */
export function fixWord(f: Fix): string {
  return f.label.replace(/^Change to /, '').replace(/ \(\d+ places\)$/, '');
}

/**
 * A parser message cut to what a reader needs first. "Unknown name" is followed by every name the language knows, which a
 * model repairing a block can use but a person reads as a wall of text: `head` is the sentence that names the word, and
 * `rest` the list, for a place that folds it away. Other messages are all head. A "Line 5: " in front stays with the head.
 */
export function shortMessage(message: string): { head: string; rest: string } {
  const m = message.match(/^((?:Line \d+: )?Unknown name "[^"]+"\.) ([\s\S]+)$/);
  return m ? { head: m[1], rest: m[2] } : { head: message, rest: '' };
}

const writesWord = (f: Fix): boolean => f.hint.startsWith('Possible correction');

/**
 * The fixes for a problem and a sentence that offers them, for one fix: "Did you mean sma, the simple average of the last n
 * closes?" when it writes a function's name, "Did you mean rebalance?" for another word, and the fix's own hint for a habit
 * such as `&&` (empty when the message says what to do). For equally near words: "Possible corrections: sma, sum.", and for
 * other ways to put the problem right, nothing more than the message. Null when there is no fix.
 */
export function suggestions(lines: string[], d: Diagnostic, defaults: Partial<Defaults> = {}): { fixes: Fix[]; text: string } | null {
  const fixes = fixesFor(lines, d, defaults);
  if (fixes.length > 1) return { fixes, text: fixes.every(writesWord) ? `Possible corrections: ${fixes.map(fixWord).join(', ')}.` : '' };
  const [found] = fixes;
  if (!found) return null;
  if (!writesWord(found)) return { fixes, text: found.hint };
  const word = fixWord(found);
  const short = FUNCTIONS.includes(word) ? shortOf(word) : '';
  return { fixes, text: short ? `Did you mean ${word}, the ${short}?` : `Did you mean ${word}?` };
}

/** The one fix for a problem and the sentence that offers it (see `suggestions`); null when there is none, or more than one. */
export function suggestion(lines: string[], d: Diagnostic, defaults: Partial<Defaults> = {}): { fix: Fix; text: string } | null {
  const found = suggestions(lines, d, defaults);
  return found?.fixes.length === 1 ? { fix: found.fixes[0], text: found.text } : null;
}

/** Where else a block writes a ticker, as the same ticker: on `for` lines, after `of`, in the universe and so on. */
function otherPlaces(lines: string[], at: { line: number; from: number }, prefix: string, typed: string): FixEdit[] {
  const out: FixEdit[] = [];
  tokenizeBlock(lines).forEach((row, i) => {
    for (const t of row) {
      if (t.kind !== 'ticker' || (i + 1 === at.line && t.from === at.from)) continue;
      const written = lines[i].slice(t.from, t.to);
      const there = written.match(SOURCE_PREFIX)?.[0] ?? '';
      // A bare name refers to the ticker by name, whatever its prefix; another prefix is another ticker.
      if (written.slice(there.length).toUpperCase() !== typed.toUpperCase() || (there && there.toLowerCase() !== prefix.toLowerCase())) continue;
      out.push({ line: i + 1, from: t.from + there.length, to: t.to, insert: '' });
    }
  });
  return out;
}

/** Another way of writing a ticker that its source can know: Yahoo writes a share class after a dash (BRK-B), where others write BRK.B. */
export function tickerSpellings(ticker: string, source: string): string[] {
  const m = source === 'yahoo' ? ticker.match(/^([A-Z0-9]+)\.([A-C])$/i) : null;
  return m ? [`${m[1]}-${m[2]}`.toUpperCase()] : [];
}

/**
 * Replaces a ticker the source does not know with the nearest of `candidates` (tickers the source does
 * know). `at` is where the ticker is written, with any `binance:` style prefix. The same ticker written
 * elsewhere in the block, on a `for` line or after `of`, changes with it, so the block stays consistent.
 * Nothing is offered when the edit would give the block a problem it did not have, anywhere in it.
 */
export function tickerFix(lines: string[], at: { line: number; from: number; to: number }, candidates: readonly string[], defaults: Partial<Defaults> = {}): Fix | null {
  const written = textOf(lines, at.line, at.from, at.to);
  const prefix = written.match(/^(yahoo|binance):/i)?.[0] ?? '';
  const typed = written.slice(prefix.length);
  const ctx: Context = { lines, d: { line: at.line, message: '', from: at.from, to: at.to }, defaults, errors: errorsOf(lines, defaults), strict: { problems: problemsOf(lines, defaults) } };
  const others = otherPlaces(lines, at, prefix, typed);
  const found = pick(ctx, typed, candidates, (c) => ({
    line: at.line,
    from: at.from + prefix.length,
    to: at.to,
    insert: c,
    shown: c,
    also: others.map((o) => ({ ...o, insert: c })),
  }));
  return found.length === 1 ? found[0] : null;
}
