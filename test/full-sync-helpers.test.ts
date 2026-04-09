import assert from "node:assert/strict";
import test from "node:test";

import {
  createSyncRunState,
  filterHealthyAccountsForAllScope,
  recordSyncFailure,
} from "../src/sync/full-sync-helpers.ts";
import { createEmptyCounts } from "../src/main/helpers.ts";

test("createSyncRunState starts with shared counts and empty report buckets", () => {
  const counts = createEmptyCounts();
  const state = createSyncRunState(counts);

  assert.equal(state.counts, counts);
  assert.deepEqual(state.failures, []);
  assert.deepEqual(state.createdEntries, []);
  assert.deepEqual(state.failedEntries, []);
});

test("recordSyncFailure increments counts and records optional report entries", () => {
  const state = createSyncRunState(createEmptyCounts());

  recordSyncFailure(
    state,
    {
      id: "acc-1/conv-1",
      title: "Account 1: Conversation 1",
      message: "Boom",
      attempts: 3,
    },
    {
      accountId: "acc-1",
      accountLabel: "Account 1",
      conversationId: "conv-1",
      title: "Conversation 1",
      conversationUrl: null,
      notePath: null,
      message: "Boom",
    },
  );

  assert.equal(state.counts.failed, 1);
  assert.equal(state.failures.length, 1);
  assert.equal(state.failedEntries.length, 1);
});

test("filterHealthyAccountsForAllScope keeps healthy accounts and reports skipped labels", async () => {
  const accounts = [
    {
      accountId: "healthy",
      userId: "",
      email: "",
      secretId: "secret-1",
      disabled: false,
      addedAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z",
    },
    {
      accountId: "unhealthy",
      userId: "",
      email: "",
      secretId: "secret-2",
      disabled: false,
      addedAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z",
    },
  ];
  const allConfiguredAccounts = [
    ...accounts,
    {
      accountId: "disabled",
      userId: "",
      email: "",
      secretId: "secret-3",
      disabled: true,
      addedAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z",
    },
  ];
  const unhealthyIds: string[] = [];

  const result = await filterHealthyAccountsForAllScope(accounts, allConfiguredAccounts, {
    ensureCanContinue: async () => true,
    checkAccountHealth: async (account) =>
      account.accountId === "healthy"
        ? { status: "healthy", checkedAt: "2026-04-09T00:00:00.000Z", message: "ok" }
        : { status: "disable-and-skip", checkedAt: "2026-04-09T00:00:00.000Z", message: "bad" },
    getAccountLabel: (account) => `Label ${account.accountId}`,
    onUnhealthyAccount: (account) => {
      unhealthyIds.push(account.accountId);
    },
  });

  assert.deepEqual(result, {
    healthyAccounts: [accounts[0]],
    skippedLabels: ["Label disabled", "Label unhealthy"],
  });
  assert.deepEqual(unhealthyIds, ["unhealthy"]);
});

test("filterHealthyAccountsForAllScope stops early when continuation fails", async () => {
  const result = await filterHealthyAccountsForAllScope(
    [
      {
        accountId: "acc-1",
        userId: "",
        email: "",
        secretId: "secret-1",
        disabled: false,
        addedAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
      },
    ],
    [],
    {
      ensureCanContinue: async () => false,
      checkAccountHealth: async () => {
        throw new Error("should not run");
      },
      getAccountLabel: (account) => account.accountId,
      onUnhealthyAccount: () => undefined,
    },
  );

  assert.equal(result, null);
});
