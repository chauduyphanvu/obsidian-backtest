import type { Asset, AssetRef, Source } from './types.ts';

export type SeriesName = 'open' | 'high' | 'low' | 'close' | 'volume';
export type CmpOp = '>' | '<' | '>=' | '<=' | '==' | '!=' | 'xup' | 'xdn';

export type Expr =
  | { k: 'num'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'series'; name: SeriesName }
  | { k: 'ind'; fn: string; src: Expr | null; args: number[] }
  | { k: 'math'; fn: 'min' | 'max' | 'abs'; args: Expr[] }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: Expr; b: Expr }
  | { k: 'neg'; a: Expr }
  | { k: 'cmp'; op: CmpOp; a: Expr; b: Expr }
  | { k: 'logic'; op: 'and' | 'or'; a: Expr; b: Expr }
  | { k: 'not'; a: Expr }
  | { k: 'lag'; a: Expr; n: number }
  | { k: 'of'; a: Expr; asset: string };

export type Rebalance = 'never' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export interface Rules {
  buy: Expr;
  sell: Expr | null;
}

export interface Spec {
  name: string | null;
  universe: Asset[];
  /** Tickers the rules read with `of` that are not held. */
  extras: AssetRef[];
  benchmark: AssetRef | null;
  from: number | null;
  to: number | null;
  interval: string;
  capital: number;
  costBps: number;
  rebalance: Rebalance;
  stopLoss: number | null;
  trailingStop: number | null;
  takeProfit: number | null;
  /** Rules per universe asset name, with the shared rules already filled in. */
  rules: Record<string, Rules>;
}

export interface Diagnostic {
  /** 1-based line inside the block. */
  line: number;
  message: string;
}

/**
 * Indicators. `src` is the series used when none is given (null: the function takes no series).
 * `params` lists the numeric parameters with their defaults (null: required).
 */
export const INDICATORS: Record<string, { src: SeriesName | null; params: (number | null)[] }> = {
  sma: { src: 'close', params: [null] },
  ema: { src: 'close', params: [null] },
  rsi: { src: 'close', params: [14] },
  roc: { src: 'close', params: [null] },
  stdev: { src: 'close', params: [null] },
  highest: { src: 'high', params: [null] },
  lowest: { src: 'low', params: [null] },
  atr: { src: null, params: [14] },
  macd: { src: 'close', params: [12, 26] },
  macd_signal: { src: 'close', params: [12, 26, 9] },
  bb_upper: { src: 'close', params: [20, 2] },
  bb_lower: { src: 'close', params: [20, 2] },
};

export const SERIES: SeriesName[] = ['open', 'high', 'low', 'close', 'volume'];
export const BINANCE_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'];
const YAHOO_INTERVALS = ['1d', '1w'];
export const REBALANCE: Rebalance[] = ['never', 'weekly', 'monthly', 'quarterly', 'yearly'];

class SpecError extends Error {
  line: number;
  constructor(line: number, message: string) {
    super(message);
    this.line = line;
  }
}

interface Tok {
  t: 'num' | 'id' | 'sym' | 'op' | 'end';
  s: string;
  v: number;
  line: number;
}

function lex(text: string, line: number, out: Tok[]): void {
  let i = 0;
  const push = (t: Tok['t'], s: string, v = 0) => out.push({ t, s, v, line });
  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\s+/))) {
      i += m[0].length;
    } else if ((m = rest.match(/^(\d+(?:\.\d+)?|\.\d+)(\s*%)?/))) {
      push('num', m[0], m[2] ? Number(m[1]) / 100 : Number(m[1]));
      i += m[0].length;
    } else if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/))) {
      const word = m[0].toLowerCase();
      i += m[0].length;
      if (word === 'of') {
        // A ticker can hold characters that are operators elsewhere (BTC-USD, BRK.B, ^VIX).
        const sym = text.slice(i).match(/^\s*([A-Za-z0-9^:/._=-]+)/);
        if (!sym) throw new SpecError(line, 'Expected a ticker after "of"');
        push('op', 'of');
        push('sym', sym[1]);
        i += sym[0].length;
      } else {
        push('id', word);
      }
    } else if ((m = rest.match(/^(>=|<=|==|!=|[()[\],+\-*/><=])/))) {
      push('op', m[0]);
      i += m[0].length;
    } else {
      throw new SpecError(line, `Unexpected character "${rest[0]}"`);
    }
  }
}

