// Cross-check of the backtest engine against Rearview: `node xcheck/run.ts [case ...] [-v]` (see xcheck/README.md).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest } from '../src/backtest.ts';
import { parseCsv } from '../src/data.ts';
import { parseSpec, type Spec } from '../src/dsl.ts';
import type { ExitReason } from '../src/engine.ts';
import { Evaluator } from '../src/evaluate.ts';
import type { Bars } from '../src/types.ts';
import { generate, importFiles, periodOf, tickerCsv } from './data.ts';
import { readEval, readRun, rvw, type RvFill, type RvRun } from './rearview.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '.scratch', 'xcheck');
/** Rearview's command-line tool: RVW when set, else `rvw` on PATH; empty when neither is there. */
function findRvw(): string {
  if (process.env.RVW) return existsSync(process.env.RVW) ? process.env.RVW : '';
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir && existsSync(join(dir, 'rvw'))) return join(dir, 'rvw');
  return '';
}
const RVW = findRvw();
const DAY = 86_400_000;

// Rearview rounds every fill price to a millionth of a dollar (up for buys, down for sells).
const PRICE_TOL = 1.5e-6;
// Rearview also rounds cash, commissions and interest to millionths of a dollar and quantities to
// millionths of a share: on a $100,000 account each rounding is below 1e-10 of equity, and the few
// thousand of them in a run stay below 1e-8. The tolerances leave a hundred times that.
const LEVEL_TOL = 1e-6;
const RETURN_TOL = 1e-7;
const INDICATOR_TOL = 1e-9;

/** Per-security constant weights for Rearview's `size weight series("w")` in the rebalancing cases. */
const WEIGHTS = { TRND: 0.5, MREV: 0.3, CHOP: 0.15, WK1: 0.6, WK2: 0.35 };

interface CaseConfig {
  what: string;
  /**
   * direct: our equity against Rearview's daily equity. replay: against Rearview's own fills
   * replayed with our sizing (all in at the fill), for one ticker that gaps, where Rearview's
   * sizing at the signal close leaves cash over after a gap down.
   */
  equity: 'direct' | 'replay';
  /**
   * Rearview fills a scheduled rebalance on the second trading day of the period, a day after us;
   * with fill: close (Rearview's same_close) at the close of the first day, a day after our last.
   */
  rebalanceShift?: 'month' | 'week';
  /** Extra Rearview `run` settings. */
  run?: Record<string, unknown>;
  /** Root causes of trade differences this case may show (see EXPLAIN). */
  explain?: string[];
}

const EXPLAIN: Record<string, string> = {
  halt: 'the ticker had no bar on the day after the signal: Rearview cancels the entry order, we fill it at the next bar',
  rearm: 'after a stop or target exit our buy rule must stop holding before it fires again; Rearview enters again at once',
  trail: "on its entry bar a trailing stop trails Rearview's fill price, slippage included, and our open",
  closetrail: "with close fills Rearview's trailing stop also trails the high of the bar it bought at, made before the fill; ours starts from the close it bought at",
  knock: 'knock-on of an explained difference: the other engine held a position from an explained trade at the time',
};

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const relDiff = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
const fmtE = (x: number) => (x === 0 ? '0' : x.toExponential(1));
const verbose = process.argv.includes('-v');

interface Ctx {
  data: Map<string, Bars>;
  ids: Map<number, string>;
  days: string[];
  store: string;
}

// ---------------------------------------------------------------- data

function prepareData(): Ctx {
  const g = generate();
  const files = importFiles(g, WEIGHTS);
  const importDir = join(OUT, 'import');
  const store = join(OUT, 'store');
  const hash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const hashFile = join(OUT, 'store.sha256');
  if (!existsSync(hashFile) || readFileSync(hashFile, 'utf8') !== hash || !existsSync(store)) {
    rmSync(importDir, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(importDir, p)), { recursive: true });
      writeFileSync(join(importDir, p), text);
    }
    const report = JSON.parse(rvw(RVW, ['import', importDir, '--store', store, '--strict']));
    if (report.issues?.length) throw new Error(`Rearview's import reported issues: ${JSON.stringify(report.issues)}`);
    writeFileSync(hashFile, hash);
  }
  // Our engine reads the same bars.csv, one ticker at a time, through its own CSV reader.
  const barsCsv = readFileSync(join(importDir, 'bars.csv'), 'utf8');
  const data = new Map<string, Bars>();
  const ids = new Map<number, string>();
  for (const s of g.specs) {
    data.set(s.ticker, parseCsv(tickerCsv(barsCsv, s.id)));
    ids.set(s.id, s.ticker);
  }
  return { data, ids, days: g.days, store };
}

// ---------------------------------------------------------------- indicators

