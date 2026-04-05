import { App, MarkdownView, Notice, Plugin, TFile, TFolder, addIcon, normalizePath } from "obsidian";

import {
  fetchConversationDetailWithPayload,
  fetchConversationFileDownloadInfo,
  fetchSignedFileContent,
  parseConversationDetailPayload,
  parseSessionJson
} from "./chatgpt-api";
import { resolveAssetFolderPaths } from "./asset-storage";
import { SyncChatGptModal, type SyncExecutionControl, type SyncProgressReporter } from "./import-modal";
import {
  indexConversationNotes,
  upsertConversationNote
} from "./note-writer";
import { Chats2MdSettingTab } from "./settings";
import { ForceSyncUiController } from "./force-sync-ui";
import {
  CONVERSATION_ACCOUNT_ID_KEY,
  CONVERSATION_CREATED_AT_KEY,
  CONVERSATION_ID_KEY,
  CONVERSATION_LIST_UPDATED_AT_KEY,
  CONVERSATION_TITLE_KEY,
  CONVERSATION_UPDATED_AT_KEY,
  CONVERSATION_USER_ID_KEY,
  SECRET_ID_PREFIX,
  appendExtensionIfMissing,
  createEmptyCounts,
  formatAssetStorageMode,
  formatActionLabel,
  normalizeAssetStorageMode,
  type ConversationFrontmatterInfo,
  type LegacySettingsPayload,
  normalizeStoredAccount,
  normalizeTargetFolder,
  readString,
  sanitizePathPart,
  sortAccounts,
  summarizeCounts,
  SyncRunLogger
} from "./main-helpers";
import { runFullSync } from "./full-sync";
import { renderSyncRunReport } from "./sync-report";
import {
  type AssetStorageMode,
  DEFAULT_SETTINGS,
  type ChatGptRequestConfig,
  type Chats2MdSettings,
  type ConversationAssetLinkMap,
  type ConversationDetail,
  type ConversationFileReference,
  type SyncReportConversationEntry,
  type SyncRunReport,
  type SyncRunStatus,
  type StoredSessionAccount,
  type SyncModalValues
} from "./types";

const OPENAI_RIBBON_ICON_ID = "chats2md-openai-knot";
const OPENAI_RIBBON_ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">
  <g stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="10" y="2.5" width="4" height="11" rx="2" />
    <rect x="10" y="2.5" width="4" height="11" rx="2" transform="rotate(60 12 12)" />
    <rect x="10" y="2.5" width="4" height="11" rx="2" transform="rotate(120 12 12)" />
    <rect x="10" y="2.5" width="4" height="11" rx="2" transform="rotate(180 12 12)" />
    <rect x="10" y="2.5" width="4" height="11" rx="2" transform="rotate(240 12 12)" />
    <rect x="10" y="2.5" width="4" height="11" rx="2" transform="rotate(300 12 12)" />
  </g>
  <circle cx="12" cy="12" r="1.6" fill="currentColor" />
