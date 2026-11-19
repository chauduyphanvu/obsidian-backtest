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

test('a block that cannot run shows its own lines, the word marked, a short message, and a fix that writes the block', async () => {
  const { renderErrors } = await import('../src/render.ts');
  const { El } = await import('./page.ts');
  const src = 'name: Trend\nuniverse: SPY\ncosts: 5 bps\n\nbuy when close > smaa(200)\nsell when close < sma(200)\n';
  const { errors } = parseSpec(src);
  const written: string[] = [];
  const root = new El('div');
  renderErrors(root as unknown as HTMLElement, errors, src, { fix: (text) => (written.push(text), Promise.resolve()) });
  assert.equal(root.byClass('bt-title')[0].textContent, 'Trend');
  assert.equal(root.byClass('bt-chip-problem')[0].textContent, 'Cannot run · 1 problem');
  // The three settings and the blank line after them fold into one line; the rules stay, the bad one tinted.
  assert.equal(root.byClass('bt-err-folded')[0].textContent, '· · ·  3 settings');
  const bad = root.byClass('bt-err-bad');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].byClass('bt-err-g')[0].textContent, '5');
  assert.equal(bad[0].byClass('bt-squig')[0].textContent, 'smaa');
  assert.equal(root.byClass('bt-err-msg')[0].textContent, 'Unknown name "smaa". Did you mean sma, the simple average of the last n closes?');
  assert.ok(root.byClass('bt-err-all')[0].textContent.startsWith('All names'));
  const fix = root.byClass('bt-err-fix')[0];
  assert.equal(fix.textContent, 'Change to sma');
  fix.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(written, [src.replace('smaa', 'sma')]);
  assert.equal(bad[0].byClass('bt-squig-fixed')[0].textContent, 'sma');
  // Where the block cannot be written, as in the preview panel, the fix is a sentence only.
  const panel = new El('div');
  renderErrors(panel as unknown as HTMLElement, errors, src);
  assert.equal(panel.byClass('bt-err-fix').length, 0);
  assert.match(panel.byClass('bt-err-msg')[0].textContent, /Did you mean sma/);
});

test('a fix from a list finds its block by its text, and refuses a note with two blocks of that text', async () => {
  const { fixBlockInNote } = await import('../src/rewrite.ts');
  const block = 'name: Typo\nbuy when close > smaa(200)';
  const fixed = 'name: Typo\nbuy when close > sma(200)';
  const note = `# Mine\n\n> [!note]\n> \`\`\`strategy\n> ${block.split('\n').join('\n> ')}\n> \`\`\`\n\n\`\`\`strategy\nname: Other\nbuy when true\n\`\`\`\n`;
  assert.equal(fixBlockInNote(note, block, fixed), note.replace('smaa', 'sma'));
  const twice = `\`\`\`strategy\n${block}\n\`\`\`\n\n\`\`\`strategy\n${block}\n\`\`\`\n`;
  assert.equal(fixBlockInNote(twice, block, fixed), null);
  assert.equal(fixBlockInNote('no blocks', block, fixed), null);
});

