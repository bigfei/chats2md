import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SYNC_REPORT_FOLDER_TEMPLATE,
  appendExtensionIfMissing,
  createEmptyCounts,
  formatAssetStorageMode,
  formatActionLabel,
  getOldestConversationSummaryByUpdatedAt,
  hasMatchingUpdatedAt,
  normalizeAssetStorageMode,
  normalizeConversationListCacheByAccount,
  normalizeConversationListLatestLimit,
  normalizeStoredAccount,
  normalizeTargetFolder,
  normalizeTimestampToMs,
  readString,
  resolveSyncReportFolder,
  sanitizePathPart,
  sortAccounts,
  summarizeCounts,
} from "../src/main/helpers.ts";

test("createEmptyCounts initializes all counters to zero", () => {
  assert.deepEqual(createEmptyCounts(), {
    created: 0,
    updated: 0,
    moved: 0,
    skipped: 0,
    failed: 0,
  });
});

test("summarizeCounts renders a compact summary line", () => {
  const summary = summarizeCounts(12, {
    created: 2,
    updated: 3,
    moved: 1,
    skipped: 5,
    failed: 1,
  });

  assert.equal(summary, "Synced 12 conversations. 2 created 3 updated 1 moved 5 skipped 1 failed");
});

test("normalizeTimestampToMs parses ISO timestamps and rejects invalid input", () => {
  assert.equal(normalizeTimestampToMs(null), null);
  assert.equal(normalizeTimestampToMs(""), null);
  assert.equal(normalizeTimestampToMs("not-a-date"), null);

  const timestamp = normalizeTimestampToMs("2026-01-01T00:00:00.000Z");
  assert.equal(timestamp, 1767225600000);
});

test("hasMatchingUpdatedAt accepts exact and near-equivalent timestamps", () => {
  assert.equal(hasMatchingUpdatedAt(null, "2026-01-01T00:00:00.000Z"), false);
  assert.equal(hasMatchingUpdatedAt("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"), true);
  assert.equal(hasMatchingUpdatedAt("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.900Z"), true);
  assert.equal(hasMatchingUpdatedAt("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:02.000Z"), false);
});

test("getOldestConversationSummaryByUpdatedAt returns the oldest valid summary", () => {
  const oldest = getOldestConversationSummaryByUpdatedAt([
    {
      id: "newer",
      title: "Newer",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      url: "https://chatgpt.com/c/newer",
    },
    {
      id: "invalid",
      title: "Invalid",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "not-a-date",
      url: "https://chatgpt.com/c/invalid",
    },
    {
      id: "oldest",
      title: "Oldest",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      url: "https://chatgpt.com/c/oldest",
    },
  ]);

  assert.equal(oldest?.id, "oldest");
});

test("formatActionLabel title-cases values and handles empty action", () => {
  assert.equal(formatActionLabel("updated"), "Updated");
  assert.equal(formatActionLabel(""), "Unknown");
});

test("normalizeAssetStorageMode defaults unknown values to global mode", () => {
  assert.equal(normalizeAssetStorageMode("with_conversation"), "with_conversation");
  assert.equal(normalizeAssetStorageMode("global_by_conversation"), "global_by_conversation");
  assert.equal(normalizeAssetStorageMode("invalid"), "global_by_conversation");
});

test("normalizeConversationListLatestLimit validates and normalizes values", () => {
  assert.equal(normalizeConversationListLatestLimit(250), 250);
  assert.equal(normalizeConversationListLatestLimit("300"), 300);
  assert.equal(normalizeConversationListLatestLimit("0", 200), 200);
  assert.equal(normalizeConversationListLatestLimit("invalid", 150), 150);
});

