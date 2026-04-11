import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";

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
import type { AssetStorageMode } from "../shared/types";
import type { StoredSessionAccount } from "../shared/types";
import {
  buildAccountDescriptionLines,
  CONVERSATION_PATH_TEMPLATE_DESCRIPTION_LINES,
  createAdvancedNumberSettingDefinitions,
  CUSTOM_TEMPLATE_OPTION,
  normalizeConversationPathTemplateInput,
  normalizeDefaultLatestConversationCountInput,
  normalizeSyncReportFolderInput,
  parseSettingsNumberInput,
  saveSettingIfChanged,
} from "./settings-helpers";
import {
  applyConversationTemplatePresetSelection,
  runCheckAccountAction,
  runCheckAllAccountsAction,
  runDeleteAccountSessionAction,
  runSaveSessionAction,
  runSyncReportCleanupAction,
} from "./settings-actions";

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

class ConfirmActionModal extends Modal {
  private readonly message: string;
  private readonly onResolve: (confirmed: boolean) => void;

  constructor(app: App, message: string, onResolve: (confirmed: boolean) => void) {
    super(app);
    this.message = message;
    this.onResolve = onResolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chats2md-modal");

    this.setTitle("Confirm action");
    contentEl.createEl("p", {
      cls: "chats2md-modal__status",
      text: this.message,
    });

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setWarning()
          .setButtonText("Confirm")
          .onClick(() => {
            this.resolve(true);
          });
      })
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => {
          this.resolve(false);
        });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private resolve(confirmed: boolean): void {
    this.onResolve(confirmed);
    this.close();
  }
}

