// The trigger prices checked against the engine: for each price a report gives, the bar it assumes is added to the prices
// just inside and just outside it, the strategy is run again, and the ticker's order at the end must be there inside and
// gone outside.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec, type Spec } from '../src/dsl.ts';
import { STARTERS } from '../src/gallery.ts';
import { makeRng } from '../src/rng.ts';
import type { Bars } from '../src/types.ts';
import { DAY } from './helpers.ts';
import { head, signalFile, tally, valueSeries, verify, verifyPublished, walkBars } from './trigger-helpers.ts';

const parsed = (src: string): Spec => {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, [], src);
  return spec!;
};

test('the starters: each price a report gives makes the order inside it and not outside, at many points of their history', () => {
  const seen = tally();
  STARTERS.forEach((s, k) => {
    const spec = parsed(s.text);
    const names = [...new Set([...spec.universe, ...spec.extras, ...(spec.benchmark ? [spec.benchmark] : [])].map((a) => a.name))];
    const full = new Map(names.map((name, j) => [name, walkBars(900, 100 * k + j, { weekends: spec.universe.some((a) => a.source === 'binance') })]));
    for (let cut = 620; cut <= 900; cut += 7) {
      const data = new Map([...full].map(([name, b]) => [name, head(b, cut)]));
      verify(spec, data, `${s.title}, ${cut} bars`, seen);
    }
  });
  assert.ok(seen.buy >= 40 && seen.sell >= 40 && seen.add >= 4, JSON.stringify(seen));
});

/** A random strategy from parts of rules, settings and stops that the trigger prices treat differently. */
function randomStrategy(seed: number): string {
  const rng = makeRng(seed);
  const pick = <T,>(xs: T[]): T => xs[rng.int(xs.length)];
  const n = () => 5 + rng.int(30);
  const buys = [
    () => `close > sma(${n()})`,
    () => `close > ema(${n()})`,
    () => `rsi(${2 + rng.int(12)}) < ${20 + rng.int(40)}`,
    () => `close > highest(${n()})[1]`,
    () => `close crosses above sma(${n()})`,
    () => `zscore(${n()}) < -0.5`,
    () => `close > bb_upper(${n()}, 1)`,
    () => `close of B > sma(${n()}) of B`,
    () => `close > open`,
    () => `high > highest(${n()})[1]`,
    () => `close > sma(${n()}) and rsi(${2 + rng.int(12)}) < 70`,
    () => `close > vwap(${n()})`,
    () => `stoch_k(14, 3) < 40`,
    () => `close / close[5] > 1.01`,
    () => `bars_since(close < sma(${n()})) > 2`,
    () => `roc(${n()}) > 0 and close of B > close[1] of B`,
  ];
  const sells = [
    () => `close < sma(${n()})`,
    () => `rsi(${2 + rng.int(12)}) > ${50 + rng.int(40)}`,
    () => `close < entry price * 0.97 or bars held >= ${3 + rng.int(20)}`,
    () => `close crosses below ema(${n()})`,
    () => `close < lowest(${n()})[1]`,
    () => `close of B < sma(${n()}) of B`,
    () => `close < open`,
  ];
  const lines = ['universe: A', 'capital: 10000'];
  if (rng.next() < 0.5) lines.push('fill: close');
  if (rng.next() < 0.3) lines.push(`stop loss: ${3 + rng.int(6)}%`);
  if (rng.next() < 0.25) lines.push(`trailing stop: ${3 + rng.int(6)}%`);
  if (rng.next() < 0.25) lines.push(`take profit: ${4 + rng.int(8)}%`);
  const entries = rng.next() < 0.25;
  if (entries) lines.push('entries: 3');
  lines.push(`buy when ${pick(buys)()}`);
  if (rng.next() < 0.85) lines.push(`sell when ${pick(sells)()}`);
  if (entries) lines.push(`add when close > last entry price * ${(1 + rng.int(4) / 100).toFixed(2)}`);
  return lines.join('\n');
}

test('random strategies: each price a report gives makes the order inside it and not outside', () => {
  const seen = tally();
  const A = walkBars(700, 1);
  const B = walkBars(700, 2);
  for (let seed = 1; seed <= 160; seed++) {
    const src = randomStrategy(seed);
    const spec = parsed(src);
    const rng = makeRng(seed * 31);
    for (let k = 0; k < 6; k++) {
      const cut = 420 + rng.int(280);
      verify(spec, new Map([['A', head(A, cut)], ['B', head(B, cut)]]), `seed ${seed}, ${cut} bars:\n${src}\n`, seen);
    }
  }
  assert.ok(seen.buy >= 150 && seen.sell >= 120 && seen.add >= 25 && seen.rearm >= 8, JSON.stringify(seen));
});

