import { isRateLimitedChatGptRequestError } from "../chatgpt/request-core";
import { isSyncCancelledError, sleepWithAbort } from "./cancellation";
import { isConsecutiveRateLimitPauseError } from "./rate-limit-guard";

const DEFAULT_TRANSIENT_RETRY_DELAY_STEP_MS = 750;

export interface TransientRetryProgress {
  nextAttemptNumber: number;
  maxAttempts: number;
  message: string;
}

export interface RetryTransientOperationOptions {
  maxAttempts: number;
  signal?: AbortSignal;
  onRetry?: (progress: TransientRetryProgress) => void;
  shouldRetry?: (error: unknown, signal?: AbortSignal) => boolean;
  getDelayMs?: (attemptNumber: number) => number;
  wrapFinalError?: (error: unknown, attempts: number, maxAttempts: number) => Error;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function shouldRetryTransientSyncError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return false;
  }

  if (isSyncCancelledError(error)) {
    return false;
  }

  if (isConsecutiveRateLimitPauseError(error)) {
    return false;
  }

  if (isRateLimitedChatGptRequestError(error)) {
    return false;
  }

  return true;
}

export async function retryTransientOperation<T>(
  operation: () => Promise<T>,
  options: RetryTransientOperationOptions,
): Promise<T> {
  let lastError: unknown;
  const shouldRetry = options.shouldRetry ?? shouldRetryTransientSyncError;
  const getDelayMs = options.getDelayMs ?? ((attemptNumber: number) => attemptNumber * DEFAULT_TRANSIENT_RETRY_DELAY_STEP_MS);

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!shouldRetry(error, options.signal)) {
        throw normalizeError(error);
      }

      if (attempt >= options.maxAttempts) {
        break;
      }

      const message = error instanceof Error ? error.message : String(error);
      options.onRetry?.({
        nextAttemptNumber: attempt + 1,
        maxAttempts: options.maxAttempts,
        message,
      });
      await sleepWithAbort(getDelayMs(attempt), options.signal);
    }
  }

  if (options.wrapFinalError) {
    throw options.wrapFinalError(lastError, options.maxAttempts, options.maxAttempts);
  }

  throw normalizeError(lastError);
}
