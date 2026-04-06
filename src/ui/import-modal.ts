import { App, Modal, Notice, Setting } from "obsidian";

import { formatAssetStorageMode } from "../main/helpers";
import { toIsoUtcDate } from "../sync/date-range";
import type {
  ConversationSyncDateRangePromptContext,
  ConversationSyncDateRangeSelection,
  ImportFailure,
  ImportProgressCounts,
  StoredSessionAccount,
  SyncModalValues,
} from "../shared/types";

export interface SyncProgressReporter {
  setPreparing(message: string): void;
  setRetry(title: string, index: number, total: number, attempt: number, message: string): void;
  setProgress(title: string, index: number, total: number, processed: number, counts: ImportProgressCounts): void;
  selectDateRange(context: ConversationSyncDateRangePromptContext): Promise<ConversationSyncDateRangeSelection>;
  complete(total: number, counts: ImportProgressCounts, failures: ImportFailure[]): void;
  fail(message: string, counts: ImportProgressCounts): void;
  log(message: string): void;
}

export interface SyncExecutionControl {
  waitIfPaused(): Promise<void>;
  shouldStop(): boolean;
}

interface SyncModalOptions {
  folder: string;
  conversationPathTemplate: string;
  assetStorageMode: SyncModalValues["assetStorageMode"];
  defaultConversationListLatestLimit: number;
  accounts: StoredSessionAccount[];
  onSubmit: (values: SyncModalValues, progress: SyncProgressReporter, control: SyncExecutionControl) => Promise<void>;
  onSyncDialogHidden?: (reason: "minimize" | "close") => void;
}

function formatCounts(counts: ImportProgressCounts): string {
  return [
    `Created: ${counts.created}`,
    `Updated: ${counts.updated}`,
    `Moved: ${counts.moved}`,
    `Skipped: ${counts.skipped}`,
    `Failed: ${counts.failed}`,
  ].join(" | ");
}

function createEmptyCounts(): ImportProgressCounts {
  return {
    created: 0,
    updated: 0,
    moved: 0,
    skipped: 0,
    failed: 0,
  };
}

const MAX_SYNC_DETAIL_LINES = 500;

function parseIsoDateInput(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }

  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString().slice(0, 10) === date ? parsed : null;
}

