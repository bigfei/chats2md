import { App, Modal, Notice, Setting } from "obsidian";

import { formatAssetStorageMode } from "../main/helpers";
import { isSyncCancelledError } from "../sync/cancellation";
import { toIsoUtcDate } from "../sync/date-range";
import { getConversationSyncSubsetFieldState, type ConversationSyncSubsetMode } from "./sync-subset";
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
  getStopSignal(): AbortSignal;
}

interface SyncModalOptions {
  folder: string;
  conversationPathTemplate: string;
  assetStorageMode: SyncModalValues["assetStorageMode"];
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

function formatAccountLabel(account: StoredSessionAccount): string {
  return account.email.trim().length > 0 ? `${account.email} (${account.accountId})` : account.accountId;
}

interface SyncDateRangeModalOptions {
  context: ConversationSyncDateRangePromptContext;
  onResolve(selection: ConversationSyncDateRangeSelection): void;
}

class SyncDateRangeModal extends Modal {
  private readonly options: SyncDateRangeModalOptions;
  private readonly fullStartDate: string;
  private readonly fullEndDate: string;
  private filterMode: ConversationSyncSubsetMode = "all";
  private startDate: string;
  private endDate: string;
  private latestCount: string;
  private startDateSetting: Setting | null = null;
  private endDateSetting: Setting | null = null;
  private latestCountSetting: Setting | null = null;
  private startDateInput: HTMLInputElement | null = null;
  private endDateInput: HTMLInputElement | null = null;
  private latestCountInput: HTMLInputElement | null = null;
  private resolved = false;

  constructor(app: App, options: SyncDateRangeModalOptions) {
    super(app);
    this.options = options;
    const fallbackDate = new Date().toISOString().slice(0, 10);
    const minDate = toIsoUtcDate(options.context.minCreatedAt) ?? fallbackDate;
    const maxDate = toIsoUtcDate(options.context.maxCreatedAt) ?? minDate;

    if (minDate <= maxDate) {
      this.fullStartDate = minDate;
      this.fullEndDate = maxDate;
    } else {
      this.fullStartDate = maxDate;
      this.fullEndDate = minDate;
    }

    this.startDate = this.fullStartDate;
    this.endDate = this.fullEndDate;
    this.latestCount = String(options.context.discoveredCount);
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
      text: `created_at range: ${this.fullStartDate} to ${this.fullEndDate}.`,
    });
    contentEl.createEl("p", {
      cls: "chats2md-modal__hint",
      text: "Choose one subset mode. created_at date range and latest N are mutually exclusive.",
    });