export function isBool(e: Expr): boolean {
  switch (e.k) {
    case 'bool':
    case 'cmp':
    case 'logic':
    case 'not':
      return true;
    case 'lag':
    case 'of':
      return isBool(e.a);
    default:
      return false;
  }
}

class ExprParser {
  private pos = 0;
  private toks: Tok[];
  private resolveAsset: (sym: string, line: number) => string;

  constructor(toks: Tok[], resolveAsset: (sym: string, line: number) => string) {
    this.toks = toks;
    this.resolveAsset = resolveAsset;
  }

  parseCondition(): Expr {
    const e = this.or();
    const t = this.peek();
    if (t.t !== 'end') throw new SpecError(t.line, `Unexpected "${t.s}"`);
    if (!isBool(e)) throw new SpecError(t.line, 'A rule needs a condition, such as close > sma(200)');
    return e;
  }

  private peek(): Tok {
    return this.toks[this.pos];
  }
  private next(): Tok {
    return this.toks[this.pos++];
  }
  private isOp(s: string): boolean {
    const t = this.peek();
    return t.t === 'op' && t.s === s;
  }
  private isId(s: string): boolean {
    const t = this.peek();
    return t.t === 'id' && t.s === s;
  }
  private expect(s: string): void {
    const t = this.next();
    if (t.t !== 'op' || t.s !== s) throw new SpecError(t.line, `Expected "${s}"${t.t === 'end' ? '' : ` but found "${t.s}"`}`);
  }
  private needBool(e: Expr, t: Tok, word: string): Expr {
    if (!isBool(e)) throw new SpecError(t.line, `"${word}" needs a condition on each side, such as close > sma(200)`);
    return e;
  }
  private needNum(e: Expr, t: Tok, what: string): Expr {
    if (isBool(e)) throw new SpecError(t.line, `${what} needs a number, not a condition`);
    return e;
  }

  private or(): Expr {
    let a = this.and();
    while (this.isId('or')) {
      const t = this.next();
      const b = this.and();
      a = { k: 'logic', op: 'or', a: this.needBool(a, t, 'or'), b: this.needBool(b, t, 'or') };
    }
    return a;
  }

  private and(): Expr {
    let a = this.not();
    while (this.isId('and')) {
      const t = this.next();
      const b = this.not();
      a = { k: 'logic', op: 'and', a: this.needBool(a, t, 'and'), b: this.needBool(b, t, 'and') };
    }
    return a;
  }

  private not(): Expr {
    if (this.isId('not')) {
      const t = this.next();
      return { k: 'not', a: this.needBool(this.not(), t, 'not') };
    }
    return this.cmp();
  }

  private cmpOp(): CmpOp | null {
    const t = this.peek();
    if (t.t === 'op' && ['>', '<', '>=', '<=', '==', '!=', '='].includes(t.s)) {
      this.next();
      return t.s === '=' ? '==' : (t.s as CmpOp);
    }
    if (t.t !== 'id') return null;
    if (t.s === 'crosses') {
      this.next();
      const dir = this.next();
      if (dir.t === 'id' && dir.s === 'above') return 'xup';
      if (dir.t === 'id' && dir.s === 'below') return 'xdn';
      throw new SpecError(dir.line, 'Expected "above" or "below" after "crosses"');
    }
    if (t.s === 'is') {
      const after = this.toks[this.pos + 1];
      if (after.t === 'id' && (after.s === 'above' || after.s === 'below')) this.next();
    }
    if (this.isId('above')) {
      this.next();
      return '>';
    }
    if (this.isId('below')) {
      this.next();
      return '<';
    }
    return null;
  }