function parsePositiveIntegerInput(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

interface SyncDateRangeModalOptions {
  context: ConversationSyncDateRangePromptContext;
  onResolve(selection: ConversationSyncDateRangeSelection): void;
}

class SyncDateRangeModal extends Modal {
  private readonly options: SyncDateRangeModalOptions;
  private readonly fullStartDate: string;
  private readonly fullEndDate: string;
  private startDate: string;
  private endDate: string;
  private resolved = false;

  constructor(app: App, options: SyncDateRangeModalOptions) {
    super(app);
    this.options = options;
    const fallbackDate = new Date().toISOString().slice(0, 10);
    const minDate = toIsoUtcDate(options.context.minUpdatedAt) ?? fallbackDate;
    const maxDate = toIsoUtcDate(options.context.maxUpdatedAt) ?? minDate;

    if (minDate <= maxDate) {
      this.fullStartDate = minDate;
      this.fullEndDate = maxDate;
    } else {
      this.fullStartDate = maxDate;
      this.fullEndDate = minDate;
    }

    this.startDate = this.fullStartDate;
    this.endDate = this.fullEndDate;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chats2md-modal");
    contentEl.addClass("chats2md-date-range-modal");

    this.setTitle(`Choose sync subset (${this.options.context.accountLabel})`);

    contentEl.createEl("p", {
      cls: "chats2md-modal__status",
      text: `Found ${this.options.context.discoveredCount} conversations spanning more than 30 days.`,
    });
    contentEl.createEl("p", {
      cls: "chats2md-modal__hint",
      text: `updated_at range: ${this.fullStartDate} to ${this.fullEndDate}.`,
    });
    contentEl.createEl("p", {
      cls: "chats2md-modal__hint",
      text: "Choose an updated_at date range, or keep the full discovered range.",
    });

    new Setting(contentEl)
      .setName("Start date")
      .setDesc("Inclusive lower bound, based on updated_at.")
      .addText((component) => {
        component.inputEl.type = "date";
        component.inputEl.min = this.fullStartDate;
        component.inputEl.max = this.fullEndDate;
        component.setValue(this.startDate);
        component.onChange((value) => {
          this.startDate = value.trim();
        });
      });

    new Setting(contentEl)
      .setName("End date")
      .setDesc("Inclusive upper bound, based on updated_at.")
      .addText((component) => {
        component.inputEl.type = "date";
        component.inputEl.min = this.fullStartDate;
        component.inputEl.max = this.fullEndDate;
        component.setValue(this.endDate);
        component.onChange((value) => {
          this.endDate = value.trim();
        });
      });

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("Continue")
          .setCta()
          .onClick(() => {
            this.submit();
          });
      })
      .addButton((button) => {
        button.setButtonText("Skip account").onClick(() => {
          this.resolve({ mode: "skip-account" });
        });
      });
  }

  onClose(): void {
    if (!this.resolved) {
      this.resolve({ mode: "skip-account" }, false);
    }

    this.contentEl.empty();
  }

  private submit(): void {
    const normalizedStartDate = this.startDate;
    const normalizedEndDate = this.endDate;
    const startMs = parseIsoDateInput(normalizedStartDate);
    const endMs = parseIsoDateInput(normalizedEndDate);
    const fullStartMs = parseIsoDateInput(this.fullStartDate);
    const fullEndMs = parseIsoDateInput(this.fullEndDate);

    if (startMs === null || endMs === null || fullStartMs === null || fullEndMs === null) {
      new Notice("Date range must use YYYY-MM-DD.");
      return;
    }

    if (startMs > endMs) {
      new Notice("Start date must be before or equal to end date.");
      return;
    }

    if (startMs < fullStartMs || endMs > fullEndMs) {
      new Notice(`Date range must stay within ${this.fullStartDate} to ${this.fullEndDate}.`);
      return;
    }

    if (normalizedStartDate === this.fullStartDate && normalizedEndDate === this.fullEndDate) {
      this.resolve({ mode: "all" });
      return;
    }

    this.resolve({
      mode: "range",
      startDate: normalizedStartDate,
      endDate: normalizedEndDate,
    });
  }

  private resolve(selection: ConversationSyncDateRangeSelection, shouldClose = true): void {
    if (this.resolved) {
      return;
    }

    this.resolved = true;
    this.options.onResolve(selection);

    if (shouldClose) {
      this.close();
    }
  }
}

function openSyncDateRangeModal(
  app: App,
  context: ConversationSyncDateRangePromptContext,
): Promise<ConversationSyncDateRangeSelection> {
  return new Promise((resolve) => {
    new SyncDateRangeModal(app, {
      context,
      onResolve: resolve,
    }).open();
  });
}

export class SyncChatGptModal extends Modal implements SyncProgressReporter, SyncExecutionControl {
  private readonly options: SyncModalOptions;
  private syncScope: "all" | "single" = "all";
  private selectedAccountId: string;
  private forceRefresh = false;
  private fetchFullConversationList = false;
  private conversationLimitOverride = "";
  private readonly accountSelectorContainer: HTMLDivElement;

  private statusEl: HTMLElement | null = null;
  private countsEl: HTMLElement | null = null;
  private detailEl: HTMLDivElement | null = null;
  private progressEl: HTMLProgressElement | null = null;
  private pauseButton: HTMLButtonElement | null = null;

  private activeStatusText = "Preparing sync...";
  private latestCounts: ImportProgressCounts = createEmptyCounts();
  private detailLines: string[] = [];
  private progressValue = 0;
  private isSyncing = false;
  private isPaused = false;
  private stopRequested = false;
  private closeReason: "minimize" | "close" = "close";
  private pauseWaiters: Array<() => void> = [];

  constructor(app: App, options: SyncModalOptions) {
    super(app);
    this.options = options;
    this.selectedAccountId = options.accounts[0]?.accountId ?? "";
    this.accountSelectorContainer = this.contentEl.createDiv();
  }

  onOpen(): void {
    if (this.isSyncing) {
      this.renderProgressView();
      return;
    }

    this.renderSetupView();
  }

  onClose(): void {
    if (this.isSyncing) {
      if (this.closeReason === "close") {
        this.stopRequested = true;
      }

      this.options.onSyncDialogHidden?.(this.closeReason);
    }

    this.closeReason = "close";
    this.isPaused = false;
    this.releasePauseWaiters();
    this.pauseButton = null;
    this.statusEl = null;
    this.countsEl = null;
    this.detailEl = null;
    this.progressEl = null;
    this.contentEl.empty();
  }

