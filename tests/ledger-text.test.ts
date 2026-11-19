import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { addTrial, addVersion, defaultsHash, emptyLedger, Ledgers, mergeLedgers, parseLedger, resetTrials, trialOf, versionHash, type Ledger } from '../src/ledger.ts';
import { deflatedSharpe, excessReturns, normCdf, stepSharpe, stepsPerYear, type Pbo } from '../src/overfit.ts';
import { renderTriesNote, triesNote, triesOf, triesWords, upperBound, type Tries } from '../src/render-luck.ts';
import { pboWords } from '../src/render-sweep.ts';
import { changeText, figuresText, localStamp, versionRows } from '../src/render-versions.ts';
import { JsonStore } from '../src/store.ts';
import { bars, DAY } from './helpers.ts';

const T0 = Date.UTC(2026, 10, 17, 9, 30);

function shown(src = 'universe: A\nbuy when close > sma(20)\nsell when close < sma(20)'): Backtest {
  const closes: number[] = [];
  const times: number[] = [];
  let c = 100;
  for (let t = Date.UTC(2016, 0, 1); t <= Date.UTC(2020, 11, 31); t += DAY) {
    if (times.length) c *= 1 + 0.012 * Math.sin(t / DAY / 9) + 0.0006;
    closes.push(c);
    times.push(t);
  }
  return runBacktest(parseSpec(src).spec!, new Map([['A', bars(closes, { times })]]));
}

test('one try: SR0 is 0, so the chance is the probability that the Sharpe ratio is above 0', () => {
  const bt = shown();
  const own = trialOf(bt.spec, bt)!;
  const l = addTrial(emptyLedger(), own.hash, own.sharpe, own.perYear, T0);
  const t = triesOf(l, bt);
  const shape = stepSharpe(excessReturns(bt.run.equity, bt.run.cashReturn))!;
  assert.equal(t.n, 1);
  assert.equal(t.since, T0);
  assert.equal(t.deflated!.sr0, 0);
  assert.equal(t.deflated!.dsr, normCdf((shape.sharpe * Math.sqrt(shape.steps - 1)) / Math.sqrt(1 - shape.skew * shape.sharpe + ((shape.kurt - 1) / 4) * shape.sharpe ** 2)));
  assert.match(triesWords(t), /^The plugin counted only the run shown since 2026-11-17\. Thus no correction for other tries is necessary\. .* shows an edge is (approximately \d+%|more than 99%)\. /);
  assert.equal(triesNote(t), null);
});

test('many tries raise the bar: SR0 and the chance come from the spread of their Sharpe ratios a year', () => {
  const bt = shown();
  let l = emptyLedger();
  const own = trialOf(bt.spec, bt)!;
  l = addTrial(l, own.hash, own.sharpe, own.perYear, T0);
  // Other tries, one on weekly bars: they compare through their figures a year.
  for (const [i, sharpe] of [0.2, -0.4, 1.1, 0.6].entries()) l = addTrial(l, `x${i}`, sharpe, i === 0 ? 52 : 252, T0 + i);
  const t = triesOf(l, bt);
  const perYear = stepsPerYear(bt.run.t);
  const srs = [own.sharpe, 0.2, -0.4, 1.1, 0.6].map((s) => s / Math.sqrt(perYear));
  const mean = srs.reduce((a, x) => a + x, 0) / 5;
  const variance = srs.reduce((a, x) => a + (x - mean) ** 2, 0) / 4;
  const expected = deflatedSharpe(stepSharpe(excessReturns(bt.run.equity, bt.run.cashReturn))!, 5, variance)!;
  assert.equal(t.n, 5);
  assert.ok(Math.abs(t.deflated!.dsr - expected.dsr) < 1e-12);
  assert.ok(Math.abs(t.deflated!.bar - expected.sr0 * Math.sqrt(perYear)) < 1e-12);
  assert.ok(t.deflated!.sr0 > 0);
  const words = triesWords(t);
  assert.match(words, /^The plugin counted 5 tries of this block since 2026-11-17\. If there is no edge, the best of 5 tries of this type usually has a Sharpe ratio of approximately \d\.\d\d\. The run shown has /);
  assert.match(words, /and not luck in the selection of the best try, is (approximately \d+%|more than 99%|less than 1%)\. /);
  assert.match(triesNote(t)!, /^The plugin counted 5 tries of this block to date\. After a correction for them, the probability that this Sharpe ratio shows an edge is .*\. See "How many tries" in "Was it luck\?"\.$/);
  assert.equal(upperBound(1200), '1,200 is the maximum number of different tries. Variants that are near each other give almost the same results. Thus the number of different tries is smaller, and the probability above is possibly too low.');
});

