import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runAblation } from '../ablation.ts';
import { CORPUS } from '../corpus/examples.ts';
import { MISTAKES } from '../corpus/mistakes.ts';
import type { DataDeps } from '../data.ts';
import { generatedFiles, wordList } from '../llm-files.ts';
import { SYSTEM_PROMPT, userMessage } from '../llm.ts';
import { defaultsFrom, type Settings } from '../settings-core.ts';
import { runStress } from '../stress.ts';
import { checkSource, correctSource, explainText, noBlock, problemLine, runNote, settingsIn, version, WORD_KINDS, wordNames, type Io } from './main.ts';
import { defaultCacheDir, nodeDeps } from './node-deps.ts';
import { runSummary, runText } from './report.ts';

const text = (t: string) => ({ type: 'text' as const, text: t });

/** Where run_backtest looked for a CSV file that is not there, and how to point it at the vault. */
const csvFolder = (vault: string | undefined): string =>
  vault === undefined
    ? 'The server reads CSV files from the folder where it started, because the vault_path argument is not given. Give the vault folder in vault_path, and write the path of the file from that folder.'
    : `The server reads CSV files from the vault_path folder, ${vault}. Make sure that it is the vault folder, and that the path of the file starts from it.`;

/**
 * The tools, resources and prompt; `depsFor` gives what a run reads from outside, with CSV files under `vault`, and
 * `settingsFor` the plugin settings a run in `vault` uses.
 */
export function createServer(depsFor: (vault: string | undefined) => DataDeps, settingsFor: (vault: string | undefined) => Promise<Settings>): McpServer {
  const server = new McpServer({ name: 'backtest-blocks', version: version() });

  const fix = z.object({
    label: z.string().describe('What the correction does, for example "Change to sma"'),
    line: z.number().describe('The line, counted as for the problem'),
    from: z.number().describe('The first column to replace, counted from 1 as for the problem'),
    endLine: z.number().optional().describe('For a correction that reaches into the lines after "line", such as one that removes blank lines: the line where it ends'),
    to: z.number().describe('The column after the last one to replace: on "endLine" when the correction has one, else on "line"'),
    insert: z.string().describe('The text to write in place of the columns from "from" up to "to"'),
  });
  const problem = z.object({
    file: z.string(),
    block: z.string().nullable().describe('The name of the block, when it has one'),
    line: z.number(),
    column: z.number().nullable(),
    severity: z.enum(['error', 'warning']),
    message: z.string(),
    suggestion: z.string().optional().describe('The correction in words, when there is one'),
    fixes: z.array(fix).describe('Each correction that removes the problem: none, one, or two or three equally good ones'),
  });

  server.registerTool(
    'check_strategy',
    {
      title: 'Examine a strategy block',
      description:
        'Examines a Backtest Blocks strategy with the parser of the plugin. The input is one block without a fence, or a full note that contains ```strategy blocks. Returns each error and warning with its line, and the corrections that the plugin has for it. corrected_source is the input with each correction made that is the only one for its problem. Examine each block that you write before you give it to the user. Correct the problems that it shows.',
      inputSchema: { source: z.string().describe('A strategy block (its lines, without the fence), or a Markdown note that contains ```strategy blocks') },
      outputSchema: {
        blocks: z.number(),
        errors: z.number(),
        warnings: z.number(),
        problems: z.array(problem),
        corrected_source: z
          .string()
          .optional()
          .describe('The input with each correction made that is the only one for its problem, then examined again for problems that a correction showed. Absent when there is no such correction'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ source }) => {
      const { blocks, problems } = checkSource(source, 'strategy');
      const errors = problems.filter((p) => p.severity === 'error').length;
      const corrected = correctSource(source, 'strategy');
      const summary = blocks === 0 ? `Found ${noBlock('strategy')}.` : problems.length === 0 ? `${blocks === 1 ? 'The block has' : `All ${blocks} blocks have`} no problems.` : problems.map(problemLine).join('\n');
      const more = corrected.fixed.length ? `\n\nThe source with each correction that is the only one for its problem:\n${corrected.text}` : '';
      return {
        content: [text(summary + more)],
        structuredContent: { blocks, errors, warnings: problems.length - errors, problems, ...(corrected.fixed.length ? { corrected_source: corrected.text } : {}) },
      };
    },
  );

  server.registerTool(
    'run_backtest',
    {
      title: 'Backtest a strategy block',
      description:
        'Backtests a strategy block on live prices (Yahoo Finance, Binance, Tiingo, FRED, or CSV files in vault_path). Returns the verdict, and the return per year, total return, worst drawdown and Sharpe ratio, compared with buy and hold. Also returns the trades and the positions after the last bar. The prices are saved between runs. It uses the plugin settings that the vault in vault_path keeps, or the default settings when there are none.',
      inputSchema: {
        source: z.string().describe('A strategy block, or a note that contains ```strategy blocks'),
        block: z.string().optional().describe('The block of a note to run: its name, or its number (the first block is 1). Necessary when the note has more than one block'),
        vault_path: z.string().optional().describe('The Obsidian vault folder, for the CSV files that the block reads and the plugin settings'),
        refresh: z.boolean().optional().describe('Download the prices again, and do not use the saved prices'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ source, block, vault_path, refresh }) => {
      let settings: Settings;
      try {
        settings = await settingsFor(vault_path);
      } catch (e) {
        return { content: [text(`Cannot read the plugin settings of the vault: ${e instanceof Error ? e.message : e}`)], isError: true };
      }
      const result = await runNote(source, 'strategy', block, depsFor(vault_path), refresh ?? false, settings, 'the block argument', vault_path);
      if ('code' in result) return { content: [text(/There is no file at /.test(result.message) ? `${result.message}\n${csvFolder(vault_path)}` : result.message)], isError: true };
      const stress = runStress(result.source, result.out.spec, result.out.data, result.out.backtest, defaultsFrom(settings));
      const ablation = runAblation(result.out.spec, result.out.data, result.out.backtest, result.source);
      return {
        content: [text(runText(result.out))],
        structuredContent: {
          ...runSummary(result.out),
          stress: {
            ...stress.breakingPoints,
            breakevenBps: Number.isFinite(stress.breakingPoints.breakevenBps) ? stress.breakingPoints.breakevenBps : null,
            breakevenCapped: !Number.isFinite(stress.breakingPoints.breakevenBps),
          },
          ablation: ablation.clauses.map((c) => ({
            id: c.id,
            label: c.label,
            verdict: c.verdict,
            deltaSharpe: c.deltaSharpe,
            deltaMaxDD: c.deltaMaxDD,
          })),
        },
      };
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
  const server = createServer(
    (vault) => nodeDeps({ vault: vault ?? io.cwd, cacheDir: defaultCacheDir(io.env), env: io.env, fetch: io.fetch }),
    (vault) => settingsIn(vault ?? io.cwd),
  );
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => (transport.onclose = resolve));
  await server.connect(transport);
  // The transport doesn't close itself when the client hangs up: it only stops getting data.
  process.stdin.once('end', () => void transport.close());
  await closed;
}
