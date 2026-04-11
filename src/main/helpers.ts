import type { App } from "obsidian";

import type {
  AssetStorageMode,
  ChatGptRequestConfig,
  Chats2MdSettings,
  ImportProgressCounts,
  StoredSessionAccount,
  SyncTuningSettings,
} from "../shared/types";
import { normalizeObsidianPath } from "../path/normalization";

export const SECRET_ID_PREFIX = "chats2md-session";
export const ASSET_FOLDER_NAME = "_assets";
export const MAX_ASSET_FILENAME_LENGTH = 120;
export const CONVERSATION_ID_KEY = "chatgpt_conversation_id";
export const CONVERSATION_TITLE_KEY = "chatgpt_title";
export const CONVERSATION_CREATED_AT_KEY = "chatgpt_created_at";
export const CONVERSATION_UPDATED_AT_KEY = "chatgpt_updated_at";
export const CONVERSATION_LIST_UPDATED_AT_KEY = "chatgpt_list_updated_at";
export const CONVERSATION_ACCOUNT_ID_KEY = "chatgpt_account_id";
export const CONVERSATION_USER_ID_KEY = "chatgpt_user_id";
export const CONVERSATION_ASSET_STORAGE_MODE_KEY = "chats2md_asset_storage";
export const FORCE_SYNC_ACTION_LABEL = "Force sync from ChatGPT";
export const DEFAULT_SYNC_REPORT_FOLDER_TEMPLATE = "<syncFolder>/sync-result";
const MIME_TO_EXTENSION: Record<string, string> = {
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/zip": ".zip",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
  "message/rfc822": ".eml",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/plain": ".txt",
};

const MIN_TUNING_PARALLELISM = 1;
const MAX_TUNING_PARALLELISM = 10;
const MIN_TUNING_RETRY_ATTEMPTS = 1;
const MAX_TUNING_RETRY_ATTEMPTS = 10;
const MIN_TUNING_BROWSE_DELAY_MS = 0;
const MAX_TUNING_BROWSE_DELAY_MS = 60000;
const MIN_TUNING_RATE_LIMIT_THRESHOLD = 1;
const MAX_TUNING_RATE_LIMIT_THRESHOLD = 20;
const MIN_TUNING_LATEST_COUNT = 1;
const MAX_TUNING_LATEST_COUNT = 10000;
const INVALID_PATH_PART_CHARS = new RegExp(`[<>:"/\\\\|?*${String.fromCharCode(0)}-${String.fromCharCode(31)}]`, "g");

type SyncLogLevel = "info" | "warn" | "error";

export class SyncRunLogger {
  readonly filePath: string;
  private readonly app: App;
  private readonly dialogLogger: (message: string) => void;
  private appendQueue: Promise<void> = Promise.resolve();
  private pendingLines: string[] = [];

  constructor(app: App, filePath: string, dialogLogger: (message: string) => void) {
    this.app = app;
    this.filePath = filePath;
    this.dialogLogger = dialogLogger;
  }

  info(message: string): void {
    this.write("info", message, true);
  }

  warn(message: string): void {
    this.write("warn", message, false);
  }

  error(message: string): void {
    this.write("error", message, false);
  }

  async flush(): Promise<void> {
    this.queuePendingLines();
    await this.appendQueue;
  }

  private write(level: SyncLogLevel, message: string, includeInDialog: boolean): void {
    if (includeInDialog) {
      this.dialogLogger(message);
    }

    const timestamp = new Date().toISOString();
    const lines = message.split(/\r?\n/);
    for (const line of lines) {
      this.pendingLines.push(`[${timestamp}] [${level.toUpperCase()}] ${line}`);
    }
  }

  private queuePendingLines(): void {
    if (this.pendingLines.length === 0) {
      return;
    }

    const block = `${this.pendingLines.join("\n")}\n`;
    this.pendingLines = [];
    this.appendQueue = this.appendQueue.then(() => this.appendBlock(block)).catch(() => undefined);
  }

