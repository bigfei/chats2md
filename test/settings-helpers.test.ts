import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAccountDescriptionLines,
  buildSyncReportCleanupNotice,
  createAdvancedNumberSettingDefinitions,
  normalizeConversationPathTemplateInput,
  normalizeDefaultLatestConversationCountInput,
  normalizeSyncReportFolderInput,
  parseSettingsNumberInput,
  saveSettingIfChanged,
  summarizeAccountHealthResults,
} from "../src/ui/settings-helpers.ts";

test("settings helpers normalize text inputs to their defaults", () => {
  assert.equal(normalizeConversationPathTemplateInput("   "), "{date}/{slug}");
  assert.equal(
    normalizeConversationPathTemplateInput(" {date}/{slug}/{conversation_id} "),
    "{date}/{slug}/{conversation_id}",
  );
  assert.equal(normalizeSyncReportFolderInput(" "), "<syncFolder>/sync-result");
  assert.equal(normalizeSyncReportFolderInput(" reports "), "reports");
});

test("settings helpers normalize numeric inputs and latest-count values", () => {
  assert.equal(parseSettingsNumberInput("12", 3), 12);
  assert.equal(parseSettingsNumberInput("nope", 3), 3);
  assert.equal(normalizeDefaultLatestConversationCountInput(""), null);
  assert.equal(normalizeDefaultLatestConversationCountInput("25"), 25);
});

test("saveSettingIfChanged skips redundant saves and persists changed values", async () => {
  const saved: string[] = [];

  assert.equal(
    await saveSettingIfChanged("Imports/ChatGPT", "Imports/ChatGPT", async (value) => {
      saved.push(value);
    }),
    false,
  );

  assert.equal(
    await saveSettingIfChanged("Imports/ChatGPT", "Imports/Archive", async (value) => {
      saved.push(value);
    }),
    true,
  );

  assert.deepEqual(saved, ["Imports/Archive"]);
});

test("settings helpers build cleanup notices for keep-latest and clear-all flows", () => {
  assert.equal(
    buildSyncReportCleanupNotice({ removedPaths: ["a.md"], keptPaths: ["b.md", "c.md"] }, 10),
    "Removed 1 sync report/log file(s). Kept 2.",
  );
  assert.equal(
    buildSyncReportCleanupNotice({ removedPaths: [], keptPaths: ["b.md", "c.md"] }, 10),
    "No sync report/log files removed. 2 file(s) kept.",
  );
  assert.equal(
    buildSyncReportCleanupNotice({ removedPaths: [], keptPaths: [] }),
    "No generated sync report/log files found to remove.",
  );
});

test("settings helpers build multiline account descriptions and health summaries", () => {
  const account = {
    accountId: "acc-1",
    userId: "user-1",
    email: "user@example.com",
    secretId: "secret-1",
    disabled: false,
    addedAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z",
  };
  const unhealthyResult = {
    status: "disable-and-skip" as const,
    checkedAt: "2026-04-09T01:00:00.000Z",
    message: "Session expired.",
  };

  assert.deepEqual(buildAccountDescriptionLines(account, unhealthyResult), [
    "Session: Enabled",
    "Health: Warning - Session expired. (checked 2026-04-09T01:00:00.000Z)",
    "Expires: Unavailable",
    "Account ID: acc-1",
    "User ID: user-1",
  ]);

  assert.deepEqual(
    summarizeAccountHealthResults([
      { status: "healthy", checkedAt: "2026-04-09T01:00:00.000Z", message: "ok" },
      unhealthyResult,
    ]),
    {
      healthyCount: 1,
      unhealthyCount: 1,
      notice: "Account session health check complete. 1 healthy, 1 unhealthy.",
    },
  );
});

test("settings helpers expose the advanced number-setting definitions", () => {
  const definitions = createAdvancedNumberSettingDefinitions();

  assert.equal(definitions.length, 6);
  assert.equal(definitions[0]?.key, "conversationListFetchParallelism");
  assert.match(definitions[0]?.desc ?? "", /conversation-list pages fetched in parallel/i);
  assert.equal(definitions[5]?.key, "maxConsecutiveRateLimitResponses");
});