/** The newer language in random strategies: definitions, ranges, windows, either-way crosses and the values since the entry. */
function newerStrategy(seed: number): string {
  const rng = makeRng(seed);
  const pick = <T,>(xs: T[]): T => xs[rng.int(xs.length)];
  const n = () => 5 + rng.int(25);
  const defs = [
    ['trend', () => `close > sma(${n()})`],
    ['calm', () => `stdev(${n()}) / close < ${(1 + rng.int(4)).toFixed(0)}%`],
    ['dip', () => `rsi(${2 + rng.int(6)}) < ${30 + rng.int(25)}`],
    ['gap', () => `close / sma(${n()}) - 1`],
  ] as const;
  const lines = ['universe: A', 'capital: 10000'];
  if (rng.next() < 0.5) lines.push('fill: close');
  if (rng.next() < 0.25) lines.push(`trailing stop: ${3 + rng.int(6)}%`);
  const made = defs.filter(() => rng.next() < 0.75);
  for (const [name, text] of made) lines.push(`${name} = ${text()}`);
  const has = (name: string) => made.some(([x]) => x === name);
  const buys = [
    () => (has('trend') ? `trend for ${2 + rng.int(3)} bars` : `close > sma(${n()}) for 2 bars`),
    () => (has('dip') ? `dip within ${2 + rng.int(3)} bars and ${has('trend') ? 'trend' : `close > sma(${n()})`}` : `rsi(3) < 40 within 3 bars`),
    () => `close between sma(${n()}) * 0.98 and sma(${n()}) * 1.02`,
    () => `close crosses sma(${n()})`,
    () => `rsi(${2 + rng.int(6)}) between ${10 + rng.int(20)} and ${40 + rng.int(30)}`,
    () => `count(close > open, ${4 + rng.int(4)}) >= ${2 + rng.int(3)}`,
    () => (has('gap') ? `gap < -${(1 + rng.int(3)).toFixed(0)}% and ${has('calm') ? 'calm' : 'close > open'}` : `close < sma(${n()}) * 0.97`),
  ];
  const sells = [
    () => `close < highest since entry - ${(1 + rng.int(3)).toFixed(0)} * atr(14)`,
    () => `position return > ${4 + rng.int(8)}% or position return < -${2 + rng.int(4)}%`,
    () => `close < highest since entry * 0.95 or bars held > ${5 + rng.int(20)}`,
    () => `close > lowest since entry * 1.08`,
    () => (has('trend') ? `not trend or position return > 6%` : `close < sma(${n()})`),
    () => `close crosses below sma(${n()})`,
  ];
  lines.push(`buy when ${pick(buys)()}`);
  lines.push(`sell when ${pick(sells)()}`);
  return lines.join('\n');
}

test('random strategies in the newer language: each price a report gives makes the order inside it and not outside', () => {
  const seen = tally();
  const A = walkBars(800, 3, { vol: 0.025 });
  for (let seed = 1; seed <= 90; seed++) {
    const src = newerStrategy(seed);
    const spec = parsed(src);
    const rng = makeRng(seed * 17);
    for (let k = 0; k < 5; k++) {
      const cut = 420 + rng.int(380);
      verify(spec, new Map([['A', head(A, cut)]]), `seed ${seed}, ${cut} bars:\n${src}\n`, seen);
    }
  }
  assert.ok(seen.buy >= 40 && seen.sell >= 40, JSON.stringify(seen));
});

/** `n` weekdays up to `end`, about `every` calendar days apart, with a value for each from `value`. */
function published(n: number, seed: number, every: number, value: (i: number, rng: ReturnType<typeof makeRng>) => number, end = Date.UTC(2026, 10, 13)): { t: number[]; v: number[] } {
  const rng = makeRng(seed);
  const t = new Set<number>();
  for (let d = end; t.size < n; d -= DAY * (every === 1 ? 1 : every - 2 + rng.int(5))) {
    const wd = new Date(d).getUTCDay();
    t.add(wd === 0 ? d - 2 * DAY : wd === 6 ? d - DAY : d);
  }
  return { t: [...t].sort((a, b) => a - b), v: Array.from({ length: n }, (_, i) => value(i, rng)) };
}

