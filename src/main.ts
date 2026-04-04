import { App, MarkdownView, Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";

import {
  fetchConversationDetail,
  fetchConversationFileDownloadInfo,
  fetchConversationSummaries,
  fetchSignedFileContent,
  parseSessionJson
} from "./chatgpt-api";
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
  type ConversationAssetLinkMap,
  type ConversationFileReference,
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
const ASSET_FOLDER_NAME = "_assets";
const MAX_ASSET_FILENAME_LENGTH = 120;
const CONVERSATION_ID_KEY = "chatgpt_conversation_id";
const CONVERSATION_TITLE_KEY = "chatgpt_title";
const CONVERSATION_CREATED_AT_KEY = "chatgpt_created_at";
const CONVERSATION_UPDATED_AT_KEY = "chatgpt_updated_at";
const CONVERSATION_LIST_UPDATED_AT_KEY = "chatgpt_list_updated_at";
const CONVERSATION_ACCOUNT_ID_KEY = "chatgpt_account_id";
const CONVERSATION_USER_ID_KEY = "chatgpt_user_id";
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
  "text/csv": ".csv",
  "text/html": ".html",
  "text/plain": ".txt"
};
type SyncLogLevel = "info" | "warn" | "error";

class SyncRunLogger {
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
    this.appendQueue = this.appendQueue
      .then(() => this.app.vault.adapter.append(this.filePath, `${line}\n`))
      .catch(() => undefined);
  }
}

interface LegacySettingsPayload extends Partial<Chats2MdSettings> {
  sessionJson?: string;
}

interface ConversationFrontmatterInfo {
  conversationId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  listUpdatedAt: string;
  accountId: string;
  userId: string;
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

function normalizeTargetFolder(folder: string): string {
  return normalizePath(folder.trim().replace(/^\/+|\/+$/g, ""));
}

function sanitizePathPart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, MAX_ASSET_FILENAME_LENGTH);
  return sanitized || "file";
}

