import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignCurves, combine, correlations, parseCompare, type Curve } from '../src/compare.ts';
import { spreadLabels } from '../src/render-compare.ts';
import { near } from './helpers.ts';

const entry = (link: string, block: string | null, label: string | null, weight: number | null, line: number) => ({ link, block, label, weight, line });

test('parses wikilinks, bare paths, names and labels', () => {
  const { entries, errors } = parseCompare(['[[Trend following]]', '[[Research/Three sleeves]]', '[[Pullbacks#QQQ RSI pullback|QQQ dips]]', 'Research/Old.md#Second one', 'Plain.md'].join('\n'));
  assert.deepEqual(errors, []);
  assert.deepEqual(entries, [
    entry('Trend following', null, null, null, 1),
    entry('Research/Three sleeves', null, null, null, 2),
    entry('Pullbacks', 'QQQ RSI pullback', 'QQQ dips', null, 3),
    entry('Research/Old.md', 'Second one', null, null, 4),
    entry('Plain.md', null, null, null, 5),
  ]);
});

test('parses weights as fractions, in every form a line can take', () => {
  const { entries, errors } = parseCompare(
    ['[[Trend following]] 40%', '[[Pullbacks#QQQ RSI pullback]]   20 %', 'Research/Old.md#Second one 12.5%', 'Plain.md 5%'].join('\n'),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(entries.map((e) => [e.link, e.block, e.weight]), [
    ['Trend following', null, 0.4],
    ['Pullbacks', 'QQQ RSI pullback', 0.2],
    ['Research/Old.md', 'Second one', 0.125],
    ['Plain.md', null, 0.05],
  ]);
});

test('comments, blank lines and Windows line ends are skipped, and line numbers count them', () => {
  const { entries, errors } = parseCompare('# Compare\r\n\r\n[[A]]\r\n   # indented comment\r\n[[B]]\r\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(entries.map((e) => [e.link, e.line]), [['A', 3], ['B', 5]]);
});

test('the strategy name keeps its case, and a # inside an alias belongs to the alias', () => {
  const { entries, errors } = parseCompare('[[A#Mixed Case]]\n[[B|Tag #1]]');
  assert.deepEqual(errors, []);
  assert.deepEqual(entries, [entry('A', 'Mixed Case', null, null, 1), entry('B', null, 'Tag #1', null, 2)]);
});

test('a line that is neither a link nor a path to a note is an error with its line and the weight position', () => {
  const r = parseCompare('[[A]]\nSPY\n[[B]]');
  assert.deepEqual(r.errors, [{ line: 2, message: 'Write a note as [[Note name]] or [[Note name#Strategy name]], or as a vault path ending in .md' }]);
  assert.deepEqual(r.entries.map((e) => e.link), ['A', 'B']);
});

test('link errors: no closing brackets, no note, nothing after #', () => {
  assert.deepEqual(parseCompare('[[A]]\n[[B').errors, [{ line: 2, message: 'This link has no closing ]]' }]);
  assert.deepEqual(parseCompare('[[A]]\n[[#Name]]').errors, [{ line: 2, message: "This link doesn't name a note" }]);
  assert.deepEqual(parseCompare('[[A]]\n[[B#]]').errors, [{ line: 2, message: 'Nothing follows # in this link: name the strategy, or remove the #' }]);
  assert.deepEqual(parseCompare('[[A]]\nB.md#').errors, [{ line: 2, message: 'Nothing follows # in this link: name the strategy, or remove the #' }]);
});

test('weight errors point at the weight', () => {
  const zero = parseCompare('[[A]] 0%\n[[B]] 50%');
  assert.deepEqual(zero.errors, [{ line: 1, message: 'A weight must be above 0%', from: 6, to: 8 }]);
  const negative = parseCompare('[[A]] 50%\n[[B]] -5%');
  assert.deepEqual(negative.errors, [{ line: 2, message: 'A weight must be above 0%', from: 6, to: 9 }]);
  const word = parseCompare('[[A]] half\n[[B]]');
  assert.deepEqual(word.errors, [{ line: 1, message: 'After the note, only a weight such as 40% can follow', from: 6, to: 10 }]);
  // The same weight problem on a bare path.
  assert.deepEqual(parseCompare('A.md 0%\n[[B]] 50%').errors, [{ line: 1, message: 'A weight must be above 0%', from: 5, to: 7 }]);
});

test('a block needs 2 to 8 strategies', () => {
  assert.deepEqual(parseCompare('').errors, [{ line: 1, message: 'Add at least 2 strategies to compare' }]);
  assert.deepEqual(parseCompare('# only a comment\n[[A]]').errors, [{ line: 2, message: 'Add at least 2 strategies to compare' }]);
  const eight = Array.from({ length: 8 }, (_, i) => `[[N${i}]]`);
  assert.deepEqual(parseCompare(eight.join('\n')).errors, []);
  const nine = parseCompare([...eight, '[[N8]]'].join('\n'));
  assert.deepEqual(nine.errors, [{ line: 9, message: 'A comparison holds at most 8 strategies' }]);
  assert.equal(nine.entries.length, 9);
});

test('every strategy has a weight or none does', () => {
  assert.deepEqual(parseCompare('[[A]] 50%\n[[B]]').errors, [{ line: 2, message: 'Give every strategy a weight, or none of them' }]);
  assert.deepEqual(parseCompare('[[A]]\n[[B]]\n[[C]] 10%').errors, [{ line: 3, message: 'Give every strategy a weight, or none of them' }]);
  assert.deepEqual(parseCompare('[[A]] 50%\n[[B]] 50%').errors, []);
});

test('weights may add up to 100% but not more, with no rounding trouble', () => {
  assert.deepEqual(parseCompare('[[A]] 60%\n[[B]] 40%').errors, []);
  assert.deepEqual(parseCompare('[[A]] 70%\n[[B]] 20%\n[[C]] 10%').errors, []);
  assert.deepEqual(parseCompare('[[A]] 33.3%\n[[B]] 33.3%\n[[C]] 33.4%').errors, []);
  assert.deepEqual(parseCompare('[[A]] 60%\n[[B]] 40.5%').errors, [{ line: 2, message: "The weights add up to 100.5%, and they can't add up to more than 100%" }]);
});

test('listing the same strategy twice is an error, however it is spelled', () => {
  assert.deepEqual(parseCompare('[[A]]\n[[B]]\n[[a.md]]').errors, [{ line: 3, message: 'This strategy is already listed on line 1' }]);
  assert.deepEqual(parseCompare('[[A#One]]\n[[B]]\nA.md#one').errors, [{ line: 3, message: 'This strategy is already listed on line 1' }]);
  // A different strategy block of the same note is fine, and so is the first block next to a named one.
  assert.deepEqual(parseCompare('[[A#One]]\n[[A#Two]]\n[[A]]').errors, []);
});

test('errors come in line order, and a failed line does not also report a missing strategy', () => {
  const r = parseCompare('[[A]] 70%\n???\n[[B]] 40%');
  assert.deepEqual(r.errors.map((e) => e.line), [2, 3]);
  assert.equal(r.entries.length, 2);
});

// --- Alignment -----------------------------------------------------------------------------------------------------

const day = (n: number) => Date.UTC(2020, 0, n);
const curve = (label: string, days: number[], equity: number[]): Curve => ({ label, t: days.map(day), equity });

test('curves are put on the union of their times between the latest start and the earliest end', () => {
  const a = curve('A', [1, 2, 3, 4, 5], [100, 110, 120, 130, 140]);
  const b = curve('B', [2, 4, 6], [50, 60, 90]);
  const r = alignCurves([a, b]);
  // The window is day 2 to day 5. B has no point on day 3 or 5, so it carries its last value.
  assert.deepEqual(r.t, [day(2), day(3), day(4), day(5)]);
  const [ra, rb] = r.series;
  [1, 120 / 110, 130 / 110, 140 / 110].forEach((v, i) => assert.ok(near(ra[i], v), `A[${i}]`));
  [1, 1, 1.2, 1.2].forEach((v, i) => assert.ok(near(rb[i], v), `B[${i}]`));
});

test('every aligned curve starts at 1, whatever its own scale', () => {
  const r = alignCurves([curve('A', [1, 2, 3], [10_000, 12_000, 9_000]), curve('B', [1, 2, 3], [0.5, 0.25, 1])]);
  assert.deepEqual(r.t, [day(1), day(2), day(3)]);
  assert.deepEqual(r.series[0], [1, 1.2, 0.9]);
  assert.deepEqual(r.series[1], [1, 0.5, 2]);
});

test('a curve that starts before the window is carried to its first time and rebased there', () => {
  const r = alignCurves([curve('A', [1, 5, 9], [10, 20, 40]), curve('B', [3, 7, 9], [1, 2, 4])]);
  // Window day 3 to 9. A's value on day 3 is its day-1 value, 10.
  assert.deepEqual(r.t, [day(3), day(5), day(7), day(9)]);
  assert.deepEqual(r.series[0], [1, 2, 2, 4]);
  assert.deepEqual(r.series[1], [1, 1, 2, 4]);
});

test('three curves align to the latest start and the earliest end of all of them', () => {
  const r = alignCurves([curve('A', [1, 4, 8], [1, 2, 3]), curve('B', [2, 4, 9], [1, 1, 1]), curve('C', [3, 5, 7], [2, 4, 8])]);
  assert.deepEqual(r.t, [day(3), day(4), day(5), day(7)]);
  assert.equal(r.series.length, 3);
  assert.ok(r.series.every((s) => s[0] === 1 && s.length === 4));
});

test('curves that never overlap, or meet on one date only, are an error that names them', () => {
  assert.throws(() => alignCurves([curve('Early', [1, 2, 3], [1, 2, 3]), curve('Late', [5, 6, 7], [1, 2, 3])]), /Late starts on 2020-01-05, after Early ends on 2020-01-03/);
  assert.throws(() => alignCurves([curve('Early', [1, 2, 3], [1, 2, 3]), curve('Late', [3, 4, 5], [1, 2, 3])]), /single date, 2020-01-03/);
  assert.throws(() => alignCurves([]), /no strategies/);
  assert.throws(() => alignCurves([curve('A', [1, 2], [1, 2]), curve('Empty', [], [])]), /Empty has no prices/);
});

// --- Combining -----------------------------------------------------------------------------------------------------

test('with no month boundary the sleeves drift', () => {
  const aligned = { t: [day(1), day(2), day(3)], series: [[1, 1.1, 1.21], [1, 0.9, 0.81]] };
  const v = combine(aligned, [0.5, 0.5]);
  // 0.5 * 1.1 + 0.5 * 0.9 = 1; 0.5 * 1.21 + 0.5 * 0.81 = 1.01.
  [1, 1, 1.01].forEach((x, i) => assert.ok(near(v[i], x), `v[${i}]: ${v[i]}`));
});

test('at the first point of a new month the portfolio goes back to its weights', () => {
  // Jan 30, Jan 31, Feb 1, Feb 2. A doubles on Jan 31 and doubles again on Feb 2; B stays flat.
  const t = [Date.UTC(2020, 0, 30), Date.UTC(2020, 0, 31), Date.UTC(2020, 1, 1), Date.UTC(2020, 1, 2)];
  const aligned = { t, series: [[1, 2, 2, 4], [1, 1, 1, 1]] };
  const v = combine(aligned, [0.5, 0.5]);
  // Jan 31: 1 + 0.5 = 1.5. Feb 1 is worth 1.5 and is reset to 0.75 and 0.75. Feb 2: 1.5 + 0.75 = 2.25 (2.5 without the reset).
  [1, 1.5, 1.5, 2.25].forEach((x, i) => assert.ok(near(v[i], x), `v[${i}]: ${v[i]}`));
  const drift = combine({ t: [day(1), day(2), day(3), day(4)], series: aligned.series }, [0.5, 0.5]);
  assert.ok(near(drift[3], 2.5));
});

test('the reset happens at the first point of each month, even when it comes days into the month', () => {
  // Jan 31, Feb 3 (first point of February), Feb 4, Mar 2 (first point of March), Mar 3.
  const t = [Date.UTC(2020, 0, 31), Date.UTC(2020, 1, 3), Date.UTC(2020, 1, 4), Date.UTC(2020, 2, 2), Date.UTC(2020, 2, 3)];
  const aligned = { t, series: [[1, 1, 2, 2, 2], [1, 1, 1, 0.5, 1]] };
  const v = combine(aligned, [0.5, 0.5]);
  // Feb 3: 1, reset to 0.5 / 0.5. Feb 4: A 1, B 0.5 = 1.5. Mar 2: A 1, B 0.25 = 1.25, reset to 0.625 each.
  // Mar 3: A 0.625, B 0.625 * 2 = 1.25 = 1.875.
  [1, 1, 1.5, 1.25, 1.875].forEach((x, i) => assert.ok(near(v[i], x), `v[${i}]: ${v[i]}`));
});

test('weights below 100% leave the rest in cash that earns nothing, and stays a share of the whole when it resets', () => {
  const aligned = { t: [day(1), day(2)], series: [[1, 2], [1, 1]] };
  // 0.5 * 2 + 0.25 * 1 + 0.25 cash = 1.5
  assert.ok(near(combine(aligned, [0.5, 0.25])[1], 1.5));
  // Across a month boundary the cash share is restored as well: 0.25 of 1.5 is 0.375 afterwards.
  const t = [Date.UTC(2020, 0, 31), Date.UTC(2020, 1, 3), Date.UTC(2020, 1, 4)];
  const v = combine({ t, series: [[1, 2, 2], [1, 1, 1]] }, [0.5, 0.25]);
  // Feb 3: 1.5, reset to A 0.75, B 0.375, cash 0.375. Feb 4: nothing moves.
  assert.ok(near(v[1], 1.5) && near(v[2], 1.5));
  const next = combine({ t: [...t, Date.UTC(2020, 1, 5)], series: [[1, 2, 2, 4], [1, 1, 1, 1]] }, [0.5, 0.25]);
  assert.ok(near(next[3], 0.75 * 2 + 0.375 + 0.375));
});

test('all in one curve gives that curve', () => {
  const aligned = { t: [day(1), day(2), day(3)], series: [[1, 1.5, 0.75], [1, 2, 3]] };
  const v = combine(aligned, [1, 0]);
  [1, 1.5, 0.75].forEach((x, i) => assert.ok(near(v[i], x)));
});

test('weights above 100% in total, negative weights and a wrong count are rejected', () => {
  const aligned = { t: [day(1), day(2)], series: [[1, 2], [1, 1]] };
  assert.throws(() => combine(aligned, [0.6, 0.5]), /cannot add up to more than 100%/);
  assert.throws(() => combine(aligned, [1.2, -0.2]), /negative/);
  assert.throws(() => combine(aligned, [1]), /one weight for each curve/);
});

// --- Correlation ---------------------------------------------------------------------------------------------------

/** A series that starts at 1 and takes each simple return in turn. */
const fromReturns = (r: number[]) => r.reduce((s, x) => [...s, s[s.length - 1] * (1 + x)], [1]);
const T = [day(1), day(2), day(3), day(4), day(5)];

test('identical series correlate at 1, and one that does the opposite at -1', () => {
  const up = [0.1, -0.05, 0.1, -0.05];
  const c = correlations({ t: T, series: [fromReturns(up), fromReturns(up), fromReturns(up.map((x) => -x))] });
  assert.deepEqual(c.map((row) => row.map((x) => Math.round(x * 1e9) / 1e9)), [
    [1, 1, -1],
    [1, 1, -1],
    [-1, -1, 1],
  ]);
});

test('a hand-worked pair: returns 0.1, 0, -0.1 against 0.1, 0.1, 0', () => {
  const c = correlations({ t: T.slice(0, 4), series: [fromReturns([0.1, 0, -0.1]), fromReturns([0.1, 0.1, 0])] });
  // Means 0 and 0.0667; cross sum 0.01, sums of squares 0.02 and 0.00667: 0.01 / sqrt(0.02 * 0.00667) = sqrt(3) / 2.
  assert.ok(near(c[0][1], Math.sqrt(3) / 2, 1e-9));
  assert.equal(c[0][1], c[1][0]);
});

test('a series that never moves has no correlation with the others, and a diagonal of 1', () => {
  const c = correlations({ t: T, series: [fromReturns([0.1, -0.05, 0.1, -0.05]), [1, 1, 1, 1, 1]] });
  assert.equal(c[0][0], 1);
  assert.equal(c[1][1], 1);
  assert.ok(Number.isNaN(c[0][1]) && Number.isNaN(c[1][0]));
});

// --- End labels ------------------------------------------------------------------------------------------------------

test('end labels stay where their line ends unless they would touch', () => {
  assert.deepEqual(spreadLabels([20, 100, 60], 0, 200, 14), [20, 100, 60]);
  // Close ends are pushed down, in order of height, and each result goes back to its own line.
  assert.deepEqual(spreadLabels([100, 50, 52], 0, 200, 14), [100, 50, 64]);
});

test('end labels are pulled back inside the chart, keeping their gaps', () => {
  assert.deepEqual(spreadLabels([190, 195, 199], 0, 200, 14), [172, 186, 200]);
  assert.deepEqual(spreadLabels([-5, 0], 6, 200, 14), [6, 20]);
  assert.deepEqual(spreadLabels([], 0, 200), []);
});
