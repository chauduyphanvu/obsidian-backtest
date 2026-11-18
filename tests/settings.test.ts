import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec } from '../src/dsl.ts';
import { DEFAULT_MODEL, draftStrategy } from '../src/llm.ts';
import { CACHE_HOURS_MAX, CACHE_HOURS_MIN, DEFAULT_SETTINGS, defaultsFrom, normalizeSettings, providerText, validateSetting } from '../src/settings-core.ts';

test('the defaults are the documented ones', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    capital: 10000,
    costs: '0 bps',
    slippage: '0 bps',
    commission: '0',
    cashRate: '0%',
    dataSource: 'yahoo',
    cacheHours: 6,
    tiingoSecret: '',
    fredSecret: '',
    tiingoFallback: false,
    writeProperties: false,
    ordersNote: '',
    snapshotFolder: 'Backtests',
    resultView: 'full',
    ordersOnStartup: true,
    tickerLookup: true,
    llmProvider: 'anthropic',
    llmBaseUrl: '',
    llmModel: '',
    llmSecret: '',
  });
  for (const key of ['costs', 'slippage', 'commission', 'cashRate'] as const) assert.equal(validateSetting(key, DEFAULT_SETTINGS[key]), null);
});

test('normalizeSettings: nothing saved gives the defaults, as a new object', () => {
  for (const saved of [null, undefined, {}, 'text', 5, true, [], [1, 2]]) {
    const out = normalizeSettings(saved);
    assert.deepEqual(out, DEFAULT_SETTINGS);
    assert.notEqual(out, DEFAULT_SETTINGS);
  }
  const a = normalizeSettings(null);
  a.capital = 1;
  assert.equal(DEFAULT_SETTINGS.capital, 10000);
});

test('normalizeSettings: saved values stay, gaps are filled and unknown keys are dropped', () => {
  const out = normalizeSettings({ capital: 25000, cacheHours: 12, writeProperties: true, llmProvider: 'openai', llmBaseUrl: 'http://localhost:8000/v1', llmSecret: 'my-key', old: 'x' });
  assert.deepEqual(out, { ...DEFAULT_SETTINGS, capital: 25000, cacheHours: 12, writeProperties: true, llmProvider: 'openai', llmBaseUrl: 'http://localhost:8000/v1', llmSecret: 'my-key' });
  assert.ok(!('old' in out));
  const full = { ...DEFAULT_SETTINGS, costs: '5 bps', slippage: '2 bps', cashRate: '^IRX', dataSource: 'binance', ordersNote: 'Trading/Orders.md', snapshotFolder: 'Runs', llmModel: 'some-model' };
  assert.deepEqual(normalizeSettings(full), full);
});

test('normalizeSettings: wrong types fall back to the default', () => {
  const out = normalizeSettings({
    capital: '5000',
    costs: 5,
    slippage: null,
    cashRate: ['4%'],
    dataSource: 'kraken',
    cacheHours: '12',
    writeProperties: 'yes',
    ordersNote: 7,
    snapshotFolder: {},
    llmProvider: 'gemini',
    llmBaseUrl: false,
    llmModel: 1,
    llmSecret: [],
  });
  assert.deepEqual(out, DEFAULT_SETTINGS);
});

test('normalizeSettings: out-of-range numbers are repaired', () => {
  for (const capital of [0, -5, NaN, Infinity]) assert.equal(normalizeSettings({ capital }).capital, 10000);
  assert.equal(normalizeSettings({ capital: 0.5 }).capital, 0.5);
  assert.equal(CACHE_HOURS_MIN, 1);
  assert.equal(CACHE_HOURS_MAX, 168);
  const hours = (cacheHours: unknown) => normalizeSettings({ cacheHours }).cacheHours;
  assert.equal(hours(0), 1);
  assert.equal(hours(-4), 1);
  assert.equal(hours(1), 1);
  assert.equal(hours(168), 168);
  assert.equal(hours(169), 168);
  assert.equal(hours(100000), 168);
  assert.equal(hours(2.6), 3);
  assert.equal(hours(NaN), 6);
  assert.equal(hours(Infinity), 6);
});