/** The rows of `b` dated by `at`. */
const until = (b: Bars, at: number): Bars => {
  const n = b.t.filter((x) => x <= at).length;
  return { ...b, ...head(b, n), ...(b.columns ? { columns: b.columns.map((c) => ({ ...c, v: c.v.slice(0, n) })) } : {}) };
};

test('a FRED series and a file of columns read with `of` have no row at the next bar unless one is published, as in the engine', () => {
  const seen = tally();
  const A = walkBars(700, 11);
  // A monthly series published on uneven days, as UNRATE is; a daily one; and a file of signals dated about weekly.
  const monthly = published(40, 12, 30, (_, rng) => 4 + Math.round(rng.next() * 6) / 10);
  const daily = published(700, 13, 1, (i, rng) => Math.round((Math.sin(i / 9) + rng.next() - 0.5) * 100) / 100);
  const weekly = published(140, 14, 7, (_, rng) => Math.round(rng.next() * 10) - 5);
  const full = new Map<string, Bars>([
    ['U', valueSeries(monthly.t, monthly.v)],
    ['D', valueSeries(daily.t, daily.v)],
    ['signals', signalFile(weekly.t, weekly.v)],
  ]);
  const rules = [
    'buy when close > sma(5) and close of fred:U < close[1] of fred:U\nsell when close < sma(5)',
    'buy when close > sma(10) and close of fred:D < sma(3) of fred:D\nsell when close < sma(10) or close of fred:D crosses above sma(5) of fred:D',
    'buy when close crosses above sma(8) and close of fred:D > close[1] of fred:D\nsell when close < sma(8)',
    'buy when close > sma(5) and column(score) of csv:Data/signals.csv < column(score)[1] of signals\nsell when close < sma(5) and column(score) of signals > 0',
  ];
  for (const fill of ['', 'fill: close\n']) {
    for (const rule of rules) {
      const spec = parsed(`universe: A\n${fill}${rule}`);
      for (let cut = 450; cut <= 700; cut += 10) {
        const a = head(A, cut);
        // Some cuts hold a value published on the day after the last bar, which the next bar reads.
        const data = new Map<string, Bars>([['A', a], ...[...full].map(([n, b]): [string, Bars] => [n, until(b, a.t[cut - 1] + (cut % 3) * DAY)])]);
        const label = `${fill}${rule}, ${cut} bars`;
        const report = verifyPublished(spec, data, label, seen);
        verify(spec, data, label, tally());
        for (const t of report.triggers) assert.equal(t.driver, 'A', label);
      }
    }
  }
  assert.ok(seen.buy >= 40 && seen.sell >= 30, JSON.stringify(seen));
});

test('rules solved for a FRED series: its next value is tried on an even scale around its last, below zero too, and each price agrees with the engine', () => {
  const seen = tally();
  const A = walkBars(500, 21);
  for (const seed of [22, 23, 24]) {
    // A daily spread that drifts below zero, dated by the weekday it came out.
    const rng = makeRng(seed);
    let x = 0.4;
    const F = valueSeries([...A.t], A.t.map(() => (x += (rng.next() - 0.53) * 0.06)));
    const rules = [
      'buy when close of fred:F > sma(5) of fred:F\nsell when close of fred:F < sma(5) of fred:F',
      'buy when close of fred:F > 0\nsell when close of fred:F < -0.1',
      'buy when close of fred:F crosses above sma(10) of fred:F\nsell when close of fred:F crosses below sma(3) of fred:F',
      'fill: close\nbuy when close of fred:F > sma(5) of fred:F and close[1] > sma(20)[1]\nsell when close of fred:F < sma(8) of fred:F',
    ];
    for (const rule of rules) {
      const spec = parsed(`universe: A\n${rule}`);
      for (let cut = 300; cut <= 500; cut += 8) {
        const a = head(A, cut);
        // Some cuts end the series a day or two before the ticker's last bar, as a value published late does.
        const data = new Map<string, Bars>([['A', a], ['F', until(F, a.t[cut - 1] - (cut % 3) * DAY)]]);
        const label = `seed ${seed}, ${cut} bars:\n${rule}\n`;
        const report = verifyPublished(spec, data, label, seen);
        verify(spec, data, label, tally());
        for (const t of report.triggers.filter((t) => !t.blocked && !t.noRule)) {
          // Read a bar early with fill: close, a value of the day before the next bar is the last that bar can read,
          // so a series already holding it has no next value to try.
          if (spec.fill === 'close' && data.get('F')!.t.at(-1)! >= report.next - DAY) {
            assert.deepEqual([t.driver, t.values], ['A', undefined], label);
            continue;
          }
          assert.deepEqual([t.driver, t.values], ['F', true], label);
          assert.ok(t.range.lo < t.last && t.last < t.range.hi, JSON.stringify(t));
        }
      }
    }
  }
  assert.ok(seen.buy >= 60 && seen.sell >= 40, JSON.stringify(seen));
});