  private cmp(): Expr {
    const a = this.sum();
    const t = this.peek();
    const op = this.cmpOp();
    if (!op) return a;
    const b = this.sum();
    return { k: 'cmp', op, a: this.needNum(a, t, 'A comparison'), b: this.needNum(b, t, 'A comparison') };
  }

  private sum(): Expr {
    let a = this.prod();
    while (this.isOp('+') || this.isOp('-')) {
      const t = this.next();
      const b = this.prod();
      a = { k: 'bin', op: t.s as '+' | '-', a: this.needNum(a, t, `"${t.s}"`), b: this.needNum(b, t, `"${t.s}"`) };
    }
    return a;
  }

  private prod(): Expr {
    let a = this.unary();
    while (this.isOp('*') || this.isOp('/')) {
      const t = this.next();
      const b = this.unary();
      a = { k: 'bin', op: t.s as '*' | '/', a: this.needNum(a, t, `"${t.s}"`), b: this.needNum(b, t, `"${t.s}"`) };
    }
    return a;
  }

  private unary(): Expr {
    if (this.isOp('-')) {
      const t = this.next();
      return { k: 'neg', a: this.needNum(this.unary(), t, '"-"') };
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.isOp('[')) {
        this.next();
        const n = this.next();
        if (n.t !== 'num' || !Number.isInteger(n.v) || n.v < 0) {
          throw new SpecError(n.line, 'Bars ago must be a whole number, as in close[1]');
        }
        this.expect(']');
        e = { k: 'lag', a: e, n: n.v };
      } else if (this.isOp('of')) {
        this.next();
        const sym = this.next();
        e = { k: 'of', a: e, asset: this.resolveAsset(sym.s, sym.line) };
      } else {
        return e;
      }
    }
  }

  private primary(): Expr {
    const t = this.next();
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'op' && t.s === '(') {
      const e = this.or();
      this.expect(')');
      return e;
    }
    if (t.t === 'id') {
      if (t.s === 'true' || t.s === 'always') return { k: 'bool', v: true };
      if (t.s === 'false' || t.s === 'never') return { k: 'bool', v: false };
      if ((SERIES as string[]).includes(t.s)) return { k: 'series', name: t.s as SeriesName };
      if (t.s === 'min' || t.s === 'max' || t.s === 'abs') return this.math(t);
      if (t.s in INDICATORS) return this.indicator(t);
      throw new SpecError(t.line, `Unknown name "${t.s}". Series: ${SERIES.join(', ')}. Functions: ${Object.keys(INDICATORS).join(', ')}, min, max, abs`);
    }
    throw new SpecError(t.line, t.t === 'end' ? 'The rule ends too early' : `Unexpected "${t.s}"`);
  }

  private args(): Expr[] {
    const out: Expr[] = [];
    if (!this.isOp('(')) return out;
    this.next();
    if (this.isOp(')')) {
      this.next();
      return out;
    }
    for (;;) {
      out.push(this.or());
      if (this.isOp(',')) this.next();
      else break;
    }
    this.expect(')');
    return out;
  }

  private math(t: Tok): Expr {
    const fn = t.s as 'min' | 'max' | 'abs';
    const args = this.args();
    const want = fn === 'abs' ? 1 : 2;
    if (args.length !== want) throw new SpecError(t.line, `${fn}() takes ${want} value${want > 1 ? 's' : ''}`);
    for (const a of args) this.needNum(a, t, `${fn}()`);
    return { k: 'math', fn, args };
  }

  private indicator(t: Tok): Expr {
    const def = INDICATORS[t.s];
    const args = this.args();
    let src: Expr | null = def.src ? { k: 'series', name: def.src } : null;
    let rest = args;
    if (def.src && args.length > 0 && (args[0].k !== 'num' || args.length > def.params.length)) {
      src = this.needNum(args[0], t, `${t.s}()`);
      rest = args.slice(1);
    }
    if (rest.length > def.params.length) throw new SpecError(t.line, `${t.s}() takes at most ${def.params.length} number${def.params.length > 1 ? 's' : ''}`);
    const nums = def.params.map((dflt, i) => {
      const a = rest[i];
      if (!a) {
        if (dflt === null) throw new SpecError(t.line, `${t.s}() needs a period, as in ${t.s}(20)`);
        return dflt;
      }
      if (a.k !== 'num') throw new SpecError(t.line, `${t.s}() periods must be plain numbers`);
      return a.v;
    });
    const isBand = t.s === 'bb_upper' || t.s === 'bb_lower';
    nums.forEach((n, i) => {
      const multiplier = isBand && i === 1;
      if (multiplier ? n <= 0 : !Number.isInteger(n) || n < 1 || n > 10000) {
        throw new SpecError(t.line, `${t.s}(): ${n} is not a valid ${multiplier ? 'band width' : 'period'}`);
      }
    });
    return { k: 'ind', fn: t.s, src, args: nums };
  }
}