test("normalizeConversationListCacheByAccount keeps valid entries and drops invalid summaries", () => {
  const normalized = normalizeConversationListCacheByAccount({
    "account-1": {
      cachedAt: "2026-04-06T00:00:00.000Z",
      summaries: [
        {
          id: "conv-1",
          title: "Conversation 1",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-02T00:00:00.000Z",
          url: "https://chatgpt.com/c/conv-1",
        },
        {
          id: "",
          title: "invalid",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-02T00:00:00.000Z",
          url: "https://chatgpt.com/c/invalid",
        },
      ],
    },
  });

  assert.equal(Object.keys(normalized).length, 1);
  assert.equal(normalized["account-1"]?.summaries.length, 1);
  assert.equal(normalized["account-1"]?.summaries[0]?.id, "conv-1");
});

test("formatAssetStorageMode returns human-readable labels", () => {
  assert.equal(formatAssetStorageMode("global_by_conversation"), "Global by conversation");
  assert.equal(formatAssetStorageMode("with_conversation"), "With conversation folder");
});

test("readString returns string values or fallback", () => {
  assert.equal(readString("abc", "fallback"), "abc");
  assert.equal(readString(123, "fallback"), "fallback");
});

test("normalizeTargetFolder trims outer slashes and whitespace", () => {
  assert.equal(normalizeTargetFolder(" /Imports/ChatGPT/ "), "Imports/ChatGPT");
  assert.equal(normalizeTargetFolder("Imports/ChatGPT"), "Imports/ChatGPT");
});

test("resolveSyncReportFolder defaults to <syncFolder>/sync-result", () => {
  assert.equal(resolveSyncReportFolder("Imports/ChatGPT", ""), "Imports/ChatGPT/sync-result");
  assert.equal(DEFAULT_SYNC_REPORT_FOLDER_TEMPLATE, "<syncFolder>/sync-result");
});

test("resolveSyncReportFolder supports <syncFolder> placeholder in custom folder", () => {
  assert.equal(resolveSyncReportFolder("Imports/ChatGPT", "<syncFolder>/reports"), "Imports/ChatGPT/reports");
});

test("resolveSyncReportFolder uses a static folder when no placeholder is configured", () => {
  assert.equal(resolveSyncReportFolder("Imports/ChatGPT", "Shared/SyncReports"), "Shared/SyncReports");
});

test("sanitizePathPart strips invalid path characters and preserves length limit", () => {
  assert.equal(sanitizePathPart("  report:Q1/2026?*  "), "report_Q1_2026__");
  assert.equal(sanitizePathPart(""), "file");
});

test("appendExtensionIfMissing infers extension from content type", () => {
  assert.equal(appendExtensionIfMissing("image", "image/png"), "image.png");
  assert.equal(appendExtensionIfMissing("mail", "message/rfc822"), "mail.eml");
  assert.equal(appendExtensionIfMissing("archive.zip", "application/zip"), "archive.zip");
  assert.equal(appendExtensionIfMissing("payload", null), "payload");
});

test("normalizeStoredAccount validates and normalizes account metadata", () => {
  assert.equal(normalizeStoredAccount(null), null);
  assert.equal(normalizeStoredAccount({ accountId: "a" }), null);

  const normalized = normalizeStoredAccount({
    accountId: "acc-1",
    userId: "user-1",
    email: "x@example.com",
    expiresAt: "2026-12-31",
    secretId: "secret-1",
    addedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });

  assert.deepEqual(normalized, {
    accountId: "acc-1",
    userId: "user-1",
    email: "x@example.com",
    expiresAt: "2026-12-31",
    secretId: "secret-1",
    addedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
});

test("sortAccounts orders by email then account id", () => {
  const sorted = sortAccounts([
    {
      accountId: "b",
      userId: "u2",
      email: "z@example.com",
      secretId: "s2",
      addedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      accountId: "a",
      userId: "u1",
      email: "a@example.com",
      secretId: "s1",
      addedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      accountId: "c",
      userId: "u3",
      email: "a@example.com",
      secretId: "s3",
      addedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);

  assert.deepEqual(
    sorted.map((account) => `${account.email}/${account.accountId}`),
    ["a@example.com/a", "a@example.com/c", "z@example.com/b"],
  );
});