test('the count starts at its reset, and the verdict follows the chance', () => {
  const base: Tries = { n: 3, since: new Date(2026, 0, 2, 12).getTime(), sharpe: 1.234, deflated: { sr0: 0.05, dsr: 0.97, bar: 0.8 }, why: null };
  assert.match(triesWords(base), /since 2026-01-02\. .*Sharpe ratio of approximately 0\.80\. The run shown has 1\.23\. .* is approximately 97%\. This is a strong sign of an edge, for these tries\.$/);
  assert.match(triesWords({ ...base, deflated: { sr0: 0.05, dsr: 0.6, bar: 0.8 } }), /is approximately 60%\. This is not a strong sign: the result can be luck\.$/);
  assert.match(triesWords({ ...base, deflated: { sr0: 0.05, dsr: 0.2, bar: 0.8 } }), /is approximately 20%\. The probability of luck is higher than the probability of an edge\.$/);
  assert.match(triesWords({ ...base, deflated: { sr0: 0.05, dsr: 0.999, bar: 0.8 } }), /is more than 99%\./);
  assert.match(triesWords({ ...base, deflated: { sr0: 0.05, dsr: 0.001, bar: -0.8 } }), /approximately −0\.80\. .* is less than 1%\./);
  const bt = shown();
  const own = trialOf(bt.spec, bt)!;
  const l = addTrial(resetTrials(addTrial(emptyLedger(), 'old', 2, 252, 1), T0), own.hash, own.sharpe, own.perYear, T0 + 5);
  const t = triesOf(l, bt);
  assert.deepEqual([t.n, t.since], [1, T0]);
});

test('the chance can\'t be told for a run that never traded, never moved, or has no margin of error', () => {
  const idle = shown('universe: A\nbuy when false');
  const t = triesOf(addTrial(emptyLedger(), 'a1', 1, 252, T0), idle);
  assert.equal(t.why, 'no trades');
  assert.equal(triesWords(t), 'The plugin counted 1 try of this block since 2026-11-17. The run shown made no trades. Thus the count does not include it, and it has no Sharpe ratio to examine.');
  const none: Tries = { n: 0, since: null, sharpe: NaN, deflated: null, why: 'flat' };
  assert.equal(triesWords(none), 'The plugin counted 0 tries of this block. The returns of the run shown are almost the same as the returns of cash. Thus it has no Sharpe ratio to examine.');
  assert.match(triesWords({ ...none, why: 'shape' }), /The plugin cannot calculate this\. The returns of the run are too skewed or heavy-tailed/);
  assert.match(triesWords({ ...none, why: 'short' }), /does not have sufficient bars/);
  assert.equal(triesNote({ ...none, n: 4 }), 'The plugin counted 4 tries of this block to date. See "How many tries" in "Was it luck?".');
});

const check = (o: Partial<Pbo>): Pbo => ({ pbo: 0.3, short: null, variants: 40, leftOut: 0, steps: 1260, groups: 16, splits: 12_870, ...o });

test('the overfitting check in words: the share, what it means, and that one sweep\'s figure swings', () => {
  const words = pboWords(check({}));
  assert.match(words, /^The plugin cut the history into 16 parts, and divided them into two halves in all 12,870 possible combinations\. In 30% of them, the variant with the best Sharpe ratio on one half ranked in the bottom half on the other half\. A variant at the middle position counts as half\. /);
  assert.match(words, /frequently did not stay good/);
  assert.match(words, /Bailey, Borwein, López de Prado and Zhu/);
  assert.match(words, /changes much from one sweep to the next/);
  assert.match(pboWords(check({ pbo: 0.05 })), /usually stayed good/);
  assert.match(pboWords(check({ pbo: 0.5 })), /On the half that it did not see, the best variant did not do better than a random selection/);
  assert.match(pboWords(check({ leftOut: 2 })), /The plugin did not include 2 variants that ran on a different number of bars\.$/);
  assert.match(pboWords(check({ leftOut: 1 })), /The plugin did not include 1 variant that ran on a different number of bars\.$/);
});

test('the overfitting check says what it lacks when it can\'t be told', () => {
  assert.equal(pboWords(check({ pbo: null, short: 'variants', variants: 3 })), 'This check must have a minimum of 5 variants that traded. This sweep has 3.');
  assert.equal(
    pboWords(check({ pbo: null, short: 'steps', steps: 250, groups: 16 })),
    'This check must have a minimum of 20 bars in each of the 16 parts of the history, 320 in total. These runs have 250.',
  );
});

const version = (text: string, at: number, figures = { cagr: 0.1, maxDrawdown: -0.2, sharpe: 0.9, trades: 10 }, defaults: unknown = {}): Ledger =>
  addVersion(emptyLedger(), { text, defaults, at, figures });

