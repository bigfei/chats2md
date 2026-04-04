import { App, Modal, Notice, Setting } from "obsidian";

import type { ImportFailure, ImportProgressCounts, StoredSessionAccount, SyncModalValues } from "./types";

export interface SyncProgressReporter {
  setPreparing(message: string): void;
  setRetry(title: string, index: number, total: number, attempt: number, message: string): void;
  setProgress(title: string, index: number, total: number, processed: number, counts: ImportProgressCounts): void;
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
    `Failed: ${counts.failed}`
  ].join(" | ");
}

function createEmptyCounts(): ImportProgressCounts {
  return {
    created: 0,
    updated: 0,
    moved: 0,
    skipped: 0,
    failed: 0
  };
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

  setProgress(
    title: string,
    index: number,
    total: number,
    processed: number,
    counts: ImportProgressCounts
  ): void {
    this.activeStatusText = `Sync ${title} (${index}/${total})`;
    this.latestCounts = { ...counts };
    this.setProgressValue(total === 0 ? 0 : Math.round((processed / total) * 100));
    this.countsEl?.setText(formatCounts(this.latestCounts));
    this.applyStatusText();
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
      text: "Sync settings are configured from the plugin settings tab."
    });

    const summaryList = contentEl.createEl("ul", {
      cls: "chats2md-modal__summary"
    });

    summaryList.createEl("li", {
      text: `Folder: ${this.options.folder}`
    });
    summaryList.createEl("li", {
      text: `Configured accounts: ${this.options.accounts.length}`
    });

    if (this.options.accounts.length === 0) {
      contentEl.createEl("p", {
        cls: "chats2md-modal__hint",
        text: "No accounts configured. Add at least one session in plugin settings."
      });

      new Setting(contentEl).addButton((button) => {
        button.setButtonText("Close").setCta().onClick(() => this.close());
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

    this.accountSelectorContainer.remove();
    contentEl.appendChild(this.accountSelectorContainer);
    this.renderAccountSelector();

    contentEl.createEl("p", {
      cls: "chats2md-modal__hint",
      text: "Continue to sync full conversation logs into markdown notes."
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
              scope: this.syncScope,
              accountId: this.syncScope === "single" ? this.selectedAccountId : undefined
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
        text: "All configured accounts will be synced sequentially."
      });
      return;
    }

    new Setting(this.accountSelectorContainer)
      .setName("Account")
      .setDesc("Choose one account to sync.")
      .addDropdown((dropdown) => {
        for (const account of this.options.accounts) {
          const label = account.email.trim().length > 0
            ? `${account.email} (${account.accountId})`
            : account.accountId;
          dropdown.addOption(account.accountId, label);
        }

        const fallbackAccountId = this.options.accounts[0]?.accountId ?? "";
        if (!this.selectedAccountId || !this.options.accounts.some((account) => account.accountId === this.selectedAccountId)) {
          this.selectedAccountId = fallbackAccountId;
        }

        dropdown
          .setValue(this.selectedAccountId)
          .onChange((value) => {
            this.selectedAccountId = value;
          });
      });
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
      cls: "chats2md-modal__status"
    });

    const progressWrapper = contentEl.createDiv({
      cls: "chats2md-progress-modal__bar"
    });
    this.progressEl = progressWrapper.createEl("progress");
    this.progressEl.max = 100;
    this.progressEl.value = this.progressValue;

    this.countsEl = contentEl.createEl("p", {
      cls: "chats2md-progress-modal__counts",
      text: formatCounts(this.latestCounts)
    });

    this.detailEl = contentEl.createDiv({
      cls: "chats2md-progress-modal__details"
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

    if (!this.detailEl) {
      return;
    }

    this.detailEl.createEl("p", { text });
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
