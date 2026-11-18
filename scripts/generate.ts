// Writes the files made for language models and tools (src/llm-files.ts). Run with: npm run generate
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatedFiles } from '../src/llm-files.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const [path, text] of Object.entries(generatedFiles())) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  console.log(`wrote ${path}`);
}
