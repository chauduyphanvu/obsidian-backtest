import { INSIDE_BARS } from './data.ts';
import { YAHOO_INSIDE_DAYS, type Spec } from './dsl.ts';
import { firstAtOrAfter, SMALL_TRADE, simulate, type RunResult, type Signals, type Skipped, type Trade } from './engine.ts';
import { clocksApart, columnFiles, columnNotes, ofReads, specEvaluator } from './evaluate.ts';
import { DAY, isIntraday, stamp, YEAR } from './format.ts';
import { alignByEnd } from './indicators.ts';
import type { Asset, Bars } from './types.ts';

export interface Stats {
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  volatility: number;
  /** Return above the cash rate, per unit of volatility, a year. */
  sharpe: number;
  /** Like Sharpe, counting only the steps below the cash rate as risk. */
  sortino: number;
  /** Average fraction of equity invested. */
  exposure: number;
}

export interface TradeStats {
  count: number;
  open: number;
  winRate: number;
  avgReturn: number;
}

/** One part of the run, measured on its own: the part before `test from` and the part from it on. */
export interface Segment {
  label: string;
  from: number;
  to: number;
  stats: Stats;
  benchmarkStats: Stats;
  tradeStats: TradeStats;
}

export interface Backtest {
  spec: Spec;
  /** The prices the run used, keyed by asset name. */
  data: Map<string, Bars>;
  run: RunResult;
  stats: Stats;
  tradeStats: TradeStats;
  drawdown: number[];
  /** Aligned with `run.t`; NaN before the benchmark's first bar, whose statistics start there. */
  benchmark: { label: string; equity: number[]; drawdown: number[]; stats: Stats };
  /** Interest earned on cash. */
  interest: number;
  cashRateNote: string;
  /** Before and from `test from`; null when it is not set. */
  segments: Segment[] | null;
  /** Plain sentences about how the run went that the reader should know, such as a benchmark with a shorter history. */
  notes: string[];
}

/** A deviation per step below this is floating-point noise, not risk. */
export const NOISE = 1e-12;

/** Fall from the highest value so far at each step; NaN where the value is unknown. */
export function drawdowns(equity: number[]): number[] {
  let peak = -Infinity;
  return equity.map((e) => {
    if (Number.isNaN(e)) return NaN;
    if (e > peak) peak = e;
    return e / peak - 1;
  });
}

/** The worst drawdown, as a fraction at or below 0. A loop, since spreading a long run into Math.min overflows the stack. */
export function maxDrawdown(equity: number[]): number {
  let worst = 0;
  for (const d of drawdowns(equity)) if (d < worst) worst = d;
  return worst;
}

/** `cashReturn[i]` is what cash earned from bar i - 1 to bar i; Sharpe and Sortino measure returns above it. */
export function computeStats(t: number[], equity: number[], capital: number, exposure: number[], cashReturn?: number[]): Stats {
  if (equity.length < 2) return { totalReturn: NaN, cagr: NaN, maxDrawdown: NaN, volatility: NaN, sharpe: NaN, sortino: NaN, exposure: NaN };
  const years = (t[t.length - 1] - t[0]) / YEAR;
  const total = equity[equity.length - 1] / capital - 1;
  const rets: number[] = [];
  const excess: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const r = equity[i] / equity[i - 1] - 1;
    rets.push(r);
    excess.push(r - (cashReturn?.[i] ?? 0));
  }
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const mean = avg(rets);
  const sd = Math.sqrt(avg(rets.map((r) => (r - mean) ** 2)));
  const meanExcess = avg(excess);
  const sdExcess = Math.sqrt(avg(excess.map((r) => (r - meanExcess) ** 2)));
  const downside = Math.sqrt(avg(excess.map((r) => Math.min(0, r) ** 2)));
  const perYear = rets.length / years;
  return {
    totalReturn: total,
    cagr: (1 + total) ** (1 / years) - 1,
    maxDrawdown: maxDrawdown(equity),
    volatility: sd * Math.sqrt(perYear),
    sharpe: sdExcess >= NOISE ? (meanExcess / sdExcess) * Math.sqrt(perYear) : 0,
    sortino: downside >= NOISE ? (meanExcess / downside) * Math.sqrt(perYear) : 0,
    exposure: exposure.reduce((s, x) => s + x, 0) / exposure.length,
  };
}

