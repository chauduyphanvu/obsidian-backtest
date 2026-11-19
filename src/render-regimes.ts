// The "Regimes and crises" section: how the strategy did in each state of the market, and through the market's worst falls.

import { h } from './dom.ts';
import { pct, plural, signedPct, stamp } from './format.ts';
import { bucketStats, crisesFor, crisisResults, regimeBuckets, regimePlan, type BucketStats, type CrisisResult, type Growth, type Recovery, type RunSeries } from './regimes.ts';
import { cell } from './render-stats.ts';
import { dumbbell } from './render-versus.ts';
import { tabInfo } from './tabs.ts';
import { LEVEL, benchProse } from './verdict.ts';
import type { Extras } from './runner.ts';
import type { AssetRef } from './types.ts';

export interface RegimeInput {
  run: RunSeries;
  benchmarkLabel: string;
  intraday: boolean;
  universe: AssetRef[];
  /** The market's daily prices when they are all saved and fresh, so that reading them downloads nothing; otherwise null. */
  saved(refs: AssetRef[], from: number, lookback: number): Promise<Extras | null>;
  /** The market's daily prices, downloaded where they are not saved. */
  load(refs: AssetRef[], from: number, lookback: number): Promise<Extras>;
}

/** A figure with a quieter note after it. */
type Cell = [string, string | null];

/** Appends a collapsed "Regimes and crises" section to `parent`. Returns a cleanup function. The content is built the first time the section is opened. */
export function renderRegimes(parent: HTMLElement, input: RegimeInput): () => void {
  const details = h(parent, 'details', 'bt-details bt-regimes');
  h(details, 'summary', undefined, 'Regimes and crises');
  const falls = crisesFor(input.universe);
  const results = crisisResults(input.run, falls);
  const compared = results.filter((r) => Number.isFinite(r.benchmark));
  tabInfo(details, 'Regimes and crises', compared.length ? `better in ${compared.filter(better).length} of ${plural(compared.length, 'drawdown')}` : 'by market condition');
  let gone = false;
  details.addEventListener('toggle', () => build(h(details, 'div', 'bt-regimes-body'), input, results, falls.length, () => gone), { once: true });
  return () => {
    gone = true;
  };
}

/** Better than the benchmark by more than the Years tab calls level, so a near tie is not counted as a win. */
const better = (r: CrisisResult): boolean => r.strategy - r.benchmark > LEVEL;

/** "A", "A and B", "A, B and C". */
const list = (names: string[]): string => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function build(body: HTMLElement, input: RegimeInput, results: CrisisResult[], known: number, gone: () => boolean): void {
  const plan = regimePlan(input.universe);
  const from = input.run.t[0];
  const names = plan.refs.map((r) => r.name);
  h(body, 'div', 'bt-stats-heading bt-regimes-first', 'Market drawdowns');
  fallRows(body, input.benchmarkLabel, results, input.intraday, known);
  h(body, 'div', 'bt-stats-heading', 'By market condition');
  const box = h(body, 'div', 'bt-regimes-box');

  const show = (got: Extras): void => {
    box.replaceChildren();
    for (const warning of got.warnings) h(box, 'div', 'bt-note', warning);
    const groups = plan.regimes.map((regime) => {
      const stats = bucketStats(input.run, regimeBuckets(regime, got.data.get(regime.ref.name)!, input.run.t), 2);
      return { title: regime.title, rows: regimeRows(stats, regime.states) };
    });
    regimeTable(box, input.benchmarkLabel, groups);
    h(box, 'div', 'bt-note', REGIME_NOTE);
  };
  const offer = (problem?: string): void => {
    box.replaceChildren();
    if (problem) h(box, 'div', 'bt-note', problem);
    h(box, 'div', 'bt-note', `This section reads the daily prices of ${list(names)} from ${plan.source}. These prices are not saved at this time. The plugin downloads them only when you click the button, and saves them the same as other prices.`);
    const row = h(box, 'div', 'bt-run-row');
    const button = h(row, 'button', 'bt-button mod-cta', `Load ${names.join(', ')} from ${plan.source}`);
    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = 'Prices load…';
      input.load(plan.refs, from, plan.lookback).then(
        (got) => {
          if (!gone()) show(got);
        },
        (e) => {
          if (!gone()) offer(message(e));
        },
      );
    });
  };
  h(box, 'div', 'bt-note', 'The plugin looks for saved prices…');
  void input.saved(plan.refs, from, plan.lookback).then((got) => {
    if (gone()) return;
    if (got) show(got);
    else offer();
  });

}

const REGIME_NOTE =
  'The plugin puts each step of the run in the market condition that was known at the previous close. It reads each condition from the daily prices of its ticker. Thus a weekly or hourly strategy has the same condition as a daily strategy. Returns are compounded across the steps in a condition. When these steps make a year or more, the returns are per year. The benchmark returns use the same steps. Worst drawdown is the largest decrease in one continuous period in the condition.';

/** A return as a percentage, with "a year" or "in all" after it. */
export function growthCell(g: Growth): Cell {
  return Number.isFinite(g.value) ? [signedPct(g.value), g.perYear ? 'a year' : 'in all'] : ['–', null];
}

const share = (x: number): string => pct(x, x < 0.1 ? 1 : 0);

export interface Row {
  label: string;
  cells: Cell[];
}

/** The rows of one regime: its states in order, then the steps where it was not known, each only if the run had a step in it. */
export function regimeRows(stats: BucketStats[], states: string[]): Row[] {
  return stats.flatMap((s, i) =>
    s.steps === 0
      ? []
      : [
          {
            label: i < states.length ? states[i] : 'Not known',
            cells: [[share(s.share), null], growthCell(s.strategy), growthCell(s.benchmark), investedCell(s), [pct(s.worstDrawdown), null]] as Cell[],
          },
        ],
  );
}

