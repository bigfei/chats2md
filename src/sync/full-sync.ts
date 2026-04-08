import { App, Notice } from "obsidian";

import { fetchConversationDetailWithPayload, fetchConversationSummaries } from "../chatgpt/api";
import type { SyncExecutionControl, SyncProgressReporter } from "../ui/import-modal";
import {
  DETAIL_FETCH_MAX_ATTEMPTS,
  createEmptyCounts,
  formatActionLabel,
  summarizeCounts,
  type SyncRunLogger,
} from "../main/helpers";
import { cleanupMovedConversationFolders } from "../main/folder-cleanup";
import { formatConversationBrowseDelay, prepareConversationDetailFetch } from "./browse-delay";
import { isSyncCancelledError, sleepWithAbort } from "./cancellation";
import { ConsecutiveRateLimitGuard, isConsecutiveRateLimitPauseError } from "./rate-limit-guard";
import { runWithRateLimitPauseRetry } from "./rate-limit-retry";
import { hasIndexedConversationNote, indexConversationNotes, upsertConversationNote } from "../storage/note-writer";
import {
  filterConversationSummariesByCreatedDateRange,
  filterConversationSummariesByLatestCreatedCount,
  getConversationCreatedAtSpan,
  shouldPromptForDateRange,
  toIsoUtcDate,
} from "./date-range";
import type {
  AssetStorageMode,
  ChatGptRequestConfig,
  ConversationAssetLinkMap,
  ConversationDetail,
  SyncReportConversationEntry,
  SyncRunReport,
  SyncRunStatus,
  ConversationSummary,
  ImportFailure,
  ImportProgressCounts,
  StoredSessionAccount,
  SyncModalValues,
} from "../shared/types";

export interface FullSyncContext {
  app: App;
  manifestVersion: string;
  createSyncRunLogger(progressModal: SyncProgressReporter): Promise<SyncRunLogger>;
  getSelectedAccounts(values: SyncModalValues): StoredSessionAccount[];
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
}