/** Ours, Rearview's, and the bar from which they must agree (null: every bar, warm-up included). */
const INDICATORS: [string, string, number | null][] = [
  ['sma(20)', 'sma(close, 20)', null],
  ['ema(20)', 'ema(close, 20)', null],
  ['ema(50)', 'ema(close, 50)', null],
  ['rsi(14)', 'rsi(close, 14)', null],
  ['rsi(2)', 'rsi(close, 2)', null],
  ['sma(rsi(2), 5)', 'sma(rsi(close, 2), 5)', null],
  ['roc(20)', 'roc(close, 20)', null],
  ['roc(63)', 'roc(close, 63)', null],
  ['highest(20)', 'highest(high, 20)', null],
  ['lowest(10)', 'lowest(low, 10)', null],
  ['highest(close, 20)[1]', 'highest(close, 20)[1]', null],
  ['stdev(20)', 'stdev(close, 20)', null],
  ['macd(12, 26)', 'macd_line(close, 12, 26, 9)', null],
  ['macd_signal(12, 26, 9)', 'macd_signal(close, 12, 26, 9)', null],
  ['bb_upper(20, 2)', 'bollinger_upper(close, 20, 2)', null],
  ['bb_lower(20, 2.5)', 'bollinger_lower(close, 20, 2.5)', null],
  ['ema(rsi(14), 10)', 'ema(rsi(close, 14), 10)', null],
  ['rsi(sma(5), 3)', 'rsi(sma(close, 5), 3)', null],
  ['stdev(roc(1), 20)', 'stdev(roc(close, 1), 20)', null],
  ['highest(close - open, 5)', 'highest(close - open, 5)', null],
  ['max(close, sma(20)) - min(open, ema(10))', 'max(close, sma(close, 20)) - min(open, ema(close, 10))', null],
  ['abs(roc(5)) * 100', 'abs(roc(close, 5)) * 100', null],
  ['sma(macd(12, 26), 3)', 'sma(macd_line(close, 12, 26, 9), 3)', null],
  // Documented: our first true range is the first bar's high - low, Rearview's starts on the second
  // bar, so ours is known a bar earlier and the two converge as Wilder's smoothing forgets the seed.
  ['atr(14)', 'atr(14)', 400],
];

interface IndicatorResult {
  ours: string;
  theirs: string;
  compared: number;
  worst: number;
  warmup: string;
  ok: boolean;
}

function checkIndicators(ctx: Ctx): IndicatorResult[] {
  const tickers = [...ctx.data.keys()];
  const out = join(OUT, 'indicators.csv');
  const args = ['eval', '--store', ctx.store, '--tickers', tickers.join(','), '--out', out];
  INDICATORS.forEach(([, theirs], i) => args.push('--expr', `i${i}=${theirs}`));
  rvw(RVW, args);
  const values = readEval(out);
  const ev = new Evaluator(ctx.data);
  return INDICATORS.map(([ours, theirs, settle], i) => {
    const { spec, errors } = parseSpec(`universe: ${tickers[0]}\nhold: top 1 by ${ours}`);
    if (!spec) throw new Error(`Can't parse ${ours}: ${JSON.stringify(errors)}`);
    let compared = 0;
    let worst = 0;
    let ok = true;
    const warm: string[] = [];
    for (const tk of tickers) {
      const bars = ctx.data.get(tk)!;
      const mine = ev.eval(spec.rank!.by, tk);
      const theirsByDate = values.get(tk)!.get(`i${i}`)!;
      const firstMine = mine.findIndex((x) => !Number.isNaN(x));
      const firstTheirs = bars.t.findIndex((t) => !Number.isNaN(theirsByDate.get(iso(t)) ?? NaN));
      if (firstMine !== firstTheirs) warm.push(`${tk} ${firstMine} vs ${firstTheirs}`);
      for (let k = 0; k < bars.t.length; k++) {
        const a = mine[k];
        const b = theirsByDate.get(iso(bars.t[k])) ?? NaN;
        if (Number.isNaN(a) || Number.isNaN(b)) {
          if (Number.isNaN(a) !== Number.isNaN(b) && settle === null) ok = false;
          continue;
        }
        if (settle !== null && k < settle) continue;
        compared++;
        worst = Math.max(worst, Math.abs(a - b) / Math.max(1, Math.abs(b)));
      }
    }
    if (worst > INDICATOR_TOL) ok = false;
    const warmup = warm.length === 0 ? 'same' : settle !== null ? `documented: bar ${warm[0].split(' ').slice(1).join(' ')}` : `DIFFERENT: ${warm.join('; ')}`;
    return { ours, theirs, compared, worst, warmup, ok };
  });
}

// ---------------------------------------------------------------- cases

interface T {
  asset: string;
  entry: string;
  entryPx: number;
  exit: string | null;
  exitPx: number | null;
  reason: ExitReason;
  pnl: number;
  bars: number;
}

const REASONS: Record<string, ExitReason> = {
  EXIT_SIGNAL: 'signal',
  TIME_EXIT: 'signal',
  REBALANCE: 'signal',
  STOP: 'stop loss',
  TRAILING_STOP: 'trailing stop',
  TARGET: 'take profit',
  '': 'open',
};

