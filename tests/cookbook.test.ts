import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseAccount } from '../src/account.ts';
import { runBacktest } from '../src/backtest.ts';
import { blockName } from '../src/blocks.ts';
import { parseCompare } from '../src/compare.ts';
import { hasDagRefs, parseSignalBlock, parseUniverseBlock, resolveStrategyDag, type VaultReader } from '../src/dag.ts';
import { parseDashboard } from '../src/dashboard.ts';
import { docFor } from '../src/docs.ts';
import { parseSpec, type Spec } from '../src/dsl.ts';
import { DAY } from '../src/format.ts';
import type { Bars } from '../src/types.ts';

const cookbook = readFileSync(new URL('../docs/cookbook.md', import.meta.url), 'utf8');

interface Fence {
  lang: string;
  body: string;
  line: number;
}

/** Extracts every fenced code block in a Markdown document with its 1-based opening line. */
function fences(markdown: string): Fence[] {
  const out: Fence[] = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^ {0,3}(`{3,}|~{3,})\s*(\S*)/);
    if (!open) continue;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^ {0,3}\\${open[1][0]}{${open[1].length},}\\s*$`).test(lines[j])) body.push(lines[j++]);
    assert.ok(j < lines.length, `the fence on cookbook line ${i + 1} is never closed`);
    out.push({ lang: open[2].toLowerCase(), body: body.join('\n'), line: i + 1 });
    i = j;
  }
  return out;
}

const blocks = fences(cookbook);
const firstLine = (body: string) => body.split('\n').find((l) => l.trim()) ?? '';

/** GitHub-style heading slugifier for verifying internal TOC anchor links. */
function githubSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/ /g, '-');
}

/**
 * Builds an in-memory VaultReader populated from the cookbook's own named `strategy`, `signal`, `regime`, and `universe`
 * blocks so `extends: [[...]]`, `universe: [[...]]`, and `[[Note#export]]` references resolve against real cookbook blocks.
 */
function cookbookVault(): VaultReader {
  const notes = new Map<string, string>();
  const dagLangs = new Set(['strategy', 'signal', 'regime', 'universe']);
  for (const b of blocks) {
    if (!dagLangs.has(b.lang)) continue;
    const name = blockName(b.body);
    if (!name) continue;
    const path = `${name}.md`;
    const fenced = `\`\`\`${b.lang}\n${b.body}\n\`\`\`\n`;
    notes.set(path.toLowerCase(), `${notes.get(path.toLowerCase()) ?? ''}${fenced}`);
  }
  return {
    resolve(link: string): string | null {
      const clean = link.replace(/\.md$/i, '').trim();
      const key = `${clean}.md`.toLowerCase();
      return notes.has(key) ? `${clean}.md` : null;
    },
    async read(path: string): Promise<string | null> {
      return notes.get(path.toLowerCase()) ?? null;
    },
  };
}

/** Deterministic multi-regime synthetic OHLCV series spanning 2004..2025 for executing cookbook recipes end-to-end. */
function synthSeries(name: string, interval: Spec['interval']): Bars {
  const stepMs = interval === '4h' ? DAY / 6 : DAY;
  const start = interval === '4h' ? Date.UTC(2020, 6, 1) : Date.UTC(2004, 0, 2);
  const count = interval === '4h' ? 2400 : 5400;

  let seed = 0;
  for (let i = 0; i < name.length; i++) seed = (seed * 31 + name.charCodeAt(i)) % 997;

  const t: number[] = [];
  const o: number[] = [];
  const h: number[] = [];
  const l: number[] = [];
  const c: number[] = [];
  const v: number[] = [];

  let curT = start;
  let price = 100 + (seed % 40);
  const isVix = name === '^VIX';
  const isYield = name === '^IRX' || name === 'fred:DGS3MO';
  const isCurve = name === 'fred:T10Y2Y';
  const isBreadth = name.includes('breadth');

  for (let i = 0; i < count; i++) {
    if (interval === '1d') {
      const dow = new Date(curT).getUTCDay();
      if (dow === 6) curT += 2 * DAY;
      else if (dow === 0) curT += DAY;
    }
    const phase = i / 180 + (seed % 17) * 0.23;
    const fast = Math.sin(i / 7 + seed * 0.1) * 0.014;
    const shock = i % 37 === seed % 37 ? -0.022 : i % 41 === (seed + 5) % 41 ? 0.02 : 0;
    const trend = Math.sin(phase) * 0.0022 + 0.00035;

    let open: number;
    let close: number;
    let high: number;
    let low: number;
    if (isVix) {
      close = 20 + Math.sin(i / 65) * 14 + Math.cos(i / 19) * 5;
      open = close * 0.99;
      high = close * 1.04;
      low = Math.max(9, close * 0.96);
    } else if (isYield) {
      close = Math.max(0.1, 3 + Math.sin(i / 300) * 2.5);
      open = close;
      high = close;
      low = close;
    } else if (isCurve) {
      close = 0.6 + Math.sin(i / 240) * 1.2;
      open = close;
      high = close;
      low = close;
    } else if (isBreadth) {
      close = 52 + Math.sin(i / 45) * 28;
      open = close;
      high = close;
      low = close;
    } else {
      const r = trend + fast + shock;
      open = price;
      close = Math.max(5, price * (1 + r));
      const spread = 0.008 + Math.abs(r) * 0.5;
      high = Math.max(open, close) * (1 + spread);
      low = Math.min(open, close) * (1 - spread);
      price = close;
    }

    t.push(curT);
    o.push(open);
    h.push(high);
    l.push(low);
    c.push(close);
    v.push(1_000_000 + ((i * 7919 + seed * 101) % 500_000));
    curT += stepMs;
  }

  return isBreadth ? { t, o, h, l, c, v, columns: [{ name: 'breadth', header: 'breadth', v: c }] } : { t, o, h, l, c, v };
}

