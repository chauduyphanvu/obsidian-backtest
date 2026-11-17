import { INDICATORS, SERIES, SETTINGS } from './dsl.ts';

export type TokenKind = 'key' | 'keyword' | 'function' | 'series' | 'number' | 'ticker' | 'value' | 'operator' | 'comment';

export interface Token {
  from: number;
  to: number;
  kind: TokenKind;
}

/** What a line is, read the way the parser reads it. */
export type LineKind = 'blank' | 'for' | 'rule' | 'setting' | 'continuation' | 'other';

const KEYWORDS = ['buy', 'sell', 'when', 'and', 'or', 'not', 'crosses', 'above', 'below', 'is', 'of'];
const CONSTANTS = ['true', 'false', 'always', 'never'];
const FUNCTIONS = [...Object.keys(INDICATORS), 'min', 'max', 'abs'];
const TICKER_SETTINGS = ['universe', 'symbol', 'benchmark'];

function commentStart(line: string): number {
  const m = line.match(/(^|\s)(#|\/\/)/);
  return m ? m.index! + m[1].length : -1;
}

export function settingKey(text: string): string | null {
  const m = text.match(/^\s*([A-Za-z][A-Za-z ]*?)\s*:/);
  const key = m ? m[1].toLowerCase().replace(/\s+/g, ' ') : null;
  return key && SETTINGS.includes(key) ? key : null;
}

/** `inRule` is whether the previous line was part of a rule, so this one can continue it. */
export function lineKind(line: string, inRule: boolean): LineKind {
  const c = commentStart(line);
  const text = (c < 0 ? line : line.slice(0, c)).trim();
  if (!text) return 'blank';
  if (/^for\s+.+:$/i.test(text)) return 'for';
  if (/^(buy|sell)\s+when\b/i.test(text)) return 'rule';
  if (settingKey(text)) return 'setting';
  return inRule ? 'continuation' : 'other';
}

function expression(line: string, from: number, to: number, out: Token[]): void {
  const re = /(\d+(?:\.\d+)?%?|\.\d+%?)|([A-Za-z_][A-Za-z0-9_]*)|(>=|<=|==|!=|[()[\],+\-*/><=])/g;
  re.lastIndex = from;
  for (let m = re.exec(line); m && m.index < to; m = re.exec(line)) {
    const [start, end] = [m.index, m.index + m[0].length];
    if (m[1]) out.push({ from: start, to: end, kind: 'number' });
    else if (m[3]) out.push({ from: start, to: end, kind: 'operator' });
    else {
      const word = m[2].toLowerCase();
      if (KEYWORDS.includes(word)) out.push({ from: start, to: end, kind: 'keyword' });
      else if (CONSTANTS.includes(word)) out.push({ from: start, to: end, kind: 'value' });
      else if (FUNCTIONS.includes(word)) out.push({ from: start, to: end, kind: 'function' });
      else if ((SERIES as string[]).includes(word)) out.push({ from: start, to: end, kind: 'series' });
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

/** Tokens to colour on one line of a strategy block. */
export function tokenize(line: string, kind: LineKind): Token[] {
  const out: Token[] = [];
  const c = commentStart(line);
  const end = c < 0 ? line.length : c;
  if (kind === 'for') {
    const m = line.match(/^(\s*)(for)(\s+)(.+?)\s*:/i)!;
    out.push({ from: m[1].length, to: m[1].length + 3, kind: 'keyword' });
    const at = m[1].length + 3 + m[3].length;
    out.push({ from: at, to: at + m[4].length, kind: m[4].toLowerCase() === 'all' ? 'keyword' : 'ticker' });
  } else if (kind === 'rule' || kind === 'continuation') {
    expression(line, 0, end, out);
  } else if (kind === 'setting') {
    const colon = line.indexOf(':');
    const keyFrom = line.length - line.trimStart().length;
    out.push({ from: keyFrom, to: colon, kind: 'key' });
    const key = settingKey(line)!;
    if (key === 'name') {
      const lead = line.slice(colon + 1, end).match(/^\s*/)![0].length;
      if (colon + 1 + lead < end) out.push({ from: colon + 1 + lead, to: line.slice(0, end).trimEnd().length, kind: 'value' });
    } else {
      const re = TICKER_SETTINGS.includes(key) ? /(\d+(?:\.\d+)?\s*%)|([A-Za-z0-9^:/._=-]+)/g : /(\$?\d[\d,_.-]*\s*(?:%|bps?|[kKmM]\b)?)|([A-Za-z]+)/g;
      re.lastIndex = colon + 1;
      for (let m = re.exec(line); m && m.index < end; m = re.exec(line)) {
        out.push({ from: m.index, to: m.index + m[0].length, kind: m[1] ? 'number' : TICKER_SETTINGS.includes(key) ? 'ticker' : 'value' });
      }
    }
  }
  if (c >= 0) out.push({ from: c, to: line.length, kind: 'comment' });
  return out;
}

/** Tokens for each line of a whole block. */
export function tokenizeBlock(lines: string[]): Token[][] {
  let inRule = false;
  return lines.map((line) => {
    const kind = lineKind(line, inRule);
    inRule = kind === 'rule' || kind === 'continuation';
    return tokenize(line, kind);
  });
}
