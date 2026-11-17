import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

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
// styles/*.css are joined in name order into the one stylesheet Obsidian loads.
writeFileSync('dist/styles.css', readdirSync('styles').filter((f) => f.endsWith('.css')).sort().map((f) => readFileSync(`styles/${f}`, 'utf8')).join('\n'));
