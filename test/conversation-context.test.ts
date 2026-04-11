import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConversationFrontmatter,
  resolveAccountForConversation,
  selectAccountsForSync,
} from "../src/main/conversation-context.ts";

const accountA = {
  accountId: "acc-1",
  userId: "user-1",
  email: "alpha@example.com",
  secretId: "secret-1",
  disabled: false,
  addedAt: "2026-04-09T00:00:00.000Z",
  updatedAt: "2026-04-09T00:00:00.000Z",
};

const accountB = {
  accountId: "acc-2",
  userId: "user-2",
  email: "beta@example.com",
  secretId: "secret-2",
  disabled: true,
  addedAt: "2026-04-09T00:00:00.000Z",
  updatedAt: "2026-04-09T00:00:00.000Z",
};

test("buildConversationFrontmatter trims strings and ignores non-strings", () => {
  assert.deepEqual(
    buildConversationFrontmatter({
      chatgpt_conversation_id: " conv-123 ",
      chatgpt_title: " Hello ",
      chatgpt_created_at: " 2026-04-09T00:00:00.000Z ",
      chatgpt_updated_at: "2026-04-10T00:00:00.000Z",
      chatgpt_list_updated_at: 42,
      chatgpt_account_id: " acc-1 ",
      chatgpt_user_id: null,
    }),
    {
      conversationId: "conv-123",
      title: "Hello",
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-10T00:00:00.000Z",
      listUpdatedAt: "",
      accountId: "acc-1",
      userId: "",
    },
  );
});

test("selectAccountsForSync returns enabled accounts for all scope", () => {
  assert.deepEqual(selectAccountsForSync([accountB, accountA], { scope: "all" }), [accountA]);
});

test("selectAccountsForSync validates single-account selection", () => {
  assert.throws(() => selectAccountsForSync([accountA], { scope: "single", accountId: "" }), {
    message: "No account selected for sync.",
  });

  assert.throws(() => selectAccountsForSync([accountA], { scope: "single", accountId: "missing" }), {
    message: "Selected enabled account is no longer available: missing",
  });

  assert.deepEqual(selectAccountsForSync([accountA, accountB], { scope: "single", accountId: "acc-1" }), [accountA]);
});

test("resolveAccountForConversation prefers account id, then unique user id, then sole account", () => {
  assert.equal(
    resolveAccountForConversation([accountA, accountB], {
      conversationId: "conv-1",
      title: "Example",
      createdAt: "",
      updatedAt: "",
      listUpdatedAt: "",
      accountId: "acc-1",
      userId: "",
    }),
    accountA,
  );

  assert.equal(
    resolveAccountForConversation([accountA, accountB], {
      conversationId: "conv-1",
      title: "Example",
      createdAt: "",
      updatedAt: "",
      listUpdatedAt: "",
      accountId: "",
      userId: "user-1",
    }),
    accountA,
  );

  assert.equal(
    resolveAccountForConversation([accountA], {
      conversationId: "conv-1",
      title: "Example",
      createdAt: "",
      updatedAt: "",
      listUpdatedAt: "",
      accountId: "",
      userId: "",
    }),
    accountA,
  );
});

test("resolveAccountForConversation preserves current error cases", () => {
  const duplicateUserMatch = {
    ...accountB,
    accountId: "acc-3",
    disabled: false,
    userId: "user-1",
  };

  assert.throws(
    () =>
      resolveAccountForConversation([accountA, duplicateUserMatch], {
        conversationId: "conv-1",
        title: "Example",
        createdAt: "",
        updatedAt: "",
        listUpdatedAt: "",
        accountId: "",
        userId: "user-1",
      }),
    {
      message: 'Multiple sessions match user_id "user-1". Re-run full sync to refresh account_id in note frontmatter.',
    },
  );

  assert.throws(
    () =>
      resolveAccountForConversation([accountA, { ...accountB, disabled: false }], {
        conversationId: "conv-1",
        title: "Example",
        createdAt: "",
        updatedAt: "",
        listUpdatedAt: "",
        accountId: "missing",
        userId: "",
      }),
    {
      message: 'No session matches account_id "missing" from note frontmatter.',
    },
  );

  assert.throws(
    () =>
      resolveAccountForConversation([accountA, { ...accountB, disabled: false }], {
        conversationId: "conv-1",
        title: "Example",
        createdAt: "",
        updatedAt: "",
        listUpdatedAt: "",
        accountId: "",
        userId: "",
      }),
    {
      message: "Note frontmatter is missing chatgpt_account_id and chatgpt_user_id.",
    },
  );
});