export function computeTradeStats(trades: Trade[]): TradeStats {
  const closed = trades.filter((t) => t.reason !== 'open');
  return {
    count: closed.length,
    open: trades.length - closed.length,
    winRate: closed.length ? closed.filter((t) => t.ret > 0).length / closed.length : NaN,
    avgReturn: closed.length ? closed.reduce((s, t) => s + t.ret, 0) / closed.length : NaN,
  };
}

/** A rule unknown for more bars than this at the start of the run gets a note. */
const FEW_BARS = 5;

/** Notes on rules still warming up at the run's first bar, one per rule and date. */
function warmupNotes(spec: Spec, data: Map<string, Bars>, signals: Map<string, Signals>, run: RunResult, intraday: boolean): string[] {
  const last = run.t[run.t.length - 1];
  const byWhen = new Map<string, { what: string; known: number | null; names: string[] }>();
  for (const a of spec.universe) {
    const { t } = data.get(a.name)!;
    const sig = signals.get(a.name)!;
    const unknown = (i: number) => (Number.isNaN(sig.buy[i]) ? 'buy rule' : sig.score && !Number.isFinite(sig.score[i]) ? 'ranking score' : null);
    let first = 0;
    while (first < t.length && t[first] < run.t[0]) first++;
    const what = unknown(first);
    if (!what) continue;
    let i = first;
    while (i < t.length && t[i] <= last && unknown(i)) i++;
    if (i - first <= FEW_BARS) continue;
    const known = i < t.length && t[i] <= last ? t[i] : null;
    const key = `${what} ${known}`;
    if (!byWhen.has(key)) byWhen.set(key, { what, known, names: [] });
    byWhen.get(key)!.names.push(a.name);
  }
  return [...byWhen.values()].map(({ what, known, names }) => {
    const subject = names.length === 1 ? `The ${what} for ${names[0]} was` : `The ${what}s for ${list(names)} were`;
    return known === null
      ? `${subject} unknown for the whole run: ${names.length === 1 ? 'its' : 'their'} indicators need more bars than the prices have.`
      : `${subject} unknown until ${stamp(known, intraday)} while ${names.length === 1 ? 'its' : 'their'} indicators warmed up, so ${list(names)} could not be bought before then.`;
  });
}

/** How a warm-up input is named in a sentence, with its period. */
export const WARMUP_INPUT: Record<Skipped['input'], (n: number) => string> = {
  'risk per trade': (n) => `the ${n}-bar ATR for risk per trade`,
  'inverse volatility': (n) => `the ${n}-bar volatility for inverse volatility weighting`,
  'stop loss': (n) => `the ${n}-bar ATR for the stop loss`,
  'trailing stop': (n) => `the ${n}-bar ATR for the trailing stop`,
  'take profit': (n) => `the ${n}-bar ATR for the take profit`,
};

