import assert from 'node:assert/strict';
import { test } from 'node:test';
import { complete, hitCompletions, localTickers, tickerPosition, tickers } from '../src/complete.ts';
import { shortOf } from '../src/docs.ts';
import { SETTINGS } from '../src/dsl.ts';
import { lineKind, lineKinds, tokenize, tokenizeBlock } from '../src/highlight.ts';

const BLOCK = `name: Three sleeves
universe: SPY 50%, binance:BTCUSDT 20%, csv:Data/gold.csv 30%
costs: 10 bps  # per side
stop loss: 8%

buy  when close > sma(200) and rsi(14) of ^VIX < 30.5
       or close crosses above highest(high, 50)[1]

for BTCUSDT:
  sell when not true
nonsense here`.split('\n');

const shown = (i: number) => tokenizeBlock(BLOCK)[i].map((t) => `${t.kind}:${BLOCK[i].slice(t.from, t.to)}`);

test('settings: key, tickers, numbers, free text, comments', () => {
  assert.deepEqual(shown(0), ['key:name', 'value:Three sleeves']);
  assert.deepEqual(shown(1), ['key:universe', 'ticker:SPY', 'number:50%', 'ticker:binance:BTCUSDT', 'number:20%', 'ticker:csv:Data/gold.csv', 'number:30%']);
  assert.deepEqual(shown(2), ['key:costs', 'number:10 bps', 'comment:# per side']);
  assert.deepEqual(shown(3), ['key:stop loss', 'number:8%']);
});

test('fill is a key with plain values, like rebalance', () => {
  const kinds = (line: string) => tokenizeBlock([line])[0].map((t) => `${t.kind}:${line.slice(t.from, t.to)}`);
  assert.deepEqual(kinds('fill: next open'), ['key:fill', 'value:next', 'value:open']);
  assert.deepEqual(kinds('fill: close  # at the close'), ['key:fill', 'value:close', 'comment:# at the close']);
});

test('a line that ends in a carriage return is coloured as without it', () => {
  const crlf = BLOCK.map((line) => `${line}\r`);
  assert.deepEqual(tokenizeBlock(crlf), tokenizeBlock(BLOCK));
  assert.deepEqual(lineKinds(crlf), lineKinds(BLOCK));
});

test('rules, continuation lines and "of" tickers', () => {
  assert.deepEqual(shown(5), [
    'keyword:buy', 'keyword:when', 'series:close', 'operator:>', 'function:sma', 'operator:(', 'number:200', 'operator:)',
    'keyword:and', 'function:rsi', 'operator:(', 'number:14', 'operator:)', 'keyword:of', 'ticker:^VIX', 'operator:<', 'number:30.5',
  ]);
  assert.deepEqual(shown(6).slice(0, 5), ['keyword:or', 'series:close', 'keyword:crosses', 'keyword:above', 'function:highest']);
  assert.deepEqual(shown(6).slice(-3), ['operator:[', 'number:1', 'operator:]']);
});

test('for headers, constants, and lines that are neither', () => {
  assert.deepEqual(shown(8), ['keyword:for', 'ticker:BTCUSDT']);
  assert.deepEqual(shown(9), ['keyword:sell', 'keyword:when', 'keyword:not', 'value:true']);
  assert.deepEqual(shown(4), []);
  // A line after a rule continues it; unknown words in it stay uncoloured.
  assert.deepEqual(shown(10), []);
});

const labels = (above: string[], before: string, block = BLOCK) => complete(block, above, before)?.items.map((i) => i.label) ?? null;

test('tickers the block names', () => {
  assert.deepEqual(tickers(BLOCK), ['SPY', 'BTCUSDT', 'gold']);
});

