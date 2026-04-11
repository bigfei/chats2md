import { MarkdownView, Plugin, TFile, TFolder, addIcon, normalizePath } from "obsidian";

import { parseSessionJson } from "../chatgpt/api";
import { SyncChatGptModal, type SyncExecutionControl, type SyncProgressReporter } from "../ui/import-modal";
import { Chats2MdSettingTab } from "../ui/settings";
import { ForceSyncUiController } from "../ui/force-sync-ui";
import { forceSyncConversationNote as forceSyncConversationNoteHelper } from "./force-sync";
import {
  CONVERSATION_ACCOUNT_ID_KEY,
  CONVERSATION_CREATED_AT_KEY,
  CONVERSATION_ID_KEY,
  CONVERSATION_LIST_UPDATED_AT_KEY,
  CONVERSATION_TITLE_KEY,
  CONVERSATION_UPDATED_AT_KEY,
  CONVERSATION_USER_ID_KEY,
  getStoredAccountDisplayName,
  isImportedChatGptConversationFrontmatter,
  normalizeAssetStorageMode,
  normalizeSyncTuningSettings,
  type ConversationFrontmatterInfo,
  type LegacySettingsPayload,
  normalizeStoredAccount,
  resolveSyncReportFolder,
  readString,
  sortAccounts,
  SyncRunLogger,
} from "./helpers";
import { syncConversationAssetsForConversation } from "./asset-sync";
import { runRebuildNotesFromCachedJson } from "./rebuild";
import { checkStoredAccountHealth, type AccountHealthResult } from "./account-health";
import {
  migrateLegacySessionIfNeeded as migrateLegacySessionIfNeededHelper,
  removeSessionAccount as removeSessionAccountHelper,
  upsertSessionAccount as upsertSessionAccountHelper,
} from "./session-account";
import {
  handleSync as handleSyncHelper,
  openSyncModal as openSyncModalHelper,
  startAllAccountsSync as startAllAccountsSyncHelper,
} from "./sync-modal";
import {
  buildSyncStatusText as buildSyncStatusTextHelper,
  clearSyncStatusBar as clearSyncStatusBarHelper,
  setSyncStatusBar as setSyncStatusBarHelper,
} from "./sync-status";
import { renderSyncRunReport } from "../sync/report";
import { configureNormalizePath } from "../path/normalization";
import { cleanupSyncReportFiles } from "./sync-report-cleanup";
import {
  type AssetStorageMode,
  DEFAULT_SETTINGS,
  DEFAULT_SYNC_TUNING_SETTINGS,
  type ChatGptRequestConfig,
  type Chats2MdSettings,
  type ConversationAssetLinkMap,
  type ConversationDetail,
  type SyncRunReport,
  type StoredSessionAccount,
  type SyncModalValues,
} from "../shared/types";

