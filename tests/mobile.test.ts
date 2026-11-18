// Obsidian's mobile app runs on iOS versions whose JavaScript has no lookbehind, and the community directory's review
// rejects a plugin that uses one, even in a regular expression built from a string.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const sources = (dir: string): string[] =>
  readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : [],
  );

test('no regular expression in the source looks behind', () => {
  const found = sources('src').flatMap((f) =>
    readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
      .split('\n')
      .flatMap((line, i) => (/\(\?<[=!]/.test(line) ? [`${f}:${i + 1}`] : [])),
  );
  assert.deepEqual(found, []);
});
