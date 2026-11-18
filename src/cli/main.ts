import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { extractBlocks } from '../blocks.ts';
import { ALL_DOCS, docFor, type Doc } from '../docs.ts';
import { parseSpec, type Diagnostic } from '../dsl.ts';
import { languageJson, llmsFull } from '../llm-files.ts';
import { Runner } from '../runner.ts';
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

const HELP = `backtest-blocks: check and backtest the strategy blocks of Backtest Blocks, outside Obsidian.

Usage:
  backtest-blocks check <file|->...      check every strategy block in notes (or a bare block); exit 1 on errors
  backtest-blocks run <file|-> [--block <name|n>] [--vault <dir>] [--cache <dir>] [--refresh]
                                          backtest one block on live prices and print the result
  backtest-blocks explain <word>          what a function, setting, value or word means
  backtest-blocks words                   every word of the language
  backtest-blocks guide                   the guide for writing blocks (llms-full.txt)
  backtest-blocks mcp                     serve check, run and explain as MCP tools over stdio
  backtest-blocks --version | --help

Options:
  --json     print JSON instead of text (check, run, words)
  --block    which block of the note to run: its name, or its number from 1
  --vault    the vault folder, for CSV files a block reads (default: the folder above the note that holds .obsidian)
  --cache    where prices are saved between runs (default: $XDG_CACHE_HOME/backtest-blocks or ~/.cache/backtest-blocks)
  --refresh  fetch prices again instead of using saved ones

Tiingo and FRED read their keys from TIINGO_API_KEY and FRED_API_KEY.`;

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

/** The strategy blocks of a note, or the whole text as one block when it has no strategy fence. */
export function blocksIn(text: string): FoundBlock[] {
  const blocks = extractBlocks(text);
  if (blocks.length > 0) return blocks.map((b) => ({ name: b.name, source: b.source, start: b.line + 1 }));
  return /^\s*(`{3,}|~{3,})/m.test(text) ? [] : [{ name: null, source: text.replace(/\n+$/, ''), start: 0 }];
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
  const found = blocksIn(text);
  return { blocks: found.length, problems: found.flatMap((b) => problemsOf(file, text, b)) };
}

/** A problem as one line: "note.md:12:5: error: message". */
export const problemLine = (p: Problem): string => `${p.file}:${p.line}${p.column === null ? '' : `:${p.column}`}: ${p.severity}: ${p.message}`;

async function readInput(path: string, io: Io): Promise<string> {
  return path === '-' ? io.stdin() : readFile(resolve(io.cwd, path), 'utf8');
}

async function check(files: string[], json: boolean, io: Io): Promise<number> {
  if (files.length === 0) {
    io.err('check: name a note, or - to read a block from standard input');
    return 2;
  }
  const problems: Problem[] = [];
  let blocks = 0;
  for (const file of files) {
    let text: string;
    try {
      text = await readInput(file, io);
    } catch (e) {
      io.err(`check: can't read ${file}: ${e instanceof Error ? e.message : e}`);
      return 2;
    }
    const found = checkSource(text, file);
    if (found.blocks === 0) io.err(`${file}: no strategy block`);
    blocks += found.blocks;
    problems.push(...found.problems);
  }
  const errors = problems.filter((p) => p.severity === 'error').length;
  if (json) io.out(JSON.stringify({ blocks, errors, warnings: problems.length - errors, problems }, null, 2));
  else {
    for (const p of problems) io.out(problemLine(p));
    io.err(`${blocks} ${blocks === 1 ? 'block' : 'blocks'} checked: ${errors === 0 && problems.length === 0 ? 'no problems' : `${errors} ${errors === 1 ? 'error' : 'errors'}, ${problems.length - errors} ${problems.length - errors === 1 ? 'warning' : 'warnings'}`}`);
  }
  // A note with no block to check is a mistake too: the fence may be misspelt.
  return errors > 0 || blocks === 0 ? 1 : 0;
}