const CHATGPT_IMPORT_SYNC_ICON_ID = "chats2md-chatgpt-import-sync";
const CHATGPT_IMPORT_SYNC_ICON_SVG = `
  <g transform="translate(8 8) scale(1.9)" fill="currentColor">
    <path d="M37.532 16.87a9.963 9.963 0 0 0-.856-8.184 10.078 10.078 0 0 0-10.855-4.835A9.964 9.964 0 0 0 18.306.5a10.079 10.079 0 0 0-9.614 6.977 9.967 9.967 0 0 0-6.664 4.834 10.08 10.08 0 0 0 1.24 11.817 9.965 9.965 0 0 0 .856 8.185 10.079 10.079 0 0 0 10.855 4.835 9.965 9.965 0 0 0 7.516 3.35 10.078 10.078 0 0 0 9.617-6.981 9.967 9.967 0 0 0 6.663-4.834 10.079 10.079 0 0 0-1.243-11.813ZM22.498 37.886a7.474 7.474 0 0 1-4.799-1.735c.061-.033.168-.091.237-.134l7.964-4.6a1.294 1.294 0 0 0 .655-1.134V19.054l3.366 1.944a.12.12 0 0 1 .066.092v9.299a7.505 7.505 0 0 1-7.49 7.496ZM6.392 31.006a7.471 7.471 0 0 1-.894-5.023c.06.036.162.099.237.141l7.964 4.6a1.297 1.297 0 0 0 1.308 0l9.724-5.614v3.888a.12.12 0 0 1-.048.103l-8.051 4.649a7.504 7.504 0 0 1-10.24-2.744ZM4.297 13.62A7.469 7.469 0 0 1 8.2 10.333c0 .068-.004.19-.004.274v9.201a1.294 1.294 0 0 0 .654 1.132l9.723 5.614-3.366 1.944a.12.12 0 0 1-.114.012L7.044 23.86a7.504 7.504 0 0 1-2.747-10.24Zm27.658 6.437-9.724-5.615 3.367-1.943a.121.121 0 0 1 .114-.012l8.048 4.648a7.498 7.498 0 0 1-1.158 13.528V21.36a1.293 1.293 0 0 0-.647-1.132v-.17Zm3.35-5.043c-.059-.037-.162-.099-.236-.141l-7.965-4.6a1.298 1.298 0 0 0-1.308 0l-9.723 5.614v-3.888a.12.12 0 0 1 .048-.103l8.05-4.645a7.497 7.497 0 0 1 11.135 7.763Zm-21.063 6.929-3.367-1.944a.12.12 0 0 1-.065-.092v-9.299a7.497 7.497 0 0 1 12.293-5.756 6.94 6.94 0 0 0-.236.134l-7.965 4.6a1.294 1.294 0 0 0-.654 1.132l-.006 11.225Zm1.829-3.943 4.33-2.501 4.332 2.5v5l-4.331 2.5-4.331-2.5V18Z"/>
  </g>
  <g stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M74 70V83"/>
    <path d="M68 77L74 83L80 77"/>
  </g>
`;

configureNormalizePath(normalizePath);

export default class Chats2MdPlugin extends Plugin {
  settings: Chats2MdSettings = DEFAULT_SETTINGS;
  private legacySessionMigrationWarning: string | null = null;
  private syncStatusBarEl: HTMLElement | null = null;
  private activeSyncModal: SyncChatGptModal | null = null;
  private forceSyncUiController: ForceSyncUiController | null = null;
  private syncWorkerActive = false;
  private syncStatusClearTimer: number | null = null;
  private suppressSyncStatusBarUpdates = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    addIcon(CHATGPT_IMPORT_SYNC_ICON_ID, CHATGPT_IMPORT_SYNC_ICON_SVG);
    const ribbonAction = this.addRibbonIcon(CHATGPT_IMPORT_SYNC_ICON_ID, "Sync conversations", () => {
      this.openSyncModal();
    });
    ribbonAction.classList.add("chats2md-ribbon-action-bottom");

    this.addCommand({
      id: "import-chatgpt-conversations",
      name: "Sync all accounts",
      callback: () => {
        this.startAllAccountsSync();
      },
    });

    this.addCommand({
      id: "rebuild-chatgpt-notes-from-json",
      name: "Rebuild from JSON",
      callback: () => {
        void this.rebuildNotesFromCachedJson();
      },
    });

    const settingTab = new Chats2MdSettingTab(this.app, this);
    this.addSettingTab(settingTab);

    this.syncStatusBarEl = this.addStatusBarItem();
    this.syncStatusBarEl.classList.add("chats2md-sync-statusbar");
    this.syncStatusBarEl.classList.add("is-hidden");
    this.syncStatusBarEl.addEventListener("click", () => {
      if (this.activeSyncModal?.isSyncInProgress()) {
        this.activeSyncModal.open();
      }
    });