function buildAccountSessionStatusLabel(healthResult?: AccountHealthResult): string | null {
  if (!healthResult) {
    return null;
  }

  return healthResult.status === "healthy" ? "Healthy" : "Needs attention";
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
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- Preserve ChatGPT brand casing in the default example path.
        component.setPlaceholder("Imports/ChatGPT");
        component.setValue(this.plugin.settings.defaultFolder);
        new FolderSuggest(this.app, component.inputEl);
        component.onChange(async (value) => {
          const nextValue = value.trim();
          await saveSettingIfChanged(this.plugin.settings.defaultFolder, nextValue, async (normalizedValue) => {
            this.plugin.settings.defaultFolder = normalizedValue;
            await this.plugin.saveSettings();
          });
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
            const nextValue: AssetStorageMode =
              value === "with_conversation" ? "with_conversation" : "global_by_conversation";
            const changed = await saveSettingIfChanged(
              this.plugin.settings.assetStorageMode,
              nextValue,
              async (mode) => {
                this.plugin.settings.assetStorageMode = mode;
                await this.plugin.saveSettings();
              },
            );

            if (changed) {
              new Notice(`Asset storage preset: ${formatAssetStorageMode(this.plugin.settings.assetStorageMode)}`);
            }
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
            await applyConversationTemplatePresetSelection(value, {
              setConversationPathTemplate: (nextValue) => {
                this.plugin.settings.conversationPathTemplate = nextValue;
              },
              saveSettings: () => this.plugin.saveSettings(),
              notice: (message) => new Notice(message),
              rerender: () => this.display(),
            });
          });
      })
      .addText((component) => {
        component.setPlaceholder("{date}/{slug}");
        component.setValue(this.plugin.settings.conversationPathTemplate);
        component.onChange(async (value) => {
          const nextValue = normalizeConversationPathTemplateInput(value);
          await saveSettingIfChanged(
            this.plugin.settings.conversationPathTemplate,
            nextValue,
            async (normalizedValue) => {
              this.plugin.settings.conversationPathTemplate = normalizedValue;
              await this.plugin.saveSettings();
            },
          );
        });
      });

    new Setting(containerEl)
      .setName("Enable debug logging")
      .setDesc("Log additional sync diagnostics in the developer console.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => {
          await saveSettingIfChanged(this.plugin.settings.debugLogging, value, async (nextValue) => {
            this.plugin.settings.debugLogging = nextValue;
            await this.plugin.saveSettings();
          });
        });
      });

    new Setting(containerEl).setName("Sync report").setHeading();

    new Setting(containerEl)
      .setName("Generate sync report")
      .setDesc("Write a Markdown report after each full sync run and cached-JSON rebuild.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.generateSyncReport).onChange(async (value) => {
          const changed = await saveSettingIfChanged(
            this.plugin.settings.generateSyncReport,
            value,
            async (nextValue) => {
              this.plugin.settings.generateSyncReport = nextValue;
              await this.plugin.saveSettings();
            },
          );
          if (changed) {
            this.display();
          }
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
            const nextValue = normalizeSyncReportFolderInput(value);
            await saveSettingIfChanged(this.plugin.settings.syncReportFolder, nextValue, async (normalizedValue) => {
              this.plugin.settings.syncReportFolder = normalizedValue;
              await this.plugin.saveSettings();
            });
          });
        });

      new Setting(containerEl)
        .setName("Clean sync reports and logs")
        .setDesc("Remove generated sync report Markdown and sync log files from the configured report folder.")
        .addButton((button) => {
          button.setButtonText("Keep latest 10").onClick((): void => {
            void runSyncReportCleanupAction({
              confirm: (message) => this.confirmAction(message),
              cleanupSyncReports: (options) =>
                this.plugin.cleanupSyncReports(this.plugin.settings.defaultFolder, options),
              keepLatest: 10,
              notice: (message) => new Notice(message),
              setDisabled: (disabled) => {
                button.setDisabled(disabled);
              },
            });
          });
        })
        .addButton((button) => {
          button
            .setWarning()
            .setButtonText("Clear all")
            .onClick((): void => {
              void runSyncReportCleanupAction({
                confirm: (message) => this.confirmAction(message),
                cleanupSyncReports: () => this.plugin.cleanupSyncReports(this.plugin.settings.defaultFolder),
                notice: (message) => new Notice(message),
                setDisabled: (disabled) => {
                  button.setDisabled(disabled);
                },
              });
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
          await saveSettingIfChanged(this.plugin.settings.saveConversationJson, value, async (nextValue) => {
            this.plugin.settings.saveConversationJson = nextValue;
            await this.plugin.saveSettings();
          });
        });
      });

    new Setting(containerEl)
      .setName("Rebuild Markdown from cached JSON")
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
      .setName("Manage account sessions")
      .setDesc(
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- Preserve ChatGPT brand casing.
        "Add one ChatGPT session payload per account. Payloads are validated before save and stored in Obsidian secret storage.",
      )
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
        .setClass("chats2md-settings__account-setting")
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
          button.setButtonText("Check health").onClick(async () => {
            button.setDisabled(true);

            try {
              await this.checkAccount(account);
            } finally {
              button.setDisabled(false);
            }
          });
        })
        .addButton((button) => {
          button.setButtonText("Edit").onClick(() => {
            this.openSessionEditor(account);
          });
        })
        .addButton((button) => {
          button
            .setWarning()
            .setButtonText("Delete")
            .onClick(() => {
              void runDeleteAccountSessionAction(account, {
                confirm: (message) => this.confirmAction(message),
                removeSessionAccount: (accountId) => this.plugin.removeSessionAccount(accountId),
                clearTransientHealthResult: (accountId) => this.transientHealthResults.delete(accountId),
                notice: (message) => new Notice(message),
                rerender: () => this.display(),
              });
            });
        });

      setting.settingEl.addClass("chats2md-settings__account");
      const headingEl = setting.nameEl.parentElement;
      if (headingEl) {
        const statusLabel = buildAccountSessionStatusLabel(healthResult);
        if (statusLabel) {
          headingEl.createSpan({
            cls: `chats2md-settings__account-badge ${isUnhealthy ? "is-warning" : "is-ok"}`,
            text: statusLabel,
          });
        }
      }
      if (isUnhealthy) {
        this.decorateUnhealthyAccountSetting(setting);
      }
    }

    new Setting(containerEl)
      .setName("Health checks")
      .setDesc(
        "Run transient health checks for all account sessions. Results stay in this settings pane until it closes.",
      )
      .addButton((button) => {
        button.setButtonText("Check all accounts").onClick(async () => {
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
      text: "Advanced sync tuning",
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
      .setDesc(
        "Default: blank = all discovered conversations. Prefills the newest conversations field in the sync subset modal.",
      )
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
          const nextValue = normalizeDefaultLatestConversationCountInput(value);
          const changed = await saveSettingIfChanged(
            this.plugin.settings.syncTuning.defaultLatestConversationCount,
            nextValue,
            async (normalizedValue) => {
              this.plugin.settings.syncTuning.defaultLatestConversationCount = normalizedValue;
              await this.plugin.saveSettings();
            },
          );
          if (changed) {
            component.setValue(
              this.plugin.settings.syncTuning.defaultLatestConversationCount === null
                ? ""
                : String(this.plugin.settings.syncTuning.defaultLatestConversationCount),
            );
          }
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
          const nextValue = parseSettingsNumberInput(value, options.value);
          const changed = await saveSettingIfChanged(options.getValue(), nextValue, options.onSave);
          if (changed) {
            component.setValue(String(options.getValue()));
          }
        });
      });
  }

  private openSessionEditor(account?: StoredSessionAccount): void {
    new SessionEditorModal(this.app, {
      title: account ? "Edit account session" : "Add account session",
      pluginVersion: this.plugin.manifest.version,
      hasExistingSecret: Boolean(account),
      onSave: async (raw, parsed) => {
        await runSaveSessionAction(raw, parsed, {
          checkRequestConfigHealth,
          upsertSessionAccount: (sessionRaw, requestConfig) =>
            this.plugin.upsertSessionAccount(sessionRaw, requestConfig),
          clearTransientHealthResult: (accountId) => this.transientHealthResults.delete(accountId),
          notice: (message) => new Notice(message),
          rerender: () => this.display(),
        });
      },
    }).open();
  }

  private async checkAllAccounts(): Promise<void> {
    await runCheckAllAccountsAction(this.plugin.getAccounts(), {
      checkAccountHealth: (account) => this.plugin.checkAccountHealth(account),
      setTransientHealthResult: (accountId, result) => this.transientHealthResults.set(accountId, result),
      notice: (message) => new Notice(message),
      rerender: () => this.display(),
    });
  }

  private async checkAccount(account: StoredSessionAccount): Promise<void> {
    await runCheckAccountAction(account, {
      checkAccountHealth: (currentAccount) => this.plugin.checkAccountHealth(currentAccount),
      setTransientHealthResult: (accountId, result) => this.transientHealthResults.set(accountId, result),
      notice: (message) => new Notice(message),
      rerender: () => this.display(),
      logError: (message, context) => this.plugin.logError(message, context),
    });
  }

  private confirmAction(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      new ConfirmActionModal(this.app, message, resolve).open();
    });
  }
}
