import { Notice, PluginSettingTab, SecretComponent, Setting, type App, type Plugin } from 'obsidian';
import { DRAFT_PRIVACY } from './llm.ts';
import { CACHE_HOURS_MAX, CACHE_HOURS_MIN, providerText, validateSetting, type Settings } from './settings-core.ts';

export interface SettingsHost {
  settings: Settings;
  saveSettings(): Promise<void>;
  /** Removes the saved price files. */
  clearPrices(): Promise<void>;
  /** Switches the count of today's orders in the status bar on or off at once, as the setting says. */
  setOrdersBadge(on: boolean): void;
}

export class BacktestSettingTab extends PluginSettingTab {
  // Only what the tab needs: through Plugin, `settings` would read as the API of Obsidian 1.13, newer than minAppVersion.
  private host: SettingsHost;

  constructor(app: App, plugin: Plugin & SettingsHost) {
    super(app, plugin);
    this.host = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.host.settings;
    containerEl.empty();

    new Setting(containerEl).setName('Defaults for new runs').setHeading();
    this.field('Starting money', 'Used when a strategy has no capital line.', String(settings.capital), '10000', (v) => {
      const n = Number(v);
      return v.trim() !== '' && Number.isFinite(n) && n > 0 ? null : 'Enter an amount above 0.';
    }, (v) => (settings.capital = Number(v)), 'number');
    this.field('Costs per trade', 'Used when a strategy has no costs line, such as 5 bps.', settings.costs, '0 bps', (v) => validateSetting('costs', v), (v) => (settings.costs = v.trim()));
    this.field('Slippage per fill', 'How much worse each fill is than the price, such as 5 bps.', settings.slippage, '0 bps', (v) => validateSetting('slippage', v), (v) => (settings.slippage = v.trim()));
    this.field(
      'Commission per order',
      'Used when a strategy has no commission line, on top of the costs: 1 for a fixed amount per order, or 0.005 per share, min 1. 0 for none.',
      settings.commission,
      '0',
      (v) => validateSetting('commission', v),
      (v) => (settings.commission = v.trim()),
    );
    this.field(
      'Interest on cash',
      'A rate such as 4%, or a ticker whose price is a yield, such as ^IRX. Strategies can override it with a cash rate line.',
      settings.cashRate,
      '0%',
      (v) => validateSetting('cashRate', v),
      (v) => (settings.cashRate = v.trim()),
    );
    this.field(
      'Borrow fee for shorts',
      'A yearly fee on the value of each short position, such as 0.5%. Strategies can override it with a borrow fee line.',
      settings.borrowFee,
      '0.5%',
      (v) => validateSetting('borrowFee', v),
      (v) => (settings.borrowFee = v.trim()),
    );
    this.field(
      'Interest on borrowed money',
      'A yearly rate on the money a strategy owes when it holds more than its equity, such as 6%. Strategies can override it with a margin rate line.',
      settings.marginRate,
      '6%',
      (v) => validateSetting('marginRate', v),
      (v) => (settings.marginRate = v.trim()),
    );
    new Setting(containerEl)
      .setName('Where plain tickers come from')
      .setDesc('Used for tickers written without a prefix such as binance:. Tiingo needs its API key below.')
      .addDropdown((d) =>
        d
          .addOptions({ yahoo: 'Yahoo', binance: 'Binance', tiingo: 'Tiingo' })
          .setValue(settings.dataSource)
          .onChange(async (v) => {
            settings.dataSource = v as Settings['dataSource'];
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl).setName('Prices').setHeading();
    this.field(
      'Keep saved prices for',
      `Hours before saved prices are fetched again, from ${CACHE_HOURS_MIN} to ${CACHE_HOURS_MAX}.`,
      String(settings.cacheHours),
      '6',
      (v) => {
        const n = Number(v);
        return v.trim() !== '' && Number.isInteger(n) && n >= CACHE_HOURS_MIN && n <= CACHE_HOURS_MAX ? null : `Enter a whole number of hours, from ${CACHE_HOURS_MIN} to ${CACHE_HOURS_MAX}.`;
      },
      (v) => (settings.cacheHours = Number(v)),
      'number',
    );
    new Setting(containerEl)
      .setName('Saved prices')
      .setDesc('Remove every price file this plugin has saved.')
      .addButton((b) =>
        b.setButtonText('Clear saved prices').onClick(async () => {
          b.setDisabled(true);
          try {
            await this.host.clearPrices();
            b.setButtonText('Cleared');
            window.setTimeout(() => b.setButtonText('Clear saved prices').setDisabled(false), 2000);
          } catch (e) {
            b.setDisabled(false);
            new Notice(`Could not clear saved prices: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      );
    const stored = 'Choose or add a secret in Obsidian’s keychain. Only the secret’s name is saved here.';
    new Setting(containerEl)
      .setName('Tiingo API key')
      .setDesc(`Needed for tiingo: tickers, data: tiingo and the setting below. ${stored} It is sent to api.tiingo.com in a request header.`)
      .addComponent((el) =>
        new SecretComponent(this.app, el).setValue(settings.tiingoSecret).onChange(async (name) => {
          settings.tiingoSecret = name ?? '';
          await this.host.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('FRED API key')
      .setDesc(`Needed for fred: series. ${stored} FRED takes it only in the web address of each request to api.stlouisfed.org.`)
      .addComponent((el) =>
        new SecretComponent(this.app, el).setValue(settings.fredSecret).onChange(async (name) => {
          settings.fredSecret = name ?? '';
          await this.host.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('When Yahoo fails, use Tiingo')
      .setDesc(
        'When a US ticker cannot be loaded from Yahoo and its saved copy is more than 3 days old, or there is none, load it from Tiingo instead, and say so in the result. Not for tickers that start with ^ or end in a suffix such as .L, -USD or =X. Needs the Tiingo API key.',
      )
      .addToggle((t) =>
        t.setValue(settings.tiingoFallback).onChange(async (v) => {
          settings.tiingoFallback = v;
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl).setName('Notes').setHeading();
    new Setting(containerEl)
      .setName('Write results to note properties')
      .setDesc(
        "When a note's strategies have run, save their main figures to the note's properties so a Base can list them. Properties that start with bt_ belong to this plugin: it updates them, and removes ones that no strategy in the note produces any more. This edits your notes.",
      )
      .addToggle((t) =>
        t.setValue(settings.writeProperties).onChange(async (v) => {
          settings.writeProperties = v;
          await this.host.saveSettings();
        }),
      );
    this.field(
      'Note for today’s orders',
      'Vault path of the note to write them to, such as Trading/Orders.md. The note is rewritten each time you save. An existing note is replaced only if this plugin made it. Leave empty for none.',
      settings.ordersNote,
      'Trading/Orders.md',
      () => null,
      (v) => (settings.ordersNote = v.trim()),
    );
    this.field('Folder for saved results', 'Vault folder where saved results go.', settings.snapshotFolder, 'Backtests', () => null, (v) => (settings.snapshotFolder = v.trim() || 'Backtests'));

    new Setting(containerEl).setName('Results and writing').setHeading();
    new Setting(containerEl)
      .setName('How results first appear')
      .setDesc('Full shows everything. Compact shows one line per strategy that opens on a click, which suits a note with several strategies.')
      .addDropdown((d) =>
        d
          .addOptions({ full: 'Full', compact: 'Compact' })
          .setValue(settings.resultView)
          .onChange(async (v) => {
            settings.resultView = v as Settings['resultView'];
            await this.host.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('Check for orders when Obsidian starts')
      .setDesc("Runs every strategy in the vault shortly after start-up and shows how many orders are due in the status bar. This fetches prices for every strategy's tickers. Turning it off hides the count and stops the checks at once.")
      .addToggle((t) =>
        t.setValue(settings.ordersOnStartup).onChange(async (v) => {
          settings.ordersOnStartup = v;
          this.host.setOrdersBadge(v);
          await this.host.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('Look tickers up while writing')
      .setDesc(
        "Suggests matching tickers and marks ones that do not exist. What you type where a ticker goes, and the Yahoo tickers named in strategy blocks on screen, are sent to Yahoo's search, one ticker at a time. Starting what you type with binance:, csv:, tiingo: or fred: keeps it from being sent, and so does a block whose tickers come from Tiingo. Binance's list of markets is downloaded without sending anything. Nothing else from your notes is sent.",
      )
      .addToggle((t) =>
        t.setValue(settings.tickerLookup).onChange(async (v) => {
          settings.tickerLookup = v;
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl).setName('Drafting from plain English').setDesc(DRAFT_PRIVACY).setHeading();
    new Setting(containerEl)
      .setName('Provider')
      .setDesc('The service that turns your description into a strategy.')
      .addDropdown((d) =>
        d
          .addOptions({ anthropic: 'Anthropic', openai: 'OpenAI-compatible server' })
          .setValue(settings.llmProvider)
          .onChange(async (v) => {
            settings.llmProvider = v as Settings['llmProvider'];
            await this.host.saveSettings();
            this.display();
          }),
      );
    const text = providerText(settings.llmProvider);
    this.field('Server address', text.address.desc, settings.llmBaseUrl, text.address.placeholder, () => null, (v) => (settings.llmBaseUrl = v.trim()));
    this.field('Model', text.model.desc, settings.llmModel, text.model.placeholder, () => null, (v) => (settings.llmModel = v.trim()));
    new Setting(containerEl)
      .setName('API key')
      .setDesc(text.key)
      .addComponent((el) =>
        new SecretComponent(this.app, el).setValue(settings.llmSecret).onChange(async (name) => {
          settings.llmSecret = name ?? '';
          await this.host.saveSettings();
        }),
      );
  }

  /**
   * A text row. A value that fails `check` shows its message under the description and is not
   * applied or saved; the field keeps what was typed.
   */
  private field(name: string, desc: string, value: string, placeholder: string, check: (value: string) => string | null, apply: (value: string) => void, type = 'text'): void {
    const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
    const message = setting.descEl.createDiv({ cls: 'bt-setting-error' });
    setting.addText((t) => {
      t.inputEl.type = type;
      t.setPlaceholder(placeholder)
        .setValue(value)
        .onChange(async (v) => {
          const problem = check(v);
          message.setText(problem ?? '');
          t.inputEl.setAttr('aria-invalid', problem ? 'true' : 'false');
          if (problem) return;
          apply(v);
          await this.host.saveSettings();
        });
    });
  }
}
