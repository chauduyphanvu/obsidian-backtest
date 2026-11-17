import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseCompare } from '../src/compare.ts';
import { parseDashboard } from '../src/dashboard.ts';
import { INSIDE_BARS } from '../src/data.ts';
import { CALENDAR, INDICATORS, POSITION, SERIES, SETTINGS, YAHOO_INSIDE_DAYS, parseSpec } from '../src/dsl.ts';
import { SMALL_TRADE } from '../src/engine.ts';
import { resultProperties } from '../src/export.ts';
import { STARTERS } from '../src/gallery.ts';
import { LIMITS, LimitError, anywayLabel, sizeRefusal } from '../src/limits.ts';
import { notOurNoteMessage, ORDERS_MARKER } from '../src/orders.ts';
import { valuesUsed } from '../src/render-luck.ts';
import { WAITING, WRITTEN } from '../src/render-sweep.ts';
import { NOTE_CHANGED } from '../src/rewrite.ts';
import { bars } from './helpers.ts';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const json = (path: string) => JSON.parse(read(path)) as Record<string, string>;

const readme = read('README.md');

/** The fenced code blocks of a Markdown file with the first word after the fence as their language. */
function fences(markdown: string): { lang: string; body: string; line: number }[] {
  const out: { lang: string; body: string; line: number }[] = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^ {0,3}(`{3,}|~{3,})\s*(\S*)/);
    if (!open) continue;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^ {0,3}\\${open[1][0]}{${open[1].length},}\\s*$`).test(lines[j])) body.push(lines[j++]);
    assert.ok(j < lines.length, `the fence on README line ${i + 1} is never closed`);
    out.push({ lang: open[2].toLowerCase(), body: body.join('\n'), line: i + 1 });
    i = j;
  }
  return out;
}

const blocks = fences(readme);
const first = (body: string) => body.split('\n').find((l) => l.trim()) ?? '';

/** The text of a `## ` section, without its heading line, up to the next `## `. */
function section(title: string): string {
  const start = readme.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `no section "${title}" in the README`);
  const body = start + title.length + 5;
  const end = readme.indexOf('\n## ', body);
  return readme.slice(body, end < 0 ? undefined : end);
}

/** The first cell of each row of the Markdown tables in `text`, without the header and divider rows. */
function firstCells(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| ---'))
    .slice(1)
    .map((l) => l.split(' | ')[0].slice(2).trim());
}

test('every strategy block in the README parses without errors', () => {
  const found = blocks.filter((b) => b.lang === 'strategy');
  assert.ok(found.length >= 10, `only ${found.length} strategy blocks found`);
  for (const b of found) {
    const { errors } = parseSpec(b.body);
    assert.deepEqual(errors, [], `the strategy block on README line ${b.line} ("${first(b.body)}") has errors`);
  }
});

test('every compare block in the README parses without errors', () => {
  const found = blocks.filter((b) => b.lang === 'compare');
  assert.ok(found.length >= 1, 'no compare block found');
  for (const b of found) {
    const { errors } = parseCompare(b.body);
    assert.deepEqual(errors, [], `the compare block on README line ${b.line} ("${first(b.body)}") has errors`);
  }
});

test('every backtests block in the README parses without errors', () => {
  const found = blocks.filter((b) => b.lang === 'backtests');
  assert.ok(found.length >= 1, 'no backtests block found');
  for (const b of found) {
    const { errors } = parseDashboard(b.body);
    assert.deepEqual(errors, [], `the backtests block on README line ${b.line} ("${first(b.body)}") has errors`);
  }
});

test('the README mentions every setting, function, series, calendar value and position value', () => {
  const missing: string[] = [];
  for (const name of [...SETTINGS, ...Object.keys(INDICATORS), ...SERIES, ...CALENDAR]) {
    if (!readme.includes(`\`${name}\``)) missing.push(name);
  }
  for (const [name, words] of Object.entries(POSITION)) {
    if (!readme.includes(words) && !readme.includes(name)) missing.push(name);
  }
  assert.deepEqual(missing, [], 'names the README does not mention in backticks');
});

test('the README has a row in its tables for every setting of the language and every function', () => {
  const rows = new Set([...readme.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]));
  assert.deepEqual([...SETTINGS, ...Object.keys(INDICATORS)].filter((n) => !rows.has(n)), [], 'settings or functions with no table row');
});

