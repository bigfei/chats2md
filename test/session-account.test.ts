import assert from "node:assert/strict";
import test from "node:test";

import { removeStoredAccount } from "../src/main/helpers.ts";
import { clearStoredSecretPayload } from "../src/main/secret-storage.ts";
import type { Chats2MdSettings } from "../src/shared/types.ts";

function createSettings(): Chats2MdSettings {
  return {
    defaultFolder: "Imports/ChatGPT",
    conversationPathTemplate: "{date}/{slug}",
    assetStorageMode: "global_by_conversation",
    skipExistingLocalConversations: true,
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

test("session removal fallback clears stored secret payload before metadata removal", () => {
  const settings = createSettings();
  const secretWrites: Array<{ key: string; value: string }> = [];

  const cleared = clearStoredSecretPayload(settings, "account-1", (key, value) => {
    secretWrites.push({ key, value });
  });
  removeStoredAccount(settings, "account-1");

  assert.equal(cleared, true);
  assert.deepEqual(secretWrites, [{ key: "secret-1", value: "" }]);
  assert.deepEqual(
    settings.accounts.map((account) => account.accountId),
    ["account-2"],
  );
});
