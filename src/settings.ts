import {
  Notice,
  PluginSettingTab,
  requireApiVersion,
  SecretComponent,
  Setting,
  type App,
  type ButtonComponent,
  type Plugin,
  type SettingDefinition,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
} from 'obsidian';
import type { Settings } from './settings-core.ts';
import { savedText, settingRows, type SettingRow } from './settings-rows.ts';

export interface SettingsHost {
  settings: Settings;
  saveSettings(): Promise<void>;
  /** Removes the saved price files. */
  clearPrices(): Promise<void>;
  /** Switches the count of today's orders in the status bar on or off at once, as the setting says. */
  setOrdersBadge(on: boolean): void;
}

type Row = Exclude<SettingRow, { kind: 'heading' }>;
type ValueRow = Exclude<Row, { kind: 'clear-prices' }>;

export class BacktestSettingTab extends PluginSettingTab {
  // Only what the tab needs: through Plugin, `settings` would read as the API of Obsidian 1.13, newer than minAppVersion.
  private host: SettingsHost;

  constructor(app: App, plugin: Plugin & SettingsHost) {
    super(app, plugin);
    this.host = plugin;
  }

  /** The tab as Obsidian 1.13 and later draws it, and finds its settings in the search of the settings window. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const groups: SettingDefinitionGroup[] = [];
    for (const row of settingRows(this.host.settings)) {
      if (row.kind === 'heading') {
        groups.push({ type: 'group', heading: row.name, items: [] });
      } else {
        groups[groups.length - 1].items?.push(this.definition(row));
      }
    }
    return groups;
  }

  getControlValue(key: string): unknown {
    const value = this.host.settings[key as keyof Settings];
    // A number is shown in a text control (see definition).
    return typeof value === 'number' ? String(value) : value;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const row = settingRows(this.host.settings).find((r): r is ValueRow => 'key' in r && r.key === key);
    if (!row) return;
    const saved = row.kind === 'text' ? savedText(row, String(value)) : row.kind === 'number' ? Number(value) : row.kind === 'secret' ? (value ?? '') : value;
    await this.change(row, saved);
    // What the rows of the strategy writer say depends on its provider.
    if (key === 'llmProvider' && requireApiVersion('1.13.0')) this.update();
  }

  /** The tab drawn by hand, for Obsidian before 1.13. */
  display(): void {
    this.draw();
  }

  private draw(): void {
    const { containerEl } = this;
    const settings = this.host.settings;
    containerEl.empty();
    for (const row of settingRows(settings)) {
      const setting = new Setting(containerEl).setName(row.name);
      if (row.kind === 'heading') {
        setting.setHeading();
        continue;
      }
      setting.setDesc(row.desc);
      switch (row.kind) {
        case 'text':
        case 'number':
          this.field(setting, row, String(settings[row.key]));
          break;
        case 'dropdown':
          setting.addDropdown((d) =>
            d
              .addOptions(row.options)
              .setValue(settings[row.key])
              .onChange(async (v) => {
                await this.change(row, v);
                if (row.key === 'llmProvider') this.draw();
              }),
          );
          break;
        case 'toggle':
          setting.addToggle((t) => t.setValue(settings[row.key]).onChange((v) => this.change(row, v)));
          break;
        case 'secret':
          setting.addComponent((el) => new SecretComponent(this.app, el).setValue(settings[row.key]).onChange((name) => this.change(row, name ?? '')));
          break;
        case 'clear-prices':
          setting.addButton((b) => this.clearPricesButton(b));
          break;
      }
    }
  }

  private definition(row: Row): SettingDefinition {
    const { name, desc } = row;
    switch (row.kind) {
      case 'text':
        return { name, desc, control: { type: 'text', key: row.key, placeholder: row.placeholder, validate: (v) => row.check?.(v) ?? undefined } };
      case 'number':
        // A text control, not a number one: Obsidian's number control saves only when the field loses focus, and shows
        // no message for a value it does not save.
        return { name, desc, control: { type: 'text', key: row.key, placeholder: row.placeholder, validate: (v) => row.check(v) ?? undefined } };
      case 'dropdown':
        return { name, desc, control: { type: 'dropdown', key: row.key, options: row.options } };
      case 'toggle':
        return { name, desc, control: { type: 'toggle', key: row.key } };
      case 'secret':
        return { name, desc, control: { type: 'secret', key: row.key } };
      case 'clear-prices':
        return {
          name,
          desc,
          render: (setting) => {
            setting.addButton((b) => this.clearPricesButton(b));
          },
        };
    }
  }

  /** Saves a value the user gave, with what follows from it. */
  private async change(row: ValueRow, value: unknown): Promise<void> {
    (this.host.settings as unknown as Record<string, unknown>)[row.key] = value;
    if (row.key === 'ordersOnStartup') this.host.setOrdersBadge(value === true);
    await this.host.saveSettings();
  }

  /**
   * A text row drawn by hand. A value that fails its check shows its message under the description and is not applied
   * or saved; the field keeps what was typed.
   */
  private field(setting: Setting, row: Extract<Row, { kind: 'text' | 'number' }>, value: string): void {
    const message = setting.descEl.createDiv({ cls: 'bt-setting-error' });
    setting.addText((t) => {
      if (row.kind === 'number') t.inputEl.type = 'number';
      t.setPlaceholder(row.placeholder)
        .setValue(value)
        .onChange(async (v) => {
          const problem = row.check?.(v) ?? null;
          message.setText(problem ?? '');
          t.inputEl.setAttr('aria-invalid', problem ? 'true' : 'false');
          if (problem) return;
          await this.change(row, row.kind === 'number' ? Number(v) : savedText(row, v));
        });
    });
  }

  private clearPricesButton(b: ButtonComponent): void {
    b.setButtonText('Delete saved prices').onClick(async () => {
      b.setDisabled(true);
      try {
        await this.host.clearPrices();
        b.setButtonText('Deleted');
        window.setTimeout(() => {
          b.setButtonText('Delete saved prices').setDisabled(false);
        }, 2000);
      } catch (e) {
        b.setDisabled(false);
        new Notice(`Cannot delete the saved prices: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }
}
