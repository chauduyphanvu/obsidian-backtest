// The added functions as the language offers them: how they are written, typed and read, which history they need,
// and how correl reads another ticker.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { INDICATORS, parseSpec, type Expr } from '../src/dsl.ts';
import { Evaluator, specEvaluator } from '../src/evaluate.ts';
import { complete } from '../src/complete.ts';
import { docFor, shortOf } from '../src/docs.ts';
import { explainTrade } from '../src/explain.ts';
import { tokenize } from '../src/highlight.ts';
import * as ind from '../src/indicators.ts';
import { lookbackBars } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY, near, T0 } from './helpers.ts';

const NEW = [
  'stoch_k', 'stoch_d', 'adx', 'plus_di', 'minus_di', 'cci', 'williams_r', 'mfi', 'obv', 'vwap', 'keltner_upper', 'keltner_lower',
  'supertrend', 'supertrend_up', 'wma', 'hma', 'median', 'zscore', 'percent_rank', 'slope', 'correl', 'bars_since',
];

const problems = (rule: string, extra = '') => parseSpec(`universe: A\n${extra}buy when true\nsell when ${rule}`).errors.map((e) => e.message);
const failure = (rule: string, extra = '') => parseSpec(`universe: A\n${extra}buy when ${rule}`).errors.map((e) => e.message)[0];
const expr = (text: string, extra = ''): Expr => {
  const { spec, errors } = parseSpec(`universe: A\n${extra}buy when ${text}`);
  assert.deepEqual(errors, [], text);
  return spec!.rules.A.buy;
};
const num = (text: string): Expr => (expr(`${text} > -1e9`.replace('1e9', '1000000000')) as Extract<Expr, { k: 'cmp' }>).a;

test('the table lists every function this file knows about', () => {
  for (const name of NEW) assert.ok(name in INDICATORS, name);
});

// ---------------------------------------------------------------- how they are written

test('numbers have defaults where the usual setting is standard, and are whole periods', () => {
  const args = (text: string) => (num(text) as Extract<Expr, { k: 'ind' }>).args;
  assert.deepEqual(args('stoch_k()'), [14, 3]);
  assert.deepEqual(args('stoch_k(10)'), [10, 3]);
  assert.deepEqual(args('stoch_d()'), [14, 3, 3]);
  assert.deepEqual(args('stoch_d(5, 1, 2)'), [5, 1, 2]);
  assert.deepEqual(args('adx()'), [14]);
  assert.deepEqual(args('cci()'), [20]);
  assert.deepEqual(args('williams_r()'), [14]);
  assert.deepEqual(args('mfi()'), [14]);
  assert.deepEqual(args('vwap()'), [20]);
  assert.deepEqual(args('keltner_upper()'), [20, 2, 10]);
  assert.deepEqual(args('keltner_lower(30, 1.5)'), [30, 1.5, 10]);
  assert.deepEqual(args('supertrend()'), [10, 3]);
  assert.deepEqual(args('supertrend(7, 2.5)'), [7, 2.5]);
  assert.deepEqual(args('obv()'), []);
  assert.deepEqual(args('wma(20)'), [20]);
  assert.deepEqual(args('correl(close of SPY, 60)'), [60]);
});

test('a series can come first where a function reads one, and the others take none', () => {
  assert.equal((num('zscore(volume, 20)') as Extract<Expr, { k: 'ind' }>).src!.k, 'series');
  assert.equal((num('hma(rsi(14), 21)') as Extract<Expr, { k: 'ind' }>).src!.k, 'ind');
  assert.equal((num('keltner_upper(volume, 20, 2, 10)') as Extract<Expr, { k: 'ind' }>).args.length, 3);
  assert.equal((num('stoch_k(14)') as Extract<Expr, { k: 'ind' }>).src, null);
  assert.equal(failure('adx(close) > 25'), 'adx() periods must be plain numbers');
  assert.equal(failure('mfi(volume) > 25'), 'mfi() periods must be plain numbers');
});

