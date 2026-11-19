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
      title: 'Examine a strategy block',
      description:
        'Examines a Backtest Blocks strategy with the parser of the plugin. The input is one block without a fence, or a full note that contains ```strategy blocks. Returns each error and warning with its line. Examine each block that you write before you give it to the user. Correct the problems that it shows.',
      inputSchema: { source: z.string().describe('A strategy block (its lines, without the fence), or a Markdown note that contains ```strategy blocks') },
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
        'Backtests a strategy block on live prices (Yahoo Finance, Binance, Tiingo, FRED, or CSV files in vault_path). Returns the verdict, and the return per year, total return, worst drawdown and Sharpe ratio, compared with buy and hold. Also returns the trades and the positions after the last bar. The prices are saved between runs.',
      inputSchema: {
        source: z.string().describe('A strategy block, or a note that contains ```strategy blocks'),
        block: z.string().optional().describe('The block of a note to run: its name, or its number (the first block is 1). Necessary when the note has more than one block'),
        vault_path: z.string().optional().describe('The Obsidian vault folder, for the CSV files that the block reads'),
        refresh: z.boolean().optional().describe('Download the prices again, and do not use the saved prices'),
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
      title: 'Help text for a word of the language',
      description: 'Gives the help text for a function, setting, setting value (for example "rebalance=monthly"), series, calendar value, position value or rule word. The help text has the syntax, one or two sentences and an example.',
      inputSchema: { word: z.string().describe('For example sma, stop loss, bars held, crosses above or rebalance=monthly') },
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
      description: 'All words of one type (the kind argument) in the strategy language, each with its syntax and a short description. Without kind, the names of all words, by type.',
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
  resource('guide', 'backtest-blocks://guide', 'How to write strategy blocks', 'The full strategy language, with examples and the procedure to examine a block.', 'text/markdown', () => files['llms-full.txt']);
  resource('words', 'backtest-blocks://words', 'Word list', 'All functions, settings, values and words, each with its syntax, its description and an example.', 'application/json', () => files['docs/language.json']);
  resource('examples', 'backtest-blocks://examples', 'Examples', `${CORPUS.length} requests in plain English and the blocks for them. One JSON object on each line.`, 'application/jsonl', () => files['docs/corpus/examples.jsonl']);
  resource('mistakes', 'backtest-blocks://mistakes', 'Errors and corrections', `${MISTAKES.length} blocks with an error, the parser message, and the corrected block. One JSON object on each line.`, 'application/jsonl', () => files['docs/corpus/mistakes.jsonl']);
  resource('grammar-lark', 'backtest-blocks://grammar/lark', 'Lark grammar', 'The grammar of one block, for output that a grammar controls. It accepts more than the parser accepts. Examine the result with the parser.', 'text/plain', () => files['docs/grammar/strategy.lark']);
  resource('grammar-gbnf', 'backtest-blocks://grammar/gbnf', 'GBNF grammar', 'The same grammar for llama.cpp.', 'text/plain', () => files['docs/grammar/strategy.gbnf']);

  server.registerPrompt(
    'write_strategy',
    {
      title: 'Write a strategy',
      description: 'Writes a strategy block from a trading idea in plain English. It uses the same instructions as the plugin command "Write a strategy from a description".',
      argsSchema: { description: z.string().describe('The trading idea, in plain English') },
    },
    ({ description }) => ({
      messages: [{ role: 'user', content: text(`${SYSTEM_PROMPT}\n\n---\n\n${userMessage(description)}\n\nUse the check_strategy tool to examine the block before you reply. Correct the problems that it shows.`) }],
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
