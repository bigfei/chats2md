import assert from "node:assert/strict";
import test from "node:test";

import {
  ConsecutiveRateLimitGuard,
  ConsecutiveRateLimitPauseError,
  MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES,
} from "../src/sync/rate-limit-guard.ts";

test("ConsecutiveRateLimitGuard pauses after more than five consecutive 429 responses", () => {
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
      error instanceof ConsecutiveRateLimitPauseError &&
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

test("ConsecutiveRateLimitGuard can be reset after a pause so sync may resume", () => {
  const guard = new ConsecutiveRateLimitGuard();
  const monitor = guard.createMonitor();

  for (let index = 0; index <= MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES; index += 1) {
    try {
      monitor.onRateLimitedResponse();
    } catch (error) {
      assert.equal(error instanceof ConsecutiveRateLimitPauseError, true);
    }
  }

  guard.reset();

  assert.doesNotThrow(() => {
    for (let index = 0; index < MAX_CONSECUTIVE_RATE_LIMIT_RESPONSES; index += 1) {
      monitor.onRateLimitedResponse();
    }
  });
});

test("ConsecutiveRateLimitGuard honors a custom consecutive-429 threshold", () => {
  const guard = new ConsecutiveRateLimitGuard(2);
  const monitor = guard.createMonitor();

  monitor.onRateLimitedResponse();
  monitor.onRateLimitedResponse();

  assert.throws(
    () => {
      monitor.onRateLimitedResponse();
    },
    (error: unknown) =>
      error instanceof ConsecutiveRateLimitPauseError &&
      error.consecutiveCount === 3 &&
      error.maxConsecutiveRateLimitResponses === 2,
  );
});
