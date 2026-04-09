import assert from "node:assert/strict";
import test from "node:test";

import { finalizeFullSyncRun } from "../src/sync/full-sync-finalize.ts";
import { createEmptyCounts } from "../src/main/helpers.ts";

function createReport() {
  return {
    startedAt: "2026-04-09T00:00:00.000Z",
    finishedAt: "2026-04-09T00:10:00.000Z",
    status: "completed" as const,
    logPath: "logs/sync.log",
    folder: "Imports/ChatGPT",
    conversationPathTemplate: "{date}/{slug}",
    assetStorageMode: "global_by_conversation" as const,
    scope: "all" as const,
    accounts: [{ accountId: "acc-1", label: "Account 1" }],
    discoveredTotal: 3,
    selectedTotal: 2,
    counts: createEmptyCounts(),
    created: [],
    updated: [],
    moved: [],
    failed: [],
  };
}

test("finalizeFullSyncRun logs saved report paths and flushes the logger", async () => {
  const infos: string[] = [];
  let flushed = false;

  await finalizeFullSyncRun(createReport(), {
    writeSyncReport: async () => "Reports/sync-result/run.md",
    syncLogger: {
      flush: async () => {
        flushed = true;
      },
    } as never,
    logInfo: (message) => infos.push(message),
    logWarn: () => undefined,
  });

  assert.deepEqual(infos, ["Sync report saved: Reports/sync-result/run.md"]);
  assert.equal(flushed, true);
});

test("finalizeFullSyncRun reports skipped reports and write failures", async () => {
  const infos: string[] = [];
  const warnings: string[] = [];

  await finalizeFullSyncRun(createReport(), {
    writeSyncReport: async () => null,
    syncLogger: null,
    logInfo: (message) => infos.push(message),
    logWarn: (message) => warnings.push(message),
  });

  await finalizeFullSyncRun(createReport(), {
    writeSyncReport: async () => {
      throw new Error("disk full");
    },
    syncLogger: null,
    logInfo: (message) => infos.push(message),
    logWarn: (message) => warnings.push(message),
  });

  assert.deepEqual(infos, ["Sync report generation skipped (disabled in settings)."]);
  assert.deepEqual(warnings, ["Sync report generation failed: disk full"]);
});
