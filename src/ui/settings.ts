import { App, Notice, PluginSettingTab, Setting } from "obsidian";

import {
  DEFAULT_SYNC_REPORT_FOLDER_TEMPLATE,
  formatAssetStorageMode,
  getStoredAccountDisplayName,
} from "../main/helpers";
import {
  checkRequestConfigHealth,
  isAccountHealthResultUnhealthy,
  type AccountHealthResult,
} from "../main/account-health";
import { CONVERSATION_PATH_TEMPLATE_PRESETS } from "../path/template";
import { FolderSuggest } from "./folder-suggest";
import type Chats2MdPlugin from "../main";
import { SessionEditorModal } from "./session-editor-modal";
import { DEFAULT_SYNC_TUNING_SETTINGS } from "../shared/types";
import type { StoredSessionAccount } from "../shared/types";
import {
  buildAccountDescriptionLines,
  buildSyncReportCleanupNotice,
  CONVERSATION_PATH_TEMPLATE_DESCRIPTION_LINES,
  createAdvancedNumberSettingDefinitions,
  CUSTOM_TEMPLATE_OPTION,
  normalizeConversationPathTemplateInput,
  normalizeDefaultLatestConversationCountInput,
  normalizeSyncReportFolderInput,
  parseSettingsNumberInput,
  summarizeAccountHealthResults,
} from "./settings-helpers";

function isKnownTemplatePreset(template: string): boolean {
  return CONVERSATION_PATH_TEMPLATE_PRESETS.includes(template as (typeof CONVERSATION_PATH_TEMPLATE_PRESETS)[number]);
}