  isSyncInProgress(): boolean {
    return this.isSyncing;
  }

  waitIfPaused(): Promise<void> {
    if (!this.isPaused || this.stopRequested) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.pauseWaiters.push(resolve);
    });
  }

  shouldStop(): boolean {
    return this.stopRequested;
  }

  setPreparing(message: string): void {
    this.activeStatusText = message;
    this.setProgressValue(0);
    this.applyStatusText();
  }

  setRetry(title: string, index: number, total: number, attempt: number, message: string): void {
    this.activeStatusText = `Retry ${title} (${index}/${total}) attempt ${attempt}/3`;
    this.applyStatusText();
    this.appendDetail(`${title}: ${message}`);
  }

  setProgress(title: string, index: number, total: number, processed: number, counts: ImportProgressCounts): void {
    this.activeStatusText = `Sync ${title} (${index}/${total})`;
    this.latestCounts = { ...counts };
    this.setProgressValue(total === 0 ? 0 : Math.round((processed / total) * 100));
    this.countsEl?.setText(formatCounts(this.latestCounts));
    this.applyStatusText();
  }

  async selectDateRange(context: ConversationSyncDateRangePromptContext): Promise<ConversationSyncDateRangeSelection> {
    return openSyncDateRangeModal(this.app, context);
  }

  complete(total: number, counts: ImportProgressCounts, failures: ImportFailure[]): void {
    const successCount = total - counts.failed;
    this.latestCounts = { ...counts };
    this.activeStatusText = `Finished sync. ${successCount}/${total} conversations processed.`;
    this.setProgressValue(100);
    this.countsEl?.setText(formatCounts(this.latestCounts));

    if (failures.length > 0) {
      this.appendDetail("Failures:");

      for (const failure of failures) {
        this.appendDetail(`${failure.title} (${failure.id}) after ${failure.attempts} attempts: ${failure.message}`);
      }
    }

    this.finishSync();
    this.applyStatusText();
  }

  fail(message: string, counts: ImportProgressCounts): void {
    this.latestCounts = { ...counts };
    this.activeStatusText = message;
    this.countsEl?.setText(formatCounts(this.latestCounts));
    this.appendDetail(message);
    this.finishSync();
    this.applyStatusText();
  }

  log(message: string): void {
    this.appendDetail(message);
  }

  private renderSetupView(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chats2md-modal");
    const isFullConversationListMode = this.fetchFullConversationList;
    const fetchListModeDescription = isFullConversationListMode
      ? "Full-history mode for this run. Fetches complete conversation list history from API."
      : "Latest-window mode for this run. Reads per-account cache and fetches only recent list pages.";
    const conversationLimitSettingName = isFullConversationListMode
      ? "Latest cache window override"
      : "Latest conversation limit override";
    const conversationLimitSettingDescription = isFullConversationListMode
      ? `Optional one-time override for refreshed latest-window cache size after full-list fetch. ` +
        `Does not limit full-history discovery/sync. Default: ${this.options.defaultConversationListLatestLimit}.`
      : `Optional one-time override for latest-window discovery and sync scope. ` +
        `Default: ${this.options.defaultConversationListLatestLimit}.`;
    const modeHintText = isFullConversationListMode
      ? "Mode: full-history discovery. Date-range chooser may appear when updated_at span exceeds 30 days."
      : "Mode: latest-window discovery (cache-aware). Date-range chooser is skipped in this mode.";

    this.setTitle("Sync ChatGPT conversations");

    contentEl.createEl("p", {
      cls: "chats2md-modal__status",
      text: "Sync settings are configured from the plugin settings tab.",
    });

    const summaryList = contentEl.createEl("ul", {
      cls: "chats2md-modal__summary",
    });

    summaryList.createEl("li", {
      text: `Folder: ${this.options.folder}`,
    });
    summaryList.createEl("li", {
      text: `Layout template: ${this.options.conversationPathTemplate}`,
    });
    summaryList.createEl("li", {
      text: `Asset storage: ${formatAssetStorageMode(this.options.assetStorageMode)}`,
    });
    summaryList.createEl("li", {
      text: `Default latest conversation limit: ${this.options.defaultConversationListLatestLimit}`,
    });
    summaryList.createEl("li", {
      text: `Configured accounts: ${this.options.accounts.length}`,
    });

    if (this.options.accounts.length === 0) {
      contentEl.createEl("p", {
        cls: "chats2md-modal__hint",
        text: "No accounts configured. Add at least one session in plugin settings.",
      });

      new Setting(contentEl).addButton((button) => {
        button
          .setButtonText("Close")
          .setCta()
          .onClick(() => this.close());
      });
      return;
    }

    new Setting(contentEl)
      .setName("Sync scope")
      .setDesc("Choose whether to sync all configured accounts or just one account.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("all", "All accounts")
          .addOption("single", "Single account")
          .setValue(this.syncScope)
          .onChange((value) => {
            this.syncScope = value === "single" ? "single" : "all";
            this.renderAccountSelector();
          });
      });

    new Setting(contentEl)
      .setName("Force refresh")
      .setDesc("Always fetch details and rewrite notes even when updated_at matches local metadata.")
      .addToggle((toggle) => {
        toggle.setValue(this.forceRefresh).onChange((value) => {
          this.forceRefresh = value;
        });
      });

    new Setting(contentEl)
      .setName("Fetch full conversation list")
      .setDesc(fetchListModeDescription)
      .addToggle((toggle) => {
        toggle.setValue(this.fetchFullConversationList).onChange((value) => {
          this.fetchFullConversationList = value;
          this.renderSetupView();
        });
      });

    new Setting(contentEl)
      .setName(conversationLimitSettingName)
      .setDesc(conversationLimitSettingDescription)
      .addText((component) => {
        component.inputEl.type = "number";
        component.inputEl.min = "1";
        component.setPlaceholder(String(this.options.defaultConversationListLatestLimit));
        component.setValue(this.conversationLimitOverride);
        component.onChange((value) => {
          this.conversationLimitOverride = value.trim();
        });
      });

    this.accountSelectorContainer.remove();
    contentEl.appendChild(this.accountSelectorContainer);
    this.renderAccountSelector();

    contentEl.createEl("p", {
      cls: "chats2md-modal__hint",
      text: modeHintText,
    });

    contentEl.createEl("p", {
      cls: "chats2md-modal__hint",
      text: "Continue to sync selected ChatGPT conversations into markdown notes.",
    });

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("Continue")
          .setCta()
          .onClick(async () => {
            if (this.syncScope === "single" && !this.selectedAccountId) {
              new Notice("Select an account to continue.");
              return;
            }

            const conversationLimitOverride = this.resolveConversationLimitOverride();
            if (conversationLimitOverride === null) {
              new Notice("Latest conversation limit override must be a positive whole number.");
              return;
            }

            button.setDisabled(true);

            const values: SyncModalValues = {
              folder: this.options.folder,
              conversationPathTemplate: this.options.conversationPathTemplate,
              assetStorageMode: this.options.assetStorageMode,
              scope: this.syncScope,
              accountId: this.syncScope === "single" ? this.selectedAccountId : undefined,
              forceRefresh: this.forceRefresh,
              fetchFullConversationList: this.fetchFullConversationList,
              conversationLimitOverride: conversationLimitOverride ?? undefined,
            };

            try {
              await this.startSync(values);
            } finally {
              button.setDisabled(false);
            }
          });
      })
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => this.close());
      });
  }

  private renderAccountSelector(): void {
    this.accountSelectorContainer.empty();

    if (this.syncScope !== "single") {
      this.accountSelectorContainer.createEl("p", {
        cls: "chats2md-modal__hint",
        text: "All configured accounts will be synced sequentially.",
      });
      return;
    }

    new Setting(this.accountSelectorContainer)
      .setName("Account")
      .setDesc("Choose one account to sync.")
      .addDropdown((dropdown) => {
        for (const account of this.options.accounts) {
          const label = account.email.trim().length > 0 ? `${account.email} (${account.accountId})` : account.accountId;
          dropdown.addOption(account.accountId, label);
        }

        const fallbackAccountId = this.options.accounts[0]?.accountId ?? "";
        if (
          !this.selectedAccountId ||
          !this.options.accounts.some((account) => account.accountId === this.selectedAccountId)
        ) {
          this.selectedAccountId = fallbackAccountId;
        }

        dropdown.setValue(this.selectedAccountId).onChange((value) => {
          this.selectedAccountId = value;
        });
      });
  }

  private resolveConversationLimitOverride(): number | null | undefined {
    if (this.conversationLimitOverride.length === 0) {
      return undefined;
    }

    return parsePositiveIntegerInput(this.conversationLimitOverride);
  }

  private async startSync(values: SyncModalValues): Promise<void> {
    this.isSyncing = true;
    this.isPaused = false;
    this.stopRequested = false;
    this.latestCounts = createEmptyCounts();
    this.detailLines = [];
    this.progressValue = 0;
    this.activeStatusText = "Preparing sync...";

    this.renderProgressView();
    this.log("Sync started.");

    try {
      await this.options.onSubmit(values, this, this);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail(message, this.latestCounts);
      new Notice(message);
    }
  }

  private renderProgressView(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chats2md-modal");
    contentEl.addClass("chats2md-progress-modal");

    this.setTitle("Sync ChatGPT conversations");

    this.statusEl = contentEl.createEl("p", {
      cls: "chats2md-modal__status",
    });

    const progressWrapper = contentEl.createDiv({
      cls: "chats2md-progress-modal__bar",
    });
    this.progressEl = progressWrapper.createEl("progress");
    this.progressEl.max = 100;
    this.progressEl.value = this.progressValue;

    this.countsEl = contentEl.createEl("p", {
      cls: "chats2md-progress-modal__counts",
      text: formatCounts(this.latestCounts),
    });

    this.detailEl = contentEl.createDiv({
      cls: "chats2md-progress-modal__details",
    });

    for (const line of this.detailLines) {
      this.detailEl.createEl("p", { text: line });
    }
    this.detailEl.scrollTop = this.detailEl.scrollHeight;

    new Setting(contentEl)
      .addButton((button) => {
        button.onClick(() => this.togglePause());
        this.pauseButton = button.buttonEl;
      })
      .addButton((button) => {
        button.setButtonText("Minimize").onClick(() => this.minimize());
      })
      .addButton((button) => {
        button.setButtonText("Close").onClick(() => this.closeWithReason("close"));
      });

    this.updatePauseButton();
    this.applyStatusText();
  }

  private togglePause(): void {
    if (!this.isSyncing) {
      return;
    }

    this.isPaused = !this.isPaused;

    if (this.isPaused) {
      this.log("Paused by user.");
    } else {
      this.log("Resumed by user.");
      this.releasePauseWaiters();
    }

    this.updatePauseButton();
    this.applyStatusText();
  }

  private minimize(): void {
    if (!this.isSyncing) {
      return;
    }

    this.closeWithReason("minimize");
  }

  private closeWithReason(reason: "minimize" | "close"): void {
    this.closeReason = reason;
    this.close();
  }

  private finishSync(): void {
    this.isSyncing = false;
    this.isPaused = false;
    this.stopRequested = false;
    this.updatePauseButton();
    this.releasePauseWaiters();
  }

  private updatePauseButton(): void {
    if (!this.pauseButton) {
      return;
    }

    this.pauseButton.disabled = !this.isSyncing;
    this.pauseButton.setText(this.isPaused ? "Resume" : "Pause");
  }

  private setProgressValue(value: number): void {
    this.progressValue = Math.max(0, Math.min(100, value));

    if (this.progressEl) {
      this.progressEl.value = this.progressValue;
    }
  }

  private appendDetail(text: string): void {
    this.detailLines.push(text);
    if (this.detailLines.length > MAX_SYNC_DETAIL_LINES) {
      this.detailLines.splice(0, this.detailLines.length - MAX_SYNC_DETAIL_LINES);
    }

    if (!this.detailEl) {
      return;
    }

    this.detailEl.createEl("p", { text });
    while (this.detailEl.childElementCount > MAX_SYNC_DETAIL_LINES) {
      this.detailEl.firstElementChild?.remove();
    }
    this.detailEl.scrollTop = this.detailEl.scrollHeight;
  }

  private applyStatusText(): void {
    if (!this.statusEl) {
      return;
    }

    if (this.isPaused && this.isSyncing) {
      this.statusEl.setText(`Paused. ${this.activeStatusText}`);
      return;
    }

    this.statusEl.setText(this.activeStatusText);
  }

  private releasePauseWaiters(): void {
    for (const resolve of this.pauseWaiters) {
      resolve();
    }

    this.pauseWaiters = [];
  }
}
