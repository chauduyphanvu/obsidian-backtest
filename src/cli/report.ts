import { isIntraday, isoDate, minus, pct, stamp } from '../format.ts';
import { positionText } from '../export.ts';
import type { RunOutput } from '../runner.ts';
import { verdict } from '../verdict.ts';

/** A run as plain data: the figures against the benchmark, the trades, what it holds now, and what to know about the prices. */
export function runSummary(out: RunOutput, lastTrades = 10) {
  const bt = out.backtest;
  const intraday = isIntraday(bt.run.t);
  const v = verdict(bt);
  const figures = (s: typeof bt.stats) => ({ returnPerYear: s.cagr, totalReturn: s.totalReturn, worstDrawdown: s.maxDrawdown, sharpe: s.sharpe, exposure: s.exposure });
  return {
    name: bt.spec.name ?? null,
    from: isoDate(bt.run.t[0]),
    to: isoDate(bt.run.t[bt.run.t.length - 1]),
    verdict: [v.lead.map((p) => p.text).join(''), v.more].filter(Boolean),
    strategy: figures(bt.stats),
    benchmark: { label: bt.benchmark.label, ...figures(bt.benchmark.stats) },
    trades: bt.tradeStats,
    now: bt.run.states.map((st) => ({ ticker: st.name, holds: positionText(st, bt.spec.entries ?? 1, intraday) })),
    lastTrades: bt.run.trades.slice(-lastTrades).map((t) => ({
      ticker: t.asset,
      side: t.side ?? 'long',
      entry: stamp(t.entryT, intraday),
      exit: t.reason === 'open' ? null : stamp(t.exitT, intraday),
      return: t.ret,
      reason: t.reason,
    })),
    warnings: out.warnings,
    notes: out.notes ?? [],
  };
}

const ratio = (x: number) => (Number.isFinite(x) ? minus(x.toFixed(2)) : '–');

/** The run as text for a terminal or a model: the verdict, the figures side by side, the trades and what it holds now. */
export function runText(out: RunOutput): string {
  const s = runSummary(out);
  const rows: [string, string, string][] = [
    ['', 'Strategy', s.benchmark.label],
    ['Return per year', pct(s.strategy.returnPerYear), pct(s.benchmark.returnPerYear)],
    ['Total return', pct(s.strategy.totalReturn), pct(s.benchmark.totalReturn)],
    ['Worst drawdown', pct(s.strategy.worstDrawdown), pct(s.benchmark.worstDrawdown)],
    ['Sharpe ratio', ratio(s.strategy.sharpe), ratio(s.benchmark.sharpe)],
  ];
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length)));
  const table = rows.map((r) => `${r[0].padEnd(widths[0])}  ${r[1].padStart(widths[1])}  ${r[2].padStart(widths[2])}`.trimEnd());
  const t = s.trades;
  return [
    ...(s.name ? [s.name] : []),
    `${s.from} to ${s.to}`,
    '',
    ...s.verdict,
    '',
    ...table,
    '',
    `Trades: ${t.count} closed${t.count ? `, ${pct(t.winRate, 0)} won, ${pct(t.avgReturn)} on average` : ''}${t.open ? `, ${t.open} open` : ''}`,
    ...s.now.map((n) => `${n.ticker}: ${n.holds}`),
    ...[...s.warnings, ...s.notes].map((w) => `Note: ${w}`),
  ].join('\n');
}
