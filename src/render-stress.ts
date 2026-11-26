// Renders the Always-On Adversarial Stress Envelope controls: Breaking-Point Gauge header and 4-axis isolation pill bar
// (`Params ±15%` | `Friction 3×` | `Delay +1 bar` | `Drop Best Year`), replacing the static Buy & Hold scorecard as the
// primary v2 surface.

import { h } from './dom.ts';
import { minus, pct } from './format.ts';
import type { StressAxis, StressReport } from './stress.ts';

export type SelectedStressAxis = StressAxis | 'all';

const AXIS_LABELS: [SelectedStressAxis, string][] = [
  ['all', 'All'],
  ['params', 'Params ±15%'],
  ['friction', 'Friction 3×'],
  ['timing', 'Delay +1d'],
  ['outliers', 'Outliers'],
];

const GRADE_LABEL: Record<StressReport['breakingPoints']['grade'], string> = {
  robust: 'Holds up',
  sensitive: 'Sensitive',
  fragile: 'Fragile',
};

/** Renders the stress test readout and 4-axis toggle bar above the chart. */
export function renderStressPanel(
  parent: HTMLElement,
  report: StressReport,
  onSelectAxis: (axis: SelectedStressAxis) => void,
): HTMLElement {
  const bp = report.breakingPoints;
  const box = h(parent, 'div', `bt-stress bt-stress-${bp.grade}`);

  const head = h(box, 'div', 'bt-stress-head');
  const badge = h(head, 'span', `bt-stress-grade bt-stress-grade-${bp.grade}`, GRADE_LABEL[bp.grade]);
  badge.title = 'How the strategy holds up across ±15% value shifts, 3x costs, +1 bar delay, and dropping the best year';

  const metrics = h(head, 'div', 'bt-stress-metrics');
  const item = (k: string, v: string, bad = false) => {
    const el = h(metrics, 'span', `bt-stress-kv${bad ? ' bt-stress-bad' : ''}`);
    h(el, 'span', 'bt-stress-k', k);
    h(el, 'span', 'bt-stress-v', v);
  };
  item('Costs break at', Number.isFinite(bp.breakevenBps) ? `${Math.round(bp.breakevenBps)} bps` : '>100 bps', bp.breakevenBps < 20);
  item('±15% pass', pct(bp.neighborSurvivalRate, 0), bp.neighborSurvivalRate < 0.75);
  item('Without best yr', Number.isFinite(bp.exBestYearSharpe) ? minus(bp.exBestYearSharpe.toFixed(2)) : '–', bp.exBestYearSharpe <= 0);
  item('+1 bar delay', Number.isFinite(bp.delayedSharpe) ? minus(bp.delayedSharpe.toFixed(2)) : '–', bp.delayedSharpe <= 0);

  // 4-axis isolation toggle strip
  const bar = h(box, 'div', 'bt-stress-axes');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Stress envelope axis');
  let active: SelectedStressAxis = 'all';
  const buttons = new Map<SelectedStressAxis, HTMLButtonElement>();
  for (const [axis, label] of AXIS_LABELS) {
    const collapsed = axis !== 'all' && bp.axisCollapse[axis];
    const btn = h(bar, 'button', `bt-stress-pill${axis === active ? ' is-active' : ''}${collapsed ? ' is-collapsed' : ''}`, label);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(axis === active));
    if (collapsed) btn.title = `${label} cuts strategy Sharpe by >40% or below 0`;
    btn.addEventListener('click', () => {
      active = axis;
      for (const [k, b] of buttons) {
        b.classList.toggle('is-active', k === active);
        b.setAttribute('aria-pressed', String(k === active));
      }
      onSelectAxis(active);
    });
    buttons.set(axis, btn);
  }
  return box;
}