test('wrong numbers of arguments and lengths out of range are refused in plain words', () => {
  assert.equal(failure('adx(14, 3) > 25'), 'adx() takes at most 1 number');
  assert.equal(failure('stoch_d(14, 3, 3, 2) > 25'), 'stoch_d() takes at most 3 numbers');
  assert.equal(failure('obv(5) > 0'), 'obv() takes no arguments');
  assert.equal(failure('wma() > 0'), 'wma() needs a period, as in wma(20)');
  assert.equal(failure('slope() > 0'), 'slope() needs a period, as in slope(20)');
  assert.equal(failure('adx(0) > 25'), 'adx(): 0 is not a valid period. Use a whole number from 1 to 10000');
  assert.equal(failure('adx(1.5) > 25'), 'adx(): 1.5 is not a valid period. Use a whole number from 1 to 10000');
  assert.equal(failure('adx(10001) > 25'), 'adx(): 10001 is not a valid period. Use a whole number from 1 to 10000');
  assert.equal(failure('stoch_k(14, 0) > 25'), 'stoch_k(): 0 is not a valid period. Use a whole number from 1 to 10000');
  assert.equal(failure('keltner_upper(20, 2, 0) > 25'), 'keltner_upper(): 0 is not a valid period. Use a whole number from 1 to 10000');
  assert.equal(failure('keltner_upper(20, 0) > 25'), 'keltner_upper(): 0 is not a valid band width');
  assert.equal(failure('supertrend(10, 0) > 25'), 'supertrend(): 0 is not a valid multiplier');
  // These need at least two bars: a line, a spread or a correlation through one value says nothing.
  for (const name of ['slope', 'zscore', 'cci', 'hma']) assert.equal(failure(`${name}(1) > 0`), `${name}(): 1 is not a valid period. Use a whole number from 2 to 10000`);
  assert.equal(failure('correl(close of SPY, 1) > 0'), 'correl(): 1 is not a valid period. Use a whole number from 2 to 10000');
  // A length of 1 is fine where it means something.
  for (const name of ['adx', 'plus_di', 'minus_di', 'williams_r', 'mfi', 'vwap', 'wma', 'median', 'percent_rank']) assert.deepEqual(parseSpec(`universe: A\nbuy when ${name}(1) > 0`).errors, [], name);
});

