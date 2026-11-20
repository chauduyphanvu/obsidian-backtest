import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseAccount } from '../src/account.ts';
import { runBacktest } from '../src/backtest.ts';
import { parseCompare } from '../src/compare.ts';
import { parseDashboard } from '../src/dashboard.ts';
import { INSIDE_BARS } from '../src/data.ts';
import { CSV_ASK_BYTES, CSV_MAX_BYTES } from '../src/debug.ts';
import { CALENDAR, INDICATORS, POSITION, SERIES, SETTINGS, YAHOO_INSIDE_DAYS, parseSpec } from '../src/dsl.ts';
import { SMALL_TRADE } from '../src/engine.ts';
import { resultProperties } from '../src/export.ts';
import { forwardChanged, parseForward } from '../src/forward.ts';
import { STARTERS } from '../src/gallery.ts';
import { LIMITS, LimitError, anywayLabel, sizeRefusal } from '../src/limits.ts';
import { notOurNoteMessage, ORDERS_MARKER } from '../src/orders.ts';
import { MAX_VERSIONS } from '../src/ledger.ts';
import { PBO_MIN_STEPS_PER_GROUP, PBO_MIN_VARIANTS, STRETCHES } from '../src/overfit.ts';
import { ADD_NAME, RESET, UNNAMED, upperBound, valuesUsed } from '../src/render-luck.ts';
import { RESTORE } from '../src/render-versions.ts';
import { WAITING, WRITTEN } from '../src/render-sweep.ts';
import { NOTE_CHANGED } from '../src/rewrite.ts';
import { oldRecordWords, type OldRecord } from '../src/render.ts';
import { bars } from './helpers.ts';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const json = (path: string) => JSON.parse(read(path)) as Record<string, string>;

const readme = read('docs/reference.md');

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
    assert.ok(j < lines.length, `the fence on reference line ${i + 1} is never closed`);
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
  assert.ok(start >= 0, `no section "${title}" in the reference`);
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

test('every strategy block in the reference parses without errors', () => {
  const found = blocks.filter((b) => b.lang === 'strategy');
  assert.ok(found.length >= 10, `only ${found.length} strategy blocks found`);
  for (const b of found) {
    const { errors } = parseSpec(b.body);
    assert.deepEqual(errors, [], `the strategy block on reference line ${b.line} ("${first(b.body)}") has errors`);
  }
});

test('every compare block in the reference parses without errors', () => {
  const found = blocks.filter((b) => b.lang === 'compare');
  assert.ok(found.length >= 1, 'no compare block found');
  for (const b of found) {
    const { errors } = parseCompare(b.body);
    assert.deepEqual(errors, [], `the compare block on reference line ${b.line} ("${first(b.body)}") has errors`);
  }
});

test('every account block in the reference parses without errors', () => {
  const found = blocks.filter((b) => b.lang === 'account');
  assert.ok(found.length >= 1, 'no account block found');
  for (const b of found) {
    const { errors } = parseAccount(b.body);
    assert.deepEqual(errors, [], `the account block on reference line ${b.line} ("${first(b.body)}") has errors`);
  }
});

test('every forward block in the reference parses without errors, its check holds and its strategy runs', () => {
  const found = blocks.filter((b) => b.lang === 'forward');
  assert.ok(found.length >= 1, 'no forward block found');
  for (const b of found) {
    const { forward, errors } = parseForward(b.body);
    assert.deepEqual(errors, [], `the forward block on reference line ${b.line} ("${first(b.body)}") has errors`);
    assert.equal(forwardChanged(forward!), false, `the check of the forward block on reference line ${b.line} does not match its text`);
    assert.deepEqual(parseSpec(forward!.source).errors, [], `the strategy in the forward block on reference line ${b.line} has errors`);
  }
});

