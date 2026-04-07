import type { ChatGptRateLimitMonitor } from "../shared/types";

export const MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES = 5;
export const RATE_LIMIT_PAUSE_MESSAGE =
  "Sync paused after more than 5 consecutive ChatGPT 429 responses. Check your ChatGPT session or rate limit, then click Resume to retry.";

export class ConsecutiveRateLimitPauseError extends Error {
  readonly consecutiveCount: number;

  constructor(consecutiveCount: number) {
    super(RATE_LIMIT_PAUSE_MESSAGE);
    this.name = "ConsecutiveRateLimitPauseError";
    this.consecutiveCount = consecutiveCount;
  }
}

export function isConsecutiveRateLimitPauseError(error: unknown): error is ConsecutiveRateLimitPauseError {
  return error instanceof ConsecutiveRateLimitPauseError;
}

export class ConsecutiveRateLimitGuard {
  private consecutiveCount = 0;
  private paused = false;

  reset(): void {
    this.consecutiveCount = 0;
    this.paused = false;
  }

  createMonitor(onWarning?: (message: string) => void): ChatGptRateLimitMonitor {
    return {
      onRateLimitedResponse: () => {
        if (this.paused) {
          return;
        }

        this.consecutiveCount += 1;
        onWarning?.(
          `Consecutive HTTP 429 responses: ${this.consecutiveCount}/${MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES}.`,
        );

        if (this.consecutiveCount > MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES) {
          this.paused = true;
          throw new ConsecutiveRateLimitPauseError(this.consecutiveCount);
        }
      },
      onNonRateLimitedResponse: () => {
        if (this.paused) {
          return;
        }

        this.consecutiveCount = 0;
      },
    };
  }
}
