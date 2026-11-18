// The "Regimes and crises" section: how the strategy did in each state of the market, and through the market's worst falls.

import { h } from './dom.ts';
import { pct, signedPct, stamp } from './format.ts';
import { bucketStats, crisesFor, crisisResults, regimeBuckets, regimePlan, type BucketStats, type CrisisResult, type Growth, type Recovery, type RunSeries } from './regimes.ts';
import { cell } from './render-stats.ts';
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
  let gone = false;
  details.addEventListener('toggle', () => build(h(details, 'div', 'bt-regimes-body'), input, () => gone), { once: true });
  return () => {
    gone = true;
  };
}

/** "A", "A and B", "A, B and C". */
const list = (names: string[]): string => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function build(body: HTMLElement, input: RegimeInput, gone: () => boolean): void {
  const plan = regimePlan(input.universe);
  const from = input.run.t[0];
  const names = plan.refs.map((r) => r.name);
  h(body, 'div', 'bt-stats-heading bt-regimes-first', 'By market state');
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
    h(box, 'div', 'bt-note', `This reads the daily prices of ${list(names)} from ${plan.source}, which are not saved yet. They are fetched only when you press the button, and saved like any other prices.`);
    const row = h(box, 'div', 'bt-run-row');
    const button = h(row, 'button', 'bt-button mod-cta', `Load ${names.join(', ')} from ${plan.source}`);
    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = 'Loading…';
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
  h(box, 'div', 'bt-note', 'Looking for saved prices…');
  void input.saved(plan.refs, from, plan.lookback).then((got) => {
    if (gone()) return;
    if (got) show(got);
    else offer();
  });

  const falls = crisesFor(input.universe);
  h(body, 'div', 'bt-stats-heading', 'Market falls');
  crisisTable(body, input.benchmarkLabel, crisisResults(input.run, falls), input.intraday, falls.length);
}

const REGIME_NOTE =
  "Each step of the run is put in the state known at the close before it. A state is read from the ticker's own daily prices, so a weekly or hourly strategy gets the same state a daily one would. Returns are compounded over the steps in a state, per year once they add up to a year or more, and the benchmark's are over the same steps. Worst drawdown is the largest fall within one unbroken stretch in the state.";

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
            label: i < states.length ? states[i] : 'Not known yet',
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
  return r.kind === 'back' ? stamp(r.t, intraday) : r.kind === 'held' ? 'Never below it' : 'Not by the end';
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

function crisisTable(parent: HTMLElement, benchmarkLabel: string, results: CrisisResult[], intraday: boolean, known: number): void {
  if (results.length === 0) {
    h(parent, 'div', 'bt-note', `The run does not cover any of the ${known} market falls this section knows.`);
    return;
  }
  const wrap = h(parent, 'div', 'bt-scroll bt-regimes-scroll');
  const table = h(wrap, 'table', 'bt-table bt-regimes-table');
  const head = h(h(table, 'thead'), 'tr');
  h(head, 'th');
  for (const label of ['Strategy', benchmarkLabel, 'Worst drawdown', 'Invested', 'Back at its earlier high']) h(head, 'th', 'bt-num', label);
  const tbody = h(table, 'tbody');
  for (const result of results) {
    const row = crisisRow(result, intraday);
    const tr = h(tbody, 'tr');
    const first = h(tr, 'td', undefined, row.label);
    h(first, 'span', 'bt-regimes-dates', row.dates);
    for (const c of row.cells) cell(tr, ...c);
  }
  h(parent, 'div', 'bt-note', 'Each fall runs from the close of the market’s peak day to the close of its trough day, and is shown only when the run covers all of it. The earlier high is the strategy’s highest value before the fall began.');
}
