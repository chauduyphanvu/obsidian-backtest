import { CALENDAR, INDICATORS, isParamValue, PARAM_LINE, POSITION, RESERVED, SERIES, SETTINGS } from './dsl.ts';

export type TokenKind = 'key' | 'keyword' | 'function' | 'series' | 'number' | 'ticker' | 'value' | 'operator' | 'comment' | 'param';

export interface Token {
  from: number;
  to: number;
  kind: TokenKind;
}

/** What a line is, read the way the parser reads it. A `define` line is `name = expression`, as a `param` line is `name = number`. */
export type LineKind = 'blank' | 'for' | 'rule' | 'setting' | 'param' | 'define' | 'continuation' | 'other';

/** Whether the line after one of this kind can continue it: a rule or a definition goes on over several lines. */
export const continues = (kind: LineKind): boolean => kind === 'rule' || kind === 'continuation' || kind === 'define';

/** The words a rule starts with, before `when`. */
export const RULE_HEADS = ['buy', 'sell', 'add', 'short', 'cover'];
const KEYWORDS = ['buy', 'sell', 'short', 'cover', 'when', 'and', 'or', 'not', 'crosses', 'above', 'below', 'is', 'of', 'between', 'within', 'for'];
const CONSTANTS = ['true', 'false', 'always', 'never'];
const FUNCTIONS = [...Object.keys(INDICATORS), 'min', 'max', 'abs', 'sqrt', 'log', 'exp', 'if'];
/** Words that read like series: calendar values and the one-word spellings of position values. */
const VALUES: string[] = [...CALENDAR, ...Object.keys(POSITION)];
/** The words that must follow the first word of a position value written in several words. */
const PAIRS = new Map<string, RegExp>([
  ['bars', /^\s+held\b/i],
  ['entry', /^\s+price\b/i],
  ['entries', /^\s+made\b/i],
  ['last', /^\s+entry\s+price\b/i],
  ['highest', /^\s+since\s+entry\b/i],
  ['lowest', /^\s+since\s+entry\b/i],
  ['position', /^\s+return\b/i],
]);
/** Settings whose values are tickers. */
export const TICKER_SETTINGS = ['universe', 'symbol', 'benchmark', 'cash rate'];
/** Settings whose values are numbers, percentages and atr(n), where parameters can stand in. */
export const NUMERIC_SETTINGS = ['stop loss', 'trailing stop', 'take profit', 'risk per trade', 'weighting', 'hold', 'entries'];
/** Settings whose value is a bar size such as `1h` or `15m`, one word whatever its digits. */
const SIZE_SETTINGS = ['interval', 'magnify'];

