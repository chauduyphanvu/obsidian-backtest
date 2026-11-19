import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { extractBlocks } from '../blocks.ts';
import { ALL_DOCS, docFor, type Doc } from '../docs.ts';
import { parseSpec, type Diagnostic } from '../dsl.ts';
import { languageJson, llmsFull, wordList } from '../llm-files.ts';
import type { DataDeps } from '../data.ts';
import { Runner, type RunOutput } from '../runner.ts';
import { DEFAULT_SETTINGS, defaultsFrom } from '../settings-core.ts';
import { defaultCacheDir, nodeDeps } from './node-deps.ts';
import { runSummary, runText } from './report.ts';

/** Set by the build; a run from the sources reads manifest.json. */
declare const BACKTEST_BLOCKS_VERSION: string | undefined;

export interface Io {
  out(text: string): void;
  err(text: string): void;
  stdin(): Promise<string>;
  env: NodeJS.ProcessEnv;
  cwd: string;
  fetch?: typeof fetch;
}

/** A stream read whole as UTF-8, joined as bytes first so a character split between two chunks stays whole. */
export async function readText(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(parts).toString('utf8');
}

const HELP = `backtest-blocks: examine and backtest the strategy blocks of Backtest Blocks without Obsidian.

Usage:
  backtest-blocks check <file|->...      examine all strategy blocks in notes, or one block without a fence (exit code 1 for errors)
  backtest-blocks run <file|-> [--block <name|n>] [--vault <dir>] [--cache <dir>] [--refresh]
                                          backtest one block on live prices and print the result
  backtest-blocks explain <word>          show the help text for a function, setting, value or word
  backtest-blocks words                   list all words of the language
  backtest-blocks guide                   print the instructions to write blocks (llms-full.txt)
  backtest-blocks mcp                     start an MCP server on stdio with the check, run and explain tools
  backtest-blocks --version | --help

Options:
  --json     print JSON, not text (check, run, words)
  --block    the block of the note to run: its name, or its number (the first block is 1)
  --vault    the vault folder, for the CSV files that a block reads (default: the folder above the note that contains .obsidian)
  --cache    the folder for saved prices (default: $XDG_CACHE_HOME/backtest-blocks or ~/.cache/backtest-blocks)
  --refresh  download the prices again, and do not use the saved prices

The keys for Tiingo and FRED are in TIINGO_API_KEY and FRED_API_KEY.`;

export function version(): string {
  if (typeof BACKTEST_BLOCKS_VERSION === 'string') return BACKTEST_BLOCKS_VERSION;
  return JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8')).version;
}

interface FoundBlock {
  name: string | null;
  source: string;
  /** 0-based line of the note where the block's text starts. */
  start: number;
}

/** A Markdown note's name: its blocks must be fenced, since its prose is not a block. */
const isNote = (file: string) => /\.md$/i.test(file);

/** What to say of a text with no strategy block in it. */
export const noBlock = (file: string) => `no strategy block: a block starts with \`\`\`strategy${isNote(file) ? '' : ', or give the lines of the block without a fence'}`;

