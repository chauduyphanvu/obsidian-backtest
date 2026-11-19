// The words at the top of a result: the opening sentence, the figures against the benchmark's, the years it came out
// ahead, and the trades in a sentence.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Backtest, Stats } from '../src/backtest.ts';
import type { Trade } from '../src/engine.ts';
import { benchProse, fallText, figures, tradesSentence, verdict, yearsAhead, yearsSentence } from '../src/verdict.ts';
import { DAY, T0 } from './helpers.ts';

const stats = (o: Partial<Stats>): Stats => ({ totalReturn: 1, cagr: 0.1, maxDrawdown: -0.2, volatility: 0.15, sharpe: 0.6, sortino: 0.8, exposure: 1, ...o });

/** A result with the figures given; its run is two flat bars unless a series is given. */
function result(mine: Partial<Stats>, theirs: Partial<Stats>, o: { label?: string; count?: number; open?: number; margin?: boolean; ruin?: number; t?: number[]; equity?: number[]; bench?: number[] } = {}): Backtest {
  const t = o.t ?? [T0, T0 + DAY];
  return {
    spec: { margin: o.margin ?? false },
    stats: stats(mine),
    tradeStats: { count: o.count ?? 5, open: o.open ?? 0, winRate: 0.4, avgReturn: 0.02 },
    run: { t, equity: o.equity ?? t.map(() => 1), trades: [], ruin: o.ruin === undefined ? null : { t: o.ruin, deficit: 0 } },
    benchmark: { label: o.label ?? 'Buy & hold', equity: o.bench ?? t.map(() => 1), drawdown: [], stats: stats(theirs) },
  } as unknown as Backtest;
}

const said = (bt: Backtest) => verdict(bt).lead.map((p) => p.text).join('');
const marked = (bt: Backtest, mark: 'strategy' | 'benchmark') => verdict(bt).lead.filter((p) => p.mark === mark).map((p) => p.text);

test('the opening sentence weighs return per year against the worst fall, with each figure marked as whose it is', () => {
  const tradeOff = result({ cagr: 0.0723548, maxDrawdown: -0.2444594 }, { cagr: 0.10585, maxDrawdown: -0.5518943 });
  assert.equal(said(tradeOff), '7.2% a year, compared with 10.6% for buy and hold. But its worst drawdown was smaller: 24%, compared with 55%.');
  assert.deepEqual(marked(tradeOff, 'strategy'), ['7.2% a year', '24%']);
  assert.deepEqual(marked(tradeOff, 'benchmark'), ['10.6%', '55%']);
  assert.equal(said(result({ cagr: 0.12, maxDrawdown: -0.24 }, { cagr: 0.106, maxDrawdown: -0.55 })), '12.0% a year, compared with 10.6% for buy and hold. Its worst drawdown was also smaller: 24%, compared with 55%.');
  assert.equal(said(result({ cagr: 0.12, maxDrawdown: -0.6 }, { cagr: 0.106, maxDrawdown: -0.55 })), '12.0% a year, compared with 10.6% for buy and hold. But its worst drawdown was larger: 60%, compared with 55%.');
  assert.equal(said(result({ cagr: -0.031, maxDrawdown: -0.6 }, { cagr: 0.106, maxDrawdown: -0.55 })), '−3.1% a year, compared with 10.6% for buy and hold. Its worst drawdown was also larger: 60%, compared with 55%.');
  // Figures that read the same are the same.
  assert.equal(said(result({ cagr: 0.10601, maxDrawdown: -0.24 }, { cagr: 0.106, maxDrawdown: -0.55 })), '10.6% a year, the same as buy and hold. Its worst drawdown was smaller: 24%, compared with 55%.');
  assert.equal(said(result({ cagr: 0.12, maxDrawdown: -0.551 }, { cagr: 0.106, maxDrawdown: -0.549 })), '12.0% a year, compared with 10.6% for buy and hold. Its worst drawdown was the same: 55%.');
  // A fall under 10% keeps a decimal.
  assert.equal(fallText(-0.0534), '5.3%');
  assert.equal(said(result({ cagr: 0.05, maxDrawdown: -0.0534 }, { cagr: 0.1, maxDrawdown: -0.3 }, { label: 'SPY buy & hold' })), '5.0% a year, compared with 10.0% for SPY buy and hold. But its worst drawdown was smaller: 5.3%, compared with 30%.');
});

test('the benchmark is named as a sentence reads it', () => {
  assert.equal(benchProse('Buy & hold'), 'buy and hold');
  assert.equal(benchProse('SPY buy & hold'), 'SPY buy and hold');
  assert.equal(benchProse('Equal-weight buy & hold'), 'equal-weight buy and hold');
});

test('after the opening sentence: the Sharpe ratios, the time in the market or the exposure, and the years ahead', () => {
  const v = verdict(result({ sharpe: 0.6575677, exposure: 0.8048692 }, { sharpe: 0.6278347 }));
  assert.equal(v.more, 'The Sharpe ratio was 0.03 higher: 0.66, compared with 0.63. The strategy was in the market 80% of the time.');
  assert.equal(verdict(result({ sharpe: 0.3, exposure: 1 }, { sharpe: 0.62 })).more, 'The Sharpe ratio was 0.32 lower: 0.30, compared with 0.62. The strategy was in the market all the time.');
  assert.equal(verdict(result({ sharpe: 0.6, exposure: 1.2, netExposure: 0.4 }, { sharpe: 0.6 }, { margin: true })).more, 'The Sharpe ratio was the same: 0.60. The average exposure was 120% gross and 40% net.');
});

