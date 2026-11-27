// The command line: check, run, explain, words and guide, as a model or a person would use them outside Obsidian.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.equal(r.err, '2 blocks examined: no problems');
});

test('check prints each problem at its line and column in the note, and fails', async () => {
  const r = await call(['check', 'Broken.md']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out.split('\n'), [
    'Broken.md:3:7: error: "01/31/2015" is not a date in the form YYYY-MM-DD. For example, write 2015-01-31.',
    `Broken.md:4:18: error: ${r.out.split('\n')[1].split(': error: ')[1]}`,
  ]);
  assert.match(r.out.split('\n')[1], /^Broken\.md:4:18: error: Unknown name "moving_average"/);
  assert.equal(r.err, '1 block examined: 2 errors, 0 warnings');
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

test('check on a DAG child clamps merged-source diagnostics past the child block end and tags them [resolved]', async () => {
  writeFileSync(
    join(vault, 'DagBadParent.md'),
    ['```strategy', 'name: Bad Parent', 'universe: SPY', 'a = 1', 'b = 2', 'c = 3', 'buy when close > unknown_fn(10)', '```'].join('\n'),
  );
  writeFileSync(
    join(vault, 'DagChild.md'),
    ['# Child', '', '```strategy', 'name: Child', 'extends: [[DagBadParent]]', '```'].join('\n'),
  );
  const r = await call(['check', '--json', 'DagChild.md']);
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out) as { problems: { line: number; message: string }[] };
  assert.ok(j.problems.length > 0);
  // Child block starts at line 4 (0-based 3) with only 2 lines (4..5); parent error anchors on `extends:` (line 5) with [resolved].
  for (const p of j.problems) {
    assert.equal(p.line, 5, `expected parent error anchored on extends line (5), got ${p.line}`);
    assert.match(p.message, /^\[resolved\] /);
  }
});

test('check on a DAG child with comments maps in-range parent errors to extends: and child token errors to the child rule line', async () => {
  writeFileSync(
    join(vault, 'DagBadParentShort.md'),
    ['```strategy', 'name: Bad Parent Short', 'universe: SPY', 'buy when close > bogus_parent_fn(10)', '```'].join('\n'),
  );
  writeFileSync(
    join(vault, 'DagChildWithComments.md'),
    [
      '```strategy',
      'name: Commented Child',
      'extends: [[DagBadParentShort]]',
      '# comment line 1',
      '# comment line 2',
      '# comment line 3',
      '# comment line 4',
      '```',
    ].join('\n'),
  );
  const parentErr = await call(['check', '--json', 'DagChildWithComments.md']);
  assert.equal(parentErr.code, 1);
  const pj = JSON.parse(parentErr.out) as { problems: { line: number; message: string }[] };
  assert.ok(pj.problems.length > 0);
  // Must anchor on `extends:` (line 3) with [resolved], NOT land on a comment line inside the child block!
  for (const p of pj.problems) {
    assert.equal(p.line, 3);
    assert.match(p.message, /^\[resolved\] /);
  }

  writeFileSync(
    join(vault, 'DagGoodParent2.md'),
    ['```strategy', 'name: Good Parent 2', 'universe: SPY', 'buy when close > sma(20)', '```'].join('\n'),
  );
  writeFileSync(
    join(vault, 'DagBadChildRule.md'),
    [
      '```strategy',
      'name: Bad Child Rule',
      'extends: [[DagGoodParent2]]',
      '# extra note',
      'buy when base and close > smaa_typo(10)',
      '```',
    ].join('\n'),
  );
  const childErr = await call(['check', '--json', 'DagBadChildRule.md']);
  assert.equal(childErr.code, 1);
  const cj = JSON.parse(childErr.out) as { problems: { line: number; message: string }[] };
  assert.equal(cj.problems.length, 1);
  // Must map directly to line 5 (`buy when base and close > smaa_typo(10)`) with [resolved]!
  assert.equal(cj.problems[0].line, 5);
  assert.match(cj.problems[0].message, /^\[resolved\] .*smaa_typo/);
});

test('check --fix skips unresolved DAG blocks and never corrupts valid extends/base syntax', async () => {
  writeFileSync(
    join(vault, 'DagGoodParent.md'),
    ['```strategy', 'name: Good Parent', 'universe: SPY', 'buy when close > sma(50)', 'sell when close < sma(50)', '```'].join('\n'),
  );
  const childContent = ['```strategy', 'name: Good Child', 'extends: [[DagGoodParent]]', 'buy when base and rsi(14) < 70', '```', ''].join('\n');
  const childPath = join(vault, 'DagGoodChild.md');
  writeFileSync(childPath, childContent);
  const r = await call(['check', '--fix', 'DagGoodChild.md']);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(childPath, 'utf8'), childContent);
});

