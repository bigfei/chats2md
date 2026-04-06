import { Notice, type TFile } from "obsidian";

import { parseConversationDetailPayload } from "../chatgpt/api";
import {
  CONVERSATION_ID_KEY,
  createEmptyCounts,
  formatActionLabel,
  summarizeCounts,
  type ConversationFrontmatterInfo,
  type SyncRunLogger,
} from "./helpers";
import { indexConversationNotes, upsertConversationNote } from "../storage/note-writer";
import type {
  ChatGptRequestConfig,
  ConversationAssetLinkMap,
  ConversationDetail,
  SyncReportConversationEntry,
  SyncRunReport,
  SyncRunStatus,
  StoredSessionAccount,
} from "../shared/types";

export interface MainRebuildHost {
  app: {
    vault: {
      getAbstractFileByPath(path: string): unknown;
      getMarkdownFiles(): TFile[];
    };
  };
  settings: {
    defaultFolder: string;
    conversationPathTemplate: string;
    assetStorageMode: "global_by_conversation" | "with_conversation";
  };
  manifestVersion: string;
  isSyncWorkerActive(): boolean;
  setSyncWorkerActive(value: boolean): void;
  setSuppressSyncStatusBarUpdates(value: boolean): void;
  setSyncStatusBar(text: string, active?: boolean): void;
  buildSyncStatusText(processed: number, total: number, phase: string): string;
  clearSyncStatusBar(delayMs?: number): void;
  createSyncRunLogger(progressSink: { log(message: string): void }, syncFolder: string): Promise<SyncRunLogger>;
  getConversationFrontmatter(file: TFile): ConversationFrontmatterInfo;
  resolveAccountForConversation(frontmatter: ConversationFrontmatterInfo): StoredSessionAccount;
  getAccountLabel(account: StoredSessionAccount): string;
  getRequestConfig(account: StoredSessionAccount): ChatGptRequestConfig;
  readConversationJsonSidecar(notePath: string): Promise<unknown | null>;
  syncConversationAssets(
    requestConfig: ChatGptRequestConfig,
    conversation: ConversationDetail,
    baseFolder: string,
    conversationPathTemplate: string,
    assetStorageMode: "global_by_conversation" | "with_conversation",
    logger: SyncRunLogger | null,
    accountLabel: string,
    conversationIndex: number,
    totalConversations: number,
    stopSignal?: AbortSignal,
  ): Promise<ConversationAssetLinkMap>;
  moveConversationJsonSidecar(sourceNotePath: string, targetNotePath: string): Promise<boolean>;
  writeSyncReport(report: SyncRunReport): Promise<string | null>;
  getAccounts(): StoredSessionAccount[];
  logInfo(message: string, context?: unknown): void;
  logWarn(message: string, context?: unknown): void;
  logError(message: string, context?: unknown): void;
}

