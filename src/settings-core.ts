import { parseSpec, type Defaults, type Spec } from './dsl.ts';

export interface Settings {
  /** Starting money for a run that does not set `capital`. */
  capital: number;
  /** Text in the language's own form, such as "5 bps". */
  costs: string;
  slippage: string;
  /** A yearly rate or a yield ticker, such as "4%" or "^IRX". */
  cashRate: string;
  dataSource: 'yahoo' | 'binance';
  /** How long saved prices count as fresh. */
  cacheHours: number;
  /** Save each result's figures to the note's properties. */
  writeProperties: boolean;
  /** Vault path of the "Today's orders" note; empty for none. */
  ordersNote: string;
  /** Vault folder for saved results. */
  snapshotFolder: string;
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
  cashRate: '0%',
  dataSource: 'yahoo',
  cacheHours: 6,
  writeProperties: false,
  ordersNote: '',
  snapshotFolder: 'Backtests',
  llmProvider: 'anthropic',
  llmBaseUrl: '',
  llmModel: '',
  llmSecret: '',
};

type TextKey = 'costs' | 'slippage' | 'cashRate';

const SETTING_LINE: Record<TextKey, string> = { costs: 'costs', slippage: 'slippage', cashRate: 'cash rate' };
const EXAMPLE: Record<TextKey, string> = { costs: '5 bps or 0.05%', slippage: '5 bps or 0.05%', cashRate: '4% or ^IRX' };
/** A block that reads cleanly on its own, so any problem found after adding one setting line is that line's. */
const VALID_BLOCK = 'universe: SPY\nbuy when true';

/** Reads one text setting as the language would read it on a `costs:`, `slippage:` or `cash rate:` line. */
function read(key: TextKey, text: string): { spec: Spec } | { error: string } {
  const value = text.trim();
  if (/[\r\n]/.test(value)) return { error: 'Use a single line.' };
  if (!value) return { error: `Enter a value, such as ${EXAMPLE[key]}.` };
  // In a strategy a comment would be dropped; here the text is stored as it is.
  if (/(^|\s)(#|\/\/)/.test(value)) return { error: 'Leave out comments here.' };
  const { spec, errors } = parseSpec(`${VALID_BLOCK}\n${SETTING_LINE[key]}: ${value}`);
  return spec ? { spec } : { error: errors[0]?.message ?? 'This value cannot be read.' };
}

/** Checks one text setting the way the language would read it. Returns null when fine, else a plain message. */
export function validateSetting(key: TextKey, text: string): string | null {
  const result = read(key, text);
  return 'error' in result ? result.error : null;
}

/** The parser defaults these settings imply (costs and slippage read from their text; text that cannot be read counts as 0). */
export function defaultsFrom(settings: Settings): Defaults {
  const bps = (key: 'costs' | 'slippage'): number => {
    const result = read(key, settings[key]);
    return 'spec' in result ? (key === 'costs' ? result.spec.costBps : result.spec.slippageBps) : 0;
  };
  return {
    capital: settings.capital,
    costBps: bps('costs'),
    slippageBps: bps('slippage'),
    cashRate: settings.cashRate.trim(),
    dataSource: settings.dataSource,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fills gaps and repairs out-of-range or wrong-typed values in whatever was saved. */
export function normalizeSettings(saved: unknown): Settings {
  const given = isObject(saved) ? saved : {};
  const d = DEFAULT_SETTINGS;
  const text = (key: 'ordersNote' | 'llmBaseUrl' | 'llmModel' | 'llmSecret'): string => (typeof given[key] === 'string' ? given[key].trim() : d[key]);
  const readable = (key: TextKey): string => (typeof given[key] === 'string' && validateSetting(key, given[key]) === null ? given[key].trim() : d[key]);
  const hours = given.cacheHours;
  const folder = typeof given.snapshotFolder === 'string' ? given.snapshotFolder.trim() : '';
  return {
    capital: typeof given.capital === 'number' && Number.isFinite(given.capital) && given.capital > 0 ? given.capital : d.capital,
    costs: readable('costs'),
    slippage: readable('slippage'),
    cashRate: readable('cashRate'),
    dataSource: given.dataSource === 'yahoo' || given.dataSource === 'binance' ? given.dataSource : d.dataSource,
    cacheHours: typeof hours === 'number' && Number.isFinite(hours) ? Math.min(CACHE_HOURS_MAX, Math.max(CACHE_HOURS_MIN, Math.round(hours))) : d.cacheHours,
    writeProperties: typeof given.writeProperties === 'boolean' ? given.writeProperties : d.writeProperties,
    ordersNote: text('ordersNote'),
    snapshotFolder: folder || d.snapshotFolder,
    llmProvider: given.llmProvider === 'anthropic' || given.llmProvider === 'openai' ? given.llmProvider : d.llmProvider,
    llmBaseUrl: text('llmBaseUrl'),
    llmModel: text('llmModel'),
    llmSecret: text('llmSecret'),
  };
}
