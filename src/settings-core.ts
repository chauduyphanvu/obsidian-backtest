import { BORROW_FEE, MARGIN_RATE, parseSpec, type Defaults, type Spec } from './dsl.ts';
import { DEFAULT_MODEL } from './llm.ts';
import { DATA_SOURCES, type DataSource } from './types.ts';

export interface Settings {
  /** Starting money for a run that does not set `capital`. */
  capital: number;
  /** Text in the language's own form, such as "5 bps". */
  costs: string;
  slippage: string;
  /** Text of a `commission` line, such as "1" or "0.005 per share, min 1"; "0" for none. */
  commission: string;
  /** A yearly rate or a yield ticker, such as "4%" or "^IRX". */
  cashRate: string;
  /** Yearly rates for a strategy that borrows, such as "0.5%" and "6%": the fee on the value of its shorts, and the interest on money it owes. */
  borrowFee: string;
  marginRate: string;
  dataSource: DataSource;
  /** How long saved prices count as fresh. */
  cacheHours: number;
  /** Names of the secrets in Obsidian's keychain that hold the Tiingo and FRED API keys; the keys themselves are never saved here. */
  tiingoSecret: string;
  fredSecret: string;
  /** Load a US ticker from Tiingo when Yahoo fails and its saved copy is old or missing. */
  tiingoFallback: boolean;
  /** Save each result's figures to the note's properties. */
  writeProperties: boolean;
  /** Vault path of the "Today's orders" note; empty for none. */
  ordersNote: string;
  /** Vault folder for saved results. */
  snapshotFolder: string;
  /** How a result first appears: everything, or one line that opens on a click. */
  resultView: 'full' | 'compact';
  /** Work out today's orders when Obsidian starts and show the count in the status bar. */
  ordersOnStartup: boolean;
  /** Look tickers up at Yahoo and Binance while a strategy is being written. */
  tickerLookup: boolean;
  llmProvider: 'anthropic' | 'openai';
  /** Empty means the provider's own address. */
  llmBaseUrl: string;
  /** Empty means the provider's default model. */
  llmModel: string;
  /** Name of the secret in Obsidian's keychain that holds the API key; the key itself is never saved here. */
  llmSecret: string;
}

export const CACHE_HOURS_MIN = 1;
export const CACHE_HOURS_MAX = 168;

export const DEFAULT_SETTINGS: Settings = {
  capital: 10_000,
  costs: '0 bps',
  slippage: '0 bps',
  commission: '0',
  cashRate: '0%',
  borrowFee: '0.5%',
  marginRate: '6%',
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
};

/** What each provider's three connection fields say, matching what the request code requires of them. */
export function providerText(provider: Settings['llmProvider']): { address: { desc: string; placeholder: string }; model: { desc: string; placeholder: string }; key: string } {
  const stored = 'Choose or add a secret in Obsidian’s keychain. Only the secret’s name is saved here.';
  if (provider === 'anthropic') {
    return {
      address: { desc: 'Leave empty to use Anthropic’s own address. Enter another only to go through a proxy.', placeholder: 'https://api.anthropic.com' },
      model: { desc: `Leave empty to use ${DEFAULT_MODEL.anthropic}.`, placeholder: DEFAULT_MODEL.anthropic },
      key: `Required. ${stored}`,
    };
  }
  return {
    address: { desc: 'Required. The address of your server, such as http://localhost:8000/v1.', placeholder: 'http://localhost:8000/v1' },
    model: { desc: 'Required. The name of the model on your server.', placeholder: 'Model name' },
    key: `${stored} Leave it empty for a server that needs no key.`,
  };
}

type TextKey = 'costs' | 'slippage' | 'commission' | 'cashRate' | 'borrowFee' | 'marginRate';

const SETTING_LINE: Record<TextKey, string> = {
  costs: 'costs',
  slippage: 'slippage',
  commission: 'commission',
  cashRate: 'cash rate',
  borrowFee: 'borrow fee',
  marginRate: 'margin rate',
};
const EXAMPLE: Record<TextKey, string> = {
  costs: '5 bps or 0.05%',
  slippage: '5 bps or 0.05%',
  commission: '1, 0.005 per share, min 1, or 0 for none',
  cashRate: '4% or ^IRX',
  borrowFee: '0.5%',
  marginRate: '6%',
};
/** A block that reads cleanly on its own, so any problem found after adding one setting line is that line's. */
const VALID_BLOCK = 'universe: SPY\nbuy when true';
/** The same, for the rates of borrowing: only a block that can borrow carries them in its spec. */
const BORROWING_BLOCK = `${VALID_BLOCK}\nshort when false`;