export async function runFullSync(
  context: FullSyncContext,
  values: SyncModalValues,
  progressModal: SyncProgressReporter,
  control: SyncExecutionControl,
): Promise<void> {
  const counts = createEmptyCounts();
  const failures: ImportFailure[] = [];
  const shouldCollectReportEntries = context.shouldGenerateSyncReport();
  const createdEntries: SyncReportConversationEntry[] = [];
  const updatedEntries: SyncReportConversationEntry[] = [];
  const movedEntries: SyncReportConversationEntry[] = [];
  const failedEntries: SyncReportConversationEntry[] = [];
  let discoveredConversations = 0;
  let processedConversations = 0;
  let totalConversations = 0;
  const startedAt = new Date().toISOString();
  let runStatus: SyncRunStatus = "completed";
  let selectedAccounts: StoredSessionAccount[] = [];
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
  const ensureCanContinue = async (): Promise<boolean> => {
    const canContinue = await ensureSyncCanContinue(control, progressModal, counts);

    if (!canContinue) {
      runStatus = "stopped";
    }

    return canContinue;
  };
  const rateLimitGuard = new ConsecutiveRateLimitGuard();
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

    selectedAccounts = context.getSelectedAccounts(values);
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
        counts.failed += 1;
        failures.push({
          id: account.accountId,
          title: accountLabel,
          message,
          attempts: 1,
        });
        if (shouldCollectReportEntries) {
          failedEntries.push({
            accountId: account.accountId,
            accountLabel,
            conversationId: account.accountId,
            title: accountLabel,
            conversationUrl: null,
            notePath: null,
            message,
          });
        }
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
        counts.failed += 1;
        failures.push({
          id: account.accountId,
          title: accountLabel,
          message,
          attempts: 1,
        });
        if (shouldCollectReportEntries) {
          failedEntries.push({
            accountId: requestConfig.accountId,
            accountLabel,
            conversationId: account.accountId,
            title: `${accountLabel} conversation list`,
            conversationUrl: null,
            notePath: null,
            message,
          });
        }
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

      const createdAtSpan = getConversationCreatedAtSpan(summaries);
      const discoveredStartDate = toIsoUtcDate(createdAtSpan?.minCreatedAt ?? "");
      const discoveredEndDate = toIsoUtcDate(createdAtSpan?.maxCreatedAt ?? "");
      const discoveredRangeLabel =
        discoveredStartDate && discoveredEndDate ? `${discoveredStartDate} to ${discoveredEndDate}` : "unknown";

      if (shouldPromptForDateRange(createdAtSpan) && createdAtSpan) {
        if (!(await ensureCanContinue())) {
          return;
        }

        progressModal.setPreparing(
          `Syncing ${accountLabel} (${accountIndex + 1}/${selectedAccounts.length}): choose conversation filter...`,
        );
        logInfo(`[${accountLabel}] created_at span exceeds 30 days (${discoveredRangeLabel}). Waiting for selection.`);

        const selection = await progressModal.selectDateRange({
          accountLabel,
          discoveredCount,
          minCreatedAt: createdAtSpan.minCreatedAt,
          maxCreatedAt: createdAtSpan.maxCreatedAt,
          skipExistingLocalConversations,
        });

        if (!(await ensureCanContinue())) {
          return;
        }

        if (selection.mode === "skip-account") {
          logInfo(`[${accountLabel}] Selection canceled. Skipping account.`);
          continue;
        }

        skipExistingLocalConversations = selection.skipExistingLocalConversations;
        values.skipExistingLocalConversations = selection.skipExistingLocalConversations;

        if (selection.mode === "range") {
          try {
            summaries = filterConversationSummariesByCreatedDateRange(
              summaries,
              selection.startDate,
              selection.endDate,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            counts.failed += 1;
            failures.push({
              id: account.accountId,
              title: `${accountLabel} date range`,
              message,
              attempts: 1,
            });
            if (shouldCollectReportEntries) {
              failedEntries.push({
                accountId: requestConfig.accountId,
                accountLabel,
                conversationId: account.accountId,
                title: `${accountLabel} date range`,
                conversationUrl: null,
                notePath: null,
                message,
              });
            }
            logError(`[${accountLabel}] Invalid date range selection: ${message}`);
            continue;
          }

          logInfo(
            `[${accountLabel}] Selected created_at range ${selection.startDate} to ${selection.endDate}. ` +
              `Syncing ${summaries.length}/${discoveredCount} conversation(s).`,
          );
        } else if (selection.mode === "latest-count") {
          try {
            summaries = filterConversationSummariesByLatestCreatedCount(summaries, selection.count);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            counts.failed += 1;
            failures.push({
              id: account.accountId,
              title: `${accountLabel} latest count`,
              message,
              attempts: 1,
            });
            if (shouldCollectReportEntries) {
              failedEntries.push({
                accountId: requestConfig.accountId,
                accountLabel,
                conversationId: account.accountId,
                title: `${accountLabel} latest count`,
                conversationUrl: null,
                notePath: null,
                message,
              });
            }
            logError(`[${accountLabel}] Invalid latest count selection: ${message}`);
            continue;
          }

          logInfo(
            `[${accountLabel}] Selected latest ${selection.count} conversation(s) by created_at. ` +
              `Syncing ${summaries.length}/${discoveredCount} conversation(s).`,
          );
        } else {
          logInfo(
            `[${accountLabel}] Using full discovered created_at range ${discoveredRangeLabel}. ` +
              `Syncing ${discoveredCount}/${discoveredCount} conversation(s).`,
          );
        }
      }

      if (summaries.length === 0) {
        logInfo(`[${accountLabel}] No conversations selected for sync after filtering.`);
        continue;
      }

      if (summaries.length !== discoveredCount) {
        logInfo(`[${accountLabel}] Selected ${summaries.length}/${discoveredCount} conversation(s) for sync.`);
      }

      totalConversations += summaries.length;
      context.setSyncStatusBar(
        context.buildSyncStatusText(processedConversations, totalConversations, `syncing ${accountLabel}`),
        true,
      );

      for (let conversationIndex = 0; conversationIndex < summaries.length; conversationIndex += 1) {
        const summary = summaries[conversationIndex]!;
        if (!(await ensureCanContinue())) {
          return;
        }

        const displayTitle = `${accountLabel}: ${summary.title}`;

        progressModal.setProgress(displayTitle, conversationIndex + 1, summaries.length, conversationIndex, counts);
        logInfo(`[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Processing "${summary.title}".`);

        try {
          const handled = await runWithRateLimitPauseRetry(
            async () => {
              const fetchPreparation = await prepareConversationDetailFetch(
                hasIndexedConversationNote(noteIndex, requestConfig.accountId, summary.id),
                skipExistingLocalConversations,
                control,
                {
                  onDelay: (delayMs) => {
                    const delayLabel = formatConversationBrowseDelay(delayMs);
                    progressModal.setStatus(`Waiting ${delayLabel} before opening ${displayTitle}`);
                    logInfo(
                      `[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Waiting ${delayLabel} before opening "${summary.title}".`,
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
                counts.skipped += 1;
                processedConversations += 1;
                logInfo(
                  `[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Skipped existing local conversation "${summary.title}".`,
                );
                progressModal.setProgress(
                  displayTitle,
                  conversationIndex + 1,
                  summaries.length,
                  conversationIndex + 1,
                  counts,
                );
                context.setSyncStatusBar(
                  context.buildSyncStatusText(processedConversations, totalConversations, `syncing ${accountLabel}`),
                  true,
                );
                return "skipped" as const;
              }

              if (!(await ensureCanContinue())) {
                return "stopped" as const;
              }

              progressModal.setStatus(`Sync ${displayTitle} (${conversationIndex + 1}/${summaries.length})`);
              context.setSyncStatusBar(
                context.buildSyncStatusText(processedConversations, totalConversations, `syncing ${accountLabel}`),
                true,
              );
              logInfo(
                `[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Calling /conversation/${summary.id}.`,
              );

              const detailResult = await fetchConversationDetailWithRetries(
                requestConfig,
                summary,
                conversationIndex + 1,
                summaries.length,
                progressModal,
                displayTitle,
                control,
                syncLogger,
              );
              if (!detailResult) {
                return "stopped" as const;
              }
              const detail = detailResult.detail;

              if (!(await ensureCanContinue())) {
                return "stopped" as const;
              }

              const assetLinks = await context.syncConversationAssets(
                requestConfig,
                detail,
                values.folder,
                values.conversationPathTemplate,
                values.assetStorageMode,
                syncLogger,
                accountLabel,
                conversationIndex + 1,
                summaries.length,
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
                  const movedSidecar = await context.moveConversationJsonSidecar(
                    result.previousFilePath,
                    result.filePath,
                  );
                  if (movedSidecar) {
                    reportWarnings.push("JSON sidecar moved with note.");
                  }
                } catch (error) {
                  const warning = error instanceof Error ? error.message : String(error);
                  reportWarnings.push(`JSON sidecar move failed: ${warning}`);
                  logWarn(
                    `[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Sidecar move warning for "${summary.title}": ${warning}`,
                  );
                }

                try {
                  const removedFolders = await cleanupMovedConversationFolders(
                    context.app,
                    result.previousFilePath,
                    result.filePath,
                    values.assetStorageMode,
                  );
                  removedFolders.forEach((folderPath) =>
                    logInfo(
                      `[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Removed empty conversation folder: ${folderPath}`,
                    ),
                  );
                } catch (error) {
                  const warning = error instanceof Error ? error.message : String(error);
                  reportWarnings.push(`Folder cleanup failed: ${warning}`);
                  logWarn(
                    `[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Folder cleanup warning for "${summary.title}": ${warning}`,
                  );
                }
              }

              if (context.shouldSaveConversationJson()) {
                try {
                  await context.saveConversationJsonSidecar(result.filePath, detailResult.rawPayload);
                } catch (error) {
                  const warning = error instanceof Error ? error.message : String(error);
                  reportWarnings.push(`JSON sidecar save failed: ${warning}`);
                  logWarn(
                    `[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Sidecar save warning for "${summary.title}": ${warning}`,
                  );
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
                `[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) ${formatActionLabel(result.action)}${result.moved ? " + moved" : ""}: "${summary.title}".`,
              );

              return "processed" as const;
            },
            (message) => pauseForRateLimit(accountLabel, message),
          );
          if (handled === null || handled === "stopped") {
            runStatus = "stopped";
            progressModal.fail("Sync stopped by user.", counts);
            return;
          }
        } catch (error) {
          if (isSyncCancelledError(error) || control.shouldStop()) {
            runStatus = "stopped";
            progressModal.fail("Sync stopped by user.", counts);
            logInfo(`[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Stopped by user.`);
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          counts.failed += 1;
          failures.push({
            id: `${account.accountId}/${summary.id}`,
            title: `${accountLabel}: ${summary.title}`,
            message,
            attempts: DETAIL_FETCH_MAX_ATTEMPTS,
          });
          if (shouldCollectReportEntries) {
            failedEntries.push({
              accountId: requestConfig.accountId,
              accountLabel,
              conversationId: summary.id,
              title: summary.title,
              conversationUrl: summary.url,
              notePath: null,
              message,
            });
          }
          logError(
            `[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Failed: "${summary.title}" - ${message}`,
          );
        }

        processedConversations += 1;

        progressModal.setProgress(displayTitle, conversationIndex + 1, summaries.length, conversationIndex + 1, counts);
        context.setSyncStatusBar(
          context.buildSyncStatusText(processedConversations, totalConversations, `syncing ${accountLabel}`),
          true,
        );
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
    try {
      const reportPath = await context.writeSyncReport({
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
      });
      if (reportPath) {
        logInfo(`Sync report saved: ${reportPath}`);
      } else {
        logInfo("Sync report generation skipped (disabled in settings).");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`Sync report generation failed: ${message}`);
    }

    if (syncLogger) {
      await syncLogger.flush();
    }
  }
}

async function fetchConversationDetailWithRetries(
  requestConfig: ChatGptRequestConfig,
  summary: { id: string; title: string; createdAt: string; updatedAt: string },
  index: number,
  total: number,
  progressModal: SyncProgressReporter,
  displayTitle: string,
  control: SyncExecutionControl,
  logger: SyncRunLogger | null,
  fetchConversationDetail: typeof fetchConversationDetailWithPayload = fetchConversationDetailWithPayload,
  onRequest?: () => void,
): Promise<{ detail: ConversationDetail; rawPayload: unknown } | null> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= DETAIL_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      await control.waitIfPaused();

      if (control.shouldStop()) {
        return null;
      }

      onRequest?.();
      return await fetchConversationDetail(requestConfig, summary.id, summary, control.getStopSignal());
    } catch (error) {
      lastError = error;

      if (control.shouldStop() || isSyncCancelledError(error)) {
        return null;
      }

      if (isConsecutiveRateLimitPauseError(error)) {
        throw error;
      }

      if (attempt >= DETAIL_FETCH_MAX_ATTEMPTS) {
        break;
      }

      const message = error instanceof Error ? error.message : String(error);
      logger?.warn(`${displayTitle} detail fetch retry ${attempt + 1}/${DETAIL_FETCH_MAX_ATTEMPTS}: ${message}`);
      progressModal.setRetry(displayTitle, index, total, attempt + 1, message);
      await sleepWithAbort(attempt * 750, control.getStopSignal());
    }
  }

  if (lastError) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    logger?.error(`${displayTitle} detail fetch failed after ${DETAIL_FETCH_MAX_ATTEMPTS} attempts: ${message}`);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function ensureSyncCanContinue(
  control: SyncExecutionControl,
  progressModal: SyncProgressReporter,
  counts: ImportProgressCounts,
): Promise<boolean> {
  await control.waitIfPaused();

  if (!control.shouldStop()) {
    return true;
  }

  progressModal.fail("Sync stopped by user.", counts);
  return false;
}
