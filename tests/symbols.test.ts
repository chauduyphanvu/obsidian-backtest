import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec } from '../src/dsl.ts';
import { SymbolLookup, blockSource, blockTickers, unknownTickerMessage, writtenAs, type LookupDeps, type SymbolHit } from '../src/symbols.ts';

// Trimmed from real answers of query2.finance.yahoo.com/v1/finance/search?q=...&quotesCount=8&newsCount=0
const quote = (symbol: string, shortname: string, longname: string | undefined, exchDisp: string, quoteType: string, typeDisp: string) => ({
  exchange: 'X',
  shortname,
  quoteType,
  symbol,
  index: 'quotes',
  typeDisp,
  ...(longname ? { longname } : {}),
  exchDisp,
  isYahooFinance: true,
});
const yahoo = (...quotes: ReturnType<typeof quote>[]) => JSON.stringify({ explains: [], count: quotes.length, quotes, news: [] });

const ANSWERS: Record<string, string> = {
  SPY: yahoo(
    quote('SPY', 'State Street SPDR S&P 500 ETF T', 'State Street SPDR S&P 500 ETF Trust', 'NYSEArca', 'ETF', 'ETF'),
    quote('SPYM', 'State Street SPDR Portfolio S&P', 'State Street SPDR Portfolio S&P 500 ETF', 'NYSEArca', 'ETF', 'ETF'),
    quote('SPYI', 'NEOS S&P 500 High Income ETF', 'Neos S&P 500(R) High Income ETF', 'BATS Trading', 'ETF', 'ETF'),
  ),
  '^GSPC': yahoo(quote('^GSPC', 'S&P 500', 'S&P 500', 'SNP', 'INDEX', 'Index')),
  SPYY: yahoo(
    quote('SPYY.DE', 'SGASE1-STS.S.MSCI A.C.W U.E.  R', 'State Street SPDR MSCI All Country World UCITS ETF', 'XETRA', 'ETF', 'ETF'),
    quote('SPYYD.XD', 'SS SPDR MSCI All Country World ', undefined, 'DXE', 'ETF', 'ETF'),
  ),
  'BRK.B': yahoo(
    quote('BRKC', 'YieldMax BRK.B Option Income St', 'YieldMax BRK.B Option Income Strategy ETF', 'NYSEArca', 'ETF', 'ETF'),
    quote('BRKB261113C00532500', 'BRK.B Nov 2026 532.500 call', 'BRK.B Nov 2026 532.500 call', 'OPR', 'OPTION', 'Option'),
  ),
  'BRK-B': yahoo(quote('BRK-B', 'Berkshire Hathaway Inc. New', 'Berkshire Hathaway Inc.', 'NYSE', 'EQUITY', 'Equity'), quote('BRKU', 'Direxion Daily BRKB Bull 2X ETF', undefined, 'NASDAQ', 'ETF', 'ETF')),
  'EURUSD=X': yahoo(quote('EURUSD=X', 'EUR/USD', 'EUR/USD', 'CCY', 'CURRENCY', 'Currency')),
  'BTC-USD': yahoo(quote('BTC-USD', 'Bitcoin USD', 'Bitcoin USD', 'CCC', 'CRYPTOCURRENCY', 'Cryptocurrency')),
  BTC: yahoo(quote('BTC-USD', 'Bitcoin USD', 'Bitcoin USD', 'CCC', 'CRYPTOCURRENCY', 'Cryptocurrency'), quote('BTC.DE', 'BTC Deutschland', undefined, 'XETRA', 'ETF', 'ETF')),
};