  private async appendBlock(block: string): Promise<void> {
    const existing = this.app.vault.getFileByPath(this.filePath);

    if (existing) {
      await this.app.vault.process(existing, (content) => `${content}${block}`);
      return;
    }

    if (!this.app.vault.getAbstractFileByPath(this.filePath)) {
      await this.app.vault.create(this.filePath, block);
      return;
    }

    throw new Error(`Sync log path conflicts with a folder: ${this.filePath}`);
  }
}

export interface LegacySettingsPayload extends Partial<Chats2MdSettings> {
  sessionJson?: string;
}

export interface ConversationFrontmatterInfo {
  conversationId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  listUpdatedAt: string;
  accountId: string;
  userId: string;
}

export function isImportedChatGptConversationFrontmatter(frontmatter: ConversationFrontmatterInfo): boolean {
  return frontmatter.conversationId.length > 0;
}

export function createEmptyCounts(): ImportProgressCounts {
  return {
    created: 0,
    updated: 0,
    moved: 0,
    skipped: 0,
    failed: 0,
  };
}

export function summarizeCounts(total: number, counts: ImportProgressCounts): string {
  return [
    `Synced ${total} conversations.`,
    `${counts.created} created`,
    `${counts.updated} updated`,
    `${counts.moved} moved`,
    `${counts.skipped} skipped`,
    `${counts.failed} failed`,
  ].join(" ");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function formatActionLabel(action: string): string {
  if (!action) {
    return "Unknown";
  }

  return `${action.charAt(0).toUpperCase()}${action.slice(1)}`;
}

export function normalizeAssetStorageMode(value: unknown): AssetStorageMode {
  return value === "with_conversation" ? "with_conversation" : "global_by_conversation";
}

export function formatAssetStorageMode(mode: AssetStorageMode): string {
  return mode === "with_conversation" ? "With conversation folder" : "Global by conversation";
}

export function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function normalizeTargetFolder(folder: string): string {
  const trimmed = folder.trim().replace(/^\/+|\/+$/g, "");
  return trimmed.length > 0 ? normalizeObsidianPath(trimmed) : "";
}

export function resolveSyncReportFolder(syncFolder: string, configuredFolder: string): string {
  const normalizedSyncFolder = normalizeTargetFolder(syncFolder);

  if (!normalizedSyncFolder) {
    throw new Error("Cannot resolve sync report folder because sync folder is empty.");
  }

  const configuredTemplate = configuredFolder.trim() || DEFAULT_SYNC_REPORT_FOLDER_TEMPLATE;
  const resolvedTemplate = configuredTemplate.includes("<syncFolder>")
    ? configuredTemplate.split("<syncFolder>").join(normalizedSyncFolder)
    : configuredTemplate;
  const resolvedFolder = normalizeTargetFolder(resolvedTemplate);

  if (resolvedFolder) {
    return resolvedFolder;
  }

  return normalizeTargetFolder(`${normalizedSyncFolder}/sync-result`);
}

export function sanitizePathPart(value: string): string {
  const sanitized = value
    .trim()
    .replace(INVALID_PATH_PART_CHARS, "_")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, MAX_ASSET_FILENAME_LENGTH);
  return sanitized || "file";
}

export function appendExtensionIfMissing(fileName: string, contentType: string | null): string {
  if (fileName.includes(".") || !contentType) {
    return fileName;
  }

  const normalizedType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  const extension = MIME_TO_EXTENSION[normalizedType];
  return extension ? `${fileName}${extension}` : fileName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeStoredAccount(value: unknown): StoredSessionAccount | null {
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
    disabled: value.disabled === true,
    addedAt: readString(value.addedAt, timestamp),
    updatedAt: readString(value.updatedAt, timestamp),
  };
}

export function upsertStoredAccountMetadata(
  settings: Chats2MdSettings,
  requestConfig: ChatGptRequestConfig,
  secretId: string,
): StoredSessionAccount {
  const now = new Date().toISOString();
  const existing = settings.accounts.find((account) => account.accountId === requestConfig.accountId);

  const account: StoredSessionAccount = {
    accountId: requestConfig.accountId,
    userId: requestConfig.userId,
    email: requestConfig.userEmail,
    expiresAt: requestConfig.expiresAt,
    secretId,
    disabled: existing?.disabled ?? false,
    addedAt: existing?.addedAt ?? now,
    updatedAt: now,
  };

  settings.accounts = sortAccounts([
    ...settings.accounts.filter((item) => item.accountId !== requestConfig.accountId),
    account,
  ]);

  return account;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(value as number)));
}

