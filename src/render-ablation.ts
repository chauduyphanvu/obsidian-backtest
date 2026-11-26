// Renders Inline X-Ray Clause Attribution pills inside the rules box (and exports compact text formatting shared with
// CodeMirror 6 inline decorations in editor.ts). Supports 1-click mute/unmute, hover-to-highlight causal trades on the
// main chart, and committing muted deletions back to the note.

import type { AblationReport, ClauseAttribution } from './ablation.ts';
import { h } from './dom.ts';
import { minus } from './format.ts';

const signed = (x: number, digits = 2): string =>
  !Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : ''}${minus(x.toFixed(digits))}`;

/** Compact inline badge text used both in rendered cards and in CodeMirror 6 end-of-line decorations. */
export function ablationPillText(c: ClauseAttribution): string {
  const sr = `${signed(c.deltaSharpe, 2)} SR`;
  const dd = `${c.deltaMaxDD >= 0 ? '-' : '+'}${Math.abs(c.deltaMaxDD * 100).toFixed(1)}% DD`;
  const touched = c.tradesAdded + c.tradesBlocked;
  if (c.verdict === 'neutral') return `${sr} · no effect (${touched}t)`;
  if (c.verdict === 'destructive') return `${sr} · hurts (${dd})`;
  return `${sr} · ${dd}`;
}

export interface AblationUiCallbacks {
  muted: ReadonlySet<string>;
  onToggleMute: (clauseId: string) => void;
  onHoverTimes?: (times: number[] | null) => void;
  onCommitRemove?: () => void;
  /** Initial expanded state (preserves openness across mute toggles). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Renders a hairline-separated collapsible X-Ray clause strip at the bottom of the rules well. */
export function renderAblationStrip(parent: HTMLElement, report: AblationReport, cb: AblationUiCallbacks): HTMLElement {
  const box = h(parent, 'details', 'bt-ablation') as HTMLDetailsElement;
  box.open = cb.open ?? cb.muted.size > 0;
  box.addEventListener('toggle', () => cb.onOpenChange?.(box.open));

  const summary = h(box, 'summary', 'bt-ablation-summary');
  h(summary, 'span', 'bt-ablation-title', 'Clauses');

  const counts = {
    load: report.clauses.filter((c) => c.verdict === 'load-bearing').length,
    helpful: report.clauses.filter((c) => c.verdict === 'helpful').length,
    neutral: report.clauses.filter((c) => c.verdict === 'neutral').length,
    destructive: report.clauses.filter((c) => c.verdict === 'destructive').length,
  };
  const tally = h(summary, 'span', 'bt-ablation-tally');
  const addTag = (n: number, label: string, cls: string) => {
    if (n <= 0) return;
    h(tally, 'span', `bt-ablation-tag bt-ablation-tag-${cls}`, `${n} ${label}`);
  };
  addTag(counts.load, 'key', 'load-bearing');
  addTag(counts.helpful, 'helpful', 'helpful');
  addTag(counts.neutral, 'no effect', 'neutral');
  addTag(counts.destructive, 'hurts', 'destructive');
  if (cb.muted.size > 0) addTag(cb.muted.size, 'muted', 'muted');

  h(summary, 'span', 'bt-ablation-chevron', '▸');

  const inner = h(box, 'div', 'bt-ablation-body');
  const bar = h(inner, 'div', 'bt-ablation-bar');
  h(bar, 'span', 'bt-ablation-sub', 'Click a clause to mute it · hover to mark its trades on the chart');
  if (cb.muted.size > 0 && cb.onCommitRemove) {
    const commit = h(bar, 'button', 'bt-chip-button bt-ablation-commit', `Delete ${cb.muted.size} muted`);
    commit.type = 'button';
    commit.addEventListener('click', (e) => {
      e.preventDefault();
      cb.onCommitRemove!();
    });
  }

  const list = h(inner, 'div', 'bt-ablation-list');
  for (const c of report.clauses) {
    const isMuted = cb.muted.has(c.id);
    const row = h(list, 'button', `bt-clause bt-clause-${c.verdict}${isMuted ? ' is-muted' : ''}`);
    row.type = 'button';
    row.setAttribute('aria-pressed', String(isMuted));
    row.title = `${c.label}\nΔSharpe: ${signed(c.deltaSharpe, 2)} · ΔMaxDD: ${signed(c.deltaMaxDD * 100, 1)} pts · Added ${c.tradesAdded}, blocked ${c.tradesBlocked} trades`;
    h(row, 'span', 'bt-clause-label', c.label);
    h(row, 'span', `bt-clause-pill bt-clause-pill-${c.verdict}`, isMuted ? 'muted' : ablationPillText(c));
    row.addEventListener('click', () => cb.onToggleMute(c.id));
    if (cb.onHoverTimes && c.affectedTimes.length > 0) {
      row.addEventListener('mouseenter', () => cb.onHoverTimes!(c.affectedTimes));
      row.addEventListener('mouseleave', () => cb.onHoverTimes!(null));
    }
  }
  return box;
}
