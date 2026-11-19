// "How to split": weights for strategies held together, the figures each set of weights would have given had it been
// worked out month by month, what each strategy adds, and a button that writes a set into the block. Drawn under a weighted
// `compare` block and in an `account` block.

import { COVARIANCE_MONTHS, MAX_DECIMALS, VOLATILITY_MONTHS, strategyAdds, suggestWeights, type Allocation, type Method } from './allocate.ts';
import { cashReturns, combine, lineStats, weightedCashReturn, type Aligned } from './compare.ts';
import { h } from './dom.ts';
import { minus, pct, plural } from './format.ts';

export interface SplitInput {
  aligned: Aligned;
  /** One per strategy, in the block's order. */
  labels: string[];
  /** As written, fractions adding up to the total the suggestions keep. */
  weights: number[];
  /** The decimals the block writes its weights with (weightDecimals); the suggestions are rounded to them. */
  decimals: number;
  /** Writes whole percentages, one per strategy, into the block; null when the block's place in its note is not known. */
  use: ((percents: number[]) => Promise<void>) | null;
}

export const METHOD_NAMES: Record<Method, string> = {
  equal: 'Equal weights',
  'inverse volatility': 'Inverse volatility',
  'minimum variance': 'Minimum variance',
  'maximum diversification': 'Maximum diversification',
};

export interface SplitRow {
  name: string;
  /** Whole percentages, one per strategy; for the weights as written, those weights. */
  weights: string[];
  /** Return per year, worst drawdown and Sharpe ratio of the combined line. */
  figures: string[];
  /** What "Use these weights" writes; null for the weights as written, and for a set of nothing but 0%. */
  percents: number[] | null;
}

const ratio = (x: number) => minus((Math.round(x * 100) / 100 || 0).toFixed(2));
const share = (w: number) => `${Number((w * 100).toFixed(MAX_DECIMALS))}%`;

function figures(t: number[], values: number[], cashReturn: number[]): string[] {
  const st = lineStats(t, values, cashReturn);
  return [pct(st.cagr), pct(st.maxDrawdown), ratio(st.sharpe)];
}

/** The rows of the table: the weights as written, then each method's, with the figures of its line. */
export function splitRows(input: Pick<SplitInput, 'aligned' | 'weights'>, alloc: Allocation): SplitRow[] {
  const { aligned, weights } = input;
  const written: SplitRow = {
    name: 'As written',
    weights: weights.map(share),
    figures: figures(aligned.t, combine(aligned, weights), weightedCashReturn(cashReturns(aligned), weights)),
    percents: null,
  };
  return [
    written,
    ...alloc.suggestions.map((s) => ({
      name: METHOD_NAMES[s.method],
      weights: s.percents.map((p) => `${p}%`),
      figures: figures(aligned.t, s.values, s.cashReturn),
      // Every line at 0% would leave the block with nothing to combine.
      percents: s.percents.some((p) => p > 0) ? s.percents : null,
    })),
  ];
}

const points = (x: number) => (Number.isFinite(x) ? `${x > 0 ? '+' : ''}${minus((x * 100).toFixed(1))} pts` : '–');
const ratioChange = (x: number) => (Number.isFinite(x) ? `${x > 0 ? '+' : ''}${ratio(x)}` : '–');

/**
 * For each strategy, what the combined line at the weights written gains by holding it: its return per year, worst
 * drawdown and Sharpe ratio less those of the same line without it, its weight spread over the others.
 */
export function addsRows(input: Pick<SplitInput, 'aligned' | 'labels' | 'weights'>): { label: string; cells: string[] }[] {
  const { aligned, labels, weights } = input;
  const adds = strategyAdds(aligned, weights);
  const whole = lineStats(aligned.t, adds.values, adds.cashReturn);
  return labels.map((label, k) => {
    const without = lineStats(aligned.t, adds.without[k].values, adds.without[k].cashReturn);
    return { label, cells: [points(whole.cagr - without.cagr), points(whole.maxDrawdown - without.maxDrawdown), ratioChange(whole.sharpe - without.sharpe)] };
  });
}