test('check --json gives every problem with its place', async () => {
  const r = await call(['check', '--json', 'Broken.md']);
  const j = JSON.parse(r.out);
  assert.equal(j.blocks, 1);
  assert.equal(j.errors, 2);
  assert.deepEqual({ ...j.problems[0], message: undefined }, { file: 'Broken.md', block: null, line: 3, column: 7, severity: 'error', message: undefined, fixes: [] });
});

/** A note with five slips that each have one correction, and one with two equally near ones; the second block is in a callout. */
const TYPOS = [
  '# Typos',
  '',
  '```strategy',
  'universe: SPY',
  'from: 2015/01/31',
  'rebalance: montly',
  'buy when close > smaa(200) && rsi(2) < 10',
  'sell when close < sam(200)',
  '```',
  '',
  '> [!note]',
  '> ```strategy',
  '> universe: QQQ',
  '> buy when close crosses over sma(50)',
  '> ```',
  '',
].join('\n');

test('check prints the correction under each problem that has one, and --json gives each correction placed in the note', async () => {
  writeFileSync(join(vault, 'Typos.md'), TYPOS);
  const r = await call(['check', 'Typos.md']);
  assert.equal(r.code, 1);
  const out = r.out.split('\n');
  assert.equal(out[out.indexOf('Typos.md:6:12: error: rebalance must be one of: never, weekly, monthly, quarterly, yearly') + 1], '  Did you mean monthly?');
  assert.equal(out[out.indexOf('Typos.md:7:28: error: Unexpected character "&"') + 1], '  Write and, not &&.');
  assert.equal(out[out.findIndex((l) => l.startsWith('Typos.md:7:18: error: Unknown name "smaa".')) + 1], '  Did you mean sma, the simple average of the last n closes?');
  assert.equal(out[out.findIndex((l) => l.startsWith('Typos.md:8:19: error: Unknown name "sam".')) + 1], '  Possible corrections: sma, sum.');
  // A message that says what to write has no line under it.
  assert.ok(out[out.indexOf('Typos.md:5:7: error: Write the date with dashes: 2015-01-31.') + 1].startsWith('Typos.md:6:'));

  const j = JSON.parse((await call(['check', '--json', 'Typos.md'])).out);
  const fixes = (line: number) => j.problems.filter((p: { line: number }) => p.line === line).map((p: { fixes: unknown[] }) => p.fixes);
  assert.deepEqual(fixes(5), [[{ label: 'Change to 2015-01-31', line: 5, from: 7, to: 17, insert: '2015-01-31' }]]);
  assert.deepEqual(fixes(8), [[{ label: 'Change to sma', line: 8, from: 19, to: 22, insert: 'sma' }, { label: 'Change to sum', line: 8, from: 19, to: 22, insert: 'sum' }]]);
  // In a callout, the columns count the markers too.
  assert.deepEqual(fixes(14), [[{ label: 'Change to crosses above', line: 14, from: 18, to: 30, insert: 'crosses above' }]]);
  assert.equal(j.problems.find((p: { line: number }) => p.line === 6).suggestion, 'Did you mean monthly?');
  // Without --fix nothing is written.
  assert.equal(readFileSync(join(vault, 'Typos.md'), 'utf8'), TYPOS);
});

test('--json gives a correction that spans lines in a callout its end line, with the columns of each line past its own markers', async () => {
  const note = ['> [!note]', '> ```strategy', '> universe: SPY', '> buy when close > sma(5)', '>', '>   and rsi(2) < 30', '> ```', ''];
  writeFileSync(join(vault, 'Blank.md'), note.join('\n'));
  const j = JSON.parse((await call(['check', '--json', 'Blank.md'])).out);
  const [fix] = j.problems.flatMap((p: { fixes: unknown[] }) => p.fixes);
  assert.deepEqual(fix, { label: 'Remove the blank line', line: 5, from: 2, endLine: 6, to: 3, insert: '' });
  // A client that makes the change as given gets a block with no problem left.
  const at = (line: number, column: number) => note.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1;
  const text = note.join('\n');
  writeFileSync(join(vault, 'Blank.md'), text.slice(0, at(fix.line, fix.from)) + fix.insert + text.slice(at(fix.endLine, fix.to)));
  assert.deepEqual(JSON.parse((await call(['check', '--json', 'Blank.md'])).out).problems, []);
});

