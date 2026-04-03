import { Notice, Plugin } from "obsidian";

import { fetchConversationDetail, fetchConversationSummaries, parseSessionJson } from "./chatgpt-api";
import { SyncChatGptModal } from "./import-modal";
import { indexConversationNotes, upsertConversationNote } from "./note-writer";
import { ImportProgressModal } from "./progress-modal";
import { Chats2MdSettingTab } from "./settings";
import {
  DEFAULT_SETTINGS,
  type ChatGptRequestConfig,
  type Chats2MdSettings,
  type ImportFailure,
  type ImportProgressCounts,
  type StoredSessionAccount,
  type SyncModalValues
} from "./types";

const DETAIL_FETCH_MAX_ATTEMPTS = 3;
const SECRET_ID_PREFIX = "chats2md-session";

interface LegacySettingsPayload extends Partial<Chats2MdSettings> {
  sessionJson?: string;
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

function summarizeCounts(total: number, counts: ImportProgressCounts): string {
  return [
    `Synced ${total} conversations.`,
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

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeStoredAccount(value: unknown): StoredSessionAccount | null {
  if (!isRecord(value)) {
    return null;
  }

  const accountId = readString(value.accountId).trim();
  const secretId = readString(value.secretId).trim();

  if (!accountId || !secretId) {
    return null;
  }

  const timestamp = new Date().toISOString();
  const expiresAt = readString(value.expiresAt).trim();

  return {
    accountId,
    userId: readString(value.userId).trim(),
    email: readString(value.email).trim(),
    expiresAt: expiresAt.length > 0 ? expiresAt : undefined,
    secretId,
    addedAt: readString(value.addedAt, timestamp),
    updatedAt: readString(value.updatedAt, timestamp)
  };
}

function sortAccounts(accounts: StoredSessionAccount[]): StoredSessionAccount[] {
  return [...accounts].sort((left, right) => {
    const emailSort = left.email.localeCompare(right.email);

    if (emailSort !== 0) {
      return emailSort;
    }

    return left.accountId.localeCompare(right.accountId);
  });
}

export default class Chats2MdPlugin extends Plugin {
  settings: Chats2MdSettings = DEFAULT_SETTINGS;
  private legacySessionMigrationWarning: string | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addRibbonIcon("download", "Sync ChatGPT conversations", () => {
      this.openSyncModal();
    });

    this.addCommand({
      id: "import-chatgpt-conversations",
      name: "Sync ChatGPT conversations",
      callback: () => {
        this.openSyncModal();
      }
    });

    this.addSettingTab(new Chats2MdSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    const saved = await this.loadData() as LegacySettingsPayload | null;
    const savedAccounts = Array.isArray(saved?.accounts)
      ? saved.accounts.map(normalizeStoredAccount).filter((account): account is StoredSessionAccount => account !== null)
      : [];
    const legacySessionJson = readString(saved?.legacySessionJson).trim() || readString(saved?.sessionJson);

    this.settings = {
      ...DEFAULT_SETTINGS,
      defaultFolder: readString(saved?.defaultFolder, DEFAULT_SETTINGS.defaultFolder),
      accounts: sortAccounts(savedAccounts),
      legacySessionJson
    };

    await this.migrateLegacySessionIfNeeded();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getAccounts(): StoredSessionAccount[] {
    return sortAccounts(this.settings.accounts);
  }

  getLegacySessionMigrationWarning(): string | null {
    return this.legacySessionMigrationWarning;
  }

  getSessionSecret(secretId: string): string | null {
    return this.app.secretStorage.getSecret(secretId);
  }

  async upsertSessionAccount(rawSessionJson: string, parsed?: ChatGptRequestConfig): Promise<StoredSessionAccount> {
    const normalizedRaw = rawSessionJson.trim();

    if (!normalizedRaw) {
      throw new Error("Session JSON cannot be empty.");
    }

    const requestConfig = parsed ?? parseSessionJson(normalizedRaw, this.manifest.version);
    const secretId = this.buildSecretId(requestConfig.accountId);

    this.app.secretStorage.setSecret(secretId, normalizedRaw);
    const account = this.upsertAccountMetadata(requestConfig, secretId);
    this.legacySessionMigrationWarning = null;

    if (this.settings.legacySessionJson.trim().length > 0) {
      this.settings.legacySessionJson = "";
    }

    await this.saveSettings();
    return account;
  }

  async removeSessionAccount(accountId: string): Promise<void> {
    this.settings.accounts = this.settings.accounts.filter((account) => account.accountId !== accountId);
    await this.saveSettings();
  }

  private async migrateLegacySessionIfNeeded(): Promise<void> {
    const raw = this.settings.legacySessionJson.trim();

    if (!raw) {
      this.legacySessionMigrationWarning = null;
      return;
    }

    try {
      const parsed = parseSessionJson(raw, this.manifest.version);
      const secretId = this.buildSecretId(parsed.accountId);
      this.app.secretStorage.setSecret(secretId, raw);
      this.upsertAccountMetadata(parsed, secretId);
      this.settings.legacySessionJson = "";
      this.legacySessionMigrationWarning = null;
      await this.saveSettings();
      new Notice("Legacy Session JSON was migrated into Secret Storage.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.legacySessionMigrationWarning = `Legacy Session JSON migration failed: ${message}`;
    }
  }

  private upsertAccountMetadata(requestConfig: ChatGptRequestConfig, secretId: string): StoredSessionAccount {
    const now = new Date().toISOString();
    const existing = this.settings.accounts.find((account) => account.accountId === requestConfig.accountId);

    const account: StoredSessionAccount = {
      accountId: requestConfig.accountId,
      userId: requestConfig.userId,
      email: requestConfig.userEmail,
      expiresAt: requestConfig.expiresAt,
      secretId,
      addedAt: existing?.addedAt ?? now,
      updatedAt: now
    };

    this.settings.accounts = sortAccounts([
      ...this.settings.accounts.filter((item) => item.accountId !== requestConfig.accountId),
      account
    ]);

    return account;
  }

  private buildSecretId(accountId: string): string {
    const normalizedPart = accountId
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    return `${SECRET_ID_PREFIX}-${normalizedPart || "account"}`;
  }

  private getSelectedAccounts(values: SyncModalValues): StoredSessionAccount[] {
    const accounts = this.getAccounts();

    if (values.scope === "all") {
      return accounts;
    }

    const accountId = (values.accountId ?? "").trim();

    if (!accountId) {
      throw new Error("No account selected for sync.");
    }

    const selected = accounts.find((account) => account.accountId === accountId);

    if (!selected) {
      throw new Error(`Selected account is no longer available: ${accountId}`);
    }

    return [selected];
  }

  private getRequestConfig(account: StoredSessionAccount): ChatGptRequestConfig {
    const raw = this.app.secretStorage.getSecret(account.secretId);

    if (!raw || raw.trim().length === 0) {
      throw new Error(`Session secret not found for account ${account.accountId}.`);
    }

    return parseSessionJson(raw, this.manifest.version);
  }

  private getAccountLabel(account: StoredSessionAccount): string {
    return account.email.trim().length > 0 ? account.email : account.accountId;
  }

  private openSyncModal(): void {
    const accounts = this.getAccounts();

    if (accounts.length === 0) {
      new Notice("Add at least one account session in plugin settings before syncing.");
      return;
    }

    new SyncChatGptModal(this.app, {
      folder: this.settings.defaultFolder,
      accounts,
      onSubmit: async (values) => this.handleSync(values)
    }).open();
  }

  private async handleSync(values: SyncModalValues): Promise<void> {
    this.settings.defaultFolder = values.folder;
    await this.saveSettings();

    const progressModal = new ImportProgressModal(this.app);
    progressModal.open();

    const counts = createEmptyCounts();
    const failures: ImportFailure[] = [];

    try {
      const selectedAccounts = this.getSelectedAccounts(values);
      const noteIndex = indexConversationNotes(this.app);
      let totalConversations = 0;

      for (const [accountIndex, account] of selectedAccounts.entries()) {
        const accountLabel = this.getAccountLabel(account);
        progressModal.setPreparing(`Syncing ${accountLabel} (${accountIndex + 1}/${selectedAccounts.length}): fetching conversation list...`);

        let requestConfig: ChatGptRequestConfig;

        try {
          requestConfig = this.getRequestConfig(account);
        } catch (error) {
          counts.failed += 1;
          failures.push({
            id: account.accountId,
            title: accountLabel,
            message: error instanceof Error ? error.message : String(error),
            attempts: 1
          });
          continue;
        }

        let summaries = [];

        try {
          summaries = await fetchConversationSummaries(requestConfig);
        } catch (error) {
          counts.failed += 1;
          failures.push({
            id: account.accountId,
            title: accountLabel,
            message: error instanceof Error ? error.message : String(error),
            attempts: 1
          });
          continue;
        }

        if (summaries.length === 0) {
          continue;
        }

        totalConversations += summaries.length;
        for (const [conversationIndex, summary] of summaries.entries()) {
          const displayTitle = `${accountLabel}: ${summary.title}`;

          progressModal.setProgress(displayTitle, conversationIndex + 1, summaries.length, conversationIndex, counts);

          try {
            const detail = await this.fetchConversationDetailWithRetries(
              requestConfig,
              summary,
              conversationIndex + 1,
              summaries.length,
              progressModal,
              displayTitle
            );
            const result = await upsertConversationNote(
              this.app,
              noteIndex,
              detail,
              values.folder,
              {
                accountId: requestConfig.accountId,
                userId: requestConfig.userId,
                userEmail: requestConfig.userEmail
              },
              this.manifest.version
            );

            counts[result.action] += 1;

            if (result.moved) {
              counts.moved += 1;
            }
          } catch (error) {
            counts.failed += 1;
            failures.push({
              id: `${account.accountId}/${summary.id}`,
              title: `${accountLabel}: ${summary.title}`,
              message: error instanceof Error ? error.message : String(error),
              attempts: DETAIL_FETCH_MAX_ATTEMPTS
            });
          }

          progressModal.setProgress(
            displayTitle,
            conversationIndex + 1,
            summaries.length,
            conversationIndex + 1,
            counts
          );
        }
      }

      progressModal.complete(totalConversations, counts, failures);
      new Notice(summarizeCounts(totalConversations, counts));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      progressModal.fail(message, counts);
      new Notice(message);
    }
  }

  private async fetchConversationDetailWithRetries(
    requestConfig: ChatGptRequestConfig,
    summary: { id: string; title: string; createdAt: string; updatedAt: string },
    index: number,
    total: number,
    progressModal: ImportProgressModal,
    displayTitle: string
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
        progressModal.setRetry(displayTitle, index, total, attempt + 1, message);
        await sleep(attempt * 750);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
