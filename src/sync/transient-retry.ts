import { isRateLimitedChatGptRequestError } from "../chatgpt/request-core";
import { retryOperation, shouldRetryOperationError, type RetryProgress } from "@chats2md/sync-core";
import { isSyncCancelledError } from "./cancellation";
import { isConsecutiveRateLimitPauseError } from "./rate-limit-guard";

export type TransientRetryProgress = RetryProgress;

export interface RetryTransientOperationOptions {
  maxAttempts: number;
  signal?: AbortSignal;
  onRetry?: (progress: TransientRetryProgress) => void;
  shouldRetry?: (error: unknown, signal?: AbortSignal) => boolean;
  getDelayMs?: (attemptNumber: number) => number;
  wrapFinalError?: (error: unknown, attempts: number, maxAttempts: number) => Error;
}

export function shouldRetryTransientSyncError(error: unknown, signal?: AbortSignal): boolean {
  if (isConsecutiveRateLimitPauseError(error)) {
    return false;
  }

  if (isRateLimitedChatGptRequestError(error)) {
    return false;
  }

  return shouldRetryOperationError(error, signal) && !isSyncCancelledError(error);
}

export async function retryTransientOperation<T>(
  operation: () => Promise<T>,
  options: RetryTransientOperationOptions,
): Promise<T> {
  return retryOperation(operation, {
    ...options,
    shouldRetry: options.shouldRetry ?? shouldRetryTransientSyncError,
  });
}
