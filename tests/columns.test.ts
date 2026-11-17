// Columns of a CSV file as series a rule can read: the reader, the language, and what a run does with them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { loadBars, parseCsv, type DataDeps } from '../src/data.ts';
import { INDICATORS, parseSpec, type Expr } from '../src/dsl.ts';
import { columnFiles, columnNotes, Evaluator, specEvaluator } from '../src/evaluate.ts';
import { explainTrade } from '../src/explain.ts';
import { serve, withInputs, type FromWorker, type Ran, type ToWorker } from '../src/jobs.ts';
import { resultBytes, runSize } from '../src/limits.ts';
import { lookbackBars, Runner } from '../src/runner.ts';
import { columnName, MAX_COLUMNS, sliceBars, type Bars } from '../src/types.ts';
import { bars, DAY, near, T0 } from './helpers.ts';

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const nan = NaN;
const same = (a: number[], b: number[]) => assert.deepEqual(a.map((x) => (Number.isNaN(x) ? 'nan' : x)), b.map((x) => (Number.isNaN(x) ? 'nan' : x)));

/** Price bars with the given columns, each named as its header. */
function withColumns(b: Bars, cols: Record<string, number[]>): Bars {
  return { ...b, columns: Object.entries(cols).map(([name, v]) => ({ name, header: name, v })) };
}

/** A file with only a date and columns, one row at each of `times`. */
function signals(times: number[], cols: Record<string, number[]>): Bars {
  const n = times.length;
  const none = () => times.map(() => nan);
  return { t: times, o: none(), h: none(), l: none(), c: none(), v: times.map(() => 0), unpriced: true, columns: Object.entries(cols).map(([name, v]) => ({ name, header: name, v: v.slice(0, n) })) };
}

const days = (n: number, start = T0) => Array.from({ length: n }, (_, i) => start + i * DAY);

function run(source: string, data: Record<string, Bars>): Backtest {
  const { spec, errors } = parseSpec(source);
  assert.deepEqual(errors, [], source);
  return runBacktest(spec!, new Map(Object.entries(data)));
}
const trades = (bt: Backtest) => bt.run.trades.map((t) => [t.asset, iso(t.entryT), t.reason === 'open' ? 'open' : iso(t.exitT)]);
const errorsOf = (source: string) => parseSpec(source).errors.map((e) => e.message);

// ------------------------------------------------------------------------------------------------ the reader

test('every extra column that holds numbers is kept, lined up with the bars, and the usual ones are not', () => {
  const b = parseCsv(['Date,Open,High,Low,Close,Volume,Score,News Sentiment', '2024-01-02,1,2,1,2,10,0.5,3', '2024-01-03,2,3,2,3,10,0.7,-4.5', '2024-01-04,3,4,3,4,10,0.2,1e2'].join('\n'));
  assert.deepEqual(b.c, [2, 3, 4]);
  assert.deepEqual(b.columns!.map((c) => [c.name, c.header]), [['score', 'Score'], ['news_sentiment', 'News Sentiment']]);
  same(b.columns![0].v, [0.5, 0.7, 0.2]);
  same(b.columns![1].v, [3, -4.5, 100]);
  assert.equal(b.unpriced, undefined);
  assert.equal(b.unread, undefined);
});

test('a file with no extra column has no columns field at all, so it reads as it did before', () => {
  const b = parseCsv('Date,Open,High,Low,Close,Volume\n2024-01-02,1,2,1,2,10');
  assert.deepEqual(Object.keys(b), ['t', 'o', 'h', 'l', 'c', 'v']);
  // A text column and a column of nothing are not columns a rule can read.
  const text = parseCsv('Date,Open,High,Low,Close,Symbol,Notes\n2024-01-02,1,2,1,2,SPY,\n2024-01-03,1,2,1,2,SPY,');
  assert.deepEqual(Object.keys(text), ['t', 'o', 'h', 'l', 'c', 'v']);
  // A column that Yahoo files carry and that no rule needs is simply one more column.
  assert.deepEqual(parseCsv('Date,Open,High,Low,Close,Adj Close,Volume,Dividends\n2024-01-02,1,2,1,2,2,5,0.1').columns!.map((c) => c.name), ['dividends']);
});

test('a header becomes a name: lower case, accents dropped, each run of other characters one underscore', () => {
  const cases: [string, string][] = [
    ['Score', 'score'],
    ['News Sentiment', 'news_sentiment'],
    ['news-sentiment', 'news_sentiment'],
    ['  P/E  ratio ', 'p_e_ratio'],
    ['Température (°C)', 'temperature_c'],
    ['10Y yield', '10y_yield'],
    ['__x__', 'x'],
    ['GDP %', 'gdp'],
    ['%', ''],
    ['', ''],
    ['日本', ''],
  ];
  for (const [header, name] of cases) assert.equal(columnName(header), name, JSON.stringify(header));
});

