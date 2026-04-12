import { App, Notice } from "obsidian";
import { createSyncEngine, type SyncQuery } from "@chats2md/sync-core";

import { fetchConversationSummaries } from "../chatgpt/api";
import { loadObsidianTransport } from "../chatgpt/obsidian-transport";
import { createChatGptAuthProvider, createChatGptSyncSource } from "../chatgpt/sync-source";
import { ConversationListPageFetchError } from "../chatgpt/conversation-list-fetch";
import type { AccountHealthResult } from "../main/account-health";
import type { SyncExecutionControl, SyncProgressReporter } from "../ui/import-modal";
import { createEmptyCounts, formatActionLabel, summarizeCounts, type SyncRunLogger } from "../main/helpers";
import { cleanupMovedConversationFolders } from "../main/folder-cleanup";
import { formatConversationBrowseDelay, prepareConversationDetailFetch } from "./browse-delay";
import { isSyncCancelledError } from "./cancellation";
import { createSyncRunState, filterHealthyAccountsForAllScope, recordSyncFailure } from "./full-sync-helpers";
import { ensureSyncCanContinue } from "./full-sync-detail-fetch";
import { finalizeFullSyncRun } from "./full-sync-finalize";
import { ConsecutiveRateLimitGuard, isConsecutiveRateLimitPauseError } from "./rate-limit-guard";
import { runWithRateLimitPauseRetry } from "./rate-limit-retry";
import { hasIndexedConversationNote, indexConversationNotes, upsertConversationNote } from "../storage/note-writer";
import { applyConversationSubsetSelection, openAccountSubsetSelectionPrompt } from "./account-subset-selection";
import type {
  AssetStorageMode,
  ChatGptRequestConfig,
  ConversationAssetLinkMap,
  ConversationDetail,
  SyncReportConversationEntry,
  SyncRunReport,
  SyncRunStatus,
  SyncTuningSettings,
  ConversationSummary,
  StoredSessionAccount,
  SyncModalValues,
} from "../shared/types";

export interface FullSyncContext {
  app: App;
  manifestVersion: string;
  createSyncRunLogger(progressModal: SyncProgressReporter): Promise<SyncRunLogger>;
  getAllConfiguredAccounts(): StoredSessionAccount[];
  getSelectedAccounts(values: SyncModalValues): StoredSessionAccount[];
  checkAccountHealth(account: StoredSessionAccount): Promise<AccountHealthResult>;
  getRequestConfig(account: StoredSessionAccount): ChatGptRequestConfig;
  getAccountLabel(account: StoredSessionAccount): string;
  shouldSaveConversationJson(): boolean;
  shouldGenerateSyncReport(): boolean;
  saveConversationJsonSidecar(notePath: string, payload: unknown): Promise<string>;
  moveConversationJsonSidecar(sourceNotePath: string, targetNotePath: string): Promise<boolean>;
  syncConversationAssets(
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
  ): Promise<ConversationAssetLinkMap>;
  writeSyncReport(report: SyncRunReport): Promise<string | null>;
  buildSyncStatusText(processed: number, total: number, phase: string): string;
  setSyncStatusBar(text: string, active?: boolean): void;
  clearSyncStatusBar(delayMs?: number): void;
  getSyncTuning(): SyncTuningSettings;
}