interface CaseResult {
  name: string;
  what: string;
  equityMode: string;
  ours: number;
  theirs: number;
  matched: number;
  exits: string;
  mismatches: string[];
  explained: Record<string, number>;
  explainedList: string[];
  levelWorst: number;
  levelWorstDate: string;
  levelDays: number;
  returnWorst: number;
  returnWorstDate: string;
  returnDays: number;
  exposureWorst: number;
  totals: string[];
  warnings: string[];
  ok: boolean;
}

function runCase(name: string, dir: string, ctx: Ctx): CaseResult {
  const cfg = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as CaseConfig;
  const { spec, errors } = parseSpec(readFileSync(join(dir, 'case.strategy'), 'utf8'));
  if (!spec) throw new Error(`${name}: our parser refused case.strategy: ${JSON.stringify(errors)}`);
  const ours = runBacktest(spec, ctx.data);
  const dates = ours.run.t.map(iso);

  const rate = spec.cash.k === 'fixed' ? spec.cash.rate : 0;
  // Rearview counts interest over a 360-day year, we over 365: the same daily rate is ours * 360/365.
  const cashRate = (rate * 360 * 1e6) / 365;
  if (Math.abs(cashRate - Math.round(cashRate)) > 1e-6) throw new Error(`${name}: pick a cash rate whose 360/365 is a whole number of millionths`);
  const runDir = join(OUT, 'runs', name);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const config = {
    run: {
      start: dates[0],
      end: dates[dates.length - 1],
      initial_cash: Math.round(spec.capital * 1e6),
      account: { type: 'cash' },
      quantity: { share_decimals: 6 },
      commission: { per_share: 0, per_trade: 0, pct: Math.round(spec.costBps * 100), min: 0 },
      slippage: Math.round(spec.slippageBps * 100),
      cash_rate: Math.round(cashRate),
      ...cfg.run,
    },
  };
  writeFileSync(join(runDir, 'config.json'), JSON.stringify(config, null, 2));
  rvw(RVW, ['run', '--store', ctx.store, '--script', join(dir, 'case.rvw'), '--config', join(runDir, 'config.json'), '--out', join(runDir, 'rv')]);
  const rv = readRun(join(runDir, 'rv'));

  const atClose = spec.fill === 'close';
  const dayIdx = new Map(ctx.days.map((d, i) => [d, i]));
  const periodStart = (d: string, offset: number) => {
    const i = dayIdx.get(d)! - offset;
    const p = (k: number) => periodOf(ctx.days[k], cfg.rebalanceShift!);
    return i >= 1 && p(i - 1) !== p(i) && (offset === 0 || p(i) === p(i + offset));
  };
  // A rebalance Rearview decides at the close of a period's first trading day fills on the second;
  // ours fills at the first day's open. With close fills Rearview's fills at that first close, and
  // ours at the close of the day before, the period's last. The fills at the run's start are the same.
  const shifted = (f: RvFill) =>
    !!cfg.rebalanceShift &&
    (f.reason === 'REBALANCE' || f.reason === 'ENTRY_SIGNAL') &&
    (atClose ? periodStart(f.date, 0) && f.date !== dates[0] : periodStart(f.date, 1) && ctx.days[dayIdx.get(f.date)! - 1] !== dates[0]);
  const fillDay = (f: RvFill) => (shifted(f) ? ctx.days[dayIdx.get(f.date)! - 1] : f.date);

  const mine: T[] = ours.run.trades.map((t) => ({
    asset: t.asset,
    entry: iso(t.entryT),
    entryPx: t.entryPrice,
    exit: t.reason === 'open' ? null : iso(t.exitT),
    exitPx: t.reason === 'open' ? null : t.exitPrice,
    reason: t.reason,
    pnl: t.pnl,
    bars: t.bars,
  }));
  const fillOf = (id: number, date: string, side: string, last: boolean) => {
    const fs = rv.fills.filter((f) => f.id === id && f.date === date && f.side === side);
    return fs.length === 0 ? null : last ? fs[fs.length - 1] : fs[0];
  };
  const theirs: T[] = rv.trades.map((t) => {
    // A trade's entry_px averages its buys (rebalancing top-ups too); ours is the first fill.
    const entry = fillOf(t.id, t.entryDate, 'BUY', false)!;
    const exit = t.exitDate === null ? null : fillOf(t.id, t.exitDate, 'SELL', true)!;
    return {
      asset: ctx.ids.get(t.id)!,
      entry: fillDay(entry),
      entryPx: entry.price,
      exit: exit === null ? null : fillDay(exit),
      exitPx: exit === null ? null : exit.price,
      reason: REASONS[t.reason] ?? (`? ${t.reason}` as ExitReason),
      pnl: t.pnl,
      bars: t.barsHeld,
    };
  });

  // Trades, matched by ticker and entry day.
  const key = (t: T) => `${t.asset} ${t.entry}`;
  const byKey = new Map(mine.map((t) => [key(t), t]));
  const mismatches: string[] = [];
  const onlyTheirs: T[] = [];
  const pairs: [T, T][] = [];
  const slip = spec.slippageBps / 10_000;
  for (const r of theirs) {
    const o = byKey.get(key(r));
    if (o) pairs.push([o, r]);
    else onlyTheirs.push(r);
  }
  const paired = new Set(pairs.map(([o]) => o));
  const onlyMine = mine.filter((t) => !paired.has(t));

  const ev = new Evaluator(ctx.data);
  const allowed = new Set(cfg.explain ?? []);
  const why = new Map<T, string>();
  const protective = (t: T) => t.reason === 'stop loss' || t.reason === 'trailing stop' || t.reason === 'take profit';
  const barIndex = (asset: string, day: string) => ctx.data.get(asset)!.t.findIndex((t) => iso(t) === day);
  const lastDay = dates[dates.length - 1];
  const nextDay = (d: string) => ctx.days[dayIdx.get(d)! + 1];
  const span = (t: T): [string, string] => [t.entry, t.exit ?? lastDay];

  // Matched trades: prices to Rearview's rounding, days and reasons exactly, bars held for closed
  // trades. A pair that differs only as a documented rule says is explained; if it left the market
  // on different days, those days are left out of the equity comparisons like an unmatched trade's.
  const problemsOf = (o: T, r: T) => {
    const problems: string[] = [];
    if (Math.abs(o.entryPx - r.entryPx) > PRICE_TOL) problems.push(`entry ${o.entryPx} vs ${r.entryPx}`);
    if (o.exit !== r.exit) problems.push(`exit day ${o.exit} vs ${r.exit}`);
    if (o.reason !== r.reason) problems.push(`reason ${o.reason} vs ${r.reason}`);
    if (o.exitPx !== null && r.exitPx !== null) {
      // Documented: Rearview fills targets as limit orders, without slippage; we slip every fill.
      const want = r.reason === 'take profit' ? r.exitPx * (1 - slip) : r.exitPx;
      if (Math.abs(o.exitPx - want) > PRICE_TOL + 1e-9 * want) problems.push(`exit ${o.exitPx} vs ${want}`);
    }
    if (o.exit !== null && !cfg.rebalanceShift && o.bars !== r.bars) problems.push(`bars ${o.bars} vs ${r.bars}`);
    return problems;
  };
  const trailPct = spec.stops[spec.universe[0].name]?.trailingStop;
  /** Rearview took a trailing stop on the entry bar from its fill price; ours trails the open there. */
  const entryBarTrail = (o: T, r: T) => {
    if (!allowed.has('trail') || r.reason !== 'trailing stop' || r.exit !== r.entry || trailPct?.k !== 'pct') return false;
    const bars = ctx.data.get(r.asset)!;
    const k = barIndex(r.asset, r.entry);
    const [open, low] = [bars.o[k], bars.l[k]];
    const ourLevel = open * (1 - trailPct.v);
    const theirLevel = r.entryPx * (1 - trailPct.v);
    // Both hit: the fills differ by the slippage on the entry price. Only theirs hit: the low lies between.
    if (o.exit === r.exit && o.reason === 'trailing stop') return Math.abs(o.exitPx! * (1 + slip) - r.exitPx!) <= PRICE_TOL * 2;
    return low > ourLevel && low <= theirLevel + PRICE_TOL;
  };
  /**
   * With close fills Rearview's trailing level counts the high of the bar it bought at, which came
   * before the fill. Explained when that high is above every later one before Rearview's exit, and
   * Rearview's exit is the fill at the level it gives.
   */
  const closeEntryTrail = (o: T, r: T) => {
    if (!atClose || !allowed.has('closetrail') || r.reason !== 'trailing stop' || r.exit === null || trailPct?.k !== 'pct') return false;
    const bars = ctx.data.get(r.asset)!;
    const k = barIndex(r.asset, r.entry);
    const x = barIndex(r.asset, r.exit);
    let later = bars.c[k];
    for (let j = k + 1; j < x; j++) later = Math.max(later, bars.h[j]);
    const level = bars.h[k] * (1 - trailPct.v);
    return bars.h[k] > later && (o.exit === null || o.exit >= r.exit) && Math.abs(r.exitPx! - Math.min(bars.o[x], level) * (1 - slip)) <= PRICE_TOL * 2;
  };
  const explainedSpans: T[] = [];
  const diverged: T[] = [];
  const mismatchedPairs = new Set<T>();
  let matched = 0;
  for (const [o, r] of pairs) {
    const problems = problemsOf(o, r);
    if (problems.length === 0) {
      matched++;
    } else if (closeEntryTrail(o, r)) {
      why.set(r, 'closetrail');
      // The money differs from Rearview's exit on, whether or not the exits fall on one day.
      const both = { ...r, exit: o.exit === null || o.exit > r.exit! ? o.exit : r.exit };
      explainedSpans.push(both);
      diverged.push(both);
    } else if (entryBarTrail(o, r)) {
      why.set(r, 'trail');
      if (o.exit !== r.exit) {
        // Spanning both exits.
        const both = { ...r, exit: o.exit === null || (r.exit !== null && o.exit > r.exit) ? o.exit : r.exit };
        explainedSpans.push(both);
        diverged.push(both);
      }
    } else {
      mismatchedPairs.add(o);
      mismatches.push(`${key(o)}: ${problems.join(', ')}`);
    }
  }

  // Unmatched trades: find a root cause the case allows, then their knock-ons.
  if (allowed.has('rearm')) {
    for (const r of onlyTheirs) {
      const k = barIndex(r.asset, r.entry);
      if (k < 1) continue;
      // With close fills the entry's own close is the signal: Rearview can buy at the close of the day its stop hit.
      const signal = atClose ? k : k - 1;
      const signalDay = iso(ctx.data.get(r.asset)!.t[signal]);
      const exited = [...mine, ...theirs].some((t) => t.asset === r.asset && t.exit === signalDay && protective(t));
      if (exited && ev.eval(spec.rules[r.asset].buy, r.asset)[signal] === 1) why.set(r, 'rearm');
    }
  }
  if (allowed.has('halt')) {
    for (const o of onlyMine) {
      const k = barIndex(o.asset, o.entry);
      if (k >= 1 && nextDay(iso(ctx.data.get(o.asset)!.t[k - 1])) !== o.entry) why.set(o, 'halt');
    }
  }
  const overlaps = (a: T, b: T) => a.asset === b.asset && span(a)[0] <= span(b)[1] && span(b)[0] <= span(a)[1];
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of [...onlyMine, ...onlyTheirs]) {
      const causes = [...explainedSpans, ...[...onlyMine, ...onlyTheirs].filter((u) => u !== t && why.has(u) && onlyMine.includes(u) !== onlyMine.includes(t))];
      if (!why.has(t) && causes.some((u) => overlaps(t, u))) {
        why.set(t, 'knock');
        changed = true;
      }
    }
  }
  const explained: Record<string, number> = {};
  const explainedList: string[] = [];
  const describe = (t: T, side: string) => `${key(t)} -> ${t.exit ?? 'open'} ${t.reason}: ${side}`;
  for (const [o, r] of pairs) {
    const w = why.get(r);
    if (w !== 'trail' && w !== 'closetrail') continue;
    explained[w] = (explained[w] ?? 0) + 1;
    explainedList.push(`${describe(r, 'Rearview')} vs ${o.exit ?? 'open'} ${o.reason} at ${o.exitPx} (${w})`);
  }
  for (const [list, side] of [[onlyMine, 'only ours'], [onlyTheirs, "only Rearview's"]] as const) {
    for (const t of list) {
      const w = why.get(t);
      if (w) {
        explained[w] = (explained[w] ?? 0) + 1;
        explainedList.push(`${describe(t, side)} (${w})`);
      } else mismatches.push(describe(t, side));
    }
  }

  // The days unmatched or diverging trades were open are left out of the equity comparisons;
  // levels are compared only up to the first of them, as the two runs' money differs from there on.
  const apart = [...onlyMine, ...onlyTheirs, ...diverged];
  // With several tickers, a position held while the money diverged carries other weights in the
  // two runs until it closes, and one bought beside it may be cut to other cash, and so on.
  if (spec.universe.length > 1) {
    const rest = new Set(pairs.map(([o]) => o));
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of rest) {
        if (!apart.some((u) => span(t)[0] <= span(u)[1] && span(u)[0] <= span(t)[1])) continue;
        apart.push(t);
        rest.delete(t);
        grew = true;
      }
    }
  }
  const excluded = new Set<string>();
  for (const t of apart) for (const d of dates) if (d >= span(t)[0] && d <= span(t)[1]) excluded.add(d);
  const firstExcluded = dates.find((d) => excluded.has(d)) ?? '9999';

  // P&L where the sizing is the same and the money hasn't diverged yet.
  if (cfg.equity === 'direct') {
    for (const [o, r] of pairs) {
      if (mismatchedPairs.has(o) || span(o)[1] >= firstExcluded || Math.abs(o.pnl - r.pnl) <= 1e-8 * spec.capital) continue;
      matched--;
      mismatches.push(`${key(o)}: pnl ${o.pnl} vs ${r.pnl}`);
    }
  }

  const ref = cfg.equity === 'direct' ? directReference(rv, dates) : replayReference(rv, dates, ctx.data.get(spec.universe[0].name)!, spec, theirs);
  const movedTo = new Set<string>();
  for (const f of rv.fills) {
    if (!shifted(f)) continue;
    // A fill Rearview makes a day after us costs it its commission and slippage that day; we pay
    // them the day before, at the same price (a calm first day), so move them there.
    const d = fillDay(f);
    const k = dates.indexOf(d);
    const bars = ctx.data.get(ctx.ids.get(f.id)!)!;
    ref.equity[k] -= f.commission + f.qty * Math.abs(f.price - bars.c[barIndex(ctx.ids.get(f.id)!, d)]);
    movedTo.add(d);
  }
  let levelWorst = 0;
  let levelWorstDate = '';
  let levelDays = 0;
  let returnWorst = 0;
  let returnWorstDate = '';
  let returnDays = 0;
  let exposureWorst = 0;
  for (let k = 0; k < dates.length; k++) {
    if (dates[k] < firstExcluded) {
      levelDays++;
      const d = relDiff(ours.run.equity[k], ref.equity[k]);
      if (d > levelWorst) [levelWorst, levelWorstDate] = [d, dates[k]];
    }
    if (k > 0 && !excluded.has(dates[k])) {
      returnDays++;
      const d = Math.abs(ours.run.equity[k] / ours.run.equity[k - 1] - ref.equity[k] / ref.equity[k - 1]);
      if (d > returnWorst) [returnWorst, returnWorstDate] = [d, dates[k]];
    }
    // On the day we rebalance and Rearview has yet to, the weights differ by design.
    if (cfg.equity === 'direct' && !excluded.has(dates[k]) && !movedTo.has(dates[k])) {
      exposureWorst = Math.max(exposureWorst, Math.abs(ours.run.exposure[k] - ref.exposure![k]));
    }
  }

  // Totals and statistics, when nothing diverged.
  const totals: string[] = [];
  let totalsOk = true;
  const check = (label: string, a: number, b: number, tol: number, digits = 2) => {
    totals.push(`${label} ${a.toFixed(digits)} vs ${b.toFixed(digits)}`);
    if (Math.abs(a - b) / Math.max(Math.abs(b), 1) > tol) totalsOk = false;
  };
  if (excluded.size === 0) {
    check('final', ours.run.equity[ours.run.equity.length - 1], ref.equity[ref.equity.length - 1], LEVEL_TOL);
    check('costs', ours.run.costs, ref.costs, LEVEL_TOL);
    check('interest', ours.run.interest, ref.interest, LEVEL_TOL);
    if (cfg.equity === 'direct') {
      for (const s of ours.run.states) {
        const id = [...ctx.ids].find(([, n]) => n === s.name)![0];
        const held = rv.fills.filter((f) => f.id === id).reduce((q, f) => q + (f.side === 'BUY' ? f.qty : -f.qty), 0);
        if (Math.abs(s.shares - held) > 1e-6 * Math.max(1, held) + 2e-6) {
          totals.push(`${s.name} shares ${s.shares} vs ${held}`);
          totalsOk = false;
        }
      }
      // Rearview's run starts with the same equity curve, unless told to start a day later.
      if (!cfg.rebalanceShift && rv.daily[0].date === dates[0]) {
        const s = rv.summary;
        check('CAGR', ours.stats.cagr, s.cagr, LEVEL_TOL, 6);
        check('max drawdown', ours.stats.maxDrawdown, s.max_drawdown, LEVEL_TOL, 6);
        check('avg exposure', ours.stats.exposure, s.avg_gross_exposure, LEVEL_TOL, 6);
        // Documented: Rearview's Sharpe has no cash rate, √252 and the sample deviation; ours takes
        // returns above the cash rate, √(steps a year) and the population deviation. Without a cash
        // rate they differ by those factors alone.
        if (rate === 0) {
          const n = dates.length - 1;
          const perYear = n / ((ours.run.t[ours.run.t.length - 1] - ours.run.t[0]) / (365.25 * DAY));
          check('Sharpe ×√(252/steps a year)×√((n-1)/n)', ours.stats.sharpe * Math.sqrt(252 / perYear) * Math.sqrt((n - 1) / n), s.sharpe, LEVEL_TOL, 6);
        }
      }
    }
  }
  // The orders the last close leaves for the next open: ours in each ticker's state, Rearview's as
  // pending market orders. (With a rebalance shift, Rearview decides a day after us.)
  if (!excluded.has(lastDay) && !cfg.rebalanceShift) {
    const pending = new Map(rv.orders.filter((o) => o.status === 'PENDING' && o.kind === 'MARKET_OPEN').map((o) => [ctx.ids.get(o.id)!, o.side === 'BUY' ? 'buy' : 'sell']));
    for (const st of ours.run.states) {
      const theirsPending = pending.get(st.name) ?? null;
      if (st.pending !== theirsPending) {
        totals.push(`${st.name} pending ${st.pending} vs ${theirsPending}`);
        totalsOk = false;
      }
      // With close fills what the last close decided has filled there: ours in `filled`, Rearview's as that day's signal fills.
      if (!atClose) continue;
      const id = [...ctx.ids].find(([, n]) => n === st.name)![0];
      const fill = rv.fills.find((f) => f.id === id && f.date === lastDay && (f.reason === 'ENTRY_SIGNAL' || f.reason === 'EXIT_SIGNAL'));
      const theirsFilled = fill ? (fill.side === 'BUY' ? 'buy' : 'sell') : null;
      if ((st.filled?.side ?? null) !== theirsFilled) {
        totals.push(`${st.name} filled at the last close ${st.filled?.side ?? null} vs ${theirsFilled}`);
        totalsOk = false;
      }
    }
  }

  const ok = mismatches.length === 0 && levelWorst <= LEVEL_TOL && returnWorst <= RETURN_TOL && exposureWorst <= LEVEL_TOL && totalsOk;
  return {
    name,
    what: cfg.what,
    equityMode: cfg.equity,
    ours: mine.length,
    theirs: theirs.length,
    matched,
    exits: exitCoverage(ours.run.trades, ctx.data, spec),
    mismatches,
    explained,
    explainedList,
    levelWorst,
    levelWorstDate,
    levelDays,
    returnWorst,
    returnWorstDate,
    returnDays,
    exposureWorst,
    totals,
    warnings: rv.warnings.map((w) => `${w.code}: ${w.message}`),
    ok,
  };
}