/** The strategy blocks of a note, or the whole text as one block when it is not a note and has no fence at all. */
export function blocksIn(text: string, note = false): FoundBlock[] {
  const blocks = extractBlocks(text);
  if (blocks.length > 0) return blocks.map((b) => ({ name: b.name, source: b.source, start: b.line + 1 }));
  return note || /^\s*(`{3,}|~{3,})/m.test(text) ? [] : [{ name: null, source: text.replace(/\n+$/, ''), start: 0 }];
}

export interface Problem {
  file: string;
  block: string | null;
  line: number;
  column: number | null;
  severity: 'error' | 'warning';
  message: string;
}

function problemsOf(file: string, text: string, b: FoundBlock): Problem[] {
  const fileLines = text.split(/\r?\n/);
  const blockLines = b.source.split('\n');
  const { errors, warnings } = parseSpec(b.source);
  const place = (d: Diagnostic, severity: Problem['severity']): Problem => {
    const fileLine = fileLines[b.start + d.line - 1] ?? '';
    const own = blockLines[d.line - 1] ?? '';
    // A block in a callout or quote has its markers before the text the parser read.
    const shift = fileLine.endsWith(own) ? fileLine.length - own.length : 0;
    return { file, block: b.name, line: b.start + d.line, column: d.from === undefined ? null : shift + d.from + 1, severity, message: d.message };
  };
  return [...errors.map((d) => place(d, 'error')), ...warnings.map((d) => place(d, 'warning'))].sort((x, y) => x.line - y.line);
}

/** Every problem in the strategy blocks of a note, or of a bare block, with lines counted in the note. */
export function checkSource(text: string, file: string): { blocks: number; problems: Problem[] } {
  const found = blocksIn(text, isNote(file));
  return { blocks: found.length, problems: found.flatMap((b) => problemsOf(file, text, b)) };
}

/** A problem as one line: "note.md:12:5: error: message". */
export const problemLine = (p: Problem): string => `${p.file}:${p.line}${p.column === null ? '' : `:${p.column}`}: ${p.severity}: ${p.message}`;

async function readInput(path: string, io: Io): Promise<string> {
  return path === '-' ? io.stdin() : readFile(resolve(io.cwd, path), 'utf8');
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function check(files: string[], json: boolean, io: Io): Promise<number> {
  if (files.length === 0) {
    io.err('check: give a note, or - to read a block from standard input');
    return 2;
  }
  const problems: Problem[] = [];
  let blocks = 0;
  let empty = 0;
  let unread = 0;
  for (const file of files) {
    let text: string;
    try {
      text = await readInput(file, io);
    } catch (e) {
      // The other notes are still checked, so their problems are not lost.
      io.err(`check: cannot read ${file}: ${e instanceof Error ? e.message : e}`);
      unread++;
      continue;
    }
    const found = checkSource(text, file);
    // A note with no block to check is a mistake too: the fence may be misspelt.
    if (found.blocks === 0) {
      io.err(`${file}: ${noBlock(file)}`);
      empty++;
    }
    blocks += found.blocks;
    problems.push(...found.problems);
  }
  const errors = problems.filter((p) => p.severity === 'error').length;
  if (json) io.out(JSON.stringify({ blocks, errors, warnings: problems.length - errors, notesWithoutBlock: empty, notesUnread: unread, problems }, null, 2));
  else {
    for (const p of problems) io.out(problemLine(p));
    const said = [
      ...(problems.length ? [`${plural(errors, 'error', 'errors')}, ${plural(problems.length - errors, 'warning', 'warnings')}`] : []),
      ...(empty ? [`${plural(empty, 'note', 'notes')} with no strategy block`] : []),
      ...(unread ? [`${plural(unread, 'note', 'notes')} not read`] : []),
    ];
    io.err(`${plural(blocks, 'block', 'blocks')} examined: ${said.join('; ') || 'no problems'}`);
  }
  return unread > 0 ? 2 : errors > 0 || empty > 0 ? 1 : 0;
}

/** The folder above `from` that holds .obsidian, which makes it a vault; null when there is none. */
function vaultAbove(from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.obsidian'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** The block of a note to run: the one named or numbered, or the only one; else what to say. */
export function pickBlock(text: string, file: string, block: string | undefined, how = '--block'): { block: FoundBlock } | { error: string } {
  const found = blocksIn(text, isNote(file));
  let b: FoundBlock | undefined;
  if (block !== undefined) b = /^\d+$/.test(block) ? found[Number(block) - 1] : found.find((x) => x.name?.toLowerCase() === block.toLowerCase());
  else if (found.length === 1) b = found[0];
  if (b) return { block: b };
  const list = found.map((x, i) => `${i + 1}${x.name ? `: ${x.name}` : ''}`).join(', ');
  return {
    error:
      found.length === 0 ? `${file}: ${noBlock(file)}` : block === undefined ? `${file} has ${found.length} blocks (${list}). Select one with ${how}` : `${file} has no block "${block}". Its blocks: ${list}`,
  };
}

/** Why a block was not run: which block to run is unclear (2), or it has errors, each at its line in the note (1). */
export type NotRun = { code: 1 | 2; message: string };

/** Runs one block of a note, or a bare block, with the plugin's default settings. Shared by `run` and the MCP tool. */
export async function runNote(text: string, file: string, block: string | undefined, deps: DataDeps, refresh: boolean, how = '--block'): Promise<{ out: RunOutput } | NotRun> {
  const picked = pickBlock(text, file, block, how);
  if ('error' in picked) return { code: 2, message: picked.error };
  const errors = problemsOf(file, text, picked.block).filter((p) => p.severity === 'error');
  if (errors.length > 0) return { code: 1, message: `The block has errors. It did not run:\n${errors.map(problemLine).join('\n')}` };
  const runner = new Runner(deps, defaultsFrom(DEFAULT_SETTINGS));
  try {
    return { out: await runner.run(runner.parse(picked.block.source).spec!, refresh) };
  } catch (e) {
    return { code: 1, message: `The backtest did not run: ${e instanceof Error ? e.message : e}` };
  }
}

async function run(file: string | undefined, o: { block?: string; vault?: string; cache?: string; refresh: boolean; json: boolean }, io: Io): Promise<number> {
  if (!file) {
    io.err('run: give a note, or - to read a block from standard input');
    return 2;
  }
  let text: string;
  try {
    text = await readInput(file, io);
  } catch (e) {
    io.err(`run: cannot read ${file}: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  const noteDir = file === '-' ? io.cwd : dirname(resolve(io.cwd, file));
  const deps = nodeDeps({
    vault: o.vault ? resolve(io.cwd, o.vault) : (vaultAbove(noteDir) ?? noteDir),
    cacheDir: o.cache ? resolve(io.cwd, o.cache) : defaultCacheDir(io.env),
    env: io.env,
    fetch: io.fetch,
  });
  const result = await runNote(text, file, o.block, deps, o.refresh);
  if ('code' in result) {
    io.err(result.message);
    return result.code;
  }
  io.out(o.json ? JSON.stringify(runSummary(result.out), null, 2) : runText(result.out));
  return 0;
}

/**
 * A word's entry, found as a block writes it, in any case: `sma`, `sma(200)`, `stop loss`, `stop loss: 10%`, and a
 * setting's fixed value as `rebalance: monthly` or `rebalance=monthly`.
 */
export function findDoc(word: string): Doc | undefined {
  const w = word.trim().replace(/\s+/g, ' ').toLowerCase();
  const byId = (id: string) => docFor(id) ?? ALL_DOCS.find((d) => d.id.toLowerCase() === id);
  const call = w.match(/^([a-z_]+)\s*\(.*\)$/);
  const setting = w.match(/^([a-z ]+?)\s*[:=]\s*(.+)$/);
  return byId(w) ?? (call ? byId(call[1]) : undefined) ?? (setting ? (byId(`${setting[1]}=${setting[2]}`) ?? byId(setting[1])) : undefined);
}

/** A word's form, meaning and example as text, or what to say when it is not a word of the language. */
export function explainText(word: string): { text: string } | { error: string } {
  const d = findDoc(word);
  if (d) return { text: [d.signature, '', d.text, ...(d.example ? ['', 'Example:', d.example] : [])].join('\n') };
  const near = ALL_DOCS.filter((x) => x.id.toLowerCase().includes(word.trim().toLowerCase())).map((x) => x.id);
  return { error: `"${word}" is not a word of the language.${near.length ? ` Words that contain "${word.trim()}": ${near.slice(0, 8).join(', ')}.` : ' To see all words, use list_words or backtest-blocks words.'}` };
}

function explain(word: string | undefined, io: Io): number {
  if (!word) {
    io.err('explain: give a word, for example sma or stop loss');
    return 2;
  }
  const found = explainText(word);
  if ('error' in found) {
    io.err(found.error);
    return 1;
  }
  io.out(found.text);
  return 0;
}

/** The kinds of word the word list has, in the order they are listed. */
export const WORD_KINDS = ['functions', 'series', 'calendar', 'position', 'settings', 'words', 'units'] as const;

/** The names of every word, a line for each kind. */
export const wordNames = (): string => WORD_KINDS.map((k) => `${k}: ${wordList()[k].map((w) => w.name).join(', ')}`).join('\n');

function words(json: boolean, io: Io): number {
  io.out(json ? languageJson().trimEnd() : `${wordNames()}\n\nFor the help text of a word: backtest-blocks explain <word>`);
  return 0;
}

/** Runs one command; the number is the exit code. */
export async function cli(args: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        block: { type: 'string' },
        vault: { type: 'string' },
        cache: { type: 'string' },
        refresh: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : e}\n\n${HELP}`);
    return 2;
  }
  const { values: o, positionals: [command, ...rest] } = parsed;
  if (o.version) {
    io.out(version());
    return 0;
  }
  if (o.help || !command) {
    io.out(HELP);
    return command || o.help ? 0 : 2;
  }
  switch (command) {
    case 'check':
      return check(rest, o.json, io);
    case 'run':
      return run(rest[0], { block: o.block, vault: o.vault, cache: o.cache, refresh: o.refresh, json: o.json }, io);
    case 'explain':
      return explain(rest.join(' ') || undefined, io);
    case 'words':
      return words(o.json, io);
    case 'guide':
      io.out(llmsFull().trimEnd());
      return 0;
    case 'mcp': {
      const { serve } = await import('./mcp.ts');
      await serve(io);
      return 0;
    }
    default:
      io.err(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}
