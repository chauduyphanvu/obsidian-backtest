import { tickers } from './complete.ts';
import { CALENDAR, INDICATORS, POSITION, SERIES, SETTINGS, parseSpec, type Defaults, type Diagnostic } from './dsl.ts';
import { declaredParams, settingKey } from './highlight.ts';

/** One change to a block's text, and how to offer it. Columns are in line `line` (1-based, as in a parser Diagnostic). */
export interface Fix {
  line: number;
  from: number;
  to: number;
  insert: string;
  /** For the button: "Change to sma". */
  label: string;
  /** For places that can only show text: "Did you mean sma?". */
  hint: string;
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

/** Candidates within reach of a typed word, nearest first. A word that is already a candidate has no typo. */
function ranked(word: string, candidates: readonly string[]): { value: string; key: number[] }[] {
  const seen = new Set<string>();
  const out: { value: string; key: number[] }[] = [];
  for (const value of candidates) {
    if (seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    const key = closeness(word, value);
    if (key[0] >= 1 && key[0] <= allowance(word.length)) out.push({ value, key });
  }
  return out.sort((a, b) => compare(a.key, b.key));
}

/** The candidate nearest to a typed word, or null when none is near enough or two are equally near. */
export function closest(word: string, candidates: readonly string[]): string | null {
  const [best, next] = ranked(word, candidates);
  return best && (!next || compare(best.key, next.key) !== 0) ? best.value : null;
}

interface Edit {
  line: number;
  from: number;
  to: number;
  insert: string;
  /** What to call the new text in a label, when it carries spaces for the neighbours. */
  shown?: string;
}

interface Context {
  lines: string[];
  d: Diagnostic;
  defaults: Partial<Defaults>;
  /** The block's problems before the edit. */
  errors: Diagnostic[];
  /** Any new problem on the edited line counts, not only one that touches the new text. */
  strict?: boolean;
}

const textOf = (lines: string[], line: number, from: number, to: number): string => lines[line - 1]?.slice(from, to) ?? '';

function applied(lines: string[], e: Edit): string[] {
  const out = [...lines];
  out[e.line - 1] = out[e.line - 1].slice(0, e.from) + e.insert + out[e.line - 1].slice(e.to);
  return out;
}

const errorsOf = (lines: string[], defaults: Partial<Defaults>): Diagnostic[] => parseSpec(lines.join('\n'), { defaults }).errors;

/**
 * Whether the edit makes the problem go away without a new one in its place: the same message no
 * longer starts where the problem started, and nothing that was not there before touches the new text.
 */
function removes(ctx: Context, e: Edit): boolean {
  const after = errorsOf(applied(ctx.lines, e), ctx.defaults);
  if (after.some((x) => x.line === ctx.d.line && x.message === ctx.d.message && x.from === ctx.d.from)) return false;
  return !after.some((x) => {
    if (x.line !== e.line || ctx.errors.some((b) => b.line === x.line && b.message === x.message)) return false;
    return ctx.strict || x.from === undefined || (x.from < e.from + e.insert.length && (x.to ?? Infinity) > e.from);
  });
}

function fix(e: Edit, replaced: string, habit = false): Fix {
  const word = (e.shown ?? e.insert).trim();
  return {
    line: e.line,
    from: e.from,
    to: e.to,
    insert: e.insert,
    label: `Change to ${word}`,
    hint: habit ? `Write ${word} instead of ${replaced}.` : `Did you mean ${word}?`,
  };
}

/** The nearest candidate whose edit passes `removes`; two equally good ones leave it undecided. */
function pick(ctx: Context, word: string, candidates: readonly string[], build: (candidate: string) => Edit | null): Fix | null {
  const good = ranked(word, candidates)
    .slice(0, 4)
    .flatMap((c) => {
      const edit = build(c.value);
      return edit && removes(ctx, edit) ? [{ edit, key: c.key }] : [];
    });
  if (!good.length || (good[1] && compare(good[0].key, good[1].key) === 0)) return null;
  return fix(good[0].edit, word);
}

const FUNCTIONS = [...Object.keys(INDICATORS), 'min', 'max', 'abs'];
const NAMES = [...SERIES, ...CALENDAR, ...Object.keys(POSITION), 'true', 'false', 'always', 'never'];
/** Words that can follow a finished value in a condition. */
const CONNECTIVES = ['and', 'or', 'crosses', 'above', 'below', 'is'];

/** A rule's start written wrong, such as `sel whn`, on a line that begins with it. */
function ruleHead(lineNo: number, line: string): Edit | null {
  const m = line.match(/^(\s*)([A-Za-z]+)(\s+)([A-Za-z]+)(?!\w)/);
  if (!m) return null;
  const a = m[2].toLowerCase();
  const b = m[4].toLowerCase();
  const first = a === 'buy' || a === 'sell' ? a : closest(a, ['buy', 'sell']);
  const second = b === 'when' ? b : closest(b, ['when']);
  if (!first || !second || (a === first && b === second)) return null;
  return { line: lineNo, from: m[1].length, to: m[1].length + m[2].length + m[3].length + m[4].length, insert: `${first} ${second}` };
}

function unknownSetting(ctx: Context, name: string): Fix | null {
  const { d } = ctx;
  if (d.from === undefined || d.to === undefined) return null;
  const typed = textOf(ctx.lines, d.line, d.from, d.to).replace(/\s+/g, ' ');
  const whole = pick(ctx, typed, SETTINGS, (c) => ({ line: d.line, from: d.from!, to: d.to!, insert: c }));
  if (whole) return whole;
  // `fro TLT:` reads as a setting called "fro TLT".
  const m = typed.match(/^(\S+) (\S+)$/);
  if (!m || !tickers(ctx.lines, ['universe', 'symbol']).some((t) => t.toLowerCase() === m[2].toLowerCase())) return null;
  return pick(ctx, m[1], ['for'], (c) => ({ line: d.line, from: d.from!, to: d.from! + m[1].length, insert: c }));
}

function unknownName(ctx: Context, word: string): Fix | null {
  const { d } = ctx;
  if (d.from === undefined || d.to === undefined || textOf(ctx.lines, d.line, d.from, d.to).toLowerCase() !== word) return null;
  const call = ctx.lines[d.line - 1].slice(d.to).trimStart().startsWith('(');
  const params = declaredParams(ctx.lines).map((p) => p.name);
  const candidates = call ? FUNCTIONS : [...NAMES, ...params];
  return pick(ctx, word, candidates, (c) => ({ line: d.line, from: d.from!, to: d.to!, insert: c }));
}

function unexpected(ctx: Context, found: string): Fix | null {
  const { d } = ctx;
  if (d.from === undefined || d.to === undefined) return null;
  const line = ctx.lines[d.line - 1];
  if ((found === '>' || found === '<') && line[d.from - 1] === '=') {
    const insert = found === '>' ? '>=' : '<=';
    return fix({ line: d.line, from: d.from - 1, to: d.to, insert }, `=${found}`, true);
  }
  if (!/^[A-Za-z_]+$/.test(found) || textOf(ctx.lines, d.line, d.from, d.to).toLowerCase() !== found) return null;
  if (found === 'is') {
    const next = line.slice(d.to).match(/^(\s+)([A-Za-z]+)/);
    const from = d.to + (next?.[1].length ?? 0);
    return next ? pick(ctx, next[2], ['above', 'below'], (c) => ({ line: d.line, from, to: from + next[2].length, insert: c })) : null;
  }
  if (!line.slice(0, d.from).trim()) {
    const head = ruleHead(d.line, line);
    if (head) return removes(ctx, head) ? fix(head, line.slice(head.from, head.to)) : null;
  }
  return pick(ctx, found, CONNECTIVES, (c) => ({ line: d.line, from: d.from!, to: d.to!, insert: c }));
}

/** `&&`, `||` and a leading `!` as they are written in other languages. */
function habit(ctx: Context, found: string): Fix | null {
  const { d } = ctx;
  if (d.from === undefined) return null;
  const line = ctx.lines[d.line - 1];
  const at = d.from;
  if (line[at] !== found) return null;
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
  return edit && removes(ctx, edit) ? fix(edit, line.slice(edit.from, edit.to), true) : null;
}

/** The option list a "must be one of" style message carries, for a value typed in its range. */
function optionsOf(message: string): string[] | null {
  const m = message.match(/^[A-Za-z ]+ must be one of: (.+)$/) ?? message.match(/^Binance intervals: (.+)$/);
  if (m) return m[1].split(', ');
  return /^Yahoo data comes as 1d or 1w bars, not "/.test(message) ? ['1d', '1w'] : null;
}

function settingValue(ctx: Context, options: string[]): Fix | null {
  const { d } = ctx;
  if (d.from === undefined || d.to === undefined) return null;
  const typed = textOf(ctx.lines, d.line, d.from, d.to).trim().replace(/\s+/g, ' ');
  return pick(ctx, typed, options, (c) => ({ line: d.line, from: d.from!, to: d.to!, insert: c }));
}

/** The `for` line above a problem inside its section, when it names the ticker the message names. */
function forTicker(ctx: Context, name: string): Fix | null {
  for (let n = ctx.d.line; n >= 1; n--) {
    const m = ctx.lines[n - 1].replace(/(^|\s)(#|\/\/).*$/, '').match(/^(\s*for\s+)(.+?)\s*:\s*$/i);
    if (!m) continue;
    if (m[2].toLowerCase() !== name.toLowerCase()) return null;
    return pick(ctx, m[2], tickers(ctx.lines, ['universe', 'symbol']), (c) => ({ line: n, from: m[1].length, to: m[1].length + m[2].length, insert: c }));
  }
  return null;
}

/** `entry` or `bars` alone, with the second word missing or misspelt. */
function onItsOwn(ctx: Context, first: string, second: string): Fix | null {
  const { d } = ctx;
  if (d.from === undefined || d.to === undefined || textOf(ctx.lines, d.line, d.from, d.to).toLowerCase() !== first) return null;
  const next = ctx.lines[d.line - 1].slice(d.to).match(/^(\s+)([A-Za-z_]+)/);
  if (next) {
    return pick(ctx, next[2], [second], (c) => ({ line: d.line, from: d.from!, to: d.to! + next[1].length + next[2].length, insert: `${first} ${c}` }));
  }
  const edit = { line: d.line, from: d.to, to: d.to, insert: ` ${second}`, shown: `${first} ${second}` };
  return removes(ctx, edit) ? fix(edit, first) : null;
}

/** A line that is neither a setting nor a rule: a rule's start or a setting's name written wrong. */
function notARule(ctx: Context): Fix | null {
  const line = ctx.lines[ctx.d.line - 1];
  const head = ruleHead(ctx.d.line, line);
  if (head) return removes(ctx, head) ? fix(head, line.slice(head.from, head.to)) : null;
  const m = line.match(/^(\s*)([A-Za-z_][A-Za-z_ ]*?)\s*:/);
  if (!m) return null;
  const typed = m[2].replace(/_/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  const edit = (c: string): Edit => ({ line: ctx.d.line, from: m[1].length, to: m[1].length + m[2].length, insert: c });
  if (SETTINGS.includes(typed)) return removes(ctx, edit(typed)) ? fix(edit(typed), m[2]) : null;
  return pick(ctx, typed, SETTINGS, edit);
}

/** A word in a setting's value or a `[n]` that should have been the name of a parameter. */
function parameterName(ctx: Context): Fix | null {
  const { d } = ctx;
  const line = ctx.lines[d.line - 1];
  const params = declaredParams(ctx.lines).map((p) => p.name);
  if (!params.length || d.from === undefined || d.to === undefined) return null;
  if (/^Bars ago must be a whole number/.test(d.message)) {
    const typed = textOf(ctx.lines, d.line, d.from, d.to);
    return /^[A-Za-z_]\w*$/.test(typed) ? pick(ctx, typed, params, (c) => ({ line: d.line, from: d.from!, to: d.to!, insert: c })) : null;
  }
  const key = settingKey(line);
  if (!key || !['stop loss', 'trailing stop', 'take profit', 'risk per trade', 'weighting', 'hold'].includes(key)) return null;
  const known = new Set(['atr', 'top', 'by', 'at', 'inverse', 'volatility', 'of', ...FUNCTIONS, ...NAMES, ...params.map((p) => p.toLowerCase())]);
  const colon = line.indexOf(':');
  const value = line.slice(colon + 1).replace(/(^|\s)(#|\/\/).*$/, '');
  const unknown = [...value.matchAll(/[A-Za-z_]\w*/g)].filter((w) => !known.has(w[0].toLowerCase()));
  if (unknown.length !== 1) return null;
  const from = colon + 1 + unknown[0].index;
  return pick(ctx, unknown[0][0], params, (c) => ({ line: d.line, from, to: from + unknown[0][0].length, insert: c }));
}

/**
 * The correction for a problem the parser reported, when it is a likely typo, or null. `lines` are the
 * block's lines and `d` the parser's problem for them; the edit is in the same coordinates (the
 * problem's line is 1-based). It is offered only after applying it to a copy of the block and reading
 * that copy again: the problem at that spot must be gone, with no new one in its place.
 */
export function fixFor(lines: string[], d: Diagnostic, defaults: Partial<Defaults> = {}): Fix | null {
  const ctx: Context = { lines, d, defaults, errors: errorsOf(lines, defaults) };
  const m = (re: RegExp) => d.message.match(re);
  let found: RegExpMatchArray | null;
  if ((found = m(/^Unknown setting "(.+?)"\./))) return unknownSetting(ctx, found[1]);
  if ((found = m(/^Unknown name "(.+?)"\./))) return unknownName(ctx, found[1]);
  if ((found = m(/^Unexpected character "(.)"$/))) return habit(ctx, found[1]);
  if ((found = m(/^Unexpected "(.+)"$/))) return unexpected(ctx, found[1]);
  if (m(/^Expected "above" or "below" after "crosses"$/)) {
    const typed = d.from === undefined ? '' : textOf(lines, d.line, d.from, d.to ?? d.from).toLowerCase();
    return typed ? pick(ctx, typed, ['above', 'below'], (c) => ({ line: d.line, from: d.from!, to: d.to!, insert: c })) : null;
  }
  if ((found = m(/^"for (.+?):" names a ticker that is not in the universe$/))) return forTicker(ctx, found[1]);
  if ((found = m(/^"(entry|bars)" on its own is not a name\. Write "(?:entry|bars) (price|held)"$/))) return onItsOwn(ctx, found[1], found[2]);
  if (/^Not a setting or a rule/.test(d.message)) return notARule(ctx);
  const options = optionsOf(d.message);
  if (options) return settingValue(ctx, options);
  return parameterName(ctx);
}

/** The same suggestion as a sentence, for places that cannot offer a button. */
export function hintFor(lines: string[], d: Diagnostic, defaults: Partial<Defaults> = {}): string | null {
  return fixFor(lines, d, defaults)?.hint ?? null;
}

/**
 * Replaces a ticker the source does not know with the nearest of `candidates` (tickers the source does
 * know). `at` is where the ticker is written, with any `binance:` style prefix. Nothing is offered when
 * the edit would give the block a problem it did not have.
 */
export function tickerFix(lines: string[], at: { line: number; from: number; to: number }, candidates: readonly string[], defaults: Partial<Defaults> = {}): Fix | null {
  const written = textOf(lines, at.line, at.from, at.to);
  const prefix = written.match(/^(yahoo|binance):/i)?.[0] ?? '';
  const typed = written.slice(prefix.length);
  const ctx: Context = { lines, d: { line: at.line, message: '', from: at.from, to: at.to }, defaults, errors: errorsOf(lines, defaults), strict: true };
  return pick(ctx, typed, candidates, (c) => ({ line: at.line, from: at.from + prefix.length, to: at.to, insert: c, shown: c }));
}
