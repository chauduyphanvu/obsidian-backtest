import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseCompare } from '../src/compare.ts';
import { parseDashboard } from '../src/dashboard.ts';
import { CALENDAR, INDICATORS, POSITION, SERIES, SETTINGS, parseSpec } from '../src/dsl.ts';
import { resultProperties } from '../src/export.ts';
import { notOurNoteMessage, ORDERS_MARKER } from '../src/orders.ts';
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

test('the README lists the source files by name', () => {
  const start = readme.indexOf('Layout of `src/`');
  assert.ok(start >= 0, 'no source layout in the README');
  const layout = readme.slice(start, readme.indexOf('\n## ', start));
  for (const file of ['sweep.ts', 'luck.ts', 'rng.ts', 'render-sweep.ts', 'render-luck.ts', 'render-compare.ts']) assert.ok(layout.includes(`\`${file}\``), file);
  const files = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 40, `only ${files.length} files found in src/`);
  assert.deepEqual(files.filter((f) => !layout.includes(`\`${f}\``)), [], 'files in src/ that the layout does not name');
});

test('the README names every setting the settings tab shows', () => {
  const tab = read('src/settings.ts');
  const names = [...tab.matchAll(/\.setName\('([^']+)'\)(?!\s*\.setHeading)/g), ...tab.matchAll(/this\.field\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 15, `only ${names.length} settings found`);
  assert.deepEqual(names.filter((n) => !readme.includes(n)), [], 'settings the README does not name');
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
