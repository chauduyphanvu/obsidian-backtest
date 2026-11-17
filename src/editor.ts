import { Facet, StateEffect, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, hoverTooltip, type DecorationSet, type Tooltip, type ViewUpdate } from '@codemirror/view';
import { EditorSuggest, type App, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo } from 'obsidian';
import { closesFence, fenceOf, findBlocks } from './blocks.ts';
import { complete, hitCompletions, localTickers, tickerPosition, writtenTickers, type Completion } from './complete.ts';
import { analyzeBlock, fixForDiagnostic, unknownTickers, type BlockAnalysis, type BlockDiagnostic } from './diagnostics.ts';
import { helpAt, type Doc } from './docs.ts';
import type { Defaults } from './dsl.ts';
import { fixChanges, type Fix } from './fixes.ts';
import { lineKinds, TICKER_SETTINGS, type TokenKind } from './highlight.ts';
import { ResultCache } from './result-cache.ts';
import { blockSource, blockTickers, type SymbolLookup, type TickerRef } from './symbols.ts';

const KINDS: Record<TokenKind, true> = { key: true, keyword: true, function: true, series: true, number: true, ticker: true, value: true, operator: true, comment: true, param: true };
const TOKEN_MARKS = Object.fromEntries(Object.keys(KINDS).map((k) => [k, Decoration.mark({ class: `bt-tok bt-tok-${k}` })])) as Record<TokenKind, Decoration>;

/** A block on screen with what was read from it. */
interface Shown {
  /** 0-based line of the block's first content line in the note. */
  first: number;
  lines: string[];
  analysis: BlockAnalysis;
  defaults: Partial<Defaults>;
  /** The tickers the block names, read when first needed. */
  refs?: TickerRef[];
}

/** A problem placed in the note, for the tooltip and the fix. */
interface Problem {
  from: number;
  to: number;
  severity: BlockDiagnostic['severity'];
  message: string;
  block: Shown;
  diagnostic: BlockDiagnostic;
}

/** What the pointer is over that has help, in note positions. */
interface Help {
  from: number;
  to: number;
  doc: Doc;
}

/** A change to the note, ready to dispatch: one or more edits that are made together, in the note as it is now. */
interface Change {
  edits: { from: number; to: number; insert: string }[];
  label: string;
}

const PREFIX = { error: 'Problem: ', warning: 'Note: ' };

/** Blocks read at once on screen; older readings of a block fall out as it is edited. */
const CACHED_BLOCKS = 64;
/** How long after typing stops the tickers on screen are checked. */
const CHECK_DELAY_MS = 700;
/** Tickers checked in one go. */
const CHECKS_AT_ONCE = 6;
/** How long after typing stops a ticker suggestion asks for hits. */
const SUGGEST_DELAY_MS = 250;

export interface EditorOptions {
  /** The ticker lookup, or null while the setting for it is off. Read each time, so the setting takes effect at once. */
  lookup?: () => SymbolLookup | null;
}

/** Marks that a lookup answered, so the underlines are drawn again. */
const lookupAnswered = StateEffect.define<null>();

class StrategyView {
  tokens: DecorationSet = Decoration.none;
  problems: DecorationSet = Decoration.none;
  hits: Problem[] = [];
  private shown: Shown[] = [];
  /** Underlines for what the parser reported; the ones for unknown tickers are added to these. */
  private parsed: Range<Decoration>[] = [];
  private parsedHits: Problem[] = [];
  private cache: ResultCache<BlockAnalysis>;
  private getDefaults: () => Partial<Defaults>;
  private getLookup: () => SymbolLookup | null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dead = false;
  private wanted: { ticker: string; source: 'yahoo' | 'binance' }[] = [];
  private view: EditorView;

  constructor(view: EditorView, cache: ResultCache<BlockAnalysis>, getDefaults: () => Partial<Defaults>, getLookup: () => SymbolLookup | null) {
    this.view = view;
    this.cache = cache;
    this.getDefaults = getDefaults;
    this.getLookup = getLookup;
    this.build(view);
  }

