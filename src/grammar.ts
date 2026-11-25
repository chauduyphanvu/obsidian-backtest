import { FIXED_VALUES } from './docs.ts';
import { INDICATORS, POSITION, SETTINGS } from './dsl.ts';

/**
 * The text of a strategy block as a context-free grammar, for models that generate under a grammar (Lark for OpenAI's
 * grammar-constrained tools, vLLM and llguidance; GBNF for llama.cpp). It reads characters, with the spaces written out.
 * It accepts more than the parser does: names are any identifier, an expression is a flat run of operands and
 * operators, and what a block means (which names exist, which rule may read what) is left to the parser. Words are in
 * their canonical lower case.
 */
export type Node =
  | { k: 'lit'; s: string }
  | { k: 'class'; ranges: [string, string][]; not: boolean }
  | { k: 'seq'; xs: Node[] }
  | { k: 'alt'; xs: Node[] }
  | { k: 'rep'; x: Node; min: 0 | 1; one: boolean }
  | { k: 'ref'; name: string };

export interface Grammar {
  /** By name, the first being where a block starts. */
  rules: Map<string, Node>;
  /** The rules that are single tokens (spaces, names, numbers): Lark writes them as terminals. They refer to no rule. */
  tokens: Set<string>;
}

const lit = (s: string): Node => ({ k: 'lit', s });
/** A character class from a list such as "A-Za-z0-9_": a letter, a range a-b, or a backslash and the next character. */
function cls(spec: string, not = false): Node {
  const ranges: [string, string][] = [];
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i] === '\\' ? spec[++i] : spec[i];
    if (spec[i + 1] === '-' && i + 2 < spec.length) {
      ranges.push([c, spec[i + 2] === '\\' ? spec[i + 3] : spec[i + 2]]);
      i += spec[i + 2] === '\\' ? 3 : 2;
    } else ranges.push([c, c]);
  }
  return { k: 'class', ranges, not };
}
const seq = (...xs: (Node | string)[]): Node => ({ k: 'seq', xs: xs.map((x) => (typeof x === 'string' ? lit(x) : x)) });
const alt = (...xs: (Node | string)[]): Node => ({ k: 'alt', xs: xs.map((x) => (typeof x === 'string' ? lit(x) : x)) });
const opt = (x: Node | string): Node => ({ k: 'rep', x: typeof x === 'string' ? lit(x) : x, min: 0, one: true });
const star = (x: Node): Node => ({ k: 'rep', x, min: 0, one: false });
const plus = (x: Node): Node => ({ k: 'rep', x, min: 1, one: false });
const ref = (name: string): Node => ({ k: 'ref', name });

/** Words written with one space between them, as `a ws b`. */
const words = (text: string): Node => seq(...text.split(' ').flatMap((w, i) => (i === 0 ? [w] : [ref('ws'), w])));

/** The function names a call may use; column() has a form of its own. */
export const GRAMMAR_FUNCTIONS = [...Object.keys(INDICATORS), 'min', 'max', 'abs', 'sqrt', 'log', 'exp', 'if'];