test('line starts offer settings and rule openers', () => {
  assert.deepEqual(labels([], 'st'), ['stop loss']);
  assert.deepEqual(labels([], 'b'), ['buy when', 'benchmark']);
  assert.deepEqual(labels([], 's'), ['sell when', 'symbol', 'size', 'stop loss', 'slippage']);
  assert.equal(labels([], ''), null);
  const r = complete(BLOCK, [], '  tr')!;
  assert.deepEqual([r.from, r.items[0].insert], [2, 'trailing stop: ']);
  // Inside a rule, a new line can also continue it.
  assert.deepEqual(labels(['buy when close > 1'], 'a'), ['add when', 'and']);
  assert.deepEqual(labels([], 'a'), ['add when']);
});

test('setting values', () => {
  assert.deepEqual(labels([], 'rebalance: '), ['never', 'weekly', 'monthly', 'quarterly', 'yearly']);
  assert.deepEqual(labels([], 'rebalance: m'), ['monthly']);
  assert.equal(labels([], 'rebalance: monthly'), null);
  assert.deepEqual(labels([], 'data: '), ['yahoo', 'binance']);
  assert.deepEqual(labels([], 'interval: 1'), ['1m', '15m', '1h', '12h', '1d', '1w']);
  assert.equal(labels([], 'name: s'), null);
  assert.equal(labels([], 'universe: S'), null);
});

test('inside a rule: series, functions and words', () => {
  assert.deepEqual(labels([], 'buy when c'), ['close', 'cci', 'correl', 'column', 'crosses above', 'crosses below']);
  assert.deepEqual(labels([], 'buy when close > s'), ['sma', 'stdev', 'stoch_k', 'stoch_d', 'supertrend', 'supertrend_up', 'slope']);
  assert.equal(complete(BLOCK, [], 'buy when close > sm')!.items[0].insert, 'sma(');
  assert.deepEqual(labels([], 'buy when close > sma(h'), ['high', 'highest', 'hma']);
  assert.deepEqual(labels(['buy when close > 1'], '   or rs'), ['rsi']);
  assert.deepEqual(labels([], 'buy '), ['when']);
  assert.deepEqual(labels([], 'sell when close crosses '), ['above', 'below']);
  // Nothing while typing a number, after a finished word, or outside a rule.
  assert.equal(labels([], 'buy when close > sma(2'), null);
  assert.equal(labels([], 'buy when close'), null);
  assert.equal(labels([], 'buy when close > '), null);
  assert.equal(labels([], 'something el'), null);
});

test('tickers after "of" and "for"', () => {
  assert.deepEqual(labels([], 'buy when close of '), ['SPY', 'BTCUSDT', 'gold']);
  assert.deepEqual(labels([], 'buy when close of b'), ['BTCUSDT']);
  assert.deepEqual(labels([], 'for '), ['SPY', 'BTCUSDT', 'gold', 'all']);
  assert.equal(complete(BLOCK, [], 'for g')!.items[0].insert, 'gold:');
});

const V2 = `universe: SPY, QQQ, TLT
fast = 50 in 20..100 step 10   # sweep
stop = 8%
hold: top n by roc(fast) of SPY
weighting: inverse volatility(60)
risk per trade: 1% at 2 atr(14)
cash rate: ^IRX
slippage: 5 bps
test from: 2019-01-01
stop loss: stop
buy when sma(fast) > close and month_end
sell when bars held >= n or close < entry price * 0.9 or weekday == 5
for TLT:
  trailing stop: 3 atr(14)
n = 2`.split('\n');

const shownV2 = (i: number) => tokenizeBlock(V2)[i].map((t) => `${t.kind}:${V2[i].slice(t.from, t.to)}`);

test('parameter declarations: name as a key, numbers, in and step', () => {
  assert.deepEqual(shownV2(1), ['key:fast', 'operator:=', 'number:50', 'keyword:in', 'number:20', 'operator:..', 'number:100', 'keyword:step', 'number:10', 'comment:# sweep']);
  assert.deepEqual(shownV2(2), ['key:stop', 'operator:=', 'number:8%']);
  assert.deepEqual(shownV2(14), ['key:n', 'operator:=', 'number:2']);
  assert.equal(lineKind(V2[1], true), 'param');
  // A built-in name is not a parameter, so inside a rule the line continues it.
  assert.equal(lineKind('  close = 5', true), 'continuation');
});

