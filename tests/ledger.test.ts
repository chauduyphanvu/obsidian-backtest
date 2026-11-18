import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec, type ParseOptions } from '../src/dsl.ts';
import {
  addTrial,
  addVersion,
  defaultsHash,
  emptyLedger,
  lineDiff,
  MAX_VERSIONS,
  mergeLedgers,
  parseLedger,
  resetTrials,
  trialHash,
  trialSpread,
  versionHash,
  type Ledger,
} from '../src/ledger.ts';
import { JsonStore, type StoreFiles } from '../src/store.ts';
import { makeRng } from '../src/rng.ts';
import { near } from './helpers.ts';

const hashOf = (src: string, opts?: ParseOptions) => {
  const { spec, errors } = parseSpec(src, opts);
  assert.deepEqual(errors, []);
  return trialHash(spec!);
};

test('two blocks that trade alike are one trial, however they are written', () => {
  const plain = 'universe: SPY\nbuy when close > sma(50)\nsell when close < sma(50)';
  for (const same of [
    'universe: SPY\nbuy when close > sma(close, 50)\nsell when close < sma(close, 50)',
    'universe:  SPY\n\nbuy when  close  >  sma( 50 )   # the trend\nsell when close below sma(50)',
    'universe: SPY\nbuy when close above sma(50)\nsell when close < sma(50)',
    // A name and `test from` only label and split the figures.
    `name: Trend\n${plain}\ntest from: 2020-01-01`,
  ]) {
    assert.equal(hashOf(same), hashOf(plain), same);
  }
});

test('a parameter trades as the number it is set to, wherever it is used', () => {
  const swept = 'universe: SPY\nfast = 50 in 20..100 step 10\nbuy when sma(fast) > sma(200)';
  assert.equal(hashOf(swept, { overrides: { fast: 30 } }), hashOf('universe: SPY\nbuy when sma(30) > sma(200)'));
  assert.equal(hashOf(swept), hashOf('universe: SPY\nbuy when sma(50) > sma(200)'));
  assert.notEqual(hashOf(swept, { overrides: { fast: 30 } }), hashOf(swept));
  const pairs: [string, string][] = [
    ['universe: SPY\nlag = 3\nbuy when close > close[lag]', 'universe: SPY\nbuy when close > close[3]'],
    ['universe: SPY\nn = 10\nstop loss: 2 atr(n)\nbuy when true', 'universe: SPY\nstop loss: 2 atr(10)\nbuy when true'],
    ['universe: SPY, TLT\nn = 30\nweighting: inverse volatility(n)\nbuy when true', 'universe: SPY, TLT\nweighting: inverse volatility(30)\nbuy when true'],
    ['universe: SPY\nn = 14\nrisk per trade: 1% at 2 atr(n)\nbuy when true', 'universe: SPY\nrisk per trade: 1% at 2 atr(14)\nbuy when true'],
    ['universe: SPY\nk = 5%\nstop loss: k\nbuy when true', 'universe: SPY\nstop loss: 5%\nbuy when true'],
    ['universe: SPY\nlimit = 30\nbuy when rsi(14) < limit', 'universe: SPY\nbuy when rsi(14) < 30'],
    ['universe: SPY, QQQ, TLT\nn = 2 in 1..3\nhold: top n by roc(20)', 'universe: SPY, QQQ, TLT\nhold: top 2 by roc(20)'],
  ];
  for (const [a, b] of pairs) assert.equal(hashOf(a), hashOf(b), a);
  // With a `from` date, a range within the 250 bars always loaded before it loads no more history either.
  const from = 'universe: SPY\nfrom: 2015-01-01\n';
  assert.equal(hashOf(`${from}fast = 20 in 10..40\nbuy when close > sma(fast)`), hashOf(`${from}buy when close > sma(20)`));
});

