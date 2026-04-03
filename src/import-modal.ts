import { App, Modal, Setting } from "obsidian";

import type { ImportModalValues } from "./types";

interface ImportModalOptions {
  folder: string;
  limit: number;
  accountId: string;
  expiresAt?: string;
  onSubmit: (values: ImportModalValues) => Promise<void>;
}

export class ImportChatGptModal extends Modal {
  private readonly options: ImportModalOptions;

  constructor(app: App, options: ImportModalOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chats2md-modal");

    this.setTitle("Import ChatGPT conversations");

    contentEl.createEl("p", {
      cls: "chats2md-modal__status",
      text: "Import settings are configured from the plugin settings tab."
    });

    const summaryList = contentEl.createEl("ul", {
      cls: "chats2md-modal__summary"
    });

    summaryList.createEl("li", {
      text: `Folder: ${this.options.folder}`
    });
    summaryList.createEl("li", {
      text: `Conversation limit: ${this.options.limit}`
    });
    summaryList.createEl("li", {
      text: `Account ID: ${this.options.accountId}`
    });
    summaryList.createEl("li", {
      text: `Session expiry: ${this.options.expiresAt || "Unavailable"}`
    });

    contentEl.createEl("p", {
      cls: "chats2md-modal__hint",
      text: "Continue to download full conversation logs into markdown notes."
    });

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("Continue")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);

            try {
              await this.options.onSubmit({
                folder: this.options.folder,
                limit: this.options.limit
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
}
