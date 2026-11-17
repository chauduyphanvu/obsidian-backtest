import type { Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, hoverTooltip, type DecorationSet, type Tooltip, type ViewUpdate } from '@codemirror/view';
import { EditorSuggest, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo } from 'obsidian';
import { complete, type Completion } from './complete.ts';
import { analyzeBlock, closesFence, fenceOf, findBlocks, type BlockAnalysis, type BlockDiagnostic } from './diagnostics.ts';
import type { Defaults } from './dsl.ts';
import type { TokenKind } from './highlight.ts';
import { ResultCache } from './result-cache.ts';

const KINDS: Record<TokenKind, true> = { key: true, keyword: true, function: true, series: true, number: true, ticker: true, value: true, operator: true, comment: true, param: true };
const TOKEN_MARKS = Object.fromEntries(Object.keys(KINDS).map((k) => [k, Decoration.mark({ class: `bt-tok bt-tok-${k}` })])) as Record<TokenKind, Decoration>;

/** A problem placed in the note, for the tooltip. */
interface Problem {
  from: number;
  to: number;
  severity: BlockDiagnostic['severity'];
  message: string;
}

const PREFIX = { error: 'Problem: ', warning: 'Note: ' };

/** Blocks read at once on screen; older readings of a block fall out as it is edited. */
const CACHED_BLOCKS = 64;

class StrategyView {
  tokens: DecorationSet = Decoration.none;
  problems: DecorationSet = Decoration.none;
  hits: Problem[] = [];
  private cache: ResultCache<BlockAnalysis>;
  private getDefaults: () => Partial<Defaults>;

  constructor(view: EditorView, cache: ResultCache<BlockAnalysis>, getDefaults: () => Partial<Defaults>) {
    this.cache = cache;
    this.getDefaults = getDefaults;
    this.build(view);
  }

  update(u: ViewUpdate): void {
    if (u.docChanged || u.viewportChanged) this.build(u.view);
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
    const problems: Range<Decoration>[] = [];
    const hits: Problem[] = [];

    for (const block of findBlocks(doc.iterLines(), lastShown)) {
      if (block.last < block.first || block.last < firstShown || block.first > lastShown) continue;
      const lines = Array.from(doc.iterLines(block.first + 1, block.last + 2));
      const key = salt + lines.join('\n');
      let analysis = this.cache.get(key);
      if (!analysis) {
        analysis = analyzeBlock(lines, defaults);
        this.cache.set(key, analysis);
      }
      const shownFrom = Math.max(block.first, firstShown);
      const shownTo = Math.min(block.last, lastShown);
      for (let n = shownFrom; n <= shownTo; n++) {
        const start = doc.line(n + 1).from;
        for (const t of analysis.tokens[n - block.first]) tokens.push(TOKEN_MARKS[t.kind].range(start + t.from, start + t.to));
      }
      for (const d of analysis.diagnostics) {
        const n = block.first + d.line;
        if (n < shownFrom || n > shownTo) continue;
        const start = doc.line(n + 1).from;
        const mark = Decoration.mark({ class: `bt-diag bt-diag-${d.severity}`, attributes: { title: PREFIX[d.severity] + d.message } });
        problems.push(mark.range(start + d.from, start + d.to));
        hits.push({ from: start + d.from, to: start + d.to, severity: d.severity, message: d.message });
      }
    }
    this.tokens = Decoration.set(tokens, true);
    this.problems = Decoration.set(problems, true);
    this.hits = hits;
  }
}

function tooltipFor(view: EditorView, hits: Problem[]): Tooltip {
  return {
    pos: Math.min(...hits.map((h) => h.from)),
    end: Math.max(...hits.map((h) => h.to)),
    above: true,
    create() {
      const doc = view.dom.ownerDocument;
      const dom = doc.createElement('div');
      dom.className = 'bt-diag-tip';
      for (const h of hits) {
        const row = doc.createElement('div');
        row.className = `bt-diag-tip-row bt-diag-tip-${h.severity}`;
        const kind = doc.createElement('span');
        kind.className = 'bt-diag-tip-kind';
        kind.textContent = PREFIX[h.severity];
        row.append(kind, h.message);
        dom.append(row);
      }
      return { dom };
    },
  };
}

/** Editor extensions for strategy blocks: token colours, and underlines for problems with the message on hover. `getDefaults` is read each time a block is parsed. */
export function strategyEditor(getDefaults: () => Partial<Defaults>): Extension[] {
  const cache = new ResultCache<BlockAnalysis>(CACHED_BLOCKS, Infinity);
  const plugin = ViewPlugin.define((view) => new StrategyView(view, cache, getDefaults), {
    decorations: (v) => v.tokens,
    provide: (p) => EditorView.decorations.of((view) => view.plugin(p)?.problems ?? Decoration.none),
  });
  const hover = hoverTooltip(
    (view, pos, side) => {
      const hits = (view.plugin(plugin)?.hits ?? []).filter((h) => pos >= h.from && pos <= h.to && (pos > h.from || side > 0) && (pos < h.to || side < 0));
      if (!hits.length) return null;
      hits.sort((a, b) => (a.severity === b.severity ? a.from - b.from : a.severity === 'error' ? -1 : 1));
      return tooltipFor(view, hits);
    },
    { hideOnChange: true },
  );
  return [plugin, hover];
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

export class StrategySuggest extends EditorSuggest<Completion> {
  private items: Completion[] = [];

  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    const around = blockAround(editor, cursor.line);
    if (!around) return null;
    const result = complete(around.block, around.above, editor.getLine(cursor.line).slice(0, cursor.ch));
    if (!result) return null;
    this.items = result.items;
    return { start: { line: cursor.line, ch: result.from }, end: cursor, query: '' };
  }

  getSuggestions(_context: EditorSuggestContext): Completion[] {
    return this.items;
  }

  renderSuggestion(item: Completion, el: HTMLElement): void {
    el.addClass('bt-suggest');
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