test('every backtests block in the reference parses without errors', () => {
  const found = blocks.filter((b) => b.lang === 'backtests');
  assert.ok(found.length >= 1, 'no backtests block found');
  for (const b of found) {
    const { errors } = parseDashboard(b.body);
    assert.deepEqual(errors, [], `the backtests block on reference line ${b.line} ("${first(b.body)}") has errors`);
  }
});

test('the reference mentions every setting, function, series, calendar value and position value', () => {
  const missing: string[] = [];
  for (const name of [...SETTINGS, ...Object.keys(INDICATORS), ...SERIES, ...CALENDAR]) {
    if (!readme.includes(`\`${name}\``)) missing.push(name);
  }
  for (const [name, words] of Object.entries(POSITION)) {
    if (!readme.includes(words) && !readme.includes(name)) missing.push(name);
  }
  assert.deepEqual(missing, [], 'names the reference does not mention in backticks');
});

test('the reference has a row in its tables for every setting of the language and every function', () => {
  const rows = new Set([...readme.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]));
  assert.deepEqual([...SETTINGS, ...Object.keys(INDICATORS)].filter((n) => !rows.has(n)), [], 'settings or functions with no table row');
});

test('the reference mentions every command the plugin registers', () => {
  const main = read('src/main.ts');
  const names = [...main.matchAll(/addCommand\(\{[^]*?\bname:\s*(["'`])((?:(?!\1).)*)\1/g)].map((m) => m[2]);
  assert.equal(names.length, main.match(/addCommand\(/g)!.length, 'a command name was not found');
  assert.deepEqual(names.filter((n) => !readme.includes(n)), []);
});

test('the reference names every property a result writes', () => {
  const spec = parseSpec('universe: A\nbuy when true').spec!;
  const data = new Map([['A', bars([10, 11, 12, 11, 13, 14])]]);
  const keys = Object.keys(resultProperties(runBacktest(spec, data), Date.UTC(2026, 0, 1)));
  assert.ok(keys.length > 0);
  assert.deepEqual(keys.filter((k) => !readme.includes(`\`${k}\``)), []);
});

test('the reference says what the orders note carries, what refuses a save, and who owns the bt_ properties', () => {
  assert.ok(readme.includes(`\`${ORDERS_MARKER}: true\``));
  assert.ok(readme.includes(notOurNoteMessage('<path>')));
  assert.match(readme, /The plugin owns every property that starts with `bt_`/);
});

test('the reference quotes the messages about writing values, sliders and luck checks as the plugin words them', () => {
  assert.ok(readme.includes(`"${WRITTEN}"`));
  assert.ok(readme.includes(`"Cannot write the values to the block. ${NOTE_CHANGED}"`));
  assert.ok(read('src/render-params.ts').includes('`Cannot write the values to the block. ${sentence(e)}`'));
  assert.ok(readme.includes('"More price history loads…"') && read('src/render-params.ts').includes("'More price history loads…'"));
  const block = 'universe: SPY\nfast = 10 in 5..25 step 5\nbuy when sma(fast) > sma(50)';
  const used = valuesUsed(parseSpec(block, { overrides: { fast: 25 } }).spec!.params);
  assert.ok(used !== null && readme.includes(`"${used}"`));
  assert.ok(readme.includes('"Values shown"') && readme.includes('"Values in the note"'));
  assert.ok(read('src/render-luck.ts').includes("'Values shown'") && read('src/render-luck.ts').includes("'Values in the note'"));
});

test('the reference keeps its engine rules numbered one after another, and every "rule N" points at one', () => {
  const start = readme.indexOf('## How the simulation works');
  const section = readme.slice(start, readme.indexOf('\n## ', start + 1));
  const numbers = [...section.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1));
  for (const m of readme.matchAll(/\brules? (\d+)\b/g)) assert.ok(Number(m[1]) <= numbers.length, `"${m[0]}" points past the last rule`);
});

test('the reference lists the source files by name', () => {
  const start = readme.indexOf('Layout of `src/`');
  assert.ok(start >= 0, 'no source layout in the reference');
  const layout = readme.slice(start, readme.indexOf('\n## ', start));
  for (const file of ['sweep.ts', 'luck.ts', 'rng.ts', 'render-sweep.ts', 'render-luck.ts', 'render-compare.ts']) assert.ok(layout.includes(`\`${file}\``), file);
  const files = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 40, `only ${files.length} files found in src/`);
  assert.deepEqual(files.filter((f) => !layout.includes(`\`${f}\``)), [], 'files in src/ that the layout does not name');
});

test('the reference layout names no source file that is not there', () => {
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

test('the reference names every setting the settings tab shows', () => {
  const names = tabSettings();
  assert.ok(names.length >= 15, `only ${names.length} settings found`);
  assert.deepEqual(names.filter((n) => !readme.includes(n)), [], 'settings the reference does not name');
});

test('the settings table lists exactly the settings the settings tab shows', () => {
  const names = tabSettings();
  assert.ok(names.includes('Commission per order'), 'the commission setting is not in the settings tab');
  const rows = firstCells(section('Settings'));
  assert.deepEqual(names.filter((n) => !rows.includes(n)), [], 'settings with no row in the reference table');
  assert.deepEqual(rows.filter((n) => !names.includes(n)), [], 'rows in the reference table for settings the tab does not show');
});

test('the reference says how many starter strategies there are and lists each one', () => {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const said = readme.match(/It lists (\w+) strategies and an "Empty block"/);
  assert.ok(said, 'the reference does not say how many starter strategies the window lists');
  assert.equal(words.indexOf(said[1]), STARTERS.length, `the reference says ${said[1]}; src/gallery.ts has ${STARTERS.length}`);
  const rows = firstCells(readme.slice(readme.indexOf('### Starter strategies'), readme.indexOf('\n## ', readme.indexOf('### Starter strategies'))));
  assert.deepEqual(rows, STARTERS.map((s) => s.title), 'the starter table lists the starters in the order of src/gallery.ts');
});

test('the reference says what the parser says for the example with the three mistakes', () => {
  const [source, said] = blocks.filter((b) => b.lang === 'text');
  assert.ok(source && said, 'the two text blocks of "When something is wrong" are missing');
  const messages = parseSpec(source.body).errors.map((e) => `Line ${e.line}: ${e.message}`);
  assert.deepEqual(said.body.split('\n'), messages);
});

test('the reference quotes the limit messages, buttons and numbers as the plugin words them', () => {
  const refusal = sizeRefusal({ bars: 2_100_000, tickers: 40, ruleWork: 0, windowWork: 0 }, 'worker');
  assert.ok(refusal !== null && refusal.startsWith('This run has 2.1 million bars across 40 tickers. The limit is 1 million.'));
  assert.ok(readme.includes('"This run has 2.1 million bars across 40 tickers. The limit is 1 million."'));
  const draw = read('src/render.ts');
  for (const title of ['This backtest is too large to run', 'This backtest used too much time']) assert.ok(readme.includes(`"${title}"`) && draw.includes(`'${title}'`), title);
  for (const label of [anywayLabel(new LimitError('size', '', true)), anywayLabel(new LimitError('time', '', true))]) assert.ok(readme.includes(`"${label}"`), label);
  assert.ok(read('src/limits.ts').includes("'Backtests run in the foreground here. ") && readme.includes('"Backtests run in the foreground here"'));
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
  ]) assert.ok(plain(readme).includes(need), `the reference does not say "${need}"`);
  assert.ok(readme.includes(`up to ${LIMITS.anywayMs / 60_000} minutes`) && readme.includes(`goes ${LIMITS.stepMs / 60_000} minutes without finishing`));
});

test('the reference names the controls of the bar-by-bar table as the plugin words them', () => {
  const debug = read('src/render-debug.ts');
  const labels = ['Rule values, bar by bar', '← Previous bars', 'Next bars →', 'Go to date', '← Previous trade', 'Next trade →', 'Only bars where something occurred or almost occurred', 'Save as CSV', 'Save all bars', 'Position', 'What occurred'];
  for (const label of labels) assert.ok(debug.includes(`'${label}'`) && readme.includes(`"${label}"`), label);
  assert.ok(readme.includes(`over about ${CSV_ASK_BYTES / 1e6} MB`) && readme.includes(`over about ${CSV_MAX_BYTES / 1e6} MB`));
  assert.ok(debug.includes('` bars ${shown.from + 1} to ${shown.to}`') && readme.includes('`<name> rule values <ticker> bars 121 to 180 <date>`'));
  const columns = readme.match(/\*\*The columns\.\*\*[^\n]*/)![0];
  assert.ok(columns.indexOf('"What occurred" and "Position"') > columns.indexOf('the close'), 'the reference gives the columns in the order of the table');
  assert.match(debug, /'Close'\)[^]*?'What occurred'\)[^]*?'Position'\)/, 'the table draws Close, What occurred, then Position');
});

test('the reference quotes the line about changed default settings and the CSV helper\'s words as the plugin has them', () => {
  const quoted: [string, string][] = [
    ['src/render.ts', 'You changed the default settings after the plugin calculated this result. This result uses the previous settings.'],
    ['src/csv-modal.ts', 'Are some of these columns prices? Select them here'],
    ['src/csv-modal.ts', 'This file has no prices. A strategy can read its columns but cannot trade it.'],
  ];
  for (const [file, text] of quoted) assert.ok(read(file).includes(`'${text}'`) && readme.includes(`"${text}"`), text);
  assert.ok(read('src/render.ts').includes("'Run again'") && readme.includes('with a "Run again" button'));
});

test('the reference gives the numbers of magnify, commission and the cross-check as the code has them', () => {
  assert.ok(readme.includes(`for the last ${YAHOO_INSIDE_DAYS['2m']} days (${YAHOO_INSIDE_DAYS['1h']} for 1h)`));
  assert.ok(readme.includes(`at most ${INSIDE_BARS.toLocaleString('en-US')} for a ticker`));
  assert.ok(readme.includes(`its commission would be ${SMALL_TRADE * 100}% of its value or more`));
  const cases = readdirSync(new URL('../xcheck/cases/', import.meta.url)).length;
  const expressions = [...read('xcheck/run.ts').match(/const INDICATORS[^]*?\n\];/)![0].matchAll(/^ {2}\[/gm)].length;
  assert.ok(readme.includes(`runs ${cases} strategy pairs and ${expressions} indicator expressions`), `the cross-check has ${cases} cases and ${expressions} expressions`);
  assert.ok(readme.includes(`The cross-check runs ${cases} cases and ${expressions} indicator expressions`));
});

test('the reference holds no path from anyone\'s own machine', () => {
  assert.doesNotMatch(readme, /\/Users\/|\/home\/[a-z]|[A-Z]:\\Users/);
});

test('the reference has no images and no promises of later features', () => {
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

test('the reference words the tries, the overfitting check and the versions as the plugin does, with its numbers', () => {
  const luck = read('src/render-luck.ts');
  const sweep = read('src/render-sweep.ts');
  const versions = read('src/render-versions.ts');
  for (const [file, text] of [
    [luck, 'How many tries'],
    [luck, 'Start again'],
    [luck, 'Keep the count'],
    [luck, 'Give the strategy a name'],
    [sweep, 'Overfitting check'],
    [versions, 'Versions'],
    [versions, 'Show the changes'],
    [versions, 'Show the text'],
  ] as const) {
    assert.ok(file.includes(`'${text}'`) && readme.includes(`"${text}"`), text);
  }
  for (const text of [RESET, RESTORE, UNNAMED, ADD_NAME]) assert.ok(readme.includes(`"${text}"`), text);
  // The lines of a record left elsewhere, with the example the reference uses.
  const take = async () => {};
  const found: OldRecord[] = [
    { kind: 'renamed', name: 'Trend', take },
    { kind: 'moved', note: 'Scratch.md', take },
    { kind: 'copied', note: 'Scratch.md', name: 'Trend', tries: 120, take },
  ];
  for (const f of found) {
    const { text, button } = oldRecordWords(f);
    assert.ok(readme.includes(`"${text}"`) && readme.includes(`"${button}"`), text);
  }
  assert.ok(readme.includes('"Add it to the count"'));
  const bound = 'is the maximum number of different tries. Variants that are near each other give almost the same results. Thus the number of different tries is smaller';
  assert.ok(upperBound(7).startsWith(`7 ${bound}`) && readme.includes(`N ${bound}`));
  assert.ok(readme.includes(`summed over ${STRETCHES} equal stretches`));
  assert.ok(readme.includes(`needs at least ${PBO_MIN_VARIANTS} of them and ${PBO_MIN_STEPS_PER_GROUP} bars in each part`));
  assert.ok(readme.includes(`The plugin keeps the first version and the last ${MAX_VERSIONS} versions.`));
});

// ------------------------------------------------------------------------------------------------ the short README

const short = read('README.md');

test('every block in the README parses without errors', () => {
  const found = fences(short);
  const parse = { strategy: (b: string) => parseSpec(b).errors, compare: (b: string) => parseCompare(b).errors, account: (b: string) => parseAccount(b).errors, backtests: (b: string) => parseDashboard(b).errors };
  for (const lang of Object.keys(parse) as (keyof typeof parse)[]) {
    const ofLang = found.filter((b) => b.lang === lang);
    assert.ok(ofLang.length >= 1, `no ${lang} block in the README`);
    for (const b of ofLang) assert.deepEqual(parse[lang](b.body), [], `the ${lang} block on README line ${b.line} ("${first(b.body)}") has errors`);
  }
});

test('the README names every command and every host the plugin contacts, and points to the reference', () => {
  const main = read('src/main.ts');
  const names = [...main.matchAll(/addCommand\(\{[^]*?\bname:\s*(["'`])((?:(?!\1).)*)\1/g)].map((m) => m[2]);
  assert.deepEqual(names.filter((n) => !short.includes(n)), [], 'commands the README does not name');
  // The hosts the reference's "Network requests" lists, which a plugin has to disclose where users read about it.
  const network = readme.slice(readme.indexOf('### Network requests'), readme.indexOf('\n## ', readme.indexOf('### Network requests')));
  const hosts = [...new Set([...network.matchAll(/`((?:[a-z0-9-]+\.)+[a-z]{2,})`/g)].map((m) => m[1]))];
  assert.ok(hosts.length >= 5, `only ${hosts.length} hosts found in the reference`);
  assert.deepEqual(hosts.filter((h) => !short.includes(`\`${h}\``)), [], 'hosts the README does not name');
  assert.ok(short.includes('](https://github.com/chauduyphanvu/obsidian-backtest/blob/main/docs/reference.md'), 'no link to the reference');
});

test('the README holds no path from anyone\'s own machine, no broken image and no promises of later features', () => {
  assert.doesNotMatch(short, /\/Users\/|\/home\/[a-z]|[A-Z]:\\Users/);
  assert.doesNotMatch(short, /!\[[^\]]*\]\(/, 'an image is an <img> tag with alt text, not Markdown');
  // A picture is a file in the repository, so it can't point at a page that moves or a screenshot nobody kept.
  const tags = [...short.matchAll(/<(img|source)\b[^>]*>/gi)].map((m) => m[0]);
  assert.ok(tags.length > 0);
  for (const tag of tags) {
    const path = tag.match(/\b(?:src|srcset)="([^"]+)"/)?.[1] ?? '';
    assert.match(path, /^docs\/images\/[a-z-]+\.png$/, tag);
    assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} is missing`);
    if (tag.startsWith('<img')) assert.match(tag, /\balt="[^"]{20,}"/, `${path} needs alt text`);
  }
  assert.ok(!/coming soon|\bTODO\b/i.test(short));
});