test('check --fix writes each correction that is the only one, in every block, and leaves a choice between two as it is', async () => {
  writeFileSync(join(vault, 'Fix.md'), TYPOS);
  const r = await call(['check', '--fix', 'Fix.md']);
  assert.equal(r.code, 1);
  assert.equal(
    readFileSync(join(vault, 'Fix.md'), 'utf8'),
    TYPOS.replace('2015/01/31', '2015-01-31').replace('montly', 'monthly').replace('smaa(200) &&', 'sma(200) and').replace('crosses over', 'crosses above'),
  );
  assert.deepEqual(r.out.split('\n').slice(0, 6), [
    'Fix.md:5:7: fixed: Change to 2015-01-31',
    'Fix.md:6:12: fixed: Change to monthly',
    'Fix.md:7:18: fixed: Change to sma',
    'Fix.md:7:28: fixed: Change to and',
    'Fix.md:14:18: fixed: Change to crosses above',
    `Fix.md:8:19: error: ${r.out.split('\n')[5].split(': error: ')[1]}`,
  ]);
  assert.equal(r.err, '2 blocks examined: 5 corrections written; 1 error, 0 warnings');

  // A note with nothing to correct is not written, and says so.
  const again = await call(['check', '--fix', '--json', 'Fix.md']);
  const j = JSON.parse(again.out);
  assert.deepEqual(j.fixed, []);
  assert.equal(j.errors, 1);

  // A correction can show the next problem: the misspelt function is read only once the line is a rule.
  writeFileSync(join(vault, 'Rounds.md'), '```strategy\nuniverse: SPY\nbuy when close > sma(50)\nsel whn close < smaa(20)\n```\n');
  assert.deepEqual((await call(['check', 'Rounds.md'])).out.split('\n'), ['Rounds.md:4:1: error: Unexpected "sel"', '  Did you mean sell when?']);
  const rounds = await call(['check', '--fix', 'Rounds.md']);
  assert.equal(rounds.code, 0, rounds.out);
  assert.equal(readFileSync(join(vault, 'Rounds.md'), 'utf8'), '```strategy\nuniverse: SPY\nbuy when close > sma(50)\nsell when close < sma(20)\n```\n');
  assert.equal(rounds.out, 'Rounds.md:4:1: fixed: Change to sell when\nRounds.md:4:19: fixed: Change to sma');
  assert.equal(rounds.err, '1 block examined: 2 corrections written; no problems');

  // Standard input has no file to write into.
  const stdin = await call(['check', '--fix', '-'], 'universe: SPY\nbuy when close > smaa(20)');
  assert.equal(stdin.code, 2);
  assert.match(stdin.err, /cannot read a block from standard input/);
});