function parseRef(text: string, defaultSource: Source, line: number): AssetRef {
  const m = text.match(/^(yahoo|binance|csv):(.+)$/i);
  const source = m ? (m[1].toLowerCase() as Source) : defaultSource;
  const raw = m ? m[2] : text;
  if (source === 'csv') {
    const base = raw.split('/').pop()!.replace(/\.csv$/i, '');
    if (!base) throw new SpecError(line, `"${text}" is not a CSV path`);
    return { name: base, source, id: raw };
  }
  if (!/^[A-Za-z0-9^._=-]+$/.test(raw)) throw new SpecError(line, `"${raw}" is not a ticker`);
  const id = raw.toUpperCase();
  return { name: id, source, id };
}

function parseDate(text: string, line: number): number {
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  if (Number.isNaN(ms)) throw new SpecError(line, `"${text}" is not a date. Write it as 2015-01-31`);
  return ms;
}

function parsePercent(text: string, line: number, what: string, max: number): number {
  const m = text.match(/^(\d+(?:\.\d+)?)\s*%/);
  if (!m || Number(m[1]) <= 0 || Number(m[1]) > max) throw new SpecError(line, `${what} must be a percentage, such as 10%`);
  return Number(m[1]) / 100;
}

function parseCapital(text: string, line: number): number {
  const m = text.replace(/[$,_\s]/g, '').match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
  const mult = m && m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1;
  if (!m || Number(m[1]) * mult <= 0) throw new SpecError(line, `"${text}" is not an amount. Write it as 10000 or 10k`);
  return Number(m[1]) * mult;
}

function parseCosts(text: string, line: number): number {
  const m = text.match(/^(\d+(?:\.\d+)?)\s*(bps?|%)?$/i);
  if (!m) throw new SpecError(line, `"${text}" is not a cost. Write it as 5 bps or 0.05%`);
  const bps = m[2] === '%' ? Number(m[1]) * 100 : Number(m[1]);
  if (bps >= 1000) throw new SpecError(line, 'Costs must be under 10% per trade');
  return bps;
}

interface RawRule {
  side: 'buy' | 'sell';
  scope: string | null;
  line: number;
  toks: Tok[];
}

export const SETTINGS = ['name', 'universe', 'symbol', 'from', 'to', 'data', 'interval', 'capital', 'costs', 'size', 'rebalance', 'benchmark', 'stop loss', 'trailing stop', 'take profit'];

