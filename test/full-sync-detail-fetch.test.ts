import assert from "node:assert/strict";
import test from "node:test";

import { fetchConversationDetailWithRetries, ensureSyncCanContinue } from "../src/sync/full-sync-detail-fetch.ts";
import { ConsecutiveRateLimitPauseError } from "../src/sync/rate-limit-guard.ts";
import { SyncCancelledError } from "../src/sync/cancellation.ts";
import { createEmptyCounts } from "../src/main/helpers.ts";

function createControl(overrides: Partial<Parameters<typeof fetchConversationDetailWithRetries>[6]> = {}) {
  const abortController = new AbortController();
  return {
    waitIfPaused: async () => undefined,
    shouldStop: () => false,
    getStopSignal: () => abortController.signal,
    resetRetryPause: () => undefined,
    ...overrides,
  };
}

function createProgressModal() {
  const retries: Array<{ title: string; nextAttemptNumber: number; maxAttempts: number; message: string }> = [];
  const failures: Array<{ message: string; counts: ReturnType<typeof createEmptyCounts> }> = [];

  return {
    retries,
    failures,
    setRetry: (
      title: string,
      _index: number,
      _total: number,
      nextAttemptNumber: number,
      maxAttempts: number,
      message: string,
    ) => {
      retries.push({ title, nextAttemptNumber, maxAttempts, message });
    },
    fail: (message: string, counts: ReturnType<typeof createEmptyCounts>) => {
      failures.push({ message, counts: { ...counts } });
    },
  };
}

test("fetchConversationDetailWithRetries retries transient failures and reports progress", async () => {
  const progressModal = createProgressModal();
  const warnings: string[] = [];
  const summary = {
    id: "conv-1",
    title: "Conversation 1",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z",
  };
  let attempts = 0;

  const result = await fetchConversationDetailWithRetries(
    {
      accessToken: "token",
      accountId: "acc-1",
      userId: "user-1",
      userEmail: "user@example.com",
      headers: {},
      userAgent: "agent",
    },
    summary,
    1,
    3,
    progressModal as never,
    "Account: Conversation 1",
    createControl() as never,
    {
      filePath: "logs/sync.log",
      warn: (message: string) => warnings.push(message),
      error: () => undefined,
    } as never,
    3,
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary");
      }

      return {
        detail: {
          id: "conv-1",
          title: "Conversation 1",
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          url: "https://chatgpt.com/c/conv-1",
          messages: [],
          fileReferences: [],
          footnotes: [],
        },
        rawPayload: { ok: true },
      };
    },
  );

  assert.equal(attempts, 2);
  assert.equal(result?.detail.id, "conv-1");
  assert.equal(progressModal.retries.length, 1);
  assert.match(progressModal.retries[0]?.message ?? "", /temporary/);
  assert.match(warnings[0] ?? "", /detail fetch retry 2\/3/);
});

test("fetchConversationDetailWithRetries returns null when cancellation is requested", async () => {
  const controller = createControl({
    shouldStop: () => true,
  });

  const result = await fetchConversationDetailWithRetries(
    {
      accessToken: "token",
      accountId: "acc-1",
      userId: "user-1",
      userEmail: "user@example.com",
      headers: {},
      userAgent: "agent",
    },
    {
      id: "conv-1",
      title: "Conversation 1",
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z",
    },
    1,
    1,
    createProgressModal() as never,
    "Account: Conversation 1",
    controller as never,
    null,
    3,
  );

  assert.equal(result, null);
});

test("fetchConversationDetailWithRetries rethrows rate-limit pauses and logs terminal errors", async () => {
  const errors: string[] = [];
  const summary = {
    id: "conv-1",
    title: "Conversation 1",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z",
  };

  await assert.rejects(
    () =>
      fetchConversationDetailWithRetries(
        {
          accessToken: "token",
          accountId: "acc-1",
          userId: "user-1",
          userEmail: "user@example.com",
          headers: {},
          userAgent: "agent",
        },
        summary,
        1,
        1,
        createProgressModal() as never,
        "Account: Conversation 1",
        createControl() as never,
        {
          filePath: "logs/sync.log",
          warn: () => undefined,
          error: (message: string) => errors.push(message),
        } as never,
        2,
        async () => {
          throw new ConsecutiveRateLimitPauseError(6);
        },
      ),
    ConsecutiveRateLimitPauseError,
  );

  await assert.rejects(
    () =>
      fetchConversationDetailWithRetries(
        {
          accessToken: "token",
          accountId: "acc-1",
          userId: "user-1",
          userEmail: "user@example.com",
          headers: {},
          userAgent: "agent",
        },
        summary,
        1,
        1,
        createProgressModal() as never,
        "Account: Conversation 1",
        createControl() as never,
        {
          filePath: "logs/sync.log",
          warn: () => undefined,
          error: (message: string) => errors.push(message),
        } as never,
        2,
        async () => {
          throw new Error("fatal");
        },
      ),
    /fatal/,
  );

  assert.match(errors[0] ?? "", /failed after 2 attempts: fatal/);
});

test("fetchConversationDetailWithRetries returns null for sync-cancelled errors", async () => {
  const result = await fetchConversationDetailWithRetries(
    {
      accessToken: "token",
      accountId: "acc-1",
      userId: "user-1",
      userEmail: "user@example.com",
      headers: {},
      userAgent: "agent",
    },
    {
      id: "conv-1",
      title: "Conversation 1",
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z",
    },
    1,
    1,
    createProgressModal() as never,
    "Account: Conversation 1",
    createControl() as never,
    null,
    2,
    async () => {
      throw new SyncCancelledError("stopped");
    },
  );

  assert.equal(result, null);
});

test("ensureSyncCanContinue fails the modal when stop has been requested", async () => {
  const counts = createEmptyCounts();
  counts.failed = 2;
  const progressModal = createProgressModal();

  const canContinue = await ensureSyncCanContinue(
    createControl({
      shouldStop: () => true,
    }) as never,
    progressModal as never,
    counts,
  );

  assert.equal(canContinue, false);
  assert.deepEqual(progressModal.failures, [
    {
      message: "Sync stopped by user.",
      counts: { ...counts },
    },
  ]);
});