test('correl needs the other ticker\'s series first, and bars_since a condition', () => {
  assert.equal(failure('correl() > 0'), "correl() needs the other ticker's series first, as in correl(close of SPY, 60)");
  assert.equal(failure('correl(60) > 0'), "correl() needs the other ticker's series first, as in correl(close of SPY, 60)");
  assert.equal(failure('correl(close of SPY) > 0'), 'correl() needs a period, as in correl(close of SPY, 20)');
  assert.equal(failure('correl(close > 1, 20) > 0'), 'correl() needs a number, not a condition');
  assert.equal(failure('bars_since() > 0'), 'bars_since() takes one condition, as in bars_since(close crosses above sma(50))');
  assert.equal(failure('bars_since(close > 1, 2) > 0'), 'bars_since() takes one condition, as in bars_since(close crosses above sma(50))');
  assert.equal(failure('bars_since(close) > 0'), 'bars_since() needs a condition, not a number, as in bars_since(close crosses above sma(50))');
  assert.match(problems('bars_since(bars held > 3) > 0')[0], /"bars held" can't go inside bars_since\(\)/);
  assert.deepEqual(problems('bars_since(close crosses above sma(50)) < 10'), []);
});

test('supertrend_up is a condition and supertrend a number', () => {
  assert.deepEqual(parseSpec('universe: A\nbuy when supertrend_up(10, 3)').errors, []);
  assert.deepEqual(parseSpec('universe: A\nbuy when supertrend_up() and not close < sma(5)\nsell when not supertrend_up()').errors, []);
  assert.match(failure('supertrend(10, 3)'), /A rule needs a condition/);
  assert.match(failure('supertrend_up(10, 3) > 0'), /A comparison needs a number, not a condition/);
  assert.deepEqual(parseSpec('universe: A\nbuy when close > supertrend(10, 3)').errors, []);
  // Every other function is a number.
  for (const name of NEW.filter((n) => n !== 'supertrend_up')) {
    const { lead, params } = INDICATORS[name];
    const numbers = params.map((d) => d ?? 20).join(', ');
    const call = lead === 'series' ? `${name}(close of SPY, ${numbers})` : lead === 'condition' ? `${name}(close > 1)` : `${name}(${numbers})`;
    assert.match(failure(call), /A rule needs a condition/, name);
  }
});

test('parameters stand in for periods and multipliers, and a range at the top counts for the history', () => {
  const block = 'n = 20 in 10..60 step 10\nmult = 2.5 in 1..4 step 0.5\nwide = 30\nbuy when close > keltner_upper(n, mult, 14) and stoch_k(wide, 3) > 20\n';
  const { spec, errors } = parseSpec(`universe: A\n${block}`);
  assert.deepEqual(errors, []);
  const e = spec!.rules.A.buy as Extract<Expr, { k: 'logic' }>;
  const keltner = (e.a as Extract<Expr, { k: 'cmp' }>).b as Extract<Expr, { k: 'ind' }>;
  assert.deepEqual(keltner.args, [20, 2.5, 14]);
  assert.deepEqual(keltner.params, ['n', 'mult', null]);
  assert.equal(parseSpec(`universe: A\nmult = 2.5\nbuy when close > supertrend(10, mult)`).errors.length, 0);
  // The widest period counts: n goes to 60, so the average needs 5 * 60 bars.
  assert.equal(lookbackBars(spec!), 5 * 60);
});

test('a parameter cannot be named like a function', () => {
  for (const name of NEW) {
    const { errors } = parseSpec(`universe: A\n${name} = 5\nbuy when true`);
    assert.match(errors[0]?.message ?? '', /is a built-in name/, name);
  }
});

// ---------------------------------------------------------------- how they are read

/** Bars with a trend, noise, and volume that moves. */
function market(len: number, seed = 3, volume = true, bias = 0.46): Bars {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let px = 100;
  for (let i = 0; i < len; i++) {
    const open = px * (1 + (u() - 0.5) * 0.004);
    const close = open * (1 + (u() - bias) * 0.03);
    out.t.push(T0 + i * DAY);
    out.o.push(open);
    out.c.push(close);
    out.h.push(Math.max(open, close) * (1 + u() * 0.01));
    out.l.push(Math.min(open, close) * (1 - u() * 0.01));
    out.v.push(volume ? Math.round(1e6 * (0.5 + u())) : 0);
    px = close;
  }
  return out;
}

const values = (text: string, data: Record<string, Bars>, extra = ''): number[] => {
  const { spec, errors } = parseSpec(`universe: A\n${extra}buy when ${text}`);
  assert.deepEqual(errors, [], text);
  const e = spec!.rules.A.buy;
  return new Evaluator(new Map(Object.entries(data))).eval(e.k === 'cmp' ? e.a : e, 'A');
};

test('each function reads the ticker\'s own bars and gives the array its indicator gives', () => {
  const m = market(400);
  const A = { A: m };
  const at = (text: string) => values(`${text} > -1000000000`, A);
  assert.deepEqual(at('stoch_k(14, 3)'), ind.stochK(m.h, m.l, m.c, 14, 3));
  assert.deepEqual(at('stoch_d(14, 3, 3)'), ind.stochD(m.h, m.l, m.c, 14, 3, 3));
  assert.deepEqual(at('adx(14)'), ind.adx(m.h, m.l, m.c, 14));
  assert.deepEqual(at('plus_di(14)'), ind.plusDi(m.h, m.l, m.c, 14));
  assert.deepEqual(at('minus_di(14)'), ind.minusDi(m.h, m.l, m.c, 14));
  assert.deepEqual(at('cci(20)'), ind.cci(m.h, m.l, m.c, 20));
  assert.deepEqual(at('williams_r(14)'), ind.williamsR(m.h, m.l, m.c, 14));
  assert.deepEqual(at('mfi(14)'), ind.mfi(m.h, m.l, m.c, m.v, 14));
  assert.deepEqual(at('obv()'), ind.obv(m.c, m.v));
  assert.deepEqual(at('vwap(20)'), ind.vwap(m.h, m.l, m.c, m.v, 20));
  assert.deepEqual(at('supertrend(10, 3)'), ind.supertrend(m.h, m.l, m.c, 10, 3).line);
  assert.deepEqual(values('supertrend_up(10, 3)', A), ind.supertrend(m.h, m.l, m.c, 10, 3).up);
  assert.deepEqual(at('wma(20)'), ind.wma(m.c, 20));
  assert.deepEqual(at('hma(21)'), ind.hma(m.c, 21));
  assert.deepEqual(at('median(20)'), ind.median(m.c, 20));
  assert.deepEqual(at('zscore(20)'), ind.zscore(m.c, 20));
  assert.deepEqual(at('percent_rank(100)'), ind.percentRank(m.c, 100));
  assert.deepEqual(at('slope(50)'), ind.slope(m.c, 50));
  // A series first replaces close: here the volume.
  assert.deepEqual(at('wma(volume, 20)'), ind.wma(m.v, 20));
  assert.deepEqual(at('zscore(rsi(14), 30)'), ind.zscore(ind.rsi(m.c, 14), 30));
});

test('keltner is the exponential average plus or minus a multiple of the average true range', () => {
  const m = market(300);
  const A = { A: m };
  const upper = values('keltner_upper(20, 2.5, 10) > 0', A);
  const lower = values('keltner_lower(20, 2.5, 10) > 0', A);
  const byHand = (sign: number) => ind.ema(m.c, 20).map((x, i) => x + sign * 2.5 * ind.atr(m.h, m.l, m.c, 10)[i]);
  assert.deepEqual(upper, byHand(1));
  assert.deepEqual(lower, byHand(-1));
  // The same numbers as writing it out with the first twelve functions.
  assert.deepEqual(upper, values('ema(20) + 2.5 * atr(10) > 0', A));
  // Hand-worked: closes 9 10 11 14 15, true ranges 2 2 2 4 3, ema(3) 10 12 13.5 from index 2, atr(2) 2 2 3 3 from index 1.
  // Upper (3, 2, 2): 10 + 2 * 2 = 14, 12 + 2 * 3 = 18, 13.5 + 2 * 3 = 19.5; lower 6, 6, 7.5.
  const small = bars([9, 10, 11, 14, 15], { highs: [10, 11, 12, 15, 16], lows: [8, 9, 10, 12, 13] });
  assert.deepEqual(values('keltner_upper(3, 2, 2) > 0', { A: small }), [NaN, NaN, 14, 18, 19.5]);
  assert.deepEqual(values('keltner_lower(3, 2, 2) > 0', { A: small }), [NaN, NaN, 6, 6, 7.5]);
});

test('a rule that uses a function that is still unknown never fires', () => {
  const m = market(120);
  const { spec } = parseSpec('universe: A\nbuy when percent_rank(60) >= 0 and bars_since(close > 0) >= 0');
  const bt = runBacktest(spec!, new Map([['A', m]]));
  // percent_rank(60) first has a value at index 60, so the signal is first read at the close of that bar and fills at the next open.
  assert.equal(bt.run.trades[0].entryT, m.t[61]);
  const none = runBacktest(parseSpec('universe: A\nbuy when correl(close of B, 500) > -2').spec!, new Map([['A', m], ['B', market(120, 4)]]));
  assert.equal(none.run.trades.length, 0);
});

test('bars_since reads a condition: crosses, comparisons and the rest', () => {
  const b = bars([1, 2, 3, 4, 3, 2, 3, 4]);
  // close crosses above 2.5 on the bars valued 3 (index 2 and 6).
  assert.deepEqual(values('bars_since(close crosses above 2.5) >= 0', { A: b }), [NaN, NaN, 0, 1, 2, 3, 0, 1]);
  assert.deepEqual(values('bars_since(close > 3.5 and close[1] < 3.5) < 5', { A: b }), [NaN, NaN, NaN, 0, 1, 2, 3, 0].map((x, i) => (i === 7 ? 0 : x)).map((x, i) => (i === 3 ? 0 : x)));
});

test('volume functions say so when the prices have none', () => {
  const none = market(60, 3, false);
  for (const call of ['mfi(14)', 'obv()', 'vwap(20)']) {
    const name = call.split('(')[0];
    assert.throws(() => values(`${call} > 0`, { A: none }), new RegExp(`^Error: A has no volume, which ${name}\\(\\) needs`), call);
  }
  // Another ticker's prices are checked the same way, and named.
  assert.throws(() => values('mfi(14) of IDX > 0', { A: market(60), IDX: none }), /IDX has no volume/);
  // The run itself stops with that message, rather than never buying.
  const { spec } = parseSpec('universe: A\nbuy when obv() > sma(obv(), 5)');
  assert.throws(() => runBacktest(spec!, new Map([['A', none]])), /A has no volume, which obv\(\) needs/);
  // Prices with a little volume are fine, and the others never ask for it.
  const some = { ...none, v: none.v.map((_, i) => (i === 30 ? 5 : 0)) };
  assert.doesNotThrow(() => values('obv() > 0', { A: some }));
  assert.doesNotThrow(() => values('adx(14) > 0', { A: none }));
});

test('no function reads a later bar, through the evaluator and across other tickers', () => {
  const [a, b] = [market(300, 8), market(300, 9)];
  const texts = [
    'stoch_k(14, 3)', 'adx(14)', 'cci(20)', 'mfi(14)', 'obv()', 'vwap(20)', 'keltner_upper(20, 2, 10)', 'supertrend(10, 3)', 'supertrend_up(10, 3)',
    'wma(20)', 'hma(21)', 'median(20)', 'zscore(20)', 'percent_rank(50)', 'slope(30)', 'correl(close of B, 30)', 'correl(rsi(5) of B, 30)',
    'bars_since(close crosses above sma(20))', 'zscore(correl(close of B, 20), 10)',
  ];
  const cut = (x: Bars, k: number): Bars => ({ t: x.t.slice(0, k), o: x.o.slice(0, k), h: x.h.slice(0, k), l: x.l.slice(0, k), c: x.c.slice(0, k), v: x.v.slice(0, k) });
  for (const text of texts) {
    const body = text.startsWith('supertrend_up') ? text : `${text} > -1000000000`;
    const { spec, errors } = parseSpec(`universe: A\nbuy when ${body}`);
    assert.deepEqual(errors, [], text);
    const e = spec!.rules.A.buy;
    const whole = new Evaluator(new Map([['A', a], ['B', b]])).eval(e.k === 'cmp' ? e.a : e, 'A');
    for (const k of [1, 2, 5, 21, 30, 59, 60, 61, 120, 299]) {
      const part = new Evaluator(new Map([['A', cut(a, k)], ['B', cut(b, k)]])).eval(e.k === 'cmp' ? e.a : e, 'A');
      assert.deepEqual(part, whole.slice(0, k), `${text}: the first ${k} values depend on later bars`);
    }
  }
});

// ---------------------------------------------------------------- correl reads another ticker as "of" does

const weekdays = (from: number, count: number): number[] => {
  const out: number[] = [];
  for (let t = from; out.length < count; t += DAY) if (![0, 6].includes(new Date(t).getUTCDay())) out.push(t);
  return out;
};
const everyDay = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i * DAY);
const level = (times: number[], f: (i: number) => number): Bars => bars(times.map((_, i) => f(i)), { times });

