// The result drawn into a stand-in for the page: the block's settings folded away, the sections as tabs, the chart's
// read-out, its spans, shading and falls, the folded line, the near-order chip and the scale of the next close.
import { El, WIDTH } from './page.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { isoDate, timeTicks } from '../src/format.ts';
import { parseSpec } from '../src/dsl.ts';
import { awayText, nextOrder, orderLine, watchText } from '../src/render-now.ts';
import { renderPriceCharts } from '../src/render-price.ts';
import { renderRegimes } from '../src/render-regimes.ts';
import { oldPrices, oldRecordWords, renderOldRecord, renderResult, type ResultView } from '../src/render.ts';
import { versusView } from '../src/render-versus.ts';
import type { AssetRef } from '../src/types.ts';
import type { RunOutput } from '../src/runner.ts';
import { condition, priceAlone, type Trigger, type TriggerReport } from '../src/trigger.ts';
import { bars, DAY } from './helpers.ts';

const START = Date.UTC(2019, 0, 1);
/** Three years of daily closes that climb, fall through March 2020 and climb again. */
const CLOSES = Array.from({ length: 1100 }, (_, i) => {
  const t = START + i * DAY;
  const covid = t >= Date.UTC(2020, 1, 19) && t <= Date.UTC(2020, 2, 23) ? (t - Date.UTC(2020, 1, 19)) / DAY : t > Date.UTC(2020, 2, 23) ? 33 : 0;
  return 100 * (1 + i * 0.0006) * (1 - covid * 0.009) + 3 * Math.sin(i / 9);
});
const TREND = 'name: Trend\nuniverse: A\ncosts: 5 bps\n\nbuy when close > sma(20)\nsell when close < sma(20)';

function run(src: string, closes = CLOSES): RunOutput {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  const data = new Map([['A', bars(closes, { start: START })]]);
  return { spec: spec!, backtest: runBacktest(spec!, data), data, warnings: [], prices: [] };
}

