import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { EditorSuggest, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo } from 'obsidian';
import { complete, type Completion } from './complete.ts';
import { lineKind, tokenize, type TokenKind } from './highlight.ts';

const OPEN = /^\s*(`{3,}|~{3,})\s*strategy\s*$/;

const MARKS = Object.fromEntries(
  (['key', 'keyword', 'function', 'series', 'number', 'ticker', 'value', 'operator', 'comment'] as TokenKind[]).map((k) => [k, Decoration.mark({ class: `bt-tok bt-tok-${k}` })]),
) as Record<TokenKind, Decoration>;

function decorate(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const first = view.viewport.from;
  const last = doc.lineAt(view.viewport.to).number;
  let fence: string | null = null;
  let inRule = false;
  // Fences are found from the top; only lines on screen get marks.
  for (let n = 1; n <= last; n++) {
    const line = doc.line(n);
    if (fence === null) {
      const m = line.text.match(OPEN);
      if (m) {
        fence = m[1];
        inRule = false;
      }
    } else if (line.text.trim().startsWith(fence)) {
      fence = null;
    } else {
      const kind = lineKind(line.text, inRule);
      inRule = kind === 'rule' || kind === 'continuation';
      if (line.to >= first) for (const t of tokenize(line.text, kind)) builder.add(line.from + t.from, line.from + t.to, MARKS[t.kind]);
    }
  }
  return builder.finish();
}

/** Colours strategy blocks while they are being edited. */
export const strategyHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) this.decorations = decorate(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

/** The strategy block around a line: every line in it and those above the given line; null outside one. */
function blockAround(editor: Editor, at: number): { block: string[]; above: string[] } | null {
  let start = -1;
  let fence = '';
  for (let n = at - 1; n >= 0; n--) {
    const text = editor.getLine(n);
    const m = text.match(OPEN);
    if (m) {
      start = n;
      fence = m[1];
      break;
    }
    if (/^\s*(`{3,}|~{3,})/.test(text)) return null;
  }
  if (start < 0 || editor.getLine(at).trim().startsWith(fence)) return null;
  const block: string[] = [];
  for (let n = start + 1; n < editor.lineCount() && !editor.getLine(n).trim().startsWith(fence); n++) block.push(editor.getLine(n));
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