test('a range that loads more history before `from` is another trial, as an EMA started earlier can trade differently', () => {
  const swept = 'slow = 200 in 100..400 step 100\nbuy when close > ema(slow)';
  // ema(400) settles over 2,000 bars, ema(200) over 1,000.
  assert.notEqual(hashOf(`universe: SPY\nfrom: 2015-01-01\n${swept}`, { overrides: { slow: 200 } }), hashOf('universe: SPY\nfrom: 2015-01-01\nbuy when close > ema(200)'));
  // Without one, the whole history is loaded whatever the range.
  assert.equal(hashOf(`universe: SPY\n${swept}`, { overrides: { slow: 200 } }), hashOf('universe: SPY\nbuy when close > ema(200)'));
});

test('anything that can change a trade changes the trial', () => {
  const base = 'universe: SPY\nbuy when close > sma(50)\nsell when close < sma(50)';
  const variants = [
    'universe: SPY\nbuy when close > sma(51)\nsell when close < sma(50)',
    'universe: SPY\nbuy when close > ema(50)\nsell when close < sma(50)',
    'universe: SPY\nbuy when close >= sma(50)\nsell when close < sma(50)',
    'universe: QQQ\nbuy when close > sma(50)\nsell when close < sma(50)',
    `${base}\ncosts: 10 bps`,
    `${base}\nslippage: 5 bps`,
    `${base}\ncapital: 20000`,
    `${base}\nstop loss: 5%`,
    `${base}\nfill: close`,
    `${base}\nfrom: 2015-01-01`,
    `${base}\ninterval: 1w`,
    `${base}\ncash rate: 3%`,
    `${base}\ncommission: $1 per order`,
    `${base}\nentries: 2\nadd when close > last entry price * 1.03`,
    `${base}\nentries: 2\nadd when close > last entry price * 1.04`,
    'universe: SPY\nbuy when close > sma(50)',
    'universe: SPY\nlag = 4\nbuy when close > close[lag]\nsell when close < sma(50)',
  ];
  const seen = new Set([hashOf(base)]);
  for (const v of variants) {
    const { spec, errors } = parseSpec(v);
    assert.deepEqual(errors, [], v);
    const h = trialHash(spec!);
    assert.ok(!seen.has(h), v);
    seen.add(h);
  }
  // The defaults fill in what a block leaves out, so they count too.
  assert.notEqual(hashOf(base, { defaults: { costBps: 2 } }), hashOf(base, { defaults: { costBps: 3 } }));
  assert.equal(hashOf(`${base}\ncosts: 2 bps`, { defaults: { costBps: 2 } }), hashOf(`${base}\ncosts: 2 bps`, { defaults: { costBps: 3 } }));
});

test('a trial counts once, with the figures it was first counted with, and runs with no Sharpe ratio do not count', () => {
  let l = emptyLedger();
  l = addTrial(l, 'a1', 1.2, 252, 100);
  l = addTrial(l, 'b2', 0.4, 252, 200);
  const before = l;
  // Drawing the block again, on newer prices, changes nothing, so nothing is written.
  assert.equal(addTrial(l, 'a1', 1.3, 251.5, 300), before);
  assert.deepEqual(l.trials, { a1: [1.2, 252, 100], b2: [0.4, 252, 200] });
  assert.equal(addTrial(l, 'c3', NaN, 252, 400), before);
  assert.equal(addTrial(l, 'c3', 1, 0, 400), before);
  assert.equal(addTrial(l, 'c3', 1, Infinity, 400), before);
  // The record passed in is not changed.
  const empty = emptyLedger();
  addTrial(empty, 'a1', 1, 252, 1);
  assert.deepEqual(empty, emptyLedger());
});

test('starting the count again drops the trials and keeps the versions', () => {
  let l = addTrial(emptyLedger(), 'a1', 1, 252, 100);
  l = addVersion(l, { text: 'universe: SPY', defaults: {}, at: 100, figures: { cagr: 0.1, maxDrawdown: -0.2, sharpe: 1, trades: 3 } });
  const r = resetTrials(l, 500);
  assert.deepEqual(r.trials, {});
  assert.equal(r.resetAt, 500);
  assert.equal(r.versions, l.versions);
  assert.equal(resetTrials(r, 400).resetAt, 500, 'a reset never moves back');
});

