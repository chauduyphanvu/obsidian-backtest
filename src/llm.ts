import { parseSpec, type Defaults, type Diagnostic } from './dsl.ts';
import { EXAMPLES, type Example } from './examples.ts';
import { continues, lineKind, type LineKind } from './highlight.ts';
import { LANGUAGE_GUIDE } from './language-guide.ts';

export interface LlmConfig {
  provider: 'anthropic' | 'openai';
  /** "" is the provider's own address for Anthropic. OpenAI-compatible servers need one, such as http://localhost:8000/v1. */
  baseUrl: string;
  /** "" means DEFAULT_MODEL for the provider. */
  model: string;
  /** May be "" for a local server. */
  apiKey: string;
}

/** An OpenAI-compatible server has no default: model names are whatever that server serves. */
export const DEFAULT_MODEL: Record<LlmConfig['provider'], string> = { anthropic: 'claude-opus-5-5', openai: '' };

export interface HttpResponse {
  status: number;
  text: string;
}
export type HttpPost = (url: string, headers: Record<string, string>, body: string) => Promise<HttpResponse>;

export interface Draft {
  source: string;
  notes: string[];
  errors: Diagnostic[];
  warnings: Diagnostic[];
  /** Requests made to the model: the first draft plus any repairs. */
  attempts: number;
}

/** What the reader is told about what leaves the vault when a strategy is drafted. */
export const DRAFT_PRIVACY =
  'The plugin sends nothing from your notes or vault. It sends these items to the service that you selected: your description and the plugin instructions for the strategy language. If a draft has problems, the plugin also sends that draft and its problems.';

const FENCE = '```';

export { PROMPT_EXAMPLES } from './examples.ts';

const renderExample = (e: Example): string =>
  ['Description:', e.description, '', 'Reply:', `${FENCE}strategy`, e.source, FENCE, ...e.notes.map((n) => `NOTE: ${n}`)].join('\n');

/** The fixed instructions: role, the complete language reference with worked examples, the reply format. */
export const SYSTEM_PROMPT = `You turn a plain-English trading idea into a strategy for Backtest Blocks, a backtester inside the note-taking app Obsidian. Strategies are written in a small rule language. A parser checks every line you write, and the rules it accepts, not you, are what get backtested. Use only what this document lists.

## Reply format

Reply with the strategy in one ${FENCE}strategy code fence that holds only strategy lines. After the fence you may add lines that each start with "NOTE:", one short sentence per line, for:
- anything the description asks for that the language cannot express, and what you wrote instead;
- anything you chose that the description did not say, such as which ticker stands for "the market", a period, a threshold, a date or a cost.
Write nothing else: no greeting, no explanation of the rules, no text in the fence that is not strategy.

${LANGUAGE_GUIDE}

## Worked examples

${EXAMPLES.map(renderExample).join('\n\n')}`;

export function userMessage(description: string): string {
  return `Description:\n${description.trim()}`;
}

export function repairMessage(draft: string, errors: Diagnostic[]): string {
  const lines = draft.split('\n');
  const problems = errors.map((e) => {
    const text = lines[e.line - 1]?.trim();
    return `- Line ${e.line}: ${e.message}${text ? `\n  ${text}` : ''}`;
  });
  return [
    `The parser found ${errors.length === 1 ? 'a problem' : `${errors.length} problems`} in your draft.`,
    '',
    ...problems,
    '',
    'Your draft was:',
    `${FENCE}strategy`,
    draft,
    FENCE,
    '',
    'Reply again in the same format with the whole strategy corrected. Change only what the problems require, and use only the settings and functions in your instructions.',
  ].join('\n');
}

// Only the start of a line is matched; the rest is trimmed, so a long run of spaces costs nothing extra.
const NOTE_HEAD = /^\s*(?:[-*•]\s+)?(?:\*\*)?NOTE(?::\*\*|\*\*:|:)/i;
/** A model reply is a few hundred characters; this keeps a runaway one from taking long to read. */
const MAX_REPLY_CHARS = 20_000;

function noteIn(line: string): string | null {
  const head = line.match(NOTE_HEAD);
  return head ? line.slice(head[0].length).trim() || null : null;
}

