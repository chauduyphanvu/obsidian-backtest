// `for SPY, QQQ:`: one section for several tickers.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec } from '../src/dsl.ts';

const HEAD = 'universe: SPY, QQQ, TLT\n';
const ok = (src: string) => {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, [], src);
  return spec!;
};
const errors = (src: string) => parseSpec(src).errors.map((e) => [e.line, e.from, e.to, e.message] as const);

test('each ticker listed gets the rules and stops that follow, as if written under a line of its own', () => {
  const listed = ok(`${HEAD}buy when close > sma(200)\nfor SPY, QQQ:\n  buy when close > sma(50)\n  sell when rsi(2) > 90\n  stop loss: 5%\n  take profit: 2 atr(14)\nfor all:\n  costs: 5 bps`);
  const apart = ok(`${HEAD}buy when close > sma(200)\nfor SPY:\n  buy when close > sma(50)\n  sell when rsi(2) > 90\n  stop loss: 5%\n  take profit: 2 atr(14)\nfor QQQ:\n  buy when close > sma(50)\n  sell when rsi(2) > 90\n  stop loss: 5%\n  take profit: 2 atr(14)\nfor all:\n  costs: 5 bps`);
  assert.deepEqual(listed.rules, apart.rules);
  assert.deepEqual(listed.stops, apart.stops);
  // TLT is not listed, so it keeps the shared rule and no stops.
  assert.equal(JSON.stringify(listed.rules.TLT.buy).includes('"args":[200]'), true);
  assert.equal(listed.rules.TLT.sell, null);
  assert.deepEqual(listed.stops.TLT, { stopLoss: null, trailingStop: null, takeProfit: null });
  assert.deepEqual(listed.stops.QQQ.stopLoss, { k: 'pct', v: 0.05 });
  // The text of each rule is the same text for each of them.
  assert.equal(listed.written!.rules.SPY.sell!.text, 'rsi(2) > 90');
  assert.equal(listed.written!.rules.QQQ.sell!.text, 'rsi(2) > 90');
});

test('spacing, case and a comment on the line do not matter', () => {
  const spec = ok(`${HEAD}buy when true\nfor  spy ,QQQ  :   # two of three\n  sell when close < 1`);
  assert.deepEqual([spec.rules.SPY.sell !== null, spec.rules.QQQ.sell !== null, spec.rules.TLT.sell !== null], [true, true, false]);
  assert.deepEqual(ok(`${HEAD}buy when true\nfor SPY, QQQ, TLT:\n  sell when close < 1`).rules.TLT.sell !== null, true);
});

test('each ticker must be in the universe, and the message points at the one that is not', () => {
  const src = `${HEAD}buy when true\nfor SPY, GLD, QQQ:\n  sell when close < 1\n  stop loss: 5%`;
  assert.deepEqual(errors(src), [[3, 9, 12, '"for SPY, GLD, QQQ:" names GLD, which is not in the universe']]);
  // Two that are not: both are named, once each, however many rules sit under the line.
  assert.deepEqual(errors(`${HEAD}buy when true\nfor GLD, SPY, IWM:\n  sell when close < 1\n  stop loss: 5%`), [
    [3, 4, 7, '"for GLD, SPY, IWM:" names GLD, which is not in the universe'],
    [3, 14, 17, '"for GLD, SPY, IWM:" names IWM, which is not in the universe'],
  ]);
  // A single ticker keeps its message.
  assert.deepEqual(errors(`${HEAD}buy when true\nfor GLD:\n  sell when close < 1`), [[3, 4, 7, '"for GLD:" names a ticker that is not in the universe']]);
  // The rule's own mistakes are still reported.
  assert.match(errors(`${HEAD}buy when true\nfor SPY, QQQ:\n  sell when close < smaa(3)`)[0][3], /^Unknown name "smaa"/);
});

test('a ticker is listed once, all stands alone, and a comma needs a ticker on each side', () => {
  assert.deepEqual(errors(`${HEAD}buy when true\nfor SPY, spy:\n  sell when close < 1`), [[3, 9, 12, 'spy is listed twice. List each ticker once, as in for SPY, QQQ:']]);
  assert.deepEqual(errors(`${HEAD}buy when true\nfor SPY, all:\n  sell when close < 1`), [[3, 9, 12, '"all" means every ticker, so it can\'t be listed with others. Write it alone, as in for all:']]);
  assert.deepEqual(errors(`${HEAD}buy when true\nfor SPY,:\n  sell when close < 1`), [[3, 0, 9, 'Name a ticker between the commas, as in for SPY, QQQ:']]);
  assert.deepEqual(errors(`${HEAD}buy when true\nfor ,SPY:\n  sell when close < 1`).map((e) => e[3]), ['Name a ticker between the commas, as in for SPY, QQQ:']);
});

test('a rule of one kind written twice for a ticker follows the rule for duplicates, whatever sections it comes from', () => {
  const twice = errors(`${HEAD}buy when true\nfor SPY, QQQ:\n  sell when close < 1\nfor QQQ:\n  sell when close < 2`);
  assert.deepEqual(twice, [[6, 2, 11, 'There is already a sell rule for QQQ. Join conditions with "and" or "or"']]);
  // Listed on two lines that share a ticker.
  assert.deepEqual(errors(`${HEAD}buy when true\nfor SPY, QQQ:\n  sell when close < 1\nfor QQQ, TLT:\n  sell when close < 2`).map((e) => e[3]), ['There is already a sell rule for QQQ. Join conditions with "and" or "or"']);
  // The same ticker twice by two lines, and a stop too.
  assert.deepEqual(errors(`${HEAD}buy when true\nfor SPY, QQQ:\n  stop loss: 5%\nfor QQQ:\n  stop loss: 6%`).map((e) => e[3]), ['"stop loss" is set twice for QQQ']);
  // Different kinds, or different tickers, are fine; so is a shared rule next to a listed one.
  assert.deepEqual(errors(`${HEAD}buy when true\nsell when close < 3\nfor SPY, QQQ:\n  sell when close < 1\nfor TLT:\n  sell when close < 2\nfor SPY:\n  stop loss: 5%`), []);
  // Two shared rules of a kind are still an error, with no ticker to name.
  assert.deepEqual(errors(`${HEAD}buy when true\nbuy when false`), [[3, 0, 8, 'There is already a buy rule. Join conditions with "and" or "or"']]);
});

test('settings other than stops are still refused inside a list, and a price warning covers the listed tickers', () => {
  assert.match(errors(`${HEAD}buy when true\nfor SPY, QQQ:\n  costs: 5 bps`)[0][3], /"costs" applies to the whole strategy/);
  // A price against a number warns when any ticker the rule belongs to has adjusted prices; here only the Binance one is listed.
  const w = parseSpec('universe: SPY, binance:BTCUSDT\nbuy when true\nfor BTCUSDT:\n  sell when close > 100').warnings;
  assert.deepEqual(w, []);
  const w2 = parseSpec('universe: SPY, binance:BTCUSDT\nbuy when true\nfor SPY, BTCUSDT:\n  sell when close > 100').warnings;
  assert.equal(w2.length, 1);
});

test('a rule under a list reads a column only where each listed ticker is a CSV file', () => {
  const e = parseSpec('universe: csv:Data/a.csv, SPY\nbuy when true\nfor a, SPY:\n  sell when column(score) > 1').errors;
  assert.equal(e.length, 1);
  assert.match(e[0].message, /^column\(score\) reads a column of the ticker the rule belongs to, and SPY comes from Yahoo/);
});