/** How our trades ended: signal exits, and stops (SL, TS) and targets (TP) inside the bar or at a gapped open (g); x: stop and target both in the bar. */
function exitCoverage(trades: ReturnType<typeof runBacktest>['run']['trades'], data: Map<string, Bars>, spec: Spec): string {
  const n: Record<string, number> = {};
  const add = (k: string) => (n[k] = (n[k] ?? 0) + 1);
  const slip = spec.slippageBps / 10_000;
  for (const t of trades) {
    const tag = { signal: 'sig', 'stop loss': 'SL', 'trailing stop': 'TS', 'take profit': 'TP', open: 'open' }[t.reason];
    add(tag);
    if (tag === 'sig' || tag === 'open') continue;
    const bars = data.get(t.asset)!;
    const k = bars.t.indexOf(t.exitT);
    const atOpen = bars.o[k] * (1 - slip);
    if (Math.abs(t.exitPrice - atOpen) < 1e-9 * atOpen) add(`${tag}g`);
    const tp = spec.stops[t.asset].takeProfit;
    if (tag !== 'TP' && tp?.k === 'pct' && bars.h[k] >= t.entryPrice * (1 + tp.v)) add('x');
  }
  const order = ['sig', 'SL', 'SLg', 'TS', 'TSg', 'TP', 'TPg', 'x', 'open'];
  return order.filter((k) => n[k]).map((k) => `${k} ${n[k]}`).join(', ');
}