/** Reads one text setting as the language would read it on its line, such as `costs:` or `borrow fee:`. */
function read(key: TextKey, text: string): { spec: Spec } | { error: string } {
  const value = text.trim();
  if (/[\r\n]/.test(value)) return { error: 'Use a single line.' };
  if (!value) return { error: `Enter a value, such as ${EXAMPLE[key]}.` };
  // In a strategy a comment would be dropped; here the text is stored as it is.
  if (/(^|\s)(#|\/\/)/.test(value)) return { error: 'Leave out comments here.' };
  const block = key === 'borrowFee' || key === 'marginRate' ? BORROWING_BLOCK : VALID_BLOCK;
  const { spec, errors } = parseSpec(`${block}\n${SETTING_LINE[key]}: ${value}`);
  return spec ? { spec } : { error: errors[0]?.message ?? 'This value cannot be read.' };
}

/** Checks one text setting the way the language would read it. Returns null when fine, else a plain message. */
export function validateSetting(key: TextKey, text: string): string | null {
  const result = read(key, text);
  return 'error' in result ? result.error : null;
}

/** The parser defaults these settings imply (costs, slippage, commission and the rates of borrowing read from their text; text that cannot be read counts as none, or as the parser's own rate). */
export function defaultsFrom(settings: Settings): Defaults {
  const bps = (key: 'costs' | 'slippage'): number => {
    const result = read(key, settings[key]);
    return 'spec' in result ? (key === 'costs' ? result.spec.costBps : result.spec.slippageBps) : 0;
  };
  const charge = read('commission', settings.commission);
  const commission = 'spec' in charge ? charge.spec.commission : undefined;
  const margin = (key: 'borrowFee' | 'marginRate') => {
    const result = read(key, settings[key]);
    return 'spec' in result ? result.spec.margin : undefined;
  };
  const borrowFee = margin('borrowFee')?.borrowFee ?? BORROW_FEE;
  const marginRate = margin('marginRate')?.rate ?? MARGIN_RATE;
  // At the parser's own rates they are left out, as a commission of none is, so that with these settings as they come
  // the defaults, which go into every result's key and every version, are what they were before the settings existed.
  return {
    capital: settings.capital,
    costBps: bps('costs'),
    slippageBps: bps('slippage'),
    cashRate: settings.cashRate.trim(),
    dataSource: settings.dataSource,
    ...(commission ? { commission } : {}),
    ...(borrowFee !== BORROW_FEE ? { borrowFee } : {}),
    ...(marginRate !== MARGIN_RATE ? { marginRate } : {}),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fills gaps and repairs out-of-range or wrong-typed values in whatever was saved. */
export function normalizeSettings(saved: unknown): Settings {
  const given = isObject(saved) ? saved : {};
  const d = DEFAULT_SETTINGS;
  const text = (key: 'ordersNote' | 'llmBaseUrl' | 'llmModel' | 'llmSecret' | 'tiingoSecret' | 'fredSecret'): string => (typeof given[key] === 'string' ? given[key].trim() : d[key]);
  const readable = (key: TextKey): string => (typeof given[key] === 'string' && validateSetting(key, given[key]) === null ? given[key].trim() : d[key]);
  const hours = given.cacheHours;
  const folder = typeof given.snapshotFolder === 'string' ? given.snapshotFolder.trim() : '';
  return {
    capital: typeof given.capital === 'number' && Number.isFinite(given.capital) && given.capital > 0 ? given.capital : d.capital,
    costs: readable('costs'),
    slippage: readable('slippage'),
    commission: readable('commission'),
    cashRate: readable('cashRate'),
    borrowFee: readable('borrowFee'),
    marginRate: readable('marginRate'),
    dataSource: (DATA_SOURCES as readonly unknown[]).includes(given.dataSource) ? (given.dataSource as DataSource) : d.dataSource,
    cacheHours: typeof hours === 'number' && Number.isFinite(hours) ? Math.min(CACHE_HOURS_MAX, Math.max(CACHE_HOURS_MIN, Math.round(hours))) : d.cacheHours,
    tiingoSecret: text('tiingoSecret'),
    fredSecret: text('fredSecret'),
    tiingoFallback: typeof given.tiingoFallback === 'boolean' ? given.tiingoFallback : d.tiingoFallback,
    writeProperties: typeof given.writeProperties === 'boolean' ? given.writeProperties : d.writeProperties,
    ordersNote: text('ordersNote'),
    snapshotFolder: folder || d.snapshotFolder,
    resultView: given.resultView === 'full' || given.resultView === 'compact' ? given.resultView : d.resultView,
    ordersOnStartup: typeof given.ordersOnStartup === 'boolean' ? given.ordersOnStartup : d.ordersOnStartup,
    tickerLookup: typeof given.tickerLookup === 'boolean' ? given.tickerLookup : d.tickerLookup,
    llmProvider: given.llmProvider === 'anthropic' || given.llmProvider === 'openai' ? given.llmProvider : d.llmProvider,
    llmBaseUrl: text('llmBaseUrl'),
    llmModel: text('llmModel'),
    llmSecret: text('llmSecret'),
  };
}