export function strategyGrammar(): Grammar {
  const r = new Map<string, Node>();
  const ws = ref('ws');
  const sp = opt(ws);
  const tokens = new Set(['ws', 'ident', 'digits', 'ticker', 'for_ticker', 'date', 'rest', 'column_name', 'quoted', 'comment_text']);

  r.set('block', seq(ref('line'), star(seq('\n', ref('line')))));
  r.set('line', seq(sp, opt(alt(seq(ref('content'), opt(seq(ws, opt(ref('comment'))))), ref('comment')))));
  r.set('comment', seq(alt('#', '//'), opt(ref('comment_text'))));
  r.set('content', alt(ref('setting'), ref('parameter'), ref('definition'), ref('rule'), ref('for_line'), ref('continuation')));

  // Tokens.
  r.set('ws', plus(cls(' \t')));
  r.set('ident', seq(cls('A-Za-z_'), star(cls('A-Za-z0-9_'))));
  r.set('digits', plus(cls('0-9')));
  r.set('ticker', plus(cls('A-Za-z0-9^:/._=\\-')));
  r.set('for_ticker', plus(cls('A-Za-z0-9^/._=\\-')));
  r.set('date', seq(cls('0-9'), cls('0-9'), cls('0-9'), cls('0-9'), '-', cls('0-9'), cls('0-9'), '-', cls('0-9'), cls('0-9')));
  r.set('rest', plus(cls('\n', true)));
  r.set('column_name', plus(cls('A-Za-z0-9_')));
  r.set('quoted', seq('"', star(cls('"\n', true)), '"'));
  r.set('comment_text', plus(cls('\n', true)));

  // Numbers.
  r.set('unsigned', alt(seq(ref('digits'), opt(seq('.', ref('digits')))), seq('.', ref('digits'))));
  r.set('number', seq(opt('-'), ref('unsigned'), opt(seq(sp, '%'))));
  r.set('percent', seq(ref('unsigned'), sp, '%'));
  r.set('count_or_name', alt(ref('digits'), ref('ident')));
  r.set('number_or_name', alt(ref('unsigned'), ref('ident')));

  // Settings: each key with the values it takes.
  const colon = seq(sp, ':', sp);
  const fixed = (key: string) => alt(...FIXED_VALUES[key].map(words));
  const atr = seq(alt(seq(ref('unsigned'), sp), seq(ref('ident'), ws)), 'atr', opt(seq(sp, '(', sp, ref('number_or_name'), sp, ')')));
  const level = alt(ref('percent'), atr, ref('ident'));
  const amount = seq(opt(seq('$', sp)), ref('unsigned'));
  const values: Record<string, Node> = {
    name: ref('rest'),
    universe: ref('ticker_list'),
    symbol: ref('ticker'),
    from: ref('date'),
    to: ref('date'),
    'test from': ref('date'),
    data: fixed('data'),
    interval: fixed('interval'),
    magnify: fixed('interval'),
    rebalance: fixed('rebalance'),
    fill: fixed('fill'),
    capital: seq(opt(seq('$', sp)), ref('digits'), star(seq(cls(',_'), ref('digits'))), opt(seq('.', ref('digits'))), opt(seq(sp, cls('kKmM')))),
    costs: seq(ref('unsigned'), opt(seq(sp, alt('bps', 'bp', '%')))),
    slippage: seq(ref('unsigned'), opt(seq(sp, alt('bps', 'bp', '%')))),
    commission: seq(amount, opt(seq(ws, 'per', ws, alt('order', 'share'))), star(seq(sp, ',', sp, alt('min', 'max'), ws, alt(ref('percent'), amount)))),
    size: alt(ref('percent'), ref('ident')),
    'cash rate': alt(ref('percent'), ref('ticker')),
    'borrow fee': alt(ref('percent'), ref('ident')),
    'margin rate': alt(ref('percent'), ref('ident')),
    'stop loss': level,
    'trailing stop': level,
    'take profit': level,
    'risk per trade': seq(alt(ref('percent'), ref('ident')), ws, 'at', ws, atr),
    hold: seq('top', ws, ref('count_or_name'), ws, 'by', ws, ref('expr')),
    weighting: seq('inverse', ws, 'volatility', sp, '(', sp, ref('number_or_name'), sp, ')'),
    entries: ref('count_or_name'),
    benchmark: ref('ticker'),
  };
  r.set('setting', alt(...SETTINGS.map((key) => seq(words(key), colon, values[key]))));
  r.set('ticker_list', seq(ref('ticker_item'), star(seq(sp, ',', sp, ref('ticker_item')))));
  r.set('ticker_item', seq(ref('ticker'), opt(seq(ws, ref('percent')))));

  // Parameters, definitions, rules and sections.
  r.set('parameter', seq(ref('ident'), sp, '=', sp, ref('number'), opt(seq(ws, 'in', ws, ref('number'), sp, '..', sp, ref('number'), opt(seq(ws, 'step', ws, ref('number')))))));
  r.set('definition', seq(ref('ident'), sp, '=', sp, ref('expr')));
  r.set('rule', seq(alt('buy', 'sell', 'add', 'short', 'cover'), ws, 'when', ws, ref('expr')));
  r.set('for_line', seq('for', ws, alt('all', seq(ref('for_ticker'), star(seq(sp, ',', sp, ref('for_ticker'))))), sp, ':'));
  // A line under a rule or definition continues it, and may start or end with an operator.
  r.set('continuation', seq(opt(alt(seq(ref('symbol_operator'), sp), seq(ref('word_operator'), ws))), ref('expr')));

  // Expressions, flat: operands joined by operators. Which binds first is the parser's business.
  r.set('expr', seq(ref('operand'), star(ref('joined')), opt(alt(seq(sp, ref('symbol_operator')), seq(ws, ref('word_operator'))))));
  r.set('joined', seq(ref('gap_operator'), ref('operand')));
  r.set('gap_operator', alt(seq(sp, ref('symbol_operator'), sp), seq(ws, ref('word_operator'), ws)));
  r.set('symbol_operator', alt('>=', '<=', '==', '!=', '>', '<', '=', '+', '-', '*', '/'));
  r.set('word_operator', alt('and', 'or', 'above', 'below', words('crosses above'), words('crosses below'), 'crosses', 'between'));
  r.set('operand', seq(star(ref('prefix')), ref('term'), star(ref('postfix'))));
  r.set('prefix', alt(seq('not', ws), seq('-', sp)));
  r.set('postfix', alt(
    seq(sp, '[', sp, ref('count_or_name'), sp, ']'),
    seq(ws, 'of', ws, ref('ticker')),
    seq(ws, alt('for', 'within'), ws, ref('count_or_name'), ws, 'bars'),
  ));
  r.set('term', alt(
    ref('number'),
    seq('(', sp, ref('expr'), sp, ')'),
    seq('not', sp, '(', sp, ref('expr'), sp, ')'),
    ref('call'),
    seq('column', sp, '(', sp, alt(ref('column_name'), ref('quoted')), sp, ')'),
    ...Object.values(POSITION).map(words),
    ref('ident'),
  ));
  r.set('call', seq(alt(...GRAMMAR_FUNCTIONS), sp, '(', sp, opt(seq(ref('expr'), star(seq(sp, ',', sp, ref('expr'))))), sp, ')'));

  return { rules: r, tokens };
}