test('a run that never opened a position, and a ruined run, say so instead', () => {
  const none = verdict(result({}, { cagr: 0.106 }, { count: 0, open: 0 }));
  assert.equal(none.lead.map((p) => p.text).join(''), 'No rule opened a position. All the money stayed in cash.');
  assert.equal(none.more, 'Buy and hold made 10.6% a year in the same period.');
  // Only open positions: it did trade.
  assert.notEqual(said(result({}, {}, { count: 0, open: 1 })), 'No rule opened a position. All the money stayed in cash.');
  const ruined = verdict(result({ cagr: -1 }, {}, { ruin: T0 + 3 * DAY }));
  assert.equal(ruined.lead.map((p) => p.text).join(''), 'The equity decreased to zero on 2020-01-04, and the run stopped.');
  assert.equal(ruined.more, '');
});

// Three whole calendar years: the strategy falls 5% while the benchmark falls 30%, then rises 10% against 20%, then both are flat.
const YEARS = [Date.UTC(2000, 11, 31), Date.UTC(2001, 0, 2), Date.UTC(2001, 11, 31), Date.UTC(2002, 0, 2), Date.UTC(2002, 11, 31), Date.UTC(2003, 0, 2), Date.UTC(2003, 11, 31)];
const MINE = [100, 100, 95, 95, 104.5, 104.5, 104.5];
const THEIRS = [100, 100, 70, 70, 84, 84, 84];

test('the years ahead, level and behind, and whether every year ahead was a falling one', () => {
  const y = yearsAhead(YEARS, MINE, THEIRS);
  assert.equal(y.years, 3);
  assert.deepEqual(y.ahead.map((p) => p.key), ['2001']);
  assert.equal(y.level, 1);
  assert.ok(y.onlyFalling);
  assert.equal(yearsSentence(y, 'buy and hold'), 'It did better than buy and hold only in down years: 2001.');
  assert.equal(yearsSentence({ ...y, ahead: [], onlyFalling: false }, 'buy and hold'), 'It did better than buy and hold in 0 of 3 full years.');
  assert.equal(yearsSentence({ ...y, onlyFalling: false }, 'buy and hold'), 'It did better than buy and hold in 1 of 3 full years.');
  // Under two whole years is too few to count.
  assert.equal(yearsSentence({ ...y, years: 1 }, 'buy and hold'), '');
  assert.match(verdict(result({}, {}, { t: YEARS, equity: MINE, bench: THEIRS })).more, / It did better than buy and hold only in down years: 2001\.$/);
});

test('each figure beside the benchmark’s, with how far apart they are in words', () => {
  const rows = figures(result({ cagr: 0.0723548, totalReturn: 3.6078878, maxDrawdown: -0.2444594, sharpe: 0.6575677, volatility: 0.116631, exposure: 0.8048692 }, { cagr: 0.10585, totalReturn: 8.028893, maxDrawdown: -0.5518943, sharpe: 0.6278347, volatility: 0.188656 }));
  assert.deepEqual(
    rows.map((r) => [r.label, r.sText, r.bText, r.delta]),
    [
      ['Return per year', '7.2%', '10.6%', '3.3 pts lower'],
      ['Total return', '360.8%', '802.9%', '442 pts lower'],
      ['Worst drawdown', '−24.4%', '−55.2%', '30.7 pts smaller'],
      ['Sharpe ratio', '0.66', '0.63', '0.03 higher'],
      ['Volatility', '11.7%', '18.9%', '7.2 pts lower'],
      ['Time invested', '80%', '100%', '19.5 pts lower'],
      ['Trades', '5', '', '40% won, +2.0% on average'],
    ],
  );
  assert.equal(figures(result({ cagr: 0.1 }, { cagr: 0.1 }))[0].delta, 'the same');
  assert.equal(figures(result({}, {}, { count: 0, open: 2 })).at(-1)!.delta, 'no closed trades');
  assert.equal(figures(result({}, {}, { count: 0, open: 0 })).at(-1)!.delta, 'no rule opened a position');
});

test('the trades in a sentence: how many won, what winners and losers made, and how much the best five made', () => {
  const trade = (ret: number, pnl: number, reason = 'signal'): Trade => ({ asset: 'A', entryT: 0, entryPrice: 1, exitT: 1, exitPrice: 1, ret, reason, bars: 1, pnl }) as Trade;
  // Ten closed: three big winners, seven small losers, and one still open that does not count.
  const trades = [trade(0.4, 4000), trade(0.3, 3000), trade(0.2, 2000), ...Array.from({ length: 7 }, () => trade(-0.02, -200)), trade(0.5, 5000, 'open')];
  assert.equal(tradesSentence({ run: { trades } } as unknown as Backtest), '3 of 10 closed trades won. The average trade with a profit made +30.0%. The average trade with a loss made −2.0%. The five best trades made $8,600. This is more than the $7,600 that all closed trades made together.');
  assert.equal(tradesSentence({ run: { trades: [trade(0.1, 100)] } } as unknown as Backtest), '1 of 1 closed trade won.');
  assert.equal(tradesSentence({ run: { trades: [trade(0.1, 100, 'open')] } } as unknown as Backtest), '');
});
