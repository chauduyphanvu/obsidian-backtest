// A short, flipping or leveraged result drawn into a stand-in for the page: the figures, the notes, the chart's read-out, the
// positions and trades tables, the price chart and the bar-by-bar table.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { renderDebug } from '../src/render-debug.ts';
import { renderPriceCharts } from '../src/render-price.ts';
import { renderPositions, renderTrades } from '../src/render-trades.ts';
import { renderResult } from '../src/render.ts';
import type { RunOutput } from '../src/runner.ts';
import type { Bars } from '../src/types.ts';
import { bars, DAY, T0 } from './helpers.ts';

import { El } from './page.ts';

// --- Results ------------------------------------------------------------------------------------------------------

function run(src: string, data: Record<string, Bars>): RunOutput {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  const map = new Map(Object.entries(data));
  return { spec: spec!, backtest: runBacktest(spec!, map), data: map, warnings: [], prices: [] };
}
const day = (n: number) => T0 + n * DAY;
function ohlc(rows: number[][]): Bars {
  return { t: rows.map((_, n) => day(n)), o: rows.map((r) => r[0]), h: rows.map((r) => r[1]), l: rows.map((r) => r[2]), c: rows.map((r) => r[3]), v: rows.map(() => 1000) };
}
const flat = (n: number, price = 100) => bars(Array.from({ length: n }, () => price));

function draw(out: RunOutput, source = ''): El {
  const root = new El('div');
  renderResult(root as unknown as HTMLElement, { source, out, notes: [], onRefresh: () => {} });
  return root;
}
/** The figures under the verdict as label, the strategy's value, the note under it and the benchmark's value. */
const figures = (root: El) =>
  root
    .byClass('bt-vs-row')
    .filter((r) => !r.classes().includes('bt-vs-head'))
    .map((r) => [r.byClass('bt-vs-label')[0].textContent, r.byClass('bt-vs-s')[0].byClass('bt-vs-value')[0].textContent, r.byClass('bt-vs-s')[0].byClass('bt-vs-note')[0]?.textContent ?? '', r.byClass('bt-vs-b')[0]?.textContent ?? '']);
/** Moves the pointer over the result's chart to the bar at `share` of the way across, and gives what the read-out says it held. */
function hover(root: El, share: number): string {
  const chart = root.byClass('bt-chart')[0];
  const hit = chart.all().find((e) => e.tag === 'rect' && e.attrs.fill === 'transparent')!;
  hit.dispatch('pointermove', { clientX: Number(hit.attrs.x) + share * Number(hit.attrs.width) });
  return root.byClass('bt-read-state')[0].textContent;
}

/** Long A at 100% and short B at 50%: 150% gross and 50% net from the second bar, with no fees to move them. */
const LONG_SHORT = 'universe: A 100%, B 50%\ncapital: 10000\nborrow fee: 0%\nmargin rate: 0%\nfor A:\nbuy when true\nfor B:\nshort when true';

test('a block that can borrow shows its exposure, gross and net, where a long-only block shows its time invested', () => {
  const out = run(LONG_SHORT, { A: flat(5), B: flat(5) });
  const root = draw(out);
  const exposure = figures(root).find((t) => t[0] === 'Exposure, gross');
  // Four of five bars at 150% gross and 50% net, against the benchmark's 100%.
  assert.deepEqual(exposure, ['Exposure, gross', '120%', 'net 40%', '100%']);
  assert.ok(!figures(root).some((t) => t[0] === 'Time invested'));
  assert.equal(hover(root, 1), 'Exposure 150% gross, net 50%');
  assert.equal(hover(root, 0), 'Exposure 0% gross, net 0%');
  // A short alone has a net exposure below 0.
  const short = draw(run('universe: A\ncapital: 10000\nborrow fee: 0%\nshort when true', { A: flat(5) }));
  assert.equal(hover(short, 1), 'Exposure 100% gross, net −100%');
  const long = draw(run('universe: A\nbuy when true', { A: bars([10, 10, 11, 12, 13]) }));
  // Four of five bars invested, against the benchmark's 100%.
  assert.deepEqual(figures(long).find((t) => t[0] === 'Time invested'), ['Time invested', '80%', '', '100%']);
  assert.ok(figures(long).some((t) => t[0] === 'Volatility'));
  assert.equal(hover(long, 1), '100% invested');
});