export async function runFullSync(
  context: FullSyncContext,
  values: SyncModalValues,
  progressModal: SyncProgressReporter,
  control: SyncExecutionControl,
): Promise<void> {
  const syncState = createSyncRunState(createEmptyCounts());
  const { counts, failures, createdEntries, updatedEntries, movedEntries, failedEntries } = syncState;
  const shouldCollectReportEntries = context.shouldGenerateSyncReport();
  let discoveredConversations = 0;
  let processedConversations = 0;
  let totalConversations = 0;
  const startedAt = new Date().toISOString();
  let runStatus: SyncRunStatus = "completed";
  let selectedAccounts: StoredSessionAccount[] = [];
  let syncLogger: SyncRunLogger | null = null;
  let transport = null as Awaited<ReturnType<typeof loadObsidianTransport>> | null;
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
  const ensureCanContinue = async (): Promise<boolean> => {
    const canContinue = await ensureSyncCanContinue(control, progressModal, counts);

    if (!canContinue) {
      runStatus = "stopped";
    }

    return canContinue;
  };
  const syncTuning = context.getSyncTuning();
  const rateLimitGuard = new ConsecutiveRateLimitGuard(syncTuning.maxConsecutiveRateLimitResponses);
  const pauseForRateLimit = async (accountLabel: string, message: string): Promise<boolean> => {
    progressModal.pauseForRetry(message);
    logWarn(`[${accountLabel}] ${message}`);
    new Notice(message);
    context.setSyncStatusBar(message, true);
    await control.waitIfPaused();
    if (control.shouldStop()) {
      return false;
    }
    control.resetRetryPause();
    rateLimitGuard.reset();
    logInfo(`[${accountLabel}] Resuming sync after rate-limit pause.`);
    return true;
  };

  try {
    try {
      syncLogger = await context.createSyncRunLogger(progressModal);
      syncLogger.info(`Sync log file: ${syncLogger.filePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      progressModal.log(`Sync log file unavailable: ${message}`);
    }

    if (!(await ensureCanContinue())) {
      return;
    }

    transport = await loadObsidianTransport();

    selectedAccounts = context.getSelectedAccounts(values);
    if (values.scope === "all") {
      const accountFilterResult = await filterHealthyAccountsForAllScope(
        selectedAccounts,
        context.getAllConfiguredAccounts(),
        {
          ensureCanContinue,
          checkAccountHealth: (account) => context.checkAccountHealth(account),
          getAccountLabel: (account) => context.getAccountLabel(account),
          onUnhealthyAccount: (account, result) => {
            const label = context.getAccountLabel(account);
            logWarn(`[${label}] Skipping unhealthy account: ${result.message}`);
          },
        },
      );
      if (!accountFilterResult) {
        return;
      }

      const { healthyAccounts, skippedLabels } = accountFilterResult;
      if (skippedLabels.length > 0) {
        const warningMessage = `These account(s) will not be synced: ${skippedLabels.join(", ")}.`;
        progressModal.log(warningMessage);
        syncLogger?.warn(warningMessage);
        new Notice(warningMessage);
      }

      if (healthyAccounts.length === 0) {
        const message = "No enabled healthy accounts available for all-accounts sync.";
        runStatus = "failed";
        progressModal.fail(message, counts);
        logError(message);
        new Notice(message);
        context.setSyncStatusBar(`ChatGPT sync failed: ${message}`, false);
        context.clearSyncStatusBar(8000);
        return;
      }

      selectedAccounts = healthyAccounts;
    }

    const noteIndex = indexConversationNotes(context.app);
    let skipExistingLocalConversations = values.skipExistingLocalConversations;
    logInfo(`Starting sync for ${selectedAccounts.length} account(s).`);
    logInfo("Conversation list mode: full discovery with local created_at ordering.");
    context.setSyncStatusBar(context.buildSyncStatusText(processedConversations, totalConversations, "starting"), true);

    for (const [accountIndex, account] of selectedAccounts.entries()) {
      if (!(await ensureCanContinue())) {
        return;
      }

      const accountLabel = context.getAccountLabel(account);
      progressModal.setPreparing(
        `Syncing ${accountLabel} (${accountIndex + 1}/${selectedAccounts.length}): fetching conversation list...`,
      );
      logInfo(`[${accountIndex + 1}/${selectedAccounts.length}] Fetching conversation list for ${accountLabel}.`);
      context.setSyncStatusBar(
        context.buildSyncStatusText(
          processedConversations,
          totalConversations,
          `fetching list for ${accountLabel} (${accountIndex + 1}/${selectedAccounts.length})`,
        ),
        true,
      );

      let requestConfig: ChatGptRequestConfig;

      try {
        requestConfig = {
          ...context.getRequestConfig(account),
          rateLimitMonitor: rateLimitGuard.createMonitor((message) => {
            logWarn(`[${accountLabel}] ${message}`);
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordSyncFailure(
          syncState,
          {
            id: account.accountId,
            title: accountLabel,
            message,
            attempts: 1,
          },
          shouldCollectReportEntries
            ? {
                accountId: account.accountId,
                accountLabel,
                conversationId: account.accountId,
                title: accountLabel,
                conversationUrl: null,
                notePath: null,
                message,
              }
            : undefined,
        );
        logError(`[${accountLabel}] Failed to load session: ${message}`);
        continue;
      }

      let summaries: ConversationSummary[] = [];
      let listPagesFetched = 0;
      let listRawItemCount = 0;
      let listUniqueConversationCount = 0;

      try {
        if (!(await ensureCanContinue())) {
          return;
        }

        const listFetchResult = await runWithRateLimitPauseRetry(
          () =>
            fetchConversationSummaries(requestConfig, {
              parallelism: syncTuning.conversationListFetchParallelism,
              retryAttempts: syncTuning.conversationListRetryAttempts,
              signal: control.getStopSignal(),
              onPageFetched: (progress) => {
                const totalLabel =
                  progress.expectedTotal !== null
                    ? `${progress.discoveredUniqueCount}/${progress.expectedTotal}`
                    : `${progress.discoveredUniqueCount}/?`;

                logInfo(
                  `[${accountLabel}] Conversation-list API call #${progress.pageNumber} ` +
                    `(offset=${progress.offset}, limit=${progress.pageLimit}) ` +
                    `returned ${progress.pageCount} item(s), discovered ${totalLabel}.`,
                );
              },
              onPageRetry: (progress) => {
                logWarn(
                  `[${accountLabel}] Conversation-list retry ${progress.attemptNumber}/${progress.maxAttempts} ` +
                    `(offset=${progress.offset}, limit=${progress.pageLimit}): ${progress.message}`,
                );
              },
            }),
          (message) => pauseForRateLimit(accountLabel, message),
        );
        if (!listFetchResult) {
          runStatus = "stopped";
          progressModal.fail("Sync stopped by user.", counts);
          logInfo(`[${accountLabel}] Conversation-list fetch canceled by user.`);
          return;
        }
        summaries = listFetchResult.summaries;
        listPagesFetched = listFetchResult.pagesFetched;
        listRawItemCount = listFetchResult.rawItemCount;
        listUniqueConversationCount = listFetchResult.uniqueConversationCount;
      } catch (error) {
        if (isSyncCancelledError(error) || control.shouldStop()) {
          runStatus = "stopped";
          progressModal.fail("Sync stopped by user.", counts);
          logInfo(`[${accountLabel}] Conversation-list fetch canceled by user.`);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        const attempts = error instanceof ConversationListPageFetchError ? error.attempts : 1;
        recordSyncFailure(
          syncState,
          {
            id: account.accountId,
            title: accountLabel,
            message,
            attempts,
          },
          shouldCollectReportEntries
            ? {
                accountId: requestConfig.accountId,
                accountLabel,
                conversationId: account.accountId,
                title: `${accountLabel} conversation list`,
                conversationUrl: null,
                notePath: null,
                message,
              }
            : undefined,
        );
        logError(`[${accountLabel}] Failed to fetch conversation list: ${message}`);
        continue;
      }

      const discoveredCount = summaries.length;
      discoveredConversations += discoveredCount;
      logInfo(
        `[${accountLabel}] Found ${discoveredCount} conversation(s) ` +
          `(list pages: ${listPagesFetched}, raw list items: ${listRawItemCount}, unique conversations after merge: ${listUniqueConversationCount}).`,
      );
      if (discoveredCount === 0) {
        continue;
      }

      const subsetPromptResult = await openAccountSubsetSelectionPrompt(
        {
          accountLabel,
          accountIndex,
          totalAccounts: selectedAccounts.length,
          summaries,
          skipExistingLocalConversations,
          defaultLatestConversationCount: syncTuning.defaultLatestConversationCount,
        },
        {
          ensureCanContinue,
          setPreparing: (message) => {
            progressModal.setPreparing(message);
          },
          logInfo,
          selectDateRange: (context) => progressModal.selectDateRange(context),
        },
      );

      if (subsetPromptResult.status === "stop") {
        return;
      }

      if (subsetPromptResult.status === "skip-account") {
        logInfo(`[${accountLabel}] Selection canceled. Skipping account.`);
        continue;
      }

      const discoveredRangeLabel = subsetPromptResult.discoveredRangeLabel;
      let syncQuery: SyncQuery<ConversationSummary> = {
        mode: "full",
        seedSummaries: summaries,
        record: {
          retryAttempts: syncTuning.conversationDetailRetryAttempts,
        },
        signal: control.getStopSignal(),
      };
      let selectedSummaryCount = discoveredCount;

      if (subsetPromptResult.status === "selected") {
        const selection = subsetPromptResult.selection;
        skipExistingLocalConversations = selection.skipExistingLocalConversations;
        values.skipExistingLocalConversations = selection.skipExistingLocalConversations;

        if (selection.mode === "range") {
          try {
            selectedSummaryCount = applyConversationSubsetSelection(summaries, selection).length;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            recordSyncFailure(
              syncState,
              {
                id: account.accountId,
                title: `${accountLabel} date range`,
                message,
                attempts: 1,
              },
              shouldCollectReportEntries
                ? {
                    accountId: requestConfig.accountId,
                    accountLabel,
                    conversationId: account.accountId,
                    title: `${accountLabel} date range`,
                    conversationUrl: null,
                    notePath: null,
                    message,
                  }
                : undefined,
            );
            logError(`[${accountLabel}] Invalid date range selection: ${message}`);
            continue;
          }

          syncQuery = {
            ...syncQuery,
            mode: "date-range",
            dateRange: {
              start: selection.startDate,
              end: selection.endDate,
            },
          };
          logInfo(
            `[${accountLabel}] Selected created_at range ${selection.startDate} to ${selection.endDate}. ` +
              `Syncing ${selectedSummaryCount}/${discoveredCount} conversation(s).`,
          );
        } else if (selection.mode === "latest-count") {
          try {
            selectedSummaryCount = applyConversationSubsetSelection(summaries, selection).length;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            recordSyncFailure(
              syncState,
              {
                id: account.accountId,
                title: `${accountLabel} latest count`,
                message,
                attempts: 1,
              },
              shouldCollectReportEntries
                ? {
                    accountId: requestConfig.accountId,
                    accountLabel,
                    conversationId: account.accountId,
                    title: `${accountLabel} latest count`,
                    conversationUrl: null,
                    notePath: null,
                    message,
                  }
                : undefined,
            );
            logError(`[${accountLabel}] Invalid latest count selection: ${message}`);
            continue;
          }

          syncQuery = {
            ...syncQuery,
            itemLimit: selection.count,
          };
          logInfo(
            `[${accountLabel}] Selected latest ${selection.count} conversation(s) by created_at. ` +
              `Syncing ${selectedSummaryCount}/${discoveredCount} conversation(s).`,
          );
        } else {
          logInfo(
            `[${accountLabel}] Using full discovered created_at range ${discoveredRangeLabel}. ` +
              `Syncing ${discoveredCount}/${discoveredCount} conversation(s).`,
          );
        }
      }

      if (selectedSummaryCount === 0) {
        logInfo(`[${accountLabel}] No conversations selected for sync after filtering.`);
        continue;
      }

      if (selectedSummaryCount !== discoveredCount) {
        logInfo(`[${accountLabel}] Selected ${selectedSummaryCount}/${discoveredCount} conversation(s) for sync.`);
      }

      totalConversations += selectedSummaryCount;
      context.setSyncStatusBar(
        context.buildSyncStatusText(processedConversations, totalConversations, `syncing ${accountLabel}`),
        true,
      );

      const engine = createSyncEngine({
        source: createChatGptSyncSource(requestConfig),
        transport: transport ?? undefined,
        authProvider: createChatGptAuthProvider(requestConfig),
        beforeFetchSummary: async ({ summary, index, total }) => {
          if (!(await ensureCanContinue())) {
            throw control.getStopSignal()?.reason ?? new Error("Sync stopped by user.");
          }

          const displayTitle = `${accountLabel}: ${summary.title}`;
          progressModal.setProgress(displayTitle, index, total, index - 1, counts);
          logInfo(`[${accountLabel}] (${index}/${total}) Processing "${summary.title}".`);

          const fetchPreparation = await prepareConversationDetailFetch(
            hasIndexedConversationNote(noteIndex, requestConfig.accountId, summary.id),
            skipExistingLocalConversations,
            control,
            {
              delayRange: {
                minDelayMs: syncTuning.conversationDetailBrowseDelayMinMs,
                maxDelayMs: syncTuning.conversationDetailBrowseDelayMaxMs,
              },
              onDelay: (delayMs) => {
                const delayLabel = formatConversationBrowseDelay(delayMs);
                progressModal.setStatus(`Waiting ${delayLabel} before opening ${displayTitle}`);
                logInfo(
                  `[${accountLabel}] (${index}/${total}) Waiting ${delayLabel} before opening "${summary.title}".`,
                );
                context.setSyncStatusBar(
                  context.buildSyncStatusText(
                    processedConversations,
                    totalConversations,
                    `waiting ${delayLabel} before opening ${accountLabel}`,
                  ),
                  true,
                );
              },
            },
          );

          if (!fetchPreparation.shouldFetch) {
            return {
              skip: true,
              reason: "existing local conversation",
            };
          }

          if (!(await ensureCanContinue())) {
            throw control.getStopSignal()?.reason ?? new Error("Sync stopped by user.");
          }

          progressModal.setStatus(`Sync ${displayTitle} (${index}/${total})`);
          context.setSyncStatusBar(
            context.buildSyncStatusText(processedConversations, totalConversations, `syncing ${accountLabel}`),
            true,
          );
          logInfo(`[${accountLabel}] (${index}/${total}) Calling /conversation/${summary.id}.`);

          return {
            skip: false,
          };
        },
        onRecord: async ({ summary, record: detail, raw, index, total }) => {
          if (!(await ensureCanContinue())) {
            throw control.getStopSignal()?.reason ?? new Error("Sync stopped by user.");
          }

          const assetLinks = await context.syncConversationAssets(
            requestConfig,
            detail,
            values.folder,
            values.conversationPathTemplate,
            values.assetStorageMode,
            syncLogger,
            accountLabel,
            index,
            total,
            control.getStopSignal(),
          );

          const result = await upsertConversationNote(
            context.app,
            noteIndex,
            detail,
            values.folder,
            {
              accountId: requestConfig.accountId,
              userId: requestConfig.userId,
              userEmail: requestConfig.userEmail,
            },
            context.manifestVersion,
            values.conversationPathTemplate,
            values.assetStorageMode,
            summary.updatedAt,
            assetLinks,
          );

          counts[result.action] += 1;
          const reportEntry: SyncReportConversationEntry | null = shouldCollectReportEntries
            ? {
                accountId: requestConfig.accountId,
                accountLabel,
                conversationId: detail.id,
                title: detail.title,
                conversationUrl: detail.url,
                notePath: result.filePath,
              }
            : null;
          const reportWarnings: string[] = [];

          if (result.moved && result.previousFilePath) {
            try {
              const movedSidecar = await context.moveConversationJsonSidecar(result.previousFilePath, result.filePath);
              if (movedSidecar) {
                reportWarnings.push("JSON sidecar moved with note.");
              }
            } catch (error) {
              const warning = error instanceof Error ? error.message : String(error);
              reportWarnings.push(`JSON sidecar move failed: ${warning}`);
              logWarn(`[${accountLabel}] (${index}/${total}) Sidecar move warning for "${summary.title}": ${warning}`);
            }

            try {
              const removedFolders = await cleanupMovedConversationFolders(
                context.app,
                result.previousFilePath,
                result.filePath,
                values.assetStorageMode,
              );
              removedFolders.forEach((folderPath) =>
                logInfo(`[${accountLabel}] (${index}/${total}) Removed empty conversation folder: ${folderPath}`),
              );
            } catch (error) {
              const warning = error instanceof Error ? error.message : String(error);
              reportWarnings.push(`Folder cleanup failed: ${warning}`);
              logWarn(
                `[${accountLabel}] (${index}/${total}) Folder cleanup warning for "${summary.title}": ${warning}`,
              );
            }
          }

          if (context.shouldSaveConversationJson()) {
            try {
              await context.saveConversationJsonSidecar(result.filePath, raw);
            } catch (error) {
              const warning = error instanceof Error ? error.message : String(error);
              reportWarnings.push(`JSON sidecar save failed: ${warning}`);
              logWarn(`[${accountLabel}] (${index}/${total}) Sidecar save warning for "${summary.title}": ${warning}`);
            }
          }

          if (reportEntry && reportWarnings.length > 0) {
            reportEntry.message = reportWarnings.join(" ");
          }

          if (reportEntry && result.action === "created") {
            createdEntries.push(reportEntry);
          } else if (reportEntry && result.action === "updated") {
            updatedEntries.push(reportEntry);
          }

          if (result.moved) {
            counts.moved += 1;
            const moveMessage = reportEntry?.message
              ? `Moved to match current layout template. ${reportEntry.message}`
              : "Moved to match current layout template.";
            if (reportEntry) {
              movedEntries.push({
                ...reportEntry,
                message: moveMessage,
              });
            }
          }

          logInfo(
            `[${accountLabel}] (${index}/${total}) ${formatActionLabel(result.action)}${result.moved ? " + moved" : ""}: "${summary.title}".`,
          );
        },
        onEvent: (event) => {
          if (event.type === "summary-retry") {
            progressModal.setRetry(
              `${accountLabel}: ${event.summary.title}`,
              event.index,
              event.total,
              event.attemptNumber,
              event.maxAttempts,
              event.message,
            );
            syncLogger?.warn(
              `${accountLabel}: ${event.summary.title} detail fetch retry ${event.attemptNumber}/${event.maxAttempts}: ${event.message}`,
            );
            return;
          }

          if (event.type === "summary-skip") {
            counts.skipped += 1;
            processedConversations += 1;
            logInfo(
              `[${accountLabel}] (${event.index}/${event.total}) Skipped existing local conversation "${event.summary.title}".`,
            );
            progressModal.setProgress(
              `${accountLabel}: ${event.summary.title}`,
              event.index,
              event.total,
              event.index,
              counts,
            );
            context.setSyncStatusBar(
              context.buildSyncStatusText(processedConversations, totalConversations, `syncing ${accountLabel}`),
              true,
            );
            return;
          }

          if (event.type === "summary-success") {
            processedConversations += 1;
            progressModal.setProgress(
              `${accountLabel}: ${event.summary.title}`,
              event.index,
              event.total,
              event.index,
              counts,
            );
            context.setSyncStatusBar(
              context.buildSyncStatusText(processedConversations, totalConversations, `syncing ${accountLabel}`),
              true,
            );
            return;
          }

          if (event.type === "summary-failure") {
            processedConversations += 1;
            recordSyncFailure(
              syncState,
              {
                id: `${account.accountId}/${event.summary.id}`,
                title: `${accountLabel}: ${event.summary.title}`,
                message: event.error.message,
                attempts: event.attempts,
              },
              shouldCollectReportEntries
                ? {
                    accountId: requestConfig.accountId,
                    accountLabel,
                    conversationId: event.summary.id,
                    title: event.summary.title,
                    conversationUrl: event.summary.url,
                    notePath: null,
                    message: event.error.message,
                  }
                : undefined,
            );
            logError(
              `[${accountLabel}] (${event.index}/${event.total}) Failed: "${event.summary.title}" - ${event.error.message}`,
            );
            progressModal.setProgress(
              `${accountLabel}: ${event.summary.title}`,
              event.index,
              event.total,
              event.index,
              counts,
            );
            context.setSyncStatusBar(
              context.buildSyncStatusText(processedConversations, totalConversations, `syncing ${accountLabel}`),
              true,
            );
          }
        },
        onSummaryError: async (error) => {
          if (isConsecutiveRateLimitPauseError(error)) {
            const shouldRetry = await pauseForRateLimit(accountLabel, error.message);
            return shouldRetry ? "retry" : "abort";
          }

          return "continue";
        },
      });

      try {
        await engine.run(syncQuery);
      } catch (error) {
        if (isSyncCancelledError(error) || control.shouldStop()) {
          runStatus = "stopped";
          progressModal.fail("Sync stopped by user.", counts);
          logInfo(`[${accountLabel}] Stopped by user.`);
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        recordSyncFailure(
          syncState,
          {
            id: account.accountId,
            title: accountLabel,
            message,
            attempts: 1,
          },
          shouldCollectReportEntries
            ? {
                accountId: requestConfig.accountId,
                accountLabel,
                conversationId: account.accountId,
                title: `${accountLabel} sync`,
                conversationUrl: null,
                notePath: null,
                message,
              }
            : undefined,
        );
        logError(`[${accountLabel}] Sync engine failed: ${message}`);
      }
    }

    logInfo("Sync complete.");
    progressModal.complete(totalConversations, counts, failures);
    new Notice(summarizeCounts(totalConversations, counts));
    context.setSyncStatusBar(
      context.buildSyncStatusText(processedConversations, totalConversations, "complete"),
      false,
    );
    context.clearSyncStatusBar(8000);
  } catch (error) {
    if (isSyncCancelledError(error) || control.shouldStop()) {
      runStatus = "stopped";
      progressModal.fail("Sync stopped by user.", counts);
      logInfo("Sync stopped by user.");
      context.setSyncStatusBar("ChatGPT sync stopped.", false);
      context.clearSyncStatusBar(3000);
    } else {
      runStatus = "failed";
      const message = error instanceof Error ? error.message : String(error);
      progressModal.fail(message, counts);
      logError(`Sync failed: ${message}`);
      new Notice(message);
      context.setSyncStatusBar(`ChatGPT sync failed: ${message}`, false);
      context.clearSyncStatusBar(10000);
    }
  } finally {
    const finishedAt = new Date().toISOString();
    await finalizeFullSyncRun(
      {
        startedAt,
        finishedAt,
        status: runStatus,
        logPath: syncLogger?.filePath ?? null,
        folder: values.folder,
        conversationPathTemplate: values.conversationPathTemplate,
        assetStorageMode: values.assetStorageMode,
        scope: values.scope,
        accounts: selectedAccounts.map((account) => ({
          accountId: account.accountId,
          label: context.getAccountLabel(account),
        })),
        discoveredTotal: discoveredConversations,
        selectedTotal: totalConversations,
        counts: { ...counts },
        created: createdEntries,
        updated: updatedEntries,
        moved: movedEntries,
        failed: failedEntries,
      },
      {
        writeSyncReport: (report) => context.writeSyncReport(report),
        syncLogger,
        logInfo,
        logWarn,
      },
    );
  }
}
