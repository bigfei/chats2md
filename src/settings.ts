import { App, Notice, PluginSettingTab, Setting } from "obsidian";

import { parseSessionJson, validateConversationListAccess } from "./chatgpt-api";
import { CONVERSATION_PATH_TEMPLATE_PRESETS } from "./path-template";
import { FolderSuggest } from "./folder-suggest";
import type Chats2MdPlugin from "./main";
import { SessionEditorModal } from "./session-editor-modal";
import type { StoredSessionAccount } from "./types";

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
      .setName("Default sync folder")
      .setDesc("Conversation logs are synced into this vault folder by default.")
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
      .setName("Conversation path template")
      .setDesc("Relative note path template (without .md). Placeholders: {date}, {slug}, {email}, {account_id}, {conversation_id}.")
      .addText((component) => {
        component.setPlaceholder("{date}/{slug}");
        component.setValue(this.plugin.settings.conversationPathTemplate);
        component.onChange(async (value) => {
          this.plugin.settings.conversationPathTemplate = value.trim() || "{date}/{slug}";
          await this.plugin.saveSettings();
        });
      });

    let selectedPreset = "";
    new Setting(containerEl)
      .setName("Path template presets")
      .setDesc("Apply one of the common folder layouts.")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "Select preset...");
        for (const preset of CONVERSATION_PATH_TEMPLATE_PRESETS) {
          dropdown.addOption(preset, preset);
        }
        dropdown.setValue(selectedPreset).onChange((value) => {
          selectedPreset = value;
        });
      })
      .addButton((button) => {
        button.setButtonText("Apply").onClick(async () => {
          if (!selectedPreset) {
            new Notice("Select a template preset first.");
            return;
          }

          this.plugin.settings.conversationPathTemplate = selectedPreset;
          await this.plugin.saveSettings();
          new Notice(`Applied conversation template: ${selectedPreset}`);
          this.display();
        });
      });

    containerEl.createEl("h3", {
      text: "Account sessions"
    });

    const migrationWarning = this.plugin.getLegacySessionMigrationWarning();

    if (migrationWarning) {
      containerEl.createEl("p", {
        cls: "chats2md-settings__warning",
        text: migrationWarning
      });
    }

    new Setting(containerEl)
      .setName("Manage sessions")
      .setDesc("Add a session JSON payload per account. Payloads are stored in Obsidian Secret Storage.")
      .addButton((button) => {
        button.setButtonText("Add account").setCta().onClick(() => {
          this.openSessionEditor();
        });
      });

    const accounts = this.plugin.getAccounts();

    if (accounts.length === 0) {
      containerEl.createEl("p", {
        cls: "chats2md-settings__status",
        text: "No account sessions configured."
      });
    }

    for (const account of accounts) {
      new Setting(containerEl)
        .setName(account.email.trim().length > 0 ? account.email : account.accountId)
        .setDesc(this.describeAccount(account))
        .addButton((button) => {
          button.setButtonText("Edit").onClick(() => {
            this.openSessionEditor(account);
          });
        })
        .addButton((button) => {
          button.setButtonText("Delete").setWarning().onClick(async () => {
            const label = account.email.trim().length > 0 ? account.email : account.accountId;
            const confirmed = window.confirm(`Delete account session for ${label}?`);

            if (!confirmed) {
              return;
            }

            await this.plugin.removeSessionAccount(account.accountId);
            new Notice(`Deleted account session for ${label}.`);
            this.display();
          });
        });
    }

    new Setting(containerEl)
      .setName("Validate sessions")
      .setDesc("Checks whether stored sessions can be parsed and call the conversation list API.")
      .addButton((button) => {
        button.setButtonText("Validate").onClick(async () => {
          button.setDisabled(true);

          try {
            await this.validateSessions();
          } finally {
            button.setDisabled(false);
          }
        });
      });
  }

  private describeAccount(account: StoredSessionAccount): string {
    return [
      `User ID: ${account.userId || "Unavailable"}`,
      `Email: ${account.email || "Unavailable"}`,
      `Account ID: ${account.accountId}`,
      `Expires: ${account.expiresAt || "Unavailable"}`
    ].join(" | ");
  }

  private openSessionEditor(account?: StoredSessionAccount): void {
    const initialValue = account ? (this.plugin.getSessionSecret(account.secretId) ?? "") : "";

    new SessionEditorModal(this.app, {
      title: account ? "Edit account session JSON" : "Add account session JSON",
      pluginVersion: this.plugin.manifest.version,
      initialValue,
      onSave: async (raw, parsed) => {
        await validateConversationListAccess(parsed);
        const saved = await this.plugin.upsertSessionAccount(raw, parsed);
        const label = saved.email.trim().length > 0 ? saved.email : saved.accountId;
        new Notice(`Saved session for ${label}.`);
        this.display();
      }
    }).open();
  }

  private async validateSessions(): Promise<void> {
    const accounts = this.plugin.getAccounts();

    if (accounts.length === 0) {
      new Notice("No account sessions configured.");
      return;
    }

    let validCount = 0;
    const errors: string[] = [];

    for (const account of accounts) {
      const raw = this.plugin.getSessionSecret(account.secretId);

      if (!raw || raw.trim().length === 0) {
        errors.push(`${account.accountId}: missing secret payload`);
        continue;
      }

      try {
        const parsed = parseSessionJson(raw, this.plugin.manifest.version);

        if (parsed.accountId !== account.accountId) {
          errors.push(`${account.accountId}: secret account mismatch (${parsed.accountId})`);
          continue;
        }

        await validateConversationListAccess(parsed);
        validCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${account.accountId}: ${message}`);
      }
    }

    if (errors.length === 0) {
      new Notice(`All ${validCount} account sessions are valid.`);
      return;
    }

    new Notice(`Validated ${validCount}/${accounts.length} accounts. Check console for details.`);
    // Keep full failure details available for debugging without overflowing Notice UI.
    console.error("[chats2md] Session validation errors", errors);
  }
}
