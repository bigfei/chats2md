export class SyncCancelledError extends Error {
  constructor(message = "Sync stopped by user.") {
    super(message);
    this.name = "SyncCancelledError";
  }
}

export function toSyncCancelledError(reason?: unknown): SyncCancelledError {
  if (reason instanceof SyncCancelledError) {
    return reason;
  }

  if (reason instanceof Error && reason.message.trim().length > 0) {
    return new SyncCancelledError(reason.message);
  }

  if (typeof reason === "string" && reason.trim().length > 0) {
    return new SyncCancelledError(reason);
  }

  return new SyncCancelledError();
}

export function isSyncCancelledError(error: unknown): error is SyncCancelledError {
  return error instanceof SyncCancelledError || (error instanceof Error && error.name === "SyncCancelledError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  throw toSyncCancelledError(signal.reason);
}

export function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);

  if (!signal) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(toSyncCancelledError(signal.reason));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }

      resolve();
    }, ms);

    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      reject(toSyncCancelledError(signal?.reason));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
