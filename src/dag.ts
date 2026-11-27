// Composable Strategy DAG & Structural Inheritance: resolves `extends: [[Parent]]`, `universe: [[Basket]]`, and
// `[[Note#Signal]]` references across `strategy`, `signal`, `regime`, and `universe` blocks, detects cycles, computes
// Merkle content hashes, tracks reverse dependencies for blast-radius diffs, and computes parent-vs-child trade diffs.
// Pure; knows nothing about Obsidian — the caller supplies a `VaultReader`.

import type { Backtest } from './backtest.ts';
import { blockName, fencedBlocks } from './blocks.ts';
import { commentAt, type Diagnostic } from './dsl.ts';
import { hash } from './result-cache.ts';

export type DagBlockKind = 'strategy' | 'signal' | 'regime' | 'universe';

/** Abstract vault access for both Obsidian and the CLI/MCP filesystem resolver. */
export interface VaultReader {
  /** Resolves a wikilink target (`Note` or `Folder/Note`) from `fromPath` to a canonical vault note path; null if not found. */
  resolve(link: string, fromPath: string): string | null;
  /** Reads the Markdown content of a resolved vault note path; null if unreadable. */
  read(path: string): Promise<string | null>;
}

/** A parsed `[[Note#Fragment]]` reference. */
export interface LinkRef {
  raw: string;
  link: string;
  fragment: string | null;
}

/** Parsed signal / regime block exports (named definitions or a single anonymous expression). */
export interface SignalBlock {
  kind: 'signal' | 'regime';
  name: string | null;
  /** Named exports (lowercased key -> { name, expr }), in declaration order. */
  exports: Map<string, { name: string; expr: string }>;
  /** Default expression: the lone anonymous expression, or the last named export. */
  defaultExpr: string | null;
  defaultName: string | null;
}

/** Parsed universe block: comma/newline-separated tickers with optional weights. */
export interface UniverseBlock {
  name: string | null;
  tickers: string;
}

/** Result of resolving a strategy block against its upstream DAG nodes. */
export interface ResolvedStrategy {
  /** Valid Backtest Blocks DSL with inheritance (`extends`/`base`), universes, and signal refs expanded. */
  mergedSource: string;
  /** Immediate parent's resolved source when `extends:` is used; null otherwise. */
  parentSource: string | null;
  parentName: string | null;
  parentKey: string | null;
  /** Top-most ancestor key in the `extends` chain for DSR family-root trial rollup. */
  rootFamilyKey: string;
  /** Canonical upstream node keys (`path#name`) in topological dependency order. */
  dependencies: string[];
  /** Merkle hash of this block's source combined with all upstream dependency content hashes. */
  contentHash: string;
  errors: Diagnostic[];
}

/** Quantitative diff between a parent strategy and a child strategy that `extends` it. */
export interface StrategyDiff {
  parentName: string;
  deltaCagr: number;
  /** Positive means the child reduced max drawdown (closer to 0). */
  deltaMaxDD: number;
  deltaSharpe: number;
  deltaExposure: number;
  tradesAdded: number;
  tradesRemoved: number;
  /** Parent losing trades that the child avoided. */
  losingTradesAvoided: number;
  /** Parent winning trades that the child dropped. */
  winningTradesRemoved: number;
  /** Entry timestamps of trades that differ between parent and child. */
  diffTimes: number[];
}

const WIKILINK = /\[\[([^[\]]+)\]\]/g;
const EXTENDS_LINE = /^\s*extends\s*:\s*(.+?)\s*$/i;
const RULE_HEAD = /^(\s*)(buy|sell|add|short|cover)\s+when\b(.*)$/i;
const SETTING_KEY = /^(\s*)([A-Za-z]+(?: +[A-Za-z]+)*)\s*:(.*)$/;
const DEF_LINE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*(.*)$/;

/** Fast O(1) check for whether a strategy block uses any DAG features (`extends:` or `[[...]]`). */
export function hasDagRefs(source: string): boolean {
  return source.includes('[[') || /^\s*extends\s*:/im.test(source);
}

