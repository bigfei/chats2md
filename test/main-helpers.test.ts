import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SYNC_REPORT_FOLDER_TEMPLATE,
  appendExtensionIfMissing,
  createEmptyCounts,
  formatAssetStorageMode,
  formatActionLabel,
  normalizeAssetStorageMode,
  normalizeDefaultLatestConversationCount,
  normalizeStoredAccount,
  normalizeSyncTuningSettings,
  normalizeTargetFolder,
  readString,
  resolveSyncReportFolder,
  sanitizePathPart,
  sortAccounts,
  summarizeCounts,
} from "../src/main/helpers.ts";
import { DEFAULT_SYNC_TUNING_SETTINGS } from "../src/shared/types.ts";

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

test("formatActionLabel title-cases values and handles empty action", () => {
  assert.equal(formatActionLabel("updated"), "Updated");
  assert.equal(formatActionLabel(""), "Unknown");
});

test("normalizeAssetStorageMode defaults unknown values to global mode", () => {
  assert.equal(normalizeAssetStorageMode("with_conversation"), "with_conversation");
  assert.equal(normalizeAssetStorageMode("global_by_conversation"), "global_by_conversation");
  assert.equal(normalizeAssetStorageMode("invalid"), "global_by_conversation");
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

test("normalizeDefaultLatestConversationCount keeps blank and null as all discovered", () => {
  assert.equal(normalizeDefaultLatestConversationCount(""), null);
  assert.equal(normalizeDefaultLatestConversationCount(null), null);
});

test("normalizeDefaultLatestConversationCount clamps numeric values into supported range", () => {
  assert.equal(normalizeDefaultLatestConversationCount(0), 1);
  assert.equal(normalizeDefaultLatestConversationCount(10001), 10000);
  assert.equal(normalizeDefaultLatestConversationCount(25), 25);
});

test("normalizeSyncTuningSettings applies defaults when missing", () => {
  assert.deepEqual(normalizeSyncTuningSettings(undefined, DEFAULT_SYNC_TUNING_SETTINGS), DEFAULT_SYNC_TUNING_SETTINGS);
});

test("normalizeSyncTuningSettings clamps values and normalizes browse delay max >= min", () => {
  assert.deepEqual(
    normalizeSyncTuningSettings(
      {
        conversationListFetchParallelism: 99,
        conversationListRetryAttempts: 0,
        conversationDetailRetryAttempts: 22,
        conversationDetailBrowseDelayMinMs: 70000,
        conversationDetailBrowseDelayMaxMs: 1000,
        maxConsecutiveRateLimitResponses: -10,
        defaultLatestConversationCount: "",
      },
      DEFAULT_SYNC_TUNING_SETTINGS,
    ),
    {
      conversationListFetchParallelism: 10,
      conversationListRetryAttempts: 1,
      conversationDetailRetryAttempts: 10,
      conversationDetailBrowseDelayMinMs: 60000,
      conversationDetailBrowseDelayMaxMs: 60000,
      maxConsecutiveRateLimitResponses: 1,
      defaultLatestConversationCount: null,
    },
  );
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
