import { App, Modal, Setting } from "obsidian";

import type { ImportFailure, ImportProgressCounts } from "./types";

function formatCounts(counts: ImportProgressCounts): string {
  return [
    `Created: ${counts.created}`,
    `Updated: ${counts.updated}`,
    `Moved: ${counts.moved}`,
    `Skipped: ${counts.skipped}`,
    `Failed: ${counts.failed}`
  ].join(" | ");
}

export class ImportProgressModal extends Modal {
  private statusEl!: HTMLElement;
  private countsEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private progressBarSetting!: Setting;
  private closeButton!: HTMLButtonElement;

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chats2md-modal");
    contentEl.addClass("chats2md-progress-modal");

    this.setTitle("Import ChatGPT conversations");

    this.statusEl = contentEl.createEl("p", {
      cls: "chats2md-modal__status",
      text: "Preparing import..."
    });

    this.progressBarSetting = new Setting(contentEl).setName("Progress");
    this.progressBarSetting.addProgressBar((component) => {
      component.setValue(0);
    });

    this.countsEl = contentEl.createEl("p", {
      cls: "chats2md-progress-modal__counts",
      text: formatCounts({
        created: 0,
        updated: 0,
        moved: 0,
        skipped: 0,
        failed: 0
      })
    });

    this.detailEl = contentEl.createDiv({
      cls: "chats2md-progress-modal__details"
    });

    new Setting(contentEl).addButton((button) => {
      button.setButtonText("Close");
      button.setDisabled(true);
      this.closeButton = button.buttonEl;
      button.onClick(() => this.close());
    });
  }

  setPreparing(message: string): void {
    this.statusEl.setText(message);
    this.setProgressValue(0);
  }

  setRetry(title: string, index: number, total: number, attempt: number, message: string): void {
    this.statusEl.setText(`Retry ${title} (${index}/${total}) attempt ${attempt}/3`);
    this.appendDetail(`${title}: ${message}`);
  }

  setProgress(
    title: string,
    index: number,
    total: number,
    processed: number,
    counts: ImportProgressCounts
  ): void {
    this.statusEl.setText(`Download ${title} (${index}/${total})`);
    this.countsEl.setText(formatCounts(counts));
    this.setProgressValue(total === 0 ? 0 : Math.round((processed / total) * 100));
  }

  complete(total: number, counts: ImportProgressCounts, failures: ImportFailure[]): void {
    const successCount = total - counts.failed;
    this.statusEl.setText(`Finished import. ${successCount}/${total} conversations processed.`);
    this.countsEl.setText(formatCounts(counts));
    this.setProgressValue(100);

    if (failures.length > 0) {
      this.appendDetail("Failures:");

      for (const failure of failures) {
        this.appendDetail(`${failure.title} (${failure.id}) after ${failure.attempts} attempts: ${failure.message}`);
      }
    }

    this.closeButton.disabled = false;
  }

  fail(message: string, counts: ImportProgressCounts): void {
    this.statusEl.setText(message);
    this.countsEl.setText(formatCounts(counts));
    this.appendDetail(message);
    this.closeButton.disabled = false;
  }

  private appendDetail(text: string): void {
    this.detailEl.createEl("p", {
      text
    });
  }

  private setProgressValue(value: number): void {
    const progressEl = this.progressBarSetting.controlEl.querySelector("progress");

    if (progressEl instanceof HTMLProgressElement) {
      progressEl.value = value;
    }
  }
}