test('new settings colour their values, with parameters where numbers go', () => {
  assert.deepEqual(shownV2(3), ['key:hold', 'keyword:top', 'param:n', 'keyword:by', 'function:roc', 'operator:(', 'param:fast', 'operator:)', 'keyword:of', 'ticker:SPY']);
  assert.deepEqual(shownV2(4), ['key:weighting', 'value:inverse', 'value:volatility', 'operator:(', 'number:60', 'operator:)']);
  assert.deepEqual(shownV2(5), ['key:risk per trade', 'number:1%', 'keyword:at', 'number:2', 'function:atr', 'operator:(', 'number:14', 'operator:)']);
  assert.deepEqual(shownV2(6), ['key:cash rate', 'ticker:^IRX']);
  assert.deepEqual(shownV2(7), ['key:slippage', 'number:5 bps']);
  assert.deepEqual(shownV2(8), ['key:test from', 'number:2019-01-01']);
  assert.deepEqual(shownV2(9), ['key:stop loss', 'param:stop']);
  assert.deepEqual(shownV2(13), ['key:trailing stop', 'number:3', 'function:atr', 'operator:(', 'number:14', 'operator:)']);
});

test('rules colour parameters, position values and calendar values', () => {
  assert.deepEqual(shownV2(10), ['keyword:buy', 'keyword:when', 'function:sma', 'operator:(', 'param:fast', 'operator:)', 'operator:>', 'series:close', 'keyword:and', 'series:month_end']);
  assert.deepEqual(shownV2(11), [
    'keyword:sell', 'keyword:when', 'series:bars held', 'operator:>=', 'param:n', 'keyword:or', 'series:close', 'operator:<',
    'series:entry price', 'operator:*', 'number:0.9', 'keyword:or', 'series:weekday', 'operator:==', 'number:5',
  ]);
  // Without the block's parameter names a line leaves them uncoloured.
  assert.ok(!tokenize(V2[10], 'rule').some((t) => t.kind === 'param'));
});

test('completions: position values in sell rules only, calendar values and parameters everywhere in a rule', () => {
  assert.deepEqual(labels([], 'sell when ba', V2), ['bars held', 'bars_since']);
  assert.deepEqual(labels([], 'buy when ba', V2), ['bars_since']);
  assert.deepEqual(labels(['sell when close > 1'], '  or en', V2), ['entry price', 'entries made']);
  assert.equal(labels(['buy when close > 1'], '  or en', V2), null);
  assert.deepEqual(labels([], 'buy when month_', V2), ['month_start', 'month_end']);
  assert.deepEqual(labels([], 'buy when we', V2), ['weekday']);
  const fast = complete(V2, [], 'buy when close > sma(fa')!.items;
  assert.deepEqual(fast.map((i) => [i.label, i.detail]), [['fast', 'parameter: 50 in 20..100 step 10']]);
  assert.deepEqual(labels([], 'hold: top 3 by ro', V2), ['roc']);
  assert.deepEqual(labels([], 'hold: top 3 by ba', V2), ['bars_since']);
});