/** The folder above `from` that holds .obsidian, which makes it a vault; null when there is none. */
function vaultAbove(from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.obsidian'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** The block of a note to run: the one named or numbered, or the only one; else what to say. */
export function pickBlock(text: string, file: string, block: string | undefined): { block: FoundBlock } | { error: string } {
  const found = blocksIn(text);
  let b: FoundBlock | undefined;
  if (block !== undefined) b = /^\d+$/.test(block) ? found[Number(block) - 1] : found.find((x) => x.name?.toLowerCase() === block.toLowerCase());
  else if (found.length === 1) b = found[0];
  if (b) return { block: b };
  const list = found.map((x, i) => `${i + 1}${x.name ? `: ${x.name}` : ''}`).join(', ');
  return {
    error:
      found.length === 0 ? `${file}: no strategy block` : block === undefined ? `${file} has ${found.length} blocks (${list}). Choose one with --block` : `${file} has no block "${block}". Its blocks: ${list}`,
  };
}

async function run(file: string | undefined, o: { block?: string; vault?: string; cache?: string; refresh: boolean; json: boolean }, io: Io): Promise<number> {
  if (!file) {
    io.err('run: name a note, or - to read a block from standard input');
    return 2;
  }
  let text: string;
  try {
    text = await readInput(file, io);
  } catch (e) {
    io.err(`run: can't read ${file}: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  const picked = pickBlock(text, file, o.block);
  if ('error' in picked) {
    io.err(picked.error);
    return 2;
  }
  const b = picked.block;
  const problems = problemsOf(file, text, b);
  if (problems.some((p) => p.severity === 'error')) {
    for (const p of problems) io.err(problemLine(p));
    return 1;
  }
  const noteDir = file === '-' ? io.cwd : dirname(resolve(io.cwd, file));
  const deps = nodeDeps({
    vault: o.vault ? resolve(io.cwd, o.vault) : (vaultAbove(noteDir) ?? noteDir),
    cacheDir: o.cache ? resolve(io.cwd, o.cache) : defaultCacheDir(io.env),
    env: io.env,
    fetch: io.fetch,
  });
  const runner = new Runner(deps, defaultsFrom(DEFAULT_SETTINGS));
  try {
    const out = await runner.run(runner.parse(b.source).spec!, o.refresh);
    io.out(o.json ? JSON.stringify(runSummary(out), null, 2) : runText(out));
    return 0;
  } catch (e) {
    io.err(`run: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}

/** A word's entry, found the way it is written, in any case; for a setting's value, "rebalance=monthly". */
export function findDoc(word: string): Doc | undefined {
  const w = word.trim().replace(/\s+/g, ' ');
  return docFor(w) ?? ALL_DOCS.find((d) => d.id.toLowerCase() === w.toLowerCase() || d.id.toLowerCase().replace(/[()]/g, '') === w.toLowerCase());
}

function explain(word: string | undefined, io: Io): number {
  if (!word) {
    io.err('explain: name a word, such as sma or stop loss');
    return 2;
  }
  const d = findDoc(word);
  if (!d) {
    const near = ALL_DOCS.filter((x) => x.id.toLowerCase().includes(word.toLowerCase())).map((x) => x.id);
    io.err(`"${word}" is not a word of the language.${near.length ? ` Did you mean: ${near.slice(0, 8).join(', ')}?` : ' See: backtest-blocks words'}`);
    return 1;
  }
  io.out([d.signature, '', d.text, ...(d.example ? ['', 'Example:', d.example] : [])].join('\n'));
  return 0;
}

function words(json: boolean, io: Io): number {
  if (json) {
    io.out(languageJson().trimEnd());
    return 0;
  }
  const list = JSON.parse(languageJson());
  const names = (key: string) => list[key].map((w: { name: string }) => w.name).join(', ');
  io.out(
    [
      `Functions: ${names('functions')}`,
      `Series: ${names('series')}`,
      `Calendar: ${names('calendar')}`,
      `Position: ${names('position')}`,
      `Settings: ${names('settings')}`,
      `Words: ${names('words')}`,
      `Units: ${names('units')}`,
      '',
      'For one of them: backtest-blocks explain <word>',
    ].join('\n'),
  );
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
