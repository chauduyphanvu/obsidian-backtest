// Text a result can be kept as: CSV files, a snapshot note and note properties. Pure; the caller reads the clock and writes files.

import { drawdowns, type Backtest, type Segment } from './backtest.ts';
import type { AssetState, Trade } from './engine.ts';
import { csvField, isIntraday, isoDate, minus, money, pct, price, signedPct, stamp } from './format.ts';
import { positionOrder } from './orders.ts';
import { tradeExit } from './price-chart.ts';

const SNAPSHOT_TRADES = 30;

/** When a trade was bought: its first entry, and how many entries it had when there were several (its price is then their average). */
export function boughtText(t: Trade, intraday: boolean): string {
  const n = t.entries?.length ?? 1;
  return n > 1 ? `${stamp(t.entryT, intraday)}, ${n} entries` : stamp(t.entryT, intraday);
}

/** What a ticker holds after the last bar, as the positions table says it: "Long since …" or "Short since …", with the entries made of a position built in `steps`, or "In cash". */
export function positionText(st: AssetState, steps: number, intraday: boolean): string {
  if (st.side === null) return 'In cash';
  const built = steps > 1 ? `, ${st.entries} of ${steps} entries` : '';
  return `${st.side === 'long' ? 'Long' : 'Short'} since ${stamp(st.since!, intraday)}${built}`;
}

/** Whether a run has a short trade, which gives its trade lists a side. */
export const hasShorts = (trades: Trade[]): boolean => trades.some((t) => t.side === 'short');

export const csvLine = (fields: (string | number)[]): string => fields.map(csvField).join(',') + '\n';
/** Fixed decimals, without a "-0.00" for a loss too small to show. */
const fixed = (x: number, digits: number): string => {
  const v = x.toFixed(digits);
  return /^-0(\.0+)?$/.test(v) ? v.slice(1) : v;
};
/** Up to `digits` decimals, without trailing zeros. */
const trimmed = (x: number, digits: number): string => String(Number(x.toFixed(digits)));

/**
 * One row per trade. A strategy that builds positions in steps gets four more columns at the end: the number of entries,
 * and each entry's date, price and shares, separated by semicolons; `bought` is then the first entry and `buy_price` their
 * average. A run with a short trade gets a `side` column after all of them, long or short, so the others keep their
 * places; for a short, `bought` and `buy_price` are its entry, the short sale, and `sold` and `sell_price` the cover.
 */
export function tradesCsv(trades: Trade[], intraday: boolean): string {
  const steps = trades.some((t) => t.entries);
  const sides = hasShorts(trades);
  let out = csvLine([
    'ticker', 'bought', 'buy_price', 'sold', 'sell_price', 'return_pct', 'profit', 'bars', 'exit',
    ...(steps ? ['entries', 'entry_dates', 'entry_prices', 'entry_shares'] : []),
    ...(sides ? ['side'] : []),
  ]);
  for (const t of trades) {
    const open = t.reason === 'open';
    const entries = t.entries ?? [{ t: t.entryT, price: t.entryPrice, shares: NaN }];
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
      ...(steps
        ? [
            entries.length,
            entries.map((e) => stamp(e.t, intraday)).join(';'),
            entries.map((e) => trimmed(e.price, 6)).join(';'),
            entries.map((e) => (Number.isNaN(e.shares) ? '' : trimmed(e.shares, 6))).join(';'),
          ]
        : []),
      ...(sides ? [t.side ?? 'long'] : []),
    ]);
  }
  return out;
}

export function equityCsv(t: number[], strategy: number[], benchmark: number[], benchmarkLabel: string, intraday: boolean): string {
  const drawdown = drawdowns(strategy);
  let out = csvLine(['date', 'strategy', benchmarkLabel, 'drawdown_pct']);
  // A benchmark whose prices start later has no value (NaN) before then: leave the field empty.
  const cell = (x: number) => (Number.isFinite(x) ? fixed(x, 2) : '');
  for (let i = 0; i < t.length; i++) out += csvLine([stamp(t[i], intraday), cell(strategy[i]), cell(benchmark[i]), cell(drawdown[i] * 100)]);
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
  const intraday = isIntraday(run.t);
  const day = isoDate(input.now);
  const sections: string[] = [];

  sections.push(['---', 'tags: [backtest/snapshot]', `created: ${day}`, '---'].join('\n'));
  sections.push(
    `# ${input.name.trim() || 'Backtest'}\n\nSnapshot made on ${day}. The run is from ${stamp(run.t[0], intraday)} to ${stamp(run.t[run.t.length - 1], intraday)}. Start capital: ${money(spec.capital)}. The run is compared with ${benchmark.label}.`,
  );
  sections.push(`## Strategy\n\nThis copy is text, not a strategy block. Thus it does not run again.\n\n${fenced(input.source.replace(/^\s*\n/, '').trimEnd(), 'text')}`);

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
          spec.margin ? ['Exposure', `${pct(stats.exposure, 0)} gross, net ${pct(stats.netExposure ?? NaN, 0)}`, pct(b.exposure, 0)] : ['Time invested', pct(stats.exposure, 0), pct(b.exposure, 0)],
          ['Trades', tradesText(tradeStats), '–'],
          ['Trades won', pct(tradeStats.winRate, 0), '–'],
          ...(run.commission === undefined ? [] : [['Costs paid', `${money(run.costs)} (${money(run.commission)} commission)`, '–']]),
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
    '## Positions\n\n' +
      table(
        ['Ticker', 'Weight', 'Now'],
        run.states.map((st) => {
          const order = positionOrder(st, spec.fill);
          return [st.name, pct(st.weight, 0), positionText(st, spec.entries ?? 1, intraday) + (order ? `, ${order}` : '')];
        }),
        'lrl',
      ),
  );

  const latest = run.trades.slice(-SNAPSHOT_TRADES).reverse();
  const sides = hasShorts(run.trades);
  const tradeRows = latest.map((t) => {
    const open = t.reason === 'open';
    return [
      t.asset,
      ...(sides ? [sideText(t)] : []),
      boughtText(t, intraday),
      price(t.entryPrice),
      open ? '–' : stamp(t.exitT, intraday),
      open ? '–' : price(t.exitPrice),
      signedPct(t.ret),
      tradeExit(t, run.trades),
    ];
  });
  sections.push(
    '## Last trades\n\n' +
      (latest.length === 0
        ? 'No trades.'
        : (latest.length < run.trades.length ? `The last ${latest.length} of ${run.trades.length} trades.\n\n` : '') +
          (sides
            ? table(['Ticker', 'Side', 'Opened', 'At', 'Closed', 'At', 'Return', 'Exit'], tradeRows, 'lllrlrrl')
            : table(['Ticker', 'Bought', 'At', 'Sold', 'At', 'Return', 'Exit'], tradeRows, 'llrlrrl'))),
  );

  return sections.join('\n\n') + '\n';
}