/** One note per input that held entries back, naming the tickers and how many. */
function skippedNotes(skipped: Skipped[]): string[] {
  const groups = new Map<string, Skipped[]>();
  for (const s of skipped) {
    const key = `${s.input} ${s.n}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  return [...groups.values()].map((rows) => {
    const total = rows.reduce((sum, r) => sum + r.count, 0);
    const signals = `${total} buy signal${total === 1 ? '' : 's'}`;
    const verb = total === 1 ? 'was' : 'were';
    const input = WARMUP_INPUT[rows[0].input](rows[0].n);
    return rows.length === 1
      ? `${signals} for ${rows[0].asset} ${verb} not acted on while ${input} was still unknown.`
      : `${signals} ${verb} not acted on while ${input} was still unknown: ${rows.map((r) => `${r.asset} ${r.count}`).join(', ')}.`;
  });
}

/** "A", "A and B", "A, B and C". */
function list(names: string[]): string {
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function cashRateNote(spec: Spec): string {
  if (spec.cash.k === 'ticker') return `Cash earns the ${spec.cash.ref.name} rate`;
  return spec.cash.rate === 0 ? 'Cash earns nothing' : `Cash earns ${Number((spec.cash.rate * 100).toFixed(2))}% a year`;
}

/**
 * With `fill: close`, what the fills rest on from other tickers: bars read one early because the tickers keep different
 * hours (evaluate.ts clocksApart, and the ranking in engine.ts), and closes of the same date the result takes as known at
 * the fill because the prices cannot show that the markets close apart. Binance tickers on one bar size close together.
 */
function closeReadNotes(spec: Spec, data: Map<string, Bars>, intraday: boolean): string[] {
  const apart = clocksApart(spec, data);
  if (!apart) return [];
  const refs = [...spec.universe, ...spec.extras];
  const binance = (name: string) => refs.find((r) => r.name === name)?.source === 'binance';
  const together = (a: string, b: string) => !apart(a, b) && binance(a) && binance(b);
  const when = intraday ? 'time' : 'date';
  const names = spec.universe.map((a) => a.name);
  const pairs = names.flatMap((a, i) => names.slice(i + 1).map((b) => [a, b]));
  // How a file whose columns are read is read, its prices included, is said in its own note (evaluate.ts columnNotes).
  const columns = new Set(columnFiles(spec));
  const reads = ofReads(spec).filter(([, read]) => !columns.has(read));
  const notes: string[] = [];
  const early = reads.filter(([reader, read]) => apart(read, reader));
  if (early.length) {
    notes.push(
      `With fill: close, a rule reads the previous bar of a ticker that keeps other hours than the one it trades (another source, other days of the week or another bar size), because that ticker's bar of the same ${when} can close after the fill: ${early.map(([reader, read]) => `${read} for ${reader}`).join(', ')}.`,
    );
  }
  const ranked = spec.rank !== null && names.length > 1;
  if (ranked && pairs.some(([a, b]) => apart(a, b))) {
    notes.push(
      `With fill: close, the ranked tickers keep different hours (another source, other days of the week or another bar size), so at a time when tickers on different hours both trade, the ranking reads every ticker's previous bar: a close of the same ${when} can come after the fill.`,
    );
  }
  const same = reads.filter(([reader, read]) => !apart(read, reader) && !together(read, reader));
  const sameRank = ranked && pairs.some(([a, b]) => !apart(a, b) && !together(a, b));
  if (same.length || sameRank) {
    const what = [
      same.length ? `a rule reads another ticker's close of the same ${when} (${same.map(([reader, read]) => `${read} for ${reader}`).join(', ')})` : '',
      sameRank ? `the ranking compares the tickers' closes of the same ${when}` : '',
    ].filter(Boolean);
    const one = same.length === 1 && !sameRank;
    notes.push(
      `With fill: close, ${what.join(', and ')}. The result assumes ${one ? 'that close is' : 'those closes are'} known at the moment of the fill, which is not true for a market that closes later.`,
    );
  }
  return notes;
}

/**
 * With `magnify`, what was looked inside: for each ticker from when (its first bar in the run that has smaller bars, or
 * none), why not earlier, how many bars with a level inside them were followed through their smaller bars, and how many
 * in that time were read whole. Tickers that read alike share a note.
 */