test('normalizeSettings: text that the language cannot read falls back to the default', () => {
  const out = normalizeSettings({ costs: 'five', slippage: '12%', cashRate: 'banana split' });
  assert.equal(out.costs, '0 bps');
  assert.equal(out.slippage, '0 bps');
  assert.equal(out.cashRate, '0%');
  assert.equal(normalizeSettings({ cashRate: '4' }).cashRate, '0%');
  assert.equal(normalizeSettings({ costs: '' }).costs, '0 bps');
  assert.equal(normalizeSettings({ costs: '5 bps # note' }).costs, '0 bps');
});

test('normalizeSettings: text is trimmed, and an empty folder means the default one', () => {
  const out = normalizeSettings({ costs: ' 5 bps ', cashRate: ' 4% ', ordersNote: '  Orders.md ', snapshotFolder: ' Runs/2026 ', llmBaseUrl: ' http://x/v1 ', llmModel: ' m ', llmSecret: ' k ' });
  assert.deepEqual(out, { ...DEFAULT_SETTINGS, costs: '5 bps', cashRate: '4%', ordersNote: 'Orders.md', snapshotFolder: 'Runs/2026', llmBaseUrl: 'http://x/v1', llmModel: 'm', llmSecret: 'k' });
  assert.equal(normalizeSettings({ snapshotFolder: '' }).snapshotFolder, 'Backtests');
  assert.equal(normalizeSettings({ snapshotFolder: '   ' }).snapshotFolder, 'Backtests');
});

test('validateSetting accepts what a costs or slippage line accepts', () => {
  for (const text of ['0 bps', '5 bps', '5', '12.5 bp', '0.05%', ' 5 bps ', '999 bps']) {
    assert.equal(validateSetting('costs', text), null, text);
    assert.equal(validateSetting('slippage', text), null, text);
  }
});

test('validateSetting rejects what the language rejects, with its message', () => {
  assert.match(validateSetting('costs', 'five')!, /"five" is not a cost\. Write it as 5 bps or 0\.05%/);
  assert.match(validateSetting('slippage', 'five')!, /is not a slippage/);
  assert.match(validateSetting('costs', '-5 bps')!, /is not a cost/);
  assert.match(validateSetting('costs', '1000 bps')!, /Costs must be under 10% per trade/);
  assert.match(validateSetting('slippage', '10%')!, /Slippage must be under 10% per trade/);
  assert.match(validateSetting('costs', '5 percent')!, /is not a cost/);
});

test('validateSetting: empty text, extra lines and comments are not values', () => {
  assert.equal(validateSetting('costs', ''), 'Enter a value, such as 5 bps or 0.05%.');
  assert.equal(validateSetting('cashRate', '   '), 'Enter a value, such as 4% or ^IRX.');
  assert.equal(validateSetting('costs', '5 bps\nuniverse: QQQ'), 'Use a single line.');
  assert.equal(validateSetting('slippage', '5 bps\r\nbuy when true'), 'Use a single line.');
  assert.equal(validateSetting('costs', '5 bps # note'), 'Leave out comments here.');
  assert.equal(validateSetting('cashRate', '4% // note'), 'Leave out comments here.');
});

test('validateSetting for the cash rate: a yearly percentage or a yield ticker', () => {
  for (const text of ['0%', '4%', '4.25%', ' 4 % ', '50%', '^IRX', 'yahoo:^IRX', 'BTC-USD', 'csv:rates/irx.csv']) {
    assert.equal(validateSetting('cashRate', text), null, text);
  }
  assert.match(validateSetting('cashRate', '4')!, /Write the cash rate as a yearly percentage/);
  assert.match(validateSetting('cashRate', '60%')!, /between 0% and 50% a year/);
  assert.match(validateSetting('cashRate', '-1%')!, /between 0% and 50% a year/);
  assert.match(validateSetting('cashRate', 'banana split')!, /is not a ticker/);
  assert.match(validateSetting('cashRate', 'a b')!, /is not a ticker/);
});

test('defaultsFrom: the defaults give the parser defaults', () => {
  assert.deepEqual(defaultsFrom(DEFAULT_SETTINGS), { capital: 10000, costBps: 0, slippageBps: 0, cashRate: '0%', dataSource: 'yahoo' });
});

