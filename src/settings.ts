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
    this.field('Start capital', 'The plugin uses this value when a strategy has no capital line.', String(settings.capital), '10000', (v) => {
      const n = Number(v);
      return v.trim() !== '' && Number.isFinite(n) && n > 0 ? null : 'Type a number that is more than 0.';
    }, (v) => (settings.capital = Number(v)), 'number');
    this.field('Costs per trade', 'The plugin uses this value when a strategy has no costs line. For example: 5 bps.', settings.costs, '0 bps', (v) => validateSetting('costs', v), (v) => (settings.costs = v.trim()));
    this.field('Slippage per fill', 'Each fill is worse than the price by this value. For example: 5 bps.', settings.slippage, '0 bps', (v) => validateSetting('slippage', v), (v) => (settings.slippage = v.trim()));
    this.field(
      'Commission per order',
      'The plugin uses this value when a strategy has no commission line. The plugin adds it to the costs. For example: 1 (a fee of 1 for each order), or 0.005 per share, min 1. Type 0 for no commission.',
      settings.commission,
      '0',
      (v) => validateSetting('commission', v),
      (v) => (settings.commission = v.trim()),
    );
    this.field(
      'Interest on cash',
      'A rate, for example 4%. Or a ticker with a price that is a yield, for example ^IRX. A cash rate line in a strategy overrides this value.',
      settings.cashRate,
      '0%',
      (v) => validateSetting('cashRate', v),
      (v) => (settings.cashRate = v.trim()),
    );
    this.field(
      'Borrow fee for shorts',
      'A yearly fee on the value of each short position, for example 0.5%. A borrow fee line in a strategy overrides this value.',
      settings.borrowFee,
      '0.5%',
      (v) => validateSetting('borrowFee', v),
      (v) => (settings.borrowFee = v.trim()),
    );
    this.field(
      'Interest on borrowed money',
      'A yearly rate on the money that a strategy borrows when it holds more than its equity, for example 6%. A margin rate line in a strategy overrides this value.',
      settings.marginRate,
      '6%',
      (v) => validateSetting('marginRate', v),
      (v) => (settings.marginRate = v.trim()),
    );
    new Setting(containerEl)
      .setName('Price source for tickers without a prefix')
      .setDesc('The service for tickers that you write without a prefix (for example binance:). For Tiingo, you must also set the "Tiingo API key" setting.')
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
      `The plugin downloads saved prices again after this number of hours, from ${CACHE_HOURS_MIN} to ${CACHE_HOURS_MAX}.`,
      String(settings.cacheHours),
      '6',
      (v) => {
        const n = Number(v);
        return v.trim() !== '' && Number.isInteger(n) && n >= CACHE_HOURS_MIN && n <= CACHE_HOURS_MAX ? null : `Type a number of hours from ${CACHE_HOURS_MIN} to ${CACHE_HOURS_MAX}, with no decimals.`;
      },
      (v) => (settings.cacheHours = Number(v)),
      'number',
    );
    new Setting(containerEl)
      .setName('Saved prices')
      .setDesc('Delete all the price files that the plugin saved.')
      .addButton((b) =>
        b.setButtonText('Delete saved prices').onClick(async () => {
          b.setDisabled(true);
          try {
            await this.host.clearPrices();
            b.setButtonText('Deleted');
            window.setTimeout(() => b.setButtonText('Delete saved prices').setDisabled(false), 2000);
          } catch (e) {
            b.setDisabled(false);
            new Notice(`Cannot delete the saved prices: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      );
    const stored = 'Select or add a secret in the Obsidian keychain. The plugin saves only the name of the secret.';
    new Setting(containerEl)
      .setName('Tiingo API key')
      .setDesc(`The plugin uses this key for tiingo: tickers, data: tiingo and the setting "Use Tiingo when Yahoo is not available". ${stored} The plugin sends the key to api.tiingo.com in a request header.`)
      .addComponent((el) =>
        new SecretComponent(this.app, el).setValue(settings.tiingoSecret).onChange(async (name) => {
          settings.tiingoSecret = name ?? '';
          await this.host.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('FRED API key')
      .setDesc(`The plugin uses this key for fred: series. ${stored} The plugin sends the key in the URL of each request to api.stlouisfed.org, because FRED accepts the key only there.`)
      .addComponent((el) =>
        new SecretComponent(this.app, el).setValue(settings.fredSecret).onChange(async (name) => {
          settings.fredSecret = name ?? '';
          await this.host.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('Use Tiingo when Yahoo is not available')
      .setDesc(
        'This setting applies when the plugin cannot download a US ticker from Yahoo and has no saved copy from the last 3 days. Then the plugin downloads the ticker from Tiingo. The result tells you this. Tickers that start with ^ or end with a suffix (for example .L, -USD or =X) are not included. You must also set the Tiingo API key.',
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
        'After the strategies in a note run, the plugin saves their primary figures to the properties of the note. A Base can then show them in a list. The plugin controls all properties that start with bt_. It updates them, and removes the bt_ properties that no strategy in the note makes. This setting changes your notes.',
      )
      .addToggle((t) =>
        t.setValue(settings.writeProperties).onChange(async (v) => {
          settings.writeProperties = v;
          await this.host.saveSettings();
        }),
      );
    this.field(
      'Note for today’s orders',
      'The vault path of the note for the orders, for example Trading/Orders.md. The plugin writes the full note again each time you save. The plugin replaces a note at this path only if the plugin made that note. Keep this field empty for no note.',
      settings.ordersNote,
      'Trading/Orders.md',
      () => null,
      (v) => (settings.ordersNote = v.trim()),
    );
    this.field('Folder for saved results', 'The vault folder for saved results.', settings.snapshotFolder, 'Backtests', () => null, (v) => (settings.snapshotFolder = v.trim() || 'Backtests'));

    new Setting(containerEl).setName('Results and editor').setHeading();
    new Setting(containerEl)
      .setName('Result view')
      .setDesc('Full shows all of each result. Compact shows one line for each strategy. Click the line to open the result. Compact is good for a note with many strategies.')
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
      .setName('Find orders when Obsidian starts')
      .setDesc('After Obsidian starts, the plugin runs all strategies in the vault. Then the status bar shows the number of orders for today. For this, the plugin downloads the prices of the tickers in each strategy. When you set this to off, the plugin removes the count and stops the runs immediately.')
      .addToggle((t) =>
        t.setValue(settings.ordersOnStartup).onChange(async (v) => {
          settings.ordersOnStartup = v;
          this.host.setOrdersBadge(v);
          await this.host.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('Find tickers while you type')
      .setDesc(
        'Shows tickers for the text that you type, and identifies unknown tickers. The plugin sends the text that you type in the position of a ticker to Yahoo. It also sends the Yahoo tickers in the strategy blocks on the screen. It sends one ticker at a time. It does not send text that starts with binance:, csv:, tiingo: or fred:. It does not send the tickers of a block that uses Tiingo for its prices. The plugin downloads the list of Binance markets, and sends no text that you type. The plugin sends nothing more from your notes.',
      )
      .addToggle((t) =>
        t.setValue(settings.tickerLookup).onChange(async (v) => {
          settings.tickerLookup = v;
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl).setName('Strategies from a description').setDesc(DRAFT_PRIVACY).setHeading();
    new Setting(containerEl)
      .setName('Provider')
      .setDesc('The service that writes a strategy from your description.')
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
