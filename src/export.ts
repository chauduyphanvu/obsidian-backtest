// Text a result can be kept as: CSV files, a snapshot note and note properties. Pure; the caller reads the clock and writes files.

import { drawdowns, type Backtest, type Segment } from './backtest.ts';
import { DAY, isoDate, minus, money, pct, price, signedPct, stamp } from './dom.ts';
import type { Trade } from './engine.ts';

const SNAPSHOT_TRADES = 30;

const csvField = (v: string | number): string => {
  const x = String(v);
  return /[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
};
const csvLine = (fields: (string | number)[]): string => fields.map(csvField).join(',') + '\n';
/** Fixed decimals, without a "-0.00" for a loss too small to show. */
const fixed = (x: number, digits: number): string => {
  const v = x.toFixed(digits);
  return /^-0(\.0+)?$/.test(v) ? v.slice(1) : v;
};
/** Up to `digits` decimals, without trailing zeros. */
const trimmed = (x: number, digits: number): string => String(Number(x.toFixed(digits)));

export function tradesCsv(trades: Trade[], intraday: boolean): string {
  let out = csvLine(['ticker', 'bought', 'buy_price', 'sold', 'sell_price', 'return_pct', 'profit', 'bars', 'exit']);
  for (const t of trades) {
    const open = t.reason === 'open';
    out += csvLine([
      t.asset,
      stamp(t.entryT, intraday),
      trimmed(t.entryPrice, 6),
      open ? '' : stamp(t.exitT, intraday),
      open ? '' : trimmed(t.exitPrice, 6),
      fixed(t.ret * 100, 2),
      fixed(t.pnl, 2),
      t.bars,
      t.reason,
    ]);
  }
  return out;
}

export function equityCsv(t: number[], strategy: number[], benchmark: number[], benchmarkLabel: string, intraday: boolean): string {
  const drawdown = drawdowns(strategy);
  let out = csvLine(['date', 'strategy', benchmarkLabel, 'drawdown_pct']);
  for (let i = 0; i < t.length; i++) out += csvLine([stamp(t[i], intraday), fixed(strategy[i], 2), fixed(benchmark[i], 2), fixed(drawdown[i] * 100, 2)]);
  return out;
}

const ratio = (x: number) => minus(x.toFixed(2));
const totalReturn = (x: number) => pct(x, Math.abs(x) >= 10 ? 0 : 1);

/** A Markdown table; `align` has one letter per column, `l` or `r`. */
function table(head: string[], rows: string[][], align: string): string {
  const row = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
  const rule = [...align].map((a) => (a === 'r' ? '---:' : '---'));
  return [row(head), `| ${rule.join(' | ')} |`, ...rows.map(row)].join('\n');
}

/** A fence longer than any run of backticks inside, so the text cannot end it early. */
function fenced(text: string, lang: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

const tradesText = (n: Backtest['tradeStats']) => (n.open > 0 ? `${n.count} closed, ${n.open} open` : String(n.count));

/**
 * A note body recording one result so it can be kept. The strategy sits in a `text` fence, not a `strategy` one,
 * so the saved copy never runs again.
 */
export function snapshotMarkdown(input: { name: string; source: string; backtest: Backtest; now: number }): string {
  const { backtest: bt } = input;
  const { run, stats, tradeStats, benchmark, spec } = bt;
  const intraday = run.t.some((t) => t % DAY !== 0);
  const day = isoDate(input.now);
  const sections: string[] = [];

  sections.push(['---', 'tags: [backtest/snapshot]', `created: ${day}`, '---'].join('\n'));
  sections.push(
    `# ${input.name.trim() || 'Backtest'}\n\nSnapshot taken on ${day}. The run covers ${stamp(run.t[0], intraday)} to ${stamp(run.t[run.t.length - 1], intraday)}, starting with ${money(spec.capital)}, and is compared with ${benchmark.label}.`,
  );
  sections.push(`## Strategy\n\nKept as plain text, so it does not run again.\n\n${fenced(input.source.replace(/^\s*\n/, '').trimEnd(), 'text')}`);

  const b = benchmark.stats;
  sections.push(
    '## Figures\n\n' +
      table(
        ['', 'Strategy', benchmark.label],
        [
          ['Return per year', pct(stats.cagr), pct(b.cagr)],
          ['Total return', totalReturn(stats.totalReturn), totalReturn(b.totalReturn)],
          ['Worst drawdown', pct(stats.maxDrawdown), pct(b.maxDrawdown)],
          ['Sharpe ratio', ratio(stats.sharpe), ratio(b.sharpe)],
          ['Time invested', pct(stats.exposure, 0), pct(b.exposure, 0)],
          ['Trades', tradesText(tradeStats), '–'],
          ['Share won', pct(tradeStats.winRate, 0), '–'],
        ],
        'lrr',
      ),
  );

  if (bt.segments) {
    const rows = bt.segments.map((g: Segment) => [
      g.label,
      `${stamp(g.from, intraday)} to ${stamp(g.to, intraday)}`,
      pct(g.stats.cagr),
      totalReturn(g.stats.totalReturn),
      pct(g.stats.maxDrawdown),
      ratio(g.stats.sharpe),
      tradesText(g.tradeStats),
      pct(g.benchmarkStats.cagr),
    ]);
    sections.push(
      '## Before and after the test date\n\n' +
        table(['Period', 'Dates', 'Return per year', 'Total return', 'Worst drawdown', 'Sharpe ratio', 'Trades', `${benchmark.label}, return per year`], rows, 'llrrrrrr'),
    );
  }

  sections.push(
    '## Positions now\n\n' +
      table(
        ['Ticker', 'Weight', 'Now'],
        run.states.map((st) => [
          st.name,
          pct(st.weight, 0),
          (st.long ? `Long since ${stamp(st.since!, intraday)}` : 'In cash') + (st.pending ? `, ${st.pending === 'buy' ? 'buys' : 'sells'} at the next open` : ''),
        ]),
        'lrl',
      ),
  );

  const latest = run.trades.slice(-SNAPSHOT_TRADES).reverse();
  const tradeRows = latest.map((t) => {
    const open = t.reason === 'open';
    return [
      t.asset,
      stamp(t.entryT, intraday),
      price(t.entryPrice),
      open ? '–' : stamp(t.exitT, intraday),
      open ? '–' : price(t.exitPrice),
      signedPct(t.ret),
      open ? 'still held' : t.reason === 'signal' ? 'sell rule' : t.reason,
    ];
  });
  sections.push(
    '## Latest trades\n\n' +
      (latest.length === 0
        ? 'No trades.'
        : (latest.length < run.trades.length ? `Showing the latest ${latest.length} of ${run.trades.length}.\n\n` : '') +
          table(['Ticker', 'Bought', 'At', 'Sold', 'At', 'Return', 'Exit'], tradeRows, 'llrlrrl')),
  );

  return sections.join('\n\n') + '\n';
}

const round = (x: number, digits: number): number | string => (Number.isFinite(x) ? Number(x.toFixed(digits)) : '');

/**
 * Values to store in a note's properties so a Base can list strategies. With a `name` and `multiple`, every key takes the name
 * between `bt_` and the rest, such as `bt_trend_following_sharpe`, so several strategies fit in one note.
 */
export function resultProperties(bt: Backtest, now: number, opts: { name?: string | null; multiple?: boolean } = {}): Record<string, string | number> {
  const slug = opts.name && opts.multiple ? opts.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') : '';
  const key = (field: string) => (slug ? `bt_${slug}_${field}` : `bt_${field}`);
  const { run, stats, tradeStats, benchmark } = bt;
  const held = run.states.filter((s) => s.long).map((s) => s.name);
  return {
    [key('return_per_year')]: round(stats.cagr * 100, 1),
    [key('worst_drawdown')]: round(stats.maxDrawdown * 100, 1),
    [key('sharpe')]: round(stats.sharpe, 2),
    [key('trades')]: tradeStats.count,
    [key('invested')]: round(stats.exposure * 100, 0),
    [key('from')]: isoDate(run.t[0]),
    [key('to')]: isoDate(run.t[run.t.length - 1]),
    [key('benchmark_return_per_year')]: round(benchmark.stats.cagr * 100, 1),
    [key('last_run')]: isoDate(now),
    [key('position')]: held.length ? held.join(', ') : 'cash',
  };
}