test('defaultsFrom reads costs and slippage in the language\'s own forms', () => {
  const settings = { ...DEFAULT_SETTINGS, capital: 50000, costs: '5 bps', slippage: '0.05%', cashRate: ' ^IRX ', dataSource: 'binance' as const };
  assert.deepEqual(defaultsFrom(settings), { capital: 50000, costBps: 5, slippageBps: 5, cashRate: '^IRX', dataSource: 'binance' });
  assert.equal(defaultsFrom({ ...DEFAULT_SETTINGS, costs: '12.5 bp' }).costBps, 12.5);
  assert.equal(defaultsFrom({ ...DEFAULT_SETTINGS, costs: '10' }).costBps, 10);
});

test('defaultsFrom: text that cannot be read counts as 0', () => {
  for (const bad of ['five', '', '1000 bps', '5 bps # x', '5 bps\nuniverse: QQQ']) {
    const out = defaultsFrom({ ...DEFAULT_SETTINGS, costs: bad, slippage: bad });
    assert.equal(out.costBps, 0, JSON.stringify(bad));
    assert.equal(out.slippageBps, 0, JSON.stringify(bad));
  }
});

test('the parser uses what the settings imply', () => {
  const defaults = defaultsFrom(normalizeSettings({ capital: 20000, costs: '7 bps', slippage: '3 bps', cashRate: '4%', dataSource: 'binance' }));
  const { spec, errors } = parseSpec('universe: BTCUSDT\nbuy when close > sma(20)', { defaults });
  assert.deepEqual(errors, []);
  assert.equal(spec!.capital, 20000);
  assert.equal(spec!.costBps, 7);
  assert.equal(spec!.slippageBps, 3);
  assert.deepEqual(spec!.cash, { k: 'fixed', rate: 0.04 });
  assert.equal(spec!.universe[0].source, 'binance');
  // Whatever was saved, the defaults never make a strategy fail to read.
  const messy = defaultsFrom(normalizeSettings({ costs: 'x', slippage: 'y', cashRate: 'z z', capital: -1, dataSource: 'q' }));
  assert.deepEqual(parseSpec('universe: SPY\nbuy when close > sma(20)', { defaults: messy }).errors, []);
});

test('provider text: Anthropic may leave the address and model empty, and needs a key', () => {
  const t = providerText('anthropic');
  assert.match(t.address.desc, /^Leave empty/);
  assert.match(t.model.desc, /^Leave empty to use claude-opus-5-5\./);
  assert.equal(t.address.placeholder, 'https://api.anthropic.com');
  assert.equal(t.model.placeholder, DEFAULT_MODEL.anthropic);
  assert.match(t.key, /^Required\./);
});

test('provider text: an OpenAI-compatible server needs an address and a model, and may go without a key', () => {
  const t = providerText('openai');
  assert.match(t.address.desc, /^Required\./);
  assert.match(t.model.desc, /^Required\./);
  assert.doesNotMatch(t.address.desc + t.model.desc, /Leave empty/);
  assert.equal(t.address.placeholder, 'http://localhost:8000/v1');
  assert.match(t.key, /Leave it empty for a server that needs no key/);
});

test('provider text agrees with the request code about what may be left empty', async () => {
  let posted = 0;
  const post = async () => {
    posted++;
    return { status: 200, text: JSON.stringify({ choices: [{ message: { content: '```strategy\nuniverse: SPY\nbuy when true\n```' } }], content: [{ type: 'text', text: '```strategy\nuniverse: SPY\nbuy when true\n```' }] }) };
  };
  const open = { provider: 'openai' as const, baseUrl: 'http://localhost:8000/v1', model: 'm', apiKey: '' };
  // What the text calls required is refused when empty; a key the text lets go empty is accepted.
  await assert.rejects(draftStrategy('x', { ...open, baseUrl: '' }, post), /address/);
  await assert.rejects(draftStrategy('x', { ...open, model: '' }, post), /model name/);
  assert.equal(posted, 0);
  await draftStrategy('x', open, post);
  // What the text lets go empty is accepted for Anthropic.
  await draftStrategy('x', { provider: 'anthropic', baseUrl: '', model: '', apiKey: 'sk-test' }, post);
  await assert.rejects(draftStrategy('x', { provider: 'anthropic', baseUrl: '', model: '', apiKey: '' }, post), /API key/);
  assert.equal(posted, 2);
});
