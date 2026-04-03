import { App, Modal, Notice, Setting } from "obsidian";

import type { StoredSessionAccount, SyncModalValues } from "./types";

interface SyncModalOptions {
  folder: string;
  accounts: StoredSessionAccount[];
  onSubmit: (values: SyncModalValues) => Promise<void>;
}

export class SyncChatGptModal extends Modal {
  private readonly options: SyncModalOptions;
  private syncScope: "all" | "single" = "all";
  private selectedAccountId: string;
  private readonly accountSelectorContainer: HTMLDivElement;

  constructor(app: App, options: SyncModalOptions) {
    super(app);
    this.options = options;
    this.selectedAccountId = options.accounts[0]?.accountId ?? "";
    this.accountSelectorContainer = this.contentEl.createDiv();
  }

  onOpen(): void {
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

            try {
              await this.options.onSubmit({
                folder: this.options.folder,
                scope: this.syncScope,
                accountId: this.syncScope === "single" ? this.selectedAccountId : undefined
              });
              this.close();
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
}
