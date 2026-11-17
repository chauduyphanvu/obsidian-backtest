import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mock, test } from 'node:test';
import { SymbolLookup, type LookupDeps } from '../src/symbols.ts';

// The plugin's own `obsidian` package holds only types, so the one class this file needs is stood in for.
const STUB = 'data:text/javascript,' + encodeURIComponent('export class EditorSuggest { constructor(app) { this.app = app; this.context = null; } }');
registerHooks({
  resolve: (specifier, context, next) => (specifier === 'obsidian' ? { url: STUB, shortCircuit: true } : next(specifier, context)),
});
const { StrategySuggest } = await import('../src/editor.ts');

const quote = (symbol: string, name: string, exch: string) => ({ symbol, longname: name, exchDisp: exch, quoteType: 'ETF', typeDisp: 'ETF' });
const SEARCH: Record<string, unknown[]> = {
  AAP: [quote('AAPL', 'Apple Inc.', 'NASDAQ'), quote('AAP', 'Advance Auto Parts, Inc.', 'NYSE')],
  TL: [quote('TLT', 'iShares 20+ Year Treasury Bond ETF', 'NASDAQ')],
  BTC: [quote('BTC-USD', 'Bitcoin USD', 'CCC')],
};
const BINANCE = JSON.stringify(['BTCUSDT', 'BTCUSDC', 'ETHUSDT'].map((symbol) => ({ symbol, price: '1' })));

function network(): { deps: LookupDeps; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    deps: {
      now: () => 1_000_000,
      fetchText: async (url) => {
        urls.push(url);
        if (url.includes('binance')) return BINANCE;
        const q = decodeURIComponent(new URL(url).searchParams.get('q') ?? '');
        return JSON.stringify({ quotes: SEARCH[q] ?? [] });
      },
    },
  };
}

class FakeEditor {
  lines: string[];
  cursor = { line: 0, ch: 0 };
  constructor(text: string) {
    this.lines = text.split('\n');
  }
  getLine(n: number) {
    return this.lines[n];
  }
  lineCount() {
    return this.lines.length;
  }
  replaceRange(text: string, from: { line: number; ch: number }, to: { line: number; ch: number }) {
    const l = this.lines[from.line];
    this.lines[from.line] = l.slice(0, from.ch) + text + l.slice(to.ch);
  }
  setCursor(c: { line: number; ch: number }) {
    this.cursor = c;
  }
}

/** The note: a block whose line 2 is the one being typed. */
const note = (typed: string, extra: string[] = []) => new FakeEditor(['```strategy', 'universe: SPY, binance:ETHUSDT, csv:Data/gold.csv', typed, ...extra, '```'].join('\n'));

function suggestFor(editor: FakeEditor, line: number, options: ConstructorParameters<typeof StrategySuggest>[1]) {
  const suggest = new StrategySuggest({} as never, options);
  const cursor = { line, ch: editor.getLine(line).length };
  const info = suggest.onTrigger(cursor, editor as never);
  if (info) suggest.context = { ...info, editor: editor as never, file: null } as never;
  return { suggest, info, cursor };
}

const labels = (items: { label: string }[]) => items.map((i) => i.label);

test('with no lookup the editor behaves as before: no ticker suggestions, no request', async () => {
  const net = network();
  const closed = { lookup: () => null, csvPaths: () => ['Data/gold.csv'] };
  for (const typed of ['universe: S', 'benchmark: ', 'cash rate: ^V', 'universe: csv:go']) {
    const { info } = suggestFor(note(typed), 2, closed);
    assert.equal(info, null, typed);
  }
  // Everything else still works.
  const { suggest, info } = suggestFor(note('buy when clo'), 2, closed);
  assert.equal(info!.start.ch, 9);
  assert.deepEqual(labels(await suggest.getSuggestions(suggest.context!)), ['close']);
  // Not even given any options at all.
  assert.equal(suggestFor(note('benchmark: '), 2, undefined).info, null);
  assert.deepEqual(net.urls, []);
});

