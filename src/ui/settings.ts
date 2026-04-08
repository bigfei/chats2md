import { App, Notice, PluginSettingTab, Setting } from "obsidian";

import { parseSessionJson, validateConversationListAccess } from "../chatgpt/api";
import {
  DEFAULT_SYNC_REPORT_FOLDER_TEMPLATE,
  formatAssetStorageMode,
  getStoredAccountDisplayName,
} from "../main/helpers";
import { CONVERSATION_PATH_TEMPLATE_PRESETS } from "../path/template";
import { FolderSuggest } from "./folder-suggest";
import type Chats2MdPlugin from "../main";
import { SessionEditorModal } from "./session-editor-modal";
import type { StoredSessionAccount } from "../shared/types";

const CUSTOM_TEMPLATE_OPTION = "__custom__";

function isKnownTemplatePreset(template: string): boolean {
  return CONVERSATION_PATH_TEMPLATE_PRESETS.includes(template as (typeof CONVERSATION_PATH_TEMPLATE_PRESETS)[number]);
}

function describeConversationPathTemplate(): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = [
    "Relative note path template, without .md.",
    "{date}: conversation created date (YYYY-MM-DD)",
    "{slug}: sanitized conversation title",
    "{email}: account email",
    "{account_id}: ChatGPT account ID",
    "{conversation_id}: ChatGPT conversation ID",
  ];

  lines.forEach((line, index) => {
    if (index > 0) {
      fragment.appendChild(document.createElement("br"));
    }

    fragment.append(line);
  });

  return fragment;
}

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
      .setName("Asset storage preset")
      .setDesc("Global: <default>/_assets/<account_id>. With conversation: <note-folder>/_assets.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("global_by_conversation", "Global by conversation")
          .addOption("with_conversation", "With conversation")
          .setValue(this.plugin.settings.assetStorageMode)
          .onChange(async (value) => {
            this.plugin.settings.assetStorageMode =
              value === "with_conversation" ? "with_conversation" : "global_by_conversation";
            await this.plugin.saveSettings();
            new Notice(`Asset storage preset: ${formatAssetStorageMode(this.plugin.settings.assetStorageMode)}`);
          });
      });

    new Setting(containerEl)
      .setName("Conversation path template")
      .setDesc(describeConversationPathTemplate())
      .addDropdown((dropdown) => {
        dropdown
          .addOption(CONVERSATION_PATH_TEMPLATE_PRESETS[0], CONVERSATION_PATH_TEMPLATE_PRESETS[0])
          .addOption(CONVERSATION_PATH_TEMPLATE_PRESETS[1], CONVERSATION_PATH_TEMPLATE_PRESETS[1])
          .addOption(CONVERSATION_PATH_TEMPLATE_PRESETS[2], CONVERSATION_PATH_TEMPLATE_PRESETS[2])
          .addOption(CUSTOM_TEMPLATE_OPTION, "Customize")
          .setValue(
            isKnownTemplatePreset(this.plugin.settings.conversationPathTemplate)
              ? this.plugin.settings.conversationPathTemplate
              : CUSTOM_TEMPLATE_OPTION,
          )
          .onChange(async (value) => {
            if (value === CUSTOM_TEMPLATE_OPTION) {
              return;
            }

            this.plugin.settings.conversationPathTemplate = value;
            await this.plugin.saveSettings();
            new Notice(`Applied conversation template: ${value}`);
            this.display();
          });
      })
      .addText((component) => {
        component.setPlaceholder("{date}/{slug}");
        component.setValue(this.plugin.settings.conversationPathTemplate);
        component.onChange(async (value) => {
          this.plugin.settings.conversationPathTemplate = value.trim() || "{date}/{slug}";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Enable debug logging")
      .setDesc("Log additional sync diagnostics in the developer console.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => {
          this.plugin.settings.debugLogging = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("Sync report").setHeading();

    new Setting(containerEl)
      .setName("Generate sync report")
      .setDesc("Write a markdown report after each full sync run and cached-JSON rebuild.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.generateSyncReport).onChange(async (value) => {
          this.plugin.settings.generateSyncReport = value;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    if (this.plugin.settings.generateSyncReport) {
      new Setting(containerEl)
        .setName("Sync report folder")
        .setDesc("Vault folder for reports. Supports <syncFolder> placeholder. Default: <syncFolder>/sync-result.")
        .addText((component) => {
          component.setPlaceholder(DEFAULT_SYNC_REPORT_FOLDER_TEMPLATE);
          component.setValue(this.plugin.settings.syncReportFolder);
          component.onChange(async (value) => {
            this.plugin.settings.syncReportFolder = value.trim() || DEFAULT_SYNC_REPORT_FOLDER_TEMPLATE;
            await this.plugin.saveSettings();
          });
        });
    }

    new Setting(containerEl).setName("Cached detail JSON").setHeading();

    new Setting(containerEl)
      .setName("Save conversation detail JSON sidecar")
      .setDesc(
        "Save raw /backend-api/conversation/{id} JSON next to each note as <note>.json whenever detail is fetched.",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.saveConversationJson).onChange(async (value) => {
          this.plugin.settings.saveConversationJson = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Rebuild markdown from cached JSON")
      .setDesc(
        "Rebuild existing synced notes from local sidecar JSON without calling /conversation/{id}. Missing sidecars are skipped.",
      )
      .addButton((button) => {
        button
          .setButtonText("Rebuild now")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.plugin.rebuildNotesFromCachedJson();
            } finally {
              button.setDisabled(false);
            }
          });
      });

    new Setting(containerEl).setName("Account sessions").setHeading();

    const migrationWarning = this.plugin.getLegacySessionMigrationWarning();

    if (migrationWarning) {
      containerEl.createEl("p", {
        cls: "chats2md-settings__warning",
        text: migrationWarning,
      });
    }

    new Setting(containerEl)
      .setName("Manage sessions")
      .setDesc("Add a session JSON payload per account. Payloads are stored in Obsidian Secret Storage.")
      .addButton((button) => {
        button
          .setButtonText("Add account")
          .setCta()
          .onClick(() => {
            this.openSessionEditor();
          });
      });

    const accounts = this.plugin.getAccounts();

    if (accounts.length === 0) {
      containerEl.createEl("p", {
        cls: "chats2md-settings__status",
        text: "No account sessions configured.",
      });
    }

    for (const account of accounts) {
      new Setting(containerEl)
        .setName(getStoredAccountDisplayName(account))
        .setDesc(this.describeAccount(account))
        .addButton((button) => {
          button
            .setButtonText("Validate")
            .onClick(async () => {
              button.setDisabled(true);

              try {
                await this.validateAccount(account);
              } finally {
                button.setDisabled(false);
              }
            });
        })
        .addButton((button) => {
          button
            .setButtonText("Edit")
            .onClick(() => {
              this.openSessionEditor(account);
            });
        })
        .addButton((button) => {
          button
            .setWarning()
            .setButtonText("Delete")
            .onClick(async () => {
              const label = getStoredAccountDisplayName(account);
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
  }

  private describeAccount(account: StoredSessionAccount): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const lines = [
      `User ID: ${account.userId || "Unavailable"}`,
      `Account ID: ${account.accountId}`,
      `Expires: ${account.expiresAt || "Unavailable"}`,
    ];

    lines.forEach((line, index) => {
      if (index > 0) {
        fragment.appendChild(document.createElement("br"));
      }

      fragment.append(line);
    });

    return fragment;
  }
  private openSessionEditor(account?: StoredSessionAccount): void {
    new SessionEditorModal(this.app, {
      title: account ? "Edit account session JSON" : "Add account session JSON",
      pluginVersion: this.plugin.manifest.version,
      hasExistingSecret: Boolean(account),
      onSave: async (raw, parsed) => {
        await validateConversationListAccess(parsed);
        const saved = await this.plugin.upsertSessionAccount(raw, parsed);
        const label = getStoredAccountDisplayName(saved);
        new Notice(`Saved session for ${label}.`);
        this.display();
      },
    }).open();
  }

  private async validateAccount(account: StoredSessionAccount): Promise<void> {
    const label = getStoredAccountDisplayName(account);
    const raw = this.plugin.getSessionSecret(account.secretId);

    if (!raw || raw.trim().length === 0) {
      new Notice(`Validation failed for ${label}: missing secret payload.`);
      return;
    }

    try {
      const parsed = parseSessionJson(raw, this.plugin.manifest.version);

      if (parsed.accountId !== account.accountId) {
        throw new Error(`secret account mismatch (${parsed.accountId})`);
      }

      await validateConversationListAccess(parsed);
      new Notice(`Session is valid for ${label}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Validation failed for ${label}: ${message}`);
      this.plugin.logError("Session validation error", {
        accountId: account.accountId,
        message,
      });
    }
  }
}