  update(u: ViewUpdate): void {
    if (u.docChanged || u.viewportChanged) this.build(u.view);
    else if (u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(lookupAnswered)))) this.markTickers(u.view);
  }

  destroy(): void {
    this.dead = true;
    clearTimeout(this.timer);
  }

  /**
   * Colours and underlines for the strategy blocks on screen. A block is read again only when its
   * text (or the defaults) changed. The marks are collected unsorted and sorted by the set, so
   * neither the token order nor the order of blocks can break the "ascending from" rule.
   */
  private build(view: EditorView): void {
    const doc = view.state.doc;
    const firstShown = doc.lineAt(view.viewport.from).number - 1;
    const lastShown = doc.lineAt(view.viewport.to).number - 1;
    const defaults = this.getDefaults();
    const salt = JSON.stringify(defaults) + '\n';
    const tokens: Range<Decoration>[] = [];
    const parsed: Range<Decoration>[] = [];
    const hits: Problem[] = [];
    this.shown = [];

    for (const block of findBlocks(doc.iterLines(), lastShown)) {
      if (block.last < block.first || block.last < firstShown || block.first > lastShown) continue;
      const lines = Array.from(doc.iterLines(block.first + 1, block.last + 2));
      const key = salt + lines.join('\n');
      let analysis = this.cache.get(key);
      if (!analysis) {
        analysis = analyzeBlock(lines, defaults);
        this.cache.set(key, analysis);
      }
      const here: Shown = { first: block.first, lines, analysis, defaults };
      this.shown.push(here);
      const shownFrom = Math.max(block.first, firstShown);
      const shownTo = Math.min(block.last, lastShown);
      for (let n = shownFrom; n <= shownTo; n++) {
        const start = doc.line(n + 1).from;
        for (const t of analysis.tokens[n - block.first]) tokens.push(TOKEN_MARKS[t.kind].range(start + t.from, start + t.to));
      }
      for (const d of analysis.diagnostics) {
        const n = block.first + d.line;
        if (n < shownFrom || n > shownTo) continue;
        this.place(doc.line(n + 1).from, d, here, parsed, hits);
      }
    }
    this.tokens = Decoration.set(tokens, true);
    this.parsed = parsed;
    this.parsedHits = hits;
    this.markTickers(view);
  }

  private place(lineStart: number, d: BlockDiagnostic, block: Shown, marks: Range<Decoration>[], hits: Problem[]): void {
    const mark = Decoration.mark({ class: `bt-diag bt-diag-${d.severity}`, attributes: { title: PREFIX[d.severity] + d.message } });
    marks.push(mark.range(lineStart + d.from, lineStart + d.to));
    hits.push({ from: lineStart + d.from, to: lineStart + d.to, severity: d.severity, message: d.message, block, diagnostic: d });
  }

  /**
   * Adds the underlines for tickers the lookup knows their source does not have, and works out which
   * tickers on screen have yet to be asked about. A ticker the cursor is in is left alone: it is
   * probably still being typed.
   */
  private markTickers(view: EditorView): void {
    const lookup = this.getLookup();
    const marks = [...this.parsed];
    const hits = [...this.parsedHits];
    const wanted: { ticker: string; source: 'yahoo' | 'binance' }[] = [];
    if (lookup) {
      const doc = view.state.doc;
      const head = view.state.selection.main.head;
      const firstShown = doc.lineAt(view.viewport.from).number - 1;
      const lastShown = doc.lineAt(view.viewport.to).number - 1;
      for (const block of this.shown) {
        const absolute = (line: number) => doc.line(block.first + line + 1).from;
        const refs = (block.refs ??= blockTickers(block.lines, block.defaults)).filter((r) => {
          const line = block.first + r.line;
          const typing = head >= absolute(r.line) + r.from && head <= absolute(r.line) + r.to;
          return line >= firstShown && line <= lastShown && !typing;
        });
        for (const d of unknownTickers(refs, lookup)) this.place(absolute(d.line), d, block, marks, hits);
        for (const r of refs) {
          if (lookup.peek(r.ticker, r.source) === null && !wanted.some((w) => w.ticker === r.ticker && w.source === r.source)) wanted.push(r);
        }
      }
    }
    this.problems = Decoration.set(marks, true);
    this.hits = hits;
    this.wanted = wanted;
    this.schedule();
  }

  /** Asks about the tickers on screen a moment after the last change. */
  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.wanted.length) return;
    this.timer = setTimeout(() => void this.ask(), CHECK_DELAY_MS);
  }

  private async ask(): Promise<void> {
    const lookup = this.getLookup();
    if (!lookup || this.dead) return;
    for (const w of this.wanted.slice(0, CHECKS_AT_ONCE)) {
      const verdict = await lookup.check(w.ticker, w.source);
      if (this.dead) return;
      // An "unsure" answer changes nothing on screen, and the lookup does not ask again for a while.
      if (verdict !== 'unsure') this.view.dispatch({ effects: lookupAnswered.of(null) });
    }
  }

  blockAt(line: number): Shown | undefined {
    return this.shown.find((b) => line >= b.first && line < b.first + b.lines.length);
  }
}

