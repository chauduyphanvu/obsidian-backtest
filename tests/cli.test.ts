// The command line: check, run, explain, words and guide, as a model or a person would use them outside Obsidian.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cli, readText, type Io } from '../src/cli/main.ts';
import { nodeDeps } from '../src/cli/node-deps.ts';
import { makeRng } from '../src/rng.ts';

const dir = mkdtempSync(join(tmpdir(), 'backtest-blocks-cli-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Seven hundred daily bars of a random walk, as a CSV file in a vault; a lower `up` makes it fall. */
function prices(up = 0.48): string {
  const rng = makeRng(7);
  let c = 100;
  const t0 = Date.UTC(2020, 0, 1);
  const rows = Array.from({ length: 700 }, (_, i) => {
    const o = c;
    c *= 1 + (rng.next() - up) * 0.03;
    return `${new Date(t0 + i * 86_400_000).toISOString().slice(0, 10)},${o},${Math.max(o, c)},${Math.min(o, c)},${c}`;
  });
  return ['date,open,high,low,close', ...rows].join('\n');
}

const vault = join(dir, 'vault');
mkdirSync(join(vault, '.obsidian'), { recursive: true });
mkdirSync(join(vault, 'Data'), { recursive: true });
writeFileSync(join(vault, 'Data/walk.csv'), prices());
writeFileSync(join(vault, 'Data/fall.csv'), prices(0.56));
const NOTE = ['# Two strategies', '', '```strategy', 'name: Walk trend', 'universe: csv:Data/walk.csv', 'buy when close > sma(50)', 'sell when close < sma(50)', '```', '', '> [!note]', '> ```strategy', '> name: Walk dips', '> universe: csv:Data/walk.csv', '> buy when rsi(2) < 10', '> sell when rsi(2) > 70', '> ```', ''].join('\n');
writeFileSync(join(vault, 'Two.md'), NOTE);
writeFileSync(join(vault, 'Broken.md'), ['```strategy', 'universe: SPY', 'from: 01/31/2015', 'buy when close > moving_average(200)', '```', ''].join('\n'));
writeFileSync(join(vault, 'Prose.md'), 'Just a note.\n\n```js\nconsole.log(1)\n```\n');

async function call(args: string[], stdin = '', with_: Partial<Io> = {}): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    stdin: async () => stdin,
    env: {},
    cwd: vault,
    fetch: () => Promise.reject(new Error('no network in tests')),
    ...with_,
  };
  const code = await cli(args, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('check passes a note whose blocks are fine, and says how many it read', async () => {
  const r = await call(['check', 'Two.md']);
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.equal(r.err, '2 blocks checked: no problems');
});

test('check prints each problem at its line and column in the note, and fails', async () => {
  const r = await call(['check', 'Broken.md']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out.split('\n'), [
    'Broken.md:3:7: error: "01/31/2015" is not a date. Write it as 2015-01-31',
    `Broken.md:4:18: error: ${r.out.split('\n')[1].split(': error: ')[1]}`,
  ]);
  assert.match(r.out.split('\n')[1], /^Broken\.md:4:18: error: Unknown name "moving_average"/);
  assert.equal(r.err, '1 block checked: 2 errors, 0 warnings');
});

test('check counts lines and columns past the markers of a callout', async () => {
  writeFileSync(join(vault, 'Callout.md'), ['> [!tip]', '> ```strategy', '> universe: SPY', '> buy when close > sma(20', '> ```'].join('\n'));
  const r = await call(['check', 'Callout.md']);
  assert.equal(r.code, 1);
  assert.match(r.out, /^Callout\.md:4:\d+: error: /);
});

test('check reads a bare block from standard input, and fails a note with no strategy block', async () => {
  assert.equal((await call(['check', '-'], 'universe: SPY\nbuy when rsi(2) < 10\nsell when rsi(2) > 70\n')).code, 0);
  const prose = await call(['check', 'Prose.md']);
  assert.equal(prose.code, 1);
  assert.match(prose.err, /Prose\.md: no strategy block/);
});

test('check --json gives every problem with its place', async () => {
  const r = await call(['check', '--json', 'Broken.md']);
  const j = JSON.parse(r.out);
  assert.equal(j.blocks, 1);
  assert.equal(j.errors, 2);
  assert.deepEqual({ ...j.problems[0], message: undefined }, { file: 'Broken.md', block: null, line: 3, column: 7, severity: 'error', message: undefined });
});

test('run backtests the block named, on a CSV file in the vault above the note', async () => {
  const r = await call(['run', 'Two.md', '--block', 'Walk trend']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Walk trend\n2020-01-01 to 2021-11-30\n/);
  assert.match(r.out, /Return per year +-?−?[\d.]+% +−?[\d.]+%/);
  assert.match(r.out, /Worst drawdown +−[\d.]+% +−[\d.]+%/);
  assert.match(r.out, /Trades: \d+ closed/);
  const j = JSON.parse((await call(['run', 'Two.md', '--block', '2', '--json'])).out);
  assert.equal(j.name, 'Walk dips');
  assert.ok(Number.isFinite(j.strategy.returnPerYear) && j.strategy.worstDrawdown <= 0);
  assert.ok(j.trades.count > 0 && j.lastTrades.length > 0);
  assert.deepEqual(Object.keys(j.now[0]), ['ticker', 'holds']);
});

test('run asks which block when a note has several, and does not run a block with errors', async () => {
  const several = await call(['run', 'Two.md']);
  assert.equal(several.code, 2);
  assert.equal(several.err, 'Two.md has 2 blocks (1: Walk trend, 2: Walk dips). Choose one with --block');
  const broken = await call(['run', 'Broken.md']);
  assert.equal(broken.code, 1);
  assert.match(broken.err, /^The block has errors, so it was not run:\nBroken\.md:3:7: error: /);
  assert.equal(broken.out, '');
});

test('explain gives a word\'s form, meaning and example, in any case, and points to near words', async () => {
  const r = await call(['explain', 'Stop', 'Loss']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^stop loss: 10% \| 2 atr\(14\)\n\n.+\n\nExample:\nstop loss: 10%$/s);
  assert.match((await call(['explain', 'rebalance=monthly'])).out, /monthly/);
  const near = await call(['explain', 'cross']);
  assert.equal(near.code, 1);
  assert.match(near.err, /Did you mean: crosses, crosses above, crosses below/);
});

test('words, guide, help and version', async () => {
  assert.match((await call(['words'])).out, /^functions: sma, ema, /);
  assert.ok(JSON.parse((await call(['words', '--json'])).out).functions.length > 50);
  assert.match((await call(['guide'])).out, /^# Backtest Blocks: writing strategy blocks\n/);
  assert.match((await call(['--help'])).out, /backtest-blocks check <file\|->/);
  assert.equal((await call([])).code, 2);
  assert.equal((await call(['frobnicate'])).code, 2);
  assert.match((await call(['--version'])).out, /^\d+\.\d+\.\d+$/);
});

test('the command runs as a program and sets its exit code', () => {
  const version = execFileSync(process.execPath, ['src/cli/bin.ts', '--version'], { encoding: 'utf8' });
  assert.match(version, /^\d+\.\d+\.\d+\n$/);
  assert.throws(() => execFileSync(process.execPath, ['src/cli/bin.ts', 'check', join(vault, 'Broken.md')], { stdio: 'pipe' }), (e: { status: number }) => e.status === 1);
});

test('a Yahoo retry waits on Node, where there is no browser window', async () => {
  const deps = nodeDeps({ vault, cacheDir: join(dir, 'cache'), env: {} });
  await deps.sleep!(1);
});

test('check goes on past a note it can not read, reports every other problem, and fails each note with no block', async () => {
  const both = await call(['check', 'Broken.md', 'Missing.md']);
  assert.equal(both.code, 2);
  assert.match(both.out, /^Broken\.md:3:7: error: /);
  assert.match(both.err, /can't read Missing\.md/);
  const one = await call(['check', 'Two.md', 'Prose.md']);
  assert.equal(one.code, 1);
  assert.equal(one.err, 'Prose.md: no strategy block: a block opens with ```strategy\n2 blocks checked: 1 note with no strategy block');
  assert.equal((await call(['check', 'Prose.md'])).err, 'Prose.md: no strategy block: a block opens with ```strategy\n0 blocks checked: 1 note with no strategy block');
});

test('a CSV path reads from the vault as Obsidian does, and never from outside it', async () => {
  writeFileSync(join(dir, 'outside.csv'), prices());
  const slash = await call(['run', '-'], 'universe: csv:/Data/walk.csv\nbuy when close > sma(20)\nsell when close < sma(20)');
  assert.equal(slash.code, 0, slash.err);
  const out = await call(['run', '-'], 'universe: csv:../outside.csv\nbuy when close > sma(20)\nsell when close < sma(20)');
  assert.equal(out.code, 1);
  assert.match(out.err, /No file at \.\.\/outside\.csv|outside the vault/);
});

test('standard input is read as UTF-8 even when a character falls between two chunks', async () => {
  const times = Buffer.from('×');
  async function* chunks() {
    yield Buffer.concat([Buffer.from('name: a'), times.subarray(0, 1)]);
    yield Buffer.concat([times.subarray(1), Buffer.from('b')]);
  }
  assert.equal(await readText(chunks()), 'name: a×b');
});

test('explain takes a word as a block writes it: a call with its arguments, a setting with its value', async () => {
  assert.match((await call(['explain', 'sma(200)'])).out, /^sma\(n\)/);
  assert.match((await call(['explain', 'rebalance: monthly'])).out, /^rebalance: monthly/);
  assert.match((await call(['explain', 'stop loss: 10%'])).out, /^stop loss: /);
});

test('the MCP server exits quietly when its client closes standard input', () => {
  const r = spawnSync(process.execPath, ['src/cli/bin.ts', 'mcp'], { input: '', encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: join(dir, 'xdg') } });
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
});

test('a FRED or Tiingo key that is missing or refused names the variable to set, not the plugin settings', async () => {
  const fred = 'universe: csv:Data/walk.csv\nbuy when close of fred:T10Y2Y > 0\nsell when close of fred:T10Y2Y < 0';
  const missing = await call(['run', '-'], fred);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /FRED needs an API key to load T10Y2Y\. Set FRED_API_KEY in the environment\./);
  assert.match((await call(['run', '-'], 'data: tiingo\nuniverse: SPY\nbuy when close > sma(20)\nsell when close < sma(20)')).err, /Set TIINGO_API_KEY in the environment\./);
  const refused = await call(['run', '-'], fred, {
    env: { FRED_API_KEY: 'wrong' },
    fetch: async () => new Response('{"error_code":400,"error_message":"Bad Request.  The value for variable api_key is not registered."}', { status: 400 }),
  });
  assert.match(refused.err, /FRED did not accept the API key\. Check FRED_API_KEY/);
  for (const r of [missing, refused]) assert.doesNotMatch(r.err, /plugin settings/);
});

test('a note with no strategy fence is not read as a block, however plain its text', async () => {
  writeFileSync(join(vault, 'Plain.md'), '# Ideas\n\nBuy SPY when it looks cheap.\n');
  const r = await call(['check', 'Plain.md']);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /^Plain\.md: no strategy block/);
  // A file that is not a note, and standard input, may still be a bare block.
  writeFileSync(join(vault, 'draft.txt'), 'universe: SPY\nbuy when close > sma(200)\nsell when close < sma(200)\n');
  assert.equal((await call(['check', 'draft.txt'])).code, 0);
});

test('a block in a plain fence is not checked, and the message says how to fence it', async () => {
  const r = await call(['check', '-'], '```\nuniverse: SPY\nbuy when close > sma(200)\n```');
  assert.equal(r.code, 1);
  assert.equal(r.err, '-: no strategy block: a block opens with ```strategy, or give its lines with no fence\n0 blocks checked: 1 note with no strategy block');
});

test('the run table writes a negative Sharpe ratio with the same minus as the other figures', async () => {
  const r = await call(['run', '-'], 'universe: csv:Data/fall.csv\nbuy when close > 0\nsell when close < 0');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Sharpe ratio +−\d\.\d\d +−\d\.\d\d$/m);
  assert.doesNotMatch(r.out, /(^|\s)-\d/m);
});
