import { App, Modal, Notice, Setting } from "obsidian";

import { parseSessionJson } from "./chatgpt-api";
import type { ChatGptRequestConfig } from "./types";

interface SessionEditorModalOptions {
  title: string;
  pluginVersion: string;
  initialValue?: string;
  onSave: (raw: string, parsed: ChatGptRequestConfig) => Promise<void>;
}

const SECRET_STORAGE_DOCS_URL = "https://docs.obsidian.md/plugins/guides/secret-storage";
const CHATGPT_SESSION_JSON_URL = "https://chatgpt.com/api/auth/session";

export class SessionEditorModal extends Modal {
  private readonly options: SessionEditorModalOptions;

  constructor(app: App, options: SessionEditorModalOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chats2md-modal");
    contentEl.addClass("chats2md-session-modal");

    this.setTitle(this.options.title);

    contentEl.createEl("p", {
      cls: "chats2md-modal__status",
      text: "Paste a complete session JSON payload. It should include accessToken, account.id, user.id, and user.email."
    });

    const sessionHint = contentEl.createEl("p", {
      cls: "chats2md-modal__hint"
    });
    sessionHint.createSpan({ text: "Get the payload by signing into ChatGPT, then opening " });
    sessionHint.createEl("a", {
      text: CHATGPT_SESSION_JSON_URL,
      href: CHATGPT_SESSION_JSON_URL
    });
    sessionHint.createSpan({ text: " and copying the full JSON response." });

    let rawValue = this.options.initialValue ?? "";

    new Setting(contentEl)
      .setName("Session JSON")
      .setDesc("The raw session payload will be stored in Obsidian Secret Storage.")
      .addTextArea((component) => {
        component.inputEl.rows = 16;
        component.inputEl.wrap = "off";
        component.inputEl.spellcheck = false;
        component.inputEl.addClass("chats2md-settings__textarea");
        component.setPlaceholder("{\n  \"accessToken\": \"...\",\n  \"user\": {\n    \"id\": \"...\",\n    \"email\": \"...\"\n  },\n  \"account\": {\n    \"id\": \"...\"\n  },\n  \"cookie\": \"...\"\n}");
        component.setValue(rawValue);
        component.onChange((value) => {
          rawValue = value;
        });
      });

    const docs = contentEl.createEl("p", {
      cls: "chats2md-modal__hint"
    });
    docs.createSpan({ text: "Use " });
    docs.createEl("a", {
      text: "Obsidian Secret Storage",
      href: SECRET_STORAGE_DOCS_URL
    });
    docs.createSpan({ text: " for sensitive plugin credentials." });

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("Save")
          .setCta()
          .onClick(async () => {
            const trimmed = rawValue.trim();

            if (!trimmed) {
              new Notice("Session JSON cannot be empty.");
              return;
            }

            let parsed: ChatGptRequestConfig;

            try {
              parsed = parseSessionJson(trimmed, this.options.pluginVersion);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              new Notice(message);
              return;
            }

            button.setDisabled(true);

            try {
              await this.options.onSave(trimmed, parsed);
              this.close();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              new Notice(message);
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
