import { CORPUS } from './corpus/examples.ts';
import { MISTAKES } from './corpus/mistakes.ts';
import type { CorpusExample } from './corpus/types.ts';
import { ALL_DOCS, FIXED_VALUES, type Doc, type DocKind } from './docs.ts';
import { LATER_WORDS, RESERVED } from './dsl.ts';
import { strategyGrammar, toGbnf, toLark } from './grammar.ts';
import { LANGUAGE_GUIDE } from './language-guide.ts';

/** One word as the word list gives it. */
const entry = (d: Doc) => ({ name: d.id, signature: d.signature, summary: d.short, text: d.text, example: d.example });
const ofKind = (kind: DocKind) => ALL_DOCS.filter((d) => d.kind === kind).map(entry);

/** Every word of the language with its form, meaning and an example, from the editor's help (docs.ts). */
export function languageJson(): string {
  const values = (setting: string) =>
    (FIXED_VALUES[setting] ?? []).map((v) => {
      const d = ALL_DOCS.find((x) => x.id === `${setting}=${v}`);
      return { value: v, summary: d?.short ?? '', text: d?.text ?? '' };
    });
  const list = {
    about:
      'The words of the Backtest Blocks strategy language. Functions, series, calendar and position values go in conditions; settings are "key: value" lines; words are the rest of the rule language. A parameter or definition name is letters, digits and underscores, starting with a letter or underscore, and is not one of "reserved".',
    functions: ofKind('function'),
    series: ofKind('series'),
    calendar: ofKind('calendar'),
    position: ofKind('position'),
    settings: ALL_DOCS.filter((d) => d.kind === 'setting').map((d) => ({ ...entry(d), ...(FIXED_VALUES[d.id] ? { values: values(d.id) } : {}) })),
    words: ofKind('word'),
    units: ofKind('unit'),
    reserved: [...RESERVED].sort(),
    laterWords: {
      about: 'Words added after 0.7.0. A block may still use one as a parameter or definition name, which it then means in that block; calling it as a function there is an error.',
      words: [...LATER_WORDS].sort(),
    },
  };
  return `${JSON.stringify(list, null, 2)}\n`;
}

const FENCE = '```';
const REPO = 'https://github.com/chauduyphanvu/obsidian-backtest';
const RAW = 'https://raw.githubusercontent.com/chauduyphanvu/obsidian-backtest/main';
/** Where the command line and MCP server can be downloaded: the file attached to the latest release. */
export const CLI_DOWNLOAD = `${REPO}/releases/latest/download/backtest-blocks.mjs`;

/** Everything a model needs to write a block: what a block is, the language, worked examples, and how to check one. */
export function llmsFull(): string {
  const example = (e: CorpusExample) =>
    [`### ${e.title}`, '', e.description, '', `${FENCE}strategy`, e.source, FENCE, ...(e.notes.length ? ['', ...e.notes.map((n) => `- ${n}`)] : [])].join('\n');
  return `# Backtest Blocks: writing strategy blocks

Backtest Blocks is a plugin for the note-taking app Obsidian. A strategy is written in a small rule language inside a ${FENCE}strategy code block in a note, and the plugin draws its backtest in place of the block. This document is what a writer needs: the language, worked examples and how to check a block. It is made from the plugin's code, so it lists exactly what the parser takes.

A block in a note looks like this, and only strategy lines go inside the fence:

${FENCE}strategy
name: SPY 200-day trend
universe: SPY

buy when close > sma(200)
sell when close < sma(200)
${FENCE}

A parser checks every line, and the rules it accepts are what get backtested. When a request asks for something the language cannot express, or you choose a value, ticker, period or cost it did not give, tell the reader in one short sentence each after the block. Where this guide says "say so in a NOTE", that is what it means.

${LANGUAGE_GUIDE}

## Worked examples

Each has the request, the block that answers it and what the writer told the reader. More are in ${RAW}/docs/corpus/examples.jsonl, and blocks with common mistakes, the parser's messages and their fixes in ${RAW}/docs/corpus/mistakes.jsonl.

${CORPUS.filter((e) => e.prompt).map(example).join('\n\n')}

## Check your work

- Command line: download ${CLI_DOWNLOAD} and run \`node backtest-blocks.mjs check note.md\`. It checks every strategy block in the note, prints each problem with its line and column, and exits with 1 when there is an error. \`node backtest-blocks.mjs run note.md\` backtests a block on live prices.
- MCP: \`node backtest-blocks.mjs mcp\` serves the tools check_strategy, run_backtest, explain_word and list_words, and this guide as a resource.
- Word list: ${RAW}/docs/language.json has every function, setting, value and word with its form, meaning and example.
- Grammar: ${RAW}/docs/grammar/strategy.lark and ${RAW}/docs/grammar/strategy.gbnf, for generating under a grammar. They take more than the parser does (any name, operators in any order), so check what they produce.
`;
}

/** The index of the files above, in the llms.txt layout (llmstxt.org). */
export function llmsTxt(): string {
  return `# Backtest Blocks

> A plugin for Obsidian that backtests trading strategies written in a small rule language, in \`strategy\` code blocks in a note. Long, short or leveraged up to 2×, on daily, weekly or intraday bars from Yahoo Finance, Binance, Tiingo or CSV files, with economic series from FRED.

A parser checks every line of a block, and only what it accepts is backtested. Write blocks from the guide below, then check them with the command line or the MCP server.

## Docs

- [Writing strategy blocks](${RAW}/llms-full.txt): the whole language for a writer, with worked examples and how to check a block
- [Word list](${RAW}/docs/language.json): every function, setting, value and word, with its form, meaning and an example
- [Worked examples](${RAW}/docs/corpus/examples.jsonl): ${CORPUS.length} requests in plain English and the blocks that answer them
- [Mistakes and fixes](${RAW}/docs/corpus/mistakes.jsonl): ${MISTAKES.length} blocks with a mistake, what the parser says and the block put right

## Tools

- [Command line and MCP server](${CLI_DOWNLOAD}): one file for Node.js. \`node backtest-blocks.mjs check note.md\` checks blocks, \`run\` backtests one, and \`mcp\` serves both as MCP tools
- [Lark grammar](${RAW}/docs/grammar/strategy.lark) and [GBNF grammar](${RAW}/docs/grammar/strategy.gbnf): for generating under a grammar; they take more than the parser does, so check the result

## Optional

- [Full reference](${RAW}/docs/reference.md): the complete guide, written for people
- [Source](${REPO})
`;
}

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** The files written for language models and tools, by their path in the repository. */
export function generatedFiles(): Record<string, string> {
  const grammar = strategyGrammar();
  return {
    'llms.txt': llmsTxt(),
    'llms-full.txt': llmsFull(),
    'docs/language.json': languageJson(),
    'docs/corpus/examples.jsonl': jsonl(CORPUS.map((e) => ({ title: e.title, description: e.description, strategy: e.source, notes: e.notes, tags: e.tags }))),
    'docs/corpus/mistakes.jsonl': jsonl(MISTAKES.map((m) => ({ title: m.title, why: m.why, broken: m.broken, errors: m.errors, fixed: m.fixed }))),
    'docs/grammar/strategy.lark': toLark(grammar),
    'docs/grammar/strategy.gbnf': toGbnf(grammar),
  };
}
