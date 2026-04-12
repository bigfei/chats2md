import { isSyncCancelledError, sleepWithAbort } from "./cancellation";

export interface RetryProgress {
  nextAttemptNumber: number;
  maxAttempts: number;
  message: string;
}

export interface RetryOperationOptions {
  maxAttempts: number;
  signal?: AbortSignal;
  onRetry?: (progress: RetryProgress) => void | Promise<void>;
  shouldRetry?: (error: unknown, signal?: AbortSignal) => boolean;
  getDelayMs?: (attemptNumber: number) => number;
  wrapFinalError?: (error: unknown, attempts: number, maxAttempts: number) => Error;
}

const DEFAULT_RETRY_DELAY_STEP_MS = 750;

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortLikeError(error: unknown): boolean {
  if (isSyncCancelledError(error)) {
    return true;
  }

  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError" || error.name === "SyncCancelledError")
  );
}

export function shouldRetryOperationError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return false;
  }

  return !isAbortLikeError(error);
}

export async function retryOperation<T>(operation: () => Promise<T>, options: RetryOperationOptions): Promise<T> {
  let lastError: unknown;
  const shouldRetry = options.shouldRetry ?? shouldRetryOperationError;
  const getDelayMs = options.getDelayMs ?? ((attemptNumber: number) => attemptNumber * DEFAULT_RETRY_DELAY_STEP_MS);

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
      await options.onRetry?.({
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