// The start of the real answer of data-api.binance.vision/api/v3/ticker/price, with the markets the tests use.
const BINANCE = JSON.stringify(
  ['ETHBTC', 'BNBBTC', 'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'BTCUSDC', 'BTCEUR', 'BTCTRY', 'DOGEUSDT', 'SOLUSDT', 'WBTCBTC', 'BTCFDUSD'].map((symbol) => ({ symbol, price: '1.00000000' })),
);

interface Net {
  deps: LookupDeps;
  urls: string[];
  clock: { t: number };
  /** Hosts that fail, or a function that decides per URL. */
  fail: Set<string>;
  /** Bodies to send instead of the usual ones, by URL substring. */
  body: Map<string, string>;
  pending: { url: string; done: () => void }[];
  hold: boolean;
  /** The most requests that were ever open at once. */
  most: number;
}

function net(): Net {
  const n: Net = { urls: [], clock: { t: 1_000_000 }, fail: new Set(), body: new Map(), pending: [], hold: false, most: 0, deps: null as never };
  let open = 0;
  const answer = (url: string): string => {
    for (const [part, text] of n.body) if (url.includes(part)) return text;
    if (url.startsWith('https://data-api.binance.vision/api/v3/ticker/price')) return BINANCE;
    const q = decodeURIComponent(new URL(url).searchParams.get('q') ?? '');
    return ANSWERS[q] ?? yahoo();
  };
  n.deps = {
    now: () => n.clock.t,
    fetchText: async (url) => {
      n.urls.push(url);
      n.most = Math.max(n.most, ++open);
      try {
        if ([...n.fail].some((h) => url.includes(h))) throw new Error('HTTP 429');
        if (n.hold) await new Promise<void>((resolve) => n.pending.push({ url, done: resolve }));
        return answer(url);
      } finally {
        open--;
      }
    },
  };
  return n;
}

const tickers = (hits: SymbolHit[]) => hits.map((h) => h.ticker);

test('search: parses symbol, name, exchange and kind; options are left out', async () => {
  const n = net();
  const lookup = new SymbolLookup(n.deps);
  const hits = await lookup.search('SPY', 'yahoo');
  assert.deepEqual(hits[0], { ticker: 'SPY', name: 'State Street SPDR S&P 500 ETF Trust', detail: 'NYSEArca · ETF', source: 'yahoo' });
  assert.deepEqual(tickers(hits), ['SPY', 'SPYM', 'SPYI']);
  // The short name is used when there is no long one.
  assert.equal((await lookup.search('BTC', 'yahoo'))[1].name, 'BTC Deutschland');
  assert.deepEqual(tickers(await lookup.search('BRK.B', 'yahoo')), ['BRKC']);
});

test('requests carry only the ticker, encoded, on the two Yahoo hosts and the Binance price list', async () => {
  const n = net();
  const lookup = new SymbolLookup(n.deps);
  await lookup.search('^GSPC', 'yahoo');
  await lookup.search('EURUSD=X', 'yahoo');
  await lookup.search('brk.b', 'yahoo');
  await lookup.search('BTC', 'binance');
  assert.deepEqual(n.urls, [
    'https://query2.finance.yahoo.com/v1/finance/search?q=%5EGSPC&quotesCount=8&newsCount=0',
    'https://query2.finance.yahoo.com/v1/finance/search?q=EURUSD%3DX&quotesCount=8&newsCount=0',
    'https://query2.finance.yahoo.com/v1/finance/search?q=brk.b&quotesCount=8&newsCount=0',
    'https://data-api.binance.vision/api/v3/ticker/price',
  ]);
});

test('text that is not a ticker is never sent', async () => {
  const n = net();
  const lookup = new SymbolLookup(n.deps);
  for (const bad of ['', '  ', 'my notes about SPY', 'SPY, TLT', 'a/b', 'x'.repeat(30), '$SPY', 'SPY%']) {
    assert.deepEqual(await lookup.search(bad, 'yahoo'), [], JSON.stringify(bad));
    assert.equal(await lookup.check(bad, 'yahoo'), 'unsure', JSON.stringify(bad));
  }
  assert.deepEqual(n.urls, []);
});

test('check: an exact symbol, in any case, is known; one that is not listed is unknown', async () => {
  const n = net();
  const lookup = new SymbolLookup(n.deps);
  assert.equal(await lookup.check('SPY', 'yahoo'), 'known');
  assert.equal(await lookup.check('spy', 'yahoo'), 'known');
  assert.equal(await lookup.check('^gspc', 'yahoo'), 'known');
  assert.equal(await lookup.check('EURUSD=X', 'yahoo'), 'known');
  assert.equal(await lookup.check('BTC-USD', 'yahoo'), 'known');
  assert.equal(await lookup.check('BRK-B', 'yahoo'), 'known');
  assert.equal(await lookup.check('SPYY', 'yahoo'), 'unknown');
  // Yahoo spells it BRK-B; the dotted form is not listed.
  assert.equal(await lookup.check('BRK.B', 'yahoo'), 'unknown');
});

test('check: an answer that filled its page without the ticker proves nothing', async () => {
  const n = net();
  const many = Array.from({ length: 8 }, (_, i) => quote(`ZZ${i}.L`, `Fund ${i}`, undefined, 'London', 'ETF', 'ETF'));
  n.body.set('q=ZZ', yahoo(...many));
  const lookup = new SymbolLookup(n.deps);
  assert.equal(await lookup.check('ZZ', 'yahoo'), 'unsure');
  assert.equal(lookup.peek('ZZ', 'yahoo'), null);
  assert.equal(await lookup.check('ZZ', 'yahoo'), 'unsure');
  assert.equal(n.urls.length, 1, 'the answer is kept, so it is not asked again');
  // The same page with the ticker on it is a yes.
  n.body.set('q=ZY', yahoo(quote('ZY', 'Zy', undefined, 'NYSE', 'EQUITY', 'Equity'), ...many.slice(1)));
  assert.equal(await lookup.check('ZY', 'yahoo'), 'known');
});

test('a ticker with ^ = . or - in it is neither mangled nor marked unknown', async () => {
  const n = net();
  const lookup = new SymbolLookup(n.deps);
  for (const t of ['^GSPC', 'EURUSD=X', 'BRK-B', 'BTC-USD']) assert.equal(await lookup.check(t, 'yahoo'), 'known', t);
  assert.ok(n.urls.every((u) => !u.includes('^') && !u.includes('=X&')), 'the query is percent-encoded');
});

test('answers are kept for the session, and identical requests in flight are shared', async () => {
  const n = net();
  n.hold = true;
  const lookup = new SymbolLookup(n.deps);
  const first = lookup.search('SPY', 'yahoo');
  const second = lookup.check('SPY', 'yahoo');
  const third = lookup.search('spy', 'yahoo');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(n.urls.length, 1);
  n.pending.forEach((p) => p.done());
  assert.deepEqual(tickers(await first), ['SPY', 'SPYM', 'SPYI']);
  assert.equal(await second, 'known');
  assert.deepEqual(tickers(await third), ['SPY', 'SPYM', 'SPYI']);
  n.hold = false;
  await lookup.search('SPY', 'yahoo');
  await lookup.check('SPY', 'yahoo');
  assert.equal(n.urls.length, 1);
});

test('peek: nothing before the question is asked, the answer after, nothing for a failed one', async () => {
  const n = net();
  const lookup = new SymbolLookup(n.deps);
  assert.equal(lookup.peek('SPY', 'yahoo'), null);
  assert.equal(lookup.peekSearch('SPY', 'yahoo'), null);
  await lookup.check('SPY', 'yahoo');
  await lookup.check('SPYY', 'yahoo');
  assert.equal(lookup.peek('spy', 'yahoo'), 'known');
  assert.equal(lookup.peek('SPYY', 'yahoo'), 'unknown');
  assert.deepEqual(tickers(lookup.peekSearch('SPYY', 'yahoo')!), ['SPYY.DE', 'SPYYD.XD']);
  n.fail.add('finance.yahoo.com');
  assert.equal(await lookup.check('QQQ', 'yahoo'), 'unsure');
  assert.equal(lookup.peek('QQQ', 'yahoo'), null);
});

test('the second host is tried, and an answer that is not search results counts as a failure', async () => {
  const n = net();
  n.fail.add('query2.');
  const lookup = new SymbolLookup(n.deps);
  assert.equal(await lookup.check('SPY', 'yahoo'), 'known');
  assert.deepEqual(n.urls.map((u) => new URL(u).host), ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']);

  const m = net();
  m.body.set('query2.', '<html>Too many requests</html>');
  const other = new SymbolLookup(m.deps);
  assert.equal(await other.check('SPY', 'yahoo'), 'known');
  assert.equal(m.urls.length, 2);
  const none = net();
  none.body.set('finance.yahoo.com', '{"finance":{"error":"x"}}');
  assert.equal(await new SymbolLookup(none.deps).check('SPY', 'yahoo'), 'unsure');
});

test('a failure gives no hits and "unsure", is not asked again for a while, then is tried again', async () => {
  const n = net();
  n.fail.add('finance.yahoo.com');
  const lookup = new SymbolLookup(n.deps);
  assert.deepEqual(await lookup.search('SPY', 'yahoo'), []);
  assert.equal(n.urls.length, 2, 'both hosts were tried');
  assert.equal(await lookup.check('SPY', 'yahoo'), 'unsure');
  assert.equal(n.urls.length, 2, 'not asked again at once');
  n.clock.t += 31_000;
  n.fail.clear();
  assert.equal(await lookup.check('SPY', 'yahoo'), 'known');
  assert.equal(lookup.peek('SPY', 'yahoo'), 'known');
});

test('after three failures in a row a host is left alone for a minute', async () => {
  const n = net();
  n.fail.add('finance.yahoo.com');
  const lookup = new SymbolLookup(n.deps);
  for (const t of ['AAA', 'BBB', 'CCC']) assert.equal(await lookup.check(t, 'yahoo'), 'unsure');
  const sent = n.urls.length;
  assert.equal(await lookup.check('DDD', 'yahoo'), 'unsure');
  assert.equal(n.urls.length, sent, 'paused');
  n.clock.t += 61_000;
  n.fail.clear();
  assert.equal(await lookup.check('SPY', 'yahoo'), 'known');
});

test('no more than two requests run at once, and the rest wait their turn', async () => {
  const n = net();
  n.hold = true;
  const lookup = new SymbolLookup(n.deps);
  const all = ['SPY', 'SPYY', '^GSPC', 'BRK-B', 'BTC'].map((t) => lookup.check(t, 'yahoo'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(n.urls.length, 2);
  for (let guard = 0; n.pending.length && guard < 20; guard++) {
    n.pending.shift()!.done();
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.equal(n.urls.length, 5);
  assert.equal(n.most, 2);
  assert.deepEqual(await Promise.all(all), ['known', 'unknown', 'known', 'known', 'unknown']);
});

test('requests are spaced when the caller can wait', async () => {
  const n = net();
  const waits: number[] = [];
  const lookup = new SymbolLookup({
    ...n.deps,
    sleep: async (ms) => {
      waits.push(ms);
      n.clock.t += ms;
    },
  });
  await lookup.check('SPY', 'yahoo');
  await lookup.check('^GSPC', 'yahoo');
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 0 && waits[0] <= 250);
});

test('Binance: the list of markets is fetched once, then searched and checked locally', async () => {
  const n = net();
  const lookup = new SymbolLookup(n.deps);
  assert.equal(lookup.peek('BTCUSDT', 'binance'), null);
  const hits = await lookup.search('btc', 'binance');
  assert.deepEqual(tickers(hits), ['BTCUSDT', 'BTCUSDC', 'BTCFDUSD', 'BTCEUR', 'BTCTRY', 'ETHBTC', 'BNBBTC', 'WBTCBTC']);
  assert.deepEqual(hits[0], { ticker: 'BTCUSDT', name: 'BTC / USDT', detail: 'Binance', source: 'binance' });
  assert.equal(await lookup.check('BTCUSDT', 'binance'), 'known');
  assert.equal(await lookup.check('btcusdtt', 'binance'), 'unknown');
  assert.equal(lookup.peek('ETHUSDT', 'binance'), 'known');
  assert.equal(lookup.peek('NOPE', 'binance'), 'unknown');
  assert.deepEqual(tickers(lookup.peekSearch('DOGE', 'binance')!), ['DOGEUSDT']);
  assert.equal(n.urls.length, 1);
  // An exact market comes first.
  assert.equal((await lookup.search('ETHBTC', 'binance'))[0].ticker, 'ETHBTC');
});

test('Binance: the list is fetched again after hours, and the old one serves when that fails', async () => {
  const n = net();
  const lookup = new SymbolLookup(n.deps);
  await lookup.check('BTCUSDT', 'binance');
  n.clock.t += 5 * 3_600_000;
  await lookup.check('ETHUSDT', 'binance');
  assert.equal(n.urls.length, 1);
  n.clock.t += 2 * 3_600_000;
  n.fail.add('binance.vision');
  assert.equal(await lookup.check('ETHUSDT', 'binance'), 'known');
  assert.equal(n.urls.length, 2);
  n.fail.clear();
  n.clock.t += 31_000;
  n.body.set('binance.vision', JSON.stringify([{ symbol: 'NEWUSDT', price: '1' }]));
  assert.equal(await lookup.check('NEWUSDT', 'binance'), 'known');
  assert.equal(lookup.peek('BTCUSDT', 'binance'), 'unknown');
});

test('Binance: a failed first fetch is "unsure" and an odd answer is a failure', async () => {
  const n = net();
  n.fail.add('binance.vision');
  const lookup = new SymbolLookup(n.deps);
  assert.equal(await lookup.check('BTCUSDT', 'binance'), 'unsure');
  assert.deepEqual(await lookup.search('BTC', 'binance'), []);
  assert.equal(lookup.peek('BTCUSDT', 'binance'), null);
  const odd = net();
  odd.body.set('binance.vision', '{"code":-1003,"msg":"Too many requests"}');
  assert.equal(await new SymbolLookup(odd.deps).check('BTCUSDT', 'binance'), 'unsure');
});

test('the cache is bounded', async () => {
  const n = net();
  const lookup = new SymbolLookup(n.deps);
  for (let i = 0; i < 350; i++) await lookup.search(`T${i}`, 'yahoo');
  assert.equal(lookup.peekSearch('T0', 'yahoo'), null, 'the oldest fell out');
  assert.ok(lookup.peekSearch('T349', 'yahoo'));
});

test('suggest: the block’s source first, the other one adding a few, written the way the block needs them', async () => {
  const n = net();
  const lookup = new SymbolLookup(n.deps);
  const yahooBlock = await lookup.suggest('BTC', 'yahoo');
  assert.deepEqual(yahooBlock.map((s) => s.written), ['BTC-USD', 'BTC.DE', 'binance:BTCUSDT', 'binance:BTCUSDC', 'binance:BTCFDUSD']);
  const binanceBlock = await lookup.suggest('BTC', 'binance');
  assert.deepEqual(binanceBlock.slice(0, 2).map((s) => s.written), ['BTCUSDT', 'BTCUSDC']);
  assert.deepEqual(binanceBlock.slice(-2).map((s) => s.written), ['yahoo:BTC-USD', 'yahoo:BTC.DE']);
  // A prefix that was typed limits the search to that source and is kept.
  const typed = await lookup.suggest('binance:BTC', 'yahoo');
  assert.ok(typed.length > 0 && typed.every((s) => s.hit.source === 'binance' && s.written === `binance:${s.hit.ticker}`));
  assert.deepEqual((await lookup.suggest('yahoo:BTC', 'binance')).map((s) => s.written), ['yahoo:BTC-USD', 'yahoo:BTC.DE']);
  assert.deepEqual(await lookup.suggest('', 'yahoo'), []);
});

test('peekSuggest gives the same list once every search it needs has been made', async () => {
  const n = net();
  const lookup = new SymbolLookup(n.deps);
  assert.equal(lookup.peekSuggest('BTC', 'yahoo'), null);
  const full = await lookup.suggest('BTC', 'yahoo');
  assert.deepEqual(lookup.peekSuggest('BTC', 'yahoo'), full);
  assert.deepEqual(lookup.peekSuggest('', 'yahoo'), []);
});

test('suggest survives one source failing', async () => {
  const n = net();
  n.fail.add('binance.vision');
  const lookup = new SymbolLookup(n.deps);
  assert.deepEqual((await lookup.suggest('BTC', 'yahoo')).map((s) => s.written), ['BTC-USD', 'BTC.DE']);
});

test('writtenAs', () => {
  const y: SymbolHit = { ticker: 'SPY', name: '', detail: '', source: 'yahoo' };
  const b: SymbolHit = { ticker: 'BTCUSDT', name: '', detail: '', source: 'binance' };
  assert.equal(writtenAs(y, 'yahoo'), 'SPY');
  assert.equal(writtenAs(b, 'yahoo'), 'binance:BTCUSDT');
  assert.equal(writtenAs(y, 'binance'), 'yahoo:SPY');
  assert.equal(writtenAs(b, 'binance'), 'BTCUSDT');
  assert.equal(writtenAs(b, 'yahoo', 'binance:'), 'binance:BTCUSDT');
});

test('the source of plain tickers: the data line, else the default', () => {
  assert.equal(blockSource(['universe: SPY']), 'yahoo');
  assert.equal(blockSource(['universe: SPY'], { dataSource: 'binance' }), 'binance');
  assert.equal(blockSource(['data: binance', 'universe: BTCUSDT'], { dataSource: 'yahoo' }), 'binance');
  assert.equal(blockSource(['DATA:  Yahoo  # prices'], { dataSource: 'binance' }), 'yahoo');
  assert.equal(blockSource(['data: banana'], { dataSource: 'binance' }), 'binance');
});

test('blockTickers: tickers on the lines that take them, with their source and columns', () => {
  const lines = [
    'universe: SPY 60%, binance:BTCUSDT 30%, csv:Data/gold.csv 10%, ^GSPC',
    'benchmark: qqq',
    'cash rate: ^IRX',
    'buy when close of BRK-B > 1 and close of binance:ethusdt < 2',
    'for SPY:',
    '  sell when close of ^VIX > 20',
    'weighting: inverse volatility(60)',
  ];
  const refs = blockTickers(lines, { dataSource: 'yahoo' });
  assert.deepEqual(
    refs.map((r) => [r.line, lines[r.line].slice(r.from, r.to), r.ticker, r.source, lines[r.line].slice(r.idFrom, r.to)]),
    [
      [0, 'SPY', 'SPY', 'yahoo', 'SPY'],
      [0, 'binance:BTCUSDT', 'BTCUSDT', 'binance', 'BTCUSDT'],
      [0, '^GSPC', '^GSPC', 'yahoo', '^GSPC'],
      [1, 'qqq', 'QQQ', 'yahoo', 'qqq'],
      [2, '^IRX', '^IRX', 'yahoo', '^IRX'],
      [3, 'BRK-B', 'BRK-B', 'yahoo', 'BRK-B'],
      [3, 'binance:ethusdt', 'ETHUSDT', 'binance', 'ethusdt'],
      [5, '^VIX', '^VIX', 'yahoo', '^VIX'],
    ],
  );
  assert.ok(blockTickers(['data: binance', 'universe: BTCUSDT, yahoo:SPY']).every((r, i) => r.source === (i === 0 ? 'binance' : 'yahoo')));
  // A weight written without its percent sign, or a cash rate, is a number and not a ticker.
  assert.deepEqual(blockTickers(['universe: SPY 60, TLT 40', 'cash rate: 4']).map((r) => r.ticker), ['SPY', 'TLT']);
  assert.deepEqual(blockTickers(['universe: 7203.T']).map((r) => r.ticker), ['7203.T']);
});

test('the message for a ticker the source does not know', () => {
  assert.equal(unknownTickerMessage('SPYY', 'yahoo'), 'Yahoo has no ticker called SPYY.');
  assert.equal(unknownTickerMessage('BTCUSDTT', 'binance'), 'Binance has no market called BTCUSDTT.');
});

test('blockTickers: a CSV file the block names is never a ticker, however a rule refers to it', () => {
  const cases: string[][] = [
    ['universe: SPY, csv:Data/myfund.csv', 'buy when close of myfund > sma(20) of myfund'],
    // The parser matches names whatever the capitals, and takes the name from the file name without its ending.
    ['universe: SPY, csv:Data/myfund.csv', 'buy when close of MyFund > sma(20) of MYFUND'],
    ['universe: SPY, csv:Data/MyFund.CSV', 'buy when close of myfund > 1'],
    ['universe: SPY, csv:myfund.csv', 'buy when close of myfund > 1'],
    // A file first named after `of` is read by name afterwards.
    ['universe: SPY', 'buy when close of csv:Data/gold.csv > 1 and close of gold > 1'],
    ['universe: SPY', 'benchmark: csv:Data/gold.csv', 'buy when close > 1', 'sell when close of gold < 1'],
    ['universe: csv:Data/a.csv, csv:Data/b.csv', 'buy when close of b > close of a', 'for a:', '  stop loss: 5%'],
  ];
  for (const lines of cases) {
    const { spec } = parseSpec(lines.join('\n'));
    const files = new Set((spec ? [...spec.universe, ...spec.extras] : []).filter((a) => a.source === 'csv').map((a) => a.name.toLowerCase()));
    const sent = blockTickers(lines).map((r) => r.ticker.toLowerCase());
    assert.deepEqual(sent.filter((t) => t !== 'spy'), [], lines.join(' / '));
    if (spec) for (const name of files) assert.ok(!sent.includes(name));
  }
  // A name no file has is still a ticker, and so is one with its own prefix.
  assert.deepEqual(
    blockTickers(['universe: SPY, csv:Data/myfund.csv', 'buy when close of myfunds > 1 and close of binance:myfund > 1']).map((r) => `${r.source}:${r.ticker}`),
    ['yahoo:SPY', 'yahoo:MYFUNDS', 'binance:MYFUND'],
  );
});
