import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runAblation } from '../ablation.ts';
import { extractBlocks, fencedBlocks } from '../blocks.ts';
import { hasDagRefs, resolveStrategyDag, type VaultReader } from '../dag.ts';
import { ALL_DOCS, docFor, type Doc } from '../docs.ts';
import { parseSpec, type Diagnostic } from '../dsl.ts';
import { applyFix, suggestions, type Fix } from '../fixes.ts';
import { languageJson, llmsFull, wordList } from '../llm-files.ts';
import type { DataDeps } from '../data.ts';
import { replaceBlockInNote } from '../rewrite.ts';
import { Runner, type RunOutput } from '../runner.ts';
import { HOUR } from '../format.ts';
import { DEFAULT_SETTINGS, defaultsFrom, normalizeSettings, type Settings } from '../settings-core.ts';
import { runStress } from '../stress.ts';
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
  backtest-blocks check <file|->... [--fix]
                                          examine all strategy blocks in notes, or one block without a fence (exit code 1 for errors),
                                          with the correction under each problem that has one
  backtest-blocks run <file|-> [--block <name|n>] [--vault <dir>] [--cache <dir>] [--refresh]
                                          backtest one block on live prices and print the result
  backtest-blocks explain <word>          show the help text for a function, setting, value, word or phrase (for 3 bars)
  backtest-blocks words                   list all words of the language
  backtest-blocks guide                   print the instructions to write blocks (llms-full.txt)
  backtest-blocks mcp                     start an MCP server on stdio with the check, run and explain tools
  backtest-blocks --version | --help

Options:
  --json     print JSON, not text (check, run, words); with check, each problem has its corrections in "fixes"
  --fix      write into the note each correction that is the only one for its problem, examine the note again,
             and print what changed and the problems that remain (check)
  --block    the block of the note to run: its name, or its number (the first block is 1)
  --vault    the vault folder, for the CSV files that a block reads and the plugin settings (default: the folder above the note that contains .obsidian)
  --cache    the folder for saved prices (default: $XDG_CACHE_HOME/backtest-blocks or ~/.cache/backtest-blocks)
  --refresh  download the prices again, and do not use the saved prices

run uses the plugin settings that the vault keeps in .obsidian/plugins/backtest-blocks/data.json, so it gives the result that
Obsidian gives. A vault without that file uses the default settings.