test('a ticker position shows the block’s own tickers at once and asks the lookup only after a pause', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const net = network();
    const lookup = new SymbolLookup(net.deps);
    const { suggest, info } = suggestFor(note('benchmark: s'), 2, { lookup: () => lookup });
    assert.deepEqual(info!.start, { line: 2, ch: 11 });
    const first = suggest.getSuggestions(suggest.context!);
    assert.ok(Array.isArray(first), 'the own tickers are returned without waiting');
    assert.deepEqual(labels(first as never[]), ['SPY']);
    assert.deepEqual(net.urls, [], 'nothing is sent before the pause');
    mock.timers.tick(250);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const sent: string[] = [...net.urls];
    assert.ok(sent.length > 0, 'asked after the pause');
    assert.ok(sent.every((u) => u.includes('q=s') || u.includes('binance')), sent.join(' '));
  } finally {
    mock.timers.reset();
  }
});

test('with nothing of the block’s own to show, the hits are awaited and shown with name and exchange', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const net = network();
    const lookup = new SymbolLookup(net.deps);
    const { suggest } = suggestFor(note('universe: SPY, AAP'), 2, { lookup: () => lookup });
    const pending = suggest.getSuggestions(suggest.context!) as Promise<{ label: string; insert: string; detail: string }[]>;
    assert.ok(pending instanceof Promise);
    mock.timers.tick(250);
    const items = await pending;
    assert.deepEqual(labels(items), ['AAPL', 'AAP']);
    assert.equal(items[0].detail, 'Apple Inc. · NASDAQ · ETF');
    // Only the word being typed was sent.
    const sent: string[] = [...net.urls];
    assert.ok(sent.some((u) => u.endsWith('q=AAP&quotesCount=8&newsCount=0')));
    assert.ok(sent.every((u) => !u.includes('SPY') && !u.includes('universe')));
    // Choosing one writes it over the word being typed.
    const editor = suggest.context!.editor as unknown as FakeEditor;
    suggest.selectSuggestion(items[0]);
    assert.equal(editor.getLine(2), 'universe: SPY, AAPL');
    assert.deepEqual(editor.cursor, { line: 2, ch: 19 });
  } finally {
    mock.timers.reset();
  }
});

test('a hit from the other source is written with its prefix, a typed prefix is kept', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const lookup = new SymbolLookup(network().deps);
    const yahooBlock = suggestFor(note('benchmark: BTC'), 2, { lookup: () => lookup, defaults: () => ({ dataSource: 'yahoo' }) });
    const waiting = yahooBlock.suggest.getSuggestions(yahooBlock.suggest.context!) as Promise<{ label: string }[]>;
    mock.timers.tick(250);
    assert.deepEqual(labels(await waiting), ['BTC-USD', 'binance:BTCUSDT', 'binance:BTCUSDC']);

    const binanceBlock = suggestFor(note('data: binance', ['benchmark: BTC']), 3, { lookup: () => lookup });
    const second = binanceBlock.suggest.getSuggestions(binanceBlock.suggest.context!);
    mock.timers.tick(250);
    assert.deepEqual(labels(await second), ['BTCUSDT', 'BTCUSDC', 'yahoo:BTC-USD']);

    const typed = suggestFor(note('benchmark: binance:BTC'), 2, { lookup: () => lookup });
    const third = typed.suggest.getSuggestions(typed.suggest.context!);
    mock.timers.tick(250);
    assert.deepEqual(labels(await third), ['binance:BTCUSDT', 'binance:BTCUSDC']);
    assert.deepEqual(typed.info!.start, { line: 2, ch: 11 }, 'the prefix is part of the word replaced');
  } finally {
    mock.timers.reset();
  }
});

test('hits already known are shown at once, after the block’s own tickers', async () => {
  const lookup = new SymbolLookup(network().deps);
  await lookup.suggest('TL', 'yahoo');
  const { suggest } = suggestFor(note('benchmark: TL'), 2, { lookup: () => lookup });
  const items = suggest.getSuggestions(suggest.context!);
  assert.ok(Array.isArray(items));
  assert.deepEqual(labels(items as never[]), ['TLT']);
});