test('correl lines the other ticker up with this one\'s bars exactly as of does', () => {
  // A stock on weekdays and a coin every day, 60 days from Wednesday 1 January 2020.
  const stock = level(weekdays(Date.UTC(2020, 0, 1), 40), (i) => 100 + 3 * Math.sin(i / 3) + i * 0.2);
  const coin = level(everyDay(Date.UTC(2020, 0, 1), 60), (i) => 50 + 4 * Math.cos(i / 4) + i * 0.1);
  const data = new Map([['STK', stock], ['binance:CRY', coin]]);
  const run = (source: string) => {
    const { spec, errors } = parseSpec(source);
    assert.deepEqual(errors, [], source);
    return { spec: spec!, ev: specEvaluator(spec!, new Map([['STK', stock], ['CRY', coin]])) };
  };
  void data;
  for (const fill of ['', 'fill: close\n']) {
    const { spec, ev } = run(`universe: STK\n${fill}buy when correl(close of binance:CRY, 8) > -2`);
    const e = spec.rules.STK.buy as Extract<Expr, { k: 'cmp' }>;
    const read = ev.eval({ k: 'of', a: { k: 'series', name: 'close' }, asset: 'CRY' }, 'STK');
    // The plain close of CRY as the rule reads it, bar for bar: the correlation is of that array and STK's closes, which
    // with fill: close are taken a bar early too, as the coin is.
    assert.deepEqual(ev.eval(e.a, 'STK'), ind.correl(fill ? ind.lag(stock.c, 1) : stock.c, read, 8));
    // Bar 10 of the stock is Wednesday 15 January; the coin's bar it reads is that day's, or with fill: close the day before's.
    const k = ev.barOf('CRY', 'STK', 10);
    assert.equal(coin.t[k], stock.t[10] - (fill ? DAY : 0), fill || 'next open');
  }
  // The two readings differ, since the coin is read a bar earlier with fill: close.
  const [open, close] = [run('universe: STK\nbuy when correl(close of binance:CRY, 8) > -2'), run('universe: STK\nfill: close\nbuy when correl(close of binance:CRY, 8) > -2')];
  const get = (r: ReturnType<typeof run>) => r.ev.eval((r.spec.rules.STK.buy as Extract<Expr, { k: 'cmp' }>).a, 'STK');
  assert.notDeepEqual(get(open), get(close));
});

