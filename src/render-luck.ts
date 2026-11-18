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
  return `These checks test the run shown, with ${list((p) => p.value)}. The block says ${list((p) => p.declared)}.`;
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
      ? 'Three checks that try to make a lucky result look lucky. They run extra backtests on the prices already loaded.'
      : 'Two checks that try to make a lucky result look lucky. They run extra backtests on the prices already loaded. A third, walk-forward, needs a parameter with a range, such as fast = 50 in 20..100 step 10.',
  );
  const used = valuesUsed(bt.spec.params);
  const ours = used ? SHOWN : NOTE;
  if (used) h(body, 'p', 'bt-note', used);
  const stopTries = input.ledger ? triesBlock(h(body, 'div'), input.ledger, bt) : () => {};
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
      b = await step({ kind: 'reshuffle', seed, runs: RESHUFFLES }, 'Reshuffling history…');
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
      randomBlock(random, lifeOf(random), bt, r && !(r.stopped && r.runs === 0) ? r : 'Stopped before the first try. Run the checks again to finish it.', RANDOM_RUNS);
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
            walkBlock(walk, lifeOf(walk), 'Stopped before the end. Run the checks again to finish it.', ours);
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
  h(p, 'strong', undefined, "What it can't tell you: ");
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

const chance = (p: number) => (p > 0.995 ? 'over 99%' : p < 0.005 ? 'under 1%' : `about ${pct(p, 0)}`);
const ratio = (x: number) => minus(x.toFixed(2));
const sinceText = (t: Tries) => (t.since === null ? '' : ` since ${localDate(t.since)}`);
const counted = (t: Tries) =>
  t.n === 1 ? `1 try of this block has been counted${sinceText(t)}` : `${plural(t.n, 'try', 'tries')} of this block have been counted${sinceText(t)}`;

/** The verdict of "How many tries", in words. */
export function triesWords(t: Tries): string {
  const cannot: Record<NonNullable<Tries['why']>, string> = {
    'no trades': 'The run shown never traded, so it is not one of them, and it has no Sharpe ratio to judge.',
    flat: 'The run shown barely moves against cash, so it has no Sharpe ratio to judge.',
    short: 'The run shown has too few bars to judge its Sharpe ratio.',
    shape: "Can't tell: the run's returns are so lopsided or heavy-tailed that its Sharpe ratio has no usable margin of error.",
  };
  if (!t.deflated) return `${counted(t)}. ${cannot[t.why ?? 'shape']}`;
  const d = t.deflated;
  const verdict =
    d.dsr >= 0.95
      ? 'That is strong evidence of an edge, as far as these tries can tell.'
      : d.dsr >= 0.5
        ? 'That is not strong evidence: the result could be luck.'
        : 'The result is more likely luck than an edge.';
  if (t.n <= 1) {
    return `Only the run shown has been counted${sinceText(t)}, so there are no other tries to allow for. Given the length and shape of its returns, the chance that its Sharpe ratio of ${ratio(t.sharpe)} reflects a real edge is ${chance(d.dsr)}. ${verdict}`;
  }
  return (
    `${counted(t)}. With no edge at all, the best of ${plural(t.n, 'try', 'tries')} like these would typically show a Sharpe ratio of about ${ratio(d.bar)}; the run shown has ${ratio(t.sharpe)}. ` +
    `Allowing for that, the chance that its Sharpe ratio reflects a real edge, rather than the luck of keeping the best try, is ${chance(d.dsr)}. ${verdict}`
  );
}

/** Why the count overstates the tries. */
export const upperBound = (n: number) =>
  `${n.toLocaleString('en-US')} is an upper bound: neighbouring variants are alike, so they make fewer independent tries than their count, and the chance above errs on the low side.`;

/** The line under the result's figures; null when there is nothing to allow for. */
export function triesNote(t: Tries): string | null {
  if (t.n <= 1) return null;
  const see = 'See "How many tries" under "Was it luck?".';
  return t.deflated
    ? `${plural(t.n, 'try', 'tries')} of this block counted so far. Allowing for them, the chance that this Sharpe ratio reflects a real edge is ${chance(t.deflated.dsr)}. ${see}`
    : `${plural(t.n, 'try', 'tries')} of this block counted so far. ${see}`;
}

