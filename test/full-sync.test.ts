import assert from "node:assert/strict";
import test from "node:test";

import { ConsecutiveRateLimitPauseError } from "../src/sync/rate-limit-guard.ts";
import { runWithRateLimitPauseRetry } from "../src/sync/rate-limit-retry.ts";

test("runWithRateLimitPauseRetry retries the interrupted account-level operation after resume", async () => {
  const attempts: string[] = [];
  const pauseMessages: string[] = [];

  const result = await runWithRateLimitPauseRetry(
    async () => {
      attempts.push("list-fetch");

      if (attempts.length === 1) {
        throw new ConsecutiveRateLimitPauseError(6);
      }

      return { accountId: "acc-1" };
    },
    async (message) => {
      pauseMessages.push(message);
      return true;
    },
  );

  assert.deepEqual(result, { accountId: "acc-1" });
  assert.deepEqual(attempts, ["list-fetch", "list-fetch"]);
  assert.equal(pauseMessages.length, 1);
});

test("runWithRateLimitPauseRetry retries the interrupted conversation-level operation after resume", async () => {
  const attempts: string[] = [];
  const processedConversationIds: string[] = [];

  for (const conversationId of ["conv-1", "conv-2"]) {
    const result = await runWithRateLimitPauseRetry(
      async () => {
        attempts.push(conversationId);

        if (conversationId === "conv-1" && attempts.filter((value) => value === conversationId).length === 1) {
          throw new ConsecutiveRateLimitPauseError(6);
        }

        processedConversationIds.push(conversationId);
        return conversationId;
      },
      async () => true,
    );

    assert.equal(result, conversationId);
  }

  assert.deepEqual(attempts, ["conv-1", "conv-1", "conv-2"]);
  assert.deepEqual(processedConversationIds, ["conv-1", "conv-2"]);
});