test('the borrow fees and the interest on borrowed money are said with the costs', () => {
  // 150% long and 50% short of 10,000: 5,000 borrowed for the long, 5,000 of shares borrowed, over about three weeks.
  const src = 'universe: A 150%, B 50%\ncapital: 10000\nborrow fee: 10%\nmargin rate: 10%\nfor A:\nbuy when true\nfor B:\nshort when true';
  const out = run(src, { A: flat(20), B: flat(20) });
  const { borrowFees, marginInterest } = out.backtest.run;
  assert.ok(borrowFees! > 20 && marginInterest! > 20, `${borrowFees}, ${marginInterest}`);
  const root = draw(out);
  const fine = root.byClass('bt-note').map((n) => n.textContent).find((t) => t.includes('Costs') || t.includes('Borrow'))!;
  assert.ok(fine.includes(`Borrow fees for shorts: $${Math.round(borrowFees!)}.`), fine);
  assert.ok(fine.includes(`Interest on borrowed money: $${Math.round(marginInterest!)}.`), fine);
  // Under half a dollar is not worth a line.
  const tiny = draw(run('universe: A\ncapital: 10000\nborrow fee: 0.5%\nshort when close >= 100\ncover when close < 85', { A: bars([100, 90, 80, 80]) }));
  assert.ok(!tiny.has('Borrow fees for shorts'));
  assert.ok(!draw(run('universe: A\nbuy when true', { A: bars([10, 11, 12]) })).has('Borrow fees'));
});

test('margin calls, a ruin and rules that both held are notes on the result, counted on the folded line', () => {
  const ruined = ohlc([[100, 100, 100, 100], [100, 100, 70, 70], [70, 70, 66, 66], [45, 65, 45, 60], [60, 80, 60, 80], [80, 90, 80, 90]]);
  const root = draw(run('universe: A 200%\ncapital: 10000\nmargin rate: 0%\nbuy when true', { A: ruined }));
  assert.deepEqual(
    root.byClass('bt-warning').map((w) => w.textContent),
    [
      "1 margin call: equity fell below 25% of the positions' value, and every position was closed at the next open.",
      'Ruined on 2020-01-04: equity fell to zero and the run stopped there; the account owed $1,000 more.',
    ],
  );
  assert.equal(root.byClass('bt-fold-mark')[0].textContent, '2 notes');
  const both = draw(run('universe: A\nbuy when true\nshort when true', { A: flat(5) }));
  assert.deepEqual(both.byClass('bt-warning').map((w) => w.textContent), ['Buy and short rules both held on 5 bars, so neither opened a position.']);
  const one = draw(run('universe: A\nbuy when close > 100\nshort when close > 100\nfill: close', { A: bars([100, 101, 100]) }));
  assert.ok(one.byClass('bt-warning').some((w) => w.textContent === 'Buy and short rules both held on 1 bar, so neither opened a position.'));
});

test('a ruined run\'s line ends before the ruin, and the axis is not stretched to 0', () => {
  const ruined = ohlc([[100, 100, 100, 100], [100, 100, 70, 70], [70, 70, 66, 66], [45, 65, 45, 60], [60, 80, 60, 80], [80, 90, 80, 90]]);
  const root = draw(run('universe: A 200%\ncapital: 10000\nmargin rate: 0%\nbuy when true', { A: ruined }));
  const chart = root.byClass('bt-chart')[0];
  const line = chart.all().find((e) => e.attrs.class === 'bt-line bt-line-strategy')!;
  assert.equal(line.attrs.d.split('L').length, 3, line.attrs.d);
  assert.ok(!/NaN|Infinity/.test(chart.all().map((e) => e.attrs.d ?? '').join('')));
  // The money axis stays near the run's own values, with nothing printed at fractions of a cent.
  const labels = chart.all().filter((e) => e.attrs.class === 'bt-axis' && e.attrs['text-anchor'] === 'end').map((e) => e.textContent);
  assert.ok(labels.every((l) => !l.startsWith('$0')), labels.join(' '));
});

