import assert from "node:assert/strict";
import test from "node:test";

import { removeAccountAndConversationListCache } from "../src/main/helpers.ts";
import type { Chats2MdSettings } from "../src/shared/types.ts";

function createSettings(): Chats2MdSettings {
  return {
    defaultFolder: "Imports/ChatGPT",
    conversationPathTemplate: "{date}/{slug}",
    assetStorageMode: "global_by_conversation",
    generateSyncReport: true,
    syncReportFolder: "<syncFolder>/sync-result",
    debugLogging: false,
    saveConversationJson: false,
    conversationListLatestLimit: 200,
    conversationListCacheByAccount: {
      "account-1": {
        summaries: [
          {
            id: "conv-1",
            title: "Conversation 1",
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-02T00:00:00.000Z",
            url: "https://chatgpt.com/c/conv-1",
          },
        ],
        cachedAt: "2026-04-06T00:00:00.000Z",
      },
      "account-2": {
        summaries: [
          {
            id: "conv-2",
            title: "Conversation 2",
            createdAt: "2026-04-03T00:00:00.000Z",
            updatedAt: "2026-04-04T00:00:00.000Z",
            url: "https://chatgpt.com/c/conv-2",
          },
        ],
        cachedAt: "2026-04-06T01:00:00.000Z",
      },
    },
    accounts: [
      {
        accountId: "account-1",
        userId: "user-1",
        email: "a@example.com",
        secretId: "secret-1",
        addedAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
      {
        accountId: "account-2",
        userId: "user-2",
        email: "b@example.com",
        secretId: "secret-2",
        addedAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
    ],
    legacySessionJson: "",
  };
}

test("removeAccountAndConversationListCache removes the account and its conversation-list cache entry", () => {
  const settings = createSettings();

  removeAccountAndConversationListCache(settings, "account-1");

  assert.deepEqual(
    settings.accounts.map((account) => account.accountId),
    ["account-2"],
  );
  assert.equal(settings.conversationListCacheByAccount["account-1"], undefined);
  assert.equal(settings.conversationListCacheByAccount["account-2"]?.summaries.length, 1);
});
