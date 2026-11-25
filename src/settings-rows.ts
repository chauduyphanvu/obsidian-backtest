// The rows of the plugin's settings tab, in order. Obsidian 1.13 and later draws the tab from definitions made of these
// rows (settings.ts getSettingDefinitions), and older versions draw the same rows by hand (settings.ts display).

import { DRAFT_PRIVACY } from './llm.ts';
import { CACHE_HOURS_MAX, CACHE_HOURS_MIN, providerText, validateSetting, type Settings } from './settings-core.ts';

type KeyOf<V> = { [K in keyof Settings]: Settings[K] extends V ? K : never }[keyof Settings];

export type SettingRow =
  | { kind: 'heading'; name: string }
  | {
      kind: 'text';
      key: KeyOf<string>;
      name: string;
      desc: string;
      placeholder: string;
      /** The problem with a value as typed, or null when it can be saved. */
      check?: (text: string) => string | null;
      /** The value saved for valid text; the text trimmed when there is none. */
      save?: (text: string) => string;
    }
  | { kind: 'number'; key: KeyOf<number>; name: string; desc: string; placeholder: string; check: (text: string) => string | null }
  | { kind: 'dropdown'; key: KeyOf<string>; name: string; desc: string; options: Record<string, string> }
  | { kind: 'toggle'; key: KeyOf<boolean>; name: string; desc: string }
  /** The name of a secret in Obsidian's keychain; the key itself is never saved. */
  | { kind: 'secret'; key: KeyOf<string>; name: string; desc: string }
  | { kind: 'clear-prices'; name: string; desc: string };

const STORED = 'Select or add a secret in the Obsidian keychain. The plugin saves only the name of the secret.';

