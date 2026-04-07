import { isConsecutiveRateLimitPauseError } from "./rate-limit-guard";

export async function runWithRateLimitPauseRetry<T>(
  operation: () => Promise<T>,
  pauseForRateLimit: (message: string) => Promise<boolean>,
): Promise<T | null> {
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isConsecutiveRateLimitPauseError(error)) {
        throw error;
      }

      const shouldRetry = await pauseForRateLimit(error.message);
      if (!shouldRetry) {
        return null;
      }
    }
  }
}
