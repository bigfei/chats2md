import { Notice, Plugin } from "obsidian";

import { fetchConversationDetail, fetchConversationSummaries, parseSessionJson } from "./chatgpt-api";
import { ImportChatGptModal } from "./import-modal";
import { indexConversationNotes, upsertConversationNote } from "./note-writer";
import { ImportProgressModal } from "./progress-modal";
import { Chats2MdSettingTab } from "./settings";
import {
  DEFAULT_SETTINGS,
  type ChatGptRequestConfig,
  type Chats2MdSettings,
  type ImportFailure,
  type ImportModalValues,
  type ImportProgressCounts
} from "./types";

const DETAIL_FETCH_MAX_ATTEMPTS = 3;

function createEmptyCounts(): ImportProgressCounts {
  return {
    created: 0,
    updated: 0,
    moved: 0,
    skipped: 0,
    failed: 0
  };
}

function summarizeCounts(total: number, counts: ImportProgressCounts): string {
  return [
    `Processed ${total} conversations.`,
    `${counts.created} created`,
    `${counts.updated} updated`,
    `${counts.moved} moved`,
    `${counts.skipped} skipped`,
    `${counts.failed} failed`
  ].join(" ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export default class Chats2MdPlugin extends Plugin {
  settings: Chats2MdSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addRibbonIcon("download", "Import ChatGPT conversations", () => {
      this.openImportModal();
    });

    this.addCommand({
      id: "import-chatgpt-conversations",
      name: "Import ChatGPT conversations",
      callback: () => {
        this.openImportModal();
      }
    });

    this.addSettingTab(new Chats2MdSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved as Partial<Chats2MdSettings>);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private getRequestConfig(): ChatGptRequestConfig {
    const raw = this.settings.sessionJson.trim();

    if (!raw) {
      throw new Error("Configure Session JSON in the Chats2MD settings before importing.");
    }

    return parseSessionJson(raw, this.manifest.version);
  }

  private openImportModal(): void {
    let requestConfig: ChatGptRequestConfig;

    try {
      requestConfig = this.getRequestConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(message);
      return;
    }

    new ImportChatGptModal(this.app, {
      folder: this.settings.defaultFolder,
      limit: this.settings.defaultLimit,
      accountId: requestConfig.accountId,
      expiresAt: requestConfig.expiresAt,
      onSubmit: async (values) => this.handleImport(values, requestConfig)
    }).open();
  }

  private async handleImport(values: ImportModalValues, requestConfig: ChatGptRequestConfig): Promise<void> {
    this.settings.defaultFolder = values.folder;
    this.settings.defaultLimit = values.limit;
    await this.saveSettings();

    const progressModal = new ImportProgressModal(this.app);
    progressModal.open();
    progressModal.setPreparing("Fetching conversation list...");

    const counts = createEmptyCounts();
    const failures: ImportFailure[] = [];

    try {
      const summaries = await fetchConversationSummaries(requestConfig, values.limit);

      if (summaries.length === 0) {
        progressModal.complete(0, counts, failures);
        new Notice("No conversations returned.");
        return;
      }

      const noteIndex = indexConversationNotes(this.app);

      for (const [index, summary] of summaries.entries()) {
        progressModal.setProgress(summary.title, index + 1, summaries.length, index, counts);

        try {
          const detail = await this.fetchConversationDetailWithRetries(
            requestConfig,
            summary,
            index + 1,
            summaries.length,
            progressModal
          );
          const result = await upsertConversationNote(
            this.app,
            noteIndex,
            detail,
            values.folder,
            requestConfig.accountId,
            this.manifest.version
          );

          counts[result.action] += 1;

          if (result.moved) {
            counts.moved += 1;
          }
        } catch (error) {
          counts.failed += 1;
          failures.push({
            id: summary.id,
            title: summary.title,
            message: error instanceof Error ? error.message : String(error),
            attempts: DETAIL_FETCH_MAX_ATTEMPTS
          });
        }

        progressModal.setProgress(
          summary.title,
          index + 1,
          summaries.length,
          index + 1,
          counts
        );
      }

      progressModal.complete(summaries.length, counts, failures);
      new Notice(summarizeCounts(summaries.length, counts));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      progressModal.fail(message, counts);
      new Notice(message);
    }
  }

  private async fetchConversationDetailWithRetries(
    requestConfig: ChatGptRequestConfig,
    summary: { id: string; title: string; updatedAt: string },
    index: number,
    total: number,
    progressModal: ImportProgressModal
  ) {
    let lastError: unknown;

    for (let attempt = 1; attempt <= DETAIL_FETCH_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await fetchConversationDetail(requestConfig, summary.id, summary);
      } catch (error) {
        lastError = error;

        if (attempt >= DETAIL_FETCH_MAX_ATTEMPTS) {
          break;
        }

        const message = error instanceof Error ? error.message : String(error);
        progressModal.setRetry(summary.title, index, total, attempt + 1, message);
        await sleep(attempt * 750);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