function regimeTable(parent: HTMLElement, benchmarkLabel: string, groups: { title: string; rows: Row[] }[]): void {
  const wrap = h(parent, 'div', 'bt-scroll bt-regimes-scroll');
  const table = h(wrap, 'table', 'bt-table bt-regimes-table bt-regimes-states');
  const head = h(h(table, 'thead'), 'tr');
  h(head, 'th');
  for (const label of ['Time', 'Strategy', benchmarkLabel, 'Invested', 'Worst drawdown']) h(head, 'th', 'bt-num', label);
  const tbody = h(table, 'tbody');
  for (const group of groups) {
    if (group.rows.length === 0) continue;
    const title = h(h(tbody, 'tr', 'bt-regimes-group'), 'th', undefined, group.title);
    title.colSpan = 6;
    for (const row of group.rows) {
      const tr = h(tbody, 'tr');
      h(tr, 'td', undefined, row.label);
      for (const c of row.cells) cell(tr, ...c);
    }
  }
}

/** How the day the strategy was back at its earlier high is put, or why there is none. */
export function recoveryText(r: Recovery, intraday: boolean): string {
  return r.kind === 'back' ? stamp(r.t, intraday) : r.kind === 'held' ? 'Always at or above it' : 'Not by the end';
}

/** What was invested, gross, with the net beside it for a run that can borrow: "150%", "(net 50%)". */
export const investedCell = (s: { exposure: number; netExposure?: number }): Cell => [pct(s.exposure, 0), s.netExposure === undefined ? null : `net ${pct(s.netExposure, 0)}`];

/** The row of a fall: its name and days, then the figures. */
export function crisisRow(r: CrisisResult, intraday: boolean): Row & { dates: string } {
  return {
    label: r.crisis.name,
    dates: `${r.crisis.peak} to ${r.crisis.trough}`,
    cells: [[signedPct(r.strategy), null], [Number.isNaN(r.benchmark) ? '–' : signedPct(r.benchmark), null], [pct(r.worstDrawdown), null], investedCell(r), [recoveryText(r.recovery, intraday), null]],
  };
}

/**
 * Each market fall the run covers on a line of its own: what the strategy and its benchmark did over it, as two dots on a
 * scale shared by every fall, and under its name the strategy's worst drawdown in it, what it held, and when it was back
 * at its earlier high.
 */
function fallRows(parent: HTMLElement, benchmarkLabel: string, results: CrisisResult[], intraday: boolean, known: number): void {
  if (results.length === 0) {
    h(parent, 'div', 'bt-note', `The run includes none of the ${known} market drawdowns that this section knows.`);
    return;
  }
  const bench = benchProse(benchmarkLabel);
  const compared = results.filter((r) => Number.isFinite(r.benchmark));
  const won = compared.filter(better);
  if (compared.length > 0) {
    let lead = `The strategy did better than ${bench} in ${won.length} of the ${plural(compared.length, 'market drawdown')} in the run.`;
    const closest = won.length === compared.length ? won.reduce((a, r) => (r.strategy - r.benchmark < a.strategy - a.benchmark ? r : a)) : null;
    if (closest && compared.length > 1 && closest.strategy - closest.benchmark < 0.01) lead += ` In the ${closest.crisis.name}, by only ${((closest.strategy - closest.benchmark) * 100).toFixed(1)} points.`;
    h(parent, 'p', 'bt-tab-lead', lead);
  }
  const values = results.flatMap((r) => [r.strategy, r.benchmark]).filter(Number.isFinite);
  const [lo, hi] = [Math.min(0, ...values), Math.max(0, ...values)];
  const list = h(parent, 'div', 'bt-vs bt-falls');
  const head = h(list, 'div', 'bt-vs-row bt-vs-head');
  h(head, 'span', 'bt-vs-label');
  const sKey = h(head, 'span', 'bt-vs-s bt-vs-key');
  h(sKey, 'span', 'bt-vs-key-dot bt-dumbbell-strategy');
  sKey.append('Strategy');
  h(head, 'span', 'bt-vs-track');
  const bKey = h(head, 'span', 'bt-vs-b bt-vs-key');
  h(bKey, 'span', 'bt-vs-key-dot bt-dumbbell-benchmark');
  bKey.append(benchmarkLabel);
  for (const r of results) {
    const row = crisisRow(r, intraday);
    const line = h(list, 'div', 'bt-vs-row');
    const name = h(line, 'span', 'bt-vs-label');
    h(name, 'span', 'bt-fall-name', row.label);
    const [worst, invested, back] = [row.cells[2], row.cells[3], row.cells[4]];
    h(name, 'span', 'bt-regimes-dates', `${row.dates} · worst ${worst[0]} · held ${invested[0]}${invested[1] ? ` (${invested[1]})` : ''} · back at its high: ${back[0].toLowerCase()}`);
    const s = h(line, 'span', 'bt-vs-s');
    h(s, 'span', 'bt-vs-value', row.cells[0][0]);
    dumbbell(line, r.strategy, r.benchmark, lo, hi).classList.add('bt-vs-track');
    const b = h(line, 'span', 'bt-vs-b');
    h(b, 'span', 'bt-vs-value', row.cells[1][0]);
  }
  h(parent, 'div', 'bt-note', 'Each market drawdown starts at the close of the peak day of the market and stops at the close of its trough day. The plugin shows it only when the run includes all of it. "Worst" is the deepest drawdown of the strategy in the market drawdown. "Its high" is the highest value of the strategy before the market drawdown started.');
}