test('the positions table says a short held, and the trades table gives each trade its side when the run shorts', () => {
  const out = run('universe: A\nfill: close\nbuy when close > 100\nshort when close < 100', { A: bars([101, 99, 101, 98]) });
  const root = new El('div');
  renderPositions(root as unknown as HTMLElement, out.backtest, false);
  const nowCell = root.all().filter((e) => e.tag === 'td')[2];
  const now = nowCell.textContent;
  assert.ok(now.startsWith('Short since 2020-01-04, '), now);
  // Its date is kept whole too.
  assert.ok(nowCell.children.some((c) => typeof c !== 'string' && c.classes().includes('bt-nowrap') && c.textContent === '2020-01-04,'));
  renderTrades(root as unknown as HTMLElement, out.backtest, false);
  const details = root.all().find((e) => e.tag === 'details')!;
  details.dispatch('toggle');
  const table = details.byClass('bt-table')[0];
  assert.deepEqual(table.all().filter((e) => e.tag === 'th').map((e) => e.textContent), ['Why', 'Ticker', 'Side', 'Opened', 'At', 'Closed', 'At', 'Return', 'Profit', 'Exit']);
  const rows = table.all().filter((e) => e.tag === 'tr').slice(1).map((r) => r.children.slice(1).map((c) => (c as El).textContent));
  assert.deepEqual(rows.map((r) => [r[1], r[2], r[8]]), [['Short', '2020-01-04', 'still held'], ['Long', '2020-01-03', 'flipped to short'], ['Short', '2020-01-02', 'flipped to long'], ['Long', '2020-01-01', 'flipped to short']]);
  // The Side column leaves the dates less room: each is kept whole, so a line breaks at a space, as in the exit, never inside a date.
  const dates = table.all().filter((e) => e.tag === 'td' && /^\d{4}-\d\d-\d\d$/.test(e.textContent));
  assert.equal(dates.length, 7);
  assert.ok(dates.every((td) => td.children.length === 1 && typeof td.children[0] !== 'string' && td.children[0].classes().includes('bt-nowrap')));
  // An explanation opened under a row spans every column.
  const button = table.byClass('bt-why')[0];
  button.dispatch('click');
  const opened = table.byClass('bt-explain-tr')[0];
  assert.equal((opened.children[0] as El).colSpan, 10);
  assert.ok(opened.has('Why it was shorted'));
  // A long-only run keeps its columns.
  const long = new El('div');
  renderTrades(long as unknown as HTMLElement, run('universe: A\nbuy when close > 10\nsell when close < 10', { A: bars([10, 12, 9, 9]) }).backtest, false);
  long.all().find((e) => e.tag === 'details')!.dispatch('toggle');
  assert.deepEqual(long.all().filter((e) => e.tag === 'th').map((e) => e.textContent), ['Why', 'Ticker', 'Bought', 'At', 'Sold', 'At', 'Return', 'Profit', 'Exit']);
});