const figures = { cagr: 0.08, maxDrawdown: -0.15, sharpe: 0.9, trades: 12 };

test('a version is its text and defaults; one seen before keeps its first date', () => {
  let l = addVersion(emptyLedger(), { text: 'a', defaults: { capital: 1 }, at: 10, figures });
  assert.equal(l.versions.length, 1);
  assert.deepEqual(l.versions[0], { hash: versionHash('a', { capital: 1 }), text: 'a', defaults: defaultsHash({ capital: 1 }), at: 10, figures });
  const same = addVersion(l, { text: 'a', defaults: { capital: 1 }, at: 20, figures: { ...figures, trades: 99 } });
  assert.equal(same, l);
  l = addVersion(l, { text: 'a', defaults: { capital: 2 }, at: 20, figures });
  assert.equal(l.versions.length, 2, 'the same text with other defaults is another version');
  assert.notEqual(versionHash('a\nb', {}), versionHash('a', { b: 1 }));
  // Figures that are not numbers are kept as null, as JSON would write them.
  l = addVersion(l, { text: 'b', defaults: {}, at: 30, figures: { cagr: NaN, maxDrawdown: -0.1, sharpe: Infinity, trades: 0 } });
  assert.deepEqual(l.versions[2].figures, { cagr: null, maxDrawdown: -0.1, sharpe: null, trades: 0 });
});

test('versions are kept oldest first, the very first and the latest 100', () => {
  let l = emptyLedger();
  for (let i = 0; i < 130; i++) l = addVersion(l, { text: `v${i}`, defaults: {}, at: 1000 + i, figures });
  assert.equal(l.versions.length, MAX_VERSIONS + 1);
  assert.equal(l.versions[0].text, 'v0');
  assert.equal(l.versions[1].text, 'v30');
  assert.equal(l.versions[MAX_VERSIONS].text, 'v129');
  // A version added out of order lands in its place.
  const late = addVersion(emptyLedger(), { text: 'b', defaults: {}, at: 20, figures });
  assert.deepEqual(addVersion(late, { text: 'a', defaults: {}, at: 10, figures }).versions.map((v) => v.text), ['a', 'b']);
});

/** A record with the given trials and versions (by text and time). */
function ledger(trials: Record<string, [number, number, number]>, versions: [string, number][], resetAt = 0): Ledger {
  let l: Ledger = { ...emptyLedger(), trials, resetAt };
  for (const [text, at] of versions) l = addVersion(l, { text, defaults: {}, at, figures });
  return l;
}

test('two copies merge as the union of their trials and versions', () => {
  const disk = ledger({ a1: [1, 252, 10], b2: [0.5, 252, 20] }, [['x', 10], ['y', 30]]);
  const mine = ledger({ a1: [1.1, 252, 15], c3: [0.2, 52, 40] }, [['y', 25], ['z', 40]]);
  const m = mergeLedgers(disk, mine);
  // a1 keeps its earlier sight, figures and all, whichever copy had it.
  assert.deepEqual(m.trials, { a1: [1, 252, 10], b2: [0.5, 252, 20], c3: [0.2, 52, 40] });
  assert.deepEqual(mergeLedgers(mine, disk).trials, m.trials);
  assert.deepEqual(m.versions.map((v) => [v.text, v.at]), [['x', 10], ['y', 25], ['z', 40]]);
  assert.equal(m.resetAt, 0);
});

test('merging is idempotent, so a record written again and again does not grow', () => {
  const a = ledger({ a1: [1, 252, 10], b2: [0.5, 252, 20] }, [['x', 10], ['y', 30]], 5);
  assert.deepEqual(mergeLedgers(a, a), a);
  const b = ledger({ c3: [2, 252, 50] }, [['z', 60]], 5);
  const once = mergeLedgers(a, b);
  assert.deepEqual(mergeLedgers(once, b), once);
  assert.deepEqual(mergeLedgers(a, once), once);
  // A copy that holds all of the other's is the result.
  assert.deepEqual(mergeLedgers(a, mergeLedgers(a, b)), once);
});