function insideNotes(spec: Spec, data: Map<string, Bars>, run: RunResult, intraday: boolean): string[] {
  const size = spec.magnify;
  if (!size || !run.inside) return [];
  const window = (source: string) =>
    source === 'yahoo' && YAHOO_INSIDE_DAYS[size]
      ? ` (Yahoo gives ${size} bars for the last ${YAHOO_INSIDE_DAYS[size]} days)`
      : source === 'binance'
        ? ` (at most ${INSIDE_BARS.toLocaleString('en-US')} ${size} bars are loaded for a ticker)`
        : '';
  const groups = new Map<string, { names: string[]; from: number | null; source: string; looked: number; whole: number }>();
  for (const r of run.inside) {
    const source = spec.universe.find((a) => a.name === r.asset)!.source;
    const t = data.get(r.asset)!.t;
    const all = r.from !== null && r.from === t[firstAtOrAfter(t, run.t[0])];
    const key = `${all ? 'all' : r.from} ${all ? '' : source}`;
    if (!groups.has(key)) groups.set(key, { names: [], from: all ? -Infinity : r.from, source, looked: 0, whole: 0 });
    const g = groups.get(key)!;
    g.names.push(r.asset);
    g.looked += r.looked;
    g.whole += r.whole;
  }
  const notes: string[] = [];
  const firstStop = 'when a bar holds both a stop and a target the stop is taken first';
  for (const g of groups.values()) {
    const one = g.names.length === 1;
    const their = one ? 'its' : 'their';
    const held =
      g.looked === 0
        ? `none of them held a stop or target inside ${one ? 'its' : 'their'} range`
        : `${g.looked} ${g.looked === 1 ? 'bar held a stop or target and was' : 'bars held a stop or target and were'} followed through them`;
    if (g.from === null) {
      notes.push(`No ${size} bars of ${list(g.names)} reach into this run${window(g.source)}, so ${their} bars are read whole, and ${firstStop}.`);
      continue;
    }
    if (g.from === -Infinity) notes.push(`Looked inside every bar of ${list(g.names)} using ${their} ${size} bars: ${held}.`);
    else {
      notes.push(
        `Looked inside the bars of ${list(g.names)} from ${stamp(g.from, intraday)} on, using ${their} ${size} bars${window(g.source)}: ${held}. Before that, bars are read whole, and ${firstStop}.`,
      );
    }
    if (g.whole > 0) {
      notes.push(
        `In that time ${g.whole} ${g.whole === 1 ? 'bar' : 'bars'} of ${list(g.names)} with a stop or target inside ${g.whole === 1 ? 'it was' : 'them were'} read whole, because ${g.whole === 1 ? 'its' : 'their'} ${size} bars were missing or did not match ${g.whole === 1 ? 'it' : 'them'}.`,
      );
    }
  }
  const csv = spec.universe.filter((a) => a.source === 'csv').map((a) => a.name);
  if (csv.length) {
    notes.push(`${list(csv)} ${csv.length === 1 ? 'is a CSV file, which has' : 'are CSV files, which have'} no smaller bars, so ${csv.length === 1 ? 'its' : 'their'} bars are read whole.`);
  }
  const tiingo = spec.universe.filter((a) => a.source === 'tiingo').map((a) => a.name);
  if (tiingo.length) {
    notes.push(`${list(tiingo)} ${tiingo.length === 1 ? 'comes' : 'come'} from Tiingo, which gives no smaller bars here, so ${tiingo.length === 1 ? 'its' : 'their'} bars are read whole.`);
  }
  return notes;
}

export const CLOSE_FILL_NOTE =
  'Orders fill at the same close the rules were read at (fill: close). The result assumes you can trade at that closing price, which a real order can only come near by being placed just before the close.';

/** What each ticker's rules say, as simulate reads them. */
export function specSignals(spec: Spec, data: Map<string, Bars>): Map<string, Signals> {
  const evaluator = specEvaluator(spec, data);
  const signals = new Map<string, Signals>();
  for (const a of spec.universe) {
    const r = spec.rules[a.name];
    signals.set(a.name, {
      buy: evaluator.eval(r.buy, a.name),
      sell: r.sell ? evaluator.compile(r.sell, a.name) : null,
      score: spec.rank ? evaluator.eval(spec.rank.by, a.name) : null,
      add: r.add ? evaluator.compile(r.add, a.name) : null,
    });
  }
  return signals;
}