test('the price chart marks a short sale and a cover apart from a buy and a sell, and shades the time held short', () => {
  const out = run('universe: A\nfill: close\nbuy when close > 100\nshort when close < 100', { A: bars([101, 102, 99, 98, 101, 103]) });
  const { backtest: bt } = out;
  const root = new El('div');
  renderPriceCharts(root as unknown as HTMLElement, { data: out.data, tickers: ['A'], trades: bt.run.trades, from: bt.run.t[0], to: bt.run.t.at(-1)!, intraday: false });
  root.all().find((e) => e.tag === 'details')!.dispatch('toggle');
  const keys = root.byClass('bt-key').filter((k) => !k.hidden).map((k) => k.textContent);
  assert.deepEqual(keys, ['Price', 'Held', 'Held short', 'Buy', 'Sell', 'Sell short', 'Buy to cover']);
  const chart = root.byClass('bt-price-chart')[0];
  const paths = (cls: string) => chart.all().filter((e) => e.attrs.class === cls);
  // One buy (the first) and the buy of the flip back; one sell, one short sale and one cover at the flips.
  const count = (cls: string) => paths(cls).reduce((n, p) => n + p.attrs.d.split('M').length - 1, 0);
  assert.deepEqual(['bt-price-buy', 'bt-price-sell', 'bt-price-short', 'bt-price-cover'].map(count), [2, 1, 1, 1]);
  // A short sale points down from above the price like a sell, a cover up from below like a buy: the tip's y, then the base's.
  const tipAndBase = (cls: string) => paths(cls)[0].attrs.d.match(/^M[\d.]+,([\d.]+)L[\d.]+,([\d.]+)/)!.slice(1).map(Number);
  const [shortTip, shortBase] = tipAndBase('bt-price-short');
  const [coverTip, coverBase] = tipAndBase('bt-price-cover');
  assert.ok(shortBase < shortTip && coverBase > coverTip);
  assert.equal(paths('bt-price-band bt-price-band-short').length, 1);
  assert.equal(paths('bt-price-band').length, 2);
  // The tooltip over the short.
  const hit = root.all().find((e) => e.tag === 'rect' && e.attrs.fill === 'transparent')!;
  const left = Number(hit.attrs.x);
  hit.dispatch('pointermove', { clientX: left + (Number(hit.attrs.width) * 2.5) / 5 });
  const tip = root.byClass('bt-price-tip')[0];
  const rows = tip.byClass('bt-price-tip-row').map((r) => r.children.map((c) => (c as El).textContent));
  assert.deepEqual(rows.map((r) => r[0]), ['Close', 'Sold short', 'Bought to cover', 'Return', 'Reason']);
  assert.deepEqual(rows[1], ['Sold short', '2020-01-03 at 99.00']);
  assert.deepEqual(rows.at(-1), ['Reason', 'flipped to long']);
});

test('the bar-by-bar table shades the bars held short apart, dims the cover rule while no short is held, and says so', async () => {
  // Long, then short from the third bar, then long again: the cover rule and the buy rule hold together at 106.
  const out = run('universe: A\nbuy when close > 100\nsell when close < 95\nshort when close < 100\ncover when close > 105', { A: bars([101, 101, 99, 99, 106, 106]) });
  const root = new El('div');
  renderDebug(root as unknown as HTMLElement, { backtest: out.backtest, intraday: false, save: () => {} });
  root.all().find((e) => e.tag === 'details')!.dispatch('toggle');
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const rows = root.all().filter((e) => e.tag === 'tr' && e.classes().includes('bt-debug-row'));
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((r) => (r.classes().includes('bt-debug-held-short') ? 'short' : r.classes().includes('bt-debug-held') ? 'long' : '')), ['', 'long', 'long', 'short', 'short', 'long']);
  const position = rows.map((r) => r.byClass('bt-debug-position')[0].textContent);
  assert.match(position[3], /^Short, [\d.]+ shares$/);
  const legend = root.byClass('bt-debug-legend-key')[0].textContent;
  assert.ok(legend.endsWith('sell rule columns are dimmed where no long was held, and cover rule columns where no short was.'), legend);
  // Columns: buy, sell, short, cover, each one comparison.
  const cells = (r: El) => r.byClass('bt-debug-cell');
  const idle = (r: El) => cells(r).map((c) => c.classes().includes('bt-debug-idle'));
  assert.deepEqual(idle(rows[1]), [false, false, false, true]);
  assert.deepEqual(idle(rows[3]), [false, true, false, false]);
  assert.ok(cells(rows[1])[3].title.endsWith('No short was held, so the cover rule was not in play.'));
  assert.ok(cells(rows[3])[1].title.endsWith('No long was held, so the sell rule was not in play.'));
});
