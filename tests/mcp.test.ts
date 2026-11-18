// The MCP server as a client sees it: its tools, resources and prompt, through the SDK's own client.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/cli/mcp.ts';
import { nodeDeps } from '../src/cli/node-deps.ts';
import { SYSTEM_PROMPT } from '../src/llm.ts';
import { makeRng } from '../src/rng.ts';

const dir = mkdtempSync(join(tmpdir(), 'backtest-blocks-mcp-'));
const vault = join(dir, 'vault');
mkdirSync(join(vault, 'Data'), { recursive: true });
{
  const rng = makeRng(11);
  let c = 50;
  const t0 = Date.UTC(2021, 0, 1);
  const rows = Array.from({ length: 600 }, (_, i) => {
    const o = c;
    c *= 1 + (rng.next() - 0.48) * 0.025;
    return `${new Date(t0 + i * 86_400_000).toISOString().slice(0, 10)},${o},${Math.max(o, c)},${Math.min(o, c)},${c}`;
  });
  writeFileSync(join(vault, 'Data/walk.csv'), ['date,open,high,low,close', ...rows].join('\n'));
}

const client = new Client({ name: 'test', version: '1' });
const vaults: (string | undefined)[] = [];
before(async () => {
  const server = createServer((v) => {
    vaults.push(v);
    return nodeDeps({ vault: v ?? vault, cacheDir: join(dir, 'cache'), env: {}, fetch: () => Promise.reject(new Error('no network in tests')) });
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});
after(async () => {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

const textOf = (r: Record<string, unknown>) => ((r.content ?? []) as { text: string }[]).map((c) => c.text).join('\n');

test('the server offers its four tools, six resources and one prompt', async () => {
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ['check_strategy', 'run_backtest', 'explain_word', 'list_words']);
  assert.deepEqual((await client.listResources()).resources.map((r) => r.uri), [
    'backtest-blocks://guide',
    'backtest-blocks://words',
    'backtest-blocks://examples',
    'backtest-blocks://mistakes',
    'backtest-blocks://grammar/lark',
    'backtest-blocks://grammar/gbnf',
  ]);
  assert.deepEqual((await client.listPrompts()).prompts.map((p) => p.name), ['write_strategy']);
});

test('check_strategy says a good block has no problems and lists a bad one\'s with their lines', async () => {
  const good = await client.callTool({ name: 'check_strategy', arguments: { source: 'universe: SPY\nbuy when close > sma(200)\nsell when close < sma(200)' } });
  assert.equal(textOf(good), 'The block has no problems.');
  assert.deepEqual(good.structuredContent, { blocks: 1, errors: 0, warnings: 0, problems: [] });
  const bad = await client.callTool({ name: 'check_strategy', arguments: { source: '```strategy\nuniverse: SPY\nfrom: 01/31/2015\nbuy when true\n```' } });
  assert.equal(textOf(bad), 'strategy:3:7: error: "01/31/2015" is not a date. Write it as 2015-01-31');
  assert.equal((bad.structuredContent as { errors: number }).errors, 1);
});

test('run_backtest runs a block on a CSV file in the vault given, and refuses one with errors', async () => {
  const r = await client.callTool({
    name: 'run_backtest',
    arguments: { source: 'name: Walk\nuniverse: csv:Data/walk.csv\nbuy when close > sma(30)\nsell when close < sma(30)', vault_path: vault },
  });
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /^Walk\n2021-01-01 to 2022-08-23\n/);
  const s = r.structuredContent as { name: string; trades: { count: number }; strategy: { returnPerYear: number } };
  assert.equal(s.name, 'Walk');
  assert.ok(s.trades.count > 0 && Number.isFinite(s.strategy.returnPerYear));
  assert.equal(vaults.at(-1), vault);
  const bad = await client.callTool({ name: 'run_backtest', arguments: { source: 'universe: SPY\nbuy when close > sma(' } });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /^The block has errors, so it was not run:\nstrategy:2/);
});

test('run_backtest says plainly when the prices can not be had', async () => {
  const r = await client.callTool({ name: 'run_backtest', arguments: { source: 'universe: SPY\nbuy when close > sma(5)\nsell when close < sma(5)' } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^The backtest could not run: /);
});

test('explain_word and list_words', async () => {
  assert.match(textOf(await client.callTool({ name: 'explain_word', arguments: { word: 'bars held' } })), /^bars held\n\n/);
  const unknown = await client.callTool({ name: 'explain_word', arguments: { word: 'moving_average' } });
  assert.equal(unknown.isError, true);
  assert.match(textOf(await client.callTool({ name: 'list_words', arguments: {} })), /^functions: sma, ema, /);
  assert.match(textOf(await client.callTool({ name: 'list_words', arguments: { kind: 'calendar' } })), /trading_days_left: /);
});

test('the resources hold the guide, the word list, the corpus and the grammars', async () => {
  const read = async (uri: string) => ((await client.readResource({ uri })).contents[0] as { text: string }).text;
  assert.match(await read('backtest-blocks://guide'), /^# Backtest Blocks: writing strategy blocks/);
  assert.ok(JSON.parse(await read('backtest-blocks://words')).functions.length > 50);
  assert.ok((await read('backtest-blocks://examples')).split('\n').filter(Boolean).every((l) => 'strategy' in JSON.parse(l)));
  assert.match(await read('backtest-blocks://grammar/lark'), /^start: block$/m);
  assert.match(await read('backtest-blocks://grammar/gbnf'), /^root ::= block$/m);
});

test('write_strategy gives the drafter\'s instructions and the idea', async () => {
  const p = await client.getPrompt({ name: 'write_strategy', arguments: { description: 'Buy QQQ on dips' } });
  const t = (p.messages[0].content as { text: string }).text;
  assert.ok(t.startsWith(SYSTEM_PROMPT));
  assert.match(t, /Buy QQQ on dips/);
  assert.match(t, /check_strategy/);
});