// ---------------------------------------------------------------- recognizing

/** Whether `text`, a block's text, is in the grammar's language. */
export function recognize(g: Grammar, text: string): boolean {
  const memo = new Map<Node, Map<number, Set<number>>>();
  const ruleNode = new Map<string, Node>();
  for (const name of g.rules.keys()) ruleNode.set(name, ref(name));
  const inClass = (n: Extract<Node, { k: 'class' }>, c: string) => n.ranges.some(([a, b]) => c >= a && c <= b) !== n.not;

  const ends = (n: Node, at: number): Set<number> => {
    let byPos = memo.get(n);
    if (!byPos) memo.set(n, (byPos = new Map<number, Set<number>>()));
    const known = byPos.get(at);
    if (known) return known;
    const out = new Set<number>();
    byPos.set(at, out);
    switch (n.k) {
      case 'lit':
        if (text.startsWith(n.s, at)) out.add(at + n.s.length);
        break;
      case 'class':
        if (at < text.length && inClass(n, text[at])) out.add(at + 1);
        break;
      case 'ref':
        for (const e of ends(g.rules.get(n.name)!, at)) out.add(e);
        break;
      case 'alt':
        for (const x of n.xs) for (const e of ends(x, at)) out.add(e);
        break;
      case 'seq': {
        let here = new Set([at]);
        for (const x of n.xs) {
          const next = new Set<number>();
          for (const p of here) for (const e of ends(x, p)) next.add(e);
          here = next;
          if (here.size === 0) break;
        }
        for (const e of here) out.add(e);
        break;
      }
      case 'rep': {
        if (n.min === 0) out.add(at);
        let frontier = [at];
        const seen = new Set([at]);
        for (let round = 0; frontier.length > 0 && !(n.one && round === 1); round++) {
          const next: number[] = [];
          for (const p of frontier) for (const e of ends(n.x, p)) {
            out.add(e);
            if (!seen.has(e)) {
              seen.add(e);
              next.push(e);
            }
          }
          frontier = next;
        }
        break;
      }
    }
    return out;
  };
  const start = ruleNode.get(g.rules.keys().next().value!)!;
  return ends(start, 0).has(text.length);
}

