// The shared pieces of the redesign: short problem messages with a suggestion and a fix to apply, and the downsampled
// series a sparkline draws.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { applyFix, fixWord, shortMessage, suggestion } from '../src/fixes.ts';
import { sparkSeries } from '../src/render-chart.ts';
import { bars } from './helpers.ts';

test('an unknown name is cut to the sentence that names it, the list kept apart', () => {
  const { errors } = parseSpec('universe: SPY\nbuy when close > sam(200)');
  const { head, rest } = shortMessage(errors[0].message);
  assert.equal(head, 'Unknown name "sam".');
  assert.match(rest, /^Series: open, high, low, close/);
  assert.equal(`${head} ${rest}`, errors[0].message);
  assert.deepEqual(shortMessage(`Line 2: ${errors[0].message}`).head, 'Line 2: Unknown name "sam".');
  assert.deepEqual(shortMessage('Unknown setting "fro".'), { head: 'Unknown setting "fro".', rest: '' });
});

test('a suggestion names the word and what a function does, and its fix makes the block run', () => {
  const lines = ['universe: SPY', 'buy when close > smaa(200)', 'sell when close < sma(200)'];
  const d = parseSpec(lines.join('\n')).errors[0];
  const found = suggestion(lines, d);
  assert.ok(found);
  assert.equal(found.fix.label, 'Change to sma');
  assert.equal(fixWord(found.fix), 'sma');
  assert.equal(found.text, 'Did you mean sma, the simple average of the last n closes?');
  const fixed = applyFix(lines, found.fix);
  assert.equal(fixed[1], 'buy when close > sma(200)');
  assert.deepEqual(parseSpec(fixed.join('\n')).errors, []);
});

test('a habit keeps its own sentence, and a word that is not a function is offered alone', () => {
  const habit = ['universe: SPY', 'buy when close > sma(20) && close > sma(50)'];
  const h = suggestion(habit, parseSpec(habit.join('\n')).errors[0]);
  assert.equal(h?.text, 'Write and, not &&.');
  const setting = ['universe: SPY', 'rebalanse: monthly', 'buy when close > sma(20)'];
  const s = suggestion(setting, parseSpec(setting.join('\n')).errors[0]);
  assert.equal(s?.text, 'Did you mean rebalance?');
});

test('a sparkline keeps the first and the last bar and at most about n points', () => {
  const closes = Array.from({ length: 1000 }, (_, i) => 100 + i / 10);
  const { spec } = parseSpec('universe: A\nbuy when close > sma(20)\nsell when close < sma(20)');
  const data = new Map([['A', bars(closes)]]);
  const bt = runBacktest(spec!, data);
  const series = sparkSeries(bt, 120);
  assert.ok(series.benchmark.length <= 121 && series.benchmark.length >= 100);
  assert.equal(series.strategy.length, series.benchmark.length);
  assert.equal(series.benchmark[0], bt.benchmark.equity[0]);
  assert.equal(series.benchmark.at(-1), bt.benchmark.equity.at(-1));
  assert.equal(series.strategy.at(-1), bt.run.equity.at(-1));
});

test('a result starts where the reader left the one it replaces: the tab, the span and the figures', async () => {
  const { El } = await import('./page.ts');
  const { renderResult, renderLoading } = await import('../src/render.ts');
  const closes = Array.from({ length: 1400 }, (_, i) => 100 * (1 + i * 0.0005) + 3 * Math.sin(i / 9));
  const src = 'name: Trend\nuniverse: A\n\nbuy when close > sma(20)\nsell when close < sma(20)';
  const { spec } = parseSpec(src);
  const data = new Map([['A', bars(closes)]]);
  const out = { spec: spec!, backtest: runBacktest(spec!, data), data, warnings: [], prices: [] };
  const root = new El('div');
  const drawn = renderResult(root as unknown as HTMLElement, { source: src, out, notes: [], onRefresh: () => {}, initial: { tab: 'Years', span: 365.25 * 864e5, more: true } });
  assert.deepEqual(drawn.view(), { tab: 'Years', span: 365.25 * 864e5, more: true });
  assert.equal(root.byClass('bt-vs-toggle')[0].textContent, 'Fewer figures');
  drawn.busy(true);
  assert.ok(drawn.root.classList.contains('bt-busy'));
  drawn.busy(false);
  drawn.failed('Yahoo did not answer.', () => {});
  assert.equal(root.byClass('bt-refresh-problem')[0].textContent, 'Cannot get new prices. Yahoo did not answer.Run again');
  drawn.dispose();

  const wait = new El('div');
  const loading = renderLoading(wait as unknown as HTMLElement, { title: 'Trend', tickers: ['SPY', 'QQQ'], height: 640 });
  assert.equal(wait.byClass('bt-title')[0].textContent, 'Trend');
  assert.equal(wait.byClass('bt-loading-say')[0].textContent, 'The plugin loads the prices for SPY, QQQ…');
  loading.prices(5512);
  assert.equal(wait.byClass('bt-step-on')[0].textContent, 'Backtest of 5,512 bars');
  assert.equal(wait.byClass('bt-step-done').length, 1);
});

