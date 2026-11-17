import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CALENDAR, INDICATORS, POSITION, SERIES, SETTINGS, parseSpec } from '../src/dsl.ts';
import {
  DEFAULT_MODEL,
  DRAFT_PRIVACY,
  PROMPT_EXAMPLES,
  SYSTEM_PROMPT,
  draftStrategy,
  parseReply,
  repairMessage,
  userMessage,
  type HttpPost,
  type HttpResponse,
  type LlmConfig,
} from '../src/llm.ts';

const FENCE = '```';
const GOOD = 'name: Trend\nuniverse: SPY\nbuy when close > sma(200)\nsell when close < sma(200)';
const BAD = 'universe: SPY\nbuy when close > smaa(200)\nsell when close < sma(200)';
const TWO_BAD = 'universe: SPY\nbuy when close > smaa(200)\nsell when close < smaa(200)';
const reply = (source: string, ...notes: string[]) => [`${FENCE}strategy`, source, FENCE, ...notes.map((n) => `NOTE: ${n}`)].join('\n');

const ANTHROPIC: LlmConfig = { provider: 'anthropic', baseUrl: '', model: '', apiKey: 'sk-test' };
const OPENAI: LlmConfig = { provider: 'openai', baseUrl: 'http://localhost:8000/v1', model: 'qwen', apiKey: '' };

const anthropicBody = (text: string): HttpResponse => ({ status: 200, text: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] }) });
const openaiBody = (text: string): HttpResponse => ({ status: 200, text: JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }) });

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { model: string; messages: { role: string; content: string }[]; [key: string]: unknown };
}

/** A fake service that answers with `answers` in order and keeps what it was sent. */
function fake(answers: HttpResponse[]): { post: HttpPost; calls: Call[] } {
  const calls: Call[] = [];
  const post: HttpPost = async (url, headers, body) => {
    calls.push({ url, headers, body: JSON.parse(body) });
    const next = answers[calls.length - 1] ?? answers[answers.length - 1];
    return next;
  };
  return { post, calls };
}

test('every example in the prompt parses without errors and appears in the prompt as written', () => {
  assert.ok(PROMPT_EXAMPLES.length >= 4 && PROMPT_EXAMPLES.length <= 6);
  for (const source of PROMPT_EXAMPLES) {
    assert.deepEqual(parseSpec(source).errors, [], source);
    assert.ok(SYSTEM_PROMPT.includes(source), source);
  }
});

test('the examples between them use rebalancing, a for section, a stop, a ranking, parameters with ranges and test from', () => {
  const all = PROMPT_EXAMPLES.join('\n');
  for (const part of [/^rebalance: /m, /^for \w+:/m, /^stop loss: /m, /^hold: top \d/m, / in \d+\.\.\d+ step /, /^test from: /m, /bars held/]) assert.match(all, part);
});

test('the prompt names every setting, function, series, calendar value and position value of the language', () => {
  for (const s of SETTINGS) assert.ok(SYSTEM_PROMPT.includes(`${s}:`), `setting ${s}`);
  for (const f of [...Object.keys(INDICATORS), 'min', 'max', 'abs']) assert.ok(SYSTEM_PROMPT.includes(`${f}(`), `function ${f}`);
  for (const w of [...SERIES, ...CALENDAR, ...Object.values(POSITION), 'crosses above', 'crosses below', 'above', 'below']) {
    assert.match(SYSTEM_PROMPT, new RegExp(`\\b${w}\\b`), `word ${w}`);
  }
});

test('the prompt says where a rule fills, with both settings of fill', () => {
  assert.ok(SYSTEM_PROMPT.includes('A rule that holds at a close fills at the next open, or with fill: close at that same close.'));
  assert.match(SYSTEM_PROMPT, /^ {2}fill: close /m);
});

test('the prompt states the limits and the rules about what not to write', () => {
  for (const part of [/no shorting/, /no leverage/, /no options/, /NOTE:/, /Never invent syntax/, /one "buy when" or one "sell when"/, /YYYY-MM-DD/, /Do not invent settings, functions/, /before the first "for" line/]) {
    assert.match(SYSTEM_PROMPT, part);
  }
});