/** Parses `[[Note]]`, `[[Note#Export]]`, or `[[Note#Export|Alias]]`. */
export function parseWikilink(raw: string): LinkRef | null {
  const m = raw.trim().match(/^\[\[([^[\]]+)\]\]$/);
  if (!m) return null;
  const inner = m[1].split('|')[0].trim();
  if (!inner) return null;
  const hashIdx = inner.indexOf('#');
  const link = (hashIdx < 0 ? inner : inner.slice(0, hashIdx)).trim();
  const fragment = hashIdx < 0 ? null : inner.slice(hashIdx + 1).trim() || null;
  return link ? { raw: m[0], link, fragment } : null;
}

/** Extracts all `[[...]]` references from a text block, ignoring comments. */
export function findWikilinks(source: string): LinkRef[] {
  const out: LinkRef[] = [];
  for (const rawLine of source.split('\n')) {
    const c = commentAt(rawLine);
    const code = c < 0 ? rawLine : rawLine.slice(0, c);
    for (const m of code.matchAll(WIKILINK)) {
      const parsed = parseWikilink(m[0]);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

/** Parses a `signal` or `regime` code block into its named exports and default expression. */
export function parseSignalBlock(source: string, kind: 'signal' | 'regime' = 'signal'): SignalBlock {
  const exports = new Map<string, { name: string; expr: string }>();
  let name: string | null = null;
  let openKey: string | null = null;
  const anon: string[] = [];

  for (const rawLine of source.split('\n')) {
    const raw = rawLine.replace(/\r$/, '');
    const c = commentAt(raw);
    const code = (c < 0 ? raw : raw.slice(0, c)).trim();
    if (!code || code.startsWith('~')) {
      openKey = null;
      continue;
    }
    const nm = code.match(/^name\s*:\s*(.+)$/i);
    if (nm) {
      name = nm[1].trim();
      openKey = null;
      continue;
    }
    // Skip optional metadata lines like `from:` or `description:`
    if (/^(from|to|data|interval|description)\s*:/i.test(code)) {
      openKey = null;
      continue;
    }
    const dm = code.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*(.+)$/);
    if (dm) {
      const key = dm[1].toLowerCase();
      exports.set(key, { name: dm[1], expr: dm[2].trim() });
      openKey = key;
      continue;
    }
    if (openKey && /^(and|or)\b/i.test(code)) {
      const prev = exports.get(openKey)!;
      prev.expr = `${prev.expr} ${code}`;
      continue;
    }
    openKey = null;
    anon.push(code);
  }
  const last = [...exports.values()].pop();
  return {
    kind,
    name,
    exports,
    defaultExpr: anon.length > 0 ? anon.join(' ') : (last?.expr ?? null),
    defaultName: anon.length > 0 ? null : (last?.name ?? null),
  };
}

/** Parses a `universe` code block into a single comma-separated ticker list suitable for `universe:`. */
export function parseUniverseBlock(source: string): UniverseBlock {
  let name: string | null = null;
  const items: string[] = [];
  for (const rawLine of source.split('\n')) {
    const raw = rawLine.replace(/\r$/, '');
    const c = commentAt(raw);
    const code = (c < 0 ? raw : raw.slice(0, c)).trim();
    if (!code || code.startsWith('~')) continue;
    const nm = code.match(/^name\s*:\s*(.+)$/i);
    if (nm) {
      name = nm[1].trim();
      continue;
    }
    const um = code.match(/^(?:universe|tickers)\s*:\s*(.+)$/i);
    const body = um ? um[1] : code;
    for (const part of body.split(',')) {
      const t = part.trim();
      if (t) items.push(t);
    }
  }
  return { name, tickers: items.join(', ') };
}

/** Canonical node key for a block in a note. */
export const dagNodeKey = (notePath: string, name: string | null, kind: DagBlockKind = 'strategy'): string =>
  `${notePath}#${kind}:${(name ?? '').toLowerCase()}`;

interface ParsedParts {
  settings: Map<string, string>; // lower key -> full line
  paramsAndDefs: Map<string, string[]>; // lower name -> lines (including continuations)
  rules: Map<string, { head: string; body: string }>; // "scope|side" -> rule
  invalidate: string[];
  extendsRaw: string | null;
  extendsLine: number;
  otherLines: string[];
}

/** Splits a strategy block into mergeable sections for `extends:` inheritance. */
function splitStrategy(source: string): ParsedParts {
  const settings = new Map<string, string>();
  const paramsAndDefs = new Map<string, string[]>();
  const rules = new Map<string, { head: string; body: string }>();
  const invalidate: string[] = [];
  const otherLines: string[] = [];
  let extendsRaw: string | null = null;
  let extendsLine = 1;
  let scope = 'all';
  let openRuleKey: string | null = null;
  let openDefKey: string | null = null;
  let inInvalidate = false;

  const lines = source.split('\n');
  lines.forEach((rawLine, idx) => {
    const raw = rawLine.replace(/\r$/, '');
    const c = commentAt(raw);
    const stripped = (c < 0 ? raw : raw.slice(0, Math.max(0, c - 1))).trim();
    if (!stripped) {
      openRuleKey = null;
      openDefKey = null;
      inInvalidate = false;
      return;
    }
    if (stripped.startsWith('~')) {
      // Muted lines stay verbatim on the child only.
      otherLines.push(raw);
      return;
    }
    const em = stripped.match(EXTENDS_LINE);
    if (em) {
      extendsRaw = em[1].trim();
      extendsLine = idx + 1;
      openRuleKey = null;
      openDefKey = null;
      inInvalidate = false;
      return;
    }
    if (/^for\s+.+:$/i.test(stripped)) {
      const rawScope = stripped.slice(4, -1).trim();
      scope = /^all$/i.test(rawScope) ? 'all' : rawScope || 'all';
      openRuleKey = null;
      openDefKey = null;
      inInvalidate = false;
      return;
    }
    if (/^invalidate\s+when\b/i.test(stripped)) {
      invalidate.push(raw);
      inInvalidate = true;
      openRuleKey = null;
      openDefKey = null;
      return;
    }
    if (inInvalidate && /^(and|or)\b/i.test(stripped)) {
      invalidate.push(raw);
      return;
    }
    inInvalidate = false;
    const rm = raw.match(RULE_HEAD);
    if (rm) {
      const side = rm[2].toLowerCase();
      const key = `${scope}|${side}`;
      const body = (c < 0 ? rm[3] : rm[3].slice(0, Math.max(0, c - (raw.length - rm[3].length)))).trim();
      rules.set(key, { head: `${rm[2]} when`, body });
      openRuleKey = key;
      openDefKey = null;
      return;
    }
    if (openRuleKey && /^(and|or)\b/i.test(stripped)) {
      const prev = rules.get(openRuleKey)!;
      prev.body = prev.body ? `${prev.body}\n  ${stripped}` : stripped;
      return;
    }
    const sm = raw.match(SETTING_KEY);
    if (sm && !/^(buy|sell|add|short|cover|for|invalidate)$/i.test(sm[2].trim())) {
      const key = sm[2].toLowerCase().replace(/\s+/g, ' ').replace(/^symbol$/, 'universe');
      const scopedKey = scope === 'all' ? key : `${scope}|${key}`;
      settings.set(scopedKey, `${key}: ${(c < 0 ? sm[3] : raw.slice(raw.indexOf(':') + 1, c)).trim()}`);
      openRuleKey = null;
      openDefKey = null;
      return;
    }
    const dm = raw.match(DEF_LINE);
    if (dm) {
      const key = dm[2].toLowerCase();
      paramsAndDefs.set(key, [c < 0 ? raw : raw.slice(0, c).trimEnd()]);
      openDefKey = key;
      openRuleKey = null;
      return;
    }
    if (openRuleKey) {
      const prev = rules.get(openRuleKey)!;
      prev.body = prev.body ? `${prev.body}\n  ${stripped}` : stripped;
      return;
    }
    if (openDefKey) {
      paramsAndDefs.get(openDefKey)!.push(c < 0 ? raw : raw.slice(0, c).trimEnd());
      return;
    }
    otherLines.push(raw);
  });

  return { settings, paramsAndDefs, rules, invalidate, extendsRaw, extendsLine, otherLines };
}

/** Merges parent and child strategy sections; replaces standalone `base` in child rules with the parent's rule body. */
function mergeParts(parent: ParsedParts, child: ParsedParts): string {
  const out: string[] = [];
  const mergedSettings = new Map(parent.settings);
  // A child strategy starts as its own research draft; do not inherit the parent's deployment pin.
  mergedSettings.delete('live since');
  for (const [k, v] of child.settings) mergedSettings.set(k, v);
  // Global settings first (keys without "|")
  for (const [k, v] of mergedSettings) if (!k.includes('|')) out.push(v);

  const mergedDecls = new Map(parent.paramsAndDefs);
  for (const [k, v] of child.paramsAndDefs) mergedDecls.set(k, v);
  for (const lines of mergedDecls.values()) out.push(...lines);

  const mergedRules = new Map(parent.rules);
  for (const [k, v] of child.rules) {
    const parentRule = parent.rules.get(k);
    let body = v.body;
    if (/\bbase\b/i.test(body)) {
      const side = k.slice(k.indexOf('|') + 1);
      const fallback = side === 'sell' || side === 'cover' ? 'false' : 'true';
      const baseExpr = parentRule ? `(${parentRule.body.replace(/\s*\n\s*/g, ' ')})` : fallback;
      body = body.replace(/\bbase\b/gi, baseExpr);
    }
    mergedRules.set(k, { head: v.head, body });
  }
  // Shared ("all") rules first, followed by global muted/other lines BEFORE per-ticker `for` sections.
  for (const [k, v] of mergedRules) {
    if (k.startsWith('all|')) out.push(`${v.head} ${v.body}`);
  }
  for (const line of child.otherLines) out.push(line);
  // Per-ticker scoped sections (`for TICKER:`)
  const scopes = new Set<string>();
  for (const k of [...mergedSettings.keys(), ...mergedRules.keys()]) {
    if (k.includes('|') && !k.startsWith('all|')) scopes.add(k.slice(0, k.indexOf('|')));
  }
  for (const sc of scopes) {
    out.push(`for ${sc}:`);
    for (const [k, v] of mergedSettings) if (k.startsWith(`${sc}|`)) out.push(`  ${v}`);
    for (const [k, v] of mergedRules) if (k.startsWith(`${sc}|`)) out.push(`  ${v.head} ${v.body}`);
  }
  const inv = child.invalidate.length > 0 ? child.invalidate : parent.invalidate;
  if (inv.length > 0) out.push(...inv);
  return out.join('\n');
}

/** Finds a named (or first) fenced block of any of `langs` in a note. */
function findBlockInNote(markdown: string, fragment: string | null, langs: DagBlockKind[]): { kind: DagBlockKind; source: string; name: string | null } | null {
  const wanted = fragment?.toLowerCase() ?? null;
  let first: { kind: DagBlockKind; source: string; name: string | null } | null = null;
  for (const kind of langs) {
    for (const b of fencedBlocks(markdown, kind)) {
      const name = blockName(b.source);
      const item = { kind, source: b.source, name };
      if (!first) first = item;
      if (wanted !== null && name?.toLowerCase() === wanted) return item;
    }
  }
  // If a fragment names an export inside a signal/regime block, return the first signal/regime block that declares it.
  if (wanted !== null) {
    for (const kind of langs) {
      if (kind !== 'signal' && kind !== 'regime') continue;
      for (const b of fencedBlocks(markdown, kind)) {
        const parsed = parseSignalBlock(b.source, kind);
        if (parsed.exports.has(wanted)) return { kind, source: b.source, name: parsed.name };
      }
    }
  }
  return wanted === null ? first : null;
}

/**
 * Resolves a strategy block's `extends:`, `universe: [[...]]`, and `[[Note#Signal]]` references across the vault.
 * Detects cycles and missing links cleanly without throwing.
 */
export async function resolveStrategyDag(source: string, notePath: string, reader: VaultReader): Promise<ResolvedStrategy> {
  const selfName = blockName(source);
  const selfKey = dagNodeKey(notePath, selfName, 'strategy');
  if (!hasDagRefs(source)) {
    return {
      mergedSource: source,
      parentSource: null,
      parentName: null,
      parentKey: null,
      rootFamilyKey: selfKey,
      dependencies: [],
      contentHash: hash(source).toString(36),
      errors: [],
    };
  }

  const errors: Diagnostic[] = [];
  const deps = new Set<string>();
  const depHashes: string[] = [];
  let syntheticCounter = 0;

  /** Recursively expands `[[Note#Export]]` signal/regime refs inside an expression string. */
  const expandSignalRefs = async (
    text: string,
    fromPath: string,
    stack: string[],
    injectedDefs: string[],
    lineNum: number,
  ): Promise<string> => {
    let out = text;
    const refs = findWikilinks(text);
    for (const ref of refs) {
      const targetPath = reader.resolve(ref.link, fromPath);
      if (!targetPath) {
        errors.push({ line: lineNum, message: `Cannot find note "${ref.link}" referenced by ${ref.raw}` });
        continue;
      }
      const md = await reader.read(targetPath);
      if (md === null) {
        errors.push({ line: lineNum, message: `Cannot read note "${targetPath}" referenced by ${ref.raw}` });
        continue;
      }
      const block = findBlockInNote(md, ref.fragment, ['regime', 'signal']);
      if (!block) {
        errors.push({ line: lineNum, message: `"${ref.link}" has no signal or regime block${ref.fragment ? ` named "${ref.fragment}"` : ''}` });
        continue;
      }
      const nodeKey = dagNodeKey(targetPath, block.name, block.kind);
      if (stack.includes(nodeKey)) {
        errors.push({ line: lineNum, message: `Cycle detected: ${[...stack, nodeKey].join(' -> ')}` });
        continue;
      }
      deps.add(nodeKey);
      depHashes.push(`${nodeKey}:${hash(block.source).toString(36)}`);
      const parsed = parseSignalBlock(block.source, block.kind as 'signal' | 'regime');
      const wantedKey = ref.fragment?.toLowerCase();
      const chosen = wantedKey && parsed.exports.has(wantedKey) ? parsed.exports.get(wantedKey)!.expr : parsed.defaultExpr;
      if (!chosen) {
        errors.push({ line: lineNum, message: `${ref.raw} has no expression to export` });
        continue;
      }
      // Inline only the requested export and its transitive local dependencies so unused exports don't emit warnings.
      const prefix = `__dag${++syntheticCounter}_`;
      const renameMap = new Map<string, string>();
      for (const [k, exp] of parsed.exports) {
        renameMap.set(k, `${prefix}${exp.name}`);
      }
      // Rewrite local identifier references while skipping `[[...]]`, `column("...")`, and tokens immediately after `of `.
      const rewriteLocal = (expr: string): string => {
        if (renameMap.size === 0) return expr;
        const segments: { text: string; protected: boolean }[] = [];
        const protectRe = /\[\[[^[\]]+\]\]|\bcolumn\s*\(\s*"[^"]*"\s*\)|\bof\s+[A-Za-z0-9^:/._=-]+/gi;
        let last = 0;
        for (const m of expr.matchAll(protectRe)) {
          if (m.index! > last) segments.push({ text: expr.slice(last, m.index!), protected: false });
          segments.push({ text: m[0], protected: true });
          last = m.index! + m[0].length;
        }
        if (last < expr.length) segments.push({ text: expr.slice(last), protected: false });
        return segments
          .map((seg) => {
            if (seg.protected) return seg.text;
            let res = seg.text;
            for (const [k, renamed] of renameMap) {
              res = res.replace(new RegExp(`\\b${k}\\b`, 'gi'), renamed);
            }
            return res;
          })
          .join('');
      };
      // Determine needed exports transitively from the root expression/export.
      const rootKey = wantedKey && parsed.exports.has(wantedKey) ? wantedKey : parsed.defaultName?.toLowerCase() ?? null;
      const needed = new Set<string>();
      const collectNeeded = (expr: string) => {
        const cleaned = expr.replace(/\[\[[^[\]]+\]\]|\bcolumn\s*\(\s*"[^"]*"\s*\)|\bof\s+[A-Za-z0-9^:/._=-]+/gi, ' ');
        for (const [k, exp] of parsed.exports) {
          if (needed.has(k)) continue;
          if (new RegExp(`\\b${k}\\b`, 'i').test(cleaned)) {
            needed.add(k);
            collectNeeded(exp.expr);
          }
        }
      };
      if (rootKey) {
        needed.add(rootKey);
        collectNeeded(parsed.exports.get(rootKey)!.expr);
      } else {
        collectNeeded(chosen);
      }
      // Expand nested wikilinks BEFORE rewriting local refs on each needed export, preserving declaration order.
      for (const [k, exp] of parsed.exports) {
        if (!needed.has(k)) continue;
        const withNested = await expandSignalRefs(exp.expr, targetPath, [...stack, nodeKey], injectedDefs, lineNum);
        injectedDefs.push(`${renameMap.get(k)!} = ${rewriteLocal(withNested)}`);
      }
      const targetExpr =
        rootKey && renameMap.has(rootKey)
          ? renameMap.get(rootKey)!
          : `(${rewriteLocal(await expandSignalRefs(chosen, targetPath, [...stack, nodeKey], injectedDefs, lineNum))})`;
      out = out.split(ref.raw).join(targetExpr);
    }
    return out;
  };

  /** Expands `universe: [[Basket]]` references. */
  const expandUniverseRefs = async (src: string, fromPath: string): Promise<string> => {
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*(?:universe|symbol)\s*:\s*)(.+)$/i);
      if (!m || !m[2].includes('[[')) continue;
      let val = m[2];
      for (const ref of findWikilinks(val)) {
        const targetPath = reader.resolve(ref.link, fromPath);
        if (!targetPath) {
          errors.push({ line: i + 1, message: `Cannot find universe note "${ref.link}"` });
          continue;
        }
        const md = await reader.read(targetPath);
        const block = md ? findBlockInNote(md, ref.fragment, ['universe']) : null;
        if (!block) {
          errors.push({ line: i + 1, message: `"${ref.link}" has no universe block${ref.fragment ? ` named "${ref.fragment}"` : ''}` });
          continue;
        }
        const nodeKey = dagNodeKey(targetPath, block.name, 'universe');
        deps.add(nodeKey);
        depHashes.push(`${nodeKey}:${hash(block.source).toString(36)}`);
        const u = parseUniverseBlock(block.source);
        if (!u.tickers) errors.push({ line: i + 1, message: `Universe block in "${ref.link}" has no tickers` });
        else val = val.split(ref.raw).join(u.tickers);
      }
      lines[i] = `${m[1]}${val}`;
    }
    return lines.join('\n');
  };

  /** Recursively resolves `extends:` chain. */
  const resolveChain = async (
    src: string,
    path: string,
    stack: string[],
  ): Promise<{ merged: string; parentSource: string | null; parentName: string | null; parentKey: string | null; rootFamilyKey: string }> => {
    const nodeName = blockName(src);
    const nodeKey = dagNodeKey(path, nodeName, 'strategy');
    const parts = splitStrategy(src);
    if (!parts.extendsRaw) {
      return { merged: src, parentSource: null, parentName: null, parentKey: null, rootFamilyKey: nodeKey };
    }
    const linkRef = parseWikilink(parts.extendsRaw);
    if (!linkRef) {
      errors.push({ line: parts.extendsLine, message: `Write extends as a wikilink, for example extends: [[Trend Core]]` });
      return { merged: src, parentSource: null, parentName: null, parentKey: null, rootFamilyKey: nodeKey };
    }
    const targetPath = reader.resolve(linkRef.link, path);
    if (!targetPath) {
      errors.push({ line: parts.extendsLine, message: `Cannot find parent strategy note "${linkRef.link}"` });
      return { merged: src, parentSource: null, parentName: null, parentKey: null, rootFamilyKey: nodeKey };
    }
    const md = await reader.read(targetPath);
    const parentBlock = md ? findBlockInNote(md, linkRef.fragment, ['strategy']) : null;
    if (!parentBlock) {
      errors.push({ line: parts.extendsLine, message: `"${linkRef.link}" has no strategy block${linkRef.fragment ? ` named "${linkRef.fragment}"` : ''}` });
      return { merged: src, parentSource: null, parentName: null, parentKey: null, rootFamilyKey: nodeKey };
    }
    const parentKey = dagNodeKey(targetPath, parentBlock.name, 'strategy');
    if (stack.includes(parentKey)) {
      errors.push({ line: parts.extendsLine, message: `Inheritance cycle detected: ${[...stack, parentKey].join(' -> ')}` });
      return { merged: src, parentSource: null, parentName: null, parentKey: null, rootFamilyKey: nodeKey };
    }
    deps.add(parentKey);
    depHashes.push(`${parentKey}:${hash(parentBlock.source).toString(36)}`);
    const ancestor = await resolveChain(parentBlock.source, targetPath, [...stack, parentKey]);
    const parentResolved = await finalizeRefs(ancestor.merged, targetPath, [...stack, parentKey]);
    const merged = mergeParts(splitStrategy(parentResolved), parts);
    return {
      merged,
      parentSource: parentResolved,
      parentName: parentBlock.name ?? linkRef.link,
      parentKey,
      rootFamilyKey: ancestor.rootFamilyKey,
    };
  };

  const finalizeRefs = async (src: string, fromPath: string, stack: string[]): Promise<string> => {
    const withUniverse = await expandUniverseRefs(src, fromPath);
    const injectedDefs: string[] = [];
    const lines = withUniverse.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('[[')) continue;
      if (lines[i].trimStart().startsWith('~')) continue;
      if (/^\s*(?:extends|name|universe|symbol)\s*:/i.test(lines[i])) continue;
      lines[i] = await expandSignalRefs(lines[i], fromPath, stack, injectedDefs, i + 1);
    }
    if (injectedDefs.length === 0) return lines.join('\n');
    // Insert synthetic definitions before the first rule so they are in scope everywhere.
    const ruleIdx = lines.findIndex((l) => /^\s*(?:buy|sell|add|short|cover|for)\b/i.test(l.trim()));
    if (ruleIdx < 0) return [...lines, ...injectedDefs].join('\n');
    return [...lines.slice(0, ruleIdx), ...injectedDefs, ...lines.slice(ruleIdx)].join('\n');
  };

  const chain = await resolveChain(source, notePath, [selfKey]);
  const mergedSource = await finalizeRefs(chain.merged, notePath, [selfKey]);
  const contentHash = hash(`${source}\u0000${depHashes.sort().join('|')}`).toString(36);
  return {
    mergedSource,
    parentSource: chain.parentSource,
    parentName: chain.parentName,
    parentKey: chain.parentKey,
    rootFamilyKey: chain.rootFamilyKey,
    dependencies: [...deps],
    contentHash,
    errors,
  };
}