// ---------------------------------------------------------------- writing out

const isAtom = (n: Node) => n.k === 'lit' || n.k === 'class' || n.k === 'ref';
const suffix = (n: Extract<Node, { k: 'rep' }>) => (n.one ? '?' : n.min === 0 ? '*' : '+');

function classBody(n: Extract<Node, { k: 'class' }>, esc: (c: string) => string): string {
  // A hyphen goes last and a caret never first, where both mean themselves in every dialect.
  const items = n.ranges.filter(([a, b]) => !(a === '-' && b === '-')).map(([a, b]) => (a === b ? esc(a) : `${esc(a)}-${esc(b)}`));
  const hyphen = n.ranges.some(([a, b]) => a === '-' && b === '-');
  if (items[0]?.startsWith('^') && items.length > 1) items.push(items.shift()!);
  return `[${n.not ? '^' : ''}${items.join('')}${hyphen ? '-' : ''}]`;
}

/** A token rule as one regular expression, for a Lark terminal. */
function regexOf(g: Grammar, n: Node): string {
  const esc = (c: string) => (c === '\n' ? '\\n' : c === '\t' ? '\\t' : /[\\\]^/]/.test(c) ? `\\${c}` : c);
  const group = (x: Node) => (x.k === 'class' || (x.k === 'lit' && x.s.length === 1) ? regexOf(g, x) : `(?:${regexOf(g, x)})`);
  switch (n.k) {
    case 'lit':
      return n.s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
    case 'class':
      return classBody(n, esc);
    case 'seq':
      return n.xs.map((x) => (x.k === 'alt' ? `(?:${regexOf(g, x)})` : regexOf(g, x))).join('');
    case 'alt':
      return n.xs.map((x) => regexOf(g, x)).join('|');
    case 'rep':
      return `${group(n.x)}${suffix(n)}`;
    case 'ref':
      return regexOf(g, g.rules.get(n.name)!);
  }
}

function writeNode(n: Node, name: (rule: string) => string, literal: (s: string) => string, klass: (n: Extract<Node, { k: 'class' }>) => string): string {
  const w = (x: Node): string => writeNode(x, name, literal, klass);
  switch (n.k) {
    case 'lit':
      return literal(n.s);
    case 'class':
      return klass(n);
    case 'ref':
      return name(n.name);
    case 'seq':
      return n.xs.map((x) => (x.k === 'alt' ? `(${w(x)})` : w(x))).join(' ');
    case 'alt':
      return n.xs.map(w).join(' | ');
    case 'rep':
      return `${isAtom(n.x) ? w(n.x) : `(${w(n.x)})`}${suffix(n)}`;
  }
}

const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;

export function toLark(g: Grammar): string {
  const name = (rule: string) => (g.tokens.has(rule) ? rule.toUpperCase() : rule);
  const out = ['// Backtest Blocks strategy language: the text of one strategy block. npm run generate writes this file. Do not edit it.', ''];
  const [first] = g.rules.keys();
  out.push(`start: ${first}`, '');
  for (const [rule, n] of g.rules) {
    if (g.tokens.has(rule)) out.push(`${name(rule)}: /${regexOf(g, n)}/`);
    else out.push(`${rule}: ${writeNode(n, name, quote, (c) => `/${regexOf(g, c)}/`)}`);
  }
  return `${out.join('\n')}\n`;
}