test('correl pairs the two changes of the same days, with either fill: an identical series correlates at 1', () => {
  // The same prices from a CSV file keep other hours than the stock only because the source differs.
  const stock = level(weekdays(Date.UTC(2020, 0, 1), 300), (i) => 100 * Math.exp(0.02 * Math.sin(i * 1.7) + 0.01 * Math.cos(i * 0.31)));
  const twin = { ...stock, t: [...stock.t] };
  for (const fill of ['', 'fill: close\n']) {
    const { spec } = parseSpec(`universe: STK\n${fill}buy when correl(close of csv:Data/twin.csv, 30) > 0.9`);
    const ev = specEvaluator(spec!, new Map([['STK', stock], ['twin', twin]]));
    const v = ev.eval((spec!.rules.STK.buy as Extract<Expr, { k: 'cmp' }>).a, 'STK').filter((x) => !Number.isNaN(x));
    assert.ok(v.length > 200 && v.every((x) => near(x, 1, 1e-9)), `${fill || 'next open'}: ${Math.min(...v)}`);
  }
});

test('correl worked by hand: the changes of days 2 to 4 at the close of day 4, or of days 1 to 3 with fill: close', () => {
  // A's changes on days 1 to 4 are 1%, 2%, -1% and 3%; B's are 2%, 1%, -2% and 1%.
  const days = everyDay(Date.UTC(2020, 0, 1), 5);
  const path = (changes: number[], start: number) => changes.reduce((xs, r) => [...xs, xs[xs.length - 1] * (1 + r)], [start]);
  const A = bars(path([0.01, 0.02, -0.01, 0.03], 100), { times: days });
  const B = bars(path([0.02, 0.01, -0.02, 0.01], 50), { times: days });
  const last = (fill: string) => {
    const { spec } = parseSpec(`universe: binance:A\n${fill}buy when correl(close of csv:Data/B.csv, 3) > 0`);
    const ev = specEvaluator(spec!, new Map([['A', A], ['B', B]]));
    return ev.eval((spec!.rules.A.buy as Extract<Expr, { k: 'cmp' }>).a, 'A')[4];
  };
  // Days 2 to 4: A's deviations from their mean are 2, -7 and 5 three-hundredths, B's 1, -2 and 1 hundredths.
  assert.ok(near(last(''), 21 / Math.sqrt(78 * 6), 1e-12), String(last('')));
  // With fill: close B is read a day early, so the pairs are days 1 to 3: deviations 1, 4, -5 and 5, 2, -7 three-hundredths.
  assert.ok(near(last('fill: close\n'), 48 / Math.sqrt(42 * 78), 1e-12), String(last('fill: close\n')));
});

