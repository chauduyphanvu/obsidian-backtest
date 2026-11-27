// The MCP server as a client sees it: its tools, resources and prompt, through the SDK's own client.

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { settingsIn } from '../src/cli/main.ts';
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
  }, (v) => settingsIn(v ?? vault));
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
  assert.equal(textOf(bad), 'strategy:3:7: error: "01/31/2015" is not a date in the form YYYY-MM-DD. For example, write 2015-01-31.');
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
  assert.match(textOf(bad), /^The block has errors. It did not run:\nstrategy:2/);
});

test('run_backtest uses the plugin settings that the vault in vault_path keeps', async () => {
  const kept = join(dir, 'kept');
  mkdirSync(join(kept, '.obsidian/plugins/backtest-blocks'), { recursive: true });
  mkdirSync(join(kept, 'Data'), { recursive: true });
  copyFileSync(join(vault, 'Data/walk.csv'), join(kept, 'Data/walk.csv'));
  writeFileSync(join(kept, '.obsidian/plugins/backtest-blocks/data.json'), JSON.stringify({ costs: '50 bps' }));
  const source = 'name: Walk\nuniverse: csv:Data/walk.csv\nbuy when close > sma(30)\nsell when close < sma(30)';
  const total = async (vault_path: string) => {
    const r = await client.callTool({ name: 'run_backtest', arguments: { source, vault_path } });
    assert.ok(!r.isError, textOf(r));
    return (r.structuredContent as { strategy: { totalReturn: number } }).strategy.totalReturn;
  };
  assert.ok((await total(kept)) < (await total(vault)));
  writeFileSync(join(kept, '.obsidian/plugins/backtest-blocks/data.json'), '{ not json');
  const broken = await client.callTool({ name: 'run_backtest', arguments: { source, vault_path: kept } });
  assert.equal(broken.isError, true);
  assert.match(textOf(broken), /^Cannot read the plugin settings of the vault: /);
});