function draw(out: RunOutput, more: Partial<ResultView> = {}): El {
  const root = new El('div');
  renderResult(root as unknown as HTMLElement, { source: '', out, notes: [], onRefresh: () => {}, ...more });
  return root;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const texts = (els: El[]) => els.map((e) => e.textContent);

test('the block’s settings fold away behind a chip that counts them, its rules and a ticker’s own settings stay in view', () => {
  const source = 'name: Trend\nuniverse: A\ncosts: 5 bps\n\nn = 20 in 10..40\nbuy when close > sma(n)\nsell when close < sma(n)\n\nfor A:\n  stop loss: 5%';
  const root = draw(run(TREND), { source });
  const lines = root.byClass('bt-src-line');
  const folded = lines.filter((l) => l.classes().includes('bt-src-setting')).map((l) => l.textContent);
  assert.deepEqual(folded, ['name: Trend', 'universe: A', 'costs: 5 bps', '']);
  assert.ok(lines.some((l) => l.textContent === '  stop loss: 5%' && !l.classes().includes('bt-src-setting')));
  const box = root.byClass('bt-src')[0];
  const toggle = root.byClass('bt-src-toggle')[0];
  assert.equal(toggle.textContent, '3 settings');
  toggle.dispatch('click');
  assert.ok(box.classes().includes('bt-src-all'));
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  assert.equal(toggle.textContent, 'Hide the settings');
  // A setting the parser has a note about stays in view.
  const noted = draw(run(TREND), { source, notes: [{ line: 3, message: 'A note' }] });
  assert.deepEqual(noted.byClass('bt-src-line').filter((l) => l.classes().includes('bt-src-setting')).map((l) => l.textContent), ['name: Trend', 'universe: A']);
  assert.equal(noted.byClass('bt-src-toggle')[0].textContent, '2 settings');
  // A block of rules alone has nothing to fold, and a block of settings alone, such as a ranking, shows them all.
  assert.equal(draw(run(TREND), { source: 'buy when close > sma(20)' }).byClass('bt-src-toggle').length, 0);
  const settingsOnly = draw(run(TREND), { source: 'universe: A, B, C\nhold: top 1 by roc(20)\nrebalance: monthly' });
  assert.equal(settingsOnly.byClass('bt-src-toggle').length, 0);
  assert.deepEqual(settingsOnly.byClass('bt-src-setting'), []);
});

test('the sections are tabs, opened one at a time, each large one with a line of what is in it', () => {
  const root = draw(run(TREND));
  const tabs = root.byClass('bt-tab');
  assert.deepEqual(texts(tabs.map((t) => t.byClass('bt-tab-name')[0])), ['Trades', 'Years', 'Months']);
  const previews = texts(tabs.map((t) => t.byClass('bt-tab-preview')[0]));
  assert.match(previews[0], /^\d+ closed · \d+% won$/);
  assert.match(previews[1], /^better in \d of [23]$/);
  assert.match(previews[2], /^up in \d+%$/);
  const sections = root.byClass('bt-sections')[0].children.filter((c): c is El => typeof c !== 'string' && c.tag === 'details');
  tabs[1].dispatch('click');
  assert.deepEqual(sections.map((d) => d.open), [false, true, false]);
  tabs[2].dispatch('click');
  assert.deepEqual(sections.map((d) => d.open), [false, false, true]);
  assert.deepEqual(tabs.map((t) => t.attrs['aria-selected']), ['false', 'false', 'true']);
  // A second click closes it.
  tabs[2].dispatch('click');
  assert.deepEqual(sections.map((d) => d.open), [false, false, false]);
  // Opened from elsewhere, such as by the preview panel: the others close.
  sections[0].open = true;
  sections[1].open = true;
  sections[1].dispatch('toggle');
  assert.deepEqual(sections.map((d) => d.open), [false, true, false]);
  assert.deepEqual(tabs.map((t) => t.attrs['aria-selected']), ['false', 'true', 'false']);
});

test('the tab open when a slider is let go stays open on the new run', async () => {
  const src = 'name: Trend\nuniverse: A\n\nn = 20 in 10..40 step 10\nbuy when close > sma(n)\nsell when close < sma(n)';
  const first = run(src);
  const params = { rerun: (values: Record<string, number>) => Promise.resolve(run(src.replace('n = 20', `n = ${values.n}`))) };
  const root = draw(first, { source: src, params });
  const tab = (name: string) => root.byClass('bt-tab').find((b) => b.byClass('bt-tab-name')[0].textContent === name)!;
  tab('Years').dispatch('click');
  const slider = root.byClass('bt-param-slider')[0] as El & { valueAsNumber: number };
  slider.valueAsNumber = 30;
  slider.dispatch('change');
  await settle();
  assert.match(root.byClass('bt-meta')[0].textContent, /n 30/);
  const open = root.byClass('bt-sections')[0].children.filter((c): c is El => typeof c !== 'string' && c.tag === 'details' && c.open);
  assert.deepEqual(open.map((d) => d.attrs['data-bt-tab']), ['Years']);
  // The page tells a section it was opened a moment later; the tab follows.
  open[0].dispatch('toggle');
  assert.equal(tab('Years').attrs['aria-selected'], 'true');
  assert.deepEqual(root.byClass('bt-tab').filter((b) => b.attrs['aria-selected'] === 'true').length, 1);
});

test('the Years tab gives the years ahead, level and behind and draws the gap each year; Months a cell for each month', () => {
  const root = draw(run(TREND));
  const [trades, years, months] = root.byClass('bt-sections')[0].children.filter((c): c is El => typeof c !== 'string' && c.tag === 'details');
  years.dispatch('toggle');
  assert.match(years.byClass('bt-tab-lead')[0].textContent, /^In [23] full years, the strategy did better than buy and hold in \d, the same in \d and worse in \d\./);
  assert.ok(years.all().some((e) => e.tag === 'svg'));
  months.dispatch('toggle');
  // 1,100 days from the first of January 2019: January 2019 to January 2022, 37 months.
  assert.equal(months.byClass('bt-sr').length, 37);
  // A head row, then 2019 to 2022.
  assert.equal(months.all().filter((e) => e.tag === 'tr').length, 5);
  trades.dispatch('toggle');
  assert.match(trades.byClass('bt-tab-lead')[0].textContent, /^\d+ of \d+ closed trades won\./);
  assert.ok(trades.byClass('bt-payoff')[0].all().some((e) => e.attrs.class === 'bt-payoff-gain'));
});

test('the chart reads out the last bar, then the bar under the pointer, with the fall it lies in and what was held', () => {
  const out = run(TREND);
  const root = draw(out);
  const read = (cls: string) => root.byClass(cls)[0].textContent;
  const t = out.backtest.run.t;
  assert.equal(read('bt-read-date'), `${new Date(t.at(-1)!).toISOString().slice(0, 10)} · last bar`);
  const chart = root.byClass('bt-chart')[0];
  // The Covid crash is shaded and named.
  const labels = chart.all().filter((e) => e.attrs.class === 'bt-axis bt-fall-label').map((e) => e.textContent);
  assert.ok(labels.includes('Covid crash'), labels.join(', '));
  assert.ok(chart.all().filter((e) => e.attrs.class === 'bt-fall-band').length >= 1);
  const hit = chart.all().find((e) => e.tag === 'rect' && e.attrs.fill === 'transparent')!;
  const at = (time: number) => Number(hit.attrs.x) + ((time - t[0]) / (t.at(-1)! - t[0])) * Number(hit.attrs.width);
  hit.dispatch('pointermove', { clientX: at(Date.UTC(2020, 2, 1)) });
  assert.equal(read('bt-read-date'), '2020-03-01');
  assert.equal(read('bt-read-fall'), 'Covid crash');
  assert.match(read('bt-read-state'), /^(100% invested|In cash)$/);
  hit.dispatch('pointermove', { clientX: at(Date.UTC(2019, 6, 1)) });
  assert.equal(root.byClass('bt-read-fall')[0].hidden, true);
  hit.dispatch('pointerleave');
  assert.match(read('bt-read-date'), / · last bar$/);
  // Which line is ahead is shaded, and the line under the chart says what the shading is.
  assert.ok(chart.all().some((e) => e.attrs.class === 'bt-ahead' || e.attrs.class === 'bt-behind'));
  assert.equal(root.byClass('bt-chart-note')[0].textContent, 'Shading: the gap between the two lines, and the large market drawdowns');
});

/** A key pressed on `el`; says whether the chart took it, which stops it there. */
function press(el: El, key: string, shiftKey = false): boolean {
  let took = false;
  el.dispatch('keydown', { key, shiftKey, preventDefault() {}, stopPropagation: () => (took = true) });
  return took;
}

test('the chart reads with the arrow keys while it has the focus, and Escape gives the read-out back to the last bar', () => {
  const out = run(TREND);
  const root = draw(out);
  const read = (cls: string) => root.byClass(cls)[0].textContent;
  const iso = (time: number) => new Date(time).toISOString().slice(0, 10);
  const t = out.backtest.run.t;
  const chart = root.byClass('bt-chart')[0];
  assert.equal(chart.tabIndex, 0);
  assert.equal(chart.attrs['aria-label'], 'Chart of the value. Use the arrow keys to read the values.');
  assert.equal(root.byClass('bt-read')[0].attrs['aria-live'], 'polite');
  const cross = () => chart.all().find((e) => e.attrs.class === 'bt-cross')!;
  assert.ok(press(chart, 'ArrowLeft'));
  assert.equal(read('bt-read-date'), iso(t.at(-1)!));
  assert.equal(cross().attrs.visibility, 'visible');
  assert.ok(press(chart, 'ArrowLeft'));
  assert.equal(read('bt-read-date'), iso(t.at(-2)!));
  // Shift goes back a month by date, on a run of three years.
  assert.ok(press(chart, 'ArrowLeft', true));
  assert.equal(read('bt-read-date'), iso(t.at(-2)! - 31 * DAY));
  assert.ok(press(chart, 'Home'));
  assert.equal(read('bt-read-date'), iso(t[0]));
  // The pointer and the keys move one read-out: the keys go on from the bar the pointer read.
  const hit = chart.all().find((e) => e.tag === 'rect' && e.attrs.fill === 'transparent')!;
  hit.dispatch('pointermove', { clientX: Number(hit.attrs.x) + ((Date.UTC(2020, 2, 1) - t[0]) / (t.at(-1)! - t[0])) * Number(hit.attrs.width) });
  assert.equal(read('bt-read-date'), '2020-03-01');
  assert.ok(press(chart, 'ArrowRight'));
  assert.equal(read('bt-read-date'), '2020-03-02');
  assert.equal(read('bt-read-fall'), 'Covid crash');
  assert.ok(press(chart, 'Escape'));
  assert.equal(read('bt-read-date'), `${iso(t.at(-1)!)} · last bar`);
  assert.equal(cross().attrs.visibility, 'hidden');
  // Keys it does not use, and Escape with nothing to give back, go on to Obsidian.
  assert.ok(!press(chart, 'Escape'));
  assert.ok(!press(chart, 'Enter'));
  assert.ok(!press(chart, 'ArrowUp'));
});

test('the Years chart and the price chart read with the arrow keys too', () => {
  const out = run(TREND);
  const root = draw(out);
  const years = root.byClass('bt-sections')[0].children.filter((c): c is El => typeof c !== 'string' && c.tag === 'details')[1];
  years.dispatch('toggle');
  const chart = years.byClass('bt-chart')[0];
  const read = years.byClass('bt-tab-read')[0];
  assert.equal(chart.attrs['aria-label'], 'Chart of the years. Use the arrow keys to read each year.');
  assert.equal(read.attrs['aria-live'], 'polite');
  assert.ok(press(chart, 'ArrowRight'));
  assert.match(read.textContent, /^2019 · strategy /);
  assert.ok(press(chart, 'ArrowRight', true));
  assert.match(read.textContent, /^2020 · strategy /);
  assert.ok(press(chart, 'End'));
  assert.match(read.textContent, /^2022, part of the year · /);
  assert.ok(press(chart, 'Escape'));
  assert.match(read.textContent, /^Each bar shows the strategy return/);

  const box = new El('div');
  const bt = out.backtest;
  renderPriceCharts(box as unknown as HTMLElement, { data: out.data, tickers: ['A'], trades: bt.run.trades, from: bt.run.t[0], to: bt.run.t.at(-1)!, intraday: false });
  box.byClass('bt-details')[0].dispatch('toggle');
  const prices = box.byClass('bt-price-chart')[0];
  const tip = box.byClass('bt-price-tip')[0];
  assert.equal(prices.attrs['aria-label'], 'Chart of the price. Use the arrow keys to read the closes.');
  assert.equal(tip.attrs['aria-live'], 'polite');
  assert.ok(press(prices, 'ArrowLeft'));
  assert.equal(tip.hidden, false);
  assert.equal(tip.byClass('bt-tip-date')[0].textContent, new Date(bt.run.t.at(-1)!).toISOString().slice(0, 10));
  assert.ok(press(prices, 'Home'));
  assert.equal(tip.byClass('bt-tip-date')[0].textContent, new Date(out.data.get('A')!.t[0]).toISOString().slice(0, 10));
  assert.ok(press(prices, 'Escape'));
  assert.equal(tip.hidden, true);
});

test('a run of three years can show its last year alone; the span stays when another run is drawn', () => {
  const root = draw(run(TREND));
  const buttons = () => root.byClass('bt-range-button');
  assert.deepEqual(texts(buttons()), ['All', '1Y']);
  assert.equal(buttons()[0].attrs['aria-pressed'], 'true');
  buttons()[1].dispatch('click');
  assert.deepEqual(buttons().map((b) => b.attrs['aria-pressed']), ['false', 'true']);
  // The axis now starts a year before the last bar.
  const years = root.byClass('bt-chart')[0].all().filter((e) => e.attrs['text-anchor'] === 'middle').map((e) => e.textContent);
  assert.ok(years.every((y) => !y.startsWith('2019')), years.join(' '));
  // A run under a year and a half offers no shorter span.
  assert.equal(draw(run(TREND, CLOSES.slice(0, 400))).byClass('bt-range')[0].hidden, true);
});

test('the strip of time held is hatched where the run was short, and the key says so', () => {
  const root = draw(run('universe: A\ncapital: 10000\nborrow fee: 0%\nshort when true'));
  const chart = root.byClass('bt-chart')[0];
  const short = chart.all().find((e) => e.attrs.class === 'bt-strip-short')!;
  assert.match(short.attrs.fill, /^url\(#bt-hatch-\d+\)$/);
  assert.ok(texts(root.byClass('bt-chart-key')).includes('Held short'));
});

test('folded, the line has the growth, the figures and what is held; the chip says how near the next order is', async () => {
  const out = run(TREND);
  const near: Trigger = { ticker: 'A', side: 'sell', driver: 'A', last: 100, range: { lo: 95, hi: 105 }, fires: [{ lo: null, hi: 99.7 }], ownLast: 100, exact: true, assumptions: [] };
  const report: TriggerReport = { next: 0, intraday: false, closeFill: false, decision: null, triggers: [near] };
  const root = draw(out, { compact: true, triggers: () => Promise.resolve(report) });
  assert.ok(root.children[0] instanceof El && (root.children[0] as El).classes().includes('bt-folded'));
  const facts = root.byClass('bt-fold-facts')[0];
  assert.equal(facts.byClass('bt-spark').length, 1);
  assert.equal(facts.byClass('bt-fold-tickers')[0].textContent, 'A');
  // Each figure is a number over its unit, in a column of its own.
  assert.deepEqual(facts.byClass('bt-fold-fig').map((f) => [f.byClass('bt-fold-fig-value')[0].textContent.replace(/^[−+]?[\d.]+%$/, 'X'), f.byClass('bt-fold-fig-unit')[0].textContent]), [['X', 'a year'], ['X', 'worst']]);
  assert.match(root.byClass('bt-fold-held')[0].textContent, /^(Long A|In cash)$/);
  const chip = root.byClass('bt-chip-watch')[0];
  assert.equal(chip.hidden, true);
  await settle();
  assert.equal(chip.hidden, false);
  assert.equal(chip.textContent, '0.30% from a sell');
  // Opened, the status line says the position, the order and how far the close is from it, in amber as it is near.
  root.byClass('bt-fold')[0].dispatch('click');
  await settle();
  const status = root.byClass('bt-status')[0];
  assert.match(root.byClass('bt-status-held')[0].textContent, /^(Long A|In cash)$/);
  assert.equal(root.byClass('bt-status-order')[0].textContent, `Sells ${condition(near, 'it', priceAlone)}`);
  assert.equal(root.byClass('bt-status-away')[0].textContent, '0.30% away');
  assert.ok(status.classes().includes('bt-near'));
  // The ring breathes only within 0.5%.
  assert.ok(root.byClass('bt-status-dot')[0].classes().includes('bt-breathe'));
  // It opens on the last closes against the price, and the rule in words.
  status.dispatch('click');
  assert.equal(status.attrs['aria-expanded'], 'true');
  assert.equal(root.byClass('bt-next-chart').length, 1);
  assert.match(root.byClass('bt-status-say')[0].textContent, /^The last close was 100\.00\. The value of sma\(20\) is now [\d.]+\. Sells if it closes below 99\.\d\d, at the open after that close\.$/);
});

const SPY: Trigger = { ticker: 'SPY', side: 'sell', driver: 'SPY', last: 732.44, range: { lo: 700, hi: 765 }, fires: [{ lo: null, hi: 730.0221579985773 }], ownLast: 732.44, exact: true, assumptions: [] };
const report = (...triggers: Trigger[]): TriggerReport => ({ next: 0, intraday: false, closeFill: false, decision: null, triggers });

test('the chip names the nearest order within 2% of the last close, or one given at an unchanged close', () => {
  assert.equal(watchText(report(SPY), 1), '0.33% from a sell');
  assert.equal(watchText(report(SPY), 3), 'SPY 0.33% from a sell');
  assert.equal(watchText(report({ ...SPY, side: 'buy', fires: [{ lo: 740, hi: null }] }), 1), '1.0% from a buy');
  assert.equal(watchText(report({ ...SPY, side: 'buy', fires: [{ lo: 760, hi: null }] }), 1), null);
  assert.equal(watchText(report({ ...SPY, fires: [{ lo: null, hi: 740 }] }), 1), 'Sells if the close does not change');
  assert.equal(watchText(report({ ...SPY, fires: [{ lo: null, hi: 650 }] }), 1), null);
});

test('the status line names the nearest order with its price alone, and how far the close is from it', () => {
  const one = run(TREND);
  const several = { ...one, backtest: { ...one.backtest, run: { ...one.backtest.run, states: [one.backtest.run.states[0], { ...one.backtest.run.states[0], name: 'B' }] } } };
  const order = nextOrder(report(SPY), one, null);
  assert.equal(order.text, 'Sells if it closes below 730.03');
  assert.equal(order.away, '0.33% away');
  assert.ok(order.near && order.close && !order.due);
  // Far away, it still says the order, in a calm colour.
  const far = nextOrder(report({ ...SPY, fires: [{ lo: null, hi: 650 }] }), one, null);
  assert.equal(far.away, '11% away');
  assert.ok(!far.near && !far.close);
  // With several tickers it names the ticker; another ticker's close names that ticker.
  assert.equal(nextOrder(report(SPY), several, null).text, 'SPY: sells if it closes below 730.03');
  assert.equal(nextOrder(report({ ...SPY, ticker: 'QQQ' }), one, null).text, 'Sells if SPY closes below 730.03');
  // An order already waiting comes first; a ranking and a rule still warming up say why there is nothing to watch.
  assert.deepEqual([nextOrder(report(SPY), one, 'sells A at the next open').text, nextOrder(report(SPY), one, 'sells A at the next open').due], ['Sells A at the next open', true]);
  assert.equal(nextOrder({ ...report({ ...SPY, blocked: 'ranking' }), decision: 0 }, one, null).text, 'The ranking selects again at the next close');
  assert.equal(nextOrder(report({ ...SPY, blocked: 'warmup', warmup: null }), one, null).text, 'No order is possible at the next close');
  assert.equal(nextOrder(report({ ...SPY, fires: [] }), one, null).text, 'No order is near the last close');
});

test('the order line to copy names the ticker, how far the close is and the date of the prices', () => {
  const one = run(TREND);
  const several = { ...one, backtest: { ...one.backtest, run: { ...one.backtest.run, states: [one.backtest.run.states[0], { ...one.backtest.run.states[0], name: 'B' }] } } };
  assert.equal(orderLine(nextOrder(report(SPY), one, null), false, '2026-11-18'), 'SPY: sells if it closes below 730.03 (0.33% away). Prices to 2026-11-18.');
  assert.equal(orderLine(nextOrder(report(SPY), several, null), true, '2026-11-18'), 'SPY: sells if it closes below 730.03 (0.33% away). Prices to 2026-11-18.');
  assert.equal(orderLine(nextOrder(report({ ...SPY, ticker: 'QQQ' }), one, null), false, '2026-11-18'), 'QQQ: sells if SPY closes below 730.03 (0.33% away). Prices to 2026-11-18.');
  assert.equal(orderLine(nextOrder(report(SPY), one, 'sells A at the next open'), false, '2026-11-18'), 'Sells A at the next open. Prices to 2026-11-18.');
});

test('the panel of the status line copies the order line; with nothing to watch it has no Copy button', async () => {
  const out = run(TREND);
  const near: Trigger = { ticker: 'A', side: 'sell', driver: 'A', last: 100, range: { lo: 95, hi: 105 }, fires: [{ lo: null, hi: 99.7 }], ownLast: 100, exact: true, assumptions: [] };
  const copied: [string, string][] = [];
  const copy = (text: string, what: string) => void copied.push([text, what]);
  const root = draw(out, { copy, triggers: () => Promise.resolve(report(near)) });
  await settle();
  root.byClass('bt-status')[0].dispatch('click');
  const button = root.byClass('bt-status-copy')[0].children[0] as El;
  assert.equal(button.textContent, 'Copy');
  button.dispatch('click');
  const last = new Date(out.backtest.run.t.at(-1)!).toISOString().slice(0, 10);
  assert.deepEqual(copied, [[`A: sells if it closes below ${condition(near, 'it', priceAlone)!.replace(/^if it closes below /, '')} (0.30% away). Prices to ${last}.`, 'the order']]);
  const quiet = draw(out, { copy, triggers: () => Promise.resolve(report({ ...near, fires: [] })) });
  await settle();
  quiet.byClass('bt-status')[0].dispatch('click');
  assert.equal(quiet.byClass('bt-status-say')[0].textContent, 'No order is near the last close.');
  assert.equal(quiet.byClass('bt-status-copy').length, 0);
});

test('a distance has two decimals below 1%, so a near order never reads as 0.0%', () => {
  assert.equal(awayText(0.0000958), '0.01% away');
  assert.equal(awayText(-0.0033), '0.33% away');
  assert.equal(awayText(0.012), '1.2% away');
  assert.equal(awayText(0.14), '14% away');
  assert.equal(awayText(0.04, true), '0.04 away');
  assert.equal(awayText(NaN), null);
});

test('a run of 200,000 bars folds to its line, and its 50,000 trades draw on the Trades tab', () => {
  const n = 200_000;
  // A random walk, so trading every turn neither compounds to infinity nor to nothing.
  let seed = 7;
  const step = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 0.004;
  let price = 100;
  const closes = Array.from({ length: n }, () => (price *= 1 + step()));
  const src = 'name: Busy\nuniverse: A\n\nbuy when close > close[1]\nsell when close < close[1]';
  const { spec } = parseSpec(src);
  const data = new Map([['A', bars(closes, { start: START, step: DAY / 24 })]]);
  const out: RunOutput = { spec: spec!, backtest: runBacktest(spec!, data), data, warnings: [], prices: [] };
  assert.ok(out.backtest.run.trades.length > 40_000, `${out.backtest.run.trades.length} trades`);
  const root = draw(out, { compact: true });
  assert.equal(root.byClass('bt-spark').length, 1);
  root.byClass('bt-fold')[0].dispatch('click');
  const trades = root.byClass('bt-sections')[0].children.find((c): c is El => typeof c !== 'string' && c.attrs['data-bt-tab'] === 'Trades')!;
  trades.dispatch('toggle');
  assert.ok(trades.byClass('bt-payoff')[0].all().some((e) => e.attrs.class === 'bt-payoff-gain'));
});

test('a trade clicked in the payoff chart that the list leaves out says so', () => {
  let seed = 11;
  let price = 100;
  const closes = Array.from({ length: 4000 }, () => (price *= 1 + ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 0.02));
  const out = run('name: Busy\nuniverse: A\n\nbuy when close > close[1]\nsell when close < close[1]', closes);
  const all = out.backtest.run.trades;
  assert.ok(all.length > 500, `${all.length} trades`);
  const root = draw(out);
  const trades = root.byClass('bt-sections')[0].children.find((c): c is El => typeof c !== 'string' && c.attrs['data-bt-tab'] === 'Trades')!;
  trades.dispatch('toggle');
  const sorted = all.filter((t) => t.reason !== 'open').sort((a, b) => a.ret - b.ret);
  const listed = new Set(all.slice(-500));
  const i = sorted.findIndex((t) => !listed.has(t));
  const hit = trades.byClass('bt-payoff')[0].all().find((e) => e.tag === 'rect' && e.attrs.fill === 'transparent')!;
  const step = (WIDTH - 8) / sorted.length;
  hit.dispatch('click', { clientX: 4 + (i + 0.5) * step });
  assert.match(trades.byClass('bt-tab-read')[0].textContent, /not in the list\. The list shows only the last 500 trades\.$/);
  // A trade of one bar says so in the singular.
  const one = sorted.findIndex((t) => t.bars === 1);
  hit.dispatch('pointermove', { clientX: 4 + (one + 0.5) * step });
  assert.match(trades.byClass('bt-tab-read')[0].textContent, / · 1 bar · /);
  assert.equal(trades.all().filter((e) => e.classes().includes('bt-row-flash')).length, 0);
});

test('a fall the strategy beat by less than the Years tab calls level is not counted as beaten', () => {
  const t = Array.from({ length: 1100 }, (_, i) => START + i * DAY);
  const bench = CLOSES.map((c) => c * 100);
  // Ahead by 0.03 points over each fall: interest on a sliver of cash, say.
  const equity = bench.map((v, i) => v * (1 + 0.0003 * (i / 1100)));
  const regimes = (strategy: number[]) => {
    const box = new El('div');
    renderRegimes(box as unknown as HTMLElement, {
      run: { t, equity: strategy, exposure: t.map(() => 1), benchmark: bench },
      benchmarkLabel: 'Buy & hold',
      intraday: false,
      universe: [{ name: 'SPY', source: 'yahoo' }] as AssetRef[],
      saved: () => Promise.resolve(null),
      load: () => new Promise(() => {}),
    });
    const d = box.children[0] as El;
    d.dispatch('toggle');
    return { preview: d.attrs['data-bt-preview'], lead: d.byClass('bt-tab-lead')[0]?.textContent };
  };
  assert.deepEqual(regimes(equity), { preview: 'better in 0 of 1 drawdown', lead: 'The strategy did better than buy and hold in 0 of the 1 market drawdown in the run.' });
  // Ahead by half a point, it is.
  const ahead = regimes(bench.map((v, i) => v * (1 + 0.005 * Math.min(1, Math.max(0, (t[i] - Date.UTC(2020, 1, 19)) / (Date.UTC(2020, 2, 23) - Date.UTC(2020, 1, 19)))))));
  assert.equal(ahead.preview, 'better in 1 of 1 drawdown');
});

test('“All figures” keeps the keyboard on it when it opens and closes the rest', () => {
  const root = draw(run(TREND));
  const button = () => root.byClass('bt-vs-toggle')[0];
  assert.equal(button().textContent, 'All figures · 8 more');
  const page = globalThis.document as unknown as { activeElement: unknown };
  button().focus();
  button().dispatch('click');
  assert.equal(button().textContent, 'Fewer figures');
  assert.equal(page.activeElement, button());
  button().dispatch('click');
  assert.equal(page.activeElement, button());
});

test('a figure’s name opens what it means under its row, and a second press closes it; the row still lights the chart', () => {
  const lit: (string | null)[] = [];
  const root = draw(run(TREND));
  const name = () => root.byClass('bt-vs-label').find((e) => e.textContent === 'Sharpe ratio')!;
  const help = () => root.all().find((e) => e.id === name().attrs['aria-controls'])!;
  assert.equal(name().tag, 'button');
  assert.equal(name().attrs['aria-expanded'], 'false');
  assert.equal(help().hidden, true);
  name().dispatch('click');
  assert.equal(name().attrs['aria-expanded'], 'true');
  assert.equal(help().hidden, false);
  assert.match(help().textContent, /^For each bar, the plugin subtracts the interest that cash earned at the cash rate from the return\./);
  // It sits right under its row.
  const row = name().parent!;
  assert.equal(row.parent!.children[row.parent!.children.indexOf(row) + 1], help());
  // The rows are drawn again when "All figures" opens; the meaning stays open, and the new rows have theirs.
  root.byClass('bt-vs-toggle')[0].dispatch('click');
  assert.equal(name().attrs['aria-expanded'], 'true');
  assert.equal(help().hidden, false);
  assert.ok(root.byClass('bt-vs-label').some((e) => e.textContent === 'Longest time below a previous high' && e.tag === 'button'));
  name().dispatch('click');
  assert.equal(name().attrs['aria-expanded'], 'false');
  assert.equal(help().hidden, true);
  // The row of the worst drawdown still lights its part of the chart.
  const figs = new El('div');
  const view = versusView(figs as unknown as HTMLElement, { link: (part) => lit.push(part) });
  view.show(run(TREND).backtest);
  const dd = figs.byClass('bt-vs-label').find((e) => e.textContent === 'Worst drawdown')!.parent!;
  dd.dispatch('pointerenter');
  dd.dispatch('pointerleave');
  assert.deepEqual(lit, ['dd', null]);
});

test('a run with a `to` date says what it held at its end, not what the next close would do', async () => {
  const root = draw(run(TREND.replace('costs: 5 bps', 'costs: 5 bps\nto: 2021-06-30')));
  await settle();
  assert.equal(root.byClass('bt-status-order')[0].textContent, 'The run ends on 2021-06-30');
  // Its prices end where the run does on purpose, so they are not called old.
  assert.equal(root.byClass('bt-status-old')[0].hidden, true);
  assert.equal(root.byClass('bt-chip-old')[0].hidden, true);
});

test('with old prices the status line says in amber where they end, its order quieter, and a click there loads new ones', async () => {
  let refreshed = 0;
  const near: Trigger = { ticker: 'A', side: 'sell', driver: 'A', last: 100, range: { lo: 95, hi: 105 }, fires: [{ lo: null, hi: 99.7 }], ownLast: 100, exact: true, assumptions: [] };
  const out = run(TREND);
  const root = draw(out, { onRefresh: () => refreshed++, triggers: () => Promise.resolve({ next: 0, intraday: false, closeFill: false, decision: null, triggers: [near] }) });
  await settle();
  const end = isoDate(out.backtest.run.t[out.backtest.run.t.length - 1]);
  const old = root.byClass('bt-status-old')[0];
  assert.equal(old.hidden, false);
  assert.equal(old.tag, 'button');
  assert.equal(old.textContent, `Prices end on ${end}. They can be old.Click to load new prices.`);
  // The order words stay, in a quieter style than an order that is near.
  const line = root.byClass('bt-status')[0];
  assert.equal(root.byClass('bt-status-order')[0].textContent, `Sells ${condition(near, 'it', priceAlone)}`);
  assert.ok(line.classes().includes('bt-old') && line.classes().includes('bt-near'));
  // A click on the amber part is the refresh of the card, and does not open the panel of the line.
  old.dispatch('click');
  assert.equal(refreshed, 1);
  assert.equal(line.attrs['aria-expanded'], 'false');
  // Folded, the line has a short marker that says the same.
  const mark = root.byClass('bt-chip-old')[0];
  assert.equal(mark.hidden, false);
  assert.equal(mark.textContent, 'Old prices');
  assert.equal(mark.title, `Prices end on ${end}. They can be old.`);
});

test('old prices of bars shorter than a day say the time they end, also from a file of minute bars with no interval line', () => {
  const start = Date.UTC(2026, 10, 13, 10, 0);
  const { spec } = parseSpec('universe: csv:Data/a.csv\nbuy when close > 11');
  assert.equal(spec!.interval, '1d');
  const data = new Map([['a', bars([10, 10, 12], { start, step: 60_000 })]]);
  const out: RunOutput = { spec: spec!, backtest: runBacktest(spec!, data), data, warnings: [], prices: [] };
  assert.equal(oldPrices(out, start + 30 * DAY), 'Prices end at 2026-11-13 10:02 UTC');
});

test('a result left open reads the age of its prices again when asked, and changes only that part', async () => {
  // Daily bars that end yesterday are not old today, whatever the time zone.
  const now = new Date();
  const closes = CLOSES.slice(0, 400);
  const start = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - closes.length * DAY;
  const { spec } = parseSpec(TREND);
  const data = new Map([['A', bars(closes, { start })]]);
  const out: RunOutput = { spec: spec!, backtest: runBacktest(spec!, data), data, warnings: [], prices: [] };
  const root = new El('div');
  const drawn = renderResult(root as unknown as HTMLElement, { source: '', out, notes: [], onRefresh: () => {} });
  await settle();
  const old = root.byClass('bt-status-old')[0];
  const mark = root.byClass('bt-chip-old')[0];
  const order = root.byClass('bt-status-order')[0];
  assert.deepEqual([old.hidden, mark.hidden], [true, true]);
  assert.ok(!root.byClass('bt-status')[0].classes().includes('bt-old'));
  // Ten days later the same drawing says they are old; nothing else is drawn again.
  drawn.checkAge(Date.now() + 10 * DAY);
  assert.deepEqual([old.hidden, mark.hidden], [false, false]);
  assert.match(old.textContent, /^Prices end on \d{4}-\d\d-\d\d\. They can be old\./);
  assert.ok(root.byClass('bt-status')[0].classes().includes('bt-old'));
  assert.equal(root.byClass('bt-status-order')[0], order);
  drawn.checkAge(Date.now());
  assert.deepEqual([old.hidden, mark.hidden], [true, true]);
  // Folded and never opened, only the marker is there to change.
  const folded = new El('div');
  const card = renderResult(folded as unknown as HTMLElement, { source: '', out, notes: [], onRefresh: () => {}, compact: true });
  card.checkAge(Date.now() + 10 * DAY);
  assert.equal(folded.byClass('bt-chip-old')[0].hidden, false);
  assert.equal(folded.byClass('bt-status-old').length, 0);
});

test('five years in a narrow chart still name more than one year, and a wide chart is as before', () => {
  const [a, b] = [Date.UTC(2021, 10, 17), Date.UTC(2026, 10, 17)];
  assert.deepEqual(timeTicks(a, b, 230).map((x) => x.label), ['2022', '2024', '2026']);
  assert.deepEqual(timeTicks(Date.UTC(2005, 0, 3), b, 600).map((x) => x.label), ['2010', '2015', '2020', '2025']);
});

test('each tab names the section it opens, and the arrow keys move along a row of tabs', () => {
  const root = draw(run(TREND));
  const tabs = root.byClass('bt-tab');
  const sections = root.byClass('bt-sections')[0].children.filter((c): c is El => typeof c !== 'string' && c.tag === 'details');
  sections.forEach((d, i) => {
    assert.equal(d.attrs.role, 'tabpanel');
    assert.equal(d.attrs['aria-labelledby'], tabs[i].id);
    assert.equal(tabs[i].attrs['aria-controls'], d.id);
  });
  const page = globalThis.document as unknown as { activeElement: unknown };
  const main = tabs.filter((t) => !t.classes().includes('bt-tab-small'));
  main[0].focus();
  main[0].dispatch('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.equal(page.activeElement, main[1]);
  main[1].dispatch('keydown', { key: 'ArrowLeft', preventDefault() {} });
  assert.equal(page.activeElement, main[0]);
  main[0].dispatch('keydown', { key: 'ArrowLeft', preventDefault() {} });
  assert.equal(page.activeElement, main.at(-1));
  main.at(-1)!.dispatch('keydown', { key: 'Home', preventDefault() {} });
  assert.equal(page.activeElement, main[0]);
});

test('a number in the rules is a control: the arrow keys step it on the slider’s grid, and the slot under the bar says what differs', async () => {
  const src = 'name: Trend\nuniverse: A\n\nn = 20 in 10..40 step 10\nbuy when close > sma(n)\nsell when close < sma(n)';
  const asked: number[] = [];
  const params = {
    rerun: (values: Record<string, number>) => {
      asked.push(values.n);
      return Promise.resolve(run(src.replace('n = 20', `n = ${values.n}`)));
    },
  };
  const root = draw(run(src), { source: src, params });
  const scrub = root.byClass('bt-scrub')[0];
  assert.equal(scrub.textContent, '20');
  assert.equal(scrub.attrs.role, 'spinbutton');
  // The slot shows one thing at a time, and the hint while nothing differs.
  const on = () => root.byClass('bt-param-slot')[0].children.filter((c): c is El => typeof c !== 'string' && c.classes().includes('bt-slot-on'));
  assert.deepEqual(on().map((e) => e.classes()[0]), ['bt-param-hint']);
  scrub.dispatch('keydown', { key: 'ArrowRight', preventDefault: () => {} });
  await settle();
  assert.deepEqual(asked, [30]);
  assert.equal(scrub.textContent, '30');
  assert.ok(scrub.classes().includes('bt-scrub-changed'));
  assert.equal((root.byClass('bt-param-slider')[0] as El & { value: string }).value, '30');
  assert.deepEqual(on().map((e) => e.classes()[0]), ['bt-param-diff']);
  assert.equal(root.byClass('bt-param-diff-text')[0].textContent, 'The result shows n 30. The values in the block are n 20.');
  // The figures say how far each moved from the block as written.
  assert.match(root.byClass('bt-vs-moved')[0].textContent, /^(as written|[+−][\d.]+ pts from the block)$/);
  // The top of the grid is the end: a step past it asks for nothing.
  scrub.dispatch('keydown', { key: 'ArrowUp', preventDefault: () => {} });
  scrub.dispatch('keydown', { key: 'ArrowUp', preventDefault: () => {} });
  await settle();
  assert.deepEqual(asked, [30, 40]);
});

test('the tools sit under the tabs as "Test the idea", tests first, each with an icon, and open in the same place', () => {
  const tool = (name: string) => (root: HTMLElement) => {
    const d = document.createElement('details');
    root.append(d);
    const summary = document.createElement('summary');
    summary.textContent = name;
    d.append(summary);
  };
  const root = draw(run(TREND), { sections: () => [tool('Versions'), tool('Prices and trades'), tool('Was it luck?')] });
  const host = root.byClass('bt-sections')[0];
  const more = root.byClass('bt-tabs-more')[0];
  assert.equal(host.children.at(-1), more);
  assert.equal(more.attrs['aria-label'], 'Test the idea');
  const tools = root.byClass('bt-tool');
  assert.deepEqual(texts(tools), ['Was it luck?', 'Prices and trades', 'Versions']);
  assert.ok(tools.every((t) => t.children.some((c) => typeof c !== 'string' && c.tag === 'svg')));
  // A tool and a tab share the place: opening one closes the other.
  const trades = root.byClass('bt-tab')[0];
  trades.dispatch('click');
  tools[0].dispatch('click');
  assert.equal(trades.attrs['aria-selected'], 'false');
  assert.equal(tools[0].attrs['aria-selected'], 'true');
});

test('a command opens or folds a result on screen as a click on its title does, and the block remembers it', () => {
  const told: boolean[] = [];
  let open: boolean | undefined;
  const root = new El('div');
  const drawn = renderResult(root as unknown as HTMLElement, {
    source: TREND,
    out: run(TREND),
    notes: [],
    onRefresh: () => {},
    compact: true,
    remember: { get: () => open, set: (now) => void told.push((open = now)) },
  });
  const card = root.byClass('bt-result')[0];
  const fold = root.byClass('bt-fold')[0];
  assert.ok(card.classes().includes('bt-folded'));
  drawn.setOpen(true);
  assert.ok(!card.classes().includes('bt-folded'));
  assert.equal(fold.attrs['aria-expanded'], 'true');
  assert.equal(root.byClass('bt-body')[0].hidden, false);
  // Already open: nothing changes, and nothing more is remembered.
  drawn.setOpen(true);
  drawn.setOpen(false);
  assert.ok(card.classes().includes('bt-folded'));
  assert.equal(fold.attrs['aria-expanded'], 'false');
  drawn.setOpen(false);
  assert.deepEqual(told, [true, false]);
  // The title still opens it after a command folded it.
  fold.dispatch('click');
  assert.deepEqual(told, [true, false, true]);
  assert.ok(!card.classes().includes('bt-folded'));
});

test('a result renamed by hand says which name its record still uses, and its button moves them', async () => {
  const root = draw(run(TREND));
  let moves = 0;
  let fail = true;
  const move = async () => {
    moves++;
    if (fail) throw new Error('The disk is full.');
  };
  renderOldRecord(root as unknown as HTMLElement, { kind: 'renamed', name: 'Trend', take: move });
  renderOldRecord(root as unknown as HTMLElement, { kind: 'renamed', name: 'Trend', take: move });
  assert.equal(root.byClass('bt-renamed').length, 1, 'one line, however often it is asked for');
  const line = root.byClass('bt-renamed')[0];
  assert.equal(root.byClass('bt-result')[0].children[0], line);
  assert.equal(line.byClass('bt-defaults-changed-text')[0].textContent, 'This block has a new name. Its record of tries and its links still use the old name "Trend".');
  const button = line.byClass('bt-button')[0];
  assert.equal(button.textContent, 'Move them to the new name');
  button.dispatch('click');
  assert.equal(button.disabled, true);
  await settle();
  // A move that failed gives the button back.
  assert.equal(button.disabled, false);
  assert.equal(root.byClass('bt-renamed').length, 1);
  fail = false;
  button.dispatch('click');
  await settle();
  assert.equal(moves, 2);
  assert.equal(root.byClass('bt-renamed').length, 0);
});

test('a result moved or copied from another note says where its record is, and a later line takes the place of an earlier one', () => {
  const take = async () => {};
  assert.deepEqual(oldRecordWords({ kind: 'moved', note: 'Ideas/Scratch.md', take }), {
    text: 'This block was in Ideas/Scratch.md before. Its record of tries still belongs to that note.',
    button: 'Move the record to this note',
  });
  assert.deepEqual(oldRecordWords({ kind: 'copied', note: 'Scratch.md', name: 'Trend', tries: 120, take }), {
    text: 'This block has the same text as "Trend" in Scratch.md. The count of this block does not include 120 tries of that block.',
    button: 'Add them to the count',
  });
  assert.deepEqual(oldRecordWords({ kind: 'copied', note: 'Scratch.md', name: 'Trend', tries: 1, take }), {
    text: 'This block has the same text as "Trend" in Scratch.md. The count of this block does not include 1 try of that block.',
    button: 'Add it to the count',
  });
  const root = draw(run(TREND));
  renderOldRecord(root as unknown as HTMLElement, { kind: 'renamed', name: 'Trend', take });
  renderOldRecord(root as unknown as HTMLElement, { kind: 'moved', note: 'Scratch.md', take });
  assert.equal(root.byClass('bt-renamed').length, 1);
  assert.equal(root.byClass('bt-renamed')[0].byClass('bt-button')[0].textContent, 'Move the record to this note');
});