test('completions: hints for the new settings, and only stops inside a for section', () => {
  assert.deepEqual(labels([], 'hold: '), ['top 3 by roc(126)']);
  assert.deepEqual(labels([], 'weighting: '), ['inverse volatility(60)']);
  assert.deepEqual(labels([], 'risk per trade: '), ['1% at 2 atr(14)']);
  assert.deepEqual(labels([], 'cash rate: '), ['4%', '^IRX']);
  assert.deepEqual(labels([], 'slippage: '), ['5 bps']);
  assert.deepEqual(labels([], 'test from: '), ['2019-01-01']);
  assert.deepEqual(labels([], 'stop loss: ', V2), ['10%', '2 atr(14)', 'stop']);
  assert.deepEqual(labels([], 'r'), ['rebalance', 'risk per trade']);
  assert.deepEqual(labels([], 'ca'), ['capital', 'cash rate']);
  assert.deepEqual(labels(['for TLT:'], 's'), ['sell when', 'stop loss']);
  assert.equal(labels(['for TLT:'], 'c'), null);
  assert.deepEqual(labels(['for TLT:', 'for all:'], 'c'), ['capital', 'costs', 'cash rate', 'commission']);
});

test('completion descriptions come from the help table', () => {
  for (const s of SETTINGS) {
    const item = complete(BLOCK, [], s.split(' ')[0])?.items.find((i) => i.label === s);
    assert.equal(item?.detail, shortOf(s), s);
  }
  const fn = (name: string, typed = name.slice(0, 3)) => complete(BLOCK, [], `buy when ${typed}`)!.items.find((i) => i.label === name)!;
  assert.equal(fn('rsi').detail, 'rsi(n = 14) · relative strength index, 0 to 100');
  assert.equal(fn('macd_signal').detail, 'macd_signal(fast = 12, slow = 26, signal = 9) · average of the macd line');
  assert.equal(fn('close').detail, shortOf('close'));
  assert.equal(fn('crosses above').detail, shortOf('crosses above'));
  assert.equal(fn('of', 'o').detail, shortOf('of'));
  assert.equal(complete(BLOCK, [], 'buy when month_s')!.items[0].detail, shortOf('month_start'));
  assert.equal(complete(BLOCK, [], 'sell when ba')!.items[0].detail, shortOf('bars held'));
  assert.equal(complete(BLOCK, [], 'rebalance: q')!.items[0].detail, shortOf('rebalance=quarterly'));
  assert.equal(complete(BLOCK, [], 'interval: 2')!.items[0].detail, shortOf('interval=2h'));
  assert.equal(complete(BLOCK, [], 'for a')!.items[0].detail, shortOf('for all'));
  assert.equal(complete(BLOCK, [], 'fo')!.items.find((i) => i.label === 'for')!.detail, shortOf('for'));
  const inSection = complete(BLOCK, ['for TLT:'], 's')!.items.find((i) => i.label === 'stop loss')!;
  assert.equal(inSection.detail, `${shortOf('stop loss')}, for TLT only`);
});

test('fill: the setting and its two values complete', () => {
  assert.deepEqual(labels([], 'fi'), ['fill']);
  assert.equal(complete(BLOCK, [], 'fi')!.items[0].detail, shortOf('fill'));
  assert.deepEqual(labels([], 'fill: '), ['next open', 'close']);
  assert.deepEqual(labels([], 'fill: n'), ['next open']);
  assert.deepEqual(labels([], 'fill: next o'), ['next open']);
  assert.deepEqual(labels([], 'fill: c'), ['close']);
  assert.equal(labels([], 'fill: close'), null);
  assert.equal(labels([], 'fill: next open'), null);
  const r = complete(BLOCK, [], 'fill: next o')!;
  assert.deepEqual([r.from, r.items[0].insert, r.items[0].detail], [6, 'next open', shortOf('fill=next open')]);
});