test('every fenced block in the cookbook uses an expected language', () => {
  const allowed = new Set(['strategy', 'signal', 'regime', 'universe', 'compare', 'account', 'backtests', 'bash', 'sh', 'text']);
  const unexpected = blocks.filter((b) => !allowed.has(b.lang));
  assert.deepEqual(
    unexpected.map((b) => `${b.line}:${b.lang || '(none)'}`),
    [],
    'unexpected fence language in cookbook',
  );
});

test('every strategy block in the cookbook parses with zero errors/warnings and executes cleanly on synthetic data', async () => {
  const strategies = blocks.filter((b) => b.lang === 'strategy');
  assert.ok(strategies.length >= 20, `expected at least 20 strategy blocks, found ${strategies.length}`);
  const reader = cookbookVault();
  let dagResolvedCount = 0;

  for (const b of strategies) {
    let source = b.body;
    if (hasDagRefs(source)) {
      const resolved = await resolveStrategyDag(source, 'Cookbook.md', reader);
      assert.deepEqual(resolved.errors, [], `DAG resolution errors for strategy block on cookbook line ${b.line} ("${firstLine(b.body)}")`);
      assert.ok(resolved.dependencies.length > 0, `expected dependencies for DAG strategy block on cookbook line ${b.line}`);
      source = resolved.mergedSource;
      dagResolvedCount++;
    }
    const { spec, errors, warnings } = parseSpec(source);
    assert.deepEqual(errors, [], `parseSpec errors for strategy block on cookbook line ${b.line} ("${firstLine(b.body)}")`);
    assert.deepEqual(warnings, [], `parseSpec warnings for strategy block on cookbook line ${b.line} ("${firstLine(b.body)}")`);
    assert.ok(spec !== null, `expected non-null spec for strategy block on cookbook line ${b.line}`);

    // Execute every cookbook strategy against synthetic data so dead rules (e.g. unsatisfiable exits) are caught.
    const data = new Map<string, Bars>();
    const names = new Set<string>([
      ...spec.universe.map((a) => a.name),
      ...spec.extras.map((a) => a.name),
      ...(spec.benchmark ? [spec.benchmark.name] : []),
      ...(spec.cash.k === 'ticker' ? [spec.cash.ref.name] : []),
    ]);
    for (const name of names) {
      data.set(name, synthSeries(name, spec.interval));
    }
    const bt = runBacktest(spec, data);
    const closed = bt.run.trades.filter((tr) => tr.reason !== 'open');
    const isBuyAndHold = spec.name === '60/30/10 quarterly rebalanced';
    if (!isBuyAndHold) {
      assert.ok(closed.length >= 1, `strategy "${spec.name}" (line ${b.line}) produced 0 closed trades — check for dead entry/exit logic`);
    }
    if (spec.name === 'Long/short trend with ADX filter' || spec.name === 'QQQ/SPY z-score pairs') {
      assert.ok(
        bt.run.trades.some((tr) => tr.side === 'short'),
        `short strategy "${spec.name}" (line ${b.line}) never opened a short trade`,
      );
    }
    if (spec.name === '3-tranche trend pyramid') {
      assert.ok(
        bt.run.trades.some((tr) => (tr.entries?.length ?? 0) > 1),
        `scaling strategy "${spec.name}" (line ${b.line}) never triggered an add-on entry`,
      );
    }
  }
  assert.ok(dagResolvedCount >= 2, `expected at least 2 DAG-referenced strategy blocks, found ${dagResolvedCount}`);
});