const gbnfName = (rule: string) => rule.replace(/_/g, '-');
const gbnfChar = (c: string) => (c === '\n' ? '\\n' : c === '\t' ? '\\t' : c === '\\' ? '\\\\' : c === ']' ? '\\]' : c === '[' ? '\\[' : c === '"' ? '\\"' : c);

export function toGbnf(g: Grammar): string {
  const out = ['# Backtest Blocks strategy language: the text of one strategy block. npm run generate writes this file. Do not edit it.', ''];
  const [first] = g.rules.keys();
  out.push(`root ::= ${gbnfName(first)}`);
  for (const [rule, n] of g.rules) out.push(`${gbnfName(rule)} ::= ${writeNode(n, gbnfName, quote, (c) => classBody(c, gbnfChar))}`);
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------- reading GBNF back

/** Reads the GBNF that toGbnf writes, so a test can check that it says what the grammar does. */
export function readGbnf(text: string): Map<string, Node> {
  const rules = new Map<string, Node>();
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-z0-9-]+) ::= (.*)$/);
    if (!m || m[1] === 'root') continue;
    let i = 0;
    const s = m[2];
    const skip = () => {
      while (s[i] === ' ') i++;
    };
    const char = (): string => {
      if (s[i] !== '\\') return s[i++];
      const c = s[i + 1];
      i += 2;
      return c === 'n' ? '\n' : c === 't' ? '\t' : c;
    };
    const atom = (): Node => {
      skip();
      if (s[i] === '(') {
        i++;
        const x = alts();
        skip();
        i++; // )
        return x;
      }
      if (s[i] === '"') {
        i++;
        let v = '';
        while (s[i] !== '"') v += char();
        i++;
        return lit(v);
      }
      if (s[i] === '[') {
        i++;
        const not = s[i] === '^';
        if (not) i++;
        const ranges: [string, string][] = [];
        while (s[i] !== ']') {
          const a = char();
          if (s[i] === '-' && s[i + 1] !== ']') {
            i++;
            ranges.push([a, char()]);
          } else ranges.push([a, a]);
        }
        i++;
        return { k: 'class', ranges, not };
      }
      const nm = s.slice(i).match(/^[a-z0-9-]+/)![0];
      i += nm.length;
      return ref(nm.replace(/-/g, '_'));
    };
    const postfixed = (): Node => {
      let x = atom();
      while ('?*+'.includes(s[i]) && i < s.length) {
        const c = s[i++];
        x = c === '?' ? opt(x) : c === '*' ? star(x) : plus(x);
      }
      return x;
    };
    const sequence = (): Node => {
      const xs: Node[] = [];
      for (skip(); i < s.length && s[i] !== '|' && s[i] !== ')'; skip()) xs.push(postfixed());
      return xs.length === 1 ? xs[0] : seq(...xs);
    };
    function alts(): Node {
      const xs = [sequence()];
      for (skip(); s[i] === '|'; skip()) {
        i++;
        xs.push(sequence());
      }
      return xs.length === 1 ? xs[0] : alt(...xs);
    }
    rules.set(m[1].replace(/-/g, '_'), alts());
  }
  return rules;
}

/** The same grammar node with nested sequences and alternatives flattened and one-item ones unwrapped, for comparing. */
export function normal(n: Node): Node {
  switch (n.k) {
    case 'seq':
    case 'alt': {
      const xs = n.xs.map(normal).flatMap((x) => (x.k === n.k ? (x as { xs: Node[] }).xs : [x]));
      return xs.length === 1 ? xs[0] : { k: n.k, xs };
    }
    case 'rep':
      return { ...n, x: normal(n.x) };
    case 'class':
      return { ...n, ranges: [...n.ranges].sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1)) };
    default:
      return n;
  }
}
