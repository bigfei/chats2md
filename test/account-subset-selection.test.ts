import assert from "node:assert/strict";
import test from "node:test";

import {
  applyConversationSubsetSelection,
  openAccountSubsetSelectionPrompt,
} from "../src/sync/account-subset-selection.ts";
import type { ConversationSummary } from "../src/shared/types.ts";

function createSummary(id: string, createdAt: string, updatedAt = createdAt): ConversationSummary {
  return {
    id,
    title: id,
    createdAt,
    updatedAt,
    url: `https://chatgpt.com/c/${id}`,
  };
}

test("openAccountSubsetSelectionPrompt opens selector even for short spans", async () => {
  const summaries = [
    createSummary("conv-1", "2026-03-01T00:00:00.000Z"),
    createSummary("conv-2", "2026-03-02T00:00:00.000Z"),
  ];
  const preparingMessages: string[] = [];
  const logMessages: string[] = [];
  let selectCalls = 0;

  const result = await openAccountSubsetSelectionPrompt(
    {
      accountLabel: "user@example.com",
      accountIndex: 0,
      totalAccounts: 1,
      summaries,
      skipExistingLocalConversations: true,
      defaultLatestConversationCount: null,
    },
    {
      ensureCanContinue: async () => true,
      setPreparing: (message) => {
        preparingMessages.push(message);
      },
      logInfo: (message) => {
        logMessages.push(message);
      },
      selectDateRange: async () => {
        selectCalls += 1;
        return { mode: "all", skipExistingLocalConversations: true };
      },
    },
  );

  assert.equal(result.status, "selected");
  assert.equal(selectCalls, 1);
  assert.equal(preparingMessages.length, 1);
  assert.match(preparingMessages[0] ?? "", /choose conversation filter/i);
  assert.match(logMessages[0] ?? "", /subset selection opened/i);
});

test("openAccountSubsetSelectionPrompt does not open selector when no conversations are discovered", async () => {
  let selectCalls = 0;

  const result = await openAccountSubsetSelectionPrompt(
    {
      accountLabel: "user@example.com",
      accountIndex: 0,
      totalAccounts: 1,
      summaries: [],
      skipExistingLocalConversations: true,
      defaultLatestConversationCount: null,
    },
    {
      ensureCanContinue: async () => true,
      setPreparing: () => undefined,
      logInfo: () => undefined,
      selectDateRange: async () => {
        selectCalls += 1;
        return { mode: "all", skipExistingLocalConversations: true };
      },
    },
  );

  assert.equal(result.status, "no-selection");
  assert.equal(selectCalls, 0);
});

test("applyConversationSubsetSelection keeps all rows for all mode", () => {
  const summaries = [createSummary("conv-1", "2026-03-01T00:00:00.000Z"), createSummary("conv-2", "2026-03-02T00:00:00.000Z")];

  const selected = applyConversationSubsetSelection(summaries, {
    mode: "all",
    skipExistingLocalConversations: true,
  });

  assert.deepEqual(
    selected.map((summary) => summary.id),
    ["conv-1", "conv-2"],
  );
});

test("openAccountSubsetSelectionPrompt passes through the configured latest-count default", async () => {
  const summaries = [createSummary("conv-1", "2026-03-01T00:00:00.000Z"), createSummary("conv-2", "2026-03-02T00:00:00.000Z")];
  let receivedDefault: number | null = null;

  await openAccountSubsetSelectionPrompt(
    {
      accountLabel: "user@example.com",
      accountIndex: 0,
      totalAccounts: 1,
      summaries,
      skipExistingLocalConversations: true,
      defaultLatestConversationCount: 1,
    },
    {
      ensureCanContinue: async () => true,
      setPreparing: () => undefined,
      logInfo: () => undefined,
      selectDateRange: async (context) => {
        receivedDefault = context.defaultLatestConversationCount;
        return { mode: "all", skipExistingLocalConversations: true };
      },
    },
  );

  assert.equal(receivedDefault, 1);
});
