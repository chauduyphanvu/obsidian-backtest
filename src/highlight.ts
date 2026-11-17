import { CALENDAR, INDICATORS, PARAM_LINE, POSITION, RESERVED, SERIES, SETTINGS } from './dsl.ts';

export type TokenKind = 'key' | 'keyword' | 'function' | 'series' | 'number' | 'ticker' | 'value' | 'operator' | 'comment' | 'param';

export interface Token {
  from: number;
  to: number;
  kind: TokenKind;
}

/** What a line is, read the way the parser reads it. */
export type LineKind = 'blank' | 'for' | 'rule' | 'setting' | 'param' | 'continuation' | 'other';

const KEYWORDS = ['buy', 'sell', 'when', 'and', 'or', 'not', 'crosses', 'above', 'below', 'is', 'of'];
const CONSTANTS = ['true', 'false', 'always', 'never'];
const FUNCTIONS = [...Object.keys(INDICATORS), 'min', 'max', 'abs'];
/** Words that read like series: calendar values and the one-word spellings of position values. */
const VALUES: string[] = [...CALENDAR, ...Object.keys(POSITION)];
const TICKER_SETTINGS = ['universe', 'symbol', 'benchmark', 'cash rate'];
/** Settings whose values are numbers, percentages and atr(n), where parameters can stand in. */
const NUMERIC_SETTINGS = ['stop loss', 'trailing stop', 'take profit', 'risk per trade', 'weighting', 'hold'];

export function commentStart(line: string): number {
  const m = line.match(/(^|\s)(#|\/\/)/);
  return m ? m.index! + m[1].length : -1;
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

/** The parameter a line declares, or null. */
export function paramName(line: string): string | null {
  const m = code(line).match(PARAM_LINE);
  return m && !RESERVED.has(m[1].toLowerCase()) ? m[1] : null;
}

/** The parameters a block declares, with the text after "=". */
export function declaredParams(lines: string[]): { name: string; value: string }[] {
  return lines.flatMap((line) => {
    const name = paramName(line);
    return name ? [{ name, value: code(line).match(PARAM_LINE)![2] }] : [];
  });
}

/** `inRule` is whether the previous line was part of a rule, so this one can continue it. */
export function lineKind(line: string, inRule: boolean): LineKind {
  const text = code(line);
  if (!text) return 'blank';
  if (/^for\s+.+:$/i.test(text)) return 'for';
  if (/^(buy|sell)\s+when\b/i.test(text)) return 'rule';
  if (settingKey(text)) return 'setting';
  if (paramName(text)) return 'param';
  return inRule ? 'continuation' : 'other';
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
      const pair = (word === 'bars' || word === 'entry') && line.slice(end, to).match(word === 'bars' ? /^\s+held\b/i : /^\s+price\b/i);
      if (pair) {
        out.push({ from: start, to: end + pair[0].length, kind: 'series' });
        re.lastIndex = end + pair[0].length;
      } else if (KEYWORDS.includes(word)) out.push({ from: start, to: end, kind: 'keyword' });
      else if (CONSTANTS.includes(word)) out.push({ from: start, to: end, kind: 'value' });
      else if (FUNCTIONS.includes(word)) out.push({ from: start, to: end, kind: 'function' });
      else if ((SERIES as string[]).includes(word) || VALUES.includes(word)) out.push({ from: start, to: end, kind: 'series' });
      else if (params.has(word)) out.push({ from: start, to: end, kind: 'param' });
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
    out.push({ from: at, to: at + m[4].length, kind: m[4].toLowerCase() === 'all' ? 'keyword' : 'ticker' });
  } else if (kind === 'rule' || kind === 'continuation') {
    expression(line, 0, end, names, out);
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
    inRule = kind === 'rule' || kind === 'continuation';
    return kind;
  });
}

/** Tokens for each line of a whole block. */
export function tokenizeBlock(lines: string[]): Token[][] {
  const params = declaredParams(lines).map((p) => p.name);
  const kinds = lineKinds(lines);
  return lines.map((line, i) => tokenize(line, kinds[i], params));
}