test('the later reset wins: trials first seen before it go, versions stay', () => {
  const disk = ledger({ a1: [1, 252, 10], b2: [0.5, 252, 120] }, [['x', 10]], 0);
  const mine = ledger({ c3: [0.2, 252, 150] }, [['y', 150]], 100);
  const m = mergeLedgers(disk, mine);
  assert.deepEqual(m.trials, { b2: [0.5, 252, 120], c3: [0.2, 252, 150] });
  assert.equal(m.resetAt, 100);
  assert.deepEqual(m.versions.map((v) => v.text), ['x', 'y']);
  // The same, the other way round.
  assert.deepEqual(mergeLedgers(mine, disk).trials, m.trials);
  // A trial first seen exactly at the reset is kept.
  assert.ok('d4' in mergeLedgers(ledger({ d4: [1, 252, 100] }, []), mine).trials);
});

test('merged versions keep the very first and the latest 100', () => {
  const disk = ledger({}, Array.from({ length: 80 }, (_, i): [string, number] => [`d${i}`, i * 2]));
  const mine = ledger({}, Array.from({ length: 80 }, (_, i): [string, number] => [`m${i}`, i * 2 + 1]));
  const m = mergeLedgers(disk, mine);
  assert.equal(m.versions.length, MAX_VERSIONS + 1);
  assert.equal(m.versions[0].text, 'd0');
  assert.equal(m.versions[m.versions.length - 1].text, 'm79');
  assert.ok(m.versions.every((v, i) => i === 0 || v.at > m.versions[i - 1].at));
});

test('a record survives a trip through JSON', () => {
  let l = addTrial(emptyLedger(), trialHash(parseSpec('universe: SPY\nbuy when true').spec!), 0.8, 252.1, 5);
  l = addVersion(l, { text: 'universe: SPY\nbuy when true', defaults: { capital: 10000 }, at: 5, figures: { cagr: NaN, maxDrawdown: -0.3, sharpe: 0.8, trades: 1 } });
  l = resetTrials(l, 3);
  l = addTrial(l, 'zz', -0.4, 52, 7);
  assert.deepEqual(parseLedger(JSON.parse(JSON.stringify(l))), l);
  assert.deepEqual(parseLedger(emptyLedger()), emptyLedger());
});

test('a malformed record is rejected, and unknown fields are dropped', () => {
  const good = JSON.parse(JSON.stringify(ledger({ a1: [1, 252, 10] }, [['x', 10]]))) as Record<string, unknown>;
  assert.notEqual(parseLedger(good), null);
  const bad = (change: (r: Record<string, any>) => void) => {
    const r = structuredClone(good) as Record<string, any>;
    change(r);
    return parseLedger(r);
  };
  for (const raw of [null, 3, 'x', [], {}]) assert.equal(parseLedger(raw), null);
  assert.equal(bad((r) => delete r.trials), null);
  assert.equal(bad((r) => (r.trials = [])), null);
  assert.equal(bad((r) => (r.resetAt = null)), null);
  assert.equal(bad((r) => (r.resetAt = -5)), null);
  assert.equal(bad((r) => (r.versions = {})), null);
  assert.equal(bad((r) => (r.trials.a1 = [1, 252])), null);
  assert.equal(bad((r) => (r.trials.a1 = [1, 0, 10])), null);
  assert.equal(bad((r) => (r.trials.a1 = [null, 252, 10])), null);
  assert.equal(bad((r) => (r.trials.a1 = { 0: 1, 1: 252, 2: 10 })), null);
  assert.equal(bad((r) => (r.trials['A-1'] = [1, 252, 10])), null);
  assert.equal(parseLedger(JSON.parse('{"trials":{"__proto__":[1,252,10]},"versions":[],"resetAt":0}')), null);
  // A record from before the count kept only distinct tries had a total, which is dropped.
  assert.deepEqual(parseLedger({ ...good, total: 7 }), parseLedger(good));
  // A key that is also a name on every object is held as the record's own, and nothing else.
  const own = bad((r) => (r.trials.constructor = [1, 252, 10]))!;
  assert.deepEqual(own.trials.constructor, [1, 252, 10]);
  assert.equal(trialSpread(own, 252).trials, 2);
  assert.equal(bad((r) => (r.versions[0].text = 5)), null);
  assert.equal(bad((r) => delete r.versions[0].hash), null);
  assert.equal(bad((r) => (r.versions[0].hash = 'not a hash')), null);
  assert.equal(bad((r) => (r.versions[0].defaults = 7)), null);
  assert.equal(bad((r) => (r.versions[0].at = '2024')), null);
  assert.equal(bad((r) => (r.versions[0].figures = null)), null);
  assert.equal(bad((r) => (r.versions[0].figures.cagr = 'high')), null);
  assert.equal(bad((r) => (r.versions[0].figures.trades = -1)), null);
  assert.equal(bad((r) => (r.versions[0] = 'x')), null);
  const extra = bad((r) => {
    r.future = 1;
    r.versions[0].note = 'hi';
  })!;
  assert.deepEqual(extra, parseLedger(good));
  assert.ok(!('future' in extra) && !('note' in extra.versions[0]));
});

