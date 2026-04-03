import { App, Notice, PluginSettingTab, Setting } from "obsidian";

import { parseSessionJson } from "./chatgpt-api";
import { FolderSuggest } from "./folder-suggest";
import type Chats2MdPlugin from "./main";

export class Chats2MdSettingTab extends PluginSettingTab {
  private readonly plugin: Chats2MdPlugin;

  constructor(app: App, plugin: Chats2MdPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Default import folder")
      .setDesc("Full conversation logs are created in this vault folder by default.")
      .addText((component) => {
        component.setPlaceholder("Imports/ChatGPT");
        component.setValue(this.plugin.settings.defaultFolder);
        new FolderSuggest(this.app, component.inputEl);
        component.onChange(async (value) => {
          this.plugin.settings.defaultFolder = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Default conversation limit")
      .setDesc("The number of recent conversations requested when an import starts.")
      .addText((component) => {
        component.inputEl.type = "number";
        component.inputEl.min = "1";
        component.setValue(String(this.plugin.settings.defaultLimit));
        component.onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);

          if (Number.isFinite(parsed) && parsed > 0) {
            this.plugin.settings.defaultLimit = parsed;
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(containerEl)
      .setName("Session JSON")
      .setDesc("Paste the session JSON used for ChatGPT requests. It must include accessToken and account.id. Cookie is optional.")
      .addTextArea((component) => {
        component.inputEl.rows = 14;
        component.inputEl.addClass("chats2md-settings__textarea");
        component.setPlaceholder("{\n  \"accessToken\": \"...\",\n  \"account\": { \"id\": \"...\" },\n  \"cookie\": \"...\",\n  \"headers\": {\n    \"OAI-Session-Id\": \"...\"\n  }\n}");
        component.setValue(this.plugin.settings.sessionJson);
        component.onChange(async (value) => {
          this.plugin.settings.sessionJson = value;
          await this.plugin.saveSettings();
        });
      });

    const validationMessage = this.getSessionStatus();

    containerEl.createEl("p", {
      cls: "chats2md-settings__status",
      text: validationMessage
    });

    new Setting(containerEl)
      .setName("Validate session JSON")
      .setDesc("Checks whether the current settings value can be parsed into request credentials.")
      .addButton((button) => {
        button.setButtonText("Validate").onClick(() => {
          new Notice(this.getSessionStatus());
        });
      });
  }

  private getSessionStatus(): string {
    const raw = this.plugin.settings.sessionJson.trim();

    if (!raw) {
      return "Session JSON is not configured.";
    }

    try {
      const parsed = parseSessionJson(raw, this.plugin.manifest.version);
      return `Session JSON looks valid for account ${parsed.accountId}${parsed.expiresAt ? ` (expires ${parsed.expiresAt})` : ""}.`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