test('run_backtest says plainly when the prices can not be had', async () => {
  const r = await client.callTool({ name: 'run_backtest', arguments: { source: 'universe: SPY\nbuy when close > sma(5)\nsell when close < sma(5)' } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^The backtest did not run: /);
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

test('run_backtest names a problem at its line in the note, as check_strategy does', async () => {
  const note = ['# Note', '', 'Some text.', '', '> [!tip]', '> ```strategy', '> universe: SPY', '> buy when close > sma(20', '> ```'].join('\n');
  const checked = textOf(await client.callTool({ name: 'check_strategy', arguments: { source: note } }));
  const ran = await client.callTool({ name: 'run_backtest', arguments: { source: note } });
  assert.equal(ran.isError, true);
  const line = checked.match(/^strategy:\d+:\d+: error: .*$/m)![0];
  assert.ok(textOf(ran).includes(line), `${textOf(ran)}\n--- should hold ---\n${line}`);
});

test('check_strategy gives each problem its corrections, and the source with each correction that is the only one made', async () => {
  const source = 'universe: SPY\nrebalance: montly\nbuy when close > smaa(200)\nsell when close < sam(200)';
  const r = await client.callTool({ name: 'check_strategy', arguments: { source } });
  const s = r.structuredContent as { errors: number; problems: { line: number; suggestion?: string; fixes: unknown[] }[]; corrected_source?: string };
  assert.equal(s.errors, 3);
  assert.deepEqual(s.problems.map((p) => [p.line, p.suggestion, p.fixes.length]), [
    [2, 'Did you mean monthly?', 1],
    [3, 'Did you mean sma, the simple average of the last n closes?', 1],
    [4, 'Possible corrections: sma, sum.', 2],
  ]);
  assert.deepEqual(s.problems[0].fixes, [{ label: 'Change to monthly', line: 2, from: 12, to: 18, insert: 'monthly' }]);
  // A choice between two is left for the model to make.
  assert.equal(s.corrected_source, 'universe: SPY\nrebalance: monthly\nbuy when close > sma(200)\nsell when close < sam(200)');
  const t = textOf(r);
  assert.match(t, /^strategy:2:12: error: rebalance must be one of: .+\n {2}Did you mean monthly\?\n/);
  assert.ok(t.endsWith(`The source with each correction that is the only one for its problem:\n${s.corrected_source}`));
  // In a note, the note comes back with the corrections made in its blocks.
  const note = '# Note\n\n```strategy\nuniverse: SPY\nbuy when close > smaa(200)\n```\n';
  const inNote = await client.callTool({ name: 'check_strategy', arguments: { source: note } });
  assert.equal((inNote.structuredContent as { corrected_source?: string }).corrected_source, note.replace('smaa', 'sma'));
  // Nothing to correct: no corrected source.
  const tie = await client.callTool({ name: 'check_strategy', arguments: { source: 'universe: SPY\nbuy when close > sam(200)' } });
  assert.ok(!('corrected_source' in (tie.structuredContent as object)));
});

test('explain_word takes a window with its number, and maps crossover to crosses with a note', async () => {
  assert.match(textOf(await client.callTool({ name: 'explain_word', arguments: { word: 'for 3 bars' } })), /^condition for n bars\n/);
  assert.match(textOf(await client.callTool({ name: 'explain_word', arguments: { word: 'crossover' } })), /^"crossover" is not a word of the language\. .+\n\na crosses b\n/);
});

test('run_backtest names the vault_path argument when it cannot find a CSV file', async () => {
  const source = 'universe: csv:Data/missing.csv\nbuy when close > sma(30)\nsell when close < sma(30)';
  const given = await client.callTool({ name: 'run_backtest', arguments: { source, vault_path: vault } });
  assert.equal(given.isError, true);
  assert.match(textOf(given), /There is no file at Data\/missing\.csv/);
  assert.ok(textOf(given).endsWith(`The server reads CSV files from the vault_path folder, ${vault}. Make sure that it is the vault folder, and that the path of the file starts from it.`));
  const none = await client.callTool({ name: 'run_backtest', arguments: { source } });
  assert.match(textOf(none), /because the vault_path argument is not given\. Give the vault folder in vault_path/);
});

test('check_strategy on a block in a plain fence says how to fence it', async () => {
  const r = await client.callTool({ name: 'check_strategy', arguments: { source: '```\nuniverse: SPY\nbuy when close > sma(200)\n```' } });
  assert.match(textOf(r), /```strategy/);
});

test('run_backtest omits stress and ablation by default and computes them when opted in', async () => {
  const source = 'name: Walk\nuniverse: csv:Data/walk.csv\nbuy when close > sma(30) and rsi(14) < 70\nsell when close < sma(30)';
  const fast = await client.callTool({ name: 'run_backtest', arguments: { source, vault_path: vault } });
  assert.ok(!fast.isError, textOf(fast));
  const fastContent = fast.structuredContent as Record<string, unknown>;
  assert.equal('stress' in fastContent, false);
  assert.equal('ablation' in fastContent, false);

  const full = await client.callTool({
    name: 'run_backtest',
    arguments: { source, vault_path: vault, include_stress: true, include_ablation: true },
  });
  assert.ok(!full.isError, textOf(full));
  const fullContent = full.structuredContent as Record<string, unknown>;
  assert.ok('stress' in fullContent && fullContent.stress !== null);
  assert.ok(Array.isArray(fullContent.ablation) && fullContent.ablation.length > 0);
});

test('check_strategy resolves DAG links when vault_path is provided', async () => {
  writeFileSync(join(vault, 'Parent.md'), '```strategy\nname: Parent\nuniverse: csv:Data/walk.csv\nbuy when close > sma(30)\nsell when close < sma(30)\n```');
  const child = 'name: Child\nextends: [[Parent]]\nstop loss: 10%\nbuy when base';
  const ok = await client.callTool({ name: 'check_strategy', arguments: { source: child, vault_path: vault } });
  const okContent = ok.structuredContent as { errors: number; blocks: number };
  assert.equal(okContent.blocks, 1);
  assert.equal(okContent.errors, 0);

  const broken = await client.callTool({ name: 'check_strategy', arguments: { source: 'name: Bad\nextends: [[MissingParent]]\nbuy when base', vault_path: vault } });
  const brokenContent = broken.structuredContent as { errors: number; problems: { message: string }[] };
  assert.equal(brokenContent.errors, 1);
  assert.match(brokenContent.problems[0].message, /MissingParent/);
});