test('typing on before an answer arrives leaves the list open with the latest hits', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const lookup = new SymbolLookup(network().deps);
    const editor = note('universe: SPY, AAP');
    const suggest = new StrategySuggest({} as never, { lookup: () => lookup });
    // What Obsidian 1.15 does with each key (app.js, EditorSuggest.trigger and showSuggestions): it awaits a promised
    // answer and shows it, and an empty answer closes the list and forgets the context, so a later answer is not shown.
    let shown: string[] | null = null;
    const show = (items: { label: string }[]) => {
      if (items.length === 0) {
        suggest.context = null;
        shown = null;
      } else if (suggest.context) shown = labels(items);
    };
    const answers: Promise<void>[] = [];
    const type = (typed: string) => {
      editor.lines[2] = typed;
      const info = suggest.onTrigger({ line: 2, ch: typed.length }, editor as never)!;
      const context = (suggest.context = { ...info, editor: editor as never, file: null } as never);
      const items = suggest.getSuggestions(context) as Promise<{ label: string }[]>;
      answers.push(items.then((d) => d && show(d)));
    };
    type('universe: SPY, AA');
    type('universe: SPY, AAP');
    mock.timers.tick(250);
    await answers[1];
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.deepEqual(shown, ['AAPL', 'AAP'], 'the AAP search is shown; the overtaken AA request never answered');
  } finally {
    mock.timers.reset();
  }
});

test('weights are left alone: only the ticker word is completed', () => {
  const lookup = new SymbolLookup(network().deps);
  for (const typed of ['universe: SPY 6', 'universe: SPY 60%', 'universe: SPY 60%, TLT 4', 'universe: SPY ', 'name: SP']) {
    assert.equal(suggestFor(note(typed), 2, { lookup: () => lookup }).info, null, typed);
  }
  assert.deepEqual(suggestFor(note('universe: SPY 60%, TL'), 2, { lookup: () => lookup }).info!.start, { line: 2, ch: 19 });
});

test('after csv: the vault’s CSV files are offered, from the function the caller gives', () => {
  const lookup = new SymbolLookup(network().deps);
  const files = ['Data/gold.csv', 'Data/silver.csv', 'Data/with space.csv'];
  const { suggest, info } = suggestFor(note('universe: csv:Data/g'), 2, { lookup: () => lookup, csvPaths: () => files });
  assert.deepEqual(info!.start, { line: 2, ch: 10 });
  assert.deepEqual(labels(suggest.getSuggestions(suggest.context!) as never[]), ['csv:Data/gold.csv']);
  assert.equal(suggestFor(note('universe: csv:zzz'), 2, { lookup: () => lookup, csvPaths: () => files }).info, null);
});

test('settings and rule completions are unchanged when the lookup is on', async () => {
  const lookup = new SymbolLookup(network().deps);
  const { suggest, info } = suggestFor(note('rebalance: m'), 2, { lookup: () => lookup });
  assert.equal(info!.start.ch, 11);
  assert.deepEqual(labels(await suggest.getSuggestions(suggest.context!)), ['monthly']);
  const rule = suggestFor(note('buy when close of '), 2, { lookup: () => lookup });
  assert.deepEqual(labels(await rule.suggest.getSuggestions(rule.suggest.context!)), ['SPY', 'ETHUSDT', 'gold']);
});

test('rendering: a hit has a class of its own so a long name can be cut short', () => {
  const added: string[] = [];
  const spans: { cls: string; text: string }[] = [];
  const el = { addClass: (c: string) => added.push(c), createSpan: (o: { cls: string; text: string }) => spans.push(o) };
  const suggest = new StrategySuggest({} as never);
  suggest.renderSuggestion({ label: 'AAPL', insert: 'AAPL', detail: 'Apple Inc. · NASDAQ', hit: true }, el as never);
  suggest.renderSuggestion({ label: 'sma', insert: 'sma(', detail: 'x' }, el as never);
  assert.deepEqual(added, ['bt-suggest', 'bt-suggest-hit', 'bt-suggest']);
  assert.deepEqual(spans.map((s) => s.cls), ['bt-suggest-label', 'bt-suggest-detail', 'bt-suggest-label', 'bt-suggest-detail']);
});
