// The files written for language models and tools are made from the code, so they must match it.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ALL_DOCS } from '../src/docs.ts';
import { generatedFiles } from '../src/llm-files.ts';

test('every generated file is as the code makes it', () => {
  for (const [path, text] of Object.entries(generatedFiles())) {
    assert.ok(existsSync(path), `${path} is missing: run npm run generate`);
    assert.ok(readFileSync(path, 'utf8') === text, `${path} is out of date: run npm run generate`);
  }
});

test('the word list has every word the editor explains, under its kind', () => {
  const list = JSON.parse(generatedFiles()['docs/language.json']);
  const names = (key: string) => list[key].map((w: { name: string }) => w.name);
  for (const d of ALL_DOCS) {
    const key = { function: 'functions', series: 'series', calendar: 'calendar', position: 'position', setting: 'settings', word: 'words', unit: 'units' }[d.kind as string];
    if (key) assert.ok(names(key).includes(d.id), `${d.id} in ${key}`);
  }
  assert.ok(names('functions').includes('kama') && names('calendar').includes('trading_days_left'));
  assert.deepEqual(list.settings.find((s: { name: string }) => s.name === 'rebalance').values.map((v: { value: string }) => v.value), ['never', 'weekly', 'monthly', 'quarterly', 'yearly']);
  assert.ok(list.reserved.includes('close') && !list.reserved.includes('count') && list.laterWords.words.includes('count'));
});
