// Columns of a CSV file everywhere the language is listed or a file is looked at: help, completion, colours, the drafting
// prompt, the README, and the "Use a CSV file in a strategy" helper.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { complete, columnWord, csvFiles } from '../src/complete.ts';
import { csvColumnNames, parseCsv } from '../src/data.ts';
import { ALL_DOCS, docFor, helpAt } from '../src/docs.ts';
import { parseSpec } from '../src/dsl.ts';
import { SIGNAL_DATING, cleanedPath, csvColumn, inspectCsv, remapCsv, type CsvCleaned, type CsvMapping, type CsvRead, type CsvUnread } from '../src/csv-import.ts';
import { tokenize, tokenizeBlock } from '../src/highlight.ts';
import { SYSTEM_PROMPT } from '../src/llm.ts';
import { blockTickers } from '../src/symbols.ts';
import { MAX_COLUMNS } from '../src/types.ts';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

// ------------------------------------------------------------------------------------------------ help, colours, completion

test('help for column covers the word, the brackets\' name and nothing else, and its example parses', () => {
  const doc = docFor('column')!;
  assert.equal(doc.kind, 'function');
  assert.equal(doc.signature, 'column(name) of file');
  assert.ok(doc.text.includes('A row counts as known at the close of the day it is dated.'));
  assert.ok(ALL_DOCS.includes(doc));
  const lines = ['universe: SPY', 'buy when column(score) of csv:Data/signals.csv > 0.7 and column("News Sentiment") of signals > 1'];
  const at = (col: number) => {
    const t = helpAt(lines, 1, col);
    return t ? { id: t.doc.id, text: lines[1].slice(t.from, t.to) } : null;
  };
  const row = lines[1];
  assert.deepEqual(at(row.indexOf('column') + 2), { id: 'column', text: 'column' });
  assert.deepEqual(at(row.indexOf('score') + 1), { id: 'column', text: 'score' });
  assert.deepEqual(at(row.indexOf('"News') + 3), { id: 'column', text: '"News Sentiment"' });
  assert.deepEqual(at(row.indexOf('of csv')), { id: 'of', text: 'of' });
  // A column named like a word of the language shows the help of column, not of that word.
  const named = ['universe: csv:Data/a.csv', 'buy when column(month) > 5'];
  const t = helpAt(named, 1, named[1].indexOf('month') + 1)!;
  assert.equal(t.doc.id, 'column');
});

test('a column is coloured as a function with its name as a series, quoted or not, and its file as a ticker', () => {
  const kinds = (line: string) => tokenizeBlock([line])[0].map((t) => `${t.kind}:${line.slice(t.from, t.to)}`);
  assert.deepEqual(kinds('buy when column(score) of signals > 0.7'), ['keyword:buy', 'keyword:when', 'function:column', 'operator:(', 'series:score', 'operator:)', 'keyword:of', 'ticker:signals', 'operator:>', 'number:0.7']);
  assert.deepEqual(kinds('buy when column( "News Sentiment" ) > 1'), ['keyword:buy', 'keyword:when', 'function:column', 'operator:(', 'series:"News Sentiment"', 'operator:)', 'operator:>', 'number:1']);
  assert.deepEqual(kinds('buy when column(10y) > 1').slice(2, 5), ['function:column', 'operator:(', 'series:10y']);
  // A name is never taken for a word of the language or a parameter, and not for a ticker to look up.
  const more = '  or column(close) > sma(column(month), 5)';
  assert.deepEqual(tokenize(more, 'continuation', ['close']).filter((t) => t.kind === 'series').map((t) => more.slice(t.from, t.to)), ['close', 'month']);
  const lines = ['universe: SPY', 'buy when column(score) of csv:Data/signals.csv > 0.7'];
  assert.deepEqual(blockTickers(lines).map((t) => t.ticker), ['SPY']);
  // A half-written column is coloured as far as it goes, and a missing bracket does not break the rest.
  assert.deepEqual(kinds('buy when column(sc').slice(2), ['function:column', 'operator:(', 'series:sc']);
  assert.deepEqual(kinds('buy when column(').slice(2), ['function:column', 'operator:(']);
  // A parameter that happens to be called column is still a parameter.
  assert.deepEqual(tokenize('buy when close > column', 'rule', ['column']).map((t) => t.kind), ['keyword', 'keyword', 'series', 'operator', 'param']);
});