test('an empty or non-numeric cell is unknown, never zero, and a zero is a zero', () => {
  const b = parseCsv(['Date,Open,High,Low,Close,Score', '2024-01-02,1,2,1,2,0', '2024-01-03,1,2,1,2,', '2024-01-04,1,2,1,2,n/a', '2024-01-05,1,2,1,2,5%', '2024-01-06,1,2,1,2,0x10', '2024-01-07,1,2,1,2,Infinity', '2024-01-08,1,2,1,2,"1,5"', '2024-01-09,1,2,1,2, 7.25 ', '2024-01-10,1,2,1,2,-.5'].join('\n'));
  same(b.columns![0].v, [0, nan, nan, nan, nan, nan, nan, 7.25, -0.5]);
});

test('two headers that become the same name make neither readable, and the message names both', () => {
  const b = parseCsv(['Date,Open,High,Low,Close,News Sentiment,news-sentiment,Score', '2024-01-02,1,2,1,2,1,2,3'].join('\n'));
  // The prices read as they always did, and so does the column that has no rival.
  assert.deepEqual(b.c, [2]);
  assert.deepEqual(b.columns!.map((c) => c.name), ['score']);
  assert.equal(b.unread!.length, 1);
  assert.equal(b.unread![0].name, 'news_sentiment');
  assert.match(b.unread![0].why, /2 columns would all be called news_sentiment: "News Sentiment" and "news-sentiment"\. Rename all but one in the file/);
  assert.throws(() => run('universe: csv:Data/a.csv\nbuy when column(news_sentiment) > 0', { a: b }), /The CSV file a can't give the column news_sentiment: 2 columns would all be called news_sentiment: "News Sentiment" and "news-sentiment"/);
  // Three of a name are all named.
  const three = parseCsv('Date,Open,High,Low,Close,A b,a-b,A_B\n2024-01-02,1,2,1,2,1,2,3');
  assert.match(three.unread![0].why, /3 columns would all be called a_b: "A b", "a-b" and "A_B"/);
  // A clash with a column that holds no numbers is no clash.
  const text = parseCsv('Date,Open,High,Low,Close,Note,note\n2024-01-02,1,2,1,2,hi,4');
  assert.deepEqual(text.columns!.map((c) => c.name), ['note']);
  assert.equal(text.unread, undefined);
});

test('past the limit the first columns are readable and the rest are named as left out', () => {
  const n = MAX_COLUMNS + 10;
  const names = Array.from({ length: n }, (_, i) => `s${i}`);
  const row = (day: string) => `${day},1,2,1,2,${names.map((_, i) => i).join(',')}`;
  const b = parseCsv([`Date,Open,High,Low,Close,${names.join(',')}`, row('2024-01-02'), row('2024-01-03')].join('\n'));
  assert.equal(b.columns!.length, MAX_COLUMNS);
  assert.equal(b.columns![MAX_COLUMNS - 1].name, `s${MAX_COLUMNS - 1}`);
  assert.deepEqual(b.unread!.map((u) => u.name), names.slice(MAX_COLUMNS));
  assert.ok(b.unread!.every((u) => u.limit === true));
  assert.throws(() => run(`universe: csv:Data/a.csv\nbuy when column(s${MAX_COLUMNS}) > 0`, { a: b }), new RegExp(`can't give the column s${MAX_COLUMNS}: only the first ${MAX_COLUMNS} columns of a file can be read`));
  assert.equal(run(`universe: csv:Data/a.csv\nbuy when column(s0) >= 0`, { a: b }).run.t.length, 2);
});

test('a file of a date and columns, with no prices, is read as signals that cannot be traded', () => {
  const b = parseCsv(['date,Score,Model Score', '2024-01-03,2,3', '2024-01-02,1,2'].join('\n'));
  assert.equal(b.unpriced, true);
  assert.deepEqual(b.t, [Date.UTC(2024, 0, 2), Date.UTC(2024, 0, 3)]);
  same(b.columns![0].v, [1, 2]);
  same(b.columns![1].v, [2, 3]);
  assert.equal(b.c.length, 2);
  assert.ok(b.c.every(Number.isNaN) && b.o.every(Number.isNaN) && b.h.every(Number.isNaN) && b.l.every(Number.isNaN));
  assert.deepEqual(b.v, [0, 0]);
  // With no price header, volume and adj close are columns like any other.
  assert.deepEqual(parseCsv('date,volume,adj close\n2024-01-02,1,2').columns!.map((c) => c.name), ['volume', 'adj_close']);
  // What this changes is only a file that could not be read before. These still cannot.
  assert.throws(() => parseCsv('date,notes\n2024-01-02,hello'), /header row with date, open, high, low and close columns, but has no open, high, low, close column/);
  assert.throws(() => parseCsv('a,b\n1,2'), /header row/);
  assert.throws(() => parseCsv('Day,Score\n2024-01-02,1'), /no date, open, high, low, close column/);
  assert.throws(() => parseCsv('date,score\nsoon,1'), /"date" column could be read/);
  // A file with some price columns but not all is still an error.
  assert.throws(() => parseCsv('date,close,score\n2024-01-02,1,2'), /no open, high, low column/);
});

test('rows are sorted, and a repeated date keeps its first row, with the columns of that row', () => {
  const b = parseCsv(['Date,Open,High,Low,Close,Score', '2024-01-04,4,4,4,4,40', '2024-01-02,1,1,1,1,10', '2024-01-03,2,2,2,2,20', '2024-01-03,9,9,9,9,99', 'soon,5,5,5,5,50', '2024-01-05,0,0,0,0,60'].join('\n'));
  assert.deepEqual(b.t, [Date.UTC(2024, 0, 2), Date.UTC(2024, 0, 3), Date.UTC(2024, 0, 4)]);
  assert.deepEqual(b.c, [1, 2, 4]);
  same(b.columns![0].v, [10, 20, 40]);
  const s = parseCsv(['date,score', '2024-01-03,2', '2024-01-02,1', '2024-01-03,99', 'later,7'].join('\n'));
  same(s.columns![0].v, [1, 2]);
});

test('an adjusted close scales the prices and nothing else', () => {
  const b = parseCsv(['Date,Open,High,Low,Close,Adj Close,Score,Volume', '2024-01-02,10,11,9,10,5,10,100', '2024-01-03,20,22,18,20,10,20,100'].join('\n'));
  assert.deepEqual(b.c, [5, 10]);
  same(b.columns![0].v, [10, 20]);
  assert.deepEqual(b.v, [100, 100]);
  assert.deepEqual(b.columns!.map((c) => c.name), ['score']);
});

test('every way a Bars is copied or sliced carries the columns', () => {
  const full = parseCsv(['Date,Open,High,Low,Close,A,B', ...Array.from({ length: 6 }, (_, i) => `2024-01-0${i + 1},1,2,1,2,${i},${i * 10}`)].join('\n'));
  const cut = sliceBars(full, 2);
  assert.deepEqual(cut.t, full.t.slice(2));
  same(cut.columns![0].v, [2, 3, 4, 5]);
  same(cut.columns![1].v, [20, 30, 40, 50]);
  assert.equal(sliceBars(full, 0), full);
  assert.equal(full.columns![0].v.length, 6);
  const gone = parseCsv('date,A\n2024-01-01,1\n2024-01-02,2\n2024-01-03,3');
  const part = sliceBars({ ...gone, unread: [{ name: 'x', why: 'because' }] }, 1);
  assert.equal(part.unpriced, true);
  assert.deepEqual(part.unread, [{ name: 'x', why: 'because' }]);
  assert.deepEqual(part.c.length, 2);
  // The structured clone a worker receives its prices as.
  const copy = structuredClone(new Map([['f', full], ['g', gone]]));
  assert.deepStrictEqual(copy, new Map([['f', full], ['g', gone]]));
});

test('the runner slices the prices to the run, columns included, and a CSV file is never saved in the cache', async () => {
  const rows = Array.from({ length: 700 }, (_, i) => `${iso(T0 + i * DAY)},10,11,9,10,${i}`);
  const files: Record<string, string> = { 'Data/a.csv': `date,open,high,low,close,score\n${rows.join('\n')}` };
  const cacheCalls: string[] = [];
  const deps: DataDeps = {
    fetchText: () => Promise.reject(new Error('no network in tests')),
    readVaultFile: async (p) => files[p] ?? null,
    cacheRead: async (k) => {
      cacheCalls.push(`read ${k}`);
      return null;
    },
    cacheWrite: async (k) => void cacheCalls.push(`write ${k}`),
    now: () => Date.UTC(2023, 0, 1),
  };
  const { spec, errors } = parseSpec('universe: csv:Data/a.csv\nfrom: 2021-06-01\nbuy when column(score) > 650');
  assert.deepEqual(errors, []);
  const { data } = await new Runner(deps).loadPrices(spec!);
  const a = data.get('a')!;
  assert.ok(a.t.length < 700 && a.t.length > 250);
  assert.equal(a.columns![0].v.length, a.t.length);
  // The score of a bar is its own index, so every kept row still holds the value of its own date.
  assert.deepEqual(a.columns![0].v, a.t.map((t) => (t - T0) / DAY));
  assert.deepEqual(cacheCalls, []);
  const direct = await loadBars({ name: 'a', source: 'csv', id: 'Data/a.csv' }, '1d', 0, deps);
  assert.equal(direct.bars.columns![0].v.length, 700);
  assert.deepEqual(cacheCalls, []);
});

// ------------------------------------------------------------------------------------------------ the language

test('column(name) of file parses as a series read of another ticker, and column(name) as the rule\'s own', () => {
  const of = parseSpec('universe: SPY\nbuy when column(score) of csv:Data/signals.csv > 0.7').spec!.rules.SPY.buy;
  assert.deepEqual(of, { k: 'cmp', op: '>', a: { k: 'of', a: { k: 'column', name: 'score' }, asset: 'signals' }, b: { k: 'num', v: 0.7 } });
  const own = parseSpec('universe: csv:Data/gold.csv\nbuy when column(score) > 0.7').spec!.rules.gold.buy;
  assert.deepEqual(own, { k: 'cmp', op: '>', a: { k: 'column', name: 'score' }, b: { k: 'num', v: 0.7 } });
  // The file is an extra ticker, named once, and read by its file name afterwards.
  const both = parseSpec('universe: SPY\nbuy when column(score) of csv:Data/signals.csv > 0.7\nsell when column(score) of signals < 0.3').spec!;
  assert.deepEqual(both.extras, [{ name: 'signals', source: 'csv', id: 'Data/signals.csv' }]);
});

test('a name can be written in capitals, in quotes with spaces, or start with a digit, and means what its header means', () => {
  const name = (rule: string) => ((parseSpec(`universe: csv:Data/gold.csv\nbuy when ${rule} > 0`).spec!.rules.gold.buy as Extract<Expr, { k: 'cmp' }>).a as Extract<Expr, { k: 'column' }>).name;
  assert.equal(name('column(Score)'), 'score');
  assert.equal(name('column( score )'), 'score');
  assert.equal(name('column("News Sentiment")'), 'news_sentiment');
  assert.equal(name('column("news-sentiment")'), 'news_sentiment');
  assert.equal(name('COLUMN(10Y)'), '10y');
  assert.equal(name('column(close)'), 'close');
  assert.equal(name('column(month)'), 'month');
});

test('a column reached by of must come from a CSV file, and a rule\'s own column needs its ticker to be one', () => {
  assert.deepEqual(errorsOf('universe: SPY\nbuy when column(score) of SPY > 0'), ['SPY comes from Yahoo, not from a CSV file, so it has no column called score. Name the file, as in column(score) of csv:Data/signals.csv']);
  assert.match(errorsOf('universe: SPY\nbuy when column(score) of binance:BTCUSDT > 0')[0], /^BTCUSDT comes from Binance, not from a CSV file/);
  // A bare name that was never given a file is a Yahoo ticker.
  assert.match(errorsOf('universe: SPY\nbuy when column(score) of signals > 0')[0], /^SIGNALS comes from Yahoo/);
  assert.deepEqual(errorsOf('universe: SPY\nbuy when column(score) > 0'), ['column(score) reads a column of the ticker the rule belongs to, and SPY comes from Yahoo, not from a CSV file. Name the file instead, as in column(score) of csv:Data/signals.csv']);
  // The check follows the rule to every ticker it applies to, and each place is reported once.
  assert.equal(errorsOf('universe: csv:Data/a.csv, SPY, TLT\nbuy when column(x) > 0').length, 1);
  assert.match(errorsOf('universe: csv:Data/a.csv, SPY\nbuy when column(x) > 0')[0], /SPY comes from Yahoo/);
  assert.deepEqual(errorsOf('universe: csv:Data/a.csv, csv:Data/b.csv\nbuy when column(x) > 0'), []);
  // A ticker with a rule of its own does not take the shared one.
  assert.deepEqual(errorsOf('universe: csv:Data/a.csv, SPY\nbuy when column(x) > 0\nfor SPY:\n  buy when close > sma(5)'), []);
  assert.match(errorsOf('universe: csv:Data/a.csv, SPY\nbuy when close > sma(5)\nfor SPY:\n  buy when column(x) > 0')[0], /SPY comes from Yahoo/);
  // The ranking score and the sell rule are read for every ticker too.
  assert.match(errorsOf('universe: csv:Data/a.csv, SPY\nhold: top 1 by column(x)\nbuy when true')[0], /SPY comes from Yahoo/);
  assert.match(errorsOf('universe: SPY\nbuy when true\nsell when column(x) < 0')[0], /SPY comes from Yahoo/);
  // Through a function or a lag it is still the rule's own ticker's column.
  assert.match(errorsOf('universe: SPY\nbuy when sma(column(x), 3)[1] > 0')[0], /SPY comes from Yahoo/);
  // The column of another file inside the rule's own reading is that file's, and checked there.
  assert.deepEqual(errorsOf('universe: SPY\nbuy when sma(column(x) of csv:Data/a.csv, 3) > 0'), []);
  assert.match(errorsOf('universe: SPY\nbuy when sma(column(x) of QQQ, 3) > 0')[0], /^QQQ comes from Yahoo/);
});

test('a column that is written wrong says how to write it, where it is', () => {
  const usage = /^column needs the name of a column in brackets, as in column\(score\) of signals/;
  for (const rule of ['column > 1', 'column() > 1', 'column(a-b) > 1', 'column(1 + 2) > 1', 'column(a b) > 1', 'column(score > 1']) {
    const e = parseSpec(`universe: csv:Data/a.csv\nbuy when ${rule}`).errors;
    assert.equal(e.length, 1, rule);
    assert.match(e[0].message, usage, rule);
    assert.equal(e[0].line, 2);
  }
  assert.match(errorsOf('universe: csv:Data/a.csv\nbuy when column("") > 1')[0], /needs a letter or a digit, and "" has none/);
  assert.match(errorsOf('universe: csv:Data/a.csv\nbuy when column("%%") > 1')[0], /needs a letter or a digit, and "%%" has none/);
  const e = parseSpec('universe: csv:Data/a.csv\nbuy when column(a-b) > 1').errors[0];
  assert.deepEqual([e.from, e.to], [9, 17]);
  // A column is a number, never a condition.
  assert.match(errorsOf('universe: csv:Data/a.csv\nbuy when column(a)')[0], /needs a condition/);
  assert.match(errorsOf('universe: csv:Data/a.csv\nbuy when column(a) and true')[0], /needs a condition on each side/);
});

test('a parameter called column still works, because it is a function only before brackets', () => {
  const { spec, errors } = parseSpec('universe: csv:Data/a.csv\ncolumn = 5\nbuy when close > column and column(x) > column');
  assert.deepEqual(errors, []);
  assert.equal(spec!.params[0].name, 'column');
  assert.ok(!Object.keys(INDICATORS).includes('column'));
});

test('a column keeps its place in the written parts of a rule', () => {
  const { spec } = parseSpec('universe: csv:Data/a.csv\nbuy when column("News Sentiment") of csv:Data/s.csv > 0.5 and sma(column(x), 3) > 1');
  const w = spec!.written!.rules.a.buy!;
  assert.equal(w.text, 'column("News Sentiment") of csv:Data/s.csv > 0.5 and sma(column(x), 3) > 1');
  assert.ok(w.parts.includes('column("News Sentiment") of csv:Data/s.csv'));
  assert.ok(w.parts.includes('column("News Sentiment")'));
  assert.ok(w.parts.includes('column(x)'));
});

// ------------------------------------------------------------------------------------------------ evaluation

const SCORE = [1, 2, 3, 4, 3, 2, 1, 2, 3, 4];
const priced = (n = 10) => bars(Array.from({ length: n }, (_, i) => 100 + i));

test('a column evaluates to exactly its values, through functions, lags, comparisons and crosses', () => {
  const data = new Map<string, Bars>([['A', withColumns(priced(), { score: SCORE })]]);
  const ev = new Evaluator(data);
  const col: Expr = { k: 'column', name: 'score' };
  same(ev.eval(col, 'A'), SCORE);
  same(ev.eval({ k: 'lag', a: col, n: 2 }, 'A'), [nan, nan, 1, 2, 3, 4, 3, 2, 1, 2]);
  same(ev.eval({ k: 'ind', fn: 'sma', src: col, args: [3] }, 'A'), [nan, nan, 2, 3, 10 / 3, 3, 2, 5 / 3, 2, 3]);
  same(ev.eval({ k: 'cmp', op: '>', a: col, b: { k: 'num', v: 2.5 } }, 'A'), SCORE.map((x) => (x > 2.5 ? 1 : 0)));
  same(ev.eval({ k: 'cmp', op: 'xup', a: col, b: { k: 'num', v: 2.5 } }, 'A'), [nan, 0, 1, 0, 0, 0, 0, 0, 1, 0]);
  same(ev.eval({ k: 'bin', op: '*', a: col, b: { k: 'num', v: 10 } }, 'A'), SCORE.map((x) => x * 10));
  // The same through the parser, as a rule a person writes.
  const { spec } = parseSpec('universe: csv:Data/a.csv\nbuy when sma(column(score), 3)[1] > column(score) / 2 and column(score) crosses above 2.5');
  const bt = runBacktest(spec!, new Map([['a', withColumns(priced(), { score: SCORE })]]));
  assert.ok(bt.run.t.length === 10);
});

test('a blank cell makes every rule that reads it unknown, so nothing is bought on it', () => {
  const sc = [1, 5, nan, 5, 5, 5];
  const a = withColumns(priced(6), { score: sc });
  same(new Evaluator(new Map([['A', a]])).eval(parseCond('column(score) > 3'), 'A'), [0, 1, nan, 1, 1, 1]);
  // Unknown at the close of bar 2 buys nothing: the first buy is at the close of bar 1, and bar 2 does not undo it.
  const bt = run('universe: csv:Data/A.csv\nbuy when column(score) > 3', { A: a });
  assert.deepEqual(trades(bt), [['A', iso(T0 + 2 * DAY), 'open']]);
  const sold = run('universe: csv:Data/A.csv\nbuy when column(score) > 3\nsell when column(score) < 3', { A: a });
  assert.deepEqual(trades(sold), [['A', iso(T0 + 2 * DAY), 'open']]);
});

function parseCond(rule: string): Expr {
  return parseSpec(`universe: csv:Data/A.csv\nbuy when ${rule}`).spec!.rules.A.buy;
}

test('through of, a column is read as a close would be: the latest row that had ended by the end of the bar', () => {
  // The signal file is weekly, dated Mondays: a row is known from the next Monday on.
  const weekdays = days(30).filter((t) => ![0, 6].includes(new Date(t).getUTCDay()));
  const mondays = [Date.UTC(2020, 0, 6), Date.UTC(2020, 0, 13), Date.UTC(2020, 0, 20)];
  const data = new Map<string, Bars>([['A', bars(weekdays.map((_, i) => 10 + i), { times: weekdays })], ['sig', signals(mondays, { score: [1, 2, 3] })]]);
  const ev = new Evaluator(data);
  const read = ev.eval({ k: 'of', a: { k: 'column', name: 'score' }, asset: 'sig' }, 'A');
  const at = (d: number) => read[weekdays.indexOf(Date.UTC(2020, 0, d))];
  assert.ok(Number.isNaN(at(3)) && Number.isNaN(at(10)));
  // The row of Monday the 6th is known on Monday the 13th, not before, and the 13th's row on the 20th.
  assert.equal(at(13), 1);
  assert.equal(at(17), 1);
  assert.equal(at(20), 2);
  assert.equal(at(24), 2);
});

test('a window of the column worked out on its own file, or on the rule\'s ticker, are both allowed and use different calendars', () => {
  const t = days(8);
  const data = new Map<string, Bars>([['A', bars(t.map((_, i) => 10 + i))], ['sig', signals(t.filter((_, i) => i % 2 === 0), { score: [2, 4, 6, 8] })]]);
  const ev = new Evaluator(data);
  const col: Expr = { k: 'column', name: 'score' };
  // Two rows averaged on the file's own rows, then read on A's bars: a row is known two days after its date, as its step is two days.
  same(ev.eval({ k: 'of', a: { k: 'ind', fn: 'sma', src: col, args: [2] }, asset: 'sig' }, 'A'), [nan, nan, nan, 3, 3, 5, 5, 7]);
  // Two of A's bars averaged after the column was read on them.
  same(ev.eval({ k: 'ind', fn: 'sma', src: { k: 'of', a: col, asset: 'sig' }, args: [2] }, 'A'), [nan, nan, 2, 3, 4, 5, 6, 7]);
});

test('with fill: close a column from another source is read one bar early, and the explanation says which row', () => {
  const t = days(12);
  const data = { A: bars(t.map((_, i) => 100 + i)), sig: signals(t, { score: t.map((_, i) => (i >= 5 ? 5 : 1)) }) };
  const rule = 'universe: A\nbuy when column(score) of csv:Data/sig.csv > 3';
  const open = run(rule, data);
  assert.deepEqual(trades(open), [['A', iso(t[6]), 'open']]);
  assert.equal(open.run.trades[0].why!.buyT, t[5]);
  const close = run(`${rule}\nfill: close`, data);
  // Row 5 is read on bar 6, and the order fills at that bar's close.
  assert.equal(close.run.trades[0].why!.buyT, t[6]);
  assert.deepEqual(trades(close), [['A', iso(t[6]), 'open']]);
  for (const bt of [open, close]) {
    const rows = explainTrade(bt, bt.run.trades[0]).sections.find((s) => s.id === 'bought')!.rows;
    const code = rows.find((r) => r.code)!;
    assert.match(code.label, /column\(score\) of csv:Data\/sig\.csv > 3$/);
    assert.match(code.value, /read from sig's row of 2020-01-06/);
  }
  assert.ok(close.notes.some((n) => n.includes('sig for A')));
});

test('with fill: close a column of a file with the same source and days is read on the same day, like a close', () => {
  const t = days(12).filter((x) => ![0, 6].includes(new Date(x).getUTCDay()));
  const data = { a: bars(t.map((_, i) => 100 + i), { times: t }), sig: signals(t, { score: t.map((_, i) => (i >= 5 ? 5 : 1)) }) };
  const close = run('universe: csv:Data/a.csv\nfill: close\nbuy when column(score) of csv:Data/sig.csv > 3', data);
  assert.equal(close.run.trades[0].why!.buyT, t[5]);
});

test('a ranking by a column holds the ticker with the highest value, tie to the first', () => {
  const t = days(8);
  const a = withColumns(bars([10, 10, 10, 10, 10, 10, 10, 10]), { score: [1, 1, 3, 3, 3, 1, 1, 1] });
  const b = withColumns(bars([20, 20, 20, 20, 20, 20, 20, 20]), { score: [2, 2, 2, 2, 2, 2, 2, 2] });
  const bt = run('universe: csv:Data/a.csv, csv:Data/b.csv\nhold: top 1 by column(score)\nbuy when true', { a, b });
  // b leads on the first two bars, a on bars 2 to 4, b again from bar 5; each change fills at the next open.
  assert.deepEqual(trades(bt), [['b', iso(t[1]), iso(t[3])], ['a', iso(t[3]), iso(t[6])], ['b', iso(t[6]), 'open']]);
  const tie = run('universe: csv:Data/a.csv, csv:Data/b.csv\nhold: top 1 by column(score)\nbuy when true', { a: withColumns(a, { score: [2, 2, 2, 2, 2, 2, 2, 2] }), b });
  assert.equal(tie.run.trades[0].asset, 'a');
  assert.equal(tie.run.trades.length, 1);
});

test('a missing column stops the run with the file, the column asked for and the columns it has', () => {
  const a = withColumns(priced(4), { score: [1, 2, 3, 4], rate: [4, 3, 2, 1] });
  assert.throws(() => run('universe: csv:Data/a.csv\nbuy when column(sentiment) > 0', { a }), (e: Error) => {
    assert.equal(e.message, 'The CSV file a has no column called sentiment. Its columns are score, rate. Only a column with numbers in it can be read.');
    return true;
  });
  assert.throws(() => run('universe: A\nbuy when column(x) of csv:Data/sig.csv > 0', { A: priced(4), sig: signals(days(4), { y: [1, 2, 3, 4] }) }), /The CSV file sig has no column called x\. Its columns are y\./);
  // A file with no columns besides its prices says so.
  assert.throws(() => run('universe: csv:Data/a.csv\nbuy when column(score) > 0', { a: priced(4) }), /The CSV file a has no column called score\. It has no columns besides its prices\./);
});

test('a file with no prices cannot be traded, compared with or used for a cash rate, and its prices cannot be read', () => {
  const sig = signals(days(5), { score: [1, 2, 3, 4, 5] });
  const A = priced(5);
  const why = 'has no prices, only columns\\. A strategy can read its columns with column\\(\\.\\.\\.\\) of sig, but sig cannot';
  assert.throws(() => run('universe: csv:Data/sig.csv\nbuy when column(score) > 0', { sig }), new RegExp(`^Error: sig ${why} be in the universe, because it cannot be traded`));
  assert.throws(() => run('universe: A\nbenchmark: csv:Data/sig.csv\nbuy when true', { A, sig }), new RegExp(`^Error: sig ${why} be the benchmark`));
  assert.throws(() => run('universe: A\ncash rate: csv:Data/sig.csv\nbuy when true', { A, sig }), new RegExp(`^Error: sig ${why} give the cash rate`));
  assert.throws(() => run('universe: A\nbuy when close of csv:Data/sig.csv > 0', { A, sig }), /^Error: sig has no prices, only columns, so its close can't be read\. Read a column with column\(name\) of sig\./);
  assert.throws(() => run('universe: A\nbuy when sma(3) of csv:Data/sig.csv > 0', { A, sig }), /^Error: sig has no prices, only columns, so its close can't be read/);
  assert.throws(() => run('universe: A\nbuy when atr(3) of csv:Data/sig.csv > 0', { A, sig }), /^Error: sig has no prices, only columns, so atr\(\) can't be worked out for it/);
  // What is not a price is allowed: the column itself, and a calendar value or a window of the column.
  assert.equal(run('universe: A\nbuy when sma(column(score), 2) of csv:Data/sig.csv > 1 and month == 1', { A, sig }).run.t.length, 5);
});

test('a strategy that reads no column gives exactly the result it gave before, whatever columns the files carry', () => {
  const plain = bars([10, 11, 12, 11, 13, 14, 12, 15, 16, 14, 17]);
  const loaded = withColumns(plain, { score: plain.c.map((c) => c * 2), other: plain.c.map(() => nan) });
  for (const source of ['universe: A\nbuy when close > sma(3)\nsell when close < sma(3)', 'universe: A\nbuy when rsi(2) < 90\nstop loss: 5%\ncosts: 5 bps']) {
    const x = run(source, { A: plain });
    const y = run(source, { A: loaded });
    assert.deepStrictEqual({ ...y, data: null }, { ...x, data: null });
    assert.equal(JSON.stringify(y.run), JSON.stringify(x.run));
  }
});

// ------------------------------------------------------------------------------------------------ a whole strategy, worked by hand

test('a strategy driven by a signal file: the trade dates follow from the dates of the rows', () => {
  const t = days(12);
  const price = bars([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
  const score = [0.5, 0.6, 0.8, 0.9, 0.5, 0.2, 0.1, 0.6, 0.9, 0.4, 0.2, 0.5];
  const sig = signals(t, { score });
  const rules = 'universe: A\nbuy when column(score) of csv:Data/sig.csv > 0.7\nsell when column(score) of sig < 0.3';
  const bt = run(rules, { A: price, sig });
  // The row of day 2 (0.8) is known at the close of day 2, so the buy fills at the open of day 3, at the price of day 2's close.
  // Row 5 (0.2) is the first below 0.3 while held: the sell fills at the open of day 6. Row 8 (0.9) buys again at day 9's
  // open, and row 10 (0.2) sells at day 11's open.
  assert.deepEqual(trades(bt), [['A', iso(t[3]), iso(t[6])], ['A', iso(t[9]), iso(t[11])]]);
  assert.deepEqual(bt.run.trades.map((x) => [x.entryPrice, x.exitPrice]), [[102, 105], [108, 110]]);
  assert.equal(bt.run.trades[0].reason, 'signal');
  // Dating the rows one day later, as a prediction made on one day and filed on the next would be, delays every trade by a day.
  const later = run(rules, { A: price, sig: signals(t.map((x) => x + DAY), { score }) });
  assert.deepEqual(trades(later), [['A', iso(t[4]), iso(t[7])], ['A', iso(t[10]), 'open']]);
  // The explanation of the first buy names the rule as written, its values, and the row it read.
  const rows = explainTrade(bt, bt.run.trades[0]).sections.find((s) => s.id === 'bought')!.rows;
  const rule = rows.find((r) => r.code)!;
  assert.equal(rule.label, 'buy when column(score) of csv:Data/sig.csv > 0.7');
  assert.equal(rule.value, 'column(score) of csv:Data/sig.csv 0.8000 > 0.7; read from sig\'s row of 2020-01-03');
  assert.equal(rule.outcome, 'yes');
});

test('the same rules on a price file that carries its own column, by name alone', () => {
  const closes = [100, 101, 102, 103, 104, 105, 106, 107];
  const a = withColumns(bars(closes), { score: [0, 0, 1, 1, 1, 0, 0, 0] });
  const bt = run('universe: csv:Data/a.csv\nbuy when column(score) == 1\nsell when column(score) == 0', { a });
  assert.deepEqual(trades(bt), [['a', iso(T0 + 3 * DAY), iso(T0 + 6 * DAY)]]);
});

test('the result notes which files a strategy reads columns of, and says how a row is dated', () => {
  const spec = (src: string) => parseSpec(src).spec!;
  assert.deepEqual(columnNotes(spec('universe: SPY\nbuy when close > sma(5)')), []);
  const one = spec('universe: SPY\nbuy when column(score) of csv:Data/signals.csv > 0');
  assert.deepEqual(columnFiles(one), ['signals']);
  assert.deepEqual(columnNotes(one), ['A row of signals counts as known at the close of the day it is dated, so each row must carry the day whose close its value was computed from: a row dated earlier than the data behind it lets the rules see the future.']);
  const many = spec('universe: csv:Data/a.csv, csv:Data/b.csv\nhold: top 1 by column(x)\nbuy when column(y) of csv:Data/c.csv > 0');
  assert.deepEqual(columnFiles(many), ['c', 'a', 'b']);
  assert.match(columnNotes(many)[0], /^A row of c, a and b counts as known/);
  // One sentence.
  assert.equal(columnNotes(many)[0].split(/\.\s/).length, 1);
});

test('a run through the worker\'s message handler, with the file posted as data, gives what the main thread gives', async () => {
  const t = days(12);
  const data = new Map<string, Bars>([
    ['A', bars([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111])],
    ['sig', signals(t, { score: [0.5, 0.6, 0.8, 0.9, 0.5, 0.2, 0.1, 0.6, 0.9, 0.4, 0.2, 0.5] })],
  ]);
  const source = 'universe: A\nbuy when column(score) of csv:Data/sig.csv > 0.7\nsell when column(score) of sig < 0.3';
  const direct = runBacktest(parseSpec(source).spec!, data);
  const out: FromWorker[] = [];
  const handle = serve((m) => out.push(structuredClone(m)), 0);
  await handle(structuredClone({ type: 'data', id: 1, data } satisfies ToWorker));
  await handle(structuredClone({ type: 'run', id: 3, data: 1, block: { source, defaults: {}, overrides: {} } } satisfies ToWorker));
  assert.equal(out[0].type, 'ran', JSON.stringify(out[0]));
  const back = withInputs((out[0] as { result: Ran }).result, direct.spec, data);
  assert.deepStrictEqual(back, direct);
  // A missing column fails there with the message it has here.
  const bad: FromWorker[] = [];
  const h2 = serve((m) => bad.push(structuredClone(m)), 0);
  await h2(structuredClone({ type: 'data', id: 1, data } satisfies ToWorker));
  await h2(structuredClone({ type: 'run', id: 4, data: 1, block: { source: source.replace('score) of csv', 'nope) of csv'), defaults: {}, overrides: {} } } satisfies ToWorker));
  assert.deepEqual(bad, [{ type: 'error', id: 4, message: 'The CSV file sig has no column called nope. Its columns are score. Only a column with numbers in it can be read.' }]);
});

test('the size of a result counts the columns a file carries', () => {
  const plain = bars(Array.from({ length: 100 }, (_, i) => 10 + i));
  const wide = withColumns(plain, { a: plain.c, b: plain.c, c: plain.c });
  const bt = run('universe: A\nbuy when close > sma(3)', { A: plain });
  const at = (a: Bars) => resultBytes({ data: new Map([['A', a]]), backtest: bt });
  assert.equal(at(wide) - at(plain), 8 * 3 * 100);
  assert.deepEqual(runSize(bt.spec, new Map([['A', wide]])), runSize(bt.spec, new Map([['A', plain]])));
});

test('specEvaluator reads a column the same as a new Evaluator does', () => {
  const a = withColumns(priced(5), { score: [1, 2, 3, 4, 5] });
  const spec = parseSpec('universe: csv:Data/a.csv\nbuy when column(score) > 2').spec!;
  same(specEvaluator(spec, new Map([['a', a]])).eval(spec.rules.a.buy, 'a'), [0, 0, 1, 1, 1]);
  assert.ok(near(1, 1));
});

test('a column adds no history of its own, and the unknown-name message lists column among the functions', () => {
  const look = (src: string) => lookbackBars(parseSpec(src).spec!);
  assert.equal(look('universe: SPY\nbuy when column(x) of csv:Data/s.csv > 0'), 250);
  assert.equal(look('universe: SPY\nbuy when sma(column(x) of csv:Data/s.csv, 300)[10] > 0'), 310);
  assert.match(parseSpec('universe: SPY\nbuy when close > smaa(200)').errors[0].message, /Functions: sma, .*, min, max, abs, column\. Dates:/);
});