/** Computes exact marginal performance & trade set-diffs between a parent strategy and an inherited child strategy. */
export function diffBacktests(parent: Backtest, child: Backtest, parentName = parent.spec.name ?? 'Parent'): StrategyDiff {
  const keyOf = (t: { asset: string; entryT: number; side?: 'short' }) => `${t.asset}:${t.side ?? 'long'}:${t.entryT}`;
  const parentTrades = new Map(parent.run.trades.map((t) => [keyOf(t), t]));
  const childTrades = new Map(child.run.trades.map((t) => [keyOf(t), t]));
  let tradesAdded = 0;
  let tradesRemoved = 0;
  let losingTradesAvoided = 0;
  let winningTradesRemoved = 0;
  const diffTimes: number[] = [];

  for (const [k, t] of parentTrades) {
    if (!childTrades.has(k)) {
      tradesRemoved++;
      diffTimes.push(t.entryT);
      if (t.ret < 0) losingTradesAvoided++;
      else if (t.ret > 0) winningTradesRemoved++;
    }
  }
  for (const [k, t] of childTrades) {
    if (!parentTrades.has(k)) {
      tradesAdded++;
      diffTimes.push(t.entryT);
    }
  }
  diffTimes.sort((a, b) => a - b);

  return {
    parentName,
    deltaCagr: child.stats.cagr - parent.stats.cagr,
    // Drawdowns are negative (e.g. -0.15 vs -0.25): child - parent = +0.10 means 10 pts smaller drawdown.
    deltaMaxDD: child.stats.maxDrawdown - parent.stats.maxDrawdown,
    deltaSharpe: child.stats.sharpe - parent.stats.sharpe,
    deltaExposure: child.stats.exposure - parent.stats.exposure,
    tradesAdded,
    tradesRemoved,
    losingTradesAvoided,
    winningTradesRemoved,
    diffTimes,
  };
}