export const RESET = 'Start the count again';

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
        h(row, 'span', 'bt-ledger-ask', `Forget the ${plural(t.n, 'try', 'tries')} counted so far and count from now?`);
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
      'every run shown in the note or the preview panel counts, with each slider position and each variant of a sweep or walk-forward, once for each set of rules and values that traded: two blocks that trade alike count once, however they are written. The deflated Sharpe ratio (Bailey and López de Prado, 2014) works out the best Sharpe ratio that this many tries with no edge would typically show, from how much their Sharpe ratios differ, and asks how likely the run shown is to be above it, given how long its history is and how lopsided and heavy-tailed its returns are.',
      'tries made anywhere else are not counted: in another program, in an earlier copy of the block, or ideas dropped before they were run. Nor are the reshuffles and random entries of these checks, or the runs of the orders window and of compare and backtests blocks. The count belongs to the block: a new name line, or moving a block that has none, starts a new one.',
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
  const lost = r.lossShare === 0 ? '' : ` ${pct(r.lossShare, r.lossShare < 0.01 ? 1 : 0)} of the reshuffled versions ended below the starting value.`;
  const milder =
    r.actual.maxDrawdown > r.maxDrawdown.median
      ? ' This run’s worst drawdown was milder than in most of them: expect deeper falls than the backtest shows.'
      : r.actual.maxDrawdown < r.maxDrawdown.lo
        ? ' This run’s worst drawdown was deeper than in almost all of them: its losses came in a long streak that the reshuffling breaks up, so the reshuffled drawdowns understate the risk.'
        : '';
  return (
    'This shows how much the path and the drawdown depended on the order of the returns. ' +
    `In ${plural(r.runs, 'reshuffle')} of this run’s own returns, the middle 90% made between ${pct(r.cagr.lo)} and ${pct(r.cagr.hi)} a year (this run: ${pct(r.actual.cagr)}), with worst drawdowns between ${pct(r.maxDrawdown.lo)} and ${pct(r.maxDrawdown.hi)} (this run: ${pct(r.actual.maxDrawdown)}).` +
    `${milder}${lost} It says nothing about whether the average return will persist, because every version is made from this run’s own returns.`
  );
}

function bootBlock(el: HTMLElement, life: Life, bt: Backtest, r: BootstrapResult | string): void {
  const sec = check(el, 'Reshuffled history');
  if (typeof r === 'string') {
    h(sec, 'p', 'bt-luck-verdict', r);
    return;
  }
  if (bt.run.trades.length === 0) {
    h(sec, 'p', 'bt-luck-verdict', 'The strategy made no trades, so there is nothing to reshuffle.');
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
    made: (a, b) => `fell ${a} to ${b} at worst`,
  });
  const step = bt.spec.interval === '1d' ? 'daily' : bt.spec.interval === '1w' ? 'weekly' : 'bar-by-bar';
  how(
    sec,
    `the run’s ${step} results are cut into pieces of ${plural(r.blockBars, 'bar')} (${r.blockBars > monthOfBars(bt.run.t) ? 'a typical holding, so a position stays in one piece' : 'about a month'}) and put back together in random order, ${plural(r.runs, 'time')}. Each piece keeps its own ups and downs; only the order changes.`,
    'it only reuses pieces of this run, so it can’t show a market the run never saw, and swings longer than a piece are broken up. If these rules were picked because they looked good on this history, every reshuffle keeps that luck.',
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
  const later = spec.entries ? ' A position built in entries keeps how many it made and puts the later ones the same number of bars after its first.' : '';
  const kept = shorts ? 'how many trades each ticker made, whether each was long or short, and how long each was held' : 'how many trades each ticker made and how long each was held';
  return `each try keeps ${kept}, with the same ${same}, and places those holdings at random dates.${later} Stops are off: the holding lengths already include their exits.`;
}

/** What a random-picks try keeps from the strategy. */
export function randomPicksWorks(spec: Pick<Backtest['spec'], 'commission' | 'entries'>, trades: string, against: number): string {
  const same = andList(['rules', 'dates', 'number held', 'stops', 'costs', ...(spec.commission ? ['commission'] : []), ...(spec.entries ? ['entries'] : [])]);
  return `each try runs the same ${same}, but ranks the tickers the rules allow at random instead of by the score. A random pick is kept for a while, so the tries trade about as often as the strategy (${trades} on average, against ${against}).`;
}

/**
 * What the random entries showed, or why they did not run. `shorts`: the strategy held short positions, which count as
 * time in its tickers as long ones do.
 */
