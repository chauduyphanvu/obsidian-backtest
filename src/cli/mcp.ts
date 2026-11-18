import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CORPUS } from '../corpus/examples.ts';
import { MISTAKES } from '../corpus/mistakes.ts';
import type { DataDeps } from '../data.ts';
import { generatedFiles, wordList } from '../llm-files.ts';
import { SYSTEM_PROMPT, userMessage } from '../llm.ts';
import { checkSource, explainText, noBlock, problemLine, runNote, version, WORD_KINDS, wordNames, type Io } from './main.ts';
import { defaultCacheDir, nodeDeps } from './node-deps.ts';
import { runSummary, runText } from './report.ts';

const text = (t: string) => ({ type: 'text' as const, text: t });

/** The tools, resources and prompt; `depsFor` gives what a run reads from outside, with CSV files under `vault`. */
export function createServer(depsFor: (vault: string | undefined) => DataDeps): McpServer {
  const server = new McpServer({ name: 'backtest-blocks', version: version() });

  server.registerTool(
    'check_strategy',
    {
      title: 'Check a strategy block',
      description:
        'Checks a Backtest Blocks strategy with the plugin\'s own parser: a bare block, or a whole note with ```strategy blocks in it. Returns every error and warning with its line. Check each block you write before giving it to the user, and fix what it reports.',
      inputSchema: { source: z.string().describe('A strategy block (its lines, without the fence), or a note in Markdown holding ```strategy blocks') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ source }) => {
      const { blocks, problems } = checkSource(source, 'strategy');
      const errors = problems.filter((p) => p.severity === 'error').length;
      const summary = blocks === 0 ? `Found ${noBlock('strategy')}.` : problems.length === 0 ? `${blocks === 1 ? 'The block has' : `All ${blocks} blocks have`} no problems.` : problems.map(problemLine).join('\n');
      return { content: [text(summary)], structuredContent: { blocks, errors, warnings: problems.length - errors, problems } };
    },
  );

  server.registerTool(
    'run_backtest',
    {
      title: 'Backtest a strategy block',
      description:
        'Backtests a strategy block on live prices (Yahoo Finance, Binance, Tiingo, FRED, or CSV files under vault_path) and returns the verdict, return per year, total return, worst drawdown and Sharpe ratio against buy and hold, the trades and what it holds now. Prices are saved between runs.',
      inputSchema: {
        source: z.string().describe('A strategy block, or a note holding ```strategy blocks'),
        block: z.string().optional().describe('Which block of a note to run: its name, or its number from 1. Needed when the note has several'),
        vault_path: z.string().optional().describe('The Obsidian vault folder, for CSV files the block reads'),
        refresh: z.boolean().optional().describe('Fetch prices again instead of using saved ones'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ source, block, vault_path, refresh }) => {
      const result = await runNote(source, 'strategy', block, depsFor(vault_path), refresh ?? false, 'the block argument');
      if ('code' in result) return { content: [text(result.message)], isError: true };
      return { content: [text(runText(result.out))], structuredContent: runSummary(result.out) };
    },
  );

  server.registerTool(
    'explain_word',
    {
      title: 'Explain a word of the language',
      description: 'What a function, setting, setting value (as "rebalance=monthly"), series, calendar or position value, or rule word means: its form, a sentence or two, and an example.',
      inputSchema: { word: z.string().describe('Such as sma, stop loss, bars held, crosses above or rebalance=monthly') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ word }) => {
      const found = explainText(word);
      return 'error' in found ? { content: [text(found.error)], isError: true } : { content: [text(found.text)] };
    },
  );

  server.registerTool(
    'list_words',
    {
      title: 'List the words of the language',
      description: 'Every word of the strategy language of one kind, with its form and a short meaning. Without a kind, the names of every word by kind.',
      inputSchema: { kind: z.enum(WORD_KINDS).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ kind }) => ({
      content: [text(kind ? wordList()[kind].map((w) => `${w.signature}: ${w.summary}`).join('\n') : wordNames())],
    }),
  );

  // Made once: a server runs for as long as its client does.
  const files = generatedFiles();
  const resource = (name: string, uri: string, title: string, description: string, mimeType: string, body: () => string) =>
    server.registerResource(name, uri, { title, description, mimeType }, async (u) => ({ contents: [{ uri: u.href, mimeType, text: body() }] }));
  resource('guide', 'backtest-blocks://guide', 'Writing strategy blocks', 'The whole language for a writer, with worked examples and how to check a block.', 'text/markdown', () => files['llms-full.txt']);
  resource('words', 'backtest-blocks://words', 'Word list', 'Every function, setting, value and word, with its form, meaning and an example.', 'application/json', () => files['docs/language.json']);
  resource('examples', 'backtest-blocks://examples', 'Worked examples', `${CORPUS.length} requests in plain English and the blocks that answer them, one JSON object a line.`, 'application/jsonl', () => files['docs/corpus/examples.jsonl']);
  resource('mistakes', 'backtest-blocks://mistakes', 'Mistakes and fixes', `${MISTAKES.length} blocks with a mistake, what the parser says, and the block put right, one JSON object a line.`, 'application/jsonl', () => files['docs/corpus/mistakes.jsonl']);
  resource('grammar-lark', 'backtest-blocks://grammar/lark', 'Lark grammar', 'The text of one block, for generating under a grammar. It takes more than the parser does: check the result.', 'text/plain', () => files['docs/grammar/strategy.lark']);
  resource('grammar-gbnf', 'backtest-blocks://grammar/gbnf', 'GBNF grammar', 'The same grammar for llama.cpp.', 'text/plain', () => files['docs/grammar/strategy.gbnf']);

  server.registerPrompt(
    'write_strategy',
    {
      title: 'Write a strategy',
      description: 'Turns a trading idea in plain English into a strategy block, with the instructions the plugin\'s own drafter uses.',
      argsSchema: { description: z.string().describe('The trading idea, in plain English') },
    },
    ({ description }) => ({
      messages: [{ role: 'user', content: text(`${SYSTEM_PROMPT}\n\n---\n\n${userMessage(description)}\n\nCheck the block with the check_strategy tool before you reply, and fix what it reports.`) }],
    }),
  );

  return server;
}

/** Serves the tools over standard input and output until the client closes them. */
export async function serve(io: Io): Promise<void> {
  const server = createServer((vault) => nodeDeps({ vault: vault ?? io.cwd, cacheDir: defaultCacheDir(io.env), env: io.env, fetch: io.fetch }));
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => (transport.onclose = resolve));
  await server.connect(transport);
  // The transport doesn't close itself when the client hangs up: it only stops getting data.
  process.stdin.once('end', () => void transport.close());
  await closed;
}
