import { App, Modal, Notice, Setting } from "obsidian";

import { parseSessionJson } from "../chatgpt/api";
import type { ChatGptRequestConfig } from "../shared/types";

interface SessionEditorModalOptions {
  title: string;
  pluginVersion: string;
  hasExistingSecret?: boolean;
  onSave: (raw: string, parsed: ChatGptRequestConfig) => Promise<void>;
}

const SECRET_STORAGE_DOCS_PATH = "plugins/guides/secret-storage";
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
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- Preserve ChatGPT brand casing and API field names.
      text: "Paste a complete ChatGPT session payload. It must include accessToken, account.id, user.id, and user.email, and it must still be valid when saved.",
    });

    const sessionHint = contentEl.createEl("p", {
      cls: "chats2md-modal__hint",
    });
    sessionHint.createSpan({ text: "Get the payload by signing into ChatGPT, then opening " });
    sessionHint.createEl("a", {
      text: CHATGPT_SESSION_JSON_URL,
      href: CHATGPT_SESSION_JSON_URL,
    });
    sessionHint.createSpan({ text: " and copying the full JSON response." });

    let rawValue = "";

    const editorSection = contentEl.createDiv({ cls: "chats2md-session-modal__editor" });
    editorSection.createEl("label", {
      cls: "chats2md-session-modal__editor-label",
      text: "Session JSON",
    });
    editorSection.createEl("p", {
      cls: "chats2md-session-modal__editor-desc",
      text: this.options.hasExistingSecret
        ? "The saved secret is not shown here. Paste a replacement session payload to update this account."
        : "The raw session payload is stored only in Obsidian secret storage after validation succeeds.",
    });
    const textarea = editorSection.createEl("textarea", {
      cls: "chats2md-settings__textarea",
    });
    textarea.rows = 16;
    textarea.wrap = "off";
    textarea.spellcheck = false;
    textarea.placeholder =
      '{\n  "accessToken": "...",\n  "user": {\n    "id": "...",\n    "email": "..."\n  },\n  "account": {\n    "id": "..."\n  },\n  "cookie": "..."\n}';
    textarea.addEventListener("input", () => {
      rawValue = textarea.value;
    });

    const docs = contentEl.createEl("p", {
      cls: "chats2md-modal__hint",
    });
    docs.createSpan({ text: "Use " });
    docs.createEl("a", {
      text: "Obsidian secret storage",
      href: this.app.vault.configDir
        ? `obsidian://open?vault=${encodeURIComponent(this.app.vault.getName())}&file=${encodeURIComponent(
            `${this.app.vault.configDir}/${SECRET_STORAGE_DOCS_PATH}`,
          )}`
        : CHATGPT_SESSION_JSON_URL,
    });
    docs.createSpan({
      text: " for sensitive plugin credentials. Expired or invalid ChatGPT sessions are rejected before save.",
    });

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