test('the deflated Sharpe ratio counts distinct trials and spreads their Sharpe ratios per step of this run', () => {
  assert.deepEqual(trialSpread(emptyLedger(), 252), { trials: 0, variance: 0 });
  assert.deepEqual(trialSpread(addTrial(emptyLedger(), 'a', 1, 252, 0), 252), { trials: 1, variance: 0 });
  let l = emptyLedger();
  l = addTrial(l, 'a', 1, 252, 0);
  l = addTrial(l, 'a', 1, 252, 1);
  l = addTrial(l, 'b', 2, 252, 2);
  // A weekly run's annual figure compares with the daily ones through the year.
  l = addTrial(l, 'c', 0, 52, 3);
  const { trials, variance } = trialSpread(l, 252);
  assert.equal(trials, 3);
  // Annual Sharpe ratios 1, 2 and 0 have sample variance 1; per daily step that is 1/252.
  assert.ok(near(variance, 1 / 252, 1e-15));
  assert.ok(near(trialSpread(l, 52).variance, 1 / 52, 1e-15));
});

/** The diff's two sides as texts. */
const sides = (d: ReturnType<typeof lineDiff>) => ({
  before: d.filter((x) => x.op !== 'added').map((x) => x.text).join('\n'),
  after: d.filter((x) => x.op !== 'removed').map((x) => x.text).join('\n'),
});

test('a line diff keeps, adds and removes lines, a removed line before its replacement', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nb\nc'), [
    { op: 'same', text: 'a' },
    { op: 'same', text: 'b' },
    { op: 'same', text: 'c' },
  ]);
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc'), [
    { op: 'same', text: 'a' },
    { op: 'removed', text: 'b' },
    { op: 'added', text: 'B' },
    { op: 'same', text: 'c' },
  ]);
  assert.deepEqual(lineDiff('a\nc', 'a\nb\nc'), [
    { op: 'same', text: 'a' },
    { op: 'added', text: 'b' },
    { op: 'same', text: 'c' },
  ]);
  assert.deepEqual(lineDiff('a\nb\nc', 'b'), [
    { op: 'removed', text: 'a' },
    { op: 'same', text: 'b' },
    { op: 'removed', text: 'c' },
  ]);
  assert.deepEqual(lineDiff('', 'x'), [
    { op: 'removed', text: '' },
    { op: 'added', text: 'x' },
  ]);
  assert.deepEqual(lineDiff('', ''), [{ op: 'same', text: '' }]);
  // CRLF and LF line ends are the same line.
  assert.deepEqual(lineDiff('a\r\nb', 'a\nb').map((x) => x.op), ['same', 'same']);
});