test('completion: column offers the file names of the block and, inside the brackets, the columns the plugin knows', () => {
  const block = ['universe: SPY', 'buy when column(sc'];
  const labels = (before: string, blk = block, known?: (p: string) => readonly string[] | undefined) => complete(blk, blk.slice(0, -1), before, known)?.items.map((i) => i.label) ?? null;
  assert.ok(labels('buy when colu')!.includes('column'));
  assert.equal(complete(block, [block[0]], 'buy when colu')!.items.find((i) => i.label === 'column')!.insert, 'column(');
  assert.match(complete(block, [block[0]], 'buy when colu')!.items.find((i) => i.label === 'column')!.detail, /column\(name\) of file/);

  const named = ['universe: SPY', 'buy when column(sc) of csv:Data/signals.csv > 0 and column(sc'];
  const known = (path: string) => (path === 'Data/signals.csv' ? ['score', 'rate', 'news_sentiment'] : undefined);
  assert.deepEqual(labels('buy when column(sc', named, known), ['score']);
  assert.deepEqual(labels('buy when column(', named, known), ['score', 'rate', 'news_sentiment']);
  assert.deepEqual(labels('buy when column("news', named, known), ['news_sentiment']);
  assert.equal(complete(named, [named[0]], 'buy when column(sc', known)!.from, 'buy when column('.length);
  assert.equal(complete(named, [named[0]], 'buy when column("news', known)!.from, 'buy when column("'.length);
  assert.equal(complete(named, [named[0]], 'buy when column(sc', known)!.items[0].detail, 'column of signals.csv');
  // Nothing is offered when no file is named, when the columns of the files are not known, or once the name is complete.
  assert.equal(labels('buy when column(sc', block, known), null);
  assert.equal(labels('buy when column(sc', named), null);
  assert.equal(labels('buy when column(score', named, known), null);
  // Nor are series or functions, which would be wrong inside the brackets: no `close` after `column(c`.
  assert.equal(labels('buy when column(c', named, known), null);
  // It works in a ranking and on a continuation line too.
  const rank = ['universe: csv:Data/a.csv, csv:Data/b.csv', 'hold: top 1 by column(s'];
  assert.deepEqual(complete(rank, [rank[0]], 'hold: top 1 by column(s', (p) => (p.endsWith('a.csv') ? ['s1'] : ['s2']))!.items.map((i) => i.label), ['s1', 's2']);
  assert.deepEqual(complete(named, named, '   or column(', known)!.items.length, 3);
});

test('columnWord and csvFiles read a block the way the parser does', () => {
  assert.equal(columnWord('buy when column('), '');
  assert.equal(columnWord('buy when column( sco'), 'sco');
  assert.equal(columnWord('buy when column("News Se'), 'News Se');
  assert.equal(columnWord('buy when column(score)'), null);
  assert.equal(columnWord('buy when closing(x'), null);
  assert.equal(columnWord('buy when sma(column(sco'), 'sco');
  assert.deepEqual(csvFiles(['universe: csv:Data/a.csv, SPY', 'buy when column(x) of csv:Data/B.csv > 0 # csv:Data/c.csv', 'sell when column(x) of csv:data/b.csv < 0']), ['Data/a.csv', 'Data/B.csv']);
});

test('csvColumnNames reads the names from the first line alone, as parseCsv does from the rows', () => {
  const text = 'Date,Open,High,Low,Close,Volume,Score,News Sentiment,news-sentiment,Adj Close,Symbol\n2024-01-02,1,2,1,2,10,3,4,5,2,SPY';
  assert.deepEqual(csvColumnNames(text), ['score', 'news_sentiment', 'symbol']);
  // The rows then drop what holds no numbers and the clash.
  assert.deepEqual(parseCsv(text).columns!.map((c) => c.name), ['score']);
  assert.deepEqual(csvColumnNames('date;Score;Model Score\n2024-01-02;1;2'), ['score', 'model_score']);
  assert.deepEqual(csvColumnNames(''), []);
  assert.equal(csvColumnNames(`Date,Close,${Array.from({ length: 80 }, (_, i) => `c${i}`).join(',')}`).length, MAX_COLUMNS);
});

