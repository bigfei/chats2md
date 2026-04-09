import { App, Notice, PluginSettingTab, Setting } from "obsidian";

import {
  DEFAULT_SYNC_REPORT_FOLDER_TEMPLATE,
  formatAssetStorageMode,
  getStoredAccountDisplayName,
  normalizeDefaultLatestConversationCount,
} from "../main/helpers";
import { checkRequestConfigHealth, type AccountHealthResult } from "../main/account-health";
import { CONVERSATION_PATH_TEMPLATE_PRESETS } from "../path/template";
import { FolderSuggest } from "./folder-suggest";
import type Chats2MdPlugin from "../main";
import { SessionEditorModal } from "./session-editor-modal";
import { DEFAULT_SYNC_TUNING_SETTINGS } from "../shared/types";
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
              new Notice(
                result.removedPaths.length > 0
                  ? `Removed ${result.removedPaths.length} sync report/log file(s). Kept ${result.keptPaths.length}.`
                  : `No sync report/log files removed. ${result.keptPaths.length} file(s) kept.`,
              );
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
                new Notice(
                  result.removedPaths.length > 0
                    ? `Removed ${result.removedPaths.length} sync report/log file(s).`
                    : "No generated sync report/log files found to remove.",
                );
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
      })
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

    const accounts = this.plugin.getAccounts();

    if (accounts.length === 0) {
      containerEl.createEl("p", {
        cls: "chats2md-settings__status",
        text: "No account sessions configured.",
      });
    }

    for (const account of accounts) {
      new Setting(containerEl)
        .setName(`${getStoredAccountDisplayName(account)}${account.disabled ? " (Disabled)" : ""}`)
        .setDesc(this.describeAccount(account))
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
              new Notice(`Deleted account session for ${label}.`);
              this.display();
            });
        });
    }

    this.renderAdvancedSyncTuningSection(containerEl);
  }

  private describeAccount(account: StoredSessionAccount): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const lines = [
      `Status: ${account.disabled ? "Disabled" : "Enabled"}`,
      `User ID: ${account.userId || "Unavailable"}`,
      `Account ID: ${account.accountId}`,
      `Expires: ${account.expiresAt || "Unavailable"}`,
    ];

    if (account.lastHealthCheckAt) {
      lines.push(`Last health check: ${account.lastHealthCheckAt}`);
    }

    if (account.lastHealthCheckError) {
      lines.push(`Last health error: ${account.lastHealthCheckError}`);
    }

    lines.forEach((line, index) => {
      if (index > 0) {
        fragment.appendChild(document.createElement("br"));
      }

      fragment.append(line);
    });

    return fragment;
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

    this.addNumberSetting(sectionEl, {
      name: "Conversation-list parallel fetches",
      desc: `Default: ${DEFAULT_SYNC_TUNING_SETTINGS.conversationListFetchParallelism}. Number of conversation-list pages fetched in parallel.`,
      value: this.plugin.settings.syncTuning.conversationListFetchParallelism,
      placeholder: String(DEFAULT_SYNC_TUNING_SETTINGS.conversationListFetchParallelism),
      getValue: () => this.plugin.settings.syncTuning.conversationListFetchParallelism,
      onSave: async (value) => {
        this.plugin.settings.syncTuning.conversationListFetchParallelism = value;
        await this.plugin.saveSettings();
      },
    });

    this.addNumberSetting(sectionEl, {
      name: "Conversation-list retry attempts",
      desc: `Default: ${DEFAULT_SYNC_TUNING_SETTINGS.conversationListRetryAttempts}. Retries for failed conversation-list API calls.`,
      value: this.plugin.settings.syncTuning.conversationListRetryAttempts,
      placeholder: String(DEFAULT_SYNC_TUNING_SETTINGS.conversationListRetryAttempts),
      getValue: () => this.plugin.settings.syncTuning.conversationListRetryAttempts,
      onSave: async (value) => {
        this.plugin.settings.syncTuning.conversationListRetryAttempts = value;
        await this.plugin.saveSettings();
      },
    });

    this.addNumberSetting(sectionEl, {
      name: "Conversation-detail retry attempts",
      desc: `Default: ${DEFAULT_SYNC_TUNING_SETTINGS.conversationDetailRetryAttempts}. Retries for failed conversation-detail API calls.`,
      value: this.plugin.settings.syncTuning.conversationDetailRetryAttempts,
      placeholder: String(DEFAULT_SYNC_TUNING_SETTINGS.conversationDetailRetryAttempts),
      getValue: () => this.plugin.settings.syncTuning.conversationDetailRetryAttempts,
      onSave: async (value) => {
        this.plugin.settings.syncTuning.conversationDetailRetryAttempts = value;
        await this.plugin.saveSettings();
      },
    });

    this.addNumberSetting(sectionEl, {
      name: "Detail browse delay minimum (ms)",
      desc: `Default: ${DEFAULT_SYNC_TUNING_SETTINGS.conversationDetailBrowseDelayMinMs}. Lower bound for randomized wait before opening a conversation.`,
      value: this.plugin.settings.syncTuning.conversationDetailBrowseDelayMinMs,
      placeholder: String(DEFAULT_SYNC_TUNING_SETTINGS.conversationDetailBrowseDelayMinMs),
      getValue: () => this.plugin.settings.syncTuning.conversationDetailBrowseDelayMinMs,
      onSave: async (value) => {
        this.plugin.settings.syncTuning.conversationDetailBrowseDelayMinMs = value;
        await this.plugin.saveSettings();
      },
    });

    this.addNumberSetting(sectionEl, {
      name: "Detail browse delay maximum (ms)",
      desc: `Default: ${DEFAULT_SYNC_TUNING_SETTINGS.conversationDetailBrowseDelayMaxMs}. Upper bound for randomized wait before opening a conversation.`,
      value: this.plugin.settings.syncTuning.conversationDetailBrowseDelayMaxMs,
      placeholder: String(DEFAULT_SYNC_TUNING_SETTINGS.conversationDetailBrowseDelayMaxMs),
      getValue: () => this.plugin.settings.syncTuning.conversationDetailBrowseDelayMaxMs,
      onSave: async (value) => {
        this.plugin.settings.syncTuning.conversationDetailBrowseDelayMaxMs = value;
        await this.plugin.saveSettings();
      },
    });

    this.addNumberSetting(sectionEl, {
      name: "Pause after consecutive 429s",
      desc: `Default: ${DEFAULT_SYNC_TUNING_SETTINGS.maxConsecutiveRateLimitResponses}. Pause sync when ChatGPT keeps rate-limiting requests.`,
      value: this.plugin.settings.syncTuning.maxConsecutiveRateLimitResponses,
      placeholder: String(DEFAULT_SYNC_TUNING_SETTINGS.maxConsecutiveRateLimitResponses),
      getValue: () => this.plugin.settings.syncTuning.maxConsecutiveRateLimitResponses,
      onSave: async (value) => {
        this.plugin.settings.syncTuning.maxConsecutiveRateLimitResponses = value;
        await this.plugin.saveSettings();
      },
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
          this.plugin.settings.syncTuning.defaultLatestConversationCount = normalizeDefaultLatestConversationCount(value);
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
          const parsed = Number.parseInt(value.trim(), 10);
          await options.onSave(Number.isFinite(parsed) ? parsed : options.value);
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

    let healthyCount = 0;
    let disabledCount = 0;
    let transientCount = 0;

    for (const account of accounts) {
      const result = await this.plugin.checkAccountHealth(account);
      await this.plugin.updateAccountHealth(account.accountId, result);

      if (result.status === "healthy") {
        healthyCount += 1;
      } else if (result.status === "disable-and-skip") {
        disabledCount += 1;
      } else {
        transientCount += 1;
      }
    }

    new Notice(
      `Account health check complete. ${healthyCount} healthy, ${disabledCount} disabled, ${transientCount} transient issue(s).`,
    );
    this.display();
  }

  private async checkAccount(account: StoredSessionAccount): Promise<void> {
    const label = getStoredAccountDisplayName(account);
    const result = await this.plugin.checkAccountHealth(account);
    const updated = await this.plugin.updateAccountHealth(account.accountId, result);

    this.reportAccountHealth(label, account.accountId, result);
    if (updated) {
      this.display();
    }
  }

  private reportAccountHealth(label: string, accountId: string, result: AccountHealthResult): void {
    if (result.status === "healthy") {
      new Notice(`Account is healthy for ${label}.`);
      return;
    }

    const prefix =
      result.status === "disable-and-skip" ? `Account disabled for ${label}: ` : `Health check warning for ${label}: `;
    new Notice(`${prefix}${result.message}`);
    this.plugin.logError("Account health check issue", {
      accountId,
      status: result.status,
      message: result.message,
    });
  }
}
