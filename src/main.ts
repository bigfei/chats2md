import { Notice, Plugin } from "obsidian";

import { fetchConversationDetail, fetchConversationSummaries, parseSessionJson } from "./chatgpt-api";
import { SyncChatGptModal, type SyncExecutionControl, type SyncProgressReporter } from "./import-modal";
import {
  ensureConversationNotePath,
  getIndexedConversationSyncMetadata,
  indexConversationNotes,
  upsertConversationNote
} from "./note-writer";
import { Chats2MdSettingTab } from "./settings";
import {
  DEFAULT_SETTINGS,
  type ChatGptRequestConfig,
  type Chats2MdSettings,
  type ConversationDetail,
  type ConversationSummary,
  type ImportFailure,
  type ImportProgressCounts,
  type StoredSessionAccount,
  type SyncModalValues
} from "./types";

const DETAIL_FETCH_MAX_ATTEMPTS = 3;
const ACCOUNT_SYNC_BATCH_SIZE = 30;
const ACCOUNT_SYNC_BATCH_DELAY_MS = 30000;
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

function normalizeTimestampToMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function hasMatchingUpdatedAt(existingUpdatedAt: string | null, summaryUpdatedAt: string): boolean {
  if (!existingUpdatedAt) {
    return false;
  }

  if (existingUpdatedAt === summaryUpdatedAt) {
    return true;
  }

  const existingMs = normalizeTimestampToMs(existingUpdatedAt);
  const summaryMs = normalizeTimestampToMs(summaryUpdatedAt);

  if (existingMs === null || summaryMs === null) {
    return false;
  }

  return Math.abs(existingMs - summaryMs) <= 1000;
}

