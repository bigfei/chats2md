import type { App } from "obsidian";

import type {
  AssetStorageMode,
  Chats2MdSettings,
  ConversationListCacheByAccount,
  ConversationSummary,
  ImportProgressCounts,
  StoredSessionAccount,
} from "../shared/types";
import { normalizeObsidianPath } from "../path/normalization";

export const DETAIL_FETCH_MAX_ATTEMPTS = 3;
export const ACCOUNT_SYNC_BATCH_SIZE = 30;
export const ACCOUNT_SYNC_BATCH_DELAY_MS = 30000;
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
export const DEFAULT_CONVERSATION_LIST_LATEST_LIMIT = 200;
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

type SyncLogLevel = "info" | "warn" | "error";

export class SyncRunLogger {
  readonly filePath: string;
  private readonly app: App;
  private readonly dialogLogger: (message: string) => void;
  private appendQueue: Promise<void> = Promise.resolve();

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
    await this.appendQueue;
  }

  private write(level: SyncLogLevel, message: string, includeInDialog: boolean): void {
    if (includeInDialog) {
      this.dialogLogger(message);
    }

    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
    this.appendQueue = this.appendQueue.then(() => this.appendLine(line)).catch(() => undefined);
  }

  private async appendLine(line: string): Promise<void> {
    const existing = this.app.vault.getFileByPath(this.filePath);

    if (existing) {
      await this.app.vault.process(existing, (content) => `${content}${line}\n`);
      return;
    }

    if (!this.app.vault.getAbstractFileByPath(this.filePath)) {
      await this.app.vault.create(this.filePath, `${line}\n`);
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

export function normalizeTimestampToMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function hasMatchingUpdatedAt(existingUpdatedAt: string | null, summaryUpdatedAt: string): boolean {
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

function toPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 ? Math.trunc(value) : null;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }

    return Math.trunc(parsed);
  }

  return null;
}

export function normalizeConversationListLatestLimit(
  value: unknown,
  fallback = DEFAULT_CONVERSATION_LIST_LATEST_LIMIT,
): number {
  const normalizedFallback = toPositiveInteger(fallback) ?? DEFAULT_CONVERSATION_LIST_LATEST_LIMIT;
  return toPositiveInteger(value) ?? normalizedFallback;
}

function normalizeCachedConversationSummary(value: unknown): ConversationSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = readString(value.id).trim();
  if (!id) {
    return null;
  }

  const title = readString(value.title).trim() || "Untitled Conversation";
  const createdAt = readString(value.createdAt).trim();
  const updatedAt = readString(value.updatedAt).trim();
  const url = readString(value.url).trim() || `https://chatgpt.com/c/${id}`;

  if (!createdAt || !updatedAt) {
    return null;
  }

  return {
    id,
    title,
    createdAt,
    updatedAt,
    url,
  };
}

export function normalizeConversationListCacheByAccount(value: unknown): ConversationListCacheByAccount {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: ConversationListCacheByAccount = {};

  for (const [accountId, entry] of Object.entries(value)) {
    const normalizedAccountId = accountId.trim();
    if (!normalizedAccountId || !isRecord(entry)) {
      continue;
    }

    const summaries = Array.isArray(entry.summaries)
      ? entry.summaries
          .map((summary) => normalizeCachedConversationSummary(summary))
          .filter((summary): summary is ConversationSummary => summary !== null)
      : [];
    const cachedAt = readString(entry.cachedAt).trim();

    normalized[normalizedAccountId] = {
      summaries,
      cachedAt: cachedAt || new Date().toISOString(),
    };
  }

  return normalized;
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
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
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
    addedAt: readString(value.addedAt, timestamp),
    updatedAt: readString(value.updatedAt, timestamp),
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
