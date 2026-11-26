// Renders the Ambient "+ In My Book" evaluation panel: weight slider (0..50%), marginal Sharpe/MaxDD/Calmar deltas,
// worst-decile Tail-Drawdown Correlation, sleeve R^2 redundancy bars, blended equity chart, and today's Transition Ticket.

import { analyzeBookImpact, type ActiveBookSnapshot, type BookImpact } from './book.ts';
import type { Backtest } from './backtest.ts';
import { h, s } from './dom.ts';
import { minus, money, pct, shareCount, signedPct } from './format.ts';

const signedNum = (x: number, d = 2) => (!Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : ''}${minus(x.toFixed(d))}`);

function drawBlendChart(parent: HTMLElement, impact: BookImpact): void {
  const w = 520;
  const ht = 150;
  const pad = { l: 10, r: 10, t: 10, b: 14 };
  const svg = s(parent, 'svg', { viewBox: `0 0 ${w} ${ht}`, class: 'bt-svg bt-book-svg', role: 'img', 'aria-label': `Active book vs blended with candidate` });
  const a = impact.bookBeforeEquity;
  const b = impact.bookAfterEquity;
  const n = a.length;
  if (n < 2) return;
  let lo = Infinity;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] > 0) {
      lo = Math.min(lo, a[i]);
      hi = Math.max(hi, a[i]);
    }
    if (b[i] > 0) {
      lo = Math.min(lo, b[i]);
      hi = Math.max(hi, b[i]);
    }
  }
  if (!Number.isFinite(lo) || !(hi > 0)) return;
  const l0 = Math.log(Math.max(1e-6, lo));
  const span = Math.log(Math.max(lo * 1.001, hi)) - l0 || 1;
  const x = (i: number) => pad.l + (i / (n - 1)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (Math.log(Math.max(1e-6, v)) - l0) / span) * (ht - pad.t - pad.b);
  const line = (xs: number[]) => {
    const step = Math.max(1, Math.floor(n / 240));
    const pts: string[] = [];
    for (let i = 0; i < n; i += step) pts.push(`${x(i).toFixed(1)},${y(xs[i]).toFixed(1)}`);
    if ((n - 1) % step !== 0) pts.push(`${x(n - 1).toFixed(1)},${y(xs[n - 1]).toFixed(1)}`);
    return `M${pts.join('L')}`;
  };
  s(svg, 'path', { d: line(a), class: 'bt-line bt-line-benchmark' });
  s(svg, 'path', { d: line(b), class: 'bt-line bt-line-strategy' });
}

/** Renders the interactive "+ In My Book" portfolio impact panel for `candidateBt` against `book`. */
export function renderBookPanel(parent: HTMLElement, book: ActiveBookSnapshot, candidateBt: Backtest, initialWeight = 0.15): HTMLElement {
  const root = h(parent, 'div', 'bt-book');
  let weight = initialWeight;

  const controls = h(root, 'div', 'bt-book-controls');
  h(controls, 'span', 'bt-book-title', `Blending into ${book.name}`);
  const weightLabel = h(controls, 'span', 'bt-book-w');
  const slider = h(controls, 'input', 'bt-book-slider') as HTMLInputElement;
  slider.type = 'range';
  slider.min = '0';
  slider.max = '50';
  slider.step = '5';
  slider.value = String(Math.round(weight * 100));
  const optBtn = h(controls, 'button', 'bt-chip-button bt-book-opt');
  optBtn.type = 'button';
  let suggestedWeight = 0;

  const content = h(root, 'div', 'bt-book-body');

  const draw = () => {
    content.replaceChildren();
    weightLabel.textContent = `${Math.round(weight * 100)}% sleeve`;
    const impact = analyzeBookImpact(book, candidateBt, weight);
    if (!impact) {
      optBtn.hidden = true;
      h(content, 'div', 'bt-note', 'Not enough overlapping dates with the active book to compute marginal impact.');
      return;
    }
    suggestedWeight = impact.suggestedWeight;
    optBtn.hidden = false;
    optBtn.textContent = impact.suggestedWeight > 0 ? `Use optimal ${Math.round(impact.suggestedWeight * 100)}%` : 'Optimal: 0%';

    const grid = h(content, 'div', 'bt-book-grid');
    const card = (label: string, val: string, sub: string, tone: 'good' | 'bad' | 'neutral') => {
      const c = h(grid, 'div', `bt-book-kpi bt-book-kpi-${tone}`);
      h(c, 'div', 'bt-book-kpi-label', label);
      h(c, 'div', 'bt-book-kpi-val', val);
      h(c, 'div', 'bt-book-kpi-sub', sub);
    };
    card(
      'ΔBook Sharpe',
      signedNum(impact.deltaSharpe, 2),
      `${minus(impact.bookBefore.sharpe.toFixed(2))} → ${minus(impact.bookAfter.sharpe.toFixed(2))}`,
      impact.deltaSharpe > 0.01 ? 'good' : impact.deltaSharpe < -0.01 ? 'bad' : 'neutral',
    );
    card(
      'ΔBook Max DD',
      `${impact.deltaMaxDD >= 0 ? '+' : ''}${minus((impact.deltaMaxDD * 100).toFixed(1))} pts`,
      `${pct(impact.bookBefore.maxDrawdown)} → ${pct(impact.bookAfter.maxDrawdown)}`,
      impact.deltaMaxDD > 0.002 ? 'good' : impact.deltaMaxDD < -0.002 ? 'bad' : 'neutral',
    );
    const tail = impact.tailDrawdownCorrelation;
    card(
      'Drawdown corr',
      Number.isFinite(tail) ? minus(tail.toFixed(2)) : '–',
      !Number.isFinite(tail) ? 'Not enough data' : tail < 0 ? 'Hedges drawdowns' : tail < 0.35 ? 'Low drawdown overlap' : 'Falls with book',
      !Number.isFinite(tail) ? 'neutral' : tail < 0.1 ? 'good' : tail > 0.5 ? 'bad' : 'neutral',
    );
    card(
      'ΔBook Calmar',
      signedNum(impact.deltaCalmar, 2),
      `Full corr ${minus(impact.fullCorrelation.toFixed(2))}`,
      impact.deltaCalmar > 0.02 ? 'good' : impact.deltaCalmar < -0.02 ? 'bad' : 'neutral',
    );

    drawBlendChart(h(content, 'div', 'bt-book-chart'), impact);

    if (impact.redundancy.length > 0) {
      const red = h(content, 'div', 'bt-book-red');
      h(red, 'div', 'bt-book-sec-title', 'Sleeve overlap & redundancy');
      for (const r of impact.redundancy.slice(0, 5)) {
        const row = h(red, 'div', 'bt-book-red-row');
        h(row, 'span', 'bt-book-red-name', r.sleeve);
        h(row, 'span', 'bt-book-red-val', `R² ${pct(r.rSquared, 0)} · corr ${minus(r.correlation.toFixed(2))} · active overlap ${pct(r.activeOverlap, 0)}`);
      }
    }

    if (impact.transitionOrders.length > 0) {
      const det = h(content, 'details', 'bt-book-ticket');
      h(det, 'summary', undefined, `Live transition ticket · ${impact.transitionOrders.length} orders · ${money(impact.estimatedTurnoverDollars)} turnover`);
      const table = h(det, 'table', 'bt-table');
      const trH = h(h(table, 'thead'), 'tr');
      for (const col of ['Action', 'Ticker', 'Shares', 'Est. Value']) h(trH, 'th', undefined, col);
      const tbody = h(table, 'tbody');
      for (const o of impact.transitionOrders) {
        const tr = h(tbody, 'tr');
        h(tr, 'td', undefined, o.action === 'buy' ? 'Buy' : 'Sell');
        h(tr, 'td', undefined, o.ticker);
        h(tr, 'td', 'bt-num', shareCount(o.deltaShares));
        h(tr, 'td', 'bt-num', money(o.deltaDollars));
      }
    }
  };

  optBtn.addEventListener('click', () => {
    weight = suggestedWeight;
    slider.value = String(Math.round(weight * 100));
    draw();
  });
  slider.addEventListener('input', () => {
    weight = Number(slider.value) / 100;
    draw();
  });
  draw();
  return root;
}