interface Reference {
  equity: number[];
  exposure?: number[];
  costs: number;
  interest: number;
}

function directReference(rv: RvRun, dates: string[]): Reference {
  const byDate = new Map(rv.daily.map((d) => [d.date, d]));
  // A Rearview run told to start a day later holds its starting cash before then.
  const day = (d: string) => byDate.get(d) ?? (d < rv.daily[0].date ? { ...rv.daily[0], longMv: 0, equity: rv.daily[0].equity } : null);
  return {
    equity: dates.map((d) => day(d)?.equity ?? NaN),
    exposure: dates.map((d) => {
      const r = day(d);
      return r ? r.longMv / r.equity : NaN;
    }),
    costs: rv.fills.reduce((s, f) => s + f.commission, 0),
    interest: rv.interest,
  };
}

/**
 * Rearview's fills, at Rearview's prices, replayed with our sizing: each buy spends all the cash
 * (one ticker at 100%), costs on traded value, cash interest act/365. Two documented rules are
 * replayed our way: targets get our slippage, since Rearview fills them without any, and a
 * trailing stop taken inside the entry bar trails the open, not the fill with its slippage.
 */
function replayReference(rv: RvRun, dates: string[], bars: Bars, spec: Spec, trades: T[]): Reference {
  const cost = spec.costBps / 10_000;
  const slip = spec.slippageBps / 10_000;
  const rate = spec.cash.k === 'fixed' ? spec.cash.rate : 0;
  const closes = new Map(bars.t.map((t, i) => [iso(t), bars.c[i]]));
  const opens = new Map(bars.t.map((t, i) => [iso(t), bars.o[i]]));
  const sameDayTrail = new Set(trades.filter((t) => t.reason === 'trailing stop' && t.exit === t.entry).map((t) => t.entry));
  const ourPrice = (f: RvFill) => {
    if (f.reason === 'TARGET') return f.price * (1 - slip);
    const gapped = Math.abs(f.price - opens.get(f.date)! * (1 - slip)) <= PRICE_TOL;
    if (f.reason === 'TRAILING_STOP' && sameDayTrail.has(f.date) && !gapped) return f.price / (1 + slip);
    return f.price;
  };
  const fills = new Map<string, RvFill[]>();
  for (const f of rv.fills) fills.set(f.date, [...(fills.get(f.date) ?? []), f]);
  let cash = spec.capital;
  let shares = 0;
  let costs = 0;
  let interest = 0;
  const equity: number[] = [];
  dates.forEach((d, k) => {
    if (k > 0 && cash > 0) {
      const r = (rate * (Date.parse(d) - Date.parse(dates[k - 1]))) / DAY / 365;
      interest += cash * r;
      cash += cash * r;
    }
    for (const f of fills.get(d) ?? []) {
      if (f.side === 'BUY') {
        const spend = cash / (1 + cost);
        shares += spend / f.price;
        cash -= spend * (1 + cost);
        costs += spend * cost;
      } else {
        const value = shares * ourPrice(f);
        cash += value * (1 - cost);
        costs += value * cost;
        shares = 0;
      }
    }
    equity.push(cash + shares * closes.get(d)!);
  });
  return { equity, costs, interest };
}