/** The change a fix makes to the note, from its place in a block. */
function changeFor(view: EditorView, block: Shown, fix: Fix): Change | null {
  const { doc } = view.state;
  const edits = fixChanges(fix, (line) => {
    const n = block.first + line;
    return n < 1 || n > doc.lines ? null : doc.line(n).from;
  });
  return edits && { edits, label: fix.label };
}

interface Handle {
  /** The fix for the problem at `pos`, or on its line when none covers it. */
  fixAt(view: EditorView, pos: number): Change | null;
}

/** Lets `applyFixAtCursor` reach the extension installed in a view. */
const handles = Facet.define<Handle, Handle | null>({ combine: (all) => all[0] ?? null });

/** Applies the fix for the problem at the cursor, with a normal edit that can be undone. Returns whether there was one. */
export function applyFixAtCursor(view: EditorView): boolean {
  const change = view.state.facet(handles)?.fixAt(view, view.state.selection.main.head);
  if (!change) return false;
  view.dispatch({ changes: change.edits, userEvent: 'input.fix' });
  return true;
}

const element = (doc: Document, tag: string, cls: string, text?: string): HTMLElement => {
  const el = doc.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

function tooltipFor(view: EditorView, hits: Problem[], help: Help | null, fixOf: (p: Problem) => Change | null): Tooltip {
  const from = Math.min(...hits.map((h) => h.from), help?.from ?? Infinity);
  const to = Math.max(...hits.map((h) => h.to), help?.to ?? -Infinity);
  return {
    pos: from,
    end: to,
    above: true,
    create() {
      const doc = view.dom.ownerDocument;
      const dom = element(doc, 'div', 'bt-diag-tip');
      // Narrow panes are common, and the tooltip should not be wider than the editor it is in.
      dom.style.maxWidth = `${Math.max(160, Math.min(420, view.dom.clientWidth - 16))}px`;
      for (const h of hits) {
        const row = element(doc, 'div', `bt-diag-tip-row bt-diag-tip-${h.severity}`);
        row.append(element(doc, 'span', 'bt-diag-tip-kind', PREFIX[h.severity]), h.message);
        const change = fixOf(h);
        if (change) {
          const button = element(doc, 'button', 'bt-fix', change.label);
          // The editor keeps its focus and cursor; the edit is an ordinary transaction, so undo works.
          button.addEventListener('mousedown', (e) => e.preventDefault());
          button.addEventListener('click', () => view.dispatch({ changes: change.edits, userEvent: 'input.fix' }));
          row.append(button);
        }
        dom.append(row);
      }
      if (help) {
        const box = element(doc, 'div', 'bt-help');
        box.append(element(doc, 'div', 'bt-help-sig', help.doc.signature), element(doc, 'div', 'bt-help-text', help.doc.text));
        if (help.doc.example) box.append(element(doc, 'div', 'bt-help-example', help.doc.example));
        dom.append(box);
      }
      return {
        dom,
        // CodeMirror keeps a tooltip inside the window; a narrow pane is kept inside as well.
        positioned() {
          const frame = dom.parentElement;
          if (!frame) return;
          frame.style.transform = '';
          const editor = view.dom.getBoundingClientRect();
          const box = frame.getBoundingClientRect();
          let shift = Math.min(0, editor.right - box.right);
          if (box.left + shift < editor.left) shift = editor.left - box.left;
          if (shift) frame.style.transform = `translateX(${shift}px)`;
        },
      };
    },
  };
}

/**
 * Editor extensions for strategy blocks: token colours, underlines for problems, and on hover the
 * message with a button for the fix and help for the word under the pointer. `getDefaults` is read each
 * time a block is parsed. With `options.lookup` giving a lookup, tickers its source does not know are
 * underlined too; while it gives null nothing is looked up and no request is made.
 */
export function strategyEditor(getDefaults: () => Partial<Defaults>, options: EditorOptions = {}): Extension[] {
  const cache = new ResultCache<BlockAnalysis>(CACHED_BLOCKS, Infinity);
  const lookup = () => options.lookup?.() ?? null;
  const plugin = ViewPlugin.define((view) => new StrategyView(view, cache, getDefaults, lookup), {
    decorations: (v) => v.tokens,
    provide: (p) => EditorView.decorations.of((view) => view.plugin(p)?.problems ?? Decoration.none),
  });

  const fixOf = (view: EditorView, p: Problem): Change | null => {
    const fix = fixForDiagnostic(p.block.lines, p.diagnostic, p.block.defaults, lookup());
    return fix ? changeFor(view, p.block, fix) : null;
  };
  const byKind = (a: Problem, b: Problem) => (a.severity === b.severity ? a.from - b.from : a.severity === 'error' ? -1 : 1);

  const hover = hoverTooltip(
    (view, pos, side) => {
      const sv = view.plugin(plugin);
      if (!sv) return null;
      const hits = sv.hits.filter((h) => pos >= h.from && pos <= h.to && (pos > h.from || side > 0) && (pos < h.to || side < 0)).sort(byKind);
      const help = helpUnder(view, sv, pos, side);
      if (!hits.length && !help) return null;
      const changes = new Map(hits.map((h) => [h, fixOf(view, h)] as const));
      return tooltipFor(view, hits, help, (p) => changes.get(p) ?? null);
    },
    { hideOnChange: true },
  );

  const handle: Handle = {
    fixAt(view, pos) {
      const sv = view.plugin(plugin);
      if (!sv) return null;
      const line = view.state.doc.lineAt(pos);
      const covering = sv.hits.filter((h) => pos >= h.from && pos <= h.to).sort(byKind);
      const sameLine = sv.hits.filter((h) => h.from >= line.from && h.from <= line.to && !covering.includes(h)).sort(byKind);
      for (const h of [...covering, ...sameLine]) {
        const change = fixOf(view, h);
        if (change) return change;
      }
      return null;
    },
  };
  return [plugin, hover, handles.of(handle)];
}

/** The help for the character the pointer is over, from the block's tokens. */
function helpUnder(view: EditorView, sv: StrategyView, pos: number, side: number): Help | null {
  const line = view.state.doc.lineAt(pos);
  const block = sv.blockAt(line.number - 1);
  if (!block) return null;
  const col = pos - line.from - (side > 0 ? 0 : 1);
  const row = line.number - 1 - block.first;
  const found = helpAt(block.lines, row, col, block.analysis.tokens, lineKinds(block.lines));
  return found ? { from: line.from + found.from, to: line.from + found.to, doc: found.doc } : null;
}

/** The strategy block around a line: every line in it and those above the given line; null outside one. */
function blockAround(editor: Editor, at: number): { block: string[]; above: string[] } | null {
  let start = -1;
  let fence = '';
  for (let n = at - 1; n >= 0; n--) {
    const open = fenceOf(editor.getLine(n));
    if (!open) continue;
    if (open.info !== 'strategy') return null;
    start = n;
    fence = open.fence;
    break;
  }
  if (start < 0 || closesFence(editor.getLine(at), fence)) return null;
  const block: string[] = [];
  for (let n = start + 1; n < editor.lineCount() && !closesFence(editor.getLine(n), fence); n++) block.push(editor.getLine(n));
  return { block, above: block.slice(0, at - start - 1) };
}

export interface SuggestOptions {
  /** The defaults a block is read with; they decide where a plain ticker comes from when the block has no `data` line. */
  defaults?: () => Partial<Defaults>;
  /** The ticker lookup, or null while the setting for it is off. */
  lookup?: () => SymbolLookup | null;
  /** The vault's CSV file paths, from the root. */
  csvPaths?: () => string[];
  /** The column names of a CSV file the plugin has read; undefined for one it has not. */
  csvColumns?: (path: string) => readonly string[] | undefined;
}

/** A ticker being typed, and what the lookup is asked for it. */
interface TickerAsk {
  word: string;
  source: 'yahoo' | 'binance';
  lookup: SymbolLookup;
}

export class StrategySuggest extends EditorSuggest<Completion> {
  private items: Completion[] = [];
  private options: SuggestOptions;
  private ask: TickerAsk | null = null;
  /** Counts triggers, so an answer for text that has since changed is dropped. */
  private turn = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(app: App, options: SuggestOptions = {}) {
    super(app);
    this.options = options;
  }

  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    this.cancel();
    this.ask = null;
    const around = blockAround(editor, cursor.line);
    if (!around) return null;
    const line = editor.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    const result = complete(around.block, around.above, before, this.options.csvColumns);
    if (result) {
      this.items = result.items;
      return { start: { line: cursor.line, ch: result.from }, end: cursor, query: '' };
    }
    // Tickers are looked up only while the setting is on; without it the behaviour is as it was.
    const lookup = this.options.lookup?.() ?? null;
    const pos = lookup ? tickerPosition(before) : null;
    if (!lookup || !pos) return null;
    const taken = writtenTickers([line], TICKER_SETTINGS);
    this.items = localTickers(around.block, pos, taken, this.options.csvPaths?.() ?? []);
    if (/^csv:/i.test(pos.word)) {
      if (!this.items.length) return null;
    } else if (pos.word) {
      this.ask = { word: pos.word, source: blockSource(around.block, this.options.defaults?.()), lookup };
    } else if (!this.items.length) {
      return null;
    }
    return { start: { line: cursor.line, ch: pos.from }, end: cursor, query: pos.word };
  }

  getSuggestions(_context: EditorSuggestContext): Completion[] | Promise<Completion[]> {
    const own = this.items;
    const ask = this.ask;
    if (!ask) return own;
    const known = ask.lookup.peekSuggest(ask.word, ask.source);
    if (known) return [...own, ...hitCompletions(known, own)];
    const turn = ++this.turn;
    const fetchHits = async (): Promise<Completion[]> => [...own, ...hitCompletions(await ask.lookup.suggest(ask.word, ask.source), own)];
    if (own.length) {
      // The block's own tickers show at once; the hits are added when they arrive, if the text has not changed.
      this.timer = setTimeout(() => {
        void fetchHits().then((all) => {
          if (turn === this.turn) this.showMore(all);
        });
      }, SUGGEST_DELAY_MS);
      return own;
    }
    // A request that a newer key overtakes never answers: Obsidian takes an empty answer as "nothing matches", closes the
    // list and forgets where it was, so the newer request's hits would then have nowhere to show.
    return new Promise<Completion[]>((resolve) => {
      this.timer = setTimeout(() => {
        void fetchHits().then((all) => {
          if (turn === this.turn) resolve(all);
        });
      }, SUGGEST_DELAY_MS);
    });
  }

  /** Puts the late hits into the list that is open. Obsidian has no public call for it; where its list is not there, they show from the next key on. */
  private showMore(items: Completion[]): void {
    if (!this.context) return;
    const list = (this as unknown as { suggestions?: { setSuggestions?: (items: Completion[]) => void } }).suggestions;
    try {
      list?.setSuggestions?.(items);
    } catch {
      // The next key press asks again, and the hits are kept by then.
    }
  }

  /** Drops a request that is waiting for its turn. */
  private cancel(): void {
    this.turn++;
    clearTimeout(this.timer);
  }

  renderSuggestion(item: Completion, el: HTMLElement): void {
    el.addClass('bt-suggest');
    if (item.hit) el.addClass('bt-suggest-hit');
    el.createSpan({ cls: 'bt-suggest-label', text: item.label });
    if (item.detail) el.createSpan({ cls: 'bt-suggest-detail', text: item.detail });
  }

  selectSuggestion(item: Completion): void {
    if (!this.context) return;
    const { editor, start, end } = this.context;
    editor.replaceRange(item.insert, start, end);
    editor.setCursor({ line: start.line, ch: start.ch + item.insert.length });
  }
}