test('userMessage carries the description, and repairMessage the errors, the lines they point at and the draft', () => {
  assert.equal(userMessage('  Buy SPY.\n'), 'Description:\nBuy SPY.');
  const { errors } = parseSpec(TWO_BAD);
  const text = repairMessage(TWO_BAD, errors);
  assert.match(text, /2 problems/);
  for (const e of errors) assert.ok(text.includes(`Line ${e.line}: ${e.message}`));
  assert.ok(text.includes('  buy when close > smaa(200)'));
  assert.ok(text.includes(`${FENCE}strategy\n${TWO_BAD}\n${FENCE}`));
  assert.match(repairMessage(BAD, parseSpec(BAD).errors), /a problem/);
});

test('parseReply reads a strategy fence and the notes after it', () => {
  assert.deepEqual(parseReply(reply(GOOD, 'I chose SPY for the market.', 'Costs left out.')), { source: GOOD, notes: ['I chose SPY for the market.', 'Costs left out.'] });
});

test('parseReply accepts a fence with no language, another language, a capital letter or CRLF line ends', () => {
  assert.deepEqual(parseReply(`${FENCE}\n${GOOD}\n${FENCE}`), { source: GOOD, notes: [] });
  assert.deepEqual(parseReply(`${FENCE}text\n${GOOD}\n${FENCE}`), { source: GOOD, notes: [] });
  assert.deepEqual(parseReply(`${FENCE}Strategy\n${GOOD}\n${FENCE}`), { source: GOOD, notes: [] });
  assert.deepEqual(parseReply(`${FENCE}strategy\r\n${GOOD.replaceAll('\n', '\r\n')}\r\n${FENCE}\r\nNOTE: a\r\n`), { source: GOOD, notes: ['a'] });
});

test('parseReply prefers the strategy fence among several, and drops prose before and after', () => {
  const text = `Sure! Here is an idea.\n\n${FENCE}python\nprint(1)\n${FENCE}\n\nHere is the strategy:\n\n${reply(GOOD, 'One note.')}\n\nThis buys while SPY is in an uptrend.`;
  assert.deepEqual(parseReply(text), { source: GOOD, notes: ['One note.'] });
});

test('parseReply reads notes written as bullets or in bold, and moves a note out of the fence', () => {
  const text = `${FENCE}strategy\n${GOOD}\nNOTE: inside the fence\n${FENCE}\n- NOTE: a bullet\n**NOTE:** bold\n**NOTE**: bold again\nNote that this is prose, not a note.`;
  assert.deepEqual(parseReply(text), { source: GOOD, notes: ['inside the fence', 'a bullet', 'bold', 'bold again'] });
});

test('parseReply takes a strategy with no fence: from its first line to the first prose line', () => {
  assert.deepEqual(parseReply(`${GOOD}\n\nNOTE: unfenced`), { source: GOOD, notes: ['unfenced'] });
  const text = `Here is the strategy:\n\n${GOOD}\n  and close > 1\n\nThis buys while SPY is in an uptrend.\nNOTE: after prose`;
  assert.deepEqual(parseReply(text), { source: `${GOOD}\n  and close > 1`, notes: ['after prose'] });
  assert.deepEqual(parseReply('Buy when close > sma(200)\nsell when close < 1'), { source: 'Buy when close > sma(200)\nsell when close < 1', notes: [] });
});

test('parseReply copes with a fence that is never closed, and with thinking printed before the reply', () => {
  assert.deepEqual(parseReply(`${FENCE}strategy\n${GOOD}\nNOTE: cut off`), { source: GOOD, notes: ['cut off'] });
  const thinking = `<think>\nMaybe:\n${reply(BAD)}\n</think>\n\n${reply(GOOD)}`;
  assert.deepEqual(parseReply(thinking), { source: GOOD, notes: [] });
});

test('parseReply returns null when there is no strategy', () => {
  assert.equal(parseReply(''), null);
  assert.equal(parseReply("I can't short stocks, sorry."), null);
  assert.equal(parseReply(`${FENCE}strategy\n\n${FENCE}\nNOTE: nothing`), null);
  assert.equal(parseReply('NOTE: only a note'), null);
});