test('the dashboard has six columns, a shimmer for a running row, the near chip filled late, and a fix for a block with a problem', async () => {
  const { renderDashboard } = await import('../src/render-dashboard.ts');
  const { El } = await import('./page.ts');
  const closes = Array.from({ length: 300 }, (_, i) => 100 + i * 0.1 + 3 * Math.sin(i / 7));
  const good = 'name: Good\nuniverse: A\nbuy when close > sma(20)\nsell when close < sma(20)';
  const typo = 'name: Typo\nuniverse: A\nbuy when close > smaa(20)';
  const out = (src: string) => {
    const { spec } = parseSpec(src);
    const data = new Map([['A', bars(closes)]]);
    return { spec: spec!, backtest: runBacktest(spec!, data), data, warnings: [], prices: [] };
  };
  let release: (v: ReturnType<typeof out>) => void = () => {};
  const late = new Promise<ReturnType<typeof out>>((r) => (release = r));
  let answer: (r: null) => void = () => {};
  const fixed: string[] = [];
  const host = {
    find: async () => [
      { note: 'a.md', name: 'Good', source: good },
      { note: 'b.md', name: 'Typo', source: typo },
      { note: 'c.md', name: 'Slow', source: good },
    ],
    run: (source: string) => (source === typo ? Promise.reject(new Error(parseSpec(typo).errors[0].message)) : source === good && fixed.length === 0 && host.calls++ === 1 ? late : Promise.resolve(out(source))),
    calls: 0,
    openNote: () => {},
    now: () => Date.UTC(2026, 10, 18, 22, 41),
    triggers: () => new Promise<null>((r) => (answer = r)),
    fix: () => ({ label: 'Change to sma', text: 'Did you mean sma?', write: async () => void fixed.push('done') }),
  };
  const root = new El('div');
  renderDashboard(root as unknown as HTMLElement, '', host);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(root.all().filter((e) => e.tag === 'th').map((e) => e.textContent), ['Strategy', '', 'Return per year', 'Worst drawdown', 'Sharpe', 'Now and next']);
  const names = () => root.byClass('bt-dash-name').map((e) => e.textContent);
  // The one that ran comes first, the problem next, the one still running last with a shimmer in its cells.
  assert.deepEqual(names(), ['Good', 'Typo', 'Slow']);
  const rows = root.all().filter((e) => e.tag === 'tr').slice(1);
  assert.ok(rows[2].classes().includes('bt-dash-running') && rows[2].byClass('bt-dash-sk').length === 5);
  assert.equal(rows[0].byClass('bt-spark').length, 1);
  // Old prices are said under the name.
  assert.match(rows[0].byClass('bt-dash-sub')[0].textContent, /^\d+ trades? · prices end \d{4}-\d\d-\d\d$/);
  // The near chip's line is there and empty until the trigger prices come; with none, it says so.
  assert.equal(rows[0].byClass('bt-dash-next')[0].textContent, '');
  answer(null);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(root.all().filter((e) => e.tag === 'tr')[1].byClass('bt-dash-next')[0].textContent, 'No order near');
  // The problem row: the message cut short, the sentence and the button.
  assert.equal(rows[1].byClass('bt-dash-reason')[0].textContent, 'Unknown name "smaa". Did you mean sma?');
  const button = rows[1].all().find((e) => e.tag === 'button' && e.textContent === 'Change to sma')!;
  button.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(fixed, ['done']);
  release(out(good));
});

test('the hover finds the part of a rule it is over, reads it on its ticker, and gives its value at the last bar', async () => {
  const { hoverValue, ruleNode } = await import('../src/debug.ts');
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
  const other = Array.from({ length: 60 }, (_, i) => 50 + i / 2);
  const { spec } = parseSpec('universe: A\nbuy when close > sma(10) and close of B > sma( 5 ) of B\nsell when close < sma(10)');
  const data = new Map([
    ['A', bars(closes)],
    ['B', bars(other)],
  ]);
  assert.equal(ruleNode(spec!, 'sma(10)')?.asset, 'A');
  // Spaces do not count, and a part after `of` is read on that ticker.
  assert.equal(ruleNode(spec!, 'sma(5)')?.asset, 'B');
  assert.equal(ruleNode(spec!, 'ema(3)'), null);
  const v = hoverValue(spec!, data, 'sma(10)')!;
  // The average of the last ten closes, 150 to 159, beside the last close it is near.
  assert.equal(v.label, 'sma(10) of A');
  assert.equal(v.value, 154.5);
  assert.equal(v.close, 159);
  assert.equal(v.values.length, 20);
  assert.equal(v.closes?.length, 20);
  // The close itself has no close to compare with.
  assert.equal(hoverValue(spec!, data, 'close')!.close, null);
});

test('the call under the pointer runs to its closing bracket, or is the word alone', async () => {
  const { callAt } = await import('../src/docs.ts');
  const line = 'buy when close > sma(max(5, 10)) and rsi (2) < 10';
  assert.equal(callAt(line, 17, 20), 'sma(max(5, 10))');
  assert.equal(callAt(line, 9, 14), 'close');
  assert.equal(callAt(line, 37, 40), 'rsi (2)');
});
