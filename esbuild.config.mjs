import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', '@codemirror/state', '@codemirror/view'],
  format: 'cjs',
  target: 'es2022',
  outfile: 'dist/main.js',
});
copyFileSync('manifest.json', 'dist/manifest.json');
copyFileSync('styles.css', 'dist/styles.css');