export function randomVerdict(r: RandomEntriesResult, picks: boolean, shorts: boolean, asked: number): string {
  const who = picks ? 'Random picks' : 'Random timing';
  const skip: Record<NonNullable<RandomEntriesResult['skip']>, string> = {
    'no-trades': 'The strategy made no trades, so there is nothing to compare.',
    'always-invested': `The strategy holds its tickers${shorts ? ', long or short,' : ''} the whole time, so there is no timing to vary.`,
    'holds-everything': 'The ranking holds every ticker in the universe, so there is no pick to vary.',
  };
  if (r.skip) return skip[r.skip];
  const share = r.atLeast.cagr / r.runs;
  const shareRatio = r.atLeast.ratio / r.runs;
  const lines = [
    `${who} did at least as well on return per year in ${r.atLeast.cagr} of ${plural(r.runs, 'try', 'tries')} (${pct(share, 0)}), and on return per year ÷ worst drawdown in ${r.atLeast.ratio} (${pct(shareRatio, 0)}).`,
    share <= 0.05
      ? `So few matched it that the ${picks ? 'ranking' : 'timing of the rules'} likely adds something, though a strategy picked from many tries can clear this bar by luck too.`
      : share <= 0.2
        ? 'That is not rare enough to rule out luck.'
        : `${who} often did as well, so this result does not show that the ${picks ? 'ranking' : 'timing of the rules'} adds anything.`,
  ];
  if (!picks && r.invested >= 0.9) {
    lines.push(`The strategy is ${shorts ? 'in its tickers, long or short,' : 'invested'} ${pct(r.invested, 0)} of the time, so random timing is close to holding throughout, and this check can tell little either way.`);
  }
  if (r.stopped) lines.push(`Stopped after ${r.runs} of ${asked} tries.`);
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
      'it tests the ranking only: when to be invested and which tickers are allowed come from your rules in both. Doing better than random picks in the past does not mean the ranking will keep doing it.',
    );
  } else {
    how(
      sec,
      randomTimingWorks(bt.spec, shorts),
      `it tests when the rules ${shorts ? 'go in and out' : 'buy and sell'}, not which tickers they hold, and beating random timing in the past does not mean the rules will keep doing it.`,
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

  const svg = s(chart, 'svg', { width, height, class: 'bt-svg', role: 'img', 'aria-label': `${o.title} of ${values.length} ${o.noun}, with ${o.markLabel.toLowerCase()} marked` });
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
const unit = (months: number) => (months === 12 ? 'year' : months === 6 ? 'half-year' : months === 3 ? 'quarter' : `${months}-month stretch`);

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
    `Picking the values with the best ${label} over each past ${span(w.trainMonths)} and using them for the next ${test} ${did('cagr', w.stats.cagr)} from ${first} to ${last}, with a worst drawdown of ${pct(w.stats.maxDrawdown)}.`,
    `Over the same dates ${ours.noun} ${did('cagr', w.declared.stats.cagr)}, and the best values picked with hindsight (${valuesText(w.params, w.hindsight.values)}) ${did('cagr', w.hindsight.stats.cagr)}.`,
    w.changes === 0
      ? 'The same values were picked every time.'
      : `The pick changed ${plural(w.changes, 'time')} over ${plural(n, `test ${test}`, `test ${test === 'half-year' ? 'half-years' : `${test}s`}`)}${w.changes >= n / 2 ? ': the best values move around, a sign that much of what makes them best is noise' : ''}.`,
  ];
  if (w.failed > 0) lines.push(`${plural(w.failed, 'variant')} could not run and ${w.failed === 1 ? 'was' : 'were'} left out.`);
  if (w.idle > 0) lines.push(`${plural(w.idle, 'variant')} never traded and ${w.idle === 1 ? 'was' : 'were'} never picked.`);
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
  h(more, 'summary', undefined, `Values picked for each test ${test}`);
  const table = h(h(more, 'div', 'bt-scroll'), 'table', 'bt-table');
  const head = h(h(table, 'thead'), 'tr');
  for (const [text, num] of [['Tested', 0], ['Values picked', 0], ['Return', 1], [ours.column, 1]] as const) h(head, 'th', num ? 'bt-num' : undefined, text);
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
    `for each ${test} from ${first}, the values with the best ${label} over the ${span(w.trainMonths)} before it are picked from the ranges in the block and used for that ${test} only; the ${test === 'half-year' ? 'half-years' : `${test}s`} are joined into one line. Indicators may read earlier prices, but no pick sees the ${test} it is used in.`,
    'it only picks among the ranges written in the block, so if those ranges were chosen by looking at the whole history, some hindsight remains. Switching from one set of values to the next is taken as free.',
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

  const svg = s(chart, 'svg', { width, height, class: 'bt-svg', role: 'img', 'aria-label': `Walk-forward value over time, against ${ours.noun} and the best values picked with hindsight` });
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