test('a valid first reply is one request: Anthropic with its default address and model', async () => {
  const { post, calls } = fake([anthropicBody(reply(GOOD, 'A note.'))]);
  const draft = await draftStrategy('  Buy SPY above its 200-day average.  ', ANTHROPIC, post);
  assert.deepEqual(draft, { source: GOOD, notes: ['A note.'], errors: [], warnings: [], attempts: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(calls[0].headers, { 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
  assert.deepEqual(calls[0].body, {
    model: DEFAULT_MODEL.anthropic,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage('Buy SPY above its 200-day average.') }],
  });
  assert.equal(DEFAULT_MODEL.anthropic, 'claude-opus-5-5');
});

test('Anthropic: a chosen model and address are used, trailing slashes and spaces dropped', async () => {
  const { post, calls } = fake([anthropicBody(reply(GOOD))]);
  await draftStrategy('x', { provider: 'anthropic', baseUrl: ' https://proxy.example.com/ ', model: ' claude-sonnet-5-5 ', apiKey: ' sk-test\n' }, post);
  assert.equal(calls[0].url, 'https://proxy.example.com/v1/messages');
  assert.equal(calls[0].body.model, 'claude-sonnet-5-5');
  assert.equal(calls[0].headers['x-api-key'], 'sk-test');
});

test('an OpenAI-compatible server gets the system prompt first, temperature 0 and no Authorization header without a key', async () => {
  const { post, calls } = fake([openaiBody(reply(GOOD))]);
  const draft = await draftStrategy('Buy SPY.', OPENAI, post);
  assert.equal(draft.attempts, 1);
  assert.equal(calls[0].url, 'http://localhost:8000/v1/chat/completions');
  assert.deepEqual(calls[0].headers, { 'content-type': 'application/json' });
  assert.deepEqual(calls[0].body, {
    model: 'qwen',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage('Buy SPY.') },
    ],
    temperature: 0,
  });
});

test('an OpenAI-compatible server gets a Bearer key when one is set, and a trailing slash on its address is dropped', async () => {
  const { post, calls } = fake([openaiBody(reply(GOOD))]);
  await draftStrategy('x', { ...OPENAI, baseUrl: 'https://api.example.com/v1/', apiKey: 'secret' }, post);
  assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions');
  assert.deepEqual(calls[0].headers, { 'content-type': 'application/json', Authorization: 'Bearer secret' });
});

test('a reply with errors is sent back for a repair with the parser messages and the previous draft', async () => {
  const { post, calls } = fake([anthropicBody(reply(BAD, 'First note.')), anthropicBody(reply(GOOD, 'First note.', 'Second note.'))]);
  const draft = await draftStrategy('Buy SPY.', ANTHROPIC, post);
  assert.deepEqual(draft, { source: GOOD, notes: ['First note.', 'Second note.'], errors: [], warnings: [], attempts: 2 });
  assert.equal(calls.length, 2);
  const [first, second] = calls.map((c) => c.body.messages);
  assert.equal(first.length, 1);
  assert.deepEqual(second.slice(0, 2), [first[0], { role: 'assistant', content: reply(BAD, 'First note.') }]);
  assert.equal(second.length, 3);
  assert.equal(second[2].role, 'user');
  assert.equal(second[2].content, repairMessage(BAD, parseSpec(BAD).errors));
  assert.match(second[2].content, /Unknown name "smaa"/);
  assert.ok(second[2].content.includes(BAD));
});