/** A trade's side as a trade list says it. */
export const sideText = (t: Trade): string => (t.side === 'short' ? 'Short' : 'Long');

const round = (x: number, digits: number): number | string => (Number.isFinite(x) ? Number(x.toFixed(digits)) : '');

const PROPERTY_FIELDS = ['return_per_year', 'worst_drawdown', 'sharpe', 'trades', 'invested', 'from', 'to', 'benchmark_return_per_year', 'last_run', 'position'];
const propertyKey = (id: string, field: string) => (id ? `bt_${id}_${field}` : `bt_${field}`);
const isLastRun = (key: string) => key.endsWith('_last_run');

/**
 * What each strategy in a note puts between `bt_` and the rest of its keys, in the order given. A note with one
 * strategy has no such part (`bt_sharpe`). With several, a named strategy uses its name in lower case (`bt_trend_following_sharpe`);
 * one with no name, a name with no letters or digits, or a name that would give the same key as an earlier strategy uses its
 * position in the note (`bt_2_sharpe`), so no two strategies ever share a key.
 */
export function propertyIds(names: (string | null)[]): string[] {
  if (names.length <= 1) return names.map(() => '');
  const taken = new Set<string>();
  return names.map((name, i) => {
    const slug = name ? name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') : '';
    const free = (id: string) => PROPERTY_FIELDS.every((f) => !taken.has(propertyKey(id, f)));
    let id = slug;
    for (let n = 1; !id || !free(id); n++) id = n === 1 ? String(i + 1) : `${i + 1}_${n}`;
    for (const f of PROPERTY_FIELDS) taken.add(propertyKey(id, f));
    return id;
  });
}

/** Values to store in a note's properties so a Base can list strategies. `id` is from `propertyIds`. */
export function resultProperties(bt: Backtest, now: number, id = ''): Record<string, string | number> {
  const { run, stats, tradeStats, benchmark } = bt;
  const held = run.states.filter((s) => s.side !== null).map((s) => (s.side === 'short' ? `${s.name} (short)` : s.name));
  const values: Record<string, string | number> = {
    return_per_year: round(stats.cagr * 100, 1),
    worst_drawdown: round(stats.maxDrawdown * 100, 1),
    sharpe: round(stats.sharpe, 2),
    trades: tradeStats.count,
    invested: round(stats.exposure * 100, 0),
    from: isoDate(run.t[0]),
    to: isoDate(run.t[run.t.length - 1]),
    benchmark_return_per_year: round(benchmark.stats.cagr * 100, 1),
    last_run: isoDate(now),
    position: held.length ? held.join(', ') : 'cash',
  };
  return Object.fromEntries(PROPERTY_FIELDS.map((f) => [propertyKey(id, f), values[f]]));
}

/** What to change in a note's front matter. */
export interface PropertyPlan {
  set: Record<string, string | number>;
  remove: string[];
}

/**
 * Compares the figures the note's strategies give (`produced`) with its front matter. Only values that differ are set, and
 * the last-run date is set only when something else changes (or it is missing), so opening a note on a new day does not
 * rewrite it. When every strategy ran (`complete`), `bt_` keys that none of them produces any more are removed; when one
 * did not, old keys are left alone, because the missing figures might still be wanted. Nothing is removed from a note
 * that produced nothing.
 */
export function planProperties(existing: Record<string, unknown> | undefined, produced: Record<string, string | number>, complete: boolean): PropertyPlan {
  const have = existing ?? {};
  const keys = Object.keys(produced);
  const remove = complete && keys.length > 0 ? Object.keys(have).filter((k) => k.startsWith('bt_') && !(k in produced)) : [];
  const changed = keys.some((k) => !isLastRun(k) && have[k] !== produced[k]);
  const dirty = changed || remove.length > 0;
  const set: Record<string, string | number> = {};
  for (const k of keys) {
    if (isLastRun(k) ? dirty || !(k in have) : have[k] !== produced[k]) set[k] = produced[k];
  }
  return { set, remove };
}