test('explain takes a window with its number, and the other names of a cross, with a note that the language says crosses', async () => {
  assert.match((await call(['explain', 'for', '3', 'bars'])).out, /^condition for n bars\n/);
  assert.match((await call(['explain', 'within 5 bars'])).out, /^condition within n bars\n/);
  for (const word of ['crossover', 'cross over', 'Crosses Over']) {
    const r = await call(['explain', word]);
    assert.equal(r.code, 0);
    assert.match(r.out, new RegExp(`^"${word}" is not a word of the language\\. The language uses crosses, crosses above and crosses below\\. This is the help for crosses\\.\\n\\na crosses b\\n`));
  }
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

test('run uses the plugin settings that the vault keeps, and says so, and stops when it cannot read them', async () => {
  const kept = join(dir, 'kept');
  mkdirSync(join(kept, '.obsidian/plugins/backtest-blocks'), { recursive: true });
  mkdirSync(join(kept, 'Data'), { recursive: true });
  writeFileSync(join(kept, 'Data/walk.csv'), prices());
  writeFileSync(join(kept, 'Two.md'), NOTE);
  const settings = join(kept, '.obsidian/plugins/backtest-blocks/data.json');
  writeFileSync(settings, JSON.stringify({ costs: '50 bps', capital: 20000 }));
  const plain = JSON.parse((await call(['run', 'Two.md', '--block', 'Walk trend', '--json'])).out);
  const r = await call(['run', 'Two.md', '--block', 'Walk trend', '--json'], '', { cwd: kept });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, `run: uses the plugin settings in ${settings}`);
  const j = JSON.parse(r.out);
  assert.ok(j.trades.count > 0);
  assert.ok(j.strategy.totalReturn < plain.strategy.totalReturn, 'the costs of the vault make each trade cost more');
  // --vault points at the vault whose settings and files a run uses.
  const pointed = await call(['run', join(kept, 'Two.md'), '--block', 'Walk trend', '--json', '--vault', vault]);
  assert.equal(pointed.err, '');
  assert.equal(JSON.parse(pointed.out).strategy.totalReturn, plain.strategy.totalReturn);
  writeFileSync(settings, '{ not json');
  const broken = await call(['run', 'Two.md', '--block', 'Walk trend'], '', { cwd: kept });
  assert.equal(broken.code, 2);
  assert.match(broken.err, /^run: cannot read the plugin settings in .*data\.json: /);
});

test('run asks which block when a note has several, and does not run a block with errors', async () => {
  const several = await call(['run', 'Two.md']);
  assert.equal(several.code, 2);
  assert.equal(several.err, 'Two.md has 2 blocks (1: Walk trend, 2: Walk dips). Select one with --block');
  const broken = await call(['run', 'Broken.md']);
  assert.equal(broken.code, 1);
  assert.match(broken.err, /^The block has errors. It did not run:\nBroken\.md:3:7: error: /);
  assert.equal(broken.out, '');
});

test('explain gives a word\'s form, meaning and example, in any case, and points to near words', async () => {
  const r = await call(['explain', 'Stop', 'Loss']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^stop loss: 10% \| 2 atr\(14\)\n\n.+\n\nExample:\nstop loss: 10%$/s);
  assert.match((await call(['explain', 'rebalance=monthly'])).out, /monthly/);
  const near = await call(['explain', 'cross']);
  assert.equal(near.code, 1);
  assert.match(near.err, /Words that contain "cross": crosses, crosses above, crosses below/);
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
  assert.match(both.err, /cannot read Missing\.md/);
  const one = await call(['check', 'Two.md', 'Prose.md']);
  assert.equal(one.code, 1);
  assert.equal(one.err, 'Prose.md: no strategy block: a block starts with ```strategy\n2 blocks examined: 1 note with no strategy block');
  assert.equal((await call(['check', 'Prose.md'])).err, 'Prose.md: no strategy block: a block starts with ```strategy\n0 blocks examined: 1 note with no strategy block');
});

test('a CSV path reads from the vault as Obsidian does, and never from outside it', async () => {
  writeFileSync(join(dir, 'outside.csv'), prices());
  const slash = await call(['run', '-'], 'universe: csv:/Data/walk.csv\nbuy when close > sma(20)\nsell when close < sma(20)');
  assert.equal(slash.code, 0, slash.err);
  const out = await call(['run', '-'], 'universe: csv:../outside.csv\nbuy when close > sma(20)\nsell when close < sma(20)');
  assert.equal(out.code, 1);
  assert.match(out.err, /There is no file at \.\.\/outside\.csv|not in the vault/);
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
  assert.match(missing.err, /The plugin must have a FRED API key to load T10Y2Y\. Set FRED_API_KEY in the environment\./);
  assert.match((await call(['run', '-'], 'data: tiingo\nuniverse: SPY\nbuy when close > sma(20)\nsell when close < sma(20)')).err, /Set TIINGO_API_KEY in the environment\./);
  const refused = await call(['run', '-'], fred, {
    env: { FRED_API_KEY: 'wrong' },
    fetch: async () => new Response('{"error_code":400,"error_message":"Bad Request.  The value for variable api_key is not registered."}', { status: 400 }),
  });
  assert.match(refused.err, /FRED did not accept the API key\. Make sure that FRED_API_KEY is correct/);
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
  assert.equal(r.err, '-: no strategy block: a block starts with ```strategy, or give the lines of the block without a fence\n0 blocks examined: 1 note with no strategy block');
});

test('the run table writes a negative Sharpe ratio with the same minus as the other figures', async () => {
  const r = await call(['run', '-'], 'universe: csv:Data/fall.csv\nbuy when close > 0\nsell when close < 0');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Sharpe ratio +−\d\.\d\d +−\d\.\d\d$/m);
  assert.doesNotMatch(r.out, /(^|\s)-\d/m);
});