test('the repair turn of an OpenAI-compatible server keeps the system message and the whole conversation', async () => {
  const { post, calls } = fake([openaiBody(reply(BAD)), openaiBody(reply(GOOD))]);
  await draftStrategy('Buy SPY.', OPENAI, post);
  assert.deepEqual(calls[1].body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.match(calls[1].body.messages[3].content, /Unknown name "smaa"/);
});

test('a draft that is never repaired comes back with its errors after one request plus maxRepairs repairs', async () => {
  const run = async (maxRepairs?: number) => {
    const { post, calls } = fake([anthropicBody(reply(BAD))]);
    const draft = await draftStrategy('x', ANTHROPIC, post, maxRepairs === undefined ? {} : { maxRepairs });
    return { draft, calls: calls.length };
  };
  const byDefault = await run();
  assert.equal(byDefault.calls, 3);
  assert.equal(byDefault.draft.attempts, 3);
  assert.equal(byDefault.draft.source, BAD);
  assert.match(byDefault.draft.errors[0].message, /Unknown name "smaa"/);
  assert.equal((await run(0)).calls, 1);
  assert.equal((await run(1)).calls, 2);
  assert.equal((await run(0)).draft.errors.length, 1);
});

test('a repair that sends no strategy leaves the earlier draft, still with its errors', async () => {
  const { post } = fake([anthropicBody(reply(BAD, 'Kept.')), anthropicBody('Sorry, I am not sure how to fix that.')]);
  const draft = await draftStrategy('x', ANTHROPIC, post);
  assert.equal(draft.source, BAD);
  assert.deepEqual(draft.notes, ['Kept.']);
  assert.equal(draft.errors.length, 1);
  assert.equal(draft.attempts, 2);
});

test('the default settings reach the parser', async () => {
  const source = 'universe: BTCUSDT\ninterval: 1h\nbuy when close > sma(50)';
  assert.equal((await draftStrategy('x', ANTHROPIC, fake([anthropicBody(reply(source))]).post, { maxRepairs: 0 })).errors.length, 1);
  assert.equal((await draftStrategy('x', ANTHROPIC, fake([anthropicBody(reply(source))]).post, { defaults: { dataSource: 'binance' } })).errors.length, 0);
});

test('warnings of the parser come with the draft', async () => {
  const draft = await draftStrategy('x', ANTHROPIC, fake([anthropicBody(reply('universe: SPY\nbuy when close > 100'))]).post);
  assert.equal(draft.errors.length, 0);
  assert.equal(draft.warnings.length, 1);
});

test('onStatus reports the first draft and each repair', async () => {
  const seen: string[] = [];
  await draftStrategy('x', ANTHROPIC, fake([anthropicBody(reply(TWO_BAD)), anthropicBody(reply(BAD)), anthropicBody(reply(GOOD))]).post, { onStatus: (t) => seen.push(t) });
  assert.deepEqual(seen, ['Writing a draft…', 'Fixing 2 problems…', 'Fixing 1 problem…']);
  const once: string[] = [];
  await draftStrategy('x', ANTHROPIC, fake([anthropicBody(reply(GOOD))]).post, { onStatus: (t) => once.push(t) });
  assert.deepEqual(once, ['Writing a draft…']);
});

test('each HTTP failure is a plain-English error', async () => {
  const cases: [number, string, RegExp][] = [
    [401, '', /rejected the API key/],
    [403, '', /rejected the API key/],
    [404, '', /model or address/],
    [429, '', /busy or over its limit/],
    [500, '', /had a problem \(HTTP 500\)/],
    [503, '', /had a problem \(HTTP 503\)/],
    [400, JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens is too large' } }), /refused the request \(HTTP 400\): max_tokens is too large/],
    [422, 'not json', /refused the request \(HTTP 422\)\.$/],
  ];
  for (const [status, text, pattern] of cases) {
    for (const config of [ANTHROPIC, OPENAI]) {
      const { post } = fake([{ status, text }]);
      await assert.rejects(draftStrategy('x', config, post), pattern, `${status} ${config.provider}`);
    }
  }
});

test('a failed connection, an unreadable reply, a refusal, an empty reply and a reply with no strategy are errors', async () => {
  const down: HttpPost = async () => {
    throw new Error('net::ERR_CONNECTION_REFUSED');
  };
  await assert.rejects(draftStrategy('x', OPENAI, down), /Could not reach the model service \(net::ERR_CONNECTION_REFUSED\)/);
  await assert.rejects(draftStrategy('x', OPENAI, fake([{ status: 200, text: '<html>' }]).post), /could not read/);
  await assert.rejects(draftStrategy('x', ANTHROPIC, fake([{ status: 200, text: JSON.stringify({ stop_reason: 'refusal', content: [] }) }]).post), /declined/);
  await assert.rejects(draftStrategy('x', OPENAI, fake([openaiBody('')]).post), /did not contain a strategy\.$/);
  await assert.rejects(draftStrategy('x', OPENAI, fake([{ status: 200, text: '{"choices":[]}' }]).post), /did not contain a strategy/);
  await assert.rejects(draftStrategy('x', ANTHROPIC, fake([anthropicBody("I can't short stocks, but a long-only version is possible.")]).post), /did not contain a strategy\. It said: "I can't short stocks/);
});

test('a missing key or address stops before any request', async () => {
  const { post, calls } = fake([anthropicBody(reply(GOOD))]);
  await assert.rejects(draftStrategy('x', { ...ANTHROPIC, apiKey: '  ' }, post), /Anthropic API key/);
  await assert.rejects(draftStrategy('x', { ...OPENAI, baseUrl: '' }, post), /address of your model server/);
  await assert.rejects(draftStrategy('x', { ...OPENAI, model: '' }, post), /model name/);
  assert.equal(calls.length, 0);
});

test('the requests hold only the prompt, the description, the model\'s own drafts and the parser\'s messages', async () => {
  const description = 'Buy SPY when it is above its 200-day average.';
  const replies = [reply(TWO_BAD, 'Note one.'), reply(BAD), reply(BAD)];
  for (const [config, body] of [[ANTHROPIC, anthropicBody], [OPENAI, openaiBody]] as const) {
    const { post, calls } = fake(replies.map(body));
    await draftStrategy(description, { ...config, apiKey: 'sk-sentinel-key' }, post);
    assert.equal(calls.length, 3);
    const allowed = new Set([SYSTEM_PROMPT, userMessage(description), replies[0], replies[1], repairMessage(TWO_BAD, parseSpec(TWO_BAD).errors), repairMessage(BAD, parseSpec(BAD).errors)]);
    for (const call of calls) {
      const keys = Object.keys(call.body).sort();
      assert.deepEqual(keys, config.provider === 'anthropic' ? ['max_tokens', 'messages', 'model', 'system'] : ['messages', 'model', 'temperature']);
      const texts = [...call.body.messages.map((m) => m.content), ...(typeof call.body.system === 'string' ? [call.body.system] : [])];
      for (const t of texts) assert.ok(allowed.has(t), t.slice(0, 80));
      const raw = JSON.stringify(call.body);
      assert.ok(!raw.includes('sk-sentinel-key'));
    }
    assert.ok(!Object.values(calls[0].headers).join(' ').includes('http'));
  }
});

test('no example buys when true while it has a stop or a target, because such a ticker could never be bought again', () => {
  for (const source of PROMPT_EXAMPLES) {
    if (/^\s*(stop loss|trailing stop|take profit):/m.test(source)) assert.doesNotMatch(source, /buy when (true|always)\b/, source);
  }
  const mix = PROMPT_EXAMPLES.find((e) => e.startsWith('name: 60/40'))!;
  assert.match(mix, /^buy when close > sma\(200\)$/m);
  assert.match(mix, /^stop loss: 15%$/m);
});

test('the prompt tells the model not to combine buy when true with a stop or target, and why', () => {
  assert.match(SYSTEM_PROMPT, /Do not use "buy when true" \(or "buy when always"\) together with stop loss, trailing stop or take profit/);
  assert.match(SYSTEM_PROMPT, /never is, so the ticker would never be held again/);
});

test('what the dialog and settings say is sent matches what is sent', () => {
  assert.equal(
    DRAFT_PRIVACY,
    'Nothing from your notes or vault is sent. What is sent to the service you chose is your description, the plugin’s built-in guide to the language and, when a draft has problems, that draft and the problems found.',
  );
  assert.doesNotMatch(DRAFT_PRIVACY, /only/i);
});

test('a note line is found whatever its markup, with the text trimmed', () => {
  const text = `${FENCE}strategy\n${GOOD}\n${FENCE}\n  NOTE:   spaced out   \n* **NOTE:** starred\nNOTE:\n   `;
  assert.deepEqual(parseReply(text), { source: GOOD, notes: ['spaced out', 'starred'] });
});

test('reading a reply takes linear time: 200k characters in well under 200 ms', () => {
  const big = 200_000;
  const t0 = performance.now();
  parseReply(`${FENCE}strategy\nuniverse: SPY\n${FENCE}\nNOTE:${' '.repeat(big)}`);
  parseReply('NOTE:'.concat(' '.repeat(big), 'x'));
  parseReply('<think>'.repeat(big / 7));
  parseReply('**NOTE'.repeat(big / 6));
  parseReply('- '.repeat(big / 2) + 'NOTE:');
  parseReply(`${FENCE}${' '.repeat(big)}`);
  parseReply(`${GOOD}\n`.repeat(big / 80));
  assert.ok(performance.now() - t0 < 200, `${performance.now() - t0} ms`);
});

test('only the first 20,000 characters of a reply are read', () => {
  const long = `${FENCE}strategy\n${GOOD}\n${FENCE}\n${'x'.repeat(20_000)}\nNOTE: too late`;
  assert.deepEqual(parseReply(long), { source: GOOD, notes: [] });
  const early = `${FENCE}strategy\n${GOOD}\n${FENCE}\nNOTE: early\n${'x'.repeat(30_000)}`;
  assert.deepEqual(parseReply(early)?.notes, ['early']);
});

test('the prompt says how many rules of each side a scope may have, the add rule included', () => {
  assert.match(SYSTEM_PROMPT, /At most one buy rule, one sell rule and one add rule per scope, and an add rule only with an entries line\./);
});
