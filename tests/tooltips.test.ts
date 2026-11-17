import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// Obsidian shows its own tooltip over anything with an aria-label. Over an <svg> its tooltip code throws (it calls a
// method Obsidian adds to HTML elements only), and over a whole region the label covers what the reader is looking at.
// `--no-tooltip: true` is what Obsidian checks first, so those carry it; buttons keep their tooltips.
const css = readdirSync(new URL('../styles/', import.meta.url))
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(new URL(`../styles/${f}`, import.meta.url), 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const quiet = (selector: string) => {
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (selectors.includes(selector) && /--no-tooltip:\s*true/.test(m[2])) return true;
  }
  return false;
};

test('charts and labelled regions carry no Obsidian tooltip', () => {
  const src = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.ts'));
  for (const f of src) {
    const text = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    for (const m of text.matchAll(/'svg', \{[^}]*'aria-label'[^}]*\}/g)) assert.match(m[0], /class: 'bt-svg'/, `${f}: a labelled chart without bt-svg`);
  }
  for (const selector of ['.bt-svg', '.bt-params', '.bt-debug-scroll', '.bt-dash-table', '.bt-csv-files', '.bt-gallery-list', '.bt-csv-filter', '.bt-llm-input', '.bt-debug-picker', '.bt-price-picker']) {
    assert.ok(quiet(selector), `${selector} has no --no-tooltip: true`);
  }
});