function buildMultilineDescription(lines: string[]): DocumentFragment {
  const fragment = document.createDocumentFragment();

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
  private readonly transientHealthResults = new Map<string, AccountHealthResult>();

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
      .setDesc(buildMultilineDescription(CONVERSATION_PATH_TEMPLATE_DESCRIPTION_LINES))
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
          this.plugin.settings.conversationPathTemplate = normalizeConversationPathTemplateInput(value);
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
            this.plugin.settings.syncReportFolder = normalizeSyncReportFolderInput(value);
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("Clean sync reports and logs")
        .setDesc("Remove generated sync report markdown and sync log files from the configured report folder.")
        .addButton((button) => {
          button.setButtonText("Keep latest 10").onClick(async () => {
            const confirmed = window.confirm("Delete older generated sync reports/logs and keep only the latest 10 files?");
            if (!confirmed) {
              return;
            }

            button.setDisabled(true);
            try {
              const result = await this.plugin.cleanupSyncReports(this.plugin.settings.defaultFolder, {
                keepLatest: 10,
              });
              new Notice(buildSyncReportCleanupNotice(result, 10));
            } finally {
              button.setDisabled(false);
            }
          });
        })
        .addButton((button) => {
          button
            .setWarning()
            .setButtonText("Clear all")
            .onClick(async () => {
              const confirmed = window.confirm("Delete all generated sync report and sync log files from the configured report folder?");
              if (!confirmed) {
                return;
              }

              button.setDisabled(true);
              try {
                const result = await this.plugin.cleanupSyncReports(this.plugin.settings.defaultFolder);
                new Notice(buildSyncReportCleanupNotice(result));
              } finally {
                button.setDisabled(false);
              }
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
      const healthResult = this.transientHealthResults.get(account.accountId);
      const isUnhealthy = healthResult ? isAccountHealthResultUnhealthy(healthResult) : false;
      const setting = new Setting(containerEl)
        .setName(getStoredAccountDisplayName(account))
        .setDesc(this.describeAccount(account, healthResult))
        .addToggle((toggle) => {
          toggle.setValue(!account.disabled).onChange(async (value) => {
            toggle.setDisabled(true);

            try {
              await this.plugin.setAccountDisabled(account.accountId, !value);
              this.transientHealthResults.delete(account.accountId);
              this.display();
            } finally {
              toggle.setDisabled(false);
            }
          });
        })
        .addButton((button) => {
          button
            .setButtonText("Check health")
            .onClick(async () => {
              button.setDisabled(true);

              try {
                await this.checkAccount(account);
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
              this.transientHealthResults.delete(account.accountId);
              new Notice(`Deleted account session for ${label}.`);
              this.display();
            });
        });

      setting.settingEl.addClass("chats2md-settings__account");
      if (isUnhealthy) {
        this.decorateUnhealthyAccountSetting(setting);
      }
    }

    new Setting(containerEl)
      .setName("Health checks")
      .setDesc("Run transient health checks for all accounts. Results are shown only in this settings pane.")
      .addButton((button) => {
        button
          .setButtonText("Check all accounts")
          .onClick(async () => {
            button.setDisabled(true);

            try {
              await this.checkAllAccounts();
            } finally {
              button.setDisabled(false);
            }
          });
      });

    this.renderAdvancedSyncTuningSection(containerEl);
  }

  private decorateUnhealthyAccountSetting(setting: Setting): void {
    const markerEl = document.createElement("span");
    markerEl.className = "chats2md-settings__account-warning-marker";
    markerEl.setAttribute("aria-label", "Unhealthy account");
    markerEl.setAttribute("title", "Most recent health check reported this account as unhealthy.");
    markerEl.textContent = "!";

    setting.settingEl.addClass("chats2md-settings__account--unhealthy");
    setting.settingEl.prepend(markerEl);
  }

  private describeAccount(account: StoredSessionAccount, healthResult?: AccountHealthResult): DocumentFragment {
    return buildMultilineDescription(buildAccountDescriptionLines(account, healthResult));
  }

  private renderAdvancedSyncTuningSection(containerEl: HTMLElement): void {
    const detailsEl = containerEl.createEl("details", {
      cls: "chats2md-settings__advanced",
    });
    detailsEl.open = false;

    detailsEl.createEl("summary", {
      cls: "chats2md-settings__advanced-summary",
      text: "Advanced Sync Tuning",
    });

    detailsEl.createEl("p", {
      cls: "chats2md-settings__advanced-desc",
      text: "Power-user sync controls. Changes apply to future sync runs immediately.",
    });

    const sectionEl = detailsEl.createDiv({
      cls: "chats2md-settings__advanced-body",
    });

    createAdvancedNumberSettingDefinitions(DEFAULT_SYNC_TUNING_SETTINGS).forEach((definition) => {
      this.addNumberSetting(sectionEl, {
        name: definition.name,
        desc: definition.desc,
        value: this.plugin.settings.syncTuning[definition.key],
        placeholder: definition.placeholder,
        getValue: () => this.plugin.settings.syncTuning[definition.key],
        onSave: async (value) => {
          this.plugin.settings.syncTuning[definition.key] = value;
          await this.plugin.saveSettings();
        },
      });
    });

    new Setting(sectionEl)
      .setName("Default newest conversations count")
      .setDesc("Default: blank = all discovered conversations. Prefills the Newest conversations field in the sync subset modal.")
      .addText((component) => {
        component.inputEl.type = "number";
        component.inputEl.min = "1";
        component.setPlaceholder("All discovered");
        component.setValue(
          this.plugin.settings.syncTuning.defaultLatestConversationCount === null
            ? ""
            : String(this.plugin.settings.syncTuning.defaultLatestConversationCount),
        );
        component.onChange(async (value) => {
          this.plugin.settings.syncTuning.defaultLatestConversationCount =
            normalizeDefaultLatestConversationCountInput(value);
          await this.plugin.saveSettings();
          component.setValue(
            this.plugin.settings.syncTuning.defaultLatestConversationCount === null
              ? ""
              : String(this.plugin.settings.syncTuning.defaultLatestConversationCount),
          );
        });
      });
  }

  private addNumberSetting(
    containerEl: HTMLElement,
    options: {
      name: string;
      desc: string;
      value: number;
      placeholder: string;
      getValue: () => number;
      onSave: (value: number) => Promise<void>;
    },
  ): void {
    new Setting(containerEl)
      .setName(options.name)
      .setDesc(options.desc)
      .addText((component) => {
        component.inputEl.type = "number";
        component.inputEl.min = "0";
        component.setPlaceholder(options.placeholder);
        component.setValue(String(options.value));
        component.onChange(async (value) => {
          await options.onSave(parseSettingsNumberInput(value, options.value));
          component.setValue(String(options.getValue()));
        });
      });
  }

  private openSessionEditor(account?: StoredSessionAccount): void {
    new SessionEditorModal(this.app, {
      title: account ? "Edit account session JSON" : "Add account session JSON",
      pluginVersion: this.plugin.manifest.version,
      hasExistingSecret: Boolean(account),
      onSave: async (raw, parsed) => {
        const result = await checkRequestConfigHealth(parsed);

        if (result.status !== "healthy") {
          throw new Error(result.message);
        }

        const saved = await this.plugin.upsertSessionAccount(raw, parsed);
        this.transientHealthResults.delete(saved.accountId);
        const label = getStoredAccountDisplayName(saved);
        new Notice(`Saved session for ${label}.`);
        this.display();
      },
    }).open();
  }

  private async checkAllAccounts(): Promise<void> {
    const accounts = this.plugin.getAccounts();

    if (accounts.length === 0) {
      new Notice("No account sessions configured.");
      return;
    }

    for (const account of accounts) {
      const result = await this.plugin.checkAccountHealth(account);
      this.transientHealthResults.set(account.accountId, result);
    }

    new Notice(summarizeAccountHealthResults(this.transientHealthResults.values()).notice);
    this.display();
  }

  private async checkAccount(account: StoredSessionAccount): Promise<void> {
    const label = getStoredAccountDisplayName(account);
    const result = await this.plugin.checkAccountHealth(account);
    this.transientHealthResults.set(account.accountId, result);
    this.reportAccountHealth(label, account.accountId, result);
    this.display();
  }

  private reportAccountHealth(label: string, accountId: string, result: AccountHealthResult): void {
    if (result.status === "healthy") {
      new Notice(`Account is healthy for ${label}.`);
      return;
    }

    new Notice(`Health check warning for ${label}: ${result.message}`);
    this.plugin.logError("Account health check issue", {
      accountId,
      status: result.status,
      message: result.message,
    });
  }
}