</svg>
`;

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

    addIcon(OPENAI_RIBBON_ICON_ID, OPENAI_RIBBON_ICON_SVG);
    const ribbonAction = this.addRibbonIcon(OPENAI_RIBBON_ICON_ID, "Sync ChatGPT conversations", () => {
      this.openSyncModal();
    });
    ribbonAction.classList.add("chats2md-ribbon-action-bottom");

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

    this.forceSyncUiController = new ForceSyncUiController(this.app.workspace, {
      isSyncing: () => this.syncWorkerActive,
      isEligibleFile: (file) => this.isForceSyncEligibleFile(file),
      onForceSync: async (file) => {
        await this.forceSyncConversationNote(file);
      }
    });

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.forceSyncUiController?.refreshMarkdownSyncActions()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.forceSyncUiController?.refreshMarkdownSyncActions()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.forceSyncUiController?.refreshMarkdownSyncActions()));
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
      if (!(file instanceof TFile) || !leaf || !(leaf.view instanceof MarkdownView)) {
        return;
      }

      if (leaf.view.file?.path !== file.path) {
        return;
      }
      this.forceSyncUiController?.addForceSyncMenuItem(menu, file);
    }));
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, _editor, info) => {
      const file = info.file;
      if (!(file instanceof TFile)) {
        return;
      }

      this.forceSyncUiController?.addForceSyncMenuItem(menu, file);
    }));
    this.app.workspace.onLayoutReady(() => this.forceSyncUiController?.refreshMarkdownSyncActions());
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
      conversationPathTemplate: readString(saved?.conversationPathTemplate, DEFAULT_SETTINGS.conversationPathTemplate).trim()
        || DEFAULT_SETTINGS.conversationPathTemplate,
      assetStorageMode: normalizeAssetStorageMode(saved?.assetStorageMode),
      saveConversationJson: saved?.saveConversationJson === true,
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

  private async createSyncRunLogger(progressSink: { log(message: string): void }): Promise<SyncRunLogger> {
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

    return new SyncRunLogger(this.app, filePath, (message) => progressSink.log(message));
  }

  private async writeSyncReport(report: SyncRunReport): Promise<string> {
    const normalizedFolder = normalizeTargetFolder(report.folder);

    if (!normalizedFolder) {
      throw new Error("Cannot write sync report because sync folder is empty.");
    }

    const reportFolder = normalizePath(`${normalizedFolder}/result`);
    await this.ensureFolderExists(reportFolder);
    const timestamp = report.finishedAt.replace(/[:.]/g, "-");
    const basePath = normalizePath(`${reportFolder}/sync-${timestamp}.md`);
    let reportPath = basePath;
    let suffix = 2;

    while (this.app.vault.getAbstractFileByPath(reportPath)) {
      reportPath = normalizePath(`${reportFolder}/sync-${timestamp}-${suffix}.md`);
      suffix += 1;
    }

    await this.app.vault.create(reportPath, renderSyncRunReport(report));
    return reportPath;
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
      await this.app.vault.modify(existing, serialized);
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

  private async readConversationJsonSidecar(notePath: string): Promise<unknown | null> {
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
    if (this.syncWorkerActive) {
      new Notice("A sync job is already running. Wait for it to finish.");
      return;
    }

    const noteIndex = indexConversationNotes(this.app);
    const notes = Array.from(new Set(noteIndex.values()));

    if (notes.length === 0) {
      new Notice("No synced ChatGPT notes were found.");
      return;
    }

    const startedAt = new Date().toISOString();
    let runStatus: SyncRunStatus = "completed";
    const counts = createEmptyCounts();
    const createdEntries: SyncReportConversationEntry[] = [];
    const updatedEntries: SyncReportConversationEntry[] = [];
    const movedEntries: SyncReportConversationEntry[] = [];
    const failedEntries: SyncReportConversationEntry[] = [];
    let syncLogger: SyncRunLogger | null = null;

    const logInfo = (message: string): void => {
      if (syncLogger) {
        syncLogger.info(message);
        return;
      }

      console.info(`[chats2md] ${message}`);
    };

    const logWarn = (message: string): void => {
      if (syncLogger) {
        syncLogger.warn(message);
        return;
      }

      console.warn(`[chats2md] ${message}`);
    };

    const logError = (message: string): void => {
      if (syncLogger) {
        syncLogger.error(message);
        return;
      }

      console.error(`[chats2md] ${message}`);
    };

    this.syncWorkerActive = true;
    this.suppressSyncStatusBarUpdates = false;
    this.setSyncStatusBar(this.buildSyncStatusText(0, notes.length, "rebuilding from cached JSON"), true);

    try {
      try {
        syncLogger = await this.createSyncRunLogger({
          log: (message) => console.info(`[chats2md] ${message}`)
        });
        syncLogger.info(`Rebuild log file: ${syncLogger.filePath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[chats2md] Rebuild log unavailable: ${message}`);
      }

      for (const [noteIndexValue, note] of notes.entries()) {
        const frontmatter = this.getConversationFrontmatter(note);
        const displayTitle = frontmatter.title || note.basename || frontmatter.conversationId || note.path;
        this.setSyncStatusBar(
          this.buildSyncStatusText(noteIndexValue, notes.length, `rebuilding ${displayTitle}`),
          true
        );

        if (!frontmatter.conversationId) {
          counts.failed += 1;
          failedEntries.push({
            accountId: frontmatter.accountId || "unknown-account",
            accountLabel: frontmatter.accountId || "unknown-account",
            conversationId: "unknown-conversation",
            title: displayTitle,
            conversationUrl: null,
            notePath: note.path,
            message: `Missing ${CONVERSATION_ID_KEY} in note frontmatter.`
          });
          logError(`Skipping ${note.path}: missing ${CONVERSATION_ID_KEY}.`);
          continue;
        }

        const fallbackSummary = {
          title: frontmatter.title || note.basename || "Untitled Conversation",
          createdAt: frontmatter.createdAt || frontmatter.updatedAt || "",
          updatedAt: frontmatter.updatedAt || frontmatter.createdAt || ""
        };

        let account: StoredSessionAccount;
        try {
          account = this.resolveAccountForConversation(frontmatter);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          counts.failed += 1;
          failedEntries.push({
            accountId: frontmatter.accountId || "unknown-account",
            accountLabel: frontmatter.accountId || "unknown-account",
            conversationId: frontmatter.conversationId,
            title: fallbackSummary.title,
            conversationUrl: null,
            notePath: note.path,
            message
          });
          logError(`Skipping ${note.path}: ${message}`);
          continue;
        }

        const accountLabel = this.getAccountLabel(account);
        let requestConfig: ChatGptRequestConfig;
        try {
          requestConfig = this.getRequestConfig(account);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          counts.failed += 1;
          failedEntries.push({
            accountId: account.accountId,
            accountLabel,
            conversationId: frontmatter.conversationId,
            title: fallbackSummary.title,
            conversationUrl: null,
            notePath: note.path,
            message
          });
          logError(`[${accountLabel}] Failed to load session for ${note.path}: ${message}`);
          continue;
        }

        let rawPayload: unknown;
        try {
          rawPayload = await this.readConversationJsonSidecar(note.path);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          counts.skipped += 1;
          logWarn(`[${accountLabel}] Skipped ${note.path}: ${message}`);
          continue;
        }

        if (rawPayload === null) {
          counts.skipped += 1;
          logWarn(`[${accountLabel}] Skipped ${note.path}: JSON sidecar not found.`);
          continue;
        }

        let detail: ConversationDetail;
        try {
          detail = parseConversationDetailPayload(rawPayload, frontmatter.conversationId, fallbackSummary);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          counts.skipped += 1;
          logWarn(`[${accountLabel}] Skipped ${note.path}: ${message}`);
          continue;
        }

        try {
          const assetLinks = await this.syncConversationAssets(
            requestConfig,
            detail,
            this.settings.defaultFolder,
            this.settings.conversationPathTemplate,
            this.settings.assetStorageMode,
            syncLogger,
            accountLabel,
            noteIndexValue + 1,
            notes.length
          );

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
            this.settings.conversationPathTemplate,
            this.settings.assetStorageMode,
            frontmatter.listUpdatedAt || detail.updatedAt,
            assetLinks,
            true
          );

          counts[result.action] += 1;
          const reportEntry: SyncReportConversationEntry = {
            accountId: requestConfig.accountId,
            accountLabel,
            conversationId: detail.id,
            title: detail.title,
            conversationUrl: detail.url,
            notePath: result.filePath
          };
          const warnings: string[] = [];

          if (result.moved && result.previousFilePath) {
            try {
              const movedSidecar = await this.moveConversationJsonSidecar(result.previousFilePath, result.filePath);
              if (movedSidecar) {
                warnings.push("JSON sidecar moved with note.");
              }
            } catch (error) {
              const warning = error instanceof Error ? error.message : String(error);
              warnings.push(`JSON sidecar move failed: ${warning}`);
              logWarn(`[${accountLabel}] Sidecar move warning for "${detail.title}": ${warning}`);
            }
          }

          if (warnings.length > 0) {
            reportEntry.message = warnings.join(" ");
          }

          if (result.action === "created") {
            createdEntries.push(reportEntry);
          } else if (result.action === "updated") {
            updatedEntries.push(reportEntry);
          }

          if (result.moved) {
            counts.moved += 1;
            const moveMessage = reportEntry.message
              ? `Moved to match current layout template. ${reportEntry.message}`
              : "Moved to match current layout template.";
            movedEntries.push({
              ...reportEntry,
              message: moveMessage
            });
          }

          logInfo(
            `[${accountLabel}] (${noteIndexValue + 1}/${notes.length}) ${formatActionLabel(result.action)}${result.moved ? " + moved" : ""}: "${detail.title}".`
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          counts.failed += 1;
          failedEntries.push({
            accountId: requestConfig.accountId,
            accountLabel,
            conversationId: frontmatter.conversationId,
            title: fallbackSummary.title,
            conversationUrl: null,
            notePath: note.path,
            message
          });
          logError(`[${accountLabel}] (${noteIndexValue + 1}/${notes.length}) Failed to rebuild "${displayTitle}": ${message}`);
        }
      }

      this.setSyncStatusBar(this.buildSyncStatusText(notes.length, notes.length, "rebuild complete"), false);
      this.clearSyncStatusBar(8000);
      new Notice(`Rebuild from cached JSON complete. ${summarizeCounts(notes.length, counts)}`);
    } catch (error) {
      runStatus = "failed";
      const message = error instanceof Error ? error.message : String(error);
      this.setSyncStatusBar(`Rebuild from cached JSON failed: ${message}`, false);
      this.clearSyncStatusBar(10000);
      new Notice(`Rebuild from cached JSON failed: ${message}`);
    } finally {
      const finishedAt = new Date().toISOString();
      try {
        const reportPath = await this.writeSyncReport({
          startedAt,
          finishedAt,
          status: runStatus,
          folder: this.settings.defaultFolder,
          conversationPathTemplate: this.settings.conversationPathTemplate,
          assetStorageMode: this.settings.assetStorageMode,
          scope: "all",
          accounts: this.getAccounts().map((account) => ({
            accountId: account.accountId,
            label: this.getAccountLabel(account)
          })),
          total: notes.length,
          counts: { ...counts },
          created: createdEntries,
          updated: updatedEntries,
          moved: movedEntries,
          failed: failedEntries
        });
        syncLogger?.info(`Rebuild report saved: ${reportPath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        syncLogger?.warn(`Rebuild report generation failed: ${message}`);
      }

      if (syncLogger) {
        await syncLogger.flush();
      }

      this.syncWorkerActive = false;
      this.suppressSyncStatusBarUpdates = false;
    }
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

  private extractKnownExtension(fileName: string): string | null {
    const trimmed = fileName.trim();
    const dotIndex = trimmed.lastIndexOf(".");

    if (dotIndex <= 0 || dotIndex === trimmed.length - 1) {
      return null;
    }

    const extension = trimmed.slice(dotIndex).toLowerCase();
    return /^[.][a-z0-9]{1,12}$/i.test(extension) ? extension : null;
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

  private async migrateConversationAssetFiles(
    targetFolderPath: string,
    sourceFolderPaths: string[],
    usedNames: Set<string>,
    logger: SyncRunLogger | null,
    logPrefix: string
  ): Promise<void> {
    for (const sourceFolderPath of sourceFolderPaths) {
      const sourceFolder = this.app.vault.getAbstractFileByPath(sourceFolderPath);
      if (!(sourceFolder instanceof TFolder)) {
        continue;
      }

      for (const child of Array.from(sourceFolder.children)) {
        if (!(child instanceof TFile)) {
          continue;
        }

        const oldPath = child.path;
        const destinationFileName = this.nextAvailableFileName(child.name, usedNames);
        const destinationPath = normalizePath(`${targetFolderPath}/${destinationFileName}`);
        await this.app.fileManager.renameFile(child, destinationPath);
        logger?.info(`${logPrefix} Migrated existing asset: ${oldPath} -> ${destinationPath}`);
      }
    }
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
    totalConversations: number
  ): Promise<ConversationAssetLinkMap> {
    const linkMap: ConversationAssetLinkMap = {};
    const downloadRefs = this.collectConversationDownloadRefs(conversation.fileReferences);

    if (downloadRefs.length === 0) {
      return linkMap;
    }

    const folderPaths = resolveAssetFolderPaths({
      mode: assetStorageMode,
      baseFolder,
      conversationPathTemplate,
      conversation: {
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt
      },
      account: {
        accountId: requestConfig.accountId,
        email: requestConfig.userEmail
      }
    });
    const assetFolderPath = folderPaths.targetFolderPath;
    const logPrefix = `[${accountLabel}] (${conversationIndex}/${totalConversations})`;

    logger?.info(`${logPrefix} Resolving ${downloadRefs.length} asset reference(s) for "${conversation.title}".`);
    logger?.info(`${logPrefix} Asset storage mode: ${formatAssetStorageMode(assetStorageMode)}`);
    logger?.info(`${logPrefix} Asset folder: ${assetFolderPath}`);

    await this.ensureFolderExists(assetFolderPath);
    const usedNames = this.readFolderFileNames(assetFolderPath);
    const sourceFolderPaths = folderPaths.candidateFolderPaths.filter((path) => path !== assetFolderPath);
    await this.migrateConversationAssetFiles(assetFolderPath, sourceFolderPaths, usedNames, logger, logPrefix);

    for (const [assetIndex, ref] of downloadRefs.entries()) {
      const perAssetPrefix = `${logPrefix} Asset ${assetIndex + 1}/${downloadRefs.length} (${ref.fileId})`;

      try {
        logger?.info(`${perAssetPrefix} Resolving download metadata.`);
        const info = await fetchConversationFileDownloadInfo(requestConfig, ref.fileId);
        logger?.info(`${perAssetPrefix} Metadata resolved (file_name=${info.fileName || "<empty>"}).`);
        const rawName = sanitizePathPart(info.fileName || ref.logicalName);
        const withExtension = appendExtensionIfMissing(rawName, null);
        let preferredFileName = withExtension || sanitizePathPart(ref.logicalName);
        if (!preferredFileName.includes(".")) {
          const logicalExtension = this.extractKnownExtension(ref.logicalName);
          if (logicalExtension) {
            preferredFileName = `${preferredFileName}${logicalExtension}`;
          }
        }
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

        if (preferredFileName !== rawName) {
          const legacyPath = normalizePath(`${assetFolderPath}/${rawName}`);
          const legacyExisting = this.app.vault.getAbstractFileByPath(legacyPath);
          if (legacyExisting instanceof TFile) {
            const migratedFileName = this.nextAvailableFileName(preferredFileName, usedNames);
            const migratedPath = normalizePath(`${assetFolderPath}/${migratedFileName}`);
            await this.app.vault.rename(legacyExisting, migratedPath);
            linkMap[ref.fileId] = {
              path: migratedPath,
              fileName: migratedFileName
            };
            logger?.info(`${perAssetPrefix} Renamed legacy asset: ${legacyPath} -> ${migratedPath}`);
            continue;
          }
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

  private isForceSyncEligibleFile(file: TFile | null): boolean {
    if (!(file instanceof TFile)) {
      return false;
    }

    const frontmatter = this.getConversationFrontmatter(file);
    return frontmatter.accountId.length > 0 || frontmatter.userId.length > 0;
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

    throw new Error(`Note frontmatter is missing ${CONVERSATION_ACCOUNT_ID_KEY} and ${CONVERSATION_USER_ID_KEY}.`);
  }

  private async forceSyncConversationNote(file: TFile): Promise<void> {
    if (this.syncWorkerActive) {
      new Notice("A sync job is already running. Wait for it to finish.");
      return;
    }

    const frontmatter = this.getConversationFrontmatter(file);
    if (!frontmatter.conversationId) {
      new Notice(`Current note is missing ${CONVERSATION_ID_KEY} in frontmatter.`);
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
      const detailResult = await fetchConversationDetailWithPayload(requestConfig, frontmatter.conversationId, fallbackSummary);
      const detail = detailResult.detail;
      const assetLinks = await this.syncConversationAssets(
        requestConfig,
        detail,
        this.settings.defaultFolder,
        this.settings.conversationPathTemplate,
        this.settings.assetStorageMode,
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
        this.settings.conversationPathTemplate,
        this.settings.assetStorageMode,
        frontmatter.listUpdatedAt || detail.updatedAt,
        assetLinks,
        true
      );
      if (result.moved && result.previousFilePath) {
        try {
          await this.moveConversationJsonSidecar(result.previousFilePath, result.filePath);
        } catch (error) {
          const warning = error instanceof Error ? error.message : String(error);
          console.warn("[chats2md] JSON sidecar move warning", {
            conversationId: detail.id,
            warning
          });
        }
      }

      if (this.settings.saveConversationJson) {
        try {
          await this.saveConversationJsonSidecar(result.filePath, detailResult.rawPayload);
        } catch (error) {
          const warning = error instanceof Error ? error.message : String(error);
          console.warn("[chats2md] JSON sidecar save warning", {
            conversationId: detail.id,
            warning
          });
        }
      }
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
      conversationPathTemplate: this.settings.conversationPathTemplate,
      assetStorageMode: this.settings.assetStorageMode,
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
    this.settings.assetStorageMode = values.assetStorageMode;
    await this.saveSettings();

    this.syncWorkerActive = true;
    this.suppressSyncStatusBarUpdates = false;

    try {
      await runFullSync({
        app: this.app,
        manifestVersion: this.manifest.version,
        createSyncRunLogger: (reporter) => this.createSyncRunLogger(reporter),
        getSelectedAccounts: (syncValues) => this.getSelectedAccounts(syncValues),
        getRequestConfig: (account) => this.getRequestConfig(account),
        getAccountLabel: (account) => this.getAccountLabel(account),
        shouldSaveConversationJson: () => this.settings.saveConversationJson,
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
          totalConversations
        ) => this.syncConversationAssets(
          requestConfig,
          conversation,
          baseFolder,
          conversationPathTemplate,
          assetStorageMode,
          logger,
          accountLabel,
          conversationIndex,
          totalConversations
        ),
        writeSyncReport: (report) => this.writeSyncReport(report),
        buildSyncStatusText: (processed, total, phase) => this.buildSyncStatusText(processed, total, phase),
        setSyncStatusBar: (text, active) => this.setSyncStatusBar(text, active),
        clearSyncStatusBar: (delayMs) => this.clearSyncStatusBar(delayMs)
      }, values, progressModal, control);
    } finally {
      this.syncWorkerActive = false;
      this.suppressSyncStatusBarUpdates = false;
      if (this.activeSyncModal === modal && !modal.isSyncInProgress()) {
        this.activeSyncModal = null;
      }
    }
  }
}
