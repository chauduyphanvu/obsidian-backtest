// Differential attribution banner for a strategy that `extends:` a parent strategy, showing exact marginal deltas
// against the parent rather than only Buy & Hold.

import type { StrategyDiff } from './dag.ts';
import { h } from './dom.ts';
import { minus, signedPct } from './format.ts';

const signedNum = (x: number, digits = 2): string =>
  !Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : ''}${minus(x.toFixed(digits))}`;

/** Renders a compact "vs. Parent" differential strip above the chart when a strategy inherits via `extends:`. */
export function renderStrategyDiff(parentEl: HTMLElement, diff: StrategyDiff, onHoverTimes?: (times: number[] | null) => void): HTMLElement {
  const box = h(parentEl, 'div', 'bt-diff-banner');
  const head = h(box, 'div', 'bt-diff-head');
  h(head, 'span', 'bt-diff-tag', `vs. ${diff.parentName}`);

  const metrics = h(head, 'div', 'bt-diff-metrics');
  const chip = (label: string, text: string, good: boolean, neutral = false) => {
    const cls = neutral ? 'bt-diff-chip bt-diff-neutral' : good ? 'bt-diff-chip bt-diff-good' : 'bt-diff-chip bt-diff-bad';
    const c = h(metrics, 'span', cls);
    h(c, 'span', 'bt-diff-k', label);
    h(c, 'span', 'bt-diff-v', text);
  };
  chip('Sharpe', signedNum(diff.deltaSharpe), diff.deltaSharpe > 0.005, Math.abs(diff.deltaSharpe) <= 0.005);
  chip(
    'Max DD',
    Number.isFinite(diff.deltaMaxDD) ? `${diff.deltaMaxDD >= 0 ? '+' : ''}${minus((diff.deltaMaxDD * 100).toFixed(1))} pts` : '–',
    diff.deltaMaxDD > 0.0005,
    !Number.isFinite(diff.deltaMaxDD) || Math.abs(diff.deltaMaxDD) <= 0.0005,
  );
  chip('CAGR', signedPct(diff.deltaCagr), diff.deltaCagr > 0.0005, Math.abs(diff.deltaCagr) <= 0.0005);

  const tradeBits: string[] = [];
  if (diff.losingTradesAvoided > 0) tradeBits.push(`${diff.losingTradesAvoided} losing trades avoided`);
  if (diff.winningTradesRemoved > 0) tradeBits.push(`${diff.winningTradesRemoved} winners dropped`);
  if (diff.tradesAdded > 0) tradeBits.push(`${diff.tradesAdded} new trades added`);
  if (tradeBits.length > 0) {
    const detail = h(box, 'div', 'bt-diff-trades', tradeBits.join(' · '));
    if (onHoverTimes && diff.diffTimes.length > 0) {
      detail.classList.add('bt-diff-hoverable');
      detail.addEventListener('mouseenter', () => onHoverTimes(diff.diffTimes));
      detail.addEventListener('mouseleave', () => onHoverTimes(null));
    }
  }
  return box;
}