    new Setting(contentEl)
      .setName("Subset mode")
      .setDesc("Choose which part of the discovered list to sync.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("all", "Full discovered range")
          .addOption("range", "Created_at date range")
          .addOption("latest-count", "Latest N by created_at")
          .setValue(this.filterMode)
          .onChange((value) => {
            this.filterMode = value === "range" || value === "latest-count" ? value : "all";
            this.updateSubsetInputVisibility();
          });
      });

    this.startDateSetting = new Setting(contentEl)
      .setName("Start date")
      .setDesc("Inclusive lower bound, based on created_at.")
      .addText((component) => {
        component.inputEl.type = "date";
        component.inputEl.min = this.fullStartDate;
        component.inputEl.max = this.fullEndDate;
        this.startDateInput = component.inputEl;
        component.setValue(this.startDate);
        component.onChange((value) => {
          this.startDate = value.trim();
        });
      });

    this.latestCountSetting = new Setting(contentEl)
      .setName("Latest conversation count")
      .setDesc("Sync only the newest N conversations by created_at.")
      .addText((component) => {
        component.inputEl.type = "number";
        component.inputEl.min = "1";
        this.latestCountInput = component.inputEl;
        component.setValue(this.latestCount);
        component.onChange((value) => {
          this.latestCount = value.trim();
        });
      });

    this.endDateSetting = new Setting(contentEl)
      .setName("End date")
      .setDesc("Inclusive upper bound, based on created_at.")
      .addText((component) => {
        component.inputEl.type = "date";
        component.inputEl.min = this.fullStartDate;
        component.inputEl.max = this.fullEndDate;
        this.endDateInput = component.inputEl;
        component.setValue(this.endDate);
        component.onChange((value) => {
          this.endDate = value.trim();
        });
      });

    this.updateSubsetInputVisibility();

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
    if (this.filterMode === "all") {
      this.resolve({ mode: "all" });
      return;
    }

    if (this.filterMode === "latest-count") {
      const count = parsePositiveIntegerInput(this.latestCount);
      if (count === null) {
        new Notice("Latest conversation count must be a positive whole number.");
        return;
      }

      if (count >= this.options.context.discoveredCount) {
        this.resolve({ mode: "all" });
        return;
      }

      this.resolve({
        mode: "latest-count",
        count,
      });
      return;
    }

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

  private updateSubsetInputVisibility(): void {
    const fieldState = getConversationSyncSubsetFieldState(this.filterMode);
    this.setSettingVisible(this.startDateSetting, fieldState.showDateRange);
    this.setSettingVisible(this.endDateSetting, fieldState.showDateRange);
    this.setSettingVisible(this.latestCountSetting, fieldState.showLatestCount);

    if (this.startDateInput) {
      this.startDateInput.disabled = !fieldState.showDateRange;
    }

    if (this.endDateInput) {
      this.endDateInput.disabled = !fieldState.showDateRange;
    }

    if (this.latestCountInput) {
      this.latestCountInput.disabled = !fieldState.showLatestCount;
    }
  }

  private setSettingVisible(setting: Setting | null, isVisible: boolean): void {
    if (!setting) {
      return;
    }

    setting.settingEl.style.display = isVisible ? "" : "none";
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
  private stopController: AbortController | null = null;

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
        this.stopController?.abort("Sync stopped by user.");
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
    return this.stopRequested || this.stopController?.signal.aborted === true;
  }

  getStopSignal(): AbortSignal {
    if (!this.stopController) {
      this.stopController = new AbortController();
    }

    return this.stopController.signal;
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
            this.renderSetupView();
          });
      });

    this.accountSelectorContainer.remove();
    contentEl.appendChild(this.accountSelectorContainer);
    this.renderAccountSelector();

    contentEl.createEl("p", {
      cls: "chats2md-modal__hint",
      text: "Mode: full conversation-list discovery. Results are ordered locally by created_at (newest first).",
    });

    contentEl.createEl("p", {
      cls: "chats2md-modal__hint",
      text: "Conversation-list pages are fetched in parallel. Conversation detail sync runs one conversation at a time.",
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

            button.setDisabled(true);

            const values: SyncModalValues = {
              folder: this.options.folder,
              conversationPathTemplate: this.options.conversationPathTemplate,
              assetStorageMode: this.options.assetStorageMode,
              scope: this.syncScope,
              accountId: this.syncScope === "single" ? this.selectedAccountId : undefined,
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
          const label = formatAccountLabel(account);
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
          this.renderSetupView();
        });
      });
  }

  async startSync(values: SyncModalValues): Promise<void> {
    this.isSyncing = true;
    this.isPaused = false;
    this.stopRequested = false;
    this.stopController = new AbortController();
    this.latestCounts = createEmptyCounts();
    this.detailLines = [];
    this.progressValue = 0;
    this.activeStatusText = "Preparing sync...";

    this.renderProgressView();
    this.log("Sync started.");

    try {
      await this.options.onSubmit(values, this, this);
    } catch (error) {
      if (isSyncCancelledError(error) || this.shouldStop()) {
        this.fail("Sync stopped by user.", this.latestCounts);
        return;
      }

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
    this.stopController = null;
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
