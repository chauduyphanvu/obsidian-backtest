// The "Was it luck?" section: how many tries the block has had, reshuffled history, random entries and walk-forward, each
// with a plain verdict first.

import type { Backtest } from './backtest.ts';
import type { Param } from './dsl.ts';
import { h, s } from './dom.ts';
import { isoDate, localDate, minus, money, moneyTicks, niceStep, pct, plural, tidy, timeTicks } from './format.ts';
import type { JobOf, Kind, Results } from './jobs.ts';
import { follow, trialOf, trialSpread, type BlockLedger, type Ledger } from './ledger.ts';
import { monthOfBars, type BootstrapResult, type RandomEntriesResult, type WalkForwardResult } from './luck.ts';
import { deflatedSharpe, excessReturns, stepSharpe, stepsPerYear, type Deflated } from './overfit.ts';
import { formatParam } from './render-params.ts';
import { CHAR, observe, placeTip, progressBar, valuesText, did, WAITING, type Life, type SweepInput } from './render-sweep.ts';
import { METRICS, sweepParams } from './sweep.ts';
import { blockJobs, type BlockJobs } from './worker-client.ts';

const DEFAULT_SEED = 1;
const RANDOM_RUNS = 200;
const RESHUFFLES = 1000;

/** Appends a collapsed "Was it luck?" section. Returns a cleanup function. */
export function renderLuck(parent: HTMLElement, input: SweepInput): () => void {
  const life: Life = { gone: false, observers: [] };
  const jobs = blockJobs(input);
  // Each check redraws on its own (Shuffle again redoes two of three), so each keeps its own observers.
  const blocks = new Map<HTMLElement, Life>();
  const details = h(parent, 'details', 'bt-details bt-luck');
  h(details, 'summary', undefined, 'Was it luck?');
  let stopTries = () => {};
  details.addEventListener('toggle', () => (stopTries = build(h(details, 'div', 'bt-luck-body'), input, life, blocks, jobs)), { once: true });
  return () => {
    life.gone = true;
    stopTries();
    jobs.close();
    for (const b of blocks.values()) for (const o of b.observers) o.disconnect();
  };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How the values a slider set are named in the walk-forward, where they stand in for the note's. */
interface Ours {
  noun: string;
  label: string;
  column: string;
}
const NOTE: Ours = { noun: 'the values in the note', label: 'Values in the note', column: 'In the note' };
const SHOWN: Ours = { noun: 'the values shown', label: 'Values shown', column: 'Shown' };

/**
 * The line saying which values the checks used, when the run on screen was drawn with other values than the block's (a
 * slider moved): the checks test that run (jobs.ts jobOverrides). Null when it is the block as written.
 */
export function valuesUsed(params: Param[]): string | null {
  const moved = params.filter((p) => tidy(p.value) !== tidy(p.declared));
  if (moved.length === 0) return null;
  const list = (value: (p: Param) => number) => moved.map((p) => `${p.name} ${formatParam(p, value(p))}`).join(', ');
  return `These checks examine the run shown, with ${list((p) => p.value)}. The values in the block are ${list((p) => p.declared)}.`;
}

/** Fills the section; returns what stops its count of tries from following the record. */
function build(body: HTMLElement, input: SweepInput, life: Life, blocks: Map<HTMLElement, Life>, jobs: BlockJobs): () => void {
  const bt = input.backtest;
  const ranged = sweepParams(bt.spec).length > 0;
  h(
    body,
    'p',
    'bt-luck-intro',
    ranged
      ? 'These three checks look for signs that the result is luck. They run more backtests on the prices that are loaded.'
      : 'These two checks look for signs that the result is luck. They run more backtests on the prices that are loaded. A third check, walk-forward, is available when a parameter has a range, for example fast = 50 in 20..100 step 10.',
  );
  const used = valuesUsed(bt.spec.params);
  const ours = used ? SHOWN : NOTE;
  if (used) h(body, 'p', 'bt-note', used);
  let stopTries = () => {};
  if (input.ledger) stopTries = triesBlock(h(body, 'div'), input.ledger, bt);
  else if (input.unnamed) unnamedTries(h(body, 'div'), input.unnamed.rename);
  const controls = h(body, 'div', 'bt-run-row');
  const run = h(controls, 'button', 'bt-button mod-cta', 'Run checks');
  const progress = progressBar(controls);
  const stop = h(controls, 'button', 'bt-button', 'Stop');
  stop.hidden = true;
  const seedRow = h(body, 'div', 'bt-luck-seed');
  seedRow.hidden = true;
  const seedText = h(seedRow, 'span');
  const shuffle = h(seedRow, 'button', 'bt-button', 'Shuffle again');
  const boot = h(body, 'div');
  const random = h(body, 'div');
  const walk = h(body, 'div');

  let seed = DEFAULT_SEED;
  let running: { stop(): void } | null = null;
  // One set of checks at a time: each shares `running`, which Stop ends.
  const busy = (on: boolean) => {
    stop.hidden = !on;
    progress.show(on);
    shuffle.disabled = on;
    run.disabled = on;
  };
  stop.addEventListener('click', () => running?.stop());
  /** A fresh set of observers for a check's block, the old ones disconnected. */
  const lifeOf = (el: HTMLElement): Life => {
    for (const o of blocks.get(el)?.observers ?? []) o.disconnect();
    const mine: Life = { gone: false, observers: [] };
    blocks.set(el, mine);
    return mine;
  };
  /** Runs one check, which Stop ends; null when it was stopped with nothing to show. */
  const step = async <K extends Kind>(job: JobOf<K>, first: string, label?: (done: number, total: number) => string): Promise<Results[K] | null> => {
    progress.set(0, 1, first);
    const r = jobs.run(job, {
      onProgress: label && ((d, n) => progress.set(d, n, label(d, n))),
      onWait: (waiting) => progress.set(0, 1, waiting ? WAITING : first),
    });
    running = r;
    try {
      return await r.done;
    } finally {
      running = null;
    }
  };

  /** The two checks that draw at random; returns false when stopped or failed. */
  const randomChecks = async (): Promise<boolean> => {
    let b: BootstrapResult | null;
    try {
      b = await step({ kind: 'reshuffle', seed, runs: RESHUFFLES }, 'Reshuffled history…');
    } catch (e) {
      if (!life.gone) bootBlock(boot, lifeOf(boot), bt, message(e));
      return false;
    }
    // Stopped: what was shown before stays, seed and all.
    if (life.gone || !b) return false;
    bootBlock(boot, lifeOf(boot), bt, b);
    let r: RandomEntriesResult | null = null;
    try {
      r = await step({ kind: 'random', seed, runs: RANDOM_RUNS }, `Random entries: 0 of ${RANDOM_RUNS}`, (d, n) => `Random entries: ${d} of ${n}`);
      if (life.gone) return false;
      randomBlock(random, lifeOf(random), bt, r && !(r.stopped && r.runs === 0) ? r : 'The check stopped before the first try. Run the checks again.', RANDOM_RUNS);
    } catch (e) {
      if (life.gone) return false;
      randomBlock(random, lifeOf(random), bt, message(e), RANDOM_RUNS);
    }
    seedText.textContent = `Random draws use seed ${seed}. `;
    seedRow.hidden = false;
    return r !== null && !r.stopped;
  };

  run.addEventListener('click', async () => {
    run.hidden = true;
    busy(true);
    try {
      let finished = await randomChecks();
      if (finished && ranged) {
        walk.replaceChildren();
        try {
          const w = await step({ kind: 'walk' }, 'Walk-forward…', (d, n) => `Walk-forward: ${d} of ${n} backtests`);
          if (w) void input.ledger?.add(w.trials);
          if (life.gone) return;
          if (w) walkBlock(walk, lifeOf(walk), w, ours);
          else {
            walkBlock(walk, lifeOf(walk), 'The check stopped before the end. Run the checks again.', ours);
            finished = false;
          }
        } catch (e) {
          if (life.gone) return;
          walkBlock(walk, lifeOf(walk), message(e), ours);
        }
      }
      if (life.gone) return;
      if (!finished) {
        run.textContent = 'Run checks again';
        run.hidden = false;
      }
    } finally {
      busy(false);
    }
  });
  shuffle.addEventListener('click', async () => {
    seed = 1 + Math.floor(Math.random() * 99_999);
    busy(true);
    try {
      await randomChecks();
    } finally {
      busy(false);
    }
  });
  return stopTries;
}

function check(el: HTMLElement, title: string): HTMLElement {
  el.replaceChildren();
  const sec = h(el, 'section', 'bt-luck-check');
  h(sec, 'div', 'bt-luck-heading', title);
  return sec;
}

const how = (sec: HTMLElement, works: string, cannot: string) => {
  const p = h(sec, 'p', 'bt-note bt-luck-how');
  h(p, 'strong', undefined, 'How it works: ');
  p.append(works + ' ');
  h(p, 'strong', undefined, 'What it cannot tell you: ');
  p.append(cannot);
};

function legend(parent: HTMLElement, items: [string, string][]): void {
  const row = h(parent, 'div', 'bt-legend');
  for (const [cls, label] of items) {
    const k = h(row, 'span', 'bt-key');
    h(k, 'span', `bt-swatch ${cls}`);
    h(k, 'span', undefined, label);
  }
}

// ---------------------------------------------------------------- how many tries

/** What "How many tries" reads for the run on screen. */
export interface Tries {
  /** Distinct tries of the block counted: sets of rules and values that ran and traded. */
  n: number;
  /** When the count began: when it was last started again, or else the first try; null before any. */
  since: number | null;
  /** The run's Sharpe ratio a year. */
  sharpe: number;
  /** The deflated Sharpe ratio, and SR₀ a year as `bar`; null when it can't be told, `why` saying why. */
  deflated: (Deflated & { bar: number }) | null;
  why: 'no trades' | 'flat' | 'short' | 'shape' | null;
}

export function triesOf(ledger: Ledger, bt: Backtest): Tries {
  const trials = Object.values(ledger.trials);
  let first = Infinity;
  for (const t of trials) first = Math.min(first, t[2]);
  const since = ledger.resetAt > 0 ? ledger.resetAt : trials.length ? first : null;
  const base = { n: trials.length, since, sharpe: bt.stats.sharpe };
  if (bt.run.trades.length === 0) return { ...base, deflated: null, why: 'no trades' };
  const shape = stepSharpe(excessReturns(bt.run.equity, bt.run.cashReturn));
  if (!shape) return { ...base, deflated: null, why: 'flat' };
  const perYear = stepsPerYear(bt.run.t);
  const spread = trialSpread(ledger, perYear);
  // The run on screen is a try even before its count has been written.
  const d = deflatedSharpe(shape, Math.max(1, spread.trials), spread.variance);
  if (!d) return { ...base, deflated: null, why: shape.steps < 3 ? 'short' : 'shape' };
  return { ...base, deflated: { ...d, bar: d.sr0 * Math.sqrt(perYear) }, why: null };
}

const chance = (p: number) => (p > 0.995 ? 'more than 99%' : p < 0.005 ? 'less than 1%' : `approximately ${pct(p, 0)}`);
const ratio = (x: number) => minus(x.toFixed(2));
const sinceText = (t: Tries) => (t.since === null ? '' : ` since ${localDate(t.since)}`);
const counted = (t: Tries) =>
  `The plugin counted ${plural(t.n, 'try', 'tries')} of this block${sinceText(t)}`;

/** The verdict of "How many tries", in words. */
export function triesWords(t: Tries): string {
  const cannot: Record<NonNullable<Tries['why']>, string> = {
    'no trades': 'The run shown made no trades. Thus the count does not include it, and it has no Sharpe ratio to examine.',
    flat: 'The returns of the run shown are almost the same as the returns of cash. Thus it has no Sharpe ratio to examine.',
    short: 'The run shown does not have sufficient bars to examine its Sharpe ratio.',
    shape: 'The plugin cannot calculate this. The returns of the run are too skewed or heavy-tailed, and the margin of error on its Sharpe ratio is not usable.',
  };
  if (!t.deflated) return `${counted(t)}. ${cannot[t.why ?? 'shape']}`;
  const d = t.deflated;
  const verdict =
    d.dsr >= 0.95
      ? 'This is a strong sign of an edge, for these tries.'
      : d.dsr >= 0.5
        ? 'This is not a strong sign: the result can be luck.'
        : 'The probability of luck is higher than the probability of an edge.';
  if (t.n <= 1) {
    return `The plugin counted only the run shown${sinceText(t)}. Thus no correction for other tries is necessary. For the length and shape of its returns, the probability that its Sharpe ratio of ${ratio(t.sharpe)} shows an edge is ${chance(d.dsr)}. ${verdict}`;
  }
  return (
    `${counted(t)}. If there is no edge, the best of ${plural(t.n, 'try', 'tries')} of this type usually has a Sharpe ratio of approximately ${ratio(d.bar)}. The run shown has ${ratio(t.sharpe)}. ` +
    `After this correction, the probability that its Sharpe ratio shows an edge, and not luck in the selection of the best try, is ${chance(d.dsr)}. ${verdict}`
  );
}

/** Why the count overstates the tries. */
export const upperBound = (n: number) =>
  `${n.toLocaleString('en-US')} is the maximum number of different tries. Variants that are near each other give almost the same results. Thus the number of different tries is smaller, and the probability above is possibly too low.`;

/** The line under the result's figures; null when there is nothing to allow for. */
export function triesNote(t: Tries): string | null {
  if (t.n <= 1) return null;
  const see = 'See "How many tries" in "Was it luck?".';
  return t.deflated
    ? `The plugin counted ${plural(t.n, 'try', 'tries')} of this block to date. After a correction for them, the probability that this Sharpe ratio shows an edge is ${chance(t.deflated.dsr)}. ${see}`
    : `The plugin counted ${plural(t.n, 'try', 'tries')} of this block to date. ${see}`;
}

export const RESET = 'Start the count again';

export const UNNAMED = 'The plugin counts tries and keeps versions only for a strategy with a name. This strategy has no name. Thus the plugin does not correct its Sharpe ratio for other tries.';
export const ADD_NAME = 'To start the count, add a name line to the block, for example name: Trend.';
export const NAME_IT = 'Give the strategy a name';

/** Draws "How many tries" for a block with no name, which keeps no count: why, and the button that gives it a name, or how to add one where the block can't be edited. */
function unnamedTries(el: HTMLElement, rename?: () => void): void {
  const sec = check(el, 'How many tries');
  h(sec, 'p', 'bt-luck-verdict', rename ? UNNAMED : `${UNNAMED} ${ADD_NAME}`);
  if (rename) h(h(sec, 'div', 'bt-run-row'), 'button', 'bt-button', NAME_IT).addEventListener('click', rename);
}

/** Draws the count of tries, following the record as it changes; returns what stops it following. */
function triesBlock(el: HTMLElement, ledger: BlockLedger, bt: Backtest): () => void {
  let gone = false;
  const draw = (l: Ledger) => {
    if (gone) return;
    const sec = check(el, 'How many tries');
    const t = triesOf(l, bt);
    h(sec, 'p', 'bt-luck-verdict', triesWords(t));
    if (t.n > 1) h(sec, 'p', 'bt-note', upperBound(t.n));
    if (t.n > 0) {
      const row = h(sec, 'div', 'bt-run-row bt-ledger-reset');
      const ask = h(row, 'button', 'bt-button', RESET);
      ask.addEventListener('click', () => {
        row.replaceChildren();
        h(row, 'span', 'bt-ledger-ask', `Remove the ${plural(t.n, 'try', 'tries')} counted to date and start the count again from this run?`);
        const yes = h(row, 'button', 'bt-button mod-warning', 'Start again');
        const no = h(row, 'button', 'bt-button', 'Keep the count');
        no.addEventListener('click', () => draw(l));
        yes.addEventListener('click', async () => {
          yes.disabled = no.disabled = true;
          await ledger.reset();
          // The run on screen is the first try of the new count.
          await ledger.add([trialOf(bt.spec, bt)]);
        });
      });
    }
    how(
      sec,
      'The count includes each run shown in the note or the preview panel, each slider position, and each variant of a sweep or walk-forward. Each set of rules and values that traded counts one time. Two blocks that trade the same count one time, also when their text is different. The deflated Sharpe ratio (Bailey and López de Prado, 2014) calculates the best Sharpe ratio that this number of tries usually has with no edge. It uses the spread of their Sharpe ratios. Then it calculates the probability that the run shown is above this value. It uses the length of the history and the skew and heavy tails of the returns.',
      'The count does not include tries in other places, for example in a different program or in a previous copy of the block. It also does not include ideas that you did not run, or the reshuffles and random entries of these checks. Runs of the orders window and of compare and backtests blocks are not in the count. The count is for one block only. A new name line starts a new count. A move or a copy of the block to a different note also starts a new count. If the plugin finds the first block, a line at the top of the result offers to add its tries.',
    );
  };
  const unwatch = follow(ledger, draw);
  return () => {
    gone = true;
    unwatch();
  };
}

/** Writes the line under the result's figures, following the record as it changes; returns what stops it following. */
export function renderTriesNote(el: HTMLElement, ledger: BlockLedger, bt: Backtest): () => void {
  let gone = false;
  const draw = (l: Ledger) => {
    if (!gone) el.textContent = triesNote(triesOf(l, bt)) ?? '';
  };
  const unwatch = follow(ledger, draw);
  return () => {
    gone = true;
    unwatch();
  };
}

// ---------------------------------------------------------------- reshuffled history

/**
 * What the reshuffled history shows, and what it does not. Every version is built from the run's own returns, so it says
 * how much the path and the drawdown depended on the order, not whether the return itself was luck.
 */
export function reshuffleVerdict(r: BootstrapResult): string {
  const lost = r.lossShare === 0 ? '' : ` ${pct(r.lossShare, r.lossShare < 0.01 ? 1 : 0)} of the reshuffled versions had a last value below the initial value.`;
  const milder =
    r.actual.maxDrawdown > r.maxDrawdown.median
      ? ' The worst drawdown of this run was smaller than in most of them. Deeper drawdowns than the backtest shows are possible.'
      : r.actual.maxDrawdown < r.maxDrawdown.lo
        ? ' The worst drawdown of this run was deeper than in almost all of them. Its losses came in a long series, and the reshuffle breaks this series into pieces. Thus the reshuffled drawdowns show the risk as smaller than it is.'
        : '';
  return (
    'This check shows how much the sequence of the returns changed the path and the drawdown. ' +
    `The plugin made ${plural(r.runs, 'reshuffle')} of the returns of this run. The middle 90% made between ${pct(r.cagr.lo)} and ${pct(r.cagr.hi)} a year (this run: ${pct(r.actual.cagr)}). Their worst drawdowns were between ${pct(r.maxDrawdown.lo)} and ${pct(r.maxDrawdown.hi)} (this run: ${pct(r.actual.maxDrawdown)}).` +
    `${milder}${lost} It does not show if the average return will continue, because each version uses the returns of this run.`
  );
}

function bootBlock(el: HTMLElement, life: Life, bt: Backtest, r: BootstrapResult | string): void {
  const sec = check(el, 'Reshuffled history');
  if (typeof r === 'string') {
    h(sec, 'p', 'bt-luck-verdict', r);
    return;
  }
  if (bt.run.trades.length === 0) {
    h(sec, 'p', 'bt-luck-verdict', 'The strategy made no trades. Thus there is nothing to reshuffle.');
    return;
  }
  h(sec, 'p', 'bt-luck-verdict', reshuffleVerdict(r));
  legend(sec, [
    ['bt-luck-swatch-sim', 'Reshuffled versions'],
    ['bt-luck-swatch-band', 'Middle 90%'],
    ['bt-swatch-strategy', 'This run'],
  ]);
  const pair = h(sec, 'div', 'bt-luck-pair');
  histogram(pair, life, { title: 'Return per year', values: r.cagr.values, mark: r.actual.cagr, markLabel: 'This run', band: [r.cagr.lo, r.cagr.hi], noun: 'versions', made: (a, b) => `made ${a} to ${b} a year` });
  histogram(pair, life, {
    title: 'Worst drawdown',
    values: r.maxDrawdown.values,
    mark: r.actual.maxDrawdown,
    markLabel: 'This run',
    band: [r.maxDrawdown.lo, r.maxDrawdown.hi],
    noun: 'versions',
    made: (a, b) => `worst drawdown ${a} to ${b}`,
  });
  const step = bt.spec.interval === '1d' ? 'daily' : bt.spec.interval === '1w' ? 'weekly' : 'bar-by-bar';
  how(
    sec,
    `The plugin cuts the ${step} results of the run into pieces of ${plural(r.blockBars, 'bar')} (${r.blockBars > monthOfBars(bt.run.t) ? 'the length of a typical holding, thus a position stays in one piece' : 'approximately a month'}). Then it puts the pieces together again in a random sequence, ${plural(r.runs, 'time')}. Each piece keeps its increases and decreases. Only the sequence changes.`,
    'It uses only pieces of this run. Thus it cannot show a market that the run did not see. It also breaks up price moves that are longer than a piece. If you selected these rules because they looked good on this history, each reshuffle keeps that luck.',
  );
}

// ---------------------------------------------------------------- random entries

const andList = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * What a random-timing try keeps from the strategy; names the commission, the entries and the margin terms only when it
 * has them, and each trade's side when it made `shorts`.
 */
export function randomTimingWorks(spec: Pick<Backtest['spec'], 'commission' | 'entries' | 'margin'>, shorts = false): string {
  const borrows = spec.margin ? [...(shorts ? ['borrow fee'] : []), 'margin rate'] : [];
  const same = andList(['weights', 'costs', ...(spec.commission ? ['commission'] : []), 'slippage', ...(spec.entries ? ['entries'] : []), 'cash rate', ...borrows]);
  const later = spec.entries ? ' A position with more than one entry keeps its number of entries. Its subsequent entries are the same number of bars after its first entry.' : '';
  const kept = shorts ? 'the number of trades of each ticker, the side of each trade (long or short), and how long each trade was held' : 'the number of trades of each ticker and how long each trade was held';
  return `Each try keeps ${kept}, with the same ${same}. It puts those holdings at random dates.${later} Stops are off, because the holding lengths include their exits.`;
}

/** What a random-picks try keeps from the strategy. */
export function randomPicksWorks(spec: Pick<Backtest['spec'], 'commission' | 'entries'>, trades: string, against: number): string {
  const same = andList(['rules', 'dates', 'number held', 'stops', 'costs', ...(spec.commission ? ['commission'] : []), ...(spec.entries ? ['entries'] : [])]);
  return `Each try uses the same ${same}. But it ranks the tickers that the rules let it hold in a random sequence, not by the score. Each random pick stays for some time. Thus the tries trade approximately as frequently as the strategy (${trades} on average, compared with ${against}).`;
}

/**
 * What the random entries showed, or why they did not run. `shorts`: the strategy held short positions, which count as
 * time in its tickers as long ones do.
 */
export function randomVerdict(r: RandomEntriesResult, picks: boolean, shorts: boolean, asked: number): string {
  const who = picks ? 'Random picks' : 'Random timing';
  const skip: Record<NonNullable<RandomEntriesResult['skip']>, string> = {
    'no-trades': 'The strategy made no trades. Thus there is nothing to compare.',
    'always-invested': `The strategy holds its tickers${shorts ? ', long or short,' : ''} all the time. Thus there is no timing to change.`,
    'holds-everything': 'The ranking holds all tickers in the universe. Thus there is no pick to change.',
  };
  if (r.skip) return skip[r.skip];
  const share = r.atLeast.cagr / r.runs;
  const shareRatio = r.atLeast.ratio / r.runs;
  const lines = [
    `${who} had a return per year equal to or better than the strategy in ${r.atLeast.cagr} of ${plural(r.runs, 'try', 'tries')} (${pct(share, 0)}). On return per year ÷ worst drawdown, ${who.toLowerCase()} was equal or better in ${r.atLeast.ratio} (${pct(shareRatio, 0)}).`,
    share <= 0.05
      ? `Only a small number of tries were equal or better. Thus it is very possible that the ${picks ? 'ranking' : 'timing of the rules'} adds value. But a strategy that you selected from many tries can also have this result by luck.`
      : share <= 0.2
        ? 'This number is not sufficiently small to show that the result is not luck.'
        : `${who} frequently had an equal or better result. Thus this result does not show that the ${picks ? 'ranking' : 'timing of the rules'} adds value.`,
  ];
  if (!picks && r.invested >= 0.9) {
    lines.push(`The strategy is ${shorts ? 'in its tickers, long or short,' : 'invested'} ${pct(r.invested, 0)} of the time. Thus random timing is almost the same as holding all the time, and this check does not show much.`);
  }
  if (r.stopped) lines.push(`The check stopped after ${r.runs} of ${asked} tries.`);
  return lines.join(' ');
}

function randomBlock(el: HTMLElement, life: Life, bt: Backtest, r: RandomEntriesResult | string, asked: number): void {
  const picks = bt.spec.rank !== null;
  const sec = check(el, picks ? 'Random picks' : 'Random entries');
  if (typeof r === 'string') {
    h(sec, 'p', 'bt-luck-verdict', r);
    return;
  }
  const shorts = bt.run.trades.some((t) => t.side === 'short');
  h(sec, 'p', 'bt-luck-verdict', randomVerdict(r, picks, shorts, asked));
  if (r.skip) return;
  legend(sec, [
    ['bt-luck-swatch-sim', picks ? 'Random picks' : 'Random timing'],
    ['bt-swatch-strategy', 'Strategy'],
  ]);
  histogram(h(sec, 'div', 'bt-luck-pair bt-luck-single'), life, {
    title: 'Return per year',
    values: [...r.random.cagr].sort((a, b) => a - b),
    mark: r.strategy.cagr,
    markLabel: 'Strategy',
    noun: 'tries',
    made: (a, b) => `made ${a} to ${b} a year`,
  });
  const avg = Math.round(r.random.trades.reduce((x, n) => x + n, 0) / Math.max(1, r.random.trades.length));
  if (picks) {
    how(
      sec,
      randomPicksWorks(bt.spec, plural(avg, 'trade'), r.strategy.trades),
      'It examines only the ranking. Your rules set when to be invested and which tickers it can hold, in the strategy and in the tries. A result better than random picks on this history does not show that the ranking will continue to do better.',
    );
  } else {
    how(
      sec,
      randomTimingWorks(bt.spec, shorts),
      `It examines when the rules ${shorts ? 'open and close positions' : 'buy and sell'}, not which tickers they hold. A result better than random timing on this history does not show that the rules will continue to do better.`,
    );
  }
}

// ---------------------------------------------------------------- histogram

interface HistOpts {
  title: string;
  /** Ascending. */
  values: number[];
  mark: number;
  markLabel: string;
  band?: [number, number];
  noun: string;
  /** "made 4% to 5% a year": what the tries in one bar did. */
  made: (lo: string, hi: string) => string;
}

function histogram(parent: HTMLElement, life: Life, o: HistOpts): void {
  const box = h(parent, 'div', 'bt-luck-hist');
  h(box, 'div', 'bt-luck-hist-title', o.title);
  const chart = h(box, 'div', 'bt-chart');
  const tip = h(chart, 'div', 'bt-tip');
  tip.hidden = true;
  observe(life, chart, (width) => drawHistogram(chart, tip, width, o));
}

function drawHistogram(chart: HTMLElement, tip: HTMLElement, width: number, o: HistOpts): void {
  chart.querySelector('svg')?.remove();
  tip.hidden = true;
  const values = o.values.filter(Number.isFinite);
  const left = 34;
  const right = 10;
  const top = 24;
  const plotH = 96;
  const height = top + plotH + 22;
  const plotW = width - left - right;
  let lo = Math.min(values[0], o.mark);
  let hi = Math.max(values[values.length - 1], o.mark);
  if (hi - lo < 1e-9) [lo, hi] = [lo - 0.005, hi + 0.005];
  const binW = niceStep(hi - lo, Math.max(6, Math.min(36, Math.floor(plotW / 10))));
  // Half a bin of room on each side, so a mark at the extreme does not sit on the edge.
  const start = Math.floor((lo - binW / 2) / binW) * binW;
  const nb = Math.max(1, Math.floor((hi + binW / 2 - start) / binW) + 1);
  const counts = new Array<number>(nb).fill(0);
  for (const v of values) counts[Math.min(nb - 1, Math.floor((v - start) / binW + 1e-9))]++;
  const end = start + nb * binW;
  const x = (v: number) => left + ((v - start) / (end - start)) * plotW;
  const maxCount = Math.max(...counts, 1);
  const cStep = Math.max(1, niceStep(maxCount, 2));
  const yMax = Math.ceil(maxCount / cStep) * cStep;
  const y = (c: number) => top + plotH - (c / yMax) * plotH;

  const svg = s(chart, 'svg', { width, height, class: 'bt-svg', role: 'img', 'aria-label': `${o.title} of ${values.length} ${o.noun}, with a line at ${o.markLabel.toLowerCase()}` });
  if (o.band) s(svg, 'rect', { x: x(o.band[0]), y: top, width: Math.max(1, x(o.band[1]) - x(o.band[0])), height: plotH, class: 'bt-luck-band' });
  for (let c = cStep; c <= yMax; c += cStep) {
    s(svg, 'line', { x1: left, x2: width - right, y1: y(c), y2: y(c), class: 'bt-grid' });
    s(svg, 'text', { x: left - 6, y: y(c) + 3.5, class: 'bt-axis', 'text-anchor': 'end' }, String(c));
  }
  const barPx = plotW / nb;
  counts.forEach((c, i) => {
    if (c === 0) return;
    const gap = barPx > 4 ? 1 : 0;
    s(svg, 'rect', { x: x(start + i * binW) + gap, y: y(c), width: Math.max(1, barPx - 2 * gap), height: y(0) - y(c), rx: Math.min(2, barPx / 4), class: 'bt-luck-bar' });
  });
  s(svg, 'line', { x1: left, x2: width - right, y1: y(0), y2: y(0), class: 'bt-baseline' });
  const tickStep = niceStep(end - start, Math.max(2, Math.floor(plotW / 64)));
  const digits = tickStep >= 0.01 ? 0 : 1;
  for (let v = Math.ceil(start / tickStep) * tickStep; v <= end + 1e-12; v += tickStep) {
    const text = pct(Math.abs(v) < tickStep / 1e6 ? 0 : v, digits);
    const half = (text.length * CHAR) / 2;
    // Kept inside the chart: an end label leans inward instead of being cut off.
    const anchor = x(v) + half > width ? 'end' : x(v) - half < 0 ? 'start' : 'middle';
    s(svg, 'text', { x: anchor === 'end' ? width - 1 : anchor === 'start' ? 1 : x(v), y: height - 6, class: 'bt-axis', 'text-anchor': anchor }, text);
  }

  const mx = x(o.mark);
  s(svg, 'line', { x1: mx, x2: mx, y1: top - 6, y2: top + plotH, class: 'bt-luck-mark' });
  const label = `${o.markLabel} ${pct(o.mark)}`;
  const w = label.length * CHAR;
  const anchorEnd = mx + w + 4 > width - right;
  s(svg, 'text', { x: anchorEnd ? Math.max(w, mx - 4) : Math.max(0, mx + 4), y: top - 10, class: 'bt-axis bt-panel-label', 'text-anchor': anchorEnd ? 'end' : 'start' }, label);

  const hl = s(svg, 'rect', { y: top, width: barPx, height: plotH, class: 'bt-luck-hl', visibility: 'hidden' });
  const hit = s(svg, 'rect', { x: left, y: top, width: plotW, height: plotH + 20, fill: 'transparent' });
  const show = (clientX: number) => {
    const i = Math.min(nb - 1, Math.max(0, Math.floor((clientX - svg.getBoundingClientRect().left - left) / barPx)));
    hl.setAttribute('x', String(x(start + i * binW)));
    hl.setAttribute('visibility', 'visible');
    tip.replaceChildren();
    h(tip, 'div', 'bt-tip-date', `${counts[i]} of ${values.length} ${o.noun}`);
    h(tip, 'div', undefined, o.made(pct(start + i * binW), pct(start + (i + 1) * binW)));
    placeTip(tip, x(start + (i + 1) * binW), top, width);
  };
  hit.addEventListener('pointermove', (e) => show((e as PointerEvent).clientX));
  hit.addEventListener('pointerdown', (e) => show((e as PointerEvent).clientX));
  hit.addEventListener('pointerleave', () => {
    tip.hidden = true;
    hl.setAttribute('visibility', 'hidden');
  });
}

// ---------------------------------------------------------------- walk-forward

const span = (months: number) => (months % 12 === 0 ? plural(months / 12, 'year') : plural(months, 'month'));
const unit = (months: number) => (months === 12 ? 'year' : months === 6 ? 'half-year' : months === 3 ? 'quarter' : `${months}-month period`);

function stretch(from: number, to: number): string {
  const a = isoDate(from);
  const b = isoDate(to);
  if (a.slice(5) === '01-01' && b.slice(5) === '12-31' && a.slice(0, 4) === b.slice(0, 4)) return a.slice(0, 4);
  return `${a} to ${b}`;
}

function walkBlock(el: HTMLElement, life: Life, w: WalkForwardResult | string, ours: Ours): void {
  const sec = check(el, 'Walk-forward');
  if (typeof w === 'string') {
    h(sec, 'p', 'bt-luck-verdict', w);
    return;
  }
  const label = METRICS[w.metric].noun;
  const test = unit(w.testMonths);
  const first = isoDate(w.windows[0].testFrom).slice(0, 4);
  const last = isoDate(w.t[w.t.length - 1]).slice(0, 4);
  const n = w.windows.length;
  const lines = [
    `The plugin selected the values with the best ${label} in the ${span(w.trainMonths)} before each ${test}, and used them for that ${test}. This method ${did('cagr', w.stats.cagr)} from ${first} to ${last}, with a worst drawdown of ${pct(w.stats.maxDrawdown)}.`,
    `In the same period, ${ours.noun} ${did('cagr', w.declared.stats.cagr)}. The best values selected with hindsight (${valuesText(w.params, w.hindsight.values)}) ${did('cagr', w.hindsight.stats.cagr)}.`,
    w.changes === 0
      ? 'The plugin selected the same values each time.'
      : `The selection changed ${plural(w.changes, 'time')} in ${plural(n, `test ${test}`, `test ${test === 'half-year' ? 'half-years' : `${test}s`}`)}${w.changes >= n / 2 ? '. The best values change frequently. This shows that the best values are the best mostly because of noise' : ''}.`,
  ];
  if (w.failed > 0) lines.push(`${plural(w.failed, 'variant')} did not run, and the plugin did not include ${w.failed === 1 ? 'it' : 'them'}.`);
  if (w.idle > 0) lines.push(`${plural(w.idle, 'variant')} did not trade, and the plugin did not select ${w.idle === 1 ? 'it' : 'them'}.`);
  h(sec, 'p', 'bt-luck-verdict', lines.join(' '));
  legend(sec, [
    ['bt-luck-swatch-walk', 'Walk-forward'],
    ['bt-swatch-strategy', ours.label],
    ['bt-luck-swatch-hindsight', 'Best with hindsight'],
  ]);
  const chart = h(sec, 'div', 'bt-chart');
  const tip = h(chart, 'div', 'bt-tip');
  tip.hidden = true;
  observe(life, chart, (width) => drawWalk(chart, tip, width, w, ours));

  const more = h(sec, 'details', 'bt-details');
  h(more, 'summary', undefined, `Values selected for each test ${test}`);
  const table = h(h(more, 'div', 'bt-scroll'), 'table', 'bt-table');
  const head = h(h(table, 'thead'), 'tr');
  for (const [text, num] of [['Test period', 0], ['Values selected', 0], ['Return', 1], [ours.column, 1]] as const) h(head, 'th', num ? 'bt-num' : undefined, text);
  const body = h(table, 'tbody');
  for (const x of w.windows) {
    const row = h(body, 'tr');
    h(row, 'td', undefined, stretch(x.testFrom, x.testTo));
    h(row, 'td', undefined, valuesText(w.params, x.chosen));
    h(row, 'td', 'bt-num', pct(x.testReturn));
    h(row, 'td', 'bt-num', pct(x.declaredReturn));
  }

  how(
    sec,
    `For each ${test} from ${first}, the plugin selects the values with the best ${label} in the ${span(w.trainMonths)} before it. It selects from the ranges in the block and uses the values for that ${test} only. Then it connects the ${test === 'half-year' ? 'half-years' : `${test}s`} into one line. Indicators can read prices from before the ${test}, but no selection uses prices from the ${test} where it applies.`,
    'It selects only in the ranges in the block. If you selected those ranges when you looked at the full history, some hindsight stays. A change from one set of values to the next has no cost in this check.',
  );
}

function drawWalk(chart: HTMLElement, tip: HTMLElement, width: number, w: WalkForwardResult, ours: Ours): void {
  chart.querySelector('svg')?.remove();
  tip.hidden = true;
  const t = w.t;
  const n = t.length;
  const series = [
    { label: 'Best with hindsight', values: w.hindsight.equity, cls: 'bt-luck-line-hindsight', dot: 'bt-luck-dot-hindsight', swatch: 'bt-luck-swatch-hindsight' },
    { label: ours.label, values: w.declared.equity, cls: 'bt-line-strategy', dot: 'bt-dot-strategy', swatch: 'bt-swatch-strategy' },
    { label: 'Walk-forward', values: w.equity, cls: 'bt-luck-line-walk', dot: 'bt-luck-dot-walk', swatch: 'bt-luck-swatch-walk' },
  ];
  const left = 52;
  const right = 8;
  const top = 8;
  const plotH = Math.round(Math.min(220, Math.max(150, width * 0.32)));
  const height = top + plotH + 24;
  const plotW = width - left - right;
  const x = (time: number) => left + ((time - t[0]) / (t[n - 1] - t[0])) * plotW;
  let lo = Infinity;
  let hi = -Infinity;
  for (const sr of series) for (const v of sr.values) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
  lo = Math.max(lo, 1e-9);
  const pad = Math.max(Math.log(hi / lo) * 0.05, 0.01);
  const [l0, l1] = [Math.log(lo) - pad, Math.log(hi) + pad];
  const y = (v: number) => top + (1 - (Math.log(Math.max(v, 1e-9)) - l0) / (l1 - l0)) * plotH;

  const svg = s(chart, 'svg', { width, height, class: 'bt-svg', role: 'img', 'aria-label': `Value of the walk-forward during the run, compared with ${ours.noun} and the best values selected with hindsight` });
  // On a log scale even steps crowd at the top: keep a tick only when it clears the last one kept.
  let lastY = Infinity;
  for (const v of moneyTicks(Math.exp(l0), Math.exp(l1))) {
    if (lastY - y(v) < 16) continue;
    lastY = y(v);
    s(svg, 'line', { x1: left, x2: width - right, y1: y(v), y2: y(v), class: 'bt-grid' });
    s(svg, 'text', { x: left - 6, y: y(v) + 3.5, class: 'bt-axis', 'text-anchor': 'end' }, money(v));
  }
  // Where each test stretch begins: the pick can change there.
  for (const win of w.windows.slice(1)) s(svg, 'line', { x1: x(win.testFrom), x2: x(win.testFrom), y1: top, y2: top + plotH, class: 'bt-luck-boundary' });
  for (const tick of timeTicks(t[0], t[n - 1], plotW)) s(svg, 'text', { x: x(tick.t), y: height - 6, class: 'bt-axis', 'text-anchor': 'middle' }, tick.label);

  const stride = Math.max(1, Math.floor(n / (plotW * 2)));
  for (const sr of series) {
    let d = '';
    for (let i = 0; i < n; i += stride) d += `${d ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y(sr.values[i]).toFixed(1)}`;
    if ((n - 1) % stride !== 0) d += `L${x(t[n - 1]).toFixed(1)},${y(sr.values[n - 1]).toFixed(1)}`;
    s(svg, 'path', { d, class: `bt-line ${sr.cls}` });
  }

  const cross = s(svg, 'line', { y1: top, y2: top + plotH, class: 'bt-cross', visibility: 'hidden' });
  const dots = series.map((sr) => s(svg, 'circle', { r: 4, class: `bt-dot ${sr.dot}`, visibility: 'hidden' }));
  const hit = s(svg, 'rect', { x: left, y: top, width: plotW, height: plotH, fill: 'transparent' });
  const show = (clientX: number) => {
    const time = t[0] + ((clientX - svg.getBoundingClientRect().left - left) / plotW) * (t[n - 1] - t[0]);
    let a = 0;
    let b = n - 1;
    while (b - a > 1) {
      const mid = (a + b) >> 1;
      if (t[mid] <= time) a = mid;
      else b = mid;
    }
    const i = time - t[a] <= t[b] - time ? a : b;
    const px = x(t[i]);
    cross.setAttribute('x1', String(px));
    cross.setAttribute('x2', String(px));
    cross.setAttribute('visibility', 'visible');
    series.forEach((sr, k) => {
      dots[k].setAttribute('cx', String(px));
      dots[k].setAttribute('cy', String(y(sr.values[i])));
      dots[k].setAttribute('visibility', 'visible');
    });
    tip.replaceChildren();
    h(tip, 'div', 'bt-tip-date', isoDate(t[i]));
    for (const sr of [...series].reverse()) {
      const row = h(tip, 'div', 'bt-luck-tip-row');
      h(row, 'span', `bt-swatch ${sr.swatch}`);
      h(row, 'span', 'bt-tip-label', sr.label);
      h(row, 'span', 'bt-tip-value', money(sr.values[i]));
    }
    const win = w.windows.find((x) => x.testFrom <= t[i] && t[i] <= x.testTo);
    if (win) h(tip, 'div', 'bt-tip-foot', `Walk-forward uses ${valuesText(w.params, win.chosen)}`);
    placeTip(tip, px, top + 4, width);
  };
  hit.addEventListener('pointermove', (e) => show((e as PointerEvent).clientX));
  hit.addEventListener('pointerdown', (e) => show((e as PointerEvent).clientX));
  hit.addEventListener('pointerleave', () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    for (const d of dots) d.setAttribute('visibility', 'hidden');
  });
}