function formatActionLabel(action: string): string {
  if (!action) {
    return "Unknown";
  }

  return `${action.charAt(0).toUpperCase()}${action.slice(1)}`;
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
  private syncStatusBarEl: HTMLElement | null = null;
  private activeSyncModal: SyncChatGptModal | null = null;
  private syncWorkerActive = false;
  private syncStatusClearTimer: number | null = null;
  private suppressSyncStatusBarUpdates = false;

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

    this.syncStatusBarEl = this.addStatusBarItem();
    this.syncStatusBarEl.classList.add("chats2md-sync-statusbar");
    this.syncStatusBarEl.style.display = "none";
    this.syncStatusBarEl.addEventListener("click", () => {
      if (this.activeSyncModal?.isSyncInProgress()) {
        this.activeSyncModal.open();
      }
    });
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

  private buildSyncStatusText(processed: number, total: number, phase: string): string {
    if (total > 0) {
      const percent = Math.round((processed / total) * 100);
      return `ChatGPT sync: ${processed}/${total} (${percent}%) - ${phase}`;
    }

    return `ChatGPT sync: ${phase}`;
  }

  private setSyncStatusBar(text: string, active = false): void {
    if (this.suppressSyncStatusBarUpdates) {
      return;
    }

    if (this.syncStatusClearTimer !== null) {
      window.clearTimeout(this.syncStatusClearTimer);
      this.syncStatusClearTimer = null;
    }

    if (!this.syncStatusBarEl) {
      return;
    }

    this.syncStatusBarEl.textContent = text;
    this.syncStatusBarEl.style.display = "";
    this.syncStatusBarEl.setAttribute(
      "aria-label",
      active && this.activeSyncModal?.isSyncInProgress() ? `${text} (click to reopen dialog)` : text
    );
  }

  private clearSyncStatusBar(delayMs = 0, force = false): void {
    if (!this.syncStatusBarEl) {
      return;
    }

    if (this.syncStatusClearTimer !== null) {
      window.clearTimeout(this.syncStatusClearTimer);
      this.syncStatusClearTimer = null;
    }

    const clear = () => {
      if (!this.syncStatusBarEl) {
        return;
      }

      if (!force && this.activeSyncModal?.isSyncInProgress()) {
        return;
      }

      this.syncStatusBarEl.textContent = "";
      this.syncStatusBarEl.style.display = "none";
      this.syncStatusBarEl.removeAttribute("aria-label");
    };

    if (delayMs <= 0) {
      clear();
      return;
    }

    this.syncStatusClearTimer = window.setTimeout(() => {
      this.syncStatusClearTimer = null;
      clear();
    }, delayMs);
  }

  private openSyncModal(): void {
    if (this.syncWorkerActive) {
      if (this.activeSyncModal?.isSyncInProgress() && !this.suppressSyncStatusBarUpdates) {
        this.suppressSyncStatusBarUpdates = false;
        this.activeSyncModal.open();
        return;
      }

      new Notice("A sync job is still stopping in the background. Please wait a moment.");
      return;
    }

    if (this.activeSyncModal?.isSyncInProgress()) {
      this.suppressSyncStatusBarUpdates = false;
      this.activeSyncModal.open();
      return;
    }

    const accounts = this.getAccounts();

    if (accounts.length === 0) {
      new Notice("Add at least one account session in plugin settings before syncing.");
      return;
    }

    let modal: SyncChatGptModal;
    modal = new SyncChatGptModal(this.app, {
      folder: this.settings.defaultFolder,
      accounts,
      onSubmit: async (values, progress, control) => this.handleSync(values, progress, control, modal),
      onSyncDialogHidden: (reason) => {
        if (reason === "close") {
          this.suppressSyncStatusBarUpdates = true;
          this.clearSyncStatusBar(0, true);
          return;
        }

        this.suppressSyncStatusBarUpdates = false;
      }
    });

    this.activeSyncModal = modal;
    modal.open();
  }

  private async handleSync(
    values: SyncModalValues,
    progressModal: SyncProgressReporter,
    control: SyncExecutionControl,
    modal: SyncChatGptModal
  ): Promise<void> {
    this.settings.defaultFolder = values.folder;
    await this.saveSettings();

    const counts = createEmptyCounts();
    const failures: ImportFailure[] = [];
    let processedConversations = 0;
    let totalConversations = 0;
    this.syncWorkerActive = true;
    this.suppressSyncStatusBarUpdates = false;

    try {
      if (!(await this.ensureSyncCanContinue(control, progressModal, counts))) {
        return;
      }

      const selectedAccounts = this.getSelectedAccounts(values);
      const noteIndex = indexConversationNotes(this.app);
      progressModal.log(`Starting sync for ${selectedAccounts.length} account(s).`);
      this.setSyncStatusBar(this.buildSyncStatusText(processedConversations, totalConversations, "starting"), true);

      for (const [accountIndex, account] of selectedAccounts.entries()) {
        if (!(await this.ensureSyncCanContinue(control, progressModal, counts))) {
          return;
        }

        const accountLabel = this.getAccountLabel(account);
        progressModal.setPreparing(`Syncing ${accountLabel} (${accountIndex + 1}/${selectedAccounts.length}): fetching conversation list...`);
        progressModal.log(`[${accountIndex + 1}/${selectedAccounts.length}] Fetching conversation list for ${accountLabel}.`);
        this.setSyncStatusBar(
          this.buildSyncStatusText(
            processedConversations,
            totalConversations,
            `fetching list for ${accountLabel} (${accountIndex + 1}/${selectedAccounts.length})`
          ),
          true
        );

        let requestConfig: ChatGptRequestConfig;

        try {
          requestConfig = this.getRequestConfig(account);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          counts.failed += 1;
          failures.push({
            id: account.accountId,
            title: accountLabel,
            message,
            attempts: 1
          });
          progressModal.log(`[${accountLabel}] Failed to load session: ${message}`);
          continue;
        }

        let summaries: ConversationSummary[] = [];

        try {
          if (!(await this.ensureSyncCanContinue(control, progressModal, counts))) {
            return;
          }

          summaries = await fetchConversationSummaries(requestConfig);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          counts.failed += 1;
          failures.push({
            id: account.accountId,
            title: accountLabel,
            message,
            attempts: 1
          });
          progressModal.log(`[${accountLabel}] Failed to fetch conversation list: ${message}`);
          continue;
        }

        progressModal.log(`[${accountLabel}] Found ${summaries.length} conversation(s).`);
        if (summaries.length === 0) {
          continue;
        }

        totalConversations += summaries.length;
        this.setSyncStatusBar(
          this.buildSyncStatusText(processedConversations, totalConversations, `syncing ${accountLabel}`),
          true
        );
        let processedForAccount = 0;
        let detailApiCallsSinceWait = 0;

        for (const [conversationIndex, summary] of summaries.entries()) {
          if (!(await this.ensureSyncCanContinue(control, progressModal, counts))) {
            return;
          }

          const displayTitle = `${accountLabel}: ${summary.title}`;

          progressModal.setProgress(displayTitle, conversationIndex + 1, summaries.length, conversationIndex, counts);
          progressModal.log(`[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Processing "${summary.title}".`);

          const existingSyncMetadata = getIndexedConversationSyncMetadata(
            this.app,
            noteIndex,
            requestConfig.accountId,
            summary.id
          );

          const localListUpdatedAt = existingSyncMetadata.listUpdatedAt ?? existingSyncMetadata.updatedAt;
          const hasMatchingTitle = (existingSyncMetadata.title ?? "") === summary.title;

          if (hasMatchingTitle && hasMatchingUpdatedAt(localListUpdatedAt, summary.updatedAt)) {
            try {
              const renameResult = await ensureConversationNotePath(
                this.app,
                noteIndex,
                {
                  id: summary.id,
                  title: summary.title,
                  updatedAt: summary.updatedAt
                },
                values.folder,
                requestConfig.accountId
              );

              counts.skipped += 1;
              if (renameResult.moved) {
                counts.moved += 1;
              }

              progressModal.log(
                `[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Skipped (up-to-date)${renameResult.moved ? " + moved" : ""}: "${summary.title}".`
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              counts.failed += 1;
              failures.push({
                id: `${account.accountId}/${summary.id}`,
                title: `${accountLabel}: ${summary.title}`,
                message,
                attempts: 1
              });
              progressModal.log(`[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Failed while reconciling note path: "${summary.title}" - ${message}`);
            }
          } else {
            const mismatchReasons: string[] = [];
            if (!hasMatchingTitle) {
              mismatchReasons.push("title changed");
            }

            if (!hasMatchingUpdatedAt(localListUpdatedAt, summary.updatedAt)) {
              mismatchReasons.push("updated_at changed");
            }

            progressModal.log(
              `[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Calling /conversation/${summary.id} for "${summary.title}" (${mismatchReasons.join(", ")}).`
            );

            try {
              const detail = await this.fetchConversationDetailWithRetries(
                requestConfig,
                summary,
                conversationIndex + 1,
                summaries.length,
                progressModal,
                displayTitle,
                control,
                () => {
                  detailApiCallsSinceWait += 1;
                }
              );
              if (!detail) {
                return;
              }

              if (!(await this.ensureSyncCanContinue(control, progressModal, counts))) {
                return;
              }

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
                this.manifest.version,
                summary.updatedAt
              );

              counts[result.action] += 1;

              if (result.moved) {
                counts.moved += 1;
              }
              progressModal.log(
                `[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) ${formatActionLabel(result.action)}${result.moved ? " + moved" : ""}: "${summary.title}".`
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              counts.failed += 1;
              failures.push({
                id: `${account.accountId}/${summary.id}`,
                title: `${accountLabel}: ${summary.title}`,
                message,
                attempts: DETAIL_FETCH_MAX_ATTEMPTS
              });
              progressModal.log(`[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Failed: "${summary.title}" - ${message}`);
            }
          }

          processedConversations += 1;
          processedForAccount += 1;

          progressModal.setProgress(
            displayTitle,
            conversationIndex + 1,
            summaries.length,
            conversationIndex + 1,
            counts
          );
          this.setSyncStatusBar(
            this.buildSyncStatusText(processedConversations, totalConversations, `syncing ${accountLabel}`),
            true
          );

          const hasRemainingInAccount = processedForAccount < summaries.length;
          while (hasRemainingInAccount && detailApiCallsSinceWait >= ACCOUNT_SYNC_BATCH_SIZE) {
            progressModal.log(
              `[${accountLabel}] Called /conversation/{id} ${ACCOUNT_SYNC_BATCH_SIZE} times. Waiting 30s before next batch.`
            );
            this.setSyncStatusBar(
              this.buildSyncStatusText(
                processedConversations,
                totalConversations,
                `waiting 30s before next ${accountLabel} batch`
              ),
              true
            );

            let remainingDelayMs = ACCOUNT_SYNC_BATCH_DELAY_MS;
            while (remainingDelayMs > 0) {
              if (!(await this.ensureSyncCanContinue(control, progressModal, counts))) {
                return;
              }

              const stepDelay = Math.min(1000, remainingDelayMs);
              await sleep(stepDelay);
              remainingDelayMs -= stepDelay;
            }

            this.setSyncStatusBar(
              this.buildSyncStatusText(processedConversations, totalConversations, `syncing ${accountLabel}`),
              true
            );

            detailApiCallsSinceWait -= ACCOUNT_SYNC_BATCH_SIZE;
          }
        }
      }

      progressModal.log("Sync complete.");
      progressModal.complete(totalConversations, counts, failures);
      new Notice(summarizeCounts(totalConversations, counts));
      this.setSyncStatusBar(this.buildSyncStatusText(processedConversations, totalConversations, "complete"), false);
      this.clearSyncStatusBar(8000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      progressModal.fail(message, counts);
      new Notice(message);
      this.setSyncStatusBar(`ChatGPT sync failed: ${message}`, false);
      this.clearSyncStatusBar(10000);
    } finally {
      this.syncWorkerActive = false;
      this.suppressSyncStatusBarUpdates = false;
      if (this.activeSyncModal === modal && !modal.isSyncInProgress()) {
        this.activeSyncModal = null;
      }
    }
  }

  private async fetchConversationDetailWithRetries(
    requestConfig: ChatGptRequestConfig,
    summary: { id: string; title: string; createdAt: string; updatedAt: string },
    index: number,
    total: number,
    progressModal: SyncProgressReporter,
    displayTitle: string,
    control: SyncExecutionControl,
    onRequest?: () => void
  ): Promise<ConversationDetail | null> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= DETAIL_FETCH_MAX_ATTEMPTS; attempt += 1) {
      try {
        await control.waitIfPaused();

        if (control.shouldStop()) {
          return null;
        }

        onRequest?.();
        return await fetchConversationDetail(requestConfig, summary.id, summary);
      } catch (error) {
        lastError = error;

        if (control.shouldStop()) {
          return null;
        }

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

  private async ensureSyncCanContinue(
    control: SyncExecutionControl,
    progressModal: SyncProgressReporter,
    counts: ImportProgressCounts
  ): Promise<boolean> {
    await control.waitIfPaused();

    if (!control.shouldStop()) {
      return true;
    }

    progressModal.fail("Sync stopped by user.", counts);
    return false;
  }
}
