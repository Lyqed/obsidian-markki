import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';

export interface SimpleAnkiSyncSettings {
  defaultDeck: string;
  llmProvider: 'openai' | 'anthropic';
  llmApiBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  autoDeckEnabled: boolean;
  deckSpecificity: number;
}

export const DEFAULT_SETTINGS: SimpleAnkiSyncSettings = {
  defaultDeck: 'Default',
  llmProvider: 'openai',
  llmApiBaseUrl: 'https://api.openai.com/v1',
  llmApiKey: '',
  llmModel: 'gpt-4o',
  autoDeckEnabled: false,
  deckSpecificity: 3,
};

export interface SettingsHost {
  settings: SimpleAnkiSyncSettings;
  saveSettings(): Promise<void>;
}

export class SimpleAnkiSyncSettingTab extends PluginSettingTab {
  private plugin: SettingsHost & Plugin;

  constructor(app: App, plugin: SettingsHost & Plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Simple Anki Sync' });

    // --- Anki ---
    containerEl.createEl('h3', { text: 'Anki' });

    new Setting(containerEl)
      .setName('Default deck')
      .setDesc('Deck used when no deck is specified in the card marker.')
      .addText((text) =>
        text
          .setPlaceholder('Default')
          .setValue(this.plugin.settings.defaultDeck)
          .onChange(async (value) => {
            this.plugin.settings.defaultDeck = value || 'Default';
            await this.plugin.saveSettings();
          })
      );

    // --- LLM ---
    containerEl.createEl('h3', { text: 'AI / LLM' });

    new Setting(containerEl)
      .setName('Provider')
      .setDesc('AI provider used to generate flashcards.')
      .addDropdown((drop) =>
        drop
          .addOption('openai', 'OpenAI / Compatible API')
          .addOption('anthropic', 'Anthropic (Claude)')
          .setValue(this.plugin.settings.llmProvider)
          .onChange(async (value: string) => {
            this.plugin.settings.llmProvider = value as 'openai' | 'anthropic';
            if (value === 'anthropic' && !this.plugin.settings.llmModel.startsWith('claude')) {
              this.plugin.settings.llmModel = 'claude-haiku-4-5-20251001';
            } else if (value === 'openai' && this.plugin.settings.llmModel.startsWith('claude')) {
              this.plugin.settings.llmModel = 'gpt-4o';
            }
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.llmProvider === 'openai') {
      new Setting(containerEl)
        .setName('API base URL')
        .setDesc('Base URL for OpenAI-compatible APIs. Change to use local models (Ollama, LM Studio, etc.).')
        .addText((text) =>
          text
            .setPlaceholder('https://api.openai.com/v1')
            .setValue(this.plugin.settings.llmApiBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.llmApiBaseUrl = value;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName('API key')
      .setDesc('Your API key for the selected provider.')
      .addText((text) => {
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.llmApiKey)
          .onChange(async (value) => {
            this.plugin.settings.llmApiKey = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName('Model')
      .setDesc('Model to use for card generation.')
      .addText((text) =>
        text
          .setPlaceholder(
            this.plugin.settings.llmProvider === 'anthropic'
              ? 'claude-haiku-4-5-20251001'
              : 'gpt-4o'
          )
          .setValue(this.plugin.settings.llmModel)
          .onChange(async (value) => {
            this.plugin.settings.llmModel = value;
            await this.plugin.saveSettings();
          })
      );

    // --- Deck selection ---
    containerEl.createEl('h3', { text: 'Deck selection' });

    new Setting(containerEl)
      .setName('Auto-detect or create deck')
      .setDesc(
        'When enabled, the AI picks or creates the best deck for each card. ' +
        'The default deck is ignored unless you explicitly set deck="Name" in the marker.'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoDeckEnabled)
          .onChange(async (value) => {
            this.plugin.settings.autoDeckEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.autoDeckEnabled) {
      new Setting(containerEl)
        .setName('Deck specificity')
        .setDesc(
          '1 = very broad (reuse any existing deck)  ·  5 = very specific (always create a new narrowly-named deck).'
        )
        .addSlider((slider) =>
          slider
            .setLimits(1, 5, 1)
            .setValue(this.plugin.settings.deckSpecificity)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.deckSpecificity = value;
              await this.plugin.saveSettings();
            })
        );
    }

    // --- Marker usage tip ---
    containerEl.createEl('h3', { text: 'Usage' });
    const tip = containerEl.createEl('p');
    tip.setText(
      'Mark any bullet point as an Anki card using the command "Mark bullet as Anki card" (assignable to a hotkey), ' +
      'or type <!-- anki --> at the end of the line manually. ' +
      'Cards are synced automatically 15 seconds after you stop editing. ' +
      'Remove the marker to delete the card from Anki.'
    );
    tip.style.color = 'var(--text-muted)';
    tip.style.fontSize = '0.9em';
  }
}
