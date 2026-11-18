// The worked examples and the mistakes written for language models: each one must say what the parser says.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CORPUS } from '../src/corpus/examples.ts';
import { MISTAKES } from '../src/corpus/mistakes.ts';
import { ALL_DOCS } from '../src/docs.ts';
import { parseSpec } from '../src/dsl.ts';
import { EXAMPLES } from '../src/examples.ts';

const problems = (source: string) => {
  const { errors, warnings } = parseSpec(source);
  return [...errors, ...warnings].map((d) => `line ${d.line}: ${d.message}`);
};

test('every example parses with no problems', () => {
  for (const e of CORPUS) assert.deepEqual(problems(e.source), [], e.title);
});

test('every example has a name line, a description, tags and notes without their prefix, and none repeats another', () => {
  for (const e of CORPUS) {
    assert.match(e.source, /^name: \S/, e.title);
    assert.ok(e.description.length > 20 && e.tags.length > 0, e.title);
    assert.ok(e.notes.every((n) => !/^NOTE/i.test(n) && n.trim() === n && n.length > 0), e.title);
    assert.ok(!/```/.test(e.source), e.title);
  }
  for (const key of ['title', 'description', 'source'] as const) {
    const seen = new Set<string>();
    for (const e of CORPUS) {
      assert.ok(!seen.has(e[key]), `${key} repeated: ${e[key].slice(0, 60)}`);
      seen.add(e[key]);
    }
  }
  assert.equal(CORPUS.filter((e) => e.prompt).length, EXAMPLES.length);
});

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How a word shows in a block, for the words whose id is not simply written as is. */
const SHOWS: Record<string, RegExp> = {
  'for … bars': /\bfor \w+ bars\b/,
  within: /\bwithin \w+ bars\b/,
  for: /^\s*for (?!all:)\S/m,
  'for all': /^\s*for all:/m,
  crosses: /\bcrosses (?!above|below)/,
  above: /(?<!crosses )\babove\b/,
  below: /(?<!crosses )\bbelow\b/,
  of: /\bof [\w^:$]/,
  '[n]': /\[\w+\]/,
  'in … step': /=\s*[-\d.]+%?\s+in\s+[-\d.]+%?\s*\.\.\s*[-\d.]+%?\s+step\b/,
  'top … by': /\btop \w+ by\b/,
  at: /\bat \d/,
  'tiingo:': /\btiingo:\w/,
  'fred:': /\bfred:\w/,
  '%': /\d%/,
  bps: /\d\s*bps\b/,
};

function shows(d: { id: string; kind: string }, text: string): boolean {
  if (SHOWS[d.id]) return SHOWS[d.id].test(text);
  if (d.kind === 'function') return new RegExp(`\\b${escape(d.id)}\\(`).test(text);
  if (d.kind === 'setting') return new RegExp(`^\\s*${escape(d.id)}:`, 'mi').test(text);
  if (d.kind === 'value') {
    const [key, value] = d.id.split('=');
    return new RegExp(`^\\s*${escape(key)}:\\s*${escape(value)}\\s*$`, 'mi').test(text);
  }
  if (/ when$/.test(d.id)) return new RegExp(`^\\s*${escape(d.id)}\\b`, 'm').test(text);
  return new RegExp(`(?<![\\w])${escape(d.id)}(?![\\w])`).test(text);
}

test('the examples use every word of the language at least once', () => {
  const all = CORPUS.map((e) => e.source).join('\n\n');
  // A few intervals stand for all of them: they are written alike.
  const intervals = ['interval=1h', 'interval=1d', 'interval=1w', 'interval=15m'];
  const missing = ALL_DOCS.filter((d) => ['function', 'series', 'calendar', 'position', 'setting', 'value', 'word', 'unit'].includes(d.kind))
    .filter((d) => !d.id.startsWith('interval=') || intervals.includes(d.id))
    .filter((d) => !shows(d, all))
    .map((d) => d.id);
  assert.deepEqual(missing, []);
});

test('there are enough examples and mistakes to learn from', () => {
  assert.ok(CORPUS.length >= 60, `${CORPUS.length} examples`);
  assert.ok(MISTAKES.length >= 25, `${MISTAKES.length} mistakes`);
});

test('every mistake gives exactly its recorded messages, and its fix parses with no problems', () => {
  for (const m of MISTAKES) {
    assert.deepEqual(parseSpec(m.broken).errors.map((e) => ({ line: e.line, message: e.message })), m.errors, m.title);
    assert.ok(m.errors.length > 0, m.title);
    assert.deepEqual(problems(m.fixed), [], m.title);
    assert.ok(m.why.length > 10, m.title);
  }
  const titles = MISTAKES.map((m) => m.title);
  assert.equal(new Set(titles).size, titles.length, 'a mistake title repeats');
});