// ---------------------------------------------------------------- main

function table(head: string[], rows: string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(head), ...rows.map(line)].join('\n');
}

function main(): number {
  if (!RVW) {
    const where = process.env.RVW ? `at ${process.env.RVW}` : 'on PATH';
    console.log(`Skipped: no Rearview CLI ${where}. Set RVW to its path, or put rvw on PATH, to run the cross-check.`);
    return 0;
  }
  mkdirSync(OUT, { recursive: true });
  const ctx = prepareData();
  let failed = 0;
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

  const inds = only.length ? [] : checkIndicators(ctx);
  if (inds.length) {
    console.log(`Indicators: ours against \`rvw eval\`, ${ctx.data.size} tickers, every bar (warm-up included)\n`);
    console.log(table(['ours', 'Rearview', 'values', 'worst rel', 'first value', 'status'], inds.map((r) => [r.ours, r.theirs, String(r.compared), fmtE(r.worst), r.warmup, r.ok ? 'pass' : 'FAIL'])));
    failed += inds.filter((r) => !r.ok).length;
  }

  const casesDir = join(HERE, 'cases');
  const results: CaseResult[] = [];
  for (const name of readdirSync(casesDir).sort()) {
    if (only.length && !only.includes(name)) continue;
    results.push(runCase(name, join(casesDir, name), ctx));
  }
  console.log('\nStrategies: trades matched by ticker and entry day; equity levels up to the first unmatched trade, daily returns on every day no unmatched trade was open\n');
  console.log(
    table(
      ['case', 'equity vs', 'trades ours/RV/same', 'explained', 'our exits', 'worst level (to day)', 'worst daily return', 'status'],
      results.map((r) => [
        r.name,
        r.equityMode,
        `${r.ours}/${r.theirs}/${r.matched}`,
        Object.entries(r.explained).map(([k, v]) => `${v} ${k}`).join(', ') || '-',
        r.exits,
        `${fmtE(r.levelWorst)} (${r.levelDays}d)`,
        `${fmtE(r.returnWorst)} (${r.returnDays}d)`,
        r.ok ? 'pass' : 'FAIL',
      ]),
    ),
  );
  for (const r of results) {
    const lines = [...r.mismatches.slice(0, 8), ...(r.mismatches.length > 8 ? [`... ${r.mismatches.length - 8} more`] : [])];
    if (verbose) lines.push(...r.explainedList.map((e) => `explained: ${e}`));
    if (r.totals.length && (verbose || !r.ok)) lines.push(`totals: ${r.totals.join('; ')}`);
    if (r.equityMode === 'direct' && (verbose || !r.ok)) lines.push(`worst daily exposure difference ${fmtE(r.exposureWorst)}`);
    if (!r.ok) lines.push(`worst level on ${r.levelWorstDate || '-'}, worst return on ${r.returnWorstDate || '-'}`);
    if (r.warnings.length && verbose) lines.push(`Rearview warnings: ${r.warnings.join('; ')}`);
    if (lines.length) console.log(`\n${r.name}: ${r.what}\n  ${lines.join('\n  ')}`);
    if (!r.ok) failed++;
  }
  console.log(`\nExits: sig signal, SL stop loss, TS trailing stop, TP take profit, g at a gapped open, x stop taken with the target also in the bar.`);
  console.log(`Explained differences:\n${Object.entries(EXPLAIN).map(([k, v]) => `  ${k}: ${v}`).join('\n')}`);
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ indicators: inds, cases: results }, null, 2));
  console.log(failed ? `\n${failed} check(s) failed. Details in ${join(OUT, 'report.json')}` : '\nAll checks passed.');
  return failed ? 1 : 0;
}

process.exitCode = main();