function appendExtensionIfMissing(fileName: string, contentType: string | null): string {
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
  private markdownSyncActionEls = new WeakMap<MarkdownView, HTMLElement>();
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

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshMarkdownSyncActions()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshMarkdownSyncActions()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.refreshMarkdownSyncActions()));
    this.app.workspace.onLayoutReady(() => this.refreshMarkdownSyncActions());
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

  private async ensureFolderExists(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);

    if (!normalized) {
      return;
    }

    const parts = normalized.split("/");
    let current = "";

    for (const part of parts) {
      current = current.length === 0 ? part : `${current}/${part}`;
      const existing = this.app.vault.getAbstractFileByPath(current);

      if (!existing) {
        await this.app.vault.createFolder(current);
        continue;
      }

      if (!(existing instanceof TFolder)) {
        throw new Error(`Asset folder path "${normalized}" conflicts with an existing file.`);
      }
    }
  }

  private async ensureAdapterFolderExists(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);

    if (!normalized) {
      return;
    }

    const parts = normalized.split("/");
    let current = "";

    for (const part of parts) {
      current = current.length === 0 ? part : `${current}/${part}`;
      if (await this.app.vault.adapter.exists(current)) {
        continue;
      }

      try {
        await this.app.vault.adapter.mkdir(current);
      } catch {
        if (!(await this.app.vault.adapter.exists(current))) {
          throw new Error(`Failed to create log folder: ${current}`);
        }
      }
    }
  }

  private async createSyncRunLogger(progressModal: SyncProgressReporter): Promise<SyncRunLogger> {
    const logFolder = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/logs`);
    await this.ensureAdapterFolderExists(logFolder);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = normalizePath(`${logFolder}/sync-${timestamp}.log`);
    const header = [
      "# Chats2MD sync log",
      `started_at: ${new Date().toISOString()}`,
      `plugin_version: ${this.manifest.version}`,
      ""
    ].join("\n");
    await this.app.vault.adapter.write(filePath, header);

    return new SyncRunLogger(this.app, filePath, (message) => progressModal.log(message));
  }

  private readFolderFileNames(folderPath: string): Set<string> {
    const names = new Set<string>();
    const folder = this.app.vault.getAbstractFileByPath(folderPath);

    if (!(folder instanceof TFolder)) {
      return names;
    }

    for (const child of folder.children) {
      if (child instanceof TFile) {
        names.add(child.name);
      }
    }

    return names;
  }

  private nextAvailableFileName(baseName: string, usedNames: Set<string>): string {
    if (!usedNames.has(baseName)) {
      usedNames.add(baseName);
      return baseName;
    }

    const dotIndex = baseName.lastIndexOf(".");
    const stem = dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName;
    const extension = dotIndex > 0 ? baseName.slice(dotIndex) : "";
    let suffix = 1;

    while (true) {
      const candidate = `${stem}_${suffix}${extension}`;
      if (!usedNames.has(candidate)) {
        usedNames.add(candidate);
        return candidate;
      }
      suffix += 1;
    }
  }

  private collectConversationDownloadRefs(
    references: ConversationFileReference[]
  ): Array<{ fileId: string; logicalName: string }> {
    const refsById = new Map<string, { fileId: string; logicalName: string }>();

    for (const reference of references) {
      if (!refsById.has(reference.fileId)) {
        refsById.set(reference.fileId, {
          fileId: reference.fileId,
          logicalName: reference.logicalName
        });
      }
    }

    return Array.from(refsById.values());
  }

  private async syncConversationAssets(
    requestConfig: ChatGptRequestConfig,
    conversation: ConversationDetail,
    baseFolder: string,
    logger: SyncRunLogger | null,
    accountLabel: string,
    conversationIndex: number,
    totalConversations: number
  ): Promise<ConversationAssetLinkMap> {
    const linkMap: ConversationAssetLinkMap = {};
    const downloadRefs = this.collectConversationDownloadRefs(conversation.fileReferences);

    if (downloadRefs.length === 0) {
      return linkMap;
    }

    const normalizedBaseFolder = normalizeTargetFolder(baseFolder);
    if (!normalizedBaseFolder) {
      throw new Error("A vault folder is required.");
    }

    const accountFolder = sanitizePathPart(requestConfig.accountId || "account");
    const conversationFolder = sanitizePathPart(conversation.id);
    const assetFolderPath = normalizePath(`${normalizedBaseFolder}/${ASSET_FOLDER_NAME}/${accountFolder}/${conversationFolder}`);
    const logPrefix = `[${accountLabel}] (${conversationIndex}/${totalConversations})`;

    logger?.info(`${logPrefix} Resolving ${downloadRefs.length} asset reference(s) for "${conversation.title}".`);
    logger?.info(`${logPrefix} Asset folder: ${assetFolderPath}`);

    await this.ensureFolderExists(assetFolderPath);
    const usedNames = this.readFolderFileNames(assetFolderPath);

    for (const [assetIndex, ref] of downloadRefs.entries()) {
      const perAssetPrefix = `${logPrefix} Asset ${assetIndex + 1}/${downloadRefs.length} (${ref.fileId})`;

      try {
        logger?.info(`${perAssetPrefix} Resolving download metadata.`);
        const info = await fetchConversationFileDownloadInfo(requestConfig, ref.fileId);
        logger?.info(`${perAssetPrefix} Metadata resolved (file_name=${info.fileName || "<empty>"}).`);
        const rawName = sanitizePathPart(info.fileName || ref.logicalName);
        const withExtension = appendExtensionIfMissing(rawName, null);
        const preferredFileName = withExtension || sanitizePathPart(ref.logicalName);
        const preferredPath = normalizePath(`${assetFolderPath}/${preferredFileName}`);
        const preferredExisting = this.app.vault.getAbstractFileByPath(preferredPath);

        if (preferredExisting instanceof TFile) {
          linkMap[ref.fileId] = {
            path: preferredExisting.path,
            fileName: preferredExisting.name
          };
          usedNames.add(preferredExisting.name);
          logger?.info(`${perAssetPrefix} Reusing existing file: ${preferredExisting.path}`);
          continue;
        }

        logger?.info(`${perAssetPrefix} Downloading signed asset URL.`);
        const fileContent = await fetchSignedFileContent(requestConfig, info.downloadUrl);
        const fileNameWithType = appendExtensionIfMissing(preferredFileName, fileContent.contentType);
        const finalFileName = this.nextAvailableFileName(fileNameWithType, usedNames);
        const finalPath = normalizePath(`${assetFolderPath}/${finalFileName}`);
        const existingAtFinalPath = this.app.vault.getAbstractFileByPath(finalPath);

        if (existingAtFinalPath instanceof TFile) {
          linkMap[ref.fileId] = {
            path: existingAtFinalPath.path,
            fileName: existingAtFinalPath.name
          };
          logger?.info(`${perAssetPrefix} Reusing existing file: ${existingAtFinalPath.path}`);
          continue;
        }

        const created = await this.app.vault.createBinary(finalPath, fileContent.data);
        linkMap[ref.fileId] = {
          path: created.path,
          fileName: created.name
        };
        logger?.info(`${perAssetPrefix} Saved asset: ${created.path}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger?.warn(`${perAssetPrefix} Failed to download asset: ${message}`);
      }
    }

    return linkMap;
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

  private readFrontmatterString(file: TFile, key: string): string {
    const value = this.app.metadataCache.getFileCache(file)?.frontmatter?.[key];
    return typeof value === "string" ? value.trim() : "";
  }

  private getConversationFrontmatter(file: TFile): ConversationFrontmatterInfo {
    return {
      conversationId: this.readFrontmatterString(file, CONVERSATION_ID_KEY),
      title: this.readFrontmatterString(file, CONVERSATION_TITLE_KEY),
      createdAt: this.readFrontmatterString(file, CONVERSATION_CREATED_AT_KEY),
      updatedAt: this.readFrontmatterString(file, CONVERSATION_UPDATED_AT_KEY),
      listUpdatedAt: this.readFrontmatterString(file, CONVERSATION_LIST_UPDATED_AT_KEY),
      accountId: this.readFrontmatterString(file, CONVERSATION_ACCOUNT_ID_KEY),
      userId: this.readFrontmatterString(file, CONVERSATION_USER_ID_KEY)
    };
  }

  private isChats2MdConversationFile(file: TFile | null): boolean {
    if (!(file instanceof TFile)) {
      return false;
    }

    return this.getConversationFrontmatter(file).conversationId.length > 0;
  }

  private resolveAccountForConversation(frontmatter: ConversationFrontmatterInfo): StoredSessionAccount {
    const accounts = this.getAccounts();

    if (accounts.length === 0) {
      throw new Error("No session account is configured in plugin settings.");
    }

    if (frontmatter.accountId) {
      const byAccountId = accounts.find((account) => account.accountId === frontmatter.accountId);

      if (byAccountId) {
        return byAccountId;
      }
    }

    if (frontmatter.userId) {
      const byUserId = accounts.filter((account) => account.userId === frontmatter.userId);

      if (byUserId.length === 1) {
        const matched = byUserId[0];
        if (matched) {
          return matched;
        }
      }

      if (byUserId.length > 1) {
        throw new Error(
          `Multiple sessions match user_id "${frontmatter.userId}". Re-run full sync to refresh account_id in note frontmatter.`
        );
      }
    }

    if (accounts.length === 1) {
      const onlyAccount = accounts[0];
      if (onlyAccount) {
        return onlyAccount;
      }
    }

    if (frontmatter.accountId) {
      throw new Error(`No session matches account_id "${frontmatter.accountId}" from note frontmatter.`);
    }

    if (frontmatter.userId) {
      throw new Error(`No session matches user_id "${frontmatter.userId}" from note frontmatter.`);
    }

    throw new Error(
      `Note frontmatter is missing ${CONVERSATION_ACCOUNT_ID_KEY} and ${CONVERSATION_USER_ID_KEY}.`
    );
  }

  private refreshMarkdownSyncActions(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView)) {
        return;
      }

      this.ensureMarkdownSyncAction(leaf.view);
    });
  }

  private ensureMarkdownSyncAction(view: MarkdownView): void {
    let actionEl = this.markdownSyncActionEls.get(view);

    if (!actionEl) {
      actionEl = view.addAction("refresh-cw", "Sync", () => {
        void this.forceSyncConversationFromView(view);
      });
      actionEl.classList.add("chats2md-note-sync-action");
      this.markdownSyncActionEls.set(view, actionEl);
    }

    this.updateMarkdownSyncActionVisibility(view, actionEl);
  }

  private updateMarkdownSyncActionVisibility(view: MarkdownView, actionEl: HTMLElement): void {
    actionEl.style.display = this.isChats2MdConversationFile(view.file) ? "" : "none";
  }

  private async forceSyncConversationFromView(view: MarkdownView): Promise<void> {
    const file = view.file;

    if (!(file instanceof TFile)) {
      new Notice("Open a markdown note before forcing sync.");
      return;
    }

    await this.forceSyncConversationNote(file);
    this.refreshMarkdownSyncActions();
  }

  private async forceSyncConversationNote(file: TFile): Promise<void> {
    if (this.syncWorkerActive) {
      new Notice("A sync job is already running. Wait for it to finish.");
      return;
    }

    const frontmatter = this.getConversationFrontmatter(file);
    if (!frontmatter.conversationId) {
      new Notice("Current note is not a chats2md conversation.");
      return;
    }

    let account: StoredSessionAccount;

    try {
      account = this.resolveAccountForConversation(frontmatter);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(message);
      return;
    }

    let requestConfig: ChatGptRequestConfig;

    try {
      requestConfig = this.getRequestConfig(account);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(message);
      return;
    }

    const accountLabel = this.getAccountLabel(account);
    const fallbackSummary = {
      id: frontmatter.conversationId,
      title: frontmatter.title || file.basename || "Untitled Conversation",
      createdAt: frontmatter.createdAt || frontmatter.updatedAt || "",
      updatedAt: frontmatter.updatedAt || frontmatter.createdAt || ""
    };

    this.syncWorkerActive = true;
    this.suppressSyncStatusBarUpdates = false;
    this.setSyncStatusBar(`ChatGPT sync: forcing ${fallbackSummary.title}`, true);

    try {
      const detail = await fetchConversationDetail(requestConfig, frontmatter.conversationId, fallbackSummary);
      const assetLinks = await this.syncConversationAssets(
        requestConfig,
        detail,
        this.settings.defaultFolder,
        null,
        accountLabel,
        1,
        1
      );
      const noteIndex = indexConversationNotes(this.app);
      const result = await upsertConversationNote(
        this.app,
        noteIndex,
        detail,
        this.settings.defaultFolder,
        {
          accountId: requestConfig.accountId,
          userId: requestConfig.userId,
          userEmail: requestConfig.userEmail
        },
        this.manifest.version,
        frontmatter.listUpdatedAt || detail.updatedAt,
        assetLinks,
        true
      );
      const actionLabel = `${formatActionLabel(result.action)}${result.moved ? " + moved" : ""}`;
      this.setSyncStatusBar(`ChatGPT sync: ${actionLabel.toLowerCase()} "${detail.title}"`, false);
      this.clearSyncStatusBar(6000);
      new Notice(`Chats2MD ${actionLabel}: ${detail.title}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setSyncStatusBar(`ChatGPT sync failed: ${message}`, false);
      this.clearSyncStatusBar(10000);
      new Notice(`Chats2MD force sync failed: ${message}`);
    } finally {
      this.syncWorkerActive = false;
    }
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
    const forceRefresh = values.forceRefresh === true;
    let syncLogger: SyncRunLogger | null = null;
    const logInfo = (message: string): void => {
      if (syncLogger) {
        syncLogger.info(message);
        return;
      }

      progressModal.log(message);
    };
    const logWarn = (message: string): void => {
      if (syncLogger) {
        syncLogger.warn(message);
        return;
      }

      progressModal.log(`Warning: ${message}`);
    };
    const logError = (message: string): void => {
      if (syncLogger) {
        syncLogger.error(message);
        return;
      }

      progressModal.log(`Error: ${message}`);
    };

    try {
      try {
        syncLogger = await this.createSyncRunLogger(progressModal);
        syncLogger.info(`Sync log file: ${syncLogger.filePath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        progressModal.log(`Sync log file unavailable: ${message}`);
      }

      if (!(await this.ensureSyncCanContinue(control, progressModal, counts))) {
        return;
      }

      const selectedAccounts = this.getSelectedAccounts(values);
      const noteIndex = indexConversationNotes(this.app);
      logInfo(`Starting sync for ${selectedAccounts.length} account(s).`);
      logInfo(`Force refresh is ${forceRefresh ? "enabled" : "disabled"}.`);
      this.setSyncStatusBar(this.buildSyncStatusText(processedConversations, totalConversations, "starting"), true);

      for (const [accountIndex, account] of selectedAccounts.entries()) {
        if (!(await this.ensureSyncCanContinue(control, progressModal, counts))) {
          return;
        }

        const accountLabel = this.getAccountLabel(account);
        progressModal.setPreparing(`Syncing ${accountLabel} (${accountIndex + 1}/${selectedAccounts.length}): fetching conversation list...`);
        logInfo(`[${accountIndex + 1}/${selectedAccounts.length}] Fetching conversation list for ${accountLabel}.`);
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
          logError(`[${accountLabel}] Failed to load session: ${message}`);
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
          logError(`[${accountLabel}] Failed to fetch conversation list: ${message}`);
          continue;
        }

        logInfo(`[${accountLabel}] Found ${summaries.length} conversation(s).`);
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
          logInfo(`[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Processing "${summary.title}".`);

          const existingSyncMetadata = getIndexedConversationSyncMetadata(
            this.app,
            noteIndex,
            requestConfig.accountId,
            summary.id
          );

          const localListUpdatedAt = existingSyncMetadata.listUpdatedAt ?? existingSyncMetadata.updatedAt;
          const hasMatchingTitle = (existingSyncMetadata.title ?? "") === summary.title;

          if (!forceRefresh && hasMatchingTitle && hasMatchingUpdatedAt(localListUpdatedAt, summary.updatedAt)) {
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

              logInfo(
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
              logError(`[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Failed while reconciling note path: "${summary.title}" - ${message}`);
            }
          } else {
            const mismatchReasons: string[] = [];
            if (forceRefresh) {
              mismatchReasons.push("force refresh enabled");
            }
            if (!hasMatchingTitle) {
              mismatchReasons.push("title changed");
            }

            if (!hasMatchingUpdatedAt(localListUpdatedAt, summary.updatedAt)) {
              mismatchReasons.push("updated_at changed");
            }

            logInfo(
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
                syncLogger,
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

              const assetLinks = await this.syncConversationAssets(
                requestConfig,
                detail,
                values.folder,
                syncLogger,
                accountLabel,
                conversationIndex + 1,
                summaries.length
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
                this.manifest.version,
                summary.updatedAt,
                assetLinks,
                forceRefresh
              );

              counts[result.action] += 1;

              if (result.moved) {
                counts.moved += 1;
              }
              logInfo(
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
              logError(`[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Failed: "${summary.title}" - ${message}`);
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
            logInfo(
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

      logInfo("Sync complete.");
      progressModal.complete(totalConversations, counts, failures);
      new Notice(summarizeCounts(totalConversations, counts));
      this.setSyncStatusBar(this.buildSyncStatusText(processedConversations, totalConversations, "complete"), false);
      this.clearSyncStatusBar(8000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      progressModal.fail(message, counts);
      logError(`Sync failed: ${message}`);
      new Notice(message);
      this.setSyncStatusBar(`ChatGPT sync failed: ${message}`, false);
      this.clearSyncStatusBar(10000);
    } finally {
      if (syncLogger) {
        await syncLogger.flush();
      }
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
    logger: SyncRunLogger | null,
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
        logger?.warn(
          `${displayTitle} detail fetch retry ${attempt + 1}/${DETAIL_FETCH_MAX_ATTEMPTS}: ${message}`
        );
        progressModal.setRetry(displayTitle, index, total, attempt + 1, message);
        await sleep(attempt * 750);
      }
    }

    if (lastError) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      logger?.error(`${displayTitle} detail fetch failed after ${DETAIL_FETCH_MAX_ATTEMPTS} attempts: ${message}`);
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