test('correl on a day the other ticker had no new bar sees a change of 0, and an explanation says which bar was read', () => {
  // The coin trades every day; a rule on the stock reads it on the stock's own days. A weekend is one stock step: the coin's
  // change over it is 3 days of change, as a stock bar on Monday reads Monday's coin bar.
  const stock = level(weekdays(Date.UTC(2020, 0, 1), 30), (i) => 100 + (i % 7) * 2);
  const coin = level(everyDay(Date.UTC(2020, 0, 1), 45), (i) => 50 + (i % 5) * 3);
  const { spec } = parseSpec('universe: STK\nbuy when correl(close of binance:CRY, 6) > 0.1');
  const bt = runBacktest(spec!, new Map([['STK', stock], ['CRY', coin]]));
  assert.ok(bt.run.trades.length > 0);
  const rows = explainTrade(bt, bt.run.trades[0]).sections.find((s) => s.id === 'bought')!.rows;
  const rule = rows.find((r) => r.code && r.label.includes('correl'));
  assert.ok(rule, rows.map((r) => r.label).join('\n'));
  assert.match(rule.value, /read from CRY's bar of 2020-01-/);
  assert.match(rule.value, /correl\(close of binance:CRY, 6\) -?[0-9.]+ > 0\.1/);
});

// ---------------------------------------------------------------- the history a run needs

const lookback = (rule: string, extra = '') => {
  const { spec, errors } = parseSpec(`universe: A\n${extra}buy when ${rule}`);
  assert.deepEqual(errors, [], rule);
  return lookbackBars(spec!);
};

test('lookbackBars covers each function: its window, and the settling of the ones that start from where they began', () => {
  // The run keeps at least 250 bars, so these use periods that need more.
  assert.equal(lookback('stoch_k(300, 5) > 0'), 305);
  assert.equal(lookback('stoch_d(300, 5, 7) > 0'), 312);
  assert.equal(lookback('williams_r(300) > 0'), 300);
  assert.equal(lookback('cci(300) > 0'), 300);
  assert.equal(lookback('mfi(300) > 0'), 301);
  assert.equal(lookback('vwap(300) > 0'), 300);
  assert.equal(lookback('wma(300) > 0'), 300);
  assert.equal(lookback('hma(400) > 0'), 420);
  assert.equal(lookback('median(300) > 0'), 300);
  assert.equal(lookback('zscore(300) > 0'), 300);
  assert.equal(lookback('percent_rank(300) > 0'), 301);
  assert.equal(lookback('slope(300) > 0'), 300);
  assert.equal(lookback('correl(close of SPY, 300) > 0'), 301);
  // With fill: close this ticker's closes may be taken a bar early, to pair with another clock's.
  assert.equal(lookback('correl(close of SPY, 300) > 0', 'fill: close\n'), 302);
  assert.equal(lookback('obv() > 0'), 250);
  // Recursive: Wilder's and the exponential averages count five times their period, adx twice that (it smooths a smoothed value).
  assert.equal(lookback('plus_di(60) > 0'), 301);
  assert.equal(lookback('minus_di(60) > 0'), 301);
  assert.equal(lookback('adx(60) > 0'), 601);
  assert.equal(lookback('supertrend(60, 3) > 0'), 301);
  assert.equal(lookback('supertrend_up(60, 3)'), 301);
  assert.equal(lookback('keltner_upper(100, 2, 60) > 0'), 500);
  assert.equal(lookback('keltner_lower(20, 2, 100) > 0'), 501);
  // The condition's own history, and 250 bars before it for the last bar it held.
  assert.equal(lookback('bars_since(close crosses above sma(100)) < 5'), 101 + 250 + 0);
});

test('lookbackBars nests: a series that needs history adds to the function that reads it', () => {
  assert.equal(lookback('sma(zscore(100), 200) > 0'), 300);
  assert.equal(lookback('zscore(sma(close, 100), 200) > 0'), 300);
  assert.equal(lookback('wma(ema(close, 100), 20) > 0'), 520);
  assert.equal(lookback('hma(rsi(60), 100) > 0'), 100 + 301 + 10);
  assert.equal(lookback('correl(sma(close, 100) of SPY, 300) > 0'), 401);
  assert.equal(lookback('zscore(300) > 0 and close[20] > 0'), 300);
  assert.equal(lookback('bars_since(adx(60) > 25) < 10'), 601 + 250);
});

test('lookbackBars counts a parameter with a range at the top of its range, for every function', () => {
  const p = (name: string, rule: string, range: string) => lookback(rule, `${name} = ${range.split('..')[0].split(' in ')[0]} in ${range.split(' in ')[1]}\n`);
  assert.equal(p('n', 'zscore(n) > 0', '20 in 20..300 step 40'), 300);
  assert.equal(p('n', 'adx(n) > 0', '14 in 10..70 step 10'), 1 + 10 * 70);
  assert.equal(p('n', 'supertrend_up(n, 3)', '14 in 10..90 step 10'), 1 + 5 * 90);
  assert.equal(p('n', 'stoch_k(n, 3) > 0', '14 in 10..300 step 10'), 303);
  assert.equal(p('n', 'keltner_upper(20, 2, n) > 0', '14 in 10..80 step 10'), 1 + 5 * 80);
  assert.equal(p('n', 'hma(n) > 0', '16 in 16..400 step 16'), 400 + 20);
  assert.equal(p('n', 'bars_since(close crosses above sma(n)) < 5', '20 in 20..300 step 40'), 301 + 250);
  // A multiplier is not a length: it adds nothing.
  assert.equal(p('m', 'supertrend_up(10, m)', '3 in 1..5 step 1'), 250);
});

test('each function is known, and settled, from the first bar of a run that has the history lookbackBars asks for', () => {
  const full = market(7000, 21);
  const other = market(7000, 22);
  const cut = (x: Bars, from: number): Bars => ({ t: x.t.slice(from), o: x.o.slice(from), h: x.h.slice(from), l: x.l.slice(from), c: x.c.slice(from), v: x.v.slice(from) });
  // [expression, how far from the full-history value it may be, relative, when run from the lookback: 0 for the windowed ones, which depend on nothing before their window, and about what Wilder's smoothing leaves after five periods for the others]
  const cases: [string, number][] = [
    ['stoch_d(300, 5, 7)', 0], ['williams_r(300)', 0], ['cci(300)', 0], ['mfi(300)', 0], ['vwap(300)', 0], ['wma(300)', 0], ['hma(400)', 0],
    ['median(300)', 0], ['zscore(300)', 0], ['percent_rank(300)', 0], ['slope(300)', 0], ['correl(close of B, 300)', 0],
    ['plus_di(60)', 0.02], ['minus_di(60)', 0.02], ['adx(60)', 0.02], ['keltner_upper(100, 2, 60)', 0.005], ['keltner_lower(20, 2, 100)', 0.005],
    ['supertrend(60, 3)', 0.005],
  ];
  const starts = [2500, 3300, 4100, 5200, 6100];
  for (const [text, tol] of cases) {
    const { spec, errors } = parseSpec(`universe: A\nbuy when ${text} > -1000000000`);
    assert.deepEqual(errors, [], text);
    const lb = lookbackBars(spec!);
    const e = (spec!.rules.A.buy as Extract<Expr, { k: 'cmp' }>).a;
    const all = new Evaluator(new Map([['A', full], ['B', other]])).eval(e, 'A');
    for (const s of starts) {
      const part = new Evaluator(new Map([['A', cut(full, s - lb)], ['B', cut(other, s - lb)]])).eval(e, 'A');
      const [got, want] = [part[lb], all[s]];
      assert.ok(!Number.isNaN(got), `${text}: unknown at the first bar of a run starting at bar ${s} with ${lb} bars before it`);
      assert.ok(Math.abs(got - want) <= (tol === 0 ? 1e-9 : tol) * Math.max(1, Math.abs(want)), `${text}: ${got} with ${lb} bars of history, ${want} with all of it, at bar ${s}`);
    }
  }
});

test('bars_since and supertrend_up are known and right at the first bar of a run when their condition has held within the history', () => {
  const full = market(7000, 31, true, 0.5);
  const cut = (x: Bars, from: number): Bars => ({ t: x.t.slice(from), o: x.o.slice(from), h: x.h.slice(from), l: x.l.slice(from), c: x.c.slice(from), v: x.v.slice(from) });
  for (const text of ['bars_since(close crosses above sma(100))', 'supertrend_up(60, 3)']) {
    const { spec } = parseSpec(`universe: A\nbuy when ${text}${text.startsWith('bars') ? ' >= 0' : ''}`);
    const lb = lookbackBars(spec!);
    const e0 = spec!.rules.A.buy;
    const e = e0.k === 'cmp' ? e0.a : e0;
    const all = new Evaluator(new Map([['A', full]])).eval(e, 'A');
    let known = 0;
    let agree = 0;
    const starts = Array.from({ length: 40 }, (_, k) => 1500 + k * 130);
    for (const s of starts) {
      const part = new Evaluator(new Map([['A', cut(full, s - lb)]])).eval(e, 'A')[lb];
      if (!Number.isNaN(part)) {
        known++;
        // Known means exact: the count since the last cross, or the trend, as a run with all the history would give it.
        if (part === all[s]) agree++;
      }
    }
    assert.equal(known, starts.length, `${text}: unknown at the first bar of some runs`);
    assert.ok(agree >= starts.length - 2, `${text}: ${agree} of ${starts.length} runs agree with the full history`);
  }
});

test('an INDICATORS entry that needs high, low or volume says nothing about a series, and the others do', () => {
  for (const name of ['stoch_k', 'adx', 'cci', 'williams_r', 'mfi', 'obv', 'vwap', 'supertrend', 'supertrend_up', 'bars_since']) assert.equal(INDICATORS[name].src, null, name);
  for (const name of ['wma', 'hma', 'median', 'zscore', 'percent_rank', 'slope', 'keltner_upper', 'correl']) assert.equal(INDICATORS[name].src, 'close', name);
});

// ---------------------------------------------------------------- how they look in the editor and in an explanation

test('every function is coloured as a function, in a rule and where a score is written', () => {
  for (const name of NEW) {
    const line = `buy when ${name}(10) > ${name}(5)`;
    const kinds = tokenize(line, 'rule').map((t) => [line.slice(t.from, t.to), t.kind]);
    assert.deepEqual(kinds.filter(([text]) => text === name).map(([, kind]) => kind), ['function', 'function'], name);
  }
  const rule = 'buy when bars_since(close crosses above sma(50)) < 10 and stoch_k() > stoch_d() and correl(close of SPY, 60) < 0.3';
  const word = (text: string) => tokenize(rule, 'rule').filter((t) => rule.slice(t.from, t.to) === text).map((t) => t.kind);
  assert.deepEqual(['bars_since', 'sma', 'stoch_k', 'stoch_d', 'correl'].map((w) => word(w)[0]), ['function', 'function', 'function', 'function', 'function']);
  assert.deepEqual([word('close')[0], word('SPY')[0], word('crosses')[0], word('of')[0]], ['series', 'ticker', 'keyword', 'keyword']);
  // A parameter whose name starts like a function is still a parameter.
  const named = tokenize('buy when slope_n > 3', 'rule', ['slope_n']).map((t) => t.kind);
  assert.deepEqual(named, ['keyword', 'keyword', 'param', 'operator', 'number']);
  assert.ok(tokenize('hold: top 2 by zscore(20)', 'setting').some((t) => t.kind === 'function'));
});

test('every function completes, with its signature and what it does', () => {
  for (const name of NEW) {
    const found = complete([], [], `buy when ${name.slice(0, 3)}`)!.items.find((i) => i.label === name);
    assert.ok(found, name);
    assert.equal(found.insert, `${name}(`);
    assert.equal(found.detail, `${docFor(name)!.signature} · ${shortOf(name)}`);
  }
  assert.equal(docFor('correl')!.signature, 'correl(other, n)');
  assert.equal(docFor('bars_since')!.signature, 'bars_since(condition)');
  assert.equal(docFor('stoch_d')!.signature, 'stoch_d(n = 14, smooth = 3, d = 3)');
  assert.equal(docFor('keltner_upper')!.signature, 'keltner_upper(n = 20, width = 2, atr = 10)');
  assert.equal(docFor('obv')!.signature, 'obv()');
});

test('the help for a function says whether it reads a series, needs volume, or needs the other ticker', () => {
  for (const name of ['mfi', 'obv', 'vwap']) assert.match(docFor(name)!.text, /no series and needs volume/, name);
  assert.match(docFor('correl')!.text, /reads close for this ticker; the series written first is read as of reads it/);
  assert.match(docFor('bars_since')!.text, /no series, only a condition/);
  assert.match(docFor('keltner_upper')!.text, /read from the ticker’s own bars/);
});

test('an explanation labels each function with its value, and a trend by its direction and line', () => {
  const m = market(300, 41);
  const { spec } = parseSpec('universe: A\nbuy when supertrend_up(5, 1) and adx(5) > 0 and bars_since(close > open) < 3 and zscore(10) > -3 and cci(10) > -300\nsell when not supertrend_up(5, 1)');
  const bt = runBacktest(spec!, new Map([['A', m]]));
  assert.ok(bt.run.trades.length > 0);
  const rows = explainTrade(bt, bt.run.trades[0]).sections.find((s) => s.id === 'bought')!.rows.filter((r) => r.code);
  const byLabel = (text: string) => rows.find((r) => r.label === text)!;
  assert.match(byLabel('supertrend_up(5, 1)').value, /^uptrend, the line is at [0-9]+\.[0-9]{2}$/);
  assert.equal(byLabel('supertrend_up(5, 1)').outcome, 'yes');
  assert.match(byLabel('adx(5) > 0').value, /^adx\(5\) [0-9.]+ > 0$/);
  assert.match(byLabel('bars_since(close > open) < 3').value, /^bars_since\(close > open\) [012] < 3$/);
  assert.match(byLabel('zscore(10) > -3').value, /^zscore\(10\) [−0-9.]+ > -3$/);
  assert.match(byLabel('cci(10) > -300').value, /^cci\(10\) [−0-9.]+ > -300$/);
});
