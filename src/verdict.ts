// What a result says in words before its figures: the sentence it opens with, each figure against the benchmark's with
// how far apart they are, and the years the strategy came out ahead.

import type { Backtest } from './backtest.ts';
import { MONTHS, isIntraday, minus, pct, plural, signedPct, stamp, ungroupedPlural } from './format.ts';
import { deepStats, periodReturns, type PeriodReturn, type Underwater } from './stats.ts';

/** A piece of a sentence; a marked piece is a figure of the strategy or of its benchmark, underlined in that line's colour. */
export interface Part {
  text: string;
  mark?: 'strategy' | 'benchmark';
}

export interface Verdict {
  lead: Part[];
  /** A quieter sentence or two after it; empty when there is nothing more to say. */
  more: string;
}

/** The benchmark's label as it reads inside a sentence: "buy and hold", "SPY buy and hold", "equal-weight buy and hold". */
export function benchProse(label: string): string {
  const text = label.replace(/ & /g, ' and ');
  return /^(Buy|Equal)/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

/** A worst drawdown as a fall: "24%", "5.3%". */
export const fallText = (dd: number): string => pct(-dd, -dd < 0.1 ? 1 : 0);

const ratio = (x: number): string => minus((Math.round(x * 100) / 100 || 0).toFixed(2));

/** "2008", "2008 and 2018", "2008, 2018 and 2022". */
export const listed = (items: string[]): string => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

export interface YearsAhead {
  /** Whole calendar years both the strategy and its benchmark cover. */
  years: number;
  ahead: PeriodReturn[];
  level: number;
  /** Every year ahead was a year the benchmark fell. */
  onlyFalling: boolean;
}

/** Years whose returns differ by less than this are level. */
export const LEVEL = 0.0005;

export function yearsAhead(t: number[], equity: number[], benchmark: number[]): YearsAhead {
  const mine = periodReturns(t, equity, 'year');
  const bench = new Map(periodReturns(t, benchmark, 'year').map((p) => [p.key, p]));
  const pairs = mine.flatMap((p) => {
    const b = bench.get(p.key);
    return b && !p.partial && !b.partial && Number.isFinite(p.ret) && Number.isFinite(b.ret) ? [[p, b] as const] : [];
  });
  const ahead = pairs.filter(([p, b]) => p.ret - b.ret > LEVEL);
  return {
    years: pairs.length,
    ahead: ahead.map(([p]) => p),
    level: pairs.filter(([p, b]) => Math.abs(p.ret - b.ret) <= LEVEL).length,
    onlyFalling: ahead.length > 0 && ahead.every(([, b]) => b.ret < 0),
  };
}

/** The years sentence: "It beat buy and hold only in down years: 2008, 2018 and 2022." Empty with under two full years. */
export function yearsSentence(y: YearsAhead, bench: string): string {
  if (y.years < 2) return '';
  if (y.ahead.length === 0) return `It did better than ${bench} in 0 of ${y.years} full years.`;
  if (y.onlyFalling && y.ahead.length < y.years && y.ahead.length <= 4) return `It did better than ${bench} only in down years: ${listed(y.ahead.map((p) => p.key))}.`;
  return `It did better than ${bench} in ${y.ahead.length} of ${y.years} full years.`;
}

export function verdict(bt: Backtest): Verdict {
  const { stats: s, tradeStats, run } = bt;
  const b = bt.benchmark.stats;
  const bench = benchProse(bt.benchmark.label);
  if (run.ruin) {
    return { lead: [{ text: `The equity decreased to zero on ${stamp(run.ruin.t, isIntraday(run.t))}, and the run stopped.` }], more: '' };
  }
  if (tradeStats.count === 0 && tradeStats.open === 0) {
    return {
      lead: [{ text: 'No rule opened a position. All the money stayed in cash.' }],
      more: Number.isFinite(b.cagr) ? `${bench[0].toUpperCase()}${bench.slice(1)} made ${pct(b.cagr)} a year in the same period.` : '',
    };
  }
  const S = (text: string): Part => ({ text, mark: 'strategy' });
  const B = (text: string): Part => ({ text, mark: 'benchmark' });
  const t = (text: string): Part => ({ text });
  const [sR, bR, sD, bD] = [pct(s.cagr), pct(b.cagr), fallText(s.maxDrawdown), fallText(b.maxDrawdown)];
  let lead: Part[];
  if (!Number.isFinite(b.cagr)) lead = [S(`${sR} a year`), t('. Its worst drawdown was '), S(sD), t('.')];
  else {
    const ret = sR === bR ? 0 : s.cagr > b.cagr ? 1 : -1;
    const fall = sD === bD ? 0 : s.maxDrawdown > b.maxDrawdown ? 1 : -1;
    const tail: Part[] =
      fall === 0
        ? [t(` Its worst drawdown was ${ret === 0 ? 'also ' : ''}the same: `), S(sD), t('.')]
        : fall > 0
          ? [t(ret < 0 ? ' But its worst drawdown was smaller: ' : ret > 0 ? ' Its worst drawdown was also smaller: ' : ' Its worst drawdown was smaller: '), S(sD), t(', compared with '), B(bD), t('.')]
          : [t(ret > 0 ? ' But its worst drawdown was larger: ' : ret < 0 ? ' Its worst drawdown was also larger: ' : ' Its worst drawdown was larger: '), S(sD), t(', compared with '), B(bD), t('.')];
    lead = ret === 0 ? [S(`${sR} a year`), t(`, the same as ${bench}.`), ...tail] : [S(`${sR} a year`), t(', compared with '), B(bR), t(` for ${bench}.`), ...tail];
  }

  const more: string[] = [];
  const time = bt.spec.margin
    ? `The average exposure was ${pct(s.exposure, 0)} gross and ${pct(s.netExposure ?? NaN, 0)} net.`
    : s.exposure >= 0.995
      ? 'The strategy was in the market all the time.'
      : `The strategy was in the market ${pct(s.exposure, 0)} of the time.`;
  if (Number.isFinite(s.sharpe) && Number.isFinite(b.sharpe)) {
    const d = Math.round(s.sharpe * 100) / 100 - Math.round(b.sharpe * 100) / 100;
    const word = `${ratio(Math.abs(d))} ${d > 0 ? 'higher' : 'lower'}`;
    more.push(Math.abs(d) < 0.005 ? `The Sharpe ratio was the same: ${ratio(s.sharpe)}. ${time}` : `The Sharpe ratio was ${word}: ${ratio(s.sharpe)}, compared with ${ratio(b.sharpe)}. ${time}`);
  }
  const years = yearsSentence(yearsAhead(run.t, run.equity, bt.benchmark.equity), bench);
  if (years) more.push(years);
  return { lead, more: more.join(' ') };
}

/** A figure of the strategy beside its benchmark's, for the rows under the verdict. */
export interface Figure {
  label: string;
  /** The values on one scale, for placing the two dots; NaN for one that is not known. */
  s: number;
  b: number;
  sText: string;
  bText: string;
  /** A quieter note under a value, such as the year of a best year. */
  sNote?: string;
  bNote?: string;
  /** How far apart they are, in words: "3.3 pts lower"; empty for none. */
  delta: string;
  /** Drawn without dots: a figure the benchmark has no counterpart of. */
  textOnly?: boolean;
}

/** "3.3 pts lower", "30.7 pts smaller", "the same". `up` and `down` say which way the strategy is from the benchmark. */
function apart(s: number, b: number, up: string, down: string, scale: number, digits: number, unit: string): string {
  if (!Number.isFinite(s) || !Number.isFinite(b)) return '';
  const d = Math.abs(s - b) * scale;
  const shown = d.toFixed(digits);
  if (Number(shown) === 0) return 'the same';
  return `${shown}${unit} ${s > b ? up : down}`;
}
const pts = (s: number, b: number, up = 'higher', down = 'lower') => apart(s, b, up, down, 100, Math.abs(s - b) * 100 >= 100 ? 0 : 1, ' pts');

/** The figures under the verdict, in the order they are shown. */
export function figures(bt: Backtest): Figure[] {
  const { stats: s, tradeStats: ts } = bt;
  const b = bt.benchmark.stats;
  const total = (x: number) => pct(x, Math.abs(x) >= 10 ? 0 : 1);
  const out: Figure[] = [
    { label: 'Return per year', s: s.cagr, b: b.cagr, sText: pct(s.cagr), bText: pct(b.cagr), delta: pts(s.cagr, b.cagr) },
    { label: 'Total return', s: s.totalReturn, b: b.totalReturn, sText: total(s.totalReturn), bText: total(b.totalReturn), delta: pts(s.totalReturn, b.totalReturn) },
    { label: 'Worst drawdown', s: s.maxDrawdown, b: b.maxDrawdown, sText: pct(s.maxDrawdown), bText: pct(b.maxDrawdown), delta: pts(s.maxDrawdown, b.maxDrawdown, 'smaller', 'larger') },
    { label: 'Sharpe ratio', s: s.sharpe, b: b.sharpe, sText: ratio(s.sharpe), bText: ratio(b.sharpe), delta: apart(Math.round(s.sharpe * 100) / 100, Math.round(b.sharpe * 100) / 100, 'higher', 'lower', 1, 2, '') },
    { label: 'Volatility', s: s.volatility, b: b.volatility, sText: pct(s.volatility), bText: pct(b.volatility), delta: pts(s.volatility, b.volatility) },
    // A block that can borrow may hold more than its equity, or short: its exposure is gross, with the net under it.
    bt.spec.margin
      ? { label: 'Exposure, gross', s: s.exposure, b: 1, sText: pct(s.exposure, 0), sNote: `net ${pct(s.netExposure ?? NaN, 0)}`, bText: '100%', delta: pts(s.exposure, 1) }
      : { label: 'Time invested', s: s.exposure, b: 1, sText: pct(s.exposure, 0), bText: '100%', delta: pts(s.exposure, 1) },
    {
      label: 'Trades',
      s: NaN,
      b: NaN,
      sText: String(ts.count),
      bText: '',
      delta: ts.count ? `${pct(ts.winRate, 0)} won, ${signedPct(ts.avgReturn)} on average` : ts.open ? 'no closed trades' : 'no rule opened a position',
      textOnly: true,
    },
  ];
  return out;
}

/** "45 days" up to two months, then "1 year 3 months". */
export function duration(days: number): string {
  if (days < 1) return 'less than a day';
  if (days < 60) return ungroupedPlural(Math.round(days), 'day');
  const months = Math.round(days / 30.4375);
  const years = Math.floor(months / 12);
  return [years > 0 ? ungroupedPlural(years, 'year') : '', months % 12 > 0 ? ungroupedPlural(months % 12, 'month') : ''].filter(Boolean).join(' ');
}

/** "2019", or "Mar 2020" for a month. */
export function periodName(p: PeriodReturn): string {
  if (p.key.length === 4) return p.key;
  const d = new Date(p.t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The figures shown under "More figures": ratios, best and worst periods, months with a gain and time below a high. */
export function moreFigures(bt: Backtest): Figure[] {
  const { run } = bt;
  const mine = deepStats(run.t, run.equity, run.cashReturn);
  const bench = deepStats(run.t, bt.benchmark.equity, run.cashReturn);
  const period = (label: string, get: (d: typeof mine) => PeriodReturn | null): Figure => {
    const [p, q] = [get(mine), get(bench)];
    return { label, s: p?.ret ?? NaN, b: q?.ret ?? NaN, sText: p ? signedPct(p.ret) : '–', bText: q ? signedPct(q.ret) : '–', sNote: p ? periodName(p) : undefined, bNote: q ? periodName(q) : undefined, delta: '' };
  };
  const below = (u: Underwater): [string, string | undefined] => (u.longestDays === 0 ? ['None', undefined] : [duration(u.longestDays), u.longestTo === null ? 'below at the end' : undefined]);
  const [sBelow, sBelowNote] = below(mine.underwater);
  const [bBelow, bBelowNote] = below(bench.underwater);
  return [
    { label: 'Sortino ratio', s: mine.sortino, b: bench.sortino, sText: ratio(mine.sortino), bText: ratio(bench.sortino), delta: '' },
    { label: 'Return per year ÷ worst drawdown', s: mine.calmar, b: bench.calmar, sText: ratio(mine.calmar), bText: ratio(bench.calmar), delta: '' },
    period('Best year', (d) => d.bestYear),
    period('Worst year', (d) => d.worstYear),
    { label: 'Months up', s: mine.positiveMonths, b: bench.positiveMonths, sText: pct(mine.positiveMonths, 0), bText: pct(bench.positiveMonths, 0), delta: '' },
    { label: 'Longest time below a previous high', s: mine.underwater.longestDays, b: bench.underwater.longestDays, sText: sBelow, bText: bBelow, sNote: sBelowNote, bNote: bBelowNote, delta: '' },
    period('Best month', (d) => d.bestMonth),
    period('Worst month', (d) => d.worstMonth),
  ];
}

/** The trades in a sentence or two: how many won, what winners and losers made, and how much the best few made. */
export function tradesSentence(bt: Pick<Backtest, 'run'>): string {
  const closed = bt.run.trades.filter((t) => t.reason !== 'open');
  if (closed.length === 0) return '';
  const won = closed.filter((t) => t.ret > 0);
  const lost = closed.filter((t) => t.ret <= 0);
  const avg = (list: typeof closed) => list.reduce((a, t) => a + t.ret, 0) / list.length;
  const parts = [`${won.length.toLocaleString('en-US')} of ${plural(closed.length, 'closed trade')} won.`];
  if (won.length && lost.length) parts.push(`The average trade with a profit made ${signedPct(avg(won))}. The average trade with a loss made ${signedPct(avg(lost))}.`);
  const total = closed.reduce((a, t) => a + t.pnl, 0);
  const best = [...closed].sort((x, y) => y.pnl - x.pnl).slice(0, 5);
  const top = best.reduce((a, t) => a + t.pnl, 0);
  if (closed.length >= 10 && total > 0 && top > total) parts.push(`The five best trades made ${moneyText(top)}. This is more than the ${moneyText(total)} that all closed trades made together.`);
  else if (closed.length >= 10 && total > 0) parts.push(`The five best trades made ${moneyText(top)} of the ${moneyText(total)} that all closed trades made.`);
  return parts.join(' ');
}

const moneyText = (x: number): string => `$${Math.round(x).toLocaleString('en-US')}`;