/** Pulls the strategy text and the notes out of a model reply; tolerant of code fences and stray prose. Null when there is no strategy. */
export function parseReply(reply: string): { source: string; notes: string[] } | null {
  // Local reasoning models can print their thinking in the reply, and it may hold a draft of its own.
  const lines = reply.slice(0, MAX_REPLY_CHARS).replace(/<think>[\s\S]*?<\/think>/gi, '').split(/\r?\n/);

  const blocks: { lang: string; from: number; to: number }[] = [];
  let lang: string | null = null;
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*```\s*([\w-]*)/);
    if (!m) continue;
    if (lang === null) {
      lang = m[1].toLowerCase();
      start = i + 1;
    } else {
      blocks.push({ lang, from: start, to: i });
      lang = null;
    }
  }
  if (lang !== null) blocks.push({ lang, from: start, to: lines.length });

  let from: number;
  let to: number;
  const block = blocks.find((b) => b.lang === 'strategy') ?? blocks.find((b) => b.lang === '') ?? blocks[0];
  if (block) {
    ({ from, to } = block);
  } else {
    // No fence: the strategy runs from the first line that reads like one to the first line that does not.
    const kinds: LineKind[] = [];
    let inRule = false;
    for (const line of lines) {
      const kind = lineKind(line, inRule);
      inRule = continues(kind);
      kinds.push(kind);
    }
    from = kinds.findIndex((k) => k !== 'blank' && k !== 'other' && k !== 'continuation');
    if (from < 0) return null;
    to = kinds.findIndex((k, i) => i > from && k === 'other');
    if (to < 0) to = lines.length;
  }

  const notes: string[] = [];
  const kept: string[] = [];
  lines.forEach((line, i) => {
    const note = noteIn(line);
    if (note !== null) notes.push(note);
    else if (i >= from && i < to) kept.push(line);
  });
  const source = kept.join('\n').trim();
  return source ? { source, notes } : null;
}

type Turn = { role: 'user' | 'assistant'; content: string };

const ANTHROPIC_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 16000;

function checkConfig(config: LlmConfig): void {
  if (config.provider === 'anthropic' && !config.apiKey.trim()) throw new Error('Set your Anthropic API key in the plugin settings.');
  if (config.provider === 'openai' && !config.baseUrl.trim()) throw new Error('Type the address of your model server in the plugin settings, for example http://localhost:8000/v1.');
  if (!(config.model.trim() || DEFAULT_MODEL[config.provider])) throw new Error('Type the model name of your server in the plugin settings.');
}

function buildRequest(config: LlmConfig, turns: Turn[]): { url: string; headers: Record<string, string>; body: string } {
  const model = config.model.trim() || DEFAULT_MODEL[config.provider];
  const base = config.baseUrl.trim().replace(/\/+$/, '');
  const key = config.apiKey.trim();
  if (config.provider === 'anthropic') {
    return {
      url: `${base || ANTHROPIC_URL}/v1/messages`,
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
      // No temperature: current Claude models reject it.
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages: turns }),
    };
  }
  return {
    url: `${base}/chat/completions`,
    headers: { 'content-type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...turns], temperature: 0 }),
  };
}

/** The message a service put in its error body, if any. */
function serviceMessage(text: string): string {
  try {
    const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    return typeof message === 'string' ? message.trim().slice(0, 300) : '';
  } catch {
    return '';
  }
}

function httpError(res: HttpResponse): Error {
  const { status } = res;
  if (status === 401 || status === 403) return new Error('The service rejected the API key. Make sure that the key in the plugin settings is correct.');
  if (status === 404) return new Error('The service cannot find that model or address. Make sure that the model name and the server address in the plugin settings are correct.');
  if (status === 429) return new Error('The service cannot accept more requests at this time. Send again after one minute.');
  if (status >= 500) return new Error(`The service had a problem (HTTP ${status}). Send again after one minute.`);
  const detail = serviceMessage(res.text);
  return new Error(`The service rejected the request (HTTP ${status})${detail ? `: ${detail}` : '.'}`);
}

function replyText(config: LlmConfig, raw: string): string {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('The plugin cannot read the reply from the service. Make sure that the server address in the plugin settings is correct.');
  }
  if (config.provider === 'anthropic') {
    const reply = data as { stop_reason?: string; content?: { type?: string; text?: unknown }[] };
    if (reply.stop_reason === 'refusal') throw new Error('The model did not write this strategy. Use different words for the description and send again.');
    return (reply.content ?? []).flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');
  }
  const content = (data as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

async function ask(config: LlmConfig, post: HttpPost, turns: Turn[]): Promise<string> {
  const { url, headers, body } = buildRequest(config, turns);
  let res: HttpResponse;
  try {
    res = await post(url, headers, body);
  } catch (e) {
    throw new Error(`Cannot connect to the model service (${e instanceof Error ? e.message : String(e)}). Make sure that your network connection and the server address in the plugin settings are correct.`);
  }
  if (res.status < 200 || res.status >= 300) throw httpError(res);
  return replyText(config, res.text);
}

function noStrategy(reply: string): Error {
  const said = reply.replace(/\s+/g, ' ').trim();
  return new Error(`The model's reply did not contain a strategy.${said ? ` It said: "${said.length > 200 ? `${said.slice(0, 200)}…` : said}"` : ''}`);
}

/**
 * Asks for a draft, checks it with the parser, and asks for a repair while it has errors, at most
 * `maxRepairs` times. Rejects with a plain-English Error when the service cannot be used or sends no strategy.
 */
export async function draftStrategy(
  description: string,
  config: LlmConfig,
  post: HttpPost,
  opts: { maxRepairs?: number; defaults?: Partial<Defaults>; onStatus?: (text: string) => void } = {},
): Promise<Draft> {
  checkConfig(config);
  const maxRepairs = opts.maxRepairs ?? 2;
  const turns: Turn[] = [{ role: 'user', content: userMessage(description) }];
  let draft: Draft | null = null;
  opts.onStatus?.('The model writes a draft…');
  for (let attempts = 1; ; attempts++) {
    const reply = await ask(config, post, turns);
    const parsed = parseReply(reply);
    if (!parsed) {
      // A repair that comes back empty-handed leaves the earlier draft, which is still worth showing.
      if (draft) return { ...draft, attempts };
      throw noStrategy(reply);
    }
    const { errors, warnings } = parseSpec(parsed.source, { defaults: opts.defaults });
    const earlier: string[] = draft?.notes ?? [];
    draft = { source: parsed.source, notes: [...earlier, ...parsed.notes.filter((n) => !earlier.includes(n))], errors, warnings, attempts };
    if (errors.length === 0 || attempts > maxRepairs) return draft;
    opts.onStatus?.(`The model corrects ${errors.length} problem${errors.length === 1 ? '' : 's'}…`);
    turns.push({ role: 'assistant', content: reply }, { role: 'user', content: repairMessage(parsed.source, errors) });
  }
}
