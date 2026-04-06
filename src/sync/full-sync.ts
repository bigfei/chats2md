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
import { isSyncCancelledError, sleepWithAbort } from "./cancellation";
import { indexConversationNotes, upsertConversationNote } from "../storage/note-writer";
import {
  filterConversationSummariesByCreatedDateRange,
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
  const createdEntries: SyncReportConversationEntry[] = [];
  const updatedEntries: SyncReportConversationEntry[] = [];
  const movedEntries: SyncReportConversationEntry[] = [];
  const failedEntries: SyncReportConversationEntry[] = [];
  let processedConversations = 0;
  let totalConversations = 0;
  const forceRefresh = values.forceRefresh === true;
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
    logInfo(`Starting sync for ${selectedAccounts.length} account(s).`);
    logInfo(`Force refresh is ${forceRefresh ? "enabled" : "disabled"}.`);
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
        requestConfig = context.getRequestConfig(account);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        counts.failed += 1;
        failures.push({
          id: account.accountId,
          title: accountLabel,
          message,
          attempts: 1,
        });
        failedEntries.push({
          accountId: account.accountId,
          accountLabel,
          conversationId: account.accountId,
          title: accountLabel,
          conversationUrl: null,
          notePath: null,
          message,
        });
        logError(`[${accountLabel}] Failed to load session: ${message}`);
        continue;
      }

      let summaries: ConversationSummary[] = [];
      let listPagesFetched = 0;
      let listApiCount = 0;

      try {
        if (!(await ensureCanContinue())) {
          return;
        }

        const listFetchResult = await fetchConversationSummaries(requestConfig, {
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
        });
        summaries = listFetchResult.summaries;
        listPagesFetched = listFetchResult.pagesFetched;
        listApiCount = listFetchResult.fetchedCount;
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
        failedEntries.push({
          accountId: requestConfig.accountId,
          accountLabel,
          conversationId: account.accountId,
          title: `${accountLabel} conversation list`,
          conversationUrl: null,
          notePath: null,
          message,
        });
        logError(`[${accountLabel}] Failed to fetch conversation list: ${message}`);
        continue;
      }

      const discoveredCount = summaries.length;
      logInfo(
        `[${accountLabel}] Found ${discoveredCount} conversation(s) ` +
          `(list pages: ${listPagesFetched}, api items: ${listApiCount}).`,
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
        });

        if (!(await ensureCanContinue())) {
          return;
        }

        if (selection.mode === "skip-account") {
          logInfo(`[${accountLabel}] Selection canceled. Skipping account.`);
          continue;
        }

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
            failedEntries.push({
              accountId: requestConfig.accountId,
              accountLabel,
              conversationId: account.accountId,
              title: `${accountLabel} date range`,
              conversationUrl: null,
              notePath: null,
              message,
            });
            logError(`[${accountLabel}] Invalid date range selection: ${message}`);
            continue;
          }

          logInfo(
            `[${accountLabel}] Selected created_at range ${selection.startDate} to ${selection.endDate}. ` +
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

      for (const [conversationIndex, summary] of summaries.entries()) {
        if (!(await ensureCanContinue())) {
          return;
        }

        const displayTitle = `${accountLabel}: ${summary.title}`;

        progressModal.setProgress(displayTitle, conversationIndex + 1, summaries.length, conversationIndex, counts);
        logInfo(`[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Processing "${summary.title}".`);
        logInfo(`[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Calling /conversation/${summary.id}.`);

        try {
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
            runStatus = "stopped";
            progressModal.fail("Sync stopped by user.", counts);
            return;
          }
          const detail = detailResult.detail;

          if (!(await ensureCanContinue())) {
            return;
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
            forceRefresh,
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
              logWarn(
                `[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Sidecar move warning for "${summary.title}": ${warning}`,
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

          if (reportWarnings.length > 0) {
            reportEntry.message = reportWarnings.join(" ");
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
            `[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) ${formatActionLabel(result.action)}${result.moved ? " + moved" : ""}: "${summary.title}".`,
          );
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
          failedEntries.push({
            accountId: requestConfig.accountId,
            accountLabel,
            conversationId: summary.id,
            title: summary.title,
            conversationUrl: summary.url,
            notePath: null,
            message,
          });
          logError(`[${accountLabel}] (${conversationIndex + 1}/${summaries.length}) Failed: "${summary.title}" - ${message}`);
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
        total: totalConversations,
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
      return await fetchConversationDetailWithPayload(requestConfig, summary.id, summary, control.getStopSignal());
    } catch (error) {
      lastError = error;

      if (control.shouldStop() || isSyncCancelledError(error)) {
        return null;
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