export function normalizeDefaultLatestConversationCount(value: unknown): number | null {
  if (value === null || typeof value === "undefined") {
    return null;
  }

  if (typeof value === "string" && value.trim().length === 0) {
    return null;
  }

  if (!Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.trunc(value as number);
  if (normalized < MIN_TUNING_LATEST_COUNT) {
    return MIN_TUNING_LATEST_COUNT;
  }

  return Math.min(MAX_TUNING_LATEST_COUNT, normalized);
}

export function normalizeSyncTuningSettings(value: unknown, fallback: SyncTuningSettings): SyncTuningSettings {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const conversationDetailBrowseDelayMinMs = clampInteger(
    record.conversationDetailBrowseDelayMinMs,
    fallback.conversationDetailBrowseDelayMinMs,
    MIN_TUNING_BROWSE_DELAY_MS,
    MAX_TUNING_BROWSE_DELAY_MS,
  );
  const requestedMaxBrowseDelayMs = clampInteger(
    record.conversationDetailBrowseDelayMaxMs,
    fallback.conversationDetailBrowseDelayMaxMs,
    MIN_TUNING_BROWSE_DELAY_MS,
    MAX_TUNING_BROWSE_DELAY_MS,
  );

  return {
    conversationListFetchParallelism: clampInteger(
      record.conversationListFetchParallelism,
      fallback.conversationListFetchParallelism,
      MIN_TUNING_PARALLELISM,
      MAX_TUNING_PARALLELISM,
    ),
    conversationListRetryAttempts: clampInteger(
      record.conversationListRetryAttempts,
      fallback.conversationListRetryAttempts,
      MIN_TUNING_RETRY_ATTEMPTS,
      MAX_TUNING_RETRY_ATTEMPTS,
    ),
    conversationDetailRetryAttempts: clampInteger(
      record.conversationDetailRetryAttempts,
      fallback.conversationDetailRetryAttempts,
      MIN_TUNING_RETRY_ATTEMPTS,
      MAX_TUNING_RETRY_ATTEMPTS,
    ),
    conversationDetailBrowseDelayMinMs,
    conversationDetailBrowseDelayMaxMs: Math.max(conversationDetailBrowseDelayMinMs, requestedMaxBrowseDelayMs),
    maxConsecutiveRateLimitResponses: clampInteger(
      record.maxConsecutiveRateLimitResponses,
      fallback.maxConsecutiveRateLimitResponses,
      MIN_TUNING_RATE_LIMIT_THRESHOLD,
      MAX_TUNING_RATE_LIMIT_THRESHOLD,
    ),
    defaultLatestConversationCount: normalizeDefaultLatestConversationCount(record.defaultLatestConversationCount),
  };
}

export function sortAccounts(accounts: StoredSessionAccount[]): StoredSessionAccount[] {
  return [...accounts].sort((left, right) => {
    const emailSort = left.email.localeCompare(right.email);

    if (emailSort !== 0) {
      return emailSort;
    }

    return left.accountId.localeCompare(right.accountId);
  });
}

export function getStoredAccountDisplayName(account: Pick<StoredSessionAccount, "email" | "accountId">): string {
  return account.email.trim().length > 0 ? account.email : account.accountId;
}

export function formatStoredAccountLabel(account: Pick<StoredSessionAccount, "email" | "accountId">): string {
  const displayName = getStoredAccountDisplayName(account);
  return displayName === account.accountId ? account.accountId : `${displayName} (${account.accountId})`;
}

export function removeStoredAccount(settings: { accounts: StoredSessionAccount[] }, accountId: string): void {
  settings.accounts = settings.accounts.filter((account) => account.accountId !== accountId);
}