/** What to know about the suggestions: how many months they rest on, what was left out, and why a method is missing or can't be used. */
export function splitNotes(alloc: Allocation, labels: string[], decimals = 0): string[] {
  const out = [
    `These weights use the ${plural(alloc.months, 'full month')} that all the strategies have. At the start of each month, each method calculates its weights again from only the months before. Thus its figures do not use data from the future. The weights shown are the weights for the next month.`,
  ];
  if (alloc.months < VOLATILITY_MONTHS) out.push(`Inverse volatility must have ${VOLATILITY_MONTHS} full months. Minimum variance and maximum diversification must have ${COVARIANCE_MONTHS}.`);
  else if (alloc.months < COVARIANCE_MONTHS) out.push(`Minimum variance and maximum diversification must have ${COVARIANCE_MONTHS} full months.`);
  if (alloc.shrinkage !== null) {
    out.push(`The plugin calculates how the strategies move together from their covariances. It moves the covariances ${pct(alloc.shrinkage, 0)} of the distance to one average correlation (Ledoit and Wolf). This makes estimates from a small number of months more stable.`);
  }
  if (alloc.suggestions.length && alloc.suggestions.every((s) => s.percents.every((p) => p === 0))) {
    const total = alloc.suggestions[0].weights.reduce((sum, w) => sum + w, 0);
    out.push(`The total of the weights is ${Number((total * 100).toPrecision(6))}%. This is less than the ${10 ** -decimals}% step of the written weights. Thus no other set of weights can be written.`);
  }
  const still = alloc.still.map((i) => labels[i]);
  if (still.length) out.push(`${still.join(', ')} almost did not move in these months. Thus the methods that size by risk give ${still.length === 1 ? 'it' : 'them'} a weight of 0.`);
  return out;
}

/** Draws "How to split" into `root`. */
export function renderSplit(root: HTMLElement, input: SplitInput): void {
  const total = input.weights.reduce((s, w) => s + w, 0);
  const alloc = suggestWeights(input.aligned, total, input.decimals);
  const box = h(root, 'div', 'bt-split');
  h(box, 'div', 'bt-split-heading', 'How to split');
  const wrap = h(box, 'div', 'bt-scroll');
  const table = h(wrap, 'table', 'bt-table bt-split-table');
  const head = h(h(table, 'thead'), 'tr');
  h(head, 'th');
  for (const label of input.labels) h(head, 'th', 'bt-num', label).title = label;
  for (const name of ['Return per year', 'Worst drawdown', 'Sharpe ratio']) h(head, 'th', 'bt-num', name);
  if (input.use) h(head, 'th');
  const body = h(table, 'tbody');
  const said = h(box, 'div', 'bt-note');
  said.setAttribute('role', 'status');
  for (const row of splitRows(input, alloc)) {
    const tr = h(body, 'tr', row.percents ? undefined : 'bt-split-written');
    h(tr, 'td', 'bt-split-name', row.name);
    for (const cell of [...row.weights, ...row.figures]) h(tr, 'td', 'bt-num', cell);
    if (!input.use) continue;
    const cell = h(tr, 'td');
    if (!row.percents) continue;
    const button = h(cell, 'button', 'bt-button bt-split-use', 'Use these weights');
    const percents = row.percents;
    const use = input.use;
    button.addEventListener('click', () => {
      button.disabled = true;
      said.textContent = 'The plugin writes the weights into the block…';
      use(percents).then(
        () => (said.textContent = `The plugin wrote ${percents.map((p) => `${p}%`).join(', ')} into the block.`),
        (e: unknown) => {
          button.disabled = false;
          said.textContent = e instanceof Error ? e.message : String(e);
        },
      );
    });
  }
  for (const note of splitNotes(alloc, input.labels, input.decimals)) h(box, 'div', 'bt-note', note);

  if (input.labels.length < 2) return;
  h(box, 'div', 'bt-split-heading', 'What each strategy adds');
  h(box, 'div', 'bt-note', 'Each value is the combined line at the written weights, less the same line without the strategy. The weight of the strategy goes to the other strategies in proportion. Above 0 is better for all three: more return, a smaller drawdown, a higher Sharpe ratio.');
  const addsTable = h(h(box, 'div', 'bt-scroll'), 'table', 'bt-table bt-split-table');
  const addsHead = h(h(addsTable, 'thead'), 'tr');
  h(addsHead, 'th');
  for (const name of ['Return per year', 'Worst drawdown', 'Sharpe ratio']) h(addsHead, 'th', 'bt-num', name);
  const addsBody = h(addsTable, 'tbody');
  for (const row of addsRows(input)) {
    const tr = h(addsBody, 'tr');
    h(tr, 'td', 'bt-split-name', row.label);
    for (const cell of row.cells) h(tr, 'td', 'bt-num', cell);
  }
}