test('the drafting prompt says how a column is read, and an example in it parses', () => {
  assert.ok(SYSTEM_PROMPT.includes('column(score) of csv:Data/signals.csv'));
  assert.ok(SYSTEM_PROMPT.includes('A row counts as known at the close of the day it is dated.'));
  assert.ok(SYSTEM_PROMPT.includes('A file with only a date and columns can be read with "of" but not traded.'));
  assert.match(SYSTEM_PROMPT, /Never invent a file or a column the description does not name\./);
  assert.deepEqual(parseSpec('universe: SPY\nbuy when column(score) of signals > 0.7').errors.map((e) => e.message.slice(0, 13)), ['SIGNALS comes']);
  assert.deepEqual(parseSpec('universe: SPY\nbuy when column(score) of csv:Data/signals.csv > 0.7\nsell when sma(column(score) of signals, 10) < 0').errors, []);
});

test('the README has the subsection, its names and its dating rule, and the sample error lists column', () => {
  assert.match(readme, /^### Signals from a CSV file$/m);
  for (const part of ['`column(score) of signals`', '`column("News Sentiment")`', 'news_sentiment', 'A row dated Tuesday is known at Tuesday\'s close', 'the order it gives fills at Wednesday\'s open', 'the classic way to cheat by accident', 'At most 50 columns', 'This file has no prices. A strategy can read its columns but cannot trade it.']) {
    assert.ok(readme.includes(part), part);
  }
  assert.ok(readme.includes('abs, column. Dates:'));
  assert.ok(readme.includes(`"${'This file has no prices. A strategy can read its columns but cannot trade it.'}"`));
  // The README's account of the dating is the helper window's.
  assert.ok(SIGNAL_DATING.includes("A row counts as known at the end of the day it is dated."));
});

// ------------------------------------------------------------------------------------------------ the helper

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const priced = (n: number, extra: (i: number) => string, head = 'Date,Open,High,Low,Close,Volume,Score,News Sentiment') =>
  `${head}\n${Array.from({ length: n }, (_, i) => `${iso(Date.UTC(2024, 0, 2) + i * 86_400_000)},10,11,9,10,100,${extra(i)}`).join('\n')}\n`;
const read = (text: string): CsvRead => {
  const r = inspectCsv(text);
  assert.ok(r.read, `expected the file to be read, but: ${(r as CsvUnread).reason}`);
  return r;
};
const cleaned = (c: CsvCleaned) => {
  assert.ok(c.ok, c.ok ? '' : c.reason);
  return c;
};

test('a price file with extra columns lists them with the name to type, the first and last value and the rows that have one', () => {
  const r = read(priced(130, (i) => `${(i / 100).toFixed(2)},${i % 2 === 0 ? i : ''}`));
  assert.equal(r.priced, true);
  assert.deepEqual(r.signals.map((s) => s.name), ['score', 'news_sentiment']);
  const [score, news] = r.signals;
  assert.deepEqual([score.header, score.first, score.last, score.count], ['Score', { date: '2024-01-02', value: 0 }, { date: '2024-05-10', value: 1.29 }, 130]);
  assert.deepEqual([news.header, news.first.value, news.last.value, news.count], ['News Sentiment', 0, 128, 65]);
  assert.equal(news.last.date, '2024-05-09');
  assert.deepEqual(r.unreadable, []);
  assert.equal(r.head.length, 3);
  assert.deepEqual(r.doubts, []);
  // A file with none says so with an empty list, and reads as before.
  assert.deepEqual(read(priced(130, () => '', 'Date,Open,High,Low,Close,Volume,Score').replace(/,\n/g, ',\n')).signals.map((s) => s.name), []);
});

test('a file with no prices is described as one, with its columns, and is not offered anything that would trade it', () => {
  const text = `date,Model Score,rate\n${Array.from({ length: 40 }, (_, i) => `${iso(Date.UTC(2024, 0, 2) + i * 86_400_000)},${i / 10},${i % 4 === 0 ? '' : 3}`).join('\n')}\n`;
  const r = read(text);
  assert.equal(r.priced, false);
  assert.equal(r.rows, 40);
  assert.deepEqual([r.first, r.last], ['2024-01-02', '2024-02-10']);
  assert.deepEqual([r.head, r.tail], [[], []]);
  assert.deepEqual(r.signals.map((s) => [s.name, s.header, s.count]), [['model_score', 'Model Score', 40], ['rate', 'rate', 30]]);
  assert.deepEqual(r.columns, { date: 0, open: null, high: null, low: null, close: null, volume: null, adjClose: null, dateOrder: null });
  // No remark about the volume or the starter strategy, which are about prices.
  assert.deepEqual(r.doubts, []);
  // The same helper checks that the date is read and says what it skipped.
  const messy = read('date,score\n2024-01-02,1\nsoon,2\n2024-01-02,3\n2024-01-03,4\n');
  assert.equal(messy.rows, 2);
  assert.deepEqual(messy.doubts, ['2 of 4 rows were skipped: 1 with a date that could not be read, 1 that repeat a date already read.']);
  // A file of dates and text is still not readable, and says so as before.
  const sales = inspectCsv('date,customer,status\n2024-01-02,Ann,paid\n');
  assert.equal(sales.read, false);
});

test('the rule that reads a column names the file after of, and a path that cannot be written there is explained', () => {
  const ok = csvColumn('Data/signals.csv', 'score', false);
  assert.deepEqual(ok, { ok: true, text: 'column(score) of csv:Data/signals.csv', note: null });
  assert.deepEqual(parseSpec(`universe: SPY\nbuy when ${(ok as { text: string }).text} > 0`).errors, []);
  assert.deepEqual(csvColumn('Data/a.csv', '10y_yield', false), { ok: true, text: 'column(10y_yield) of csv:Data/a.csv', note: null });
  assert.match((csvColumn('Data/my signals.csv', 'score', false) as { reason: string }).reason, /has a space in it/);
  // A path whose characters work on a universe line but not after "of": a price file reads its own column, a signal file cannot be read.
  const odd = 'Data/é.csv';
  const own = csvColumn(odd, 'score', true);
  assert.ok(own.ok && own.text === 'column(score)' && /put it on the universe or symbol line/.test(own.note ?? ''));
  assert.deepEqual(parseSpec(`symbol: csv:${odd}\nbuy when column(score) > 0`).errors, []);
  const none = csvColumn(odd, 'score', false);
  assert.ok(!none.ok && /This file has no prices.*Rename the file/.test(none.reason));
});

test('a cleaned copy keeps the columns with numbers, under their own headers, and a copy of the copy is the same', () => {
  const text = 'Day,Settle,Hi,Lo,Op,Vol,Score,Model Rating,Comment\n2024-01-03,11,12,10,10.5,100,"1,5",8,ok\n2024-01-02,10,11,9,9.5,90,0.5,,hm\n';
  const m: CsvMapping = { date: 0, close: 1, high: 2, low: 3, open: 4, volume: 5, adjClose: null, dateOrder: null };
  const c = cleaned(remapCsv(text, m));
  assert.equal(c.text.split('\n')[0], 'date,open,high,low,close,volume,Score,Model Rating');
  assert.deepEqual(c.columns, ['score', 'model_rating']);
  assert.ok(c.notes.includes('The other columns with numbers in them were kept, and a rule reads them by name: score, model_rating.'));
  // "1,5" is read with a decimal comma, as the prices are, in a file whose fields are quoted.
  const bars = parseCsv(c.text);
  assert.deepEqual(bars.columns!.map((x) => [x.name, x.v.map((n) => (Number.isNaN(n) ? 'nan' : n))]), [['score', [0.5, 1.5]], ['model_rating', ['nan', 8]]]);
  assert.match(c.notes.join(' '), /decimal comma/);
  const again = cleaned(remapCsv(c.text, read(c.text).columns));
  assert.equal(again.text, c.text);
  assert.deepEqual(read(c.text).signals.map((s) => s.name), ['score', 'model_rating']);
  assert.equal(cleanedPath('Data/x.csv'), 'Data/x-clean.csv');
});

test('a cleaned copy leaves out a column that would clash, one that reads as a price, and what is past the limit', () => {
  const clash = cleaned(remapCsv('Date,Close,News Sentiment,news-sentiment,Volume\n2024-01-02,1,2,3,4\n', { date: 0, close: 1, open: null, high: null, low: null, volume: null, adjClose: null, dateOrder: null }));
  assert.deepEqual(clash.columns, ['news_sentiment']);
  assert.equal(clash.text.split('\n')[0], 'date,open,high,low,close,volume,News Sentiment');
  assert.ok(clash.notes.includes('The column "news-sentiment" was left out: a rule would call it news_sentiment, as it does "News Sentiment".'));
  const many = Array.from({ length: MAX_COLUMNS + 3 }, (_, i) => `k${i}`);
  const wide = cleaned(remapCsv(`Date,Close,${many.join(',')}\n2024-01-02,1,${many.map((_, i) => i).join(',')}\n`, { date: 0, close: 1, open: null, high: null, low: null, volume: null, adjClose: null, dateOrder: null }));
  assert.equal(wide.columns.length, MAX_COLUMNS);
  assert.ok(wide.notes.includes(`Only the first ${MAX_COLUMNS} columns of a file can be read, so these were left out: k${MAX_COLUMNS}, k${MAX_COLUMNS + 1}, k${MAX_COLUMNS + 2}.`));
  // A header with a comma is written in quotes, and read back as the same column.
  const comma = cleaned(remapCsv('Date,Close,"Rate, 10Y"\n2024-01-02,1,5\n', { date: 0, close: 1, open: null, high: null, low: null, volume: null, adjClose: null, dateOrder: null }));
  assert.equal(comma.text.split('\n')[0], 'date,open,high,low,close,volume,"Rate, 10Y"');
  assert.deepEqual(parseCsv(comma.text).columns!.map((c) => c.name), ['rate_10y']);
});

test('what the window says about columns that no rule can read', () => {
  const clash = read(priced(5, () => '1,2', 'Date,Open,High,Low,Close,Volume,News Sentiment,news-sentiment'));
  assert.deepEqual(clash.signals, []);
  assert.deepEqual(clash.unreadable, ['2 columns would all be called news_sentiment: "News Sentiment" and "news-sentiment". Rename all but one in the file.'.replace(/^2/, '2')]);
  const many = Array.from({ length: MAX_COLUMNS + 2 }, (_, i) => `k${i}`);
  const wide = read(`Date,Open,High,Low,Close,${many.join(',')}\n${Array.from({ length: 3 }, (_, d) => `2024-01-0${d + 2},1,2,1,2,${many.map(() => 1).join(',')}`).join('\n')}\n`);
  assert.equal(wide.signals.length, MAX_COLUMNS);
  assert.deepEqual(wide.unreadable, [`Only the first ${MAX_COLUMNS} columns of a file can be read. These were left out: k${MAX_COLUMNS}, k${MAX_COLUMNS + 1}.`]);
});

test('a file whose headers look like prices to the helper is a price file to clean, not a file of signals', () => {
  const days = (n: number) => Array.from({ length: n }, (_, i) => iso(Date.UTC(2023, 0, 2) + i * 86_400_000));
  const closes = days(300).map((d, i) => `${d},${(100 + Math.sin(i / 9) * 5).toFixed(2)}`);
  for (const head of ['Date,Price', 'Date,Last', 'Date,Settle', 'Date,NAV', 'Date,Adj Close', 'Date,Value']) {
    const text = [head, ...closes].join('\n');
    assert.throws(() => parseCsv(text), /The CSV needs a header row with date, open, high, low and close columns/, head);
    const found = inspectCsv(text) as CsvUnread;
    assert.equal(found.read, false, head);
    // The window offers its form with the price column guessed, and a cleaned copy reads as a price file.
    assert.equal(found.columns.close, 1, head);
    const cleaned = remapCsv(text, { ...found.columns, dateOrder: null });
    assert.ok(cleaned.ok, head);
    if (cleaned.ok) assert.equal(parseCsv(cleaned.text).unpriced, undefined, head);
    assert.ok(found.reason.endsWith(` If "${head.slice(5)}" holds something other than prices, give it another name, and the file is read as a file of signals.`), found.reason);
  }
  const ohlc = days(50).map((d, i) => `${d},${100 + i},${101 + i},${99 + i},${100.5 + i},1000`);
  for (const head of ['Date,Open Price,High Price,Low Price,Close Price,Volume', 'Date,Opening,Highest,Lowest,Closing,Volume', 'Date,Open*,High*,Low*,Close*,Volume']) {
    const text = [head, ...ohlc].join('\n');
    const found = inspectCsv(text) as CsvUnread;
    assert.equal(found.read, false, head);
    assert.deepEqual([found.columns.open, found.columns.high, found.columns.low, found.columns.close, found.columns.volume], [1, 2, 3, 4, 5], head);
    const cleaned = remapCsv(text, { ...found.columns, dateOrder: null });
    assert.ok(cleaned.ok && parseCsv(cleaned.text).c.length === 50, head);
  }
  // A real file of signals still reads as one, with its columns.
  const sig = inspectCsv(['date,score,news sentiment,volume', ...days(30).map((d, i) => `${d},${i / 10},${-i / 20},${i}`)].join('\n')) as CsvRead;
  assert.equal(sig.read && sig.priced, false);
  assert.deepEqual(sig.signals.map((s) => s.name), ['score', 'news_sentiment', 'volume']);
});
