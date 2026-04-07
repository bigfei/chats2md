import type { ChatGptRateLimitMonitor } from "../shared/types";

export const MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES = 5;
export const RATE_LIMIT_STOP_MESSAGE =
  "Sync stopped after more than 5 consecutive ChatGPT 429 responses. Check your ChatGPT session or rate limit, then retry.";

export class ConsecutiveRateLimitSyncError extends Error {
  readonly consecutiveCount: number;

  constructor(consecutiveCount: number) {
    super(RATE_LIMIT_STOP_MESSAGE);
    this.name = "ConsecutiveRateLimitSyncError";
    this.consecutiveCount = consecutiveCount;
  }
}

export function isConsecutiveRateLimitSyncError(error: unknown): error is ConsecutiveRateLimitSyncError {
  return error instanceof ConsecutiveRateLimitSyncError;
}

export class ConsecutiveRateLimitGuard {
  private consecutiveCount = 0;

  createMonitor(onWarning?: (message: string) => void): ChatGptRateLimitMonitor {
    return {
      onRateLimitedResponse: () => {
        this.consecutiveCount += 1;
        onWarning?.(
          `Consecutive HTTP 429 responses: ${this.consecutiveCount}/${MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES}.`,
        );

        if (this.consecutiveCount > MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES) {
          throw new ConsecutiveRateLimitSyncError(this.consecutiveCount);
        }
      },
      onNonRateLimitedResponse: () => {
        this.consecutiveCount = 0;
      },
    };
  }
}