/** The rows as they read with `settings`: what the strategy writer's rows say depends on its provider. */
export function settingRows(settings: Settings): SettingRow[] {
  const llm = providerText(settings.llmProvider);
  return [
    { kind: 'heading', name: 'Defaults for new runs' },
    {
      kind: 'number',
      key: 'capital',
      name: 'Start capital',
      desc: 'The plugin uses this value when a strategy has no capital line.',
      placeholder: '10000',
      check: (v) => {
        const n = Number(v);
        return v.trim() !== '' && Number.isFinite(n) && n > 0 ? null : 'Type a number that is more than 0.';
      },
    },
    { kind: 'text', key: 'costs', name: 'Costs per trade', desc: 'The plugin uses this value when a strategy has no costs line. For example: 5 bps.', placeholder: '0 bps', check: (v) => validateSetting('costs', v) },
    { kind: 'text', key: 'slippage', name: 'Slippage per fill', desc: 'Each fill is worse than the price by this value. For example: 5 bps.', placeholder: '0 bps', check: (v) => validateSetting('slippage', v) },
    {
      kind: 'text',
      key: 'commission',
      name: 'Commission per order',
      desc: 'The plugin uses this value when a strategy has no commission line. The plugin adds it to the costs. For example: 1 (a fee of 1 for each order), or 0.005 per share, min 1. Type 0 for no commission.',
      placeholder: '0',
      check: (v) => validateSetting('commission', v),
    },
    {
      kind: 'text',
      key: 'cashRate',
      name: 'Interest on cash',
      desc: 'A rate, for example 4%. Or a ticker with a price that is a yield, for example ^IRX. A cash rate line in a strategy overrides this value.',
      placeholder: '0%',
      check: (v) => validateSetting('cashRate', v),
    },
    {
      kind: 'text',
      key: 'borrowFee',
      name: 'Borrow fee for shorts',
      desc: 'A yearly fee on the value of each short position, for example 0.5%. A borrow fee line in a strategy overrides this value.',
      placeholder: '0.5%',
      check: (v) => validateSetting('borrowFee', v),
    },
    {
      kind: 'text',
      key: 'marginRate',
      name: 'Interest on borrowed money',
      desc: 'A yearly rate on the money that a strategy borrows when it holds more than its equity, for example 6%. A margin rate line in a strategy overrides this value.',
      placeholder: '6%',
      check: (v) => validateSetting('marginRate', v),
    },
    {
      kind: 'dropdown',
      key: 'dataSource',
      name: 'Price source for tickers without a prefix',
      desc: 'The service for tickers that you write without a prefix (for example binance:). For Tiingo, you must also set the "Tiingo API key" setting.',
      options: { yahoo: 'Yahoo', binance: 'Binance', tiingo: 'Tiingo' },
    },

    { kind: 'heading', name: 'Prices' },
    {
      kind: 'number',
      key: 'cacheHours',
      name: 'Keep saved prices for',
      desc: `The plugin downloads saved prices again after this number of hours, from ${CACHE_HOURS_MIN} to ${CACHE_HOURS_MAX}.`,
      placeholder: '6',
      check: (v) => {
        const n = Number(v);
        return v.trim() !== '' && Number.isInteger(n) && n >= CACHE_HOURS_MIN && n <= CACHE_HOURS_MAX ? null : `Type a number of hours from ${CACHE_HOURS_MIN} to ${CACHE_HOURS_MAX}, with no decimals.`;
      },
    },
    { kind: 'clear-prices', name: 'Saved prices', desc: 'Delete all the price files that the plugin saved.' },
    {
      kind: 'secret',
      key: 'tiingoSecret',
      name: 'Tiingo API key',
      desc: `The plugin uses this key for tiingo: tickers, data: tiingo and the setting "Use Tiingo when Yahoo is not available". ${STORED} The plugin sends the key to api.tiingo.com in a request header.`,
    },
    {
      kind: 'secret',
      key: 'fredSecret',
      name: 'FRED API key',
      desc: `The plugin uses this key for fred: series. ${STORED} The plugin sends the key in the URL of each request to api.stlouisfed.org, because FRED accepts the key only there.`,
    },
    {
      kind: 'toggle',
      key: 'tiingoFallback',
      name: 'Use Tiingo when Yahoo is not available',
      desc: 'This setting applies when the plugin cannot download a US ticker from Yahoo and has no saved copy from the last 3 days. Then the plugin downloads the ticker from Tiingo. The result tells you this. Tickers that start with ^ or end with a suffix (for example .L, -USD or =X) are not included. You must also set the Tiingo API key.',
    },

    { kind: 'heading', name: 'Notes' },
    {
      kind: 'toggle',
      key: 'writeProperties',
      name: 'Write results to note properties',
      desc: 'After the strategies in a note run, the plugin saves their primary figures to the properties of the note. A Base can then show them in a list. The plugin controls all properties that start with bt_. It updates them, and removes the bt_ properties that no strategy in the note makes. This setting changes your notes.',
    },
    {
      kind: 'text',
      key: 'ordersNote',
      name: 'Note for today’s orders',
      desc: 'The vault path of the note for the orders, for example Trading/Orders.md. The plugin writes the full note again each time you save. The plugin replaces a note at this path only if the plugin made that note. Keep this field empty for no note.',
      placeholder: 'Trading/Orders.md',
    },
    { kind: 'text', key: 'snapshotFolder', name: 'Folder for saved results', desc: 'The vault folder for saved results.', placeholder: 'Backtests', save: (v) => v.trim() || 'Backtests' },

    { kind: 'heading', name: 'Results and editor' },
    {
      kind: 'dropdown',
      key: 'resultView',
      name: 'Result view',
      desc: 'Full shows all of each result. Compact shows one line for each strategy. Click the line to open the result. Compact is good for a note with many strategies.',
      options: { full: 'Full', compact: 'Compact' },
    },
    {
      kind: 'toggle',
      key: 'ordersOnStartup',
      name: 'Find orders when Obsidian starts',
      desc: 'After Obsidian starts, the plugin runs all strategies in the vault. Then the status bar shows the number of orders for today. For this, the plugin downloads the prices of the tickers in each strategy. When you set this to off, the plugin removes the count and stops the runs immediately.',
    },
    {
      kind: 'toggle',
      key: 'tickerLookup',
      name: 'Find tickers while you type',
      desc: 'Shows tickers for the text that you type, and identifies unknown tickers. The plugin sends the text that you type in the position of a ticker to Yahoo. It also sends the Yahoo tickers in the strategy blocks on the screen. It sends one ticker at a time. It does not send text that starts with binance:, csv:, tiingo: or fred:. It does not send the tickers of a block that uses Tiingo for its prices. The plugin downloads the list of Binance markets, and sends no text that you type. The plugin sends nothing more from your notes.',
    },

    { kind: 'heading', name: 'Strategies from a description' },
    {
      kind: 'dropdown',
      key: 'llmProvider',
      name: 'Provider',
      desc: `The service that writes a strategy from your description. ${DRAFT_PRIVACY}`,
      options: { anthropic: 'Anthropic', openai: 'OpenAI-compatible server' },
    },
    { kind: 'text', key: 'llmBaseUrl', name: 'Server address', desc: llm.address.desc, placeholder: llm.address.placeholder },
    { kind: 'text', key: 'llmModel', name: 'Model', desc: llm.model.desc, placeholder: llm.model.placeholder },
    { kind: 'secret', key: 'llmSecret', name: 'API key', desc: llm.key },
  ];
}

/** The value saved for text typed in a text row that passed its check. */
export const savedText = (row: Extract<SettingRow, { kind: 'text' }>, text: string): string => (row.save ? row.save(text) : text.trim());