export async function runRebuildNotesFromCachedJson(host: MainRebuildHost): Promise<void> {
  if (host.isSyncWorkerActive()) {
    new Notice("A sync job is already running. Wait for it to finish.");
    return;
  }

  const noteIndex = indexConversationNotes(host.app as never);
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

    host.logInfo(message);
  };

  const logWarn = (message: string): void => {
    if (syncLogger) {
      syncLogger.warn(message);
      return;
    }

    host.logWarn(message);
  };

  const logError = (message: string): void => {
    if (syncLogger) {
      syncLogger.error(message);
      return;
    }

    host.logError(message);
  };

  host.setSyncWorkerActive(true);
  host.setSuppressSyncStatusBarUpdates(false);
  host.setSyncStatusBar(host.buildSyncStatusText(0, notes.length, "rebuilding from cached JSON"), true);

  try {
    try {
      syncLogger = await host.createSyncRunLogger(
        {
          log: (message) => host.logInfo(message),
        },
        host.settings.defaultFolder,
      );
      syncLogger.info(`Rebuild log file: ${syncLogger.filePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      host.logWarn(`Rebuild log unavailable: ${message}`);
    }

    for (const [noteIndexValue, note] of notes.entries()) {
      const frontmatter = host.getConversationFrontmatter(note);
      const displayTitle = frontmatter.title || note.basename || frontmatter.conversationId || note.path;
      host.setSyncStatusBar(host.buildSyncStatusText(noteIndexValue, notes.length, `rebuilding ${displayTitle}`), true);

      if (!frontmatter.conversationId) {
        counts.failed += 1;
        failedEntries.push({
          accountId: frontmatter.accountId || "unknown-account",
          accountLabel: frontmatter.accountId || "unknown-account",
          conversationId: "unknown-conversation",
          title: displayTitle,
          conversationUrl: null,
          notePath: note.path,
          message: `Missing ${CONVERSATION_ID_KEY} in note frontmatter.`,
        });
        logError(`Skipping ${note.path}: missing ${CONVERSATION_ID_KEY}.`);
        continue;
      }

      const fallbackSummary = {
        title: frontmatter.title || note.basename || "Untitled Conversation",
        createdAt: frontmatter.createdAt || frontmatter.updatedAt || "",
        updatedAt: frontmatter.updatedAt || frontmatter.createdAt || "",
      };

      let account: StoredSessionAccount;
      try {
        account = host.resolveAccountForConversation(frontmatter);
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
          message,
        });
        logError(`Skipping ${note.path}: ${message}`);
        continue;
      }

      const accountLabel = host.getAccountLabel(account);
      let requestConfig: ChatGptRequestConfig;
      try {
        requestConfig = host.getRequestConfig(account);
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
          message,
        });
        logError(`[${accountLabel}] Failed to load session for ${note.path}: ${message}`);
        continue;
      }

      let rawPayload: unknown;
      try {
        rawPayload = await host.readConversationJsonSidecar(note.path);
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
        const assetLinks = await host.syncConversationAssets(
          requestConfig,
          detail,
          host.settings.defaultFolder,
          host.settings.conversationPathTemplate,
          host.settings.assetStorageMode,
          syncLogger,
          accountLabel,
          noteIndexValue + 1,
          notes.length,
        );

        const result = await upsertConversationNote(
          host.app as never,
          noteIndex,
          detail,
          host.settings.defaultFolder,
          {
            accountId: requestConfig.accountId,
            userId: requestConfig.userId,
            userEmail: requestConfig.userEmail,
          },
          host.manifestVersion,
          host.settings.conversationPathTemplate,
          host.settings.assetStorageMode,
          frontmatter.listUpdatedAt || detail.updatedAt,
          assetLinks,
          true,
        );

        counts[result.action] += 1;
        const reportEntry: SyncReportConversationEntry = {
          accountId: requestConfig.accountId,
          accountLabel,
          conversationId: detail.id,
          title: detail.title,
          conversationUrl: detail.url,
          notePath: result.filePath,
        };
        const warnings: string[] = [];

        if (result.moved && result.previousFilePath) {
          try {
            const movedSidecar = await host.moveConversationJsonSidecar(result.previousFilePath, result.filePath);
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
            message: moveMessage,
          });
        }

        logInfo(
          `[${accountLabel}] (${noteIndexValue + 1}/${notes.length}) ${formatActionLabel(result.action)}${result.moved ? " + moved" : ""}: "${detail.title}".`,
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
          message,
        });
        logError(
          `[${accountLabel}] (${noteIndexValue + 1}/${notes.length}) Failed to rebuild "${displayTitle}": ${message}`,
        );
      }
    }

    host.setSyncStatusBar(host.buildSyncStatusText(notes.length, notes.length, "rebuild complete"), false);
    host.clearSyncStatusBar(8000);
    new Notice(`Rebuild from cached JSON complete. ${summarizeCounts(notes.length, counts)}`);
  } catch (error) {
    runStatus = "failed";
    const message = error instanceof Error ? error.message : String(error);
    host.setSyncStatusBar(`Rebuild from cached JSON failed: ${message}`, false);
    host.clearSyncStatusBar(10000);
    new Notice(`Rebuild from cached JSON failed: ${message}`);
  } finally {
    const finishedAt = new Date().toISOString();
    try {
      const reportPath = await host.writeSyncReport({
        startedAt,
        finishedAt,
        status: runStatus,
        logPath: syncLogger?.filePath ?? null,
        folder: host.settings.defaultFolder,
        conversationPathTemplate: host.settings.conversationPathTemplate,
        assetStorageMode: host.settings.assetStorageMode,
        scope: "all",
        accounts: host.getAccounts().map((account) => ({
          accountId: account.accountId,
          label: host.getAccountLabel(account),
        })),
        total: notes.length,
        counts: { ...counts },
        created: createdEntries,
        updated: updatedEntries,
        moved: movedEntries,
        failed: failedEntries,
      });
      if (reportPath) {
        syncLogger?.info(`Rebuild report saved: ${reportPath}`);
      } else {
        syncLogger?.info("Rebuild report generation skipped (disabled in settings).");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      syncLogger?.warn(`Rebuild report generation failed: ${message}`);
    }

    if (syncLogger) {
      await syncLogger.flush();
    }

    host.setSyncWorkerActive(false);
    host.setSuppressSyncStatusBarUpdates(false);
  }
}