/** A random strategy that goes short: short only, or long and short with flips between them, from parts the trigger prices treat differently. */
function randomShortStrategy(seed: number): string {
  const rng = makeRng(seed);
  const pick = <T,>(xs: T[]): T => xs[rng.int(xs.length)];
  const n = () => 5 + rng.int(30);
  const shorts = [
    () => `close < sma(${n()})`,
    () => `close < ema(${n()})`,
    () => `rsi(${2 + rng.int(12)}) > ${50 + rng.int(40)}`,
    () => `close < lowest(${n()})[1]`,
    () => `close crosses below sma(${n()})`,
    () => `zscore(${n()}) > 0.5`,
    () => `close of B < sma(${n()}) of B`,
    () => `close < open`,
    () => `close / close[5] < 0.99`,
  ];
  const covers = [
    () => `close > sma(${n()})`,
    () => `rsi(${2 + rng.int(12)}) < ${20 + rng.int(40)}`,
    () => `close > entry price * 1.03 or bars held >= ${3 + rng.int(20)}`,
    () => `close crosses above ema(${n()})`,
    () => `close > highest(${n()})[1]`,
    () => `close of B > sma(${n()}) of B`,
  ];
  const buys = [() => `close > sma(${n()})`, () => `rsi(${2 + rng.int(12)}) < ${20 + rng.int(40)}`, () => `close > highest(${n()})[1]`, () => `close crosses above sma(${n()})`, () => `close of B > close[1] of B`];
  const sells = [() => `close < sma(${n()})`, () => `close < entry price * 0.97 or bars held >= ${3 + rng.int(20)}`, () => `rsi(${2 + rng.int(12)}) > ${50 + rng.int(40)}`];
  // Some hold 150% of the equity on whichever side they are, borrowing the rest.
  const lines = [`universe: A${rng.next() < 0.25 ? ' 150%' : ''}`, 'capital: 10000'];
  if (rng.next() < 0.5) lines.push('fill: close');
  if (rng.next() < 0.3) lines.push(`stop loss: ${3 + rng.int(6)}%`);
  if (rng.next() < 0.25) lines.push(`trailing stop: ${3 + rng.int(6)}%`);
  if (rng.next() < 0.25) lines.push(`take profit: ${4 + rng.int(8)}%`);
  const entries = rng.next() < 0.25;
  if (entries) lines.push('entries: 3');
  // A trend that flips on one average; otherwise each side's rules drawn on their own, or short rules only.
  const kind = rng.next();
  if (kind < 0.3) {
    const k = n();
    lines.push(`buy when close > sma(${k})`, `short when close < sma(${k})`);
  } else {
    if (kind < 0.75) lines.push(`buy when ${pick(buys)()}`);
    if (kind < 0.75 && rng.next() < 0.6) lines.push(`sell when ${pick(sells)()}`);
    lines.push(`short when ${pick(shorts)()}`);
  }
  if (rng.next() < 0.7) lines.push(`cover when ${pick(covers)()}`);
  if (entries) lines.push(`add when close < last entry price * ${(1 - rng.int(4) / 100).toFixed(2)}`);
  return lines.join('\n');
}

test('strategies that go short: each price for a short, a cover and a flip makes the order inside it and not outside, with both fills', () => {
  const seen = tally();
  const A = walkBars(700, 31);
  const B = walkBars(700, 32);
  const fills = { close: 0, open: 0 };
  for (let seed = 1; seed <= 160; seed++) {
    const src = randomShortStrategy(seed);
    const spec = parsed(src);
    fills[spec.fill === 'close' ? 'close' : 'open']++;
    const rng = makeRng(seed * 37);
    for (let k = 0; k < 6; k++) {
      const cut = 420 + rng.int(280);
      verify(spec, new Map([['A', head(A, cut)], ['B', head(B, cut)]]), `seed ${seed}, ${cut} bars:\n${src}\n`, seen);
    }
  }
  assert.ok(fills.close >= 50 && fills.open >= 50, JSON.stringify(fills));
  assert.ok(seen.short >= 250 && seen.cover >= 150 && seen.buy >= 120 && seen.sell >= 150 && seen.flip >= 200 && seen.add >= 40 && seen.rearmShort >= 4, JSON.stringify(seen));
});