test('a ticker position: the word being typed on a universe, symbol, benchmark or cash rate line', () => {
  assert.deepEqual(tickerPosition('universe: SP'), { from: 10, word: 'SP' });
  assert.deepEqual(tickerPosition('universe: SPY 60%, TL'), { from: 19, word: 'TL' });
  assert.deepEqual(tickerPosition('universe: SPY 60%, '), { from: 19, word: '' });
  assert.deepEqual(tickerPosition('symbol: ^GS'), { from: 8, word: '^GS' });
  assert.deepEqual(tickerPosition('benchmark: binance:BT'), { from: 11, word: 'binance:BT' });
  assert.deepEqual(tickerPosition('  cash rate: ^IR'), { from: 13, word: '^IR' });
  assert.deepEqual(tickerPosition('universe: csv:Data/go'), { from: 10, word: 'csv:Data/go' });
  assert.deepEqual(tickerPosition('universe: BRK-B'), { from: 10, word: 'BRK-B' });
  assert.deepEqual(tickerPosition('universe: 7203.T'), { from: 10, word: '7203.T' });
  // Weights are left alone: only the ticker word is completed.
  assert.equal(tickerPosition('universe: SPY 6'), null);
  assert.equal(tickerPosition('universe: SPY '), null);
  assert.equal(tickerPosition('universe: SPY 60%'), null);
  assert.equal(tickerPosition('universe: SPY 60%, TLT 4'), null);
  assert.equal(tickerPosition('cash rate: 4'), null);
  assert.equal(tickerPosition('cash rate: 4%'), null);
  assert.equal(tickerPosition('universe: SPY # TL'), null);
  assert.equal(tickerPosition('name: SP'), null);
  assert.equal(tickerPosition('buy when close of SP'), null);
  assert.equal(tickerPosition('interval: 1'), null);
});

test('local ticker offers: the universe’s own tickers, or the vault’s CSV files after csv:', () => {
  const block = ['universe: SPY, binance:BTCUSDT, csv:Data/gold.csv', 'benchmark: '];
  const pos = (word: string) => ({ from: 11, word });
  assert.deepEqual(localTickers(block, pos(''), [], []).map((c) => c.insert), ['SPY', 'binance:BTCUSDT', 'csv:Data/gold.csv']);
  assert.deepEqual(localTickers(block, pos('b'), [], []).map((c) => c.insert), ['binance:BTCUSDT']);
  assert.deepEqual(localTickers(block, pos('s'), ['SPY'], []).map((c) => c.insert), []);
  const files = ['Data/gold.csv', 'Data/old prices.csv', 'Data/a,b.csv', 'Research/Gold history.csv', 'Data/silver.csv', 'gold2.csv'];
  assert.deepEqual(localTickers(block, pos('csv:'), [], files).map((c) => c.insert), ['csv:gold2.csv', 'csv:Data/gold.csv', 'csv:Data/silver.csv']);
  assert.deepEqual(localTickers(block, pos('csv:go'), [], files).map((c) => c.insert), ['csv:gold2.csv', 'csv:Data/gold.csv']);
  assert.deepEqual(localTickers(block, pos('CSV:DATA/G'), [], files).map((c) => c.insert), ['csv:Data/gold.csv']);
  assert.deepEqual(localTickers(block, pos('csv:'), [], []), []);
});

test('hits become completions with the name and exchange as the detail, and repeat nothing already offered', () => {
  const own = [{ label: 'SPY', insert: 'SPY', detail: 'in this block' }];
  const hits = [
    { hit: { ticker: 'SPY', name: 'SPDR', detail: 'NYSEArca · ETF', source: 'yahoo' as const }, written: 'SPY' },
    { hit: { ticker: 'SPYM', name: 'SPDR Portfolio S&P 500', detail: 'NYSEArca · ETF', source: 'yahoo' as const }, written: 'SPYM' },
    { hit: { ticker: 'BTCUSDT', name: 'BTC / USDT', detail: 'Binance', source: 'binance' as const }, written: 'binance:BTCUSDT' },
  ];
  assert.deepEqual(hitCompletions(hits, own), [
    { label: 'SPYM', insert: 'SPYM', detail: 'SPDR Portfolio S&P 500 · NYSEArca · ETF', hit: true },
    { label: 'binance:BTCUSDT', insert: 'binance:BTCUSDT', detail: 'BTC / USDT · Binance', hit: true },
  ]);
});
