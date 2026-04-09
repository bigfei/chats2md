import { fetchConversationDetailWithPayload } from "../chatgpt/api";
import { isSyncCancelledError } from "./cancellation";
import { isConsecutiveRateLimitPauseError } from "./rate-limit-guard";
import { retryTransientOperation } from "./transient-retry";

import type { SyncExecutionControl, SyncProgressReporter } from "../ui/import-modal";
import type { ChatGptRequestConfig, ConversationDetail, ImportProgressCounts } from "../shared/types";
import type { SyncRunLogger } from "../main/helpers";

export async function fetchConversationDetailWithRetries(
  requestConfig: ChatGptRequestConfig,
  summary: { id: string; title: string; createdAt: string; updatedAt: string },
  index: number,
  total: number,
  progressModal: SyncProgressReporter,
  displayTitle: string,
  control: SyncExecutionControl,
  logger: SyncRunLogger | null,
  maxAttempts: number,
  fetchConversationDetail: typeof fetchConversationDetailWithPayload = fetchConversationDetailWithPayload,
  onRequest?: () => void,
): Promise<{ detail: ConversationDetail; rawPayload: unknown } | null> {
  try {
    return await retryTransientOperation(
      async () => {
        await control.waitIfPaused();

        if (control.shouldStop()) {
          throw control.getStopSignal()?.reason ?? new Error("Sync stopped by user.");
        }

        onRequest?.();
        return await fetchConversationDetail(requestConfig, summary.id, summary, control.getStopSignal());
      },
      {
        maxAttempts,
        signal: control.getStopSignal(),
        onRetry: (progress) => {
          logger?.warn(`${displayTitle} detail fetch retry ${progress.nextAttemptNumber}/${progress.maxAttempts}: ${progress.message}`);
          progressModal.setRetry(displayTitle, index, total, progress.nextAttemptNumber, progress.maxAttempts, progress.message);
        },
      },
    );
  } catch (error) {
    if (control.shouldStop() || isSyncCancelledError(error)) {
      return null;
    }

    if (isConsecutiveRateLimitPauseError(error)) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    logger?.error(`${displayTitle} detail fetch failed after ${maxAttempts} attempts: ${message}`);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function ensureSyncCanContinue(
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