export function parseSpec(source: string): { spec: Spec | null; errors: Diagnostic[] } {
  const errors: Diagnostic[] = [];
  const settings = new Map<string, { value: string; line: number }>();
  const rawRules: RawRule[] = [];
  let scope: { name: string; line: number } | null = null;
  let open: RawRule | null = null;

  const guard = (line: number, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      if (!(e instanceof SpecError)) throw e;
      errors.push({ line: e.line || line, message: e.message });
    }
  };

  source.split('\n').forEach((rawLine, idx) => {
    const line = idx + 1;
    const text = rawLine.replace(/(^|\s)(#|\/\/).*$/, '').trim();
    if (!text) {
      open = null;
      return;
    }
    let m: RegExpMatchArray | null;
    if ((m = text.match(/^for\s+(.+?)\s*:$/i))) {
      open = null;
      scope = m[1].toLowerCase() === 'all' ? null : { name: m[1], line };
    } else if ((m = text.match(/^(buy|sell)\s+when\b(.*)$/i))) {
      const rule: RawRule = { side: m[1].toLowerCase() as 'buy' | 'sell', scope: scope?.name ?? null, line, toks: [] };
      open = rule;
      rawRules.push(rule);
      guard(line, () => lex(m![2], line, rule.toks));
    } else if ((m = text.match(/^([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/)) && SETTINGS.includes(m[1].toLowerCase().replace(/\s+/g, ' '))) {
      open = null;
      const key = m[1].toLowerCase().replace(/\s+/g, ' ').replace(/^symbol$/, 'universe');
      if (settings.has(key)) errors.push({ line, message: `"${key}" is set twice` });
      else if (!m[2]) errors.push({ line, message: `"${key}" has no value` });
      else settings.set(key, { value: m[2], line });
    } else if (open) {
      const rule: RawRule = open;
      guard(line, () => lex(text, line, rule.toks));
    } else if ((m = text.match(/^([A-Za-z][A-Za-z ]*?)\s*:/))) {
      errors.push({ line, message: `Unknown setting "${m[1]}". Settings: ${SETTINGS.join(', ')}` });
    } else {
      errors.push({ line, message: 'Not a setting or a rule. Rules start with "buy when" or "sell when"' });
    }
  });

  const get = <T>(key: string, parse: (value: string, line: number) => T, dflt: T): T => {
    const s = settings.get(key);
    if (!s) return dflt;
    let out = dflt;
    guard(s.line, () => {
      out = parse(s.value.trim(), s.line);
    });
    return out;
  };
  const oneOf = <T extends string>(options: readonly T[], what: string) => (value: string, line: number): T => {
    const v = value.toLowerCase() as T;
    if (!options.includes(v)) throw new SpecError(line, `${what} must be one of: ${options.join(', ')}`);
    return v;
  };

  const defaultSource = get('data', oneOf(['yahoo', 'binance'] as const, 'data'), 'yahoo' as Source);
  const size = get('size', (v, l) => parsePercent(v, l, 'size', 100), null as number | null);

  const universe: Asset[] = [];
  const u = settings.get('universe');
  if (!u) {
    errors.push({ line: 1, message: 'Add a universe, such as "universe: SPY" or "universe: SPY 60%, TLT 40%"' });
  } else {
    guard(u.line, () => {
      const parts = u.value.split(',').map((p) => p.trim()).filter(Boolean);
      const weights: (number | null)[] = [];
      for (const part of parts) {
        const m = part.match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)\s*%)?$/);
        if (!m) throw new SpecError(u.line, `Can't read "${part}". Write a ticker and an optional weight, such as SPY 60%`);
        const ref = parseRef(m[1], defaultSource, u.line);
        if (universe.some((a) => a.name.toLowerCase() === ref.name.toLowerCase())) throw new SpecError(u.line, `${ref.name} is listed twice`);
        universe.push({ ...ref, weight: 0 });
        weights.push(m[2] === undefined ? null : Number(m[2]) / 100);
      }
      if (universe.length === 0) throw new SpecError(u.line, 'The universe is empty');
      const given = weights.filter((w) => w !== null).length;
      if (given !== 0 && given !== weights.length) throw new SpecError(u.line, 'Give every ticker a weight, or none');
      if (given !== 0 && size !== null) throw new SpecError(settings.get('size')!.line, 'Use either weights in the universe or "size", not both');
      universe.forEach((a, i) => (a.weight = weights[i] ?? (size ?? 1) / universe.length));
      if (universe.some((a) => a.weight <= 0)) throw new SpecError(u.line, 'Weights must be above 0%');
      const total = universe.reduce((s, a) => s + a.weight, 0);
      if (total > 1 + 1e-9) throw new SpecError(u.line, `Weights add up to ${(total * 100).toFixed(1)}%. The most is 100%: this is long or flat, with no leverage`);
    });
  }

  const extras: AssetRef[] = [];
  const resolveAsset = (sym: string, line: number): string => {
    const lower = sym.toLowerCase();
    const known = [...universe, ...extras].find((a) => a.name.toLowerCase() === lower);
    if (known) return known.name;
    const ref = parseRef(sym, defaultSource, line);
    const same = [...universe, ...extras].find((a) => a.name.toLowerCase() === ref.name.toLowerCase());
    if (same) return same.name;
    extras.push(ref);
    return ref.name;
  };

  const shared: { buy?: Expr; sell?: Expr } = {};
  const own = new Map<string, { buy?: Expr; sell?: Expr }>();
  for (const r of rawRules) {
    guard(r.line, () => {
      let target = shared;
      if (r.scope !== null) {
        const asset = universe.find((a) => a.name.toLowerCase() === r.scope!.toLowerCase());
        if (!asset) {
          if (universe.length) throw new SpecError(r.line, `"for ${r.scope}:" names a ticker that is not in the universe`);
          return;
        }
        if (!own.has(asset.name)) own.set(asset.name, {});
        target = own.get(asset.name)!;
      }
      if (target[r.side]) throw new SpecError(r.line, `There is already a ${r.side} rule${r.scope ? ` for ${r.scope}` : ''}. Join conditions with "and" or "or"`);
      const last = r.toks.length ? r.toks[r.toks.length - 1].line : r.line;
      r.toks.push({ t: 'end', s: '', v: 0, line: last });
      target[r.side] = new ExprParser(r.toks, resolveAsset).parseCondition();
    });
  }

  const rules: Record<string, Rules> = {};
  for (const a of universe) {
    const buy = own.get(a.name)?.buy ?? shared.buy;
    const sell = own.get(a.name)?.sell ?? shared.sell ?? null;
    if (buy) rules[a.name] = { buy, sell };
    else if (errors.length === 0) errors.push({ line: 1, message: `There is no buy rule${universe.length > 1 ? ` for ${a.name}` : ''}. Add one, such as "buy when close > sma(200)"` });
  }

  const interval = get('interval', (v) => v.toLowerCase(), '1d');
  const sources = new Set([...universe, ...extras].map((a) => a.source));
  const intervalLine = settings.get('interval')?.line ?? 1;
  if (sources.has('yahoo') && !YAHOO_INTERVALS.includes(interval)) {
    errors.push({ line: intervalLine, message: `Yahoo data comes as 1d or 1w bars, not "${interval}"` });
  } else if (sources.has('binance') && !BINANCE_INTERVALS.includes(interval)) {
    errors.push({ line: intervalLine, message: `Binance intervals: ${BINANCE_INTERVALS.join(', ')}` });
  }

  const from = get('from', parseDate, null as number | null);
  const to = get('to', (v, l) => parseDate(v, l) + 86_400_000 - 1, null as number | null);
  if (from !== null && to !== null && to <= from) errors.push({ line: settings.get('to')!.line, message: '"to" is before "from"' });

  const spec: Spec = {
    name: get('name', (v) => v, null as string | null),
    universe,
    extras,
    benchmark: get('benchmark', (v, l) => parseRef(v, defaultSource, l), null as AssetRef | null),
    from,
    to,
    interval,
    capital: get('capital', parseCapital, 10_000),
    costBps: get('costs', parseCosts, 0),
    rebalance: get('rebalance', oneOf(REBALANCE, 'rebalance'), 'never' as Rebalance),
    stopLoss: get('stop loss', (v, l) => parsePercent(v, l, 'stop loss', 99), null as number | null),
    trailingStop: get('trailing stop', (v, l) => parsePercent(v, l, 'trailing stop', 99), null as number | null),
    takeProfit: get('take profit', (v, l) => parsePercent(v, l, 'take profit', 100000), null as number | null),
    rules,
  };

  errors.sort((a, b) => a.line - b.line);
  return { spec: errors.length ? null : spec, errors };
}