test('every signal, regime, and universe block in the cookbook parses cleanly', () => {
  const signals = blocks.filter((b) => b.lang === 'signal');
  const regimes = blocks.filter((b) => b.lang === 'regime');
  const universes = blocks.filter((b) => b.lang === 'universe');

  assert.ok(signals.length >= 1, 'expected at least 1 signal block in the cookbook');
  assert.ok(regimes.length >= 1, 'expected at least 1 regime block in the cookbook');
  assert.ok(universes.length >= 1, 'expected at least 1 universe block in the cookbook');

  for (const b of signals) {
    const parsed = parseSignalBlock(b.body, 'signal');
    assert.ok(parsed.defaultExpr !== null && parsed.defaultExpr.length > 0, `signal block on cookbook line ${b.line} has no expression`);
    assert.ok(parsed.exports.size > 0, `signal block on cookbook line ${b.line} has no named exports`);
  }
  for (const b of regimes) {
    const parsed = parseSignalBlock(b.body, 'regime');
    assert.ok(parsed.defaultExpr !== null && parsed.defaultExpr.length > 0, `regime block on cookbook line ${b.line} has no expression`);
    assert.ok(parsed.exports.size > 0, `regime block on cookbook line ${b.line} has no named exports`);
  }
  for (const b of universes) {
    const parsed = parseUniverseBlock(b.body);
    assert.ok(parsed.tickers.length > 0, `universe block on cookbook line ${b.line} has no tickers`);
    const check = parseSpec(`universe: ${parsed.tickers}\nbuy when true`);
    assert.deepEqual(check.errors, [], `universe block on cookbook line ${b.line} produced invalid tickers: ${parsed.tickers}`);
  }
});

test('every compare, account, and backtests block parses with zero errors and resolves all wikilinks', () => {
  const compares = blocks.filter((b) => b.lang === 'compare');
  const accounts = blocks.filter((b) => b.lang === 'account');
  const dashboards = blocks.filter((b) => b.lang === 'backtests');
  const reader = cookbookVault();

  assert.ok(compares.length >= 1, 'expected at least 1 compare block in the cookbook');
  assert.ok(accounts.length >= 2, 'expected at least 2 account blocks in the cookbook');
  assert.ok(dashboards.length >= 1, 'expected at least 1 backtests block in the cookbook');

  for (const b of compares) {
    const parsed = parseCompare(b.body);
    assert.deepEqual(parsed.errors, [], `compare block on cookbook line ${b.line} ("${firstLine(b.body)}") has errors`);
    for (const entry of parsed.entries) {
      assert.ok(reader.resolve(entry.link, 'Cookbook.md') !== null, `compare target [[${entry.link}]] on line ${b.line} does not match any cookbook strategy`);
    }
  }
  let activeBookCount = 0;
  for (const b of accounts) {
    const parsed = parseAccount(b.body);
    assert.deepEqual(parsed.errors, [], `account block on cookbook line ${b.line} ("${firstLine(b.body)}") has errors`);
    if (parsed.config.activeBook) activeBookCount++;
    for (const entry of parsed.entries) {
      assert.ok(reader.resolve(entry.link, 'Cookbook.md') !== null, `account target [[${entry.link}]] on line ${b.line} does not match any cookbook strategy`);
    }
  }
  assert.ok(activeBookCount >= 2, 'expected both active-book account blocks to declare book: active');

  for (const b of dashboards) {
    const { errors } = parseDashboard(b.body);
    assert.deepEqual(errors, [], `backtests block on cookbook line ${b.line} ("${firstLine(b.body)}") has errors`);
  }
});

test('cookbook TOC anchors, relative links, CLI/explain examples, and style rules all hold', () => {
  const headings = new Set(
    [...cookbook.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => githubSlug(m[1])),
  );
  for (const m of cookbook.matchAll(/\[[^\]]+\]\(#([^)]+)\)/g)) {
    assert.ok(headings.has(m[1]), `broken TOC/internal anchor #${m[1]} in docs/cookbook.md`);
  }
  for (const m of cookbook.matchAll(/\[[^\]]+\]\(((?!https?:|#)[^)]+)\)/g)) {
    const target = new URL(m[1], new URL('../docs/cookbook.md', import.meta.url));
    assert.ok(existsSync(target), `broken relative link ${m[1]} in docs/cookbook.md`);
  }

  // Verify Recipe 26's explain keyword and CLI flags exist in the real codebase.
  assert.ok(docFor('risk per trade') !== null, 'docFor("risk per trade") must exist');
  const cliSource = readFileSync(new URL('../src/cli/main.ts', import.meta.url), 'utf8');
  for (const flag of ['block', 'fix', 'json', 'vault', 'refresh']) {
    assert.ok(cliSource.includes(flag), `CLI flag --${flag} referenced in Recipe 26 not found in src/cli/main.ts`);
  }

  const banned = [
    /\bload-bearing\b/i,
    /\bdead weight\b/i,
    /\bx-ray\b/i,
    /\badversarial\b/i,
    /\bthesis broken\b/i,
    /\bunlock\w*\b/i,
    /\bsupercharg\w*\b/i,
    /\bharness\w*\b/i,
    /\belevat\w*\b/i,
    /\bgame-changing\b/i,
    /\bseamless\w*\b/i,
    /\bdelv\w*\b/i,
  ];
  for (const re of banned) {
    assert.doesNotMatch(cookbook, re, `cookbook contains banned wording matching ${re}`);
  }
  assert.doesNotMatch(cookbook, /\/Users\/|\/home\/[a-z]|[A-Z]:\\Users/);
  assert.ok(!/coming soon|\bTODO\b/i.test(cookbook));

  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('docs/cookbook.md'), 'README.md must link to docs/cookbook.md');
});
