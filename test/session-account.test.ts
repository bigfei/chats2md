import assert from "node:assert/strict";
import test from "node:test";

import { removeStoredAccount } from "../src/main/helpers.ts";
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

test("removeStoredAccount removes only the requested account", () => {
  const settings = createSettings();
  removeStoredAccount(settings, "account-1");

  assert.deepEqual(
    settings.accounts.map((account) => account.accountId),
    ["account-2"],
  );
});