test('a line diff is a longest common subsequence: no shorter way keeps more lines', () => {
  // The classic example: ABCBDAB against BDCABA keeps 4.
  const d = lineDiff('A\nB\nC\nB\nD\nA\nB', 'B\nD\nC\nA\nB\nA');
  assert.equal(d.filter((x) => x.op === 'same').length, 4);
  const lcsLength = (a: string[], b: string[]): number => {
    const m = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = a[i - 1] === b[j - 1] ? m[i - 1][j - 1] + 1 : Math.max(m[i - 1][j], m[i][j - 1]);
    return m[a.length][b.length];
  };
  const rng = makeRng(42);
  for (let k = 0; k < 300; k++) {
    const make = () => Array.from({ length: rng.int(9) }, () => 'abcd'[rng.int(4)]);
    const a = make();
    const b = make();
    const diff = lineDiff(a.join('\n'), b.join('\n'));
    assert.deepEqual(sides(diff), { before: a.join('\n'), after: b.join('\n') });
    // An empty text is one empty line.
    const lines = (x: string[]) => (x.length ? x : ['']);
    assert.equal(diff.filter((x) => x.op === 'same').length, lcsLength(lines(a), lines(b)), `${a} | ${b}`);
  }
});

test('records kept by a JsonStore merge with a copy a sync brought in', async () => {
  const files = new Map<string, string>();
  const io: StoreFiles = {
    exists: async (p) => files.has(p) || p === 'plugin/ledger',
    read: async (p) => files.get(p)!,
    write: async (p, text) => void files.set(p, text),
    mkdir: async () => undefined,
    remove: async (p) => void files.delete(p),
    list: async () => ({ files: [...files.keys()] }),
  };
  const options = { files: io, dir: 'plugin/ledger', parse: parseLedger, merge: mergeLedgers, setTimer: () => 0, clearTimer: () => undefined };
  const here = new JsonStore<Ledger>(options);
  await here.update('Note.md#Trend', (l) => addTrial(l ?? emptyLedger(), 'a1', 1, 252, 10));
  await here.flush();
  // Another device adds a trial to the same file.
  const there = new JsonStore<Ledger>(options);
  await there.update('Note.md#Trend', (l) => addTrial(l!, 'b2', 0.5, 252, 20));
  await there.flush();
  await here.update('Note.md#Trend', (l) => addTrial(l!, 'c3', 0.1, 252, 30));
  await here.flush();
  const [path] = [...files.keys()];
  const saved = parseLedger((JSON.parse(files.get(path)!) as { value: unknown }).value)!;
  assert.deepEqual(Object.keys(saved.trials).sort(), ['a1', 'b2', 'c3']);
});

test('a trial counted again after the count was started again stays, though a copy saw it before the reset', async () => {
  const disk = ledger({ abc: [1.2, 252, 1000], def: [0.4, 252, 1000] }, [], 0);
  const mine = ledger({ abc: [1.2, 252, 5001] }, [], 5000);
  for (const m of [mergeLedgers(disk, mine), mergeLedgers(mine, disk)]) assert.deepEqual([m.trials, m.resetAt], [{ abc: [1.2, 252, 5001] }, 5000]);
  // The same through a JsonStore: counted, written, started again and the run on screen counted again.
  const files = new Map<string, string>();
  const io: StoreFiles = {
    exists: async (p) => files.has(p) || p === 'plugin/ledger',
    read: async (p) => files.get(p)!,
    write: async (p, text) => void files.set(p, text),
    mkdir: async () => undefined,
    remove: async (p) => void files.delete(p),
    list: async () => ({ files: [...files.keys()] }),
  };
  const store = new JsonStore<Ledger>({ files: io, dir: 'plugin/ledger', parse: parseLedger, merge: mergeLedgers, setTimer: () => 0, clearTimer: () => undefined });
  await store.update('Note.md#Trend', (l) => addTrial(addTrial(l ?? emptyLedger(), 'abc', 1.2, 252, 1000), 'def', 0.4, 252, 1000));
  await store.flush();
  await store.update('Note.md#Trend', (l) => addTrial(resetTrials(l!, 5000), 'abc', 1.2, 252, 5001));
  await store.flush();
  const [path] = [...files.keys()];
  assert.deepEqual(Object.keys(parseLedger((JSON.parse(files.get(path)!) as { value: unknown }).value)!.trials), ['abc']);
  assert.deepEqual(Object.keys((await store.get('Note.md#Trend'))!.trials), ['abc']);
});
