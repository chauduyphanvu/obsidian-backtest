import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
// Obsidian loads one main.js per plugin, so the worker that runs sweeps and luck checks is bundled first and goes
// into main.js as text (src/worker-client.ts starts it from that text).
const worker = await build({
  entryPoints: ['src/worker.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  write: false,
});
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', '@codemirror/state', '@codemirror/view'],
  format: 'cjs',
  target: 'es2022',
  outfile: 'dist/main.js',
  define: { WORKER_CODE: JSON.stringify(worker.outputFiles[0].text) },
});
// The command line and MCP server, one file for Node that a release carries beside the plugin.
await build({
  entryPoints: ['src/cli/bin.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/backtest-blocks.mjs',
  define: { BACKTEST_BLOCKS_VERSION: JSON.stringify(JSON.parse(readFileSync('manifest.json', 'utf8')).version) },
  // Some of the MCP SDK's dependencies are CommonJS and call require(), which an ES module has no other way to give them.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
copyFileSync('manifest.json', 'dist/manifest.json');
// styles/*.css are joined in name order into the one stylesheet Obsidian loads.
writeFileSync('dist/styles.css', readdirSync('styles').filter((f) => f.endsWith('.css')).sort().map((f) => readFileSync(`styles/${f}`, 'utf8')).join('\n'));