The keys for Tiingo and FRED are in TIINGO_API_KEY and FRED_API_KEY.`;

export function version(): string {
  if (typeof BACKTEST_BLOCKS_VERSION === 'string') return BACKTEST_BLOCKS_VERSION;
  return (JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8')) as { version: string }).version;
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

/**
 * A correction of a problem, placed in the note: the line as a problem counts it, and the text from column `from` up to
 * column `to` (counted as a problem's column, from 1) replaced by `insert`. A correction that reaches into the lines after
 * its first, such as one that removes blank lines, ends on `endLine`, and `to` is a column of that line. In a callout or
 * quote, the columns of each line count that line's own markers.
 */
export interface ProblemFix {
  label: string;
  line: number;
  from: number;
  endLine?: number;
  to: number;
  insert: string;
}

export interface Problem {
  file: string;
  block: string | null;
  line: number;
  column: number | null;
  severity: 'error' | 'warning';
  message: string;
  /** What to write instead, as the editor offers it: "Did you mean sma, the simple average of the last n closes?". */
  suggestion?: string;
  /** Each correction that removes the problem; none, one, or two or three equally good ones. */
  fixes: ProblemFix[];
}

/** A block's problems, each with its corrections both in the block's own lines (to make them) and placed in the note. */
function diagnose(file: string, text: string, b: FoundBlock): { problem: Problem; fixes: Fix[] }[] {
  const fileLines = text.split(/\r?\n/);
  const blockLines = b.source.split('\n');
  const { errors, warnings } = parseSpec(b.source);
  // A block in a callout or quote has its markers before the text the parser read.
  const shift = (line: number): number => {
    const fileLine = fileLines[b.start + line - 1] ?? '';
    const own = blockLines[line - 1] ?? '';
    return fileLine.endsWith(own) ? fileLine.length - own.length : 0;
  };
  // A fix's `to` past the end of its line reaches into the lines after it, one column for each line break.
  const placeFix = (f: Fix): ProblemFix => {
    let end = f.line;
    let to = f.to;
    while (end < blockLines.length && to > blockLines[end - 1].length) {
      to -= blockLines[end - 1].length + 1;
      end++;
    }
    const at = { label: f.label, line: b.start + f.line, from: shift(f.line) + f.from + 1 };
    const rest = { to: shift(end) + to + 1, insert: f.insert };
    return end === f.line ? { ...at, ...rest } : { ...at, endLine: b.start + end, ...rest };
  };
  const place = (d: Diagnostic, severity: Problem['severity']) => {
    const offered = suggestions(blockLines, d);
    const fixes = offered?.fixes ?? [];
    const problem: Problem = {
      file,
      block: b.name,
      line: b.start + d.line,
      column: d.from === undefined ? null : shift(d.line) + d.from + 1,
      severity,
      message: d.message,
      ...(offered?.text ? { suggestion: offered.text } : {}),
      fixes: fixes.map(placeFix),
    };
    return { problem, fixes };
  };
  return [...errors.map((d) => place(d, 'error')), ...warnings.map((d) => place(d, 'warning'))].sort((x, y) => x.problem.line - y.problem.line);
}

const problemsOf = (file: string, text: string, b: FoundBlock): Problem[] => diagnose(file, text, b).map((x) => x.problem);

/** Every problem in the strategy blocks of a note, or of a bare block, with lines counted in the note. */
export function checkSource(text: string, file: string): { blocks: number; problems: Problem[] } {
  const found = blocksIn(text, isNote(file));
  return { blocks: found.length, problems: found.flatMap((b) => problemsOf(file, text, b)) };
}

/** A correction that was made: where its problem was when it was made, the problem, and what the correction did. */
export interface Fixed {
  file: string;
  block: string | null;
  line: number;
  column: number | null;
  message: string;
  label: string;
}

/** Rounds of corrections at most: each can show a problem that the one before it hid. */
const FIX_ROUNDS = 20;

/**
 * The text with each correction made that is the only one for its problem; a problem with two or more equally good
 * corrections is left as it is. After each round the blocks are checked again, until nothing more can be corrected.
 */
export function correctSource(text: string, file: string): { text: string; fixed: Fixed[] } {
  const fixed: Fixed[] = [];
  for (let round = 0; round < FIX_ROUNDS; round++) {
    let changed = false;
    // From the last block up, so a change leaves the lines of the blocks above it where they are.
    for (const b of blocksIn(text, isNote(file)).reverse()) {
      const one = diagnose(file, text, b).find((x) => x.fixes.length === 1);
      if (!one) continue;
      const source = applyFix(b.source.split('\n'), one.fixes[0]).join('\n');
      // A bare block is the whole text, but for the blank lines after it.
      const next = b.start === 0 ? source + text.slice(b.source.length) : replaceBlockInNote(text, b.start - 1, b.source, source);
      if (next === null) continue;
      const { file: f, block, line, column, message } = one.problem;
      fixed.push({ file: f, block, line, column, message, label: one.fixes[0].label });
      text = next;
      changed = true;
    }
    if (!changed) break;
  }
  return { text, fixed: fixed.sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0)) };
}

/** A problem as one line: "note.md:12:5: error: message", with the suggestion under it when there is one. */
export const problemLine = (p: Problem): string => `${p.file}:${p.line}${p.column === null ? '' : `:${p.column}`}: ${p.severity}: ${p.message}${p.suggestion ? `\n  ${p.suggestion}` : ''}`;

/** A correction that was made, as one line: "note.md:12:18: fixed: Change to sma". */
export const fixedLine = (f: Fixed): string => `${f.file}:${f.line}${f.column === null ? '' : `:${f.column}`}: fixed: ${f.label}`;

async function readInput(path: string, io: Io): Promise<string> {
  return path === '-' ? io.stdin() : readFile(resolve(io.cwd, path), 'utf8');
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function check(files: string[], o: { json: boolean; fix: boolean }, io: Io): Promise<number> {
  if (files.length === 0) {
    io.err('check: give a note, or - to read a block from standard input');
    return 2;
  }
  if (o.fix && files.includes('-')) {
    io.err('check --fix writes the corrections into the note file. Thus it cannot read a block from standard input. Give a note.');
    return 2;
  }
  const problems: Problem[] = [];
  const fixed: Fixed[] = [];
  let blocks = 0;
  let empty = 0;
  let unread = 0;
  let unwritten = 0;
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
    const corrected = o.fix ? correctSource(text, file) : null;
    if (corrected?.fixed.length) {
      try {
        await writeFile(resolve(io.cwd, file), corrected.text, 'utf8');
        fixed.push(...corrected.fixed);
        text = corrected.text;
      } catch (e) {
        // The note is as it was, and its problems are those of its text.
        io.err(`check: cannot write ${file}: ${e instanceof Error ? e.message : e}`);
        unwritten++;
      }
    }
    const foundBlocks = blocksIn(text, isNote(file));
    const hasSharedBlocks =
      isNote(file) &&
      (['signal', 'regime', 'universe'] as const).some((lang) => fencedBlocks(text, lang).length > 0);
    if (foundBlocks.length === 0 && !hasSharedBlocks) {
      io.err(`${file}: ${noBlock(file)}`);
      empty++;
      continue;
    }
    blocks += foundBlocks.length;
    const noteDir = file === '-' ? io.cwd : dirname(resolve(io.cwd, file));
    const vault = vaultAbove(noteDir) ?? noteDir;
    for (const b of foundBlocks) {
      if (file !== '-' && hasDagRefs(b.source)) {
        const relNote = isNote(file) ? relative(vault, resolve(io.cwd, file)).replace(/\\/g, '/') : file;
        const dag = await resolveStrategyDag(b.source, relNote, fsVaultReader(vault));
        if (dag.errors.length > 0) {
          for (const d of dag.errors) {
            problems.push({ file, block: b.name, line: b.start + d.line, column: null, severity: 'error', message: d.message, fixes: [] });
          }
          continue;
        }
        const { errors: mergedErrs, warnings: mergedWarns } = parseSpec(dag.mergedSource);
        for (const d of mergedErrs) problems.push({ file, block: b.name, line: b.start + d.line, column: null, severity: 'error', message: d.message, fixes: [] });
        for (const d of mergedWarns) problems.push({ file, block: b.name, line: b.start + d.line, column: null, severity: 'warning', message: d.message, fixes: [] });
      } else {
        problems.push(...problemsOf(file, text, b));
      }
    }
  }
  const errors = problems.filter((p) => p.severity === 'error').length;
  if (o.json) {
    const corrections = o.fix ? { fixed, notesNotWritten: unwritten } : {};
    io.out(JSON.stringify({ blocks, errors, warnings: problems.length - errors, notesWithoutBlock: empty, notesUnread: unread, ...corrections, problems }, null, 2));
  } else {
    for (const f of fixed) io.out(fixedLine(f));
    for (const p of problems) io.out(problemLine(p));
    const said = [
      ...(problems.length ? [`${plural(errors, 'error', 'errors')}, ${plural(problems.length - errors, 'warning', 'warnings')}`] : []),
      ...(empty ? [`${plural(empty, 'note', 'notes')} with no strategy block`] : []),
      ...(unread ? [`${plural(unread, 'note', 'notes')} not read`] : []),
      ...(unwritten ? [`${plural(unwritten, 'note', 'notes')} not written`] : []),
    ];
    const written = o.fix ? `${plural(fixed.length, 'correction', 'corrections')} written; ` : '';
    io.err(`${plural(blocks, 'block', 'blocks')} examined: ${written}${said.join('; ') || 'no problems'}`);
  }
  return unread > 0 || unwritten > 0 ? 2 : errors > 0 || empty > 0 ? 1 : 0;
}

/** The folder above `from` that holds .obsidian, which makes it a vault; null when there is none. */
function vaultAbove(from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.obsidian'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** Where a vault keeps the plugin's settings. */
const SETTINGS_FILE = join('.obsidian', 'plugins', 'backtest-blocks', 'data.json');

/**
 * The plugin's settings as the vault at `vault` keeps them, read as the plugin reads them, so a run gives the result that
 * Obsidian gives; null when the vault has no settings file. Rejects when the file is there but can't be read.
 */
export async function vaultSettings(vault: string): Promise<{ settings: Settings; path: string } | null> {
  const path = join(vault, SETTINGS_FILE);
  if (!existsSync(path)) return null;
  return { settings: normalizeSettings(JSON.parse(await readFile(path, 'utf8'))), path };
}

/** The settings a run in the vault at `vault` uses: the vault's own, else the default settings. */
export async function settingsIn(vault: string): Promise<Settings> {
  return (await vaultSettings(vault))?.settings ?? DEFAULT_SETTINGS;
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

/** Lightweight filesystem VaultReader for resolving `extends:` and `[[Signal]]` links in CLI/MCP outside Obsidian. */
function fsVaultReader(vaultRoot: string): VaultReader {
  let index: Map<string, string> | null = null;
  const build = (): Map<string, string> => {
    const map = new Map<string, string>();
    const walkDir = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walkDir(full);
        else if (/\.md$/i.test(e.name)) {
          const rel = relative(vaultRoot, full).replace(/\\/g, '/');
          const noExt = rel.replace(/\.md$/i, '');
          const base = noExt.split('/').pop()!;
          map.set(rel.toLowerCase(), rel);
          map.set(noExt.toLowerCase(), rel);
          if (!map.has(base.toLowerCase())) map.set(base.toLowerCase(), rel);
        }
      }
    };
    walkDir(vaultRoot);
    return map;
  };
  return {
    resolve(link) {
      index ??= build();
      const key = link.replace(/\.md$/i, '').replace(/\\/g, '/').toLowerCase();
      return index.get(key) ?? index.get(`${key}.md`) ?? null;
    },
    async read(path) {
      try {
        return await readFile(join(vaultRoot, path), 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/** Runs one block of a note, or a bare block, with the plugin settings `settings`. Shared by `run` and the MCP tool. */
export async function runNote(
  text: string,
  file: string,
  block: string | undefined,
  deps: DataDeps,
  refresh: boolean,
  settings: Settings,
  how = '--block',
  vaultRoot?: string,
): Promise<{ out: RunOutput; source: string } | NotRun> {
  const picked = pickBlock(text, file, block, how);
  if ('error' in picked) return { code: 2, message: picked.error };
  let source = picked.block.source;
  if (hasDagRefs(source) && vaultRoot) {
    const relNote = file === '-' || !isNote(file) ? file : relative(vaultRoot, resolve(file)).replace(/\\/g, '/');
    const dag = await resolveStrategyDag(source, relNote, fsVaultReader(vaultRoot));
    if (dag.errors.length > 0) return { code: 1, message: dag.errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n') };
    source = dag.mergedSource;
  } else {
    const errors = problemsOf(file, text, picked.block).filter((p) => p.severity === 'error');
    if (errors.length > 0) return { code: 1, message: `The block has errors. It did not run:\n${errors.map(problemLine).join('\n')}` };
  }
  const runner = new Runner(deps, defaultsFrom(settings), { freshForMs: settings.cacheHours * HOUR });
  const parsed = runner.parse(source);
  if (!parsed.spec) return { code: 1, message: parsed.errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n') };
  try {
    return { out: await runner.run(parsed.spec, refresh), source };
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
  const vault = o.vault ? resolve(io.cwd, o.vault) : (vaultAbove(noteDir) ?? noteDir);
  let saved: Awaited<ReturnType<typeof vaultSettings>>;
  try {
    saved = await vaultSettings(vault);
  } catch (e) {
    io.err(`run: cannot read the plugin settings in ${join(vault, SETTINGS_FILE)}: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  if (saved) io.err(`run: uses the plugin settings in ${saved.path}`);
  const deps = nodeDeps({
    vault,
    cacheDir: o.cache ? resolve(io.cwd, o.cache) : defaultCacheDir(io.env),
    env: io.env,
    fetch: io.fetch,
  });
  const result = await runNote(text, file, o.block, deps, o.refresh, saved?.settings ?? DEFAULT_SETTINGS, '--block', vault);
  if ('code' in result) {
    io.err(result.message);
    return result.code;
  }
  if (o.json) {
    const defaults = defaultsFrom(saved?.settings ?? DEFAULT_SETTINGS);
    const stress = runStress(result.source, result.out.spec, result.out.data, result.out.backtest, defaults);
    const ablation = runAblation(result.out.spec, result.out.data, result.out.backtest, result.source);
    io.out(
      JSON.stringify(
        {
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
        null,
        2,
      ),
    );
  } else {
    io.out(runText(result.out));
  }
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

/**
 * The word a phrase is about: a window with its number (`for 3 bars`, `within 5 bars`), and the names other tools give a
 * cross, with a note that the language calls it `crosses`. Null for any other text.
 */
function phrase(word: string): { id: string; note?: string } | null {
  const w = word.trim().replace(/\s+/g, ' ').toLowerCase();
  if (/^for \S+ bars?$/.test(w)) return { id: 'for … bars' };
  if (/^within \S+ bars?$/.test(w)) return { id: 'within' };
  if (/^(crossover|cross over|crosses over)$/.test(w)) return { id: 'crosses', note: `"${word.trim()}" is not a word of the language. The language uses crosses, crosses above and crosses below. This is the help for crosses.` };
  return null;
}

/** A word's form, meaning and example as text, or what to say when it is not a word of the language. */
export function explainText(word: string): { text: string } | { error: string } {
  const said = phrase(word);
  const d = said ? docFor(said.id) : findDoc(word);
  if (d) return { text: [...(said?.note ? [said.note, ''] : []), d.signature, '', d.text, ...(d.example ? ['', 'Example:', d.example] : [])].join('\n') };
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
        fix: { type: 'boolean', default: false },
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
      return check(rest, { json: o.json, fix: o.fix }, io);
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
