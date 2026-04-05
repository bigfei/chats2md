import assert from "node:assert/strict";
import test from "node:test";

import { renderSyncRunReport } from "../src/sync-report.ts";
import type { SyncRunReport } from "../src/types.ts";

test("renderSyncRunReport includes run metadata and wikilinks", () => {
  const report: SyncRunReport = {
    startedAt: "2026-04-04T10:00:00.000Z",
    finishedAt: "2026-04-04T10:05:00.000Z",
    status: "completed",
    logPath: "Imports/ChatGPT/sync-result/sync-2026-04-04T10-05-00-000Z.log",
    folder: "Imports/ChatGPT",
    conversationPathTemplate: "{email}/{account_id}/{slug}",
    assetStorageMode: "with_conversation",
    scope: "single",
    accounts: [{
      accountId: "acc-1",
      label: "user@example.com"
    }],
    total: 2,
    counts: {
      created: 1,
      updated: 1,
      moved: 1,
      skipped: 0,
      failed: 0
    },
    created: [{
      accountId: "acc-1",
      accountLabel: "user@example.com",
      conversationId: "conv-1",
      title: "Created chat",
      conversationUrl: "https://chatgpt.com/c/conv-1",
      notePath: "Imports/ChatGPT/user@example.com/u-1/created-chat.md"
    }],
    updated: [{
      accountId: "acc-1",
      accountLabel: "user@example.com",
      conversationId: "conv-2",
      title: "Updated chat",
      conversationUrl: "https://chatgpt.com/c/conv-2",
      notePath: "Imports/ChatGPT/user@example.com/u-1/updated-chat.md"
    }],
    moved: [{
      accountId: "acc-1",
      accountLabel: "user@example.com",
      conversationId: "conv-2",
      title: "Updated chat",
      conversationUrl: "https://chatgpt.com/c/conv-2",
      notePath: "Imports/ChatGPT/user@example.com/u-1/updated-chat.md",
      message: "Moved to match current layout template."
    }],
    failed: []
  };

  const markdown = renderSyncRunReport(report);

  assert.match(markdown, /# Chats2MD Sync Report/);
  assert.match(markdown, /- Sync log: \[\[Imports\/ChatGPT\/sync-result\/sync-2026-04-04T10-05-00-000Z\.log\|sync-2026-04-04T10-05-00-000Z\.log\]\]/);
  assert.match(markdown, /- Layout template: \{email\}\/\{account_id\}\/\{slug\}/);
  assert.match(markdown, /- Asset storage: With conversation folder/);
  assert.match(markdown, /\[\[Imports\/ChatGPT\/user@example\.com\/u-1\/created-chat\|Created chat\]\] \(`conv-1`\)/);
  assert.match(markdown, /## Failed[\s\S]*_None_/);
});