test('versions are listed newest first, each against the one before, with this version marked', () => {
  let l = version('universe: SPY\nfast = 50\nbuy when close > sma(fast)', T0);
  l = addVersion(l, { text: 'universe: SPY\nfast = 60\nbuy when close > sma(fast)', defaults: {}, at: T0 + 60_000, figures: { cagr: 0.123, maxDrawdown: -0.15, sharpe: 1.05, trades: 8 } });
  l = addVersion(l, { text: 'universe: SPY\nfast = 60\nbuy when close > sma(fast)', defaults: { capital: 5 }, at: T0 + 120_000, figures: { cagr: 0.123, maxDrawdown: -0.15, sharpe: 1.05, trades: 8 } });
  const rows = versionRows(l.versions, { hash: versionHash('universe: SPY\nfast = 60\nbuy when close > sma(fast)', {}), defaults: defaultsHash({}) });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.current), [false, true, false]);
  assert.deepEqual(rows.map((r) => r.otherDefaults), [true, false, false]);
  assert.equal(rows[1].figures, '12.3% a year, worst drawdown −15.0%, Sharpe ratio 1.05, 8 trades');
  assert.equal(rows[1].change, '1 line added, 1 line removed, return a year +2.3 points, Sharpe ratio +0.15');
  assert.equal(rows[0].change, 'the same text with different default settings, return a year unchanged, Sharpe ratio unchanged');
  assert.equal(rows[2].change, null);
  assert.equal(rows[2].previous, null);
  assert.equal(rows[1].previous, l.versions[0]);
  assert.equal(rows[2].when, localStamp(T0));
});

test('a fall and figures that were not numbers read plainly', () => {
  const before = version('a', 1, { cagr: 0.1, maxDrawdown: -0.2, sharpe: 1, trades: 10 }).versions[0];
  const after = version('a\nb\nc', 2, { cagr: 0.05, maxDrawdown: -0.3, sharpe: 0.4, trades: 1 }).versions[0];
  assert.equal(changeText(before, after), '2 lines added, return a year −5.0 points, Sharpe ratio −0.60');
  const unknown = version('a', 3, { cagr: NaN, maxDrawdown: NaN, sharpe: NaN, trades: 0 }).versions[0];
  assert.equal(figuresText(unknown.figures), '– a year, worst drawdown –, Sharpe ratio –, 0 trades');
  assert.equal(changeText(after, unknown), '2 lines removed');
});

test('a version\'s time is on the reader\'s clock, to the minute', () => {
  const d = new Date(T0);
  const two = (n: number) => String(n).padStart(2, '0');
  assert.equal(localStamp(T0), `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`);
  assert.match(localStamp(T0), /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
});

test('the day the count began is the reader\'s day, late at night and early in the morning', () => {
  const bt = shown();
  const own = trialOf(bt.spec, bt)!;
  for (const at of [new Date(2026, 10, 17, 23, 30).getTime(), new Date(2026, 10, 17, 0, 30).getTime()]) {
    const t = triesOf(addTrial(emptyLedger(), own.hash, own.sharpe, own.perYear, at), bt);
    assert.match(triesWords(t), /^The plugin counted only the run shown since 2026-11-17\./);
  }
});

test('a line drawn while the try it shows is still being counted ends with that try counted', async () => {
  const bt = shown();
  const own = trialOf(bt.spec, bt)!;
  // A slider settling: its try starts to be counted, and its result is drawn a few moments later.
  for (let ticks = 0; ticks < 6; ticks++) {
    const files = new Map<string, string>();
    const store = new JsonStore<Ledger>({
      files: {
        exists: async (p) => files.has(p) || p === 'ledger',
        read: async (p) => files.get(p)!,
        write: async (p, text) => void files.set(p, text),
        mkdir: async () => undefined,
        remove: async (p) => void files.delete(p),
        list: async () => ({ files: [...files.keys()] }),
      },
      dir: 'ledger',
      parse: parseLedger,
      merge: mergeLedgers,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    const block = new Ledgers(store, () => T0).forBlock('Note.md\u0000name:x');
    await block.add([own, { ...own, hash: 'second' }]);
    const adding = block.add([{ ...own, hash: 'third' }]);
    for (let i = 0; i < ticks; i++) await Promise.resolve();
    const el = { textContent: '' } as HTMLElement;
    const stop = renderTriesNote(el, block, bt);
    await adding;
    await new Promise((r) => setTimeout(r, 0));
    stop();
    assert.match(el.textContent ?? '', /^The plugin counted 3 tries of this block to date\./, `drawn ${ticks} ticks after the try`);
  }
});