test('the README mentions every command the plugin registers', () => {
  const main = read('src/main.ts');
  const names = [...main.matchAll(/addCommand\(\{[^]*?\bname:\s*(["'`])((?:(?!\1).)*)\1/g)].map((m) => m[2]);
  assert.equal(names.length, main.match(/addCommand\(/g)!.length, 'a command name was not found');
  assert.deepEqual(names.filter((n) => !readme.includes(n)), []);
});

test('the README names every property a result writes', () => {
  const spec = parseSpec('universe: A\nbuy when true').spec!;
  const data = new Map([['A', bars([10, 11, 12, 11, 13, 14])]]);
  const keys = Object.keys(resultProperties(runBacktest(spec, data), Date.UTC(2026, 0, 1)));
  assert.ok(keys.length > 0);
  assert.deepEqual(keys.filter((k) => !readme.includes(`\`${k}\``)), []);
});

test('the README says what the orders note carries, what refuses a save, and who owns the bt_ properties', () => {
  assert.ok(readme.includes(`\`${ORDERS_MARKER}: true\``));
  assert.ok(readme.includes(notOurNoteMessage('<path>')));
  assert.match(readme, /The plugin owns every property that starts with `bt_`/);
});

test('the README quotes the messages about writing values, sliders and luck checks as the plugin words them', () => {
  assert.ok(readme.includes(`"${WRITTEN}"`));
  assert.ok(readme.includes(`"Couldn't write the values to the block. ${NOTE_CHANGED}"`));
  assert.ok(read('src/render-params.ts').includes("`Couldn't write the values to the block. ${sentence(e)}`"));
  assert.ok(readme.includes('"Loading more price history…"') && read('src/render-params.ts').includes("'Loading more price history…'"));
  const block = 'universe: SPY\nfast = 10 in 5..25 step 5\nbuy when sma(fast) > sma(50)';
  const used = valuesUsed(parseSpec(block, { overrides: { fast: 25 } }).spec!.params);
  assert.ok(used !== null && readme.includes(`"${used}"`));
  assert.ok(readme.includes('"Values shown"') && readme.includes('"Values in the note"'));
  assert.ok(read('src/render-luck.ts').includes("'Values shown'") && read('src/render-luck.ts').includes("'Values in the note'"));
});

test('the README keeps its engine rules numbered one after another, and every "rule N" points at one', () => {
  const start = readme.indexOf('## How the simulation works');
  const section = readme.slice(start, readme.indexOf('\n## ', start + 1));
  const numbers = [...section.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1));
  for (const m of readme.matchAll(/\brules? (\d+)\b/g)) assert.ok(Number(m[1]) <= numbers.length, `"${m[0]}" points past the last rule`);
});

test('the README lists the source files by name', () => {
  const start = readme.indexOf('Layout of `src/`');
  assert.ok(start >= 0, 'no source layout in the README');
  const layout = readme.slice(start, readme.indexOf('\n## ', start));
  for (const file of ['sweep.ts', 'luck.ts', 'rng.ts', 'render-sweep.ts', 'render-luck.ts', 'render-compare.ts']) assert.ok(layout.includes(`\`${file}\``), file);
  const files = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 40, `only ${files.length} files found in src/`);
  assert.deepEqual(files.filter((f) => !layout.includes(`\`${f}\``)), [], 'files in src/ that the layout does not name');
});

test('the README layout names no source file that is not there', () => {
  const start = readme.indexOf('Layout of `src/`');
  const layout = readme.slice(start, readme.indexOf('\n## ', start));
  const files = new Set(readdirSync(new URL('../src/', import.meta.url)));
  const named = [...layout.matchAll(/`([\w-]+\.ts)`/g)].map((m) => m[1]);
  assert.deepEqual(named.filter((f) => !files.has(f)), []);
});

/** The names of the settings the settings tab shows, in the plugin's own words. */
function tabSettings(): string[] {
  const tab = read('src/settings.ts');
  const named = [...tab.matchAll(/\.setName\('([^']+)'\)([^;]*);/g)].filter((m) => !m[2].includes('.setHeading()'));
  return [...named, ...tab.matchAll(/this\.field\(\s*'([^']+)'/g)].map((m) => m[1]);
}

test('the README names every setting the settings tab shows', () => {
  const names = tabSettings();
  assert.ok(names.length >= 15, `only ${names.length} settings found`);
  assert.deepEqual(names.filter((n) => !readme.includes(n)), [], 'settings the README does not name');
});

test('the settings table lists exactly the settings the settings tab shows', () => {
  const names = tabSettings();
  assert.ok(names.includes('Commission per order'), 'the commission setting is not in the settings tab');
  const rows = firstCells(section('Settings'));
  assert.deepEqual(names.filter((n) => !rows.includes(n)), [], 'settings with no row in the README table');
  assert.deepEqual(rows.filter((n) => !names.includes(n)), [], 'rows in the README table for settings the tab does not show');
});

test('the README says how many starter strategies there are and lists each one', () => {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const said = readme.match(/It lists (\w+) strategies and an "Empty block"/);
  assert.ok(said, 'the README does not say how many starter strategies the window lists');
  assert.equal(words.indexOf(said[1]), STARTERS.length, `the README says ${said[1]}; src/gallery.ts has ${STARTERS.length}`);
  const rows = firstCells(readme.slice(readme.indexOf('### Starter strategies'), readme.indexOf('\n## ', readme.indexOf('### Starter strategies'))));
  assert.deepEqual(rows, STARTERS.map((s) => s.title), 'the starter table lists the starters in the order of src/gallery.ts');
});

test('the README says what the parser says for the example with the three mistakes', () => {
  const [source, said] = blocks.filter((b) => b.lang === 'text');
  assert.ok(source && said, 'the two text blocks of "When something is wrong" are missing');
  const messages = parseSpec(source.body).errors.map((e) => `Line ${e.line}: ${e.message}`);
  assert.deepEqual(said.body.split('\n'), messages);
});

test('the README quotes the limit messages, buttons and numbers as the plugin words them', () => {
  const refusal = sizeRefusal({ bars: 2_100_000, tickers: 40, ruleWork: 0, windowWork: 0 }, 'worker');
  assert.ok(refusal !== null && refusal.startsWith('This run has 2.1 million bars across 40 tickers; the limit is 1 million.'));
  assert.ok(readme.includes('"This run has 2.1 million bars across 40 tickers; the limit is 1 million."'));
  const draw = read('src/render.ts');
  for (const title of ['This backtest is too large to run', 'This backtest took too long']) assert.ok(readme.includes(`"${title}"`) && draw.includes(`'${title}'`), title);
  for (const label of [anywayLabel(new LimitError('size', '', true)), anywayLabel(new LimitError('time', '', true))]) assert.ok(readme.includes(`"${label}"`), label);
  assert.ok(read('src/limits.ts').includes("'Backtests run in the foreground here, so") && readme.includes('"Backtests run in the foreground here"'));
  const release = read('src/render-params.ts').match(/const ON_RELEASE = '([^']+)'/)?.[1];
  assert.ok(release && readme.includes(`"${release}"`));
  assert.ok(readme.includes(`"${WAITING}"`));
  const plain = (t: string) => t.replaceAll(',', '');
  for (const need of [
    `more than ${LIMITS.worker.bars} bars`,
    `more than ${LIMITS.worker.ruleWork / 1e6} million rule values`,
    `after ${LIMITS.runMs / 1000} seconds`,
    `${LIMITS.here.bars} bars ${LIMITS.here.ruleWork / 1e6} million rule values and ${LIMITS.here.windowWork / 1e6} million prices`,
    `takes more than ${LIMITS.dragMs} ms`,
    `the latest ${LIMITS.keptResults} and no more than about ${LIMITS.keptBytes / 1e6} MB`,
  ]) assert.ok(plain(readme).includes(need), `the README does not say "${need}"`);
  assert.ok(readme.includes(`up to ${LIMITS.anywayMs / 60_000} minutes`) && readme.includes(`goes ${LIMITS.stepMs / 60_000} minutes without finishing`));
});

test('the README names the controls of the bar-by-bar table as the plugin words them', () => {
  const debug = read('src/render-debug.ts');
  const labels = ['Rule values, bar by bar', '← Earlier', 'Later →', 'Go to date', '← Previous trade', 'Next trade →', 'Only bars where something happened or nearly happened', 'Save as CSV', 'Position', 'What happened'];
  for (const label of labels) assert.ok(debug.includes(`'${label}'`) && readme.includes(`"${label}"`), label);
});

test('the README gives the numbers of magnify, commission and the cross-check as the code has them', () => {
  assert.ok(readme.includes(`for the last ${YAHOO_INSIDE_DAYS['2m']} days (${YAHOO_INSIDE_DAYS['1h']} for 1h)`));
  assert.ok(readme.includes(`at most ${INSIDE_BARS.toLocaleString('en-US')} for a ticker`));
  assert.ok(readme.includes(`its commission would be ${SMALL_TRADE * 100}% of its value or more`));
  const cases = readdirSync(new URL('../xcheck/cases/', import.meta.url)).length;
  const expressions = [...read('xcheck/run.ts').match(/const INDICATORS[^]*?\n\];/)![0].matchAll(/^ {2}\[/gm)].length;
  assert.ok(readme.includes(`runs ${cases} strategy pairs and ${expressions} indicator expressions`), `the cross-check has ${cases} cases and ${expressions} expressions`);
  assert.ok(readme.includes(`The cross-check runs ${cases} cases and ${expressions} indicator expressions`));
});

test('the README holds no path from anyone\'s own machine', () => {
  assert.doesNotMatch(readme, /\/Users\/|\/home\/[a-z]|[A-Z]:\\Users/);
});

test('the README has no images and no promises of later features', () => {
  assert.ok(!/!\[[^\]]*\]\(/.test(readme) && !/<img\b/i.test(readme), 'an image is linked');
  assert.ok(!/coming soon|\bTODO\b/i.test(readme));
});

test('the version files agree with the manifest', () => {
  const manifest = json('manifest.json');
  assert.equal(json('package.json').version, manifest.version);
  const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version: string }> };
  assert.equal(lock.version, manifest.version, 'the version at the top of package-lock.json');
  assert.equal(lock.packages[''].version, manifest.version, 'the root package in package-lock.json');
  // versions.json keeps one line per release, so only the current one is checked here.
  assert.equal(json('versions.json')[manifest.version], manifest.minAppVersion);
});

test('the licence is MIT, 2026, held by the manifest author, and the description follows the guidance', () => {
  const manifest = json('manifest.json');
  const licence = read('LICENSE');
  assert.match(licence, /^MIT License\n/);
  assert.ok(licence.includes(`Copyright (c) 2026 ${manifest.author}\n`));
  const d = manifest.description;
  assert.ok(d.length < 250 && d.endsWith('.') && !/obsidian|plugin/i.test(d), d);
});