test('each figure says who did better, and "even" exactly when the words call the two the same', async () => {
  const { figures } = await import('../src/verdict.ts');
  const closes = Array.from({ length: 1500 }, (_, i) => 100 * (1 + i * 0.0004) * (1 - (i > 700 && i < 760 ? (i - 700) * 0.006 : i >= 760 ? 0.36 : 0)) + 4 * Math.sin(i / 11));
  const { spec } = parseSpec('universe: A\nbuy when close > sma(50)\nsell when close < sma(50)');
  const bt = runBacktest(spec!, new Map([['A', bars(closes)]]));
  const byLabel = Object.fromEntries(figures(bt).map((f) => [f.label, f]));
  const higherBetter = (f: { s: number; b: number; delta: string; judge?: string }) => (f.delta === 'the same' ? 'even' : f.s > f.b ? 'better' : 'worse');
  assert.equal(byLabel['Return per year'].judge, higherBetter(byLabel['Return per year']));
  assert.equal(byLabel['Worst drawdown'].judge, higherBetter(byLabel['Worst drawdown']));
  assert.equal(byLabel.Volatility.judge, byLabel.Volatility.delta === 'the same' ? 'even' : byLabel.Volatility.s < byLabel.Volatility.b ? 'better' : 'worse');
  assert.equal(byLabel['Time invested'].judge, undefined);
  assert.equal(byLabel.Trades.judge, undefined);
  // A run that holds the benchmark all the time is the same as it on every figure.
  const all = runBacktest(parseSpec('universe: A\nbuy when true')!.spec!, new Map([['A', bars(closes)]]));
  for (const f of figures(all).filter((x) => x.judge)) assert.equal(f.judge, 'even', f.label);
});

test('a slider track shows the return of each value with the other parameters where they are now, or nothing off the grid', async () => {
  const { trackOf } = await import('../src/render-params.ts');
  const paint = {
    params: [
      { name: 'fast', values: [20, 50] },
      { name: 'slow', values: [150, 200] },
    ],
    points: [
      { values: { fast: 20, slow: 150 }, cagr: 0.05 },
      { values: { fast: 50, slow: 150 }, cagr: 0.06 },
      { values: { fast: 20, slow: 200 }, cagr: 0.07 },
      { values: { fast: 50, slow: 200 }, cagr: 0.08 },
    ],
  };
  const declared = { fast: 50, slow: 200, stop: 0.05 };
  assert.deepEqual(trackOf(paint, 'fast', { fast: 50, slow: 200, stop: 0.05 }, declared), [
    { value: 20, cagr: 0.07 },
    { value: 50, cagr: 0.08 },
  ]);
  assert.deepEqual(trackOf(paint, 'slow', { fast: 20, slow: 200, stop: 0.05 }, declared)?.map((x) => x.cagr), [0.05, 0.07]);
  // Another parameter off the sweep's grid, or one the sweep did not move away from its declared value: no paint.
  assert.equal(trackOf(paint, 'fast', { fast: 50, slow: 180, stop: 0.05 }, declared), null);
  assert.equal(trackOf(paint, 'fast', { fast: 50, slow: 200, stop: 0.08 }, declared), null);
  assert.equal(trackOf(paint, 'stop', declared, declared), null);
});
