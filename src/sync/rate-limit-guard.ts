import type { ChatGptRateLimitMonitor } from "../shared/types";

export const MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES = 5;

export function buildRateLimitPauseMessage(maxConsecutiveRateLimitResponses: number): string {
  return (
    `Sync paused after more than ${maxConsecutiveRateLimitResponses} consecutive ChatGPT 429 responses. ` +
    "Check your ChatGPT session or rate limit, then click Resume to retry."
  );
}

export class ConsecutiveRateLimitPauseError extends Error {
  readonly consecutiveCount: number;
  readonly maxConsecutiveRateLimitResponses: number;

  constructor(consecutiveCount: number, maxConsecutiveRateLimitResponses = MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES) {
    super(buildRateLimitPauseMessage(maxConsecutiveRateLimitResponses));
    this.name = "ConsecutiveRateLimitPauseError";
    this.consecutiveCount = consecutiveCount;
    this.maxConsecutiveRateLimitResponses = maxConsecutiveRateLimitResponses;
  }
}

export function isConsecutiveRateLimitPauseError(error: unknown): error is ConsecutiveRateLimitPauseError {
  return error instanceof ConsecutiveRateLimitPauseError;
}

export class ConsecutiveRateLimitGuard {
  private readonly maxConsecutiveRateLimitResponses: number;
  private consecutiveCount = 0;
  private paused = false;

  constructor(maxConsecutiveRateLimitResponses = MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES) {
    this.maxConsecutiveRateLimitResponses = Math.max(1, Math.trunc(maxConsecutiveRateLimitResponses));
  }

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
          `Consecutive HTTP 429 responses: ${this.consecutiveCount}/${this.maxConsecutiveRateLimitResponses}.`,
        );

        if (this.consecutiveCount > this.maxConsecutiveRateLimitResponses) {
          this.paused = true;
          throw new ConsecutiveRateLimitPauseError(this.consecutiveCount, this.maxConsecutiveRateLimitResponses);
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