    this.forceSyncUiController = new ForceSyncUiController(this.app.workspace, {
      isSyncing: () => this.syncWorkerActive,
      isEligibleFile: (file) => this.isForceSyncEligibleFile(file),
      onForceSync: async (file) => {
        await this.forceSyncConversationNote(file);
      },
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.forceSyncUiController?.refreshMarkdownSyncActions()),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.forceSyncUiController?.refreshMarkdownSyncActions()),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", () => this.forceSyncUiController?.refreshMarkdownSyncActions()),
    );
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
        if (!(file instanceof TFile) || !leaf || !(leaf.view instanceof MarkdownView)) {
          return;
        }

        if (leaf.view.file?.path !== file.path) {
          return;
        }
        this.forceSyncUiController?.addForceSyncMenuItem(menu, file);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, _editor, info) => {
        const file = info.file;
        if (!(file instanceof TFile)) {
          return;
        }

        this.forceSyncUiController?.addForceSyncMenuItem(menu, file);
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      this.forceSyncUiController?.refreshMarkdownSyncActions();
    });
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as LegacySettingsPayload | null;
    const savedAccounts = Array.isArray(saved?.accounts)
      ? saved.accounts
          .map(normalizeStoredAccount)
          .filter((account): account is StoredSessionAccount => account !== null)
      : [];
    const legacySessionJson = readString(saved?.legacySessionJson).trim() || readString(saved?.sessionJson);

    this.settings = {
      ...DEFAULT_SETTINGS,
      defaultFolder: readString(saved?.defaultFolder, DEFAULT_SETTINGS.defaultFolder),
      conversationPathTemplate:
        readString(saved?.conversationPathTemplate, DEFAULT_SETTINGS.conversationPathTemplate).trim() ||
        DEFAULT_SETTINGS.conversationPathTemplate,
      assetStorageMode: normalizeAssetStorageMode(saved?.assetStorageMode),
      skipExistingLocalConversations: saved?.skipExistingLocalConversations !== false,
      generateSyncReport: saved?.generateSyncReport !== false,
      syncReportFolder:
        readString(saved?.syncReportFolder, DEFAULT_SETTINGS.syncReportFolder).trim() ||
        DEFAULT_SETTINGS.syncReportFolder,
      debugLogging: saved?.debugLogging === true,
      saveConversationJson: saved?.saveConversationJson === true,
      syncTuning: normalizeSyncTuningSettings(saved?.syncTuning, DEFAULT_SYNC_TUNING_SETTINGS),
      accounts: sortAccounts(savedAccounts),
      legacySessionJson,
    };

    await this.migrateLegacySessionIfNeeded();
  }

  async saveSettings(): Promise<void> {
    this.settings.syncTuning = normalizeSyncTuningSettings(this.settings.syncTuning, DEFAULT_SYNC_TUNING_SETTINGS);
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

  async checkAccountHealth(account: StoredSessionAccount): Promise<AccountHealthResult> {
    return checkStoredAccountHealth(
      {
        getSessionSecret: (secretId) => this.getSessionSecret(secretId),
        manifestVersion: this.manifest.version,
      },
      account,
    );
  }

  async setAccountDisabled(accountId: string, disabled: boolean): Promise<StoredSessionAccount | null> {
    const current = this.settings.accounts.find((account) => account.accountId === accountId);

    if (!current) {
      return null;
    }

    const updated = {
      ...current,
      disabled,
      updatedAt: new Date().toISOString(),
    };
    this.settings.accounts = sortAccounts([
      ...this.settings.accounts.filter((account) => account.accountId !== accountId),
      updated,
    ]);
    await this.saveSettings();
    return updated;
  }

  getAllConfiguredAccounts(): StoredSessionAccount[] {
    return sortAccounts(this.settings.accounts);
  }

  private isDebugLoggingEnabled(): boolean {
    return this.settings.debugLogging === true;
  }

  logInfo(message: string, context?: unknown): void {
    if (!this.isDebugLoggingEnabled()) {
      return;
    }

    if (typeof context === "undefined") {
      console.debug(`[chats2md] ${message}`);
      return;
    }

    console.debug(`[chats2md] ${message}`, context);
  }

  logWarn(message: string, context?: unknown): void {
    if (!this.isDebugLoggingEnabled()) {
      return;
    }

    if (typeof context === "undefined") {
      console.warn(`[chats2md] ${message}`);
      return;
    }

    console.warn(`[chats2md] ${message}`, context);
  }

  logError(message: string, context?: unknown): void {
    if (typeof context === "undefined") {
      console.error(`[chats2md] ${message}`);
      return;
    }

    console.error(`[chats2md] ${message}`, context);
  }

  async upsertSessionAccount(rawSessionJson: string, parsed?: ChatGptRequestConfig): Promise<StoredSessionAccount> {
    return upsertSessionAccountHelper(
      {
        app: this.app,
        manifestVersion: this.manifest.version,
        settings: this.settings,
        setLegacySessionMigrationWarning: (value) => {
          this.legacySessionMigrationWarning = value;
        },
        saveSettings: () => this.saveSettings(),
      },
      rawSessionJson,
      parsed,
    );
  }

  async removeSessionAccount(accountId: string): Promise<void> {
    await removeSessionAccountHelper(
      {
        app: this.app,
        manifestVersion: this.manifest.version,
        settings: this.settings,
        setLegacySessionMigrationWarning: (value) => {
          this.legacySessionMigrationWarning = value;
        },
        saveSettings: () => this.saveSettings(),
      },
      accountId,
    );
  }

  private async migrateLegacySessionIfNeeded(): Promise<void> {
    await migrateLegacySessionIfNeededHelper({
      app: this.app,
      manifestVersion: this.manifest.version,
      settings: this.settings,
      setLegacySessionMigrationWarning: (value) => {
        this.legacySessionMigrationWarning = value;
      },
      saveSettings: () => this.saveSettings(),
    });
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

  private nextAvailablePath(basePath: string): string {
    let candidate = normalizePath(basePath);
    let suffix = 2;

    while (this.app.vault.getAbstractFileByPath(candidate)) {
      const dotIndex = basePath.lastIndexOf(".");
      const stem = dotIndex > 0 ? basePath.slice(0, dotIndex) : basePath;
      const extension = dotIndex > 0 ? basePath.slice(dotIndex) : "";
      candidate = normalizePath(`${stem}-${suffix}${extension}`);
      suffix += 1;
    }

    return candidate;
  }

  private async createSyncRunLogger(
    progressSink: { log(message: string): void },
    syncFolder: string,
  ): Promise<SyncRunLogger> {
    const reportFolder = resolveSyncReportFolder(syncFolder, this.settings.syncReportFolder);
    await this.ensureFolderExists(reportFolder);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = this.nextAvailablePath(`${reportFolder}/sync-${timestamp}.log`);
    const header = [
      "# Chats2MD sync log",
      `started_at: ${new Date().toISOString()}`,
      `plugin_version: ${this.manifest.version}`,
      "",
    ].join("\n");
    await this.app.vault.create(filePath, header);

    return new SyncRunLogger(this.app, filePath, (message) => progressSink.log(message));
  }

  private async writeSyncReport(report: SyncRunReport): Promise<string | null> {
    if (!this.settings.generateSyncReport) {
      return null;
    }

    const reportFolder = resolveSyncReportFolder(report.folder, this.settings.syncReportFolder);
    await this.ensureFolderExists(reportFolder);
    const timestamp = report.finishedAt.replace(/[:.]/g, "-");
    const reportPath = this.nextAvailablePath(`${reportFolder}/sync-${timestamp}.md`);

    await this.app.vault.create(reportPath, renderSyncRunReport(report));
    return reportPath;
  }

  async cleanupSyncReports(
    syncFolder: string,
    options: {
      keepLatest?: number;
    } = {},
  ): Promise<{ removedPaths: string[]; keptPaths: string[]; reportFolder: string }> {
    return cleanupSyncReportFiles(this.app, syncFolder, this.settings.syncReportFolder, options);
  }

  private getConversationJsonSidecarPath(notePath: string): string {
    const normalized = normalizePath(notePath);
    if (!normalized) {
      throw new Error("Note path is required for JSON sidecar operations.");
    }

    const hasMarkdownExtension = normalized.toLowerCase().endsWith(".md");
    const stem = hasMarkdownExtension ? normalized.slice(0, -3) : normalized;
    return normalizePath(`${stem}.json`);
  }

  private async saveConversationJsonSidecar(notePath: string, payload: unknown): Promise<string> {
    const sidecarPath = this.getConversationJsonSidecarPath(notePath);
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const existing = this.app.vault.getAbstractFileByPath(sidecarPath);

    if (!existing) {
      await this.app.vault.create(sidecarPath, serialized);
      return sidecarPath;
    }

    if (existing instanceof TFile) {
      await this.app.vault.process(existing, () => serialized);
      return sidecarPath;
    }

    throw new Error(`JSON sidecar path conflicts with a folder: ${sidecarPath}`);
  }

  private async moveConversationJsonSidecar(sourceNotePath: string, targetNotePath: string): Promise<boolean> {
    const sourceSidecarPath = this.getConversationJsonSidecarPath(sourceNotePath);
    const targetSidecarPath = this.getConversationJsonSidecarPath(targetNotePath);

    if (sourceSidecarPath === targetSidecarPath) {
      return false;
    }

    const source = this.app.vault.getAbstractFileByPath(sourceSidecarPath);
    if (!(source instanceof TFile)) {
      return false;
    }

    const target = this.app.vault.getAbstractFileByPath(targetSidecarPath);
    if (target instanceof TFolder) {
      throw new Error(`JSON sidecar target conflicts with folder: ${targetSidecarPath}`);
    }

    if (target instanceof TFile) {
      throw new Error(`JSON sidecar target already exists: ${targetSidecarPath}`);
    }

    await this.app.fileManager.renameFile(source, targetSidecarPath);
    return true;
  }

  private async readConversationJsonSidecar(notePath: string): Promise<unknown> {
    const sidecarPath = this.getConversationJsonSidecarPath(notePath);
    const sidecar = this.app.vault.getAbstractFileByPath(sidecarPath);

    if (!(sidecar instanceof TFile)) {
      return null;
    }

    const raw = await this.app.vault.read(sidecar);
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON in sidecar ${sidecarPath}: ${message}`);
    }
  }

  async rebuildNotesFromCachedJson(): Promise<void> {
    await runRebuildNotesFromCachedJson({
      app: this.app,
      settings: {
        defaultFolder: this.settings.defaultFolder,
        conversationPathTemplate: this.settings.conversationPathTemplate,
        assetStorageMode: this.settings.assetStorageMode,
      },
      manifestVersion: this.manifest.version,
      isSyncWorkerActive: () => this.syncWorkerActive,
      setSyncWorkerActive: (value) => {
        this.syncWorkerActive = value;
      },
      setSuppressSyncStatusBarUpdates: (value) => {
        this.suppressSyncStatusBarUpdates = value;
      },
      setSyncStatusBar: (text, active) => this.setSyncStatusBar(text, active),
      buildSyncStatusText: (processed, total, phase) => this.buildSyncStatusText(processed, total, phase),
      clearSyncStatusBar: (delayMs) => this.clearSyncStatusBar(delayMs),
      createSyncRunLogger: (progressSink, syncFolder) => this.createSyncRunLogger(progressSink, syncFolder),
      getConversationFrontmatter: (file) => this.getConversationFrontmatter(file),
      resolveAccountForConversation: (frontmatter) => this.resolveAccountForConversation(frontmatter),
      getAccountLabel: (account) => this.getAccountLabel(account),
      getRequestConfig: (account) => this.getRequestConfig(account),
      readConversationJsonSidecar: (notePath) => this.readConversationJsonSidecar(notePath),
      syncConversationAssets: (
        requestConfig,
        conversation,
        baseFolder,
        conversationPathTemplate,
        assetStorageMode,
        logger,
        accountLabel,
        conversationIndex,
        totalConversations,
        stopSignal,
      ) =>
        this.syncConversationAssets(
          requestConfig,
          conversation,
          baseFolder,
          conversationPathTemplate,
          assetStorageMode,
          logger,
          accountLabel,
          conversationIndex,
          totalConversations,
          stopSignal,
        ),
      moveConversationJsonSidecar: (sourceNotePath, targetNotePath) =>
        this.moveConversationJsonSidecar(sourceNotePath, targetNotePath),
      shouldGenerateSyncReport: () => this.settings.generateSyncReport,
      writeSyncReport: (report) => this.writeSyncReport(report),
      getAccounts: () => this.getAccounts(),
      logInfo: (message, context) => this.logInfo(message, context),
      logWarn: (message, context) => this.logWarn(message, context),
      logError: (message, context) => this.logError(message, context),
    });
  }

  private async syncConversationAssets(
    requestConfig: ChatGptRequestConfig,
    conversation: ConversationDetail,
    baseFolder: string,
    conversationPathTemplate: string,
    assetStorageMode: AssetStorageMode,
    logger: SyncRunLogger | null,
    accountLabel: string,
    conversationIndex: number,
    totalConversations: number,
    stopSignal?: AbortSignal,
  ): Promise<ConversationAssetLinkMap> {
    return syncConversationAssetsForConversation(
      {
        app: this.app,
        ensureFolderExists: (folderPath) => this.ensureFolderExists(folderPath),
      },
      {
        requestConfig,
        conversation,
        baseFolder,
        conversationPathTemplate,
        assetStorageMode,
        logger,
        accountLabel,
        conversationIndex,
        totalConversations,
        stopSignal,
      },
    );
  }

  private getSelectedAccounts(values: SyncModalValues): StoredSessionAccount[] {
    const accounts = this.getAccounts();
    const enabledAccounts = accounts.filter((account) => !account.disabled);

    if (values.scope === "all") {
      return enabledAccounts;
    }

    const accountId = (values.accountId ?? "").trim();

    if (!accountId) {
      throw new Error("No account selected for sync.");
    }

    const selected = enabledAccounts.find((account) => account.accountId === accountId);

    if (!selected) {
      throw new Error(`Selected enabled account is no longer available: ${accountId}`);
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
    return getStoredAccountDisplayName(account);
  }

  private readFrontmatterString(file: TFile, key: string): string {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    const value = frontmatter?.[key];
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
      userId: this.readFrontmatterString(file, CONVERSATION_USER_ID_KEY),
    };
  }

  private isForceSyncEligibleFile(file: TFile | null): boolean {
    if (!(file instanceof TFile)) {
      return false;
    }

    const frontmatter = this.getConversationFrontmatter(file);
    return isImportedChatGptConversationFrontmatter(frontmatter);
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
          `Multiple sessions match user_id "${frontmatter.userId}". Re-run full sync to refresh account_id in note frontmatter.`,
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

    throw new Error(`Note frontmatter is missing ${CONVERSATION_ACCOUNT_ID_KEY} and ${CONVERSATION_USER_ID_KEY}.`);
  }

  private async forceSyncConversationNote(file: TFile): Promise<void> {
    await forceSyncConversationNoteHelper(
      {
        app: this.app,
        settings: this.settings,
        manifest: this.manifest,
        isSyncWorkerActive: () => this.syncWorkerActive,
        setSyncWorkerActive: (value) => {
          this.syncWorkerActive = value;
        },
        setSuppressSyncStatusBarUpdates: (value) => {
          this.suppressSyncStatusBarUpdates = value;
        },
        getConversationFrontmatter: (targetFile) => this.getConversationFrontmatter(targetFile),
        resolveAccountForConversation: (frontmatter) => this.resolveAccountForConversation(frontmatter),
        getRequestConfig: (account) => this.getRequestConfig(account),
        getAccountLabel: (account) => this.getAccountLabel(account),
        readConversationJsonSidecar: (notePath) => this.readConversationJsonSidecar(notePath),
        saveConversationJsonSidecar: (notePath, payload) => this.saveConversationJsonSidecar(notePath, payload),
        moveConversationJsonSidecar: (sourceNotePath, targetNotePath) =>
          this.moveConversationJsonSidecar(sourceNotePath, targetNotePath),
        syncConversationAssets: (
          requestConfig,
          conversation,
          baseFolder,
          conversationPathTemplate,
          assetStorageMode,
          logger,
          accountLabel,
          conversationIndex,
          totalConversations,
          stopSignal,
        ) =>
          this.syncConversationAssets(
            requestConfig,
            conversation,
            baseFolder,
            conversationPathTemplate,
            assetStorageMode,
            logger,
            accountLabel,
            conversationIndex,
            totalConversations,
            stopSignal,
          ),
        setSyncStatusBar: (text, active) => this.setSyncStatusBar(text, active),
        clearSyncStatusBar: (delayMs) => this.clearSyncStatusBar(delayMs),
        logInfo: (message, context) => this.logInfo(message, context),
        logWarn: (message, context) => this.logWarn(message, context),
      },
      file,
    );
  }

  private buildSyncStatusText(processed: number, total: number, phase: string): string {
    return buildSyncStatusTextHelper(processed, total, phase);
  }

  private setSyncStatusBar(text: string, active = false): void {
    setSyncStatusBarHelper(this.createSyncStatusHost(), text, active);
  }

  private clearSyncStatusBar(delayMs = 0, force = false): void {
    clearSyncStatusBarHelper(this.createSyncStatusHost(), delayMs, force);
  }

  private openSyncModal(): void {
    openSyncModalHelper(this.createSyncModalHost());
  }

  private startAllAccountsSync(): void {
    startAllAccountsSyncHelper(this.createSyncModalHost());
  }

  private async handleSync(
    values: SyncModalValues,
    progressModal: SyncProgressReporter,
    control: SyncExecutionControl,
    modal: SyncChatGptModal,
  ): Promise<void> {
    await handleSyncHelper(this.createSyncModalHost(), values, progressModal, control, modal);
  }

  private createSyncStatusHost() {
    return {
      getSuppressSyncStatusBarUpdates: () => this.suppressSyncStatusBarUpdates,
      getSyncStatusClearTimer: () => this.syncStatusClearTimer,
      setSyncStatusClearTimer: (value: number | null) => {
        this.syncStatusClearTimer = value;
      },
      getSyncStatusBarEl: () => this.syncStatusBarEl,
      getActiveSyncModal: () => this.activeSyncModal,
    };
  }

  private createSyncModalHost() {
    return {
      ...this.createSyncStatusHost(),
      app: this.app,
      manifest: this.manifest,
      settings: this.settings,
      getSyncWorkerActive: () => this.syncWorkerActive,
      setSyncWorkerActive: (value: boolean) => {
        this.syncWorkerActive = value;
      },
      setSuppressSyncStatusBarUpdates: (value: boolean) => {
        this.suppressSyncStatusBarUpdates = value;
      },
      setActiveSyncModal: (value: SyncChatGptModal | null) => {
        this.activeSyncModal = value;
      },
      saveSettings: () => this.saveSettings(),
      getAccounts: () => this.getAccounts(),
      getAllConfiguredAccounts: () => this.getAllConfiguredAccounts(),
      getSelectedAccounts: (values: SyncModalValues) => this.getSelectedAccounts(values),
      checkAccountHealth: (account: StoredSessionAccount) => this.checkAccountHealth(account),
      getRequestConfig: (account: StoredSessionAccount) => this.getRequestConfig(account),
      getAccountLabel: (account: StoredSessionAccount) => this.getAccountLabel(account),
      createSyncRunLogger: (progressSink: { log(message: string): void }, syncFolder: string) =>
        this.createSyncRunLogger(progressSink, syncFolder),
      saveConversationJsonSidecar: (notePath: string, payload: unknown) =>
        this.saveConversationJsonSidecar(notePath, payload),
      moveConversationJsonSidecar: (sourceNotePath: string, targetNotePath: string) =>
        this.moveConversationJsonSidecar(sourceNotePath, targetNotePath),
      syncConversationAssets: (
        requestConfig: ChatGptRequestConfig,
        conversation: ConversationDetail,
        baseFolder: string,
        conversationPathTemplate: string,
        assetStorageMode: AssetStorageMode,
        logger: SyncRunLogger | null,
        accountLabel: string,
        conversationIndex: number,
        totalConversations: number,
        stopSignal?: AbortSignal,
      ) =>
        this.syncConversationAssets(
          requestConfig,
          conversation,
          baseFolder,
          conversationPathTemplate,
          assetStorageMode,
          logger,
          accountLabel,
          conversationIndex,
          totalConversations,
          stopSignal,
        ),
      writeSyncReport: (report: SyncRunReport) => this.writeSyncReport(report),
      buildSyncStatusText: (processed: number, total: number, phase: string) =>
        this.buildSyncStatusText(processed, total, phase),
      setSyncStatusBar: (text: string, active?: boolean) => this.setSyncStatusBar(text, active),
      clearSyncStatusBar: (delayMs?: number, force?: boolean) => this.clearSyncStatusBar(delayMs, force),
      getSyncTuning: () => this.settings.syncTuning,
    };
  }
}
