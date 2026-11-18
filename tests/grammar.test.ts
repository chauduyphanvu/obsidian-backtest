// The grammar for models that write under a grammar: it must take every block the parser takes, in canonical words,
// refuse what is plainly not a block, and say the same in GBNF as in its own form.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractBlocks } from '../src/blocks.ts';
import { CORPUS } from '../src/corpus/examples.ts';
import { MISTAKES } from '../src/corpus/mistakes.ts';
import { parseSpec, SETTINGS } from '../src/dsl.ts';
import { normal, readGbnf, recognize, strategyGrammar, toGbnf, toLark } from '../src/grammar.ts';

const g = strategyGrammar();

/** Every block in the repository that the parser takes with no errors, with where it comes from. */
function validBlocks(): [string, string][] {
  const out: [string, string][] = [];
  for (const f of ['docs/reference.md', 'README.md']) for (const b of extractBlocks(readFileSync(f, 'utf8'))) out.push([`${f}:${b.line + 1}`, b.source]);
  for (const e of CORPUS) out.push([`example ${e.title}`, e.source]);
  for (const m of MISTAKES) out.push([`fix of ${m.title}`, m.fixed]);
  for (const d of readdirSync('xcheck/cases')) out.push([`xcheck ${d}`, readFileSync(join('xcheck/cases', d, 'case.strategy'), 'utf8').trimEnd()]);
  return out.filter(([, source]) => parseSpec(source).errors.length === 0);
}

test('every valid block in the docs, the corpus and the cross-check is in the grammar', () => {
  const blocks = validBlocks();
  assert.ok(blocks.length > 100, `${blocks.length} blocks`);
  const refused = blocks.filter(([, source]) => !recognize(g, source)).map(([where]) => where);
  assert.deepEqual(refused, []);
});

test('the grammar refuses what is plainly not a block', () => {
  const take = (lines: string[]) => recognize(g, ['universe: SPY', ...lines].join('\n'));
  assert.ok(take(['buy when close > sma(200)', 'sell when close < sma(200)']));
  for (const bad of [
    ['Buy SPY when it is above its average.'],
    ['```strategy', 'buy when close > sma(200)'],
    ['**buy** when close > sma(200)'],
    ['stop los: 5%'],
    ['rebalance: fortnightly'],
    ['from: 01/31/2015'],
    ['buy when close > moving_average(200)'],
    ['buy when close > sma(200'],
    ['buy when close crosses over sma(200)'],
    ['buy close > sma(200)'],
    ['data: google'],
  ]) assert.ok(!take(bad), bad.join(' / '));
});

test('every setting has a form in the grammar', () => {
  for (const key of SETTINGS) assert.ok(recognize(g, `${key}: ${{ name: 'x', universe: 'SPY', symbol: 'SPY', from: '2020-01-01', to: '2020-01-01', 'test from': '2020-01-01', data: 'yahoo', interval: '1d', magnify: '1h', rebalance: 'monthly', fill: 'close', capital: '10k', costs: '5 bps', slippage: '2 bps', commission: '1 per order', hold: 'top 2 by roc(20)', weighting: 'inverse volatility(60)', 'risk per trade': '1% at 2 atr(14)', entries: '3', benchmark: 'SPY' }[key] ?? '5%'}`), key);
});

test('the GBNF says what the grammar says', () => {
  const back = readGbnf(toGbnf(g));
  assert.deepEqual([...back.keys()], [...g.rules.keys()]);
  for (const [name, node] of g.rules) assert.deepEqual(normal(back.get(name)!), normal(node), name);
});

test('the Lark grammar names a start rule and writes the tokens as terminals', () => {
  const lark = toLark(g);
  assert.match(lark, /^start: block$/m);
  assert.match(lark, /^WS: \/\[ \\t\]\+\/$/m);
  assert.match(lark, /^IDENT: /m);
  assert.ok(!/^ws:/m.test(lark));
});
