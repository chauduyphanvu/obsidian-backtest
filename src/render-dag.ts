// Renders `signal`, `regime`, and `universe` reusable DAG blocks inside Obsidian notes, including a live Blast Radius
// table showing every strategy in the vault that depends on this node.

import { parseSignalBlock, parseUniverseBlock, type DagBlockKind } from './dag.ts';
import { h } from './dom.ts';
import { minus, signedPct } from './format.ts';

export interface BlastRadiusRow {
  note: string;
  strategy: string;
  deltaSharpe: number | null;
  deltaMaxDD: number | null;
  status: string;
}

export interface DagBlockHost {
  /** Finds strategies in the vault referencing this block and returns their blast-radius summary. */
  dependents(): Promise<BlastRadiusRow[]>;
  openNote(note: string): void;
}

/** Renders a reusable `signal`, `regime`, or `universe` block card with its exports and dependent blast radius. */
export function renderDagBlock(el: HTMLElement, kind: Exclude<DagBlockKind, 'strategy'>, source: string, host: DagBlockHost): () => void {
  el.replaceChildren();
  let alive = true;
  const root = h(el, 'div', `bt-root bt-dag bt-dag-${kind}`);
  const head = h(root, 'div', 'bt-dag-head');
  h(head, 'span', 'bt-dag-badge', kind.toUpperCase());

  if (kind === 'universe') {
    const parsed = parseUniverseBlock(source);
    h(head, 'span', 'bt-title', parsed.name ?? 'Universe');
    const tickers = parsed.tickers ? parsed.tickers.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const list = h(root, 'div', 'bt-dag-tickers');
    if (tickers.length === 0) h(list, 'span', 'bt-note', 'No tickers listed.');
    else for (const t of tickers) h(list, 'span', 'bt-chip', t);
  } else {
    const parsed = parseSignalBlock(source, kind);
    h(head, 'span', 'bt-title', parsed.name ?? (kind === 'regime' ? 'Regime' : 'Signal'));
    const body = h(root, 'div', 'bt-dag-exports');
    if (parsed.exports.size > 0) {
      for (const exp of parsed.exports.values()) {
        const row = h(body, 'div', 'bt-dag-export');
        h(row, 'code', 'bt-dag-export-name', exp.name);
        h(row, 'span', 'bt-dag-export-eq', '=');
        h(row, 'code', 'bt-dag-export-expr', exp.expr);
      }
    } else if (parsed.defaultExpr) {
      h(body, 'code', 'bt-dag-export-expr', parsed.defaultExpr);
    } else {
      h(body, 'span', 'bt-note', `Write an expression, for example risk_off = close of ^VIX > 25`);
    }
  }

  const blast = h(root, 'div', 'bt-dag-blast');
  const status = h(blast, 'div', 'bt-note', 'Checking linked strategies…');
  void host.dependents().then((rows) => {
    if (!alive) return;
    blast.replaceChildren();
    if (rows.length === 0) {
      h(blast, 'div', 'bt-note', `No strategies link to this ${kind} yet. Reference it with [[NoteName]] in a strategy block.`);
      return;
    }
    h(blast, 'div', 'bt-dag-blast-title', `Used by ${rows.length} ${rows.length === 1 ? 'strategy' : 'strategies'}`);
    const table = h(blast, 'table', 'bt-table bt-dag-table');
    const thead = h(h(table, 'thead'), 'tr');
    h(thead, 'th', undefined, 'Strategy');
    h(thead, 'th', 'bt-num', 'ΔSharpe');
    h(thead, 'th', 'bt-num', 'ΔMax DD');
    h(thead, 'th', undefined, 'Status');
    const tbody = h(table, 'tbody');
    for (const r of rows) {
      const tr = h(tbody, 'tr');
      const td = h(tr, 'td');
      const btn = h(td, 'button', 'bt-link-btn', r.strategy);
      btn.type = 'button';
      btn.addEventListener('click', () => host.openNote(r.note));
      h(tr, 'td', 'bt-num', r.deltaSharpe === null ? '–' : `${r.deltaSharpe >= 0 ? '+' : ''}${minus(r.deltaSharpe.toFixed(2))}`);
      h(tr, 'td', 'bt-num', r.deltaMaxDD === null ? '–' : signedPct(r.deltaMaxDD));
      h(tr, 'td', undefined, r.status);
    }
  }, () => {
    if (alive) status.textContent = '';
  });

  return () => {
    alive = false;
  };
}
