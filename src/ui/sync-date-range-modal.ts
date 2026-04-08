import { App, Modal, Notice, Setting } from "obsidian";

import { toIsoUtcDate } from "../sync/date-range";
import {
  getConversationSyncSubsetFieldState,
  resolveSkipExistingLocalConversations,
  type ConversationSyncSubsetMode,
  withSkipExistingLocalConversations,
} from "./sync-subset";
import type {
  ConversationSyncDateRangePromptContext,
  ConversationSyncDateRangeSelection,
} from "../shared/types";

interface SyncDateRangeModalOptions {
  context: ConversationSyncDateRangePromptContext;
  onResolve(selection: ConversationSyncDateRangeSelection): void;
}

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

class SyncDateRangeModal extends Modal {
  private readonly options: SyncDateRangeModalOptions;
  private readonly fullStartDate: string;
  private readonly fullEndDate: string;
  private filterMode: ConversationSyncSubsetMode = "all";
  private startDate: string;
  private endDate: string;
  private latestCount: string;
  private skipExistingLocalConversations: boolean;
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
    this.skipExistingLocalConversations = resolveSkipExistingLocalConversations(
      options.context.skipExistingLocalConversations,
    );
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chats2md-modal");
    contentEl.addClass("chats2md-date-range-modal");

    this.setTitle(`Choose sync subset (${this.options.context.accountLabel})`);

    contentEl.createEl("p", {
      cls: "chats2md-modal__status",
      text: `Found ${this.options.context.discoveredCount} conversations.`,
    });
    contentEl.createEl("p", {
      cls: "chats2md-modal__hint",
      text: `Conversation dates found: ${this.fullStartDate} to ${this.fullEndDate}.`,
    });
    contentEl.createEl("p", {
      cls: "chats2md-modal__hint",
      text: "Choose one sync range. Date range and newest conversations cannot be used together.",
    });

    new Setting(contentEl)
      .setName("Skip existing local conversations")
      .setDesc("When enabled, conversations that already exist locally are skipped by account and conversation ID.")
      .addToggle((toggle) => {
        toggle.setValue(this.skipExistingLocalConversations).onChange((value) => {
          this.skipExistingLocalConversations = value;
        });
      });

    new Setting(contentEl)
      .setName("Subset mode")
      .setDesc("Choose which part of the discovered list to sync.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("all", "All conversations found")
          .addOption("range", "Conversation date range")
          .addOption("latest-count", "Newest conversations")
          .setValue(this.filterMode)
          .onChange((value) => {
            this.filterMode = value === "range" || value === "latest-count" ? value : "all";
            this.updateSubsetInputVisibility();
          });
      });

    this.startDateSetting = new Setting(contentEl)
      .setName("Start date")
      .setDesc("First conversation date to include.")
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
      .setName("Number of newest conversations")
      .setDesc("Sync only the newest conversations by conversation date.")
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
      .setDesc("Last conversation date to include.")
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
      this.resolve(withSkipExistingLocalConversations({ mode: "all" }, this.skipExistingLocalConversations));
      return;
    }

    if (this.filterMode === "latest-count") {
      const count = parsePositiveIntegerInput(this.latestCount);
      if (count === null) {
        new Notice("Number of newest conversations must be a positive whole number.");
        return;
      }

      if (count >= this.options.context.discoveredCount) {
        this.resolve(withSkipExistingLocalConversations({ mode: "all" }, this.skipExistingLocalConversations));
        return;
      }

      this.resolve(
        withSkipExistingLocalConversations(
          {
            mode: "latest-count",
            count,
          },
          this.skipExistingLocalConversations,
        ),
      );
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
      this.resolve(withSkipExistingLocalConversations({ mode: "all" }, this.skipExistingLocalConversations));
      return;
    }

    this.resolve(
      withSkipExistingLocalConversations(
        {
          mode: "range",
          startDate: normalizedStartDate,
          endDate: normalizedEndDate,
        },
        this.skipExistingLocalConversations,
      ),
    );
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

export function openSyncDateRangeModal(
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