/** Runs the spec and a buy-and-hold benchmark over the same dates. `data` is keyed by asset name. */
export function runBacktest(spec: Spec, data: Map<string, Bars>): Backtest {
  const signals = specSignals(spec, data);
  const run = simulate({ ...spec, assets: spec.universe }, data, signals);

  // The benchmark holds the same weights (or the named ticker) throughout, with the same costs
  // and rebalancing, bought at the same first open the strategy could have bought at. A ranking
  // strategy is compared with holding every ticker in equal parts of the same size.
  const n = spec.universe.length;
  const held: Asset[] = spec.benchmark
    ? [{ ...spec.benchmark, weight: 1 }]
    : spec.rank
      ? spec.universe.map((a) => ({ ...a, weight: (a.weight * spec.rank!.top) / n }))
      : spec.universe;
  const always = new Map<string, Signals>(held.map((a) => [a.name, { buy: data.get(a.name)!.t.map(() => 1), sell: null, score: null }]));
  const bench = simulate(
    {
      assets: held,
      from: run.t[0],
      to: run.t[run.t.length - 1],
      capital: spec.capital,
      costBps: spec.costBps,
      slippageBps: spec.slippageBps,
      rebalance: spec.rebalance,
      stops: {},
      cash: spec.cash,
      sizing: { k: 'fixed' },
      rank: null,
      fill: spec.fill,
      commission: spec.commission,
    },
    data,
    always,
  );
  // A named benchmark can trade on other days or bars than the strategy: carry the value of its
  // latest bar that had ended by the end of each of the strategy's bars.
  // Before its first bar the benchmark has no value; while that bar is still open it is the capital.
  const at = alignByEnd(bench.t, run.t);
  const benchEquity = run.t.map((t, i) => (at[i] >= 0 ? bench.equity[at[i]] : t >= bench.t[0] ? spec.capital : NaN));
  const benchExposure = run.t.map(() => 1);
  /**
   * Statistics of the run's bars s to e - 1, with growth measured from the close of bar `base`, or
   * from the series' first value when it starts later.
   */
  const measure = (eq: number[], ex: number[], base: number, s: number, e: number, capital?: number): Stats => {
    while (base < e && Number.isNaN(eq[base])) base++;
    const cut = (xs: number[]) => xs.slice(base, e);
    return computeStats(cut(run.t), cut(eq), capital ?? eq[base], ex.slice(Math.max(s, base), e), cut(run.cashReturn));
  };

  const intraday = isIntraday(run.t);
  const notes = [...warmupNotes(spec, data, signals, run, intraday), ...skippedNotes(run.skipped), ...columnNotes(spec, data)];
  if (run.smallTrades) {
    const n = run.smallTrades;
    notes.push(
      `${n} ${n === 1 ? 'add or rebalancing trade was' : 'adds and rebalancing trades were'} not made because the commission would have been ${SMALL_TRADE * 100}% of ${n === 1 ? 'its' : 'their'} value or more.`,
    );
  }
  if (spec.fill === 'close') notes.push(CLOSE_FILL_NOTE, ...closeReadNotes(spec, data, intraday));
  notes.push(...insideNotes(spec, data, run, intraday));
  if (spec.benchmark && bench.t[0] - run.t[0] > 7 * DAY) {
    notes.push(`${spec.benchmark.name} has prices only from ${stamp(bench.t[0], intraday)}, so its figures cover a shorter period than the strategy's.`);
  }

  let segments: Segment[] | null = null;
  if (spec.testFrom !== null) {
    const split = spec.testFrom;
    const cut = run.t.findIndex((t) => t >= split);
    const k = cut < 0 ? run.t.length : cut;
    const day = new Date(split).toISOString().slice(0, 10);
    // Each part's growth runs from the last close before it, so the parts multiply to the whole run.
    const part = (label: string, s: number, e: number, mine: (t: Trade) => boolean): Segment => ({
      label,
      from: s < e ? run.t[s] : split,
      to: s < e ? run.t[e - 1] : split,
      stats: measure(run.equity, run.exposure, Math.max(0, s - 1), s, e),
      benchmarkStats: measure(benchEquity, benchExposure, Math.max(0, s - 1), s, e),
      tradeStats: computeTradeStats(run.trades.filter(mine)),
    });
    segments = [
      part(`Before ${day}`, 0, k, (tr) => tr.entryT < split),
      part(`From ${day}`, k, run.t.length, (tr) => tr.entryT >= split),
    ];
  }

  return {
    spec,
    data,
    run,
    stats: measure(run.equity, run.exposure, 0, 0, run.t.length, spec.capital),
    tradeStats: computeTradeStats(run.trades),
    drawdown: drawdowns(run.equity),
    benchmark: {
      label: spec.benchmark ? `${spec.benchmark.name} buy & hold` : spec.rank ? 'Equal-weight buy & hold' : 'Buy & hold',
      equity: benchEquity,
      drawdown: drawdowns(benchEquity),
      stats: measure(benchEquity, benchExposure, 0, 0, run.t.length, spec.capital),
    },
    interest: run.interest,
    cashRateNote: cashRateNote(spec),
    segments,
    notes,
  };
}