/** Where a comment starts: a `#` or `//` at the start of a line or after a space. Not inside the quotes of a column's name, as in `column("a # b")`. */
export function commentStart(line: string): number {
  const quoted = [...line.matchAll(/\bcolumn\s*\(\s*"[^"]*"/gi)].map((m) => [m.index, m.index + m[0].length]);
  for (const m of line.matchAll(/(^|\s)(#|\/\/)/g)) {
    const at = m.index + m[1].length;
    if (!quoted.some(([from, to]) => at >= from && at < to)) return at;
  }
  return -1;
}

function code(line: string): string {
  const c = commentStart(line);
  return (c < 0 ? line : line.slice(0, c)).trim();
}

export function settingKey(text: string): string | null {
  const m = text.match(/^\s*([A-Za-z][A-Za-z ]*?)\s*:/);
  const key = m ? m[1].toLowerCase().replace(/\s+/g, ' ') : null;
  return key && SETTINGS.includes(key) ? key : null;
}

/** The name a `name = value` line gives and whether it is a parameter's (a number, maybe with a range) or a definition's; null for any other line. */
function assignment(line: string): { name: string; param: boolean } | null {
  const m = code(line).match(PARAM_LINE);
  return m && !RESERVED.has(m[1].toLowerCase()) ? { name: m[1], param: isParamValue(m[2]) } : null;
}

/** The parameter a line declares, or null. */
export function paramName(line: string): string | null {
  const a = assignment(line);
  return a?.param ? a.name : null;
}

/** The parameters a block declares, with the text after "=". */
export function declaredParams(lines: string[]): { name: string; value: string }[] {
  return lines.flatMap((line) => {
    const name = paramName(line);
    return name ? [{ name, value: code(line).match(PARAM_LINE)![2] }] : [];
  });
}

/** The definitions a block makes, with the expression after "=" as one line, a continuation's lines joined by a space. */
export function declaredDefinitions(lines: string[]): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  let open = false;
  for (const line of lines) {
    const a = assignment(line);
    if (a && !a.param) {
      out.push({ name: a.name, value: code(line).match(PARAM_LINE)![2] });
      open = true;
    } else if (open && lineKind(line, true) === 'continuation') {
      out[out.length - 1].value += ` ${code(line)}`;
    } else {
      open = false;
    }
  }
  return out;
}

/** `inRule` is whether the previous line was part of a rule, so this one can continue it. */
export function lineKind(line: string, inRule: boolean): LineKind {
  const text = code(line);
  if (!text) return 'blank';
  if (/^for\s+.+:$/i.test(text)) return 'for';
  if (/^(buy|sell|add|short|cover)\s+when\b/i.test(text)) return 'rule';
  if (settingKey(text)) return 'setting';
  const a = assignment(text);
  if (a) return a.param ? 'param' : 'define';
  return inRule ? 'continuation' : 'other';
}

/** Whether the tokens so far end in `for 3` or `within n`: the word that follows is the unit of a window. */
function windowCount(out: Token[], line: string): boolean {
  const [before, last] = [out[out.length - 2], out[out.length - 1]];
  return !!before && before.kind === 'keyword' && ['for', 'within'].includes(line.slice(before.from, before.to).toLowerCase()) && (last.kind === 'number' || last.kind === 'param');
}

function expression(line: string, from: number, to: number, params: Set<string>, out: Token[]): void {
  const re = /(\d+(?:\.\d+)?%?|\.\d+%?)|([A-Za-z_][A-Za-z0-9_]*)|(>=|<=|==|!=|[()[\],+\-*/><=])/g;
  re.lastIndex = from;
  for (let m = re.exec(line); m && m.index < to; m = re.exec(line)) {
    const [start, end] = [m.index, m.index + m[0].length];
    if (m[1]) out.push({ from: start, to: end, kind: 'number' });
    else if (m[3]) out.push({ from: start, to: end, kind: 'operator' });
    else {
      const word = m[2].toLowerCase();
      const pair = PAIRS.has(word) ? line.slice(end, to).match(PAIRS.get(word)!) : null;
      // A column's name is read as written, so it can start with a digit or sit in quotes with spaces in it.
      const column = word === 'column' && line.slice(end, to).match(/^(\s*)\((\s*)("[^"]*"?|[A-Za-z0-9_]+)/);
      if (column) {
        const open = end + column[1].length;
        const name = open + 1 + column[2].length;
        out.push({ from: start, to: end, kind: 'function' }, { from: open, to: open + 1, kind: 'operator' }, { from: name, to: name + column[3].length, kind: 'series' });
        re.lastIndex = name + column[3].length;
      } else if (word === 'column' && /^\s*\(/.test(line.slice(end, to))) {
        out.push({ from: start, to: end, kind: 'function' });
      } else if (pair) {
        out.push({ from: start, to: end + pair[0].length, kind: 'series' });
        re.lastIndex = end + pair[0].length;
      } else if ((word === 'bars' || word === 'bar') && windowCount(out, line)) {
        out.push({ from: start, to: end, kind: 'keyword' });
      } else if (KEYWORDS.includes(word)) out.push({ from: start, to: end, kind: 'keyword' });
      // A block's own name wins over a word the language took up later (dsl.ts LATER_WORDS); no name can be an older one.
      else if (params.has(word)) out.push({ from: start, to: end, kind: 'param' });
      else if (CONSTANTS.includes(word)) out.push({ from: start, to: end, kind: 'value' });
      else if (FUNCTIONS.includes(word)) out.push({ from: start, to: end, kind: 'function' });
      else if ((SERIES as string[]).includes(word) || VALUES.includes(word)) out.push({ from: start, to: end, kind: 'series' });
      if (word === 'of') {
        const sym = line.slice(end, to).match(/^\s*([A-Za-z0-9^:/._=-]+)/);
        if (sym) {
          out.push({ from: end + sym[0].length - sym[1].length, to: end + sym[0].length, kind: 'ticker' });
          re.lastIndex = end + sym[0].length;
        }
      }
    }
  }
}

/** `2 atr(14)`, `1% at 2 atr(14)`, `inverse volatility(60)`, `top 3 by …`: numbers, a few words, parameters. */
function numericValue(line: string, from: number, to: number, params: Set<string>, out: Token[]): void {
  const re = /(\d+(?:\.\d+)?(?:\s*%)?|\.\d+(?:\s*%)?)|([A-Za-z_][A-Za-z0-9_]*)|([()])/g;
  re.lastIndex = from;
  for (let m = re.exec(line); m && m.index < to; m = re.exec(line)) {
    const [start, end] = [m.index, m.index + m[0].length];
    if (m[1]) out.push({ from: start, to: end, kind: 'number' });
    else if (m[3]) out.push({ from: start, to: end, kind: 'operator' });
    else {
      const word = m[2].toLowerCase();
      out.push({ from: start, to: end, kind: word === 'atr' ? 'function' : ['at', 'top', 'by'].includes(word) ? 'keyword' : params.has(word) ? 'param' : 'value' });
      // After "by" comes the ranking score, which reads like a rule.
      if (word === 'by') return expression(line, end, to, params, out);
    }
  }
}

/** Tokens to colour on one line of a strategy block. `params` are the names the block declares. */
export function tokenize(line: string, kind: LineKind, params: string[] = []): Token[] {
  const out: Token[] = [];
  // A line read from a file with Windows line endings still carries its "\r", which is not part of the text.
  const length = line.endsWith('\r') ? line.length - 1 : line.length;
  const c = commentStart(line);
  const end = c < 0 ? length : c;
  const names = new Set(params.map((p) => p.toLowerCase()));
  if (kind === 'for') {
    const m = line.match(/^(\s*)(for)(\s+)(.+?)\s*:/i)!;
    out.push({ from: m[1].length, to: m[1].length + 3, kind: 'keyword' });
    const at = m[1].length + 3 + m[3].length;
    // One or more tickers, separated by commas.
    for (const piece of m[4].matchAll(/[^,\s][^,]*/g)) {
      const name = piece[0].trimEnd();
      out.push({ from: at + piece.index, to: at + piece.index + name.length, kind: name.toLowerCase() === 'all' ? 'keyword' : 'ticker' });
    }
  } else if (kind === 'rule' || kind === 'continuation') {
    // "add" is not a reserved word, so it is coloured only as the head of a rule.
    const head = kind === 'rule' ? line.match(/^(\s*)add\b/i) : null;
    if (head) out.push({ from: head[1].length, to: head[0].length, kind: 'keyword' });
    expression(line, head ? head[0].length : 0, end, names, out);
  } else if (kind === 'define') {
    const lead = line.length - line.trimStart().length;
    const name = line.slice(lead).match(/^[A-Za-z_][A-Za-z0-9_]*/)![0];
    out.push({ from: lead, to: lead + name.length, kind: 'key' });
    expression(line, line.indexOf('=', lead + name.length) + 1, end, names, out);
  } else if (kind === 'param') {
    const lead = line.length - line.trimStart().length;
    const name = paramName(line)!;
    out.push({ from: lead, to: lead + name.length, kind: 'key' });
    const re = /(-?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*%)?)|(\.\.|=)|([A-Za-z_][A-Za-z0-9_]*)/g;
    re.lastIndex = lead + name.length;
    for (let m = re.exec(line); m && m.index < end; m = re.exec(line)) {
      const kindOf: TokenKind | null = m[1] ? 'number' : m[2] ? 'operator' : ['in', 'step'].includes(m[3].toLowerCase()) ? 'keyword' : null;
      if (kindOf) out.push({ from: m.index, to: m.index + m[0].length, kind: kindOf });
    }
  } else if (kind === 'setting') {
    const colon = line.indexOf(':');
    const keyFrom = line.length - line.trimStart().length;
    out.push({ from: keyFrom, to: colon, kind: 'key' });
    const key = settingKey(line)!;
    if (key === 'name') {
      const lead = line.slice(colon + 1, end).match(/^\s*/)![0].length;
      if (colon + 1 + lead < end) out.push({ from: colon + 1 + lead, to: line.slice(0, end).trimEnd().length, kind: 'value' });
    } else if (NUMERIC_SETTINGS.includes(key)) {
      numericValue(line, colon + 1, end, names, out);
    } else if (SIZE_SETTINGS.includes(key)) {
      for (const m of line.slice(0, end).matchAll(/[A-Za-z0-9]+/g)) if (m.index > colon) out.push({ from: m.index, to: m.index + m[0].length, kind: 'value' });
    } else if (key === 'commission') {
      // An amount, and the words of "0.005 per share, min 1, max 1%": a comma or a space belongs to neither.
      for (const m of line.slice(0, end).matchAll(/(\$?(?:\d+(?:\.\d+)?|\.\d+)%?)|([A-Za-z]+)/g)) {
        if (m.index > colon) out.push({ from: m.index, to: m.index + m[0].length, kind: m[1] ? 'number' : 'value' });
      }
    } else {
      const re = TICKER_SETTINGS.includes(key) ? /(\d+(?:\.\d+)?\s*%)|([A-Za-z0-9^:/._=-]+)/g : /(\$?\d[\d,_.-]*\s*(?:%|bps?|[kKmM]\b)?)|([A-Za-z]+)/g;
      re.lastIndex = colon + 1;
      for (let m = re.exec(line); m && m.index < end; m = re.exec(line)) {
        out.push({ from: m.index, to: m.index + m[0].length, kind: m[1] ? 'number' : TICKER_SETTINGS.includes(key) ? 'ticker' : 'value' });
      }
    }
  }
  if (c >= 0) out.push({ from: c, to: length, kind: 'comment' });
  return out;
}

/** What each line of a whole block is, with a rule's continuation lines read in context. */
export function lineKinds(lines: string[]): LineKind[] {
  let inRule = false;
  return lines.map((line) => {
    const kind = lineKind(line, inRule);
    inRule = continues(kind);
    return kind;
  });
}

/** Tokens for each line of a whole block. */
export function tokenizeBlock(lines: string[]): Token[][] {
  const params = [...declaredParams(lines), ...declaredDefinitions(lines)].map((p) => p.name);
  const kinds = lineKinds(lines);
  return lines.map((line, i) => tokenize(line, kinds[i], params));
}
