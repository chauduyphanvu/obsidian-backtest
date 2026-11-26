// Renders Inverse Backtesting popovers:
// 1. Brush-to-Contrast feature separation table (ROC-AUC, permutation p-value, DSR trial tax, + Test muted button).
// 2. Click-any-bar Counterfactual HUD (exact blocking comparison + global 20-year side effect if relaxed).

import { h } from './dom.ts';
import { minus, price, signedPct, stamp } from './format.ts';
import type { BarProbeResult, ContrastResult, FeatureSeparation } from './inverse.ts';

/** Renders the Brush-to-Contrast feature-separation panel for a brushed cluster of trades. */
export function renderContrastPopover(
  parent: HTMLElement,
  result: ContrastResult,
  opts: { onInjectClause?: (feature: FeatureSeparation, trialsTax: number) => void; onClose: () => void },
): HTMLElement {
  const box = h(parent, 'div', 'bt-inverse-pop');
  const head = h(box, 'div', 'bt-inverse-head');
  h(head, 'span', 'bt-inverse-title', `Feature contrast: ${result.selectedCount} selected vs. ${result.otherCount} other trades`);
  const close = h(head, 'button', 'bt-icon-button bt-inverse-close', '×');
  close.type = 'button';
  close.addEventListener('click', opts.onClose);

  if (result.features.length === 0) {
    h(box, 'div', 'bt-note', 'Select at least 2 closed trades (and leave at least 2 unselected) to contrast entry features.');
    return box;
  }

  h(
    box,
    'div',
    'bt-note bt-inverse-tax',
    `Scanned ${result.effectiveTrialsCost} candidate features. Injecting a filter adds +${result.effectiveTrialsCost} trials to your Deflated Sharpe ledger.`,
  );

  const table = h(box, 'table', 'bt-table bt-inverse-table');
  const trH = h(h(table, 'thead'), 'tr');
  for (const col of ['Feature', 'Selected', 'Others', 'AUC', 'p-val', '']) h(trH, 'th', undefined, col);
  const tbody = h(table, 'tbody');
  for (const f of result.features.slice(0, 6)) {
    const tr = h(tbody, 'tr', f.pValue <= 0.05 ? 'bt-inverse-sig' : undefined);
    h(tr, 'td', undefined, f.name);
    h(tr, 'td', 'bt-num', minus(f.selectedMedian.toFixed(2)));
    h(tr, 'td', 'bt-num', minus(f.otherMedian.toFixed(2)));
    h(tr, 'td', 'bt-num', f.auc.toFixed(2));
    h(tr, 'td', 'bt-num', f.pValue < 0.01 ? '<0.01' : f.pValue.toFixed(2));
    const td = h(tr, 'td');
    if (opts.onInjectClause) {
      const btn = h(td, 'button', 'bt-chip-button', '+ Test muted');
      btn.type = 'button';
      btn.title = `${f.suggestedClause} (adds +${result.effectiveTrialsCost} DSR trials)`;
      btn.addEventListener('click', () => opts.onInjectClause!(f, result.effectiveTrialsCost));
    }
  }
  return box;
}

/** Renders the Click-Any-Bar Counterfactual Probe HUD anchored below the price chart. */
export function renderBarProbeHud(
  parent: HTMLElement,
  probe: BarProbeResult,
  intraday: boolean,
  opts: { onApplyCounterfactual?: (literalId: string, newValue: number) => void; onClose: () => void },
): HTMLElement {
  const box = h(parent, 'div', 'bt-inverse-pop bt-probe-hud');
  const head = h(box, 'div', 'bt-inverse-head');
  const status = probe.fired ? `${probe.ruleSide} rule fired` : `${probe.ruleSide} rule did not fire`;
  h(head, 'span', 'bt-inverse-title', `${probe.ticker} · ${stamp(probe.t, intraday)} · Close ${price(probe.close)} (${probe.position}) — ${status}`);
  const close = h(head, 'button', 'bt-icon-button bt-inverse-close', '×');
  close.type = 'button';
  close.addEventListener('click', opts.onClose);

  if (probe.blockers.length === 0) {
    h(box, 'div', 'bt-note', probe.fired ? 'All rule comparisons held on this bar.' : 'No blocking numeric comparisons found on this bar.');
    return box;
  }

  for (const b of probe.blockers) {
    const row = h(box, 'div', 'bt-probe-row');
    h(row, 'code', 'bt-probe-clause', b.clause);
    h(row, 'span', 'bt-probe-vals', `observed ${minus(b.lhs.toFixed(2))} vs ${minus(b.rhs.toFixed(2))}`);
    if (b.counterfactual) {
      const cf = b.counterfactual;
      const shownVal = cf.percent ? `${Number((cf.newValue * 100).toPrecision(4))}%` : String(cf.newValue);
      const eff = h(
        row,
        'span',
        'bt-probe-cf',
        `Relax to ${shownVal}: ${cf.flippedTrades >= 0 ? '+' : ''}${cf.flippedTrades} trades, ${cf.deltaSharpe >= 0 ? '+' : ''}${minus(cf.deltaSharpe.toFixed(2))} SR, ${signedPct(cf.deltaMaxDD)} DD`,
      );
      if (opts.onApplyCounterfactual) {
        const btn = h(eff, 'button', 'bt-chip-button', `Try ${shownVal}`);
        btn.type = 'button';
        btn.addEventListener('click', () => opts.onApplyCounterfactual!(cf.literalId, cf.newValue));
      }
    }
  }
  return box;
}
