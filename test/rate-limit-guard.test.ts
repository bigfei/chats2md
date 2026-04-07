import assert from "node:assert/strict";
import test from "node:test";

import {
  ConsecutiveRateLimitGuard,
  ConsecutiveRateLimitSyncError,
  MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES,
} from "../src/sync/rate-limit-guard.ts";

test("ConsecutiveRateLimitGuard stops after more than five consecutive 429 responses", () => {
  const warnings: string[] = [];
  const guard = new ConsecutiveRateLimitGuard();
  const monitor = guard.createMonitor((message) => {
    warnings.push(message);
  });

  for (let index = 0; index < MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES; index += 1) {
    monitor.onRateLimitedResponse();
  }

  assert.equal(warnings.length, MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES);

  assert.throws(
    () => {
      monitor.onRateLimitedResponse();
    },
    (error: unknown) =>
      error instanceof ConsecutiveRateLimitSyncError &&
      error.consecutiveCount === MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES + 1,
  );
});

test("ConsecutiveRateLimitGuard resets after a non-429 response", () => {
  const guard = new ConsecutiveRateLimitGuard();
  const monitor = guard.createMonitor();

  for (let index = 0; index < MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES; index += 1) {
    monitor.onRateLimitedResponse();
  }

  monitor.onNonRateLimitedResponse();

  assert.doesNotThrow(() => {
    for (let index = 0; index < MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES; index += 1) {
      monitor.onRateLimitedResponse();
    }
  });
});
